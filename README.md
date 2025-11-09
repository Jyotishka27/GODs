

## Phase-2 Upgrades Included
- Promo codes (flat/percent) via `data/site.json -> coupons`
- Recurring weekly bookings (2/4/8 weeks)
- Waitlist for full slots (managed in Admin -> Waitlist)
- Payments stub for Razorpay (toggle `payments.enabled` and set `razorpay_key`)
- Analytics page with charts (`analytics.html`)
- PWA: installable app + offline cache

### Enable Payments
1. Set `"enabled": true` and your `"razorpay_key"` in `data/site.json`.
2. Ensure the Razorpay script is allowed (already linked in `index.html` head).
3. Payment opens after booking confirmation; wire webhook if you add a backend.
