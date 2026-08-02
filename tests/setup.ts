import '@testing-library/jest-dom';
import * as matchers from '@testing-library/jest-dom/matchers';
import { expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { dashboardStore } from '../src/persistence/dashboardStore';
import { postgresStore } from '../src/persistence/postgresStore';
import { providerPool } from '../src/gateway/providerPool';
import { inMemorySpanExporter } from '../src/telemetry/spans';

expect.extend(matchers);

// Set standard test environment variables
const testStoreId = `${process.pid}_${Math.random().toString(36).substring(2)}`;
process.env.CT_DASHBOARD_STORE = `/tmp/ct-review-bot/test_store_${testStoreId}.json`;
process.env.CT_REVIEW_PLATFORM_DB = process.env.CT_REVIEW_PLATFORM_DB || ':memory:';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test_webhook_secret';
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
process.env.GITHUB_APP_ID = process.env.GITHUB_APP_ID || '123456';
process.env.GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY || '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3\n-----END RSA PRIVATE KEY-----';
process.env.OMNIROUTE_BASE_URL = process.env.OMNIROUTE_BASE_URL || 'http://localhost:8080';

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

  // 2. Reset Singleton Stores
  if (typeof dashboardStore.reset === 'function') {
    dashboardStore.reset();
  }
  if (typeof postgresStore.reset === 'function') {
    postgresStore.reset();
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
