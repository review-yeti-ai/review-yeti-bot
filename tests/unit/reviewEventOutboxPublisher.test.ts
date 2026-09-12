import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import { describe, expect, it, vi } from 'vitest';
import type {
  ReviewYetiLifecycleEventV1,
} from '../../src/events/reviewYetiEvent';
import type { ReviewEventClaim } from '../../src/persistence/reviewEventRepository';
import {
  ReviewEventOutboxPublisher,
  type ReviewEventOutboxRepository,
} from '../../src/events/reviewEventOutboxPublisher';
import {
  createReviewEventPublisherWorkerId,
  main,
} from '../../src/reviewEventPublisherIndex';
import type {
  JetStreamPublishAck,
  ReviewEventPublishClient,
} from '../../src/events/jetStreamClient';
import { JetStreamPublishClient } from '../../src/events/jetStreamClient';

const eventId = '01J8Z5M6V7Q8R9S0T1V2W3X4Y7';

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture address');
  return address.port;
}

async function closeFixture(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function createOutboxTlsCertificate(): Promise<{
  certificatePath: string;
  certificate: Buffer;
  key: Buffer;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'review-yeti-outbox-tls-'));
  const certificatePath = join(directory, 'ca-certificate.pem');
  const caKeyPath = join(directory, 'ca-key.pem');
  const serverCertificatePath = join(directory, 'server-certificate.pem');
  const keyPath = join(directory, 'key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', caKeyPath,
    '-out', certificatePath,
    '-subj', '/CN=Review Yeti Outbox Test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-days', '1',
  ], { stdio: 'ignore' });
  const requestPath = join(directory, 'server.csr');
  execFileSync('openssl', [
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath,
    '-out', requestPath,
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], { stdio: 'ignore' });
  execFileSync('openssl', [
    'x509', '-req',
    '-in', requestPath,
    '-CA', certificatePath,
    '-CAkey', caKeyPath,
    '-CAcreateserial',
    '-out', serverCertificatePath,
    '-copy_extensions', 'copy',
    '-days', '1',
  ], { stdio: 'ignore' });
  return {
    certificatePath,
    certificate: await readFile(serverCertificatePath),
    key: await readFile(keyPath),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

interface OmittedDuplicateProbeResult {
  outcome: { status: string; published: number; released: number };
  marks: number;
  releases: number;
  connections: number;
  wireAcks: number;
  health: { state: string; lastOutcome?: string };
  secondAck?: JetStreamPublishAck;
  secondFailed: boolean;
}

async function runOmittedDuplicateOutboxProbe(
  transport: 'tcp' | 'tls',
): Promise<OmittedDuplicateProbeResult> {
  const tls = transport === 'tls' ? await createOutboxTlsCertificate() : undefined;
  const script = `
    const { once } = require('node:events');
    const { createServer } = require('node:net');
    const { createServer: createTlsServer } = require('node:tls');
    const { JetStreamPublishClient } = require('./src/events/jetStreamClient.ts');
    const { ReviewEventOutboxPublisher } = require('./src/events/reviewEventOutboxPublisher.ts');
    const transport = ${JSON.stringify(transport)};
    const event = ${JSON.stringify(lifecycleEvent)};
    const sockets = new Set();
    let connections = 0;
    let wireAcks = 0;
    const onSocket = (socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      let wire = '';
      let acknowledgedPublishes = 0;
      socket.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        wire += text;
        for (const ignored of text.matchAll(/PING\\r\\n/g)) socket.write('PONG\\r\\n');
        const publishes = Array.from(wire.matchAll(/^HPUB\\s+\\S+\\s+(\\S+)\\s+\\d+\\s+\\d+\\r\\n/gm));
        while (acknowledgedPublishes < publishes.length) {
          const reply = publishes[acknowledgedPublishes][1];
          acknowledgedPublishes += 1;
          wireAcks += 1;
          const ack = '{"stream":"CT_REVIEW_EVENTS","seq":1}';
          socket.write('MSG ' + reply + ' 1 ' + Buffer.byteLength(ack) + '\\r\\n' + ack + '\\r\\n');
        }
      });
      socket.write('INFO ' + JSON.stringify({
        server_id: 'omitted-duplicate-fixture', version: '2.10.0', proto: 1,
        host: '127.0.0.1', port: 4222, max_payload: 1048576, headers: true,
        connect_urls: [], tls_required: transport === 'tls',
      }) + '\\r\\n');
    };
    const server = transport === 'tls'
      ? createTlsServer({
          cert: Buffer.from(process.env.PROBE_TLS_CERT, 'base64'),
          key: Buffer.from(process.env.PROBE_TLS_KEY, 'base64'),
        }, onSocket)
      : createServer(onSocket);

    (async () => {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = server.address().port;
      const client = new JetStreamPublishClient({
        enabled: true,
        servers: [(transport === 'tls' ? 'tls://localhost:' : 'nats://127.0.0.1:') + port],
        token: 'synthetic-omitted-duplicate-token',
        name: 'omitted-duplicate-probe',
        connectTimeoutMs: 1000,
        publishAckTimeoutMs: 1000,
        maxReconnectAttempts: 0,
        reconnectBackoffMs: 1,
        drainTimeoutMs: 500,
        batchSize: 1,
        leaseMs: 5000,
        retryDelayMs: 100,
        pollIntervalMs: 100,
        tls: transport === 'tls' ? { handshakeFirst: true, rejectUnauthorized: true } : null,
      });
      let claimed = false;
      let marks = 0;
      let releases = 0;
      const repository = {
        claimNext: async () => {
          if (claimed) return null;
          claimed = true;
          return {
            eventId: event.event_id, runId: event.run_id, attemptId: event.attempt_id,
            repositoryId: event.repository_id, prNumber: event.pr_number,
            sequence: event.sequence, state: 'claimed', attemptCount: 1,
            leaseOwner: 'publisher-a', leaseExpiresAt: 10000, nextAttemptAt: 0,
            createdAt: 0, updatedAt: 0, event,
          };
        },
        markPublished: async () => { marks += 1; return true; },
        releaseForRetry: async () => { releases += 1; return true; },
      };
      const publisher = new ReviewEventOutboxPublisher({
        enabled: true, repository, client, workerId: 'publisher-a', batchSize: 1,
        leaseMs: 5000, retryDelayMs: 100, now: () => 2000,
      });
      const outcome = await publisher.runOnce();
      let secondAck;
      let secondFailed = false;
      try {
        secondAck = await client.publish(
          'ct.review.lifecycle.v1.0123456789abcdef01234567',
          new Uint8Array([2]),
          { messageId: event.event_id + ':health' },
        );
      } catch {
        secondFailed = true;
      }
      const result = {
        outcome, marks, releases, connections, wireAcks,
        health: client.health(), secondAck, secondFailed,
      };
      await client.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      process.stdout.write('OMITTED_DUPLICATE_RESULT ' + JSON.stringify(result) + '\\n');
    })().catch((error) => {
      process.stderr.write('OMITTED_DUPLICATE_FAILED ' + String(error && error.message) + '\\n');
      process.exitCode = 1;
    });
  `;
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ...(tls ? {
      NODE_EXTRA_CA_CERTS: tls.certificatePath,
      PROBE_TLS_CERT: tls.certificate.toString('base64'),
      PROBE_TLS_KEY: tls.key.toString('base64'),
    } : {}),
  };
  const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk) => { output += chunk.toString('utf8'); });

  try {
    const exit = await Promise.race([
      once(child, 'exit'),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error(`omitted duplicate subprocess exceeded deadline: ${output}`)),
        10_000,
      )),
    ]);
    if (exit[0] !== 0 || exit[1] !== null) {
      throw new Error(`omitted duplicate subprocess failed: ${String(exit[0])} ${String(exit[1])} ${output}`);
    }
    const match = /^OMITTED_DUPLICATE_RESULT (\{.*\})$/mu.exec(output);
    if (!match) throw new Error(`missing omitted duplicate result: ${output}`);
    return JSON.parse(match[1]) as OmittedDuplicateProbeResult;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await tls?.cleanup();
  }
}
const lifecycleEvent: ReviewYetiLifecycleEventV1 = {
  schema: 'review-yeti-event.v1',
  event_id: eventId,
  event_kind: 'review.lifecycle.terminal',
  occurred_at: '2026-09-11T20:00:00.000Z',
  repository_id: 42,
  pr_number: 73,
  base_sha: 'a'.repeat(40),
  head_sha: 'b'.repeat(40),
  attempt_id: 'attempt-private-owner/repo/customer',
  run_id: 'run-private-owner/repo/customer',
  sequence: 3,
  correlation_id: 'correlation-73',
  trace_id: 'trace-73',
  visibility: 'internal',
  data: { stage: 'terminal', terminal_class: 'clean' },
};

function claim(): ReviewEventClaim {
  return {
    eventId,
    runId: lifecycleEvent.run_id,
    attemptId: lifecycleEvent.attempt_id,
    repositoryId: lifecycleEvent.repository_id,
    prNumber: lifecycleEvent.pr_number,
    sequence: lifecycleEvent.sequence,
    state: 'claimed',
    attemptCount: 1,
    leaseOwner: 'publisher-a',
    leaseExpiresAt: 10_000,
    nextAttemptAt: 0,
    createdAt: 0,
    updatedAt: 0,
    event: lifecycleEvent,
  };
}

function repositoryFor(record: ReviewEventClaim): ReviewEventOutboxRepository {
  return {
    claimNext: vi.fn()
      .mockResolvedValueOnce(record)
      .mockResolvedValueOnce(null),
    markPublished: vi.fn().mockResolvedValue(true),
    releaseForRetry: vi.fn().mockResolvedValue(true),
  };
}

function clientFor(ack: JetStreamPublishAck = {
  acknowledged: true,
  duplicate: false,
  stream: 'CT_REVIEW_EVENTS',
  sequence: 17,
}): ReviewEventPublishClient {
  return {
    connect: vi.fn().mockResolvedValue({ state: 'connected' }),
    publish: vi.fn().mockResolvedValue(ack),
    drain: vi.fn().mockResolvedValue({ state: 'drained' }),
    close: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockReturnValue({ state: 'connected' }),
  };
}

describe('ReviewEventOutboxPublisher', () => {
  it('creates a unique opaque worker lease owner for each process incarnation', () => {
    const first = createReviewEventPublisherWorkerId('review-event-publisher');
    const second = createReviewEventPublisherWorkerId('review-event-publisher');

    expect(first).toMatch(/^review-event-publisher:outbox:[0-9a-f]{16}$/u);
    expect(second).toMatch(/^review-event-publisher:outbox:[0-9a-f]{16}$/u);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(100);
  });

  it('claims a bounded lifecycle batch, hashes the subject suffix, and marks only after ack', async () => {
    const repository = repositoryFor(claim());
    const client = clientFor();
    const calls: string[] = [];
    vi.mocked(client.publish).mockImplementation(async (...args) => {
      calls.push('publish');
      expect(args[2]).toEqual({ messageId: eventId });
      expect(args[0]).toMatch(/^ct\.review\.lifecycle\.v1\.[0-9a-f]{24}$/u);
      expect(args[0]).not.toContain('private-owner');
      expect(new TextDecoder().decode(args[1])).toBe(JSON.stringify(lifecycleEvent));
      return { acknowledged: true, duplicate: false, stream: 'CT_REVIEW_EVENTS', sequence: 17 };
    });
    vi.mocked(repository.markPublished).mockImplementation(async () => {
      calls.push('mark');
      return true;
    });
    const now = vi.fn()
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(2_100)
      .mockReturnValueOnce(2_200);

    const publisher = new ReviewEventOutboxPublisher({
      enabled: true,
      repository,
      client,
      workerId: 'publisher-a',
      batchSize: 1,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
      now,
    });

    const outcome = await publisher.runOnce();

    expect(outcome).toMatchObject({ status: 'published', claimed: 1, published: 1, failed: 0 });
    expect(calls).toEqual(['publish', 'mark']);
    expect(repository.markPublished).toHaveBeenCalledWith(eventId, 'publisher-a', 2_200, 'acknowledged');
    expect(now).toHaveBeenCalledTimes(3);
  });

  it('treats a duplicate JetStream acknowledgement as success', async () => {
    const repository = repositoryFor(claim());
    const client = clientFor({
      acknowledged: true,
      duplicate: true,
      stream: 'CT_REVIEW_EVENTS',
      sequence: 17,
    });
    const publisher = new ReviewEventOutboxPublisher({
      enabled: true,
      repository,
      client,
      workerId: 'publisher-a',
      batchSize: 1,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
      now: () => 2_000,
    });

    const outcome = await publisher.runOnce();

    expect(outcome).toMatchObject({ status: 'published', published: 1, failed: 0 });
    expect(repository.markPublished).toHaveBeenCalledWith(eventId, 'publisher-a', 2_000, 'duplicate');
  });

  it('reports lease loss when an acknowledged publish cannot be marked published', async () => {
    const repository = repositoryFor(claim());
    const client = clientFor();
    const calls: string[] = [];
    vi.mocked(client.publish).mockImplementation(async () => {
      calls.push('publish');
      return { acknowledged: true, duplicate: false, stream: 'CT_REVIEW_EVENTS', sequence: 17 };
    });
    vi.mocked(repository.markPublished).mockImplementation(async () => {
      calls.push('mark');
      return false;
    });
    const publisher = new ReviewEventOutboxPublisher({
      enabled: true,
      repository,
      client,
      workerId: 'publisher-a',
      batchSize: 1,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
      now: () => 2_000,
    });

    const outcome = await publisher.runOnce();

    expect(calls).toEqual(['publish', 'mark']);
    expect(repository.markPublished).toHaveBeenCalledWith(eventId, 'publisher-a', 2_000, 'acknowledged');
    expect(outcome).toMatchObject({
      status: 'retry',
      claimed: 1,
      published: 0,
      failed: 0,
      released: 0,
      leaseLost: 1,
    });
  });

  it('reports mark failure after an acknowledged publish without counting it as published', async () => {
    const repository = repositoryFor(claim());
    const client = clientFor();
    const calls: string[] = [];
    vi.mocked(client.publish).mockImplementation(async () => {
      calls.push('publish');
      return { acknowledged: true, duplicate: false, stream: 'CT_REVIEW_EVENTS', sequence: 17 };
    });
    vi.mocked(repository.markPublished).mockImplementation(async () => {
      calls.push('mark');
      throw new Error('database mark failed');
    });
    const publisher = new ReviewEventOutboxPublisher({
      enabled: true,
      repository,
      client,
      workerId: 'publisher-a',
      batchSize: 1,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
      now: () => 2_000,
    });

    const outcome = await publisher.runOnce();

    expect(calls).toEqual(['publish', 'mark']);
    expect(repository.markPublished).toHaveBeenCalledWith(eventId, 'publisher-a', 2_000, 'acknowledged');
    expect(outcome).toMatchObject({
      status: 'retry',
      claimed: 1,
      published: 0,
      failed: 1,
      released: 0,
      leaseLost: 0,
      errorCode: 'mark_published_failed',
    });
  });

  it('releases the PostgreSQL claim for bounded retry on NATS failure and never marks it published', async () => {
    const repository = repositoryFor(claim());
    const client = clientFor();
    vi.mocked(client.publish).mockRejectedValue(new Error('nats://user:secret@provider raw payload customer text'));
    const publisher = new ReviewEventOutboxPublisher({
      enabled: true,
      repository,
      client,
      workerId: 'publisher-a',
      batchSize: 1,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
      now: () => 2_000,
    });

    const outcome = await publisher.runOnce();

    expect(outcome).toMatchObject({ status: 'retry', claimed: 1, published: 0, failed: 1, errorCode: 'publish_failed' });
    expect(repository.releaseForRetry).toHaveBeenCalledWith(eventId, 'publisher-a', 2_000, 2_000);
    expect(repository.markPublished).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).not.toMatch(/secret|customer|payload|nats:\/\//iu);
  });

  it('reports retry release failure after publication failure without marking the event published', async () => {
    const repository = repositoryFor(claim());
    const client = clientFor();
    const calls: string[] = [];
    vi.mocked(client.publish).mockImplementation(async () => {
      calls.push('publish');
      throw new Error('transport unavailable');
    });
    vi.mocked(repository.releaseForRetry).mockImplementation(async () => {
      calls.push('release');
      throw new Error('database retry release failed');
    });
    const publisher = new ReviewEventOutboxPublisher({
      enabled: true,
      repository,
      client,
      workerId: 'publisher-a',
      batchSize: 1,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
      now: () => 2_000,
    });

    const outcome = await publisher.runOnce();

    expect(calls).toEqual(['publish', 'release']);
    expect(repository.claimNext).toHaveBeenCalledTimes(1);
    expect(client.publish).toHaveBeenCalledTimes(1);
    expect(repository.releaseForRetry).toHaveBeenCalledWith(eventId, 'publisher-a', 2_000, 2_000);
    expect(repository.markPublished).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: 'retry',
      claimed: 1,
      published: 0,
      failed: 1,
      released: 0,
      leaseLost: 0,
      errorCode: 'retry_release_failed',
    });
  });

  it('does not mark the outbox published when the transport receives a non-string PubAck stream', async () => {
    const repository = repositoryFor(claim());
    const transport = new JetStreamPublishClient({
      enabled: true,
      servers: ['tls://private-nats.internal:4222'],
      token: 'private-token',
      name: 'publisher-test',
      connectTimeoutMs: 100,
      publishAckTimeoutMs: 100,
      maxReconnectAttempts: 0,
      reconnectBackoffMs: 1,
      drainTimeoutMs: 100,
      batchSize: 1,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
      pollIntervalMs: 100,
      tls: { handshakeFirst: true, rejectUnauthorized: true },
    }, async () => ({
      jetstream: () => ({
        publish: async () => ({ duplicate: false, stream: 42, seq: 17 } as never),
      }),
      drain: async () => undefined,
      close: async () => undefined,
    }));
    const publisher = new ReviewEventOutboxPublisher({
      enabled: true,
      repository,
      client: transport,
      workerId: 'publisher-a',
      batchSize: 1,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
      now: () => 2_000,
    });

    const outcome = await publisher.runOnce();

    expect(outcome).toMatchObject({ status: 'retry', published: 0, failed: 1, released: 1 });
    expect(repository.markPublished).not.toHaveBeenCalled();
    expect(repository.releaseForRetry).toHaveBeenCalledTimes(1);
  });

  it('releases instead of marking when the official adapter receives raw duplicate null', async () => {
    const sockets = new Set<Socket>();
    let ackSent = false;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let wire = '';
      socket.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        wire += text;
        if (text.includes('PING\r\n')) socket.write('PONG\r\n');
        const publish = /^HPUB\s+\S+\s+(\S+)\s+\d+\s+\d+\r\n/mu.exec(wire);
        if (publish && !ackSent) {
          ackSent = true;
          const ack = JSON.stringify({ stream: 'CT_REVIEW_EVENTS', seq: 17, duplicate: null });
          socket.write(`MSG ${publish[1]} 1 ${Buffer.byteLength(ack)}\r\n${ack}\r\n`);
        }
      });
      socket.write('INFO {"server_id":"outbox-ack","version":"2.10.0","proto":1,"host":"127.0.0.1","port":4222,"max_payload":1048576,"connect_urls":[]}\r\n');
    });
    const port = await listen(server);
    const repository = repositoryFor(claim());
    const transport = new JetStreamPublishClient({
      enabled: true,
      servers: [`nats://127.0.0.1:${port}`],
      token: 'synthetic-outbox-token',
      name: 'publisher-raw-ack-test',
      connectTimeoutMs: 500,
      publishAckTimeoutMs: 500,
      maxReconnectAttempts: 0,
      reconnectBackoffMs: 1,
      drainTimeoutMs: 100,
      batchSize: 1,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
      pollIntervalMs: 100,
      tls: null,
    });
    const publisher = new ReviewEventOutboxPublisher({
      enabled: true,
      repository,
      client: transport,
      workerId: 'publisher-a',
      batchSize: 1,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
      now: () => 2_000,
    });

    try {
      const outcome = await publisher.runOnce();

      expect(outcome).toMatchObject({ status: 'retry', published: 0, failed: 1, released: 1 });
      expect(repository.markPublished).not.toHaveBeenCalled();
      expect(repository.releaseForRetry).toHaveBeenCalledTimes(1);
      expect(ackSent).toBe(true);
    } finally {
      await transport.close().catch(() => undefined);
      await closeFixture(server, sockets);
    }
  });

  it.each(['tcp', 'tls'] as const)(
    'marks an omitted-duplicate PubAck once over real %s and retains the healthy connection',
    async (transport) => {
      const result = await runOmittedDuplicateOutboxProbe(transport);

      expect(result.outcome).toMatchObject({ status: 'published', published: 1, released: 0 });
      expect(result.marks).toBe(1);
      expect(result.releases).toBe(0);
      expect(result.connections).toBe(1);
      expect(result.wireAcks).toBe(2);
      expect(result.health).toMatchObject({ state: 'connected', lastOutcome: 'acknowledged' });
      expect(result.secondFailed).toBe(false);
      expect(result.secondAck).toMatchObject({
        acknowledged: true,
        duplicate: false,
        stream: 'CT_REVIEW_EVENTS',
        sequence: 1,
      });
    },
    15_000,
  );

  it('reads a fresh clock immediately before claim, publish, and retry release', async () => {
    const repository = repositoryFor(claim());
    const client = clientFor();
    vi.mocked(client.publish).mockRejectedValue(new Error('unavailable'));
    const now = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_100)
      .mockReturnValueOnce(1_200);
    const publisher = new ReviewEventOutboxPublisher({
      enabled: true,
      repository,
      client,
      workerId: 'publisher-a',
      batchSize: 1,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
      now,
    });

    await publisher.runOnce();

    expect(repository.claimNext).toHaveBeenCalledWith('publisher-a', 1_000, 5_000);
    expect(client.publish).toHaveBeenCalledTimes(1);
    expect(repository.releaseForRetry).toHaveBeenCalledWith(eventId, 'publisher-a', 1_200, 2_000);
    expect(now).toHaveBeenCalledTimes(3);
  });

  it('does not mark an acknowledged event after its lease expires and leaves it for PostgreSQL reclaim', async () => {
    const expiringClaim = { ...claim(), leaseExpiresAt: 1_150 };
    const repository = repositoryFor(expiringClaim);
    const client = clientFor();
    const now = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_100)
      .mockReturnValueOnce(1_200);
    const publisher = new ReviewEventOutboxPublisher({
      enabled: true,
      repository,
      client,
      workerId: 'publisher-a',
      batchSize: 1,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
      now,
    });

    const outcome = await publisher.runOnce();

    expect(client.publish).toHaveBeenCalledTimes(1);
    expect(repository.markPublished).not.toHaveBeenCalled();
    expect(repository.releaseForRetry).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: 'retry', published: 0, leaseLost: 1 });
  });

  it('does not publish a claim whose lease is already expired before transport work', async () => {
    const expiredClaim = { ...claim(), leaseExpiresAt: 1_050 };
    const repository = repositoryFor(expiredClaim);
    const client = clientFor();
    const now = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_100);
    const publisher = new ReviewEventOutboxPublisher({
      enabled: true,
      repository,
      client,
      workerId: 'publisher-a',
      batchSize: 1,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
      now,
    });

    const outcome = await publisher.runOnce();

    expect(client.publish).not.toHaveBeenCalled();
    expect(repository.markPublished).not.toHaveBeenCalled();
    expect(repository.releaseForRetry).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: 'retry', published: 0, leaseLost: 1 });
  });

  it('releases a claimed event when aborted before publish and stops the batch', async () => {
    const controller = new AbortController();
    const repository: ReviewEventOutboxRepository = {
      claimNext: vi.fn()
        .mockImplementationOnce(() => Promise.resolve(claim()).then((claimed) => {
          controller.abort();
          return claimed;
        }))
        .mockResolvedValueOnce(null),
      markPublished: vi.fn().mockResolvedValue(true),
      releaseForRetry: vi.fn().mockResolvedValue(true),
    };
    const client = clientFor();
    const now = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_100);
    const publisher = new ReviewEventOutboxPublisher({
      enabled: true,
      repository,
      client,
      workerId: 'publisher-a',
      batchSize: 2,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
      now,
    });

    const outcome = await publisher.runOnce(controller.signal);

    expect(repository.claimNext).toHaveBeenCalledWith('publisher-a', 1_000, 5_000);
    expect(repository.releaseForRetry).toHaveBeenCalledWith(eventId, 'publisher-a', 1_100, 2_000);
    expect(outcome).toMatchObject({
      status: 'retry',
      errorCode: 'aborted',
      claimed: 1,
      released: 1,
      published: 0,
      failed: 0,
      leaseLost: 0,
    });
    expect(client.publish).not.toHaveBeenCalled();
    expect(repository.markPublished).not.toHaveBeenCalled();
    expect(repository.claimNext).toHaveBeenCalledTimes(1);
    expect(now).toHaveBeenCalledTimes(2);
  });

  it('releases a claimed event when aborted after the publish acknowledgement', async () => {
    const controller = new AbortController();
    const repository = repositoryFor(claim());
    const client = clientFor();
    vi.mocked(client.publish).mockImplementation(async () => {
      controller.abort();
      return { acknowledged: true, duplicate: false, stream: 'CT_REVIEW_EVENTS', sequence: 17 };
    });
    const publisher = new ReviewEventOutboxPublisher({
      enabled: true,
      repository,
      client,
      workerId: 'publisher-a',
      batchSize: 2,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
      now: () => 2_000,
    });

    const outcome = await publisher.runOnce(controller.signal);

    expect(client.publish).toHaveBeenCalledTimes(1);
    expect(repository.releaseForRetry).toHaveBeenCalledWith(eventId, 'publisher-a', 2_000, 2_000);
    expect(repository.markPublished).not.toHaveBeenCalled();
    expect(repository.claimNext).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      status: 'retry',
      errorCode: 'aborted',
      claimed: 1,
      released: 1,
      published: 0,
      failed: 0,
      leaseLost: 0,
    });
  });

  it('propagates cancellation and performs no subsequent claim after abort during publish', async () => {
    const repository = repositoryFor(claim());
    const client = clientFor();
    let rejectPublish!: (reason: Error) => void;
    vi.mocked(client.publish).mockImplementation(() => new Promise((_, reject) => {
      rejectPublish = reject;
    }));
    const publisher = new ReviewEventOutboxPublisher({
      enabled: true,
      repository,
      client,
      workerId: 'publisher-a',
      batchSize: 2,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
      now: () => 2_000,
    });
    const controller = new AbortController();

    const running = publisher.runOnce(controller.signal);
    await vi.waitFor(() => expect(client.publish).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.publish).mock.calls[0][2]).toEqual(expect.objectContaining({ signal: controller.signal }));
    controller.abort();
    rejectPublish(new Error('aborted provider text'));
    const outcome = await running;

    expect(repository.claimNext).toHaveBeenCalledTimes(1);
    expect(outcome.claimed).toBe(1);
    expect(outcome.published).toBe(0);
  });

  it('does not mark before the publish acknowledgement resolves', async () => {
    const repository = repositoryFor(claim());
    const client = clientFor();
    let resolvePublish!: (ack: JetStreamPublishAck) => void;
    vi.mocked(client.publish).mockImplementation(() => new Promise((resolve) => {
      resolvePublish = resolve;
    }));
    const publisher = new ReviewEventOutboxPublisher({
      enabled: true,
      repository,
      client,
      workerId: 'publisher-a',
      batchSize: 1,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
      now: () => 2_000,
    });

    const running = publisher.runOnce();
    await Promise.resolve();
    expect(repository.markPublished).not.toHaveBeenCalled();

    resolvePublish({ acknowledged: true, duplicate: false, stream: 'CT_REVIEW_EVENTS', sequence: 17 });
    await expect(running).resolves.toMatchObject({ published: 1 });
    expect(repository.markPublished).toHaveBeenCalledTimes(1);
  });

  it('does no database or transport work when disabled', async () => {
    const repository = repositoryFor(claim());
    const client = clientFor();
    const publisher = new ReviewEventOutboxPublisher({
      enabled: false,
      repository,
      client,
      workerId: 'publisher-a',
      batchSize: 1,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
    });

    await expect(publisher.runOnce()).resolves.toMatchObject({ status: 'disabled' });
    expect(repository.claimNext).not.toHaveBeenCalled();
    expect(client.publish).not.toHaveBeenCalled();
  });

  it('drains the transport during graceful shutdown', async () => {
    const repository = repositoryFor(claim());
    const client = clientFor();
    const publisher = new ReviewEventOutboxPublisher({
      enabled: true,
      repository,
      client,
      workerId: 'publisher-a',
      batchSize: 1,
      leaseMs: 5_000,
      retryDelayMs: 2_000,
    });

    await publisher.shutdown();

    expect(client.drain).toHaveBeenCalledTimes(1);
  });

  it('closes initialized resources when repository construction fails during startup', async () => {
    const failure = new Error('repository construction failed');
    const store = {
      initialize: vi.fn().mockResolvedValue(undefined),
      getPool: vi.fn(() => ({}) as never),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const client = clientFor();

    await expect(main({
      NODE_ENV: 'test',
      CT_REVIEW_EVENTS_ENABLED: 'true',
      CT_REVIEW_EVENTS_NATS_URL: 'tls://127.0.0.1:4222',
      CT_REVIEW_EVENTS_NATS_TOKEN: 'synthetic-main-token',
    }, {
      createStore: () => store,
      createClient: () => client,
      createRepository: () => { throw failure; },
    })).rejects.toBe(failure);

    expect(store.initialize).toHaveBeenCalledTimes(1);
    expect(store.getPool).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.drain).not.toHaveBeenCalled();
    expect(store.close).toHaveBeenCalledTimes(1);
  });

  it('always cancels the watchdog and removes signal listeners when store close rejects', async () => {
    const sigtermBefore = process.rawListeners('SIGTERM');
    const sigintBefore = process.rawListeners('SIGINT');
    const priorExitCode = process.exitCode;
    const cancelWatchdog = vi.fn();
    const scheduleWatchdog = vi.fn(() => cancelWatchdog);
    const rawSecret = 'synthetic-store-close-secret';
    let signalled = false;

    try {
      await expect(main({
        NODE_ENV: 'test',
        CT_REVIEW_EVENTS_ENABLED: 'true',
        CT_REVIEW_EVENTS_NATS_URL: 'tls://127.0.0.1:4222',
        CT_REVIEW_EVENTS_NATS_TOKEN: 'synthetic-main-token',
        CT_REVIEW_EVENTS_DRAIN_TIMEOUT_MS: '100',
        CT_REVIEW_EVENTS_POLL_INTERVAL_MS: '100',
      }, {
        createStore: () => ({
          initialize: async () => undefined,
          getPool: () => ({}) as never,
          close: async () => { throw new Error(rawSecret); },
        }),
        createRepository: () => ({
          claimNext: async () => {
            if (!signalled) {
              signalled = true;
              const added = process.rawListeners('SIGTERM').find((listener) => !sigtermBefore.includes(listener));
              if (!added) throw new Error('missing SIGTERM listener');
              added.call(process);
            }
            return null;
          },
          markPublished: async () => true,
          releaseForRetry: async () => true,
        }),
        createClient: () => ({
          connect: async () => ({ state: 'connected', connectAttempts: 1 }),
          publish: async () => ({ acknowledged: true, duplicate: false, stream: 'EVENTS', sequence: 1 }),
          drain: async () => ({ state: 'drained', connectAttempts: 1 }),
          close: async () => undefined,
          health: () => ({ state: 'connected', connectAttempts: 1 }),
        }),
        scheduleForcedExit: scheduleWatchdog,
      })).rejects.toThrow('Review event publisher shutdown failed');

      expect(scheduleWatchdog).toHaveBeenCalledTimes(1);
      expect(scheduleWatchdog).toHaveBeenCalledWith(100);
      expect(cancelWatchdog).toHaveBeenCalledTimes(1);
      expect(process.rawListeners('SIGTERM')).toHaveLength(sigtermBefore.length);
      expect(process.rawListeners('SIGINT')).toHaveLength(sigintBefore.length);
      expect(process.exitCode).toBe(1);
    } finally {
      for (const listener of process.rawListeners('SIGTERM')) {
        const raw = listener as Function & { listener?: (...args: unknown[]) => void };
        if (!sigtermBefore.includes(listener)) {
          process.removeListener('SIGTERM', raw.listener || (listener as (...args: unknown[]) => void));
        }
      }
      for (const listener of process.rawListeners('SIGINT')) {
        const raw = listener as Function & { listener?: (...args: unknown[]) => void };
        if (!sigintBefore.includes(listener)) {
          process.removeListener('SIGINT', raw.listener || (listener as (...args: unknown[]) => void));
        }
      }
      process.exitCode = priorExitCode;
    }
  });
});
