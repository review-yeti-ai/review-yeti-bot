import '@testing-library/jest-dom';
import * as matchers from '@testing-library/jest-dom/matchers';
import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

expect.extend(matchers);

afterEach(() => {
  cleanup();
});

// Set standard test environment variables
const testStoreId = `${process.pid}_${Math.random().toString(36).substring(2)}`;
process.env.CT_DASHBOARD_STORE = `/tmp/ct-review-bot/test_store_${testStoreId}.json`;
process.env.CT_REVIEW_PLATFORM_DB = process.env.CT_REVIEW_PLATFORM_DB || ':memory:';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test_webhook_secret';
process.env.GITHUB_APP_ID = process.env.GITHUB_APP_ID || '123456';
process.env.GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY || '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3\n-----END RSA PRIVATE KEY-----';
process.env.OMNIROUTE_BASE_URL = process.env.OMNIROUTE_BASE_URL || 'http://localhost:8080';
