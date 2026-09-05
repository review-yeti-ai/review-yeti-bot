// REL-582: the bare '@testing-library/jest-dom' entry pulls in types/jest.d.ts, which references
// a 'jest' type package this project does not (and should not) install. The '/vitest' entry is
// the supported one for a Vitest project and registers the same matchers.
import '@testing-library/jest-dom/vitest';
import * as matchers from '@testing-library/jest-dom/matchers';
import { expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dashboardStore } from '../src/persistence/dashboardStore';
import { postgresStore } from '../src/persistence/postgresStore';
import { providerPool } from '../src/gateway/providerPool';
import { inMemorySpanExporter } from '../src/telemetry/spans';
import http from 'node:http';
import { authService } from '../src/dashboard/authService';

expect.extend(matchers);

import supertest from 'supertest';
import https from 'node:https';

// Patch Supertest's serverAddress to connect via IPv6 [::1] when binding to IPv6 (default in Node for listen(0)),
// avoiding macOS port collision where 127.0.0.1 hits local host proxy servers bound to IPv4.
if ((supertest as any).Test?.prototype?.serverAddress) {
  (supertest as any).Test.prototype.serverAddress = function (app: any, path: string) {
    let addr = app.address();
    if (!addr) {
      this._server = app.listen(0);
      addr = app.address();
    }
    const port = addr ? addr.port : 0;
    const protocol = app instanceof https.Server ? 'https' : 'http';
    const host = addr && addr.family === 'IPv6' ? '[::1]' : '127.0.0.1';
    return `${protocol}://${host}:${port}${path}`;
  };
}

// Similarly patch http.get and http.request so raw http.get calls using http://127.0.0.1:<port> connect via [::1]
function normalize127(arg: any) {
  if (typeof arg === 'string') {
    return arg.replace('http://127.0.0.1:', 'http://[::1]:');
  }
  if (arg instanceof URL) {
    if (arg.hostname === '127.0.0.1') arg.hostname = '::1';
    return arg;
  }
  if (arg && typeof arg === 'object') {
    if (arg.hostname === '127.0.0.1') arg.hostname = '::1';
    if (arg.host === '127.0.0.1') arg.host = '[::1]';
  }
  return arg;
}
const origHttpGet = http.get;
(http as any).get = function (...args: any[]) {
  args[0] = normalize127(args[0]);
  return (origHttpGet as any).apply(this, args);
};
const origHttpRequest = http.request;
(http as any).request = function (...args: any[]) {
  args[0] = normalize127(args[0]);
  return (origHttpRequest as any).apply(this, args);
};

// Set standard test environment variables
const testStoreId = `${process.pid}_${Math.random().toString(36).substring(2)}`;

// REL-560: give every worker its own disposable state root, and delete it on exit.
//
// Two separate bugs lived in the old fixed `/tmp/ct-review-bot` paths:
//
// 1. `CT_REVIEW_RUN_STORE` was never set, so ReviewRunStore (src/app.ts) fell back to a single
//    shared `/tmp/ct-review-bot/review-runs.json` that persisted across every test file AND
//    across every run, accumulating deliveries/heads/previousHeads/threads. Locally the suite
//    failed 2-13 tests per run with a different failing set each time; moving that one file
//    aside took it to 1. CI never saw it because a fresh runner starts with the file absent.
// 2. The reset below assigns a fresh `CT_DASHBOARD_STORE` path per test and only ever unlinks
//    the previous one, so the last store of every fork survived. That leaked ~200 files per
//    worker, forever: this machine had 374,719 files and 17 GB under /tmp/ct-review-bot.
//
// Both are fixed by rooting all of it in one per-worker mkdtemp directory that is removed when
// the worker exits. This is also what makes `fileParallelism` safe -- workers can no longer
// read or clobber each other's run store.
const workerStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-review-bot-test-'));
process.on('exit', () => {
  try {
    fs.rmSync(workerStateRoot, { recursive: true, force: true });
  } catch {}
});

process.env.CT_REVIEW_RUN_STORE = path.join(workerStateRoot, 'review-runs.json');
process.env.CT_REVIEW_DATA_DIR = workerStateRoot;
process.env.CT_DASHBOARD_STORE = path.join(workerStateRoot, `test_store_${testStoreId}.json`);
process.env.CT_REVIEW_PLATFORM_DB = process.env.CT_REVIEW_PLATFORM_DB || ':memory:';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test_webhook_secret';
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
process.env.GITHUB_APP_ID = process.env.GITHUB_APP_ID || '123456';
process.env.GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY || '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3\n-----END RSA PRIVATE KEY-----';
process.env.OMNIROUTE_BASE_URL = process.env.OMNIROUTE_BASE_URL || 'http://localhost:8080';
process.env.ADMIN_PASSWORD = 'admin123';

// Disable proxy environment variables during unit/e2e testing
delete process.env.http_proxy;
delete process.env.HTTP_PROXY;
delete process.env.https_proxy;
delete process.env.HTTPS_PROXY;
delete process.env.all_proxy;
delete process.env.ALL_PROXY;
process.env.NO_PROXY = '*';
process.env.no_proxy = '*';

// Capture baseline process.env after initializing test environment variables
const initialEnv = { ...process.env };

function resetAllGlobalState() {
  // 1. Restore process.env
  for (const key of Object.keys(process.env)) {
    if (!(key in initialEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, initialEnv);

  delete process.env.http_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.https_proxy;
  delete process.env.HTTPS_PROXY;
  delete process.env.all_proxy;
  delete process.env.ALL_PROXY;
  process.env.NO_PROXY = '*';
  process.env.no_proxy = '*';

  // 1.5. Clean and assign a fresh store file inside this worker's own state root.
  // REL-560: the guard used to be `startsWith('/tmp/')`, which never matches on macOS because
  // os.tmpdir() is /var/folders/..., so the per-test cleanup silently did nothing there. Anchor
  // it to workerStateRoot instead, which is correct on every platform.
  if (process.env.CT_DASHBOARD_STORE && process.env.CT_DASHBOARD_STORE.startsWith(workerStateRoot)) {
    try {
      if (fs.existsSync(process.env.CT_DASHBOARD_STORE)) {
        fs.unlinkSync(process.env.CT_DASHBOARD_STORE);
      }
    } catch {}
  }
  const resetStoreId = `${process.pid}_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  process.env.CT_DASHBOARD_STORE = path.join(workerStateRoot, `test_store_${resetStoreId}.json`);

  // 2. Reset Singleton Stores
  if (typeof dashboardStore.reset === 'function') {
    dashboardStore.reset();
  }
  // PostgresStore has no `reset` method on its declared type (confirmed in
  // src/persistence/postgresStore.ts) — this guard is a pre-existing no-op kept in the same
  // defensive-optional style as the inMemorySpanExporter check below, in case a future revision
  // adds one. Cast, matching that existing pattern, rather than deleting the guard.
  if (typeof (postgresStore as any).reset === 'function') {
    (postgresStore as any).reset();
  }
  if (typeof providerPool.clear === 'function') {
    providerPool.clear();
  }
  if (typeof (inMemorySpanExporter as any).reset === 'function') {
    (inMemorySpanExporter as any).reset();
  }

  // 3. Restore all Vitest spies and mocks
  vi.restoreAllMocks();
  vi.clearAllMocks();

  // 4. React Testing Library DOM cleanup
  cleanup();
  if (typeof document !== 'undefined') {
    document.body.removeAttribute('data-aria-hidden');
    document.body.removeAttribute('aria-hidden');
    document.body.style.pointerEvents = '';
  }
}

beforeEach(() => {
  resetAllGlobalState();
});

afterEach(() => {
  resetAllGlobalState();
});

// Global ResizeObserver, IntersectionObserver, and matchMedia mocks for jsdom tests (ReactFlow, Recharts, Radix UI)
const MockResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

(globalThis as any).ResizeObserver = MockResizeObserver;
if (typeof global !== 'undefined') {
  (global as any).ResizeObserver = MockResizeObserver;
}
if (typeof window !== 'undefined') {
  (window as any).ResizeObserver = MockResizeObserver;
  if (typeof (window as any).IntersectionObserver === 'undefined') {
    (window as any).IntersectionObserver = class IntersectionObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (typeof (window as any).matchMedia === 'undefined') {
    (window as any).matchMedia = function (query: string) {
      return {
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      };
    };
  }
}
