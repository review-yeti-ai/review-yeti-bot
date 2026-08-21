/**
 * Generic Telecom Call Engine — Event Bus & Event Definitions
 * Standard compliance: RFC 3261, RFC 3550, RFC 4566
 */

import { CallId, TenantId, TimestampISO, AudioCodec } from './types';

export type TelephonyEventType =
  | 'call.initiated'
  | 'call.ringing'
  | 'call.answered'
  | 'call.transferred'
  | 'call.terminated'
  | 'media.started'
  | 'media.stopped'
  | 'cdr.generated'
  | 'quota.warning'
  | 'device.registered'
  | 'device.unregistered';

export interface BaseTelephonyEvent {
  eventId: string;
  eventType: TelephonyEventType;
  tenantId: TenantId;
  callId: CallId;
  timestamp: TimestampISO;
}

export interface CallInitiatedEvent extends BaseTelephonyEvent {
  eventType: 'call.initiated';
  caller: string;
  callee: string;
  trunkId?: string;
}

export interface CallRingingEvent extends BaseTelephonyEvent {
  eventType: 'call.ringing';
  ringingAt: TimestampISO;
  earlyMediaAvailable?: boolean;
}

export interface CallAnsweredEvent extends BaseTelephonyEvent {
  eventType: 'call.answered';
  answeredAt: TimestampISO;
  codec: AudioCodec;
  localRtpPort: number;
  remoteRtpPort: number;
}

export interface CallTransferredEvent extends BaseTelephonyEvent {
  eventType: 'call.transferred';
  transferType: 'BLIND' | 'ATTENDED';
  targetUri: string;
  transferorLegCallId: string;
}

export interface CallTerminatedEvent extends BaseTelephonyEvent {
  eventType: 'call.terminated';
  terminatedAt: TimestampISO;
  durationMs: number;
  terminationReason: string;
  q850CauseCode: number;
  sipResponseCode: number;
  rtpPacketStats?: {
    packetsSent: number;
    packetsReceived: number;
    packetsLost: number;
    jitterMs: number;
  };
}

export interface MediaStartedEvent extends BaseTelephonyEvent {
  eventType: 'media.started';
  localPort: number;
  remotePort: number;
  codec: AudioCodec;
}

export interface MediaStoppedEvent extends BaseTelephonyEvent {
  eventType: 'media.stopped';
  packetsTransmitted: number;
  packetsReceived: number;
  bytesTransmitted: number;
  bytesReceived: number;
}

export interface CdrGeneratedEvent extends BaseTelephonyEvent {
  eventType: 'cdr.generated';
  cdrId: string;
  billedDurationSec: number;
  totalCostMicros: number;
}

export interface QuotaWarningEvent extends BaseTelephonyEvent {
  eventType: 'quota.warning';
  thresholdPct: number;
  currentUsage: number;
  limit: number;
}

export interface DeviceRegisteredEvent extends BaseTelephonyEvent {
  eventType: 'device.registered';
  aor: string;
  contactUri: string;
  expiresSec: number;
}

export interface DeviceUnregisteredEvent extends BaseTelephonyEvent {
  eventType: 'device.unregistered';
  aor: string;
  contactUri: string;
}

export type AnyTelephonyEvent =
  | CallInitiatedEvent
  | CallRingingEvent
  | CallAnsweredEvent
  | CallTransferredEvent
  | CallTerminatedEvent
  | MediaStartedEvent
  | MediaStoppedEvent
  | CdrGeneratedEvent
  | QuotaWarningEvent
  | DeviceRegisteredEvent
  | DeviceUnregisteredEvent;

export type EventHandler<T extends AnyTelephonyEvent = AnyTelephonyEvent> = (event: T) => Promise<void> | void;

export class TelephonyEventBus {
  private readonly listeners: Map<TelephonyEventType, Set<EventHandler<any>>> = new Map();

  public subscribe<T extends AnyTelephonyEvent>(eventType: TelephonyEventType, handler: EventHandler<T>): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(handler as EventHandler<any>);
    return () => this.unsubscribe(eventType, handler);
  }

  public unsubscribe<T extends AnyTelephonyEvent>(eventType: TelephonyEventType, handler: EventHandler<T>): void {
    const handlers = this.listeners.get(eventType);
    if (handlers) {
      handlers.delete(handler as EventHandler<any>);
    }
  }

  public async publish(event: AnyTelephonyEvent): Promise<void> {
    const handlers = this.listeners.get(event.eventType);
    if (!handlers || handlers.size === 0) {
      return;
    }
    const promises: Array<Promise<void>> = [];
    for (const handler of handlers) {
      try {
        const res = handler(event);
        if (res && typeof res.then === 'function') {
          promises.push(res);
        }
      } catch (err) {
        console.error(`Error in event handler for ${event.eventType}:`, err);
      }
    }
    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }
  }

  public clear(): void {
    this.listeners.clear();
  }
}
