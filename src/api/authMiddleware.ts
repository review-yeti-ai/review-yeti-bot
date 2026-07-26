import { Request, Response, NextFunction } from 'express';
import { authService } from '../dashboard/authService';

export interface AuthenticatedRequest extends Request {
  user?: any;
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'] as string;
  const queryToken = (req.query?.token as string) || (req.query?.access_token as string);

  // 1. Authorization: Bearer <token>
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const session = authService.validateSession(token);
    if (session) {
      req.user = session.user;
      return next();
    }
  }

  // 2. Query parameter token: ?token=... or ?access_token=... (for EventSource SSE)
  if (queryToken) {
    const session = authService.validateSession(queryToken);
    if (session) {
      req.user = session.user;
      return next();
    }
    if (authService.validateApiKey(queryToken)) {
      req.user = { id: 'api_key_user', role: 'admin' };
      return next();
    }
  }

  // 3. x-api-key header
  if (apiKeyHeader) {
    if (authService.validateApiKey(apiKeyHeader)) {
      req.user = { id: 'api_key_user', role: 'admin' };
      return next();
    }
  }

  res.status(401).json({
    success: false,
    error: 'Unauthorized: Valid Bearer token, x-api-key, or query token required',
  });
}
