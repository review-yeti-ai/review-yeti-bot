import { Express } from 'express';
import { DiffStateManager } from './persistence/diffStateManager';
import { ProviderPool } from './router/providerPool';
import { TokenManager } from './router/tokenManager';
import { RequestWithRawBody } from './github/webhookServer';
import { ParsedPRPayload } from './github/eventHandler';
export { RequestWithRawBody };
export declare function getProviderPool(): ProviderPool;
export declare function getTokenManager(): TokenManager;
export declare function getDiffStateManager(): Promise<DiffStateManager>;
/**
 * 6-Stage Pipeline Execution Runner
 */
export declare function runReviewPipeline(parsedPayload: ParsedPRPayload, rawBodyPayload?: any): Promise<any>;
export declare function createApp(): Express;
