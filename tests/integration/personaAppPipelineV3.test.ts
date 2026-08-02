import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReviewPipeline } from '../../src/app';
import { ParsedPRPayload } from '../../src/github/eventHandler';

const POLICY = `
version: 3
profile: assertive
quorum: 2
personas:
  - id: security-tenancy
    enabled: true
    required: true
    charter: builtin:security
    paths: ["src/**"]
    providers: [grok, claude]
  - id: constitutional-goals
    enabled: true
    required: true
    charter: "Protect repository constitutional goals and authority boundaries."
    paths: ["**"]
    providers: [codex, agy-opus]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 900
  providers:
    - { id: codex, enabled: true, model: codex/gpt-5.6-sol-high, effort: high, review_timeout_s: 240, arbiter_timeout_s: 240 }
    - { id: grok, enabled: true, model: grok-cli/grok-4.5, effort: high, review_timeout_s: 240, arbiter_timeout_s: 240 }
    - { id: agy-opus, enabled: true, model: agy/claude-opus-4-6-thinking, effort: high, review_timeout_s: 300, arbiter_timeout_s: 300 }
    - { id: claude, enabled: true, model: claude/claude-opus-4-8, effort: high, review_timeout_s: 300, arbiter_timeout_s: 300 }
  arbiter:
    order: [claude, codex, grok, agy-opus]
`;

const RECURSIVE_SUBMODULE_POLICY = `${POLICY.replace('version: 3', 'version: 4')}
submodules:
  mode: recursive
`;

const SINGLE_PERSONA_POLICY = POLICY
  .replace('quorum: 2', 'quorum: 1')
  .replace('  - id: constitutional-goals\n    enabled: true', '  - id: constitutional-goals\n    enabled: false');

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

function payload(prNumber: number): ParsedPRPayload {
  return {
    installationId: '148780830',
    owner: 'calltelemetry',
    repo: 'ct-meta',
    prNumber,
    headSha: `head-${prNumber}`,
    baseSha: `base-${prNumber}`,
    title: 'proof',
    body: '',
    sender: 'developer',
    labels: [],
    triggerSource: 'pr_event',
    triggerAction: 'opened',
    deliveryId: `delivery-${prNumber}`,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fencedCompletion(request: any): Response {
  const model = String(request.model);
  const prompt = String(request.messages?.[1]?.content || '');
  const requestNonce = /CT_REVIEW_NONCE:([^\n]+)/.exec(prompt)?.[1];
  if (!requestNonce) return json({ error: 'nonce absent' }, 400);
  let value: unknown;
  if (prompt.includes('"role":"persona"')) {
    value = { decision: 'APPROVE', findings: [] };
  } else if (prompt.includes('"role":"moderator"')) {
    value = { decision: 'RECONCILED', findings: [] };
  } else if (prompt.includes('"role":"arbiter"')) {
    value = { verdict: 'SHIP', rationale: 'Every required persona completed and quorum is satisfied.' };
  } else {
    return json({ error: 'unknown role' }, 400);
  }
  return json({
    model,
    choices: [{ message: { content: `CT_REVIEW_BEGIN:${requestNonce}\n${JSON.stringify(value)}\nCT_REVIEW_END:${requestNonce}` } }],
  });
}

function route(options: {
  staleAfterPanel?: boolean;
  staleOnPublication?: boolean;
  recursiveSubmodule?: boolean;
  singlePersona?: boolean;
  omniOutage?: boolean;
} = {}) {
  const requests: Array<{ url: string; method: string; body: any }> = [];
  let pullReads = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });

    if (url.includes('/app/installations/148780830/access_tokens')) {
      return json({
        token: 'ghs_pipeline_test',
        expires_at: '2099-01-01T00:00:00Z',
        permissions: { metadata: 'read', contents: 'read', pull_requests: 'write', issues: 'write', checks: 'write' },
      }, 201);
    }
    if (url.includes('/v1/chat/completions')) {
      return options.omniOutage ? json({ error: 'provider unavailable' }, 503) : fencedCompletion(body);
    }
    if (/\/pulls\/\d+$/.test(url)) {
      pullReads += 1;
      const prNumber = Number(/\/pulls\/(\d+)$/.exec(url)?.[1]);
      const stale = options.staleAfterPanel
        ? pullReads > 1
        : options.staleOnPublication
          ? pullReads > 3
          : false;
      return json({
        head: { sha: stale ? `new-head-${prNumber}` : `head-${prNumber}` },
        base: { sha: `base-${prNumber}` },
        title: 'proof',
        body: '',
      });
    }
    if (url.includes('/contents/.ct-review.yaml?ref=')) {
      const policy = options.recursiveSubmodule
        ? RECURSIVE_SUBMODULE_POLICY
        : options.singlePersona
          ? SINGLE_PERSONA_POLICY
          : POLICY;
      return json({ encoding: 'base64', content: Buffer.from(policy).toString('base64') });
    }
    if (url.includes('/files?per_page=100&page=1')) {
      return options.recursiveSubmodule
        ? json([{
          filename: 'src/vendor/lib',
          status: 'modified',
          mode: '160000',
          previous_sha: 'a'.repeat(40),
          sha: 'b'.repeat(40),
        }])
        : json([{ filename: 'src/proof.ts', patch: '@@ -0,0 +1 @@\n+export const proof = true;' }]);
    }
    if (url.endsWith('/check-runs') && method === 'POST') return json({ id: 991 }, 201);
    if (url.includes('/check-runs/991') && method === 'PATCH') return json({});
    if (url.endsWith('/reviews') && method === 'POST') return json({ id: 700 + requests.length }, 201);
    if (/\/issues\/\d+\/comments$/.test(url) && method === 'POST') return json({ id: 800 }, 201);
    return json({ error: `unexpected ${method} ${url}` }, 404);
  });
  return { fetchMock, requests };
}

describe('GitHub App configurable persona pipeline', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_APP_ID', '4385771');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
    vi.stubEnv('GITHUB_API_BASE_URL', 'https://api.github.test');
    vi.stubEnv('OMNIROUTE_BASE_URL', 'http://omniroute.test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses a ghs token, base-SHA policy, persona COMMENT reviews, and arbiter-only approval', async () => {
    const mock = route();
    vi.stubGlobal('fetch', mock.fetchMock);

    const result = await runReviewPipeline(payload(9101));

    expect(result).toMatchObject({
      status: 'processed',
      personas: [
        { id: 'security-tenancy', provider: 'grok', model: 'x-ai/grok-4.5' },
        { id: 'constitutional-goals', provider: 'codex', model: 'openai/gpt-5.6-sol' },
      ],
      quorum: { required: 2, satisfied: true },
      arbiter: 'SHIP',
      decision: 'APPROVE',
    });
    const policyRequest = mock.requests.find((request) => request.url.includes('/contents/.ct-review.yaml'));
    expect(policyRequest?.url).toContain('ref=base-9101');
    const reviews = mock.requests.filter((request) => request.url.endsWith('/reviews'));
    expect(reviews.map((review) => review.body.event)).toEqual(['COMMENT', 'COMMENT', 'APPROVE']);
    expect(reviews[0].body.body).toContain('Persona: security-tenancy');
    expect(reviews[2].body.body).toContain('Binding arbiter verdict: SHIP');
    const githubRequests = mock.fetchMock.mock.calls.filter(([url]) => String(url).startsWith('https://api.github.test/repos/'));
    expect(githubRequests.every(([, init]) =>
      new Headers(init?.headers).get('authorization') === 'Bearer ghs_pipeline_test',
    )).toBe(true);
  });

  it('cancels stale-head evidence without publishing a review', async () => {
    const mock = route({ staleAfterPanel: true });
    vi.stubGlobal('fetch', mock.fetchMock);

    await expect(runReviewPipeline(payload(9102))).resolves.toMatchObject({
      status: 'cancelled',
      reason: 'head changed during review',
    });
    expect(mock.requests.filter((request) => request.url.endsWith('/reviews'))).toHaveLength(0);
    const completion = mock.requests.find((request) =>
      request.url.includes('/check-runs/991') && request.method === 'PATCH',
    );
    expect(completion?.body.conclusion).toBe('cancelled');
  });

  it('rechecks the exact head through the App GitHub client before the first publication write', async () => {
    const mock = route({ staleOnPublication: true, singlePersona: true });
    vi.stubGlobal('fetch', mock.fetchMock);

    await expect(runReviewPipeline(payload(9104))).rejects.toThrow(/head changed before publication/i);
    expect(mock.requests.filter((request) => request.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('turns incomplete recursive submodule context into a non-SHIP App verdict', async () => {
    const mock = route({ recursiveSubmodule: true });
    vi.stubGlobal('fetch', mock.fetchMock);

    await expect(runReviewPipeline(payload(9105))).resolves.toMatchObject({
      status: 'processed',
      arbiter: 'BLOCK',
      decision: 'REQUEST_CHANGES',
    });
    const reviews = mock.requests.filter((request) => request.url.endsWith('/reviews'));
    expect(reviews.at(-1)?.body.event).toBe('REQUEST_CHANGES');
    expect(reviews.at(-1)?.body.body).toContain('Binding arbiter verdict: BLOCK');
  });

  it('fails closed with a failed check and infrastructure comment during provider outage', async () => {
    const mock = route({ omniOutage: true });
    vi.stubGlobal('fetch', mock.fetchMock);

    await expect(runReviewPipeline(payload(9103))).rejects.toThrow(/required persona failure/i);
    expect(mock.requests.filter((request) => request.url.endsWith('/reviews'))).toHaveLength(0);
    const completion = mock.requests.find((request) =>
      request.url.includes('/check-runs/991') && request.method === 'PATCH',
    );
    expect(completion?.body.conclusion).toBe('failure');
    const comment = mock.requests.find((request) => /\/issues\/9103\/comments$/.test(request.url));
    expect(comment?.body.body).toContain('No code verdict or approval was fabricated');
  });
});
