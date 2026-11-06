/**
 * firebaseAdmin.js — the familiar namespaced Admin API (admin.firestore(),
 * admin.firestore.FieldValue, admin.auth(), admin.credential.cert, admin.apps)
 * on top of firebase-admin v14's modular entry points, which removed the
 * namespaced API. Require this instead of 'firebase-admin'.
 */
'use strict';

// firebase-admin 14.x hands our cert to Firestore as the `credentials` option,
// which google-auth-library 11 flags with a harmless console.warn on every boot.
// Nothing to change on our side (we use credential.cert as documented), so drop
// exactly that line until firebase-admin stops passing `credentials`. Every
// other warning still prints.
const AUTH_DEPRECATION = 'The `credentials` option is deprecated. Please use the `auth` object constructor';
const warn = console.warn.bind(console);
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith(AUTH_DEPRECATION)) return;
  warn(...args);
};

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp, FieldPath } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const firestore = Object.assign(() => getFirestore(), { FieldValue, Timestamp, FieldPath });

module.exports = {
  initializeApp,
  credential: { cert },
  get apps() { return getApps(); },
  firestore,
  auth: () => getAuth(),
};
