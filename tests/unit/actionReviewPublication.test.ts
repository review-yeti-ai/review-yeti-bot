import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
/**
 * Regression cover for the Action's review publication surface.
 *
 * Both behaviours under test here were lost on 2026-08-21 when `2f28719a` grafted a disjoint
 * v5.0.0 lineage over main: the Action fell back to one issue comment per head SHA, with findings
 * reduced to Checks-tab annotations that cannot be resolved. The dedupe cases come from the
 * original comment-volume corpus (example-org/example-app#4821, where 14 full-panel reruns
 * produced 65 inline findings); the publication cases pin the sticky anchor and the exact-head
 * current sticky overview receipt.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

import { compareClaims } from '../../src/review/claimSimilarity';
import { formatFindingCommentBody, planFindingPublication } from '../../src/review/findingPublication';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const {
  actionSummaryAnchor,
  capPublicationThreads,
  findLatestIssueComment,
  MAX_STICKY_COMMENT_CHARS,
  postOrOutputComment,
  postStickySummaryComment,
  MAX_READ_ACTION_REVIEWS,
  readActionReviews,
  readActionReviewThreads,
  resolveOutdatedOwnThreads,
  renderStickySummaryBody,
} = pipeline;

/**
 * `readActionReviews` and `readActionReviewThreads` both go through `gh api graphql`, so a stub has
 * to answer by document rather than by endpoint.
 */
const isReviewListQuery = (args: string[]) => args.some((arg) => arg.includes('query ActionReviews'));

const reviewListPage = (reviews: any[]) => JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        reviews: {
          nodes: reviews.map((review) => ({
            databaseId: review.id,
            body: review.body,
            submittedAt: review.submitted_at || null,
            author: { login: review.user?.login },
            commit: { oid: review.commit_id },
          })),
        },
      },
    },
  },
});

const CONTROLLER = 'server/ExampleApp/Controllers/InventoryAuditsController.cs';
const SERVICE = 'server/ExampleApp/Services/InventoryAuditService.cs';

/* -------------------------------------------------------------------------------------------- */


describe('work item 3 — one defect reported by two personas is one conversation', () => {
  const patch = `@@ -240,0 +240,60 @@\n${Array.from({ length: 60 }, (_, i) => `+line${i}`).join('\n')}`;

  it('merges the module gate and feature gate reports and credits both reviewers', () => {
    const plan = planFindingPublication([
      {
        displayName: '🛡️ Security',
        findings: [{
          severity: 'P1', path: CONTROLLER, line: 248,
          title: 'Cancel bypasses the inventory-access entitlement check',
          body: 'The cancel endpoint checks only stock Update permission and omits HasInventoryAccessAsync, unlike every other inventory-audit endpoint. A tenant whose inventory-access module is disabled can still change inventory-audit records by cancelling them.',
        }],
      },
      {
        displayName: '🏛️ Architecture',
        findings: [{
          severity: 'P1', path: CONTROLLER, line: 250,
          title: 'Cancel bypasses the inventory-access entitlement check',
          body: 'The cancel endpoint checks tenant presence and stock Update permission but never calls HasInventoryAccessAsync, unlike every other inventory-audit endpoint.',
        }],
      },
    ], [{ path: CONTROLLER, patch }]);

    expect(plan.lineComments).toHaveLength(1);
    expect(plan.lineComments[0].personas).toEqual(['🏛️ Architecture', '🛡️ Security']);
    expect(plan.lineComments[0].line).toBe(248);
    expect(plan.rejected).toEqual([]);
  });

  it('keeps the losing title visible instead of discarding it', () => {
    const body = formatFindingCommentBody({
      severity: 'P1',
      path: CONTROLLER,
      line: 248,
      side: 'RIGHT',
      title: 'Cancel bypasses the inventory-access entitlement check',
      body: 'The cancel endpoint omits the module check.',
      personas: ['🛡️ Security', '🏛️ Architecture'],
      mergedTitles: ['Cancel bypasses the inventory-access feature gate'],
    } as any);

    expect(body).toContain('**Also reported as:** _Cancel bypasses the inventory-access feature gate_');
    expect(body).toContain('**Reported by:**');
  });

  // These two sat either side of the threshold on the calibration corpus (0.377 against a genuine
  // duplicate at 0.383), so they are the pair most at risk of being wrongly collapsed.
  it('does not merge two distinct defects that happen to share vocabulary', () => {
    const plan = planFindingPublication([{
      displayName: 'Concurrency',
      findings: [
        { severity: 'P1', path: SERVICE, line: 111, title: 'Cancel must serialize with completion', body: 'CancelAsync writes the cancelled state outside the transaction that CompleteAsync uses, so a cancel issued mid-completion is silently overwritten when the completion commits.' },
        { severity: 'P1', path: SERVICE, line: 267, title: 'Serialize approval with completion', body: 'ApproveVarianceAsync reads the approval flag before CompleteAsync takes its row lock, so a variance approved during completion is applied against a stale threshold.' },
      ],
    }], [{ path: SERVICE, patch: `@@ -100,0 +100,200 @@\n${Array.from({ length: 200 }, (_, i) => `+s${i}`).join('\n')}` }]);

    expect(plan.lineComments).toHaveLength(2);
  });

  it('never merges the same claim about two different files', () => {
    const claim = { title: 'Cycle-count review data has no authorization check', body: 'The read path does not verify the caller.' };
    expect(compareClaims({ ...claim, path: 'a.cs', line: 10 }, { ...claim, path: 'b.cs', line: 10 }).duplicate).toBe(false);
  });

  it('can be turned off to inspect the unmerged set', () => {
    const input = [{
      displayName: 'Security',
      findings: [
        { severity: 'P1' as const, path: CONTROLLER, line: 248, title: 'Cancel bypasses the inventory-access entitlement check', body: 'Omits HasInventoryAccessAsync on the cancel endpoint.' },
        { severity: 'P1' as const, path: CONTROLLER, line: 250, title: 'Cancel bypasses the inventory-access entitlement check', body: 'Omits HasInventoryAccessAsync on the cancel endpoint entirely.' },
      ],
    }];
    const files = [{ path: CONTROLLER, patch }];

    expect(planFindingPublication(input, files).lineComments).toHaveLength(1);
    expect(planFindingPublication(input, files, { mergeNearDuplicates: false }).lineComments).toHaveLength(2);
  });

  it('collapses every "no tests" report about one file into one, however each was worded', () => {
    const titles = [
      'Cycle-count approval and completion rules have no tests',
      'Supervisor approval gate has no tests',
      'Add a regression test for stale item-level counts',
      'Add tests for stale count detection before inventory adjustment',
      'No tests cover the inventory-audit approval gate',
      'Test the live supervisor-approval gate',
    ];
    const policy = 'server/ExampleApp/Policies/InventoryAuditPolicy.cs';

    const plan = planFindingPublication([{
      displayName: '🧪 Testing',
      findings: titles.map((title, index) => ({
        severity: 'P1' as const,
        path: policy,
        line: 19 + index * 6,
        title,
        body: `${title}. No test in this change exercises it.`,
      })),
    }], [{ path: policy, patch: `@@ -19,0 +19,60 @@\n${Array.from({ length: 60 }, (_, i) => `+p${i}`).join('\n')}` }]);

    expect(plan.lineComments).toHaveLength(1);
    expect(plan.lineComments[0]?.finding?.mergedTitles?.length).toBe(5);
  });
});

/* -------------------------------------------------------------------------------------------- */


describe('one current sticky overview across pushes and reruns', () => {
  const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, headSha: 'newhead', baseSha: 'base' };
  const emptyPlan = { lineComments: [], fileComments: [], advisories: [], rejected: [] };
  function runner(options: { mirrorWrites?: boolean; author?: string; mutateBody?: (body: string) => string; changeHeadOnWrite?: boolean } = {}) {
    const state = { head: 'newhead', comments: [] as any[], reviews: [] as any[], posted: [] as any[], nextId: 1 };
    const commandRunner = (_exe: string, args: string[], commandOptions: any) => {
      if (args[0] === 'pr') return { status: 0, stdout: JSON.stringify({ headRefOid: state.head, baseRefOid: 'base' }) };
      if (args[1] === 'user') return { status: 0, stdout: 'github-actions[bot]' };
      if (args[1] === 'graphql') return { status: 0, stdout: isReviewListQuery(args) ? reviewListPage(state.reviews) : JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) };
      if (!args.includes('--method') && args[1].includes('/issues/42/comments')) return { status: 0, stdout: JSON.stringify(state.comments) };
      if (args.includes('--method')) {
        const method = args[args.indexOf('--method') + 1], endpoint = args[3], payload = JSON.parse(commandOptions.input);
        state.posted.push({ method, endpoint, payload });
        if (options.changeHeadOnWrite) state.head = 'superseding-head';
        const user = { login: options.author ?? 'github-actions[bot]' };
        const body = options.mutateBody ? options.mutateBody(payload.body) : payload.body;
        if (method === 'PATCH') {
          const target = state.comments.find(c => endpoint.endsWith(`/${c.id}`));
          if (target && options.mirrorWrites !== false) Object.assign(target, { body, user });
          return { status: 0, stdout: JSON.stringify({ id: target?.id, body, user }) };
        }
        const created = { id: state.nextId++, body, user };
        if (options.mirrorWrites !== false && endpoint.endsWith('/issues/42/comments')) state.comments.push(created);
        return { status: 0, stdout: JSON.stringify(created) };
      }
      return { status: 1, stderr: `unexpected: ${args.join(' ')}` };
    };
    return { state, commandRunner };
  }
  const body = (verdict = 'SHIP') => `## **Verdict: ${verdict}**\n\n- **Quorum Status**: \`SATISFIED\`\n- **Review Status**: \`${verdict}\``;

  it('publishes only one issue overview and no verdict review', () => {
    const { state, commandRunner } = runner();
    expect(postOrOutputComment(body(), context, emptyPlan, { commandRunner }).success).toBe(true);
    expect(state.posted).toHaveLength(1);
    expect(state.posted[0].endpoint).toContain('/issues/42/comments');
    expect(state.comments[0].body).toContain(actionSummaryAnchor(context));
    expect(state.comments[0].body).toContain(':newhead:action -->');
  });
  it('keeps only verdict and overview fields rather than finding bodies and telemetry', () => {
    const { state, commandRunner } = runner();
    const details = `${body()}\n- **Total Findings**: P0: \`0\` | P1: \`0\` | P2: \`1\`\n### Architecture\nDuplicated merge logic finding body\n<details><summary>Telemetry</summary>provider details</details>`;
    expect(postOrOutputComment(details, context, emptyPlan, { commandRunner }).success).toBe(true);
    expect(state.comments[0].body).toContain('Total Findings');
    expect(state.comments[0].body).not.toContain('Duplicated merge logic');
    expect(state.comments[0].body).not.toContain('provider details');
  });
  it('preserves partial coverage disclosure when condensing the actual pipeline summary', () => {
    const { state, commandRunner } = runner();
    const arbitration = { verdict: 'SHIP', completedPersonas: 1, totalPersonas: 1, quorumSatisfied: true, rationale: 'No blocking findings.', metrics: { p0Count: 0, p1Count: 0, p2Count: 0 } };
    const rendered = pipeline.formatPRComment(arbitration, [], context, {}, { enabled: true }, { omitted: ['src/omitted.ts'], truncated: ['src/partial.ts'] });
    expect(postOrOutputComment(rendered, context, emptyPlan, { commandRunner }).success).toBe(true);
    expect(state.comments[0].body).toContain('This verdict covers part of the change');
    expect(state.comments[0].body).toContain('1 file(s) were not reviewed');
    expect(state.comments[0].body).toContain('src/omitted.ts');
    expect(state.comments[0].body).toContain('1 file(s) were truncated');
    expect(state.comments[0].body).not.toContain('Persona Evaluation Roster');
  });
  it('updates the same comment for a different head and replaces the old result', () => {
    const { state, commandRunner } = runner();
    postOrOutputComment(body('BLOCK'), context, emptyPlan, { commandRunner });
    state.head = 'nexthead';
    expect(postOrOutputComment(body(), { ...context, headSha: state.head }, emptyPlan, { commandRunner }).success).toBe(true);
    expect(state.comments).toHaveLength(1);
    expect(state.posted.map(p => p.method)).toEqual(['POST', 'PATCH']);
    expect(state.comments[0].body).toContain(':nexthead:action -->');
    expect(state.comments[0].body).not.toContain(':newhead:action -->');
    expect(state.comments[0].body).not.toContain('Verdict: BLOCK');
    expect(state.comments[0].body).not.toContain('Previous review rounds');
  });
  it('refreshes the attempt marker even when a rerun has the identical verdict', () => {
    const { state, commandRunner } = runner();
    postOrOutputComment(body(), context, emptyPlan, { commandRunner, publicationAttemptId: 'run:attempt-1' });
    expect(postOrOutputComment(body(), context, emptyPlan, { commandRunner, publicationAttemptId: 'run:attempt-2' }).success).toBe(true);
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0].body).toContain(':run:attempt-2 -->');
    expect(state.comments[0].body).not.toContain(':run:attempt-1 -->');
  });
  it('deduplicates an identical retry of the same attempt', () => {
    const { state, commandRunner } = runner();
    postOrOutputComment(body(), context, emptyPlan, { commandRunner, publicationAttemptId: 'same' });
    expect(postOrOutputComment(body(), context, emptyPlan, { commandRunner, publicationAttemptId: 'same' }).success).toBe(true);
    expect(state.posted).toHaveLength(1);
  });
  it('fails before writing when the pull request head changed', () => {
    const { state, commandRunner } = runner(); state.head = 'other';
    expect(postOrOutputComment(body(), context, emptyPlan, { commandRunner }).success).toBe(false);
    expect(state.posted).toHaveLength(0);
  });
  it('fails when the head advances during publication', () => {
    const { commandRunner } = runner({ changeHeadOnWrite: true });
    expect(postOrOutputComment(body(), context, emptyPlan, { commandRunner }).success).toBe(false);
  });
  it('rejects a marker-only readback that lost the verdict', () => {
    const { commandRunner } = runner({ mutateBody: b => b.split('\n').filter(line => line.includes('<!--')).join('\n') });
    expect(postOrOutputComment(body(), context, emptyPlan, { commandRunner }).success).toBe(false);
  });
  it('fails when the sticky write is not visible afterwards', () => {
    const { commandRunner } = runner({ mirrorWrites: false });
    expect(postOrOutputComment(body(), context, emptyPlan, { commandRunner }).success).toBe(false);
  });
  it('does not accept the previous attempt as proof of the current write', () => {
    const { commandRunner } = runner({ mutateBody: b => b.replace(':current -->', ':previous -->') });
    expect(postOrOutputComment(body(), context, emptyPlan, { commandRunner, publicationAttemptId: 'current' }).success).toBe(false);
  });
  it.each(['someone-else', ''])('rejects a sticky result attributed to %j', author => {
    const { commandRunner } = runner({ author });
    expect(postOrOutputComment(body(), context, emptyPlan, { commandRunner }).success).toBe(false);
  });
});

describe('all actionable findings receive conversations', () => {
  it('does not overflow findings after ten threads and includes P2', () => {
    const files = Array.from({ length: 24 }, (_, i) => ({ path: `src/module${i}.ts`, patch: '@@ -0,0 +1 @@\n+new' }));
    const plan = capPublicationThreads(planFindingPublication([{ displayName: 'Reviewer', findings: files.map((file, i) => ({
      path: file.path, line: 1, severity: i % 2 ? 'P1' : 'P2', title: `Defect in module ${i}`, body: 'The current path returns an incorrect result.',
    })) }], files));
    expect(plan.lineComments).toHaveLength(24);
    expect(plan.overflow || []).toHaveLength(0);
    expect(plan.advisories).toHaveLength(0);
  });
});

describe('reading existing review threads', () => {
  const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, headSha: 'newhead', baseSha: 'base' };

  const thread = (id: string, overrides: any = {}) => ({
    id,
    isResolved: false,
    isOutdated: false,
    path: `src/${id}.ts`,
    line: 4,
    diffSide: 'RIGHT',
    comments: {
      nodes: [{ databaseId: Number(id.replace(/\D/gu, '')) || 1, body: `body ${id}`, createdAt: '2026-09-06T00:00:00Z', author: { login: 'github-actions[bot]' }, commit: { oid: 'newhead' } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    ...overrides,
  });

  const threadPage = (nodes: any[], pageInfo: any) => JSON.stringify([
    { data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo } } } } },
  ]);

  const isCommentQuery = (args: string[]) => args.some((arg) => arg.startsWith('threadId='));

  it('collects threads across every page', () => {
    let call = 0;
    const commandRunner = (_exe: string, args: string[]) => {
      if (args[0] !== 'api' || args[1] !== 'graphql') return { status: 1, stdout: '', stderr: 'unexpected' };
      call += 1;
      if (call === 1) return { status: 0, stdout: threadPage([thread('t1'), thread('t2')], { hasNextPage: true, endCursor: 'cursor-1' }), stderr: '' };
      return { status: 0, stdout: threadPage([thread('t3')], { hasNextPage: false, endCursor: null }), stderr: '' };
    };

    const snapshot = readActionReviewThreads(commandRunner, context);

    expect(snapshot.threads.map((entry: any) => entry.id)).toEqual(['t1', 't2', 't3']);
    expect(snapshot.complete).toBe(true);
  });

  // A server that keeps claiming another page while handing back the same cursor would spin
  // forever; the reader has to stop and say the snapshot is partial.
  it('stops on a repeated cursor instead of looping, and reports the snapshot as partial', () => {
    let calls = 0;
    const commandRunner = (_exe: string, args: string[]) => {
      if (args[0] !== 'api' || args[1] !== 'graphql') return { status: 1, stdout: '', stderr: 'unexpected' };
      calls += 1;
      return { status: 0, stdout: threadPage([thread(`t${calls}`)], { hasNextPage: true, endCursor: 'stuck' }), stderr: '' };
    };

    const snapshot = readActionReviewThreads(commandRunner, context);

    expect(snapshot.complete).toBe(false);
    expect(calls).toBeLessThanOrEqual(10);
  });

  it('marks the snapshot partial when a thread has comments it could not finish reading', () => {
    let commentCalls = 0;
    const commandRunner = (_exe: string, args: string[]) => {
      if (args[0] !== 'api' || args[1] !== 'graphql') return { status: 1, stdout: '', stderr: 'unexpected' };
      if (isCommentQuery(args)) {
        commentCalls += 1;
        return {
          status: 0,
          stdout: JSON.stringify([{ data: { node: { comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'stuck' } } } } }]),
          stderr: '',
        };
      }
      return {
        status: 0,
        stdout: threadPage(
          [thread('t1', { comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'stuck' } } })],
          { hasNextPage: false, endCursor: null },
        ),
        stderr: '',
      };
    };

    const snapshot = readActionReviewThreads(commandRunner, context);

    expect(commentCalls).toBeGreaterThan(0);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.threads[0].commentsComplete).toBe(false);
  });

  it('surfaces a GraphQL error rather than treating it as an empty snapshot', () => {
    const commandRunner = () => ({ status: 0, stdout: JSON.stringify([{ errors: [{ message: 'Resource not accessible' }] }]), stderr: '' });

    expect(() => readActionReviewThreads(commandRunner, context)).toThrow('Resource not accessible');
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('the sticky summary refuses to adopt a comment it did not write', () => {
  const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, headSha: 'newhead', baseSha: 'base' };
  const anchor = '<!-- review-yeti-bot:summary:v1:review-yeti-ai/review-yeti-bot#42 -->';

  // The anchor is derived entirely from the repository and pull request number, so anyone who can
  // read the PR URL can write a comment containing it.
  function runner(seedComments: any[], options: { publisher?: string | null } = {}) {
    const publisher = options.publisher === undefined ? 'github-actions[bot]' : options.publisher;
    const state = { comments: [...seedComments], posted: [] as any[], nextId: 700 };
    const commandRunner = (_exe: string, args: string[], commandOptions: any) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ headRefOid: 'newhead', baseRefOid: 'base' }), stderr: '' };
      }
      if (args[0] === 'api' && (args[1] === 'user' || args[1] === 'installation')) {
        return publisher ? { status: 0, stdout: `${publisher}\n`, stderr: '' } : { status: 1, stdout: '', stderr: 'no identity' };
      }
      if (args[0] === 'api' && String(args[1]).includes('/issues/42/comments') && !args.includes('--method')) {
        return { status: 0, stdout: state.comments.map((comment) => JSON.stringify(comment)).join('\n'), stderr: '' };
      }
      if (args[0] === 'api' && args.includes('--method')) {
        const method = args[args.indexOf('--method') + 1];
        const endpoint = args[3];
        state.posted.push({ method, endpoint, payload: JSON.parse(commandOptions.input) });
        // GitHub echoes the patched comment, so a PATCH keeps its own id rather than minting one.
        const patched = method === 'PATCH' ? state.comments.find((comment) => endpoint.endsWith(`/${comment.id}`)) : null;
        if (patched) return { status: 0, stdout: JSON.stringify({ id: patched.id, user: { login: publisher } }), stderr: '' };
        state.nextId += 1;
        return { status: 0, stdout: JSON.stringify({ id: state.nextId, user: { login: publisher } }), stderr: '' };
      }
      if (args[0] === 'api' && String(args[1]).includes('/pulls/42/reviews')) {
        return { status: 0, stdout: JSON.stringify([[]]), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
    };
    return { state, commandRunner };
  }

  it('posts its own comment instead of overwriting a planted one carrying the anchor', () => {
    const planted = { id: 6001, body: `looks fine to me ${anchor}`, user: { login: 'drive-by-contributor' } };
    const { state, commandRunner } = runner([planted]);

    const result = postStickySummaryComment('real summary', context, { commandRunner, existingReviews: [] });

    expect(result.success).toBe(true);
    expect(state.posted.every((post) => post.method !== 'PATCH')).toBe(true);
    expect(state.posted.some((post) => post.method === 'POST' && post.endpoint.endsWith('/issues/42/comments'))).toBe(true);
  });

  it('is not silenced by a planted comment claiming to be an existing round', () => {
    const planted = { id: 6002, body: `${anchor}\n<!-- review-yeti-bot:summary-round:v1:review-yeti-ai/review-yeti-bot#42:newhead:deadbeefdeadbeef -->`, user: { login: 'drive-by-contributor' } };
    const { state, commandRunner } = runner([planted]);

    const result = postStickySummaryComment('real summary', context, { commandRunner, existingReviews: [] });

    expect(result.deduplicated).toBeFalsy();
    expect(state.posted.some((post) => post.method === 'POST')).toBe(true);
  });

  it('still patches its own prior comment', () => {
    const own = { id: 6003, body: `earlier round ${anchor}`, user: { login: 'github-actions[bot]' } };
    const { state, commandRunner } = runner([own]);

    const result = postStickySummaryComment('later round', context, { commandRunner, existingReviews: [] });

    expect(result).toMatchObject({ success: true, updatedInPlace: true, commentId: 6003 });
    expect(state.posted.filter((post) => post.method === 'PATCH')).toHaveLength(1);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // A runner environment never authenticates the token's publishing identity.
  it('fails loudly when the publishing identity cannot be established', () => {
    vi.stubEnv('GITHUB_ACTIONS', '');
    const { state, commandRunner } = runner([], { publisher: null });

    const result = postStickySummaryComment('summary', context, { commandRunner, existingReviews: [] });

    expect(result.success).toBe(false);
    expect(result.error).toContain('could not determine the publishing GitHub identity');
    expect(state.posted).toHaveLength(0);
  });

  it('does not adopt an Actions comment when no API verifies the publisher', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    const own = { id: 6004, body: `earlier round ${anchor}`, user: { login: 'github-actions[bot]' } };
    const { state, commandRunner } = runner([own], { publisher: null });

    const result = postStickySummaryComment('later round', context, { commandRunner, existingReviews: [] });

    expect(result.success).toBe(false);
    expect(result.error).toContain('could not determine the publishing GitHub identity');
    expect(state.posted).toHaveLength(0);
  });
});

describe('finding the sticky comment without reading the whole conversation', () => {
  const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42 };

  const page = (count: number, matchAt = -1) => Array.from({ length: count }, (_, i) => JSON.stringify({
    id: 1000 + i,
    body: i === matchAt ? 'ANCHORED' : 'ordinary comment',
    user: { login: 'github-actions[bot]' },
  })).join('\n');

  it('stops requesting pages once it has a match', () => {
    const requested: string[] = [];
    const commandRunner = (_exe: string, args: string[]) => {
      requested.push(args[1]);
      return { status: 0, stdout: page(100, 3), stderr: '' };
    };

    const match = findLatestIssueComment(commandRunner, context, (comment: any) => comment.body === 'ANCHORED');

    expect(match).toMatchObject({ body: 'ANCHORED' });
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('direction=desc');
  });

  it('stops at a short page rather than asking for one that cannot exist', () => {
    const requested: string[] = [];
    const commandRunner = (_exe: string, args: string[]) => {
      requested.push(args[1]);
      return { status: 0, stdout: page(12), stderr: '' };
    };

    expect(findLatestIssueComment(commandRunner, context, () => false)).toBeNull();
    expect(requested).toHaveLength(1);
  });

  it('gives up after a bounded number of full pages', () => {
    const requested: string[] = [];
    const commandRunner = (_exe: string, args: string[]) => {
      requested.push(args[1]);
      return { status: 0, stdout: page(100), stderr: '' };
    };

    expect(findLatestIssueComment(commandRunner, context, () => false)).toBeNull();
    expect(requested.length).toBeLessThanOrEqual(5);
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('publication guards', () => {
  const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, headSha: 'newhead', baseSha: 'base' };
  const emptyPlan = { lineComments: [], fileComments: [], advisories: [], rejected: [] };
  const explode = () => { throw new Error('must not reach GitHub'); };

  // The third parameter used to be `options`. A caller that missed the change would otherwise lose
  // its injected boundary and shell out to the real gh binary without any error.
  it('rejects an options object passed in the publication-plan position', () => {
    expect(() => postOrOutputComment('body', context, { commandRunner: explode, tempDirectory: '/tmp' } as any))
      .toThrow(/third argument looks like an options object/u);
  });

  it('accepts a plan that is empty, or that carries only plan keys', () => {
    expect(() => postOrOutputComment('body', context, {}, { commandRunner: () => ({ status: 1, stdout: '', stderr: 'stop' }) })).not.toThrow();
    expect(() => postOrOutputComment('body', context, emptyPlan, { commandRunner: () => ({ status: 1, stdout: '', stderr: 'stop' }) })).not.toThrow();
  });

  it.each([['empty', ''], ['whitespace only', '   \n\t  ']])('refuses to publish a %s review body, without calling GitHub', (_label, body) => {
    const result = postOrOutputComment(body, context, emptyPlan, { commandRunner: explode });

    expect(result).toMatchObject({ success: false, postedViaGh: false });
    expect(result.error).toBeTruthy();
  });

  // The complement of the two cases above: a real body must get past the guard and reach GitHub.
  it('lets a non-empty body through to GitHub', () => {
    let reached = false;
    const commandRunner = () => {
      reached = true;
      return { status: 1, stdout: '', stderr: 'stop here' };
    };

    postOrOutputComment('a real summary', context, emptyPlan, { commandRunner });

    expect(reached).toBe(true);
  });
});

describe('resolving the publishing identity', () => {
  const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, headSha: 'newhead', baseSha: 'base' };
  const anchor = '<!-- review-yeti-bot:summary:v1:review-yeti-ai/review-yeti-bot#42 -->';

  // Installation tokens cannot call GET /user, so App-identity runs resolve through
  // `gh api installation --jq .app_slug` and must end up comparing against `<slug>[bot]`.
  function installationRunner(seedComments: any[], appSlug: string) {
    const state = { comments: [...seedComments], posted: [] as any[], nextId: 800 };
    const commandRunner = (_exe: string, args: string[], commandOptions: any) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ headRefOid: 'newhead', baseRefOid: 'base' }), stderr: '' };
      }
      if (args[0] === 'api' && args[1] === 'user') return { status: 1, stdout: '', stderr: 'Resource not accessible by integration' };
      if (args[0] === 'api' && args[1] === 'installation') return { status: 0, stdout: `${appSlug}\n`, stderr: '' };
      if (args[0] === 'api' && String(args[1]).includes('/issues/42/comments') && !args.includes('--method')) {
        return { status: 0, stdout: state.comments.map((comment) => JSON.stringify(comment)).join('\n'), stderr: '' };
      }
      if (args[0] === 'api' && args.includes('--method')) {
        const method = args[args.indexOf('--method') + 1];
        const endpoint = args[3];
        state.posted.push({ method, endpoint, payload: JSON.parse(commandOptions.input) });
        const patched = method === 'PATCH' ? state.comments.find((comment) => endpoint.endsWith(`/${comment.id}`)) : null;
        state.nextId += 1;
        return { status: 0, stdout: JSON.stringify({ id: patched ? patched.id : state.nextId }), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
    };
    return { state, commandRunner };
  }

  it('adopts its own comment when the App slug already carries the [bot] suffix', () => {
    const own = { id: 8001, body: `earlier round ${anchor}`, user: { login: 'review-yeti[bot]' } };
    const { state, commandRunner } = installationRunner([own], 'review-yeti[bot]');

    const result = postStickySummaryComment('later round', context, { commandRunner, existingReviews: [] });

    expect(result).toMatchObject({ success: true, updatedInPlace: true, commentId: 8001 });
    expect(state.posted.filter((post) => post.method === 'PATCH')).toHaveLength(1);
  });

  // The regression this pins: dropping the suffix would compare 'review-yeti' against
  // 'review-yeti[bot]' and fail closed on every App-identity run.
  it('adds the [bot] suffix when the App slug arrives without one', () => {
    const own = { id: 8002, body: `earlier round ${anchor}`, user: { login: 'review-yeti[bot]' } };
    const { state, commandRunner } = installationRunner([own], 'review-yeti');

    const result = postStickySummaryComment('later round', context, { commandRunner, existingReviews: [] });

    expect(result).toMatchObject({ success: true, updatedInPlace: true, commentId: 8002 });
    expect(state.posted.filter((post) => post.method === 'PATCH')).toHaveLength(1);
  });

  it('does not adopt a comment written by a different App', () => {
    const foreign = { id: 8003, body: `earlier round ${anchor}`, user: { login: 'some-other-app[bot]' } };
    const { state, commandRunner } = installationRunner([foreign], 'review-yeti');

    const result = postStickySummaryComment('later round', context, { commandRunner, existingReviews: [] });

    expect(result.success).toBe(true);
    expect(state.posted.every((post) => post.method !== 'PATCH')).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('verified GraphQL publisher identity', () => {
  const context = { repo: 'example-org/example-repo', prNumber: 42, headSha: 'newhead', baseSha: 'base' };
  const body = '## **Verdict: SHIP**\n\n- **Quorum Status**: SATISFIED\n- **Review Status**: SHIP';
  const plan = () => planFindingPublication([{
    displayName: 'Testing',
    findings: [{
      severity: 'P2' as const, path: 'src/alpha.ts', line: 4,
      title: 'Missing regression for the changed publisher identity',
      body: 'A custom App identity must be covered before accepting publication.',
    }],
  }], [{ path: 'src/alpha.ts', patch: '@@ -0,0 +1,5 @@\n+a\n+b\n+c\n+d\n+e' }]);

  function runner(options: {
    restUser?: string; installation?: string; viewer?: unknown; viewerRaw?: string;
    viewerStatus?: number; createdAuthor?: unknown; threadAuthor?: string;
    staleReadback?: boolean; foreignMarkers?: boolean;
  } = {}) {
    const item = plan().lineComments[0];
    const state = { calls: [] as any[], writes: [] as any[], comments: [] as any[], threads: [] as any[], nextId: 100 };
    function thread(id: number, payload: any, author: unknown) {
      return {
        id: 'thread-' + id, isResolved: false, isOutdated: false,
        path: payload.path, line: payload.line, diffSide: 'RIGHT', startLine: null,
        comments: {
          nodes: [{
            databaseId: id, body: payload.body, author: { login: author },
            commit: { oid: options.staleReadback ? 'oldhead' : 'newhead' },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    }
    if (options.foreignMarkers) {
      state.comments.push({
        id: 1, body: renderStickySummaryBody(body, context, null).body,
        user: { login: 'foreign-app[bot]' },
      });
      state.threads.push(thread(2, {
        path: item.path, line: item.line,
        body: item.body + '\n\n<!-- review-yeti-bot:finding:v1:newhead:' + item.markerKey + ' -->',
      }, 'foreign-app'));
    }
    const commandRunner = (_exe: string, args: string[], commandOptions: any) => {
      state.calls.push({ args, token: commandOptions.env.GH_TOKEN });
      const ok = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
      if (args[0] === 'pr') return ok({ headRefOid: 'newhead', baseRefOid: 'base' });
      if (args[1] === 'user' || args[1] === 'installation') {
        const output = args[1] === 'user' ? options.restUser : options.installation;
        return output === undefined
          ? { status: 1, stdout: '', stderr: 'Resource not accessible by integration' }
          : { status: 0, stdout: output, stderr: '' };
      }
      if (args[1] === 'graphql') {
        if (args.some(arg => arg.includes('query ReviewYetiPublisher'))) {
          return {
            status: options.viewerStatus ?? 0,
            stdout: options.viewerRaw ?? JSON.stringify({ data: { viewer: { login: options.viewer === undefined ? 'custom-review-app' : options.viewer } } }),
            stderr: '',
          };
        }
        if (isReviewListQuery(args)) return { status: 0, stdout: reviewListPage([]), stderr: '' };
        return ok({ data: { repository: { pullRequest: {
          reviewThreads: { nodes: state.threads, pageInfo: { hasNextPage: false, endCursor: null } },
        } } } });
      }
      if (args.includes('--method')) {
        const endpoint = args[3];
        const payload = JSON.parse(commandOptions.input);
        const author = Object.hasOwn(options, 'createdAuthor') ? options.createdAuthor : 'custom-review-app[bot]';
        state.writes.push({ endpoint, payload, method: args[args.indexOf('--method') + 1] });
        const id = ++state.nextId;
        if (endpoint.endsWith('/pulls/42/comments')) {
          state.threads.push(thread(id, payload, options.threadAuthor ?? 'custom-review-app'));
        } else if (endpoint.endsWith('/issues/42/comments')) {
          state.comments.push({ id, body: payload.body, user: { login: author } });
        }
        return ok({ id, body: payload.body, user: { login: author } });
      }
      if (args[1].includes('/issues/42/comments')) return ok(state.comments);
      return { status: 1, stdout: '', stderr: 'unexpected mock request' };
    };
    return { state, commandRunner };
  }

  afterEach(() => vi.unstubAllEnvs());

  it.each(['custom-review-app', 'custom-review-app[bot]', 'Custom-Review-App'])(
    'publishes a P2 thread and exact-head summary as verified viewer %s', (viewer) => {
      vi.stubEnv('GH_TOKEN', 'fixture-installation-token');
      const { state, commandRunner } = runner({ viewer });
      expect(plan().lineComments).toHaveLength(1);
      expect(postOrOutputComment(body, context, plan(), { commandRunner })).toMatchObject({
        success: true, postedViaGh: true, threadIds: ['thread-101'],
      });
      expect(state.writes).toHaveLength(2);
      expect(state.calls.every(call => call.token === 'fixture-installation-token')).toBe(true);
      expect(state.calls.find(call => call.args.some((arg: string) => arg.includes('query ReviewYetiPublisher'))).args)
        .toEqual(['api', 'graphql', '-f', 'query=query ReviewYetiPublisher { viewer { login } }']);
    },
  );

  it('rejects a foreign planted summary and thread instead of adopting their markers', () => {
    const { state, commandRunner } = runner({ foreignMarkers: true });
    expect(postOrOutputComment(body, context, plan(), { commandRunner }).success).toBe(true);
    expect(state.writes).toHaveLength(2);
    expect(state.writes.every(write => write.method === 'POST')).toBe(true);
    expect(state.comments[0].user.login).toBe('foreign-app[bot]');
    expect(state.threads[0].isResolved).toBe(false);
  });

  const invalidLogins = [null, '', 'null', 'undefined', 'true', 'false', 'null[bot]', '"custom-review-app"',
    {}, [], 42, '["custom-review-app"]', '{"login":"custom-review-app"}', 'custom review app', 'custom\nreview-app', '-app', 'app-', 'app[bot][bot]'];
  it.each(invalidLogins.map((viewer, i) => [i, viewer] as const))(
    'invalid GraphQL identity case %s cannot mutate even inside Actions', (_i, viewer) => {
      vi.stubEnv('GITHUB_ACTIONS', 'true');
      const { state, commandRunner } = runner({ viewer });
      expect(postOrOutputComment(body, context, plan(), { commandRunner }).success).toBe(false);
      expect(postStickySummaryComment(body, context, { commandRunner, existingReviews: [] }).success).toBe(false);
      expect(state.writes).toHaveLength(0);
    },
  );

  it.each([
    { viewerStatus: 1 }, { viewerRaw: 'undefined' }, { viewerRaw: 'null' },
    { viewerRaw: '{"data":{"viewer":null}}' },
    { viewerRaw: '{"data":{"viewer":{"login":"custom-review-app"}},"errors":[{"message":"denied"}]}' },
    { viewerRaw: '{"data":{"viewer":{"login":"custom-review-app"}},"errors":{}}' },
  ])('unknown/failed viewer resolution is nonmutating: %j', (options) => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    const { state, commandRunner } = runner(options);
    expect(postOrOutputComment(body, context, plan(), { commandRunner }).success).toBe(false);
    expect(state.writes).toHaveLength(0);
  });

  it.each(['null', 'undefined', '""', '"null"', '{}', '["custom-review-app"]', 'bad login'])(
    'invalid REST scalar %s falls through to verified GraphQL', (invalid) => {
      const { state, commandRunner } = runner({ restUser: invalid, installation: invalid });
      expect(postOrOutputComment(body, context, plan(), { commandRunner }).success).toBe(true);
      expect(state.calls.some(call => call.args.some((arg: string) => arg.includes('query ReviewYetiPublisher')))).toBe(true);
    },
  );

  it.each([
    { restUser: 'custom-review-app[bot]\n' },
    { restUser: '"custom-review-app[bot]"\n' },
    { installation: 'custom-review-app\n' },
  ])('keeps valid REST identity precedence: %j', (options) => {
    const { state, commandRunner } = runner({ ...options, viewerStatus: 1 });
    expect(postOrOutputComment(body, context, plan(), { commandRunner }).success).toBe(true);
    expect(state.calls.some(call => call.args.some((arg: string) => arg.includes('query ReviewYetiPublisher')))).toBe(false);
  });

  it.each(['foreign-app[bot]', 'github-actions[bot]', null, 'null', '', {}])(
    'rejects actual write-author drift or missing author %j', (createdAuthor) => {
      const { state, commandRunner } = runner({ createdAuthor });
      expect(postOrOutputComment(body, context, plan(), { commandRunner }).success).toBe(false);
      expect(state.writes).toHaveLength(1);
      expect(state.comments).toHaveLength(0);
    },
  );

  it.each([{ staleReadback: true }, { threadAuthor: 'foreign-app' }])(
    'retains exact-head and readback-author guards: %j', (options) => {
      const { state, commandRunner } = runner(options);
      expect(postOrOutputComment(body, context, plan(), { commandRunner }).success).toBe(false);
      expect(state.writes).toHaveLength(1);
      expect(state.comments).toHaveLength(0);
    },
  );
});

describe('repairing a partially published round', () => {
  const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, headSha: 'newhead', baseSha: 'base' };
  const marker = '<!-- review-yeti-bot:v2:review-yeti-ai/review-yeti-bot#42:newhead:action -->';
  const resultMarker = '<!-- review-yeti-bot:result:v1:review-yeti-ai/review-yeti-bot#42:newhead:earlier-attempt -->';

  const hunk = `@@ -0,0 +1,20 @@\n${Array.from({ length: 20 }, (_, i) => `+l${i}`).join('\n')}`;

  // Two line-anchored findings and one that can only be anchored to a file (empty patch).
  const plan = () => planFindingPublication([{
    displayName: 'Security',
    findings: [
      { severity: 'P1' as const, path: 'src/alpha.ts', line: 4, title: 'Tenant id reaches the query builder unvalidated', body: 'The alpha handler interpolates the caller-supplied tenant id straight into the predicate, widening the row set beyond the caller.' },
      { severity: 'P1' as const, path: 'src/beta.ts', line: 4, title: 'Session token is written to the request log', body: 'The beta handler logs the bearer token verbatim on each authenticated request, so log readers can replay a live session.' },
      { severity: 'P0' as const, path: 'config/secrets.yaml', line: 1, title: 'Signing key committed in cleartext', body: 'The session signing key is checked in verbatim, so anyone with repository read access can mint valid sessions.' },
    ],
  }], [
    { path: 'src/alpha.ts', patch: hunk },
    { path: 'src/beta.ts', patch: hunk },
    { path: 'config/secrets.yaml', patch: '' },
  ]);

  const threadFor = (item: any) => ({
    id: `thread-${item.markerKey}`,
    isResolved: false,
    isOutdated: false,
    path: item.path,
    line: Number.isInteger(item.line) ? item.line : null,
    diffSide: item.side || 'RIGHT',
    startLine: item.startLine ?? null,
    startDiffSide: item.startLine != null ? 'RIGHT' : null,
    comments: {
      nodes: [{
        databaseId: 4000,
        body: `${item.body}\n\n<!-- review-yeti-bot:finding:v1:newhead:${item.markerKey} -->`,
        createdAt: '2026-09-06T00:00:00Z',
        author: { login: 'github-actions[bot]' },
        commit: { oid: 'newhead' },
      }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });

  function runner(seedThreads: any[], options: { mirrorWrites?: boolean; freshReview?: boolean; singleLineGraphqlShape?: boolean } = {}) {
    const mirrorWrites = options.mirrorWrites !== false;
    const reviews = [{ id: 777, commit_id: 'newhead', user: { login: 'github-actions[bot]' }, body: `**Verdict: SHIP**\n\n${marker}\n\n${resultMarker}` }];
    const state = { reviews: options.freshReview ? [] : reviews, threads: [...seedThreads], posted: [] as any[], comments: [] as any[], nextId: 5000 };
    const commandRunner = (_exe: string, args: string[], commandOptions: any) => {
      if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ headRefOid: 'newhead', baseRefOid: 'base' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: 'github-actions[bot]\n', stderr: '' };
      if (args[0] === 'api' && args[1] === 'graphql') {
        if (isReviewListQuery(args)) return { status: 0, stdout: reviewListPage(state.reviews), stderr: '' };
        const threads = options.singleLineGraphqlShape ? state.threads.map(thread => (
          thread.line != null && thread.startLine == null
            ? { ...thread, startLine: thread.line, startDiffSide: null }
            : thread
        )) : state.threads;
        return { status: 0, stdout: JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: threads, pageInfo: { hasNextPage: false, endCursor: null } } } } } }]), stderr: '' };
      }
      if (args[0] === 'api' && String(args[1]).includes('/issues/42/comments') && !args.includes('--method')) {
        return { status: 0, stdout: state.comments.map((comment) => JSON.stringify(comment)).join('\n'), stderr: '' };
      }
      if (args[0] === 'api' && args.includes('--method')) {
        const endpoint = args[3];
        const payload = JSON.parse(commandOptions.input);
        state.posted.push({ method: args[args.indexOf('--method') + 1], endpoint, payload });
        state.nextId += 1;
        if (endpoint.endsWith('/issues/42/comments')) state.comments.push({ id: state.nextId, body: payload.body, user: { login: 'github-actions[bot]' } });
        if (mirrorWrites && endpoint.endsWith('/pulls/42/reviews')) {
          state.reviews.push({ id: state.nextId, commit_id: payload.commit_id, body: payload.body, user: { login: 'github-actions[bot]' } });
          state.threads.push(...payload.comments.map((comment: any) => ({
            id: `thread-${comment.path}`, isResolved: false, path: comment.path, line: comment.line,
            startLine: comment.start_line ?? null, startDiffSide: comment.start_side ?? null,
            diffSide: comment.side,
            comments: { nodes: [{ body: comment.body, author: { login: 'github-actions[bot]' }, commit: { oid: 'newhead' } }] },
          })));
        }
        if (mirrorWrites && endpoint.endsWith('/pulls/42/comments')) {
          state.threads.push({
            id: `thread-created-${state.nextId}`,
            isResolved: false,
            path: payload.path,
            line: payload.line ?? null,
            diffSide: payload.side || 'RIGHT',
            startLine: payload.start_line ?? null,
            startDiffSide: payload.start_side ?? null,
            comments: { nodes: [{ databaseId: state.nextId, body: payload.body, createdAt: '2026-09-06T00:00:00Z', author: { login: 'github-actions[bot]' }, commit: { oid: 'newhead' } }], pageInfo: { hasNextPage: false, endCursor: null } },
          });
        }
        return { status: 0, stdout: JSON.stringify({ id: state.nextId, user: { login: 'github-actions[bot]' } }), stderr: '' };
      }
      if (args[0] === 'api' && String(args[1]).includes('/pulls/42/reviews')) return { status: 0, stdout: JSON.stringify([state.reviews]), stderr: '' };
      return { status: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
    };
    return { state, commandRunner };
  }

  it.each([true, false])('publishes generated replacements with exact GitHub ranges (fresh review=%s)', (freshReview) => {
    const files = [
      { path: 'src/alpha.ts', patch: hunk }, { path: 'src/beta.ts', patch: hunk },
      { path: 'src/delete.ts', patch: hunk }, { path: 'src/fallback.ts', patch: '' },
    ];
    const generated = pipeline.sanitizeFindings([
      { severity: 'P1', path: 'src/alpha.ts', line: 4, startLine: null, title: 'Scope tenant query', body: 'Caller input bypasses tenant filtering.', replacementCode: '  return scoped;  ' },
      { severity: 'P1', path: 'src/beta.ts', line: 6, startLine: 4, title: 'Validate session before access', body: 'Expired sessions allow access.', replacementCode: '  validate();\n  access();' },
      { severity: 'P1', path: 'src/delete.ts', line: 3, startLine: null, title: 'Remove exposed credential', body: 'A secret is logged.', replacementCode: '' },
      { severity: 'P1', path: 'src/fallback.ts', line: 3, startLine: null, title: 'Restrict account lookup', body: 'Missing scope exposes accounts.', suggestion: 'Scope the lookup.', replacementCode: 'return scoped;' },
    ], files);
    const publicationPlan = planFindingPublication([{ displayName: 'Security', findings: generated }], files);
    const { state, commandRunner } = runner([], { freshReview });
    expect(postOrOutputComment('body', context, publicationPlan, { commandRunner }).success).toBe(true);
    const payloads = state.posted.flatMap((post) => post.endpoint.endsWith('/pulls/42/reviews')
      ? post.payload.comments : post.endpoint.endsWith('/pulls/42/comments') ? [post.payload] : []);
    const single = payloads.find((comment) => comment.path === 'src/alpha.ts');
    expect(single).toMatchObject({ line: 4, side: 'RIGHT' });
    expect(single).not.toHaveProperty('start_line');
    expect(single.body).toContain('```suggestion\n  return scoped;  \n```');
    expect(payloads.find((comment) => comment.path === 'src/beta.ts')).toMatchObject({ line: 6, start_line: 4, start_side: 'RIGHT' });
    expect(payloads.find((comment) => comment.path === 'src/delete.ts').body).toContain('```suggestion\n\n```');
    const fallback = payloads.find((comment) => comment.path === 'src/fallback.ts');
    expect(fallback).toMatchObject({ subject_type: 'file' });
    expect(fallback.body).not.toContain('```suggestion');
    expect(fallback.body).toContain('Scope the lookup.');
  });

  it('publishes more than ten findings including P2 directly as inline conversations', () => {
    const files = Array.from({ length: 16 }, (_, index) => ({ path: `src/check${index}.ts`, patch: hunk }));
    const publicationPlan = capPublicationThreads(planFindingPublication([{ displayName: 'Architecture', findings: files.map(file => ({
      path: file.path, line: 4, severity: 'P2', title: 'Repeated parser leaves validation inconsistent', body: 'This path accepts values rejected by the canonical parser.',
    })) }], files));
    const { state, commandRunner } = runner([]);
    expect(postOrOutputComment('body', context, publicationPlan, { commandRunner }).success).toBe(true);
    const inline = state.posted.filter(post => post.endpoint.endsWith('/pulls/42/comments'));
    expect(inline).toHaveLength(16);
    expect(inline.every(post => post.payload.line === 4 && post.payload.body.includes('P2'))).toBe(true);
    expect(state.posted.some(post => post.endpoint.endsWith('/reviews'))).toBe(false);
  });

  it('verifies newly published single-line comments when GitHub echoes startLine equal to line', () => {
    const { state, commandRunner } = runner([], { singleLineGraphqlShape: true });
    expect(postOrOutputComment('body', context, plan(), { commandRunner }).success).toBe(true);
    expect(state.posted.filter(post => post.endpoint.endsWith('/pulls/42/comments'))).toHaveLength(3);
    expect(state.comments).toHaveLength(1);
  });

  it('reuses single-line comments when GitHub echoes startLine equal to line', () => {
    const publicationPlan = plan();
    const seeded = [...publicationPlan.lineComments, ...publicationPlan.fileComments].map(threadFor);
    const { state, commandRunner } = runner(seeded, { singleLineGraphqlShape: true });
    expect(postOrOutputComment('body', context, publicationPlan, { commandRunner }).success).toBe(true);
    expect(state.posted.filter(post => post.endpoint.endsWith('/pulls/42/comments'))).toHaveLength(0);
  });

  it('repairs a matching marked thread whose replacement range is wrong', () => {
    const publicationPlan = planFindingPublication([{ displayName: 'Security', findings: [{
      severity: 'P1', path: 'src/alpha.ts', line: 6, startLine: 4,
      title: 'Scope tenant access', body: 'Tenant input bypasses access controls.', replacementCode: '  scoped();',
    }] }], [{ path: 'src/alpha.ts', patch: hunk }]);
    const wrongRange = { ...threadFor(publicationPlan.lineComments[0]), startLine: 5 };
    const { state, commandRunner } = runner([wrongRange]);
    expect(postOrOutputComment('body', context, publicationPlan, { commandRunner }).success).toBe(true);
    expect(state.posted.filter((post) => post.endpoint.endsWith('/pulls/42/comments'))).toHaveLength(1);
    expect(state.posted.find((post) => post.endpoint.endsWith('/pulls/42/comments')).payload.start_line).toBe(4);
  });

  it('creates only the conversations the prior round did not manage to open', () => {
    const publicationPlan = plan();
    const already = publicationPlan.lineComments[0];
    const { state, commandRunner } = runner([threadFor(already)]);

    const result = postOrOutputComment('body', context, publicationPlan, { commandRunner });

    expect(result.success).toBe(true);
    // The terminal receipt for this head is reused, not re-posted.
    expect(state.posted.filter((post) => post.endpoint.endsWith('/pulls/42/reviews'))).toHaveLength(0);

    const created = state.posted.filter((post) => post.endpoint.endsWith('/pulls/42/comments'));
    expect(created).toHaveLength(2);
    expect(created.map((post) => post.payload.path).sort()).toEqual(['config/secrets.yaml', 'src/beta.ts']);
    expect(created.every((post) => post.payload.commit_id === 'newhead')).toBe(true);
    // The already-published conversation is not opened a second time.
    expect(created.some((post) => post.payload.path === already.path)).toBe(false);
  });

  it('opens the unanchorable finding as a file conversation', () => {
    const publicationPlan = plan();
    const { state, commandRunner } = runner([]);

    postOrOutputComment('body', context, publicationPlan, { commandRunner });

    const fileComment = state.posted.find((post) => post.endpoint.endsWith('/pulls/42/comments') && post.payload.path === 'config/secrets.yaml');
    expect(fileComment.payload.subject_type).toBe('file');
    expect(fileComment.payload.line).toBeUndefined();
  });

  it('does not report a repair round as deduplicated', () => {
    const publicationPlan = plan();
    const { commandRunner } = runner([threadFor(publicationPlan.lineComments[0])]);

    expect(postOrOutputComment('body', context, publicationPlan, { commandRunner }).deduplicated).toBeUndefined();
  });

  it('reports deduplicated when both the overview and every conversation were already published', () => {
    const publicationPlan = plan();
    const seeded = [...publicationPlan.lineComments, ...publicationPlan.fileComments].map(threadFor);
    const { state, commandRunner } = runner(seeded);

    expect(postOrOutputComment('body', context, publicationPlan, { commandRunner }).success).toBe(true);
    const result = postOrOutputComment('body', context, publicationPlan, { commandRunner });

    expect(result).toMatchObject({ success: true, deduplicated: true });
    expect(state.posted.filter((post) => post.endpoint.endsWith('/pulls/42/comments'))).toHaveLength(0);
  });

  // Distinct from the review-readback failure: here the review is visible but a conversation the
  // run just wrote is not, so the round cannot claim the findings were published.
  it('fails closed when a written conversation is not visible afterwards', () => {
    const publicationPlan = plan();
    const { state, commandRunner } = runner([], { mirrorWrites: false });

    const result = postOrOutputComment('body', context, publicationPlan, { commandRunner });

    expect(result).toMatchObject({ success: false, postedViaGh: false });
    expect(result.error).toContain('failed exact-head verification');
    expect(state.comments).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('replacing previous overview contents', () => {
  const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, headSha: 'newhead' };
  it('discards old round bodies and collapsed history', () => {
    const first = renderStickySummaryBody('old verdict', context, '', { publicationAttemptId: 'old' });
    const next = renderStickySummaryBody('current verdict', context, `${first.body}\n<!-- review-yeti-bot:summary-history:v1:start -->\nold historical detail\n<!-- review-yeti-bot:summary-history:v1:end -->`, { publicationAttemptId: 'new' });
    expect(next.body).toContain('current verdict');
    expect(next.body).not.toContain('old verdict');
    expect(next.body).not.toContain('old historical detail');
    expect(next.historyRounds).toBe(0);
  });
  it('stays below the GitHub comment size limit', () => {
    expect(renderStickySummaryBody('x'.repeat(100_000), context, '').body.length).toBeLessThanOrEqual(MAX_STICKY_COMMENT_CHARS);
  });
});

describe('reading the existing reviews', () => {
  const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, headSha: 'newhead', baseSha: 'base' };

  // A pull request accumulates one review per pushed head for its whole life and this is read
  // twice per publish, so the request has to be bounded. The REST list is oldest-first with no
  // direction parameter, which is why capping it there would drop the entries actually needed.
  it('asks for a bounded window from the newest end', () => {
    const seen: string[][] = [];
    const commandRunner = (_exe: string, args: string[]) => {
      seen.push(args);
      return { status: 0, stdout: reviewListPage([]), stderr: '' };
    };

    readActionReviews(commandRunner, context);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('graphql');
    expect(seen[0].some((arg) => arg === `last=${MAX_READ_ACTION_REVIEWS}`)).toBe(true);
    expect(seen[0].every((arg) => !arg.includes('--paginate'))).toBe(true);
  });

  it('maps the connection onto the shape the publisher consumes', () => {
    const commandRunner = () => ({
      status: 0,
      stdout: reviewListPage([
        { id: 11, body: 'first', commit_id: 'abc', submitted_at: '2026-09-06T00:00:00Z', user: { login: 'github-actions[bot]' } },
        { id: 12, body: 'second', commit_id: 'def', submitted_at: '2026-09-06T01:00:00Z', user: { login: 'github-actions[bot]' } },
      ]),
      stderr: '',
    });

    expect(readActionReviews(commandRunner, context)).toEqual([
      { id: 11, body: 'first', commit_id: 'abc', submitted_at: '2026-09-06T00:00:00Z', user: { login: 'github-actions[bot]' } },
      { id: 12, body: 'second', commit_id: 'def', submitted_at: '2026-09-06T01:00:00Z', user: { login: 'github-actions[bot]' } },
    ]);
  });

  it('fails rather than reporting no reviews when GitHub errors', () => {
    const failed = () => ({ status: 1, stdout: '', stderr: 'Bad credentials' });
    expect(() => readActionReviews(failed, context)).toThrow('Bad credentials');

    const graphError = () => ({ status: 0, stdout: JSON.stringify({ errors: [{ message: 'Resource not accessible' }] }), stderr: '' });
    expect(() => readActionReviews(graphError, context)).toThrow('Resource not accessible');

    const malformed = () => ({ status: 0, stdout: 'not json', stderr: '' });
    expect(() => readActionReviews(malformed, context)).toThrow(/malformed/u);
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('findings GitHub cannot anchor', () => {
  const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, headSha: 'newhead', baseSha: 'base' };

  function runner() {
    const state = { reviews: [] as any[], comments: [] as any[], threads: [] as any[], posted: [] as any[], nextId: 300 };
    const commandRunner = (_exe: string, args: string[], commandOptions: any) => {
      if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ headRefOid: 'newhead', baseRefOid: 'base' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: 'github-actions[bot]\n', stderr: '' };
      if (args[0] === 'api' && args[1] === 'graphql') {
        if (isReviewListQuery(args)) return { status: 0, stdout: reviewListPage(state.reviews), stderr: '' };
        return { status: 0, stdout: JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: state.threads } } } } }]), stderr: '' };
      }
      if (args[0] === 'api' && String(args[1]).includes('/issues/42/comments') && !args.includes('--method')) {
        return { status: 0, stdout: state.comments.map((comment) => JSON.stringify(comment)).join('\n'), stderr: '' };
      }
      if (args[0] === 'api' && args.includes('--method')) {
        const endpoint = args[3];
        const payload = JSON.parse(commandOptions.input);
        state.posted.push({ endpoint, payload });
        state.nextId += 1;
        if (endpoint.endsWith('/issues/42/comments')) state.comments.push({ id: state.nextId, body: payload.body, user: { login: 'github-actions[bot]' } });
        if (endpoint.endsWith('/reviews')) state.reviews.push({ id: state.nextId, body: payload.body, commit_id: payload.commit_id, user: { login: 'github-actions[bot]' } });
        return { status: 0, stdout: JSON.stringify({ id: state.nextId, user: { login: 'github-actions[bot]' } }), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
    };
    return { state, commandRunner };
  }

  const rejected = (severity: string, reason: string) => ({
    path: 'src/handler.ts',
    line: 4200,
    side: 'RIGHT',
    severity,
    title: 'Tenant check is missing on the cancel path',
    reason,
  });

  // A finding is never moved to a nearby line to make it publishable, so an unanchorable P0/P1
  // would vanish entirely if the summary did not name it.
  it('names actionable findings it could not anchor, in the sticky summary', () => {
    const { state, commandRunner } = runner();
    const plan = {
      lineComments: [], fileComments: [], advisories: [],
      rejected: [rejected('P0', 'finding line is not an exact changed RIGHT line')],
    };

    expect(postOrOutputComment('## **Verdict: BLOCK**', context, plan, { commandRunner }).success).toBe(true);

    const sticky = state.comments[0].body;
    expect(sticky).toContain('Actionable findings without publishable anchors');
    expect(sticky).toContain('src/handler.ts:4200');
    expect(sticky).toContain('finding line is not an exact changed RIGHT line');
    expect(sticky).toContain('they require manual review at the stated path/location');
  });

  it('retains unanchorable P2 findings as a named fallback too', () => {
    const { state, commandRunner } = runner();
    const plan = { lineComments: [], fileComments: [], advisories: [], rejected: [rejected('P2', 'nit')] };

    postOrOutputComment('summary body', context, plan, { commandRunner });

    expect(state.comments[0].body).toContain('Actionable findings without publishable anchors');
    expect(state.comments[0].body).toContain('**P2**');
  });

  it('never creates a root verdict review for an unanchorable finding', () => {
    const { state, commandRunner } = runner();
    const plan = { lineComments: [], fileComments: [], advisories: [], rejected: [rejected('P1', 'unresolvable')] };

    postOrOutputComment('summary body', context, plan, { commandRunner });

    expect(state.reviews).toHaveLength(0);
    expect(state.posted.some(post => post.endpoint.endsWith('/reviews'))).toBe(false);
  });
});

describe('identifying one publication attempt', () => {
  const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, headSha: 'newhead', baseSha: 'base' };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const resultMarkerIn = (body: string) => body.match(/<!-- review-yeti-bot:result:v1:[^>]*-->/u)?.[0] || '';

  const publish = () => {
    const state = { reviews: [] as any[], comments: [] as any[], posted: [] as any[], nextId: 200 };
    const commandRunner = (_exe: string, args: string[], commandOptions: any) => {
      if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ headRefOid: 'newhead', baseRefOid: 'base' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: 'github-actions[bot]\n', stderr: '' };
      if (args[0] === 'api' && args[1] === 'graphql') {
        if (isReviewListQuery(args)) return { status: 0, stdout: reviewListPage(state.reviews), stderr: '' };
        return { status: 0, stdout: JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }]), stderr: '' };
      }
      if (args[0] === 'api' && String(args[1]).includes('/issues/42/comments') && !args.includes('--method')) {
        return { status: 0, stdout: state.comments.map((comment) => JSON.stringify(comment)).join('\n'), stderr: '' };
      }
      if (args[0] === 'api' && args.includes('--method')) {
        const endpoint = args[3];
        const payload = JSON.parse(commandOptions.input);
        state.nextId += 1;
        if (endpoint.endsWith('/issues/42/comments')) state.comments.push({ id: state.nextId, body: payload.body, user: { login: 'github-actions[bot]' } });
        if (endpoint.endsWith('/reviews')) state.reviews.push({ id: state.nextId, body: payload.body, commit_id: payload.commit_id, user: { login: 'github-actions[bot]' } });
        return { status: 0, stdout: JSON.stringify({ id: state.nextId, user: { login: 'github-actions[bot]' } }), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
    };
    postOrOutputComment('summary body', context, { lineComments: [], fileComments: [], advisories: [], rejected: [] }, { commandRunner });
    return resultMarkerIn(state.comments[0].body);
  };

  // GitHub keeps GITHUB_RUN_ID stable across a re-run and only increments GITHUB_RUN_ATTEMPT, so
  // the durable result has to be bound to both or a previous attempt satisfies this attempt's
  // post-write readback.
  it('binds the result to the run and the attempt on a hosted run', () => {
    vi.stubEnv('GITHUB_RUN_ID', '12345');
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '2');

    expect(publish()).toContain('12345:attempt-2');
  });

  it('distinguishes a re-run of the same run id', () => {
    vi.stubEnv('GITHUB_RUN_ID', '12345');
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '1');
    const first = publish();

    vi.stubEnv('GITHUB_RUN_ATTEMPT', '3');
    const rerun = publish();

    expect(first).toContain('12345:attempt-1');
    expect(rerun).toContain('12345:attempt-3');
    expect(rerun).not.toBe(first);
  });

  it('marks an unusable attempt number rather than trusting it', () => {
    vi.stubEnv('GITHUB_RUN_ID', '12345');
    vi.stubEnv('GITHUB_RUN_ATTEMPT', 'not-a-number');

    expect(publish()).toContain('12345:attempt-unknown');
  });

  it('falls back to a content-derived id when there is no run identity', () => {
    vi.stubEnv('GITHUB_RUN_ID', '');
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '');

    expect(publish()).toMatch(/:body-[0-9a-f]{16} -->/u);
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('a publication failure must not discard a computed verdict', () => {
  // Structural rather than end-to-end: main() needs the full review pipeline to run,
  // but the regression is purely an ordering one, so ordering is what this pins.
  const source = readFileSync(
    resolve(__dirname, '../../.github/workflows/pipelines/review-pipeline.js'),
    'utf8',
  );

  it('writes the step outputs before acting on the publication result', () => {
    const publish = source.indexOf('const publication = postOrOutputComment(');
    const outputs = source.indexOf('writeStepOutputs(arbitration, process.env.GITHUB_OUTPUT', publish);
    const failureBranch = source.indexOf('if (!publication.success) {', publish);

    expect(publish).toBeGreaterThan(-1);
    expect(outputs).toBeGreaterThan(-1);
    expect(failureBranch).toBeGreaterThan(-1);

    // The verdict is computed work; publication is delivery. When these were
    // reversed, a failed publication returned before GITHUB_OUTPUT was written, so
    // a consuming gate reported "did not produce a verdict" over a run whose own
    // log said SHIP. Every consumer was blocked by an undeliverable comment.
    expect(outputs).toBeLessThan(failureBranch);
  });

  it('has no early exit between computing the verdict and writing the outputs', () => {
    // Stronger than the ordering assertion above, which only pins two markers and
    // would not notice a NEW return inserted between them. This enumerates the
    // window itself: any `return`, `process.exit` or bare `throw` reached after the
    // verdict is computed but before it is written leaves a consumer observing a
    // missing verdict for a decision that was actually made -- the exact shape of
    // the outage this fix addressed.
    const lines = source.split('\n');
    const outputs = lines.findIndex((l) => l.includes('writeStepOutputs(arbitration, process.env.GITHUB_OUTPUT'));
    expect(outputs).toBeGreaterThan(-1);

    // Walk back to where the arbitration this write publishes was produced.
    let compute = -1;
    for (let i = outputs; i >= 0; i -= 1) {
      if (/\barbitration\s*=/.test(lines[i])) { compute = i; break; }
    }
    expect(compute).toBeGreaterThan(-1);

    // Comments are stripped first: the explanatory comment in this very window
    // contains the word "return" and would otherwise match. And the pattern is
    // deliberately not anchored -- `if (cond) return;` is the common shape and an
    // anchored `^return` misses it, which an earlier draft of this test proved by
    // staying green against an injected early return.
    const exits = lines
      .slice(compute, outputs)
      .map((line, offset) => ({ line: line.replace(/\/\/.*$/, '').trim(), at: compute + offset + 1 }))
      .filter(({ line }) => /\breturn\b|process\.exit\(|\bthrow new Error/.test(line));

    expect(exits, `early exit(s) between verdict computation and output write: ${JSON.stringify(exits)}`)
      .toEqual([]);
  });

  it('still fails the run when publication fails', () => {
    const failureBranch = source.indexOf('if (!publication.success) {');
    const block = source.slice(failureBranch, failureBranch + 900);

    // Emitting the verdict must not soften the outcome: an unpublished review is
    // not visible on the pull request and the run has to say so.
    expect(block).toContain('process.exitCode = 1');
  });
});

describe('the publisher must stay the same identity throughout', () => {
  const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, headSha: 'newhead', baseSha: 'base' };
  const emptyPlan = { lineComments: [], fileComments: [], advisories: [], rejected: [] };

  const hunk = `@@ -0,0 +1,20 @@\n${Array.from({ length: 20 }, (_, i) => `+l${i}`).join('\n')}`;
  const onePlan = () => planFindingPublication([{
    displayName: 'Security',
    findings: [{ severity: 'P1' as const, path: 'src/alpha.ts', line: 4, title: 'Tenant id reaches the query builder unvalidated', body: 'The handler interpolates the caller-supplied tenant id into the predicate, widening the row set beyond the caller.' }],
  }], [{ path: 'src/alpha.ts', patch: hunk }]);

  // The authenticated identity is read before writing; if what GitHub attributes the write to is
  // someone else, the run cannot claim it published this review.
  function runner(options: { reviewAuthor?: string; commentAuthor?: string; seedReview?: boolean; unidentifiedToken?: boolean } = {}) {
    const state = { reviews: [] as any[], comments: [] as any[], threads: [] as any[], nextId: 100 };
    if (options.seedReview) {
      state.reviews.push({
        id: 99,
        commit_id: 'newhead',
        user: { login: 'github-actions[bot]' },
        body: '**Verdict: SHIP**\n\n<!-- review-yeti-bot:v2:review-yeti-ai/review-yeti-bot#42:newhead:action -->\n\n<!-- review-yeti-bot:result:v1:review-yeti-ai/review-yeti-bot#42:newhead:earlier -->',
      });
    }
    const commandRunner = (_exe: string, args: string[], commandOptions: any) => {
      if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ headRefOid: 'newhead', baseRefOid: 'base' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') {
        // An App installation token cannot call GET /user, and `gh api installation` is not
        // stubbed here either, so resolution falls through to the GITHUB_ACTIONS assumption.
        if (options.unidentifiedToken) return { status: 1, stdout: '', stderr: 'Resource not accessible by integration' };
        return { status: 0, stdout: 'github-actions[bot]\n', stderr: '' };
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        if (isReviewListQuery(args)) return { status: 0, stdout: reviewListPage(state.reviews), stderr: '' };
        return { status: 0, stdout: JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: state.threads } } } } }]), stderr: '' };
      }
      if (args[0] === 'api' && String(args[1]).includes('/issues/42/comments') && !args.includes('--method')) {
        return { status: 0, stdout: state.comments.map((comment) => JSON.stringify(comment)).join('\n'), stderr: '' };
      }
      if (args[0] === 'api' && args.includes('--method')) {
        const endpoint = args[3];
        const payload = JSON.parse(commandOptions.input);
        state.nextId += 1;
        // `??` not `||`: an empty login is a distinct case (GitHub named no publisher) and must
        // not fall back to the expected identity.
        const author = endpoint.endsWith('/reviews')
          ? (options.reviewAuthor ?? 'github-actions[bot]')
          : endpoint.endsWith('/pulls/42/comments')
            ? (options.commentAuthor ?? 'github-actions[bot]')
            : 'github-actions[bot]';
        if (endpoint.endsWith('/reviews')) state.reviews.push({ id: state.nextId, body: payload.body, commit_id: payload.commit_id, user: { login: author } });
        if (endpoint.endsWith('/issues/42/comments')) state.comments.push({ id: state.nextId, body: payload.body, user: { login: author } });
        return { status: 0, stdout: JSON.stringify({ id: state.nextId, user: { login: author } }), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
    };
    return { state, commandRunner };
  }

  it('publishes normally when the write is attributed to the expected identity', () => {
    const { commandRunner } = runner();

    expect(postOrOutputComment('body', context, emptyPlan, { commandRunner })).toMatchObject({ success: true });
  });

  it('refuses when a conversation is created under a different identity mid-publication', () => {
    const { commandRunner } = runner({ commentAuthor: 'someone-else', seedReview: true });

    const result = postOrOutputComment('body', context, onePlan(), { commandRunner });

    expect(result).toMatchObject({ success: false, postedViaGh: false });
    expect(result.error).toContain('publisher changed during publication');
  });


});

describe('decoding an issue-comment page', () => {
  const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42 };

  const comment = (i: number, body: string) => ({ id: 900 + i, body, user: { login: 'github-actions[bot]' } });

  // gh emits one JSON object per line for this jq projection, but a top-level array is also
  // accepted. Only the line form was covered.
  it('finds the match when the page arrives as a JSON array', () => {
    const commandRunner = () => ({
      status: 0,
      stdout: JSON.stringify([comment(0, 'ordinary'), comment(1, 'ANCHORED'), comment(2, 'ordinary')]),
      stderr: '',
    });

    expect(findLatestIssueComment(commandRunner, context, (entry: any) => entry.body === 'ANCHORED'))
      .toMatchObject({ id: 901, body: 'ANCHORED' });
  });

  it('still bounds paging for the array shape', () => {
    const requested: string[] = [];
    const full = JSON.stringify(Array.from({ length: 100 }, (_, i) => comment(i, 'ordinary')));
    const commandRunner = (_exe: string, args: string[]) => {
      requested.push(args[1]);
      return { status: 0, stdout: full, stderr: '' };
    };

    expect(findLatestIssueComment(commandRunner, context, () => false)).toBeNull();
    expect(requested.length).toBeLessThanOrEqual(5);
  });

  it('treats an empty page as no match rather than throwing', () => {
    expect(findLatestIssueComment(() => ({ status: 0, stdout: '', stderr: '' }), context, () => true)).toBeNull();
    expect(findLatestIssueComment(() => ({ status: 0, stdout: '[]', stderr: '' }), context, () => true)).toBeNull();
  });

  it('fails loudly on a malformed page instead of reporting no match', () => {
    expect(() => findLatestIssueComment(() => ({ status: 0, stdout: '{oops', stderr: '' }), context, () => true))
      .toThrow(/malformed/u);
    expect(() => findLatestIssueComment(() => ({ status: 1, stdout: '', stderr: 'Bad credentials' }), context, () => true))
      .toThrow('Bad credentials');
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('tidying conversations whose code no longer exists', () => {
  const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, headSha: 'newhead', baseSha: 'base' };

  const thread = (id: string, overrides: any = {}) => ({
    id,
    isResolved: false,
    isOutdated: false,
    path: `src/${id}.ts`,
    line: 4,
    comments: { nodes: [{ databaseId: 1, body: 'finding', author: { login: 'github-actions[bot]' }, commit: { oid: 'old' } }], pageInfo: { hasNextPage: false } },
    ...overrides,
  });

  const byHuman = (id: string, overrides: any = {}) => thread(id, {
    comments: { nodes: [{ databaseId: 2, body: 'human note', author: { login: 'a-maintainer' } }], pageInfo: { hasNextPage: false } },
    ...overrides,
  });

  function runner(threads: any[], options: { failResolve?: boolean } = {}) {
    const resolved: string[] = [];
    const commandRunner = (_exe: string, args: string[]) => {
      if (args.some((arg) => arg.includes('mutation ResolveThread'))) {
        const id = args[args.indexOf('-F') + 1].replace('threadId=', '');
        if (options.failResolve) return { status: 1, stdout: '', stderr: 'Resource not accessible' };
        resolved.push(id);
        return { status: 0, stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected' };
    };
    return { resolved, commandRunner, snapshot: { threads, complete: true } };
  }

  it('resolves its own outdated conversations', () => {
    const { resolved, commandRunner, snapshot } = runner([
      thread('stale', { isOutdated: true }),
      thread('current'),
    ]);

    const result = resolveOutdatedOwnThreads(commandRunner, context, { expectedPublisherLogin: 'github-actions[bot]', snapshot });

    expect(result).toMatchObject({ resolved: 1, candidates: 1 });
    expect(resolved).toEqual(['stale']);
  });

  // A still-current thread's finding still stands; closing it would hide a live objection.
  it('leaves a current conversation open', () => {
    const { resolved, commandRunner, snapshot } = runner([thread('current')]);

    expect(resolveOutdatedOwnThreads(commandRunner, context, { expectedPublisherLogin: 'github-actions[bot]', snapshot }))
      .toMatchObject({ resolved: 0 });
    expect(resolved).toEqual([]);
  });

  it("never closes a person's conversation, outdated or not", () => {
    const { resolved, commandRunner, snapshot } = runner([
      byHuman('human-stale', { isOutdated: true }),
      byHuman('human-current'),
    ]);

    expect(resolveOutdatedOwnThreads(commandRunner, context, { expectedPublisherLogin: 'github-actions[bot]', snapshot }))
      .toMatchObject({ resolved: 0 });
    expect(resolved).toEqual([]);
  });

  it('leaves an already-resolved conversation alone', () => {
    const { resolved, commandRunner, snapshot } = runner([thread('done', { isOutdated: true, isResolved: true })]);

    resolveOutdatedOwnThreads(commandRunner, context, { expectedPublisherLogin: 'github-actions[bot]', snapshot });

    expect(resolved).toEqual([]);
  });

  it('does nothing when the publisher identity is unknown', () => {
    const { resolved, commandRunner, snapshot } = runner([thread('stale', { isOutdated: true })]);

    expect(resolveOutdatedOwnThreads(commandRunner, context, { expectedPublisherLogin: null, snapshot }))
      .toMatchObject({ resolved: 0, skipped: 'unknown publisher identity' });
    expect(resolved).toEqual([]);
  });

  // Tidying is an improvement to the review, never a reason to fail one.
  it('reports a failed resolve without throwing', () => {
    const { commandRunner, snapshot } = runner([thread('stale', { isOutdated: true })], { failResolve: true });

    const result = resolveOutdatedOwnThreads(commandRunner, context, { expectedPublisherLogin: 'github-actions[bot]', snapshot });

    expect(result.resolved).toBe(0);
    expect(result.failures?.[0]).toContain('Resource not accessible');
  });

  it('survives the thread snapshot being unreadable', () => {
    const explode = () => { throw new Error('GitHub unavailable'); };

    expect(() => resolveOutdatedOwnThreads(explode, context, { expectedPublisherLogin: 'github-actions[bot]' })).not.toThrow();
    expect(resolveOutdatedOwnThreads(explode, context, { expectedPublisherLogin: 'github-actions[bot]' }).resolved).toBe(0);
  });

  it('bounds how many it will close in one run', () => {
    const many = Array.from({ length: 80 }, (_, i) => thread(`stale-${i}`, { isOutdated: true }));
    const { resolved, commandRunner, snapshot } = runner(many);

    resolveOutdatedOwnThreads(commandRunner, context, { expectedPublisherLogin: 'github-actions[bot]', snapshot });

    expect(resolved.length).toBeLessThanOrEqual(50);
  });
});
