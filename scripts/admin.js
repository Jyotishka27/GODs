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

function timeAgo(iso){
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - then);
  const sec = Math.floor(diff/1000);
  if(sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec/60);
  if(min < 60) return `${min}m ago`;
  const hr = Math.floor(min/60);
  if(hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr/24);
  return `${day}d ago`;
}

async function init(){
  const cfg = await (await fetch(cfgUrl)).json();
  $("#bizName").textContent = cfg.name;

  // populate courts dropdown if present in DOM
  const filterCourt = $("#filterCourt");
  if(filterCourt && Array.isArray(cfg.courts)){
    filterCourt.innerHTML = `<option value="">All courts</option>`;
    cfg.courts.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.label;
      filterCourt.appendChild(opt);
    });
  }

  // migrate legacy bookings (add status if missing)
  (function migrateStatuses(){
    try{
      const arr = loadBookings();
      let changed = false;
      arr.forEach(b => { if(!b.status){ b.status = 'pending'; changed = true; }});
      if(changed) saveAll(arr);
    }catch(e){ /* ignore migration errors */ }
  })();

  // initial render
  renderTable(loadBookings());
  renderWaitlist();

  // wire buttons/listeners
  const exportBtn = $("#exportCsv");
  if(exportBtn) exportBtn.addEventListener("click", ()=> exportCsv());

  const clearAllBtn = $("#clearAll");
  if(clearAllBtn) clearAllBtn.addEventListener("click", ()=>{
    if(confirm("Delete ALL bookings?")){ saveAll([]); renderTable([]); }
  });

  const filterDate = $("#filterDate");
  if(filterDate){
    // default to today
    filterDate.value = new Date().toISOString().slice(0,10);
    filterDate.addEventListener("change", ()=> renderTable(loadBookings()));
  }

  if(filterCourt){
    filterCourt.addEventListener("change", ()=> renderTable(loadBookings()));
  }

  const filterStatus = $("#filterStatus");
  if(filterStatus){
    filterStatus.addEventListener("change", ()=> renderTable(loadBookings()));
  }
}

function renderTable(rows){
  const date = $("#filterDate")?.value;
  const court = $("#filterCourt")?.value;
  const status = $("#filterStatus")?.value;
  const tbody = $("#rows");
  tbody.innerHTML = "";

  rows
    .filter(r=> !date || r.dateISO===date)
    .filter(r=> !court || r.courtId===court)
    .filter(r=> !status || ((r.status || 'pending') === status))
    .sort((a,b)=> a.startISO.localeCompare(b.startISO))
    .forEach(r=>{
      const tr = document.createElement("tr");
      tr.className = "border-b";
      const startTime = new Date(r.startISO).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
      const statusBadge = ((r.status || 'pending') === 'confirmed')
        ? `<span class="px-2 py-1 rounded-full text-xs bg-emerald-100 text-emerald-700">Confirmed</span>`
        : `<span class="px-2 py-1 rounded-full text-xs bg-amber-100 text-amber-700">Pending</span>`;
      tr.innerHTML = `
        <td class="px-3 py-2 font-mono text-xs">${r.id}</td>
        <td class="px-3 py-2">${statusBadge}</td>
        <td class="px-3 py-2">${r.courtLabel || r.courtId}</td>
        <td class="px-3 py-2">${r.dateISO}</td>
        <td class="px-3 py-2">${startTime}</td>
        <td class="px-3 py-2">${escapeHtml(r.name)}<br><span class="text-gray-500 text-xs">${escapeHtml(r.phone)}</span></td>
        <td class="px-3 py-2">₹${Number(r.price||0).toLocaleString('en-IN')}</td>
        <td class="px-3 py-2">${escapeHtml(r.notes||'')}</td>
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
  // export current filtered view (respect date/court/status)
  const all = loadBookings();
  const date = $("#filterDate")?.value;
  const court = $("#filterCourt")?.value;
  const status = $("#filterStatus")?.value;
  const filtered = all
    .filter(r=> !date || r.dateISO===date)
    .filter(r=> !court || r.courtId===court)
    .filter(r=> !status || ((r.status || 'pending') === status));

  const head = ["id","status","courtLabel","courtId","dateISO","startISO","endISO","name","phone","price","notes"].join(",");
  const csvRows = filtered.map(r => {
    const notes = (r.notes) ? String(r.notes).replace(/"/g,'""') : '';
    return [r.id, (r.status||'pending'), (r.courtLabel||''), (r.courtId||''), (r.dateISO||''), (r.startISO||''), (r.endISO||''), (r.name||''), (r.phone||''), (r.price||''), `"${notes}"`].join(",");
  });
  const csv = [head].concat(csvRows).join("\n");
  const blob = new Blob([csv], {type:"text/csv"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `bookings-${new Date().toISOString().slice(0,10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ==== Waitlist Management ====
const wlKey = "turf_waitlist_v1";
function loadWaitlist(){ try { return JSON.parse(localStorage.getItem(wlKey)||"[]"); } catch(e){ return []; } }
function saveWaitlist(rows){ localStorage.setItem(wlKey, JSON.stringify(rows)); }

function renderWaitlist(){
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
      <td class="px-3 py-2">${escapeHtml(r.courtId)}</td>
      <td class="px-3 py-2">${r.dateISO}</td>
      <td class="px-3 py-2">${time}</td>
      <td class="px-3 py-2">${escapeHtml(r.name)}<br><span class="text-gray-500 text-xs">${escapeHtml(r.phone)}</span></td>
      <td class="px-3 py-2 flex gap-2">
        <a class="px-2 py-1 rounded border" target="_blank" href="https://wa.me/${String(r.phone).replace(/^\+/,'')}?text=${waText}">WhatsApp</a>
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

function escapeHtml(s){ if(s===undefined || s===null) return ''; return String(s).replace(/[&<>"]/g, c=> ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// init
window.addEventListener("load", init);
