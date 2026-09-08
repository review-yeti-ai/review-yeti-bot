import { describe, it, expect } from 'vitest';
const {
  computeArbitration,
  downgradeUnverifiedPremise,
  hasUnverifiedPremise,
} = require('../../src/review/reviewCore.js');
import { renderFindingsMarkdown } from '../../src/cli/publishingReview';

// Three false P1s from calltelemetry/ct-meta#2882, verbatim. Each states its own premise was
// never confirmed and asks the author to do the verification -- a question, not a defect.
const FALSE_P1_UNUSED_CONSTANT = {
  severity: 'P1',
  path: 'domains/darkFactory/pipeline.js',
  line: 42,
  title: 'Possible dead constant STEP_ADVERSARIAL',
  body:
    'If any later code in runDarkFactoryPipeline still references STEP_ADVERSARIAL after this '
    + 'change, this is a ReferenceError at runtime. Verify no remaining references exist; if '
    + 'unused, this is a dead-constant cleanup.',
};

const FALSE_P1_UNCONFIRMED_IMPORT = {
  severity: 'P1',
  path: 'domains/darkFactory/steps.js',
  line: 7,
  title: 'DARK_FACTORY_STEP_IDS may be undefined',
  body:
    'no import/require of DARK_FACTORY_STEP_IDS visible in this diff, and repo tooling could not '
    + 'confirm a pre-existing import. If the import already exists, this finding can be dismissed '
    + 'on verification; as submitted, the diff is not self-contained proof.',
};

const FALSE_P1_UNLOCATED_TABLE = {
  severity: 'P1',
  path: 'domains/darkFactory/keys.js',
  line: 15,
  title: 'Possible key-name mismatch in step table',
  body:
    "The table's definition could not be located to confirm these exact key names exist. A "
    + 'key-name mismatch would yield undefined step IDs silently.',
};

const FALSE_P1S = [FALSE_P1_UNUSED_CONSTANT, FALSE_P1_UNCONFIRMED_IMPORT, FALSE_P1_UNLOCATED_TABLE];

// A genuine P1 from the same day (calltelemetry/ct-meta#2882): a defect the reviewer verified
// against code it read, with no hedge on its own premise. Must never be downgraded.
const GENUINE_P1_KUBE_TIMEOUT = {
  severity: 'P1',
  path: 'src/k8s/kubernetesApiClient.ts',
  line: 88,
  title: 'KubernetesApiClient has no request timeout, can hang a Forbid CronJob indefinitely',
  body:
    "KubernetesApiClient.request() wraps httpsRequest in a Promise that only rejects on "
    + "connection 'error'; there is no timeout on socket idle or response, so a hung "
    + 'kube-apiserver leaves listPods/getPod/deletePod pending indefinitely. Combined with the '
    + 'CronJob having concurrencyPolicy Forbid, one stalled run can pin the schedule '
    + 'indefinitely.',
};

const changedFiles = [
  { path: 'domains/darkFactory/pipeline.js', patch: '@@ -1,3 +1,50 @@\n' + Array.from({ length: 50 }, () => ' x').join('\n') },
  { path: 'domains/darkFactory/steps.js', patch: '@@ -1,3 +1,20 @@\n' + Array.from({ length: 20 }, () => ' x').join('\n') },
  { path: 'domains/darkFactory/keys.js', patch: '@@ -1,3 +1,30 @@\n' + Array.from({ length: 30 }, () => ' x').join('\n') },
  { path: 'src/k8s/kubernetesApiClient.ts', patch: '@@ -1,3 +1,150 @@\n' + Array.from({ length: 150 }, () => ' x').join('\n') },
];

describe('downgradeUnverifiedPremise (unit)', () => {
  it.each(FALSE_P1S)('downgrades a hedged P1 to P2 with downgrade_reason set: %#', (raw) => {
    const finding = { ...raw };
    const result = downgradeUnverifiedPremise(finding);
    expect(result.severity).toBe('P2');
    expect(result.downgrade_reason).toBe('unverified_premise');
    expect(result.downgradedFrom).toBe('P1');
  });

  it('does not downgrade the genuine, verified P1', () => {
    const result = downgradeUnverifiedPremise({ ...GENUINE_P1_KUBE_TIMEOUT });
    expect(result.severity).toBe('P1');
    expect(result.downgrade_reason).toBeUndefined();
  });

  it('leaves a P2 with a hedge phrase untouched (no double-processing)', () => {
    const p2Hedge = {
      severity: 'P2',
      path: 'domains/darkFactory/pipeline.js',
      line: 3,
      title: 'Minor: unclear naming',
      body: 'The helper name could not be verified against style guide precedent; consider renaming.',
    };
    const result = downgradeUnverifiedPremise(p2Hedge);
    expect(result.severity).toBe('P2');
    expect(result.downgrade_reason).toBeUndefined();
    expect(result.downgradedFrom).toBeUndefined();
    // Object identity: an already-P2 finding must pass through unmodified, not merely
    // equal-by-value, so a caller cannot accidentally rely on a cloned copy.
    expect(result).toBe(p2Hedge);
  });

  it('hasUnverifiedPremise matches every documented phrase category', () => {
    expect(hasUnverifiedPremise('could not be located anywhere in this repo')).toBe(true);
    expect(hasUnverifiedPremise('If any later code in the pipeline still references X')).toBe(true);
    expect(hasUnverifiedPremise('there is no timeout on socket idle or response')).toBe(false);
  });
});

describe('computeArbitration with the unverified-premise downgrade wired in', () => {
  it('the three false P1s from ct-meta#2882 all downgrade and arbitration ships', () => {
    const personas = [{ findings: FALSE_P1S.map((f) => ({ ...f })) }];
    const arbitration = computeArbitration(personas, 1, { changedFiles });
    expect(arbitration.metrics.p1Count).toBe(0);
    expect(arbitration.verdict).toBe('SHIP');
    for (const finding of arbitration.findings) {
      expect(finding.severity).toBe('P2');
      expect(finding.downgrade_reason).toBe('unverified_premise');
      expect(finding.downgradedFrom).toBe('P1');
    }
  });

  it('COUNTERFACTUAL: without the downgrade, the same three false P1s block the merge', () => {
    // Proves the test above is actually exercising the new behaviour: strip the downgrade by
    // clustering the raw (undowngraded) findings the same way computeArbitration does internally,
    // bypassing downgradeUnverifiedPremise entirely.
    const { clusterFindings, calibrateSeverity } = require('../../src/review/reviewCore.js');
    const rawFindings = FALSE_P1S.map((f) => ({ ...f }));
    const findings = clusterFindings(rawFindings.map(calibrateSeverity));
    const p1Count = findings.filter((f: { severity: string }) => f.severity === 'P1').length;
    expect(p1Count).toBe(3);
    // A three-P1 single-lane panel meets blockP1 = max(3, ceil(1/2)) = 3, so this would BLOCK,
    // proving the downgrade above -- not some unrelated arbitration change -- is what ships it.
  });

  it('the genuine P1 is not downgraded and still produces FIX_FIRST', () => {
    const personas = [{ findings: [{ ...GENUINE_P1_KUBE_TIMEOUT }] }];
    const arbitration = computeArbitration(personas, 1, { changedFiles });
    expect(arbitration.metrics.p1Count).toBe(1);
    expect(arbitration.verdict).toBe('FIX_FIRST');
    expect(arbitration.findings[0].severity).toBe('P1');
    expect(arbitration.findings[0].downgrade_reason).toBeUndefined();
  });
});

describe('renderFindingsMarkdown shows the downgrade marker', () => {
  it('renders "**P2** (was P1 — unverified premise)" for a downgraded finding', () => {
    const downgraded = downgradeUnverifiedPremise({ ...FALSE_P1_UNLOCATED_TABLE });
    const markdown = renderFindingsMarkdown([downgraded], 0);
    expect(markdown).toContain('**P2** (was P1 — unverified premise)');
  });

  it('does not render a marker for an ordinary, non-downgraded finding', () => {
    const markdown = renderFindingsMarkdown([{ ...GENUINE_P1_KUBE_TIMEOUT }], 1);
    expect(markdown).not.toContain('unverified premise');
    expect(markdown).toContain('**P1**');
  });
});
