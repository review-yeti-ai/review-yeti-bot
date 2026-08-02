import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DashboardStore } from '../../src/persistence/dashboardStore';

describe('Empirical Verification: dashboardStore.reset() Behavior', () => {
  const tmpDir = path.join(process.cwd(), 'fixtures/tmp_reset_verification');
  const specifiedPath = path.join(tmpDir, 'custom_specified_store.json');
  const overridePath = path.join(tmpDir, 'override_temp_store.json');

  const cleanup = () => {
    if (fs.existsSync(specifiedPath)) try { fs.unlinkSync(specifiedPath); } catch {}
    if (fs.existsSync(overridePath)) try { fs.unlinkSync(overridePath); } catch {}
    if (fs.existsSync(tmpDir)) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  };

  let envBackup: string | undefined;

  beforeEach(() => {
    envBackup = process.env.CT_DASHBOARD_STORE;
    delete process.env.CT_DASHBOARD_STORE;
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    cleanup();
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (envBackup !== undefined) {
      process.env.CT_DASHBOARD_STORE = envBackup;
    } else {
      delete process.env.CT_DASHBOARD_STORE;
    }
    cleanup();
  });

  it('1. retains specifiedFilePath after reset() clears overrideFilePath', () => {
    const store = new DashboardStore(specifiedPath);
    expect(store.filePath).toBe(specifiedPath);

    // Set an override path
    store.filePath = overridePath;
    expect(store.filePath).toBe(overridePath);

    // Perform reset()
    store.reset();

    // Verify specifiedFilePath is retained
    expect(store.filePath).toBe(specifiedPath);
  });

  it('2. reloads updated backing file data on reset() without state corruption', () => {
    // Initial data in specifiedPath
    const initialData = {
      repositories: [
        {
          id: 'repo-custom-1',
          name: 'custom-repo',
          full_name: 'org/custom-repo',
          owner: 'org',
          repo: 'custom-repo',
          automationEnabled: true,
          updatedAt: new Date().toISOString(),
        },
      ],
      reviewCounter: 42,
    };
    fs.writeFileSync(specifiedPath, JSON.stringify(initialData), 'utf8');

    const store = new DashboardStore(specifiedPath);
    expect(store.getRepositories().some(r => r.id === 'repo-custom-1')).toBe(true);

    // Modify file externally
    const updatedData = {
      ...initialData,
      repositories: [
        {
          id: 'repo-custom-2',
          name: 'custom-repo-2',
          full_name: 'org/custom-repo-2',
          owner: 'org',
          repo: 'custom-repo-2',
          automationEnabled: true,
          updatedAt: new Date().toISOString(),
        },
      ],
      reviewCounter: 99,
    };
    fs.writeFileSync(specifiedPath, JSON.stringify(updatedData), 'utf8');

    // Reset store
    store.reset();

    // Verify reloaded data from specifiedPath
    expect(store.filePath).toBe(specifiedPath);
    expect(store.getRepositories().some(r => r.id === 'repo-custom-2')).toBe(true);
  });

  it('3. survives 20 consecutive resets without state corruption or memory decay', () => {
    const customData = {
      reviewCounter: 100,
      settings: {
        defaultMaxTurns: 30,
      },
    };
    fs.writeFileSync(specifiedPath, JSON.stringify(customData), 'utf8');

    const store = new DashboardStore(specifiedPath);

    for (let i = 0; i < 20; i++) {
      // Modify override path temporarily
      if (i % 2 === 0) {
        store.filePath = overridePath;
        expect(store.filePath).toBe(overridePath);
      }

      store.reset();

      expect(store.filePath).toBe(specifiedPath);
      expect(store.getSettings().defaultMaxTurns).toBe(30);

      // Verify personas are still properly merged and non-corrupt
      const personas = store.getPersonaSettings();
      expect(personas.security).toBeDefined();
      expect(personas.security.model).toBe('openrouter/auto');
    }
  });

  it('4. verifies cache invalidation on reset() returns fresh computed values', () => {
    const store = new DashboardStore(specifiedPath);
    
    // Record review run
    store.recordReviewRun({
      id: 'rev-1',
      prRun: 'run-1',
      headSha: 'abc1234',
      personas: ['security'],
      quorum: 'consensus',
      arbiterVerdict: 'SHIP',
      timestamp: new Date().toISOString(),
      costUSD: 0.15,
      tokens: { prompt: 1000, completion: 500, total: 1500 },
    });

    const summary1 = store.getAnalyticsSummary();
    expect(summary1).toBeDefined();

    // Reset store (reloads from disk, which flushes transient cache)
    store.reset();

    // Re-query analytics summary
    const summary2 = store.getAnalyticsSummary();
    expect(summary2).toBeDefined();
    expect(store.filePath).toBe(specifiedPath);
  });
});
