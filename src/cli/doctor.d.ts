export interface DoctorCheck { id: string; status: 'ok' | 'warning' | 'error'; detail: string; source?: string; }
export interface DoctorReceipt { schemaVersion: 'review-yeti-doctor-v1'; status: 'ok' | 'warning' | 'error'; checks: DoctorCheck[]; }
export function runDoctor(dependencies?: Record<string, unknown>): Promise<DoctorReceipt>;
