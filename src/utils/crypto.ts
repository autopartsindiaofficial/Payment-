import crypto from 'node:crypto';

const USER_ID_PATTERN = /^[a-zA-Z0-9._:@-]{1,128}$/;
const HEX_SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;

export function isNonEmptyString(value: unknown, maxLength = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

export function validateUserId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!USER_ID_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function timingSafeHexCompare(expectedHex: string, providedHex: string): boolean {
  if (!HEX_SHA256_PATTERN.test(expectedHex) || !HEX_SHA256_PATTERN.test(providedHex)) {
    return false;
  }
  const expectedBuf = Buffer.from(expectedHex.toLowerCase(), 'hex');
  const providedBuf = Buffer.from(providedHex.toLowerCase(), 'hex');
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

export function verifyRazorpayPaymentSignature(params: {
  orderId: string;
  paymentId: string;
  signature: string;
  keySecret: string;
}): boolean {
  const payload = `${params.orderId}|${params.paymentId}`;
  const expectedSignature = crypto
    .createHmac('sha256', params.keySecret)
    .update(payload)
    .digest('hex');

  return timingSafeHexCompare(expectedSignature, params.signature.trim());
}

export function verifyRazorpayWebhookSignature(params: {
  rawBody: Buffer;
  signatureHeader: string;
  webhookSecret: string;
}): boolean {
  const expectedSignature = crypto
    .createHmac('sha256', params.webhookSecret)
    .update(params.rawBody)
    .digest('hex');

  return timingSafeHexCompare(expectedSignature, params.signatureHeader.trim());
}
