import { CtReviewConfigV3, ProviderId } from '../config/schema';
import { ReviewModelClient, TokensUsed } from '../gateway/openRouterClient';
import { PanelRequestPolicy } from './panelEngine';
import { logger } from '../utils/logger';
import { getMetrics } from '../telemetry';

export interface ClassifierResult {
  fastShip: boolean;
  selectedPersonas: string[];
  effortTier: 'low' | 'medium' | 'high';
  rationale: string;
  usage?: TokensUsed | null;
  costUSD?: number | null;
  durationMs?: number;
  model?: string;
  providerId?: string;
}

export interface ClassifyScopeOptions {
  config: CtReviewConfigV3;
  changedFiles: Array<{ path: string; patch?: string; content?: string }>;
  candidatePersonas: Array<{ id: string; charter: string; required?: boolean; paths: string[] }>;
  repository: string;
  headSha: string;
  client: ReviewModelClient;
  jobId?: string;
  requestPolicy?: PanelRequestPolicy;
}

const EXECUTABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.go', '.rs', '.py', '.rb', '.php',
  '.ex', '.exs',
  '.java', '.kt', '.scala',
  '.c', '.cpp', '.h', '.hpp', '.cs',
  '.sh', '.bash', '.zsh',
  '.sql',
  '.vue', '.svelte',
]);

/**
 * Defense-in-depth safety guard:
 * Verifies if changes contain executable application code or critical infrastructure/security paths.
 * Fast-ship MUST NOT be granted to PRs touching these files, regardless of classifier response.
 */
export function containsExecutableOrSensitiveCode(files: Array<{ path: string }>): boolean {
  for (const file of files) {
    const p = (file.path || '').toLowerCase();
    if (
      p.includes('.github/workflows') ||
      p.includes('/auth') ||
      p.includes('/security') ||
      p.includes('/secret') ||
      p.includes('migration') ||
      p.endsWith('dockerfile') ||
      p.includes('docker-compose')
    ) {
      return true;
    }
    const dotIdx = p.lastIndexOf('.');
    const ext = dotIdx >= 0 ? p.slice(dotIdx) : '';
    if (EXECUTABLE_EXTENSIONS.has(ext)) {
      return true;
    }
  }
  return false;
}

function extractJson(text: string): any {
  const cleaned = text.trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  if (cleaned.includes('```')) {
    const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match && match[1]) {
      try {
        return JSON.parse(match[1].trim());
      } catch (_) {}
    }
  }

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    } catch (_) {}
  }

  return null;
}

const CLASSIFIER_SYSTEM_PROMPT = `You are the Review Yeti Pre-Flight Triage Classifier.
Your task is to analyze the PR changed files and candidate review personas to determine:
1. "fastShip": (boolean) Whether the PR is safe to immediately approve without running full multi-persona evaluation.
   - Set fastShip to true ONLY IF:
     * The PR only touches documentation (e.g. *.md, *.txt, docs/*)
     * OR only touches non-executable configuration or assets (e.g. .gitignore, images, icons, license)
     * OR is a trivial dependency lockfile hash bump or comment typo with zero functional or architectural risk.
   - Set fastShip to false IF:
     * The PR modifies executable code, business logic, components, or scripts.
     * The PR touches security, auth, database schemas, or CI/CD workflows.
2. "selectedPersonas": (string[]) Array of persona IDs from candidate personas that are genuinely relevant to review this PR diff.
   - For example, exclude database personas if no database files changed; exclude UI personas if only backend changed.
   - If fastShip is true, this can be empty [].
3. "effortTier": 'low' | 'medium' | 'high' based on change complexity.
4. "rationale": (string) A concise 1-2 sentence explanation.

You MUST respond strictly with a JSON object in this format:
{
  "fastShip": boolean,
  "selectedPersonas": string[],
  "effortTier": "low" | "medium" | "high",
  "rationale": "string"
}`;

/**
 * Execute a fast triage classifier LLM call before spawning the full review panel.
 * Fails open (returns null) on any network error, timeout, or malformed response.
 */
export async function classifyReviewScope(options: ClassifyScopeOptions): Promise<ClassifierResult | null> {
  // Bypass classifier in qualification runs to preserve strict qualification contract
  if (
    options.requestPolicy?.metadata?.qualificationMode ||
    process.env.REVIEW_QUALIFICATION_RUN === '1'
  ) {
    return null;
  }

  const providerSpec = options.config.reviewers.providers.find((p) => p.enabled);
  if (!providerSpec) {
    return null;
  }

  const model = providerSpec.model;
  const timeoutMs = Math.min(providerSpec.review_timeout_s * 1000, 15_000);
  const startTime = Date.now();

  // Build compact file list and excerpt
  const fileLines: string[] = [];
  let charCount = 0;
  const MAX_DIFF_CHARS = 3500;

  for (const f of options.changedFiles) {
    let entry = `- ${f.path}`;
    if (f.patch && charCount < MAX_DIFF_CHARS) {
      const excerpt = f.patch.slice(0, Math.min(f.patch.length, 300));
      entry += `\n  Hunk:\n  ${excerpt.replace(/\n/g, '\n  ')}`;
      charCount += excerpt.length;
    }
    fileLines.push(entry);
  }

  const personaLines = options.candidatePersonas.map(
    (p) => `- ${p.id} (${p.required ? 'required' : 'optional'}): ${p.charter.slice(0, 120)}`
  );

  const userPrompt = [
    `=== PR TRIAGE CLASSIFICATION ===`,
    `Repository: ${options.repository} (Commit: ${options.headSha})`,
    ``,
    `=== CHANGED FILES (${options.changedFiles.length} files) ===`,
    fileLines.join('\n'),
    ``,
    `=== CANDIDATE REVIEW PERSONAS (${options.candidatePersonas.length}) ===`,
    personaLines.join('\n'),
    ``,
    `Evaluate if fastShip applies, select relevant personas, and return JSON.`,
  ].join('\n');

  try {
    const response = await options.client.complete({
      model,
      messages: [
        { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      timeoutMs,
      jobId: options.jobId,
      persona: 'classifier',
      providerId: providerSpec.id,
      stream: false,
      temperature: 0.1,
      responseFormat: { type: 'json_object' },
      ...(options.requestPolicy?.provider ? { provider: options.requestPolicy.provider } : {}),
      ...(options.requestPolicy?.metadata ? { metadata: options.requestPolicy.metadata } : {}),
    });

    const parsed = extractJson(response.content);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const fastShipRaw = Boolean(parsed.fastShip);
    const selectedPersonas = Array.isArray(parsed.selectedPersonas)
      ? parsed.selectedPersonas.map((s: any) => String(s).trim()).filter(Boolean)
      : [];
    const effortTier: 'low' | 'medium' | 'high' = ['low', 'medium', 'high'].includes(parsed.effortTier)
      ? parsed.effortTier
      : 'medium';
    const rationale = typeof parsed.rationale === 'string' && parsed.rationale.trim()
      ? parsed.rationale.trim()
      : 'Triage classification completed.';

    // Code guardrail: never fast-ship executable or sensitive changes
    let effectiveFastShip = fastShipRaw;
    if (effectiveFastShip && containsExecutableOrSensitiveCode(options.changedFiles)) {
      logger.info('Classifier suggested fastShip, but PR contains executable or sensitive code; forcing full panel review', {
        repository: options.repository,
        headSha: options.headSha,
      });
      effectiveFastShip = false;
    }

    const durationMs = Date.now() - startTime;

    try {
      const metrics = getMetrics();
      const p = response.usage?.prompt || 0;
      const c = response.usage?.completion || 0;
      const t = response.usage?.total || (p + c);
      const cost = response.costUSD || 0;
      if (p) metrics.tokensPrompt.add(p, { persona: 'classifier', provider: providerSpec.id, model });
      if (c) metrics.tokensCompletion.add(c, { persona: 'classifier', provider: providerSpec.id, model });
      if (t) metrics.tokensTotal.add(t, { persona: 'classifier', provider: providerSpec.id, model });
      if (cost) metrics.modelCostUsd.add(cost, { persona: 'classifier', provider: providerSpec.id, model });
    } catch (_) {}

    return {
      fastShip: effectiveFastShip,
      selectedPersonas,
      effortTier,
      rationale,
      usage: response.usage || null,
      costUSD: response.costUSD || null,
      durationMs,
      model,
      providerId: providerSpec.id,
    };
  } catch (err: any) {
    logger.warn('Pre-flight classifier failed; failing open to full review panel', {
      repository: options.repository,
      headSha: options.headSha,
      error: err?.message,
    });
    return null;
  }
}
