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
import zlib from 'node:zlib';

const ROOT = process.cwd();
const AIRPORTS_TXT = path.join(ROOT, 'airports.txt');
const OUT_LATEST = path.join(ROOT, 'data', 'latest.json');
const OUT_IATA_MAP = path.join(ROOT, 'data', 'iata_map.json');
const OUT_STATUS = path.join(ROOT, 'data', 'status.json');
const OUT_RUNWAYS = path.join(ROOT, 'data', 'runways.json');

const OURAIRPORTS_CSV_URL = 'https://ourairports.com/airports.csv';
const OURAIRPORTS_RUNWAYS_CSV_URL = 'https://ourairports.com/runways.csv';

const AWC_METAR = 'https://aviationweather.gov/api/data/metar';
const AWC_TAF = 'https://aviationweather.gov/api/data/taf';

// Cache files are recommended by AWC for frequent access.
// METAR cache updates once a minute; TAF cache updates every 10 minutes (XML only).
const AWC_METAR_CACHE_CSV_GZ = 'https://aviationweather.gov/data/cache/metars.cache.csv.gz';

// We fetch METAR every run; TAF is throttled to every 10 minutes (per AWC cache cadence).
const TAF_MIN_INTERVAL_MS = 10 * 60 * 1000;

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

function ceilingFt(raw){
  if(!raw) return null;
  const tokens = raw.split(/\s+/);
  let lowest = null;
  for(const t of tokens){
    // BKNxxx / OVCxxx / VVxxx where xxx is hundreds of feet
    const m = t.match(/^(BKN|OVC|VV)(\d{3})$/);
    if(m){
      const ft = parseInt(m[2],10)*100;
      if(Number.isFinite(ft)){
        lowest = lowest==null ? ft : Math.min(lowest, ft);
      }
    }
  }
  return lowest;
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


async function fetchBuffer(url){
  const res = await fetch(url, {
    headers: {
      // AWC guidance: use a custom UA to prevent automated filtering issues
      'User-Agent': 'wizz-awc-watch (github-actions)'
    }
  });
  if(!res.ok){
    const body = await res.text().catch(()=> '');
    throw new Error(`Fetch failed ${res.status} ${res.statusText}: ${body.slice(0,200)}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function fetchGzipText(url){
  const buf = await fetchBuffer(url);
  const out = zlib.gunzipSync(buf);
  return out.toString('utf8');
}

async function fetchText(url){
  const buf = await fetchBuffer(url);
  return buf.toString('utf8');
}

async function fetchMetars(icaos){
  const want = new Set(icaos.map(s => String(s).toUpperCase()));
  const map = new Map();

  // One request per run, using cache file updated once a minute.
  const csv = await fetchGzipText(AWC_METAR_CACHE_CSV_GZ);
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if(!lines.length) return map;

  const header = parseCsvLine(lines[0]).map(h => (h || '').trim());
  const idxStation = header.findIndex(h => h === 'station_id' || h === 'stationId' || h === 'icao' || h === 'icao_id');
  const idxRaw = header.findIndex(h => h === 'raw_text' || h === 'rawText' || h === 'raw');

  if(idxStation < 0 || idxRaw < 0){
    throw new Error(`METAR cache CSV: unexpected header (station/raw columns not found). Columns: ${header.slice(0,20).join(', ')}`);
  }

  for(let i=1;i<lines.length;i++){
    const cols = parseCsvLine(lines[i]);
    const icao = (cols[idxStation] || '').toUpperCase().trim();
    if(!icao || !want.has(icao)) continue;

    let raw = (cols[idxRaw] || '').trim();
    if(!raw) continue;

    // Normalize: keep UX consistent with other views.
    if(!/^((METAR|SPECI)\s+)/.test(raw)) raw = `METAR ${raw}`;

    map.set(icao, raw);
  }

  return map;
}

async function fetchTafs(icaos){
  const map = new Map();
  for(const c of chunk(icaos, 200)){
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

  const missing = icaos.filter(i => !existing[i]);
  if(missing.length === 0) return existing;

  console.log(`IATA map: ${missing.length} missing ICAO codes, downloading OurAirports airports.csv…`);
  const csv = await fetchText(OURAIRPORTS_CSV_URL);

  const lines = csv.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]);
  const idxIdent = header.indexOf('ident');
  const idxIata = header.indexOf('iata_code');
  const idxName = header.indexOf('name');

  const want = new Set(missing);
  for(let i=1;i<lines.length && want.size;i++){
    const cols = parseCsvLine(lines[i]);
    const ident = (cols[idxIdent] || '').toUpperCase();
    if(!want.has(ident)) continue;
    const iata = (cols[idxIata] || '').toUpperCase().trim();
    const name = (cols[idxName] || '').trim();
    existing[ident] = { iata: iata || null, name: name || null };
    want.delete(ident);
  }

  // Whatever is still missing -> keep placeholder
  for(const m of want){
    existing[m] = { iata: null, name: null };
  }

  return existing;
}


async function buildRunwaysMap(icaos){
  // Creates OUT_RUNWAYS with runway headings/widths for crosswind advisory.
  const wanted = new Set(icaos);
  console.log(`Runways: downloading OurAirports runways.csv…`);
  const csv = await fetchText(OURAIRPORTS_RUNWAYS_CSV_URL);

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

  fs.writeFileSync(OUT_RUNWAYS, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_RUNWAYS} (${Object.keys(out).length} airports).`);
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
  try{
    await buildRunwaysMap(icaos);
  }catch(e){
    console.log("Runways: failed to refresh runways.json (will keep previous if present):", String(e));
  }

  // Load previous dataset (if present) so we can throttle TAF fetches to every 10 minutes
  // while still updating METAR as frequently as the workflow runs.
  let prev = null;
  try{
    if(fs.existsSync(OUT_LATEST)){
      prev = JSON.parse(fs.readFileSync(OUT_LATEST, 'utf8'));
    }
  }catch{ prev = null; }

  let metars = new Map();
  let tafs = new Map();

  // METAR: fetch every run (using cache updated once per minute)
  let metarFetchedAt = new Date().toISOString();
  try {
    console.log(`Fetching METAR for ${icaos.length} stations (AWC cache)…`);
    metars = await fetchMetars(icaos);
  } catch (e) {
    errors.push(`METAR fetch failed: ${String(e?.message ?? e)}`);
  }

  // TAF: fetch at most every 10 minutes; otherwise reuse previous TAFs from latest.json
  let tafFetchedAt = prev?.tafFetchedAt ?? null;
  const prevTafAgeMs = tafFetchedAt ? (Date.now() - Date.parse(tafFetchedAt)) : Infinity;
  const shouldFetchTaf = !(prev && Array.isArray(prev?.stations)) || !(prevTafAgeMs >= 0 && prevTafAgeMs < TAF_MIN_INTERVAL_MS);

  if(shouldFetchTaf){
    try {
      console.log(`Fetching TAF for ${icaos.length} stations…`);
      tafs = await fetchTafs(icaos);
      tafFetchedAt = new Date().toISOString();
    } catch (e) {
      errors.push(`TAF fetch failed: ${String(e?.message ?? e)}`);
      // fallback to previous if available
      if(prev && Array.isArray(prev?.stations)){
        for(const s of prev.stations){
          if(s?.icao && s?.tafRaw) tafs.set(String(s.icao).toUpperCase(), s.tafRaw);
        }
      }
    }
  } else {
    console.log(`Skipping TAF fetch (last fetched ${tafFetchedAt}); reusing previous TAFs.`);
    for(const s of (prev?.stations ?? [])){
      if(s?.icao && s?.tafRaw) tafs.set(String(s.icao).toUpperCase(), s.tafRaw);
    }
  }

  const stations = icaos.map(icao => {
    const metar = metars.get(icao) || null;
    const taf = tafs.get(icao) || null;

    const metarVis = tokenizeAllVis(metar);
    const tafVis = tokenizeAllVis(taf);

    // Use the worse (minimum) visibility between METAR and TAF for severity ranking.
    let worstVis = metarVis.min_m;
    if(tafVis.min_m != null) worstVis = (worstVis == null) ? tafVis.min_m : Math.min(worstVis, tafVis.min_m);

    const ceil_ft = ceilingFt(metar) ?? ceilingFt(taf);
    const hazards = [...new Set([...findHazards(metar), ...findHazards(taf)])];

    const score = severityScore({
      hazards,
      visibility_m: worstVis,
      ceiling_ft: ceil_ft,
      hasTaf: Boolean(taf)
    });

    return {
      icao,
      iata: iataMap[icao]?.iata ?? null,
      name: iataMap[icao]?.name ?? null,

      updatedAt: metar ? (metar.match(/\b\d{6}Z\b/)?.[0] ?? null) : null,

      visibility_m: metarVis.min_m ?? null,
      taf_visibility_m: tafVis.min_m ?? null,
      worst_visibility_m: worstVis,

      ceiling_ft: ceil_ft,
      hazards,
      severityScore: score,
      metarRaw: metar,
      tafRaw: taf,
    };
  });

  stations.sort((a,b) => (b.severityScore ?? 0) - (a.severityScore ?? 0));

  const stats = {
    icaoCount: icaos.length,
    metarReturned: metars.size,
    tafReturned: tafs.size,
    stationsWritten: stations.length,
    missingMetar: stations.filter(s => !s.metarRaw).length,
    missingTaf: stations.filter(s => !s.tafRaw).length
  };

  const out = { generatedAt, metarFetchedAt, tafFetchedAt, stations, stats, errors };
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
