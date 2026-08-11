export const EXIT_CODES: { readonly PASS: 0; readonly FAIL: 1; readonly USAGE: 2; readonly BLOCKED: 3; readonly CANCELLED: 130 };
export function main(argv?: string[], dependencies?: Record<string, unknown>): Promise<number>;
