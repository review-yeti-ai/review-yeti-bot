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
  MAX_PUBLISHED_REVIEW_THREADS,
  parsePriorSummaryReview,
  postOrOutputComment,
  postStickySummaryComment,
  MAX_READ_ACTION_REVIEWS,
  readActionReviews,
  readActionReviewThreads,
  renderStickySummaryBody,
  reviewRequiresResultRepublish,
  splitStickySummaryBody,
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
        if (isReviewListQuery(args)) return { status: 0, stdout: reviewListPage(state.reviews), stderr: '' };
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

  // A prior receipt for this head is only reusable if it recorded a terminal result. A retryable
  // one (BLOCK/FIX_FIRST/INCOMPLETE/...) must be republished, or a re-run silently inherits the
  // stale verdict as its own gate signal.
  const seededReview = (verdict: string) => ({
    id: 777,
    commit_id: 'newhead',
    user: { login: 'github-actions[bot]' },
    body: [
      `**Verdict: ${verdict}**`,
      '<!-- review-yeti-bot:v2:review-yeti-ai/review-yeti-bot#42:newhead:action -->',
      '<!-- review-yeti-bot:result:v1:review-yeti-ai/review-yeti-bot#42:newhead:earlier-attempt -->',
    ].join('\n\n'),
  });

  it('republishes the receipt when the prior exact-head result was retryable', () => {
    const { state, commandRunner } = githubRunner([seededReview('BLOCK')]);

    const result = postOrOutputComment('body', context, emptyPlan, { commandRunner });

    expect(result).toMatchObject({ success: true });
    expect(result.deduplicated).toBeUndefined();
    expect(state.reviews).toHaveLength(2);
  });

  it('reuses the receipt when the prior exact-head result was terminal', () => {
    const { state, commandRunner } = githubRunner([seededReview('SHIP')]);

    const result = postOrOutputComment('body', context, emptyPlan, { commandRunner });

    expect(result).toMatchObject({ success: true, deduplicated: true });
    expect(state.reviews).toHaveLength(1);
  });

  const RETRYABLE = ['BLOCK', 'FIX_FIRST', 'PARTIAL', 'PARTIAL_REVIEW', 'INCOMPLETE_REVIEW', 'INCOMPLETE_INFRA', 'DEGRADED', 'ERROR'];

  it('classifies which verdicts force a republish, in the heading format', () => {
    for (const verdict of RETRYABLE) {
      expect(reviewRequiresResultRepublish({ body: `**Verdict: ${verdict}**` })).toBe(true);
      expect(reviewRequiresResultRepublish({ body: `**Verdict: \`${verdict}\`**` })).toBe(true);
    }
    expect(reviewRequiresResultRepublish({ body: '**Verdict: SHIP**' })).toBe(false);
    expect(reviewRequiresResultRepublish({ body: 'no verdict at all' })).toBe(false);
    expect(reviewRequiresResultRepublish({ body: '' })).toBe(false);
  });

  // The function accepts a second shape. Only the heading form was covered, so a typo in
  // 'Quorum Status' or a change to the backtick pattern would let a stale BLOCK review be reused
  // as this head's terminal gate signal with the suite still green.
  it('classifies the status-line format too', () => {
    for (const label of ['Review Status', 'Quorum Status']) {
      for (const verdict of RETRYABLE) {
        expect(reviewRequiresResultRepublish({ body: `**${label}**: \`${verdict}\`` })).toBe(true);
      }
      expect(reviewRequiresResultRepublish({ body: `**${label}**: \`SHIP\`` })).toBe(false);
      // Backticks are part of the contract; without them this is prose, not a status line.
      expect(reviewRequiresResultRepublish({ body: `**${label}**: BLOCK` })).toBe(false);
    }
  });

  // The three regexes over rendered markdown are only correct while formatPRComment keeps
  // rendering that markdown. Nothing bound the renderer to them, so a heading change would
  // silently reclassify every gate signal. This pins the round trip.
  it('matches what formatPRComment actually renders', () => {
    const render = (verdict: string) => pipeline.formatPRComment(
      { verdict, rationale: 'test rationale', quorumSatisfied: true, completedPersonas: 1, totalPersonas: 1, metrics: { p0Count: 0, p1Count: 0, p2Count: 0 } },
      [],
      { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, headSha: 'newhead' },
    );

    expect(reviewRequiresResultRepublish({ body: render('BLOCK') })).toBe(true);
    expect(reviewRequiresResultRepublish({ body: render('FIX_FIRST') })).toBe(true);
    expect(reviewRequiresResultRepublish({ body: render('SHIP') })).toBe(false);

    // The same rendered body must remain readable by the other two parsers of that contract.
    expect(parsePriorSummaryReview(render('BLOCK')).verdict).toBe('BLOCK');
    expect(parsePriorSummaryReview(render('SHIP')).verdict).toBe('SHIP');

    // compactReviewBody lifts the verdict heading out of the same markdown. Its fallback is the
    // generic '## Review Yeti result', so a heading change degrades silently into a receipt that
    // states no verdict at all rather than failing.
    for (const verdict of ['SHIP', 'FIX_FIRST', 'BLOCK']) {
      const compact = pipeline.compactReviewBody(render(verdict), context, { marker: '', resultMarker: '' });
      expect(compact).toContain(`**Verdict: ${verdict}**`);
      expect(compact).not.toContain('## Review Yeti result');
    }

    // And the fallback still exists for a body that carries no heading at all.
    expect(pipeline.compactReviewBody('no heading here', context, { marker: '', resultMarker: '' }))
      .toContain('## Review Yeti result');
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
          if (isReviewListQuery(args)) return { status: 0, stdout: reviewListPage(reviews), stderr: '' };
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

/* -------------------------------------------------------------------------------------------- */

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

  // `readAuthenticatedPublisherLogin` falls back to 'github-actions[bot]' when GITHUB_ACTIONS is
  // 'true', so the no-identity path only exists off-Actions. The runner sets that variable, so the
  // test has to unset it explicitly rather than inherit whatever the host happens to be.
  it('fails loudly when the publishing identity cannot be established', () => {
    vi.stubEnv('GITHUB_ACTIONS', '');
    const { state, commandRunner } = runner([], { publisher: null });

    const result = postStickySummaryComment('summary', context, { commandRunner, existingReviews: [] });

    expect(result.success).toBe(false);
    expect(result.error).toContain('could not determine the publishing GitHub identity');
    expect(state.posted).toHaveLength(0);
  });

  // The complement: on Actions the identity is always resolvable, so the guard must not fire.
  it('uses the Actions identity fallback when the API cannot name the publisher', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    const own = { id: 6004, body: `earlier round ${anchor}`, user: { login: 'github-actions[bot]' } };
    const { state, commandRunner } = runner([own], { publisher: null });

    const result = postStickySummaryComment('later round', context, { commandRunner, existingReviews: [] });

    expect(result).toMatchObject({ success: true, updatedInPlace: true, commentId: 6004 });
    expect(state.posted.filter((post) => post.method === 'PATCH')).toHaveLength(1);
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

  function runner(seedThreads: any[], options: { mirrorWrites?: boolean } = {}) {
    const mirrorWrites = options.mirrorWrites !== false;
    const reviews = [{ id: 777, commit_id: 'newhead', user: { login: 'github-actions[bot]' }, body: `**Verdict: SHIP**\n\n${marker}\n\n${resultMarker}` }];
    const state = { reviews, threads: [...seedThreads], posted: [] as any[], comments: [] as any[], nextId: 5000 };
    const commandRunner = (_exe: string, args: string[], commandOptions: any) => {
      if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ headRefOid: 'newhead', baseRefOid: 'base' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: 'github-actions[bot]\n', stderr: '' };
      if (args[0] === 'api' && args[1] === 'graphql') {
        if (isReviewListQuery(args)) return { status: 0, stdout: reviewListPage(state.reviews), stderr: '' };
        return { status: 0, stdout: JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: state.threads, pageInfo: { hasNextPage: false, endCursor: null } } } } } }]), stderr: '' };
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
        if (mirrorWrites && endpoint.endsWith('/pulls/42/comments')) {
          state.threads.push({
            id: `thread-created-${state.nextId}`,
            isResolved: false,
            path: payload.path,
            line: payload.line ?? null,
            diffSide: payload.side || 'RIGHT',
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

  it('reports deduplicated only when every conversation was already open', () => {
    const publicationPlan = plan();
    const seeded = [...publicationPlan.lineComments, ...publicationPlan.fileComments].map(threadFor);
    const { state, commandRunner } = runner(seeded);

    const result = postOrOutputComment('body', context, publicationPlan, { commandRunner });

    expect(result).toMatchObject({ success: true, deduplicated: true });
    expect(state.posted.filter((post) => post.endpoint.endsWith('/pulls/42/comments'))).toHaveLength(0);
  });

  // Distinct from the review-readback failure: here the review is visible but a conversation the
  // run just wrote is not, so the round cannot claim the findings were published.
  it('fails closed when a written conversation is not visible afterwards', () => {
    const publicationPlan = plan();
    const { commandRunner } = runner([], { mirrorWrites: false });

    const result = postOrOutputComment('body', context, publicationPlan, { commandRunner });

    expect(result).toMatchObject({ success: false, postedViaGh: false });
    expect(result.error).toContain('failed exact-head verification');
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('bounding the sticky summary history', () => {
  const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, headSha: 'newhead', baseSha: 'base' };

  const roundsIn = (body: string) => splitStickySummaryBody(body).entries.length;

  // Successive rounds accumulate into collapsed history; without the slice and the shift loop the
  // comment grows until GitHub refuses the write and publication fails outright.
  const renderRounds = (count: number, bodyFor: (i: number) => string) => {
    let body: string | undefined;
    for (let i = 0; i < count; i += 1) {
      body = renderStickySummaryBody(bodyFor(i), { ...context, headSha: `head${i}` }, body, { publicationAttemptId: `attempt-${i}` }).body;
    }
    return body as string;
  };

  it('keeps only the newest eight rounds', () => {
    const body = renderRounds(12, (i) => `Round body ${i}`);

    expect(roundsIn(body)).toBe(8);
    expect(body).toContain('Round body 11');
    expect(body).not.toContain('Round body 0');
    expect(body).not.toContain('Round body 2');
  });

  it('drops further rounds when eight of them would still be too large', () => {
    const body = renderRounds(10, (i) => `Round ${i} ${'x'.repeat(9_000)}`);

    expect(roundsIn(body)).toBeLessThan(8);
    expect(body.length).toBeLessThan(120_000);
  });

  it('clips a single oversized round and says so', () => {
    const body = renderRounds(2, (i) => (i === 0 ? `huge ${'y'.repeat(20_000)}` : 'small follow-up round'));

    expect(body).toContain('This historical round was clipped to keep the sticky summary bounded.');
    expect(body).toContain('small follow-up round');
  });

  it('never drops the round currently being published', () => {
    const body = renderRounds(9, (i) => `Round ${i} ${'z'.repeat(30_000)}`);

    expect(body).toContain('Round 8');
  });
});

/* -------------------------------------------------------------------------------------------- */

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

    expect(postOrOutputComment('summary body', context, plan, { commandRunner }).success).toBe(true);

    const sticky = state.comments[0].body;
    expect(sticky).toContain('Actionable findings without publishable anchors');
    expect(sticky).toContain('src/handler.ts:4200');
    expect(sticky).toContain('finding line is not an exact changed RIGHT line');
    expect(sticky).toContain('they require manual review at the stated path/location');
  });

  it('leaves the section out entirely when only nits were unanchorable', () => {
    const { state, commandRunner } = runner();
    const plan = { lineComments: [], fileComments: [], advisories: [], rejected: [rejected('P2', 'nit')] };

    postOrOutputComment('summary body', context, plan, { commandRunner });

    expect(state.comments[0].body).not.toContain('Actionable findings without publishable anchors');
  });

  it('keeps the section out of the compact gate receipt', () => {
    const { state, commandRunner } = runner();
    const plan = { lineComments: [], fileComments: [], advisories: [], rejected: [rejected('P1', 'unresolvable')] };

    postOrOutputComment('summary body', context, plan, { commandRunner });

    expect(state.reviews[0].body).not.toContain('Actionable findings without publishable anchors');
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
    return resultMarkerIn(state.reviews[0].body);
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
  function runner(options: { reviewAuthor?: string; commentAuthor?: string; seedReview?: boolean } = {}) {
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

  it('refuses when the created review is attributed to someone else', () => {
    const { commandRunner } = runner({ reviewAuthor: 'someone-else' });

    const result = postOrOutputComment('body', context, emptyPlan, { commandRunner });

    expect(result).toMatchObject({ success: false, postedViaGh: false });
    expect(result.error).toContain('did not match the authenticated GitHub identity');
  });

  it('refuses when a conversation is created under a different identity mid-publication', () => {
    const { commandRunner } = runner({ commentAuthor: 'someone-else', seedReview: true });

    const result = postOrOutputComment('body', context, onePlan(), { commandRunner });

    expect(result).toMatchObject({ success: false, postedViaGh: false });
    expect(result.error).toContain('publisher changed during publication');
  });

  it('refuses when the write response names no publisher at all', () => {
    const { commandRunner } = runner({ reviewAuthor: '' });

    const result = postOrOutputComment('body', context, emptyPlan, { commandRunner });

    expect(result).toMatchObject({ success: false, postedViaGh: false });
    expect(result.error).toContain('did not identify its publisher');
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
