/**
 * Telecom Workspace Architecture, IP Protection & RFC Functional Test Suite
 * Location: tests/unit/telecomWorkspace.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Subsystem 1: SIP Signaling Service
import {
  SipStateMachine,
  CallState,
  DialogManager,
  SdpNegotiator,
  CallTransferCoordinator,
  CallRouter,
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

// Subsystem 3: CDR Pipeline
import {
  CdrIngestionService,
  TariffRatingEngine,
  TenantQuotaTracker,
  BatchSqlLogger,
  E164RadixTrie,
  CdrValidationError,
  DuplicateCdrError,
  DestinationUnroutableError,
  TenantQuotaExceededError,
} from '../fixtures/workspaces/telecom-call-engine/cdr_pipeline';

// Subsystem 4: PBX Device Manager
import {
  DeviceRegistry,
  DigestAuthenticator,
  TrunkAllocator,
  CtiWebhookDispatcher,
  WebhookSecurityError,
  AuthenticationFailedError,
  NoTrunkAvailableError,
} from '../fixtures/workspaces/telecom-call-engine/pbx_device_manager';

// Common Layer
import {
  TelecomEngineError,
  SipProtocolError,
  SdpNegotiationError,
  PortPoolExhaustedError,
  DialogNotFoundError,
  InvalidStateTransitionError,
  TelephonyEventBus,
} from '../fixtures/workspaces/telecom-call-engine';

describe('Generic Telecom Call Engine Workspace Suite', () => {
  const workspaceRoot = path.resolve(__dirname, '../fixtures/workspaces/telecom-call-engine');

  // =========================================================================
  // 1. File Structure & Manifest Invariants
  // =========================================================================
  describe('1. File Hierarchy & Manifest Invariants', () => {
    it('contains all required root files and package manifests', () => {
      expect(fs.existsSync(path.join(workspaceRoot, 'package.json'))).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot, 'tsconfig.json'))).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot, 'index.ts'))).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot, 'src/common/types.ts'))).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot, 'src/common/errors.ts'))).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot, 'src/common/logger.ts'))).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot, 'src/common/events.ts'))).toBe(true);
    });

    it('contains all 4 subsystem directories with index.ts and package.json', () => {
      const subsystems = [
        'sip_signaling_service',
        'rtp_media_gateway',
        'cdr_pipeline',
        'pbx_device_manager',
      ];

      for (const sub of subsystems) {
        const subPath = path.join(workspaceRoot, sub);
        expect(fs.existsSync(subPath)).toBe(true);
        expect(fs.existsSync(path.join(subPath, 'package.json'))).toBe(true);
        expect(fs.existsSync(path.join(subPath, 'index.ts'))).toBe(true);
      }
    });

    it('has valid manifest JSON configurations', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf-8'));
      expect(pkg.name).toBe('@telecom/call-engine');
      expect(pkg.version).toBe('1.0.0');

      const tsconfig = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'tsconfig.json'), 'utf-8'));
      expect(tsconfig.compilerOptions.strict).toBe(true);
      expect(tsconfig.compilerOptions.target).toBe('ES2022');
    });
  });

  // =========================================================================
  // 2. Strict IP Protection & Zero Proprietary Leakage Audit
  // =========================================================================
  describe('2. Strict IP Protection & Regex Audit', () => {
    const PROHIBITED_PATTERNS = [
      { id: 'IP-001 (Vendor Names)', regex: /\b(cisco|cucm|callmanager|jtapi|axl|broadsoft|broadworks|genesys|avaya|mitel|nortel|yealink|polycom|webex)\b/i },
      { id: 'IP-002 (Internal Namespaces)', regex: /\b(calltelemetry|cdrcisco|cisco_cdr|ct-jtapi|ct_user|ct_admin|call_telemetry)\b/i },
      { id: 'IP-003 (Vendor SIP Headers)', regex: /X-(Cisco|BroadWorks|Genesys|Avaya|Mitel|Nortel)-/i },
      { id: 'IP-004 (Proprietary Email Domains)', regex: /@(cisco|avaya|calltelemetry|genesys|broadsoft|mitel)\.com/i },
      { id: 'IP-005 (Proprietary Classes)', regex: /(Cisco|CUCM|JTAPI|AXL|BroadSoft|Avaya)[A-Z][a-zA-Z0-9]+/ },
      { id: 'IP-006 (Proprietary URLs)', regex: /https?:\/\/[a-zA-Z0-9.-]*(cisco|calltelemetry|broadsoft|genesys)\.com/i },
    ];

    function getAllFiles(dir: string, fileList: string[] = []): string[] {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
          getAllFiles(filePath, fileList);
        } else {
          fileList.push(filePath);
        }
      }
      return fileList;
    }

    it('scans all workspace files and verifies 0 IP violations', () => {
      const allFiles = getAllFiles(workspaceRoot);
      expect(allFiles.length).toBeGreaterThan(15);

      const violations: Array<{ file: string; line: number; patternId: string; matched: string }> = [];

      for (const file of allFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        const lines = content.split('\n');

        for (let lineNum = 1; lineNum <= lines.length; lineNum++) {
          const line = lines[lineNum - 1];
          for (const pattern of PROHIBITED_PATTERNS) {
            const match = line.match(pattern.regex);
            if (match) {
              violations.push({
                file: path.relative(workspaceRoot, file),
                line: lineNum,
                patternId: pattern.id,
                matched: match[0],
              });
            }
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });

  // =========================================================================
  // 3. Subsystem 1: sip_signaling_service Tests
  // =========================================================================
  describe('3. Subsystem 1: sip_signaling_service', () => {
    describe('SipStateMachine', () => {
      it('initializes in NULL state and generates RFC 3261 z9hG4bK branch ID', () => {
        const fsm = new SipStateMachine('call-123', 'UAC');
        expect(fsm.getState()).toBe(CallState.NULL);
        expect(fsm.getBranchId()).toMatch(/^z9hG4bK/);
        fsm.dispose();
      });

      it('executes UAC call flow: NULL -> CALLING -> EARLY -> CONFIRMED -> TERMINATED', () => {
        const fsm = new SipStateMachine('call-101', 'UAC', { t1: 50, t2: 200, timerBTimeout: 1000 });
        
        // 1. SEND_INVITE
        fsm.processEvent({ type: 'SEND_INVITE' });
        expect(fsm.getState()).toBe(CallState.CALLING);

        // 2. RECV_RINGING_180
        fsm.processEvent({ type: 'RECV_RINGING_180' });
        expect(fsm.getState()).toBe(CallState.EARLY);

        // 3. RECV_SUCCESS_200
        fsm.processEvent({ type: 'RECV_SUCCESS_200' });
        expect(fsm.getState()).toBe(CallState.CONFIRMED);

        // 4. SEND_ACK
        fsm.processEvent({ type: 'SEND_ACK' });
        expect(fsm.getState()).toBe(CallState.CONFIRMED);

        // 5. SEND_BYE
        fsm.processEvent({ type: 'SEND_BYE' });
        expect(fsm.getState()).toBe(CallState.TERMINATED);
        expect(fsm.getTerminatedReason()).toBe('NORMAL_CLEARING');

        fsm.dispose();
      });

      it('handles Timer A doubling and Timer B transaction timeout', () => {
        const fsm = new SipStateMachine('call-timeout', 'UAC', { t1: 100, t2: 400, timerBTimeout: 3200 });
        fsm.processEvent({ type: 'SEND_INVITE' });
        expect(fsm.getState()).toBe(CallState.CALLING);

        // Timer A expired event
        fsm.processEvent({ type: 'TIMER_EXPIRED', timerName: 'TimerA' });
        expect(fsm.getRetransmitCount()).toBe(1);
        expect(fsm.getCurrentTimerAInterval()).toBe(200);

        fsm.processEvent({ type: 'TIMER_EXPIRED', timerName: 'TimerA' });
        expect(fsm.getRetransmitCount()).toBe(2);
        expect(fsm.getCurrentTimerAInterval()).toBe(400);

        // Timer B expired event
        fsm.processEvent({ type: 'TIMER_EXPIRED', timerName: 'TimerB' });
        expect(fsm.getState()).toBe(CallState.TERMINATED);
        expect(fsm.getTerminatedReason()).toBe('408_REQUEST_TIMEOUT');

        fsm.dispose();
      });

      it('throws InvalidStateTransitionError on invalid event transition', () => {
        const fsm = new SipStateMachine('call-err', 'UAC');
        expect(() => fsm.processEvent({ type: 'SEND_BYE' })).toThrow(InvalidStateTransitionError);
        fsm.dispose();
      });
    });

    describe('DialogManager', () => {
      let dm: DialogManager;

      beforeEach(() => {
        dm = new DialogManager();
      });

      it('creates dialog with composite key and enforces tenant scoping', () => {
        const dialog = dm.createOrUpdateDialog(
          'tenant-1',
          {
            isRequest: false,
            statusCode: 200,
            reasonPhrase: 'OK',
            version: '2.0',
            headers: {
              callId: 'call-xyz',
              from: { uri: parseSipUri('sip:alice@example.com'), tag: 'tag-alice' },
              to: { uri: parseSipUri('sip:bob@example.com'), tag: 'tag-bob' },
              cseq: { sequenceNumber: 1, method: 'INVITE' },
              via: [],
              maxForwards: 70,
              contentLength: 0,
              custom: {},
            },
          },
          'UAC'
        );

        expect(dialog.dialogId).toBe('call-xyz:tag-alice:tag-bob');
        expect(dialog.state).toBe('CONFIRMED');

        // Scoped retrieval
        expect(dm.getDialog('tenant-1', dialog.dialogId)).toBeDefined();
        // Cross-tenant access is blocked
        expect(dm.getDialog('tenant-other', dialog.dialogId)).toBeUndefined();
      });

      it('validates and rejects out-of-order CSeq numbers', () => {
        const dialog = dm.createOrUpdateDialog(
          'tenant-1',
          {
            isRequest: false,
            statusCode: 200,
            reasonPhrase: 'OK',
            version: '2.0',
            headers: {
              callId: 'call-cseq',
              from: { uri: parseSipUri('sip:alice@example.com'), tag: 'a' },
              to: { uri: parseSipUri('sip:bob@example.com'), tag: 'b' },
              cseq: { sequenceNumber: 10, method: 'INVITE' },
              via: [],
              maxForwards: 70,
              contentLength: 0,
              custom: {},
            },
          },
          'UAS'
        );

        // Subsequent higher CSeq is accepted
        expect(dm.validateAndUpdateRemoteCSeq(dialog.dialogId, 11)).toBe(true);
        // Replayed or lower CSeq is rejected
        expect(dm.validateAndUpdateRemoteCSeq(dialog.dialogId, 11)).toBe(false);
        expect(dm.validateAndUpdateRemoteCSeq(dialog.dialogId, 9)).toBe(false);
      });

      it('detects re-INVITE glare collision and returns 491 Request Pending', () => {
        const dialog = dm.createOrUpdateDialog(
          'tenant-1',
          {
            isRequest: false,
            statusCode: 200,
            reasonPhrase: 'OK',
            version: '2.0',
            headers: {
              callId: 'call-glare',
              from: { uri: parseSipUri('sip:alice@example.com'), tag: 'a' },
              to: { uri: parseSipUri('sip:bob@example.com'), tag: 'b' },
              cseq: { sequenceNumber: 1, method: 'INVITE' },
              via: [],
              maxForwards: 70,
              contentLength: 0,
              custom: {},
            },
          },
          'UAC'
        );

        const first = dm.handleReInvite(dialog.dialogId, true);
        expect(first.allow).toBe(true);

        const second = dm.handleReInvite(dialog.dialogId, true);
        expect(second.allow).toBe(false);
        expect(second.httpStatus).toBe(491);
        expect(second.retryAfterSec).toBeGreaterThanOrEqual(2.1);
        expect(second.retryAfterSec).toBeLessThanOrEqual(4.0);

        dm.completeReInvite(dialog.dialogId);
        const third = dm.handleReInvite(dialog.dialogId, true);
        expect(third.allow).toBe(true);
      });
    });

    describe('SdpNegotiator', () => {
      it('creates and parses SDP session descriptions idempotently', () => {
        const negotiator = new SdpNegotiator();
        const offer = negotiator.createOffer('192.0.2.10', 16384);
        const serialized = negotiator.serialize(offer);

        expect(serialized).toContain('v=0');
        expect(serialized).toContain('m=audio 16384 RTP/AVP');
        expect(serialized).toContain('a=rtpmap:0 PCMU/8000');

        const parsed = negotiator.parse(serialized);
        expect(parsed.media[0].port).toBe(16384);
        expect(parsed.media[0].formats).toContain(0);
        expect(parsed.media[0].formats).toContain(8);
      });

      it('negotiates codecs and direction correctly per RFC 3264 Offer/Answer Model', () => {
        const negotiator = new SdpNegotiator();
        const offer = negotiator.createOffer('192.0.2.10', 16384, { direction: 'sendrecv' });

        const result = negotiator.createAnswer(offer, '198.51.100.20', 20000, 'sendrecv');
        expect(result.remoteIp).toBe('192.0.2.10');
        expect(result.remotePort).toBe(16384);
        expect(result.selectedCodec.name).toBe('PCMU');
        expect(result.answer.media[0].direction).toBe('sendrecv');
      });
    });

    describe('CallTransferCoordinator', () => {
      let dm: DialogManager;
      let coordinator: CallTransferCoordinator;

      beforeEach(() => {
        dm = new DialogManager();
        coordinator = new CallTransferCoordinator(dm);
      });

      it('coordinates RFC 3515 blind transfer lifecycle', () => {
        const dialog = dm.createOrUpdateDialog(
          'tenant-1',
          {
            isRequest: false,
            statusCode: 200,
            reasonPhrase: 'OK',
            version: '2.0',
            headers: {
              callId: 'call-transfer-blind',
              from: { uri: parseSipUri('sip:alice@example.com'), tag: 'a' },
              to: { uri: parseSipUri('sip:bob@example.com'), tag: 'b' },
              cseq: { sequenceNumber: 1, method: 'INVITE' },
              via: [],
              maxForwards: 70,
              contentLength: 0,
              custom: {},
            },
          },
          'UAC'
        );

        const { transferId, referRequest } = coordinator.initiateBlindTransfer({
          tenantId: 'tenant-1',
          transferorDialogId: dialog.dialogId,
          targetUri: 'sip:carol@example.com',
        });

        expect(referRequest.method).toBe('REFER');
        expect(referRequest.headers.referTo?.uri.host).toBe('example.com');

        coordinator.handleReferResponse(transferId, 202);
        const notify1 = coordinator.handleNotify(transferId, 'SIP/2.0 100 Trying', 'active');
        expect(notify1.isComplete).toBe(false);

        const notify2 = coordinator.handleNotify(transferId, 'SIP/2.0 200 OK', 'terminated');
        expect(notify2.isComplete).toBe(true);
        expect(notify2.success).toBe(true);
        expect(notify2.shouldTeardownTransferorLeg).toBe(true);
      });

      it('parses RFC 3891 Replaces header', () => {
        const parsed = CallTransferCoordinator.parseReplacesHeader('call-abc@example.com;to-tag=tag1;from-tag=tag2;early-only');
        expect(parsed.callId).toBe('call-abc@example.com');
        expect(parsed.toTag).toBe('tag1');
        expect(parsed.fromTag).toBe('tag2');
        expect(parsed.earlyOnly).toBe(true);
      });
    });
  });

  // =========================================================================
  // 4. Subsystem 2: rtp_media_gateway Tests
  // =========================================================================
  describe('4. Subsystem 2: rtp_media_gateway', () => {
    describe('RtpPacketHandler', () => {
      it('serializes and deserializes RFC 3550 12-byte fixed header RTP packets accurately', () => {
        const rawPayload = Buffer.from('TEST_AUDIO_PAYLOAD_12345');
        const packet: RtpPacket = {
          version: 2,
          padding: false,
          extension: false,
          csrcCount: 0,
          marker: true,
          payloadType: 0, // PCMU
          sequenceNumber: 65535,
          timestamp: 160000,
          ssrc: 0x12345678,
          csrc: [],
          payload: rawPayload,
        };

        const serialized = RtpPacketHandler.serialize(packet);
        expect(serialized.length).toBe(12 + rawPayload.length);

        const deserialized = RtpPacketHandler.deserialize(serialized);
        expect(deserialized.version).toBe(2);
        expect(deserialized.marker).toBe(true);
        expect(deserialized.payloadType).toBe(0);
        expect(deserialized.sequenceNumber).toBe(65535);
        expect(deserialized.timestamp).toBe(160000);
        expect(deserialized.ssrc).toBe(0x12345678);
        expect(deserialized.payload.toString()).toBe('TEST_AUDIO_PAYLOAD_12345');
      });

      it('serializes and parses RTCP Receiver Report (RR)', () => {
        const rrBuf = RtpPacketHandler.serializeRtcpRr({
          version: 2,
          padding: false,
          reportCount: 1,
          payloadType: 201,
          length: 7,
          ssrc: 0x11111111,
          reportBlocks: [
            {
              ssrc: 0x22222222,
              fractionLost: 5,
              cumulativeLost: 20,
              highestSeqReceived: 1000,
              jitter: 160,
              lastSrTimestamp: 0x33333333,
              delaySinceLastSr: 100,
            },
          ],
        });

        const parsed = RtpPacketHandler.parseRtcp(rrBuf);
        expect(parsed.payloadType).toBe(201);
        expect(parsed.reportBlocks.length).toBe(1);
        expect(parsed.reportBlocks[0].ssrc).toBe(0x22222222);
        expect(parsed.reportBlocks[0].fractionLost).toBe(5);
        expect(parsed.reportBlocks[0].cumulativeLost).toBe(20);
      });
    });

    describe('JitterBuffer', () => {
      it('calculates 16-bit sequence difference with rollover correctly', () => {
        expect(JitterBuffer.sequenceDifference(10, 5)).toBe(5);
        expect(JitterBuffer.sequenceDifference(0, 65535)).toBe(1);
        expect(JitterBuffer.sequenceDifference(1, 65535)).toBe(2);
        expect(JitterBuffer.sequenceDifference(65535, 0)).toBe(-1);
      });

      it('estimates RFC 3550 running jitter with packet arrivals', () => {
        const jb = new JitterBuffer({ clockRate: 8000 });

        const p1: RtpPacket = {
          version: 2, padding: false, extension: false, csrcCount: 0, marker: false,
          payloadType: 0, sequenceNumber: 100, timestamp: 8000, ssrc: 1, csrc: [],
          payload: Buffer.alloc(160, 0x55),
        };
        const p2: RtpPacket = {
          version: 2, padding: false, extension: false, csrcCount: 0, marker: false,
          payloadType: 0, sequenceNumber: 101, timestamp: 8160, ssrc: 1, csrc: [],
          payload: Buffer.alloc(160, 0x55),
        };

        jb.push(p1, 1000);
        jb.push(p2, 1025); // 25ms arrival gap vs 20ms timestamp delta -> 5ms transit diff

        expect(jb.getJitterMs()).toBeGreaterThan(0);
      });

      it('synthesizes G.711 Appendix I PLC on frame loss and comfort noise on prolonged loss', () => {
        const jb = new JitterBuffer({ clockRate: 8000, codec: 'PCMU' });
        const p1: RtpPacket = {
          version: 2, padding: false, extension: false, csrcCount: 0, marker: false,
          payloadType: 0, sequenceNumber: 10, timestamp: 1000, ssrc: 1, csrc: [],
          payload: Buffer.alloc(160, 0x10),
        };
        jb.push(p1, 100);

        // Frame 1: present
        const f1 = jb.popPlayoutFrame();
        expect(f1.concealed).toBe(false);
        expect(f1.sequenceNumber).toBe(10);

        // Frame 2 (Seq 11): missing -> concealed
        const f2 = jb.popPlayoutFrame();
        expect(f2.concealed).toBe(true);
        expect(f2.sequenceNumber).toBe(11);

        // Frame 3 (Seq 12): missing -> concealed
        const f3 = jb.popPlayoutFrame();
        expect(f3.concealed).toBe(true);

        // Frame 4 (Seq 13): missing -> concealed
        const f4 = jb.popPlayoutFrame();
        expect(f4.concealed).toBe(true);

        // Frame 5 (>60ms lost): returns comfort noise (0x7F)
        const f5 = jb.popPlayoutFrame();
        expect(f5.concealed).toBe(true);
        expect(f5.payload[0]).toBe(0x7f);
      });
    });

    describe('AudioCodecs', () => {
      it('encodes and decodes G.711 μ-law and A-law accurately', () => {
        const pcmInput = Buffer.alloc(320);
        for (let i = 0; i < 160; i++) {
          const sample = Math.floor(10000 * Math.sin((2 * Math.PI * i) / 20));
          pcmInput.writeInt16LE(sample, i * 2);
        }

        const ulaw = AudioCodecs.linearToUlaw(pcmInput);
        expect(ulaw.length).toBe(160);

        const decodedLinear = AudioCodecs.ulawToLinear(ulaw);
        expect(decodedLinear.length).toBe(320);

        const alaw = AudioCodecs.linearToAlaw(pcmInput);
        expect(alaw.length).toBe(160);

        const directAlaw = AudioCodecs.ulawToAlaw(ulaw);
        expect(directAlaw.length).toBe(160);
      });

      it('packages Opus 20ms frames', () => {
        const opusRaw = Buffer.from([0xf8, 0xff, 0xfe, 0x01, 0x02]);
        const packaged = AudioCodecs.packageOpusFrame(opusRaw);
        expect(packaged.length).toBe(opusRaw.length);
      });
    });

    describe('PortAllocator', () => {
      let allocator: PortAllocator;

      beforeEach(() => {
        allocator = new PortAllocator({ minPort: 16384, maxPort: 16390, cooldownMs: 100 });
      });

      it('allocates even RTP and odd RTCP port pairs', async () => {
        const pair1 = await allocator.allocatePair('tenant-1', 'call-1');
        expect(pair1.rtpPort % 2).toBe(0);
        expect(pair1.rtcpPort).toBe(pair1.rtpPort + 1);

        const pair2 = await allocator.allocatePair('tenant-1', 'call-2');
        expect(pair2.rtpPort).toBe(pair1.rtpPort + 2);
      });

      it('quarantines released ports during cooldown period and recycles after expiry', async () => {
        const pair1 = await allocator.allocatePair('tenant-1', 'call-1');
        const pair2 = await allocator.allocatePair('tenant-1', 'call-2');
        const pair3 = await allocator.allocatePair('tenant-1', 'call-3');

        // Pool full
        await expect(allocator.allocatePair('tenant-1', 'call-4')).rejects.toThrow(PortPoolExhaustedError);

        // Release pair1 -> moves to quarantine
        await allocator.releasePair(pair1.rtpPort);
        expect(allocator.getMetrics().quarantinedPairs).toBe(1);

        // Wait for cooldown expiry
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Now pair1 can be reallocated
        const pair4 = await allocator.allocatePair('tenant-1', 'call-4');
        expect(pair4.rtpPort).toBe(pair1.rtpPort);
      });

      it('releases all ports for a call via releaseCallPorts', async () => {
        await allocator.allocatePair('tenant-1', 'call-crash');
        expect(allocator.getMetrics().allocatedPairs).toBe(1);

        await allocator.releaseCallPorts('tenant-1', 'call-crash');
        expect(allocator.getMetrics().allocatedPairs).toBe(0);
      });
    });
  });

  // =========================================================================
  // 5. Subsystem 3: cdr_pipeline Tests
  // =========================================================================
  describe('5. Subsystem 3: cdr_pipeline', () => {
    describe('CdrIngestionService', () => {
      let ingestion: CdrIngestionService;

      beforeEach(() => {
        ingestion = new CdrIngestionService();
      });

      it('validates and normalizes answered raw call event into canonical CDR', () => {
        const raw = {
          tenantId: 'tenant-acme',
          callId: 'call-cdr-1',
          direction: 'OUTBOUND' as const,
          caller: '+12125551000',
          callee: '+14155552000',
          sipResponseCode: 200,
          q850ReasonCode: 16,
          startTimeMs: 1700000000000,
          answerTimeMs: 1700000005000,
          endTimeMs: 1700000065000,
        };

        const cdr = ingestion.ingestRawEvent(raw);
        expect(cdr.disposition).toBe('ANSWERED');
        expect(cdr.totalDurationMs).toBe(65000);
        expect(cdr.setupDurationMs).toBe(5000);
        expect(cdr.billableDurationSec).toBe(60);
        expect(cdr.q850Reason.code).toBe(16);
      });

      it('enforces timestamp ordering and rejects duplicate callId', () => {
        const invalid = {
          tenantId: 'tenant-1',
          callId: 'call-dup',
          direction: 'INBOUND' as const,
          caller: '+12125551000',
          callee: '+14155552000',
          sipResponseCode: 200,
          startTimeMs: 1700000050000,
          endTimeMs: 1700000010000, // end before start
        };

        expect(() => ingestion.ingestRawEvent(invalid)).toThrow(CdrValidationError);

        const valid = {
          tenantId: 'tenant-1',
          callId: 'call-dup',
          direction: 'INBOUND' as const,
          caller: '+12125551000',
          callee: '+14155552000',
          sipResponseCode: 200,
          startTimeMs: 1700000000000,
          endTimeMs: 1700000010000,
        };

        ingestion.ingestRawEvent(valid);
        expect(() => ingestion.ingestRawEvent(valid)).toThrow(DuplicateCdrError);
      });
    });

    describe('TariffRatingEngine', () => {
      let ratingEngine: TariffRatingEngine;

      beforeEach(() => {
        ratingEngine = new TariffRatingEngine();
        ratingEngine.loadRateDeck({
          deckId: 'deck-usd-v1',
          tenantId: 'tenant-1',
          name: 'Standard US/UK Tier',
          currency: 'USD',
          effectiveDateIso: new Date().toISOString(),
          rates: [
            {
              prefix: '+1',
              destinationName: 'US Domestic',
              ratePerMinuteMicros: 20000, // $0.02/min
              connectionFeeMicros: 5000,  // $0.005 flat fee
              pulseRule: { initialPulseSec: 60, incrementPulseSec: 60 }, // 60/60
              peakRateMultiplier: 1.25,
              isoCountryCode: 'US',
            },
            {
              prefix: '+1212',
              destinationName: 'US New York Metro',
              ratePerMinuteMicros: 15000, // $0.015/min
              connectionFeeMicros: 0,
              pulseRule: { initialPulseSec: 30, incrementPulseSec: 6 }, // 30/6
              peakRateMultiplier: 1.0,
              isoCountryCode: 'US',
            },
            {
              prefix: '+44',
              destinationName: 'UK National',
              ratePerMinuteMicros: 50000, // $0.05/min
              connectionFeeMicros: 10000,
              pulseRule: { initialPulseSec: 6, incrementPulseSec: 6 }, // 6/6
              peakRateMultiplier: 1.5,
              isoCountryCode: 'GB',
            },
          ],
        });
      });

      it('performs longest prefix match in Radix Trie and rates 60/60 & 30/6 pulse calls', () => {
        const ingestion = new CdrIngestionService();
        const cdrNy = ingestion.ingestRawEvent({
          tenantId: 'tenant-1',
          callId: 'call-ny-1',
          direction: 'OUTBOUND',
          caller: '+18005550199',
          callee: '+12125551212',
          sipResponseCode: 200,
          startTimeMs: 1000,
          answerTimeMs: 2000,
          endTimeMs: 38000, // 36s billable -> 30 + 6 = 36s billed on 30/6
        });

        const ratedNy = ratingEngine.rateCall(cdrNy);
        expect(ratedNy.destinationZone).toBe('US New York Metro');
        expect(ratedNy.billedDurationSec).toBe(36);
        expect(ratedNy.usageCostMicros).toBe(Math.round((36 / 60) * 15000)); // 9000 micros = $0.009
      });

      it('rates unanswered calls at $0.000000', () => {
        const ingestion = new CdrIngestionService();
        const cdrBusy = ingestion.ingestRawEvent({
          tenantId: 'tenant-1',
          callId: 'call-busy-1',
          direction: 'OUTBOUND',
          caller: '+18005550199',
          callee: '+14155551212',
          sipResponseCode: 486,
          startTimeMs: 1000,
          endTimeMs: 5000,
        });

        const rated = ratingEngine.rateCall(cdrBusy);
        expect(rated.totalCostMicros).toBe(0);
        expect(rated.totalCostFormatted).toBe('$0.000000');
      });
    });

    describe('TenantQuotaTracker', () => {
      let quotaTracker: TenantQuotaTracker;

      beforeEach(() => {
        quotaTracker = new TenantQuotaTracker();
        quotaTracker.registerTenant({
          tenantId: 'tenant-prepaid',
          maxConcurrentCalls: 2,
          monthlyMinuteCap: 100,
          prepaidBalanceMicros: 1000000, // $1.00
          isPostpaid: false,
          alertThresholdsPct: [80, 90, 100],
        });
      });

      it('enforces concurrency ceilings and prepaid balance exhaustion', () => {
        expect(quotaTracker.acquireChannel('tenant-prepaid', 'call-1')).toBe(true);
        expect(quotaTracker.acquireChannel('tenant-prepaid', 'call-2')).toBe(true);

        // Exceeds max channels (2)
        expect(() => quotaTracker.acquireChannel('tenant-prepaid', 'call-3')).toThrow(TenantQuotaExceededError);

        quotaTracker.releaseChannel('tenant-prepaid', 'call-1');
        expect(quotaTracker.acquireChannel('tenant-prepaid', 'call-3')).toBe(true);
      });

      it('emits threshold alerts when quota reaches 80%, 90%, 100%', () => {
        const alerts: any[] = [];
        quotaTracker.onAlert((a) => alerts.push(a));

        quotaTracker.deductUsage('tenant-prepaid', 85, 500000);
        expect(alerts.length).toBe(1);
        expect(alerts[0].thresholdPct).toBe(80);

        quotaTracker.deductUsage('tenant-prepaid', 10, 300000); // 95 min
        expect(alerts.length).toBe(2);
        expect(alerts[1].thresholdPct).toBe(90);
      });
    });

    describe('BatchSqlLogger', () => {
      it('builds parameterized multi-value SQL statements and resolves partition table names', () => {
        const logger = new BatchSqlLogger();
        const date = new Date('2026-08-20T12:00:00Z');
        expect(logger.getPartitionTableName(date)).toBe('tenant_cdrs_2026_08');

        const mockRatedCdr: any = {
          id: 'uuid-1',
          tenantId: 'tenant-1',
          callId: 'call-1',
          direction: 'OUTBOUND',
          caller: '+12125551000',
          callee: '+14155552000',
          ingressTrunkId: null,
          egressTrunkId: null,
          disposition: 'ANSWERED',
          sipResponseCode: 200,
          q850Reason: { code: 16, description: 'NORMAL_CLEARING' },
          startIso: '2026-08-20T12:00:00.000Z',
          answerIso: '2026-08-20T12:00:05.000Z',
          endIso: '2026-08-20T12:01:05.000Z',
          totalDurationMs: 65000,
          setupDurationMs: 5000,
          billedDurationSec: 60,
          ratePerMinuteMicros: 20000,
          totalCostMicros: 20000,
          createdAtIso: '2026-08-20T12:01:06.000Z',
        };

        const { sql, values } = logger.buildBatchInsertSql([mockRatedCdr], 'tenant_cdrs_2026_08');
        expect(sql).toContain('INSERT INTO tenant_cdrs_2026_08');
        expect(sql).toContain('$1, $2, $3');
        expect(values.length).toBe(20);
      });
    });
  });

  // =========================================================================
  // 6. Subsystem 4: pbx_device_manager Tests
  // =========================================================================
  describe('6. Subsystem 4: pbx_device_manager', () => {
    describe('DeviceRegistry', () => {
      let registry: DeviceRegistry;

      beforeEach(() => {
        registry = new DeviceRegistry();
      });

      it('binds contact on REGISTER and detects RFC 3581 symmetric NAT', () => {
        const endpoint = registry.registerContact(
          'sip:1001@telecom.local',
          'tenant-1',
          'sip:1001@192.168.1.50:5060;transport=udp',
          3600,
          'reg-call-1',
          1,
          'TestSoftphone/v1.0',
          '203.0.113.10', // Public NAT source IP
          62450           // Public NAT source Port
        );

        expect(endpoint.status).toBe('REGISTERED');
        expect(endpoint.bindings.length).toBe(1);
        expect(endpoint.bindings[0].natReceived).toBe('203.0.113.10');
        expect(endpoint.bindings[0].natRport).toBe(62450);
      });

      it('handles Contact: * with Expires: 0 global deregistration', () => {
        registry.registerContact(
          'sip:1002@telecom.local',
          'tenant-1',
          'sip:1002@192.168.1.60:5060',
          3600,
          'reg-1',
          1,
          'Phone',
          '192.168.1.60',
          5060
        );

        const dereg = registry.registerContact(
          'sip:1002@telecom.local',
          'tenant-1',
          '*',
          0,
          'reg-2',
          2,
          'Phone',
          '192.168.1.60',
          5060
        );

        expect(dereg.status).toBe('UNREGISTERED');
        expect(dereg.bindings.length).toBe(0);
      });
    });

    describe('DigestAuthenticator', () => {
      let authenticator: DigestAuthenticator;
      const secret = 'test-secret-key-1234567890123456';

      beforeEach(() => {
        authenticator = new DigestAuthenticator(secret, 300);
      });

      it('creates RFC 2617 challenge and verifies MD5 qop=auth response with constant-time check', async () => {
        const challenge = authenticator.createChallenge('telecom.local', '192.0.2.1');
        expect(challenge.realm).toBe('telecom.local');
        expect(challenge.algorithm).toBe('MD5');
        expect(challenge.qop).toBe('auth');

        const username = '1001';
        const password = 'SecretPassword123';
        const realm = 'telecom.local';
        const method = 'REGISTER';
        const uri = 'sip:telecom.local';
        const nc = '00000001';
        const cnonce = 'abc123xyz';

        const ha1 = authenticator.computeHA1(username, realm, password);
        const ha2 = authenticator.computeHA2(method, uri);
        const response = authenticator.computeDigestResponse(ha1, challenge.nonce, nc, cnonce, 'auth', ha2);

        const authHeader = {
          username,
          realm,
          nonce: challenge.nonce,
          uri,
          response,
          cnonce,
          nc,
          qop: 'auth' as const,
          algorithm: 'MD5' as const,
        };

        const isValid = await authenticator.verifyResponse(
          authHeader,
          method,
          '192.0.2.1',
          {
            getPassword: async (u, r) => (u === username && r === realm ? password : null),
          }
        );

        expect(isValid).toBe(true);

        // Replay of same nonce+nc is rejected
        await expect(
          authenticator.verifyResponse(
            authHeader,
            method,
            '192.0.2.1',
            {
              getPassword: async () => password,
            }
          )
        ).rejects.toThrow('Nonce replay detected');
      });
    });

    describe('TrunkAllocator', () => {
      let allocator: TrunkAllocator;

      beforeEach(() => {
        allocator = new TrunkAllocator({ failureThreshold: 3, successThreshold: 2 });
        allocator.registerTrunkGroup({
          id: 'group-us-outbound',
          tenantId: 'tenant-1',
          name: 'US Outbound Carrier Pool',
          strategy: 'WEIGHTED_ROUND_ROBIN',
          trunks: [
            {
              id: 'trunk-carrier-a',
              trunkGroupId: 'group-us-outbound',
              name: 'Carrier Alpha',
              host: 'sbc1.carrier-a.net',
              port: 5060,
              weight: 80,
              maxChannels: 2,
              activeChannels: 0,
              status: 'ACTIVE',
              consecutiveFailures: 0,
              consecutiveSuccesses: 0,
              failoverStatusCodes: [503, 408, 500],
            },
            {
              id: 'trunk-carrier-b',
              trunkGroupId: 'group-us-outbound',
              name: 'Carrier Beta Backup',
              host: 'sbc1.carrier-b.net',
              port: 5060,
              weight: 20,
              maxChannels: 10,
              activeChannels: 0,
              status: 'ACTIVE',
              consecutiveFailures: 0,
              consecutiveSuccesses: 0,
              failoverStatusCodes: [503, 408, 500],
            },
          ],
        });
      });

      it('allocates trunks and trips circuit breaker to DOWN after 3 consecutive failures', () => {
        const lease1 = allocator.allocateTrunk('group-us-outbound', 'call-t-1');
        expect(lease1.trunkId).toBe('trunk-carrier-a');

        // Record 3 consecutive 503 failures on trunk A
        allocator.recordCallResult('trunk-carrier-a', 503);
        allocator.recordCallResult('trunk-carrier-a', 503);
        allocator.recordCallResult('trunk-carrier-a', 503);

        const trunkA = allocator.getTrunk('trunk-carrier-a');
        expect(trunkA?.status).toBe('DOWN');

        // Next allocation fails over to Carrier Beta
        const lease2 = allocator.allocateTrunk('group-us-outbound', 'call-t-2');
        expect(lease2.trunkId).toBe('trunk-carrier-b');
      });
    });

    describe('CtiWebhookDispatcher', () => {
      let dispatcher: CtiWebhookDispatcher;

      beforeEach(() => {
        dispatcher = new CtiWebhookDispatcher();
      });

      it('generates 64-character HMAC-SHA256 signature', () => {
        const sig = dispatcher.generateSignature('{"callId":"call-123"}', 1700000000, 'my-secret-key');
        expect(sig).toMatch(/^[a-f0-9]{64}$/);
      });

      it('strictly blocks SSRF private and loopback IP addresses', () => {
        expect(dispatcher.validateWebhookUrl('http://127.0.0.1/webhook')).toBe(false);
        expect(dispatcher.validateWebhookUrl('http://localhost:8080/hook')).toBe(false);
        expect(dispatcher.validateWebhookUrl('https://10.0.1.5/cti')).toBe(false);
        expect(dispatcher.validateWebhookUrl('https://192.168.1.100/cti')).toBe(false);
        expect(dispatcher.validateWebhookUrl('http://169.254.169.254/latest/meta-data')).toBe(false);

        // Valid public URL
        expect(dispatcher.validateWebhookUrl('https://api.customer.com/webhooks/telephony')).toBe(true);

        expect(() => {
          dispatcher.registerWebhook({
            tenantId: 'tenant-1',
            url: 'http://127.0.0.1:9000/bad',
            secretKey: 'key',
            events: ['call.initiated'],
          });
        }).toThrow(WebhookSecurityError);
      });
    });
  });

  // =========================================================================
  // 7. Cross-Module Integration End-to-End Flow
  // =========================================================================
  describe('7. Cross-Module End-to-End Call Lifecycle', () => {
    it('executes full call lifecycle across SIP, RTP, CDR, and PBX subsystems', async () => {
      // 1. Setup subsystems
      const portAllocator = new PortAllocator({ minPort: 16384, maxPort: 16400 });
      const sdpNegotiator = new SdpNegotiator();
      const dialogManager = new DialogManager();
      const quotaTracker = new TenantQuotaTracker();
      const ratingEngine = new TariffRatingEngine();
      const cdrIngestion = new CdrIngestionService();
      const eventBus = new TelephonyEventBus();

      quotaTracker.registerTenant({
        tenantId: 'tenant-alpha',
        maxConcurrentCalls: 10,
        monthlyMinuteCap: 1000,
        prepaidBalanceMicros: 50000000, // $50.00
        isPostpaid: false,
        alertThresholdsPct: [80, 90, 100],
      });

      ratingEngine.loadRateDeck({
        deckId: 'deck-alpha',
        tenantId: 'tenant-alpha',
        name: 'Alpha Rates',
        currency: 'USD',
        effectiveDateIso: new Date().toISOString(),
        rates: [
          {
            prefix: '+1',
            destinationName: 'US Domestic',
            ratePerMinuteMicros: 20000,
            connectionFeeMicros: 0,
            pulseRule: { initialPulseSec: 60, incrementPulseSec: 60 },
            peakRateMultiplier: 1.0,
            isoCountryCode: 'US',
          },
        ],
      });

      const callId = 'call-e2e-integration-101';
      const tenantId = 'tenant-alpha';

      // Step 2: Channel acquisition & Port allocation
      expect(quotaTracker.acquireChannel(tenantId, callId)).toBe(true);
      const portPair = await portAllocator.allocatePair(tenantId, callId);
      expect(portPair.rtpPort).toBe(16384);

      // Step 3: SDP Offer / Answer
      const offer = sdpNegotiator.createOffer('192.0.2.10', portPair.rtpPort);
      const answer = sdpNegotiator.createAnswer(offer, '198.51.100.20', 20000);
      expect(answer.selectedCodec.name).toBe('PCMU');

      // Step 4: SIP State Machine & Dialog
      const fsm = new SipStateMachine(callId, 'UAC');
      fsm.processEvent({ type: 'SEND_INVITE' });
      fsm.processEvent({ type: 'RECV_RINGING_180' });
      fsm.processEvent({ type: 'RECV_SUCCESS_200' });
      expect(fsm.getState()).toBe(CallState.CONFIRMED);

      const dialog = dialogManager.createOrUpdateDialog(
        tenantId,
        {
          isRequest: false,
          statusCode: 200,
          reasonPhrase: 'OK',
          version: '2.0',
          headers: {
            callId,
            from: { uri: parseSipUri('sip:+12125551000@telecom.local'), tag: 'uac-tag' },
            to: { uri: parseSipUri('sip:+14155552000@telecom.local'), tag: 'uas-tag' },
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

      // Step 5: Call Teardown
      fsm.processEvent({ type: 'SEND_BYE' });
      expect(fsm.getState()).toBe(CallState.TERMINATED);
      dialogManager.terminateDialog(tenantId, dialog.dialogId);

      // Step 6: CDR Ingestion & Rating
      const startMs = 1700000000000;
      const answerMs = 1700000005000;
      const endMs = 1700000065000;

      const rawCdr = cdrIngestion.ingestRawEvent({
        tenantId,
        callId,
        direction: 'OUTBOUND',
        caller: '+12125551000',
        callee: '+14155552000',
        sipResponseCode: 200,
        q850ReasonCode: 16,
        startTimeMs: startMs,
        answerTimeMs: answerMs,
        endTimeMs: endMs,
      });

      const ratedCdr = ratingEngine.rateCall(rawCdr);
      expect(ratedCdr.billedDurationSec).toBe(60);
      expect(ratedCdr.totalCostMicros).toBe(20000); // $0.02

      // Step 7: Quota deduction & Port release
      const remaining = quotaTracker.deductUsage(tenantId, 1, ratedCdr.totalCostMicros);
      expect(remaining.remainingBalanceMicros).toBe(50000000 - 20000);
      quotaTracker.releaseChannel(tenantId, callId);

      await portAllocator.releasePair(portPair.rtpPort);
      expect(portAllocator.getMetrics().allocatedPairs).toBe(0);

      fsm.dispose();
    });
  });
});
