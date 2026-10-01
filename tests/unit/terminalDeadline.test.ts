import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TERMINAL_DEADLINE_MS,
  LEGACY_MAX_TERMINAL_DEADLINE_MS,
  assertPersistedTerminalDeadlineWindow,
  assertTerminalDeadlineWindow,
  resolveTerminalDeadlineMs,
} from '../../src/config/terminalDeadline';

const ENV_VAR = 'REVIEW_YETI_TERMINAL_DEADLINE_MS';

function envWith(value: string | undefined): NodeJS.ProcessEnv {
  if (value === undefined) return {} as unknown as NodeJS.ProcessEnv;
  return { [ENV_VAR]: value } as unknown as NodeJS.ProcessEnv;
}

describe('resolveTerminalDeadlineMs', () => {
  it('defaults to DEFAULT_TERMINAL_DEADLINE_MS when the env var is unset', () => {
    expect(resolveTerminalDeadlineMs(envWith(undefined))).toBe(DEFAULT_TERMINAL_DEADLINE_MS);
  });

  it('defaults when the env var is present but blank or whitespace-only', () => {
    expect(resolveTerminalDeadlineMs(envWith(''))).toBe(DEFAULT_TERMINAL_DEADLINE_MS);
    expect(resolveTerminalDeadlineMs(envWith('   '))).toBe(DEFAULT_TERMINAL_DEADLINE_MS);
    expect(resolveTerminalDeadlineMs(envWith('\t\n'))).toBe(DEFAULT_TERMINAL_DEADLINE_MS);
  });

  it('accepts the exact fixed boundary value', () => {
    expect(resolveTerminalDeadlineMs(envWith(String(DEFAULT_TERMINAL_DEADLINE_MS))))
      .toBe(DEFAULT_TERMINAL_DEADLINE_MS);
  });

  it('rejects any attempt to widen the end-to-end ceiling', () => {
    expect(() => resolveTerminalDeadlineMs(envWith('2400000'))).toThrow(/must equal the 900000 millisecond/i);
  });

  it('rejects a value one millisecond below the exact deadline', () => {
    expect(() => resolveTerminalDeadlineMs(envWith(String(DEFAULT_TERMINAL_DEADLINE_MS - 1)))).toThrow(
      new RegExp(`${ENV_VAR} must equal`, 'i'),
    );
  });

  it('rejects a value one millisecond above the exact deadline', () => {
    expect(() => resolveTerminalDeadlineMs(envWith(String(DEFAULT_TERMINAL_DEADLINE_MS + 1)))).toThrow(
      new RegExp(`${ENV_VAR} must equal`, 'i'),
    );
  });

  it('rejects non-numeric input', () => {
    expect(() => resolveTerminalDeadlineMs(envWith('abc'))).toThrow(/must equal/i);
  });

  it('rejects fractional / non-safe-integer input', () => {
    expect(() => resolveTerminalDeadlineMs(envWith('1800000.5'))).toThrow(/must equal/i);
    expect(() => resolveTerminalDeadlineMs(envWith('2000000.7'))).toThrow(/must equal/i);
    expect(() => resolveTerminalDeadlineMs(envWith(String(Number.MAX_SAFE_INTEGER + 10)))).toThrow(/must equal/i);
  });

  it('rejects negative input', () => {
    expect(() => resolveTerminalDeadlineMs(envWith('-1800000'))).toThrow(/must equal/i);
  });

  it('trims surrounding whitespace before coercion but still accepts a padded valid value', () => {
    // Number() coerces whitespace-padded numeric strings; confirm the resolver does not
    // reject a legitimately padded env value that Number() can parse cleanly.
    expect(resolveTerminalDeadlineMs(envWith('  900000  '))).toBe(900_000);
  });

  it('never mutates the injected env object', () => {
    const env = envWith('900000');
    const snapshot = { ...env };
    resolveTerminalDeadlineMs(env);
    expect(env).toEqual(snapshot);
  });
});

describe('assertTerminalDeadlineWindow', () => {
  it('accepts only the exact deadline window', () => {
    expect(() => assertTerminalDeadlineWindow(0, DEFAULT_TERMINAL_DEADLINE_MS)).not.toThrow();
  });

  it('accepts the exact window regardless of the receivedAt offset', () => {
    expect(() => assertTerminalDeadlineWindow(1_000, 1_000 + 900_000)).not.toThrow();
  });

  it('rejects a window one millisecond below or above the exact deadline', () => {
    expect(() => assertTerminalDeadlineWindow(0, DEFAULT_TERMINAL_DEADLINE_MS - 1)).toThrow(/terminal deadline must be exactly/i);
    expect(() => assertTerminalDeadlineWindow(0, DEFAULT_TERMINAL_DEADLINE_MS + 1)).toThrow(/terminal deadline must be exactly/i);
  });

  // Arithmetic with NaN cannot satisfy the exact deadline invariant, but pin the
  // explicit finite guards because repository.admit() delegates this validation.
  it('rejects non-finite receivedAt or terminalDeadline', () => {
    expect(() => assertTerminalDeadlineWindow(Number.NaN, Number.NaN)).toThrow(/terminal deadline must be exactly/i);
    expect(() => assertTerminalDeadlineWindow(1_000, Number.NaN)).toThrow(/terminal deadline must be exactly/i);
    expect(() => assertTerminalDeadlineWindow(Number.NaN, 1_000 + 900_000)).toThrow(/terminal deadline must be exactly/i);
    expect(() => assertTerminalDeadlineWindow(1_000, Number.POSITIVE_INFINITY)).toThrow(/terminal deadline must be exactly/i);
    expect(() => assertTerminalDeadlineWindow(Number.NEGATIVE_INFINITY, 1_000)).toThrow(/terminal deadline must be exactly/i);
  });
});

describe('assertPersistedTerminalDeadlineWindow', () => {
  it('allows old admitted windows only so their terminal recovery can finish', () => {
    for (const window of [900_000, 1_800_000, 2_700_000, LEGACY_MAX_TERMINAL_DEADLINE_MS]) {
      expect(() => assertPersistedTerminalDeadlineWindow(1_000, 1_000 + window)).not.toThrow();
    }
  });

  it('rejects persisted windows outside the former bounded contract', () => {
    expect(() => assertPersistedTerminalDeadlineWindow(0, 899_999)).toThrow(/persisted terminal deadline/i);
    expect(() => assertPersistedTerminalDeadlineWindow(0, LEGACY_MAX_TERMINAL_DEADLINE_MS + 1))
      .toThrow(/persisted terminal deadline/i);
  });

  it('rejects non-finite persisted receivedAt or terminalDeadline', () => {
    expect(() => assertPersistedTerminalDeadlineWindow(Number.NaN, Number.NaN)).toThrow(/persisted terminal deadline/i);
    expect(() => assertPersistedTerminalDeadlineWindow(1_000, Number.NaN)).toThrow(/persisted terminal deadline/i);
    expect(() => assertPersistedTerminalDeadlineWindow(Number.NaN, 1_000 + 900_000)).toThrow(/persisted terminal deadline/i);
    expect(() => assertPersistedTerminalDeadlineWindow(1_000, Number.POSITIVE_INFINITY)).toThrow(/persisted terminal deadline/i);
    expect(() => assertPersistedTerminalDeadlineWindow(Number.NEGATIVE_INFINITY, 1_000)).toThrow(/persisted terminal deadline/i);
  });
});
