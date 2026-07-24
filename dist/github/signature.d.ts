export interface VerifySignatureOptions {
    /** The value of the X-Hub-Signature-256 header */
    signatureHeader?: string | string[];
    /** The exact raw payload body as a Buffer, string, or object fallback */
    rawBody?: Buffer | string | object;
    /** The secret key used for HMAC SHA-256 hashing */
    secret?: string;
}
export type SignatureVerificationReason = 'valid' | 'missing_header' | 'malformed_header' | 'missing_secret' | 'mismatch' | 'internal_error';
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
export declare function computeGitHubSignature(rawBody: Buffer | string | object, secret: string): string;
/**
 * Detailed verification of GitHub webhook signature returning reason and error message.
 *
 * @param options - Verification parameters (signatureHeader, rawBody, secret)
 * @returns Detailed SignatureVerificationResult object
 */
export declare function verifyGitHubSignatureDetailed(options: VerifySignatureOptions): SignatureVerificationResult;
/**
 * Verifies GitHub HMAC SHA-256 signature in constant time.
 *
 * @param signatureHeader - X-Hub-Signature-256 header string or array
 * @param rawBody - Request raw body buffer, string, or object
 * @param secret - Webhook secret string
 * @returns boolean true if valid, false otherwise
 */
export declare function verifyGitHubSignature(signatureHeader: string | string[] | undefined, rawBody: Buffer | string | object | undefined, secret: string): boolean;
