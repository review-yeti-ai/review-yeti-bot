import type { LaneTokenUsage } from './types';
import type { WorkerFailureClass } from '../types/workerFailure';

export class PanelConfigurationError extends Error {
  /** Bounded, numeric-only telemetry from the lane's last provider response before it failed
   * closed, when one was received. Never the free-form message this error already carries. */
  readonly lastKnownUsage?: LaneTokenUsage;
  readonly lastKnownModel?: string;
  /**
   * Coded classification of why the lane failed, assigned once by the code path that observed
   * the terminal error (see `classifyPersonaAttemptFailure` and its call sites in `runPersona`).
   * This is the type-enforced home for a lane's failure reason (REL-892 finding 2): a caller
   * that only receives this error instance can read `.failureClass` directly instead of
   * re-deriving it from `.message` later. Optional because not every `PanelConfigurationError`
   * represents a persona lane failure -- panel-level setup errors (invalid roster, quorum
   * failure, arbiter failure) do not set it and fall back to `classifyFailure` at the publishing
   * layer.
   *
   * Deliberately NOT included here: `rawCompletionExcerpt`. That field carries actual completion
   * text (may contain provider prompt/response content) and must stay off this class's public
   * contract so it can never reach `optionalFailures` or a published check by construction. It is
   * bolted on as a narrow, explicitly-cast side channel only where it is set and read -- see the
   * comments at both of those sites.
   */
  readonly failureClass?: WorkerFailureClass;
  readonly failureReason?: string;

  constructor(message: string, lane?: { lastKnownUsage?: LaneTokenUsage; lastKnownModel?: string; failureClass?: WorkerFailureClass; failureReason?: string }) {
    super(message);
    this.name = 'PanelConfigurationError';
    this.lastKnownUsage = lane?.lastKnownUsage;
    this.lastKnownModel = lane?.lastKnownModel;
    this.failureClass = lane?.failureClass;
    this.failureReason = lane?.failureReason;
  }
}

/** The provider exhausted the in-conversation correction without a valid result object. */
/**
 * A provider exhausted the in-conversation correction without a valid result object.
 *
 * Extends `PanelConfigurationError` (rather than `Error` directly) so that when a real provider
 * response *was* received before the parse failure (see `invoke()`'s fence-parse catch), that
 * response's bounded, numeric-only telemetry can be carried on this error through the same
 * constructor-only, type-checked `lastKnownUsage`/`lastKnownModel` fields -- never bolted on
 * after construction via an `as {...}` cast. A caller that only receives this error instance
 * (e.g. `runPersona`'s catch, which never sees a returned `result` on this path) can still read
 * `.lastKnownUsage` / `.lastKnownModel` with compiler-checked confidence that they are the two
 * fields this class declares, not whatever shape happened to be cast onto it.
 */
export class PanelStructuredOutputError extends PanelConfigurationError {
  constructor(message: string, lane?: { lastKnownUsage?: LaneTokenUsage; lastKnownModel?: string }) {
    super(message, lane);
    this.name = 'PanelStructuredOutputError';
  }
}

/** A caller or worker stopped the panel before it produced a binding result. */
export class PanelCancellationError extends PanelConfigurationError {
  constructor(message = 'review panel was cancelled') {
    super(message);
    this.name = 'PanelCancellationError';
  }
}

/**
 * REL-1124: a lane, a required-lane panel, or the arbiter failed closed on the path to the model
 * (transport, gateway 5xx, rate limit, provider timeout), not on anything the model said. A
 * subclass so every `instanceof PanelConfigurationError` fail-closed check is unchanged; its own
 * name so logs and triage stop reporting a gateway outage as a configuration error.
 */
export class PanelInfrastructureError extends PanelConfigurationError {
  constructor(message: string, lane?: { lastKnownUsage?: LaneTokenUsage; lastKnownModel?: string; failureClass?: WorkerFailureClass; failureReason?: string }) {
    super(message, lane);
    this.name = 'PanelInfrastructureError';
  }
}

/** The configured panel deadline elapsed; this is distinct from a provider request timeout. */
export class PanelDeadlineExceededError extends PanelCancellationError {
  readonly failureClass = 'timeout' as const;
  readonly failureReason: string;
  constructor(timeoutMs: number, terminalBound = false) {
    super(terminalBound ? 'review panel exceeded admitted terminal model-work deadline'
      : `review panel exceeded overall timeout of ${Math.ceil(timeoutMs / 1000)}s`);
    this.name = 'PanelDeadlineExceededError';
    this.failureReason = terminalBound ? 'worker_terminal_deadline_exceeded' : 'worker_deadline_exceeded';
  }
}

