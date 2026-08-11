# Review Yeti CLI and Operational Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a first-class local `reviewyeti review` CLI over the production bounded review engine and prove Action/CLI receipt equivalence, operability, cost, latency, and rollback behavior.

**Architecture:** Add source adapters and a no-publication execution mode around the canonical `runReviewPipeline` runtime; do not copy orchestration or model logic into the CLI. Package a small Node executable that validates one source mode, resolves credentials without persisting them, writes the same versioned review receipt atomically, and maps incomplete execution to nonzero exit status. Extend the generic evaluation harness and operator documentation with exact-head Action/CLI equivalence and live provider receipts.

**Tech Stack:** Node.js 20, CommonJS runtime, TypeScript CLI parser/types compiled by `tsc`, Vitest 4, GitHub REST API, native `fetch`, atomic filesystem rename, existing bounded review contracts and Action cassette harness.

## Global Constraints

- Start PR 2 from the merged PR 1 commit on `upstream/main`; do not stack it on an unmerged PR 1 branch when opening the ready PR.
- The CLI must call `src/runtime/reviewPipelineRuntime.js`; it may not import a second panel engine or reproduce review semantics.
- Exactly one source mode is required: `--base <sha> --head <sha>`, `--diff-file <path>`, or `--pr <owner/repo#number|url>`.
- `--json` emits one pure JSON document to stdout. Diagnostics and progress go to stderr.
- `--output <path>` writes atomically through a same-directory temporary file, `fsync`, rename, and cleanup on failure/cancellation.
- Local mode never creates GitHub comments, reviews, checks, branches, commits, pushes, or pull requests.
- PR mode is read-only and binds fetched metadata/diff to immutable base/head SHAs.
- Invalid input, missing credentials, provider failure, partial/incomplete coverage, cancellation, stale source, and output failure exit nonzero.
- Secrets come only from explicit CLI environment, `OPENROUTER_API_KEY`, `GITHUB_TOKEN`/`GH_TOKEN`, or the user's existing `gh auth token`; do not design or persist credential storage.
- Repository policy and optional user defaults may be inspected, but CI must never read developer-machine configuration.
- The CLI and Action must produce equivalent identity, coverage, investigation, lane, finding-verification, and terminal status receipts for identical immutable inputs.
- Do not add dashboard, hosted-service, worker-authentication, or alternate panel-engine code from other repositories.
- Follow TDD and commit each independently testable task.

---

## File map

**Create**

- `src/cli/reviewSourceAdapters.ts` — resolve refs, diff files, and read-only PR inputs into immutable pipeline sources.
- `src/cli/reviewyetiCli.ts` — parse arguments, resolve credentials, run the shared pipeline, render output, and set exit codes.
- `src/cli/atomicOutput.ts` — atomic receipt file writes.
- `src/cli/doctor.ts` — bounded diagnostics without secret values.
- `src/cli/types.ts` — CLI-only source/option/result types; canonical review types remain imported from `src/review/*.d.ts`.
- `bin/reviewyeti.js` — Node shebang entrypoint loading compiled CLI code.
- `tests/unit/reviewSourceAdapters.test.ts`
- `tests/unit/reviewyetiCli.test.ts`
- `tests/unit/atomicOutput.test.ts`
- `tests/unit/reviewyetiDoctor.test.ts`
- `tests/integration/reviewyetiInstalledCli.integration.test.ts`
- `tests/integration/actionCliEquivalence.integration.test.ts`
- `tests/fixtures/cli/explicit-refs.json`
- `tests/fixtures/cli/diff-file.json`
- `tests/fixtures/cli/pull-request.json`
- `tests/fixtures/cli/action-receipt.json`
- `tests/fixtures/cli/cli-receipt.json`
- `scripts/verify-action-cli-equivalence.mjs`
- `docs/CLI.md`
- `docs/OPERATIONS.md`

**Modify**

- `src/runtime/reviewPipelineRuntime.js` — accept explicit immutable source and `publicationMode:'github'|'none'` while preserving the same engine.
- `.github/workflows/pipelines/review-pipeline.js` — use injected source and publication sink without changing review semantics.
- `package.json` and `package-lock.json` — package bin, files, scripts, and version metadata; no new runtime dependency.
- `scripts/check-action-runtime.mjs` — assert CLI code does not enter the composite Action runtime.
- `scripts/evaluate-bounded-review-engine.mjs` and its tests/fixtures — aggregate live Action and CLI receipts.
- `docs/ARCHITECTURE.md`, `docs/CONFIGURATION_REFERENCE.md`, `README.md`, and `TEST_INFRA.md` — shared-engine and operational usage.
- `tests/unit/reviewPipelineRuntime.test.ts`, `tests/unit/reviewActionPackaging.test.ts`, and `tests/integration/actionRuntime.integration.test.ts` — adapter isolation and packaging.

---

### Task 1: Explicit no-publication runtime boundary

**Files:**
- Modify: `src/runtime/reviewPipelineRuntime.js`
- Modify: `.github/workflows/pipelines/review-pipeline.js`
- Test: `tests/unit/reviewPipelineRuntime.test.ts`
- Test: `tests/unit/reviewPipelineDispatch.test.ts`
- Test: `tests/integration/actionRuntime.integration.test.ts`

**Interfaces:**
- Consumes: the merged PR 1 `runReviewPipeline` implementation.
- Produces: `runReviewPipeline({ source, publicationMode, publicationSink, ...dependencies })`, where `source` is an immutable normalized source and `publicationMode` defaults to `github` only for the Action adapter.

- [ ] **Step 1: Write failing runtime isolation tests**

```ts
it('runs an explicit immutable source without GitHub publication', async () => {
  const publicationSink = { publish: vi.fn(() => { throw new Error('must not publish'); }) };
  const result = await runReviewPipeline({
    source: {
      kind: 'diff-file',
      repository: 'local/example',
      prNumber: 1,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      diffText: fixtureDiff,
    },
    publicationMode: 'none',
    publicationSink,
    modelClient,
    env: hermeticEnv,
  });
  expect(publicationSink.publish).not.toHaveBeenCalled();
  expect(result.publication).toEqual({ mode: 'none', success: true, postedViaGh: false });
});
```

Also assert `publicationMode:'none'` rejects an injected sink that tries to publish and that omitted `publicationMode` is accepted only when `env.GITHUB_ACTIONS==='true'`.

- [ ] **Step 2: Verify tests fail**

Run: `npx vitest run tests/unit/reviewPipelineRuntime.test.ts tests/unit/reviewPipelineDispatch.test.ts tests/integration/actionRuntime.integration.test.ts`

Expected: FAIL because the runtime has no explicit source/publication contract.

- [ ] **Step 3: Implement normalized source and publication policy**

```js
async function runReviewPipeline(options = {}) {
  const env = options.env || process.env;
  const publicationMode = options.publicationMode || (env.GITHUB_ACTIONS === 'true' ? 'github' : 'none');
  if (!['github', 'none'].includes(publicationMode)) throw new TypeError('publicationMode must be github or none');
  return execute({
    ...options,
    env,
    publicationMode,
    prContext: options.source ? sourceToPrContext(options.source) : options.prContext,
    cwd: options.cwd || process.cwd(),
    fetchImplementation: options.fetchImplementation || globalThis.fetch,
  });
}
```

Implement the private adapter explicitly:

```js
function sourceToPrContext(source) {
  if (!source || !['refs', 'diff-file', 'pull-request'].includes(source.kind)) throw new TypeError('invalid review source');
  if (!/^[a-f0-9]{40,64}$/u.test(source.baseSha) || !/^[a-f0-9]{40,64}$/u.test(source.headSha)) throw new TypeError('review source requires immutable SHAs');
  return {
    repo: source.repository,
    prNumber: source.prNumber,
    baseSha: source.baseSha,
    headSha: source.headSha,
    diffText: source.diffText,
    title: source.title || '',
    sourceDigest: source.sourceDigest,
    sourceKind: source.kind,
  };
}
```

In the pipeline, route formatting/publication through a single `publishReviewResult` adapter. For `none`, return a successful no-op publication receipt and never call `gh`, REST writes, started-comment code, dashboard delivery, or memory persistence. Exact-head validation for explicit local sources compares the source digest supplied by the adapter rather than querying mutable GitHub state.

- [ ] **Step 4: Run runtime tests**

Run: `npx vitest run tests/unit/reviewPipelineRuntime.test.ts tests/unit/reviewPipelineDispatch.test.ts tests/integration/actionRuntime.integration.test.ts`

Expected: PASS; existing Action behavior remains `publicationMode:'github'`.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/reviewPipelineRuntime.js .github/workflows/pipelines/review-pipeline.js tests/unit/reviewPipelineRuntime.test.ts tests/unit/reviewPipelineDispatch.test.ts tests/integration/actionRuntime.integration.test.ts
git commit -m "feat(cli): add no-publication runtime mode"
```

### Task 2: Immutable review source adapters

**Files:**
- Create: `src/cli/types.ts`
- Create: `src/cli/reviewSourceAdapters.ts`
- Create: `tests/unit/reviewSourceAdapters.test.ts`
- Create: `tests/fixtures/cli/explicit-refs.json`
- Create: `tests/fixtures/cli/diff-file.json`
- Create: `tests/fixtures/cli/pull-request.json`

**Interfaces:**
- Consumes: parsed CLI source selection, `cwd`, optional GitHub token, `fetchImplementation`, and `commandRunner`.
- Produces: `resolveReviewSource(selection, dependencies): Promise<ReviewSource>`.

```ts
export type ReviewSource = {
  kind: 'refs' | 'diff-file' | 'pull-request';
  repository: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  diffText: string;
  title?: string;
  sourceDigest: string;
};
```

- [ ] **Step 1: Write failing adapter tests**

```ts
it('requires exactly one source mode', () => {
  expect(() => selectSource({ base: 'a'.repeat(40), head: 'b'.repeat(40), diffFile: 'change.diff' })).toThrow(/exactly one source mode/);
});

it('binds --pr data to immutable base and head SHAs and paginates files', async () => {
  const source = await resolveReviewSource({ kind: 'pull-request', value: 'review-yeti-ai/review-yeti-bot#31' }, { fetchImplementation, token: 'test-token' });
  expect(source).toMatchObject({ kind: 'pull-request', repository: 'review-yeti-ai/review-yeti-bot', prNumber: 31, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) });
  expect(source.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
});

it('rejects a symbolic ref and accepts only resolved commit SHAs', async () => {
  await expect(resolveReviewSource({ kind: 'refs', base: 'main', head: 'HEAD' }, deps)).rejects.toThrow(/full commit SHA/);
});
```

- [ ] **Step 2: Verify tests fail**

Run: `npx vitest run tests/unit/reviewSourceAdapters.test.ts`

Expected: FAIL because the adapters do not exist.

- [ ] **Step 3: Implement each adapter**

- Refs: require two 40-64 character commit SHAs, run `git diff --binary --no-ext-diff <base>...<head>`, derive repository from the validated origin when available, and hash the exact bytes.
- Diff file: reject directories/symlinks, cap input at 2,000,000 bytes, read once, hash the bytes, and derive stable synthetic base/head SHAs from labeled digests when the file carries no metadata.
- Pull request: parse `owner/repo#number` or a canonical GitHub pull URL, resolve the authenticated token, fetch PR metadata and diff with immutable SHAs, paginate changed files where required, and re-read the head before returning.

Use dependency injection for filesystem, command runner, and fetch so tests never access the live network or user's repository.

- [ ] **Step 4: Run adapter tests**

Run: `npx vitest run tests/unit/reviewSourceAdapters.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/types.ts src/cli/reviewSourceAdapters.ts tests/unit/reviewSourceAdapters.test.ts tests/fixtures/cli/explicit-refs.json tests/fixtures/cli/diff-file.json tests/fixtures/cli/pull-request.json
git commit -m "feat(cli): resolve immutable review sources"
```

### Task 3: Atomic output and exit-status contract

**Files:**
- Create: `src/cli/atomicOutput.ts`
- Create: `tests/unit/atomicOutput.test.ts`

**Interfaces:**
- Consumes: output path, serialized receipt bytes, filesystem dependency, and optional signal.
- Produces: `writeAtomicOutput(targetPath, bytes, dependencies): Promise<void>` and `exitCodeForReview(result): number`.

- [ ] **Step 1: Write failing atomicity tests**

```ts
it('renames a fully synced same-directory temporary file', async () => {
  await writeAtomicOutput('/tmp/review.json', Buffer.from('{"ok":true}\n'), { fs: fakeFs, randomUUID: () => 'run-1' });
  expect(fakeFs.calls).toEqual([
    ['open', '/tmp/.review.json.run-1.tmp', 'wx', 0o600],
    ['writeFile', '{"ok":true}\n'],
    ['sync'],
    ['close'],
    ['rename', '/tmp/.review.json.run-1.tmp', '/tmp/review.json'],
  ]);
});

it('removes the temporary file after cancellation without replacing the target', async () => {
  await expect(writeAtomicOutput('/tmp/review.json', bytes, { fs: cancellingFs, signal: abortedSignal })).rejects.toThrow(/cancelled/);
  expect(cancellingFs.rename).not.toHaveBeenCalled();
  expect(cancellingFs.unlink).toHaveBeenCalledWith('/tmp/.review.json.run-1.tmp');
});
```

Define `fakeFs`, `cancellingFs`, `bytes`, and `abortedSignal` inside the test file as strict spies implementing only `open`, handle `writeFile/sync/close`, `rename`, and `unlink`. Any unexpected filesystem method must throw so the test proves the boundary.

- [ ] **Step 2: Verify tests fail**

Run: `npx vitest run tests/unit/atomicOutput.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement atomic writing and exact exits**

```ts
export function exitCodeForReview(result: any): number {
  if (result?.cancelled) return 130;
  if (!result || result?.error) return 1;
  if (result.coverage?.status !== 'complete') return 2;
  if (result.verdict === 'SHIP') return 0;
  if (result.verdict === 'FIX_FIRST' || result.verdict === 'BLOCK') return 3;
  return 1;
}
```

Use `0o600`, `wx`, same-directory temp path, full write, file sync, close, rename, and best-effort unlink on all errors. Never overwrite the target in place.

- [ ] **Step 4: Run atomic tests**

Run: `npx vitest run tests/unit/atomicOutput.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/atomicOutput.ts tests/unit/atomicOutput.test.ts
git commit -m "feat(cli): add atomic receipt output"
```

### Task 4: First-class `reviewyeti review` command and package

**Files:**
- Create: `src/cli/reviewyetiCli.ts`
- Create: `bin/reviewyeti.js`
- Create: `tests/unit/reviewyetiCli.test.ts`
- Create: `tests/integration/reviewyetiInstalledCli.integration.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.server.json`
- Modify: `scripts/check-action-runtime.mjs`
- Modify: `tests/unit/reviewActionPackaging.test.ts`

**Interfaces:**
- Consumes: `resolveReviewSource`, `runReviewPipeline`, `writeAtomicOutput`, environment, stdout/stderr writers, and signal.
- Produces: `main(argv, dependencies): Promise<number>` and installed executable `reviewyeti`.

- [ ] **Step 1: Write failing command tests**

```ts
it('keeps --json stdout machine-pure and sends diagnostics to stderr', async () => {
  const code = await main(['review', '--diff-file', 'change.diff', '--json'], deps);
  expect(code).toBe(0);
  expect(() => JSON.parse(stdout.text())).not.toThrow();
  expect(stdout.text().trim().split('\n')).toHaveLength(1);
  expect(stderr.text()).toContain('Reviewing immutable source');
});

it.each([
  ['INCOMPLETE_REVIEW', 2],
  ['PARTIAL_REVIEW', 2],
  ['FIX_FIRST', 3],
  ['BLOCK', 3],
])('returns nonzero for %s', async (status, expected) => {
  expect(await main(['review', '--diff-file', 'change.diff', '--json'], depsWithResult(status))).toBe(expected);
});

it('never publishes in local mode', async () => {
  await main(['review', '--pr', 'review-yeti-ai/review-yeti-bot#31', '--json'], deps);
  expect(runReviewPipeline).toHaveBeenCalledWith(expect.objectContaining({ publicationMode: 'none' }));
});
```

Define `deps`, `depsWithResult`, `stdout`, and `stderr` as local injected fakes. Clear `GITHUB_ACTIONS`, `GITHUB_EVENT_PATH`, `GITHUB_REF`, `GITHUB_REPOSITORY`, and `GITHUB_SHA` in every CLI test environment so runner state cannot select Action behavior.

- [ ] **Step 2: Verify tests fail**

Run: `npx vitest run tests/unit/reviewyetiCli.test.ts tests/integration/reviewyetiInstalledCli.integration.test.ts tests/unit/reviewActionPackaging.test.ts`

Expected: FAIL because the CLI/bin/package contract does not exist.

- [ ] **Step 3: Implement argument parsing without a new dependency**

Supported syntax:

```text
reviewyeti review --base <sha> --head <sha> [--json] [--output <path>]
reviewyeti review --diff-file <path> [--json] [--output <path>]
reviewyeti review --pr <owner/repo#number|url> [--json] [--output <path>]
reviewyeti doctor [--json]
reviewyeti --help
```

Reject unknown options, duplicate scalar options, missing values, mixed source modes, symbolic refs, and `--output -`. Resolve OpenRouter from `OPENROUTER_API_KEY`. For PR reads, prefer `GITHUB_TOKEN`, then `GH_TOKEN`, then an injected `gh auth token` call; never print the token.

- [ ] **Step 4: Add the installed bin contract**

```js
#!/usr/bin/env node
'use strict';

require('../dist/cli/reviewyetiCli.js').main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(`reviewyeti: ${error.message}`);
  process.exitCode = 1;
});
```

Add `"bin":{"reviewyeti":"bin/reviewyeti.js"}` and a narrow `files` allowlist containing `bin/`, `dist/`, `src/runtime/reviewPipelineRuntime.js`, the CommonJS `src/review/`, `src/mcp/`, `src/pi/`, `src/memory/`, and `src/telemetry/` runtime modules, `.github/workflows/pipelines/review-pipeline.js` plus its sibling runtime modules, package metadata, README, and license. Ensure `npm pack --dry-run --json` includes every runtime dependency but excludes fixtures, sessions, `.env*`, and raw receipts.

- [ ] **Step 5: Prove the installed package**

The integration test must run `npm pack`, install the tarball into a temporary directory, execute `node_modules/.bin/reviewyeti --help`, run a cassette-backed `review --diff-file ... --json`, parse stdout, and assert stderr contains diagnostics only.

- [ ] **Step 6: Run CLI/package tests**

Run: `npx vitest run tests/unit/reviewyetiCli.test.ts tests/integration/reviewyetiInstalledCli.integration.test.ts tests/unit/reviewActionPackaging.test.ts && npm run build && npm pack --dry-run --json`

Expected: PASS; the pack JSON lists `bin/reviewyeti.js` and compiled CLI/runtime modules.

- [ ] **Step 7: Commit**

```bash
git add src/cli/reviewyetiCli.ts bin/reviewyeti.js tests/unit/reviewyetiCli.test.ts tests/integration/reviewyetiInstalledCli.integration.test.ts package.json package-lock.json tsconfig.server.json scripts/check-action-runtime.mjs tests/unit/reviewActionPackaging.test.ts
git commit -m "feat(cli): ship reviewyeti review command"
```

### Task 5: Bounded `doctor` diagnostics

**Files:**
- Create: `src/cli/doctor.ts`
- Create: `tests/unit/reviewyetiDoctor.test.ts`
- Modify: `src/cli/reviewyetiCli.ts`

**Interfaces:**
- Consumes: environment, executable lookup, config reader, GitHub/OpenRouter injected probes, and stdout format.
- Produces: `runDoctor(dependencies): Promise<DoctorReceipt>` with statuses `ok`, `warning`, or `error`.

- [ ] **Step 1: Write failing redaction and failure tests**

```ts
it('reports credential presence and reachability without values', async () => {
  const receipt = await runDoctor({ env: { OPENROUTER_API_KEY: 'sk-secret', GITHUB_TOKEN: 'ghp-secret' }, probes });
  expect(receipt.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'openrouter-credential', status: 'ok', source: 'OPENROUTER_API_KEY' }),
    expect.objectContaining({ id: 'github-credential', status: 'ok', source: 'GITHUB_TOKEN' }),
  ]));
  expect(JSON.stringify(receipt)).not.toContain('sk-secret');
  expect(JSON.stringify(receipt)).not.toContain('ghp-secret');
});

it('does not write configuration or credentials', async () => {
  await runDoctor(deps);
  expect(deps.fs.writeFile).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify tests fail**

Run: `npx vitest run tests/unit/reviewyetiDoctor.test.ts`

Expected: FAIL because `doctor.ts` does not exist.

- [ ] **Step 3: Implement the fixed check roster**

Check Node >=20, current directory/repository readability, trusted repository config parseability, OpenRouter credential presence, a bounded OpenRouter model reachability probe, GitHub credential source, GitHub repository read permission when a repo is known, and output-directory writability only when explicitly requested. Each probe has a timeout and an allowlisted error code. Do not enumerate environment variables or user config directories.

- [ ] **Step 4: Run doctor tests**

Run: `npx vitest run tests/unit/reviewyetiDoctor.test.ts tests/unit/reviewyetiCli.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/doctor.ts src/cli/reviewyetiCli.ts tests/unit/reviewyetiDoctor.test.ts tests/unit/reviewyetiCli.test.ts
git commit -m "feat(cli): add bounded reviewyeti doctor"
```

### Task 6: Action/CLI receipt equivalence and operational corpus

**Files:**
- Create: `tests/integration/actionCliEquivalence.integration.test.ts`
- Create: `scripts/verify-action-cli-equivalence.mjs`
- Modify: `scripts/evaluate-bounded-review-engine.mjs`
- Modify: `tests/fixtures/bounded-review-engine/evaluation-matrix.json`
- Modify: `tests/unit/boundedReviewEvaluation.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: one immutable source fixture, Action harness result, CLI result, and optional live receipt paths.
- Produces: `action-cli-equivalence-v1` and expanded `bounded-review-eval-result-v1` receipts.

- [ ] **Step 1: Write failing equivalence tests**

```ts
it('produces equivalent authority receipts from identical immutable input', async () => {
  const action = await runActionHarness(fixture);
  const cli = await runCliHarness(fixture);
  expect(projectAuthorityReceipt(cli)).toEqual(projectAuthorityReceipt(action));
});

function projectAuthorityReceipt(result: any) {
  return {
    identity: result.identity,
    verdict: result.verdict,
    coverage: result.coverage,
    investigationDigest: result.investigation.receiptDigest,
    reviewUnits: result.reviewUnits,
    findingVerification: result.findingVerification,
  };
}
```

Do not compare timestamps, filesystem paths, GitHub publication ids, logs, or adapter-specific metadata.

- [ ] **Step 2: Verify tests fail**

Run: `npx vitest run tests/integration/actionCliEquivalence.integration.test.ts tests/unit/boundedReviewEvaluation.test.ts`

Expected: FAIL because equivalence projection/script and live aggregate fields do not exist.

- [ ] **Step 3: Implement deterministic equivalence verification**

`verify-action-cli-equivalence.mjs` accepts `--action-receipt`, `--cli-receipt`, and optional `--output`. It validates both schemas, projects authority fields, compares canonical JSON, prints one JSON receipt, writes atomically when requested, and exits 1 on mismatch.

Extend the evaluator with:

- exact head SHA;
- completed/expected persona counts;
- evidence calls and truncations;
- valid/invalid publication anchors;
- provider-reported prompt/completion tokens and USD cost;
- wall-clock latency and p95 across repeated live runs;
- unsafe-ship count;
- hidden-skipped-unit count; and
- Action/CLI equivalence status.

Cost remains `null` when the provider receipt omits cost; never derive it from duration.

- [ ] **Step 4: Run equivalence/evaluation tests**

Run: `npx vitest run tests/integration/actionCliEquivalence.integration.test.ts tests/unit/boundedReviewEvaluation.test.ts && node scripts/verify-action-cli-equivalence.mjs --action-receipt tests/fixtures/cli/action-receipt.json --cli-receipt tests/fixtures/cli/cli-receipt.json`

Expected: PASS with `{"schemaVersion":"action-cli-equivalence-v1","equivalent":true,...}`.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/actionCliEquivalence.integration.test.ts scripts/verify-action-cli-equivalence.mjs scripts/evaluate-bounded-review-engine.mjs tests/fixtures/bounded-review-engine/evaluation-matrix.json tests/fixtures/cli/action-receipt.json tests/fixtures/cli/cli-receipt.json tests/unit/boundedReviewEvaluation.test.ts package.json
git commit -m "test(cli): prove Action and CLI receipt equivalence"
```

### Task 7: CLI and operations documentation

**Files:**
- Create: `docs/CLI.md`
- Create: `docs/OPERATIONS.md`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/CONFIGURATION_REFERENCE.md`
- Modify: `TEST_INFRA.md`
- Test: `tests/unit/reviewActionPackaging.test.ts`

**Interfaces:**
- Consumes: actual CLI help, receipt schemas, exit codes, and operational verification commands.
- Produces: user/operator documentation matching shipped behavior.

- [ ] **Step 1: Add failing documentation contract assertions**

Assert the docs contain all three mutually exclusive source modes, exact exit codes `0/1/2/3/130`, pure JSON/stdout rule, atomic output guarantee, local no-publication rule, credential precedence, no credential persistence, investigation termination causes, exact-head identity, Action/CLI equivalence command, and Git-revert rollback.

- [ ] **Step 2: Verify documentation tests fail**

Run: `npx vitest run tests/unit/reviewActionPackaging.test.ts`

Expected: FAIL because CLI/operations docs are missing.

- [ ] **Step 3: Write documentation from executable output**

Capture `reviewyeti --help` and `reviewyeti doctor --json` field names from the installed tarball test, then document only those shipped options/fields. Include copy-paste commands using placeholder-free shell variables:

```bash
reviewyeti review --base "$BASE_SHA" --head "$HEAD_SHA" --json
reviewyeti review --diff-file ./change.diff --output ./review-run.json
reviewyeti review --pr review-yeti-ai/review-yeti-bot#31 --json
reviewyeti doctor --json
```

Clarify that `BASE_SHA` and `HEAD_SHA` must already contain full immutable commit SHAs and that CI passes configuration explicitly rather than reading user-machine defaults.

- [ ] **Step 4: Run doc/package tests**

Run: `npx vitest run tests/unit/reviewActionPackaging.test.ts tests/integration/reviewyetiInstalledCli.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/CLI.md docs/OPERATIONS.md README.md docs/ARCHITECTURE.md docs/CONFIGURATION_REFERENCE.md TEST_INFRA.md tests/unit/reviewActionPackaging.test.ts
git commit -m "docs(cli): document local review operations"
```

### Task 8: PR 2 verification and landing evidence

**Files:**
- Modify only for demonstrated verification failures.
- Keep generated tarballs, live receipts, and provider transcripts out of Git.

**Interfaces:**
- Consumes: the complete PR 2 implementation on top of merged PR 1.
- Produces: package, Action/CLI equivalence, exact-head live, reviewer, merge, and post-merge evidence.

- [ ] **Step 1: Run CLI-focused verification**

Run:

```bash
npm run lint
npm run build
npx vitest run tests/unit/reviewSourceAdapters.test.ts tests/unit/atomicOutput.test.ts tests/unit/reviewyetiCli.test.ts tests/unit/reviewyetiDoctor.test.ts tests/integration/reviewyetiInstalledCli.integration.test.ts tests/integration/actionCliEquivalence.integration.test.ts
npm pack --dry-run --json
```

Expected: all exit 0 and the package contains the executable plus all runtime files.

- [ ] **Step 2: Run complete repository verification**

Run:

```bash
npm run test:all
actionlint action.yml
node scripts/check-action-runtime.mjs
```

Expected: all exit 0; the composite Action does not load CLI TypeScript or local configuration.

- [ ] **Step 3: Prove the installed tarball locally**

Create a temporary directory with `mktemp -d`, run `npm pack`, install that exact tarball into the temporary directory, then execute the installed `.bin/reviewyeti --help`, one cassette-backed diff-file review, and `doctor --json`. Verify stdout JSON purity, nonzero incomplete status, atomic output, and no GitHub publication calls.

- [ ] **Step 4: Commit only demonstrated fixes**

Run `git status --short`. If verification required a code change, stage only the named affected files, commit `fix(cli): satisfy installed package verification`, and rerun every affected command. Otherwise leave the branch unchanged.

- [ ] **Step 5: Push and open PR 2**

Push from a branch based on the merged PR 1 main SHA and open a ready pull request titled `feat: ship Review Yeti CLI and operational proof`. Include the exact head SHA, installed-package result, Action/CLI equivalence receipt, deterministic evaluation summary, and explicit statement that the production engine was already active from PR 1.

- [ ] **Step 6: Run live Action and CLI against identical immutable input**

Run the production Action on the PR head. Fetch the exact base/head/diff into a local immutable source and run the installed CLI with the same model/persona policy and secrets supplied explicitly. Compare receipts using `verify-action-cli-equivalence.mjs`.

Record exact SHAs, Action run URL, CLI package tarball digest, provider-reported token usage/cost, latency, coverage, investigation digest, verifier summary, and equivalence result. Do not call focused fixtures or a locally constructed response fleet acceptance.

- [ ] **Step 7: Obtain current-head reviewer quorum**

Wait for CodeRabbit and GitHub Copilot on the exact current head. Address actionable findings, rerun installed-package and equivalence proof after every push, and do not count stale/rate-limited/timed-out reviews as approval.

- [ ] **Step 8: Merge and verify main**

Merge only after required CI, installed-package proof, live Action/CLI equivalence, and both reviewers are complete with no blockers. Verify the merge commit on `upstream/main`, install the package built from that exact commit, run one no-publication CLI review and one production Action review, and retain only redacted receipts outside Git.

---

## PR 2 completion definition

PR 2 is complete only when the installed `reviewyeti` executable uses the canonical bounded engine, local mode cannot publish, all source modes are immutable and tested, incomplete work exits nonzero, output is atomic, doctor is read-only and redacted, Action/CLI authority receipts match for identical input, current-head reviewers approve, and post-merge runs prove the merged SHA.
