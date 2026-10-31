/**
 * firebaseAdmin.js — the familiar namespaced Admin API (admin.firestore(),
 * admin.firestore.FieldValue, admin.auth(), admin.credential.cert, admin.apps)
 * on top of firebase-admin v14's modular entry points, which removed the
 * namespaced API. Require this instead of 'firebase-admin'.
 */
'use strict';

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
