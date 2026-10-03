import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AuthService } from '../../src/dashboard/authService';
import { createApp } from '../../src/app';

// The repository-wide test setup sets ADMIN_PASSWORD; these tests control it explicitly.
describe('local admin login fails closed without ADMIN_PASSWORD (REL-1282)', () => {
  const original = process.env.ADMIN_PASSWORD;
  beforeEach(() => { delete process.env.ADMIN_PASSWORD; });
  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = original;
  });

  it.each([undefined, '', 'admin123', 'admin', 'password'])('rejects admin login with password %j when unset', (password) => {
    const service = new AuthService();
    expect(service.isLocalLoginConfigured()).toBe(false);
    expect(service.login('admin', password as string | undefined)).toBeNull();
  });

  it('treats an empty ADMIN_PASSWORD as unset', () => {
    process.env.ADMIN_PASSWORD = '';
    const service = new AuthService();
    expect(service.isLocalLoginConfigured()).toBe(false);
    expect(service.login('admin', '')).toBeNull();
  });

  it('the login route rejects every attempt with 503 and no token', async () => {
    const app = createApp();
    for (const body of [{ username: 'admin', password: 'admin123' }, { username: 'admin', password: 'x' }]) {
      const res = await request(app).post('/api/auth/login').send(body);
      expect(res.status).toBe(503);
      expect(res.body.token).toBeUndefined();
      expect(res.body.success).toBe(false);
    }
  });

  it('still logs in with the configured password and rejects a wrong one', async () => {
    process.env.ADMIN_PASSWORD = 'configured-secret-for-test';
    const service = new AuthService();
    expect(service.isLocalLoginConfigured()).toBe(true);
    expect(service.login('admin', 'configured-secret-for-test')?.user.role).toBe('admin');
    expect(service.login('admin', 'admin123')).toBeNull();
    expect(service.login('root', 'configured-secret-for-test')).toBeNull();
    const app = createApp();
    const ok = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'configured-secret-for-test' });
    expect(ok.status).toBe(200);
    const bad = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
    expect(bad.status).toBe(401);
  });
});
