# Wooflahoma Walks

A dog walking marketplace for Oklahoma — dog owners browse and message
local, independent walkers, then book and pay for a walk. Built on Firebase.

(Repo name `DW-App` / Firebase project `dw-app-2beee` predate the product name and are
left as-is — renaming either is an infra change, not just a label swap.)

## Status

🚧 In development, live at https://dw-app-2beee.web.app. Working so far: Firebase
backend fully provisioned, a public landing page, a working sign-up/login flow
(email+password and Google) with Firestore profiles gated by an Oklahoma-town
allowlist, and an admin approval flow (email-allowlist + PIN-gated, no public
link — the panel is created in the DOM only for a signed-in allowlisted admin
on `/dashboard.html`) to approve/reject pending sign-ups. Browsing walkers,
messaging, and bookings/payments aren't built yet.

See `docs/ARCHITECTURE.md` for the full data model and every product/architecture
decision made so far (payment model, town caps, etc).

## Stack

- **Backend:** Firebase — Auth, Firestore, Storage, Cloud Functions, Cloud Messaging, Stripe Connect (planned)
- **Frontend:** Plain HTML/CSS/JS, no build step, no framework — served from `/public`
- **CI/CD:** GitHub Actions — Firestore rules tests + Playwright e2e tests against local
  emulators on every PR; `main` is branch-protected (PR + passing CI required, auto-merges once green)

## Core features

- [x] Firebase project provisioned (Auth, Firestore, Storage, Messaging, Blaze)
- [x] Landing page
- [x] Sign-up / login (email+password + Google), town-gated to Oklahoma
- [x] Admin approval flow (email allowlist + PIN-gated portal)
- [ ] Browse/search walkers
- [ ] In-app messaging
- [ ] Booking flow + Stripe Connect payments
- [ ] Reviews/ratings
- [ ] Push notifications

## Repo layout

```
/docs         — architecture & decision log
/public       — the actual app (static HTML/CSS/JS, Firebase Hosting root)
/functions    — Firebase Cloud Functions
/testing      — Playwright e2e tests + Firestore rules unit tests
/.github/workflows — CI pipeline
```

## Local dev

```
firebase emulators:start --project dw-app-2beee
```
Serves the app at http://127.0.0.1:5000 against local emulators (never production).

To run the test suite the same way CI does:
```
cd testing && npm install && npx playwright install --with-deps chromium
cd ..
firebase emulators:exec --project dw-app-2beee --only firestore,hosting,auth,storage "npm --prefix testing test"
firebase emulators:exec --project dog-walker-rules-test --only firestore "npm run test:rules --prefix testing"
```
