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

**Revised 2026-08-26** — split into a static list (no database involved) plus a small
live counter collection, instead of pre-seeding one Firestore document per town.

- **`public/data/ok-towns.json`** — the actual Oklahoma-only allowlist. All 594
  incorporated Oklahoma cities/towns with population > 0 (sourced from Wikipedia's
  Census-backed municipality table), `{ id, name, county, population }`. Ships as a
  static asset with every `firebase deploy --only hosting` — no seeding, no admin
  credentials, no database round trip to populate the signup dropdown. This is what
  makes "Oklahoma only" true by construction: a walker or owner can only pick a town
  from this file.
- **`towns/{townId}`** — a *live counter*, not a reference list. It only exists for a
  town once someone has actually signed up from it. `public/signup.html` self-registers
  it on demand (see below), seeded from the matching entry in `ok-towns.json`:
  ```
  towns/{townId}
    name: "Pauls Valley"
    county: "Garvin"
    population: 6112
    walkerCap: 61                 // hard ceiling on APPROVED walkers in this town
    approvedWalkerCount: 0        // maintained by a Cloud Function trigger, never client-written
    status: "open" | "cap_reached"
  ```
- **Default cap formula:** `max(10, round(population * 0.01))` — 1% of town population,
  minimum 10 so a tiny town can still support a couple of walkers. Computed client-side
  at registration time (and re-derivable any time from `ok-towns.json`), not hand-set
  per town.
- **Self-registration, not admin seeding:** `firestore.rules` lets any signed-in user
  *create* a `towns/{townId}` doc, but only with a fresh, correctly-shaped counter
  (`approvedWalkerCount == 0`, `status == "open"`, right field types) — never edit an
  existing one. Once a town's counter doc exists, only an admin/Cloud Function can
  change it, so `approvedWalkerCount` can't be tampered with client-side even though
  creation is open. This replaces the earlier plan of bulk-seeding ~590 docs via a
  service-account script, which was unnecessary maintenance/deployment friction for
  data that's 99% static — see decision log.
- Every `users/{uid}` (owner) and `walkerProfiles/{uid}` (walker) still gets a required
  `townId` field, validated by `firestore.rules` against `exists(towns/{townId})` — true
  by the time of that write because the client creates/confirms the town doc first.
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
| `admins/{email}` | Admin allowlist, keyed by email (see Admin portal below). |
| `adminPinAttempts/{uid}` | PIN lockout counter, Cloud-Function-only. |

## Admin portal & approval flow

**Added 2026-08-26, went through two corrections same day** — the only way
any `users/{uid}` doc moves out of `approved: false`. First built as a
standalone `admin.html` (wrong — a separate route), then folded into a
hidden section on `index.html` behind a public footer link (also wrong — a
public page still shouldn't carry a discoverable admin affordance in its
DOM/markup at all, even an inert one). It now lives entirely inside
`public/dashboard.html`'s module script, and there is NO trace of it — no
link, no element, nothing — anywhere in the page source for a logged-out
visitor or a non-admin user. The whole section is built with
`document.createElement`/`innerHTML` and appended to the page at runtime,
and that code path only ever runs once `onAuthStateChanged` reports a real
signed-in user (via the normal `login.html` flow) whose email passes the
allowlist check below — nothing is hidden with CSS, it simply never gets
created for anyone else. Two layers, both required:

1. **Email allowlist** — `admins/{email}` docs, added by hand in the Firebase
   console (Firestore write is `if false` for everyone, including admins
   themselves — console/Admin SDK only). This is the real authorization
   boundary and is what `isAdmin()` in `firestore.rules` checks — keyed by
   email (not uid) so an address can be pre-authorized before it's ever
   signed in. (Which emails are on it isn't recorded here — this repo is
   public — see the Firestore console for the live list.)
2. **PIN second factor** — after Google sign-in, an allowlisted email still
   has to enter a PIN, verified server-side by the callable Cloud Function
   `verifyAdminPin` (never compared client-side, so it's never sitting in
   page source). 5 wrong attempts locks that uid out for 15 minutes
   (`adminPinAttempts/{uid}`, Cloud-Function-only). Passing it just sets a
   `sessionStorage` flag for that tab — the actual data access is still
   governed by `isAdmin()` regardless of the PIN, which is a UX gate on top,
   not a second security boundary.
3. Once in, an admin sees every `users/{uid}` with `approved == false` and can
   Approve (`approved: true, everApproved: true`) or Reject (`rejected: true`)
   with one click — plain client-side Firestore writes, allowed by the
   `isAdmin()` branch of `firestore.rules`.

**Setting the real PIN:** `firebase functions:secrets:set ADMIN_PIN --project
dw-app-2beee` — run that yourself (never paste the value in chat); it prompts
for the value interactively. Local/CI testing uses a fixed, non-secret
placeholder (`functions/.secret.local`, gitignored) — never the real one.

**Bug fixed in this same pass:** the pre-existing self-service update branches
on `users/{uid}` and `walkerProfiles/{uid}` let an owner set
`approved`/`everApproved`/`rejected` to *any* internally-consistent
combination themselves — i.e. any user could already self-approve. Neither
field is in the self-service `hasOnly()` list anymore; only the `isAdmin()`
branch can move them now. Caught by a rules test while building this feature,
not a live incident.

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
6. ~~Town data seeding~~ — **Resolved 2026-08-26:** dropped the service-account-key
   bulk-seeder in favor of a static `ok-towns.json` + on-demand `towns/{townId}`
   self-registration. No more manual database seeding, ever, for towns.

## What was deliberately left out of this port

The source project's game rooms, leaderboards, daily-rewards sponsor system, and
town/edition multi-tenant build script aren't relevant here and weren't carried over.
Its **security rule patterns** (field-scoped `hasOnly()` update branches, approval-gated
reads, image moderation via Cloud Vision SafeSearch, rate-limit collections) were the
actual reuse target and are reflected in `firestore.rules`.
