import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

/**
 * The Action pins its dispatch endpoint: `validateDispatchEndpoint` requires the
 * exact hosted origin and path. Documentation that promises a reader can point
 * Kubernetes Mode at "your own cluster" therefore describes something the code
 * refuses, and a reader following it deploys the chart and waits for reviews that
 * can never arrive.
 *
 * These assertions are deliberately narrow: they pin the *contradiction*, not the
 * prose. If the endpoint ever becomes configurable, the code change lands first
 * and these are updated with it.
 */
describe('Kubernetes Mode documentation matches enforced behaviour', () => {
  it('pins the endpoint in code, so the docs must not promise arbitrary clusters', () => {
    const dispatch = read('scripts/dispatch-doks-action.mjs');
    // The premise of the whole test: if this ever stops being true, revisit.
    expect(dispatch).toContain('url.origin === expected.origin');
    expect(dispatch).toContain('url.pathname === expected.pathname');
  });

  it('does not advertise pointing the worker at a cluster the reader operates', () => {
    // Pattern families, not the two literals this PR deleted. The property is
    // "the docs must not promise the reader can point Kubernetes Mode at their own
    // cluster", and a reworded claim -- "run the panel on worker pods in your EKS
    // cluster", "deploy the chart into your infrastructure" -- reintroduces exactly
    // that promise. Forbidding only the removed strings would be evaded by the very
    // edit this guard exists to catch.
    const doc = read('docs/KUBERNETES_MODE.md');
    const claims = [
      /\b(your|their)\s+(own\s+)?(cluster|infrastructure|kubernetes)\b/iu,
      /\b(EKS|GKE|AKS)\b/u,
      /\bany\s+(vanilla\s+)?(K8s|Kubernetes)\s+cluster\b/iu,
      /\bself[- ]host(ing|ed)?\b/iu,
    ];
    // Blockquotes are excluded wholesale: the callouts exist to say the endpoint is
    // fixed, and stating the limitation necessarily names the thing being ruled out.
    // Prose outside a callout has no such excuse.
    const withoutCallout = doc.split('\n').filter((line) => !line.trimStart().startsWith('>')).join('\n');
    for (const claim of claims) {
      expect(withoutCallout, `docs promise matching ${claim}`).not.toMatch(claim);
    }
  });

  it('states plainly that the endpoint is fixed', () => {
    // A reader must be able to learn this without reading the dispatch script.
    const doc = read('docs/KUBERNETES_MODE.md');
    expect(doc).toMatch(/dispatch endpoint is fixed/iu);
    expect(doc).toContain('validateDispatchEndpoint');
  });

  it('does not title the chart section as self-hosting, and says the chart alone is inert', () => {
    // Semantic anchor, not exact prose: "…will not receive reviews until the
    // endpoint is configurable" is a correct edit and must not fail. Pinning the
    // sentence would train maintainers to update the test mechanically rather than
    // check the property.
    const readme = read('README.md');
    expect(readme).not.toMatch(/Self-Hosting with Official Helm 3 Chart/u);
    expect(readme).toMatch(/will not receive reviews/iu);
    expect(readme).toContain('docs/KUBERNETES_MODE.md');
  });
});
