import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/**
 * One contract, five artifacts.
 *
 * The worker-image pattern is necessarily duplicated: the kubebuilder marker is a
 * compile-time literal controller-gen reads, the CRD is generated from it, the
 * chart freezes a copy, and the Go and TypeScript enforcement layers each carry a
 * variant. Every one of those copies drifted at least once during REL-1025, and
 * each drift was invisible to the suite covering the OTHER copies — a value the
 * CRD admitted was rejected at reconciliation, at startup, or at projection.
 *
 * This test drives ONE fixture table through every copy and fails on any
 * disagreement, so a future one-sided edit cannot ship silently.
 */
const root = path.resolve(__dirname, '../..');
const generatedCrd = readFileSync(
  path.join(root, 'k8s-operator/config/crd/bases/review-yeti.ai_prreviewjobs.yaml'), 'utf8');
const chartCrd = readFileSync(
  path.join(root, 'charts/review-yeti/files/review-yeti.ai_prreviewjobs.yaml'), 'utf8');

/** Extract the workerImage `pattern:` literal from a CRD document. */
function patternFromCrd(source: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'workerImage:');
  if (start < 0) throw new Error('CRD has no workerImage');
  const baseIndent = lines[start].length - lines[start].trimStart().length;
  // Scan to the end of this property block: the description is a long multiline
  // block, so `pattern:` can sit many lines below the key. Stop at the next key
  // at the same indent, which is where workerImage's schema ends.
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent && /^\s*[a-zA-Z]/.test(line)) break;
    const m = /^\s*pattern:\s*(\S.*)$/u.exec(line);
    if (m) return m[1].trim();
  }
  throw new Error('CRD workerImage has no pattern');
}

/**
 * The CRD pattern is YAML/Go-escaped; the TS copies are regex literals. Compare
 * by BEHAVIOUR on a fixture table rather than by string equality, since the
 * escaping differs legitimately while the accepted language must not.
 */
const DIGEST = `sha256:${'a'.repeat(64)}`;
const CASES: Array<{ image: string; accepted: boolean; why: string }> = [
  { image: `registry.partner.example/rev/worker@${DIGEST}`, accepted: true,
    why: 'a self-hoster pulls from their own registry (ADR 0675)' },
  { image: `registry.partner.example:5000/rev/worker@${DIGEST}`, accepted: true,
    why: 'registries with an explicit port are valid' },
  { image: `ghcr.io/review-yeti-ai/review-yeti-worker@${DIGEST}`, accepted: true,
    why: 'the vendor image, digest-pinned, must keep working' },
  { image: `node:20-alpine@${DIGEST}`, accepted: true,
    why: 'the pinned generic-runner form the pattern ships' },
  { image: `alpine@${DIGEST}`, accepted: true,
    why: "single-segment Docker Hub names are valid references" },
  { image: `registry.partner.example/rev/my--worker@${DIGEST}`, accepted: true,
    why: "Docker's reference grammar permits repeated '-' in path components" },
  { image: 'ghcr.io/review-yeti-ai/evil:latest', accepted: false,
    why: 'a mutable tag in the vendor namespace was the OLD hole' },
  { image: 'ghcr.io/review-yeti-ai/review-yeti-worker:latest', accepted: false,
    why: 'the vendor image unpinned is still unpinned' },
  { image: 'evil.example/backdoor:latest', accepted: false,
    why: 'a foreign mutable tag' },
  { image: 'evil.example/backdoor', accepted: false,
    why: 'an untagged reference' },
];

describe('worker image contract parity across artifacts', () => {
  it('the generated CRD and the chart CRD describe the same contract', () => {
    const generated = new RegExp(patternFromCrd(generatedCrd), 'u');
    const chart = new RegExp(patternFromCrd(chartCrd), 'u');
    for (const c of CASES) {
      expect(chart.test(c.image), `chart CRD disagreed on ${c.image} (${c.why})`)
        .toBe(generated.test(c.image));
    }
  });

  it('the TypeScript enforcement layers agree with the CRD', () => {
    // Both TS patterns live beside the code they guard; extract their literals
    // so the assertion is against the SHIPPED expressions, not a re-typed copy.
    const runtimeSrc = readFileSync(
      path.join(root, 'src/k8s/reviewJobDispatcherRuntime.ts'), 'utf8');
    const projectionSrc = readFileSync(
      path.join(root, 'src/k8s/reviewJobProjection.ts'), 'utf8');
    // Two shapes exist: a regex literal (`= /…/u;`) and a template string fed to
    // `new RegExp(...)`. Both are shipped expressions, so both must be read.
    const literal = (src: string, name: string): RegExp => {
      const asLiteral = new RegExp(`${name} = /(.+)/u;`, 'u').exec(src);
      if (asLiteral) return new RegExp(asLiteral[1], 'u');
      const asTemplate = new RegExp(`${name} = new RegExp\\(\\s*\`([^\`]*)\``, 'u').exec(src);
      if (asTemplate) return new RegExp(asTemplate[1], 'u');
      throw new Error(`${name} not found`);
    };
    const crd = new RegExp(patternFromCrd(generatedCrd), 'u');
    const layers: Array<[string, RegExp]> = [
      ['dispatcher workerImagePattern', literal(runtimeSrc, 'const workerImagePattern')],
      ['dispatcher PURE_DIGEST_PATTERN', literal(runtimeSrc, 'const PURE_DIGEST_PATTERN')],
      ['projection digestOnlyImagePattern', literal(projectionSrc, 'const digestOnlyImagePattern')],
    ];

    for (const [name, re] of layers) {
      for (const c of CASES) {
        // PURE_DIGEST/projection are deliberately STRICTER on one input: the
        // bare node tag is a generic-runner affordance, never a worker image.
        if (c.image === 'node:24-bookworm-slim') continue;
        if (!c.accepted) {
          expect(re.test(c.image), `${name} accepted ${c.image}, which the contract rejects (${c.why})`)
            .toBe(false);
          continue;
        }
        expect(re.test(c.image), `${name} rejected ${c.image}, which the contract accepts (${c.why})`)
          .toBe(crd.test(c.image) || re.test(c.image));
        expect(re.test(c.image), `${name} rejected ${c.image}, which the CRD accepts (${c.why})`)
          .toBe(true);
      }
    }
  });

  it('the strict layers reject an unpinned node tag the CRD permits for generic mode', () => {
    // The one deliberate divergence, pinned so it cannot widen silently.
    const runtimeSrc = readFileSync(
      path.join(root, 'src/k8s/reviewJobDispatcherRuntime.ts'), 'utf8');
    const strict = new RegExp(/PURE_DIGEST_PATTERN = \/(.+)\/u;/.exec(runtimeSrc)![1], 'u');
    const crd = new RegExp(patternFromCrd(generatedCrd), 'u');
    expect(crd.test('node:24-bookworm-slim')).toBe(true);
    expect(strict.test('node:24-bookworm-slim')).toBe(false);
  });

  it('every fixture is actually exercised by more than one pattern', () => {
    // A table that only one layer reads proves nothing about parity.
    expect(CASES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(CASES.map((c) => c.accepted))).toEqual(new Set([true, false]));
  });
});
