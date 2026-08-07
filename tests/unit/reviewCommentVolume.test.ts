/**
 * Regression cover for the comment volume work.
 *
 * Scenarios and wording are taken from example-org/example-app#4821, where six hours of review produced
 * 121 comments: 65 inline findings across 14 full-panel reruns, nine of them asserting that files
 * present in the pull request were missing.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

import {
  assertsAbsence,
  claimSimilarity,
  claimType,
  compareClaims,
} from '../../src/review/claimSimilarity';
import { formatFindingCommentBody, planFindingPublication } from '../../src/review/findingPublication';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const {
  actionSummaryAnchor,
  buildFileManifest,
  parseBotFindingComment,
  parsePriorSummaryReview,
  planDiffPasses,
  PERSONA_CHARTERS,
  postOrOutputComment,
  readPriorBotFindings,
  reviewablePathsChangedSince,
  reviewViewWasPartial,
  reviewWithModel,
  suppressPriorFindings,
  withholdUnsoundAbsenceClaims,
} = pipeline;

/* -------------------------------------------------------------------------------------------- */
/* Fixture: a controller and the service it references, large enough to land in separate passes.  */
/* -------------------------------------------------------------------------------------------- */

const file = (filePath: string, addedCount: number, body = 'x') => ({
  path: filePath,
  patch: `@@ -0,0 +1,${addedCount} @@\n${Array.from({ length: addedCount }, (_, i) => `+${body}${i}`).join('\n')}\n`,
  addedLines: Array.from({ length: addedCount }, (_, i) => ({ text: `${body}${i}` })),
  deletedLines: [],
});

const CONTROLLER = 'server/ExampleApp/Controllers/InventoryAuditsController.cs';
const SERVICE = 'server/ExampleApp/Services/InventoryAuditService.cs';
const GENERATED_CLIENT = 'apps/web/src/api/generated/inventory-audits/index.ts';

const splitDiffFiles = [file(CONTROLLER, 200), file(SERVICE, 200)];

describe('work item 1 — a reviewer cannot tell "not shown to me" from "not in the pull request"', () => {
  it('splits a controller and its service across separate passes, which is what makes absence unknowable', () => {
    const plan = planDiffPasses(splitDiffFiles, 900, 3);

    expect(plan.passes).toHaveLength(2);
    expect(plan.passes[0].map((f: any) => f.path)).toEqual([CONTROLLER]);
    expect(plan.passes[1].map((f: any) => f.path)).toEqual([SERVICE]);
    expect(plan.omitted).toEqual([]);
  });

  it('describes every file in the pull request, with added and removed counts', () => {
    const manifest = buildFileManifest(splitDiffFiles);

    expect(manifest.entries).toHaveLength(2);
    expect(manifest.text).toContain(CONTROLLER);
    expect(manifest.text).toContain(SERVICE);
    expect(manifest.text).toContain('+200 -0');
    expect(manifest.text).toContain('all 2 file(s)');
    expect(manifest.truncated).toBe(0);
  });

  it('lists an excluded path and says outright that it exists', () => {
    const manifest = buildFileManifest(
      [...splitDiffFiles, file(GENERATED_CLIENT, 1088)],
      new Map([[GENERATED_CLIENT, 'excluded by configuration (apps/*/src/api/generated/**)']]),
    );

    expect(manifest.text).toContain(GENERATED_CLIENT);
    expect(manifest.text).toContain('excluded_from_review: true');
    expect(manifest.text).toContain('the file IS part of this pull request');
    expect(manifest.text).toContain('They are NOT missing.');
    expect(manifest.entries.find((e: any) => e.path === GENERATED_CLIENT)).toMatchObject({
      excludedFromReview: true,
      added: 1088,
    });
  });

  it('states the overflow rather than silently shortening the manifest', () => {
    const many = Array.from({ length: 900 }, (_, i) => file(`src/very/long/path/to/module-number-${i}/index.ts`, 3));
    const manifest = buildFileManifest(many);

    expect(manifest.truncated).toBeGreaterThan(0);
    expect(manifest.text).toContain('did not fit this listing');
    expect(manifest.text).toContain('They exist in the pull request.');
    expect(manifest.text.length).toBeLessThanOrEqual(21_000);
  });

  it('sends the whole manifest to a reviewer whose diff slice holds only one of the two files', async () => {
    const calls: any[] = [];
    const fetchImplementation = async (url: string, init: any) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: '{"findings":[]}' } }] }) };
    };
    const manifest = buildFileManifest(splitDiffFiles);

    await reviewWithModel(
      PERSONA_CHARTERS.find((p: any) => p.id === 'security'),
      [splitDiffFiles[0]], // only the controller is in this pass
      { repo: 'example-org/example-app', prNumber: 4821, headSha: 'ecf3964' },
      {},
      { apiKey: 'sk-test', enabled: true, fetchImplementation, fileManifest: manifest.text, maxAttempts: 1 },
    );

    const [system, user] = calls[0].messages;
    expect(user.content).toContain(SERVICE);
    expect(user.content).not.toContain(`FILE: ${SERVICE}`);
    expect(system.content).toContain('is the authority on what this change contains');
    expect(system.content).toContain('Never report that a file, type, symbol, test, migration, or generated artifact is missing');
    expect(system.content).toContain('Files marked excluded_from_review are present');
  });

  it('classifies the absence claims this bot actually filed, and leaves real defects alone', () => {
    const absenceClaims = [
      { title: 'Registered inventory-audit service implementation is missing from the diff', body: 'This change registers InventoryAuditService, but the diff adds no InventoryAuditService.cs implementation.' },
      { title: 'Generated client output is missing for the new API tag', body: 'This diff does not update the generated API client for that tag.' },
      { title: 'Cycle-count contracts are not exposed by any route', body: 'This diff adds the inventory-audit DTOs, but contains no controller or route-tree changes that expose them.' },
      { title: 'Cycle-count client tag has no published API surface in this diff', body: 'Nothing in this diff publishes the tag.' },
    ];
    for (const claim of absenceClaims) {
      expect(claimType(claim), claim.title).toBe('absence');
      expect(assertsAbsence(claim)).toBe(true);
    }

    // Real defects in code the change does add. These merely read like absence claims, and
    // withholding them would be exactly the "silence P0/P1" failure this must not cause.
    const realDefects = [
      { title: 'Dismissal has no authorization check', body: 'The dismissal path does not verify the caller may act on the count.' },
      { title: 'Dropping the old FK can leave tenant isolation unenforced', body: 'The batch drops the old constraint before the replacement is added.' },
      { title: 'Enforce tenant ownership of Center_GUID', body: 'The migration accepts a Center_GUID that is not checked against the tenant.' },
      { title: 'Post-commit notification scheduling can be permanently lost', body: 'A failure after the transaction commits discards the scheduled work.' },
    ];
    for (const claim of realDefects) {
      expect(claimType(claim), claim.title).toBe('generic');
      expect(assertsAbsence(claim)).toBe(false);
    }
  });

  it('treats every way of seeing less than the whole change as a partial view', () => {
    expect(reviewViewWasPartial({ passes: 2, omitted: [], truncated: [], skipped: [] })).toBe(true);
    expect(reviewViewWasPartial({ passes: 1, omitted: ['a.ts'], truncated: [], skipped: [] })).toBe(true);
    expect(reviewViewWasPartial({ passes: 1, omitted: [], truncated: ['a.ts'], skipped: [] })).toBe(true);
    expect(reviewViewWasPartial({ passes: 1, omitted: [], truncated: [], skipped: [{ path: 'p.lock' }] })).toBe(true);
    expect(reviewViewWasPartial({ passes: 1, omitted: [], truncated: [], skipped: [] })).toBe(false);
  });

  it('withholds absence claims under a partial view and keeps everything else', () => {
    const lanes = [{
      personaId: 'architecture',
      displayName: 'Architecture',
      decision: 'FINDINGS',
      findings: [
        { severity: 'P1', path: CONTROLLER, line: 25, title: 'Cycle-count service implementation is missing from the patch', body: 'The diff adds no implementation for the referenced service.' },
        { severity: 'P1', path: CONTROLLER, line: 248, title: 'Cancel bypasses the inventory-access entitlement check', body: 'The cancel endpoint omits HasInventoryAccessAsync.' },
      ],
    }];

    const withheldRun = withholdUnsoundAbsenceClaims(lanes, true);
    expect(withheldRun.withheld).toHaveLength(1);
    expect(withheldRun.withheld[0].title).toContain('missing from the patch');
    expect(withheldRun.withheld[0].persona).toBe('Architecture');
    expect(withheldRun.personaResults[0].findings).toHaveLength(1);
    expect(withheldRun.personaResults[0].findings[0].title).toContain('Cancel bypasses');
    expect(withheldRun.personaResults[0].decision).toBe('FINDINGS');

    // Whole-change view: the same claim is now something a reviewer could actually know.
    const completeRun = withholdUnsoundAbsenceClaims(lanes, false);
    expect(completeRun.withheld).toEqual([]);
    expect(completeRun.personaResults[0].findings).toHaveLength(2);
  });

  it('marks a lane that had nothing but absence claims as having approved, not as having found things', () => {
    const lanes = [{
      personaId: 'testing',
      displayName: 'Testing',
      decision: 'FINDINGS',
      findings: [{ severity: 'P1', path: SERVICE, line: 22, title: 'No tests cover the new inventory-audit workflow', body: 'There are no tests anywhere in the diff for this workflow.' }],
    }];

    const result = withholdUnsoundAbsenceClaims(lanes, true);

    expect(result.personaResults[0].findings).toEqual([]);
    expect(result.personaResults[0].decision).toBe('APPROVE');
    expect(result.withheld).toHaveLength(1);
  });

  it('leaves a failed lane failed — a withheld finding is not a recovered lane', () => {
    const lanes = [{
      personaId: 'security',
      displayName: 'Security',
      decision: 'ERROR',
      error: 'Provider timeout',
      findings: [{ severity: 'P1', path: SERVICE, line: 1, title: 'Service implementation is missing from the diff', body: 'The diff contains no such file.' }],
    }];

    expect(withholdUnsoundAbsenceClaims(lanes, true).personaResults[0].decision).toBe('ERROR');
  });
});

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
        { severity: 'P1', path: CONTROLLER, line: 248, title: 'Cancel bypasses the inventory-access entitlement check', body: 'Omits HasInventoryAccessAsync on the cancel endpoint.' },
        { severity: 'P1', path: CONTROLLER, line: 250, title: 'Cancel bypasses the inventory-access entitlement check', body: 'Omits HasInventoryAccessAsync on the cancel endpoint entirely.' },
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
    expect(plan.lineComments[0].finding.mergedTitles.length).toBe(5);
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('work item 2 — a rerun does not re-litigate what it already said', () => {
  const priorBody = [
    '**P1 · Dropping the legacy FK is not atomic with adding the tenant-scoped FK**',
    '',
    'When upgrading a database with the earlier single-column foreign key, this batch drops the old constraint before the replacement is added in a later batch.',
    '',
    '**Suggested fix**',
    '',
    'Add the replacement constraint in the same batch.',
    '',
    '**Reported by:** `🗄️ Database`',
    '',
    '<!-- review-yeti-bot:finding:v1:c84d44db1b714695267a4c2a6967c5307845201d:review-yeti-finding:abc123 -->',
  ].join('\n');

  it('reads back the claim from a comment it wrote earlier', () => {
    const parsed = parseBotFindingComment(priorBody);

    expect(parsed).toMatchObject({
      severity: 'P1',
      title: 'Dropping the legacy FK is not atomic with adding the tenant-scoped FK',
      sha: 'c84d44db1b714695267a4c2a6967c5307845201d',
    });
    expect(parsed.body).toContain('drops the old constraint before the replacement');
    expect(parsed.body).not.toContain('Suggested fix');
    expect(parsed.body).not.toContain('<!--');
  });

  it('ignores comments that are not ours', () => {
    expect(parseBotFindingComment('Looks good to me!')).toBeNull();
    expect(parseBotFindingComment('**P1 · Something** without a marker')).toBeNull();
  });

  it('round-trips what formatFindingCommentBody produces, including merged titles', () => {
    const rendered = `${formatFindingCommentBody({
      severity: 'P1',
      path: CONTROLLER,
      line: 248,
      side: 'RIGHT',
      title: 'Cancel bypasses the inventory-access entitlement check',
      body: 'The cancel endpoint omits HasInventoryAccessAsync.',
      personas: ['Security'],
      mergedTitles: ['Cancel bypasses the inventory-access feature gate'],
    } as any)}\n\n<!-- review-yeti-bot:finding:v1:deadbeef:key -->`;

    const parsed = parseBotFindingComment(rendered);

    expect(parsed.title).toBe('Cancel bypasses the inventory-access entitlement check');
    expect(parsed.alternateTitles).toEqual(['Cancel bypasses the inventory-access feature gate']);
    expect(parsed.body).toBe('The cancel endpoint omits HasInventoryAccessAsync.');
  });

  const migration = 'database/migrations/2026-08-04-pr-4821-inventory-audits.sql';
  const priorFinding = {
    path: migration,
    line: 117,
    side: 'RIGHT',
    severity: 'P1',
    title: 'Dropping the legacy FK is not atomic with adding the tenant-scoped FK',
    body: 'This batch drops the old constraint before the replacement foreign key is added in a later batch, so an interrupted deployment leaves the table without either.',
    alternateTitles: [],
    isResolved: false,
    threadId: 'THREAD_1',
    commentId: 55501,
  };

  it('suppresses a repeat wearing a different title, and carries it forward as still open', () => {
    const lanes = [{
      personaId: 'database',
      displayName: '🗄️ Database',
      decision: 'FINDINGS',
      findings: [{
        severity: 'P1',
        path: migration,
        line: 119,
        title: 'Dropping the legacy FK is not failure-safe',
        body: 'This batch drops the old constraint before the replacement foreign key is added in a later batch, so an interrupted deployment leaves the table without either constraint.',
      }],
    }];

    const result = suppressPriorFindings(lanes, [priorFinding]);

    expect(result.personaResults[0].findings).toEqual([]);
    expect(result.personaResults[0].decision).toBe('APPROVE');
    expect(result.stillOpen).toHaveLength(1);
    expect(result.stillOpen[0]).toMatchObject({ threadId: 'THREAD_1', commentId: 55501, repeats: 1 });
    expect(result.alreadyResolved).toEqual([]);
  });

  it('does not repost a finding whose conversation the author already resolved', () => {
    const lanes = [{
      personaId: 'database',
      displayName: '🗄️ Database',
      decision: 'FINDINGS',
      findings: [{
        severity: 'P1',
        path: migration,
        line: 117,
        title: 'Dropping the legacy FK is not failure-safe',
        body: 'This batch drops the old constraint before the replacement foreign key is added in a later batch, so an interrupted deployment leaves the table without either constraint.',
      }],
    }];

    const result = suppressPriorFindings(lanes, [{ ...priorFinding, isResolved: true }]);

    expect(result.personaResults[0].findings).toEqual([]);
    expect(result.alreadyResolved).toHaveLength(1);
    expect(result.stillOpen).toEqual([]);
  });

  it('publishes a genuinely new finding on a file that already has a conversation', () => {
    const lanes = [{
      personaId: 'database',
      displayName: '🗄️ Database',
      decision: 'FINDINGS',
      findings: [{
        severity: 'P1',
        path: migration,
        line: 65,
        title: 'Build existing-table indexes online',
        body: 'Creating this index without ONLINE=ON takes a schema-modification lock on a large existing table.',
      }],
    }];

    const result = suppressPriorFindings(lanes, [priorFinding]);

    expect(result.personaResults[0].findings).toHaveLength(1);
    expect(result.stillOpen).toEqual([]);
  });

  it('keeps matching a prior comment that already absorbed several titles', () => {
    const absorbed = { ...priorFinding, title: 'Composite FK upgrade leaves a window with no constraint', alternateTitles: ['Dropping the legacy FK is not failure-safe'] };
    const lanes = [{
      personaId: 'database',
      displayName: '🗄️ Database',
      decision: 'FINDINGS',
      findings: [{
        severity: 'P1',
        path: migration,
        line: 118,
        title: 'Dropping the legacy FK is not failure-safe',
        body: 'This batch drops the old constraint before the replacement foreign key is added in a later batch, so an interrupted deployment leaves the table without either constraint.',
      }],
    }];

    expect(suppressPriorFindings(lanes, [absorbed]).stillOpen).toHaveLength(1);
  });

  it('changes nothing when the pull request has no prior conversations', () => {
    const lanes = [{ personaId: 'x', displayName: 'X', decision: 'FINDINGS', findings: [{ severity: 'P1', path: 'a.ts', line: 1, title: 'T', body: 'B' }] }];
    expect(suppressPriorFindings(lanes, []).personaResults).toBe(lanes);
  });

  it('reads prior findings out of the review threads, and survives GitHub being unreadable', () => {
    const threads = [{
      id: 'THREAD_9',
      isResolved: false,
      path: migration,
      line: 117,
      diffSide: 'RIGHT',
      comments: { nodes: [{ databaseId: 991, body: priorBody, author: { login: 'github-actions[bot]' }, commit: { oid: 'abc' } }] },
    }];
    const ok = () => ({ status: 0, stdout: JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } } }]), stderr: '' });
    const context = { repo: 'example-org/example-app', prNumber: 4821, headSha: 'ecf3964' };

    const read = readPriorBotFindings(ok, context);
    expect(read.available).toBe(true);
    expect(read.findings).toHaveLength(1);
    expect(read.findings[0]).toMatchObject({ path: migration, line: 117, isResolved: false, threadId: 'THREAD_9', commentId: 991 });

    const broken = () => ({ status: 1, stdout: '', stderr: 'gone' });
    expect(readPriorBotFindings(broken, context)).toEqual({ findings: [], available: false });
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('work item 2 — one pull request gets one summary, not one per push', () => {
  const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 42, headSha: 'newhead' };

  function githubRunner(seedReviews: any[] = []) {
    const state = {
      reviews: [...seedReviews],
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
      if (args[0] === 'api' && args.includes('--method')) {
        const method = args[args.indexOf('--method') + 1];
        const endpoint = args[3];
        const payload = JSON.parse(commandOptions.input);
        state.posted.push({ method, endpoint, payload });
        state.nextId += 1;
        if (method === 'PUT') {
          const target = state.reviews.find((r) => endpoint.endsWith(`/${r.id}`));
          if (target) target.body = payload.body;
          return { status: 0, stdout: JSON.stringify({ id: target?.id, user: { login: 'github-actions[bot]' } }), stderr: '' };
        }
        if (endpoint.endsWith('/reviews')) {
          state.reviews.push({ id: state.nextId, body: payload.body, user: { login: 'github-actions[bot]' } });
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

  it('posts a review on the first push and stamps both markers', () => {
    const { state, commandRunner } = githubRunner();

    const result = postOrOutputComment('body for head one', context, emptyPlan, { commandRunner });

    expect(result.success).toBe(true);
    expect(state.posted.filter((p) => p.method === 'POST')).toHaveLength(1);
    expect(state.reviews[0].body).toContain(actionSummaryAnchor(context));
    expect(state.reviews[0].body).toContain('review-yeti-bot:v2:review-yeti-ai/review-yeti-bot#42:newhead:action');
  });

  it('edits the earlier summary in place on the next push instead of adding a second', () => {
    const priorReview = {
      id: 777,
      user: { login: 'github-actions[bot]' },
      body: `## 🟡 Verdict: FIX_FIRST\n\n- **Commit SHA**: \`oldhead\`\n\n${actionSummaryAnchor(context)}\n\n<!-- review-yeti-bot:v2:review-yeti-ai/review-yeti-bot#42:oldhead:action -->`,
    };
    const { state, commandRunner } = githubRunner([priorReview]);

    const result = postOrOutputComment('## Verdict for the new head', context, emptyPlan, { commandRunner });

    expect(result).toMatchObject({ success: true, reviewId: 777 });
    expect(state.reviews).toHaveLength(1);
    expect(state.posted.filter((p) => p.method === 'POST')).toHaveLength(0);

    const put = state.posted.find((p) => p.method === 'PUT')!;
    expect(put.endpoint).toBe('repos/review-yeti-ai/review-yeti-bot/pulls/42/reviews/777');
    // The consumer verifies publication by grepping the head SHA out of a review body, so an
    // in-place edit is only safe while the edited body carries the new head.
    expect(state.reviews[0].body).toContain('review-yeti-bot:v2:review-yeti-ai/review-yeti-bot#42:newhead:action');
    expect(state.reviews[0].body).toContain('## Verdict for the new head');
    expect(state.reviews[0].body).not.toContain('oldhead');
  });

  it('still deduplicates a retry of the same push rather than editing anything', () => {
    const { state, commandRunner } = githubRunner();
    postOrOutputComment('body', context, emptyPlan, { commandRunner });

    const replay = postOrOutputComment('body', context, emptyPlan, { commandRunner });

    expect(replay).toMatchObject({ success: true, deduplicated: true });
    expect(state.posted.filter((p) => p.method === 'PUT')).toHaveLength(0);
    expect(state.reviews).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('work item 4 — a push that changed nothing reviewable', () => {
  it('recovers the verdict, head, and counts from a summary it published earlier', () => {
    const body = [
      '## 🟡 **Verdict: FIX_FIRST**',
      '- **Parallel Personas Evaluated**: `12/12`',
      '- **Total Findings**: P0: `0` | P1: `7` | P2 / Nits: `3`',
      '<!-- review-yeti-bot:v2:example-org/example-app#4821:ecf3964c865d91ed08ff4ac6266e8f8b090b567e:action -->',
    ].join('\n');

    expect(parsePriorSummaryReview(body)).toMatchObject({
      verdict: 'FIX_FIRST',
      headSha: 'ecf3964c865d91ed08ff4ac6266e8f8b090b567e',
      completedPersonas: 12,
      totalPersonas: 12,
      metrics: { p0Count: 0, p1Count: 7, p2Count: 3, totalFindings: 10 },
    });
  });

  it('returns nothing usable for a body that is not one of ours', () => {
    expect(parsePriorSummaryReview('LGTM')).toMatchObject({ verdict: null, headSha: null, metrics: null });
  });

  const HEAD = 'ecf3964c865d91ed08ff4ac6266e8f8b090b567e';
  const PREVIOUS_HEAD = 'c84d44db1b714695267a4c2a6967c5307845201d';
  const context = { repo: 'example-org/example-app', prNumber: 4821, headSha: HEAD };
  const compareRunner = (files: string[]) => () => ({ status: 0, stdout: JSON.stringify([{ files: files.map((filename) => ({ filename })) }]), stderr: '' });

  it('separates excluded churn from a real source change', () => {
    const excludes = ['apps/*/src/api/generated/**'];

    const generatedOnly = reviewablePathsChangedSince(compareRunner([GENERATED_CLIENT, 'package-lock.json']), context, PREVIOUS_HEAD, excludes);
    expect(generatedOnly).toMatchObject({ available: true, reviewable: [] });
    expect(generatedOnly.changed).toHaveLength(2);

    const withSource = reviewablePathsChangedSince(compareRunner([GENERATED_CLIENT, SERVICE]), context, PREVIOUS_HEAD, excludes);
    expect(withSource.reviewable).toEqual([SERVICE]);
  });

  const summaryFor = (sha: string, verdict = 'FIX_FIRST') => ({
    id: 900,
    user: { login: 'github-actions[bot]' },
    body: [
      `## 🟡 **Verdict: ${verdict}**`,
      '- **Parallel Personas Evaluated**: `12/12`',
      '- **Total Findings**: P0: `0` | P1: `7` | P2 / Nits: `3`',
      actionSummaryAnchor(context),
      `<!-- review-yeti-bot:v2:example-org/example-app#4821:${sha}:action -->`,
    ].join('\n'),
  });

  /** A runner answering both the reviews read and the compare call. */
  const skipRunner = (summary: any, changedFiles: string[] | null) => (_exe: string, args: string[]) => {
    if (args[0] === 'api' && String(args[1]).startsWith('repos/example-org/example-app/compare/')) {
      if (changedFiles === null) return { status: 1, stdout: '', stderr: 'no comparison' };
      return { status: 0, stdout: JSON.stringify([{ files: changedFiles.map((filename) => ({ filename })) }]), stderr: '' };
    }
    if (args[0] === 'api' && String(args[1]).includes('/reviews')) {
      return { status: 0, stdout: JSON.stringify([summary ? [summary] : []]), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
  };

  const excludes = ['apps/*/src/api/generated/**'];

  it('carries the previous verdict forward when only excluded paths moved', () => {
    const runner = skipRunner(summaryFor(PREVIOUS_HEAD), [GENERATED_CLIENT]);

    const plan = pipeline.planCarriedForwardVerdict(runner, context, excludes);

    expect(plan).toMatchObject({
      verdict: 'FIX_FIRST',
      status: 'UNCHANGED_SINCE_LAST_REVIEW',
      coverageStatus: 'complete',
      gateDecision: 'BLOCKED',
      mergeEligible: false,
      metrics: { p0Count: 0, p1Count: 7, p2Count: 3 },
      completedPersonas: 12,
    });
    expect(plan.rationale).toContain(PREVIOUS_HEAD.slice(0, 7));
    expect(plan.rationale).toContain(HEAD.slice(0, 7));
  });

  it('preserves a verified clean gate when carrying an unchanged SHIP verdict forward', () => {
    const cleanSummary = summaryFor(PREVIOUS_HEAD, 'SHIP');
    cleanSummary.body = cleanSummary.body.replace('P1: `7`', 'P1: `0`');

    const plan = pipeline.planCarriedForwardVerdict(
      skipRunner(cleanSummary, [GENERATED_CLIENT]),
      context,
      excludes,
    );

    expect(plan).toMatchObject({
      verdict: 'SHIP',
      status: 'UNCHANGED_SINCE_LAST_REVIEW',
      coverageStatus: 'complete',
      coverageQuorumSatisfied: true,
      gateDecision: 'PASS',
      mergeEligible: true,
    });
  });

  it('reruns instead of carrying a verdict whose prior panel was not complete', () => {
    const incompleteSummary = summaryFor(PREVIOUS_HEAD);
    incompleteSummary.body = incompleteSummary.body.replace('`12/12`', '`11/12`');

    expect(pipeline.planCarriedForwardVerdict(
      skipRunner(incompleteSummary, [GENERATED_CLIENT]),
      context,
      excludes,
    )).toBeNull();
  });

  it('runs the panel whenever anything reviewable moved', () => {
    const runner = skipRunner(summaryFor(PREVIOUS_HEAD), [GENERATED_CLIENT, SERVICE]);
    expect(pipeline.planCarriedForwardVerdict(runner, context, excludes)).toBeNull();
  });

  it('runs the panel when there is no prior summary, no comparison, or an empty comparison', () => {
    expect(pipeline.planCarriedForwardVerdict(skipRunner(null, [GENERATED_CLIENT]), context, excludes)).toBeNull();
    expect(pipeline.planCarriedForwardVerdict(skipRunner(summaryFor(PREVIOUS_HEAD), null), context, excludes)).toBeNull();
    expect(pipeline.planCarriedForwardVerdict(skipRunner(summaryFor(PREVIOUS_HEAD), []), context, excludes)).toBeNull();
    // Already reviewed at this exact head: the normal exact-head dedupe path owns that case.
    expect(pipeline.planCarriedForwardVerdict(skipRunner(summaryFor(HEAD), [GENERATED_CLIENT]), context, excludes)).toBeNull();
  });

  it('refuses to answer when the comparison is missing, unreadable, or degenerate', () => {
    const failing = () => ({ status: 1, stdout: '', stderr: 'not found' });
    expect(reviewablePathsChangedSince(failing, context, PREVIOUS_HEAD, [])).toMatchObject({ available: false });

    const noFileList = () => ({ status: 0, stdout: JSON.stringify([{ commits: [] }]), stderr: '' });
    expect(reviewablePathsChangedSince(noFileList, context, PREVIOUS_HEAD, [])).toMatchObject({ available: false });

    const garbage = () => ({ status: 0, stdout: 'not json', stderr: '' });
    expect(reviewablePathsChangedSince(garbage, context, PREVIOUS_HEAD, [])).toMatchObject({ available: false });

    // No base to compare against, or a base equal to the head, is not evidence of no change.
    expect(reviewablePathsChangedSince(compareRunner([]), context, '', [])).toMatchObject({ available: false });
    expect(reviewablePathsChangedSince(compareRunner([]), context, HEAD, [])).toMatchObject({ available: false });
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('claim similarity is calibrated, not guessed', () => {
  it('scores identically-titled reports of one defect far above differently-scoped ones', () => {
    const a = { path: CONTROLLER, line: 248, title: 'Cancel bypasses the inventory-access entitlement check', body: 'The cancel endpoint checks only stock Update permission and omits HasInventoryAccessAsync.' };
    const b = { path: CONTROLLER, line: 250, title: 'Cancel bypasses the inventory-access entitlement check', body: 'The cancel endpoint never calls HasInventoryAccessAsync, unlike every other inventory-audit endpoint.' };
    const unrelated = { path: CONTROLLER, line: 259, title: 'Completion is authorized with Create permission', body: 'The completion endpoint accepts the Create permission where Update is required.' };

    expect(claimSimilarity(a, b)).toBeGreaterThan(0.7);
    expect(claimSimilarity(a, unrelated)).toBeLessThan(0.45);
  });

  /**
   * Known limit, pinned deliberately rather than left to be rediscovered.
   *
   * These two titles describe one defect and share not a single content word, so the lexical
   * measure cannot connect them and the pair still costs two conversations. Fixing it means an
   * embedding or model-side equality check; the threshold cannot simply be lowered, because a
   * genuine non-duplicate on the calibration corpus already scores above where this pair lands.
   */
  it('cannot connect two titles for one defect that share no vocabulary', () => {
    const shared = 'This batch drops the old constraint before the replacement foreign key is added in a later batch.';
    const a = { path: 'm.sql', line: 117, title: 'Dropping the legacy FK is not atomic with adding the tenant-scoped FK', body: shared };
    const b = { path: 'm.sql', line: 117, title: 'Foreign-key upgrade can leave the database without the old constraint', body: shared };

    expect(compareClaims(a, b).duplicate).toBe(false);
    expect(claimSimilarity(a, b)).toBeLessThan(0.45);
  });

  it('treats a reworded identifier as the same word', () => {
    const withIdentifier = { path: 'a.cs', line: 1, title: 'HasInventoryAccessAsync is not called', body: '' };
    const withProse = { path: 'a.cs', line: 1, title: 'has inventory access async is not called', body: '' };
    expect(claimSimilarity(withIdentifier, withProse)).toBeGreaterThan(0.9);
  });
});
