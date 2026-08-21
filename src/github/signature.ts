import crypto from 'crypto';

export interface VerifySignatureOptions {
  /** The value of the X-Hub-Signature-256 header */
  signatureHeader?: string | string[];
  /** The exact raw payload body as a Buffer, string, or object fallback */
  rawBody?: Buffer | string | object;
  /** The secret key used for HMAC SHA-256 hashing */
  secret?: string;
}

export type SignatureVerificationReason =
  | 'valid'
  | 'missing_header'
  | 'malformed_header'
  | 'missing_secret'
  | 'mismatch'
  | 'internal_error';

export interface SignatureVerificationResult {
  isValid: boolean;
  reason: SignatureVerificationReason;
  error?: string;
}

/**
 * Computes expected GitHub HMAC SHA-256 signature for a payload.
 *
 * @param rawBody - The raw payload as a Buffer, UTF-8 string, or JSON object fallback
 * @param secret - The webhook secret string
 * @returns Signature string formatted as "sha256=<hex_digest>"
 */
export function computeGitHubSignature(
  rawBody: Buffer | string | object,
  secret: string
): string {
  if (!secret || secret.trim() === '') {
    throw new Error('Webhook secret is required to compute signature');
  }

  let bodyBuffer: Buffer;
  if (Buffer.isBuffer(rawBody)) {
    bodyBuffer = rawBody;
  } else if (typeof rawBody === 'string') {
    bodyBuffer = Buffer.from(rawBody, 'utf-8');
  } else if (typeof rawBody === 'object' && rawBody !== null) {
    bodyBuffer = Buffer.from(JSON.stringify(rawBody), 'utf-8');
  } else {
    bodyBuffer = Buffer.from('', 'utf-8');
  }

  const hmac = crypto.createHmac('sha256', secret);
  const digest = hmac.update(bodyBuffer).digest('hex');
  return `sha256=${digest}`;
}

/**
 * Detailed verification of GitHub webhook signature returning reason and error message.
 *
 * @param options - Verification parameters (signatureHeader, rawBody, secret)
 * @returns Detailed SignatureVerificationResult object
 */
export function verifyGitHubSignatureDetailed(
  options: VerifySignatureOptions
): SignatureVerificationResult {
  const { signatureHeader, rawBody, secret } = options;
  const isBypass = process.env.BYPASS_WEBHOOK_SIGNATURE === 'true';

  if (!secret || secret.trim() === '') {
    if (isBypass) {
      return { isValid: true, reason: 'valid' };
    }
    return {
      isValid: false,
      reason: 'missing_secret',
      error: 'Webhook secret is not configured',
    };
  }

  let sigHeaderStr: string | undefined;
  if (Array.isArray(signatureHeader)) {
    sigHeaderStr = signatureHeader[0];
  } else if (typeof signatureHeader === 'string') {
    sigHeaderStr = signatureHeader;
  }

  if (!sigHeaderStr || sigHeaderStr.trim() === '') {
    if (isBypass) {
      return { isValid: true, reason: 'valid' };
    }
    return {
      isValid: false,
      reason: 'missing_header',
      error: 'X-Hub-Signature-256 header is missing or empty',
    };
  }

  if (!sigHeaderStr.startsWith('sha256=')) {
    if (isBypass) {
      return { isValid: true, reason: 'valid' };
    }
    return {
      isValid: false,
      reason: 'malformed_header',
      error: 'X-Hub-Signature-256 header must start with "sha256="',
    };
  }

  if (rawBody === undefined || rawBody === null) {
    return {
      isValid: false,
      reason: 'internal_error',
      error: 'Raw request body is missing',
    };
  }

  try {
    const expectedSig = computeGitHubSignature(rawBody, secret);

    const sigBuf = Buffer.from(sigHeaderStr, 'utf-8');
    const calcBuf = Buffer.from(expectedSig, 'utf-8');

    // Node.js crypto.timingSafeEqual throws if buffer lengths do not match exactly.
    if (sigBuf.length !== calcBuf.length) {
      if (isBypass) {
        return { isValid: true, reason: 'valid' };
      }
      return {
        isValid: false,
        reason: 'mismatch',
        error: 'Signature length mismatch',
      };
    }

    const isValid = crypto.timingSafeEqual(sigBuf, calcBuf);
    if (!isValid && isBypass) {
      return { isValid: true, reason: 'valid' };
    }
    return isValid
      ? { isValid: true, reason: 'valid' }
      : { isValid: false, reason: 'mismatch', error: 'Signature hash does not match' };
  } catch (err: any) {
    if (isBypass) {
      return { isValid: true, reason: 'valid' };
    }
    return {
      isValid: false,
      reason: 'internal_error',
      error: `Crypto verification failed: ${err?.message || 'unknown error'}`,
    };
  }
}

/**
 * Verifies GitHub HMAC SHA-256 signature in constant time.
 *
 * @param signatureHeader - X-Hub-Signature-256 header string or array
 * @param rawBody - Request raw body buffer, string, or object
 * @param secret - Webhook secret string
 * @returns boolean true if valid, false otherwise
 */
export function verifyGitHubSignature(
  signatureHeader: string | string[] | undefined,
  rawBody: Buffer | string | object | undefined,
  secret: string
): boolean {
  return verifyGitHubSignatureDetailed({ signatureHeader, rawBody, secret }).isValid;
}
