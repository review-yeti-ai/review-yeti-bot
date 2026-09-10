import type { Request, Response, NextFunction, RequestHandler } from 'express';

export interface RateLimiterOptions {
  /** Time window in milliseconds (defaults to 60,000 ms / 1 minute) */
  windowMs?: number;
  /** Maximum number of requests allowed within the window (defaults to 60) */
  max?: number;
  /** Error message returned in JSON response */
  message?: string;
  /** Custom key generator (defaults to client IP from X-Forwarded-For or remoteAddress) */
  keyGenerator?: (req: Request) => string;
  /** Optional function to skip rate limiting for specific requests */
  skip?: (req: Request) => boolean;
  /** Custom clock for testing */
  now?: () => number;
}

export interface RateLimiterMiddleware extends RequestHandler {
  reset: () => void;
  getHitCount: (key: string) => number;
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    const first = forwarded[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || req.ip || '127.0.0.1';
}

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiterMiddleware {
  const windowMs = options.windowMs && options.windowMs > 0 ? options.windowMs : 60_000;
  const max = options.max && options.max > 0 ? options.max : 60;
  const message = options.message || 'Too many requests, please try again later.';
  const keyGenerator = options.keyGenerator || getClientIp;
  const skip = options.skip || (() => false);
  const now = options.now || Date.now;

  const hits = new Map<string, number[]>();

  // Cleanup helper to prevent memory accumulation
  const cleanup = (currentTime: number) => {
    const threshold = currentTime - windowMs;
    for (const [key, timestamps] of hits.entries()) {
      const valid = timestamps.filter((t) => t > threshold);
      if (valid.length === 0) {
        hits.delete(key);
      } else if (valid.length !== timestamps.length) {
        hits.set(key, valid);
      }
    }
  };

  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    if (skip(req)) {
      return next();
    }

    const currentTime = now();
    const key = keyGenerator(req);
    const threshold = currentTime - windowMs;

    // Prune expired entries for this key
    const existing = hits.get(key) || [];
    const validTimestamps = existing.filter((t) => t > threshold);

    if (validTimestamps.length >= max) {
      const oldestValid = validTimestamps[0];
      const resetTime = oldestValid + windowMs;
      const retryAfterSec = Math.max(1, Math.ceil((resetTime - currentTime) / 1000));

      res.setHeader('Retry-After', String(retryAfterSec));
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetTime / 1000)));

      return res.status(429).json({
        error: message,
        retryAfterSeconds: retryAfterSec,
      });
    }

    validTimestamps.push(currentTime);
    hits.set(key, validTimestamps);

    const remaining = Math.max(0, max - validTimestamps.length);
    const resetTime = validTimestamps[0] + windowMs;

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetTime / 1000)));

    // Run background cleanup when map exceeds 5000 entries
    if (hits.size > 5000) {
      cleanup(currentTime);
    }

    return next();
  };

  const handler = middleware as RateLimiterMiddleware;
  handler.reset = () => {
    hits.clear();
  };
  handler.getHitCount = (key: string) => {
    const currentTime = now();
    const threshold = currentTime - windowMs;
    const existing = hits.get(key) || [];
    return existing.filter((t) => t > threshold).length;
  };

  return handler;
}
