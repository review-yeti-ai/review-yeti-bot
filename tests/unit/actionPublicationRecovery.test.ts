import { afterEach, describe, expect, it, vi } from 'vitest';

const { postOrOutputComment } = require('../../.github/workflows/pipelines/review-pipeline.js');
const head = '366e0d5d43dae75609821a8a8a63725a63b8e9c8';
const base = '7357e129f56fe4d94a947bcc0c0b2a2f66ef7531';
const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 638, headSha: head, baseSha: base };
const item = { path: 'src/github/appAuth.ts', line: 48, side: 'RIGHT', markerKey: 'review-yeti-finding:fixture', body: '**P2 · Cancellation coverage**\n\nAdd cancellation tests.' };
const plan = { lineComments: [item], fileComments: [], rejected: [], advisories: [] };
const summary = '## 🟢 **Verdict: SHIP**\n\n- **Quorum Status**: `SATISFIED`';
const ok = (value: unknown) => ({ status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
const failure = () => ({ status: 1, stdout: JSON.stringify({ message: 'PRIVATE_RESPONSE', errors: [{ resource: 'PullRequestReviewComment', field: 'line', code: 'invalid', value: 'PRIVATE_VALUE' }] }), stderr: 'gh: Validation Failed (HTTP 422) PRIVATE_STDERR' });

type Options = {
  mutate?: (state: any) => void;
  afterSnapshot?: (state: any, reads: number) => void;
  afterSummarySnapshot?: (state: any) => void;
  pagination?: { scope: 'nested' | 'outer'; response: unknown };
  response?: ReturnType<typeof failure>;
  stickyFailure?: boolean;
  hideSummary?: boolean;
  successfulCreate?: boolean;
};

// Only GitHub transport is fake. The real publisher must decide whether the persisted
// comment is sufficient and must still publish/read back its own current sticky summary.
function fixture(options: Options = {}, selectedPlan = plan) {
  const state: any = { threads: [], comments: [], posts: [], reads: 0, paginationReads: 0, publisher: 'github-actions[bot]', head, base, complete: true, readFailure: false };
  const commandRunner = (_exe: string, args: string[], commandOptions: any) => {
    if (args[0] === 'pr') return ok({ headRefOid: state.head, baseRefOid: state.base });
    if (args[1] === 'user') return ok(state.publisher);
    if (args[1] === 'graphql') {
      state.reads++;
      if (state.readFailure) return { status: 1, stdout: '', stderr: 'PRIVATE_GRAPHQL' };
      if (options.pagination && args.includes('endCursor=fixture-next')) {
        const nested = args.some(arg => arg.includes('query ReviewThreadComments'));
        if (nested !== (options.pagination.scope === 'nested')) throw new Error('Unexpected pagination connection');
        state.paginationReads++;
        return ok(options.pagination.response);
      }
      const snapshot = structuredClone({ data: { repository: { pullRequest: { reviewThreads: { nodes: state.threads, pageInfo: { hasNextPage: !state.complete, endCursor: null } } } } } });
      if (options.pagination && state.threads.length > 0) {
        const connection = snapshot.data.repository.pullRequest.reviewThreads;
        const paginated = options.pagination.scope === 'nested' ? connection.nodes[0].comments : connection;
        paginated.pageInfo = { hasNextPage: true, endCursor: 'fixture-next' };
      }
      options.afterSnapshot?.(state, state.reads);
      return ok(snapshot);
    }
    if (args[1]?.startsWith('repos/review-yeti-ai/review-yeti-bot/issues/638/comments?') && !args.includes('--method')) {
      const snapshot = ok(options.hideSummary ? '' : state.comments.map((c: any) => JSON.stringify(c)).join('\n'));
      if (state.comments.length > 0) options.afterSummarySnapshot?.(state);
      return snapshot;
    }
    if (args[1] === '--method') {
      const payload = JSON.parse(commandOptions.input);
      state.posts.push({ method: args[2], endpoint: args[3], payload });
      if (args[3].endsWith('/pulls/638/comments')) {
        state.threads.push({ id: 'thread-1', isResolved: false, isOutdated: false, path: payload.path, line: payload.line ?? null, diffSide: payload.side ?? null, startLine: payload.start_line ?? null, startDiffSide: payload.start_side ?? null, comments: { nodes: [{ databaseId: 3973120684, body: payload.body, author: { login: 'github-actions[bot]' }, commit: { oid: head } }], pageInfo: { hasNextPage: false, endCursor: null } } });
        options.mutate?.(state);
        return options.successfulCreate ? ok({ id: 3973120684, user: { login: state.publisher } }) : options.response ?? failure();
      }
      if (args[3].endsWith('/issues/638/comments')) {
        if (options.stickyFailure) return failure();
        state.comments.push({ id: 99, body: payload.body, user: { login: state.publisher } });
        return ok({ id: 99, user: { login: state.publisher } });
      }
      if (args[2] === 'PATCH' && args[3].endsWith('/issues/comments/99')) {
        const existing = state.comments.find((comment: any) => comment.id === 99);
        if (!existing) throw new Error('Fake PATCH requires an existing sticky comment');
        existing.body = payload.body;
        return ok(existing);
      }
    }
    throw new Error(`Unexpected fake GitHub call: ${args.slice(0, 4).join(' ')}`);
  };
  return { state, run: () => postOrOutputComment(summary, context, selectedPlan, { commandRunner }) };
}

afterEach(() => vi.restoreAllMocks());

describe('uncertain inline creation: strict read-back, never POST retry', () => {
  it.each([false, true])('requires a real visible sticky summary after creation (normal201=%s)', (successfulCreate) => {
    const f = fixture({ successfulCreate });
    expect(f.run()).toMatchObject({ success: true, summaryCommentId: 99 });
    expect(f.state.posts.map((p: any) => p.endpoint)).toEqual(['repos/review-yeti-ai/review-yeti-bot/pulls/638/comments', 'repos/review-yeti-ai/review-yeti-bot/issues/638/comments']);
    expect(f.state.posts[0].payload).toEqual({ commit_id: head, path: 'src/github/appAuth.ts', line: 48, side: 'RIGHT', body: `${item.body}\n\n<!-- review-yeti-bot:finding:v1:${head}:review-yeti-finding:fixture -->` });
    expect(f.state.comments[0].body).toContain(head);
    expect(f.state.reads).toBeGreaterThanOrEqual(successfulCreate ? 2 : 3);
  });

  const invalid: Array<[string, (s: any) => void]> = [
    ['missing', s => { s.threads = []; }],
    ['duplicate', s => { s.threads.push({ ...structuredClone(s.threads[0]), id: 'thread-2' }); }],
    ['wrong body with correct marker', s => { s.threads[0].comments.nodes[0].body = s.threads[0].comments.nodes[0].body.replace('Add cancellation tests.', 'Different finding.'); }],
    ['wrong marker', s => { s.threads[0].comments.nodes[0].body = s.threads[0].comments.nodes[0].body.replace('review-yeti-finding:fixture', 'review-yeti-finding:other'); }],
    ['wrong head', s => { s.threads[0].comments.nodes[0].commit.oid = 'c'.repeat(40); }],
    ['wrong author', s => { s.threads[0].comments.nodes[0].author.login = 'untrusted[bot]'; }],
    ['wrong path', s => { s.threads[0].path = 'src/other.ts'; }],
    ['wrong end line', s => { s.threads[0].line = 49; }],
    ['wrong side', s => { s.threads[0].diffSide = 'LEFT'; }],
    ['wrong start', s => { s.threads[0].startLine = 47; }],
    ['resolved', s => { s.threads[0].isResolved = true; }],
    ['outdated', s => { s.threads[0].isOutdated = true; }],
    ['missing outdated evidence', s => { delete s.threads[0].isOutdated; }],
    ['incomplete snapshot', s => { s.complete = false; }],
    ['incomplete comments', s => { s.threads[0].comments.pageInfo = { hasNextPage: true, endCursor: null }; }],
    ['failed readback', s => { s.readFailure = true; }],
    ['fresh head drift', s => { s.head = 'c'.repeat(40); }],
    ['fresh base drift', s => { s.base = 'd'.repeat(40); }],
    ['fresh publisher drift', s => { s.publisher = 'different[bot]'; }],
  ];
  it.each(invalid)('refuses %s without a second POST or a summary', (_name, mutate) => {
    const f = fixture({ mutate });
    expect(f.run().success).toBe(false);
    expect(f.state.posts).toHaveLength(1);
  });

  it.each(['head', 'base', 'publisher'])('rechecks %s after the recovery snapshot', (key) => {
    const f = fixture({ afterSnapshot(s, reads) { if (reads === 2) s[key] = key === 'publisher' ? 'changed[bot]' : 'e'.repeat(40); } });
    expect(f.run().success).toBe(false);
    expect(f.state.posts).toHaveLength(1);
  });

  describe.each([false, true])('existing sticky publisher boundary (needs PATCH=%s)', (needsPatch) => {
    it('refuses changed identity at the pre-sticky guard without adopting or writing', () => {
      let driftAtRead = Infinity;
      const f = fixture({ successfulCreate: true,
        afterSnapshot(state, reads) { if (reads === driftAtRead) state.publisher = 'changed[bot]'; },
      });
      expect(f.run()).toMatchObject({ success: true, summaryCommentId: 99 });
      if (needsPatch) f.state.comments[0].body += '\nprevious summary content';
      const before = structuredClone(f.state.comments);
      f.state.posts = [];
      driftAtRead = f.state.reads + 1;
      const result = f.run();
      expect(f.state.publisher).toBe('changed[bot]');
      expect(result).toMatchObject({ success: false, postedViaGh: false,
        error: 'GitHub review publication failed: sticky summary publication failed: Action review publisher changed before sticky publication',
      });
      expect(f.state.posts).toEqual([]);
      expect(f.state.comments).toEqual(before);
    });

    it('still permits the corresponding existing-comment path for an unchanged identity', () => {
      const f = fixture({ successfulCreate: true });
      expect(f.run()).toMatchObject({ success: true, summaryCommentId: 99 });
      if (needsPatch) f.state.comments[0].body += '\nprevious summary content';
      f.state.posts = [];
      expect(f.run()).toMatchObject({ success: true, postedViaGh: true, summaryCommentId: 99 });
      expect(f.state.posts.map((post: any) => [post.method, post.endpoint])).toEqual(needsPatch
        ? [['PATCH', 'repos/review-yeti-ai/review-yeti-bot/issues/comments/99']]
        : []);
      expect(f.state.comments).toHaveLength(1);
      expect(f.state.comments[0].user.login).toBe('github-actions[bot]');
    });
  });

  describe.each(['nested', 'outer'] as const)('%s strict pagination', (scope) => {
    const page = (connection: unknown) => scope === 'nested'
      ? { data: { node: { comments: connection } } }
      : { data: { repository: { pullRequest: { reviewThreads: connection } } } };
    const terminal = page({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } });

    it.each([
      ['absent page list', []],
      ['missing connection', {}],
      ['missing pageInfo', page({ nodes: [] })],
      ['later missing connection', [terminal, {}]],
      ['later missing pageInfo', [terminal, page({ nodes: [] })]],
      ['nonboolean hasNextPage', page({ nodes: [], pageInfo: { hasNextPage: 'false', endCursor: null } })],
    ])('refuses %s without retrying inline creation or publishing sticky', (_name, response) => {
      const f = fixture({ pagination: { scope, response } });
      expect(f.run()).toMatchObject({ success: false, postedViaGh: false, reconciledInlineCount: 0 });
      expect(f.state.paginationReads).toBe(1);
      expect(f.state.posts.map((p: any) => [p.method, p.endpoint])).toEqual([
        ['POST', 'repos/review-yeti-ai/review-yeti-bot/pulls/638/comments'],
      ]);
    });

    it.each([['object', terminal], ['page list', [terminal]]])('accepts an explicit empty terminal connection (%s)', (_name, response) => {
      const f = fixture({ pagination: { scope, response } });
      expect(f.run()).toMatchObject({ success: true, postedViaGh: true, reconciledInlineCount: 1, summaryCommentId: 99 });
      // Both recovery and final verification must observe the terminal page.
      expect(f.state.paginationReads).toBe(2);
      expect(f.state.posts.map((p: any) => [p.method, p.endpoint])).toEqual([
        ['POST', 'repos/review-yeti-ai/review-yeti-bot/pulls/638/comments'],
        ['POST', 'repos/review-yeti-ai/review-yeti-bot/issues/638/comments'],
      ]);
    });
  });

  describe.each([false, true])('terminal sticky identity (normal201=%s)', (successfulCreate) => {
    it.each(['head', 'base', 'publisher'])('refuses %s drift during the final visible sticky GET', (key) => {
      const f = fixture({
        successfulCreate,
        afterSummarySnapshot(s) { s[key] = key === 'publisher' ? 'changed[bot]' : 'e'.repeat(40); },
      });
      expect(f.run()).toMatchObject({ success: false, postedViaGh: false, reconciledInlineCount: successfulCreate ? 0 : 1 });
      expect(f.state[key]).toBe(key === 'publisher' ? 'changed[bot]' : 'e'.repeat(40));
      // The final read happens after the write: fail closed, never retry either POST.
      expect(f.state.posts.map((p: any) => [p.method, p.endpoint])).toEqual([
        ['POST', 'repos/review-yeti-ai/review-yeti-bot/pulls/638/comments'],
        ['POST', 'repos/review-yeti-ai/review-yeti-bot/issues/638/comments'],
      ]);
      expect(f.state.comments[0].body).toContain(head);
    });
  });

  it('does not weaken the final all-thread verification after recovering', () => {
    const f = fixture({ afterSnapshot(s, reads) { if (reads === 2) s.threads[0].diffSide = 'LEFT'; } });
    expect(f.run().success).toBe(false);
    expect(f.state.posts).toHaveLength(1);
  });

  it.each([{ stickyFailure: true }, { hideSummary: true }])('never reports success without the actual sticky receipt (%j)', (options) => {
    const f = fixture(options);
    expect(f.run().success).toBe(false);
    expect(f.state.posts).toHaveLength(2);
    expect(f.state.posts.filter((p: any) => p.endpoint.includes('/pulls/'))).toHaveLength(1);
  });

  it.each([false, true])('recovers only the exact multiline range (wrong start side=%s)', (wrong) => {
    const selected = { ...plan, lineComments: [{ ...item, startLine: 46 }] };
    const f = fixture({ mutate(s) { if (wrong) s.threads[0].startDiffSide = 'LEFT'; } }, selected);
    expect(f.run().success).toBe(!wrong);
    expect(f.state.posts.filter((p: any) => p.endpoint.includes('/pulls/'))).toHaveLength(1);
  });

  it('accepts GitHub single-line startLine echo without converting it to a range', () => {
    const f = fixture({ mutate(s) { s.threads[0].startLine = 48; } });
    expect(f.run().success).toBe(true);
  });

  it('recovers a lost-response process failure only with the same strict persisted proof', () => {
    const f = fixture({ response: { status: 1, stdout: '', stderr: 'PRIVATE_SOCKET_FAILURE' } });
    expect(f.run().success).toBe(true);
    expect(f.state.posts).toHaveLength(2);
  });
});

describe('publication API diagnostics have closed fields, not raw error messages', () => {
  it('retains 422 resource/field/code and safe request dimensions, never values or raw streams', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture({ mutate(s) { s.threads = []; } });
    const result = f.run();
    expect(result.diagnostics).toEqual([expect.objectContaining({ httpStatus: 422, validation: [{ resource: 'PullRequestReviewComment', field: 'line', code: 'invalid' }], request: expect.objectContaining({ headSha: head, line: 48, side: 'RIGHT', bodyBytes: expect.any(Number), bodyDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }) })]);
    expect(JSON.stringify([result, warn.mock.calls])).not.toMatch(/PRIVATE_|Add cancellation tests/);
  });

  it.each(['not json PRIVATE_RESPONSE', JSON.stringify({ errors: [{ resource: 'PRIVATE_RESOURCE', field: 'PRIVATE_FIELD', code: 'PRIVATE_CODE', message: 'PRIVATE_MESSAGE' }] }), 'x'.repeat(70_000)])('does not trust unknown/malformed/oversized error JSON', (stdout) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture({ mutate(s) { s.threads = []; }, response: { status: 1, stdout, stderr: 'gh: Validation Failed (HTTP 422) PRIVATE_STDERR' } });
    const result = f.run();
    expect(result.diagnostics?.[0]).toMatchObject({ httpStatus: 422, validation: [] });
    expect(JSON.stringify([result, warn.mock.calls])).not.toMatch(/PRIVATE_|xxxxxx/);
  });
});
