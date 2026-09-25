import { afterEach, describe, expect, it, vi } from 'vitest';
import { containsExecutableOrSensitiveCode } from '../../src/panel/classifierEngine';
import { evaluatePersonaGating } from '../../src/panel/panelEngine';
import { parseChangedFiles } from '../../src/review/changedFiles';
import { planDiffShrink, type DiffShrinkInput } from '../../src/review/diffShrink';
import {
  JEV_TRIAGE_LOG,
  computeTriageFileFacts,
  startJevTriageShadow,
  triageLaneOutcome,
  triagePathClass,
  type StartJevTriageShadowInput,
} from '../../src/review/jevTriageShadow';
import { buildEffectiveReviewFiles } from '../../src/review/personaApplicability';
import { classifyBudgetCategory, packLaneBudget, type BudgetCandidate } from '../../src/review/reviewBudget';
import * as sensitive from '../../src/review/securitySensitivePaths';
import type { JevAskRequest, JevAsker, JevOutcome } from '../../src/gateway/jevClient';
import { logger } from '../../src/utils/logger';

/**
 * REL-1135 (ADRs 0685 and 0688): one security-sensitive predicate, the union of the three lists
 * that used to disagree, and every consumer reads it. Lockfiles and toolchain pins are the arm
 * the depth-deciding list (diff shrink W2, budget packing W5) was missing.
 *
 * Negative proof (ADR 0641): run against origin/main (83ce3345) with the module-level blocks
 * removed (they import APIs that do not exist there), all 34 W2, W5 and Jev tests fail -- W2
 * whitespace-collapses and linguist-excludes lockfiles and `.tool-versions`, W5 packs them as
 * source/config and cuts them to signatures, the Jev shadow's own list misses toolchain pins,
 * `.lock` files it did not name, `.sh` and migrations, and the join line has no `sensitive_any`,
 * `path_class` or lane `outcome`. The fast-ship and deterministic-exclusion blocks pass there
 * too: they pin behaviour this change must not regress, not a bug.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const LOCKFILES = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'bun.lock', 'go.sum', 'Cargo.lock',
  'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'mix.lock', 'composer.lock', 'flake.lock',
  'ios/Podfile.lock', 'Package.resolved', 'packages.lock.json', 'ct-meta.lock', 'services/api/deps-lock.json',
];
const TOOLCHAIN_PINS = [
  '.tool-versions', '.nvmrc', '.node-version', '.python-version', '.ruby-version', '.terraform-version',
  'rust-toolchain', 'rust-toolchain.toml', 'go.work', 'web/.nvmrc', 'mise.toml', 'global.json',
];

// ---------------------------------------------------------------------------
// The predicate: a union, not a replacement
// ---------------------------------------------------------------------------

describe('one security-sensitive predicate', () => {
  it.each(LOCKFILES)('lockfile %s is sensitive', (path) => {
    expect(sensitive.isSecuritySensitivePath(path)).toBe(true);
    expect(sensitive.securitySensitivePathClass(path)).toBe('lockfile');
  });

  it.each(TOOLCHAIN_PINS)('toolchain pin %s is sensitive', (path) => {
    expect(sensitive.isSecuritySensitivePath(path)).toBe(true);
    expect(sensitive.securitySensitivePathClass(path)).toBe('toolchain_pin');
  });

  it.each([
    // Formerly only in the Jev shadow list.
    ['tools/actions/setup/action.yml', 'ci'],
    ['sub/.github/workflows/ci.yml', 'ci'],
    ['packages.config', 'dependency_manifest'],
    // Formerly only in the fast-ship substring list.
    ['cloudbuild.yaml', 'ci'],
    ['.gitlab/ci/build.yml', 'ci'],
    ['Procfile', 'container'],
    ['deploy_keys/id_ed25519', 'secret_material'],
    ['CMakeLists.txt', 'build_script'],
    // Formerly only in the budget's own CI/IaC list.
    ['clusters/doks/app/values.yaml', 'iac'],
    ['Chart.yaml', 'iac'],
    // Already in the canonical list (kept).
    ['scripts/release.sh', 'build_script'],
    ['db/migrations/001.sql', 'migration'],
    ['src/auth/session.ts', 'auth_crypto_secrets'],
    ['package.json', 'dependency_manifest'],
    ['Dockerfile', 'container'],
    ['infra/main.tf', 'iac'],
  ])('%s is sensitive (%s)', (path, pathClass) => {
    expect(sensitive.isSecuritySensitivePath(path)).toBe(true);
    expect(sensitive.securitySensitivePathClass(path)).toBe(pathClass);
  });

  it('malformed input is sensitive, so it never unlocks a reduction', () => {
    expect(sensitive.securitySensitivePathClass('')).toBe('malformed');
    expect(sensitive.isSecuritySensitivePath(undefined)).toBe(true);
  });

  it.each(['src/app.ts', 'src/keyboard.ts', 'docs/guide.md', 'src/lockstep.ts', 'README.md'])('%s is not sensitive', (path) => {
    expect(sensitive.isSecuritySensitivePath(path)).toBe(false);
    expect(sensitive.securitySensitivePathClass(path)).toBeNull();
  });

  it('the fast-ship screen is a superset of the predicate', () => {
    for (const path of [...LOCKFILES, ...TOOLCHAIN_PINS, 'src/auth/x.ts', 'Chart.yaml']) {
      expect(sensitive.blocksFastShipByPath(path)).toBe(true);
    }
    // The coarse substring arm still blocks what it always did.
    expect(sensitive.blocksFastShipByPath('src/monkey.ts')).toBe(true);
    expect(sensitive.blocksFastShipByPath('docs/guide.md')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Consumers: W2 diff shrink
// ---------------------------------------------------------------------------

function modified(path: string, hunks: string[]): string {
  return [`diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`, ...hunks]
    .join('\n') + '\n';
}

/** An indentation-only change: W2 collapses it on a non-sensitive, non-whitespace-significant path. */
const WS_HUNK = ['@@ -1,3 +1,3 @@', ' {', '-"dep": "LOCK_WS_MARKER"', '+  "dep": "LOCK_WS_MARKER"', ' }'].join('\n');
const REAL_HUNK = ['@@ -1 +1 @@', '-nodejs 20.1.0', '+nodejs 22.3.0 PIN_MARKER'].join('\n');

/** W2 input straight from the parser: a lockfile the hunk filter would drop is still checked here. */
function parsed(diff: string) {
  return parseChangedFiles(diff).files as unknown as Parameters<typeof planDiffShrink>[0];
}

const SHRINK_ON: DiffShrinkInput = { enabled: true };

describe('W2 diff shrink never shrinks a lockfile or toolchain pin', () => {
  it.each(['package-lock.json', 'bun.lock', 'ct-meta.lock', 'composer.lock', '.tool-versions', '.nvmrc'])(
    'keeps a whitespace-only change to %s in full', (path) => {
      const { files: out, disclosure } = planDiffShrink(parsed(modified(path, [WS_HUNK])), SHRINK_ON);
      expect(disclosure.whitespaceOnlyFiles).toEqual([]);
      expect(disclosure.collapsedWhitespaceHunks).toEqual([]);
      expect(disclosure.keptFullDepth).toEqual([{ path, rule: 'whitespace' }]);
      expect(out[0].patch).toContain('LOCK_WS_MARKER');
    },
  );

  it.each(['package-lock.json', 'uv.lock', '.tool-versions'])(
    'never linguist-excludes %s, even when .gitattributes marks it generated', (path) => {
      const input: DiffShrinkInput = { enabled: true, linguist: { status: 'applied', content: `${path} linguist-generated\n` } };
      const { files: out, disclosure } = planDiffShrink(parsed(modified(path, [REAL_HUNK])), input);
      expect(disclosure.linguistExcluded).toEqual([]);
      expect(disclosure.keptFullDepth).toEqual([{ path, rule: 'linguist' }]);
      expect(out[0].patch).toContain('PIN_MARKER');
    },
  );

  it('the same whitespace change to ordinary source is still collapsed (the rule is live)', () => {
    const { disclosure } = planDiffShrink(parsed(modified('src/app.json5', [WS_HUNK])), SHRINK_ON);
    expect(disclosure.whitespaceOnlyFiles).toEqual(['src/app.json5']);
  });
});

// ---------------------------------------------------------------------------
// Consumers: W5 budget packing (and map-reduce, which packs through it)
// ---------------------------------------------------------------------------

function bigPatch(path: string, lines: number, tag: string): string {
  const body = [`+export function ${tag}_head(input: string): string {`];
  for (let i = 0; i < lines; i++) body.push(`+  const ${tag}_v${String(i).padStart(5, '0')} = input.length + ${i};`);
  body.push(`+  return '${tag}_TAIL_MARKER';`, '+}');
  return parseChangedFiles([
    `diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', `+++ b/${path}`,
    `@@ -0,0 +1,${body.length} @@`, ...body,
  ].join('\n') + '\n').files[0].patch!;
}

describe('W5 budget packing never summarizes a lockfile or toolchain pin', () => {
  it.each(['package-lock.json', 'bun.lock', '.tool-versions', '.nvmrc'])('%s is a full-depth category', (path) => {
    expect(classifyBudgetCategory(path)).toBe('security-sensitive');
  });

  // Nested under `web/` so each sorts after `src/core.ts`: on origin/main a lockfile packed as
  // `source` or `config` then loses the soft budget to the source file.
  it.each(['web/package-lock.json', 'web/bun.lock', 'web/.tool-versions'])(
    'packs %s in full ahead of source that would otherwise take the soft budget', (path) => {
      // ~48 KB of source fits the 56 KB soft budget alone; with a ~14 KB lockfile it does not.
      // As `source`/`config` (origin/main) the lockfile came after it and was cut to signatures; as
      // security-sensitive it is placed first, in full, and the source is the one reduced.
      const candidates: BudgetCandidate[] = [
        { path: 'src/core.ts', effectivePatch: bigPatch('src/core.ts', 1000, 'core'), wholePatch: null },
        { path, effectivePatch: bigPatch(path, 300, 'lock'), wholePatch: null },
      ];
      const pack = packLaneBudget('sec-lane', candidates);
      expect(pack.entries.get(path)?.depth).toBe('full');
      expect(pack.entries.get(path)?.promptPatch).toContain('lock_TAIL_MARKER');
      // Not vacuous: the budget really had to reduce something.
      expect(pack.entries.get('src/core.ts')?.depth).not.toBe('full');
    },
  );
});

// ---------------------------------------------------------------------------
// Consumers: fast-ship guard
// ---------------------------------------------------------------------------

describe('fast-ship guard', () => {
  it.each([...LOCKFILES, ...TOOLCHAIN_PINS, 'Chart.yaml', 'cloudbuild.yaml', 'tools/actions/setup/action.yml'])(
    'never fast-ships %s', (path) => {
      expect(containsExecutableOrSensitiveCode([{ path, patch: '@@ -1 +1 @@\n-a\n+b\n' }])).toBe(true);
    },
  );

  it('prose on a sensitive-sounding path stays fast-ship eligible (it is not an executable surface)', () => {
    expect(containsExecutableOrSensitiveCode([{ path: 'docs/login.md', patch: '@@ -1 +1 @@\n-a\n+b\n' }])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Consumers: security-lane gate (panelEngine evaluatePersonaGating)
// ---------------------------------------------------------------------------

describe('security-lane gate', () => {
  it.each(['.tool-versions', 'rust-toolchain.toml', 'bun.lock', 'ct-meta.lock', 'package.json', 'Dockerfile'])(
    'runs sec-lane at full depth (not weakMatch) on a change to %s alone', (path) => {
      const result = evaluatePersonaGating({
        persona: { id: 'sec-lane', charter: 'Security review', paths: ['**/*'] },
        changedFiles: [{ path, patch: '@@ -1 +1 @@\n-a 1\n+a 2\n' }],
        domainLanes: { [path]: 'system_runtime' },
      });
      expect(result.skipped).toBe(false);
      expect(result.weakMatch).toBeFalsy();
    },
  );

  it('a change with no sensitive path gets the reduced weakMatch budget (the gate is live)', () => {
    const result = evaluatePersonaGating({
      persona: { id: 'sec-lane', charter: 'Security review', paths: ['**/*'] },
      changedFiles: [{ path: 'src/app.ts', patch: '@@ -1 +1 @@\n-a 1\n+a 2\n' }],
      domainLanes: { 'src/app.ts': 'system_runtime' },
    });
    expect(result).toMatchObject({ skipped: false, weakMatch: true });
  });

  it('a coarse substring-only match (src/monkey.ts) keeps the weakMatch budget: only the predicate forces full depth', () => {
    const result = evaluatePersonaGating({
      persona: { id: 'sec-lane', charter: 'Security review', paths: ['**/*'] },
      changedFiles: [{ path: 'src/monkey.ts', patch: '@@ -1 +1 @@\n-a 1\n+a 2\n' }],
      domainLanes: { 'src/monkey.ts': 'system_runtime' },
    });
    expect(result).toMatchObject({ skipped: false, weakMatch: true });
  });
});

// ---------------------------------------------------------------------------
// Consumers: Jev triage shadow facts and join line
// ---------------------------------------------------------------------------

describe('Jev shadow reads the shared predicate', () => {
  it.each([...TOOLCHAIN_PINS, 'ct-meta.lock', 'bun.lock', 'scripts/deploy.sh', 'db/migrations/002.sql'])(
    'facts.security_sensitive is true for %s', (path) => {
      expect(computeTriageFileFacts({ path, patch: '@@ -1 +1 @@\n-a\n+b\n' }, 1000).facts.security_sensitive).toBe(true);
    },
  );
});

describe('triagePathClass: sensitive first, then test, docs, generated, other', () => {
  const facts = (path: string) => computeTriageFileFacts({ path, patch: '@@ -1 +1 @@\n-a\n+b\n' }, 1000).facts;
  it.each([
    ['tests/auth/login.test.ts', 'sensitive'],
    ['tests/app.test.ts', 'test'],
    ['docs/guide.md', 'docs'],
    ['dist/app.min.js', 'generated'],
    ['src/app.ts', 'other'],
  ])('%s is %s', (path, pathClass) => {
    expect(triagePathClass(facts(path))).toBe(pathClass);
  });
});

describe('triageLaneOutcome: a failed lane is never an empty approval', () => {
  it('failed wins even when the lane also reported APPROVE with no findings', () => {
    expect(triageLaneOutcome({ decision: 'APPROVE', findings: [] }, true)).toBe('failed');
  });
  it('an absent lane that did not fail is skipped, never approved', () => {
    expect(triageLaneOutcome(undefined, false)).toBe('skipped');
  });
  it('a not-applicable lane is skipped', () => {
    expect(triageLaneOutcome({ decision: 'APPROVE', findings: [], notApplicable: true }, false)).toBe('skipped');
    expect(triageLaneOutcome({ decision: 'APPROVE', findings: [], skipReason: 'gated' }, false)).toBe('skipped');
  });
  it('approve and findings are told apart', () => {
    expect(triageLaneOutcome({ decision: 'APPROVE', findings: [] }, false)).toBe('completed-approve');
    expect(triageLaneOutcome({ decision: 'FINDINGS', findings: [{}] }, false)).toBe('completed-findings');
  });
  it('a lane result with no decision is not read as an approval', () => {
    expect(triageLaneOutcome({ findings: [] }, false)).toBe('failed');
  });
});

describe('Jev join line: sensitive_any, path_class and per-lane outcome', () => {
  const PERSONAS = [{ id: 'sec-lane', charter: 'builtin:security' }, { id: 'perf-lane', charter: 'builtin:performance' }];
  const TYPESAFE_ENV = {
    TYPESAFE_BASE_URL: 'https://api.typesafe.example/v1/systemone', TYPESAFE_MODEL: 'jev-latest',
    TYPESAFE_API_KEY: 'ts-test-key', TYPESAFE_MODEL_PIN: 'jev-1.13.0',
  };

  function asker(choiceFor: (path: string) => string): JevAsker {
    const ask = vi.fn(async (request: JevAskRequest<string>): Promise<JevOutcome<string>> => {
      const path = String((request.state as { file?: { path?: string } })?.file?.path);
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(request.questions)) {
        if (question.type === 'choice') answers[key] = { type: 'choice', choice: choiceFor(path), confidence: 0.9, probabilities: {} };
        else if (question.type === 'score') {
          answers[key] = { type: 'score', score: 0, confidence: 0.9,
            legend: Object.fromEntries(question.criteria.map((c, i) => [String(i), c])), probabilities: { '0': 0.9 } };
        } else answers[key] = { type: 'noul', noul: 0.1 };
      }
      return { status: 'ok', answers: answers as never, model: 'jev-1.13.0', usage: { input_tokens: 1, output_tokens: 1 }, durationMs: 1 };
    });
    return { ask: ask as unknown as JevAsker['ask'] };
  }

  function input(paths: string[], choiceFor: (path: string) => string): StartJevTriageShadowInput {
    return {
      env: { REVIEW_YETI_JEV_SHADOW: 'true', ...TYPESAFE_ENV },
      repository: 'review-yeti-ai/review-yeti-bot', runId: 'run_1135', prNumber: 1135, headSha: 'b'.repeat(40),
      changedFiles: paths.map((path) => ({ path, patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n` })),
      personas: PERSONAS,
      asker: asker(choiceFor),
    };
  }

  function joins(spy: { mock: { calls: unknown[][] } }): Array<Record<string, any>> {
    return spy.mock.calls
      .map((call: unknown[]) => call[1] as Record<string, any> | undefined)
      .filter((meta: Record<string, any> | undefined): meta is Record<string, any> => meta?.event === JEV_TRIAGE_LOG.join);
  }

  it('logs sensitive_any as the path rule OR a valid Jev security_sensitive category, and a path_class', async () => {
    const info = vi.spyOn(logger, 'info');
    const handle = startJevTriageShadow(input(
      ['.tool-versions', 'src/worker/disk.ts', 'tests/auth/login.test.ts', 'docs/guide.md', 'src/app.ts'],
      (path) => (path === 'src/worker/disk.ts' ? 'security_sensitive' : path === '.tool-versions' ? 'config' : 'source'),
    ));
    await handle.join({
      findings: [], mode: 'panel', verdict: 'SHIP', conclusion: 'success', applicablePersonaIds: ['sec-lane', 'perf-lane'],
      personas: [
        { id: 'sec-lane', decision: 'APPROVE', findings: [] },
        { id: 'perf-lane', decision: 'APPROVE', findings: [] },
      ],
    });
    const byPath = Object.fromEntries(joins(info).map((line) => [line.path, line]));
    // Path rule alone (Jev said "config"): ADR 0688's `.nvmrc`/`.tool-versions` case.
    expect(byPath['.tool-versions']).toMatchObject({
      security_sensitive: true, sensitive_any: true, sensitive_path_class: 'toolchain_pin', path_class: 'sensitive', category: 'config',
    });
    // Jev category alone (no path rule): ADR 0685's disk-pressure worker case.
    expect(byPath['src/worker/disk.ts']).toMatchObject({
      security_sensitive: false, sensitive_any: true, sensitive_path_class: null, path_class: 'other',
    });
    // No category precedence: a test on a sensitive path is sensitive.
    expect(byPath['tests/auth/login.test.ts']).toMatchObject({ sensitive_any: true, path_class: 'sensitive' });
    expect(byPath['docs/guide.md']).toMatchObject({ sensitive_any: false, path_class: 'docs' });
    expect(byPath['src/app.ts']).toMatchObject({ sensitive_any: false, path_class: 'other' });
  });

  it('marks a failed lane `failed` (not an empty approval) and a completed one by its decision', async () => {
    const info = vi.spyOn(logger, 'info');
    const handle = startJevTriageShadow(input(['src/app.ts'], () => 'source'));
    await handle.join({
      findings: [], mode: 'panel', verdict: 'BLOCK', conclusion: 'failure', applicablePersonaIds: ['sec-lane', 'perf-lane'],
      personas: [{ id: 'sec-lane', decision: 'APPROVE', findings: [] }],
      failedPersonaIds: ['perf-lane'],
    });
    expect(joins(info)[0].lanes).toMatchObject({
      'sec-lane': { outcome: 'completed-approve', completed: true, ran: true, findings: 0 },
      'perf-lane': { outcome: 'failed', completed: false, ran: false, findings: 0 },
    });
  });
});

// ---------------------------------------------------------------------------
// Scope note pinned as a test: the hunk filter's deterministic lockfile exclusion (plan
// invariant 1, #993) still applies to the names it lists; the predicate protects every
// lockfile that reaches a content-reducing rule.
// ---------------------------------------------------------------------------

describe('deterministic lockfile exclusion is unchanged', () => {
  it('buildEffectiveReviewFiles still drops the hunk filter\'s listed lockfiles, and keeps bun.lock', () => {
    const diff = modified('package-lock.json', [REAL_HUNK]) + modified('bun.lock', [REAL_HUNK]);
    expect(buildEffectiveReviewFiles(parseChangedFiles(diff).files).files.map((file) => file.path)).toEqual(['bun.lock']);
  });
});
