import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Combines class names using clsx and merges Tailwind CSS classes cleanly.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Formats an ISO string or Date into a human-friendly relative time marker
 * (e.g. "Just now", "2m ago", "1h ago", "3d ago").
 */
export function formatRelativeTime(dateInput: string | Date | number | undefined | null): string {
  if (!dateInput) return 'Just now';
  try {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return String(dateInput);
    const now = Date.now();
    const diffMs = now - d.getTime();
    if (diffMs < 0) return 'Just now';
    const diffSecs = Math.floor(diffMs / 1000);
    if (diffSecs < 45) return 'Just now';
    const diffMins = Math.floor(diffSecs / 60);
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays}d ago`;
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d);
  } catch {
    return String(dateInput);
  }
}

/**
 * Formats prompt (input) and completion (output) token breakdown cleanly.
 */
export function formatTokenBreakdown(promptTokens?: number, completionTokens?: number, totalTokens?: number): string {
  const p = promptTokens || 0;
  const c = completionTokens || 0;
  const t = totalTokens || (p + c);
  if (p > 0 || c > 0) {
    return `📥 ${p.toLocaleString()} in / 📤 ${c.toLocaleString()} out (${t.toLocaleString()} total)`;
  }
  if (t > 0) {
    return `${t.toLocaleString()} tokens`;
  }
  return '0 tokens';
}
