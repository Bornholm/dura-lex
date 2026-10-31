import { esc, loadJSON, loadVotes, loadClassements, swatch, showError, fmtInt, fmtDate, pct, header, CONFIANCE_RANG } from "./common.js";

const ALL = "ALL";
// En dessous de ce nombre de textes, un taux n'est pas affiché : il ne veut rien dire.
const MIN_TEXTES = 5;
const UNIT = {
  partis: ["parti", "partis", "Parti"],
  groupes: ["groupe", "groupes", "Groupe"],
  blocs: ["bloc", "blocs", "Bloc"],
};

const state = {
  leg: ALL, mode: "blocs", kind: "ensemble", conf: "faible", origin: "", statut: "", clivant: false,
  pole: 0, metric: "p", unique: false, compare: [],
};
const METRIC = { p: "pour", c: "contre" };
const POLE_NOM = ["A", "B"];
// Paramètres de l'indice, fixés dans config/protocole.json avant le calcul des résultats.
let PROTO;
let meta, classements, familleOf, heatData;

const selectedLegs = () => (state.leg === ALL ? Object.keys(meta.legislatures) : [state.leg]);
const legLabel = () => (state.leg === ALL ? "toutes législatures confondues" : `législature ${state.leg}`);

// Échelle divergente : rouge (le parti vote rarement pour) → neutre à 50 % → vert (il vote presque toujours pour),
// dans les couleurs des votes. Le pourcentage reste écrit dans chaque case.
const ROUGE = [192, 57, 43], NEUTRE = [242, 242, 240], VERT = [23, 100, 58];

function cellStyle(v) {
  const [from, to, t] = v < 50 ? [ROUGE, NEUTRE, v / 50] : [NEUTRE, VERT, (v - 50) / 50];
  const c = from.map((x, i) => Math.round(x + (to[i] - x) * t));
  return `background:rgb(${c.join(",")});color:${Math.abs(v - 50) > 28 ? "#fff" : "#16181D"}`;
}

// Un parti est-il dans la majorité gouvernementale à cette date ? (config/majorites.json)
function inMajority(famille, date) {
  return meta.majorites.some((p) => p.familles.includes(famille) && p.debut <= date && (!p.fin || date <= p.fin));
}

// Un texte clivant : le camp minoritaire réunit au moins le seuil du protocole des suffrages exprimés.
function clivant(r) {
  const [p, c, a] = r.v, expr = p + c + a;
  return expr > 0 && Math.min(p, c + a) / expr >= PROTO.seuil_clivant;
}

function filterLabel() {
  const parts = [];
  if (state.origin === "gouvernement") parts.push("projets du Gouvernement");
  if (state.origin === "parlementaire") parts.push("propositions de parlementaires");
  if (state.clivant) parts.push("textes clivants");
  if (state.statut === "majorite") parts.push("partis dans la majorité au moment du vote");
  if (state.statut === "opposition") parts.push("partis dans l'opposition au moment du vote");
  if (state.compare.length >= 2) parts.push(`uniquement les textes votés par ${state.compare.join(", ")}`);
  return parts.length ? ` Filtres : ${parts.join(", ")}.` : "";
}

function retained(c) {
  return Boolean(c) && (CONFIANCE_RANG[c.confiance] ?? -1) >= CONFIANCE_RANG[state.conf];
}

// Compte les positions majoritaires d'un ensemble de groupes sur une liste de scrutins.
// Pour un bloc, la position retenue est celle qui réunit le plus de députés du bloc.
// `statut` ne garde, scrutin par scrutin, que les groupes dans la majorité ou dans l'opposition.
function positionOf(r, allIds, statut = state.statut) {
  const groupIds = statut
    ? allIds.filter((id) => inMajority(familleOf[id], r.d) === (statut === "majorite"))
    : allIds;
  if (!groupIds.length) return null;
  if (groupIds.length === 1) {
    const row = r.g[groupIds[0]];
    return row && row[0] !== "n" ? row[0] : null;
  }
  const sum = { p: 0, c: 0, a: 0 };
  for (const id of groupIds) {
    const row = r.g[id];
    if (row) { sum.p += row[1]; sum.c += row[2]; sum.a += row[3]; }
  }
  if (sum.p + sum.c + sum.a === 0) return null;
  return ["p", "c", "a"].reduce((best, k) => (sum[k] > sum[best] ? k : best), "p");
}

function tally(records, allIds, statut = state.statut) {
  const out = { p: 0, c: 0, a: 0, total: 0 };
  for (const r of records) {
    const pos = positionOf(r, allIds, statut);
    if (!pos) continue;
    out[pos] += 1;
    out.total += 1;
  }
  return out;
}

// Lignes des tableaux : groupes d'une législature, partis (familles de groupes) ou blocs.
function units() {
  const groupes = selectedLegs().flatMap((l) => meta.legislatures[l].groupes);
  const abrevs = (members) => [...new Set(members.map((g) => g.abrev))].join(", ");
  if (state.mode === "groupes") {
    return groupes.map((g) => ({ key: g.abrev, label: g.nom, sub: `${g.sieges} sièges`, color: g.couleur, ids: [g.id] }));
  }
  const parents = state.mode === "partis"
    ? meta.familles.map((f) => ({ id: f.id, label: f.nom, color: f.couleur, match: (g) => g.famille === f.id }))
    : meta.blocs.map((b) => ({ id: b.id, label: b.id, color: b.couleur, match: (g) => g.bloc === b.id }));
  return parents
    .map((p) => {
      const members = groupes.filter(p.match);
      return { key: p.id, label: p.label, sub: abrevs(members), color: p.color, ids: members.map((g) => g.id) };
    })
    .filter((u) => u.ids.length);
}

function renderFilters() {
  const legs = [[ALL, "Toutes", "2012 → aujourd'hui"], ...Object.entries(meta.legislatures).map(([id, l]) => [id, id, l.periode])];
  document.getElementById("f-leg").innerHTML = legs
    .map(([id, label, periode]) => `<button type="button" data-leg="${esc(id)}" aria-pressed="${id === state.leg}">${esc(label)} · ${esc(periode)}</button>`)
    .join("");
  for (const btn of document.querySelectorAll("#f-mode button")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.mode === state.mode));
    // Les groupes changent à chaque législature : pas de vue par groupe sur l'ensemble de la période.
    const disabled = btn.dataset.mode === "groupes" && state.leg === ALL;
    btn.disabled = disabled;
    btn.title = disabled ? "Choisissez une législature pour voir le détail par groupe" : "";
  }
  document.getElementById("f-compare").innerHTML = units()
    .map((u) => `<button type="button" data-key="${esc(u.key)}" aria-pressed="${state.compare.includes(u.key)}" title="${esc(u.label)}">${swatch(u.color)} ${esc(u.key)}</button>`)
    .join("");
  document.getElementById("compare-reset").hidden = !state.compare.length;
  document.getElementById("compare-unit").textContent = UNIT[state.mode][1];
  for (const el of document.querySelectorAll(".ix-unit")) el.textContent = UNIT[state.mode][1];
  for (const el of document.querySelectorAll(".ix-unit-sg")) el.textContent = UNIT[state.mode][0];
  document.getElementById("compare-hint").textContent = state.compare.length === 1
    ? `Choisissez au moins un autre ${UNIT[state.mode][0]} pour comparer sur les lois votées par les deux.`
    : "";
}

function renderPositions(rows, records) {
  const kindLabel = document.getElementById("f-kind").selectedOptions[0].textContent.toLowerCase();
  const [one, many, title] = UNIT[state.mode];
  document.getElementById("unit-plural").textContent = many;
  document.getElementById("pos-unit").textContent = title;
  document.getElementById("pos-caption").textContent =
    `${fmtInt(records.length)} scrutins (${kindLabel}), ${legLabel()}. Part des scrutins où la majorité du ${one} a voté pour, contre ou s'est abstenue.${filterLabel()}`;
  document.getElementById("positions").innerHTML = rows.map((u) => {
    const t = tally(records, u.ids);
    const [p, c, a] = [pct(t.p, t.total), pct(t.c, t.total), pct(t.a, t.total)];
    const bar = t.total
      ? `<div class="vote-bar small" role="img" aria-label="${esc(`${u.label} : ${p} % pour, ${c} % contre, ${a} % abstention`)}">
          <span class="seg-pour" style="width:${(t.p / t.total) * 100}%"></span><span class="seg-contre" style="width:${(t.c / t.total) * 100}%"></span><span class="seg-abst" style="width:${(t.a / t.total) * 100}%"></span>
        </div>`
      : `<span class="muted">Aucun scrutin</span>`;
    return `<tr>
      <th scope="row" class="full"><span class="label-with-swatch">${swatch(u.color)}<span title="${esc(u.label)}">${esc(u.key)}</span><span class="muted" style="font-weight:400">${esc(u.sub)}</span></span></th>
      <td class="full">${bar}</td>
      <td class="num" data-label="Pour">${p ?? "–"} %</td><td class="num" data-label="Contre">${c ?? "–"} %</td><td class="num" data-label="Abst.">${a ?? "–"} %</td>
      <td class="num muted" data-label="Scrutins">${fmtInt(t.total)}</td>
    </tr>`;
  }).join("");
}

function renderHeat(rows, records) {
  const classified = records.filter((r) => retained(classements[r.uid]));
  document.getElementById("heat-caption").textContent = classified.length
    ? `${classified.length} textes classés parmi les scrutins retenus${state.unique ? ", à thème unique" : ""}. Une case reste vide quand elle porte sur moins de ${MIN_TEXTES} textes. Touchez ou cliquez une case pour voir les textes concernés.${filterLabel()}`
    : "Aucun texte classé dans cette sélection : les cases restent vides. Le classement se lance avec scripts/classify.py.";
  const metric = METRIC[state.metric];
  const poleOf = (t) => t.poles[state.pole];
  document.getElementById("heat-pole").textContent = POLE_NOM[state.pole];
  document.getElementById("heat-metric").textContent = metric;
  for (const btn of document.querySelectorAll("#f-pole button")) {
    btn.setAttribute("aria-pressed", String(Number(btn.dataset.pole) === state.pole));
  }
  for (const btn of document.querySelectorAll("#f-metric button")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.metric === state.metric));
  }
  document.getElementById("ramp-min").textContent = `0 % ${metric}`;
  document.getElementById("ramp-max").textContent = `100 % ${metric}`;
  // Pour le « contre », l'échelle s'inverse : beaucoup de « contre » = rouge.
  document.getElementById("ramp").classList.toggle("reverse", state.metric === "c");
  const head = `<thead><tr><th scope="col" style="text-align:left;width:200px">${UNIT[state.mode][2]}</th>${meta.themes.map((t) => `<th scope="col">${esc(t.id)}<span class="pole-head">${esc(poleOf(t).court)}</span></th>`).join("")}</tr></thead>`;
  const byTheme = Object.fromEntries(meta.themes.map((t) => [
    t.id,
    classified.filter((r) => classements[r.uid].themes?.some((x) => x.id === t.id && x.sens === poleOf(t).id)
      && (!state.unique || classements[r.uid].themes.length === 1)),
  ]));
  heatData = { rows, byTheme };
  const body = rows.map((u, i) => `<tr>
      <th scope="row"><span class="label-with-swatch">${swatch(u.color)}<span>${esc(u.key)}</span></span></th>
      ${meta.themes.map((t) => {
        const tl = tally(byTheme[t.id], u.ids);
        const v = pct(tl[state.metric], tl.total);
        const few = tl.total < MIN_TEXTES;
        const label = few
          ? `${u.label} · ${t.id} : ${tl.total} texte(s), trop peu pour un taux. Voir les textes.`
          : `${u.label} : ${metric} ${tl[state.metric]} des ${tl.total} textes qui ${poleOf(t).label}. Voir les textes.`;
        const style = few ? "background:#F4F5F7;color:#5A606B" : cellStyle(state.metric === "c" ? 100 - v : v);
        return `<td><button type="button" class="heat-cell" data-unit="${i}" data-theme="${esc(t.id)}" aria-label="${esc(label)}"
          style="${style}">${few ? "–" : `${v} %`}</button></td>`;
      }).join("")}
    </tr>`).join("");
  document.getElementById("heat").innerHTML = head + `<tbody>${body}</tbody>`;
  document.getElementById("heat-detail").hidden = true;
}

const POS_TXT = { p: ["Pour", "pour"], c: ["Contre", "contre"], a: ["Abstention", "abstention"] };

// Détail d'une case : décompte et liste des textes, avec la position du parti sur chacun.
function showHeatDetail(unitIndex, themeId) {
  const { rows, byTheme } = heatData;
  const u = rows[unitIndex], theme = meta.themes.find((t) => t.id === themeId);
  const items = byTheme[themeId]
    .map((r) => ({ r, pos: positionOf(r, u.ids) }))
    .filter((x) => x.pos)
    .sort((a, b) => b.r.d.localeCompare(a.r.d));
  const count = { p: 0, c: 0, a: 0 };
  for (const x of items) count[x.pos] += 1;
  const panel = document.getElementById("heat-detail");
  panel.innerHTML = `
    <div class="head-row" style="align-items:flex-start">
      <div class="stack" style="gap:4px">
        <h3 style="margin:0;font:700 20px var(--cond)">${esc(u.label)} · ${esc(theme.id)}</h3>
        <p class="muted">Textes qui ${esc(theme.poles[state.pole].label)}. Pour ${count.p} · Contre ${count.c} · Abstention ${count.a}, sur ${items.length} texte(s).</p>
      </div>
      <button type="button" class="btn" id="heat-detail-close">Fermer</button>
    </div>
    ${items.length ? `<ul class="detail-list">${items.map(({ r, pos }) => `<li>
      <span class="pill ${POS_TXT[pos][1]}">${POS_TXT[pos][0]}</span>
      <span><a href="scrutin.html?id=${encodeURIComponent(r.uid)}">${esc(r.t.charAt(0).toUpperCase() + r.t.slice(1))}</a>
      <span class="muted mono" style="font-size:12px;display:block">${fmtDate(r.d)} · n° ${r.n}</span></span>
    </li>`).join("")}</ul>` : `<p class="muted">Aucun texte dans cette sélection.</p>`}`;
  panel.hidden = false;
  for (const b of document.querySelectorAll(".heat-cell")) {
    b.setAttribute("aria-pressed", String(b.dataset.unit === String(unitIndex) && b.dataset.theme === themeId));
  }
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Même parti, deux situations : voter quand on soutient le Gouvernement, voter quand on s'y oppose.
function renderDiscipline(rows, records) {
  document.getElementById("discipline-unit").textContent = UNIT[state.mode][2];
  document.getElementById("discipline-caption").textContent =
    `Taux de « pour » de chaque ${UNIT[state.mode][0]} selon qu'il soutenait ou non le Gouvernement au moment du vote, sur les mêmes types de textes. Seuls les ${UNIT[state.mode][1]} passés par les deux situations apparaissent.`;
  const lines = rows.map((u) => {
    const maj = tally(records, u.ids, "majorite"), opp = tally(records, u.ids, "opposition");
    if (maj.total < MIN_TEXTES || opp.total < MIN_TEXTES) return "";
    const pm = pct(maj.p, maj.total), po = pct(opp.p, opp.total);
    return `<tr>
      <th scope="row" class="full"><span class="label-with-swatch">${swatch(u.color)}<span title="${esc(u.label)}">${esc(u.key)}</span></span></th>
      <td class="num" data-label="Dans la majorité">${pm} % <span class="muted">(${maj.total})</span></td>
      <td class="num" data-label="Dans l'opposition">${po} % <span class="muted">(${opp.total})</span></td>
      <td class="num" data-label="Écart"><b>${pm - po > 0 ? "+" : ""}${pm - po}</b></td>
    </tr>`;
  }).join("");
  document.getElementById("discipline").innerHTML =
    lines || `<tr><td colspan="4" class="muted">Aucun ${UNIT[state.mode][0]} n'a connu les deux situations dans cette sélection.</td></tr>`;
}

// Générateur pseudo-aléatoire à graine fixe : les intervalles ne changent pas d'un affichage à l'autre.
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Taux de « pour » moyen d'un échantillon tiré avec remise.
function resampleRate(votes, rand) {
  let s = 0;
  for (let i = 0; i < votes.length; i++) s += votes[(rand() * votes.length) | 0];
  return s / votes.length;
}

// Indice d'un parti : taux de « pour » sur les textes progressifs moins taux sur les textes régressifs,
// avec un intervalle obtenu en rééchantillonnant les textes (bootstrap).
function indexOf(u, prog, regr, statut, withInterval) {
  const votes = (list) => list.map((r) => positionOf(r, u.ids, statut)).filter(Boolean).map((p) => (p === "p" ? 1 : 0));
  const m = votes(prog), a = votes(regr);
  if (m.length < PROTO.textes_minimum || a.length < PROTO.textes_minimum) return null;
  const mean = (v) => v.reduce((x, y) => x + y, 0) / v.length;
  const out = { v: Math.round(100 * (mean(m) - mean(a))), nm: m.length, na: a.length };
  if (withInterval) {
    const rand = rng(42), sims = [];
    for (let i = 0; i < PROTO.reechantillonnages; i++) sims.push(resampleRate(m, rand) - resampleRate(a, rand));
    sims.sort((x, y) => x - y);
    const q = (1 - PROTO.niveau_intervalle) / 2;
    out.lo = Math.round(100 * sims[Math.floor(q * sims.length)]);
    out.hi = Math.round(100 * sims[Math.ceil((1 - q) * sims.length) - 1]);
  }
  return out;
}

// Textes retenus pour l'indice selon un jeu de paramètres (le protocole ou une variante).
function indexTexts(records, v) {
  const kept = records.filter((r) => {
    const c = classements[r.uid];
    if (!retained(c) || (v.clivant && !clivant(r)) || (!v.budgets && r.b)) return false;
    if (v.unanime) { const [k, n] = (c.accord ?? "").split("/"); if (k !== n) return false; }
    return true;
  });
  return {
    prog: kept.filter((r) => PROTO.effets_progressifs.includes(classements[r.uid].effet)),
    regr: kept.filter((r) => v.regressifs.includes(classements[r.uid].effet)),
  };
}

function protocolVariant() {
  return { clivant: PROTO.textes_clivants_uniquement, budgets: PROTO.budgets, regressifs: PROTO.effets_regressifs, unanime: false, statut: undefined };
}

const fmtSigned = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}`;

function renderIndex(rows, records) {
  const { prog, regr } = indexTexts(records, protocolVariant());
  const el = document.getElementById("index");
  document.getElementById("index-caption").textContent =
    `Calculé sur ${prog.length} lois favorables aux ménages modestes et ${regr.length} lois favorables aux ménages aisés ou aux entreprises, hors budgets et hors lois adoptées presque à l'unanimité. Le trait fin est la marge d'incertitude. « Comprendre l'étude », en haut de page, explique le calcul.${filterLabel()}`;
  const scale = (x) => 50 + x / 2;
  const lines = rows.map((u) => {
    const ix = indexOf(u, prog, regr, state.statut, true);
    if (!ix) return "";
    const { v } = ix, w = Math.abs(v) / 2;
    return `<div class="ix-row">
      <span class="name label-with-swatch">${swatch(u.color)}${esc(u.key)}</span>
      <div class="track" role="img" aria-label="${esc(`${u.label} : ${v}, intervalle de ${ix.lo} à ${ix.hi}`)}">
        <span class="bar ${v < 0 ? "neg" : "pos"}" style="left:${v < 0 ? 50 - w : 50}%;width:${w}%"></span>
        <span class="ci" style="left:${scale(ix.lo)}%;width:${(ix.hi - ix.lo) / 2}%"></span>
      </div>
      <span class="val">${fmtSigned(v)}</span>
      <span class="ix-n muted">marge ${fmtSigned(ix.lo)} à ${fmtSigned(ix.hi)} · ${ix.nm + ix.na} lois</span>
    </div>`;
  }).join("");
  el.innerHTML = lines || `<p class="muted" style="margin-top:12px">Pas assez de textes classés dans chaque sens (au moins ${PROTO.textes_minimum} par ${UNIT[state.mode][0]}) pour calculer l'indice.</p>`;
  renderSensitivity(rows, records);
}

// Le même indice sous d'autres choix de méthode : ce qui ne change pas de signe ne dépend pas de ces choix.
function renderSensitivity(rows, records) {
  const base = protocolVariant();
  const variants = [
    ["Méthode retenue", base],
    ["En gardant les budgets", { ...base, budgets: true }],
    ["En gardant toutes les lois, même consensuelles", { ...base, clivant: false }],
    ["Ménages aisés seulement, sans les entreprises", { ...base, regressifs: base.regressifs.filter((e) => e !== "entreprises") }],
    ["Seulement les lois où les 3 IA sont d'accord", { ...base, unanime: true }],
    ["Seulement les votes émis dans l'opposition", { ...base, statut: "opposition" }],
  ].map(([label, v]) => ({ label, v, texts: indexTexts(records, v) }))
    // Une règle sans assez de lois pour aucun parti n'apprend rien : on n'affiche pas sa colonne.
    .filter((x, i) => i === 0 || rows.some((u) => indexOf(u, x.texts.prog, x.texts.regr, x.v.statut ?? state.statut, false)));
  document.getElementById("sens-head").innerHTML = `<tr><th scope="col">${UNIT[state.mode][2]}</th>${variants.map((x) =>
    `<th scope="col" class="num">${esc(x.label)}<span class="pole-head">${x.texts.prog.length + x.texts.regr.length} lois</span></th>`).join("")}<th scope="col">Verdict</th></tr>`;
  document.getElementById("sens-body").innerHTML = rows.map((u) => {
    const vals = variants.map((x) => indexOf(u, x.texts.prog, x.texts.regr, x.v.statut ?? state.statut, true));
    if (!vals[0]) return "";
    const signs = new Set(vals.filter(Boolean).map((x) => (x.lo > 0 ? 1 : x.hi < 0 ? -1 : 0)));
    const verdict = signs.size === 1 && !signs.has(0)
      ? `<span class="pill blue">Solide</span>`
      : signs.has(0) && signs.size === 1 ? `<span class="pill grey">Pas de tendance nette</span>` : `<span class="pill grey">Dépend de la méthode</span>`;
    return `<tr>
      <th scope="row" class="full"><span class="label-with-swatch">${swatch(u.color)}<span title="${esc(u.label)}">${esc(u.key)}</span></span></th>
      ${vals.map((x, i) => `<td class="num" data-label="${esc(variants[i].label)}">${x
        ? `<b>${fmtSigned(x.v)}</b><span class="ix-ci">${fmtSigned(x.lo)} à ${fmtSigned(x.hi)}</span>`
        : `<span class="muted">–</span>`}</td>`).join("")}
      <td data-label="Verdict">${verdict}</td>
    </tr>`;
  }).join("");
}

function renderRecent(records) {
  const recent = records.filter((r) => r.k === "ensemble" && r.tv === "SPS").slice(-8).reverse();
  document.getElementById("recent").innerHTML = recent.length
    ? recent.map((r) => {
        const c = classements[r.uid];
        const effet = meta.effets.find((e) => e.id === c?.effet);
        const [label, cls] = effet ? [`${effet.label} · confiance ${c.confiance}`, "blue"] : ["Non classé", "grey"];
        return `<tr>
          <td class="date">${fmtDate(r.d)}</td>
          <td class="full"><a href="scrutin.html?id=${encodeURIComponent(r.uid)}" style="font-weight:500">${esc(r.t)}</a><div class="sub">Scrutin n° ${r.n} · ${esc(r.s)}</div></td>
          <td data-label="Thèmes">${esc(c?.themes?.map((t) => t.id).join(" · ") || "–")}</td>
          <td class="num" data-label="Pour / contre">${r.v[0]} / ${r.v[1]}</td>
          <td><span class="pill ${cls}">${esc(label)}</span></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="5" class="muted">Aucun vote solennel sur un texte dans cette législature.</td></tr>`;
}

function renderStatic() {
  const nbClasses = Object.keys(classements).length;
  const tiles = [
    ["Scrutins publics", fmtInt(meta.totaux.scrutins), "depuis juin 2012"],
    ["Votes sur une loi entière", fmtInt(meta.totaux.ensemble), "la base de l'analyse"],
    ["Votes de députés", fmtInt(meta.totaux.votes_nominatifs), "pour, contre ou abstention"],
    ["Lois classées", fmtInt(nbClasses), "par trois intelligences artificielles"],
  ];
  const all = Object.values(classements);
  const unanimes = all.filter((c) => { const [k, n] = (c.accord ?? "").split("/"); return k && k === n && n === "3"; }).length;
  document.getElementById("c-unanimes").textContent = `${pct(unanimes, all.length)} %`;
  document.getElementById("tiles").innerHTML = tiles.map(([k, v, s]) =>
    `<div class="tile"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span><span class="s">${esc(s)}</span></div>`).join("");
  document.getElementById("footer").innerHTML =
    `<span>Source : open data de l'Assemblée nationale (data.assemblee-nationale.fr). Code sous licence MIT, données sous Licence Ouverte 2.0.</span><span>Données extraites le ${fmtDate(meta.extrait_le)}.</span>`;
}

async function render() {
  if (state.leg === ALL && state.mode === "groupes") state.mode = "partis";
  const all = (await Promise.all(selectedLegs().map(loadVotes))).flat();
  let records = all.filter((r) =>
    (!state.kind || r.k === state.kind) && (!state.origin || r.o === state.origin) && (!state.clivant || clivant(r)));
  const allRows = units();
  state.compare = state.compare.filter((k) => allRows.some((u) => u.key === k));
  const rows = state.compare.length ? allRows.filter((u) => state.compare.includes(u.key)) : allRows;
  // Comparer à périmètre égal : seulement les scrutins où chaque parti choisi a pris position.
  if (state.compare.length >= 2) records = records.filter((r) => rows.every((u) => positionOf(r, u.ids)));
  renderFilters();
  renderPositions(rows, records);
  renderDiscipline(rows, records);
  renderHeat(rows, records);
  renderIndex(rows, records);
  renderRecent(all);
}

async function main() {
  document.querySelector(".site-header").innerHTML = header("index.html");
  try {
    [meta, classements] = await Promise.all([loadJSON("data/meta.json"), loadClassements()]);
    PROTO = meta.protocole.indice;
    state.conf = PROTO.confiance_minimale;
    familleOf = Object.fromEntries(Object.values(meta.legislatures).flatMap((l) => l.groupes.map((g) => [g.id, g.famille])));
    renderStatic();
    await render();
  } catch (err) {
    showError(document.querySelector("main"), err);
    return;
  }

  document.getElementById("f-leg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-leg]");
    if (b) { state.leg = b.dataset.leg; render(); }
  });
  document.getElementById("f-mode").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (b) { state.mode = b.dataset.mode; state.compare = []; render(); }
  });
  document.getElementById("f-compare").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-key]");
    if (!b) return;
    const k = b.dataset.key;
    state.compare = state.compare.includes(k) ? state.compare.filter((x) => x !== k) : [...state.compare, k];
    render();
  });
  document.getElementById("compare-reset").addEventListener("click", () => { state.compare = []; render(); });
  document.getElementById("f-metric").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-metric]");
    if (b) { state.metric = b.dataset.metric; render(); }
  });
  document.getElementById("f-unique").addEventListener("change", (e) => { state.unique = e.target.checked; render(); });
  document.getElementById("f-kind").addEventListener("change", (e) => { state.kind = e.target.value; render(); });
  document.getElementById("f-conf").addEventListener("change", (e) => { state.conf = e.target.value; render(); });
  document.getElementById("f-origin").addEventListener("change", (e) => { state.origin = e.target.value; render(); });
  document.getElementById("f-statut").addEventListener("change", (e) => { state.statut = e.target.value; render(); });
  document.getElementById("f-clivant").addEventListener("change", (e) => { state.clivant = e.target.value === "1"; render(); });
  document.getElementById("heat").addEventListener("click", (e) => {
    const b = e.target.closest("button.heat-cell");
    if (b) showHeatDetail(Number(b.dataset.unit), b.dataset.theme);
  });
  document.getElementById("heat-detail").addEventListener("click", (e) => {
    if (e.target.id === "heat-detail-close") {
      e.currentTarget.hidden = true;
      for (const b of document.querySelectorAll(".heat-cell[aria-pressed='true']")) b.setAttribute("aria-pressed", "false");
    }
  });
  document.getElementById("f-pole").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-pole]");
    if (b) { state.pole = Number(b.dataset.pole); render(); }
  });
}

main();
