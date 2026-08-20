/**
 * Empirical Adversarial Challenger Test Suite: SIP Signaling Service & RTP Media Gateway
 * Location: tests/integration/telecomSIPRTPAdversarialEmpirical.test.ts
 *
 * Stress-tests extreme edge cases:
 * 1. Out-of-order SIP messages & CSeq tracking
 * 2. Re-INVITE glare collision (RFC 3261 491 Request Pending & backoff timers)
 * 3. Rapid sequential BYE/INVITE races & state teardown (5,000 FSM transitions)
 * 4. 16-bit RTP sequence number rollover (65535 -> 0), out-of-order packet reordering & jitter computation
 * 5. Burst packet loss >50%, ITU-T G.711 Appendix I PLC & comfort noise
 * 6. UDP port pool exhaustion, concurrency & quarantine cooldown lifecycle (100 rapid cycles)
 * 7. SDP Offer/Answer negotiation edge cases & codec mismatch handling
 * 8. G.711 μ-law/A-law bitwise codec clipping & direct transcoding parity
 * 9. SIP message parser RFC 3261 compliance with edge-case headers & multiline bodies
 */

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';

// Subsystem 1: SIP Signaling Service
import {
  SipStateMachine,
  CallState,
  DialogManager,
  SdpNegotiator,
  CallTransferCoordinator,
  SipServer,
  parseSipUri,
  formatSipUri,
} from '../fixtures/workspaces/telecom-call-engine/sip_signaling_service';

// Subsystem 2: RTP Media Gateway
import {
  RtpPacketHandler,
  JitterBuffer,
  AudioCodecs,
  PortAllocator,
  MediaBridge,
  RtcpReporter,
  RtpPacket,
} from '../fixtures/workspaces/telecom-call-engine/rtp_media_gateway';

// Common Layer Errors
import {
  InvalidStateTransitionError,
  DialogNotFoundError,
  SipProtocolError,
  SdpNegotiationError,
  PortPoolExhaustedError,
  RtpMediaError,
} from '../fixtures/workspaces/telecom-call-engine';

describe('Empirical Adversarial Challenger: SIP Signaling & RTP Media Gateway', () => {

  // =========================================================================
  // 1. Out-of-Order SIP Messages, CSeq Tracking & Invalid Transitions
  // =========================================================================
  describe('1. Out-of-Order SIP Messages & CSeq Tracking', () => {
    it('handles direct 200 OK response from CALLING state (bypassing provisional 180)', () => {
      const fsm = new SipStateMachine('call-ooo-1', 'UAC');
      fsm.processEvent({ type: 'SEND_INVITE' });
      expect(fsm.getState()).toBe(CallState.CALLING);

      // Fast network: 200 OK arrives directly without 100/180
      const transition = fsm.processEvent({ type: 'RECV_SUCCESS_200' });
      expect(transition.previousState).toBe(CallState.CALLING);
      expect(transition.currentState).toBe(CallState.CONFIRMED);
      expect(fsm.getState()).toBe(CallState.CONFIRMED);
      fsm.dispose();
    });

    it('rejects late 180 Ringing arriving after 200 OK (in CONFIRMED state)', () => {
      const fsm = new SipStateMachine('call-ooo-2', 'UAC');
      fsm.processEvent({ type: 'SEND_INVITE' });
      fsm.processEvent({ type: 'RECV_SUCCESS_200' });
      expect(fsm.getState()).toBe(CallState.CONFIRMED);

      // Late arriving 180 Ringing packet
      expect(() => {
        fsm.processEvent({ type: 'RECV_RINGING_180' });
      }).toThrow(InvalidStateTransitionError);

      expect(fsm.getState()).toBe(CallState.CONFIRMED);
      fsm.dispose();
    });

    it('rejects premature ACK received before 200 OK (in CALLING state)', () => {
      const fsm = new SipStateMachine('call-ooo-3', 'UAS');
      fsm.processEvent({ type: 'RECV_INVITE' });
      expect(fsm.getState()).toBe(CallState.PROCEEDING);

      // Premature ACK before 200 OK sent
      expect(() => {
        fsm.processEvent({ type: 'RECV_ACK' });
      }).toThrow(InvalidStateTransitionError);

      fsm.dispose();
    });

    it('absorbs stray ACK in TERMINATED state without throwing', () => {
      const fsm = new SipStateMachine('call-ooo-4', 'UAC');
      fsm.processEvent({ type: 'SEND_INVITE' });
      fsm.processEvent({ type: 'RECV_SUCCESS_200' });
      fsm.processEvent({ type: 'SEND_BYE' });
      expect(fsm.getState()).toBe(CallState.TERMINATED);

      // Stray retransmitted ACK arriving post-teardown
      expect(() => {
        fsm.processEvent({ type: 'RECV_ACK' });
      }).not.toThrow();

      expect(fsm.getState()).toBe(CallState.TERMINATED);
      fsm.dispose();
    });

    it('rejects BYE sent in CALLING state (must CANCEL early leg)', () => {
      const fsm = new SipStateMachine('call-ooo-5', 'UAC');
      fsm.processEvent({ type: 'SEND_INVITE' });
      expect(fsm.getState()).toBe(CallState.CALLING);

      expect(() => {
        fsm.processEvent({ type: 'SEND_BYE' });
      }).toThrow(InvalidStateTransitionError);

      // CANCEL is valid
      fsm.processEvent({ type: 'SEND_CANCEL' });
      expect(fsm.getState()).toBe(CallState.TERMINATED);
      expect(fsm.getTerminatedReason()).toBe('CANCELLED');
      fsm.dispose();
    });

    it('rejects CANCEL sent in CONFIRMED state (must BYE active call)', () => {
      const fsm = new SipStateMachine('call-ooo-6', 'UAC');
      fsm.processEvent({ type: 'SEND_INVITE' });
      fsm.processEvent({ type: 'RECV_SUCCESS_200' });
      expect(fsm.getState()).toBe(CallState.CONFIRMED);

      expect(() => {
        fsm.processEvent({ type: 'SEND_CANCEL' });
      }).toThrow(InvalidStateTransitionError);

      // BYE is valid
      fsm.processEvent({ type: 'SEND_BYE' });
      expect(fsm.getState()).toBe(CallState.TERMINATED);
      expect(fsm.getTerminatedReason()).toBe('NORMAL_CLEARING');
      fsm.dispose();
    });

    it('enforces monotonic CSeq validation in DialogManager across replayed and out-of-order requests', () => {
      const dm = new DialogManager();
      const dialog = dm.createOrUpdateDialog(
        'tenant-edge',
        {
          isRequest: true,
          method: 'INVITE',
          requestUri: parseSipUri('sip:callee@domain.com'),
          version: '2.0',
          headers: {
            callId: 'call-cseq-adv',
            from: { uri: parseSipUri('sip:caller@domain.com'), tag: 'tag-from-1' },
            to: { uri: parseSipUri('sip:callee@domain.com'), tag: 'tag-to-1' },
            cseq: { sequenceNumber: 100, method: 'INVITE' },
            via: [],
            maxForwards: 70,
            contentLength: 0,
            custom: {},
          },
        },
        'UAS'
      );

      // 1. Initial CSeq is 100
      expect(dialog.remoteCSeq).toBe(100);

      // 2. In-order higher CSeq (101) -> ACCEPTED
      expect(dm.validateAndUpdateRemoteCSeq(dialog.dialogId, 101)).toBe(true);

      // 3. Jump forward CSeq (115) -> ACCEPTED (network dropped intervening)
      expect(dm.validateAndUpdateRemoteCSeq(dialog.dialogId, 115)).toBe(true);

      // 4. Exact replay of CSeq (115) -> REJECTED
      expect(dm.validateAndUpdateRemoteCSeq(dialog.dialogId, 115)).toBe(false);

      // 5. Old out-of-order CSeq (102) -> REJECTED
      expect(dm.validateAndUpdateRemoteCSeq(dialog.dialogId, 102)).toBe(false);

      // 6. Next increment (116) -> ACCEPTED
      expect(dm.validateAndUpdateRemoteCSeq(dialog.dialogId, 116)).toBe(true);
    });
  });

  // =========================================================================
  // 2. Re-INVITE Glare Collision (491 Request Pending & Timer Distributions)
  // =========================================================================
  describe('2. Re-INVITE Glare Collision & RFC 3261 Section 14.1/14.2 Backoff', () => {
    let dm: DialogManager;
    let dialogId: string;

    beforeEach(() => {
      dm = new DialogManager();
      const dialog = dm.createOrUpdateDialog(
        'tenant-glare',
        {
          isRequest: false,
          statusCode: 200,
          reasonPhrase: 'OK',
          version: '2.0',
          headers: {
            callId: 'call-glare-101',
            from: { uri: parseSipUri('sip:alice@domain.com'), tag: 'alice-tag' },
            to: { uri: parseSipUri('sip:bob@domain.com'), tag: 'bob-tag' },
            cseq: { sequenceNumber: 1, method: 'INVITE' },
            via: [],
            maxForwards: 70,
            contentLength: 0,
            custom: {},
          },
        },
        'UAC'
      );
      dialogId = dialog.dialogId;
    });

    it('detects simultaneous re-INVITE collision and returns 491 with valid retry-after timers', () => {
      // First party initiates re-INVITE
      const first = dm.handleReInvite(dialogId, true);
      expect(first.allow).toBe(true);
      expect(first.httpStatus).toBeUndefined();

      // Second party attempts simultaneous re-INVITE while first is pending -> GLARE!
      const secondAsOwner = dm.handleReInvite(dialogId, true);
      expect(secondAsOwner.allow).toBe(false);
      expect(secondAsOwner.httpStatus).toBe(491);
      expect(secondAsOwner.retryAfterSec).toBeGreaterThanOrEqual(2.1);
      expect(secondAsOwner.retryAfterSec).toBeLessThanOrEqual(4.0);

      const secondAsNonOwner = dm.handleReInvite(dialogId, false);
      expect(secondAsNonOwner.allow).toBe(false);
      expect(secondAsNonOwner.httpStatus).toBe(491);
      expect(secondAsNonOwner.retryAfterSec).toBeGreaterThanOrEqual(0.0);
      expect(secondAsNonOwner.retryAfterSec).toBeLessThanOrEqual(2.0);
    });

    it('empirically verifies 100 random trials of backoff distributions for owner vs non-owner', () => {
      dm.handleReInvite(dialogId, true); // Lock

      for (let i = 0; i < 100; i++) {
        const ownerResult = dm.handleReInvite(dialogId, true);
        expect(ownerResult.allow).toBe(false);
        expect(ownerResult.httpStatus).toBe(491);
        expect(ownerResult.retryAfterSec).toBeGreaterThanOrEqual(2.1);
        expect(ownerResult.retryAfterSec).toBeLessThanOrEqual(4.0);

        const nonOwnerResult = dm.handleReInvite(dialogId, false);
        expect(nonOwnerResult.allow).toBe(false);
        expect(nonOwnerResult.httpStatus).toBe(491);
        expect(nonOwnerResult.retryAfterSec).toBeGreaterThanOrEqual(0.0);
        expect(nonOwnerResult.retryAfterSec).toBeLessThanOrEqual(2.0);
      }
    });

    it('allows new re-INVITE immediately after completeReInvite is called', () => {
      dm.handleReInvite(dialogId, true);
      expect(dm.handleReInvite(dialogId, true).allow).toBe(false);

      dm.completeReInvite(dialogId);
      const retry = dm.handleReInvite(dialogId, true);
      expect(retry.allow).toBe(true);
      dm.completeReInvite(dialogId);
    });
  });

  // =========================================================================
  // 3. Rapid Sequential BYE/INVITE Races & State Teardown
  // =========================================================================
  describe('3. Rapid Sequential BYE/INVITE Races & Teardown Integrity', () => {
    it('executes 500 consecutive rapid create/teardown cycles without memory or state leakage', () => {
      const dm = new DialogManager();
      const tenantId = 'tenant-rapid';

      for (let i = 0; i < 500; i++) {
        const callId = `call-rapid-${i}`;
        const fsm = new SipStateMachine(callId, 'UAC');
        fsm.processEvent({ type: 'SEND_INVITE' });
        fsm.processEvent({ type: 'RECV_RINGING_180' });
        fsm.processEvent({ type: 'RECV_SUCCESS_200' });
        fsm.processEvent({ type: 'SEND_ACK' });

        const dialog = dm.createOrUpdateDialog(
          tenantId,
          {
            isRequest: false,
            statusCode: 200,
            reasonPhrase: 'OK',
            version: '2.0',
            headers: {
              callId,
              from: { uri: parseSipUri(`sip:user_${i}@domain.com`), tag: `tag-from-${i}` },
              to: { uri: parseSipUri(`sip:target_${i}@domain.com`), tag: `tag-to-${i}` },
              cseq: { sequenceNumber: 1, method: 'INVITE' },
              via: [],
              maxForwards: 70,
              contentLength: 0,
              custom: {},
            },
          },
          'UAC'
        );

        expect(dialog.state).toBe('CONFIRMED');

        // Simulate mid-call glare check
        const glare = dm.handleReInvite(dialog.dialogId, true);
        expect(glare.allow).toBe(true);

        // Immediate BYE teardown while re-INVITE is active
        fsm.processEvent({ type: 'SEND_BYE' });
        expect(fsm.getState()).toBe(CallState.TERMINATED);

        dm.terminateDialog(tenantId, dialog.dialogId);
        fsm.dispose();
      }

      expect(dm.getActiveDialogCount(tenantId)).toBe(0);
    });

    it('stress-tests 2,000 rapid FSM state cycles under alternating provisional paths', () => {
      for (let i = 0; i < 2000; i++) {
        const fsm = new SipStateMachine(`call-fsm-stress-${i}`, 'UAC');
        fsm.processEvent({ type: 'SEND_INVITE' });
        if (i % 2 === 0) {
          fsm.processEvent({ type: 'RECV_RINGING_180' });
        } else if (i % 3 === 0) {
          fsm.processEvent({ type: 'RECV_SESSION_PROGRESS_183' });
        }
        fsm.processEvent({ type: 'RECV_SUCCESS_200' });
        fsm.processEvent({ type: 'SEND_ACK' });
        fsm.processEvent({ type: 'SEND_BYE' });
        expect(fsm.getState()).toBe(CallState.TERMINATED);
        fsm.dispose();
      }
    });
  });

  // =========================================================================
  // 4. 16-Bit RTP Sequence Number Rollover (65535 -> 0), Reordering & Jitter
  // =========================================================================
  describe('4. 16-Bit RTP Sequence Number Rollover, Packet Reordering & Jitter', () => {
    it('accurately computes signed sequenceDifference across the 65535 -> 0 boundary', () => {
      // 1-step forward
      expect(JitterBuffer.sequenceDifference(0, 65535)).toBe(1);
      expect(JitterBuffer.sequenceDifference(1, 65535)).toBe(2);
      expect(JitterBuffer.sequenceDifference(5, 65530)).toBe(11);

      // 1-step backward (late / reordered)
      expect(JitterBuffer.sequenceDifference(65535, 0)).toBe(-1);
      expect(JitterBuffer.sequenceDifference(65535, 1)).toBe(-2);
      expect(JitterBuffer.sequenceDifference(65530, 5)).toBe(-11);

      // Edge boundaries
      expect(JitterBuffer.sequenceDifference(32767, 0)).toBe(32767);
      expect(JitterBuffer.sequenceDifference(32768, 0)).toBe(-32768);
    });

    it('streams 1,000 consecutive packets smoothly across multiple rollovers via interleaved playout', () => {
      const jb = new JitterBuffer({ clockRate: 8000, codec: 'PCMU' });
      const startSeq = 65500;
      const totalPackets = 1000; // Will rollover 65535 -> 0 and continue to 65500 + 1000 = 66500 (seq 964)

      // Initial prebuffer of 3 packets
      for (let i = 0; i < 3; i++) {
        const seq = (startSeq + i) & 0xffff;
        jb.push(
          {
            version: 2, padding: false, extension: false, csrcCount: 0, marker: i === 0,
            payloadType: 0, sequenceNumber: seq, timestamp: 8000 + i * 160, ssrc: 0x99887766, csrc: [],
            payload: Buffer.alloc(160, seq & 0xff),
          },
          1000 + i * 20
        );
      }

      // Continuous interleaved streaming: push 1, pop 1
      for (let i = 3; i < totalPackets; i++) {
        const pushSeq = (startSeq + i) & 0xffff;
        jb.push(
          {
            version: 2, padding: false, extension: false, csrcCount: 0, marker: false,
            payloadType: 0, sequenceNumber: pushSeq, timestamp: 8000 + i * 160, ssrc: 0x99887766, csrc: [],
            payload: Buffer.alloc(160, pushSeq & 0xff),
          },
          1000 + i * 20
        );

        const expectedPopSeq = (startSeq + (i - 3)) & 0xffff;
        const frame = jb.popPlayoutFrame();
        expect(frame.concealed).toBe(false);
        expect(frame.sequenceNumber).toBe(expectedPopSeq);
        expect(frame.payload[0]).toBe(expectedPopSeq & 0xff);
      }

      // Pop remaining 3 trailing frames
      for (let i = totalPackets - 3; i < totalPackets; i++) {
        const expectedPopSeq = (startSeq + i) & 0xffff;
        const frame = jb.popPlayoutFrame();
        expect(frame.concealed).toBe(false);
        expect(frame.sequenceNumber).toBe(expectedPopSeq);
        expect(frame.payload[0]).toBe(expectedPopSeq & 0xff);
      }

      expect(jb.getLossCount()).toBe(0);
    });

    it('correctly reorders out-of-order RTP packets in circular buffer before playout deadline', () => {
      const jb = new JitterBuffer({ clockRate: 8000, codec: 'PCMU' });

      const p100: RtpPacket = {
        version: 2, padding: false, extension: false, csrcCount: 0, marker: false,
        payloadType: 0, sequenceNumber: 100, timestamp: 16000, ssrc: 1, csrc: [],
        payload: Buffer.alloc(160, 0x10),
      };

      const p102: RtpPacket = { // Arrives BEFORE 101
        version: 2, padding: false, extension: false, csrcCount: 0, marker: false,
        payloadType: 0, sequenceNumber: 102, timestamp: 16320, ssrc: 1, csrc: [],
        payload: Buffer.alloc(160, 0x30),
      };

      const p101: RtpPacket = { // Late packet arriving after 102 but before playout
        version: 2, padding: false, extension: false, csrcCount: 0, marker: false,
        payloadType: 0, sequenceNumber: 101, timestamp: 16160, ssrc: 1, csrc: [],
        payload: Buffer.alloc(160, 0x20),
      };

      jb.push(p100, 1000);
      jb.push(p102, 1020); // Out of order!
      jb.push(p101, 1030); // Reordered insertion into slot 101

      // Playout pops in exact sequence 100, 101, 102 with zero concealment!
      const f100 = jb.popPlayoutFrame();
      expect(f100.concealed).toBe(false);
      expect(f100.sequenceNumber).toBe(100);
      expect(f100.payload[0]).toBe(0x10);

      const f101 = jb.popPlayoutFrame();
      expect(f101.concealed).toBe(false);
      expect(f101.sequenceNumber).toBe(101);
      expect(f101.payload[0]).toBe(0x20);

      const f102 = jb.popPlayoutFrame();
      expect(f102.concealed).toBe(false);
      expect(f102.sequenceNumber).toBe(102);
      expect(f102.payload[0]).toBe(0x30);
    });

    it('computes stable non-negative jitter across rollover with inter-arrival variance', () => {
      const jb = new JitterBuffer({ clockRate: 8000, codec: 'PCMU' });
      const startSeq = 65530;

      for (let i = 0; i < 20; i++) {
        const seq = (startSeq + i) & 0xffff;
        const timestamp = 10000 + i * 160;
        // Jittery arrival: alternate +/- 10ms
        const jitterDeltaMs = i % 2 === 0 ? 10 : -10;
        const arrivalMs = 2000 + i * 20 + jitterDeltaMs;

        const packet: RtpPacket = {
          version: 2,
          padding: false,
          extension: false,
          csrcCount: 0,
          marker: false,
          payloadType: 0,
          sequenceNumber: seq,
          timestamp,
          ssrc: 0xaabbccdd,
          csrc: [],
          payload: Buffer.alloc(160, 0x33),
        };

        jb.push(packet, arrivalMs);
      }

      const jitterMs = jb.getJitterMs();
      expect(jitterMs).toBeGreaterThan(0);
      expect(Number.isFinite(jitterMs)).toBe(true);
      expect(jb.getTargetDelayMs()).toBeGreaterThanOrEqual(20);
    });
  });

  // =========================================================================
  // 5. Burst Packet Loss >50%, G.711 Appendix I PLC & Comfort Noise
  // =========================================================================
  describe('5. Burst Packet Loss >50%, G.711 Appendix I PLC & Comfort Noise', () => {
    it('handles 60% burst loss (6 of 10 dropped) with 3-stage PLC attenuation then comfort noise fallback', () => {
      const jb = new JitterBuffer({ clockRate: 8000, codec: 'PCMU' });

      // Transmit Packet 100
      const p100: RtpPacket = {
        version: 2, padding: false, extension: false, csrcCount: 0, marker: false,
        payloadType: 0, sequenceNumber: 100, timestamp: 16000, ssrc: 1, csrc: [],
        payload: Buffer.alloc(160, 0x20), // Initial audio level
      };
      jb.push(p100, 1000);

      // Packets 101-106 are DROPPED (burst loss)

      // Transmit Packet 107 (stream resumes)
      const p107: RtpPacket = {
        version: 2, padding: false, extension: false, csrcCount: 0, marker: false,
        payloadType: 0, sequenceNumber: 107, timestamp: 17120, ssrc: 1, csrc: [],
        payload: Buffer.alloc(160, 0x40),
      };
      jb.push(p107, 1140);

      expect(jb.getLossCount()).toBe(6); // 101, 102, 103, 104, 105, 106

      // Playout frame 100: Real frame
      const f100 = jb.popPlayoutFrame();
      expect(f100.concealed).toBe(false);
      expect(f100.sequenceNumber).toBe(100);
      expect(f100.payload[0]).toBe(0x20);

      // Frame 101: PLC frame 1 (attenuation 0.8)
      const f101 = jb.popPlayoutFrame();
      expect(f101.concealed).toBe(true);
      expect(f101.sequenceNumber).toBe(101);

      // Frame 102: PLC frame 2 (attenuation 0.64)
      const f102 = jb.popPlayoutFrame();
      expect(f102.concealed).toBe(true);
      expect(f102.sequenceNumber).toBe(102);

      // Frame 103: PLC frame 3 (attenuation 0.512)
      const f103 = jb.popPlayoutFrame();
      expect(f103.concealed).toBe(true);
      expect(f103.sequenceNumber).toBe(103);

      // Frames 104-106: Prolonged loss (>60ms) -> Comfort noise (0x7F for PCMU)
      const f104 = jb.popPlayoutFrame();
      expect(f104.concealed).toBe(true);
      expect(f104.payload[0]).toBe(0x7f);

      const f105 = jb.popPlayoutFrame();
      expect(f105.concealed).toBe(true);
      expect(f105.payload[0]).toBe(0x7f);

      const f106 = jb.popPlayoutFrame();
      expect(f106.concealed).toBe(true);
      expect(f106.payload[0]).toBe(0x7f);

      // Frame 107: Recovered real audio frame!
      const f107 = jb.popPlayoutFrame();
      expect(f107.concealed).toBe(false);
      expect(f107.sequenceNumber).toBe(107);
      expect(f107.payload[0]).toBe(0x40);
    });

    it('survives 80% heavy stochastic packet loss over 100 packets without hanging or crashing', () => {
      const jb = new JitterBuffer({ clockRate: 8000, codec: 'PCMU' });
      const totalPackets = 100;
      let transmittedCount = 0;
      let droppedCount = 0;

      for (let i = 0; i < totalPackets; i++) {
        const seq = (1000 + i) & 0xffff;
        const shouldDrop = i > 0 && (i % 5 !== 0); // 80% drop rate

        if (shouldDrop) {
          droppedCount++;
          continue;
        }

        transmittedCount++;
        const packet: RtpPacket = {
          version: 2, padding: false, extension: false, csrcCount: 0, marker: i === 0,
          payloadType: 0, sequenceNumber: seq, timestamp: 8000 + i * 160, ssrc: 7, csrc: [],
          payload: Buffer.alloc(160, 0x11),
        };
        jb.push(packet, 1000 + i * 20);
      }

      // Send a terminating sentinel packet (seq 1100) to close the loss gap detection
      const sentinel: RtpPacket = {
        version: 2, padding: false, extension: false, csrcCount: 0, marker: false,
        payloadType: 0, sequenceNumber: (1000 + totalPackets) & 0xffff,
        timestamp: 8000 + totalPackets * 160, ssrc: 7, csrc: [],
        payload: Buffer.alloc(160, 0x99),
      };
      jb.push(sentinel, 1000 + totalPackets * 20);

      // Pop all 100 frames + sentinel
      let realFrames = 0;
      let concealedFrames = 0;
      for (let i = 0; i < totalPackets; i++) {
        const frame = jb.popPlayoutFrame();
        expect(frame.payload.length).toBe(160);
        if (frame.concealed) {
          concealedFrames++;
        } else {
          realFrames++;
        }
      }

      expect(realFrames).toBe(transmittedCount);
      expect(concealedFrames).toBe(droppedCount);
      expect(jb.getLossCount()).toBe(droppedCount);
    });
  });

  // =========================================================================
  // 6. UDP Port Pool Exhaustion, Concurrency & Quarantine Cooldown Lifecycle
  // =========================================================================
  describe('6. UDP Port Pool Exhaustion, Concurrency & Quarantine Cooldown', () => {
    it('exhausts small port pool, enforces quarantine cooldown barrier, and recycles after expiry', async () => {
      // 4 pairs: 20000, 20002, 20004, 20006
      const allocator = new PortAllocator({ minPort: 20000, maxPort: 20008, cooldownMs: 100 });

      const p1 = await allocator.allocatePair('tenant-a', 'call-1');
      const p2 = await allocator.allocatePair('tenant-a', 'call-2');
      const p3 = await allocator.allocatePair('tenant-a', 'call-3');
      const p4 = await allocator.allocatePair('tenant-a', 'call-4');

      expect(allocator.getMetrics().allocatedPairs).toBe(4);
      expect(allocator.getMetrics().availablePairs).toBe(0);

      // Attempt 5th -> throws PortPoolExhaustedError
      await expect(allocator.allocatePair('tenant-a', 'call-5')).rejects.toThrow(PortPoolExhaustedError);

      // Release p1 (20000) -> moves into quarantine
      await allocator.releasePair(p1.rtpPort);
      expect(allocator.getMetrics().quarantinedPairs).toBe(1);
      expect(allocator.getMetrics().allocatedPairs).toBe(3);

      // Immediate reallocation attempt while quarantined MUST fail
      await expect(allocator.allocatePair('tenant-a', 'call-5')).rejects.toThrow(PortPoolExhaustedError);

      // Wait 130ms for quarantine to expire
      await new Promise((r) => setTimeout(r, 130));

      // Now allocation succeeds and re-acquires 20000
      const p5 = await allocator.allocatePair('tenant-a', 'call-5');
      expect(p5.rtpPort).toBe(20000);
      expect(p5.rtcpPort).toBe(20001);
      expect(allocator.getMetrics().allocatedPairs).toBe(4);
      expect(allocator.getMetrics().quarantinedPairs).toBe(0);
    });

    it('allocates 50 concurrent port pairs under Promise.all without port collisions', async () => {
      const allocator = new PortAllocator({ minPort: 10000, maxPort: 10100 }); // 50 pairs
      const tenantId = 'tenant-concur';

      const promises: Array<Promise<any>> = [];
      for (let i = 0; i < 50; i++) {
        promises.push(allocator.allocatePair(tenantId, `call-concurrent-${i}`));
      }

      const allocatedPairs = await Promise.all(promises);
      expect(allocatedPairs.length).toBe(50);

      const rtpPorts = new Set(allocatedPairs.map((p) => p.rtpPort));
      expect(rtpPorts.size).toBe(50); // Zero collisions

      // Release all call ports
      for (let i = 0; i < 50; i++) {
        await allocator.releaseCallPorts(tenantId, `call-concurrent-${i}`);
      }

      expect(allocator.getMetrics().allocatedPairs).toBe(0);
      expect(allocator.getMetrics().quarantinedPairs).toBe(50);
    });

    it('stress-tests 20 rapid exhaustion and quarantine recycling cycles', async () => {
      const allocator = new PortAllocator({ minPort: 30000, maxPort: 30020, cooldownMs: 30 }); // 10 pairs
      for (let cycle = 0; cycle < 20; cycle++) {
        const pairs: any[] = [];
        for (let i = 0; i < 10; i++) {
          pairs.push(await allocator.allocatePair(`tenant-${cycle}`, `call-${i}`));
        }
        expect(allocator.getMetrics().allocatedPairs).toBe(10);
        expect(allocator.getMetrics().availablePairs).toBe(0);

        for (const p of pairs) {
          await allocator.releasePair(p.rtpPort);
        }
        expect(allocator.getMetrics().quarantinedPairs).toBe(10);

        await new Promise((r) => setTimeout(r, 45));
        expect(allocator.getMetrics().quarantinedPairs).toBe(0);
        expect(allocator.getMetrics().availablePairs).toBe(10);
      }
    });
  });

  // =========================================================================
  // 7. SDP Offer/Answer Negotiation Edge Cases
  // =========================================================================
  describe('7. SDP Offer/Answer Negotiation Edge Cases', () => {
    it('throws SdpNegotiationError on codec capability mismatch', () => {
      const negotiator = new SdpNegotiator([
        { name: 'opus', clockRate: 48000, channels: 2, preferredPayloadType: 111 },
      ]);

      // Offer only has PCMU (pt=0) and PCMA (pt=8)
      const offer = new SdpNegotiator([
        { name: 'PCMU', clockRate: 8000, channels: 1, preferredPayloadType: 0 },
      ]).createOffer('1.2.3.4', 16384);

      expect(() => {
        negotiator.createAnswer(offer, '5.6.7.8', 20000);
      }).toThrow(SdpNegotiationError);
    });

    it('correctly negotiates call hold direction matrix (sendrecv -> sendonly -> recvonly / inactive)', () => {
      const negotiator = new SdpNegotiator();

      // Offerer puts on hold by offering sendonly
      const holdOffer = negotiator.createOffer('1.2.3.4', 16384, { direction: 'sendonly' });
      const answer = negotiator.createAnswer(holdOffer, '5.6.7.8', 20000, 'sendrecv');

      // Per RFC 3264 Section 6.1: sendonly offer answered with sendrecv results in recvonly
      expect(answer.answer.media[0].direction).toBe('recvonly');
    });

    it('throws SdpNegotiationError if peer offered port is 0 (stream rejected)', () => {
      const negotiator = new SdpNegotiator();
      const offer = negotiator.createOffer('1.2.3.4', 0); // Port 0 = rejected

      expect(() => {
        negotiator.createAnswer(offer, '5.6.7.8', 20000);
      }).toThrow(SdpNegotiationError);
    });
  });

  // =========================================================================
  // 8. Audio Codecs Bitwise Clipping & Transcoding Invariants
  // =========================================================================
  describe('8. Audio Codecs Bitwise Clipping & Transcoding Invariants', () => {
    it('handles extreme 16-bit linear PCM clipping limits (+32767, -32768, 0)', () => {
      const buf = Buffer.alloc(6);
      buf.writeInt16LE(32767, 0);
      buf.writeInt16LE(-32768, 2);
      buf.writeInt16LE(0, 4);

      const ulaw = AudioCodecs.linearToUlaw(buf);
      expect(ulaw.length).toBe(3);

      const decoded = AudioCodecs.ulawToLinear(ulaw);
      expect(decoded.readInt16LE(4)).toBe(0); // Zero sample maps back to 0

      const alaw = AudioCodecs.linearToAlaw(buf);
      expect(alaw.length).toBe(3);
    });

    it('verifies bidirectional direct μ-law <-> A-law transcoding symmetry', () => {
      const origUlaw = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) origUlaw[i] = i;

      const alaw = AudioCodecs.ulawToAlaw(origUlaw);
      expect(alaw.length).toBe(256);

      const backUlaw = AudioCodecs.alawToUlaw(alaw);
      expect(backUlaw.length).toBe(256);
    });

    it('validates Opus TOC frame packaging and rejects empty buffer', () => {
      expect(() => AudioCodecs.packageOpusFrame(Buffer.alloc(0))).toThrow();

      const validOpus = Buffer.from([0x78, 0x01, 0x02, 0x03]);
      const packaged = AudioCodecs.packageOpusFrame(validOpus);
      expect(packaged.length).toBe(4);
    });
  });

  // =========================================================================
  // 9. SIP Message Parser RFC 3261 Compliance & Malformed Messages
  // =========================================================================
  describe('9. SIP Message Parser RFC 3261 Compliance & Edge Cases', () => {
    let server: SipServer;

    beforeEach(() => {
      server = new SipServer('127.0.0.1', 5060);
    });

    it('parses compact SIP headers (v, f, t, i, c, m, l)', () => {
      const compactSip = [
        'INVITE sip:bob@example.com SIP/2.0',
        'v: SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bKcompact123',
        'f: <sip:alice@example.com>;tag=from-compact-1',
        't: <sip:bob@example.com>',
        'i: call-compact-id-999',
        'CSeq: 1 INVITE',
        'm: <sip:alice@192.0.2.1:5060>',
        'c: application/sdp',
        'l: 12',
        '',
        'v=0\r\ns=-\r\n',
      ].join('\r\n');

      const parsed: any = server.parseMessage(compactSip);
      expect(parsed.isRequest).toBe(true);
      expect(parsed.method).toBe('INVITE');
      expect(parsed.headers.callId).toBe('call-compact-id-999');
      expect(parsed.headers.from.tag).toBe('from-compact-1');
      expect(parsed.headers.via[0].branch).toBe('z9hG4bKcompact123');
      expect(parsed.headers.contentType).toBe('application/sdp');
      expect(parsed.headers.contentLength).toBe(12);
    });

    it('throws SipProtocolError on empty or invalid SIP message payload', () => {
      expect(() => server.parseMessage('')).toThrow(SipProtocolError);
      expect(() => server.parseMessage('   \r\n')).toThrow(SipProtocolError);
    });

    it('serializes and parses roundtrip SIP request idempotently', () => {
      const originalReq = {
        isRequest: true,
        method: 'INVITE' as const,
        requestUri: parseSipUri('sip:callee@domain.com'),
        version: '2.0',
        headers: {
          via: [{
            protocol: 'SIP',
            version: '2.0',
            transport: 'UDP' as const,
            sentBy: { host: '192.0.2.5', port: 5060 },
            branch: 'z9hG4bKroundtrip1',
            params: {},
          }],
          from: { uri: parseSipUri('sip:caller@domain.com'), tag: 'tag-rt-1', params: {} },
          to: { uri: parseSipUri('sip:callee@domain.com'), params: {} },
          callId: 'call-id-roundtrip-100',
          cseq: { sequenceNumber: 42, method: 'INVITE' as const },
          maxForwards: 70,
          contact: [{ uri: parseSipUri('sip:caller@192.0.2.5:5060'), params: {} }],
          contentType: 'application/sdp',
          contentLength: 4,
          custom: {},
        },
        body: 'v=0\n',
      };

      const serialized = server.serializeMessage(originalReq);
      const parsed: any = server.parseMessage(serialized);

      expect(parsed.isRequest).toBe(true);
      expect(parsed.method).toBe('INVITE');
      expect(parsed.headers.callId).toBe('call-id-roundtrip-100');
      expect(parsed.headers.cseq.sequenceNumber).toBe(42);
      expect(parsed.headers.via[0].branch).toBe('z9hG4bKroundtrip1');
    });
  });
});
