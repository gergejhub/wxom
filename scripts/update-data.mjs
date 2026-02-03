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

const ROOT = process.cwd();
const AIRPORTS_TXT = path.join(ROOT, 'airports.txt');
const OUT_LATEST = path.join(ROOT, 'data', 'latest.json');
const OUT_IATA_MAP = path.join(ROOT, 'data', 'iata_map.json');
const OUT_STATUS = path.join(ROOT, 'data', 'status.json');
const OUT_RUNWAYS = path.join(ROOT, 'data', 'runways.json');

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
      lat: iataMap[icao]?.lat ?? null,
      lon: iataMap[icao]?.lon ?? null,

      updatedAt: metar ? (metar.match(/\b\d{6}Z\b/)?.[0] ?? null) : null,

      visibility_m: metarVis.min_m ?? null,
      taf_visibility_m: tafVis.min_m ?? null,
      worst_visibility_m: worstVis,

      ceiling_ft: ceil_ft,
      hazards,
      severityScore: score,
      metarRaw: metar,
      tafRaw: taf,
      minima: minimaByIcao[icao] ?? null,
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
