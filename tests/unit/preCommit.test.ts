import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  scanDiffForCredentials,
  scanChangedFilesForCredentials,
  formatVerdict,
  evaluateExitCode,
  parseUnifiedDiff,
  runPreCommit,
  installGitHook,
  evaluateWithFlashModel,
  findGitRoot,
  SECRET_PATTERNS,
  PreCommitFinding,
} from '../../src/cli/preCommit';
import { runCli } from '../../src/cli/index';
import { filterDiffHunks, ChangedFile } from '../../src/pipeline/hunkFilter';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';

describe('Milestone 3: Local Pre-Commit CLI & Git Hook (R3)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeti-precommit-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Feature 11: Static Pre-Flight Security Scanner (< 10ms)
  // =========================================================================
  describe('Feature 11: Static Pre-Flight Security Scanner', () => {
    it('detects AWS access keys, GitHub tokens, and RSA private keys in < 10ms', () => {
      const diffWithSecrets = `
diff --git a/src/auth.ts b/src/auth.ts
index 0000000..1111111 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,6 @@
 export function setup() {
+  const awsKey = "AKIAIOSFODNN7EXAMPLE";
+  const ghToken = "ghp_123456789012345678901234567890123456";
+  const pem = "-----BEGIN RSA PRIVATE KEY-----";
   return true;
 }
`;

      const start = performance.now();
      const findings = scanDiffForCredentials(diffWithSecrets, 'src/auth.ts');
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(10); // Sub-10ms requirement
      expect(findings.length).toBe(3);
      expect(findings.map((f) => f.rule)).toEqual(['AWS Access Key', 'GitHub Token', 'RSA Private Key']);
      expect(findings.every((f) => f.severity === 'P0')).toBe(true);
      expect(findings[0].lineNumber).toBe(2);
      expect(findings[1].lineNumber).toBe(3);
      expect(findings[2].lineNumber).toBe(4);
    });

    it('rejects false positives: dummy all-zeros mock keys, regex templates, and short tokens', () => {
      const safeDiff = `
diff --git a/src/mock.ts b/src/mock.ts
--- a/src/mock.ts
+++ b/src/mock.ts
@@ -1,3 +1,4 @@
+const dummyKey = "AKIA0000000000000000"; // All zeros test mock
+const template = "AKIA[0-9A-Z]{16}"; // Regex string in documentation
+const notAToken = "ghp_short"; // Too short
`;

      const findings = scanDiffForCredentials(safeDiff, 'src/mock.ts');
      expect(findings.length).toBe(0);
    });

    it('detects new fine-grained GitHub PATs and Slack tokens', () => {
      const sampleSlackToken = ['xoxb', '123456789012', '123456789012', 'abcdefghijklmnopqrstuvwx'].join('-');
      const diffWithMoreSecrets = `
+ const fineGrained = "github_pat_11AAAAAAA0000000000000000000000000000000000000000000000000000000000000000000000000";
+ const slackToken = "${sampleSlackToken}";
+ const openAiKey = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
`;

      const findings = scanDiffForCredentials(diffWithMoreSecrets, 'src/secrets.ts');
      expect(findings.length).toBe(3);
      expect(findings.map((f) => f.rule)).toContain('GitHub Token');
      expect(findings.map((f) => f.rule)).toContain('Slack Token');
      expect(findings.map((f) => f.rule)).toContain('OpenAI API Key');
    });

    it('does NOT flag secrets in deleted lines (removing a secret is safe)', () => {
      const diffRemovingSecret = `
diff --git a/src/keys.ts b/src/keys.ts
--- a/src/keys.ts
+++ b/src/keys.ts
@@ -1,2 +1,2 @@
-const leakedKey = "AKIAIOSFODNN7EXAMPLE";
+const leakedKey = process.env.AWS_KEY;
`;

      const findings = scanDiffForCredentials(diffRemovingSecret, 'src/keys.ts');
      expect(findings.length).toBe(0);
    });

    it('scans multiple changed files efficiently', () => {
      const files: ChangedFile[] = [
        { path: 'src/clean.ts', patch: '@@ -1,2 +1,2 @@\n+const x = 1;' },
        { path: 'src/secret.ts', patch: '@@ -1,2 +1,2 @@\n+const token = "ghp_123456789012345678901234567890123456";' },
      ];

      const findings = scanChangedFilesForCredentials(files);
      expect(findings.length).toBe(1);
      expect(findings[0].filePath).toBe('src/secret.ts');
      expect(findings[0].rule).toBe('GitHub Token');
    });
  });

  // =========================================================================
  // Feature 10: Staged Diff Evaluation & Lockfile/Artifact Filtering
  // =========================================================================
  describe('Feature 10: Staged Diff Evaluation & Filtering', () => {
    it('parses unified diff text into structured ChangedFile array', () => {
      const diffText = `
diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 export function start() {
+  console.log("started");
 }
diff --git a/src/utils.ts b/src/utils.ts
index 3333333..4444444 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -10,3 +10,4 @@
+export const PI = 3.14;
`;

      const files = parseUnifiedDiff(diffText);
      expect(files.length).toBe(2);
      expect(files[0].path).toBe('src/app.ts');
      expect(files[0].patch).toContain('+  console.log("started");');
      expect(files[1].path).toBe('src/utils.ts');
      expect(files[1].patch).toContain('+export const PI = 3.14;');
    });

    it('returns empty array when diff text is empty or whitespace', () => {
      expect(parseUnifiedDiff('')).toEqual([]);
      expect(parseUnifiedDiff('   \n\n  ')).toEqual([]);
    });

    it('filters lockfiles and generated build artifacts before evaluation', () => {
      const stagedFiles: ChangedFile[] = [
        { path: 'package-lock.json', patch: '+ "version": "1.2.3"' },
        { path: 'yarn.lock', patch: '+ dependency@^1.0.0:' },
        { path: 'pnpm-lock.yaml', patch: '+ lockfileVersion: 5.4' },
        { path: 'dist/index.js', patch: '+ function bundle() {}' },
        { path: 'src/app.min.js', patch: '+ var a=1;' },
        { path: 'src/realCode.ts', patch: '+ export const valid = true;' },
      ];

      const filtered = filterDiffHunks(stagedFiles);
      expect(filtered.stats.totalFiles).toBe(6);
      expect(filtered.stats.ignoredFilesCount).toBe(5);
      const included = filtered.files.filter((f) => f.status === 'included');
      expect(included.length).toBe(1);
      expect(included[0].path).toBe('src/realCode.ts');
    });

    it('runPreCommit exits cleanly with code 0 when staged diff is empty', async () => {
      const result = await runPreCommit({
        diff: '',
        quiet: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.clean).toBe(true);
      expect(result.findings.length).toBe(0);
      expect(result.scannedFilesCount).toBe(0);
    });

    it('runPreCommit exits cleanly with code 0 when diff only contains lockfiles', async () => {
      const lockfileDiff = `
diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
-"version": "1.0.0"
+"version": "1.0.1"
`;

      const result = await runPreCommit({
        diff: lockfileDiff,
        quiet: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.clean).toBe(true);
      expect(result.ignoredFilesCount).toBe(1);
      expect(result.scannedFilesCount).toBe(0);
    });
  });

  // =========================================================================
  // Feature 12: Terminal ANSI Formatting & Exit Codes
  // =========================================================================
  describe('Feature 12: Terminal Formatting & Exit Code Enforcement', () => {
    it('formats color-coded verdicts: bold red P0, bold yellow P1, cyan P2', () => {
      const p0 = formatVerdict('P0', 'Critical vulnerability', true);
      expect(p0).toContain('\x1b[1;31m[P0]\x1b[0m');
      expect(p0).toContain('Critical vulnerability');

      const p1 = formatVerdict('P1', 'High risk warning', true);
      expect(p1).toContain('\x1b[1;33m[P1]\x1b[0m');
      expect(p1).toContain('High risk warning');

      const p2 = formatVerdict('P2', 'Cosmetic nit', true);
      expect(p2).toContain('\x1b[36m[P2]\x1b[0m');
      expect(p2).toContain('Cosmetic nit');
    });

    it('respects useColor=false and suppresses ANSI escape codes', () => {
      const p0Unstyled = formatVerdict('P0', 'Critical vulnerability', false);
      expect(p0Unstyled).toBe('[P0] Critical vulnerability');
      expect(p0Unstyled).not.toContain('\x1b');

      const p1Unstyled = formatVerdict('P1', 'Warning', false);
      expect(p1Unstyled).toBe('[P1] Warning');
      expect(p1Unstyled).not.toContain('\x1b');
    });

    it('enforces non-zero exit code (1) when blocking P0 findings exist', () => {
      expect(evaluateExitCode([{ severity: 'P0' }])).toBe(1);
      expect(evaluateExitCode([{ severity: 'P0' }, { severity: 'P2' }])).toBe(1);
    });

    it('allows P1 warnings with exit code 0 by default, but blocks with code 1 in --strict mode', () => {
      expect(evaluateExitCode([{ severity: 'P1' }], false)).toBe(0);
      expect(evaluateExitCode([{ severity: 'P1' }], true)).toBe(1);
      expect(evaluateExitCode([{ severity: 'P2' }], true)).toBe(0);
      expect(evaluateExitCode([])).toBe(0);
    });

    it('runPreCommit outputs JSON when json=true', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await runPreCommit({
        diff: `
diff --git a/src/secret.ts b/src/secret.ts
--- a/src/secret.ts
+++ b/src/secret.ts
@@ -1,2 +1,2 @@
+const key = "AKIA1111111111111111";
`,
        json: true,
      });

      expect(result.exitCode).toBe(1);
      expect(result.findings.length).toBe(1);
      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      expect(parsed.exitCode).toBe(1);
      expect(parsed.findings[0].rule).toBe('AWS Access Key');
    });
  });

  // =========================================================================
  // Feature 11 (cont): Fast Flash Model Evaluation
  // =========================================================================
  describe('Feature 11 (cont): Flash Model Evaluation', () => {
    it('queries flash model and attaches structured findings', async () => {
      const mockModelClient: ReviewModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify([
            {
              severity: 'P1',
              rule: 'SQL Injection',
              filePath: 'src/db.ts',
              lineNumber: 10,
              message: 'Raw query interpolation detected',
              suggestion: 'Use query parameterization',
            },
          ]),
          raw: {},
        }),
      };

      const files: ChangedFile[] = [
        { path: 'src/db.ts', patch: '@@ -10,1 +10,1 @@\n+db.query("SELECT * FROM users WHERE id = " + id);' },
      ];

      const findings = await evaluateWithFlashModel(files, 'gemini-flash', mockModelClient);
      expect(findings.length).toBe(1);
      expect(findings[0].rule).toBe('SQL Injection');
      expect(findings[0].severity).toBe('P1');
      expect(findings[0].lineNumber).toBe(10);
    });

    it('falls back gracefully when flash model throws or times out', async () => {
      const mockModelClient: ReviewModelClient = {
        complete: vi.fn().mockRejectedValue(new Error('Gateway timeout')),
      };

      const files: ChangedFile[] = [
        { path: 'src/db.ts', patch: '@@ -10,1 +10,1 @@\n+const a = 1;' },
      ];

      const findings = await evaluateWithFlashModel(files, 'gemini-flash', mockModelClient);
      expect(findings).toEqual([]);
    });
  });

  // =========================================================================
  // Feature 13: Pre-Commit Git Hook Installer
  // =========================================================================
  describe('Feature 13: Pre-Commit Git Hook Installer', () => {
    it('installs git hook into .git/hooks/pre-commit with executable permissions (0o755)', () => {
      const gitHooksDir = path.join(tempDir, '.git', 'hooks');
      fs.mkdirSync(gitHooksDir, { recursive: true });

      const result = installGitHook({ repoRoot: tempDir });
      expect(result.success).toBe(true);
      expect(result.hookPath).toBe(path.join(gitHooksDir, 'pre-commit'));
      expect(fs.existsSync(result.hookPath)).toBe(true);

      const content = fs.readFileSync(result.hookPath, 'utf-8');
      expect(content).toContain('#!/bin/sh');
      expect(content).toContain('review-yeti pre-commit');

      // Verify executable permissions
      const stat = fs.statSync(result.hookPath);
      const isExecutable = (stat.mode & 0o111) !== 0;
      expect(isExecutable).toBe(true);
    });

    it('installs git hook into .husky/pre-commit when husky option is enabled', () => {
      const result = installGitHook({ repoRoot: tempDir, husky: true });
      expect(result.success).toBe(true);
      expect(result.hookPath).toBe(path.join(tempDir, '.husky', 'pre-commit'));
      expect(fs.existsSync(result.hookPath)).toBe(true);

      const content = fs.readFileSync(result.hookPath, 'utf-8');
      expect(content).toContain('review-yeti pre-commit');
    });

    it('creates missing directories recursively and sets permissions safely', () => {
      const nestedHookPath = path.join(tempDir, 'custom', 'hooks', 'pre-commit');
      const result = installGitHook({ hookPath: nestedHookPath });

      expect(result.success).toBe(true);
      expect(fs.existsSync(nestedHookPath)).toBe(true);
      const stat = fs.statSync(nestedHookPath);
      expect((stat.mode & 0o755)).toBe(0o755);
    });
  });

  // =========================================================================
  // Feature 9: CLI Entrypoint & Argument Dispatcher
  // =========================================================================
  describe('Feature 9: CLI Entrypoint & Argument Dispatcher', () => {
    it('prints help and returns 0 for --help / -h / help / no args', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const exit0 = await runCli(['--help']);
      expect(exit0).toBe(0);

      const exit1 = await runCli(['-h']);
      expect(exit1).toBe(0);

      const exit2 = await runCli([]);
      expect(exit2).toBe(0);

      expect(consoleSpy).toHaveBeenCalled();
    });

    it('prints version and returns 0 for --version / -v', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const code = await runCli(['--version']);
      expect(code).toBe(0);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('review-yeti v1.28.6'));
    });

    it('executes pre-commit via CLI with --diff flag and returns 1 on blocking secrets', async () => {
      const secretDiffFile = path.join(tempDir, 'leak.diff');
      fs.writeFileSync(
        secretDiffFile,
        `
diff --git a/src/secret.ts b/src/secret.ts
--- a/src/secret.ts
+++ b/src/secret.ts
@@ -1,2 +1,2 @@
+const key = "AKIA1111111111111111";
`
      );

      const code = await runCli(['pre-commit', '--diff', secretDiffFile, '--quiet']);
      expect(code).toBe(1);
    });

    it('executes pre-commit via CLI with clean diff and returns 0', async () => {
      const cleanDiffFile = path.join(tempDir, 'clean.diff');
      fs.writeFileSync(
        cleanDiffFile,
        `
diff --git a/src/clean.ts b/src/clean.ts
--- a/src/clean.ts
+++ b/src/clean.ts
@@ -1,2 +1,2 @@
+const key = process.env.API_KEY;
`
      );

      const code = await runCli(['pre-commit', '--diff', cleanDiffFile, '--quiet']);
      expect(code).toBe(0);
    });

    it('executes install-hook via CLI and returns 0', async () => {
      const code = await runCli(['install-hook', '--dir', tempDir]);
      expect(code).toBe(0);
      expect(fs.existsSync(path.join(tempDir, '.git', 'hooks', 'pre-commit'))).toBe(true);
    });

    it('handles unknown command with error message and return code 1', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const code = await runCli(['unknown-command']);
      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith('Unknown command: unknown-command');
    });
  });
});
