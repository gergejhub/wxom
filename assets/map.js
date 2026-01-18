/* Wizz Air METAR/TAF Map (Leaflet)
   - Dots colored by overall alert
   - Hover popup shows raw + decoded METAR/TAF and active alerts
   - No manual inputs: OM advisory flags are derived from METAR/TAF + OurAirports runways
*/

const $ = (id) => document.getElementById(id);

const ALERT_LEVEL = { OK:0, MED:1, HIGH:2, CRIT:3 };

function alertFromScore(score){
  return score >= 70 ? "CRIT" :
         score >= 45 ? "HIGH" :
         score >= 20 ? "MED" : "OK";
}
function maxAlert(...alerts){
  let best = "OK";
  for (const a of alerts){
    if (!a) continue;
    if ((ALERT_LEVEL[a] ?? 0) > (ALERT_LEVEL[best] ?? 0)) best = a;
  }
  return best;
}

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, (c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

function parseVisibilityMeters(raw){
  if (!raw) return null;
  const up = String(raw).toUpperCase();
  if (/\bCAVOK\b/.test(up)) return 10000;

  // Prefer 4-digit meters (treat 9999 as 10km+)
  const toks = up.trim().split(/\s+/);
  for (const t of toks){
    if (/^\d{4}$/.test(t)){
      const v = parseInt(t,10);
      if (!Number.isNaN(v)) return (v === 9999 ? 10000 : v);
    }
  }

  // Statute miles (SM)
  for (const t of toks){
    if (!/SM$/.test(t)) continue;
    // Examples: 1SM, P6SM, M1/4SM, 1 1/2SM (split tokens)
    let x = t;
    if (/^P\d+SM$/.test(x)){
      const n = parseInt(x.slice(1,-2),10);
      return Number.isFinite(n) ? Math.round(n*1609.34) : null;
    }
    if (/^M?\d+SM$/.test(x)){
      const n = parseInt(x.replace(/^M/,"").slice(0,-2),10);
      return Number.isFinite(n) ? Math.round(n*1609.34) : null;
    }
    if (/^M?\d+\/\d+SM$/.test(x)){
      const frac = x.replace(/^M/,"").slice(0,-2);
      const [a,b] = frac.split("/").map(Number);
      if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) return Math.round((a/b)*1609.34);
    }
  }
  return null;
}

function extractAllVisibilityMetersFromTAF(raw){
  if (!raw) return [];
  const out = [];
  const up = String(raw).toUpperCase();
  if (/\bCAVOK\b/.test(up)) out.push(10000);
  const toks = up.trim().split(/\s+/);
  for (const t of toks){
    if (!t) continue;
    if (t.includes("/")) continue;
    if (/^\d{4}$/.test(t)){
      const v = parseInt(t,10);
      if (!Number.isNaN(v)) out.push(v === 9999 ? 10000 : v);
      continue;
    }
    if (/SM$/.test(t)){
      let m = null;
      if (/^P\d+SM$/.test(t)){
        const n = parseInt(t.slice(1,-2),10);
        m = Number.isFinite(n) ? Math.round(n*1609.34) : null;
      } else if (/^M?\d+SM$/.test(t)){
        const n = parseInt(t.replace(/^M/,"").slice(0,-2),10);
        m = Number.isFinite(n) ? Math.round(n*1609.34) : null;
      } else if (/^M?\d+\/\d+SM$/.test(t)){
        const frac = t.replace(/^M/,"").slice(0,-2);
        const [a,b] = frac.split("/").map(Number);
        if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) m = Math.round((a/b)*1609.34);
      }
      if (m != null) out.push(m);
    }
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
  const v = extractGustKt(raw);
  return v.length ? Math.max(...v) : null;
}

function ceilingFt(raw){
  if (!raw) return null;
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

function hazardFlags(raw){
  if (!raw) return {
    fzfg:false, fg:false, br:false, sn:false, ra:false, ts:false, cb:false, va:false,
    fzra:false, gr:false, pl:false, gs:false, sg:false,
    heavySn:false, heavyFzra:false, heavyHail:false
  };
  const up = String(raw).toUpperCase();
  const wxToks = up.split(/\s+/).map(t=>t.trim()).filter(Boolean).filter(t=>{
    if (t.includes("/")) return false;
    if (/[0-9]/.test(t)) return false;
    if (/KT$/.test(t) || /MPS$/.test(t)) return false;
    if (t.length > 10) return false;
    return true;
  });
  const hasWx = (needle)=>wxToks.some(t=>t.includes(needle));

  const fzra = /\bFZRA\b/.test(up) || hasWx("FZRA");
  const gr = /\b\+?GR\b/.test(up) || hasWx("GR");
  const pl = /\bPL\b/.test(up) || hasWx("PL");
  const gs = /\bGS\b/.test(up) || hasWx("GS");
  const sg = /\bSG\b/.test(up) || hasWx("SG");
  const heavySn = /\b\+SN\b/.test(up) || wxToks.some(t=>t.startsWith("+" ) && t.includes("SN"));
  const heavyFzra = /\b\+FZRA\b/.test(up);
  const heavyHail = /\b\+GR\b/.test(up);

  return {
    fzfg: /\bFZFG\b/.test(up),
    fg: /\bFG\b/.test(up) || hasWx("FG"),
    br: /\bBR\b/.test(up) || hasWx("BR"),
    sn: /\bSN\b/.test(up) || /\bSHSN\b/.test(up) || /\bBLSN\b/.test(up) || hasWx("SN"),
    ra: /\bRA\b/.test(up) || /\bDZ\b/.test(up) || hasWx("RA") || hasWx("DZ"),
    ts: /\bTS\b/.test(up) || /\bTSRA\b/.test(up) || /\bTSGR\b/.test(up) || hasWx("TS"),
    cb: /\bCB\b/.test(up) || hasWx("CB"),
    va: /\bVA\b/.test(up) || hasWx("VA"),
    fzra, gr, pl, gs, sg,
    heavySn, heavyFzra, heavyHail
  };
}

function computeScores(raw){
  const vis = parseVisibilityMeters(raw);
  const rvrMin = (()=>{
    const rv = extractRvrMeters(raw);
    return rv.length ? Math.min(...rv) : null;
  })();
  const cig = ceilingFt(raw);
  const hz = hazardFlags(raw);
  const gustMax = gustMaxKt(raw);

  // Score tuning consistent with desktop app.js
  let score = 0;
  if (vis !== null){
    if (vis <= 150) score += 30;
    else if (vis <= 175) score += 24;
    else if (vis <= 250) score += 18;
    else if (vis <= 300) score += 14;
    else if (vis <= 500) score += 10;
    else if (vis <= 550) score += 8;
    else if (vis <= 800) score += 5;
  }

  if (rvrMin !== null){
    if (rvrMin <= 75) score += 30;
    else if (rvrMin <= 200) score += 22;
    else if (rvrMin <= 300) score += 16;
    else if (rvrMin <= 500) score += 8;
  }

  if (cig !== null){
    if (cig < 500) score += 22;
    else if (cig < 800) score += 12;
  }

  if (hz.ts) score += 22;
  if (hz.fzfg) score += 18;
  if (hz.fg) score += 14;
  if (hz.sn) score += 10;
  if (hz.ra) score += 8;
  if (hz.br) score += 6;

  if (gustMax !== null){
    if (gustMax >= 40) score += 10;
    else if (gustMax >= 30) score += 6;
    else if (gustMax >= 25) score += 4;
  }

  score = Math.min(100, score);
  return {vis, rvrMin, cig, hz, gustMax, score};
}

function windPillarAlert(met, taf){
  const g = Math.max(met.gustMax ?? 0, taf.gustMax ?? 0);
  if (!g) return "OK";
  if (g >= 40) return "CRIT";
  if (g >= 30) return "HIGH";
  if (g >= 25) return "MED";
  return "OK";
}

function snowPillarAlert(st, met, taf){
  // Operationally prioritize any SN + low vis or low ceiling
  const sn = met.hz.sn || taf.hz.sn;
  const worstVis = (()=>{
    const vals = [];
    if (met.vis !== null) vals.push(met.vis);
    const tv = extractAllVisibilityMetersFromTAF(st.tafRaw || "");
    if (tv.length) vals.push(Math.min(...tv));
    return vals.length ? Math.min(...vals) : null;
  })();
  const cigAll = (()=>{
    const a = ceilingFt(st.metarRaw || "");
    const b = ceilingFt(st.tafRaw || "");
    if (a === null) return b;
    if (b === null) return a;
    return Math.min(a,b);
  })();

  if (!sn) return "OK";
  if (worstVis !== null && worstVis <= 300) return "HIGH";
  if (cigAll !== null && cigAll < 500) return "HIGH";
  return "MED";
}

function decodeMetar(raw){
  if (!raw) return "";
  const out = [];
  const wind = raw.match(/\b(\d{3}|VRB)(\d{2})(G(\d{2}))?KT\b/);
  if (wind){
    const g = wind[4] ? ` gust ${wind[4]} kt` : "";
    out.push(`Wind: ${wind[1]}° ${wind[2]} kt${g}`);
  }
  if (/\bCAVOK\b/i.test(raw)) out.push("Visibility: 10 km or more");
  else{
    const v = parseVisibilityMeters(raw);
    if (v !== null) out.push(`Visibility: ${v >= 10000 ? "10 km or more" : (v + " m")}`);
  }
  const hz = hazardFlags(raw);
  const wx = [];
  if (hz.fzfg) wx.push("Freezing fog");
  else if (hz.fg) wx.push("Fog");
  if (hz.br) wx.push("Mist");
  if (hz.sn) wx.push("Snow");
  if (hz.ra) wx.push("Rain/Drizzle");
  if (hz.ts) wx.push("Thunderstorm");
  if (wx.length) out.push(`Weather: ${wx.join(", ")}`);

  const q = raw.match(/\bQ(\d{4})\b/);
  if (q) out.push(`QNH: ${q[1]} hPa`);

  const cig = ceilingFt(raw);
  if (cig !== null) out.push(`Ceiling: ${cig} ft AGL`);

  return `<ul>${out.map(x=>`<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
}

function decodeTaf(raw){
  if (!raw) return "";
  const out = [];
  const vp = raw.match(/\b(\d{2})(\d{2})\/(\d{2})(\d{2})\b/);
  if (vp) out.push(`Valid: day ${vp[1]} ${vp[2]}Z → day ${vp[3]} ${vp[4]}Z`);
  const wind = raw.match(/\b(\d{3}|VRB)(\d{2})(G(\d{2}))?KT\b/);
  if (wind){
    const g = wind[4] ? ` gust ${wind[4]} kt` : "";
    out.push(`Wind: ${wind[1]}° ${wind[2]} kt${g}`);
  }
  const vals = extractAllVisibilityMetersFromTAF(raw);
  if (/\bCAVOK\b/i.test(raw)) out.push("Visibility: CAVOK");
  else if (vals.length) out.push(`Worst visibility in TAF: ${Math.min(...vals)} m`);

  const hz = hazardFlags(raw);
  const wx = [];
  if (hz.ts) wx.push("TS");
  if (hz.fzfg) wx.push("FZFG");
  if (hz.fg) wx.push("FG");
  if (hz.br) wx.push("BR");
  if (hz.sn) wx.push("SN");
  if (hz.ra) wx.push("RA/DZ");
  if (wx.length) out.push(`Weather signals: ${wx.join(", ")}`);

  const cig = ceilingFt(raw);
  if (cig !== null) out.push(`Lowest ceiling in TAF: ${cig} ft AGL`);

  return `<ul>${out.map(x=>`<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
}

function computeOmPolicy(st, met, taf, worstVis, rvrMinAll, runwaysMap){
  try{
    const api = (typeof window !== "undefined") ? window.WXM_OM : null;
    if (api && typeof api.computeOmFlags === "function"){
      return api.computeOmFlags(st, met, taf, worstVis, rvrMinAll, runwaysMap || null);
    }
  }catch(e){}
  return {
    toProhib:false, lvto:false, lvp:false, rvr125:false, xwindExceed:false, xwindKt:null, xwindLimitKt:null,
    volcanicAsh:false, tsCb:false, takeoffProhibitedWx:false, belowCat1:false, belowCat2:false, belowCat3:false, circlingBelow:false
  };
}

function deriveStation(st, runwaysMap){
  const met = computeScores(st.metarRaw || "");
  const taf = computeScores(st.tafRaw || "");

  const worstVis = (()=>{
    const vals = [];
    if (met.vis !== null) vals.push(met.vis);
    const tv = extractAllVisibilityMetersFromTAF(st.tafRaw || "");
    if (tv.length) vals.push(Math.min(...tv));
    return vals.length ? Math.min(...vals) : null;
  })();

  const allRvr = [...extractRvrMeters(st.metarRaw || ""), ...extractRvrMeters(st.tafRaw || "")];
  const rvrMinAll = allRvr.length ? Math.min(...allRvr) : null;

  const om = computeOmPolicy(st, met, taf, worstVis, rvrMinAll, runwaysMap);

  const engIceOps = (met.vis !== null && met.vis <= 150 && met.hz.fzfg);

  let severityScore = Math.max(met.score, Math.floor((taf.score || 0) * 0.85));
  if (engIceOps) severityScore = 100;

  const baseAlert = alertFromScore(severityScore);
  const alert = maxAlert(baseAlert, windPillarAlert(met, taf), snowPillarAlert(st, met, taf));

  const tags = [];
  const push = (label, cls)=>tags.push({label, cls});

  if (engIceOps) push("ENG ICE OPS", "tag--eng");
  if (alert === "CRIT") push("CRITICAL", "tag--bad");

  const worstVisM = worstVis;
  if (worstVisM !== null && worstVisM < 300) push(`VIS/RVR < 300`, "tag--warn");

  if (met.hz.ts || taf.hz.ts || met.hz.cb || taf.hz.cb) push("TS/CB", "tag--bad");
  if ((met.gustMax ?? 0) >= 25 || (taf.gustMax ?? 0) >= 25) push("WIND", "tag--wind");
  if (met.hz.sn || taf.hz.sn) push("SNOW", "tag--warn");

  // OM advisory tiles
  if (om.toProhib || om.takeoffProhibitedWx || om.tsCb) push("TO PROHIB (OM)", "tag--bad");
  if (om.lvto) push("LVTO (OM)", "tag--lvto");
  if (om.xwindExceed) push(`XWIND>${om.xwindLimitKt}KT`, "tag--wind");
  if (om.volcanicAsh) push("VA (OM)", "tag--bad");

  return {met, taf, worstVis, rvrMinAll, om, engIceOps, severityScore, alert, tags};
}

function colorForStation(derived){
  if (derived.om?.toProhib || derived.om?.takeoffProhibitedWx || derived.om?.tsCb) return "var(--wizz-mag)";
  if (derived.alert === "CRIT") return "var(--crit)";
  if (derived.alert === "HIGH") return "var(--high)";
  if (derived.alert === "MED") return "var(--med)";
  return "var(--ok)";
}

function buildPopupHtml(st, derived){
  const code = `${st.iata || st.icao || ""}`.trim();
  const sub = `${st.icao}${st.name ? ` · ${st.name}` : ""}`;

  const tags = derived.tags.length
    ? `<div class="tags">${derived.tags.map(t=>`<span class="tag ${t.cls}">${escapeHtml(t.label)}</span>`).join("")}</div>`
    : `<div class="tags"><span class="tag">No active alerts</span></div>`;

  const metRaw = st.metarRaw ? `<pre>${escapeHtml(st.metarRaw)}</pre>` : `<pre>No METAR</pre>`;
  const tafRaw = st.tafRaw ? `<pre>${escapeHtml(st.tafRaw)}</pre>` : `<pre>No TAF</pre>`;

  return `
    <div class="pop">
      <h3>${escapeHtml(code || "AIRPORT")}</h3>
      <div class="sub">${escapeHtml(sub)}${st.updatedAt ? ` · METAR ${escapeHtml(st.updatedAt)}` : ""}</div>
      ${tags}
      <div class="grid">
        <div>
          <div class="sub">METAR (raw)</div>
          ${metRaw}
          <div class="sub" style="margin-top:8px;">METAR (decoded)</div>
          ${decodeMetar(st.metarRaw || "")}
        </div>
        <div>
          <div class="sub">TAF (raw)</div>
          ${tafRaw}
          <div class="sub" style="margin-top:8px;">TAF (decoded)</div>
          ${decodeTaf(st.tafRaw || "")}
        </div>
      </div>
    </div>
  `;
}

function makeDivIcon(colorCss, isBase){
  const cls = isBase ? "markerDot markerDot--base" : "markerDot";
  return L.divIcon({
    className: "", // avoid leaflet default styles
    html: `<div class="${cls}" style="background:${colorCss}"></div>`,
    iconSize: [14,14],
    iconAnchor: [7,7]
  });
}

async function fetchJson(path){
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path} (${res.status})`);
  return await res.json();
}
async function fetchText(path){
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) return "";
  return await res.text();
}

let MAP = null;
let MARKERS = []; // {marker, st, derived}

function fitInitial(map, markers){
  const latlngs = markers.map(m => m.marker.getLatLng());
  if (!latlngs.length){
    map.setView([47.2, 19.2], 5); // fallback Hungary
    return;
  }
  const b = L.latLngBounds(latlngs);
  map.fitBounds(b.pad(0.15));
}

function applySearch(q){
  const s = String(q || "").trim().toUpperCase();
  if (!s){
    for (const m of MARKERS){ m.marker.setOpacity(1); }
    return;
  }
  for (const m of MARKERS){
    const hay = `${m.st.iata||""} ${m.st.icao||""} ${m.st.name||""}`.toUpperCase();
    const hit = hay.includes(s);
    m.marker.setOpacity(hit ? 1 : 0.12);
  }
}

async function init(){
  const status = $("mapStatus");
  const qEl = $("mapQ");

  MAP = L.map('map', {
    zoomControl: true,
    worldCopyJump: true,
    preferCanvas: true
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO'
  }).addTo(MAP);

  let baseSet = new Set();
  try{
    const baseTxt = await fetchText('base.txt');
    baseSet = new Set(baseTxt.split(/\s+/).map(x=>x.trim().toUpperCase()).filter(x=>x.length===3));
  }catch(e){}

  let runwaysMap = null;
  try{
    runwaysMap = await fetchJson('data/runways.json');
  }catch(e){
    runwaysMap = null;
  }

  const data = await fetchJson('data/latest.json');
  const stations = Array.isArray(data.stations) ? data.stations : [];

  status.textContent = `Loaded ${stations.length} stations · Generated ${data.generatedAt || "—"}`;

  for (const st of stations){
    if (st.lat == null || st.lon == null) continue;
    const derived = deriveStation(st, runwaysMap);
    const color = colorForStation(derived);
    const isBase = (st.iata && baseSet.has(String(st.iata).toUpperCase())) || false;

    const icon = makeDivIcon(color, isBase);
    const marker = L.marker([st.lat, st.lon], { icon }).addTo(MAP);

    marker.bindPopup(buildPopupHtml(st, derived), { maxWidth: 520, closeButton: false, autoPanPadding: [24,24] });

    marker.on('mouseover', ()=>marker.openPopup());
    marker.on('mouseout', ()=>marker.closePopup());

    MARKERS.push({marker, st, derived});
  }

  fitInitial(MAP, MARKERS);

  qEl.addEventListener('input', ()=>applySearch(qEl.value));
}

window.addEventListener('DOMContentLoaded', ()=>{
  init().catch((e)=>{
    const status = $("mapStatus");
    if (status) status.textContent = `Error: ${String(e?.message ?? e)}`;
    console.error(e);
  });
});
