# Architectural Analysis & Implementation Specification: M1 Scaffolding & Core Service Setup

**Agent**: Explorer 1 (`teamwork_preview_explorer_m1_1`)  
**Target Project**: `ct-review-bot`  
**Milestone**: Milestone 1 (Core Foundations & Config/State)  
**Date**: 2026-07-24  

---

## 1. Executive Summary & Scope Overview

Milestone 1 establishes the foundational infrastructure of `ct-review-bot`, a multi-persona AI code review bot service. Explorer 1's domain covers:
1. **Node.js + TypeScript Project Scaffolding**: Standardized `package.json`, `tsconfig.json`, build/lint/test scripts.
2. **Test Runner Configuration**: Vitest setup with TypeScript integration and v8 coverage profiling.
3. **Core Express Service Entrypoint**: `src/app.ts` and `src/index.ts` supporting health checks, environment loading, graceful shutdown, and raw request body preservation for webhooks.
4. **Structured Logger Utility**: `src/utils/logger.ts` providing JSON/Console structured logs with level filtering.
5. **Dependency Strategy & Fallbacks**: Package requirements, TypeScript type definitions, and native build fallback design (for `better-sqlite3`).

---

## 2. Project Scaffolding Specification

### 2.1 Directory Structure Blueprint

```
ct-review-bot/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                 # Service launcher & graceful shutdown
│   ├── app.ts                   # Express application setup & middleware
│   ├── config/                  # (Explorer 2: config loader & schema)
│   ├── ticket/                  # (Explorer 2: ticket validator)
│   ├── constitution/            # (Explorer 2: operational constitution engine)
│   ├── persistence/             # (Explorer 3: diff state manager & db)
│   ├── quorum/                  # (M3: review panel & personas)
│   ├── router/                  # (M2: OmniRoute router & token manager)
│   ├── github/                  # (M4: webhook receiver & octokit)
│   └── utils/
│       ├── logger.ts            # (Explorer 1: structured logger)
│       └── diffHash.ts          # (Explorer 3: SHA-256 diff hasher)
└── tests/
    ├── unit/
    │   ├── logger.test.ts
    │   └── app.test.ts
    ├── integration/
    └── e2e/
```

### 2.2 Package Dependency Specification (`package.json`)

#### Production Dependencies
| Package | Version Range | Purpose |
|---|---|---|
| `express` | `^4.19.2` | Web server for webhooks & health check endpoints |
| `@octokit/core` | `^6.1.2` | GitHub API core client |
| `js-yaml` | `^4.1.0` | Parsing `.ct-review.yaml` and `.coderabbit.yaml` configs |
| `zod` | `^3.23.8` | Schema validation for configurations and API payloads |
| `better-sqlite3` | `^11.0.0` | High-performance synchronous SQLite storage for diff states |

#### Development Dependencies
| Package | Version Range | Purpose |
|---|---|---|
| `typescript` | `^5.4.5` | TypeScript compiler |
| `ts-node` | `^10.9.2` | Execution engine for development & local testing |
| `vitest` | `^1.6.0` | Fast TypeScript-native test runner |
| `@vitest/coverage-v8` | `^1.6.0` | Code coverage provider using Node.js V8 engine |
| `supertest` | `^7.0.0` | HTTP assertion engine for Express endpoints |
| `@types/node` | `^20.12.12` | Type definitions for Node.js v20 runtime |
| `@types/express` | `^4.17.21` | Type definitions for Express |
| `@types/js-yaml` | `^4.0.9` | Type definitions for `js-yaml` |
| `@types/better-sqlite3` | `^7.6.10` | Type definitions for `better-sqlite3` |
| `@types/supertest` | `^6.0.2` | Type definitions for `supertest` |

#### Concrete `package.json` Code Blueprint

```json
{
  "name": "ct-review-bot",
  "version": "1.0.0",
  "description": "Enterprise-grade quorum-based GitHub Code Review Bot service",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "ts-node src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@octokit/core": "^6.1.2",
    "better-sqlite3": "^11.0.0",
    "express": "^4.19.2",
    "js-yaml": "^4.1.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.10",
    "@types/express": "^4.17.21",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^20.12.12",
    "@types/supertest": "^6.0.2",
    "@vitest/coverage-v8": "^1.6.0",
    "supertest": "^7.0.0",
    "ts-node": "^10.9.2",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

### 2.3 TypeScript Configuration (`tsconfig.json`)

Key compiler flags:
- `target`: `ES2022` — modern JavaScript features available in Node 20+.
- `module`: `CommonJS` — compatible with Node.js runtime and `better-sqlite3`.
- `moduleResolution`: `node` — standard Node module resolution algorithm.
- `strict`: `true` — enables all strict type checking flags (`noImplicitAny`, `strictNullChecks`, etc.).
- `esModuleInterop`: `true` — seamless import interop between CommonJS and ES modules.
- `outDir`: `./dist` — compiled build destination.
- `rootDir`: `./src` — root source directory.

#### Concrete `tsconfig.json` Code Blueprint

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

---

## 3. Test Runner Architecture & Configuration

### 3.1 Vitest vs Jest Evaluation

| Metric | Jest (`ts-jest`) | Vitest |
|---|---|---|
| **Compilation Speed** | Slower (requires Babel/ts-jest transformations) | Instant (uses Vite/esbuild under the hood) |
| **ESM / CJS Compatibility** | Complex transform configuration required | Native support with zero extra setup |
| **Configuration Overhead** | Requires `jest.config.js` + `ts-jest` preset | Minimal `vitest.config.ts` |
| **API Familiarity** | Standard `describe/it/expect` | 100% Jest-compatible `describe/it/expect/vi` API |
| **Coverage Engine** | `istanbul` or `v8` | Native `v8` provider via `@vitest/coverage-v8` |

**Recommendation**: **Vitest**. Vitest offers instantaneous startup and native TypeScript compilation without needing `ts-jest` transforms, making build and test execution significantly faster and simpler.

### 3.2 Vitest Configuration Blueprint (`vitest.config.ts`)

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', 'tests/'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80
      }
    }
  }
});
```

---

## 4. Express Service Entrypoint Architecture

### 4.1 Modular Separation: `app.ts` vs `index.ts`

To enable fast, isolated integration testing of HTTP routes via `supertest` without starting network listeners, we decouple Express application setup from server socket binding:
- **`src/app.ts`**: Creates and exports the Express app instance, configures body parsing, registers middleware, and defines `/health` and webhook routes.
- **`src/index.ts`**: Imports `app` from `app.ts`, reads environment variables (`PORT`), starts `app.listen()`, and registers process signal handlers for graceful shutdown (`SIGTERM`, `SIGINT`).

### 4.2 Raw Request Body Preservation Middleware

GitHub App webhook signature verification requires computing an HMAC SHA-256 digest over the **exact unparsed raw request payload bytes**.
Standard `express.json()` mutates the request body into a parsed JavaScript object. To prevent signature verification failures:
- `express.json()` must be configured with a custom `verify` callback that attaches `req.rawBody = buf` to incoming requests.

### 4.3 Concrete `src/app.ts` Code Blueprint

```typescript
import express, { Express, Request, Response, NextFunction } from 'express';
import { logger } from './utils/logger';

export interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

export function createApp(): Express {
  const app = express();

  // Parse JSON with raw body retention for GitHub webhook signature validation
  app.use(
    express.json({
      verify: (req: RequestWithRawBody, _res: Response, buf: Buffer) => {
        req.rawBody = buf;
      }
    })
  );

  // Request logging middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info('HTTP Request', {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        durationMs: duration
      });
    });
    next();
  });

  // Liveness and Readiness Probe Endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'ct-review-bot',
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime()
    });
  });

  return app;
}
```

### 4.4 Concrete `src/index.ts` Code Blueprint

```typescript
import { createApp } from './app';
import { logger } from './utils/logger';

const PORT = parseInt(process.env.PORT || '3000', 10);
const app = createApp();

const server = app.listen(PORT, () => {
  logger.info(`ct-review-bot service listening on port ${PORT}`, {
    port: PORT,
    nodeEnv: process.env.NODE_ENV || 'development'
  });
});

function gracefulShutdown(signal: string) {
  logger.info(`Received ${signal}. Initiating graceful shutdown...`);
  server.close(() => {
    logger.info('HTTP server closed. Exiting process.');
    process.exit(0);
  });

  // Force exit if server hasn't closed in 10s
  setTimeout(() => {
    logger.error('Forced shutdown: HTTP server failed to close in time.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

---

## 5. Logger Utility Specification (`src/utils/logger.ts`)

### 5.1 Requirements & Architecture
- **Log Levels**: `debug` (0), `info` (1), `warn` (2), `error` (3).
- **Environment Level Filter**: Reads `LOG_LEVEL` (`process.env.LOG_LEVEL`), defaulting to `info`.
- **Structured Format**: Produces JSON strings when `NODE_ENV=production`, or human-readable formatted output during local development.
- **Context Metadata**: Accepts arbitrary key-value metadata objects to log along with messages.

### 5.2 Concrete `src/utils/logger.ts` Code Blueprint

```typescript
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

class Logger {
  private currentLevel: number;

  constructor() {
    const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
    this.currentLevel = LOG_LEVELS[envLevel] !== undefined ? LOG_LEVELS[envLevel] : LOG_LEVELS.info;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= this.currentLevel;
  }

  private formatMessage(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    const isProduction = process.env.NODE_ENV === 'production';

    if (isProduction) {
      return JSON.stringify({
        timestamp,
        level: level.toUpperCase(),
        message,
        ...meta
      });
    }

    const metaString = meta && Object.keys(meta).length > 0 ? ` | Meta: ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaString}`;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) {
      console.debug(this.formatMessage('debug', message, meta));
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('info')) {
      console.info(this.formatMessage('info', message, meta));
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, meta));
    }
  }

  error(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message, meta));
    }
  }
}

export const logger = new Logger();
```

---

## 6. Native Build Fallback Strategy (`better-sqlite3`)

`better-sqlite3` is a C++ native extension requiring Python and build tools to compile `node-gyp`. To maintain zero-failure build tolerance in minimal containers or restricted operating environments:
1. `better-sqlite3` is included as a primary dependency in `package.json`.
2. Storage modules (`src/persistence/db.ts` designed by Explorer 3) should implement a dynamic try/catch loading abstraction:
   - If `better-sqlite3` imports successfully, instantiate SQLite backing.
   - If `better-sqlite3` fails to load (e.g. `ERR_DLOPEN_FAILED` or native module missing), automatically fallback to an atomic JSON file storage mechanism (`.json` with `.tmp` write and atomic rename).

---

## 7. Verification Method for Implementer

To verify the scaffolding after implementation:
1. `npm install` — Verify all dependencies resolve cleanly.
2. `npm run build` — Verify TypeScript compiles cleanly without errors.
3. `npm run lint` — Confirm zero type check errors.
4. `npm test` — Run Vitest suite and verify health check unit tests pass with 100% line coverage.
