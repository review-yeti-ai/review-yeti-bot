/**
 * Regression cover for the Action's review publication surface.
 *
 * Both behaviours under test here were lost on 2026-08-21 when `2f28719a` grafted a disjoint
 * v5.0.0 lineage over main: the Action fell back to one issue comment per head SHA, with findings
 * reduced to Checks-tab annotations that cannot be resolved. The dedupe cases come from the
 * original comment-volume corpus (example-org/example-app#4821, where 14 full-panel reruns
 * produced 65 inline findings); the publication cases pin the sticky anchor and the exact-head
 * compact review receipt.
 */
import { describe, it, expect } from 'vitest';
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
  MAX_PUBLISHED_REVIEW_THREADS,
  postOrOutputComment,
  postStickySummaryComment,
  renderStickySummaryBody,
  splitStickySummaryBody,
} = pipeline;

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


describe('work item 2 — each reviewed head gets an immutable summary, without duplicate retries', () => {
  const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, headSha: 'newhead', baseSha: 'base' };

  function githubRunner(seedReviews: any[] = [], options: { createdReviewCommitId?: string } = {}) {
    const state = {
      reviews: [...seedReviews],
      comments: [] as Array<{ id: number; body: string; user: { login: string } }>,
      posted: [] as Array<{ method: string; endpoint: string; payload: any }>,
      threads: [] as any[],
      nextId: 500,
    };
    const commandRunner = (_executable: string, args: string[], commandOptions: any) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ headRefOid: context.headSha, baseRefOid: 'base' }), stderr: '' };
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        return { status: 0, stdout: JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: state.threads } } } } }]), stderr: '' };
      }
      if (args[0] === 'api' && args[1] === 'user') {
        return { status: 0, stdout: 'github-actions[bot]\n', stderr: '' };
      }
      if (args[0] === 'api' && String(args[1]).includes('/issues/42/comments') && !args.includes('--method')) {
        return { status: 0, stdout: state.comments.map((comment) => JSON.stringify(comment)).join('\n'), stderr: '' };
      }
      if (args[0] === 'api' && args.includes('--method')) {
        const method = args[args.indexOf('--method') + 1];
        const endpoint = args[3];
        const payload = JSON.parse(commandOptions.input);
        state.posted.push({ method, endpoint, payload });
        state.nextId += 1;
        if (method === 'PATCH') {
          const target = state.comments.find((comment) => endpoint.endsWith(`/${comment.id}`));
          if (target) target.body = payload.body;
          return { status: 0, stdout: JSON.stringify({ id: target?.id, user: { login: 'github-actions[bot]' } }), stderr: '' };
        }
        if (method === 'PUT') {
          const target = state.reviews.find((r) => endpoint.endsWith(`/${r.id}`));
          if (target) target.body = payload.body;
          return { status: 0, stdout: JSON.stringify({ id: target?.id, user: { login: 'github-actions[bot]' } }), stderr: '' };
        }
        if (endpoint.endsWith('/issues/42/comments')) {
          state.comments.push({ id: state.nextId, body: payload.body, user: { login: 'github-actions[bot]' } });
        } else if (endpoint.endsWith('/reviews')) {
          state.reviews.push({
            id: state.nextId,
            body: payload.body,
            commit_id: options.createdReviewCommitId || payload.commit_id,
            user: { login: 'github-actions[bot]' },
          });
        }
        return { status: 0, stdout: JSON.stringify({ id: state.nextId, user: { login: 'github-actions[bot]' } }), stderr: '' };
      }
      if (args[0] === 'api' && String(args[1]).includes('/pulls/42/reviews')) {
        return { status: 0, stdout: JSON.stringify([state.reviews]), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
    };
    return { state, commandRunner };
  }

  const emptyPlan = { lineComments: [], fileComments: [], advisories: [], rejected: [] };

  it('anchors the summary to the pull request, not to the push', () => {
    expect(actionSummaryAnchor(context)).toBe('<!-- review-yeti-bot:summary:v1:review-yeti-ai/review-yeti-bot#42 -->');
    expect(actionSummaryAnchor({ ...context, headSha: 'different' })).toBe(actionSummaryAnchor(context));
  });

  it('posts a compact review receipt and one full sticky summary on the first push', () => {
    const { state, commandRunner } = githubRunner();

    const result = postOrOutputComment('body for head one', context, emptyPlan, { commandRunner });

    expect(result.success).toBe(true);
    expect(state.posted.filter((p) => p.method === 'POST')).toHaveLength(2);
    expect(state.reviews[0].body).not.toContain(actionSummaryAnchor(context));
    expect(state.reviews[0].body).toContain('review-yeti-bot:v2:review-yeti-ai/review-yeti-bot#42:newhead:action');
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0].body).toContain(actionSummaryAnchor(context));
    expect(state.comments[0].body).toContain('body for head one');
  });

  it('creates a new exact-head receipt and compacts the legacy full review during migration', () => {
    const priorReview = {
      id: 777,
      commit_id: 'oldhead',
      user: { login: 'github-actions[bot]' },
      body: `## 🟡 Verdict: FIX_FIRST\n\n- **Commit SHA**: \`oldhead\`\n\n${actionSummaryAnchor(context)}\n\n<!-- review-yeti-bot:v2:review-yeti-ai/review-yeti-bot#42:oldhead:action -->`,
    };
    const { state, commandRunner } = githubRunner([priorReview]);

    const result = postOrOutputComment('## Verdict for the new head', context, emptyPlan, { commandRunner });

    expect(result).toMatchObject({ success: true });
    expect(state.reviews).toHaveLength(2);
    expect(state.posted.filter((p) => p.method === 'POST')).toHaveLength(2);
    expect(state.posted.filter((p) => p.method === 'PUT')).toHaveLength(1);

    const created = state.posted.find((p) => p.method === 'POST' && p.endpoint.endsWith('/reviews'))!;
    expect(created.endpoint).toBe('repos/review-yeti-ai/review-yeti-bot/pulls/42/reviews');
    expect(created.payload.commit_id).toBe('newhead');
    expect(state.reviews[1].body).toContain('review-yeti-bot:v2:review-yeti-ai/review-yeti-bot#42:newhead:action');
    expect(state.reviews[1].body).not.toContain('## Verdict for the new head');
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0].body).toContain('## Verdict for the new head');
    expect(state.comments[0].body).toContain('<summary>Previous review rounds (1)</summary>');
    expect(state.reviews[0].body).toContain('oldhead');
    expect(state.reviews[0].body).not.toContain(actionSummaryAnchor(context));
    expect(state.reviews[0].body).toContain('Full round details are maintained in the sticky Review Yeti summary comment.');
  });

  it('still deduplicates a retry of the same push rather than editing anything', () => {
    const { state, commandRunner } = githubRunner();
    postOrOutputComment('body', context, emptyPlan, { commandRunner });

    const replay = postOrOutputComment('body', context, emptyPlan, { commandRunner });

    expect(replay).toMatchObject({ success: true, deduplicated: true });
    expect(state.posted.filter((p) => p.method === 'PUT')).toHaveLength(0);
    expect(state.reviews).toHaveLength(1);
    expect(state.comments).toHaveLength(1);
  });

  it('repairs a legacy body marker when its immutable review commit belongs to an earlier head', () => {
    const legacyReview = {
      id: 777,
      commit_id: 'oldhead',
      user: { login: 'github-actions[bot]' },
      body: `## 🟢 Verdict: SHIP\n\n${actionSummaryAnchor(context)}\n\n<!-- review-yeti-bot:v2:review-yeti-ai/review-yeti-bot#42:newhead:action -->`,
    };
    const { state, commandRunner } = githubRunner([legacyReview]);

    const result = postOrOutputComment('## Verdict for the new head', context, emptyPlan, { commandRunner });

    expect(result).toMatchObject({ success: true, postedViaGh: true });
    expect(state.reviews).toHaveLength(2);
    expect(state.posted.filter((p) => p.method === 'POST')).toHaveLength(2);
    expect(state.posted.filter((p) => p.method === 'PUT')).toHaveLength(1);
    expect(state.posted.find((p) => p.method === 'POST')?.payload.commit_id).toBe('newhead');
  });

  it('keeps the latest round expanded while retaining earlier rounds in collapsed history', () => {
    const first = renderStickySummaryBody('## 🟢 **Verdict: SHIP**\nfirst round', context, null);
    const second = renderStickySummaryBody('## 🔴 **Verdict: BLOCK**\nsecond round', context, first.body);

    expect(second.deduplicated).toBe(false);
    expect(second.body).toContain('## 🔴 **Verdict: BLOCK**\nsecond round');
    expect(second.body).toContain('<details>\n<summary>Previous review rounds (1)</summary>');
    expect(second.body).toContain('## 🟢 **Verdict: SHIP**\nfirst round');
    expect(splitStickySummaryBody(second.body).entries).toHaveLength(1);
    expect(renderStickySummaryBody('## 🔴 **Verdict: BLOCK**\nsecond round', context, second.body).deduplicated).toBe(true);
  });

  it('patches the one sticky comment when a later round changes the summary', () => {
    const { state, commandRunner } = githubRunner();

    expect(postStickySummaryComment('first round', context, { commandRunner })).toMatchObject({ success: true });
    expect(postStickySummaryComment('second round', context, { commandRunner })).toMatchObject({
      success: true,
      updatedInPlace: true,
    });

    expect(state.comments).toHaveLength(1);
    expect(state.comments[0].body).toContain('second round');
    expect(state.comments[0].body).toContain('<summary>Previous review rounds (1)</summary>');
    expect(state.posted.filter((post) => post.method === 'POST' && post.endpoint.endsWith('/issues/42/comments'))).toHaveLength(1);
    expect(state.posted.filter((post) => post.method === 'PATCH')).toHaveLength(1);
  });

  it('fails closed when GitHub exposes the compact review at a different commit than the requested head', () => {
    const { commandRunner } = githubRunner([], { createdReviewCommitId: 'oldhead' });

    const result = postOrOutputComment('body', context, emptyPlan, { commandRunner });

    expect(result).toMatchObject({ success: false, postedViaGh: false });
    expect(result.error).toContain('exact-head compact review was not visible after publication');
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('the merge-blocking cap on review threads', () => {
  const file = (name: string) => ({
    path: name,
    patch: `@@ -0,0 +1,80 @@\n${Array.from({ length: 80 }, (_, i) => `+l${i}`).join('\n')}`,
  });

  // Distinct claims about distinct files, so near-duplicate merging cannot collapse them and the
  // count reaching the cap is the count the panel actually produced.
  const planOf = (count: number, severity: 'P0' | 'P1' = 'P1') => planFindingPublication([{
    displayName: 'Security',
    findings: Array.from({ length: count }, (_, i) => ({
      severity,
      path: `src/module${i}.ts`,
      line: 4,
      title: `Unvalidated tenant identifier reaches query builder ${i}`,
      body: `Handler ${i} interpolates the caller-supplied tenant id straight into the predicate, so a crafted id widens the row set beyond the caller's tenant.`,
    })),
  }], Array.from({ length: count }, (_, i) => file(`src/module${i}.ts`)));

  it('leaves a plan under the cap untouched', () => {
    const plan = planOf(MAX_PUBLISHED_REVIEW_THREADS - 1);
    expect(capPublicationThreads(plan)).toBe(plan);
  });

  it('opens no more than the cap and carries the rest as overflow', () => {
    const capped = capPublicationThreads(planOf(MAX_PUBLISHED_REVIEW_THREADS + 7));

    expect(capped.lineComments).toHaveLength(MAX_PUBLISHED_REVIEW_THREADS);
    expect(capped.overflow).toHaveLength(7);
  });

  it('loses no finding — every planned thread is either published or in overflow', () => {
    const plan = planOf(MAX_PUBLISHED_REVIEW_THREADS + 7);
    const capped = capPublicationThreads(plan);
    const seen = [...capped.lineComments, ...capped.fileComments, ...capped.overflow];

    expect(seen).toHaveLength(plan.lineComments.length + plan.fileComments.length);
    expect(new Set(seen.map((item: any) => item.markerKey)).size).toBe(seen.length);
  });

  it('keeps the most severe findings as the threads that block the merge', () => {
    const mixed = planFindingPublication([{
      displayName: 'Security',
      findings: [
        ...Array.from({ length: MAX_PUBLISHED_REVIEW_THREADS }, (_, i) => ({
          severity: 'P1' as const,
          path: `src/low${i}.ts`,
          line: 4,
          title: `Unvalidated tenant identifier reaches query builder ${i}`,
          body: `Handler ${i} interpolates the caller-supplied tenant id into the predicate, widening the row set.`,
        })),
        {
          severity: 'P0' as const,
          path: 'src/critical.ts',
          line: 4,
          title: 'Session token is written to the request log',
          body: 'The bearer token is logged verbatim on every authenticated request, so anyone with log read access can replay a live session.',
        },
      ],
    }], [
      ...Array.from({ length: MAX_PUBLISHED_REVIEW_THREADS }, (_, i) => file(`src/low${i}.ts`)),
      file('src/critical.ts'),
    ]);

    const capped = capPublicationThreads(mixed);

    expect(capped.lineComments[0].finding.severity).toBe('P0');
    expect(capped.overflow.every((item: any) => item.finding.severity === 'P1')).toBe(true);
  });

  // planFindingPublication returns two separately-sorted lists, so taking the head of each would
  // publish a P1 line finding while pushing a P0 file-level finding into overflow.
  it('keeps a P0 without a line anchor ahead of P1 line findings', () => {
    const lineFile = (i: number) => file(`src/line${i}.ts`);
    const mixed = planFindingPublication([{
      displayName: 'Security',
      findings: [
        ...Array.from({ length: MAX_PUBLISHED_REVIEW_THREADS }, (_, i) => ({
          severity: 'P1' as const,
          path: `src/line${i}.ts`,
          line: 4,
          title: `Unvalidated tenant identifier reaches query builder ${i}`,
          body: `Handler ${i} interpolates the caller-supplied tenant id into the predicate, widening the row set.`,
        })),
        {
          // No hunks in the patch, so this can only be published as a file-level conversation.
          severity: 'P0' as const,
          path: 'config/secrets.yaml',
          line: 1,
          title: 'Production signing key is committed in cleartext',
          body: 'The signing key used for session tokens is checked in verbatim, so anyone with repository read access can mint valid sessions.',
        },
      ],
    }], [
      ...Array.from({ length: MAX_PUBLISHED_REVIEW_THREADS }, (_, i) => lineFile(i)),
      { path: 'config/secrets.yaml', patch: '' },
    ]);

    expect(mixed.fileComments).toHaveLength(1);

    const capped = capPublicationThreads(mixed);

    expect(capped.fileComments).toHaveLength(1);
    expect(capped.lineComments).toHaveLength(MAX_PUBLISHED_REVIEW_THREADS - 1);
    expect(capped.overflow).toHaveLength(1);
    expect(capped.overflow[0].finding.severity).toBe('P1');
  });

  it('reports the over-cap findings in the sticky summary rather than dropping them', () => {
    const { state, commandRunner } = (() => {
      const posted: Array<{ method: string; endpoint: string; payload: any }> = [];
      const comments: Array<{ id: number; body: string; user: { login: string } }> = [];
      const reviews: any[] = [];
      const threads: any[] = [];
      let nextId = 900;
      const runner = (_exe: string, args: string[], commandOptions: any) => {
        if (args[0] === 'pr' && args[1] === 'view') {
          return { status: 0, stdout: JSON.stringify({ headRefOid: 'newhead', baseRefOid: 'base' }), stderr: '' };
        }
        if (args[0] === 'api' && args[1] === 'graphql') {
          return { status: 0, stdout: JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } } }]), stderr: '' };
        }
        if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: 'github-actions[bot]\n', stderr: '' };
        if (args[0] === 'api' && String(args[1]).includes('/issues/42/comments') && !args.includes('--method')) {
          return { status: 0, stdout: comments.map((c) => JSON.stringify(c)).join('\n'), stderr: '' };
        }
        if (args[0] === 'api' && args.includes('--method')) {
          const method = args[args.indexOf('--method') + 1];
          const endpoint = args[3];
          const payload = JSON.parse(commandOptions.input);
          posted.push({ method, endpoint, payload });
          nextId += 1;
          if (endpoint.endsWith('/issues/42/comments')) comments.push({ id: nextId, body: payload.body, user: { login: 'github-actions[bot]' } });
          else if (endpoint.endsWith('/reviews')) {
            reviews.push({ id: nextId, body: payload.body, commit_id: payload.commit_id, user: { login: 'github-actions[bot]' } });
            // GitHub materializes each element of `comments[]` as a review thread; mirror that so
            // the publisher's post-write readback sees what it just created.
            for (const comment of payload.comments || []) {
              threads.push({
                id: `thread-${threads.length}`,
                isResolved: false,
                path: comment.path,
                line: comment.line ?? null,
                diffSide: comment.side || 'RIGHT',
                comments: {
                  nodes: [{
                    databaseId: 1000 + threads.length,
                    body: comment.body,
                    createdAt: '2026-09-06T00:00:00Z',
                    author: { login: 'github-actions[bot]' },
                    commit: { oid: 'newhead' },
                  }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              });
            }
          }
          return { status: 0, stdout: JSON.stringify({ id: nextId, user: { login: 'github-actions[bot]' } }), stderr: '' };
        }
        if (args[0] === 'api' && String(args[1]).includes('/pulls/42/reviews')) {
          return { status: 0, stdout: JSON.stringify([reviews]), stderr: '' };
        }
        return { status: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
      };
      return { state: { posted, comments, reviews }, commandRunner: runner };
    })();

    const capped = capPublicationThreads(planOf(MAX_PUBLISHED_REVIEW_THREADS + 3));
    const result = postOrOutputComment('summary body', {
      repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, headSha: 'newhead', baseSha: 'base',
    }, capped, { commandRunner });

    expect(result.success).toBe(true);
    const sticky = state.comments[0].body;
    expect(sticky).toContain('Additional findings not opened as conversations');
    for (const item of capped.overflow) expect(sticky).toContain(item.path);
  });
});
