// scripts/app.js
// Lightweight booking UI using localStorage as a demo backend

const $ = (sel, el=document) => el.querySelector(sel);
const $$ = (sel, el=document) => [...el.querySelectorAll(sel)];
const storeKey = "turf_bookings_v1";
const siteCfgUrl = "./data/site.json";

const state = {
  cfg: null,
  date: new Date(),
  courtId: null,
  phone: "",
  cart: [],
};

// Keys
const notificationsKey = "turf_notifications_v1";
const waitlistKey = "turf_waitlist_v1";

// -------------------- Utilities & storage helpers --------------------
function uuid(){ return 'xxxxxx'.replace(/x/g, ()=> (Math.random()*36|0).toString(36)); }

function loadBookings(){
  try { return JSON.parse(localStorage.getItem(storeKey) || "[]"); }
  catch(e){ return []; }
}
function saveBooking(booking){
  const all = loadBookings();
  all.push(booking);
  localStorage.setItem(storeKey, JSON.stringify(all));
  return booking.id;
}
function overwriteAllBookings(rows){ localStorage.setItem(storeKey, JSON.stringify(rows)); }
function loadAllBookings(){ return loadBookings(); }

// Notifications helpers
function loadNotifications(){ try { return JSON.parse(localStorage.getItem(notificationsKey)||"[]"); } catch(e){ return []; } }
function saveNotifications(rows){ localStorage.setItem(notificationsKey, JSON.stringify(rows)); }
function pushAdminNotification({type, title, body, bookingId}){
  const rows = loadNotifications();
  rows.unshift({ id: uuid(), type, title, body, bookingId, read:false, createdAt:new Date().toISOString() });
  localStorage.setItem(notificationsKey, JSON.stringify(rows.slice(0,200)));
}

// Waitlist helpers
function loadWaitlist(){ try { return JSON.parse(localStorage.getItem(waitlistKey)||"[]"); } catch(e){ return []; } }
function saveWaitlist(rows){ localStorage.setItem(waitlistKey, JSON.stringify(rows)); }

// -------------------- SMS (frontend stub) --------------------
// Pluggable SMS sender. Configure state.cfg.sms in data/site.json with endpoint/key to enable real SMS.
async function sendSMS(to, message){
  if(state.cfg?.sms?.enabled && state.cfg.sms.endpoint){
    try{
      await fetch(state.cfg.sms.endpoint, {
        method: 'POST',
        headers: {'Content-Type':'application/json', ...(state.cfg.sms.authHeader ? { Authorization: state.cfg.sms.authHeader } : {})},
        body: JSON.stringify({ to, message })
      });
      return true;
    }catch(e){
      console.warn('SMS send failed', e);
      // fall through to fallback
    }
  }
  // fallback: push to admin notifications so admin can see unsent SMS
  console.log('SMS disabled or endpoint missing — message to', to, message);
  pushAdminNotification({ type: 'sms-mock', title: `SMS to ${to}`, body: message, bookingId: null });
  return false;
}

// -------------------- Formatting helpers --------------------
function fmtDateISO(d){ return d.toISOString().split('T')[0]; }
function pad(n){ return String(n).padStart(2,'0'); }
function toIST(d){
  // Adjust to Asia/Kolkata (UTC+5:30) for display consistency
  const tzOffset = 5.5 * 60; // minutes
  const utc = d.getTime() + (d.getTimezoneOffset()*60000);
  return new Date(utc + tzOffset*60000);
}
function money(n){ return `₹${Number(n||0).toLocaleString('en-IN')}`; }

// -------------------- Admin: confirmBooking (where you asked to add) --------------------
async function confirmBooking(bookingId, adminNote){
  const rows = loadAllBookings();
  const idx = rows.findIndex(b => b.id === bookingId);
  if(idx === -1) { console.warn('booking not found', bookingId); return false; }

  rows[idx].status = "confirmed";
  rows[idx].adminNote = adminNote || "";
  rows[idx].confirmedAt = new Date().toISOString();
  overwriteAllBookings(rows);

  const b = rows[idx];

  // notify user
  const userMsg = `GODs Turf — Booking Confirmed ✅
Booking ID: ${b.id}
Date: ${b.dateISO}
Time: ${new Date(b.startISO).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
Court: ${b.courtLabel || b.courtId}
Collect payment at counter.`;
  await sendSMS(b.phone, userMsg);

  // notify admin (confirmation)
  const adminMsg = `Booking CONFIRMED.
ID: ${b.id}
Customer: ${b.name}, ${b.phone}
Confirmed by admin.`;
  await sendSMS(state.cfg.phone, adminMsg);
  pushAdminNotification({ type: 'booking-confirmed', title: `Booking confirmed — ${b.id}`, body: adminMsg, bookingId: b.id });

  // inform other clients / admin UI
  window.dispatchEvent(new CustomEvent('booking:confirmed', { detail: b }));
  return true;
}

// Expose to global (so inline admin.html scripts can call it)
window.confirmBooking = confirmBooking;

// -------------------- App boot & rendering --------------------
let currentShownBookingId = null;

async function init(){
  const res = await fetch(siteCfgUrl);
  state.cfg = await res.json();
  // default court
  state.courtId = state.cfg.courts[0].id;
  renderHeader();
  renderDatePicker();
  renderCourtPicker();
  renderAmenities();
  renderRules();
  renderMap();
  renderGallery();
  renderPolicies();
  renderSlots();
  attachHandlers();
}

function renderHeader(){
  const bizNameEl = $("#bizName");
  if(bizNameEl) bizNameEl.textContent = state.cfg.name;
  const addrEl = $("#addr");
  if(addrEl) addrEl.textContent = state.cfg.address;
  const callLink = $("#callLink");
  if(callLink) callLink.href = `tel:${state.cfg.phone}`;
  const wa = $("#waLink");
  if(wa) wa.href = `https://wa.me/${state.cfg.whatsapp}`;
  const mail = $("#emailLink");
  if(mail) mail.href = `mailto:${state.cfg.email}`;
}

function renderDatePicker(){
  const d = toIST(new Date());
  const min = fmtDateISO(d);
  const input = $("#date");
  if(!input) return;
  input.value = min;
  input.min = min;
  input.addEventListener("change", renderSlots);
}

function renderCourtPicker(){
  const wrap = $("#courtPicker");
  if(!wrap) return;
  wrap.innerHTML = "";
  (state.cfg.courts||[]).forEach(c=>{
    const btn = document.createElement("button");
    btn.className = "px-4 py-2 rounded-xl border hover:bg-gray-50 transition";
    btn.textContent = c.label;
    btn.dataset.id = c.id;
    if(c.id === state.courtId) btn.classList.add("ring-2","ring-emerald-400");
    btn.addEventListener("click", ()=>{
      state.courtId = c.id;
      renderCourtPicker();
      renderSlots();
    });
    wrap.appendChild(btn);
  });
}

function genSlotsForDay(dateISO, court){
  const open = state.cfg.hours.open;
  const close = state.cfg.hours.close;
  const dur = court.durationMins;
  const buffer = state.cfg.bufferMins;
  const slots = [];
  let start = new Date(`${dateISO}T${pad(open)}:00:00`);
  while(true){
    const end = new Date(start.getTime() + dur*60000);
    if(end.getHours() > close || (end.getHours()===close && end.getMinutes()>0)) break;
    slots.push({ start: new Date(start), end });
    start = new Date(end.getTime() + buffer*60000);
  }
  return slots;
}

function isOverlap(aStart,aEnd,bStart,bEnd){
  return aStart < bEnd && bStart < aEnd;
}

function computePrice(court, start){
  const base = court.basePrice;
  const { start: phStart, end: phEnd, multiplier } = state.cfg.peakHours;
  const hour = start.getHours();
  const peak = hour >= phStart && hour < phEnd;
  return Math.round(base * (peak ? multiplier : 1));
}

function renderSlots(){
  const dateInput = $("#date");
  if(!dateInput) return;
  const dateISO = dateInput.value;
  const court = state.cfg.courts.find(c=>c.id===state.courtId);
  const allBookings = loadBookings().filter(b=> b.courtId===court.id && b.dateISO===dateISO);
  const taken = allBookings.map(b=>({start:new Date(b.startISO), end:new Date(b.endISO)}));
  const list = $("#slotList");
  if(!list) return;
  list.innerHTML = "";
  const slots = genSlotsForDay(dateISO, court);
  if(!slots.length){
    list.innerHTML = `<p class="text-gray-500">No slots available for this day.</p>`;
    return;
  }
  slots.forEach(s=>{
    const price = computePrice(court, s.start);
    const disabled = taken.some(t => isOverlap(s.start, s.end, t.start, t.end));
    const item = document.createElement("button");
    item.className = "w-full flex items-center justify-between border rounded-xl p-3 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed";
    item.disabled = disabled;
    const time = `${pad(s.start.getHours())}:${pad(s.start.getMinutes())}–${pad(s.end.getHours())}:${pad(s.end.getMinutes())}`;
    item.innerHTML = `<span class="font-medium">${time}</span><span class="font-semibold">${money(price)}</span>`;
    item.addEventListener("click", ()=> openBookingModal({court, dateISO, start:s.start, end:s.end, price}));
    list.appendChild(item);
  });
}

function openBookingModal({court, dateISO, start, end, price}){
  $("#modal").classList.remove("hidden");
  $("#m-title").textContent = `${court.label}`;
  $("#m-when").textContent = `${dateISO} • ${pad(start.getHours())}:${pad(start.getMinutes())}–${pad(end.getHours())}:${pad(end.getMinutes())}`;
  $("#m-price").textContent = money(price);
  $("#m-phone").value = "";
  $("#m-name").value = "";
  $("#m-notes").value = "";
  $("#m-coupon").value = "";
  $("#m-repeat").checked = false;

  $("#m-confirm").onclick = async ()=>{
    const name = $("#m-name").value.trim();
    const phone = $("#m-phone").value.trim();
    const coupon = $("#m-coupon").value.trim();
    const repeat = $("#m-repeat").checked;
    const weeks = parseInt($("#m-weeks").value || "2", 10);
    if(!/^\+?\d{8,15}$/.test(phone)){ alert("Enter a valid phone number with country code (e.g., +91xxxxxxxxxx)."); return; }
    if(!name){ alert("Please enter your name."); return; }
    const pricing = applyCoupon(coupon, price);
    if(pricing.reason){ alert(pricing.reason); return; }

    const bookings = [];
    const occurrences = repeat ? weeks : 1;
    let startTime = new Date(start);
    let endTime = new Date(end);

    for(let i=0;i<occurrences;i++){
      const id = uuid();
      const booking = {
        id,
        courtId: court.id,
        courtLabel: court.label,
        dateISO,
        startISO: startTime.toISOString(),
        endISO: endTime.toISOString(),
        price: pricing.amount,
        discount: pricing.discount || 0,
        coupon: pricing.code || null,
        name,
        phone,
        notes: $("#m-notes").value.trim(),
        createdAt: new Date().toISOString(),
        status: "pending" // pending until admin confirms
      };

      saveBooking(booking);
      bookings.push(booking);

      // Notify user (SMS) — pending
      const userMsg = `GODs Turf — Booking received (PENDING).
Name: ${booking.name}
Date: ${booking.dateISO}
Time: ${new Date(booking.startISO).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
Amount: ${money(booking.price)}
Booking ID: ${booking.id}
Status: Pending confirmation.`;
      sendSMS(booking.phone, userMsg);

      // Notify admin (SMS + in-app)
      const adminMsg = `New booking PENDING.
ID: ${booking.id}
Court: ${booking.courtLabel}
When: ${booking.dateISO} ${new Date(booking.startISO).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
Customer: ${booking.name}, ${booking.phone}`;
      sendSMS(state.cfg.phone, adminMsg);
      pushAdminNotification({ type: 'booking-pending', title: `Booking pending — ${booking.id}`, body: adminMsg, bookingId: booking.id });

      // advance by 7 days for repeats
      startTime = new Date(startTime.getTime() + 7*24*60*60*1000);
      endTime = new Date(endTime.getTime() + 7*24*60*60*1000);
    }

    $("#modal").classList.add("hidden");
    renderSlots();
    showConfirmation(bookings[0]);
  };
}

function showConfirmation(b){
  if(!b) return;
  currentShownBookingId = b.id; // remember which booking is on screen
  $("#c-id").textContent = b.id;
  $("#c-when").textContent = `${b.dateISO} • ${new Date(b.startISO).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`;
  $("#c-court").textContent = b.courtLabel || (state.cfg.courts.find(c=>c.id===b.courtId)?.label || "");
  $("#c-amount").textContent = money(b.price);
  $("#confirmCard").classList.remove("hidden");

  // show status indicator
  let statusEl = $("#confirmCard").querySelector(".booking-status");
  if(!statusEl){
    statusEl = document.createElement("div");
    statusEl.className = "mt-2 text-sm booking-status";
    $("#confirmCard").insertBefore(statusEl, $("#confirmCard").querySelector(".mt-3"));
  }
  const statusText = b.status || 'pending';
  statusEl.textContent = `Status: ${statusText}`; // pending / confirmed
  statusEl.classList.remove('status-pending','status-confirmed');
  statusEl.classList.add((b.status === 'confirmed') ? 'status-confirmed' : 'status-pending');

  // Friendly message when pending
  let pendingNote = $("#confirmCard").querySelector(".booking-pending-note");
  if(statusText === 'pending'){
    if(!pendingNote){
      pendingNote = document.createElement("div");
      pendingNote.className = "mt-2 text-sm text-gray-700 booking-pending-note";
      // insert right below status
      statusEl.insertAdjacentElement('afterend', pendingNote);
    }
    pendingNote.textContent = "Booking received — pending confirmation. We’ll notify you on your phone.";
  } else {
    if(pendingNote) pendingNote.remove();
  }

  // update WA link too
  const whatsappText = encodeURIComponent(`Booking Request\nName: ${b.name}\nCourt: ${$("#c-court").textContent}\nDate: ${b.dateISO}\nTime: ${new Date(b.startISO).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}\nAmount: ${money(b.price)}\nBooking ID: ${b.id}\nStatus: ${statusText}`);
  $("#confirmWA").href = `https://wa.me/${state.cfg.whatsapp}?text=${whatsappText}`;
}

function closeModal(){ const modal = $("#modal"); if(modal) modal.classList.add("hidden"); }

function renderAmenities(){
  const wrap = $("#amenities");
  if(!wrap) return;
  wrap.innerHTML = "";
  (state.cfg.amenities||[]).forEach(a=>{
    const chip = document.createElement("span");
    chip.className = "px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200";
    chip.textContent = a;
    wrap.appendChild(chip);
  });
}

function renderRules(){
  const ul = $("#rules");
  if(!ul) return;
  ul.innerHTML = "";
  (state.cfg.rules||[]).forEach(r=>{
    const li = document.createElement("li");
    li.className = "flex gap-2 items-start";
    li.innerHTML = `<span class="mt-2 h-2 w-2 rounded-full bg-emerald-500"></span><p>${r}</p>`;
    ul.appendChild(li);
  });
}

function renderPolicies(){
  const el = $("#refundPolicy");
  if(el) el.textContent = state.cfg.refundPolicy || "";
}

function renderMap(){
  const map = $("#map");
  if(!map) return;
  map.innerHTML = `<iframe
      class="w-full h-64 rounded-2xl border"
      loading="lazy"
      referrerpolicy="no-referrer-when-downgrade"
      src="https://www.google.com/maps?q=${state.cfg.coords.lat},${state.cfg.coords.lng}&z=15&output=embed">
    </iframe>`;
}

function renderGallery(){
  const wrap = $("#gallery");
  if(!wrap) return;
  wrap.innerHTML = "";
  for(let i=1;i<=6;i++){
    const a = document.createElement("a");
    a.href = `./assets/gallery-${i}.svg`;
    a.target = "_blank";
    a.className = "block overflow-hidden rounded-2xl border hover:scale-[1.01] transition";
    a.innerHTML = `<img src="./assets/gallery-${i}.svg" alt="Gallery ${i}" class="w-full h-48 object-cover" />`;
    wrap.appendChild(a);
  }
}

function attachHandlers(){
  const cm = $("#closeModal");
  if(cm) cm.addEventListener("click", closeModal);
  const mc = $("#m-cancel");
  if(mc) mc.addEventListener("click", closeModal);
  // Admin link: keyboard 'A' opens prompt
  document.addEventListener("keydown", (e)=>{
    if(e.key.toLowerCase()==='a' && (e.ctrlKey || e.metaKey)){
      window.location.href = "./admin.html";
    }
  });
}

window.addEventListener("load", init);

// Update confirmation card on booking:confirmed if currently shown matches
window.addEventListener('booking:confirmed', (ev)=>{
  try{
    const detail = ev && ev.detail;
    const id = detail && detail.id;
    if(!id) return;
    if(id === currentShownBookingId){
      const all = loadBookings();
      const b = all.find(x=> x.id === id);
      if(b) showConfirmation(b);
    }
  }catch(e){ console.warn('booking:confirmed handler error', e); }
});

// -------------------- Phase-2: Waitlist, coupons, UI overrides --------------------
function applyCoupon(code, amount){
  if(!state.cfg?.coupons || !code) return { amount, discount:0, code:null, reason:null };
  const c = state.cfg.coupons.find(x=> x.code.toLowerCase() === code.toLowerCase());
  if(!c) return { amount, discount:0, code:null, reason:"Invalid code" };
  const today = new Date().toISOString().slice(0,10);
  if(c.expires && c.expires < today) return { amount, discount:0, code:null, reason:"Expired code" };
  if(amount < (c.minAmount||0)) return { amount, discount:0, code:null, reason:`Min amount ₹${c.minAmount}` };
  let discount = 0;
  if(c.type==="flat") discount = c.value;
  if(c.type==="percent") discount = Math.round(amount * (c.value/100));
  const final = Math.max(0, amount - discount);
  return { amount: final, discount, code:c.code, reason:null };
}

function addWaitlist(dateISO, courtId, startISO, name, phone){
  const id = uuid();
  const rows = loadWaitlist();
  rows.push({ id, dateISO, courtId, startISO, name, phone, createdAt:new Date().toISOString() });
  saveWaitlist(rows);
  alert("Added to waitlist ✅. We'll notify you if the slot opens.");
}

function linkJoinWaitlist(btn, slot, court){
  const dateISO = $("#date").value;
  btn.addEventListener("click", ()=>{
    const name = prompt("Your name?"); if(!name) return;
    const phone = prompt("Phone with country code (e.g., +91...)"); if(!phone) return;
    addWaitlist(dateISO, court.id, slot.start.toISOString(), name, phone);
  });
}

// Modify renderSlots to show Join Waitlist on disabled slots
const _renderSlots = renderSlots;
renderSlots = function(){
  const dateInput = $("#date");
  if(!dateInput) return;
  const dateISO = dateInput.value;
  const court = state.cfg.courts.find(c=>c.id===state.courtId);
  const allBookings = loadBookings().filter(b=> b.courtId===court.id && b.dateISO===dateISO);
  const taken = allBookings.map(b=>({start:new Date(b.startISO), end:new Date(b.endISO)}));
  const list = $("#slotList");
  if(!list) return;
  list.innerHTML = "";
  const slots = genSlotsForDay(dateISO, court);
  if(!slots.length){ list.innerHTML = `<p class="text-gray-500">No slots available for this day.</p>`; return; }
  slots.forEach(s=>{
    const price = computePrice(court, s.start);
    const disabled = taken.some(t => isOverlap(s.start, s.end, t.start, t.end));
    const item = document.createElement("div");
    item.className = "w-full flex items-center justify-between border rounded-xl p-3 gap-3";
    const time = `${pad(s.start.getHours())}:${pad(s.start.getMinutes())}–${pad(s.end.getHours())}:${pad(s.end.getMinutes())}`;
    const left = document.createElement("div");
    left.innerHTML = `<span class="font-medium">${time}</span><span class="ml-3 font-semibold">${money(price)}</span>`;
    const right = document.createElement("div");
    if(disabled){
      const wl = document.createElement("button");
      wl.className = "px-3 py-2 rounded-xl border text-gray-700 hover:bg-gray-50";
      wl.textContent = "Join Waitlist";
      linkJoinWaitlist(wl, s, court);
      right.appendChild(wl);
    } else {
      const book = document.createElement("button");
      book.className = "px-3 py-2 rounded-xl bg-emerald-600 text-white";
      book.textContent = "Book";
      book.addEventListener("click", ()=> openBookingModal({court, dateISO, start:s.start, end:s.end, price}));
      right.appendChild(book);
    }
    item.append(left, right);
    list.appendChild(item);
  });
}

// Keep openBookingModal behavior (already defined above) — no override needed

// No online payments: keep launchRazorpay as noop to avoid accidental calls
function launchRazorpay(){ console.warn('Payments disabled — launchRazorpay() is a noop'); }

// End of app.js
