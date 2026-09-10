import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const runtimeSource = readFileSync(path.join(root, 'src/k8s/reviewJobDispatcherRuntime.ts'), 'utf8');
const projectionSource = readFileSync(path.join(root, 'src/k8s/reviewJobProjection.ts'), 'utf8');
const helperSource = readFileSync(path.join(root, 'scripts/advance-review-worker.sh'), 'utf8');

// Execute current source bytes without importing the application/config graph.
// Only export modifiers and TypeScript types are removed; no resolver is copied.
function canonicalProgram(runtime: string, projection: string): string {
  const parse = (source: string) => ts.createSourceFile('source.ts', source, ts.ScriptTarget.ES2022, true);
  const runtimeAst = parse(runtime);
  const projectionAst = parse(projection);
  const functions = runtimeAst.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'reviewJobDispatcherConfigFromEnv');
  if (functions.length !== 1 || !functions[0].body) throw new Error('expected exactly one canonical function');
  const declaration = (source: ts.SourceFile, name: string) => {
    const matches = source.statements.filter((node): node is ts.VariableStatement =>
      ts.isVariableStatement(node) && node.declarationList.declarations.some((entry) =>
        ts.isIdentifier(entry.name) && entry.name.text === name));
    if (matches.length !== 1 || matches[0].declarationList.declarations.length !== 1
        || !(matches[0].declarationList.flags & ts.NodeFlags.Const)
        || !matches[0].declarationList.declarations[0].initializer) {
      throw new Error(`expected exactly one static declaration: ${name}`);
    }
    return matches[0].getText(source).replace(/^export\s+/u, '');
  };
  const selected = [
    ...['TRUSTED_WORKER_IMAGE_REPOSITORIES', 'DEFAULT_GENERIC_RUNNER_IMAGE', 'GENERIC_RUNNER_IMAGE_PATTERN']
      .map((name) => declaration(projectionAst, name)),
    ...['workerImagePattern', 'hostnamePattern'].map((name) => declaration(runtimeAst, name)),
    functions[0].getText(runtimeAst).replace(/^export\s+/u, ''),
  ].join('\n');
  const { outputText, diagnostics } = ts.transpileModule(selected, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true,
  });
  if (diagnostics?.length) throw new Error('canonical source transpilation failed');

  return outputText;
}

function probeProgram(source: string): string {
  const matches = [...source.matchAll(/k exec "\$pod" --container "\$container" -- node -e '([^']*)' \| json/gu)];
  if (matches.length !== 1) throw new Error('expected exactly one actual attestation probe');
  return matches[0][1];
}

const canonicalCode = canonicalProgram(runtimeSource, projectionSource);
const probeCode = probeProgram(helperSource);
const vmOptions = { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } };
const fixedEnvironment = {
  REVIEW_JOB_DISPATCH_ENABLED: 'true', REVIEW_JOB_NAMESPACE: 'ct-review-system', HOSTNAME: 'dispatcher-fixture',
  REVIEW_JOB_WORKER_IMAGE: `ghcr.io/review-yeti-ai/review-yeti-worker@sha256:${'a'.repeat(64)}`,
};

describe('source-extracted worker mode parity', () => {
  it.each([
    ['absent default', undefined, undefined, 'prebaked'],
    ['empty default', '', '', 'prebaked'],
    ['whitespace default', ' \t', '\n ', 'prebaked'],
    ['trim primary', ' \tprebaked\n', undefined, 'prebaked'],
    ['explicit generic', 'generic', undefined, 'generic'],
    ['trim generic', '\tgeneric ', undefined, 'generic'],
    ['fallback only', undefined, ' generic ', 'generic'],
    ['blank primary fallback', '', 'generic', 'generic'],
    ['whitespace primary fallback', ' \n', ' prebaked ', 'prebaked'],
    ['primary prebaked wins', ' prebaked ', 'generic', 'prebaked'],
    ['primary generic wins', ' generic ', 'prebaked', 'generic'],
    ['valid primary beats unknown fallback', 'prebaked', 'future', 'prebaked'],
    ['unknown primary does not fall back', 'future', 'prebaked', 'future'],
    ['unknown fallback', '', ' future ', 'future'],
  ])('%s', (_name, primary, fallback, mode) => {
    const environment = { ...fixedEnvironment, REVIEW_JOB_RUNNER_MODE: primary, RUNNER_MODE: fallback };
    let stdout = '';
    runInNewContext(probeCode, { process: { env: { ...environment }, stdout: { write: (text: string) => { stdout += text; } } } }, vmOptions);
    const attestation = JSON.parse(stdout);
    const canonical = () => runInNewContext(`${canonicalCode}\nreviewJobDispatcherConfigFromEnv(fixture);`,
      { fixture: { ...environment } }, vmOptions);
    if (mode === 'future') {
      expect(canonical).toThrow('REVIEW_JOB_RUNNER_MODE must be prebaked or generic');
      expect(attestation.runnerMode).not.toBe('prebaked');
    } else {
      const config = canonical();
      expect(attestation.runnerMode).toBe(config.runnerMode);
      expect(attestation.workerImage).toBe(config.workerImage);
      if (mode === 'generic') expect(attestation.runnerMode).not.toBe('prebaked');
    }
    expect(attestation.runnerMode).toBe(mode);
  });

  it('fails instead of skipping missing or duplicate canonical declarations', () => {
    expect(() => canonicalProgram('', projectionSource)).toThrow('exactly one canonical function');
    expect(() => canonicalProgram(`${runtimeSource}\n${runtimeSource}`, projectionSource)).toThrow('exactly one canonical function');
    expect(() => canonicalProgram(runtimeSource, '')).toThrow('exactly one static declaration');
    expect(() => canonicalProgram(runtimeSource, `${projectionSource}\n${projectionSource}`)).toThrow('exactly one static declaration');
  });

  it('fails on an unresolved source dependency in the fixture-only VM', () => {
    const drifted = runtimeSource.replace('const runnerModeRaw =', 'const runnerModeRaw = externalResolver() ||');
    expect(drifted).not.toBe(runtimeSource);
    const program = canonicalProgram(drifted, projectionSource);
    expect(() => runInNewContext(`${program}\nreviewJobDispatcherConfigFromEnv(fixture);`,
      { fixture: { ...fixedEnvironment } }, vmOptions)).toThrow('externalResolver is not defined');
  });

  it('fails instead of skipping missing or duplicate actual probe snippets', () => {
    expect(() => probeProgram('')).toThrow('exactly one actual attestation probe');
    expect(() => probeProgram(`${helperSource}\n${helperSource}`)).toThrow('exactly one actual attestation probe');
  });
});

describe('guarded runtime upgrade shell contract', () => {
  it('proves worker-key CAS, guarded restart and recovery with fake external binaries', () => {
    const output = execFileSync('bash', ['scripts/advance-review-worker.test.sh'], {
      cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 120_000,
    });
    expect(output).toMatch(/advance-review-worker focused tests: [1-9]\d* passed/);
  }, 125_000);

  it('proves image-only updates, provenance and receipt-bound recovery without cluster access', () => {
    const root = path.resolve(__dirname, '../..');
    const output = execFileSync('bash', ['scripts/advance-review-runtime.test.sh'], {
      cwd: root, encoding: 'utf8', timeout: 60_000,
    });
    expect(output).toContain('advance-review-runtime focused tests: PASS');
    const provenance = execFileSync('bash', ['scripts/review-runtime-image-provenance.test.sh'], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
    });
    expect(provenance).toMatch(/^PASS: [1-9]\d* provenance checks \(fake crane only\)$/m);
  }, 65_000);
});
