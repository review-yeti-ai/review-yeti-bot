import { describe, expect, it } from 'vitest';
import {
  isSubmoduleEntry,
  isArchitecturePersona,
  personaCoversFile,
  scopeFilesForPersona,
  computeUnmatchedPaths,
} from '../../src/panel/panelEngine';
import { deriveApplicablePersonas } from '../../src/review/personaApplicability';
import { loadCompiledIndex, resolveFileDomains } from '../../src/pipeline/domainIndex';

describe('Submodule Architecture Persona Routing', () => {
  describe('isSubmoduleEntry', () => {
    it('identifies gitlink mode 160000 entries across all field variants as submodules', () => {
      expect(isSubmoduleEntry({ path: 'ct-dashboard', mode: '160000' })).toBe(true);
      expect(isSubmoduleEntry({ path: 'cisco-cdr', newMode: '160000' })).toBe(true);
      expect(isSubmoduleEntry({ path: 'ct-meta', old_mode: '160000' })).toBe(true);
      expect(isSubmoduleEntry({ path: 'ct-meta', oldMode: '160000' })).toBe(true);
      expect(isSubmoduleEntry({ path: 'ct-meta', new_mode: '160000' })).toBe(true);
    });

    it('identifies submodule flags as submodules', () => {
      expect(isSubmoduleEntry({ path: 'ct-dashboard', isSubmodule: true })).toBe(true);
      expect(isSubmoduleEntry({ path: 'cisco-cdr', submoduleCandidate: true })).toBe(true);
    });

    it('rejects ordinary files', () => {
      expect(isSubmoduleEntry({ path: 'src/index.ts', mode: '100644' })).toBe(false);
      expect(isSubmoduleEntry({ path: 'README.md' })).toBe(false);
      expect(isSubmoduleEntry(null)).toBe(false);
      expect(isSubmoduleEntry(undefined)).toBe(false);
    });
  });

  describe('isArchitecturePersona', () => {
    it('matches architecture persona variants by stable id, charter, or capability flag', () => {
      expect(isArchitecturePersona({ id: 'architecture' })).toBe(true);
      expect(isArchitecturePersona({ id: 'arch-lane' })).toBe(true);
      expect(isArchitecturePersona({ id: 'custom', charter: 'builtin:architecture' })).toBe(true);
      expect(isArchitecturePersona({ id: 'custom-lane', coversSubmodules: true })).toBe(true);
    });

    it('rejects non-architecture personas, including those with architecture in display name', () => {
      expect(isArchitecturePersona({ id: 'security', charter: 'builtin:security' })).toBe(false);
      expect(isArchitecturePersona({ id: 'sec-lane', charter: 'builtin:security' })).toBe(false);
      expect(isArchitecturePersona({ id: 'documentation', charter: 'builtin:documentation' })).toBe(false);
      expect(isArchitecturePersona({ id: 'qual-lane', charter: 'builtin:consistency' })).toBe(false);
      // Display name substring alone must NOT match:
      expect(isArchitecturePersona({ id: 'docs-lane', name: 'Architecture Decision Records Reviewer' })).toBe(false);
      expect(isArchitecturePersona(null)).toBe(false);
    });
  });

  describe('personaCoversFile', () => {
    const archPersona = { id: 'architecture', name: 'Architecture', paths: ['arch/**', 'system/**'] };
    const secPersona = { id: 'security', name: 'Security', paths: ['auth/**', 'crypto/**'] };
    const wildcardPersona = { id: 'general', name: 'General', paths: ['**'] };

    it('routes submodule gitlinks to architecture persona even when paths do not match', () => {
      const submoduleFile = { path: 'ct-dashboard', mode: '160000' };
      expect(personaCoversFile(archPersona, submoduleFile)).toBe(true);
      expect(personaCoversFile(secPersona, submoduleFile)).toBe(false);
    });

    it('matches paths normally for architecture persona on standard files', () => {
      expect(personaCoversFile(archPersona, { path: 'arch/topology.md', mode: '100644' })).toBe(true);
      expect(personaCoversFile(archPersona, { path: 'other/random.ts', mode: '100644' })).toBe(false);
    });

    it('handles bare "**" wildcard path correctly', () => {
      expect(personaCoversFile(wildcardPersona, { path: 'any/path/file.ts', mode: '100644' })).toBe(true);
      expect(personaCoversFile(wildcardPersona, { path: 'README.md', mode: '100644' })).toBe(true);
    });

    it('handles null and undefined files safely', () => {
      expect(personaCoversFile(archPersona, null)).toBe(false);
      expect(personaCoversFile(archPersona, undefined)).toBe(false);
    });
  });

  describe('scopeFilesForPersona', () => {
    const archPersona = { id: 'architecture', name: 'Architecture', paths: ['arch/**'] };
    const secPersona = { id: 'security', name: 'Security', paths: ['auth/**'] };

    it('scopes changedFiles in runPersona such that submodule changes belong to arch lane only', () => {
      const changedFiles = [
        { path: 'ct-dashboard', mode: '160000' },
        { path: 'auth/login.ts', mode: '100644' },
      ];

      const archScoped = scopeFilesForPersona(archPersona, changedFiles);
      const secScoped = scopeFilesForPersona(secPersona, changedFiles);

      expect(archScoped.map((f) => f.path)).toEqual(['ct-dashboard']);
      expect(secScoped.map((f) => f.path)).toEqual(['auth/login.ts']);
    });
  });

  describe('computeUnmatchedPaths in executePersonaPanel', () => {
    const archPersona = { id: 'architecture', name: 'Architecture', paths: ['arch/**'] };
    const secPersona = { id: 'security', name: 'Security', paths: ['auth/**'] };

    it('excludes submodule gitlink entries from unmatched paths when architecture persona is active', () => {
      const effectiveFiles = [
        { path: 'ct-dashboard', mode: '160000' },
        { path: 'uncovered/code.ts', mode: '100644' },
      ];

      const unmatched = computeUnmatchedPaths(effectiveFiles, [archPersona]);

      expect(unmatched).toEqual(['uncovered/code.ts']);
      expect(unmatched).not.toContain('ct-dashboard');
    });

    it('includes submodule entries in unmatched paths when NO architecture persona is active', () => {
      const effectiveFiles = [
        { path: 'ct-dashboard', mode: '160000' },
        { path: 'auth/login.ts', mode: '100644' },
      ];

      // Only security persona active: ct-dashboard is uncovered
      const unmatched = computeUnmatchedPaths(effectiveFiles, [secPersona]);

      expect(unmatched).toEqual(['ct-dashboard']);
      expect(unmatched).not.toContain('auth/login.ts');
    });

    it('excludes documentation and asset paths from unmatched list', () => {
      const effectiveFiles = [
        { path: 'docs/guide.md', mode: '100644' },
        { path: 'assets/logo.png', mode: '100644' },
      ];

      const unmatched = computeUnmatchedPaths(effectiveFiles, []);
      expect(unmatched).toHaveLength(0);
    });
  });

  describe('domain index .gitmodules mapping', () => {
    it('.gitmodules resolves to infra -> architecture, devops, security', () => {
      const index = loadCompiledIndex();
      const resolution = resolveFileDomains('.gitmodules', index);
      expect(resolution.matched).toBe(true);
      expect(resolution.classes).toContain('infra');
      expect(resolution.personas).toContain('architecture');
      expect(resolution.personas).toContain('security');
      expect(resolution.personas).toContain('devops');
    });
  });

  describe('deriveApplicablePersonas with submodules', () => {
    it('applies architecture persona when changed files contain a submodule gitlink', () => {
      const personas = [
        { id: 'security', name: 'Security', enabled: true, paths: ['auth/**'] },
        { id: 'architecture', name: 'Architecture', enabled: true, paths: ['arch/**'] },
        { id: 'devops', name: 'DevOps', enabled: true, paths: ['deploy/**'] },
      ] as any;

      const files = [{ path: 'ct-dashboard', mode: '160000' }];
      const result = deriveApplicablePersonas(personas, files);
      expect(result.map((p: any) => p.id)).toEqual(['architecture']);
    });

    it('does not apply non-architecture personas for standalone submodule changes', () => {
      const personas = [
        { id: 'security', name: 'Security', enabled: true, paths: ['auth/**'] },
        { id: 'frontend', name: 'Frontend', enabled: true, paths: ['src/**/*.vue'] },
      ] as any;

      const files = [{ path: 'cisco-cdr', isSubmodule: true }];
      const result = deriveApplicablePersonas(personas, files);
      expect(result).toHaveLength(0);
    });
  });
});


