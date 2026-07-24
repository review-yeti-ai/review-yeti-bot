import { Persona, EffortLevel, CtReviewConfig } from '../config/schema';
import { OmniRouteAdapter } from '../router/omniRouteAdapter';
import { logger } from '../utils/logger';
import {
  QuorumReviewContext,
  PersonaFinding,
  getPersonaRunner,
  PRDiffFile,
} from './personas';

export { QuorumReviewContext, PersonaFinding, PRDiffFile };

export interface mefEngineOptions {
  config: CtReviewConfig;
  router: OmniRouteAdapter;
  personaEffortOverrides?: Partial<Record<Persona, EffortLevel>>;
  timeoutMsPerPersona?: number; // Default: 30000ms
}

export interface PersonaExecutionResult {
  persona: Persona;
  success: boolean;
  findings: PersonaFinding[];
  rawResponse?: string;
  tokensUsed?: { prompt: number; completion: number; total: number };
  providerUsed?: string;
  modelUsed?: string;
  executionTimeMs: number;
  error?: string;
}

export interface mefEngineResult {
  personaResults: Record<string, PersonaExecutionResult>;
  allFindings: PersonaFinding[];
  stats: {
    totalPersonasConfigured: number;
    personasExecuted: Persona[];
    personasFailed: Persona[];
    totalTokensUsed: number;
    totalExecutionTimeMs: number;
  };
}

export async function executeQuorumFanOut(
  context: QuorumReviewContext,
  options: mefEngineOptions
): Promise<mefEngineResult> {
  const startTime = Date.now();
  const configuredPersonas: Persona[] =
    options.config.quorum.personas || ['security', 'architecture', 'performance', 'quality'];
  const globalEffort: EffortLevel = options.config.quorum.effortLevel || 'medium';
  const timeoutMs = options.timeoutMsPerPersona || 30000;

  const personaTasks = configuredPersonas.map(async (persona): Promise<PersonaExecutionResult> => {
    const pStartTime = Date.now();
    const effortLevel: EffortLevel =
      options.personaEffortOverrides?.[persona] || globalEffort;

    const runner = getPersonaRunner(persona);
    const systemPrompt = runner.getSystemPrompt();
    const userPrompt = runner.buildUserPrompt(context);

    // Timeout promise for per-persona isolation
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        reject(new Error(`Persona ${persona} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    // LLM execution via OmniRouteAdapter
    const llmPromise = options.router.complete({
      persona,
      effortLevel,
      prompt: userPrompt,
      systemPrompt,
    });

    try {
      const llmRes = await Promise.race([llmPromise, timeoutPromise]);
      if (timerId) clearTimeout(timerId);

      const rawContent = llmRes.content || '';
      const findings = runner.parseResponse(rawContent, context);

      logger.info(`Persona review complete for ${persona}`, {
        persona,
        findingsCount: findings.length,
        providerUsed: llmRes.providerUsed,
        modelUsed: llmRes.modelUsed,
      });

      return {
        persona,
        success: true,
        findings,
        rawResponse: rawContent,
        tokensUsed: llmRes.tokensUsed,
        providerUsed: llmRes.providerUsed,
        modelUsed: llmRes.modelUsed,
        executionTimeMs: Date.now() - pStartTime,
      };
    } catch (err: any) {
      if (timerId) clearTimeout(timerId);
      const errMsg = err?.message || String(err);
      logger.error(`Persona review failed for ${persona}: ${errMsg}`, { persona, err });

      return {
        persona,
        success: false,
        findings: [],
        executionTimeMs: Date.now() - pStartTime,
        error: errMsg,
      };
    }
  });

  const results = await Promise.allSettled(personaTasks);

  const personaResults: Record<string, PersonaExecutionResult> = {};
  const allFindings: PersonaFinding[] = [];
  const personasExecuted: Persona[] = [];
  const personasFailed: Persona[] = [];
  let totalTokensUsed = 0;

  results.forEach((res, idx) => {
    const persona = configuredPersonas[idx];
    if (res.status === 'fulfilled') {
      const pRes = res.value;
      personaResults[persona] = pRes;
      if (pRes.success) {
        personasExecuted.push(persona);
        allFindings.push(...pRes.findings);
        if (pRes.tokensUsed) {
          totalTokensUsed += pRes.tokensUsed.total || 0;
        }
      } else {
        personasFailed.push(persona);
      }
    } else {
      personasFailed.push(persona);
      const errorMsg = res.reason?.message || String(res.reason);
      personaResults[persona] = {
        persona,
        success: false,
        findings: [],
        executionTimeMs: Date.now() - startTime,
        error: errorMsg,
      };
    }
  });

  const totalExecutionTimeMs = Date.now() - startTime;

  return {
    personaResults,
    allFindings,
    stats: {
      totalPersonasConfigured: configuredPersonas.length,
      personasExecuted,
      personasFailed,
      totalTokensUsed,
      totalExecutionTimeMs,
    },
  };
}
