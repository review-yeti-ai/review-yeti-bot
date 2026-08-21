import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ReviewRunStore } from '../../src/persistence/reviewRunStore';

describe('reviewRunStore.ts — Comprehensive Unit Expansion Tests', () => {
  let tmpDir: string;
  let tmpPath: string;
  let store: ReviewRunStore;

  beforeEach(() => {
    const baseDir = path.resolve(__dirname, '../../node_modules/.cache/store-tests');
    fs.mkdirSync(baseDir, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(baseDir, 'run-'));
    tmpPath = path.join(tmpDir, 'review-runs.json');
    store = new ReviewRunStore(tmpPath);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('reads non-existent file cleanly and initializes empty data structures', () => {
    expect(store.getHead(100)).toBeUndefined();
    expect(store.getPreviousHead(100)).toBeUndefined();
  });

  it('recovers gracefully when reading corrupted JSON file', () => {
    const corruptPath = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(corruptPath, '{ invalid JSON file content ...');

    const corruptStore = new ReviewRunStore(corruptPath);
    expect(corruptStore.getHead(1)).toBeUndefined();
    expect(corruptStore.claimDelivery('del-corrupt')).toBe(true);
  });

  it('claimDelivery claims delivery IDs once and rejects duplicates', () => {
    expect(store.claimDelivery('delivery-1')).toBe(true);
    expect(store.claimDelivery('delivery-1')).toBe(false);
    expect(store.claimDelivery('')).toBe(false);
  });

  it('persists data to disk atomically', () => {
    store.claimDelivery('persisted-del-123');
    expect(fs.existsSync(tmpPath)).toBe(true);

    const reloadedStore = new ReviewRunStore(tmpPath);
    expect(reloadedStore.claimDelivery('persisted-del-123')).toBe(false);
  });

  it('setHead and markHead track current and previous head SHAs', () => {
    const owner = 'calltelemetry';
    const repo = 'ct-bot';
    const prNumber = 77;

    store.markHead(owner, repo, prNumber, 'head-v1');
    expect(store.getHead(owner, repo, prNumber)).toBe('head-v1');
    expect(store.isCurrentHead(owner, repo, prNumber, 'head-v1')).toBe(true);
    expect(store.getPreviousHead(owner, repo, prNumber)).toBeUndefined();

    store.markHead(owner, repo, prNumber, 'head-v2');
    expect(store.getHead(owner, repo, prNumber)).toBe('head-v2');
    expect(store.getPreviousHead(owner, repo, prNumber)).toBe('head-v1');
    expect(store.isCurrentHead(owner, repo, prNumber, 'head-v1')).toBe(false);
    expect(store.isCurrentHead(owner, repo, prNumber, 'head-v2')).toBe(true);
  });

  it('recordThread and resolveThread manage thread states', () => {
    const prNumber = 88;
    const filePath = 'src/app.ts';
    const line = 15;
    const title = 'Unused variable';

    store.recordThread(prNumber, filePath, line, title, 'ACTIVE');

    const activeFindings = [{ filePath, lineNumber: line, title }];
    expect(store.filterResolvedNits(prNumber, activeFindings)).toHaveLength(0);

    store.resolveThread(prNumber, filePath, line, title);
    const resolvedFindings = [{ filePath, lineNumber: line, title }];
    expect(store.filterResolvedNits(prNumber, resolvedFindings)).toHaveLength(0);
  });

  it('recordThreads processes batch findings correctly', () => {
    const prNumber = 99;
    const batch = [
      { filePath: 'src/a.ts', lineNumber: 10, title: 'Issue 1' },
      { filePath: 'src/b.ts', lineNumber: 20, title: 'Issue 2' },
    ];

    store.recordThreads(prNumber, batch);

    expect(store.filterResolvedNits(prNumber, batch)).toHaveLength(0);
  });

  it('filterResolvedNits returns unrecorded findings', () => {
    const prNumber = 101;
    const newFindings = [{ filePath: 'src/new.ts', lineNumber: 5, title: 'New finding' }];

    const filtered = store.filterResolvedNits(prNumber, newFindings);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].filePath).toBe('src/new.ts');
  });

  it('filterResolvedNits returns empty array for non-array input', () => {
    expect(store.filterResolvedNits(1, null as any)).toEqual([]);
    expect(store.filterResolvedNits(1, undefined as any)).toEqual([]);
  });
});
