import { describe, it, expect } from 'vitest';
import { buildFastShipPanelResult } from '../../src/panel/fastShipResult';
import { ClassifierResult } from '../../src/panel/classifierEngine';

describe('fastShipResult.ts — Consensus and Panel Structure Invariants', () => {
  it('constructs a valid PanelResult matching consensus output invariants', () => {
    const classifierResult: ClassifierResult = {
      fastShip: true,
      selectedPersonas: [],
      effortTier: 'low',
      rationale: 'Pure markdown documentation update.',
      usage: { prompt: 100, completion: 20, total: 120 },
      costUSD: 0.0001,
      durationMs: 450,
      model: 'fast-classifier-model',
      providerId: 'openrouter-provider',
    };

    const panelResult = buildFastShipPanelResult(classifierResult, 'commit-sha-123', 1);

    expect(panelResult.headSha).toBe('commit-sha-123');
    expect(panelResult.quorum.satisfied).toBe(true);
    expect(panelResult.quorum.required).toBe(1);
    expect(panelResult.quorum.distinctProviders).toEqual(['openrouter-provider']);

    // Moderator invariants
    expect(panelResult.moderator.decision).toBe('RECONCILED');
    expect(panelResult.moderator.findings).toEqual([]);
    expect(panelResult.moderator.providerId).toBe('openrouter-provider');

    // Arbiter invariants
    expect(panelResult.arbiter.verdict).toBe('SHIP');
    expect(panelResult.arbiter.rationale).toContain('Pure markdown documentation update.');
    expect(panelResult.arbiter.usage).toEqual({ prompt: 100, completion: 20, total: 120 });
    expect(panelResult.arbiter.costUSD).toBe(0.0001);
    expect(panelResult.arbiter.durationMs).toBe(450);

    // Persona lane invariants
    expect(panelResult.personas).toHaveLength(1);
    const lane = panelResult.personas[0];
    expect(lane.id).toBe('fast-ship');
    expect(lane.required).toBe(true);
    expect(lane.decision).toBe('APPROVE');
    expect(lane.findings).toEqual([]);
    expect(lane.providerId).toBe('openrouter-provider');
    expect(lane.model).toBe('fast-classifier-model');
  });

  it('provides safe fallbacks when providerId and usage are omitted', () => {
    const classifierResult: ClassifierResult = {
      fastShip: true,
      selectedPersonas: [],
      effortTier: 'low',
      rationale: 'Minimal docs update.',
    };

    const panelResult = buildFastShipPanelResult(classifierResult, 'sha-fallback');
    expect(panelResult.arbiter.verdict).toBe('SHIP');
    expect(panelResult.quorum.distinctProviders).toEqual(['fast-ship']);
    expect(panelResult.personas[0].providerId).toBe('fast-ship');
    expect(panelResult.personas[0].usage).toBeNull();
  });

  it('correctly marks quorum unsatisfied when requiredQuorum > 1 with a single classifier provider', () => {
    const classifierResult: ClassifierResult = {
      fastShip: true,
      selectedPersonas: [],
      effortTier: 'low',
      rationale: 'Docs only update.',
      providerId: 'provider-1',
    };

    const panelResult = buildFastShipPanelResult(classifierResult, 'sha-quorum-fail', 2);
    expect(panelResult.quorum.satisfied).toBe(false);
    expect(panelResult.quorum.required).toBe(2);
    expect(panelResult.quorum.distinctProviders).toEqual(['provider-1']);
  });
});
