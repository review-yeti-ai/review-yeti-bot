import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
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

const REPO_ROOT = path.resolve(__dirname, '../..');
const BIN_PATH = path.join(REPO_ROOT, 'bin/review-yeti.js');

describe('Milestone 3 Empirical Challenger 1 Adversarial Suite', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeti-adv-m3-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Section 1: Boundary Conditions & Diff Parsing
  // =========================================================================
  describe('Section 1: Boundary Conditions & Diff Parsing', () => {
    it('1.1: Handles completely empty diff without error', async () => {
      expect(parseUnifiedDiff('')).toEqual([]);
      const result = await runPreCommit({ diff: '', quiet: true });
      expect(result.exitCode).toBe(0);
      expect(result.clean).toBe(true);
      expect(result.findings).toEqual([]);
      expect(result.scannedFilesCount).toBe(0);
    });

    it('1.2: Handles whitespace-only diffs cleanly', async () => {
      const whitespaceDiff = '   \r\n\t  \n\n     \n\t\t';
      expect(parseUnifiedDiff(whitespaceDiff)).toEqual([]);
      const result = await runPreCommit({ diff: whitespaceDiff, quiet: true });
      expect(result.exitCode).toBe(0);
      expect(result.clean).toBe(true);
      expect(result.findings).toEqual([]);
    });

    it('1.3: Handles binary file diff headers without false positive alerts', async () => {
      const binaryDiff = `
diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000..91a5e12
Binary files /dev/null and b/assets/logo.png differ
diff --git a/firmware/blob.bin b/firmware/blob.bin
index 1111111..2222222 100644
GIT binary patch
literal 100
zcmV-1000000000000000000000000000000000000000000000000000000000000
`;
      const parsed = parseUnifiedDiff(binaryDiff);
      expect(parsed.length).toBe(2);
      expect(parsed[0].path).toBe('assets/logo.png');
      expect(parsed[1].path).toBe('firmware/blob.bin');

      const findings = scanChangedFilesForCredentials(parsed);
      expect(findings).toEqual([]);

      const result = await runPreCommit({ diff: binaryDiff, quiet: true });
      expect(result.exitCode).toBe(0);
      expect(result.clean).toBe(true);
    });

    it('1.4: Accurately parses multiple hunks in a single file and tracks 1-indexed line numbers', () => {
      const multiHunkDiff = `
diff --git a/src/service.ts b/src/service.ts
--- a/src/service.ts
+++ b/src/service.ts
@@ -10,3 +10,4 @@
 function header() {
+  const normalVar = 100;
   return normalVar;
 }
@@ -45,3 +46,5 @@
 function leaked() {
+  const x = 1;
+  const leakedKey = "AKIA1111111111111111";
   return x;
 }
`;
      const findings = scanDiffForCredentials(multiHunkDiff, 'src/service.ts');
      expect(findings.length).toBe(1);
      expect(findings[0].rule).toBe('AWS Access Key');
      // In hunk 2, line 46 is +  const x = 1, line 47 is +  const leakedKey
      expect(findings[0].lineNumber).toBe(48);
    });

    it('1.5: Does not flag secrets when lines are deleted or context-only', () => {
      const diffWithDeletionAndContext = `
diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,5 +1,4 @@
  const AWS_KEY = "AKIA2222222222222222"; // Unchanged context line
- const OLD_PAT = "ghp_123456789012345678901234567890123456"; // Deleted line
+ const NEW_VAL = "safe_env_reference";
  return true;
`;
      const findings = scanDiffForCredentials(diffWithDeletionAndContext, 'src/config.ts');
      expect(findings.length).toBe(0);
    });

    it('1.6: Integrates with real git repository staging and git diff --cached', () => {
      const gitRepo = path.join(tempDir, 'real-repo');
      fs.mkdirSync(gitRepo, { recursive: true });

      const env = {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Review Yeti',
        GIT_AUTHOR_EMAIL: 'yeti@example.com',
        GIT_COMMITTER_NAME: 'Review Yeti',
        GIT_COMMITTER_EMAIL: 'yeti@example.com',
      };

      execSync('git init -b main', { cwd: gitRepo, env });

      // Initial clean commit
      fs.writeFileSync(path.join(gitRepo, 'app.ts'), 'export const app = 1;\n');
      execSync('git add app.ts', { cwd: gitRepo, env });
      execSync('git commit -m "initial commit"', { cwd: gitRepo, env });

      // Stage clean change
      fs.appendFileSync(path.join(gitRepo, 'app.ts'), 'export const port = 3000;\n');
      execSync('git add app.ts', { cwd: gitRepo, env });

      // Pre-commit scan on staged
      const cleanResult = execFileSync('node', [BIN_PATH, 'pre-commit'], {
        cwd: gitRepo,
        env,
        encoding: 'utf-8',
      });
      expect(cleanResult).toContain('Pre-commit checks passed');

      // Stage a credential leak
      fs.writeFileSync(path.join(gitRepo, 'secret.ts'), 'export const key = "AKIA9999999999999999";\n');
      execSync('git add secret.ts', { cwd: gitRepo, env });

      let exitCode = 0;
      let leakOutput = '';
      try {
        leakOutput = execFileSync('node', [BIN_PATH, 'pre-commit'], {
          cwd: gitRepo,
          env,
          encoding: 'utf-8',
        });
      } catch (err: any) {
        exitCode = err.status;
        leakOutput = err.stdout?.toString() || '';
      }

      expect(exitCode).toBe(1);
      expect(leakOutput).toContain('AWS Access Key');
      expect(leakOutput).toContain('Commit blocked: 1 blocking P0 issue(s) detected');
    });
  });

  // =========================================================================
  // Section 2: Massive Staged Diffs & Sub-10ms Performance Benchmark
  // =========================================================================
  describe('Section 2: Massive Staged Diffs & Performance (< 10ms)', () => {
    it('2.1: Scans 50+ changed files in sub-10ms with high throughput', () => {
      const files: ChangedFile[] = [];
      const fileCount = 60; // 60 files (exceeds 50+ requirement)

      for (let i = 0; i < fileCount; i++) {
        const lines: string[] = ['@@ -1,10 +1,15 @@'];
        for (let j = 0; j < 10; j++) {
          lines.push(`+ const variable_${i}_${j} = "some value string ${j}";`);
        }
        // Plant a secret in file #42
        if (i === 42) {
          lines.push('+ const token = "ghp_123456789012345678901234567890123456";');
        }
        files.push({
          path: `src/module_${i}/component_${i}.ts`,
          patch: lines.join('\n'),
        });
      }

      expect(files.length).toBe(60);

      const startTime = performance.now();
      const findings = scanChangedFilesForCredentials(files);
      const elapsedMs = performance.now() - startTime;

      expect(elapsedMs).toBeLessThan(10); // Static pre-flight sub-10ms requirement
      expect(findings.length).toBe(1);
      expect(findings[0].filePath).toBe('src/module_42/component_42.ts');
      expect(findings[0].rule).toBe('GitHub Token');
    });

    it('2.2: ReDoS stress test: resilient against long crafted non-matching input strings', () => {
      const attackPatterns = [
        // Long repetition of AKIA prefix without 16 characters
        '+ ' + 'AKIA!'.repeat(1000),
        // Long repetition of ghp_ prefix
        '+ ' + 'ghp_!'.repeat(1000),
        // Long repetition of github_pat_ prefix
        '+ ' + 'github_pat_!'.repeat(1000),
        // Slack token backtracking attempt
        '+ xoxb-' + '9'.repeat(5000) + '-fail',
        // OpenAI key backtracking attempt
        '+ sk-' + 'a!'.repeat(2500),
        // PEM key header attempt
        '+ ' + '-----BEGIN '.repeat(1000),
      ];

      for (const attackLine of attackPatterns) {
        const start = performance.now();
        const findings = scanDiffForCredentials(attackLine, 'src/attack.ts');
        const duration = performance.now() - start;

        // Must complete instantaneously without catastrophic regex backtracking (< 5ms)
        expect(duration).toBeLessThan(5);
        expect(findings.length).toBe(0);
      }
    });
  });

  // =========================================================================
  // Section 3: Secret Scanner False Positive Resistance
  // =========================================================================
  describe('Section 3: Secret Scanner False Positive Resistance', () => {
    it('3.1: Rejects dummy mock keys with all zeros (AKIA0000000000000000)', () => {
      const diff = '+ const mockAwsKey = "AKIA0000000000000000";';
      const findings = scanDiffForCredentials(diff, 'src/test.ts');
      expect(findings.length).toBe(0);
    });

    it('3.2: Rejects lowercase or non-conforming AWS-like prefixes', () => {
      const diff = `
+ const lowercaseKey = "akia1234567890123456";
+ const shortKey = "AKIA12345";
+ const invalidChars = "AKIA123456789012345!";
+ const envVarName = process.env.AWS_ACCESS_KEY_ID;
`;
      const findings = scanDiffForCredentials(diff, 'src/test.ts');
      expect(findings.length).toBe(0);
    });

    it('3.3: Correctly identifies authentic AWS access key format', () => {
      const diff = '+ const liveKey = "AKIAIOSFODNN7EXAMPLE";';
      const findings = scanDiffForCredentials(diff, 'src/test.ts');
      expect(findings.length).toBe(1);
      expect(findings[0].rule).toBe('AWS Access Key');
      expect(findings[0].match).toBe('AKIAIOSFODNN7EXAMPLE');
    });

    it('3.4: Rejects short GitHub tokens and validates PAT boundary lengths', () => {
      const diff = `
+ const shortGhp = "ghp_123456"; // only 6 chars
+ const shortPat = "github_pat_11AAAAAAA000000000000000000000000000000000000000000000000000000000000000000000000"; // 80 chars (needs 82)
`;
      const findings = scanDiffForCredentials(diff, 'src/test.ts');
      expect(findings.length).toBe(0);
    });

    it('3.5: Distinguishes between private keys (P0) and public keys/certificates (safe)', () => {
      const diffWithPublicMaterial = `
+ const pubKey = "-----BEGIN RSA PUBLIC KEY-----";
+ const genericPubKey = "-----BEGIN PUBLIC KEY-----";
+ const cert = "-----BEGIN CERTIFICATE-----";
+ const certReq = "-----BEGIN CERTIFICATE REQUEST-----";
`;
      const findings = scanDiffForCredentials(diffWithPublicMaterial, 'src/crypto.ts');
      expect(findings.length).toBe(0);

      const diffWithPrivateKey = '+ const privateKey = "-----BEGIN RSA PRIVATE KEY-----";';
      const privFindings = scanDiffForCredentials(diffWithPrivateKey, 'src/crypto.ts');
      expect(privFindings.length).toBe(1);
      expect(privFindings[0].rule).toBe('RSA Private Key');

      const diffWithOpenSsh = '+ const sshKey = "-----BEGIN OPENSSH PRIVATE KEY-----";';
      const sshFindings = scanDiffForCredentials(diffWithOpenSsh, 'src/ssh.ts');
      expect(sshFindings.length).toBe(1);
      expect(sshFindings[0].rule).toBe('Generic Private Key');
    });

    it('3.6: Validates Slack tokens and OpenAI key boundaries', () => {
      const diff = `
+ const invalidSlack = "xoxz-123456789012-123456789012-abcdef"; // invalid prefix xoxz
+ const shortOpenAi = "sk-tooshort123456"; // under 32 chars
`;
      const findings = scanDiffForCredentials(diff, 'src/test.ts');
      expect(findings.length).toBe(0);

      const sampleSlackToken = ['xoxb', '123456789012', '123456789012', 'abcdefghijklmnopqrstuvwx'].join('-');
      const validDiff = `
+ const validSlack = "${sampleSlackToken}";
+ const validOpenAi = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
`;
      const validFindings = scanDiffForCredentials(validDiff, 'src/test.ts');
      expect(validFindings.length).toBe(2);
    });
  });

  // =========================================================================
  // Section 4: ANSI Terminal Formatting & NO_COLOR Compliance
  // =========================================================================
  describe('Section 4: ANSI Formatting & NO_COLOR Compliance', () => {
    it('4.1: Formats verdicts with exact ANSI codes: P0 Bold Red, P1 Bold Yellow, P2 Cyan', () => {
      expect(formatVerdict('P0', 'Alert', true)).toBe('\x1b[1;31m[P0]\x1b[0m Alert');
      expect(formatVerdict('P1', 'Warning', true)).toBe('\x1b[1;33m[P1]\x1b[0m Warning');
      expect(formatVerdict('P2', 'Info', true)).toBe('\x1b[36m[P2]\x1b[0m Info');
    });

    it('4.2: Suppresses ANSI escapes when useColor is false', () => {
      expect(formatVerdict('P0', 'Alert', false)).toBe('[P0] Alert');
      expect(formatVerdict('P1', 'Warning', false)).toBe('[P1] Warning');
      expect(formatVerdict('P2', 'Info', false)).toBe('[P2] Info');
    });

    it('4.3: CLI honors NO_COLOR environment variable dynamically', () => {
      const diffFile = path.join(tempDir, 'leak.diff');
      fs.writeFileSync(
        diffFile,
        'diff --git a/a.ts b/a.ts\n@@ -0,0 +1,2 @@\n+const k = "AKIA1111111111111111";\n'
      );

      let stdout = '';
      try {
        stdout = execFileSync('node', [BIN_PATH, 'pre-commit', '--diff', diffFile], {
          encoding: 'utf-8',
          env: { ...process.env, NO_COLOR: '1' },
        });
      } catch (err: any) {
        stdout = err.stdout?.toString() || '';
      }

      expect(stdout).toContain('[P0] AWS Access Key at a.ts:1');
      expect(stdout).not.toContain('\x1b[1;31m');
      expect(stdout).not.toContain('\x1b[0m');
    });

    it('4.4: CLI honors --no-color flag even when NO_COLOR is not set in env', () => {
      const diffFile = path.join(tempDir, 'leak.diff');
      fs.writeFileSync(
        diffFile,
        'diff --git a/a.ts b/a.ts\n@@ -0,0 +1,2 @@\n+const k = "AKIA1111111111111111";\n'
      );

      const envWithoutNoColor = { ...process.env };
      delete envWithoutNoColor.NO_COLOR;

      let stdout = '';
      try {
        stdout = execFileSync('node', [BIN_PATH, 'pre-commit', '--diff', diffFile, '--no-color'], {
          encoding: 'utf-8',
          env: envWithoutNoColor,
        });
      } catch (err: any) {
        stdout = err.stdout?.toString() || '';
      }

      expect(stdout).toContain('[P0] AWS Access Key at a.ts:1');
      expect(stdout).not.toContain('\x1b[1;31m');
    });

    it('4.5: CLI --json outputs strictly valid JSON without ANSI pollution', () => {
      const diffFile = path.join(tempDir, 'leak.diff');
      fs.writeFileSync(
        diffFile,
        'diff --git a/a.ts b/a.ts\n@@ -0,0 +1,2 @@\n+const k = "AKIA1111111111111111";\n'
      );

      let stdout = '';
      try {
        stdout = execFileSync('node', [BIN_PATH, 'pre-commit', '--diff', diffFile, '--json'], {
          encoding: 'utf-8',
        });
      } catch (err: any) {
        stdout = err.stdout?.toString() || '';
      }

      const parsed = JSON.parse(stdout.trim());
      expect(parsed.exitCode).toBe(1);
      expect(parsed.clean).toBe(false);
      expect(parsed.findings.length).toBe(1);
      expect(parsed.findings[0].severity).toBe('P0');
      expect(parsed.stats.scannedFiles).toBe(1);
    });
  });

  // =========================================================================
  // Section 5: Exit Code Handling & Flag Scenarios
  // =========================================================================
  describe('Section 5: Exit Code Handling & Flag Scenarios', () => {
    it('5.1: evaluateExitCode returns 1 for P0, regardless of strict flag', () => {
      expect(evaluateExitCode([{ severity: 'P0' }], false)).toBe(1);
      expect(evaluateExitCode([{ severity: 'P0' }], true)).toBe(1);
      expect(evaluateExitCode([{ severity: 'P0' }, { severity: 'P1' }], false)).toBe(1);
    });

    it('5.2: evaluateExitCode returns 0 for clean (no findings)', () => {
      expect(evaluateExitCode([], false)).toBe(0);
      expect(evaluateExitCode([], true)).toBe(0);
    });

    it('5.3: evaluateExitCode handles P1: 0 in standard mode, 1 in --strict mode', () => {
      expect(evaluateExitCode([{ severity: 'P1' }], false)).toBe(0);
      expect(evaluateExitCode([{ severity: 'P1' }], true)).toBe(1);
    });

    it('5.4: evaluateExitCode does NOT block on P2 even in --strict mode', () => {
      expect(evaluateExitCode([{ severity: 'P2' }], false)).toBe(0);
      expect(evaluateExitCode([{ severity: 'P2' }], true)).toBe(0);
    });

    it('5.5: CLI pre-commit with flash mock returning P1 respects --strict flag', async () => {
      const mockModelClient: ReviewModelClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify([
            {
              severity: 'P1',
              rule: 'High Risk Hazard',
              filePath: 'src/handler.ts',
              message: 'Unvalidated input hazard',
            },
          ]),
          raw: {},
        }),
      };

      // Non-strict run with P1 -> exitCode 0
      const standardResult = await runPreCommit({
        diff: 'diff --git a/src/handler.ts b/src/handler.ts\n@@ -0,0 +1,2 @@\n+const x = 1;\n',
        modelClient: mockModelClient,
        strict: false,
        quiet: true,
      });
      expect(standardResult.exitCode).toBe(0);
      expect(standardResult.findings.length).toBe(1);

      // Strict run with P1 -> exitCode 1
      const strictResult = await runPreCommit({
        diff: 'diff --git a/src/handler.ts b/src/handler.ts\n@@ -0,0 +1,2 @@\n+const x = 1;\n',
        modelClient: mockModelClient,
        strict: true,
        quiet: true,
      });
      expect(strictResult.exitCode).toBe(1);
    });

    it('5.6: CLI returns exit code 1 when --diff specifies a non-existent file', async () => {
      const code = await runCli(['pre-commit', '--diff', 'non_existent_diff_file.diff']);
      expect(code).toBe(1);
    });
  });

  // =========================================================================
  // Section 6: Git Hook Installation & Binary Packaging
  // =========================================================================
  describe('Section 6: Git Hook Installation & Binary Packaging', () => {
    it('6.1: bin/review-yeti.js exists and is executable (mode 0o755)', () => {
      expect(fs.existsSync(BIN_PATH)).toBe(true);
      const stat = fs.statSync(BIN_PATH);
      expect((stat.mode & 0o111) !== 0).toBe(true);
    });

    it('6.2: package.json maps bin entries for review-yeti, git-yeti, and ct-review', () => {
      const pkgJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
      expect(pkgJson.bin).toBeDefined();
      expect(pkgJson.bin['review-yeti']).toBe('bin/review-yeti.js');
      expect(pkgJson.bin['git-yeti']).toBe('bin/review-yeti.js');
      expect(pkgJson.bin['ct-review']).toBe('bin/review-yeti.js');
      expect(pkgJson.files).toContain('bin/');
    });

    it('6.3: install-hook creates an executable pre-commit script with fallback commands', () => {
      const hookResult = installGitHook({ repoRoot: tempDir });
      expect(hookResult.success).toBe(true);
      expect(fs.existsSync(hookResult.hookPath)).toBe(true);

      const content = fs.readFileSync(hookResult.hookPath, 'utf-8');
      expect(content).toContain('npx review-yeti pre-commit');
      expect(content).toContain('review-yeti pre-commit');
      expect(content).toContain('git-yeti pre-commit');

      const stat = fs.statSync(hookResult.hookPath);
      expect((stat.mode & 0o111) !== 0).toBe(true);
    });
  });

  // =========================================================================
  // Section 7: Strict Public Anonymity Audit
  // =========================================================================
  describe('Section 7: Strict Public Anonymity Audit', () => {
    it('7.1: Zero proprietary company references across all Milestone 3 files', () => {
      const m3Files = [
        'bin/review-yeti.js',
        'src/cli/index.ts',
        'src/cli/preCommit.ts',
        'tests/unit/cli.test.ts',
        'tests/unit/preCommit.test.ts',
      ];

      for (const relPath of m3Files) {
        const fullPath = path.join(REPO_ROOT, relPath);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          // Check for forbidden keyword (case-insensitive)
          const match = content.match(/calltelemetry/i);
          expect(match, `Forbidden proprietary keyword found in ${relPath}`).toBeNull();
        }
      }
    });
  });
});
