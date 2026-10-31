# Dura Lex

Qui vote quoi à l'Assemblée nationale, et au profit de qui. Analyse des scrutins publics depuis 2012 (XIVe à XVIIe législature) à partir de l'open data de l'Assemblée.

Tableau de bord en ligne : https://bornholm.github.io/dura-lex/

Le site est publié sur GitHub Pages à chaque push sur `main` (`.github/workflows/pages.yml`, dossier `web/`). Le dossier `data/` (archives, documents téléchargés, contexte des textes, environ 700 Mo) n'est pas versionné : les scripts le reconstruisent.

## Démarrage

```sh
# 1. Télécharger les données brutes (une fois, ~70 Mo)
mkdir -p data/raw && cd data/raw
curl -Lo XIV.json.zip  https://data.assemblee-nationale.fr/static/openData/repository/14/loi/scrutins/Scrutins_XIV.json.zip
curl -Lo XV.json.zip   https://data.assemblee-nationale.fr/static/openData/repository/15/loi/scrutins/Scrutins_XV.json.zip
curl -Lo XVI.json.zip  https://data.assemblee-nationale.fr/static/openData/repository/16/loi/scrutins/Scrutins.json.zip
curl -Lo XVII.json.zip https://data.assemblee-nationale.fr/static/openData/repository/17/loi/scrutins/Scrutins.json.zip
curl -Lo AMO30_historique.json.zip https://data.assemblee-nationale.fr/static/openData/repository/17/amo/tous_acteurs_mandats_organes_xi_legislature/AMO30_tous_acteurs_tous_mandats_tous_organes_historique.json.zip
curl -Lo Dossiers_Legislatifs_14.json.zip https://data.assemblee-nationale.fr/static/openData/repository/14/loi/dossiers_legislatifs/Dossiers_Legislatifs_XIV.json.zip
curl -Lo Dossiers_Legislatifs_15.json.zip https://data.assemblee-nationale.fr/static/openData/repository/15/loi/dossiers_legislatifs/Dossiers_Legislatifs_XV.json.zip
curl -Lo Dossiers_Legislatifs_16.json.zip https://data.assemblee-nationale.fr/static/openData/repository/16/loi/dossiers_legislatifs/Dossiers_Legislatifs.json.zip
curl -Lo Dossiers_Legislatifs_17.json.zip https://data.assemblee-nationale.fr/static/openData/repository/17/loi/dossiers_legislatifs/Dossiers_Legislatifs.json.zip
cd ../..

# 2. Construire les fichiers du tableau de bord (Python 3, bibliothèque standard uniquement)
python3 -I scripts/build_data.py

# 3. Servir le site
python3 -m http.server 8000 -d web
# → http://localhost:8000
```

Le site doit être servi en HTTP : ouvert directement en `file://`, le navigateur bloque le chargement des JSON.

## Classement automatique

Deux étapes :

1. `scripts/fetch_context.py` retrouve le dossier législatif de chaque vote sur l'ensemble d'un texte (références de vote du dossier, sinon rapprochement par l'intitulé), télécharge le texte initial déposé à l'Assemblée et l'étude d'impact quand elle existe, et écrit dans `data/context/<scrutin>.json` le dispositif (articles), l'exposé des motifs et le texte de l'étude d'impact. Les fichiers bruts sont gardés dans `data/cache/docs/` ; une relance ne télécharge que ce qui manque.
2. `scripts/classify.py` appelle l'agent [pi](https://github.com/badlogic/pi-mono) en mode non interactif (`pi -p --mode json`, sans outils ni contexte de projet) pour classer chaque vote sur l'ensemble d'un texte. Le processus est entièrement automatique, sans relecture humaine. Les résultats sont écrits dans `web/data/classements.json` ; le tableau de bord permet de filtrer selon la confiance déclarée par le modèle.

```sh
python3 -I scripts/fetch_context.py --workers 4             # contexte des textes (une fois)
python3 -I scripts/classify.py --dry-run --limit 1          # voir le prompt, sans appel
python3 -I scripts/classify.py --leg XVII --solennels --limit 10
python3 -I scripts/classify.py --match "immigration"
python3 -I scripts/classify.py --workers 4                  # tout ce qui reste à classer
python3 -I scripts/classify.py --force --workers 4          # tout reclasser
```

- Modèles : ceux de `config/protocole.json`, trois fournisseurs différents (DeepSeek, Mistral, Google), un passage chacun. `--models` en change la liste, `--runs` le nombre de passages par modèle. Environ 0,004 $ par texte avec les trois modèles.
- Les réponses sont combinées à la majorité : un effet n'est retenu que si une majorité stricte des modèles le propose, sinon il devient `incertain` ; un thème n'est retenu que si une majorité des modèles le propose, avec le pôle majoritaire (sinon `mixte`). La confiance baisse d'un cran si l'accord n'est pas unanime. Le champ `accord` (par exemple `2/3`) et la liste `effets_proposes` (modèle et effet) gardent la trace du vote. Un modèle en échec est écarté tant qu'il reste deux classements.
- Le modèle reçoit l'intitulé et le contexte collecté (jusqu'à 40 000 caractères de dispositif, 25 000 d'exposé des motifs, 40 000 d'étude d'impact), joint à pi par fichier (`@texte.md`). Il ne reçoit jamais les votes, pour ne pas classer un texte d'après ceux qui l'ont soutenu.
- Avant l'envoi, `anonymize()` masque les indices d'appartenance politique : noms de partis et de groupes, « député socialiste », « notre groupe », « députés de la majorité », noms de personnes précédés d'une civilité, et la nature du texte (« projet » ou « proposition » de loi devient « texte de loi »). La date n'est pas transmise. Les modèles peuvent toutefois reconnaître les textes les plus connus ; la consigne leur demande alors de ne pas tenir compte de leur réception politique.
- Les consignes demandent de juger sur le dispositif : l'exposé des motifs est le plaidoyer des auteurs, l'étude d'impact celui des porteurs du texte. Les exemples de vigilance sur les intitulés vont dans les deux sens.
- `typesafe/jev-router` est déconseillé pour ce corpus : il choisit un modèle différent selon la requête, ce qui rend les classements incomparables entre eux, et pi ne connaît pas son tarif.
- Les identifiants renvoyés sans accents (« Sante ») sont rétablis ; une limitation de débit du fournisseur (429) est attendue puis réessayée.
- Chaque appel à pi est limité à 180 secondes et réessayé deux fois ; pi reçoit une entrée standard vide (sinon il peut attendre celle du terminal).
- `--output` écrit ailleurs que dans `web/data/classements.json`, pour comparer des modèles ; `--uid` cible un scrutin.
- Les textes déjà classés sont ignorés ; `--force` les reclasse.
- Le prompt est dans `config/prompt_classement.md`, les échecs dans `data/classify_errors.jsonl`.

## Organisation

| Chemin | Rôle |
|---|---|
| `scripts/build_data.py` | Lit les archives et produit `web/data/meta.json` et `web/data/votes/<LEG>.json` |
| `scripts/fetch_context.py` | Récupère dispositif, exposé des motifs et étude d'impact de chaque texte voté |
| `scripts/classify.py` | Classe chaque texte avec un modèle de langue via pi |
| `config/prompt_classement.md` | Consignes données au modèle |
| `config/protocole.json` | Choix de méthode fixés avant le calcul : modèles, agrégation, paramètres de l'indice |
| `config/groupes.json` | Regroupement éditorial des groupes en blocs, couleurs de repli |
| `config/majorites.json` | Partis membres de la majorité gouvernementale, par période |
| `config/themes.json` | Thèmes, leurs deux pôles, catégories d'effet redistributif |
| `web/data/classements.json` | Classement des textes (thèmes, sens, effet, confiance, sources) |
| `web/` | Tableau de bord statique : vue d'ensemble et scrutins |

## Méthode

- **Type de scrutin** : déduit de l'intitulé (`ensemble`, `article`, `amendement`, `censure`, `procedure`, `partie`, `declaration`, `autre`). Par défaut, l'analyse porte sur les votes sur l'ensemble d'un texte.
- **Position d'un groupe** : la `positionMajoritaire` publiée par l'Assemblée. Pour un bloc, la position qui réunit le plus de députés du bloc. La fiche d'un scrutin signale les cas où la position publiée ne correspond pas au décompte.
- **Thème et orientation** : chaque thème oppose deux pôles, décrits chacun dans ses propres termes (Immigration : `ouverture` / `controle` ; Sécurité & justice : `libertes` / `securite` ; Environnement : `normes` / `activite`…). Un texte classé indique pour chaque thème le pôle vers lequel il va, ou `mixte`. L'ordre des pôles (A, B) est arbitraire et le tableau de bord ne leur associe aucune couleur : le vert et le rouge ne désignent que les votes pour et contre.
- **Origine du texte** : déduite de l'intitulé, projet de loi (Gouvernement) ou proposition de loi ou de résolution (parlementaires).
- **Majorité et opposition** : `config/majorites.json` liste, par période, les partis qui soutiennent le Gouvernement. Le filtre « Position du parti » ne garde, scrutin par scrutin, que les partis dans la majorité (ou dans l'opposition) à la date du vote ; le tableau « Dans la majorité, dans l'opposition » compare les deux situations pour un même parti. Choix éditorial à vérifier pour les gouvernements récents.
- **Pour ou contre** : la matrice thématique affiche au choix le taux de « pour » ou de « contre ». Le « contre » est plus net : ne pas voter pour peut être une abstention.
- **Textes à thème unique** : option de la matrice qui ne garde que les textes classés dans un seul thème, pour écarter ceux qui touchent à plusieurs sujets à la fois.
- **Comparer des partis** : on choisit deux partis ou plus ; seuls les scrutins où chacun a pris position restent, pour comparer à périmètre égal (les partis n'ont pas tous siégé aux mêmes périodes).
- **Textes budgétaires** : repérés par leur intitulé (loi de finances, de financement de la Sécurité sociale, de programmation des finances publiques, de règlement, de fin de gestion, loi spéciale). Exclus par défaut de l'indice redistributif, parce que leur vote exprime d'abord le soutien ou l'opposition au Gouvernement.
- **Indice redistributif** : taux de « pour » sur les textes `modestes`, moins le taux de « pour » sur les textes `aises` ou `entreprises`, sur les seuls textes clivants et hors budgets (voir le protocole). Chaque valeur affiche le nombre de textes de chaque côté et un intervalle de confiance à 95 % obtenu par rééchantillonnage des textes (1 000 tirages, graine fixe).
- **Sensibilité** : le tableau « Sensibilité » recalcule l'indice avec les budgets, avec tous les textes, sans les textes `entreprises`, avec les seuls textes classés à l'unanimité des modèles, et sur les seuls votes émis dans l'opposition. Un parti est dit « robuste » quand, dans toutes les variantes calculables, l'intervalle reste du même côté de zéro.
- **Texte clivant** : le camp minoritaire (contre et abstentions, ou pour) réunit au moins 25 % des suffrages exprimés.
- **Effet redistributif** : `modestes` (progressif), `aises` (régressif), `entreprises`, `neutre`, `ambivalent`, `incertain`. Convention : on classe l'effet direct (qui reçoit ou paie de l'argent du fait même des mesures), pas les effets indirects attendus sur l'emploi, l'investissement ou l'offre, qui sont discutés. La convention s'applique dans les deux sens : baisse d'une prestation sous condition de ressources `aises` quel que soit le public visé, baisse de cotisations patronales `entreprises` même si l'objectif affiché est l'emploi, encadrement d'un loyer `modestes`.
- **Blocs** : nuancier le plus récent du ministère de l'Intérieur (circulaire du 2 février 2026, validée par le Conseil d'État le 27 février 2026) : LFI en « Extrême gauche », RN et UDR en « Extrême droite ». Ce classement est appliqué à toute la période, alors que l'Intérieur plaçait LFI à gauche avant 2026. Il est contesté par les partis concernés ; la vue par partis n'en dépend pas.

## Protocole et limites

Les choix de méthode de l'indice et du classement sont fixés dans `config/protocole.json` (version 4, fixée le 31 octobre 2026, avant le reclassement à trois modèles). Ils ne doivent pas être modifiés pour corriger un résultat qui surprend : une autre option se présente comme variante dans le tableau de sensibilité. Toute modification change la version, notée ci-dessous.

Historique :
- v1 : classement sur l'intitulé seul, un modèle.
- v2 : contexte (dispositif, exposé des motifs, étude d'impact), un modèle, un passage.
- v3 : un modèle, trois passages ; budgets exclus de l'indice, textes clivants seulement, côté régressif élargi aux entreprises. Ces trois choix ont été faits **après** avoir vu des résultats jugés surprenants : c'est pour cela qu'ils sont maintenant figés et accompagnés d'une analyse de sensibilité.
- v4 : axes à deux pôles neutres, consignes symétriques, effet direct comme convention explicite, masquage des indices d'appartenance politique, trois modèles de fournisseurs différents, intervalles de confiance, tableau de sensibilité.

Limites connues, non corrigées :
- Pas d'échantillon codé par des experts : on mesure l'accord entre modèles, pas leur justesse.
- Les modèles de langue ont des biais politiques documentés ; en combiner trois en atténue les particularités sans garantir l'absence d'un biais commun.
- Seuls les scrutins publics et les votes sur l'ensemble d'un texte entrent dans l'indice. Les amendements n'y sont pas, chaque texte pèse autant quelle que soit son importance, et le texte classé est le texte déposé, pas le texte voté.
- L'exécutif choisit la plupart des textes soumis au vote, et Renaissance, MoDem et Horizons n'ont jamais été dans l'opposition depuis 2017 : pour eux, ligne politique et soutien au Gouvernement ne se distinguent pas.
- `config/majorites.json` doit être tenu à jour à chaque changement de gouvernement.

### Format de `classements.json`

```json
{
  "VTANR5L17V6319": {
    "themes": [{ "id": "Protection sociale", "sens": "extension | conditions | mixte" }],
    "effet": "modestes | aises | entreprises | neutre | ambivalent | incertain",
    "confiance": "faible | moyenne | élevée",
    "connaissance": "connu | partiel | inconnu",
    "resume": "…",
    "contexte": ["Dispositif du texte initial", "Exposé des motifs", "Étude d'impact"],
    "justification": "…",
    "sources": ["https://…"],
    "accord": "2/3",
    "effets_proposes": [{ "modele": "deepseek/deepseek-v4.1-flash", "effet": "modestes" }],
    "modeles": ["deepseek/deepseek-v4.1-flash", "google/gemini-3.5-flash-lite", "mistralai/mistral-small-2603"],
    "protocole": 4,
    "maj": "2026-10-31"
  }
}
```

## Licences

- Code (scripts, site, configuration) : licence MIT, voir `LICENSE`.
- Données publiées dans `web/data/` (votes et classements) : Licence Ouverte / Open Licence 2.0 d'Etalab, voir `LICENCE-DONNEES.md`. Les votes viennent de l'open data de l'Assemblée nationale, diffusé sous la même licence. Les classements sont produits automatiquement par des modèles de langage et peuvent contenir des erreurs.
