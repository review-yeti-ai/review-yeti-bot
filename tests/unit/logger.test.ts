import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../src/utils/logger';

describe('Logger Utility', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('logs info messages formatted in non-production mode', () => {
    process.env.NODE_ENV = 'development';
    process.env.LOG_LEVEL = 'info';
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    logger.info('Test info message', { key: 'val' });

    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0][0];
    expect(output).toContain('[INFO] Test info message');
    expect(output).toContain('Meta: {"key":"val"}');
  });

  it('logs JSON formatted messages in production mode', () => {
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'debug';
    logger.setLevel('debug');
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    logger.debug('Production debug log', { service: 'review-yeti-bot' });

    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.level).toBe('DEBUG');
    expect(parsed.message).toBe('Production debug log');
    expect(parsed.service).toBe('review-yeti-bot');
  });

  it('respects log level filtering and programmatic setLevel', () => {
    logger.setLevel('warn');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    logger.info('Should be filtered out');
    logger.warn('Should be logged');

    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('handles error log level', () => {
    logger.setLevel('error');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.error('Critical failure', { code: 500 });

    expect(errorSpy).toHaveBeenCalledOnce();
  });
});
