import { createHash } from 'node:crypto';

const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
export const QUALIFICATION_DISPATCH_ORIGIN_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * Hashes only a canonical, service-owned HTTPS origin. The raw private origin
 * remains in runtime configuration and is never returned or serialized.
 */
export function qualificationDispatchOriginSha256FromEnv(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const ipLiteral = ipv4.test(hostname) || hostname.startsWith('[');
    if (url.protocol !== 'https:' || !hostname || ipLiteral || !hostname.includes('.')
      || hostname === 'localhost' || hostname.endsWith('.localhost')
      || url.port !== '' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || value !== url.origin) return undefined;
    const digest = createHash('sha256').update(url.origin).digest('hex');
    return QUALIFICATION_DISPATCH_ORIGIN_SHA256_PATTERN.test(digest) ? digest : undefined;
  } catch {
    return undefined;
  }
}
