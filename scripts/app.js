// scripts/app.js (mobile-friendly drop-in replacement)
// Booking + Wishlist front-end using Firestore (no auth)
// - Slot buckets, pitch selector, pending/confirmed status display
// - Book button on right, status pill centered, wishlist on right
// - Robust normalization of court keys to avoid halves blocking each other

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

/* ---------- Firebase config ---------- */
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

/* tiny helper: attach tap-friendly handlers (click + touchstart) */
function addTap(el, handler) {
  if (!el) return;
  el.addEventListener('click', handler);
  // Add touchstart but avoid ghost clicks; preventDefault to avoid double-fire
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
function to12(t24) {
  const [hh, mm] = t24.split(":").map(Number);
  const period = hh >= 12 ? "PM" : "AM";
  let hour = hh % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${String(mm).padStart(2, "0")} ${period}`;
}
function to12HourLabel(slotId) {
  const [start, end] = slotId.split("-");
  return `${to12(start)} - ${to12(end)}`;
}
function niceWhen(dateStr, slotLabel) {
  const d = new Date(dateStr + "T00:00:00");
  const opts = { year: "numeric", month: "short", day: "numeric" };
  return `${d.toLocaleDateString(undefined, opts)} · ${slotLabel}`;
}

/* ---------- slots, pricing & court meta ---------- */
const OPEN_HOUR = 0;
const CLOSE_HOUR = 24;
const BUFFER_MIN = 10;

function generateSlots() {
  const slots = [];
  for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
    const start = `${String(h).padStart(2, "0")}:00`;
    const endHour = (h + 1) % 24;
    const end = `${String(endHour).padStart(2, "0")}:00`;
    slots.push({ id: `${start}-${end}`, label: `${start}-${end}`, startHour: h });
  }
  return slots;
}
const ALL_SLOTS = generateSlots();

const PRICE_BY_COURT = { "5A": 1500, "5B": 1500, "7A": 2500, "CRK": 2500 };

const COURT_META = {
  "5A": { type: "half", label: "Half Ground A", dims: "55×90" },
  "5B": { type: "half", label: "Half Ground B", dims: "55×90" },
  "7A": { type: "full", label: "Full Ground", dims: "110×90" },
  "CRK": { type: "cricket", label: "Full Ground (Cricket)", dims: "55×90" }
};

/* ---------- NORMALIZATION (robust) ---------- */
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
  if (/5A|LEFT/.test(key)) return { type: "half", label: "Half Ground A", dims: "55×90" };
  if (/5B|RIGHT/.test(key)) return { type: "half", label: "Half Ground B", dims: "55×90" };
  if (/7A|FULL/.test(key)) return { type: "full", label: "Full Ground", dims: "110×90" };
  if (/CRK|CRICKET/.test(key)) return { type: "cricket", label: "Full Ground (Cricket)", dims: "55×90" };
  return { type: "unknown", label: key || String(courtId), dims: "" };
}

/* ---------- occupancy helpers (fixed) ---------- */
function computeSlotOccupancy(bookingDocs) {
  const m = {};
  bookingDocs.forEach(b => {
    if (!b || !b.slotId) return;
    const slotId = b.slotId;
    const rawCourt = b.court ?? b.courtId ?? b.selectedCourt ?? "";
    const courtId = normalizedKey(rawCourt);
    const s = (m[slotId] ||= { halves: new Set(), full: false, cricket: false, bookings: [] });
    const copy = { ...b, court: courtId };
    s.bookings.push(copy);
    if ((b.status || "").toLowerCase() === "cancelled") return;
    const meta = metaFor(courtId);
    if (meta.type === "half") s.halves.add(courtId);
    else if (meta.type === "full") s.full = true;
    else if (meta.type === "cricket") s.cricket = true;
  });
  return m;
}

function isSlotAvailableFor(occupancyMap, slotId, targetCourt) {
  const occ = occupancyMap[slotId] || { halves: new Set(), full: false, cricket: false, bookings: [] };
  const tmeta = metaFor(targetCourt);
  if (tmeta.type === "half") {
    if (occ.full) return { allowed: false, reason: "Blocked — full ground already booked." };
    if (occ.cricket) return { allowed: false, reason: "Blocked — cricket booked." };
    if (occ.halves.size >= 2) return { allowed: false, reason: "Both halves already booked." };
    if (occ.halves.has(normalizedKey(targetCourt))) return { allowed: false, reason: "You already booked this half for this slot." };
    return { allowed: true, reason: null };
  } else if (tmeta.type === "full") {
    if (occ.halves.size > 0) return { allowed: false, reason: "Blocked — one or more halves already booked." };
    if (occ.cricket) return { allowed: false, reason: "Blocked — cricket booked." };
    if (occ.full) return { allowed: false, reason: "Full ground already booked." };
    return { allowed: true, reason: null };
  } else if (tmeta.type === "cricket") {
    if (occ.halves.size > 0) return { allowed: false, reason: "Blocked — halves already booked." };
    if (occ.full) return { allowed: false, reason: "Blocked — full ground booked." };
    if (occ.cricket) return { allowed: false, reason: "Cricket already booked." };
    return { allowed: true, reason: null };
  } else {
    if (occ.bookings.length) return { allowed: false, reason: "Slot already booked." };
    return { allowed: true, reason: null };
  }
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

/* ---------- app state ---------- */
let selectedCourt = normalizedKey('5A'); // canonical initial
let selectedSlot = null;
let selectedDate = dateInput?.value || fmtDateISO(new Date());
let selectedAmount = PRICE_BY_COURT[selectedCourt] || 0;

let selectedBucket = "morning";
let modalMode = "booking";
let preferredBookingId = null;

/* ---------- seed static UI ---------- */
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

/* ---------- daypart bucket util ---------- */
function bucketSlots(slots) {
  const buckets = { midnight: [], morning: [], afternoon: [], evening: [] };
  slots.forEach(s => {
    const h = s.startHour;
    if (h >= 0 && h < 6) buckets.midnight.push(s);
    else if (h >= 6 && h < 12) buckets.morning.push(s);
    else if (h >= 12 && h < 18) buckets.afternoon.push(s);
    else buckets.evening.push(s);
  });
  return buckets;
}

/* ---------- derive visible status ---------- */
function determineSlotStatus(occupancy, slotId) {
  const occ = occupancy[slotId];
  if (!occ || !occ.bookings || !occ.bookings.length) return { label: null, type: null };
  const statuses = occ.bookings.map(b => (b && b.status ? String(b.status).toLowerCase() : ""));
  if (statuses.includes("pending")) return { label: "Pending confirmation", type: "pending" };
  if (statuses.includes("confirmed") || statuses.includes("booked") || statuses.includes("complete")) return { label: "Booked", type: "booked" };
  return { label: "Pending confirmation", type: "pending" };
}

/* ---------- render slots UI ---------- */
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

  const bucketInfo = {};
  Object.entries(buckets).forEach(([key, items]) => {
    const total = items.length;
    let available = 0;
    items.forEach(s => { if (isSlotAvailableFor(occupancy, s.id, selectedCourt).allowed) available++; });
    bucketInfo[key] = { total, available };
  });

  // render tabs (equal-width buttons) - with smaller minWidth for phones
  slotTabs.innerHTML = "";
  const tabOrder = [
    { key: "midnight", title: "Midnight (12:00 AM–6:00 AM)" },
    { key: "morning", title: "Morning (6:00 AM–12:00 PM)" },
    { key: "afternoon", title: "Afternoon (12:00 PM–6:00 PM)" },
    { key: "evening", title: "Evening (6:00 PM–12:00 AM)" }
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
    // responsive equal widths: smaller min width helps phones
    btn.style.flex = "1 1 0";
    btn.style.minWidth = "120px"; // reduced so tabs fit on narrow screens
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
    midnight: "Midnight slots (12:00 AM — 6:00 AM)",
    morning: "Morning slots (6:00 AM — 12:00 PM)",
    afternoon: "Afternoon slots (12:00 PM — 6:00 PM)",
    evening: "Evening slots (6:00 PM — 12:00 AM)"
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
    // item becomes column on small screens and row on larger screens
    const item = document.createElement("div");
    item.className = "flex flex-col sm:flex-row items-start sm:items-center justify-between p-3 border rounded-xl bg-white gap-3";

    const left = document.createElement("div");
    left.className = "flex-0";
    left.innerHTML = `<div class="font-medium">${to12HourLabel(s.label)}</div><div class="text-xs text-gray-500">Buffer ${BUFFER_MIN} mins</div>`;

    const middle = document.createElement("div");
    middle.className = "flex-1 text-center";

    const right = document.createElement("div");
    right.className = "flex flex-col sm:flex-row items-stretch sm:items-center gap-2";

    const avail = isSlotAvailableFor(occupancy, s.id, selectedCourt);

    if (!avail.allowed) {
      // center: status pill (Pending / Booked)
      const st = determineSlotStatus(occupancy, s.id);
      const label = st.label || "Booked";
      const type = st.type || "booked";

      const pill = document.createElement("span");
      pill.className = `inline-block px-3 py-1 rounded-full text-sm font-medium ${type === 'pending' ? 'bg-yellow-50 text-yellow-800 border border-yellow-200' : 'bg-red-50 text-red-700 border border-red-100'}`;
      pill.textContent = label;
      middle.appendChild(pill);

      // right: wishlist (count + button)
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
      // available: right contains Book button and wishlist badge (if any)
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
        // allow user to join wishlist even when none exist yet
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

/* ---------- modal & validation ---------- */
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
  return { ok: true, name, phone };
}

function lockBodyScroll() { document.body.style.overflow = 'hidden'; }
function unlockBodyScroll() { document.body.style.overflow = ''; }

function openBookingModal(slot) {
  modalMode = "booking";
  selectedSlot = slot;
  selectedAmount = PRICE_BY_COURT[selectedCourt] || 0;
  if (mTitle) mTitle.textContent = `Book ${selectedCourt} · ${slot.label}`;
  if (mWhen) mWhen.textContent = niceWhen(selectedDate, slot.label);
  if (mPrice) mPrice.textContent = `₹${selectedAmount}`;
  if (mConfirm) mConfirm.textContent = "Confirm";
  preferredBookingId = null;
  resetModalFields();
  openModal();
}
function openWishlistModal(slot, prefBookingId = null) {
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
    return;
  }
  const { name, phone } = v;
  const coupon = mCoupon?.value?.trim();
  const notes = mNotes?.value?.trim();

  if (!selectedCourt || !selectedSlot || !selectedDate) { return alert("Select a pitch and date first."); }

  const normCourt = normalizedKey(selectedCourt);

  if (modalMode === "booking") {
    const booking = {
      userName: name,
      phone,
      coupon: coupon || null,
      notes: notes || null,
      court: normCourt,
      slotId: selectedSlot.id,
      slotLabel: selectedSlot.label,
      date: selectedDate,
      amount: selectedAmount,
      status: "pending",
      createdAt: serverTimestamp()
    };

    try {
      const conflictQ = query(collection(db, "bookings"), where("date", "==", selectedDate), where("slotId", "==", selectedSlot.id));
      const conflictSnap = await getDocs(conflictQ);
      const existing = [];
      conflictSnap.forEach(d => { const data = d.data(); data._id = d.id; existing.push(data); });

      const occMap = computeSlotOccupancy(existing);
      const availabilityCheck = isSlotAvailableFor(occMap, selectedSlot.id, normCourt);
      if (!availabilityCheck.allowed) {
        alert("Sorry — that slot is not available for the selected court: " + (availabilityCheck.reason || "Unavailable"));
        closeModalFn();
        renderSlots();
        return;
      }

      setConfirmLoading(true);
      const ref = await addDoc(collection(db, "bookings"), booking);

      if (cid) cid.textContent = ref.id;
      if (cwhen) cwhen.textContent = `${selectedDate} · ${selectedSlot.label}`;
      if (ccourt) ccourt.textContent = (normCourt === "5A" ? "Half Ground A" : normCourt === "5B" ? "Half Ground B" : normCourt === "7A" ? "Full Ground Football" : "Cricket (Full)");
      if (camount) camount.textContent = `₹${selectedAmount}`;
      const waMsg = encodeURIComponent(`Hi GODs Turf — I booked slot ${selectedSlot.label} on ${selectedDate} (Booking ID: ${ref.id}). Name: ${name}, Phone: ${phone}.`);
      if (confirmWA) confirmWA.href = `https://wa.me/917003396909?text=${waMsg}`;

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

/* ---------- PITCH SELECTOR ---------- */
function initPitchSelector() {
  const container = document.getElementById("pitchSelectorContainer");
  if (!container) {
    console.debug("Pitch selector container not found");
    return { setSelected: (k)=>{} };
  }

  // Use uploaded gallery preview path (platform converts the local path to a URL)
  const previewUrl = '/mnt/data/18f0cde1-0b47-43fb-ab5f-e1f707ab51a9.png';

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
