'use client';

import * as React from 'react';
import { ReviewJob } from '@/types/dashboard';
import {
  X,
  ExternalLink,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  Layers,
  Copy,
  Check,
  Terminal,
  FileCode,
} from 'lucide-react';
import { formatRelativeTime } from '@/lib/utils';

interface ReviewSlideoverInspectorProps {
  job: ReviewJob | null;
  onClose: () => void;
}

export function ReviewSlideoverInspector({ job, onClose }: ReviewSlideoverInspectorProps) {
  const [activeTab, setActiveTab] = React.useState<'findings' | 'reasoning' | 'receipt'>('findings');
  const [copied, setCopied] = React.useState(false);

  // Close on Escape key
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!job) return null;

  const isShip = job.verdict === 'SHIP';
  const isBlock = job.verdict === 'NACK' || (job.verdict as string) === 'BLOCK';

  const copyReceipt = () => {
    navigator.clipboard.writeText(JSON.stringify(job, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
      />

      {/* Slide-over Drawer Panel */}
      <div className="relative z-50 flex h-full w-full max-w-2xl flex-col border-l border-white/[0.08] bg-[#0c0d11] text-zinc-100 shadow-2xl shadow-black/80 animate-in slide-in-from-right duration-200">
        {/* Drawer Header */}
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4 bg-[#0a0b0e]">
          <div className="flex items-center gap-3 min-w-0">
            {isShip ? (
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
              </span>
            ) : isBlock ? (
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-rose-500/15 text-rose-400">
                <AlertTriangle className="h-4 w-4" />
              </span>
            ) : (
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-500/15 text-indigo-400 animate-pulse">
                <Clock className="h-4 w-4" />
              </span>
            )}
            <div className="truncate">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-semibold text-indigo-400">
                  {job.repo} #{job.prNumber}
                </span>
                <span className="px-1.5 py-0.2 rounded text-[10px] font-mono border border-white/[0.08] bg-white/[0.04] text-zinc-400">
                  {job.headSha || 'head'}
                </span>
              </div>
              <h2 className="text-sm font-semibold text-zinc-100 truncate">
                {job.title}
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <a
              href={`https://github.com/${job.repo}/pull/${job.prNumber}`}
              target="_blank"
              rel="noreferrer"
              className="flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.02] text-zinc-400 hover:text-white hover:bg-white/[0.06]"
              title="View on GitHub"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.02] text-zinc-400 hover:text-white hover:bg-white/[0.06]"
              title="Close (Esc)"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Linear Sub-Tabs */}
        <div className="flex items-center gap-1 border-b border-white/[0.06] px-5 py-2 bg-[#090a0d]">
          <button
            onClick={() => setActiveTab('findings')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              activeTab === 'findings'
                ? 'bg-white/[0.08] text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.03]'
            }`}
          >
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
            <span>Findings Matrix</span>
            <span className="ml-1 px-1 rounded bg-white/[0.06] text-[10px] font-mono text-zinc-300">
              {job.findingsDelta?.newFindings || 0}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('reasoning')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              activeTab === 'reasoning'
                ? 'bg-white/[0.08] text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.03]'
            }`}
          >
            <Cpu className="h-3.5 w-3.5 text-indigo-400" />
            <span>Swarm Reasoning</span>
          </button>

          <button
            onClick={() => setActiveTab('receipt')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              activeTab === 'receipt'
                ? 'bg-white/[0.08] text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.03]'
            }`}
          >
            <Terminal className="h-3.5 w-3.5 text-amber-400" />
            <span>DO State & Receipt</span>
          </button>
        </div>

        {/* Drawer Body Scroll Container */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Key Metrics Strip */}
          <div className="grid grid-cols-4 gap-2 p-3 rounded-lg border border-white/[0.06] bg-white/[0.02]">
            <div>
              <div className="text-[10px] font-mono uppercase text-zinc-500">Verdict</div>
              <div className={`text-xs font-bold font-mono mt-0.5 ${isShip ? 'text-emerald-400' : isBlock ? 'text-rose-400' : 'text-amber-400'}`}>
                {job.verdict}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase text-zinc-500">Latency</div>
              <div className="text-xs font-mono font-semibold text-zinc-200 mt-0.5">
                {((job.latencyMs || 0) / 1000).toFixed(1)}s
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase text-zinc-500">Tokens</div>
              <div className="text-xs font-mono font-semibold text-zinc-200 mt-0.5">
                {(job.tokens || 0).toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase text-zinc-500">Cost</div>
              <div className="text-xs font-mono font-semibold text-zinc-200 mt-0.5">
                ${(job.cost || 0).toFixed(4)}
              </div>
            </div>
          </div>

          {/* Tab 1: Findings Matrix */}
          {activeTab === 'findings' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-zinc-400 font-mono">
                <span>Active Swarm Rules & Findings</span>
                <span>Gate: 0 P0 Tolerance</span>
              </div>

              {/* Sample Grounded Finding Card */}
              <div className="p-4 rounded-lg border border-white/[0.08] bg-[#0f1015] space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold font-mono bg-rose-500/15 text-rose-400 border border-rose-500/30">
                      P0 Blocker
                    </span>
                    <span className="text-xs font-mono text-zinc-300">
                      concurrency.fencing.lease_epoch_validation
                    </span>
                  </div>
                  <span className="text-[11px] font-mono text-zinc-500">line 142</span>
                </div>
                <p className="text-xs text-zinc-300 leading-relaxed">
                  Worker heartbeat lease bump must validate that <code>fencingEpoch</code> strictly matches the current Durable Object state before persisting state.
                </p>
                <div className="p-2.5 rounded bg-black/50 border border-white/[0.04] font-mono text-[11px] text-zinc-400 overflow-x-auto">
                  <code>{`if (epoch !== this.runState.fencingEpoch) {\n  return { ok: false, reason: 'fencing_epoch_mismatch' };\n}`}</code>
                </div>
              </div>

              <div className="p-4 rounded-lg border border-white/[0.06] bg-[#0f1015] space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold font-mono bg-amber-500/15 text-amber-300 border border-amber-500/30">
                      P1 Architecture
                    </span>
                    <span className="text-xs font-mono text-zinc-300">
                      cache.lifecycle.sub_day_expiration
                    </span>
                  </div>
                  <span className="text-[11px] font-mono text-zinc-500">line 88</span>
                </div>
                <p className="text-xs text-zinc-300 leading-relaxed">
                  R2 workspace tarball cache must specify <code>CustomMetadata: &#123;&quot;ttl&quot;: &quot;86400&quot;&#125;</code> to allow aggressive 1-hour cron reaper sweeps.
                </p>
              </div>
            </div>
          )}

          {/* Tab 2: Swarm Reasoning Tree */}
          {activeTab === 'reasoning' && (
            <div className="space-y-3 font-mono text-xs">
              <div className="p-3.5 rounded-lg border border-white/[0.06] bg-[#0f1015] space-y-2">
                <div className="flex items-center justify-between text-indigo-400 font-semibold">
                  <span>1. Path-Scoped Context Compaction</span>
                  <span className="text-[10px] text-zinc-500">Completed (1.2s)</span>
                </div>
                <p className="text-zinc-400 text-[11px]">
                  Zoekt symbol graph isolated 4 modified source hunks. Raw diff evicted from context; summaries retained for persona subagents.
                </p>
              </div>

              <div className="p-3.5 rounded-lg border border-white/[0.06] bg-[#0f1015] space-y-2">
                <div className="flex items-center justify-between text-indigo-400 font-semibold">
                  <span>2. Parallel Subagent Swarm Execution</span>
                  <span className="text-[10px] text-zinc-500">Completed (14.8s)</span>
                </div>
                <div className="space-y-1 text-zinc-400 text-[11px]">
                  <div>• Security Guardian: Passed (0 credentials exposed)</div>
                  <div>• Concurrency Auditor: Passed (Fencing epoch validated)</div>
                  <div>• Performance Gate: Passed (Sub-1500ms unpack verified)</div>
                </div>
              </div>

              <div className="p-3.5 rounded-lg border border-white/[0.06] bg-[#0f1015] space-y-2">
                <div className="flex items-center justify-between text-emerald-400 font-semibold">
                  <span>3. Consensus & Verdict Arbitration</span>
                  <span className="text-[10px] text-zinc-500">Completed (0.4s)</span>
                </div>
                <p className="text-zinc-400 text-[11px]">
                  Consensus threshold achieved (4/4 subagents). Verdict: <strong>SHIP</strong>. GitHub check run attestation published.
                </p>
              </div>
            </div>
          )}

          {/* Tab 3: DO State & Receipt */}
          {activeTab === 'receipt' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-zinc-400">Durable Object State Receipt</span>
                <button
                  onClick={copyReceipt}
                  className="flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded bg-white/[0.05] border border-white/[0.08] text-zinc-300 hover:text-white"
                >
                  {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                  <span>{copied ? 'Copied' : 'Copy JSON'}</span>
                </button>
              </div>
              <pre className="p-3.5 rounded-lg bg-black/70 border border-white/[0.06] font-mono text-[11px] text-zinc-300 overflow-x-auto max-h-96">
                {JSON.stringify(job, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
