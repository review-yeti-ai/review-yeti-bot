'use client';

import React, { useState, useEffect, useMemo, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSSE } from '@/lib/useSSE';
import { ReviewStageStepper } from '@/components/live/review-stage-stepper';
import { LiveTurnTimeline } from '@/components/live/live-turn-timeline';
import { TerminalFeed } from '@/components/live/terminal-feed';
import { SwarmTaskMatrix, SwarmTaskItem, ContextCompactionMetrics } from '@/components/live/SwarmTaskMatrix';
import { SwarmTaskTabs } from '@/components/live/SwarmTaskTabs';
import { StreamingMetricsCharts } from '@/components/live/streaming-metrics-charts';
import { ActiveJobsSidebar } from '@/components/live/active-jobs-sidebar';
import { DiffViewer } from '@/components/live/diff-viewer';
import { ReasoningFeed } from '@/components/live/reasoning-feed';
import { ToolFeed } from '@/components/live/tool-feed';
import { LiveSwarmTopologyCanvas } from '@/components/live/LiveSwarmTopologyCanvas';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { StatusBadge, StatusType } from '@/components/layout/status-badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Radio, RefreshCw, Play, FileCode, Brain, Terminal, Layers, RotateCcw, Loader2, Scissors, ShieldCheck, Activity, Cpu, CheckCircle2, Network, Zap } from 'lucide-react';
import { ChangedFileDiff, AnchoredFinding } from '@/types/diff';
import { VerdictOverrideControls } from '@/components/dashboard/verdict-override-controls';
import { PromptGuidanceCard } from '@/components/live/prompt-guidance-card';
import {
  dismissFinding,
  adjustFindingSeverity,
  submitPromptGuidance,
  fetchPromptGuidance,
} from '@/lib/api-client';
import type { PromptGuidanceItem, VerdictOverrideRecord } from '@/types/hitl';

function LiveStreamContent() {
  const searchParams = useSearchParams();
  const initialJobId = searchParams?.get('jobId') || 'run_live_reviewyeti_pr1282';
  const initialToken = searchParams?.get('token') || searchParams?.get('access_token') || undefined;

  const {
    connectionStatus,
    jobId,
    setJobId,
    events,
    selectedPersona,
    setSelectedPersona,
    filteredEvents,
    personaProgress,
    tokenMetrics,
    tokenHistory,
    clearEvents,
    reconnect,
    activeJobs,
    fetchActiveJobs,
    reasoning,
    toolExecutions,
    anchoredFindings,
    swarmTasks: liveSwarmTasks,
    contextCompaction: liveCompaction,
    currentStage,
    stageHistory,
    overallProgress,
    turns,
    activeTurnByTask,
  } = useSSE({
    jobId: initialJobId,
    token: initialToken,
    autoConnect: true,
  });

  const [inputJobId, setInputJobId] = useState(initialJobId);
  const [diffFiles, setDiffFiles] = useState<ChangedFileDiff[]>([]);
  const [diffFindings, setDiffFindings] = useState<AnchoredFinding[]>([]);
  const [diffLoading, setDiffLoading] = useState<boolean>(false);
  const [dismissedMap, setDismissedMap] = useState<Record<string, string>>({});
  const [severityOverrideMap, setSeverityOverrideMap] = useState<Record<string, 'P0' | 'P1' | 'P2'>>({});
  const [guidanceList, setGuidanceList] = useState<PromptGuidanceItem[]>([]);
  const [overrideRecord, setOverrideRecord] = useState<VerdictOverrideRecord | null>(null);
  const [isTriggering, setIsTriggering] = useState<boolean>(false);
  const [selectedPr, setSelectedPr] = useState<number>(1282);
  const [showTelemetryCharts, setShowTelemetryCharts] = useState<boolean>(false);
  const [showTopologyPreview, setShowTopologyPreview] = useState<boolean>(false);

  const handleTriggerLiveReview = async (prNumberToRun?: number) => {
    const targetPr = typeof prNumberToRun === 'number' ? prNumberToRun : selectedPr;
    try {
      setIsTriggering(true);
      const newJobId = `run_live_pr${targetPr}_${Date.now()}`;
      setInputJobId(newJobId);
      setJobId(newJobId);
      clearEvents();

      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href);
        url.searchParams.set('jobId', newJobId);
        window.history.pushState({}, '', url.toString());
      }

      const res = await fetch('/api/live/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: newJobId,
          repo: 'reviewyeti-ai/yeti-pr-reviewer',
          prNumber: targetPr,
        }),
      });

      if (!res.ok) {
        await fetch('/api/dashboard/trigger-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId: newJobId,
            repo: 'reviewyeti-ai/yeti-pr-reviewer',
            prNumber: targetPr,
          }),
        });
      }
    } catch (err) {
      console.error('Failed to trigger live review:', err);
    } finally {
      setIsTriggering(false);
    }
  };

  const currentActiveJob = activeJobs.find((j) => j.jobId === jobId);

  const swarmTasks: SwarmTaskItem[] = useMemo(() => {
    if (liveSwarmTasks && liveSwarmTasks.length > 0) {
      return liveSwarmTasks;
    }
    if ((currentActiveJob as any)?.tasks && Array.isArray((currentActiveJob as any).tasks)) {
      return (currentActiveJob as any).tasks;
    }
    return [
      {
        id: 'task_sec_boundary',
        dimension: 'security',
        description: 'Enforce security floor: secret redaction, credential scanning, and edge boundary fences',
        paths: ['src/gateway/edgeCompactionEngine.ts'],
        priority: 1,
        status: 'IN_FLIGHT',
        progress: 60,
        findingsCount: 0,
        lastMessage: 'Validating secret scanning, token redaction, and boundary fences...',
        durationMs: 1400,
      },
      {
        id: 'task_arch_compaction',
        dimension: 'architecture',
        description: 'Context compaction audit: verify AST outline depth and eliminate diff leakage across turns',
        paths: ['src/gateway/edgeCompactionEngine.ts', 'cf-orchestrator/src/worker.ts'],
        priority: 2,
        status: 'IN_FLIGHT',
        progress: 80,
        findingsCount: 1,
        lastMessage: 'Context compaction: 4.2x ratio achieved on unified diff',
        durationMs: 2800,
      },
      {
        id: 'task_perf_worker_budget',
        dimension: 'performance',
        description: 'Cloudflare Worker budget: CPU execution time and memory limits validation',
        paths: ['cf-orchestrator/src/worker.ts'],
        priority: 3,
        status: 'PENDING',
        progress: 0,
        findingsCount: 0,
        lastMessage: 'Queued for Worker CPU/memory budget verification',
        durationMs: 0,
      },
      {
        id: 'task_test_coverage',
        dimension: 'testing',
        description: 'Test coverage & invariant verification across Edge orchestrator routes',
        paths: ['cf-orchestrator/test/dashboardRoutes.test.ts'],
        priority: 4,
        status: 'PENDING',
        progress: 0,
        findingsCount: 0,
        lastMessage: 'Queued for route invariant verification',
        durationMs: 0,
      },
    ];
  }, [liveSwarmTasks, currentActiveJob]);

  const compactionMetrics: ContextCompactionMetrics = useMemo(() => {
    if (liveCompaction && (liveCompaction.rawDiffTokens > 0 || liveCompaction.compactedTokens > 0)) {
      return liveCompaction;
    }
    if ((currentActiveJob as any)?.contextCompaction) {
      return (currentActiveJob as any).contextCompaction;
    }
    return {
      rawDiffTokens: 24800,
      compactedTokens: 5900,
      compactionRatio: 4.2,
      boundsReductionLines: 1420,
      lockfilesBypassed: 1,
      astOutlineNodes: 18,
    };
  }, [liveCompaction, currentActiveJob]);

  useEffect(() => {
    if (!jobId) return;
    let active = true;
    fetchPromptGuidance(jobId)
      .then((items) => {
        if (active && items) {
          setGuidanceList(items);
        }
      })
      .catch((err) => {
        console.warn('Failed to fetch prompt guidance:', err);
      });
    return () => {
      active = false;
    };
  }, [jobId]);

  const handleAddGuidance = async (guidanceText: string, targetPersonas?: string[]) => {
    if (!jobId) return;
    const res = await submitPromptGuidance(jobId, guidanceText, targetPersonas);
    if (res.guidance) {
      setGuidanceList((prev) => [...prev, res.guidance]);
    }
  };

  useEffect(() => {
    if (jobId) {
      setInputJobId(jobId);
    }
  }, [jobId]);

  // Fetch diff & findings for active job
  useEffect(() => {
    if (!jobId) return;
    let active = true;
    setDiffLoading(true);

    fetch(`/api/live/diff?jobId=${encodeURIComponent(jobId)}`)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP error ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        if (!active) return;
        if (data && data.success) {
          setDiffFiles(data.files || []);
          setDiffFindings(data.findings || []);
        }
      })
      .catch((err) => {
        console.warn('Failed to fetch live diff:', err);
      })
      .finally(() => {
        if (active) {
          setDiffLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [jobId]);

  // Merge initial diff findings with live SSE streamed findings
  const combinedFindings = useMemo(() => {
    const map = new Map<string, AnchoredFinding>();
    for (const f of diffFindings) {
      map.set(f.id, f);
    }
    for (const f of anchoredFindings) {
      map.set(f.id, f);
    }
    return Array.from(map.values());
  }, [diffFindings, anchoredFindings]);

  // Apply HITL overrides (dismissals and severity changes)
  const effectiveFindings = useMemo(() => {
    return combinedFindings.map((f) => {
      const isDismissed = Boolean(dismissedMap[f.id]);
      const severity = severityOverrideMap[f.id] || f.severity;
      return {
        ...f,
        status: isDismissed ? ('dismissed' as const) : f.status,
        dismissedReason: dismissedMap[f.id] || f.dismissedReason,
        severity,
      };
    });
  }, [combinedFindings, dismissedMap, severityOverrideMap]);

  const handleDismissFinding = (findingId: string, reason: string) => {
    setDismissedMap((prev) => ({ ...prev, [findingId]: reason }));
    if (jobId) {
      dismissFinding(jobId, findingId, reason).catch((err) => {
        console.warn('Failed to persist finding dismissal:', err);
      });
    }
  };

  const handleAdjustSeverity = (findingId: string, newSeverity: 'P0' | 'P1' | 'P2') => {
    setSeverityOverrideMap((prev) => ({ ...prev, [findingId]: newSeverity }));
    if (jobId) {
      adjustFindingSeverity(jobId, findingId, newSeverity).catch((err) => {
        console.warn('Failed to persist severity adjustment:', err);
      });
    }
  };

  const handleConnectJob = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputJobId.trim()) {
      const newJob = inputJobId.trim();
      clearEvents();
      setJobId(newJob);
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href);
        url.searchParams.set('jobId', newJob);
        window.history.pushState({}, '', url.toString());
      }
    }
  };

  const handleSelectJob = (newJob: string) => {
    clearEvents();
    setJobId(newJob);
    setInputJobId(newJob);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('jobId', newJob);
      window.history.pushState({}, '', url.toString());
    }
  };

  const getStatusBadgeType = (): StatusType => {
    switch (connectionStatus) {
      case 'connected':
        return 'live';
      case 'connecting':
      case 'reconnecting':
        return 'busy';
      case 'disconnected':
      default:
        return 'offline';
    }
  };

  return (
    <div className="space-y-4 pb-12">
      {/* Top Live Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-2.5 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <span className="status-dot-green" />
          <h2 className="text-xs sm:text-sm font-semibold tracking-tight text-zinc-100 font-mono flex items-center gap-2 uppercase">
            <Radio className="h-3.5 w-3.5 text-emerald-400 animate-pulse" />
            Live Swarm Command Center
          </h2>
          <span className="linear-kbd text-[10px] text-zinc-400 font-mono">
            reviewyeti-ai
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div id="connection-status">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-white/[0.03] border border-white/[0.08] text-xs font-mono">
              <span
                className={
                  connectionStatus === 'connected'
                    ? 'h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]'
                    : connectionStatus === 'connecting' || connectionStatus === 'reconnecting'
                    ? 'h-2 w-2 rounded-full bg-indigo-400 animate-pulse'
                    : 'h-2 w-2 rounded-full bg-rose-500'
                }
              />
              <span className="text-zinc-200 text-xs">
                {connectionStatus === 'connected'
                  ? 'Streaming Live'
                  : connectionStatus === 'reconnecting'
                  ? 'Reconnecting...'
                  : connectionStatus === 'connecting'
                  ? 'Connecting...'
                  : 'Disconnected'}
              </span>
            </div>
          </div>

          <Button
            size="sm"
            onClick={() => handleTriggerLiveReview()}
            disabled={isTriggering}
            className="h-7 text-xs bg-indigo-600 hover:bg-indigo-500 text-white font-medium gap-1.5 shadow-sm shadow-indigo-500/20"
            data-testid="trigger-live-review-btn"
          >
            <Play className={`h-3 w-3 ${isTriggering ? 'animate-spin' : ''}`} />
            <span>{isTriggering ? 'Triggering...' : 'Trigger Live Review'}</span>
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={reconnect}
            className="h-7 text-xs border-white/[0.08] bg-white/[0.03] text-zinc-300 hover:text-white hover:bg-white/[0.06]"
          >
            <RefreshCw className="h-3 w-3 mr-1" />
            Reconnect
          </Button>
        </div>
      </div>

      {/* Real-time 6-Stage Autonomous Review Lifecycle Stepper */}
      <ReviewStageStepper
        currentStage={currentStage}
        stages={stageHistory}
        overallProgress={overallProgress}
      />

      {/* Vibe Coder Action & Quick PR Selector Bar */}
      <div className="linear-card p-3.5 border border-white/[0.08] bg-[#08090c] rounded-xl space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Quick Preset PR Pills */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-mono text-zinc-400 font-semibold uppercase tracking-wider mr-1">
              Select Target PR:
            </span>
            {[
              { num: 1282, label: 'PR #1282: Edge Compaction' },
              { num: 1283, label: 'PR #1283: Security Fences' },
              { num: 1284, label: 'PR #1284: Worker Budget' },
            ].map((pr) => {
              const isSelected = selectedPr === pr.num;
              return (
                <button
                  key={pr.num}
                  type="button"
                  onClick={() => {
                    setSelectedPr(pr.num);
                    handleTriggerLiveReview(pr.num);
                  }}
                  className={`text-xs px-3 py-1.5 rounded-lg border font-mono transition-all ${
                    isSelected
                      ? 'bg-indigo-600/20 border-indigo-500/60 text-indigo-300 font-medium shadow-[0_0_12px_rgba(99,102,241,0.25)]'
                      : 'bg-white/[0.03] border-white/[0.08] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06]'
                  }`}
                  data-testid={`pr-preset-pill-${pr.num}`}
                >
                  {pr.label}
                </button>
              );
            })}
          </div>

          {/* Primary Action Button */}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => handleTriggerLiveReview(selectedPr)}
              disabled={isTriggering}
              className={`h-8 px-4 text-xs font-semibold gap-2 shadow-lg transition-all ${
                overallProgress > 0 && overallProgress < 100
                  ? 'bg-indigo-600/90 hover:bg-indigo-600 text-white shadow-indigo-500/25 ring-1 ring-indigo-400/40 animate-pulse'
                  : overallProgress >= 100 || currentStage === 'complete'
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-500/20'
                  : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-500/30'
              }`}
              data-testid="trigger-live-review-btn-actionbar"
            >
              {isTriggering || (overallProgress > 0 && overallProgress < 100) ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>
                    Review Rolling: {currentStage.toUpperCase()} ({Math.round(overallProgress)}%)
                  </span>
                </>
              ) : overallProgress >= 100 || currentStage === 'complete' ? (
                <>
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Re-run Live Review (PR #{selectedPr})</span>
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5 fill-current" />
                  <span>Run Live Review (PR #{selectedPr})</span>
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Stream Target Job Selector (Preserved for Custom Job IDs and Automated Test Harnesses) */}
        <form onSubmit={handleConnectJob} className="flex flex-wrap items-center gap-2 pt-2.5 border-t border-white/[0.05] text-xs">
          <span className="font-semibold text-zinc-300 shrink-0 font-mono text-[11px]">Active Job Stream:</span>
          <Input
            type="text"
            placeholder="Enter Job ID (e.g. run_live_reviewyeti_pr1282)"
            value={inputJobId}
            onChange={(e) => setInputJobId(e.target.value)}
            className="h-7 w-full sm:w-72 text-xs font-mono bg-[#050608] border-white/[0.08] focus:border-indigo-500 text-zinc-200"
          />
          <Button size="sm" type="submit" className="h-7 text-xs bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200 border border-white/[0.08] gap-1.5 px-3">
            <Play className="h-3 w-3" />
            <span>Switch Stream</span>
          </Button>
        </form>
      </div>

      {/* Sleek Live Review HUD Strip (Review-First, Clutter-Free) */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2 bg-[#08090d]/90 border border-white/[0.08] rounded-xl text-xs font-mono shadow-sm">
        <div className="flex flex-wrap items-center gap-3 text-zinc-300">
          <div className="flex items-center gap-1.5 text-zinc-200 font-semibold" data-testid="hud-tokens-meter">
            <Activity className="h-3.5 w-3.5 text-amber-400" />
            <span>Tokens:</span>
            <span className="text-zinc-100 font-mono">{tokenMetrics.totalTokens.toLocaleString()}</span>
            {tokenMetrics.tokensPerSec ? (
              <span className="text-[11px] text-cyan-400 font-mono">({tokenMetrics.tokensPerSec} t/s)</span>
            ) : null}
          </div>

          <span className="text-zinc-700 hidden sm:inline">•</span>

          <div className="flex items-center gap-1.5 text-zinc-200 font-semibold" data-testid="hud-budget-meter">
            <Zap className="h-3.5 w-3.5 text-emerald-400" />
            <span>Budget:</span>
            <span className="text-emerald-300 font-mono">${tokenMetrics.estimatedCostUSD.toFixed(4)}</span>
            <span className="text-[11px] text-zinc-500 font-mono hidden sm:inline">
              / $0.0500 ({Math.min(100, Math.round((tokenMetrics.estimatedCostUSD / 0.0500) * 100))}%)
            </span>
          </div>

          <span className="text-zinc-700 hidden sm:inline">•</span>

          <div className="flex items-center gap-1.5 text-zinc-200">
            <Scissors className="h-3.5 w-3.5 text-cyan-400" />
            <span>Compaction:</span>
            <span className="text-cyan-300 font-semibold font-mono">{compactionMetrics.compactionRatio}x</span>
            <span className="text-[11px] text-zinc-500 hidden md:inline">({compactionMetrics.boundsReductionLines} lines saved)</span>
          </div>

          <span className="text-zinc-700 hidden sm:inline">•</span>

          <div className="flex items-center gap-1.5 text-zinc-200">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
            <span>Findings:</span>
            <span className={`font-semibold font-mono ${effectiveFindings.length > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
              {effectiveFindings.length}
            </span>
          </div>

          <span className="text-zinc-700 hidden sm:inline">•</span>

          <div className="flex items-center gap-1.5 text-zinc-300">
            <Cpu className="h-3.5 w-3.5 text-indigo-400" />
            <span>Swarm:</span>
            <span className="text-zinc-200 font-mono font-medium">{swarmTasks.length} Subagents</span>
          </div>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => setShowTopologyPreview(!showTopologyPreview)}
            className="h-7 text-xs font-mono text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.05] border border-white/[0.06] px-2.5 gap-1.5"
            data-testid="toggle-topology-preview-btn"
          >
            <Network className="h-3 w-3 text-cyan-400" />
            <span>{showTopologyPreview ? 'Hide Topology Mesh ▴' : 'Show Topology Mesh ▾'}</span>
          </Button>

          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => setShowTelemetryCharts(!showTelemetryCharts)}
            className="h-7 text-xs font-mono text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.05] border border-white/[0.06] px-2.5 gap-1.5"
          >
            <Activity className="h-3 w-3 text-indigo-400" />
            <span>{showTelemetryCharts ? 'Hide Telemetry Charts ▴' : 'Show Telemetry Charts ▾'}</span>
          </Button>
        </div>
      </div>

      {/* Expandable Live Swarm & Infrastructure Topology Preview */}
      {showTopologyPreview && (
        <div className="animate-in fade-in duration-200">
          <LiveSwarmTopologyCanvas
            jobId={jobId}
            swarmTasks={swarmTasks}
            compaction={compactionMetrics}
            tokenMetrics={tokenMetrics}
            currentStage={currentStage}
            connectionStatus={connectionStatus}
            onSelectAgentTask={setSelectedPersona}
          />
        </div>
      )}

      {/* Expandable Deep-Dive Telemetry Curves */}
      {showTelemetryCharts && (
        <div className="p-4 bg-[#08090d]/60 border border-white/[0.08] rounded-xl space-y-3 animate-in fade-in duration-200">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-zinc-400 uppercase tracking-wider font-semibold">
              Real-time Token Burn & LLM Latency Curves
            </span>
            <span className="text-[11px] font-mono text-zinc-500">Live SSE Feed</span>
          </div>
          <StreamingMetricsCharts metrics={tokenMetrics} history={tokenHistory} />
        </div>
      )}

      {/* Main Stream Explorer Workspace: Active Jobs Sidebar + Inspector Tabs */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <ActiveJobsSidebar
          currentJobId={jobId}
          onSelectJob={handleSelectJob}
          activeJobs={activeJobs}
          onRefresh={fetchActiveJobs}
          className="lg:col-span-1"
        />

        <div className="lg:col-span-3 space-y-4">
          {/* Swarm Task Branch Filter Tabs */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider font-mono">
                Swarm Task Branch Filter
              </h3>
              <span className="text-[11px] font-mono text-zinc-500">
                Filter reasoning traces and tool activity by subagent task
              </span>
            </div>
            <SwarmTaskTabs
              selectedTaskId={selectedPersona}
              onSelectTask={setSelectedPersona}
              tasks={swarmTasks}
            />
          </div>

          {/* Primary View Switcher Tabs: Diff & Findings | Swarm Tasks | Reasoning & Tools | Raw Terminal | Turns */}
          <Tabs defaultValue="diff" className="w-full">
            <div className="flex items-center justify-between pb-1">
              <TabsList className="bg-[#050608] border border-white/[0.08] p-1 h-9 rounded-lg">
                <TabsTrigger
                  value="diff"
                  className="gap-1.5 text-xs data-[state=active]:bg-white/[0.08] data-[state=active]:text-white data-[state=active]:shadow-none"
                >
                  <FileCode className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Diff & Findings</span>
                  {effectiveFindings.length > 0 && (
                    <span className="ml-1 text-[10px] font-mono px-1.5 py-0.2 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30">
                      {effectiveFindings.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger
                  value="mesh"
                  className="gap-1.5 text-xs data-[state=active]:bg-white/[0.08] data-[state=active]:text-white data-[state=active]:shadow-none"
                  data-testid="swarm-mesh-tab-trigger"
                >
                  <Network className="h-3.5 w-3.5 text-cyan-400" />
                  <span>Swarm & Infra Mesh</span>
                  <span className="ml-1 text-[10px] font-mono px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                    Live
                  </span>
                </TabsTrigger>
                <TabsTrigger
                  value="tasks"
                  className="gap-1.5 text-xs data-[state=active]:bg-white/[0.08] data-[state=active]:text-white data-[state=active]:shadow-none"
                  data-testid="swarm-tasks-tab-trigger"
                >
                  <Cpu className="h-3.5 w-3.5 text-violet-400" />
                  <span>Swarm Tasks</span>
                  <span className="ml-1 text-[10px] font-mono px-1.5 py-0.2 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">
                    {swarmTasks.length}
                  </span>
                </TabsTrigger>
                <TabsTrigger
                  value="reasoning"
                  className="gap-1.5 text-xs data-[state=active]:bg-white/[0.08] data-[state=active]:text-white data-[state=active]:shadow-none"
                >
                  <Brain className="h-3.5 w-3.5 text-cyan-400" />
                  <span>Reasoning & Tools</span>
                  {toolExecutions.length > 0 && (
                    <span className="ml-1 text-[10px] font-mono px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                      {toolExecutions.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger
                  value="terminal"
                  className="gap-1.5 text-xs data-[state=active]:bg-white/[0.08] data-[state=active]:text-white data-[state=active]:shadow-none"
                >
                  <Terminal className="h-3.5 w-3.5 text-indigo-400" />
                  <span>Raw Terminal</span>
                  {events.length > 0 && (
                    <span className="ml-1 text-[10px] font-mono px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                      {events.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger
                  value="turns"
                  className="gap-1.5 text-xs data-[state=active]:bg-white/[0.08] data-[state=active]:text-white data-[state=active]:shadow-none"
                  data-testid="turns-tab-trigger"
                >
                  <Layers className="h-3.5 w-3.5 text-indigo-400" />
                  <span>Turns & Execution</span>
                  {turns.length > 0 && (
                    <span className="ml-1 text-[10px] font-mono px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                      {turns.length}
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>
            </div>

            {/* Tab 1: Diff & Line-Anchored Findings + HITL Controls */}
            <TabsContent value="diff" className="mt-3 space-y-4">
              {jobId && (
                <VerdictOverrideControls
                  reviewId={jobId}
                  currentVerdict="SHIP"
                  existingOverride={overrideRecord}
                  onOverrideSuccess={(record: any) => setOverrideRecord(record)}
                />
              )}
              <DiffViewer
                jobId={jobId}
                files={diffFiles}
                findings={effectiveFindings}
                selectedPersona={selectedPersona}
                loading={diffLoading}
                onDismissFinding={handleDismissFinding}
                onAdjustSeverity={handleAdjustSeverity}
              />
            </TabsContent>

            {/* Tab: Real-Time Live Swarm & Infrastructure Topology Mesh */}
            <TabsContent value="mesh" className="mt-3 space-y-4">
              <LiveSwarmTopologyCanvas
                jobId={jobId}
                swarmTasks={swarmTasks}
                compaction={compactionMetrics}
                tokenMetrics={tokenMetrics}
                currentStage={currentStage}
                connectionStatus={connectionStatus}
                onSelectAgentTask={setSelectedPersona}
              />
            </TabsContent>

            {/* Tab 2: Composed Swarm Review Task Execution Matrix */}
            <TabsContent value="tasks" className="mt-3 space-y-4">
              <SwarmTaskMatrix
                tasks={swarmTasks}
                compaction={compactionMetrics}
                selectedTaskId={selectedPersona}
                onSelectTask={(p) => setSelectedPersona(p)}
                activeTurnByTask={activeTurnByTask}
              />
            </TabsContent>

            {/* Tab 3: Streaming Reasoning Traces, Subagent Tools & Prompt Steering */}
            <TabsContent value="reasoning" className="mt-3 space-y-4">
              <div id="inspector-prompt" className="space-y-2">
                <PromptGuidanceCard
                  reviewId={jobId || ''}
                  guidanceList={guidanceList}
                  onAddGuidance={handleAddGuidance}
                />
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <ReasoningFeed
                  events={filteredEvents}
                  reasoning={reasoning}
                  selectedPersona={selectedPersona}
                />
                <ToolFeed
                  events={filteredEvents}
                  toolExecutions={toolExecutions}
                  selectedPersona={selectedPersona}
                />
              </div>
            </TabsContent>

            {/* Tab 4: Monospace Glass Terminal Feed */}
            <TabsContent value="terminal" className="mt-3">
              <TerminalFeed
                events={filteredEvents}
                selectedPersona={selectedPersona}
                onClear={clearEvents}
              />
            </TabsContent>

            {/* Tab 5: Granular Subagent Turn Execution Timeline */}
            <TabsContent value="turns" className="mt-3">
              <LiveTurnTimeline
                turns={turns}
                selectedTaskId={selectedPersona}
                onSelectTask={setSelectedPersona}
                activeTurnByTask={activeTurnByTask}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

export function LiveDashboardView() {
  return (
    <Suspense
      fallback={
        <div className="p-8 text-center text-zinc-400 font-mono text-xs space-y-4">
          <div className="flex items-center justify-center gap-2 text-zinc-100 font-semibold text-sm">
            <Radio className="h-4 w-4 text-emerald-400 animate-pulse" />
            Review Yeti AI Swarm — Live Command Center
          </div>
          <p className="text-[11px] text-zinc-500 font-mono">
            Connecting to Cloudflare Edge Swarm SSE Stream...
          </p>
          <div className="animate-pulse space-y-3 max-w-4xl mx-auto pt-4">
            <div className="h-28 bg-[#0d0e12]/80 border border-white/[0.06] rounded-xl" />
            <div className="h-64 bg-[#0d0e12]/80 border border-white/[0.06] rounded-xl" />
          </div>
        </div>
      }
    >
      <LiveStreamContent />
    </Suspense>
  );
}

export default LiveDashboardView;
