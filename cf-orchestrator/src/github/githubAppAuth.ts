/**
 * githubAppAuth.ts
 *
 * Edge-native GitHub App authentication using Web Crypto API (RS256).
 * Supports both PKCS#1 ("BEGIN RSA PRIVATE KEY") and PKCS#8 ("BEGIN PRIVATE KEY") formats.
 * Caches installation access tokens in Cloudflare KV (AUTH_CACHE) with a 50-minute TTL.
 */

export interface GitHubAuthEnv {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_TOKEN?: string;
  AUTH_CACHE?: {
    get: (key: string) => Promise<string | null>;
    put: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>;
    delete?: (key: string) => Promise<void>;
  };
}

function base64UrlEncode(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64ToBinary(base64Str: string): Uint8Array {
  const raw = atob(base64Str);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

/**
 * Wraps PKCS#1 RSAPrivateKey DER into PKCS#8 PrivateKeyInfo DER structure.
 */
function wrapPkcs1ToPkcs8(pkcs1Der: Uint8Array): Uint8Array {
  function encodeLength(len: number): number[] {
    if (len < 128) return [len];
    const bytes: number[] = [];
    let temp = len;
    while (temp > 0) {
      bytes.unshift(temp & 0xff);
      temp >>= 8;
    }
    return [0x80 | bytes.length, ...bytes];
  }

  // Version: INTEGER 0 (02 01 00)
  const version = [0x02, 0x01, 0x00];
  // AlgorithmIdentifier: rsaEncryption (1.2.840.113549.1.1.1) with NULL
  const algoId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  // OCTET STRING containing the PKCS#1 DER bytes: 04 <len> <pkcs1Der>
  const octetStringHeader = [0x04, ...encodeLength(pkcs1Der.length)];
  const inner = [...version, ...algoId, ...octetStringHeader, ...pkcs1Der];
  // Outer SEQUENCE: 30 <len> <inner>
  const outer = [0x30, ...encodeLength(inner.length), ...inner];
  return new Uint8Array(outer);
}

/**
 * Imports an RSA private key PEM (PKCS#1 or PKCS#8) into a Web Crypto CryptoKey.
 */
export async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const isPkcs1 = pem.includes('BEGIN RSA PRIVATE KEY');
  const cleanPem = pem
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, '')
    .replace(/-----END (RSA )?PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  let derBytes = decodeBase64ToBinary(cleanPem);
  if (isPkcs1) {
    derBytes = wrapPkcs1ToPkcs8(derBytes);
  }

  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      derBytes,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['sign']
    );
  } catch (err: any) {
    throw new Error(`Failed to import GitHub App private key: ${err?.message || err}`);
  }
}

/**
 * Signs a GitHub App JWT with RS256 algorithm and 10-minute validity.
 */
export async function signGitHubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: appId,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const cryptoKey = await importRsaPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsignedToken)
  );

  const encodedSignature = base64UrlEncode(new Uint8Array(signature));
  return `${unsignedToken}.${encodedSignature}`;
}

/**
 * Gets or mints a GitHub App installation access token, caching in KV for 50 minutes.
 */
export async function getInstallationToken(
  env: GitHubAuthEnv,
  owner: string,
  repo: string,
  installationId?: number,
  fetchFn: typeof fetch = fetch
): Promise<string | null> {
  if (env.GITHUB_TOKEN) {
    return env.GITHUB_TOKEN;
  }

  const cacheKey = installationId
    ? `gh_token_inst_${installationId}`
    : `gh_token_${owner}_${repo}`;

  if (env.AUTH_CACHE?.get) {
    try {
      const cached = await env.AUTH_CACHE.get(cacheKey);
      if (cached) return cached;
    } catch {
      // Non-fatal cache read failure
    }
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return null;
  }

  try {
    const jwt = await signGitHubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
    let targetInstId = installationId;

    if (!targetInstId) {
      const installRes = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/installation`, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'ReviewYeti-Edge/2.4',
        },
      });

      if (!installRes.ok) {
        return null;
      }

      const installData = (await installRes.json()) as any;
      targetInstId = installData?.id;
      if (!targetInstId) return null;
    }

    const tokenRes = await fetchFn(`https://api.github.com/app/installations/${targetInstId}/access_tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'ReviewYeti-Edge/2.4',
      },
    });

    if (!tokenRes.ok) return null;
    const tokenData = (await tokenRes.json()) as any;
    const token = tokenData?.token;

    if (token && env.AUTH_CACHE?.put) {
      try {
        // Cache for 50 minutes (GitHub tokens are valid for 60 minutes)
        await env.AUTH_CACHE.put(cacheKey, token, { expirationTtl: 3000 });
      } catch {
        // Non-fatal cache write failure
      }
    }

    return token || null;
  } catch {
    return null;
  }
}

/**
 * Evicts a cached installation token from KV.
 */
export async function clearCachedToken(
  env: GitHubAuthEnv,
  owner: string,
  repo: string,
  installationId?: number
): Promise<void> {
  const cacheKey = installationId
    ? `gh_token_inst_${installationId}`
    : `gh_token_${owner}_${repo}`;

  if (env.AUTH_CACHE?.delete) {
    try {
      await env.AUTH_CACHE.delete(cacheKey);
    } catch {
      // Non-fatal
    }
  }
}
