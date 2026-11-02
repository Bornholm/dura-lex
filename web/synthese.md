# Dura Lex : synthèse de l'étude

Ce document résume l'étude Dura Lex pour qu'un lecteur, humain ou agent, puisse en discuter sans lire le code. Les chiffres datent du classement du 31 octobre 2026.

- Tableau de bord : https://bornholm.github.io/dura-lex/
- Dépôt : https://github.com/Bornholm/dura-lex

## 1. La question

Quand l'Assemblée nationale vote une loi qui déplace de l'argent, qui vote pour ? L'étude cherche à savoir si chaque parti soutient plutôt les lois qui profitent aux ménages modestes ou celles qui profitent aux ménages aisés et aux entreprises. Elle couvre les scrutins publics de juin 2012 à octobre 2026, soit les XIVe, XVe, XVIe et XVIIe législatures.

Elle mesure ce que les partis votent. Elle ne mesure pas ce qu'ils promettent, ni l'effet réel des lois une fois appliquées.

## 2. Les données

Tout vient de l'open data de l'Assemblée nationale (data.assemblee-nationale.fr), sous Licence Ouverte 2.0 :

- les scrutins publics des quatre législatures : 19 279 scrutins et 2 630 519 votes individuels ;
- le référentiel des députés, groupes et mandats, pour rattacher chaque député à son groupe ;
- les dossiers législatifs, pour retrouver le texte de chaque loi votée.

L'indice ne porte que sur les **votes sur l'ensemble d'un texte**, c'est-à-dire le vote final d'une lecture. Il y en a 941. Les votes sur des amendements, des articles ou des motions de censure servent aux autres vues du tableau de bord mais pas à l'indice.

Pour chacun de ces 941 textes, un script télécharge le texte initial déposé à l'Assemblée. Il en extrait trois parties :
- le dispositif, c'est-à-dire les articles ;
- l'exposé des motifs ;
- l'étude d'impact, quand elle existe.

### Position d'un groupe

On reprend la position majoritaire que l'Assemblée publie pour chaque groupe. Pour un bloc, on retient la position qui réunit le plus de députés de ce bloc.

### Partis et blocs

Les groupes changent de nom d'une législature à l'autre, par exemple SRC, NG, SOC puis SOC-A. L'étude les regroupe en 14 « partis », que le code appelle `familles` :
- à gauche : LFI, GDR, ECO, PS, RRDP ;
- au centre : REN, MODEM, HOR, UDI ;
- à droite et à l'extrême droite : LR, RN, UDR ;
- non alignés : LIOT, NI.

Ces partis sont ensuite rangés en six blocs. Le tableau de bord s'ouvre sur la vue par blocs.

| Bloc | Partis |
|---|---|
| Extrême gauche | LFI |
| Gauche | GDR, ECO, PS, RRDP |
| Centre | REN, MODEM, HOR, UDI |
| Droite | LR |
| Extrême droite | RN, UDR |
| Non alignés | LIOT, NI |

Les blocs suivent le classement le plus récent du ministère de l'Intérieur. Il s'agit de la circulaire du 2 février 2026 pour les municipales, que le Conseil d'État a validée le 27 février 2026 (n° 512694).
- **Application dans le temps :** l'étude applique ce classement à toute la période, alors que l'Intérieur classait LFI à gauche avant 2026.
- **Contestation :** les partis concernés contestent ce classement.
- **Vue par partis :** elle ne dépend pas de ce choix.

## 3. Le classement des lois par IA

Personne ne relit les classements. Le choix est assumé : le but est un processus entièrement automatique et reproductible. Le prix à payer, c'est qu'aucun expert n'a vérifié les classements.

### Ce que reçoit le modèle

Le modèle reçoit l'intitulé, le dispositif (40 000 caractères au plus), l'exposé des motifs (25 000) et l'étude d'impact (40 000).

Il ne reçoit jamais les votes. Avant l'envoi, un script masque aussi tout ce qui trahit le camp politique de l'auteur :
- les noms de partis et de groupes ;
- les formules comme « député socialiste », « notre groupe » ou « députés de la majorité » ;
- les noms de personnes précédés d'une civilité, y compris les listes de signataires ;
- la nature du texte : « projet de loi » (Gouvernement) et « proposition de loi » (parlementaires) deviennent tous deux « texte de loi ».

La date n'est pas transmise non plus. Ce masquage fait 1 624 remplacements sur le corpus.

Les modèles peuvent quand même reconnaître une loi célèbre. La consigne leur demande alors de ne pas tenir compte de sa réception politique.

### Les consignes

Le prompt complet est dans `config/prompt_classement.md`. Ses règles principales :

- Le modèle juge sur les articles. L'exposé des motifs est le plaidoyer des auteurs. L'étude d'impact est rédigée par ceux qui portent le texte.
- Il se méfie des intitulés, et les exemples de vigilance vont dans les deux sens. Un texte « pour l'emploi » peut réduire des droits ; un texte « de justice sociale » peut surtout profiter aux classes moyennes.
- Il n'emploie aucun vocabulaire qui juge le texte.
- Il répond « incertain » s'il manque d'éléments.

### Thèmes et orientation

Chaque texte reçoit de 0 à 3 thèmes. Chaque thème oppose deux orientations formulées de façon neutre, et le modèle indique vers laquelle va le texte, ou « mixte ». Ces orientations s'appellent les pôles A et B. Leur ordre est arbitraire et le site ne leur donne aucune couleur.

| Thème | Pôle A | Pôle B |
|---|---|---|
| Fiscalité | accroît les prélèvements ou leur progressivité | réduit les prélèvements ou leur progressivité |
| Travail | renforce les protections des salariés | accroît la flexibilité des employeurs |
| Retraites | étend les droits à la retraite | restreint ces droits pour l'équilibre du système |
| Protection sociale | étend les prestations ou leur accès | restreint les prestations ou en durcit les conditions |
| Santé | élargit l'accès aux soins | maîtrise la dépense, au prix d'un accès réduit |
| Logement | renforce les droits des locataires ou la régulation | renforce les droits des propriétaires ou la liberté du marché |
| Environnement | renforce les normes environnementales | allège ces contraintes au profit de l'activité |
| Immigration | élargit les droits des étrangers ou l'accès au séjour | renforce le contrôle des flux ou les conditions d'accès |
| Sécurité & justice | renforce les libertés publiques et les droits de la défense | renforce les pouvoirs de police, de surveillance ou de sanction |
| Services publics | accroît les moyens des services publics | réduit leur coût ou les ouvre au privé |

### Effet redistributif

Le modèle range chaque texte dans l'une de six catégories :

| Identifiant | Libellé | Sens |
|---|---|---|
| `modestes` | Progressif | gain direct pour les ménages modestes, ou charge accrue pour les plus aisés |
| `aises` | Régressif | gain direct pour les ménages aisés, ou perte pour les plus modestes |
| `entreprises` | Vers les entreprises | allègements, aides ou obligations réduites pour les entreprises |
| `neutre` | Neutre | pas de transfert direct notable |
| `ambivalent` | Ambivalent | transferts notables dans les deux sens |
| `incertain` | Incertain | documents insuffisants |

**Convention de l'effet direct.** On classe qui reçoit ou paie de l'argent du fait même des mesures : impôts, cotisations, prestations, salaires, loyers et prix réglementés, patrimoine. Les effets indirects attendus ne comptent pas, qu'il s'agisse de l'emploi, de l'investissement ou de l'offre de logement. Chaque camp invoque les siens et ils sont discutés.

La règle s'applique dans les deux sens :
- une baisse de cotisations patronales est classée `entreprises`, même si son but affiché est l'emploi ;
- un encadrement des loyers est classé `modestes` ;
- un durcissement des conditions d'une prestation sous condition de ressources est classé `aises`.

Un texte sur l'immigration, la sécurité ou les institutions sans transfert d'argent est `neutre`. Son orientation se lit dans les thèmes.

### Trois modèles, vote à la majorité

Chaque texte est classé par trois modèles de fournisseurs différents, une fois chacun, appelés par l'outil `pi` via OpenRouter :
- DeepSeek V4.1 Flash ;
- Mistral Small (2603) ;
- Gemini 3.5 Flash Lite.

Les trois réponses sont combinées ainsi :
- **Effet :** il est retenu s'il réunit une majorité stricte des modèles, sinon il devient « incertain ».
- **Thème :** il est retenu s'il réunit une majorité, avec le pôle majoritaire, sinon « mixte ».
- **Confiance :** elle baisse d'un cran quand les modèles ne sont pas unanimes.
- **Panne d'un modèle :** il est écarté tant qu'il reste deux réponses. 36 textes n'ont été classés que par deux modèles, à cause de limites de débit chez Mistral.

Le classement complet a coûté 5,91 $.

### Résultat du classement (941 textes)

| Effet | Textes |
|---|---|
| Neutre | 560 |
| Incertain | 137 |
| Progressif | 115 |
| Vers les entreprises | 99 |
| Ambivalent | 25 |
| Régressif | 5 |

- **Accord entre modèles :** 494 textes à 3 sur 3, 326 à 2 sur 3 et 85 à 1 sur 3 (donc « incertain »). Pour les 36 textes classés par deux modèles : 17 à 2 sur 2, 19 à 1 sur 2.
- **Accord par paire :** Gemini et Mistral s'accordent sur 76 % des textes, DeepSeek et Gemini sur 65 %, DeepSeek et Mistral sur 62 %.
- **Confiance déclarée :** élevée 456, moyenne 321, faible 164.
- **Connaissance du texte déclarée par les modèles :** connu 859, partiel 48, inconnu 34.

Un point pèse sur tout le reste : avec la convention de l'effet direct, presque aucun texte n'est classé régressif (5 sur 941). Dans la pratique, l'indice compare donc les lois progressives et les lois favorables aux entreprises.

## 4. L'indice redistributif

### Formule

```
indice = % de « pour » sur les lois progressives − % de « pour » sur les lois régressives ou favorables aux entreprises
```

L'indice va de −100 à +100.

Exemple : un parti qui vote pour 80 % des lois progressives et 30 % des lois favorables aux entreprises obtient 80 − 30 = +50.

- **Valeur positive :** le parti soutient plus souvent les lois progressives.
- **Valeur négative :** il soutient plus souvent les autres.
- **Valeur proche de 0 :** il ne fait pas de différence nette.

Une abstention ou un vote contre compte comme « pas pour ».

### Lois retenues

Les paramètres sont dans `config/protocole.json`, version 4 :

- **Lois clivantes seulement.** Le camp minoritaire doit réunir au moins 25 % des suffrages exprimés. Une loi votée à 95 % ne distingue personne.
- **Budgets exclus.** Il s'agit des lois de finances, des lois de financement de la Sécurité sociale, des lois de programmation, des lois de règlement et des lois spéciales. Leur vote exprime d'abord le soutien ou l'opposition au Gouvernement.
- **Côté progressif :** `modestes`. **Côté opposé :** `aises` et `entreprises`.
- **Confiance :** les classements de confiance faible sont gardés.
- **Minimum :** 5 lois de chaque côté. En dessous, pas de valeur.

### Marge d'erreur

Chaque valeur a un intervalle de confiance à 95 %, calculé par bootstrap. On tire 1 000 fois au hasard, avec remise, un nouvel échantillon de lois, et l'on garde les 2,5 % et 97,5 % extrêmes. La graine est fixe (42), donc le calcul est reproductible.

Cette marge reflète le petit nombre de lois. Elle ne couvre pas les erreurs de classement des IA.

## 5. Analyse de sensibilité

L'indice est recalculé avec d'autres règles, présentées comme variantes à côté de la méthode retenue :

| Variante | Lois retenues (vue par blocs) |
|---|---|
| Méthode retenue | 82 |
| En gardant les budgets | 98 |
| En gardant toutes les lois, même consensuelles | 196 |
| Seulement les lois où les 3 IA sont d'accord | 45 |
| Seulement les votes émis dans l'opposition | 82 |

Une sixième variante n'utilise que les ménages aisés, sans les entreprises. Elle ne s'affiche jamais, faute de 5 lois régressives.

Chaque parti reçoit un verdict :
- **Solide :** dans toutes les variantes calculables, la marge reste du même côté de zéro.
- **Pas de tendance nette :** la marge traverse zéro partout.
- **Dépend de la méthode :** tous les autres cas.

## 6. Résultats

### Par bloc

| Bloc | Indice | Marge à 95 % | Lois | Verdict |
|---|---|---|---|---|
| Extrême gauche | +49 | +28 à +69 | 63 | Solide |
| Gauche | +35 | +14 à +54 | 81 | Solide |
| Centre | −37 | −56 à −18 | 82 | Dépend de la méthode |
| Droite | −30 | −48 à −10 | 81 | Dépend de la méthode |
| Extrême droite | −2 | −32 à +27 | 43 | Dépend de la méthode |
| Non alignés | 0 | −23 à +23 | 78 | Pas de tendance nette |

### Par parti

| Parti | Indice | Marge à 95 % | Lois | Verdict |
|---|---|---|---|---|
| ECO | +56 | +33 à +77 | 60 | Solide |
| LFI | +49 | +28 à +69 | 63 | Solide |
| GDR | +44 | +25 à +64 | 80 | Solide |
| PS | +31 | +10 à +51 | 81 | Dépend de la méthode |
| LIOT | +13 | −14 à +36 | 55 | Dépend de la méthode |
| UDI | +8 | −28 à +38 | 39 | Pas de tendance nette |
| RN | −2 | −32 à +27 | 43 | Dépend de la méthode |
| NI | −7 | −30 à +18 | 65 | Pas de tendance nette |
| RRDP | −27 | −55 à −9 | 17 | Dépend de la méthode |
| LR | −30 | −48 à −10 | 81 | Dépend de la méthode |
| REN | −40 | −60 à −18 | 65 | Solide |
| MODEM | −46 | −64 à −23 | 65 | Solide |
| HOR | −54 | −79 à −32 | 48 | Solide |
| UDR | −64 | −100 à −26 | 17 | Dépend de la méthode |

### Ce que montrent les variantes

- **Gauche** (LFI, GDR, ECO) : positive partout. La marge du PS touche zéro quand on garde les budgets (+19, marge −1 à +38), d'où son verdict « Dépend de la méthode ».
- **REN, MODEM, HOR** : négatifs partout, mais ils n'ont jamais siégé dans l'opposition depuis 2017. La variante « votes dans l'opposition » ne se calcule pas pour eux. Pour ces partis, le vote sur le fond et le soutien au Gouvernement ne se séparent pas.
- **RN** : −2 avec la méthode retenue, mais +21 (marge +3 à +38) quand on garde les lois consensuelles. Le RN vote pour beaucoup de lois progressives peu disputées.
- **LR** : nettement négatif sur les lois clivantes, proche de zéro (−7) quand on garde toutes les lois.
- **Centre** : il passe à +8 dans la variante « votes dans l'opposition ». Ces votes viennent surtout de l'UDI, qui n'a jamais fait partie de la majorité.
- **Lois votées à l'unanimité des trois IA** : les écarts se creusent (Gauche +68, Centre −66). Les cas que les IA classent sans hésiter sont aussi les plus tranchés.
- **Petits effectifs** : RRDP (17 lois) et UDR (17 lois) ont des marges larges.

### Majorité et opposition

`config/majorites.json` liste les partis qui soutiennent le Gouvernement :

| Période | Gouvernements | Majorité |
|---|---|---|
| 2012-05-16 → 2014-04-01 | Ayrault | PS, RRDP, ECO |
| 2014-04-02 → 2017-05-14 | Valls, Cazeneuve | PS, RRDP |
| 2017-05-15 → 2022-05-15 | Philippe, Castex | REN, MODEM, HOR |
| 2022-05-16 → 2024-09-20 | Borne, Attal | REN, MODEM, HOR |
| 2024-09-21 → 2025-10-11 | Barnier, Bayrou, Lecornu I | REN, MODEM, HOR, LR |
| depuis le 2025-10-12 | Lecornu II et suivants | REN, MODEM, HOR |

Les dates des deux dernières lignes ont été saisies de mémoire et restent à vérifier.

Trois partis ont été dans les deux situations. Sur l'ensemble des votes finaux, ils votent beaucoup plus souvent pour quand ils sont dans la majorité :

| Parti | « Pour » dans la majorité | « Pour » dans l'opposition | Écart |
|---|---|---|---|
| PS | 97 % (117 votes) | 61 % (800) | +36 |
| LR | 89 % (107) | 59 % (808) | +30 |
| ECO | 82 % (65) | 59 % (508) | +23 |

## 7. Historique du protocole

| Version | Changements |
|---|---|
| v1 | classement sur l'intitulé seul, un modèle |
| v2 | ajout du texte (dispositif, exposé des motifs, étude d'impact), un modèle, un passage |
| v3 | un modèle, trois passages. Budgets exclus, lois clivantes seulement, côté régressif élargi aux entreprises |
| v4 | thèmes à deux pôles neutres, consignes symétriques, convention de l'effet direct, masquage politique, trois modèles de fournisseurs différents, marges d'erreur, tableau de sensibilité |

Les trois choix de la v3 ont été faits **après** avoir vu des résultats jugés surprenants. Un critique peut y voir une recherche de spécification, c'est-à-dire des règles ajustées jusqu'à obtenir le résultat voulu. C'est pour cela que la v4 les fige dans `config/protocole.json`, avec cette règle : on ne modifie plus la méthode pour corriger un résultat, on ajoute une variante. Le tableau de sensibilité sert à montrer ce que chaque choix change.

## 8. Limites connues

- **Aucun expert n'a vérifié.** On mesure l'accord entre trois IA, pas leur justesse. Personne n'a classé à la main un échantillon de lois pour servir de référence.
- **Biais des IA.** Les modèles de langue ont des biais politiques documentés. En combiner trois atténue leurs particularités, pas un éventuel biais commun.
- **Presque pas de lois régressives.** La convention de l'effet direct ne compte pas les effets indirects. Résultat : 5 lois régressives seulement, et un indice qui oppose surtout les lois progressives aux lois favorables aux entreprises. Une convention qui compterait les effets indirects classerait autrement.
- **Texte déposé, pas texte voté.** L'IA lit le texte initial. Les amendements peuvent l'avoir beaucoup changé.
- **Toutes les lois pèsent pareil.** Une réforme des retraites compte autant qu'une loi technique.
- **Le Gouvernement choisit l'ordre du jour.** Il choisit la plupart des textes votés, donc ce qu'un parti a l'occasion de soutenir ou de rejeter.
- **Majorité et ligne politique se confondent.** Pour les partis toujours au pouvoir depuis 2017, on ne peut pas séparer les deux.
- **Seuls les votes finaux comptent.** Les scrutins publics sur l'ensemble d'un texte entrent dans l'indice. Les votes à main levée et les amendements n'y entrent pas.
- **Blocs contestables.** Ils reprennent un classement administratif contesté, appliqué à toute la période.
- **Peu de lois pour certains.** Plusieurs partis ont peu de lois (RRDP, UDR : 17), donc des marges larges.

## 9. Où vérifier

| Fichier | Contenu |
|---|---|
| `config/protocole.json` | paramètres figés : modèles, agrégation, règles de l'indice |
| `config/prompt_classement.md` | consignes données aux IA |
| `config/themes.json` | thèmes, pôles et catégories d'effet |
| `config/groupes.json` | rattachement des groupes aux partis et aux blocs |
| `config/majorites.json` | partis de la majorité par période |
| `web/data/classements.json` | classement de chaque loi : thèmes, effet, confiance, accord, effet proposé par chaque modèle, résumé, justification |
| `web/data/votes/<LEG>.json` | un objet par scrutin : identifiant, date, type, intitulé, résultat, et pour chaque groupe sa position et le décompte des voix |
| `web/data/meta.json` | partis, blocs, thèmes, majorités, totaux et protocole |
| `web/assets/overview.js` | calcul de l'indice, du bootstrap et des variantes, dans le navigateur |

Les fichiers de `web/data/` se lisent aussi en ligne, par exemple https://bornholm.github.io/dura-lex/data/classements.json.

## 10. Pistes de discussion

- La convention de l'effet direct est-elle le bon choix ? Que deviendrait l'indice si l'on comptait les effets indirects ?
- Peut-on comparer un parti de gouvernement et un parti d'opposition sur le même indice ?
- Comment vérifier les IA sans relecture humaine ? On pourrait par exemple confronter leurs classements à des évaluations publiques, comme celles de l'Institut des politiques publiques (IPP) sur les budgets.
- Le seuil de 25 % pour une loi clivante est-il le bon ? La variante sans seuil change surtout le RN et LR.
- Vaut-il mieux appliquer à chaque date le classement des blocs en vigueur à cette date ?
