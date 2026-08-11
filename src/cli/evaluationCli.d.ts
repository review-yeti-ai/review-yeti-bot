export const EXIT_CODES: {
  readonly PASS: 0;
  readonly FAIL: 1;
  readonly USAGE: 2;
  readonly INCONCLUSIVE: 3;
};

export function runEvaluationCli(argv?: string[], dependencies?: Record<string, unknown>): Promise<number>;
