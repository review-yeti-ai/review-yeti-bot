import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import {
  runPreCheckAnalyzers,
  parseEslintOutput,
  parseSemgrepOutput,
  parseGitleaksOutput,
  getApplicableAnalyzers,
  formatCandidateHypothesesPrompt,
  filterHypothesesForPersona,
  maskSecret,
  normalizeRepoPath,
  DefaultSandboxRunner,
  executeSandboxedCommand,
  CandidateHypothesis,
  PreCheckSummary,
} from '../../src/sandbox/analyzerRunner';
import { SandboxRunner, SandboxCommandResult } from '../../src/fix/sandboxRunner';
import { PreChecksAnalyzersConfig } from '../../src/config/schema';

// In-memory mock runner for deterministic control over subprocess behavior
class MockSandboxRunner implements SandboxRunner {
  private rules: Array<{
    matcher: (cmd: string, args: string[]) => boolean;
    response: Partial<SandboxCommandResult> | ((cmd: string, args: string[]) => Partial<SandboxCommandResult>);
  }> = [];

  public executedCommands: Array<{ command: string; args: string[]; options?: any }> = [];

  onCommand(
    matcher: string | RegExp | ((cmd: string, args: string[]) => boolean),
    response: Partial<SandboxCommandResult> | ((cmd: string, args: string[]) => Partial<SandboxCommandResult>)
  ): this {
    const predicate = typeof matcher === 'string'
      ? (cmd: string, args: string[]) => cmd.includes(matcher) || args.some((a) => a.includes(matcher))
      : matcher instanceof RegExp
      ? (cmd: string, args: string[]) => matcher.test(cmd) || args.some((a) => matcher.test(a))
      : matcher;
    this.rules.push({ matcher: predicate, response });
    return this;
  }

  async run(command: string, args: string[], options?: any): Promise<SandboxCommandResult> {
    this.executedCommands.push({ command, args, options });
    for (const rule of this.rules) {
      if (rule.matcher(command, args)) {
        const res = typeof rule.response === 'function' ? rule.response(command, args) : rule.response;
        return {
          command,
          exitStatus: res.exitStatus ?? 0,
          stdout: res.stdout ?? '',
          stderr: res.stderr ?? '',
        };
      }
    }
    return { command, exitStatus: 0, stdout: '[]', stderr: '' };
  }

  clear(): void {
    this.rules = [];
    this.executedCommands = [];
  }
}

describe('Challenger M4-1 Empirical Adversarial Test Suite', () => {
  let mockRunner: MockSandboxRunner;
  const workspaceRoot = '/test/workspace';
  const fullConfig: PreChecksAnalyzersConfig & { heavy_compilers?: boolean } = {
    enabled: true,
    linters: true,
    security: true,
    secrets: true,
    heavy_compilers: true,
  };

  beforeEach(() => {
    mockRunner = new MockSandboxRunner();
  });

  // ===========================================================================
  // SUITE 1: PARSER FUZZING & CORRUPTED / UNEXPECTED SCHEMAS
  // ===========================================================================
  describe('Suite 1: Parser Fuzzing & Malformed JSON Handling', () => {
    const corruptedPayloads = [
      '',
      '   \n\t  ',
      '{ not valid json }',
      '[ { incomplete: "json',
      'NaN',
      'undefined',
      '{"results": [1, 2, 3]}',
      '{"messages": null}',
      '{"issues": "not an array"}',
      '{"findings": 12345}',
      '{"command-line-arguments": "corrupted"}',
      '{"RuleID": true}',
      '{"line": -10, "path": null}',
    ];

    it('1.1: parseEslintOutput handles fuzz/corrupted inputs without unhandled exception', () => {
      for (const payload of corruptedPayloads) {
        expect(() => parseEslintOutput(payload, workspaceRoot)).not.toThrow();
        const result = parseEslintOutput(payload, workspaceRoot);
        expect(Array.isArray(result)).toBe(true);
      }
    });

    it('1.2: parseSemgrepOutput handles fuzz/corrupted inputs without unhandled exception', () => {
      for (const payload of corruptedPayloads) {
        expect(() => parseSemgrepOutput(payload, workspaceRoot)).not.toThrow();
        const result = parseSemgrepOutput(payload, workspaceRoot);
        expect(Array.isArray(result)).toBe(true);
      }
    });

    it('1.3: parseGitleaksOutput handles fuzz/corrupted inputs without unhandled exception', () => {
      for (const payload of corruptedPayloads) {
        expect(() => parseGitleaksOutput(payload, workspaceRoot)).not.toThrow();
        const result = parseGitleaksOutput(payload, workspaceRoot);
        expect(Array.isArray(result)).toBe(true);
      }
    });

    it('1.7: ESLint parser tolerates missing message attributes (null ruleId, NaN lines)', () => {
      const weirdPayload = JSON.stringify([
        {
          filePath: '/test/workspace/src/weird.ts',
          messages: [
            {
              ruleId: null, // missing rule
              line: 'not-a-number',
              message: null,
              severity: 99,
            },
            null, // null entry in messages array
          ],
        },
      ]);

      const hypotheses = parseEslintOutput(weirdPayload, workspaceRoot);
      expect(hypotheses).toHaveLength(1);
      expect(hypotheses[0].ruleId).toBe('eslint');
      expect(hypotheses[0].line).toBe(1); // normalized to >= 1
      expect(hypotheses[0].path).toBe('src/weird.ts');
      expect(hypotheses[0].severity).toBe('warning'); // non-2 severity defaults to warning
    });

    it('1.8: Semgrep parser handles missing extra metadata and string numbers', () => {
      const payload = JSON.stringify({
        results: [
          {
            check_id: 'custom.rule',
            path: 'lib/db.ts',
            start: { line: '42', col: '10' },
            extra: null, // missing extra
          },
        ],
      });

      const hypotheses = parseSemgrepOutput(payload, workspaceRoot);
      expect(hypotheses).toHaveLength(1);
      expect(hypotheses[0].line).toBe(42);
      expect(hypotheses[0].path).toBe('lib/db.ts');
      expect(hypotheses[0].severity).toBe('warning');
    });

    it('1.11: Parsers with non-string paths in AST/SAST results handle safely without throwing', () => {
      // SAST output with unexpected schema: path is a number
      const weirdSemgrep = {
        results: [
          {
            check_id: 'rule1',
            path: 12345, // corrupted non-string path
            start: { line: 10 },
          },
        ],
      };
      expect(() => parseSemgrepOutput(weirdSemgrep as any, workspaceRoot)).not.toThrow();
      const hypotheses = parseSemgrepOutput(weirdSemgrep as any, workspaceRoot);
      expect(hypotheses).toHaveLength(1);
      expect(hypotheses[0].path).toBe('');
    });
  });

  // ===========================================================================
  // SUITE 3: GITLEAKS SECRET MASKING & SENSITIVE DATA DEFENSE
  // ===========================================================================
  describe('Suite 3: Gitleaks Secret Masking & Entropy Edge Cases', () => {
    it('3.1: masks secrets of various lengths reliably without leaking content', () => {
      // <= 6 chars: completely replaced with ***
      expect(maskSecret('')).toBe('***');
      expect(maskSecret('a')).toBe('***');
      expect(maskSecret('abcdef')).toBe('***');

      // 7..12 chars: first 2 and last 2 preserved, middle 4 asterisks
      expect(maskSecret('1234567')).toBe('12****67');
      expect(maskSecret('123456789012')).toBe('12****12');

      // > 12 chars: first 4 and last 4 preserved, middle 4 asterisks
      expect(maskSecret('AKIAIOSFODNN7EXAMPLE')).toBe('AKIA****MPLE');
      expect(maskSecret('ghp_abcdefghijklmnopqrstuvwxyz123456')).toBe('ghp_****3456');

      // non-string or falsy input
      expect(maskSecret(null as any)).toBe('***');
      expect(maskSecret(undefined as any)).toBe('***');
      expect(maskSecret(12345678 as any)).toBe('***');
    });

    it('3.2: masks multi-line secrets and whitespace-padded secrets', () => {
      const privateKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----';
      const masked = maskSecret(privateKey);
      expect(masked).not.toContain('MIIEow');
      expect(masked).toMatch(/^----.*\*\*\*\*.*----$/);

      const padded = '   ghp_1234567890abcdef1234567890abcdef   ';
      const maskedPadded = maskSecret(padded);
      expect(maskedPadded).toBe('ghp_****cdef');
    });

    it('3.3: parseGitleaksOutput formats snippet with masked secret and never reveals raw secret', () => {
      const rawSecret = 'ghp_secret_token_1234567890_super_private';
      const rawPayload = JSON.stringify([
        {
          RuleID: 'github-pat',
          Description: 'GitHub Personal Access Token',
          File: 'src/config/token.ts',
          StartLine: 15,
          EndLine: 15,
          StartColumn: 10,
          Secret: rawSecret,
          Match: `token = "${rawSecret}"`,
        },
      ]);

      const hypotheses = parseGitleaksOutput(rawPayload, workspaceRoot);
      expect(hypotheses).toHaveLength(1);
      expect(hypotheses[0].category).toBe('secrets');
      expect(hypotheses[0].severity).toBe('critical');
      expect(hypotheses[0].snippet).toContain('Matched pattern: ghp_****vate');
      expect(hypotheses[0].snippet).not.toContain(rawSecret);
      expect(hypotheses[0].message).not.toContain(rawSecret);
    });
  });

  // ===========================================================================
  // SUITE 4: EXECUTION BOUNDARY STRESS & SIMULATED TOOLCHAIN FAILURES
  // ===========================================================================
  describe('Suite 4: Execution Boundary Stress & Fail-Soft Conditions', () => {
    const ALL_TOOLS = ['eslint', 'semgrep', 'gitleaks'] as const;

    for (const tool of ALL_TOOLS) {
      it(`4.1.${tool}: records exitStatus: "not_installed" with available: false when ${tool} binary triggers ENOENT`, async () => {
        mockRunner.onCommand(tool, {
          exitStatus: 'error',
          stderr: `spawn ${tool} ENOENT: binary not found in PATH`,
        });

        // Determine a target file that routes to this tool
        let testFile = 'src/app.ts';
        if (tool === 'gitleaks') testFile = 'config/secrets.env';

        const summary = await runPreCheckAnalyzers({
          workspaceRoot,
          changedFiles: [testFile],
          config: fullConfig,
          sandboxRunner: mockRunner,
        });

        const receipt = summary.receipts.find((r) => r.tool === tool);
        expect(receipt).toBeDefined();
        expect(receipt?.available).toBe(false);
        expect(receipt?.exitStatus).toBe('not_installed');
        expect(receipt?.hypotheses).toHaveLength(0);
      });
    }

    it('4.2: records exitStatus: "timeout" and preserves overall run when an analyzer command times out', async () => {
      mockRunner.onCommand('eslint', {
        exitStatus: 'timeout',
        stderr: 'Command execution timed out after 15000ms',
      });
      mockRunner.onCommand('semgrep', {
        exitStatus: 0,
        stdout: JSON.stringify({ results: [] }),
      });
      mockRunner.onCommand('gitleaks', {
        exitStatus: 0,
        stdout: JSON.stringify([]),
      });

      const summary = await runPreCheckAnalyzers({
        workspaceRoot,
        changedFiles: ['src/app.ts'],
        config: fullConfig,
        sandboxRunner: mockRunner,
      });

      const eslintReceipt = summary.receipts.find((r) => r.tool === 'eslint');
      expect(eslintReceipt?.exitStatus).toBe('timeout');
      expect(eslintReceipt?.available).toBe(true);
      expect(eslintReceipt?.hypotheses).toHaveLength(0);

      // Remaining tools executed cleanly
      expect(summary.analyzersExecuted).toBe(3);
      expect(summary.status).toBe('clean');
    });

    it('4.3: treats exit code 1 with valid findings as success, but exit code 1 with empty stdout/stderr as error', async () => {
      // Tool A: Exit code 1 with valid JSON findings
      mockRunner.onCommand('eslint', {
        exitStatus: 1,
        stdout: JSON.stringify([
          {
            filePath: '/test/workspace/src/app.ts',
            messages: [{ ruleId: 'no-debugger', severity: 2, line: 12, message: 'Unexpected debugger' }],
          },
        ]),
      });

      // Tool B: Exit code 1 with fatal crash and no findings
      mockRunner.onCommand('semgrep', {
        exitStatus: 1,
        stdout: '',
        stderr: 'Fatal: invalid configuration flag provided',
      });

      const summary = await runPreCheckAnalyzers({
        workspaceRoot,
        changedFiles: ['src/app.ts'],
        config: { enabled: true, linters: true, security: true, secrets: false },
        sandboxRunner: mockRunner,
      });

      const eslintReceipt = summary.receipts.find((r) => r.tool === 'eslint');
      expect(eslintReceipt?.exitStatus).toBe(1);
      expect(eslintReceipt?.hypotheses).toHaveLength(1);
      expect(eslintReceipt?.hypotheses[0].ruleId).toBe('no-debugger');

      const semgrepReceipt = summary.receipts.find((r) => r.tool === 'semgrep');
      expect(semgrepReceipt?.exitStatus).toBe('error');
      expect(semgrepReceipt?.hypotheses).toHaveLength(0);
      expect(semgrepReceipt?.error).toContain('Fatal: invalid configuration flag');
    });

    it('4.4: handles exit code 2+ (linter crash / fatal error) cleanly with 0 hypotheses', async () => {
      mockRunner.onCommand('eslint', {
        exitStatus: 2,
        stdout: '',
        stderr: 'Fatal error: Cannot find module',
      });

      const summary = await runPreCheckAnalyzers({
        workspaceRoot,
        changedFiles: ['src/app.ts'],
        config: fullConfig,
        sandboxRunner: mockRunner,
      });

      const receipt = summary.receipts.find((r) => r.tool === 'eslint');
      expect(receipt?.exitStatus).toBe('error');
      expect(receipt?.hypotheses).toHaveLength(0);
    });
  });

  // ===========================================================================
  // SUITE 5: BUFFER CAPPING & STREAM TRUNCATION EMPIRICAL STRESS
  // ===========================================================================
  describe('Suite 5: Buffer Capping & Stream Truncation', () => {
    it('5.1: DefaultSandboxRunner caps stdout accumulation to maxBytes limit without hanging', async () => {
      const runner = new DefaultSandboxRunner();
      // Generate 200,000 characters with a 10,000 byte cap
      const script = `process.stdout.write('A'.repeat(200000))`;
      const res = await runner.run('node', ['-e', script], {
        maxBytes: 10_000,
        timeoutMs: 5000,
      });

      expect(res.exitStatus).toBe(0);
      expect(res.stdout.length).toBe(10_000);
      expect(res.stdout).toBe('A'.repeat(10_000));
    });

    it('5.2: DefaultSandboxRunner caps stderr accumulation to maxBytes limit without hanging', async () => {
      const runner = new DefaultSandboxRunner();
      const script = `process.stderr.write('B'.repeat(200000))`;
      const res = await runner.run('node', ['-e', script], {
        maxBytes: 15_000,
        timeoutMs: 5000,
      });

      expect(res.exitStatus).toBe(0);
      expect(res.stderr.length).toBe(15_000);
      expect(res.stderr).toBe('B'.repeat(15_000));
    });

    it('5.3: DefaultSandboxRunner terminates hanging process cleanly when timeoutMs expires', async () => {
      const runner = new DefaultSandboxRunner();
      // Hanging script: infinite interval
      const script = `setInterval(() => {}, 1000)`;
      const startTime = Date.now();
      const res = await runner.run('node', ['-e', script], {
        timeoutMs: 250,
      });
      const elapsed = Date.now() - startTime;

      expect(res.exitStatus).toBe('timeout');
      expect(elapsed).toBeGreaterThanOrEqual(240);
      expect(elapsed).toBeLessThan(3000); // verified quick SIGTERM/SIGKILL termination
    });

    it('5.4: DefaultSandboxRunner returns error and ENOENT when binary does not exist', async () => {
      const runner = new DefaultSandboxRunner();
      const res = await runner.run('non_existent_binary_xyz_12345', []);
      expect(res.exitStatus).toBe('error');
      expect(res.stderr).toContain('ENOENT');

      // Test executeSandboxedCommand wrapper converts it to not_installed
      const cmdRes = await executeSandboxedCommand('non_existent_binary_xyz_12345', [], {
        sandboxRunner: runner,
      });
      expect(cmdRes.exitStatus).toBe('not_installed');
    });

    it('5.5: parsers handle 500KB truncated JSON output gracefully without unhandled crashes', () => {
      // Simulate a 500KB JSON payload that was truncated mid-stream
      const largePrefix = JSON.stringify(
        Array.from({ length: 2000 }, (_, i) => ({
          filePath: `/test/workspace/src/file_${i}.ts`,
          messages: [{ ruleId: 'no-console', line: i + 1, message: 'Unexpected console statement' }],
        }))
      );
      // Cut off at 50,000 bytes mid-structure
      const truncated = largePrefix.slice(0, 50_000);

      expect(() => parseEslintOutput(truncated, workspaceRoot)).not.toThrow();
      expect(parseEslintOutput(truncated, workspaceRoot)).toEqual([]);

      expect(() => parseSemgrepOutput(truncated, workspaceRoot)).not.toThrow();
      expect(parseSemgrepOutput(truncated, workspaceRoot)).toEqual([]);

      expect(() => parseGitleaksOutput(truncated, workspaceRoot)).not.toThrow();
      expect(parseGitleaksOutput(truncated, workspaceRoot)).toEqual([]);
    });
  });

  // ===========================================================================
  // SUITE 6: MULTI-ECOSYSTEM FILE ROUTING & PATH NORMALIZATION EDGE CASES
  // ===========================================================================
  describe('Suite 6: Multi-Ecosystem File Routing Edge Cases', () => {
    it('6.1: correctly categorizes edge case extensions (.mjs, .cjs, .exs, uppercase .GO, .TSX)', () => {
      expect(getApplicableAnalyzers('server.mjs', fullConfig)).toContain('eslint');
      expect(getApplicableAnalyzers('server.cjs', fullConfig)).toContain('eslint');
      expect(getApplicableAnalyzers('test/test_helper.exs', fullConfig)).toContain('semgrep');
      expect(getApplicableAnalyzers('test/test_helper.exs', fullConfig)).not.toContain('credo');
      expect(getApplicableAnalyzers('pkg/main.GO', fullConfig)).toContain('semgrep');
      expect(getApplicableAnalyzers('pkg/main.GO', fullConfig)).not.toContain('govet');
      expect(getApplicableAnalyzers('components/Header.TSX', fullConfig)).toContain('eslint');
    });

    it('6.2: excludes standard binary file extensions from all tools', () => {
      const binaries = [
        'assets/logo.png',
        'assets/hero.JPG',
        'assets/favicon.ICO',
        'build/binary.exe',
        'build/library.DLL',
        'build/archive.tar.gz',
        'build/package.zip',
        'docs/contract.pdf',
      ];

      for (const binary of binaries) {
        const tools = getApplicableAnalyzers(binary, fullConfig);
        expect(tools).toHaveLength(0);
      }
    });

    it('6.2.wasm: verifies .wasm binary exclusion from secret scanning', () => {
      const tools = getApplicableAnalyzers('wasm/module.wasm', fullConfig);
      expect(tools).toHaveLength(0);
    });

    it('6.3: zero-file input executes 0 subprocesses and returns clean status', async () => {
      const summary = await runPreCheckAnalyzers({
        workspaceRoot,
        changedFiles: [],
        config: fullConfig,
        sandboxRunner: mockRunner,
      });

      expect(summary.status).toBe('clean');
      expect(summary.analyzersExecuted).toBe(0);
      expect(summary.hypothesesCount).toBe(0);
      expect(mockRunner.executedCommands).toHaveLength(0);
    });

    it('6.4: input with only binary files executes 0 subprocesses and returns clean status', async () => {
      const summary = await runPreCheckAnalyzers({
        workspaceRoot,
        changedFiles: ['images/photo.jpg', 'vendor/bundle.zip'],
        config: fullConfig,
        sandboxRunner: mockRunner,
      });

      expect(summary.status).toBe('clean');
      expect(summary.analyzersExecuted).toBe(0);
      expect(summary.hypothesesCount).toBe(0);
      expect(mockRunner.executedCommands).toHaveLength(0);
    });

    it('6.5: input with only deleted files executes 0 subprocesses and returns clean status', async () => {
      const summary = await runPreCheckAnalyzers({
        workspaceRoot,
        changedFiles: [
          { path: 'src/deleted1.ts', status: 'deleted' },
          { path: 'lib/deleted2.ex', status: 'deleted' },
        ],
        config: fullConfig,
        sandboxRunner: mockRunner,
      });

      expect(summary.status).toBe('clean');
      expect(summary.analyzersExecuted).toBe(0);
      expect(summary.hypothesesCount).toBe(0);
      expect(mockRunner.executedCommands).toHaveLength(0);
    });

    it('6.6: mixed PR diff routes files precisely to respective ecosystem tools only', async () => {
      await runPreCheckAnalyzers({
        workspaceRoot,
        changedFiles: [
          'src/app.ts',
          'lib/router.ex',
          'pkg/handler.go',
          'docs/README.md',
          'assets/diagram.png',
        ],
        config: fullConfig,
        sandboxRunner: mockRunner,
      });

      const eslintCmd = mockRunner.executedCommands.find((c) => c.command.includes('eslint'));
      expect(eslintCmd?.args).toContain('src/app.ts');
      expect(eslintCmd?.args).not.toContain('lib/router.ex');
      expect(eslintCmd?.args).not.toContain('pkg/handler.go');

      const semgrepCmd = mockRunner.executedCommands.find((c) => c.command.includes('semgrep'));
      expect(semgrepCmd?.args).toContain('lib/router.ex');
      expect(semgrepCmd?.args).toContain('pkg/handler.go');

      expect(mockRunner.executedCommands.some((c) => c.command.includes('credo'))).toBe(false);
      expect(mockRunner.executedCommands.some((c) => c.command.includes('govet'))).toBe(false);

      const gitleaksCmd = mockRunner.executedCommands.find((c) => c.command.includes('gitleaks'));
      expect(gitleaksCmd).toBeDefined();
      // Assets png should NOT be in any tool command
      for (const cmd of mockRunner.executedCommands) {
        expect(cmd.args).not.toContain('assets/diagram.png');
      }
    });

    it('6.7: normalizeRepoPath handles Windows paths, leading slashes, and relative dots', () => {
      expect(normalizeRepoPath('C:\\project\\src\\app.ts', 'C:/project')).toBe('src/app.ts');
      expect(normalizeRepoPath('///src//app.ts')).toBe('src//app.ts');
      expect(normalizeRepoPath('./src/app.ts')).toBe('src/app.ts');
      expect(normalizeRepoPath('/workspace/nested/file.go', '/workspace/')).toBe('nested/file.go');
    });
  });

  // ===========================================================================
  // SUITE 7: PERSONA LANE SCOPING & PROMPT BUDGETING STRESS
  // ===========================================================================
  describe('Suite 7: Persona Lane Scoping & Budgeting Stress', () => {
    it('7.1: filterHypothesesForPersona strictly enforces 20-cap and sorts secrets > security > linter', () => {
      const generated: CandidateHypothesis[] = [];
      // 30 linters
      for (let i = 0; i < 30; i++) {
        generated.push({
          id: `hyp:eslint:rule-${i}:src/app.ts:${i + 1}`,
          analyzer: 'eslint',
          category: 'linter',
          ruleId: `rule-${i}`,
          path: 'src/app.ts',
          line: i + 1,
          message: `Linter warning ${i}`,
          severity: 'warning',
          confidence: 'medium',
        });
      }
      // 10 security
      for (let i = 0; i < 10; i++) {
        generated.push({
          id: `hyp:semgrep:sec-${i}:src/app.ts:${i + 100}`,
          analyzer: 'semgrep',
          category: 'security',
          ruleId: `sec-${i}`,
          path: 'src/app.ts',
          line: i + 100,
          message: `Security vuln ${i}`,
          severity: 'error',
          confidence: 'high',
        });
      }
      // 5 secrets
      for (let i = 0; i < 5; i++) {
        generated.push({
          id: `hyp:gitleaks:secret-${i}:src/app.ts:${i + 200}`,
          analyzer: 'gitleaks',
          category: 'secrets',
          ruleId: `secret-${i}`,
          path: 'src/app.ts',
          line: i + 200,
          message: `Secret leak ${i}`,
          severity: 'critical',
          confidence: 'high',
        });
      }

      const filtered = filterHypothesesForPersona({
        hypotheses: generated,
        personaId: 'general-lane',
        charter: 'general review',
        scopedFiles: [{ path: 'src/app.ts' }],
      });

      expect(filtered).toHaveLength(20);
      // All 5 secrets must be first
      for (let i = 0; i < 5; i++) {
        expect(filtered[i].category).toBe('secrets');
      }
      // Next 10 must be security
      for (let i = 5; i < 15; i++) {
        expect(filtered[i].category).toBe('security');
      }
      // Remaining 5 must be linter
      for (let i = 15; i < 20; i++) {
        expect(filtered[i].category).toBe('linter');
      }
    });

    it('7.2: formatCandidateHypothesesPrompt generates explicit VERIFY or REFUTE instructions', () => {
      const hypotheses: CandidateHypothesis[] = [
        {
          id: 'hyp:eslint:no-eval:src/eval.ts:5',
          analyzer: 'eslint',
          category: 'linter',
          ruleId: 'no-eval',
          path: 'src/eval.ts',
          line: 5,
          message: 'eval can be harmful',
          severity: 'error',
          confidence: 'high',
        },
      ];

      const prompt = formatCandidateHypothesesPrompt(hypotheses);
      expect(prompt).toContain('=== DETERMINISTIC STATIC ANALYSIS PRE-CHECK HYPOTHESES (UNVERIFIED) ===');
      expect(prompt).toContain('Verify or refute each hypothesis during your review turns:');
      expect(prompt).toContain('Do NOT publish raw hypotheses directly without verifying them.');
      expect(prompt).toContain('If verified: Formulate a validated finding');
      expect(prompt).toContain('If refuted (false positive, test mock, intentional design): Silently discard');
      expect(prompt).toContain('[HYPOTHESIS hyp:eslint:no-eval:src/eval.ts:5]');
    });

    it('7.3: formatCandidateHypothesesPrompt returns empty string when disabled or empty', () => {
      expect(formatCandidateHypothesesPrompt([])).toBe('');
      expect(formatCandidateHypothesesPrompt(null)).toBe('');
      expect(formatCandidateHypothesesPrompt(undefined)).toBe('');

      const disabledSummary: PreCheckSummary = {
        enabled: false,
        analyzersExecuted: 0,
        hypothesesCount: 0,
        receipts: [],
        hypotheses: [],
        status: 'disabled',
      };
      expect(formatCandidateHypothesesPrompt(disabledSummary)).toBe('');
    });
  });
});
