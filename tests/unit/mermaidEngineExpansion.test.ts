import { describe, it, expect } from 'vitest';
import { analyzeDiffComplexity, generateMermaidDiagram } from '../../src/review/mermaidEngine';

describe('mermaidEngine.ts — Comprehensive Unit Expansion Tests', () => {
  it('returns isComplex false for empty, null, or whitespace diffs', () => {
    expect(analyzeDiffComplexity('')).toEqual({ isComplex: false, type: 'flowchart TD', components: [], functions: [] });
    expect(analyzeDiffComplexity('   \n  ')).toEqual({ isComplex: false, type: 'flowchart TD', components: [], functions: [] });
    expect(analyzeDiffComplexity(null as any)).toEqual({ isComplex: false, type: 'flowchart TD', components: [], functions: [] });
  });

  it('detects interaction keywords and selects sequenceDiagram type', () => {
    const diff = `
diff --git a/src/github/eventHandler.ts b/src/github/eventHandler.ts
--- a/src/github/eventHandler.ts
+++ b/src/github/eventHandler.ts
@@ -1,5 +1,5 @@
+ export function publishEvent() { fetch('http://api'); }
`;
    const analysis = analyzeDiffComplexity(diff);

    expect(analysis.isComplex).toBe(true);
    expect(analysis.type).toBe('sequenceDiagram');
    expect(analysis.components).toContain('EventHandler');
    expect(analysis.functions).toContain('publishEvent');
  });

  it('selects flowchart TD type for structural diffs without interaction keywords', () => {
    const diff = `
diff --git a/src/utils/math.ts b/src/utils/math.ts
--- a/src/utils/math.ts
+++ b/src/utils/math.ts
@@ -1,5 +1,5 @@
+ const x = 1; if (x === 1) { console.log(x); }
`;
    const analysis = analyzeDiffComplexity(diff);

    expect(analysis.isComplex).toBe(true);
    expect(analysis.type).toBe('flowchart TD');
  });

  it('extracts PascalCase component names from file paths', () => {
    const diff = `
diff --git a/src/github/commentPublisher.ts b/src/github/commentPublisher.ts
--- a/src/github/commentPublisher.ts
+++ b/src/github/commentPublisher.ts
@@ -1,1 +1,1 @@
+ class CommentPublisher {}
diff --git a/src/gateway/providerPool.ts b/src/gateway/providerPool.ts
--- a/src/gateway/providerPool.ts
+++ b/src/gateway/providerPool.ts
@@ -1,1 +1,1 @@
+ class ProviderPool {}
`;
    const analysis = analyzeDiffComplexity(diff);

    expect(analysis.components).toContain('CommentPublisher');
    expect(analysis.components).toContain('ProviderPool');
  });

  it('extracts exported functions, classes, and types from diff lines', () => {
    const diff = `
+ export function processReview() {}
+ export class ReviewRunner {}
+ export interface ReviewConfig {}
+ export type ReviewStatus = 'ok' | 'fail';
`;
    const analysis = analyzeDiffComplexity(diff);

    expect(analysis.functions).toContain('processReview');
    expect(analysis.functions).toContain('ReviewRunner');
    expect(analysis.functions).toContain('ReviewConfig');
    expect(analysis.functions).toContain('ReviewStatus');
  });

  it('generateMermaidDiagram returns empty string when diff is not complex', () => {
    const diagram = generateMermaidDiagram('');
    expect(diagram).toBe('');
  });

  it('generateMermaidDiagram produces fenced mermaid code block', () => {
    const diff = `
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
+ function dispatchCommand() {}
`;
    const diagram = generateMermaidDiagram(diff);

    expect(diagram).toContain('```mermaid');
    expect(diagram).toContain('```');
  });

  it('generateMermaidDiagram includes sequenceDiagram header and autonumbering', () => {
    const diff = `
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
+ function publishComment() {}
`;
    const diagram = generateMermaidDiagram(diff);

    expect(diagram).toContain('sequenceDiagram');
    expect(diagram).toContain('autonumber');
  });

  it('generateMermaidDiagram formats up to 4 participants in sequence diagrams', () => {
    const diff = `
diff --git a/src/compA.ts b/src/compA.ts
--- a/src/compA.ts
+++ b/src/compA.ts
@@ -1,1 +1,1 @@
+ fetch()
diff --git a/src/compB.ts b/src/compB.ts
--- a/src/compB.ts
+++ b/src/compB.ts
@@ -1,1 +1,1 @@
+ fetch()
diff --git a/src/compC.ts b/src/compC.ts
--- a/src/compC.ts
+++ b/src/compC.ts
@@ -1,1 +1,1 @@
+ fetch()
diff --git a/src/compD.ts b/src/compD.ts
--- a/src/compD.ts
+++ b/src/compD.ts
@@ -1,1 +1,1 @@
+ fetch()
diff --git a/src/compE.ts b/src/compE.ts
--- a/src/compE.ts
+++ b/src/compE.ts
@@ -1,1 +1,1 @@
+ fetch()
`;
    const diagram = generateMermaidDiagram(diff);

    expect(diagram).toContain('participant CompA');
    expect(diagram).toContain('participant CompB');
    expect(diagram).toContain('participant CompC');
    expect(diagram).toContain('participant CompD');
    expect(diagram).not.toContain('participant CompE');
  });

  it('generateMermaidDiagram uses fallback participants when component count < 2', () => {
    const diff = `
+ function publish() {}
`;
    const diagram = generateMermaidDiagram(diff);

    expect(diagram).toContain('participant Client');
    expect(diagram).toContain('participant ReviewBot');
    expect(diagram).toContain('participant GitHubAPI');
  });

  it('handles large diffs with many component files cleanly', () => {
    const diff = Array.from({ length: 20 }, (_, i) => `
diff --git a/src/module${i}.ts b/src/module${i}.ts
--- a/src/module${i}.ts
+++ b/src/module${i}.ts
@@ -1,1 +1,1 @@
+ function fn${i}() { fetch(); }
`).join('\n');

    const diagram = generateMermaidDiagram(diff);
    expect(diagram).toContain('```mermaid');
    expect(diagram).toContain('sequenceDiagram');
  });
});
