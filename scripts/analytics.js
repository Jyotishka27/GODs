
function loadBookings(){ try { return JSON.parse(localStorage.getItem("turf_bookings_v1")||"[]"); } catch(e){ return []; } }

function by(arr, key){ return arr.reduce((m, x)=> (m[x[key]]=(m[x[key]]||0)+1, m), {}); }

function init(){
  const rows = loadBookings();
  // Revenue chart
  const last = rows.slice(-30);
  const labels = last.map(r=> r.dateISO);
  const values = last.map(r=> r.price||0);
  new Chart(document.getElementById("revChart").getContext("2d"), {
    type: "line",
    data: { labels, datasets: [{ label: "Revenue (₹)", data: values }] },
    options: { responsive: true, plugins: { legend: { display: false } } }
  });
  // Occupancy by hour
  const hours = Array.from({length:24}, (_,h)=>h);
  const occ = hours.map(h => rows.filter(r=> new Date(r.startISO).getHours()===h).length);
  new Chart(document.getElementById("occChart").getContext("2d"), {
    type: "bar",
    data: { labels: hours.map(h=> String(h).padStart(2,'0')+":00"), datasets: [{ label: "Bookings", data: occ }] },
    options: { responsive: true, plugins: { legend: { display: false } } }
  });
  // Courts
  const counts = by(rows, "courtLabel");
  new Chart(document.getElementById("courtChart").getContext("2d"), {
    type: "doughnut",
    data: { labels: Object.keys(counts), datasets: [{ data: Object.values(counts) }] },
    options: { responsive: true }
  });
}
window.addEventListener("load", init);
