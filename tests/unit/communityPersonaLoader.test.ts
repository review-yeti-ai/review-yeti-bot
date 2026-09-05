import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CommunityPersonaLoader,
  CommunityPersonaValidationError,
  CommunityPersonaNotFoundError,
  CommunityPersonaFetchError,
  parsePersonaCharter,
  resolveCommunityPersonas,
  sanitizePersonaId,
} from '../../src/personas/communityPersonaLoader';
import { personaSchema } from '../../src/config/schema';
import { parseAndValidateConfig, resolveConfigPersonas } from '../../src/config/configLoader';

describe('CommunityPersonaLoader Unit Tests', () => {
  const testBaseDir = path.resolve(__dirname, '../fixtures/community_personas_test');
  const testCacheDir = path.join(testBaseDir, '.ct-memory/cache/personas');
  const testLocalDir = path.join(testBaseDir, 'custom-personas');

  beforeEach(() => {
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testLocalDir, { recursive: true });
    fs.mkdirSync(testCacheDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  describe('1. Parsing & Frontmatter Validation', () => {
    it('successfully extracts YAML frontmatter and markdown charter body', () => {
      const rawMarkdown = `---
name: "django-security"
role: "Django Security Specialist"
focus: "SQL injection, CSRF protection, ORM security"
model: openrouter/deepseek/deepseek-v4-flash-0731
enabled: true
reasoning_effort: high
---

# Django Security Specialist Charter
## Role & Mission
Audit Django applications for security misconfigurations and SQL injections.`;

      const { frontmatter, charter } = parsePersonaCharter(rawMarkdown);

      expect(frontmatter.name).toBe('django-security');
      expect(frontmatter.role).toBe('Django Security Specialist');
      expect(frontmatter.focus).toBe('SQL injection, CSRF protection, ORM security');
      expect(frontmatter.model).toBe('openrouter/deepseek/deepseek-v4-flash-0731');
      expect(frontmatter.enabled).toBe(true);
      expect(frontmatter.reasoning_effort).toBe('high');
      expect(charter).toContain('# Django Security Specialist Charter');
      expect(charter).toContain('Audit Django applications');
    });

    it('throws CommunityPersonaValidationError when frontmatter delimiters are missing', () => {
      const invalidMarkdown = `# Heading without frontmatter
Some charter body text here.`;

      expect(() => parsePersonaCharter(invalidMarkdown)).toThrow(CommunityPersonaValidationError);
      expect(() => parsePersonaCharter(invalidMarkdown)).toThrow(/between '---' markers/i);
    });

    it('throws CommunityPersonaValidationError when YAML syntax is invalid', () => {
      const malformedYaml = `---
name: [unclosed array
model: 123: invalid
---

# Valid Body Here`;

      expect(() => parsePersonaCharter(malformedYaml)).toThrow(CommunityPersonaValidationError);
      expect(() => parsePersonaCharter(malformedYaml)).toThrow(/Failed to parse YAML frontmatter/i);
    });

    it('throws CommunityPersonaValidationError when charter body is empty or too short', () => {
      const emptyBody = `---
name: test-persona
---
`;

      expect(() => parsePersonaCharter(emptyBody)).toThrow(CommunityPersonaValidationError);
      expect(() => parsePersonaCharter(emptyBody)).toThrow(/cannot be empty/i);
    });

    it('sanitizes persona IDs into lowercase alphanumeric and hyphen format', () => {
      expect(sanitizePersonaId('Django Security Guardian')).toBe('django-security-guardian');
      expect(sanitizePersonaId('123_numeric_start')).toBe('p-123_numeric_start');
      expect(sanitizePersonaId('Special!@#$%Characters')).toBe('special-characters');
    });
  });

  describe('2. Resolution Precedence', () => {
    it('resolves bundled community persona from domains/personas/ (Precedence 1)', async () => {
      const loader = new CommunityPersonaLoader({
        baseDir: path.resolve(__dirname, '../..'),
      });

      const result = await loader.resolvePersonaReference('review-yeti/personas/django-security@v1');
      expect(result.sourceType).toBe('bundled');
      expect(result.frontmatter.name).toBe('django-security');
      expect(result.charter).toContain('Django Security Specialist Charter');
      expect(result.charter).toContain('Unsafe ORM and Raw SQL Queries');
    });

    it('resolves bundled persona with bare name or tenancy filename', async () => {
      const loader = new CommunityPersonaLoader({
        baseDir: path.resolve(__dirname, '../..'),
      });

      const result = await loader.resolvePersonaReference('tenancy');
      expect(result.sourceType).toBe('bundled');
      expect(result.frontmatter.name).toContain('Multi-Tenant');
      expect(result.charter).toContain('Multi-Tenant Isolation Guardian Charter');
    });

    it('resolves local persona file starting with ./ (Precedence 2)', async () => {
      const localFilePath = path.join(testLocalDir, 'custom-auditor.md');
      fs.writeFileSync(
        localFilePath,
        `---
name: custom-auditor
role: Internal API Auditor
model: openrouter/openai/gpt-4o
---
# Internal API Auditor Charter
Ensures internal RPC schemas follow enterprise standards.`,
        'utf-8'
      );

      const loader = new CommunityPersonaLoader({
        baseDir: testBaseDir,
      });

      const result = await loader.resolvePersonaReference('./custom-personas/custom-auditor.md');
      expect(result.sourceType).toBe('local');
      expect(result.frontmatter.name).toBe('custom-auditor');
      expect(result.charter).toContain('Internal API Auditor Charter');
    });

    it('throws CommunityPersonaNotFoundError if local file does not exist', async () => {
      const loader = new CommunityPersonaLoader({
        baseDir: testBaseDir,
      });

      await expect(loader.resolvePersonaReference('./custom-personas/non-existent.md')).rejects.toThrow(
        CommunityPersonaNotFoundError
      );
    });

    it('resolves remote GitHub reference (Precedence 3) with custom fetcher and caching', async () => {
      const mockFetch = vi.fn().mockResolvedValue(`---
name: remote-cloud-guardian
role: Cloud Infrastructure Sentinel
model: openrouter/google/gemini-2.5-pro
---
# Cloud Infrastructure Sentinel Charter
Checks Terraform, Helm, and K8s manifests for security posture.`);

      const loader = new CommunityPersonaLoader({
        baseDir: testBaseDir,
        cacheDir: testCacheDir,
        fetcher: mockFetch,
      });

      // 1. Initial fetch: calls fetcher and populates cache
      const result1 = await loader.resolvePersonaReference('acme-corp/dev-personas/cloud.md@v2.1.0');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://raw.githubusercontent.com/acme-corp/dev-personas/v2.1.0/cloud.md'
      );
      expect(result1.sourceType).toBe('remote');
      expect(result1.frontmatter.name).toBe('remote-cloud-guardian');
      expect(result1.charter).toContain('Cloud Infrastructure Sentinel Charter');

      // Check cache directory has the cached file
      const cachedFiles = fs.readdirSync(testCacheDir);
      expect(cachedFiles.length).toBe(1);

      // 2. Second fetch: uses cache, mockFetch is NOT called again
      const result2 = await loader.resolvePersonaReference('acme-corp/dev-personas/cloud.md@v2.1.0');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result2.frontmatter.name).toBe('remote-cloud-guardian');
    });

    it('throws CommunityPersonaFetchError when remote fetch returns HTTP 404', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('HTTP 404 Not Found'));

      const loader = new CommunityPersonaLoader({
        baseDir: testBaseDir,
        cacheDir: testCacheDir,
        fetcher: mockFetch,
      });

      await expect(loader.resolvePersonaReference('unknown/repo/missing.md@main')).rejects.toThrow(
        CommunityPersonaFetchError
      );
    });
  });

  describe('3. Persona Configuration Normalization', () => {
    it('merges config overrides over charter frontmatter defaults', async () => {
      const loader = new CommunityPersonaLoader({
        baseDir: path.resolve(__dirname, '../..'),
      });

      const resolved = await loader.resolvePersona({
        name: 'django-security',
        uses: 'review-yeti/personas/django-security@v1',
        paths: ['src/django/**', 'backend/**'],
        providers: ['openrouter'],
        model: 'openrouter/anthropic/claude-3.5-sonnet',
        required: true,
      });

      expect(resolved.id).toBe('django-security');
      expect(resolved.name).toBe('django-security');
      expect(resolved.charter).toContain('Django Security Specialist Charter');
      expect(resolved.paths).toEqual(['src/django/**', 'backend/**']);
      expect(resolved.providers).toEqual(['openrouter']);
      expect(resolved.model).toBe('openrouter/anthropic/claude-3.5-sonnet');
      expect(resolved.required).toBe(true);
      expect(resolved.enabled).toBe(true);

      // Verify resolved persona satisfies personaSchema
      const validated = personaSchema.safeParse(resolved);
      expect(validated.success).toBe(true);
    });

    it('resolves an array of mixed local and bundled personas', async () => {
      const localFilePath = path.join(testLocalDir, 'team-rules.md');
      fs.writeFileSync(
        localFilePath,
        `---
name: team-rules
model: openrouter/deepseek/deepseek-v4-flash-0731
---
# Team Rules Charter
Enforce no direct database mutations outside migration files.`,
        'utf-8'
      );

      const loader = new CommunityPersonaLoader({
        baseDir: testBaseDir,
        bundledDir: path.resolve(__dirname, '../../domains/personas'),
      });

      const personas = [
        { name: 'django-security', uses: 'review-yeti/personas/django-security@v1' },
        { name: 'team-rules', uses: './custom-personas/team-rules.md' },
      ];

      const resolved = await loader.resolvePersonas(personas);
      expect(resolved.length).toBe(2);
      expect(resolved[0].id).toBe('django-security');
      expect(resolved[0].charter).toContain('Django Security Specialist Charter');
      expect(resolved[1].id).toBe('team-rules');
      expect(resolved[1].charter).toContain('Team Rules Charter');
    });
  });

  describe('4. Config Parser and Loader Integration', () => {
    it('parses .ct-review.yaml with uses: and resolves external personas into usable objects', async () => {
      const yamlContent = `
version: 3
profile: balanced
quorum: 1
personas:
  - name: django-security
    uses: review-yeti/personas/django-security@v1
    required: true
    paths:
      - "backend/**"
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 300
  providers:
    - id: openrouter
      enabled: true
      model: deepseek/deepseek-v4-flash-0731
      effort: high
      review_timeout_s: 120
      arbiter_timeout_s: 120
  arbiter:
    order:
      - openrouter
`;

      const parsed = parseAndValidateConfig(yamlContent);
      expect((parsed as any).personas.length).toBe(1);
      expect((parsed as any).personas[0].uses).toBe('review-yeti/personas/django-security@v1');

      // Resolve personas
      const resolvedConfig = await resolveConfigPersonas(parsed, {
        baseDir: path.resolve(__dirname, '../..'),
      });

      expect(resolvedConfig.personas[0].id).toBe('django-security');
      expect(resolvedConfig.personas[0].charter).toContain('Django Security Specialist Charter');
      expect(resolvedConfig.personas[0].paths).toEqual(['backend/**']);
      expect(resolvedConfig.personas[0].required).toBe(true);
    });

    it('resolveCommunityPersonas export functions properly as a standalone utility', async () => {
      const personas = [
        {
          name: 'compliance-auditor',
          uses: 'review-yeti/personas/compliance@v1',
        },
      ];

      const resolved = await resolveCommunityPersonas(personas, {
        baseDir: path.resolve(__dirname, '../..'),
      });

      expect(resolved.length).toBe(1);
      expect(resolved[0].charter).toMatch(/compliance/i);
    });
  });
});
