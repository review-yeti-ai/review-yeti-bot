/**
 * PBX Device Manager Module Entrypoint
 * RFC 3261, RFC 2617, RFC 3581 Standard Implementation
 */

export * from './src/models/sipEndpoint';
export * from './src/models/trunkGroup';
export * from './src/deviceRegistry';
export * from './src/digestAuth';
export * from './src/trunkAllocator';
export * from './src/ctiWebhookDispatcher';

// Compatibility aliases
export { DigestAuthenticator as DigestAuth } from './src/digestAuth';
export { CtiWebhookDispatcher as WebhookDispatcher } from './src/ctiWebhookDispatcher';
