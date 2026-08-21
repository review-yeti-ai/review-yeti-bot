// =========================================================================
// 11. TELECOM BENCHMARK EXPANSION - CROSS-MODULE CONTRACT BREAKAGES (PR #2125-#2148)
// =========================================================================

export const CROSS_MODULE_SCENARIOS = [
  {
    "id": "telecom-cross-sip-event-payload-rename",
    "name": "Event Payload Rename callId -> sipCallId Breaks CDR Ingestion",
    "category": "architecture",
    "description": "Modifying SIP server event payload key from callId to sipCallId passes local signaling tests but breaks unmodified cdr_pipeline ingestion listeners.",
    "tags": [
      "telecom",
      "cross-module",
      "sip",
      "cdr",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "code_search",
        "query": "onCallEvent",
        "expectedSubstring": "cdrIngestion.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2125,
      "title": "refactor(sip): standardize signaling event payload properties",
      "headSha": "a1b2c3d4e5f67890123456789012345678902125",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "sip-team",
      "body": "Standardizes signaling event property naming for SIP dialog tracking."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/sipServer.ts",
        "patch": "@@ -30,8 +30,9 @@\n   public emitCallEvent(eventName: string, callId: string, state: string): void {\n     this.eventBus.emit('call_event', {\n-      callId,\n+      // Breaking contract change: renamed callId to sipCallId without updating cdr_pipeline\n+      sipCallId: callId,\n       state,\n       timestamp: Date.now(),\n     });\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "sip_signaling_service/src/sipServer.ts",
        "line": 33,
        "title": "Event Payload Rename callId -> sipCallId Breaks CDR Ingestion",
        "description": "Renaming event property callId to sipCallId in the shared call_event payload breaks downstream event consumers in cdr_pipeline/src/cdrIngestion.ts which extract event.callId to record call progress.",
        "category": "cross_module_contract_breakage",
        "suggestion": "Maintain backwards compatibility by emitting both callId and sipCallId or updating all subscriber modules across the monorepo."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-rtp-port-async-release",
    "name": "Async Port Release Signature Breaks Synchronous Callers",
    "category": "architecture",
    "description": "Changing PortAllocator.releasePort from synchronous to async Promise<void> causes synchronous callers in sip_signaling_service to miss unhandled rejections and fail deallocations.",
    "tags": [
      "telecom",
      "cross-module",
      "rtp",
      "sip",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "code_search",
        "query": "portAllocator.releasePort",
        "expectedSubstring": "sipStateMachine.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2126,
      "title": "refactor(rtp): asynchronous port deallocation with Redis cooldown",
      "headSha": "a1b2c3d4e5f67890123456789012345678902126",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-plane-eng",
      "body": "Makes port deallocation async to support distributed Redis cooldown timers."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/portAllocator.ts",
        "patch": "@@ -23,4 +23,6 @@\n-  public releasePort(port: number): void {\n+  // Breaking contract change: changed return type from void to Promise<void>\n+  public async releasePort(port: number): Promise<void> {\n     this.allocatedPorts.delete(port);\n+    await this.redisCooldownStore.set(`cooldown:${port}`, Date.now());\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "rtp_media_gateway/src/portAllocator.ts",
        "line": 24,
        "title": "Async Port Release Signature Breaks Synchronous Callers",
        "description": "Making releasePort asynchronous breaks callers like sip_signaling_service/src/sipStateMachine.ts that call releasePort synchronously in destructor teardown handlers without awaiting the returned promise.",
        "category": "breaking_api_signature",
        "suggestion": "Keep synchronous releasePort or update all callers in sip_signaling_service to await the asynchronous deallocation."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-pbx-trunk-capacity-object",
    "name": "Trunk Capacity Structure Change Breaks SIP Call Router",
    "category": "architecture",
    "description": "Refactoring TrunkGroup.capacity from number to an object breaks arithmetic channel comparisons in sip_signaling_service call router.",
    "tags": [
      "telecom",
      "cross-module",
      "pbx",
      "sip",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "code_search",
        "query": "trunk.capacity",
        "expectedSubstring": "callRouter.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2127,
      "title": "refactor(pbx): structured trunk capacity with burst channels",
      "headSha": "a1b2c3d4e5f67890123456789012345678902127",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "carrier-team",
      "body": "Refactors trunk capacity to support baseline and burst channel limits."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/models/trunkGroup.ts",
        "patch": "@@ -16,4 +16,8 @@\n   id: string;\n   name: string;\n-  capacity: number;\n+  // Breaking contract change: changed capacity from number to object\n+  capacity: {\n+    maxChannels: number;\n+    reservedChannels: number;\n+  };\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "pbx_device_manager/src/models/trunkGroup.ts",
        "line": 19,
        "title": "Trunk Capacity Structure Change Breaks SIP Call Router",
        "description": "Changing capacity from a primitive number to a structured object breaks downstream arithmetic expressions like `if (activeCalls >= trunk.capacity)` in sip_signaling_service/src/callRouter.ts, evaluating to false and causing channel oversubscription.",
        "category": "contract_schema_breakage",
        "suggestion": "Preserve numeric capacity getter on TrunkGroup or migrate callRouter.ts to use trunk.capacity.maxChannels."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-cdr-db-column-rename",
    "name": "Database Column Rename Breaks CDR Batch Ingestion Query",
    "category": "database",
    "description": "Modifying CDR batch insert query column name duration_sec to billed_seconds breaks unmodified database table schema in downstream analytics.",
    "tags": [
      "telecom",
      "cross-module",
      "cdr",
      "database",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "file_read",
        "query": "cdr_pipeline/src/models/callDetailRecord.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2128,
      "title": "refactor(cdr): rename duration_sec column to billed_seconds",
      "headSha": "a1b2c3d4e5f67890123456789012345678902128",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "db-eng",
      "body": "Updates SQL batch insert column names for billing clarity."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/batchSqlLogger.ts",
        "patch": "@@ -13,7 +13,8 @@\n   public buildInsertSql(): string {\n     return `\n-      INSERT INTO tenant_cdrs (id, tenant_id, duration_sec, cost)\n+      -- Breaking schema change: renamed duration_sec to billed_seconds\n+      INSERT INTO tenant_cdrs (id, tenant_id, billed_seconds, cost)\n       VALUES ($1, $2, $3, $4)\n     `;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "database",
        "severity": "P1",
        "path": "cdr_pipeline/src/batchSqlLogger.ts",
        "line": 15,
        "title": "Database Column Rename Breaks CDR Batch Ingestion Query",
        "description": "Renaming the insert target column from duration_sec to billed_seconds in batchSqlLogger without an expand-contract database migration causes runtime PostgreSQL column 'billed_seconds' does not exist errors on live tables.",
        "category": "database_schema_mismatch",
        "suggestion": "Use expand-contract migration: add billed_seconds with view or alias before changing insert queries."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-sip-sdp-codec-enum-split",
    "name": "Codec Enum Split Breaks RTP Transcoder Switch",
    "category": "architecture",
    "description": "Splitting CodecType.G711 into G711_ULAW and G711_ALAW in SIP signaling messages breaks un-updated switch branches in rtp_media_gateway.",
    "tags": [
      "telecom",
      "cross-module",
      "sip",
      "rtp",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "code_search",
        "query": "CodecType.G711",
        "expectedSubstring": "audioCodecs.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2129,
      "title": "refactor(sip): split G.711 codec enum into ULAW and ALAW variants",
      "headSha": "a1b2c3d4e5f67890123456789012345678902129",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "sip-protocol-dev",
      "body": "Distinguishes μ-law and A-law in SIP signaling codec enumerations."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/types/sipMessages.ts",
        "patch": "@@ -43,4 +43,6 @@\n   OPUS = 'opus',\n-  G711 = 'g711',\n+  // Breaking enum change: removed unified G711 enum value\n+  G711_ULAW = 'g711u',\n+  G711_ALAW = 'g711a',\n   TELEPHONE_EVENT = 'telephone-event',\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "sip_signaling_service/src/types/sipMessages.ts",
        "line": 45,
        "title": "Codec Enum Split Breaks RTP Transcoder Switch",
        "description": "Removing CodecType.G711 breaks downstream switch statements in rtp_media_gateway/src/audioCodecs.ts that rely on CodecType.G711, causing unrecognized codec exceptions during call bridging.",
        "category": "enum_breaking_change",
        "suggestion": "Deprecate CodecType.G711 as an alias or update all codec switch handlers across rtp_media_gateway."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-pbx-device-status-enum",
    "name": "Device Status Enum Rename Breaks Routing Checks",
    "category": "architecture",
    "description": "Changing EndpointStatus 'OFFLINE' to 'UNREGISTERED' in PBX device model breaks device reachability checks in SIP call router.",
    "tags": [
      "telecom",
      "cross-module",
      "pbx",
      "sip",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "code_search",
        "query": "EndpointStatus.OFFLINE",
        "expectedSubstring": "callRouter.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2130,
      "title": "refactor(pbx): clarify endpoint lifecycle statuses",
      "headSha": "a1b2c3d4e5f67890123456789012345678902130",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "pbx-core",
      "body": "Renames endpoint offline status to unregistered for RFC compliance."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/models/sipEndpoint.ts",
        "patch": "@@ -11,4 +11,5 @@\n   AVAILABLE = 'AVAILABLE',\n   BUSY = 'BUSY',\n-  OFFLINE = 'OFFLINE',\n+  // Breaking enum change: renamed OFFLINE to UNREGISTERED\n+  UNREGISTERED = 'UNREGISTERED',\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "pbx_device_manager/src/models/sipEndpoint.ts",
        "line": 14,
        "title": "Device Status Enum Rename Breaks Routing Checks",
        "description": "Renaming EndpointStatus.OFFLINE to UNREGISTERED breaks reachability filtering in sip_signaling_service/src/callRouter.ts where endpoints with status OFFLINE are excluded from ringing groups.",
        "category": "enum_breaking_change",
        "suggestion": "Keep OFFLINE as an alias or update references across sip_signaling_service."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-rtp-jitter-buffer-sample-rate",
    "name": "Default Clock Rate Change Causes G.711 Timestamp Drift",
    "category": "architecture",
    "description": "Modifying JitterBuffer default sampling rate from 8000 Hz to 48000 Hz causes G.711 RTP packet handlers to calculate 6x playout delay error.",
    "tags": [
      "telecom",
      "cross-module",
      "rtp",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "file_read",
        "query": "rtp_media_gateway/src/rtpPacketHandler.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2131,
      "title": "feat(rtp): default jitter buffer to 48kHz HD voice sampling rate",
      "headSha": "a1b2c3d4e5f67890123456789012345678902131",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-team",
      "body": "Updates default jitter buffer clock rate for HD Opus audio streams."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/jitterBuffer.ts",
        "patch": "@@ -37,6 +37,7 @@\n-  private clockRate: number = 8000;\n+  // Breaking change: changed default clock rate to 48000 Hz without codec check\n+  private clockRate: number = 48000;\n \n   constructor(clockRate?: number) {\n     if (clockRate) this.clockRate = clockRate;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "rtp_media_gateway/src/jitterBuffer.ts",
        "line": 38,
        "title": "Default Clock Rate Change Causes G.711 Timestamp Drift",
        "description": "Setting default clockRate to 48000 Hz breaks narrowband G.711 streams instantiated without explicit clock rate in rtpPacketHandler.ts, causing RTP timestamp intervals to be miscalculated by 6x and creating severe audio underruns.",
        "category": "default_configuration_breakage",
        "suggestion": "Dynamically set clockRate based on negotiated codec (8000 for G.711, 48000 for Opus)."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-cdr-tenant-id-type-uuid",
    "name": "Strict UUID Tenant ID Rejects Numeric PBX Tenant Identifiers",
    "category": "database",
    "description": "Adding strict UUIDv4 validation to CDR record schema rejects integer string tenant identifiers emitted by PBX device manager.",
    "tags": [
      "telecom",
      "cross-module",
      "cdr",
      "pbx",
      "security",
      "p0"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "code_search",
        "query": "validateCdrRecord",
        "expectedSubstring": "cdrIngestion.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2132,
      "title": "refactor(cdr): strict UUIDv4 format validation on tenant identifiers",
      "headSha": "a1b2c3d4e5f67890123456789012345678902132",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "security-compliance",
      "body": "Enforces strict UUID format validation on incoming CDR tenant ID fields."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/models/callDetailRecord.ts",
        "patch": "@@ -21,3 +21,5 @@\n-  if (!record.tenantId || typeof record.tenantId !== 'string') return false;\n+  // Breaking validation: enforces strict UUIDv4 rejecting numeric PBX tenant IDs\n+  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;\n+  if (!uuidRegex.test(record.tenantId)) return false;\n   return true;\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "security",
        "severity": "P0",
        "path": "cdr_pipeline/src/models/callDetailRecord.ts",
        "line": 22,
        "title": "Strict UUID Tenant ID Rejects Numeric PBX Tenant Identifiers",
        "description": "Enforcing strict UUIDv4 validation rejects legitimate PBX tenant identifiers (such as 'tenant_1001' or integer IDs) produced by pbx_device_manager, causing 100% of non-UUID tenant CDRs to be silently rejected and unbilled.",
        "category": "contract_validation_breakage",
        "suggestion": "Support both UUID and alphanumeric legacy tenant ID formats: /^[a-zA-Z0-9_-]+$/."
      }
    ],
    "expectedVerdict": "BLOCK"
  },
  {
    "id": "telecom-cross-sip-transfer-callback-signature",
    "name": "Inverted Callback Parameters Break Error Propagation",
    "category": "architecture",
    "description": "Inverting CallTransferCoordinator callback parameters from (err, id) to (id, err) causes caller in sipServer to mistake errors for success IDs.",
    "tags": [
      "telecom",
      "cross-module",
      "sip",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "code_search",
        "query": "executeTransfer",
        "expectedSubstring": "sipServer.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2133,
      "title": "refactor(sip): modernize transfer callback signature",
      "headSha": "a1b2c3d4e5f67890123456789012345678902133",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "sip-team",
      "body": "Refactors asynchronous transfer callback arguments."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/callTransferCoordinator.ts",
        "patch": "@@ -50,6 +50,7 @@\n-  public executeTransfer(req: TransferRequest, callback: (err: Error | null, transferId?: string) => void): void {\n+  // Breaking callback change: inverted error-first Node.js convention\n+  public executeTransfer(req: TransferRequest, callback: (transferId: string | null, err?: Error) => void): void {\n     if (!req.targetUri) {\n-      return callback(new Error('Target URI missing'));\n+      return callback(null, new Error('Target URI missing'));\n     }\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "sip_signaling_service/src/callTransferCoordinator.ts",
        "line": 51,
        "title": "Inverted Callback Parameters Break Error Propagation",
        "description": "Inverting callback parameter order from error-first (err, transferId) to (transferId, err) violates Node.js conventions and breaks sipServer.ts which checks `if (err)` on the first argument, treating error objects as successful transfer IDs.",
        "category": "api_signature_breakage",
        "suggestion": "Maintain standard Node.js error-first callback signature (err, result) or migrate to async/Promise."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-pbx-webhook-header-rename",
    "name": "Signature Header Rename Breaks Consumer Verification",
    "category": "architecture",
    "description": "Renaming webhook HMAC header from X-Telecom-Sig to X-Sig-256 breaks all registered enterprise PBX webhook receivers.",
    "tags": [
      "telecom",
      "cross-module",
      "pbx",
      "webhooks",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "symbol_lookup",
        "query": "CtiWebhookDispatcher"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2134,
      "title": "refactor(webhook): modernize HTTP HMAC signature header name",
      "headSha": "a1b2c3d4e5f67890123456789012345678902134",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "cti-team",
      "body": "Updates signature header name to X-Sig-256 for standard compliance."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/ctiWebhookDispatcher.ts",
        "patch": "@@ -26,7 +26,8 @@\n   public buildHeaders(signature: string): Record<string, string> {\n     return {\n       'Content-Type': 'application/json',\n-      'X-Telecom-Sig': signature,\n+      // Breaking contract change: renamed public header\n+      'X-Sig-256': signature,\n     };\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "pbx_device_manager/src/ctiWebhookDispatcher.ts",
        "line": 30,
        "title": "Signature Header Rename Breaks Consumer Verification",
        "description": "Renaming public webhook HMAC signature header from X-Telecom-Sig to X-Sig-256 without dual-emission breaks signature verification for existing customer PBX webhook receivers.",
        "category": "public_contract_breakage",
        "suggestion": "Emit both X-Telecom-Sig and X-Sig-256 during a deprecation transition period."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-rtp-socket-close-semantics",
    "name": "Immediate Socket Destroy Drops Buffered Packets",
    "category": "architecture",
    "description": "MediaBridge.close immediately calls socket.destroy() before flushing outbound RTP packets queued in the media bridge.",
    "tags": [
      "telecom",
      "cross-module",
      "rtp",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "code_search",
        "query": "mediaBridge.close",
        "expectedSubstring": "sipStateMachine.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2135,
      "title": "refactor(media): instantaneous socket destruction on call teardown",
      "headSha": "a1b2c3d4e5f67890123456789012345678902135",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-plane-eng",
      "body": "Accelerates call teardown by immediately destroying media sockets."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/mediaBridge.ts",
        "patch": "@@ -72,5 +72,6 @@\n   public close(): void {\n-    this.flushPendingPackets();\n-    this.socket.close();\n+    // Breaking change: immediate socket destroy drops in-flight audio frames\n+    this.socket.destroy();\n+    this.isOpen = false;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "rtp_media_gateway/src/mediaBridge.ts",
        "line": 74,
        "title": "Immediate Socket Destroy Drops Buffered Packets",
        "description": "Calling socket.destroy() without flushing pending audio packets truncates the final 200-500ms of speech (such as goodbye phrases) upon call termination initiated by sip_signaling_service.",
        "category": "graceful_shutdown",
        "suggestion": "Call flushPendingPackets() before closing the media bridge socket."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-sip-uri-parser-strictness",
    "name": "Strict URI Parser Rejects Valid PBX Contact Headers",
    "category": "architecture",
    "description": "Modifying SIP URI parser in sipServer to strictly prohibit unquoted semicolon parameters rejects valid Contact headers emitted by PBX device registry.",
    "tags": [
      "telecom",
      "cross-module",
      "sip",
      "pbx",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "code_search",
        "query": "parseSipUri",
        "expectedSubstring": "deviceRegistry.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2136,
      "title": "refactor(sip): strict RFC 3261 URI grammar validation",
      "headSha": "a1b2c3d4e5f67890123456789012345678902136",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "sip-protocol-dev",
      "body": "Hardens SIP URI parser with strict RFC grammar checks."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/sipServer.ts",
        "patch": "@@ -57,4 +57,5 @@\n-  const uriRegex = /^sip:(?:([^@:]+)(?::([^@]+))?@)?([^;:]+)(?::(\\d+))?(?:;(.*))?$/;\n+  // Breaking regex change: rejects URI parameter strings containing transport or transport tags\n+  const uriRegex = /^sip:([^@]+)@([a-zA-Z0-9.-]+)(?::(\\d+))?$/;\n   const match = rawUri.match(uriRegex);\n   if (!match) throw new Error(`Invalid SIP URI: ${rawUri}`);\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "sip_signaling_service/src/sipServer.ts",
        "line": 58,
        "title": "Strict URI Parser Rejects Valid PBX Contact Headers",
        "description": "The simplified SIP URI regex rejects valid RFC 3261 Contact URIs containing parameters (such as `sip:alice@10.0.0.1:5060;transport=udp`) generated by pbx_device_manager/src/deviceRegistry.ts.",
        "category": "parser_rfc_compliance",
        "suggestion": "Preserve optional URI parameter parsing `(?:;(.*))?` in the SIP URI regular expression."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-cdr-rating-rounding-precision",
    "name": "Rating Cost Precision Reduction Causes Cumulative Invoicing Errors",
    "category": "architecture",
    "description": "Reducing tariff rating calculation intermediate precision from 6 decimal places to 2 decimal places causes significant financial drift across high-volume fractional rates.",
    "tags": [
      "telecom",
      "cross-module",
      "cdr",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "file_read",
        "query": "cdr_pipeline/src/tariffRatingEngine.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2137,
      "title": "refactor(cdr): round intermediate rating cost to 2 decimal places",
      "headSha": "a1b2c3d4e5f67890123456789012345678902137",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "billing-dev",
      "body": "Rounds call costs to standard two decimal currency figures."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/tariffRatingEngine.ts",
        "patch": "@@ -46,5 +46,6 @@\n   public computeCallCost(durationSec: number, ratePerMin: number): number {\n     const rawCost = (durationSec / 60.0) * ratePerMin;\n-    return Number(rawCost.toFixed(6));\n+    // Breaking precision change: rounds intermediate rate to 2 decimal places\n+    return Number(rawCost.toFixed(2));\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "cdr_pipeline/src/tariffRatingEngine.ts",
        "line": 49,
        "title": "Rating Cost Precision Reduction Causes Cumulative Invoicing Errors",
        "description": "Rounding call costs to 2 decimal places during rating causes sub-cent micro-rate calls (e.g. wholesale $0.004/min VoIP routing) to truncate to $0.00, resulting in catastrophic uncollected revenue across high call volumes.",
        "category": "financial_precision",
        "suggestion": "Preserve high precision (minimum 6 decimal places) in intermediate rating calculations and round only on monthly invoice totals."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-pbx-trunk-failover-code-array",
    "name": "Failover Codes Type Change From Set to Array Crashes Caller",
    "category": "architecture",
    "description": "Changing TrunkGroup.failoverCodes from Set<number> to number[] causes callers in trunkAllocator calling .has() to throw TypeError.",
    "tags": [
      "telecom",
      "cross-module",
      "pbx",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "code_search",
        "query": "failoverCodes.has",
        "expectedSubstring": "trunkAllocator.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2138,
      "title": "refactor(pbx): serialize failover codes as JSON array",
      "headSha": "a1b2c3d4e5f67890123456789012345678902138",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "pbx-team",
      "body": "Converts failover code set to array for direct JSON serialization."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/models/trunkGroup.ts",
        "patch": "@@ -25,3 +25,4 @@\n   id: string;\n-  failoverCodes: Set<number>;\n+  // Breaking type change: changed Set<number> to number[]\n+  failoverCodes: number[];\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "pbx_device_manager/src/models/trunkGroup.ts",
        "line": 27,
        "title": "Failover Codes Type Change From Set to Array Crashes Caller",
        "description": "Changing failoverCodes from Set<number> to number[] causes callers like `trunkAllocator.ts` that invoke `trunk.failoverCodes.has(statusCode)` to crash with TypeError: failoverCodes.has is not a function.",
        "category": "type_contract_breakage",
        "suggestion": "Use trunk.failoverCodes.includes() across callers or retain Set<number> with a custom JSON serializer."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-rtp-transcoder-buffer-reuse",
    "name": "Shared Static Audio Buffer Leaks Cross-Tenant Media Stream",
    "category": "security",
    "description": "Introducing a static singleton audio transcoding buffer in rtp_media_gateway allows concurrent call sessions across different tenants to bleed voice audio into each other.",
    "tags": [
      "telecom",
      "cross-module",
      "rtp",
      "security",
      "data-leak",
      "p0"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "code_search",
        "query": "AudioCodecs",
        "expectedSubstring": "mediaBridge.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2139,
      "title": "perf(rtp): static buffer caching to reduce GC allocations",
      "headSha": "a1b2c3d4e5f67890123456789012345678902139",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-perf-eng",
      "body": "Replaces per-packet buffer allocation with static reusable transcode buffer."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/audioCodecs.ts",
        "patch": "@@ -35,5 +35,7 @@\n-  public transcodeFrame(input: Buffer): Buffer {\n-    const output = Buffer.alloc(input.length * 2);\n+  // Breaking security flaw: shared static buffer across all concurrent channels\n+  private static sharedTranscodeBuffer = Buffer.alloc(8192);\n+  public transcodeFrame(input: Buffer): Buffer {\n+    const output = AudioCodecs.sharedTranscodeBuffer;\n     return output;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "security",
        "severity": "P0",
        "path": "rtp_media_gateway/src/audioCodecs.ts",
        "line": 36,
        "title": "Shared Static Audio Buffer Leaks Cross-Tenant Media Stream",
        "description": "Using a single static buffer shared across all transcoding instances causes concurrent calls to overwrite and read each other's audio payload frames, leaking live phone conversations across unrelated enterprise tenants.",
        "category": "cross_tenant_data_leak",
        "suggestion": "Allocate per-session transcode buffers or use a thread-safe buffer pool with isolation."
      }
    ],
    "expectedVerdict": "BLOCK"
  },
  {
    "id": "telecom-cross-sip-dialog-seq-counter",
    "name": "Fixed Initial CSeq Counter Predictability Vulnerability",
    "category": "architecture",
    "description": "Initializing dialog CSeq to constant 1 rather than randomized integer violates RFC 3261 and enables off-path dialog tear-down attacks.",
    "tags": [
      "telecom",
      "cross-module",
      "sip",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "symbol_lookup",
        "query": "DialogManager"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2140,
      "title": "refactor(sip): deterministic initial CSeq sequence numbers",
      "headSha": "a1b2c3d4e5f67890123456789012345678902140",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "sip-protocol-dev",
      "body": "Initializes CSeq to 1 for simplified unit testing and sequencing."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/dialogManager.ts",
        "patch": "@@ -61,4 +61,5 @@\n   public generateInitialCSeq(): number {\n-    return Math.floor(Math.random() * 100000) + 1;\n+    // Breaking change: Fixed initial CSeq sequence number\n+    return 1;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "sip_signaling_service/src/dialogManager.ts",
        "line": 63,
        "title": "Fixed Initial CSeq Counter Predictability Vulnerability",
        "description": "Hardcoding the initial CSeq to 1 violates RFC 3261 Section 12.2.1.1 which recommends random initial sequence numbers to prevent sequence prediction and forged BYE/CANCEL injection attacks by off-path adversaries.",
        "category": "cseq_predictability",
        "suggestion": "Use cryptographically random initial sequence numbers: crypto.randomInt(1, 2147483647)."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-cdr-batch-flush-interval",
    "name": "Extended Flush Interval Increases In-Memory Buffer Pressure",
    "category": "performance",
    "description": "Extending CDR batch flush interval from 1s to 60s increases in-memory record accumulation 60x and delays downstream billing telemetry.",
    "tags": [
      "telecom",
      "cross-module",
      "cdr",
      "performance",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "code_search",
        "query": "flushIntervalMs",
        "expectedSubstring": "batchSqlLogger.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2141,
      "title": "perf(cdr): reduce database write frequency by extending batch interval",
      "headSha": "a1b2c3d4e5f67890123456789012345678902141",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "db-admin",
      "body": "Increases flush interval to 60,000ms to reduce database IOPS."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/batchSqlLogger.ts",
        "patch": "@@ -17,2 +17,3 @@\n-  private flushIntervalMs: number = 1000;\n+  // Breaking performance change: 60x increase in batch flush delay\n+  private flushIntervalMs: number = 60000;\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "performance",
        "severity": "P1",
        "path": "cdr_pipeline/src/batchSqlLogger.ts",
        "line": 18,
        "title": "Extended Flush Interval Increases In-Memory Buffer Pressure",
        "description": "Increasing the batch flush interval from 1s to 60s causes up to 60,000 CDR objects to accumulate in memory under high call-rate conditions, inflating heap usage and risking massive unrecoverable data loss if the node crashes.",
        "category": "buffering_delay",
        "suggestion": "Keep flush interval under 2000ms or flush immediately when batch size reaches a maximum threshold (e.g. 1000 records)."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-pbx-device-expiry-heartbeat",
    "name": "Shortened Expiry Without Keepalive Causes Registration Storm",
    "category": "architecture",
    "description": "Cutting SIP registration expiry to 30 seconds without NAT keepalive causes 100,000 endpoints to bombard PBX registry with continuous re-registration requests.",
    "tags": [
      "telecom",
      "cross-module",
      "pbx",
      "sip",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "code_search",
        "query": "DEFAULT_REGISTRATION_EXPIRY",
        "expectedSubstring": "deviceRegistry.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2142,
      "title": "refactor(pbx): enforce fast registration expiry for NAT tracking",
      "headSha": "a1b2c3d4e5f67890123456789012345678902142",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "pbx-team",
      "body": "Lowers registration TTL to 30s for real-time NAT mapping."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/deviceRegistry.ts",
        "patch": "@@ -43,2 +43,3 @@\n-  public static readonly DEFAULT_EXPIRY: number = 3600;\n+  // Breaking change: reduced registration TTL from 1 hour to 30 seconds\n+  public static readonly DEFAULT_EXPIRY: number = 30;\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "pbx_device_manager/src/deviceRegistry.ts",
        "line": 44,
        "title": "Shortened Expiry Without Keepalive Causes Registration Storm",
        "description": "Dropping default registration expiry to 30 seconds forces all registered endpoints to flood the SIP server with REGISTER transactions every 15-30 seconds, creating massive signaling storms and saturating database write capacity.",
        "category": "registration_storm",
        "suggestion": "Use standard registration expiration (minimum 600s - 3600s) and handle NAT pinhole maintenance via lightweight SIP OPTIONS or UDP keepalives."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-rtp-dtmf-payload-mapping",
    "name": "Hardcoded DTMF Payload Type Overrides Negotiated SDP",
    "category": "architecture",
    "description": "Hardcoding DTMF payload type to 101 in mediaBridge ignores dynamic payload mapping from sdpNegotiator when carrier uses payload 96 or 102.",
    "tags": [
      "telecom",
      "cross-module",
      "rtp",
      "sip",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "file_read",
        "query": "sip_signaling_service/src/sdpNegotiator.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2143,
      "title": "refactor(media): fast RFC 2833 DTMF relay packet handler",
      "headSha": "a1b2c3d4e5f67890123456789012345678902143",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-plane-eng",
      "body": "Optimizes DTMF packet detection with hardcoded payload filter."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/mediaBridge.ts",
        "patch": "@@ -87,4 +87,5 @@\n   public isDtmfPacket(payloadType: number): boolean {\n-    return payloadType === this.negotiatedDtmfPayloadType;\n+    // Breaking change: hardcoded 101 ignores dynamic SDP negotiation\n+    return payloadType === 101;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "rtp_media_gateway/src/mediaBridge.ts",
        "line": 89,
        "title": "Hardcoded DTMF Payload Type Overrides Negotiated SDP",
        "description": "Hardcoding the DTMF payload type check to 101 breaks interoperability with carrier trunks that negotiate alternative dynamic telephone-event payload numbers (e.g., 96, 100, or 102), causing IVR touch-tone digit detection to fail.",
        "category": "dtmf_negotiation_breakage",
        "suggestion": "Use the negotiated telephone-event payload type extracted from the active session SDP offer/answer."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-sip-bye-reason-header",
    "name": "Malformed Q.850 Reason Header Format Breaks Parser",
    "category": "architecture",
    "description": "Formatting SIP Reason header without space as Reason: Q.850;cause=16 breaks strict regex in cdr_pipeline ingestion service.",
    "tags": [
      "telecom",
      "cross-module",
      "sip",
      "cdr",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "code_search",
        "query": "parseReasonHeader",
        "expectedSubstring": "cdrIngestion.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2144,
      "title": "refactor(sip): format Q.850 release cause headers on BYE",
      "headSha": "a1b2c3d4e5f67890123456789012345678902144",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "sip-team",
      "body": "Adds Q.850 release cause headers to SIP BYE termination messages."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/dialogManager.ts",
        "patch": "@@ -103,4 +103,5 @@\n   public formatByeReasonHeader(q850Cause: number): string {\n-    return `Reason: Q.850; cause=${q850Cause}`;\n+    // Breaking change: omitted standard space after semicolon\n+    return `Reason: Q.850;cause=${q850Cause}`;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "sip_signaling_service/src/dialogManager.ts",
        "line": 105,
        "title": "Malformed Q.850 Reason Header Format Breaks Parser",
        "description": "Omitting the whitespace in `Reason: Q.850;cause=16` breaks downstream regex parsers in cdr_pipeline/src/cdrIngestion.ts that expect RFC 3326 formatted `Q.850; cause=16`, resulting in unclassified call termination causes.",
        "category": "header_rfc_compliance",
        "suggestion": "Format header per RFC 3326: `Reason: Q.850; cause=${q850Cause}; text=\"Normal Clearing\"`."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-cdr-export-date-timezone",
    "name": "Local Time Serialization Without UTC Offset Corrupts Billing",
    "category": "architecture",
    "description": "Serializing CDR timestamps using toLocaleString() instead of ISO 8601 UTC string breaks cross-timezone billing reconciliation.",
    "tags": [
      "telecom",
      "cross-module",
      "cdr",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "file_read",
        "query": "cdr_pipeline/src/models/callDetailRecord.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2145,
      "title": "refactor(cdr): export CDR timestamps as localized formatted strings",
      "headSha": "a1b2c3d4e5f67890123456789012345678902145",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "billing-dev",
      "body": "Formats CDR export timestamps using local system time format."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/models/callDetailRecord.ts",
        "patch": "@@ -38,4 +38,5 @@\n   public static serializeTimestamp(date: Date): string {\n-    return date.toISOString();\n+    // Breaking change: serializes timestamp using local server time without offset\n+    return date.toLocaleString();\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "cdr_pipeline/src/models/callDetailRecord.ts",
        "line": 40,
        "title": "Local Time Serialization Without UTC Offset Corrupts Billing",
        "description": "Serializing CDR timestamps via toLocaleString() drops ISO 8601 UTC standard offsets, corrupting billing reconciliation and rating window calculations across multi-region server clusters.",
        "category": "timestamp_serialization",
        "suggestion": "Use date.toISOString() or explicit UTC timestamp representation."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-pbx-trunk-group-lb-strategy",
    "name": "Strict Priority Load Balancing Overloads Primary Trunk",
    "category": "performance",
    "description": "Changing trunk selection from weighted round-robin to strict priority order causes primary carrier trunk to saturate while backup trunks sit 100% idle.",
    "tags": [
      "telecom",
      "cross-module",
      "pbx",
      "performance",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "symbol_lookup",
        "query": "TrunkAllocator"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2146,
      "title": "refactor(trunk): prioritize primary carrier trunk routes",
      "headSha": "a1b2c3d4e5f67890123456789012345678902146",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "carrier-ops",
      "body": "Changes trunk allocator to route all calls through lowest-cost carrier first."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/trunkAllocator.ts",
        "patch": "@@ -54,4 +54,5 @@\n   public selectTrunk(trunks: TrunkGroup[]): TrunkGroup {\n-    return this.weightedRoundRobin(trunks);\n+    // Breaking performance change: strict priority selection overloads trunk 0\n+    return trunks[0];\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "performance",
        "severity": "P1",
        "path": "pbx_device_manager/src/trunkAllocator.ts",
        "line": 56,
        "title": "Strict Priority Load Balancing Overloads Primary Trunk",
        "description": "Replacing weighted round-robin with unconditional selection of `trunks[0]` directs 100% of outbound enterprise traffic to a single trunk group, exhausting its channel capacity and causing call rejections.",
        "category": "load_balancing_degradation",
        "suggestion": "Restore weighted round-robin or capacity-aware load balancing across available healthy trunk groups."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-cross-rtp-crypto-suite-sdes",
    "name": "SRTP Encryption Disabled on WAN Egress Bridge",
    "category": "security",
    "description": "Disabling SRTP AES-128-CM payload encryption on WAN egress media bridge streams unencrypted plaintext audio over the public Internet.",
    "tags": [
      "telecom",
      "cross-module",
      "rtp",
      "security",
      "encryption",
      "p0"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "code_search",
        "query": "srtpEnabled",
        "expectedSubstring": "mediaBridge.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2147,
      "title": "refactor(media): bypass SRTP encryption on high-throughput WAN routes",
      "headSha": "a1b2c3d4e5f67890123456789012345678902147",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-plane-eng",
      "body": "Disables SRTP cryptographic transform to optimize CPU utilization on egress bridges."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/mediaBridge.ts",
        "patch": "@@ -40,4 +40,5 @@\n   public isSrtpRequired(isWanEgress: boolean): boolean {\n-    return isWanEgress || this.forceSrtp;\n+    // Breaking security vulnerability: disables SRTP on WAN egress bridges\n+    return false;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "security",
        "severity": "P0",
        "path": "rtp_media_gateway/src/mediaBridge.ts",
        "line": 42,
        "title": "SRTP Encryption Disabled on WAN Egress Bridge",
        "description": "Hardcoding isSrtpRequired to false disables SRTP encryption on public WAN voice streams, allowing unencrypted RTP audio packets to traverse intermediate networks and exposing conversations to wiretapping.",
        "category": "encryption_disabled",
        "suggestion": "Enforce SRTP encryption on all WAN egress connections: return isWanEgress || this.forceSrtp."
      }
    ],
    "expectedVerdict": "BLOCK"
  },
  {
    "id": "telecom-cross-sip-auth-realm-domain",
    "name": "Dynamic Realm Extraction from Untrusted Contact Header",
    "category": "security",
    "description": "Extracting digest authentication realm from untrusted client Contact header hostname enables SIP authentication realm spoofing.",
    "tags": [
      "telecom",
      "cross-module",
      "sip",
      "pbx",
      "security",
      "auth",
      "p0"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "requiredToolQueries": [
      {
        "tool": "file_read",
        "query": "pbx_device_manager/src/digestAuth.ts"
      }
    ],
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2148,
      "title": "refactor(sip): dynamic auth realm extraction for multi-tenant domains",
      "headSha": "a1b2c3d4e5f67890123456789012345678902148",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "security-team",
      "body": "Extracts digest realm dynamically from incoming SIP request Contact header."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/sipServer.ts",
        "patch": "@@ -75,4 +75,5 @@\n   public getChallengeRealm(request: SipRequest): string {\n-    return this.configuredServerRealm;\n+    // Breaking security vulnerability: trusting unauthenticated Contact header domain\n+    return request.headers['contact']?.split('@')[1] || this.configuredServerRealm;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "security",
        "severity": "P0",
        "path": "sip_signaling_service/src/sipServer.ts",
        "line": 77,
        "title": "Dynamic Realm Extraction from Untrusted Contact Header",
        "description": "Extracting the digest authentication challenge realm directly from unauthenticated client Contact headers allows an attacker to specify arbitrary realm domains, triggering hash mismatch or credential harvesting attacks.",
        "category": "auth_domain_spoofing",
        "suggestion": "Use server-configured canonical realm domains matched against trusted tenant domains."
      }
    ],
    "expectedVerdict": "BLOCK"
  }
];
