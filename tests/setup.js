/**
 * Vitest setup.
 *
 * Integration suites need the Firestore emulator:
 *   firebase emulators:exec --only firestore "npm test"
 * which sets FIRESTORE_EMULATOR_HOST. When it is absent, integration suites use
 * `describe.skipIf(!hasEmulator)` and only the pure-unit suites run.
 *
 * Pure-unit suites (validate, imageField, otp hashing, constants) never touch
 * Firestore and always run.
 */

import { generateKeyPairSync } from 'node:crypto';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
process.env.PORT = process.env.PORT || '3000';
process.env.RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'test_webhook_secret';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_x';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'test_key_secret';
process.env.FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'test_web_api_key';
process.env.OTP_PEPPER = process.env.OTP_PEPPER || 'test_pepper';
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
process.env.RESERVATION_CLEANUP_SECRET = process.env.RESERVATION_CLEANUP_SECRET || 'test_cron_secret';

export const hasEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;

if (hasEmulator && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  // The emulator ignores credentials, but firebase-admin's credential.cert()
  // still wants a syntactically valid key + a project id. Generate a throwaway
  // RSA key at runtime so no PEM literal is committed.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'alimentures-test';
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    type: 'service_account',
    project_id: 'alimentures-test',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: 'test@alimentures-test.iam.gserviceaccount.com',
  });
}
