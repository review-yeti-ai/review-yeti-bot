export const NATS_CONFIG_ENV = {
  enabled: 'CT_REVIEW_EVENTS_ENABLED',
  serverUrl: 'CT_REVIEW_EVENTS_NATS_URL',
  token: 'CT_REVIEW_EVENTS_NATS_TOKEN',
  name: 'CT_REVIEW_EVENTS_CLIENT_NAME',
  connectTimeoutMs: 'CT_REVIEW_EVENTS_CONNECT_TIMEOUT_MS',
  publishAckTimeoutMs: 'CT_REVIEW_EVENTS_PUBLISH_ACK_TIMEOUT_MS',
  maxReconnectAttempts: 'CT_REVIEW_EVENTS_MAX_RECONNECT_ATTEMPTS',
  reconnectBackoffMs: 'CT_REVIEW_EVENTS_RECONNECT_BACKOFF_MS',
  drainTimeoutMs: 'CT_REVIEW_EVENTS_DRAIN_TIMEOUT_MS',
  batchSize: 'CT_REVIEW_EVENTS_BATCH_SIZE',
  leaseMs: 'CT_REVIEW_EVENTS_LEASE_MS',
  retryDelayMs: 'CT_REVIEW_EVENTS_RETRY_DELAY_MS',
  pollIntervalMs: 'CT_REVIEW_EVENTS_POLL_INTERVAL_MS',
} as const;

const DEFAULTS = {
  name: 'review-event-publisher',
  connectTimeoutMs: 5_000,
  publishAckTimeoutMs: 5_000,
  maxReconnectAttempts: 3,
  reconnectBackoffMs: 250,
  drainTimeoutMs: 5_000,
  batchSize: 10,
  leaseMs: 30_000,
  retryDelayMs: 10_000,
  pollIntervalMs: 1_000,
} as const;

export const NATS_MAX_RECONNECT_BACKOFF_DELAY_MS = 10_000;
export const NATS_LEASE_COMPLETION_MARGIN_MS = 1_000;

const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,64}$/u;
const SAFE_TOKEN = /^[^\u0000-\u001f\u007f]{1,4096}$/u;
type NatsEnvironment = Readonly<Record<string, string | undefined>>;

export interface NatsEventPublisherConfig {
  enabled: boolean;
  servers: string[];
  tls: { handshakeFirst: true; rejectUnauthorized: true } | null;
  token?: string;
  name: string;
  connectTimeoutMs: number;
  publishAckTimeoutMs: number;
  maxReconnectAttempts: number;
  reconnectBackoffMs: number;
  drainTimeoutMs: number;
  batchSize: number;
  leaseMs: number;
  retryDelayMs: number;
  pollIntervalMs: number;
}

export class NatsConfigurationError extends Error {
  public readonly name = 'NatsConfigurationError';
  public readonly code = 'invalid_config' as const;

  constructor(reason: string) {
    super(`Invalid NATS event publisher configuration: ${reason}`);
  }
}

function invalid(reason: string): never {
  throw new NatsConfigurationError(reason);
}

function parseEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return invalid('enabled must be true or false');
}

function parseBoundedInteger(
  env: NatsEnvironment,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return invalid(`${key} is outside its allowed bound`);
  }
  return value;
}

function maximumConnectBudgetMs(
  connectTimeoutMs: number,
  maxReconnectAttempts: number,
  reconnectBackoffMs: number,
): number {
  let budget = connectTimeoutMs * (maxReconnectAttempts + 1);
  for (let retry = 0; retry < maxReconnectAttempts; retry += 1) {
    budget += Math.min(
      reconnectBackoffMs * (2 ** retry),
      NATS_MAX_RECONNECT_BACKOFF_DELAY_MS,
    );
  }
  return budget;
}

function assertLeaseCoversTransport(
  leaseMs: number,
  connectTimeoutMs: number,
  publishAckTimeoutMs: number,
  maxReconnectAttempts: number,
  reconnectBackoffMs: number,
): void {
  const maximumTransportMs = maximumConnectBudgetMs(
    connectTimeoutMs,
    maxReconnectAttempts,
    reconnectBackoffMs,
  ) + publishAckTimeoutMs;
  if (leaseMs <= maximumTransportMs + NATS_LEASE_COMPLETION_MARGIN_MS) {
    invalid('lease must exceed the worst-case transport and completion budget');
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '[::1]') return true;
  const octets = normalized.split('.');
  return octets.length === 4
    && octets[0] === '127'
    && octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255);
}

function parseServerUrls(raw: string | undefined): Pick<NatsEventPublisherConfig, 'servers' | 'tls'> {
  if (!raw || raw.trim() === '') return invalid('server URL is required when enabled');
  const values = raw.split(',').map((value) => value.trim());
  if (values.length === 0 || values.some((value) => value.length === 0)) {
    return invalid('server URL is malformed');
  }

  const protocols = new Set<string>();
  const servers = values.map((value) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return invalid('server URL is malformed');
    }
    if (!['nats:', 'tls:'].includes(parsed.protocol)
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || (parsed.pathname !== '' && parsed.pathname !== '/')) {
      return invalid('server URL contains unsupported or credential-bearing components');
    }
    if (parsed.protocol === 'nats:' && !isLoopbackHostname(parsed.hostname)) {
      return invalid('plaintext transport is restricted to loopback');
    }
    protocols.add(parsed.protocol);
    return `${parsed.protocol}//${parsed.host}`;
  });
  if (protocols.size !== 1) return invalid('server URLs must use one transport security mode');

  return {
    servers,
    tls: protocols.has('tls:')
      ? { handshakeFirst: true, rejectUnauthorized: true }
      : null,
  };
}

function parseName(env: NatsEnvironment): string {
  const value = env[NATS_CONFIG_ENV.name]?.trim() || DEFAULTS.name;
  if (!SAFE_NAME.test(value)) return invalid('client name is malformed');
  return value;
}

function parseToken(env: NatsEnvironment): string {
  const value = env[NATS_CONFIG_ENV.token];
  if (!value || !SAFE_TOKEN.test(value)) return invalid('separate NATS credential is required');
  return value;
}

/**
 * Parse the publisher's private DOKS configuration. Disabled is the safe
 * default and intentionally does not require any transport or credential
 * settings. Enabled configuration is complete-or-invalid; callers must not
 * silently downgrade a malformed enabled process to an in-memory mode.
 */
export function natsConfigFromEnv(env: NatsEnvironment = process.env): NatsEventPublisherConfig {
  const enabled = parseEnabled(env[NATS_CONFIG_ENV.enabled]);
  if (!enabled) {
    return {
      enabled: false,
      servers: [],
      tls: null,
      name: DEFAULTS.name,
      connectTimeoutMs: DEFAULTS.connectTimeoutMs,
      publishAckTimeoutMs: DEFAULTS.publishAckTimeoutMs,
      maxReconnectAttempts: DEFAULTS.maxReconnectAttempts,
      reconnectBackoffMs: DEFAULTS.reconnectBackoffMs,
      drainTimeoutMs: DEFAULTS.drainTimeoutMs,
      batchSize: DEFAULTS.batchSize,
      leaseMs: DEFAULTS.leaseMs,
      retryDelayMs: DEFAULTS.retryDelayMs,
      pollIntervalMs: DEFAULTS.pollIntervalMs,
    };
  }

  const transport = parseServerUrls(env[NATS_CONFIG_ENV.serverUrl]);
  const connectTimeoutMs = parseBoundedInteger(
    env,
    NATS_CONFIG_ENV.connectTimeoutMs,
    DEFAULTS.connectTimeoutMs,
    100,
    30_000,
  );
  const publishAckTimeoutMs = parseBoundedInteger(
    env,
    NATS_CONFIG_ENV.publishAckTimeoutMs,
    DEFAULTS.publishAckTimeoutMs,
    100,
    30_000,
  );
  const maxReconnectAttempts = parseBoundedInteger(
    env,
    NATS_CONFIG_ENV.maxReconnectAttempts,
    DEFAULTS.maxReconnectAttempts,
    0,
    5,
  );
  const reconnectBackoffMs = parseBoundedInteger(
    env,
    NATS_CONFIG_ENV.reconnectBackoffMs,
    DEFAULTS.reconnectBackoffMs,
    1,
    NATS_MAX_RECONNECT_BACKOFF_DELAY_MS,
  );
  const leaseMs = parseBoundedInteger(
    env,
    NATS_CONFIG_ENV.leaseMs,
    DEFAULTS.leaseMs,
    100,
    300_000,
  );
  assertLeaseCoversTransport(
    leaseMs,
    connectTimeoutMs,
    publishAckTimeoutMs,
    maxReconnectAttempts,
    reconnectBackoffMs,
  );
  return {
    enabled: true,
    ...transport,
    token: parseToken(env),
    name: parseName(env),
    connectTimeoutMs,
    publishAckTimeoutMs,
    maxReconnectAttempts,
    reconnectBackoffMs,
    drainTimeoutMs: parseBoundedInteger(env, NATS_CONFIG_ENV.drainTimeoutMs, DEFAULTS.drainTimeoutMs, 100, 30_000),
    batchSize: parseBoundedInteger(env, NATS_CONFIG_ENV.batchSize, DEFAULTS.batchSize, 1, 100),
    leaseMs,
    retryDelayMs: parseBoundedInteger(env, NATS_CONFIG_ENV.retryDelayMs, DEFAULTS.retryDelayMs, 100, 300_000),
    pollIntervalMs: parseBoundedInteger(env, NATS_CONFIG_ENV.pollIntervalMs, DEFAULTS.pollIntervalMs, 100, 60_000),
  };
}
