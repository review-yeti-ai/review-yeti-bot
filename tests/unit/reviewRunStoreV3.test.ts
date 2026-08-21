import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewRunStore } from '../../src/persistence/reviewRunStore';

describe('persistent webhook and exact-head state', () => {
  let directory = '';
  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('rejects webhook replay after process restart', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-review-store-'));
    const file = path.join(directory, 'runs.json');
    expect(new ReviewRunStore(file).claimDelivery('delivery-1')).toBe(true);
    expect(new ReviewRunStore(file).claimDelivery('delivery-1')).toBe(false);
  });

  it('invalidates cached exact-head evidence when a new head is marked', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-review-store-'));
    const store = new ReviewRunStore(path.join(directory, 'runs.json'));
    store.markHead('calltelemetry', 'ct-meta', 1, 'old');
    expect(store.isCurrentHead('calltelemetry', 'ct-meta', 1, 'old')).toBe(true);
    store.markHead('calltelemetry', 'ct-meta', 1, 'new');
    expect(store.isCurrentHead('calltelemetry', 'ct-meta', 1, 'old')).toBe(false);
    expect(store.isCurrentHead('calltelemetry', 'ct-meta', 1, 'new')).toBe(true);
  });
});
