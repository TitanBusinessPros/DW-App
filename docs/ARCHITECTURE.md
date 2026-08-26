# Architecture & data model

Status: **draft v1** — ported/adapted from a sibling Firebase project (patterns only,
no shared secrets/config). Flagged decisions below need your sign-off before we build
on top of them.

## Stack

- **Hosting:** Firebase Hosting, static files served from `/public` — plain HTML/CSS/JS,
  no build step (matches the source project this was adapted from).
- **Backend:** Firebase Auth, Firestore, Storage, Cloud Functions (Node 20), Stripe Connect.
- **Testing:** Playwright (end-to-end, against Firebase emulators) + `@firebase/rules-unit-testing`
  (Firestore rules unit tests). Mirrors the sibling project's `testing/` setup.
- **CI:** GitHub Actions — runs the test suite against emulators on every push/PR to `main`.
  Auto-merges once the `test` check passes (2026-08-26 — see decision log below).

## Service area: Oklahoma-only, town by town

The whole state-restriction and per-town-cap problem is solved with **one mechanism**: a
curated `towns` collection. There is no geocoding/geofencing in v1 — a walker or an owner
can only pick a town from this list, and every town in the list is one we've explicitly
added because it's in Oklahoma. That makes "Oklahoma only" true by construction, not by
checking coordinates.

```
towns/{townId}
  name: "Pauls Valley"
  county: "Garvin"
  population: 5000              // for computing a default cap, not shown to users
  walkerCap: 50                 // hard ceiling on APPROVED walkers in this town
  approvedWalkerCount: 0        // maintained by a Cloud Function trigger, never client-written
  status: "open" | "cap_reached"
  createdAt, capLastRaisedAt
```

- **Default cap formula:** `max(10, round(population * 0.01))` — 1% of town population,
  minimum 10 so a tiny town can still support a couple of walkers. Pauls Valley
  (~5,000) → 50, matching your example. Admin can override per town at add-time.
- Every `users/{uid}` (owner) and `walkerProfiles/{uid}` (walker) gets a required
  `townId` field, validated by `firestore.rules` against `exists(towns/{townId})`.
  Bookings inherit `townId` from the walker being booked — an owner literally cannot
  construct a booking that references a walker/town outside the allowlist.
- **Cap enforcement point:** at admin approval, not at signup. A pending applicant can
  always submit; if `approvedWalkerCount >= walkerCap` at the moment an admin would
  approve them, they're placed on a waitlist (`status: "waitlisted"`) instead of
  approved, and the admin dashboard shows the town is full. `approvedWalkerCount` is
  kept in sync by a Cloud Function Firestore trigger on `walkerProfiles` approval/
  deapproval/delete, inside a transaction (so concurrent approvals can't overshoot the
  cap — this can't be done safely in security rules alone).

**Open question:** raising the cap ("doubles to 100 if demand grows") — who/what decides
"demand grew"? Two ways to build it:
- **Manual (simpler, recommended for v1):** admin dashboard shows per-town stats
  (waitlist length, avg bookings/walker/week) and a "raise cap" button. You make the
  call, I just surface the numbers.
- **Automatic:** a scheduled Cloud Function computes a demand score weekly and
  auto-doubles the cap past some threshold, no human in the loop.

I'd start manual — it's a business judgment call as much as a data one, and it's far
less code. Let me know if you want it automatic from the start.

## Payment: Stripe Connect, per-booking cut (Option B)

Confirmed 2026-08-26. Replaces the earlier flat-listing-fee draft.

- **Account type:** Stripe Connect **Express** accounts for walkers — Stripe hosts the
  identity-verification/bank-account onboarding UI, so we don't build or store any of
  that ourselves.
- **Charge pattern:** destination charges. The owner pays the platform (us); Stripe
  automatically splits it — `application_fee_amount` (our cut) stays with the
  platform, the rest (`transfer_data.destination`) goes to the walker's connected
  account. One charge, no manual payout bookkeeping.
- **Walker onboarding flow:** callable Cloud Function `createConnectAccountLink` →
  creates (or resumes) the walker's Express account and returns a Stripe-hosted
  onboarding URL → walker isn't bookable (`stripeOnboardingComplete: false`) until
  Stripe tells us via webhook they've finished.
- **Booking payment flow:** callable Cloud Function `createBookingPaymentIntent`,
  called when an owner confirms a booking request the walker accepted → creates the
  PaymentIntent with the destination-charge split → client confirms payment with
  Stripe.js.
- **Webhooks needed** (`functions/index.js` → `stripeWebhook`):
  - `account.updated` — flips `walkerProfiles.stripeOnboardingComplete` once Stripe
    reports the Express account can accept charges/payouts
  - `payment_intent.succeeded` — marks the booking paid, triggers the accept
    notification
  - `payment_intent.payment_failed` — surfaces the failure to the owner
  - `charge.refunded` — handles cancellations
- `walkerProfiles/{uid}` gains: `stripeAccountId`, `stripeOnboardingComplete`
  (replaces the old `listingPaidUntil` field entirely — walkers don't pay to be
  listed anymore, they just need a connected Stripe account before they're bookable).
- `bookings/{bookingId}` gains: `stripePaymentIntentId`, `platformFeeAmount`,
  `amountTotal`, `paidStatus`.

**Still needed from you:** the actual Stripe API keys and webhook signing secret —
see the setup steps below. I can't create those myself; they only exist inside your
Stripe dashboard.

## Collections (Firestore) — current

| Collection | Purpose |
|---|---|
| `towns/{townId}` | Curated OK-town allowlist + per-town walker cap (see above). |
| `users/{uid}` | Core identity for everyone — owners and walkers both start here. `role`, `townId`, approval workflow, `agreedToTerms`, `notificationsEnabled`, `fcmTokens`. |
| `walkerProfiles/{uid}` | Walker listing: bio, `townId`, service radius, hourly rate, availability, `stripeAccountId`, `stripeOnboardingComplete`. |
| `dogs/{dogId}` | Owner's dog profiles: name, breed, notes, photo, `ownerId`. |
| `conversations/{ownerUid}_{walkerUid}` / `.../messages/{id}` | 1:1 DMs. |
| `bookings/{bookingId}` | Walk request + payment: `ownerId`, `walkerId`, `townId`, `dogIds[]`, time window, `status`, `stripePaymentIntentId`, `platformFeeAmount`. |
| `reviews/{reviewId}` | Post-booking rating/review, tied to a completed `bookingId`. |
| `blocks/{pairId}`, `reports/{reportId}`, `bugReports/{reportId}` | Safety. |
| `messageLimits/{uid}`, `bookingLimits/{uid}` | Rate limiting. |
| `admins/{uid}` | Admin allowlist. |

## Decision log

1. ~~Payment model~~ — **Resolved 2026-08-26: Option B**, Stripe Connect per-booking
   cut. See above.
2. ~~Firebase project~~ — **Resolved.** `dw-app-2beee`, fully provisioned: Auth
   (Email/Password + Google), Firestore, Storage, Cloud Messaging, Blaze plan, Cloud
   Functions API all confirmed live; `firestore.rules`/`storage.rules` deployed.
3. **"Both" role** — assumed yes, one account can be owner and walker. Unchanged.
4. ~~Auto-merge~~ — **Resolved 2026-08-26:** CI green → merge automatically, no
   per-PR confirmation.
5. **Open:** manual vs. automatic town-cap escalation (see Service Area section).

## What was deliberately left out of this port

The source project's game rooms, leaderboards, daily-rewards sponsor system, and
town/edition multi-tenant build script aren't relevant here and weren't carried over.
Its **security rule patterns** (field-scoped `hasOnly()` update branches, approval-gated
reads, image moderation via Cloud Vision SafeSearch, rate-limit collections) were the
actual reuse target and are reflected in `firestore.rules`.
