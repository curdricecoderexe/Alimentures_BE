import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { generateOtp, hashOtp } from '../utils/otp.js';

describe('OTP primitives', () => {
  it('generates a 6-digit numeric code', () => {
    for (let i = 0; i < 50; i++) {
      const otp = generateOtp();
      expect(otp).toMatch(/^\d{6}$/);
    }
  });

  it('hash is deterministic and not reversible to the code', () => {
    const h1 = hashOtp('123456');
    const h2 = hashOtp('123456');
    expect(h1).toBe(h2);
    expect(h1).not.toContain('123456');
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different codes hash differently', () => {
    expect(hashOtp('000000')).not.toBe(hashOtp('000001'));
  });

  it('hash incorporates the pepper', () => {
    const withPepper = hashOtp('123456');
    const plain = crypto.createHash('sha256').update('123456').digest('hex');
    expect(withPepper).not.toBe(plain);
  });
});
