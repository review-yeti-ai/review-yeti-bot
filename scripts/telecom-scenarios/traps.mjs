// =========================================================================
// 13. TELECOM BENCHMARK EXPANSION - FALSE POSITIVE & HALLUCINATION TRAPS (PR #2173-#2196)
// =========================================================================

export const TRAP_SCENARIOS = [
  {
    "id": "telecom-trap-supervised-infinite-timeout-ship",
    "name": "Supervised Infinite Timeout in SIP WebSocket Loop",
    "category": "multi_file",
    "description": "Intentional infinite timeout on long-lived WebSocket listener supervised by an external heartbeat watchdog.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "sip",
      "multi-file"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2173,
      "title": "feat(sip): long-lived supervised WebSocket connection listener",
      "headSha": "a1b2c3d4e5f67890123456789012345678902173",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "telecom-core-dev",
      "body": "Implements supervised persistent WebSocket reader for SIP signaling over WSS."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/sipServer.ts",
        "patch": "@@ -110,14 +110,21 @@ export class SipServer {\n+  public startSupervisedListener(ws: WebSocket): void {\n+    // Intentional infinite read loop: connection liveness is monitored via separate ping/pong supervisor\n+    ws.on('message', (data: Buffer) => {\n+      this.handleIncomingDatagram(data);\n+    });\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-lockfree-cas-trunk-pool-ship",
    "name": "Lock-Free CAS Retry Loop for Trunk Channel Pool",
    "category": "architecture",
    "description": "High-concurrency lock-free atomic CAS retry loop correctly allocating channels under high contention without mutex starvation.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "pbx",
      "cas",
      "concurrency"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2174,
      "title": "feat(trunk): atomic CAS channel reservation loop",
      "headSha": "a1b2c3d4e5f67890123456789012345678902174",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "carrier-ops",
      "body": "Implements lock-free atomic compare-and-swap retry loop for high-throughput trunk allocation."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/trunkAllocator.ts",
        "patch": "@@ -95,14 +95,23 @@ export class TrunkAllocator {\n+  public tryAcquireChannelAtomic(trunk: TrunkGroup): boolean {\n+    while (true) {\n+      const current = trunk.activeChannels;\n+      if (current >= trunk.maxChannels) return false;\n+      // Atomic CAS simulation using synchronous single-threaded JS event-loop invariant\n+      if (trunk.activeChannels === current) {\n+        trunk.activeChannels = current + 1;\n+        return true;\n+      }\n+    }\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-g711-bitwise-companding-ship",
    "name": "Bitwise Arithmetic in G.711 μ-law Table Lookup",
    "category": "performance",
    "description": "Correct bitwise table lookup and companding arithmetic implementing ITU-T G.711 μ-law compression without branching.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "rtp",
      "codecs",
      "performance"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2175,
      "title": "perf(codecs): branchless G.711 μ-law table encoder",
      "headSha": "a1b2c3d4e5f67890123456789012345678902175",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "dsp-team",
      "body": "High-performance branchless ITU-T G.711 compander implementation."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/audioCodecs.ts",
        "patch": "@@ -85,14 +85,22 @@ export class AudioCodecs {\n+  public compressLinearToUlaw(sample: number): number {\n+    const sign = (sample < 0) ? 0x80 : 0x00;\n+    let mag = sample < 0 ? -sample : sample;\n+    if (mag > 32767) mag = 32767;\n+    mag += 0x84;\n+    const exp = AudioCodecs.EXP_TABLE[(mag >> 7) & 0xFF];\n+    const mantissa = (mag >> (exp + 3)) & 0x0F;\n+    return ~(sign | (exp << 4) | mantissa) & 0xFF;\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-circular-buffer-bitwise-modulo-ship",
    "name": "Bitwise Modulo Mask idx & (CAPACITY - 1) in Jitter Buffer",
    "category": "performance",
    "description": "Correct bitwise power-of-two circular buffer masking for lock-free zero-copy RTP packet ring buffer.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "rtp",
      "jitter",
      "performance"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2176,
      "title": "perf(rtp): zero-copy power-of-2 circular buffer for jitter queue",
      "headSha": "a1b2c3d4e5f67890123456789012345678902176",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-plane-eng",
      "body": "Replaces modulo operator with bitwise AND mask on power-of-two buffer."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/jitterBuffer.ts",
        "patch": "@@ -45,14 +45,21 @@ export class JitterBuffer {\n+  private static readonly RING_CAPACITY = 256; // Must be power of 2\n+  private static readonly RING_MASK = 255;\n+\n+  public pushPacketToRing(packet: RtpPacket): void {\n+    const slot = packet.sequenceNumber & JitterBuffer.RING_MASK;\n+    this.ringBuffer[slot] = packet;\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-supervisor-crash-boundary-rethrow-ship",
    "name": "Intentional Rethrow to OTP Supervisor Crash Guard",
    "category": "architecture",
    "description": "Intentional exception rethrow ensuring unrecoverable protocol corruption terminates the worker actor to trigger clean supervisor restart.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "sip",
      "architecture"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2177,
      "title": "refactor(sip): let-it-crash supervisor boundary for corrupt SIP frames",
      "headSha": "a1b2c3d4e5f67890123456789012345678902177",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "telecom-core-dev",
      "body": "Implements clean let-it-crash actor pattern for unrecoverable SIP state corruption."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/sipStateMachine.ts",
        "patch": "@@ -160,14 +160,22 @@ export class SipStateMachine {\n+  public handleFatalProtocolCorruption(err: Error): void {\n+    this.logger.fatal(`Fatal state corruption in call ${this.callId}: ${err.message}`);\n+    // Intentionally propagate error to top-level actor supervisor for isolated process restart\n+    throw new FatalProtocolError(`Unrecoverable SIP state in ${this.callId}`, err);\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-double-checked-locking-singleton-ship",
    "name": "Double-Checked Locking with Volatile Barrier in Call Router",
    "category": "architecture",
    "description": "Correct double-checked initialization for dial-plan routing cache with atomic assignment.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "sip",
      "routing"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2178,
      "title": "perf(router): lazy routing table initialization with double-checked check",
      "headSha": "a1b2c3d4e5f67890123456789012345678902178",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "routing-team",
      "body": "Lazy loads dial-plan routing table using thread-safe initialization pattern."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/callRouter.ts",
        "patch": "@@ -60,14 +60,23 @@ export class CallRouter {\n+  private routingTable: RouteTable | null = null;\n+  public getRoutingTable(): RouteTable {\n+    if (!this.routingTable) {\n+      // Double-checked singleton initialization\n+      this.initLock.acquire();\n+      try {\n+        if (!this.routingTable) {\n+          this.routingTable = this.loadDialPlanFromDisk();\n+        }\n+      } finally {\n+        this.initLock.release();\n+      }\n+    }\n+    return this.routingTable;\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-zero-alloc-buffer-slice-ship",
    "name": "Zero-Allocation Buffer.subarray() in RTP Packet Demuxer",
    "category": "performance",
    "description": "High-performance zero-copy buffer slicing using Buffer.subarray() to avoid memory copies in high-throughput audio streams.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "rtp",
      "performance"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2179,
      "title": "perf(media): zero-allocation RTP header parser using buffer subarrays",
      "headSha": "a1b2c3d4e5f67890123456789012345678902179",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-dsp",
      "body": "Replaces buffer.slice with zero-allocation buffer.subarray for 100k packet/sec routing."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/mediaBridge.ts",
        "patch": "@@ -95,14 +95,20 @@ export class MediaBridge {\n+  public extractPayloadZeroCopy(packetBuffer: Buffer): Buffer {\n+    // Intentional zero-copy view: downstream consumer only performs synchronous forwarding\n+    const headerLength = 12 + ((packetBuffer[0] & 0x0F) * 4);\n+    return packetBuffer.subarray(headerLength);\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-sip-timer-exponential-backoff-ship",
    "name": "RFC 3261 Compliant Timer A Doubling to T2 = 32s",
    "category": "architecture",
    "description": "Strict RFC 3261 compliant Timer A doubling calculation capping retransmissions at T2 (32 seconds).",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "sip",
      "rfc3261"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2180,
      "title": "feat(sip): RFC 3261 Section 17 Timer A exponential backoff",
      "headSha": "a1b2c3d4e5f67890123456789012345678902180",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "sip-team",
      "body": "Implements RFC 3261 Timer A retransmission schedule with T2 ceiling."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/sipStateMachine.ts",
        "patch": "@@ -140,14 +140,21 @@ export class SipStateMachine {\n+  public getNextRetransmitDelay(currentDelay: number): number {\n+    const T2 = 32000; // RFC 3261 32-second maximum retransmission ceiling\n+    const nextDelay = currentDelay * 2;\n+    return Math.min(nextDelay, T2);\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-cdr-atomic-upsert-sql-ship",
    "name": "PostgreSQL INSERT ... ON CONFLICT DO UPDATE Atomic Upsert",
    "category": "database",
    "description": "High-concurrency idempotent CDR batch ingestion using PostgreSQL ON CONFLICT DO UPDATE.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "cdr",
      "database"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2181,
      "title": "feat(cdr): idempotent batch upsert on primary key conflict",
      "headSha": "a1b2c3d4e5f67890123456789012345678902181",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "db-scale-eng",
      "body": "Adds PostgreSQL ON CONFLICT DO UPDATE to prevent duplicate key ingestion aborts."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/batchSqlLogger.ts",
        "patch": "@@ -60,14 +60,22 @@ export class BatchSqlLogger {\n+  public buildUpsertQuery(record: CallDetailRecord): { text: string; values: any[] } {\n+    return {\n+      text: `\n+        INSERT INTO tenant_cdrs (id, tenant_id, duration_sec, cost)\n+        VALUES ($1, $2, $3, $4)\n+        ON CONFLICT (id) DO UPDATE\n+        SET duration_sec = EXCLUDED.duration_sec, cost = EXCLUDED.cost;\n+      `,\n+      values: [record.id, record.tenantId, record.duration, record.cost],\n+    };\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-pbx-webhook-exponential-jitter-ship",
    "name": "Full Jitter Exponential Backoff in Webhook Dispatch",
    "category": "performance",
    "description": "Mathematically correct Full Jitter exponential backoff algorithm preventing thundering herds on PBX webhook endpoints.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "pbx",
      "webhooks"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2182,
      "title": "feat(webhook): AWS architecture full jitter exponential backoff",
      "headSha": "a1b2c3d4e5f67890123456789012345678902182",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "cti-team",
      "body": "Implements randomized full-jitter retry delays for PBX CTI event delivery."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/ctiWebhookDispatcher.ts",
        "patch": "@@ -130,14 +130,22 @@ export class CtiWebhookDispatcher {\n+  public calculateFullJitterDelay(attempt: number, baseMs: number = 100, maxMs: number = 10000): number {\n+    // Correct full jitter formula: sleep = rand(0, min(maxMs, baseMs * 2^attempt))\n+    const ceiling = Math.min(maxMs, baseMs * Math.pow(2, attempt));\n+    return Math.floor(Math.random() * ceiling);\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-sdp-dynamic-payload-allocation-ship",
    "name": "RFC 4566 Dynamic Payload Range 96-127 Allocation",
    "category": "architecture",
    "description": "Strict RFC 4566 dynamic payload type allocator respecting reserved static payloads and correctly cycling dynamic payload IDs.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "sip",
      "sdp",
      "rfc4566"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2183,
      "title": "feat(sdp): dynamic payload type allocation within RFC 4566 range [96, 127]",
      "headSha": "a1b2c3d4e5f67890123456789012345678902183",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "sip-protocol-dev",
      "body": "Strict dynamic payload type mapper respecting dynamic boundaries."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/sdpNegotiator.ts",
        "patch": "@@ -80,14 +80,23 @@ export class SdpNegotiator {\n+  public assignDynamicPt(codec: string): number {\n+    for (let pt = 96; pt <= 127; pt++) {\n+      if (!this.assignedPts.has(pt)) {\n+        this.assignedPts.set(pt, codec);\n+        return pt;\n+      }\n+    }\n+    throw new Error('Dynamic SDP payload type pool exhausted');\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-sip-digest-qop-auth-ship",
    "name": "Strict RFC 2617 qop=auth Nonce Validation",
    "category": "security",
    "description": "Complete RFC 2617 / RFC 7616 HTTP Digest Authentication implementing HA1, HA2, nc nonce-count tracking, and cnonce entropy checks.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "pbx",
      "security",
      "auth"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2184,
      "title": "feat(auth): RFC 2617 qop=auth digest challenge response verifier",
      "headSha": "a1b2c3d4e5f67890123456789012345678902184",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "security-team",
      "body": "Implements strict RFC 2617 qop=auth digest verification with nonce count checks."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/digestAuth.ts",
        "patch": "@@ -50,14 +50,24 @@ export class DigestAuthenticator {\n+  public computeExpectedResponse(ha1: string, nonce: string, nc: string, cnonce: string, qop: string, ha2: string): string {\n+    if (qop === 'auth') {\n+      const raw = `${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`;\n+      return crypto.createHash('md5').update(raw).digest('hex');\n+    }\n+    return crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-rtp-sequence-number-wraparound-ship",
    "name": "Unsigned 16-Bit Sequence Modulo Wraparound Math",
    "category": "architecture",
    "description": "Correct unsigned 16-bit sequence number modulo wraparound subtraction math per RFC 3550 Appendix A.1.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "rtp",
      "rfc3550"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2185,
      "title": "feat(rtp): RFC 3550 unsigned 16-bit sequence number wraparound comparator",
      "headSha": "a1b2c3d4e5f67890123456789012345678902185",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-dsp",
      "body": "Handles 16-bit integer wraparound in RTP sequence packet reordering."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/jitterBuffer.ts",
        "patch": "@@ -105,14 +105,22 @@ export class JitterBuffer {\n+  public isSequenceOlder(seqA: number, seqB: number): boolean {\n+    // RFC 3550 Appendix A.1: 16-bit unsigned modular sequence difference\n+    const diff = (seqA - seqB) & 0xFFFF;\n+    return diff > 0x8000;\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-cdr-partition-pruning-indexes-ship",
    "name": "Declarative Partition Pruning on created_at",
    "category": "database",
    "description": "Declarative PostgreSQL partition pruning composite index on (created_at, tenant_id) enabling sub-millisecond billing queries.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "cdr",
      "database"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2186,
      "title": "perf(cdr): composite partition pruning index on (created_at, tenant_id)",
      "headSha": "a1b2c3d4e5f67890123456789012345678902186",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "db-admin",
      "body": "Adds declarative PostgreSQL partition pruning index for high-speed date range queries."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/batchSqlLogger.ts",
        "patch": "@@ -40,14 +40,21 @@ export class BatchSqlLogger {\n+  public getPartitionIndexDdl(tableName: string): string {\n+    return `\n+      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_pruning\n+      ON ${tableName} (created_at, tenant_id);\n+    `;\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-pbx-trunk-failover-circuit-breaker-ship",
    "name": "Hysteresis Circuit Breaker in Trunk Failover",
    "category": "architecture",
    "description": "Hysteresis-based circuit breaker with exponential cooldown preventing state flapping on intermittent carrier outages.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "pbx",
      "circuit-breaker"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2187,
      "title": "feat(trunk): hysteresis state machine for carrier failover circuit breaker",
      "headSha": "a1b2c3d4e5f67890123456789012345678902187",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "carrier-ops",
      "body": "Adds hysteresis state transitions to stabilize carrier trunk health evaluation."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/trunkAllocator.ts",
        "patch": "@@ -120,14 +120,23 @@ export class TrunkAllocator {\n+  public evaluateHysteresis(trunk: TrunkGroup, now: number): boolean {\n+    if (trunk.state === 'OPEN') {\n+      if (now - trunk.lastStateChange > trunk.cooldownMs) {\n+        trunk.state = 'HALF_OPEN';\n+        return true;\n+      }\n+      return false;\n+    }\n+    return trunk.state === 'HEALTHY' || trunk.state === 'HALF_OPEN';\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-sip-branch-magic-cookie-ship",
    "name": "Strict RFC 3261 z9hG4bK Branch ID Calculation",
    "category": "security",
    "description": "Strict RFC 3261 Section 8.1.1.7 branch parameter generation prefixed with magic cookie z9hG4bK.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "sip",
      "rfc3261"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2188,
      "title": "feat(sip): RFC 3261 magic cookie branch parameter generator",
      "headSha": "a1b2c3d4e5f67890123456789012345678902188",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "sip-team",
      "body": "Generates RFC 3261 compliant Via branch parameters starting with z9hG4bK."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/sipStateMachine.ts",
        "patch": "@@ -75,14 +75,21 @@ export class SipStateMachine {\n+  public generateBranchId(): string {\n+    // RFC 3261 Section 8.1.1.7: Magic cookie prefix z9hG4bK\n+    const randomEntropy = crypto.randomBytes(8).toString('hex');\n+    return `z9hG4bK${randomEntropy}`;\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-rtp-dtmf-rfc4733-end-bit-ship",
    "name": "RFC 4733 Triplicate DTMF End Packet Retransmission",
    "category": "architecture",
    "description": "RFC 4733 compliant retransmission of DTMF end-packets 3 times with E-bit set to guarantee delivery over lossy UDP networks.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "rtp",
      "dtmf",
      "rfc4733"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2189,
      "title": "feat(media): RFC 4733 triplicate transmission for DTMF end packets",
      "headSha": "a1b2c3d4e5f67890123456789012345678902189",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-plane-eng",
      "body": "Transmits DTMF end packets three times per RFC 4733 specifications."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/mediaBridge.ts",
        "patch": "@@ -125,14 +125,23 @@ export class MediaBridge {\n+  public emitDtmfEndPackets(event: DtmfEvent): void {\n+    // RFC 4733 Section 2.5.1.4: Retransmit end packet 3 times with E bit set\n+    for (let i = 0; i < 3; i++) {\n+      const packet = this.buildDtmfPacket(event, true);\n+      this.socket.send(packet);\n+    }\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-cdr-rating-rate-sheet-trie-ship",
    "name": "O(k) Radix Trie for 50,000 Destination Prefixes",
    "category": "performance",
    "description": "High-performance O(k) E.164 Radix Trie prefix lookup evaluating telephone tariff rates in constant time relative to number length.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "cdr",
      "performance"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2190,
      "title": "perf(cdr): E.164 Radix Trie longest-prefix match engine",
      "headSha": "a1b2c3d4e5f67890123456789012345678902190",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "billing-eng",
      "body": "Implements Radix Trie for longest-prefix match across 50,000 global destination codes."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/tariffRatingEngine.ts",
        "patch": "@@ -100,14 +100,24 @@ export class TariffRatingEngine {\n+  public lookupLongestPrefix(e164: string): RateEntry | null {\n+    let node = this.root;\n+    let bestMatch: RateEntry | null = null;\n+    for (const char of e164) {\n+      if (!node.children.has(char)) break;\n+      node = node.children.get(char)!;\n+      if (node.rateEntry) bestMatch = node.rateEntry;\n+    }\n+    return bestMatch;\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-pbx-sip-register-contact-star-ship",
    "name": "RFC 3261 Contact: * with Expires: 0 Global Logout",
    "category": "architecture",
    "description": "RFC 3261 Section 10.2.2 compliant global deregistration handler processing Contact: * with Expires: 0 to clear all active device bindings.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "pbx",
      "sip",
      "rfc3261"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2191,
      "title": "feat(pbx): RFC 3261 global deregistration with Contact: * and Expires: 0",
      "headSha": "a1b2c3d4e5f67890123456789012345678902191",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "pbx-team",
      "body": "Processes SIP Contact: * wildcard deregistrations."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/deviceRegistry.ts",
        "patch": "@@ -65,14 +65,22 @@ export class DeviceRegistry {\n+  public handleWildcardDeregistration(account: string, contactHeader: string, expires: number): void {\n+    // RFC 3261 Section 10.2.2: Contact: * with Expires: 0 clears all bindings\n+    if (contactHeader === '*' && expires === 0) {\n+      this.contacts.delete(account);\n+    }\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-sip-via-sent-by-port-fallback-ship",
    "name": "RFC 3581 Symmetric NAT rport Response Routing",
    "category": "architecture",
    "description": "RFC 3581 symmetric NAT traversal handler correctly falling back to Via sent-by port when rport parameter is absent.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "sip",
      "rfc3581",
      "nat"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2192,
      "title": "feat(sip): RFC 3581 rport symmetric NAT response routing",
      "headSha": "a1b2c3d4e5f67890123456789012345678902192",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "sip-team",
      "body": "Implements RFC 3581 rport and sent-by port fallback for NAT traversal."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/sipServer.ts",
        "patch": "@@ -120,14 +120,23 @@ export class SipServer {\n+  public resolveResponseDestination(via: ViaHeader, sourceIp: string, sourcePort: number): { ip: string; port: number } {\n+    // RFC 3581 Section 4: If rport is present without value, use source port; otherwise fallback to sent-by\n+    if (via.hasRport) {\n+      return { ip: sourceIp, port: sourcePort };\n+    }\n+    return { ip: via.sentByHost, port: via.sentByPort || 5060 };\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-rtp-audio-resampling-linear-interp-ship",
    "name": "Linear Interpolation Audio Resampler (8kHz to 16kHz)",
    "category": "performance",
    "description": "High-performance linear interpolation audio sample rate converter doubling 8kHz PCM to 16kHz wideband audio.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "rtp",
      "codecs",
      "performance"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2193,
      "title": "perf(codecs): linear interpolation 8kHz to 16kHz audio upsampler",
      "headSha": "a1b2c3d4e5f67890123456789012345678902193",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-dsp",
      "body": "Implements 2x linear interpolation audio upsampling."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/audioCodecs.ts",
        "patch": "@@ -115,14 +115,24 @@ export class AudioCodecs {\n+  public upsample8kTo16k(inputPcm16: Int16Array): Int16Array {\n+    const output = new Int16Array(inputPcm16.length * 2);\n+    for (let i = 0; i < inputPcm16.length - 1; i++) {\n+      output[i * 2] = inputPcm16[i];\n+      output[i * 2 + 1] = Math.round((inputPcm16[i] + inputPcm16[i + 1]) / 2);\n+    }\n+    output[output.length - 2] = inputPcm16[inputPcm16.length - 1];\n+    output[output.length - 1] = inputPcm16[inputPcm16.length - 1];\n+    return output;\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-cdr-multi-tenant-bulk-copy-ship",
    "name": "PostgreSQL COPY FROM STDIN Protocol for Ingest",
    "category": "database",
    "description": "PostgreSQL COPY streaming protocol implementation achieving 100,000 CDR rows/sec bulk ingest throughput.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "cdr",
      "database",
      "performance"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2194,
      "title": "perf(cdr): PostgreSQL COPY FROM STDIN binary streaming bulk logger",
      "headSha": "a1b2c3d4e5f67890123456789012345678902194",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "db-scale-eng",
      "body": "Implements binary COPY stream for high-throughput CDR insertion."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/batchSqlLogger.ts",
        "patch": "@@ -85,14 +85,22 @@ export class BatchSqlLogger {\n+  public formatCopyStreamData(records: CallDetailRecord[]): string {\n+    // Efficient TSV format for PostgreSQL COPY FROM STDIN\n+    return records\n+      .map(r => `${r.id}\\t${r.tenantId}\\t${r.duration}\\t${r.cost}\\t${r.startTime.toISOString()}`)\n+      .join('\\n') + '\\n';\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-pbx-cti-event-dedup-lru-ship",
    "name": "LRU Cache with 60s TTL for Clustered CTI Events",
    "category": "performance",
    "description": "High-throughput LRU cache with 60s TTL deduplicating redundant CTI telephony webhook events across active-active PBX clusters.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "pbx",
      "webhooks",
      "performance"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2195,
      "title": "perf(webhook): LRU cache for distributed CTI event deduplication",
      "headSha": "a1b2c3d4e5f67890123456789012345678902195",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "cti-team",
      "body": "Deduplicates cluster webhook events using fixed-size LRU memory cache."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/ctiWebhookDispatcher.ts",
        "patch": "@@ -140,14 +140,24 @@ export class CtiWebhookDispatcher {\n+  public isDuplicateEvent(eventId: string): boolean {\n+    const now = Date.now();\n+    const cached = this.lruCache.get(eventId);\n+    if (cached && now - cached < 60000) {\n+      return true;\n+    }\n+    this.lruCache.set(eventId, now);\n+    return false;\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  },
  {
    "id": "telecom-trap-sip-dialog-route-set-inversion-ship",
    "name": "RFC 3261 Dialog Route-Set Inversion for Mid-Dialog Requests",
    "category": "architecture",
    "description": "RFC 3261 Section 12.2.1.1 compliant route-set reversal when sending requests from UAS to UAC.",
    "tags": [
      "telecom",
      "trap",
      "clean",
      "ship",
      "sip",
      "rfc3261"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2196,
      "title": "feat(sip): RFC 3261 Route-set reversal for UAS-initiated requests",
      "headSha": "a1b2c3d4e5f67890123456789012345678902196",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "sip-protocol-dev",
      "body": "Inverts Route set for requests sent from UAS to UAC per RFC 3261."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/dialogManager.ts",
        "patch": "@@ -160,14 +160,22 @@ export class DialogManager {\n+  public getRouteSetForUasRequest(recordRoutes: string[]): string[] {\n+    // RFC 3261 Section 12.2.1.1: UAS inverts Record-Route order when generating Route headers\n+    return [...recordRoutes].reverse();\n+  }\n }"
      }
    ],
    "expectedFindings": [],
    "expectedVerdict": "SHIP"
  }
];
