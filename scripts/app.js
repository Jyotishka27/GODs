// scripts/app.js (mobile-optimized timeline multi-select, 30-min ticks, min 60 min booking)
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
  el.addEventListener('click', handler);
  el.addEventListener('touchstart', function touchHandler(e){
    // prevent duplicate click and allow immediate touch feedback
    e.preventDefault();
    handler(e);
  }, { passive: false });
}

/* ---------- debug: surface runtime errors into UI ---------- */
window.addEventListener('error', ev => {
  console.error('Runtime error:', ev.error || ev.message || ev);
  const p = document.getElementById('slotPanel');
  if (p) p.innerHTML = `<div style="padding:12px;border-radius:8px;background:#fee2e2;color:#991b1b">Error: ${String(ev.error?.message || ev.message || ev).slice(0,300)}</div>`;
});
window.addEventListener('unhandledrejection', ev => {
  console.error('Unhandled rejection:', ev.reason);
  const p = document.getElementById('slotPanel');
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
const ALL_SLOTS = generate30MinSlots(); // 48 slots
const slotIndexMap = ALL_SLOTS.reduce((acc,s,i)=>{ acc[s.id]=i; return acc; }, {});

const BUFFER_MIN = 10;
const MIN_BOOKING_MINS = 60; // min 60 minutes

/* ---------- IMPORTANT: quoted keys (fix previously broken syntax) ---------- */
const PRICE_BY_COURT = { "5A": 1500, "5B": 1500, "7A": 2500, "CRK": 2500 };
const COURT_META = {
  "5A": { type: "half", label: "Half Ground Left", dims: "55×90" },
  "5B": { type: "half", label: "Half Ground Right", dims: "55×90" },
  "7A": { type: "full", label: "Full Ground", dims: "110×90" },
  "CRK": { type: "cricket", label: "Full Ground (Cricket)", dims: "110×90" }
};

/* ---------- normalization & meta helpers ---------- */
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
  if (/5A|LEFT/.test(key)) return { type: "half", label: "Half Ground Left", dims: "55×90" };
  if (/5B|RIGHT/.test(key)) return { type: "half", label: "Half Ground Right", dims: "55×90" };
  if (/7A|FULL/.test(key)) return { type: "full", label: "Full Ground", dims: "110×90" };
  if (/CRK|CRICKET/.test(key)) return { type: "cricket", label: "Full Ground (Cricket)", dims: "110×90" };
  return { type: "unknown", label: key || String(courtId), dims: "" };
}

/* ---------- expand bookings to 30-min slots ---------- */
function expandBookingToSlots(bookingRangeId) {
  if (!bookingRangeId || typeof bookingRangeId !== "string") return [];
  const [start, end] = bookingRangeId.split("-");
  // find index by start
  const startIdx = ALL_SLOTS.findIndex(s => s.id.split("-")[0] === start);
  const endIdx = ALL_SLOTS.findIndex(s => s.id.split("-")[1] === end);
  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    const out = [];
    for (let i = startIdx; i <= endIdx; i++) out.push(ALL_SLOTS[i].id);
    return out;
  }
  // fallback compute by minutes
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

/* ---------- occupancy map (per 30-min slot) ---------- */
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
      // ---- FIX: only add halves if we have a normalized courtId ----
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

/* ---------- range availability check ---------- */
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
      // if both halves taken -> blocked
      if (occ.halves.size >= 2) return { allowed: false, reason: `Both halves booked at ${sid}` };
      // if this same half already booked by someone else -> blocked
      if (targetKey && occ.halves.has(targetKey)) return { allowed: false, reason: `You already booked this half at ${sid}` };
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

/* ---------- prevent past ---------- */
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

/* ---------- DOM refs (defensive) ---------- */
const dateInput = $("#date");
const slotTabs = $("#slotTabs");
const slotPanel = $("#slotPanel");
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
const confirmWA = $("#confirmWA");

/* ---------- state ---------- */
let selectedCourt = normalizedKey("5A");
let selectedDate = dateInput?.value || fmtDateISO(new Date());
let selectedAmount = PRICE_BY_COURT[selectedCourt] || 0;
let selectedBucket = "morning";
let modalMode = "booking";
let preferredBookingId = null;

// timeline selections: set of slotIds user selected
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

/* ---------- buckets ---------- */
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

/* ---------- render helpers ---------- */
function createTimelineElement() {
  const container = document.createElement("div");
  container.className = "timeline-container";
  return { container };
}

/* apply visual highlight to selected slots in the grid */
function applySelectionHighlights(gridEl) {
  if (!gridEl) return;
  const buttons = gridEl.querySelectorAll("button[data-slot-id]");
  buttons.forEach(b => {
    const sid = b.getAttribute("data-slot-id");
    if (timelineSelection.has(sid)) {
      b.classList.remove("bg-white","slot-partial");
      b.classList.add("slot-selected");
      b.setAttribute("aria-pressed","true");
    } else {
      b.setAttribute("aria-pressed","false");
      if (b.disabled) {
        // keep disabled styling
      } else {
        b.classList.remove("slot-selected");
        b.classList.add("bg-white");
      }
    }
  });
}

/* show selection summary below timeline and show Book / Waitlist / Clear actions */
function renderSelectionSummary(gridEl, occupancyMap) {
  if (!gridEl) return;
  let summary = gridEl.parentElement.querySelector(".timeline-summary");
  if (!summary) {
    summary = document.createElement("div");
    summary.className = "timeline-summary mt-3 p-3 border rounded-lg bg-white flex flex-col sm:flex-row items-start sm:items-center gap-3 justify-between";
    gridEl.parentElement.appendChild(summary);
  }
  summary.innerHTML = "";

  if (!timelineSelection.size) {
    const hint = document.createElement("div");
    hint.className = "text-sm text-gray-600";
    hint.innerHTML = "Tap 30-min ticks above to choose start/end. Minimum booking: <strong>60 mins</strong>.";
    summary.appendChild(hint);
    return;
  }

  // compute contiguous selection start/end
  const indices = Array.from(timelineSelection).map(id => slotIndexMap[id]).filter(i => i!==undefined).sort((a,b)=>a-b);
  const min = indices[0], max = indices[indices.length-1];
  const startSlot = ALL_SLOTS[min];
  const endSlot = ALL_SLOTS[max];
  const startTime = startSlot.id.split("-")[0];
  const endTime = endSlot.id.split("-")[1];
  const durationMins = (max - min + 1) * 30;
  const price = selectedAmount;
  const priceMetric = Math.round((price * (durationMins/60)) || price);

  const info = document.createElement("div");
  info.className = "text-sm text-gray-700";
  info.innerHTML = `<div><strong>${to12FromHHMM(startTime)} — ${to12FromHHMM(endTime)}</strong> · ${durationMins} mins</div><div class="text-xs text-gray-500 mt-1">Estimate: ₹${priceMetric}</div>`;
  summary.appendChild(info);

  // actions container
  const actions = document.createElement("div");
  actions.className = "flex items-center gap-2";

  // determine availability
  const availability = isRangeAvailableFor(occupancyMap || window.__GODsTurf?.occupancyMap || {}, startSlot.id, durationMins, selectedCourt);
  const anyPast = isSlotInPast(startSlot.id, selectedDate);

  const bookBtn = document.createElement("button");
  bookBtn.className = "px-4 py-2 rounded-xl text-white";
  bookBtn.style.minWidth = "140px";

  if (anyPast) {
    bookBtn.textContent = "Cannot book past time";
    bookBtn.classList.add("bg-gray-400","cursor-not-allowed");
    bookBtn.disabled = true;
  } else if (!availability.allowed) {
    bookBtn.textContent = "Join Waitlist";
    bookBtn.classList.add("bg-yellow-600");
    addTap(bookBtn, () => {
      openWishlistModal(startSlot, null, { startSlotId: startSlot.id, durationMins, rangeId: makeRangeIdFromStartAndDuration(startSlot.id, durationMins) });
    });
  } else {
    if (durationMins < MIN_BOOKING_MINS) {
      bookBtn.textContent = "Minimum 60 mins";
      bookBtn.classList.add("bg-gray-400","cursor-not-allowed");
      bookBtn.disabled = true;
    } else {
      bookBtn.textContent = "Book";
      bookBtn.classList.add("bg-emerald-600");
      addTap(bookBtn, () => {
        openBookingModalWithRange(startSlot, durationMins);
      });
    }
  }

  const clearBtn = document.createElement("button");
  clearBtn.className = "px-3 py-2 rounded-xl border";
  clearBtn.textContent = "Clear";
  addTap(clearBtn, ()=> {
    timelineSelection = new Set();
    applySelectionHighlights(gridEl);
    renderSelectionSummary(gridEl, occupancyMap);
  });

  actions.appendChild(bookBtn);
  actions.appendChild(clearBtn);
  summary.appendChild(actions);
}

/* ---------- render slots wrapper ---------- */
async function renderSlots() {
  if (!slotPanel || !slotTabs) {
    console.warn('renderSlots: slotPanel or slotTabs missing. Aborting render.');
    return;
  }
  selectedDate = dateInput?.value || selectedDate || fmtDateISO(new Date());

  if (!selectedCourt) {
    selectedCourt = '5A';
    selectedAmount = PRICE_BY_COURT[selectedCourt] || 0;
    try { window.__GODsTurf?.updateSelectedUI && window.__GODsTurf.updateSelectedUI(metaFor(selectedCourt).label + (metaFor(selectedCourt).dims ? ` · ${metaFor(selectedCourt).dims}` : ""), selectedAmount); } catch(e){}
  }

  let bookingsAll = [], wishlists = [];
  try {
    [bookingsAll, wishlists] = await Promise.all([fetchBookingsForDate(selectedDate), fetchWishlistsFor(selectedDate, selectedCourt)]);
  } catch (e) {
    console.error("fetch error", e);
    toast("Error fetching bookings/wishlists.", { error: true });
  }

  // occupancy map per 30-min slot
  const occupancy = computeSlotOccupancy(bookingsAll);
  // store occupancy globally for helper usage
  window.__GODsTurf = window.__GODsTurf || {};
  window.__GODsTurf.occupancyMap = occupancy;

  // wishlist map (by 30-min slot id)
  const wishlistMap = (wishlists || []).reduce((acc, w) => {
    if (!w || !w.slotId) return acc;
    const covered = expandBookingToSlots(w.slotId);
    covered.forEach(sid => {
      if (!acc[sid]) acc[sid] = [];
      acc[sid].push(w);
    });
    return acc;
  }, {});

  const buckets = bucketSlots(ALL_SLOTS);
  // compute available starts (min 60)
  const bucketInfo = {};
  Object.entries(buckets).forEach(([k, items])=>{
    const total = items.length;
    let available = 0;
    items.forEach(s => {
      const ok = isRangeAvailableFor(occupancy, s.id, MIN_BOOKING_MINS, selectedCourt).allowed;
      if (ok && !isSlotInPast(s.id, selectedDate)) available++;
    });
    bucketInfo[k] = { total, available };
  });

  // build tabs
  slotTabs.innerHTML = "";
  const tabOrder = [
    { key: "midnight", title: "Midnight (00:00–06:00)" },
    { key: "morning", title: "Morning (06:00–12:00)" },
    { key: "afternoon", title: "Afternoon (12:00–18:00)" },
    { key: "evening", title: "Evening (18:00–00:00)" }
  ];
  const tabsWrap = document.createElement("div");
  tabsWrap.className = "w-full flex gap-2 flex-wrap";
  tabOrder.forEach(t=>{
    const isActive = (t.key === selectedBucket);
    const btn = document.createElement("button");
    btn.className = ["px-3","py-2","rounded-full","text-sm","border", isActive ? "bg-emerald-600 text-white":"bg-white"].join(" ");
    btn.style.flex = "1 1 0";
    btn.style.minWidth = "120px";
    btn.innerHTML = `<span class="truncate">${t.title}</span><span class="ml-2 text-xs ${isActive ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-700'} px-2 py-0.5 rounded-full">${bucketInfo[t.key].available}/${bucketInfo[t.key].total}</span>`;
    addTap(btn, ()=> { selectedBucket = t.key; timelineSelection = new Set(); renderSlots(); });
    tabsWrap.appendChild(btn);
  });
  slotTabs.appendChild(tabsWrap);

  // Render timeline for the selected bucket
  slotPanel.innerHTML = "";
  const bucketItems = buckets[selectedBucket] || [];
  const header = document.createElement("div");
  header.className = "mb-3 flex items-center justify-between";
  const title = document.createElement("h4");
  title.className = "font-semibold";
  const titleMap = { midnight: "Midnight (00:00–06:00)", morning: "Morning (06:00–12:00)", afternoon: "Afternoon (12:00–18:00)", evening: "Evening (18:00–00:00)" };
  title.textContent = titleMap[selectedBucket] || "Slots";
  header.appendChild(title);
  const summary = document.createElement("div");
  summary.className = "text-sm text-gray-500";
  summary.textContent = `Showing ${bucketInfo[selectedBucket].available} available / ${bucketInfo[selectedBucket].total} total`;
  header.appendChild(summary);
  slotPanel.appendChild(header);

  if (!bucketItems.length) {
    const emp = document.createElement("div");
    emp.className = "text-sm text-gray-500";
    emp.textContent = "No slots in this period.";
    slotPanel.appendChild(emp);
    return;
  }

  // timeline container
  const { container } = createTimelineElement();
  const bucketGrid = document.createElement("div");
  bucketGrid.className = "timeline-grid";

  // render buttons into bucketGrid
  bucketItems.forEach(slot => {
    const btn = document.createElement("button");
    btn.className = "slot-btn";
    btn.setAttribute("data-slot-id", slot.id);
    btn.style.minWidth = "64px";
    btn.style.display = "inline-flex";
    btn.style.flexDirection = "column";
    btn.style.alignItems = "center";
    btn.style.justifyContent = "center";
    btn.style.gap = "4px";

    const past = isSlotInPast(slot.id, selectedDate);
    const occ = occupancy[slot.id] || { halves: new Set(), full:false, cricket:false, bookings: [] };

    // CONSISTENT state logic
    let state = "available";
    if (past) {
      state = "past";
    } else {
      if (occ.full || occ.cricket) {
        state = "blocked";
      } else if (occ.halves && occ.halves.size >= 1) {
        state = "partial";
      } else {
        state = "available";
      }
    }

    if (state === "past") {
      btn.classList.add("slot-past");
      btn.disabled = true;
      btn.setAttribute("aria-disabled","true");
    } else if (state === "blocked") {
      btn.classList.add("slot-blocked");
      btn.disabled = true;
      btn.setAttribute("aria-disabled","true");
    } else if (state === "partial") {
      btn.classList.add("slot-partial");
      btn.disabled = false;
      btn.setAttribute("aria-disabled","false");
    } else {
      btn.classList.add("bg-white");
      btn.disabled = false;
      btn.setAttribute("aria-disabled","false");
    }

    const timeLabel = document.createElement("div");
    timeLabel.textContent = to12FromHHMM(slot.start);
    timeLabel.style.fontSize = "11px";
    timeLabel.style.opacity = "0.95";
    const sub = document.createElement("div");
    sub.textContent = slot.label.split("-")[0];
    sub.style.fontSize = "10px";
    sub.style.opacity = "0.6";
    btn.appendChild(timeLabel);
    btn.appendChild(sub);

    addTap(btn, (e) => {
      e.preventDefault();
      if (btn.disabled) {
        if (state === "blocked") {
          openWishlistModal(slot, null);
        }
        return;
      }
      const sid = slot.id;
      if (timelineSelection.has(sid)) timelineSelection.delete(sid);
      else timelineSelection.add(sid);
      normalizeSelectionToContiguous();
      // refresh visuals & summary
      const allButtons = bucketGrid.querySelectorAll("button[data-slot-id]");
      allButtons.forEach(b => {
        const id = b.getAttribute("data-slot-id");
        if (timelineSelection.has(id)) {
          b.classList.remove("bg-white","slot-partial");
          b.classList.add("slot-selected");
          b.setAttribute("aria-pressed","true");
        } else {
          b.setAttribute("aria-pressed","false");
          if (b.disabled) {
            // nothing
          } else {
            b.classList.remove("slot-selected");
            b.classList.add("bg-white");
          }
        }
      });
      renderSelectionSummary(bucketGrid, occupancy);
    });

    bucketGrid.appendChild(btn);
  });

  container.appendChild(bucketGrid);
  slotPanel.appendChild(container);

  // initial empty summary
  renderSelectionSummary(bucketGrid, occupancy);
}

/* turn timelineSelection set into contiguous range from min to max (based on slot indices) */
function normalizeSelectionToContiguous() {
  if (!timelineSelection.size) return;
  const indices = Array.from(timelineSelection).map(id => slotIndexMap[id]).filter(i => i !== undefined).sort((a,b)=>a-b);
  const min = indices[0], max = indices[indices.length - 1];
  timelineSelection = new Set();
  for (let i = min; i <= max; i++) timelineSelection.add(ALL_SLOTS[i].id);
}

/* ---------- modal helpers & booking flow ---------- */
function openBookingModalWithRange(startSlot, durationMins) {
  modalMode = "booking";
  selectedAmount = PRICE_BY_COURT[selectedCourt] || 0;
  if (mTitle) mTitle.textContent = `Book ${selectedCourt} · ${to12FromHHMM(startSlot.start)}`;
  if (mWhen) mWhen.textContent = `${selectedDate} · ${to12FromHHMM(startSlot.start)} — ${to12FromHHMM(makeRangeIdFromStartAndDuration(startSlot.id, durationMins).split("-")[1])}`;
  if (mPrice) mPrice.textContent = `₹${Math.round(selectedAmount * (durationMins/60))}`;
  if (mConfirm) mConfirm.textContent = "Confirm";
  preferredBookingId = null;
  resetModalFields();
  const mD = $("#m-duration");
  if (mD) mD.value = String(durationMins);
  // consistent dataset key used everywhere: durationMins
  if (modal) {
    modal.dataset.startSlot = startSlot.id;
    modal.dataset.durationMins = String(durationMins);
  }
  openModal();
}

function openWishlistModal(slot, prefBookingId = null, extra = null) {
  modalMode = "wishlist";
  selectedAmount = PRICE_BY_COURT[selectedCourt] || 0;
  if (mTitle) mTitle.textContent = `Wishlist — ${selectedCourt} · ${to12FromHHMM(slot.start)}`;
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
    mConfirm.textContent = mConfirm.dataset.orig || (modalMode === "wishlist" ? "Save to Wishlist" : "Confirm");
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

  // determine startSlot & duration from modal.dataset
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
    // final availability check
    const existing = await fetchBookingsForDate(selectedDate);
    const occMap = computeSlotOccupancy(existing);
    const availabilityCheck = isRangeAvailableFor(occMap, startSlotId, durationMins, normCourt);
    if (!availabilityCheck.allowed) {
      alert("Sorry — that slot/time is not available: " + (availabilityCheck.reason || "Unavailable"));
      closeModalFn();
      renderSlots();
      return;
    }

    // prorate saved amount by duration
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
      if (ccourt) ccourt.textContent = (normCourt === "5A" ? "Half Ground A" : normCourt === "5B" ? "Half Ground B" : normCourt === "7A" ? "Full Ground Football" : "Cricket (Full)");
      if (camount) camount.textContent = `₹${booking.amount}`;
      const waMsg = encodeURIComponent(`Hi GODs Turf — I booked ${booking.slotLabel} on ${selectedDate} (Booking ID: ${ref.id}). Name: ${name}, Phone: ${phone}.`);
      if (confirmWA) confirmWA.href = `https://wa.me/+917003396909?text=${waMsg}`;

      show(confirmCard);
      closeModalFn();
      toast("Booking successful — check confirmation card.", { duration: 5000 });
      // clear timeline selection
      timelineSelection = new Set();
      renderSlots();
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
    // save wishlist entry (rangeId or single slot)
    try {
      setConfirmLoading(true);
      // dedupe check
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

      // For wishlist we also save a prorated amount for clarity
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
      renderSlots();
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

/* ---------- hide confirm card on date change ---------- */
dateInput?.addEventListener("change", ()=> {
  hide(confirmCard);
  timelineSelection = new Set();
  renderSlots();
});

/* ---------- pitch selector ---------- */
function initPitchSelector() {
  const container = document.getElementById("pitchSelectorContainer");
  if (!container) {
    console.debug("Pitch selector container not found");
    return { setSelected: (k)=>{} };
  }

  const previewUrl = './assets/turf_left.jpg';

  container.innerHTML = `
    <div class="rounded-2xl shadow-md p-3 bg-white">
      <div class="flex flex-col sm:flex-row justify-between items-center mb-3 gap-3">
        <h3 class="text-lg font-medium">Choose pitch</h3>
        <div class="space-x-2 w-full sm:w-auto">
          <button data-pitch="half-left" class="pitch-btn px-3 py-1 rounded-full border text-sm">Half (left)</button>
          <button data-pitch="half-right" class="pitch-btn px-3 py-1 rounded-full border text-sm">Half (right)</button>
          <button data-pitch="full" class="pitch-btn px-3 py-1 rounded-full border text-sm">Full</button>
          <button data-pitch="full-cricket" class="pitch-btn px-3 py-1 rounded-full border text-sm">Full (Cricket)</button>
        </div>
      </div>

      <div class="relative flex flex-col md:flex-row gap-4">
        <div class="flex-1 flex justify-center">
          <!-- simplified SVG pitch -->
          <svg id="pitchSvg" viewBox="0 0 1200 800" class="rounded-lg" style="max-width:720px;width:100%;height:auto;">
            <defs><linearGradient id="__grass" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#2f7a2f"/><stop offset="100%" stop-color="#2aa02a"/></linearGradient></defs>
            <rect x="40" y="40" rx="36" ry="36" width="1120" height="720" fill="url(#__grass)" stroke="#0d6b3c" stroke-width="3"/>
            <line x1="600" y1="40" x2="600" y2="760" stroke="#fff" stroke-width="3"/>
            <circle cx="600" cy="400" r="90" fill="none" stroke="#fff" stroke-width="3"/>
            <rect x="40" y="200" width="180" height="400" fill="none" stroke="#fff" stroke-width="3" rx="12"/>
            <rect x="980" y="200" width="180" height="400" fill="none" stroke="#fff" stroke-width="3" rx="12"/>
            <rect id="area-full" x="40" y="40" width="1120" height="720" rx="28" fill="transparent" stroke="transparent" cursor="pointer" />
            <ellipse id="area-cricket" cx="600" cy="400" rx="540" ry="330" fill="transparent" stroke="transparent" stroke-width="6" cursor="pointer" />
            <rect id="area-left" x="40" y="40" width="560" height="720" rx="20" fill="transparent" stroke="transparent" cursor="pointer" />
            <rect id="area-right" x="600" y="40" width="560" height="720" rx="20" fill="transparent" stroke="transparent" cursor="pointer" />
            <text x="320" y="60" text-anchor="middle" font-size="22" fill="#fff" opacity="0.9">Left Half</text>
            <text x="880" y="60" text-anchor="middle" font-size="22" fill="#fff" opacity="0.9">Right Half</text>
            <g id="selectionHighlight"></g>
          </svg>
        </div>

        <div class="w-56 flex-shrink-0">
          <div class="rounded-md overflow-hidden border p-2 bg-white shadow-sm">
            <div class="text-xs text-gray-500 mb-2">Current UI preview</div>
            <img id="pitchPreviewImg" src="${previewUrl}" alt="current-ui" class="w-full h-40 object-cover rounded" />
            <div class="mt-2 text-xs text-gray-600">This preview is the image you uploaded — useful while replacing the half-ground graphic.</div>
          </div>
        </div>
      </div>
    </div>
  `;

  const pitchToCourt = {
    "half-left": { id: "5A", label: "Half Ground A", dims: COURT_META["5A"].dims },
    "half-right": { id: "5B", label: "Half Ground B", dims: COURT_META["5B"].dims },
    "full": { id: "7A", label: "Full Ground", dims: COURT_META["7A"].dims },
    "full-cricket": { id: "CRK", label: "Full Ground (Cricket)", dims: COURT_META["CRK"].dims }
  };

  function updateSelectedPanel(courtKey) {
    const meta = metaFor(courtKey);
    const labelWithDims = meta.label + (meta.dims ? ` · ${meta.dims}` : "");
    const price = PRICE_BY_COURT[courtKey] || 0;
    try {
      if (window && window.__GODsTurf && typeof window.__GODsTurf.updateSelectedUI === "function") {
        window.__GODsTurf.updateSelectedUI(labelWithDims, price);
      } else {
        const s = document.getElementById('selectedPitch');
        const p = document.getElementById('selectedPrice');
        if (s) s.textContent = labelWithDims;
        if (p) p.textContent = price ? `₹${price}` : '—';
      }
    } catch (e) { console.warn("updateSelectedPanel failed", e); }
  }

  function setSelectedByPitch(pitchKey) {
    if (!pitchToCourt[pitchKey]) return;
    const target = pitchToCourt[pitchKey];
    selectedCourt = normalizedKey(target.id);
    selectedAmount = PRICE_BY_COURT[selectedCourt] || 0;
    updateSelectedPanel(selectedCourt);
    try { renderSlots(); } catch(e) { console.warn("renderSlots not ready", e); }
  }

  // wire pitch buttons
  $$(".pitch-btn", container).forEach(b => {
    addTap(b, (ev) => {
      const p = ev.currentTarget?.getAttribute("data-pitch");
      setSelectedByPitch(p);
      // style toggling
      $$(".pitch-btn", container).forEach(x=> x.classList.remove("bg-green-600","text-white"));
      ev.currentTarget.classList.add("bg-green-600","text-white");
    });
  });

  const areaLeft = container.querySelector("#area-left");
  const areaRight = container.querySelector("#area-right");
  const areaFull = container.querySelector("#area-full");
  const areaCricket = container.querySelector("#area-cricket");

  addTap(areaLeft, ()=> setSelectedByPitch("half-left"));
  addTap(areaRight, ()=> setSelectedByPitch("half-right"));
  addTap(areaFull, ()=> setSelectedByPitch("full"));
  addTap(areaCricket, ()=> setSelectedByPitch("full-cricket"));

  return {
    setSelected: (pitchKey) => { if (!pitchToCourt[pitchKey]) return; setSelectedByPitch(pitchKey); }
  };
}

/* ---------- initialization ---------- */
window.addEventListener("load", async () => {
  selectedDate = dateInput?.value || fmtDateISO(new Date());
  if (dateInput && !dateInput.value) dateInput.value = selectedDate;

  let selectorApi = { setSelected: (k)=>{} };
  try { selectorApi = initPitchSelector(); } catch (e) { console.warn("initPitchSelector failed", e); }

  try {
    selectorApi.setSelected('half-left');
  } catch (e) {
    selectedCourt = '5A';
    selectedAmount = PRICE_BY_COURT[selectedCourt] || 0;
    try { window.__GODsTurf?.updateSelectedUI && window.__GODsTurf.updateSelectedUI(metaFor(selectedCourt).label + (metaFor(selectedCourt).dims ? ` · ${metaFor(selectedCourt).dims}` : ""), selectedAmount); } catch(e){}
  }

  // small debug to help validate occupancy vs selectedCourt (remove if not needed)
  window.__GODsTurf = window.__GODsTurf || {};
  window.__GODsTurf.debug = function(){ console.log('DEBUG selectedCourt', selectedCourt); console.log('DEBUG occupancy sample', window.__GODsTurf.occupancyMap); };

  // render initial slots/timeline
  setTimeout(()=> {
    try { renderSlots(); } catch (e) { console.error("renderSlots error", e); }
  }, 60);
});
