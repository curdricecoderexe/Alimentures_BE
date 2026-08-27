/**
 * Boots the Express app for supertest. Uses a real (throwaway) RSA key so
 * firebase-admin's credential.cert() accepts it. Without the Firestore emulator,
 * any handler that touches the DB 500s — fine for tests that only assert on the
 * pre-DB behaviour (auth, CORS, signature checks, rate limits, 404s).
 */
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let app;

export function getApp() {
  if (app) return app;

  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT_JSON.includes('MIIBVAIBAD')) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
      type: 'service_account',
      project_id: process.env.GCLOUD_PROJECT || 'alimentures-test',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      client_email: 'test@alimentures-test.iam.gserviceaccount.com',
    });
  }
  process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
  process.env.NODE_ENV = 'production';

  app = require('../../index.js');
  return app;
}
