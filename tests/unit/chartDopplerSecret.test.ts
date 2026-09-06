import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const chartDir = path.resolve(__dirname, '../../charts/review-yeti');

function render(...setArgs: string[]): string {
  return execFileSync('helm', ['template', 'rv', chartDir, ...setArgs], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function helmAvailable(): boolean {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// The chart is the only supported way to change this cluster's manifests, so the
// projection has to be asserted where it is declared rather than against a live
// namespace.
describe.skipIf(!helmAvailable() || !existsSync(chartDir))('review-yeti chart Doppler projection', () => {
  it('renders no DopplerSecret by default', () => {
    // Enabling it requires the Doppler operator plus an out-of-band service-token
    // Secret; a chart that projected credentials by default would fail to install
    // on any cluster without them.
    expect(render()).not.toContain('kind: DopplerSecret');
  });

  it('projects the gateway credential through the operator when enabled', () => {
    const rendered = render('--set', 'doppler.enabled=true');
    expect(rendered).toContain('kind: DopplerSecret');
    expect(rendered).toContain('project: "ct-llm-gateway"');
    expect(rendered).toContain('config: "prd"');
    // The operator must keep re-reading Doppler: the gateway credential is a
    // Bifrost virtual key that can be revoked upstream, and a one-shot copy goes
    // stale silently (the cluster copy was already found revoked once while the
    // GitHub copy still worked, so nothing observed the rot).
    expect(rendered).toMatch(/resyncSeconds:\s*\d+/u);
  });

  it('never renders a Doppler token into a manifest', () => {
    // The token is referenced by Secret name only. Rendering one into the chart
    // would put a long-lived credential into Helm release history and any values
    // file that sets it.
    const rendered = render('--set', 'doppler.enabled=true');
    expect(rendered).toContain('name: doppler-token-secret');
    expect(rendered).not.toMatch(/serviceToken\s*:/u);
    expect(rendered).not.toMatch(/dp\.st\./u);
  });
});
