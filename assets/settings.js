/* Settings page (shared configuration)
   - edits watchlist (airports.txt)
   - edits roles (config/airport_roles.json)
   - exports both files for commit
*/
const $ = (id)=>document.getElementById(id);

const ROLE_ORDER = ["BASE","DEST","ALT","OTHER"];
function normalizeIcao(s){
  const v = String(s||"").trim().toUpperCase().replace(/[^A-Z0-9]/g,"");
  return v.length===4 ? v : "";
}
function normalizeRole(r){
  const v = String(r||"").trim().toUpperCase();
  if (v==="BASE") return "BASE";
  if (v==="DEST" || v==="DESTINATION") return "DEST";
  if (v==="ALT"  || v==="ALTERNATE")   return "ALT";
  return "OTHER";
}
function roleRank(r){
  const v = normalizeRole(r);
  return v==="BASE" ? 0 : v==="DEST" ? 1 : v==="ALT" ? 2 : 3;
}
function downloadText(filename, text){
  const blob = new Blob([text], {type:"text/plain;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

let airports = [];          // ordered ICAO list
let roles = {};             // { ICAO: ROLE }

async function loadFromRepo(){
  const [air, rol] = await Promise.all([
    fetch("airports.txt?cb="+Date.now(), {cache:"no-store"}).then(r=>r.ok?r.text():""),
    fetch("config/airport_roles.json?cb="+Date.now(), {cache:"no-store"}).then(r=>r.ok?r.json():{})
  ]);
  airports = parseAirportsTxt(air);
  roles = sanitizeRoles(rol);
  render();
}

function parseAirportsTxt(txt){
  const out = [];
  const seen = new Set();
  for (const line of String(txt||"").split(/\r?\n/)){
    const m = line.toUpperCase().match(/\b[A-Z0-9]{4}\b/);
    if (!m) continue;
    const icao = m[0];
    if (!seen.has(icao)){
      seen.add(icao);
      out.push(icao);
    }
  }
  return out;
}
function sanitizeRoles(obj){
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [k,v] of Object.entries(obj)){
    const icao = normalizeIcao(k);
    if (!icao) continue;
    const r = normalizeRole(v);
    if (r !== "OTHER") out[icao] = r;
  }
  return out;
}

function setRole(icao, role){
  const r = normalizeRole(role);
  if (r === "OTHER") delete roles[icao];
  else roles[icao] = r;
}

function addAirport(icao, role){
  const v = normalizeIcao(icao);
  if (!v) return false;
  if (!airports.includes(v)) airports.push(v);
  setRole(v, role);
  return true;
}

function removeAirport(icao){
  airports = airports.filter(x=>x!==icao);
  delete roles[icao];
}

function buildExports(){
  const airportsTxt = airports.join("\n") + (airports.length ? "\n" : "");
  // only non-OTHER roles
  const rolesObj = {};
  for (const icao of airports){
    const r = normalizeRole(roles[icao]);
    if (r !== "OTHER") rolesObj[icao] = r;
  }
  const rolesJson = JSON.stringify(rolesObj, null, 2) + "\n";
  return {airportsTxt, rolesJson};
}

function render(){
  $("countAirports").textContent = String(airports.length);

  // rows sorted by priority then ICAO, but keep airports order for watchlist export.
  const rows = airports
    .slice()
    .sort((a,b)=> roleRank(roles[a]) - roleRank(roles[b]) || a.localeCompare(b));

  const tbody = $("roleRows");
  tbody.innerHTML = rows.map(icao=>{
    const r = normalizeRole(roles[icao]);
    const pr = r==="BASE" ? "1" : r==="DEST" ? "2" : r==="ALT" ? "3" : "4";
    return `
      <tr class="row" data-icao="${icao}">
        <td class="icaoCell">${icao}</td>
        <td>
          <select class="select roleSel">
            ${ROLE_ORDER.map(opt=>`<option value="${opt}" ${opt===r?"selected":""}>${opt}</option>`).join("")}
          </select>
        </td>
        <td class="muted">${pr}</td>
        <td style="text-align:right">
          <button class="btn btn--danger delBtn" type="button">Remove</button>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll(".roleSel").forEach(sel=>{
    sel.addEventListener("change", (e)=>{
      const tr = e.target.closest("tr");
      const icao = tr?.getAttribute("data-icao");
      if (!icao) return;
      setRole(icao, e.target.value);
      syncPreviews();
      render(); // to update sorting by priority
    });
  });
  tbody.querySelectorAll(".delBtn").forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      const tr = e.target.closest("tr");
      const icao = tr?.getAttribute("data-icao");
      if (!icao) return;
      removeAirport(icao);
      syncPreviews();
      render();
    });
  });

  syncPreviews();
}

function syncPreviews(){
  const {airportsTxt, rolesJson} = buildExports();
  $("outAirports").value = airportsTxt;
  $("outRoles").value = rolesJson;
}

$("btnAdd").addEventListener("click", ()=>{
  const icao = $("addIcao").value;
  const role = $("addRole").value;
  if (addAirport(icao, role)){
    $("addIcao").value = "";
    syncPreviews();
    render();
  }
});

$("btnAddMany").addEventListener("click", ()=>{
  const bulk = $("bulkIcao").value;
  const items = String(bulk||"").split(/[\s,;]+/).map(normalizeIcao).filter(Boolean);
  let changed = false;
  for (const icao of items){
    if (addAirport(icao, "OTHER")) changed = true;
  }
  if (changed){
    $("bulkIcao").value = "";
    syncPreviews();
    render();
  }
});

$("btnReload").addEventListener("click", ()=>loadFromRepo());

$("btnExportAll").addEventListener("click", ()=>{
  const {airportsTxt, rolesJson} = buildExports();
  downloadText("airports.txt", airportsTxt);
  downloadText("airport_roles.json", rolesJson);
});

$("btnDlAirports").addEventListener("click", ()=>{
  const {airportsTxt} = buildExports();
  downloadText("airports.txt", airportsTxt);
});
$("btnDlRoles").addEventListener("click", ()=>{
  const {rolesJson} = buildExports();
  downloadText("airport_roles.json", rolesJson);
});

loadFromRepo().catch(err=>{
  console.error(err);
  $("roleRows").innerHTML = `<tr><td colspan="4" class="muted">Failed to load data. Ensure airports.txt and config/airport_roles.json exist in the repository.</td></tr>`;
});
