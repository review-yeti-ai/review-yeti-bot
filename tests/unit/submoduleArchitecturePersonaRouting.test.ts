import { describe, expect, it } from 'vitest';
import { isSubmoduleEntry, isArchitecturePersona } from '../../src/panel/panelEngine';
import { deriveApplicablePersonas } from '../../src/review/personaApplicability';
import { loadCompiledIndex, resolveFileDomains } from '../../src/pipeline/domainIndex';

describe('Submodule Architecture Persona Routing', () => {
  describe('isSubmoduleEntry', () => {
    it('identifies gitlink mode 160000 entries as submodules', () => {
      expect(isSubmoduleEntry({ path: 'ct-dashboard', mode: '160000' })).toBe(true);
      expect(isSubmoduleEntry({ path: 'cisco-cdr', newMode: '160000' })).toBe(true);
      expect(isSubmoduleEntry({ path: 'ct-meta', old_mode: '160000' })).toBe(true);
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
    it('matches architecture persona variants', () => {
      expect(isArchitecturePersona({ id: 'architecture' })).toBe(true);
      expect(isArchitecturePersona({ id: 'arch-lane' })).toBe(true);
      expect(isArchitecturePersona({ id: 'custom-arch', name: 'System Architecture' })).toBe(true);
      expect(isArchitecturePersona({ id: 'custom', charter: 'builtin:architecture' })).toBe(true);
    });

    it('rejects non-architecture personas', () => {
      expect(isArchitecturePersona({ id: 'security', charter: 'builtin:security' })).toBe(false);
      expect(isArchitecturePersona({ id: 'sec-lane', charter: 'builtin:security' })).toBe(false);
      expect(isArchitecturePersona({ id: 'documentation', charter: 'builtin:documentation' })).toBe(false);
      expect(isArchitecturePersona({ id: 'qual-lane', charter: 'builtin:consistency' })).toBe(false);
      expect(isArchitecturePersona(null)).toBe(false);
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

