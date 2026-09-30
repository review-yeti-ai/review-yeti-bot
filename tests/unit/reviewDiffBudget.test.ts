import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));
const { assessReviewAssignmentBudget } = require(path.join(rootRepoDir, '.github/workflows/pipelines/incremental-review-scope.js'));

const {
  planDiffBudget,
  formatPRComment,
  computeArbitrationQuorum,
  writeStepOutputs,
  calculateTransportDiffCapacity,
  calculateLaneDiffBudget,
  calculateSafeDiffCapacity,
  DIRECT_REASONING_SAFE_PROMPT_TOKENS,
  reviewWithModel,
  PERSONA_CHARTERS,
  DEFAULT_PERSONA_IDS,
  resolveSafeDiffCapacity,
  GUARDED_GATEWAY_MAX_DIFF_CHARS,
  shaPartitionManager,
} = pipeline;

const securityPersona = PERSONA_CHARTERS.find((p: any) => p.id === 'security');

const file = (p: string, size: number) => ({
  path: p,
  patch: 'x'.repeat(size),
  addedLines: [],
  deletedLines: [],
});

describe('planDiffBudget', () => {
  it('reviews everything when the diff fits', () => {
    const plan = planDiffBudget([file('a.ts', 100), file('b.ts', 100)], 10_000);
    expect(plan.reviewed).toEqual(['a.ts', 'b.ts']);
    expect(plan.truncated).toEqual([]);
    expect(plan.omitted).toEqual([]);
  });

  it('truncates an oversized file rather than dropping it, so it still gets reviewed', () => {
    const plan = planDiffBudget([file('huge.ts', 50_000)], 10_000);
    expect(plan.reviewed).toEqual(['huge.ts']);
    expect(plan.truncated).toEqual(['huge.ts']);
    expect(plan.omitted).toEqual([]);
  });

  it('does not let one large file starve the files after it', () => {
    const plan = planDiffBudget([file('huge.ts', 100_000), file('small.ts', 200)], 10_000);
    expect(plan.reviewed).toContain('small.ts');
  });

  it('records overflow files by name instead of dropping them silently', () => {
    const many = Array.from({ length: 200 }, (_, i) => file(`f${i}.ts`, 5_000));
    const plan = planDiffBudget(many, 10_000);
    expect(plan.omitted.length).toBeGreaterThan(0);
    expect(plan.reviewed.length + plan.omitted.length).toBe(200);
    expect(plan.omitted[0]).toMatch(/^f\d+\.ts$/);
  });

  it('keeps the rendered prompt near the budget', () => {
    const many = Array.from({ length: 50 }, (_, i) => file(`f${i}.ts`, 5_000));
    const plan = planDiffBudget(many, 10_000);
    // Allow headroom for per-file headers and truncation notices.
    expect(plan.text.length).toBeLessThan(10_000 * 2);
  });

  it('tells the model what it was not shown', () => {
    const many = Array.from({ length: 200 }, (_, i) => file(`f${i}.ts`, 5_000));
    const plan = planDiffBudget(many, 10_000);
    expect(plan.text).toMatch(/not shown|omitted|truncated/i);
  });

  it('handles an empty diff without throwing', () => {
    const plan = planDiffBudget([], 10_000);
    expect(plan.reviewed).toEqual([]);
    expect(plan.omitted).toEqual([]);
  });
});

describe('Incomplete coverage is disclosed to the human, not just the model', () => {
  const results = [{
    personaId: 'security',
    displayName: '🛡️ Security',
    model: 'm',
    decision: 'APPROVE',
    findings: [],
  }];
  const ctx = { repo: 'o/r', prNumber: '1', headSha: 'abc1234' };

  it('states in the comment when files were not reviewed', () => {
    const coverage = { reviewed: ['a.ts'], truncated: [], omitted: ['b.ts', 'c.ts'] };
    const c = formatPRComment(computeArbitrationQuorum(results, 1), results, ctx, {}, {}, coverage);
    expect(c).toMatch(/not reviewed|omitted/i);
    expect(c).toContain('b.ts');
    expect(c).toContain('c.ts');
  });

  it('states when a reviewed file was only partially shown', () => {
    const coverage = { reviewed: ['a.ts'], truncated: ['a.ts'], omitted: [] };
    const c = formatPRComment(computeArbitrationQuorum(results, 1), results, ctx, {}, {}, coverage);
    expect(c).toMatch(/truncated|partial/i);
  });

  it('says nothing about coverage when the whole diff was reviewed', () => {
    const coverage = { reviewed: ['a.ts'], truncated: [], omitted: [] };
    const c = formatPRComment(computeArbitrationQuorum(results, 1), results, ctx, {}, {}, coverage);
    expect(c).not.toMatch(/not reviewed/i);
  });

  it('does not claim a clean verdict is complete when files were skipped', () => {
    const coverage = { reviewed: ['a.ts'], truncated: [], omitted: ['b.ts'] };
    const c = formatPRComment(computeArbitrationQuorum(results, 1), results, ctx, {}, {}, coverage);
    // The reader must be able to see the verdict covers only part of the change.
    expect(c).toMatch(/⚠️|incomplete|partial|not reviewed/i);
  });
});

// REL-556: a direct-reasoning transport (Ollama/Fireworks) can exhaust its whole output
// ceiling on reasoning alone before emitting a content token, once the prompt is large enough
// -- regardless of reasoning_effort. calculateTransportDiffCapacity / calculateLaneDiffBudget
// give the lane a hard input-side ceiling so that never happens.
describe('calculateTransportDiffCapacity', () => {
  it('does not constrain a context-bound transport (OpenRouter)', () => {
    const cap = calculateTransportDiffCapacity(
      { name: 'openrouter-deepseek', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' },
      'https://openrouter.ai/api/v1',
    );
    expect(cap).toBe(Infinity);
  });

  it('bounds a direct-reasoning transport (Ollama) well under its evidence-observed failure point', () => {
    const cap = calculateTransportDiffCapacity(
      { name: 'ollama', model: 'deepseek-v4-flash:cloud' },
      'https://ollama.com/v1',
    );
    // Evidence (REL-556): 729,269 chars (~212k prompt tokens) exhausted the model's 65,536-token
    // ceiling on reasoning alone; 65k prompt tokens left enough headroom. The cap must sit
    // comfortably below the observed failure size.
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(300_000);
  });

  it('recognizes Fireworks as reasoning-ceiling-bound the same way as Ollama', () => {
    const cap = calculateTransportDiffCapacity(
      { name: 'fireworks', model: 'accounts/fireworks/models/deepseek-v4-flash-0731' },
      'https://api.fireworks.ai/inference/v1',
    );
    expect(cap).toBeGreaterThan(0);
    expect(Number.isFinite(cap)).toBe(true);
  });

  it('honors a transport-declared override for a route with its own measured ceiling', () => {
    const narrow = calculateTransportDiffCapacity(
      { name: 'ollama', model: 'deepseek-v4-flash:cloud', reasoningSafePromptTokens: 10_000 },
      'https://ollama.com/v1',
    );
    const wide = calculateTransportDiffCapacity(
      { name: 'ollama', model: 'deepseek-v4-flash:cloud', reasoningSafePromptTokens: 90_000 },
      'https://ollama.com/v1',
    );
    expect(narrow).toBeLessThan(wide);
  });
});

describe('calculateLaneDiffBudget', () => {
  const openRouterTransport = { name: 'openrouter-deepseek', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' };
  const ollamaTransport = { name: 'ollama', model: 'deepseek-v4-flash:cloud' };

  it('keeps the requested budget when no candidate transport is reasoning-ceiling-bound', () => {
    const budget = calculateLaneDiffBudget([openRouterTransport], 400_000);
    expect(budget).toBe(400_000);
  });

  it('tightens the budget to the safest transport in the fallback chain', () => {
    const budget = calculateLaneDiffBudget([openRouterTransport, ollamaTransport], 400_000);
    const ollamaCap = calculateTransportDiffCapacity(ollamaTransport, '');
    expect(budget).toBe(ollamaCap);
    expect(budget).toBeLessThan(400_000);
  });

  it('falls back to the requested budget when no transports are known', () => {
    expect(calculateLaneDiffBudget(null, 400_000)).toBe(400_000);
    expect(calculateLaneDiffBudget([], 400_000)).toBe(400_000);
  });

  it('never returns a non-positive budget even if the requested budget is tiny', () => {
    const budget = calculateLaneDiffBudget([ollamaTransport], 1);
    expect(budget).toBeGreaterThanOrEqual(1);
  });
});

describe('guarded gateway input budgeting', () => {
  it('caps only the explicitly guarded pr-reviewer gateway alias and preserves tighter configured budgets', () => {
    expect(GUARDED_GATEWAY_MAX_DIFF_CHARS).toBe(64_000);
    expect(resolveSafeDiffCapacity({
      guardedGatewayDestination: true,
      model: 'pr-reviewer',
      maxDiffChars: 410_400,
    })).toBe(64_000);
    expect(resolveSafeDiffCapacity({
      guardedGatewayDestination: true,
      model: 'pr-reviewer',
      maxDiffChars: 32_000,
    })).toBe(32_000);

    const guardedRuntime = pipeline.resolveModelConfig({
      OPENROUTER_API_KEY: 'test-only',
      OPENROUTER_BASE_URL: 'https://llm-gateway.example.ts.net/v1',
      OPENROUTER_MODEL: 'neuralwatt/glm-5.3-flash',
      REVIEW_TRANSPORT_DESTINATION: 'gateway',
    });
    expect(guardedRuntime.guardedGatewayDestination).toBe(true);
    expect(guardedRuntime.model).toBe('pr-reviewer');
    expect(resolveSafeDiffCapacity(guardedRuntime)).toBe(64_000);
  });

  it('leaves an unguarded destination or a different gateway model at its configured budget', () => {
    expect(resolveSafeDiffCapacity({
      guardedGatewayDestination: false,
      model: 'pr-reviewer',
      maxDiffChars: 410_400,
    })).toBe(410_400);
    expect(resolveSafeDiffCapacity({
      guardedGatewayDestination: true,
      model: 'z-ai/glm-5.3-flash',
      maxDiffChars: 410_400,
    })).toBe(410_400);

    const directOpenRouter = pipeline.resolveModelConfig({
      OPENROUTER_API_KEY: 'test-only',
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENROUTER_MODEL: 'z-ai/glm-5.3-flash',
    });
    expect(resolveSafeDiffCapacity(directOpenRouter)).toBe(410_400);
    const unclassifiedGateway = pipeline.resolveModelConfig({
      OPENROUTER_API_KEY: 'test-only',
      OPENROUTER_BASE_URL: 'https://llm-gateway.example.ts.net/v1',
      OPENROUTER_MODEL: 'neuralwatt/glm-5.3-flash',
    });
    expect(unclassifiedGateway.guardedGatewayDestination).toBe(false);
    expect(unclassifiedGateway.model).toBe('neuralwatt/glm-5.3-flash');
    expect(resolveSafeDiffCapacity(unclassifiedGateway)).toBe(410_400);
  });

  it('partitions a current-sized full diff into admitted, lossless persona assignments', async () => {
    const gatewayDiffBudget = resolveSafeDiffCapacity({
      guardedGatewayDestination: true,
      model: 'pr-reviewer',
      maxDiffChars: 410_400,
    });
    const largePath = 'src/oversized-module.ts';
    const largeFileHeader = `diff --git a/${largePath} b/${largePath}\nindex 0000000..1111111 100644\n--- a/${largePath}\n+++ b/${largePath}\n`;
    const firstHunkPrefix = '@@ -1,0 +1,1 @@\n+';
    const secondHunkPrefix = '@@ -2,0 +2,1 @@\n+';
    const largeFileChars = 70_000;
    const payloadChars = largeFileChars
      - largeFileHeader.length
      - firstHunkPrefix.length
      - secondHunkPrefix.length
      - 1;
    const firstPayloadChars = Math.floor(payloadChars / 2);
    const secondPayloadChars = payloadChars - firstPayloadChars;
    const firstHunk = `${firstHunkPrefix}${'a'.repeat(firstPayloadChars)}`;
    const secondHunk = `${secondHunkPrefix}${'b'.repeat(secondPayloadChars)}`;
    const oversizedPatch = `${largeFileHeader}${firstHunk}\n${secondHunk}`;
    expect(oversizedPatch).toHaveLength(largeFileChars);

    const otherFiles = Array.from({ length: 32 }, (_, index) => {
      const filePath = `src/module-${String(index).padStart(2, '0')}.ts`;
      const size = index === 31 ? 4_650 : 4_637;
      const prefix = `diff --git a/${filePath} b/${filePath}\n@@ -1,1 +1,1 @@\n+`;
      return {
        path: filePath,
        patch: `${prefix}${'x'.repeat(size - prefix.length)}`,
        status: 'modified',
      };
    });
    const inputFiles = [
      { path: largePath, patch: oversizedPatch, status: 'modified' },
      ...otherFiles,
    ];
    const totalInputChars = inputFiles.reduce((sum, item) => sum + item.patch.length, 0);
    expect(totalInputChars).toBe(218_397);

    const plan = shaPartitionManager.createPartitionPlan(
      inputFiles,
      '0123456789abcdef0123456789abcdef01234567',
      'fedcba9876543210fedcba9876543210fedcba98',
      gatewayDiffBudget,
    );

    expect(plan.partitions).toHaveLength(4);
    expect(plan.coveragePercent).toBe(100);
    expect(plan.omittedFilesCount).toBe(0);
    expect(plan.totalOriginalChars).toBe(totalInputChars);
    expect(plan.fileManifest).toHaveLength(inputFiles.length);
    expect(plan.partitions.every((partition: any) => partition.totalChars <= gatewayDiffBudget)).toBe(true);

    const partitionFiles = plan.partitions.flatMap((partition: any) => partition.files);
    for (const originalFile of otherFiles) {
      const reviewedCopies = partitionFiles.filter((part: any) => part.path === originalFile.path);
      expect(reviewedCopies).toHaveLength(1);
      expect(reviewedCopies[0].patch).toBe(originalFile.patch);
    }
    const oversizedChunks = partitionFiles.filter((part: any) => part.path === largePath);
    expect(oversizedChunks).toHaveLength(2);
    expect(oversizedChunks.every((part: any) => part.patch.length <= gatewayDiffBudget)).toBe(true);
    expect(oversizedChunks.filter((part: any) => part.patch.includes(firstHunk))).toHaveLength(1);
    expect(oversizedChunks.filter((part: any) => part.patch.includes(secondHunk))).toHaveLength(1);

    const assignmentBudget = assessReviewAssignmentBudget(
      plan.partitions.length,
      DEFAULT_PERSONA_IDS.length,
      24,
    );
    expect(DEFAULT_PERSONA_IDS).toHaveLength(5);
    expect(assignmentBudget).toEqual({ planned: 20, maximum: 24, admitted: true });

    const requests: Array<{ personaId: string; url: string; body: any }> = [];
    const fetchImplementationFor = (personaId: string) => async (input: string | URL | Request, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body));
      requests.push({ personaId, url: input instanceof Request ? input.url : String(input), body });
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const partitionResults = await Promise.all(plan.partitions.flatMap((partition: any) =>
      DEFAULT_PERSONA_IDS.map(async (personaId: string) => {
        const persona = PERSONA_CHARTERS.find((candidate: any) => candidate.id === personaId);
        const result = await reviewWithModel(
          persona,
          partition.files,
          { repo: 'example/review-fixture', prNumber: '1', baseSha: plan.baseSha, headSha: plan.headSha },
          null,
          {
            model: 'pr-reviewer',
            maxDiffChars: gatewayDiffBudget,
            guardedGatewayDestination: true,
            partition,
            partitionPlan: plan,
            fetchImplementation: fetchImplementationFor(personaId),
            circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
            transports: [{
              name: 'openrouter',
              baseUrl: 'https://gateway.example.invalid/v1',
              apiKey: 'test-only',
              model: 'pr-reviewer',
              provider: 'openrouter',
              maxTokens: 24_576,
              stream: false,
            }],
          },
        );
        return { personaId, partitionIndex: partition.partitionIndex, result };
      }),
    ));

    expect(partitionResults).toHaveLength(20);
    expect(requests).toHaveLength(20);
    expect(partitionResults.every(({ result }) => result.decision === 'APPROVE')).toBe(true);
    expect(partitionResults.every(({ result }) => result.coverage.truncated.length === 0 && result.coverage.omitted.length === 0)).toBe(true);
    expect(requests.every(({ url, body }) =>
      url === 'https://gateway.example.invalid/v1/chat/completions'
      && body.model === 'pr-reviewer'
      && body.max_tokens === 24_576
    )).toBe(true);

    for (const personaId of DEFAULT_PERSONA_IDS) {
      const personaRuns = partitionResults.filter((run) => run.personaId === personaId);
      expect(personaRuns.map((run) => run.partitionIndex).sort()).toEqual([0, 1, 2, 3]);
      const reviewedPaths = new Set(personaRuns.flatMap((run) => run.result.coverage.reviewed));
      expect([...reviewedPaths].sort()).toEqual(inputFiles.map((item) => item.path).sort());
      const personaPrompt = requests
        .filter((request) => request.personaId === personaId)
        .map((request) => request.body.messages[1].content)
        .join('\n');
      for (const originalFile of otherFiles) expect(personaPrompt).toContain(originalFile.patch);
      expect(personaPrompt).toContain(firstHunk);
      expect(personaPrompt).toContain(secondHunk);
    }
  });
});

describe('REL-556: an oversized diff never reaches a direct-reasoning transport intact', () => {
  // Mirrors the evidence PR: cisco-cdr #4861, 727,269 chars across 126 files. Build an
  // equivalent-scale synthetic diff and confirm the applied budget for a lane whose fallback
  // chain includes Ollama is far under both the diff total and the OpenRouter-only budget for
  // the same lane, and that priority ordering (files earlier in the caller-supplied order win
  // review slots first -- see PR #419's tail-ordering of generated/lock/vendor/test files) is
  // preserved under the tighter cap.
  const totalChars = 700_000;
  const fileCount = 300;
  const perFileChars = Math.floor(totalChars / fileCount);
  const diffFiles = Array.from({ length: fileCount }, (_, i) => file(`src/file_${String(i).padStart(3, '0')}.ex`, perFileChars));

  it('sizes the synthetic fixture at the evidence scale', () => {
    const actualTotal = diffFiles.reduce((sum, f) => sum + f.patch.length, 0);
    expect(actualTotal).toBeGreaterThan(680_000);
    expect(actualTotal).toBeLessThan(720_000);
  });

  it('applies a materially tighter budget than an OpenRouter-only lane would get', () => {
    const openRouterOnlyBudget = calculateLaneDiffBudget(
      [{ name: 'openrouter-deepseek', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' }],
      calculateSafeDiffCapacity('deepseek/deepseek-v4-flash-0731'),
    );
    const ollamaFallbackBudget = calculateLaneDiffBudget(
      [
        { name: 'openrouter-deepseek', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' },
        { name: 'ollama', model: 'deepseek-v4-flash:cloud' },
      ],
      calculateSafeDiffCapacity('deepseek/deepseek-v4-flash-0731'),
    );
    expect(ollamaFallbackBudget).toBeLessThan(openRouterOnlyBudget);
    // The applied budget must leave the diff still oversized relative to the cap (this is a
    // 700k-char fixture on purpose), proving the cap actually bites rather than being a no-op.
    expect(ollamaFallbackBudget).toBeLessThan(totalChars);
  });

  it('keeps the existing priority ordering and honest disclosure under the tighter cap', () => {
    const ollamaFallbackBudget = calculateLaneDiffBudget(
      [{ name: 'ollama', model: 'deepseek-v4-flash:cloud' }],
      calculateSafeDiffCapacity('deepseek/deepseek-v4-flash-0731'),
    );
    const plan = planDiffBudget(diffFiles, ollamaFallbackBudget);

    // Not every file fits under the tightened budget -- some are correctly omitted, not
    // silently dropped.
    expect(plan.omitted.length).toBeGreaterThan(0);
    expect(plan.reviewed.length + plan.omitted.length).toBe(fileCount);

    // Ordering: the files reviewed are exactly a prefix of the caller-supplied order (the
    // priority ordering PR #419 established at the call site is untouched by this change --
    // planDiffBudget still walks the list in the order it was given).
    const reviewedPrefix = diffFiles.slice(0, plan.reviewed.length).map((f) => f.path);
    expect(plan.reviewed).toEqual(reviewedPrefix);

    // Honest disclosure: the model is told what it was not shown.
    expect(plan.text).toMatch(/not shown|omitted|truncated/i);
    expect(plan.text).toContain(plan.omitted[0]);
  });

  it('leaves an OpenRouter-only lane able to see materially more of the same diff', () => {
    const openRouterOnlyBudget = calculateLaneDiffBudget(
      [{ name: 'openrouter-deepseek', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' }],
      calculateSafeDiffCapacity('deepseek/deepseek-v4-flash-0731'),
    );
    const ollamaFallbackBudget = calculateLaneDiffBudget(
      [{ name: 'ollama', model: 'deepseek-v4-flash:cloud' }],
      calculateSafeDiffCapacity('deepseek/deepseek-v4-flash-0731'),
    );
    const openRouterPlan = planDiffBudget(diffFiles, openRouterOnlyBudget);
    const ollamaPlan = planDiffBudget(diffFiles, ollamaFallbackBudget);
    expect(openRouterPlan.reviewed.length).toBeGreaterThan(ollamaPlan.reviewed.length);
  });
});

describe('REL-556: reviewWithModel applies the tightened budget end to end', () => {
  const totalChars = 700_000;
  const fileCount = 300;
  const perFileChars = Math.floor(totalChars / fileCount);
  const bigDiffFiles = Array.from({ length: fileCount }, (_, i) => file(`src/file_${String(i).padStart(3, '0')}.ex`, perFileChars));

  function stubFetch(content: string) {
    const calls: any[] = [];
    const impl = async (url: string, init: any) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      };
    };
    return { impl, calls };
  }

  it('sends the direct-reasoning transport a diff that fits its safe capacity, not the full 700k-char diff', async () => {
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));
    const result = await reviewWithModel(securityPersona, bigDiffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      fetchImplementation: impl,
      transports: [{ name: 'ollama', baseUrl: 'https://ollama.com/v1', apiKey: 'k', model: 'deepseek-v4-flash:cloud' }],
    });

    expect(calls).toHaveLength(1);
    const userMessage = calls[0].body.messages.find((m: any) => m.role === 'user').content as string;
    // The full diff (700k chars across the patches alone) must not be on the wire -- only the
    // budgeted subset planDiffBudget selected.
    expect(userMessage.length).toBeLessThan(totalChars);
    expect(userMessage).toMatch(/not shown|omitted|truncated/i);

    // The applied per-lane budget and the omission count are reported in the lane's telemetry.
    expect(result.diffBudgetChars).toBeGreaterThan(0);
    expect(result.diffBudgetChars).toBeLessThan(totalChars);
    expect(result.diffOmittedFilesCount).toBeGreaterThan(0);
  });

  it('lets an OpenRouter-only lane see materially more of the same 700k-char diff', async () => {
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));
    const result = await reviewWithModel(securityPersona, bigDiffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      fetchImplementation: impl,
      transports: [{ name: 'openrouter-deepseek', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', model: 'deepseek/deepseek-v4-flash-0731', provider: 'openrouter' }],
    });

    const userMessage = calls[0].body.messages.find((m: any) => m.role === 'user').content as string;
    expect(result.diffOmittedFilesCount ?? 0).toBeLessThan(fileCount);
    expect(userMessage.length).toBeGreaterThan(0);
  });
});

describe('Coverage is exposed as step outputs so a workflow can gate on it', () => {
  it('emits reviewed and omitted counts', () => {
    const out = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'ct-cov-')), 'o.txt');
    writeStepOutputs(
      { verdict: 'SHIP', completedPersonas: 1, totalPersonas: 1, metrics: {} },
      out,
      { reviewed: ['a.ts', 'b.ts'], truncated: ['a.ts'], omitted: ['c.ts'] },
    );
    const content = fs.readFileSync(out, 'utf-8');
    expect(content).toContain('files-reviewed=2');
    expect(content).toContain('files-omitted=1');
  });
});
