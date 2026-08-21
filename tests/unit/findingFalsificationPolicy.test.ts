import { describe, expect, it } from 'vitest';

import { resolveFindingFalsificationPolicy } from '../../.github/workflows/pipelines/review-pipeline';

function localConfig(value: unknown) {
  return { parsed: { review: { finding_falsification: value } } };
}

describe('resolveFindingFalsificationPolicy', () => {
  it('is off unless explicitly configured', () => {
    expect(resolveFindingFalsificationPolicy({ localConfig: { parsed: {} }, env: {} })).toMatchObject({ enabled: false, reason: 'not_configured' });
    expect(resolveFindingFalsificationPolicy({ localConfig: localConfig(false), env: {} })).toMatchObject({ enabled: false, reason: 'disabled_by_config' });
    expect(resolveFindingFalsificationPolicy({ localConfig: localConfig('yes'), env: {} })).toMatchObject({ enabled: false, reason: 'invalid_config' });
  });

  it('enables via true or an object, carrying limits through', () => {
    expect(resolveFindingFalsificationPolicy({ localConfig: localConfig(true), env: {} })).toMatchObject({ enabled: true });
    const policy = resolveFindingFalsificationPolicy({ localConfig: localConfig({ limits: { maxCalls: 3 } }), env: {} });
    expect(policy).toMatchObject({ enabled: true, limits: { maxCalls: 3 } });
  });

  it('honors the environment kill-switch', () => {
    const policy = resolveFindingFalsificationPolicy({ localConfig: localConfig(true), env: { REVIEW_YETI_FINDING_FALSIFICATION: 'false' } });
    expect(policy).toMatchObject({ enabled: false, reason: 'disabled_by_env' });
  });
});
