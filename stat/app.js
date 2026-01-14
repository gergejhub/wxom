
/* v48 – Stats: stacked pinned ALL-metrics mini charts + local pruning + crisp canvases (no external libs) */
const $ = (id)=>document.getElementById(id);

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}


function fitCanvas(canvas){
  // Make canvas crisp on high-DPI displays and responsive layouts.
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(1, Math.round(rect.width));
  const cssH = Math.max(1, Math.round(rect.height));
  const pxW = Math.max(1, Math.round(cssW * dpr));
  const pxH = Math.max(1, Math.round(cssH * dpr));
  if(canvas.width !== pxW || canvas.height !== pxH){
    canvas.width = pxW;
    canvas.height = pxH;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr,0,0,dpr,0,0);
  return { ctx, w: cssW, h: cssH, dpr };
}
const KEY_HISTORY = "wxmonitor_stats_history_v1";          // refresh entries
const KEY_SNAP    = "wxmonitor_station_snap_v2";          // latest per-station snapshot
const KEY_EVENTS  = "wxmonitor_station_events_v2";        // per-station change events
const KEY_SERIES  = "wxmonitor_station_series_v2";        // per-station time series

// local-history retention (avoid localStorage bloat / quota errors)
const MAX_HISTORY = 200;                 // refresh entries
const MAX_EVENTS_PER_ICAO = 300;         // change events per station
const MAX_SERIES_PER_ICAO = 500;         // time-series points per station
const MAX_AGE_HOURS = 48;                // prune anything older than this window

const POLL_MS = 60_000;
const EXPECTED_MIN_DEFAULT = 10;
const BUCKET_MIN = 10;

let lastGeneratedAt = null;
let rolesMap = {};
let pinnedIcao = null;

function nowMs(){ return Date.now(); }

function loadJson(key, fallback){
  try{ const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }catch{ return fallback; }
}
function saveJson(key, val){
  try{ localStorage.setItem(key, JSON.stringify(val)); }catch{}
}

function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }

function median(nums){
  const arr = (nums||[]).filter(v=>typeof v==="number" && isFinite(v)).slice().sort((a,b)=>a-b);
  if(arr.length===0) return null;
  const mid = Math.floor(arr.length/2);
  return (arr.length%2) ? arr[mid] : (arr[mid-1]+arr[mid])/2;
}

function parseVisM(raw){
  if(!raw) return null;

  const up = String(raw).toUpperCase();
  if(/\bCAVOK\b/.test(up)) return 10000;

  // Token-based parsing avoids false positives from:
  // - TAF validity/time groups (e.g. 3012/3112)
  // - RVR groups (e.g. R27/0600)
  // We only accept whitespace-delimited tokens with no '/'.
  const toks = up.trim().split(/\s+/);

  let best = null;
  const add = (m)=>{ if(m==null) return; best = (best==null)?m:Math.min(best,m); };

  for(const t of toks){
    if(!t) continue;
    if(t.includes("/")) continue;

    if(/^\d{4}$/.test(t)){
      const v = parseInt(t,10);
      if(Number.isFinite(v)) add(v===9999?10000:v);
      continue;
    }

    // statute miles
    if(/^P\d+SM$/.test(t)){
      const n = parseInt(t.slice(1,-2),10);
      if(Number.isFinite(n)) add(Math.round(n*1609.34));
      continue;
    }
    if(/^M?\d+SM$/.test(t)){
      const n = parseInt(t.replace(/^M/,"").slice(0,-2),10);
      if(Number.isFinite(n)) add(Math.round(n*1609.34));
      continue;
    }
    if(/^M?\d+\/\d+SM$/.test(t)){
      const frac = t.replace(/^M/,"").slice(0,-2);
      const [a,b] = frac.split("/").map(Number);
      if(Number.isFinite(a) && Number.isFinite(b) && b!==0){
        add(Math.round((a/b)*1609.34));
      }
      continue;
    }
  }

  return best;
}


function parseGustKt(raw){
  if(!raw) return null;
  const g = raw.match(/\b(\d{3})\d{2,3}G(\d{2,3})KT\b/);
  if(g) return parseInt(g[2],10);
  const s = raw.match(/\b(\d{3})(\d{2,3})KT\b/);
  if(s) return parseInt(s[2],10);
  return null;
}

function parseRvrMin(raw){
  if(!raw) return null;
  const matches = raw.match(/\bR\d{2}[LRC]?\/\d{4}(?:V\d{4})?\b/g) || [];
  let min = null;
  for(const t of matches){
    const mm = t.match(/\/(\d{4})/);
    if(!mm) continue;
    const v = parseInt(mm[1],10);
    if(min===null || v<min) min=v;
  }
  return min;
}

function parseCeilingFt(raw){
  if(!raw) return null;
  // Ceiling traditionally uses BKN/OVC/VV. However, many stations report only FEW/SCT.
  // For the Stats trend we prefer showing a *cloud-base trend* rather than a blank chart.
  // Logic:
  // 1) If BKN/OVC/VV exists → lowest of those (true ceiling)
  // 2) Else if FEW/SCT exists → lowest of those (cloud base proxy)
  const reCeil = /\b(BKN|OVC|VV)(\d{3})\b/g;
  let m, min=null;
  while((m=reCeil.exec(raw))!==null){
    const ft = parseInt(m[2],10)*100;
    if(min===null || ft<min) min=ft;
  }
  if(min!==null) return min;
  const reCloud = /\b(FEW|SCT)(\d{3})\b/g;
  while((m=reCloud.exec(raw))!==null){
    const ft = parseInt(m[2],10)*100;
    if(min===null || ft<min) min=ft;
  }
  return min;
}

function hasSnow(raw){
  if(!raw) return false;
  const up = String(raw).toUpperCase();

  // Weather codes can be combined (e.g. RASN, -RASN, SNRA, SHRASN).
  // Use token-aware checks rather than \bSN\b, which misses combined groups.
  const toks = up.trim().split(/\s+/).map(t=>t.trim()).filter(Boolean);

  for(const t of toks){
    if(t.includes("/")) continue;
    if(/[0-9]/.test(t)) continue;
    if(/KT$/.test(t) || /MPS$/.test(t)) continue;
    if(t.length > 10) continue;
    if(t.includes("SN")) return true;
  }

  return /\bBLSN\b/.test(up) || /\bSHSN\b/.test(up) || /\bSN\b/.test(up);
}

function wxTokens(raw){
  if(!raw) return [];
  const up = String(raw).toUpperCase();
  const toks = [];

  // Primary list still supported
  const list = ["FZFG","FG","BR","TS","TSRA","TSGR","TSGS","SQ","FZRA","FZDZ","DZ","+RA","RA","SHRA","SHSN","SN","BLSN","GR","GS"];

  // Token-aware scan to capture combined groups (e.g. RASN, -RASN, SHRASN)
  const parts = up.trim().split(/\s+/).map(t=>t.trim()).filter(Boolean).filter(t=>{
    if(t.includes("/")) return false;
    if(/[0-9]/.test(t)) return false;
    if(/KT$/.test(t) || /MPS$/.test(t)) return false;
    if(t.length > 10) return false;
    return true;
  });

  for(const t of list){
    const re = new RegExp("\\b"+t.replace("+","\\+")+"\\b");
    if(re.test(up)) toks.push(t);
  }

  if(parts.some(t=>t.includes("SN")) && !toks.includes("SN")) toks.push("SN");
  if(parts.some(t=>t.includes("RA")) && !toks.includes("RA")) toks.push("RA");
  if(parts.some(t=>t.includes("TS")) && !toks.includes("TS")) toks.push("TS");
  if(parts.some(t=>t.includes("FG")) && !toks.includes("FG")) toks.push("FG");

  return toks;
}


function metricCategory(metric){
  const m = (metric||"").toUpperCase();
  if(m.includes("VIS")) return "VIS";
  if(m.includes("RVR")) return "RVR";
  if(m.includes("CIG") || m.includes("CEIL")) return "CIG";
  if(m.includes("GUST") || m.includes("WIND")) return "GUST";
  if(m.includes("SNOW") || m.includes("BLSN") || m === "SN") return "SN";
  if(m.includes("WX") || m.includes("WEATHER")) return "WX";
  return "WX";
}

function roleOf(icao){
  const v = rolesMap[(icao||"").toUpperCase()];
  if(v==="BASE"||v==="DEST"||v==="ALT") return v;
  return "OTHER";
}
function roleRank(role){
  if(role==="BASE") return 0;
  if(role==="DEST") return 1;
  if(role==="ALT") return 2;
  return 3;
}

async function loadRoles(){
  try{
    const res = await fetch("../config/airport_roles.json?cb="+Date.now(), {cache:"no-store"});
    if(!res.ok) throw new Error("HTTP "+res.status);
    const j = await res.json();
    rolesMap = (j && typeof j === "object") ? j : {};
  }catch{
    rolesMap = {};
  }
}

function addHistoryEntry(entry){
  const hist = loadJson(KEY_HISTORY, []);
  hist.unshift(entry);

  // prune by time window first (if we have timestamps)
  const cutoff = nowMs() - (MAX_AGE_HOURS * 3600 * 1000);
  const pruned = [];
  for(const h of hist){
    const t = (h && typeof h.t === "number") ? h.t : null;
    if(t === null || t >= cutoff) pruned.push(h);
  }

  // hard cap
  if(pruned.length > MAX_HISTORY) pruned.length = MAX_HISTORY;

  saveJson(KEY_HISTORY, pruned);
}

function putStationSnap(icao, snap){
  const snaps = loadJson(KEY_SNAP, {});
  snaps[icao]=snap;
  saveJson(KEY_SNAP, snaps);
}
function getStationSnap(icao){
  const snaps = loadJson(KEY_SNAP, {});
  return snaps[icao] || null;
}

function pushEvent(icao, ev){
  const all = loadJson(KEY_EVENTS, {});
  const arr = all[icao] || [];
  arr.unshift(ev);

  // prune old events (time window)
  const cutoff = nowMs() - (MAX_AGE_HOURS * 3600 * 1000);
  const kept = [];
  for(const e of arr){
    const t = (e && typeof e.t === "number") ? e.t : null;
    if(t === null || t >= cutoff) kept.push(e);
  }

  if(kept.length > MAX_EVENTS_PER_ICAO) kept.length = MAX_EVENTS_PER_ICAO;
  all[icao] = kept;
  saveJson(KEY_EVENTS, all);
}
function getEvents(icao){
  const all = loadJson(KEY_EVENTS, {});
  return all[icao] || [];
}

function pushSeriesPoint(icao, pt){
  const all = loadJson(KEY_SERIES, {});
  const arr = all[icao] || [];
  arr.push(pt);

  // prune by time window (preferred) and by hard cap
  const cutoff = nowMs() - (MAX_AGE_HOURS * 3600 * 1000);
  let kept = arr;
  if(arr.length > 0){
    kept = arr.filter(p => {
      const t = (p && typeof p.t === "number") ? p.t : null;
      return (t === null || t >= cutoff);
    });
  }
  if(kept.length > MAX_SERIES_PER_ICAO){
    kept = kept.slice(kept.length - MAX_SERIES_PER_ICAO);
  }

  all[icao] = kept;
  saveJson(KEY_SERIES, all);
}
function getSeries(icao){
  const all = loadJson(KEY_SERIES, {});
  return all[icao] || [];
}

function computeImpact(ev){
  // impact 0..100 crude
  let imp = 0;
  const cat = metricCategory(ev.metric);
  if(cat==="VIS"){
    const v = ev.value;
    if(typeof v==="number"){
      if(v<=175) imp += 40;
      else if(v<=300) imp += 30;
      else if(v<=500) imp += 22;
      else if(v<=800) imp += 16;
      else imp += 8;
    }else imp += 10;
  }else if(cat==="GUST"){
    const g = ev.value;
    if(typeof g==="number"){
      if(g>=40) imp += 32;
      else if(g>=30) imp += 22;
      else if(g>=25) imp += 16;
      else imp += 8;
    }else imp += 10;
  }else if(cat==="SN"){
    imp += 26;
  }else if(cat==="RVR"){
    const r = ev.value;
    if(typeof r==="number"){
      if(r<=75) imp += 40;
      else if(r<=200) imp += 28;
      else if(r<=300) imp += 22;
      else if(r<=500) imp += 16;
      else imp += 8;
    }else imp += 10;
  }else if(cat==="CIG"){
    const c = ev.value;
    if(typeof c==="number"){
      if(c<500) imp += 32;
      else if(c<1000) imp += 22;
      else if(c<2000) imp += 14;
      else imp += 8;
    }else imp += 10;
  }else{
    imp += 12;
  }
  // directional emphasis
  if(ev.dir==="WORSE") imp += 8;
  return clamp(imp, 4, 100);
}

function detectChanges(icao, prev, cur){
  const t = cur.t;
  // Visibility (use METAR if available else TAF)
  const pv = prev.vis;
  const cv = cur.vis;
  if(typeof pv==="number" && typeof cv==="number" && pv!==cv){
    pushEvent(icao, {
      t, metric:"VIS", src:"OBS", dir: (cv<pv?"WORSE":"BETTER"),
      from: pv, value: cv
    });
  }else if(pv===null && typeof cv==="number"){
    pushEvent(icao, { t, metric:"VIS", src:"OBS", dir:"CHG", from:null, value:cv });
  }

  // RVR
  if(typeof prev.rvr==="number" && typeof cur.rvr==="number" && prev.rvr!==cur.rvr){
    pushEvent(icao, { t, metric:"RVR", src:"OBS", dir:(cur.rvr<prev.rvr?"WORSE":"BETTER"), from:prev.rvr, value:cur.rvr });
  }

  // Ceiling
  if(typeof prev.cig==="number" && typeof cur.cig==="number" && prev.cig!==cur.cig){
    pushEvent(icao, { t, metric:"CIG", src:"OBS", dir:(cur.cig<prev.cig?"WORSE":"BETTER"), from:prev.cig, value:cur.cig });
  }

  // Gust
  if(typeof prev.gust==="number" && typeof cur.gust==="number" && prev.gust!==cur.gust){
    pushEvent(icao, { t, metric:"GUST", src:"OBS", dir:(cur.gust>prev.gust?"WORSE":"BETTER"), from:prev.gust, value:cur.gust });
  }else if(prev.gust===null && typeof cur.gust==="number"){
    pushEvent(icao, { t, metric:"GUST", src:"OBS", dir:"CHG", from:null, value:cur.gust });
  }

  // Snow presence (obs+fcst combined)
  if(prev.snow !== cur.snow){
    pushEvent(icao, { t, metric:"SN", src:"OBS/FCST", dir:"CHG", from:prev.snow, value:cur.snow });
  }

  // WX token change (simplified)
  const pw = (prev.wx||[]).join(",");
  const cw = (cur.wx||[]).join(",");
  if(pw!==cw){
    pushEvent(icao, { t, metric:"WX", src:"OBS/FCST", dir:"CHG", from:pw, value:cw });
  }
}

function toSnap(st, tMs){
  const met = st.metarRaw || "";
  const taf = st.tafRaw || "";
  const vis = (typeof st.visibility_m==="number") ? st.visibility_m : parseVisM(met);
  const tafVis = (typeof st.taf_visibility_m==="number") ? st.taf_visibility_m : parseVisM(taf);
  const worstVis = (typeof st.worst_visibility_m==="number") ? st.worst_visibility_m : (typeof vis==="number" && typeof tafVis==="number" ? Math.min(vis,tafVis) : (vis ?? tafVis ?? null));
  const gust = parseGustKt(met) ?? parseGustKt(taf);
  const rvr = parseRvrMin(met) ?? parseRvrMin(taf);
  const cig = (typeof st.ceiling_ft === "number" ? st.ceiling_ft : null) ?? parseCeilingFt(met) ?? parseCeilingFt(taf);
  const snow = hasSnow(met) || hasSnow(taf);
  const wx = Array.from(new Set([...wxTokens(met), ...wxTokens(taf)])).slice(0,8);
  return { t: tMs, vis: worstVis, gust, rvr, cig, snow, wx };
}

function fmtTime(ms){
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  return `${hh}:${mm}`;
}
function fmtAge(ms){
  const s = Math.max(0, Math.floor((Date.now()-ms)/1000));
  const m = Math.floor(s/60), r = s%60;
  if(m<60) return `${m}m ${String(r).padStart(2,"0")}s ago`;
  const h = Math.floor(m/60);
  return `${h}h ${m%60}m ago`;
}

function renderTopHealth(data){
  const ga = data?.generatedAt ? Date.parse(data.generatedAt) : null;
  $("genAt").textContent = data?.generatedAt ? data.generatedAt.replace("T"," ").replace(".000Z","Z") : "–";
  $("genAge").textContent = ga ? fmtAge(ga) : "–";

  const hist = loadJson(KEY_HISTORY, []);
  // average interval between generatedAt changes
  const times = hist.map(h=>h.genMs).filter(Boolean);
  let avg = null;
  if(times.length>=2){
    let sum=0, n=0;
    for(let i=0;i<times.length-1;i++){
      const dt = Math.abs(times[i]-times[i+1]);
      if(dt>0){ sum += dt; n++; }
    }
    if(n>0) avg = sum/n;
  }
  $("avgInt").textContent = avg ? `${Math.round(avg/60000)} min` : "–";
  $("avgIntSub").textContent = avg ? `based on ${Math.min(times.length, 50)} updates` : "not enough data yet";

  const st = data?.stats || {};
  const total = st.totalStations ?? (data?.stations?.length ?? "–");
  const mm = st.missingMetar ?? "–";
  const mt = st.missingTaf ?? "–";
  $("counts").textContent = `${total}`;
  $("countsSub").textContent = `missing METAR: ${mm} · missing TAF: ${mt}`;

  // verdict based on age vs expected
  const expMin = EXPECTED_MIN_DEFAULT;
  const ageMin = ga ? (Date.now()-ga)/60000 : null;
  let v = "–", vs = "–";
  if(ageMin!==null){
    if(ageMin <= expMin*1.8){ v="Healthy"; vs=`updated ~${Math.round(ageMin)} min ago`; }
    else if(ageMin <= expMin*3.2){ v="Delayed"; vs=`no update for ~${Math.round(ageMin)} min`; }
    else{ v="Stale"; vs=`no update for ~${Math.round(ageMin)} min`; }
  }
  $("verdict").textContent = v;
  $("verdictSub").textContent = vs;

  // small, always-on sparklines (non-technical friendly)
  try{
    renderSparklines(hist);
  }catch{}
}

function renderSparklines(hist){
  const c1 = $("sparkRefresh");
  const c2 = $("sparkCoverage");
  if(!c1 || !c2) return;

  // use up to last 60 entries, oldest->newest
// use up to last 60 entries; ensure chronological order (oldest -> newest)
let arr = (hist||[]).slice(0,60).slice();
// Heuristic: if the first entry is newer than the last, reverse.
if(arr.length>=2 && typeof arr[0].genMs==="number" && typeof arr[arr.length-1].genMs==="number" && arr[0].genMs > arr[arr.length-1].genMs){
  arr = arr.slice().reverse();
}
  // Refresh intervals (minutes)
  const intervals = [];
  for(let i=1;i<arr.length;i++){
    const a = arr[i-1].genMs;
    const b = arr[i].genMs;
    if(typeof a !== "number" || typeof b !== "number") continue;
    const dt = Math.max(0, (b-a)/60000);
    intervals.push(dt);
  }
  // Improve subtitles with readable stats (no more "ugly" inline numbers)
  const nInt = intervals.length;
  const medInt = median(intervals);
  const sub1 = $("refreshSub");
  if(sub1){
    sub1.textContent = (medInt!==null)
      ? `Intervals between dataset updates (this browser) · median ${Math.round(medInt)} min · n=${nInt}`
      : "Intervals between dataset updates (this browser)";
  }

  const tLeft = arr.length ? fmtTime(arr[0].t) : "–";
  const tRight = arr.length ? fmtTime(arr[arr.length-1].t) : "–";
  drawSpark(c1, [{ name:"interval", values: intervals }], {
    unit: "min",
    clampMax: 90,
    xLeft: tLeft,
    xRight: tRight,
    seriesLegend: [{name:"interval", label:"Update interval"}]
  });

// Coverage: missing counts over time (align by time; keep arrays same length as arr)
const missMet = [];
const missTaf = [];
let lastMet = null;
let lastTaf = null;
for(const h of arr){
  if(typeof h.missingMetar === "number") lastMet = h.missingMetar;
  if(typeof h.missingTaf === "number") lastTaf = h.missingTaf;
  // carry-forward last known values so both series remain drawable and aligned
  missMet.push((typeof lastMet==="number") ? lastMet : 0);
  missTaf.push((typeof lastTaf==="number") ? lastTaf : 0);
}

const n = Math.max(missMet.length, missTaf.length);
const curMet = missMet.length ? missMet[missMet.length-1] : null;
const curTaf = missTaf.length ? missTaf[missTaf.length-1] : null;

const sub2 = $("coverageSub");
if(sub2){
  if(typeof curMet==="number" && typeof curTaf==="number"){
    sub2.textContent = `Missing METAR / TAF counts over time · current: METAR ${curMet} · TAF ${curTaf} · n=${n}`;
  }else{
    sub2.textContent = "Missing METAR / TAF counts over time";
  }
}

drawSpark(c2, [
  { name:"missingMetar", values: missMet },
  { name:"missingTaf", values: missTaf }
], {
  unit: "",
  yTitle: "Missing reports",
  clampMax: 60,
  multi:true,
  xLeft: tLeft,
  xRight: tRight,
  seriesLegend: [
    {name:"missingMetar", label:"METAR"},
    {name:"missingTaf", label:"TAF"},
  ]
});
}

function drawSpark(canvas, series, opts={}){
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0,0,w,h);

  // background
  ctx.fillStyle = "rgba(0,0,0,.08)";
  ctx.fillRect(0,0,w,h);

  // flatten values
  const all = [];
  for(const s of series){
    for(const v of (s.values||[])) if(typeof v === "number" && isFinite(v)) all.push(v);
  }
  if(all.length < 2){
    ctx.fillStyle = "rgba(255,255,255,.55)";
    ctx.font = "12px system-ui";
    ctx.fillText("Not enough data yet", 10, Math.floor(h/2));
    return;
  }
  let min = Math.min(...all);
  let max = Math.max(...all);
  if(typeof opts.clampMax === "number") max = Math.min(max, opts.clampMax);
  if(max - min < 0.0001){ max = min + 1; }

  // padding allows room for axis labels
  const padL = 44, padR = 12, padT = 16, padB = 22;
  const iw = w - padL - padR;
  const ih = h - padT - padB;

  // subtle backing strip for axis labels (improves legibility on dark gradients)
  ctx.fillStyle = "rgba(0,0,0,.22)";
  ctx.fillRect(0, 0, padL, h);

  // faint grid + nicer Y ticks
  ctx.strokeStyle = "rgba(255,255,255,.10)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "rgba(255,255,255,.85)";
  ctx.font = "12px system-ui";


  // compute nice tick values + draw subtle grid + readable tick labels
  const tickVals = niceTickValues(min, max, 4);
  ctx.save();
  ctx.textBaseline = "middle";
  ctx.font = "12px system-ui";
  for(const tv of tickVals){
    const frac = (max - tv) / (max - min);
    const y = padT + ih * frac;

    // grid
    ctx.strokeStyle = "rgba(255,255,255,.14)";
    ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(w-padR,y); ctx.stroke();

    // label (with tiny backdrop for legibility on gradients)
    const lbl = formatTick(tv);
    const tw = ctx.measureText(lbl).width;
    const tx = padL - 12 - tw;

    ctx.fillStyle = "rgba(0,0,0,.35)";
    ctx.fillRect(tx - 4, y - 8, tw + 8, 16);

    ctx.fillStyle = "rgba(255,255,255,.86)";
    ctx.fillText(lbl, tx, y);
  }
  ctx.restore();


  // Y axis title / unit
  const yTitle = opts.yTitle || (opts.unit ? String(opts.unit) : "");
  if(yTitle){
    // Place unit/title top-right so it never collides with Y ticks ( (fixes "mi60" overlap on TV/zoom)
    ctx.save();
    ctx.font = "11px system-ui";
    ctx.textBaseline = "top";
    const txt = String(yTitle);
    const tw = ctx.measureText(txt).width;
    const x = Math.max(padL + 6, (w - padR - tw - 8));
    const y = 6;
    // pill background
    ctx.fillStyle = "rgba(0,0,0,.38)";
    ctx.fillRect(x - 6, y - 2, tw + 12, 16);
    ctx.fillStyle = "rgba(255,255,255,.84)";
    ctx.fillText(txt, x, y);
    ctx.restore();
  }

  // X axis labels (left, center, right)
  ctx.fillStyle = "rgba(255,255,255,.75)";
  ctx.font = "12px system-ui";
  if(opts.xLeft){ ctx.fillText(String(opts.xLeft), padL, h - 6); }
  if(opts.xRight){
    const txt = String(opts.xRight);
    const tw = ctx.measureText(txt).width;
    ctx.fillText(txt, w - padR - tw, h - 6);
  }
  if(opts.xLeft && opts.xRight){
    // midpoint cue helps non-technical viewers read time
    const mid = "…";
    const tw = ctx.measureText(mid).width;
    ctx.fillText(mid, Math.floor((w-tw)/2), h - 6);
  }

  // draw each series
  const colors = ["rgba(48,240,200,.95)", "rgba(255,79,180,.95)", "rgba(102,163,255,.95)"];
  let ci = 0;
  let drawn = 0;
  for(const s of series){
    const vals = (s.values||[]).filter(v=>typeof v === "number" && isFinite(v));
    if(vals.length === 0) continue;
    if(vals.length === 1){
      // Draw a single-point series as a dot so charts never look "empty"
      const v0 = Math.min(vals[0], max);
      const x0 = padL + iw; // right edge
      const y0 = padT + ih - (ih*((v0 - min)/(max-min)));
      ctx.fillStyle = colors[ci % colors.length];
      ctx.beginPath(); ctx.arc(x0,y0,3,0,Math.PI*2); ctx.fill();
      drawn++;
      ci++;
      continue;
    }
    const n = vals.length;
    ctx.strokeStyle = colors[ci % colors.length];
    ctx.lineWidth = 2;
    ctx.beginPath();
    for(let i=0;i<n;i++){
      const x = padL + (iw*(i/(n-1)));
      const vv = Math.min(vals[i], max);
      const y = padT + ih - (ih*((vv - min)/(max-min)));
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.stroke();

    // last value dot
    const lx = padL + iw;
    const lv = Math.min(vals[n-1], max);
    const ly = padT + ih - (ih*((lv - min)/(max-min)));
    ctx.fillStyle = colors[ci % colors.length];
    ctx.beginPath(); ctx.arc(lx,ly,3,0,Math.PI*2); ctx.fill();
    ci++;
  }


  // mini legend for multi-series charts
  if(Array.isArray(opts.seriesLegend) && opts.seriesLegend.length>0){
    ctx.save();
    ctx.font = "11px system-ui";
    ctx.textBaseline = "middle";

    // compute legend width
    let wLegend = 0;
    for(let i=0;i<opts.seriesLegend.length;i++){
      const item = opts.seriesLegend[i];
      const lbl = String(item.label||item.name||"");
      wLegend += 14 + ctx.measureText(lbl).width + 12;
    }
    wLegend = Math.max(0, wLegend - 12);

    const lx0 = padL + 6;
    const ly0 = padT + 12;

    // backdrop
    ctx.fillStyle = "rgba(0,0,0,.28)";
    ctx.fillRect(lx0 - 6, ly0 - 12, Math.min(w - padL - padR - 6, wLegend + 12), 18);

    let lx = lx0;
    const ly = ly0 - 3;

    for(let i=0;i<opts.seriesLegend.length;i++){
      const item = opts.seriesLegend[i];
      const col = colors[i % colors.length];

      ctx.fillStyle = col;
      ctx.fillRect(lx, ly-6, 10, 10);
      lx += 14;

      ctx.fillStyle = "rgba(255,255,255,.85)";
      const lbl = String(item.label||item.name||"");
      ctx.fillText(lbl, lx, ly);
      lx += ctx.measureText(lbl).width + 12;
    }
    ctx.restore();
  }
}


function niceTickValues(min, max, count){
  // ensure stable nice ticks for simple sparklines
  if(!isFinite(min) || !isFinite(max)) return [0,1];
  if(max < min) [min, max] = [max, min];
  if(Math.abs(max-min) < 1e-6){
    const v = min;
    return [v, v+1];
  }
  const span = max - min;
  const rough = span / count;
  const pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
  const mult = [1,2,5,10].find(m => rough <= m*pow10) || 10;
  const step = mult * pow10;
  const start = Math.floor(min/step)*step;
  const end = Math.ceil(max/step)*step;
  const out = [];
  for(let v=end; v>=start-1e-9; v-=step){
    out.push(v);
    if(out.length>count+3) break;
  }
  // ensure includes max and min-ish
  if(out.length<2){ out.push(start); }
  return out;
}

function formatTick(v){
  // clean numeric formatting
  if(!isFinite(v)) return "–";
  const av = Math.abs(v);
  if(av >= 1000) return String(Math.round(v));
  if(av >= 100) return String(Math.round(v));
  if(av >= 10) return String(Math.round(v));
  // allow 1 decimal for small numbers
  return (Math.round(v*10)/10).toFixed((Math.round(v*10)/10)%1===0?0:1);
}

function renderLog(){
  const hist = loadJson(KEY_HISTORY, []);
  const rows = hist.slice(0,20).map(h=>{
    return `<tr>
      <td>${escapeHtml(fmtTime(h.t))}</td>
      <td>${escapeHtml(h.generatedAt || "–")}</td>
      <td>${escapeHtml(String(h.total ?? "–"))}</td>
      <td>${escapeHtml(String(h.missingMetar ?? "–"))}</td>
      <td>${escapeHtml(String(h.missingTaf ?? "–"))}</td>
    </tr>`;
  }).join("");
  $("logBody").innerHTML = rows || `<tr><td colspan="5" class="muted">No log yet.</td></tr>`;
}

function buildAtlasModel(){
  const windowMin = parseInt($("atlasWindow").value,10);
  const metricSel = $("atlasMetric").value;
  const dirSel = $("atlasDir").value;
  const roleSel = $("atlasRole").value;
  const q = ($("atlasSearch").value||"").trim().toUpperCase();

  const cut = Date.now() - windowMin*60_000;
  const allEventsMap = loadJson(KEY_EVENTS, {});
  const snapsMap = loadJson(KEY_SNAP, {});
  const icaos = Array.from(new Set([ ...Object.keys(snapsMap), ...Object.keys(allEventsMap) ]));

  const airports = [];
  for(const icao of icaos){
    const role = roleOf(icao);
    if(roleSel!=="ALL" && role!==roleSel) continue;

    // fetch latest snap for display
    const snap = getStationSnap(icao) || {};
    const iata = snap.iata || "";
    if(q){
      const hit = (icao.includes(q) || (iata||"").includes(q));
      if(!hit) continue;
    }

    // filter events by window + metric + dir
    const evs = (allEventsMap[icao] || []).filter(ev=>{
      if(!ev || typeof ev.t!=="number") return false;
      if(ev.t < cut) return false;
      const cat = metricCategory(ev.metric);
      if(metricSel!=="ALL"){
        if(metricSel==="SN"){
          if(!(cat==="SN" || (cat==="WX" && (String(ev.metric).toUpperCase().includes("SN"))))) return false;
        }else{
          if(cat !== metricSel) return false;
        }
      }
      if(dirSel==="WORSE" && ev.dir!=="WORSE") return false;
      if(dirSel==="BETTER" && ev.dir!=="BETTER") return false;
      return true;
    });

    if(evs.length===0) continue;

    // impact = max impact
    let impact=0, worse=0, better=0;
    const countsByMetric = {};
    for(const ev of evs){
      const imp = computeImpact(ev);
      if(imp>impact) impact=imp;
      if(ev.dir==="WORSE") worse++;
      else if(ev.dir==="BETTER") better++;
      const cat = metricCategory(ev.metric);
      countsByMetric[cat] = (countsByMetric[cat]||0)+1;
    }

    airports.push({ icao, iata, role, impact, worse, better, countsByMetric, evs });
  }

  // sort: role priority, then impact desc, then ICAO
  airports.sort((a,b)=>{
    const rr = roleRank(a.role)-roleRank(b.role);
    if(rr!==0) return rr;
    if(b.impact!==a.impact) return b.impact-a.impact;
    return a.icao.localeCompare(b.icao);
  });

  // buckets
  const cols = Math.ceil(windowMin / BUCKET_MIN);
  const bucketMs = BUCKET_MIN*60_000;
  const end = Date.now();
  const start = end - cols*bucketMs;

  const matrix = [];
  for(const ap of airports){
    const row = [];
    for(let c=0;c<cols;c++){
      const b0 = start + c*bucketMs;
      const b1 = b0 + bucketMs;
      const evs = ap.evs.filter(ev=>ev.t>=b0 && ev.t<b1);
      if(evs.length===0){ row.push(null); continue; }
      let w=0, be=0, ch=0, imp=0;
      const byMetric = {};
      for(const ev of evs){
        if(ev.dir==="WORSE") w++;
        else if(ev.dir==="BETTER") be++;
        else ch++;
        const iim = computeImpact(ev);
        if(iim>imp) imp=iim;
        const cat = metricCategory(ev.metric);
        byMetric[cat]=(byMetric[cat]||0)+1;
      }
      let kind="MIXED";
      if(w>0 && be===0) kind="WORSE";
      else if(be>0 && w===0) kind="BETTER";
      else kind="MIXED";
      row.push({ kind, imp, w, be, ch, byMetric, b0, b1, n: evs.length });
    }
    matrix.push(row);
  }

  return { airports, matrix, cols, start, end, bucketMs, windowMin };
}

function glyphFor(kind){
  if(kind==="WORSE") return "▼";
  if(kind==="BETTER") return "▲";
  return "◆";
}
function sizeClass(imp){
  if(imp>=55) return "sz3";
  if(imp>=28) return "sz2";
  return "sz1";
}

function renderAtlas(){
  const model = buildAtlasModel();
  const { airports, matrix, cols, start, bucketMs } = model;

  // empty state
  const hasAnyHistory = Object.keys(loadJson(KEY_EVENTS, {})).length>0;
  $("atlasEmpty").style.display = (!hasAnyHistory) ? "block" : "none";
  if(!hasAnyHistory){
    $("atlasEmpty").textContent = "No change history yet in this browser. Showing the current airport list; leave this page open until the next METAR/TAF refresh to see arrows appear.";
  }

  // KPIs
  let totalChanged=0;
  let gotWorse=0, improved=0, mostImp=0, mostTxt="–";
  let eventsInWindow=0;
  for(const ap of airports){
    if((ap.evs||[]).length>0) totalChanged++;
    gotWorse += (ap.worse>0 ? 1:0);
    improved += (ap.better>0 ? 1:0);
    eventsInWindow += ap.evs.length;
    if(ap.impact>mostImp){ mostImp=ap.impact; mostTxt=`${ap.icao}${ap.iata?(" / "+ap.iata):""} · ${ap.role}`; }
  }
  $("atlasKpis").innerHTML = `
    <div class="kpi"><div class="kpi__k">Changes in window</div><div class="kpi__v">${eventsInWindow}</div><div class="kpi__s">${totalChanged} airports</div></div>
    <div class="kpi"><div class="kpi__k">Got worse</div><div class="kpi__v">${gotWorse}</div><div class="kpi__s">airports with worsening</div></div>
    <div class="kpi"><div class="kpi__k">Improved</div><div class="kpi__v">${improved}</div><div class="kpi__s">airports with improvement</div></div>
    <div class="kpi"><div class="kpi__k">Most impacted</div><div class="kpi__v">${mostImp||0}</div><div class="kpi__s">${escapeHtml(mostTxt)}</div></div>
  `;

  // grid columns: first airport col + time cols
  const airportCol = 240;
  const cellW = 26;
  const tpl = `${airportCol}px repeat(${cols}, ${cellW}px)`;
  const table = $("atlasTable");
  table.style.gridTemplateColumns = tpl;

  const cells = [];
  // header row
  cells.push(`<div class="cell h air">Airport</div>`);
  // time labels: reduce density so it's readable at a glance
  const bucketMin = Math.max(1, Math.round(bucketMs/60000));
  let labelEvery = Math.round(60 / bucketMin);      // default: hourly
  if(cols <= 12) labelEvery = Math.round(30 / bucketMin); // shorter windows: every 30 min
  labelEvery = Math.max(1, labelEvery);
  for(let c=0;c<cols;){
    const span = Math.min(labelEvery, cols - c);
    const t = start + c*bucketMs;
    const label = fmtTime(t);
    cells.push(`<div class="cell h span" style="grid-column: span ${span};">${escapeHtml(label)}</div>`);
    c += span;
  }

  // body rows
  for(let r=0;r<airports.length;r++){
    const ap = airports[r];
    const role = ap.role;
    const roleCls = role.toLowerCase();
    const name = `${ap.icao}${ap.iata?(" / "+ap.iata):""}`;
    const isPinned = (pinnedIcao && pinnedIcao===ap.icao);
    cells.push(`<div class="cell air" data-air="${escapeHtml(ap.icao)}" title="Click to pin">
      <div class="airMain">${escapeHtml(name)}</div>
      <span class="airRole ${roleCls}">${escapeHtml(role)}</span>
    </div>`);
    for(let c=0;c<cols;c++){
      const cell = matrix[r][c];
      if(!cell){
        cells.push(`<div class="cell" data-air="${escapeHtml(ap.icao)}" data-col="${c}"></div>`);
        continue;
      }
      const cls = cell.kind==="WORSE" ? "worse" : (cell.kind==="BETTER" ? "better" : "mixed");
      const glyph = glyphFor(cell.kind);
      const sz = sizeClass(cell.imp);
      cells.push(`<div class="cell" data-air="${escapeHtml(ap.icao)}" data-col="${c}" data-has="1">
        <span class="glyph ${cls} ${sz}">${glyph}</span>
      </div>`);
    }
  }
  table.innerHTML = cells.join("");

  // interaction: pin on airport cell click
  table.querySelectorAll('.cell.air[data-air]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const icao = el.getAttribute('data-air');
      pinAirport(icao);
    });
  });

  // tooltip
  const tooltip = $("atlasTooltip");
  function hideTip(){ tooltip.style.display="none"; }
  function showTip(html, x, y){
    tooltip.innerHTML = html;
    tooltip.style.display="block";
    const pad=14;
    const w=tooltip.offsetWidth, h=tooltip.offsetHeight;
    let left=x+12, top=y+12;
    if(left+w>window.innerWidth-pad) left = x - w - 12;
    if(top+h>window.innerHeight-pad) top = y - h - 12;
    tooltip.style.left = left+"px";
    tooltip.style.top = top+"px";
  }

  table.querySelectorAll('.cell[data-has="1"]').forEach(el=>{
    el.addEventListener('mouseenter',(e)=>{
      const icao = el.getAttribute('data-air');
      const col = parseInt(el.getAttribute('data-col'),10);
      const apIdx = airports.findIndex(a=>a.icao===icao);
      if(apIdx<0) return;
      const cell = matrix[apIdx][col];
      if(!cell) return;
      const name = `${icao}${airports[apIdx].iata?(" / "+airports[apIdx].iata):""}`;
      const range = `${fmtTime(cell.b0)}–${fmtTime(cell.b1)}`;
      const bits = [];
      for(const [k,v] of Object.entries(cell.byMetric)){
        bits.push(`${k}: ${v}`);
      }
      const dirTxt = (cell.kind==="WORSE"?"Got worse":cell.kind==="BETTER"?"Improved":"Changed / mixed");
      showTip(`<div style="font-weight:900;font-size:13px;">${escapeHtml(name)}</div>
        <div style="color:rgba(255,255,255,.72);margin-top:2px;">${escapeHtml(range)} · ${escapeHtml(dirTxt)} · impact ${cell.imp}</div>
        <div style="margin-top:6px;">${escapeHtml(bits.join(" · "))}</div>`, e.clientX, e.clientY);
    });
    el.addEventListener('mouseleave', hideTip);
  });

  // auto-pin behavior based on search
  applyAutoPinFromSearch(model);

  // ensure pinned exists
  if(!pinnedIcao && airports.length){
    pinAirport(airports[0].icao, false);
  }else if(pinnedIcao){
    // if pinned filtered out, pick first
    if(!airports.some(a=>a.icao===pinnedIcao) && airports.length){
      pinAirport(airports[0].icao, false);
    }else{
      renderPinned();
    }
  }else{
    renderPinned(); // renders empty
  }
}

function applyAutoPinFromSearch(model){
  const q = ($("atlasSearch").value||"").trim().toUpperCase();
  if(!q) return;
  const aps = model.airports;
  if(aps.length===1){
    if(pinnedIcao!==aps[0].icao) pinAirport(aps[0].icao, false);
    return;
  }
  const exact = aps.find(a=>a.icao===q || a.iata===q);
  if(exact && pinnedIcao!==exact.icao){
    pinAirport(exact.icao, false);
  }
}

function eventSentence(ev){
  const when = fmtTime(ev.t);
  const cat = metricCategory(ev.metric);
  const dir = ev.dir;
  if(cat==="VIS"){
    const to = (typeof ev.value==="number") ? `${ev.value} m` : "–";
    const fr = (typeof ev.from==="number") ? `${ev.from} m` : null;
    if(dir==="WORSE") return { t:`Visibility dropped to ${to}`, s: fr ? `from ${fr} · ${when}` : `${when}` };
    if(dir==="BETTER") return { t:`Visibility improved to ${to}`, s: fr ? `from ${fr} · ${when}` : `${when}` };
    return { t:`Visibility updated: ${to}`, s:`${when}` };
  }
  if(cat==="GUST"){
    const to = (typeof ev.value==="number") ? `${ev.value} kt` : "–";
    const fr = (typeof ev.from==="number") ? `${ev.from} kt` : null;
    if(dir==="WORSE") return { t:`Wind gusts increased to ${to}`, s: fr ? `from ${fr} · ${when}` : `${when}` };
    if(dir==="BETTER") return { t:`Wind gusts eased to ${to}`, s: fr ? `from ${fr} · ${when}` : `${when}` };
    return { t:`Wind updated: ${to}`, s:`${when}` };
  }
  if(cat==="RVR"){
    const to = (typeof ev.value==="number") ? `${ev.value} m` : "–";
    const fr = (typeof ev.from==="number") ? `${ev.from} m` : null;
    if(dir==="WORSE") return { t:`Runway visibility decreased to ${to}`, s: fr ? `from ${fr} · ${when}` : `${when}` };
    if(dir==="BETTER") return { t:`Runway visibility improved to ${to}`, s: fr ? `from ${fr} · ${when}` : `${when}` };
    return { t:`Runway visibility updated: ${to}`, s:`${when}` };
  }
  if(cat==="CIG"){
    const to = (typeof ev.value==="number") ? `${ev.value} ft` : "–";
    const fr = (typeof ev.from==="number") ? `${ev.from} ft` : null;
    if(dir==="WORSE") return { t:`Ceiling lowered to ${to}`, s: fr ? `from ${fr} · ${when}` : `${when}` };
    if(dir==="BETTER") return { t:`Ceiling lifted to ${to}`, s: fr ? `from ${fr} · ${when}` : `${when}` };
    return { t:`Ceiling updated: ${to}`, s:`${when}` };
  }
  if(cat==="SN"){
    const to = ev.value ? "present" : "not present";
    return { t:`Snow is ${to}`, s:`${when}` };
  }
  // WX
  const a = (ev.from||"") ? String(ev.from) : "";
  const b = (ev.value||"") ? String(ev.value) : "";
  if(a && b) return { t:`Weather changed`, s:`${a || "–"} → ${b || "–"} · ${when}` };
  if(b) return { t:`Weather updated`, s:`${b} · ${when}` };
  return { t:`Weather updated`, s:`${when}` };
}

const METRICS = [
    { id:"VIS", key:"vis",  label:"Visibility", unit:"m",  color:"rgba(48,240,200,0.88)" },
    { id:"RVR", key:"rvr",  label:"RVR",        unit:"m",  color:"rgba(150,120,255,0.90)" },
    { id:"CIG", key:"cig",  label:"Ceiling",    unit:"ft", color:"rgba(255,200,80,0.92)" },
    { id:"GUST",key:"gust", label:"Gust",       unit:"kt", color:"rgba(255,90,200,0.90)" },
    { id:"WX",  key:"wx",   label:"Wx codes",   unit:"#",  color:"rgba(120,220,255,0.85)" },
    // Snow can easily become visually "flat" when mixed with other metrics.
    // Use a brighter tone and a dedicated top-band mapping in ALL mode.
    { id:"SN",  key:"snow", label:"Snow",       unit:"0/1",color:"rgba(210,245,255,0.95)" }
  ];

function drawMiniTimeline(canvas, series){
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0,0,w,h);
  // background
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  ctx.fillRect(0,0,w,h);
  if(!series || series.length<2){
    ctx.fillStyle="rgba(255,255,255,0.55)";
    ctx.font="12px system-ui";
    ctx.fillText("No trend yet", 10, h/2);
    return;
  }
  const xs = series.map(p=>p.t);
  const minT = xs[0], maxT = xs[xs.length-1];
  const visVals = series.map(p=> (typeof p.vis==="number"?p.vis:null)).filter(v=>v!==null);
  const gVals = series.map(p=> (typeof p.gust==="number"?p.gust:null)).filter(v=>v!==null);
  const minV = visVals.length?Math.min(...visVals):0;
  const maxV = visVals.length?Math.max(...visVals):10000;

  function xOf(t){ return 10 + (w-20) * ((t-minT)/(maxT-minT || 1)); }
  function yVis(v){ return (h-14) - (h-24) * ((v-minV)/((maxV-minV)||1)); }

  // draw vis line (thin)
  ctx.strokeStyle="rgba(48,240,200,0.75)";
  ctx.lineWidth=2;
  ctx.beginPath();
  let started=false;
  for(const p of series){
    if(typeof p.vis!=="number") continue;
    const x=xOf(p.t), y=yVis(p.vis);
    if(!started){ ctx.moveTo(x,y); started=true; } else ctx.lineTo(x,y);
  }
  ctx.stroke();

  // axes labels
  ctx.fillStyle="rgba(255,255,255,0.55)";
  ctx.font="11px system-ui";
  ctx.fillText("visibility", 10, 12);
}
function drawSmallMetric(canvas, series, metricId){
  const m = METRICS.find(x=>x.id===metricId);
  if(!m) return false;
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0,0,w,h);

  // background
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  ctx.fillRect(0,0,w,h);

  if(!series || series.length<2) return false;

  const xs = series.map(p=>p.t);
  const minT = xs[0], maxT = xs[xs.length-1];
  const vals = series.map(p=>{
    const v = p[m.key];
    return (typeof v === "number") ? v : null;
  });

  const have = vals.filter(v=>v!==null);
  if(have.length < 2) return false;

  let minV = Math.min(...have), maxV = Math.max(...have);
  if(minV === maxV){
    // provide a small band to render a visible line
    minV = minV - 1;
    maxV = maxV + 1;
  }

  const padL=8, padR=8, padT=6, padB=10;
  const xOf = (t)=> padL + ( (t-minT) / (maxT-minT || 1) ) * (w - padL - padR);
  const yOf = (v)=> padT + (1 - ( (v-minV) / (maxV-minV || 1) )) * (h - padT - padB);

  // faint baseline/grid
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const gy = yOf(minV);
  ctx.moveTo(padL, gy);
  ctx.lineTo(w-padR, gy);
  ctx.stroke();

  // plot
  ctx.strokeStyle = m.color;
  ctx.lineWidth = (m.unit==="0/1") ? 3 : 2;
  ctx.beginPath();
  let started=false;
  for(let i=0;i<series.length;i++){
    const v = vals[i];
    if(v===null) continue;
    const x = xOf(series[i].t);
    const y = yOf(v);
    if(!started){ ctx.moveTo(x,y); started=true; }
    else ctx.lineTo(x,y);
  }
  ctx.stroke();

  // time labels (subtle)
  ctx.fillStyle="rgba(255,255,255,0.45)";
  ctx.font="10.5px system-ui";
  ctx.textAlign="left";
  ctx.fillText(fmtTime(minT), padL, h-2);
  ctx.textAlign="right";
  ctx.fillText(fmtTime(maxT), w-padR, h-2);
  ctx.textAlign="left";

  return true;
}



function drawTrend(canvas, series, metricMode){
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle="rgba(255,255,255,0.03)";
  ctx.fillRect(0,0,w,h);

  if(!series || series.length<2){
    return false;
  }

  

  const mode = metricMode || "ALL";
  const chosen = (mode==="ALL") ? METRICS : METRICS.filter(m=>m.id===mode);
  if(chosen.length===0) return false;

  const minT = series[0].t;
  const maxT = series[series.length-1].t;

  const padL=46, padR=16, padT=28, padB=22;
  function xOf(t){ return padL + (w-padL-padR) * ((t-minT)/(maxT-minT || 1)); }

  // grid
  ctx.strokeStyle="rgba(255,255,255,0.08)";
  ctx.lineWidth=1;
  ctx.beginPath();
  for(let i=0;i<=4;i++){
    const y = padT + (h-padT-padB)*i/4;
    ctx.moveTo(padL,y); ctx.lineTo(w-padR,y);
  }
  ctx.stroke();

  // label + legend
  ctx.font="11px system-ui";
  ctx.fillStyle="rgba(255,255,255,0.70)";
  const title = (mode==="ALL") ? "All metrics (normalized)" : (chosen[0].label + " ("+chosen[0].unit+")");
  ctx.fillText(title, 8, 14);

  // compute ranges per metric
  const ranges = {};
  for(const m of chosen){
    const vals = series.map(p=> (typeof p[m.key]==="number" ? p[m.key] : null)).filter(v=>v!==null);
    let mn = vals.length?Math.min(...vals):0;
    let mx = vals.length?Math.max(...vals):1;
    if(mn===mx){ mx = mn + 1; }
    ranges[m.id] = { mn, mx, last: vals.length?vals[vals.length-1]:null };
  }

  // y mapping
  function yOf(mId, v){
    const r = ranges[mId];
    if(!r) return null;
    const frac = (v - r.mn)/((r.mx - r.mn) || 1);
    return (h-padB) - (h-padT-padB) * frac;
  }
  function yNorm(mId, v){
    // same as yOf but explicit for readability
    return yOf(mId, v);
  }


if(drawn===0){
  ctx.fillStyle = "rgba(255,255,255,.70)";
  ctx.font = "12px system-ui";
  ctx.fillText("No drawable series", padL + 8, Math.floor(h/2));
}

  // legend row (colored bullets + last values)
  let lx = 8, ly = 26;
  for(const m of chosen){
    const r = ranges[m.id];
    ctx.fillStyle = m.color;
    ctx.fillRect(lx, ly-8, 10, 10);
    lx += 14;
    ctx.fillStyle="rgba(255,255,255,0.80)";
    const lastTxt = (r && r.last!==null) ? (`${m.label}: ${Math.round(r.last)}${m.unit==="0/1"?"":(" "+m.unit)}`) : (`${m.label}: –`);
    ctx.fillText(lastTxt, lx, ly);
    lx += ctx.measureText(lastTxt).width + 14;
    if(lx > w-140){ lx = 8; ly += 14; }
  }

  // plot lines
  const drawOne = (m) => {
    ctx.strokeStyle = m.color;
    ctx.lineWidth = (mode==="ALL" && m.id==="SN") ? 3 : 2;
    ctx.beginPath();
    let started=false;
    for(const p of series){
      const v = p[m.key];
      if(typeof v!=="number") continue;
      const x = xOf(p.t);
      let y;
      if(mode==="ALL" && m.id==="SN"){
        // dedicated visual band near the top: snow=1 clearly visible
        const bandTop = padT + 10;
        const bandSpan = 18;
        y = bandTop + (1 - clamp(v,0,1)) * bandSpan;
      }else{
        y = (mode==="ALL") ? yNorm(m.id, v) : yOf(m.id, v);
      }
      if(y===null) continue;
      if(!started){ ctx.moveTo(x,y); started=true; } else { ctx.lineTo(x,y); }
    }
    ctx.stroke();

    // emphasize snow presence with markers (even if only intermittent)
    if(mode==="ALL" && m.id==="SN"){
      ctx.fillStyle = m.color;
      for(const p of series){
        const v = p[m.key];
        if(typeof v!=="number") continue;
        if(v < 0.5) continue;
        const x = xOf(p.t);
        const bandTop = padT + 10;
        const bandSpan = 18;
        const y = bandTop;
        ctx.beginPath(); ctx.arc(x, y, 4.0, 0, Math.PI*2); ctx.fill();
      }
    }
  };

  for(const m of chosen){
    drawOne(m);
  }

  // time labels
  ctx.fillStyle="rgba(255,255,255,0.55)";
  ctx.font="11px system-ui";
  ctx.textAlign="left";
  ctx.fillText(fmtTime(minT), padL, h-6);
  ctx.textAlign="right";
  ctx.fillText(fmtTime(maxT), w-padR, h-6);
  ctx.textAlign="left";

  // y-axis ticks for single-metric mode
  if(mode!=="ALL"){
    const m = chosen[0];
    const r = ranges[m.id];
    if(r){
      ctx.fillStyle="rgba(255,255,255,0.55)";
      ctx.font="10px system-ui";
      ctx.textAlign="left";
      ctx.fillText(String(Math.round(r.mx)), 8, padT+8);
      ctx.fillText(String(Math.round(r.mn)), 8, h-padB);
      ctx.textAlign="left";
    }
  } else {
    // normalized label
    ctx.fillStyle="rgba(255,255,255,0.45)";
    ctx.font="10px system-ui";
    ctx.fillText("min→max per metric", 8, h-6);
  }

  return true;
}
function renderPinned(){
  const badge = $("atlasBadges");
  const evBox = $("atlasEvents");
  const mini = $("miniCanvas");
  const trend = $("trendCanvas");
  const stack = $("trendStack");
  const fallback = $("trendFallback");

  if(!pinnedIcao){
    badge.textContent="–";
    evBox.innerHTML = `<div class="muted">Select an airport to see details.</div>`;
    fallback.style.display="block";
    fallback.textContent="No airport selected.";
    return;
  }

  const snap = getStationSnap(pinnedIcao) || {};
  const name = `${pinnedIcao}${snap.iata?(" / "+snap.iata):""}`;
  const role = roleOf(pinnedIcao);
  badge.textContent = `${name} · ${role}`;

  // events (last 12, filtered by current selectors)
  const metricSel = $("atlasMetric").value;
  const dirSel = $("atlasDir").value;
  const windowMin = parseInt($("atlasWindow").value,10);
  const cut = Date.now() - windowMin*60_000;

  const evs = getEvents(pinnedIcao).filter(ev=>{
    if(ev.t < cut) return false;
    const cat = metricCategory(ev.metric);
    if(metricSel!=="ALL"){
      if(metricSel==="SN"){
        if(!(cat==="SN" || (cat==="WX" && (String(ev.metric).toUpperCase().includes("SN"))))) return false;
      }else{
        if(cat !== metricSel) return false;
      }
    }
    if(dirSel==="WORSE" && ev.dir!=="WORSE") return false;
    if(dirSel==="BETTER" && ev.dir!=="BETTER") return false;
    return true;
  }).slice(0,12);

  if(evs.length===0){
    evBox.innerHTML = `<div class="muted">No events for the current filters in this time window.</div>`;
  }else{
    evBox.innerHTML = evs.map(ev=>{
      const s = eventSentence(ev);
      return `<div class="ev"><div class="ev__t">${escapeHtml(s.t)}</div><div class="ev__s">${escapeHtml(s.s)}</div></div>`;
    }).join("");
  }

  // series trend
  const series = getSeries(pinnedIcao);
  drawMiniTimeline(mini, series);

  // Single-metric mode keeps the combined trend canvas.
  // ALL mode renders a vertical stack of per-metric mini charts (clearer than multi-line normalization).
  let ok = false;
  if(metricSel === "ALL"){
    trend.style.display = "none";
    if(stack) stack.style.display = "flex";
    if(stack) stack.innerHTML = "";

    const show = METRICS.filter(m=>m.id!=="VIS"); // VIS already shown above as the pinned mini timeline
    for(const m of show){
      if(!stack) continue;
      const row = document.createElement("div");
      row.className = "trendRow";
      const last = (()=>{ 
        for(let i=series.length-1;i>=0;i--){
          const v = series[i][m.key];
          if(typeof v === "number") return v;
        }
        return null;
      })();
      const vtxt = (last===null) ? "–" : (m.unit==="0/1" ? (last ? "YES" : "NO") : `${Math.round(last)} ${m.unit}`);
      row.innerHTML = `
        <div class="trendRow__hdr">
          <div class="trendRow__lbl"><span class="trendSwatch" style="background:${m.color}"></span>${escapeHtml(m.label)}</div>
          <div class="trendRow__val">${escapeHtml(vtxt)}</div>
        </div>
        <canvas width="520" height="64" aria-label="${escapeHtml(m.label)} trend"></canvas>
      `;
      const c = row.querySelector("canvas");
      stack.appendChild(row);
      ok = drawSmallMetric(c, series, m.id) || ok;
    }

  }else{
    if(stack) stack.style.display = "none";
    trend.style.display = "block";
    ok = drawTrend(trend, series, metricSel);
  }

  if(ok){
    fallback.style.display="none";
  }else{
    fallback.style.display="block";
    fallback.textContent="Trend will appear after a few refresh cycles (new METAR/TAF updates).";
  }
}

function pinAirport(icao, rerender=true){
  pinnedIcao = (icao||"").toUpperCase();
  renderPinned();
  if(rerender) renderAtlas();
}

async function fetchLatest(){
  const res = await fetch("../data/latest.json?cb="+Date.now(), {cache:"no-store"});
  if(!res.ok) throw new Error("HTTP "+res.status);
  return await res.json();
}

async function refresh(force=false){
  let data=null;
  try{
    data = await fetchLatest();
  }catch(err){
    console.error("Stats fetch failed:", err);
    // still render what we have
    renderLog();
    renderAtlas();
    renderPinned();
    return;
  }

  const genAt = data.generatedAt || null;
  const genMs = genAt ? Date.parse(genAt) : null;

  // only record changes when generatedAt changes (or first)
  const changed = force || (genAt && genAt !== lastGeneratedAt);
  if(changed){
    lastGeneratedAt = genAt;

    addHistoryEntry({
      t: Date.now(),
      generatedAt: genAt,
      genMs,
      total: data?.stats?.totalStations ?? (data?.stations?.length ?? null),
      missingMetar: data?.stats?.missingMetar ?? null,
      missingTaf: data?.stats?.missingTaf ?? null
    });

    // per-station compare
    const tMs = genMs || Date.now();
    for(const st of (data.stations||[])){
      const icao = (st.icao||"").toUpperCase();
      if(!icao) continue;

      // keep iata for labels
      const curSnap = toSnap(st, tMs);
      curSnap.iata = (st.iata||"").toUpperCase();

      const prev = getStationSnap(icao);
      if(prev){
        detectChanges(icao, prev, curSnap);
      }
      putStationSnap(icao, curSnap);

      // series point
      pushSeriesPoint(icao, { t: tMs, vis: curSnap.vis, rvr: curSnap.rvr, cig: curSnap.cig, gust: curSnap.gust, wx: (Array.isArray(curSnap.wx)?curSnap.wx.length:null), snow: (curSnap.snow?1:0) });
    }
  }

  renderTopHealth(data);
  renderLog();
  renderAtlas();
  renderPinned();
}

function bind(){
  $("btnNow").addEventListener("click", ()=>refresh(true));
  ["atlasWindow","atlasMetric","atlasDir","atlasRole"].forEach(id=>{
    $(id).addEventListener("change", ()=>{ renderAtlas(); renderPinned(); });
  });

  let searchTimer=null;
  $("atlasSearch").addEventListener("input", ()=>{
    const q = ($("atlasSearch").value||"").trim().toUpperCase();
    clearTimeout(searchTimer);
    searchTimer=setTimeout(()=>{ renderAtlas(); }, 60);
    if(!q) return;
    const snapsMap = loadJson(KEY_SNAP, {});
    // exact ICAO match
    if(snapsMap[q]){ pinAirport(q,false); renderPinned(); return; }
    // exact IATA match (first hit)
    for(const [icao,snap] of Object.entries(snapsMap)){
      if((snap && (snap.iata||"").toUpperCase())===q){
        pinAirport(icao,false); renderPinned(); return;
      }
    }
  });
  $("atlasSearch").addEventListener("keydown",(e)=>{
    if(e.key==="Enter"){
      // pin exact match if exists after render
      const q = ($("atlasSearch").value||"").trim().toUpperCase();
      if(!q) return;
      const allEventsMap = loadJson(KEY_EVENTS, {});
      const snapsMap = loadJson(KEY_SNAP, {});
      if(snapsMap[q]){ pinAirport(q); return; }
      // try IATA exact match
      for(const [icao,snap] of Object.entries(snapsMap)){
        if((snap && (snap.iata||"").toUpperCase())===q){ pinAirport(icao); return; }
      }
      if(allEventsMap[q]){ pinAirport(q); }
    }
  });
}

(async function init(){
  try{ await loadRoles(); }catch{}
  bind();
  await refresh(true);
  setInterval(()=>refresh(false), POLL_MS);
})();
