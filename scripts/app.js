// scripts/app.js (final ready-to-drop)
// Booking + Wishlist front-end using Firestore (no auth)
// - Shows "Booked" (no username) + Wishlist button for occupied slots
// - Prevents duplicate bookings via pre-check
// - Stores wishlists in top-level `wishlists` collection
// - Includes helpful toasts, validation, wishlist modal UX, and mutual-exclusion booking rules

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

/* ---------- Utility functions ---------- */
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
  } catch (e) {
    console.warn("toast failed", e);
  }
}

function fmtDateISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function niceWhen(dateStr, slotLabel) {
  const d = new Date(dateStr + "T00:00:00");
  const opts = { year: "numeric", month: "short", day: "numeric" };
  return `${d.toLocaleDateString(undefined, opts)} · ${slotLabel}`;
}

/* ---------- Slot generation ---------- */
const OPEN_HOUR = 6;
const CLOSE_HOUR = 23;
const BUFFER_MIN = 10;

function generateSlots() {
  const slots = [];
  for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
    const start = `${String(h).padStart(2, "0")}:00`;
    const end = `${String(h + 1).padStart(2, "0")}:00`;
    // hyphen used consistently in id/label
    slots.push({ id: `${start}-${end}`, label: `${start}-${end}`, startHour: h });
  }
  return slots;
}
const ALL_SLOTS = generateSlots();

/* ---------- Prices ---------- */
const PRICE_BY_COURT = { "5A": 1500, "5B": 1500, "7A": 2500, "CRK": 2500 };

/* ---------- Court meta (edit to match your actual court data-ids) ---------- */
const COURT_META = {
  "5A": { type: "half", label: "Half A" },
  "5B": { type: "half", label: "Half B" }, // keep if you support two halves
  "7A": { type: "full", label: "Full Ground" },
  "CRK": { type: "cricket", label: "Cricket (Full)" }
};

function normalizedKey(val) {
  return (val === undefined || val === null) ? "" : String(val).trim().toUpperCase();
}

/* ---------- Replaced: metaFor (normalizes keys) ---------- */
function metaFor(courtId) {
  const key = normalizedKey(courtId);
  return COURT_META[key] || { type: "unknown", label: key || courtId };
}

/* ---------- occupancy helpers (normalizes stored court ids) ---------- */
/**
 * bookingDocs: array of booking objects with fields { slotId, court, status, ... }
 * returns map: slotId -> { halves: Set(courtIds), full: boolean, cricket: boolean, bookings: [...] }
 */
function computeSlotOccupancy(bookingDocs) {
  const m = {};
  bookingDocs.forEach(b => {
    if (!b || !b.slotId) return;
    const slotId = b.slotId;
    const courtIdRaw = b.court ?? "";
    const courtId = normalizedKey(courtIdRaw);
    const s = (m[slotId] ||= { halves: new Set(), full: false, cricket: false, bookings: [] });
    // push a copy with normalized court for easier debugging
    const copy = { ...b, court: courtId };
    s.bookings.push(copy);
    if (b.status === "cancelled") return; // ignore cancelled

    const meta = metaFor(courtId);
    if (meta.type === "half") s.halves.add(courtId);
    else if (meta.type === "full") s.full = true;
    else if (meta.type === "cricket") s.cricket = true;
  });

  // debug log for occupancy
  Object.keys(m).forEach(slotId => {
    try {
      console.debug("Occupancy for", slotId, {
        halves: Array.from(m[slotId].halves),
        full: m[slotId].full,
        cricket: m[slotId].cricket,
        bookings: m[slotId].bookings
      });
    } catch (e) { /* ignore */ }
  });

  return m;
}

/**
 * Decide whether a slot is available for a targetCourt based on occupancy map
 * returns { allowed: boolean, reason: string|null }
 */
function isSlotAvailableFor(occupancyMap, slotId, targetCourt) {
  const occ = occupancyMap[slotId] || { halves: new Set(), full: false, cricket: false, bookings: [] };
  const tmeta = metaFor(targetCourt);
  if (tmeta.type === "half") {
    if (occ.full) return { allowed: false, reason: "Blocked — full ground already booked." };
    if (occ.cricket) return { allowed: false, reason: "Blocked — cricket booked." };
    // allow up to 2 half bookings (different halves)
    if (occ.halves.size >= 2) return { allowed: false, reason: "Both halves already booked." };
    // block duplicate same-half booking
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
    // unknown type -> be conservative
    if (occ.bookings.length) return { allowed: false, reason: "Slot already booked." };
    return { allowed: true, reason: null };
  }
}

/* ---------- DOM refs ---------- */
const dateInput = $("#date");
const slotList = $("#slotList");
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
let selectedCourt = null;   // will be set by pitch selector
let selectedSlot = null;
let selectedDate = null;
let selectedAmount = 0;

let modalMode = "booking";         // "booking" or "wishlist"
let preferredBookingId = null;     // used when saving wishlist from an occupied slot

/* ---------- set defaults & populate static UI ---------- */
if (dateInput) dateInput.value = fmtDateISO(new Date());

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
  if (emailLink) { emailLink.href = "mailto:hello@gods.example"; emailLink.textContent = "hello@gods.example"; }
})();

/* ---------- Firestore helpers ---------- */
async function fetchBookingsFor(dateISO, courtId) {
  if (!dateISO || !courtId) return [];
  try {
    // ensure courtId normalized for query (DB should store normalized keys)
    const q = query(
      collection(db, "bookings"),
      where("date", "==", dateISO),
      where("court", "==", normalizedKey(courtId))
    );
    const snap = await getDocs(q);
    const docs = [];
    snap.forEach(d => {
      const data = d.data();
      data._id = d.id;
      docs.push(data);
    });
    return docs;
  } catch (err) {
    console.error("fetchBookingsFor err", err);
    toast("Firestore error: " + (err?.message || err), { error: true, duration: 8000 });
    return [];
  }
}

// New helper: fetch ALL bookings for a date (across courts) - used to compute occupancy per slot
async function fetchBookingsForDate(dateISO) {
  if (!dateISO) return [];
  try {
    const q = query(
      collection(db, "bookings"),
      where("date", "==", dateISO)
    );
    const snap = await getDocs(q);
    const docs = [];
    snap.forEach(d => {
      const data = d.data();
      data._id = d.id;
      docs.push(data);
    });
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
    const q = query(
      collection(db, "wishlists"),
      where("date", "==", dateISO),
      where("court", "==", normalizedKey(courtId))
    );
    const snap = await getDocs(q);
    const docs = [];
    snap.forEach(d => {
      const data = d.data();
      data._id = d.id;
      docs.push(data);
    });
    return docs;
  } catch (err) {
    console.error("fetchWishlistsFor err", err);
    toast("Firestore error (wishlists): " + (err?.message || err), { error: true, duration: 8000 });
    return [];
  }
}

/* ---------- Slot rendering (enforces mutual-exclusion rules) ---------- */
async function renderSlots() {
  if (!slotList) return;
  slotList.innerHTML = "";
  selectedDate = dateInput?.value;
  if (!selectedCourt) {
    slotList.innerHTML = `<div class="text-sm text-gray-500">Select a pitch to view slots.</div>`;
    return;
  }

  let bookingsAll = [], wishlists = [];
  try {
    // fetch all bookings for the date (across courts) to compute occupancy
    [bookingsAll, wishlists] = await Promise.all([
      fetchBookingsForDate(selectedDate),
      fetchWishlistsFor(selectedDate, selectedCourt)
    ]);
  } catch (e) {
    console.error("Error fetching bookings/wishlists:", e);
    toast("Error fetching bookings/wishlists — check console", { error: true, duration: 8000 });
  }

  // occupancy map built from all bookings for the date
  const occupancy = computeSlotOccupancy(bookingsAll);

  const wishlistMap = wishlists.reduce((acc, w) => {
    if (!w || !w.slotId) return acc;
    if (!acc[w.slotId]) acc[w.slotId] = [];
    acc[w.slotId].push(w);
    return acc;
  }, {});

  ALL_SLOTS.forEach(s => {
    const item = document.createElement("div");
    item.className = "flex items-center justify-between p-2 border rounded-xl";
    const left = document.createElement("div");
    left.innerHTML = `<div class="font-medium">${s.label}</div><div class="text-xs text-gray-500">Buffer ${BUFFER_MIN} mins</div>`;
    const right = document.createElement("div");

    // Decide availability for this selectedCourt using the occupancy map
    const avail = isSlotAvailableFor(occupancy, s.id, selectedCourt);

    if (!avail.allowed) {
      // Slot blocked for the currently selected court type -> show Booked + Wishlist
      right.innerHTML = `<div class="text-sm text-red-600">Booked</div>`;

      const count = (wishlistMap[s.id] || []).length;
      if (count > 0) {
        const badge = document.createElement("span");
        badge.className = "ml-2 px-2 py-1 rounded-full text-xs border bg-white";
        badge.textContent = `Wishlist · ${count}`;
        right.appendChild(badge);
      }

      const wishBtn = document.createElement("button");
      wishBtn.className = "ml-3 px-2 py-1 text-sm rounded-full border hover:bg-gray-50";
      wishBtn.textContent = "Wishlist";
      wishBtn.title = "Add yourself to wishlist for this slot";
      wishBtn.addEventListener("click", () => {
        // find a representative booking for admin reference if available
        const occBooking = (occupancy[s.id] && occupancy[s.id].bookings && occupancy[s.id].bookings[0]) || null;
        preferredBookingId = occBooking?._id ?? null;
        openWishlistModal(s, preferredBookingId);
      });
      right.appendChild(wishBtn);

    } else {
      // available to book
      const btn = document.createElement("button");
      btn.className = "px-3 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700";
      btn.textContent = "Book";
      btn.addEventListener("click", () => openBookingModal(s));
      right.appendChild(btn);

      const count = (wishlistMap[s.id] || []).length;
      if (count > 0) {
        const badge = document.createElement("span");
        badge.className = "ml-2 px-2 py-1 rounded-full text-xs border bg-white";
        badge.textContent = `Wishlist · ${count}`;
        right.appendChild(badge);
      }
    }

    item.appendChild(left);
    item.appendChild(right);
    slotList.appendChild(item);
  });
}

/* ---------- Modal flow (improved wishlist modal UX + validation) ---------- */

function showFieldError(fieldEl, message) {
  if (!fieldEl) return;
  console.log("field error", fieldEl, message);
}

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

  if (name.length < 2) {
    showFieldError(mName, "Please enter your full name (min 2 characters).");
    return { ok: false, reason: "name" };
  }
  if (!/^\+?\d{8,15}$/.test(phone)) {
    showFieldError(mPhone, "Enter a valid phone with country code, e.g. +91...");
    return { ok: false, reason: "phone" };
  }
  return { ok: true, name, phone };
}

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

function openModal() { modal?.classList.remove("hidden"); }
function closeModalFn() { modal?.classList.add("hidden"); resetModalFields(); }
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

/* ---------- Confirm handler (booking + wishlist) with rule-based pre-check ---------- */
mConfirm?.addEventListener("click", async () => {
  const nameRaw = mName?.value?.trim();
  const phoneRaw = mPhone?.value?.trim();
  const coupon = mCoupon?.value?.trim();
  const notes = mNotes?.value?.trim();

  const v = validateModalFields();
  if (!v.ok) {
    if (v.reason === "name") toast("Please enter your name.", { error: true });
    if (v.reason === "phone") toast("Enter a valid phone with country code (e.g. +91...).", { error: true });
    return;
  }
  const name = v.name;
  const phone = v.phone;

  if (!selectedCourt || !selectedSlot || !selectedDate) { return alert("Select a pitch and date first."); }

  // normalized court used for writes and checks
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
      // STRONGER PRE-CHECK: fetch all bookings for this date+slot (across courts) and enforce rules
      try {
        const conflictQ = query(
          collection(db, "bookings"),
          where("date", "==", selectedDate),
          where("slotId", "==", selectedSlot.id)
        );
        const conflictSnap = await getDocs(conflictQ);
        const existing = [];
        conflictSnap.forEach(d => {
          const data = d.data();
          data._id = d.id;
          existing.push(data);
        });

        // compute occupancy from existing bookings for this single slot
        const occMap = computeSlotOccupancy(existing);
        const availabilityCheck = isSlotAvailableFor(occMap, selectedSlot.id, normCourt);
        if (!availabilityCheck.allowed) {
          alert("Sorry — that slot is not available for the selected court: " + (availabilityCheck.reason || "Unavailable"));
          closeModalFn();
          renderSlots();
          return;
        }
      } catch (qerr) {
        console.error("Conflict-check failed", qerr);
        const qmsg = qerr?.message || String(qerr);
        if (qmsg.includes("requires an index")) {
          toast("Firestore requires an index for booking-check. Click console link to create it.", { error: true, duration: 8000 });
        } else {
          toast("Could not verify slot availability — try again.", { error: true, duration: 8000 });
        }
        return;
      }

      // No conflict — proceed to write booking
      setConfirmLoading(true);
      console.group("Booking write start (Firestore)");
      console.log("Booking object:", booking);
      const ref = await addDoc(collection(db, "bookings"), booking);
      console.log("BOOKING WRITE SUCCESS:", ref.id);
      console.groupEnd();

      if (cid) cid.textContent = ref.id;
      if (cwhen) cwhen.textContent = `${selectedDate} · ${selectedSlot.label}`;
      if (ccourt) ccourt.textContent = (normCourt === "5A" ? "Half Ground A" : normCourt === "5B" ? "Half Ground B" : normCourt === "7A" ? "Full Ground Football" : "Cricket (Full)");
      if (camount) camount.textContent = `₹${selectedAmount}`;
      const waMsg = encodeURIComponent(`Hi GODs Turf — I booked slot ${selectedSlot.label} on ${selectedDate} (Booking ID: ${ref.id}). Name: ${name}, Phone: ${phone}.`);
      if (confirmWA) confirmWA.href = `https://wa.me/919876543210?text=${waMsg}`;

      show(confirmCard);
      closeModalFn();
      toast("Booking successful — check confirmation card.", { duration: 5000 });

      renderSlots();

    } catch (err) {
      console.group("Booking write FAILED");
      console.error(err);
      const emsg = err?.message || String(err);
      toast("Booking failed: " + emsg, { error: true, duration: 8000 });
      alert("Booking failed — check console. Error: " + emsg);
      console.groupEnd();
    } finally {
      setConfirmLoading(false);
    }
    return;
  }

  // wishlist mode: validate + duplicate-check on Firestore then save
  if (modalMode === "wishlist") {
    setConfirmLoading(true);
    try {
      // Check duplicates: same phone, date, court, slotId
      const dupQ = query(
        collection(db, "wishlists"),
        where("date", "==", selectedDate),
        where("court", "==", normalizedKey(selectedCourt)),
        where("slotId", "==", selectedSlot.id),
        where("phone", "==", phone) // use normalized phone from validation
      );
      const dupSnap = await getDocs(dupQ);
      const dupRows = [];
      dupSnap.forEach(d => {
        const dt = d.data();
        dt._id = d.id;
        dupRows.push(dt);
      });
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
      const emsg = err?.message || String(err);
      toast("Wishlist save failed: " + emsg, { error: true, duration: 8000 });
      alert("Wishlist save failed — check console. Error: " + emsg);
    } finally {
      setConfirmLoading(false);
    }
    return;
  }
});

/* ---------- hide confirm card when date changes ---------- */
dateInput?.addEventListener("change", ()=> hide(confirmCard));

/* ---------- Pitch selector integration (vanilla) ---------- */
/*
 - Renders an interactive SVG pitch into #pitchSelectorContainer
 - Maps:
    half-left -> 5A
    half-right -> 5B
    full -> 7A
    full-cricket -> CRK
 - Pitch is now the single source of truth (we removed the old courtPicker).
 - Full ground clickable area now covers the entire pitch (x=40 width=1120 height=720).
*/
function initPitchSelector() {
  const container = document.getElementById("pitchSelectorContainer");
  if (!container) return;

  // uploaded file path (will be transformed to a public URL by your build)
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
          <!-- SVG pitch (clickable regions) -->
          <svg id="pitchSvg" viewBox="0 0 1200 800" class="rounded-lg" style="max-width:720px;width:100%;height:auto;">
            <defs>
              <linearGradient id="__grass" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stop-color="#2f7a2f"/>
                <stop offset="100%" stop-color="#2aa02a"/>
              </linearGradient>
            </defs>

            <rect x="40" y="40" rx="36" ry="36" width="1120" height="720" fill="url(#__grass)" stroke="#0d6b3c" stroke-width="3"/>

            <!-- center -->
            <line x1="600" y1="40" x2="600" y2="760" stroke="#fff" stroke-width="3"/>
            <circle cx="600" cy="400" r="90" fill="none" stroke="#fff" stroke-width="3"/>

            <!-- penalty boxes & goals -->
            <rect x="40" y="200" width="180" height="400" fill="none" stroke="#fff" stroke-width="3" rx="12"/>
            <rect x="980" y="200" width="180" height="400" fill="none" stroke="#fff" stroke-width="3" rx="12"/>
            <rect x="10" y="330" width="30" height="140" fill="#ffffff22" stroke="#fff" stroke-width="2"/>
            <rect x="1160" y="330" width="30" height="140" fill="#ffffff22" stroke="#fff" stroke-width="2"/>

            <!-- interactive regions -->
            <!-- FULL area now covers entire pitch; halves are defined after and sit on top -->
            <rect id="area-full" x="40" y="40" width="1120" height="720" rx="28" fill="transparent" stroke="transparent" cursor="pointer" />
            <ellipse id="area-cricket" cx="600" cy="400" rx="540" ry="330" fill="transparent" stroke="transparent" stroke-width="6" cursor="pointer" />
            <rect id="area-left" x="40" y="40" width="560" height="720" rx="20" fill="transparent" stroke="transparent" cursor="pointer" />
            <rect id="area-right" x="600" y="40" width="560" height="720" rx="20" fill="transparent" stroke="transparent" cursor="pointer" />

            <text x="320" y="60" text-anchor="middle" font-size="22" fill="#fff" opacity="0.9">Left Half</text>
            <text x="880" y="60" text-anchor="middle" font-size="22" fill="#fff" opacity="0.9">Right Half</text>

            <!-- selection highlight -->
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

  // mapping pitch -> courtId
  const pitchToCourt = {
    "half-left": "5A",
    "half-right": "5B",
    "full": "7A",
    "full-cricket": "CRK"
  };

  const highlight = container.querySelector("#selectionHighlight");

  function clearHighlights() {
    while (highlight.firstChild) highlight.removeChild(highlight.firstChild);
    $$(".pitch-btn", container).forEach(b => b.classList.remove("bg-green-600","text-white","bg-yellow-600"));
  }

  function showHighlight(type) {
    clearHighlights();

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

  function setSelectedByPitch(pitchKey) {
    if (!pitchToCourt[pitchKey]) return;
    // visual
    showHighlight(pitchKey);
    // update selectedCourt (single source of truth)
    selectedCourt = normalizedKey(pitchToCourt[pitchKey]);
    selectedAmount = PRICE_BY_COURT[selectedCourt] || 0;
    // re-render slots
    try { renderSlots(); } catch (e) { console.warn("renderSlots not available yet", e); }
  }

  // wire areas (note order: full defined before halves so halves are on top in DOM)
  const areaFull = container.querySelector("#area-full");
  const areaCricket = container.querySelector("#area-cricket");
  const areaLeft = container.querySelector("#area-left");
  const areaRight = container.querySelector("#area-right");

  areaFull?.addEventListener("click", ()=> setSelectedByPitch("full"));
  areaCricket?.addEventListener("click", ()=> setSelectedByPitch("full-cricket"));
  areaLeft?.addEventListener("click", ()=> setSelectedByPitch("half-left"));
  areaRight?.addEventListener("click", ()=> setSelectedByPitch("half-right"));

  // wire quick buttons
  $$(".pitch-btn", container).forEach(b => {
    b.addEventListener("click", (ev) => {
      const p = ev.currentTarget.getAttribute("data-pitch");
      setSelectedByPitch(p);
    });
  });

  // default selection if not already set
  if (!selectedCourt) {
    setSelectedByPitch("half-left"); // default to Half A
  } else {
    // reflect existing selection visually
    const rev = Object.entries(pitchToCourt).reduce((acc,[k,v]) => (acc[v]=k, acc), {});
    const mappedPitch = rev[normalizedKey(selectedCourt)];
    if (mappedPitch) showHighlight(mappedPitch);
  }
}

/* ---------- initial setup ---------- */
window.addEventListener("load", () => {
  // initialize pitch selector (safe to call even if container not present)
  try { initPitchSelector(); } catch (e) { console.warn("initPitchSelector failed", e); }

  renderSlots();
});
