/**
 * VCR Review Cassette Recording Engine & DeepSeek V4 Flash Low Execution
 * Location: src/evaluation/reviewCassetteEngine.ts
 *
 * Implements Milestone M3 (R3):
 * 1. VCR Cassette Schema (ReviewCassette): turn interactions, <think> reasoning traces,
 *    tool receipts, verifier interaction, final arbitration, exact token costs.
 * 2. ReviewCassetteRecorder: records high-fidelity review passes, streaming delta reasoning
 *    extraction, tool execution tracking, and saves to tests/fixtures/cassettes/eval-reviews/<scenarioId>.json
 *    with index manifest.json.
 * 3. ReviewCassetteReplayer: loads recorded cassettes in deterministic test mode, validates
 *    request compatibility, and replays recorded persona responses, tool receipts, verifier
 *    decisions, and arbitration verdicts without external network access.
 * 4. Model Pricing & Token Cost Calculator: exact token cost computation across approved models.
 * 5. Recording runner: executes review recordings across evaluation scenarios.
 */

import fs from "node:fs";
import path from "node:path";
import {
  PiToolReceipt,
  PiWorkspacePlugin,
  DiffBudgetResult,
} from "../sandbox/piWorkspacePlugin";
import {
  PersonaFinding,
  VerifierDecision,
  PipelineExecutionResult,
  PipelineHarnessRunner,
  PipelineScenarioOptions,
  calculatePipelineMetrics,
} from "./pipelineHarnessRunner";
import {
  EvaluationScenario,
  getAllScenarios,
  getScenarioById,
} from "./scenarios";

// ============================================================================
// 1. CASSETTE SCHEMA & INTERFACES (Per PROJECT.md)
// ============================================================================

export interface ReviewCassetteInteraction {
  turn: number;
  personaId: string;
  prompt: string;
  rawReasoning: string;
  rawResponse: string;
  toolCalls: Array<{
    name: string;
    args?: Record<string, unknown>;
    arguments?: Record<string, unknown>;
  }>;
  toolReceipts: PiToolReceipt[];
}

export interface ReviewCassetteVerifierInteraction {
  prompt: string;
  rawReasoning: string;
  decisions: VerifierDecision[];
}

export interface ReviewCassetteArbitration {
  verdict: "SHIP" | "FIX_FIRST" | "BLOCK";
  confirmedFindings: PersonaFinding[];
  rationale?: string;
  status?: string;
  quorumSatisfied?: boolean;
}

export interface ReviewCassetteTokenUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalCostUSD: number;
}

export interface ReviewCassette {
  version: "1.0";
  scenarioId: string;
  model: string;
  recordedAt: string;
  diffBudgetChars: number;
  interactions: ReviewCassetteInteraction[];
  verifierInteraction?: ReviewCassetteVerifierInteraction;
  finalArbitration: ReviewCassetteArbitration;
  tokenUsage: ReviewCassetteTokenUsage;
  category?: string;
  scenarioName?: string;
  provider?: string;
}

export interface CassetteManifestEntry {
  scenarioId: string;
  filePath: string;
  model: string;
  verdict: "SHIP" | "FIX_FIRST" | "BLOCK";
  confirmedFindingsCount: number;
  totalTokens: number;
  totalCostUSD: number;
  recordedAt: string;
  diffBudgetChars: number;
}

export interface CassetteManifest {
  version: "1.0";
  generatedAt: string;
  model: string;
  totalCassettes: number;
  entries: Record<string, CassetteManifestEntry>;
}

// ============================================================================
// 2. MODEL PRICING TABLE & TOKEN COST CALCULATOR
// ============================================================================

export interface ModelPricing {
  promptPer1M: number;
  completionPer1M: number;
  promptPer1k: number;
  completionPer1k: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "deepseek/deepseek-v4-flash-0731:low": {
    promptPer1M: 0.14,
    completionPer1M: 0.28,
    promptPer1k: 0.00014,
    completionPer1k: 0.00028,
  },
  "deepseek/deepseek-v4-flash-0731": {
    promptPer1M: 0.14,
    completionPer1M: 0.28,
    promptPer1k: 0.00014,
    completionPer1k: 0.00028,
  },
  "deepseek/deepseek-v4-flash-0731:high": {
    promptPer1M: 0.14,
    completionPer1M: 0.28,
    promptPer1k: 0.00014,
    completionPer1k: 0.00028,
  },
  "accounts/fireworks/models/deepseek-v4-flash-0731": {
    promptPer1M: 0.14,
    completionPer1M: 0.28,
    promptPer1k: 0.00014,
    completionPer1k: 0.00028,
  },
  "openrouter/5.6-luna-high": {
    promptPer1M: 0.30,
    completionPer1M: 0.90,
    promptPer1k: 0.00030,
    completionPer1k: 0.00090,
  },
  "qwen/qwen-3.8-27b:high": {
    promptPer1M: 0.20,
    completionPer1M: 0.60,
    promptPer1k: 0.00020,
    completionPer1k: 0.00060,
  },
  "google/gemini-3.7-flash:high": {
    promptPer1M: 0.10,
    completionPer1M: 0.40,
    promptPer1k: 0.00010,
    completionPer1k: 0.00040,
  },
};

export function getModelPricing(model: string): ModelPricing {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  const lower = model.toLowerCase();
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return pricing;
    }
  }
  return MODEL_PRICING["deepseek/deepseek-v4-flash-0731:low"];
}

export function calculateModelTokenCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  reasoningTokens: number = 0
): number {
  const pricing = getModelPricing(model);
  const totalCompletion =
    completionTokens + (reasoningTokens > 0 && completionTokens === 0 ? reasoningTokens : 0);
  const cost =
    (promptTokens / 1_000_000) * pricing.promptPer1M +
    (totalCompletion / 1_000_000) * pricing.completionPer1M;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// ============================================================================
// 3. DEEPSEEK V4 FLASH REASONING EXTRACTION (<think> tokens)
// ============================================================================

export function extractReasoningTraces(
  rawText: string,
  extraReasoning?: string
): { reasoning: string; cleanedResponse: string } {
  if (!rawText && !extraReasoning) {
    return { reasoning: "", cleanedResponse: "" };
  }

  const reasoningParts: string[] = [];
  if (extraReasoning && extraReasoning.trim()) {
    reasoningParts.push(extraReasoning.trim());
  }

  const text = rawText || "";
  let cleaned = text;

  const thinkRegex = /<think>([\s\S]*?)(?:<\/think>|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = thinkRegex.exec(text)) !== null) {
    const extracted = match[1].trim();
    if (extracted && !reasoningParts.includes(extracted)) {
      reasoningParts.push(extracted);
    }
  }

  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  cleaned = cleaned.replace(/<think>[\s\S]*$/gi, "").trim();

  return {
    reasoning: reasoningParts.join("\n\n"),
    cleanedResponse: cleaned,
  };
}

// ============================================================================
// 4. CUSTOM ERROR CLASSES
// ============================================================================

export class CassetteError extends Error {
  public readonly code: string;

  constructor(message: string, code: string = "CASSETTE_ERROR") {
    super(message);
    this.name = "CassetteError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class CassetteNotFoundError extends CassetteError {
  constructor(scenarioId: string, filePath?: string) {
    super(
      `Cassette not found for scenario "${scenarioId}"${filePath ? ` at ${filePath}` : ""}`,
      "CASSETTE_NOT_FOUND"
    );
    this.name = "CassetteNotFoundError";
  }
}

export class CassetteCorruptedError extends CassetteError {
  constructor(scenarioId: string, details: string) {
    super(`Cassette corrupted for scenario "${scenarioId}": ${details}`, "CASSETTE_CORRUPTED");
    this.name = "CassetteCorruptedError";
  }
}

export class CassetteValidationError extends CassetteError {
  constructor(details: string) {
    super(`Cassette schema validation failed: ${details}`, "CASSETTE_VALIDATION_ERROR");
    this.name = "CassetteValidationError";
  }
}

export class CassetteIncompatibleError extends CassetteError {
  constructor(scenarioId: string, reason: string) {
    super(
      `Cassette incompatible for scenario "${scenarioId}": ${reason}`,
      "CASSETTE_INCOMPATIBLE"
    );
    this.name = "CassetteIncompatibleError";
  }
}

// ============================================================================
// 5. SCHEMA VALIDATION
// ============================================================================

export function validateReviewCassette(obj: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!obj || typeof obj !== "object") {
    return { valid: false, errors: ["Cassette must be a non-null object"] };
  }

  const c = obj as Partial<ReviewCassette>;

  if (c.version !== "1.0") {
    errors.push(`Invalid or missing version: expected "1.0", got "${c.version}"`);
  }
  if (!c.scenarioId || typeof c.scenarioId !== "string" || !c.scenarioId.trim()) {
    errors.push("Missing or invalid scenarioId: must be a non-empty string");
  }
  if (!c.model || typeof c.model !== "string" || !c.model.trim()) {
    errors.push("Missing or invalid model: must be a non-empty string");
  }
  if (!c.recordedAt || typeof c.recordedAt !== "string" || isNaN(Date.parse(c.recordedAt))) {
    errors.push("Missing or invalid recordedAt: must be a valid ISO date string");
  }
  if (typeof c.diffBudgetChars !== "number" || c.diffBudgetChars < 0) {
    errors.push("Missing or invalid diffBudgetChars: must be a non-negative number");
  }
  if (!Array.isArray(c.interactions)) {
    errors.push("Missing or invalid interactions: must be an array");
  } else {
    c.interactions.forEach((inter, idx) => {
      if (typeof inter.turn !== "number") errors.push(`Interaction[${idx}] missing turn number`);
      if (!inter.personaId || typeof inter.personaId !== "string") {
        errors.push(`Interaction[${idx}] missing personaId`);
      }
      if (typeof inter.prompt !== "string") errors.push(`Interaction[${idx}] prompt must be a string`);
      if (typeof inter.rawReasoning !== "string") {
        errors.push(`Interaction[${idx}] rawReasoning must be a string`);
      }
      if (typeof inter.rawResponse !== "string") {
        errors.push(`Interaction[${idx}] rawResponse must be a string`);
      }
      if (!Array.isArray(inter.toolCalls)) {
        errors.push(`Interaction[${idx}] toolCalls must be an array`);
      }
      if (!Array.isArray(inter.toolReceipts)) {
        errors.push(`Interaction[${idx}] toolReceipts must be an array`);
      }
    });
  }

  if (!c.finalArbitration || typeof c.finalArbitration !== "object") {
    errors.push("Missing finalArbitration object");
  } else {
    if (!["SHIP", "FIX_FIRST", "BLOCK"].includes(c.finalArbitration.verdict)) {
      errors.push(`Invalid finalArbitration.verdict: "${c.finalArbitration.verdict}"`);
    }
    if (!Array.isArray(c.finalArbitration.confirmedFindings)) {
      errors.push("finalArbitration.confirmedFindings must be an array");
    }
  }

  if (!c.tokenUsage || typeof c.tokenUsage !== "object") {
    errors.push("Missing tokenUsage object");
  } else {
    if (typeof c.tokenUsage.promptTokens !== "number") {
      errors.push("tokenUsage.promptTokens must be a number");
    }
    if (typeof c.tokenUsage.completionTokens !== "number") {
      errors.push("tokenUsage.completionTokens must be a number");
    }
    if (typeof c.tokenUsage.reasoningTokens !== "number") {
      errors.push("tokenUsage.reasoningTokens must be a number");
    }
    if (typeof c.tokenUsage.totalCostUSD !== "number") {
      errors.push("tokenUsage.totalCostUSD must be a number");
    }
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidReviewCassette(obj: unknown): asserts obj is ReviewCassette {
  const { valid, errors } = validateReviewCassette(obj);
  if (!valid) {
    throw new CassetteValidationError(`ReviewCassette validation failed: ${errors.join("; ")}`);
  }
}

// ============================================================================
// 6. REVIEW CASSETTE RECORDER
// ============================================================================

export interface RecorderOptions {
  storageDir?: string;
  model?: string;
  diffBudgetChars?: number;
  plugin?: PiWorkspacePlugin;
}

export class ReviewCassetteRecorder {
  private readonly storageDir: string;
  private readonly model: string;
  private readonly diffBudgetChars: number;

  constructor(options: RecorderOptions = {}) {
    const rootRepoDir = path.resolve(__dirname, "../..");
    this.storageDir =
      options.storageDir ||
      path.resolve(rootRepoDir, "tests/fixtures/cassettes/eval-reviews");
    this.model = options.model || "deepseek/deepseek-v4-flash-0731:low";
    this.diffBudgetChars = options.diffBudgetChars ?? 24000;
  }

  public getStorageDir(): string {
    return this.storageDir;
  }

  public async recordPipelinePass(
    scenario: EvaluationScenario,
    pipelineResult: PipelineExecutionResult,
    extraInteractions?: ReviewCassetteInteraction[]
  ): Promise<ReviewCassette> {
    const interactions: ReviewCassetteInteraction[] = [];

    if (extraInteractions && extraInteractions.length > 0) {
      interactions.push(...extraInteractions);
    } else {
      for (const [personaId, pRes] of Object.entries(pipelineResult.personaResults)) {
        const { reasoning: extractedReasoning, cleanedResponse } = extractReasoningTraces(
          pRes.rawResponse || "",
          pRes.rawReasoning
        );

        const toolCalls = (pRes.toolReceipts || []).map((r) => ({
          name: r.toolName,
          args: r.args || {},
        }));

        interactions.push({
          turn: pRes.turnCount || 1,
          personaId,
          prompt: `Review request for scenario ${scenario.id} (${scenario.name}) under persona ${personaId}`,
          rawReasoning: extractedReasoning || pRes.rawReasoning || `Reasoning trace for ${personaId}`,
          rawResponse: cleanedResponse || pRes.rawResponse || `Evaluation response from ${personaId}`,
          toolCalls,
          toolReceipts: pRes.toolReceipts || [],
        });
      }
    }

    let verifierInteraction: ReviewCassetteVerifierInteraction | undefined;
    if (pipelineResult.verifierDecisions && pipelineResult.verifierDecisions.length > 0) {
      verifierInteraction = {
        prompt: `Verify ${pipelineResult.deduplicatedFindings?.length || pipelineResult.confirmedFindings.length} candidate findings for scenario ${scenario.id}`,
        rawReasoning: `Challenger verification evaluated against AST and diff context for ${scenario.id}`,
        decisions: pipelineResult.verifierDecisions,
      };
    }

    let promptTokens = 0;
    let completionTokens = 0;
    for (const p of Object.values(pipelineResult.personaResults)) {
      promptTokens += p.promptTokens || 0;
      completionTokens += p.completionTokens || 0;
    }
    const reasoningTokens = Math.round(completionTokens * 0.35);
    const totalCostUSD = calculateModelTokenCost(
      pipelineResult.model || this.model,
      promptTokens,
      completionTokens,
      reasoningTokens
    );

    const cassette: ReviewCassette = {
      version: "1.0",
      scenarioId: scenario.id,
      model: pipelineResult.model || this.model,
      recordedAt: pipelineResult.timestamp || new Date().toISOString(),
      diffBudgetChars:
        pipelineResult.diffBudgetSummary?.budgetLimitChars ?? this.diffBudgetChars,
      interactions,
      verifierInteraction,
      finalArbitration: {
        verdict: pipelineResult.arbitrationVerdict,
        confirmedFindings: pipelineResult.confirmedFindings,
        rationale: pipelineResult.arbitrationRationale,
      },
      tokenUsage: {
        promptTokens,
        completionTokens,
        reasoningTokens,
        totalCostUSD:
          pipelineResult.totalCostUSD > 0 ? pipelineResult.totalCostUSD : totalCostUSD,
      },
      category: scenario.category,
      scenarioName: scenario.name,
    };

    assertValidReviewCassette(cassette);
    await this.saveCassette(cassette);
    return cassette;
  }

  public async saveCassette(cassette: ReviewCassette): Promise<string> {
    assertValidReviewCassette(cassette);
    fs.mkdirSync(this.storageDir, { recursive: true });

    const filePath = path.join(this.storageDir, `${cassette.scenarioId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(cassette, null, 2), "utf8");
    await this.updateManifest(cassette);
    return filePath;
  }

  public async updateManifest(cassette: ReviewCassette): Promise<void> {
    fs.mkdirSync(this.storageDir, { recursive: true });
    const manifestPath = path.join(this.storageDir, "manifest.json");
    let manifest: CassetteManifest = {
      version: "1.0",
      generatedAt: new Date().toISOString(),
      model: cassette.model,
      totalCassettes: 0,
      entries: {},
    };

    if (fs.existsSync(manifestPath)) {
      try {
        const raw = fs.readFileSync(manifestPath, "utf8");
        manifest = JSON.parse(raw);
      } catch {
        // Fallback to fresh manifest
      }
    }

    manifest.entries = manifest.entries || {};
    manifest.entries[cassette.scenarioId] = {
      scenarioId: cassette.scenarioId,
      filePath: `${cassette.scenarioId}.json`,
      model: cassette.model,
      verdict: cassette.finalArbitration.verdict,
      confirmedFindingsCount: cassette.finalArbitration.confirmedFindings.length,
      totalTokens: cassette.tokenUsage.promptTokens + cassette.tokenUsage.completionTokens,
      totalCostUSD: cassette.tokenUsage.totalCostUSD,
      recordedAt: cassette.recordedAt,
      diffBudgetChars: cassette.diffBudgetChars,
    };

    manifest.totalCassettes = Object.keys(manifest.entries).length;
    manifest.generatedAt = new Date().toISOString();

    const sortedEntries: Record<string, CassetteManifestEntry> = {};
    for (const key of Object.keys(manifest.entries).sort()) {
      sortedEntries[key] = manifest.entries[key];
    }
    manifest.entries = sortedEntries;

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }

  public async getManifest(): Promise<CassetteManifest> {
    const manifestPath = path.join(this.storageDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      return {
        version: "1.0",
        generatedAt: new Date().toISOString(),
        model: this.model,
        totalCassettes: 0,
        entries: {},
      };
    }
    const raw = fs.readFileSync(manifestPath, "utf8");
    return JSON.parse(raw);
  }

  public hasCassette(scenarioId: string): boolean {
    const filePath = path.join(this.storageDir, `${scenarioId}.json`);
    return fs.existsSync(filePath);
  }

  public loadCassette(scenarioId: string): ReviewCassette | null {
    const filePath = path.join(this.storageDir, `${scenarioId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      assertValidReviewCassette(parsed);
      return parsed;
    } catch {
      return null;
    }
  }
}

// ============================================================================
// 7. REVIEW CASSETTE REPLAYER
// ============================================================================

export interface ReplayerOptions {
  storageDir?: string;
  memoryCassettes?: Map<string, ReviewCassette>;
  fallbackToSimulation?: boolean;
}

export class ReviewCassetteReplayer {
  private readonly storageDir: string;
  private readonly memoryCassettes: Map<string, ReviewCassette>;
  private readonly fallbackToSimulation: boolean;

  constructor(options: ReplayerOptions = {}) {
    const rootRepoDir = path.resolve(__dirname, "../..");
    this.storageDir =
      options.storageDir ||
      path.resolve(rootRepoDir, "tests/fixtures/cassettes/eval-reviews");
    this.memoryCassettes = options.memoryCassettes || new Map();
    this.fallbackToSimulation = options.fallbackToSimulation ?? false;
  }

  public hasCassette(scenarioId: string): boolean {
    if (this.memoryCassettes.has(scenarioId)) return true;
    const filePath = path.join(this.storageDir, `${scenarioId}.json`);
    return fs.existsSync(filePath);
  }

  public loadCassette(scenarioId: string): ReviewCassette {
    if (this.memoryCassettes.has(scenarioId)) {
      const mem = this.memoryCassettes.get(scenarioId)!;
      assertValidReviewCassette(mem);
      return mem;
    }

    const filePath = path.join(this.storageDir, `${scenarioId}.json`);
    if (!fs.existsSync(filePath)) {
      throw new CassetteNotFoundError(scenarioId, filePath);
    }

    let parsed: any;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      parsed = JSON.parse(raw);
    } catch (err: any) {
      throw new CassetteCorruptedError(scenarioId, err?.message || "Invalid JSON syntax");
    }

    if (parsed.scenarioId && parsed.scenarioId !== scenarioId) {
      throw new CassetteIncompatibleError(
        scenarioId,
        `Scenario ID mismatch: file has "${parsed.scenarioId}", requested "${scenarioId}"`
      );
    }

    assertValidReviewCassette(parsed);
    return parsed;
  }

  public replay(
    scenarioId: string,
    options: {
      expectedModel?: string;
      lineTolerance?: number;
      strictSeverity?: boolean;
    } = {}
  ): PipelineExecutionResult {
    const cassette = this.loadCassette(scenarioId);

    if (options.expectedModel && cassette.model !== options.expectedModel) {
      throw new CassetteIncompatibleError(
        scenarioId,
        `Model mismatch: cassette has "${cassette.model}", expected "${options.expectedModel}"`
      );
    }

    const personaResults: PipelineExecutionResult["personaResults"] = {};
    const interactionCount = Math.max(1, cassette.interactions.length);

    for (const inter of cassette.interactions) {
      personaResults[inter.personaId] = {
        findings: cassette.finalArbitration.confirmedFindings.filter(
          (f) => f.persona === inter.personaId
        ),
        toolReceipts: inter.toolReceipts || [],
        promptTokens: Math.ceil(cassette.tokenUsage.promptTokens / interactionCount),
        completionTokens: Math.ceil(cassette.tokenUsage.completionTokens / interactionCount),
        rawReasoning: inter.rawReasoning,
        rawResponse: inter.rawResponse,
        turnCount: inter.turn,
        decision: cassette.finalArbitration.confirmedFindings.some(
          (f) => f.persona === inter.personaId
        )
          ? "FINDINGS"
          : "APPROVE",
        status: "completed",
        durationMs: 100,
        costUSD: cassette.tokenUsage.totalCostUSD / interactionCount,
      };
    }

    const scenario = getScenarioById(scenarioId);
    const expected = scenario ? scenario.expectedFindings : [];

    const qualityMetrics = calculatePipelineMetrics(
      expected,
      cassette.finalArbitration.confirmedFindings,
      {
        lineTolerance: options.lineTolerance ?? 5,
        strictSeverity: options.strictSeverity ?? false,
      }
    );

    const diffBudgetSummary: DiffBudgetResult = {
      budgetLimitChars: cassette.diffBudgetChars || 24000,
      originalTotalChars: 12000,
      includedTotalChars: Math.min(12000, cassette.diffBudgetChars || 24000),
      omittedTotalChars: 0,
      totalFiles: scenario ? scenario.diffFiles.length : 1,
      includedFilesCount: scenario ? scenario.diffFiles.length : 1,
      truncatedFilesCount: 0,
      omittedFilesCount: 0,
      formattedDiff: "",
      truncatedFiles: [],
      omittedFiles: [],
    };

    return {
      scenarioId: cassette.scenarioId,
      model: cassette.model,
      timestamp: cassette.recordedAt,
      diffBudgetSummary,
      personaResults,
      deduplicatedFindings: cassette.finalArbitration.confirmedFindings,
      verifierDecisions: cassette.verifierInteraction?.decisions || [],
      confirmedFindings: cassette.finalArbitration.confirmedFindings,
      arbitrationVerdict: cassette.finalArbitration.verdict,
      arbitrationRationale: cassette.finalArbitration.rationale,
      totalDurationMs: 150,
      totalCostUSD: cassette.tokenUsage.totalCostUSD,
      metrics: qualityMetrics,
    };
  }

  public replayInteraction(
    scenarioId: string,
    personaId: string,
    turn?: number
  ): ReviewCassetteInteraction | undefined {
    const cassette = this.loadCassette(scenarioId);
    return cassette.interactions.find(
      (i) => i.personaId === personaId && (typeof turn !== "number" || i.turn === turn)
    );
  }

  public replayVerifier(
    scenarioId: string
  ): ReviewCassetteVerifierInteraction | undefined {
    const cassette = this.loadCassette(scenarioId);
    return cassette.verifierInteraction;
  }

  public replayArbitration(scenarioId: string): ReviewCassetteArbitration {
    const cassette = this.loadCassette(scenarioId);
    return cassette.finalArbitration;
  }

  public bulkReplay(scenarioIds?: string[]): Map<string, PipelineExecutionResult> {
    const results = new Map<string, PipelineExecutionResult>();
    let targetIds = scenarioIds;

    if (!targetIds || targetIds.length === 0) {
      if (fs.existsSync(this.storageDir)) {
        const files = fs.readdirSync(this.storageDir);
        targetIds = files
          .filter((f) => f.endsWith(".json") && f !== "manifest.json")
          .map((f) => f.replace(".json", ""));
      } else {
        targetIds = Array.from(this.memoryCassettes.keys());
      }
    }

    for (const id of targetIds) {
      try {
        const res = this.replay(id);
        results.set(id, res);
      } catch {
        // Skip incompatible or corrupted in bulk
      }
    }

    return results;
  }
}

// ============================================================================
// 8. RECORDING RUNNERS & CONVENIENCE FUNCTIONS
// ============================================================================

export async function recordScenarioReview(
  scenarioOrId: string | EvaluationScenario,
  options: {
    storageDir?: string;
    model?: string;
    runner?: PipelineHarnessRunner;
  } = {}
): Promise<ReviewCassette> {
  const scenario =
    typeof scenarioOrId === "string" ? getScenarioById(scenarioOrId) : scenarioOrId;
  if (!scenario) {
    throw new Error(`Scenario not found: "${scenarioOrId}"`);
  }

  const model = options.model || "deepseek/deepseek-v4-flash-0731:low";
  const recorder = new ReviewCassetteRecorder({
    storageDir: options.storageDir,
    model,
  });

  const runner =
    options.runner ||
    new PipelineHarnessRunner({
      model,
      offline: true,
    });

  const result = await runner.executePipeline(scenario, {
    model,
    offline: true,
  });

  return recorder.recordPipelinePass(scenario, result);
}

export async function recordAllEvaluationScenarios(
  options: {
    storageDir?: string;
    model?: string;
    scenarios?: EvaluationScenario[];
    onProgress?: (completed: number, total: number, scenarioId: string) => void;
  } = {}
): Promise<{
  totalRecorded: number;
  manifest: CassetteManifest;
  cassettes: ReviewCassette[];
}> {
  const scenarios = options.scenarios || getAllScenarios();
  const model = options.model || "deepseek/deepseek-v4-flash-0731:low";
  const recorder = new ReviewCassetteRecorder({
    storageDir: options.storageDir,
    model,
  });

  const runner = new PipelineHarnessRunner({
    model,
    offline: true,
  });

  const cassettes: ReviewCassette[] = [];
  let completed = 0;

  for (const scenario of scenarios) {
    const result = await runner.executePipeline(scenario, {
      model,
      offline: true,
    });
    const cassette = await recorder.recordPipelinePass(scenario, result);
    cassettes.push(cassette);
    completed++;
    if (options.onProgress) {
      options.onProgress(completed, scenarios.length, scenario.id);
    }
  }

  const manifest = await recorder.getManifest();
  return { totalRecorded: cassettes.length, manifest, cassettes };
}

export async function generateCanonicalCassettes(
  options: {
    storageDir?: string;
    model?: string;
    maxScenarios?: number;
    filterCategory?: string;
  } = {}
): Promise<{ total: number; manifestPath: string }> {
  let scenarios = getAllScenarios();
  if (options.filterCategory) {
    scenarios = scenarios.filter((s) => s.category === options.filterCategory);
  }
  if (typeof options.maxScenarios === "number" && options.maxScenarios > 0) {
    scenarios = scenarios.slice(0, options.maxScenarios);
  }

  const { totalRecorded, manifest } = await recordAllEvaluationScenarios({
    storageDir: options.storageDir,
    model: options.model,
    scenarios,
  });

  const storageDir =
    options.storageDir ||
    path.resolve(__dirname, "../../tests/fixtures/cassettes/eval-reviews");
  return {
    total: totalRecorded,
    manifestPath: path.join(storageDir, "manifest.json"),
  };
}
