// scripts/app.js (updated: duration <-> timeline sync, slot styles, mobile book button wiring)
// Uses Firestore (same imports & config as before)
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.5.0/firebase-app.js";
import {
  getFirestore,
  collection,
  query,
  where,
  getDocs,
  addDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.5.0/firebase-firestore.js";

/* ---------- Firebase config (unchanged) ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyAXDvwYufUn5C_E_IYAdm094gSmyHOg46s",
  authDomain: "gods-turf.firebaseapp.com",
  projectId: "gods-turf",
  storageBucket: "gods-turf.appspot.com",
  messagingSenderId: "46992157689",
  appId: "1:46992157689:web:b547bc847c7a0331bb2b28"
};
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app);

/* ---------- tiny helpers ---------- */
const $ = (sel, el = document) => (el || document).querySelector(sel);
const $$ = (sel, el = document) => Array.from((el || document).querySelectorAll(sel));
const show = el => el?.classList.remove("hidden");
const hide = el => el?.classList.add("hidden");

function toast(msg, opts = {}) {
  try {
    const t = document.createElement("div");
    t.textContent = msg;
    t.style = `
      position: fixed;
      right: 12px;
      bottom: 12px;
      max-width: 360px;
      background: ${opts.error ? "#fee2e2" : "#ecfdf5"};
      color: ${opts.error ? "#991b1b" : "#064e3b"};
      border-radius: 8px;
      padding: 10px 12px;
      box-shadow: 0 6px 18px rgba(2,6,23,0.08);
      font-size: 13px;
      z-index: 99999;
    `;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), opts.duration || 4500);
  } catch (e) { /* ignore */ }
}

function addTap(el, handler) {
  if (!el) return;
  const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  if (isTouch) {
    el.addEventListener('touchstart', function touchHandler(e){
      e.preventDefault();
      try { handler(e); } catch(err){ console.error(err); }
    }, { passive: false });
  } else {
    el.addEventListener('click', function clickHandler(e){
      try { handler(e); } catch(err){ console.error(err); }
    });
  }
}

/* ---------- debug: surface runtime errors into UI ---------- */
window.addEventListener('error', ev => {
  console.error('Runtime error:', ev.error || ev.message || ev);
  const p = document.getElementById('timeChips');
  if (p) p.innerHTML = `<div style="padding:12px;border-radius:8px;background:#fee2e2;color:#991b1b">Error: ${String(ev.error?.message || ev.message || ev).slice(0,300)}</div>`;
});
window.addEventListener('unhandledrejection', ev => {
  console.error('Unhandled rejection:', ev.reason);
  const p = document.getElementById('timeChips');
  if (p) p.innerHTML = `<div style="padding:12px;border-radius:8px;background:#fff7ed;color:#92400e">Error: ${String(ev.reason).slice(0,300)}</div>`;
});

/* ---------- date/time helpers ---------- */
function fmtDateISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function to12FromHHMM(hhmm) {
  const [hh, mm] = hhmm.split(":").map(Number);
  const period = hh >= 12 ? "PM" : "AM";
  let hour = hh % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${String(mm).padStart(2,"0")} ${period}`;
}
function to12HourLabel(rangeId) {
  const [start, end] = rangeId.split("-");
  return `${to12FromHHMM(start)} - ${to12FromHHMM(end)}`;
}

/* ---------- slots (30 min) ---------- */
function generate30MinSlots() {
  const slots = [];
  for (let h = 0; h < 24; h++) {
    for (let m of [0, 30]) {
      const start = `${String(h).padStart(2, "0")}:${String(m).padStart(2,"0")}`;
      const endDate = new Date(1970,0,1,h,m,0);
      endDate.setMinutes(endDate.getMinutes() + 30);
      const end = `${String(endDate.getHours()).padStart(2,"0")}:${String(endDate.getMinutes()).padStart(2,"0")}`;
      slots.push({ id: `${start}-${end}`, label: `${start}-${end}`, start, end, startHour: h });
    }
  }
  return slots;
}
const ALL_SLOTS = generate30MinSlots();
const slotIndexMap = ALL_SLOTS.reduce((acc,s,i)=>{ acc[s.id]=i; return acc; }, {});

const BUFFER_MIN = 10;
const MIN_BOOKING_MINS = 60;

const PRICE_BY_COURT = { "5A": 1500, "5B": 1500, "7A": 2500, "CRK": 2500 };
const COURT_META = {
  "5A": { type: "half", label: "Half Ground — Left", dims: "55×90" },
  "5B": { type: "half", label: "Half Ground — Right", dims: "55×90" },
  "7A": { type: "full", label: "Full Ground", dims: "110×90" },
  "CRK": { type: "cricket", label: "Cricket Pitch", dims: "110×90" }
};

function normalizedKey(val) {
  if (val === undefined || val === null) return "";
  let v = String(val).trim();
  const compact = v.replace(/[\s_\-]+/g, "").toUpperCase();
  if (/^5A$/.test(compact)) return "5A";
  if (/^5B$/.test(compact)) return "5B";
  if (/^7A$/.test(compact)) return "7A";
  if (/^CRK$/.test(compact)) return "CRK";
  if (/HALF.*LEFT|LEFTHALF|^LEFT$|HALFLEFT|LEFT/i.test(v)) return "5A";
  if (/HALF.*RIGHT|RIGHTHALF|^RIGHT$|HALFRIGHT|RIGHT/i.test(v)) return "5B";
  if (/FULL.*CRICKET|CRICKET|FULLCRICKET/i.test(v)) return "CRK";
  if (/FULL|WHOLE|ENTIRE|FULLGROUND|FULL_GROUND|^7A$/i.test(v)) return "7A";
  const fallback = compact.replace(/[^A-Z0-9]/g, "");
  return fallback;
}
function metaFor(courtId) {
  const key = normalizedKey(courtId);
  if (COURT_META[key]) return COURT_META[key];
  if (/5A|LEFT/.test(key)) return { type: "half", label: "Half Ground — Left", dims: "55×90" };
  if (/5B|RIGHT/.test(key)) return { type: "half", label: "Half Ground — Right", dims: "55×90" };
  if (/7A|FULL/.test(key)) return { type: "full", label: "Full Ground", dims: "110×90" };
  if (/CRK|CRICKET/.test(key)) return { type: "cricket", label: "Cricket Pitch", dims: "110×90" };
  return { type: "unknown", label: key || String(courtId), dims: "" };
}

function expandBookingToSlots(bookingRangeId) {
  if (!bookingRangeId || typeof bookingRangeId !== "string") return [];
  const [start, end] = bookingRangeId.split("-");
  const startIdx = ALL_SLOTS.findIndex(s => s.id.split("-")[0] === start);
  const endIdx = ALL_SLOTS.findIndex(s => s.id.split("-")[1] === end);
  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    const out = [];
    for (let i = startIdx; i <= endIdx; i++) out.push(ALL_SLOTS[i].id);
    return out;
  }
  const sH = Number(start.split(":")[0]), sM = Number(start.split(":")[1]);
  const eH = Number(end.split(":")[0]), eM = Number(end.split(":")[1]);
  const sT = sH * 60 + sM;
  const eT = eH * 60 + eM;
  const out = [];
  for (let t = sT; t < eT; t += 30) {
    const sh = Math.floor(t / 60), sm = t % 60;
    const eh = Math.floor((t + 30) / 60), em = (t + 30) % 60;
    const sId = `${String(sh).padStart(2,"0")}:${String(sm).padStart(2,"0")}-${String(eh).padStart(2,"0")}:${String(em).padStart(2,"0")}`;
    out.push(sId);
  }
  return out;
}

function computeSlotOccupancy(bookingDocs) {
  const m = {};
  ALL_SLOTS.forEach(s => { m[s.id] = { halves: new Set(), full: false, cricket: false, bookings: [] }; });

  bookingDocs.forEach(b => {
    if (!b || !b.slotId) return;
    const rawCourt = b.court ?? b.courtId ?? b.selectedCourt ?? "";
    const courtId = normalizedKey(rawCourt);
    const meta = metaFor(courtId);
    const covered = expandBookingToSlots(b.slotId);
    covered.forEach(slotId => {
      if (!m[slotId]) m[slotId] = { halves: new Set(), full: false, cricket: false, bookings: [] };
      const s = m[slotId];
      const copy = { ...b, court: courtId };
      s.bookings.push(copy);
      if ((b.status || "").toLowerCase() === "cancelled") return;
      if (meta.type === "half") {
        if (courtId) s.halves.add(courtId);
      } else if (meta.type === "full") {
        s.full = true;
      } else if (meta.type === "cricket") {
        s.cricket = true;
      }
    });
  });
  return m;
}

function makeRangeIdFromStartAndDuration(startSlotId, durationMins) {
  const [start] = startSlotId.split("-");
  const [hh, mm] = start.split(":").map(Number);
  const dt = new Date(1970,0,1,hh,mm,0);
  dt.setMinutes(dt.getMinutes() + durationMins);
  const end = `${String(dt.getHours()).padStart(2,"0")}:${String(dt.getMinutes()).padStart(2,"0")}`;
  return `${start}-${end}`;
}

function isRangeAvailableFor(occupancyMap, startSlotId, durationMins, targetCourt) {
  if (!startSlotId || !targetCourt) return { allowed: false, reason: "Invalid args" };
  const rangeId = makeRangeIdFromStartAndDuration(startSlotId, durationMins);
  const slotsNeeded = expandBookingToSlots(rangeId);
  if (!slotsNeeded.length) return { allowed: false, reason: "Invalid range." };
  const tmeta = metaFor(targetCourt);
  const targetKey = normalizedKey(targetCourt);

  for (let sid of slotsNeeded) {
    const occ = occupancyMap[sid] || { halves: new Set(), full:false, cricket:false, bookings:[] };
    if (tmeta.type === "half") {
      if (occ.full) return { allowed: false, reason: `Blocked — full ground at ${sid}` };
      if (occ.cricket) return { allowed: false, reason: `Blocked — cricket at ${sid}` };
      if (occ.halves.size >= 2) return { allowed: false, reason: `Both halves booked at ${sid}` };
      if (targetKey && occ.halves.has(targetKey)) return { allowed: false, reason: `This half already booked at ${sid}` };
    } else if (tmeta.type === "full") {
      if (occ.halves.size > 0) return { allowed: false, reason: `Blocked — half booked at ${sid}` };
      if (occ.cricket) return { allowed: false, reason: `Blocked — cricket at ${sid}` };
      if (occ.full) return { allowed: false, reason: `Full booked at ${sid}` };
    } else if (tmeta.type === "cricket") {
      if (occ.halves.size > 0) return { allowed: false, reason: `Blocked — halves booked at ${sid}` };
      if (occ.full) return { allowed: false, reason: `Blocked — full booked at ${sid}` };
      if (occ.cricket) return { allowed: false, reason: `Cricket booked at ${sid}` };
    } else {
      if (occ.bookings.length) return { allowed: false, reason: `Booked at ${sid}` };
    }
  }
  return { allowed: true, reason: null };
}

function isSlotInPast(slotId, dateISO) {
  if (!slotId || !dateISO) return false;
  const [start] = slotId.split("-");
  const [hhRaw, mmRaw] = start.split(":");
  const hh = Number(hhRaw) || 0;
  const mm = Number(mmRaw) || 0;
  const slotDate = new Date(dateISO + "T00:00:00");
  slotDate.setHours(hh, mm, 0, 0);
  return slotDate.getTime() <= Date.now();
}

/* ---------- DOM refs ---------- */
const dateInput = $("#date");
const modal = $("#modal");
const closeModal = $("#closeModal");
const mTitle = $("#m-title");
const mWhen = $("#m-when");
const mPrice = $("#m-price");
const mName = $("#m-name");
const mPhone = $("#m-phone");
const mCoupon = $("#m-coupon");
const mNotes = $("#m-notes");
const mConfirm = $("#m-confirm");
const mCancel = $("#m-cancel");
const confirmCard = $("#confirmCard");
const cid = $("#c-id");
const cwhen = $("#c-when");
const ccourt = $("#c-court");
const camount = $("#c-amount");

// NEW refs for updated UI
const weekStrip      = document.getElementById('weekStrip');
const timeBucketTabs = document.getElementById('timeBucketTabs');
const timeChips      = document.getElementById('timeChips');
const durationDisplay = document.getElementById('durationDisplay');
const durationMinus   = document.getElementById('durationMinus');
const durationPlus    = document.getElementById('durationPlus');
const courtsGrid      = document.getElementById('courtsGrid');
const summaryDate     = document.getElementById('summaryDate');
const summaryStart    = document.getElementById('summaryStart');
const summaryEnd      = document.getElementById('summaryEnd');
const summaryCourt    = document.getElementById('summaryCourt');
const summaryDuration = document.getElementById('summaryDuration');
const summaryTotal    = document.getElementById('summaryTotal');
const summaryBookBtn  = document.getElementById('summaryBookBtn');
const summaryBookBtnMobile = document.getElementById('summaryBookBtnMobile');
const summaryTotalMobile = document.getElementById('summaryTotalMobile');

/* ---------- state ---------- */
let selectedCourt = normalizedKey("5A");
let selectedDate = dateInput?.value || fmtDateISO(new Date());
let selectedAmount = PRICE_BY_COURT[selectedCourt] || 0;
let selectedBucket = "morning";
let selectedDurationMins = MIN_BOOKING_MINS;
let modalMode = "booking";
let preferredBookingId = null;
let timelineSelection = new Set();

/* ---------- static UI ---------- */
if (dateInput && !dateInput.value) dateInput.value = fmtDateISO(new Date());

(function populateStatic(){
  const am = $("#amenities");
  if (am) {
    ["Floodlights","Parking","Changing Rooms","Water Bottle","First Aid"].forEach(a=>{
      const el = document.createElement("span");
      el.className = "px-3 py-1 rounded-full border text-sm";
      el.textContent = a;
      am.appendChild(el);
    });
  }
  const rules = $("#rulesList");
  if (rules) {
    ["No smoking","No outside food","Arrive 10 mins before","Respect booking time"].forEach(r=>{
      const li = document.createElement("li");
      li.className = "text-sm";
      li.textContent = r;
      rules.appendChild(li);
    });
  }
  const addr = $("#addr");
  if (addr) addr.textContent = "Near City Sports Complex, New Town, Kolkata 700156";
  const emailLink = $("#emailLink");
  if (emailLink) { emailLink.href = "mailto:godsturf@gmail.com"; emailLink.textContent = "godsturf@gmail.com"; }
})();

/* ---------- Firestore helpers ---------- */
async function fetchBookingsForDate(dateISO) {
  if (!dateISO) return [];
  try {
    const q = query(collection(db, "bookings"), where("date", "==", dateISO));
    const snap = await getDocs(q);
    const docs = [];
    snap.forEach(d => { const data = d.data(); data._id = d.id; docs.push(data); });
    return docs;
  } catch (err) {
    console.error("fetchBookingsForDate err", err);
    toast("Firestore error: " + (err?.message || err), { error: true, duration: 8000 });
    return [];
  }
}
async function fetchWishlistsFor(dateISO, courtId) {
  if (!dateISO || !courtId) return [];
  try {
    const q = query(collection(db, "wishlists"), where("date", "==", dateISO), where("court", "==", normalizedKey(courtId)));
    const snap = await getDocs(q);
    const docs = [];
    snap.forEach(d => { const data = d.data(); data._id = d.id; docs.push(data); });
    return docs;
  } catch (err) {
    console.error("fetchWishlistsFor err", err);
    toast("Firestore error (wishlists): " + (err?.message || err), { error: true, duration: 8000 });
    return [];
  }
}

function bucketSlots(slots) {
  const buckets = { midnight: [], morning: [], afternoon: [], evening: [] };
  slots.forEach(s => {
    const hour = Number(s.start.split(":")[0]);
    if (hour >= 0 && hour < 6) buckets.midnight.push(s);
    else if (hour >= 6 && hour < 12) buckets.morning.push(s);
    else if (hour >= 12 && hour < 18) buckets.afternoon.push(s);
    else buckets.evening.push(s);
  });
  return buckets;
}

/* ---------- Week strip ---------- */
function buildWeekStrip(baseDateISO) {
  if (!weekStrip) return;
  const base = baseDateISO ? new Date(baseDateISO) : new Date();
  weekStrip.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const iso = fmtDateISO(d);
    const label = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    const btn = document.createElement('button');
    const isActive = iso === selectedDate;
    btn.className = [
      'px-3','py-2','rounded-xl','text-sm','border',
      isActive ? 'bg-emerald-600 text-white' : 'bg-white text-gray-800'
    ].join(' ');
    btn.textContent = label;
    addTap(btn, () => {
      selectedDate = iso;
      if (dateInput) dateInput.value = iso;
      hide(confirmCard);
      timelineSelection = new Set();
      renderAll();
      buildWeekStrip(selectedDate);
    });
    weekStrip.appendChild(btn);
  }
}

/* ---------- Duration control ---------- */
function syncDurationDisplay() {
  if (!durationDisplay) return;
  const hrs = selectedDurationMins / 60;
  durationDisplay.textContent = hrs + ' hr' + (hrs > 1 ? 's' : '');
}
function ensureMinDuration() {
  if (selectedDurationMins < MIN_BOOKING_MINS) selectedDurationMins = MIN_BOOKING_MINS;
}

durationMinus?.addEventListener('click', () => {
  if (selectedDurationMins <= MIN_BOOKING_MINS) return;
  selectedDurationMins -= 30;
  ensureMinDuration();
  syncDurationDisplay();

  // if there's an active selection, shrink it from the end
  if (timelineSelection.size) {
    const indices = Array.from(timelineSelection).map(id => slotIndexMap[id]).filter(i => i!==undefined).sort((a,b)=>a-b);
    const startIdx = indices[0];
    const neededSlots = Math.max(1, selectedDurationMins / 30);
    timelineSelection = new Set();
    for (let i = startIdx; i < startIdx + neededSlots; i++) {
      if (ALL_SLOTS[i]) timelineSelection.add(ALL_SLOTS[i].id);
    }
    renderAll(); // re-render to reflect new selection
  } else {
    updateSummaryFromSelection();
  }
});

durationPlus?.addEventListener('click', () => {
  selectedDurationMins += 30;
  syncDurationDisplay();

  // if there's an active selection, try to expand it to the right
  if (timelineSelection.size) {
    const indices = Array.from(timelineSelection).map(id => slotIndexMap[id]).filter(i => i!==undefined).sort((a,b)=>a-b);
    const startIdx = indices[0];
    const neededSlots = Math.max(1, selectedDurationMins / 30);
    const occupancy = window.__GODsTurf?.occupancyMap || {};
    const targetCourt = selectedCourt;
    const newRangeStart = ALL_SLOTS[startIdx].id;
    const newRangeId = makeRangeIdFromStartAndDuration(newRangeStart, selectedDurationMins);
    const check = isRangeAvailableFor(occupancy, newRangeStart, selectedDurationMins, targetCourt);
    if (!check.allowed) {
      selectedDurationMins -= 30; // revert
      syncDurationDisplay();
      toast("Can't extend selection: " + (check.reason || "unavailable"), { error: true });
      return;
    }
    timelineSelection = new Set();
    for (let i = startIdx; i < startIdx + neededSlots; i++) {
      if (ALL_SLOTS[i]) timelineSelection.add(ALL_SLOTS[i].id);
    }
    renderAll();
  } else {
    updateSummaryFromSelection();
  }
});

/* ---------- render helpers ---------- */
function normalizeSelectionToContiguous() {
  if (!timelineSelection.size) return;
  const indices = Array.from(timelineSelection).map(id => slotIndexMap[id]).filter(i => i !== undefined).sort((a,b)=>a-b);
  const min = indices[0], max = indices[indices.length - 1];
  timelineSelection = new Set();
  for (let i = min; i <= max; i++) timelineSelection.add(ALL_SLOTS[i].id);
  // auto-update duration based on selection count
  const count = (max - min) + 1;
  selectedDurationMins = Math.max(MIN_BOOKING_MINS, count * 30);
  syncDurationDisplay();
}

async function renderAll() {
  selectedDate = dateInput?.value || selectedDate || fmtDateISO(new Date());

  let bookingsAll = [], wishlists = [];
  try {
    [bookingsAll, wishlists] = await Promise.all([
      fetchBookingsForDate(selectedDate),
      fetchWishlistsFor(selectedDate, selectedCourt)
    ]);
  } catch (e) {
    toast('Error fetching bookings/wishlists.', { error: true });
  }

  const occupancy = computeSlotOccupancy(bookingsAll || []);
  window.__GODsTurf = window.__GODsTurf || {};
  window.__GODsTurf.occupancyMap = occupancy;

  const buckets = bucketSlots(ALL_SLOTS);
  renderTimeBuckets(buckets, occupancy);
  renderTimeChips(buckets, occupancy);
  renderCourtsGrid(occupancy);
  updateSummaryFromSelection();
}

function renderTimeBuckets(buckets, occupancy) {
  if (!timeBucketTabs) return;
  const bucketInfo = {};
  Object.entries(buckets).forEach(([k, items]) => {
    let available = 0;
    items.forEach(s => {
      const ok = isRangeAvailableFor(occupancy, s.id, MIN_BOOKING_MINS, selectedCourt).allowed;
      if (ok && !isSlotInPast(s.id, selectedDate)) available++;
    });
    bucketInfo[k] = { total: items.length, available };
  });

  const tabOrder = [
    { key: 'midnight', title: 'Midnight' },
    { key: 'morning',  title: 'Morning' },
    { key: 'afternoon',title: 'Afternoon' },
    { key: 'evening',  title: 'Evening' }
  ];

  timeBucketTabs.innerHTML = '';
  tabOrder.forEach(t => {
    const info = bucketInfo[t.key] || { total: 0, available: 0 };
    const isActive = t.key === selectedBucket;
    const btn = document.createElement('button');
    btn.className = [
      'px-3','py-2','rounded-full','text-sm','border','flex-1',
      isActive ? 'bg-emerald-600 text-white' : 'bg-white'
    ].join(' ');
    btn.innerHTML = `
      <span class="truncate">${t.title}</span>
      <span class="ml-2 text-xs ${isActive ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-700'} px-2 py-0.5 rounded-full">
        ${info.available}/${info.total}
      </span>
    `;
    addTap(btn, () => {
      selectedBucket = t.key;
      timelineSelection = new Set(); // switching buckets clears the timeline selection (intentional)
      renderAll();
    });
    timeBucketTabs.appendChild(btn);
  });
}

function renderTimeChips(buckets, occupancy) {
  if (!timeChips) return;
  const bucketItems = buckets[selectedBucket] || [];
  timeChips.innerHTML = '';

  const container = document.createElement('div');
  container.className = 'timeline-container';
  const grid = document.createElement('div');
  grid.className = 'timeline-grid';
  container.appendChild(grid);
  timeChips.appendChild(container);

  if (!bucketItems.length) {
    const msg = document.createElement('div');
    msg.className = 'text-sm text-gray-600 p-4';
    msg.textContent = 'No slots in this period.';
    grid.appendChild(msg);
    return;
  }

  bucketItems.forEach(slot => {
    const btn = document.createElement('button');
    btn.className = 'slot-btn';
    btn.setAttribute('data-slot-id', slot.id);

    const past = isSlotInPast(slot.id, selectedDate);
    const occ = occupancy[slot.id] || { halves: new Set(), full:false, cricket:false, bookings: [] };

    let state = 'available';
    if (past) state = 'past';
    else if (occ.full || occ.cricket) state = 'blocked';
    else if (occ.halves && occ.halves.size >= 1) state = 'partial';

    // apply classes for visual states
    if (state === 'past') {
      btn.classList.add('slot-past');
      btn.disabled = true;
    } else if (state === 'blocked') {
      btn.classList.add('slot-blocked');
      btn.disabled = true;
    } else if (state === 'partial') {
      btn.classList.add('slot-partial');
    } else {
      btn.classList.add('bg-white');
    }

    // time text
    const timeLabel = document.createElement('div');
    timeLabel.textContent = to12FromHHMM(slot.start);
    timeLabel.style.fontSize = '13px';
    const sub = document.createElement('div');
    sub.textContent = slot.label.split('-')[0];
    sub.style.fontSize = '11px';
    sub.style.opacity = '0.7';
    btn.appendChild(timeLabel);
    btn.appendChild(sub);

    // if this slot is already selected in state, mark it selected
    if (timelineSelection.has(slot.id)) {
      btn.classList.remove('bg-white','slot-partial');
      btn.classList.add('slot-selected');
      btn.disabled = false; // ensure selectable visually
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault();

      if (btn.disabled) {
        if (state === 'blocked') {
          // allow wishlist on blocked slots
          openWishlistModal(slot, null);
        }
        return;
      }

      const sid = slot.id;

      // toggle this slot
      if (timelineSelection.has(sid)) {
        timelineSelection.delete(sid);
      } else {
        timelineSelection.add(sid);
      }

      // keep selection contiguous and update duration
      normalizeSelectionToContiguous();

      // re-paint all buttons in this grid
      grid.querySelectorAll('button[data-slot-id]').forEach(b => {
        const id = b.getAttribute('data-slot-id');
        if (timelineSelection.has(id)) {
          b.classList.remove('bg-white', 'slot-partial');
          b.classList.add('slot-selected');
        } else {
          b.classList.remove('slot-selected');
          if (!b.disabled) {
            b.classList.add('bg-white');
          }
        }
      });

      // update summary card
      updateSummaryFromSelection();
    });

    grid.appendChild(btn);
  });
}

function renderCourtsGrid(occupancy) {
  if (!courtsGrid) return;
  courtsGrid.innerHTML = '';
  Object.keys(PRICE_BY_COURT).forEach(courtId => {
    const meta = metaFor(courtId);
    const card = document.createElement('div');
    card.className = 'border rounded-xl p-3 flex flex-col gap-2 bg-white hover:border-emerald-500 transition';

    const title = document.createElement('div');
    title.className = 'font-semibold text-sm';
    title.textContent = meta.label;
    card.appendChild(title);

    const sub = document.createElement('div');
    sub.className = 'text-xs text-gray-500';
    sub.textContent = `Default: 60 mins · ₹${PRICE_BY_COURT[courtId]}${meta.dims ? ' · ' + meta.dims : ''}`;
    card.appendChild(sub);

    const btnRow = document.createElement('div');
    btnRow.className = 'mt-2 flex flex-wrap gap-2';
    const selectBtn = document.createElement('button');
    selectBtn.className = 'px-3 py-1.5 rounded-xl text-sm ' + (selectedCourt === courtId ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-800');
    selectBtn.textContent = selectedCourt === courtId ? 'Selected' : 'Select';
    addTap(selectBtn, () => {
      selectedCourt = courtId;
      selectedAmount = PRICE_BY_COURT[courtId] || 0;
      const s = document.getElementById('selectedPitch');
      const p = document.getElementById('selectedPrice');
      if (s) s.textContent = meta.label + (meta.dims ? ` · ${meta.dims}` : '');
      if (p) p.textContent = `₹${selectedAmount}`;
      // re-render but keep timelineSelection (so selection does not reset on court change)
      renderAll();
    });

    btnRow.appendChild(selectBtn);
    card.appendChild(btnRow);
    courtsGrid.appendChild(card);
  });
}

function updateSummaryFromSelection() {
  if (!summaryDate) return;

  summaryDate.textContent = selectedDate || '—';

  if (!timelineSelection.size) {
    if (summaryStart) summaryStart.textContent = '—';
    if (summaryEnd) summaryEnd.textContent = '—';
    if (summaryDuration) summaryDuration.textContent = '—';
    if (summaryCourt) summaryCourt.textContent = metaFor(selectedCourt).label || '—';
    if (summaryTotal) summaryTotal.textContent = '₹0';
    if (summaryTotalMobile) summaryTotalMobile.textContent = '₹0';
    if (summaryBookBtn) summaryBookBtn.disabled = true;
    if (summaryBookBtnMobile) summaryBookBtnMobile.disabled = true;
    return;
  }

  const indices = Array.from(timelineSelection).map(id => slotIndexMap[id]).filter(i => i !== undefined).sort((a,b)=>a-b);
  const min = indices[0];
  const startSlot = ALL_SLOTS[min];
  const startTime = startSlot.id.split('-')[0];

  const rangeId = makeRangeIdFromStartAndDuration(startSlot.id, selectedDurationMins);
  const [_, endTime] = rangeId.split('-');

  if (summaryStart) summaryStart.textContent = to12FromHHMM(startTime);
  if (summaryEnd) summaryEnd.textContent = to12FromHHMM(endTime);
  const hrs = selectedDurationMins / 60;
  if (summaryDuration) summaryDuration.textContent = hrs + ' hr' + (hrs > 1 ? 's' : '');
  if (summaryCourt) summaryCourt.textContent = metaFor(selectedCourt).label;
  const total = Math.round((selectedAmount || 0) * (selectedDurationMins/60));
  if (summaryTotal) summaryTotal.textContent = '₹' + total;
  if (summaryTotalMobile) summaryTotalMobile.textContent = '₹' + total;

  if (summaryBookBtn) {
    summaryBookBtn.disabled = false;
    summaryBookBtn.onclick = () => {
      openBookingModalWithRange(startSlot, selectedDurationMins);
    };
  }
  if (summaryBookBtnMobile) {
    summaryBookBtnMobile.disabled = false;
    summaryBookBtnMobile.onclick = () => {
      openBookingModalWithRange(startSlot, selectedDurationMins);
    };
  }
}

/* ---------- modal helpers & booking flow ---------- */
function openBookingModalWithRange(startSlot, durationMins) {
  modalMode = "booking";
  selectedAmount = PRICE_BY_COURT[selectedCourt] || 0;
  if (mTitle) mTitle.textContent = `Book ${metaFor(selectedCourt).label}`;
  if (mWhen) mWhen.textContent = `${selectedDate} · ${to12FromHHMM(startSlot.start)} — ${to12FromHHMM(makeRangeIdFromStartAndDuration(startSlot.id, durationMins).split("-")[1])}`;
  if (mPrice) mPrice.textContent = `₹${Math.round(selectedAmount * (durationMins/60))}`;
  if (mConfirm) mConfirm.textContent = "Confirm Booking";
  preferredBookingId = null;
  resetModalFields();
  if (modal) {
    modal.dataset.startSlot = startSlot.id;
    modal.dataset.durationMins = String(durationMins);
  }
  openModal();
}

function openWishlistModal(slot, prefBookingId = null, extra = null) {
  modalMode = "wishlist";
  selectedAmount = PRICE_BY_COURT[selectedCourt] || 0;
  if (mTitle) mTitle.textContent = `Wishlist — ${metaFor(selectedCourt).label}`;
  if (mWhen) mWhen.textContent = `${selectedDate} · ${to12FromHHMM(slot.start)}`;
  if (mPrice) mPrice.textContent = selectedAmount ? `₹${selectedAmount}` : "-";
  if (mConfirm) mConfirm.textContent = "Save to Wishlist";
  preferredBookingId = prefBookingId || null;
  resetModalFields();
  if (extra && extra.startSlotId) {
    modal.dataset.startSlot = extra.startSlotId;
    modal.dataset.durationMins = String(extra.durationMins || 30);
    modal.dataset.rangeId = extra.rangeId || "";
  } else {
    modal.dataset.startSlot = slot.id;
    modal.dataset.durationMins = String(30);
    modal.dataset.rangeId = slot.id;
  }
  openModal();
  setTimeout(()=> { mName?.focus(); }, 120);
}

function openModal() { if (modal) { modal.classList.remove("hidden"); document.body.style.overflow = 'hidden'; } }
function closeModalFn() { if (modal) modal.classList.add("hidden"); resetModalFields(); document.body.style.overflow = ''; }
function resetModalFields() {
  if (mName) mName.value = "";
  if (mPhone) mPhone.value = "";
  if (mCoupon) mCoupon.value = "";
  if (mNotes) mNotes.value = "";
  if (modal) {
    delete modal.dataset.startSlot;
    delete modal.dataset.durationMins;
    delete modal.dataset.rangeId;
  }
  setConfirmLoading(false);
}
function setConfirmLoading(isLoading) {
  if (!mConfirm) return;
  if (isLoading) {
    mConfirm.disabled = true;
    mConfirm.dataset.orig = mConfirm.textContent;
    mConfirm.textContent = "Saving...";
    mConfirm.classList.add("opacity-70","cursor-not-allowed");
  } else {
    mConfirm.disabled = false;
    mConfirm.textContent = mConfirm.dataset.orig || (modalMode === "wishlist" ? "Save to Wishlist" : "Confirm Booking");
    mConfirm.classList.remove("opacity-70","cursor-not-allowed");
  }
}
function validateModalFields() {
  const name = mName?.value?.trim() || "";
  const phone = mPhone?.value?.trim() || "";
  if (name.length < 2) return { ok:false, reason:"name" };
  if (!/^\+?\d{8,15}$/.test(phone)) return { ok:false, reason:"phone" };
  return { ok:true, name, phone };
}

closeModal?.addEventListener("click", closeModalFn);
mCancel?.addEventListener("click", closeModalFn);

mConfirm?.addEventListener("click", async () => {
  const v = validateModalFields();
  if (!v.ok) {
    if (v.reason === "name") toast("Please enter your name.", { error: true });
    if (v.reason === "phone") toast("Enter a valid phone with country code (e.g. +91...).", { error: true });
    return;
  }
  const { name, phone } = v;
  const coupon = mCoupon?.value?.trim();
  const notes = mNotes?.value?.trim();

  if (!selectedCourt || !selectedDate) { return alert("Select a pitch and date first."); }

  const startSlotId = modal?.dataset?.startSlot;
  const durationMins = Number(modal?.dataset?.durationMins || MIN_BOOKING_MINS);
  const rangeId = modal?.dataset?.rangeId || makeRangeIdFromStartAndDuration(startSlotId, durationMins);

  if (!startSlotId) return alert("No time selected.");

  if (isSlotInPast(startSlotId, selectedDate)) {
    toast("That slot is in the past — cannot save booking or wishlist.", { error: true });
    return;
  }

  const normCourt = normalizedKey(selectedCourt);

  if (modalMode === "booking") {
    const existing = await fetchBookingsForDate(selectedDate);
    const occMap = computeSlotOccupancy(existing);
    const availabilityCheck = isRangeAvailableFor(occMap, startSlotId, durationMins, normCourt);
    if (!availabilityCheck.allowed) {
      alert("Sorry — that slot/time is not available: " + (availabilityCheck.reason || "Unavailable"));
      closeModalFn();
      renderAll();
      return;
    }

    const amountToSave = Math.round((selectedAmount || 0) * (durationMins / 60));

    const booking = {
      userName: name,
      phone,
      coupon: coupon || null,
      notes: notes || null,
      court: normCourt,
      slotId: rangeId,
      slotLabel: to12HourLabel(rangeId),
      date: selectedDate,
      amount: amountToSave,
      durationMins,
      status: "pending",
      createdAt: serverTimestamp()
    };

    try {
      setConfirmLoading(true);
      const ref = await addDoc(collection(db, "bookings"), booking);
      if (cid) cid.textContent = ref.id;
      if (cwhen) cwhen.textContent = `${selectedDate} · ${booking.slotLabel}`;
      if (ccourt) ccourt.textContent = metaFor(normCourt).label;
      if (camount) camount.textContent = `₹${booking.amount}`;
      const waMsg = encodeURIComponent(`Hi GODs Turf — I booked ${booking.slotLabel} on ${selectedDate} (Booking ID: ${ref.id}). Name: ${name}, Phone: ${phone}.`);
      if (confirmWA) confirmWA.href = `https://wa.me/+917003396909?text=${waMsg}`;

      show(confirmCard);
      closeModalFn();
      toast("Booking successful — check confirmation card.", { duration: 5000 });
      timelineSelection = new Set();
      renderAll();
    } catch (err) {
      console.error("Booking failed", err);
      toast("Booking failed: " + (err?.message || String(err)), { error: true, duration: 8000 });
      alert("Booking failed — check console. Error: " + (err?.message || String(err)));
    } finally {
      setConfirmLoading(false);
    }
    return;
  }

  if (modalMode === "wishlist") {
    try {
      setConfirmLoading(true);
      const dupQ = query(collection(db, "wishlists"),
        where("date","==", selectedDate),
        where("court","==", normalizedKey(selectedCourt)),
        where("slotId","==", rangeId),
        where("phone","==", phone)
      );
      const dupSnap = await getDocs(dupQ);
      const dup = [];
      dupSnap.forEach(d => { const dt = d.data(); dt._id = d.id; dup.push(dt); });
      if (dup.length) {
        toast("You are already on the wishlist for this slot.", { duration: 5000 });
        setConfirmLoading(false);
        closeModalFn();
        return;
      }

      const wishlistAmount = Math.round((selectedAmount || 0) * (durationMins / 60));
      const wishlistEntry = {
        userName: name,
        phone,
        notes: notes || null,
        coupon: coupon || null,
        court: normalizedKey(selectedCourt),
        slotId: rangeId,
        slotLabel: to12HourLabel(rangeId),
        date: selectedDate,
        amount: wishlistAmount,
        preferredBookingId: preferredBookingId || null,
        status: "open",
        createdAt: serverTimestamp()
      };
      const ref = await addDoc(collection(db, "wishlists"), wishlistEntry);
      toast("Saved to wishlist — admin will be notified.", { duration: 6000 });
      closeModalFn();
      timelineSelection = new Set();
      renderAll();
    } catch (err) {
      console.error("Wishlist save failed", err);
      toast("Wishlist save failed: " + (err?.message || String(err)), { error: true, duration: 8000 });
      alert("Wishlist save failed — check console. Error: " + (err?.message || String(err)));
    } finally {
      setConfirmLoading(false);
    }
    return;
  }
});

dateInput?.addEventListener("change", ()=> {
  hide(confirmCard);
  timelineSelection = new Set();
  selectedDate = dateInput.value;
  buildWeekStrip(selectedDate);
  renderAll();
});

/* ---------- pitch selector (simplified for new layout) ---------- */
function initPitchSelector() {
  const container = document.getElementById("pitchSelectorContainer");
  if (!container) return;

  container.innerHTML = `
    <div class="text-sm text-gray-600">
      <p>Select a court from the grid below to view availability and book.</p>
    </div>
  `;
}

/* ---------- initialization ---------- */
window.addEventListener('DOMContentLoaded', () => {
  initPitchSelector();

  // Set selected pitch display
  const s = document.getElementById('selectedPitch');
  const p = document.getElementById('selectedPrice');
  if (s) s.textContent = metaFor(selectedCourt).label + (metaFor(selectedCourt).dims ? ` · ${metaFor(selectedCourt).dims}` : '');
  if (p) p.textContent = `₹${selectedAmount}`;

  buildWeekStrip(selectedDate);
  syncDurationDisplay();
  renderAll();

  // Wire mobile Details/Book buttons if present
  const detailsBtn = document.getElementById('summaryViewMobile');
  if (detailsBtn) detailsBtn.addEventListener('click', () => {
    const bookSection = document.getElementById('book');
    if (bookSection) bookSection.scrollIntoView({ behavior: 'smooth' });
  });

  // sync desktop total -> mobile total periodically (keeps mobile widget in sync with other scripts)
  if (summaryTotal && summaryTotalMobile) {
    setInterval(() => {
      if (summaryTotal.textContent !== summaryTotalMobile.textContent) summaryTotalMobile.textContent = summaryTotal.textContent;
    }, 500);
  }
});
