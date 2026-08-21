import { Request, Response, NextFunction } from 'express';
import { getTracer } from './tracer';
import { SpanStatusCode, trace, context } from '@opentelemetry/api';

export function telemetryMiddleware() {
  const tracer = getTracer();

  return (req: Request, res: Response, next: NextFunction) => {
    const spanName = `HTTP ${req.method} ${req.path}`;
    const span = tracer.startSpan(spanName, {
      attributes: {
        'http.method': req.method,
        'http.target': req.originalUrl || req.url,
        'http.user_agent': req.headers['user-agent'] || '',
      },
    });

    const activeCtx = trace.setSpan(context.active(), span);

    context.with(activeCtx, () => {
      res.on('finish', () => {
        span.setAttribute('http.status_code', res.statusCode);
        if (res.statusCode >= 400) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${res.statusCode}`,
          });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        span.end();
      });

      next();
    });
  };
}
