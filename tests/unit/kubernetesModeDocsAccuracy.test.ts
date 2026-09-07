import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

/**
 * The Action pins its dispatch endpoint: `validateDispatchEndpoint` requires the
 * exact hosted origin and path. Documentation promising a reader can point
 * Kubernetes Mode at a cluster they operate therefore describes something the code
 * refuses, and a reader following it deploys the chart and waits for reviews that
 * can never arrive. This repository is public, so that reader may have no one to ask.
 */
/**
 * The harm is *possession*, not mention. Naming EKS while describing what a guide
 * covers is factual; telling a reader their EKS cluster will receive reviews is the
 * promise the code refuses. Matching a bare platform name flagged a documentation
 * index and would push maintainers to write worse prose to satisfy a test.
 */
const CLAIM_PATTERNS = [
  // Allows intervening words, so "your EKS cluster" and "their own K8s clusters"
  // are caught as surely as "your cluster".
  /\b(your|their)\s+(\w+\s+){0,3}(clusters?|infrastructure)\b/iu,
  /\b(your|their)\s+(own\s+)?kubernetes\b/iu,
  /\bany\s+(vanilla\s+)?(K8s|Kubernetes)\s+clusters?\b/iu,
  /\bclusters?\s+(you|they)\s+(operate|run|own|manage|control)\b/iu,
  // "self-hosted Ollama/vLLM endpoints" is about MODEL PROVIDERS, not clusters, and
  // is a true statement. Only match self-hosting that is about running the worker.
  /\bself[- ]host(ing|ed|s)?\b(?!\s+(Ollama|vLLM|model|endpoint))/iu,
];

/**
 * Wording that marks a line as stating the limit rather than promising it works.
 *
 * Detection is claim-minus-limitation rather than claim-outside-blockquote. An
 * earlier version excluded every `>` line, which let a promise pass purely by
 * being written as a callout — markdown syntax says nothing about meaning, but a
 * negation does.
 */
const LIMITATION = /\b(not|cannot|can't|never|until|unless|is fixed|no longer)\b/iu;

/**
 * Blocks, not lines. A bullet inherits the limitation stated by its list intro --
 * "these files configure the chart; they do NOT make a cluster you operate
 * reachable" covers every platform bullet beneath it. Judging line by line would
 * demand the caveat be repeated on each one, which is how a guard starts forcing
 * worse prose than it protects.
 */
function promisingBlocks(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n/u)
    .filter((block) => CLAIM_PATTERNS.some((pattern) => pattern.test(block)))
    .filter((block) => !LIMITATION.test(block))
    .map((block) => block.trim().split('\n')[0].slice(0, 120));
}

describe('Kubernetes Mode documentation matches enforced behaviour', () => {
  it('pins the endpoint in code, so the docs must not promise arbitrary clusters', () => {
    // The premise of every assertion below. If this stops being true, revisit them.
    const dispatch = read('scripts/dispatch-doks-action.mjs');
    expect(dispatch).toContain('url.origin === expected.origin');
    expect(dispatch).toContain('url.pathname === expected.pathname');
  });

  it.each([
    ['docs/KUBERNETES_MODE.md'],
    ['README.md'],
  ])('%s never promises the reader can point the worker at a cluster they operate', (file) => {
    // Applied to BOTH documents. The README previously pinned only its removed
    // heading, so "Self-Host the Worker Fleet" would have reintroduced the
    // advertising without failing anything.
    expect(promisingBlocks(read(file))).toEqual([]);
  });

  it('states plainly that the endpoint is fixed, naming what enforces it', () => {
    // A reader must be able to verify the constraint without reading the dispatch
    // script to discover it exists.
    const doc = read('docs/KUBERNETES_MODE.md');
    expect(doc).toMatch(/dispatch endpoint is fixed/iu);
    expect(doc).toContain('validateDispatchEndpoint');
  });

  it('links the README chart section to the constraint', () => {
    // Semantic anchor, not exact prose: "...until the dispatch endpoint is
    // configurable" is a correct edit and must not fail the suite.
    const readme = read('README.md');
    expect(readme).toMatch(/will not receive reviews/iu);
    expect(readme).toContain('docs/KUBERNETES_MODE.md');
  });
});
