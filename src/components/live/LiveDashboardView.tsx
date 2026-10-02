'use client';

import React, { useState, useEffect, useMemo, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSSE } from '@/lib/useSSE';
import { TerminalFeed } from '@/components/live/terminal-feed';
import { PersonaTabs } from '@/components/live/persona-tabs';
import { PersonaProgressGrid } from '@/components/live/persona-progress-grid';
import { StreamingMetricsCharts } from '@/components/live/streaming-metrics-charts';
import { ActiveJobsSidebar } from '@/components/live/active-jobs-sidebar';
import { DiffViewer } from '@/components/live/diff-viewer';
import { ReasoningFeed } from '@/components/live/reasoning-feed';
import { ToolFeed } from '@/components/live/tool-feed';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { StatusBadge, StatusType } from '@/components/layout/status-badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Radio, RefreshCw, Play, FileCode, Brain, Terminal } from 'lucide-react';
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
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-3 border-b border-white/[0.06]">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="status-dot-green" />
            <h1 className="text-xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
              <Radio className="h-4 w-4 text-emerald-400 animate-pulse" />
              Review Yeti — Live Agent Review Terminal
            </h1>
            <span className="linear-kbd text-[10px] text-zinc-400 font-mono">
              reviewyeti-ai
            </span>
          </div>
          <p className="text-xs text-zinc-400 font-mono">
            Real-time SSE multi-agent review stream, context compaction traces, and token metrics on Cloudflare Edge
          </p>
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
            variant="outline"
            onClick={reconnect}
            className="h-7 text-xs border-white/[0.08] bg-white/[0.03] text-zinc-300 hover:text-white hover:bg-white/[0.06]"
          >
            <RefreshCw className="h-3 w-3 mr-1" />
            Reconnect
          </Button>
        </div>
      </div>

      {/* Stream Target Job Selector */}
      <form onSubmit={handleConnectJob} className="linear-card flex flex-wrap items-center gap-3 p-3 text-xs">
        <span className="font-semibold text-zinc-300 shrink-0 font-mono">Active Job Stream:</span>
        <Input
          type="text"
          placeholder="Enter Job ID (e.g. run_live_reviewyeti_pr1282)"
          value={inputJobId}
          onChange={(e) => setInputJobId(e.target.value)}
          className="h-7 w-full sm:w-72 text-xs font-mono bg-[#050608] border-white/[0.08] focus:border-indigo-500 text-zinc-200"
        />
        <Button size="sm" type="submit" className="h-7 text-xs bg-indigo-600 hover:bg-indigo-500 text-white gap-1.5 px-3">
          <Play className="h-3 w-3" />
          <span>Switch Stream</span>
        </Button>
        <span className="text-[11px] text-zinc-500 font-mono ml-auto hidden md:inline">
          Endpoint: /api/live/stream?jobId={jobId}
        </span>
      </form>

      {/* Streaming Token Metrics Cards & Recharts */}
      <StreamingMetricsCharts metrics={tokenMetrics} history={tokenHistory} />

      {/* Human-in-the-Loop Verdict Override Controls */}
      {jobId && (
        <VerdictOverrideControls
          reviewId={jobId}
          currentVerdict="SHIP"
          existingOverride={overrideRecord}
          onOverrideSuccess={(record: any) => setOverrideRecord(record)}
        />
      )}

      {/* Persona Parallel Execution Progress Grid */}
      <PersonaProgressGrid
        personaProgress={personaProgress}
        onPersonaClick={(p) => setSelectedPersona(p)}
      />

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
          {/* Persona Tabs Navigation */}
          <div>
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Tabbed Persona Explorer
            </h3>
            <PersonaTabs
              selectedPersona={selectedPersona}
              onSelectPersona={setSelectedPersona}
              events={events}
              personaProgress={personaProgress}
            />
          </div>

          <div id="inspector-prompt" className="space-y-2">
            <PromptGuidanceCard
              reviewId={jobId || ''}
              guidanceList={guidanceList}
              onAddGuidance={handleAddGuidance}
            />
          </div>

          {/* Primary View Switcher Tabs: Diff & Findings | Reasoning & Tools | Raw Terminal */}
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
              </TabsList>
            </div>

            {/* Tab 1: Diff & Line-Anchored Findings */}
            <TabsContent value="diff" className="mt-3">
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

            {/* Tab 2: Streaming Reasoning Traces & Subagent Tools */}
            <TabsContent value="reasoning" className="mt-3 space-y-4">
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

            {/* Tab 3: Monospace Glass Terminal Feed */}
            <TabsContent value="terminal" className="mt-3">
              <TerminalFeed
                events={filteredEvents}
                selectedPersona={selectedPersona}
                onClear={clearEvents}
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
        <div className="p-8 text-center text-slate-400 font-mono text-xs space-y-4">
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center justify-center gap-2">
            ct-review-bot — Live Agent Review Terminal
          </h2>
          <PersonaProgressGrid personaProgress={{}} />
        </div>
      }
    >
      <LiveStreamContent />
    </Suspense>
  );
}

export default LiveDashboardView;
