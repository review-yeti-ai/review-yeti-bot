import { describe, expect, it } from 'vitest';
import {
  classifyPersonaAttemptFailure,
  PanelFindingsValidationError,
  PanelStructuredOutputError,
} from '../../src/panel/panelEngine';
import { OpenRouterConnectionError, OpenRouterResponseError, OpenRouterTimeoutError } from '../../src/gateway/openRouterClient';
import { UpstreamCapacityRejectionError } from '../../src/gateway/providerCapacityManager';
import { classifyWorkerFailureMessage } from '../../src/review/workerCompletion';

/**
 * REL-892 finding 2 follow-up: `classifyPersonaAttemptFailure`'s ~10 branches were untested when
 * the coded `failureClass` was introduced. This exercises every branch -- the panel-specific typed
 * checks it evaluates itself, and the message/status-pattern remainder it now delegates to the
 * single shared `classifyWorkerFailureMessage` (../../src/review/workerCompletion), which
 * `classifyFailure` (../../src/cli/publishingReview, see publishingReview.test.ts) also delegates
 * to so both layers share exactly one regex ladder.
 */
describe('classifyPersonaAttemptFailure', () => {
  it.each([
    ['OpenRouterTimeoutError', new OpenRouterTimeoutError('deadline exceeded'), 'timeout'],
    ['UpstreamCapacityRejectionError', new UpstreamCapacityRejectionError('bifrost', 'queue full'), 'rate_limit'],
    ['OpenRouterConnectionError', new OpenRouterConnectionError('socket closed'), 'transport'],
    ['OpenRouterResponseError 401', new OpenRouterResponseError('unauthorized', 401), 'auth'],
    ['OpenRouterResponseError 403', new OpenRouterResponseError('forbidden', 403), 'auth'],
    ['OpenRouterResponseError 429', new OpenRouterResponseError('busy', 429), 'rate_limit'],
    ['OpenRouterResponseError other status', new OpenRouterResponseError('upstream failed', 503), 'provider_error'],
    ['PanelStructuredOutputError', new PanelStructuredOutputError('exhausted structured-output correction'), 'malformed_output'],
    ['PanelFindingsValidationError', new PanelFindingsValidationError('malformed findings payload'), 'malformed_output'],
  ] as const)('classifies %s as %s via its typed check', (_label, error, expected) => {
    expect(classifyPersonaAttemptFailure(error)).toBe(expected);
  });

  // The message/status-pattern remainder: none of these are instances of a typed error the panel
  // checks directly, so they fall through to the shared `classifyWorkerFailureMessage`.
  it.each([
    ['turn budget exhausted', 'budget_exhausted'],
    ['persona sec-lane exceeded total retry/execution budget of 900s', 'budget_exhausted'],
    ['request timed out', 'timeout'],
    ['virtual key not found', 'auth'],
    ['401 unauthorized', 'auth'],
    ['429 rate limit exceeded', 'rate_limit'],
    ['ENOTFOUND api.example.invalid', 'transport'],
    ['fetch failed', 'transport'],
    ['invalid findings contract at index 0', 'malformed_output'],
    ['nonce-fenced structured output rejected', 'malformed_output'],
    ['gateway returned an unexpected payload', 'provider_error'],
    ['unexpected invariant violation', 'internal_error'],
  ])('classifies %s as %s via the shared message fallback', (message, expected) => {
    expect(classifyPersonaAttemptFailure(new Error(message))).toBe(expected);
  });

  it('falls back to internal_error for a message matching no pattern and no typed check', () => {
    expect(classifyPersonaAttemptFailure(new Error('a completely novel failure shape'))).toBe('internal_error');
  });

  it('agrees with the shared classifier for every error neither layer has a typed check for', () => {
    // Consolidation proof (REL-892 finding 1): for any error that is not one of the panel's own
    // typed pre-checks, classifyPersonaAttemptFailure's result must be identical to calling the
    // shared classifier directly -- there is no second, independently-maintained regex ladder in
    // the panel that could silently drift from the one the publisher also uses.
    const messages = [
      'turn budget exhausted', 'request timed out', 'virtual key not found', '429 rate limit',
      'ENOTFOUND host', 'invalid findings contract', 'gateway returned an unexpected payload',
      'unexpected invariant violation',
    ];
    for (const message of messages) {
      const error = new Error(message);
      expect(classifyPersonaAttemptFailure(error)).toBe(classifyWorkerFailureMessage(error));
    }
  });
});
