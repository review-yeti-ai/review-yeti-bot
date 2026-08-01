import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const { resolvePersonaRoster, PERSONA_CHARTERS, DEFAULT_PERSONA_IDS } = pipeline;
const allIds = DEFAULT_PERSONA_IDS;

/** Wraps a parsed .ct-review.yaml body in the shape loadLocalRepoConfig returns. */
const cfg = (parsed: any) => ({ file: '.ct-review.yaml', parsed });

const ids = (result: any) => result.personas.map((p: any) => p.id);

describe('resolvePersonaRoster — built-in selection', () => {
  it('defaults to the default reviewer set when nothing is configured', () => {
    const r = resolvePersonaRoster({}, null, {});
    expect(ids(r)).toEqual(allIds);
    expect(r.errors).toEqual([]);
  });

  it('treats the Actions string "null" as unconfigured', () => {
    const r = resolvePersonaRoster({}, null, { ACTIVE_PERSONAS: 'null' });
    expect(ids(r)).toEqual(allIds);
  });

  it('selects a subset from a comma-separated input', () => {
    const r = resolvePersonaRoster({}, null, { ACTIVE_PERSONAS: 'security, devops' });
    expect(ids(r)).toEqual(['security', 'devops']);
    expect(r.errors).toEqual([]);
  });

  it('honors an explicit empty selection as a real opt-out', () => {
    const r = resolvePersonaRoster({ activePersonas: [] }, null, {});
    expect(ids(r)).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('excludes built-ins disabled in local config', () => {
    const r = resolvePersonaRoster({}, cfg({ personas: [{ id: 'security' }, { id: 'style', enabled: false }] }), {});
    expect(ids(r)).toEqual(['security']);
  });

  it('carries the built-in charter through so it reaches the model prompt', () => {
    const r = resolvePersonaRoster({}, null, { ACTIVE_PERSONAS: 'security' });
    expect(r.personas[0].charter).toBe(PERSONA_CHARTERS.find((p: any) => p.id === 'security').charter);
  });
});

describe('resolvePersonaRoster — unknown ids fail loudly', () => {
  it('reports an error rather than silently reviewing nothing', () => {
    const r = resolvePersonaRoster({ activePersonas: ['secrity'] }, null, {});
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toContain('secrity');
  });

  it('names the valid ids in the error so the fix is obvious', () => {
    const r = resolvePersonaRoster({ activePersonas: ['nope'] }, null, {});
    expect(r.errors[0]).toContain('security');
  });

  it('points at charter as the way to define a new persona', () => {
    const r = resolvePersonaRoster({}, cfg({ personas: [{ id: 'sec-lane' }] }), {});
    expect(r.errors[0]).toContain('charter');
  });

  it('fails on a typo even when other ids are valid, so coverage cannot silently halve', () => {
    const r = resolvePersonaRoster({ activePersonas: ['security', 'secrity'] }, null, {});
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('reports every unknown id at once rather than one per run', () => {
    const r = resolvePersonaRoster({ activePersonas: ['aaa', 'bbb'] }, null, {});
    expect(r.errors.join(' ')).toContain('aaa');
    expect(r.errors.join(' ')).toContain('bbb');
  });
});

describe('failure signalling', () => {
  const source = fs.readFileSync(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'), 'utf-8');

  it('does not swallow a crash into a passing check', () => {
    // A review tool exiting 0 after throwing is indistinguishable from a clean review.
    expect(source).not.toContain('process.exit(0)');
  });
});

describe('resolvePersonaRoster — custom personas', () => {
  const tenancy = {
    id: 'tenancy',
    name: '🏢 Multi-Tenant Isolation',
    charter: 'Every query touching customer data must be scoped by orgId.',
  };

  it('accepts a repository-defined persona that supplies a charter', () => {
    const r = resolvePersonaRoster({}, cfg({ personas: [tenancy] }), {});
    expect(r.errors).toEqual([]);
    expect(ids(r)).toEqual(['tenancy']);
    expect(r.personas[0].charter).toContain('orgId');
    expect(r.personas[0].name).toBe('🏢 Multi-Tenant Isolation');
  });

  it('mixes custom personas with built-ins', () => {
    const r = resolvePersonaRoster({}, cfg({ personas: [{ id: 'security' }, tenancy] }), {});
    expect(ids(r).sort()).toEqual(['security', 'tenancy']);
  });

  it('falls back to the id as a display name when none is given', () => {
    const r = resolvePersonaRoster({}, cfg({ personas: [{ id: 'perf-budget', charter: 'Watch bundle size.' }] }), {});
    expect(r.personas[0].name).toContain('perf-budget');
  });

  it('lets a repository override a built-in charter without renaming the persona', () => {
    const r = resolvePersonaRoster({}, cfg({ personas: [{ id: 'security', charter: 'Only flag hardcoded credentials.' }] }), {});
    expect(r.errors).toEqual([]);
    expect(r.personas[0].id).toBe('security');
    expect(r.personas[0].charter).toBe('Only flag hardcoded credentials.');
  });

  it('rejects a custom persona whose charter is blank', () => {
    const r = resolvePersonaRoster({}, cfg({ personas: [{ id: 'ghost', charter: '   ' }] }), {});
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('excludes a custom persona explicitly disabled', () => {
    const r = resolvePersonaRoster({}, cfg({ personas: [{ ...tenancy, enabled: false }] }), {});
    expect(ids(r)).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('gives custom personas the default model so they reach the same provider', () => {
    const r = resolvePersonaRoster({}, cfg({ personas: [tenancy] }), {});
    expect(r.personas[0].model).toBeTruthy();
  });
});
