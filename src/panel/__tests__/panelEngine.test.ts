import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildDiffSection,
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
    expect(isRetryablePanelError(new OpenRouterTimeoutError('deadline', 'total'))).toBe(true);
  });

  describe('buildDiffSection and prompt diff budget compaction', () => {
    it('inlines full patches when diff is within the 40,000 character budget', () => {
      const files = [
        { path: 'src/a.ts', patch: 'diff a content line 1\nline 2' },
        { path: 'src/b.ts', patch: 'diff b content line 1\nline 2' },
      ];
      const diffSection = buildDiffSection(files);
      expect(diffSection).toContain('=== FILE: src/a.ts ===\ndiff a content line 1\nline 2');
      expect(diffSection).toContain('=== FILE: src/b.ts ===\ndiff b content line 1\nline 2');
      expect(diffSection).not.toContain('=== PR CHANGED FILES INDEX');
      expect(diffSection).not.toContain('[diff truncated');
    });

    it('switches to compact index and bounded truncated excerpts when total diff exceeds 40,000 characters', () => {
      // Create 15 files with 3,000 chars each (total 45,000 chars > MAX_INLINE_DIFF_CHARS)
      const files = Array.from({ length: 15 }, (_, i) => ({
        path: `src/file_${i}.ts`,
        patch: `// Header for file ${i}\n` + 'x'.repeat(3000),
      }));

      const diffSection = buildDiffSection(files);

      // Must contain index header with file count
      expect(diffSection).toContain('=== PR CHANGED FILES INDEX (15 file(s)');
      expect(diffSection).toContain('=== BOUNDED DIFF EXCERPTS (Large PR: use read_file, get_diff, search_code, or zoekt for full details) ===');

      // Must contain at most 10 file excerpt blocks
      const fileBlocks = diffSection.match(/=== FILE: src\/file_\d+\.ts ===/g);
      expect(fileBlocks?.length).toBe(10);
      expect(diffSection).not.toContain('=== FILE: src/file_10.ts ===');

      // Excerpts over 2000 chars must carry the truncation marker
      expect(diffSection).toContain('... [diff truncated: use read_file or get_diff for full contents]');
    });

    it('preserves full patches at the exact 40,000 character boundary without truncation', () => {
      const boundaryPatch = 'a'.repeat(MAX_INLINE_DIFF_CHARS);
      const files = [{ path: 'src/boundary.ts', patch: boundaryPatch }];

      const diffSection = buildDiffSection(files);
      expect(diffSection).toBe(`=== FILE: src/boundary.ts ===\n${boundaryPatch}`);
      expect(diffSection).not.toContain('=== PR CHANGED FILES INDEX');
      expect(diffSection).not.toContain('[diff truncated');
    });
  });
