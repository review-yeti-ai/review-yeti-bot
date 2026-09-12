import { Worker } from 'node:worker_threads';
import type { Readable } from 'node:stream';
import {
  NATS_MAX_RECONNECT_BACKOFF_DELAY_MS,
  type NatsEventPublisherConfig,
} from './natsConfig';
import {
  MAX_REVIEW_EVENT_SUBJECT_SUFFIX_LENGTH,
  isReviewEventSubject,
} from './reviewEventSubjects';

export type { NatsEventPublisherConfig } from './natsConfig';
export {
  LIFECYCLE_SUBJECT_PREFIX,
  MAX_REVIEW_EVENT_SUBJECT_SUFFIX_LENGTH,
  PROGRESS_SUBJECT_PREFIX,
} from './reviewEventSubjects';

export const MAX_SUBJECT_SUFFIX_LENGTH = MAX_REVIEW_EVENT_SUBJECT_SUFFIX_LENGTH;
export const MAX_PUBLISH_PAYLOAD_BYTES = 16 * 1024;

const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;
const STREAM_NAME_PATTERN_SOURCE = String.raw`[^\s.*>\/\\\u0000-\u001f\u007f]{1,255}`;
const STREAM_NAME_PATTERN = new RegExp(`^${STREAM_NAME_PATTERN_SOURCE}$`, 'u');
const TERMINATE_OWNED_TRANSPORT = Symbol('terminateOwnedTransport');

export interface JetStreamPublishAck {
  acknowledged: true;
  duplicate: boolean;
  stream: string;
  sequence: number;
}

export interface JetStreamLike {
  publish(subject: string, payload: Uint8Array, options: { msgID: string; timeout: number }): Promise<PubAckLike>;
}

export interface JetStreamConnectionLike {
  jetstream(): JetStreamLike;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export interface PubAckLike {
  duplicate?: boolean;
  stream?: string;
  seq?: number;
}

export interface NatsConnectOptions {
  servers: string[];
  tls: { handshakeFirst: true; rejectUnauthorized: true } | null;
  token: string;
  name: string;
  timeout: number;
  reconnect: true;
  maxReconnectAttempts: number;
  reconnectTimeWait: number;
  ignoreClusterUpdates: boolean;
}

export type NatsConnectionFactory = (
  options: NatsConnectOptions,
  signal?: AbortSignal,
) => Promise<JetStreamConnectionLike>;

export type JetStreamTransportErrorCode =
  | 'aborted'
  | 'connect_failed'
  | 'connect_timeout'
  | 'publish_failed'
  | 'publish_timeout'
  | 'invalid_subject'
  | 'invalid_message_id'
  | 'invalid_payload'
  | 'drain_failed'
  | 'drain_timeout'
  | 'close_failed'
  | 'close_timeout';

export class JetStreamTransportError extends Error {
  public readonly name = 'JetStreamTransportError';

  constructor(public readonly code: JetStreamTransportErrorCode) {
    super(`NATS event transport ${code.replaceAll('_', ' ')}`);
  }
}

export type JetStreamHealthState = 'disconnected' | 'connecting' | 'connected' | 'draining' | 'drained' | 'closed';

export interface JetStreamHealth {
  state: JetStreamHealthState;
  connectAttempts: number;
  lastErrorCode?: JetStreamTransportErrorCode;
  lastOutcome?: 'acknowledged' | 'duplicate';
}

export interface ReviewEventPublishClient {
  connect(signal?: AbortSignal): Promise<JetStreamHealth>;
  publish(
    subject: string,
    payload: Uint8Array,
    options: { messageId: string; signal?: AbortSignal },
  ): Promise<JetStreamPublishAck>;
  drain(): Promise<JetStreamHealth>;
  close(): Promise<void>;
  health(): JetStreamHealth;
}

export function assertReviewEventSubject(subject: string): void {
  if (!isReviewEventSubject(subject)) throw new JetStreamTransportError('invalid_subject');
}

function assertMessageId(messageId: string): void {
  if (!MESSAGE_ID_PATTERN.test(messageId)) throw new JetStreamTransportError('invalid_message_id');
}

function assertPayload(payload: Uint8Array): void {
  if (!(payload instanceof Uint8Array) || payload.byteLength === 0 || payload.byteLength > MAX_PUBLISH_PAYLOAD_BYTES) {
    throw new JetStreamTransportError('invalid_payload');
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new JetStreamTransportError('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new JetStreamTransportError('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function boundedOperation<T>(
  operation: () => Promise<T>,
  milliseconds: number,
  timeoutCode: JetStreamTransportErrorCode,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new JetStreamTransportError('aborted'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => settle(() => reject(new JetStreamTransportError('aborted')));
    const timer = setTimeout(
      () => settle(() => reject(new JetStreamTransportError(timeoutCode))),
      milliseconds,
    );
    signal?.addEventListener('abort', onAbort, { once: true });

    Promise.resolve()
      .then(operation)
      .then((result) => settle(() => resolve(result)))
      .catch((error: unknown) => settle(() => reject(error)));
  });
}

const TRANSPORT_WORKER_SOURCE = String.raw`
  const { parentPort } = require('node:worker_threads');
  const { connect } = require('@nats-io/transport-node');
  const { jetstream } = require('@nats-io/jetstream');
  const STREAM_NAME_PATTERN_SOURCE = ${JSON.stringify(STREAM_NAME_PATTERN_SOURCE)};
  const STREAM_NAME_PATTERN = new RegExp('^' + STREAM_NAME_PATTERN_SOURCE + '$', 'u');

  let connection;
  let client;
  let lifetimeController;

  parentPort.on('message', async (message) => {
    try {
      let value;
      if (message.operation === 'connect') {
        lifetimeController = new AbortController();
        const options = message.options.tls
          ? {
              ...message.options,
              tls: { ...message.options.tls, signal: lifetimeController.signal },
            }
          : message.options;
        connection = await connect(options);
        client = jetstream(connection);
        const parseJsResponse = client.parseJsResponse.bind(client);
        client.parseJsResponse = (message) => {
          const raw = JSON.parse(new TextDecoder().decode(message.data));
          if (!raw || typeof raw !== 'object' || (!raw.error && (
            typeof raw.stream !== 'string'
            || !STREAM_NAME_PATTERN.test(raw.stream)
            || !Number.isSafeInteger(raw.seq)
            || raw.seq <= 0
            || (Object.prototype.hasOwnProperty.call(raw, 'duplicate')
              && typeof raw.duplicate !== 'boolean')
          ))) {
            throw new Error('invalid publish acknowledgement');
          }
          return parseJsResponse(message);
        };
      } else if (message.operation === 'publish') {
        if (!client) throw new Error('not connected');
        value = await client.publish(message.subject, message.payload, message.options);
      } else if (message.operation === 'drain') {
        if (connection) await connection.drain();
      } else if (message.operation === 'close') {
        if (connection) await connection.close();
      } else {
        throw new Error('invalid operation');
      }
      parentPort.postMessage({ id: message.id, ok: true, value });
    } catch {
      parentPort.postMessage({ id: message.id, ok: false });
    }
  });
`;

interface TransportWorkerRequest {
  operation: 'connect' | 'publish' | 'drain' | 'close';
  options?: unknown;
  subject?: string;
  payload?: Uint8Array;
}

interface TransportWorkerResponse {
  id: number;
  ok: boolean;
  value?: unknown;
}

class TransportWorkerConnection implements JetStreamConnectionLike {
  private readonly worker = new Worker(TRANSPORT_WORKER_SOURCE, {
    eval: true,
    stdout: true,
    stderr: true,
  });
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
  private nextRequestId = 1;
  private terminal = false;
  private terminationPromise: Promise<void> | undefined;
  private readonly workerExitPromise: Promise<void>;
  private resolveWorkerExit!: () => void;
  private readonly onAbort = () => { void this.terminate(); };

  constructor(private readonly signal?: AbortSignal) {
    this.workerExitPromise = new Promise((resolve) => {
      this.resolveWorkerExit = resolve;
    });
    // The upstream parser currently writes malformed protocol details directly
    // to console. Keep those streams scoped to this transport worker and drain
    // them here so provider text cannot reach application stdout or stderr.
    this.worker.stdout?.resume();
    this.worker.stderr?.resume();
    this.worker.on('message', (response: TransportWorkerResponse) => this.handleResponse(response));
    this.worker.on('error', () => { void this.terminate(); });
    this.worker.on('exit', () => {
      this.finishTermination();
      this.resolveWorkerExit();
    });
    if (signal?.aborted) void this.terminate();
    else signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  async initialize(options: NatsConnectOptions): Promise<void> {
    await this.request({ operation: 'connect', options });
  }

  jetstream(): JetStreamLike {
    return {
      publish: async (subject, payload, options): Promise<PubAckLike> => (
        await this.request({ operation: 'publish', subject, payload, options })
      ) as PubAckLike,
    };
  }

  async drain(): Promise<void> {
    try {
      await this.request({ operation: 'drain' });
    } finally {
      await this.terminate();
    }
  }

  async close(): Promise<void> {
    try {
      await this.request({ operation: 'close' });
    } finally {
      await this.terminate();
    }
  }

  async [TERMINATE_OWNED_TRANSPORT](): Promise<void> {
    await this.terminate();
  }

  private request(request: TransportWorkerRequest): Promise<unknown> {
    if (this.terminal) return Promise.reject(new Error('NATS transport worker unavailable'));
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, ...request });
      } catch {
        this.pending.delete(id);
        reject(new Error('NATS transport worker unavailable'));
      }
    });
  }

  private handleResponse(response: TransportWorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.value);
    else pending.reject(new Error('NATS transport worker operation failed'));
  }

  private async terminate(): Promise<void> {
    if (this.terminationPromise) return this.terminationPromise;
    this.terminal = true;
    this.signal?.removeEventListener('abort', this.onAbort);
    const terminating = (async () => {
      this.finishTermination();
      await this.worker.terminate().catch(() => undefined);
      await this.workerExitPromise;
      await Promise.all([
        this.closeCapturedStream(this.worker.stdout),
        this.closeCapturedStream(this.worker.stderr),
      ]);
      this.worker.removeAllListeners();
    })();
    this.terminationPromise = terminating;
    await terminating;
  }

  private async closeCapturedStream(stream: Readable | null): Promise<void> {
    if (!stream || stream.closed) return;
    await new Promise<void>((resolve) => {
      stream.once('error', () => undefined);
      stream.once('close', resolve);
      stream.destroy();
    });
  }

  private finishTermination(): void {
    this.terminal = true;
    this.signal?.removeEventListener('abort', this.onAbort);
    for (const pending of this.pending.values()) {
      pending.reject(new Error('NATS transport worker unavailable'));
    }
    this.pending.clear();
  }
}

async function defaultConnectionFactory(
  options: NatsConnectOptions,
  signal?: AbortSignal,
): Promise<JetStreamConnectionLike> {
  const connection = new TransportWorkerConnection(signal);
  try {
    await connection.initialize(options);
    return connection;
  } catch {
    await connection.close().catch(() => undefined);
    throw new JetStreamTransportError('connect_failed');
  }
}

export class JetStreamPublishClient implements ReviewEventPublishClient {
  private connection: JetStreamConnectionLike | undefined;
  private drainingConnection: JetStreamConnectionLike | undefined;
  private connectPromise: Promise<JetStreamHealth> | undefined;
  private drainPromise: Promise<JetStreamHealth> | undefined;
  private closePromise: Promise<void> | undefined;
  private state: JetStreamHealthState = 'disconnected';
  private connectAttempts = 0;
  private connectionGeneration = 0;
  private shutdownRequested = false;
  private readonly shutdownController = new AbortController();
  private readonly disposedConnections = new WeakSet<JetStreamConnectionLike>();
  private readonly connectionControllers = new WeakMap<JetStreamConnectionLike, AbortController>();
  private readonly ownsTransportWorker: boolean;
  private lastErrorCode: JetStreamTransportErrorCode | undefined;
  private lastOutcome: JetStreamHealth['lastOutcome'];

  constructor(
    private readonly config: NatsEventPublisherConfig,
    private readonly connectionFactory: NatsConnectionFactory = defaultConnectionFactory,
  ) {
    this.ownsTransportWorker = connectionFactory === defaultConnectionFactory;
  }

  health(): JetStreamHealth {
    return {
      state: this.state,
      connectAttempts: this.connectAttempts,
      ...(this.lastErrorCode ? { lastErrorCode: this.lastErrorCode } : {}),
      ...(this.lastOutcome ? { lastOutcome: this.lastOutcome } : {}),
    };
  }

  private isTerminal(): boolean {
    return this.shutdownRequested
      || this.state === 'draining'
      || this.state === 'drained'
      || this.state === 'closed';
  }

  async connect(signal?: AbortSignal): Promise<JetStreamHealth> {
    if (signal?.aborted) throw new JetStreamTransportError('aborted');
    if (this.isTerminal()) throw new JetStreamTransportError('connect_failed');
    if (this.state === 'connected' && this.connection) return this.health();

    if (!this.connectPromise) {
      const generation = ++this.connectionGeneration;
      const pending = this.connectWithRetry(generation);
      this.connectPromise = pending;
      void pending.finally(() => {
        if (this.connectPromise === pending) this.connectPromise = undefined;
      }).catch(() => undefined);
    }
    return abortable(this.connectPromise, signal);
  }

  private connectOptions(): NatsConnectOptions {
    return {
      servers: this.config.servers,
      tls: this.config.tls,
      token: this.config.token || '',
      name: this.config.name,
      timeout: this.config.connectTimeoutMs,
      reconnect: true,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
      reconnectTimeWait: this.config.reconnectBackoffMs,
      ignoreClusterUpdates: this.config.tls === null,
    };
  }

  private async connectAttempt(generation: number): Promise<JetStreamConnectionLike> {
    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort();
    this.shutdownController.signal.addEventListener('abort', abortAttempt, { once: true });
    const rawConnection = Promise.resolve().then(() => this.connectionFactory(
      this.connectOptions(),
      attemptController.signal,
    ));
    try {
      const connection = await boundedOperation(
        () => rawConnection,
        this.config.connectTimeoutMs,
        'connect_timeout',
        this.shutdownController.signal,
      );
      if (this.shutdownRequested || generation !== this.connectionGeneration) {
        await this.closeQuietly(connection);
        throw new JetStreamTransportError('connect_failed');
      }
      this.connectionControllers.set(connection, attemptController);
      return connection;
    } catch (error: unknown) {
      attemptController.abort();
      const cleanup = rawConnection
        .then((connection) => this.closeQuietly(connection))
        .catch(() => undefined);
      if (this.ownsTransportWorker) await cleanup;
      else void cleanup;
      throw error;
    } finally {
      this.shutdownController.signal.removeEventListener('abort', abortAttempt);
    }
  }

  private async connectWithRetry(generation: number): Promise<JetStreamHealth> {
    let attempt = 0;
    while (!this.shutdownRequested && generation === this.connectionGeneration) {
      attempt += 1;
      this.connectAttempts += 1;
      this.state = 'connecting';
      try {
        const connection = await this.connectAttempt(generation);
        if (this.isTerminal() || generation !== this.connectionGeneration) {
          await this.closeQuietly(connection);
          throw new JetStreamTransportError('connect_failed');
        }
        if (this.connection) {
          await this.closeQuietly(connection);
          if (!this.shutdownRequested && generation === this.connectionGeneration) this.state = 'connected';
          return this.health();
        }
        this.connection = connection;
        this.state = 'connected';
        this.lastErrorCode = undefined;
        return this.health();
      } catch (error: unknown) {
        if (this.shutdownRequested || generation !== this.connectionGeneration) {
          throw new JetStreamTransportError('connect_failed');
        }
        const code = error instanceof JetStreamTransportError && error.code === 'connect_timeout'
          ? 'connect_timeout'
          : 'connect_failed';
        this.state = 'disconnected';
        this.lastErrorCode = code;
        if (attempt > this.config.maxReconnectAttempts) throw new JetStreamTransportError(code);
        await wait(
          Math.min(
            this.config.reconnectBackoffMs * (2 ** (attempt - 1)),
            NATS_MAX_RECONNECT_BACKOFF_DELAY_MS,
          ),
          this.shutdownController.signal,
        );
      }
    }
    throw new JetStreamTransportError('connect_failed');
  }

  async publish(
    subject: string,
    payload: Uint8Array,
    options: { messageId: string; signal?: AbortSignal },
  ): Promise<JetStreamPublishAck> {
    assertReviewEventSubject(subject);
    assertMessageId(options.messageId);
    assertPayload(payload);
    await this.connect(options.signal);
    const connection = this.connection;
    if (!connection) throw new JetStreamTransportError('publish_failed');
    try {
      const ack = await boundedOperation<PubAckLike>(
        () => connection.jetstream().publish(subject, payload, {
          msgID: options.messageId,
          timeout: this.config.publishAckTimeoutMs,
        }),
        this.config.publishAckTimeoutMs,
        'publish_timeout',
        options.signal,
      );
      if (typeof ack.stream !== 'string'
        || !STREAM_NAME_PATTERN.test(ack.stream)
        || !Number.isSafeInteger(ack.seq)
        || Number(ack.seq) <= 0
        || typeof ack.duplicate !== 'boolean') {
        throw new JetStreamTransportError('publish_failed');
      }
      const duplicate = ack.duplicate;
      const sequence = ack.seq as number;
      if (!this.shutdownRequested && this.connection === connection) {
        this.state = 'connected';
        this.lastErrorCode = undefined;
      }
      this.lastOutcome = duplicate ? 'duplicate' : 'acknowledged';
      return {
        acknowledged: true,
        duplicate,
        stream: ack.stream,
        sequence,
      };
    } catch (error: unknown) {
      const code = error instanceof JetStreamTransportError && error.code === 'aborted'
        ? 'aborted'
        : error instanceof JetStreamTransportError && error.code === 'publish_timeout'
          ? 'publish_timeout'
          : 'publish_failed';
      if (code === 'aborted' && !this.shutdownRequested) {
        throw new JetStreamTransportError('aborted');
      }
      if (this.connection === connection) this.connection = undefined;
      if (!this.shutdownRequested) this.state = 'disconnected';
      this.lastErrorCode = code;
      await this.closeQuietly(connection);
      throw new JetStreamTransportError(code);
    }
  }

  async drain(): Promise<JetStreamHealth> {
    if (this.closePromise) {
      await this.closePromise;
      return this.health();
    }
    if (this.drainPromise) return this.drainPromise;
    if (this.state === 'drained' || this.state === 'closed') return this.health();

    const pendingConnect = this.ownsTransportWorker ? this.connectPromise : undefined;
    this.shutdownRequested = true;
    this.shutdownController.abort();
    this.connectionGeneration += 1;
    const connection = this.connection;
    this.connection = undefined;
    this.drainingConnection = connection;
    this.state = 'draining';
    this.drainPromise = this.drainConnection(connection, pendingConnect);
    return this.drainPromise;
  }

  private async drainConnection(
    connection: JetStreamConnectionLike | undefined,
    pendingConnect?: Promise<JetStreamHealth>,
  ): Promise<JetStreamHealth> {
    if (!connection) {
      await pendingConnect?.catch(() => undefined);
      if (this.state !== 'closed') this.state = 'drained';
      return this.health();
    }
    const cleanupReserveMs = Math.min(50, Math.max(1, Math.floor(this.config.drainTimeoutMs / 2)));
    const nativeDrainTimeoutMs = Math.max(1, this.config.drainTimeoutMs - cleanupReserveMs);
    try {
      await boundedOperation(() => connection.drain(), nativeDrainTimeoutMs, 'drain_timeout');
      this.disposedConnections.add(connection);
      await this.abortConnection(connection);
      if (this.state !== 'closed') {
        this.state = 'drained';
        this.lastErrorCode = undefined;
      }
      return this.health();
    } catch (error: unknown) {
      const code = error instanceof JetStreamTransportError && error.code === 'drain_timeout'
        ? 'drain_timeout'
        : 'drain_failed';
      if (this.state !== 'closed') this.state = 'drained';
      this.lastErrorCode = code;
      this.disposedConnections.add(connection);
      await this.abortConnection(connection);
      throw new JetStreamTransportError(code);
    } finally {
      if (this.drainingConnection === connection) this.drainingConnection = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state === 'closed') return;

    const pendingConnect = this.ownsTransportWorker ? this.connectPromise : undefined;
    this.shutdownRequested = true;
    this.shutdownController.abort();
    this.connectionGeneration += 1;
    if (this.drainPromise) {
      this.state = 'closed';
      this.closePromise = this.drainPromise.then(
        () => undefined,
        () => undefined,
      );
      return this.closePromise;
    }
    const connection = this.connection || this.drainingConnection;
    this.connection = undefined;
    this.state = 'closed';
    this.closePromise = this.closeConnection(connection, pendingConnect);
    return this.closePromise;
  }

  private async closeConnection(
    connection: JetStreamConnectionLike | undefined,
    pendingConnect?: Promise<JetStreamHealth>,
  ): Promise<void> {
    if (!connection) {
      await pendingConnect?.catch(() => undefined);
      return;
    }
    try {
      await boundedOperation(() => connection.close(), this.config.drainTimeoutMs, 'close_timeout');
      this.disposedConnections.add(connection);
    } catch (error: unknown) {
      const code = error instanceof JetStreamTransportError && error.code === 'close_timeout'
        ? 'close_timeout'
        : 'close_failed';
      this.lastErrorCode = code;
      throw new JetStreamTransportError(code);
    } finally {
      await this.abortConnection(connection);
    }
  }

  private async closeQuietly(
    connection: JetStreamConnectionLike,
    timeoutMs: number = this.config.drainTimeoutMs,
  ): Promise<void> {
    if (this.disposedConnections.has(connection)) {
      await this.abortConnection(connection);
      return;
    }
    this.disposedConnections.add(connection);
    const closing = Promise.resolve().then(() => connection.close());
    if (timeoutMs <= 0) {
      void closing.catch(() => undefined);
      await this.abortConnection(connection);
      return;
    }
    try {
      await boundedOperation(() => closing, timeoutMs, 'close_timeout').catch(() => undefined);
    } finally {
      await this.abortConnection(connection);
    }
  }

  private async abortConnection(connection: JetStreamConnectionLike): Promise<void> {
    const controller = this.connectionControllers.get(connection);
    this.connectionControllers.delete(connection);
    controller?.abort();
    const ownedConnection = connection as JetStreamConnectionLike & {
      [TERMINATE_OWNED_TRANSPORT]?: () => Promise<void>;
    };
    await ownedConnection[TERMINATE_OWNED_TRANSPORT]?.();
  }
}
