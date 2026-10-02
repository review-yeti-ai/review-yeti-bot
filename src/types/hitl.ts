/**
 * Human-in-the-Loop (HITL) domain types for Review Yeti R2.
 */

export interface PromptGuidanceItem {
  id: string;
  reviewId: string;
  guidanceText: string;
  targetPersonas?: string[];
  createdBy: string;
  createdAt: string;
  repository?: string;
  prNumber?: number;
}

export interface VerdictOverrideRecord {
  id?: string;
  reviewId: string;
  overrideVerdict: 'SHIP' | 'BLOCK';
  reason: string;
  overriddenBy: string;
  previousVerdict?: string;
  gateVersion?: number;
  timestamp: string;
}

export interface ReviewAuditEvent {
  id: string;
  reviewId: string;
  actor: string;
  action: 'finding_dismissed' | 'severity_changed' | 'verdict_overridden' | 'guidance_added';
  previousState?: Record<string, unknown>;
  newState: Record<string, unknown>;
  justification?: string;
  timestamp: string;
}

export interface FindingStateRecord {
  findingId: string;
  reviewId: string;
  status: 'active' | 'dismissed' | 'resolved';
  severity: 'P0' | 'P1' | 'P2';
  previousSeverity?: 'P0' | 'P1' | 'P2';
  dismissedReason?: string;
  dismissedBy?: string;
  updatedAt: string;
}

export interface GateAttemptRecord {
  attemptId?: string;
  runId?: string;
  reviewId: string;
  verdict?: 'SHIP' | 'BLOCK' | 'NEUTRAL';
  desired_state: 'queued' | 'in_progress' | 'success' | 'failure' | 'cancelled' | 'timed_out';
  desired_version: number;
  published_version: number;
  updated_at: string;
}

export interface FindingDismissalRequest {
  findingId: string;
  reason: string;
  dismissedBy: string;
}

export interface VerdictOverrideRequest {
  overrideVerdict: 'SHIP' | 'BLOCK';
  reason: string;
  overriddenBy: string;
}

export interface PromptGuidanceRequest {
  guidanceText: string;
  targetPersonas?: string[];
  createdBy: string;
}

export interface VerdictOverrideResponse {
  success: boolean;
  reviewId: string;
  overrideVerdict: 'SHIP' | 'BLOCK';
  previousVerdict?: string;
  gateVersion: number;
  status: string;
}
