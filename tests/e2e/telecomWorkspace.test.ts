/**
 * Telecom Workspace End-to-End Test Suite (Tiers 1-4)
 * Location: tests/e2e/telecomWorkspace.test.ts
 *
 * Validates the generic telecom SWE-bench call engine workspace across:
 * - Tier 1: Feature Coverage (Category-Partition: Manifests, IP Protection, SIP, RTP, CDR, PBX)
 * - Tier 2: Boundary & Corner Cases (Boundary Value Analysis: Glare collisions, sequence rollover, quota depletion, replay attacks)
 * - Tier 3: Pairwise Combinatorial & Cross-Feature Interactions (Workspace tool queries, full multi-module call lifecycle)
 * - Tier 4: Real-World Telecom Application Scenarios (Enterprise call flows, attended transfers, trunk bursting, jitter recovery, failover)
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

/**
 * Workspace Tool Executor implementation for E2E tool calling tests.
 */
class WorkspaceToolExecutor {
  constructor(public readonly workspaceRoot: string) {}

  async fileRead(relPath: string): Promise<string> {
    const fullPath = path.resolve(this.workspaceRoot, relPath);
    if (!fullPath.startsWith(this.workspaceRoot)) {
      throw new Error(`Access denied: path traversal out of workspace root: ${relPath}`);
    }
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${relPath}`);
    }
    return fs.readFileSync(fullPath, 'utf8');
  }

  async codeSearch(pattern: string, fileGlob?: string): Promise<Array<{ path: string; line: number; match: string }>> {
    const results: Array<{ path: string; line: number; match: string }> = [];
    const regex = new RegExp(pattern, 'i');

    const scan = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.json') || entry.name.endsWith('.md'))) {
          if (fileGlob && !entry.name.includes(fileGlob.replace('*', ''))) {
            continue;
          }
          const content = fs.readFileSync(full, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push({
                path: path.relative(this.workspaceRoot, full).replace(/\\/g, '/'),
                line: i + 1,
                match: lines[i].trim(),
              });
            }
          }
        }
      }
    };

    scan(this.workspaceRoot);
    return results;
  }

  async symbolLookup(symbolName: string): Promise<Array<{ path: string; line: number; kind: string }>> {
    const results: Array<{ path: string; line: number; kind: string }> = [];
    const symbolRegex = new RegExp(`\\b(class|interface|function|type|enum|const)\\s+${symbolName}\\b`);

    const scan = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const content = fs.readFileSync(full, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(symbolRegex);
            if (m) {
              results.push({
                path: path.relative(this.workspaceRoot, full).replace(/\\/g, '/'),
                line: i + 1,
                kind: m[1],
              });
            }
          }
        }
      }
    };

    scan(this.workspaceRoot);
    return results;
  }
}

describe('Telecom Call Engine Workspace E2E Test Suite (Tiers 1-4)', () => {
  const workspaceRoot = path.resolve(__dirname, '../fixtures/workspaces/telecom-call-engine');
  let toolExecutor: WorkspaceToolExecutor;

  beforeEach(() => {
    toolExecutor = new WorkspaceToolExecutor(workspaceRoot);
  });

  // =========================================================================
  // TIER 1: FEATURE COVERAGE (CATEGORY-PARTITION)
  // =========================================================================
  describe('Tier 1: Feature Coverage (Category-Partition)', () => {
    it('TEST_E2E_WORKSPACE_T1_01 — Root & Subsystem Manifests and TypeScript Integrity', () => {
      expect(fs.existsSync(path.join(workspaceRoot, 'package.json'))).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot, 'tsconfig.json'))).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot, 'index.ts'))).toBe(true);

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

        const subPkg = JSON.parse(fs.readFileSync(path.join(subPath, 'package.json'), 'utf8'));
        expect(subPkg.name).toContain(sub.replace(/_/g, '-'));
      }
    });

    it('TEST_E2E_WORKSPACE_T1_02 — Strict IP Protection Audit (0 Proprietary Reference Invariant)', () => {
      const PROHIBITED_PATTERNS = [
        { id: 'IP-001 (Vendor Names)', regex: /\b(cisco|cucm|callmanager|jtapi|axl|broadsoft|broadworks|genesys|avaya|mitel|nortel|yealink|polycom|webex)\b/i },
        { id: 'IP-002 (Internal Namespaces)', regex: /\b(calltelemetry|cdrcisco|cisco_cdr|ct-jtapi|ct_user|ct_admin|call_telemetry)\b/i },
        { id: 'IP-003 (Vendor SIP Headers)', regex: /X-(Cisco|BroadWorks|Genesys|Avaya|Mitel|Nortel)-/i },
        { id: 'IP-004 (Proprietary Email Domains)', regex: /@(cisco|avaya|calltelemetry|genesys|broadsoft|mitel)\.com/i },
        { id: 'IP-005 (Proprietary Classes)', regex: /(Cisco|CUCM|JTAPI|AXL|BroadSoft|Avaya)[A-Z][a-zA-Z0-9]+/ },
        { id: 'IP-006 (Proprietary URLs)', regex: /https?:\/\/[a-zA-Z0-9.-]*(cisco|calltelemetry|broadsoft|genesys)\.com/i },
      ];

      const scanDir = (dir: string, fileList: string[] = []): string[] => {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const full = path.join(dir, file);
          if (fs.statSync(full).isDirectory()) {
            scanDir(full, fileList);
          } else {
            fileList.push(full);
          }
        }
        return fileList;
      };

      const allFiles = scanDir(workspaceRoot);
      expect(allFiles.length).toBeGreaterThan(15);

      const violations: Array<{ file: string; line: number; patternId: string; matched: string }> = [];

      for (const file of allFiles) {
        const content = fs.readFileSync(file, 'utf8');
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

    it('TEST_E2E_WORKSPACE_T1_03 — Subsystem 1: RFC 3261 SIP State Machine, Dialog & SDP Offer/Answer', () => {
      const fsm = new SipStateMachine('call-t1-03', 'UAC');
      expect(fsm.getState()).toBe(CallState.NULL);
      expect(fsm.getBranchId()).toMatch(/^z9hG4bK/);

      fsm.processEvent({ type: 'SEND_INVITE' });
      expect(fsm.getState()).toBe(CallState.CALLING);

      fsm.processEvent({ type: 'RECV_RINGING_180' });
      expect(fsm.getState()).toBe(CallState.EARLY);

      fsm.processEvent({ type: 'RECV_SUCCESS_200' });
      expect(fsm.getState()).toBe(CallState.CONFIRMED);

      fsm.processEvent({ type: 'SEND_ACK' });
      expect(fsm.getState()).toBe(CallState.CONFIRMED);

      fsm.processEvent({ type: 'SEND_BYE' });
      expect(fsm.getState()).toBe(CallState.TERMINATED);
      fsm.dispose();

      // SDP Offer / Answer
      const negotiator = new SdpNegotiator();
      const offer = negotiator.createOffer('192.0.2.1', 16384, { direction: 'sendrecv' });
      const answer = negotiator.createAnswer(offer, '198.51.100.1', 20000, 'sendrecv');
      expect(answer.selectedCodec.name).toBe('PCMU');
      expect(answer.remotePort).toBe(16384);
    });

    it('TEST_E2E_WORKSPACE_T1_04 — Subsystem 2: RFC 3550 RTP/RTCP Gateway, Codecs & Port Allocator', async () => {
      const allocator = new PortAllocator({ minPort: 16384, maxPort: 16390, cooldownMs: 50 });
      const pair = await allocator.allocatePair('tenant-1', 'call-rtp-1');
      expect(pair.rtpPort % 2).toBe(0);
      expect(pair.rtcpPort).toBe(pair.rtpPort + 1);

      const rawPayload = Buffer.from('TELECOM_RTP_AUDIO_TEST_PAYLOAD');
      const packet: RtpPacket = {
        version: 2,
        padding: false,
        extension: false,
        csrcCount: 0,
        marker: true,
        payloadType: 0, // PCMU
        sequenceNumber: 1000,
        timestamp: 160000,
        ssrc: 0xabcdef12,
        csrc: [],
        payload: rawPayload,
      };

      const serialized = RtpPacketHandler.serialize(packet);
      const deserialized = RtpPacketHandler.deserialize(serialized);
      expect(deserialized.ssrc).toBe(0xabcdef12);
      expect(deserialized.payload.toString()).toBe('TELECOM_RTP_AUDIO_TEST_PAYLOAD');

      // Audio Transcoding
      const pcm = Buffer.alloc(320);
      const ulaw = AudioCodecs.linearToUlaw(pcm);
      expect(ulaw.length).toBe(160);
      const decodedPcm = AudioCodecs.ulawToLinear(ulaw);
      expect(decodedPcm.length).toBe(320);

      await allocator.releasePair(pair.rtpPort);
    });

    it('TEST_E2E_WORKSPACE_T1_05 — Subsystem 3: CDR Ingestion, E.164 Radix Trie Rating & Quota', () => {
      const ingestion = new CdrIngestionService();
      const ratingEngine = new TariffRatingEngine();
      const quotaTracker = new TenantQuotaTracker();

      quotaTracker.registerTenant({
        tenantId: 'tenant-cdr-t1',
        maxConcurrentCalls: 5,
        monthlyMinuteCap: 1000,
        prepaidBalanceMicros: 5000000, // $5.00
        isPostpaid: false,
        alertThresholdsPct: [80, 90, 100],
      });

      ratingEngine.loadRateDeck({
        deckId: 'deck-e2e-1',
        tenantId: 'tenant-cdr-t1',
        name: 'Standard US Plan',
        currency: 'USD',
        effectiveDateIso: new Date().toISOString(),
        rates: [
          {
            prefix: '+1',
            destinationName: 'US Domestic',
            ratePerMinuteMicros: 20000, // $0.02/min
            connectionFeeMicros: 5000,
            pulseRule: { initialPulseSec: 60, incrementPulseSec: 60 },
            peakRateMultiplier: 1.0,
            isoCountryCode: 'US',
          },
        ],
      });

      const raw = {
        tenantId: 'tenant-cdr-t1',
        callId: 'call-cdr-e2e-1',
        direction: 'OUTBOUND' as const,
        caller: '+12125550100',
        callee: '+14155550200',
        sipResponseCode: 200,
        startTimeMs: 1700000000000,
        answerTimeMs: 1700000002000,
        endTimeMs: 1700000062000, // 60s billable
      };

      const cdr = ingestion.ingestRawEvent(raw);
      expect(cdr.billableDurationSec).toBe(60);

      const rated = ratingEngine.rateCall(cdr);
      expect(rated.destinationZone).toBe('US Domestic');
      expect(rated.totalCostMicros).toBe(25000); // $0.025 (20000 rate + 5000 fee)

      const deducted = quotaTracker.deductUsage('tenant-cdr-t1', 1, rated.totalCostMicros);
      expect(deducted.remainingBalanceMicros).toBe(4975000);
    });

    it('TEST_E2E_WORKSPACE_T1_06 — Subsystem 4: PBX Device Registry, Digest Auth & CTI Webhooks', async () => {
      const registry = new DeviceRegistry({ defaultExpiresSec: 3600 });
      const auth = new DigestAuthenticator('test-secret-key-123', 300);
      const dispatcher = new CtiWebhookDispatcher();

      // 1. Device Registration via registerContact
      const endpoint = registry.registerContact(
        'sip:1001@pbx.example.com',
        'tenant-pbx-1',
        'sip:1001@192.0.2.50:5060',
        3600,
        'reg-call-1',
        1,
        'GenericPBX/1.0',
        '192.0.2.50',
        5060
      );
      expect(endpoint.status).toBe('REGISTERED');
      expect(endpoint.bindings.length).toBe(1);

      // 2. Digest Authentication Challenge & Verification
      const challenge = auth.createChallenge('pbx.example.com', '192.0.2.50');
      expect(challenge.realm).toBe('pbx.example.com');
      expect(challenge.nonce).toBeDefined();

      const ha1 = auth.computeHA1('1001', 'pbx.example.com', 'secretPassword123');
      const ha2 = auth.computeHA2('REGISTER', 'sip:pbx.example.com');
      const response = auth.computeDigestResponse(ha1, challenge.nonce, '00000001', 'cnonce123', 'auth', ha2);

      const isValid = await auth.verifyResponse(
        {
          username: '1001',
          realm: 'pbx.example.com',
          nonce: challenge.nonce,
          uri: 'sip:pbx.example.com',
          response,
          nc: '00000001',
          cnonce: 'cnonce123',
          qop: 'auth',
          algorithm: 'MD5',
        },
        'REGISTER',
        '192.0.2.50',
        {
          getPassword: async (u, r) => (u === '1001' && r === 'pbx.example.com' ? 'secretPassword123' : null),
        }
      );
      expect(isValid).toBe(true);

      // 3. CTI Webhook Signature Generation & Verification
      const sig = dispatcher.generateSignature('{"event":"call.initiated"}', 1700000000, 'test-secret-key-123');
      expect(sig).toMatch(/^[a-f0-9]{64}$/);
      expect(dispatcher.validateWebhookUrl('https://api.example.com/webhook')).toBe(true);
    });
  });

  // =========================================================================
  // TIER 2: BOUNDARY VALUE ANALYSIS & CORNER CASES
  // =========================================================================
  describe('Tier 2: Boundary Value Analysis & Corner Cases', () => {
    it('TEST_E2E_WORKSPACE_T2_01 — Re-INVITE Glare Collision (491 Request Pending)', () => {
      const dm = new DialogManager();
      const dialog = dm.createOrUpdateDialog(
        'tenant-glare',
        {
          isRequest: false,
          statusCode: 200,
          reasonPhrase: 'OK',
          version: '2.0',
          headers: {
            callId: 'call-glare-e2e',
            from: { uri: parseSipUri('sip:alice@example.com'), tag: 'tag-a', params: {} },
            to: { uri: parseSipUri('sip:bob@example.com'), tag: 'tag-b', params: {} },
            cseq: { sequenceNumber: 1, method: 'INVITE' },
            via: [],
            maxForwards: 70,
            contentLength: 0,
            custom: {},
          },
        },
        'UAC'
      );

      // First re-INVITE initiated
      const first = dm.handleReInvite(dialog.dialogId, true);
      expect(first.allow).toBe(true);

      // Glare: Simultaneous re-INVITE while previous is unresolved
      const glare = dm.handleReInvite(dialog.dialogId, true);
      expect(glare.allow).toBe(false);
      expect(glare.httpStatus).toBe(491);
      expect(glare.retryAfterSec).toBeGreaterThanOrEqual(2.1);
      expect(glare.retryAfterSec).toBeLessThanOrEqual(4.0);

      // Complete first re-INVITE
      dm.completeReInvite(dialog.dialogId);
      const afterResolution = dm.handleReInvite(dialog.dialogId, true);
      expect(afterResolution.allow).toBe(true);
    });

    it('TEST_E2E_WORKSPACE_T2_02 — SIP Transaction Timeout (Timer B 64*T1 -> 408 Timeout)', () => {
      const fsm = new SipStateMachine('call-timeout-e2e', 'UAC', { t1: 50, t2: 200, timerBTimeout: 3200 });
      fsm.processEvent({ type: 'SEND_INVITE' });
      expect(fsm.getState()).toBe(CallState.CALLING);

      fsm.processEvent({ type: 'TIMER_EXPIRED', timerName: 'TimerB' });
      expect(fsm.getState()).toBe(CallState.TERMINATED);
      expect(fsm.getTerminatedReason()).toBe('408_REQUEST_TIMEOUT');
      fsm.dispose();
    });

    it('TEST_E2E_WORKSPACE_T2_03 — 16-Bit RTP Sequence Rollover & Out-of-Order Recovery', () => {
      expect(JitterBuffer.sequenceDifference(0, 65535)).toBe(1);
      expect(JitterBuffer.sequenceDifference(1, 65535)).toBe(2);
      expect(JitterBuffer.sequenceDifference(65535, 0)).toBe(-1);
      expect(JitterBuffer.sequenceDifference(10, 5)).toBe(5);

      const jb = new JitterBuffer({ clockRate: 8000, codec: 'PCMU' });
      const p1: RtpPacket = {
        version: 2, padding: false, extension: false, csrcCount: 0, marker: false,
        payloadType: 0, sequenceNumber: 65535, timestamp: 8000, ssrc: 1, csrc: [],
        payload: Buffer.alloc(160, 0x11),
      };
      const p2: RtpPacket = {
        version: 2, padding: false, extension: false, csrcCount: 0, marker: false,
        payloadType: 0, sequenceNumber: 0, timestamp: 8160, ssrc: 1, csrc: [],
        payload: Buffer.alloc(160, 0x22),
      };

      jb.push(p1, 1000);
      jb.push(p2, 1020);

      const f1 = jb.popPlayoutFrame();
      expect(f1.sequenceNumber).toBe(65535);
      expect(f1.concealed).toBe(false);

      const f2 = jb.popPlayoutFrame();
      expect(f2.sequenceNumber).toBe(0);
      expect(f2.concealed).toBe(false);
    });

    it('TEST_E2E_WORKSPACE_T2_04 — Prolonged Packet Loss Comfort Noise Synthesis (0x7F)', () => {
      const jb = new JitterBuffer({ clockRate: 8000, codec: 'PCMU' });
      const p1: RtpPacket = {
        version: 2, padding: false, extension: false, csrcCount: 0, marker: false,
        payloadType: 0, sequenceNumber: 100, timestamp: 1000, ssrc: 1, csrc: [],
        payload: Buffer.alloc(160, 0x33),
      };
      jb.push(p1, 100);

      // Frame 1: present
      const f1 = jb.popPlayoutFrame();
      expect(f1.concealed).toBe(false);

      // Frames 2, 3, 4: simulated loss -> PLC interpolation
      const f2 = jb.popPlayoutFrame();
      expect(f2.concealed).toBe(true);
      const f3 = jb.popPlayoutFrame();
      expect(f3.concealed).toBe(true);
      const f4 = jb.popPlayoutFrame();
      expect(f4.concealed).toBe(true);

      // Frame 5 (>60ms consecutive loss) -> Comfort noise 0x7F
      const f5 = jb.popPlayoutFrame();
      expect(f5.concealed).toBe(true);
      expect(f5.payload[0]).toBe(0x7f);
    });

    it('TEST_E2E_WORKSPACE_T2_05 — Port Allocator Pool Exhaustion & Double-Release Safety', async () => {
      const allocator = new PortAllocator({ minPort: 20000, maxPort: 20004, cooldownMs: 1000 });
      const p1 = await allocator.allocatePair('tenant-t2', 'call-p1'); // 20000, 20001
      const p2 = await allocator.allocatePair('tenant-t2', 'call-p2'); // 20002, 20003

      // Pool exhausted
      await expect(allocator.allocatePair('tenant-t2', 'call-p3')).rejects.toThrow(PortPoolExhaustedError);

      // Double release should be idempotent without throw
      await allocator.releasePair(p1.rtpPort);
      await allocator.releasePair(p1.rtpPort);
      expect(allocator.getMetrics().quarantinedPairs).toBe(1);
    });

    it('TEST_E2E_WORKSPACE_T2_06 — CDR Inverted Timestamp & Duplicate Ingestion Protection', () => {
      const ingestion = new CdrIngestionService();

      const inverted = {
        tenantId: 'tenant-1',
        callId: 'call-inv-1',
        direction: 'INBOUND' as const,
        caller: '+12125551000',
        callee: '+14155552000',
        sipResponseCode: 200,
        startTimeMs: 1700000050000,
        endTimeMs: 1700000010000, // end before start
      };
      expect(() => ingestion.ingestRawEvent(inverted)).toThrow(CdrValidationError);

      const valid = {
        tenantId: 'tenant-1',
        callId: 'call-unique-1',
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

    it('TEST_E2E_WORKSPACE_T2_07 — Tariff Rating Unroutable Prefix & Zero-Cost Non-Connected Calls', () => {
      const ratingEngine = new TariffRatingEngine();
      ratingEngine.loadRateDeck({
        deckId: 'deck-us-only',
        tenantId: 'tenant-1',
        name: 'US Only Plan',
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

      const ingestion = new CdrIngestionService();

      // Unroutable destination (e.g. +81 Tokyo)
      const foreignCdr = ingestion.ingestRawEvent({
        tenantId: 'tenant-1',
        callId: 'call-foreign-1',
        direction: 'OUTBOUND',
        caller: '+12125550100',
        callee: '+81355550100',
        sipResponseCode: 200,
        startTimeMs: 1000,
        answerTimeMs: 2000,
        endTimeMs: 30000,
      });
      expect(() => ratingEngine.rateCall(foreignCdr)).toThrow(DestinationUnroutableError);

      // Non-connected call (e.g. 486 Busy) rated at $0.00
      const busyCdr = ingestion.ingestRawEvent({
        tenantId: 'tenant-1',
        callId: 'call-busy-2',
        direction: 'OUTBOUND',
        caller: '+12125550100',
        callee: '+12125550200',
        sipResponseCode: 486,
        startTimeMs: 1000,
        endTimeMs: 3000,
      });
      const busyRated = ratingEngine.rateCall(busyCdr);
      expect(busyRated.totalCostMicros).toBe(0);
      expect(busyRated.totalCostFormatted).toBe('$0.000000');
    });

    it('TEST_E2E_WORKSPACE_T2_08 — Digest Auth Nonce Replay Attack Defense', async () => {
      const auth = new DigestAuthenticator('test-secret', 300);
      const challenge = auth.createChallenge('pbx.example.com', '192.0.2.1');

      const ha1 = auth.computeHA1('1001', 'pbx.example.com', 'password123');
      const ha2 = auth.computeHA2('INVITE', 'sip:1002@pbx.example.com');
      const response = auth.computeDigestResponse(ha1, challenge.nonce, '00000001', 'cnonce1', 'auth', ha2);

      const authHeader = {
        username: '1001',
        realm: 'pbx.example.com',
        nonce: challenge.nonce,
        uri: 'sip:1002@pbx.example.com',
        response,
        nc: '00000001',
        cnonce: 'cnonce1',
        qop: 'auth' as const,
        algorithm: 'MD5' as const,
      };

      // Valid first authentication
      const valid = await auth.verifyResponse(authHeader, 'INVITE', '192.0.2.1', {
        getPassword: async () => 'password123',
      });
      expect(valid).toBe(true);

      // Replay of same nonce + nc is rejected
      await expect(
        auth.verifyResponse(authHeader, 'INVITE', '192.0.2.1', {
          getPassword: async () => 'password123',
        })
      ).rejects.toThrow('Nonce replay detected');
    });

    it('TEST_E2E_WORKSPACE_T2_09 — CTI Webhook SSRF IP Blocking', () => {
      const dispatcher = new CtiWebhookDispatcher();

      // Loopback / Private / Cloud metadata
      expect(dispatcher.validateWebhookUrl('http://127.0.0.1/webhook')).toBe(false);
      expect(dispatcher.validateWebhookUrl('http://localhost:8080/hook')).toBe(false);
      expect(dispatcher.validateWebhookUrl('https://10.0.1.5/cti')).toBe(false);
      expect(dispatcher.validateWebhookUrl('https://192.168.1.100/cti')).toBe(false);
      expect(dispatcher.validateWebhookUrl('http://169.254.169.254/latest/meta-data')).toBe(false);

      // Public HTTPS
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

    it('TEST_E2E_WORKSPACE_T2_10 — Tenant Prepaid Balance Exact Zero Boundary & Overdraft Prevention', () => {
      const quota = new TenantQuotaTracker();
      quota.registerTenant({
        tenantId: 'tenant-prepaid-boundary',
        maxConcurrentCalls: 10,
        monthlyMinuteCap: 1000,
        prepaidBalanceMicros: 20000, // Exactly $0.02
        isPostpaid: false,
        alertThresholdsPct: [80, 90, 100],
      });

      // Deduct exact balance ($0.02)
      const res1 = quota.deductUsage('tenant-prepaid-boundary', 1, 20000);
      expect(res1.remainingBalanceMicros).toBe(0);

      // Additional call acquisition when balance is $0.00 throws TenantQuotaExceededError
      expect(() => quota.acquireChannel('tenant-prepaid-boundary', 'call-overdraft')).toThrow(TenantQuotaExceededError);
    });
  });

  // =========================================================================
  // TIER 3: PAIRWISE COMBINATORIAL & CROSS-FEATURE INTERACTIONS
  // =========================================================================
  describe('Tier 3: Pairwise Combinatorial & Cross-Feature Interactions', () => {
    it('TEST_E2E_WORKSPACE_T3_01 — Multi-Turn Workspace Tool Queries Across All 4 Subsystems', async () => {
      // 1. Tool: symbol_lookup for SipStateMachine
      const sipSymbols = await toolExecutor.symbolLookup('SipStateMachine');
      expect(sipSymbols.length).toBeGreaterThan(0);
      expect(sipSymbols[0].path).toContain('sip_signaling_service');

      // 2. Tool: file_read of discovered file
      const sipCode = await toolExecutor.fileRead(sipSymbols[0].path);
      expect(sipCode).toContain('export class SipStateMachine');
      expect(sipCode).toContain('z9hG4bK');

      // 3. Tool: code_search across RTP media gateway
      const rtpSearch = await toolExecutor.codeSearch('PortAllocator');
      expect(rtpSearch.length).toBeGreaterThan(0);
      expect(rtpSearch.some((r) => r.path.includes('rtp_media_gateway'))).toBe(true);

      // 4. Tool: symbol_lookup across CDR pipeline
      const cdrSymbols = await toolExecutor.symbolLookup('TariffRatingEngine');
      expect(cdrSymbols.length).toBeGreaterThan(0);
      expect(cdrSymbols[0].path).toContain('cdr_pipeline');

      // 5. Tool: symbol_lookup across PBX device manager
      const pbxSymbols = await toolExecutor.symbolLookup('DigestAuthenticator');
      expect(pbxSymbols.length).toBeGreaterThan(0);
      expect(pbxSymbols[0].path).toContain('pbx_device_manager');
    });

    it('TEST_E2E_WORKSPACE_T3_02 — End-to-End Multi-Subsystem Outbound Call Lifecycle', async () => {
      const dm = new DialogManager();
      const sdp = new SdpNegotiator();
      const allocator = new PortAllocator({ minPort: 16384, maxPort: 16400, cooldownMs: 50 });
      const ingestion = new CdrIngestionService();
      const ratingEngine = new TariffRatingEngine();
      const quota = new TenantQuotaTracker();
      const dispatcher = new CtiWebhookDispatcher();

      // Step 1: Register Tenant & Rate Deck
      quota.registerTenant({
        tenantId: 'tenant-full-cycle',
        maxConcurrentCalls: 10,
        monthlyMinuteCap: 500,
        prepaidBalanceMicros: 10000000, // $10.00
        isPostpaid: false,
        alertThresholdsPct: [80, 90, 100],
      });

      ratingEngine.loadRateDeck({
        deckId: 'deck-full-cycle',
        tenantId: 'tenant-full-cycle',
        name: 'Standard US',
        currency: 'USD',
        effectiveDateIso: new Date().toISOString(),
        rates: [
          {
            prefix: '+1',
            destinationName: 'US Domestic',
            ratePerMinuteMicros: 12000, // $0.012/min
            connectionFeeMicros: 3000,  // $0.003
            pulseRule: { initialPulseSec: 60, incrementPulseSec: 60 },
            peakRateMultiplier: 1.0,
            isoCountryCode: 'US',
          },
        ],
      });

      // Step 2: Channel Acquisition & Port Allocation
      expect(quota.acquireChannel('tenant-full-cycle', 'call-fc-1')).toBe(true);
      const portPair = await allocator.allocatePair('tenant-full-cycle', 'call-fc-1');
      expect(portPair.rtpPort).toBeGreaterThanOrEqual(16384);

      // Step 3: SIP Signaling & SDP Negotiation
      const offer = sdp.createOffer('192.0.2.10', portPair.rtpPort);
      const answer = sdp.createAnswer(offer, '198.51.100.20', 20000);
      expect(answer.selectedCodec.name).toBe('PCMU');

      const dialog = dm.createOrUpdateDialog(
        'tenant-full-cycle',
        {
          isRequest: false,
          statusCode: 200,
          reasonPhrase: 'OK',
          version: '2.0',
          headers: {
            callId: 'call-fc-1',
            from: { uri: parseSipUri('sip:1001@example.com'), tag: 'tag-from', params: {} },
            to: { uri: parseSipUri('sip:1002@example.com'), tag: 'tag-to', params: {} },
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

      // Step 4: Media Streaming Simulation (10 packets)
      const jb = new JitterBuffer({ clockRate: 8000, codec: 'PCMU' });
      for (let seq = 1; seq <= 10; seq++) {
        const p: RtpPacket = {
          version: 2, padding: false, extension: false, csrcCount: 0, marker: seq === 1,
          payloadType: 0, sequenceNumber: seq, timestamp: seq * 160, ssrc: 0x99, csrc: [],
          payload: Buffer.alloc(160, 0x55),
        };
        jb.push(p, 1000 + seq * 20);
      }

      // Pop frames from jitter buffer
      const f1 = jb.popPlayoutFrame();
      expect(f1.sequenceNumber).toBe(1);
      expect(f1.concealed).toBe(false);

      // Step 5: Teardown, Port Release, Quota Channel Release
      await allocator.releasePair(portPair.rtpPort);
      quota.releaseChannel('tenant-full-cycle', 'call-fc-1');
      dm.terminateDialog('tenant-full-cycle', dialog.dialogId);

      // Step 6: CDR Ingestion & Rating
      const cdr = ingestion.ingestRawEvent({
        tenantId: 'tenant-full-cycle',
        callId: 'call-fc-1',
        direction: 'OUTBOUND',
        caller: '+12125550100',
        callee: '+14155550200',
        sipResponseCode: 200,
        startTimeMs: 1700000000000,
        answerTimeMs: 1700000002000,
        endTimeMs: 1700000062000, // 60s
      });
      const rated = ratingEngine.rateCall(cdr);
      expect(rated.totalCostMicros).toBe(15000); // 12000 usage + 3000 fee

      // Step 7: Balance Deduction & Webhook Dispatch Signature
      const deduction = quota.deductUsage('tenant-full-cycle', 1, rated.totalCostMicros);
      expect(deduction.remainingBalanceMicros).toBe(9985000);

      const sig = dispatcher.generateSignature(
        JSON.stringify({ callId: 'call-fc-1', cost: rated.totalCostFormatted }),
        1700000000,
        'secret-key'
      );
      expect(sig).toMatch(/^[a-f0-9]{64}$/);
    });

    it('TEST_E2E_WORKSPACE_T3_03 — High-Concurrency Multi-Tenant Parallel Processing', async () => {
      const allocator = new PortAllocator({ minPort: 10000, maxPort: 10200, cooldownMs: 10 });
      const ingestion = new CdrIngestionService();
      const quota = new TenantQuotaTracker();

      quota.registerTenant({
        tenantId: 'tenant-conc-A',
        maxConcurrentCalls: 30,
        monthlyMinuteCap: 10000,
        prepaidBalanceMicros: 100000000,
        isPostpaid: true,
        alertThresholdsPct: [80, 90, 100],
      });
      quota.registerTenant({
        tenantId: 'tenant-conc-B',
        maxConcurrentCalls: 30,
        monthlyMinuteCap: 10000,
        prepaidBalanceMicros: 100000000,
        isPostpaid: true,
        alertThresholdsPct: [80, 90, 100],
      });

      const concurrentCalls = 40;
      const promises: Promise<void>[] = [];

      for (let i = 0; i < concurrentCalls; i++) {
        const tenantId = i % 2 === 0 ? 'tenant-conc-A' : 'tenant-conc-B';
        const callId = `call-conc-${i}`;

        promises.push(
          (async () => {
            quota.acquireChannel(tenantId, callId);
            const pair = await allocator.allocatePair(tenantId, callId);
            expect(pair.rtpPort).toBeGreaterThanOrEqual(10000);

            // Ingest CDR
            ingestion.ingestRawEvent({
              tenantId,
              callId,
              direction: 'OUTBOUND',
              caller: `+121255501${i.toString().padStart(2, '0')}`,
              callee: `+141555502${i.toString().padStart(2, '0')}`,
              sipResponseCode: 200,
              startTimeMs: 1000,
              answerTimeMs: 2000,
              endTimeMs: 32000,
            });

            await allocator.releasePair(pair.rtpPort);
            quota.releaseChannel(tenantId, callId);
          })()
        );
      }

      await Promise.all(promises);
      expect(allocator.getMetrics().allocatedPairs).toBe(0);
    });

    it('TEST_E2E_WORKSPACE_T3_04 — RFC 3515 Blind Transfer Execution with Downstream Teardown', () => {
      const dm = new DialogManager();
      const coordinator = new CallTransferCoordinator(dm);

      const dialog = dm.createOrUpdateDialog(
        'tenant-t3-xfer',
        {
          isRequest: false,
          statusCode: 200,
          reasonPhrase: 'OK',
          version: '2.0',
          headers: {
            callId: 'call-blind-xfer-leg1',
            from: { uri: parseSipUri('sip:alice@example.com'), tag: 'tag-alice', params: {} },
            to: { uri: parseSipUri('sip:bob@example.com'), tag: 'tag-bob', params: {} },
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
        tenantId: 'tenant-t3-xfer',
        transferorDialogId: dialog.dialogId,
        targetUri: 'sip:carol@example.com',
      });

      expect(referRequest.method).toBe('REFER');
      expect(referRequest.headers.referTo?.uri.user).toBe('carol');

      coordinator.handleReferResponse(transferId, 202); // Accepted
      const notifyProgress = coordinator.handleNotify(transferId, 'SIP/2.0 180 Ringing', 'active');
      expect(notifyProgress.isComplete).toBe(false);

      const notifySuccess = coordinator.handleNotify(transferId, 'SIP/2.0 200 OK', 'terminated');
      expect(notifySuccess.isComplete).toBe(true);
      expect(notifySuccess.success).toBe(true);
      expect(notifySuccess.shouldTeardownTransferorLeg).toBe(true);
    });
  });

  // =========================================================================
  // TIER 4: REAL-WORLD APPLICATION SCENARIOS
  // =========================================================================
  describe('Tier 4: Real-World Application Workloads', () => {
    it('WORKFLOW_E2E_4.1 — Enterprise PBX Outbound Call with E.164 Tariff Rating & CTI Webhook Delivery', async () => {
      const dm = new DialogManager();
      const sdp = new SdpNegotiator();
      const allocator = new PortAllocator({ minPort: 16384, maxPort: 16400 });
      const ingestion = new CdrIngestionService();
      const ratingEngine = new TariffRatingEngine();
      const quota = new TenantQuotaTracker();
      const dispatcher = new CtiWebhookDispatcher();

      quota.registerTenant({
        tenantId: 'tenant-enterprise-hq',
        maxConcurrentCalls: 50,
        monthlyMinuteCap: 50000,
        prepaidBalanceMicros: 500000000, // $500.00
        isPostpaid: true,
        alertThresholdsPct: [80, 90, 100],
      });

      ratingEngine.loadRateDeck({
        deckId: 'deck-enterprise',
        tenantId: 'tenant-enterprise-hq',
        name: 'Enterprise Global Rate Plan',
        currency: 'USD',
        effectiveDateIso: new Date().toISOString(),
        rates: [
          {
            prefix: '+1',
            destinationName: 'North America Toll Free',
            ratePerMinuteMicros: 5000, // $0.005/min
            connectionFeeMicros: 0,
            pulseRule: { initialPulseSec: 6, incrementPulseSec: 6 },
            peakRateMultiplier: 1.0,
            isoCountryCode: 'US',
          },
        ],
      });

      // 1. Reserve channel & allocate RTP media port pair
      quota.acquireChannel('tenant-enterprise-hq', 'call-ent-101');
      const ports = await allocator.allocatePair('tenant-enterprise-hq', 'call-ent-101');

      // 2. Negotiate SDP
      const offer = sdp.createOffer('192.0.2.10', ports.rtpPort);
      const answer = sdp.createAnswer(offer, '198.51.100.20', 25000);
      expect(answer.selectedCodec.name).toBe('PCMU');

      // 3. Confirm Dialog
      const dialog = dm.createOrUpdateDialog(
        'tenant-enterprise-hq',
        {
          isRequest: false,
          statusCode: 200,
          reasonPhrase: 'OK',
          version: '2.0',
          headers: {
            callId: 'call-ent-101',
            from: { uri: parseSipUri('sip:executive@enterprise.com'), tag: 'tag-exec', params: {} },
            to: { uri: parseSipUri('sip:client@example.com'), tag: 'tag-client', params: {} },
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

      // 4. Teardown Call & Release Media Ports
      await allocator.releasePair(ports.rtpPort);
      quota.releaseChannel('tenant-enterprise-hq', 'call-ent-101');
      dm.terminateDialog('tenant-enterprise-hq', dialog.dialogId);

      // 5. Ingest CDR & Calculate Rating
      const cdr = ingestion.ingestRawEvent({
        tenantId: 'tenant-enterprise-hq',
        callId: 'call-ent-101',
        direction: 'OUTBOUND',
        caller: '+18005550100',
        callee: '+18005550199',
        sipResponseCode: 200,
        startTimeMs: 1700000000000,
        answerTimeMs: 1700000003000,
        endTimeMs: 1700000183000, // 180s billable -> 3 mins @ $0.005 = $0.015
      });
      const rated = ratingEngine.rateCall(cdr);
      expect(rated.totalCostMicros).toBe(15000);

      // 6. Deliver CTI Webhook
      const sig = dispatcher.generateSignature(
        JSON.stringify({
          tenantId: 'tenant-enterprise-hq',
          event: 'CALL_COMPLETED_AND_RATED',
          callId: 'call-ent-101',
          durationSec: 180,
          costUSD: rated.totalCostFormatted,
        }),
        1700000000,
        'ent-secret-xyz'
      );
      expect(sig).toMatch(/^[a-f0-9]{64}$/);
    });

    it('WORKFLOW_E2E_4.2 — High-Concurrency Attended Call Transfer with SDP Renegotiation', async () => {
      const dm = new DialogManager();
      const sdp = new SdpNegotiator();
      const allocator = new PortAllocator({ minPort: 16384, maxPort: 16450 });

      // Leg 1: Alice -> Bob
      const leg1Ports = await allocator.allocatePair('tenant-1', 'call-leg1');
      const leg1Dialog = dm.createOrUpdateDialog(
        'tenant-1',
        {
          isRequest: false,
          statusCode: 200,
          reasonPhrase: 'OK',
          version: '2.0',
          headers: {
            callId: 'call-leg1',
            from: { uri: parseSipUri('sip:alice@example.com'), tag: 'tag-alice', params: {} },
            to: { uri: parseSipUri('sip:bob@example.com'), tag: 'tag-bob', params: {} },
            cseq: { sequenceNumber: 1, method: 'INVITE' },
            via: [],
            maxForwards: 70,
            contentLength: 0,
            custom: {},
          },
        },
        'UAC'
      );

      // Leg 2 (Consultative): Bob -> Carol
      const leg2Ports = await allocator.allocatePair('tenant-1', 'call-leg2');
      const leg2Dialog = dm.createOrUpdateDialog(
        'tenant-1',
        {
          isRequest: false,
          statusCode: 200,
          reasonPhrase: 'OK',
          version: '2.0',
          headers: {
            callId: 'call-leg2',
            from: { uri: parseSipUri('sip:bob@example.com'), tag: 'tag-bob-2', params: {} },
            to: { uri: parseSipUri('sip:carol@example.com'), tag: 'tag-carol', params: {} },
            cseq: { sequenceNumber: 1, method: 'INVITE' },
            via: [],
            maxForwards: 70,
            contentLength: 0,
            custom: {},
          },
        },
        'UAC'
      );

      // Attended Transfer Replaces header construction
      const replacesHeader = `call-leg2;to-tag=tag-carol;from-tag=tag-bob-2`;
      const parsedReplaces = CallTransferCoordinator.parseReplacesHeader(replacesHeader);
      expect(parsedReplaces.callId).toBe('call-leg2');
      expect(parsedReplaces.toTag).toBe('tag-carol');
      expect(parsedReplaces.fromTag).toBe('tag-bob-2');

      // Bob completes transfer: Bob's legs teardown, Alice & Carol renegotiate SDP
      await allocator.releasePair(leg1Ports.rtpPort);
      await allocator.releasePair(leg2Ports.rtpPort);
      dm.terminateDialog('tenant-1', leg1Dialog.dialogId);
      dm.terminateDialog('tenant-1', leg2Dialog.dialogId);

      // New direct media path between Alice & Carol
      const directPorts = await allocator.allocatePair('tenant-1', 'call-alice-carol-direct');
      const directOffer = sdp.createOffer('192.0.2.10', directPorts.rtpPort);
      const directAnswer = sdp.createAnswer(directOffer, '198.51.100.50', 30000);
      expect(directAnswer.selectedCodec.name).toBe('PCMU');

      await allocator.releasePair(directPorts.rtpPort);
    });

    it('WORKFLOW_E2E_4.3 — Multi-Tenant Trunk Bursting & Prepaid Balance Depletion under High Traffic', async () => {
      const quota = new TenantQuotaTracker();
      const allocator = new PortAllocator({ minPort: 12000, maxPort: 12020 });

      // Tenant with 5 trunk channels and $0.10 prepaid balance
      quota.registerTenant({
        tenantId: 'tenant-burst',
        maxConcurrentCalls: 5,
        monthlyMinuteCap: 100,
        prepaidBalanceMicros: 100000, // $0.10
        isPostpaid: false,
        alertThresholdsPct: [80, 90, 100],
      });

      // 1. Acquire 5 channels (at capacity)
      for (let c = 1; c <= 5; c++) {
        expect(quota.acquireChannel('tenant-burst', `call-burst-${c}`)).toBe(true);
      }

      // 2. 6th channel attempt is rejected (capacity limit)
      expect(() => quota.acquireChannel('tenant-burst', 'call-burst-6')).toThrow(TenantQuotaExceededError);

      // 3. Release 1 channel and re-acquire
      quota.releaseChannel('tenant-burst', 'call-burst-1');
      expect(quota.acquireChannel('tenant-burst', 'call-burst-6')).toBe(true);

      // 4. Deduct calls until balance is exhausted
      quota.deductUsage('tenant-burst', 3, 60000); // $0.06 spent, $0.04 left
      quota.deductUsage('tenant-burst', 2, 40000); // $0.04 spent, $0.00 left

      // 5. Subsequent channel acquisition fails prepaid balance check ($0.00 remaining)
      quota.releaseChannel('tenant-burst', 'call-burst-2');
      expect(() => quota.acquireChannel('tenant-burst', 'call-burst-new')).toThrow(TenantQuotaExceededError);
    });

    it('WORKFLOW_E2E_4.4 — Network Jitter Spike & Packet Loss Recovery with PLC and RTCP QoS Monitoring', () => {
      const jb = new JitterBuffer({ clockRate: 8000, codec: 'PCMU' });
      const reporter = new RtcpReporter();

      // Normal transmission (packets 1..5)
      for (let i = 1; i <= 5; i++) {
        jb.push(
          {
            version: 2, padding: false, extension: false, csrcCount: 0, marker: false,
            payloadType: 0, sequenceNumber: i, timestamp: i * 160, ssrc: 0x5555, csrc: [],
            payload: Buffer.alloc(160, 0x12),
          },
          1000 + i * 20
        );
      }

      // Jitter spike: Packet 6 arrives with 80ms delay
      jb.push(
        {
          version: 2, padding: false, extension: false, csrcCount: 0, marker: false,
          payloadType: 0, sequenceNumber: 6, timestamp: 6 * 160, ssrc: 0x5555, csrc: [],
          payload: Buffer.alloc(160, 0x12),
        },
        1000 + 6 * 20 + 80 // +80ms jitter delay
      );

      expect(jb.getJitterMs()).toBeGreaterThan(0);

      // Simulate packet loss on packet 7 (dropped in transit) -> packet 8 arrives
      jb.push(
        {
          version: 2, padding: false, extension: false, csrcCount: 0, marker: false,
          payloadType: 0, sequenceNumber: 8, timestamp: 8 * 160, ssrc: 0x5555, csrc: [],
          payload: Buffer.alloc(160, 0x12),
        },
        1000 + 8 * 20
      );

      // Playout pops frames: Frame 1 to 6 are normal, Frame 7 should be concealed (PLC)
      for (let i = 1; i <= 6; i++) {
        const frame = jb.popPlayoutFrame();
        expect(frame.sequenceNumber).toBe(i);
        expect(frame.concealed).toBe(false);
      }

      const frame7 = jb.popPlayoutFrame();
      expect(frame7.sequenceNumber).toBe(7);
      expect(frame7.concealed).toBe(true);

      const frame8 = jb.popPlayoutFrame();
      expect(frame8.sequenceNumber).toBe(8);
      expect(frame8.concealed).toBe(false);
    });

    it('WORKFLOW_E2E_4.5 — PBX Device Registration Failover & Digest Re-authentication under Load', async () => {
      const registry = new DeviceRegistry({ defaultExpiresSec: 10 });
      const auth = new DigestAuthenticator('secret', 300);

      // Register device at IP 192.0.2.100
      const ep1 = registry.registerContact(
        'sip:2001@pbx.example.com',
        'tenant-failover',
        'sip:2001@192.0.2.100:5060',
        10,
        'reg-fo-1',
        1,
        'SIP-Phone-v1',
        '192.0.2.100',
        5060
      );
      expect(ep1.status).toBe('REGISTERED');

      // Failover event: Device migrates to backup IP 192.0.2.200 and re-authenticates
      const challenge = auth.createChallenge('pbx.example.com', '192.0.2.200');
      const ha1 = auth.computeHA1('2001', 'pbx.example.com', 'pass-2001');
      const ha2 = auth.computeHA2('REGISTER', 'sip:pbx.example.com');
      const resp = auth.computeDigestResponse(ha1, challenge.nonce, '00000001', 'cnonce-fo', 'auth', ha2);

      const isValid = await auth.verifyResponse(
        {
          username: '2001',
          realm: 'pbx.example.com',
          nonce: challenge.nonce,
          uri: 'sip:pbx.example.com',
          response: resp,
          nc: '00000001',
          cnonce: 'cnonce-fo',
          qop: 'auth',
          algorithm: 'MD5',
        },
        'REGISTER',
        '192.0.2.200',
        {
          getPassword: async () => 'pass-2001',
        }
      );
      expect(isValid).toBe(true);

      // Update registration with new contact URI
      const ep2 = registry.registerContact(
        'sip:2001@pbx.example.com',
        'tenant-failover',
        'sip:2001@192.0.2.200:5060',
        3600,
        'reg-fo-2',
        2,
        'SIP-Phone-v1',
        '192.0.2.200',
        5060
      );
      expect(ep2.bindings.some((b) => b.contactUri === 'sip:2001@192.0.2.200:5060')).toBe(true);
      const newBinding = ep2.bindings.find((b) => b.contactUri === 'sip:2001@192.0.2.200:5060');
      expect(newBinding?.sourceIp).toBe('192.0.2.200');
    });
  });
});
