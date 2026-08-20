import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import { sseBody } from '../support/streamableFetchStub';

// Resolve path to root repository .github/workflows/pipelines/review-pipeline.js
const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipelinePath = path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js');
const pipeline = require(pipelinePath);
const { createReviewUnitManifest } = require(path.join(rootRepoDir, 'src/review/reviewUnitManifest.js'));

describe('PI.dev Review Workflow Pipeline Script (.github/workflows/pipelines/review-pipeline.js)', () => {
  const runMainInTempDir = async (diff: string, options: { expectedFetches?: number; config?: string; runChatPreflight?: boolean; mainOptions?: Record<string, unknown> }) => {
    const originalCwd = process.cwd();
    const originalFetch = globalThis.fetch;
    const originalExitCode = process.exitCode;
    const originalEnv = { ...process.env };
    const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'review-yeti-terminal-'));
    const outputPath = path.join(tempDir, 'github-output.txt');
    // Streaming is unconditional on the real review path (operator directive), so this needs a
    // readable `body` (a single-chunk SSE stream) or every persona-lane fetch would legitimately
    // (and audibly) retry once non-stream within the same attempt, doubling `expectedFetches` for
    // every test that counts model-fetch calls.
    // Bounded-investigation contract (review-pipeline.js's only remaining review path, since the
    // legacy single-shot findings-only contract was removed): a COMPLETE status with no risks and
    // no findings resolves in exactly one turn. A legacy-shaped `{"findings":[]}` body has no
    // review_status, so the investigation loop can't tell the lane is done and spends its second
    // (evidence-follow-up) turn too -- doubling every `expectedFetches` count below.
    const chatPayload = {
      model: 'test-model',
      provider: 'test-provider',
      choices: [{ message: { content: JSON.stringify({ review_status: 'COMPLETE', risk_plan: [], evidence_requests: [], risk_dispositions: [], findings: [] }) } }],
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => chatPayload,
      body: sseBody(chatPayload),
    }));
    const repo = 'o/r';
    const prNumber = '101';
    const headSha = 'b'.repeat(40);
    const baseSha = 'a'.repeat(40);
    // A real (bounded-mode-qualifying) prNumber makes postOrOutputComment attempt an actual
    // GitHub publish instead of its no-prNumber local-file fallback, so this needs the full `gh`
    // surface stubbed (mirrors tests/support/reviewWorkflowHarness.ts's commandRunnerFactory),
    // not just the exact-head verification call.
    const reviewEndpoint = `repos/${repo}/pulls/${prNumber}/reviews`;
    const commentsEndpoint = `repos/${repo}/issues/${prNumber}/comments`;
    // Publication re-fetches the review it just created to verify exact-head visibility before
    // declaring success; the GET stub must echo back what the POST stub "created" or every
    // publish looks like it silently vanished. The full rendered comment body -- what
    // review-comment.md held under the old no-prNumber local-write fallback -- is posted as the
    // sticky issue comment (postStickySummaryComment), not the compact PR review body, so that
    // POST is what result.comment must expose.
    let createdReview: Record<string, unknown> | null = null;
    let stickyCommentBody = '';
    const commandRunner = (command: string, args: string[] = [], commandOptions: { input?: string } = {}) => {
      if (command !== 'gh') return { status: 1, stdout: '', stderr: `unexpected command ${command}` };
      const joined = args.join(' ');
      if (args[0] === 'pr' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ headRefOid: headSha, baseRefOid: baseSha }), stderr: '' };
      }
      if (joined.includes(commentsEndpoint) && args.includes('--method') && args.includes('POST')) {
        const payload = JSON.parse(commandOptions.input || '{}');
        stickyCommentBody = String(payload.body || '');
        return { status: 0, stdout: JSON.stringify({ id: 8001, body: stickyCommentBody }), stderr: '' };
      }
      if (!args.includes('--method') && (joined.includes(commentsEndpoint) || (args[0] === 'api' && String(args[1] || '').includes(`/issues/${prNumber}/comments`)))) {
        return { status: 0, stdout: '[]', stderr: '' };
      }
      if (args.includes('user')) return { status: 0, stdout: 'review-yeti-bot\n', stderr: '' };
      if (args.includes('graphql')) {
        return {
          status: 0,
          stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }),
          stderr: '',
        };
      }
      if (joined.includes(reviewEndpoint) && args.includes('--method') && args.includes('POST')) {
        const payload = JSON.parse(commandOptions.input || '{}');
        createdReview = { id: 9001, commit_id: payload.commit_id, user: { login: 'review-yeti-bot' }, body: payload.body || '' };
        return { status: 0, stdout: JSON.stringify(createdReview), stderr: '' };
      }
      if (joined.includes(reviewEndpoint) && !args.includes('--method')) return { status: 0, stdout: JSON.stringify(createdReview ? [createdReview] : []), stderr: '' };
      if (args[0] === 'pr' && args[1] === 'comment') return { status: 0, stdout: '', stderr: '' };
      if (args.includes('compare')) return { status: 0, stdout: JSON.stringify({ files: [] }), stderr: '' };
      return { status: 0, stdout: '{}', stderr: '' };
    };

    try {
      process.chdir(tempDir);
      if (options.config) fs.writeFileSync(path.join(tempDir, '.review-yeti.yaml'), options.config);
      process.exitCode = undefined;
      for (const key of [
        'PR_NUMBER', 'PR_REPO', 'GITHUB_ACTIONS', 'GITHUB_EVENT_PATH', 'GITHUB_REF',
        'GITHUB_REPOSITORY', 'GITHUB_SHA',
        'REVIEW_YETI_CONFIG_DIR', 'EXCLUDE_PATHS',
        'CONTEXT7_API_KEY', 'CONTEXT7_ENABLED', 'MCP_CONFIG_JSON',
      ]) delete process.env[key];
      Object.assign(process.env, {
        // A positive prNumber and 40-hex base/head SHAs are what select the bounded review-unit
        // manifest path (the only path left -- see the legacy-path removal that deleted the
        // synthetic-identity fallback this harness used to rely on).
        PR_NUMBER: prNumber,
        PR_DIFF: JSON.stringify({ diff, repo, prNumber, baseSha, headSha, title: 'terminal coverage' }),
        ACTIVE_PERSONAS: JSON.stringify(['security']),
        OPENROUTER_API_KEY: 'test-key',
        OPENROUTER_MODEL: 'test-model',
        MAX_FILE_DIFF_CHARS: '5000',
        MAX_DIFF_CHARS: '20000',
        GITHUB_OUTPUT: outputPath,
        // Required by the bounded path's review-dispatch receipt, which now always builds on a
        // completed review (previously skipped only on the legacy dispatch branch).
        GITHUB_RUN_ID: 'test-run-1',
        GITHUB_RUN_ATTEMPT: '1',
        REVIEW_YETI_ACTION_SHA: 'c'.repeat(40),
        // These cases assert exact model-fetch counts for the persona lanes;
        // the overview pre-pass is covered by its own suites.
        REVIEW_YETI_OVERVIEW_BRIEF: 'false',
      });
      process.env.VITEST = options.runChatPreflight ? 'false' : 'true';
      globalThis.fetch = fetchImpl as any;

      await pipeline.main({ commandRunner, ...options.mainOptions });

      if (options.expectedFetches !== undefined) expect(fetchImpl).toHaveBeenCalledTimes(options.expectedFetches);
      return {
        output: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '',
        // A real prNumber (required for the bounded review-unit manifest) makes publication
        // go through the mocked GitHub calls above instead of the no-prNumber local-file
        // fallback, so the published sticky-summary body -- not review-comment.md -- carries the
        // full rendered comment content these assertions inspect.
        comment: stickyCommentBody
          || (typeof createdReview?.body === 'string' ? createdReview.body : '')
          || (fs.existsSync(path.join(tempDir, 'review-comment.md'))
            ? fs.readFileSync(path.join(tempDir, 'review-comment.md'), 'utf-8')
            : ''),
        fetchImpl,
      };
    } finally {
      process.chdir(originalCwd);
      globalThis.fetch = originalFetch;
      process.exitCode = originalExitCode;
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
    }
  };

  const diffWithFiles = (files: string[]) => files.map((entry) => entry).join('\n');

  it('ships mixed eligible coverage while treating oversized files as expected exclusions', async () => {
    const oversizedMarker = 'MIXED_OVERSIZED_MARKER';
    const diff = diffWithFiles([
      'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new',
      `diff --git a/src/oversized.ts b/src/oversized.ts\n--- a/src/oversized.ts\n+++ b/src/oversized.ts\n@@ -1 +1 @@\n-${oversizedMarker}${'x'.repeat(5_000)}\n+${oversizedMarker}${'x'.repeat(5_000)}`,
    ]);

    const result = await runMainInTempDir(diff, { expectedFetches: 1 });

    expect(result.output).toContain('verdict=SHIP');
    expect(result.output).toContain('review-status=SHIP');
    expect(result.comment).not.toContain('INCOMPLETE_REVIEW');
    expect(result.comment).toContain('src/oversized.ts');
    expect(result.comment).toMatch(/src\/oversized\.ts.*\d[\d,]+ chars/i);
    expect(result.comment).toMatch(/expected policy exclusion|does not block/i);
    expect(JSON.stringify(result.fetchImpl.mock.calls)).not.toContain(oversizedMarker);
  }, 15_000);

  it('ships intentional exclusions without model requests', async () => {
    // Built-in lockfile/generated-file detection only -- a repo-configured `exclude:` glob is
    // deliberately NOT included here. See the KNOWN GAP test below: found while auditing the
    // legacy path for removal, boundedMode's review-unit-manifest selection (now the only
    // selection path -- previously skipped for any non-bounded run) does not thread a repo's
    // plain `.review-yeti.yaml` `exclude:` list into its trusted-default policy, so a
    // repo-configured exclusion is silently ignored unless `review.units.enabled` is also
    // configured with full trusted-config bootstrapping. That is a pre-existing production gap,
    // not something this PR introduces or fixes -- flagged, not silently absorbed into this test.
    const diff = diffWithFiles([
      'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-old\n+new',
      'diff --git a/generated/schema.generated.json b/generated/schema.generated.json\n--- a/generated/schema.generated.json\n+++ b/generated/schema.generated.json\n@@ -1 +1 @@\n-old\n+new',
    ]);

    const result = await runMainInTempDir(diff, { expectedFetches: 0 });

    expect(result.output).toContain('verdict=SHIP');
    expect(result.output).toContain('review-status=SHIP');
    expect(result.comment).toContain('Verdict: SHIP');
    expect(result.comment).toMatch(/expected policy exclusion|does not block/i);
  });

  // KNOWN GAP (pre-existing, not introduced by the legacy-path removal): a repo's plain
  // `.review-yeti.yaml` `exclude:` list is honored by the legacy/general-purpose
  // `filterReviewableFiles` selection, but boundedMode's review-unit-manifest override
  // (main()'s `authoritativeUnitPolicy` trusted-default fallback, review-pipeline.js) hard-codes
  // `rules.exclude: []` whenever `review.units.enabled` isn't ALSO configured with full trusted-
  // config bootstrapping (REVIEW_YETI_CONFIG_DIR/TRUSTED_CONFIG_DIR/TRUSTED_CONFIG_BASE_SHA + a
  // live `gh pr view` base-SHA match). Since boundedMode is unconditional now (previously this
  // was reachable only when a real PR identity happened to select it -- i.e. always in real
  // production, per the operator's own framing that bounded is "the production default"), this
  // is a real, live gap for any repo that has NOT done that trusted-config bootstrap: a plain
  // `exclude:` entry in `.review-yeti.yaml` does not exclude anything. This test documents the
  // CURRENT (buggy) behavior rather than silently asserting the feature works -- it must fail
  // loudly, not pass vacuously, once someone fixes the underlying gap.
  it('KNOWN GAP: a plain .review-yeti.yaml exclude: entry is not honored by the bounded review-unit-manifest path', async () => {
    const diff = diffWithFiles([
      'diff --git a/configured/fixture.txt b/configured/fixture.txt\n--- a/configured/fixture.txt\n+++ b/configured/fixture.txt\n@@ -1 +1 @@\n-old\n+new',
    ]);

    const result = await runMainInTempDir(diff, {
      expectedFetches: 1,
      config: 'exclude:\n  - configured/**\n',
    });

    // If this ever becomes 0 (the CORRECT behavior), the fix landed -- update this test to
    // assert the fix instead of deleting it, and drop this comment block.
    expect(result.output).toContain('files-reviewed=1');
  });

  it('does not run chat preflight before the all-skipped terminal decision', async () => {
    const diff = diffWithFiles([
      'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-old\n+new',
    ]);

    const result = await runMainInTempDir(diff, {
      expectedFetches: 0,
      runChatPreflight: true,
    });

    expect(result.output).toContain('verdict=SHIP');
  });

  it('uses an SSE request for the authentication preflight instead of a buffered ping', async () => {
    const result = await runMainInTempDir(
      'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -0,0 +1 @@\n+const safe = true;\n',
      { runChatPreflight: true },
    );

    expect(result.fetchImpl.mock.calls.length).toBeGreaterThan(0);
    expect(result.fetchImpl.mock.calls.every(([, options]: any[]) => JSON.parse(options.body).stream === true)).toBe(true);
  });

  it('renders policy-only exclusions as SHIP while keeping real coverage gaps blocked', () => {
    const { formatPRComment } = pipeline;
    const context = { repo: 'owner/repo', prNumber: '1', headSha: 'head-sha' };
    const metadataOnly = formatPRComment({
      verdict: 'SHIP',
      status: 'SHIP',
      quorumSatisfied: true,
      completedPersonas: 0,
      totalPersonas: 0,
      rationale: 'Only expected policy exclusions remained.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    }, [], context, {}, {}, {
      reviewed: [],
      skipped: [{ path: 'package-lock.json', category: 'lockfile', reason: 'lockfile' }],
      oversized: [{ path: 'src/oversized.ts', category: 'oversized', reason: 'per-file cap', diffChars: 5_001 }],
      truncated: [],
      omitted: [],
      passes: 0,
    });

    expect(metadataOnly).toContain('## 🟢 **Verdict: SHIP**');
    expect(metadataOnly).not.toContain('Verdict: BLOCK');
    expect(metadataOnly).toMatch(/expected policy exclusion|does not block/i);
    expect(metadataOnly).toContain('src/oversized.ts');

    const incomplete = formatPRComment({
      verdict: 'BLOCK',
      status: 'INCOMPLETE_REVIEW',
      quorumSatisfied: false,
      completedPersonas: 0,
      totalPersonas: 0,
      rationale: 'A whole-request budget file was not reviewed.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    }, [], context, {}, { enabled: true, model: 'm' }, {
      reviewed: [],
      skipped: [],
      oversized: [],
      omitted: ['src/omitted.ts'],
      truncated: [],
      passes: 0,
    });

    expect(incomplete).toContain('## 🔴 **Verdict: BLOCK**');
    expect(incomplete).toContain('INCOMPLETE_REVIEW');
  });

  it('ships all oversized files without model requests', async () => {
    const oversizedMarker = 'ALL_OVERSIZED_MARKER';
    const diff = diffWithFiles([
      `diff --git a/src/oversized.ts b/src/oversized.ts\n--- a/src/oversized.ts\n+++ b/src/oversized.ts\n@@ -1 +1 @@\n-${oversizedMarker}${'x'.repeat(5_000)}\n+${oversizedMarker}${'x'.repeat(5_000)}`,
    ]);

    const result = await runMainInTempDir(diff, { expectedFetches: 0 });

    expect(result.output).toContain('verdict=SHIP');
    expect(result.output).toContain('review-status=SHIP');
    expect(result.comment).not.toContain('INCOMPLETE_REVIEW');
    expect(result.comment).toMatch(/exceeded the per-file limit/i);
    expect(result.comment).toMatch(/src\/oversized\.ts.*\d[\d,]+ chars/i);
    expect(result.comment).toMatch(/expected policy exclusion|does not block/i);
    expect(JSON.stringify(result.fetchImpl.mock.calls)).not.toContain(oversizedMarker);
  });

  it('keeps intentional generated skips non-blocking when source remains eligible', async () => {
    const diff = diffWithFiles([
      'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-old\n+new',
      'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new',
    ]);

    const result = await runMainInTempDir(diff, { expectedFetches: 1 });

    expect(result.output).toContain('verdict=SHIP');
    expect(result.output).toContain('files-skipped-generated=1');
    expect(result.comment).toContain('intentionally skipped');
    expect(result.comment).not.toContain('INCOMPLETE_REVIEW');
  });

  it('treats recovered partial multi-pass lanes as complete when decision is not ERROR', () => {
    // One failed provider attempt of a multi-pass lane is telemetry, not a hard incomplete.
    expect(pipeline.reviewCoverageCompleteForArbitration(
      true,
      { omitted: [], truncated: [] },
      [{ personaId: 'security', decision: 'APPROVE', partial: 1 }],
    )).toBe(true);

    expect(pipeline.reviewCoverageCompleteForArbitration(
      true,
      { omitted: [], truncated: [] },
      [{ personaId: 'security' }],
    )).toBe(true);

    // Hard ERROR still leaves coverage incomplete.
    expect(pipeline.reviewCoverageCompleteForArbitration(
      true,
      { omitted: [], truncated: [] },
      [{ personaId: 'security', decision: 'ERROR', partial: 1 }],
    )).toBe(false);
  });

  it('explains that recovered multi-pass lanes remain visible', () => {
    const comment = pipeline.formatPRComment({
      verdict: 'BLOCK',
      status: 'INCOMPLETE_REVIEW',
      quorumSatisfied: false,
      completedPersonas: 1,
      totalPersonas: 1,
      rationale: 'A provider pass failed.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    }, [{
      personaId: 'security',
      displayName: '🛡️ Security',
      decision: 'APPROVE',
      partial: 1,
      findings: [],
    }], { repo: 'owner/repo', prNumber: '1', headSha: 'head-sha' }, {}, {}, {
      reviewed: ['src/app.ts'],
      skipped: [],
      oversized: [],
      truncated: [],
      omitted: [],
      passes: 2,
    });

    expect(comment).toContain('Recovered multi-pass lanes');
    expect(comment).not.toContain('were excluded');
  });

  it('1. Script file exists and is executable', () => {
    expect(fs.existsSync(pipelinePath)).toBe(true);
    const content = fs.readFileSync(pipelinePath, 'utf-8');
    expect(content).toContain('#!/usr/bin/env node');
  });

  it('resolves the strict per-file limit with Action input precedence', () => {
    const localConfig = {
      parsed: {
        limits: { max_diff_bytes: 90_000, max_file_diff_chars: 12_345 },
        submodules: {},
      },
    };

    const fromYaml = pipeline.resolveActionReviewPolicy(localConfig, {
      MAX_DIFF_CHARS: '90000',
      MAX_FILE_DIFF_CHARS: '',
    });
    expect(fromYaml).toMatchObject({ maxDiffChars: 90_000, maxFileDiffChars: 12_345 });

    const fromAction = pipeline.resolveActionReviewPolicy(localConfig, {
      MAX_DIFF_CHARS: '90000',
      MAX_FILE_DIFF_CHARS: '6789',
    });
    expect(fromAction).toMatchObject({ maxDiffChars: 90_000, maxFileDiffChars: 6_789 });

    expect(() => pipeline.resolveActionReviewPolicy(localConfig, {
      MAX_FILE_DIFF_CHARS: '12.5',
    })).toThrow('MAX_FILE_DIFF_CHARS must be a positive integer.');
  });

  it('2. Loads 12 persona charters with default model deepseek/deepseek-v4-flash-0731', () => {
    const { PERSONA_CHARTERS, DEFAULT_MODEL } = pipeline;
    expect(DEFAULT_MODEL).toBe('deepseek/deepseek-v4-flash-0731');
    expect(PERSONA_CHARTERS).toHaveLength(12);

    const expectedPersonas = [
      'security',
      'performance',
      'architecture',
      'style',
      'testing',
      'documentation',
      'accessibility',
      'database',
      'devops',
      'i18n',
      'dependencies',
      'licensing',
    ];

    const actualPersonas = PERSONA_CHARTERS.map((p: any) => p.id);
    expect(actualPersonas).toEqual(expectedPersonas);

    PERSONA_CHARTERS.forEach((persona: any) => {
      expect(persona.model).toBeTruthy();
      expect(persona.charter).toBeDefined();
      expect(persona.charter.length).toBeGreaterThan(10);
    });
  });

  it('3. Parses diff payload correctly', () => {
    const rawDiff = `diff --git a/src/server.ts b/src/server.ts
index 123456..789abc 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,3 +1,5 @@
 import express from 'express';
+const apiKey = "sk-proj-1234567890abcdef12345678";
`;
    const parsed = pipeline.parseDiff(rawDiff);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('src/server.ts');
    expect(parsed[0].addedLines.some((l: any) => l.text.includes('sk-proj'))).toBe(true);
  });

  it('parses deleted .github and quoted paths from diff headers without splicing old and new paths', () => {
    const rawDiff = `diff --git a/.github/workflows/old.yml b/.github/workflows/old.yml
deleted file mode 100644
--- a/.github/workflows/old.yml
+++ /dev/null
@@ -1 +0,0 @@
-name: old
diff --git "a/docs/old name.md" "b/docs/old name.md"
deleted file mode 100644
--- "a/docs/old name.md"
+++ /dev/null
@@ -1 +0,0 @@
-old`;

    expect(pipeline.parseDiff(rawDiff).map((file: any) => file.path)).toEqual([
      '.github/workflows/old.yml',
      'docs/old name.md',
    ]);
  });

  it('retains real rename, mode, and deletion metadata for deterministic review units', () => {
    const rawDiff = `diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts
diff --git a/bin/tool b/bin/tool
old mode 100644
new mode 100755
diff --git a/src/deleted.ts b/src/deleted.ts
deleted file mode 100644
--- a/src/deleted.ts
+++ /dev/null
@@ -1 +0,0 @@
-old`;
    const [renamed, modeChanged, deleted] = pipeline.parseDiff(rawDiff) as any[];

    expect(renamed).toMatchObject({ path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', similarityIndex: 100 });
    expect(modeChanged).toMatchObject({ path: 'bin/tool', oldMode: '100644', newMode: '100755', mode: '100755' });
    expect(deleted).toMatchObject({ path: 'src/deleted.ts', status: 'removed', deleted: true, oldMode: '100644' });
  });

  it('feeds parsed rename-only and deleted diffs into explicit manifest units', () => {
    const files = pipeline.parseDiff(`diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts
diff --git a/src/deleted.ts b/src/deleted.ts
deleted file mode 100644
--- a/src/deleted.ts
+++ /dev/null
@@ -1 +0,0 @@
-old`);
    const manifest = createReviewUnitManifest({
      identity: { repository: 'owner/repo', prNumber: 3, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), configDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64), diffDigest: 'e'.repeat(64) },
      files,
      trustedRules: {},
    });

    expect(manifest.units.map((unit: any) => [unit.path, unit.status, unit.change])).toEqual([
      ['src/new.ts', 'unreviewable', 'renamed'],
      ['src/deleted.ts', 'selected', 'deleted'],
    ]);
  });

  // sanitizeFindings and PRESENT_BUT_UNREVIEWED_INSTRUCTION were reviewWithModel's legacy
  // findings-validation and prompt-construction helpers, deleted with the legacy single-shot
  // path they only ever served. Equivalent coverage: malformed-finding rejection (bad line,
  // side, blank title/body) is now parseInvestigationResponse's own stricter per-field
  // validation (reviewInvestigationPrompt.test.ts); "present but unreviewed" file handling is
  // now the deferred-diff notice (reviewInvestigationPrompt.test.ts's "names every deferred
  // file" tests).


  it('4. Evaluates 12 personas in parallel and computes binding arbitration quorum', async () => {
    const { PERSONA_CHARTERS, evaluatePersonaLane, computeArbitrationQuorum } = pipeline;
    const diffFiles = [
      {
        path: 'db/migrations/001_init.sql',
        patch: 'DROP TABLE users;',
        addedLines: [{ text: 'DROP TABLE users;' }],
        deletedLines: [],
      },
    ];

    const prContext = {
      prNumber: '99',
      repo: 'review-yeti-ai/review-yeti-bot',
      headSha: 'abc1234def',
      title: 'Destructive DB Migration PR',
    };

    const results = await Promise.all(
      PERSONA_CHARTERS.map((p: any) => evaluatePersonaLane(p, diffFiles, prContext))
    );

    expect(results).toHaveLength(12);
    const dbResult = results.find((r: any) => r.personaId === 'database');
    expect(dbResult.decision).toBe('FINDINGS');
    expect(dbResult.findings[0].severity).toBe('P0');

    const arbitration = computeArbitrationQuorum(results);
    expect(arbitration.verdict).toBe('BLOCK');
    expect(arbitration.quorumSatisfied).toBe(true);
    expect(arbitration.completedPersonas).toBe(12);
  });

  it('5. Formats GitHub PR comment output with persona roster breakdown and no pipeline diagram', () => {
    const { PERSONA_CHARTERS, formatPRComment } = pipeline;
    const mockResults = PERSONA_CHARTERS.map((p: any) => ({
      personaId: p.id,
      displayName: p.name,
      model: p.model,
      decision: 'APPROVE',
      findings: [],
    }));

    const mockArbitration = {
      totalPersonas: 12,
      completedPersonas: 12,
      quorumSatisfied: true,
      verdict: 'SHIP',
      rationale: 'All 12 persona evaluations passed.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    };

    const prContext = {
      prNumber: '101',
      repo: 'review-yeti-ai/review-yeti-bot',
      headSha: '1a2b3c4d5e',
    };

    const formattedComment = formatPRComment(mockArbitration, mockResults, prContext);

    expect(formattedComment).toContain('## 🟢 **Verdict: SHIP**');
    // The flow diagram was static fan-in topology duplicating the roster table (review-yeti-ai/review-yeti-bot#31).
    expect(formattedComment).not.toContain('```mermaid');
    expect(formattedComment).not.toContain('Architectural Pipeline Flow');
    expect(formattedComment).toContain('📋 Persona Evaluation Roster');
    expect(formattedComment).toMatch(/`(openrouter\/auto(-beta)?|deepseek\/deepseek-v4-flash(-0731)?)`/);
    expect(formattedComment).toContain('🛡️ Security & Tenancy Guardian');
    expect(formattedComment).toContain('No issues detected across completed reviewer personas');
    expect(formattedComment).not.toContain('Open full review in Review Yeti');

    const linkedComment = formatPRComment(
      mockArbitration,
      mockResults,
      prContext,
      {},
      {},
      null,
      null,
      null,
      null,
      { dashboardReviewUrl: 'https://reviewyeti.ai/dashboard/reviews/j57abc123' },
    );
    expect(linkedComment).toContain('[📊 Open full review in Review Yeti ↗](https://reviewyeti.ai/dashboard/reviews/j57abc123)');
  });

  it('does not claim a clean review when persona lanes ERROR', () => {
    const { formatPRComment } = pipeline;
    const comment = formatPRComment({
      totalPersonas: 2,
      completedPersonas: 1,
      quorumSatisfied: false,
      verdict: 'BLOCK',
      status: 'INCOMPLETE_REVIEW',
      rationale: 'Blocked because 1 persona lane(s) failed.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    }, [
      {
        personaId: 'security',
        displayName: '🛡️ Security',
        model: 'deepseek/deepseek-v4-flash-0731',
        decision: 'ERROR',
        findings: [],
        error: 'Provider timeout after 180000ms (attempt 2/2)',
      },
      {
        personaId: 'testing',
        displayName: '🧪 Testing',
        model: 'deepseek/deepseek-v4-flash-0731',
        decision: 'APPROVE',
        findings: [],
      },
    ], { repo: 'o/r', prNumber: '1', headSha: 'head' }, {}, { enabled: true, model: 'deepseek/deepseek-v4-flash-0731' });

    expect(comment).toContain('Failed persona lanes');
    expect(comment).toContain('timeout');
    expect(comment).toContain('not a clean review');
    expect(comment).not.toContain('No issues detected across enabled reviewer personas');
    expect(comment).not.toMatch(/🎉 \*\*No issues detected across completed/);
  });

  it('uses persona ids and stable fallbacks instead of undefined diagnostic labels', () => {
    const comment = pipeline.formatPRComment({
      totalPersonas: 1,
      completedPersonas: 0,
      quorumSatisfied: false,
      verdict: 'BLOCK',
      status: 'INCOMPLETE_REVIEW',
      rationale: 'Provider response was invalid.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    }, [{
      personaId: 'security',
      decision: 'ERROR',
      findings: [],
      failure: {
        class: 'semantic_invalid_response',
        reason: 'empty_response',
        personaId: 'security',
        providerRoute: 'azure',
        model: 'openai/gpt-5.6-luna',
        attempt: 2,
        generationId: 'gen-empty',
      },
      error: 'malformed_response',
    }], { repo: 'o/r', prNumber: '1', headSha: 'head' }, {}, { enabled: true, model: 'openai/gpt-5.6-luna' });

    expect(comment).toContain('| security | `security` | `azure` | `openai/gpt-5.6-luna` | `semantic_invalid_response` | empty_response | 2 | `gen-empty` |');
    expect(comment).not.toContain('undefined');
  });

  it('always requests a streamed response and resolves provider/model from SSE metadata', async () => {
    const { callOpenRouterChat } = pipeline;
    let seenBody = '';
    const fetchImpl = async (_url: string, init: any) => {
      seenBody = String(init.body || '');
      const payload = {
        id: 'gen-stream-1',
        model: 'anthropic/claude-sonnet-4',
        provider: 'Anthropic',
        choices: [{ delta: { content: '{"findings":[]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 },
      };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: sseBody(payload),
      };
    };

    const result = await callOpenRouterChat(fetchImpl as any, {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { Authorization: 'Bearer test' },
      body: { model: 'deepseek/deepseek-v4-flash-0731', messages: [] },
      timeoutMs: 5_000,
    });

    expect(JSON.parse(seenBody).stream).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.streamed).toBe(true);
    expect(result.provider).toBe('Anthropic');
    expect(result.model).toBe('anthropic/claude-sonnet-4');
  });

  it('fails closed on an HTTP/2 StreamReset 502 without a buffered retry', async () => {
    const { callOpenRouterChat } = pipeline;
    let calls = 0;
    const fetchImpl = async (_url: string, init: any) => {
      calls += 1;
      const body = JSON.parse(String(init.body || '{}'));
      if (body.stream === true) {
        return {
          ok: false,
          status: 502,
          headers: { get: () => null },
          text: async () => '<StreamReset stream_id:35, error_code:1, remote_reset:True>',
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected non-stream retry: ${JSON.stringify(body)}`);
    };

    const result = await callOpenRouterChat(fetchImpl as any, {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { Authorization: 'Bearer test' },
      body: { model: 'deepseek/deepseek-v4-flash-0731', messages: [] },
      timeoutMs: 5_000,
    });

    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.streamed).toBe(true);
    expect(result.status).toBe(502);
    expect(result.model).toBe('deepseek/deepseek-v4-flash-0731');
  });

  it('formats a pre-review started comment with trigger metadata', () => {
    const { formatStartedComment } = pipeline;
    const body = formatStartedComment(
      { repo: 'review-yeti-ai/review-yeti-bot', prNumber: '56', headSha: 'abcdef123456' },
      {
        trigger: 'pull_request',
        eventAction: 'synchronize',
        actor: 'example-user',
        model: 'deepseek/deepseek-v4-flash-0731',
        personaCount: 12,
        runUrl: 'https://github.com/review-yeti-ai/review-yeti-bot/actions/runs/1',
        workflow: 'Review Bot',
      },
    );
    expect(body).toContain('Review started');
    expect(body).toContain('pull_request / synchronize');
    expect(body).toContain('deepseek/deepseek-v4-flash-0731');
    expect(body).toContain('12 (parallel)');
    expect(body).toContain('open run');
    expect(body).toContain('not** the verdict');
  });

  it('surfaces the resolved upstream provider + model on failed persona lanes (not just auto-beta)', () => {
    const { formatPRComment, formatRouteLabel, resolveRouteMeta } = pipeline;
    expect(formatRouteLabel({ provider: 'OpenAI', model: 'openai/gpt-5' })).toBe(
      'provider=OpenAI model=openai/gpt-5',
    );
    expect(resolveRouteMeta({
      id: 'gen-abc',
      model: 'anthropic/claude-sonnet-4',
      provider: 'Anthropic',
    }, 'deepseek/deepseek-v4-flash-0731')).toEqual({
      model: 'anthropic/claude-sonnet-4',
      provider: 'Anthropic',
      generationId: 'gen-abc',
    });

    const comment = formatPRComment({
      totalPersonas: 2,
      completedPersonas: 0,
      quorumSatisfied: false,
      verdict: 'BLOCK',
      status: 'INCOMPLETE_REVIEW',
      rationale: 'Blocked because 2 persona lane(s) failed.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    }, [
      {
        personaId: 'security',
        displayName: '🛡️ Security',
        provider: 'OpenAI',
        model: 'openai/gpt-5',
        decision: 'ERROR',
        findings: [],
        error: 'Provider timeout after 180000ms (attempt 2/2) [provider=OpenAI model=openai/gpt-5]',
      },
      {
        personaId: 'licensing',
        displayName: '📜 Licensing',
        // Requested router id only — resolved route is retained on the semantic failure.
        model: 'openrouter/auto-beta',
        provider: 'openrouter',
        decision: 'ERROR',
        findings: [],
        error: 'malformed_response',
        failure: {
          class: 'semantic_invalid_response',
          reason: 'unknown_response_fields',
          route: { provider: 'ExampleCloud', model: 'deepseek/deepseek-v4-flash-0731' },
        },
      },
    ], { repo: 'o/r', prNumber: '1', headSha: 'head' }, {}, { enabled: true, model: 'deepseek/deepseek-v4-flash-0731' });

    expect(comment).toContain('| Persona | Persona ID | Provider | Model | Error class | Reason | Attempt | Generation |');
    expect(comment).toContain('| 🛡️ Security | `security` | `OpenAI` | `openai/gpt-5` | `timeout` |');
    // Structured semantic failures retain their resolved route without publishing model output.
    expect(comment).toContain('| 📜 Licensing | `licensing` | `ExampleCloud` | `deepseek/deepseek-v4-flash-0731` | `semantic_invalid_response` | unknown_response_fields |');
    expect(comment).toContain('resolved direct transport or downstream OpenRouter provider');
  });

  it('keeps review outcomes in a compact roster and moves telemetry into collapsible details', () => {
    const { formatPRComment } = pipeline;
    const results = [
      {
        personaId: 'security',
        displayName: 'Security | Guardian',
        provider: 'OpenAI',
        model: 'openai/gpt-5.6-luna',
        decision: 'FINDINGS',
        fallbackUsed: true,
        fallbackModel: 'deepseek/deepseek-v4-flash-0731',
        findings: [
          { severity: 'P0', path: 'src/a.ts', line: 1, title: 'Critical', body: 'Critical issue' },
          { severity: 'P1', path: 'src/a.ts', line: 2, title: 'Required', body: 'Required issue' },
          { severity: 'P2', path: 'src/a.ts', line: 3, title: 'Nit', body: 'Minor issue' },
        ],
        usage: { promptTokens: 100, completionTokens: 20, costUSD: 0.0074 },
      },
      {
        personaId: 'testing',
        displayName: 'Testing',
        provider: 'openrouter',
        model: 'anthropic/claude-3.5-sonnet',
        decision: 'APPROVE',
        findings: [],
        usage: { promptTokens: 200, completionTokens: 40, costUSD: 0.0063 },
      },
    ];
    const comment = formatPRComment({
      totalPersonas: 2,
      completedPersonas: 2,
      quorumSatisfied: true,
      verdict: 'BLOCK',
      rationale: 'Critical issue found.',
      metrics: { p0Count: 1, p1Count: 1, p2Count: 1, totalFindings: 3 },
    }, results, { repo: 'o/r', prNumber: '1', headSha: 'head' });

    expect(comment).toContain('| Reviewer | Decision | Findings | Cost |');
    expect(comment).not.toContain('| Reviewer | Model | Decision |');
    expect(comment).toContain('| Security \\| Guardian | ⚠️ FINDINGS | P0 1 · P1 1 · P2 1 | $0.0074 |');
    expect(comment).toContain('| Testing | ✅ APPROVE | None | $0.0063 |');
    expect(comment).toContain('| **Total** | — | **P0 1 · P1 1 · P2 1** | **$0.0137** |');
    expect(comment).toContain('<summary><b>Model and usage details</b> (300 in / 60 out)</summary>');
    expect(comment).toContain('- **Security \\| Guardian**<br>Model: `openai/gpt-5.6-luna` via `OpenAI`<br>Fallback used: `deepseek/deepseek-v4-flash-0731`');
    expect(comment).toContain('Usage: 100 in / 20 out');
    expect(comment).toMatch(/Turns:\s*1/);
    expect(comment).not.toContain('P3');
  });

  it('marks an incomplete total cost as a lower bound and sanitizes Markdown cells', () => {
    const { formatPRComment } = pipeline;
    const comment = formatPRComment({
      totalPersonas: 2,
      completedPersonas: 2,
      quorumSatisfied: true,
      verdict: 'SHIP',
      rationale: 'Clean.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    }, [
      {
        personaId: 'security',
        displayName: 'A `reviewer` | one',
        provider: 'Open|AI',
        model: 'model`name',
        decision: 'APPROVE',
        findings: [],
        usage: { promptTokens: 1, completionTokens: 2, costUSD: 0.001 },
      },
      {
        personaId: 'testing',
        displayName: 'Testing',
        model: 'fallback',
        decision: 'APPROVE',
        findings: [],
        usage: { promptTokens: 3, completionTokens: 4 },
      },
    ], { repo: 'o/r', prNumber: '1', headSha: 'head' });

    expect(comment).toContain("| A 'reviewer' \\| one | ✅ APPROVE | None | $0.0010 |");
    expect(comment).toContain('| **Total** | — | **None** | **≥$0.0010** |');
    expect(comment).toContain("- **A 'reviewer' \\| one**<br>Model: `model'name` via `Open|AI`");
    expect(comment).toContain('Usage: 1 in / 2 out');
    expect(comment).toMatch(/Turns:\s*1/);
    expect(comment).toContain('<summary><b>Model and usage details</b> (4 in / 6 out)</summary>');
  });

  it('uses the authoritative run cost for the total when lane costs are incomplete', () => {
    const comment = pipeline.formatPRComment({
      totalPersonas: 2,
      completedPersonas: 2,
      quorumSatisfied: true,
      verdict: 'SHIP',
      rationale: 'Clean.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    }, [
      {
        personaId: 'security',
        displayName: 'Security',
        decision: 'APPROVE',
        findings: [],
        usage: { promptTokens: 1, completionTokens: 2, costUSD: 0.001 },
      },
      {
        personaId: 'testing',
        displayName: 'Testing',
        decision: 'APPROVE',
        findings: [],
        usage: { promptTokens: 3, completionTokens: 4 },
      },
    ], { repo: 'o/r', prNumber: '1', headSha: 'head' }, {}, {}, null, {
      totalTokens: 10,
      promptTokens: 4,
      completionTokens: 6,
      costUSD: 0.0042,
    });

    expect(comment).toContain('| **Total** | — | **None** | **$0.0042** |');
    expect(comment).not.toContain('≥$0.0010');
  });

  it('does not turn an all-zero fallback usage block into a fabricated cost', () => {
    const comment = pipeline.formatPRComment({
      totalPersonas: 1,
      completedPersonas: 1,
      quorumSatisfied: true,
      verdict: 'SHIP',
      rationale: 'Clean.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    }, [{
      personaId: 'security',
      displayName: 'Security',
      model: 'deepseek/deepseek-v4-flash-0731',
      decision: 'APPROVE',
      findings: [],
      usage: { promptTokens: 0, completionTokens: 0, costUSD: 0 },
    }], { repo: 'o/r', prNumber: '1', headSha: 'head' });

    expect(comment).toContain('| Security | ✅ APPROVE | None | — |');
    expect(comment).toContain('- **Security**<br>Model: `deepseek/deepseek-v4-flash-0731` via `unresolved model transport`');
    expect(comment).toContain('Usage: 0 in / 0 out');
    expect(comment).toMatch(/Turns:\s*1/);
    expect(comment).toContain('<summary><b>Model and usage details</b> (0 in / 0 out)</summary>');
    expect(comment).not.toContain('NaN');
  });

  it('keeps partial token telemetry visible when only one token direction is available', () => {
    const comment = pipeline.formatPRComment({
      totalPersonas: 1,
      completedPersonas: 1,
      quorumSatisfied: true,
      verdict: 'SHIP',
      rationale: 'Clean.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    }, [{
      personaId: 'security',
      displayName: 'Security',
      model: 'deepseek/deepseek-v4-flash-0731',
      decision: 'APPROVE',
      findings: [],
      usage: { completionTokens: 5, costUSD: 0.001 },
    }], { repo: 'o/r', prNumber: '1', headSha: 'head' });

    expect(comment).toContain('| Security | ✅ APPROVE | None | $0.0010 |');
    expect(comment).toContain('<summary><b>Model and usage details</b> (— in / 5 out)</summary>');
    expect(comment).toContain('Usage: — in / 5 out');
  });

  it('does not present a failed reviewer lane as having zero findings', () => {
    const comment = pipeline.formatPRComment({
      totalPersonas: 1,
      completedPersonas: 0,
      quorumSatisfied: false,
      verdict: 'BLOCK',
      rationale: 'Reviewer failed.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    }, [{
      personaId: 'architecture',
      displayName: 'Architecture',
      model: 'deepseek/deepseek-v4-flash-0731',
      decision: 'ERROR',
      findings: [],
      usage: { promptTokens: 0, completionTokens: 0, costUSD: 0 },
    }], { repo: 'o/r', prNumber: '1', headSha: 'head' });

    expect(comment).toContain('| Architecture | ❌ ERROR | Not reviewed | — |');
    expect(comment).toContain('| **Total** | — | **None** | — |');
    expect(comment).not.toContain('| Architecture | ❌ ERROR | P0 0');
  });

  it('does not round a positive sub-millicent reviewer cost down to zero', () => {
    const comment = pipeline.formatPRComment({
      totalPersonas: 1,
      completedPersonas: 1,
      quorumSatisfied: true,
      verdict: 'SHIP',
      rationale: 'Clean.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    }, [{
      personaId: 'security',
      displayName: 'Security',
      model: 'deepseek/deepseek-v4-flash-0731',
      decision: 'APPROVE',
      findings: [],
      usage: { promptTokens: 10, completionTokens: 2, costUSD: 0.0004 },
    }], { repo: 'o/r', prNumber: '1', headSha: 'head' });

    expect(comment).toContain('| Security | ✅ APPROVE | None | $0.0004 |');
    expect(comment).not.toContain('$0.0000');
  });

  it('shows only non-zero severity counts in the findings column', () => {
    const comment = pipeline.formatPRComment({
      totalPersonas: 1,
      completedPersonas: 1,
      quorumSatisfied: true,
      verdict: 'FIX_FIRST',
      rationale: 'One advisory.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 1, totalFindings: 1 },
    }, [{
      personaId: 'testing',
      displayName: 'Testing',
      model: 'deepseek/deepseek-v4-flash-0731',
      decision: 'FINDINGS',
      findings: [{ severity: 'P2', path: 'src/a.ts', line: 1, title: 'Nit', body: 'Minor issue' }],
      usage: { promptTokens: 10, completionTokens: 2, costUSD: 0.0004 },
    }], { repo: 'o/r', prNumber: '1', headSha: 'head' });

    expect(comment).toContain('| Testing | ⚠️ FINDINGS | P2 1 | $0.0004 |');
    expect(comment).toContain('| **Total** | — | **P2 1** | **$0.0004** |');
    expect(comment).not.toContain('P0 0 · P1 0');
  });

  it('6. Executes main pipeline cleanly without unhandled exceptions', async () => {
    // main() verifies the PR head against a live `gh pr view` on anything it
    // considers a real runner, and deliberately ignores workflow-supplied
    // overrides to do so. On a GitHub Actions runner that makes this test call
    // the network for a PR that does not exist. The synthetic-vitest path
    // requires BOTH GITHUB_ACTIONS unset and GITHUB_EVENT_PATH absent, and a
    // real runner sets both — so clear both for the duration. The production
    // invariant is unchanged and covered by test 6a below.
    const runnerEnv = ['GITHUB_ACTIONS', 'GITHUB_EVENT_PATH'] as const;
    const savedRunnerEnv = runnerEnv.map((key) => [key, process.env[key]] as const);
    runnerEnv.forEach((key) => { delete process.env[key]; });

    // Set environment variables for test execution
    process.env.PR_NUMBER = '777';
    // A positive prNumber alone used to be enough to stay off the bounded review-unit-manifest
    // path (it also required immutable SHAs); now that boundedMode is unconditional, the
    // manifest identity needs real 40-hex SHAs too, or createReviewUnitManifest throws.
    process.env.PR_HEAD_SHA = 'e'.repeat(40);
    process.env.GITHUB_BASE_SHA = 'f'.repeat(40);
    process.env.ACTIVE_PERSONAS = JSON.stringify(['security', 'architecture', 'performance', 'quality', 'database', 'api_contract', 'docs_compliance', 'reliability', 'devops', 'finops', 'red_team', 'review_flowchart']);
    process.env.PR_DIFF = `diff --git a/README.md b/README.md
+ ## Documentation update
`;
    try {
      await expect(pipeline.main()).resolves.not.toThrow();
    } finally {
      savedRunnerEnv.forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });

  it('6a. Verifies the PR head on a real runner even when PR_DIFF is supplied', () => {
    // The synthetic-vitest escape hatch must never engage on GITHUB_ACTIONS=true,
    // otherwise a workflow-supplied PR_DIFF could skip exact-head verification.
    const source = fs.readFileSync(pipelinePath, 'utf-8');
    expect(source).toContain("runtimeEnv.GITHUB_ACTIONS !== 'true'");

    const commandRunner = () => ({ status: 1, stdout: '', stderr: 'no such PR' });
    expect(() => pipeline.assertCurrentPullRequest(
      { repo: 'o/r', prNumber: '777', headSha: 'head' },
      { commandRunner },
    )).toThrow('Unable to verify the current PR head');
  });

  // =========================================================================
  // EDGE CASE & RESILIENCE STRESS TESTS
  // =========================================================================

  describe('Edge Cases: Diff Parsing & Environment Context', () => {
    it('7. Handles empty, null, undefined, and non-git diff inputs safely', () => {
      expect(pipeline.parseDiff('')).toEqual([]);
      expect(pipeline.parseDiff(null)).toEqual([]);
      expect(pipeline.parseDiff(undefined)).toEqual([]);

      // Raw unformatted diff fallback to src/index.ts
      const rawText = '+ console.log("hello world");';
      const parsedRaw = pipeline.parseDiff(rawText);
      expect(parsedRaw).toHaveLength(1);
      expect(parsedRaw[0].path).toBe('src/index.ts');
      expect(parsedRaw[0].addedLines[0].text).toBe(' console.log("hello world");');
    });

    it('8. Handles JSON payload in PR_DIFF environment variable correctly', () => {
      const originalEnv = process.env.PR_DIFF;
      const originalEventPath = process.env.GITHUB_EVENT_PATH;
      const originalSha = process.env.GITHUB_SHA;
      try {
        delete process.env.GITHUB_EVENT_PATH;
        delete process.env.GITHUB_SHA;
        process.env.PR_DIFF = JSON.stringify({
          diff: 'diff --git a/src/api/user.ts b/src/api/user.ts\n+ const x = 1;\n',
          prNumber: 42,
          repo: 'custom/repo',
          headSha: 'cafebabe1234',
          title: 'Custom JSON Title',
        });
        const ctx = pipeline.getPRDiffAndContext();
        expect(ctx.prNumber).toBe('42');
        expect(ctx.repo).toBe('custom/repo');
        expect(ctx.headSha).toBe('cafebabe1234');
        expect(ctx.title).toBe('Custom JSON Title');
        expect(ctx.diffText).toContain('src/api/user.ts');
      } finally {
        process.env.PR_DIFF = originalEnv;
        if (originalEventPath === undefined) delete process.env.GITHUB_EVENT_PATH;
        else process.env.GITHUB_EVENT_PATH = originalEventPath;
        if (originalSha === undefined) delete process.env.GITHUB_SHA;
        else process.env.GITHUB_SHA = originalSha;
      }
    });

    it('9. Handles invalid JSON in PR_DIFF cleanly as raw diff text fallback', () => {
      const originalEnv = process.env.PR_DIFF;
      try {
        process.env.PR_DIFF = '{ invalid json payload... diff --git a/foo.ts b/foo.ts';
        const ctx = pipeline.getPRDiffAndContext();
        expect(ctx.diffText).toContain('{ invalid json payload');
      } finally {
        process.env.PR_DIFF = originalEnv;
      }
    });
  });

  describe('Edge Cases: Persona Evaluation Rules across all 12 Personas', () => {
    const { PERSONA_CHARTERS, evaluatePersonaLane } = pipeline;
    const aliasMap: Record<string, string> = {
      quality: 'style',
      reliability: 'testing',
      docs_compliance: 'documentation',
      api_contract: 'accessibility',
      finops: 'i18n',
      red_team: 'dependencies',
      review_flowchart: 'licensing',
    };
    const findPersona = (id: string) =>
      PERSONA_CHARTERS.find((p: any) => p.id === id || p.id === aliasMap[id]);

    it('10. Security persona flags hardcoded secrets and missing tenancy checks', async () => {
      const secPersona = findPersona('security');

      // Secret detection (P0) - alphanumeric token
      const diffSecret = [{
        path: 'src/config.ts',
        patch: '+ const token = "sk-0123456789abcdef0123456789";\n',
        addedLines: [{ text: ' const token = "sk-0123456789abcdef0123456789";' }],
      }];
      const resSecret = await evaluatePersonaLane(secPersona, diffSecret, {});
      expect(resSecret.decision).toBe('FINDINGS');
      expect(resSecret.findings[0].severity).toBe('P0');
      expect(resSecret.findings[0].title).toBe('Hardcoded Secret Detected');

      // Tenancy check (P1)
      const diffApiNoAuth = [{
        path: 'src/api/users.ts',
        patch: '+ app.get("/api/users", (req, res) => { const id = req.query.id; });\n',
        addedLines: [{ text: ' app.get("/api/users", (req, res) => { const id = req.query.id; });' }],
      }];
      const resTenancy = await evaluatePersonaLane(secPersona, diffApiNoAuth, {});
      expect(resTenancy.decision).toBe('FINDINGS');
      expect(resTenancy.findings.some((f: any) => f.severity === 'P1')).toBe(true);
    });

    it('11. Performance persona flags async sequential loops and sync I/O in API hot path', async () => {
      const perfPersona = findPersona('performance');

      // Async loop (P1)
      const diffLoop = [{
        path: 'src/services/fetcher.ts',
        patch: '+ for (const id of ids) { await fetch(id); }\n',
        addedLines: [{ text: ' for (const id of ids) { await fetch(id); }' }],
      }];
      const resLoop = await evaluatePersonaLane(perfPersona, diffLoop, {});
      expect(resLoop.decision).toBe('FINDINGS');
      expect(resLoop.findings[0].severity).toBe('P1');
      expect(resLoop.findings[0].title).toBe('N+1 Query / Async Sequential Loop');

      // Sync I/O in API hot path (P2)
      const diffSync = [{
        path: 'src/server/api/handler.ts',
        patch: '+ const data = fs.readFileSync("/tmp/data");\n',
        addedLines: [{ text: ' const data = fs.readFileSync("/tmp/data");' }],
      }];
      const resSync = await evaluatePersonaLane(perfPersona, diffSync, {});
      expect(resSync.decision).toBe('FINDINGS');
      expect(resSync.findings[0].severity).toBe('P2');
      expect(resSync.findings[0].title).toBe('Synchronous Blocking I/O in API Hot Path');
    });

    it('12. Architecture persona flags deep cross-layer coupling', async () => {
      const archPersona = findPersona('architecture');
      const diffArch = [{
        path: 'src/domain/userEntity.ts',
        patch: '+ import { UserView } from "../../../presentation/views";\n',
        addedLines: [{ text: ' import { UserView } from "../../../presentation/views";' }],
      }];
      const resArch = await evaluatePersonaLane(archPersona, diffArch, {});
      expect(resArch.decision).toBe('FINDINGS');
      expect(resArch.findings[0].severity).toBe('P2');
      expect(resArch.findings[0].title).toBe('Layer Boundary Coupling Hazard');
    });

    it('13. Quality persona flags console.log debug statements', async () => {
      const stylePersona = findPersona('quality');
      const diffStyle = [{
        path: 'src/utils/math.ts',
        patch: '+ console.log("debug math");\n',
        addedLines: [{ text: ' console.log("debug math");' }],
      }];
      const resStyle = await evaluatePersonaLane(stylePersona, diffStyle, {});
      expect(resStyle.decision).toBe('FINDINGS');
      expect(resStyle.findings[0].severity).toBe('P2');
      expect(resStyle.findings[0].title).toBe('Leftover Debug Statement');
    });

    it('14. Reliability persona flags active .only() markers', async () => {
      const testPersona = findPersona('reliability');
      const diffTest = [{
        path: 'tests/unit/app.test.ts',
        patch: '+ describe.only("focused suite", () => {});\n',
        addedLines: [{ text: ' describe.only("focused suite", () => {});' }],
      }];
      const resTest = await evaluatePersonaLane(testPersona, diffTest, {});
      expect(resTest.decision).toBe('FINDINGS');
      expect(resTest.findings[0].severity).toBe('P1');
      expect(resTest.findings[0].title).toBe('Exclusive Test Marker Left Active');
    });

    it('15. Docs compliance persona flags exported functions without JSDoc', async () => {
      const docPersona = findPersona('docs_compliance');
      const diffDoc = [{
        path: 'src/lib/calculator.ts',
        patch: '+ export function add(a: number, b: number) { return a + b; }\n',
        addedLines: [{ text: ' export function add(a: number, b: number) { return a + b; }' }],
      }];
      const resDoc = await evaluatePersonaLane(docPersona, diffDoc, {});
      expect(resDoc.decision).toBe('FINDINGS');
      expect(resDoc.findings[0].severity).toBe('P2');
      expect(resDoc.findings[0].title).toBe('Missing Docstring / JSDoc Annotation');
    });

    it('16. API contract persona flags img elements missing alt attribute', async () => {
      const a11yPersona = findPersona('api_contract');
      const diffA11y = [{
        path: 'src/components/Avatar.tsx',
        patch: '+ return <img src="/logo.png" />;\n',
        addedLines: [{ text: ' return <img src="/logo.png" />;' }],
      }];
      const resA11y = await evaluatePersonaLane(a11yPersona, diffA11y, {});
      expect(resA11y.decision).toBe('FINDINGS');
      expect(resA11y.findings[0].severity).toBe('P2');
      expect(resA11y.findings[0].title).toBe('Image Missing Alt Text (WCAG 2.1)');
    });

    it('17. Database persona flags DROP COLUMN destructive migrations', async () => {
      const dbPersona = findPersona('database');
      const diffDb = [{
        path: 'db/migrations/002_drop.sql',
        patch: '+ ALTER TABLE users DROP COLUMN phone;\n',
        addedLines: [{ text: ' ALTER TABLE users DROP COLUMN phone;' }],
      }];
      const resDb = await evaluatePersonaLane(dbPersona, diffDb, {});
      expect(resDb.decision).toBe('FINDINGS');
      expect(resDb.findings[0].severity).toBe('P0');
      expect(resDb.findings[0].title).toBe('Destructive DDL Schema Migration Hazard');
    });

    it('18. DevOps persona flags Dockerfile missing non-root USER directive', async () => {
      const devopsPersona = findPersona('devops');
      const diffDevops = [{
        path: 'Dockerfile',
        patch: '+ ENTRYPOINT ["node", "dist/index.js"]\n',
        addedLines: [{ text: ' ENTRYPOINT ["node", "dist/index.js"]' }],
      }];
      const resDevops = await evaluatePersonaLane(devopsPersona, diffDevops, {});
      expect(resDevops.decision).toBe('FINDINGS');
      expect(resDevops.findings[0].severity).toBe('P1');
      expect(resDevops.findings[0].title).toBe('Container Non-Root User Missing');
    });

    it('19. FinOps persona flags hardcoded string in UI components', async () => {
      const i18nPersona = findPersona('finops');
      const diffI18n = [{
        path: 'src/components/Header.tsx',
        patch: '+ return <h1>Welcome User</h1>;\n',
        addedLines: [{ text: ' return <h1>Welcome User</h1>;' }],
      }];
      const resI18n = await evaluatePersonaLane(i18nPersona, diffI18n, {});
      expect(resI18n.decision).toBe('FINDINGS');
      expect(resI18n.findings[0].severity).toBe('P2');
      expect(resI18n.findings[0].title).toBe('Hardcoded User Interface Text String');
    });

    it('20. Red team persona flags unpinned wildcard dependencies', async () => {
      const depPersona = findPersona('red_team');
      const diffDep = [{
        path: 'package.json',
        patch: '+ "express": "*"\n',
        addedLines: [{ text: ' "express": "*"' }],
      }];
      const resDep = await evaluatePersonaLane(depPersona, diffDep, {});
      expect(resDep.decision).toBe('FINDINGS');
      expect(resDep.findings[0].severity).toBe('P1');
      expect(resDep.findings[0].title).toBe('Unpinned Wildcard Dependency Version');
    });

    it('21. Review flowchart persona flags missing headers in large source files', async () => {
      const licPersona = findPersona('review_flowchart');
      const addedLines = Array(60).fill({ text: 'const line = 1;' });
      const diffLic = [{
        path: 'src/largeModule.ts',
        patch: addedLines.map(l => '+' + l.text).join('\n'),
        addedLines,
      }];
      const resLic = await evaluatePersonaLane(licPersona, diffLic, {});
      expect(resLic.decision).toBe('FINDINGS');
      expect(resLic.findings[0].severity).toBe('P2');
      expect(resLic.findings[0].title).toBe('Missing License Header Notice');
    });
  });

  describe('Edge Cases & Quorum Thresholds: computeArbitrationQuorum', () => {
    const { computeArbitrationQuorum } = pipeline;
    // Distinct files, not just distinct line numbers on one boilerplate title/body: these tests are
    // pinning threshold *counting*, and computeArbitration now clusters near-duplicate claims
    // (claimSimilarity.compareClaims) before counting severities. compareClaims requires a path
    // match before it looks at claim text, so distinct paths guarantee these stay N distinct
    // findings regardless of title/body wording, which is what "threshold scales with N genuinely
    // different findings" needs to test -- decoupled from the separate dedup behavior pinned in
    // tests/unit/reviewArbitrationJudgment.test.ts.
    const finding = (severity: 'P0' | 'P1' | 'P2', line: number) => ({
      severity,
      path: `src/app-${line}.ts`,
      line,
      title: `${severity} finding ${line}`,
      body: 'Concrete issue.',
    });

    it('22. Computes FIX_FIRST for 1 P1 finding or 5+ P2 findings', () => {
      const resultsP1 = [{ findings: [finding('P1', 1)] }];
      const quorumP1 = computeArbitrationQuorum(resultsP1 as any);
      expect(quorumP1.verdict).toBe('FIX_FIRST');

      const resultsP2 = [{
        findings: [
          finding('P2', 1),
          finding('P2', 2),
          finding('P2', 3),
          finding('P2', 4),
          finding('P2', 5),
        ],
      }];
      const quorumP2 = computeArbitrationQuorum(resultsP2 as any);
      expect(quorumP2.verdict).toBe('FIX_FIRST');
    });

    it('23. Computes BLOCK for 3+ P1 findings or 1 P0 finding', () => {
      const resultsP1s = [
        { findings: [finding('P1', 1), finding('P1', 2), finding('P1', 3)] },
      ];
      const quorumP1s = computeArbitrationQuorum(resultsP1s as any);
      expect(quorumP1s.verdict).toBe('BLOCK');
    });
  });

  describe('Stress & Performance Testing', () => {
    it('24. Stress test: Evaluates 50 files and 2,000 diff lines across all 12 personas in parallel (<1000ms)', async () => {
      const { PERSONA_CHARTERS, evaluatePersonaLane, computeArbitrationQuorum } = pipeline;

      // Generate 50 simulated file diffs with mixed content
      const diffFiles = [];
      for (let i = 0; i < 50; i++) {
        diffFiles.push({
          path: `src/module_${i}/service_${i}.ts`,
          patch: `+ export function handle_${i}() {\n+   console.log("processing ${i}");\n+   return ${i};\n+ }\n`,
          addedLines: [
            { text: ` export function handle_${i}() {` },
            { text: `   console.log("processing ${i}");` },
            { text: `   return ${i};` },
            { text: ` }` },
          ],
        });
      }

      const startTime = Date.now();
      const results = await Promise.all(
        PERSONA_CHARTERS.map((persona: any) => evaluatePersonaLane(persona, diffFiles, {}))
      );
      const durationMs = Date.now() - startTime;

      expect(results).toHaveLength(12);
      expect(durationMs).toBeLessThan(1000); // Expect sub-second parallel execution

      const arbitration = computeArbitrationQuorum(results);
      expect(arbitration.completedPersonas).toBe(12);
      expect(arbitration.quorumSatisfied).toBe(true);
      expect(['SHIP', 'FIX_FIRST', 'BLOCK']).toContain(arbitration.verdict);
    });
  });

  // "The default is bounded" is exactly what let the legacy single-shot path rot undetected for
  // as long as it did: reviewWithModel's non-bounded prompt-building/parsing branch and the local
  // (non-imported) runPersonaInvestigation loop were reachable whenever boundedMode was false --
  // which happened whenever a caller supplied a non-immutable SHA or a non-numeric prNumber (every
  // unit test in this repo, until this suite was fixed alongside the deletion) or explicitly
  // passed options.boundedReview: false. These tests prove there is no such branch left to reach,
  // not merely that the common case selects the bounded one.
  describe('no reachable non-bounded review path', () => {
    it('options.boundedReview has no effect -- there is no legacy branch left to select with it', async () => {
      const diff = diffWithFiles([
        'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new',
      ]);

      // boundedReview: false used to select the local (non-imported) legacy runPersonaInvestigation
      // loop whenever it also lacked a real PR identity. Both are gone now; passing it must be a
      // silent no-op, not a way to reach different code.
      const result = await runMainInTempDir(diff, { expectedFetches: 1, mainOptions: { boundedReview: false } });

      expect(result.output).toContain('verdict=SHIP');
      // Markers only the bounded review-unit-manifest dispatch ever produces (review dispatch
      // receipt fields, investigation status/receipt) -- present here proves boundedReview: false
      // did not downgrade this run to some other path.
      expect(result.output).toMatch(/investigation-status=/);
      expect(result.output).toMatch(/investigation-receipt=/);
      expect(result.output).toMatch(/evidence-calls=/);
    });

    it('reviewWithModel has no legacy fallback: it throws rather than silently building its own prompt when no investigationMessages is supplied', async () => {
      await expect(pipeline.reviewWithModel(
        pipeline.PERSONA_CHARTERS[0],
        [{ path: 'src/a.ts', patch: '+x' }],
        { repo: 'o/r', prNumber: '1' },
        null,
        { apiKey: 'k' },
      )).rejects.toThrow(/investigationMessages/);
    });

    it('the legacy findings-only parser and the local (non-bounded) investigation loop are gone as exports, not merely unreachable in practice', () => {
      expect(pipeline.runPersonaInvestigation).toBeUndefined();
      expect(pipeline.parseFindingsPayload).toBeUndefined();
      expect(pipeline.sanitizeFindings).toBeUndefined();
    });
  });
});
