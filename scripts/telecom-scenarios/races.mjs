// =========================================================================
// 12. TELECOM BENCHMARK EXPANSION - DISTRIBUTED RACE CONDITIONS (PR #2149-#2172)
// =========================================================================

export const RACE_SCENARIOS = [
  {
    "id": "telecom-race-early-bye-transfer-handshake",
    "name": "Early BYE Destroys Media Bridge During REFER Handshake",
    "category": "architecture",
    "description": "An early SIP BYE received during an asynchronous REFER call transfer teardown destroys the media bridge before the final 200 OK transfer confirmation is processed, dropping the transferee.",
    "tags": [
      "telecom",
      "concurrency",
      "race-condition",
      "sip",
      "transfer",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2149,
      "title": "fix(sip): asynchronous transfer handshake and early BYE teardown",
      "headSha": "a1b2c3d4e5f67890123456789012345678902149",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "telecom-core-dev",
      "body": "Handles early BYE requests during active REFER transfer negotiations."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/callTransferCoordinator.ts",
        "patch": "@@ -110,14 +110,8 @@\n   public async handleEarlyBye(transferSessionId: string): Promise<void> {\n     const session = this.transferSessions.get(transferSessionId);\n     if (!session) return;\n-    await session.transferLock.acquire();\n-    try {\n-      if (session.state === 'PENDING') {\n-        session.state = 'ABORTED';\n-        await this.mediaBridge.destroyBridge(session.bridgeId);\n-      }\n-    } finally {\n-      session.transferLock.release();\n-    }\n+    // Bug: Unlocked check-then-act race: destroys media bridge immediately\n+    session.state = 'ABORTED';\n+    await this.mediaBridge.destroyBridge(session.bridgeId);\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "sip_signaling_service/src/callTransferCoordinator.ts",
        "line": 114,
        "title": "Early BYE Destroys Media Bridge During REFER Handshake",
        "description": "Removing the transfer lock around handleEarlyBye creates a race condition where an early BYE from the transferor immediately destroys the media bridge while the transferee is answering, terminating the call prematurely.",
        "category": "race_condition",
        "suggestion": "Synchronize early BYE processing with the transfer session mutex lock."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-split-brain-trunk-lease",
    "name": "Concurrent Trunk Allocation Check-Then-Act Race Condition",
    "category": "performance",
    "description": "Concurrent worker threads allocate carrier trunk channels using a non-atomic check-then-act pattern, leading to trunk capacity oversubscription.",
    "tags": [
      "telecom",
      "concurrency",
      "race-condition",
      "pbx",
      "performance",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2150,
      "title": "perf(trunk): lock-free channel lease reservation",
      "headSha": "a1b2c3d4e5f67890123456789012345678902150",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "carrier-ops",
      "body": "Removes global trunk mutex to increase call allocation throughput."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/trunkAllocator.ts",
        "patch": "@@ -79,6 +79,11 @@\n   public leaseChannel(trunkId: string): boolean {\n     const trunk = this.trunks.get(trunkId);\n     if (!trunk) return false;\n-    return this.atomicIncrementIfUnderLimit(trunk);\n+    // Bug: Non-atomic check-then-act race under high concurrent CPS\n+    if (trunk.activeChannels < trunk.maxChannels) {\n+      trunk.activeChannels++;\n+      return true;\n+    }\n+    return false;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "performance",
        "severity": "P1",
        "path": "pbx_device_manager/src/trunkAllocator.ts",
        "line": 83,
        "title": "Concurrent Trunk Allocation Check-Then-Act Race Condition",
        "description": "Checking activeChannels < maxChannels without atomic CAS or mutex synchronization allows parallel call setup requests to interleave, leasing channels beyond the carrier's contracted hard limit and triggering 503 Service Unavailable trunk errors.",
        "category": "concurrency_race",
        "suggestion": "Use atomic Compare-And-Swap (CAS) or a mutex around channel lease increments."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-double-free-rtp-port",
    "name": "Concurrent Port Release Double-Free in Bitmap",
    "category": "performance",
    "description": "Simultaneous CANCEL arrival and transaction timeout invoke releasePort concurrently on the same port without an atomic check, corrupting the port allocation bitmap.",
    "tags": [
      "telecom",
      "concurrency",
      "race-condition",
      "rtp",
      "port-allocator",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2151,
      "title": "fix(rtp): parallel port release on teardown timeouts",
      "headSha": "a1b2c3d4e5f67890123456789012345678902151",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-plane-eng",
      "body": "Optimizes UDP port deallocation speed during call teardowns."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/portAllocator.ts",
        "patch": "@@ -60,7 +60,6 @@\n   public releasePort(port: number): void {\n-    if (this.allocatedPorts.has(port)) {\n-      this.allocatedPorts.delete(port);\n-      this.availableCount++;\n-    }\n+    // Bug: Double-free race: unconditionally increments availableCount\n+    this.allocatedPorts.delete(port);\n+    this.availableCount++;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "performance",
        "severity": "P1",
        "path": "rtp_media_gateway/src/portAllocator.ts",
        "line": 62,
        "title": "Concurrent Port Release Double-Free in Bitmap",
        "description": "Unconditionally incrementing availableCount without checking whether the port was actually present in allocatedPorts causes concurrent releases of the same port (e.g. from simultaneous CANCEL and timeout handlers) to inflate availableCount past total capacity.",
        "category": "double_free_race",
        "suggestion": "Only increment availableCount if this.allocatedPorts.delete(port) returns true."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-tenant-minute-quota-burst",
    "name": "Parallel Call Minute Quota Check Race Condition",
    "category": "security",
    "description": "Multi-tenant quota validator checks balance before debiting without an atomic reservation, allowing concurrent calls to burst 100x past account credit limits.",
    "tags": [
      "telecom",
      "concurrency",
      "race-condition",
      "cdr",
      "security",
      "p0"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2152,
      "title": "perf(quota): lock-free balance checks for call admission",
      "headSha": "a1b2c3d4e5f67890123456789012345678902152",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "billing-eng",
      "body": "Removes per-tenant quota lock during pre-call admission checks."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/tenantQuotaTracker.ts",
        "patch": "@@ -70,4 +70,11 @@\n   public async debitCallMinutes(tenantId: string, estimatedMinutes: number): Promise<boolean> {\n-    return this.atomicDebit(tenantId, estimatedMinutes);\n+    const current = this.balances.get(tenantId) || 0;\n+    // Bug: Check-then-act race permits parallel calls to all pass before debit\n+    if (current >= estimatedMinutes) {\n+      await this.sleep(1); // Simulating async DB round-trip\n+      this.balances.set(tenantId, current - estimatedMinutes);\n+      return true;\n+    }\n+    return false;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "security",
        "severity": "P0",
        "path": "cdr_pipeline/src/tenantQuotaTracker.ts",
        "line": 71,
        "title": "Parallel Call Minute Quota Check Race Condition",
        "description": "Reading tenant balance, awaiting an asynchronous operation, and then writing back the modified balance introduces a classic Time-of-Check to Time-of-Use (TOCTOU) race condition, enabling attackers to launch hundreds of concurrent calls on depleted balances.",
        "category": "toctou_financial_race",
        "suggestion": "Use atomic SQL `UPDATE tenant_balances SET balance = balance - $1 WHERE balance >= $1` or Redis atomic decrement."
      }
    ],
    "expectedVerdict": "BLOCK"
  },
  {
    "id": "telecom-race-sip-dialog-state-reinvite-glare",
    "name": "Simultaneous Re-INVITE State Deadlock Without Glare Backoff",
    "category": "architecture",
    "description": "Simultaneous re-INVITE requests arriving from both endpoints overwrite dialog state concurrently without 491 pending glare resolution.",
    "tags": [
      "telecom",
      "concurrency",
      "race-condition",
      "sip",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2153,
      "title": "refactor(sip): asynchronous mid-call re-INVITE state coordinator",
      "headSha": "a1b2c3d4e5f67890123456789012345678902153",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "sip-team",
      "body": "Refactors re-INVITE state transitions for hold/resume media changes."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/dialogManager.ts",
        "patch": "@@ -152,10 +152,7 @@\n   public processReInvite(dialogId: string, sdpOffer: string): void {\n     const dialog = this.dialogs.get(dialogId);\n     if (!dialog) return;\n-    if (dialog.reInviteInProgress) {\n-      this.send491Pending(dialog);\n-      return;\n-    }\n-    dialog.reInviteInProgress = true;\n+    // Bug: Removed reInviteInProgress lock: parallel re-INVITEs overwrite active offer\n+    dialog.pendingOffer = sdpOffer;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "sip_signaling_service/src/dialogManager.ts",
        "line": 156,
        "title": "Simultaneous Re-INVITE State Deadlock Without Glare Backoff",
        "description": "Removing the reInviteInProgress check allows concurrent re-INVITE offers from both call legs to overwrite dialog.pendingOffer simultaneously without sending RFC 3261 491 Request Pending, causing session state corruption.",
        "category": "sip_glare_race",
        "suggestion": "Enforce 491 glare backoff when a re-INVITE transaction is already active."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-cdr-batch-buffer-flush-race",
    "name": "Concurrent Timer and Threshold Flush Duplicates CDR Rows",
    "category": "performance",
    "description": "Periodic timer tick and batch buffer size threshold trigger flush() simultaneously without an atomic queue swap, inserting duplicate CDR rows.",
    "tags": [
      "telecom",
      "concurrency",
      "race-condition",
      "cdr",
      "performance",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2154,
      "title": "perf(cdr): parallel timer and threshold buffer flush trigger",
      "headSha": "a1b2c3d4e5f67890123456789012345678902154",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "db-scale-eng",
      "body": "Allows concurrent timer and volume flush workers for CDR batch logger."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/batchSqlLogger.ts",
        "patch": "@@ -108,11 +108,7 @@\n   public async flush(): Promise<void> {\n-    if (this.isFlushing || this.queue.length === 0) return;\n-    this.isFlushing = true;\n-    const batch = this.queue.splice(0, this.batchSize);\n-    try {\n-      await this.writeToDb(batch);\n-    } finally {\n-      this.isFlushing = false;\n-    }\n+    // Bug: Removed isFlushing re-entrancy guard: concurrent flushes read same queue\n+    const batch = [...this.queue];\n+    await this.writeToDb(batch);\n+    this.queue = [];\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "performance",
        "severity": "P1",
        "path": "cdr_pipeline/src/batchSqlLogger.ts",
        "line": 110,
        "title": "Concurrent Timer and Threshold Flush Duplicates CDR Rows",
        "description": "Removing the isFlushing lock and taking a shallow copy `[...this.queue]` before awaiting writeToDb allows concurrent timer and threshold triggers to process the exact same CDR items twice, resulting in duplicate database records.",
        "category": "reentrancy_race",
        "suggestion": "Use atomic queue draining: `const batch = this.queue.splice(0);` or enforce a mutex lock around flush operations."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-pbx-device-multi-reg-contact-loss",
    "name": "Concurrent REGISTER Read-Modify-Write Drops Contact Bindings",
    "category": "architecture",
    "description": "Concurrent SIP REGISTER requests for different phone extensions on the same account perform non-atomic read-modify-write on contact array, dropping active endpoints.",
    "tags": [
      "telecom",
      "concurrency",
      "race-condition",
      "pbx",
      "sip",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2155,
      "title": "refactor(pbx): in-memory contact binding registry for multi-device SIP",
      "headSha": "a1b2c3d4e5f67890123456789012345678902155",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "pbx-team",
      "body": "Refactors contact bindings for multi-device SIP fork ringing."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/deviceRegistry.ts",
        "patch": "@@ -87,7 +87,7 @@\n   public async addContact(account: string, newContact: string): Promise<void> {\n-    await this.accountLocks.withLock(account, async () => {\n-      const contacts = this.contacts.get(account) || [];\n-      this.contacts.set(account, [...contacts, newContact]);\n-    });\n+    // Bug: Removed per-account lock causing concurrent REGISTERs to overwrite contact list\n+    const contacts = this.contacts.get(account) || [];\n+    await this.db.saveContact(account, newContact);\n+    this.contacts.set(account, [...contacts, newContact]);\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "pbx_device_manager/src/deviceRegistry.ts",
        "line": 89,
        "title": "Concurrent REGISTER Read-Modify-Write Drops Contact Bindings",
        "description": "Reading the contacts array, awaiting an asynchronous DB save, and then setting `[...contacts, newContact]` creates a race condition where simultaneous REGISTER requests from different devices for the same user account overwrite each other, dropping SIP endpoint bindings.",
        "category": "read_modify_write_race",
        "suggestion": "Use a Set data structure with synchronized mutations or atomic append operations."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-rtp-jitter-buffer-reorder-deadlock",
    "name": "Bidirectional Lock Inversion Deadlock in Jitter Buffer",
    "category": "performance",
    "description": "Packet insertion locks packetLock -> queueLock while playout worker locks queueLock -> packetLock, causing lock inversion deadlock under high packet jitter.",
    "tags": [
      "telecom",
      "concurrency",
      "deadlock",
      "rtp",
      "jitter",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2156,
      "title": "perf(rtp): fine-grained locking in jitter buffer reorder engine",
      "headSha": "a1b2c3d4e5f67890123456789012345678902156",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-dsp",
      "body": "Introduces fine-grained mutexes for packet ingestion and audio playout."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/jitterBuffer.ts",
        "patch": "@@ -185,17 +185,18 @@\n   public insertPacket(packet: RtpPacket): void {\n     this.packetMutex.lock();\n     this.queueMutex.lock();\n     this.packetQueue.push(packet);\n     this.queueMutex.unlock();\n     this.packetMutex.unlock();\n   }\n \n   public getNextPlayoutFrame(): Buffer | null {\n-    this.packetMutex.lock();\n-    this.queueMutex.lock();\n+    // Bug: Inverted lock acquisition order causing deadlock under concurrency\n+    this.queueMutex.lock();\n+    this.packetMutex.lock();\n     const frame = this.popFrame();\n     this.packetMutex.unlock();\n     this.queueMutex.unlock();\n     return frame;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "performance",
        "severity": "P1",
        "path": "rtp_media_gateway/src/jitterBuffer.ts",
        "line": 195,
        "title": "Bidirectional Lock Inversion Deadlock in Jitter Buffer",
        "description": "insertPacket acquires packetMutex then queueMutex while getNextPlayoutFrame acquires queueMutex then packetMutex. Under high packet arrival rates, this lock inversion triggers a permanent deadlock freezing the audio playout thread.",
        "category": "lock_inversion_deadlock",
        "suggestion": "Enforce strict, uniform lock hierarchy: always acquire packetMutex before queueMutex."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-distributed-lock-ttl-expiry",
    "name": "Distributed Lock TTL Expiration Without Heartbeat Extension",
    "category": "architecture",
    "description": "Redis distributed trunk lock TTL expires during slow database trunk provisioning without a background renewal heartbeat, leading to split-brain double leasing.",
    "tags": [
      "telecom",
      "concurrency",
      "distributed-lock",
      "pbx",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2157,
      "title": "feat(trunk): distributed Redis lock for multi-node trunk allocation",
      "headSha": "a1b2c3d4e5f67890123456789012345678902157",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "distributed-systems-team",
      "body": "Adds distributed locking for multi-region PBX carrier trunk groups."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/trunkAllocator.ts",
        "patch": "@@ -138,12 +138,9 @@\n   public async allocateTrunkWithLock(trunkId: string): Promise<boolean> {\n     const lock = await this.redisLock.acquire(`lock:${trunkId}`, 1000); // 1s TTL\n     if (!lock) return false;\n-    const heartbeat = this.startLockHeartbeat(lock);\n-    try {\n-      return await this.provisionTrunkResources(trunkId);\n-    } finally {\n-      heartbeat.stop();\n-      await lock.release();\n-    }\n+    // Bug: Removed background heartbeat renewal during slow provisioning\n+    const result = await this.slowProvisionTrunkResources(trunkId);\n+    await lock.release();\n+    return result;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "pbx_device_manager/src/trunkAllocator.ts",
        "line": 142,
        "title": "Distributed Lock TTL Expiration Without Heartbeat Extension",
        "description": "The 1000ms distributed lock TTL expires if slowProvisionTrunkResources takes longer than 1 second, allowing another cluster node to acquire the lock and allocate the same trunk channels simultaneously.",
        "category": "distributed_lock_ttl_race",
        "suggestion": "Implement a background heartbeat timer to renew the distributed lock TTL until the operation completes or use monotonic fencing tokens."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-sip-transaction-timer-b-destruction",
    "name": "Race Condition Between 200 OK Arrival and Timer B Expiry",
    "category": "performance",
    "description": "A 200 OK response arriving at the exact millisecond Timer B fires invokes transaction destruction twice, throwing an uncaught null reference exception.",
    "tags": [
      "telecom",
      "concurrency",
      "race-condition",
      "sip",
      "performance",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2158,
      "title": "refactor(sip): transaction cleanup on final response arrival",
      "headSha": "a1b2c3d4e5f67890123456789012345678902158",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "sip-protocol-dev",
      "body": "Streamlines transaction destruction lifecycle upon final response arrival."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/sipStateMachine.ts",
        "patch": "@@ -186,6 +186,6 @@\n   public handleFinalResponse(res: SipResponse): void {\n-    if (this.isDestroyed) return;\n-    this.isDestroyed = true;\n-    this.destroyTransaction();\n+    // Bug: Removed isDestroyed guard: concurrent Timer B timeout destroys null socket\n+    this.socket.close();\n+    this.socket = null as any;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "performance",
        "severity": "P1",
        "path": "sip_signaling_service/src/sipStateMachine.ts",
        "line": 188,
        "title": "Race Condition Between 200 OK Arrival and Timer B Expiry",
        "description": "Removing the isDestroyed state guard creates a race where a 200 OK arriving simultaneously with Timer B expiry causes both handlers to call socket.close() and dereference this.socket, throwing TypeError: Cannot read properties of null.",
        "category": "teardown_race",
        "suggestion": "Use an atomic `if (this.isDestroyed) return; this.isDestroyed = true;` guard."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-rtp-transcoder-channel-swap",
    "name": "Recycled Transcoder State Bleeds Audio Residuals",
    "category": "architecture",
    "description": "Recycled audio transcoder context returned to pool is reassigned to a new call session before previous session DSP filter state is cleared.",
    "tags": [
      "telecom",
      "concurrency",
      "rtp",
      "codecs",
      "audio-bleed",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2159,
      "title": "perf(rtp): object pooling for audio transcoding contexts",
      "headSha": "a1b2c3d4e5f67890123456789012345678902159",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "dsp-team",
      "body": "Implements pooling for high-rate audio transcoder contexts."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/audioCodecs.ts",
        "patch": "@@ -113,6 +113,5 @@\n   public releaseContext(ctx: TranscodeContext): void {\n-    ctx.resetFilters();\n-    ctx.buffer.fill(0);\n-    this.pool.push(ctx);\n+    // Bug: Pooled context returned without zeroing residual PCM audio buffers\n+    this.pool.push(ctx);\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "rtp_media_gateway/src/audioCodecs.ts",
        "line": 115,
        "title": "Recycled Transcoder State Bleeds Audio Residuals",
        "description": "Releasing transcoding contexts back into the pool without resetting internal filter states and clearing sample buffers causes the first 20-40ms of the next call to play audio fragments from the previous caller.",
        "category": "state_reuse_bleed",
        "suggestion": "Zero all internal buffers and reset filter state prior to returning contexts to the pool."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-pbx-webhook-retry-order-inversion",
    "name": "Webhook Retry Backoff Inverts Event Delivery Sequence",
    "category": "architecture",
    "description": "Per-request exponential backoff on failed call.initiated retry delivers event after call.terminated has already been delivered, corrupting client call state.",
    "tags": [
      "telecom",
      "concurrency",
      "pbx",
      "webhooks",
      "ordering",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2160,
      "title": "fix(webhook): asynchronous retry backoff for failed CTI events",
      "headSha": "a1b2c3d4e5f67890123456789012345678902160",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "cti-team",
      "body": "Adds independent retry timers for failed webhook event deliveries."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/ctiWebhookDispatcher.ts",
        "patch": "@@ -124,4 +124,5 @@\n   public async dispatchEvent(event: CtiEvent): Promise<void> {\n-    await this.sequentialQueue.enqueue(event.callId, () => this.sendHttp(event));\n+    // Bug: Dispatches independent retry without preserving per-call event order\n+    this.sendWithBackoff(event);\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "pbx_device_manager/src/ctiWebhookDispatcher.ts",
        "line": 126,
        "title": "Webhook Retry Backoff Inverts Event Delivery Sequence",
        "description": "Dispatching webhook retries independently without per-call FIFO sequencing causes retried `call.initiated` events to arrive after `call.terminated` has already been delivered, leaving customer CRM systems in a permanently stuck 'Ringing' state.",
        "category": "event_ordering_inversion",
        "suggestion": "Enforce per-callId sequential queues so downstream events are not dispatched until prior events succeed or exhaust retries."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-cdr-rating-rate-sheet-swap",
    "name": "In-Place Rate Trie Mutation During Active Call Rating",
    "category": "architecture",
    "description": "Modifying Radix Trie nodes in-place during live rate card updates causes concurrent rating lookups to traverse half-initialized branch nodes.",
    "tags": [
      "telecom",
      "concurrency",
      "cdr",
      "rating",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2161,
      "title": "feat(cdr): real-time dynamic rate deck updates without restart",
      "headSha": "a1b2c3d4e5f67890123456789012345678902161",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "billing-eng",
      "body": "Enables hot rate-sheet reloads on live rating engines."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/tariffRatingEngine.ts",
        "patch": "@@ -163,6 +163,7 @@\n   public reloadRateSheet(newRates: RateEntry[]): void {\n-    const newTrie = new E164RadixTrie();\n-    for (const rate of newRates) newTrie.insert(rate.prefix, rate);\n-    this.trie = newTrie; // Atomic pointer swap\n+    // Bug: Mutates existing active trie in-place during live lookups\n+    for (const rate of newRates) {\n+      this.trie.insert(rate.prefix, rate);\n+    }\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "cdr_pipeline/src/tariffRatingEngine.ts",
        "line": 165,
        "title": "In-Place Rate Trie Mutation During Active Call Rating",
        "description": "Inserting new rates directly into the active trie instance while concurrent rating queries are traversing it introduces a data race where lookups read partially linked trie nodes, resulting in rating misses or unhandled exceptions.",
        "category": "concurrent_mutation_race",
        "suggestion": "Build a new Radix Trie instance off-thread and perform an atomic pointer swap."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-sip-dialog-bridge-whisper-deadlock",
    "name": "Lock Hierarchy Violation in Supervisor Barge-In Whisper",
    "category": "performance",
    "description": "Call whisper coaching feature acquires supervisor dialog lock before agent dialog lock while agent transfer acquires in opposite order, causing thread deadlock.",
    "tags": [
      "telecom",
      "concurrency",
      "deadlock",
      "sip",
      "pbx",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2162,
      "title": "feat(sip): supervisor whisper coaching and barge-in audio bridge",
      "headSha": "a1b2c3d4e5f67890123456789012345678902162",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "pbx-core",
      "body": "Implements supervisor coaching audio bridge with dual dialog synchronization."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/dialogManager.ts",
        "patch": "@@ -208,6 +208,6 @@\n   public bridgeWhisperChannel(supervisorDialogId: string, agentDialogId: string): void {\n-    const [first, second] = [supervisorDialogId, agentDialogId].sort();\n-    this.locks.get(first)?.lock();\n-    this.locks.get(second)?.lock();\n+    // Bug: Arbitrary lock acquisition order violates lock hierarchy\n+    this.locks.get(supervisorDialogId)?.lock();\n+    this.locks.get(agentDialogId)?.lock();\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "performance",
        "severity": "P1",
        "path": "sip_signaling_service/src/dialogManager.ts",
        "line": 210,
        "title": "Lock Hierarchy Violation in Supervisor Barge-In Whisper",
        "description": "Acquiring dialog mutexes in arbitrary parameter order (supervisorDialogId then agentDialogId) without canonical sorting creates a circular lock dependency deadlock when simultaneous supervisor barge-in and agent transfer events occur.",
        "category": "deadlock_lock_ordering",
        "suggestion": "Always acquire multiple locks in consistent alphabetical or resource-ID order."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-rtp-socket-bind-collision",
    "name": "Non-Atomic UDP Port Reservation Causes EADDRINUSE",
    "category": "performance",
    "description": "Time gap between port availability bitmap check and actual OS socket binding allows concurrent threads to select the same UDP port, throwing EADDRINUSE.",
    "tags": [
      "telecom",
      "concurrency",
      "rtp",
      "port-allocator",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2163,
      "title": "refactor(rtp): fast bitmap search for UDP port pool allocation",
      "headSha": "a1b2c3d4e5f67890123456789012345678902163",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-plane-eng",
      "body": "Speeds up UDP port allocation using bitwise scans."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/portAllocator.ts",
        "patch": "@@ -94,10 +94,10 @@\n   public allocatePort(): number | null {\n     for (let port = 16384; port < 32768; port += 2) {\n       if (!this.allocatedPorts.has(port)) {\n-        this.allocatedPorts.add(port);\n-        return port;\n+        // Bug: Yields or delays before setting allocatedPorts, opening collision window\n+        return port;\n       }\n     }\n     return null;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "performance",
        "severity": "P1",
        "path": "rtp_media_gateway/src/portAllocator.ts",
        "line": 98,
        "title": "Non-Atomic UDP Port Reservation Causes EADDRINUSE",
        "description": "Returning an available port number without immediately marking it as allocated in the allocatedPorts set creates a race condition where multiple concurrent call setups receive the same port, causing OS bind collisions with EADDRINUSE.",
        "category": "port_allocation_race",
        "suggestion": "Atomically mark the port as allocated before returning it."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-pbx-trunk-circuit-breaker-flap",
    "name": "Non-Atomic Failure Counter Causes Circuit Breaker Oscillation",
    "category": "performance",
    "description": "Unsynchronized increments and resets of trunk failure counters across concurrent cluster workers cause circuit breaker to flap between OPEN and CLOSED states.",
    "tags": [
      "telecom",
      "concurrency",
      "pbx",
      "circuit-breaker",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2164,
      "title": "refactor(trunk): high-concurrency circuit breaker failure counters",
      "headSha": "a1b2c3d4e5f67890123456789012345678902164",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "carrier-ops",
      "body": "Refactors carrier circuit breaker state calculations under high concurrency."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/trunkAllocator.ts",
        "patch": "@@ -166,10 +166,8 @@\n   public recordFailure(trunkId: string): void {\n     const trunk = this.trunks.get(trunkId);\n     if (!trunk) return;\n-    if (trunk.state === 'OPEN') return;\n-    trunk.consecutiveFailures++;\n-    if (trunk.consecutiveFailures >= 5) {\n-      trunk.state = 'OPEN';\n-    }\n+    // Bug: Non-atomic counter mutation permits state flapping\n+    trunk.consecutiveFailures++;\n+    trunk.state = trunk.consecutiveFailures >= 5 ? 'OPEN' : 'HEALTHY';\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "performance",
        "severity": "P1",
        "path": "pbx_device_manager/src/trunkAllocator.ts",
        "line": 170,
        "title": "Non-Atomic Failure Counter Causes Circuit Breaker Oscillation",
        "description": "Unconditionally setting state to HEALTHY when consecutiveFailures is below threshold without respecting existing OPEN / HALF_OPEN states causes concurrent threads to prematurely reset tripped circuit breakers while carrier trunks are still down.",
        "category": "circuit_breaker_race",
        "suggestion": "Guard state transitions with explicit state machine checks and cooldown timers."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-sip-nonce-replay-window",
    "name": "Nonce Consumed After Verification Opens Replay Window",
    "category": "security",
    "description": "Marking SIP auth nonce as consumed only after password hash verification completes allows parallel requests with the same nonce to authenticate simultaneously.",
    "tags": [
      "telecom",
      "concurrency",
      "security",
      "sip",
      "auth-replay",
      "p0"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2165,
      "title": "refactor(auth): defer nonce invalidation until authentication passes",
      "headSha": "a1b2c3d4e5f67890123456789012345678902165",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "auth-team",
      "body": "Prevents invalidating nonces on malformed digest attempts."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/digestAuth.ts",
        "patch": "@@ -100,5 +100,9 @@\n   public async authenticateRequest(req: DigestRequest): Promise<boolean> {\n-    if (!this.consumeNonceAtomically(req.nonce)) return false;\n-    return this.verifyDigestHash(req);\n+    // Bug: Nonce is only marked consumed AFTER slow cryptographic verification\n+    const isValid = await this.verifyDigestHash(req);\n+    if (isValid) {\n+      this.consumedNonces.add(req.nonce);\n+    }\n+    return isValid;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "security",
        "severity": "P0",
        "path": "pbx_device_manager/src/digestAuth.ts",
        "line": 102,
        "title": "Nonce Consumed After Verification Opens Replay Window",
        "description": "Checking and consuming the authentication nonce after completing hash verification opens a race window where multiple parallel requests can replay the same nonce simultaneously before it is added to consumedNonces.",
        "category": "auth_replay_race",
        "suggestion": "Atomically mark the nonce as consumed before verifying the cryptographic digest."
      }
    ],
    "expectedVerdict": "BLOCK"
  },
  {
    "id": "telecom-race-cdr-sql-partition-creation",
    "name": "Concurrent Partition Creation Race Without Advisory Lock",
    "category": "database",
    "description": "Concurrent worker processes detecting missing monthly CDR partition execute CREATE TABLE simultaneously without IF NOT EXISTS or advisory locks, crashing workers with duplicate relation errors.",
    "tags": [
      "telecom",
      "concurrency",
      "database",
      "cdr",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2166,
      "title": "feat(cdr): dynamic table partition creation on ingestion worker",
      "headSha": "a1b2c3d4e5f67890123456789012345678902166",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "db-scale-eng",
      "body": "Allows worker nodes to auto-create monthly partitions on demand."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/batchSqlLogger.ts",
        "patch": "@@ -146,4 +146,8 @@\n   public async ensurePartitionExists(tableName: string): Promise<void> {\n-    await this.db.query(`CREATE TABLE IF NOT EXISTS ${tableName} PARTITION OF tenant_cdrs ...`);\n+    // Bug: CREATE TABLE without IF NOT EXISTS or lock crashes on concurrent worker execution\n+    const exists = await this.checkTableExists(tableName);\n+    if (!exists) {\n+      await this.db.query(`CREATE TABLE ${tableName} PARTITION OF tenant_cdrs ...`);\n+    }\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "database",
        "severity": "P1",
        "path": "cdr_pipeline/src/batchSqlLogger.ts",
        "line": 148,
        "title": "Concurrent Partition Creation Race Without Advisory Lock",
        "description": "Using checkTableExists followed by CREATE TABLE without `IF NOT EXISTS` or PostgreSQL advisory locks creates a race condition where multiple cluster workers simultaneously attempt to create the partition, throwing fatal 'relation already exists' errors.",
        "category": "concurrent_ddl_race",
        "suggestion": "Use `CREATE TABLE IF NOT EXISTS` or wrap DDL execution in `pg_advisory_xact_lock`."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-rtp-rtcp-bye-packet-reorder",
    "name": "Asynchronous RTCP BYE Destroys Active Media Stream",
    "category": "architecture",
    "description": "RTCP BYE packet handled on an asynchronous callback destroys media bridge socket while buffered RTP voice packets are still in transit.",
    "tags": [
      "telecom",
      "concurrency",
      "rtp",
      "rtcp",
      "architecture",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2167,
      "title": "refactor(rtcp): instant session teardown on RTCP BYE receipt",
      "headSha": "a1b2c3d4e5f67890123456789012345678902167",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-plane-eng",
      "body": "Teardown media streams immediately upon receiving RTCP BYE packets."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/mediaBridge.ts",
        "patch": "@@ -128,4 +128,5 @@\n   public handleRtcpBye(): void {\n-    this.scheduleDelayedTeardown(500); // Allow in-flight RTP packets to flush\n+    // Bug: Immediate teardown closes socket while RTP buffer is still playing\n+    this.close();\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "rtp_media_gateway/src/mediaBridge.ts",
        "line": 130,
        "title": "Asynchronous RTCP BYE Destroys Active Media Stream",
        "description": "Calling this.close() immediately upon RTCP BYE receipt terminates the UDP socket while jitter buffer packets are still queued for audio playback, clipping the last syllables of speech.",
        "category": "media_teardown_race",
        "suggestion": "Implement a graceful teardown delay (e.g. 500ms) or wait for the jitter buffer queue to empty before closing the media bridge."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-pbx-cti-call-pickup-double-grab",
    "name": "Non-Atomic Call Pickup Connects Multiple Agents",
    "category": "architecture",
    "description": "Simultaneous directed call pickup requests check call ringing state non-atomically, connecting two agents into the same inbound ringing call leg.",
    "tags": [
      "telecom",
      "concurrency",
      "pbx",
      "call-pickup",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2168,
      "title": "feat(pbx): directed call pickup for department hunt groups",
      "headSha": "a1b2c3d4e5f67890123456789012345678902168",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "pbx-team",
      "body": "Allows agents to pick up ringing calls from co-workers' extensions."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/deviceRegistry.ts",
        "patch": "@@ -114,6 +114,9 @@\n   public async pickupCall(callId: string, agentId: string): Promise<boolean> {\n     const call = this.activeCalls.get(callId);\n     if (!call || call.state !== 'RINGING') return false;\n-    return this.claimCallAtomically(call, agentId);\n+    // Bug: Non-atomic assignment permits two agents to pick up same call\n+    call.assignedAgent = agentId;\n+    call.state = 'ANSWERED';\n+    return true;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "pbx_device_manager/src/deviceRegistry.ts",
        "line": 118,
        "title": "Non-Atomic Call Pickup Connects Multiple Agents",
        "description": "Checking call.state === 'RINGING' and mutating call.assignedAgent without an atomic CAS operation or lock allows two agents executing pickup simultaneously to both receive success, resulting in conflicting SIP 200 OK responses.",
        "category": "call_pickup_race",
        "suggestion": "Use atomic Compare-And-Swap (CAS) to transition call state from RINGING to ANSWERED."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-sip-session-timer-refresh-glare",
    "name": "Simultaneous Session Timer Refresh UPDATE Collision",
    "category": "architecture",
    "description": "Simultaneous RFC 4028 session timer UPDATE requests sent by both endpoints collide and cause unhandled 491 glare, terminating the call.",
    "tags": [
      "telecom",
      "concurrency",
      "sip",
      "session-timers",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2169,
      "title": "feat(sip): RFC 4028 session timers keepalive refresh in dialogs",
      "headSha": "a1b2c3d4e5f67890123456789012345678902169",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "sip-team",
      "body": "Implements periodic SIP UPDATE refreshers for session timer keepalives."
    },
    "diffFiles": [
      {
        "path": "sip_signaling_service/src/dialogManager.ts",
        "patch": "@@ -237,10 +237,7 @@\n   public handleSessionTimerExpiry(dialogId: string): void {\n     const dialog = this.dialogs.get(dialogId);\n     if (!dialog) return;\n-    if (dialog.hasPendingTransaction) {\n-      this.rescheduleSessionTimer(dialogId, 2000);\n-      return;\n-    }\n+    // Bug: Sends UPDATE immediately without checking pending transactions\n     this.sendSessionRefreshUpdate(dialog);\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "sip_signaling_service/src/dialogManager.ts",
        "line": 240,
        "title": "Simultaneous Session Timer Refresh UPDATE Collision",
        "description": "Sending a session refresh UPDATE message when a dialog transaction is already in flight triggers an RFC 3261 491 Request Pending response from the peer which, without retry logic, causes the session timer to expire and drop the call.",
        "category": "session_timer_glare",
        "suggestion": "Reschedule session timer refresh with a backoff interval if a transaction is currently in progress."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-cdr-multi-tenant-accumulator-leak",
    "name": "Non-Atomic Map Merge Corrupts Tenant Usage Metrics",
    "category": "security",
    "description": "In-memory dictionary merge during hourly multi-tenant quota rollups overwrites one tenant's used minutes with another tenant's metrics under high concurrency.",
    "tags": [
      "telecom",
      "concurrency",
      "security",
      "cdr",
      "multi-tenancy",
      "p0"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2170,
      "title": "perf(cdr): asynchronous hourly tenant quota rollup accumulator",
      "headSha": "a1b2c3d4e5f67890123456789012345678902170",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "billing-eng",
      "body": "Aggregates tenant call usage metrics asynchronously."
    },
    "diffFiles": [
      {
        "path": "cdr_pipeline/src/tenantQuotaTracker.ts",
        "patch": "@@ -93,4 +93,7 @@\n   public accumulateUsage(tenantId: string, durationSec: number): void {\n-    this.atomicAddMinutes(tenantId, Math.ceil(durationSec / 60));\n+    // Bug: Read-modify-write on shared object property across concurrent workers\n+    const entry = this.usageMap[tenantId] || { totalMinutes: 0 };\n+    entry.totalMinutes += Math.ceil(durationSec / 60);\n+    this.usageMap[tenantId] = entry;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "security",
        "severity": "P0",
        "path": "cdr_pipeline/src/tenantQuotaTracker.ts",
        "line": 95,
        "title": "Non-Atomic Map Merge Corrupts Tenant Usage Metrics",
        "description": "Concurrent read-modify-write operations on this.usageMap allow parallel worker threads to overwrite tenant usage values, corrupting billing data and enabling tenants to exceed prepaid quotas without detection.",
        "category": "billing_corruption_race",
        "suggestion": "Use atomic increments or synchronized map operations for usage aggregation."
      }
    ],
    "expectedVerdict": "BLOCK"
  },
  {
    "id": "telecom-race-pbx-device-deregistration-cascade",
    "name": "Un-Throttled Mass Deregistration Database Spike",
    "category": "performance",
    "description": "Mass endpoint network recovery triggers thousands of parallel synchronous DB queries, exhausting the PostgreSQL connection pool.",
    "tags": [
      "telecom",
      "concurrency",
      "pbx",
      "performance",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2171,
      "title": "refactor(pbx): instantaneous bulk endpoint cleanup on network loss",
      "headSha": "a1b2c3d4e5f67890123456789012345678902171",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "pbx-team",
      "body": "Immediately cleans up expired device registrations upon timeout."
    },
    "diffFiles": [
      {
        "path": "pbx_device_manager/src/deviceRegistry.ts",
        "patch": "@@ -148,4 +148,5 @@\n   public async handleMassDisconnect(endpointIds: string[]): Promise<void> {\n-    await this.batchDeregisterWithConcurrency(endpointIds, 50);\n+    // Bug: Unbounded Promise.all triggers thousands of parallel DB connections\n+    await Promise.all(endpointIds.map(id => this.db.deleteEndpoint(id)));\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "performance",
        "severity": "P1",
        "path": "pbx_device_manager/src/deviceRegistry.ts",
        "line": 150,
        "title": "Un-Throttled Mass Deregistration Database Spike",
        "description": "Using unbounded Promise.all across thousands of disconnected endpoints executes thousands of concurrent database delete operations simultaneously, starving the database connection pool and crashing other active call processing queries.",
        "category": "unbounded_concurrency_spike",
        "suggestion": "Use batched IN queries `DELETE FROM endpoints WHERE id IN (...)` or concurrency-limited worker pools."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  },
  {
    "id": "telecom-race-rtp-dtmf-duration-accumulation",
    "name": "Out-of-Order DTMF End Packets Overwrite Duration",
    "category": "architecture",
    "description": "Out-of-order RFC 4733 DTMF packets overwrite cumulative event duration with an earlier timestamp value, truncating DTMF tone length to IVR.",
    "tags": [
      "telecom",
      "concurrency",
      "rtp",
      "dtmf",
      "rfc4733",
      "p1"
    ],
    "workspaceRoot": "tests/fixtures/workspaces/telecom-call-engine",
    "prContext": {
      "repo": "calltelemetry/telecom-call-engine",
      "prNumber": 2172,
      "title": "refactor(media): RFC 4733 DTMF event packet duration tracker",
      "headSha": "a1b2c3d4e5f67890123456789012345678902172",
      "baseSha": "000000000000000000000000000000000000base",
      "author": "media-plane-eng",
      "body": "Updates RFC 4733 DTMF event duration calculation logic."
    },
    "diffFiles": [
      {
        "path": "rtp_media_gateway/src/mediaBridge.ts",
        "patch": "@@ -160,6 +160,5 @@\n   public processDtmfPacket(event: DtmfEvent): void {\n-    if (event.duration >= this.currentDtmfDuration) {\n-      this.currentDtmfDuration = event.duration;\n-    }\n+    // Bug: Unconditional assignment causes out-of-order packets to truncate tone duration\n+    this.currentDtmfDuration = event.duration;\n   }\n }"
      }
    ],
    "expectedFindings": [
      {
        "personaId": "architecture",
        "severity": "P1",
        "path": "rtp_media_gateway/src/mediaBridge.ts",
        "line": 162,
        "title": "Out-of-Order DTMF End Packets Overwrite Duration",
        "description": "Unconditionally overwriting currentDtmfDuration with incoming packet durations without checking for monotonic increase causes reordered UDP DTMF packets to truncate the reported tone length, leading to unrecognized digits in automated IVR menus.",
        "category": "out_of_order_packet_race",
        "suggestion": "Only update duration if `event.duration >= this.currentDtmfDuration` for the active event timestamp."
      }
    ],
    "expectedVerdict": "FIX_FIRST"
  }
];
