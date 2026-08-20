/**
 * Canonical CDR Stream Ingestion, Validation & Normalization Service
 */

import crypto from 'node:crypto';
import {
  CallDisposition,
  MediaQualityMetrics,
  NormalizedCdr,
  Q850Cause,
  Q850_CAUSES,
  RawCallEvent,
} from './models/callDetailRecord';
import { CdrRatingError } from '../../src/common/errors';

export class CdrValidationError extends Error {
  constructor(message: string, public readonly field: string, public readonly value: unknown) {
    super(`[CdrValidationError] ${field}: ${message}`);
    this.name = 'CdrValidationError';
  }
}

export class DuplicateCdrError extends Error {
  constructor(public readonly callId: string) {
    super(`[DuplicateCdrError] Call-ID already ingested: ${callId}`);
    this.name = 'DuplicateCdrError';
  }
}

export interface CdrIngestionOptions {
  maxClockSkewMs?: number;      // Default: 300,000ms (5 mins)
  minE164Length?: number;       // Default: 7 digits
  maxE164Length?: number;       // Default: 15 digits (ITU-T E.164)
}

export class CdrIngestionService {
  private readonly processedCallIds: Set<string> = new Set();
  private readonly options: Required<CdrIngestionOptions>;

  constructor(options: CdrIngestionOptions = {}) {
    this.options = {
      maxClockSkewMs: options.maxClockSkewMs ?? 300000,
      minE164Length: options.minE164Length ?? 7,
      maxE164Length: options.maxE164Length ?? 15,
    };
  }

  /**
   * Validates and normalizes raw signaling/media events into canonical CDR.
   */
  public ingestRawEvent(event: RawCallEvent): NormalizedCdr {
    if (!event.tenantId) {
      throw new CdrValidationError('Missing tenantId', 'tenantId', event.tenantId);
    }
    if (!event.callId) {
      throw new CdrValidationError('Missing callId', 'callId', event.callId);
    }

    if (this.processedCallIds.has(event.callId)) {
      throw new DuplicateCdrError(event.callId);
    }

    this.validateTimestamps(event.startTimeMs, event.answerTimeMs, event.endTimeMs);

    const callerNormalized = this.normalizeE164(event.caller);
    const calleeNormalized = this.normalizeE164(event.callee);

    const disposition = this.deriveDisposition(event.sipResponseCode, event.answerTimeMs, event.q850ReasonCode);
    const q850Reason = this.resolveQ850Cause(event.q850ReasonCode, event.sipResponseCode, disposition);

    const totalDurationMs = Math.max(0, event.endTimeMs - event.startTimeMs);
    const setupDurationMs = Math.max(
      0,
      (event.ringingTimeMs ?? event.answerTimeMs ?? event.endTimeMs) - event.startTimeMs
    );

    const billableDurationSec = event.answerTimeMs && event.answerTimeMs <= event.endTimeMs
      ? Math.ceil((event.endTimeMs - event.answerTimeMs) / 1000)
      : 0;

    const defaultMediaMetrics: MediaQualityMetrics = {
      callerJitterMs: 0,
      calleeJitterMs: 0,
      callerPacketLossPct: 0,
      calleePacketLossPct: 0,
      callerMosEstimate: 4.4,
      calleeMosEstimate: 4.4,
      audioCodec: 'PCMU',
      ingressBytes: 0,
      egressBytes: 0,
      ...event.mediaMetrics,
    };

    const normalized: NormalizedCdr = {
      id: crypto.randomUUID(),
      tenantId: event.tenantId,
      callId: event.callId,
      direction: event.direction,
      caller: callerNormalized,
      callee: calleeNormalized,
      ingressTrunkId: event.ingressTrunkId ?? null,
      egressTrunkId: event.egressTrunkId ?? null,
      disposition,
      sipResponseCode: event.sipResponseCode,
      q850Reason,
      startIso: new Date(event.startTimeMs).toISOString(),
      answerIso: event.answerTimeMs ? new Date(event.answerTimeMs).toISOString() : null,
      endIso: new Date(event.endTimeMs).toISOString(),
      totalDurationMs,
      setupDurationMs,
      billableDurationSec,
      mediaMetrics: defaultMediaMetrics,
      createdAtIso: new Date().toISOString(),
    };

    this.processedCallIds.add(event.callId);
    return normalized;
  }

  public deriveDisposition(
    sipCode: number,
    answerTimeMs?: number,
    q850Code?: number
  ): CallDisposition {
    if (answerTimeMs !== undefined && answerTimeMs !== null) {
      return 'ANSWERED';
    }
    if (sipCode === 200) {
      return 'ANSWERED';
    }
    if (sipCode === 486 || q850Code === 17) {
      return 'BUSY';
    }
    if (sipCode === 408 || sipCode === 480 || q850Code === 19) {
      return 'NO_ANSWER';
    }
    if (sipCode === 487 || q850Code === 16) {
      return 'CANCELLED';
    }
    return 'FAILED';
  }

  public validateTimestamps(startMs: number, answerMs?: number, endMs?: number): void {
    if (typeof startMs !== 'number' || isNaN(startMs) || startMs <= 0) {
      throw new CdrValidationError('Invalid startTimeMs', 'startTimeMs', startMs);
    }
    if (typeof endMs !== 'number' || isNaN(endMs) || endMs <= 0) {
      throw new CdrValidationError('Invalid endTimeMs', 'endTimeMs', endMs);
    }
    if (startMs > endMs) {
      throw new CdrValidationError(
        `startTimeMs (${startMs}) cannot be greater than endTimeMs (${endMs})`,
        'startTimeMs',
        startMs
      );
    }
    if (answerMs !== undefined && answerMs !== null) {
      if (typeof answerMs !== 'number' || isNaN(answerMs) || answerMs <= 0) {
        throw new CdrValidationError('Invalid answerTimeMs', 'answerTimeMs', answerMs);
      }
      if (answerMs < startMs || answerMs > endMs) {
        throw new CdrValidationError(
          `answerTimeMs (${answerMs}) must be between startTimeMs (${startMs}) and endTimeMs (${endMs})`,
          'answerTimeMs',
          answerMs
        );
      }
    }
  }

  public normalizeE164(phoneNumber: string): string {
    if (!phoneNumber || typeof phoneNumber !== 'string') {
      return '';
    }
    const trimmed = phoneNumber.trim();
    // Internal extension check (e.g. 3-5 digits)
    if (/^\d{3,5}$/.test(trimmed)) {
      return trimmed;
    }
    // E.164 normalization: keep leading + and digits
    const cleaned = trimmed.startsWith('+')
      ? `+${trimmed.slice(1).replace(/\D/g, '')}`
      : `+${trimmed.replace(/\D/g, '')}`;

    return cleaned;
  }

  private resolveQ850Cause(
    q850Code?: number,
    sipCode?: number,
    disposition?: CallDisposition
  ): Q850Cause {
    if (q850Code && Q850_CAUSES[q850Code]) {
      return { code: q850Code, description: Q850_CAUSES[q850Code] };
    }

    if (disposition === 'ANSWERED') {
      return { code: 16, description: Q850_CAUSES[16] }; // NORMAL_CLEARING
    }
    if (disposition === 'BUSY' || sipCode === 486) {
      return { code: 17, description: Q850_CAUSES[17] }; // USER_BUSY
    }
    if (disposition === 'NO_ANSWER' || sipCode === 408) {
      return { code: 19, description: Q850_CAUSES[19] }; // NO_ANSWER
    }
    if (sipCode === 503) {
      return { code: 34, description: Q850_CAUSES[34] }; // NO_CIRCUIT_AVAILABLE
    }

    return { code: 41, description: Q850_CAUSES[41] || 'TEMPORARY_FAILURE' };
  }

  public isCallIdProcessed(callId: string): boolean {
    return this.processedCallIds.has(callId);
  }

  public clearProcessedCache(): void {
    this.processedCallIds.clear();
  }
}
