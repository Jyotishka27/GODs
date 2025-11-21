// scripts/app.js (updated — 30min base slots, min 60min booking, 30min increments)
// Booking + Wishlist front-end using Firestore (no auth)
// - Slot buckets, pitch selector, pending/confirmed status display
// - Booking duration selectable (minimum 60 mins, increments of 30 mins)

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

/* ---------- small utils ---------- */
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
    setTimeout(() => t.remove(), opts.duration || 6000);
  } catch (e) { /* ignore */ }
}

function addTap(el, handler) {
  if (!el) return;
  el.addEventListener('click', handler);
  el.addEventListener('touchstart', function touchHandler(e){
    e.preventDefault();
    handler(e);
  }, { passive: false });
}

/* ---------- date/label helpers ---------- */
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
function to12HourLabel(slotId) {
  const [start, end] = slotId.split("-");
  return `${to12FromHHMM(start)} - ${to12FromHHMM(end)}`;
}
function niceWhen(dateStr, slotLabel) {
  const d = new Date(dateStr + "T00:00:00");
  const opts = { year: "numeric", month: "short", day: "numeric" };
  return `${d.toLocaleDateString(undefined, opts)} · ${slotLabel}`;
}

/* ---------- slots, pricing & court meta ---------- */
const BUFFER_MIN = 10;

function generate30MinSlots() {
  const slots = [];
  for (let h = 0; h < 24; h++) {
    for (let m of [0, 30]) {
      const start = `${String(h).padStart(2, "0")}:${String(m).padStart(2,"0")}`;
      // compute end by adding 30 minutes
      const endDate = new Date(1970,0,1,h,m,0);
      endDate.setMinutes(endDate.getMinutes() + 30);
      const end = `${String(endDate.getHours()).padStart(2,"0")}:${String(endDate.getMinutes()).padStart(2,"0")}`;
      slots.push({ id: `${start}-${end}`, label: `${start}-${end}`, startHour: h, start: start, end: end });
    }
  }
  return slots;
}
const ALL_SLOTS = generate30MinSlots(); // 48 slots

const PRICE_BY_COURT = { "5A": 1500, "5B": 1500, "7A": 2500, "CRK": 2500 };

const COURT_META = {
  "5A": { type: "half", label: "Half Ground Left", dims: "55×90" },
  "5B": { type: "half", label: "Half Ground Right", dims: "55×90" },
  "7A": { type: "full", label: "Full Ground", dims: "110×90" },
  "CRK": { type: "cricket", label: "Full Ground (Cricket)", dims: "110×90" }
};

/* ---------- NORMALIZATION (unchanged) ---------- */
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

/* ---------- slot helpers: mapping & expansion ---------- */
const slotIndexMap = ALL_SLOTS.reduce((acc, s, i) => { acc[s.id] = i; return acc; }, {});

function parseSlotRange(rangeId) {
  // rangeId like "06:00-07:30" or "06:00-06:30"
  const [start, end] = rangeId.split("-");
  return { start, end };
}
function slotsBetween(startId, endIdInclusive) {
  // return array of slotIds from startId up to (but not beyond) endIdInclusive's end time
  const startIdx = slotIndexMap[startId];
  if (startIdx === undefined) return [];
  // find index of a slot whose end equals end of endIdInclusive
  const targetIdx = slotIndexMap[endIdInclusive];
  if (targetIdx === undefined) return [];
  const step = startIdx <= targetIdx ? 1 : -1;
  const out = [];
  for (let i = startIdx; i <= targetIdx; i++) out.push(ALL_SLOTS[i].id);
  return out;
}
function makeRangeIdFromStartAndDuration(startSlotId, durationMins) {
  // startSlotId is a 30-min slot id like "06:00-06:30". duration typically multiple of 30.
  const [start] = startSlotId.split("-");
  const [hh, mm] = start.split(":").map(Number);
  const dt = new Date(1970,0,1,hh,mm,0);
  dt.setMinutes(dt.getMinutes() + durationMins);
  const end = `${String(dt.getHours()).padStart(2,"0")}:${String(dt.getMinutes()).padStart(2,"0")}`;
  return `${start}-${end}`;
}

// Expand an arbitrary booking range (e.g. 06:00-07:30) into constituent 30-min slot ids
function expandBookingToSlots(bookingRangeId) {
  const [start, end] = bookingRangeId.split("-");
  // find start slot index
  const startSlotId = ALL_SLOTS.find(s => s.id.startsWith(start + "-") || s.id.split("-")[0] === start);
  if (!startSlotId) return [];
  // find the index of slot whose end equals end
  const endIdx = ALL_SLOTS.findIndex(s => s.id.split("-")[1] === end);
  const startIdx = slotIndexMap[startSlotId.id];
  if (startIdx === undefined || endIdx === -1 || endIdx < startIdx) {
    // fallback: compute by minutes
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
  const out = [];
  for (let i = startIdx; i <= endIdx; i++) out.push(ALL_SLOTS[i].id);
  return out;
}

/* ---------- occupancy helpers (updated for ranges) ---------- */
function computeSlotOccupancy(bookingDocs) {
  // occupancy per 30-min slot id: { halves: Set(), full: false, cricket: false, bookings: [] }
  const m = {};
  // init all slots
  ALL_SLOTS.forEach(s => {
    m[s.id] = { halves: new Set(), full: false, cricket: false, bookings: [] };
  });

  bookingDocs.forEach(b => {
    if (!b || !b.slotId) return;
    const rawCourt = b.court ?? b.courtId ?? b.selectedCourt ?? "";
    const courtId = normalizedKey(rawCourt);
    const meta = metaFor(courtId);

    // expand this booking's slot range to constituent 30-min slot ids
    const covered = expandBookingToSlots(b.slotId);
    covered.forEach(slotId => {
      if (!m[slotId]) m[slotId] = { halves: new Set(), full: false, cricket: false, bookings: [] };
      const s = m[slotId];
      const copy = { ...b, court: courtId };
      s.bookings.push(copy);
      if ((b.status || "").toLowerCase() === "cancelled") return; // don't mark occupancy if cancelled
      if (meta.type === "half") s.halves.add(courtId);
      else if (meta.type === "full") s.full = true;
      else if (meta.type === "cricket") s.cricket = true;
    });
  });
  return m;
}

// Check if entire requested range (from startSlotId for durationMins) is available for targetCourt
function isRangeAvailableFor(occupancyMap, startSlotId, durationMins, targetCourt) {
  const rangeId = makeRangeIdFromStartAndDuration(startSlotId, durationMins);
  const slotsNeeded = expandBookingToSlots(rangeId);
  if (!slotsNeeded.length) return { allowed: false, reason: "Invalid time range." };
  const tmeta = metaFor(targetCourt);

  for (let sid of slotsNeeded) {
    const occ = occupancyMap[sid] || { halves: new Set(), full: false, cricket: false, bookings: [] };
    if (tmeta.type === "half") {
      if (occ.full) return { allowed: false, reason: `Blocked — full ground booked at ${sid}.` };
      if (occ.cricket) return { allowed: false, reason: `Blocked — cricket booked at ${sid}.` };
      if (occ.halves.size >= 2) return { allowed: false, reason: `Both halves booked at ${sid}.` };
      if (occ.halves.has(normalizedKey(targetCourt))) return { allowed: false, reason: `You already have this half booked at ${sid}.` };
    } else if (tmeta.type === "full") {
      if (occ.halves.size > 0) return { allowed: false, reason: `Blocked — half already booked at ${sid}.` };
      if (occ.cricket) return { allowed: false, reason: `Blocked — cricket booked at ${sid}.` };
      if (occ.full) return { allowed: false, reason: `Full ground booked at ${sid}.` };
    } else if (tmeta.type === "cricket") {
      if (occ.halves.size > 0) return { allowed: false, reason: `Blocked — halves already booked at ${sid}.` };
      if (occ.full) return { allowed: false, reason: `Blocked — full ground booked at ${sid}.` };
      if (occ.cricket) return { allowed: false, reason: `Cricket already booked at ${sid}.` };
    } else {
      if (occ.bookings.length) return { allowed: false, reason: `Slot already booked at ${sid}.` };
    }
  }
  return { allowed: true, reason: null };
}

/* ---------- prevent booking past slots (unchanged semantics) ---------- */
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
const mDuration = $("#m-duration"); // NEW

/* ---------- app state ---------- */
let selectedCourt = normalizedKey('5A'); // canonical initial
let selectedSlot = null; // selected 30-min slot object
let selectedDate = dateInput?.value || fmtDateISO(new Date());
let selectedAmount = PRICE_BY_COURT[selectedCourt] || 0;
let selectedBucket = "morning";
let modalMode = "booking";
let preferredBookingId = null;

/* ---------- seed static UI (unchanged) ---------- */
if (dateInput && !dateInput.value) dateInput.value = fmtDateISO(new Date());

(function populateStatic() {
  const am = $("#amenities");
  if (am) {
    ["Floodlights", "Parking", "Changing Rooms", "Water Bottle", "First Aid"].forEach(a=>{
      const el = document.createElement("span");
      el.className = "px-3 py-1 rounded-full border text-sm";
      el.textContent = a;
      am.appendChild(el);
    });
  }
  const rules = $("#rulesList");
  if (rules) {
    ["No smoking", "No outside food", "Arrive 10 mins before", "Respect booking time"].forEach(r=>{
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

/* ---------- Firestore helpers (unchanged) ---------- */
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

/* ---------- daypart bucket util (works on 30-min slots) ---------- */
function bucketSlots(slots) {
  const buckets = { midnight: [], morning: [], afternoon: [], evening: [] };
  slots.forEach(s => {
    // decide bucket by hour of slot start
    const hour = Number(s.start.split(":")[0]);
    if (hour >= 0 && hour < 6) buckets.midnight.push(s);
    else if (hour >= 6 && hour < 12) buckets.morning.push(s);
    else if (hour >= 12 && hour < 18) buckets.afternoon.push(s);
    else buckets.evening.push(s);
  });
  return buckets;
}

/* ---------- derive visible status (unchanged) ---------- */
function determineSlotStatus(occupancy, slotId) {
  const occ = occupancy[slotId];
  if (!occ || !occ.bookings || !occ.bookings.length) return { label: null, type: null };
  const statuses = occ.bookings.map(b => (b && b.status ? String(b.status).toLowerCase() : ""));
  if (statuses.includes("pending")) return { label: "Pending confirmation", type: "pending" };
  if (statuses.includes("confirmed") || statuses.includes("booked") || statuses.includes("complete")) return { label: "Booked", type: "booked" };
  return { label: "Pending confirmation", type: "pending" };
}

/* ---------- render slots UI (updated to 30-min slots + availability by minimum 60 min) ---------- */
async function renderSlots() {
  if (!slotPanel || !slotTabs) return;
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

  const occupancy = computeSlotOccupancy(bookingsAll);
  const wishlistMap = (wishlists || []).reduce((acc, w) => {
    if (!w || !w.slotId) return acc;
    if (!acc[w.slotId]) acc[w.slotId] = [];
    acc[w.slotId].push(w);
    return acc;
  }, {});

  const buckets = bucketSlots(ALL_SLOTS);

  // When computing availability for a slot displayed, we consider the minimum booking length (1 hour)
  function availableStartsForSlot(startSlotId, courtKey) {
    // return true if you can start a booking at startSlotId for the minimum (60)
    return isRangeAvailableFor(occupancy, startSlotId, 60, courtKey).allowed;
  }

  const bucketInfo = {};
  Object.entries(buckets).forEach(([key, items]) => {
    const total = items.length;
    let available = 0;
    items.forEach(s => {
      if (availableStartsForSlot(s.id, selectedCourt) && !isSlotInPast(s.id, selectedDate)) available++;
    });
    bucketInfo[key] = { total, available };
  });

  // render tabs
  slotTabs.innerHTML = "";
  const tabOrder = [
    { key: "midnight", title: "Midnight (00:00 AM–6:00 AM)" },
    { key: "morning", title: "Morning (6:00 AM–12:00 PM)" },
    { key: "afternoon", title: "Afternoon (12:00 PM–6:00 PM)" },
    { key: "evening", title: "Evening (6:00 PM–00:00 AM)" }
  ];

  const tabsWrap = document.createElement("div");
  tabsWrap.className = "w-full flex gap-2 flex-wrap";

  tabOrder.forEach(t => {
    const isActive = (t.key === selectedBucket);
    const btn = document.createElement("button");
    btn.setAttribute("data-bucket", t.key);
    btn.className = [
      "flex",
      "items-center",
      "justify-center",
      "gap-2",
      "px-3",
      "py-2",
      "rounded-full",
      "text-sm",
      "border",
      isActive ? "bg-emerald-600 text-white" : "bg-white",
    ].join(" ");
    btn.style.flex = "1 1 0";
    btn.style.minWidth = "120px";
    const badgeClass = isActive ? "bg-white/20 text-white" : "bg-gray-100 text-gray-700";
    btn.innerHTML = `<span class="truncate">${t.title}</span><span class="ml-2 text-xs ${badgeClass} px-2 py-0.5 rounded-full">${bucketInfo[t.key].available}/${bucketInfo[t.key].total}</span>`;
    addTap(btn, () => { selectedBucket = t.key; renderSlots(); });
    tabsWrap.appendChild(btn);
  });

  slotTabs.appendChild(tabsWrap);

  // render selected bucket
  slotPanel.innerHTML = "";
  const selectedItems = buckets[selectedBucket] || [];
  const header = document.createElement("div");
  header.className = "mb-3 flex items-center justify-between";
  const headTitle = document.createElement("h4");
  headTitle.className = "font-semibold";
  const titleMap = {
    midnight: "Midnight slots (00:00 AM — 6:00 AM)",
    morning: "Morning slots (6:00 AM — 12:00 PM)",
    afternoon: "Afternoon slots (12:00 PM — 6:00 PM)",
    evening: "Evening slots (6:00 PM — 00:00 AM)"
  };
  headTitle.textContent = titleMap[selectedBucket] || "Slots";
  header.appendChild(headTitle);
  const summary = document.createElement("div");
  summary.className = "text-sm text-gray-500";
  summary.textContent = `Showing ${bucketInfo[selectedBucket].available} available / ${bucketInfo[selectedBucket].total} total`;
  header.appendChild(summary);
  slotPanel.appendChild(header);

  if (!selectedItems.length) {
    const empty = document.createElement("div");
    empty.className = "text-sm text-gray-500";
    empty.textContent = "No slots in this period.";
    slotPanel.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "space-y-2";

  selectedItems.forEach(s => {
    const item = document.createElement("div");
    item.className = "flex flex-col sm:flex-row items-start sm:items-center justify-between p-3 border rounded-xl bg-white gap-3";

    const left = document.createElement("div");
    left.className = "flex-0";
    left.innerHTML = `<div class="font-medium">${to12HourLabel(s.label)}</div><div class="text-xs text-gray-500">Buffer ${BUFFER_MIN} mins</div>`;

    const middle = document.createElement("div");
    middle.className = "flex-1 text-center";

    const right = document.createElement("div");
    right.className = "flex flex-col sm:flex-row items-stretch sm:items-center gap-2";

    const past = isSlotInPast(s.id, selectedDate);
    const availForMin = isRangeAvailableFor(occupancy, s.id, 60, selectedCourt);

    if (past) {
      const pill = document.createElement("span");
      pill.className = "inline-block px-3 py-1 rounded-full text-sm font-medium bg-gray-100 text-gray-700 border border-gray-200";
      pill.textContent = "Past";
      middle.appendChild(pill);

      const count = (wishlistMap[s.id] || []).length;
      if (count > 0) {
        const badge = document.createElement("span");
        badge.className = "px-2 py-1 rounded-full text-xs border bg-white";
        badge.textContent = `Wishlist · ${count}`;
        right.appendChild(badge);
      }

      const disabledBtn = document.createElement("button");
      disabledBtn.className = "px-3 py-2 text-sm rounded-xl border text-gray-400 w-full sm:w-auto cursor-not-allowed";
      disabledBtn.textContent = "Not available";
      disabledBtn.disabled = true;
      right.appendChild(disabledBtn);

    } else if (!availForMin.allowed) {
      const st = determineSlotStatus(occupancy, s.id);
      const label = st.label || "Booked";
      const type = st.type || "booked";

      const pill = document.createElement("span");
      pill.className = `inline-block px-3 py-1 rounded-full text-sm font-medium ${type === 'pending' ? 'bg-yellow-50 text-yellow-800 border border-yellow-200' : 'bg-red-50 text-red-700 border border-red-100'}`;
      pill.textContent = label;
      middle.appendChild(pill);

      const count = (wishlistMap[s.id] || []).length;
      if (count > 0) {
        const badge = document.createElement("span");
        badge.className = "px-2 py-1 rounded-full text-xs border bg-white";
        badge.textContent = `Wishlist · ${count}`;
        right.appendChild(badge);
      }

      const wishBtn = document.createElement("button");
      wishBtn.className = "px-3 py-2 text-sm rounded-xl border hover:bg-gray-50 w-full sm:w-auto text-center";
      wishBtn.textContent = "Wishlist";
      wishBtn.title = "Add yourself to wishlist for this slot";
      addTap(wishBtn, () => {
        const occBooking = (occupancy[s.id] && occupancy[s.id].bookings && occupancy[s.id].bookings[0]) || null;
        preferredBookingId = occBooking?._id ?? null;
        openWishlistModal(s, preferredBookingId);
      });
      right.appendChild(wishBtn);

    } else {
      // slot is available at least for min 60 minutes
      const bookBtn = document.createElement("button");
      bookBtn.className = "px-3 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 w-full sm:w-auto";
      bookBtn.textContent = "Book";
      addTap(bookBtn, () => openBookingModal(s));
      right.appendChild(bookBtn);

      const count = (wishlistMap[s.id] || []).length;
      if (count > 0) {
        const badge = document.createElement("span");
        badge.className = "px-2 py-1 rounded-full text-xs border bg-white text-center";
        badge.textContent = `Wishlist · ${count}`;
        right.appendChild(badge);
      } else {
        const wishBtn = document.createElement("button");
        wishBtn.className = "px-3 py-2 text-sm rounded-xl border hover:bg-gray-50 w-full sm:w-auto";
        wishBtn.textContent = "Wishlist";
        wishBtn.title = "Add yourself to wishlist for this slot";
        addTap(wishBtn, () => {
          preferredBookingId = null;
          openWishlistModal(s, null);
        });
        right.appendChild(wishBtn);
      }
    }

    item.appendChild(left);
    item.appendChild(middle);
    item.appendChild(right);
    list.appendChild(item);
  });

  slotPanel.appendChild(list);
}

/* ---------- modal & validation (updated to support durations) ---------- */
function showFieldError(fieldEl, message) { if (!fieldEl) return; console.log("field error", fieldEl, message); }
function clearFieldErrors() {}
function setConfirmLoading(isLoading) {
  if (!mConfirm) return;
  if (isLoading) {
    mConfirm.disabled = true;
    mConfirm.dataset.orig = mConfirm.textContent;
    mConfirm.textContent = "Saving...";
    mConfirm.classList.add("opacity-70", "cursor-not-allowed");
  } else {
    mConfirm.disabled = false;
    mConfirm.textContent = mConfirm.dataset.orig || (modalMode === "wishlist" ? "Save to Wishlist" : "Confirm");
    mConfirm.classList.remove("opacity-70", "cursor-not-allowed");
  }
}
function validateModalFields() {
  clearFieldErrors();
  const name = mName?.value?.trim() || "";
  const phone = mPhone?.value?.trim() || "";
  if (name.length < 2) { showFieldError(mName, "Please enter your full name (min 2 characters)."); return { ok: false, reason: "name" }; }
  if (!/^\+?\d{8,15}$/.test(phone)) { showFieldError(mPhone, "Enter a valid phone with country code, e.g. +91..."); return { ok: false, reason: "phone" }; }
  // duration validation (only for booking)
  if (modalMode === "booking") {
    const dur = Number(mDuration?.value || 0);
    if (!dur || dur < 60 || dur % 30 !== 0) {
      showFieldError(mDuration, "Choose a valid duration (min 60, increments 30).");
      return { ok: false, reason: "duration" };
    }
  }
  return { ok: true, name, phone };
}

function lockBodyScroll() { document.body.style.overflow = 'hidden'; }
function unlockBodyScroll() { document.body.style.overflow = ''; }

function openBookingModal(slot) {
  if (isSlotInPast(slot.id, selectedDate)) {
    toast("Cannot book a slot that has already started.", { error: true });
    return;
  }
  modalMode = "booking";
  selectedSlot = slot;
  selectedAmount = PRICE_BY_COURT[selectedCourt] || 0;
  if (mTitle) mTitle.textContent = `Book ${selectedCourt} · ${slot.label}`;
  if (mWhen) mWhen.textContent = niceWhen(selectedDate, slot.label);
  if (mPrice) mPrice.textContent = `₹${selectedAmount}`;
  if (mConfirm) mConfirm.textContent = "Confirm";
  preferredBookingId = null;
  resetModalFields();
  // set default duration to 60
  if (mDuration) mDuration.value = "60";
  openModal();
}
function openWishlistModal(slot, prefBookingId = null) {
  if (isSlotInPast(slot.id, selectedDate)) {
    toast("Cannot join wishlist for a slot that has already started.", { error: true });
    return;
  }
  modalMode = "wishlist";
  selectedSlot = slot;
  selectedAmount = PRICE_BY_COURT[selectedCourt] || 0;
  if (mTitle) mTitle.textContent = `Wishlist — ${selectedCourt} · ${slot.label}`;
  if (mWhen) mWhen.textContent = niceWhen(selectedDate, slot.label);
  if (mPrice) mPrice.textContent = selectedAmount ? `₹${selectedAmount}` : "-";
  if (mConfirm) mConfirm.textContent = "Save to Wishlist";
  preferredBookingId = prefBookingId || null;
  resetModalFields();
  openModal();
  setTimeout(()=> { mName?.focus(); }, 120);
}
function openModal() { modal?.classList.remove("hidden"); lockBodyScroll(); }
function closeModalFn() { modal?.classList.add("hidden"); resetModalFields(); unlockBodyScroll(); }
function resetModalFields() {
  if (mName) mName.value = "";
  if (mPhone) mPhone.value = "";
  if (mCoupon) mCoupon.value = "";
  if (mNotes) mNotes.value = "";
  if (mDuration) { mDuration.value = "60"; }
  if (mPrice) mPrice.textContent = selectedAmount ? `₹${selectedAmount}` : "-";
  clearFieldErrors();
  setConfirmLoading(false);
}
closeModal?.addEventListener("click", closeModalFn);
mCancel?.addEventListener("click", closeModalFn);

mConfirm?.addEventListener("click", async () => {
  const v = validateModalFields();
  if (!v.ok) {
    if (v.reason === "name") toast("Please enter your name.", { error: true });
    if (v.reason === "phone") toast("Enter a valid phone with country code (e.g. +91...).", { error: true });
    if (v.reason === "duration") toast("Choose a valid duration (min 60 mins).", { error: true });
    return;
  }
  const { name, phone } = v;
  const coupon = mCoupon?.value?.trim();
  const notes = mNotes?.value?.trim();

  if (!selectedCourt || !selectedSlot || !selectedDate) { return alert("Select a pitch and date first."); }

  // final guard before saving
  if (isSlotInPast(selectedSlot.id, selectedDate)) {
    toast("That slot is in the past — cannot save booking or wishlist.", { error: true });
    return;
  }

  const normCourt = normalizedKey(selectedCourt);

  if (modalMode === "booking") {
    const durationMins = Number(mDuration?.value || 60);
    // make booking range id, e.g. "06:00-07:30"
    const slotRangeId = makeRangeIdFromStartAndDuration(selectedSlot.id, durationMins);
    const booking = {
      userName: name,
      phone,
      coupon: coupon || null,
      notes: notes || null,
      court: normCourt,
      slotId: slotRangeId,
      slotLabel: `${to12HourLabel(slotRangeId)}`,
      date: selectedDate,
      amount: selectedAmount,
      durationMins,
      status: "pending",
      createdAt: serverTimestamp()
    };

    try {
      // Fetch all bookings for the date and compute occupancy locally (needed for range overlap checks)
      const existing = await fetchBookingsForDate(selectedDate);
      const occMap = computeSlotOccupancy(existing);
      const availabilityCheck = isRangeAvailableFor(occMap, selectedSlot.id, durationMins, normCourt);
      if (!availabilityCheck.allowed) {
        alert("Sorry — that slot is not available for the selected court/time: " + (availabilityCheck.reason || "Unavailable"));
        closeModalFn();
        renderSlots();
        return;
      }

      setConfirmLoading(true);
      const ref = await addDoc(collection(db, "bookings"), booking);

      if (cid) cid.textContent = ref.id;
      if (cwhen) cwhen.textContent = `${selectedDate} · ${booking.slotLabel}`;
      if (ccourt) ccourt.textContent = (normCourt === "5A" ? "Half Ground A" : normCourt === "5B" ? "Half Ground B" : normCourt === "7A" ? "Full Ground Football" : "Cricket (Full)");
      if (camount) camount.textContent = `₹${selectedAmount}`;
      const waMsg = encodeURIComponent(`Hi GODs Turf — I booked ${booking.slotLabel} on ${selectedDate} (Booking ID: ${ref.id}). Name: ${name}, Phone: ${phone}.`);
      if (confirmWA) confirmWA.href = `https://wa.me/+917003396909?text=${waMsg}`;

      show(confirmCard);
      closeModalFn();
      toast("Booking successful — check confirmation card.", { duration: 5000 });
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
    setConfirmLoading(true);
    try {
      const dupQ = query(collection(db, "wishlists"),
        where("date", "==", selectedDate),
        where("court", "==", normalizedKey(selectedCourt)),
        where("slotId", "==", selectedSlot.id),
        where("phone", "==", phone)
      );
      const dupSnap = await getDocs(dupQ);
      const dupRows = [];
      dupSnap.forEach(d => { const dt = d.data(); dt._id = d.id; dupRows.push(dt); });
      if (dupRows.length) {
        toast("You are already on the wishlist for this slot.", { duration: 5000 });
        setConfirmLoading(false);
        closeModalFn();
        return;
      }

      const wishlistEntry = {
        userName: name,
        phone,
        notes: notes || null,
        coupon: coupon || null,
        court: normalizedKey(selectedCourt),
        slotId: selectedSlot.id,
        slotLabel: selectedSlot.label,
        date: selectedDate,
        preferredBookingId: preferredBookingId || null,
        status: "open",
        createdAt: serverTimestamp()
      };

      const ref = await addDoc(collection(db, "wishlists"), wishlistEntry);
      toast("Saved to wishlist — admin will be notified.", { duration: 6000 });
      closeModalFn();
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
dateInput?.addEventListener("change", ()=> hide(confirmCard));

/* ---------- PITCH SELECTOR (unchanged) ---------- */
// ... keep your existing initPitchSelector code as-is or copy from original file if needed
function initPitchSelector() {
  const container = document.getElementById("pitchSelectorContainer");
  if (!container) {
    console.debug("Pitch selector container not found");
    return { setSelected: (k)=>{} };
  }

  const previewUrl = './assets/turf_left.jpg';

  container.innerHTML = `
    <div class="rounded-2xl shadow-md p-3 bg-white">
      <div class="flex justify-between items-center mb-3">
        <h3 class="text-lg font-medium">Choose pitch</h3>
        <div class="space-x-2">
          <button data-pitch="half-left" class="pitch-btn px-3 py-1 rounded-full border text-sm">Half (left)</button>
          <button data-pitch="half-right" class="pitch-btn px-3 py-1 rounded-full border text-sm">Half (right)</button>
          <button data-pitch="full" class="pitch-btn px-3 py-1 rounded-full border text-sm">Full</button>
          <button data-pitch="full-cricket" class="pitch-btn px-3 py-1 rounded-full border text-sm">Full (Cricket)</button>
        </div>
      </div>

      <div class="relative flex flex-col md:flex-row gap-4">
        <div class="flex-1 flex justify-center">
          <svg id="pitchSvg" viewBox="0 0 1200 800" class="rounded-lg" style="max-width:720px;width:100%;height:auto;">
            <defs><linearGradient id="__grass" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#2f7a2f"/><stop offset="100%" stop-color="#2aa02a"/></linearGradient></defs>
            <rect x="40" y="40" rx="36" ry="36" width="1120" height="720" fill="url(#__grass)" stroke="#0d6b3c" stroke-width="3"/>
            <line x1="600" y1="40" x2="600" y2="760" stroke="#fff" stroke-width="3"/>
            <circle cx="600" cy="400" r="90" fill="none" stroke="#fff" stroke-width="3"/>
            <rect x="40" y="200" width="180" height="400" fill="none" stroke="#fff" stroke-width="3" rx="12"/>
            <rect x="980" y="200" width="180" height="400" fill="none" stroke="#fff" stroke-width="3" rx="12"/>
            <rect x="10" y="330" width="30" height="140" fill="#ffffff22" stroke="#fff" stroke-width="2"/>
            <rect x="1160" y="330" width="30" height="140" fill="#ffffff22" stroke="#fff" stroke-width="2"/>
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

  const highlight = container.querySelector("#selectionHighlight");
  function clearHighlights() { while (highlight.firstChild) highlight.removeChild(highlight.firstChild); $$(".pitch-btn", container).forEach(b => b.classList.remove("bg-green-600","text-white","bg-yellow-600")); }

  function showHighlight(type) {
    clearHighlights();
    if (!type) return;
    if (type === "half-left") {
      const r = document.createElementNS("http://www.w3.org/2000/svg","rect");
      r.setAttribute("x","40"); r.setAttribute("y","40"); r.setAttribute("width","560"); r.setAttribute("height","720");
      r.setAttribute("rx","20"); r.setAttribute("fill","#ffffff33"); r.setAttribute("stroke","#0f923f"); r.setAttribute("stroke-width","6");
      highlight.appendChild(r);
      container.querySelector('button[data-pitch="half-left"]').classList.add("bg-green-600","text-white");
    } else if (type === "half-right") {
      const r = document.createElementNS("http://www.w3.org/2000/svg","rect");
      r.setAttribute("x","600"); r.setAttribute("y","40"); r.setAttribute("width","560"); r.setAttribute("height","720");
      r.setAttribute("rx","20"); r.setAttribute("fill","#ffffff33"); r.setAttribute("stroke","#0f923f"); r.setAttribute("stroke-width","6");
      highlight.appendChild(r);
      container.querySelector('button[data-pitch="half-right"]').classList.add("bg-green-600","text-white");
    } else if (type === "full") {
      const r = document.createElementNS("http://www.w3.org/2000/svg","rect");
      r.setAttribute("x","40"); r.setAttribute("y","40"); r.setAttribute("width","1120"); r.setAttribute("height","720");
      r.setAttribute("rx","28"); r.setAttribute("fill","#ffffff55"); r.setAttribute("stroke","#0f923f"); r.setAttribute("stroke-width","8");
      highlight.appendChild(r);
      container.querySelector('button[data-pitch="full"]').classList.add("bg-green-600","text-white");
    } else if (type === "full-cricket") {
      const e = document.createElementNS("http://www.w3.org/2000/svg","ellipse");
      e.setAttribute("cx","600"); e.setAttribute("cy","400"); e.setAttribute("rx","540"); e.setAttribute("ry","330");
      e.setAttribute("fill","#fff1c433"); e.setAttribute("stroke","#d97706"); e.setAttribute("stroke-width","8");
      highlight.appendChild(e);
      container.querySelector('button[data-pitch="full-cricket"]').classList.add("bg-yellow-600","text-white");
    }
  }

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
    showHighlight(pitchKey);
    const target = pitchToCourt[pitchKey];
    selectedCourt = normalizedKey(target.id);
    selectedAmount = PRICE_BY_COURT[selectedCourt] || 0;
    updateSelectedPanel(selectedCourt);
    try { renderSlots(); } catch(e) { console.warn("renderSlots not ready", e); }
  }

  const areaFull = container.querySelector("#area-full");
  const areaCricket = container.querySelector("#area-cricket");
  const areaLeft = container.querySelector("#area-left");
  const areaRight = container.querySelector("#area-right");

  addTap(areaFull, ()=> setSelectedByPitch("full"));
  addTap(areaCricket, ()=> setSelectedByPitch("full-cricket"));
  addTap(areaLeft, ()=> setSelectedByPitch("half-left"));
  addTap(areaRight, ()=> setSelectedByPitch("half-right"));

  $$(".pitch-btn", container).forEach(b => {
    addTap(b, (ev) => {
      const p = ev.currentTarget?.getAttribute("data-pitch");
      setSelectedByPitch(p);
    });
  });

  return {
    setSelected: (pitchKey) => {
      if (!pitchToCourt[pitchKey]) return;
      setSelectedByPitch(pitchKey);
    }
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

  // small delay to allow DOM to settle, then render slots
  setTimeout(() => {
    try { renderSlots(); } catch (e) { console.error("renderSlots error", e); }
  }, 60);
});
