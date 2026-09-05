/**
 * Master Domain Index unit tests (REL-551)
 * Location: tests/unit/domainIndex.test.ts
 *
 * Covers:
 *  - Schema validity of every checked-in domains/ecosystems/*.json file and domains/classes.json.
 *  - Class vocabulary enforcement (exactly the 14 documented classes, nothing else).
 *  - Every class in domains/classes.json maps only to known persona ids, and stays in sync with
 *    the live PERSONA_CHARTERS export (drift guard).
 *  - Glob parity cases ported from the reference ct_review/glob.py test suite.
 *  - Compile determinism (build twice -> byte-identical).
 *  - matched=true/personas=[] vs matched=false distinction.
 *  - Representative end-to-end resolutions.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PERSONA_CHARTERS } from '../../.github/workflows/pipelines/review-pipeline.js';
import {
  CLASS_VOCABULARY,
  PERSONA_VOCABULARY,
  matchOne,
  buildCompiledIndex,
  loadCompiledIndex,
  loadEcosystemFiles,
  loadClassesFile,
  validateEcosystemFile,
  validateClassesFile,
  resolveFileDomains,
} from '../../src/pipeline/domainIndex';

const domainsDir = path.join(__dirname, '..', '..', 'domains');

describe('Master Domain Index (REL-551)', () => {
  describe('schema validity', () => {
    it('validates every domains/ecosystems/*.json file against index-schema.json', () => {
      const files = fs.readdirSync(path.join(domainsDir, 'ecosystems')).filter((f) => f.endsWith('.json'));
      expect(files.length).toBeGreaterThanOrEqual(25); // ~25 language ecosystems + generic

      for (const file of files) {
        const parsed = JSON.parse(fs.readFileSync(path.join(domainsDir, 'ecosystems', file), 'utf8'));
        const errors = validateEcosystemFile(parsed, domainsDir);
        expect(errors, `${file}: ${errors.join('; ')}`).toEqual([]);
      }
    });

    it('validates domains/classes.json against index-schema.json', () => {
      const parsed = JSON.parse(fs.readFileSync(path.join(domainsDir, 'classes.json'), 'utf8'));
      const errors = validateClassesFile(parsed, domainsDir);
      expect(errors).toEqual([]);
    });

    it('rejects an ecosystem file with an unknown class', () => {
      const errors = validateEcosystemFile(
        { ecosystem: 'x', description: 'x', classes: { 'not-a-real-class': ['**/*.x'] } },
        domainsDir,
      );
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an ecosystem file with an empty glob list', () => {
      const errors = validateEcosystemFile({ ecosystem: 'x', description: 'x', classes: { source: [] } }, domainsDir);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a classes.json missing a class', () => {
      const full = JSON.parse(fs.readFileSync(path.join(domainsDir, 'classes.json'), 'utf8'));
      delete full.assets;
      const errors = validateClassesFile(full, domainsDir);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a classes.json with an unknown persona id', () => {
      const full = JSON.parse(fs.readFileSync(path.join(domainsDir, 'classes.json'), 'utf8'));
      full.source = ['not-a-real-persona'];
      const errors = validateClassesFile(full, domainsDir);
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('class vocabulary enforcement', () => {
    it('CLASS_VOCABULARY has exactly the 14 documented classes', () => {
      expect(CLASS_VOCABULARY).toHaveLength(14);
      expect([...CLASS_VOCABULARY].sort()).toEqual(
        [
          'source',
          'test',
          'docs',
          'deps-manifest',
          'lockfile',
          'ci',
          'infra',
          'database',
          'config',
          'ui-styles',
          'i18n',
          'license',
          'scripts',
          'assets',
        ].sort(),
      );
    });

    it('every ecosystem file uses only classes from CLASS_VOCABULARY', () => {
      const ecosystems = loadEcosystemFiles(domainsDir);
      for (const eco of ecosystems) {
        for (const cls of Object.keys(eco.classes)) {
          expect(CLASS_VOCABULARY as readonly string[]).toContain(cls);
        }
      }
    });

    it('domains/classes.json defines every one of the 14 classes exactly once', () => {
      const classesFile = loadClassesFile(domainsDir);
      expect(Object.keys(classesFile).sort()).toEqual([...CLASS_VOCABULARY].sort());
    });
  });

  describe('persona id integrity', () => {
    it('PERSONA_VOCABULARY matches the live PERSONA_CHARTERS ids exactly (drift guard)', () => {
      const liveIds = PERSONA_CHARTERS.map((p: { id: string }) => p.id).sort();
      expect([...PERSONA_VOCABULARY].sort()).toEqual(liveIds);
      expect(PERSONA_VOCABULARY).toHaveLength(12);
    });

    it('every persona id in domains/classes.json is a known persona', () => {
      const classesFile = loadClassesFile(domainsDir);
      for (const [cls, personas] of Object.entries(classesFile)) {
        for (const persona of personas) {
          expect(PERSONA_VOCABULARY as readonly string[], `class "${cls}"`).toContain(persona);
        }
      }
    });

    it('assets maps to no personas on purpose', () => {
      const classesFile = loadClassesFile(domainsDir);
      expect(classesFile.assets).toEqual([]);
    });
  });

  describe('glob parity (ported from ct_review/glob.py test cases)', () => {
    it.each([
      ['lib/**/*.ex', 'lib/foo.ex', true],
      ['lib/**/*.ex', 'lib/a/b/foo.ex', true],
      ['lib/**/*.ex', 'test/foo.ex', false],
      ['**/*.generated.*', 'x.generated.ex', true],
      ['**/*.generated.*', 'lib/x.generated.ex', true],
      ['*.ex', 'a/b.ex', false],
      ['lib/*.ex', 'lib/foo.ex', true],
      ['lib/*.ex', 'lib/a/foo.ex', false],
      ['?', 'a', true],
      ['?', 'ab', false],
      ['src/**/*.{ts,js,vue}', 'src/a.ts', true],
      ['src/**/*.{ts,js,vue}', 'src/y/z.vue', true],
      ['src/**/*.{ts,js,vue}', 'src/d/e/f.js', true],
      ['src/**/*.{ts,js,vue}', 'src/x.css', false],
      ['src/**/*.{ts,js,vue}', 'x/y/z.vue', false],
      ['a/*.{ts,}', 'a/b.ts', true],
      ['a/*.{}', 'a/b', false],
      ['proto/**', 'proto/bar.proto', true],
    ] as const)('matchOne(%s, %s) === %s', (glob, filePath, expected) => {
      expect(matchOne(glob, filePath)).toBe(expected);
    });
  });

  describe('compile determinism', () => {
    it('building the index twice from the same sources produces byte-identical output', () => {
      const first = buildCompiledIndex(domainsDir);
      const second = buildCompiledIndex(domainsDir);
      expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
      expect(first.indexDigest).toEqual(second.indexDigest);
    });

    it('the checked-in domains/compiled-index.json matches a fresh build (run `npm run domains:build` if this fails)', () => {
      const fresh = buildCompiledIndex(domainsDir);
      const checkedIn = loadCompiledIndex(domainsDir);
      expect(checkedIn).toEqual(fresh);
    });

    it('indexDigest changes when the source files change', () => {
      const original = buildCompiledIndex(domainsDir);

      const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'domain-index-digest-'));
      try {
        fs.cpSync(domainsDir, tmpDir, { recursive: true });
        const classesPath = path.join(tmpDir, 'classes.json');
        const classesFile = JSON.parse(fs.readFileSync(classesPath, 'utf8'));
        classesFile.assets = ['security']; // was []
        fs.writeFileSync(classesPath, JSON.stringify(classesFile));

        const mutated = buildCompiledIndex(tmpDir);
        expect(mutated.indexDigest).not.toEqual(original.indexDigest);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('resolveFileDomains', () => {
    const index = loadCompiledIndex(domainsDir);

    it('matched=true, personas=[] for a binary asset (distinct from unmatched)', () => {
      const resolution = resolveFileDomains('assets/logo.png', index);
      expect(resolution.matched).toBe(true);
      expect(resolution.classes).toContain('assets');
      expect(resolution.personas).toEqual([]);
    });

    it('matched=false for a path no ecosystem glob covers', () => {
      const resolution = resolveFileDomains('weird.xyz', index);
      expect(resolution.matched).toBe(false);
      expect(resolution.classes).toEqual([]);
      expect(resolution.personas).toEqual([]);
    });

    it('lib/foo.ex resolves to the elixir source class and its personas', () => {
      const resolution = resolveFileDomains('lib/foo.ex', index);
      expect(resolution.matched).toBe(true);
      expect(resolution.classes).toContain('source');
      expect(resolution.personas.sort()).toEqual(
        ['security', 'performance', 'architecture', 'testing', 'style'].sort(),
      );
    });

    it('mix.lock resolves to lockfile -> dependencies + security', () => {
      const resolution = resolveFileDomains('mix.lock', index);
      expect(resolution.matched).toBe(true);
      expect(resolution.classes).toContain('lockfile');
      expect(resolution.personas.sort()).toEqual(['dependencies', 'security'].sort());
    });

    it('README.md resolves to docs -> documentation + licensing', () => {
      const resolution = resolveFileDomains('README.md', index);
      expect(resolution.matched).toBe(true);
      expect(resolution.classes).toContain('docs');
      expect(resolution.personas.sort()).toEqual(['documentation', 'licensing'].sort());
    });

    it('a nested test file resolves to the test class', () => {
      const resolution = resolveFileDomains('test/cdrcisco/foo_test.exs', index);
      expect(resolution.matched).toBe(true);
      expect(resolution.classes).toContain('test');
      expect(resolution.personas.sort()).toEqual(['testing', 'architecture'].sort());
    });

    it('a GitHub Actions workflow resolves to ci (also matched by generic config globs, personas union)', () => {
      const resolution = resolveFileDomains('.github/workflows/ci.yml', index);
      expect(resolution.matched).toBe(true);
      expect(resolution.classes).toContain('ci');
      // Also matched by generic's `**/*.yml` -> config, so personas are the union of ci + config.
      expect(resolution.classes.sort()).toEqual(['ci', 'config'].sort());
      expect(resolution.personas.sort()).toEqual(['architecture', 'devops', 'security'].sort());
    });

    it('a Dockerfile resolves to infra -> devops + security + architecture', () => {
      const resolution = resolveFileDomains('Dockerfile', index);
      expect(resolution.matched).toBe(true);
      expect(resolution.classes).toContain('infra');
      expect(resolution.personas.sort()).toEqual(['devops', 'security', 'architecture'].sort());
    });

    it('a path may match classes across multiple ecosystems and unions them', () => {
      // package.json is JS/TS deps-manifest; it's also covered by generic's config globs? verify union semantics
      // by checking mix.lock (elixir lockfile) also matches generic's `*.lock` glob -> still just "lockfile" class.
      const resolution = resolveFileDomains('mix.lock', index);
      expect(resolution.classes).toEqual(['lockfile']);
    });

    it('REL-586: CLAUDE.md, AGENTS.md, SKILL.md, and .claude/rules/*.md are executable policy -- they resolve to config in addition to docs, not docs alone', () => {
      const policyPaths = [
        'CLAUDE.md',
        'AGENTS.md',
        'plugins/ct-workflow/skills/coder-worker/SKILL.md',
        '.claude/rules/00-overview.md',
      ];
      for (const filePath of policyPaths) {
        const resolution = resolveFileDomains(filePath, index);
        expect(resolution.matched, filePath).toBe(true);
        expect(resolution.classes, filePath).toContain('config');
        // config -> security, architecture, devops -- a policy-file-only PR must not be
        // reviewable by the licensing persona alone.
        expect(resolution.personas, filePath).toContain('security');
        expect(resolution.personas, filePath).toContain('architecture');
      }
      // An ordinary README.md is unaffected -- still docs-only.
      expect(resolveFileDomains('README.md', index).classes).toEqual(['docs']);
    });

    it('REL-586: an SVG resolves to the source class (not the personaless assets class)', () => {
      const resolution = resolveFileDomains('assets/logo.svg', index);
      expect(resolution.matched).toBe(true);
      expect(resolution.classes).toContain('source');
      expect(resolution.classes).not.toContain('assets');
      expect(resolution.personas.length).toBeGreaterThan(0);
      // A PNG stays in the personaless assets class -- only SVG moved.
      expect(resolveFileDomains('assets/logo.png', index).classes).toEqual(['assets']);
    });
  });
});
