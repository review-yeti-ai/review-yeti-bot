import { beforeEach, afterEach, vi } from 'vitest';

// Standard test environment. Values are synthetic; no test may reach a real endpoint.
process.env.REVIEW_YETI_PLATFORM_DB = process.env.REVIEW_YETI_PLATFORM_DB || ':memory:';
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
process.env.GITHUB_APP_ID = process.env.GITHUB_APP_ID || '123456';

// Baseline captured after the variables above are set, so each test starts from the same env.
const initialEnv = { ...process.env };

function resetAllGlobalState() {
  for (const key of Object.keys(process.env)) {
    if (!(key in initialEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, initialEnv);

  vi.restoreAllMocks();
  vi.clearAllMocks();
}

beforeEach(resetAllGlobalState);
afterEach(resetAllGlobalState);
