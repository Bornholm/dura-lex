"""Classement automatique des textes par un modèle de langue, via l'agent pi en mode non interactif.

Pour chaque vote sur l'ensemble d'un texte pas encore classé, appelle
`pi -p --mode json` avec l'intitulé du texte et, quand scripts/fetch_context.py
l'a récupéré, son contenu : dispositif (articles), exposé des motifs, étude d'impact.
Jamais les votes, pour ne pas biaiser le classement. Les noms de personnes et de groupes
politiques, la date et la nature du texte (projet ou proposition) sont masqués.

Chaque texte est classé par plusieurs modèles de fournisseurs différents
(config/protocole.json), et les classements sont combinés à la majorité. La réponse
est validée et ajoutée à web/data/classements.json. Les textes déjà classés sont
ignorés, sauf avec --force.

Usage :
  python3 -I scripts/classify.py --leg XVII --limit 5
  python3 -I scripts/classify.py --solennels --workers 4
  python3 -I scripts/classify.py --models openrouter/deepseek/deepseek-v4.1-flash --runs 3
  python3 -I scripts/classify.py --dry-run --limit 1      # affiche le prompt sans appeler le modèle
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "data"
CONFIG = ROOT / "config"
CONTEXT = ROOT / "data" / "context"
ERRORS = ROOT / "data" / "classify_errors.jsonl"

# Taille maximale de chaque partie du contexte, en caractères. Les lois de finances
# dépassent le million de caractères ; le début de chaque document porte l'essentiel.
LIMITES = {"dispositif": 40_000, "expose": 25_000, "etude_impact": 40_000}
LIBELLES = {
    "dispositif": "Dispositif du texte initial (articles)",
    "expose": "Exposé des motifs (rédigé par les auteurs du texte)",
    "etude_impact": "Étude d'impact",
}

PROTOCOLE = json.loads((CONFIG / "protocole.json").read_text())
PI_TIMEOUT = 180  # secondes par appel
PI_ATTEMPTS = 3
CONNAISSANCES = {"connu", "partiel", "inconnu"}
CONFIANCES = {"faible", "moyenne", "élevée"}

lock = threading.Lock()


def build_system_prompt(cfg):
    themes = "\n".join(
        f"- `{t['id']}` : " + " ; ou ".join(f"`{p['id']}` = le texte {p['label']}" for p in t["poles"])
        for t in cfg["themes"]
    )
    effets = "\n".join(f"- `{e['id']}` : {e['label']} ({e['detail']})" for e in cfg["effets"])
    template = (CONFIG / "prompt_classement.md").read_text()
    return template.replace("{{THEMES}}", themes).replace("{{EFFETS}}", effets)


def load_context(uid):
    path = CONTEXT / f"{uid}.json"
    return json.loads(path.read_text()) if path.exists() else None


# Masquage des indices d'appartenance politique. Le modèle classe un contenu, pas un camp.
PARTIS = re.compile(
    r"\b(La France insoumise|France insoumise|Rassemblement national|Front national|Les Républicains"
    r"|Union pour un mouvement populaire|UMP|(?:La )?République en [Mm]arche|LREM|LaREM"
    r"|Ensemble pour la République|Renaissance(?= \()|Mouvement démocrate|MoDem|Les Démocrates|Horizons et apparentés"
    r"|Agir ensemble|UDI|Union des démocrates et indépendants|Libertés,? indépendants,? outre-mer et territoires|LIOT"
    r"|Libertés et territoires|Gauche démocrate et républicaine|Socialistes et apparentés|Parti socialiste"
    r"|Nouvelle gauche|Écologiste et social|Europe [ÉE]cologie[ -]les Verts|EELV|Écologie démocratie solidarité"
    r"|Union des droites pour la République|Droite républicaine|Radical,? républicain,? démocrate et progressiste"
    r"|Nouveau Front populaire|NUPES|majorité présidentielle)\b"
)
GROUPE_NOMME = re.compile(
    r"\b(groupe|député(?:e)?s?|collègues?|sénateurs?)\s+(?:de la |du |des |)"
    r"(socialistes?|communistes?|écologistes?|insoumis(?:es)?|centristes?|républicains?|radicaux|radicale?s?"
    r"|de la majorité|de l'opposition|de la gauche|de la droite)\b",
    re.I,
)
# Civilité suivie d'un ou plusieurs noms (listes de signataires comprises), jusqu'au premier mot en minuscules.
PERSONNE = re.compile(r"\b(?:M\.|Mme|MM\.|Mmes|Monsieur|Madame)\s+(?:[A-ZÉÈÀÎÔ][\w'’-]+\.?[\s,]*(?:et\s+)?){1,40}")
NOM_APRES_GROUPE = re.compile(r"\[groupe politique\]\s+(?:de l[’']?\w+, )?(?:[A-ZÉÈ][\w'’-]+\s*){2,3}")
NOUS = re.compile(r"\b(notre groupe|nous, députés[^,.]*|les députés (?:du groupe|signataires)[^,.]*)", re.I)
NATURE = re.compile(r"\b(?:(la|le|cette|ce|une|un|de la|du) )?(?:projet|proposition) de (loi|résolution)", re.I)
ARTICLE = {"la": "le", "cette": "ce", "une": "un", "de la": "du"}


def anonymize(text):
    text = PARTIS.sub("[groupe politique]", text)
    text = GROUPE_NOMME.sub(lambda m: f"{m.group(1)} [groupe politique]", text)
    text = NOM_APRES_GROUPE.sub("[groupe politique] [personne] ", text)
    text = NOUS.sub("[les auteurs]", text)
    text = PERSONNE.sub("[personne] ", text)
    def nature(m):
        art = m.group(1)
        return (f"{ARTICLE.get(art.lower(), art)} " if art else "") + f"texte de {m.group(2)}"
    return NATURE.sub(nature, text)


def user_prompt(r, ctx):
    parts = [f"# Texte voté\n\n{anonymize(r['t'])}"]
    if ctx:
        parts.append(f"Dossier législatif : {anonymize(ctx['dossier_titre'])}")
        for key, limit in LIMITES.items():
            body = ctx.get(key, "").strip()
            if not body:
                continue
            cut = " […] (tronqué)" if len(body) > limit else ""
            parts.append(f"## {LIBELLES[key]}\n\n{anonymize(body[:limit])}{cut}")
    else:
        parts.append("(Contenu du texte non disponible : seul l'intitulé est connu.)")
    return "\n\n".join(parts)


def ctx_sources(uid):
    ctx = load_context(uid)
    return ctx["sources"] if ctx else []


def used_parts(ctx):
    return [LIBELLES[k].split(" (")[0] for k in LIMITES if ctx and ctx.get(k, "").strip()]


def extract_json(text):
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0]
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("aucun objet JSON dans la réponse")
    return json.loads(text[start : end + 1])


def fold(value):
    """Forme sans accents ni casse, pour reconnaître « Sante » ou « elevee »."""
    return unicodedata.normalize("NFKD", str(value)).encode("ascii", "ignore").decode().lower().strip()


def normalize(obj, cfg):
    """Rétablit les identifiants attendus quand le modèle a perdu les accents ou la casse."""
    def canon(value, allowed):
        return next((a for a in allowed if fold(a) == fold(value)), value)
    themes = {t["id"]: t for t in cfg["themes"]}
    obj["effet"] = canon(obj.get("effet"), [e["id"] for e in cfg["effets"]])
    obj["confiance"] = canon(obj.get("confiance"), CONFIANCES)
    obj["connaissance"] = canon(obj.get("connaissance"), CONNAISSANCES)
    for t in obj.get("themes") or []:
        if isinstance(t, dict):
            t["id"] = canon(t.get("id"), themes)
            if t["id"] in themes:
                t["sens"] = canon(t.get("sens"), [p["id"] for p in themes[t["id"]]["poles"]] + ["mixte"])
    return obj


def validate(obj, cfg):
    poles = {t["id"]: {p["id"] for p in t["poles"]} | {"mixte"} for t in cfg["themes"]}
    effet_ids = {e["id"] for e in cfg["effets"]}
    errors = []
    if obj.get("connaissance") not in CONNAISSANCES:
        errors.append(f"connaissance invalide : {obj.get('connaissance')!r}")
    if obj.get("effet") not in effet_ids:
        errors.append(f"effet invalide : {obj.get('effet')!r}")
    if obj.get("confiance") not in CONFIANCES:
        errors.append(f"confiance invalide : {obj.get('confiance')!r}")
    themes = obj.get("themes")
    if not isinstance(themes, list):
        errors.append("themes doit être une liste")
    else:
        for t in themes:
            if not isinstance(t, dict) or t.get("sens") not in poles.get(t.get("id"), ()):
                errors.append(f"thème invalide : {t!r}")
    for key in ("resume", "justification"):
        if not isinstance(obj.get(key), str) or not obj[key].strip():
            errors.append(f"{key} manquant")
    if not isinstance(obj.get("sources", []), list):
        errors.append("sources doit être une liste")
    return errors


def run_pi(model, system_prompt, document, instruction, thinking):
    """Lance pi et renvoie (texte de la réponse finale, coût en dollars, modèle ayant répondu).

    Le document (souvent plus de 100 000 caractères) est joint par fichier avec `@`,
    car un argument de ligne de commande est limité à 128 Ko.
    """
    cmd = [
        "pi", "-p", "--mode", "json",
        "--no-session", "--no-tools", "--no-context-files", "--no-extensions",
        "--no-skills", "--no-prompt-templates", "--no-mcp", "--offline",
        "--model", model, "--thinking", thinking,
        "--system-prompt", system_prompt,
        "@texte.md", instruction,
    ]
    # Répertoire de travail neutre : pi ne doit charger aucun fichier du projet.
    with tempfile.TemporaryDirectory() as cwd:
        Path(cwd, "texte.md").write_text(document)
        # Le fournisseur laisse parfois une réponse en suspens, ou limite le débit (429) :
        # on coupe ou on attend, puis on réessaie.
        for attempt in range(PI_ATTEMPTS + 2):
            try:
                # Entrée standard vide : sinon pi hérite de celle du terminal et peut l'attendre indéfiniment.
                proc = subprocess.run(cmd, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=PI_TIMEOUT)
            except subprocess.TimeoutExpired:
                if attempt >= PI_ATTEMPTS - 1:
                    raise RuntimeError(f"pi n'a pas répondu en {PI_TIMEOUT} s, {PI_ATTEMPTS} fois de suite") from None
                continue
            if '"code":429' in proc.stdout or "rate-limited" in proc.stdout:
                time.sleep(15 * (attempt + 1))
                continue
            break
    if proc.returncode != 0:
        raise RuntimeError(f"pi a échoué ({proc.returncode}) : {proc.stderr.strip()[:300]}")
    text, cost, answered_by = None, 0.0, model
    for line in proc.stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = event.get("message") or {}
        if event.get("type") == "message_end" and msg.get("role") == "assistant":
            text = "".join(c.get("text", "") for c in msg.get("content", []) if c.get("type") == "text")
            cost += (msg.get("usage") or {}).get("cost", {}).get("total", 0.0)
            answered_by = msg.get("responseModel") or msg.get("model") or answered_by
            if msg.get("stopReason") == "error" or msg.get("errorMessage"):
                raise RuntimeError(f"erreur du fournisseur : {msg.get('errorMessage')}")
    if text is None:
        raise RuntimeError("pas de réponse de l'assistant dans la sortie de pi")
    return text, cost, answered_by


INSTRUCTION = "Classe le texte décrit dans le document joint, selon les consignes."


def classify_once(r, model, system_prompt, cfg, thinking):
    document = user_prompt(r, load_context(r["uid"]))
    instruction = INSTRUCTION
    total_cost = 0.0
    for attempt in range(2):
        text, cost, answered_by = run_pi(model, system_prompt, document, instruction, thinking)
        total_cost += cost
        try:
            obj = normalize(extract_json(text), cfg)
            errors = validate(obj, cfg)
        except (ValueError, json.JSONDecodeError) as e:
            errors = [str(e)]
        if not errors:
            return obj, total_cost, answered_by
        instruction = (
            f"{INSTRUCTION} Ta réponse précédente était invalide ({'; '.join(errors)}). "
            "Réponds uniquement par l'objet JSON demandé, avec les valeurs autorisées."
        )
    raise ValueError(f"réponse invalide après 2 essais : {'; '.join(errors)}")


NIVEAUX = ["faible", "moyenne", "élevée"]


def aggregate(runs):
    """Combine plusieurs classements indépendants d'un même texte (vote à la majorité).
    Chaque passage est un couple (modèle, classement).

    - effet : celui d'une majorité stricte des passages, sinon « incertain » ;
    - thèmes : retenus s'ils apparaissent dans une majorité des passages ; sens majoritaire, sinon « mixte » ;
    - confiance : celle des passages majoritaires, abaissée d'un cran si l'accord n'est pas unanime,
      « faible » en l'absence de majorité.
    """
    proposes = [{"modele": m, "effet": o["effet"]} for m, o in runs]
    runs = [o for _, o in runs]
    n = len(runs)
    effet, votes = Counter(o["effet"] for o in runs).most_common(1)[0]
    if votes * 2 <= n:
        effet = "incertain"
    agreeing = [o for o in runs if o["effet"] == effet] or runs
    themes = []
    for tid in dict.fromkeys(t["id"] for o in runs for t in o["themes"]):
        sens = [t["sens"] for o in runs for t in o["themes"] if t["id"] == tid]
        if len(sens) * 2 <= n:
            continue
        top, k = Counter(sens).most_common(1)[0]
        themes.append({"id": tid, "sens": top if k * 2 > len(sens) else "mixte"})
    if votes * 2 <= n:
        confiance = "faible"
    else:
        level = round(sum(NIVEAUX.index(o["confiance"]) for o in agreeing) / len(agreeing))
        confiance = NIVEAUX[max(0, level - (votes < n))]
    first = agreeing[0]
    return {
        **first,
        "effet": effet,
        "themes": themes,
        "confiance": confiance,
        "connaissance": Counter(o["connaissance"] for o in runs).most_common(1)[0][0],
        "accord": f"{votes}/{n}",
        "effets_proposes": proposes,
    }


def classify(r, models, system_prompt, cfg, thinking, runs):
    """Classe un texte avec chaque modèle (`runs` fois chacun) et combine les réponses.

    Un modèle en échec est écarté tant qu'il reste au moins deux classements à combiner.
    """
    results, total_cost, errors = [], 0.0, []
    # Les modèles sont chez des fournisseurs différents : on les interroge en même temps.
    jobs = [m for m in models for _ in range(runs)]
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = {pool.submit(classify_once, r, m, system_prompt, cfg, thinking): m for m in jobs}
        for fut in futures:
            try:
                obj, cost, answered_by = fut.result()
            except (RuntimeError, ValueError) as e:
                errors.append(f"{futures[fut]} : {e}")
                continue
            results.append((answered_by, obj))
            total_cost += cost
    expected = len(models) * runs
    if len(results) < min(2, expected):
        raise RuntimeError(" ; ".join(errors) or "aucun classement")
    return aggregate(results), total_cost, sorted({m for m, _ in results})


def save(classements, path):
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(classements, ensure_ascii=False, indent=2) + "\n")
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--leg", action="append", help="législature (répétable) ; toutes par défaut")
    ap.add_argument("--solennels", action="store_true", help="uniquement les scrutins solennels")
    ap.add_argument("--match", help="uniquement les textes dont l'intitulé contient ce texte")
    ap.add_argument("--uid", action="append", help="uniquement ce scrutin (répétable)")
    ap.add_argument("--limit", type=int, help="nombre maximal de textes à classer")
    ap.add_argument("--models", default=",".join(PROTOCOLE["classement"]["modeles"]),
                    help="modèles séparés par des virgules (par défaut ceux de config/protocole.json)")
    ap.add_argument("--thinking", default="off", help="niveau de réflexion pi (off, low, medium…)")
    ap.add_argument("--workers", type=int, default=4, help="textes traités en parallèle")
    ap.add_argument("--runs", type=int, default=PROTOCOLE["classement"]["passages_par_modele"],
                    help="classements indépendants par modèle et par texte")
    ap.add_argument("--force", action="store_true", help="reclasser aussi les textes déjà classés")
    ap.add_argument("--dry-run", action="store_true", help="affiche le prompt du premier texte sans appeler le modèle")
    ap.add_argument("--output", type=Path, default=DATA / "classements.json",
                    help="fichier de sortie (par défaut web/data/classements.json ; utile pour comparer des modèles)")
    args = ap.parse_args()

    meta = json.loads((DATA / "meta.json").read_text())
    cfg = json.loads((CONFIG / "themes.json").read_text())
    classements = json.loads(args.output.read_text()) if args.output.exists() else {}
    system_prompt = build_system_prompt(cfg)
    models = [m.strip() for m in args.models.split(",") if m.strip()]

    todo = []
    for leg in args.leg or list(meta["legislatures"]):
        for r in json.loads((DATA / "votes" / f"{leg}.json").read_text()):
            if r["k"] != "ensemble" or (args.solennels and r["tv"] != "SPS"):
                continue
            if args.match and args.match.lower() not in r["t"].lower():
                continue
            if args.uid and r["uid"] not in args.uid:
                continue
            if r["uid"] in classements and not args.force:
                continue
            todo.append(r)
    todo.sort(key=lambda r: r["d"], reverse=True)
    if args.limit:
        todo = todo[: args.limit]

    if args.dry_run:
        print("=== Prompt système ===\n" + system_prompt)
        if todo:
            print("\n=== Document joint ===\n" + user_prompt(todo[0], load_context(todo[0]["uid"]))[:3000])
        return
    if not todo:
        print("Rien à classer.")
        return

    print(f"{len(todo)} textes à classer avec {', '.join(models)}, {args.runs} passage(s) par modèle", flush=True)
    done, failed, spent = 0, 0, 0.0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(classify, r, models, system_prompt, cfg, args.thinking, args.runs): r for r in todo}
        for fut in as_completed(futures):
            r = futures[fut]
            try:
                obj, cost, answered_by = fut.result()  # answered_by : modèles ayant répondu
            except Exception as e:  # noqa: BLE001 — on journalise et on continue
                failed += 1
                with lock:
                    ERRORS.parent.mkdir(parents=True, exist_ok=True)
                    with ERRORS.open("a") as f:
                        f.write(json.dumps({"uid": r["uid"], "titre": r["t"], "erreur": str(e)}, ensure_ascii=False) + "\n")
                print(f"  ✗ n° {r['n']} : {e}", file=sys.stderr)
                continue
            spent += cost
            done += 1
            with lock:
                classements[r["uid"]] = {
                    "themes": obj["themes"],
                    "effet": obj["effet"],
                    "confiance": obj["confiance"],
                    "connaissance": obj["connaissance"],
                    "resume": obj["resume"].strip(),
                    "justification": obj["justification"].strip(),
                    "sources": (ctx_sources(r["uid"])
                                + [s for s in obj.get("sources", []) if isinstance(s, str) and s.strip()]),
                    "contexte": used_parts(load_context(r["uid"])),
                    "accord": obj["accord"],
                    "effets_proposes": obj["effets_proposes"],
                    "modeles": answered_by,
                    "protocole": PROTOCOLE["version"],
                    "maj": date.today().isoformat(),
                }
                save(classements, args.output)
            themes = ", ".join(f"{t['id']} ({t['sens']})" for t in obj["themes"]) or "aucun thème"
            accord = f" (accord {obj['accord']})"
            print(f"  ✓ n° {r['n']} [{obj['connaissance']}/{obj['confiance']}] {obj['effet']}{accord} · {themes}", flush=True)

    print(f"Terminé : {done} classés, {failed} en échec, coût {spent:.4f} $")
    if failed:
        print(f"Détail des échecs : {ERRORS}")


if __name__ == "__main__":
    main()
