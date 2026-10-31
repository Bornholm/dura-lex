"""Récupère le contenu des textes votés pour enrichir le classement automatique.

Pour chaque vote sur l'ensemble d'un texte :
  1. retrouve le dossier législatif (références de vote du dossier, sinon rapprochement par l'intitulé) ;
  2. télécharge le texte initial déposé à l'Assemblée et en extrait l'exposé des motifs et le dispositif (articles) ;
  3. télécharge l'étude d'impact quand elle existe (projets de loi) et en extrait le texte.

Entrées : data/raw/Dossiers_Legislatifs_<NN>.json.zip, web/data/votes/<LEG>.json
Sorties : data/cache/docs/ (fichiers bruts), data/context/<uid du scrutin>.json

Usage : python3 -I scripts/fetch_context.py [--leg XVII] [--limit 20] [--workers 4]
"""

import argparse
import html
import http.client
import json
import re
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
CACHE = ROOT / "data" / "cache" / "docs"
CONTEXT = ROOT / "data" / "context"
VOTES = ROOT / "web" / "data" / "votes"

LEGS = {"XIV": 14, "XV": 15, "XVI": 16, "XVII": 17}
BASE = "https://www.assemblee-nationale.fr"
USER_AGENT = "dura-lex/0.1 (analyse des scrutins publics, open data)"


# ---------- Dossiers législatifs ----------

def iter_documents(path):
    """Projets et propositions de loi (titre complet et dossier de rattachement)."""
    with zipfile.ZipFile(path) as zf:
        for name in zf.namelist():
            if not name.endswith(".json"):
                continue
            if name.count("/") and "/document/" not in name:
                continue
            doc = json.loads(zf.read(name))
            if "export" in doc:
                yield from doc["export"].get("textesLegislatifs", {}).get("document", [])
            elif "document" in doc:
                yield doc["document"]


def iter_dossiers(path):
    with zipfile.ZipFile(path) as zf:
        for name in zf.namelist():
            if not name.endswith(".json"):
                continue
            doc = json.loads(zf.read(name))
            if "export" in doc:  # XIVe et XVe : un seul fichier
                for d in doc["export"]["dossiersLegislatifs"]["dossier"]:
                    yield d["dossierParlementaire"]
            elif "dossierParlementaire" in doc:
                yield doc["dossierParlementaire"]


def walk_actes(node, out):
    """Aplatit l'arbre des actes législatifs en (codeActe, textes associés, votes)."""
    if isinstance(node, list):
        for n in node:
            walk_actes(n, out)
        return
    if not isinstance(node, dict):
        return
    textes = []
    if node.get("texteAssocie"):
        textes.append(node["texteAssocie"])
    ta = (node.get("textesAssocies") or {}).get("texteAssocie")
    for t in ta if isinstance(ta, list) else [ta] if ta else []:
        if t.get("refTexteAssocie"):
            textes.append(t["refTexteAssocie"])
    votes = (node.get("voteRefs") or {}).get("voteRef")
    votes = votes if isinstance(votes, list) else [votes] if votes else []
    if node.get("codeActe"):
        out.append((node["codeActe"], textes, votes))
    walk_actes((node.get("actesLegislatifs") or {}).get("acteLegislatif"), out)


def normalize(title):
    t = unicodedata.normalize("NFKD", title.lower().replace("’", "'"))
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = re.sub(r"\(.*?\)", " ", t)
    t = re.sub(r"^(sur )?l'ensemble (du |de la |de l'|des )?", "", t.strip())
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def load_dossiers():
    dossiers, by_vote, by_title = {}, {}, {}
    for leg, num in LEGS.items():
        path = RAW / f"Dossiers_Legislatifs_{num}.json.zip"
        if not path.exists():
            sys.exit(f"Archive manquante : {path}")
        for d in iter_dossiers(path):
            actes = []
            walk_actes((d.get("actesLegislatifs") or {}).get("acteLegislatif"), actes)
            dossiers[d["uid"]] = {"uid": d["uid"], "titre": d["titreDossier"]["titre"], "actes": actes}
            for _, _, votes in actes:
                for v in votes:
                    by_vote.setdefault(v, d["uid"])
            by_title.setdefault((leg, normalize(d["titreDossier"]["titre"])), d["uid"])
        # Les dossiers portent un titre court ; les scrutins citent l'intitulé complet du texte,
        # qui est celui des documents (projets et propositions de loi).
        for doc in iter_documents(path):
            if not re.match(r"^(PION|PRJL)", doc.get("uid", "")) or not doc.get("dossierRef"):
                continue
            title = (doc.get("titres") or {}).get("titrePrincipal")
            if title:
                by_title.setdefault((leg, normalize(title)), doc["dossierRef"])
    return dossiers, by_vote, by_title


def find_dossier(r, leg, dossiers, by_vote, by_title):
    if r["uid"] in by_vote:
        return by_vote[r["uid"]], "voteRef"
    if r.get("dos") in dossiers:
        return r["dos"], "scrutin"
    key = normalize(r["t"])
    if by_title.get((leg, key)) in dossiers:
        return by_title[(leg, key)], "intitule"
    # Intitulé du scrutin plus long ou plus court que celui du document.
    candidates = {uid for (l, t), uid in by_title.items() if l == leg and len(t) > 25 and (t in key or key in t) and uid in dossiers}
    if len(candidates) == 1:
        return candidates.pop(), "intitule"
    return None, None


def initial_text(dossier):
    """Premier texte déposé à l'Assemblée (projet ou proposition de loi)."""
    for code, textes, _ in dossier["actes"]:
        if code.startswith("AN") and code.endswith("-DEPOT"):
            for t in textes:
                if re.match(r"^(PION|PRJL)AN", t):
                    return t
    return None


def impact_study(dossier, texte):
    """Numéro de l'étude d'impact : acte « -ETI » du dossier, sinon celui du projet de loi."""
    for code, textes, _ in dossier["actes"]:
        if code.startswith("AN") and code.endswith("-ETI"):
            for t in textes:
                if t.startswith("ETDIAN"):
                    return int(re.search(r"B(\d+)$", t).group(1))
    if texte and texte.startswith("PRJL"):
        return int(re.search(r"B(\d+)$", texte).group(1))
    return None


# ---------- Téléchargement ----------

def fetch(url, dest, want):
    """Télécharge url vers dest (mis en cache). `want` : "html" ou "pdf".

    Renvoie le chemin, ou None si le document n'existe pas sous cette forme
    (le site renvoie parfois une page HTML à la place d'un PDF absent).
    """
    if dest.exists():
        return dest if dest.stat().st_size > 0 else None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = resp.read()
                ctype = resp.headers.get("Content-Type", "")
            if (want == "pdf") != ("pdf" in ctype):
                data = b""
            dest.write_bytes(data)
            return dest if data else None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                dest.write_bytes(b"")  # mémorise l'absence
                return None
            time.sleep(2 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException):
            time.sleep(2 * (attempt + 1))
    return None


def read_html(path):
    raw = path.read_bytes()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", "replace")  # anciennes pages .asp


def fetch_texte(texte, num):
    """Texte d'un projet ou d'une proposition de loi : HTML open data, ancienne page, puis PDF."""
    n = int(re.search(r"B(\d+)$", texte).group(1))
    folder, prefix = ("projets", "pl") if texte.startswith("PRJL") else ("propositions", "pion")
    candidates = [
        (f"{BASE}/dyn/opendata/{texte}.html", CACHE / f"{texte}.html", "html"),
        (f"{BASE}/{num}/{folder}/{prefix}{n:04d}.asp", CACHE / f"{texte}.asp.html", "html"),
        (f"{BASE}/{num}/pdf/{folder}/{prefix}{n:04d}.pdf", CACHE / f"{texte}.pdf", "pdf"),
    ]
    for url, dest, want in candidates:
        path = fetch(url, dest, want)
        if not path:
            continue
        text = pdf_to_text(path) if want == "pdf" else html_to_text(read_html(path))
        if len(text) > 1500:  # écarte les pages vides ou réduites à l'en-tête
            return url, text
    return None, ""


def html_to_text(raw):
    raw = re.sub(r"<(script|style)\b.*?</\1>", " ", raw, flags=re.S | re.I)
    raw = re.sub(r"</(p|div|h\d|li|tr|br)\s*>|<br\s*/?>", "\n", raw, flags=re.I)
    text = html.unescape(re.sub(r"<[^>]+>", " ", raw))
    text = re.sub(r"[ \t   ]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()


ARTICLE_1 = re.compile(r"\n\s*(Article\s+(premier|1\s*er|unique)\b|TITRE\s+(PREMIER|I\s*ER|Ier|I)\b|CHAPITRE\s+(PREMIER|I\s*ER|Ier|I)\b)")
DISPOSITIF = re.compile(r"\n\s*(PROPOSITION|PROJET) DE LOI( ORGANIQUE| CONSTITUTIONNELLE)?\s*(\(.*?\))?\s*\n")


def split_texte(text):
    """Sépare l'exposé des motifs du dispositif (articles).

    Après l'exposé, le dispositif s'ouvre sur un intitulé « PROPOSITION DE LOI » ou
    « PROJET DE LOI » seul sur sa ligne, suivi des articles.
    """
    m = re.search(r"EXPOS[ÉE] (G[ÉE]N[ÉE]RAL )?DES MOTIFS", text, flags=re.I)
    if not m:
        art = ARTICLE_1.search(text)
        return "", (text[art.start():] if art else text).strip()
    rest = text[m.end():]
    heads = [h for h in DISPOSITIF.finditer(rest) if ARTICLE_1.search(rest[h.end(): h.end() + 3000])]
    cut = heads[-1].start() if heads else None
    if cut is None:
        art = ARTICLE_1.search(rest)
        cut = art.start() if art else None
    if cut is None:
        return rest.strip(), ""
    return rest[:cut].strip(), rest[cut:].strip()


def pdf_to_text(path):
    proc = subprocess.run(["pdftotext", "-q", "-enc", "UTF-8", str(path), "-"], capture_output=True, timeout=120)
    return re.sub(r"\n\s*\n+", "\n\n", proc.stdout.decode("utf-8", "replace")).strip()


def build_context(r, leg, dossier, how):
    num = LEGS[leg]
    out = {"scrutin": r["uid"], "dossier": dossier["uid"], "dossier_titre": dossier["titre"], "rapprochement": how,
           "texte": None, "expose": "", "dispositif": "", "etude_impact": "", "sources": []}
    texte = initial_text(dossier)
    if texte:
        url, text = fetch_texte(texte, num)
        if url:
            expose, dispositif = split_texte(text)
            out.update(texte=texte, expose=expose, dispositif=dispositif)
            out["sources"].append(url)
    ei = impact_study(dossier, texte)
    if ei:
        url = f"{BASE}/{num}/pdf/projets/pl{ei:04d}-ei.pdf"
        path = fetch(url, CACHE / f"ETDI-{num}-{ei:04d}.pdf", "pdf")
        if path:
            out["etude_impact"] = pdf_to_text(path)
            out["sources"].append(url)
    out["sources"].append(f"{BASE}/dyn/{num}/dossiers/{dossier['uid']}")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--leg", action="append", choices=list(LEGS))
    ap.add_argument("--limit", type=int)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--force", action="store_true", help="reconstruire les contextes déjà présents")
    args = ap.parse_args()

    CACHE.mkdir(parents=True, exist_ok=True)
    CONTEXT.mkdir(parents=True, exist_ok=True)
    dossiers, by_vote, by_title = load_dossiers()

    todo, unmatched = [], []
    for leg in args.leg or list(LEGS):
        for r in json.loads((VOTES / f"{leg}.json").read_text()):
            if r["k"] != "ensemble":
                continue
            if (CONTEXT / f"{r['uid']}.json").exists() and not args.force:
                continue
            uid, how = find_dossier(r, leg, dossiers, by_vote, by_title)
            if uid:
                todo.append((r, leg, dossiers[uid], how))
            else:
                unmatched.append((leg, r))
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(todo)} contextes à construire, {len(unmatched)} scrutins sans dossier retrouvé")

    stats = {"expose": 0, "dispositif": 0, "etude_impact": 0, "rien": 0}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(build_context, *item): item[0] for item in todo}
        for i, fut in enumerate(as_completed(futures), 1):
            r = futures[fut]
            try:
                ctx = fut.result()
            except Exception as e:  # noqa: BLE001 — on journalise et on continue
                print(f"  ✗ n° {r['n']} : {e}", file=sys.stderr)
                continue
            (CONTEXT / f"{r['uid']}.json").write_text(json.dumps(ctx, ensure_ascii=False, indent=1))
            for k in ("expose", "dispositif", "etude_impact"):
                stats[k] += bool(ctx[k])
            stats["rien"] += not (ctx["expose"] or ctx["dispositif"])
            if i % 50 == 0:
                print(f"  {i}/{len(todo)}")

    print("Contenu obtenu :", ", ".join(f"{k} {v}" for k, v in stats.items()))
    if unmatched:
        path = ROOT / "data" / "context_sans_dossier.txt"
        path.write_text("\n".join(f"{leg}\t{r['uid']}\t{r['t']}" for leg, r in unmatched) + "\n")
        print(f"Scrutins sans dossier : {path}")


if __name__ == "__main__":
    main()
