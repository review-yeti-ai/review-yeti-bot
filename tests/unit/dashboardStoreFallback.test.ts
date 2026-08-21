import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DashboardStore } from '../../src/persistence/dashboardStore';

describe('DashboardStore Fallback Path & Resiliency Suite', () => {
  const originalEnvStore = process.env.CT_DASHBOARD_STORE;
  const originalVitest = process.env.VITEST;

  beforeEach(() => {
    delete process.env.CT_DASHBOARD_STORE;
  });

  afterEach(() => {
    if (originalEnvStore !== undefined) {
      process.env.CT_DASHBOARD_STORE = originalEnvStore;
    } else {
      delete process.env.CT_DASHBOARD_STORE;
    }
    if (originalVitest !== undefined) {
      process.env.VITEST = originalVitest;
    }
  });

  it('1. falls back to /tmp/ct-review-bot/dashboard.json when no path provided and CT_DASHBOARD_STORE is unset', () => {
    const store = new DashboardStore();
    expect(store.getFilePath()).toMatch(/\/tmp\/ct-review-bot\/dashboard\.json$/);
  });

  it('2. prioritizes explicit filePath argument over CT_DASHBOARD_STORE environment variable', () => {
    process.env.CT_DASHBOARD_STORE = '/tmp/ct-review-bot/env_override.json';
    const explicitPath = '/tmp/ct-review-bot/explicit_override.json';
    const store = new DashboardStore(explicitPath);
    expect(store.getFilePath()).toBe(explicitPath);
    try { if (fs.existsSync(explicitPath)) fs.unlinkSync(explicitPath); } catch {}
    try { if (fs.existsSync(process.env.CT_DASHBOARD_STORE)) fs.unlinkSync(process.env.CT_DASHBOARD_STORE); } catch {}
  });

  it('3. uses CT_DASHBOARD_STORE environment variable when no explicit filePath argument is provided', () => {
    const envPath = '/tmp/ct-review-bot/env_store.json';
    process.env.CT_DASHBOARD_STORE = envPath;
    const store = new DashboardStore();
    expect(store.getFilePath()).toBe(envPath);
    try { if (fs.existsSync(envPath)) fs.unlinkSync(envPath); } catch {}
  });

  it('4. falls back gracefully to /tmp/ct-review-bot/dashboard.json when /app/data is not writable', () => {
    try {
      delete process.env.VITEST;
      const store = new DashboardStore();
      expect(store.getFilePath()).toContain('/tmp/ct-review-bot/dashboard.json');
    } finally {
      process.env.VITEST = originalVitest || 'true';
    }
  });
});
