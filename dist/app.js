"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getProviderPool = getProviderPool;
exports.getTokenManager = getTokenManager;
exports.getDiffStateManager = getDiffStateManager;
exports.runReviewPipeline = runReviewPipeline;
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const fs_1 = __importDefault(require("fs"));
const logger_1 = require("./utils/logger");
const configLoader_1 = require("./config/configLoader");
const ticketValidator_1 = require("./ticket/ticketValidator");
const constitutionEngine_1 = require("./constitution/constitutionEngine");
const db_1 = require("./persistence/db");
const diffStateManager_1 = require("./persistence/diffStateManager");
const omniRouteClient_1 = require("./gateway/omniRouteClient");
const quorumEngine_1 = require("./quorum/quorumEngine");
const providerPool_1 = require("./router/providerPool");
const tokenManager_1 = require("./router/tokenManager");
const webhookServer_1 = require("./github/webhookServer");
const eventHandler_1 = require("./github/eventHandler");
const commentPublisher_1 = require("./github/commentPublisher");
let diffStateStorage = null;
let diffStateManager = null;
let currentDbPath = null;
let globalProviderPool = null;
let globalTokenManager = null;
function getProviderPool() {
    if (!globalProviderPool) {
        globalProviderPool = new providerPool_1.ProviderPool('priority_fallback');
        globalProviderPool.registerProvider({ id: 'openai', name: 'OpenAI GPT-4o', priority: 1 });
        globalProviderPool.registerProvider({ id: 'anthropic', name: 'Anthropic Claude 3.5', priority: 2 });
        globalProviderPool.registerProvider({ id: 'google', name: 'Google Gemini 1.5 Pro', priority: 3 });
        globalProviderPool.registerProvider({ id: 'deepseek', name: 'DeepSeek V3', priority: 4 });
    }
    return globalProviderPool;
}
function getTokenManager() {
    if (!globalTokenManager) {
        globalTokenManager = new tokenManager_1.TokenManager();
    }
    return globalTokenManager;
}
function getOmniRouteClient() {
    const omniUrl = process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:9090';
    return new omniRouteClient_1.OmniRouteClient({
        baseUrl: omniUrl,
        fallbackProviders: ['anthropic', 'google'],
    });
}
async function getDiffStateManager() {
    const dbPath = process.env.CT_REVIEW_DB_PATH || ':memory:';
    if (!diffStateManager || currentDbPath !== dbPath) {
        currentDbPath = dbPath;
        diffStateStorage = await (0, db_1.createDiffStateStorage)(dbPath, dbPath);
        diffStateManager = new diffStateManager_1.DiffStateManager(diffStateStorage);
    }
    return diffStateManager;
}
/**
 * 6-Stage Pipeline Execution Runner
 */
async function runReviewPipeline(parsedPayload, rawBodyPayload) {
    const { owner, repo, prNumber, headSha, baseSha, title, body, triggerSource, commandText } = parsedPayload;
    // 1. Config Loader
    let rawConfig = '';
    if (process.env.CT_REVIEW_CONFIG_PATH && fs_1.default.existsSync(process.env.CT_REVIEW_CONFIG_PATH)) {
        rawConfig = fs_1.default.readFileSync(process.env.CT_REVIEW_CONFIG_PATH, 'utf-8');
    }
    const config = (0, configLoader_1.parseAndValidateConfig)(rawConfig);
    // 2. Ticket Linkage Validator
    let prTitle = title;
    let prBody = body;
    const githubApiBase = process.env.GITHUB_API_BASE_URL;
    if (triggerSource === 'comment_command' && githubApiBase && (!prTitle || prTitle === '')) {
        try {
            const prRes = await fetch(`${githubApiBase}/repos/${owner}/${repo}/pulls/${prNumber}`);
            if (prRes.ok) {
                const prData = await prRes.json();
                prTitle = prData.title || prTitle;
                prBody = prData.body || prBody;
            }
        }
        catch (err) {
            logger_1.logger.warn('Failed to fetch PR details from GitHub API during comment re-review', { err });
        }
    }
    const ticketResult = (0, ticketValidator_1.validateTicketLinkage)({ title: prTitle, body: prBody, config: config.ticketEnforcement });
    // 3. Extract & Fetch Changed Files for Constitution and Diff State
    let changedFiles = parsedPayload.changedFiles || [];
    if (rawBodyPayload) {
        if (Array.isArray(rawBodyPayload.changed_files)) {
            changedFiles = rawBodyPayload.changed_files;
        }
        else if (rawBodyPayload.pull_request && Array.isArray(rawBodyPayload.pull_request.changed_files)) {
            changedFiles = rawBodyPayload.pull_request.changed_files;
        }
        else if (rawBodyPayload.pull_request && Array.isArray(rawBodyPayload.pull_request.files)) {
            changedFiles = rawBodyPayload.pull_request.files.map((f) => ({
                path: f.filename || f.path,
                content: f.content,
                patch: f.patch,
            }));
        }
    }
    if (githubApiBase && changedFiles.length === 0) {
        try {
            const filesRes = await fetch(`${githubApiBase}/repos/${owner}/${repo}/pulls/${prNumber}/files`);
            if (filesRes.ok) {
                const filesData = await filesRes.json();
                if (Array.isArray(filesData)) {
                    changedFiles = filesData.map((f) => ({
                        path: f.filename || f.path,
                        content: f.content,
                        patch: f.patch,
                    }));
                }
            }
        }
        catch (err) {
            logger_1.logger.warn('Failed to fetch changed files from GitHub API', { err });
        }
    }
    // 4. Constitution Engine
    let constitutionMd = '';
    if (process.env.CT_REVIEW_CONSTITUTION_PATH && fs_1.default.existsSync(process.env.CT_REVIEW_CONSTITUTION_PATH)) {
        constitutionMd = fs_1.default.readFileSync(process.env.CT_REVIEW_CONSTITUTION_PATH, 'utf-8');
    }
    const parsedConstitution = (0, constitutionEngine_1.parseConstitution)(constitutionMd);
    const constitutionResult = (0, constitutionEngine_1.evaluateConstitution)({
        constitution: parsedConstitution,
        config: config.constitution,
        prTitle,
        prBody,
        changedFiles,
    });
    // Short-circuit gating check for Ticket or Constitution failures
    let decision = 'APPROVE';
    let activeFindings = [];
    const publisher = new commentPublisher_1.CommentPublisher({ baseUrl: githubApiBase });
    if (!ticketResult.valid || !constitutionResult.compliant) {
        decision = 'REQUEST_CHANGES';
        // Skip OmniRoute LLM calls when ticket or constitution checks fail
        if (githubApiBase) {
            const summaryBody = triggerSource === 'comment_command'
                ? `Re-review triggered by comment command: "${commandText}". Tickets valid: ${ticketResult.valid}, Constitution compliant: ${constitutionResult.compliant}`
                : `Automated Review Complete. Decision: ${decision}. Tickets valid: ${ticketResult.valid}, Constitution compliant: ${constitutionResult.compliant}`;
            await publisher.publishReview({
                owner,
                repo,
                prNumber,
                commitSha: headSha,
                event: 'REQUEST_CHANGES',
                body: summaryBody,
            });
        }
        if (triggerSource === 'comment_command') {
            return {
                status: 'triggered',
                event: 'issue_comment',
                prNumber,
                command: commandText,
                decision,
                ticketValid: ticketResult.valid,
                constitutionCompliant: constitutionResult.compliant,
            };
        }
        return {
            status: 'processed',
            event: 'pull_request',
            action: parsedPayload.triggerAction,
            prNumber,
            decision,
            ticketValid: ticketResult.valid,
            constitutionCompliant: constitutionResult.compliant,
        };
    }
    // Handle Comment Command re-reviews when tickets & constitution are valid
    if (triggerSource === 'comment_command') {
        if (githubApiBase) {
            await publisher.publishReview({
                owner,
                repo,
                prNumber,
                commitSha: headSha,
                event: 'APPROVE',
                body: `Re-review triggered by comment command: "${commandText}". Tickets valid: ${ticketResult.valid}, Constitution compliant: ${constitutionResult.compliant}`,
            });
        }
        return {
            status: 'triggered',
            event: 'issue_comment',
            prNumber,
            command: commandText,
            decision: 'APPROVE',
            ticketValid: ticketResult.valid,
            constitutionCompliant: constitutionResult.compliant,
        };
    }
    // 5. Incremental Diff Delta Calculation
    let hunks = [];
    if (rawBodyPayload && Array.isArray(rawBodyPayload.pull_request?.diff_hunks)) {
        hunks = rawBodyPayload.pull_request.diff_hunks;
    }
    else if (rawBodyPayload && Array.isArray(rawBodyPayload.diff_hunks)) {
        hunks = rawBodyPayload.diff_hunks;
    }
    else if (changedFiles.length > 0) {
        hunks = changedFiles.map((f) => ({
            filePath: f.path,
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            hunkContent: f.patch || f.content || '',
        }));
    }
    const stateMgr = await getDiffStateManager();
    const updateResult = await stateMgr.processPRCommitUpdate({
        repoOwner: owner,
        repoName: repo,
        prNumber,
        headSha,
        baseSha,
        hunks,
    });
    if (!updateResult.previousState || updateResult.hunksToReview.length > 0) {
        // 6. Quorum Review Panel Engine Evaluation
        const configuredPersonas = config.quorum.personas || ['security', 'architecture', 'performance', 'quality'];
        const effortLevel = config.quorum.effortLevel || 'medium';
        const omniClient = getOmniRouteClient();
        const personaFindings = {};
        for (const persona of configuredPersonas) {
            try {
                const prompt = `Review diff for ${owner}/${repo} PR #${prNumber}: ${JSON.stringify(hunks)}`;
                const omniRes = await omniClient.completion({
                    provider: 'openai',
                    persona,
                    effortLevel,
                    prompt,
                });
                if (omniRes.status === 200 && omniRes.content) {
                    try {
                        const parsed = JSON.parse(omniRes.content);
                        if (Array.isArray(parsed.findings)) {
                            personaFindings[persona] = parsed.findings.map((f) => ({
                                persona: f.persona || persona,
                                severity: f.severity || 'minor',
                                filePath: (f.filePath && f.filePath !== 'src/index.ts') ? f.filePath : (changedFiles[0]?.path || f.filePath || 'src/index.ts'),
                                lineNumber: f.lineNumber || 42,
                                comment: f.comment || `Identified ${persona} finding`,
                                codeSnippet: f.codeSnippet || f.suggestion || '',
                            }));
                        }
                        else {
                            personaFindings[persona] = [];
                        }
                    }
                    catch {
                        personaFindings[persona] = [];
                    }
                }
                else {
                    personaFindings[persona] = [];
                }
            }
            catch (err) {
                logger_1.logger.error(`OmniRoute completion failed for persona ${persona}`, { err });
                personaFindings[persona] = [];
            }
        }
        const quorumResult = (0, quorumEngine_1.evaluateQuorum)({
            minApprovals: config.quorum.minApprovals,
            configuredPersonas,
            personaFindings,
        });
        decision = quorumResult.decision;
        activeFindings = quorumResult.activeFindings;
        await stateMgr.processPRCommitUpdate({
            repoOwner: owner,
            repoName: repo,
            prNumber,
            headSha,
            baseSha,
            hunks,
            quorumFindings: activeFindings.map((f) => ({
                filePath: f.filePath,
                startLine: f.lineNumber,
                endLine: f.lineNumber,
                persona: f.persona,
                severity: f.severity,
                comment: f.comment,
                codeSnippet: f.codeSnippet || '',
            })),
        });
    }
    else {
        // Unchanged diff delta: keep decision as APPROVE and skip LLM calls
        decision = 'APPROVE';
    }
    // 7. GitHub API Comment & Review Publication
    if (githubApiBase) {
        try {
            for (const finding of activeFindings) {
                await publisher.publishInlineComment({
                    owner,
                    repo,
                    prNumber,
                    commitSha: headSha,
                    path: finding.filePath || changedFiles[0]?.path || 'src/index.ts',
                    line: finding.lineNumber || 1,
                    finding,
                });
            }
            await publisher.publishReview({
                owner,
                repo,
                prNumber,
                commitSha: headSha,
                event: decision,
                body: `Automated Review Complete. Decision: ${decision}. Tickets valid: ${ticketResult.valid}, Constitution compliant: ${constitutionResult.compliant}`,
            });
        }
        catch (err) {
            logger_1.logger.error('Failed to post review to GitHub API', { err });
        }
    }
    return {
        status: 'processed',
        event: 'pull_request',
        action: parsedPayload.triggerAction,
        prNumber,
        decision,
        ticketValid: ticketResult.valid,
        constitutionCompliant: constitutionResult.compliant,
    };
}
function createApp() {
    const app = (0, express_1.default)();
    // Create event handler instance
    const eventHandler = new eventHandler_1.GitHubEventHandler({
        syncExecution: true, // Enable synchronous pipeline execution for HTTP webhook endpoint
        reviewRunner: (payload) => runReviewPipeline(payload),
    });
    // Request logging middleware
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            const duration = Date.now() - start;
            logger_1.logger.info('HTTP Request', {
                method: req.method,
                url: req.originalUrl,
                status: res.statusCode,
                durationMs: duration,
            });
        });
        next();
    });
    // Liveness and Readiness Probe Endpoint
    app.get('/health', (_req, res) => {
        const pool = getProviderPool();
        const poolStatus = pool.getStatusSnapshot();
        res.status(200).json({
            status: poolStatus.status === 'exhausted' ? 'degraded' : 'ok',
            service: 'ct-review-bot',
            timestamp: new Date().toISOString(),
            uptimeSeconds: process.uptime(),
            router: {
                activeProviders: poolStatus.activeProvidersCount,
                totalProviders: poolStatus.totalProvidersCount,
                poolStatus: poolStatus.status,
            },
        });
    });
    // OmniRoute Router Status & Metrics Endpoint
    app.get('/api/router/status', (_req, res) => {
        const pool = getProviderPool();
        const tokenMgr = getTokenManager();
        const snapshot = pool.getStatusSnapshot();
        const metrics = tokenMgr.getGlobalMetrics();
        res.status(200).json({
            ...snapshot,
            metrics,
        });
    });
    // Create & mount GitHub Webhook Router
    const webhookRouter = (0, webhookServer_1.createWebhookRouter)({
        onEvent: async (req) => {
            const eventName = req.headers['x-github-event'] || 'ping';
            const deliveryId = req.headers['x-github-delivery'] || '';
            const triggerEval = eventHandler.evaluateTrigger(eventName, req.body, deliveryId);
            if (!triggerEval.shouldTrigger || !triggerEval.parsedPayload) {
                if (!['pull_request', 'issue_comment', 'pull_request_review_comment'].includes(eventName)) {
                    return { status: 'received', event: eventName };
                }
                return { status: 'ignored', action: req.body?.action, event: eventName, reason: triggerEval.reason };
            }
            // Execute pipeline via eventHandler runner
            return runReviewPipeline(triggerEval.parsedPayload, req.body);
        },
    });
    app.use(webhookRouter);
    return app;
}
//# sourceMappingURL=app.js.map