// Utilitaires et accès aux données partagés par les pages du tableau de bord.

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path} : HTTP ${res.status}`);
  return res.json();
}

const votesCache = {};
export function loadVotes(leg) {
  votesCache[leg] ??= loadJSON(`data/votes/${leg}.json`);
  return votesCache[leg];
}

export function swatch(color) {
  return `<span class="swatch" aria-hidden="true" style="background:${esc(color)}"></span>`;
}

export function showError(container, err) {
  container.innerHTML = `<p class="error">Impossible de charger les données (${esc(err.message)}).
    Le site doit être servi en HTTP : <code>python3 -m http.server -d web</code>,
    après avoir lancé <code>python3 -I scripts/build_data.py</code>.</p>`;
}

export function fmtInt(n) {
  return new Intl.NumberFormat("fr-FR").format(n);
}

export function fmtDate(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString("fr-FR");
}

export function pct(n, d) {
  return d ? Math.round((n / d) * 100) : null;
}

// Identifiant de scrutin (VTANR5L17V6319) → législature (XVII).
const ROMAN = { 14: "XIV", 15: "XV", 16: "XVI", 17: "XVII" };
export function legOf(uid) {
  const m = /L(\d+)V/.exec(uid);
  return m ? ROMAN[m[1]] : null;
}

export const KINDS = {
  ensemble: "Vote sur l'ensemble d'un texte",
  censure: "Motion de censure",
  procedure: "Motion de procédure",
  partie: "Partie d'un projet de loi de finances",
  article: "Article",
  amendement: "Amendement",
  declaration: "Déclaration du Gouvernement",
  autre: "Autre",
};

export const VOTE_TYPES = {
  SPO: "Scrutin public ordinaire",
  SPS: "Scrutin solennel",
  SAT: "Scrutin à la tribune",
  MOC: "Motion de censure",
};

export const POS_LABEL = { p: "Pour", c: "Contre", a: "Abstention", n: "Non-votant" };
export const POS_CLASS = { p: "pour", c: "contre", a: "abstention", n: "grey" };

// Classements produits par scripts/classify.py.
export async function loadClassements() {
  try {
    return await loadJSON("data/classements.json");
  } catch {
    return {}; // Pas encore de fichier : aucun texte classé.
  }
}

export const CONFIANCE_RANG = { faible: 0, moyenne: 1, "élevée": 2 };

export function header(active) {
  const links = [
    ["index.html", "Vue d'ensemble"],
    ["scrutin.html", "Scrutins"],
  ];
  return `<div class="inner">
    <a class="brand" href="index.html">DURA LEX</a>
    <nav aria-label="Navigation principale">
      ${links.map(([href, label]) => `<a href="${href}"${href === active ? ' aria-current="page"' : ""}>${label}</a>`).join("")}
    </nav>
    <span class="scope">Assemblée nationale · 2012 → aujourd'hui</span>
  </div>`;
}
