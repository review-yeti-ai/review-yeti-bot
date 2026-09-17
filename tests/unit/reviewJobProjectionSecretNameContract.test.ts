import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { buildRunSecretName, deriveRunSecretExecutionAttempt } from '../../src/k8s/reviewJobProjection';

// REL-896: the run-secret naming contract is defined once, canonically, by
// buildRunSecretName here, and re-implemented as a Go regex
// (job.IsValidRunSecretName, k8s-operator/pkg/job/job.go) that gates the
// v1alpha2 operator's Secret-delete finalizer (reconcileRunSecretDeletion in
// prreviewjob_v1alpha2_controller.go). If the two drift, the operator
// silently stops recognizing -- and therefore stops deleting -- a run Secret
// it should own, leaking a credential Secret on every affected run. This
// fixture is the single source both languages assert against;
// k8s-operator/pkg/job/run_secret_names_fixture_test.go loads the identical
// file. Regenerate the fixture's `valid` names from buildRunSecretName
// whenever the naming scheme changes here, then fix job.go's
// secretNamePattern until the Go test in that file goes green again.
const fixturePath = path.resolve(__dirname, '../../k8s-operator/pkg/job/testdata/run_secret_names.json');

interface RunSecretNameFixture {
  valid: Array<{ runId: string; executionAttempt: number; name: string }>;
  invalid: string[];
}

function loadFixture(): RunSecretNameFixture {
  return JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
}

describe('run Secret naming contract fixture (REL-896)', () => {
  const fixture = loadFixture();
  // Every invalid fixture name fails runSecretNamePattern's shape on its own,
  // so which runId it is checked against does not matter for these
  // assertions -- any runId that itself satisfies runIdPattern will do.
  const probeRunId = 'run_11111111111111111111111111111111';

  it('declares at least one valid and one invalid entry', () => {
    expect(fixture.valid.length).toBeGreaterThan(0);
    expect(fixture.invalid.length).toBeGreaterThan(0);
  });

  it.each(fixture.valid.map((entry) => [entry.runId, entry.executionAttempt, entry.name] as const))(
    'buildRunSecretName(%s, %i) matches the golden fixture',
    (runId, executionAttempt, expected) => {
      expect(buildRunSecretName(runId, executionAttempt)).toBe(expected);
    },
  );

  it('every golden valid name round-trips through deriveRunSecretExecutionAttempt', () => {
    for (const entry of fixture.valid) {
      expect(deriveRunSecretExecutionAttempt(entry.runId, entry.name)).toBe(entry.executionAttempt);
    }
  });

  it.each(fixture.invalid)('deriveRunSecretExecutionAttempt rejects invalid name %j', (name) => {
    expect(deriveRunSecretExecutionAttempt(probeRunId, name)).toBeUndefined();
  });
});
