import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPublishingReviewWorker } from '../../src/cli/publishingReview';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema } from '../../src/config/schema';
import { containsExecutableOrSensitiveCode } from '../../src/panel/classifierEngine';
import { executePersonaPanel, extractMessageContentText } from '../../src/panel/panelEngine';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { parseChangedFiles } from '../../src/review/changedFiles';
import {
  attachDiffShrinkDisclosure,
  diffShrinkEnabledFor,
  isWhitespaceOnlyHunk,
  loadDiffShrinkInput,
  planDiffShrink,
  renderDiffShrinkSummary,
  resolveShrunkReviewApplicability,
  type DiffShrinkInput,
} from '../../src/review/diffShrink';
import {
  compileGitattributesPattern,
  linguistExclusionFor,
  parseLinguistAttributes,
} from '../../src/review/gitattributesLinguist';
import { buildEffectiveReviewFiles, resolveReviewApplicability } from '../../src/review/personaApplicability';
import { isSecuritySensitivePath } from '../../src/review/securitySensitivePaths';

/**
 * REL-1079 (plan 2026-09-23 section 4 W2): deterministic diff shrinking behind
 * REVIEW_YETI_DIFF_SHRINK, default off.
 *
 * Negative proof (ADR 0641): every guard below was checked against a planted
 * violation in src/review/diffShrink.ts (see the PR body for the mutation list),
 * and the engine/worker wiring tests fail on origin/main, where the flag is not
 * read and every change is sent in full.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Diff fixtures (the GitHub/git unified format parseChangedFiles reads)
// ---------------------------------------------------------------------------

function modified(path: string, hunks: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks,
  ].join('\n') + '\n';
}

const WS_HUNK = [
  '@@ -1,3 +1,3 @@',
  ' function wrap() {',
  '-return WS_ONLY_MARKER;',
  '+  return WS_ONLY_MARKER;',
  ' }',
].join('\n');
const REAL_HUNK = [
  '@@ -10,2 +10,2 @@',
  ' const keep = 0;',
  '-const REAL = 1;',
  '+const REAL_CHANGE_MARKER = 2;',
].join('\n');

function files(diff: string) {
  return parseChangedFiles(diff).files;
}

function effective(diff: string) {
  return buildEffectiveReviewFiles(files(diff)).files;
}

const ON: DiffShrinkInput = { enabled: true };

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

describe('REVIEW_YETI_DIFF_SHRINK flag', () => {
  it.each([undefined, '', '0', 'false', 'off', 'FALSE'])('is off for %s (the default)', (raw) => {
    const env = raw === undefined ? {} : { REVIEW_YETI_DIFF_SHRINK: raw };
    expect(diffShrinkEnabledFor(env, 'review-yeti-ai/review-yeti-bot')).toBe(false);
  });

  it.each(['1', 'true', 'on', 'all', 'TRUE'])('is on for every repository with %s', (raw) => {
    expect(diffShrinkEnabledFor({ REVIEW_YETI_DIFF_SHRINK: raw }, 'acme/anything')).toBe(true);
  });

  it('can be enabled per repository first', () => {
    const env = { REVIEW_YETI_DIFF_SHRINK: 'review-yeti-ai/review-yeti-bot, calltelemetry/ct-meta' };
    expect(diffShrinkEnabledFor(env, 'review-yeti-ai/review-yeti-bot')).toBe(true);
    expect(diffShrinkEnabledFor(env, 'CallTelemetry/CT-Meta')).toBe(true);
    expect(diffShrinkEnabledFor(env, 'calltelemetry/ct-quasar')).toBe(false);
    expect(diffShrinkEnabledFor(env, '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 1: whitespace
// ---------------------------------------------------------------------------

describe('whitespace-only collapse', () => {
  it('lists a file whose only change is indentation and does not send its content', () => {
    const { files: out, disclosure } = planDiffShrink(effective(modified('src/app.ts', [WS_HUNK])), ON);
    expect(disclosure.whitespaceOnlyFiles).toEqual(['src/app.ts']);
    expect(out[0].patch).not.toContain('WS_ONLY_MARKER');
    expect(out[0].patch).toContain('\\ Review Yeti: whitespace-only change, not sent');
    expect(out[0].path).toBe('src/app.ts');
  });

  it('collapses only the whitespace-only hunk of a mixed file and keeps the real hunk verbatim', () => {
    const { files: out, disclosure } = planDiffShrink(effective(modified('src/app.ts', [WS_HUNK, REAL_HUNK])), ON);
    expect(disclosure.whitespaceOnlyFiles).toEqual([]);
    expect(disclosure.collapsedWhitespaceHunks).toEqual([{ path: 'src/app.ts', hunks: 1 }]);
    expect(out[0].patch).not.toContain('WS_ONLY_MARKER');
    expect(out[0].patch).toContain('\\ Review Yeti: whitespace-only hunk -1,3 +1,3 not sent');
    expect(out[0].patch).toContain(`${REAL_HUNK}\n`);
    // Still a parseable diff for the same path.
    expect(parseChangedFiles(out[0].patch!).files[0].path).toBe('src/app.ts');
  });

  it('treats indentation, CRLF conversion, blank lines and a final newline as whitespace', () => {
    expect(isWhitespaceOnlyHunk(['-a = 1;', '+\t\ta = 1;'])).toBe(true);
    expect(isWhitespaceOnlyHunk(['-a = 1;\r', '+a = 1;'])).toBe(true);
    expect(isWhitespaceOnlyHunk([' a();', '+', '+\t', ' b();'])).toBe(true);
    expect(isWhitespaceOnlyHunk(['-last();', '\\ No newline at end of file', '+last();'])).toBe(true);
  });

  it('never treats whitespace INSIDE a line as ignorable (git -w would)', () => {
    // `"a b"` -> `"ab"` changes a string literal; `x = y` -> `x=y` is harmless but indistinguishable here.
    expect(isWhitespaceOnlyHunk(['-const s = "a b";', '+const s = "ab";'])).toBe(false);
    const { disclosure } = planDiffShrink(
      effective(modified('src/text.ts', ['@@ -1 +1 @@', '-const s = "a b";', '+const s = "ab";'])), ON,
    );
    expect(disclosure.whitespaceOnlyFiles).toEqual([]);
  });

  it('never treats trailing whitespace as ignorable: it is part of a multi-line literal\'s value', () => {
    expect(isWhitespaceOnlyHunk(['-a = 1;  ', '+a = 1;'])).toBe(false);
    expect(isWhitespaceOnlyHunk([' SELECT id', '-FROM t', '+FROM t  '])).toBe(false);
  });

  it.each([
    [' const q = `', '-  SELECT *', '+SELECT *', ' `;'],
    [' doc = ' + '"'.repeat(3), '-  body', '+body'],
    [" doc = " + "'".repeat(3), '-  body', '+body'],
    [' cat <<EOF', '-  body', '+body', ' EOF'],
    [" cat <<-'EOF'", '-  body', '+body'],
    [' auto s = R"(', '-  body', '+body'],
  ])('never collapses a hunk that shows a multi-line literal delimiter: %j', (...lines: string[]) => {
    expect(isWhitespaceOnlyHunk(lines)).toBe(false);
  });

  it('never treats a reordering or a real edit as whitespace', () => {
    expect(isWhitespaceOnlyHunk(['-a();', '-b();', '+b();', '+a();'])).toBe(false);
    // A line removed above a context line and re-added below it is a move, not whitespace.
    expect(isWhitespaceOnlyHunk(['-  item_a,', '   item_b,', '+  item_a,'])).toBe(false);
    expect(isWhitespaceOnlyHunk(['-  item_a,', ' item_b,', '+item_a,', ' item_c,'])).toBe(false);
    expect(isWhitespaceOnlyHunk([' context only'])).toBe(false);
    expect(isWhitespaceOnlyHunk(['-gone();'])).toBe(false);
  });

  it.each(['app/models.py', 'deploy/values.yaml', 'config/ci.yml', 'Makefile', 'mk/rules.mk', 'README.md'])(
    'never collapses whitespace in the whitespace-significant format %s',
    (path) => {
      const { files: out, disclosure } = planDiffShrink(effective(modified(path, [WS_HUNK])), ON);
      expect(disclosure.whitespaceOnlyFiles).toEqual([]);
      expect(out[0].patch).toContain('WS_ONLY_MARKER');
    },
  );

  it('keeps a security-sensitive file at full depth and discloses the declined rule', () => {
    const { files: out, disclosure } = planDiffShrink(effective(modified('src/auth/session.ts', [WS_HUNK])), ON);
    expect(disclosure.whitespaceOnlyFiles).toEqual([]);
    expect(disclosure.keptFullDepth).toEqual([{ path: 'src/auth/session.ts', rule: 'whitespace' }]);
    expect(out[0].patch).toContain('WS_ONLY_MARKER');
  });

  it('never shrinks a submodule gitlink, a symlink or a binary file', () => {
    const gitlink = 'diff --git a/vendor/lib b/vendor/lib\nindex 6c3f36d..f84610f 160000\n--- a/vendor/lib\n+++ b/vendor/lib\n'
      + '@@ -1 +1 @@\n-Subproject commit 6c3f36d89d675d27c0a8b88f684d57c6185a7e6b\n+Subproject commit f84610fbbf478540b07861fa7a18174126ffe5bb\n';
    const symlink = 'diff --git a/src/link.ts b/src/link.ts\nindex 1111111..2222222 120000\n--- a/src/link.ts\n+++ b/src/link.ts\n'
      + '@@ -1 +1 @@\n-target.ts\n+  target.ts\n';
    const binary = 'diff --git a/src/data.bin.ts b/src/data.bin.ts\nindex 1111111..2222222 100644\nBinary files a/src/data.bin.ts and b/src/data.bin.ts differ\n';
    const everything: DiffShrinkInput = { enabled: true, linguist: { status: 'applied', content: '* linguist-generated\n' } };
    for (const diff of [gitlink, symlink, binary]) {
      const before = effective(diff);
      const { files: out, disclosure } = planDiffShrink(before, everything);
      expect(out).toEqual(before);
      expect(disclosure.linguistExcluded).toEqual([]);
      expect(disclosure.whitespaceOnlyFiles).toEqual([]);
    }
  });

  it('never shrinks a file whose mode changes', () => {
    const diff = [
      'diff --git a/src/run.ts b/src/run.ts', 'old mode 100644', 'new mode 100755',
      'index 1111111..2222222', '--- a/src/run.ts', '+++ b/src/run.ts', WS_HUNK,
    ].join('\n') + '\n';
    const { files: out, disclosure } = planDiffShrink(effective(diff), ON);
    expect(disclosure.whitespaceOnlyFiles).toEqual([]);
    expect(out[0].patch).toContain('WS_ONLY_MARKER');
  });

  it('keeps the ORIGINAL size for the fast-ship size bar, so shrinking never makes a file fast-ship eligible', () => {
    // Markdown is the one text format fast-ship accepts; only its size can bar it.
    const big = Array.from({ length: 400 }, (_, index) => [`-old line ${index}`, `+new line ${index}`]).flat();
    const diff = modified('docs/notes.mkdn', ['@@ -1,400 +1,400 @@', ...big]);
    const before = effective(diff);
    const { files: out, disclosure } = planDiffShrink(before, {
      enabled: true, linguist: { status: 'applied', content: '*.mkdn linguist-generated\n' },
    });
    expect(disclosure.linguistExcluded).toHaveLength(1);
    const maxFileSize = 2_000;
    expect(Buffer.byteLength(before[0].patch!, 'utf8')).toBeGreaterThan(maxFileSize);
    expect(Buffer.byteLength(out[0].patch!, 'utf8')).toBeLessThan(maxFileSize);
    expect(containsExecutableOrSensitiveCode(before as never, { maxFileSize })).toBe(true);
    expect(containsExecutableOrSensitiveCode(out as never, { maxFileSize })).toBe(true);
    // Sanity: the same small file is fast-ship eligible, so the bar above is the size alone.
    expect(containsExecutableOrSensitiveCode([{ ...out[0], byteSize: undefined }] as never, { maxFileSize })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 2: renames and moves
// ---------------------------------------------------------------------------

describe('rename and move detection', () => {
  const pureRename = [
    'diff --git a/src/old/name.ts b/src/new/name.ts', 'similarity index 100%',
    'rename from src/old/name.ts', 'rename to src/new/name.ts',
  ].join('\n') + '\n';
  const modifiedRename = [
    'diff --git a/src/old/util.ts b/src/new/util.ts', 'similarity index 91%',
    'rename from src/old/util.ts', 'rename to src/new/util.ts', 'index 1111111..2222222 100644',
    '--- a/src/old/util.ts', '+++ b/src/new/util.ts', REAL_HUNK,
  ].join('\n') + '\n';

  it('shows a pure rename as old -> new (similarity N%) and sends only its header', () => {
    const before = effective(pureRename);
    const { files: out, disclosure } = planDiffShrink(before, ON);
    expect(disclosure.renames).toEqual([{
      from: 'src/old/name.ts', to: 'src/new/name.ts', similarity: 100, kind: 'rename',
      detectedBy: 'diff-header', contentSent: 'none',
    }]);
    expect(out[0].patch).toBe(before[0].patch);
    expect(out[0].patch).not.toContain('@@');
  });

  it('sends only the changed hunks of a modified rename', () => {
    const { files: out, disclosure } = planDiffShrink(effective(modifiedRename), ON);
    expect(disclosure.renames[0]).toMatchObject({ similarity: 91, contentSent: 'changed-hunks' });
    expect(out[0].patch).toContain('REAL_CHANGE_MARKER');
  });

  it('reads git-quoted rename paths (spaces force quoting)', () => {
    const quoted = [
      'diff --git "a/src/old/my file.ts" "b/src/new/my file.ts"', 'similarity index 100%',
      'rename from "src/old/my file.ts"', 'rename to "src/new/my file.ts"',
    ].join('\n') + '\n';
    const { disclosure } = planDiffShrink(effective(quoted), ON);
    expect(disclosure.renames).toEqual([expect.objectContaining({ from: 'src/old/my file.ts', to: 'src/new/my file.ts' })]);
    const intoAuth = quoted.replace(/src\/new\/my file\.ts/gu, 'src/auth/my file.ts').replace(/rename from "src\/old/u, 'rename from "src/auth');
    expect(planDiffShrink(effective(intoAuth), ON).disclosure.renames).toEqual([]);
  });

  it('reports a git -C copy as a copy', () => {
    const copy = pureRename.replace(/rename (from|to)/gu, 'copy $1');
    expect(planDiffShrink(effective(copy), ON).disclosure.renames[0].kind).toBe('copy');
  });

  it('keeps a rename into or out of a security-sensitive path at full depth', () => {
    const intoWorkflows = pureRename.replace(/src\/new\/name\.ts/gu, '.github/workflows/name.yml');
    const { disclosure } = planDiffShrink(effective(intoWorkflows), ON);
    expect(disclosure.renames).toEqual([]);
    expect(disclosure.keptFullDepth).toEqual([{ path: '.github/workflows/name.yml', rule: 'rename' }]);
    const outOfAuth = pureRename.replace(/src\/old\/name\.ts/gu, 'src/auth/name.ts');
    expect(planDiffShrink(effective(outOfAuth), ON).disclosure.renames).toEqual([]);
  });

  const deleted = (path: string, lines: string[], mode = '100644') => [
    `diff --git a/${path} b/${path}`, `deleted file mode ${mode}`, 'index 3333333..0000000',
    `--- a/${path}`, '+++ /dev/null', `@@ -1,${lines.length} +0,0 @@`, ...lines.map((line) => `-${line}`),
  ].join('\n') + '\n';
  const added = (path: string, lines: string[], mode = '100644') => [
    `diff --git a/${path} b/${path}`, `new file mode ${mode}`, 'index 0000000..3333333',
    '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`),
  ].join('\n') + '\n';
  const BODY = ['export function moved() {', '  return MOVED_MARKER;', '}'];

  it('pairs a byte-identical delete and add the diff source did not pair, and sends neither body', () => {
    const { files: out, disclosure } = planDiffShrink(
      effective(deleted('src/a/moved.ts', BODY) + added('src/b/moved.ts', BODY)), ON,
    );
    expect(disclosure.renames).toEqual([{
      from: 'src/a/moved.ts', to: 'src/b/moved.ts', similarity: 100, kind: 'rename',
      detectedBy: 'content-match', contentSent: 'none',
    }]);
    expect(out.map((file) => file.path)).toEqual(['src/a/moved.ts', 'src/b/moved.ts']);
    expect(out.every((file) => !file.patch!.includes('MOVED_MARKER'))).toBe(true);
  });

  it('never pairs a move into or out of a security-sensitive path, and discloses both sides', () => {
    const intoWorkflows = planDiffShrink(effective(deleted('src/a/moved.ts', BODY) + added('.github/workflows/moved.ts', BODY)), ON);
    expect(intoWorkflows.disclosure.renames).toEqual([]);
    expect(intoWorkflows.disclosure.keptFullDepth).toEqual([
      { path: '.github/workflows/moved.ts', rule: 'rename' }, { path: 'src/a/moved.ts', rule: 'rename' },
    ]);
    expect(intoWorkflows.files.every((file) => file.patch!.includes('MOVED_MARKER'))).toBe(true);
    const outOfEnv = planDiffShrink(effective(deleted('.env.production', BODY) + added('src/copy.txt.ts', BODY)), ON);
    expect(outOfEnv.disclosure.renames).toEqual([]);
    expect(outOfEnv.files.every((file) => file.patch!.includes('MOVED_MARKER'))).toBe(true);
  });

  it('does not pair when the content differs, the match is ambiguous, or the mode differs', () => {
    const changed = [...BODY.slice(0, 2), '} // edited'];
    expect(planDiffShrink(effective(deleted('src/a.ts', BODY) + added('src/b.ts', changed)), ON).disclosure.renames).toEqual([]);
    const twoTargets = deleted('src/a.ts', BODY) + added('src/b.ts', BODY) + added('src/c.ts', BODY);
    expect(planDiffShrink(effective(twoTargets), ON).disclosure.renames).toEqual([]);
    const nowExecutable = deleted('src/a.ts', BODY) + added('src/b.ts', BODY, '100755');
    expect(planDiffShrink(effective(nowExecutable), ON).disclosure.renames).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 3: .gitattributes linguist-generated / linguist-vendored
// ---------------------------------------------------------------------------

describe('.gitattributes linguist rules', () => {
  it('follows gitattributes pattern semantics', () => {
    const at = (pattern: string, path: string) => compileGitattributesPattern(pattern)!.test(path);
    expect(at('*.pb.ts', 'src/deep/api.pb.ts')).toBe(true); // no slash: any depth
    expect(at('gen/*.ts', 'gen/a.ts')).toBe(true); // slash: anchored
    expect(at('gen/*.ts', 'src/gen/a.ts')).toBe(false);
    expect(at('gen/*.ts', 'gen/sub/a.ts')).toBe(false); // * does not cross /
    expect(at('/vendor/**', 'vendor/x/y.js')).toBe(true);
    expect(at('**/generated/*.go', 'a/b/generated/z.go')).toBe(true);
    expect(at('**/generated/*.go', 'generated/z.go')).toBe(true);
    expect(at('a/**/b.ts', 'a/b.ts')).toBe(true);
    expect(at('a/**/b.ts', 'a/x/y/b.ts')).toBe(true);
    expect(at('file[0-9].ts', 'file7.ts')).toBe(true);
    expect(at('file[!0].ts', 'file1.ts')).toBe(true); // negated class
    expect(at('file[!0].ts', 'file0.ts')).toBe(false);
    expect(at('file[^0].ts', 'file1.ts')).toBe(true); // ^ negation, same as !
    expect(at('file[^0].ts', 'file0.ts')).toBe(false);
    expect(at('*.[!o]pb.go', 'api.opb.go')).toBe(false);
    expect(compileGitattributesPattern('vendor/')).toBeNull(); // directories never match files
    // A bare `**` (no slash) is a file-name glob that matches everything, not a directory walk.
    expect(at('**', 'src/deep/file.ts')).toBe(true);
    expect(at('***.ts', 'a/b.ts')).toBe(true);
    const everything = parseLinguistAttributes('** linguist-generated\n');
    expect(linguistExclusionFor(everything, 'src/app.ts')).toBe('linguist-generated');
  });

  it('matches crafted repository patterns in linear time (no regex backtracking)', () => {
    const manyGlobstars = compileGitattributesPattern(`a/${Array.from({ length: 40 }, () => '**').join('/x/')}/z.ts`)!;
    const deepPath = `a/${Array.from({ length: 250 }, () => 'x').join('/')}/nope.ts`;
    const starHeavy = compileGitattributesPattern(`${'*a'.repeat(30)}*b`)!;
    const started = performance.now();
    expect(manyGlobstars.test(deepPath)).toBe(false);
    expect(starHeavy.test('a'.repeat(250))).toBe(false);
    expect(compileGitattributesPattern('a/**/**/**/b.ts')!.test('a/x/y/b.ts')).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('lets the last matching line decide, and honours unset, false and unspecified', () => {
    const attributes = parseLinguistAttributes([
      '# comment',
      '*.gen.ts linguist-generated',
      'keep.gen.ts -linguist-generated',
      'vendor/** linguist-vendored=true',
      'vendor/ours/** linguist-vendored=false',
      'third_party/** linguist-vendored',
      'third_party/patched.c !linguist-vendored',
      '"quoted *.ts" linguist-generated',
      '[attr]gen linguist-generated',
      '!neg.ts linguist-generated',
    ].join('\n'));
    expect(attributes.hasExclusions).toBe(true);
    expect(linguistExclusionFor(attributes, 'src/api.gen.ts')).toBe('linguist-generated');
    expect(linguistExclusionFor(attributes, 'src/keep.gen.ts')).toBeNull();
    expect(linguistExclusionFor(attributes, 'vendor/lib/x.js')).toBe('linguist-vendored');
    expect(linguistExclusionFor(attributes, 'vendor/ours/x.js')).toBeNull();
    expect(linguistExclusionFor(attributes, 'third_party/patched.c')).toBeNull();
    expect(linguistExclusionFor(attributes, 'src/app.ts')).toBeNull();
    expect(parseLinguistAttributes('*.ts text eol=lf').hasExclusions).toBe(false);
  });

  const applied = (content: string): DiffShrinkInput => ({ enabled: true, linguist: { status: 'applied', content } });

  it('fails open when a rule cannot be evaluated: the file is not excluded', () => {
    const attributes = parseLinguistAttributes('*.ts linguist-generated\n');
    vi.spyOn(attributes.rules[0].matcher, 'test').mockImplementation(() => { throw new Error('boom'); });
    expect(linguistExclusionFor(attributes, 'src/app.ts')).toBeNull();
  });

  it('lists a linguist-generated file without sending its content', () => {
    const diff = modified('src/api.gen.ts', ['@@ -1 +1 @@', '-GENERATED_OLD', '+GENERATED_MARKER'])
      + modified('src/app.ts', [REAL_HUNK]);
    const { files: out, disclosure } = planDiffShrink(effective(diff), applied('*.gen.ts linguist-generated\n'));
    expect(disclosure.linguistExcluded).toEqual([{ path: 'src/api.gen.ts', attribute: 'linguist-generated' }]);
    expect(out.map((file) => file.path)).toEqual(['src/api.gen.ts', 'src/app.ts']);
    expect(out[0].patch).not.toContain('GENERATED_MARKER');
    expect(out[0].patch).toContain('\\ Review Yeti: not sent (linguist-generated in .gitattributes, 2 changed lines)');
    expect(out[1].patch).toContain('REAL_CHANGE_MARKER');
  });

  it('never excludes a security-sensitive path, even when .gitattributes marks it', () => {
    const diff = modified('.github/workflows/release.yml', ['@@ -1 +1 @@', '-a: 1', '+a: WORKFLOW_MARKER']);
    const { files: out, disclosure } = planDiffShrink(effective(diff), applied('*.yml linguist-generated\n'));
    expect(disclosure.linguistExcluded).toEqual([]);
    expect(disclosure.keptFullDepth).toEqual([{ path: '.github/workflows/release.yml', rule: 'linguist' }]);
    expect(out[0].patch).toContain('WORKFLOW_MARKER');
  });

  it('applies nothing unless the rules were supplied as applied', () => {
    const diff = modified('src/api.gen.ts', ['@@ -1 +1 @@', '-x', '+GENERATED_MARKER']);
    for (const input of [ON, { enabled: true, linguist: { status: 'not-applied', reason: 'r' } } as DiffShrinkInput]) {
      expect(planDiffShrink(effective(diff), input).files[0].patch).toContain('GENERATED_MARKER');
    }
  });

  describe('loadDiffShrinkInput (which rules a pull request cannot have written)', () => {
    const provider = (over: Partial<{ readFile: unknown; findFiles: unknown; treeTruncated: unknown }> = {}) => ({
      readFile: vi.fn(async () => '*.gen.ts linguist-generated\n'),
      findFiles: vi.fn(async () => ['.gitattributes', 'src/a.ts']),
      treeTruncated: vi.fn(async () => false),
      ...over,
    }) as never;
    const env = { REVIEW_YETI_DIFF_SHRINK: 'acme/app' };
    const load = (over: Record<string, unknown> = {}) => loadDiffShrinkInput({
      env, repository: 'acme/app', changedPaths: ['src/a.ts'], repoFileProvider: provider(), ...over,
    });

    it('is undefined, and reads nothing, when the flag is off', async () => {
      const repoFileProvider = provider();
      expect(await load({ env: {}, repoFileProvider })).toBeUndefined();
      expect(await load({ repository: 'acme/other', repoFileProvider })).toBeUndefined();
      expect((repoFileProvider as any).readFile).not.toHaveBeenCalled();
    });

    it('applies the root rules when the PR does not touch any .gitattributes', async () => {
      expect(await load()).toEqual({
        enabled: true, linguist: { status: 'applied', content: '*.gen.ts linguist-generated\n' },
      });
    });

    it.each([
      [['.gitattributes', 'src/a.ts'], 'this pull request changes a .gitattributes file'],
      [['pkg/.gitattributes'], 'this pull request changes a .gitattributes file'],
    ])('refuses rules when the PR changes %j', async (changedPaths, reason) => {
      const repoFileProvider = provider();
      expect(await load({ changedPaths, repoFileProvider })).toEqual({ enabled: true, linguist: { status: 'not-applied', reason } });
      expect((repoFileProvider as any).readFile).not.toHaveBeenCalled();
    });

    it('refuses rules when nested .gitattributes files exist or the tree is truncated', async () => {
      expect((await load({ repoFileProvider: provider({ findFiles: vi.fn(async () => ['.gitattributes', 'pkg/.gitattributes']) }) }))?.linguist)
        .toEqual({ status: 'not-applied', reason: 'nested .gitattributes files are not supported' });
      expect((await load({ repoFileProvider: provider({ treeTruncated: vi.fn(async () => true) }) }))?.linguist)
        .toEqual({ status: 'not-applied', reason: 'the repository tree listing was truncated' });
    });

    it('fails open to no exclusions on a read error, a timeout or no provider', async () => {
      const notApplied = { status: 'not-applied', reason: 'the repository .gitattributes could not be read' };
      expect((await load({ repoFileProvider: provider({ readFile: vi.fn(async () => { throw new Error('boom'); }) }) }))?.linguist)
        .toEqual(notApplied);
      expect((await load({ timeoutMs: 5, repoFileProvider: provider({ readFile: vi.fn(() => new Promise(() => {})) }) }))?.linguist)
        .toEqual(notApplied);
      expect((await load({ repoFileProvider: undefined }))?.linguist)
        .toEqual({ status: 'not-applied', reason: 'repository files are not readable in this run' });
    });

    it('reports none-declared for a missing file or one without linguist exclusions', async () => {
      expect((await load({ repoFileProvider: provider({ readFile: vi.fn(async () => null) }) }))?.linguist).toEqual({ status: 'none-declared' });
      expect((await load({ repoFileProvider: provider({ readFile: vi.fn(async () => '* text=auto\n') }) }))?.linguist).toEqual({ status: 'none-declared' });
    });
  });
});

// ---------------------------------------------------------------------------
// Invariant 4: one decision, every path
// ---------------------------------------------------------------------------

describe('one applicability decision (worker, engines, trusted completion)', () => {
  const transport = { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'k', model: 'review-model' };
  const roster = resolveWorkerConfig({ REVIEW_PERSONAS: 'security,architecture,testing' }, transport)
    .personas.filter((persona) => persona.enabled);
  const EVERYTHING: DiffShrinkInput = { enabled: true, linguist: { status: 'applied', content: '* linguist-generated\n' } };
  const corpus: Record<string, string> = {
    'whitespace only': modified('src/app.ts', [WS_HUNK]),
    'mixed': modified('src/app.ts', [WS_HUNK, REAL_HUNK]) + modified('tests/app.test.ts', [WS_HUNK]),
    'every file linguist-generated': modified('src/api.gen.ts', [REAL_HUNK]) + modified('lib/out.js', [REAL_HUNK]),
    'documentation only': modified('docs/guide.md', [WS_HUNK]),
    'pure rename': 'diff --git a/src/a.ts b/src/b.ts\nsimilarity index 100%\nrename from src/a.ts\nrename to src/b.ts\n',
    'gitlink': 'diff --git a/ct-dashboard b/ct-dashboard\nindex 6c3f36d89d..f84610fbbf 160000\n--- a/ct-dashboard\n+++ b/ct-dashboard\n'
      + '@@ -1 +1 @@\n-Subproject commit 6c3f36d89d675d27c0a8b88f684d57c6185a7e6b\n+Subproject commit f84610fbbf478540b07861fa7a18174126ffe5bb\n',
  };

  it.each(Object.entries(corpus))('shrinking never changes the lanes, the exemption or the failure: %s', (_name, diff) => {
    const changed = files(diff);
    // What the service's trusted completion context derives (no flag, no .gitattributes).
    const service = resolveReviewApplicability(roster, changed, { pathFilters: [] });
    const worker = resolveShrunkReviewApplicability(roster, changed, { pathFilters: [], diffShrink: EVERYTHING });
    expect(worker.applicable.map((persona) => persona.id)).toEqual(service.applicable.map((persona) => persona.id));
    expect(worker.noReviewableContent).toBe(service.noReviewableContent);
    expect(worker.noReviewableContentKind).toBe(service.noReviewableContentKind);
    expect(worker.unmatchedPaths).toEqual(service.unmatchedPaths);
    expect(worker.effectiveFiles.map((file) => file.path)).toEqual(service.effectiveFiles.map((file) => file.path));
  });

  it('is exactly the shared decision when the flag is off', () => {
    const changed = files(corpus.mixed);
    const service = resolveReviewApplicability(roster, changed, { pathFilters: [] });
    for (const diffShrink of [undefined, { enabled: false }]) {
      const worker = resolveShrunkReviewApplicability(roster, changed, { pathFilters: [], diffShrink });
      expect(worker.diffShrink).toBeNull();
      expect(worker.effectiveFiles).toEqual(service.effectiveFiles);
    }
  });

  it('does not shrink a zero-lane decision', () => {
    const worker = resolveShrunkReviewApplicability(roster, files(corpus['documentation only']), { diffShrink: EVERYTHING });
    expect(worker.noReviewableContent).toBe(true);
    expect(worker.diffShrink).toBeNull();
  });

  it('attaches the disclosure to an engine result only when shrinking ran', () => {
    const disclosure = resolveShrunkReviewApplicability(roster, files(corpus.mixed), { diffShrink: ON }).diffShrink;
    expect(disclosure).not.toBeNull();
    expect(attachDiffShrinkDisclosure({ headSha: 'x' }, disclosure)).toEqual({ headSha: 'x', diffShrink: disclosure });
    expect(attachDiffShrinkDisclosure({ headSha: 'x' }, null)).toEqual({ headSha: 'x' });
  });
});

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

describe('check-summary disclosure', () => {
  it('renders nothing when the flag is off', () => {
    expect(renderDiffShrinkSummary(null)).toEqual([]);
  });

  it('lists every rule, every file and every declined sensitive file', () => {
    const generated = ['@@ -1,40 +1,40 @@', ...Array.from({ length: 40 }, (_, i) => [`-old${i}`, `+new${i}`]).flat()].join('\n');
    const diff = modified('src/app.ts', [WS_HUNK]) + modified('src/mixed.ts', [WS_HUNK, REAL_HUNK])
      + modified('src/api.gen.ts', [generated]) + modified('src/auth/login.ts', [WS_HUNK])
      + 'diff --git a/src/a.ts b/src/b.ts\nsimilarity index 97%\nrename from src/a.ts\nrename to src/b.ts\n';
    const { disclosure } = planDiffShrink(effective(diff), { enabled: true, linguist: { status: 'applied', content: '*.gen.ts linguist-generated' } });
    const text = renderDiffShrinkSummary(disclosure).join('\n');
    expect(text).toContain('**Diff shrinking** (`REVIEW_YETI_DIFF_SHRINK`)');
    expect(text).toContain('- Whitespace-only, content not sent (1): `src/app.ts`');
    expect(text).toContain('- Whitespace-only hunks collapsed (1 in 1 file(s)): `src/mixed.ts` (1)');
    expect(text).toContain('- Renamed, moved or copied (1): `src/a.ts` -> `src/b.ts` (rename, similarity 97%, content unchanged, not sent)');
    const modifiedRename = 'diff --git a/src/c.ts b/src/d.ts\nsimilarity index 88%\nrename from src/c.ts\nrename to src/d.ts\n'
      + 'index 1111111..2222222 100644\n--- a/src/c.ts\n+++ b/src/d.ts\n' + REAL_HUNK + '\n';
    expect(renderDiffShrinkSummary(planDiffShrink(effective(modifiedRename), ON).disclosure).join('\n'))
      .toContain('- Renamed, moved or copied (1): `src/c.ts` -> `src/d.ts` (rename, similarity 88%, only changed hunks sent)');
    expect(text).toContain('- Excluded by .gitattributes, content not sent (1): `src/api.gen.ts` (linguist-generated)');
    expect(text).toContain('- Security-sensitive, kept at full depth (1): `src/auth/login.ts` (whitespace)');
    expect(disclosure.estimatedTokensAfter).toBeLessThan(disclosure.estimatedTokensBefore);
  });

  it('says why .gitattributes rules were not applied, and says so when nothing shrank', () => {
    const text = renderDiffShrinkSummary(planDiffShrink(
      effective(modified('src/app.ts', [REAL_HUNK])),
      { enabled: true, linguist: { status: 'not-applied', reason: 'this pull request changes a .gitattributes file' } },
    ).disclosure).join('\n');
    expect(text).toContain('- .gitattributes linguist rules not applied: this pull request changes a .gitattributes file.');
    // REL-1141: without the decision's not-sent-in-full list, never claim every change was sent in full.
    expect(text).toContain('- No file was shrunk by diff shrinking.');
    expect(text).not.toContain('every change was sent in full');
  });

  it('caps long lists and neutralises backticks and newlines in paths', () => {
    const diff = Array.from({ length: 20 }, (_, index) => modified(`src/f${index}.ts`, [WS_HUNK])).join('');
    const text = renderDiffShrinkSummary(planDiffShrink(effective(diff), ON).disclosure).join('\n');
    expect(text).toContain('(20):');
    expect(text).toContain('+5 more');
    const [line] = renderDiffShrinkSummary({
      ...planDiffShrink([], ON).disclosure, whitespaceOnlyFiles: ['a`b\nc.ts'],
    }).slice(1);
    expect(line).toContain('`a b c.ts`');
  });
});

describe('security-sensitive path list', () => {
  it.each([
    'src/auth/login.ts', 'src/authentication.ts', 'src/authorization.ts', 'src/auth/authentication/index.go',
    'lib/authenticate.ts', 'lib/authorize.ts', 'src/userAuthService.ts', 'src/loadSecrets.go', 'src/passwords.ts',
    'src/encryption/aes.go', 'src/credentialStore.ts', 'lib/crypto/aes.go', 'app/secrets.rb', 'pkg/oauth2/client.go', '.github/workflows/ci.yml',
    '.gitlab-ci.yml', 'Dockerfile', 'docker/api.Dockerfile', 'infra/main.tf', 'charts/app/values.yaml', 'package.json',
    'requirements-dev.txt', 'go.mod', 'App.csproj', '.gitattributes', 'scripts/release.sh', 'db/migrations/001.sql',
    '.env.production', '', 42,
  ])('%s is always reviewed at full depth', (path) => {
    expect(isSecuritySensitivePath(path)).toBe(true);
  });

  it.each(['src/app.ts', 'src/keyboard.ts', 'tests/app.test.ts', 'docs/guide.md', 'src/monkey.ts', 'src/author.ts'])(
    '%s is not on the list', (path) => {
      expect(isSecuritySensitivePath(path)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Engine wiring: what the persona actually receives
// ---------------------------------------------------------------------------

describe('persona panel wiring', () => {
  function panelConfig() {
    return ctReviewConfigV3Schema.parse({
      ...createDefaultV3Config(),
      quorum: 1,
      personas: [{
        id: 'correctness-lane', enabled: true, required: true, charter: 'builtin:correctness',
        paths: ['**/*.ts'], providers: ['mock-llm'], maxTurns: 2,
      }],
      reviewers: {
        execution: 'personas', fallback: 'none', overall_timeout_s: 30,
        providers: [{ id: 'mock-llm', enabled: true, model: 'mock-model', effort: 'medium', review_timeout_s: 30, arbiter_timeout_s: 30 }],
        arbiter: { order: ['mock-llm'] },
      },
    });
  }

  async function personaPrompts(diffShrink?: DiffShrinkInput): Promise<{ text: string; disclosure: unknown }> {
    const prompts: string[] = [];
    const client = {
      complete: vi.fn(async (req: any) => {
        const text = req.messages.map((message: any) => extractMessageContentText(message.content)).join('\n');
        const nonce = (/CT_REVIEW_NONCE:([^\n"\\]+)/u.exec(JSON.stringify(req.messages))?.[1] ?? 'n').trim();
        const role = req.metadata?.role;
        if (role === 'moderator') return { model: req.model, content: JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }), usage: { prompt: 1, completion: 1, total: 2 }, costUSD: 0, raw: {} };
        if (role === 'arbiter') return { model: req.model, content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'ok' }), usage: { prompt: 1, completion: 1, total: 2 }, costUSD: 0, raw: {} };
        prompts.push(text);
        return { model: req.model, content: JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }), usage: { prompt: 1, completion: 1, total: 2 }, costUSD: 0, raw: {} };
      }),
    };
    const result = await executePersonaPanel({
      config: panelConfig(),
      changedFiles: files(modified('src/app.ts', [WS_HUNK, REAL_HUNK]) + modified('src/other.ts', [WS_HUNK])),
      repository: 'acme/app',
      headSha: 'f'.repeat(40),
      client: client as never,
      deterministicRoster: true,
      requestPolicy: { responseFormat: { type: 'json_object' } },
      ...(diffShrink ? { diffShrink } : {}),
    });
    expect(result.applicablePersonaIds).toEqual(['correctness-lane']);
    return { text: prompts.join('\n'), disclosure: result.diffShrink };
  }

  it('sends every change in full without the flag (today\'s behaviour)', async () => {
    const { text, disclosure } = await personaPrompts();
    expect(text).toContain('WS_ONLY_MARKER');
    expect(text).toContain('REAL_CHANGE_MARKER');
    expect(disclosure).toBeUndefined();
  });

  it('sends the shrunk diff with the flag and returns the disclosure of exactly that shrink', async () => {
    const { text, disclosure } = await personaPrompts(ON);
    expect(text).not.toContain('WS_ONLY_MARKER');
    expect(text).toContain('REAL_CHANGE_MARKER');
    expect(text).toContain('src/other.ts');
    expect(disclosure).toMatchObject({
      whitespaceOnlyFiles: ['src/other.ts'],
      collapsedWhitespaceHunks: [{ path: 'src/app.ts', hunks: 1 }],
    });
  });
});

describe('composed engine wiring', () => {
  const COMPOSED_CONFIG = () => ctReviewConfigV3Schema.parse({
    ...createDefaultV3Config(),
    quorum: 1,
    personas: [{ id: 'security', enabled: true, required: true, charter: 'builtin:security', paths: ['**/*'], providers: ['codex'] }],
    reviewers: {
      execution: 'personas', fallback: 'none', overall_timeout_s: 30,
      providers: [{ id: 'codex', enabled: true, model: 'codex/model', effort: 'high', review_timeout_s: 15, arbiter_timeout_s: 15 }],
      arbiter: { order: ['codex'] },
    },
    composed: { max_tasks: 1, max_turns_total: 4, max_turns_per_task: 2 },
  });

  // The first model call is the plan turn; its prompt carries the static diff prefix.
  async function planPrompt(diffShrink?: DiffShrinkInput): Promise<string> {
    const prompts: string[] = [];
    const client = {
      complete: vi.fn(async (req: any) => {
        prompts.push(req.messages.map((message: any) => extractMessageContentText(message.content)).join('\n'));
        throw new Error('stop after the plan prompt');
      }),
    };
    await executeComposedReview({
      config: COMPOSED_CONFIG(),
      changedFiles: files(modified('src/app.ts', [WS_HUNK, REAL_HUNK]) + modified('src/other.ts', [WS_HUNK])),
      repository: 'acme/app',
      headSha: 'e'.repeat(40),
      client: client as never,
      ...(diffShrink ? { diffShrink } : {}),
    }).catch(() => undefined);
    expect(prompts.length).toBeGreaterThan(0);
    return prompts[0];
  }

  it('sends every change in full without the flag', async () => {
    const text = await planPrompt();
    expect(text).toContain('WS_ONLY_MARKER');
    expect(text).toContain('REAL_CHANGE_MARKER');
  });

  it('sends the shrunk diff with the flag', async () => {
    const text = await planPrompt(ON);
    expect(text).not.toContain('WS_ONLY_MARKER');
    expect(text).toContain('REAL_CHANGE_MARKER');
  });

  it('returns the disclosure of its own shrink on a completed run, and none without the flag', async () => {
    const run = (diffShrink?: DiffShrinkInput) => {
      const client = {
        complete: vi.fn(async (req: any) => {
          const all = req.messages.map((message: any) => extractMessageContentText(message.content)).join('\n');
          const nonces = [...all.matchAll(/CT_REVIEW_NONCE:([a-f0-9-]+)/gu)];
          const nonce = nonces.length > 0 ? nonces[nonces.length - 1][1] : 'n';
          const body = all.includes('WORK TURN')
            ? { nonce, task: 't1', status: 'COMPLETE', findings: [] }
            : { nonce, tasks: [{ id: 't1', dimension: 'architecture', paths: ['src/app.ts', 'src/other.ts'], question: 'q', rationale: 'r' }] };
          return { model: 'm', content: JSON.stringify(body), usage: { prompt: 1, completion: 1, total: 2 }, costUSD: 0, raw: {} };
        }),
      };
      return executeComposedReview({
        config: COMPOSED_CONFIG(),
        changedFiles: files(modified('src/app.ts', [WS_HUNK, REAL_HUNK]) + modified('src/other.ts', [WS_HUNK])),
        repository: 'acme/app',
        headSha: 'e'.repeat(40),
        client: client as never,
        ...(diffShrink ? { diffShrink } : {}),
      });
    };
    const shrunk = await run(ON);
    expect(shrunk.diffShrink).toMatchObject({ whitespaceOnlyFiles: ['src/other.ts'] });
    expect((await run()).diffShrink).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Worker wiring: flag -> engines, and the published check summary
// ---------------------------------------------------------------------------

describe('publishing worker wiring', () => {
  const HEAD = 'a'.repeat(40);
  const BASE = 'b'.repeat(40);
  const WORKER_DIFF = modified('src/app.ts', [REAL_HUNK]) + modified('src/whitespace.ts', [WS_HUNK])
    + modified('src/api.gen.ts', [REAL_HUNK]);

  function workerEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      NODE_ENV: 'test',
      REVIEW_PUBLICATION_MODE: 'app-gate',
      REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
      REVIEW_REPO: 'calltelemetry/ct-meta',
      REVIEW_REPOSITORY_ID: '1339040553',
      REVIEW_POLICY_DIGEST: 'c'.repeat(64),
      REVIEW_CONFIG_DIGEST: 'd'.repeat(64),
      REVIEW_EXECUTION_ATTEMPT: '1',
      REVIEW_PR_NUMBER: '2795',
      REVIEW_HEAD_SHA: HEAD,
      REVIEW_BASE_SHA: BASE,
      REVIEW_MODEL: 'ollama/glm-5.3-flash',
      OPENAI_BASE_URL: 'https://gateway.example.invalid/v1',
      OPENAI_API_KEY: 'vk-test',
      GH_TOKEN: 'ghs_test',
      ...overrides,
    };
  }

  async function runWorker(env: NodeJS.ProcessEnv, options: { engineShrinks?: boolean } = {}) {
    // Stands in for an engine: it shrinks with the input it was given and attaches that disclosure.
    const panelRunner = vi.fn(async (runOptions: any) => attachDiffShrinkDisclosure({
      headSha: HEAD,
      applicablePersonaIds: ['sec-lane'],
      personas: [{ id: 'sec-lane', providerId: 'bifrost', model: 'm', decision: 'APPROVE', findings: [] }],
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      moderator: { providerId: 'bifrost', model: 'none', decision: 'RECONCILED', findings: [], usage: null, costUSD: null, durationMs: 0 },
      arbiter: { providerId: 'bifrost', model: 'none', verdict: 'SHIP', rationale: 'stub', usage: null, costUSD: null, durationMs: 0 },
    }, runOptions.diffShrink && options.engineShrinks !== false
      ? planDiffShrink(buildEffectiveReviewFiles(runOptions.changedFiles).files, runOptions.diffShrink).disclosure
      : null));
    const readFile = vi.fn(async () => '*.gen.ts linguist-generated\n');
    const checkClient = { createCheck: vi.fn(async () => 4242), completeCheck: vi.fn(async () => {}) };
    await runPublishingReviewWorker(env, {
      checkClient,
      sourceLoader: vi.fn(async () => ({ diff: WORKER_DIFF, githubReads: 1 })) as never,
      visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
      panelRunner: panelRunner as never,
      client: {} as never,
      repoFileProviderFactory: (() => ({
        readFile,
        findFiles: vi.fn(async () => ['.gitattributes']),
        treeTruncated: vi.fn(async () => false),
      })) as never,
    });
    const summary = JSON.stringify((checkClient.completeCheck.mock.calls as unknown[][]).map((call) => call[0]));
    return { panelOptions: (panelRunner.mock.calls as unknown[][])[0][0] as Record<string, unknown>, summary, readFile };
  }

  it('passes nothing to the engines and discloses nothing when the flag is off', async () => {
    const { panelOptions, summary, readFile } = await runWorker(workerEnv());
    expect(panelOptions).not.toHaveProperty('diffShrink');
    expect(summary).not.toContain('Diff shrinking');
    expect(readFile).not.toHaveBeenCalledWith('.gitattributes');
  });

  it('passes the shrink input to the engine and discloses every shrunk file in the check summary', async () => {
    const { panelOptions, summary } = await runWorker(workerEnv({ REVIEW_YETI_DIFF_SHRINK: 'calltelemetry/ct-meta' }));
    expect(panelOptions.diffShrink).toEqual({
      enabled: true, linguist: { status: 'applied', content: '*.gen.ts linguist-generated\n' },
    });
    expect(summary).toContain('Diff shrinking');
    expect(summary).toContain('Whitespace-only, content not sent (1): `src/whitespace.ts`');
    expect(summary).toContain('Excluded by .gitattributes, content not sent (1): `src/api.gen.ts` (linguist-generated)');
  });

  it('publishes only what the engine reports: no disclosure when the engine did not shrink', async () => {
    const { panelOptions, summary } = await runWorker(
      workerEnv({ REVIEW_YETI_DIFF_SHRINK: 'calltelemetry/ct-meta' }), { engineShrinks: false },
    );
    expect(panelOptions).toHaveProperty('diffShrink');
    expect(summary).not.toContain('Diff shrinking');
  });

  it('passes the shrink input to the non-gating shadow engine as well as the gating panel', async () => {
    const composedReviewRunner = vi.fn(async () => { throw new Error('shadow evidence only'); });
    const panelRunner = vi.fn(async () => ({
      headSha: HEAD,
      applicablePersonaIds: ['sec-lane'],
      personas: [{ id: 'sec-lane', providerId: 'bifrost', model: 'm', decision: 'APPROVE', findings: [] }],
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      moderator: { providerId: 'bifrost', model: 'none', decision: 'RECONCILED', findings: [], usage: null, costUSD: null, durationMs: 0 },
      arbiter: { providerId: 'bifrost', model: 'none', verdict: 'SHIP', rationale: 'stub', usage: null, costUSD: null, durationMs: 0 },
    }));
    await runPublishingReviewWorker(workerEnv({
      REVIEW_YETI_DIFF_SHRINK: 'calltelemetry/ct-meta',
      REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: { personas: 'security', review_engine: 'shadow' } }),
    }), {
      checkClient: { createCheck: vi.fn(async () => 4242), completeCheck: vi.fn(async () => {}) },
      sourceLoader: vi.fn(async () => ({ diff: WORKER_DIFF, githubReads: 1 })) as never,
      visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
      panelRunner: panelRunner as never,
      composedReviewRunner: composedReviewRunner as never,
      client: {} as never,
      repoFileProviderFactory: (() => ({
        readFile: vi.fn(async () => null), findFiles: vi.fn(async () => []), treeTruncated: vi.fn(async () => false),
      })) as never,
    });
    const expected = { enabled: true, linguist: { status: 'none-declared' } };
    expect(panelRunner).toHaveBeenCalledTimes(1);
    expect(composedReviewRunner).toHaveBeenCalledTimes(1);
    expect((panelRunner.mock.calls as unknown[][])[0][0]).toMatchObject({ diffShrink: expected });
    expect((composedReviewRunner.mock.calls as unknown[][])[0][0]).toMatchObject({ diffShrink: expected });
  });

  it('stays off for a repository the per-repository flag does not name', async () => {
    const { panelOptions, summary } = await runWorker(workerEnv({ REVIEW_YETI_DIFF_SHRINK: 'review-yeti-ai/review-yeti-bot' }));
    expect(panelOptions).not.toHaveProperty('diffShrink');
    expect(summary).not.toContain('Diff shrinking');
  });
});
