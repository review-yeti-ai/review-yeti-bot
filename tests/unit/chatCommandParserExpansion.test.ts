import { describe, it, expect } from 'vitest';
import { parseCommand } from '../../src/chat/commandDispatcher';

describe('commandDispatcher.ts — Parser Edge Case Unit Tests', () => {
  it('parses commands with leading/trailing whitespace', () => {
    const cmd = parseCommand('   @ct-review   review   ');
    expect(cmd).toEqual({ command: 'review', args: '', rawText: '   @ct-review   review   ' });
  });

  it('parses commands case-insensitively (@CT-REVIEW EXPLAIN)', () => {
    const cmd = parseCommand('@CT-REVIEW EXPLAIN how does this work?');
    expect(cmd?.command).toBe('explain');
    expect(cmd?.args).toBe('how does this work?');
  });

  it('parses @ct-review-bot bot mention handle', () => {
    const cmd = parseCommand('@ct-review-bot refactor simplify code');
    expect(cmd?.command).toBe('refactor');
    expect(cmd?.args).toBe('simplify code');
  });

  it('parses @bot short mention handle', () => {
    const cmd = parseCommand('@bot summarize');
    expect(cmd?.command).toBe('summarize');
    expect(cmd?.args).toBe('');
  });

  it('parses multi-line argument strings in command text', () => {
    const multiLineArg = 'Please explain this line:\nline 1\nline 2';
    const cmd = parseCommand(`@ct-review explain ${multiLineArg}`);

    expect(cmd?.command).toBe('explain');
    expect(cmd?.args).toBe(multiLineArg);
  });

  it('parses code snippets embedded inside command arguments', () => {
    const codeArg = 'use `const x = 1;` instead of `var x = 1;`';
    const cmd = parseCommand(`@ct-review refactor ${codeArg}`);

    expect(cmd?.command).toBe('refactor');
    expect(cmd?.args).toBe(codeArg);
  });

  it('parses ask command with unicode and emoji characters in question', () => {
    const question = 'Is this thread-safe? 🔒 ⚡';
    const cmd = parseCommand(`@ct-review ask ${question}`);

    expect(cmd?.command).toBe('ask');
    expect(cmd?.args).toBe(question);
  });

  it('returns null for unmentioned bot handles (@other-bot review)', () => {
    expect(parseCommand('@other-bot review')).toBeNull();
    expect(parseCommand('@github-actions review')).toBeNull();
  });

  it('returns null for bare mention without command (@ct-review)', () => {
    expect(parseCommand('@ct-review')).toBeNull();
    expect(parseCommand('@ct-review-bot')).toBeNull();
  });

  it('returns null for invalid command keyword (@ct-review invalidKeyword)', () => {
    expect(parseCommand('@ct-review execute')).toBeNull();
    expect(parseCommand('@ct-review deploy')).toBeNull();
  });

  it('returns null for null, undefined, or non-string inputs', () => {
    expect(parseCommand(null as any)).toBeNull();
    expect(parseCommand(undefined as any)).toBeNull();
    expect(parseCommand(12345 as any)).toBeNull();
    expect(parseCommand({ text: '@ct-review review' } as any)).toBeNull();
  });

  it('preserves exact rawText string in ParsedCommand output', () => {
    const raw = '   @ct-review   ask   What is the test coverage?   ';
    const cmd = parseCommand(raw);

    expect(cmd?.rawText).toBe(raw);
    expect(cmd?.command).toBe('ask');
    expect(cmd?.args).toBe('What is the test coverage?');
  });
});
