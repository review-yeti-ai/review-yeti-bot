/**
 * Native Edge GitHub App Authentication & Proxy using Web Crypto API.
 * Eliminates Node.js `jsonwebtoken` and `crypto` dependencies.
 */

function base64UrlEncode(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToBinary(pem: string): Uint8Array {
  const cleanPem = pem
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, '')
    .replace(/-----END (RSA )?PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  const raw = atob(cleanPem);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

export async function signGitHubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60,
    exp: now + 600, // 10 minutes
    iss: appId,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const binaryKey = pemToBinary(privateKeyPem);
  let cryptoKey: CryptoKey;

  try {
    cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      binaryKey,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['sign']
    );
  } catch (err) {
    throw new Error(`Failed to import GitHub App private key: ${(err as any)?.message || err}`);
  }

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsignedToken)
  );

  const encodedSignature = base64UrlEncode(new Uint8Array(signature));
  return `${unsignedToken}.${encodedSignature}`;
}

export async function getInstallationToken(
  env: { GITHUB_APP_ID?: string; GITHUB_APP_PRIVATE_KEY?: string; AUTH_CACHE?: any; GITHUB_TOKEN?: string },
  owner: string,
  repo: string
): Promise<string | null> {
  if (env.GITHUB_TOKEN) {
    return env.GITHUB_TOKEN;
  }

  const cacheKey = `gh_token_${owner}_${repo}`;
  if (env.AUTH_CACHE?.get) {
    const cached = await env.AUTH_CACHE.get(cacheKey);
    if (cached) return cached;
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return null;
  }

  try {
    const jwt = await signGitHubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

    // 1. Get installation ID for repository
    const installRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
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
    const installationId = installData?.id;
    if (!installationId) return null;

    // 2. Mint installation access token
    const tokenRes = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
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
      // Cache with 50-minute TTL (GitHub tokens live for 60m)
      await env.AUTH_CACHE.put(cacheKey, token, { expirationTtl: 3000 });
    }

    return token || null;
  } catch {
    return null;
  }
}

export async function fetchLivePullRequests(
  env: any,
  owner: string,
  repo: string,
  state: 'open' | 'closed' | 'all' = 'open'
): Promise<any[]> {
  const token = await getInstallationToken(env, owner, repo);
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'ReviewYeti-Edge/2.4',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=${state}&per_page=30`, {
      headers,
    });

    if (!res.ok) {
      return [];
    }

    const pulls = (await res.json()) as any[];
    return pulls.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      headSha: p.head?.sha?.slice(0, 8) || 'head',
      author: {
        login: p.user?.login || 'developer',
        avatarUrl: p.user?.avatar_url || 'https://avatars.githubusercontent.com/u/1000',
      },
      updatedAt: p.updated_at,
      reviewStatus: { status: 'pending', findingsCount: 0 },
    }));
  } catch {
    return [];
  }
}

export async function fetchLivePullRequestDiff(
  env: any,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ success: boolean; jobId?: string; totalFiles: number; files: any[] } | null> {
  const token = await getInstallationToken(env, owner, repo);
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'ReviewYeti-Edge/2.4',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`, {
      headers,
    });

    if (!res.ok) {
      return null;
    }

    const filesData = (await res.json()) as any[];
    const files = filesData.map((f: any) => {
      const hunks: any[] = [];
      if (f.patch) {
        const patchLines = f.patch.split('\n');
        let currentHunk: any = null;
        for (const line of patchLines) {
          if (line.startsWith('@@')) {
            currentHunk = { header: line, lines: [] };
            hunks.push(currentHunk);
          } else if (currentHunk) {
            currentHunk.lines.push(line);
          }
        }
      }

      return {
        path: f.filename,
        oldPath: f.previous_filename || f.filename,
        changeType: f.status === 'added' ? 'added' : f.status === 'removed' ? 'deleted' : 'modified',
        additions: f.additions || 0,
        deletions: f.deletions || 0,
        patch: f.patch,
        hunks: hunks.length > 0 ? hunks : undefined,
      };
    });

    return {
      success: true,
      totalFiles: files.length,
      files,
    };
  } catch {
    return null;
  }
}

