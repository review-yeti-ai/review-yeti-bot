/**
 * SIP Signaling Service Module Entrypoint
 * RFC 3261, RFC 3515, RFC 3891, RFC 4566 Standard Implementation
 */

export * from './src/types/sipMessages';
export * from './src/types/dialogTypes';
export * from './src/sipStateMachine';
export * from './src/dialogManager';
export * from './src/sdpNegotiator';
export * from './src/callTransferCoordinator';
export * from './src/callRouter';
export * from './src/sipServer';

// Compatibility aliases
export { SipStateMachine as SipTransactionManager } from './src/sipStateMachine';
export { CallTransferCoordinator as TransferController } from './src/callTransferCoordinator';
