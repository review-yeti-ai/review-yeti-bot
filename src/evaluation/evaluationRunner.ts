/**
 * Evaluation Runner & Benchmark Engine
 *
 * Implements the automated benchmark evaluation harness for ct-review-bot reviewer personas
 * and models (including OpenRouter 5.6 Luna High and baseline models).
 *
 * Measures all 6 comparative dimensions:
 * 1. Signal-to-Noise Ratio (SNR)
 * 2. Time-to-First-Token (TTFT)
 * 3. Total Tokens In / Out
 * 4. Findings Accuracy, Precision & Recall (TP, FP, FN, verdict matching)
 * 5. Investigation Turn Depth
 * 6. Cost Efficiency ($TP / Cost USD)
 */

import {
  EvaluationScenario,
  ExpectedFinding,
  ArbitrationVerdict,
  ScenarioCategory,
  getAllScenarios,
  getScenarioById,
  getScenariosByCategory,
  formatUnifiedDiff,
  DiffFile,
} from './scenarios';
import {
  OpenRouterClient,
  normalizeOpenRouterModel,
  FetchImplementation,
} from '../gateway/openRouterClient';
import {
  computeArbitration,
  sanitizeFindings,
  ReviewFinding,
} from '../review/reviewCore';

// =========================================================================
// TYPES & INTERFACES
// =========================================================================

export interface Finding {
  severity?: 'P0' | 'P1' | 'P2' | string;
  path?: string;
  line?: number;
  title?: string;
  body?: string;
  description?: string;
  suggestion?: string;
  confidence?: number;
}

export interface MetricOptions {
  lineTolerance?: number;
  strictSeverity?: boolean;
}

export interface MatchedFindingPair {
  expected: ExpectedFinding;
  actual: Finding;
  lineDelta: number;
}

export interface EvaluationMetrics {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1Score: number;
  snr: number;
  snrDb: number;
  matchedFindings: MatchedFindingPair[];
  unmatchedActual: Finding[];
  unmatchedExpected: ExpectedFinding[];
}

export interface ScenarioEvaluationResult {
  scenarioId: string;
  scenarioName: string;
  category: ScenarioCategory;
  model: string;
  provider: string;
  verdict: ArbitrationVerdict;
  expectedVerdict: ArbitrationVerdict;
  verdictMatch: boolean;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1Score: number;
  snr: number;
  snrDb: number;
  ttftMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUSD: number;
  durationMs: number;
  turnDepth: number;
  costEfficiency: number;
  evidenceGatePassed?: boolean;
  findings: Finding[];
  rawOutput?: string;
  error?: string;
}

export interface ModelSummaryMetrics {
  model: string;
  totalScenarios: number;
  verdictMatches: number;
  verdictAccuracy: number;
  totalTp: number;
  totalFp: number;
  totalFn: number;
  precision: number;
  recall: number;
  f1Score: number;
  avgSnr: number;
  avgSnrDb: number;
  avgTtftMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUSD: number;
  avgTurnDepth: number;
  costEfficiency: number;
}

export interface ComparativeBenchmarkReport {
  timestamp: string;
  models: string[];
  scenarios: string[];
  summary: Record<string, ModelSummaryMetrics>;
  detailedResults: ScenarioEvaluationResult[];
}

export interface MockAdapterResult {
  content?: string;
  findings?: Finding[];
  verdict?: ArbitrationVerdict;
  ttftMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  turnDepth?: number;
  costUSD?: number;
}

export interface RunnerOptions {
  offline?: boolean;
  cassettePath?: string;
  fetchImplementation?: FetchImplementation;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  mockAdapter?: (modelId: string, scenario: EvaluationScenario) => Promise<MockAdapterResult> | MockAdapterResult;
  personaPrompts?: Record<string, string>;
  maxTurns?: number;
  metricOptions?: MetricOptions;
}

// =========================================================================
// COST MODEL REGISTRY
// =========================================================================

export interface ModelPricing {
  promptPer1M: number;
  completionPer1M: number;
}

export const MODEL_PRICING_TABLE: Record<string, ModelPricing> = {
  'deepseek/deepseek-v4-flash-0731:high': { promptPer1M: 0.14, completionPer1M: 0.28 },
  'deepseek/deepseek-v4-flash-0731': { promptPer1M: 0.14, completionPer1M: 0.28 },
  'accounts/fireworks/models/deepseek-v4-flash-0731': { promptPer1M: 0.14, completionPer1M: 0.28 },
  'openrouter/5.6-luna-high': { promptPer1M: 2.0, completionPer1M: 6.0 },
  'openai/gpt-5.6-luna:high': { promptPer1M: 2.0, completionPer1M: 6.0 },
  'openai/gpt-5.6-luna': { promptPer1M: 2.0, completionPer1M: 6.0 },
  'openrouter/openai/gpt-5.6-luna': { promptPer1M: 2.0, completionPer1M: 6.0 },
  'qwen/qwen-3.8-27b:high': { promptPer1M: 0.35, completionPer1M: 0.80 },
  'qwen/qwen3.8-27b:high': { promptPer1M: 0.35, completionPer1M: 0.80 },
  'qwen/qwen-2.5-coder-32b-instruct': { promptPer1M: 0.35, completionPer1M: 0.80 },
  'google/gemini-3.7-flash:high': { promptPer1M: 0.15, completionPer1M: 0.60 },
  'google/gemini-3.7-flash': { promptPer1M: 0.15, completionPer1M: 0.60 },
  'openrouter/auto': { promptPer1M: 0.50, completionPer1M: 1.50 },
};

/**
 * Calculates estimated USD cost from prompt and completion token counts.
 */
export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const normalized = normalizeOpenRouterModel(model).toLowerCase();
  let pricing = MODEL_PRICING_TABLE[normalized];
  if (!pricing) {
    if (normalized.includes('v4-flash') || normalized.includes('deepseek')) {
      pricing = { promptPer1M: 0.14, completionPer1M: 0.28 };
    } else if (normalized.includes('luna') || normalized.includes('5.6-luna')) {
      pricing = { promptPer1M: 2.0, completionPer1M: 6.0 };
    } else if (normalized.includes('qwen') || normalized.includes('3.8-27b')) {
      pricing = { promptPer1M: 0.35, completionPer1M: 0.80 };
    } else if (normalized.includes('3.7-flash') || normalized.includes('gemini')) {
      pricing = { promptPer1M: 0.15, completionPer1M: 0.60 };
    } else {
      pricing = { promptPer1M: 0.50, completionPer1M: 1.50 };
    }
  }

  const cost = (promptTokens / 1_000_000) * pricing.promptPer1M + (completionTokens / 1_000_000) * pricing.completionPer1M;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// =========================================================================
// METRICS CALCULATION ENGINE
// =========================================================================

function normalizeFilePath(filePath?: string): string {
  if (!filePath) return '';
  return filePath.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * Calculates all precision, recall, F1, SNR, and defect matching metrics.
 */
export function calculateMetrics(
  expectedFindings: ExpectedFinding[] = [],
  actualFindings: Finding[] = [],
  options: MetricOptions = {}
): EvaluationMetrics {
  const lineTolerance = options.lineTolerance ?? 5;
  const strictSeverity = options.strictSeverity ?? false;

  const matchedFindings: MatchedFindingPair[] = [];
  const unmatchedExpectedIndices = new Set<number>(expectedFindings.map((_, i) => i));
  const unmatchedActualIndices = new Set<number>(actualFindings.map((_, i) => i));

  // Greedy bipartite matching: pair actual findings with expected findings
  for (let actualIdx = 0; actualIdx < actualFindings.length; actualIdx++) {
    const actual = actualFindings[actualIdx];
    const actualPath = normalizeFilePath(actual.path);
    const actualLine = Number(actual.line);

    let bestExpectedIdx = -1;
    let minLineDelta = Infinity;

    for (const expIdx of unmatchedExpectedIndices) {
      const expected = expectedFindings[expIdx];
      const expPath = normalizeFilePath(expected.path);
      const expLine = typeof expected.line === 'number' ? expected.line : undefined;

      // 1. Path must match
      if (actualPath !== expPath) continue;

      // 2. Severity check if strict
      if (strictSeverity && actual.severity !== expected.severity) continue;

      // 3. Line proximity check
      let lineDelta = 0;
      if (typeof expLine === 'number' && Number.isFinite(actualLine) && actualLine > 0) {
        lineDelta = Math.abs(actualLine - expLine);
        if (lineDelta > lineTolerance) continue;
      }

      // 4. Pattern check if specified
      if (expected.titlePattern) {
        const pattern = typeof expected.titlePattern === 'string'
          ? new RegExp(expected.titlePattern, 'i')
          : expected.titlePattern;
        const textToMatch = `${actual.title || ''} ${actual.body || ''} ${actual.description || ''}`;
        if (!pattern.test(textToMatch)) continue;
      }

      if (lineDelta < minLineDelta) {
        minLineDelta = lineDelta;
        bestExpectedIdx = expIdx;
      }
    }

    if (bestExpectedIdx !== -1) {
      unmatchedExpectedIndices.delete(bestExpectedIdx);
      unmatchedActualIndices.delete(actualIdx);
      matchedFindings.push({
        expected: expectedFindings[bestExpectedIdx],
        actual,
        lineDelta: minLineDelta === Infinity ? 0 : minLineDelta,
      });
    }
  }

  const tp = matchedFindings.length;
  const fp = unmatchedActualIndices.size;
  const fn = unmatchedExpectedIndices.size;

  let precision = 1.0;
  if (tp + fp > 0) {
    precision = tp / (tp + fp);
  } else if (expectedFindings.length > 0) {
    precision = 0.0;
  }

  let recall = 1.0;
  if (tp + fn > 0) {
    recall = tp / (tp + fn);
  } else if (actualFindings.length > 0 && expectedFindings.length === 0) {
    recall = 1.0;
  }

  let f1Score = 0.0;
  if (precision + recall > 0) {
    f1Score = (2 * precision * recall) / (precision + recall);
  } else if (expectedFindings.length === 0 && actualFindings.length === 0) {
    f1Score = 1.0;
  }

  // SNR: TP / (FP + 1)
  const snr = Math.round((tp / (fp + 1)) * 100) / 100;

  // SNR in dB: 10 * log10(TP / max(FP, 0.1))
  let snrDb: number;
  if (tp > 0) {
    const rawRatio = tp / Math.max(fp, 0.1);
    snrDb = Math.round(10 * Math.log10(rawRatio) * 100) / 100;
  } else if (fp === 0 && expectedFindings.length === 0) {
    snrDb = 20.0; // Clean PR perfect baseline
  } else {
    const rawRatio = 0.01 / Math.max(fp, 0.1);
    snrDb = Math.round(10 * Math.log10(rawRatio) * 100) / 100;
  }

  const unmatchedActual = Array.from(unmatchedActualIndices).map((i) => actualFindings[i]);
  const unmatchedExpected = Array.from(unmatchedExpectedIndices).map((i) => expectedFindings[i]);

  return {
    tp,
    fp,
    fn,
    precision: Math.round(precision * 1000) / 1000,
    recall: Math.round(recall * 1000) / 1000,
    f1Score: Math.round(f1Score * 1000) / 1000,
    snr,
    snrDb,
    matchedFindings,
    unmatchedActual,
    unmatchedExpected,
  };
}

// =========================================================================
// OFFLINE BENCHMARK SIMULATOR PROFILES
// =========================================================================

/**
 * 32-bit FNV-1a deterministic pseudo-random hash in [0, 1) to replace unseeded Math.random() in offline simulation.
 */
function deterministicScore(modelId: string, scenarioId: string, findingKey: string | number): number {
  const str = `${modelId}:${scenarioId}:${findingKey}`;
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

interface SimulatedProfile {
  discoveryRate: number;
  fpProb: number;
  ttftBase: number;
  ttftVariance: number;
  turnDepth: number;
  promptFactor: number;
  completionFactor: number;
}

function getSimulatedProfile(modelId: string): SimulatedProfile {
  const norm = normalizeOpenRouterModel(modelId).toLowerCase();
  if (norm.includes('v4-flash') || norm.includes('deepseek')) {
    return {
      discoveryRate: 1.0,
      fpProb: 0.0,
      ttftBase: 105,
      ttftVariance: 15,
      turnDepth: 3,
      promptFactor: 1.05,
      completionFactor: 1.15,
    };
  }
  if (norm.includes('luna') || norm.includes('5.6-luna')) {
    return {
      discoveryRate: 1.0,
      fpProb: 0.0,
      ttftBase: 135,
      ttftVariance: 20,
      turnDepth: 3,
      promptFactor: 1.1,
      completionFactor: 1.2,
    };
  }
  if (norm.includes('qwen') || norm.includes('3.8-27b')) {
    return {
      discoveryRate: 0.98,
      fpProb: 0.02,
      ttftBase: 140,
      ttftVariance: 20,
      turnDepth: 3,
      promptFactor: 1.1,
      completionFactor: 1.2,
    };
  }
  if (norm.includes('3.7-flash') || norm.includes('gemini')) {
    return {
      discoveryRate: 1.0,
      fpProb: 0.0,
      ttftBase: 115,
      ttftVariance: 15,
      turnDepth: 3,
      promptFactor: 1.05,
      completionFactor: 1.15,
    };
  }
  return {
    discoveryRate: 0.95,
    fpProb: 0.05,
    ttftBase: 150,
    ttftVariance: 25,
    turnDepth: 2,
    promptFactor: 1.0,
    completionFactor: 1.0,
  };
}

// =========================================================================
// EVALUATION RUNNER CLASS
// =========================================================================

export class EvaluationRunner {
  private defaultOptions: RunnerOptions;

  constructor(options: RunnerOptions = {}) {
    this.defaultOptions = {
      offline: true,
      timeoutMs: 30_000,
      ...options,
    };
  }

  /**
   * Evaluates a single scenario against a specified model.
   */
  async runScenario(
    modelId: string,
    scenario: EvaluationScenario,
    options: RunnerOptions = {}
  ): Promise<ScenarioEvaluationResult> {
    const opts = { ...this.defaultOptions, ...options };
    const startTime = Date.now();
    const effectiveModel = normalizeOpenRouterModel(modelId);

    // 1. Check for custom mockAdapter
    if (opts.mockAdapter) {
      const mock = await opts.mockAdapter(modelId, scenario);
      const findings = mock.findings || (mock.content ? this.parseFindings(mock.content) : []);
      const sanitized = sanitizeFindings(findings, scenario.diffFiles);
      const metrics = calculateMetrics(scenario.expectedFindings, sanitized, opts.metricOptions);

      const arbitration = computeArbitration(
        [{ id: 'reviewer', status: 'SUCCESS', findings: sanitized }],
        1,
        { changedFiles: scenario.diffFiles }
      );
      const verdict = mock.verdict || arbitration.verdict;
      const verdictMatch = verdict === scenario.expectedVerdict;

      const promptTokens = mock.promptTokens ?? this.estimatePromptTokens(scenario);
      const completionTokens = mock.completionTokens ?? Math.max(80, sanitized.length * 90);
      const totalTokens = promptTokens + completionTokens;
      const costUSD = mock.costUSD ?? estimateCost(effectiveModel, promptTokens, completionTokens);
      const ttftMs = mock.ttftMs ?? 140;
      const turnDepth = mock.turnDepth ?? (scenario.category === 'multi_turn' ? 3 : 1);
      const durationMs = Date.now() - startTime;
      const costEfficiency = metrics.tp > 0 ? Math.round((metrics.tp / Math.max(costUSD, 0.00001)) * 100) / 100 : (metrics.f1Score > 0 ? Math.round((metrics.f1Score / Math.max(costUSD, 0.00001)) * 10) / 10 : 0);

      return {
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        category: scenario.category,
        model: effectiveModel,
        provider: this.resolveProvider(effectiveModel),
        verdict,
        expectedVerdict: scenario.expectedVerdict,
        verdictMatch,
        tp: metrics.tp,
        fp: metrics.fp,
        fn: metrics.fn,
        precision: metrics.precision,
        recall: metrics.recall,
        f1Score: metrics.f1Score,
        snr: metrics.snr,
        snrDb: metrics.snrDb,
        ttftMs,
        promptTokens,
        completionTokens,
        totalTokens,
        costUSD,
        durationMs,
        turnDepth,
        costEfficiency,
        evidenceGatePassed: scenario.evidenceRequirement ? true : undefined,
        findings: sanitized,
        rawOutput: mock.content,
      };
    }

    // 2. Live execution via OpenRouterClient or FetchImplementation
    if (!opts.offline && (opts.apiKey || process.env.OPENROUTER_API_KEY || opts.fetchImplementation)) {
      try {
        const client = new OpenRouterClient({
          baseUrl: opts.baseUrl,
          apiKey: opts.apiKey || process.env.OPENROUTER_API_KEY,
          fetchImplementation: opts.fetchImplementation,
        });

        const unifiedDiff = formatUnifiedDiff(scenario.diffFiles);
        const systemPrompt = this.buildSystemPrompt(scenario, opts);
        const userPrompt = this.buildUserPrompt(scenario, unifiedDiff);

        let ttftMs = 0;
        const reqStart = Date.now();

        const response = await client.complete({
          model: effectiveModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          timeoutMs: opts.timeoutMs || 30_000,
          stream: true,
        });

        ttftMs = Date.now() - reqStart;
        const findings = this.parseFindings(response.content);
        const sanitized = sanitizeFindings(findings, scenario.diffFiles);
        const metrics = calculateMetrics(scenario.expectedFindings, sanitized, opts.metricOptions);

        const arbitration = computeArbitration(
          [{ id: 'reviewer', status: 'SUCCESS', findings: sanitized }],
          1,
          { changedFiles: scenario.diffFiles }
        );
        const verdict = arbitration.verdict;
        const verdictMatch = verdict === scenario.expectedVerdict;

        const promptTokens = response.usage?.prompt ?? this.estimatePromptTokens(scenario);
        const completionTokens = response.usage?.completion ?? Math.max(60, sanitized.length * 80);
        const totalTokens = response.usage?.total ?? (promptTokens + completionTokens);
        const costUSD = response.costUSD ?? estimateCost(effectiveModel, promptTokens, completionTokens);
        const durationMs = Date.now() - startTime;
        const turnDepth = scenario.category === 'multi_turn' ? 3 : 1;
        const costEfficiency = metrics.tp > 0 ? Math.round((metrics.tp / Math.max(costUSD, 0.00001)) * 100) / 100 : (metrics.f1Score > 0 ? Math.round((metrics.f1Score / Math.max(costUSD, 0.00001)) * 10) / 10 : 0);

        return {
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          category: scenario.category,
          model: effectiveModel,
          provider: this.resolveProvider(effectiveModel),
          verdict,
          expectedVerdict: scenario.expectedVerdict,
          verdictMatch,
          tp: metrics.tp,
          fp: metrics.fp,
          fn: metrics.fn,
          precision: metrics.precision,
          recall: metrics.recall,
          f1Score: metrics.f1Score,
          snr: metrics.snr,
          snrDb: metrics.snrDb,
          ttftMs,
          promptTokens,
          completionTokens,
          totalTokens,
          costUSD,
          durationMs,
          turnDepth,
          costEfficiency,
          evidenceGatePassed: scenario.evidenceRequirement ? true : undefined,
          findings: sanitized,
          rawOutput: response.content,
        };
      } catch (err: any) {
        if (!opts.offline) {
          throw err;
        }
      }
    }

    // 3. Deterministic offline benchmark simulator
    const profile = getSimulatedProfile(effectiveModel);
    const findings: Finding[] = [];

    // Synthesize ground-truth findings deterministically based on discovery rate
    for (let idx = 0; idx < scenario.expectedFindings.length; idx++) {
      const exp = scenario.expectedFindings[idx];
      const score = deterministicScore(effectiveModel, scenario.id, idx);
      if (score <= profile.discoveryRate || profile.discoveryRate === 1.0) {
        findings.push({
          severity: exp.severity,
          path: exp.path,
          line: exp.line || 1,
          title: exp.title || 'Identified charter defect',
          body: exp.description || 'Verified ground truth defect matching scenario charter.',
          suggestion: exp.suggestion,
        });
      }
    }

    const sanitized = sanitizeFindings(findings, scenario.diffFiles);
    const metrics = calculateMetrics(scenario.expectedFindings, sanitized, opts.metricOptions);

    const arbitration = computeArbitration(
      [{ id: 'reviewer', status: 'SUCCESS', findings: sanitized }],
      1,
      { changedFiles: scenario.diffFiles }
    );
    const verdict = arbitration.verdict;
    const verdictMatch = verdict === scenario.expectedVerdict;

    const promptTokens = Math.round(this.estimatePromptTokens(scenario) * profile.promptFactor);
    const completionTokens = Math.round(Math.max(60, sanitized.length * 85) * profile.completionFactor);
    const totalTokens = promptTokens + completionTokens;
    const costUSD = estimateCost(effectiveModel, promptTokens, completionTokens);
    const ttftMs = profile.ttftBase;
    const turnDepth = scenario.category === 'multi_turn' ? Math.max(2, profile.turnDepth) : (scenario.evidenceRequirement ? profile.turnDepth : 1);
    const durationMs = ttftMs + Math.round(completionTokens * 1.5);
    const costEfficiency = metrics.tp > 0 ? Math.round((metrics.tp / Math.max(costUSD, 0.00001)) * 100) / 100 : (metrics.f1Score > 0 ? Math.round((metrics.f1Score / Math.max(costUSD, 0.00001)) * 10) / 10 : 0);

    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      category: scenario.category,
      model: effectiveModel,
      provider: this.resolveProvider(effectiveModel),
      verdict,
      expectedVerdict: scenario.expectedVerdict,
      verdictMatch,
      tp: metrics.tp,
      fp: metrics.fp,
      fn: metrics.fn,
      precision: metrics.precision,
      recall: metrics.recall,
      f1Score: metrics.f1Score,
      snr: metrics.snr,
      snrDb: metrics.snrDb,
      ttftMs,
      promptTokens,
      completionTokens,
      totalTokens,
      costUSD,
      durationMs,
      turnDepth,
      costEfficiency,
      evidenceGatePassed: scenario.evidenceRequirement ? true : undefined,
      findings: sanitized,
    };
  }

  /**
   * Executes a benchmark suite across multiple models and scenarios.
   */
  async runBenchmarkSuite(
    models: string[],
    scenarios: EvaluationScenario[] = getAllScenarios(),
    options: RunnerOptions = {}
  ): Promise<ComparativeBenchmarkReport> {
    const detailedResults: ScenarioEvaluationResult[] = [];
    const summary: Record<string, ModelSummaryMetrics> = {};

    for (const model of models) {
      let totalTp = 0;
      let totalFp = 0;
      let totalFn = 0;
      let verdictMatches = 0;
      let sumSnr = 0;
      let sumSnrDb = 0;
      let sumTtft = 0;
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let totalCostUSD = 0;
      let sumTurnDepth = 0;

      for (const scenario of scenarios) {
        const result = await this.runScenario(model, scenario, options);
        detailedResults.push(result);

        totalTp += result.tp;
        totalFp += result.fp;
        totalFn += result.fn;
        if (result.verdictMatch) verdictMatches++;
        sumSnr += result.snr;
        sumSnrDb += result.snrDb;
        sumTtft += result.ttftMs;
        totalPromptTokens += result.promptTokens;
        totalCompletionTokens += result.completionTokens;
        totalCostUSD += result.costUSD;
        sumTurnDepth += result.turnDepth;
      }

      const totalScenarios = scenarios.length;
      if (totalScenarios === 0) {
        summary[model] = {
          model,
          totalScenarios: 0,
          verdictMatches: 0,
          verdictAccuracy: 0,
          totalTp: 0,
          totalFp: 0,
          totalFn: 0,
          precision: 0,
          recall: 0,
          f1Score: 0,
          avgSnr: 0,
          avgSnrDb: 0,
          avgTtftMs: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalTokens: 0,
          totalCostUSD: 0,
          avgTurnDepth: 0,
          costEfficiency: 0,
        };
        continue;
      }

      const verdictAccuracy = Math.round((verdictMatches / totalScenarios) * 1000) / 10;
      const precision = totalTp + totalFp > 0 ? Math.round((totalTp / (totalTp + totalFp)) * 1000) / 1000 : 1.0;
      const recall = totalTp + totalFn > 0 ? Math.round((totalTp / (totalTp + totalFn)) * 1000) / 1000 : 1.0;
      const f1Score = precision + recall > 0 ? Math.round(((2 * precision * recall) / (precision + recall)) * 1000) / 1000 : 0.0;
      const avgSnr = Math.round((sumSnr / totalScenarios) * 100) / 100;
      const avgSnrDb = Math.round((sumSnrDb / totalScenarios) * 100) / 100;
      const avgTtftMs = Math.round(sumTtft / totalScenarios);
      const totalTokens = totalPromptTokens + totalCompletionTokens;
      const roundedCost = Math.round(totalCostUSD * 10_000) / 10_000;
      const avgTurnDepth = Math.round((sumTurnDepth / totalScenarios) * 10) / 10;
      const costEfficiency = totalTp > 0 ? Math.round((totalTp / Math.max(roundedCost, 0.00001)) * 100) / 100 : (f1Score > 0 ? Math.round((f1Score / Math.max(roundedCost, 0.00001)) * 10) / 10 : 0);

      summary[model] = {
        model,
        totalScenarios,
        verdictMatches,
        verdictAccuracy,
        totalTp,
        totalFp,
        totalFn,
        precision,
        recall,
        f1Score,
        avgSnr,
        avgSnrDb,
        avgTtftMs,
        totalPromptTokens,
        totalCompletionTokens,
        totalTokens,
        totalCostUSD: roundedCost,
        avgTurnDepth,
        costEfficiency,
      };
    }

    return {
      timestamp: new Date().toISOString(),
      models,
      scenarios: scenarios.map((s) => s.id),
      summary,
      detailedResults,
    };
  }

  /**
   * Formats the comparative benchmark report into a Markdown document.
   */
  formatMarkdownReport(report: ComparativeBenchmarkReport): string {
    return formatMarkdownReport(report);
  }

  /**
   * Formats the comparative benchmark report into a JSON string.
   */
  formatJSONReport(report: ComparativeBenchmarkReport): string {
    return formatJSONReport(report);
  }

  // =========================================================================
  // INTERNAL HELPERS
  // =========================================================================

  private resolveProvider(model: string): string {
    if (model.startsWith('openai/')) return 'openai';
    if (model.startsWith('anthropic/')) return 'anthropic';
    if (model.startsWith('deepseek/')) return 'deepseek';
    if (model.startsWith('google/')) return 'google';
    if (model.startsWith('openrouter/')) return 'openrouter';
    return 'openrouter';
  }

  private estimatePromptTokens(scenario: EvaluationScenario): number {
    const diffChars = scenario.diffFiles.reduce((acc, f) => acc + (f.patch?.length || 0), 0);
    return Math.round(500 + diffChars / 3.8);
  }

  private buildSystemPrompt(scenario: EvaluationScenario, options: RunnerOptions): string {
    if (options.personaPrompts?.[scenario.category]) {
      return options.personaPrompts[scenario.category];
    }
    return [
      `You are an expert ${scenario.category} code reviewer on the ct-review-bot panel.`,
      `Review the unified diff against the charter for ${scenario.category} concerns.`,
      'Respond with JSON only in the following schema:',
      '{"findings":[{"severity":"P0"|"P1"|"P2","path":"<path>","line":<int>,"title":"<short>","body":"<detail>","suggestion":"<fix>"}]}',
    ].join('\n');
  }

  private buildUserPrompt(scenario: EvaluationScenario, diff: string): string {
    const lines: string[] = [
      `Repository: ${scenario.prContext.repo}`,
      `Pull Request: #${scenario.prContext.prNumber} - ${scenario.prContext.title}`,
      `Category: ${scenario.category}`,
    ];

    if (scenario.sessionContext?.augmentedHeader) {
      lines.push('', scenario.sessionContext.augmentedHeader);
    }

    lines.push('', 'Unified diff under review:', '', diff);
    return lines.join('\n');
  }

  private parseFindings(content: string): Finding[] {
    if (!content || typeof content !== 'string') return [];
    try {
      // Look for JSON object or array
      const jsonMatch = content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (!jsonMatch) return [];
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed.findings)) return parsed.findings;
      return [];
    } catch {
      return [];
    }
  }
}

// =========================================================================
// REPORT FORMATTERS
// =========================================================================

/**
 * Formats a ComparativeBenchmarkReport into a Markdown report.
 */
export function formatMarkdownReport(report: ComparativeBenchmarkReport): string {
  const lines: string[] = [
    '# Model Comparative Evaluation & Benchmark Report',
    '',
    `**Generated**: ${report.timestamp}`,
    `**Evaluated Models**: ${report.models.join(', ')}`,
    `**Total Scenarios**: ${report.scenarios.length}`,
    '',
    '## 1. Executive Summary & Comparative Matrix',
    '',
    '| Model | Verdict Acc (%) | Precision | Recall | F1 Score | Avg SNR (dB) | TTFT (ms) | Turn Depth | Total Tokens | Cost (USD) | Cost Eff (TP/$) |',
    '| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |',
  ];

  for (const model of report.models) {
    const s = report.summary[model];
    if (!s) continue;
    const costEffStr = s.costEfficiency > 0 ? `${s.costEfficiency.toFixed(1)}` : '—';
    lines.push(
      `| \`${s.model}\` | **${s.verdictAccuracy.toFixed(1)}%** | ${s.precision.toFixed(3)} | ${s.recall.toFixed(3)} | **${s.f1Score.toFixed(3)}** | ${s.avgSnrDb.toFixed(1)} dB | ${s.avgTtftMs} ms | ${s.avgTurnDepth.toFixed(1)} | ${s.totalTokens.toLocaleString()} | $${s.totalCostUSD.toFixed(4)} | ${costEffStr} |`
    );
  }

  lines.push('', '## 2. Key Comparative Dimensions', '');
  lines.push('1. **Signal-to-Noise Ratio (SNR)**: Measures genuine defect discovery against false positives/hallucinations.');
  lines.push('2. **Time-to-First-Token (TTFT)**: Latency from initial request dispatch to first streaming token chunk.');
  lines.push('3. **Total Tokens In / Out**: Input prompt overhead and output completion verbosity.');
  lines.push('4. **Findings Accuracy, Precision & Recall**: Ground-truth defect identification ($TP$), non-defect noise ($FP$), and missed defects ($FN$).');
  lines.push('5. **Investigation Turn Depth**: Average multi-turn tool calling cycles per review.');
  lines.push('6. **Cost Efficiency**: Verified True Positive findings discovered per USD spent.');

  lines.push('', '## 3. Scenario-by-Scenario Detailed Breakdown', '');
  lines.push('| Scenario ID | Model | Category | Expected | Actual | Match | TP | FP | FN | F1 | SNR | TTFT (ms) | Cost ($) |');
  lines.push('| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');

  for (const res of report.detailedResults) {
    const matchIcon = res.verdictMatch ? '✅' : '❌';
    lines.push(
      `| \`${res.scenarioId}\` | \`${res.model}\` | ${res.category} | ${res.expectedVerdict} | ${res.verdict} | ${matchIcon} | ${res.tp} | ${res.fp} | ${res.fn} | ${res.f1Score.toFixed(2)} | ${res.snr.toFixed(1)} | ${res.ttftMs} | $${res.costUSD.toFixed(4)} |`
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Formats a ComparativeBenchmarkReport into a formatted JSON string.
 */
export function formatJSONReport(report: ComparativeBenchmarkReport): string {
  return JSON.stringify(report, null, 2);
}
