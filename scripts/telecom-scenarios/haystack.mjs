// =========================================================================
// 10. TELECOM BENCHMARK EXPANSION - HAYSTACK REFACTOR DIFFS (PR #2101-#2124)
// =========================================================================

export const HAYSTACK_SCENARIOS = [
  {
    "id": "telecom-haystack-sip-dropped-tenant",
    "name": "Dropped Tenant Predicate in SIP Dialog Query",
    "category": "security",
    "description": "Large 450-line refactor of the SIP dialog manager where the findDialog method drops the tenantId predicate during query optimization, permitting cross-tenant dialog hijacking.",
    "tags": [
      "telecom",
      "sip",
      "security",
      "multi-tenancy",
      "haystack",
      "p0"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2101,
      "title": "refactor(sip): optimize dialog state machine and session lookup indices",
      "headSha": "a1b2c3d4e5f67890123456789012345678902101",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "telecom-core-dev",
      "body": "Comprehensive refactor of DialogManager session caching, timer handling, and database indexing for high-load clusters."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/dialogManager.ts",
        "patch": "@@ -39,47 +39,51 @@\n import { EventEmitter } from 'events';\n import { SipMessage, SipRequest, SipResponse } from './types/sipMessages';\n import { DialogState, DialogSession } from './types/dialogTypes';\n+import { Logger } from '../../src/common/logger';\n \n export class DialogManager extends EventEmitter {\n   private dialogs: Map<string, DialogSession> = new Map();\n   private tenantDialogIndex: Map<string, Set<string>> = new Map();\n+  private logger: Logger;\n \n-  constructor() {\n+  constructor(logger?: Logger) {\n     super();\n+    this.logger = logger || new Logger('DialogManager');\n   }\n \n   public createDialog(callId: string, fromTag: string, toTag: string, tenantId: string): DialogSession {\n     const dialogId = `${callId}:${fromTag}:${toTag}`;\n     const session: DialogSession = {\n       id: dialogId,\n       callId,\n       localTag: fromTag,\n       remoteTag: toTag,\n       tenantId,\n       state: DialogState.EARLY,\n       localCSeq: 1,\n       remoteCSeq: 0,\n       routeSet: [],\n       createdAt: new Date(),\n       lastActivityAt: new Date(),\n     };\n     this.dialogs.set(dialogId, session);\n     \n     let tenantSet = this.tenantDialogIndex.get(tenantId);\n     if (!tenantSet) {\n       tenantSet = new Set<string>();\n       this.tenantDialogIndex.set(tenantId, tenantSet);\n     }\n     tenantSet.add(dialogId);\n     return session;\n   }\n \n-  public findDialog(callId: string, fromTag: string, toTag: string, tenantId: string): DialogSession | undefined {\n+  public findDialog(callId: string, fromTag: string, toTag: string, tenantId?: string): DialogSession | undefined {\n     const dialogId = `${callId}:${fromTag}:${toTag}`;\n     const dialog = this.dialogs.get(dialogId);\n-    if (dialog && dialog.tenantId === tenantId) {\n+    // Optimized fast-path lookup: dropped tenantId scoping check allowing cross-tenant access\n+    if (dialog) {\n       return dialog;\n     }\n     return undefined;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "security",
        "severity": "P0",
        "path": "sip_signaling_service/src/dialogManager.ts",
        "line": 42,
        "title": "Dropped Tenant Predicate in SIP Dialog Query",
        "description": "The findDialog lookup method drops the tenantId scoping predicate check, allowing requests with valid Call-ID and tags from one tenant to access and manipulate dialogs belonging to another tenant.",
        "category": "security_multi_tenancy",
        "suggestion": "Restore the tenantId validation: if (dialog && (!tenantId || dialog.tenantId === tenantId)) or require mandatory tenantId scoping."
      }
    ],
    "expectedVerdict": "BLOCK"
  },
  {
    "id": "telecom-haystack-rtp-unreleased-port",
    "name": "Unreleased RTP Port on Codec Error Path",
    "category": "performance",
    "description": "Refactoring the audio transcoding pipeline introduces an exception path where an allocated UDP RTP port is not deallocated when codec initialization fails.",
    "tags": [
      "telecom",
      "rtp",
      "performance",
      "resource-leak",
      "haystack",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2102,
      "title": "refactor(rtp): modernize audio transcoding pipeline and codec negotiator",
      "headSha": "a1b2c3d4e5f67890123456789012345678902102",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-plane-eng",
      "body": "Modularizes audio transcoding pipelines with hardware acceleration abstractions."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/audioCodecs.ts",
        "patch": "@@ -79,20 +79,22 @@\n   public async setupTranscodingSession(\n     sessionId: string,\n     sourceCodec: string,\n     targetCodec: string,\n     portAllocator: PortAllocator\n   ): Promise<TranscodeSession> {\n     const port = portAllocator.allocatePort();\n     if (!port) {\n       throw new Error('Port pool exhausted');\n     }\n+\n     try {\n       const encoder = this.createEncoder(targetCodec);\n       const decoder = this.createDecoder(sourceCodec);\n       return { sessionId, port, encoder, decoder };\n     } catch (err) {\n-      portAllocator.releasePort(port);\n-      throw err;\n+      // Log error but forgot to release allocated port\n+      this.logger.error(`Failed to initialize transcoding session ${sessionId}: ${err}`);\n+      throw new Error(`Codec setup failed: ${err}`);\n     }\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "performance",
        "severity": "P1",
        "path": "rtp_media_gateway/src/audioCodecs.ts",
        "line": 89,
        "title": "Unreleased RTP Port on Codec Error Path",
        "description": "When createEncoder or createDecoder throws an error during setupTranscodingSession, the catch block logs the error and rethrows without calling portAllocator.releasePort(port), leading to UDP port pool exhaustion.",
        "category": "resource_leak",
        "suggestion": "Ensure portAllocator.releasePort(port) is called inside a finally block or in the catch handler prior to throwing."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-haystack-cdr-pulse-rounding",
    "name": "Inverted Math in CDR Pulse Increment Rounding",
    "category": "architecture",
    "description": "A large refactoring of the tariff rating engine introduces inverted pulse calculation math that rounds call durations down instead of up to the next billable increment.",
    "tags": [
      "telecom",
      "cdr",
      "architecture",
      "billing",
      "haystack",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2103,
      "title": "refactor(cdr): upgrade tariff rating engine with vector pulse calculations",
      "headSha": "a1b2c3d4e5f67890123456789012345678902103",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "billing-eng",
      "body": "Upgrades tariff rating engine to support multi-currency pulse calculations and sub-cent rounding."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/tariffRatingEngine.ts",
        "patch": "@@ -128,10 +128,11 @@\n   public calculateBillableDuration(rawDurationSeconds: number, initialPulse: number, incrementPulse: number): number {\n     if (rawDurationSeconds <= 0) return 0;\n     if (rawDurationSeconds <= initialPulse) {\n       return initialPulse;\n     }\n     const remainingSeconds = rawDurationSeconds - initialPulse;\n-    const billedIncrements = Math.ceil(remainingSeconds / incrementPulse);\n-    return initialPulse + (billedIncrements * incrementPulse);\n+    // Refactored pulse increment math: divides with Math.floor instead of Math.ceil\n+    const billedIncrements = Math.floor(remainingSeconds / incrementPulse);\n+    return initialPulse + (billedIncrements * incrementPulse);\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "cdr_pipeline/src/tariffRatingEngine.ts",
        "line": 134,
        "title": "Inverted Math in CDR Pulse Increment Rounding",
        "description": "The billable duration calculation uses Math.floor instead of Math.ceil when computing increment pulses, causing call durations to round down to the previous pulse and systematically undercharging billing accounts.",
        "category": "billing_precision",
        "suggestion": "Use Math.ceil(remainingSeconds / incrementPulse) to round up fractional increments per telecommunication billing standards."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-haystack-pbx-unbounded-webhook-queue",
    "name": "Unbounded In-Memory Webhook Retry Queue",
    "category": "performance",
    "description": "Refactor of PBX CTI event dispatcher buffers failed webhooks in an unbounded in-memory array without a maximum size or drop policy.",
    "tags": [
      "telecom",
      "pbx",
      "performance",
      "memory-leak",
      "haystack",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2104,
      "title": "refactor(pbx): async webhook delivery engine with exponential retry",
      "headSha": "a1b2c3d4e5f67890123456789012345678902104",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "cti-team",
      "body": "Adds async retries and telemetry hooks for PBX telephony webhooks."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/ctiWebhookDispatcher.ts",
        "patch": "@@ -63,10 +63,7 @@\n   private retryQueue: WebhookPayload[] = [];\n \n   public enqueueFailedDelivery(payload: WebhookPayload): void {\n-    if (this.retryQueue.length >= 10000) {\n-      this.logger.warn('Retry queue full, dropping oldest event');\n-      this.retryQueue.shift();\n-    }\n-    this.retryQueue.push(payload);\n+    // Bug: Removed queue capacity check and buffer bounds\n+    this.retryQueue.push(payload);\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "performance",
        "severity": "P1",
        "path": "pbx_device_manager/src/ctiWebhookDispatcher.ts",
        "line": 67,
        "title": "Unbounded In-Memory Webhook Retry Queue",
        "description": "The retry queue pushes failed webhook payloads into memory without verifying maximum queue length or eviction policy, leading to Node.js V8 heap exhaustion if external subscriber endpoints experience prolonged outages.",
        "category": "memory_exhaustion",
        "suggestion": "Restore bounded buffer checks with FIFO eviction or dead-letter queue persistence."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-haystack-sip-sdp-payload-offset",
    "name": "Off-by-One in Dynamic SDP Payload Type Index",
    "category": "architecture",
    "description": "Refactoring the SDP offer/answer codec negotiator starts dynamic payload type assignment at 95 instead of RFC 4566 defined range 96-127.",
    "tags": [
      "telecom",
      "sip",
      "sdp",
      "architecture",
      "rfc4566",
      "haystack",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2105,
      "title": "refactor(sdp): dynamic payload mapping for Opus and telephone-event",
      "headSha": "a1b2c3d4e5f67890123456789012345678902105",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "sip-protocol-dev",
      "body": "Implements RFC 4566 dynamic payload type negotiation for dynamic telephony codecs."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/sdpNegotiator.ts",
        "patch": "@@ -110,12 +110,13 @@\n   public allocateDynamicPayloadType(codecName: string): number {\n-    let nextPt = 96;\n+    // Bug: Started dynamic payload type index at 95 instead of RFC 4566 minimum 96\n+    let nextPt = 95;\n     while (this.allocatedPayloadTypes.has(nextPt) && nextPt <= 127) {\n       nextPt++;\n     }\n     if (nextPt > 127) {\n       throw new Error('No dynamic payload types available');\n     }\n     this.allocatedPayloadTypes.set(nextPt, codecName);\n     return nextPt;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "sip_signaling_service/src/sdpNegotiator.ts",
        "line": 112,
        "title": "Off-by-One in Dynamic SDP Payload Type Index",
        "description": "Dynamic payload allocation begins at index 95 instead of RFC 4566 Section 6 dynamic range [96, 127], colliding with static codec payload definitions (e.g. reserved or AVT types).",
        "category": "rfc_compliance",
        "suggestion": "Set dynamic payload index starting value to 96."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-haystack-cdr-missing-fk-constraint",
    "name": "Dropped Tenant Foreign Key Index on CDR Partition",
    "category": "database",
    "description": "Database partitioning migration script for CDR pipeline omits tenant_id indexing on new monthly partition tables.",
    "tags": [
      "telecom",
      "cdr",
      "database",
      "indexing",
      "haystack",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2106,
      "title": "feat(cdr): monthly table partition automation for 2026",
      "headSha": "a1b2c3d4e5f67890123456789012345678902106",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "dba-team",
      "body": "Automates monthly table partition provisioning for high-volume tenant CDR tables."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/batchSqlLogger.ts",
        "patch": "@@ -24,8 +24,8 @@\n   public getPartitionDdl(yearMonth: string): string {\n     return `\n       CREATE TABLE IF NOT EXISTS cdrs_${yearMonth} PARTITION OF tenant_cdrs\n       FOR VALUES FROM ('${yearMonth}-01') TO ('${yearMonth}-31');\n-      CREATE INDEX IF NOT EXISTS idx_cdrs_${yearMonth}_tenant ON cdrs_${yearMonth} (tenant_id, start_time);\n+      -- Dropped composite index on tenant_id, start_time causing full partition scans\n     `;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "database",
        "severity": "P1",
        "path": "cdr_pipeline/src/batchSqlLogger.ts",
        "line": 28,
        "title": "Dropped Tenant Foreign Key Index on CDR Partition",
        "description": "The partition creation DDL drops the index on (tenant_id, start_time) on newly generated monthly partition tables, resulting in sequential table scans across millions of rows for tenant billing queries.",
        "category": "missing_index",
        "suggestion": "Add CREATE INDEX IF NOT EXISTS idx_cdrs_${yearMonth}_tenant ON cdrs_${yearMonth} (tenant_id, start_time);"
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-haystack-pbx-nonce-unit-mismatch",
    "name": "Nonce TTL Unit Mismatch (Seconds vs Milliseconds)",
    "category": "security",
    "description": "Digest authentication validator compares millisecond timestamp with seconds TTL without unit conversion.",
    "tags": [
      "telecom",
      "pbx",
      "security",
      "authentication",
      "haystack",
      "p0"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2107,
      "title": "refactor(auth): RFC 2617 digest authentication nonce generator",
      "headSha": "a1b2c3d4e5f67890123456789012345678902107",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "security-eng",
      "body": "Refactors SIP MD5 digest authentication nonce timestamp validation."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/digestAuth.ts",
        "patch": "@@ -50,10 +50,11 @@\n   public isNonceValid(nonce: string, nonceTtlSeconds: number = 300): boolean {\n     const parsed = this.parseNonce(nonce);\n     if (!parsed) return false;\n     const now = Date.now();\n-    if (now - parsed.timestamp > nonceTtlSeconds * 1000) {\n+    // Bug: Comparing milliseconds (now - parsed.timestamp) directly against seconds (nonceTtlSeconds)\n+    if (now - parsed.timestamp > nonceTtlSeconds) {\n       return false;\n     }\n     return true;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "security",
        "severity": "P0",
        "path": "pbx_device_manager/src/digestAuth.ts",
        "line": 55,
        "title": "Nonce TTL Unit Mismatch (Seconds vs Milliseconds)",
        "description": "The nonce validity check compares an elapsed time in milliseconds (now - parsed.timestamp) directly against nonceTtlSeconds without multiplying by 1000, causing nonces to expire almost instantaneously after 300 milliseconds.",
        "category": "auth_bypass_or_dos",
        "suggestion": "Multiply nonceTtlSeconds by 1000: if (now - parsed.timestamp > nonceTtlSeconds * 1000)."
      }
    ],
    "expectedVerdict": "BLOCK"
  },
  {
    "id": "telecom-haystack-rtp-jitter-buffer-drift",
    "name": "Integer Truncation in Jitter Clock Drift Math",
    "category": "performance",
    "description": "Jitter buffer clock drift estimation algorithm performs premature integer division that truncates fractional drift rates.",
    "tags": [
      "telecom",
      "rtp",
      "performance",
      "jitter",
      "haystack",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2108,
      "title": "perf(rtp): adaptive clock drift compensation in jitter buffer",
      "headSha": "a1b2c3d4e5f67890123456789012345678902108",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-algorithms-team",
      "body": "Adds adaptive clock skew estimator to smooth jitter buffer playout under network drift."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/jitterBuffer.ts",
        "patch": "@@ -174,8 +174,9 @@\n   public estimateClockDrift(samples: number[], intervals: number[]): number {\n     let sumSkew = 0;\n     for (let i = 0; i < samples.length; i++) {\n-      sumSkew += (samples[i] - intervals[i]) / 1000.0;\n+      // Bug: Integer truncation with Math.floor inside skew accumulator\n+      sumSkew += Math.floor((samples[i] - intervals[i]) / 1000);\n     }\n     return sumSkew / samples.length;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "performance",
        "severity": "P1",
        "path": "rtp_media_gateway/src/jitterBuffer.ts",
        "line": 178,
        "title": "Integer Truncation in Jitter Clock Drift Math",
        "description": "Premature Math.floor integer truncation in the per-sample clock skew calculation zeros out sub-millisecond network jitter drift, preventing the adaptive jitter buffer from detecting gradual clock divergence.",
        "category": "calculation_precision",
        "suggestion": "Preserve floating-point precision during per-sample skew accumulation."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-haystack-sip-cancel-timer-leak",
    "name": "Missing Timer Cancellation on SIP CANCEL Branch",
    "category": "performance",
    "description": "SIP transaction state machine transitions to TERMINATED upon receiving CANCEL but forgets to clear active Timer A retransmit timer.",
    "tags": [
      "telecom",
      "sip",
      "performance",
      "timer-leak",
      "haystack",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2109,
      "title": "refactor(sip): RFC 3261 transaction state machine timer cleanup",
      "headSha": "a1b2c3d4e5f67890123456789012345678902109",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "sip-protocol-dev",
      "body": "Refactors SIP client transaction state transitions and timer teardown lifecycle."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/sipStateMachine.ts",
        "patch": "@@ -208,11 +208,11 @@\n   private timerA: NodeJS.Timeout | null = null;\n   private timerB: NodeJS.Timeout | null = null;\n \n   public handleCancel(): void {\n     if (this.state === CallState.PROCEEDING || this.state === CallState.CALLING) {\n       this.state = CallState.TERMINATED;\n-      if (this.timerA) clearTimeout(this.timerA);\n       if (this.timerB) clearTimeout(this.timerB);\n+      // Bug: Forgot to clearTimeout(this.timerA) causing timer handle leak\n     }\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "performance",
        "severity": "P1",
        "path": "sip_signaling_service/src/sipStateMachine.ts",
        "line": 215,
        "title": "Missing Timer Cancellation on SIP CANCEL Branch",
        "description": "The CANCEL transition handler clears Timer B but omits clearTimeout on Timer A, causing retransmission timers to keep firing in the background and leaking timer resources.",
        "category": "timer_leak",
        "suggestion": "Add if (this.timerA) { clearTimeout(this.timerA); this.timerA = null; } in the handleCancel method."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-haystack-cdr-unbatched-bulk-insert",
    "name": "Single-Row Transaction Loop in CDR Bulk Ingest",
    "category": "performance",
    "description": "High-throughput batch SQL logger refactored to execute single-row INSERT statements inside an individual loop instead of a parameterized multi-value batch.",
    "tags": [
      "telecom",
      "cdr",
      "performance",
      "n-plus-one",
      "database",
      "haystack",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2110,
      "title": "perf(cdr): batch SQL logger connection pooling and transaction manager",
      "headSha": "a1b2c3d4e5f67890123456789012345678902110",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "db-scale-eng",
      "body": "Re-architects CDR batch logger for concurrent PostgreSQL transaction pools."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/batchSqlLogger.ts",
        "patch": "@@ -91,6 +91,12 @@\n   public async flushBatch(records: CallDetailRecord[]): Promise<void> {\n     if (records.length === 0) return;\n-    const query = this.buildMultiRowInsertQuery(records);\n-    await this.db.query(query.text, query.values);\n+    // Bug: Replaced multi-row batch insert with sequential single-row transaction loop\n+    for (const record of records) {\n+      await this.db.query('INSERT INTO tenant_cdrs (id, tenant_id, duration) VALUES ($1, $2, $3)', [\n+        record.id,\n+        record.tenantId,\n+        record.duration,\n+      ]);\n+    }\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "performance",
        "severity": "P1",
        "path": "cdr_pipeline/src/batchSqlLogger.ts",
        "line": 94,
        "title": "Single-Row Transaction Loop in CDR Bulk Ingest",
        "description": "The flushBatch method executes sequential single-row INSERT queries in an unbatched loop instead of a single multi-value batch insert, causing extreme network round-trip overhead and connection pool exhaustion.",
        "category": "n_plus_one_sql",
        "suggestion": "Use parameterized multi-row insert statements or PostgreSQL COPY protocol for batch operations."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-haystack-pbx-ssrf-webhook-url",
    "name": "Missing Private IP Filter in Webhook Dispatcher",
    "category": "security",
    "description": "PBX CTI webhook dispatcher accepts custom webhook URLs without blocking loopback or RFC 1918 private subnets, enabling Server-Side Request Forgery.",
    "tags": [
      "telecom",
      "pbx",
      "security",
      "ssrf",
      "owasp-a10",
      "haystack",
      "p0"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2111,
      "title": "feat(pbx): custom customer webhook endpoint registration",
      "headSha": "a1b2c3d4e5f67890123456789012345678902111",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "integration-dev",
      "body": "Allows enterprise PBX tenants to register external webhook notification endpoints."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/ctiWebhookDispatcher.ts",
        "patch": "@@ -37,12 +37,10 @@\n   public validateDestinationUrl(destinationUrl: string): boolean {\n     try {\n       const parsed = new URL(destinationUrl);\n-      if (['localhost', '127.0.0.1', '169.254.169.254'].includes(parsed.hostname)) {\n-        return false;\n-      }\n-      return parsed.protocol === 'https:';\n+      // Bug: Removed private IP and cloud metadata filter checks\n+      return parsed.protocol === 'http:' || parsed.protocol === 'https:';\n     } catch {\n       return false;\n     }\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "security",
        "severity": "P0",
        "path": "pbx_device_manager/src/ctiWebhookDispatcher.ts",
        "line": 41,
        "title": "Missing Private IP Filter in Webhook Dispatcher",
        "description": "The destination URL validator removes hostname and private IP validation, allowing tenants to configure internal network destinations (e.g. AWS metadata endpoint 169.254.169.254, internal microservices) and triggering Server-Side Request Forgery.",
        "category": "ssrf_vulnerability",
        "suggestion": "Enforce strict hostname resolution and deny private RFC 1918 addresses, loopback, and cloud metadata IPs."
      }
    ],
    "expectedVerdict": "BLOCK"
  },
  {
    "id": "telecom-haystack-rtp-g711-sign-bit-flip",
    "name": "Flipped Sign Bit Mask in G.711 μ-law Compander",
    "category": "architecture",
    "description": "Inverted bitwise sign mask in ITU-T G.711 μ-law compander causes negative audio samples to be encoded with positive sign bit.",
    "tags": [
      "telecom",
      "rtp",
      "codecs",
      "g711",
      "architecture",
      "haystack",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2112,
      "title": "refactor(codecs): bitwise ITU-T G.711 companding optimization",
      "headSha": "a1b2c3d4e5f67890123456789012345678902112",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "dsp-media-team",
      "body": "Optimizes linear PCM to G.711 companding using bitwise table lookup accelerators."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/audioCodecs.ts",
        "patch": "@@ -61,10 +61,11 @@\n   public encodeG711UlawSample(pcm16: number): number {\n-    const sign = (pcm16 < 0) ? 0x80 : 0x00;\n-    let sample = pcm16 < 0 ? -pcm16 : pcm16;\n+    // Bug: Inverted sign determination logic in compander\n+    const sign = (pcm16 > 0) ? 0x80 : 0x00;\n+    let sample = Math.abs(pcm16);\n     if (sample > 32767) sample = 32767;\n     sample += 0x84;\n     const exponent = this.computeExponent(sample);\n     const mantissa = (sample >> (exponent + 3)) & 0x0F;\n     return ~(sign | (exponent << 4) | mantissa) & 0xFF;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "rtp_media_gateway/src/audioCodecs.ts",
        "line": 63,
        "title": "Flipped Sign Bit Mask in G.711 μ-law Compander",
        "description": "The sign calculation in G.711 μ-law encoding tests for positive values (pcm16 > 0) rather than negative values to set sign bit 0x80, inverting the sign mask and corrupting audio output with loud clipping noise.",
        "category": "codec_corruption",
        "suggestion": "Restore sign test: const sign = (pcm16 < 0) ? 0x80 : 0x00;"
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-haystack-sip-blind-transfer-dangling-leg",
    "name": "Unsent BYE to Transferor Leg on NOTIFY 200 OK",
    "category": "architecture",
    "description": "Blind call transfer coordinator does not emit a SIP BYE request to the original transferor call leg upon receiving a successful 200 OK NOTIFY.",
    "tags": [
      "telecom",
      "sip",
      "transfer",
      "architecture",
      "haystack",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2113,
      "title": "feat(sip): RFC 3515 blind and attended call transfer state machine",
      "headSha": "a1b2c3d4e5f67890123456789012345678902113",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "telecom-core-dev",
      "body": "Implements RFC 3515 SIP REFER / NOTIFY transfer orchestration."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/callTransferCoordinator.ts",
        "patch": "@@ -138,10 +138,11 @@\n   public handleNotifyResponse(transferSessionId: string, statusCode: number): void {\n     const session = this.transferSessions.get(transferSessionId);\n     if (!session) return;\n \n     if (statusCode === 200) {\n       session.state = 'COMPLETED';\n-      this.sipServer.sendBye(session.transferorCallId);\n+      // Bug: Omitted sending BYE to transferor leg after successful REFER NOTIFY\n+      this.logger.info(`Transfer session ${transferSessionId} completed successfully`);\n     }\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "sip_signaling_service/src/callTransferCoordinator.ts",
        "line": 145,
        "title": "Unsent BYE to Transferor Leg on NOTIFY 200 OK",
        "description": "When the transfer target answers and NOTIFY 200 OK is received, the coordinator sets session state to COMPLETED but omits sending a BYE request to the transferor call leg, leaving the transferor channel connected and accumulating billing time.",
        "category": "protocol_state_machine",
        "suggestion": "Call this.sipServer.sendBye(session.transferorCallId) upon receiving successful NOTIFY 200 OK."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-haystack-cdr-quota-negative-balance-bypass",
    "name": "Post-Increment Deduction Bypasses Minute Quota",
    "category": "security",
    "description": "Multi-tenant quota tracker checks balance > 0 before allowing call setup but deducts consumed minutes only after call completion without locking.",
    "tags": [
      "telecom",
      "cdr",
      "quota",
      "security",
      "haystack",
      "p0"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2114,
      "title": "refactor(quota): asynchronous minute balance tracking and reservation",
      "headSha": "a1b2c3d4e5f67890123456789012345678902114",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "billing-sec-eng",
      "body": "Refactors tenant minute quota tracker for high concurrency."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/tenantQuotaTracker.ts",
        "patch": "@@ -48,7 +48,7 @@\n   public canInitiateCall(tenantId: string): boolean {\n     const quota = this.quotas.get(tenantId);\n     if (!quota) return true;\n-    const available = quota.allocatedMinutes - quota.usedMinutes - quota.reservedMinutes;\n-    return available > 0;\n+    // Bug: Ignores active reserved minutes allowing unbounded overdraft\n+    return quota.allocatedMinutes > quota.usedMinutes;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "security",
        "severity": "P0",
        "path": "cdr_pipeline/src/tenantQuotaTracker.ts",
        "line": 52,
        "title": "Post-Increment Deduction Bypasses Minute Quota",
        "description": "The canInitiateCall check ignores reservedMinutes for currently active calls, allowing tenants with only 1 remaining minute to launch hundreds of concurrent calls and incur massive unpaid telecommunication billing overdrafts.",
        "category": "quota_bypass",
        "suggestion": "Account for active reserved minutes: return (quota.allocatedMinutes - quota.usedMinutes - quota.reservedMinutes) > 0;"
      }
    ],
    "expectedVerdict": "BLOCK"
  },
  {
    "id": "telecom-haystack-pbx-trunk-circuit-breaker-reset",
    "name": "Missing Success Reset in Trunk Circuit Breaker",
    "category": "performance",
    "description": "PBX carrier trunk group allocator accumulates failover error counts but never resets the consecutive failure counter on successful call allocations.",
    "tags": [
      "telecom",
      "pbx",
      "performance",
      "circuit-breaker",
      "haystack",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2115,
      "title": "refactor(trunk): carrier circuit breaker and failover state machine",
      "headSha": "a1b2c3d4e5f67890123456789012345678902115",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "carrier-ops",
      "body": "Upgrades carrier SIP trunk health monitor with automatic circuit breakers."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/trunkAllocator.ts",
        "patch": "@@ -114,7 +114,8 @@\n   public recordTrunkSuccess(trunkId: string): void {\n     const trunk = this.trunks.get(trunkId);\n     if (!trunk) return;\n-    trunk.consecutiveFailures = 0;\n     trunk.state = 'HEALTHY';\n+    // Bug: Removed resetting consecutiveFailures to 0 on success\n+    this.logger.info(`Trunk ${trunkId} marked healthy`);\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "performance",
        "severity": "P1",
        "path": "pbx_device_manager/src/trunkAllocator.ts",
        "line": 119,
        "title": "Missing Success Reset in Trunk Circuit Breaker",
        "description": "The recordTrunkSuccess method marks trunk state as HEALTHY but fails to reset consecutiveFailures to 0, causing the next intermittent failure to immediately trip the circuit breaker.",
        "category": "circuit_breaker_logic",
        "suggestion": "Reset trunk.consecutiveFailures = 0 upon successful call routing."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-haystack-rtp-rtcp-sr-timestamp-wraparound",
    "name": "Signed 32-bit Integer Overflow in RTCP Timestamp",
    "category": "architecture",
    "description": "RTCP Sender Report generator performs signed 32-bit arithmetic casting timestamps to negative values when RTP timestamp wraps past 2^31.",
    "tags": [
      "telecom",
      "rtp",
      "rtcp",
      "architecture",
      "rfc3550",
      "haystack",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2116,
      "title": "refactor(rtcp): RFC 3550 sender and receiver report telemetry",
      "headSha": "a1b2c3d4e5f67890123456789012345678902116",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-plane-eng",
      "body": "Implements RFC 3550 RTCP Sender Report and Receiver Report statistics calculation."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/rtcpReporter.ts",
        "patch": "@@ -78,9 +78,10 @@\n   public formatSenderReport(ssrc: number, rtpTimestamp: number, packetCount: number, octetCount: number): Buffer {\n     const buffer = Buffer.alloc(28);\n     buffer.writeUInt32BE(ssrc, 4);\n-    buffer.writeUInt32BE(rtpTimestamp >>> 0, 16);\n+    // Bug: Using signed bitwise conversion (rtpTimestamp | 0) with writeInt32BE causes negative timestamps\n+    buffer.writeInt32BE(rtpTimestamp | 0, 16);\n     buffer.writeUInt32BE(packetCount, 20);\n     buffer.writeUInt32BE(octetCount, 24);\n     return buffer;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "rtp_media_gateway/src/rtcpReporter.ts",
        "line": 82,
        "title": "Signed 32-bit Integer Overflow in RTCP Timestamp",
        "description": "Using writeInt32BE with (rtpTimestamp | 0) treats 32-bit unsigned RTP timestamps as signed integers, generating negative timestamp fields in RTCP Sender Reports when the timestamp exceeds 0x7FFFFFFF and breaking remote QoS jitter calculations.",
        "category": "rfc_compliance",
        "suggestion": "Use buffer.writeUInt32BE(rtpTimestamp >>> 0, 16) for 32-bit unsigned RTP timestamp serialization."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-haystack-sip-route-header-reflection",
    "name": "Reflected Untrusted Record-Route Enables Open Relay",
    "category": "security",
    "description": "SIP call router reflects untrusted client Record-Route headers directly into the dialog Route-set without verifying proxy domain authority.",
    "tags": [
      "telecom",
      "sip",
      "security",
      "open-relay",
      "haystack",
      "p0"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2117,
      "title": "refactor(router): SIP loose routing and Record-Route set handling",
      "headSha": "a1b2c3d4e5f67890123456789012345678902117",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "routing-security",
      "body": "Refactors RFC 3261 loose routing and proxy Route header construction."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/callRouter.ts",
        "patch": "@@ -165,4 +165,5 @@\n   public buildOutboundRouteSet(inboundRecordRoutes: string[]): string[] {\n-    return inboundRecordRoutes.filter(route => this.isTrustedProxy(route));\n+    // Bug: Blindly copying all inbound Record-Route entries without domain validation\n+    return [...inboundRecordRoutes];\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "security",
        "severity": "P0",
        "path": "sip_signaling_service/src/callRouter.ts",
        "line": 167,
        "title": "Reflected Untrusted Record-Route Enables Open Relay",
        "description": "The outbound route-set generator copies unvalidated Record-Route headers from inbound SIP requests into outbound routing sets, allowing external untrusted entities to steer SIP signaling through arbitrary third-party relays.",
        "category": "sip_open_relay",
        "suggestion": "Filter Record-Route entries against a whitelist of trusted internal proxy domain patterns."
      }
    ],
    "expectedVerdict": "BLOCK"
  },
  {
    "id": "telecom-haystack-cdr-rate-deck-prefix-longest-match",
    "name": "Unsorted Array Search Replaces Longest Prefix Match",
    "category": "architecture",
    "description": "Tariff rating engine replaces Radix Trie with unsorted array search returning first prefix match instead of longest specific match.",
    "tags": [
      "telecom",
      "cdr",
      "rating",
      "architecture",
      "haystack",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2118,
      "title": "refactor(cdr): simplified rate card prefix lookup for small rate sheets",
      "headSha": "a1b2c3d4e5f67890123456789012345678902118",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "billing-eng",
      "body": "Replaces Trie rate card lookup with fast in-memory array filtering."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/tariffRatingEngine.ts",
        "patch": "@@ -89,6 +89,5 @@\n   public findMatchingRate(e164Number: string, rateDeck: RateEntry[]): RateEntry | null {\n-    // Longest prefix match using length sorted lookup\n-    const sorted = [...rateDeck].sort((a, b) => b.prefix.length - a.prefix.length);\n-    return sorted.find(r => e164Number.startsWith(r.prefix)) || null;\n+    // Bug: Searching unsorted array returns first matching prefix instead of longest match\n+    return rateDeck.find(r => e164Number.startsWith(r.prefix)) || null;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "cdr_pipeline/src/tariffRatingEngine.ts",
        "line": 91,
        "title": "Unsorted Array Search Replaces Longest Prefix Match",
        "description": "Searching an unsorted rate table with Array.find returns the first arbitrary matching prefix (e.g. '+1' US general) rather than the most specific longest prefix (e.g. '+1415' San Francisco premium), resulting in severe tariff calculation errors.",
        "category": "longest_prefix_match",
        "suggestion": "Sort rate entries by prefix length descending or utilize an E.164 Radix Trie."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-haystack-pbx-device-auth-timing-attack",
    "name": "Non-Constant Time Password Comparison",
    "category": "security",
    "description": "Digest authentication credential validation uses non-constant time string equality instead of crypto.timingSafeEqual.",
    "tags": [
      "telecom",
      "pbx",
      "security",
      "timing-attack",
      "haystack",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2119,
      "title": "refactor(auth): MD5 digest challenge response validator",
      "headSha": "a1b2c3d4e5f67890123456789012345678902119",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "security-team",
      "body": "Refactors MD5 challenge response comparison logic."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/digestAuth.ts",
        "patch": "@@ -76,5 +76,5 @@\n   public verifyResponse(expectedDigest: string, clientDigest: string): boolean {\n-    if (expectedDigest.length !== clientDigest.length) return false;\n-    return crypto.timingSafeEqual(Buffer.from(expectedDigest), Buffer.from(clientDigest));\n+    // Bug: Direct string comparison vulnerable to timing side-channels\n+    return expectedDigest === clientDigest;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "security",
        "severity": "P1",
        "path": "pbx_device_manager/src/digestAuth.ts",
        "line": 78,
        "title": "Non-Constant Time Password Comparison",
        "description": "Comparing digest authentication hashes using === string equality introduces a timing side-channel that allows attackers to iteratively deduce digest characters via response latency measurement.",
        "category": "timing_attack",
        "suggestion": "Use crypto.timingSafeEqual with equal length buffer checks."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-haystack-rtp-packet-loss-concealment-leak",
    "name": "Buffer Allocation in Loop During Packet Loss",
    "category": "performance",
    "description": "Jitter buffer allocates new 160-byte audio buffers inside the high-frequency packet loss concealment loop instead of reusing pre-allocated silence buffers.",
    "tags": [
      "telecom",
      "rtp",
      "performance",
      "gc-churn",
      "haystack",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2120,
      "title": "perf(rtp): ITU-T G.711 Appendix I packet loss concealment",
      "headSha": "a1b2c3d4e5f67890123456789012345678902120",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-dsp",
      "body": "Adds ITU-T packet loss concealment interpolation for lost audio frames."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/jitterBuffer.ts",
        "patch": "@@ -230,8 +230,10 @@\n   public generateConcealmentFrames(lostCount: number): Buffer[] {\n     const frames: Buffer[] = [];\n     for (let i = 0; i < lostCount; i++) {\n-      frames.push(this.staticSilenceFrame);\n+      // Bug: Fresh 160-byte buffer allocation per lost packet in high-rate loop\n+      const frame = Buffer.alloc(160, 0xFF);\n+      frames.push(frame);\n     }\n     return frames;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "performance",
        "severity": "P1",
        "path": "rtp_media_gateway/src/jitterBuffer.ts",
        "line": 234,
        "title": "Buffer Allocation in Loop During Packet Loss",
        "description": "Allocating a new Buffer in a tight loop during packet loss bursts generates immense garbage collection heap churn (thousands of short-lived buffers/sec per stream), increasing event-loop latency.",
        "category": "garbage_collection_churn",
        "suggestion": "Reuse a shared static or pooled Buffer instance for synthetic concealment frames."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-haystack-sip-re-invite-glare-491",
    "name": "Returns 500 Instead of 491 on Re-INVITE Glare",
    "category": "architecture",
    "description": "SIP dialog manager responds with 500 Internal Server Error instead of RFC 3261 Section 14.2 491 Request Pending when a re-INVITE arrives while a local re-INVITE is in flight.",
    "tags": [
      "telecom",
      "sip",
      "glare",
      "architecture",
      "rfc3261",
      "haystack",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2121,
      "title": "refactor(sip): mid-dialog re-INVITE glare and session renegotiation",
      "headSha": "a1b2c3d4e5f67890123456789012345678902121",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "telecom-core-dev",
      "body": "Refactors mid-call SDP renegotiation and re-INVITE glare handling."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/dialogManager.ts",
        "patch": "@@ -193,9 +193,10 @@\n   public handleIncomingReInvite(dialogId: string): number {\n     const dialog = this.dialogs.get(dialogId);\n     if (!dialog) return 481;\n     if (dialog.hasPendingLocalReInvite) {\n-      return 491; // RFC 3261 Request Pending (glare resolution)\n+      // Bug: Returning 500 Server Error aborts the call instead of triggering standard 491 backoff\n+      return 500;\n     }\n     return 200;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "sip_signaling_service/src/dialogManager.ts",
        "line": 198,
        "title": "Returns 500 Instead of 491 on Re-INVITE Glare",
        "description": "Returning 500 Internal Server Error during re-INVITE glare violates RFC 3261 Section 14.2, terminating the call session rather than signalling the peer to retry after a randomized backoff interval.",
        "category": "rfc_compliance",
        "suggestion": "Return 491 (Request Pending) when a re-INVITE is received while a local re-INVITE transaction is active."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-haystack-cdr-destructive-drop-partition",
    "name": "Immediate DROP TABLE Without Month Validation",
    "category": "database",
    "description": "CDR cleanup database maintenance script issues unconditional DROP TABLE on target tables without verifying retention age.",
    "tags": [
      "telecom",
      "cdr",
      "database",
      "data-loss",
      "haystack",
      "p0"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2122,
      "title": "feat(cdr): automated partition pruning and retention cleaner",
      "headSha": "a1b2c3d4e5f67890123456789012345678902122",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "db-admin",
      "body": "Automated retention policy execution for expired CDR partitions."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/batchSqlLogger.ts",
        "patch": "@@ -9,8 +9,6 @@\n export class PartitionCleaner {\n   public buildDropQuery(tableName: string, cutoffMonth: string): string {\n-    if (!tableName.startsWith('cdrs_') || tableName >= `cdrs_${cutoffMonth}`) {\n-      throw new Error('Refusing to drop active or unverified partition');\n-    }\n-    return `DROP TABLE IF EXISTS ${tableName} CASCADE;`;\n+    // Bug: Dropped safety cutoff validation, allowing active tables to be dropped\n+    return `DROP TABLE IF EXISTS ${tableName} CASCADE;`;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "database",
        "severity": "P0",
        "path": "cdr_pipeline/src/batchSqlLogger.ts",
        "line": 12,
        "title": "Immediate DROP TABLE Without Month Validation",
        "description": "The partition drop query builder removes the safeguard checking whether the table name is older than the retention cutoffMonth, allowing active or future billing partitions to be permanently dropped.",
        "category": "destructive_migration",
        "suggestion": "Verify that tableName strictly precedes the retention cutoff date before constructing DROP TABLE statements."
      }
    ],
    "expectedVerdict": "BLOCK"
  },
  {
    "id": "telecom-haystack-pbx-webhook-hmac-truncation",
    "name": "HMAC-SHA256 Truncation to 8 Hex Characters",
    "category": "security",
    "description": "PBX CTI webhook dispatcher truncates HMAC-SHA256 signature to 8 hex characters, reducing signature entropy to 32 bits.",
    "tags": [
      "telecom",
      "pbx",
      "security",
      "hmac",
      "crypto",
      "haystack",
      "p0"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2123,
      "title": "refactor(webhook): HMAC-SHA256 signature header formatting",
      "headSha": "a1b2c3d4e5f67890123456789012345678902123",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "security-team",
      "body": "Refactors webhook HMAC signing headers for downstream CTI webhook consumers."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/ctiWebhookDispatcher.ts",
        "patch": "@@ -84,6 +84,7 @@\n   public signPayload(payload: string, secret: string): string {\n     const hmac = crypto.createHmac('sha256', secret);\n     hmac.update(payload);\n-    return hmac.digest('hex');\n+    // Bug: Truncating HMAC-SHA256 to 8 hex characters reduces entropy to 32 bits\n+    return hmac.digest('hex').slice(0, 8);\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "security",
        "severity": "P0",
        "path": "pbx_device_manager/src/ctiWebhookDispatcher.ts",
        "line": 88,
        "title": "HMAC-SHA256 Truncation to 8 Hex Characters",
        "description": "Truncating the HMAC-SHA256 digest to 8 hexadecimal characters reduces the signature key space from 256 bits to only 32 bits (4 billion possibilities), allowing trivial signature forgery via brute-force attack.",
        "category": "cryptographic_weakness",
        "suggestion": "Return the complete 64-character hex string from hmac.digest('hex')."
      }
    ],
    "expectedVerdict": "BLOCK"
  },
  {
    "id": "telecom-haystack-rtp-opus-packetization-boundary",
    "name": "Missing Padding on Odd-Length Opus Frame Slices",
    "category": "architecture",
    "description": "Opus audio payload packetizer fails to enforce 16-bit word alignment padding on variable-length compressed frames.",
    "tags": [
      "telecom",
      "rtp",
      "codecs",
      "opus",
      "architecture",
      "haystack",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2124,
      "title": "feat(rtp): variable bitrate Opus frame packetization",
      "headSha": "a1b2c3d4e5f67890123456789012345678902124",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-plane-eng",
      "body": "Implements RFC 7587 Opus audio packetization and framing."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/audioCodecs.ts",
        "patch": "@@ -45,8 +45,5 @@\n   public packetizeOpusFrame(frameData: Buffer): Buffer {\n-    const isOdd = frameData.length % 2 !== 0;\n-    const totalLength = isOdd ? frameData.length + 1 : frameData.length;\n-    const packet = Buffer.alloc(totalLength);\n-    frameData.copy(packet, 0);\n-    return packet;\n+    // Bug: Removed 16-bit word alignment padding on odd-length Opus frames\n+    return Buffer.from(frameData);\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "rtp_media_gateway/src/audioCodecs.ts",
        "line": 47,
        "title": "Missing Padding on Odd-Length Opus Frame Slices",
        "description": "Returning raw unaligned Buffers for odd-length Opus frames without 16-bit word boundary alignment causes memory alignment faults and truncated packet reads on downstream hardware media bridges.",
        "category": "packetization_alignment",
        "suggestion": "Ensure payload length is padded to even byte boundary or set the RTP header padding bit appropriately."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  }
];
