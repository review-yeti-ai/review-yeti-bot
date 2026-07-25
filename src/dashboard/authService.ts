import crypto from 'crypto';
import { dashboardStore } from '../persistence/dashboardStore';

export interface UserSession {
  token: string;
  user: {
    id: string;
    username: string;
    role: string;
    email?: string;
  };
  expiresAt: string;
}

export class AuthService {
  private sessions: Map<string, UserSession> = new Map();

  public login(username: string, password?: string): UserSession | null {
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    // Allow login if username is admin and password matches
    if (username === 'admin' && password === adminPassword) {
      const token = `sess_${crypto.randomBytes(24).toString('hex')}`;
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const session: UserSession = {
        token,
        user: {
          id: 'usr_admin_01',
          username: 'admin',
          role: 'admin',
          email: 'admin@company.com',
        },
        expiresAt,
      };
      this.sessions.set(token, session);
      return session;
    }
    return null;
  }

  public validateSession(token: string): UserSession | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  public invalidateSession(token: string): boolean {
    return this.sessions.delete(token);
  }

  public validateApiKey(apiKey: string): boolean {
    return dashboardStore.validateApiKey(apiKey);
  }
}

export const authService = new AuthService();
