# WX Monitor (METAR/TAF) — GitHub Pages + GitHub Actions

A lightweight, static **METAR/TAF monitoring dashboard** designed for OCC-style situational awareness.  
It runs on **GitHub Pages** and refreshes data via **GitHub Actions** (server-side fetch → commit JSON → client reads JSON), avoiding browser CORS issues.

## What it does

### Main dashboard (`/`)
- Monitors a configurable list of airports (from `airports.txt`) and shows:
  - **Live METAR** (observed)
  - **TAF** (forecast)
  - Derived operational signals (visibility buckets, ceiling, wind gusts, thunderstorms, snow, etc.)
- **KPI tiles** for rapid triage (AUTO + TV view):
  - Engine Ice Ops, Critical, Visibility ≤ 175 m, Thunderstorm, Wind (gust ≥ 25 kt), Snow, Reset
- **TV mode** (large typography for distant viewing):
  - Toggle via **VIEW** button or **Shift+T**
- **Role-aware prioritisation**:
  - Airports can be marked as **BASE**, **DESTINATION**, **ALTERNATE**, or **OTHER**
  - Priority and display ordering: **BASE > DESTINATION > ALTERNATE > OTHER**
  - Role filters are available on the main page

### Settings (`/settings.html`)
A shared, repo-based configuration workflow (multi-user friendly):
- Edit the monitored airport list (add/remove ICAO).
- Assign roles per airport: **BASE / DESTINATION / ALTERNATE / OTHER**.
- Export:
  - `airports.txt`
  - `airport_roles.json` (to be saved in the repo as `config/airport_roles.json`)

> Note: GitHub Pages is static, so Settings **cannot commit** changes automatically.  
> To apply changes for all users, export the files and **commit them to the repo**.

### Stats (`/stat/`)
A non-technical, “at-a-glance” operational view with a WOW-style visualisation:
- **Health / refresh verification**
  - Latest dataset time (`generatedAt`)
  - Refresh health (Healthy / Delayed)
  - Average refresh interval (observed by the browser)
  - Stations/coverage summary (missing METAR/TAF counts)
- **Refresh trend** sparkline (dataset update intervals)
- **Coverage trend** sparkline (missing METAR / missing TAF over time)
- **Change Atlas** (matrix timeline)
  - Rows: airports (sticky left column shows **ICAO/IATA + role**)
  - Columns: time buckets
  - Cells: glyphs showing change direction
    - **▼** worsened, **▲** improved, **◆** mixed/neutral
    - Larger glyph ≈ higher impact
  - **Search ICAO/IATA** to filter without scrolling; exact match auto-pins the airport.
- **Pinned airport panel**
  - “What happened?” cards in plain language
  - Weather trend chart:
    - **All metrics** overlays key trends (normalised for shape comparison) with a clear legend
    - Selecting a specific metric shows **only that metric**
    - Snow is rendered as a dedicated, highly visible band/series

> Change Atlas history is recorded **in this browser** (local history).  
> It starts populating once new datasets arrive (when `generatedAt` changes). It also seeds the airport list immediately from snapshots so the view is never “empty”.

---

## Data flow (high level)

1. **GitHub Actions** runs every ~10 minutes:
   - reads `airports.txt`
   - downloads METAR/TAF from `aviationweather.gov`
   - updates:
     - `data/latest.json`
     - `data/status.json`
     - `data/iata_map.json` (ICAO→IATA/name mapping via OurAirports CSV)
2. **GitHub Pages** serves static files:
   - main UI loads `data/latest.json`
   - stats UI loads `data/latest.json` and builds local history/trends

---

## Configuration files

### `airports.txt`
List of airports to monitor (one ICAO per line; comments are allowed).

Example:
```txt
LHBP  # Budapest
EGLL  # London Heathrow
```

### `config/airport_roles.json`
Shared role configuration (multi-user consistent).

Example:
```json
{
  "LHBP": "BASE",
  "EGLL": "DEST",
  "LOWW": "ALT"
}
```

Allowed values:
- `BASE`
- `DEST` (Destination)
- `ALT` (Alternate)
- omitted → treated as `OTHER`

---

## How to change the monitored airports / roles (recommended workflow)

1. Open `settings.html` on your GitHub Pages site.
2. Add/remove ICAOs and set roles (BASE/DEST/ALT/OTHER).
3. Export both files.
4. Commit to the repo:
   - overwrite `airports.txt`
   - overwrite `config/airport_roles.json`

After the next scheduled Actions run, the dataset will refresh for everyone.

---

## Troubleshooting

### “Loading…” on the main page
- Hard refresh the browser (**Ctrl+F5**) to bypass cached JS/CSS.
- Check that `data/latest.json` exists in the repo and is being updated by Actions.

### Stats page shows 0 changes
- This is expected in a fresh browser until the next dataset update arrives (`generatedAt` changes).
- Keep `/stat/` open until the next update; the Change Atlas will begin to populate.

### Roles not applied
- Ensure `config/airport_roles.json` exists in the repo (it can be `{}`).
- Confirm the file path is exactly `config/airport_roles.json` (case-sensitive on some systems).

---

## Repository layout

- `index.html` — main dashboard UI
- `assets/` — main UI JS/CSS
- `settings.html`, `assets/settings.js` — shared configuration UI + export
- `stat/` — stats + Change Atlas UI
- `airports.txt` — monitored ICAO list
- `config/airport_roles.json` — shared role configuration
- `data/` — generated outputs committed by Actions
- `scripts/` — data update logic used by Actions
- `.github/workflows/` — scheduled update workflow

---

## Version notes
This README reflects the **shared roles + settings + Change Atlas** build series (v51+).


## OM-A / OM-B Policy Layer (Wizz Air)

This build adds an **OM policy advisory layer** derived **strictly from METAR/TAF text** (no manual runway heading, no SNOWTAM/runway condition input).

What is supported (derived from METAR/TAF only):
- **Take-off minima**: LVTO (<550m), **LVP required** (<400m), **absolute min** (<125m) using **RVR if present**, otherwise VIS proxy.
- **Generic landing minima indicators** (CAT I/II/III) using RVR/VIS thresholds and ceiling (when available).
- **Circling minima indicators** (Cat C: 4000m / 1000ft).
- **Hazard prohibitions/advisories**:
  - **TS/CB present** → "OM: TS/CB PROHIBITED" (note: overhead/approaching cannot be inferred reliably).
  - **Heavy precip / freezing rain / hail / pellets** → "OM: TO PROHIBITED (WX)" (per OM-A 8.3.8.7) based on METAR/TAF tokens.
  - **Volcanic Ash (VA)** detected.
- **Cold temperature**: OAT ≤ 0°C flag (minima correction reminder).

Not supported without additional inputs:
- **Crosswind limits** and FO experience limits (require runway heading, runway width, RWYCC/contamination).
- Runway condition logic (requires SNOWTAM / RWYCC and runway selection).

