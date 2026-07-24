import { Express, Router, Request } from 'express';
export interface RequestWithRawBody extends Request {
    rawBody?: Buffer;
}
export interface WebhookServerOptions {
    /** Optional secret override */
    secret?: string;
    /** Primary webhook route path (defaults to '/webhook') */
    path?: string;
    /** Pluggable event handler callback function */
    onEvent?: (req: RequestWithRawBody) => Promise<any>;
}
/**
 * Resolves the active GitHub Webhook Secret from options or environment variables.
 */
export declare function resolveWebhookSecret(overrideSecret?: string): string;
/**
 * Creates an Express Router configured for GitHub Webhook handling.
 */
export declare function createWebhookRouter(options?: WebhookServerOptions): Router;
/**
 * Creates a standalone Express application for GitHub Webhook handling.
 */
export declare function createWebhookServer(options?: WebhookServerOptions): Express;
