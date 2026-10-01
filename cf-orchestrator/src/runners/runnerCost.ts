/**
 * runnerCost.ts
 *
 * Compute cost calculation and formatting for Review Yeti managed runners
 * (DigitalOcean Managed Agents / Firecracker microVMs and Cloudflare Containers).
 */

export interface RunnerCostDetails {
  runnerType: 'digitalocean' | 'cloudflare' | 'doks' | string;
  runnerName: string;
  durationMs: number;
  vcpus: number;
  memoryMb: number;
  costUsd: number;
  formattedCost: string;
  formattedRuntime: string;
  rateHourlyUsd: number;
  baseHourlyUsd?: number;
  usedFallbackRate?: boolean;
}

export interface CalculateRunnerCostOptions {
  durationMs: number;
  vcpus?: number;
  memoryMb?: number;
  runnerType?: 'digitalocean' | 'cloudflare' | 'doks' | string;
}

/**
 * Standard active compute rates:
 * - DigitalOcean Managed Agents (Firecracker microVM):
 *     Base: $0.0648 / hour for 2 vCPU + 2048 MB ($0.000018 / sec)
 *     Per vCPU: $0.000008 / sec; Per 1024MB RAM: $0.000001 / sec
 * - Cloudflare Containers (Edge OCI sandbox):
 *     Base: $0.0540 / hour for 2 vCPU + 2048 MB ($0.000015 / sec)
 *     Per vCPU: $0.0000065 / sec; Per 1024MB RAM: $0.000001 / sec
 * - DOKS (Kubernetes dedicated node pool amortization):
 *     Amortized base: $0.1800 / hour ($0.000050 / sec)
 */
export interface RunnerRateTier {
  vcpuRatePerSec: number;
  ramGbRatePerSec: number;
}

const HOURLY_RATES: Record<string, RunnerRateTier> = {
  digitalocean: {
    vcpuRatePerSec: 0.000008,
    ramGbRatePerSec: 0.000001,
  },
  cloudflare: {
    vcpuRatePerSec: 0.0000065,
    ramGbRatePerSec: 0.000001,
  },
  doks: {
    vcpuRatePerSec: 0.000020,
    ramGbRatePerSec: 0.000005,
  },
};

const BASE_HOURLY_RATES: Record<string, number> = {
  digitalocean: 0.0648, // 2 vCPU + 2048 MB standard baseline
  cloudflare: 0.0540,   // 2 vCPU + 2048 MB standard baseline
  doks: 0.1800,         // amortized cluster node pool baseline
};

const RUNNER_NAMES: Record<string, string> = {
  digitalocean: 'DigitalOcean Managed Agents (Firecracker microVM)',
  cloudflare: 'Cloudflare Containers (Edge OCI Sandbox)',
  doks: 'DOKS Legacy Kubernetes Worker Pod',
};

/**
 * Formats duration in milliseconds to human-friendly string (e.g., "24.8s (24,800 ms)" or "2m 14.5s").
 */
export function formatDuration(durationMs: number): string {
  const safeMs = Math.max(0, Math.round(durationMs));
  if (safeMs < 1000) {
    return `${safeMs} ms`;
  }
  const totalSeconds = safeMs / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s (${safeMs.toLocaleString()} ms)`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = (totalSeconds % 60).toFixed(1);
  return `${minutes}m ${remainingSeconds}s (${safeMs.toLocaleString()} ms)`;
}

/**
 * Formats a USD amount to high precision currency string (e.g. "$0.000446 USD").
 */
export function formatCostUsd(costUsd: number): string {
  if (costUsd === 0) return '$0.00 USD';
  if (costUsd < 0.01) {
    return `$${costUsd.toFixed(6)} USD`;
  }
  return `$${costUsd.toFixed(4)} USD`;
}

/**
 * Computes exact compute cost and runtime details for a runner session.
 */
export function calculateRunnerCost(options: CalculateRunnerCostOptions): RunnerCostDetails {
  const durationMs = Math.max(0, options.durationMs || 0);
  const vcpus = options.vcpus ?? 2;
  const memoryMb = options.memoryMb ?? 2048;
  const runnerType = (options.runnerType || 'digitalocean').toLowerCase();

  const isKnownRunner = Boolean(HOURLY_RATES[runnerType]);
  const rateConfig = HOURLY_RATES[runnerType] || HOURLY_RATES.digitalocean;
  const runnerName = RUNNER_NAMES[runnerType] || `Managed Runner (${runnerType})`;

  // Minimum billable time: 1000ms (1 second)
  const billableSeconds = durationMs > 0 ? Math.max(1, durationMs / 1000) : 0;
  const ramGb = memoryMb / 1024;
  const perSecondRate = (vcpus * rateConfig.vcpuRatePerSec) + (ramGb * rateConfig.ramGbRatePerSec);
  const rawCost = billableSeconds * perSecondRate;

  // Round to 6 decimal places
  const costUsd = Math.round(rawCost * 1000000) / 1000000;
  const rateHourlyUsd = Math.round(perSecondRate * 3600 * 10000) / 10000;

  return {
    runnerType,
    runnerName,
    durationMs,
    vcpus,
    memoryMb,
    costUsd,
    formattedCost: formatCostUsd(costUsd),
    formattedRuntime: formatDuration(durationMs),
    rateHourlyUsd,
    baseHourlyUsd: BASE_HOURLY_RATES[runnerType] || rateHourlyUsd,
    usedFallbackRate: !isKnownRunner,
  };
}

/**
 * Formats the runner cost details as a clean Markdown section for Review Yeti PR comments and reviews.
 */
export function formatRunnerCostMarkdown(cost: RunnerCostDetails): string {
  return `### 💰 Managed Runner Execution & Cost
- **Runner:** ${cost.runnerName} (${cost.vcpus} vCPU / ${cost.memoryMb} MB)
- **Total Runtime:** ${cost.formattedRuntime}
- **Runner Cost:** **${cost.formattedCost}** ($${cost.rateHourlyUsd.toFixed(4)}/hr active compute rate)`;
}
