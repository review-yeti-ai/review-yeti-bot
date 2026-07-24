"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveWebhookSecret = resolveWebhookSecret;
exports.createWebhookRouter = createWebhookRouter;
exports.createWebhookServer = createWebhookServer;
const express_1 = __importStar(require("express"));
const logger_1 = require("../utils/logger");
const signature_1 = require("./signature");
/**
 * Resolves the active GitHub Webhook Secret from options or environment variables.
 */
function resolveWebhookSecret(overrideSecret) {
    if (overrideSecret && overrideSecret.trim() !== '') {
        return overrideSecret;
    }
    if (process.env.WEBHOOK_SECRET && process.env.WEBHOOK_SECRET.trim() !== '') {
        return process.env.WEBHOOK_SECRET;
    }
    if (process.env.GITHUB_WEBHOOK_SECRET && process.env.GITHUB_WEBHOOK_SECRET.trim() !== '') {
        return process.env.GITHUB_WEBHOOK_SECRET;
    }
    return 'development-webhook-secret-key-12345';
}
/**
 * Creates an Express Router configured for GitHub Webhook handling.
 */
function createWebhookRouter(options = {}) {
    const router = (0, express_1.Router)();
    const webhookSecret = resolveWebhookSecret(options.secret);
    const primaryPath = options.path || '/webhook';
    // Middleware 1: Parse JSON and retain raw body buffer
    router.use(express_1.default.json({
        verify: (req, _res, buf) => {
            req.rawBody = buf;
        },
    }));
    // Middleware 2: Security & JSON Body Parsing Error Handler
    router.use((err, req, res, next) => {
        if (err && (err instanceof SyntaxError || err.type === 'entity.parse.failed' || err.status === 400)) {
            const sigHeader = req.headers['x-hub-signature-256'];
            if (sigHeader && req.rawBody) {
                const verification = (0, signature_1.verifyGitHubSignatureDetailed)({
                    signatureHeader: sigHeader,
                    rawBody: req.rawBody,
                    secret: webhookSecret,
                });
                if (!verification.isValid) {
                    logger_1.logger.warn('Webhook request with malformed JSON failed signature authentication', { reason: verification.reason });
                    return res.status(401).json({ error: 'Invalid or missing signature' });
                }
            }
            logger_1.logger.warn('Webhook server received malformed JSON payload', { error: err.message });
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Invalid JSON body or malformed payload',
            });
        }
        next(err);
    });
    // Core Webhook Route Handler
    const webhookHandler = async (req, res, next) => {
        try {
            const sigHeader = req.headers['x-hub-signature-256'];
            // 1. Signature Authentication (HTTP 401)
            const verification = (0, signature_1.verifyGitHubSignatureDetailed)({
                signatureHeader: sigHeader,
                rawBody: req.rawBody,
                secret: webhookSecret,
            });
            if (!verification.isValid) {
                logger_1.logger.warn('Webhook request signature authentication failed', {
                    reason: verification.reason,
                    error: verification.error,
                });
                return res.status(401).json({ error: 'Invalid or missing signature' });
            }
            // 2. Event Extraction
            const event = req.headers['x-github-event'] || 'ping';
            if (event === 'ping') {
                return res.status(200).json({ status: 'pong' });
            }
            // 3. Delegate to event handler if provided
            if (options.onEvent) {
                const handlerResult = await options.onEvent(req);
                if (handlerResult !== undefined) {
                    if (typeof handlerResult === 'object' && handlerResult !== null) {
                        return res.status(200).json(handlerResult);
                    }
                    return res.status(200).send(handlerResult);
                }
            }
            return res.status(200).json({ status: 'received', event });
        }
        catch (err) {
            logger_1.logger.error('Unhandled exception during webhook processing', { error: err?.message || err });
            if (!res.headersSent) {
                return res.status(500).json({
                    error: 'Internal Server Error',
                    message: err?.message || 'Webhook processing failed',
                });
            }
            next(err);
        }
    };
    // Mount at primary path and standard API alias path
    router.post(primaryPath, webhookHandler);
    if (primaryPath !== '/api/webhook/github') {
        router.post('/api/webhook/github', webhookHandler);
    }
    return router;
}
/**
 * Creates a standalone Express application for GitHub Webhook handling.
 */
function createWebhookServer(options = {}) {
    const app = (0, express_1.default)();
    const router = createWebhookRouter(options);
    app.use('/', router);
    return app;
}
//# sourceMappingURL=webhookServer.js.map