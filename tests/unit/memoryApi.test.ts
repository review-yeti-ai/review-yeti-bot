import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';
import { SymbolGraphStore } from '../../src/indexer/symbolGraphStore';
import { createMemoryRouter } from '../../src/api/memoryApi';
import { dashboardStore } from '../../src/persistence/dashboardStore';

describe('MemoryApi REST Endpoints Unit Tests', () => {
  let app: Express;
  let prMemoryStore: PRMemoryStore;
  let symbolGraphStore: SymbolGraphStore;
  let apiKey: string;

  beforeEach(() => {
    prMemoryStore = new PRMemoryStore(':memory:');
    symbolGraphStore = new SymbolGraphStore(':memory:');
    apiKey = dashboardStore.createApiKey('memory-unit-test').rawKey;
    app = express();
    app.use(express.json());
    app.use('/api', createMemoryRouter({ prMemoryStore, symbolGraphStore }));
  });

  afterEach(() => {
    prMemoryStore.close();
    symbolGraphStore.close();
  });

  it('POST /api/memory/record inserts a learning and POST /api/memory/query retrieves it', async () => {
    // 1. Record learning
    const recRes = await request(app)
      .post('/api/memory/record')
      .set('x-api-key', apiKey)
      .send({
        repo: 'calltelemetry/cisco-cdr',
        prNumber: 99,
        type: 'learning',
        data: {
          category: 'convention',
          title: 'Prefer async/await over promises',
          description: 'All asynchronous operations should use async/await syntax.',
          filePath: 'src/api/memoryApi.ts',
        },
      });

    expect(recRes.status).toBe(201);
    expect(recRes.body.success).toBe(true);
    expect(recRes.body.record.title).toBe('Prefer async/await over promises');

    // 2. Query learnings
    const queryRes = await request(app)
      .post('/api/memory/query')
      .set('x-api-key', apiKey)
      .send({
        repo: 'calltelemetry/cisco-cdr',
        filePath: 'src/api/memoryApi.ts',
      });

    expect(queryRes.status).toBe(200);
    expect(queryRes.body.success).toBe(true);
    expect(queryRes.body.learnings.length).toBe(1);
    expect(queryRes.body.learnings[0].title).toBe('Prefer async/await over promises');
  });

  it('POST /api/memory/record records resolved nits and ADR constraints', async () => {
    // Record Nit
    const nitRes = await request(app)
      .post('/api/memory/record')
      .set('x-api-key', apiKey)
      .send({
        repo: 'calltelemetry/cisco-cdr',
        prNumber: 10,
        type: 'nit',
        data: {
          pattern: 'use strict',
          filePath: 'src/index.ts',
          reason: 'ES modules are strict by default.',
        },
      });
    expect(nitRes.status).toBe(201);
    expect(nitRes.body.type).toBe('nit');

    // Record ADR
    const adrRes = await request(app)
      .post('/api/memory/record')
      .set('x-api-key', apiKey)
      .send({
        repo: 'calltelemetry/cisco-cdr',
        type: 'adr',
        data: {
          adrNumber: 3,
          title: 'Zod API Validation',
          status: 'accepted',
          rule: 'All endpoints must validate input body with Zod schemas.',
          targetPaths: ['src/api/**'],
        },
      });
    expect(adrRes.status).toBe(201);
    expect(adrRes.body.type).toBe('adr');

    // Query both
    const queryRes = await request(app)
      .post('/api/memory/query')
      .set('x-api-key', apiKey)
      .send({ repo: 'calltelemetry/cisco-cdr' });

    expect(queryRes.status).toBe(200);
    expect(queryRes.body.resolvedNits.length).toBe(1);
    expect(queryRes.body.adrConstraints.length).toBe(1);
  });

  it('POST /api/memory/query returns 400 when required repo parameter is missing', async () => {
    const res = await request(app)
      .post('/api/memory/query')
      .set('x-api-key', apiKey)
      .send({ category: 'security' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/code/symbol-graph returns 401 when unauthenticated', async () => {
    const res = await request(app)
      .post('/api/code/symbol-graph')
      .send({ symbolName: 'createMemoryRouter' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/code/symbol-graph returns symbol metadata and status 200', async () => {
    const res = await request(app)
      .post('/api/code/symbol-graph')
      .set('x-api-key', apiKey)
      .send({
        symbolName: 'createMemoryRouter',
        includeCallers: true,
        includeCallees: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.symbolName).toBe('createMemoryRouter');
    expect(Array.isArray(res.body.definitions)).toBe(true);
  });

  it('POST /api/code/symbol-graph returns 400 when symbolName is missing', async () => {
    const res = await request(app)
      .post('/api/code/symbol-graph')
      .set('x-api-key', apiKey)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/code/search returns 401 when unauthenticated', async () => {
    const res = await request(app)
      .post('/api/code/search')
      .send({ query: 'test' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/code/search performs code search and returns 200', async () => {
    const res = await request(app)
      .post('/api/code/search')
      .set('x-api-key', apiKey)
      .send({
        query: 'vector embedding cosine similarity',
        limit: 5,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.query).toBe('vector embedding cosine similarity');
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  it('POST /api/code/search returns 400 when query is empty', async () => {
    const res = await request(app)
      .post('/api/code/search')
      .set('x-api-key', apiKey)
      .send({ query: '' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
