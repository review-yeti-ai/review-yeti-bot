import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildCompactFileList,
  buildCompactDiffManifest,
  buildDiffSection,
  computeDiffStats,
  executePersonaPanel,
  isRetryablePanelError,
  MAX_INLINE_DIFF_CHARS,
  PanelConfigurationError,
  validateFindings,
} from '../panelEngine';
import { OpenRouterResponseError, OpenRouterTimeoutError } from '../../gateway/openRouterClient';
import { OmniRouteClient } from '../../gateway/omniRouteClient';
import { parseAndValidateConfig } from '../../config/configLoader';
import { CtReviewConfigV3 } from '../../config/schema';

const mockYaml = `
version: 3
profile: balanced
quorum: 1
personas:
  - id: security
    charter: builtin:security
    providers: [codex]
    paths: ["**/*"]
    required: true
    enabled: true
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 30
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 5
      arbiter_timeout_s: 5
  arbiter:
    order: [codex]
`;

describe('PanelEngine (src/panel) — Exception Propagation & Fail-Closed Verification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rejects malformed findings instead of defaulting severity, path, line, or body', () => {
    expect(() => validateFindings([{
      severity: 'CRITICAL',
      path: '',
      line: 'not-a-line',
      title: '',
      body: '',
    }])).toThrow(/invalid findings contract.*severity/);
  });

  it('normalizes only valid finding values at the shared contract boundary', () => {
    expect(validateFindings([{
      severity: 'P2',
      path: './src/main.ts',
      line: 3,
      title: '  Title  ',
      body: '  Body  ',
      suggestion: null,
    }])).toEqual([{
      severity: 'P2',
      path: 'src/main.ts',
      line: 3,
      title: 'Title',
      body: 'Body',
    }]);
  });

  it('fails closed (throws PanelConfigurationError) when gateway connection fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:9090')));

    const client = new OmniRouteClient({ baseUrl: 'http://127.0.0.1:9090' });
    const config = parseAndValidateConfig(mockYaml) as unknown as CtReviewConfigV3;

    await expect(
      executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/main.ts', content: 'console.log("test");' }],
        repository: 'test/repo',
        headSha: 'abc1234',
        client,
      })
    ).rejects.toThrow(PanelConfigurationError);
    });
  });

  it('retries only typed transient OpenRouter failures', () => {
    expect(isRetryablePanelError(new OpenRouterResponseError('unauthorized', 401))).toBe(false);
    expect(isRetryablePanelError(new OpenRouterResponseError('rate limited', 429))).toBe(true);
    expect(isRetryablePanelError(new OpenRouterResponseError('unavailable', 503))).toBe(true);
    // The gateway tags empty completions with 502; classification is status-based, not stringly-typed.
    expect(isRetryablePanelError(new OpenRouterResponseError('OpenRouter returned empty completion content', 502))).toBe(true);
    expect(isRetryablePanelError(new OpenRouterResponseError('some other contract error'))).toBe(false);
    expect(isRetryablePanelError(new OpenRouterTimeoutError('deadline', 'total'))).toBe(true);
  });

  describe('buildDiffSection never inlines patch payloads', () => {
    it('emits git range and file names only, even for tiny diffs', () => {
      const files = [
        { path: 'src/a.ts', patch: 'diff a content line 1\nline 2' },
        { path: 'src/b.ts', patch: 'diff b content line 1\nline 2' },
      ];
      const diffSection = buildDiffSection(files, {
        baseSha: 'b'.repeat(40),
        headSha: 'a'.repeat(40),
      });
      expect(diffSection).toContain('=== GIT RANGE (no diff payload is inlined; explore this yourself) ===');
      expect(diffSection).toContain(`git diff ${'b'.repeat(40)}...${'a'.repeat(40)}`);
      expect(diffSection).toContain('=== PR CHANGED FILES INDEX (2 file(s)) ===');
      expect(diffSection).toContain('- src/a.ts');
      expect(diffSection).toContain('- src/b.ts');
      expect(diffSection).not.toContain('diff a content');
      expect(diffSection).not.toContain('=== FILE:');
      expect(diffSection).toContain('Fetch the commit diffs yourself');
    });

    it('marks files over max-file-diff-chars as SKIPPED and omits their payload', () => {
      const previous = process.env.MAX_FILE_DIFF_CHARS;
      process.env.MAX_FILE_DIFF_CHARS = '100';
      try {
        const files = [
          { path: 'src/small.ts', patch: 'ok' },
          { path: 'src/huge.ts', patch: 'x'.repeat(200) },
        ];
        const diffSection = buildDiffSection(files);
        expect(diffSection).toContain('- src/small.ts');
        expect(diffSection).toContain('SKIPPED: 200 chars > max-file-diff-chars 100');
        expect(diffSection).not.toContain('x'.repeat(20));
      } finally {
        if (previous === undefined) delete process.env.MAX_FILE_DIFF_CHARS;
        else process.env.MAX_FILE_DIFF_CHARS = previous;
      }
    });

    it('does not inline excerpts when the combined patch is huge', () => {
      const files = Array.from({ length: 15 }, (_, i) => ({
        path: `src/file_${i}.ts`,
        patch: `// Header for file ${i}\n` + 'x'.repeat(3000),
      }));
      const diffSection = buildDiffSection(files);
      expect(diffSection).toContain('=== PR CHANGED FILES INDEX (15 file(s)) ===');
      expect(diffSection).not.toContain('=== FILE: src/file_0.ts ===');
      expect(diffSection).not.toContain('x'.repeat(20));
      expect(diffSection).not.toContain('[diff truncated');
    });
  });

  describe('buildCompactFileList helper', () => {
    it('formats file paths without line counts by default', () => {
      const files = [
        { path: 'src/a.ts', patch: '+ line1\n+ line2' },
        { path: 'src/b.ts' },
      ];
      expect(buildCompactFileList(files)).toBe('- src/a.ts\n- src/b.ts');
    });

    it('annotates line counts when includeLineCounts is enabled', () => {
      const files = [
        { path: 'src/a.ts', patch: '+ line1\n+ line2' },
        { path: 'src/single.ts', patch: '+ line1' },
        { path: 'src/empty.ts' },
      ];
      expect(buildCompactFileList(files, { includeLineCounts: true })).toBe(
        '- src/a.ts (2 diff lines)\n- src/single.ts (1 diff line)\n- src/empty.ts (0 diff lines)'
      );
    });

    it('returns None when changed files list is empty', () => {
      expect(buildCompactFileList([])).toBe('None');
    });
  });

  describe('buildCompactDiffManifest & Domain Lane Partitioning', () => {
    it('computes diff stats additions and deletions accurately', () => {
      const patch = [
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,3 +1,4 @@',
        ' context',
        '-old line 1',
        '-old line 2',
        '+new line 1',
        '+new line 2',
        '+new line 3',
        ' trailing context',
      ].join('\n');

      const stats = computeDiffStats(patch);
      expect(stats.additions).toBe(3);
      expect(stats.deletions).toBe(2);
    });

    it('partitions files into domain lanes with breakdown and line stats', () => {
      const files = [
        { path: 'src/auth/jwt.ts', patch: '+ export function sign() {}\n- old()' },
        { path: 'priv/repo/migrations/init.sql', patch: '+ CREATE TABLE users();' },
        { path: 'docs/architecture.md', patch: '+ # Architecture' },
      ];

      const manifest = buildCompactDiffManifest(files, {
        baseSha: 'base123',
        headSha: 'head456',
      });

      expect(manifest).toContain('=== GIT RANGE');
      expect(manifest).toContain('git diff base123...head456');
      expect(manifest).toContain('=== DOMAIN LANE BREAKDOWN ===');
      expect(manifest).toContain('- security_auth: 1 file');
      expect(manifest).toContain('- data_persistence: 1 file');
      expect(manifest).toContain('- docs_assets: 1 file');
      expect(manifest).toContain('=== PR CHANGED FILES INDEX (3 file(s)) ===');
      expect(manifest).toContain('- src/auth/jwt.ts [security_auth] (+1, -1 lines)');
      expect(manifest).toContain('- priv/repo/migrations/init.sql [data_persistence] (+1, -0 lines)');
      expect(manifest).toContain('- docs/architecture.md [docs_assets] (+1, -0 lines)');
      expect(manifest).toContain('=== SWARM EXPLORATION & TARGETED PULL PROTOCOL ===');
      expect(manifest).toContain('Zero raw diff hunks are pre-rendered in this prompt');
    });

    it('highlights persona lane affinity with (★ YOUR LANE) for sec-lane', () => {
      const files = [
        { path: 'src/auth/guard.ts', patch: '+ function check() {}' },
        { path: 'src/components/Header.tsx', patch: '+ <header/>' },
      ];

      const manifest = buildCompactDiffManifest(files, {
        persona: 'sec-lane',
      });

      expect(manifest).toContain('=== YOUR ASSIGNED DOMAIN FOCUS ===');
      expect(manifest).toContain("Persona: 'sec-lane' | Domain Lane Affinities: [security_auth]");
      expect(manifest).toContain('- src/auth/guard.ts [security_auth] (★ YOUR LANE) (+1, -0 lines)');
      expect(manifest).toContain('- src/components/Header.tsx [ui_frontend] (+1, -0 lines)');
      expect(manifest).not.toContain('Header.tsx [ui_frontend] (★ YOUR LANE)');
    });

    it('highlights persona lane affinity for db-lane', () => {
      const files = [
        { path: 'src/auth/guard.ts', patch: '+ check' },
        { path: 'priv/repo/migrations/2026_add_col.exs', patch: '+ alter table' },
      ];

      const manifest = buildCompactDiffManifest(files, {
        persona: 'db-lane',
      });

      expect(manifest).toContain("Persona: 'db-lane' | Domain Lane Affinities: [data_persistence]");
      expect(manifest).toContain('- priv/repo/migrations/2026_add_col.exs [data_persistence] (★ YOUR LANE) (+1, -0 lines)');
    });
  });

  describe('read_file line slicing in tool exploration', () => {
    it('slices requested line range correctly with 1-based index and clamping', async () => {
      let capturedToolResult = '';
      const mockClient = {
        complete: vi.fn().mockImplementation(async (payload: any) => {
          const userMsg = payload.messages[payload.messages.length - 1];
          const text = typeof userMsg?.content === 'string'
            ? userMsg.content
            : Array.isArray(userMsg?.content)
              ? userMsg.content.map((b: any) => b.text || '').join('\n')
              : '';

          const allText = payload.messages
            .map((m: any) =>
              typeof m?.content === 'string'
                ? m.content
                : Array.isArray(m?.content)
                  ? m.content.map((b: any) => b.text || '').join('\n')
                  : ''
            )
            .join('\n');

          const nonceMatch = allText.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
          const nonce = nonceMatch ? nonceMatch[1] : 'nonce-123';

          if (allText.includes('SHIP|FIX_FIRST|BLOCK')) {
            return {
              id: 'resp_arbiter',
              model: 'test-model',
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'All good' })}\nCT_REVIEW_END:${nonce}`,
              usage: { prompt: 10, completion: 10, total: 20 },
            };
          }

          if (allText.includes('RECONCILED')) {
            return {
              id: 'resp_mod',
              model: 'test-model',
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
              usage: { prompt: 10, completion: 10, total: 20 },
            };
          }

          if (text.includes('[PI_TOOL_RESULT]')) {
            if (!capturedToolResult) capturedToolResult = text;
            return {
              id: 'resp_finish',
              model: 'test-model',
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ role: 'persona', decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
              usage: { prompt: 10, completion: 10, total: 20 },
            };
          }

          // First turn: invoke read_file with lines 2 to 3
          return {
            id: 'resp_tool',
            model: 'test-model',
            content: '```json\n{"tool": "read_file", "args": {"path": "src/multi.ts", "startLine": 2, "endLine": 3}}\n```',
            usage: { prompt: 10, completion: 10, total: 20 },
          };
        }),
      };

      const multilineContent = [
        'line 1: header',
        'line 2: important logic',
        'line 3: edge case',
        'line 4: footer',
      ].join('\n');

      const config = parseAndValidateConfig(mockYaml) as unknown as CtReviewConfigV3;
      await executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/multi.ts', patch: multilineContent }],
        repository: 'test/repo',
        headSha: 'abc1234',
        client: mockClient as any,
      });

      expect(capturedToolResult).toContain("Lines 2-3 of 4 for 'src/multi.ts':");
      expect(capturedToolResult).toContain('line 2: important logic\nline 3: edge case');
      expect(capturedToolResult).not.toContain('line 1: header');
      expect(capturedToolResult).not.toContain('line 4: footer');
    });
  });

