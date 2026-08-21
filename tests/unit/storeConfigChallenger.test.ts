import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DashboardStore } from '../../src/store/dashboardStore';
import { ConfigResolver, RepositoryContentClient } from '../../src/config/configResolver';

describe('Challenger 2: Store & Config Hierarchy Empirical Verification', () => {
  const tmpStoreFile = path.join(process.cwd(), 'fixtures/tmp/test_challenger2_store.json');
  let store: DashboardStore;

  beforeEach(() => {
    const dir = path.dirname(tmpStoreFile);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {}
    }
    if (fs.existsSync(tmpStoreFile)) {
      try {
        fs.unlinkSync(tmpStoreFile);
      } catch {}
    }
    store = new DashboardStore(tmpStoreFile);
  });

  afterEach(() => {
    if (fs.existsSync(tmpStoreFile)) {
      try {
        fs.unlinkSync(tmpStoreFile);
      } catch {}
    }
  });

  describe('1. dashboardStore.getSettings() Schema Defaults', () => {
    it('returns defaultMaxTurns = 20 and defaultEffort = "low"', () => {
      const settings = store.getSettings();
      expect(settings).toBeDefined();
      expect(settings.defaultMaxTurns).toBe(20);
      expect(settings.defaultEffort).toBe('low');
    });
  });

  describe('2. dashboardStore.getPersonaSettings() Defaults', () => {
    it('returns default maxTurns = 20 for all initial personas', () => {
      const personaSettings = store.getPersonaSettings();
      const keys = Object.keys(personaSettings);
      expect(keys.length).toBeGreaterThan(0);

      for (const [key, persona] of Object.entries(personaSettings)) {
        expect(persona).toBeDefined();
        expect(persona.maxTurns).toBe(20);
      }
    });
  });

  describe('3. dashboardStore.updatePersonaSetting() Persistence & Validation', () => {
    it('successfully persists valid maxTurns (1..20)', () => {
      // Test minimum boundary: 1
      const updatedLow = store.updatePersonaSetting('security', { maxTurns: 1 });
      expect(updatedLow.maxTurns).toBe(1);
      expect(store.getPersonaSetting('security')?.maxTurns).toBe(1);

      // Test mid value: 12
      const updatedMid = store.updatePersonaSetting('security', { maxTurns: 12 });
      expect(updatedMid.maxTurns).toBe(12);
      expect(store.getPersonaSetting('security')?.maxTurns).toBe(12);

      // Test maximum boundary: 20
      const updatedHigh = store.updatePersonaSetting('security', { maxTurns: 20 });
      expect(updatedHigh.maxTurns).toBe(20);
      expect(store.getPersonaSetting('security')?.maxTurns).toBe(20);
    });

    it('throws errors on invalid maxTurns values (0, 21, negative, floats, non-integers)', () => {
      // 0
      expect(() => {
        store.updatePersonaSetting('security', { maxTurns: 0 });
      }).toThrow(/maxTurns for 'security' must be an integer between 1 and 20/);

      // 21
      expect(() => {
        store.updatePersonaSetting('security', { maxTurns: 21 });
      }).toThrow(/maxTurns for 'security' must be an integer between 1 and 20/);

      // Negative number
      expect(() => {
        store.updatePersonaSetting('security', { maxTurns: -1 });
      }).toThrow(/maxTurns for 'security' must be an integer between 1 and 20/);

      // Floating point number (10.5)
      expect(() => {
        store.updatePersonaSetting('security', { maxTurns: 10.5 });
      }).toThrow(/maxTurns for 'security' must be an integer between 1 and 20/);

      // Non-number string
      expect(() => {
        store.updatePersonaSetting('security', { maxTurns: '10' as any });
      }).toThrow(/maxTurns for 'security' must be an integer between 1 and 20/);
    });
  });

  describe('4. configResolver.ts Configuration Resolution Hierarchy', () => {
    const createMockClient = (files: Record<string, string>): RepositoryContentClient => ({
      getFileContent: async (_owner: string, _repo: string, path: string) => {
        return files[path] || null;
      },
    });

    it('falls back to System default_max_turns = 20 when no Org or Repo config is defined', async () => {
      const resolver = new ConfigResolver();
      const client = createMockClient({});

      const config = await resolver.resolveConfig({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        client,
      });

      expect(config.default_max_turns).toBe(20);
      expect(config.reviews.default_max_turns).toBe(20);
    });

    it('merges Org default_max_turns over System config when Repo has no default_max_turns', async () => {
      const resolver = new ConfigResolver();
      const client = createMockClient({
        // Org config (.github repository)
        '.ct-review.yaml': `
version: 3
default_max_turns: 15
`,
      });

      const config = await resolver.resolveConfig({
        owner: 'calltelemetry',
        repo: 'cisco-cdr', // requesting repo cisco-cdr, mock client returns .ct-review.yaml for .github
        client: {
          getFileContent: async (owner: string, repo: string, path: string) => {
            if (repo === '.github' && path === '.ct-review.yaml') {
              return 'version: 3\ndefault_max_turns: 15\n';
            }
            return null;
          },
        },
      });

      expect(config.default_max_turns).toBe(15);
      expect(config.reviews.default_max_turns).toBe(15);
    });

    it('merges Repo default_max_turns over Org and System config (Repo > Org > System)', async () => {
      const resolver = new ConfigResolver();
      const client: RepositoryContentClient = {
        getFileContent: async (_owner: string, repo: string, path: string) => {
          if (repo === 'cisco-cdr' && path === '.ct-review.yaml') {
            return 'version: 3\ndefault_max_turns: 8\n';
          }
          if (repo === '.github' && path === '.ct-review.yaml') {
            return 'version: 3\ndefault_max_turns: 15\n';
          }
          return null;
        },
      };

      const config = await resolver.resolveConfig({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        client,
      });

      expect(config.default_max_turns).toBe(8);
      expect(config.reviews.default_max_turns).toBe(8);
    });

    it('supports reviews.default_max_turns nested hierarchy override (Repo > Org > System)', async () => {
      const resolver = new ConfigResolver();
      const client: RepositoryContentClient = {
        getFileContent: async (_owner: string, repo: string, path: string) => {
          if (repo === 'cisco-cdr' && path === '.ct-review.yaml') {
            return `
version: 3
reviews:
  default_max_turns: 5
`;
          }
          if (repo === '.github' && path === '.ct-review.yaml') {
            return `
version: 3
reviews:
  default_max_turns: 12
`;
          }
          return null;
        },
      };

      const config = await resolver.resolveConfig({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        client,
      });

      expect(config.default_max_turns).toBe(5);
      expect(config.reviews.default_max_turns).toBe(5);
    });
  });
});
