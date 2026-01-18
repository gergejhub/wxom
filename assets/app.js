
/* v60: fixes
   - Quick View triggers layout (CSS flex-wrap)
   - Raw highlight overlap fixed via CSS .hl inline-block margins
   - Priority: METAR-driven hazards outrank TAF-only hazards
*/

const $ = (id) => document.getElementById(id);

// Tile tooltips (policy/trigger quick help) ---------------------------------
// Shows a small "bubble" when hovering a tile, summarizing what triggers it
// and which OM section it maps to. Content mirrors the GUIDE page (alerts.html)
// but stays compact for at-a-glance usage.

const TILE_TIPS = {
  eng: {
    title: "Engine Anti-Ice Ops (advisory)",
    om: "Ops advisory",
    lines: [
      "Highlights stations where engine anti-ice operations are likely required.",
      "Cue is derived from METAR/TAF freezing/frozen precipitation / icing risk signals.",
    ],
    triggers: ["FZFG / FZRA / FZDZ", "SN / SG / GS", "OAT ≤ 0°C cues (advisory)"]
  },
  crit: {
    title: "Critical (severity score ≥ 70)",
    om: "Scoring model (advisory)",
    lines: [
      "Composite score derived from operationally relevant hazards (VIS/RVR, CIG, TS/CB, wind gusts, wx codes, policy flags).",
      "Use to triage; always verify raw METAR/TAF and local procedures."
    ],
    triggers: ["Score ≥ 70"]
  },
  vis300: {
    title: "Low VIS / RVR (worst < 300 m)",
    om: "OM-A 8.1.4 (minima cues)",
    lines: [
      "Uses the worst (METAR or TAF) visibility / RVR when present.",
      "Designed as a rapid operational impact cue."
    ],
    triggers: ["Worst VIS < 300 m", "or worst RVR < 300 m"]
  },
  ts: {
    title: "Thunderstorm / Convective (TS / CB)",
    om: "OM-A 8.3.8.1",
    lines: [
      "Thunderstorm activity is a flight safety risk.",
      "This cue flags convective signals in METAR/TAF."
    ],
    triggers: ["TS", "CB", "TCU (risk cue)"]
  },
  wind: {
    title: "Wind (gust ≥ 25 kt)",
    om: "Ops cue (limits per OM-B/airport)",
    lines: [
      "Flags airports with gusts at/above the configured threshold.",
      "Crosswind limitation assessment is available via XWIND policy tile (runway-aware)."
    ],
    triggers: ["Gust ≥ 25 kt"]
  },
  snow: {
    title: "Snow present / forecast",
    om: "OM-A 8.3.8.7 (heavy precip take-off prohibited)",
    lines: [
      "Highlights snow in METAR/TAF. Use alongside runway condition / SNOWTAM when available.",
      "Heavy snow (+SN) is also a TO/LND PROHIB policy flag."
    ],
    triggers: ["SN / +SN", "SG / GS (when present)"]
  },
  toProhib: {
    title: "Take-off / Landing prohibited (policy flags)",
    om: "OM-A 8.3.8",
    lines: [
      "Company policy: take-off is prohibited in specific heavy precipitation conditions.",
      "Also flags TS presence as a risk cue for take-off/landing planning."
    ],
    triggers: ["+SN, +GS, +SG, +PL", "FZRA / +FZRA", "GR / +GR", "TS (risk cue)"]
  },
  lvto: {
    title: "LVTO / Minima cues", 
    om: "OM-A 8.1.4",
    lines: [
      "Low Visibility Take-off (LVTO) cue based on reported VIS/RVR.",
      "Highlights additional procedural cues for LVP and absolute minimum RVR."
    ],
    triggers: ["LVTO: RVR/VIS < 550 m", "LVP required: RVR < 400 m", "Absolute minimum: RVR < 125 m"]
  },
  xwind: {
    title: "Crosswind exceedance (runway-aware)",
    om: "OM-B 1.3.1",
    lines: [
      "Evaluates best-available runway alignment (from runways.json) against reported wind.",
      "Assumes dry runway unless runway condition data is available (advisory)."
    ],
    triggers: ["Best RWY crosswind exceeds company limit"]
  },
  va: {
    title: "Volcanic ash detected", 
    om: "OM-A 8.3.8.6",
    lines: [
      "Flags volcanic ash / ash cloud cues in METAR/TAF.",
      "Company policy: avoid planning/flight into medium/high contamination zones."
    ],
    triggers: ["VA", "VOLCANIC ASH"]
  }
};

function initTileTooltips(){
  // Create a single tooltip element (reused)
  let tip = document.getElementById('tileTip');
  if (!tip){
    tip = document.createElement('div');
    tip.id = 'tileTip';
    tip.className = 'tiletip';
    tip.setAttribute('role','tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
  }

  const tiles = Array.from(document.querySelectorAll('.tiles .tile[data-filter]'));
  if (!tiles.length) return;

  let active = null;
  let raf = 0;

  const hide = ()=>{
    active = null;
    tip.hidden = true;
    tip.innerHTML = '';
  };

  const clamp = (v, lo, hi)=>Math.max(lo, Math.min(hi, v));

  const position = (anchor)=>{
    if (!anchor || tip.hidden) return;
    const r = anchor.getBoundingClientRect();
    const pad = 10;
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;

    // Ensure tip has measurable size
    const tr = tip.getBoundingClientRect();
    let top = r.bottom + 10;
    let left = r.left;

    // Prefer below; if it would overflow, place above
    if (top + tr.height + pad > vh){
      top = r.top - tr.height - 10;
      tip.classList.add('tiletip--above');
    } else {
      tip.classList.remove('tiletip--above');
    }

    left = clamp(left, pad, vw - tr.width - pad);
    top = clamp(top, pad, vh - tr.height - pad);

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  const renderTip = (key)=>{
    const t = TILE_TIPS[key];
    if (!t) return '';
    const trig = (t.triggers || []).map(x=>`<span class="tiletip__chip">${escapeHtml(x)}</span>`).join('');
    const lines = (t.lines || []).map(x=>`<div class="tiletip__p">${escapeHtml(x)}</div>`).join('');
    return `
      <div class="tiletip__hdr">
        <div class="tiletip__title">${escapeHtml(t.title || key)}</div>
        <div class="tiletip__om">${escapeHtml(t.om || '')}</div>
      </div>
      <div class="tiletip__body">
        ${lines}
        ${trig ? `<div class="tiletip__chips">${trig}</div>` : ''}
      </div>
    `;
  };

  const showFor = (btn)=>{
    const f = btn.getAttribute('data-filter');
    if (!f) return;
    const html = renderTip(f);
    if (!html) return;
    active = btn;
    tip.innerHTML = html;
    tip.hidden = false;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(()=>position(btn));
  };

  tiles.forEach(btn=>{
    btn.addEventListener('mouseenter', ()=>showFor(btn));
    btn.addEventListener('mouseleave', hide);
    btn.addEventListener('focusin', ()=>showFor(btn));
    btn.addEventListener('focusout', hide);
  });

  window.addEventListener('scroll', ()=>{ if (active) position(active); }, { passive:true });
  window.addEventListener('resize', ()=>{ if (active) position(active); });
  document.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') hide(); });
  // Hide if user clicks elsewhere
  document.addEventListener('pointerdown', (e)=>{
    if (!active) return;
    if (e.target && (e.target.closest('.tiletip') || e.target.closest('.tile'))) return;
    hide();
  });
}

// Base airport priority list ------------------------------------------------
// Loaded from base.txt (one IATA per line). Used to prioritize and highlight key stations
// across tiles and the table.
const BASE_LIST_URL = "base.txt";
let baseAirports = new Set();
let baseAirportsLoaded = false;
async function fetchBaseAirportsOnce(){
  if (baseAirportsLoaded) return baseAirports;
  baseAirportsLoaded = true;
  try{
    const res = await fetch(BASE_LIST_URL + "?cb=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const txt = await res.text();
    const set = new Set();
    txt.split(/\r?\n/)
      .map(x => x.trim())
      .filter(Boolean)
      .forEach(x => set.add(x.toUpperCase()));
    baseAirports = set;
  } catch (e) {
    // Non-fatal: if base.txt is missing, the app should still work.
    baseAirports = new Set();
  }
  return baseAirports;
}
function isBaseAirport(code){
  if (!code) return false;
  return baseAirports.has(String(code).toUpperCase());
}

// View mode (Auto / TV) ----------------------------------------------------
const VIEW_MODE_KEY = "wizz_viewMode"; // "auto" | "tv"
let viewMode = (localStorage.getItem(VIEW_MODE_KEY) || "auto");

function detectDeviceClass(){
  const w = window.innerWidth || 1200;
  if (w < 640) return "mobile";
  if (w < 1024) return "tablet";
  if (w >= 1800) return "tvhint"; // large wall displays; still requires manual TV mode
  return "desktop";
}
function applyDeviceClass(){
  const cls = detectDeviceClass();
  document.body.classList.remove("device-mobile","device-tablet","device-desktop","device-tvhint");
  document.body.classList.add(`device-${cls}`);
}
function applyViewMode(mode){
  viewMode = mode;
  localStorage.setItem(VIEW_MODE_KEY, viewMode);

  document.body.classList.toggle("view-tv", viewMode === "tv");
  document.body.classList.toggle("view-auto", viewMode === "auto");

  applyDeviceClass();

  const lbl = $("viewBtnLabel");
  if (lbl) lbl.textContent = (viewMode === "tv" ? "TV" : "AUTO");

  // Header height changes with font scale; recompute drawer offset
  requestAnimationFrame(updateTopHeight);
}
function toggleTvMode(){
  applyViewMode(viewMode === "tv" ? "auto" : "tv");
}
function initViewModeUI(){
  // Default: auto adapts layout via CSS media queries; TV mode is manual
  applyViewMode(viewMode);

  const btn = $("viewBtn");
  if (btn) btn.addEventListener("click", toggleTvMode);

  const title = $("brandTitle");
  if (title) title.addEventListener("dblclick", toggleTvMode);

  window.addEventListener("resize", ()=>{
    if (viewMode === "auto"){
      applyDeviceClass();
      requestAnimationFrame(updateTopHeight);
    }
  });

  document.addEventListener("keydown", (e)=>{
    if (e.shiftKey && (e.key === "T" || e.key === "t")){
      e.preventDefault();
      toggleTvMode();
    }
  });
}





function updateTopHeight(){
  const top = document.querySelector('header.top');
  if (!top) return;
  const h = Math.ceil(top.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--top-h', `${h}px`);
}
window.addEventListener('resize', ()=>requestAnimationFrame(updateTopHeight));

const VIS_THRESHOLDS = [800, 550, 500, 300, 250, 175, 150];
const RVR_THRESHOLDS = [500, 300, 200, 75];

const ALERT_LEVEL = { OK:0, MED:1, HIGH:2, CRIT:3 };

// Display labels (keep internal codes for logic, but render full words in UI).
const ALERT_LABEL = { OK:"Ok", MED:"Medium", HIGH:"High", CRIT:"Critical" };
function alertLabel(code){
  const k = String(code || "").toUpperCase();
  return ALERT_LABEL[k] || k;
}

function alertFromScore(score){
  return score >= 70 ? "CRIT" :
         score >= 45 ? "HIGH" :
         score >= 20 ? "MED" : "OK";
}

function minScoreForAlert(alert){
  return alert === "CRIT" ? 70 :
         alert === "HIGH" ? 45 :
         alert === "MED" ? 20 : 0;
}

function maxAlert(...alerts){
  let best = "OK";
  for (const a of alerts){
    if (!a) continue;
    if (ALERT_LEVEL[a] > ALERT_LEVEL[best]) best = a;
  }
  return best;
}

function windPillarAlert(met, taf){
  const g = Math.max(met.gustMax ?? 0, taf.gustMax ?? 0);
  if (!g) return "OK";
  if (g >= 40) return "CRIT";
  if (g >= 30) return "HIGH";
  if (g >= 25) return "MED";
  return "OK";
}

function snowPillarAlert(st, met, taf, worstVis, rvrMinAll, cigAll){
  const hasSnow = !!(met.hz.sn || taf.hz.sn);
  const hasBlSn = !!(met.hz.blsn || taf.hz.blsn);
  if (!hasSnow && !hasBlSn) return "OK";

  if (hasBlSn) return "CRIT";

  const vis = worstVis;
  const rvr = rvrMinAll;
  const cig = cigAll;

  if ((vis !== null && vis <= 500) || (rvr !== null && rvr <= 300) || (cig !== null && cig < 500)) return "CRIT";
  if ((vis !== null && vis <= 800) || (rvr !== null && rvr <= 500) || (cig !== null && cig < 1000)) return "HIGH";
  return "MED";
}


let stations = [];

let runwaysMap = null;

let stationMap = new Map();
let lastGeneratedAt = null; // string (ISO) from data.generatedAt

// Shared airport roles (multi-user): fetched from repo-backed JSON.
let rolesMap = {}; // { ICAO: "BASE" | "DEST" | "ALT" }

function normalizeRole(r){
  const v = String(r || "").trim().toUpperCase();
  if (v === "BASE") return "BASE";
  if (v === "DEST" || v === "DESTINATION") return "DEST";
  if (v === "ALT" || v === "ALTERNATE") return "ALT";
  return "OTHER";
}
function roleRank(role){
  switch(role){
    case "BASE": return 0;
    case "DEST": return 1;
    case "ALT":  return 2;
    default:     return 3;
  }
}
function getRole(icao){
  const key = String(icao || "").toUpperCase();
  return normalizeRole(rolesMap[key]);
}
async function fetchRoles(){
  try{
    const res = await fetch("config/airport_roles.json?cb=" + Date.now(), {cache:"no-store"});
    if (!res.ok){
      rolesMap = {};
      return rolesMap;
    }
    const j = await res.json();
    if (j && typeof j === "object"){
      const out = {};
      for (const [k,v] of Object.entries(j)){
        const icao = String(k || "").toUpperCase();
        if (icao.length === 4) out[icao] = normalizeRole(v);
      }
      rolesMap = out;
    }else{
      rolesMap = {};
    }
  }catch(e){
    rolesMap = {};
  }
  return rolesMap;
}


async function fetchRunways(){
  if (runwaysMap) return runwaysMap;
  try{
    const res = await fetch("data/runways.json?cb=" + Date.now(), {cache:"no-store"});
    if (!res.ok){
      runwaysMap = null;
      return runwaysMap;
    }
    const j = await res.json();
    runwaysMap = (j && typeof j === "object") ? j : null;
  }catch(e){
    runwaysMap = null;
  }
  return runwaysMap;
}

let view = {
  q: "",
  cond: "all",
  alert: "all",
  sortPri: true,
};

// Tracks which station is currently shown in the Quick View drawer
// so we can keep time-based fields (age) ticking without manual page refresh.
let drawerIcao = null;

function escapeHtml(s){
  return (s ?? "").replace(/[&<>"']/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}


function parseTempC(raw){
  // METAR temp/dewpoint group like 02/00 or M05/M10
  if (!raw) return null;
  const up = String(raw).toUpperCase();
  const m = up.match(/\b(M?\d{2})\/(M?\d{2})\b/);
  if (!m) return null;
  const t = m[1];
  const val = parseInt(t.replace("M","-"), 10);
  return Number.isNaN(val) ? null : val;
}

function parseVisibilityMeters(raw){
  if (!raw) return null;

  // CAVOK is effectively >= 10km
  if (/\bCAVOK\b/.test(raw)) return 10000;

  // Robust token-based parse:
  // - ignores time ranges like 3012/3112 (TAF) and RVR groups like R27/0600
  // - supports US-style SM tokens (e.g., P6SM, 1/2SM)
  const toks = String(raw).trim().split(/\s+/);

  let best = null;
  const add = (m)=>{ if (m == null) return; best = (best==null) ? m : Math.min(best, m); };

  for (const t0 of toks){
    const t = t0.trim().toUpperCase();
    if (!t) continue;
    if (t.includes("/")) continue;

    if (/^\d{4}$/.test(t)){
      const v = parseInt(t,10);
      if (!Number.isNaN(v)) add(v === 9999 ? 10000 : v);
      continue;
    }

    const sm = (() => {
      if (/^P\d+SM$/.test(t)){
        const n = parseInt(t.slice(1,-2),10);
        return Number.isFinite(n) ? Math.round(n*1609.34) : null;
      }
      if (/^M?\d+SM$/.test(t)){
        const n = parseInt(t.replace(/^M/,"").slice(0,-2),10);
        return Number.isFinite(n) ? Math.round(n*1609.34) : null;
      }
      if (/^M?\d+\/\d+SM$/.test(t)){
        const frac = t.replace(/^M/,"").slice(0,-2);
        const [a,b] = frac.split("/").map(Number);
        if (Number.isFinite(a) && Number.isFinite(b) && b !== 0){
          return Math.round((a/b)*1609.34);
        }
      }
      return null;
    })();
    if (sm != null) add(sm);
  }

  return best;
}


function extractAllVisibilityMetersFromTAF(raw){
  if (!raw) return [];
  const out = [];

  if (/\bCAVOK\b/.test(raw)) out.push(10000);

  const toks = String(raw).trim().split(/\s+/);
  for (const t0 of toks){
    const t = t0.trim().toUpperCase();
    if (!t) continue;
    if (t.includes("/")) continue;

    if (/^\d{4}$/.test(t)){
      const v = parseInt(t,10);
      if (!Number.isNaN(v)) out.push(v === 9999 ? 10000 : v);
      continue;
    }

    const sm = (() => {
      if (/^P\d+SM$/.test(t)){
        const n = parseInt(t.slice(1,-2),10);
        return Number.isFinite(n) ? Math.round(n*1609.34) : null;
      }
      if (/^M?\d+SM$/.test(t)){
        const n = parseInt(t.replace(/^M/,"").slice(0,-2),10);
        return Number.isFinite(n) ? Math.round(n*1609.34) : null;
      }
      if (/^M?\d+\/\d+SM$/.test(t)){
        const frac = t.replace(/^M/,"").slice(0,-2);
        const [a,b] = frac.split("/").map(Number);
        if (Number.isFinite(a) && Number.isFinite(b) && b !== 0){
          return Math.round((a/b)*1609.34);
        }
      }
      return null;
    })();
    if (sm != null) out.push(sm);
  }
  return out;
}


function extractRvrMeters(raw){
  if (!raw) return [];
  const re = /\bR\d{2}[LRC]?\/([PM]?)(\d{4})(?:V([PM]?)(\d{4}))?([UDN])?\b/g;
  const vals = [];
  let m;
  while ((m = re.exec(raw)) !== null){
    const v1 = parseInt(m[2],10);
    if (!Number.isNaN(v1)) vals.push(v1);
    if (m[4]){
      const v2 = parseInt(m[4],10);
      if (!Number.isNaN(v2)) vals.push(v2);
    }
  }
  return vals;
}

function extractGustKt(raw){
  // Returns all gust values in knots found in wind groups like 27015G30KT or VRB05G25KT
  if (!raw) return [];
  const out = [];
  const re = /\b(?:\d{3}|VRB)\d{2,3}G(\d{2,3})KT\b/g;
  let m;
  while ((m = re.exec(raw)) !== null){
    const g = parseInt(m[1],10);
    if (!Number.isNaN(g)) out.push(g);
  }
  return out;
}

function gustMaxKt(raw){
  const vals = extractGustKt(raw);
  return vals.length ? Math.max(...vals) : null;
}

function ceilingFt(raw){
  if (!raw) return null;
  // BKN/OVC### or VV### where ### is hundreds of feet
  const re = /\b(BKN|OVC|VV)(\d{3})\b/g;
  let min = null;
  let m;
  while ((m = re.exec(raw)) !== null){
    const h = parseInt(m[2],10);
    if (!Number.isNaN(h)){
      const ft = h*100;
      if (min === null || ft < min) min = ft;
    }
  }
  return min;
}

function hasAny(raw, tokens){
  if (!raw) return false;
  return tokens.some(t => new RegExp(`\\b${t}\\b`).test(raw));
}

function hazardFlags(raw){
  if (!raw) return {
    fzfg:false, fg:false, br:false, blsn:false,
    sn:false, ra:false, ts:false,
    cb:false, va:false,
    fzra:false, fzdz:false, gr:false, pl:false, gs:false, sg:false,
    heavySn:false, heavyFzra:false, heavyHail:false,
  };

  const up = String(raw).toUpperCase();

  // Token-aware helpers to catch combined weather codes like RASN, -RASN, SNRA, etc.
  const wxToks = up.split(/\s+/).map(t=>t.trim()).filter(Boolean).filter(t=>{
    if (t.includes("/")) return false;                 // time groups, RVR
    if (/[0-9]/.test(t)) return false;                 // numeric groups
    if (/KT$/.test(t) || /MPS$/.test(t)) return false; // wind
    if (t.length > 10) return false;
    return true;
  });

  const hasWx = (needle)=>wxToks.some(t=>t.includes(needle));

  return {
    fzfg: /\bFZFG\b/.test(up),
    fg: /\bFG\b/.test(up) || hasWx("FG"),
    br: /\bBR\b/.test(up) || hasWx("BR"),
    blsn: /\bBLSN\b/.test(up) || hasWx("BLSN"),
    sn: /\bSN\b/.test(up) || /\bSHSN\b/.test(up) || /\bBLSN\b/.test(up) || hasWx("SN"),
    ra: /\bRA\b/.test(up) || /\bDZ\b/.test(up) || hasWx("RA") || hasWx("DZ"),
    ts: /\bTS\b/.test(up) || /\bTSRA\b/.test(up) || /\bTSGR\b/.test(up) || hasWx("TS"),
  };
}


function computeScores(raw){
  const vis = parseVisibilityMeters(raw);
  const rvr = extractRvrMeters(raw);
  const rvrMin = rvr.length ? Math.min(...rvr) : null;
  const cig = ceilingFt(raw);
  const hz = hazardFlags(raw);
  const tempC = parseTempC(raw);
  const gustMax = gustMaxKt(raw);

  let score = 0;

  // Visibility contribution
  if (vis !== null){
    if (vis <= 150) score += 35;
    else if (vis <= 175) score += 30;
    else if (vis <= 250) score += 26;
    else if (vis <= 300) score += 24;
    else if (vis <= 500) score += 18;
    else if (vis <= 550) score += 16;
    else if (vis <= 800) score += 12;
  }

  // RVR contribution
  if (rvrMin !== null){
    if (rvrMin <= 75) score += 28;
    else if (rvrMin <= 200) score += 22;
    else if (rvrMin <= 300) score += 18;
    else if (rvrMin <= 500) score += 12;
  }

  // Ceiling contribution
  if (cig !== null){
    if (cig < 500) score += 22;
    else if (cig < 800) score += 12;
  }

  // Wx triggers
  if (hz.ts) score += 22;
  if (hz.fzfg) score += 18;
  if (hz.fg) score += 14;
  if (hz.sn) score += 10;
  if (hz.ra) score += 8;
  if (hz.br) score += 6;

  // Wind gust contribution
  // Operational tuning: start highlighting/alerting already from G25.
  if (gustMax !== null){
    if (gustMax >= 40) score += 10;
    else if (gustMax >= 30) score += 6;
    else if (gustMax >= 25) score += 4;
  }

  // cap-ish
  score = Math.min(100, score);

  return {vis, rvrMin, cig, hz, tempC, gustMax, score};
}


function computeOmPolicy(st, met, taf, worstVis, rvrMinAll){
  // OM policy layer (advisory).
  // Zero-manual inputs: runway geometry is sourced from data/runways.json when available.
  try{
    const api = (typeof window !== "undefined") ? window.WXM_OM : null;
    if (api && typeof api.computeOmFlags === "function"){
      return api.computeOmFlags(st, met, taf, worstVis, rvrMinAll, runwaysMap || null);
    }
  }catch(e){}
  return {
    toProhib:false, tsOrCb:false, heavyPrecip:false, va:false,
    lvto:false, lvp:false, rvr125:false, coldcorr:false,
    xwindExceed:false, xwindKt:null, xwindLimitKt:null
  };
}

function deriveStation(st){

  // Age: compute from raw time group on every render so the UI updates each minute.
  // If raw is missing or unparseable, fall back to the value coming from latest.json.
  const metAgeComputed = computeAgeMinutesFromRawZ(st.metarRaw || "");
  const tafAgeComputed = computeAgeMinutesFromRawZ(st.tafRaw || "");
  st.metarAgeMin = (metAgeComputed !== null) ? metAgeComputed : (st.metarAgeMin ?? st.metarAge ?? null);
  st.tafAgeMin   = (tafAgeComputed !== null) ? tafAgeComputed : (st.tafAgeMin ?? st.tafAge ?? null);
  const met = computeScores(st.metarRaw || "");
  const taf = computeScores(st.tafRaw || "");

  const worstVis = (() => {
    const vals = [];
    if (met.vis !== null) vals.push(met.vis);
    // TAF: could have multiple vis values; use min extracted to represent worst
    const tafVals = extractAllVisibilityMetersFromTAF(st.tafRaw || "");
    if (tafVals.length) vals.push(Math.min(...tafVals));
    return vals.length ? Math.min(...vals) : null;
  })();

  const allRvr = [...extractRvrMeters(st.metarRaw || ""), ...extractRvrMeters(st.tafRaw || "")];
  const rvrMinAll = allRvr.length ? Math.min(...allRvr) : null;

  const cigAll = (() => {
    const a = ceilingFt(st.metarRaw || "");
    const b = ceilingFt(st.tafRaw || "");
    if (a === null) return b;
    if (b === null) return a;
    return Math.min(a,b);
  })();


  // OM policy layer (derived from METAR/TAF only; no manual runway heading/condition)
  st.om = computeOmPolicy(st, met, taf, worstVis, rvrMinAll);

  // ENG ICE OPS condition based on METAR visibility + METAR FZFG (operationally "now")
  const engIceOps = (met.vis !== null && met.vis <= 150 && met.hz.fzfg);

  // severity score (combined but METAR has higher weight)
  let severityScore = Math.max(met.score, Math.floor(taf.score*0.85));
  if (engIceOps) severityScore = 100;

  // Base alert derived from score, then "pillar" escalation for wind and snow.
  const baseAlert = alertFromScore(severityScore);
  const windAlert = windPillarAlert(met, taf);
  const snowAlert = snowPillarAlert(st, met, taf, worstVis, rvrMinAll, cigAll);
  const alert = maxAlert(baseAlert, windAlert, snowAlert);

  // Keep score bucket consistent with the escalated alert.
  severityScore = Math.max(severityScore, minScoreForAlert(alert));

  // Priority: METAR outranks TAF
  // Primary sort key uses METAR score, then TAF score
  const metPri = engIceOps ? 1000 : met.score; // 1000 = pinned
  const tafPri = taf.score;

  // Determine triggers & source (M/T)
  const triggers = [];
  const push = (label, cls, src) => triggers.push({label, cls, src}); // src: "M","T","MT"
  const addBy = (label, cls, m, t) => {
    if (!m && !t) return;
    const src = m && t ? "MT" : (m ? "M" : "T");
    push(label, cls, src);
  };

  
  // OM-A/OM-B advisory flags (METAR/TAF-derived)
  if (st.om){
    if (st.om.toProhib) push("TO/LND PROHIBITED", "tag--stop", "M");
    if (st.om.lvto) push("LVTO", "tag--lvto", "M");
    if (st.om.lvp) push("LVP required", "tag--warn", "M");
    if (st.om.rvr125) push("RVR<125", "tag--stop", "M");
    if (st.om.xwindExceed) push(`XWIND>${st.om.xwindLimitKt}KT`, "tag--wind", "M");
    if (st.om.va) push("VA", "tag--stop", "M");
    if (st.om.coldcorr) push("COLD CORR", "tag--warn", "M");
  }

// VIS thresholds for worstVis
  for (const th of VIS_THRESHOLDS){
    const m = (met.vis !== null && met.vis <= th);
    const t = (() => {
      const vals = extractAllVisibilityMetersFromTAF(st.tafRaw || "");
      return vals.length ? Math.min(...vals) <= th : false;
    })();
    if (m || t){
      addBy(`VIS≤${th}`, "tag--vis", m, t);
      break; // show only tightest bucket
    }
  }

  // RVR buckets
  if (rvrMinAll !== null){
    for (const th of RVR_THRESHOLDS){
      const m = extractRvrMeters(st.metarRaw || "").some(v => v <= th);
      const t = extractRvrMeters(st.tafRaw || "").some(v => v <= th);
      if (m || t){
        addBy(`RVR≤${th}`, "tag--rvr", m, t);
        break;
      }
    }
  }

  // CIG<500
  addBy("CIG<500", "tag--cig",
        (ceilingFt(st.metarRaw || "") !== null && ceilingFt(st.metarRaw || "") < 500),
        (ceilingFt(st.tafRaw || "") !== null && ceilingFt(st.tafRaw || "") < 500));

// Wind gusts
const mg25 = (met.gustMax !== null && met.gustMax >= 25);
const tg25 = (taf.gustMax !== null && taf.gustMax >= 25);
const mg30 = (met.gustMax !== null && met.gustMax >= 30);
const tg30 = (taf.gustMax !== null && taf.gustMax >= 30);
const mg40 = (met.gustMax !== null && met.gustMax >= 40);
const tg40 = (taf.gustMax !== null && taf.gustMax >= 40);
// Show higher threshold if met/taf gusts are very strong
addBy("GUST≥40KT", "tag--gust", mg40, tg40);
addBy("GUST≥30KT", "tag--gust", mg30 && !mg40, tg30 && !tg40);
addBy("GUST≥25KT", "tag--gust", mg25 && !mg30 && !mg40, tg25 && !tg30 && !tg40);
  // Wx
  const mhz = met.hz, thz = taf.hz;
  addBy("TS", "tag--wx", mhz.ts, thz.ts);
  addBy("FZFG", "tag--wx", mhz.fzfg, thz.fzfg);
  addBy("FG", "tag--wx", mhz.fg, thz.fg);
  addBy("BR", "tag--wx", mhz.br, thz.br);
  addBy("SN", "tag--wx", mhz.sn, thz.sn);
  addBy("RA", "tag--wx", mhz.ra, thz.ra);

  // ENG ICE OPS tag: show source METAR (M) by design
  if (engIceOps){
    triggers.unshift({label:"ENG ICE OPS", cls:"tag--eng", src:"M"});
  }

  
  // OM-A/OM-B policy triggers (advisory; based strictly on METAR/TAF observables)
  const om = st.om;

  // Takeoff/Landing prohibited due TS/CB presence (overhead/approaching cannot be inferred from raw strings)
  addBy("OM: TS/CB PROHIBITED", "tag--bad", om.tsCb && (met.hz.ts || met.hz.cb), om.tsCb && (taf.hz.ts || taf.hz.cb));

  // Takeoff prohibited due heavy precipitation/freezing/hail (OM-A 8.3.8.7)
  addBy("OM: TO PROHIBITED (WX)", "tag--bad", om.takeoffProhibitedWx && (met.hz.heavySn || met.hz.heavyFzra || met.hz.fzra || met.hz.gr || met.hz.pl || met.hz.gs || met.hz.sg), 
                                 om.takeoffProhibitedWx && (taf.hz.heavySn || taf.hz.heavyFzra || taf.hz.fzra || taf.hz.gr || taf.hz.pl || taf.hz.gs || taf.hz.sg));

  // Takeoff minima / LVTO / absolute minimum
  if (om.rvrBelow125) push("OM: RVR/VIS < 125m", "tag--bad", "MT");
  else if (om.lvpReq) push("OM: LVP required (<400m)", "tag--warn", "MT");
  else if (om.lvto) push("OM: LVTO (<550m)", "tag--warn", "MT");

  // Landing minima indicators (generic, since actual CAT depends on approach)
  if (om.belowCat3) push("OM: Below CAT III (75m)", "tag--bad", "MT");
  else if (om.belowCat2) push("OM: Below CAT II (300m/100ft)", "tag--warn", "MT");
  else if (om.belowCat1) push("OM: Below CAT I (550m/200ft)", "tag--warn", "MT");

  if (om.circlingBelow) push("OM: Circling below (4000m/1000ft)", "tag--warn", "MT");

  // Volcanic ash presence
  addBy("OM: VOLCANIC ASH (VA)", "tag--bad", om.volcanicAsh && met.hz.va, om.volcanicAsh && taf.hz.va);

  // Cold temperature corrections
  if (om.coldTemp) push("OM: Cold temp (≤0°C) minima correction", "tag--info", "M");

return {
    ...st,
    met, taf,
    worstVis,
    rvrMinAll,
    cigAll,
    engIceOps,
    severityScore,
    alert,
    metPri,
    tafPri,
    triggers
  };
}

function ageClass(mins){
  if (mins === null || mins === undefined) return "age--stale";
  if (mins <= 20) return "age--fresh";
  if (mins <= 60) return "age--warn";
  return "age--stale";
}

function formatAge(mins){
  if (mins === null || mins === undefined) return "—";
  return `${Math.round(mins)}m`;
}


function computeAgeMinutesFromRawZ(raw, nowUtc=new Date()){
  if (!raw) return null;
  // Match DDHHMMZ
  const m = raw.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
  if (!m) return null;
  const dd = parseInt(m[1],10), hh = parseInt(m[2],10), mm = parseInt(m[3],10);
  if ([dd,hh,mm].some(x=>Number.isNaN(x))) return null;

  // Build a UTC timestamp with today's month/year, then adjust day roll if needed.
  const y = nowUtc.getUTCFullYear();
  const mo = nowUtc.getUTCMonth();
  let obs = Date.UTC(y, mo, dd, hh, mm, 0);
  const now = Date.UTC(y, mo, nowUtc.getUTCDate(), nowUtc.getUTCHours(), nowUtc.getUTCMinutes(), 0);

  // If obs is in the future by > 6h, assume it belongs to previous month/day cycle.
  if (obs - now > 6*3600*1000){
    // previous month
    const prev = new Date(Date.UTC(y, mo, 1, 0, 0, 0));
    prev.setUTCDate(0); // last day of previous month
    const prevMo = prev.getUTCMonth();
    const prevY = prev.getUTCFullYear();
    obs = Date.UTC(prevY, prevMo, dd, hh, mm, 0);
  } else if (now - obs > 25*3600*1000 && dd > nowUtc.getUTCDate()){
    // If day looks ahead but would create >25h age, use previous month
    const prev = new Date(Date.UTC(y, mo, 1, 0, 0, 0));
    prev.setUTCDate(0);
    obs = Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), dd, hh, mm, 0);
  }

  const diffMin = (now - obs) / 60000;
  if (!Number.isFinite(diffMin)) return null;
  // clamp to [0, 24h] for sanity
  return Math.max(0, Math.min(diffMin, 24*60));
}


function highlightRaw(raw){
  // escape
  let s = escapeHtml(raw || "");

// Wind gusts (KT): highlight gust groups like 27015G25KT
s = s.replace(/\b(?:\d{3}|VRB)\d{2,3}G(\d{2,3})KT\b/g, (m, g) => {
  const gv = parseInt(g,10);
  if (Number.isNaN(gv)) return m;
  let cls = null;
  if (gv >= 40) cls = "hl-gust-40";
  else if (gv >= 30) cls = "hl-gust-30";
  else if (gv >= 25) cls = "hl-gust-25";
  if (!cls) return m;
  return `<span class="hl ${cls}" data-cat="wind">${m}</span>`;
});

  // RVR
  s = s.replace(/\bR\d{2}[LRC]?\/([PM]?)(\d{4})(?:V([PM]?)(\d{4}))?([UDN])?\b/g, (m, p1, v1, p2, v2) => {
    const nums = [v1, v2].filter(Boolean).map(x=>parseInt(x,10)).filter(n=>!Number.isNaN(n));
    const minv = nums.length ? Math.min(...nums) : null;
    let cls = "hl-rvr-500";
    if (minv !== null){
      if (minv <= 75) cls = "hl-rvr-75";
      else if (minv <= 200) cls = "hl-rvr-200";
      else if (minv <= 300) cls = "hl-rvr-300";
      else if (minv <= 500) cls = "hl-rvr-500";
    }
    return `<span class="hl ${cls}" data-cat="rvr">${m}</span>`;
  });

  // CIG tokens
  s = s.replace(/\b(BKN|OVC|VV)(\d{3})\b/g, (m, typ, h) => {
    const ft = parseInt(h,10)*100;
    if (!Number.isNaN(ft) && ft < 500){
      return `<span class="hl" data-cat="cig">${m}</span>`;
    }
    return m;
  });

  // Wx hazards
  const hazardMap = [
    {re:/\bTS\w*\b/g, cls:"hl-wx-ts"},
    {re:/\b(FZFG|FG)\b/g, cls:"hl-wx-fog"},
    {re:/\bBR\b/g, cls:"hl-wx-fog"},
    // Snow: include combined codes like RASN / -RASN / SNRA etc.
    {re:/\b[+\-]?[A-Z]{0,3}SN[A-Z]{0,3}\b/g, cls:"hl-wx-snow"},
    // Rain/Drizzle: include combined codes like -RASN / SHRASN etc.
    {re:/\b[+\-]?[A-Z]{0,3}(RA|DZ)[A-Z]{0,3}\b/g, cls:"hl-wx-rain"},
  ];
  for (const h of hazardMap){
    s = s.replace(h.re, (m)=>`<span class="hl ${h.cls}" data-cat="wx">${m}</span>`);
  }

  // Visibility numeric tokens — only highlight when low
  // Find 4-digit vis values (exclude RVR already handled by (?!\/))
  s = s.replace(/(?<!\/)\b(\d{4})\b(?!\/)/g, (m, d) => {
    const v = parseInt(d,10);
    if (Number.isNaN(v)) return m;
    let cls = null;
    if (v <= 150) cls = "hl-vis-150";
    else if (v <= 175) cls = "hl-vis-175";
    else if (v <= 250) cls = "hl-vis-250";
    else if (v <= 300) cls = "hl-vis-300";
    else if (v <= 500) cls = "hl-vis-500";
    else if (v <= 550) cls = "hl-vis-550";
    else if (v <= 800) cls = "hl-vis-800";
    if (!cls) return m;
    return `<span class="hl ${cls}" data-cat="vis">${m}</span>`;
  });

  return s;
}

function decodeMetar(raw){
  if (!raw) return "";
  const out = [];
  // wind
  const wind = raw.match(/\b(\d{3}|VRB)(\d{2})(G(\d{2}))?KT\b/);
  if (wind){
    const g = wind[4] ? ` gust ${wind[4]} kt` : "";
    out.push(`Wind: ${wind[1]}° ${wind[2]} kt${g}`);
  }
  // visibility
  if (/\bCAVOK\b/.test(raw)) out.push("Visibility: 10 km or more");
  else{
    const v = parseVisibilityMeters(raw);
    if (v !== null) out.push(`Visibility: ${v >= 10000 ? "10 km or more" : (v + " m")}`);
  }
  // wx
  const wx = [];
  if (/\bFZFG\b/.test(raw)) wx.push("Freezing fog");
  else if (/\bFG\b/.test(raw)) wx.push("Fog");
  if (/\bBR\b/.test(raw)) wx.push("Mist");
  if (/\b(SN|SHSN)\b/.test(raw)) wx.push("Snow");
  if (/\b(RA|DZ)\b/.test(raw)) wx.push("Rain/Drizzle");
  if (/\bTS\b/.test(raw)) wx.push("Thunderstorm");
  if (wx.length) out.push(`Weather: ${wx.join(", ")}`);

  // temp/dew
  const td = raw.match(/\b(M?\d{2})\/(M?\d{2})\b/);
  if (td){
    const t = td[1].replace(/^M/,"-");
    const d = td[2].replace(/^M/,"-");
    out.push(`Temp/Dew point: ${t}°C / ${d}°C`);
  }
  // qnh
  const q = raw.match(/\bQ(\d{4})\b/);
  if (q) out.push(`QNH: ${q[1]} hPa`);

  // ceiling
  const cig = ceilingFt(raw);
  if (cig !== null) out.push(`Ceiling: ${cig} ft AGL`);

  return `<ul>${out.map(x=>`<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
}

function decodeTaf(raw){
  if (!raw) return "";
  const out = [];
  // valid period
  const vp = raw.match(/\b(\d{2})(\d{2})\/(\d{2})(\d{2})\b/);
  if (vp) out.push(`Valid: day ${vp[1]} ${vp[2]}Z → day ${vp[3]} ${vp[4]}Z`);
  // headline wind
  const wind = raw.match(/\b(\d{3}|VRB)(\d{2})(G(\d{2}))?KT\b/);
  if (wind){
    const g = wind[4] ? ` gust ${wind[4]} kt` : "";
    out.push(`Wind: ${wind[1]}° ${wind[2]} kt${g}`);
  }
  // worst vis
  const vals = extractAllVisibilityMetersFromTAF(raw);
  if (/\bCAVOK\b/.test(raw)) out.push("Visibility: CAVOK");
  else if (vals.length){
    out.push(`Worst visibility in TAF: ${Math.min(...vals)} m`);
  }
  // notable groups
  const groups = [];
  if (/\bTEMPO\b/.test(raw)) groups.push("TEMPO");
  if (/\bBECMG\b/.test(raw)) groups.push("BECMG");
  if (/\bPROB\d{2}\b/.test(raw)) groups.push("PROB");
  if (groups.length) out.push(`Change groups: ${groups.join(", ")}`);

  // hazards
  const hz = hazardFlags(raw);
  const wx = [];
  if (hz.ts) wx.push("TS");
  if (hz.fzfg) wx.push("FZFG");
  if (hz.fg) wx.push("FG");
  if (hz.br) wx.push("BR");
  if (hz.sn) wx.push("SN");
  if (hz.ra) wx.push("RA/DZ");
  if (wx.length) out.push(`Weather signals: ${wx.join(", ")}`);

  // ceiling
  const cig = ceilingFt(raw);
  if (cig !== null) out.push(`Lowest ceiling in TAF: ${cig} ft AGL`);

  return `<ul>${out.map(x=>`<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
}

function metarObsKeyFromRaw(raw){
  if (!raw) return "";
  const m = raw.match(/\b(\d{2}\d{2}\d{2})Z\b/);
  return m ? m[0] : ""; // DDHHMMZ
}

function trendPill(icao, currentMetarVis, metarObsKey){
  // Trend must ONLY change when a NEW METAR arrives (i.e., the DDHHMMZ group changes).
  // Otherwise keep the last computed trend symbol.
  const kObs = `wxm_prev_metar_obs_${icao}`;
  const kVis = `wxm_prev_metar_vis_${icao}`;
  const kTrend = `wxm_prev_metar_trend_${icao}`;

  const obs = metarObsKey || "";
  if (!obs) return {text:"—", cls:"trend--flat"};

  const prevObs = localStorage.getItem(kObs);
  const prevVisRaw = localStorage.getItem(kVis);
  const prevTrend = localStorage.getItem(kTrend);

  // First time seeing this station
  if (!prevObs){
    localStorage.setItem(kObs, obs);
    localStorage.setItem(kVis, currentMetarVis === null ? "" : String(currentMetarVis));
    localStorage.setItem(kTrend, "trend--new|NEW");
    return {text:"NEW", cls:"trend--new"};
  }

  // No new METAR yet → keep the last symbol
  if (prevObs === obs){
    if (prevTrend){
      const [cls, text] = prevTrend.split("|");
      if (cls && text) return {cls, text};
    }
    return {text:"•0", cls:"trend--flat"};
  }

  // New METAR arrived → compute trend vs previous METAR visibility
  const prevVis = prevVisRaw ? parseInt(prevVisRaw,10) : NaN;
  let out = {text:"NEW", cls:"trend--new"};
  if (!Number.isNaN(prevVis) && currentMetarVis !== null){
    if (currentMetarVis < prevVis) out = {text:"▼", cls:"trend--down"};
    else if (currentMetarVis > prevVis) out = {text:"▲", cls:"trend--up"};
    else out = {text:"•0", cls:"trend--flat"};
  }

  localStorage.setItem(kObs, obs);
  localStorage.setItem(kVis, currentMetarVis === null ? "" : String(currentMetarVis));
  localStorage.setItem(kTrend, `${out.cls}|${out.text}`);
  return out;
}

function visBucket(vis){
  if (vis === null) return null;
  for (const th of VIS_THRESHOLDS){
    if (vis <= th) return th;
  }
  return null;
}

function buildLowVisTag(st){
  const b = visBucket(st.worstVis);
  if (!b) return "—";
  return `VIS≤${b}`;
}

function rowHtml(st){
  // Trend is based on ACTUAL METAR visibility, and only updates when a NEW METAR arrives.
  const metVisForTrend = (st.met.vis !== null ? st.met.vis : null);
  const trend = trendPill(st.icao, metVisForTrend, metarObsKeyFromRaw(st.metarRaw || ""));

  const vis = (st.met.vis !== null ? st.met.vis : (st.worstVis ?? null));
  const lowVis = buildLowVisTag(st);
  const lowVisTagHtml = lowVis ? `<span class="tag tag--vis" data-icao="${st.icao}" data-open="1">${escapeHtml(lowVis)}</span>` : "";

  const trigHtml = st.triggers.map(t=>{
    const srcBadge = t.src ? `<span class="tag tag--src">${t.src === "MT" ? "M+T" : t.src}</span>` : "";
    return `<span class="tag ${t.cls || ""}" data-icao="${st.icao}" data-open="1">${escapeHtml(t.label)} ${srcBadge}</span>`;
  }).join("");

  // Age is re-computed on EVERY render (per-minute UI refresh), so it "ticks" without manual reload.
  const metAgeNow = computeAgeMinutesFromRawZ(st.metarRaw || "");
  const tafAgeNow = computeAgeMinutesFromRawZ(st.tafRaw || "");
  const metAgeUse = (metAgeNow !== null) ? metAgeNow : (st.metarAgeMin ?? null);
  const tafAgeUse = (tafAgeNow !== null) ? tafAgeNow : (st.tafAgeMin ?? null);
  const metAge = `<span class="age ${ageClass(metAgeUse)}" data-age="metar" data-icao="${escapeHtml(st.icao)}">${escapeHtml(formatAge(metAgeUse))}</span>`;
  const tafAge = `<span class="age ${ageClass(tafAgeUse)}" data-age="taf" data-icao="${escapeHtml(st.icao)}">${escapeHtml(formatAge(tafAgeUse))}</span>`;

  const metRaw = st.metarRaw ? highlightRaw(st.metarRaw) : "<span class='muted'>—</span>";
  const tafRaw = st.tafRaw ? highlightRaw(st.tafRaw) : "<span class='muted'>—</span>";

  return `<tr class="row" data-icao="${escapeHtml(st.icao)}">
    <td>
      <div class="airport">
        <div class="airport__codes">
          <div class="airport__icao">${escapeHtml(st.icao)}</div>
          <div class="airport__iata ${isBaseAirport(st.iata)?"base":""}">${escapeHtml((st.iata||"—").toUpperCase())}</div>
        </div>
        <div class="airport__name">${escapeHtml(st.name||"")}</div>
      </div>
    </td>
    <td><span class="pill pill--${st.alert.toLowerCase()}">${escapeHtml(alertLabel(st.alert))}</span></td>
    <td><div class="triggers">${lowVisTagHtml}${trigHtml}</div></td>
    <td class="col-worst">
      <div class="worst">
        <span class="mono worst__v">${escapeHtml(String(st.worstVis ?? st.met.vis ?? "—"))}</span>
        <span class="trend ${trend.cls}">${trend.text}</span>
      </div>
    </td>
    <td><span class="mono">${escapeHtml(st.rvrMinAll !== null ? String(st.rvrMinAll) : "—")}</span></td>
    <td><span class="mono">${escapeHtml(st.cigAll !== null ? String(st.cigAll) : "—")}</span></td>
    <td class="col-raw"><div class="raw">${metRaw}</div></td>
    <td class="col-raw"><div class="raw">${tafRaw}</div></td>
    <td class="col-ages">
      <div class="ages">
        <span class="agepill"><span class="age__k">M</span>${metAge}</span>
        <span class="agepill"><span class="age__k">T</span>${tafAge}</span>
      </div>
    </td>
  </tr>`;
}

function applyFilters(list){
  const q = view.q.trim().toUpperCase();
  const cond = view.cond;
  const alert = view.alert;

  return list.filter(st=>{
    if (q){
      const hay = `${st.icao} ${(st.iata||"")} ${(st.name||"")}`.toUpperCase();
      if (!hay.includes(q)) return false;
    }
    if (alert !== "all" && st.alert !== alert) return false;

    switch(cond){
      case "all": break;
      case "eng": if (!st.engIceOps) return false; break;
      case "crit": if (st.alert !== "CRIT") return false; break;
      case "role_base": if (st.role !== "BASE") return false; break;
      case "role_dest": if (st.role !== "DEST") return false; break;
      case "role_alt":  if (st.role !== "ALT") return false; break;
      case "high": if (st.alert !== "HIGH") return false; break;
      case "med": if (st.alert !== "MED") return false; break;

      case "vis800": if (!(st.worstVis !== null && st.worstVis <= 800)) return false; break;
      case "vis550": if (!(st.worstVis !== null && st.worstVis <= 550)) return false; break;
      case "vis500": if (!(st.worstVis !== null && st.worstVis <= 500)) return false; break;
      case "vis300": if (!(st.worstVis !== null && st.worstVis <= 300)) return false; break;
      case "vis250": if (!(st.worstVis !== null && st.worstVis <= 250)) return false; break;
      case "vis300": {
        const v = st.worstVis;
        const r = st.rvrMinAll;
        if (!((v !== null && v < 300) || (r !== null && r < 300))) return false;
      } break;
      case "vis150": if (!(st.worstVis !== null && st.worstVis <= 150)) return false; break;

      case "rvr500": if (!(st.rvrMinAll !== null && st.rvrMinAll <= 500)) return false; break;
      case "rvr300": if (!(st.rvrMinAll !== null && st.rvrMinAll <= 300)) return false; break;
      case "rvr200": if (!(st.rvrMinAll !== null && st.rvrMinAll <= 200)) return false; break;
      case "rvr75":  if (!(st.rvrMinAll !== null && st.rvrMinAll <= 75)) return false; break;

      case "fog":
        if (!(st.met.hz.fg || st.met.hz.br || st.met.hz.fzfg || st.taf.hz.fg || st.taf.hz.br || st.taf.hz.fzfg)) return false;
        break;
      case "snow":
        if (!(st.met.hz.sn || st.taf.hz.sn)) return false;
        break;
      case "rain":
        if (!(st.met.hz.ra || st.taf.hz.ra)) return false;
        break;
      case "ts":
        if (!(st.met.hz.ts || st.taf.hz.ts)) return false;
        break;
case "gust40":
  if (!((st.met.gustMax !== null && st.met.gustMax >= 40) || (st.taf.gustMax !== null && st.taf.gustMax >= 40))) return false;
  break;
case "gust30":
  if (!((st.met.gustMax !== null && st.met.gustMax >= 30) || (st.taf.gustMax !== null && st.taf.gustMax >= 30))) return false;
  break;
case "gust25":
  if (!((st.met.gustMax !== null && st.met.gustMax >= 25) || (st.taf.gustMax !== null && st.taf.gustMax >= 25))) return false;
  break;
      case "cig500":
        if (!(st.cigAll !== null && st.cigAll < 500)) return false;
        break;
      
      // OM-A/OM-B advisory (derived from METAR/TAF only; no manual inputs)
      // Note: These keys intentionally match both the dropdown values and the tile data-filter values.
      case "toProhib":
      case "oma_to_prohib":
        if (!(st.om && st.om.toProhib)) return false;
        break;

      case "lvto":
      case "oma_lvto":
        if (!(st.om && st.om.lvto)) return false;
        break;

      case "lvp":
        if (!(st.om && st.om.lvp)) return false;
        break;

      case "rvr125":
        if (!(st.om && st.om.rvr125)) return false;
        break;

      case "xwind":
        if (!(st.om && st.om.xwindExceed)) return false;
        break;

      case "va":
        if (!(st.om && st.om.va)) return false;
        break;

      case "coldcorr":
      case "oma_cold":
        if (!(st.om && st.om.coldcorr)) return false;
        break;

case "dataset":
  // dataset tile is informational; do not filter
  break;
default: break;
    }

    return true;
  });
}

function sortList(list){
  if (!view.sortPri){
    return [...list].sort((a,b)=> a.icao.localeCompare(b.icao));
  }
  return [...list].sort((a,b)=>{
    // 1) ENG ICE OPS pinned
    if (a.engIceOps !== b.engIceOps) return a.engIceOps ? -1 : 1;
    // 2) METAR priority (current)
    if (b.metPri !== a.metPri) return b.metPri - a.metPri;
    // 3) TAF priority
    if (b.tafPri !== a.tafPri) return b.tafPri - a.tafPri;
    // 4) Severity
    if (b.severityScore !== a.severityScore) return b.severityScore - a.severityScore;
    // 5) ICAO
    return a.icao.localeCompare(b.icao);
  });
}

function updateTiles(currentList){
  const eng = currentList.filter(s=>s.engIceOps);
  const crit = currentList.filter(s=>s.alert==="CRIT");
  const vis300 = currentList.filter(s=> (s.worstVis !== null && s.worstVis < 300) || (s.rvrMinAll !== null && s.rvrMinAll < 300));
  const ts = currentList.filter(s=>s.met.hz.ts || s.taf.hz.ts);
  const wind = currentList.filter(s=> (s.met.gustMax !== null && s.met.gustMax >= 25) || (s.taf.gustMax !== null && s.taf.gustMax >= 25));
  const snow = currentList.filter(s=>s.met.hz.sn || s.taf.hz.sn);

  // OM-A/OM-B advisory flags (computed in assets/om_policy.js)
  const toProhib = currentList.filter(s=>s.om && s.om.toProhib);
  const lvto = currentList.filter(s=>s.om && s.om.lvto);
  const xwind = currentList.filter(s=>s.om && s.om.xwindExceed);
  const va = currentList.filter(s=>s.om && s.om.va);

  const setIf = (id,val)=>{ const el=document.getElementById(id); if (el) el.textContent=String(val); };

  setIf("tileEngCount", eng.length);
  setIf("tileCritCount", crit.length);
  setIf("tileVis300Count", vis300.length);
  setIf("tileTsCount", ts.length);
  setIf("tileWindCount", wind.length);
  setIf("tileSnowCount", snow.length);

  setIf("tileToProhibCount", toProhib.length);
  setIf("tileLvtoCount", lvto.length);
  setIf("tileXwindCount", xwind.length);
  setIf("tileVACount", va.length);

  function uniqIata(list){
    const seen = new Map();
    for (const st of list){
      const code = st.iata || st.icao;
      if (!code) continue;
      const rr = (typeof st.roleRank === "number") ? st.roleRank : roleRank(getRole(st.icao));
      const prev = seen.get(code);
      if (!prev || rr < prev.rr) seen.set(code, {code, rr});
    }
    return Array.from(seen.values())
      .sort((a,b)=> (Number(isBaseAirport(b.code)) - Number(isBaseAirport(a.code))) || (a.rr-b.rr) || a.code.localeCompare(b.code))
      .map(x=>x.code);
  }

  function renderIata(elId, list){
    const el = document.getElementById(elId);
    if (!el) return;
    const codes = uniqIata(list);
    const max = (viewMode === "tv" ? 18 : 10);
    const shown = codes.slice(0, max);
    const rest = codes.length - shown.length;
    el.innerHTML =
      shown.map(x=>`<span class="${isBaseAirport(x)?"iata base":"iata"}">${escapeHtml(x)}</span>`).join("") +
      (rest > 0 ? `<span>+${rest}</span>` : "");
  }

  renderIata("tileEngIata", eng);
  renderIata("tileCritIata", crit);
  renderIata("tileVis300Iata", vis300);
  renderIata("tileTsIata", ts);
  renderIata("tileWindIata", wind);
  renderIata("tileSnowIata", snow);

  renderIata("tileToProhibIata", toProhib);
  renderIata("tileLvtoIata", lvto);
  renderIata("tileXwindIata", xwind);
  renderIata("tileVAIata", va);
}



function render(){
  const tbody = $("rows");
  const filtered = applyFilters(stations);
  const sorted = sortList(filtered);

  updateTiles(sorted);

  if (!sorted.length){
    tbody.innerHTML = `<tr><td colspan="9" class="muted">No matching rows.</td></tr>`;
    return;
  }

  tbody.innerHTML = sorted.map(rowHtml).join("");

  // row click and tag click opens drawer
  tbody.querySelectorAll("tr.row").forEach(tr=>{
    tr.addEventListener("click", (ev)=>{
      // if clicked on a link-like element, still open
      const icao = tr.getAttribute("data-icao");
      openDrawer(icao);
    });
  });
  tbody.querySelectorAll("[data-open='1']").forEach(el=>{
    el.addEventListener("click", (ev)=>{
      ev.stopPropagation();
      const icao = el.getAttribute("data-icao");
      openDrawer(icao);
    });
  });
}

function openDrawer(icao){
  updateTopHeight();
  const st = stations.find(s=>s.icao === icao);
  if (!st) return;

  drawerIcao = icao;

  $("dAirport").textContent = `${st.icao} ${(st.iata||"—").toUpperCase()}`;
  $("dSub").textContent = st.name || "";

  $("dAlert").textContent = st.alert;
  $("dSev").textContent = String(st.severityScore);
  $("dVis").textContent = st.met.vis !== null ? `${st.met.vis} m` : "—";
  $("dWorstVis").textContent = st.worstVis !== null ? `${st.worstVis} m` : "—";
  $("dRvr").textContent = st.rvrMinAll !== null ? `${st.rvrMinAll} m` : "—";
  $("dCig").textContent = st.cigAll !== null ? `${st.cigAll} ft` : "—";
  // Age should tick without page reload: compute from raw DDHHMMZ each time drawer opens.
  const metAgeNow = computeAgeMinutesFromRawZ(st.metarRaw || "");
  const tafAgeNow = computeAgeMinutesFromRawZ(st.tafRaw || "");
  $("dMetAge").textContent = formatAge(metAgeNow !== null ? metAgeNow : (st.metarAgeMin ?? null));
  $("dTafAge").textContent = formatAge(tafAgeNow !== null ? tafAgeNow : (st.tafAgeMin ?? null));

  // triggers in drawer — fixed: always flex-wrap container; no overlapping
  $("dTriggers").innerHTML = st.triggers.map(t=>{
    const src = t.src ? `<span class="tag tag--src">${t.src==="MT"?"M+T":t.src}</span>` : "";
    return `<span class="tag ${t.cls||""}">${escapeHtml(t.label)} ${src}</span>`;
  }).join("");

  $("dMetRaw").innerHTML = st.metarRaw ? highlightRaw(st.metarRaw) : "—";
  $("dTafRaw").innerHTML = st.tafRaw ? highlightRaw(st.tafRaw) : "—";

  $("dMetDec").innerHTML = decodeMetar(st.metarRaw || "");
  $("dTafDec").innerHTML = decodeTaf(st.tafRaw || "");

  $("copyBrief").onclick = async () => {
    const line = buildBriefingLine(st);
    try{
      await navigator.clipboard.writeText(line);
      $("copyBrief").textContent = "Copied";
      setTimeout(()=> $("copyBrief").textContent = "Copy briefing line", 900);
    }catch{
      // fallback
      const ta = document.createElement("textarea");
      ta.value = line;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      $("copyBrief").textContent = "Copied";
      setTimeout(()=> $("copyBrief").textContent = "Copy briefing line", 900);
    }
  };

  // open
  $("drawer").classList.add("is-open");
  $("drawer").setAttribute("aria-hidden","false");
  $("scrim").hidden = false;
}

function refreshDrawerAges(){
  if (!drawerIcao) return;
  const st = stations.find(s=>s.icao === drawerIcao);
  if (!st) return;
  const metAgeNow = computeAgeMinutesFromRawZ(st.metarRaw || "");
  const tafAgeNow = computeAgeMinutesFromRawZ(st.tafRaw || "");
  $("dMetAge").textContent = formatAge(metAgeNow !== null ? metAgeNow : (st.metarAgeMin ?? null));
  $("dTafAge").textContent = formatAge(tafAgeNow !== null ? tafAgeNow : (st.tafAgeMin ?? null));
}

function closeDrawer(){
  $("drawer").classList.remove("is-open");
  $("drawer").setAttribute("aria-hidden","true");
  $("scrim").hidden = true;
  drawerIcao = null;
}

function buildBriefingLine(st){
  const parts = [];
  parts.push(`${st.icao}/${(st.iata||"—").toUpperCase()}`);
  parts.push(`ALERT ${st.alert} (sev ${st.severityScore})`);
  if (st.engIceOps) parts.push("ENG ICE OPS");
  if (st.met.vis !== null) parts.push(`METAR VIS ${st.met.vis}m`);
  if (st.worstVis !== null) parts.push(`WORST VIS ${st.worstVis}m`);
  if (st.rvrMinAll !== null) parts.push(`RVRmin ${st.rvrMinAll}m`);
  if (st.cigAll !== null) parts.push(`CIG ${st.cigAll}ft`);
  const trig = st.triggers.map(t=>`${t.label}${t.src?`(${t.src})`:""}`).join(",");
  if (trig) parts.push(`TRG ${trig}`);
  return parts.join(" | ");
}


function updateAgesInPlace(){
  // Update METAR/TAF ages in the existing DOM without rerendering the whole table.
  // This keeps the UI stable (no scroll jumps) and still shows the "age ticking".
  const nowUtc = new Date();
  document.querySelectorAll('span.age[data-age][data-icao]').forEach(el=>{
    const icao = el.getAttribute('data-icao');
    const st = stationMap.get(icao);
    if (!st) return;
    const kind = el.getAttribute('data-age');
    const raw = (kind === 'taf') ? (st.tafRaw || "") : (st.metarRaw || "");
    const ageNow = computeAgeMinutesFromRawZ(raw, nowUtc);
    const mins = (ageNow !== null) ? ageNow : (kind === 'taf' ? (st.tafAgeMin ?? null) : (st.metarAgeMin ?? null));
    el.textContent = formatAge(mins);
    el.classList.remove('age--fresh','age--warn','age--stale');
    el.classList.add(ageClass(mins));
  });
}


function applyDataFromLatest(data){
  const gen = data && data.generatedAt ? new Date(data.generatedAt) : null;
  const genStr = (data && data.generatedAt) ? String(data.generatedAt) : null;
  lastGeneratedAt = genStr;

  $("statUpdated").textContent = (gen && !isNaN(gen.getTime()))
    ? `Last update: ${gen.toISOString().replace('T',' ').slice(0,16)}Z`
    : "Last update: —";

  const rawStations = Array.isArray(data.stations) ? data.stations : [];
  stations = rawStations.map(s => ({
    icao: (s.icao || s.station || "").toUpperCase(),
    iata: (s.iata || "").toUpperCase(),
    name: s.name || s.airportName || "",
    metarRaw: s.metarRaw || s.metar || "",
    tafRaw: s.tafRaw || s.taf || "",
    metarAgeMin: s.metarAgeMin ?? s.metarAge ?? null,
    tafAgeMin: s.tafAgeMin ?? s.tafAge ?? null,
  })).filter(s=>s.icao && s.icao.length===4).map(deriveStation).map(st=>{
    st.role = getRole(st.icao);
    st.roleRank = roleRank(st.role);
    return st;
  });

  stationMap = new Map(stations.map(s=>[s.icao, s]));

  const metCnt = stations.filter(s=>!!s.metarRaw).length;
  const tafCnt = stations.filter(s=>!!s.tafRaw).length;
  const missMet = stations.length - metCnt;
  const missTaf = stations.length - tafCnt;
  $("statCounts").textContent = `ICAO: ${stations.length} | METAR: ${metCnt} | TAF: ${tafCnt} | Missing METAR: ${missMet} | Missing TAF: ${missTaf}`;

  render();

  // If the drawer is open, refresh its content from the updated dataset (without closing).
  if (drawerIcao){
    const body = $("drawerBody");
    const scroll = body ? body.scrollTop : 0;
    openDrawer(drawerIcao);
    if (body) body.scrollTop = scroll;
  }
}


async function updateDatasetTile(){
  const stateEl = document.getElementById("tileDatasetState");
  const subEl = document.getElementById("tileDatasetSub");
  if (!stateEl || !subEl) return;
  try{
    const res = await fetch("data/status.json?cb=" + Date.now(), {cache:"no-store"});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = await res.json();
    const gen = s && s.generatedAt ? new Date(s.generatedAt) : null;
    if (!gen || Number.isNaN(gen.getTime())) throw new Error("Invalid generatedAt");
    const mins = Math.floor((Date.now() - gen.getTime())/60000);
    const delayed = mins >= 20;
    stateEl.textContent = delayed ? "Delayed" : "OK";
    subEl.textContent = `Last update: ${gen.toISOString().replace(".000","")} · ${mins} min ago`;
  }catch(e){
    stateEl.textContent = "—";
    subEl.textContent = "Last update: —";
  }
}

async function refreshData(force=false){
  const tbody = $("rows");
  try{
    await fetchBaseAirportsOnce();
    await fetchRoles();
    await fetchRunways();
    const res = await fetch("data/latest.json?cb=" + Date.now(), {cache:"no-store"});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const genStr = (data && data.generatedAt) ? String(data.generatedAt) : null;
    if (!force && genStr && lastGeneratedAt && genStr === lastGeneratedAt){
      // Data unchanged: only update ages in-place.
      updateAgesInPlace();
      refreshDrawerAges();
      await updateDatasetTile();
      return;
    }

    applyDataFromLatest(data);
    await updateDatasetTile();
  }catch(err){
    console.error(err);
    tbody.innerHTML = `<tr><td colspan="9" class="muted">Data load error: ${escapeHtml(String(err))}. Ensure data/latest.json exists and is valid.</td></tr>`;
    $("statCounts").textContent = "ICAO: 0 | METAR: 0 | TAF: 0";
    $("statUpdated").textContent = "Last update: —";
    updateTiles([]);
    await updateDatasetTile();
  }
}

async function load(){
  return refreshData(true);
}


function bind(){
  const TILE_TO_COND = {eng:"eng", crit:"crit", vis300:"vis300", ts:"ts", wind:"gust25", snow:"snow", toProhib:"toProhib", lvto:"lvto", xwind:"xwind", va:"va"};

 // Ensure the Quick View overlay never shows on initial load (prevents the "grey fog" layer)
  try {
    const s = $("scrim");
    const d = $("drawer");
    if (s) { s.hidden = true; s.classList.add("hidden"); }
    if (d) { d.hidden = true; d.classList.add("hidden"); d.classList.remove("is-open"); d.setAttribute("aria-hidden","true"); }
  } catch(e) {}


  const syncActiveTile = ()=>{
    const tiles = Array.from(document.querySelectorAll('#tiles .tile[data-filter]'));
    tiles.forEach(btn=>{
      const f = btn.getAttribute('data-filter');
      const target = TILE_TO_COND[f] || null;
      const on = (target && view.cond === target);
      btn.classList.toggle('tile--active', !!on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  };

  $("q").addEventListener("input", (e)=>{ view.q = e.target.value; render(); });
  $("cond").addEventListener("change", (e)=>{ view.cond = e.target.value; syncActiveTile(); render(); });
  $("alert").addEventListener("change", (e)=>{ view.alert = e.target.value; render(); });
  $("sortPri").addEventListener("change", (e)=>{ view.sortPri = e.target.checked; render(); });
  initViewModeUI();
  initTileTooltips();


  // tile filters
  $("tiles").addEventListener("click", (e)=>{
    const btn = e.target.closest("button.tile");
    if (!btn) return;
    if (btn.id === "tileReset"){
      view.q=""; view.cond="all"; view.alert="all"; view.sortPri=true;
      $("q").value=""; $("cond").value="all"; $("alert").value="all"; $("sortPri").checked=true;
      syncActiveTile();
      render();
      return;
    }
    const f = btn.getAttribute("data-filter");
    if (!f) return;
    // toggle: clicking same filter again resets to all
    const target = TILE_TO_COND[f] || "all";
    view.cond = (view.cond === target ? "all" : target);
    $("cond").value = view.cond;
    syncActiveTile();
    render();

    // UX: ensure the table is in view after selecting a tile filter
    const table = document.getElementById('table');
    if (table){ table.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });

  $("drawerClose").addEventListener("click", closeDrawer);
  $("scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown",(e)=>{ if (e.key==="Escape") closeDrawer(); });

  // Refresh time-based UI (METAR/TAF age) every minute without refetch.
  // Also keep the Quick View drawer age fields ticking if it's open.
  setInterval(()=>{ updateAgesInPlace(); refreshDrawerAges(); }, 60_000);

  // Poll for new data (generatedAt change) every 60 seconds. Reads only GitHub Pages CDN, not AWC.
  setInterval(()=>{ refreshData(false); }, 60_000);

  // If the tab becomes visible again, force a refresh so ages don't look frozen.
  document.addEventListener("visibilitychange", ()=>{
    if (!document.hidden){ refreshData(false); }
  });
}

bind();
updateDatasetTile();
load();

updateTopHeight();
