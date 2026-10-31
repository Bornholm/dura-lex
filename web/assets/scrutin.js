import {
  esc, loadJSON, loadVotes, loadClassements, swatch, showError, fmtInt, fmtDate, header, legOf,
  KINDS, VOTE_TYPES, POS_LABEL, POS_CLASS,
} from "./common.js";

const app = document.getElementById("app");
const PAGE_SIZE = 100;
let meta, classements;

// ---------- Liste ----------

async function renderList(params) {
  const legs = Object.keys(meta.legislatures);
  const leg = legs.includes(params.get("leg")) ? params.get("leg") : legs.at(-1);
  const kind = params.get("type") ?? "ensemble";
  const q = (params.get("q") ?? "").trim();
  const page = Math.max(1, Number(params.get("page")) || 1);

  const all = await loadVotes(leg);
  const needle = q.toLowerCase();
  const rows = all
    .filter((r) => (!kind || r.k === kind) && (!needle || r.t.toLowerCase().includes(needle)))
    .reverse();
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const link = (p) => `scrutin.html?${new URLSearchParams({ leg, type: kind, q, page: p })}`;

  app.innerHTML = `
    <section class="stack">
      <h1>Scrutins</h1>
      <p class="lede">Tous les scrutins publics de l'Assemblée nationale depuis 2012, avec le vote de chaque groupe.</p>
    </section>
    <form class="card filters" method="get" action="scrutin.html">
      <div class="field">
        <label for="leg">Législature</label>
        <select id="leg" name="leg">${legs.map((l) => `<option value="${l}"${l === leg ? " selected" : ""}>${l} · ${esc(meta.legislatures[l].periode)}</option>`).join("")}</select>
      </div>
      <div class="field">
        <label for="type">Type</label>
        <select id="type" name="type">
          ${Object.entries(KINDS).map(([k, l]) => `<option value="${k}"${k === kind ? " selected" : ""}>${esc(l)}</option>`).join("")}
          <option value=""${kind === "" ? " selected" : ""}>Tous</option>
        </select>
      </div>
      <div class="field" style="flex:1 1 280px">
        <label for="q">Rechercher dans l'intitulé</label>
        <input id="q" name="q" type="text" value="${esc(q)}" placeholder="retraites, logement, climat…">
      </div>
      <button class="btn primary" type="submit">Filtrer</button>
    </form>
    <section class="stack">
      <p class="muted">${fmtInt(rows.length)} scrutins · page ${page} sur ${pages}</p>
      <div class="card flush scroll-x">
        <table class="data stack-mobile">
          <thead><tr><th scope="col">Date</th><th scope="col">Intitulé</th><th scope="col">Type</th><th scope="col" class="num">Pour / contre / abst.</th><th scope="col">Résultat</th></tr></thead>
          <tbody>${shown.map((r) => `<tr>
            <td class="date">${fmtDate(r.d)}</td>
            <td class="full"><a href="scrutin.html?id=${encodeURIComponent(r.uid)}">${esc(r.t)}</a><div class="sub">n° ${r.n}${classements[r.uid] ? ` · classé (confiance ${esc(classements[r.uid].confiance)})` : ""}</div></td>
            <td>${esc(VOTE_TYPES[r.tv] ?? r.tv)}</td>
            <td class="num" data-label="Pour / contre / abst.">${r.v[0]} / ${r.v[1]} / ${r.v[2]}</td>
            <td><span class="pill ${r.s === "adopté" ? "green" : "grey"}">${esc(r.s)}</span></td>
          </tr>`).join("") || `<tr><td colspan="5" class="muted">Aucun scrutin ne correspond.</td></tr>`}</tbody>
        </table>
      </div>
      <nav class="actions" aria-label="Pagination">
        ${page > 1 ? `<a class="btn" href="${link(page - 1)}">← Précédents</a>` : ""}
        ${page < pages ? `<a class="btn" href="${link(page + 1)}">Suivants →</a>` : ""}
      </nav>
    </section>`;
}

// ---------- Fiche ----------

function majority(row) {
  const counts = { p: row[1], c: row[2], a: row[3] };
  if (counts.p + counts.c + counts.a === 0) return "n";
  return Object.keys(counts).reduce((best, k) => (counts[k] > counts[best] ? k : best), "p");
}

function classementBlock(c) {
  if (!c) {
    return `<p class="muted">Ce texte n'est pas classé (seuls les votes sur l'ensemble d'un texte le sont).</p>`;
  }
  const effet = meta.effets.find((e) => e.id === c.effet);
  const connaissance = { connu: "texte connu du modèle", partiel: "texte partiellement connu du modèle", inconnu: "texte inconnu du modèle" }[c.connaissance];
  return `
    <span class="pill blue" style="align-self:flex-start">Classement automatique${c.modeles ? ` · ${c.modeles.length} modèles` : ""}${c.protocole ? ` · protocole v${esc(c.protocole)}` : ""}${connaissance ? ` · ${esc(connaissance)}` : ""}</span>
    ${c.resume ? `<p style="max-width:860px">${esc(c.resume)}</p>` : ""}
    <p class="muted" style="font-size:13px">Documents analysés : ${c.contexte?.length ? esc(c.contexte.join(", ")) : "intitulé seul"}.</p>
    <div class="stack" style="gap:8px">
      <span class="field-label" style="font-size:13px;font-weight:600;color:var(--ink-2)">Thèmes et orientation</span>
      <ul style="margin:0;padding-left:18px">${(c.themes ?? []).map((t) => {
        const theme = meta.themes.find((x) => x.id === t.id);
        const pole = theme?.poles.find((p) => p.id === t.sens);
        const txt = pole ? `le texte ${pole.label}` : `mesures dans les deux sens (${theme?.poles.map((p) => p.court).join(" / ") ?? ""})`;
        return `<li><b>${esc(t.id)}</b> : ${esc(txt)}</li>`;
      }).join("") || "<li>Aucun</li>"}</ul>
    </div>
    <div class="counts">
      <div><span class="k">Effet redistributif</span><span style="display:block;font-weight:600">${esc(effet?.label ?? "–")}</span></div>
      <div><span class="k">Confiance</span><span style="display:block;font-weight:600">${esc(c.confiance ?? "–")}</span></div>
      ${c.accord ? `<div><span class="k">Accord entre modèles</span><span style="display:block;font-weight:600">${esc(c.accord)}</span>
        <span class="muted" style="font-size:12px">${esc((c.effets_proposes ?? []).map((e) => {
          const label = meta.effets.find((x) => x.id === (e.effet ?? e))?.label ?? e.effet ?? e;
          return e.modele ? `${e.modele.split("/").pop()} : ${label}` : label;
        }).join(" · "))}</span></div>` : ""}
    </div>
    ${c.justification ? `<div class="stack" style="gap:6px"><span class="k muted" style="font-size:13px">Justification</span><p style="max-width:860px;white-space:pre-line">${esc(c.justification)}</p></div>` : ""}
    ${c.sources?.length ? `<div class="stack" style="gap:6px"><span class="k muted" style="font-size:13px">Sources</span><ul style="margin:0;padding-left:18px">${c.sources.map((s) => `<li>${/^https?:\/\//.test(s) ? `<a href="${esc(s)}">${esc(s)}</a>` : esc(s)}</li>`).join("")}</ul></div>` : ""}`;
}

async function renderDetail(uid) {
  const leg = legOf(uid);
  if (!leg || !meta.legislatures[leg]) throw new Error(`identifiant de scrutin inconnu : ${uid}`);
  const r = (await loadVotes(leg)).find((x) => x.uid === uid);
  if (!r) throw new Error(`scrutin ${uid} introuvable`);

  const groupMeta = Object.fromEntries(meta.legislatures[leg].groupes.map((g) => [g.id, g]));
  const groupes = Object.entries(r.g)
    .map(([id, row]) => ({ id, row, g: groupMeta[id] }))
    .sort((x, y) => (x.g && y.g ? meta.legislatures[leg].groupes.indexOf(x.g) - meta.legislatures[leg].groupes.indexOf(y.g) : x.g ? -1 : 1));
  const [vp, vc, va, vnv] = r.v;
  const expr = vp + vc + va || 1;

  const blocs = meta.blocs.map((b) => {
    let p = 0, c = 0, a = 0;
    for (const { g, row } of groupes) if (g?.bloc === b.id) { p += row[1]; c += row[2]; a += row[3]; }
    if (p + c + a === 0) return "";
    const pos = p > 3 * c ? ["Pour", "pour"] : c > 3 * p ? ["Contre", "contre"] : ["Divisé", "divise"];
    return `<div class="bloc-line"><span style="font-weight:500">${esc(b.id)}</span><span class="pill ${pos[1]}">${pos[0]} · ${p} / ${c}${a ? ` / ${a}` : ""}</span></div>`;
  }).join("");

  const c = classements[uid] ?? null;
  const dossier = r.dos ? `<a href="https://www.assemblee-nationale.fr/dyn/${legNum(leg)}/dossiers/${encodeURIComponent(r.dos)}">Dossier législatif</a>` : "";

  document.title = `Dura Lex · Scrutin n° ${r.n}`;
  app.innerHTML = `
    <nav aria-label="Fil d'Ariane" class="muted" style="font-size:14px;display:flex;flex-wrap:wrap;gap:8px">
      <a href="scrutin.html?leg=${leg}">Scrutins</a><span aria-hidden="true">/</span><span>${leg}e législature</span><span aria-hidden="true">/</span><span>n° ${r.n}</span>
    </nav>
    <section class="stack" style="gap:14px">
      <div class="actions" style="gap:8px">
        <span class="pill dark">${esc(VOTE_TYPES[r.tv] ?? r.tv)}</span>
        <span class="pill blue">${esc(KINDS[r.k] ?? r.k)}</span>
        ${ORIGINS[r.o] ? `<span class="pill grey">${ORIGINS[r.o]}</span>` : ""}
      </div>
      <h1 style="max-width:960px;font-size:clamp(26px,3.4vw,38px)">${esc(r.t.charAt(0).toUpperCase() + r.t.slice(1))}</h1>
      <p class="muted" style="display:flex;flex-wrap:wrap;gap:6px 20px;font-size:14px">
        <span>Scrutin n° ${r.n}</span><span>${fmtDate(r.d)}</span>${r.dem ? `<span>Demandé par : ${esc(r.dem)}</span>` : ""}${dossier}
      </p>
    </section>

    <section class="row" style="align-items:stretch">
      <div class="card main-col stack" style="gap:20px">
        <span style="font:700 30px var(--cond);color:${r.s === "adopté" ? "var(--modestes-ink)" : "var(--contre-ink)"}">${esc(r.s.charAt(0).toUpperCase() + r.s.slice(1))}</span>
        <div class="vote-bar" role="img" aria-label="${vp} pour, ${vc} contre, ${va} abstentions">
          <span class="seg-pour" style="width:${(vp / expr) * 100}%"></span><span class="seg-contre" style="width:${(vc / expr) * 100}%"></span><span class="seg-abst" style="width:${(va / expr) * 100}%"></span>
        </div>
        <div class="counts">
          <div><span class="k">Pour</span><span class="v">${vp}</span></div>
          <div><span class="k">Contre</span><span class="v">${vc}</span></div>
          <div><span class="k">Abstention</span><span class="v">${va}</span></div>
          <div><span class="k">Non-votants</span><span class="v">${vnv}</span></div>
        </div>
      </div>
      <div class="card side-col stack" style="gap:14px">
        <h2 style="font-size:20px">Par bloc</h2>
        ${blocs}
      </div>
    </section>

    <section class="stack">
      <div class="head-row">
        <h2>Vote des groupes</h2>
        <div class="key" aria-hidden="true">
          <span><i style="background:var(--vote-pour)"></i>Pour</span><span><i style="background:var(--vote-contre)"></i>Contre</span>
          <span><i style="background:var(--abst)"></i>Abstention</span><span><i style="background:var(--absent);box-shadow:inset 0 0 0 1px var(--field)"></i>Absent ou non-votant</span>
        </div>
      </div>
      <div class="card flush scroll-x">
        <table class="data stack-mobile">
          <thead><tr><th scope="col">Groupe</th><th scope="col">Position majoritaire</th><th scope="col" style="width:38%">Répartition des membres</th><th scope="col" class="num">Pour</th><th scope="col" class="num">Contre</th><th scope="col" class="num">Abst.</th><th scope="col" class="num">Membres</th></tr></thead>
          <tbody>${groupes.map(({ id, row, g }) => {
            const [pos, p, c2, a, , m] = row;
            const flag = pos !== "n" && majority(row) !== pos && p + c2 > 0;
            const w = (n) => (m ? (n / m) * 100 : 0);
            return `<tr>
              <th scope="row"><span class="label-with-swatch">${swatch(g?.couleur ?? "#8D949A")}<span title="${esc(g?.nom ?? id)}">${esc(g?.abrev ?? id)}</span>${g && inMajority(g.famille, r.d) ? `<span class="pill blue" title="Soutenait le Gouvernement à cette date">majorité</span>` : ""}</span></th>
              <td><span class="pill ${POS_CLASS[pos]}">${POS_LABEL[pos]}</span>${flag ? `<span class="note-warn">Diffère du décompte : à vérifier</span>` : ""}</td>
              <td class="full"><div class="vote-bar small" role="img" aria-label="${esc(`${g?.abrev ?? id} : ${p} pour, ${c2} contre, ${a} abstentions sur ${m} membres`)}">
                <span class="seg-pour" style="width:${w(p)}%"></span><span class="seg-contre" style="width:${w(c2)}%"></span><span class="seg-abst" style="width:${w(a)}%"></span>
              </div></td>
              <td class="num" data-label="Pour">${p}</td><td class="num" data-label="Contre">${c2}</td><td class="num" data-label="Abst.">${a}</td><td class="num muted" data-label="Membres">${m}</td>
            </tr>`;
          }).join("")}</tbody>
        </table>
      </div>
      <p class="muted" style="font-size:13px">Positions majoritaires telles que publiées par l'Assemblée nationale. Un avertissement apparaît quand elles ne correspondent pas au décompte des voix du groupe.</p>
    </section>

    <section class="card stack" style="gap:20px">
      <h2>Classement du texte</h2>
      ${classementBlock(c)}
    </section>

    <footer class="site-footer">Source : data.assemblee-nationale.fr, scrutin ${esc(uid)}.</footer>`;
}

const ORIGINS = { gouvernement: "Projet du Gouvernement", parlementaire: "Proposition de parlementaires" };

function inMajority(famille, date) {
  return meta.majorites.some((p) => p.familles.includes(famille) && p.debut <= date && (!p.fin || date <= p.fin));
}

function legNum(leg) {
  return { XIV: 14, XV: 15, XVI: 16, XVII: 17 }[leg];
}

async function main() {
  document.querySelector(".site-header").innerHTML = header("scrutin.html");
  try {
    [meta, classements] = await Promise.all([loadJSON("data/meta.json"), loadClassements()]);
    const params = new URLSearchParams(location.search);
    if (params.get("id")) await renderDetail(params.get("id"));
    else await renderList(params);
  } catch (err) {
    showError(app, err);
  }
}

main();
