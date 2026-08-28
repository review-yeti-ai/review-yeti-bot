import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const { computeArbitrationQuorum, resolvePersonaRoster, PERSONA_CHARTERS, DEFAULT_PERSONA_IDS } = pipeline;

/** Builds persona results carrying a given number of findings at each severity. */
function results(personaCount: number, sev: Record<string, number> = {}) {
  const findings: any[] = [];
  for (const [severity, n] of Object.entries(sev)) {
    for (let i = 0; i < n; i++) findings.push({ severity });
  }
  const out = Array.from({ length: personaCount }, () => ({ findings: [] as any[] }));
  out[0].findings = findings;
  return out;
}

describe('Arbitration scales with the size of the panel', () => {
  it('does not block a twelve-persona panel over a single P1', () => {
    const a = computeArbitrationQuorum(results(12, { P1: 1 }), 12);
    expect(a.verdict).toBe('FIX_FIRST');
  });

  it('does not block a twelve-persona panel until P1s concentrate', () => {
    expect(computeArbitrationQuorum(results(12, { P1: 5 }), 12).verdict).toBe('FIX_FIRST');
    expect(computeArbitrationQuorum(results(12, { P1: 6 }), 12).verdict).toBe('BLOCK');
  });

  it('keeps a floor so a small panel still blocks on three P1s', () => {
    expect(computeArbitrationQuorum(results(3, { P1: 3 }), 3).verdict).toBe('BLOCK');
  });

  it('always blocks on a P0 regardless of panel size', () => {
    expect(computeArbitrationQuorum(results(12, { P0: 1 }), 12).verdict).toBe('BLOCK');
    expect(computeArbitrationQuorum(results(1, { P0: 1 }), 1).verdict).toBe('BLOCK');
  });

  it('scales the nit threshold with the panel so twelve reviewers may each raise one', () => {
    expect(computeArbitrationQuorum(results(12, { P2: 11 }), 12).verdict).toBe('SHIP');
    expect(computeArbitrationQuorum(results(12, { P2: 12 }), 12).verdict).toBe('FIX_FIRST');
  });

  it('keeps a nit floor of five for small panels', () => {
    expect(computeArbitrationQuorum(results(2, { P2: 4 }), 2).verdict).toBe('SHIP');
    expect(computeArbitrationQuorum(results(2, { P2: 5 }), 2).verdict).toBe('FIX_FIRST');
  });

  it('reports the thresholds it applied so a verdict can be argued with', () => {
    const a = computeArbitrationQuorum(results(12, { P1: 6 }), 12);
    expect(a.thresholds).toEqual({ blockP1: 6, fixP2: 12 });
  });
});

describe('Default roster is the subset that applies to any codebase', () => {
  it('exposes an explicit default set smaller than the full roster', () => {
    expect(Array.isArray(DEFAULT_PERSONA_IDS)).toBe(true);
    expect(DEFAULT_PERSONA_IDS.length).toBeGreaterThan(0);
    expect(DEFAULT_PERSONA_IDS.length).toBeLessThan(PERSONA_CHARTERS.length);
  });

  it('runs only the default set when nothing is configured', () => {
    const r = resolvePersonaRoster({}, null, {});
    expect(r.personas.map((p: any) => p.id)).toEqual(DEFAULT_PERSONA_IDS);
  });

  it('leaves situational reviewers off by default', () => {
    const r = resolvePersonaRoster({}, null, {});
    const ids = r.personas.map((p: any) => p.id);
    expect(ids).not.toContain('i18n');
    expect(ids).not.toContain('accessibility');
    expect(ids).not.toContain('licensing');
  });

  it('still enables a situational reviewer when asked for by id', () => {
    const r = resolvePersonaRoster({}, null, { ACTIVE_PERSONAS: 'i18n,accessibility' });
    expect(r.personas.map((p: any) => p.id)).toEqual(['accessibility', 'i18n']);
    expect(r.errors).toEqual([]);
  });

  it('accepts "all" as a selector for the complete roster', () => {
    const r = resolvePersonaRoster({}, null, { ACTIVE_PERSONAS: 'all' });
    expect(r.personas).toHaveLength(PERSONA_CHARTERS.length);
    expect(r.errors).toEqual([]);
  });

  it('marks every built-in with an explicit default flag', () => {
    for (const p of PERSONA_CHARTERS) {
      expect(typeof p.defaultEnabled).toBe('boolean');
    }
  });
});

describe('Built-in charters are written as reviewer instructions', () => {
  it('tells every reviewer what not to flag, which is what keeps reviews quiet', () => {
    for (const p of PERSONA_CHARTERS) {
      expect(p.charter.toLowerCase(), `persona ${p.id}`).toContain('do not flag');
    }
  });

  it('gives every reviewer severity calibration rather than a bare topic list', () => {
    for (const p of PERSONA_CHARTERS) {
      expect(p.charter, `persona ${p.id}`).toMatch(/P0|P1|P2/);
    }
  });

  it('writes charters long enough to actually constrain a model', () => {
    for (const p of PERSONA_CHARTERS) {
      expect(p.charter.length, `persona ${p.id}`).toBeGreaterThan(400);
    }
  });

  it('does not send reviewers hunting for the Kubernetes setup this project removed', () => {
    for (const p of PERSONA_CHARTERS) {
      expect(p.charter, `persona ${p.id}`).not.toContain('Kubernetes');
    }
  });

  it('requires causal evidence before the testing reviewer reports a defect', () => {
    const testing = PERSONA_CHARTERS.find((persona) => persona.id === 'testing');
    expect(testing?.charter).toContain('Scope:');
    expect(testing?.charter).toContain('Concrete counterfactual evidence:');
    expect(testing?.charter).toContain("Name the changed assertion, input or path, and expected outcome");
    expect(testing?.charter).toContain('Isolation:');
    expect(testing?.charter).toContain('Sibling coverage:');
    expect(testing?.charter).toContain('sibling tests and shared helpers/defaults');
    expect(testing?.charter).toContain('Semantic equivalence:');
    expect(testing?.charter).toContain('equivalent formatting, reordering, or representation');
    expect(testing?.charter).toContain('Branch completeness:');
    expect(testing?.charter).toContain('If that causal chain cannot be shown from the diff, return no finding.');
  });

  it('keeps testing hardening generic rather than encoding evaluation fixtures', () => {
    const testing = PERSONA_CHARTERS.find((persona) => persona.id === 'testing');
    expect(testing?.charter).not.toMatch(/vacuous|format.?evadable|absence.?guard|default.?value/i);
  });
});
