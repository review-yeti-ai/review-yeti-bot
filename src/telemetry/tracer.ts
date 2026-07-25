import { trace, Tracer, Context, context, SpanOptions, Span, SpanStatusCode, ContextManager, ROOT_CONTEXT } from '@opentelemetry/api';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { AsyncLocalStorage } from 'async_hooks';
import { inMemorySpanExporter } from './spans';

export class AsyncLocalStorageContextManager implements ContextManager {
  private storage = new AsyncLocalStorage<Context>();

  public active(): Context {
    return this.storage.getStore() || ROOT_CONTEXT;
  }

  public with<A extends (...args: any[]) => any>(
    context: Context,
    fn: A,
    thisArg?: any,
    ...args: Parameters<A>
  ): ReturnType<A> {
    return this.storage.run(context, () => fn.apply(thisArg, args));
  }

  public bind<T>(context: Context, target: T): T {
    if (typeof target === 'function') {
      const self = this;
      return function (this: any, ...args: any[]) {
        return self.with(context, target as any, this, ...args);
      } as any;
    }
    return target;
  }

  public enable(): this {
    return this;
  }

  public disable(): this {
    this.storage.disable();
    return this;
  }
}

let tracerProvider: BasicTracerProvider | null = null;

export function initTracer(serviceName = 'ct-review-bot'): BasicTracerProvider {
  if (tracerProvider) {
    return tracerProvider;
  }

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
  });

  tracerProvider = new BasicTracerProvider({
    resource,
  });

  tracerProvider.addSpanProcessor(new SimpleSpanProcessor(inMemorySpanExporter));
  tracerProvider.register({ contextManager: new AsyncLocalStorageContextManager() });

  return tracerProvider;
}

export function getTracer(name = 'ct-review-bot', version?: string): Tracer {
  return trace.getTracer(name, version);
}

export async function runInSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  options?: SpanOptions,
  ctx?: Context
): Promise<T> {
  const tracer = getTracer();
  const parentContext = ctx || context.active();
  const span = tracer.startSpan(name, options, parentContext);

  const activeCtx = trace.setSpan(parentContext, span);

  try {
    const result = await context.with(activeCtx, () => fn(span));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error: any) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error?.message || String(error),
    });
    span.recordException(error);
    throw error;
  } finally {
    span.end();
  }
}
