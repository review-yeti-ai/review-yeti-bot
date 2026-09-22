import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import { MCP_ERRORS, buildJsonRpcError } from './mcpTypes';
import { extractBearerToken } from './mcpAuthenticator';

export interface SlidingWindowRateLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
  now?: () => number;
  errorCode?: number;
}

export class SlidingWindowRateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly now: () => number;
  private readonly errorCode: number;
  private readonly buckets = new Map<string, number[]>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(options: SlidingWindowRateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxRequests = options.maxRequests ?? 60;
    this.now = options.now ?? Date.now;
    this.errorCode = options.errorCode ?? MCP_ERRORS.RATE_LIMITED_ALT;

    this.cleanupTimer = setInterval(
      () => this.pruneExpired(),
      Math.min(this.windowMs, 60_000)
    );
    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  public middleware(): RequestHandler {
    return (request: Request, response: Response, next: NextFunction) => {
      const token = extractBearerToken(request);
      const tokenKey = request.mcpCaller?.tokenDigest || (token ? createHash('sha256').update(token.trim()).digest('hex').slice(0, 12) : null);
      const key = tokenKey || request.ip || 'anonymous';
      const currentTime = this.now();
      const cutoff = currentTime - this.windowMs;

      let timestamps = this.buckets.get(key);
      if (!timestamps) {
        timestamps = [];
        this.buckets.set(key, timestamps);
      }

      // Evict entries older than window
      let validIndex = 0;
      while (validIndex < timestamps.length && timestamps[validIndex] <= cutoff) {
        validIndex++;
      }
      if (validIndex > 0) {
        timestamps.splice(0, validIndex);
      }

      if (timestamps.length >= this.maxRequests) {
        const earliestTime = timestamps[0];
        const resetTimeMs = earliestTime + this.windowMs;
        const retryAfterSeconds = Math.max(1, Math.ceil((resetTimeMs - currentTime) / 1000));

        response.setHeader('Retry-After', String(retryAfterSeconds));
        response.setHeader('X-RateLimit-Limit', String(this.maxRequests));
        response.setHeader('X-RateLimit-Remaining', '0');
        response.setHeader('X-RateLimit-Reset', String(Math.ceil(resetTimeMs / 1000)));

        return response.status(429).json(
          buildJsonRpcError(
            null,
            this.errorCode,
            `Too many requests. Rate limit exceeded (${this.maxRequests} req/min). Retry in ${retryAfterSeconds}s.`
          )
        );
      }

      timestamps.push(currentTime);
      const remaining = this.maxRequests - timestamps.length;
      const resetTimeMs = currentTime + this.windowMs;

      response.setHeader('X-RateLimit-Limit', String(this.maxRequests));
      response.setHeader('X-RateLimit-Remaining', String(remaining));
      response.setHeader('X-RateLimit-Reset', String(Math.ceil(resetTimeMs / 1000)));

      return next();
    };
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [key, timestamps] of this.buckets.entries()) {
      let validIndex = 0;
      while (validIndex < timestamps.length && timestamps[validIndex] <= cutoff) {
        validIndex++;
      }
      if (validIndex >= timestamps.length) {
        this.buckets.delete(key);
      } else if (validIndex > 0) {
        timestamps.splice(0, validIndex);
      }
    }
  }

  public reset(): void {
    this.buckets.clear();
  }

  public close(): void {
    clearInterval(this.cleanupTimer);
    this.buckets.clear();
  }
}
