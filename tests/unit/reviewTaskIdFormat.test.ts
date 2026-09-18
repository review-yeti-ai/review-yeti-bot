import { describe, it, expect } from 'vitest';
import { isValidTaskId } from '../../src/panel/reviewTask';

// publishingReview.ts's `isRosterId` is not exported, so pin the shared format here: if someone
// re-declares a second regex in either module, these cases are what catch the drift.
describe('task id format is the roster id format', () => {
  it('accepts every id shape the roster accepts', () => {
    for (const id of ['a', 'security', 'sec-lane', 'arch_lane', 'a'.repeat(128), 'x0', 'q-9_z']) {
      expect(isValidTaskId(id), id).toBe(true);
    }
  });
  it('rejects everything the roster rejects', () => {
    for (const id of ['', 'A', '0lead', '-lead', '_lead', 'has space', 'has.dot', 'a'.repeat(129), 'ünicode', null, undefined, 7, {}]) {
      expect(isValidTaskId(id as any), String(id)).toBe(false);
    }
  });
});
