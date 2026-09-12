import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import { describe, expect, it, vi } from 'vitest';
import {
  JetStreamPublishClient,
  MAX_PUBLISH_PAYLOAD_BYTES,
  type JetStreamConnectionLike,
  type NatsEventPublisherConfig,
} from '../../src/events/jetStreamClient';

const eventId = '01J8Z5M6V7Q8R9S0T1V2W3X4Y7';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function activeMessagePortCount(): number {
  const processWithHandles = process as NodeJS.Process & { _getActiveHandles(): unknown[] };
  return processWithHandles._getActiveHandles()
    .filter((handle) => (handle as { constructor?: { name?: string } }).constructor?.name === 'MessagePort')
    .length;
}

async function listen(server: Server, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture address');
  return address.port;
}

async function closeFixture(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function nonLoopbackIpv4(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '0.0.0.0';
}

function infoLine(
  port: number,
  connectUrls: string[] = [],
  extra: Record<string, unknown> = {},
): string {
  return `INFO ${JSON.stringify({
    server_id: `fixture-${port}`,
    version: '2.10.0',
    proto: 1,
    host: '127.0.0.1',
    port,
    max_payload: 1_048_576,
    connect_urls: connectUrls,
    ...extra,
  })}\r\n`;
}

async function createTlsCertificate(): Promise<{
  certificatePath: string;
  certificate: Buffer;
  key: Buffer;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'review-yeti-nats-tls-'));
  const certificatePath = join(directory, 'ca-certificate.pem');
  const caKeyPath = join(directory, 'ca-key.pem');
  const serverCertificatePath = join(directory, 'server-certificate.pem');
  const keyPath = join(directory, 'key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', caKeyPath,
    '-out', certificatePath,
    '-subj', '/CN=Review Yeti Test CA',
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

type ShutdownTransport = 'tcp' | 'tls';
type ShutdownOrder = 'close-drain' | 'drain-close';

interface ShutdownOrderingProbeResult {
  firstSettled: boolean;
  messagePorts: number;
  sockets: number;
  state: string;
}

async function runShutdownOrderingProbe(
  transport: ShutdownTransport,
  order: ShutdownOrder,
): Promise<ShutdownOrderingProbeResult> {
  const tls = transport === 'tls' ? await createTlsCertificate() : undefined;
  const script = `
    const { once } = require('node:events');
    const { createServer } = require('node:net');
    const { createServer: createTlsServer } = require('node:tls');
    const { JetStreamPublishClient } = require('./src/events/jetStreamClient.ts');
    const transport = ${JSON.stringify(transport)};
    const order = ${JSON.stringify(order)};
    const sockets = new Set();
    const activeMessagePortCount = () => process._getActiveHandles()
      .filter((handle) => handle.constructor && handle.constructor.name === 'MessagePort').length;
    const onSocket = (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      socket.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        for (const ignored of text.matchAll(/PING\\r\\n/g)) socket.write('PONG\\r\\n');
      });
      socket.write('INFO ' + JSON.stringify({
        server_id: 'shutdown-ordering-fixture', version: '2.10.0', proto: 1,
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
      const baselineMessagePorts = activeMessagePortCount();
      const client = new JetStreamPublishClient({
        enabled: true,
        servers: [(transport === 'tls' ? 'tls://localhost:' : 'nats://127.0.0.1:') + port],
        token: 'synthetic-shutdown-ordering-token',
        name: 'shutdown-ordering-probe',
        connectTimeoutMs: 1000,
        publishAckTimeoutMs: 500,
        maxReconnectAttempts: 0,
        reconnectBackoffMs: 1,
        drainTimeoutMs: 500,
        batchSize: 1,
        leaseMs: 5000,
        retryDelayMs: 100,
        pollIntervalMs: 100,
        tls: transport === 'tls' ? { handshakeFirst: true, rejectUnauthorized: true } : null,
      });
      await client.connect();

      let firstSettled = false;
      const first = (order === 'close-drain' ? client.close() : client.drain())
        .then((value) => { firstSettled = true; return value; });
      const second = order === 'close-drain' ? client.drain() : client.close();
      await Promise.race([
        second,
        new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown ordering timeout')), 2000)),
      ]);
      const result = {
        firstSettled,
        messagePorts: activeMessagePortCount() - baselineMessagePorts,
        sockets: sockets.size,
        state: client.health().state,
      };
      await first;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      process.stdout.write('SHUTDOWN_ORDER_RESULT ' + JSON.stringify(result) + '\\n');
    })().catch((error) => {
      process.stderr.write('SHUTDOWN_ORDER_FAILED ' + String(error && error.message) + '\\n');
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
      delay(8_000).then(() => { throw new Error(`shutdown ordering subprocess exceeded deadline: ${output}`); }),
    ]);
    if (exit[0] !== 0 || exit[1] !== null) {
      throw new Error(`shutdown ordering subprocess failed: ${String(exit[0])} ${String(exit[1])} ${output}`);
    }
    const match = /^SHUTDOWN_ORDER_RESULT (\{.*\})$/mu.exec(output);
    if (!match) throw new Error(`missing shutdown ordering result: ${output}`);
    return JSON.parse(match[1]) as ShutdownOrderingProbeResult;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await tls?.cleanup();
  }
}

function config(overrides: Partial<NatsEventPublisherConfig> = {}): NatsEventPublisherConfig {
  return {
    enabled: true,
    servers: ['tls://private-nats.internal:4222'],
    token: 'private-token',
    name: 'review-event-publisher-test',
    connectTimeoutMs: 50,
    publishAckTimeoutMs: 50,
    maxReconnectAttempts: 0,
    reconnectBackoffMs: 1,
    drainTimeoutMs: 50,
    batchSize: 2,
    leaseMs: 5_000,
    retryDelayMs: 2_000,
    pollIntervalMs: 10,
    tls: { handshakeFirst: true, rejectUnauthorized: true },
    ...overrides,
  };
}

function connection(
  publish: JetStreamConnectionLike['jetstream'] extends () => infer T
    ? T extends { publish: infer P } ? P : never
    : never,
): JetStreamConnectionLike {
  return {
    jetstream: () => ({ publish } as never),
    drain: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('JetStream publish client', () => {
  it('ignores plaintext cluster discovery that advertises a non-loopback listener', async () => {
    const token = 'synthetic-discovery-token';
    const advertisedWire: Buffer[] = [];
    const advertisedSockets = new Set<Socket>();
    const advertised = createServer((socket) => {
      advertisedSockets.add(socket);
      socket.on('close', () => advertisedSockets.delete(socket));
      socket.on('data', (chunk) => {
        advertisedWire.push(Buffer.from(chunk));
        if (Buffer.concat(advertisedWire).includes(Buffer.from('PING\r\n'))) socket.write('PONG\r\n');
      });
      socket.write(infoLine(0));
    });
    const advertisedPort = await listen(advertised, '0.0.0.0');
    const advertisedHost = nonLoopbackIpv4();

    const seedSockets = new Set<Socket>();
    let seedWire = '';
    const seed = createServer((socket) => {
      seedSockets.add(socket);
      socket.on('close', () => seedSockets.delete(socket));
      socket.on('data', (chunk) => {
        seedWire += chunk.toString('utf8');
        if (seedWire.includes('PING\r\n')) {
          socket.write('PONG\r\n');
          setTimeout(() => {
            socket.destroy();
            if (seed.listening) seed.close();
          }, 10);
        }
      });
      socket.write(infoLine(0, [`${advertisedHost}:${advertisedPort}`]));
    });
    const seedPort = await listen(seed);
    const client = new JetStreamPublishClient(config({
      servers: [`nats://127.0.0.1:${seedPort}`],
      tls: null,
      token,
      connectTimeoutMs: 500,
      maxReconnectAttempts: 5,
      reconnectBackoffMs: 1,
    }));

    try {
      await client.connect();
      await delay(300);

      const wire = Buffer.concat(advertisedWire).toString('utf8');
      expect(advertisedSockets.size).toBe(0);
      expect(wire).not.toContain('CONNECT');
      expect(wire).not.toContain(token);
    } finally {
      await client.close().catch(() => undefined);
      await closeFixture(seed, seedSockets);
      await closeFixture(advertised, advertisedSockets);
    }
  });

  it('performs a verified TLS handshake before sending credentials to a plaintext probe', async () => {
    const received: Buffer[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', (chunk) => received.push(Buffer.from(chunk)));
      socket.write('INFO {"server_id":"plaintext-probe","version":"2.10.0","proto":1,"host":"127.0.0.1","port":4222,"max_payload":1048576}\r\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing fixture address');
    const token = 'synthetic-token-must-not-cross-plaintext';
    const client = new JetStreamPublishClient(config({
      servers: [`tls://127.0.0.1:${address.port}`],
      token,
      connectTimeoutMs: 500,
    }));

    try {
      await expect(client.connect()).rejects.toMatchObject({ code: expect.stringMatching(/^connect_/u) });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const wire = Buffer.concat(received).toString('latin1');
      expect(received.length).toBeGreaterThan(0);
      expect(wire).not.toContain(token);
      expect(wire).not.toContain('CONNECT');
    } finally {
      await client.close().catch(() => undefined);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('preserves cluster discovery for verified TLS servers', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('fixture unavailable'));
    const client = new JetStreamPublishClient(config(), connect);

    await expect(client.connect()).rejects.toMatchObject({ code: 'connect_failed' });

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        servers: ['tls://private-nats.internal:4222'],
        tls: { handshakeFirst: true, rejectUnauthorized: true },
        ignoreClusterUpdates: false,
      }),
      expect.any(AbortSignal),
    );
  });

  it('closes all three real TLS sockets when bounded handshake attempts stall', async () => {
    const received: Buffer[] = [];
    const sockets = new Set<Socket>();
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', (chunk) => received.push(Buffer.from(chunk)));
    });
    const port = await listen(server);
    const client = new JetStreamPublishClient(config({
      servers: [`tls://127.0.0.1:${port}`],
      connectTimeoutMs: 250,
      drainTimeoutMs: 100,
      maxReconnectAttempts: 2,
      reconnectBackoffMs: 1,
    }));

    try {
      await expect(client.connect()).rejects.toMatchObject({ code: 'connect_timeout' });
      await client.drain();
      await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 500 });
      expect(connections).toBe(3);
      const wire = Buffer.concat(received).toString('latin1');
      expect(wire).not.toContain('CONNECT');
      expect(wire).not.toContain('private-token');
    } finally {
      await client.close().catch(() => undefined);
      await closeFixture(server, sockets);
    }
  });

  it('closes all three real loopback plaintext sockets when protocol handshakes stall', async () => {
    const sockets = new Set<Socket>();
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    const port = await listen(server);
    const client = new JetStreamPublishClient(config({
      servers: [`nats://127.0.0.1:${port}`],
      tls: null,
      connectTimeoutMs: 250,
      drainTimeoutMs: 100,
      maxReconnectAttempts: 2,
      reconnectBackoffMs: 1,
    }));

    try {
      await expect(client.connect()).rejects.toMatchObject({ code: 'connect_timeout' });
      await client.drain();
      await client.close();
      await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 500 });
      expect(connections).toBe(3);
      expect(client.health()).toMatchObject({ state: 'closed', connectAttempts: 3 });
    } finally {
      await client.close().catch(() => undefined);
      await closeFixture(server, sockets);
    }
  });

  it.each(['drain', 'close'] as const)(
    'waits for a connecting worker and its active handles before startup %s resolves',
    async (operation) => {
      const sockets = new Set<Socket>();
      let acceptConnection!: () => void;
      const accepted = new Promise<void>((resolve) => {
        acceptConnection = resolve;
      });
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.resume();
        acceptConnection();
      });
      const port = await listen(server);
      const baselineMessagePorts = activeMessagePortCount();
      const client = new JetStreamPublishClient(config({
        servers: [`tls://127.0.0.1:${port}`],
        connectTimeoutMs: 5_000,
        drainTimeoutMs: 250,
      }));
      const connecting = client.connect().catch((error: unknown) => error);

      try {
        await accepted;
        expect(activeMessagePortCount()).toBeGreaterThan(baselineMessagePorts);

        if (operation === 'drain') await client.drain();
        else await client.close();
        await connecting;

        expect(sockets.size).toBe(0);
        expect(activeMessagePortCount()).toBe(baselineMessagePorts);
      } finally {
        await client.close().catch(() => undefined);
        await vi.waitFor(() => expect(activeMessagePortCount()).toBe(baselineMessagePorts), { timeout: 1_000 });
        await closeFixture(server, sockets);
      }
    },
  );

  it.each([
    ['tcp', 'close-drain'],
    ['tcp', 'drain-close'],
    ['tls', 'close-drain'],
    ['tls', 'drain-close'],
  ] as const)(
    'waits for real %s worker resources when shutdown order is %s',
    async (transport, order) => {
      const result = await runShutdownOrderingProbe(transport, order);

      expect(result).toEqual({
        firstSettled: true,
        messagePorts: 0,
        sockets: 0,
        state: 'closed',
      });
    },
    12_000,
  );

  it('rejects a malformed PubAck returned by the real v3 adapter', async () => {
    const sockets = new Set<Socket>();
    let malformedAckSent = false;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let wire = '';
      socket.on('data', (chunk) => {
        wire += chunk.toString('utf8');
        if (wire.includes('PING\r\n')) socket.write('PONG\r\n');
        const publish = /^HPUB\s+\S+\s+(\S+)\s+\d+\s+\d+\r\n/mu.exec(wire);
        if (publish && !malformedAckSent) {
          malformedAckSent = true;
          socket.write(`MSG ${publish[1]} 1 2\r\n{}\r\n`);
        }
      });
      socket.write(infoLine(0));
    });
    const port = await listen(server);
    const client = new JetStreamPublishClient(config({
      servers: [`nats://127.0.0.1:${port}`],
      tls: null,
      connectTimeoutMs: 500,
      publishAckTimeoutMs: 500,
    }));

    try {
      await expect(client.publish(
        'ct.review.lifecycle.v1.0123456789abcdef01234567',
        new Uint8Array([1]),
        { messageId: eventId },
      )).rejects.toMatchObject({ code: 'publish_failed' });
      expect(malformedAckSent).toBe(true);
      expect(client.health()).toMatchObject({ state: 'disconnected', lastErrorCode: 'publish_failed' });
    } finally {
      await client.close().catch(() => undefined);
      await closeFixture(server, sockets);
    }
  });

  it.each([
    ['null', null],
    ['zero', 0],
    ['empty string', ''],
  ])('rejects a real v3 wire PubAck whose raw duplicate is %s', async (_kind, rawDuplicate) => {
    const sockets = new Set<Socket>();
    let ackSent = false;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let wire = '';
      socket.on('data', (chunk) => {
        wire += chunk.toString('utf8');
        if (chunk.toString('utf8').includes('PING\r\n')) socket.write('PONG\r\n');
        const publish = /^HPUB\s+\S+\s+(\S+)\s+\d+\s+\d+\r\n/mu.exec(wire);
        if (publish && !ackSent) {
          ackSent = true;
          const ack = JSON.stringify({ stream: 'CT_REVIEW_EVENTS', seq: 17, duplicate: rawDuplicate });
          socket.write(`MSG ${publish[1]} 1 ${Buffer.byteLength(ack)}\r\n${ack}\r\n`);
        }
      });
      socket.write(infoLine(0));
    });
    const port = await listen(server);
    const client = new JetStreamPublishClient(config({
      servers: [`nats://127.0.0.1:${port}`],
      tls: null,
      connectTimeoutMs: 500,
      publishAckTimeoutMs: 500,
    }));

    try {
      await expect(client.publish(
        'ct.review.lifecycle.v1.0123456789abcdef01234567',
        new Uint8Array([1]),
        { messageId: eventId },
      )).rejects.toMatchObject({ code: 'publish_failed' });
      expect(ackSent).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await closeFixture(server, sockets);
    }
  });

  it.each([
    ['number', 42],
    ['boolean', true],
    ['array', ['CT_REVIEW_EVENTS']],
    ['object', { name: 'CT_REVIEW_EVENTS' }],
  ])('rejects a PubAck whose stream is a %s', async (_kind, stream) => {
    const publish = vi.fn().mockResolvedValue({
      duplicate: false,
      stream,
      seq: 17,
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const client = new JetStreamPublishClient(
      config(),
      vi.fn().mockResolvedValue({
        jetstream: () => ({ publish }),
        drain: vi.fn().mockResolvedValue(undefined),
        close,
      }),
    );

    await expect(client.publish(
      'ct.review.lifecycle.v1.0123456789abcdef01234567',
      new Uint8Array([1]),
      { messageId: eventId },
    )).rejects.toMatchObject({ code: 'publish_failed' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('sends the immutable event ID as Nats-Msg-Id and treats duplicate ack as success', async () => {
    const publish = vi.fn().mockResolvedValue({
      duplicate: true,
      stream: 'CT_REVIEW_EVENTS',
      seq: 17,
    });
    const client = new JetStreamPublishClient(
      config(),
      vi.fn().mockResolvedValue(connection(publish)),
    );

    const ack = await client.publish(
      'ct.review.lifecycle.v1.0123456789abcdef01234567',
      new Uint8Array([123]),
      { messageId: eventId },
    );

    expect(publish).toHaveBeenCalledWith(
      'ct.review.lifecycle.v1.0123456789abcdef01234567',
      new Uint8Array([123]),
      expect.objectContaining({ msgID: eventId }),
    );
    expect(ack).toMatchObject({ acknowledged: true, duplicate: true });
  });

  it('redacts unavailable-provider errors instead of exposing URLs, tokens, or provider text', async () => {
    const client = new JetStreamPublishClient(
      config(),
      vi.fn().mockRejectedValue(new Error('connect tls://user:secret@private-nats.internal:4222 token=private-token raw provider detail')),
    );

    await expect(client.connect()).rejects.toMatchObject({ code: 'connect_failed' });
    try {
      await client.connect();
    } catch (error) {
      expect(String(error)).not.toContain('tls://user:secret@private-nats.internal:4222');
      expect(String(error)).not.toContain('private-token');
      expect(String(error)).not.toContain('raw provider detail');
    }
  });

  it('keeps malformed real-adapter protocol text out of subprocess output', async () => {
    const rawSecret = 'synthetic-provider-token-must-not-print';
    const sockets = new Set<Socket>();
    let malformedSent = false;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let wire = '';
      socket.on('data', (chunk) => {
        wire += chunk.toString('utf8');
        if (!malformedSent && wire.includes('PING\r\n')) {
          malformedSent = true;
          socket.write(`PONG\r\nX ${rawSecret} raw-provider-detail\r\n`);
        }
      });
      socket.write(infoLine(0));
    });
    const port = await listen(server);
    const script = `
      const { JetStreamPublishClient } = require('./src/events/jetStreamClient.ts');
      process.stdout.write('APPLICATION_LOG_VISIBLE\\n');
      const client = new JetStreamPublishClient({
        enabled: true,
        servers: ['nats://127.0.0.1:${port}'],
        token: 'synthetic-client-token-must-not-print',
        name: 'strict-output-probe',
        connectTimeoutMs: 500,
        publishAckTimeoutMs: 500,
        maxReconnectAttempts: 0,
        reconnectBackoffMs: 1,
        drainTimeoutMs: 100,
        batchSize: 1,
        leaseMs: 1000,
        retryDelayMs: 100,
        pollIntervalMs: 100,
        tls: null,
      });
      void (async () => {
        try {
          await client.connect();
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch {}
        await client.close().catch(() => undefined);
      })().catch(() => { process.exitCode = 1; });
    `;
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { output += chunk.toString('utf8'); });

    try {
      const exit = await Promise.race([
        once(child, 'exit'),
        delay(3_000).then(() => { throw new Error(`strict adapter probe did not exit: ${output}`); }),
      ]);

      expect(exit).toEqual([0, null]);
      expect(malformedSent).toBe(true);
      expect(output).toContain('APPLICATION_LOG_VISIBLE');
      expect(output).not.toContain(rawSecret);
      expect(output).not.toContain('raw-provider-detail');
      expect(output).not.toContain('synthetic-client-token-must-not-print');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closeFixture(server, sockets);
    }
  }, 10_000);

  it('bounds a connection that never becomes available', async () => {
    const client = new JetStreamPublishClient(
      config({ connectTimeoutMs: 10 }),
      vi.fn(() => new Promise<JetStreamConnectionLike>(() => undefined)),
    );

    await expect(client.connect()).rejects.toMatchObject({ code: 'connect_timeout' });
  });

  it('bounds a publish acknowledgement that never arrives', async () => {
    const publish = vi.fn(() => new Promise<never>(() => undefined));
    const client = new JetStreamPublishClient(
      config({ publishAckTimeoutMs: 10 }),
      vi.fn().mockResolvedValue(connection(publish)),
    );

    await expect(client.publish(
      'ct.review.lifecycle.v1.0123456789abcdef01234567',
      new Uint8Array([1]),
      { messageId: eventId },
    )).rejects.toMatchObject({ code: 'publish_timeout' });
  });

  it('closes every failed publish connection so repeated timeouts and drain leak none', async () => {
    let openConnections = 0;
    const closeCalls: Array<ReturnType<typeof vi.fn>> = [];
    const connect = vi.fn().mockImplementation(async () => {
      openConnections += 1;
      let open = true;
      const release = vi.fn(async () => {
        if (!open) return;
        open = false;
        openConnections -= 1;
      });
      closeCalls.push(release);
      return {
        jetstream: () => ({ publish: () => new Promise<never>(() => undefined) }),
        drain: release,
        close: release,
      } satisfies JetStreamConnectionLike;
    });
    const client = new JetStreamPublishClient(config({ publishAckTimeoutMs: 5 }), connect);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(client.publish(
        'ct.review.lifecycle.v1.0123456789abcdef01234567',
        new Uint8Array([1]),
        { messageId: eventId },
      )).rejects.toMatchObject({ code: 'publish_timeout' });
    }
    await client.drain();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(openConnections).toBe(0);
    expect(closeCalls.every((close) => close.mock.calls.length === 1)).toBe(true);
  });

  it('closes connections that resolve after repeated bounded connect attempts and drain', async () => {
    const resolveAttempts: Array<(value: JetStreamConnectionLike) => void> = [];
    const closeCalls = [vi.fn().mockResolvedValue(undefined), vi.fn().mockResolvedValue(undefined)];
    const connect = vi.fn(() => new Promise<JetStreamConnectionLike>((resolve) => {
      resolveAttempts.push(resolve);
    }));
    const client = new JetStreamPublishClient(config({
      connectTimeoutMs: 5,
      maxReconnectAttempts: 1,
      reconnectBackoffMs: 1,
    }), connect);

    await expect(client.connect()).rejects.toMatchObject({ code: 'connect_timeout' });
    await client.drain();
    for (let index = 0; index < resolveAttempts.length; index += 1) {
      resolveAttempts[index]({
        jetstream: () => ({ publish: vi.fn() }),
        drain: vi.fn().mockResolvedValue(undefined),
        close: closeCalls[index],
      });
    }

    await vi.waitFor(() => {
      expect(closeCalls[0]).toHaveBeenCalledTimes(1);
      expect(closeCalls[1]).toHaveBeenCalledTimes(1);
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(client.health()).toMatchObject({ state: 'drained' });
  });

  it('keeps one shared connect alive when only one concurrent caller aborts', async () => {
    const resolutions: Array<(value: JetStreamConnectionLike) => void> = [];
    const close = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn(() => new Promise<JetStreamConnectionLike>((resolve) => {
      resolutions.push(resolve);
    }));
    const client = new JetStreamPublishClient(config({ connectTimeoutMs: 500 }), connect);
    const controller = new AbortController();

    const aborted = client.connect(controller.signal);
    const waiting = client.connect();
    void waiting.catch(() => undefined);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'aborted' });
    const third = client.connect();
    void third.catch(() => undefined);
    for (const resolve of resolutions) {
      resolve({
        jetstream: () => ({ publish: vi.fn() }),
        drain: vi.fn().mockResolvedValue(undefined),
        close,
      });
    }

    await expect(waiting).resolves.toMatchObject({ state: 'connected' });
    await expect(third).resolves.toMatchObject({ state: 'connected' });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    await client.drain();
  });

  it('serializes close behind an in-flight native drain and keeps closed terminal', async () => {
    let resolveDrain!: () => void;
    const drain = vi.fn(() => new Promise<void>((resolve) => {
      resolveDrain = resolve;
    }));
    const close = vi.fn().mockResolvedValue(undefined);
    const client = new JetStreamPublishClient(
      config({ drainTimeoutMs: 500 }),
      vi.fn().mockResolvedValue({ jetstream: () => ({ publish: vi.fn() }), drain, close }),
    );
    await client.connect();

    const draining = client.drain();
    await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
    const closing = client.close();
    let closeSettled = false;
    void closing.finally(() => { closeSettled = true; });
    await delay(20);

    expect(close).not.toHaveBeenCalled();
    expect(closeSettled).toBe(false);
    resolveDrain();

    await expect(closing).resolves.toBeUndefined();
    await expect(draining).resolves.toMatchObject({ state: 'closed' });
    expect(close).not.toHaveBeenCalled();
    expect(client.health()).toMatchObject({ state: 'closed' });
  });

  it('preserves drain_timeout when close races a timed-out native drain', async () => {
    const drain = vi.fn(() => new Promise<void>(() => undefined));
    const close = vi.fn().mockResolvedValue(undefined);
    const client = new JetStreamPublishClient(
      config({ drainTimeoutMs: 20 }),
      vi.fn().mockResolvedValue({ jetstream: () => ({ publish: vi.fn() }), drain, close }),
    );
    await client.connect();

    const draining = client.drain();
    const drainingExpectation = expect(draining).rejects.toMatchObject({ code: 'drain_timeout' });
    await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
    const closing = client.close();

    await drainingExpectation;
    await expect(closing).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
    expect(client.health()).toMatchObject({ state: 'closed', lastErrorCode: 'drain_timeout' });
  });

  it('does not resurrect connected when a publish acknowledgement arrives after drain', async () => {
    let resolvePublish!: (ack: { duplicate: boolean; stream: string; seq: number }) => void;
    const publish = vi.fn(() => new Promise<{ duplicate: boolean; stream: string; seq: number }>((resolve) => {
      resolvePublish = resolve;
    }));
    const client = new JetStreamPublishClient(
      config(),
      vi.fn().mockResolvedValue(connection(publish)),
    );
    const publishing = client.publish(
      'ct.review.lifecycle.v1.0123456789abcdef01234567',
      new Uint8Array([1]),
      { messageId: eventId },
    );
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));

    await client.drain();
    resolvePublish({ duplicate: false, stream: 'CT_REVIEW_EVENTS', seq: 18 });

    await expect(publishing).resolves.toMatchObject({ acknowledged: true });
    expect(client.health()).toMatchObject({ state: 'drained' });
  });

  it('keeps a shared connection usable when one concurrent publish caller aborts', async () => {
    type Ack = { duplicate: boolean; stream: string; seq: number };
    const pending = new Map<string, {
      resolve(ack: Ack): void;
      reject(error: Error): void;
    }>();
    const publish = vi.fn()
      .mockImplementation((_subject, _payload, options: { msgID: string }) => {
        if (options.msgID.endsWith('-c')) {
          return Promise.resolve({ duplicate: false, stream: 'CT_REVIEW_EVENTS', seq: 19 });
        }
        return new Promise<Ack>((resolve, reject) => {
          pending.set(options.msgID, { resolve, reject });
        });
      });
    const close = vi.fn(async () => {
      const failure = new Error('shared connection closed');
      for (const operation of pending.values()) operation.reject(failure);
    });
    const client = new JetStreamPublishClient(
      config({ publishAckTimeoutMs: 500 }),
      vi.fn().mockResolvedValue({
        jetstream: () => ({ publish }),
        drain: vi.fn().mockResolvedValue(undefined),
        close,
      }),
    );
    const controller = new AbortController();

    const first = client.publish(
      'ct.review.lifecycle.v1.0123456789abcdef01234567',
      new Uint8Array([1]),
      { messageId: eventId, signal: controller.signal },
    );
    const second = client.publish(
      'ct.review.lifecycle.v1.0123456789abcdef01234567',
      new Uint8Array([2]),
      { messageId: `${eventId}-b` },
    );
    const secondExpectation = expect(second).resolves.toMatchObject({ acknowledged: true, sequence: 18 });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(first).rejects.toMatchObject({ code: 'aborted' });
    pending.get(`${eventId}-b`)?.resolve({ duplicate: false, stream: 'CT_REVIEW_EVENTS', seq: 18 });
    await secondExpectation;
    pending.get(eventId)?.resolve({ duplicate: false, stream: 'CT_REVIEW_EVENTS', seq: 17 });
    await expect(client.publish(
      'ct.review.lifecycle.v1.0123456789abcdef01234567',
      new Uint8Array([3]),
      { messageId: `${eventId}-c` },
    )).resolves.toMatchObject({ acknowledged: true, sequence: 19 });

    expect(close).not.toHaveBeenCalled();
    expect(client.health()).toMatchObject({ state: 'connected' });
  });

  it('uses bounded reconnect attempts and backoff after an initial connection failure', async () => {
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce(connection(vi.fn().mockResolvedValue({ duplicate: false, seq: 1 })));
    const client = new JetStreamPublishClient(
      config({ maxReconnectAttempts: 1, reconnectBackoffMs: 1 }),
      connect,
    );

    await expect(client.connect()).resolves.toMatchObject({ state: 'connected' });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('gracefully drains an established connection and exposes only bounded health metadata', async () => {
    const drain = vi.fn().mockResolvedValue(undefined);
    const client = new JetStreamPublishClient(
      config(),
      vi.fn().mockResolvedValue({
        jetstream: () => ({ publish: vi.fn() }),
        drain,
        close: vi.fn().mockResolvedValue(undefined),
      }),
    );

    await client.connect();
    await client.drain();
    await client.drain();

    expect(drain).toHaveBeenCalledTimes(1);
    expect(client.health()).toEqual(expect.objectContaining({ state: 'drained' }));
    expect(JSON.stringify(client.health())).not.toMatch(/token|url|payload|provider/iu);
  });

  it('rejects arbitrary subjects and malformed message IDs before touching NATS', async () => {
    const publish = vi.fn();
    const client = new JetStreamPublishClient(
      config(),
      vi.fn().mockResolvedValue(connection(publish)),
    );

    await expect(client.publish(
      'ct.review.lifecycle.v1.>',
      new Uint8Array([1]),
      { messageId: eventId },
    )).rejects.toMatchObject({ code: 'invalid_subject' });
    await expect(client.publish(
      'ct.review.lifecycle.v1.0123456789abcdef01234567',
      new Uint8Array([1]),
      { messageId: 'bad id' },
    )).rejects.toMatchObject({ code: 'invalid_message_id' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects a safe subject whose total suffix exceeds the shared bound before touching NATS', async () => {
    const publish = vi.fn();
    const client = new JetStreamPublishClient(
      config(),
      vi.fn().mockResolvedValue(connection(publish)),
    );

    await expect(client.publish(
      `ct.review.progress.v1.${'a'.repeat(65)}`,
      new Uint8Array([1]),
      { messageId: eventId },
    )).rejects.toMatchObject({ code: 'invalid_subject' });
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', new Uint8Array(0)],
    ['over the maximum', new Uint8Array(MAX_PUBLISH_PAYLOAD_BYTES + 1)],
  ])('rejects a %s payload before touching NATS', async (_label, payload) => {
    const publish = vi.fn();
    const connect = vi.fn().mockResolvedValue(connection(publish));
    const client = new JetStreamPublishClient(config(), connect);

    await expect(client.publish(
      'ct.review.progress.v1.repo-123.pr-42',
      payload,
      { messageId: eventId },
    )).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(connect).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('accepts a payload exactly at the transport byte bound', async () => {
    const publish = vi.fn().mockResolvedValue({
      duplicate: false,
      stream: 'CT_REVIEW_EVENTS',
      seq: 17,
    });
    const client = new JetStreamPublishClient(
      config(),
      vi.fn().mockResolvedValue(connection(publish)),
    );

    await expect(client.publish(
      'ct.review.progress.v1.repo-123.pr-42',
      new Uint8Array(MAX_PUBLISH_PAYLOAD_BYTES),
      { messageId: eventId },
    )).resolves.toMatchObject({ acknowledged: true, sequence: 17 });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('gracefully drains a healthy verified TLS connection and exits zero after worker cleanup', async () => {
    const tls = await createTlsCertificate();
    const sockets = new Set<Socket>();
    const server = createTlsServer({ cert: tls.certificate, key: tls.key }, (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let wire = '';
      let ackSent = false;
      socket.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        wire += text;
        for (const _ping of text.matchAll(/PING\r\n/gu)) socket.write('PONG\r\n');
        const publish = /^HPUB\s+\S+\s+(\S+)\s+\d+\s+\d+\r\n/mu.exec(wire);
        if (publish && !ackSent) {
          ackSent = true;
          const ack = JSON.stringify({ stream: 'CT_REVIEW_EVENTS', seq: 1, duplicate: false });
          socket.write(`MSG ${publish[1]} 1 ${Buffer.byteLength(ack)}\r\n${ack}\r\n`);
        }
      });
      socket.write(infoLine(0, [], { tls_required: true }));
    });
    const port = await listen(server);
    const event = {
      schema: 'review-yeti-event.v1',
      event_id: eventId,
      event_kind: 'review.lifecycle.terminal',
      occurred_at: '2026-09-12T16:00:00.000Z',
      repository_id: 42,
      pr_number: 73,
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      attempt_id: 'attempt-healthy-tls',
      run_id: 'run-healthy-tls',
      sequence: 1,
      correlation_id: 'correlation-healthy-tls',
      trace_id: 'trace-healthy-tls',
      visibility: 'internal',
      data: { stage: 'terminal', terminal_class: 'clean' },
    };
    const script = `
      const { main } = require('./src/reviewEventPublisherIndex.ts');
      const event = ${JSON.stringify(event)};
      let claimed = false;
      void main(process.env, {
        createStore: () => ({
          initialize: async () => undefined,
          getPool: () => ({}),
          close: async () => undefined,
        }),
        createRepository: () => ({
          claimNext: async (workerId) => {
            if (claimed) return null;
            claimed = true;
            return {
              eventId: event.event_id,
              runId: event.run_id,
              attemptId: event.attempt_id,
              repositoryId: event.repository_id,
              prNumber: event.pr_number,
              sequence: event.sequence,
              state: 'claimed',
              attemptCount: 1,
              leaseOwner: workerId,
              leaseExpiresAt: Date.now() + 60000,
              nextAttemptAt: 0,
              createdAt: 0,
              updatedAt: 0,
              event,
            };
          },
          markPublished: async () => {
            process.stdout.write('PUBLISHED\\n');
            return true;
          },
          releaseForRetry: async () => true,
        }),
      }).then(() => process.stdout.write('MAIN_RESOLVED\\n')).catch(() => {
        process.stdout.write('MAIN_REJECTED\\n');
        process.exitCode = 1;
      });
    `;
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_EXTRA_CA_CERTS: tls.certificatePath,
      CT_REVIEW_EVENTS_ENABLED: 'true',
      CT_REVIEW_EVENTS_NATS_URL: `tls://localhost:${port}`,
      CT_REVIEW_EVENTS_NATS_TOKEN: 'synthetic-healthy-tls-token',
      CT_REVIEW_EVENTS_CONNECT_TIMEOUT_MS: '1000',
      CT_REVIEW_EVENTS_PUBLISH_ACK_TIMEOUT_MS: '1000',
      CT_REVIEW_EVENTS_MAX_RECONNECT_ATTEMPTS: '0',
      CT_REVIEW_EVENTS_RECONNECT_BACKOFF_MS: '1',
      CT_REVIEW_EVENTS_DRAIN_TIMEOUT_MS: '250',
      CT_REVIEW_EVENTS_BATCH_SIZE: '1',
      CT_REVIEW_EVENTS_LEASE_MS: '10000',
      CT_REVIEW_EVENTS_RETRY_DELAY_MS: '100',
      CT_REVIEW_EVENTS_POLL_INTERVAL_MS: '100',
    };
    delete childEnvironment.DATABASE_URL;
    delete childEnvironment.POSTGRES_URL;
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
      cwd: process.cwd(),
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { output += chunk.toString('utf8'); });
    const exitPromise = once(child, 'exit');

    try {
      await Promise.race([
        vi.waitFor(() => expect(output).toContain('PUBLISHED'), { timeout: 4_000 }),
        exitPromise.then(([code, signal]) => {
          throw new Error(`healthy TLS publisher exited before shutdown: ${String(code)} ${String(signal)} ${output}`);
        }),
      ]);
      const signalledAt = Date.now();
      expect(child.kill('SIGTERM')).toBe(true);
      const exit = await Promise.race([
        exitPromise,
        delay(1_000).then(() => { throw new Error(`healthy TLS shutdown exceeded deadline: ${output}`); }),
      ]);

      expect(exit).toEqual([0, null]);
      expect(Date.now() - signalledAt).toBeLessThan(1_000);
      expect(output).toContain('MAIN_RESOLVED');
      expect(output).not.toContain('MAIN_REJECTED');
      expect(output).not.toContain('synthetic-healthy-tls-token');
      expect(sockets.size).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closeFixture(server, sockets);
      await tls.cleanup();
    }
  }, 10_000);

  it('closes a verified TLS socket stalled during automatic reconnect before nonzero exit', async () => {
    const tls = await createTlsCertificate();
    const tlsSockets = new Set<Socket>();
    const stalledSockets = new Set<Socket>();
    let acceptReconnect!: () => void;
    const reconnectAccepted = new Promise<void>((resolve) => {
      acceptReconnect = resolve;
    });
    const stalledServer = createServer((socket) => {
      stalledSockets.add(socket);
      socket.on('close', () => stalledSockets.delete(socket));
      socket.resume();
      acceptReconnect();
    });
    let port = 0;
    let switching = false;
    let secureConnections = 0;
    let tlsFixtureError = '';
    let sawPing = false;
    let sawPublish = false;
    const server = createTlsServer({ cert: tls.certificate, key: tls.key }, (socket) => {
      secureConnections += 1;
      let wire = '';
      let pongSent = false;
      let ackSent = false;
      socket.on('data', (chunk) => {
        wire += chunk.toString('utf8');
        if (!pongSent && wire.includes('PING\r\n')) {
          pongSent = true;
          sawPing = true;
          socket.write('PONG\r\n');
        }
        const publish = /^HPUB\s+\S+\s+(\S+)\s+\d+\s+\d+\r\n/mu.exec(wire);
        if (publish && !ackSent) {
          ackSent = true;
          sawPublish = true;
          const ack = JSON.stringify({ stream: 'CT_REVIEW_EVENTS', seq: 1, duplicate: false });
          socket.write(`MSG ${publish[1]} 1 ${Buffer.byteLength(ack)}\r\n${ack}\r\n`, () => {
            if (!switching) {
              switching = true;
              setTimeout(() => {
                socket.destroy();
                server.close(() => stalledServer.listen(port, '127.0.0.1'));
              }, 100);
            }
          });
        }
      });
      socket.write(infoLine(0, [], { tls_required: true }));
    });
    server.on('tlsClientError', (error) => { tlsFixtureError = error.message; });
    server.on('connection', (socket) => {
      tlsSockets.add(socket);
      socket.on('close', () => tlsSockets.delete(socket));
    });
    port = await listen(server);
    const event = {
      schema: 'review-yeti-event.v1',
      event_id: eventId,
      event_kind: 'review.lifecycle.terminal',
      occurred_at: '2026-09-12T10:00:00.000Z',
      repository_id: 42,
      pr_number: 73,
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      attempt_id: 'attempt-reconnect-subprocess',
      run_id: 'run-reconnect-subprocess',
      sequence: 1,
      correlation_id: 'correlation-reconnect-subprocess',
      trace_id: 'trace-reconnect-subprocess',
      visibility: 'internal',
      data: { stage: 'terminal', terminal_class: 'clean' },
    };
    const script = `
      const { main } = require('./src/reviewEventPublisherIndex.ts');
      let claimed = false;
      const event = ${JSON.stringify(event)};
      void main(process.env, {
        createStore: () => ({
          initialize: async () => undefined,
          getPool: () => ({}),
          close: async () => undefined,
        }),
        createRepository: () => ({
          claimNext: async (workerId) => {
            if (claimed) return null;
            claimed = true;
            return {
              eventId: event.event_id,
              runId: event.run_id,
              attemptId: event.attempt_id,
              repositoryId: event.repository_id,
              prNumber: event.pr_number,
              sequence: event.sequence,
              state: 'claimed',
              attemptCount: 1,
              leaseOwner: workerId,
              leaseExpiresAt: Date.now() + 60000,
              nextAttemptAt: 0,
              createdAt: 0,
              updatedAt: 0,
              event,
            };
          },
          markPublished: async () => true,
          releaseForRetry: async () => true,
        }),
      }).then(() => process.stdout.write('MAIN_RESOLVED\\n')).catch(() => {
        process.stdout.write('MAIN_REJECTED\\n');
        process.exitCode = 1;
      });
    `;
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_EXTRA_CA_CERTS: tls.certificatePath,
      CT_REVIEW_EVENTS_ENABLED: 'true',
      CT_REVIEW_EVENTS_NATS_URL: `tls://localhost:${port}`,
      CT_REVIEW_EVENTS_NATS_TOKEN: 'synthetic-reconnect-token',
      CT_REVIEW_EVENTS_CONNECT_TIMEOUT_MS: '5000',
      CT_REVIEW_EVENTS_PUBLISH_ACK_TIMEOUT_MS: '5000',
      CT_REVIEW_EVENTS_MAX_RECONNECT_ATTEMPTS: '5',
      CT_REVIEW_EVENTS_RECONNECT_BACKOFF_MS: '1',
      CT_REVIEW_EVENTS_DRAIN_TIMEOUT_MS: '100',
      CT_REVIEW_EVENTS_BATCH_SIZE: '1',
      CT_REVIEW_EVENTS_LEASE_MS: '60000',
      CT_REVIEW_EVENTS_RETRY_DELAY_MS: '100',
      CT_REVIEW_EVENTS_POLL_INTERVAL_MS: '100',
    };
    delete childEnvironment.DATABASE_URL;
    delete childEnvironment.POSTGRES_URL;
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
      cwd: process.cwd(),
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { output += chunk.toString('utf8'); });
    const exitPromise = once(child, 'exit');
    let probeReached = false;
    const prematureExit = exitPromise.then(([code, signal]) => {
      if (!probeReached) throw new Error(`subprocess exited before TLS reconnect: ${String(code)} ${String(signal)} ${output}`);
      return [code, signal];
    });

    try {
      await Promise.race([
        reconnectAccepted.then(() => { probeReached = true; }),
        prematureExit,
        delay(4_000).then(() => { throw new Error(`subprocess did not reach TLS reconnect (${secureConnections}, ping=${sawPing}, publish=${sawPublish}, ${tlsFixtureError}): ${output}`); }),
      ]);
      const signalledAt = Date.now();
      expect(child.kill('SIGTERM')).toBe(true);
      const exit = await Promise.race([
        exitPromise,
        delay(700).then(() => { throw new Error(`subprocess exceeded TLS reconnect shutdown deadline: ${output}`); }),
      ]);

      expect(exit).toEqual([1, null]);
      expect(Date.now() - signalledAt).toBeLessThan(700);
      expect(output).toContain('MAIN_REJECTED');
      expect(output).not.toContain('synthetic-reconnect-token');
      await vi.waitFor(() => expect({ tls: tlsSockets.size, stalled: stalledSockets.size }).toEqual({ tls: 0, stalled: 0 }), { timeout: 500 });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closeFixture(server, tlsSockets);
      await closeFixture(stalledServer, stalledSockets);
      await tls.cleanup();
    }
  }, 15_000);

  it('exits within the drain deadline on SIGTERM while the real TLS handshake is stalled', async () => {
    const sockets = new Set<Socket>();
    let acceptConnection!: () => void;
    const accepted = new Promise<void>((resolve) => {
      acceptConnection = resolve;
    });
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.once('data', () => acceptConnection());
    });
    const port = await listen(server);
    const event = {
      schema: 'review-yeti-event.v1',
      event_id: eventId,
      event_kind: 'review.lifecycle.terminal',
      occurred_at: '2026-09-11T20:00:00.000Z',
      repository_id: 42,
      pr_number: 73,
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      attempt_id: 'attempt-subprocess',
      run_id: 'run-subprocess',
      sequence: 1,
      correlation_id: 'correlation-subprocess',
      trace_id: 'trace-subprocess',
      visibility: 'internal',
      data: { stage: 'terminal', terminal_class: 'clean' },
    };
    const script = `
      const { main } = require('./src/reviewEventPublisherIndex.ts');
      let claimed = false;
      const event = ${JSON.stringify(event)};
      void main(process.env, {
        createStore: () => ({
          initialize: async () => undefined,
          getPool: () => ({}),
          close: async () => undefined,
        }),
        createRepository: () => ({
          claimNext: async (workerId) => {
            if (claimed) return null;
            claimed = true;
            return {
              eventId: event.event_id,
              runId: event.run_id,
              attemptId: event.attempt_id,
              repositoryId: event.repository_id,
              prNumber: event.pr_number,
              sequence: event.sequence,
              state: 'claimed',
              attemptCount: 1,
              leaseOwner: workerId,
              leaseExpiresAt: Date.now() + 60000,
              nextAttemptAt: 0,
              createdAt: 0,
              updatedAt: 0,
              event,
            };
          },
          markPublished: async () => true,
          releaseForRetry: async () => true,
        }),
      }).catch(() => { process.exitCode = 1; });
    `;
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      CT_REVIEW_EVENTS_ENABLED: 'true',
      CT_REVIEW_EVENTS_NATS_URL: `tls://127.0.0.1:${port}`,
      CT_REVIEW_EVENTS_NATS_TOKEN: 'synthetic-subprocess-token',
      CT_REVIEW_EVENTS_CONNECT_TIMEOUT_MS: '5000',
      CT_REVIEW_EVENTS_PUBLISH_ACK_TIMEOUT_MS: '5000',
      CT_REVIEW_EVENTS_MAX_RECONNECT_ATTEMPTS: '0',
      CT_REVIEW_EVENTS_RECONNECT_BACKOFF_MS: '1',
      CT_REVIEW_EVENTS_DRAIN_TIMEOUT_MS: '100',
      CT_REVIEW_EVENTS_BATCH_SIZE: '1',
      CT_REVIEW_EVENTS_LEASE_MS: '12000',
      CT_REVIEW_EVENTS_RETRY_DELAY_MS: '100',
      CT_REVIEW_EVENTS_POLL_INTERVAL_MS: '100',
    };
    delete childEnvironment.DATABASE_URL;
    delete childEnvironment.POSTGRES_URL;
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
      cwd: process.cwd(),
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    let probeReached = false;
    const exitPromise = once(child, 'exit');
    const prematureExit = exitPromise.then(([code, signal]) => {
      if (!probeReached) throw new Error(`subprocess exited before TLS probe: ${String(code)} ${String(signal)} ${stderr}`);
      return [code, signal];
    });

    try {
      await Promise.race([
        accepted.then(() => { probeReached = true; }),
        prematureExit,
        delay(3_000).then(() => { throw new Error(`subprocess did not reach TLS probe: ${stderr}`); }),
      ]);
      const signalledAt = Date.now();
      expect(child.kill('SIGTERM')).toBe(true);
      const exit = await Promise.race([
        exitPromise,
        delay(1_500).then(() => { throw new Error('subprocess exceeded SIGTERM deadline'); }),
      ]);

      expect(exit).toEqual([0, null]);
      expect(Date.now() - signalledAt).toBeLessThan(1_500);
      await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 500 });
      expect(stderr).not.toContain('synthetic-subprocess-token');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closeFixture(server, sockets);
    }
  }, 10_000);

  it('exits nonzero and redacted when graceful publisher drain and close fail', async () => {
    const rawSecret = 'synthetic-drain-provider-secret';
    const rawCloseSecret = 'synthetic-close-provider-secret';
    const script = `
      const { main } = require('./src/reviewEventPublisherIndex.ts');
      let announced = false;
      void main(process.env, {
        createStore: () => ({
          initialize: async () => undefined,
          getPool: () => ({}),
          close: async () => undefined,
        }),
        createRepository: () => ({
          claimNext: async () => {
            if (!announced) {
              announced = true;
              process.stdout.write('READY\\n');
            }
            return null;
          },
          markPublished: async () => true,
          releaseForRetry: async () => true,
        }),
        createClient: () => ({
          connect: async () => ({ state: 'connected', connectAttempts: 1 }),
          publish: async () => ({ acknowledged: true, duplicate: false, stream: 'EVENTS', sequence: 1 }),
          drain: async () => { throw new Error('${rawSecret} raw-provider-detail'); },
          close: async () => {
            process.stdout.write('CLOSE_CALLED\\n');
            throw new Error('${rawCloseSecret} raw-close-detail');
          },
          health: () => ({ state: 'connected', connectAttempts: 1 }),
        }),
      }).then(() => process.stdout.write('MAIN_RESOLVED\\n')).catch(() => {
        process.stdout.write('MAIN_REJECTED\\n');
        process.exitCode = 1;
      });
    `;
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      CT_REVIEW_EVENTS_ENABLED: 'true',
      CT_REVIEW_EVENTS_NATS_URL: 'tls://127.0.0.1:4222',
      CT_REVIEW_EVENTS_NATS_TOKEN: 'synthetic-drain-token',
      CT_REVIEW_EVENTS_DRAIN_TIMEOUT_MS: '100',
      CT_REVIEW_EVENTS_POLL_INTERVAL_MS: '100',
    };
    delete childEnvironment.DATABASE_URL;
    delete childEnvironment.POSTGRES_URL;
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
      cwd: process.cwd(),
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { output += chunk.toString('utf8'); });
    const exitPromise = once(child, 'exit');

    try {
      await Promise.race([
        vi.waitFor(() => expect(output).toContain('READY'), { timeout: 3_000 }),
        exitPromise.then(([code, signal]) => {
          throw new Error(`subprocess exited before drain failure: ${String(code)} ${String(signal)} ${output}`);
        }),
      ]);
      const signalledAt = Date.now();
      expect(child.kill('SIGTERM')).toBe(true);
      const exit = await Promise.race([
        exitPromise,
        delay(700).then(() => { throw new Error(`subprocess exceeded failed-drain deadline: ${output}`); }),
      ]);

      expect(exit).toEqual([1, null]);
      expect(Date.now() - signalledAt).toBeLessThan(700);
      expect(output).toContain('MAIN_REJECTED');
      expect(output).toContain('CLOSE_CALLED');
      expect(output).not.toContain(rawSecret);
      expect(output).not.toContain(rawCloseSecret);
      expect(output).not.toContain('raw-provider-detail');
      expect(output).not.toContain('raw-close-detail');
      expect(output).not.toContain('synthetic-drain-token');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 10_000);

  it('forces subprocess exit by the shutdown deadline when a PostgreSQL claim promise stalls', async () => {
    const sockets = new Set<Socket>();
    let acceptConnection!: () => void;
    const accepted = new Promise<void>((resolve) => {
      acceptConnection = resolve;
    });
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.once('data', () => acceptConnection());
    });
    const port = await listen(server);
    const script = `
      const { main } = require('./src/reviewEventPublisherIndex.ts');
      const { Client } = require('pg');
      let databaseClient;
      void main(process.env, {
        createStore: () => ({
          initialize: async () => undefined,
          getPool: () => ({}),
          close: async () => databaseClient ? databaseClient.end() : undefined,
        }),
        createRepository: () => ({
          claimNext: async () => {
            databaseClient = new Client({
              connectionString: process.env.DATABASE_URL,
              connectionTimeoutMillis: 5000,
            });
            await databaseClient.connect();
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
      }).catch(() => { process.exitCode = 1; });
    `;
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      CT_REVIEW_EVENTS_ENABLED: 'true',
      CT_REVIEW_EVENTS_NATS_URL: 'tls://127.0.0.1:4222',
      CT_REVIEW_EVENTS_NATS_TOKEN: 'synthetic-stalled-postgres-token',
      CT_REVIEW_EVENTS_DRAIN_TIMEOUT_MS: '100',
      DATABASE_URL: `postgresql://fixture:fixture@127.0.0.1:${port}/fixture`,
    };
    delete childEnvironment.POSTGRES_URL;
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
      cwd: process.cwd(),
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const exitPromise = once(child, 'exit');
    let probeReached = false;
    const prematureExit = exitPromise.then(([code, signal]) => {
      if (!probeReached) throw new Error(`subprocess exited before PostgreSQL stall: ${String(code)} ${String(signal)} ${stderr}`);
      return [code, signal];
    });

    try {
      await Promise.race([
        accepted.then(() => { probeReached = true; }),
        prematureExit,
        delay(3_000).then(() => { throw new Error(`subprocess did not reach PostgreSQL probe: ${stderr}`); }),
      ]);
      const signalledAt = Date.now();
      expect(child.kill('SIGTERM')).toBe(true);
      const exit = await Promise.race([
        exitPromise,
        delay(700).then(() => { throw new Error('subprocess exceeded hard shutdown deadline'); }),
      ]);

      expect(exit).toEqual([1, null]);
      expect(Date.now() - signalledAt).toBeLessThan(700);
      expect(stderr).not.toContain('synthetic-stalled-postgres-token');
      await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 500 });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closeFixture(server, sockets);
    }
  }, 10_000);
});
