
/* v62: changes
   - Quick View triggers layout (CSS flex-wrap)
   - Raw highlight overlap fixed via CSS .hl inline-block margins
   - Priority: METAR-driven hazards outrank TAF-only hazards
*/

const $ = (id) => document.getElementById(id);


// View mode (Auto / TV) ----------------------------------------------------
const VIEW_MODE_KEY = "wizz_viewMode"; // "auto" | "tv"
let viewMode = (localStorage.getItem(VIEW_MODE_KEY) || "auto");


// Notifications (AUTO view): browser notifications when a NEW BASE becomes impacted by a NEW METAR
const NOTIF_KEY = "wxm_notifEnabled"; // "1"|"0"
let notifEnabled = (localStorage.getItem(NOTIF_KEY) === "1");

// Collapsible TAF tiles panel
const TAF_PANEL_KEY = "wxm_tafPanelOpen"; // "1"|"0"
let tafPanelOpen = (localStorage.getItem(TAF_PANEL_KEY) === "1"); // default collapsed

// For change detection (new METAR / new alerts)
let prevMetarObsByIcao = new Map(); // ICAO -> "DDHHMMZ"
let prevSignalSets = null; // previous tile sets for TV toast/flash


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


// --- Notifications UI ----------------------------------------------------
function updateNotifBtn(){
  const btn = $("notifBtn");
  const lbl = $("notifBtnLabel");
  if (!btn || !lbl) return;
  const supported = (typeof window !== "undefined" && "Notification" in window);
  btn.classList.toggle("hidden", !supported);
  lbl.textContent = notifEnabled ? "ON" : "OFF";
}

async function requestNotifPermission(){
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try{
    const p = await Notification.requestPermission();
    return p === "granted";
  }catch(e){
    return false;
  }
}

async function toggleNotifications(){
  if (!("Notification" in window)) return;
  if (!notifEnabled){
    const ok = await requestNotifPermission();
    if (!ok){
      notifEnabled = false;
      localStorage.setItem(NOTIF_KEY, "0");
      updateNotifBtn();
      return;
    }
    notifEnabled = true;
    localStorage.setItem(NOTIF_KEY, "1");
    updateNotifBtn();
    try{
      new Notification("Notifications enabled", {body:"You will be notified when a NEW BASE becomes impacted by a NEW METAR (AUTO view).", silent:true});
    }catch(e){}
    return;
  }
  notifEnabled = false;
  localStorage.setItem(NOTIF_KEY, "0");
  updateNotifBtn();
}

function initNotifUI(){
  updateNotifBtn();
  const btn = $("notifBtn");
  if (btn) btn.addEventListener("click", toggleNotifications);
}

// --- TAF panel UI --------------------------------------------------------
function applyTafPanelState(){
  const panel = $("tilesTaf");
  const sub = $("tileTafAnySub");
  if (panel) panel.classList.toggle("hidden", !tafPanelOpen);
  if (sub) sub.textContent = tafPanelOpen ? "tap to collapse" : "tap to expand";
}

function toggleTafPanel(){
  tafPanelOpen = !tafPanelOpen;
  localStorage.setItem(TAF_PANEL_KEY, tafPanelOpen ? "1" : "0");
  applyTafPanelState();
}

function initTafPanelUI(){
  applyTafPanelState();
  // click handler is bound in bind() on the summary tile
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

// Base airport list (IATA codes) from repo-backed base.txt.
// Used for highlighting + prioritisation.
let baseSet = new Set();

function isBaseCode(code){
  const v = String(code || "").trim().toUpperCase();
  return v && baseSet.has(v);
}

async function fetchBaseList(){
  try{
    const res = await fetch("base.txt?cb=" + Date.now(), {cache:"no-store"});
    if (!res.ok){
      baseSet = new Set();
      return baseSet;
    }
    const txt = await res.text();
    const out = new Set();
    for (const line of txt.split(/\r?\n/)){
      const v = String(line || "").trim().toUpperCase();
      if (!v || v.startsWith("#")) continue;
      out.add(v);
    }
    baseSet = out;
  }catch(e){
    baseSet = new Set();
  }
  return baseSet;
}

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
  // - supports US-style SM tokens including split form: "1 1/2SM"
  const toks = String(raw).trim().split(/\s+/);

  let best = null;
  const add = (m)=>{ if (m == null) return; best = (best==null) ? m : Math.min(best, m); };

  for (let idx=0; idx<toks.length; idx++){
    const t0 = toks[idx].trim().toUpperCase();
    if (!t0) continue;

    // Split statute miles: e.g. "1 1/2SM" or "2 M1/4SM"
    if (/^\d+$/.test(t0) && idx+1 < toks.length){
      const t1 = toks[idx+1].trim().toUpperCase();
      if (/^M?\d+\/\d+SM$/.test(t1)){
        const whole = parseInt(t0,10);
        const frac = t1.replace(/^M/,'').slice(0,-2);
        const [a,b] = frac.split('/').map(Number);
        if (Number.isFinite(whole) && Number.isFinite(a) && Number.isFinite(b) && b !== 0){
          add(Math.round((whole + (a/b))*1609.34));
          idx++; // consume fraction token
          continue;
        }
      }
    }

    // US fractional statute miles (single token): e.g. 1/2SM, M1/4SM
    if (/^M?\d+\/\d+SM$/.test(t0)){
      const frac = t0.replace(/^M/,"").slice(0,-2);
      const [a,b] = frac.split("/").map(Number);
      if (Number.isFinite(a) && Number.isFinite(b) && b !== 0){
        add(Math.round((a/b)*1609.34));
      }
      continue;
    }

    // Ignore validity/time ranges (TAF) and RVR groups
    if (/^\d{4}\/\d{4}$/.test(t0)) continue;
    if (/^R\d{2}[LRC]?\//.test(t0)) continue;
    if (t0.includes("/")) continue;

    // ICAO vis tokens: 0400, 9999, also with suffix like 9999NDV
    if (/^\d{4}(?:[A-Z]{1,4})?$/.test(t0)){
      const v = parseInt(t0.slice(0,4),10);
      if (!Number.isNaN(v)) add(v === 9999 ? 10000 : v);
      continue;
    }

    // Whole statute miles tokens: P6SM, 2SM, M1SM
    if (/^P\d+SM$/.test(t0)){
      const n = parseInt(t0.slice(1,-2),10);
      if (Number.isFinite(n)) add(Math.round(n*1609.34));
      continue;
    }
    if (/^M?\d+SM$/.test(t0)){
      const n = parseInt(t0.replace(/^M/,"").slice(0,-2),10);
      if (Number.isFinite(n)) add(Math.round(n*1609.34));
      continue;
    }
  }

  return best;
}



function extractAllVisibilityMetersFromTAF(raw){
  if (!raw) return [];
  const out = [];

  if (/\bCAVOK\b/.test(raw)) out.push(10000);

  const toks = String(raw).trim().split(/\s+/);
  for (let idx=0; idx<toks.length; idx++){
    const t0 = toks[idx].trim().toUpperCase();
    if (!t0) continue;

    // Split statute miles: "1 1/2SM"
    if (/^\d+$/.test(t0) && idx+1 < toks.length){
      const t1 = toks[idx+1].trim().toUpperCase();
      if (/^M?\d+\/\d+SM$/.test(t1)){
        const whole = parseInt(t0,10);
        const frac = t1.replace(/^M/,"").slice(0,-2);
        const [a,b] = frac.split("/").map(Number);
        if (Number.isFinite(whole) && Number.isFinite(a) && Number.isFinite(b) && b !== 0){
          out.push(Math.round((whole + (a/b))*1609.34));
          idx++;
          continue;
        }
      }
    }

    // Fractional statute miles token: 1/2SM
    if (/^M?\d+\/\d+SM$/.test(t0)){
      const frac = t0.replace(/^M/,"").slice(0,-2);
      const [a,b] = frac.split("/").map(Number);
      if (Number.isFinite(a) && Number.isFinite(b) && b !== 0){
        out.push(Math.round((a/b)*1609.34));
      }
      continue;
    }

    // Ignore validity/time ranges and RVR groups
    if (/^\d{4}\/\d{4}$/.test(t0)) continue;
    if (/^R\d{2}[LRC]?\//.test(t0)) continue;
    if (t0.includes("/")) continue;

    if (/^\d{4}(?:[A-Z]{1,4})?$/.test(t0)){
      const v = parseInt(t0.slice(0,4),10);
      if (!Number.isNaN(v)) out.push(v === 9999 ? 10000 : v);
      continue;
    }

    if (/^P\d+SM$/.test(t0)){
      const n = parseInt(t0.slice(1,-2),10);
      if (Number.isFinite(n)) out.push(Math.round(n*1609.34));
      continue;
    }
    if (/^M?\d+SM$/.test(t0)){
      const n = parseInt(t0.replace(/^M/,"").slice(0,-2),10);
      if (Number.isFinite(n)) out.push(Math.round(n*1609.34));
      continue;
    }
  }
  return out;
}



function extractRvrMeters(raw){
  if (!raw) return [];
  // Accept common ICAO format and US-style optional FT suffix.
  // Examples: R29/1000N, R06/0600V1000U, R27/P1500U, R09/M0050N, R11/1200FT
  const re = /\bR\d{2}[LRC]?\/([PM]?)(\d{4})(?:V([PM]?)(\d{4}))?([UDN])?(FT)?\b/g;
  const vals = [];
  let m;
  while ((m = re.exec(raw)) !== null){
    const isFt = !!m[6];
    const toMeters = (x)=> isFt ? Math.round(x * 0.3048) : x;

    const v1 = parseInt(m[2],10);
    if (!Number.isNaN(v1)) vals.push(toMeters(v1));
    if (m[4]){
      const v2 = parseInt(m[4],10);
      if (!Number.isNaN(v2)) vals.push(toMeters(v2));
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
  // Returns a richer set of phenomena flags from raw METAR/TAF strings.
  // NOTE: The report header (METAR/TAF/SPECI/AUTO/AMD/...) and ICAO station id are stripped
  // before token scanning to avoid false positives like LGTS/GCTS triggering TS.
  if (!raw) return {
    fzfg:false, fg:false, br:false, blsn:false,
    sn:false, ra:false, ts:false, cb:false,
    va:false,
    fzra:false, fzdz:false, gr:false, pl:false, gs:false, sg:false,
    heavySn:false, heavyFzra:false, heavyHail:false,
  };

  const upAll = String(raw).toUpperCase();

  // Strip leading meta tokens + ICAO to prevent substring matches inside airport identifiers.
  const toksAll = upAll.split(/\s+/).map(t=>t.trim()).filter(Boolean);
  let i = 0;
  const headerSkip = new Set(["METAR","SPECI","TAF","AUTO","COR","AMD","CNL","NIL"]);
  while (i < toksAll.length && headerSkip.has(toksAll[i])) i++;
  if (i < toksAll.length && /^[A-Z]{4}$/.test(toksAll[i])) i++; // ICAO station
  const toks = toksAll.slice(i);

  const coreText = toks.join(" ");

  // Token-aware helpers to catch combined weather codes like RASN, -RASN, SNRA, etc.
  const wxToks = toks.filter(t=>{
    if (!t) return false;
    if (t.includes("/")) return false;                 // time groups, RVR, validity
    if (/[0-9]/.test(t)) return false;                 // numeric groups
    if (/KT$/.test(t) || /MPS$/.test(t)) return false; // wind
    if (t.length > 12) return false;
    return true;
  });

  const hasWx = (needle)=>wxToks.some(t=>t.includes(needle));
  const hasWxRe = (re)=>wxToks.some(t=>re.test(t));

  // Cloud qualifiers can be attached: BKN020CB, SCT030TCU, etc. (avoid matching in ICAO)
  const cb =
    /\b(?:FEW|SCT|BKN|OVC|VV)\d{3}(?:CB|TCU)\b/.test(coreText) ||
    /\bCB\b/.test(coreText) ||
    /\bTCU\b/.test(coreText) ||
    hasWx("CB") || hasWx("TCU");

  const va = /\bVA\b/.test(coreText);

  const fzra = /\bFZRA\b/.test(coreText) || hasWx("FZRA");
  const fzdz = /\bFZDZ\b/.test(coreText) || hasWx("FZDZ");
  const gr   = /\bGR\b/.test(coreText)   || hasWx("GR");
  const pl   = /\bPL\b/.test(coreText)   || hasWx("PL");
  const gs   = /\bGS\b/.test(coreText)   || hasWx("GS");
  const sg   = /\bSG\b/.test(coreText)   || hasWx("SG");

  // Heavy-intensity markers (used for OM-A takeoff prohibition list in om_policy.js as well)
  const heavySn   = /\+SN\b/.test(coreText) || hasWx("+SN");
  const heavyFzra = /\+FZRA\b/.test(coreText) || /\bFZRA\b/.test(coreText); // includes +FZRA
  const heavyHail = /\+GR\b/.test(coreText) || /\bGR\b/.test(coreText);     // includes +GR

  // TS: match only true weather tokens (avoid ICAO substring issues)
  const ts = hasWxRe(/^(?:\+|\-)?TS/) || hasWxRe(/^VCTS/);

  return {
    fzfg: /\bFZFG\b/.test(coreText),
    fg: /\bFG\b/.test(coreText) || hasWx("FG"),
    br: /\bBR\b/.test(coreText) || hasWx("BR"),
    blsn: /\bBLSN\b/.test(coreText) || hasWx("BLSN"),

    sn: /\bSN\b/.test(coreText) || /\bSHSN\b/.test(coreText) || /\bBLSN\b/.test(coreText) || hasWx("SN"),
    ra: /\bRA\b/.test(coreText) || /\bDZ\b/.test(coreText) || hasWx("RA") || hasWx("DZ"),
    ts,
    cb,

    va,
    fzra, fzdz, gr, pl, gs, sg,
    heavySn, heavyFzra, heavyHail,
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
  if (hz.cb) score += 12;
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
    lvto:false, lvp:false, lvtoQualReq:false, rvr125:false, rvrRequired:false,
    cat2Plus:false, cat3Only:false, cat3BelowMin:false,
    coldcorr:false,
    xwindExceed:false, xwindKt:null, xwindLimitKt:null,
    xwindCond:null, rwyccEst:null, noOpsLikely:false
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

  // TAF-only worst visibility (for forecast tiles)
  const tafWorstVis = (() => {
    const vals = extractAllVisibilityMetersFromTAF(st.tafRaw || "");
    if (vals.length) return Math.min(...vals);
    return (taf.vis !== null) ? taf.vis : null;
  })();

  const metRvrMin = (met.rvrMin !== undefined) ? met.rvrMin : null;
  const tafRvrMin = (taf.rvrMin !== undefined) ? taf.rvrMin : null;

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

  // Separate OM flags for METAR-only vs TAF-only tiles
  const _empty = computeScores("");
  st.omMet = computeOmPolicy({...st, tafRaw:""}, met, _empty, met.vis, metRvrMin);
  st.omTaf = computeOmPolicy({...st, metarRaw:""}, _empty, taf, tafWorstVis, tafRvrMin);

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

  
  
  // OM-A/OM-B advisory tags (derived from raw METAR/TAF observables)
  // Note: these are dispatcher aids; the dashboard has no access to SNOWTAM / reported RWYCC.
  const omM = st.omMet || {};
  const omT = st.omTaf || {};

  // Hierarchical tagging to avoid duplicates (show the most restrictive band per source)
  const minimaState = (om)=>{
    if (om && om.rvr125) return "rvr125";
    if (om && om.lvtoQualReq) return "lvto150";
    if (om && om.lvp) return "lvp";
    if (om && om.lvto) return "lvto";
    return null;
  };
  const catState = (om)=>{
    if (om && om.cat3BelowMin) return "cat3min";
    if (om && om.cat3Only) return "cat3only";
    if (om && om.cat2Plus) return "cat2plus";
    return null;
  };

  const mMin = minimaState(omM);
  const tMin = minimaState(omT);
  const mCat = catState(omM);
  const tCat = catState(omT);

  // OM-A heavy precip: TAKEOFF IS PROHIBITED
  addBy("TO PROHIB", "tag--stop", !!omM.toProhib, !!omT.toProhib);

  // Takeoff / LVO bands
  addBy("RVR<125", "tag--stop", mMin==="rvr125", tMin==="rvr125");
  addBy("LVTO<150 QUAL", "tag--warn", mMin==="lvto150", tMin==="lvto150");
  addBy("LVP (<400)", "tag--warn", mMin==="lvp", tMin==="lvp");
  addBy("LVTO (<550)", "tag--lvto", mMin==="lvto", tMin==="lvto");

  // Approach/landing requirement when VIS/CMV < 800m
  addBy("RVR REQ (<800)", "tag--warn", !!omM.rvrRequired, !!omT.rvrRequired);

  // CAT / minima bands (show only below thresholds)
  addBy("CAT3<75", "tag--stop", mCat==="cat3min", tCat==="cat3min");
  addBy("CAT3 ONLY <200", "tag--warn", mCat==="cat3only", tCat==="cat3only");
  addBy("CAT2+ <450", "tag--warn", mCat==="cat2plus", tCat==="cat2plus");

  // Crosswind exceed (label includes limit; METAR and TAF may differ)
  if (omM && omM.xwindExceed && omM.xwindLimitKt){
    push(`XWIND>${omM.xwindLimitKt}KT`, "tag--warn", "M");
  }
  if (omT && omT.xwindExceed && omT.xwindLimitKt){
    if (!(omM && omM.xwindExceed && omM.xwindLimitKt === omT.xwindLimitKt)){
      push(`XWIND>${omT.xwindLimitKt}KT`, "tag--warn", "T");
    }
  }

  // RWYCC policy (estimated): company policy requires RWYCC >=3 unless explicitly upgraded
  addBy("RWYCC<3 likely", "tag--warn", !!omM.noOpsLikely, !!omT.noOpsLikely);

  // Volcanic ash
  addBy("VA", "tag--stop", !!omM.va, !!omT.va);

  // Cold temp correction flag (METAR only)
  if (omM && omM.coldcorr) push("COLD CORR", "tag--warn", "M");

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
  addBy("TS/CB", "tag--wx", (mhz.ts || mhz.cb), (thz.ts || thz.cb));
  addBy("FZFG", "tag--wx", mhz.fzfg, thz.fzfg);
  addBy("FG", "tag--wx", mhz.fg, thz.fg);
  addBy("BR", "tag--wx", mhz.br, thz.br);
  addBy("SN", "tag--wx", mhz.sn, thz.sn);
  addBy("RA", "tag--wx", mhz.ra, thz.ra);

  // ENG ICE OPS tag: show source METAR (M) by design
  if (engIceOps){
    triggers.unshift({label:"ENG ICE OPS", cls:"tag--eng", src:"M"});
  }

  
  

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
          <div class="airport__iata${st.isBase ? " is-base" : ""}">${escapeHtml((st.iata||"—").toUpperCase())}</div>
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

      // Tiles (NOW / METAR)
      case "met_crit": if (!((st.met && typeof st.met.score === "number" && st.met.score >= 70))) return false; break;
      case "alert_crit": if (!(st.alert === "CRIT")) return false; break;
      case "met_vis300": {
        const v = (st.met ? st.met.vis : null);
        const r = (st.met ? st.met.rvrMin : null);
        if (!((v !== null && v < 300) || (r !== null && r < 300))) return false;
      } break;
      case "met_ts": if (!(st.met && st.met.hz && st.met.hz.ts)) return false; break;
      case "met_wind25": if (!((st.met && st.met.gustMax !== null && st.met.gustMax >= 25))) return false; break;
      case "met_snow": if (!(st.met && st.met.hz && st.met.hz.sn)) return false; break;
      case "met_toProhib": if (!(st.omMet && st.omMet.toProhib)) return false; break;
      case "met_lvto": if (!(st.omMet && st.omMet.lvto)) return false; break;
      case "met_xwind": if (!(st.omMet && st.omMet.xwindExceed)) return false; break;
      case "met_va": if (!(st.omMet && st.omMet.va)) return false; break;

      // Tiles (FORECAST / TAF)
      case "taf_any": {
        const v = st.tafWorstVis;
        const r = (st.taf ? st.taf.rvrMin : null);
        const any = ((st.taf && st.taf.score >= 70) || ((v !== null && v < 300) || (r !== null && r < 300)) || (st.taf && st.taf.hz && (st.taf.hz.ts || st.taf.hz.sn)) || (st.taf && st.taf.gustMax !== null && st.taf.gustMax >= 25) || (st.omTaf && (st.omTaf.toProhib || st.omTaf.lvto || st.omTaf.va)));
        if (!any) return false;
      } break;
      case "taf_crit": if (!(st.taf && st.taf.score >= 70)) return false; break;
      case "taf_vis300": {
        const v = st.tafWorstVis;
        const r = (st.taf ? st.taf.rvrMin : null);
        if (!((v !== null && v < 300) || (r !== null && r < 300))) return false;
      } break;
      case "taf_ts": if (!(st.taf && st.taf.hz && st.taf.hz.ts)) return false; break;
      case "taf_wind25": if (!((st.taf && st.taf.gustMax !== null && st.taf.gustMax >= 25))) return false; break;
      case "taf_snow": if (!(st.taf && st.taf.hz && st.taf.hz.sn)) return false; break;
      case "taf_toProhib": if (!(st.omTaf && st.omTaf.toProhib)) return false; break;
      case "taf_lvto": if (!(st.omTaf && st.omTaf.lvto)) return false; break;
      case "taf_va": if (!(st.omTaf && st.omTaf.va)) return false; break;


      // Policy (union of METAR/TAF-derived OM flags; advisory)
      case "toProhib": if (!((st.omMet && st.omMet.toProhib) || (st.omTaf && st.omTaf.toProhib))) return false; break;
      case "lvto": if (!((st.omMet && st.omMet.lvto) || (st.omTaf && st.omTaf.lvto))) return false; break;
      case "lvp": if (!((st.omMet && st.omMet.lvp) || (st.omTaf && st.omTaf.lvp))) return false; break;
      case "rvr125": if (!((st.omMet && st.omMet.rvr125) || (st.omTaf && st.omTaf.rvr125))) return false; break;
      case "xwind": if (!((st.omMet && st.omMet.xwindExceed) || (st.omTaf && st.omTaf.xwindExceed))) return false; break;
      case "va": if (!((st.omMet && st.omMet.va) || (st.omTaf && st.omTaf.va))) return false; break;
      case "coldcorr": if (!(st.omMet && st.omMet.coldcorr)) return false; break;


      case "vis800": if (!(st.worstVis !== null && st.worstVis <= 800)) return false; break;
      case "vis550": if (!(st.worstVis !== null && st.worstVis <= 550)) return false; break;
      case "vis500": if (!(st.worstVis !== null && st.worstVis <= 500)) return false; break;
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
      
case "oma_to_prohib":
  if (!((st.omMet && st.omMet.toProhib) || (st.omTaf && st.omTaf.toProhib))) return false;
  break;
case "oma_ts_prohib":
  if (!((st.omMet && st.omMet.tsOrCb) || (st.omTaf && st.omTaf.tsOrCb))) return false;
  break;
case "oma_lvto":
  if (!((st.omMet && st.omMet.lvto) || (st.omTaf && st.omTaf.lvto))) return false;
  break;
case "oma_below_cat1":
  if (!((st.omMet && st.omMet.cat2Plus) || (st.omTaf && st.omTaf.cat2Plus))) return false;
  break;
case "oma_va":
  if (!((st.omMet && st.omMet.va) || (st.omTaf && st.omTaf.va))) return false;
  break;
case "oma_cold":
  if (!(st.omMet && st.omMet.coldcorr)) return false;
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

function computeTileLists(list){
  const metEng = list.filter(s=>s.engIceOps);
  const metCrit = list.filter(s=> (s.met && typeof s.met.score === "number" && s.met.score >= 70));
  const alertCrit = list.filter(s=> (s.alert === "CRIT"));
  const metVis300 = list.filter(s=> ((s.met && s.met.vis !== null && s.met.vis < 300) || (s.met && s.met.rvrMin !== null && s.met.rvrMin < 300)));
  const metTs = list.filter(s=>s.met && s.met.hz && s.met.hz.ts);
  const metWind = list.filter(s=> (s.met && s.met.gustMax !== null && s.met.gustMax >= 25));
  const metSnow = list.filter(s=>s.met && s.met.hz && s.met.hz.sn);
  const metToProhib = list.filter(s=>s.omMet && s.omMet.toProhib);
  const metLvto = list.filter(s=>s.omMet && s.omMet.lvto);
  const metXwind = list.filter(s=>s.omMet && s.omMet.xwindExceed);
  const metVa = list.filter(s=>s.omMet && s.omMet.va);

  const tafCrit = list.filter(s=> (s.taf && typeof s.taf.score === "number" && s.taf.score >= 70));
  const tafVis300 = list.filter(s=> ((s.tafWorstVis !== null && s.tafWorstVis < 300) || (s.taf && s.taf.rvrMin !== null && s.taf.rvrMin < 300)));
  const tafTs = list.filter(s=>s.taf && s.taf.hz && s.taf.hz.ts);
  const tafWind = list.filter(s=> (s.taf && s.taf.gustMax !== null && s.taf.gustMax >= 25));
  const tafSnow = list.filter(s=>s.taf && s.taf.hz && s.taf.hz.sn);
  const tafToProhib = list.filter(s=>s.omTaf && s.omTaf.toProhib);
  const tafLvto = list.filter(s=>s.omTaf && s.omTaf.lvto);
  const tafVa = list.filter(s=>s.omTaf && s.omTaf.va);

  const metAny = list.filter(s=>
    s.engIceOps ||
    (s.met && s.met.score >= 70) ||
    ((s.met && s.met.vis !== null && s.met.vis < 300) || (s.met && s.met.rvrMin !== null && s.met.rvrMin < 300)) ||
    (s.met && s.met.hz && (s.met.hz.ts || s.met.hz.sn)) ||
    (s.met && s.met.gustMax !== null && s.met.gustMax >= 25) ||
    (s.omMet && (s.omMet.toProhib || s.omMet.lvto || s.omMet.xwindExceed || s.omMet.va))
  );

  const tafAny = list.filter(s=>
    (s.taf && s.taf.score >= 70) ||
    ((s.tafWorstVis !== null && s.tafWorstVis < 300) || (s.taf && s.taf.rvrMin !== null && s.taf.rvrMin < 300)) ||
    (s.taf && s.taf.hz && (s.taf.hz.ts || s.taf.hz.sn)) ||
    (s.taf && s.taf.gustMax !== null && s.taf.gustMax >= 25) ||
    (s.omTaf && (s.omTaf.toProhib || s.omTaf.lvto || s.omTaf.va))
  );

  return {
    met:{eng:metEng, crit:metCrit, alertCrit:alertCrit, vis300:metVis300, ts:metTs, wind:metWind, snow:metSnow, toProhib:metToProhib, lvto:metLvto, xwind:metXwind, va:metVa, any:metAny},
    taf:{crit:tafCrit, vis300:tafVis300, ts:tafTs, wind:tafWind, snow:tafSnow, toProhib:tafToProhib, lvto:tafLvto, va:tafVa, any:tafAny}
  };
}

function listToIcaoSet(arr){
  const s = new Set();
  for (const x of (arr || [])) if (x && x.icao) s.add(String(x.icao).toUpperCase());
  return s;
}
function diffSet(a,b){
  const out = new Set();
  for (const v of a){
    if (!b || !b.has(v)) out.add(v);
  }
  return out;
}

function updateTiles(currentList){
  const t = computeTileLists(currentList);

  const setIf = (id,val)=>{ const el=document.getElementById(id); if (el) el.textContent=String(val); };

  // NOW (METAR-priority) tiles
  setIf("tileEngCount", t.met.eng.length);
  setIf("tileCritCount", t.met.crit.length);
  setIf("tileAlertCritCount", t.met.alertCrit.length);
  setIf("tileVis300Count", t.met.vis300.length);
  setIf("tileTsCount", t.met.ts.length);
  setIf("tileWindCount", t.met.wind.length);
  setIf("tileSnowCount", t.met.snow.length);

  setIf("tileToProhibCount", t.met.toProhib.length);
  setIf("tileLvtoCount", t.met.lvto.length);
  setIf("tileXwindCount", t.met.xwind.length);
  setIf("tileVACount", t.met.va.length);

  // FORECAST (TAF) tiles + summary
  setIf("tileTafAnyCount", t.taf.any.length);
  setIf("tileTafCritCount", t.taf.crit.length);
  setIf("tileTafVis300Count", t.taf.vis300.length);
  setIf("tileTafTsCount", t.taf.ts.length);
  setIf("tileTafWindCount", t.taf.wind.length);
  setIf("tileTafSnowCount", t.taf.snow.length);
  setIf("tileTafToProhibCount", t.taf.toProhib.length);
  setIf("tileTafLvtoCount", t.taf.lvto.length);
  setIf("tileTafVACount", t.taf.va.length);

  // keep the summary subtitle in sync with the panel state
  applyTafPanelState();

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
      .sort((a,b)=> (a.rr-b.rr) || a.code.localeCompare(b.code))
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
      shown.map(x=>{
        const base = isBaseCode(x);
        const cls = base ? "iata-chip iata-chip--base" : "iata-chip";
        return `<span class="${cls}">${escapeHtml(x)}</span>`;
      }).join("") +
      (rest > 0 ? `<span class="iata-chip iata-chip--more">+${rest}</span>` : "");
  }

  renderIata("tileEngIata", t.met.eng);
  renderIata("tileCritIata", t.met.crit);
  renderIata("tileAlertCritIata", t.met.alertCrit);
  renderIata("tileVis300Iata", t.met.vis300);
  renderIata("tileTsIata", t.met.ts);
  renderIata("tileWindIata", t.met.wind);
  renderIata("tileSnowIata", t.met.snow);

  renderIata("tileToProhibIata", t.met.toProhib);
  renderIata("tileLvtoIata", t.met.lvto);
  renderIata("tileXwindIata", t.met.xwind);
  renderIata("tileVAIata", t.met.va);

  renderIata("tileTafAnyIata", t.taf.any);
  renderIata("tileTafCritIata", t.taf.crit);
  renderIata("tileTafVis300Iata", t.taf.vis300);
  renderIata("tileTafTsIata", t.taf.ts);
  renderIata("tileTafWindIata", t.taf.wind);
  renderIata("tileTafSnowIata", t.taf.snow);
  renderIata("tileTafToProhibIata", t.taf.toProhib);
  renderIata("tileTafLvtoIata", t.taf.lvto);
  renderIata("tileTafVAIata", t.taf.va);
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


function formatRvrGroupList(groups){
  if (!Array.isArray(groups) || !groups.length) return "";
  return groups.map(g=>{
    const q1 = g.q1 ? g.q1 : "";
    const v1 = Number.isFinite(g.v1) ? String(g.v1).padStart(4,"0") : "----";
    const a = `R${g.rwy||"--"}/${q1}${v1}`;
    if (Number.isFinite(g.v2)){
      const q2 = g.q2 ? g.q2 : "";
      const v2 = String(g.v2).padStart(4,"0");
      return `${a}V${q2}${v2}${g.trend||""}`;
    }
    return `${a}${g.trend||""}`;
  }).join(", ");
}

function omMinBand(om){
  if (!om) return null;
  if (om.rvr125) return "rvr125";
  if (om.lvtoQualReq) return "lvto150";
  if (om.lvp) return "lvp";
  if (om.lvto) return "lvto";
  return null;
}
function omCatBand(om){
  if (!om) return null;
  if (om.cat3BelowMin) return "cat3min";
  if (om.cat3Only) return "cat3only";
  if (om.cat2Plus) return "cat2plus";
  return null;
}

function renderOmExplainHtml(st){
  const m = st && st.omMet ? st.omMet : {};
  const t = st && st.omTaf ? st.omTaf : {};
  const mx = m.explain || {};
  const tx = t.explain || {};

  function srcPill(s){
    return `<span class="tag tag--src">${s}</span>`;
  }

  function line(src, html){
    return `<div class="omx__line">${srcPill(src)} <span>${html}</span></div>`;
  }

  function code(x){
    return `<code>${escapeHtml(String(x))}</code>`;
  }

  const items = [];

  function addItem(title, linesArr){
    if (!linesArr.length) return;
    items.push(
      `<div class="omx__item">`+
        `<div class="omx__t"><span>${escapeHtml(title)}</span></div>`+
        `<div class="omx__lines">`+linesArr.join("")+`</div>`+
      `</div>`
    );
  }

  // TO PROHIB (OM-A 8.3.8.7)
  {
    const lines = [];
    if (m.toProhib){
      const mm = (mx.heavyMatches && mx.heavyMatches.length) ? mx.heavyMatches.join(", ") : "—";
      lines.push(line("M", `Matched heavy precip: ${code(mm)} (OM-A 8.3.8.7)`));
    }
    if (t.toProhib){
      const tm = (tx.heavyMatches && tx.heavyMatches.length) ? tx.heavyMatches.join(", ") : "—";
      lines.push(line("T", `Matched heavy precip: ${code(tm)} (OM-A 8.3.8.7)`));
    }
    addItem("TO PROHIB", lines);
  }

  // Takeoff minima / LVTO / LVP / RVR<125 (hierarchical)
  {
    const lines = [];
    function bandExplain(src, om, x){
      const band = omMinBand(om);
      if (!band) return null;

      const refType = x.refVisType || null;
      const refVal  = (x.refVisValue != null) ? x.refVisValue : null;

      const rvrList = formatRvrGroupList(x.rvrGroups);
      const ref = (refType === "RVR")
        ? `Ref ${code("RVR")} min = ${code(refVal+"m")} from ${code(rvrList || "RVR groups")}`
        : (refType === "VIS")
          ? `Ref ${code("VIS")} = ${code(refVal+"m")} (no RVR used)`
          : `No ref VIS/RVR available`;

      if (band === "rvr125") return `${ref} → below ${code("<125m")} (stop band)`;
      if (band === "lvto150") return `${ref} → below ${code("<150m")} (LVTO crew qual)`;
      if (band === "lvp") return `${ref} → below ${code("<400m")} (LVP)`;
      if (band === "lvto") return `${ref} → below ${code("<550m")} (LVTO)`;
      return null;
    }

    const mTxt = bandExplain("M", m, mx);
    if (mTxt) lines.push(line("M", mTxt));
    const tTxt = bandExplain("T", t, tx);
    if (tTxt) lines.push(line("T", tTxt));
    addItem("TAKEOFF / LVO BAND", lines);
  }

  // RVR reporting required when VIS/CMV < 800m (approach/landing)
  {
    const lines = [];
    if (m.rvrRequired){
      const vis = (mx.worstVis != null) ? mx.worstVis : "—";
      const has = mx.rvrAny ? "yes" : "no";
      lines.push(line("M", `VIS/CMV ${code(vis+"m")} < ${code("800m")} and RVR present? ${code(has)} → RVR required`));
    }
    if (t.rvrRequired){
      const vis = (tx.worstVis != null) ? tx.worstVis : "—";
      const has = tx.rvrAny ? "yes" : "no";
      lines.push(line("T", `VIS/CMV ${code(vis+"m")} < ${code("800m")} and RVR present? ${code(has)} → RVR required`));
    }
    addItem("RVR REQ (<800)", lines);
  }

  // CAT band (hierarchical)
  {
    const lines = [];
    function catExplain(om, x){
      const band = omCatBand(om);
      if (!band) return null;
      const rvr = (x.rvrMinAll != null) ? x.rvrMinAll : null;
      const rvrList = formatRvrGroupList(x.rvrGroups);
      const ref = (rvr != null)
        ? `RVR min ${code(rvr+"m")} from ${code(rvrList || "RVR groups")}`
        : `No RVR available`;

      if (band === "cat3min") return `${ref} → below ${code("<75m")} (very low RVR)`;
      if (band === "cat3only") return `${ref} → below ${code("<200m")} (CAT III environment)`;
      if (band === "cat2plus") return `${ref} → below ${code("<450m")} (CAT II thresholds DH-dependent)`;
      return null;
    }

    const mTxt = catExplain(m, mx);
    if (mTxt) lines.push(line("M", mTxt));
    const tTxt = catExplain(t, tx);
    if (tTxt) lines.push(line("T", tTxt));
    addItem("CAT BAND", lines);
  }

  // RWYCC estimate
  {
    const lines = [];
    function rwyccLine(x){
      const cond = x.runwayCond || {};
      const ev = Array.isArray(cond.evidence) && cond.evidence.length ? cond.evidence.join(", ") : "—";
      return `Inferred ${code(cond.cond || "—")} (RWYCC≈${code(cond.rwyccEst!=null?cond.rwyccEst:"—")}) from wx ${code(ev)} (estimate)`;
    }
    if (m.noOpsLikely) lines.push(line("M", rwyccLine(mx)));
    if (t.noOpsLikely) lines.push(line("T", rwyccLine(tx)));
    addItem("RWYCC<3 LIKELY", lines);
  }

  // Crosswind exceed
  {
    const lines = [];
    function xwindLine(x){
      const wx = x.xwind || {};
      if (!wx.available){
        return `<span class="omx__mut">No runways.json data → crosswind advisory unavailable.</span>`;
      }
      const w = x.wind || {};
      const windTxt = (w.dir!=null && w.usedSpd!=null)
        ? `Wind ${code(w.dir+"°")} at ${code(w.usedSpd+"kt")}${(w.gst!=null && w.gst>w.spd)?` (gust ${code(w.gst+"kt")})`:""}`
        : `Wind ${code("—")}`;
      const rwyTxt = (wx.runwayHdg!=null)
        ? `Best runway hdg ${code(wx.runwayHdg)}${wx.runwayName?` (${code(wx.runwayName)})`:""}`
        : `Runway ${code("—")}`;
      const xw = (wx.xwindKt!=null) ? code(wx.xwindKt+"kt") : code("—");
      const lim = (wx.limitKt!=null) ? code(wx.limitKt+"kt") : code("—");
      const narrow = wx.narrow ? "narrow runway limit applied" : "standard limit";
      return `${windTxt}; ${rwyTxt}; XWIND ${xw} > limit ${lim} (${escapeHtml(narrow)}).`;
    }
    if (m.xwindExceed) lines.push(line("M", xwindLine(mx)));
    if (t.xwindExceed) lines.push(line("T", xwindLine(tx)));
    addItem("XWIND EXCEED", lines);
  }

  // VA
  {
    const lines = [];
    if (m.va) lines.push(line("M", `Token ${code("VA")} detected in raw.`));
    if (t.va) lines.push(line("T", `Token ${code("VA")} detected in raw.`));
    addItem("VA", lines);
  }

  // Cold corrections (METAR only)
  {
    const lines = [];
    if (m.coldcorr){
      const tc = (mx.tempC != null) ? mx.tempC : "—";
      lines.push(line("M", `Temperature ${code(tc+"°C")} ≤ 0 → cold temperature corrections may apply (OM-A tables).`));
    }
    addItem("COLD CORR", lines);
  }

  if (!items.length){
    return `<div class="omx__mut">No OM policy tags below thresholds for this station.</div>`;
  }
  return items.join("");
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

  // OM tag explanations (audit)
  const omEl = $("dOmExplain");
  if (omEl) omEl.innerHTML = renderOmExplainHtml(st);

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




// --- TV highlight + notifications on new alerts ---------------------------
function showTvToast(title, lines){
  const el = $("tvToast");
  if (!el) return;
  const safeTitle = escapeHtml(title || "NEW ALERT");
  const items = (lines || []).map(x=>`<li>${escapeHtml(x)}</li>`).join("");
  el.innerHTML = `
    <div class="tvToast__h">
      <div>${safeTitle}</div>
      <div class="tvToast__k">${new Date().toISOString().replace('T',' ').slice(0,16)}Z</div>
    </div>
    <div class="tvToast__b"><ul>${items}</ul></div>
  `;
  el.classList.remove("hidden");
  clearTimeout(showTvToast._t);
  showTvToast._t = setTimeout(()=>{ el.classList.add("hidden"); }, 12_000);
}

function flashTiles(keys){
  for (const key of (keys || [])){
    const btn = document.querySelector(`button.tile[data-filter="${CSS.escape(key)}"]`);
    if (!btn) continue;
    btn.classList.add("is-flash");
    setTimeout(()=>btn.classList.remove("is-flash"), 12_000);
  }
}

function fmtCodesFromIcaos(icaos){
  const out = [];
  for (const icao of Array.from(icaos || [])){
    const st = stationMap.get(icao);
    const code = (st && (st.iata || st.icao)) ? String(st.iata || st.icao).toUpperCase() : String(icao).toUpperCase();
    out.push(code);
  }
  out.sort();
  const max = (viewMode === "tv" ? 14 : 8);
  const shown = out.slice(0, max);
  const rest = out.length - shown.length;
  return shown.join(", ") + (rest > 0 ? ` +${rest}` : "");
}

function signalNewAlerts(fullList){
  // fullList must be the full stations array (not filtered).
  const t = computeTileLists(fullList);

  // METAR "new report" detection based on DDHHMMZ group
  const obsNow = new Map();
  for (const st of fullList){
    obsNow.set(st.icao, metarObsKeyFromRaw(st.metarRaw || ""));
  }
  let newMetar = false;
  if (prevMetarObsByIcao && prevMetarObsByIcao.size){
    for (const [icao, obs] of obsNow.entries()){
      const prev = prevMetarObsByIcao.get(icao);
      if (obs && prev && obs !== prev){ newMetar = true; break; }
    }
  }

  // Build sets per tile for delta detection
  const setsNow = {
    met: {
      eng: listToIcaoSet(t.met.eng),
      metCrit: listToIcaoSet(t.met.crit),
      alertCrit: listToIcaoSet(t.met.alertCrit),
      vis: listToIcaoSet(t.met.vis300),
      ts: listToIcaoSet(t.met.ts),
      wind: listToIcaoSet(t.met.wind),
      snow: listToIcaoSet(t.met.snow),
      toProhib: listToIcaoSet(t.met.toProhib),
      lvto: listToIcaoSet(t.met.lvto),
      xwind: listToIcaoSet(t.met.xwind),
      va: listToIcaoSet(t.met.va),
      any: listToIcaoSet(t.met.any),
    },
    taf: {
      crit: listToIcaoSet(t.taf.crit),
      vis: listToIcaoSet(t.taf.vis300),
      ts: listToIcaoSet(t.taf.ts),
      wind: listToIcaoSet(t.taf.wind),
      snow: listToIcaoSet(t.taf.snow),
      toProhib: listToIcaoSet(t.taf.toProhib),
      lvto: listToIcaoSet(t.taf.lvto),
      va: listToIcaoSet(t.taf.va),
      any: listToIcaoSet(t.taf.any),
    }
  };

  // First run: just store baselines, no alerts.
  if (!prevSignalSets){
    prevSignalSets = setsNow;
    prevMetarObsByIcao = obsNow;
    return;
  }

  // AUTO view: show browser notifications only when a NEW BASE appears among impacted NOW-tile set, and ONLY on new METAR.
  if (viewMode === "auto" && notifEnabled && newMetar){
    const basesNow = new Set();
    for (const icao of setsNow.met.any){
      const st = stationMap.get(icao);
      if (!st) continue;
      if (st.role === "BASE" || isBaseCode(st.iata)) basesNow.add(icao);
    }
    const basesPrev = prevSignalSets.met.any ? new Set(Array.from(prevSignalSets.met.any).filter(icao=>{
      const st = stationMap.get(icao);
      return st && (st.role === "BASE" || isBaseCode(st.iata));
    })) : new Set();
    const newBases = diffSet(basesNow, basesPrev);
    if (newBases.size){
      const title = "NEW BASE alert (METAR)";
      const body = fmtCodesFromIcaos(newBases);
      try{
        new Notification(title, {body, silent:false});
      }catch(e){}
    }
  }

  // TV view: toast + flash when ANY category gains new entries (NOW or TAF).
  if (viewMode === "tv"){
    const lines = [];
    const flashes = [];

    function check(catKey, key, display, filterKey){
      const nowS = setsNow[catKey][key];
      const prevS = (prevSignalSets && prevSignalSets[catKey]) ? (prevSignalSets[catKey][key] || new Set()) : new Set();
      const add = diffSet(nowS, prevS);
      if (add.size){
        lines.push(`${display}: ${fmtCodesFromIcaos(add)}`);
        if (filterKey) flashes.push(filterKey);
      }
    }

    // NOW (METAR) categories
    check("met","metCrit","METAR CRIT","met_crit");
    check("met","alertCrit","ALERT CRIT","alert_crit");
    check("met","vis","VIS/RVR<300","met_vis300");
    check("met","ts","TS/CB","met_ts");
    check("met","wind","WIND","met_wind25");
    check("met","snow","SNOW","met_snow");
    check("met","toProhib","TO PROHIB","met_toProhib");
    check("met","lvto","LVTO","met_lvto");
    check("met","xwind","XWIND","met_xwind");
    check("met","va","VA","met_va");
    // ENG tile uses its legacy filter key "eng" in HTML? (we kept tile ENG as "eng")
    const addEng = diffSet(setsNow.met.eng, prevSignalSets.met.eng || new Set());
    if (addEng.size){
      lines.push(`ENG: ${fmtCodesFromIcaos(addEng)}`);
      flashes.push("eng");
    }

    // TAF categories (only if panel exists)
    check("taf","crit","TAF CRIT","taf_crit");
    check("taf","vis","TAF VIS/RVR<300","taf_vis300");
    check("taf","ts","TAF TS/CB","taf_ts");
    check("taf","wind","TAF WIND","taf_wind25");
    check("taf","snow","TAF SNOW","taf_snow");
    check("taf","toProhib","TAF TO PROHIB","taf_toProhib");
    check("taf","lvto","TAF LVTO","taf_lvto");
    check("taf","va","TAF VA","taf_va");

    if (lines.length){
      showTvToast("NEW ALERTS", lines.slice(0, 10));
      flashTiles(flashes);
      // also flash the TAF summary tile if any TAF additions occurred while panel is collapsed
      const tafAdds = diffSet(setsNow.taf.any, prevSignalSets.taf.any || new Set());
      if (tafAdds.size){
        const btn = $("tileTafSummary");
        if (btn){
          btn.classList.add("is-flash");
          setTimeout(()=>btn.classList.remove("is-flash"), 12_000);
        }
      }
    }
  }

  prevSignalSets = setsNow;
  prevMetarObsByIcao = obsNow;
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
  })).filter(s=>s.icao && s.icao.length===4)
    .map(deriveStation)
    .map(st=>{
      st.isBase = isBaseCode(st.iata);
      st.role = st.isBase ? "BASE" : getRole(st.icao);
      st.roleRank = roleRank(st.role);
      return st;
    });

  stationMap = new Map(stations.map(s=>[s.icao, s]));

  // NEW alert detection + notifications (uses full list, not filtered)
  try{ signalNewAlerts(stations); }catch(e){ console.error(e); }

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
    await fetchBaseList();
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


// Tile hover tooltips (detailed triggers + OM reference) --------------------
// These are informational aids for users; they do NOT change alert logic.
const TILE_TOOLTIP = {
  eng: {
    title: "ENG ICE OPS",
    om: "OM-A 8.3.8.2 (Icing) · Clean Aircraft Concept",
    why: "Based on icing-related indications, the system highlights that ground de/anti-icing and icing risk may be relevant.",
    triggers: [
      "METAR/TAF: FZFG / FZRA / FZDZ",
      "METAR/TAF: SN / PL / GS / SG",
      "METAR/TAF: icing-related keywords / remarks (when present)",
    ],
  },
  crit: {
    title: "CRITICAL",
    om: "Internal severity score (dashboard policy layer)",
    why: "Composite severity state. Multiple hazards and/or minima-adjacent values can elevate the overall state to CRIT.",
    triggers: [
      "Score ≥ 70",
      "Multiple reinforcing hazards at the same time",
    ],
  },
  vis300: {
    title: "VIS/RVR < 300",
    om: "OM-A 8.1.4 (CAT II minima: RVR ≥ 300m)",
    why: "The system uses the worst-case VIS/RVR computed from METAR and TAF. Dropping below 300 m indicates a below CAT II band situation.",
    triggers: [
      "Worst VIS < 300 m (METAR/TAF)",
      "or RVRmin < 300 m (METAR/TAF)",
    ],
  },
  ts: {
    title: "TS / CB",
    om: "OM-A 8.3.8.1 (Thunderstorms avoidance)",
    why: "Thunderstorm/CB indication in reports. Company policy is avoidance; overhead/approaching may require delay/hold/diversion per SOP and operational judgment.",
    triggers: [
      "METAR/TAF: TS",
      "METAR/TAF: CB (when reported)",
    ],
  },
  wind: {
    title: "WIND",
    om: "OM-B 1.3.1 (Crosswind limits) · advisory tile",
    why: "Highlights significant gusts. This tile is advisory (gust threshold); the XWIND tile estimates crosswind component.",
    triggers: ["GUST ≥ 25 kt (METAR or TAF)"]
  },
  snow: {
    title: "SNOW",
    om: "OM-A 8.3.8.7 (Heavy precipitation - takeoff prohibited)",
    why: "Snow-related weather codes are present in METAR/TAF. Specific prohibitive cases (+SN, +GS, +SG, +PL, +FZRA, GR) are shown under the TO PROHIB tile.",
    triggers: [
      "METAR: SN or related snow phenomena",
      "TAF: SN or related snow phenomena",
    ],
  },
  toProhib: {
    title: "TO PROHIB",
    om: "OM-A 8.3.8.1 (TS) · OM-A 8.3.8.7 (Heavy precip)",
    why: "The policy layer flags weather elements that can prohibit take-off per OM guidance. Advisory: the operational decision remains per SOP and actual conditions.",
    triggers: [
      "TS overhead/approaching (derived from METAR/TAF)",
      "Heavy snow: +SN",
      "Moderate/heavy freezing rain: FZRA / +FZRA",
      "Hail: GR / +GR",
      "Ice pellets / snow pellets / grains: PL / GS / SG (especially +)",
    ],
  },
  lvto: {
    title: "LVTO",
    om: "OM-A 8.1.4.4 (Take-off minima) · LVP if RVR < 400m",
    why: "Low Visibility Take-off indication when worst VIS/RVR drops below 550 m. Below 400 m, LVP must be in force.",
    triggers: [
      "RVR/VIS < 550 m",
      "(LVP required if RVR < 400 m)",
    ],
  },
  xwind: {
    title: "XWIND",
    om: "OM-B 1.3.1 (Crosswind limitations)",
    why: "Without runway heading, crosswind is approximated using a best-runway estimation. Advisory: actual limits depend on runway/condition/width.",
    triggers: [
      "Estimated crosswind exceeds company limits (conservative without RWY condition)",
      "Gust is included (company limits include gusts)",
    ],
  },
  va: {
    title: "VA",
    om: "OM-A 8.3.8.6 (Volcanic ash)",
    why: "Volcanic ash (VA) indication in reports. Medium/High contamination must be avoided; visible ash cloud avoidance is mandatory.",
    triggers: ["METAR/TAF: VA / volcanic ash indication"]
  },
};

// Extra tooltip mappings for METAR-priority and TAF forecast tiles
TILE_TOOLTIP.met_crit = {
  title: "METAR CRIT",
  om: "Internal severity score (METAR)",
  why: "Shows stations where the METAR-only severity score reaches the CRITICAL band (score ≥ 70). This is based only on the current observed METAR conditions.",
  triggers: ["METAR score ≥ 70"]
};
TILE_TOOLTIP.alert_crit = {
  title: "ALERT CRIT (overall)",
  om: "Overall alert level (NOW + FORECAST + escalation)",
  why: "Matches the Alert pill in the table. Overall alert can be CRITICAL even if the METAR score is below 70, because it can be driven by TAF forecast risk and/or pillar escalation logic (e.g., SNOW/WIND/ENG ICE OPS). Use this tile to answer: 'Which stations are operationally CRIT overall?'.",
  triggers: ["Alert level = CRIT (combined NOW + FORECAST + escalation)"]
};

TILE_TOOLTIP.met_vis300 = {title:"VIS/RVR < 300 (METAR)", om:"OM-A 8.1.4 (CAT II minima: RVR ≥ 300m)", why:"METAR-only (current) visibility/RVR banding.", triggers:["METAR VIS < 300 m", "or METAR RVRmin < 300 m"]};
TILE_TOOLTIP.met_ts = {title:"TS / CB (METAR)", om:"OM-A 8.3.8.1 (Thunderstorms)", why:"Current report (METAR) indicates TS.", triggers:["METAR: TS"]};
TILE_TOOLTIP.met_wind25 = {title:"WIND (METAR)", om:"Advisory", why:"Current gust threshold (METAR).", triggers:["METAR GUST ≥ 25 kt"]};
TILE_TOOLTIP.met_snow = {title:"SNOW (METAR)", om:"Advisory", why:"Current snow signals (METAR).", triggers:["METAR: SN / snow-related"]};
TILE_TOOLTIP.met_toProhib = {title:"TO PROHIB (METAR)", om:"OM-A 8.3.8.1/8.3.8.7", why:"METAR-only prohibitive WX flags.", triggers:["TS", "+SN", "FZRA/+FZRA", "GR", "PL/GS/SG"]};
TILE_TOOLTIP.met_lvto = {title:"LVTO (METAR)", om:"OM-A 8.1.4.4", why:"METAR-only LVTO band.", triggers:["RVR/VIS < 550 m"]};
TILE_TOOLTIP.met_xwind = {title:"XWIND (METAR)", om:"OM-B 1.3.1", why:"Crosswind estimate using METAR wind.", triggers:["Estimated XWIND exceeds limit"]};
TILE_TOOLTIP.met_va = {title:"VA (METAR)", om:"OM-A 8.3.8.6", why:"Volcanic ash indicated in METAR.", triggers:["METAR: VA"]};
TILE_TOOLTIP.taf_any = {title:"FORECAST (TAF)", om:"TAF-driven tiles", why:"Summary of forecast-driven (TAF) alerts.", triggers:["Any TAF tile is triggered"]};
TILE_TOOLTIP.taf_crit = {title:"CRITICAL (TAF)", om:"Internal severity score (TAF)", why:"Forecast (TAF) severity band.", triggers:["TAF score ≥ 70"]};
TILE_TOOLTIP.taf_vis300 = {title:"VIS/RVR < 300 (TAF)", om:"OM-A 8.1.4", why:"Worst visibility/RVR within the TAF.", triggers:["TAF worst VIS < 300 m", "or TAF RVRmin < 300 m"]};
TILE_TOOLTIP.taf_ts = {title:"TS / CB (TAF)", om:"OM-A 8.3.8.1", why:"Forecast indicates TS.", triggers:["TAF: TS"]};
TILE_TOOLTIP.taf_wind25 = {title:"WIND (TAF)", om:"Advisory", why:"Forecast gust threshold.", triggers:["TAF GUST ≥ 25 kt"]};
TILE_TOOLTIP.taf_snow = {title:"SNOW (TAF)", om:"Advisory", why:"Forecast snow signals.", triggers:["TAF: SN"]};
TILE_TOOLTIP.taf_toProhib = {title:"TO PROHIB (TAF)", om:"OM-A 8.3.8.1/8.3.8.7", why:"Forecast prohibitive WX flags.", triggers:["TS", "+SN", "FZRA/+FZRA", "GR", "PL/GS/SG"]};
TILE_TOOLTIP.taf_lvto = {title:"LVTO (TAF)", om:"OM-A 8.1.4.4", why:"Forecast LVTO band.", triggers:["RVR/VIS < 550 m"]};
TILE_TOOLTIP.taf_va = {title:"VA (TAF)", om:"OM-A 8.3.8.6", why:"Forecast VA indication.", triggers:["TAF: VA"]};

let tileTipEl = null;
function ensureTileTip(){
  if (tileTipEl) return tileTipEl;
  const el = document.createElement("div");
  el.className = "tile-tip";
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  tileTipEl = el;
  return el;
}

function showTileTip(key, x, y){
  const info = TILE_TOOLTIP[key];
  if (!info) return;
  const el = ensureTileTip();
  const trig = (info.triggers || []).map(t=>`<li>${escapeHtml(t)}</li>`).join("");
  el.innerHTML = `
    <div class="tile-tip__h">
      <div class="tile-tip__t">${escapeHtml(info.title)}</div>
    </div>
    ${info.why ? `<div class="tile-tip__b">${escapeHtml(info.why)}</div>` : ""}
    <div class="tile-tip__k">Trigger</div>
    <ul class="tile-tip__ul">${trig}</ul>
    <div class="tile-tip__k">OM reference</div>
    <div class="tile-tip__om">${escapeHtml(info.om || "—")}</div>
  `;

  const pad = 14;
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  el.style.left = "0px";
  el.style.top = "0px";
  el.classList.add("is-on");
  const r = el.getBoundingClientRect();
  let left = x + 14;
  let top = y + 14;
  if (left + r.width + pad > vw) left = vw - r.width - pad;
  if (top + r.height + pad > vh) top = vh - r.height - pad;
  if (left < pad) left = pad;
  if (top < pad) top = pad;
  el.style.left = left + "px";
  el.style.top = top + "px";
}

function hideTileTip(){
  if (!tileTipEl) return;
  tileTipEl.classList.remove("is-on");
}

function initTileTooltips(){
  // Avoid hover tooltips on touch devices
  const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  const roots = [document.getElementById("tiles"), document.getElementById("tilesTaf")].filter(Boolean);
  if (!roots.length || coarse) return;

  roots.forEach(root=>{
    root.querySelectorAll("button.tile[data-filter]").forEach(btn=>{
      const key = btn.getAttribute("data-filter");
      if (!key || !TILE_TOOLTIP[key]) return;
      btn.addEventListener("mouseenter", (e)=>{ showTileTip(key, e.clientX, e.clientY); });
      btn.addEventListener("mousemove", (e)=>{ showTileTip(key, e.clientX, e.clientY); });
      btn.addEventListener("mouseleave", hideTileTip);
      btn.addEventListener("focus", ()=>{
        const r = btn.getBoundingClientRect();
        showTileTip(key, r.left + r.width/2, r.top);
      });
      btn.addEventListener("blur", hideTileTip);
    });
  });
}


function bind(){
  $("q").addEventListener("input", (e)=>{ view.q = e.target.value; render(); });
  $("cond").addEventListener("change", (e)=>{ view.cond = e.target.value; render(); });
  $("alert").addEventListener("change", (e)=>{ view.alert = e.target.value; render(); });
  $("sortPri").addEventListener("change", (e)=>{ view.sortPri = e.target.checked; render(); });
  initViewModeUI();
  initTileTooltips();


initNotifUI();
initTafPanelUI();

// tile filters (NOW + TAF panel)
function handleTileClick(e){
  const btn = e.target.closest("button.tile");
  if (!btn) return;

  if (btn.id === "tileReset"){
    view.q=""; view.cond="all"; view.alert="all"; view.sortPri=true;
    $("q").value=""; $("cond").value="all"; $("alert").value="all"; $("sortPri").checked=true;
    render();
    return;
  }
  if (btn.id === "tileTafSummary"){
    toggleTafPanel();
    return;
  }

  const f = btn.getAttribute("data-filter");
  if (!f) return;

  // toggle: clicking same filter again resets to all
  view.cond = (view.cond === f ? "all" : f);
  $("cond").value = view.cond;
  render();
}
$("tiles").addEventListener("click", handleTileClick);
const tafRoot = $("tilesTaf");
if (tafRoot) tafRoot.addEventListener("click", handleTileClick);

$("drawerClose")
.addEventListener("click", closeDrawer);
  $("scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown",(e)=>{ if (e.key==="Escape") closeDrawer(); });

  // Hide tooltip when scrolling (prevents odd positioning if user scrolls while hovering)
  document.addEventListener("scroll", hideTileTip, {passive:true});

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