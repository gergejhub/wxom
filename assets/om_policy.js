/* OM-A/OM-B advisory policy layer (zero-manual inputs).
   - Crosswind advisory: uses OurAirports runway headings/widths (data/runways.json)
   - Runway condition is inferred conservatively from METAR/TAF wx codes (no SNOWTAM/RWYCC).
   - Outputs: st.om = { ...flags... } consumed by assets/app.js
*/

(function(){
  const SIN = Math.sin;
  const PI = Math.PI;

  function toRad(deg){ return (deg * PI) / 180; }
  function norm360(d){
    d = ((d % 360) + 360) % 360;
    return d;
  }
  function angleDiff(a,b){
    const d = Math.abs(norm360(a) - norm360(b));
    return d > 180 ? 360 - d : d;
  }

  function parseWindKt(raw){
    // Returns {dir: number|null, spd: number|null, gst: number|null}
    if (!raw) return {dir:null, spd:null, gst:null};
    const up = String(raw).toUpperCase();
    const m = up.match(/\b(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?KT\b/);
    if (!m) return {dir:null, spd:null, gst:null};
    const dir = (m[1] === "VRB") ? null : parseInt(m[1],10);
    const spd = parseInt(m[2],10);
    const gst = m[4] ? parseInt(m[4],10) : null;
    return {
      dir: Number.isFinite(dir) ? dir : null,
      spd: Number.isFinite(spd) ? spd : null,
      gst: Number.isFinite(gst) ? gst : null
    };
  }

  function parseTempC(raw){
    // Typical group: 03/M01 or M05/M10; we take first temperature
    if (!raw) return null;
    const up = String(raw).toUpperCase();
    const m = up.match(/\b(M?\d{2})\/(M?\d{2})\b/);
    if (!m) return null;
    const t = m[1];
    const v = t.startsWith("M") ? -parseInt(t.slice(1),10) : parseInt(t,10);
    return Number.isFinite(v) ? v : null;
  }

  function hasToken(raw, re){ return re.test(String(raw || "").toUpperCase()); }

  function detectVA(raw){ return hasToken(raw, /\bVA\b/); }
  function detectCB(raw){ return hasToken(raw, /\bCB\b|\bTCU\b/); }

  function detectHeavyPrecipTOProhib(raw){
    // Heavy snow (+SN), heavy snow pellets (+GS), heavy snow grains (+SG), heavy ice pellets (+PL),
    // moderate/heavy freezing rain (FZRA, +FZRA), moderate/heavy hail (GR, +GR)
    const up = String(raw || "").toUpperCase();
    return (
      /\+SN\b/.test(up) ||
      /\+GS\b/.test(up) ||
      /\+SG\b/.test(up) ||
      /\+PL\b/.test(up) ||
      /\bFZRA\b/.test(up) ||     // includes +FZRA
      /\bGR\b/.test(up)          // includes +GR
    );
  }

  function inferRunwayCondition(metarRaw, tafRaw){
    // Conservative inference:
    // - contaminated if snow/ice pellets/fzra/hail present
    // - wet if rain/drizzle present
    // - dry otherwise
    const up = `${metarRaw||""} ${tafRaw||""}`.toUpperCase();
    if (/\bSN\b|\bSG\b|\bGS\b|\bPL\b|\bFZRA\b|\bGR\b/.test(up)) return "CONTAM";
    if (/\bRA\b|\bDZ\b/.test(up)) return "WET";
    return "DRY";
  }

  function crosswindLimitKt(cond, narrow){
    // OM-B 1.3.1 crosswind limits incl gusts (company limits).
    // With no SNOWTAM depth/RWYCC, we map inferred conditions to table rows:
    // - DRY => Dry
    // - WET => Wet/Damp (<=3mm)
    // - CONTAM => Use 15kt (dry/wet snow) as a conservative default.
    if (cond === "DRY") return narrow ? 20 : 38;
    if (cond === "WET") return narrow ? 20 : 35;
    // CONTAM
    return narrow ? 10 : 15;
  }

  function computeBestCrosswind(metarRaw, runwaysForIcao){
    const w = parseWindKt(metarRaw);
    if (w.dir == null || w.spd == null) return {xwind:null, best:null, narrow:null, usedSpd:null, windDir:w.dir};
    const usedSpd = Math.max(w.spd, w.gst || 0);
    const rwys = Array.isArray(runwaysForIcao) ? runwaysForIcao : [];
    if (!rwys.length) return {xwind:null, best:null, narrow:null, usedSpd, windDir:w.dir};

    let best = null;
    for (const r of rwys){
      const headings = [];
      if (Number.isFinite(r.le_heading)) headings.push(r.le_heading);
      if (Number.isFinite(r.he_heading)) headings.push(r.he_heading);
      for (const hdg of headings){
        const ang = angleDiff(w.dir, hdg);
        const x = Math.round(usedSpd * Math.abs(SIN(toRad(ang))));
        const candidate = {
          xwind: x,
          hdg,
          width_m: Number.isFinite(r.width_m) ? r.width_m : null,
          name: r.name || r.ident || null
        };
        if (!best || candidate.xwind < best.xwind) best = candidate;
      }
    }
    if (!best) return {xwind:null, best:null, narrow:null, usedSpd, windDir:w.dir};
    const narrow = (best.width_m != null) ? (best.width_m < 45) : null;
    return {xwind: best.xwind, best, narrow, usedSpd, windDir:w.dir};
  }

  function computeOmFlags(st, met, taf, worstVis, rvrMinAll, runwaysMap){
    const metarRaw = st.metarRaw || "";
    const tafRaw = st.tafRaw || "";

    const tsOrCb = (met && met.hz && met.hz.ts) || (taf && taf.hz && taf.hz.ts) || detectCB(metarRaw) || detectCB(tafRaw);
    const heavy = detectHeavyPrecipTOProhib(metarRaw) || detectHeavyPrecipTOProhib(tafRaw);
    const toProhib = !!(tsOrCb || heavy);

    const va = detectVA(metarRaw) || detectVA(tafRaw);

    // LVTO / LVP / absolute min:
    // Prefer RVR if present, otherwise VIS. We use minimum of all detected RVR groups if available.
    const refVis = (typeof rvrMinAll === "number") ? rvrMinAll : (typeof worstVis === "number" ? worstVis : null);
    const lvto = (refVis != null) ? (refVis < 550) : false;
    const lvp = (refVis != null) ? (refVis < 400) : false;
    const rvr125 = (typeof rvrMinAll === "number") ? (rvrMinAll < 125) : false;

    const tempC = parseTempC(metarRaw);
    const coldcorr = (tempC != null) ? (tempC <= 0) : false;

    // Crosswind advisory
    const rwys = runwaysMap ? runwaysMap[st.icao] : null;
    const bestX = computeBestCrosswind(metarRaw, rwys);
    const cond = inferRunwayCondition(metarRaw, tafRaw);
    const narrow = (bestX.narrow === true);
    const xwindLimit = (bestX.xwind != null) ? crosswindLimitKt(cond, narrow) : null;
    const xwindExceed = (bestX.xwind != null && xwindLimit != null) ? (bestX.xwind > xwindLimit) : false;

    return {
      toProhib,
      tsOrCb: !!tsOrCb,
      heavyPrecip: !!heavy,
      va,
      lvto,
      lvp,
      rvr125,
      coldcorr,
      xwindExceed,
      xwindKt: bestX.xwind,
      xwindLimitKt: xwindLimit,
      xwindCond: cond,
      xwindNarrow: bestX.narrow,
      xwindUsedSpdKt: bestX.usedSpd,
      xwindWindDir: bestX.windDir
    };
  }

  // Expose globally for app.js
  window.WXM_OM = {
    parseWindKt,
    parseTempC,
    computeOmFlags
  };
})();
