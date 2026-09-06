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

describe('review-yeti chart publishing transport', () => {
  it('renders no transport by default so the operator refuses app-gate', () => {
    // An unset transport leaves the operator's publishing config incomplete and
    // BuildWorkerJob refuses every app-gate review. Defaulting a gateway URL here
    // would dispatch reviews against a gateway nobody chose.
    const rendered = render();
    expect(rendered).not.toContain('REVIEW_YETI_GATEWAY_BASE_URL');
    expect(rendered).not.toContain('REVIEW_YETI_REVIEW_MODEL');
  });

  it('passes the transport to the operator when configured', () => {
    const rendered = render(
      '--set', 'publishing.gatewayBaseUrl=https://llm-gateway.calltelemetry.com/v1',
      '--set', 'publishing.model=ollama/glm-5.3-flash',
    );
    expect(rendered).toContain('REVIEW_YETI_GATEWAY_BASE_URL');
    expect(rendered).toContain('https://llm-gateway.calltelemetry.com/v1');
    expect(rendered).toContain('ollama/glm-5.3-flash');
  });

  it('always points the operator at the Doppler-projected secret', () => {
    // The Secret name is a location, not a transport choice, so it may default --
    // and it must line up with the DopplerSecret this chart projects.
    const rendered = render();
    expect(rendered).toContain('review-yeti-gateway-credentials');
    expect(rendered).toContain('REVIEW_YETI_BIFROST_API_KEY');
  });
});


