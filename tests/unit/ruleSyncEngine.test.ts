import { describe, it, expect } from 'vitest';
import { RuleSyncEngine } from '../../src/config/ruleSyncEngine';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';
import { PlatformMemoryStore } from '../../src/memory/platformMemoryStore';

describe('RuleSyncEngine — CodeRabbit-Aligned Learning Synchronizer', () => {
  it('parses .ct-review.yaml rules and path instructions and syncs to PRMemoryStore', async () => {
    const yamlSample = `
version: 3
rules:
  - id: no-customer-identifiers
    rule: "No customer names or PII in code or comments"
    scope: ["**"]
    severity: P0
  - id: bash-3.2-safe
    rule: "Shell scripts must run on bash 3.2"
    scope: ["**/scripts/*"]
    severity: P1

path_instructions:
  - path: "tools/**/*.py"
    instructions: "Stdlib-first. Fail closed on bad input."
  - path: "knowledge/adr/**"
    instructions: "ADRs capture the why + alternatives."
`;

    const prStore = new PRMemoryStore(':memory:');
    const platformStore = new PlatformMemoryStore(':memory:');

    const syncEngine = new RuleSyncEngine(prStore, platformStore);
    const result = await syncEngine.syncYamlConfigToMemory('calltelemetry/cisco-cdr', yamlSample);

    expect(result.rulesSyncedCount).toBe(2);
    expect(result.pathInstructionsSyncedCount).toBe(2);

    const memory = await prStore.queryLearnings('calltelemetry/cisco-cdr');
    expect(memory.learnings.length).toBe(2);
    expect(memory.learnings[0].title).toBe('no-customer-identifiers');

    const pathInsts = prStore.queryPathInstructions('calltelemetry/cisco-cdr');
    expect(pathInsts.length).toBe(2);
    expect(pathInsts[0].pathPattern).toBe('tools/**/*.py');
    expect(pathInsts[0].instructions).toContain('Stdlib-first');

    prStore.close();
    platformStore.close();
  });
});
