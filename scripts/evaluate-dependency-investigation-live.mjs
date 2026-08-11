#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pipeline = require('../.github/workflows/pipelines/review-pipeline.js');
const { buildDependencyEvidence, classifyDependencyPath, requestKindMatchesPath, renderDependencyEvidence } = require('../src/review/dependencyEvidence.js');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function decision(result = {}) {
  if (result.decision === 'ERROR') return 'ERROR';
  if (result.reviewStatus === 'INCOMPLETE_REVIEW' || result.decision === 'INCOMPLETE_REVIEW') return 'INCOMPLETE_REVIEW';
  if (Array.isArray(result.findings) && result.findings.length > 0) return 'FINDINGS';
  return 'APPROVE';
}

function legacyDecision(result = {}) {
  // Before this change, the findings-only parser ignored review_status and evidence_requests.
  return result.decision === 'ERROR' ? 'ERROR' : Array.isArray(result.findings) && result.findings.length > 0 ? 'FINDINGS' : 'APPROVE';
}

function usageTotal(results) {
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let costUSD = 0;
  let hasCost = true;
  for (const result of results) {
    usage.promptTokens += Number(result?.usage?.promptTokens || 0);
    usage.completionTokens += Number(result?.usage?.completionTokens || 0);
    if (typeof result?.usage?.costUSD === 'number' && Number.isFinite(result.usage.costUSD)) costUSD += result.usage.costUSD;
    else hasCost = false;
  }
  usage.totalTokens = usage.promptTokens + usage.completionTokens;
  return hasCost ? { ...usage, costUSD } : usage;
}

function shuffle(items, seed) {
  const result = [...items];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swap = state % (index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function summarize(rows, arm) {
  const selected = rows.filter((row) => row.arm === arm);
  const faults = selected.filter((row) => row.category === 'fault');
  const clean = selected.filter((row) => row.category === 'clean');
  const unavailableBoundaries = selected.filter((row) => row.category === 'boundary' && row.expectedDecision === 'INCOMPLETE_REVIEW');
  const evidenceRows = selected.filter((row) => row.evidenceAvailable);
  const evidenceRequests = selected.flatMap((row) => row.evidenceRequests || []);
  const validEvidenceRequests = evidenceRequests.filter((request) => {
    const classified = classifyDependencyPath(request?.path);
    return classified && requestKindMatchesPath(classified, request?.kind);
  }).length;
  const costValues = selected.map((row) => row.usage.costUSD).filter((value) => typeof value === 'number');
  const latencyValues = selected.map((row) => row.latencyMs).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return {
    rows: selected.length,
    expectedDecisionAccuracy: selected.length ? Number((selected.filter((row) => row.decision === row.expectedDecision).length / selected.length).toFixed(4)) : 0,
    faultRecall: faults.length ? Number((faults.filter((row) => row.decision === 'FINDINGS').length / faults.length).toFixed(4)) : 0,
    cleanFalsePositiveRate: clean.length ? Number((clean.filter((row) => row.decision === 'FINDINGS').length / clean.length).toFixed(4)) : 0,
    unsafeShipRate: unavailableBoundaries.length ? Number((unavailableBoundaries.filter((row) => row.decision === 'APPROVE').length / unavailableBoundaries.length).toFixed(4)) : 0,
    postEvidenceDecisionAccuracy: evidenceRows.length ? Number((evidenceRows.filter((row) => row.decision === row.expectedDecision).length / evidenceRows.length).toFixed(4)) : 0,
    validEvidenceRequestRate: evidenceRequests.length ? Number((validEvidenceRequests / evidenceRequests.length).toFixed(4)) : null,
    followUps: selected.filter((row) => row.followUp).length,
    totalTokens: selected.reduce((sum, row) => sum + row.usage.totalTokens, 0),
    costUSD: costValues.length === selected.length ? Number(costValues.reduce((sum, value) => sum + value, 0).toFixed(6)) : null,
    latencyMsP95: latencyValues.length ? latencyValues[Math.min(latencyValues.length - 1, Math.ceil(latencyValues.length * 0.95) - 1)] : null,
  };
}

export async function evaluateLive(matrix, { repetitions = 3, modelOptions = {}, maxInvestigationTurns = 2, concurrency = 4 } = {}) {
  const dependencyPersona = pipeline.PERSONA_CHARTERS.find((persona) => persona.id === 'dependencies');
  if (!dependencyPersona) throw new Error('dependency persona is not configured');
  const rows = [];
  const fixtures = Array.isArray(matrix?.fixtures) ? matrix.fixtures : [];
  const runFixture = async (fixture, repetition) => {
      const prContext = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: `dependency-eval-${repetition}-${fixture.id}` };
      const startedAt = Date.now();
      const initial = await pipeline.reviewWithModel(dependencyPersona, fixture.files, prContext, null, {
        ...modelOptions,
        turn: 1,
        maxInvestigationTurns,
      });
      const initialLatencyMs = Date.now() - startedAt;
      const initialEvidenceRequested = initial.reviewStatus === 'NEEDS_EVIDENCE' || initial.decision === 'NEEDS_EVIDENCE' || (initial.evidenceRequests || []).length > 0;
      let candidateResult = initial;
      let followUp = false;
      let evidenceAvailable = false;
      const runResults = [initial];
      if (initialEvidenceRequested) {
        const evidence = buildDependencyEvidence(fixture.files, initial.evidenceRequests, fixture.evidenceOptions || {});
        evidenceAvailable = evidence.complete;
        if (!evidence.complete) {
          candidateResult = { ...initial, decision: 'INCOMPLETE_REVIEW', reviewStatus: 'INCOMPLETE_REVIEW' };
        } else if (maxInvestigationTurns > 1) {
          followUp = true;
          const followup = await pipeline.reviewWithModel(dependencyPersona, fixture.files, prContext, {
            turn: 2,
            maxInvestigationTurns,
            investigationContext: renderDependencyEvidence(evidence, fixture.evidenceOptions?.maxChars || 12_000),
          }, {
            ...modelOptions,
            turn: 2,
            maxInvestigationTurns,
            investigationContext: renderDependencyEvidence(evidence, fixture.evidenceOptions?.maxChars || 12_000),
          });
          runResults.push(followup);
          candidateResult = followup;
        }
      }
      const usage = usageTotal(runResults);
      const latencyMs = Date.now() - startedAt;
      const baselineRow = {
        repetition,
        fixtureId: fixture.id,
        category: fixture.category,
        arm: 'baseline',
        decision: legacyDecision(initial),
        expectedDecision: fixture.expected.decision,
        followUp: false,
        evidenceAvailable,
        evidenceRequests: initial.evidenceRequests || [],
        usage: usageTotal([initial]),
        latencyMs: initialLatencyMs,
      };
      const candidateRow = {
        repetition,
        fixtureId: fixture.id,
        category: fixture.category,
        arm: 'candidate',
        decision: decision(candidateResult),
        expectedDecision: fixture.expected.decision,
        followUp,
        evidenceAvailable,
        evidenceRequests: initial.evidenceRequests || [],
        usage,
        latencyMs,
      };
      return [baselineRow, candidateRow];
  };
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const ordered = shuffle(fixtures, repetition);
    const width = Math.max(1, Math.min(Number(concurrency) || 1, 8));
    for (let index = 0; index < ordered.length; index += width) {
      const batch = ordered.slice(index, index + width);
      const batchRows = await Promise.all(batch.map((fixture) => runFixture(fixture, repetition)));
      rows.push(...batchRows.flat());
    }
  }
  const baseline = summarize(rows, 'baseline');
  const candidate = summarize(rows, 'candidate');
  return {
    schemaVersion: 'dependency-review-live-eval-result-v1',
    status: 'complete',
    promotionReady: candidate.unsafeShipRate === 0
      && candidate.faultRecall - baseline.faultRecall >= 0.15
      && candidate.postEvidenceDecisionAccuracy >= 0.9
      && candidate.validEvidenceRequestRate >= 0.9
      && candidate.cleanFalsePositiveRate <= 0.1
      && typeof candidate.costUSD === 'number'
      && typeof baseline.costUSD === 'number'
      && candidate.costUSD <= baseline.costUSD * 1.3
      && candidate.latencyMsP95 <= baseline.latencyMsP95 * 1.5,
    repetitions,
    fixtureCount: fixtures.length,
    concurrency: Math.max(1, Math.min(Number(concurrency) || 1, 8)),
    baseline,
    candidate,
    deltas: {
      faultRecall: Number((candidate.faultRecall - baseline.faultRecall).toFixed(4)),
      costMultiplier: baseline.costUSD ? Number((candidate.costUSD / baseline.costUSD).toFixed(4)) : null,
      latencyMultiplier: baseline.latencyMsP95 ? Number((candidate.latencyMsP95 / baseline.latencyMsP95).toFixed(4)) : null,
    },
    rows,
  };
}

if (process.argv[1]?.endsWith('evaluate-dependency-investigation-live.mjs')) {
  const fixturePath = path.resolve(process.cwd(), argument('--fixture', 'tests/fixtures/dependency-evaluation.json'));
  const repetitions = Number(argument('--repetitions', '3'));
  const key = process.env.OPENROUTER_API_KEY || '';
  if (!key) {
    console.error('OPENROUTER_API_KEY is required for the live evaluation; no provider call was made.');
    process.exitCode = 2;
  } else {
    const matrix = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const cfg = pipeline.resolveModelConfig(process.env);
    const result = await evaluateLive(matrix, {
      repetitions,
      concurrency: Number(argument('--concurrency', '4')),
      maxInvestigationTurns: 2,
      modelOptions: {
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        maxAttempts: 1,
        maxTokens: 8192,
        timeoutMs: Number(process.env.OPENROUTER_TIMEOUT_MS || 30_000),
        openRouterPolicy: {
          allowedModels: [],
          fallbackModels: [],
          ignoredProviders: ['deepinfra'],
          providerRouting: { ignore: ['deepinfra'] },
          timeoutMs: Number(process.env.OPENROUTER_TIMEOUT_MS || 30_000),
          stream: false,
        },
      },
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.promotionReady) process.exitCode = 1;
  }
}
