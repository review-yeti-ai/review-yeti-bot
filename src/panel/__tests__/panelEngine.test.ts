import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildCompactFileList,
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
