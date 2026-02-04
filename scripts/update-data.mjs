/* Node 20+ script run by GitHub Actions.
   - Reads airports.txt (ICAO list)
   - Builds ICAO -> IATA mapping from OurAirports airports.csv
   - Fetches METAR + TAF from aviationweather.gov
   - Computes severity and produces highlighted HTML snippets
   - Writes data/latest.json

   IMPORTANT:
   This avoids browser CORS issues with aviationweather.gov by running server-side.
*/

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = process.cwd();
const AIRPORTS_TXT = path.join(ROOT, 'airports.txt');
const BASE_TXT = path.join(ROOT, 'base.txt');
const OUT_LATEST = path.join(ROOT, 'data', 'latest.json');
const OUT_IATA_MAP = path.join(ROOT, 'data', 'iata_map.json');
const OUT_STATUS = path.join(ROOT, 'data', 'status.json');
const OUT_RUNWAYS = path.join(ROOT, 'data', 'runways.json');
const OUT_BRIEF = path.join(ROOT, 'data', 'management_brief.json');
const OUT_CHANGES = path.join(ROOT, 'data', 'changes.json');
const OUT_SCHEMA_DEBUG = path.join(ROOT, 'data', 'schema_debug.json');

// --- Thin-client precompute -------------------------------------------------
// Precompute parsing + trigger logic server-side so the browser client can render
// with minimal computation (stable TV view, less CPU, fewer reflows).

const VIS_THRESHOLDS = [800, 550, 500, 300, 250, 175, 150];
const RVR_THRESHOLDS = [500, 300, 200, 75];
const ALERT_LEVEL = { OK:0, MED:1, HIGH:2, CRIT:3 };

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
    if ((ALERT_LEVEL[a]||0) > (ALERT_LEVEL[best]||0)) best = a;
  }
  return best;
}

function escapeHtmlThin(s){
  return String(s||"")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/\"/g,"&quot;")
    .replace(/'/g,"&#39;");
}

// --- Schema normalization helpers -------------------------------------------
// The API / pipeline must always write string raw fields and safe scalar display fields.
// This prevents frontend crashes and keeps data/latest.json "clean".

function rawToString(v){
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Common patterns: { raw:"..." } / { text:"..." } / { metar:"..." }
  if (typeof v === "object"){
    for (const k of ["raw","text","metar","taf","value","data"]){
      const x = v?.[k];
      if (typeof x === "string") return x;
    }
    // If we can't confidently extract an actual raw report string,
    // prefer an empty string ("missing") over serializing objects.
    // This keeps latest.json clean and prevents ugly [object Object] renders.
    return "";
  }
  return String(v);
}

function optStringOrNull(v){
  const s = rawToString(v).trim();
  return s ? s : null;
}

function ensureArrayOfStrings(v){
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x=>rawToString(x)).filter(Boolean);
  // if single string/object provided
  const s = rawToString(v).trim();
  return s ? [s] : [];
}

function schemaProbeStation(st){
  // Returns list of schema issues for a station object.
  const issues = [];
  const mustStr = ["icao"];
  const rawStr = ["metarRaw","tafRaw","updatedAt"];
  for (const k of mustStr){
    if (typeof st[k] !== "string") issues.push(`${k} type=${typeof st[k]}`);
  }
  for (const k of rawStr){
    if (st[k] != null && typeof st[k] !== "string") issues.push(`${k} type=${typeof st[k]}`);
  }
  if (st.iata != null && typeof st.iata !== "string") issues.push(`iata type=${typeof st.iata}`);
  if (st.name != null && typeof st.name !== "string") issues.push(`name type=${typeof st.name}`);
  // Common computed strings
  for (const k of ["alert","critSrc"]){
    if (st[k] != null && typeof st[k] !== "string") issues.push(`${k} type=${typeof st[k]}`);
  }

  // Minima explain blocks are expected to be either null or an object with a string `.tip`.
  // (Earlier UI issues were caused by treating the whole object as a string.)
  for (const k of ["minExplainMet","minExplainTaf"]){
    const ex = st[k];
    if (ex == null) continue;
    if (typeof ex !== "object"){
      issues.push(`${k} type=${typeof ex}`);
      continue;
    }
    if (ex.tip != null && typeof ex.tip !== "string") issues.push(`${k}.tip type=${typeof ex.tip}`);
    if (ex.mode != null && typeof ex.mode !== "string") issues.push(`${k}.mode type=${typeof ex.mode}`);
  }
  // triggers must be an array (object items are expected)
  if (st.triggers != null && !Array.isArray(st.triggers)) issues.push(`triggers not array (${typeof st.triggers})`);
  return issues;
}

function parseTempC(raw){
  const m = String(raw||"").match(/\b(M?\d{1,2})\/(M?\d{1,2})\b/);
  if (!m) return null;
  const v = m[1];
  const n = parseInt(v.replace(/^M/,""),10);
  if (Number.isNaN(n)) return null;
  return v.startsWith("M") ? -n : n;
}

function _parseVisibilityMeters(tok){
  const t = String(tok||"").trim();
  if (!t) return null;
  if (t === "CAVOK") return 10000;
  if (/^\d{4}$/.test(t)) return parseInt(t,10);
  const frac = t.match(/^([0-9]+)\s*\/?\s*([0-9]+)?SM$/i);
  if (frac){
    // XSM or X/YSM
    let mi = parseFloat(frac[1]);
    if (frac[2]) mi = parseInt(frac[1],10)/parseInt(frac[2],10);
    if (!Number.isFinite(mi)) return null;
    return Math.round(mi * 1609.34);
  }
  const m = t.match(/^([0-9]+(?:\.[0-9]+)?)SM$/i);
  if (m){
    const mi = parseFloat(m[1]);
    if (!Number.isFinite(mi)) return null;
    return Math.round(mi*1609.34);
  }
  if (/^\d+\/\d+SM$/i.test(t)){
    const [a,b] = t.replace(/SM/i,"").split("/").map(x=>parseFloat(x));
    if (Number.isFinite(a) && Number.isFinite(b) && b){
      return Math.round((a/b)*1609.34);
    }
  }
  return null;
}

function extractRvrMeters(raw){
  const s = String(raw||"");
  const out = [];
  const re = /\bR(\d{2}[A-Z]?)\/(P|M)?(\d{4})(?:V(P|M)?(\d{4}))?([UDN])?\b/g;
  let m;
  while ((m = re.exec(s)) !== null){
    const v1 = parseInt(m[3],10);
    if (!Number.isNaN(v1)) out.push(v1);
    const v2 = m[5] ? parseInt(m[5],10) : NaN;
    if (!Number.isNaN(v2)) out.push(v2);
  }
  return out;
}

function hazardFlags(raw){
  const s = String(raw||"").toUpperCase();
  const wx = (p)=> new RegExp(`(?:^|[^A-Z])${p}(?:[^A-Z]|$)`).test(s);
  const hasCB = /\bCB\b/.test(s);
  return {
    ts: wx("TS"),
    cb: hasCB,
    fg: wx("FG"),
    fzfg: /FZFG/.test(s),
    br: wx("BR"),
    sn: wx("SN"),
    blsn: /BLSN/.test(s),
    ra: wx("RA") || wx("DZ") || wx("SHRA") || wx("SHDZ"),
    va: wx("VA"),
  };
}

function gustMaxKt(raw){
  const s = String(raw||"");
  // METAR: 18015G25KT, TAF similar
  const m = s.match(/\b\d{3}\d{2,3}G(\d{2,3})KT\b/);
  if (m){
    const g = parseInt(m[1],10);
    return Number.isNaN(g) ? null : g;
  }
  return null;
}

function ceilingFt(raw){
  const s = String(raw||"").toUpperCase();
  if (/\bCAVOK\b/.test(s)) return 5000;
  // Find lowest BKN/OVC/VV layer
  const re = /\b(BKN|OVC|VV)(\d{3})\b/g;
  let m, best = null;
  while ((m = re.exec(s)) !== null){
    const ft = parseInt(m[2],10) * 100;
    if (Number.isNaN(ft)) continue;
    if (best===null || ft < best) best = ft;
  }
  return best;
}

function parseVisibilityMeters(tok){ return _parseVisibilityMeters(tok); }

function extractAllVisibilityMetersFromTAF(raw){
  const s = String(raw||"");
  const out = [];
  if (/\bCAVOK\b/.test(s)) out.push(10000);
  // 4-digit meters (0000..9999) + SM forms
  const toks = s.split(/\s+/).filter(Boolean);
  for (const t of toks){
    if (/^\d{4}$/.test(t)) out.push(parseInt(t,10));
    const v = parseVisibilityMeters(t);
    if (v !== null) out.push(v);
  }
  return out.filter(n=>Number.isFinite(n));
}

function scoreFromVis(vis){
  if (vis===null || vis===undefined) return 0;
  if (vis <= 150) return 80;
  if (vis <= 175) return 72;
  if (vis <= 250) return 60;
  if (vis <= 300) return 52;
  if (vis <= 500) return 40;
  if (vis <= 550) return 32;
  if (vis <= 800) return 20;
  return 0;
}
function scoreFromCig(cig){
  if (cig===null || cig===undefined) return 0;
  if (cig < 200) return 70;
  if (cig < 300) return 60;
  if (cig < 500) return 45;
  if (cig < 800) return 28;
  if (cig < 1000) return 18;
  return 0;
}
function scoreFromGust(g){
  if (!g) return 0;
  if (g >= 40) return 75;
  if (g >= 30) return 55;
  if (g >= 25) return 35;
  return 0;
}
function scoreFromHazards(hz){
  if (!hz) return 0;
  if (hz.va) return 90;
  if (hz.ts || hz.cb) return 55;
  if (hz.fzfg) return 65;
  if (hz.fg) return 35;
  if (hz.sn || hz.blsn) return hz.blsn ? 90 : 40;
  if (hz.ra) return 20;
  if (hz.br) return 18;
  return 0;
}

function computeScores(raw){
  const s = String(raw||"").trim();
  const hz = hazardFlags(s);
  const tempC = parseTempC(s);
  const gustMax = gustMaxKt(s);
  const cig = ceilingFt(s);

  // Visibility: METAR uses 4-digit, TAF can include SM forms too
  let vis = null;
  const vMatch = s.match(/\b(\d{4}|CAVOK)\b/);
  if (vMatch) vis = parseVisibilityMeters(vMatch[1]);
  if (vis === null){
    // try SM token
    const sm = s.match(/\b(P?\d+(?:\.\d+)?SM|\d+\/\d+SM)\b/i);
    if (sm) vis = parseVisibilityMeters(sm[1]);
  }

  const rvr = extractRvrMeters(s);
  const rvrMin = rvr.length ? Math.min(...rvr) : null;

  const score = Math.max(
    scoreFromVis(vis),
    scoreFromCig(cig),
    scoreFromGust(gustMax),
    scoreFromHazards(hz)
  );

  return { raw:s, hz, tempC, gustMax, vis, cig, rvrMin, score };
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

function snippetAround(raw, token, radius=28){
  const s = String(raw||"");
  const i = s.toUpperCase().indexOf(String(token||"").toUpperCase());
  if (i < 0) return "";
  const a = Math.max(0, i-radius);
  const b = Math.min(s.length, i+String(token).length+radius);
  const pref = a>0 ? "…" : "";
  const suf = b<s.length ? "…" : "";
  return pref + s.slice(a,b).trim() + suf;
}

function visTokenForMeters(raw){
  const s = String(raw||"");
  const m = s.match(/\b(\d{4}|CAVOK)\b/);
  if (m) return m[1];
  const sm = s.match(/\b(P?\d+(?:\.\d+)?SM|\d+\/\d+SM)\b/i);
  if (sm) return sm[1];
  return null;
}

function buildMinimaExplain({kind, raw, minima, state, visVal, rvrMin, isTaf}){
  if (!minima || !minima.best || !minima.alt || !state) return null;
  const triggered = !!(state.belowBest || state.onlyBest);
  if (!triggered) return null;
  const mode = state.belowBest ? "CRIT" : "LIMIT";
  const basis = state.belowBest ? "BEST" : "ALT";
  const thr = state.belowBest ? minima.best : minima.alt;
  const effVis = (state.effVis != null) ? state.effVis : null;
  const cig = (state.cig != null) ? state.cig : null;

  const reasons = [];
  const tokens = [];

  if (cig != null && thr.cig_ft != null && cig < thr.cig_ft){
    const token = (()=>{
      const s = String(raw||"").toUpperCase();
      const re = /\b(BKN|OVC|VV)(\d{3})\b/g;
      let m;
      while ((m = re.exec(s)) !== null){
        const ft = parseInt(m[2],10)*100;
        if (ft === cig) return `${m[1]}${m[2]}`;
      }
      return null;
    })();
    if (token){
      tokens.push({token, cls: mode==="CRIT"?"hlStop":"hlWarn"});
    }
    reasons.push({metric:"CIG", actual:cig, threshold:thr.cig_ft, basis, token, snippet: token?snippetAround(raw, token):""});
  }
  if (effVis != null && thr.vis_m != null && effVis < thr.vis_m){
    const token = (rvrMin != null && rvrMin <= effVis) ? null : visTokenForMeters(raw);
    if (token){
      tokens.push({token, cls: mode==="CRIT"?"hlStop":"hlWarn"});
    }
    reasons.push({metric:"VIS/RVR", actual:effVis, threshold:thr.vis_m, basis, token, snippet: token?snippetAround(raw, token):""});
  }
  const tip = `${kind} minima ${mode} (${basis}) · ` + reasons.map(r=>`${r.metric} ${r.actual}<${r.threshold}`).join("; ");
  return { mode, basis, tip, reasons, tokens };
}

function loadOmApi(runwaysMap){
  try{
    const code = fs.readFileSync(path.join(ROOT, "assets", "om_policy.js"), "utf8");
    const sandbox = { window: {}, console };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, {timeout: 500});
    const api = sandbox.window && sandbox.window.WXM_OM;
    if (api && typeof api.computeOmFlags === "function"){
      return (st, met, taf, worstVis, rvrMinAll)=> api.computeOmFlags(st, met, taf, worstVis, rvrMinAll, runwaysMap || null);
    }
  }catch(e){
    // ignore
  }
  return null;
}

function computeDerivedStation(st, omFn){
  const met = computeScores(st.metarRaw || "");
  const taf = computeScores(st.tafRaw || "");

  const worstVis = (() => {
    const vals = [];
    if (met.vis !== null) vals.push(met.vis);
    const tafVals = extractAllVisibilityMetersFromTAF(st.tafRaw || "");
    if (tafVals.length) vals.push(Math.min(...tafVals));
    return vals.length ? Math.min(...vals) : null;
  })();

  const tafWorstVis = (() => {
    const vals = extractAllVisibilityMetersFromTAF(st.tafRaw || "");
    if (vals.length) return Math.min(...vals);
    return (taf.vis !== null) ? taf.vis : null;
  })();

  const metRvrMin = met.rvrMin ?? null;
  const tafRvrMin = taf.rvrMin ?? null;

  const allRvr = [...extractRvrMeters(st.metarRaw || ""), ...extractRvrMeters(st.tafRaw || "")];
  const rvrMinAll = allRvr.length ? Math.min(...allRvr) : null;

  const cigAll = (() => {
    const a = ceilingFt(st.metarRaw || "");
    const b = ceilingFt(st.tafRaw || "");
    if (a === null) return b;
    if (b === null) return a;
    return Math.min(a,b);
  })();

  const minimaNow = (() => {
    const m = st.minima || null;
    if (!m || !m.best || !m.alt) return null;
    const effVis = (()=>{
      const a = (met.vis===null||met.vis===undefined)?Infinity:met.vis;
      const b = (metRvrMin===null||metRvrMin===undefined)?Infinity:metRvrMin;
      const v = Math.min(a,b);
      return (v===Infinity)?null:v;
    })();
    const cig = (met.cig===undefined)?null:met.cig;
    const belowBest = ((cig!==null && m.best.cig_ft!=null && cig < m.best.cig_ft) ||
      (effVis!==null && m.best.vis_m!=null && effVis < m.best.vis_m));
    const belowAlt = ((cig!==null && m.alt.cig_ft!=null && cig < m.alt.cig_ft) ||
      (effVis!==null && m.alt.vis_m!=null && effVis < m.alt.vis_m));
    return { belowBest, belowAlt, onlyBest: (!belowBest && belowAlt), effVis, cig };
  })();

  const minimaTaf = (() => {
    const m = st.minima || null;
    if (!m || !m.best || !m.alt) return null;
    const effVis = (()=>{
      const a = (tafWorstVis===null||tafWorstVis===undefined)?Infinity:tafWorstVis;
      const b = (tafRvrMin===null||tafRvrMin===undefined)?Infinity:tafRvrMin;
      const v = Math.min(a,b);
      return (v===Infinity)?null:v;
    })();
    const cig = (taf.cig===undefined)?null:taf.cig;
    const belowBest = ((cig!==null && m.best.cig_ft!=null && cig < m.best.cig_ft) ||
      (effVis!==null && m.best.vis_m!=null && effVis < m.best.vis_m));
    const belowAlt = ((cig!==null && m.alt.cig_ft!=null && cig < m.alt.cig_ft) ||
      (effVis!==null && m.alt.vis_m!=null && effVis < m.alt.vis_m));
    return { belowBest, belowAlt, onlyBest: (!belowBest && belowAlt), effVis, cig };
  })();

  const minExplainMet = buildMinimaExplain({kind:"METAR", raw:st.metarRaw||"", minima:st.minima||null, state:minimaNow, visVal:met.vis, rvrMin:metRvrMin, isTaf:false});
  const minExplainTaf = buildMinimaExplain({kind:"TAF", raw:st.tafRaw||"", minima:st.minima||null, state:minimaTaf, visVal:tafWorstVis, rvrMin:tafRvrMin, isTaf:true});
  const _minTokensM = minExplainMet ? (minExplainMet.tokens || []) : [];
  const _minTokensT = minExplainTaf ? (minExplainTaf.tokens || []) : [];

  const om = omFn ? omFn(st, met, taf, worstVis, rvrMinAll) : null;
  const empty = computeScores("");
  const omMet = omFn ? omFn({...st, tafRaw:""}, met, empty, met.vis, metRvrMin) : null;
  const omTaf = omFn ? omFn({...st, metarRaw:""}, empty, taf, tafWorstVis, tafRvrMin) : null;

  const engIceOps = (met.vis !== null && met.vis <= 150 && met.hz.fzfg);

  let severityScore = Math.max(met.score, Math.floor(taf.score*0.85));
  if (engIceOps) severityScore = 100;
  const baseAlert = alertFromScore(severityScore);
  const windAlert = windPillarAlert(met, taf);
  const snowAlert = snowPillarAlert(st, met, taf, worstVis, rvrMinAll, cigAll);
  const alert = maxAlert(baseAlert, windAlert, snowAlert);
  severityScore = Math.max(severityScore, minScoreForAlert(alert));

  const metPri = engIceOps ? 1000 : met.score;
  const tafPri = taf.score;

  const metCrit = (typeof met.score === "number" && met.score >= 70);
  const tafCrit = (typeof taf.score === "number" && taf.score >= 70);
  const critSrc = (alert === "CRIT") ? (metCrit ? "M" : (tafCrit ? "T" : "E")) : null;

  const triggers = [];
  const push = (label, cls, src, tip) => triggers.push({label, cls, src, tip});
  const addBy = (label, cls, m, t) => {
    if (!m && !t) return;
    const src = m && t ? "MT" : (m ? "M" : "T");
    push(label, cls, src);
  };

  const minimaState = (om0)=>{
    if (om0 && om0.rvr125) return "rvr125";
    if (om0 && om0.lvtoQualReq) return "lvto150";
    if (om0 && om0.lvp) return "lvp";
    if (om0 && om0.lvto) return "lvto";
    return null;
  };
  const catState = (om0)=>{
    if (om0 && om0.cat3BelowMin) return "cat3min";
    if (om0 && om0.cat3Only) return "cat3only";
    if (om0 && om0.cat2Plus) return "cat2plus";
    return null;
  };
  const omM = omMet || {};
  const omT = omTaf || {};
  const mMin = minimaState(omM);
  const tMin = minimaState(omT);
  const mCat = catState(omM);
  const tCat = catState(omT);

  addBy("TO PROHIB", "tag--stop", !!omM.toProhib, !!omT.toProhib);
  addBy("RVR<125", "tag--stop", mMin==="rvr125", tMin==="rvr125");
  addBy("LVTO<150 QUAL", "tag--warn", mMin==="lvto150", tMin==="lvto150");
  addBy("LVP (<400)", "tag--warn", mMin==="lvp", tMin==="lvp");
  addBy("LVTO (<550)", "tag--lvto", mMin==="lvto", tMin==="lvto");
  addBy("RVR REQ (<800)", "tag--warn", !!omM.rvrRequired, !!omT.rvrRequired);
  addBy("CAT3<75", "tag--stop", mCat==="cat3min", tCat==="cat3min");
  addBy("CAT3 ONLY <200", "tag--warn", mCat==="cat3only", tCat==="cat3only");
  addBy("CAT2+ <450", "tag--warn", mCat==="cat2plus", tCat==="cat2plus");

  if (minExplainMet){
    const lbl = (minExplainMet.mode === "CRIT") ? "MINIMA CRIT" : "MINIMA LIMIT";
    const cls = (minExplainMet.mode === "CRIT") ? "tag--stop" : "tag--warn";
    push(lbl, cls, "M", minExplainMet.tip || "");
  }
  if (minExplainTaf){
    const lbl = (minExplainTaf.mode === "CRIT") ? "MINIMA CRIT" : "MINIMA LIMIT";
    const cls = (minExplainTaf.mode === "CRIT") ? "tag--stop" : "tag--warn";
    push(lbl, cls, "T", minExplainTaf.tip || "");
  }

  if (omM && omM.xwindExceed && omM.xwindLimitKt){
    push(`XWIND>${omM.xwindLimitKt}KT`, "tag--warn", "M");
  }
  if (omT && omT.xwindExceed && omT.xwindLimitKt){
    if (!(omM && omM.xwindExceed && omM.xwindLimitKt === omT.xwindLimitKt)){
      push(`XWIND>${omT.xwindLimitKt}KT`, "tag--warn", "T");
    }
  }

  addBy("RWYCC<3 likely", "tag--warn", !!omM.noOpsLikely, !!omT.noOpsLikely);
  addBy("VA", "tag--stop", !!omM.va, !!omT.va);
  if (omM && omM.coldcorr) push("COLD CORR", "tag--warn", "M");

  for (const th of VIS_THRESHOLDS){
    const m = (met.vis !== null && met.vis <= th);
    const t = (()=>{
      const vals = extractAllVisibilityMetersFromTAF(st.tafRaw || "");
      return vals.length ? Math.min(...vals) <= th : false;
    })();
    if (m || t){
      addBy(`VIS≤${th}`, "tag--vis", m, t);
      break;
    }
  }

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

  addBy("CIG<500", "tag--cig",
    (ceilingFt(st.metarRaw||"") !== null && ceilingFt(st.metarRaw||"") < 500),
    (ceilingFt(st.tafRaw||"") !== null && ceilingFt(st.tafRaw||"") < 500));

  const mg25 = (met.gustMax !== null && met.gustMax >= 25);
  const tg25 = (taf.gustMax !== null && taf.gustMax >= 25);
  const mg30 = (met.gustMax !== null && met.gustMax >= 30);
  const tg30 = (taf.gustMax !== null && taf.gustMax >= 30);
  const mg40 = (met.gustMax !== null && met.gustMax >= 40);
  const tg40 = (taf.gustMax !== null && taf.gustMax >= 40);
  addBy("GUST≥40KT", "tag--gust", mg40, tg40);
  addBy("GUST≥30KT", "tag--gust", mg30 && !mg40, tg30 && !tg40);
  addBy("GUST≥25KT", "tag--gust", mg25 && !mg30 && !mg40, tg25 && !tg30 && !tg40);

  const mhz = met.hz, thz = taf.hz;
  addBy("TS/CB", "tag--wx", (mhz.ts || mhz.cb), (thz.ts || thz.cb));
  addBy("FZFG", "tag--wx", mhz.fzfg, thz.fzfg);
  addBy("FG", "tag--wx", mhz.fg, thz.fg);
  addBy("BR", "tag--wx", mhz.br, thz.br);
  addBy("SN", "tag--wx", mhz.sn, thz.sn);
  addBy("RA", "tag--wx", mhz.ra, thz.ra);

  if (engIceOps) triggers.unshift({label:"ENG ICE OPS", cls:"tag--eng", src:"M"});

  return {
    ...st,
    _thinComputed: true,
    met, taf,
    worstVis,
    tafWorstVis,
    rvrMinAll,
    cigAll,
    minimaNow,
    minimaTaf,
    minExplainMet,
    minExplainTaf,
    _minTokensM,
    _minTokensT,
    om,
    omMet,
    omTaf,
    engIceOps,
    severityScore,
    alert,
    metCrit,
    tafCrit,
    critSrc,
    metPri,
    tafPri,
    triggers
  };
}

const OURAIRPORTS_AIRPORTS_URLS = [
  'https://ourairports.com/airports.csv',
  'https://davidmegginson.github.io/ourairports-data/airports.csv',
  'https://raw.githubusercontent.com/davidmegginson/ourairports-data/master/airports.csv',
  'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv',
];

const OURAIRPORTS_RUNWAYS_URLS = [
  'https://ourairports.com/runways.csv',
  'https://davidmegginson.github.io/ourairports-data/runways.csv',
  'https://raw.githubusercontent.com/davidmegginson/ourairports-data/master/runways.csv',
  'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/runways.csv',
];

const AWC_METAR = 'https://aviationweather.gov/api/data/metar';
const AWC_TAF = 'https://aviationweather.gov/api/data/taf';

// Core hazards to highlight (extend as desired)
const HAZARDS = [
  'FZFG','FG','BR',
  'TS','TSRA','TSGR','TSGS','SQ',
  'FZRA','PL','SN','BLSN','RA','+RA','SHRA','SHSN','GR','GS',
  'FZDZ','DZ'
];

function readIcaoList() {
  if(!fs.existsSync(AIRPORTS_TXT)){
    throw new Error(`Missing airports.txt at ${AIRPORTS_TXT}`);
  }
  // Be permissive: accept lines like
  //   "LHBP"
  //   "LHBP # Budapest"
  //   "LHBP - Budapest"
  //   "LHBP,BUD"
  // and ignore any extra tokens/comments after the ICAO.
  // This prevents silent drop of all rows if airports.txt contains annotations.
  const txt = fs.readFileSync(AIRPORTS_TXT, 'utf8').replace(/^\uFEFF/, ''); // strip BOM

  const out = [];
  for (const line0 of txt.split(/\r?\n/)) {
    const line = String(line0)
      .replace(/\s*(#|\/\/).*$/, '')   // strip trailing comments
      .trim()
      .toUpperCase();
    if (!line) continue;

    // First standalone 4-char token wins
    const m = line.match(/\b([A-Z0-9]{4})\b/);
    if (m) out.push(m[1]);
  }

  // De-duplicate while preserving order
  const seen = new Set();
  return out.filter(x => (seen.has(x) ? false : (seen.add(x), true)));
}

function readBaseIataList(){
  if (!fs.existsSync(BASE_TXT)) return [];
  const raw = fs.readFileSync(BASE_TXT, 'utf8');
  const lines = raw.split(/\r?\n/).map(l=>l.trim().toUpperCase()).filter(Boolean);
  // de-dupe but keep order
  const seen = new Set();
  const out = [];
  for (const x of lines){
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}


function ensureDataDir(){
  const dir = path.dirname(OUT_LATEST);
  fs.mkdirSync(dir, { recursive: true });
}

function writeStatus({generatedAt, stats, errors}){
  ensureDataDir();
  const payload = {
    generatedAt,
    stats: stats ?? {},
    errors: errors ?? []
  };
  fs.writeFileSync(OUT_STATUS, JSON.stringify(payload, null, 2));
}

function safeReadJson(file){
  try{
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }catch{
    return null;
  }
}

function diffStations(prevStations, nextStations){
  // Build quick maps by ICAO.
  const prev = new Map((prevStations||[]).map(s=>[s.icao, s]));
  const next = new Map((nextStations||[]).map(s=>[s.icao, s]));
  const events = [];

  for (const [icao, n] of next.entries()){
    const p = prev.get(icao);
    if (!p){
      events.push({icao, type:"NEW", alert:n.alert||"OK", triggers:n.triggers||[], minimaNow:n.minimaNow||null});
      continue;
    }
    const changes = {};
    for (const key of ["alert","critSrc","minimaNow","minimaTaf"]){
      const pv = p[key] ?? null;
      const nv = n[key] ?? null;
      if (pv !== nv) changes[key] = {from: pv, to: nv};
    }
    const trigKey = (arr)=> (Array.isArray(arr)?arr:[]).map(t=> (typeof t==="string")?t:(t?.label||"")).filter(Boolean).join("|");
    const pTrig = trigKey(p.triggers);
    const nTrig = trigKey(n.triggers);
    if (pTrig !== nTrig) changes.triggers = {from: p.triggers||[], to: n.triggers||[]};

    if (Object.keys(changes).length){
      events.push({icao, type:"CHANGE", changes, alert:n.alert||"OK", triggers:n.triggers||[]});
    }
  }

  // Removed stations (rare)
  for (const [icao, p] of prev.entries()){
    if (!next.has(icao)) events.push({icao, type:"REMOVED", alert:p.alert||"OK"});
  }

  return events;
}

function buildManagementBrief({generatedAt, stations, events, baseStations, baseMissing, baseOrder}){
  const all = (stations||[]);
  const top = all.slice(0, 40); // already sorted by severityScore desc
  const crit = top.filter(s=>s.alert==="CRIT");
  const high = top.filter(s=>s.alert==="HIGH");
  const med  = top.filter(s=>s.alert==="MED");

  const changed = (events||[]).filter(e=>e.type==="CHANGE").slice(0, 12);

  const shortName = (name)=>{
    const s = String(name||"").trim();
    if (!s) return null;
    return s.replace(/\s+Airport$/i,"").replace(/\s+International$/i,"").trim();
  };
  const airportLabel = (s)=>{
    const n = shortName(s.name) || s.iata || s.icao;
    // Keep codes, but don't make the whole brief code-only.
    const code = s.iata ? `${s.iata}/${s.icao}` : s.icao;
    return `${n} (${code})`;
  };
  const listAirports = (arr, n=6)=>{
    const a = (arr||[]).slice(0,n).map(airportLabel);
    if (!a.length) return "—";
    const extra = (arr||[]).length - a.length;
    return extra>0 ? `${a.join(", ")} and ${extra} others` : a.join(", ");
  };

  const trigLabels = (s)=> (Array.isArray(s?.triggers)?s.triggers:[])
      .map(t=> (typeof t==="string")?t:(t?.label||""))
      .filter(Boolean);

  const fmtVis = (m)=>{
    if (m == null) return null;
    const v = Number(m);
    if (!Number.isFinite(v)) return null;
    if (v >= 9999) return "10 km+";
    if (v >= 1000) return `${(v/1000).toFixed(v%1000===0?0:1)} km`;
    return `${Math.round(v)} m`;
  };
  const fmtRvr = (m)=>{
    if (m == null) return null;
    const v = Number(m);
    if (!Number.isFinite(v)) return null;
    return `${Math.round(v)} m`;
  };
  const fmtCeil = (ft)=>{
    if (ft == null) return null;
    const v = Number(ft);
    if (!Number.isFinite(v)) return null;
    if (v >= 5000) return "5,000 ft+";
    return `${Math.round(v)} ft`;
  };

  const categorize = (label)=>{
    const L = String(label||"").toUpperCase();
    if (L.includes("MINIMA")) return "approach minima limitations";
    if (L.includes("LVP")) return "low-visibility operations (reduced capacity)";
    if (L.includes("LVTO")) return "low-visibility takeoff restrictions";
    if (L.includes("RVR")) return "runway visual range limitations";
    if (L.includes("VIS")) return "very low visibility";
    if (L.includes("CIG")) return "low cloud base";
    if (L.includes("FZFG") || L.includes("FG")) return "fog / freezing fog";
    if (L.includes("BR")) return "mist";
    if (L.includes("BLSN") || (L.includes("SN") && !L.includes("TSN"))) return "snow / blowing snow";
    if (L.includes("FZRA") || L.includes("FZDZ") || L.includes("ICE")) return "freezing precipitation / icing risk";
    if (L.includes("TS") || L.includes("CB")) return "thunderstorm / convective risk";
    if (L.includes("XWIND") || L.includes("CROSSWIND")) return "crosswind limitations";
    if (L.includes("RWYCC") || (L.includes("RWY") && L.includes("LIKELY"))) return "runway contamination / braking action risk";
    if (L.includes("COLD CORR")) return "cold-temperature performance corrections";
    if (L.includes("VA")) return "volcanic ash risk";
    return null;
  };

  const humanSummary = (s)=>{
    // Short, management-readable cause line.
    // Avoid pure codes/tags; prefer plain-language drivers + only material metrics.
    const parts = [];
    const haz = new Set(Array.isArray(s?.hazards) ? s.hazards : []);
    const labs = trigLabels(s);

    // Weather descriptors (plain language)
    if (haz.has("fzfg")) parts.push("freezing fog");
    else if (haz.has("fg")) parts.push("fog");
    if (haz.has("br") && !parts.includes("fog") && !parts.includes("freezing fog")) parts.push("mist");
    if (haz.has("sn") || haz.has("blsn")) parts.push("snow");
    if (labs.some(x=>/FZRA|FZDZ|ICE/i.test(x))) parts.push("freezing precipitation / icing risk");
    if (labs.some(x=>/RWYCC|BRAKING|CONTAM/i.test(x))) parts.push("runway contamination risk");
    if (labs.some(x=>/COLD CORR/i.test(x))) parts.push("cold-temperature performance penalties");
    if (labs.some(x=>/XWIND|CROSSWIND/i.test(x))) parts.push("crosswind limitation risk");
    if (labs.some(x=>/GUST/i.test(x))) parts.push("strong gusts risk");

    // Measurable constraints (only if operationally material)
    const visVal = Number(s?.worstVis ?? s?.worst_visibility_m ?? s?.visibility_m);
    const v = fmtVis(visVal);
    const rvrVal = Number(s?.rvrMinAll);
    const r = fmtRvr(rvrVal);
    const ceilVal = Number(s?.cigAll ?? s?.ceiling_ft);
    const c = fmtCeil(ceilVal);

    const meas = [];
    if (v && Number.isFinite(visVal) && visVal > 0 && visVal < 3000) meas.push(`visibility down to ${v}`);
    if (r && Number.isFinite(rvrVal) && rvrVal > 0 && rvrVal < 800) meas.push(`RVR down to ${r}`);
    if (c && Number.isFinite(ceilVal) && ceilVal >= 0 && ceilVal < 1000) meas.push(`cloud base around ${c}`);
    if (meas.length) parts.push(meas.join(", "));

    // Minima (only if actually below)
    if (s?.minimaNow?.belowBest) parts.push("below approach minima (current METAR)");
    else if (s?.minimaNow?.belowAlt) parts.push("below alternate minima (current METAR)");
    if (s?.minimaTaf?.belowBest) parts.push("forecast below approach minima at times");

    if (!parts.length){
      // Fallback: convert top trigger labels to plain categories
      const cats = [];
      const seen = new Set();
      for (const lab of labs){
        const cat = categorize(lab);
        if (!cat || seen.has(cat)) continue;
        seen.add(cat);
        cats.push(cat);
        if (cats.length >= 2) break;
      }
      if (cats.length) return cats.join("; ");
      return "operational constraints flagged";
    }
    return parts.slice(0,3).join("; ");
  };

  // Always include base airports (from base.txt), even if not in top list.
  const bases = (baseStations||[]).slice().sort((a,b)=>{
    const ao = (baseOrder?.[a.iata] ?? 1e9);
    const bo = (baseOrder?.[b.iata] ?? 1e9);
    if (ao !== bo) return ao - bo;
    return (b.severityScore??0) - (a.severityScore??0);
  });

  const baseCounts = { CRIT:0, HIGH:0, MED:0, OK:0 };
  for (const s of bases){
    const a = s.alert || "OK";
    baseCounts[a] = (baseCounts[a] ?? 0) + 1;
  }
  const baseImpactedAny = bases.filter(s=> (s.alert==="CRIT" || s.alert==="HIGH" || s.alert==="MED"));
  const baseFocus = bases.filter(s=> (s.alert==="CRIT" || s.alert==="HIGH"));
  const baseMonitorCount = Math.max(0, baseImpactedAny.length - baseFocus.length);

  // Build driver stats from the worst tier present (crit > high > med)
  const pool = crit.length ? crit : (high.length ? high : med);
  const driverCounts = new Map();
  for (const s of pool){
    const seen = new Set();
    for (const lab of trigLabels(s)){
      const cat = categorize(lab);
      if (!cat || seen.has(cat)) continue;
      seen.add(cat);
      driverCounts.set(cat, (driverCounts.get(cat)||0) + 1);
    }
  }
  const topDrivers = [...driverCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([cat,count])=>`${cat}`);

  const headline20 =
    crit.length ? `Critical operational constraints are flagged at ${crit.length} airports right now.` :
    high.length ? `High-impact operational constraints are flagged at ${high.length} airports right now.` :
    med.length ? `Medium-level weather constraints are flagged at ${med.length} airports right now.` :
    "No significant operational weather constraints are currently flagged in the monitored airports.";

  const management45 = (() => {
    const parts = [];
    parts.push(headline20);

    // Base airports: always included and phrased for read-out-loud delivery.
    if (bases.length){
      const baseStatusBits = [];
      if (baseCounts.CRIT) baseStatusBits.push(`${baseCounts.CRIT} critical`);
      if (baseCounts.HIGH) baseStatusBits.push(`${baseCounts.HIGH} high`);
      if (baseCounts.MED)  baseStatusBits.push(`${baseCounts.MED} medium`);
      const okCount = bases.length - (baseCounts.CRIT + baseCounts.HIGH + baseCounts.MED);
      if (okCount) baseStatusBits.push(`${okCount} normal`);
      parts.push(`Across base airports: ${baseStatusBits.join(", ")}.`);

      const basePool = baseFocus.length ? baseFocus : baseImpactedAny;
      if (basePool.length){
        // Spoken-friendly base summary: mention key bases, then group common drivers (avoid repeating the same trigger per airport).
        const shownBases = basePool.slice(0,5);
        const extraBases = Math.max(0, basePool.length - shownBases.length);
        const baseNames = shownBases.map(s => airportLabel(s)).filter(Boolean);
        const joinList = (items)=>{
          const a = (items||[]).filter(Boolean);
          if (!a.length) return "";
          if (a.length===1) return a[0];
          if (a.length===2) return `${a[0]} and ${a[1]}`;
          return a.slice(0,-1).join(", ") + ` and ${a[a.length-1]}`;
        };
        const baseList = joinList(baseNames) + (extraBases>0 ? ` and ${extraBases} others` : "");
        parts.push(`Base airports needing attention include ${baseList}.`);

        if (baseMonitorCount>0){
          parts.push(`Other base airports are mostly medium severity and should be monitored (${baseMonitorCount} flagged).`);
        }

        // Build driver groups across basePool
        const driverMap = new Map(); // category -> stations[]
        const addDriver = (cat, s)=>{
          if (!cat) return;
          if (!driverMap.has(cat)) driverMap.set(cat, []);
          driverMap.get(cat).push(s);
        };
        for (const s of basePool){
          const cats = new Set();
          // hazards
          const haz = new Set(Array.isArray(s?.hazards) ? s.hazards : []);
          if (haz.has("fg") || haz.has("fzfg")) cats.add("fog / freezing fog");
          if (haz.has("br")) cats.add("mist");
          if (haz.has("sn") || haz.has("blsn")) cats.add("snow / blowing snow");
          // trigger labels
          for (const lab of trigLabels(s)){
            const cat = categorize(lab);
            if (cat) cats.add(cat);
          }
          for (const cat of cats) addDriver(cat, s);
        }

        // Pick top categories by coverage
        const ranked = [...driverMap.entries()]
          .map(([cat, arr])=>[cat, new Set(arr.map(x=>x.icao)).size])
          .sort((a,b)=>b[1]-a[1]);

        // Optionally merge snow + runway contamination into one clause for more natural spoken output
        const getSet = (cat)=>{
          const arr = driverMap.get(cat) || [];
          return new Set(arr.map(x=>x.icao));
        };
        const snowSet = getSet("snow / blowing snow");
        const rwySet  = getSet("runway contamination / braking action risk");
        if (snowSet.size && rwySet.size){
          const merged = new Set([...snowSet, ...rwySet]);
          driverMap.set("snow / runway contamination risk", [...basePool].filter(s=>merged.has(s.icao)));
          // Reduce ranking weight by removing individual items later if present
        }

        const prettyCat = (cat)=>{
          switch(cat){
            case "snow / runway contamination risk": return "snow and runway contamination risk";
            case "runway contamination / braking action risk": return "runway contamination / reduced braking risk";
            case "cold-temperature performance corrections": return "cold‑temperature performance penalties";
            case "low cloud base": return "low cloud base";
            case "mist": return "mist";
            case "fog / freezing fog": return "fog / freezing fog";
            case "very low visibility": return "very low visibility";
            case "runway visual range limitations": return "RVR limitations";
            case "low-visibility operations (reduced capacity)": return "low‑visibility procedures";
            case "approach minima limitations": return "approach minima limits";
            case "crosswind limitations": return "crosswind constraints";
            case "snow / blowing snow": return "snow / blowing snow";
            default: return cat;
          }
        };

        // Build up to 3 grouped clauses
        const selectedCats = [];
        for (const [cat, n] of ranked){
          if (selectedCats.length>=3) break;
          if (cat==="snow / blowing snow" && driverMap.has("snow / runway contamination risk")) continue;
          if (cat==="runway contamination / braking action risk" && driverMap.has("snow / runway contamination risk")) continue;
          if (!n) continue;
          selectedCats.push(cat);
        }
        if (driverMap.has("snow / runway contamination risk") && !selectedCats.includes("snow / runway contamination risk")){
          // Prefer merged clause if it is material
          selectedCats.unshift("snow / runway contamination risk");
          selectedCats.splice(3);
        }

        const clauseFor = (cat)=>{
          const arr = driverMap.get(cat) || [];
          const uniq = [];
          const seen = new Set();
          for (const s of arr){
            if (seen.has(s.icao)) continue;
            seen.add(s.icao);
            uniq.push(s);
          }
          uniq.sort((a,b)=> (b.severityScore||0) - (a.severityScore||0));
          const shown = uniq.slice(0,4).map(s=>airportLabel(s));
          const extra = Math.max(0, uniq.length - shown.length);
          const list = joinList(shown) + (extra>0 ? ` and ${extra} others` : "");
          return `${prettyCat(cat)} at ${list}`;
        };

        const clauses = selectedCats.map(clauseFor).filter(Boolean);
        if (clauses.length){
          const spoken = (clauses.length===1) ? clauses[0]
            : (clauses.length===2) ? `${clauses[0]}, and ${clauses[1]}`
            : `${clauses[0]}, ${clauses[1]}, and ${clauses[2]}`;
          parts.push(`At base airports, the main issues are ${spoken}.`);
        }
      } else {
        parts.push(`No base airports are currently showing material operational constraints.`);
      }

      if (Array.isArray(baseMissing) && baseMissing.length){
        const bmShown = baseMissing.slice(0,6);
        const bmExtra = baseMissing.length - bmShown.length;
        parts.push(`Note: ${baseMissing.length} base codes are not present in the monitored airport list (${bmShown.join(", ")}${bmExtra>0 ? ` and ${bmExtra} others` : ""}).`);
      }
    }

    if (pool.length){
      parts.push(`Across the network, the worst‑affected airports include ${listAirports(pool, 6)}.`);
      if (topDrivers.length){
        // Slightly shorten a few driver labels for spoken delivery
        const pretty = (d)=>({
          "approach minima limitations":"approach minima limits",
          "low-visibility operations (reduced capacity)":"low‑visibility procedures (reduced capacity)",
          "low-visibility takeoff restrictions":"low‑visibility takeoff restrictions",
          "runway visual range limitations":"RVR limitations",
          "very low visibility":"very low visibility",
          "low cloud base":"low cloud base",
          "fog / freezing fog":"fog / freezing fog",
          "snow / blowing snow":"snow / blowing snow",
          "freezing precipitation / icing risk":"freezing precipitation / icing risk",
          "thunderstorm / convective risk":"convective activity",
          "crosswind limitations":"crosswind constraints",
          "runway contamination / braking action risk":"runway contamination / braking action risk",
          "cold-temperature performance corrections":"cold‑temperature performance penalties",
          "volcanic ash risk":"volcanic ash"
        }[d] || d);
        const d = topDrivers.map(pretty);
        parts.push(`Primary drivers are ${d.join(", ").replace(/,([^,]*)$/, " and$1")}.`);
      }
      parts.push(`Expected impact: reduced runway capacity and higher delay/diversion risk at the worst‑affected airports, especially where visibility/RVR and cloud base are very low.`);
    }

    if (changed.length){
      const changedStations = changed.map(e => all.find(x=>x.icao===e.icao)).filter(Boolean);
      const shown = changedStations.slice(0,6).map(airportLabel);
      const extra = changedStations.length - shown.length;
      parts.push(`Since the last update, ${changedStations.length} airports changed status, led by ${shown.join(", ")}${extra>0 ? ` and ${extra} others` : ""}.`);
    }

    return parts.join(" ");
  })();

  const detail90 = (() => {
    const lines = [];
    lines.push(headline20);

    const prettyDriver = (d)=>({
      "approach minima limitations":"approach minima limits",
      "low-visibility operations (reduced capacity)":"low-visibility procedures (reduced capacity)",
      "low-visibility takeoff restrictions":"low-visibility takeoff restrictions",
      "runway visual range limitations":"runway visual range (RVR) constraints",
      "very low visibility":"very low visibility",
      "low cloud base":"low ceilings",
      "fog / freezing fog":"fog/freezing fog",
      "mist":"mist",
      "snow / blowing snow":"snow/blowing snow",
      "freezing precipitation / icing risk":"freezing precipitation/icing risk",
      "thunderstorm / convective risk":"thunderstorm/convective risk",
      "crosswind limitations":"crosswind limitations",
      "runway contamination / braking action risk":"runway contamination / reduced braking",
      "cold-temperature performance corrections":"cold-temperature performance penalties",
      "volcanic ash risk":"volcanic ash risk"
    }[d] || d);

    const driverPhrases = (s, max=3)=>{
      const out = [];
      const seen = new Set();
      for (const lab of trigLabels(s)){
        const cat = categorize(lab);
        if (!cat) continue;
        const p = prettyDriver(cat);
        if (seen.has(p)) continue;
        seen.add(p);
        out.push(p);
        if (out.length >= max) break;
      }
      // Add obvious hazards if not already captured
      const haz = new Set(Array.isArray(s?.hazards) ? s.hazards : []);
      const pushIf = (phrase)=>{
        if (out.length>=max) return;
        if (!seen.has(phrase)) { out.push(phrase); seen.add(phrase); }
      };
      if (haz.has("fzfg")) pushIf("freezing fog");
      else if (haz.has("fg")) pushIf("fog");
      if (haz.has("sn") || haz.has("blsn")) pushIf("snow/blowing snow");
      return out.slice(0,max);
    };

    if (bases.length){
      const focus = baseFocus.length ? baseFocus : bases.filter(s=>s.alert==="MED");
      const shown = focus.slice(0,6).map(s=>`${airportLabel(s)} — ${s.alert||"OK"}: ${humanSummary(s)}`);
      const extra = focus.length - shown.length;
      let line = `Base airports (focus): ${shown.join(" | ")}${extra>0 ? ` and ${extra} others` : ""}.`;
      if (!baseFocus.length && baseMonitorCount>0) line = `Base airports (monitor): ${shown.join(" | ")}${extra>0 ? ` and ${extra} others` : ""}.`;
      lines.push(line);
    }

    // Critical / worst affected airports: explain in plain drivers (no raw tags)
    const worst = crit.length ? crit : pool;
    const show = worst.slice(0, 6);
    if (show.length){
      const items = show.map(s=>{
        const drivers = driverPhrases(s, 3);
        const d = drivers.length ? drivers.join(", ") : "operational constraints";
        return `${airportLabel(s)} — ${s.alert||"OK"}: ${humanSummary(s)} (drivers: ${d})`;
      });
      const extra = worst.length - items.length;
      lines.push(`Worst affected now: ${items.join(" | ")}${extra>0 ? ` and ${extra} others` : ""}.`);
    }

    if (changed.length){
      const changedNames = changed.map(e=>{
        const s = all.find(x=>x.icao===e.icao);
        return s ? airportLabel(s) : e.icao;
      });
      const shown = changedNames.slice(0,10);
      const extra = changedNames.length - shown.length;
      lines.push(`Changed since last run: ${shown.join(", ")}${extra>0 ? ` and ${extra} others` : ""}.`);
    }
    return lines.join(" ");
  })();

  // Include top + impacted bases in the exported top list for UI and debugging.
  const topOut = [];
  const seen = new Set();
  const pushUnique = (s)=>{
    if (!s || !s.icao || seen.has(s.icao)) return;
    seen.add(s.icao);
    topOut.push({
      icao:s.icao, iata:s.iata||null, name:s.name||null,
      alert:s.alert||"OK", critSrc:s.critSrc||null,
      summary: humanSummary(s),
      triggers: Array.isArray(s.triggers)?s.triggers:[],
    });
  };
  for (const s of top.slice(0,12)) pushUnique(s);
  for (const s of baseImpactedAny.slice(0,12)) pushUnique(s);

  return {
    generatedAt,
    headline20,
    management45,
    detail90,
    base: bases.slice(0, 40).map(s=>({
      icao:s.icao, iata:s.iata||null, name:s.name||null,
      alert:s.alert||"OK", summary: humanSummary(s)
    })),
    top: topOut,
    changed: changed.map(e=>({icao:e.icao, type:e.type, alert:e.alert||"OK"}))
  };
}

function writeRollingChanges({generatedAt, events, limit=200}){
  ensureDataDir();
  const prev = safeReadJson(OUT_CHANGES);
  const hist = Array.isArray(prev?.events) ? prev.events : [];
  const merged = [
    ...events.map(e=>({ts: generatedAt, ...e})),
    ...hist
  ].slice(0, limit);

  fs.writeFileSync(OUT_CHANGES, JSON.stringify({generatedAt, events: merged}, null, 2));
}


function chunk(arr, n){
  const out=[];
  for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n));
  return out;
}

function escapeHtml(s=''){
  return s.replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function parseSmToken(tok){
  // Handles: 10SM, 1/2SM, M1/4SM, P6SM
  if(/^P\d+SM$/.test(tok)){
    const sm = parseInt(tok.slice(1,-2),10);
    return Number.isFinite(sm) ? sm * 1609 : null;
  }
  if(/^M?\d+SM$/.test(tok)){
    const sm = parseInt(tok.replace('M','').slice(0,-2),10);
    return Number.isFinite(sm) ? sm * 1609 : null;
  }
  if(/^M?\d+\/\d+SM$/.test(tok)){
    const frac = tok.replace('M','').slice(0,-2);
    const [a,b]=frac.split('/').map(Number);
    if(Number.isFinite(a) && Number.isFinite(b) && b !== 0){
      return Math.round((a/b) * 1609);
    }
  }
  return null;
}

function tokenizeAllVis(raw){
  // Returns {min_m, tokensToHighlight: Set<string>, primaryToken?:string}
  if(!raw) return { min_m: null, tokensToHighlight: new Set(), primaryToken: null };

  const tokens = raw.split(/\s+/);
  let min = null;
  const toks = new Set();

  // CAVOK is effectively >= 10km
  if(/\bCAVOK\b/.test(raw)){
    min = 10000;
    toks.add('CAVOK');
  }

  for(const t of tokens){
    // 4-digit meters visibility group (0000..9999)
    if(/^\d{4}$/.test(t)){
      const m = parseInt(t,10);
      if(Number.isFinite(m)){
        const meters = (m === 9999) ? 10000 : m;
        if(min == null || meters < min) min = meters;
        toks.add(t);
      }
      continue;
    }

    // SM formats
    const smMeters = parseSmToken(t);
    if(smMeters != null){
      if(min == null || smMeters < min) min = smMeters;
      toks.add(t);
    }
  }

  // pick a primary token for display/highlight focus (if any)
  const primaryToken = toks.size ? Array.from(toks)[0] : null;
  return { min_m: min, tokensToHighlight: toks, primaryToken };
}

function findHazards(text){
  if(!text) return [];
  const up = String(text).toUpperCase();
  const set = new Set();

  for(const h of HAZARDS){
    const re = new RegExp(`\\b${h.replace('+','\\+')}\\b`);
    if(re.test(up)) set.add(h);
  }

  // Token-aware detection for combined weather groups (e.g. RASN, -RASN, SHRASN).
  // aviationweather.gov raw output is whitespace-delimited, so this is safe.
  const toks = up.split(/\s+/).map(t=>t.trim()).filter(Boolean).filter(t=>{
    if(t.includes("/")) return false;
    if(/[0-9]/.test(t)) return false;
    if(/KT$/.test(t) || /MPS$/.test(t)) return false;
    if(t.length > 10) return false;
    return true;
  });

  const addIf = (needle, label)=>{ if(toks.some(t=>t.includes(needle))) set.add(label); };

  addIf("SN", "SN");
  addIf("BLSN", "BLSN");
  addIf("FZRA", "FZRA");
  addIf("FZDZ", "FZDZ");
  addIf("TS", "TS");
  addIf("FG", "FG");
  addIf("BR", "BR");
  addIf("RA", "RA");
  addIf("DZ", "DZ");

  // Also capture +/- variants for key phenomena when standalone
  const generic = up.match(/\b(\+|-)?(RA|SN|TS|FG|DZ)\b/g);
  if(generic){
    for(const g of generic) set.add(g);
  }

  return Array.from(set);
}


function severityScore({hazards=[], visibility_m=null, ceiling_ft=null, hasTaf=false}){
  let s = 0;

  // Visibility weighting (meters)
  if(visibility_m != null){
    if(visibility_m <= 200) s += 55;
    else if(visibility_m <= 300) s += 45;
    else if(visibility_m <= 500) s += 35;
    else if(visibility_m <= 800) s += 25;
    else if(visibility_m <= 1500) s += 10;
  }

  // Ceiling weighting
  if(ceiling_ft != null){
    if(ceiling_ft < 500) s += 35;
    else if(ceiling_ft < 1000) s += 25;
    else if(ceiling_ft < 2000) s += 12;
  }

  // Hazards weighting
  const weight = {
    'FZRA': 35, 'FZDZ': 28,
    'FZFG': 30,
    'TS': 25, 'TSRA': 25, 'TSGR': 30, 'TSGS': 30, 'SQ': 18,
    'GR': 20, 'GS': 18,
    'SN': 18, 'BLSN': 22, 'PL': 15,
    'RA': 12, '+RA': 16, 'SHRA': 14,
    'FG': 20, 'BR': 10,
    'DZ': 10
  };
  for(const h of hazards){
    s += weight[h] ?? 10;
  }

  // small penalty if no TAF (less situational picture)
  if(!hasTaf) s += 5;

  return Math.min(100, s);
}

function highlightRaw(text, visTokensToHighlight = new Set(), visThreshold_m = 800){
  if(!text) return '';
  let html = escapeHtml(text);

  // Highlight hazards
  for(const h of HAZARDS){
    const safe = h.replace('+','\\+');
    html = html.replace(new RegExp(`\\b${safe}\\b`, 'g'), (m) => `<span class="hl">${m}</span>`);
  }
  html = html.replace(/\b(\+|-)(RA|SN|TS|FG|DZ)\b/g, (m)=> `<span class="hl">${m}</span>`);

  // Highlight visibility tokens that are <= threshold (meters) when token is 4-digit,
  // or any SM token if overall min visibility <= threshold.
  if(visTokensToHighlight && visTokensToHighlight.size){
    for(const tok of visTokensToHighlight){
      // For 4-digit meter groups, only highlight if <= threshold
      let shouldHighlight = false;
      if(/^\d{4}$/.test(tok)){
        const m = parseInt(tok,10);
        if(Number.isFinite(m) && m <= visThreshold_m) shouldHighlight = true;
      } else if(/\bSM$/.test(tok) || tok === 'CAVOK'){
        // If min vis is already below threshold, highlight SM token as well.
        // (We don't have token-level meters here, but this keeps UX consistent.)
        shouldHighlight = true;
      }

      if(!shouldHighlight) continue;

      const safeTok = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(new RegExp(`\\b${safeTok}\\b`, 'g'), (m)=> `<span class="hl-vis">${m}</span>`);
    }
  }

  return html;
}

function sleep(ms){
  return new Promise(r => setTimeout(r, ms));
}

function headersForUrl(url){
  const u = String(url || "");
  const headers = {};

  // AWC guidance: use a custom UA to prevent automated filtering issues
  if (u.includes("aviationweather.gov")){
    headers["User-Agent"] = "wizz-awc-monitor (github-actions)";
    headers["Accept"] = "text/plain,*/*";
    return headers;
  }

  // OurAirports sources can be picky about bot-like UAs; use a browser-like UA.
  if (u.includes("ourairports.com") || u.includes("ourairports-data") || u.includes("githubusercontent.com")){
    headers["User-Agent"] = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
    headers["Accept"] = "text/csv,text/plain,*/*";
    return headers;
  }

  headers["User-Agent"] = "Mozilla/5.0";
  headers["Accept"] = "*/*";
  return headers;
}

async function fetchText(url, {timeoutMs = 25_000, retries = 2} = {}){
  let lastErr = null;

  for(let attempt = 0; attempt <= retries; attempt++){
    const ac = new AbortController();
    const t = setTimeout(()=> ac.abort(), timeoutMs);

    try{
      const res = await fetch(url, {
        headers: headersForUrl(url),
        redirect: "follow",
        signal: ac.signal,
      });

      clearTimeout(t);

      if(!res.ok){
        const body = await res.text().catch(()=> "");
        throw new Error(`Fetch failed ${res.status} ${res.statusText}: ${body.slice(0,200)}`);
      }

      return await res.text();
    }catch(e){
      clearTimeout(t);
      lastErr = e;
      if (attempt < retries){
        await sleep(700 * (attempt + 1));
        continue;
      }
    }
  }

  throw lastErr;
}


async function fetchMetars(icaos){
  const map = new Map();
  for(const c of chunk(icaos, 50)){
    const ids = encodeURIComponent(c.join(','));
    const url = `${AWC_METAR}?ids=${ids}&format=raw`;
    const txt = await fetchText(url);
    for(const line of txt.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)){
      // Example: "METAR EGLC ...." or "SPECI EDDM ..."
      const parts = line.split(/\s+/);
      const idx = (parts[0] === 'METAR' || parts[0] === 'SPECI') ? 1 : 0;
      const icao = parts[idx];
      if(icao) map.set(icao.toUpperCase(), line);
    }
  }
  return map;
}

async function fetchTafs(icaos){
  const map = new Map();
  for(const c of chunk(icaos, 50)){
    const ids = encodeURIComponent(c.join(','));
    const url = `${AWC_TAF}?ids=${ids}&format=raw`;
    const txt = await fetchText(url);

    // TAFs can be multi-line blocks; split by "TAF " header.
    const blocks = txt.split(/\n(?=TAF\s)/).map(s=>s.trim()).filter(Boolean);
    for(const b of blocks){
      const m = b.match(/^(TAF\s+)?([A-Z0-9]{4})\b/);
      if(m){
        map.set(m[2].toUpperCase(), b);
      }
    }
  }
  return map;
}

function parseCsvLine(line){
  // Handles quoted CSV with commas. Minimal parser sufficient for OurAirports.
  const out = [];
  let cur = '';
  let inQ = false;
  for(let i=0;i<line.length;i++){
    const ch = line[i];
    if(inQ){
      if(ch === '"' && line[i+1] === '"'){ cur += '"'; i++; continue; }
      if(ch === '"'){ inQ = false; continue; }
      cur += ch;
    }else{
      if(ch === '"'){ inQ = true; continue; }
      if(ch === ','){ out.push(cur); cur=''; continue; }
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function buildIataMap(icaos){
  // Load existing map if present to avoid re-downloading on every run.
  let existing = {};
  if(fs.existsSync(OUT_IATA_MAP)){
    try { existing = JSON.parse(fs.readFileSync(OUT_IATA_MAP,'utf8')); } catch {}
  }

  // Rebuild entries that are missing core fields (older iata_map.json versions may not contain lat/lon).
  const missing = icaos.filter(i => !existing[i] || existing[i].lat == null || existing[i].lon == null);
  if(missing.length === 0) return existing;

  console.log(`IATA map: ${missing.length} missing ICAO codes, downloading OurAirports airports.csv…`);
  let csv;
  {
    let lastErr = null;
    for (const url of OURAIRPORTS_AIRPORTS_URLS){
      try{
        csv = await fetchText(url);
        lastErr = null;
        break;
      }catch(e){
        lastErr = e;
        console.log(`IATA map: source failed (${url}): ${String(e?.message ?? e)}`);
      }
    }
    if (!csv) throw lastErr || new Error('IATA map: all sources failed');
  }

  const lines = csv.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]);
  const idxIdent = header.indexOf('ident');
  const idxIata = header.indexOf('iata_code');
  const idxName = header.indexOf('name');
  const idxLat = header.indexOf('latitude_deg');
  const idxLon = header.indexOf('longitude_deg');

  const want = new Set(missing);
  for(let i=1;i<lines.length && want.size;i++){
    const cols = parseCsvLine(lines[i]);
    const ident = (cols[idxIdent] || '').toUpperCase();
    if(!want.has(ident)) continue;
    const iata = (cols[idxIata] || '').toUpperCase().trim();
    const name = (cols[idxName] || '').trim();
    const lat = (idxLat >= 0 && cols[idxLat] !== '') ? Number(cols[idxLat]) : null;
    const lon = (idxLon >= 0 && cols[idxLon] !== '') ? Number(cols[idxLon]) : null;
    existing[ident] = {
      iata: iata || null,
      name: name || null,
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
    };
    want.delete(ident);
  }

  // Whatever is still missing -> keep placeholder
  for(const m of want){
    existing[m] = { iata: null, name: null, lat: null, lon: null };
  }

  return existing;
}


async function buildRunwaysMap(icaos){
  // Creates OUT_RUNWAYS with runway headings/widths for crosswind advisory.
  const wanted = new Set(icaos);
  console.log(`Runways: downloading OurAirports runways.csv…`);
  let csv;
  {
    let lastErr = null;
    for (const url of OURAIRPORTS_RUNWAYS_URLS){
      try{
        csv = await fetchText(url);
        lastErr = null;
        break;
      }catch(e){
        lastErr = e;
        console.log(`Runways: source failed (${url}): ${String(e?.message ?? e)}`);
      }
    }
    if (!csv) throw lastErr || new Error('Runways: all sources failed');
  }

  const lines = csv.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]);

  const idxIdent = header.indexOf('airport_ident');
  const idxLeHdg = header.indexOf('le_heading_degT');
  const idxHeHdg = header.indexOf('he_heading_degT');
  const idxWidth = header.indexOf('width_ft');
  const idxLeId = header.indexOf('le_ident');
  const idxHeId = header.indexOf('he_ident');

  if (idxIdent < 0) throw new Error("runways.csv: missing airport_ident column");

  const out = {};
  for (let i=1;i<lines.length;i++){
    const cols = parseCsvLine(lines[i]);
    const icao = (cols[idxIdent] || '').toUpperCase();
    if (!wanted.has(icao)) continue;

    const le = cols[idxLeId] || '';
    const he = cols[idxHeId] || '';
    const name = (le && he) ? `${le}/${he}` : (le || he || null);

    const leH = (idxLeHdg >= 0 && cols[idxLeHdg]) ? Number(cols[idxLeHdg]) : null;
    const heH = (idxHeHdg >= 0 && cols[idxHeHdg]) ? Number(cols[idxHeHdg]) : null;
    const widthFt = (idxWidth >= 0 && cols[idxWidth]) ? Number(cols[idxWidth]) : null;
    const widthM = Number.isFinite(widthFt) ? Math.round(widthFt * 0.3048 * 10)/10 : null;

    const r = {
      name,
      le_heading: Number.isFinite(leH) ? Math.round(leH) : null,
      he_heading: Number.isFinite(heH) ? Math.round(heH) : null,
      width_m: widthM
    };

    if (!out[icao]) out[icao] = [];
    out[icao].push(r);
  }

  const airportsWithRunways = Object.keys(out).length;
  if (airportsWithRunways === 0){
    throw new Error(`runways.csv parsed but 0 matching airports found (watchlist=${icaos.length}). Source may be blocked or format changed.`);
  }

  fs.writeFileSync(OUT_RUNWAYS, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_RUNWAYS} (${airportsWithRunways} airports).`);
  return out;
}

async function main(){
  const generatedAt = new Date().toISOString();
  const errors = [];

  ensureDataDir();

  let icaos = [];
  try {
    icaos = readIcaoList();
  } catch (e) {
    errors.push(String(e?.message ?? e));
  }

  if(icaos.length === 0){
    console.log('No ICAO codes found (or airports.txt missing).');
    fs.writeFileSync(OUT_LATEST, JSON.stringify({ generatedAt, stations: [], stats: { icaoCount: 0 } , errors }, null, 2));
    writeStatus({ generatedAt, stats: { icaoCount: 0 }, errors });
    return;
  }

  console.log(`ICAO list loaded: ${icaos.length} stations. Sample: ${icaos.slice(0,10).join(', ')}`);

  const iataMap = await buildIataMap(icaos);
  fs.writeFileSync(OUT_IATA_MAP, JSON.stringify(iataMap, null, 2));

  const baseIatas = readBaseIataList();
  const baseIataSet = new Set(baseIatas);
  const baseOrder = Object.fromEntries(baseIatas.map((x,i)=>[x,i]));
  try{
    // Runways dataset is heavy and changes rarely. Refresh at most daily,
    // but always re-try if file is missing or suspiciously tiny (e.g. "{}").
    const st = fs.existsSync(OUT_RUNWAYS) ? fs.statSync(OUT_RUNWAYS) : null;
    const isTiny = !!st && st.size < 10;
    const ageMs = st ? (Date.now() - st.mtimeMs) : Number.POSITIVE_INFINITY;
    const refreshMs = 24 * 60 * 60 * 1000; // 24h

    const shouldRefresh = (!st) || isTiny || (ageMs > refreshMs);

    if (shouldRefresh){
      await buildRunwaysMap(icaos);
    }else{
      console.log(`Runways: using cached ${OUT_RUNWAYS} (age ${(ageMs/3600000).toFixed(1)}h).`);
    }
  }catch(e){
    const msg = `Runways refresh failed: ${String(e?.message ?? e)}`;
    console.log(msg);
    errors.push(msg);
    // Keep the previous runways.json if present (most useful behavior for CI hiccups).
    // If it doesn't exist, write an empty object so the frontend stays stable.
    if (!fs.existsSync(OUT_RUNWAYS)){
      fs.writeFileSync(OUT_RUNWAYS, JSON.stringify({}, null, 2));
    }
  }


  // Optional approach minima table (per-airport). Used by dashboard tiles.
  const minimaByIcao = (()=>{
    const p = path.join(ROOT, 'config', 'airport_minima.json');
    if (!fs.existsSync(p)) return {};
    try{
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return j.byIcao || j || {};
    }catch(e){
      errors.push(`Minima load failed: ${String(e?.message ?? e)}`);
      return {};
    }
  })();


  let metars = new Map();
  let tafs = new Map();

  try {
    console.log(`Fetching METAR for ${icaos.length} stations…`);
    metars = await fetchMetars(icaos);
  } catch (e) {
    errors.push(`METAR fetch failed: ${String(e?.message ?? e)}`);
  }

  try {
    console.log(`Fetching TAF for ${icaos.length} stations…`);
    tafs = await fetchTafs(icaos);
  } catch (e) {
    errors.push(`TAF fetch failed: ${String(e?.message ?? e)}`);
  }

  // Load runway map (for OM policy layer) and compile OM evaluator.
  let runwaysMap = {};
  try{
    runwaysMap = fs.existsSync(OUT_RUNWAYS) ? JSON.parse(fs.readFileSync(OUT_RUNWAYS, 'utf8')) : {};
  }catch(e){
    runwaysMap = {};
  }
  const omFn = loadOmApi(runwaysMap);

  const stations = icaos.map(icao => {
    const metar = rawToString(metars.get(icao));
    const taf = rawToString(tafs.get(icao));

    const base = {
      icao,
      iata: optStringOrNull(iataMap[icao]?.iata),
      name: optStringOrNull(iataMap[icao]?.name),
      lat: iataMap[icao]?.lat ?? null,
      lon: iataMap[icao]?.lon ?? null,
      updatedAt: metar ? (metar.match(/\b\d{6}Z\b/)?.[0] ?? null) : null,
      metarRaw: metar,
      tafRaw: taf,
      minima: minimaByIcao[icao] ?? null,
    };

    const d = computeDerivedStation(base, omFn);

    // Compatibility / quick filters: keep a few simple scalar fields alongside thin payload.
    return {
      ...d,
      visibility_m: (d.met && d.met.vis != null) ? d.met.vis : null,
      taf_visibility_m: (d.tafWorstVis != null) ? d.tafWorstVis : ((d.taf && d.taf.vis != null) ? d.taf.vis : null),
      worst_visibility_m: d.worstVis ?? null,
      ceiling_ft: d.cigAll ?? null,
      hazards: [...new Set([...(d.met?.hz ? Object.keys(d.met.hz).filter(k=>d.met.hz[k]) : []), ...(d.taf?.hz ? Object.keys(d.taf.hz).filter(k=>d.taf.hz[k]) : [])])],
      severityScore: d.severityScore ?? null,
    };
  });

  stations.sort((a,b) => (b.severityScore ?? 0) - (a.severityScore ?? 0));

  // --- Schema validation / debug -------------------------------------------
  const schemaIssues = [];
  const schemaSamples = {};
  for (const s of stations){
    const issues = schemaProbeStation(s);
    if (issues.length){
      schemaIssues.push({icao: s.icao, issues});
      if (!schemaSamples[s.icao]) schemaSamples[s.icao] = s;
    }
  }
  if (schemaIssues.length){
    errors.push(`Schema: ${schemaIssues.length} stations have non-string fields (see schema_debug.json)`);
  }
  fs.writeFileSync(OUT_SCHEMA_DEBUG, JSON.stringify({
    generatedAt,
    issueCount: schemaIssues.length,
    issues: schemaIssues.slice(0, 50),
    sample: Object.fromEntries(Object.entries(schemaSamples).slice(0, 3))
  }, null, 2));


  const stats = {
    icaoCount: icaos.length,
    metarReturned: metars.size,
    tafReturned: tafs.size,
    stationsWritten: stations.length,
    missingMetar: stations.filter(s => !s.metarRaw).length,
    missingTaf: stations.filter(s => !s.tafRaw).length
  };

  const baseStations = stations.filter(s => (s.iata && baseIataSet.has(s.iata)));
  const basePresent = new Set(baseStations.map(s=>s.iata));
  const baseMissing = baseIatas.filter(x=>!basePresent.has(x));

  // --- Change log + management brief ("Musk step") --------------------------
  const prevLatest = safeReadJson(OUT_LATEST);
  const events = diffStations(prevLatest?.stations || [], stations);
  writeRollingChanges({generatedAt, events});
  const brief = buildManagementBrief({generatedAt, stations, events, baseStations, baseMissing, baseOrder});
  fs.writeFileSync(OUT_BRIEF, JSON.stringify(brief, null, 2));

  const out = { generatedAt, stations, stats, errors };
  fs.writeFileSync(OUT_LATEST, JSON.stringify(out, null, 2));
  writeStatus({ generatedAt, stats, errors });
  console.log(`Wrote ${OUT_LATEST} with ${stations.length} stations.`);
  console.log(`Stats: ${JSON.stringify(stats)}`);
  if(errors.length) console.log(`Errors: ${errors.join(' | ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
