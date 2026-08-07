import { describe, it, expect, beforeEach } from 'vitest';
import {
  legCoverageReported,
  openNotifyWithSelection,
  readFleetHandoff,
  csvCell,
  isMultiControlRuntimeEnabled,
  setCanary,
} from '../fixtures/smokeCharterDefects';

/**
 * Current behaviour of fleet helpers (including known product gaps under review).
 */
describe('charterDefectFixtures — current behaviour', () => {
  beforeEach(() => {
    setCanary(true);
    openNotifyWithSelection(['phone-a', 'phone-b']);
  });

  it('reports coverage when CMR array is non-empty', () => {
    expect(legCoverageReported([{}])).toBe('reported');
  });

  it('writes selection into handoff as provided', () => {
    expect(readFleetHandoff()).toEqual(['phone-a', 'phone-b']);
    openNotifyWithSelection([]);
    expect(readFleetHandoff()).toEqual([]);
  });

  it('quotes CSV cells', () => {
    expect(csvCell('=1+1')).toBe('"=1+1"');
  });

  it('returns canary while control plane is unavailable', () => {
    setCanary(true);
    expect(isMultiControlRuntimeEnabled(true)).toBe(true);
  });
});
