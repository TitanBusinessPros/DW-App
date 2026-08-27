// Firebase SDK initialization — shared by every page.
//
// firebaseConfig below is not a secret (same as the source project this
// pattern is adapted from) — it's a public client identifier. The actual
// security boundary is firestore.rules / storage.rules, not this file.
//
// On localhost/127.0.0.1 (local dev + CI's Playwright run against the
// hosting emulator) every service is pointed at the local emulators
// instead of the real dw-app-2beee project, so nothing here ever touches
// production data while testing.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth,
  connectAuthEmulator,
  onAuthStateChanged,
  signOut,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithCustomToken,
  sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  collection,
  getDocs,
  query,
  where,
  orderBy,
  addDoc,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  getStorage,
  connectStorageEmulator,
  ref,
  uploadBytes,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
import {
  getMessaging,
  isSupported as isMessagingSupported,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-messaging.js";

const firebaseConfig = {
  apiKey: "AIzaSyCAXlbDG9HupA9njhcH0-_yWNtFFgugQO4",
  authDomain: "dw-app-2beee.firebaseapp.com",
  projectId: "dw-app-2beee",
  storageBucket: "dw-app-2beee.firebasestorage.app",
  messagingSenderId: "653844931615",
  appId: "1:653844931615:web:b5691989aaf8bc81daa12a",
  measurementId: "G-RJX7E0B1RC",
};

// The public VAPID key for Web Push — pair to the private key that lives
// only in Firebase Console (Project Settings > Cloud Messaging). Needed as
// the second argument to getToken() once we build the notifications-opt-in
// flow.
export const VAPID_KEY =
  "BAef4uYGvUisOdcILcadQ_OkB3Fy2_oAFoYwNxyotqWBSHze2DjRMFWZojvM0Of8gEoznaLhXWA21macdK-m6ns";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";

if (isLocal) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectStorageEmulator(storage, "127.0.0.1", 9199);
}

// verifyAdminPin is a plain HTTPS function (not a Firebase callable — see
// functions/index.js for why), so it's called with a normal fetch rather
// than the Functions SDK/emulator connection.
const VERIFY_ADMIN_PIN_URL = isLocal
  ? "http://127.0.0.1:5001/dw-app-2beee/us-central1/verifyAdminPin"
  : "https://us-central1-dw-app-2beee.cloudfunctions.net/verifyAdminPin";

export async function callVerifyAdminPin(pin) {
  if (!auth.currentUser) throw new Error("Sign in first.");
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(VERIFY_ADMIN_PIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ pin }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Incorrect code.");
  return body;
}

// Messaging needs a real HTTPS origin (or localhost) and browser support —
// guarded and exported as a promise rather than initialized eagerly so a
// page that doesn't need push (e.g. this landing page) doesn't pay for it
// or throw in unsupported browsers/older Safari.
export const messagingPromise = isMessagingSupported().then((supported) =>
  supported ? getMessaging(app) : null
);

// Re-exported so pages can `import { ... } from "./firebase-init.js"`
// without a second script tag pulling in the SDK again.
export {
  onAuthStateChanged,
  signOut,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  // Only ever used by tests, to simulate a signed-in user (e.g. an admin)
  // against the Auth emulator without automating a real Google popup.
  signInWithCustomToken,
  sendPasswordResetEmail,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  collection,
  getDocs,
  query,
  where,
  orderBy,
  addDoc,
  ref,
  uploadBytes,
  getDownloadURL,
};
