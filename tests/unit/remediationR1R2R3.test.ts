import { describe, it, expect } from 'vitest';
import { getProviderIdForModel } from '../../src/lib/model-filtering';
import { filterDiffHunks } from '../../src/pipeline/hunkFilter';
import { CommentPublisher } from '../../src/github/commentPublisher';
import { PERSONA_CHARTERS } from '../../.github/workflows/pipelines/review-pipeline.js';

describe('Remediation R1, R2, R3 Targeted Verification Tests', () => {
  describe('R1.4: Model Filtering Provider Resolution', () => {
    it('returns openrouter for openrouter/auto model ID', () => {
      const providerId = getProviderIdForModel('openrouter/auto');
      expect(providerId).toBe('openrouter');
    });

    it('returns openrouter for openrouter/anthropic/claude-3.5-sonnet', () => {
      const providerId = getProviderIdForModel('openrouter/anthropic/claude-3.5-sonnet');
      expect(providerId).toBe('openrouter');
    });
  });

  describe('R1.5: Diff Hunk Filtering with path_filters', () => {
    it('ignores files matching path_filters exclusion patterns', () => {
      const files = [
        { path: 'src/index.ts', content: 'console.log("hello");' },
        { path: 'vendor/library.js', content: 'var lib = 1;' },
        { path: 'docs/api.pdf', content: 'binary' },
      ];
      const result = filterDiffHunks(files, { path_filters: ['vendor/**', '*.pdf'] });
      expect(result.files).toHaveLength(3);
      expect(result.files.find((f) => f.path === 'src/index.ts')?.status).toBe('included');
      expect(result.files.find((f) => f.path === 'vendor/library.js')?.status).toBe('ignored');
      expect(result.files.find((f) => f.path === 'docs/api.pdf')?.status).toBe('ignored');
    });
  });

  describe('R2.3: CommentPublisher Token Enforcement', () => {
    it('throws when no token is configured (no ghs_fallback_token_dev)', () => {
      const origToken = process.env.GITHUB_TOKEN;
      const origAppToken = process.env.GITHUB_APP_INSTALLATION_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_APP_INSTALLATION_TOKEN;

      try {
        expect(() => new CommentPublisher({})).toThrow(/requires an (authentic|explicit) GitHub.*token/i);
      } finally {
        if (origToken) process.env.GITHUB_TOKEN = origToken;
        if (origAppToken) process.env.GITHUB_APP_INSTALLATION_TOKEN = origAppToken;
      }
    });
  });

  describe('R3.1: Persona Charters Harmonization', () => {
    it('contains all 12 standard reviewer persona IDs', () => {
      const ids = PERSONA_CHARTERS.map((p: any) => p.id);
      expect(ids).toContain('security');
      expect(ids).toContain('performance');
      expect(ids).toContain('architecture');
      expect(ids).toContain('style');
      expect(ids).toContain('testing');
      expect(ids).toContain('documentation');
      expect(ids).toContain('accessibility');
      expect(ids).toContain('database');
      expect(ids).toContain('devops');
      expect(ids).toContain('i18n');
      expect(ids).toContain('dependencies');
      expect(ids).toContain('licensing');
      expect(ids.length).toBe(12);
    });
  });
});
