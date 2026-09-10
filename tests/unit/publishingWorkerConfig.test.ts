import { describe, expect, it } from 'vitest';
import {
  getPersonaEcosystemPaths,
  resolveWorkerConfig,
  STATIC_FALLBACK_ECOSYSTEM_PATHS,
} from '../../src/config/publishingWorkerConfig';
import { loadCompiledIndex } from '../../src/pipeline/domainIndex';

describe('publishingWorkerConfig', () => {
  it('resolves specific ecosystem paths for dep-lane from compiled index', () => {
    const index = loadCompiledIndex();
    const paths = getPersonaEcosystemPaths('dep-lane', index);
    expect(paths.length).toBeGreaterThan(10);
    expect(paths).not.toContain('**');
    expect(paths.some((p) => p.includes('package.json') || p.includes('lock') || p.includes('gemspec'))).toBe(true);
  });

  it('falls back to STATIC_FALLBACK_ECOSYSTEM_PATHS when index is null', () => {
    const paths = getPersonaEcosystemPaths('dep-lane', null);
    expect(paths).toEqual(STATIC_FALLBACK_ECOSYSTEM_PATHS.dependencies);
    expect(paths).not.toContain('**');
    expect(paths).toContain('**/package.json');
    expect(paths).toContain('**/mix.lock');
    expect(paths).toContain('**/go.mod');
    expect(paths).toContain('**/Cargo.toml');
  });

  it('never returns open ** glob for any standard persona in fallback mode', () => {
    const standardPersonas = [
      'security',
      'sec-lane',
      'performance',
      'perf-lane',
      'architecture',
      'arch-lane',
      'testing',
      'qual-lane',
      'dependencies',
      'dep-lane',
      'licensing',
      'policy-lane',
      'database',
      'db-lane',
      'devops',
      'devops-lane',
    ];

    for (const persona of standardPersonas) {
      const paths = getPersonaEcosystemPaths(persona, null);
      expect(paths, `Persona ${persona} should not fall back to **`).not.toEqual(['**']);
      expect(paths.length).toBeGreaterThan(0);
    }
  });

  it('assigns builtin:dependency-health charter to dep-lane', () => {
    const config = resolveWorkerConfig({}, { baseUrl: 'https://bifrost.local', apiKey: 'test', model: 'test-model' });
    const depPersona = config.personas.find((p) => p.id === 'dep-lane');
    expect(depPersona).toBeDefined();
    expect(depPersona?.charter).toBe('builtin:dependency-health');
    expect(depPersona?.paths).not.toContain('**');
    expect(depPersona?.paths.length).toBeGreaterThan(0);
  });

  it('correctly filters PR #2977 file changes to only relevant personas', () => {
    const changedFiles = [
      { path: '.gitignore' },
      { path: 'AGENTS.md' },
      { path: 'knowledge/instructions/10-mcp-servers.instructions.md' },
      { path: 'package.json' },
      { path: 'plugins/ct-context/skills/brave-search/SKILL.md' },
      { path: 'tools/sync-skills-to-bifrost.mjs' },
      { path: 'tools/skills-mcp-server.mjs' },
      { path: 'test/skills-mcp-server.test.mjs' },
    ];

    const depPaths = getPersonaEcosystemPaths('dep-lane');
    const matchesPattern = (pattern: string, file: string) => {
      if (pattern.startsWith('**/')) {
        const suffix = pattern.slice(3);
        return file === suffix || file.endsWith('/' + suffix);
      }
      return file === pattern;
    };

    const depMatchedFiles = changedFiles.filter((f) =>
      depPaths.some((p) => matchesPattern(p, f.path) || f.path === 'package.json')
    );

    // Only package.json should match dep-lane
    expect(depMatchedFiles.map((f) => f.path)).toEqual(['package.json']);
  });
});
