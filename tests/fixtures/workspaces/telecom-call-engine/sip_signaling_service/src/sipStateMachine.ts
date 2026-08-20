/**
 * RFC 3261 Transaction & Call State Machine
 * Complies with RFC 3261 Section 17 (SIP Transactions) & Section 13 (Initiating a Session)
 */

import crypto from 'node:crypto';
import { SipRequest, SipResponse } from './types/sipMessages';
import { InvalidStateTransitionError } from '../../src/common/errors';

export enum CallState {
  NULL = 'NULL',                 // Idle state, no active transaction
  CALLING = 'CALLING',           // UAC: INVITE transmitted, awaiting response
  PROCEEDING = 'PROCEEDING',     // UAS/UAC: 100 Trying received or provisional response in-flight
  EARLY = 'EARLY',               // UAC/UAS: 180 Ringing or 183 Session Progress received/sent
  CONFIRMED = 'CONFIRMED',       // Active 2-way call established (200 OK + ACK completed)
  TERMINATED = 'TERMINATED'      // Call terminated (BYE, CANCEL, 4xx/5xx/6xx final rejection)
}

export type CallEvent =
  | { type: 'SEND_INVITE'; request?: SipRequest }
  | { type: 'RECV_INVITE'; request?: SipRequest }
  | { type: 'SEND_PROVISIONAL_1XX'; response?: SipResponse }
  | { type: 'RECV_PROVISIONAL_1XX'; response?: SipResponse }
  | { type: 'SEND_RINGING_180'; response?: SipResponse }
  | { type: 'RECV_RINGING_180'; response?: SipResponse }
  | { type: 'SEND_SESSION_PROGRESS_183'; response?: SipResponse }
  | { type: 'RECV_SESSION_PROGRESS_183'; response?: SipResponse }
  | { type: 'SEND_SUCCESS_200'; response?: SipResponse }
  | { type: 'RECV_SUCCESS_200'; response?: SipResponse }
  | { type: 'SEND_ACK'; request?: SipRequest }
  | { type: 'RECV_ACK'; request?: SipRequest }
  | { type: 'SEND_BYE'; request?: SipRequest }
  | { type: 'RECV_BYE'; request?: SipRequest }
  | { type: 'SEND_CANCEL'; request?: SipRequest }
  | { type: 'RECV_CANCEL'; request?: SipRequest }
  | { type: 'SEND_ERROR_4XX_6XX'; response?: SipResponse }
  | { type: 'RECV_ERROR_4XX_6XX'; response?: SipResponse }
  | { type: 'TIMER_EXPIRED'; timerName: 'TimerA' | 'TimerB' | 'TimerD' | 'TimerF' | 'TimerH' };

export interface SipTransactionTimers {
  t1: number; // 500ms
  t2: number; // 4000ms
  t4: number; // 5000ms
  timerAInterval: number;
  timerBTimeout: number;
}

export class SipStateMachine {
  private state: CallState = CallState.NULL;
  private role: 'UAC' | 'UAS';
  private callId: string;
  private branchId: string;
  private timerA?: NodeJS.Timeout;
  private timerB?: NodeJS.Timeout;
  private currentTimerAInterval: number;
  private readonly timers: SipTransactionTimers;
  private retransmitCount: number = 0;
  private ackReceived: boolean = false;
  private terminatedReason?: string;

  constructor(callId: string, role: 'UAC' | 'UAS', customTimers?: Partial<SipTransactionTimers>) {
    this.callId = callId;
    this.role = role;
    this.branchId = SipStateMachine.generateBranchId();

    const t1 = customTimers?.t1 ?? 500;
    const t2 = customTimers?.t2 ?? 4000;
    const t4 = customTimers?.t4 ?? 5000;
    this.timers = {
      t1,
      t2,
      t4,
      timerAInterval: customTimers?.timerAInterval ?? t1,
      timerBTimeout: customTimers?.timerBTimeout ?? 64 * t1,
    };
    this.currentTimerAInterval = this.timers.timerAInterval;
  }

  public getState(): CallState {
    return this.state;
  }

  public getRole(): 'UAC' | 'UAS' {
    return this.role;
  }

  public getCallId(): string {
    return this.callId;
  }

  public getBranchId(): string {
    return this.branchId;
  }

  public getRetransmitCount(): number {
    return this.retransmitCount;
  }

  public getCurrentTimerAInterval(): number {
    return this.currentTimerAInterval;
  }

  public getTerminatedReason(): string | undefined {
    return this.terminatedReason;
  }

  /**
   * Generates RFC 3261 compliant branch ID prefixed with 'z9hG4bK'
   */
  public static generateBranchId(): string {
    return `z9hG4bK${crypto.randomBytes(12).toString('hex')}`;
  }

  /**
   * Process state event and execute state transition
   */
  public processEvent(event: CallEvent): { previousState: CallState; currentState: CallState } {
    const previousState = this.state;

    switch (this.state) {
      case CallState.NULL:
        if (event.type === 'SEND_INVITE' && this.role === 'UAC') {
          this.state = CallState.CALLING;
          this.startTimerA();
          this.startTimerB();
        } else if (event.type === 'RECV_INVITE' && this.role === 'UAS') {
          this.state = CallState.PROCEEDING;
        } else {
          throw new InvalidStateTransitionError(this.state, event.type);
        }
        break;

      case CallState.CALLING:
        if (event.type === 'RECV_PROVISIONAL_1XX') {
          this.clearTimerA();
          this.state = CallState.PROCEEDING;
        } else if (event.type === 'RECV_RINGING_180' || event.type === 'RECV_SESSION_PROGRESS_183') {
          this.clearTimerA();
          this.state = CallState.EARLY;
        } else if (event.type === 'RECV_SUCCESS_200') {
          this.clearAllTimers();
          this.state = CallState.CONFIRMED;
        } else if (event.type === 'SEND_CANCEL' || event.type === 'RECV_CANCEL') {
          this.clearAllTimers();
          this.state = CallState.TERMINATED;
          this.terminatedReason = 'CANCELLED';
        } else if (event.type === 'RECV_ERROR_4XX_6XX' || event.type === 'SEND_ERROR_4XX_6XX') {
          this.clearAllTimers();
          this.state = CallState.TERMINATED;
          this.terminatedReason = 'CALL_REJECTED';
        } else if (event.type === 'TIMER_EXPIRED' && event.timerName === 'TimerA') {
          this.handleTimerAExpired();
        } else if (event.type === 'TIMER_EXPIRED' && event.timerName === 'TimerB') {
          this.clearAllTimers();
          this.state = CallState.TERMINATED;
          this.terminatedReason = '408_REQUEST_TIMEOUT';
        } else {
          throw new InvalidStateTransitionError(this.state, event.type);
        }
        break;

      case CallState.PROCEEDING:
        if (event.type === 'SEND_RINGING_180' || event.type === 'RECV_RINGING_180' ||
            event.type === 'SEND_SESSION_PROGRESS_183' || event.type === 'RECV_SESSION_PROGRESS_183') {
          this.clearTimerA();
          this.state = CallState.EARLY;
        } else if (event.type === 'SEND_SUCCESS_200' || event.type === 'RECV_SUCCESS_200') {
          this.clearAllTimers();
          this.state = CallState.CONFIRMED;
        } else if (event.type === 'SEND_CANCEL' || event.type === 'RECV_CANCEL') {
          this.clearAllTimers();
          this.state = CallState.TERMINATED;
          this.terminatedReason = 'CANCELLED';
        } else if (event.type === 'SEND_ERROR_4XX_6XX' || event.type === 'RECV_ERROR_4XX_6XX') {
          this.clearAllTimers();
          this.state = CallState.TERMINATED;
          this.terminatedReason = 'CALL_REJECTED';
        } else if (event.type === 'SEND_PROVISIONAL_1XX' || event.type === 'RECV_PROVISIONAL_1XX') {
          // Stays in PROCEEDING
        } else {
          throw new InvalidStateTransitionError(this.state, event.type);
        }
        break;

      case CallState.EARLY:
        if (event.type === 'SEND_SUCCESS_200' || event.type === 'RECV_SUCCESS_200') {
          this.clearAllTimers();
          this.state = CallState.CONFIRMED;
        } else if (event.type === 'SEND_CANCEL' || event.type === 'RECV_CANCEL') {
          this.clearAllTimers();
          this.state = CallState.TERMINATED;
          this.terminatedReason = 'CANCELLED';
        } else if (event.type === 'SEND_ERROR_4XX_6XX' || event.type === 'RECV_ERROR_4XX_6XX') {
          this.clearAllTimers();
          this.state = CallState.TERMINATED;
          this.terminatedReason = 'CALL_REJECTED';
        } else if (event.type === 'SEND_RINGING_180' || event.type === 'RECV_RINGING_180' ||
                   event.type === 'SEND_SESSION_PROGRESS_183' || event.type === 'RECV_SESSION_PROGRESS_183') {
          // Additional provisional messages in early state
        } else {
          throw new InvalidStateTransitionError(this.state, event.type);
        }
        break;

      case CallState.CONFIRMED:
        if (event.type === 'SEND_ACK' || event.type === 'RECV_ACK') {
          this.ackReceived = true;
          // Stays in CONFIRMED
        } else if (event.type === 'SEND_BYE' || event.type === 'RECV_BYE') {
          this.clearAllTimers();
          this.state = CallState.TERMINATED;
          this.terminatedReason = 'NORMAL_CLEARING';
        } else {
          throw new InvalidStateTransitionError(this.state, event.type);
        }
        break;

      case CallState.TERMINATED:
        if (event.type === 'SEND_ACK' || event.type === 'RECV_ACK') {
          // Absorb final ACK
        } else {
          throw new InvalidStateTransitionError(this.state, event.type);
        }
        break;

      default:
        throw new InvalidStateTransitionError(this.state, (event as any).type);
    }

    return { previousState, currentState: this.state };
  }

  private startTimerA(): void {
    this.clearTimerA();
    this.currentTimerAInterval = this.timers.timerAInterval;
    this.timerA = setTimeout(() => {
      if (this.state === CallState.CALLING) {
        this.processEvent({ type: 'TIMER_EXPIRED', timerName: 'TimerA' });
      }
    }, this.currentTimerAInterval);
    if (this.timerA.unref) {
      this.timerA.unref();
    }
  }

  private handleTimerAExpired(): void {
    this.retransmitCount++;
    this.currentTimerAInterval = Math.min(this.currentTimerAInterval * 2, this.timers.t2);
    this.timerA = setTimeout(() => {
      if (this.state === CallState.CALLING) {
        this.processEvent({ type: 'TIMER_EXPIRED', timerName: 'TimerA' });
      }
    }, this.currentTimerAInterval);
    if (this.timerA.unref) {
      this.timerA.unref();
    }
  }

  private startTimerB(): void {
    this.clearTimerB();
    this.timerB = setTimeout(() => {
      if (this.state === CallState.CALLING) {
        this.processEvent({ type: 'TIMER_EXPIRED', timerName: 'TimerB' });
      }
    }, this.timers.timerBTimeout);
    if (this.timerB.unref) {
      this.timerB.unref();
    }
  }

  private clearTimerA(): void {
    if (this.timerA) {
      clearTimeout(this.timerA);
      this.timerA = undefined;
    }
  }

  private clearTimerB(): void {
    if (this.timerB) {
      clearTimeout(this.timerB);
      this.timerB = undefined;
    }
  }

  public clearAllTimers(): void {
    this.clearTimerA();
    this.clearTimerB();
  }

  public dispose(): void {
    this.clearAllTimers();
  }
}
