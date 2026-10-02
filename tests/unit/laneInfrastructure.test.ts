import { describe, expect, it } from 'vitest';
import {
  formatIncompleteInfrastructureDetail,
  renderIncompleteInfrastructureTitle,
  type IncompleteLaneDescription,
} from '../../src/review/laneInfrastructure';

describe('shared structured infrastructure lane detail', () => {
  it.each<[string, readonly IncompleteLaneDescription[], string]>([
    ['no lanes', [], 'lane failed'],
    ['one coded failure', [{ id: 'arch)lane', failureClass: 'transport)closed' }], 'lane arch)lane failed: transport)closed'],
    ['observed HTTP status', [{ id: 'test)lane', failureClass: 'provider_error)', providerStatus: 502 }], 'lane test)lane failed: 502'],
    ['multiple failures', [
      { id: 'arch)lane', failureClass: 'transport)closed' },
      { id: 'test-lane', failureClass: 'provider_error', providerStatus: 503 },
    ], 'lanes arch)lane transport)closed, test-lane 503 failed'],
    ['more than three failures', [
      { id: 'one', failureClass: 'transport' },
      { id: 'two', failureClass: 'timeout' },
      { id: 'three', failureClass: 'rate_limit', providerStatus: 429 },
      { id: 'four', failureClass: 'provider_error' },
    ], 'lanes one transport, two timeout, three 429, … failed'],
  ])('formats %s without parsing title punctuation', (_label, lanes, detail) => {
    expect(formatIncompleteInfrastructureDetail(lanes)).toBe(detail);
    expect(renderIncompleteInfrastructureTitle(lanes))
      .toBe(`Review Yeti: INCOMPLETE — infrastructure (${detail})`);
  });

  it('keeps structured detail untruncated while the rendered title owns its bound', () => {
    const lanes = [{ id: 'x'.repeat(240), failureClass: 'transport)closed' }];
    expect(formatIncompleteInfrastructureDetail(lanes))
      .toBe(`lane ${'x'.repeat(240)} failed: transport)closed`);
    const title = renderIncompleteInfrastructureTitle(lanes);
    expect(title).toHaveLength(140);
    expect(title).toMatch(/…\)$/u);
  });

  it('preserves the explicitly scheduled compatibility suffix, including empty lanes', () => {
    const retry = { nextAttempt: 2, maxAttempts: 3 };
    expect(renderIncompleteInfrastructureTitle([], retry))
      .toBe('Review Yeti: INCOMPLETE — infrastructure (lane failed); retrying as attempt 2 of 3');
    expect(renderIncompleteInfrastructureTitle([{ id: 'arch)lane', failureClass: 'transport)closed' }], retry))
      .toBe('Review Yeti: INCOMPLETE — infrastructure (lane arch)lane failed: transport)closed); retrying as attempt 2 of 3');
  });
});
