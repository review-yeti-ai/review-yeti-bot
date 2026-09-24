#!/usr/bin/env node
/**
 * REL-1074. Decide which Vitest files a CI run must execute.
 *
 * Pull requests run only the tests whose inputs changed since the PR's merge base. Everything
 * else (push to main, schedule, manual dispatch) runs the full suite. The selection is built to
 * over-select, never under-select, and every uncertainty resolves to the full suite:
 *
 *   1. `git diff --name-status -M <base> <head>` lists the changed files (both sides of a rename).
 *      A git failure, or a missing base, is a full run.
 *   2. Any change to a global input is a full run: package manifests and lockfiles, Vitest/Vite
 *      config, tsconfig*, test setup/globalSetup files and everything they import, workflows,
 *      the pretest artifact scripts, env files, schemas/, and this selector itself.
 *   3. Tests also depend on files the module graph cannot see: fixtures read with fs, source files
 *      read as text by contract tests, scripts spawned in a child process, and the CommonJS
 *      pipeline bundle that `require()`s `dist/`. A text-reference closure covers those: a file
 *      that names a changed file (basename, path, or the directory it lives in) is treated as
 *      changed too, repeated to a fixed point. A changed non-module file under tests/ that nothing
 *      names is a full run -- something reads it in a way this scan cannot see.
 *   4. The closure is handed to Vitest's own related-files filter (`config.related`, the exact
 *      code path behind `vitest run --changed`), which walks the Vite SSR module graph of every
 *      test file, so any test that transitively imports a changed module is selected.
 *   5. As a cross-check, the plain `vitest --changed <base>` selection must be a subset of ours;
 *      if it is not, the run is full.
 *
 * Output (JSON, --out): { mode: 'full' | 'subset' | 'none', reason, base, changed, tests, postgresTests,
 * reaperAcceptance }. `tests` excludes Postgres-backed files; those run in the Postgres job.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CODE_EXT = /\.(?:[cm]?[jt]sx?|sh)$/u;
/** The REL-817 harness `npm run test:acceptance:reaper` runs (pinned to that script by a unit test). */
export const REAPER_ACCEPTANCE = 'tests/integration/reaperMetricsAcceptance.postgres.test.ts';
/**
 * How a suite is recognised as Postgres-backed.
 *
 * This MUST NOT depend on a suite spelling the env var literally. It did, and the
 * marker was a landmine: REL-1069 consolidated thirteen suites onto a shared
 * `postgresDatabaseUrl()` helper, every file stopped matching, all thirteen were
 * routed back into the plain shards (which have no database), and the CI run went
 * red. A detector that a refactor can silently disable is worse than none -- it
 * fails by moving tests to the wrong job rather than by erroring here.
 *
 * A Postgres suite is now identified by EITHER the legacy literal OR the shared
 * helper, so consolidating onto the helper is safe and the next refactor cannot
 * quietly drop a suite out of its dedicated job.
 */
const POSTGRES_MARKERS = [
  /process\.env\.REVIEW_YETI_TEST_DATABASE_URL\b/u,
  /\bpostgresDatabaseUrl\s*\(/u,
  /\brequireDatabaseUrlInCi\s*\(/u,
];

/** Any change matching one of these runs the whole suite. */
export const FULL_SUITE_TRIGGERS = [
  [/^(?:.*\/)?package(?:-lock)?\.json$/u, 'package manifest or lockfile'],
  [/^(?:\.npmrc|\.nvmrc|\.node-version|\.tool-versions)$/u, 'node toolchain config'],
  [/^(?:vitest|vite)(?:\.[\w-]+)?\.config\.[cm]?[jt]s$/u, 'vitest/vite config'],
  [/^tsconfig(?:\.[\w-]+)?\.json$/u, 'tsconfig'],
  [/^tests\/(?:setup|globalSetup)\.tsx?$/u, 'test setup file'],
  [/^\.github\/workflows\//u, 'workflow or workflow-bundled pipeline'],
  [/^\.github\/actions\//u, 'composite action'],
  [/^scripts\/ensure-(?:pipeline-build|static-assets)\.js$/u, 'pretest artifact script'],
  [/^scripts\/build-domain-index\.ts$/u, 'pretest domain index check'],
  [/^scripts\/ci\//u, 'CI test selector'],
  [/^schemas\//u, 'schema file'],
  [/(?:^|\/)\.env(?:\..*)?$/u, 'env file'],
  [/^next\.config\.js$|^postcss\.config\.js$|^tailwind\.config\.js$/u, 'build config'],
];

/** Top-level trees whose code does not run inside Vite, so their imports are only visible as text. */
const OUT_OF_GRAPH_CODE = /^(?:scripts|bin|tools|pi-runtime|legacy-runtime|\.github)\//u;

function parseArgs(argv) {
  const args = { base: '', head: 'HEAD', out: '', full: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--base') { args.base = value; i += 1; }
    else if (key === '--head') { args.head = value; i += 1; }
    else if (key === '--out') { args.out = value; i += 1; }
    else if (key === '--full') { args.full = value; i += 1; }
    else throw new Error(`unknown argument ${key}`);
  }
  return args;
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Parse `git diff --name-status -z` output; a rename or copy contributes both of its paths. */
export function parseNameStatus(output) {
  const fields = output.split('\0').filter(Boolean);
  const files = new Set();
  for (let i = 0; i < fields.length;) {
    const status = fields[i];
    if (!/^[ACDMRTUXB]\d*$/u.test(status)) throw new Error(`unexpected name-status field '${status}'`);
    if (/^[RC]/u.test(status)) {
      if (i + 2 >= fields.length) throw new Error(`truncated ${status} entry`);
      files.add(fields[i + 1]);
      files.add(fields[i + 2]);
      i += 3;
    } else {
      if (i + 1 >= fields.length) throw new Error(`truncated ${status} entry`);
      files.add(fields[i + 1]);
      i += 2;
    }
  }
  return [...files].sort();
}

export function changedFiles(base, head) {
  if (!/^[0-9a-f]{40}$/u.test(base)) throw new Error(`base must be a full commit SHA, got '${base}'`);
  git(['cat-file', '-e', `${base}^{commit}`]);
  return parseNameStatus(git(['diff', '--name-status', '-M', '-z', base, head]));
}

export function fullSuiteTrigger(file) {
  for (const [pattern, reason] of FULL_SUITE_TRIGGERS) {
    if (pattern.test(file)) return reason;
  }
  return null;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Patterns that mean "this file refers to `target` by name". Deliberately generous: a false match
 * costs a few extra tests, a missed one ships a regression.
 *
 *   byName       the file itself: readFileSync('.../ci-cd.yaml'), execFile('node', ['scripts/x.mjs'])
 *   bySpecifier  a module specifier: '../src/pipeline/diffCompactor', './lib/x.mjs' -- only
 *                meaningful in code Vite does not load (spawned scripts, CommonJS `require()`),
 *                because Vite's own graph already covers every import it executes
 *   byDirectory  the containing directory as a path in its own right (a readdir or glob root):
 *                'tests/fixtures/cassettes', `${root}/k8s/${name}`, path.join('tests', 'fixtures'),
 *                or any ancestor as the root of a recursive walk: walk(path.join(root, 'src'))
 */
export function referencePatterns(target, childDirs = new Map()) {
  const base = path.posix.basename(target);
  const dir = path.posix.dirname(target);
  const isCode = CODE_EXT.test(target);
  const Q = `['"\`]`;
  const patterns = { byName: [], bySpecifier: [], byDirectory: [] };

  patterns.byName.push(new RegExp(`(?<![\\w.-])${escapeRegExp(base)}(?![\\w-])`, 'u'));
  if (isCode) {
    const stem = base.replace(/\.[^.]+$/u, '');
    patterns.bySpecifier.push(new RegExp(`/${escapeRegExp(stem)}(?:\\.[cm]?[jt]sx?)?${Q}`, 'u'));
  }

  if (dir !== '.') {
    const segments = dir.split('/');
    // path.join(root, 'src', 'pipeline') names src/pipeline, not src: a literal subdirectory
    // right after the directory narrows the reference away from this file.
    const children = [...(childDirs.get(dir) ?? [])];
    const narrowed = children.length
      ? `(?!\\s*,\\s*${Q}(?:${children.map(escapeRegExp).join('|')})${Q})`
      : '';
    for (let start = 0; start < segments.length; start += 1) {
      const suffix = segments.slice(start);
      // A lone nested segment ('review' of src/review) is too generic to mean anything for code;
      // for data files it is how readdir roots are usually spelled: path.join(dir, 'cassettes').
      if (suffix.length === 1 && isCode && start !== 0) continue;
      const lead = start === 0 ? `(?<![\\w-])` : `[/'"\`]`;
      const slashForm = escapeRegExp(suffix.join('/'));
      patterns.byDirectory.push(new RegExp(`${lead}${slashForm}(?:/?${Q}${narrowed}|/\\*|/\\$\\{)`, 'u'));
      if (suffix.length > 1) {
        const joinForm = suffix.map((s) => `${Q}${escapeRegExp(s)}${Q}`).join('\\s*,\\s*');
        patterns.byDirectory.push(new RegExp(`${joinForm}${narrowed}`, 'u'));
      }
    }
    // Every ancestor as the root of a recursive walk: walk(path.join(root, 'src')), 'src/**'.
    // Only a complete path counts; one followed by another literal segment names somewhere else.
    for (let depth = 1; depth < segments.length; depth += 1) {
      const ancestor = segments.slice(0, depth);
      const slashForm = escapeRegExp(ancestor.join('/'));
      patterns.byDirectory.push(new RegExp(`(?<![\\w-])${slashForm}(?:/?${Q}(?!\\s*,\\s*${Q})|/\\*\\*)`, 'u'));
      if (ancestor.length > 1) {
        const joinForm = ancestor.map((s) => `${Q}${escapeRegExp(s)}${Q}`).join('\\s*,\\s*');
        patterns.byDirectory.push(new RegExp(`${joinForm}(?!\\s*,\\s*${Q})`, 'u'));
      }
    }
  }
  return patterns;
}

const isTestSide = (file) => file.startsWith('tests/') || /\.test\.[cm]?[jt]sx?$/u.test(file);

/**
 * Fixed-point closure over "file A names file B" edges, starting from the changed files.
 *
 * Directory references to *code* only count from test-side files and out-of-graph code: a test or
 * script that walks src/ really does read every file there, but application code that carries a
 * glob such as 'src/**' as review-routing data does not.
 */
export function textReferenceClosure(changed, corpus, childDirs = new Map()) {
  const reached = new Set(changed);
  const referrersOf = new Map();
  const queue = [...changed];
  while (queue.length) {
    const target = queue.shift();
    const { byName, bySpecifier, byDirectory } = referencePatterns(target, childDirs);
    const targetIsCode = CODE_EXT.test(target);
    const found = [];
    for (const [file, text] of corpus) {
      if (file === target) continue;
      const outOfGraph = OUT_OF_GRAPH_CODE.test(file) || (/\.c?js$/u.test(file) && /\brequire\(/u.test(text));
      const hit = byName.some((re) => re.test(text))
        || (outOfGraph && bySpecifier.some((re) => re.test(text)))
        || ((!targetIsCode || outOfGraph || isTestSide(file)) && byDirectory.some((re) => re.test(text)));
      if (!hit) continue;
      found.push(file);
      if (!reached.has(file)) { reached.add(file); queue.push(file); }
    }
    referrersOf.set(target, found);
  }
  return { reached, referrersOf };
}

/**
 * Reduce a source file to its string literals, at their original offsets, keeping the commas and
 * brackets between them so path.join('src', 'pipeline') adjacency survives. Comments, identifiers
 * and prose vanish, so a comment that says "see vitest.config.ts" is not a runtime reference.
 * Shell scripts keep everything but comment lines.
 */
export function literalText(file, text, ts) {
  if (file.endsWith('.sh')) return text.replace(/^\s*#.*$/gmu, '');
  const kind = /\.tsx$/u.test(file) ? ts.ScriptKind.TSX
    : /\.jsx$/u.test(file) ? ts.ScriptKind.JSX
      : /\.[cm]?js$/u.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const out = text.replace(/[^\n,()[\]]/gu, ' ').split('');
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node)
      || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      for (let i = node.getStart(source); i < node.end; i += 1) out[i] = text[i];
    }
    node.forEachChild(visit);
  };
  visit(source);
  return out.join('');
}

/** Map each tracked directory to the names of its tracked subdirectories. */
export function trackedChildDirs() {
  const children = new Map();
  for (const file of git(['ls-files', '-z']).split('\0').filter(Boolean)) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length - 1; i += 1) {
      const parent = parts.slice(0, i).join('/');
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent).add(parts[i]);
    }
  }
  return children;
}

/** Files that decide what runs rather than run themselves; naming a path there is not a dependency. */
const NOT_A_REFERRER = /^(?:(?:vitest|vite)(?:\.[\w-]+)?\.config\.[cm]?[jt]s|tests\/screenshots\.spec\.ts|next\.config\.js|postcss\.config\.js|tailwind\.config\.js)$/u;

export async function loadCorpus() {
  const ts = (await import('typescript')).default;
  const corpus = new Map();
  for (const file of git(['ls-files', '-z']).split('\0').filter(Boolean)) {
    if (!CODE_EXT.test(file) || file.startsWith('k8s-operator/') || NOT_A_REFERRER.test(file)) continue;
    const abs = path.join(repoRoot, file);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; /* deleted in this tree */ }
    corpus.set(file, literalText(file, text, ts));
  }
  return corpus;
}

async function withVitest(fn) {
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest('test', { watch: false, run: true, config: path.join(repoRoot, 'vitest.config.ts') }, {}, {});
  try { return await fn(vitest); } finally { await vitest.close(); }
}

const rel = (abs) => path.relative(repoRoot, abs).split(path.sep).join('/');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = {
    mode: 'full', reason: '', base: args.base || null, changed: [], tests: [], postgresTests: [], postgresExcludes: [], reaperAcceptance: true,
  };

  await withVitest(async (vitest) => {
    const allSpecs = await vitest.specifications.globTestSpecifications();
    const allTests = [...new Set(allSpecs.map((spec) => rel(spec.moduleId)))].sort();
    const isPostgres = (file) => {
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      return POSTGRES_MARKERS.some((marker) => marker.test(source));
    };
    const postgresAll = allTests.filter(isPostgres);
    plan.postgresExcludes = postgresAll;
    const finishFull = (reason) => {
      plan.mode = 'full';
      plan.reason = reason;
      plan.tests = allTests.filter((file) => !postgresAll.includes(file));
      plan.postgresTests = postgresAll;
      plan.reaperAcceptance = true;
    };

    if (args.full) return finishFull(args.full);
    if (!args.base) return finishFull('no merge base supplied');

    let changed;
    try { changed = changedFiles(args.base, args.head); } catch (error) {
      return finishFull(`change detection failed: ${error.message.split('\n')[0]}`);
    }
    plan.changed = changed;
    if (changed.length === 0) return finishFull('empty diff against merge base');

    for (const file of changed) {
      const trigger = fullSuiteTrigger(file);
      if (trigger) return finishFull(`${file}: ${trigger}`);
    }

    // Setup files run before every test file. Their own edits are full-suite triggers above; the
    // modules they import directly (stores they reset between tests) are too, because a change
    // there alters the harness every test runs in. Deeper imports are ordinary graph nodes: stock
    // `vitest --changed` ignores setup imports entirely, and any test that exercises those modules
    // imports them itself.
    const project = vitest.projects[0];
    const setupDeps = new Set();
    const setupFiles = new Set();
    for (const setup of [...project.config.setupFiles, ...(project.config.globalSetup ?? [])]) {
      const abs = path.resolve(repoRoot, setup);
      setupFiles.add(rel(abs));
      const transformed = await project.vite.environments.ssr.transformRequest(abs);
      for (const dep of [...(transformed?.deps ?? []), ...(transformed?.dynamicDeps ?? [])]) {
        const fsPath = dep.startsWith('/@fs/') ? dep.slice(4) : path.join(repoRoot, dep);
        if (!fsPath.includes('node_modules') && fs.existsSync(fsPath)) setupDeps.add(rel(fsPath));
      }
    }
    plan.setupImports = [...setupDeps].sort();

    const corpus = await loadCorpus();
    const { reached, referrersOf } = textReferenceClosure(changed, corpus, trackedChildDirs());
    // The setup files themselves are named by scripts they run (globalSetup runs the pipeline
    // build), which is not a change to the harness; their own edits are full triggers above.
    for (const file of reached) {
      if (setupDeps.has(file) && !setupFiles.has(file)) return finishFull(`${file} is imported directly by a test setup file`);
    }
    for (const file of changed) {
      const unseen = !CODE_EXT.test(file) && file.startsWith('tests/') && !(referrersOf.get(file) ?? []).length;
      if (unseen && fs.existsSync(path.join(repoRoot, file))) {
        return finishFull(`${file}: test data that no file names; cannot map it to tests`);
      }
    }

    const relatedAbs = [...reached].map((file) => path.join(repoRoot, file));
    vitest.config.related = relatedAbs;
    const selected = new Set((await vitest.specifications.getRelevantTestSpecifications()).map((s) => rel(s.moduleId)));

    // Cross-check against stock `vitest --changed <base>`: it must never select something we did not.
    vitest.config.related = changed.map((file) => path.join(repoRoot, file));
    const stock = (await vitest.specifications.getRelevantTestSpecifications()).map((s) => rel(s.moduleId));
    const missing = stock.filter((file) => !selected.has(file));
    if (missing.length) return finishFull(`selector missed ${missing.length} file(s) stock --changed selects: ${missing.slice(0, 3).join(', ')}`);
    vitest.config.related = undefined;
    plan.stockChangedSelection = stock.length;
    plan.textReached = [...reached].filter((file) => !changed.includes(file)).sort();

    if (selected.size >= allTests.length * 0.85) return finishFull(`change reaches ${selected.size}/${allTests.length} test files`);

    const sorted = [...selected].sort();
    plan.mode = sorted.length ? 'subset' : 'none';
    plan.reason = `${changed.length} changed file(s) reach ${sorted.length}/${allTests.length} test files`;
    plan.tests = sorted.filter((file) => !postgresAll.includes(file));
    plan.postgresTests = sorted.filter((file) => postgresAll.includes(file));
    // Fail closed: if the harness moved and this constant went stale, run it rather than skip it.
    plan.reaperAcceptance = selected.has(REAPER_ACCEPTANCE) || !allTests.includes(REAPER_ACCEPTANCE);
  });

  const json = JSON.stringify(plan, null, 2);
  if (args.out) fs.writeFileSync(args.out, `${json}\n`);
  process.stdout.write(`${JSON.stringify({
    ...plan,
    changed: plan.changed.length,
    tests: plan.tests.length,
    postgresTests: plan.postgresTests.length,
    setupImports: undefined,
    postgresExcludes: plan.postgresExcludes.length,
    textReached: plan.textReached?.length,
  })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // A selector crash must never shrink the suite: report it and let the caller run everything.
    console.error(`[select-vitest-tests] ${error?.stack || error}`);
    process.exit(1);
  });
}
