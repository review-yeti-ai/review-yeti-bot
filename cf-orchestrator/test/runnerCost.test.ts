import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRunnerCost,
  formatCostUsd,
  formatDuration,
  formatRunnerCostMarkdown,
} from '../src/runners/runnerCost.js';

describe('Runner Cost & Runtime Calculation Suite', () => {
  describe('formatDuration', () => {
    it('formats millisecond durations under 1 second', () => {
      assert.equal(formatDuration(450), '450 ms');
      assert.equal(formatDuration(0), '0 ms');
    });

    it('formats second durations under 1 minute', () => {
      assert.equal(formatDuration(24800), '24.8s (24,800 ms)');
      assert.equal(formatDuration(1000), '1.0s (1,000 ms)');
    });

    it('formats durations spanning minutes and seconds', () => {
      assert.equal(formatDuration(65400), '1m 5.4s (65,400 ms)');
      assert.equal(formatDuration(148200), '2m 28.2s (148,200 ms)');
    });
  });

  describe('formatCostUsd', () => {
    it('formats zero cost', () => {
      assert.equal(formatCostUsd(0), '$0.00 USD');
    });

    it('formats sub-cent amounts with 6 decimal precision', () => {
      assert.equal(formatCostUsd(0.000446), '$0.000446 USD');
      assert.equal(formatCostUsd(0.000018), '$0.000018 USD');
    });

    it('formats standard amounts with 4 decimal precision', () => {
      assert.equal(formatCostUsd(0.054), '$0.0540 USD');
      assert.equal(formatCostUsd(1.2345), '$1.2345 USD');
    });
  });

  describe('calculateRunnerCost - DigitalOcean Managed Agents', () => {
    it('calculates cost accurately for typical 24.8s PR review session', () => {
      // 24.8 seconds * (2 vCPU * 0.000008 + 2GB * 0.000001 = 0.000018/sec)
      // 24.8 * 0.000018 = 0.0004464 USD
      const result = calculateRunnerCost({
        durationMs: 24800,
        vcpus: 2,
        memoryMb: 2048,
        runnerType: 'digitalocean',
      });

      assert.equal(result.runnerType, 'digitalocean');
      assert.equal(result.runnerName, 'DigitalOcean Managed Agents (Firecracker microVM)');
      assert.equal(result.durationMs, 24800);
      assert.equal(result.vcpus, 2);
      assert.equal(result.memoryMb, 2048);
      assert.equal(result.costUsd, 0.000446);
      assert.equal(result.formattedCost, '$0.000446 USD');
      assert.equal(result.formattedRuntime, '24.8s (24,800 ms)');
      assert.equal(result.rateHourlyUsd, 0.0648);
    });

    it('enforces 1-second minimum billing resolution for sub-second bursts', () => {
      const result = calculateRunnerCost({
        durationMs: 350,
        runnerType: 'digitalocean',
      });

      // Billed as 1 second minimum = 1 * 0.000018 = 0.000018 USD
      assert.equal(result.costUsd, 0.000018);
      assert.equal(result.formattedRuntime, '350 ms');
    });

    it('returns $0.00 USD for duration 0ms', () => {
      const result = calculateRunnerCost({
        durationMs: 0,
        runnerType: 'digitalocean',
      });

      assert.equal(result.costUsd, 0);
      assert.equal(result.formattedCost, '$0.00 USD');
    });
  });

  describe('calculateRunnerCost - Cloudflare Containers', () => {
    it('calculates cost for Cloudflare Containers active compute tier', () => {
      // 2 vCPU * 0.0000065 + 2GB * 0.000001 = 0.000015/sec = $0.054/hr
      const result = calculateRunnerCost({
        durationMs: 30000, // 30s
        vcpus: 2,
        memoryMb: 2048,
        runnerType: 'cloudflare',
      });

      assert.equal(result.runnerType, 'cloudflare');
      assert.equal(result.runnerName, 'Cloudflare Containers (Edge OCI Sandbox)');
      assert.equal(result.costUsd, 0.00045);
      assert.equal(result.rateHourlyUsd, 0.054);
    });
  });

  describe('formatRunnerCostMarkdown', () => {
    it('renders clean markdown summary item with compute specs, total runtime, and cost', () => {
      const cost = calculateRunnerCost({
        durationMs: 24800,
        vcpus: 2,
        memoryMb: 2048,
        runnerType: 'digitalocean',
      });

      const md = formatRunnerCostMarkdown(cost);
      assert.ok(md.includes('### 💰 Managed Runner Execution & Cost'));
      assert.ok(md.includes('**Runner:** DigitalOcean Managed Agents (Firecracker microVM) (2 vCPU / 2048 MB)'));
      assert.ok(md.includes('**Total Runtime:** 24.8s (24,800 ms)'));
      assert.ok(md.includes('**Runner Cost:** **$0.000446 USD** ($0.0648/hr active compute rate)'));
    });
  });
});
