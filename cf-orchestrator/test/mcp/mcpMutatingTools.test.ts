import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/worker.js';
import { defaultMcpRouter } from '../../src/mcp/mcpRouter.js';
import { computeGateAttestationHmac } from '../../src/mcp/tools/attestPrGate.js';

describe('Review Yeti Edge MCP Mutating Tools & SSE Transport', () => {
  describe('Tool: review_yeti_attest_pr_gate', () => {
    it('successfully attests a PR when exact-head matches and verdict is SHIP', async () => {
      const mockEnv = {
        REPO_GATE: {
          idFromName: () => 'gate_1',
          get: () => ({
            async fetch() {
              return Response.json({
                latestRunId: 'run_test_101',
                activeRunId: 'run_test_101',
              });
            },
          }),
        },
        REVIEW_RUN: {
          idFromName: () => 'run_101',
          get: () => ({
            async fetch() {
              return Response.json({
                headSha: 'a'.repeat(40),
                phase: 'Completed',
              });
            },
          }),
        },
        REVIEW_YETI_ATTESTATION_SECRET: 'test-secret-123',
      };

      const res = await defaultMcpRouter.handleRpc(
        {
          jsonrpc: '2.0',
          id: 'attest-1',
          method: 'tools/call',
          params: {
            name: 'review_yeti_attest_pr_gate',
            arguments: {
              owner: 'exampleorg',
              repo: 'example-api',
              pr_number: 4836,
              head_sha: 'a'.repeat(40),
            },
          },
        },
        { env: mockEnv }
      );

      assert.equal(res.jsonrpc, '2.0');
      assert.equal(res.id, 'attest-1');
      assert.ok(res.result);
      const parsed = JSON.parse(res.result.content[1].text);
      assert.equal(parsed.attested, true);
      assert.equal(parsed.gate_status, 'PASSED');
      assert.equal(parsed.blockers.length, 0);
      assert.ok(parsed.attestation_token);
      assert.equal(parsed.head_sha, 'a'.repeat(40));

      // Verify HMAC token
      const expectedHmac = await computeGateAttestationHmac(
        'test-secret-123',
        `exampleorg/example-api#4836@${'a'.repeat(40)}:${parsed.timestamp}`
      );
      assert.equal(parsed.attestation_token, expectedHmac);
    });

    it('blocks gate when head_sha does not match latest evaluated run', async () => {
      const mockEnv = {
        REPO_GATE: {
          idFromName: () => 'gate_1',
          get: () => ({
            async fetch() {
              return Response.json({
                latestRunId: 'run_test_102',
              });
            },
          }),
        },
        REVIEW_RUN: {
          idFromName: () => 'run_102',
          get: () => ({
            async fetch() {
              return Response.json({
                headSha: 'b'.repeat(40),
                phase: 'Completed',
              });
            },
          }),
        },
      };

      const res = await defaultMcpRouter.handleRpc(
        {
          jsonrpc: '2.0',
          id: 'attest-2',
          method: 'tools/call',
          params: {
            name: 'review_yeti_attest_pr_gate',
            arguments: {
              repo: 'example-api',
              pr_number: 4836,
              head_sha: 'a'.repeat(40),
            },
          },
        },
        { env: mockEnv }
      );

      const parsed = JSON.parse(res.result.content[1].text);
      assert.equal(parsed.attested, false);
      assert.equal(parsed.gate_status, 'BLOCKED');
      assert.ok(parsed.blockers.some((b: string) => b.includes('mismatch')));
      assert.equal(parsed.attestation_token, '');
    });

    it('blocks gate when review run phase is Failed or in progress', async () => {
      const mockEnv = {
        REPO_GATE: {
          idFromName: () => 'gate_1',
          get: () => ({
            async fetch() {
              return Response.json({
                latestRunId: 'run_test_103',
              });
            },
          }),
        },
        REVIEW_RUN: {
          idFromName: () => 'run_103',
          get: () => ({
            async fetch() {
              return Response.json({
                headSha: 'c'.repeat(40),
                phase: 'Failed',
              });
            },
          }),
        },
      };

      const res = await defaultMcpRouter.handleRpc(
        {
          jsonrpc: '2.0',
          id: 'attest-3',
          method: 'tools/call',
          params: {
            name: 'review_yeti_attest_pr_gate',
            arguments: {
              repo: 'example-api',
              pr_number: 4836,
              head_sha: 'c'.repeat(40),
            },
          },
        },
        { env: mockEnv }
      );

      const parsed = JSON.parse(res.result.content[1].text);
      assert.equal(parsed.attested, false);
      assert.equal(parsed.gate_status, 'BLOCKED');
      assert.ok(parsed.blockers.some((b: string) => b.includes('Authoritative review verdict')));
    });

    it('can be called via unprefixed alias "attest_pr_gate"', async () => {
      const mockEnv = {
        REPO_GATE: {
          idFromName: () => 'gate_1',
          get: () => ({
            async fetch() {
              return Response.json({ latestRunId: 'run_test_104' });
            },
          }),
        },
        REVIEW_RUN: {
          idFromName: () => 'run_104',
          get: () => ({
            async fetch() {
              return Response.json({
                headSha: 'd'.repeat(40),
                phase: 'Completed',
              });
            },
          }),
        },
        REVIEW_YETI_ATTESTATION_SECRET: 'test-secret-123',
      };

      const res = await defaultMcpRouter.handleRpc(
        {
          jsonrpc: '2.0',
          id: 'attest-alias',
          method: 'tools/call',
          params: {
            name: 'attest_pr_gate',
            arguments: {
              repo: 'example-api',
              pr_number: 4836,
              head_sha: 'd'.repeat(40),
            },
          },
        },
        { env: mockEnv }
      );

      assert.equal(res.id, 'attest-alias');
      const parsed = JSON.parse(res.result.content[1].text);
      assert.equal(parsed.attested, true);
    });
  });

  describe('Tool: review_yeti_dispute_finding', () => {
    it('records dispute and emits DisputeFindingRecheckReceipt.v1 receipt', async () => {
      let eventPayload: any = null;
      let workflowPayload: any = null;

      const mockEnv = {
        REPO_GATE: {
          idFromName: () => 'gate_1',
          get: () => ({
            async fetch() {
              return Response.json({ latestRunId: 'run_dispute_target' });
            },
          }),
        },
        REVIEW_RUN: {
          idFromName: () => 'run_dispute_target',
          get: () => ({
            async fetch(url: string, init: any) {
              if (url.endsWith('/events')) {
                eventPayload = JSON.parse(init.body);
                return Response.json({ ok: true });
              }
              return Response.json({ ok: true });
            },
          }),
        },
        REVIEW_JOB_WORKFLOW: {
          async create(params: any) {
            workflowPayload = params;
            return { id: params.id };
          },
        },
      };

      const res = await defaultMcpRouter.handleRpc(
        {
          jsonrpc: '2.0',
          id: 'dispute-1',
          method: 'tools/call',
          params: {
            name: 'review_yeti_dispute_finding',
            arguments: {
              owner: 'exampleorg',
              repo: 'example-api',
              pr_number: 5290,
              finding_id: 'finding_epoch_fence_01',
              counter_argument: 'The lease is bounded by atomic compare-and-swap in the parent supervisor.',
            },
          },
        },
        { env: mockEnv }
      );

      assert.equal(res.jsonrpc, '2.0');
      assert.equal(res.id, 'dispute-1');
      const parsed = JSON.parse(res.result.content[1].text);
      assert.equal(parsed.version, 'DisputeFindingRecheckReceipt.v1');
      assert.equal(parsed.finding_id, 'finding_epoch_fence_01');
      assert.equal(parsed.review_status, 'fresh_re_review_requested');
      assert.ok(parsed.request_id);

      // Verify event was posted to ReviewRunDO
      assert.ok(eventPayload);
      assert.equal(eventPayload.type, 'finding:dispute_requested');
      assert.equal(eventPayload.data.findingId, 'finding_epoch_fence_01');

      // Verify recheck workflow dispatch
      assert.ok(workflowPayload);
      assert.equal(workflowPayload.params.disputeFindingId, 'finding_epoch_fence_01');
    });

    it('can be called via unprefixed alias "dispute_finding"', async () => {
      const res = await defaultMcpRouter.handleRpc({
        jsonrpc: '2.0',
        id: 'dispute-alias',
        method: 'tools/call',
        params: {
          name: 'dispute_finding',
          arguments: {
            repo: 'example-api',
            pr_number: 5290,
            finding_id: 'finding_alias_test',
            counter_argument: 'Verified by integration benchmark.',
          },
        },
      });

      const parsed = JSON.parse(res.result.content[1].text);
      assert.equal(parsed.version, 'DisputeFindingRecheckReceipt.v1');
      assert.equal(parsed.finding_id, 'finding_alias_test');
    });
  });

  describe('Tool: review_yeti_reply_review_thread', () => {
    it('posts reply using mock response injector', async () => {
      const res = await defaultMcpRouter.handleRpc({
        jsonrpc: '2.0',
        id: 'reply-1',
        method: 'tools/call',
        params: {
          name: 'review_yeti_reply_review_thread',
          arguments: {
            owner: 'exampleorg',
            repo: 'example-api',
            pr_number: 5290,
            comment_id: 998811,
            body: 'Acknowledged: the lease epoch check will be enforced.',
            _mockResponse: {
              comment_id: 123456,
              thread_id: 998811,
              reply_url: 'https://github.com/exampleorg/example-api/pull/5290#discussion_r123456',
              posted_at: '2026-10-09T12:00:00Z',
            },
          },
        },
      });

      assert.equal(res.id, 'reply-1');
      const parsed = JSON.parse(res.result.content[1].text);
      assert.equal(parsed.comment_id, 123456);
      assert.equal(parsed.thread_id, 998811);
      assert.ok(parsed.reply_url.includes('5290'));
    });
  });

  describe('SSE Transport & Batch JSON-RPC over Edge Worker', () => {
    it('establishes SSE stream via GET /api/mcp/sse and announces endpoint', async () => {
      const req = new Request('https://review-yeti.test/api/mcp/sse', {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      });
      const res = await worker.fetch(req, {} as any);

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('Content-Type'), 'text/event-stream; charset=utf-8');
      const sessionId = res.headers.get('Mcp-Session-Id');
      assert.ok(sessionId);

      // Read initial chunk from stream
      const reader = res.body?.getReader();
      assert.ok(reader);
      const chunk = await reader.read();
      const text = new TextDecoder().decode(chunk.value);
      assert.ok(text.includes('event: endpoint'));
      assert.ok(text.includes(`/api/mcp/messages?sessionId=${sessionId}`));

      await reader.cancel();
    });

    it('receives message via POST /api/mcp/messages and streams result to SSE session', async () => {
      // 1. Open SSE session
      const sseReq = new Request('https://review-yeti.test/api/mcp/sse', {
        method: 'GET',
      });
      const sseRes = await worker.fetch(sseReq, {} as any);
      const sessionId = sseRes.headers.get('Mcp-Session-Id')!;
      const reader = sseRes.body!.getReader();
      await reader.read(); // Read initial endpoint chunk

      // 2. Post inbound message
      const msgReq = new Request(`https://review-yeti.test/api/mcp/messages?sessionId=${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'ping-sse',
          method: 'ping',
        }),
      });
      const msgRes = await worker.fetch(msgReq, {} as any);
      assert.equal(msgRes.status, 202);

      // 3. Read streamed response over SSE
      const sseChunk = await reader.read();
      const sseText = new TextDecoder().decode(sseChunk.value);
      assert.ok(sseText.includes('event: message'));
      assert.ok(sseText.includes('"ping-sse"'));

      await reader.cancel();
    });

    it('handles batch JSON-RPC request on POST /api/mcp', async () => {
      const req = new Request('https://review-yeti.test/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 'b-1', method: 'ping' },
          { jsonrpc: '2.0', id: 'b-2', method: 'tools/list' },
        ]),
      });

      const res = await worker.fetch(req, {} as any);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any[];
      assert.equal(data.length, 2);
      assert.equal(data[0].id, 'b-1');
      assert.deepEqual(data[0].result, {});
      assert.equal(data[1].id, 'b-2');
      assert.equal(data[1].result.tools.length, 12);
    });
  });
});
