import express, { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { PRMemoryStore } from '../memory/prMemoryStore';
import { GraphLearningEngine } from '../memory/graphLearningEngine';
import { SymbolGraphStore } from '../indexer/symbolGraphStore';
import { logger } from '../utils/logger';
import { requireAuth } from './authMiddleware';

const memoryQuerySchema = z.object({
  repo: z.string({ required_error: 'repo is required' }).min(1, 'repo is required'),
  filePath: z.string().optional(),
  category: z.enum(['convention', 'architecture', 'security', 'performance', 'style', 'adr']).optional(),
  query: z.string().optional(),
});

const symbolGraphQuerySchema = z.object({
  symbolName: z.string({ required_error: 'symbolName is required' }).min(1, 'symbolName is required'),
  includeCallers: z.boolean().optional().default(true),
  includeCallees: z.boolean().optional().default(true),
  includeReferences: z.boolean().optional().default(true),
});

const codeSearchQuerySchema = z.object({
  query: z.string({ required_error: 'query is required' }).min(1, 'query is required'),
  limit: z.number().int().min(1).max(50).optional().default(10),
});

const recordMemorySchema = z.object({
  repo: z.string({ required_error: 'repo is required' }).min(1, 'repo is required'),
  prNumber: z.number().int().optional().default(0),
  type: z.enum(['learning', 'nit', 'adr']),
  data: z.record(z.any()),
});

export interface MemoryApiOptions {
  prMemoryStore?: PRMemoryStore;
  graphLearningEngine?: GraphLearningEngine;
  symbolGraphStore?: SymbolGraphStore;
}

function formatErrorMessage(err: any): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => i.message).join('; ');
  }
  return err.message || 'Invalid request';
}

export function createMemoryRouter(options: MemoryApiOptions = {}): Router {
  const router = Router();
  router.use(express.json({ strict: false }));
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      if (req.body === undefined || req.body === null || typeof req.body !== 'object') {
        return res.status(400).json({ success: false, error: 'Request body must be a JSON object' });
      }
    }
    next();
  });
  router.use(requireAuth);
  const prMemoryStore = options.prMemoryStore || new PRMemoryStore();
  const symbolGraphStore = options.symbolGraphStore || new SymbolGraphStore();
  const graphLearningEngine = options.graphLearningEngine || new GraphLearningEngine(prMemoryStore, symbolGraphStore);

  // GET /api/memory/query
  router.get('/memory/query', async (req: Request, res: Response) => {
    try {
      const repo = String(req.query.repo || req.query.repository || '');
      if (!repo) {
        return res.status(400).json({ success: false, error: 'repo parameter is required' });
      }
      const result = await prMemoryStore.queryLearnings(repo);
      return res.status(200).json({
        success: true,
        repo,
        ...result,
      });
    } catch (err: any) {
      logger.error('Error handling GET /api/memory/query', { error: err?.message });
      return res.status(500).json({ success: false, error: err?.message });
    }
  });

  // POST /api/memory/learn
  router.post('/memory/learn', async (req: Request, res: Response) => {
    try {
      const { repo, command, pattern } = req.body;
      const targetRepo = repo || 'default';
      const textToParse = command || pattern || '';
      const { parseLearnCommand } = await import('../reflection/commandParser');
      const parsed = parseLearnCommand(textToParse);
      const learnedPattern = parsed.pattern || textToParse.replace(/@ct-review\s+learn\s+/i, '').trim();

      await prMemoryStore.recordLearning(targetRepo, 0, {
        category: 'convention',
        title: learnedPattern,
        description: learnedPattern,
      });
      await prMemoryStore.recordResolvedNit(targetRepo, 0, {
        pattern: learnedPattern,
        filePath: '**',
        reason: learnedPattern,
      });

      return res.status(200).json({
        success: true,
        repo: targetRepo,
        learned: learnedPattern,
        pattern: learnedPattern,
      });
    } catch (err: any) {
      logger.error('Error handling POST /api/memory/learn', { error: err?.message });
      return res.status(500).json({ success: false, error: err?.message });
    }
  });

  // 1. POST /api/memory/query
  router.post('/memory/query', async (req: Request, res: Response) => {
    try {
      const body = memoryQuerySchema.parse(req.body);
      const result = await prMemoryStore.queryLearnings(body.repo, {
        filePath: body.filePath,
        category: body.category,
        query: body.query,
      });

      res.status(200).json({
        success: true,
        repo: body.repo,
        ...result,
      });
    } catch (err: any) {
      const errMsg = formatErrorMessage(err);
      logger.error('Error handling /api/memory/query', { error: errMsg });
      res.status(400).json({ success: false, error: errMsg });
    }
  });

  // 2. POST /api/code/symbol-graph
  router.post('/code/symbol-graph', async (req: Request, res: Response) => {
    try {
      const body = symbolGraphQuerySchema.parse(req.body);
      const result = await symbolGraphStore.querySymbols(body.symbolName, {
        includeCallers: body.includeCallers,
        includeCallees: body.includeCallees,
        includeReferences: body.includeReferences,
      });

      res.status(200).json({
        success: true,
        symbolName: body.symbolName,
        definitions: result.definitions || [],
        references: result.references || [],
        callers: result.callers || [],
        callees: result.callees || [],
      });
    } catch (err: any) {
      const errMsg = formatErrorMessage(err);
      logger.error('Error handling /api/code/symbol-graph', { error: errMsg });
      res.status(400).json({ success: false, error: errMsg });
    }
  });

  // 3. POST /api/code/search
  router.post('/code/search', async (req: Request, res: Response) => {
    try {
      const body = codeSearchQuerySchema.parse(req.body);
      const results = await symbolGraphStore.semanticSearch(body.query, body.limit);

      res.status(200).json({
        success: true,
        query: body.query,
        results,
      });
    } catch (err: any) {
      const errMsg = formatErrorMessage(err);
      logger.error('Error handling /api/code/search', { error: errMsg });
      res.status(400).json({ success: false, error: errMsg });
    }
  });

  // 4. POST /api/memory/record
  router.post('/memory/record', async (req: Request, res: Response) => {
    try {
      const body = recordMemorySchema.parse(req.body);
      let record: any;

      if (body.type === 'learning') {
        record = await prMemoryStore.recordLearning(body.repo, body.prNumber, body.data as any);
      } else if (body.type === 'nit') {
        record = await prMemoryStore.recordResolvedNit(body.repo, body.prNumber, body.data as any);
      } else if (body.type === 'adr') {
        record = await prMemoryStore.recordADRConstraint(body.repo, body.data as any);
      }

      res.status(201).json({
        success: true,
        type: body.type,
        record,
      });
    } catch (err: any) {
      const errMsg = formatErrorMessage(err);
      logger.error('Error handling /api/memory/record', { error: errMsg });
      res.status(400).json({ success: false, error: errMsg });
    }
  });

  router.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message || 'Invalid JSON request' });
    }
  });

  return router;
}

export class MemoryApi {
  public static registerRoutes(app: any, options: MemoryApiOptions = {}): void {
    const router = createMemoryRouter(options);
    app.use('/api', router);
  }
}
