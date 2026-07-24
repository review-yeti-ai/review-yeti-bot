"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeQuorumFanOut = executeQuorumFanOut;
const logger_1 = require("../utils/logger");
const personas_1 = require("./personas");
async function executeQuorumFanOut(context, options) {
    const startTime = Date.now();
    const configuredPersonas = options.config.quorum.personas || ['security', 'architecture', 'performance', 'quality'];
    const globalEffort = options.config.quorum.effortLevel || 'medium';
    const timeoutMs = options.timeoutMsPerPersona || 30000;
    const personaTasks = configuredPersonas.map(async (persona) => {
        const pStartTime = Date.now();
        const effortLevel = options.personaEffortOverrides?.[persona] || globalEffort;
        const runner = (0, personas_1.getPersonaRunner)(persona);
        const systemPrompt = runner.getSystemPrompt();
        const userPrompt = runner.buildUserPrompt(context);
        // Timeout promise for per-persona isolation
        let timerId;
        const timeoutPromise = new Promise((_, reject) => {
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
            if (timerId)
                clearTimeout(timerId);
            const rawContent = llmRes.content || '';
            const findings = runner.parseResponse(rawContent, context);
            logger_1.logger.info(`Persona review complete for ${persona}`, {
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
        }
        catch (err) {
            if (timerId)
                clearTimeout(timerId);
            const errMsg = err?.message || String(err);
            logger_1.logger.error(`Persona review failed for ${persona}: ${errMsg}`, { persona, err });
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
    const personaResults = {};
    const allFindings = [];
    const personasExecuted = [];
    const personasFailed = [];
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
            }
            else {
                personasFailed.push(persona);
            }
        }
        else {
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
//# sourceMappingURL=mefEngine.js.map