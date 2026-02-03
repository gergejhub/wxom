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

  const toks = up.trim().split(/\s+/);
  let best = null;
  const add = (m)=>{ if (m == null) return; best = (best==null) ? m : Math.min(best, m); };

  for (let idx=0; idx<toks.length; idx++){
    const t0 = toks[idx].trim();
    if (!t0) continue;

    // Split statute miles: "1 1/2SM"
    if (/^\d+$/.test(t0) && idx+1 < toks.length){
      const t1 = toks[idx+1].trim();
      if (/^M?\d+\/\d+SM$/.test(t1)){
        const whole = parseInt(t0,10);
        const frac = t1.replace(/^M/,"").slice(0,-2);
        const [a,b] = frac.split("/").map(Number);
        if (Number.isFinite(whole) && Number.isFinite(a) && Number.isFinite(b) && b !== 0){
          add(Math.round((whole + (a/b))*1609.34));
          idx++;
          continue;
        }
      }
    }

    // Fractional statute miles token
    if (/^M?\d+\/\d+SM$/.test(t0)){
      const frac = t0.replace(/^M/,"").slice(0,-2);
      const [a,b] = frac.split("/").map(Number);
      if (Number.isFinite(a) && Number.isFinite(b) && b !== 0){
        add(Math.round((a/b)*1609.34));
      }
      continue;
    }

    // Ignore validity/time ranges and RVR groups
    if (/^\d{4}\/\d{4}$/.test(t0)) continue;
    if (/^R\d{2}[LRC]?\//.test(t0)) continue;
    if (t0.includes("/")) continue;

    // ICAO meters tokens (0400, 9999, 9999NDV)
    if (/^\d{4}(?:[A-Z]{1,4})?$/.test(t0)){
      const v = parseInt(t0.slice(0,4),10);
      if (!Number.isNaN(v)) add(v === 9999 ? 10000 : v);
      continue;
    }

    // Whole SM tokens
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
  const up = String(raw).toUpperCase();
  if (/\bCAVOK\b/.test(up)) out.push(10000);

  const toks = up.trim().split(/\s+/);
  for (let idx=0; idx<toks.length; idx++){
    const t0 = toks[idx].trim();
    if (!t0) continue;

    if (/^\d+$/.test(t0) && idx+1 < toks.length){
      const t1 = toks[idx+1].trim();
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

    if (/^M?\d+\/\d+SM$/.test(t0)){
      const frac = t0.replace(/^M/,"").slice(0,-2);
      const [a,b] = frac.split("/").map(Number);
      if (Number.isFinite(a) && Number.isFinite(b) && b !== 0){
        out.push(Math.round((a/b)*1609.34));
      }
      continue;
    }

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

/* --- Approach minima helpers (BEST/ALT) ---------------------------------- */
function effectiveVis(visM, rvrMin){
  const vals = [];
  if (typeof visM === "number") vals.push(visM);
  if (typeof rvrMin === "number") vals.push(rvrMin);
  return vals.length ? Math.min(...vals) : null;
}
function fmtM(v){
  if (typeof v !== "number") return "N/A";
  return v >= 10000 ? "10 km+" : `${Math.round(v)} m`;
}
function fmtFt(v){
  if (typeof v !== "number") return "N/A";
  return `${Math.round(v)} ft`;
}

function snippetAround(raw, token, maxLen=92){
  if (!raw || !token) return null;
  const up = String(raw).toUpperCase();
  const t = String(token).toUpperCase();
  const idx = up.indexOf(t);
  if (idx < 0) return null;
  const half = Math.floor(maxLen/2);
  const s = Math.max(0, idx - half);
  const e = Math.min(raw.length, idx + token.length + half);
  let sn = raw.slice(s, e).replace(/\s+/g, " ").trim();
  if (s > 0) sn = "..." + sn;
  if (e < raw.length) sn = sn + "...";
  return sn;
}

function findRvrToken(raw, target){
  if (!raw || typeof target !== "number") return null;
  const re = /\bR\d{2}[LRC]?\/([PM]?)(\d{4})(?:V([PM]?)(\d{4}))?([UDN])?\b/g;
  let m;
  while ((m = re.exec(raw)) !== null){
    const v1 = parseInt(m[2],10);
    const v2 = m[4] ? parseInt(m[4],10) : null;
    const vals = [v1, v2].filter(x=>Number.isFinite(x));
    if (!vals.length) continue;
    const vmin = Math.min(...vals);
    if (vmin === target) return m[0];
  }
  return null;
}

function findVisToken(raw, target){
  if (!raw || typeof target !== "number") return null;
  const up = String(raw).toUpperCase();
  if (target >= 10000){
    if (/\bCAVOK\b/.test(up)) return "CAVOK";
    if (/\b9999\b/.test(up)) return "9999";
  }
  // ICAO meters token
  const reM = /\b(\d{4})(?:NDV|[A-Z]{1,4})?\b/g;
  let m;
  while ((m = reM.exec(up)) !== null){
    const v = parseInt(m[1],10);
    if (!Number.isNaN(v)){
      const vv = (v === 9999) ? 10000 : v;
      if (vv === target) return m[0];
    }
  }
  return null;
}

function findCeilToken(raw, targetFt){
  if (!raw || typeof targetFt !== "number") return null;
  const up = String(raw).toUpperCase();
  const re = /\b(BKN|OVC|VV)(\d{3})\b/g;
  let bestTok = null;
  let bestFt = null;
  let m;
  while ((m = re.exec(up)) !== null){
    const ft = parseInt(m[2],10) * 100;
    if (!Number.isNaN(ft)){
      if (bestFt === null || ft < bestFt){
        bestFt = ft;
        bestTok = m[0];
      }
    }
  }
  if (bestFt === null) return null;
  if (Math.round(bestFt) === Math.round(targetFt)) return bestTok;
  return bestTok;
}

function buildMinimaTriggers(sourceLabel, minima, visM, rvrMin, cigFt, raw){
  // Returns: { alert: "OK"|"MED"|"CRIT", items:[{label, cls, why:[]}] }
  const items = [];
  if (!minima || (!minima.best && !minima.alt)) return {alert:"OK", items};

  const eff = effectiveVis(visM, rvrMin);

  const bestVis = (minima.best && Number.isFinite(minima.best.vis_m) && minima.best.vis_m > 0) ? minima.best.vis_m : null;
  const bestCig = (minima.best && Number.isFinite(minima.best.cig_ft) && minima.best.cig_ft > 0) ? minima.best.cig_ft : null;

  const altVis  = (minima.alt  && Number.isFinite(minima.alt.vis_m)  && minima.alt.vis_m  > 0) ? minima.alt.vis_m  : null;
  const altCig  = (minima.alt  && Number.isFinite(minima.alt.cig_ft) && minima.alt.cig_ft > 0) ? minima.alt.cig_ft : null;

  const belowBestVis = (eff != null && bestVis != null && eff < bestVis);
  const belowBestCig = (typeof cigFt === "number" && bestCig != null && cigFt < bestCig);
  const belowBest = belowBestVis || belowBestCig;

  const belowAltVis = (eff != null && altVis != null && eff < altVis);
  const belowAltCig = (typeof cigFt === "number" && altCig != null && cigFt < altCig);
  const belowAlt = belowAltVis || belowAltCig;

  const effDetail = (()=>{
    const parts = [];
    if (typeof visM === "number") parts.push(`VIS ${fmtM(visM)}`);
    if (typeof rvrMin === "number") parts.push(`RVR(min) ${fmtM(rvrMin)}`);
    if (parts.length >= 2) return `${fmtM(eff)} (min of ${parts.join(" and ")})`;
    if (parts.length === 1) return `${fmtM(eff)} (${parts[0]})`;
    return fmtM(eff);
  })();

  const addEvidence = (whyArr, token)=>{
    const sn = snippetAround(raw, token);
    if (sn) whyArr.push(`Evidence in ${sourceLabel}: ${sn}`);
    else if (token) whyArr.push(`Evidence in ${sourceLabel}: ${token}`);
  };

  const visToken = (()=>{
    if (typeof rvrMin === "number" && eff === rvrMin){
      return findRvrToken(raw, rvrMin) || findVisToken(raw, visM);
    }
    return findVisToken(raw, visM) || findRvrToken(raw, rvrMin);
  })();
  const cigToken = (typeof cigFt === "number") ? findCeilToken(raw, cigFt) : null;

  if (belowBest){
    const why = [];
    why.push("Approach minima (BEST): below the airport's best configured minima.");
    if (belowBestVis){
      why.push(`Effective visibility = ${effDetail} < BEST visibility minima ${fmtM(bestVis)}.`);
      addEvidence(why, visToken);
    }
    if (belowBestCig){
      why.push(`Ceiling = ${fmtFt(cigFt)} < BEST ceiling minima ${fmtFt(bestCig)}.`);
      addEvidence(why, cigToken);
    }
    items.push({label:"MINIMA CRIT", cls:"tag--bad", why});
    return {alert:"CRIT", items};
  }

  if (belowAlt){
    const why = [];
    why.push("Approach minima (ALT): below the second-best minima while the BEST minima is still met.");
    if (belowAltVis){
      why.push(`Effective visibility = ${effDetail} < ALT visibility minima ${fmtM(altVis)} (BEST vis minima: ${fmtM(bestVis)}).`);
      addEvidence(why, visToken);
    }
    if (belowAltCig){
      why.push(`Ceiling = ${fmtFt(cigFt)} < ALT ceiling minima ${fmtFt(altCig)} (BEST ceiling minima: ${fmtFt(bestCig)}).`);
      addEvidence(why, cigToken);
    }
    why.push("Operational interpretation: only the BEST approach remains within minima.");
    items.push({label:"MINIMA LIMIT", cls:"tag--warn", why});
    return {alert:"MED", items};
  }

  return {alert:"OK", items};
}

function hazardFlags(raw){
  // Lightweight hazards for map view.
  // Strip report header + ICAO to avoid false positives (e.g. LGTS/GCTS => 'TS').
  if (!raw) return {
    fzfg:false, fg:false, br:false, sn:false, ra:false, ts:false, cb:false, va:false,
    fzra:false, gr:false, pl:false, gs:false, sg:false,
    heavySn:false, heavyFzra:false, heavyHail:false
  };

  const upAll = String(raw).toUpperCase();

  const toksAll = upAll.split(/\s+/).map(t=>t.trim()).filter(Boolean);
  let i = 0;
  const headerSkip = new Set(["METAR","SPECI","TAF","AUTO","COR","AMD","CNL","NIL"]);
  while (i < toksAll.length && headerSkip.has(toksAll[i])) i++;
  if (i < toksAll.length && /^[A-Z]{4}$/.test(toksAll[i])) i++;
  const toks = toksAll.slice(i);
  const coreText = toks.join(" ");

  const wxToks = toks.filter(t=>{
    if (t.includes("/")) return false;
    if (/[0-9]/.test(t)) return false;
    if (/KT$/.test(t) || /MPS$/.test(t)) return false;
    if (t.length > 10) return false;
    return true;
  });
  const hasWx = (needle)=>wxToks.some(t=>t.includes(needle));
  const hasWxRe = (re)=>wxToks.some(t=>re.test(t));

  const fzra = /\bFZRA\b/.test(coreText) || hasWx("FZRA");
  const gr = /\b\+?GR\b/.test(coreText) || hasWx("GR");
  const pl = /\bPL\b/.test(coreText) || hasWx("PL");
  const gs = /\bGS\b/.test(coreText) || hasWx("GS");
  const sg = /\bSG\b/.test(coreText) || hasWx("SG");
  const heavySn = /\b\+SN\b/.test(coreText) || wxToks.some(t=>t.startsWith("+" ) && t.includes("SN"));
  const heavyFzra = /\b\+FZRA\b/.test(coreText);
  const heavyHail = /\b\+GR\b/.test(coreText);

  return {
    fzfg: /\bFZFG\b/.test(coreText),
    fg: /\bFG\b/.test(coreText) || hasWx("FG"),
    br: /\bBR\b/.test(coreText) || hasWx("BR"),
    sn: /\bSN\b/.test(coreText) || /\bSHSN\b/.test(coreText) || /\bBLSN\b/.test(coreText) || hasWx("SN"),
    ra: /\bRA\b/.test(coreText) || /\bDZ\b/.test(coreText) || hasWx("RA") || hasWx("DZ"),
    ts: hasWxRe(/^(?:\+|\-)?TS/) || hasWxRe(/^VCTS/),
    cb: /\b(?:FEW|SCT|BKN|OVC|VV)\d{3}(?:CB|TCU)\b/.test(coreText) || /\bCB\b/.test(coreText) || /\bTCU\b/.test(coreText),
    va: /\bVA\b/.test(coreText),
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
    explain: {src: null, heavyMatches: [], refVisType: null, refVisValue: null, worstVis: null, rvrMinAll: null,
      runwayCond: {cond:null, rwyccEst:null, evidence:[]}, wind:{}, xwind:{}},
    // core flags
    toProhib:false, heavyPrecip:false, heavyPrecipTokens:[],
    lvto:false, lvp:false, lvtoQualReq:false, rvr125:false,
    rvrRequired:false,
    cat2Plus:false, cat3Only:false, cat3BelowMin:false,
    xwindExceed:false, xwindKt:null, xwindLimitKt:null,
    va:false,
    noOpsLikely:false, rwyccEst:null, rwyCond:null,
    coldcorr:false
  };
}

function deriveStation(st, runwaysMap){
  const met = computeScores(st.metarRaw || "");
  const taf = computeScores(st.tafRaw || "");

  // Forecast visibility: TAF can contain multiple vis groups; prefer the minimum found
  const tafVisMin = (()=>{
    const tv = extractAllVisibilityMetersFromTAF(st.tafRaw || "");
    if (tv.length) return Math.min(...tv);
    return taf.vis;
  })();

  const rvrMinMet = met.rvrMin;
  const rvrMinTaf = (()=>{
    const rv = extractRvrMeters(st.tafRaw || "");
    return rv.length ? Math.min(...rv) : null;
  })();

  let nowAlert = alertFromScore(met.score || 0);
  let fcstAlert = alertFromScore(taf.score || 0);

  const engIceOpsMet = !!(met.hz.fzra || met.hz.pl || met.hz.gr || met.hz.gs || met.hz.sg || met.hz.heavyFzra || met.hz.heavyHail);
  const engIceOpsTaf = !!(taf.hz.fzra || taf.hz.pl || taf.hz.gr || taf.hz.gs || taf.hz.sg || taf.hz.heavyFzra || taf.hz.heavyHail);

  // OM: compute per-source so we can explain M vs T cleanly
  const stMet = Object.assign({}, st, { tafRaw: "" });
  const stTaf = Object.assign({}, st, { metarRaw: "" });

  const worstVisMet = (typeof met.vis === "number") ? met.vis : null;
  const worstVisTaf = (typeof tafVisMin === "number") ? tafVisMin : null;

  const omMet = computeOmPolicy(stMet, met, {hz:{}}, worstVisMet, rvrMinMet, runwaysMap);
  const omTaf = computeOmPolicy(stTaf, {hz:{}}, taf, worstVisTaf, rvrMinTaf, runwaysMap);

  // Trigger lists, aligned with dashboard semantics
  const now = buildWxTriggers("NOW (METAR)", met, met.vis, rvrMinMet, engIceOpsMet);
  const fcst = buildWxTriggers("FORECAST (TAF)", taf, tafVisMin, rvrMinTaf, engIceOpsTaf);
// Approach minima (airport-specific BEST/ALT) – align map behavior with the dashboard MINIMA tiles.
const minNow = buildMinimaTriggers("METAR", st.minima, met.vis, rvrMinMet, met.cig, st.metarRaw || "");
if (minNow.items.length) now.items = [...minNow.items, ...now.items];
nowAlert = maxAlert(nowAlert, minNow.alert);

const minFcst = buildMinimaTriggers("TAF", st.minima, tafVisMin, rvrMinTaf, taf.cig, st.tafRaw || "");
if (minFcst.items.length) fcst.items = [...minFcst.items, ...fcst.items];
fcstAlert = maxAlert(fcstAlert, minFcst.alert);

  const omTags = buildOmTags(omMet, omTaf);

  // Overall marker alert: worst of NOW/FORECAST + any "STOP" OM minima
  const omStop = omTags.some(t=>t.level === "STOP");
  const overallAlert = omStop ? "STOP" : maxAlert(nowAlert, fcstAlert);

  const hasAnyTrigger = (now.items.length + fcst.items.length + omTags.length) > 0 || overallAlert !== "OK";

  return {
    met, taf,
    nowAlert, fcstAlert,
    now, fcst,
    omMet, omTaf, omTags,
    overallAlert,
    hasAnyTrigger
  };
}

function buildWxTriggers(title, sc, visM, rvrMin, engIceOps){
  const items = [];

  const add = (label, cls, why=[])=>items.push({label, cls, why});

  // CRIT is based on the score ladder (desktop uses same alertFromScore)
  const a = alertFromScore(sc.score || 0);
  if (a === "CRIT") add("CRIT", "tag--bad", [
    `Severity score = ${Math.round(sc.score||0)} (CRIT threshold: ≥70)`
  ]);

  // Visibility / RVR critical trigger (dashboard: 300m)
  const vis = (typeof visM === "number") ? visM : null;
  const rvr = (typeof rvrMin === "number") ? rvrMin : null;
  if ((vis != null && vis < 300) || (rvr != null && rvr < 300)){
    const why = [];
    if (rvr != null) why.push(`RVR(min) = ${rvr} m (trigger: <300 m)`);
    if (vis != null) why.push(`VIS = ${vis} m (trigger: <300 m)`);
    add("VIS/RVR", "tag--bad", why);
  }

  // TS / CB triggers (token-based, ICAO-safe)
  if (sc.hz.ts || sc.hz.cb){
    const why = [];
    if (sc.hz.ts) why.push("Thunderstorm detected in WX tokens (e.g. TS, -TSRA, VCTS).");
    if (sc.hz.cb) why.push("CB/TCU detected (e.g. BKNxxxCB / SCTxxxTCU).");
    add("TS/CB", "tag--bad", why);
  }

  // Wind trigger (dashboard: gust >= 25kt)
  const g = (sc.gustMax ?? 0);
  if (g >= 25){
    add("WIND", "tag--wind", [
      `Gust = ${g} kt (trigger: ≥25 kt)`
    ]);
  }

  // Snow trigger
  if (sc.hz.sn){
    add("SNOW", "tag--warn", [
      "Snow / blowing snow detected (SN / SHSN / BLSN)."
    ]);
  }

  // Engine ice ops trigger
  if (engIceOps){
    add("ENG ICE OPS", "tag--eng", [
      "Icing-relevant precipitation detected (e.g. FZRA / PL / GR / GS / SG)."
    ]);
  }

  return {title, items};
}

function buildOmTags(omMet, omTaf){
  const out = [];

  const push = (label, cls, level, src, why)=>out.push({label, cls, level, src, why});

  const lvoTag = (om)=>{
    if (om.rvr125) return {label:"RVR<125", cls:"tag--bad", level:"STOP"};
    if (om.lvtoQualReq) return {label:"LVTO<150 QUAL", cls:"tag--lvto", level:"HIGH"};
    if (om.lvp) return {label:"LVP (<400)", cls:"tag--lvto", level:"MED"};
    if (om.lvto) return {label:"LVTO (<550)", cls:"tag--lvto", level:"MED"};
    return null;
  };
  const catTag = (om)=>{
    if (om.cat3BelowMin) return {label:"CAT3<75", cls:"tag--bad", level:"STOP"};
    if (om.cat3Only) return {label:"CAT3 ONLY (<200)", cls:"tag--lvto", level:"HIGH"};
    if (om.cat2Plus) return {label:"CAT2+ (<450)", cls:"tag--lvto", level:"MED"};
    return null;
  };

  const addFrom = (om, src)=>{
    if (!om) return;
    if (om.toProhib){
      push("TO PROHIB (OM)", "tag--bad", "STOP", src, explainToProhib(om));
    }
    const lvo = lvoTag(om);
    if (lvo) push(`${lvo.label} (OM)`, lvo.cls, lvo.level, src, explainLvo(om, lvo.label));
    if (om.rvrRequired){
      push("RVR REQ (<800) (OM)", "tag--warn", "MED", src, explainRvrReq(om));
    }
    const ct = catTag(om);
    if (ct) push(`${ct.label} (OM)`, ct.cls, ct.level, src, explainCat(om, ct.label));
    if (om.noOpsLikely){
      push("RWYCC<3 LIKELY (OM)", "tag--warn", "HIGH", src, explainRwycc(om));
    }
    if (om.xwindExceed){
      const lim = (om.xwindLimitKt != null) ? `${om.xwindLimitKt}KT` : "LIMIT";
      push(`XWIND>${lim} (OM)`, "tag--wind", "HIGH", src, explainXwind(om));
    }
    if (om.va){
      push("VA (OM)", "tag--bad", "HIGH", src, ["Volcanic ash (VA) detected in report."]);
    }
    if (om.coldcorr){
      push("COLD CORR (OM)", "tag--warn", "MED", src, explainCold(om));
    }
  };

  addFrom(omMet, "M");
  addFrom(omTaf, "T");

  // Merge duplicates: if same label exists in both sources, consolidate as MT
  const merged = new Map();
  for (const t of out){
    const k = t.label;
    if (!merged.has(k)){
      merged.set(k, Object.assign({}, t));
    }else{
      const cur = merged.get(k);
      cur.src = (cur.src === t.src) ? cur.src : "MT";
      // Keep the worst level
      const order = {OK:0, MED:1, HIGH:2, CRIT:3, STOP:4};
      if ((order[t.level]||0) > (order[cur.level]||0)){
        cur.level = t.level;
        cur.cls = t.cls;
      }
      // Merge whys
      cur.why = [...new Set([...(cur.why||[]), ...(t.why||[])])];
    }
  }
  return Array.from(merged.values());
}

function explainToProhib(om){
  const e = om.explain || {};
  const m = Array.isArray(e.heavyMatches) ? e.heavyMatches : [];
  if (m.length) return [
    `Matched heavy/freezing/hail/convective tokens: ${m.join(", ")}.`,
    "Operational effect: TAKEOFF PROHIBITED (OM-A heavy precipitation limitations)."
  ];
  return ["Operational effect: TAKEOFF PROHIBITED (OM-A heavy precipitation limitations)."];
}
function explainLvo(om, label){
  const e = om.explain || {};
  const parts = [];
  if (typeof e.rvrMinAll === "number") parts.push(`RVR(min) = ${e.rvrMinAll} m.`);
  else if (typeof e.worstVis === "number") parts.push(`VIS(worst) = ${e.worstVis} m.`);
  if (label.includes("550")) parts.push("Threshold: LVTO < 550 m.");
  if (label.includes("400")) parts.push("Threshold: LVP required below 400 m.");
  if (label.includes("150")) parts.push("Threshold: crew qualification below 150 m.");
  if (label.includes("125")) parts.push("Threshold: below 125 m (below minima).");
  return parts.length ? parts : ["Low visibility takeoff band (OM-A)."];
}
function explainRvrReq(om){
  const e = om.explain || {};
  const out = [];
  if (typeof e.worstVis === "number") out.push(`VIS/CMV = ${e.worstVis} m (<800 m).`);
  out.push("RVR reporting required when VIS/CMV < 800 m (approach/landing context).");
  if (e.rvrAny === false) out.push("No RVR group present in the report.");
  return out;
}
function explainCat(om, label){
  const e = om.explain || {};
  const out = [];
  if (typeof e.rvrMinAll === "number") out.push(`RVR(min) = ${e.rvrMinAll} m.`);
  if (label.includes("450")) out.push("CAT II+ environment (RVR < 450 m).");
  if (label.includes("200")) out.push("CAT III only environment (RVR < 200 m).");
  if (label.includes("75")) out.push("Below CAT III minima (RVR < 75 m).");
  return out.length ? out : ["Approach category band (OM-A)."];
}
function explainRwycc(om){
  const e = om.explain || {};
  const rc = e.runwayCond || {};
  const ev = Array.isArray(rc.evidence) ? rc.evidence : [];
  const out = [];
  if (typeof rc.rwyccEst === "number") out.push(`Estimated RWYCC = ${rc.rwyccEst} (proxy from WX).`);
  if (ev.length) out.push(`Evidence: ${ev.join(", ")}.`);
  out.push("Advisory: RWYCC<3 implies significant contamination (OM-B crosswind/ops limitations).");
  return out;
}
function explainXwind(om){
  const e = om.explain || {};
  const x = e.xwind || {};
  const w = e.wind || {};
  const out = [];
  const d = (w.dir != null) ? `${w.dir}°` : "—";
  const spd = (w.spd != null) ? `${w.spd}kt` : "—";
  const gst = (w.gst != null) ? `G${w.gst}kt` : "";
  out.push(`Wind used: ${d} ${spd}${gst ? " "+gst : ""} (used speed: ${w.usedSpd ?? "—"}kt).`);
  if (x.available){
    out.push(`Best runway: ${x.runwayName || "—"} (hdg ${x.runwayHdg ?? "—"}°, width ${x.runwayWidthM ?? "—"} m${x.narrow ? ", narrow" : ""}).`);
    out.push(`Computed crosswind = ${x.xwindKt ?? "—"} kt; limit = ${x.limitKt ?? "—"} kt.`);
  }else{
    out.push("No runway geometry available (cannot compute crosswind).");
  }
  if (typeof e.runwayCond?.rwyccEst === "number") out.push(`RWYCC proxy = ${e.runwayCond.rwyccEst}.`);
  return out;
}
function explainCold(om){
  const e = om.explain || {};
  const t = (typeof e.tempC === "number") ? e.tempC : null;
  if (t == null) return ["Cold temperature conditions detected (cold correction advisory)."];
  return [`Temperature = ${t}°C (cold correction advisory).`];
}

function colorForStation(derived){
  if (derived.omTags && derived.omTags.some(t=>t.level === "STOP")) return "var(--wizz-mag)";
  const a = derived.overallAlert || "OK";
  if (a === "CRIT") return "var(--crit)";
  if (a === "HIGH") return "var(--high)";
  if (a === "MED") return "var(--med)";
  return "var(--ok)";
}

function buildPopupHtml(st, derived, isBase){
  const code = `${st.iata || st.icao || ""}`.trim();
  const sub = `${st.icao || ""}${st.name ? ` · ${st.name}` : ""}`;

  const pill = (text, cls)=>`<span class="pill ${cls}">${escapeHtml(text)}</span>`;

  const nowP = pill(`NOW: ${derived.nowAlert}`, `pill--${(derived.nowAlert||"OK").toLowerCase()}`);
  const fcP = pill(`FCST: ${derived.fcstAlert}`, `pill--${(derived.fcstAlert||"OK").toLowerCase()}`);
  const stop = derived.omTags?.some(t=>t.level==="STOP");
  const omP = stop ? pill("OM: STOP", "pill--stop") : pill("OM: advisory", "pill--ok");
  const baseP = isBase ? pill("BASE", "pill--base") : "";

  const renderItems = (items)=>{
    if (!items.length) return `<div class="sub">No active triggers</div>`;
    return `
      <div class="tags">${items.map(it=>`<span class="tag ${it.cls}">${escapeHtml(it.label)}</span>`).join("")}</div>
      <div class="why"><ul>${items.map(it=>{
        const whys = (it.why||[]).map(w=>`<li>${escapeHtml(w)}</li>`).join("");
        return whys ? `<li><b>${escapeHtml(it.label)}:</b><ul>${whys}</ul></li>` : `<li><b>${escapeHtml(it.label)}</b></li>`;
      }).join("")}</ul></div>
    `;
  };

  const renderOm = (tags)=>{
    if (!tags.length) return `<div class="sub">No OM minima/policy tags triggered</div>`;
    return `
      <div class="tags">${tags.map(t=>`<span class="tag ${t.cls}">${escapeHtml(t.label)} <span style="opacity:.75;">(${escapeHtml(t.src||"")})</span></span>`).join("")}</div>
      <div class="why"><ul>${tags.map(t=>{
        const whys = (t.why||[]).map(w=>`<li>${escapeHtml(w)}</li>`).join("");
        return whys ? `<li><b>${escapeHtml(t.label)} (${escapeHtml(t.src||"")})</b><ul>${whys}</ul></li>` : `<li><b>${escapeHtml(t.label)} (${escapeHtml(t.src||"")})</b></li>`;
      }).join("")}</ul></div>
    `;
  };

  const metRaw = st.metarRaw ? `<pre>${escapeHtml(st.metarRaw)}</pre>` : `<pre>No METAR</pre>`;
  const tafRaw = st.tafRaw ? `<pre>${escapeHtml(st.tafRaw)}</pre>` : `<pre>No TAF</pre>`;

  return `
    <div class="pop">
      <div class="popHdr">
        <div class="popTitle">
          <h3>${escapeHtml(code || "AIRPORT")}</h3>
          <div class="sub">${escapeHtml(sub)}${st.updatedAt ? ` · METAR ${escapeHtml(st.updatedAt)}` : ""}</div>
        </div>
        <div class="popPills">
          ${baseP}
          ${nowP}
          ${fcP}
          ${omP}
        </div>
      </div>

      <div class="popSect">
        <h4>NOW (METAR) – active triggers</h4>
        ${renderItems(derived.now.items)}
      </div>

      <div class="popSect">
        <h4>FORECAST (TAF) – active triggers</h4>
        ${renderItems(derived.fcst.items)}
      </div>

      <div class="popSect">
        <h4>Minima / Policy (OM) – triggered tags</h4>
        ${renderOm(derived.omTags || [])}
        <div class="sub" style="margin-top:8px;">Tip: OM tags are advisory. For full “Why?” logic, use the dashboard drawer (Minima/Policy).</div>
      </div>

      <details class="popDet">
        <summary>Raw reports</summary>
        <div class="grid" style="margin-top:8px;">
          <div>
            <div class="sub">METAR (raw)</div>
            ${metRaw}
          </div>
          <div>
            <div class="sub">TAF (raw)</div>
            ${tafRaw}
          </div>
        </div>
      </details>

      <details class="popDet">
        <summary>Decoded (quick)</summary>
        <div class="grid" style="margin-top:8px;">
          <div>
            <div class="sub">METAR (decoded)</div>
            ${decodeMetar(st.metarRaw || "")}
          </div>
          <div>
            <div class="sub">TAF (decoded)</div>
            ${decodeTaf(st.tafRaw || "")}
          </div>
        </div>
      </details>
    </div>
  `;
}

function buildTooltipHtml(st, derived, isBase){
  const code = `${st.iata || st.icao || ""}`.trim();
  const now = derived.nowAlert || "OK";
  const fc = derived.fcstAlert || "OK";
  const worst = derived.overallAlert || "OK";
  const base = isBase ? `<span class="tipPill tipPill--base">BASE</span>` : "";
  const p = (t, cls)=>`<span class="tipPill ${cls}">${escapeHtml(t)}</span>`;
  const aCls = (a)=> a === "CRIT" ? "tipPill--crit" : a === "HIGH" ? "tipPill--high" : a === "MED" ? "tipPill--med" : "tipPill--ok";
  const topNow = (derived.now?.items || []).slice(0,3).map(x=>x.label).join(" · ");
  const topFc = (derived.fcst?.items || []).slice(0,2).map(x=>x.label).join(" · ");
  const om = (derived.omTags || []).slice(0,2).map(x=>x.label).join(" · ");
  const hints = [topNow, topFc, om].filter(Boolean).join(" | ");
  return `
    <div class="tip">
      <div class="tipRow">
        <b>${escapeHtml(code || "AIRPORT")}</b>
        <span class="tipPills">
          ${base}
          ${p(`NOW ${now}`, aCls(now))}
          ${p(`FCST ${fc}`, aCls(fc))}
          ${p(worst, aCls(worst))}
        </span>
      </div>
      <div class="tipSub">${escapeHtml(hints || "Click for full details")}</div>
    </div>
  `;
}

function popupOptions(){
  // Reserve the overlay header area so the popup does not open "under" it.
  const panel = document.querySelector('.mapPanel');
  const h = panel ? Math.ceil(panel.getBoundingClientRect().height) : 0;
  const topPad = Math.max(110, h + 18);
  return {
    maxWidth: 560,
    closeButton: false,
    autoPan: true,
    autoPanPaddingTopLeft: L.point(24, topPad),
    autoPanPaddingBottomRight: L.point(24, 24),
    offset: L.point(0, 14)
  };
}

function makeDivIcon(colorCss, isBase){
  const cls = isBase ? "mkrIcon mkrIcon--base" : "mkrIcon";
  const badge = isBase ? `<span class="baseBadge">B</span>` : "";
  const size = isBase ? 30 : 22;
  const anchor = isBase ? 15 : 11;
  return L.divIcon({
    className: cls,
    html: `<div class="mkrInner"><div class="markerDot" style="background:${colorCss}"></div>${badge}</div>`,
    iconSize: [size,size],
    iconAnchor: [anchor,anchor]
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
let CLUSTERS = null;
let RUNWAYS_MAP = null;
let BASE_ICAO_SET = new Set();
let BASE_IATA_SET = new Set();

// UI filters
let FILTER_ONLY_BASES = false;
let FILTER_ONLY_TRIGGERED = false;

// When a user searches for a filtered-out airport, temporarily force it visible
const SEARCH_FORCE_VISIBLE_MS = 15 * 1000;

let MARKERS_BY_ICAO = new Map(); // icao -> L.Marker
let META_BY_ICAO = new Map();    // icao -> {st, derived, isBase}
let STATE_BY_ICAO = new Map();   // icao -> {triggered:boolean, pulseUntil:number}

let LAST_GENERATED_AT = null;
const REFRESH_MS = 60 * 1000;
const PULSE_MS = 5 * 60 * 1000;

function fitInitial(map){
  if (!CLUSTERS) return;
  const b = CLUSTERS.getBounds();
  if (!b || !b.isValid || !b.isValid()){
    map.setView([47.2, 19.2], 5); // fallback Hungary
    return;
  }
  map.fitBounds(b.pad(0.15));
}

function findMatches(q){
  const s = String(q || "").trim().toUpperCase();
  if (!s) return [];
  const out = [];
  for (const [icao, meta] of META_BY_ICAO.entries()){
    const st = meta.st;
    const hay = `${st.iata||""} ${st.icao||""} ${st.name||""}`.toUpperCase();
    if (hay.includes(s)) out.push({icao, meta});
  }
  // Prefer exact code match first
  out.sort((a,b)=>{
    const aI = (a.meta.st.iata||"").toUpperCase() === s ? -2 : 0;
    const aC = (a.meta.st.icao||"").toUpperCase() === s ? -3 : 0;
    const bI = (b.meta.st.iata||"").toUpperCase() === s ? -2 : 0;
    const bC = (b.meta.st.icao||"").toUpperCase() === s ? -3 : 0;
    const pa = aC + aI;
    const pb = bC + bI;
    if (pa !== pb) return pa - pb;
    return (a.meta.st.name||"").length - (b.meta.st.name||"").length;
  });
  return out;
}

function applySearch(q){
  const s = String(q || "").trim().toUpperCase();
  if (!s){
    for (const m of MARKERS_BY_ICAO.values()){ m.setOpacity(1); }
    return;
  }
  // Dim non-matches (markers that are currently visible; clusters may still hide them)
  for (const [icao, marker] of MARKERS_BY_ICAO.entries()){
    const meta = META_BY_ICAO.get(icao);
    const st = meta?.st || {};
    const hay = `${st.iata||""} ${st.icao||""} ${st.name||""}`.toUpperCase();
    const hit = hay.includes(s);
    marker.setOpacity(hit ? 1 : 0.18);
  }
}

function passesFilters({ isBase, derived }){
  if (FILTER_ONLY_BASES && !isBase) return false;
  if (FILTER_ONLY_TRIGGERED && !derived?.hasAnyTrigger) return false;
  return true;
}

function ensureLayerVisibility(marker, shouldBeVisible){
  if (!CLUSTERS || !marker) return;
  const inGroup = CLUSTERS.hasLayer(marker);
  if (shouldBeVisible && !inGroup) CLUSTERS.addLayer(marker);
  if (!shouldBeVisible && inGroup) CLUSTERS.removeLayer(marker);
}

function refreshFilters(){
  // Apply current filter state to all known markers.
  for (const [icao, meta] of META_BY_ICAO.entries()){
    const marker = MARKERS_BY_ICAO.get(icao);
    if (!marker) continue;
    const visible = passesFilters(meta) || (marker.__forceVisibleUntil && marker.__forceVisibleUntil > Date.now());
    ensureLayerVisibility(marker, visible);
  }
  CLUSTERS?.refreshClusters();
}

function jumpToQuery(q){
  const s = String(q || "").trim().toUpperCase();
  if (!s || !MAP) return;
  const hits = findMatches(s);
  if (!hits.length) return;
  const best = hits[0];
  const marker = MARKERS_BY_ICAO.get(best.icao);
  if (!marker || !CLUSTERS) return;

  // If filters would hide the airport, force it visible briefly so the user sees the result.
  marker.__forceVisibleUntil = Date.now() + SEARCH_FORCE_VISIBLE_MS;
  ensureLayerVisibility(marker, true);
  CLUSTERS.refreshClusters();

  // Zoom/pan so the marker becomes visible (works with clusters)
  const target = marker.getLatLng();
  const z = Math.max(MAP.getZoom(), 7);
  CLUSTERS.zoomToShowLayer(marker, ()=>{
    MAP.setView(target, z, { animate: true });
    marker.openPopup();
  });
}

async function init(){
  const status = $("mapStatus");
  const qEl = $("mapQ");
  const onlyBasesEl = $("onlyBases");
  const onlyTrigEl = $("onlyTriggered");

  MAP = L.map('map', {
    center: [48.2, 16.0],
    zoom: 4,
    zoomControl: true,
    worldCopyJump: true,
    preferCanvas: true
  });

  // IMPORTANT: move overlay panel INSIDE the Leaflet container so popup stacking works correctly.
  // (If the panel is a sibling of the map container, Leaflet popups cannot escape that stacking context.)
  try{
    const panel = document.querySelector('.mapPanel');
    const container = MAP.getContainer();
    if (panel && container && panel.parentElement !== container){
      container.appendChild(panel);
    }
  }catch(e){}

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO'
  }).addTo(MAP);

  // Marker clustering: improves readability when many airports are close together
  CLUSTERS = L.markerClusterGroup({
    maxClusterRadius: 70,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    disableClusteringAtZoom: 8,
    chunkedLoading: true,
    removeOutsideVisibleBounds: true,
    iconCreateFunction: (cluster)=>{
      const children = cluster.getAllChildMarkers();
      let worst = "OK";
      let anyBase = false;
      let anyPulse = false;
      for (const m of children){
        if (m.__overallAlert){
          worst = (worst === "STOP" || m.__overallAlert === "STOP") ? "STOP" : maxAlert(worst, m.__overallAlert);
        }
        if (m.__isBase) anyBase = true;
        if (m.__pulseUntil && m.__pulseUntil > Date.now()) anyPulse = true;
      }
      const cls = worst === "STOP" ? "clu--stop"
        : worst === "CRIT" ? "clu--crit"
        : worst === "HIGH" ? "clu--high"
        : worst === "MED" ? "clu--med" : "clu--ok";
      const baseCls = anyBase ? " clu--base" : "";
      const pulseCls = anyPulse ? " is-pulse" : "";
      const count = cluster.getChildCount();
      return L.divIcon({
        html: `<div class="clu ${cls}${baseCls}${pulseCls}">${count}</div>`,
        className: "",
        iconSize: [34,34]
      });
    }
  });
  MAP.addLayer(CLUSTERS);

  // Load runway geometry (for OM crosswind computations)
  let runwaysMap = {};
  try{
    runwaysMap = await fetchJson('data/runways.json');
  }catch(e){
    runwaysMap = {};
  }
  RUNWAYS_MAP = runwaysMap;

  // Base airports (single source of truth)
  BASE_IATA_SET = new Set();
  BASE_ICAO_SET = new Set();
  try{
    const roles = await fetchJson('config/airport_roles.json');
    for (const [icao, role] of Object.entries(roles || {})){
      if (String(role).toUpperCase() === 'BASE') BASE_ICAO_SET.add(String(icao).toUpperCase());
    }
  }catch(e){}
  try{
    // Base list lives at repo root (base.txt)
    const baseTxt = await fetchText('base.txt');
    for (const line of String(baseTxt||"").split(/\r?\n/)){
      const t = line.trim().toUpperCase();
      if (t && !t.startsWith("#")) BASE_IATA_SET.add(t);
    }
  }catch(e){}

  const refresh = async ()=>{
    try{
      const data = await fetchJson('data/latest.json');
      if (data && data.generatedAt && data.generatedAt === LAST_GENERATED_AT){
        // No new dataset, but keep pulse timers correct and update cluster icons
        refreshPulseClasses();
        CLUSTERS.refreshClusters();
        return;
      }
      LAST_GENERATED_AT = data?.generatedAt || String(Date.now());
      await updateStations(data || {});
      if (status){
        status.textContent = `Loaded ${MARKERS_BY_ICAO.size} stations · Generated ${data.generatedAt || "—"} · Auto-refresh ${Math.round(REFRESH_MS/1000)}s`;
      }
    }catch(e){
      if (status) status.textContent = `Failed to load data/latest.json (${e.message || e})`;
    }
  };

  qEl.addEventListener('input', ()=>{
    applySearch(qEl.value);
    // If exact ICAO match, jump immediately
    const s = String(qEl.value||"").trim().toUpperCase();
    if (s && MARKERS_BY_ICAO.has(s)) jumpToQuery(s);
  });
  qEl.addEventListener('change', ()=>jumpToQuery(qEl.value));
  qEl.addEventListener('keydown', (ev)=>{
    if (ev.key === "Enter"){
      ev.preventDefault();
      jumpToQuery(qEl.value);
    }
  });

  // Filters
  const onFilterChange = ()=>{
    FILTER_ONLY_BASES = !!onlyBasesEl?.checked;
    FILTER_ONLY_TRIGGERED = !!onlyTrigEl?.checked;
    refreshFilters();
    // Keep search highlighting consistent
    applySearch(qEl?.value || "");
  };
  if (onlyBasesEl) onlyBasesEl.addEventListener('change', onFilterChange);
  if (onlyTrigEl) onlyTrigEl.addEventListener('change', onFilterChange);

  await refresh();
  fitInitial(MAP);
  setInterval(refresh, REFRESH_MS);
}

async function updateStations(data){
  const stations = Array.isArray(data.stations) ? data.stations : [];
  const now = Date.now();

  // Add/update markers
  const seen = new Set();

  for (const st of stations){
    if (st.lat == null || st.lon == null) continue;
    const icao = String(st.icao || "").toUpperCase();
    if (!icao) continue;

    const isBase = BASE_ICAO_SET.has(icao) || ((st.iata || "") && BASE_IATA_SET.has(String(st.iata).toUpperCase()));
    const derived = deriveStation(st, RUNWAYS_MAP);
    const color = colorForStation(derived);

    seen.add(icao);

    let marker = MARKERS_BY_ICAO.get(icao);
    if (!marker){
      const icon = makeDivIcon(color, isBase);
      marker = L.marker([st.lat, st.lon], { icon });
      marker.__isBase = isBase;
      marker.__overallAlert = derived.overallAlert;
      marker.__pulseUntil = 0;

      // Click => full popup (dashboard-parity), Hover => compact tooltip.
      marker.bindPopup(buildPopupHtml(st, derived, isBase), popupOptions());
      marker.bindTooltip(buildTooltipHtml(st, derived, isBase), {
        className: "wxTip",
        direction: "top",
        sticky: true,
        opacity: 1,
        offset: L.point(0, -10)
      });

      // Add marker based on current filters
      const visible = passesFilters({isBase, derived});
      if (visible) CLUSTERS.addLayer(marker);
      MARKERS_BY_ICAO.set(icao, marker);
    }else{
      marker.setLatLng([st.lat, st.lon]);
      marker.setIcon(makeDivIcon(color, isBase));
      if (marker.getPopup()) marker.setPopupContent(buildPopupHtml(st, derived, isBase));
      else marker.bindPopup(buildPopupHtml(st, derived, isBase), popupOptions());
      if (marker.getTooltip()) marker.setTooltipContent(buildTooltipHtml(st, derived, isBase));
      else marker.bindTooltip(buildTooltipHtml(st, derived, isBase), {
        className: "wxTip",
        direction: "top",
        sticky: true,
        opacity: 1,
        offset: L.point(0, -10)
      });
      marker.__isBase = isBase;
      marker.__overallAlert = derived.overallAlert;
    }

    META_BY_ICAO.set(icao, {st, derived, isBase});

    // Ensure visibility according to filters (unless force-visible due to a search)
    const visible = passesFilters({isBase, derived}) || (marker.__forceVisibleUntil && marker.__forceVisibleUntil > Date.now());
    ensureLayerVisibility(marker, visible);

        // Pulse logic (newly triggered airports pulse for 5 minutes)
    const triggeredNow = !!derived.hasAnyTrigger;

    if (!STATE_BY_ICAO.has(icao)){
      // Baseline on first sight (no pulse on initial load)
      const st0 = { triggered: triggeredNow, pulseUntil: 0 };
      STATE_BY_ICAO.set(icao, st0);
      marker.__pulseUntil = 0;
      applyPulseClass(marker, 0);
    }else{
      const prev = STATE_BY_ICAO.get(icao) || {triggered:false, pulseUntil:0};
      if (triggeredNow && !prev.triggered){
        prev.pulseUntil = now + PULSE_MS;
      }
      if (!triggeredNow){
        prev.pulseUntil = 0;
      }
      prev.triggered = triggeredNow;
      STATE_BY_ICAO.set(icao, prev);

      marker.__pulseUntil = prev.pulseUntil;
      applyPulseClass(marker, prev.pulseUntil);
    }
  }

  // Remove stale markers
  for (const [icao, marker] of MARKERS_BY_ICAO.entries()){
    if (!seen.has(icao)){
      CLUSTERS.removeLayer(marker);
      MARKERS_BY_ICAO.delete(icao);
      META_BY_ICAO.delete(icao);
      STATE_BY_ICAO.delete(icao);
    }
  }

  refreshPulseClasses();
  // Clear expired forced visibility
  const t = Date.now();
  for (const marker of MARKERS_BY_ICAO.values()){
    if (marker.__forceVisibleUntil && marker.__forceVisibleUntil <= t){
      marker.__forceVisibleUntil = 0;
    }
  }
  refreshFilters();
  CLUSTERS.refreshClusters();
}

function applyPulseClass(marker, pulseUntil){
  const el = marker.getElement && marker.getElement();
  if (!el) return;
  const on = pulseUntil && pulseUntil > Date.now();
  el.classList.toggle("is-pulse", !!on);
}

function refreshPulseClasses(){
  const t = Date.now();
  for (const [icao, marker] of MARKERS_BY_ICAO.entries()){
    const st = STATE_BY_ICAO.get(icao);
    if (!st) continue;
    if (st.pulseUntil && st.pulseUntil <= t){
      st.pulseUntil = 0;
      STATE_BY_ICAO.set(icao, st);
    }
    applyPulseClass(marker, st.pulseUntil);
    marker.__pulseUntil = st.pulseUntil;
  }
}

window.addEventListener('DOMContentLoaded', ()=>{
  init().catch((e)=>{
    const status = $("mapStatus");
    if (status) status.textContent = `Error: ${String(e?.message ?? e)}`;
    console.error(e);
  });
});
