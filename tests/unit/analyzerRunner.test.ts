import { describe, it, expect, beforeEach } from 'vitest';
import {
  runPreCheckAnalyzers,
  parseEslintOutput,
  parseSemgrepOutput,
  parseCredoOutput,
  parseSobelowOutput,
  parseGovetOutput,
  parseGitleaksOutput,
  getApplicableAnalyzers,
  formatCandidateHypothesesPrompt,
  formatCandidateHypothesesEvidence,
  filterHypothesesForPersona,
  maskSecret,
  normalizeRepoPath,
  CandidateHypothesis,
  PreCheckSummary,
  PreCheckAnalyzerReceipt,
} from '../../src/sandbox/analyzerRunner';
import { SandboxRunner, SandboxCommandResult } from '../../src/fix/sandboxRunner';
import { PreChecksAnalyzersConfig } from '../../src/config/schema';

// =============================================================================
// IN-MEMORY MOCK SANDBOX RUNNER
// =============================================================================

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

describe('analyzerRunner.test.ts — Milestone 4 Unit Test Suite', () => {
  let mockRunner: MockSandboxRunner;
  const defaultWorkspace = '/workspace';
  const fullConfig: PreChecksAnalyzersConfig = {
    enabled: true,
    linters: true,
    security: true,
    secrets: true,
  };

  beforeEach(() => {
    mockRunner = new MockSandboxRunner();
  });

  // ===========================================================================
  // SUITE 1: PARSER VERIFICATION & CANDIDATE HYPOTHESIS MAPPING
  // ===========================================================================
  describe('Suite 1: Output Parsers & Candidate Hypotheses Mapping', () => {
    // 1.1 ESLint Parser
    it('1.1: parses ESLint JSON into exact CandidateHypothesis structures with severity mapping', () => {
      const eslintStdout = JSON.stringify([
        {
          filePath: '/workspace/src/auth.ts',
          messages: [
            {
              ruleId: 'no-unused-vars',
              severity: 2,
              message: "'token' is defined but never used.",
              line: 14,
              column: 9,
              endLine: 14,
            },
            {
              ruleId: '@typescript-eslint/no-explicit-any',
              severity: 1,
              message: 'Unexpected any.',
              line: 30,
              column: 15,
            },
          ],
        },
      ]);

      const hypotheses = parseEslintOutput(eslintStdout, defaultWorkspace);
      expect(hypotheses).toHaveLength(2);

      expect(hypotheses[0]).toEqual({
        id: 'hyp:eslint:no-unused-vars:src/auth.ts:14',
        analyzer: 'eslint',
        category: 'linter',
        ruleId: 'no-unused-vars',
        path: 'src/auth.ts',
        line: 14,
        endLine: 14,
        column: 9,
        message: "'token' is defined but never used.",
        severity: 'error',
        confidence: 'high',
      });

      expect(hypotheses[1].severity).toBe('warning');
      expect(hypotheses[1].ruleId).toBe('@typescript-eslint/no-explicit-any');
      expect(hypotheses[1].line).toBe(30);
    });

    // 1.2 Semgrep Parser
    it('1.2: parses Semgrep JSON results with ruleId, CWE metadata, and security category', () => {
      const semgrepStdout = JSON.stringify({
        results: [
          {
            check_id: 'javascript.express.security.audit.sqli.node-postgres-sqli',
            path: 'src/db/query.ts',
            start: { line: 28, col: 12 },
            end: { line: 28, col: 65 },
            extra: {
              message: 'Untrusted input concatenated into SQL query.',
              severity: 'ERROR',
              metadata: { confidence: 'HIGH', cwe: ['CWE-89: SQL Injection'] },
            },
          },
        ],
      });

      const hypotheses = parseSemgrepOutput(semgrepStdout, defaultWorkspace);
      expect(hypotheses).toHaveLength(1);
      expect(hypotheses[0]).toEqual({
        id: 'hyp:semgrep:javascript.express.security.audit.sqli.node-postgres-sqli:src/db/query.ts:28',
        analyzer: 'semgrep',
        category: 'security',
        ruleId: 'javascript.express.security.audit.sqli.node-postgres-sqli',
        path: 'src/db/query.ts',
        line: 28,
        endLine: 28,
        column: 12,
        message: 'Untrusted input concatenated into SQL query.',
        severity: 'error',
        confidence: 'high',
      });
    });

    // 1.3 Credo Parser
    it('1.3: parses Credo issues into refactor (info) and warning hypotheses', () => {
      const credoStdout = JSON.stringify({
        issues: [
          {
            category: 'refactor',
            check: 'Credo.Check.Refactor.CyclomaticComplexity',
            filename: 'lib/telecom/call_router.ex',
            line_no: 54,
            column: 7,
            message: 'Function has cyclomatic complexity of 14.',
          },
          {
            category: 'warning',
            check: 'Credo.Check.Warning.UnusedEnumOperation',
            filename: 'lib/telecom/call_router.ex',
            line_no: 82,
            column: 5,
            message: 'Unused return value from Enum.map/2.',
          },
        ],
      });

      const hypotheses = parseCredoOutput(credoStdout, defaultWorkspace);
      expect(hypotheses).toHaveLength(2);
      expect(hypotheses[0].severity).toBe('info');
      expect(hypotheses[0].category).toBe('linter');
      expect(hypotheses[0].id).toBe('hyp:credo:Credo.Check.Refactor.CyclomaticComplexity:lib/telecom/call_router.ex:54');
      expect(hypotheses[1].severity).toBe('warning');
      expect(hypotheses[1].id).toBe('hyp:credo:Credo.Check.Warning.UnusedEnumOperation:lib/telecom/call_router.ex:82');
    });

    // 1.4 Sobelow Parser
    it('1.4: parses Sobelow categorized findings into security hypotheses with confidence', () => {
      const sobelowStdout = JSON.stringify({
        findings: {
          sql_injection: [
            {
              type: 'SQL.Query: SQL Injection',
              file: 'lib/telecom_web/controllers/report_controller.ex',
              line: 37,
              variable: 'params["order_by"]',
              confidence: 'High',
              fun_name: 'export_csv/2',
            },
          ],
          traversal: [],
        },
      });

      const hypotheses = parseSobelowOutput(sobelowStdout, defaultWorkspace);
      expect(hypotheses).toHaveLength(1);
      expect(hypotheses[0]).toEqual({
        id: 'hyp:sobelow:sql_injection:lib/telecom_web/controllers/report_controller.ex:37',
        analyzer: 'sobelow',
        category: 'security',
        ruleId: 'sql_injection',
        path: 'lib/telecom_web/controllers/report_controller.ex',
        line: 37,
        message: 'SQL.Query: SQL Injection in export_csv/2 (params["order_by"])',
        severity: 'error',
        confidence: 'high',
      });
    });

    it('1.4b: parses Sobelow root-level vulnerability keys when data.findings is absent', () => {
      const rootSobelow = JSON.stringify({
        sql_injection: [
          {
            type: 'SQL.Query: SQL Injection',
            file: 'lib/telecom_web/controllers/report_controller.ex',
            line: 37,
            variable: 'params["order_by"]',
            confidence: 'High',
            fun_name: 'export_csv/2',
          },
        ],
      });

      const hypotheses = parseSobelowOutput(rootSobelow, defaultWorkspace);
      expect(hypotheses).toHaveLength(1);
      expect(hypotheses[0].ruleId).toBe('sql_injection');
      expect(hypotheses[0].path).toBe('lib/telecom_web/controllers/report_controller.ex');
      expect(hypotheses[0].line).toBe(37);
      expect(hypotheses[0].confidence).toBe('high');
    });

    // 1.5 Go Vet Parser (stderr JSON Convention)
    it('1.5: parses Go Vet diagnostics from stderr stream into linter hypotheses', () => {
      const govetStderr = JSON.stringify({
        'command-line-arguments': {
          printf: [
            {
              posn: 'pkg/billing/invoice.go:45:14',
              message: 'fmt.Sprintf format %s reads arg #1, but call has only 0 args',
            },
          ],
        },
      });

      // Crucial assertion: Go Vet outputs JSON on stderr, not stdout
      const hypotheses = parseGovetOutput(govetStderr, defaultWorkspace);
      expect(hypotheses).toHaveLength(1);
      expect(hypotheses[0]).toEqual({
        id: 'hyp:govet:printf:pkg/billing/invoice.go:45',
        analyzer: 'govet',
        category: 'linter',
        ruleId: 'printf',
        path: 'pkg/billing/invoice.go',
        line: 45,
        column: 14,
        message: 'fmt.Sprintf format %s reads arg #1, but call has only 0 args',
        severity: 'warning',
        confidence: 'high',
      });
    });

    it('1.5b: parses multi-package Go Vet concatenated JSON streams', () => {
      const multiPkg = [
        '{',
        '  "pkg/one": {',
        '    "printf": [{ "posn": "pkg/one/a.go:10:2", "message": "format mismatch" }]',
        '  }',
        '}',
        '{',
        '  "pkg/two": {',
        '    "copylocks": [{ "posn": "pkg/two/b.go:20:5", "message": "copies lock value" }]',
        '  }',
        '}',
      ].join('\n');

      const hypotheses = parseGovetOutput(multiPkg, defaultWorkspace);
      expect(hypotheses).toHaveLength(2);
      expect(hypotheses[0].ruleId).toBe('printf');
      expect(hypotheses[0].path).toBe('pkg/one/a.go');
      expect(hypotheses[1].ruleId).toBe('copylocks');
      expect(hypotheses[1].path).toBe('pkg/two/b.go');
    });

    it('1.5c: extracts Go Vet diagnostics from stdout when stderr contains non-JSON compiler warnings', () => {
      const compositeInput = {
        stdout: JSON.stringify({
          'pkg/billing': {
            printf: [{ posn: 'pkg/billing/inv.go:10:2', message: 'printf mismatch' }],
          },
        }),
        stderr: 'go: downloading github.com/stretchr/testify v1.8.4\n# pkg/billing\n',
      };

      const hypotheses = parseGovetOutput(compositeInput, defaultWorkspace);
      expect(hypotheses).toHaveLength(1);
      expect(hypotheses[0].ruleId).toBe('printf');
      expect(hypotheses[0].path).toBe('pkg/billing/inv.go');
      expect(hypotheses[0].line).toBe(10);
    });

    // 1.6 Gitleaks Parser with Secret Masking
    it('1.6: parses Gitleaks JSON leaks into critical secret hypotheses with masked secrets', () => {
      const gitleaksStdout = JSON.stringify([
        {
          RuleID: 'slack-webhook-url',
          Description: 'Identified a private Slack Webhook URL.',
          File: 'config/notifications.ts',
          StartLine: 12,
          EndLine: 12,
          StartColumn: 25,
        },
      ]);

      const hypotheses = parseGitleaksOutput(gitleaksStdout, defaultWorkspace);
      expect(hypotheses).toHaveLength(1);
      expect(hypotheses[0]).toEqual({
        id: 'hyp:gitleaks:slack-webhook-url:config/notifications.ts:12',
        analyzer: 'gitleaks',
        category: 'secrets',
        ruleId: 'slack-webhook-url',
        path: 'config/notifications.ts',
        line: 12,
        endLine: 12,
        column: 25,
        message: 'Identified a private Slack Webhook URL.',
        severity: 'critical',
        confidence: 'high',
      });
    });

    it('1.7: maskSecret properly replaces middle characters of secrets with asterisks', () => {
      expect(maskSecret('short')).toBe('***');
      expect(maskSecret('123456789012')).toBe('12****12');
      expect(maskSecret('ghp_1234567890abcdef1234567890abcdef')).toBe('ghp_****cdef');
      expect(maskSecret(undefined)).toBe('***');
    });

    it('1.8: normalizeRepoPath handles Windows backslashes, absolute prefixes, and relative paths', () => {
      expect(normalizeRepoPath('/workspace/src/app.ts', '/workspace')).toBe('src/app.ts');
      expect(normalizeRepoPath('src\\app.ts', '/workspace')).toBe('src/app.ts');
      expect(normalizeRepoPath('./src/app.ts', '')).toBe('src/app.ts');
      expect(normalizeRepoPath('/workspace', '/workspace')).toBe('');
    });

    it('1.8b: normalizeRepoPath safely handles non-string and falsy values', () => {
      expect(normalizeRepoPath(null as any)).toBe('');
      expect(normalizeRepoPath(undefined as any)).toBe('');
      expect(normalizeRepoPath(12345 as any)).toBe('');
      expect(normalizeRepoPath({} as any)).toBe('');
      expect(normalizeRepoPath('' as any)).toBe('');
    });
  });

  // ===========================================================================
  // SUITE 2: ECOSYSTEM ROUTING & FILE TARGET SELECTION
  // ===========================================================================
  describe('Suite 2: Ecosystem Scoping & File Routing', () => {
    it('2.1: routes TypeScript/JavaScript files to eslint, semgrep, and gitleaks', () => {
      const tools = getApplicableAnalyzers('src/app.ts', fullConfig);
      expect(tools).toContain('eslint');
      expect(tools).toContain('semgrep');
      expect(tools).toContain('gitleaks');
      expect(tools).not.toContain('credo');
      expect(tools).not.toContain('govet');
    });

    it('2.2: routes Elixir files to semgrep and gitleaks by default (CodeRabbit zero-compilation pattern)', () => {
      const tools = getApplicableAnalyzers('lib/billing/account.ex', fullConfig);
      expect(tools).toContain('semgrep');
      expect(tools).toContain('gitleaks');
      expect(tools).not.toContain('ast-grep');
      expect(tools).not.toContain('credo');
      expect(tools).not.toContain('sobelow');
      expect(tools).not.toContain('govet');

      // When heavy_compilers is explicitly enabled, routes to credo and sobelow
      const heavyTools = getApplicableAnalyzers('lib/billing/account.ex', { ...fullConfig, heavy_compilers: true });
      expect(heavyTools).toContain('credo');
      expect(heavyTools).toContain('sobelow');
      expect(heavyTools).toContain('gitleaks');
    });

    it('2.3: routes Go files to semgrep and gitleaks by default (CodeRabbit zero-compilation pattern)', () => {
      const tools = getApplicableAnalyzers('pkg/router/server.go', fullConfig);
      expect(tools).toContain('semgrep');
      expect(tools).toContain('gitleaks');
      expect(tools).not.toContain('ast-grep');
      expect(tools).not.toContain('govet');
      expect(tools).not.toContain('credo');

      // When heavy_compilers is explicitly enabled, routes to govet
      const heavyTools = getApplicableAnalyzers('pkg/router/server.go', { ...fullConfig, heavy_compilers: true });
      expect(heavyTools).toContain('govet');
      expect(heavyTools).toContain('semgrep');
      expect(heavyTools).toContain('gitleaks');
    });

    it('2.4: routes documentation and markdown files exclusively to secrets scanner (gitleaks)', () => {
      const tools = getApplicableAnalyzers('docs/ARCHITECTURE.md', fullConfig);
      expect(tools).toEqual(['gitleaks']);
    });

    it('2.5: excludes binary files (.png, .zip) from all analyzers', () => {
      expect(getApplicableAnalyzers('assets/logo.png', fullConfig)).toHaveLength(0);
      expect(getApplicableAnalyzers('vendor/archive.zip', fullConfig)).toHaveLength(0);
      expect(getApplicableAnalyzers('docs/spec.pdf', fullConfig)).toHaveLength(0);
    });

    it('2.5b: excludes .wasm binary files from all analyzers including gitleaks', () => {
      expect(getApplicableAnalyzers('wasm/module.wasm', fullConfig)).toHaveLength(0);
      expect(getApplicableAnalyzers('build/optimized.WASM', fullConfig)).toHaveLength(0);
    });
  });

  // ===========================================================================
  // SUITE 3: BOUNDARY & FAIL-SOFT RESILIENCE
  // ===========================================================================
  describe('Suite 3: Robustness & Boundary Fail-Soft Mechanics', () => {
    it('3.1: records available: false and exitStatus: "not_installed" when binary returns ENOENT', async () => {
      mockRunner.onCommand('eslint', {
        exitStatus: 'error',
        stderr: 'spawn eslint ENOENT: binary not found in PATH',
      });

      const summary = await runPreCheckAnalyzers({
        workspaceRoot: defaultWorkspace,
        changedFiles: ['src/app.ts'],
        config: fullConfig,
        sandboxRunner: mockRunner,
      });

      const receipt = summary.receipts.find((r) => r.tool === 'eslint');
      expect(receipt).toBeDefined();
      expect(receipt?.available).toBe(false);
      expect(receipt?.exitStatus).toBe('not_installed');
      expect(receipt?.hypotheses).toHaveLength(0);
    });

    it('3.2: records exitStatus: "timeout" and proceeds when analyzer command times out', async () => {
      mockRunner.onCommand('semgrep', {
        exitStatus: 'timeout',
        stdout: '',
        stderr: 'Execution exceeded timeout limit (15000ms)',
      });

      const summary = await runPreCheckAnalyzers({
        workspaceRoot: defaultWorkspace,
        changedFiles: ['src/app.ts'],
        config: fullConfig,
        sandboxRunner: mockRunner,
      });

      const semgrepReceipt = summary.receipts.find((r) => r.tool === 'semgrep');
      expect(semgrepReceipt?.exitStatus).toBe('timeout');
      expect(semgrepReceipt?.hypotheses).toHaveLength(0);
      // Ensure other tools still executed
      expect(summary.analyzersExecuted).toBeGreaterThan(1);
    });

    it('3.3: treats linter exit code 1 as successful finding harvest rather than fatal crash', async () => {
      const eslintFinding = JSON.stringify([
        {
          filePath: '/workspace/src/app.ts',
          messages: [{ ruleId: 'semi', severity: 2, message: 'Missing semicolon.', line: 10 }],
        },
      ]);

      mockRunner.onCommand('eslint', {
        exitStatus: 1, // Exit code 1 indicates lint errors found
        stdout: eslintFinding,
      });

      const summary = await runPreCheckAnalyzers({
        workspaceRoot: defaultWorkspace,
        changedFiles: ['src/app.ts'],
        config: fullConfig,
        sandboxRunner: mockRunner,
      });

      const receipt = summary.receipts.find((r) => r.tool === 'eslint');
      expect(receipt?.exitStatus).toBe(1);
      expect(receipt?.hypotheses).toHaveLength(1);
      expect(receipt?.hypotheses[0].ruleId).toBe('semi');
    });

    it('3.4: handles fatal linter crash (exit code 2+ or syntax error) gracefully with 0 hypotheses', async () => {
      mockRunner.onCommand('eslint', {
        exitStatus: 2, // Exit code 2 indicates configuration or syntax crash
        stdout: '',
        stderr: 'Parsing error: Unexpected token (1:1)',
      });

      const summary = await runPreCheckAnalyzers({
        workspaceRoot: defaultWorkspace,
        changedFiles: ['src/app.ts'],
        config: fullConfig,
        sandboxRunner: mockRunner,
      });

      const receipt = summary.receipts.find((r) => r.tool === 'eslint');
      expect(receipt?.exitStatus).toBe('error');
      expect(receipt?.hypotheses).toHaveLength(0);
    });

    it('3.5: catches truncated or corrupted JSON output without throwing unhandled SyntaxError', async () => {
      mockRunner.onCommand('semgrep', {
        exitStatus: 0,
        stdout: '[{"check_id": "sqli", "start": { "line": 15', // truncated mid-JSON
      });

      let summary: PreCheckSummary | null = null;
      await expect((async () => {
        summary = await runPreCheckAnalyzers({
          workspaceRoot: defaultWorkspace,
          changedFiles: ['src/app.ts'],
          config: fullConfig,
          sandboxRunner: mockRunner,
        });
      })()).resolves.not.toThrow();

      expect(summary?.hypotheses.filter((h) => h.analyzer === 'semgrep')).toHaveLength(0);
    });

    it('3.6: skips execution cleanly with 0 commands when changedFiles list is empty', async () => {
      const summary = await runPreCheckAnalyzers({
        workspaceRoot: defaultWorkspace,
        changedFiles: [],
        config: fullConfig,
        sandboxRunner: mockRunner,
      });

      expect(summary.analyzersExecuted).toBe(0);
      expect(summary.hypothesesCount).toBe(0);
      expect(mockRunner.executedCommands).toHaveLength(0);
    });

    it('3.7: skips deleted files and filters them out from tool invocation', async () => {
      await runPreCheckAnalyzers({
        workspaceRoot: defaultWorkspace,
        changedFiles: [
          { path: 'src/deleted.ts', status: 'deleted' },
          { path: 'src/active.ts', status: 'modified' },
        ],
        config: fullConfig,
        sandboxRunner: mockRunner,
      });

      for (const cmd of mockRunner.executedCommands) {
        expect(cmd.args).not.toContain('src/deleted.ts');
        if (cmd.command.includes('eslint')) {
          expect(cmd.args).toContain('src/active.ts');
        }
      }
    });
  });

  // ===========================================================================
  // SUITE 4: CONFIGURATION SWITCHES INTEGRATION
  // ===========================================================================
  describe('Suite 4: Configuration Switches & Granular Toggles', () => {
    it('4.1: bypasses analyzer execution completely when pre_checks.analyzers.enabled: false', async () => {
      const summary = await runPreCheckAnalyzers({
        workspaceRoot: defaultWorkspace,
        changedFiles: ['src/app.ts'],
        config: { enabled: false, linters: true, security: true, secrets: true },
        sandboxRunner: mockRunner,
      });

      expect(summary.enabled).toBe(false);
      expect(summary.analyzersExecuted).toBe(0);
      expect(summary.hypothesesCount).toBe(0);
      expect(mockRunner.executedCommands).toHaveLength(0);
    });

    it('4.2: selective switch linters: false disables eslint, credo, and govet while running semgrep and gitleaks', async () => {
      await runPreCheckAnalyzers({
        workspaceRoot: defaultWorkspace,
        changedFiles: ['src/app.ts', 'pkg/main.go'],
        config: { enabled: true, linters: false, security: true, secrets: true },
        sandboxRunner: mockRunner,
      });

      const commands = mockRunner.executedCommands.map((c) => c.command);
      expect(commands.some((c) => c.includes('eslint'))).toBe(false);
      expect(commands.some((c) => c.includes('govet'))).toBe(false);
      expect(commands.some((c) => c.includes('semgrep'))).toBe(true);
      expect(commands.some((c) => c.includes('gitleaks'))).toBe(true);
    });

    it('4.3: selective switch security: false disables semgrep and sobelow while running linters and gitleaks', async () => {
      await runPreCheckAnalyzers({
        workspaceRoot: defaultWorkspace,
        changedFiles: ['src/app.ts', 'lib/server.ex'],
        config: { enabled: true, linters: true, security: false, secrets: true, heavy_compilers: true },
        sandboxRunner: mockRunner,
      });

      const commands = mockRunner.executedCommands.map((c) => c.command);
      expect(commands.some((c) => c.includes('semgrep'))).toBe(false);
      expect(commands.some((c) => c.includes('sobelow'))).toBe(false);
      expect(commands.some((c) => c.includes('eslint'))).toBe(true);
      expect(commands.some((c) => c.includes('credo'))).toBe(true);
    });

    it('4.4: selective switch secrets: false disables gitleaks while preserving linters and security', async () => {
      await runPreCheckAnalyzers({
        workspaceRoot: defaultWorkspace,
        changedFiles: ['src/app.ts'],
        config: { enabled: true, linters: true, security: true, secrets: false },
        sandboxRunner: mockRunner,
      });

      const commands = mockRunner.executedCommands.map((c) => c.command);
      expect(commands.some((c) => c.includes('gitleaks'))).toBe(false);
      expect(commands.some((c) => c.includes('eslint'))).toBe(true);
      expect(commands.some((c) => c.includes('semgrep'))).toBe(true);
    });
  });

  // ===========================================================================
  // SUITE 5: PERSONA PROMPT FORMATTING & VERIFICATION INSTRUCTIONS
  // ===========================================================================
  describe('Suite 5: Persona Prompt Formatting & Verification Instructions', () => {
    it('5.1: formats candidate hypotheses into structured prompt with verification instructions', () => {
      const hypotheses: CandidateHypothesis[] = [
        {
          id: 'hyp:semgrep:sql-injection:src/db.ts:18',
          analyzer: 'semgrep',
          category: 'security',
          ruleId: 'sql-injection',
          path: 'src/db.ts',
          line: 18,
          message: 'Potential SQL injection detected.',
          severity: 'error',
          confidence: 'high',
        },
      ];

      const prompt = formatCandidateHypothesesPrompt(hypotheses);
      expect(prompt).toContain('=== DETERMINISTIC STATIC ANALYSIS PRE-CHECK HYPOTHESES (UNVERIFIED) ===');
      expect(prompt).toContain('Verify or refute each hypothesis during your review turns');
      expect(prompt).toContain('Do NOT publish raw hypotheses directly');
      expect(prompt).toContain('hyp:semgrep:sql-injection:src/db.ts:18');
      expect(prompt).toContain('src/db.ts:18');
      expect(prompt).toContain('ERROR');
    });

    it('5.2: returns empty string when candidate hypotheses list is empty', () => {
      expect(formatCandidateHypothesesPrompt([])).toBe('');
      expect(formatCandidateHypothesesPrompt(null)).toBe('');
      expect(formatCandidateHypothesesPrompt(undefined)).toBe('');
    });

    it('5.3: formats status clean and status unavailable for PreCheckSummary objects', () => {
      const cleanSummary: PreCheckSummary = {
        enabled: true,
        analyzersExecuted: 2,
        hypothesesCount: 0,
        receipts: [],
        hypotheses: [],
        status: 'clean',
      };
      expect(formatCandidateHypothesesPrompt(cleanSummary)).toContain('[Status: clean]');

      const unavailSummary: PreCheckSummary = {
        enabled: true,
        analyzersExecuted: 0,
        hypothesesCount: 0,
        receipts: [],
        hypotheses: [],
        status: 'unavailable',
      };
      expect(formatCandidateHypothesesPrompt(unavailSummary)).toContain('[Status: unavailable]');
    });

    it('5.4: formatCandidateHypothesesEvidence alias produces identical prompt', () => {
      const hypotheses: CandidateHypothesis[] = [
        {
          id: 'hyp:eslint:semi:src/index.ts:1',
          analyzer: 'eslint',
          category: 'linter',
          ruleId: 'semi',
          path: 'src/index.ts',
          line: 1,
          message: 'Missing semicolon',
          severity: 'warning',
          confidence: 'high',
        },
      ];
      expect(formatCandidateHypothesesEvidence(hypotheses)).toBe(formatCandidateHypothesesPrompt(hypotheses));
    });
  });

  // ===========================================================================
  // SUITE 6: PERSONA LANE SCOPING & PROMPT BUDGETING
  // ===========================================================================
  describe('Suite 6: Persona Lane Domain Scoping & Budgeting', () => {
    const sampleHypotheses: CandidateHypothesis[] = [
      {
        id: 'hyp:eslint:no-unused:src/app.ts:10',
        analyzer: 'eslint',
        category: 'linter',
        ruleId: 'no-unused',
        path: 'src/app.ts',
        line: 10,
        message: 'unused var',
        severity: 'warning',
        confidence: 'high',
      },
      {
        id: 'hyp:semgrep:xss:src/app.ts:20',
        analyzer: 'semgrep',
        category: 'security',
        ruleId: 'xss',
        path: 'src/app.ts',
        line: 20,
        message: 'xss vulnerability',
        severity: 'error',
        confidence: 'high',
      },
      {
        id: 'hyp:gitleaks:api-key:config/secrets.env:5',
        analyzer: 'gitleaks',
        category: 'secrets',
        ruleId: 'api-key',
        path: 'config/secrets.env',
        line: 5,
        message: 'leaked key',
        severity: 'critical',
        confidence: 'high',
      },
      {
        id: 'hyp:sobelow:sql_injection:lib/repo.ex:30',
        analyzer: 'sobelow',
        category: 'security',
        ruleId: 'sql_injection',
        path: 'lib/repo.ex',
        line: 30,
        message: 'SQL Injection detected',
        severity: 'error',
        confidence: 'high',
      },
    ];

    it('6.1: sec-lane receives security and secrets hypotheses matching scoped files', () => {
      const filtered = filterHypothesesForPersona({
        hypotheses: sampleHypotheses,
        personaId: 'sec-lane',
        charter: 'builtin:security',
        scopedFiles: [{ path: 'src/app.ts' }, { path: 'config/secrets.env' }],
      });

      expect(filtered.map((h) => h.category)).toEqual(['secrets', 'security']);
      expect(filtered.some((h) => h.category === 'linter')).toBe(false);
      expect(filtered.some((h) => h.path === 'lib/repo.ex')).toBe(false);
    });

    it('6.2: qual-lane receives linter hypotheses only', () => {
      const filtered = filterHypothesesForPersona({
        hypotheses: sampleHypotheses,
        personaId: 'qual-lane',
        charter: 'builtin:consistency',
        scopedFiles: [{ path: 'src/app.ts' }],
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('hyp:eslint:no-unused:src/app.ts:10');
    });

    it('6.3: db-lane receives SQL-related security hypotheses only', () => {
      const filtered = filterHypothesesForPersona({
        hypotheses: sampleHypotheses,
        personaId: 'db-lane',
        charter: 'builtin:database',
        scopedFiles: [{ path: 'src/app.ts' }, { path: 'lib/repo.ex' }],
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].ruleId).toBe('sql_injection');
    });

    it('6.4: enforces 20 hypotheses prompt cap and prioritizes secrets > security > linter', () => {
      const manyHypotheses: CandidateHypothesis[] = [];
      for (let i = 0; i < 30; i++) {
        manyHypotheses.push({
          id: `hyp:eslint:rule-${i}:src/app.ts:${i + 1}`,
          analyzer: 'eslint',
          category: 'linter',
          ruleId: `rule-${i}`,
          path: 'src/app.ts',
          line: i + 1,
          message: `Issue ${i}`,
          severity: 'warning',
          confidence: 'medium',
        });
      }
      manyHypotheses.push({
        id: 'hyp:gitleaks:critical-secret:src/app.ts:99',
        analyzer: 'gitleaks',
        category: 'secrets',
        ruleId: 'secret-leak',
        path: 'src/app.ts',
        line: 99,
        message: 'Critical secret leak',
        severity: 'critical',
        confidence: 'high',
      });

      const filtered = filterHypothesesForPersona({
        hypotheses: manyHypotheses,
        personaId: 'general-lane',
        charter: 'general review',
        scopedFiles: [{ path: 'src/app.ts' }],
      });

      expect(filtered).toHaveLength(20);
      // The secret must be sorted first due to category prioritization
      expect(filtered[0].id).toBe('hyp:gitleaks:critical-secret:src/app.ts:99');
    });
  });
});
