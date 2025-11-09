
const $ = (s,el=document)=>el.querySelector(s);
const storeKey = "turf_bookings_v1";
const cfgUrl = "./data/site.json";

function loadBookings(){
  try { return JSON.parse(localStorage.getItem(storeKey) || "[]"); }
  catch(e){ return []; }
}
function saveAll(bookings){
  localStorage.setItem(storeKey, JSON.stringify(bookings));
}

async function init(){
  const cfg = await (await fetch(cfgUrl)).json();
  $("#bizName").textContent = cfg.name;
  renderTable(loadBookings());
  $("#exportCsv").addEventListener("click", exportCsv);
  $("#clearAll").addEventListener("click", ()=>{
    if(confirm("Delete ALL bookings?")){ saveAll([]); renderTable([]); }
  });
  $("#filterDate").addEventListener("change", ()=> renderTable(loadBookings()));
  $("#filterCourt").addEventListener("change", ()=> renderTable(loadBookings()));
}

function renderTable(rows){
  const date = $("#filterDate").value;
  const court = $("#filterCourt").value;
  const tbody = $("#rows");
  tbody.innerHTML = "";
  rows
    .filter(r=> !date || r.dateISO===date)
    .filter(r=> !court || r.courtId===court)
    .sort((a,b)=> a.startISO.localeCompare(b.startISO))
    .forEach(r=>{
      const tr = document.createElement("tr");
      tr.className = "border-b";
      tr.innerHTML = `
        <td class="px-3 py-2 font-mono text-xs">${r.id}</td>
        <td class="px-3 py-2">${r.courtLabel}</td>
        <td class="px-3 py-2">${r.dateISO}</td>
        <td class="px-3 py-2">${new Date(r.startISO).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</td>
        <td class="px-3 py-2">${r.name}<br><span class="text-gray-500 text-xs">${r.phone}</span></td>
        <td class="px-3 py-2">₹${r.price}</td>
        <td class="px-3 py-2">${r.notes||''}</td>
        <td class="px-3 py-2">
          <button class="px-2 py-1 rounded border text-red-600" data-id="${r.id}">Delete</button>
        </td>`;
      tbody.appendChild(tr);
    });
  // bind delete
  tbody.querySelectorAll("button[data-id]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.dataset.id;
      if(confirm(`Delete booking ${id}?`)){
        const rows = loadBookings().filter(x=> x.id !== id);
        saveAll(rows); renderTable(rows);
      }
    });
  });
}

function exportCsv(){
  const rows = loadBookings();
  const head = ["id","courtLabel","dateISO","startISO","endISO","name","phone","price","notes"].join(",");
  const csv = [head].concat(rows.map(r=>[r.id,r.courtLabel,r.dateISO,r.startISO,r.endISO,r.name,r.phone,r.price,JSON.stringify(r.notes||'')].join(","))).join("\n");
  const blob = new Blob([csv], {type:"text/csv"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "bookings.csv"; a.click();
  URL.revokeObjectURL(url);
}

window.addEventListener("load", init);


// ==== Waitlist Management ====
const wlKey = "turf_waitlist_v1";
function loadWaitlist(){ try { return JSON.parse(localStorage.getItem(wlKey)||"[]"); } catch(e){ return []; } }
function saveWaitlist(rows){ localStorage.setItem(wlKey, JSON.stringify(rows)); }

function renderWaitlist(){
  const cfg = { whatsapp: "" };
  const tbody = document.getElementById("wlRows");
  const rows = loadWaitlist().sort((a,b)=> a.startISO.localeCompare(b.startISO));
  tbody.innerHTML = "";
  rows.forEach(r=>{
    const tr = document.createElement("tr");
    tr.className = "border-b";
    const when = new Date(r.startISO);
    const time = when.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    const waText = encodeURIComponent(`Waitlist update for ${r.dateISO} ${time}`);
    tr.innerHTML = `
      <td class="px-3 py-2 font-mono text-xs">${r.id}</td>
      <td class="px-3 py-2">${r.courtId}</td>
      <td class="px-3 py-2">${r.dateISO}</td>
      <td class="px-3 py-2">${time}</td>
      <td class="px-3 py-2">${r.name}<br><span class="text-gray-500 text-xs">${r.phone}</span></td>
      <td class="px-3 py-2 flex gap-2">
        <a class="px-2 py-1 rounded border" target="_blank" href="https://wa.me/${r.phone.replace(/^\\+/,'')}?text=${waText}">WhatsApp</a>
        <button class="px-2 py-1 rounded border text-red-600" data-del="${r.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll("button[data-del]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.dataset.del;
      if(confirm(`Delete waitlist entry ${id}?`)){
        const rows = loadWaitlist().filter(x=> x.id !== id);
        saveWaitlist(rows); renderWaitlist();
      }
    });
  });
}

const _init_admin = init;
init = async function(){
  await _init_admin();
  renderWaitlist();
}
