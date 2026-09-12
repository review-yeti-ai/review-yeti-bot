import { randomBytes } from 'node:crypto';
import {
  RetentionPolicy,
  StorageType,
  jetstreamManager,
  type JetStreamManager,
} from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  JetStreamPublishClient,
  type NatsEventPublisherConfig,
} from '../../src/events/jetStreamClient';

const serverUrls = process.env.REVIEW_YETI_TEST_NATS_URLS
  ?.split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const token = process.env.REVIEW_YETI_TEST_NATS_TOKEN?.trim();
const describeWithJetStream = serverUrls?.length && token ? describe : describe.skip;

function publisherConfig(): NatsEventPublisherConfig {
  return {
    enabled: true,
    servers: serverUrls || [],
    tls: null,
    token,
    name: 'review-yeti-task4-integration',
    connectTimeoutMs: 2_000,
    publishAckTimeoutMs: 2_000,
    maxReconnectAttempts: 2,
    reconnectBackoffMs: 50,
    drainTimeoutMs: 2_000,
    batchSize: 2,
    leaseMs: 5_000,
    retryDelayMs: 1_000,
    pollIntervalMs: 100,
  };
}

async function waitForCurrentReplicas(manager: JetStreamManager, streamName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const info = await manager.streams.info(streamName);
    const replicas = info.cluster?.replicas || [];
    if (info.config.num_replicas === 3
      && replicas.length === 2
      && replicas.every((replica) => replica.current === true)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('JetStream replicas did not become current within the bounded fixture deadline');
}

describeWithJetStream('Review event JetStream transport', () => {
  let controlConnection: NatsConnection;
  let manager: JetStreamManager;
  const streamName = `RY_TASK4_${randomBytes(8).toString('hex').toUpperCase()}`;
  const subject = `ct.review.lifecycle.v1.${randomBytes(12).toString('hex')}`;

  beforeAll(async () => {
    controlConnection = await connect({
      servers: serverUrls!,
      token: token!,
      name: 'review-yeti-task4-fixture-control',
      timeout: 2_000,
      reconnect: true,
      maxReconnectAttempts: 2,
      reconnectTimeWait: 50,
      ignoreClusterUpdates: true,
    });
    manager = await jetstreamManager(controlConnection);
    await manager.streams.add({
      name: streamName,
      subjects: [subject],
      storage: StorageType.File,
      retention: RetentionPolicy.Limits,
      num_replicas: 3,
      max_msgs: 100,
      max_bytes: 1024 * 1024,
      duplicate_window: 120_000_000_000,
    });
    await waitForCurrentReplicas(manager, streamName);
  }, 10_000);

  afterAll(async () => {
    if (manager) await manager.streams.delete(streamName).catch(() => false);
    if (controlConnection) await controlConnection.drain().catch(() => undefined);
  });

  it('persists one R=3 message and acknowledges an exact message-ID replay as duplicate', async () => {
    const client = new JetStreamPublishClient(publisherConfig());
    const messageId = '01J8Z5M6V7Q8R9S0T1V2W3X4Y7';
    const payload = new TextEncoder().encode('{"schema":"review-yeti-event.v1","proof":"task4"}');
    try {
      const first = await client.publish(subject, payload, { messageId });
      const replay = await client.publish(subject, payload, { messageId });

      expect(first).toMatchObject({
        acknowledged: true,
        duplicate: false,
        stream: streamName,
        sequence: 1,
      });
      expect(replay).toMatchObject({
        acknowledged: true,
        duplicate: true,
        stream: streamName,
        sequence: 1,
      });

      await waitForCurrentReplicas(manager, streamName);
      const info = await manager.streams.info(streamName);
      expect(info.state.messages).toBe(1);
      expect(info.config.storage).toBe(StorageType.File);
      expect(info.config.num_replicas).toBe(3);
      expect(info.cluster?.leader).toBeTruthy();
    } finally {
      await client.drain();
    }
  }, 10_000);
});
