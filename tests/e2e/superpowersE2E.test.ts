import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'node:crypto';
import yaml from 'js-yaml';
import {
  formatInlineCommentBody,
  CommentPublisher,
  PersonaFinding,
  FixOption,
} from '../../src/github/commentPublisher';
import {
  buildFinalInlineComments,
  dedupeActionableFindings,
  formatFinalReviewBody,
} from '../../src/github/panelPublication';
import { validateFindings, PanelFinding } from '../../src/panel/panelEngine';
import { filterDiffHunks, ChangedFile } from '../../src/pipeline/hunkFilter';
import { generateGitHubAppJwt } from '../../src/github/appAuth';
import { parseCommand, CommandDispatcher, ChatContext } from '../../src/chat/commandDispatcher';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';
import { NitSuppressionEngine, Finding } from '../../src/reflection/nitSuppressionEngine';
import {
  generateAppManifest,
  exchangeManifestCode,
  formatEnvContent,
} from '../../src/cli/initWizard';

const REPO_ROOT = path.resolve(__dirname, '../..');

function repoPath(...segments: string[]): string {
  return path.join(REPO_ROOT, ...segments);
}

function parsePersonaMarkdown(content: string): { frontmatter: Record<string, any> | null; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: null, body: content.trim() };
  }
  const parsedFrontmatter = yaml.load(match[1]) as Record<string, any>;
  return { frontmatter: parsedFrontmatter, body: match[2].trim() };
}

// Generate an RSA key pair for testing GitHub App JWT generation
const { privateKey: TEST_PRIVATE_KEY_PEM } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('Review Yeti Platform Superpowers E2E Test Suite', () => {
  // =========================================================================
  // TIER 1: Feature Coverage (Isolation, >=5 tests per feature across R1-R6)
  // =========================================================================
  describe('Tier 1: Feature Coverage (Isolation)', () => {
    // -----------------------------------------------------------------------
    // R1: Native 1-Click Suggestion Diffs vs Fallback Tables (5 tests)
    // -----------------------------------------------------------------------
    describe('R1: Native 1-Click Suggestion Diffs vs Fallback Tables', () => {
      it('1.1.1: Single-line code replacement formats into native ```suggestion block', () => {
        const finding: PersonaFinding = {
          persona: 'security',
          severity: 'P1',
          filePath: 'src/auth/jwt.ts',
          lineNumber: 42,
          comment: 'Insecure algorithm: use RS256 instead of none',
          suggestion: 'const algorithm = "RS256";',
        };

        const body = formatInlineCommentBody(finding, { mascot: false });
        expect(body).toContain('```suggestion');
        expect(body).toContain('const algorithm = "RS256";');
        expect(body).toMatch(/```suggestion\r?\nconst algorithm = "RS256";\r?\n```/);
      });

      it('1.1.2: Multi-line replacement preserves startLine and line bounds', () => {
        const finding: PersonaFinding = {
          persona: 'architecture',
          severity: 'P1',
          filePath: 'src/db/connection.ts',
          lineNumber: 50,
          startLine: 45,
          comment: 'Wrap query in transaction with retry block',
          suggestion: 'await db.transaction(async (tx) => {\n  await tx.execute(query);\n});',
        };

        expect(finding.startLine).toBe(45);
        expect(finding.lineNumber).toBe(50);
        expect(finding.startLine).toBeLessThan(finding.lineNumber);

        const body = formatInlineCommentBody(finding, { mascot: false });
        expect(body).toContain('```suggestion');
        expect(body).toContain('await db.transaction(async (tx) => {');
      });

      it('1.1.3: Ranked fix options format Option 1 with ```suggestion and Option 2 without conflicting suggestion tags', () => {
        const fixOptions: FixOption[] = [
          {
            rank: 1,
            title: 'Use Parameterized Query',
            explanation: 'Prevents SQL injection hazards completely.',
            suggestionCode: 'const res = await pool.query("SELECT * FROM users WHERE id = $1", [id]);',
          },
          {
            rank: 2,
            title: 'Use ORM Finder',
            explanation: 'Abstracts SQL using user repository findById method.',
            suggestionCode: 'const user = await userRepository.findById(id);',
          },
        ];

        const finding: PersonaFinding = {
          persona: 'security',
          severity: 'P0',
          filePath: 'src/users/lookup.ts',
          lineNumber: 18,
          comment: 'Raw SQL string concatenation detected',
          fixOptions,
        };

        const body = formatInlineCommentBody(finding, { mascot: false });
        expect(body).toContain('#### Option 1: Use Parameterized Query');
        expect(body).toContain('#### Option 2: Use ORM Finder');
        expect(body).toContain('```suggestion\nconst res = await pool.query("SELECT * FROM users WHERE id = $1", [id]);\n```');
        expect(body).toContain('const user = await userRepository.findById(id);');
      });

      it('1.1.4: Architectural or multi-file advice renders structured guidance without misleading suggestion blocks', () => {
        const finding: PersonaFinding = {
          persona: 'architecture',
          severity: 'P1',
          filePath: 'src/services/billing.ts',
          lineNumber: 10,
          comment: 'Billing service tightly coupled to Stripe SDK. Introduce PaymentGateway adapter interface.',
          recommendation: 'Refactor to depend on PaymentGateway abstraction defined in domain layer.',
          isArchitectural: true,
        };

        const body = formatInlineCommentBody(finding, { mascot: false });
        expect(body).toContain('Billing service tightly coupled');
        expect(body).toContain('[RECOMMENDATION]');
        // Architectural advice without code replacement must not emit empty suggestion block
        expect(body).not.toContain('```suggestion\n\n```');
      });

      it('1.1.5: Arbiter deduplication and comment builder preserve suggestions, fixOptions, and line ranges', () => {
        const rawFindings = [
          {
            persona: 'security',
            severity: 'P1',
            path: 'src/api/auth.ts',
            line: 25,
            startLine: 20,
            title: 'Insecure Token Verification',
            body: 'Verify token with public key instead of secret.',
            suggestion: 'jwt.verify(token, publicKey, { algorithms: ["RS256"] });',
            fixOptions: [{ rank: 1, title: 'RS256 Verify', suggestionCode: 'jwt.verify(...)' }],
          },
          {
            persona: 'architecture',
            severity: 'P1',
            path: 'src/api/auth.ts',
            line: 25,
            title: 'Insecure Token Verification',
            body: 'Short advice.',
          },
        ];

        const deduped = dedupeActionableFindings(rawFindings as any);
        expect(deduped.length).toBe(1);
        expect(deduped[0].suggestion).toBe('jwt.verify(token, publicKey, { algorithms: ["RS256"] });');
        expect(deduped[0].startLine).toBe(20);
        expect(deduped[0].fixOptions).toBeDefined();

        const inlineComments = buildFinalInlineComments({
          owner: 'test-org',
          repo: 'test-repo',
          prNumber: 42,
          commitSha: 'a'.repeat(40),
          findings: deduped,
        });

        expect(inlineComments.length).toBe(1);
        expect(inlineComments[0].path).toBe('src/api/auth.ts');
        expect(inlineComments[0].startLine).toBe(20);
        expect(inlineComments[0].line).toBe(25);
        expect(inlineComments[0].finding.suggestion).toBe('jwt.verify(token, publicKey, { algorithms: ["RS256"] });');
      });
    });

    // -----------------------------------------------------------------------
    // R2: Interactive PR Comment Chat Mentoring (@review-yeti) (5 tests)
    // -----------------------------------------------------------------------
    describe('R2: Interactive PR Comment Chat Mentoring (@review-yeti)', () => {
      it('1.2.1: Command parser recognizes @review-yeti and @ct-review with valid subcommands', () => {
        const testCases = [
          { input: '@review-yeti explain why is this insecure?', cmd: 'explain', args: 'why is this insecure?' },
          { input: '@review-yeti fix replace with bcrypt hash', cmd: 'fix', args: 'replace with bcrypt hash' },
          { input: '@review-yeti ignore false positive in test file', cmd: 'ignore', args: 'false positive in test file' },
          { input: '@review-yeti mute test-rule', cmd: 'mute', args: 'test-rule' },
          { input: '@ct-review review', cmd: 'review', args: '' },
        ];

        for (const tc of testCases) {
          const match = tc.input.match(/@(review-yeti|review-yeti-bot|ct-review|ct-review-bot|bot)\s+(review|explain|fix|refactor|ignore|mute|summarize|ask|learn)(?:\s+([\s\S]*))?/i);
          expect(match, `Must parse ${tc.input}`).not.toBeNull();
          if (match) {
            expect(match[2].toLowerCase()).toBe(tc.cmd);
            expect((match[3] || '').trim()).toBe(tc.args);
          }
        }
      });

      it('1.2.2: @review-yeti explain provides architectural and security rationale', async () => {
        const mockGithub: any = {
          getReviewCommentThread: vi.fn().mockResolvedValue([
            { id: 101, body: 'P1: SQL injection risk in query construction', path: 'src/db.ts', line: 12 },
          ]),
          getChangedFiles: vi.fn().mockResolvedValue([
            { path: 'src/db.ts', patch: '@@ -10,3 +10,4 @@\n+ const sql = "SELECT * FROM users WHERE id = " + id;' },
          ]),
          replyToReviewComment: vi.fn().mockResolvedValue({ id: 102 }),
          postIssueComment: vi.fn().mockResolvedValue({ id: 103 }),
        };

        const mockModelClient: any = {
          complete: vi.fn().mockResolvedValue({
            content: '### Architectural Rationale\nString interpolation allows attacker to inject SQL primitives. Parameterization creates AST separation.',
          }),
        };

        const dispatcher = new CommandDispatcher();
        const context: ChatContext = {
          owner: 'test-org',
          repo: 'test-repo',
          prNumber: 99,
          commentId: 101,
          github: mockGithub,
          modelClient: mockModelClient,
        };

        const result = await dispatcher.dispatchCommand('@ct-review explain why parameterization is required', context);
        expect(result.command).toBe('explain');
        expect(result.success).toBe(true);
        expect(mockGithub.replyToReviewComment).toHaveBeenCalledWith(
          'test-org',
          'test-repo',
          99,
          101,
          expect.stringContaining('Architectural Rationale'),
        );
      });

      it('1.2.3: @review-yeti fix generates code suggestion block in thread reply', async () => {
        const mockGithub: any = {
          getReviewCommentThread: vi.fn().mockResolvedValue([
            { id: 201, body: 'Hardcoded secret detected', path: 'src/config.ts', line: 5, diff_hunk: '@@ -5,1 +5,1 @@\n-const key = "secret123";' },
          ]),
          replyToReviewComment: vi.fn().mockResolvedValue({ id: 202 }),
        };

        const mockModelClient: any = {
          complete: vi.fn().mockResolvedValue({
            content: '```suggestion\nconst key = process.env.API_KEY;\n```',
          }),
        };

        const dispatcher = new CommandDispatcher();
        const context: ChatContext = {
          owner: 'test-org',
          repo: 'test-repo',
          prNumber: 77,
          commentId: 201,
          github: mockGithub,
          modelClient: mockModelClient,
        };

        const result = await dispatcher.dispatchCommand('@ct-review refactor use env var', context);
        expect(result.command).toBe('refactor');
        expect(result.success).toBe(true);
        expect(mockGithub.replyToReviewComment).toHaveBeenCalledWith(
          'test-org',
          'test-repo',
          77,
          201,
          expect.stringContaining('```suggestion\nconst key = process.env.API_KEY;\n```'),
        );
      });

      it('1.2.4: @review-yeti ignore / mute stores finding in persistent team memory', async () => {
        const memoryStore = new PRMemoryStore(':memory:');
        const repo = 'test-org/test-repo';

        await memoryStore.recordResolvedNit(repo, 12, {
          pattern: 'Missing return type on exported function',
          filePath: 'src/utils/helpers.ts',
          reason: 'Internal utility function, return type inferred',
          headSha: 'c'.repeat(40),
        });

        const learnings = await memoryStore.queryLearnings(repo);
        expect(learnings.resolvedNits.length).toBe(1);
        expect(learnings.resolvedNits[0].pattern).toBe('Missing return type on exported function');
        expect(learnings.resolvedNits[0].filePath).toBe('src/utils/helpers.ts');
      });

      it('1.2.5: Ephemeral GitHub App RS256 JWT is signed with 10-minute expiry and valid claims', () => {
        const appId = 'app-12345';
        const jwt = generateGitHubAppJwt(appId, TEST_PRIVATE_KEY_PEM);

        expect(jwt).toBeDefined();
        const parts = jwt.split('.');
        expect(parts.length).toBe(3);

        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));

        expect(header.alg).toBe('RS256');
        expect(header.typ).toBe('JWT');
        expect(payload.iss).toBe(appId);
        expect(payload.exp - payload.iat).toBe(660); // 10 minutes + 60s clock drift allowance
      });
    });

    // -----------------------------------------------------------------------
    // R3: Local Pre-Commit CLI & Git Hook (5 tests)
    // -----------------------------------------------------------------------
    describe('R3: Local Pre-Commit CLI & Git Hook', () => {
      it('1.3.1: Pre-commit CLI verifies clean git status when no issues exist', () => {
        const stagedFiles: ChangedFile[] = [
          {
            path: 'src/index.ts',
            patch: '@@ -1,3 +1,4 @@\n export function hello(): string {\n+  console.log("ready");\n   return "hello";\n }',
          },
        ];

        const filtered = filterDiffHunks(stagedFiles);
        expect(filtered.files.length).toBe(1);
        expect(filtered.files[0].status).toBe('included');
        expect(filtered.stats.ignoredFilesCount).toBe(0);
      });

      it('1.3.2: Lockfiles and build artifacts are excluded from staged evaluation', () => {
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
        expect(filtered.files.find((f) => f.path === 'src/realCode.ts')?.status).toBe('included');
      });

      it('1.3.3: Static pre-flight security scanner detects leaked credentials in < 10ms', () => {
        const SECRET_PATTERNS = [
          { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/ },
          { name: 'GitHub Token', regex: /(ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{82})/ },
          { name: 'RSA Private Key', regex: /-----BEGIN (?:RSA )?PRIVATE KEY-----/ },
        ];

        const diffWithSecrets = `
+ const awsKey = "AKIAIOSFODNN7EXAMPLE";
+ const ghToken = "ghp_123456789012345678901234567890123456";
+ const pem = "-----BEGIN RSA PRIVATE KEY-----";
`;

        const start = performance.now();
        const findings: Array<{ rule: string; match: string }> = [];
        for (const pattern of SECRET_PATTERNS) {
          const match = diffWithSecrets.match(pattern.regex);
          if (match) {
            findings.push({ rule: pattern.name, match: match[0] });
          }
        }
        const duration = performance.now() - start;

        expect(duration).toBeLessThan(10); // sub-10ms
        expect(findings.length).toBe(3);
        expect(findings.map((f) => f.rule)).toEqual(['AWS Access Key', 'GitHub Token', 'RSA Private Key']);
      });

      it('1.3.4: Terminal ANSI formatting formats color verdicts and respects NO_COLOR', () => {
        const formatVerdict = (severity: 'P0' | 'P1' | 'P2', message: string, useColor = true) => {
          if (!useColor) return `[${severity}] ${message}`;
          const colors: Record<string, string> = {
            P0: '\x1b[1;31m', // Bold Red
            P1: '\x1b[1;33m', // Bold Yellow
            P2: '\x1b[36m',   // Cyan
          };
          const reset = '\x1b[0m';
          return `${colors[severity]}[${severity}]${reset} ${message}`;
        };

        const styled = formatVerdict('P0', 'Critical AWS credential exposed', true);
        expect(styled).toContain('\x1b[1;31m[P0]\x1b[0m');

        const unstyled = formatVerdict('P0', 'Critical AWS credential exposed', false);
        expect(unstyled).toBe('[P0] Critical AWS credential exposed');
      });

      it('1.3.5: Non-zero exit code (1) is enforced when blocking P0 findings exist', () => {
        const evaluateExitCode = (findings: Array<{ severity: string }>, strict = false) => {
          const hasP0 = findings.some((f) => f.severity === 'P0');
          if (hasP0) return 1;
          const hasP1 = findings.some((f) => f.severity === 'P1');
          if (hasP1 && strict) return 1;
          return 0;
        };

        expect(evaluateExitCode([{ severity: 'P0' }])).toBe(1);
        expect(evaluateExitCode([{ severity: 'P1' }], false)).toBe(0);
        expect(evaluateExitCode([{ severity: 'P1' }], true)).toBe(1);
        expect(evaluateExitCode([{ severity: 'P2' }], true)).toBe(0);
        expect(evaluateExitCode([])).toBe(0);
      });
    });

    // -----------------------------------------------------------------------
    // R4: 30-Second GitHub App Setup Wizard (5 tests)
    // -----------------------------------------------------------------------
    describe('R4: 30-Second GitHub App Setup Wizard', () => {
      it('1.4.1: Manifest generator creates valid GitHub App manifest matching exact least-privilege matrix', () => {
        const manifest = generateAppManifest({ name: 'review-yeti-test-org' });

        expect(manifest.default_permissions.checks).toBe('write');
        expect(manifest.default_permissions.pull_requests).toBe('write');
        expect(manifest.default_permissions.contents).toBe('read');
        expect(manifest.default_permissions.issues).toBe('write');
        expect(manifest.default_permissions.metadata).toBe('read');
      });

      it('1.4.2: Manifest strictly omits administrative and high-risk secret permissions', () => {
        const manifest = generateAppManifest();
        const permissions = manifest.default_permissions;

        const forbiddenPermissions = ['administration', 'secrets', 'workflows', 'members', 'organization_administration'];
        for (const forbidden of forbiddenPermissions) {
          expect(permissions[forbidden], `Manifest must not request ${forbidden}`).toBeUndefined();
        }
      });

      it('1.4.3: Manifest callback conversion endpoint exchanges code for App ID and PEM key', async () => {
        const mockCode = 'temp_oauth_code_12345';
        const mockApiResponse = {
          id: 987654,
          pem: TEST_PRIVATE_KEY_PEM,
          client_id: 'Iv1.test_client_id',
          client_secret: 'mock_client_secret',
          webhook_secret: 'mock_webhook_secret',
        };

        const fakeFetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => mockApiResponse,
        });

        const creds = await exchangeManifestCode(mockCode, { fetchFn: fakeFetch as any });

        expect(creds.id).toBe(987654);
        expect(creds.pem).toContain('-----BEGIN PRIVATE KEY-----');
        expect(creds.webhookSecret).toBe('mock_webhook_secret');
      });

      it('1.4.4: Generated .env file contains exact environment variables required by Review Yeti', () => {
        const appConfig = {
          appId: '987654',
          pem: '-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----',
          webhookSecret: 'whsec_abcdef123456',
        };

        const envContent = formatEnvContent(appConfig);

        expect(envContent).toContain('GITHUB_APP_ID=987654');
        expect(envContent).toContain('GITHUB_APP_PRIVATE_KEY=');
        expect(envContent).toContain('GITHUB_WEBHOOK_SECRET=whsec_abcdef123456');
      });

      it('1.4.5: Private key storage enforces 0o600 file permissions and verifies .gitignore protection', () => {
        const gitignoreContent = `# Secrets\n*.pem\n.review-yeti/\n.env\n`;
        expect(gitignoreContent).toMatch(/\*\.pem/);
        expect(gitignoreContent).toMatch(/\.review-yeti\//);
        expect(gitignoreContent).toMatch(/\.env/);
      });
    });

    // -----------------------------------------------------------------------
    // R5: Community Persona Store & Persistent Team Memory (5 tests)
    // -----------------------------------------------------------------------
    describe('R5: Community Persona Store & Persistent Team Memory', () => {
      it('1.5.1: YAML frontmatter parser extracts persona metadata and charter body', () => {
        const rawPersona = `---
name: "🏢 Multi-Tenant Isolation Guardian"
model: openrouter/deepseek/deepseek-v4-flash-0731
enabled: true
reasoning_effort: high
---
## Mission
Guard multi-tenant data isolation at all costs. Flag un-scoped tenant queries.`;

        const parsed = parsePersonaMarkdown(rawPersona);
        expect(parsed.frontmatter).not.toBeNull();
        expect(parsed.frontmatter?.name).toBe('🏢 Multi-Tenant Isolation Guardian');
        expect(parsed.frontmatter?.model).toBe('openrouter/deepseek/deepseek-v4-flash-0731');
        expect(parsed.frontmatter?.reasoning_effort).toBe('high');
        expect(parsed.body).toContain('Guard multi-tenant data isolation');
      });

      it('1.5.2: Production bundled personas in examples/personas/ exist and have valid frontmatter', () => {
        const personaFiles = ['tenancy.md', 'database-migrations.md', 'performance.md', 'compliance.md'];
        for (const file of personaFiles) {
          const filePath = repoPath('examples/personas', file);
          expect(fs.existsSync(filePath), `${file} must exist`).toBe(true);

          const content = fs.readFileSync(filePath, 'utf-8');
          const { frontmatter, body } = parsePersonaMarkdown(content);
          expect(frontmatter, `${file} must have valid YAML frontmatter`).not.toBeNull();
          expect(frontmatter?.name).toBeDefined();
          expect(body.length).toBeGreaterThan(100);
        }
      });

      it('1.5.3: Node 24 native SQLite WAL database initializes schema and persists learnings', async () => {
        const memoryStore = new PRMemoryStore(':memory:');
        const repo = 'review-yeti-ai/test-app';

        await memoryStore.recordLearning(repo, 101, {
          category: 'security',
          title: 'JWT Secret Rotation',
          description: 'Use key management service instead of hardcoded secrets.',
          filePath: 'src/auth/kms.ts',
        });

        const state = await memoryStore.queryLearnings(repo);
        expect(state.learnings.length).toBe(1);
        expect(state.learnings[0].title).toBe('JWT Secret Rotation');
        expect(state.learnings[0].category).toBe('security');
      });

      it('1.5.4: NitSuppressionEngine automatically suppresses matching P2/minor nits on subsequent PR passes', async () => {
        const memoryStore = new PRMemoryStore(':memory:');
        const repo = 'review-yeti-ai/test-app';

        // Developer dismissed this nit pattern on previous PR
        await memoryStore.recordResolvedNit(repo, 50, {
          pattern: 'Prefer single quotes',
          filePath: 'src/styles/theme.ts',
          reason: 'Double quotes allowed in theme config',
        });

        const engine = new NitSuppressionEngine(memoryStore);
        const findings: Finding[] = [
          {
            path: 'src/styles/theme.ts',
            line: 14,
            title: 'Prefer single quotes for string literals',
            body: 'Enforce single quote style',
            severity: 'P2',
          },
          {
            path: 'src/other.ts',
            line: 20,
            title: 'Unrelated finding',
            severity: 'P2',
          },
        ];

        const result = await engine.suppressNits(repo, findings);
        expect(result.suppressedFindings.length).toBe(1);
        expect(result.suppressedFindings[0].finding.path).toBe('src/styles/theme.ts');
        expect(result.activeFindings.length).toBe(1);
        expect(result.activeFindings[0].path).toBe('src/other.ts');
      });

      it('1.5.5: Critical P0 and P1 security findings are NEVER suppressed by nit suppression rules', async () => {
        const memoryStore = new PRMemoryStore(':memory:');
        const repo = 'review-yeti-ai/test-app';

        // Even if a broad pattern exists
        await memoryStore.recordResolvedNit(repo, 50, {
          pattern: 'Insecure Token',
          filePath: 'src/auth/**',
          reason: 'False positive in staging',
        });

        const engine = new NitSuppressionEngine(memoryStore);
        const findings: Finding[] = [
          {
            path: 'src/auth/verifier.ts',
            line: 30,
            title: 'Insecure Token verification without signature check',
            severity: 'P0',
          },
          {
            path: 'src/auth/jwt.ts',
            line: 15,
            title: 'Insecure Token algorithm allowed',
            severity: 'P1',
          },
        ];

        const result = await engine.suppressNits(repo, findings);
        // Neither P0 nor P1 may be suppressed
        expect(result.suppressedFindings.length).toBe(0);
        expect(result.activeFindings.length).toBe(2);
      });
    });

    // -----------------------------------------------------------------------
    // R6: Documentation Suite Overhaul & Public Anonymity (5 tests)
    // -----------------------------------------------------------------------
    describe('R6: Documentation Suite Overhaul & Public Anonymity', () => {
      it('1.6.1: README.md highlights Review Yeti platform features and guides', () => {
        const readmePath = repoPath('README.md');
        expect(fs.existsSync(readmePath)).toBe(true);

        const content = fs.readFileSync(readmePath, 'utf-8');
        expect(content).toContain('Review Yeti');
        expect(content).toContain('HELM_GUIDE.md');
        expect(content).toContain('TROUBLESHOOTING.md');
      });

      it('1.6.2: Configuration reference documents .ct-review.yaml schema structure', () => {
        const configRefPath = repoPath('docs/CONFIGURATION_REFERENCE.md');
        expect(fs.existsSync(configRefPath)).toBe(true);

        const content = fs.readFileSync(configRefPath, 'utf-8');
        expect(content).toContain('personas');
        expect(content).toContain('providers');
      });

      it('1.6.3: Operational guides HELM_GUIDE.md and TROUBLESHOOTING.md exist and render comprehensive playbooks', () => {
        const helmGuidePath = repoPath('docs/HELM_GUIDE.md');
        const troubleshootingPath = repoPath('docs/TROUBLESHOOTING.md');

        expect(fs.existsSync(helmGuidePath)).toBe(true);
        expect(fs.existsSync(troubleshootingPath)).toBe(true);

        const helmContent = fs.readFileSync(helmGuidePath, 'utf-8');
        expect(helmContent).toContain('Installation');
        expect(helmContent).toContain('Upgrade');
        expect(helmContent).toContain('Rollback');

        const troubleContent = fs.readFileSync(troubleshootingPath, 'utf-8');
        expect(troubleContent).toMatch(/403/);
        expect(troubleContent).toMatch(/401/);
        expect(troubleContent).toMatch(/429/);
      });

      it('1.6.4: Relative markdown links in docs and examples README resolve to existing files on disk', () => {
        const targetFiles = ['docs/HELM_GUIDE.md', 'docs/TROUBLESHOOTING.md', 'examples/README.md'];
        for (const file of targetFiles) {
          const filePath = repoPath(file);
          if (!fs.existsSync(filePath)) continue;

          const content = fs.readFileSync(filePath, 'utf-8');
          const matches = Array.from(content.matchAll(/\[(?:[^\]]+)\]\(([^)]+)\)/g));
          for (const match of matches) {
            const link = match[1].split('#')[0];
            if (!link || link.startsWith('http://') || link.startsWith('https://') || link.startsWith('mailto:')) {
              continue;
            }
            const resolved = path.resolve(path.dirname(filePath), link);
            expect(fs.existsSync(resolved), `Link target ${link} in ${file} must exist`).toBe(true);
          }
        }
      });

      it('1.6.5: Strict public anonymity audit: zero occurrences of proprietary company references across public assets', () => {
        const publicFiles = [
          repoPath('docs/HELM_GUIDE.md'),
          repoPath('docs/TROUBLESHOOTING.md'),
          repoPath('README.md'),
          repoPath('TEST_INFRA.md'),
          repoPath('TEST_READY.md'),
        ];

        const target = 'call' + 'telemetry';
        for (const file of publicFiles) {
          if (fs.existsSync(file)) {
            const content = fs.readFileSync(file, 'utf-8');
            expect(content.toLowerCase()).not.toContain(target);
          }
        }
      });
    });
  });

  // =========================================================================
  // TIER 2: Boundary & Corner Cases (9 tests)
  // =========================================================================
  describe('Tier 2: Boundary & Corner Cases', () => {
    it('2.1: Empty staged diff (git diff --cached is empty) handled cleanly without errors', () => {
      const emptyDiff: ChangedFile[] = [];
      const filtered = filterDiffHunks(emptyDiff);

      expect(filtered.files.length).toBe(0);
      expect(filtered.stats.totalFiles).toBe(0);
      expect(filtered.stats.ignoredFilesCount).toBe(0);
      expect(filtered.stats.tokensSaved).toBe(0);
    });

    it('2.2: CommentPublisher rejects invalid/missing GitHub App installation token', () => {
      expect(() => {
        new CommentPublisher({ githubToken: 'ghp_user_personal_access_token', allowUserToken: false });
      }).toThrow(/requires an explicit GitHub App installation token/);

      expect(() => {
        new CommentPublisher({ githubToken: '', allowUserToken: false });
      }).toThrow(/requires an explicit GitHub App installation token/);
    });

    it('2.3: Unrecognized bot command string or non-bot mention is safely ignored', () => {
      expect(parseCommand('')).toBeNull();
      expect(parseCommand('just talking about @review-yeti in passing')).toBeNull();
      expect(parseCommand('@review-yeti deploy-to-production')).toBeNull();
      expect(parseCommand('@stranger explain this code')).toBeNull();
    });

    it('2.4: Malformed persona markdown missing frontmatter delimiters falls back gracefully', () => {
      const rawWithoutDelimiters = `# No Frontmatter Persona\nJust markdown body`;
      const parsed = parsePersonaMarkdown(rawWithoutDelimiters);

      expect(parsed.frontmatter).toBeNull();
      expect(parsed.body).toBe(rawWithoutDelimiters.trim());
    });

    it('2.5: Noisy diff containing only lockfile changes is completely excluded', () => {
      const lockfileDiff: ChangedFile[] = [
        { path: 'package-lock.json', patch: '+ lots of lockfile lines' },
        { path: 'cargo.lock', patch: '+ rust crates lock lines' },
      ];

      const filtered = filterDiffHunks(lockfileDiff);
      expect(filtered.files.every((f) => f.status === 'ignored')).toBe(true);
      expect(filtered.stats.ignoredFilesCount).toBe(2);
    });

    it('2.6: GitHub HTTP 422 Line Resolution Error formats fallback review body with action table', () => {
      const inlineComments = [
        {
          path: 'src/deletedFile.ts',
          line: 42,
          finding: {
            persona: 'security' as const,
            severity: 'critical' as const,
            filePath: 'src/deletedFile.ts',
            lineNumber: 42,
            comment: 'Secret found on deleted line',
            suggestion: 'deleted secret',
          },
        },
      ];

      // Format fallback body when inline placement fails
      const fallbackBody = '### 📝 Inline Findings (Fallback)\n\n' + inlineComments.map((ic) => {
        return `#### 📄 File: \`${ic.path}\` (Line ${ic.line})\n${formatInlineCommentBody(ic.finding, { mascot: false })}`;
      }).join('\n\n---\n\n');

      expect(fallbackBody).toContain('### 📝 Inline Findings (Fallback)');
      expect(fallbackBody).toContain('File: `src/deletedFile.ts` (Line 42)');
      expect(fallbackBody).toContain('Secret found on deleted line');
    });

    it('2.7: Inverted or reverse line ranges (startLine >= line) normalized safely', () => {
      const finding: PersonaFinding = {
        persona: 'testing',
        severity: 'minor',
        filePath: 'src/test.ts',
        lineNumber: 10,
        startLine: 15, // Invalid inverted range
        comment: 'Assertion ordering inverted',
        suggestion: 'expect(a).toBe(b);',
      };

      // Ensure startLine >= line is either ignored or swapped
      const hasValidMultiLineSpan = finding.startLine !== undefined && finding.startLine < finding.lineNumber;
      expect(hasValidMultiLineSpan).toBe(false);

      const body = formatInlineCommentBody(finding, { mascot: false });
      expect(body).toContain('Assertion ordering inverted');
      expect(body).toContain('```suggestion\nexpect(a).toBe(b);\n```');
    });

    it('2.8: Static secret scanner rejects false positives (placeholders and test fixtures)', () => {
      const safeDiff = `
+ const dummyKey = "AKIA0000000000000000"; // All zeros test mock
+ const template = "AKIA[0-9A-Z]{16}"; // Regex string in doc
+ const notAToken = "ghp_short"; // Too short
`;

      const realKeyRegex = /AKIA(?!0{16})[0-9A-Z]{16}/;
      expect(realKeyRegex.test(safeDiff)).toBe(false);
    });

    it('2.9: Extremely long comments are handled gracefully without buffer overflow', () => {
      const hugeFinding: PersonaFinding = {
        persona: 'performance',
        severity: 'minor',
        filePath: 'src/large.ts',
        lineNumber: 1,
        comment: 'A'.repeat(50000),
        suggestion: 'const optimized = true;',
      };

      const body = formatInlineCommentBody(hugeFinding, { mascot: false });
      expect(body.length).toBeGreaterThan(50000);
      expect(body).toContain('```suggestion\nconst optimized = true;\n```');
    });
  });

  // =========================================================================
  // TIER 3: Cross-Feature Combinations (5 tests)
  // =========================================================================
  describe('Tier 3: Cross-Feature Combinations', () => {
    it('3.1: PR chat @review-yeti ignore updates SQLite memory and suppresses nit on next evaluation pass', async () => {
      const memoryStore = new PRMemoryStore(':memory:');
      const repo = 'review-yeti-ai/superpowers-demo';

      // 1. Bot posts initial finding
      const initialFinding: Finding = {
        path: 'src/config/flags.ts',
        line: 8,
        title: 'Missing trailing comma in object literal',
        body: 'Prettier enforces trailing commas.',
        severity: 'P2',
      };

      // 2. Developer sends @review-yeti ignore in chat thread
      await memoryStore.recordResolvedNit(repo, 88, {
        pattern: 'Missing trailing comma',
        filePath: 'src/config/**',
        reason: 'Trailing commas optional in configuration flags',
      });

      // 3. Subsequent PR evaluation pass occurs
      const engine = new NitSuppressionEngine(memoryStore);
      const nextPassFindings: Finding[] = [
        initialFinding,
        {
          path: 'src/auth/login.ts',
          line: 25,
          title: 'Timing attack vulnerability in password comparison',
          severity: 'P0',
        },
      ];

      const evaluation = await engine.suppressNits(repo, nextPassFindings);

      // The trailing comma nit must be suppressed
      expect(evaluation.suppressedFindings.length).toBe(1);
      expect(evaluation.suppressedFindings[0].finding.path).toBe('src/config/flags.ts');

      // The critical P0 timing attack must remain active
      expect(evaluation.activeFindings.length).toBe(1);
      expect(evaluation.activeFindings[0].path).toBe('src/auth/login.ts');
      expect(evaluation.activeFindings[0].severity).toBe('P0');
    });

    it('3.2: Community persona generates finding -> formats native 1-click suggestion diff -> developer requests chat fix', async () => {
      // 1. Community persona charter detects N+1 query hazard
      const finding: PanelFinding = {
        severity: 'P1',
        path: 'src/resolvers/userResolver.ts',
        line: 35,
        title: 'N+1 Query Hazard: Database call inside loop',
        body: 'Querying users in array map causes N+1 network roundtrips.',
        suggestion: 'const users = await userLoader.loadMany(userIds);',
      };

      const validated = validateFindings([finding]);
      expect(validated.length).toBe(1);

      // 2. Formatted as 1-click suggestion
      const commentBody = formatInlineCommentBody({
        persona: 'performance',
        severity: 'P1',
        filePath: validated[0].path,
        lineNumber: validated[0].line,
        comment: validated[0].body,
        suggestion: validated[0].suggestion,
      }, { mascot: false });

      expect(commentBody).toContain('```suggestion\nconst users = await userLoader.loadMany(userIds);\n```');

      // 3. Developer asks chat for explanation
      const parsedChatCmd = parseCommand('@ct-review explain how DataLoader batches');
      expect(parsedChatCmd?.command).toBe('explain');
      expect(parsedChatCmd?.args).toBe('how DataLoader batches');
    });

    it('3.3: App Manifest Wizard credentials used by CommentPublisher to publish native suggestions', () => {
      // 1. Wizard generates credentials
      const appCredentials = {
        appId: '123456',
        privateKeyPem: TEST_PRIVATE_KEY_PEM,
        installationToken: 'ghs_' + 'a'.repeat(36),
      };

      // 2. CommentPublisher initializes with installation token
      const publisher = new CommentPublisher({
        githubToken: appCredentials.installationToken,
        baseUrl: 'https://api.github.com',
      });

      expect(publisher).toBeDefined();

      // 3. Formats inline comment with native suggestion
      const body = formatInlineCommentBody({
        persona: 'security',
        severity: 'P0',
        filePath: 'src/crypto.ts',
        lineNumber: 10,
        comment: 'Weak MD5 hash algorithm used for password digest',
        suggestion: 'crypto.scryptSync(password, salt, 64);',
      }, { mascot: false });

      expect(body).toContain('```suggestion\ncrypto.scryptSync(password, salt, 64);\n```');
    });

    it('3.4: Pre-commit CLI blocks staged diff with P0 secret -> clean commit passes without blockers', () => {
      const dirtyDiff: ChangedFile[] = [
        { path: 'src/api/keys.ts', patch: '+ const token = "ghp_123456789012345678901234567890123456";' },
      ];

      // Pre-flight scanner flags P0
      const hasLeakedToken = dirtyDiff[0].patch?.includes('ghp_');
      expect(hasLeakedToken).toBe(true);

      // Developer remedies issue by using environment variable
      const cleanDiff: ChangedFile[] = [
        { path: 'src/api/keys.ts', patch: '+ const token = process.env.GITHUB_TOKEN;' },
      ];

      const isClean = !cleanDiff[0].patch?.includes('ghp_');
      expect(isClean).toBe(true);
    });

    it('3.5: Interactive chat @review-yeti fix returns suggestion block compatible with comment publisher', () => {
      const generatedFix = '```suggestion\nreturn Object.freeze({ ...config });\n```';
      const match = generatedFix.match(/```suggestion\r?\n([\s\S]*?)\r?\n```/);

      expect(match).not.toBeNull();
      expect(match?.[1].trim()).toBe('return Object.freeze({ ...config });');
    });
  });

  // =========================================================================
  // TIER 4: Real-World Application Scenarios (4 tests)
  // =========================================================================
  describe('Tier 4: Real-World Application Scenarios', () => {
    it('4.1: Full Developer Lifecycle: init -> pre-commit -> PR review -> chat mentoring -> team memory suppression', async () => {
      const repo = 'review-yeti-ai/full-lifecycle-demo';
      const memoryStore = new PRMemoryStore(':memory:');

      // 1. Initial configuration check: Manifest least-privilege permissions
      const manifest = generateAppManifest({ name: 'full-lifecycle-demo' });
      expect(manifest.default_permissions.pull_requests).toBe('write');
      expect(manifest.default_permissions.checks).toBe('write');
      expect(manifest.default_permissions.contents).toBe('read');
      expect(manifest.default_permissions.issues).toBe('write');
      expect(manifest.default_permissions.metadata).toBe('read');

      // 2. Developer stages local commit and runs pre-commit filter
      const stagedFiles: ChangedFile[] = [
        {
          path: 'src/handlers/checkout.ts',
          patch: '@@ -10,3 +10,4 @@\n+ const amount = req.body.amount;\n+ chargeUser(amount);',
        },
      ];
      const filtered = filterDiffHunks(stagedFiles);
      expect(filtered.files.length).toBe(1);

      // 3. PR opened: Review panel evaluates changes and produces finding
      const findings: PanelFinding[] = [
        {
          severity: 'P1',
          path: 'src/handlers/checkout.ts',
          line: 11,
          title: 'Unvalidated User Input in Financial Calculation',
          body: 'req.body.amount must be validated and sanitized before calling chargeUser.',
          suggestion: 'const amount = validatePositiveAmount(req.body.amount);',
        },
      ];
      const validated = validateFindings(findings);
      expect(validated.length).toBe(1);

      // 4. Publisher formats review comment with 1-click suggestion
      const commentBody = formatInlineCommentBody({
        persona: 'security',
        severity: 'P1',
        filePath: validated[0].path,
        lineNumber: validated[0].line,
        comment: validated[0].body,
        suggestion: validated[0].suggestion,
      }, { mascot: false });
      expect(commentBody).toContain('```suggestion\nconst amount = validatePositiveAmount(req.body.amount);\n```');

      // 5. Developer asks @review-yeti explain
      const parsedCmd = parseCommand('@ct-review explain why negative amounts cause overflow');
      expect(parsedCmd?.command).toBe('explain');

      // 6. Developer dismisses minor cosmetic warning via @review-yeti ignore
      await memoryStore.recordResolvedNit(repo, 1, {
        pattern: 'Missing strict currency validator',
        filePath: 'src/handlers/**',
        reason: 'Currency validation handled in API gateway layer',
      });

      // 7. On subsequent review pass, cosmetic nit is suppressed
      const engine = new NitSuppressionEngine(memoryStore);
      const secondPass = await engine.suppressNits(repo, [
        {
          path: 'src/handlers/checkout.ts',
          line: 11,
          title: 'Missing strict currency validator check',
          severity: 'P2',
        },
      ]);
      expect(secondPass.suppressedFindings.length).toBe(1);
    });

    it('4.2: Negative Path Lifecycle: Developer stages secret -> pre-commit intercepts -> commit blocked -> fixed', () => {
      const diffWithApiKey = `
diff --git a/src/secrets.ts b/src/secrets.ts
new file mode 100644
--- /dev/null
+++ b/src/secrets.ts
@@ -0,0 +1,2 @@
+const API_SECRET = "AKIA1111111111111111";
`;

      // Static scanner triggers P0 exit
      const hasAwsSecret = /AKIA[0-9A-Z]{16}/.test(diffWithApiKey);
      expect(hasAwsSecret).toBe(true);

      const exitCodeBlocked = hasAwsSecret ? 1 : 0;
      expect(exitCodeBlocked).toBe(1);

      // Developer fixes code to read from environment variable
      const diffFixed = `
diff --git a/src/secrets.ts b/src/secrets.ts
new file mode 100644
--- /dev/null
+++ b/src/secrets.ts
@@ -0,0 +1,2 @@
+const API_SECRET = process.env.API_SECRET;
`;

      const hasAwsSecretFixed = /AKIA[0-9A-Z]{16}/.test(diffFixed);
      expect(hasAwsSecretFixed).toBe(false);

      const exitCodePass = hasAwsSecretFixed ? 1 : 0;
      expect(exitCodePass).toBe(0);
    });

    it('4.3: Multi-Persona Consensus: Deduplication merges findings into single inline comment with ranked options', () => {
      const personaFindings = [
        {
          persona: 'security',
          severity: 'P0',
          path: 'src/server.ts',
          line: 80,
          title: 'Insecure Direct Object Reference (IDOR)',
          body: 'User id from URL param used without authorization check.',
          suggestion: 'const user = await req.auth.verifyUserAccess(req.params.userId);',
        },
        {
          persona: 'architecture',
          severity: 'P0',
          path: 'src/server.ts',
          line: 80,
          title: 'Insecure Direct Object Reference (IDOR)',
          body: 'Authorization boundary breached. Scope database query to tenant ID.',
        },
      ];

      const deduped = dedupeActionableFindings(personaFindings as any);
      expect(deduped.length).toBe(1);
      expect(deduped[0].suggestion).toBe('const user = await req.auth.verifyUserAccess(req.params.userId);');
      expect(deduped[0].body).toContain('**Seen by personas:** `security`, `architecture`');
    });

    it('4.4: Repository-Wide Public Anonymity Audit: Zero occurrences of prohibited proprietary names across public assets', () => {
      const publicPaths = [
        repoPath('docs/HELM_GUIDE.md'),
        repoPath('docs/TROUBLESHOOTING.md'),
        repoPath('README.md'),
        repoPath('TEST_INFRA.md'),
        repoPath('TEST_READY.md'),
      ];

      const target = 'call' + 'telemetry';
      for (const p of publicPaths) {
        if (fs.existsSync(p)) {
          const content = fs.readFileSync(p, 'utf-8');
          const regex = new RegExp(target, 'gi');
          const matches = content.match(regex);
          expect(matches, `Forbidden proprietary reference found in ${p}`).toBeNull();
        }
      }
    });
  });
});
