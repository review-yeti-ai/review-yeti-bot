import { describe, it, expect } from 'vitest';
import { generateMermaidDiagram, analyzeDiffComplexity } from '../../src/review/mermaidEngine';

describe('mermaidEngine.ts — Architecture Visualization Engine', () => {
  const interactionDiff = `
diff --git a/src/github/eventHandler.ts b/src/github/eventHandler.ts
--- a/src/github/eventHandler.ts
+++ b/src/github/eventHandler.ts
@@ -10,5 +10,12 @@
+ export async function handleWebhookEvent(req: Request) {
+   const token = await fetchInstallationToken();
+   const res = await fetch('https://api.github.com/repos/owner/repo/pulls', { method: 'POST' });
+   await commentPublisher.publishReview(res);
+ }
`;

  const structuralDiff = `
diff --git a/src/config/schema.ts b/src/config/schema.ts
--- a/src/config/schema.ts
+++ b/src/config/schema.ts
@@ -1,5 +1,10 @@
 export class ConfigValidator {
   validate(config: any) {
     if (!config.version) throw new Error('missing version');
     switch (config.profile) {
       case 'strict': return true;
       default: return false;
     }
   }
 }
`;

  it('detects complex interaction diffs and generates sequenceDiagram', () => {
    const analysis = analyzeDiffComplexity(interactionDiff);
    expect(analysis.isComplex).toBe(true);
    expect(analysis.type).toBe('sequenceDiagram');

    const diagram = generateMermaidDiagram(interactionDiff);
    expect(diagram).toContain('```mermaid');
    expect(diagram).toContain('sequenceDiagram');
    expect(diagram).toContain('participant');
    expect(diagram).toContain('```');
  });

  it('detects structural logic diffs and generates flowchart TD', () => {
    const analysis = analyzeDiffComplexity(structuralDiff);
    expect(analysis.isComplex).toBe(true);
    expect(analysis.type).toBe('flowchart TD');

    const diagram = generateMermaidDiagram(structuralDiff);
    expect(diagram).toContain('```mermaid');
    expect(diagram).toContain('flowchart TD');
    expect(diagram).toContain('-->');
    expect(diagram).toContain('```');
  });

  it('returns empty string for empty or non-complex diff', () => {
    const diagram = generateMermaidDiagram('');
    expect(diagram).toBe('');
  });
});
