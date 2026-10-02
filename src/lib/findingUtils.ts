/**
 * Pure TypeScript, zero-dependency, isomorphic SHA-256 and deterministic finding ID utilities.
 *
 * Designed to run synchronously and identically in:
 * - Next.js 14 App Router client components ('use client')
 * - Next.js static HTML export ('output: export')
 * - Express.js backend runtime (Node.js >= 24)
 * - Vitest unit & E2E test runners
 * - Web Workers and Edge runtimes
 *
 * Eliminates 'node:crypto' imports from the Next.js client bundle while producing
 * 100% bit-for-bit identical hashes to Node's crypto.createHash('sha256').
 */

// Canonical FIPS 180-4 SHA-256 round constants K
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * 32-bit right rotation
 */
function rotr(n: number, b: number): number {
  return (n >>> b) | (n << (32 - b));
}

/**
 * Converts a 32-bit unsigned integer to an 8-character zero-padded hexadecimal string.
 */
function toHex8(val: number): string {
  return (val >>> 0).toString(16).padStart(8, '0');
}

/**
 * Synchronous pure-TypeScript implementation of SHA-256 (FIPS 180-4).
 * Produces the lowercase 64-character hex digest of the UTF-8 encoded string.
 *
 * @param input - Input string to hash
 * @returns 64-character lowercase hex string
 */
export function sha256(input: string): string {
  const msgBytes = typeof TextEncoder !== 'undefined'
    ? new TextEncoder().encode(input)
    : Buffer.from(input, 'utf8');

  const len = msgBytes.length;
  // Length in bits represented as big-endian 64-bit integer (high and low 32-bit words)
  const bitLenHi = Math.floor((len * 8) / 0x100000000);
  const bitLenLo = (len * 8) >>> 0;

  // Pad to multiple of 64 bytes (512 bits): len + 1 (0x80) + pad zeros + 8 (length)
  const totalLen = ((len + 9 + 63) >>> 6) << 6;
  const words = new Uint32Array(totalLen >>> 2);

  // Copy bytes into 32-bit big-endian words
  for (let i = 0; i < len; i++) {
    words[i >>> 2] |= msgBytes[i] << (24 - (i & 3) * 8);
  }
  // Append standard 0x80 marker bit
  words[len >>> 2] |= 0x80 << (24 - (len & 3) * 8);

  // Append 64-bit length
  words[(totalLen >>> 2) - 2] = bitLenHi;
  words[(totalLen >>> 2) - 1] = bitLenLo;

  // Initial SHA-256 state (first 32 bits of fractional parts of square roots of first 8 primes)
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  // Process 512-bit (16-word) blocks
  for (let i = 0; i < words.length; i += 16) {
    for (let t = 0; t < 16; t++) {
      w[t] = words[i + t];
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ ((~e) & g);
      const temp1 = (h + s1 + ch + K[t] + w[t]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }

  return (
    toHex8(h0) +
    toHex8(h1) +
    toHex8(h2) +
    toHex8(h3) +
    toHex8(h4) +
    toHex8(h5) +
    toHex8(h6) +
    toHex8(h7)
  );
}

/**
 * Computes a deterministic, collision-resistant finding ID across both client and server.
 * Formula: sha256(repo + ':' + file + ':' + line + ':' + title)
 *
 * Normalization invariants:
 * - repo: trimmed, Unicode NFC normalized, colons and backslashes escaped
 * - file: trimmed, stripped of leading './' or '/', Unicode NFC normalized, colons and backslashes escaped
 * - line: floored integer >= 1 (0, negative, NaN fallback to 1)
 * - title: trimmed and Unicode NFC normalized
 *
 * @param repo - Repository in "owner/name" format (e.g. "calltelemetry/cisco-cdr")
 * @param file - File path relative to repository root (e.g. "src/auth/jwtSigner.ts")
 * @param line - 1-indexed line number
 * @param title - Clean title or description string of the finding
 * @returns 64-character lowercase SHA-256 hexadecimal string
 */
export function computeFindingId(repo: string, file: string, line: number, title: string): string {
  const cleanRepo = (repo || '').trim().toLowerCase().normalize('NFC').replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  const cleanFile = (file || '')
    .trim()
    .replace(/^\.?\//, '')
    .normalize('NFC')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:');
  const cleanLine = Math.max(1, typeof line === 'number' && !isNaN(line) ? Math.floor(line) : 1);
  const cleanTitle = (title || '').trim().normalize('NFC');
  return sha256(`${cleanRepo}:${cleanFile}:${cleanLine}:${cleanTitle}`);
}

