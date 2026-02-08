#!/usr/bin/env node
/**
 * Generate data/thermostat.json from data/latest.json + base.txt
 * Output is used by the TV "Disruption Thermostat" (single-screen mode recommendation).
 *
 * Design goals:
 *  - Robust against schema changes: best-effort parsing with safe defaults.
 *  - No external network calls.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const IN_LATEST = path.join(ROOT, "data", "latest.json");
const IN_BASE = path.join(ROOT, "base.txt");
const OUT = path.join(ROOT, "data", "thermostat.json");

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const safeArr = (v) => Array.isArray(v) ? v : [];
const safeStr = (v) => (v == null ? "" : String(v));
const uniq = (arr) => Array.from(new Set(arr));

function readJson(p, fallback){
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function readLines(p){
  try {
    return fs.readFileSync(p,"utf8").split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  } catch { return []; }
}

function isBase(iata, baseSet){ return baseSet.has((iata||"").trim().toUpperCase()); }

function classifyDrivers(st){
  // Uses triggers first; falls back to hazards / vis / ceiling fields.
  const triggers = safeArr(st?.triggers);
  const labels = triggers.map(t => safeStr(t?.label).toUpperCase());
  const hazards = safeArr(st?.hazards).map(h => safeStr(h).toUpperCase());

  const has = (re) => labels.some(l => re.test(l)) || hazards.some(h => re.test(h));

  const vis = has(/\bVIS\b|RVR|CIG|CEIL|MINIMA|LVP|LOW\s*VIS|LOW\s*CIG|BELOW/i)
           || (Number(st?.worst_visibility_m) > 0 && Number(st?.worst_visibility_m) < 1500)
           || (Number(st?.ceiling_ft) > 0 && Number(st?.ceiling_ft) < 1500);

  const wind = has(/WIND|GUST|LLWS|WS\b/i);
  const snow = has(/SNOW|BLSN|BLOWING\s*SNOW|RWY\s*CONTAM|SLUSH|BRAKING/i);
  const icing = has(/ICE|ICING|FZRA|FZDZ|FREEZ/i) || Boolean(st?.engIceOps);
  const ts = has(/\bTS\b|THUNDER|CB\b/i);

  return { vis, wind, snow, icing, ts };
}

function pickTopIatas(stations, pred, max=6){
  const iatas = stations.filter(pred).map(s => safeStr(s?.iata).trim().toUpperCase()).filter(Boolean);
  return uniq(iatas).slice(0, max);
}

function main(){
  const latest = readJson(IN_LATEST, { generatedAt: null, stations: [], stats: {}, errors: []});
  const baseSet = new Set(readLines(IN_BASE).map(s => s.toUpperCase()));

  const stations = safeArr(latest?.stations)
    .filter(s => safeStr(s?.iata).trim().length > 0)
    .map(s => ({ ...s, iata: safeStr(s?.iata).trim().toUpperCase() }));

  const generatedAt = latest?.generatedAt ?? new Date().toISOString();
  const stats = latest?.stats ?? {};
  const errors = safeArr(latest?.errors);

  const nowCrit = stations.filter(s => s.alert === "CRIT").length;
  const nowHigh = stations.filter(s => s.alert === "HIGH").length;
  const nowMed  = stations.filter(s => s.alert === "MED").length;

  const metCrit = stations.filter(s => Boolean(s.metCrit)).length;
  const tafCrit = stations.filter(s => Boolean(s.tafCrit)).length;

  // Bases impacted (any non-OK now or any forecast critical)
  const basesNow = stations.filter(s => isBase(s.iata, baseSet) && (s.alert !== "OK" || Boolean(s.metCrit))).map(s=>s.iata);
  const basesFct = stations.filter(s => isBase(s.iata, baseSet) && (Boolean(s.tafCrit) || Number(s.tafPri||0) >= 20)).map(s=>s.iata);
  const basesAny = uniq([...basesNow, ...basesFct]);

  const engIceOpsAny = uniq(stations.filter(s => Boolean(s.engIceOps)).map(s => s.iata));
  const engIceOpsBases = engIceOpsAny.filter(i => isBase(i, baseSet));
  const engIceOpsOut = engIceOpsAny.filter(i => !isBase(i, baseSet));

  // Driver aggregation over impacted stations
  let dVis=0,dWind=0,dSnow=0,dIcing=0,dTs=0;
  const impacted = stations.filter(s => s.alert !== "OK" || Boolean(s.tafCrit) || Boolean(s.metCrit));
  for(const s of impacted){
    const d = classifyDrivers(s);
    if(d.vis) dVis++;
    if(d.wind) dWind++;
    if(d.snow) dSnow++;
    if(d.icing) dIcing++;
    if(d.ts) dTs++;
  }

  const driverCounts = { vis: dVis, wind: dWind, snow: dSnow, icing: dIcing, ts: dTs };
  const driverOrder = Object.entries(driverCounts).sort((a,b)=>b[1]-a[1]).map(([k])=>k);
  const topDrivers = driverOrder.filter(k => driverCounts[k] > 0).slice(0, 3);

  // NSI (0-100) - simple, explainable weights
  const nsiRaw =
      (basesAny.length * 6)
    + (nowCrit * 5)
    + (nowHigh * 2)
    + (metCrit * 4)
    + (tafCrit * 2)
    + (dVis ? 10 : 0)          // visibility tends to cause network-level pain
    + (dSnow ? 6 : 0)
    + (dWind ? 4 : 0)
    + (dIcing ? 4 : 0)
    + (dTs ? 4 : 0);

  let nsi = clamp(Math.round(nsiRaw), 0, 100);

  // Trend vs previous thermostat (if exists)
  const prev = readJson(OUT, null);
  let trend = { direction: "flat", delta: 0 };
  if(prev && typeof prev.nsi === "number"){
    const delta = nsi - prev.nsi;
    trend = { direction: delta > 3 ? "rising" : (delta < -3 ? "falling" : "flat"), delta };
    if(trend.direction === "rising") nsi = clamp(nsi + 5, 0, 100); // slight bias to proactive posture
  }

  // Mode thresholds (default)
  const mode = (nsi >= 65) ? "PROTECT" : (nsi >= 35 ? "STABILIZE" : "PUSH");

  // Reasons (short bullets)
  const reasons = [];
  reasons.push(`Bases impacted: ${basesAny.length}`);
  reasons.push(`ENG ICE OPS: ${engIceOpsAny.length}`);
  reasons.push(`NOW: ${nowCrit} CRIT / ${nowHigh} HIGH`);
  if(topDrivers.length){
    const name = (k) => ({vis:"VIS/RVR+MINIMA", wind:"WIND/GUST", snow:"SNOW/CONTAM", icing:"ICING/ENG ICE", ts:"TS/CB"})[k] || k.toUpperCase();
    reasons.push(`Top drivers: ${topDrivers.map(name).join(", ")}`);
  }
  if(trend.direction !== "flat") reasons.push(`Trend: ${trend.direction} (${trend.delta > 0 ? "+" : ""}${trend.delta})`);

  // Top impacted airports (examples)
  const nowTop = pickTopIatas(stations, s => s.alert === "CRIT" || Boolean(s.metCrit), 8);
  const fctTop = pickTopIatas(stations, s => Boolean(s.tafCrit), 8);

  const out = {
    generatedAt,
    mode,
    nsi,
    trend,
    counts: {
      basesImpacted: basesAny.length,
      nowCrit,
      nowHigh,
      nowMed,
      metCrit,
      tafCrit,
      engIceOpsCount: engIceOpsAny.length,
      watchlistAirports: Number(stats?.icaoCount || stations.length) || stations.length,
      metarReturned: Number(stats?.metarReturned || 0) || 0,
      tafReturned: Number(stats?.tafReturned || 0) || 0,
      missingMetar: Number(stats?.missingMetar || 0) || 0,
      missingTaf: Number(stats?.missingTaf || 0) || 0,
    },
    top: { now: nowTop, forecast: fctTop },
    drivers: driverCounts,
    lists: {
      basesNow,
      basesForecast: basesFct,
      basesAny,
      engIceOps: engIceOpsAny,
      engIceOpsBases,
      engIceOpsOut,
    },
    reasons,
    errors: errors.slice(0, 10),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT} (NSI ${nsi}, ${mode})`);
}

main();
