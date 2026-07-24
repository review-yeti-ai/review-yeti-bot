"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeGitHubSignature = computeGitHubSignature;
exports.verifyGitHubSignatureDetailed = verifyGitHubSignatureDetailed;
exports.verifyGitHubSignature = verifyGitHubSignature;
const crypto_1 = __importDefault(require("crypto"));
/**
 * Computes expected GitHub HMAC SHA-256 signature for a payload.
 *
 * @param rawBody - The raw payload as a Buffer, UTF-8 string, or JSON object fallback
 * @param secret - The webhook secret string
 * @returns Signature string formatted as "sha256=<hex_digest>"
 */
function computeGitHubSignature(rawBody, secret) {
    if (!secret || secret.trim() === '') {
        throw new Error('Webhook secret is required to compute signature');
    }
    let bodyBuffer;
    if (Buffer.isBuffer(rawBody)) {
        bodyBuffer = rawBody;
    }
    else if (typeof rawBody === 'string') {
        bodyBuffer = Buffer.from(rawBody, 'utf-8');
    }
    else if (typeof rawBody === 'object' && rawBody !== null) {
        bodyBuffer = Buffer.from(JSON.stringify(rawBody), 'utf-8');
    }
    else {
        bodyBuffer = Buffer.from('', 'utf-8');
    }
    const hmac = crypto_1.default.createHmac('sha256', secret);
    const digest = hmac.update(bodyBuffer).digest('hex');
    return `sha256=${digest}`;
}
/**
 * Detailed verification of GitHub webhook signature returning reason and error message.
 *
 * @param options - Verification parameters (signatureHeader, rawBody, secret)
 * @returns Detailed SignatureVerificationResult object
 */
function verifyGitHubSignatureDetailed(options) {
    const { signatureHeader, rawBody, secret } = options;
    if (!secret || secret.trim() === '') {
        return {
            isValid: false,
            reason: 'missing_secret',
            error: 'Webhook secret is not configured',
        };
    }
    let sigHeaderStr;
    if (Array.isArray(signatureHeader)) {
        sigHeaderStr = signatureHeader[0];
    }
    else if (typeof signatureHeader === 'string') {
        sigHeaderStr = signatureHeader;
    }
    if (!sigHeaderStr || sigHeaderStr.trim() === '') {
        return {
            isValid: false,
            reason: 'missing_header',
            error: 'X-Hub-Signature-256 header is missing or empty',
        };
    }
    if (!sigHeaderStr.startsWith('sha256=')) {
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
            return {
                isValid: false,
                reason: 'mismatch',
                error: 'Signature length mismatch',
            };
        }
        const isValid = crypto_1.default.timingSafeEqual(sigBuf, calcBuf);
        return isValid
            ? { isValid: true, reason: 'valid' }
            : { isValid: false, reason: 'mismatch', error: 'Signature hash does not match' };
    }
    catch (err) {
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
function verifyGitHubSignature(signatureHeader, rawBody, secret) {
    return verifyGitHubSignatureDetailed({ signatureHeader, rawBody, secret }).isValid;
}
//# sourceMappingURL=signature.js.map