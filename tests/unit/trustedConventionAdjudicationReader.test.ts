import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_TRUSTED_CONVENTION_COMMENT_PAGES,
  readTrustedConventionAdjudications,
  trustedConventionCommentSourceIdDigest,
} from '../../src/github/trustedConventionAdjudicationReader';

const repository = 'exampleorg/project';
const prNumber = 42;
const headSha = 'a'.repeat(40);
const findingId = `lf1_${'1'.repeat(32)}`;
const evidenceDigest = '2'.repeat(64);
const createdAt = '2026-10-06T14:00:00Z';

function command(overrides: Partial<{
  repository: string;
  prNumber: number;
  headSha: string;
  findingId: string;
  evidenceDigest: string;
  conventionId: string;
}> = {}): string {
  return `/review-yeti accept-convention repo=${overrides.repository ?? repository}`
    + ` pr=${overrides.prNumber ?? prNumber} head=${overrides.headSha ?? headSha}`
    + ` finding=${overrides.findingId ?? findingId} evidence=${overrides.evidenceDigest ?? evidenceDigest}`
    + ` convention=${overrides.conventionId ?? 'legacy-header-case'}`;
}

function comment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 101,
    user: { id: 17, login: 'maintainer' },
    created_at: createdAt,
    body: command(),
    ...overrides,
  };
}

function harness(options: {
  comments?: unknown[];
  pages?: Map<number, unknown[]>;
  permission?: unknown;
  permissionStatus?: number;
  commentsStatus?: number;
  pullRequest?: unknown;
  pullRequestStatus?: number;
} = {}) {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const comments = options.comments ?? [];
  const fetchImplementation = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(rawUrl));
    requests.push({ url, init: init ?? {} });
    if (url.pathname.endsWith(`/pulls/${prNumber}`)) {
      return new Response(JSON.stringify(options.pullRequest ?? {
        number: prNumber,
        state: 'open',
        merged: false,
        head: { sha: headSha },
        base: { repo: { full_name: 'ExampleOrg/Project' } },
      }), { status: options.pullRequestStatus ?? 200 });
    }
    if (url.pathname.endsWith(`/issues/${prNumber}/comments`)) {
      const page = Number(url.searchParams.get('page'));
      const rows = options.pages?.get(page) ?? (page === 1 ? comments : []);
      return new Response(JSON.stringify(rows), { status: options.commentsStatus ?? 200 });
    }
    if (url.pathname.endsWith('/collaborators/maintainer/permission')) {
      return new Response(JSON.stringify(options.permission ?? {
        user: { id: 17, login: 'maintainer' },
        permission: 'write',
        role_name: 'maintain',
      }), { status: options.permissionStatus ?? 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { requests, fetchImplementation };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    repository,
    prNumber,
    expectedHeadSha: headSha,
    currentFindings: [{ findingId, evidenceDigest }],
    ...overrides,
  };
}

describe('trusted convention adjudication reader', () => {
  it('accepts an exact current command only after verifying the PR and writer permission', async () => {
    const { fetchImplementation, requests } = harness({ comments: [comment()] });

    const result = await readTrustedConventionAdjudications(input(), {
      token: 'ghs_test', fetchImplementation,
    });

    expect(result).toMatchObject({
      status: 'available',
      adjudications: [{
        repository: 'ExampleOrg/Project', prNumber, headSha, findingId, evidenceDigest,
        conventionId: 'legacy-header-case', commentId: 101, createdAt,
        actorDigest: createHash('sha256').update(`github-user.v1\0${17}`).digest('hex'),
        permission: 'maintain',
        sourceIdDigest: trustedConventionCommentSourceIdDigest(101),
        receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }],
    });
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      '/repos/exampleorg/project/pulls/42',
      '/repos/exampleorg/project/issues/42/comments',
      '/repos/exampleorg/project/collaborators/maintainer/permission',
    ]);
    expect(requests.every(({ init }) => (init.headers as Record<string, string>).authorization === 'Bearer ghs_test')).toBe(true);
  });

  it('drops commands with cross-repository, stale-head, unknown-finding, or wrong-evidence metadata', async () => {
    const { fetchImplementation } = harness({ comments: [
      comment({ id: 101, body: command({ repository: 'otherorg/project' }) }),
      comment({ id: 102, body: command({ headSha: 'b'.repeat(40) }) }),
      comment({ id: 103, body: command({ findingId: `lf1_${'3'.repeat(32)}` }) }),
      comment({ id: 104, body: command({ evidenceDigest: '4'.repeat(64) }) }),
    ] });

    const result = await readTrustedConventionAdjudications(input(), {
      token: 'ghs_test', fetchImplementation,
    });

    expect(result).toMatchObject({ status: 'available', adjudications: [] });
  });

  it('rejects any non-exact body, including extra lines and whitespace', async () => {
    const { fetchImplementation } = harness({ comments: [
      comment({ body: `${command()}\nplease do this` }),
      comment({ id: 102, body: `${command()}\n` }),
      comment({ id: 103, body: ` ${command()}` }),
      comment({ id: 104, body: command().replace('legacy-header-case', 'Legacy-Header-Case') }),
    ] });

    const result = await readTrustedConventionAdjudications(input(), {
      token: 'ghs_test', fetchImplementation,
    });

    expect(result).toMatchObject({ status: 'available', adjudications: [] });
  });

  it('returns stale with no comments read when GitHub reports a newer PR head', async () => {
    const { fetchImplementation, requests } = harness({
      pullRequest: {
        number: prNumber, state: 'open', merged: false,
        head: { sha: 'b'.repeat(40) }, base: { repo: { full_name: 'ExampleOrg/Project' } },
      },
      comments: [comment()],
    });

    const result = await readTrustedConventionAdjudications(input(), {
      token: 'ghs_test', fetchImplementation,
    });

    expect(result).toEqual({ status: 'stale', reason: 'head-moved', adjudications: [] });
    expect(requests).toHaveLength(1);
  });

  it('drops a command when the authenticated collaborator endpoint reports read-only access', async () => {
    const { fetchImplementation } = harness({
      comments: [comment()],
      permission: { user: { id: 17, login: 'maintainer' }, permission: 'read' },
    });

    const result = await readTrustedConventionAdjudications(input(), {
      token: 'ghs_test', fetchImplementation,
    });

    expect(result).toMatchObject({ status: 'available', adjudications: [] });
  });

  it.each([
    { permission: 'admin', role_name: 'admin', accepted: 'admin' },
    { permission: 'write', role_name: 'maintain', accepted: 'maintain' },
  ] as const)('accepts authenticated $accepted collaborator role', async ({ permission, role_name, accepted }) => {
    const { fetchImplementation } = harness({
      comments: [comment()],
      permission: { user: { id: 17, login: 'maintainer' }, permission, role_name },
    });

    const result = await readTrustedConventionAdjudications(input(), {
      token: 'ghs_test', fetchImplementation,
    });

    expect(result).toMatchObject({ status: 'available', adjudications: [{ permission: accepted }] });
  });

  it.each([
    { permission: 'write' },
    { permission: 'write', role_name: 'write' },
    { permission: 'read', role_name: 'write' },
  ])('does not accept generic $permission permission without an admin or maintain role', async (permission) => {
    const { fetchImplementation } = harness({ comments: [comment()],
      permission: { user: { id: 17, login: 'maintainer' }, ...permission } });
    const result = await readTrustedConventionAdjudications(input(), { token: 'ghs_test', fetchImplementation });
    expect(result).toMatchObject({ status: 'available', adjudications: [] });
  });

  it('drops all authorized commands for a finding when more than one is present', async () => {
    const { fetchImplementation } = harness({ comments: [
      comment({ id: 101 }),
      comment({ id: 102, body: command({ conventionId: 'different-convention' }) }),
    ] });

    const result = await readTrustedConventionAdjudications(input(), {
      token: 'ghs_test', fetchImplementation,
    });

    expect(result).toMatchObject({ status: 'available', adjudications: [] });
  });

  it('does not replay a comment source already present in durable history', async () => {
    const { fetchImplementation } = harness({ comments: [comment()] });

    const result = await readTrustedConventionAdjudications(input({
      consumedCommentSourceIdDigests: [trustedConventionCommentSourceIdDigest(101)],
    }), { token: 'ghs_test', fetchImplementation });

    expect(result).toMatchObject({ status: 'available', adjudications: [] });
  });

  it('reads the next page when the first comment page is full', async () => {
    const pages = new Map<number, unknown[]>([
      [1, Array.from({ length: 100 }, (_, index) => ({
        id: index + 1, user: { id: 18, login: 'reviewer' }, created_at: createdAt, body: 'ordinary comment',
      }))],
      [2, [comment({ id: 101 })]],
    ]);
    const { fetchImplementation, requests } = harness({ pages });

    const result = await readTrustedConventionAdjudications(input(), {
      token: 'ghs_test', fetchImplementation,
    });

    expect(result).toMatchObject({ status: 'available', adjudications: [{ commentId: 101 }] });
    expect(requests.filter(({ url }) => url.pathname.endsWith('/issues/42/comments'))
      .map(({ url }) => url.searchParams.get('page'))).toEqual(['1', '2']);
  });

  it('returns unavailable when a PR comment exceeds the body-size bound', async () => {
    const { fetchImplementation } = harness({ comments: [comment({ body: 'x'.repeat(2_049) })] });

    const result = await readTrustedConventionAdjudications(input(), {
      token: 'ghs_test', fetchImplementation,
    });

    expect(result).toEqual({ status: 'unavailable', reason: 'comment-body-limit', adjudications: [] });
  });

  it('returns unavailable and clears candidates when comment or permission reads fail', async () => {
    const commentFailure = harness({ comments: [comment()], commentsStatus: 403 });
    await expect(readTrustedConventionAdjudications(input(), {
      token: 'ghs_test', fetchImplementation: commentFailure.fetchImplementation,
    })).resolves.toEqual({ status: 'unavailable', reason: 'github-read-failed', adjudications: [] });

    const permissionFailure = harness({ comments: [comment()], permissionStatus: 403 });
    await expect(readTrustedConventionAdjudications(input(), {
      token: 'ghs_test', fetchImplementation: permissionFailure.fetchImplementation,
    })).resolves.toEqual({ status: 'unavailable', reason: 'github-read-failed', adjudications: [] });
  });

  it('fails closed at the bounded comment pagination limit', async () => {
    const pages = new Map<number, unknown[]>();
    for (let page = 1; page <= MAX_TRUSTED_CONVENTION_COMMENT_PAGES; page += 1) {
      pages.set(page, Array.from({ length: 100 }, (_, index) => ({
        id: (page - 1) * 100 + index + 1,
        user: { id: 17, login: 'maintainer' },
        created_at: createdAt,
        body: 'ordinary review comment',
      })));
    }
    const { fetchImplementation, requests } = harness({ pages });

    const result = await readTrustedConventionAdjudications(input(), {
      token: 'ghs_test', fetchImplementation,
    });

    expect(result).toEqual({ status: 'unavailable', reason: 'comment-pagination-limit', adjudications: [] });
    expect(requests.filter(({ url }) => url.pathname.endsWith('/issues/42/comments'))).toHaveLength(
      MAX_TRUSTED_CONVENTION_COMMENT_PAGES,
    );
  });
});
