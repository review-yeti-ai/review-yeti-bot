/**
 * Generic Telecom Call Engine — Standard Telephony Error Hierarchy
 * Standard compliance: RFC 3261, RFC 3550, RFC 4566, RFC 2617
 */

export class TelecomEngineError extends Error {
  public readonly isOperational: boolean;

  constructor(
    message: string,
    public readonly code: string = 'TELECOM_ENGINE_ERROR',
    public readonly statusCode: number = 500,
    public readonly reasonPhrase: string = 'Internal Server Error',
    isOperational: boolean = true
  ) {
    super(message);
    this.name = this.constructor.name;
    this.isOperational = isOperational;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class TelecomError extends TelecomEngineError {
  constructor(
    message: string,
    statusCode: number = 500,
    reasonPhrase: string = 'Internal Server Error',
    isOperational: boolean = true
  ) {
    super(message, 'TELECOM_ERROR', statusCode, reasonPhrase, isOperational);
  }
}

export class SipProtocolError extends TelecomEngineError {
  constructor(
    message: string,
    public override readonly statusCode: number = 500,
    code: string = 'SIP_PROTOCOL_ERROR'
  ) {
    super(message, code, statusCode, 'SIP Protocol Error');
  }
}

export class SipSignalingError extends TelecomEngineError {
  constructor(statusCode: number, reasonPhrase: string, details?: string) {
    super(
      details ? `${reasonPhrase}: ${details}` : reasonPhrase,
      'SIP_SIGNALING_ERROR',
      statusCode,
      reasonPhrase
    );
  }
}

export class SdpNegotiationError extends TelecomEngineError {
  constructor(message: string, code: string = 'SDP_NEGOTIATION_FAILED') {
    super(message, code, 488, 'Not Acceptable Here');
  }
}

export class PortPoolExhaustedError extends TelecomEngineError {
  constructor(message: string = 'All UDP RTP/RTCP ports are currently allocated or quarantined') {
    super(message, 'PORT_POOL_EXHAUSTED', 503, 'Service Unavailable');
  }
}

export class DialogNotFoundError extends TelecomEngineError {
  constructor(dialogId: string) {
    super(`Dialog ${dialogId} not found or tenant mismatch`, 'DIALOG_NOT_FOUND', 481, 'Call/Transaction Does Not Exist');
  }
}

export class InvalidStateTransitionError extends TelecomEngineError {
  constructor(currentState: string, event: string) {
    super(`Invalid state transition from ${currentState} on event ${event}`, 'INVALID_STATE_TRANSITION', 400, 'Bad Request');
  }
}

export class RtpMediaError extends TelecomEngineError {
  constructor(message: string, statusCode: number = 500) {
    super(message, 'RTP_MEDIA_ERROR', statusCode, 'Media Gateway Error');
  }
}

export class CdrRatingError extends TelecomEngineError {
  constructor(message: string) {
    super(message, 'CDR_RATING_ERROR', 422, 'Unprocessable Billing Entity');
  }
}

export class QuotaExceededError extends TelecomEngineError {
  constructor(message: string) {
    super(message, 'QUOTA_EXCEEDED', 402, 'Payment Required / Quota Exceeded');
  }
}

export class AuthenticationError extends TelecomEngineError {
  constructor(message: string = 'Unauthorized') {
    super(message, 'AUTHENTICATION_ERROR', 401, 'Unauthorized');
  }
}
