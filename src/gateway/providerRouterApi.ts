import { Router, Request, Response } from 'express';
import { providerPool, providerConfigSchema } from './providerPool';

export function createProviderRouter(): Router {
  const router = Router();

  router.post('/providers', (req: Request, res: Response) => {
    try {
      const validated = providerConfigSchema.parse(req.body);
      const allowUpdate = req.body?.allowUpdate === true || req.body?.update === true || req.body?.overwrite === true;
      const registered = providerPool.registerProvider(validated, allowUpdate);
      res.status(201).json({
        success: true,
        provider: {
          id: registered.id,
          type: registered.type,
          models: registered.models,
        },
      });
    } catch (err: any) {
      res.status(400).json({
        success: false,
        error: err.message || String(err),
      });
    }
  });

  router.get('/providers', (_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      providers: providerPool.listProviders().map((p) => ({
        id: p.id,
        type: p.type,
        models: p.models,
      })),
    });
  });

  router.delete('/providers/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const removed = providerPool.removeProvider(id);
    if (removed) {
      res.status(200).json({ success: true, removedId: id });
    } else {
      res.status(404).json({ success: false, error: `Provider '${id}' not found` });
    }
  });

  return router;
}
