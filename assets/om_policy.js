/* OM-A/OM-B advisory policy layer (zero-manual inputs).
   - Crosswind advisory: uses OurAirports runway headings/widths (data/runways.json)
   - Runway condition is inferred conservatively from METAR/TAF wx codes (no SNOWTAM/RWYCC).
   - Outputs are advisory (dispatcher aids), not operational release criteria.
   - Consumed by assets/app.js via window.WXM_OM.computeOmFlags

   Key OM references (user-provided PDFs):
   - OM-A: TAKEOFF IS PROHIBITED in specific heavy precip/freezing/hail conditions.
   - OM-A: RVR reporting requirement when VIS/CMV < 800m for approach/landing.
   - OM-A: LVP required for LVTO (RVR < 400m); crew qualification for LVTO (RVR < 150m).
   - OM-B: Crosswind limits by runway condition (RCAM / RWYCC) and narrow runway limits.
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
  function detectCB(raw){
    const up = String(raw || "").toUpperCase();
    // CB/TCU may be appended to cloud groups (e.g. BKN020CB)
    return /CB\b/.test(up) || /TCU\b/.test(up);
  }

  function detectAnyRvr(raw){
    const up = String(raw || "").toUpperCase();
    return /\bR\d{2}[LRC]?\/[PM]?\d{4}/.test(up);
  }

  function extractRvrGroups(raw){
    // Parses METAR/TAF RVR groups like: R12/0600U, R27/P2000, R04/0300V0600D
    // Returns [{rwy, q1, v1, q2, v2, trend}]
    if (!raw) return [];
    const re = /\bR(\d{2}[LRC]?)\/([PM]?)(\d{4})(?:V([PM]?)(\d{4}))?([UDN])?\b/g;
    const out = [];
    let m;
    while ((m = re.exec(String(raw))) !== null){
      out.push({
        rwy: m[1] || null,
        q1: m[2] || "",
        v1: m[3] ? parseInt(m[3],10) : null,
        q2: m[4] || "",
        v2: m[5] ? parseInt(m[5],10) : null,
        trend: m[6] || ""
      });
    }
    return out.filter(x => Number.isFinite(x.v1) || Number.isFinite(x.v2));
  }

  function heavyPrecipMatches(raw){
    // OM-A 8.3.8.7: TAKEOFF IS PROHIBITED in the following weather conditions:
    // +SN, +GS, +SG, +PL, (moderate/heavy) FZRA, (moderate/heavy) GR
    const up = String(raw || "").toUpperCase();
    const out = [];
    if (/\+SN\b/.test(up)) out.push("+SN");
    if (/\+GS\b/.test(up)) out.push("+GS");
    if (/\+SG\b/.test(up)) out.push("+SG");
    if (/\+PL\b/.test(up)) out.push("+PL");

    if (/\+FZRA\b/.test(up)) out.push("+FZRA");
    else if (/\bFZRA\b/.test(up)) out.push("FZRA");

    if (/\+GR\b/.test(up)) out.push("+GR");
    else if (/\bGR\b/.test(up)) out.push("GR");

    return out;
  }

  function detectHeavyPrecipTOProhib(raw){
    return heavyPrecipMatches(raw).length > 0;
  }


  function inferRunwayCondition(metarRaw, tafRaw){
    // Conservative inference from wx codes only.
    // Returns {cond, rwyccEst, evidence[]} (evidence are wx tokens that drove the estimate).
    // - DRY     => RWYCC 6
    // - WET     => RWYCC 5 (damp/wet)
    // - CONTAM  => RWYCC 3 (snow contamination proxy)
    // - SEVERE  => RWYCC 2 proxy (freezing rain / ice pellets / hail)
    const up = `${metarRaw||""} ${tafRaw||""}`.toUpperCase();

    const ev = [];

    const severeRe = /\b(FZRA|FZDZ|PL|GR)\b/g;
    let mm;
    while ((mm = severeRe.exec(up)) !== null) ev.push(mm[1]);
    if (ev.length){
      return {cond:"SEVERE", rwyccEst:2, evidence:[...new Set(ev)]};
    }

    const snowRe = /\b(SN|SG|GS|BLSN|DRSN|SHSN)\b/g;
    while ((mm = snowRe.exec(up)) !== null) ev.push(mm[1]);
    if (ev.length){
      return {cond:"CONTAM", rwyccEst:3, evidence:[...new Set(ev)]};
    }

    const wetRe = /\b(RA|DZ)\b/g;
    while ((mm = wetRe.exec(up)) !== null) ev.push(mm[1]);
    if (ev.length){
      return {cond:"WET", rwyccEst:5, evidence:[...new Set(ev)]};
    }

    return {cond:"DRY", rwyccEst:6, evidence:[]};
  }



  function crosswindLimitKt(rwyccEst, narrow){
    // OM-B 1.3.1 crosswind limits incl gusts (company limits).
    // Table (standard / narrow):
    // RWYCC 6: 38 / 20
    // RWYCC 5: 35 / 20
    // RWYCC 4: 20 / 10
    // RWYCC 3: 15 / 10
    // RWYCC 2: 10 /  5
    // RWYCC 1/0: NO OPS (company policy; unless specific OM-C upgrade logic)
    if (!Number.isFinite(rwyccEst)) return null;
    if (rwyccEst >= 6) return narrow ? 20 : 38;
    if (rwyccEst === 5) return narrow ? 20 : 35;
    if (rwyccEst === 4) return narrow ? 10 : 20;
    if (rwyccEst === 3) return narrow ? 10 : 15;
    if (rwyccEst === 2) return narrow ? 5  : 10;
    return null;
  }

  function computeBestCrosswind(windRaw, runwaysForIcao){
    const w = parseWindKt(windRaw);
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

    // Use the available report as the observation string for group extraction.
    // IMPORTANT: define this before any logic that checks RVR groups.
    const obsRaw = metarRaw || tafRaw;

    // Presence flags
    const tsOrCb = (met && met.hz && (met.hz.ts || met.hz.cb)) || (taf && taf.hz && (taf.hz.ts || taf.hz.cb)) || detectCB(metarRaw) || detectCB(tafRaw);
    const heavy = detectHeavyPrecipTOProhib(metarRaw) || detectHeavyPrecipTOProhib(tafRaw);
    const toProhib = !!heavy; // OM-A heavy precip list (TAKEOFF IS PROHIBITED)

    const va = detectVA(metarRaw) || detectVA(tafRaw);

    // LVTO / LVP / absolute min:
    // Prefer RVR if present, otherwise use reported MET visibility (no conversion).
    const refVis = (typeof rvrMinAll === "number") ? rvrMinAll : (typeof worstVis === "number" ? worstVis : null);
    const lvto = (refVis != null) ? (refVis < 550) : false;
    const lvp  = (refVis != null) ? (refVis < 400) : false;
    const rvr125 = (typeof rvrMinAll === "number") ? (rvrMinAll < 125) : false;

    // Commander responsibility: LVTO (RVR < 150m) requires appropriately qualified crew.
    const lvtoQualReq = (typeof rvrMinAll === "number") ? (rvrMinAll < 150) : false;

    // Approach/landing: RVR reporting must be available when VIS/CMV < 800m.
    // (Advisory flag; based on the currently-available report string.)
    const rvrRequired = (typeof worstVis === "number" && worstVis < 800) ? (!detectAnyRvr(obsRaw)) : false;

    // CAT-driven tags (generic thresholds; actual minima depend on approach category and lights)
    const cat2Plus = (typeof rvrMinAll === "number") ? (rvrMinAll < 450) : false;
    const cat3Only = (typeof rvrMinAll === "number") ? (rvrMinAll < 200) : false;
    const cat3BelowMin = (typeof rvrMinAll === "number") ? (rvrMinAll < 75) : false;

    // Cold temperature corrections flag (simple; detailed tables live in OM-A)
    const tempC = parseTempC(metarRaw);
    const coldcorr = (tempC != null) ? (tempC <= 0) : false;

    // Crosswind advisory
    const rwys = runwaysMap ? runwaysMap[st.icao] : null;
    const windRaw = obsRaw;
    const bestX = computeBestCrosswind(windRaw, rwys);
    const condInfo = inferRunwayCondition(metarRaw, tafRaw);
    const narrow = (bestX.narrow === true);
    const xwindLimit = (bestX.xwind != null) ? crosswindLimitKt(condInfo.rwyccEst, narrow) : null;
    const xwindExceed = (bestX.xwind != null && xwindLimit != null) ? (bestX.xwind > xwindLimit) : false;

    const noOpsLikely = (Number.isFinite(condInfo.rwyccEst) && condInfo.rwyccEst < 3);

    // Explanations for UI/audit (kept compact; derived only from raw METAR/TAF text + runways.json)
    const explainSrc = (metarRaw && !tafRaw) ? "M" : (!metarRaw && tafRaw) ? "T" : "MT";
    const rvrGroups = extractRvrGroups(obsRaw);
    const heavyMatches = [...new Set([...heavyPrecipMatches(metarRaw), ...heavyPrecipMatches(tafRaw)])];
    const w = parseWindKt(obsRaw);
    const refVisType = (typeof rvrMinAll === "number") ? "RVR" : ((typeof worstVis === "number") ? "VIS" : null);

    const explain = {
      src: explainSrc,
      heavyMatches,
      refVisType,
      refVisValue: (refVis != null ? refVis : null),
      worstVis: (typeof worstVis === "number" ? worstVis : null),
      rvrMinAll: (typeof rvrMinAll === "number" ? rvrMinAll : null),
      rvrGroups,
      rvrAny: detectAnyRvr(obsRaw),
      visThresh800: 800,
      lvtoThresh550: 550,
      lvpThresh400: 400,
      lvtoQualThresh150: 150,
      rvrStopThresh125: 125,
      cat2Thresh450: 450,
      cat3Thresh200: 200,
      cat3LowThresh75: 75,
      tempC: (tempC != null ? tempC : null),
      runwayCond: {cond: condInfo.cond, rwyccEst: condInfo.rwyccEst, evidence: condInfo.evidence || []},
      wind: {dir: w.dir ?? null, spd: w.spd ?? null, gst: w.gst ?? null, usedSpd: bestX.usedSpd ?? null},
      xwind: {
        available: !!(rwys && rwys.length),
        xwindKt: (bestX.xwind != null ? bestX.xwind : null),
        limitKt: (xwindLimit != null ? xwindLimit : null),
        runwayHdg: (bestX.best && Number.isFinite(bestX.best.hdg)) ? bestX.best.hdg : null,
        runwayName: (bestX.best && bestX.best.name) ? bestX.best.name : null,
        runwayWidthM: (bestX.best && Number.isFinite(bestX.best.width_m)) ? bestX.best.width_m : null,
        narrow: (bestX.narrow === true)
      }
    };

    return {
      explain,
      // OM-A/OM-B derived flags (advisory)
      toProhib,
      tsOrCb: !!tsOrCb,
      heavyPrecip: !!heavy,
      va,
      lvto,
      lvp,
      lvtoQualReq,
      rvr125,
      rvrRequired,
      cat2Plus,
      cat3Only,
      cat3BelowMin,
      coldcorr,

      // Crosswind
      xwindExceed,
      xwindKt: bestX.xwind,
      xwindLimitKt: xwindLimit,
      xwindCond: condInfo.cond,
      rwyccEst: condInfo.rwyccEst,
      noOpsLikely,

      // Diagnostics
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
