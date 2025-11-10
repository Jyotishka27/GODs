// scripts/app.js (updated ready-to-drop)
// Prevent duplicate bookings by pre-checking Firestore for same date+court+slotId
// Keeps wishlist support and improved error toasts/logging

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
    // keep hyphen consistent in id/label
    slots.push({ id: `${start}-${end}`, label: `${start}-${end}`, startHour: h });
  }
  return slots;
}
const ALL_SLOTS = generateSlots();

/* ---------- Prices ---------- */
const PRICE_BY_COURT = { "5A": 600, "7A": 900, "CRK": 1500 };

/* ---------- DOM refs ---------- */
const dateInput = $("#date");
const courtPicker = $("#courtPicker");
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
let selectedCourt = null;
let selectedSlot = null;
let selectedDate = null;
let selectedAmount = 0;

let modalMode = "booking";
let preferredBookingId = null;

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
    const q = query(
      collection(db, "bookings"),
      where("date", "==", dateISO),
      where("court", "==", courtId)
      // no orderBy to avoid composite index requirement here
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

async function fetchWishlistsFor(dateISO, courtId) {
  if (!dateISO || !courtId) return [];
  try {
    const q = query(
      collection(db, "wishlists"),
      where("date", "==", dateISO),
      where("court", "==", courtId)
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

/* ---------- Slot rendering (debug-enabled) ---------- */
async function renderSlots() {
  if (!slotList) return;
  slotList.innerHTML = "";
  selectedDate = dateInput?.value;
  if (!selectedCourt) {
    slotList.innerHTML = `<div class="text-sm text-gray-500">Select a court to view slots.</div>`;
    return;
  }

  let bookings = [], wishlists = [];
  try {
    [bookings, wishlists] = await Promise.all([
      fetchBookingsFor(selectedDate, selectedCourt),
      fetchWishlistsFor(selectedDate, selectedCourt)
    ]);
  } catch (e) {
    console.error("Error fetching bookings/wishlists:", e);
    toast("Error fetching bookings/wishlists — check console", { error: true, duration: 8000 });
  }

  console.log("renderSlots - selectedDate:", selectedDate, "selectedCourt:", selectedCourt);
  console.log("bookings fetched:", bookings);
  console.log("wishlists fetched:", wishlists);

  const occupied = new Set(bookings.filter(b => b && b.status !== "cancelled").map(b => b.slotId));
  console.log("occupied slotIds:", Array.from(occupied));

  const wishlistMap = wishlists.reduce((acc, w) => {
    if (!w || !w.slotId) return acc;
    if (!acc[w.slotId]) acc[w.slotId] = [];
    acc[w.slotId].push(w);
    return acc;
  }, {});
  console.log("wishlistMap:", wishlistMap);

  ALL_SLOTS.forEach(s => {
    const item = document.createElement("div");
    item.className = "flex items-center justify-between p-2 border rounded-xl";
    const left = document.createElement("div");
    left.innerHTML = `<div class="font-medium">${s.label}</div><div class="text-xs text-gray-500">Buffer ${BUFFER_MIN} mins</div>`;
    const right = document.createElement("div");

    if (occupied.has(s.id)) {
      const occ = bookings.find(b => b.slotId === s.id);
      right.innerHTML = `
        <div class="text-sm text-red-600">Booked</div>
        <div class="text-xs text-gray-500">by ${occ?.userName ?? "—"}</div>
      `;

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
        preferredBookingId = occ?._id ?? null;
        openWishlistModal(s, preferredBookingId);
      });
      right.appendChild(wishBtn);

    } else {
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

/* ---------- Modal flow ---------- */
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
}

function openModal() { modal?.classList.remove("hidden"); }
function closeModalFn() { modal?.classList.add("hidden"); resetModalFields(); }
function resetModalFields() {
  if (mName) mName.value = "";
  if (mPhone) mPhone.value = "";
  if (mCoupon) mCoupon.value = "";
  if (mNotes) mNotes.value = "";
  if (mPrice) mPrice.textContent = selectedAmount ? `₹${selectedAmount}` : "-";
}

closeModal?.addEventListener("click", closeModalFn);
mCancel?.addEventListener("click", closeModalFn);

/* ---------- Confirm handler (booking + wishlist) ---------- */
mConfirm?.addEventListener("click", async () => {
  const name = mName?.value?.trim();
  const phone = mPhone?.value?.trim();
  const coupon = mCoupon?.value?.trim();
  const notes = mNotes?.value?.trim();

  if (!name) { return alert("Please enter your name."); }
  if (!phone || !/^\+?\d{8,15}$/.test(phone)) { return alert("Enter phone with country code, e.g. +91..."); }
  if (!selectedCourt || !selectedSlot || !selectedDate) { return alert("Select a court and date first."); }

  if (modalMode === "booking") {
    const booking = {
      userName: name,
      phone,
      coupon: coupon || null,
      notes: notes || null,
      court: selectedCourt,
      slotId: selectedSlot.id,
      slotLabel: selectedSlot.label,
      date: selectedDate,
      amount: selectedAmount,
      status: "pending",
      createdAt: serverTimestamp()
    };

    try {
      // PRE-CHECK: ensure there is no active booking for this exact slot
      try {
        const conflictQ = query(
          collection(db, "bookings"),
          where("date", "==", selectedDate),
          where("court", "==", selectedCourt),
          where("slotId", "==", selectedSlot.id)
        );
        const conflictSnap = await getDocs(conflictQ);
        const existing = [];
        conflictSnap.forEach(d => {
          const data = d.data();
          data._id = d.id;
          existing.push(data);
        });
        // if any existing booking with status != cancelled -> conflict
        const conflict = existing.find(b => b && b.status !== "cancelled");
        if (conflict) {
          const who = conflict.userName ? ` by ${conflict.userName}` : "";
          alert(`Sorry — that slot is already booked${who}. Please choose another slot or add yourself to the wishlist.`);
          return;
        }
      } catch (qerr) {
        // if query fails due to missing index, surface useful info
        console.error("Conflict-check failed", qerr);
        const qmsg = qerr?.message || String(qerr);
        if (qmsg.includes("requires an index")) {
          toast("Firestore requires an index for booking-check. Click console link to create it.", { error: true, duration: 8000 });
        } else {
          toast("Could not verify slot availability — try again.", { error: true, duration: 8000 });
        }
        // continue (we could block, but better to avoid false positives) — here we'll abort to be safe
        return;
      }

      // No conflict — proceed to write
      console.group("Booking write start (Firestore)");
      console.log("Booking object:", booking);
      const ref = await addDoc(collection(db, "bookings"), booking);
      console.log("BOOKING WRITE SUCCESS:", ref.id);
      console.groupEnd();

      if (cid) cid.textContent = ref.id;
      if (cwhen) cwhen.textContent = `${selectedDate} · ${selectedSlot.label}`;
      if (ccourt) ccourt.textContent = (selectedCourt === "5A" ? "Half Ground Football" : selectedCourt === "7A" ? "Full Ground Football" : "Cricket (Full)");
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
    }
    return;
  }

  // wishlist mode
  if (modalMode === "wishlist") {
    const wishlistEntry = {
      userName: name,
      phone,
      notes: notes || null,
      coupon: coupon || null,
      court: selectedCourt,
      slotId: selectedSlot.id,
      slotLabel: selectedSlot.label,
      date: selectedDate,
      preferredBookingId: preferredBookingId || null,
      status: "open",
      createdAt: serverTimestamp()
    };

    try {
      const ref = await addDoc(collection(db, "wishlists"), wishlistEntry);
      toast("Saved to wishlist — admin will be notified.", { duration: 6000 });
      closeModalFn();
      renderSlots();
    } catch (err) {
      console.error("Wishlist save failed", err);
      const emsg = err?.message || String(err);
      toast("Wishlist save failed: " + emsg, { error: true, duration: 8000 });
      alert("Wishlist save failed — check console. Error: " + emsg);
    }
    return;
  }
});

/* ---------- hide confirm card when date/court changes ---------- */
dateInput?.addEventListener("change", ()=> hide(confirmCard));
courtPicker?.addEventListener("click", ()=> hide(confirmCard));

/* ---------- court selection ---------- */
courtPicker?.addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-id]");
  if (!btn) return;
  $$(".selected-court", courtPicker).forEach(b => b.classList.remove("selected-court", "ring-2", "ring-emerald-400"));
  btn.classList.add("selected-court", "ring-2", "ring-emerald-400");
  selectedCourt = btn.getAttribute("data-id");
  hide(confirmCard);
  renderSlots();
});

/* ---------- initial setup ---------- */
window.addEventListener("load", () => {
  if (!selectedCourt) {
    const first = courtPicker?.querySelector("button[data-id]");
    if (first) {
      first.classList.add("selected-court", "ring-2", "ring-emerald-400");
      selectedCourt = first.getAttribute("data-id");
    }
  }
  renderSlots();
});
