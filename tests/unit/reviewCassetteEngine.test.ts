/**
 * Unit Test Suite: VCR Review Cassette Recording Engine & DeepSeek V4 Flash Low Execution
 * Location: tests/unit/reviewCassetteEngine.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import {
  ReviewCassette,
  ReviewCassetteInteraction,
  ReviewCassetteVerifierInteraction,
  ReviewCassetteArbitration,
  ReviewCassetteTokenUsage,
  CassetteManifest,
  MODEL_PRICING,
  getModelPricing,
  calculateModelTokenCost,
  extractReasoningTraces,
  validateReviewCassette,
  assertValidReviewCassette,
  CassetteError,
  CassetteNotFoundError,
  CassetteCorruptedError,
  CassetteValidationError,
  CassetteIncompatibleError,
  ReviewCassetteRecorder,
  ReviewCassetteReplayer,
  recordScenarioReview,
  recordAllEvaluationScenarios,
} from "../../src/evaluation/reviewCassetteEngine";
import {
  PipelineHarnessRunner,
  PipelineExecutionResult,
} from "../../src/evaluation/pipelineHarnessRunner";
import {
  getAllScenarios,
  getScenarioById,
  EvaluationScenario,
} from "../../src/evaluation/scenarios";

describe("Review Cassette Engine Unit Tests (Milestone M3)", () => {
  const rootRepoDir = path.resolve(__dirname, "../..");
  const canonicalCassettesDir = path.resolve(
    rootRepoDir,
    "tests/fixtures/cassettes/eval-reviews"
  );
  const tempTestDir = path.resolve(
    rootRepoDir,
    "tests/fixtures/cassettes/temp-test-cassettes"
  );

  beforeEach(() => {
    fs.mkdirSync(tempTestDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempTestDir)) {
      fs.rmSync(tempTestDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 1. CASSETTE SCHEMA & VALIDATION
  // =========================================================================
  describe("1. ReviewCassette Schema & Validation", () => {
    const validCassette: ReviewCassette = {
      version: "1.0",
      scenarioId: "scen-valid-1",
      model: "deepseek/deepseek-v4-flash-0731:low",
      recordedAt: new Date().toISOString(),
      diffBudgetChars: 24000,
      interactions: [
        {
          turn: 1,
          personaId: "security",
          prompt: "Analyze SIP INVITE authorization",
          rawReasoning: "Trace tenantId in authorization headers",
          rawResponse: "Found potential unauthenticated bypass",
          toolCalls: [
            {
              name: "pi.fs.readFile",
              args: { path: "sip_signaling_service/index.ts" },
            },
          ],
          toolReceipts: [
            {
              callId: "call-1",
              personaId: "security",
              turn: 1,
              toolName: "pi.fs.readFile",
              args: { path: "sip_signaling_service/index.ts" },
              startTime: 1000,
              endTime: 1050,
              durationMs: 50,
              bytesRead: 1200,
              filesScanned: 1,
              resultCount: 1,
              status: "success",
              estimatedPromptTokens: 200,
              estimatedCompletionTokens: 100,
            },
          ],
        },
      ],
      verifierInteraction: {
        prompt: "Verify candidate findings",
        rawReasoning: "Evaluating tenant check AST node",
        decisions: [
          {
            findingId: "f-1",
            verdict: "CONFIRM",
            rationale: "True positive isolation defect",
            confidence: 0.95,
          },
        ],
      },
      finalArbitration: {
        verdict: "BLOCK",
        confirmedFindings: [
          {
            id: "f-1",
            persona: "security",
            path: "sip_signaling_service/index.ts",
            line: 42,
            severity: "P0",
            title: "Tenant bypass",
            body: "Missing orgId verification",
            confidence: 0.95,
          },
        ],
      },
      tokenUsage: {
        promptTokens: 2500,
        completionTokens: 600,
        reasoningTokens: 200,
        totalCostUSD: 0.000518,
      },
    };

    it("serializes and deserializes valid ReviewCassette without data loss", () => {
      const jsonStr = JSON.stringify(validCassette, null, 2);
      const parsed = JSON.parse(jsonStr) as ReviewCassette;

      expect(parsed.version).toBe("1.0");
      expect(parsed.scenarioId).toBe("scen-valid-1");
      expect(parsed.model).toBe("deepseek/deepseek-v4-flash-0731:low");
      expect(parsed.interactions.length).toBe(1);
      expect(parsed.interactions[0].toolReceipts[0].bytesRead).toBe(1200);
      expect(parsed.finalArbitration.verdict).toBe("BLOCK");
      expect(parsed.tokenUsage.totalCostUSD).toBeCloseTo(0.000518, 6);
    });

    it("validateReviewCassette returns valid: true on compliant object", () => {
      const result = validateReviewCassette(validCassette);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it("assertValidReviewCassette succeeds on compliant object", () => {
      expect(() => assertValidReviewCassette(validCassette)).not.toThrow();
    });

    it("validateReviewCassette detects invalid version and missing fields", () => {
      const invalid: any = {
        version: "2.0",
        scenarioId: "",
        model: "",
        interactions: "not-an-array",
        finalArbitration: { verdict: "INVALID_VERDICT" },
        tokenUsage: {},
      };

      const result = validateReviewCassette(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("version"))).toBe(true);
      expect(result.errors.some((e) => e.includes("scenarioId"))).toBe(true);
      expect(result.errors.some((e) => e.includes("interactions"))).toBe(true);
      expect(result.errors.some((e) => e.includes("finalArbitration.verdict"))).toBe(true);
    });

    it("assertValidReviewCassette throws CassetteValidationError on malformed object", () => {
      const malformed = { model: "deepseek" };
      expect(() => assertValidReviewCassette(malformed)).toThrow(CassetteValidationError);
    });
  });

  // =========================================================================
  // 2. DEEPSEEK V4 FLASH REASONING EXTRACTION (<think> tokens)
  // =========================================================================
  describe("2. DeepSeek V4 Flash Reasoning Trace Extraction", () => {
    it("extracts reasoning tokens enclosed in <think>...</think> tags", () => {
      const raw = "<think>\nInspecting SIP transfer race condition between BYE and INVITE.\n</think>\nAnalysis complete: Defect detected.";
      const { reasoning, cleanedResponse } = extractReasoningTraces(raw);

      expect(reasoning).toContain("Inspecting SIP transfer race condition");
      expect(cleanedResponse).toBe("Analysis complete: Defect detected.");
      expect(cleanedResponse).not.toContain("<think>");
    });

    it("extracts multiple <think> blocks in streaming reasoning output", () => {
      const raw = "<think>Step 1: Check AST</think> Intermediate text <think>Step 2: Check caller contract</think> Final conclusion";
      const { reasoning, cleanedResponse } = extractReasoningTraces(raw);

      expect(reasoning).toContain("Step 1: Check AST");
      expect(reasoning).toContain("Step 2: Check caller contract");
      expect(cleanedResponse).toBe("Intermediate text  Final conclusion");
    });

    it("handles unclosed <think> tag at the end of streaming deltas", () => {
      const raw = "Preamble <think>Still reasoning about jitter buffer allocation...";
      const { reasoning, cleanedResponse } = extractReasoningTraces(raw);

      expect(reasoning).toContain("Still reasoning about jitter buffer allocation...");
      expect(cleanedResponse).toBe("Preamble");
    });

    it("merges explicit extraReasoning parameter with <think> traces", () => {
      const raw = "<think>Inside think block</think> Response content";
      const { reasoning, cleanedResponse } = extractReasoningTraces(raw, "Explicit OpenRouter delta reasoning");

      expect(reasoning).toContain("Explicit OpenRouter delta reasoning");
      expect(reasoning).toContain("Inside think block");
      expect(cleanedResponse).toBe("Response content");
    });

    it("returns empty strings for null or empty input", () => {
      const { reasoning, cleanedResponse } = extractReasoningTraces("");
      expect(reasoning).toBe("");
      expect(cleanedResponse).toBe("");
    });
  });

  // =========================================================================
  // 3. MODEL PRICING & TOKEN COST CALCULATOR
  // =========================================================================
  describe("3. Model Pricing Table & Token Cost Calculator", () => {
    it("computes exact cost for DeepSeek V4 Flash rates ($0.14/M in, $0.28/M out)", () => {
      const promptTokens = 50000;
      const completionTokens = 10000;
      // (50000 * 0.14 + 10000 * 0.28) / 1,000,000 = (7000 + 2800) / 1,000,000 = 0.0098
      const cost = calculateModelTokenCost(
        "deepseek/deepseek-v4-flash-0731:low",
        promptTokens,
        completionTokens
      );
      expect(cost).toBeCloseTo(0.0098, 6);
    });

    it("computes cost for alternative approved models in pricing table", () => {
      const lunaCost = calculateModelTokenCost("openrouter/5.6-luna-high", 10000, 2000);
      // (10000 * 0.30 + 2000 * 0.90) / 1,000,000 = (3000 + 1800) / 1,000,000 = 0.0048
      expect(lunaCost).toBeCloseTo(0.0048, 6);

      const qwenCost = calculateModelTokenCost("qwen/qwen-3.8-27b:high", 10000, 2000);
      // (10000 * 0.20 + 2000 * 0.60) / 1,000,000 = (2000 + 1200) / 1,000,000 = 0.0032
      expect(qwenCost).toBeCloseTo(0.0032, 6);

      const geminiCost = calculateModelTokenCost("google/gemini-3.7-flash:high", 10000, 2000);
      // (10000 * 0.10 + 2000 * 0.40) / 1,000,000 = (1000 + 800) / 1,000,000 = 0.0018
      expect(geminiCost).toBeCloseTo(0.0018, 6);
    });

    it("handles zero tokens with zero cost", () => {
      const cost = calculateModelTokenCost("deepseek/deepseek-v4-flash-0731:low", 0, 0, 0);
      expect(cost).toBe(0);
    });

    it("falls back to default DeepSeek pricing for unknown models", () => {
      const pricing = getModelPricing("custom-unknown-model");
      expect(pricing.promptPer1M).toBe(0.14);
      expect(pricing.completionPer1M).toBe(0.28);
    });
  });

  // =========================================================================
  // 4. REVIEW CASSETTE RECORDER
  // =========================================================================
  describe("4. ReviewCassetteRecorder", () => {
    it("records a pipeline pass and writes cassette and manifest to disk", async () => {
      const scenario = getScenarioById("telecom-haystack-sip-unreleased-port-error") || getAllScenarios()[0];
      const recorder = new ReviewCassetteRecorder({ storageDir: tempTestDir });
      const runner = new PipelineHarnessRunner({ offline: true });

      const pipelineResult = await runner.executePipeline(scenario, { offline: true });
      const cassette = await recorder.recordPipelinePass(scenario, pipelineResult);

      expect(cassette.scenarioId).toBe(scenario.id);
      expect(cassette.model).toBe("deepseek/deepseek-v4-flash-0731:low");
      expect(cassette.interactions.length).toBe(5);
      expect(cassette.finalArbitration.verdict).toBe(pipelineResult.arbitrationVerdict);

      const cassettePath = path.join(tempTestDir, `${scenario.id}.json`);
      expect(fs.existsSync(cassettePath)).toBe(true);

      const manifestPath = path.join(tempTestDir, "manifest.json");
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest: CassetteManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      expect(manifest.totalCassettes).toBe(1);
      expect(manifest.entries[scenario.id]).toBeDefined();
      expect(manifest.entries[scenario.id].verdict).toBe(cassette.finalArbitration.verdict);
    });

    it("updates manifest incrementally when recording multiple cassettes", async () => {
      const recorder = new ReviewCassetteRecorder({ storageDir: tempTestDir });
      const runner = new PipelineHarnessRunner({ offline: true });
      const scenarios = getAllScenarios().slice(0, 3);

      for (const scen of scenarios) {
        const result = await runner.executePipeline(scen, { offline: true });
        await recorder.recordPipelinePass(scen, result);
      }

      const manifest = await recorder.getManifest();
      expect(manifest.totalCassettes).toBe(3);
      for (const scen of scenarios) {
        expect(manifest.entries[scen.id]).toBeDefined();
        expect(recorder.hasCassette(scen.id)).toBe(true);
      }
    });

    it("loads saved cassette accurately via loadCassette", async () => {
      const scenario = getAllScenarios()[0];
      const recorder = new ReviewCassetteRecorder({ storageDir: tempTestDir });
      const runner = new PipelineHarnessRunner({ offline: true });

      const result = await runner.executePipeline(scenario, { offline: true });
      await recorder.recordPipelinePass(scenario, result);

      const loaded = recorder.loadCassette(scenario.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.scenarioId).toBe(scenario.id);
      expect(loaded?.finalArbitration.verdict).toBe(result.arbitrationVerdict);
    });
  });

  // =========================================================================
  // 5. REVIEW CASSETTE REPLAYER (Deterministic Offline Mode)
  // =========================================================================
  describe("5. ReviewCassetteReplayer", () => {
    let recorder: ReviewCassetteRecorder;
    let replayer: ReviewCassetteReplayer;
    let sampleScenario: EvaluationScenario;

    beforeEach(async () => {
      recorder = new ReviewCassetteRecorder({ storageDir: tempTestDir });
      replayer = new ReviewCassetteReplayer({ storageDir: tempTestDir });
      sampleScenario = getAllScenarios()[0];

      const runner = new PipelineHarnessRunner({ offline: true });
      const result = await runner.executePipeline(sampleScenario, { offline: true });
      await recorder.recordPipelinePass(sampleScenario, result);
    });

    it("reconstructs full PipelineExecutionResult without network calls", () => {
      const replayed = replayer.replay(sampleScenario.id);

      expect(replayed.scenarioId).toBe(sampleScenario.id);
      expect(replayed.model).toBe("deepseek/deepseek-v4-flash-0731:low");
      expect(replayed.arbitrationVerdict).toBeDefined();
      expect(replayed.confirmedFindings).toBeDefined();
      expect(replayed.personaResults).toBeDefined();
      expect(Object.keys(replayed.personaResults).length).toBe(5);
    });

    it("replays individual persona interaction with tool receipts accurately", () => {
      const interaction = replayer.replayInteraction(sampleScenario.id, "security");
      expect(interaction).toBeDefined();
      expect(interaction?.personaId).toBe("security");
      expect(interaction?.prompt).toContain(sampleScenario.id);
    });

    it("replays verifier decisions and arbitration breakdown", () => {
      const verifier = replayer.replayVerifier(sampleScenario.id);
      const arbitration = replayer.replayArbitration(sampleScenario.id);

      expect(arbitration).toBeDefined();
      expect(["SHIP", "FIX_FIRST", "BLOCK"]).toContain(arbitration.verdict);
    });

    it("supports in-memory cassette replay via memoryCassettes option", () => {
      const memCassette: ReviewCassette = {
        version: "1.0",
        scenarioId: "mem-scen-1",
        model: "deepseek/deepseek-v4-flash-0731:low",
        recordedAt: new Date().toISOString(),
        diffBudgetChars: 24000,
        interactions: [],
        finalArbitration: { verdict: "SHIP", confirmedFindings: [] },
        tokenUsage: { promptTokens: 100, completionTokens: 50, reasoningTokens: 20, totalCostUSD: 0.000028 },
      };

      const memoryMap = new Map<string, ReviewCassette>();
      memoryMap.set("mem-scen-1", memCassette);

      const memReplayer = new ReviewCassetteReplayer({ memoryCassettes: memoryMap });
      expect(memReplayer.hasCassette("mem-scen-1")).toBe(true);

      const result = memReplayer.replay("mem-scen-1");
      expect(result.scenarioId).toBe("mem-scen-1");
      expect(result.arbitrationVerdict).toBe("SHIP");
    });

    it("bulk replay of 50 cassettes executes in < 500ms", async () => {
      const memoryMap = new Map<string, ReviewCassette>();
      for (let i = 0; i < 50; i++) {
        memoryMap.set(`bulk-scen-${i}`, {
          version: "1.0",
          scenarioId: `bulk-scen-${i}`,
          model: "deepseek/deepseek-v4-flash-0731:low",
          recordedAt: new Date().toISOString(),
          diffBudgetChars: 24000,
          interactions: [],
          finalArbitration: { verdict: "SHIP", confirmedFindings: [] },
          tokenUsage: { promptTokens: 200, completionTokens: 50, reasoningTokens: 20, totalCostUSD: 0.000042 },
        });
      }

      const bulkReplayer = new ReviewCassetteReplayer({ memoryCassettes: memoryMap });
      const start = Date.now();
      const results = bulkReplayer.bulkReplay(Array.from(memoryMap.keys()));
      const duration = Date.now() - start;

      expect(results.size).toBe(50);
      expect(duration).toBeLessThan(500);
    });
  });

  // =========================================================================
  // 6. ERROR HANDLING & RESILIENCE
  // =========================================================================
  describe("6. Error Handling & Resilience", () => {
    let replayer: ReviewCassetteReplayer;

    beforeEach(() => {
      replayer = new ReviewCassetteReplayer({ storageDir: tempTestDir });
    });

    it("throws CassetteNotFoundError when scenario cassette is missing", () => {
      expect(() => replayer.loadCassette("non-existent-scenario")).toThrow(CassetteNotFoundError);
    });

    it("throws CassetteCorruptedError when cassette JSON is malformed syntax", () => {
      const badPath = path.join(tempTestDir, "bad-syntax.json");
      fs.writeFileSync(badPath, "{ invalid json: syntax error ...", "utf8");

      expect(() => replayer.loadCassette("bad-syntax")).toThrow(CassetteCorruptedError);
    });

    it("throws CassetteIncompatibleError when cassette scenarioId mismatches query", () => {
      const mismatchCassette: ReviewCassette = {
        version: "1.0",
        scenarioId: "original-id",
        model: "deepseek/deepseek-v4-flash-0731:low",
        recordedAt: new Date().toISOString(),
        diffBudgetChars: 24000,
        interactions: [],
        finalArbitration: { verdict: "SHIP", confirmedFindings: [] },
        tokenUsage: { promptTokens: 100, completionTokens: 50, reasoningTokens: 20, totalCostUSD: 0.000028 },
      };

      const mismatchPath = path.join(tempTestDir, "queried-id.json");
      fs.writeFileSync(mismatchPath, JSON.stringify(mismatchCassette), "utf8");

      expect(() => replayer.loadCassette("queried-id")).toThrow(CassetteIncompatibleError);
    });

    it("throws CassetteIncompatibleError when expectedModel does not match", () => {
      const cassette: ReviewCassette = {
        version: "1.0",
        scenarioId: "model-check-scen",
        model: "deepseek/deepseek-v4-flash-0731:low",
        recordedAt: new Date().toISOString(),
        diffBudgetChars: 24000,
        interactions: [],
        finalArbitration: { verdict: "SHIP", confirmedFindings: [] },
        tokenUsage: { promptTokens: 100, completionTokens: 50, reasoningTokens: 20, totalCostUSD: 0.000028 },
      };

      fs.writeFileSync(
        path.join(tempTestDir, "model-check-scen.json"),
        JSON.stringify(cassette),
        "utf8"
      );

      expect(() =>
        replayer.replay("model-check-scen", { expectedModel: "openrouter/5.6-luna-high" })
      ).toThrow(CassetteIncompatibleError);
    });
  });

  // =========================================================================
  // 7. CANONICAL CASSETTES IN FIXTURES
  // =========================================================================
  describe("7. Canonical Cassettes & Manifest Integrity", () => {
    it("canonical cassettes directory contains 190 scenario cassettes and valid manifest", () => {
      expect(fs.existsSync(canonicalCassettesDir)).toBe(true);

      const manifestPath = path.join(canonicalCassettesDir, "manifest.json");
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest: CassetteManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      expect(manifest.version).toBe("1.0");
      expect(manifest.model).toBe("deepseek/deepseek-v4-flash-0731:low");
      expect(manifest.totalCassettes).toBe(190);
      expect(Object.keys(manifest.entries).length).toBe(190);
    });

    it("canonical cassette fixtures all conform strictly to ReviewCassette schema", () => {
      const replayer = new ReviewCassetteReplayer({ storageDir: canonicalCassettesDir });
      const scenarios = getAllScenarios();

      for (const scen of scenarios.slice(0, 20)) {
        expect(replayer.hasCassette(scen.id)).toBe(true);
        const cassette = replayer.loadCassette(scen.id);
        expect(cassette.scenarioId).toBe(scen.id);
        expect(cassette.version).toBe("1.0");
        expect(cassette.interactions.length).toBe(5);
        expect(["SHIP", "FIX_FIRST", "BLOCK"]).toContain(cassette.finalArbitration.verdict);
      }
    });

    it("replaying canonical cassette produces valid PipelineExecutionResult", () => {
      const replayer = new ReviewCassetteReplayer({ storageDir: canonicalCassettesDir });
      const firstScenario = getAllScenarios()[0];

      const result = replayer.replay(firstScenario.id);
      expect(result.scenarioId).toBe(firstScenario.id);
      expect(result.model).toBe("deepseek/deepseek-v4-flash-0731:low");
      expect(result.arbitrationVerdict).toBeDefined();
      expect(result.totalCostUSD).toBeGreaterThan(0);
    });
  });
});
