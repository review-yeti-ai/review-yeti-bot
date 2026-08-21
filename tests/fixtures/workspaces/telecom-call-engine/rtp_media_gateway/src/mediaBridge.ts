/**
 * RTP Media Bridge — Inbound to Outbound Audio Relay & SSRC Translation
 */

import { RtpPacket } from './types/rtpTypes';
import { RtpPacketHandler } from './rtpPacketHandler';

export interface BridgeSession {
  bridgeId: string;
  legASsrc: number;
  legBSsrc: number;
  legAPort: number;
  legBPort: number;
  packetsRelayedAtoB: number;
  packetsRelayedBtoA: number;
  bytesRelayedAtoB: number;
  bytesRelayedBtoA: number;
}

export class MediaBridge {
  private readonly sessions: Map<string, BridgeSession> = new Map();

  public createSession(bridgeId: string, legAPort: number, legBPort: number, legASsrc: number, legBSsrc: number): BridgeSession {
    const session: BridgeSession = {
      bridgeId,
      legASsrc,
      legBSsrc,
      legAPort,
      legBPort,
      packetsRelayedAtoB: 0,
      packetsRelayedBtoA: 0,
      bytesRelayedAtoB: 0,
      bytesRelayedBtoA: 0,
    };
    this.sessions.set(bridgeId, session);
    return session;
  }

  public relayPacket(bridgeId: string, packet: RtpPacket, fromLeg: 'A' | 'B'): RtpPacket {
    const session = this.sessions.get(bridgeId);
    if (!session) {
      throw new Error(`MediaBridge session not found: ${bridgeId}`);
    }

    const relayedPacket: RtpPacket = {
      ...packet,
      ssrc: fromLeg === 'A' ? session.legBSsrc : session.legASsrc,
    };

    if (fromLeg === 'A') {
      session.packetsRelayedAtoB++;
      session.bytesRelayedAtoB += packet.payload.length;
    } else {
      session.packetsRelayedBtoA++;
      session.bytesRelayedBtoA += packet.payload.length;
    }

    return relayedPacket;
  }

  public getSession(bridgeId: string): BridgeSession | undefined {
    return this.sessions.get(bridgeId);
  }

  public closeSession(bridgeId: string): void {
    this.sessions.delete(bridgeId);
  }

  public clear(): void {
    this.sessions.clear();
  }
}
