'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSSE } from '@/lib/useSSE';
import { TerminalFeed } from '@/components/live/terminal-feed';
import { PersonaTabs } from '@/components/live/persona-tabs';
import { PersonaProgressGrid } from '@/components/live/persona-progress-grid';
import { StreamingMetricsCharts } from '@/components/live/streaming-metrics-charts';
import { ActiveJobsSidebar } from '@/components/live/active-jobs-sidebar';
import { StatusBadge, StatusType } from '@/components/layout/status-badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Radio, RefreshCw, Play } from 'lucide-react';

function LiveStreamContent() {
  const searchParams = useSearchParams();
  const initialJobId = searchParams?.get('jobId') || 'default-job';
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
  } = useSSE({
    jobId: initialJobId,
    token: initialToken,
    autoConnect: true,
  });

  const [inputJobId, setInputJobId] = useState(initialJobId);

  useEffect(() => {
    if (jobId) {
      setInputJobId(jobId);
    }
  }, [jobId]);

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
    <div className="space-y-6 pb-12">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-2 border-b border-white/10">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <Radio className="h-6 w-6 text-emerald-400 animate-pulse" />
            ct-review-bot — Live Agent Review Terminal
          </h2>
          <p className="text-sm text-slate-400">
            Real-time SSE stdout/stderr review stream, persona pipeline execution, and token metrics
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div id="connection-status">
            <StatusBadge
              status={getStatusBadgeType()}
              label={
                connectionStatus === 'connected'
                  ? 'Streaming Live'
                  : connectionStatus === 'reconnecting'
                  ? 'Reconnecting...'
                  : connectionStatus === 'connecting'
                  ? 'Connecting...'
                  : 'Disconnected'
              }
            />
          </div>

          <Button
            size="sm"
            variant="outline"
            onClick={reconnect}
            className="h-8 text-xs border-slate-700 text-slate-300 hover:text-white"
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            Reconnect
          </Button>
        </div>
      </div>

      {/* Stream Target Job Selector */}
      <form onSubmit={handleConnectJob} className="flex flex-wrap items-center gap-3 p-3 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm">
        <span className="text-xs font-semibold text-slate-300 shrink-0">Active Job Stream:</span>
        <Input
          type="text"
          placeholder="Enter Job ID (e.g. job_123 or default-job)"
          value={inputJobId}
          onChange={(e) => setInputJobId(e.target.value)}
          className="h-8 w-full sm:w-64 text-xs font-mono bg-slate-950/80 border-slate-700/60 focus:border-indigo-500 text-slate-200"
        />
        <Button size="sm" type="submit" className="h-8 text-xs bg-indigo-600 hover:bg-indigo-500 text-white gap-1.5">
          <Play className="h-3.5 w-3.5" />
          <span>Switch Stream</span>
        </Button>
        <span className="text-xs text-slate-500 font-mono ml-auto hidden md:inline">
          URL: /api/live/stream?jobId={jobId}
        </span>
      </form>

      {/* Streaming Token Metrics Cards & Recharts */}
      <StreamingMetricsCharts metrics={tokenMetrics} history={tokenHistory} />

      {/* Persona Parallel Execution Progress Grid */}
      <PersonaProgressGrid
        personaProgress={personaProgress}
        onPersonaClick={(p) => setSelectedPersona(p)}
      />

      {/* Main Stream Explorer Workspace: Active Jobs Sidebar + Terminal Feed */}
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

          <div id="inspector-prompt" className="hidden" />

          {/* Monospace Glass Terminal Feed */}
          <TerminalFeed
            events={filteredEvents}
            selectedPersona={selectedPersona}
            onClear={clearEvents}
          />
        </div>
      </div>
    </div>
  );
}

export function LiveDashboardView() {
  return (
    <Suspense fallback={
      <div className="p-8 text-center text-slate-400 font-mono text-xs space-y-4">
        <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center justify-center gap-2">
          ct-review-bot — Live Agent Review Terminal
        </h2>
        <PersonaProgressGrid personaProgress={{}} />
      </div>
    }>
      <LiveStreamContent />
    </Suspense>
  );
}

export default LiveDashboardView;
