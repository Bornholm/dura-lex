"""Construit les fichiers JSON du tableau de bord à partir de l'open data de l'Assemblée nationale.

Entrées (data/raw/) : archives de scrutins par législature et référentiel historique des organes.
Sorties (web/data/) :
  - meta.json          législatures, groupes, blocs, thèmes, chiffres clés
  - votes/<LEG>.json   un enregistrement compact par scrutin, avec la ventilation par groupe
  - classements.json   créé vide s'il n'existe pas (rempli par scripts/classify.py)

Usage : python3 -I scripts/build_data.py
"""

import json
import re
import sys
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "web" / "data"
CONFIG = ROOT / "config"

LEGISLATURES = {
    "XIV": {"num": "14", "periode": "2012–2017", "archive": "XIV.json.zip"},
    "XV": {"num": "15", "periode": "2017–2022", "archive": "XV.json.zip"},
    "XVI": {"num": "16", "periode": "2022–2024", "archive": "XVI.json.zip"},
    "XVII": {"num": "17", "periode": "2024–", "archive": "XVII.json.zip"},
}

# Un groupe doit avoir pris part à au moins ce nombre de votes sur l'ensemble d'un texte
# pour apparaître dans les tableaux (écarte les groupes éphémères).
MIN_VOTES_ENSEMBLE = 10

POSITIONS = {"pour": "p", "contre": "c", "abstention": "a", "nonVotant": "n"}


def as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def num(d, *keys):
    """Lit un entier sous l'une des clés données (le format a changé entre législatures)."""
    for k in keys:
        if d.get(k) is not None:
            return int(d[k])
    return 0


def origin_of(titre):
    """Origine du texte : projet du Gouvernement ou proposition de parlementaires."""
    t = titre.lower()[:80]
    if "projet de loi" in t:
        return "gouvernement"
    if "proposition de loi" in t or "proposition de résolution" in t:
        return "parlementaire"
    return "autre"


BUDGET = re.compile(
    r"loi de finances|financement de la s[ée]curit[ée] sociale|programmation des finances publiques"
    r"|r[èe]glement du budget|r[ée]sultats de la gestion|fin de gestion|loi sp[ée]ciale",
    re.I,
)


def is_budget(titre):
    """Textes budgétaires : leur vote est d'abord un vote de soutien ou d'opposition au Gouvernement."""
    return bool(BUDGET.search(titre))


def kind_of(titre):
    t = titre.lower().replace("’", "'").strip()
    t = t.removeprefix("sur ").strip()
    if "motion de censure" in t:
        return "censure"
    if t.startswith("l'ensemble de l'article") or t.startswith("l'ensemble des articles"):
        return "article"
    if t.startswith("l'ensemble") or t.startswith("ensemble"):
        return "ensemble"
    if t.startswith("la motion") or t.startswith("la demande de suspension"):
        return "procedure"
    if "partie" in t[:40] or "(première partie)" in t or "(seconde partie)" in t:
        return "partie"
    if t.startswith("l'amendement") or t.startswith("les amendements") or "amendement n°" in t[:60]:
        return "amendement"
    if t.startswith("l'article") or t.startswith("les articles"):
        return "article"
    if "déclaration" in t[:40]:
        return "declaration"
    return "autre"


def iter_scrutins(archive):
    with zipfile.ZipFile(archive) as zf:
        for name in zf.namelist():
            if not name.endswith(".json"):
                continue
            doc = json.loads(zf.read(name))
            if "scrutins" in doc:  # XIVe : un seul fichier contenant tous les scrutins
                yield from as_list(doc["scrutins"]["scrutin"])
            else:
                yield doc["scrutin"]


def load_organes():
    organes = {}
    with zipfile.ZipFile(RAW / "AMO30_historique.json.zip") as zf:
        for name in zf.namelist():
            if "/organe/" not in name or not name.endswith(".json"):
                continue
            o = json.loads(zf.read(name))["organe"]
            if o.get("codeType") == "GP":
                organes[o["uid"]] = o
    return organes


def compact(s):
    synth = s["syntheseVote"]["decompte"]
    obj = s.get("objet") or {}
    dossier = (obj.get("dossierLegislatif") or {}).get("dossierRef")
    groupes = {}
    for g in as_list(s["ventilationVotes"]["organe"]["groupes"]["groupe"]):
        v = g["vote"]
        d = v["decompteVoix"]
        pour, contre = num(d, "pour"), num(d, "contre")
        abst = num(d, "abstentions", "abstention")
        nv = num(d, "nonVotants", "nonVotant") + num(d, "nonVotantsVolontaires")
        pos = POSITIONS.get(v.get("positionMajoritaire"), "n")
        groupes[g["organeRef"]] = [pos, pour, contre, abst, nv, int(g["nombreMembresGroupe"])]
    return {
        "uid": s["uid"],
        "n": int(s["numero"]),
        "d": s["dateScrutin"],
        "tv": s["typeVote"]["codeTypeVote"],
        "k": kind_of(s["titre"]),
        "o": origin_of(s["titre"]),
        "b": is_budget(s["titre"]),
        "s": s["sort"]["code"],
        "t": s["titre"].strip(),
        "dem": ((s.get("demandeur") or {}).get("texte") or "").strip(),
        "dos": dossier,
        "v": [num(synth, "pour"), num(synth, "contre"), num(synth, "abstentions", "abstention"), num(synth, "nonVotants", "nonVotant")],
        "g": groupes,
    }


def main():
    missing = [a for a in [*(l["archive"] for l in LEGISLATURES.values()), "AMO30_historique.json.zip"] if not (RAW / a).exists()]
    if missing:
        sys.exit(f"Archives manquantes dans {RAW} : {', '.join(missing)}")

    cfg_groupes = json.loads((CONFIG / "groupes.json").read_text())
    cfg_themes = json.loads((CONFIG / "themes.json").read_text())
    cfg_majorites = json.loads((CONFIG / "majorites.json").read_text())
    cfg_protocole = json.loads((CONFIG / "protocole.json").read_text())
    organes = load_organes()
    bloc_order = [b["id"] for b in cfg_groupes["blocs"]]
    famille_of = {gid: f for f in cfg_groupes["familles"] for gid in f["groupes"]}
    famille_order = [f["id"] for f in cfg_groupes["familles"]]

    (OUT / "votes").mkdir(parents=True, exist_ok=True)
    meta = {
        "extrait_le": date.today().isoformat(),
        "blocs": cfg_groupes["blocs"],
        "familles": [{k: f[k] for k in ("id", "nom", "bloc", "couleur")} for f in cfg_groupes["familles"]],
        "themes": cfg_themes["themes"],
        "effets": cfg_themes["effets"],
        "majorites": cfg_majorites["periodes"],
        "protocole": {k: v for k, v in cfg_protocole.items() if not k.startswith("_")},
        "legislatures": {},
        "totaux": {"scrutins": 0, "ensemble": 0, "votes_nominatifs": 0},
    }

    for leg, info in LEGISLATURES.items():
        records = sorted((compact(s) for s in iter_scrutins(RAW / info["archive"])), key=lambda r: (r["d"], r["n"]))
        (OUT / "votes" / f"{leg}.json").write_text(json.dumps(records, ensure_ascii=False, separators=(",", ":")))

        ensemble = [r for r in records if r["k"] == "ensemble"]
        participations = {}
        latest_seats = {}
        for r in records:
            for gid, row in r["g"].items():
                latest_seats[gid] = row[5]
        for r in ensemble:
            for gid in r["g"]:
                participations[gid] = participations.get(gid, 0) + 1

        groupes = []
        unknown = []
        for gid, n_votes in participations.items():
            if n_votes < MIN_VOTES_ENSEMBLE:
                continue
            o = organes.get(gid, {})
            famille = famille_of.get(gid)
            if famille is None:
                unknown.append(gid)
                famille = {"id": "NI", "bloc": "Non alignés"}
            groupes.append({
                "id": gid,
                "abrev": o.get("libelleAbrev") or gid,
                "nom": o.get("libelle") or gid,
                "couleur": o.get("couleurAssociee") or cfg_groupes["couleurs"].get(gid) or "#8D949A",
                "famille": famille["id"],
                "bloc": famille["bloc"],
                "sieges": latest_seats.get(gid, 0),
                "debut": (o.get("viMoDe") or {}).get("dateDebut"),
                "fin": (o.get("viMoDe") or {}).get("dateFin"),
            })
        groupes.sort(key=lambda g: (bloc_order.index(g["bloc"]), famille_order.index(g["famille"]), -g["sieges"]))
        if unknown:
            print(f"  [{leg}] groupes absents de config/groupes.json (rangés parmi les non-inscrits) : {', '.join(unknown)}", file=sys.stderr)

        nominatifs = sum(r["v"][0] + r["v"][1] + r["v"][2] for r in records)
        meta["legislatures"][leg] = {
            "periode": info["periode"],
            "scrutins": len(records),
            "ensemble": len(ensemble),
            "votes_nominatifs": nominatifs,
            "groupes": groupes,
        }
        meta["totaux"]["scrutins"] += len(records)
        meta["totaux"]["ensemble"] += len(ensemble)
        meta["totaux"]["votes_nominatifs"] += nominatifs
        print(f"{leg} : {len(records)} scrutins, dont {len(ensemble)} sur l'ensemble d'un texte, {len(groupes)} groupes")

    (OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    classements = OUT / "classements.json"
    if not classements.exists():
        classements.write_text("{}\n")
    print(f"Écrit dans {OUT}")


if __name__ == "__main__":
    main()
