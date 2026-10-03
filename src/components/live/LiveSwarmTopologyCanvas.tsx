'use client';

import React, { useState, useMemo, useRef } from 'react';
import { Card, Badge, Button } from '@tremor/react';
import {
  Server,
  Database,
  Cpu,
  ShieldCheck,
  Zap,
  Activity,
  HardDrive,
  FileCode,
  Radio,
  Layers,
  Sparkles,
  Play,
  Pause,
  Filter,
  Eye,
  RefreshCw,
  Maximize2,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
} from 'lucide-react';
import {
  NodeHoverInspectionCard,
  TopologyNodeData,
  TopologyNodeType,
  TopologyNodeStatus,
} from './NodeHoverInspectionCard';
import { NodeDetailsDrawer } from './NodeDetailsDrawer';
import { SwarmTaskItem, ContextCompactionMetrics } from './SwarmTaskMatrix';

export type FilterTierMode = 'all' | 'agents' | 'infra' | 'models';

interface LiveSwarmTopologyCanvasProps {
  jobId?: string | null;
  swarmTasks?: SwarmTaskItem[];
  compaction?: ContextCompactionMetrics;
  tokenMetrics?: {
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    estimatedCostUSD: number;
  };
  currentStage?: string;
  connectionStatus?: string;
  onSelectAgentTask?: (taskId: string) => void;
  className?: string;
}

export function LiveSwarmTopologyCanvas({
  jobId = 'run_live_reviewyeti_pr1282',
  swarmTasks = [],
  compaction,
  tokenMetrics,
  currentStage = 'reviewing',
  connectionStatus = 'connected',
  onSelectAgentTask,
  className = '',
}: LiveSwarmTopologyCanvasProps) {
  const [filterMode, setFilterMode] = useState<FilterTierMode>('all');
  const [hoveredNode, setHoveredNode] = useState<TopologyNodeData | null>(null);
  const [hoverPosition, setHoverPosition] = useState<{ x: number; y: number } | null>(null);
  const [selectedNode, setSelectedNode] = useState<TopologyNodeData | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [isAnimated, setIsAnimated] = useState<boolean>(true);
  const containerRef = useRef<HTMLDivElement>(null);

  // Generate topology node graph from live props
  const allNodes: TopologyNodeData[] = useMemo(() => {
    // 1. Tier 1: Ingress & Edge
    const ingressNodes: TopologyNodeData[] = [
      {
        id: 'github_webhook',
        title: 'GitHub Dispatcher',
        subtitle: 'Webhook Ingress (PR #1282)',
        type: 'edge_ingress',
        tier: 1,
        status: 'HEALTHY',
        health: 100,
        latencyMs: 12,
        metrics: {
          throughput: '32 ev/min',
          totalRequests: 1420,
        },
        details: 'Receives signed GitHub webhooks, verifies HMAC-SHA256 signatures, and routes to Cloudflare Edge Orchestrator.',
      },
      {
        id: 'cf_edge_orchestrator',
        title: 'Edge Orchestrator',
        subtitle: 'Cloudflare Worker Engine',
        type: 'edge_ingress',
        tier: 1,
        status: connectionStatus === 'connected' ? 'HEALTHY' : 'IN_FLIGHT',
        health: 99.9,
        latencyMs: 14,
        progress: currentStage === 'complete' ? 100 : currentStage === 'arbitration' ? 92 : currentStage === 'execution' ? 75 : currentStage === 'planning' ? 40 : currentStage === 'compaction' ? 25 : 10,
        tokensBurned: tokenMetrics?.totalTokens || 0,
        budgetUsedUSD: tokenMetrics?.estimatedCostUSD || 0,
        budgetMaxUSD: 0.0500,
        metrics: {
          cpuMs: 18,
          memoryMb: 24.2,
          throughput: '124 req/s',
          tokensPerSec: (tokenMetrics as any)?.tokensPerSec || (tokenMetrics?.totalTokens ? Math.round(tokenMetrics.totalTokens / 45) : 185),
          promptTokens: tokenMetrics?.promptTokens,
          completionTokens: tokenMetrics?.completionTokens,
        },
        details: 'Global Anycast edge worker handling request lifecycle, SSE broadcasting, token tracking, and subagent orchestration.',
      },
    ];

    // 2. Tier 2: Stateful Coordination & Storage Mesh
    const infraNodes: TopologyNodeData[] = [
      {
        id: 'repogate_do',
        title: 'RepoGate DO',
        subtitle: 'Concurrency Fence (Epoch #1)',
        type: 'stateful_do',
        tier: 2,
        status: 'HEALTHY',
        health: 100,
        latencyMs: 8,
        progress: 100,
        metrics: {
          memoryMb: 12.4,
          throughput: 'Single-flight lock',
        },
        details: 'Durable Object managing single-flight leases and preventing concurrent overlapping runs on the same pull request.',
      },
      {
        id: 'reviewrun_do',
        title: 'ReviewRun DO',
        subtitle: 'Stateful Session Actor',
        type: 'stateful_do',
        tier: 2,
        status: currentStage === 'complete' ? 'HEALTHY' : 'IN_FLIGHT',
        health: 99.8,
        latencyMs: 9,
        progress: currentStage === 'complete' ? 100 : currentStage === 'arbitration' ? 92 : currentStage === 'execution' ? 80 : 40,
        tokensBurned: tokenMetrics?.totalTokens || 0,
        budgetUsedUSD: tokenMetrics?.estimatedCostUSD || 0,
        budgetMaxUSD: 0.0500,
        metrics: {
          memoryMb: 32.1,
          throughput: 'SSE Streaming',
          turnsCount: 4,
          tokensPerSec: (tokenMetrics as any)?.tokensPerSec,
        },
        details: 'In-memory actor maintaining turn state, prompt guidance, finding deduplication, and streaming event buffer.',
      },
      {
        id: 'r2_ast_cache',
        title: 'R2 Symbol Storage',
        subtitle: 'yeti-cache-bucket',
        type: 'storage_r2',
        tier: 2,
        status: 'CACHED',
        health: 100,
        latencyMs: 22,
        progress: 100,
        metrics: {
          cacheHitRate: 95.8,
          throughput: '420 IOPS',
          compactionRatio: compaction?.compactionRatio || 4.2,
          astNodes: compaction?.astOutlineNodes || 18,
        },
        details: 'High-speed object storage holding repository AST symbols, compacted unified diffs, and historical review memories.',
      },
      {
        id: 'cf_task_queue',
        title: 'Cloudflare Queues',
        subtitle: 'yeti-subagent-turn-queue',
        type: 'queue',
        tier: 2,
        status: 'HEALTHY',
        health: 100,
        latencyMs: 15,
        progress: 100,
        metrics: {
          throughput: '4 in-flight',
          memoryMb: 8.5,
        },
        details: 'Bounded-concurrency asynchronous queue decoupling subagent turn execution and preventing edge worker timeouts.',
      },
    ];

    // 3. Tier 3: Autonomous Swarm Agents
    const fallbackTasks: LiveSwarmTask[] = [
      {
        id: 'task_sec_boundary',
        dimension: 'security',
        paths: ['src/gateway/edgeCompactionEngine.ts'],
        priority: 1,
        status: 'COMPLETED',
        progress: 100,
        findingsCount: 0,
        tokensBurned: 6200,
        costUSD: 0.0025,
        budgetUSD: 0.0125,
        turn: 4,
        maxTurns: 20,
        lastMessage: 'Security perimeter clean. 0 secrets detected.',
        durationMs: 4120,
      },
      {
        id: 'task_arch_compaction',
        dimension: 'architecture',
        paths: ['src/gateway/edgeCompactionEngine.ts', 'cf-orchestrator/src/worker.ts'],
        priority: 2,
        status: 'IN_FLIGHT',
        progress: 68,
        findingsCount: 1,
        tokensBurned: 9320,
        costUSD: 0.0058,
        budgetUSD: 0.0125,
        turn: 8,
        maxTurns: 20,
        tokensPerSec: 142,
        lastMessage: 'Inspecting AST outline compaction depth for large diffs',
        durationMs: 8450,
      },
      {
        id: 'task_perf_worker_budget',
        dimension: 'performance',
        paths: ['cf-orchestrator/src/worker.ts'],
        priority: 3,
        status: 'IN_FLIGHT',
        progress: 45,
        findingsCount: 0,
        tokensBurned: 4100,
        costUSD: 0.0022,
        budgetUSD: 0.0125,
        turn: 5,
        maxTurns: 20,
        tokensPerSec: 110,
        lastMessage: 'Evaluating sub-50ms CPU execution budget on Cloudflare Edge',
        durationMs: 3890,
      },
      {
        id: 'task_test_coverage',
        dimension: 'testing',
        paths: ['cf-orchestrator/test/dashboardRoutes.test.ts'],
        priority: 4,
        status: 'PENDING',
        progress: 0,
        findingsCount: 0,
        tokensBurned: 0,
        costUSD: 0,
        budgetUSD: 0.0125,
        turn: 0,
        maxTurns: 20,
        lastMessage: 'Queued for route invariant verification',
        durationMs: 0,
      },
    ];

    const activeTasks = (swarmTasks && swarmTasks.length > 0) ? swarmTasks : fallbackTasks;

    const agentNodes: TopologyNodeData[] = activeTasks.map((t) => {
      const isSec = t.dimension === 'security';
      const isArch = t.dimension === 'architecture';
      const isPerf = t.dimension === 'performance';
      const isTest = t.dimension === 'testing';

      const promptTok = t.promptTokens ?? 0;
      const complTok = t.completionTokens ?? 0;
      const totalTok = t.tokensBurned ?? (promptTok + complTok);
      const taskCost = t.costUSD ?? 0;
      const taskBudget = t.budgetUSD ?? 0.0125;

      return {
        id: t.id,
        title: isSec
          ? 'Security Sentinel'
          : isArch
          ? 'Architecture Auditor'
          : isPerf
          ? 'Budget Guardian'
          : isTest
          ? 'Contract Verifier'
          : `Agent: ${t.dimension.toUpperCase()}`,
        subtitle: `Subagent: ${t.dimension.toUpperCase()}`,
        type: 'swarm_agent',
        tier: 3,
        status: t.status === 'COMPLETED' ? 'HEALTHY' : t.status === 'IN_FLIGHT' ? 'IN_FLIGHT' : 'PENDING',
        health: t.status === 'COMPLETED' ? 100 : t.status === 'IN_FLIGHT' ? 98.5 : 100,
        latencyMs: t.durationMs || 0,
        progress: t.progress ?? (t.status === 'COMPLETED' ? 100 : 0),
        tokensBurned: totalTok,
        budgetUsedUSD: taskCost,
        budgetMaxUSD: taskBudget,
        activeTurn: t.turn ?? 0,
        maxTurns: t.maxTurns ?? 20,
        metrics: {
          tokensPerSec: t.status === 'IN_FLIGHT' ? (t.tokensPerSec || 0) : 0,
          turnsCount: t.turn ?? 0,
          compactionRatio: isArch ? compaction?.compactionRatio : undefined,
          activeFiles: t.paths,
          promptTokens: promptTok,
          completionTokens: complTok,
        },
        role: t.description,
        provider: 'OpenRouter Gateway',
        model: isSec || isArch ? 'anthropic/claude-3.5-sonnet' : 'meta-llama/llama-3.3-70b',
        details: `Specialized domain subagent executing bounded turn iterations on ${(t.paths || []).join(', ') || 'assigned files'}.`,
      };
    });

    // Add Canonical Arbiter Node
    agentNodes.push({
      id: 'agent_canonical_arbiter',
      title: 'Canonical Arbiter',
      subtitle: 'Synthesis & Quorum Engine',
      type: 'arbiter',
      tier: 3,
      status: currentStage === 'complete' ? 'HEALTHY' : currentStage === 'arbitration' ? 'IN_FLIGHT' : 'PENDING',
      health: 100,
      latencyMs: 850,
      progress: currentStage === 'complete' ? 100 : currentStage === 'arbitration' ? 70 : 0,
      tokensBurned: 1850,
      budgetUsedUSD: 0.0011,
      budgetMaxUSD: 0.0050,
      metrics: {
        throughput: 'Binding Verdict',
        turnsCount: 1,
        tokensPerSec: 95,
      },
      role: 'Cross-verifies subagent findings, deduplicates line overlaps, and arbitrates final SHIP / NACK verdict.',
      model: 'reviewyeti-ai/canonical-arbiter-v2',
      details: 'Evaluates severity floors and produces canonical line-anchored PR reviews.',
    });

    // 4. Tier 4: Model Inference Fleet & Fallback Mesh
    const modelNodes: TopologyNodeData[] = [
      {
        id: 'llm_openrouter_claude',
        title: 'Claude 3.5 Sonnet',
        subtitle: 'Anthropic via OpenRouter',
        type: 'llm_provider',
        tier: 4,
        status: 'HEALTHY',
        health: 99.9,
        latencyMs: 820,
        metrics: {
          tokensPerSec: 154,
          errorRate: 0.0,
          throughput: 'Primary Reasoning',
        },
        provider: 'Anthropic / OpenRouter',
        model: 'claude-3-5-sonnet-20241022',
        details: 'Primary high-reasoning engine for code analysis, security auditing, and AST compaction evaluation.',
      },
      {
        id: 'llm_openai_gpt4o',
        title: 'OpenAI GPT-4o',
        subtitle: 'Secondary Cross-Validation',
        type: 'llm_provider',
        tier: 4,
        status: 'HEALTHY',
        health: 100,
        latencyMs: 910,
        metrics: {
          tokensPerSec: 135,
          errorRate: 0.0,
          throughput: 'Cross-Check Fleet',
        },
        provider: 'OpenAI Direct API',
        model: 'gpt-4o',
        details: 'Secondary multi-modal reasoning engine for cross-verifying disputed security findings and architectural impact.',
      },
      {
        id: 'llm_groq_llama',
        title: 'Groq Llama 3.3 70B',
        subtitle: 'Ultra-Fast Inference (LPU)',
        type: 'llm_provider',
        tier: 4,
        status: 'HEALTHY',
        health: 99.8,
        latencyMs: 240,
        metrics: {
          tokensPerSec: 380,
          errorRate: 0.0,
          throughput: 'Fast Path',
        },
        provider: 'Groq Cloud LPU',
        model: 'llama-3.3-70b-versatile',
        details: 'Hardware-accelerated LPU engine for fast AST outline extraction, regex linting, and worker budget analysis.',
      },
      {
        id: 'llm_cf_workers_ai',
        title: 'Workers AI Edge',
        subtitle: 'Local Zero-Cold-Start Fallback',
        type: 'llm_provider',
        tier: 4,
        status: 'STANDBY',
        health: 100,
        latencyMs: 85,
        metrics: {
          tokensPerSec: 90,
          throughput: 'Edge Failover',
        },
        provider: 'Cloudflare Workers AI',
        model: '@cf/meta/llama-3.1-8b-instruct',
        details: 'Runs directly inside Cloudflare edge colos. Guarantees zero-downtime offline review completion during upstream outages.',
      },
    ];

    return [...ingressNodes, ...infraNodes, ...agentNodes, ...modelNodes];
  }, [swarmTasks, compaction, tokenMetrics, connectionStatus]);

  // Filter nodes based on selected filter pill
  const filteredNodes = useMemo(() => {
    switch (filterMode) {
      case 'agents':
        return allNodes.filter((n) => n.tier === 3);
      case 'infra':
        return allNodes.filter((n) => n.tier === 1 || n.tier === 2);
      case 'models':
        return allNodes.filter((n) => n.tier === 4);
      case 'all':
      default:
        return allNodes;
    }
  }, [allNodes, filterMode]);

  // Group nodes by tier for structured layout
  const tier1Nodes = useMemo(() => filteredNodes.filter((n) => n.tier === 1), [filteredNodes]);
  const tier2Nodes = useMemo(() => filteredNodes.filter((n) => n.tier === 2), [filteredNodes]);
  const tier3Nodes = useMemo(() => filteredNodes.filter((n) => n.tier === 3), [filteredNodes]);
  const tier4Nodes = useMemo(() => filteredNodes.filter((n) => n.tier === 4), [filteredNodes]);

  const handleNodeMouseEnter = (node: TopologyNodeData, event: React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const containerRect = containerRef.current?.getBoundingClientRect();

    if (containerRect) {
      // Calculate relative position to container
      let x = rect.right - containerRect.left + 12;
      let y = rect.top - containerRect.top;

      // Adjust if overflowing to the right
      if (x + 320 > containerRect.width) {
        x = rect.left - containerRect.left - 330;
      }
      // Keep within bounds
      if (y + 300 > containerRect.height) {
        y = Math.max(10, containerRect.height - 320);
      }

      setHoverPosition({ x: Math.max(10, x), y: Math.max(10, y) });
    }
    setHoveredNode(node);
  };

  const handleNodeMouseLeave = () => {
    setHoveredNode(null);
    setHoverPosition(null);
  };

  const handleNodeClick = (node: TopologyNodeData) => {
    setSelectedNode(node);
    setIsDrawerOpen(true);
    if (node.type === 'swarm_agent' && onSelectAgentTask) {
      onSelectAgentTask(node.id);
    }
  };

  const getNodeIcon = (type: TopologyNodeType) => {
    switch (type) {
      case 'edge_ingress':
        return <Zap className="h-4 w-4 text-emerald-400" />;
      case 'stateful_do':
        return <Server className="h-4 w-4 text-violet-400" />;
      case 'storage_r2':
        return <HardDrive className="h-4 w-4 text-cyan-400" />;
      case 'queue':
        return <Layers className="h-4 w-4 text-amber-400" />;
      case 'swarm_agent':
        return <Cpu className="h-4 w-4 text-indigo-400" />;
      case 'llm_provider':
        return <Sparkles className="h-4 w-4 text-pink-400" />;
      case 'arbiter':
        return <ShieldCheck className="h-4 w-4 text-emerald-400" />;
      default:
        return <Activity className="h-4 w-4 text-zinc-400" />;
    }
  };

  const getStatusBadge = (status: TopologyNodeStatus) => {
    switch (status) {
      case 'HEALTHY':
        return (
          <span className="flex items-center gap-1 text-[10px] font-mono text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
            ONLINE
          </span>
        );
      case 'IN_FLIGHT':
        return (
          <span className="flex items-center gap-1 text-[10px] font-mono text-indigo-300">
            <span className="h-1.5 w-1.5 rounded-full bg-indigo-400 animate-ping" />
            STREAMING
          </span>
        );
      case 'CACHED':
        return (
          <span className="flex items-center gap-1 text-[10px] font-mono text-cyan-300">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
            HIT
          </span>
        );
      case 'PENDING':
      case 'STANDBY':
        return (
          <span className="flex items-center gap-1 text-[10px] font-mono text-amber-400">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            STANDBY
          </span>
        );
      case 'DEGRADED':
        return (
          <span className="flex items-center gap-1 text-[10px] font-mono text-rose-400">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
            DEGRADED
          </span>
        );
    }
  };

  return (
    <div
      ref={containerRef}
      className={`relative rounded-xl border border-white/[0.08] bg-[#07080b] p-4 text-zinc-100 shadow-xl overflow-hidden ${className}`}
      data-testid="live-swarm-topology-canvas"
    >
      {/* Visual Ambient Background Grid */}
      <div className="absolute inset-0 bg-[radial-gradient(#1e2235_1px,transparent_1px)] [background-size:24px_24px] opacity-25 pointer-events-none" />

      {/* Top HUD Controls & System Health Strip */}
      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] pb-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/10 border border-indigo-500/20">
            <Radio className="h-3.5 w-3.5 text-indigo-400 animate-pulse" />
          </div>
          <div>
            <h3 className="text-xs font-semibold text-zinc-100 font-mono tracking-tight flex items-center gap-2">
              LIVE SWARM & INFRASTRUCTURE TOPOLOGY
              <span className="text-[10px] font-normal text-zinc-400 bg-white/[0.04] border border-white/[0.08] px-1.5 py-0.5 rounded">
                Job: {jobId || 'run_live_reviewyeti_pr1282'}
              </span>
            </h3>
            <p className="text-[11px] text-zinc-400 font-mono">
              Real-time interactive topology mesh • Hover any node for live telemetry
            </p>
          </div>
        </div>

        {/* Global Topology Telemetry Badges */}
        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/[0.02] border border-white/[0.06] text-zinc-300">
            <Activity className="h-3 w-3 text-cyan-400" />
            <span className="text-zinc-500">Throughput:</span>
            <span className="text-cyan-300 font-semibold">384 tok/s</span>
          </div>

          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/[0.02] border border-white/[0.06] text-zinc-300">
            <Zap className="h-3 w-3 text-emerald-400" />
            <span className="text-zinc-500">P95 RTT:</span>
            <span className="text-emerald-300 font-semibold">14.2ms</span>
          </div>

          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/[0.02] border border-white/[0.06] text-zinc-300">
            <HardDrive className="h-3 w-3 text-indigo-400" />
            <span className="text-zinc-500">R2 Hit Rate:</span>
            <span className="text-indigo-300 font-semibold">{compaction?.compactionRatio ? '95.8%' : '94.2%'}</span>
          </div>

          {/* Animation Toggle */}
          <button
            type="button"
            onClick={() => setIsAnimated(!isAnimated)}
            className="flex items-center gap-1 px-2 py-1 rounded-md bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] text-zinc-400 hover:text-zinc-200 transition-colors"
            title={isAnimated ? 'Pause Stream Animations' : 'Resume Stream Animations'}
            data-testid="toggle-topology-animations-btn"
          >
            {isAnimated ? <Pause className="h-3 w-3 text-indigo-400" /> : <Play className="h-3 w-3 text-zinc-400" />}
            <span className="text-[10px]">{isAnimated ? 'Live Pulse' : 'Paused'}</span>
          </button>
        </div>
      </div>

      {/* Tier Filter Tabs Bar */}
      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-1.5 bg-[#0a0b10] border border-white/[0.08] p-1 rounded-lg">
          {[
            { id: 'all', label: `All Nodes (${allNodes.length})` },
            { id: 'agents', label: `Swarm Agents (${tier3Nodes.length || 5})` },
            { id: 'infra', label: `Infrastructure (${tier1Nodes.length + tier2Nodes.length || 6})` },
            { id: 'models', label: `Inference Fleet (${tier4Nodes.length || 4})` },
          ].map((tab) => {
            const isSelected = filterMode === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilterMode(tab.id as FilterTierMode)}
                className={`text-xs px-2.5 py-1 rounded-md font-mono transition-all ${
                  isSelected
                    ? 'bg-indigo-600/30 text-indigo-200 border border-indigo-500/40 shadow-sm font-semibold'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]'
                }`}
                data-testid={`filter-tier-${tab.id}`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 text-[11px] font-mono text-zinc-500">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-emerald-400" /> Edge
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-violet-400" /> State/Cache
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-indigo-400" /> Swarm Agents
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-pink-400" /> LLM Fleet
          </span>
        </div>
      </div>

      {/* Interactive Topology Graph Grid with 4 Architectural Tiers */}
      <div className="relative z-10 grid grid-cols-1 md:grid-cols-4 gap-4 py-2">
        {/* TIER 1: Edge Ingress */}
        {(filterMode === 'all' || filterMode === 'infra') && (
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-white/[0.06] pb-1.5">
              <span className="text-[11px] font-mono uppercase tracking-wider text-emerald-400 font-semibold flex items-center gap-1.5">
                <Zap className="h-3 w-3" />
                Tier 1: Edge Ingress
              </span>
              <span className="text-[10px] font-mono text-zinc-500">2 Nodes</span>
            </div>

            <div className="space-y-2.5">
              {tier1Nodes.map((node) => (
                <div
                  key={node.id}
                  onMouseEnter={(e) => handleNodeMouseEnter(node, e)}
                  onMouseLeave={handleNodeMouseLeave}
                  onClick={() => handleNodeClick(node)}
                  className={`group relative cursor-pointer rounded-xl border p-3.5 transition-all duration-150 ${
                    hoveredNode?.id === node.id || selectedNode?.id === node.id
                      ? 'bg-emerald-950/20 border-emerald-500/60 shadow-[0_0_16px_rgba(16,185,129,0.2)]'
                      : 'bg-[#0a0c12]/80 hover:bg-[#0c0e16] border-white/[0.08] hover:border-emerald-500/40'
                  }`}
                  data-testid={`topology-node-${node.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                        {getNodeIcon(node.type)}
                      </div>
                      <div>
                        <h4 className="text-xs font-semibold text-zinc-100 font-mono group-hover:text-emerald-300 transition-colors">
                          {node.title}
                        </h4>
                        <span className="text-[10px] text-zinc-400 font-mono block truncate max-w-[140px]">
                          {node.subtitle}
                        </span>
                      </div>
                    </div>
                    {getStatusBadge(node.status)}
                  </div>

                  <div className="mt-2.5 flex items-center justify-between text-[11px] font-mono text-zinc-400 pt-2 border-t border-white/[0.04]">
                    <span>RTT: {node.latencyMs}ms</span>
                    <span className="text-zinc-500">
                      {node.metrics.throughput || (node.metrics.tokensPerSec ? `${node.metrics.tokensPerSec} t/s` : '')}
                    </span>
                  </div>

                  {/* Flow Connector Line indicator */}
                  {isAnimated && (
                    <div className="absolute -right-2 top-1/2 -translate-y-1/2 hidden md:block">
                      <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TIER 2: State & Storage Mesh */}
        {(filterMode === 'all' || filterMode === 'infra') && (
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-white/[0.06] pb-1.5">
              <span className="text-[11px] font-mono uppercase tracking-wider text-violet-400 font-semibold flex items-center gap-1.5">
                <Server className="h-3 w-3" />
                Tier 2: State & Storage
              </span>
              <span className="text-[10px] font-mono text-zinc-500">{tier2Nodes.length} Nodes</span>
            </div>

            <div className="space-y-2.5">
              {tier2Nodes.map((node) => (
                <div
                  key={node.id}
                  onMouseEnter={(e) => handleNodeMouseEnter(node, e)}
                  onMouseLeave={handleNodeMouseLeave}
                  onClick={() => handleNodeClick(node)}
                  className={`group relative cursor-pointer rounded-xl border p-3.5 transition-all duration-150 ${
                    hoveredNode?.id === node.id || selectedNode?.id === node.id
                      ? 'bg-violet-950/20 border-violet-500/60 shadow-[0_0_16px_rgba(139,92,246,0.2)]'
                      : 'bg-[#0a0c12]/80 hover:bg-[#0c0e16] border-white/[0.08] hover:border-violet-500/40'
                  }`}
                  data-testid={`topology-node-${node.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/10 border border-violet-500/20">
                        {getNodeIcon(node.type)}
                      </div>
                      <div>
                        <h4 className="text-xs font-semibold text-zinc-100 font-mono group-hover:text-violet-300 transition-colors">
                          {node.title}
                        </h4>
                        <span className="text-[10px] text-zinc-400 font-mono block truncate max-w-[140px]">
                          {node.subtitle}
                        </span>
                      </div>
                    </div>
                    {getStatusBadge(node.status)}
                  </div>

                  <div className="mt-2.5 flex items-center justify-between text-[11px] font-mono text-zinc-400 pt-2 border-t border-white/[0.04]">
                    <span>
                      {node.metrics.memoryMb ? `${node.metrics.memoryMb}MB` : `RTT: ${node.latencyMs}ms`}
                    </span>
                    <span className="text-cyan-400 font-medium">
                      {node.metrics.cacheHitRate ? `${node.metrics.cacheHitRate}% Hit` : node.metrics.throughput || ''}
                    </span>
                  </div>

                  {isAnimated && (
                    <div className="absolute -right-2 top-1/2 -translate-y-1/2 hidden md:block">
                      <div className="h-1.5 w-1.5 rounded-full bg-violet-400 animate-ping" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TIER 3: Autonomous Swarm Agents */}
        {(filterMode === 'all' || filterMode === 'agents') && (
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-white/[0.06] pb-1.5">
              <span className="text-[11px] font-mono uppercase tracking-wider text-indigo-400 font-semibold flex items-center gap-1.5">
                <Cpu className="h-3 w-3" />
                Tier 3: Swarm Agents
              </span>
              <span className="text-[10px] font-mono text-zinc-500">{tier3Nodes.length} Agents</span>
            </div>

            <div className="space-y-2.5">
              {tier3Nodes.map((node) => (
                <div
                  key={node.id}
                  onMouseEnter={(e) => handleNodeMouseEnter(node, e)}
                  onMouseLeave={handleNodeMouseLeave}
                  onClick={() => handleNodeClick(node)}
                  className={`group relative cursor-pointer rounded-xl border p-3.5 transition-all duration-150 ${
                    hoveredNode?.id === node.id || selectedNode?.id === node.id
                      ? 'bg-indigo-950/20 border-indigo-500/60 shadow-[0_0_16px_rgba(99,102,241,0.25)]'
                      : 'bg-[#0a0c12]/80 hover:bg-[#0c0e16] border-white/[0.08] hover:border-indigo-500/40'
                  }`}
                  data-testid={`topology-node-${node.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/10 border border-indigo-500/20">
                        {getNodeIcon(node.type)}
                      </div>
                      <div>
                        <h4 className="text-xs font-semibold text-zinc-100 font-mono group-hover:text-indigo-300 transition-colors">
                          {node.title}
                        </h4>
                        <span className="text-[10px] text-zinc-400 font-mono block truncate max-w-[140px]">
                          {node.subtitle}
                        </span>
                      </div>
                    </div>
                    {getStatusBadge(node.status)}
                  </div>

                  {node.progress !== undefined && (
                    <div className="mt-2 space-y-1">
                      <div className="flex items-center justify-between text-[9px] font-mono">
                        <span className="text-zinc-500">Progress</span>
                        <span className={node.progress >= 100 ? 'text-emerald-400 font-semibold' : 'text-indigo-400 font-semibold'}>
                          {Math.round(node.progress)}%
                        </span>
                      </div>
                      <div className="h-1 w-full bg-white/[0.08] rounded-full overflow-hidden">
                        <div
                          className={`h-full transition-all duration-300 ${node.progress >= 100 ? 'bg-emerald-400' : 'bg-indigo-500 animate-pulse'}`}
                          style={{ width: `${node.progress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="mt-2.5 flex items-center justify-between text-[11px] font-mono text-zinc-400 pt-2 border-t border-white/[0.04]">
                    <span>
                      {node.tokensBurned ? `${node.tokensBurned.toLocaleString()} tok` : node.metrics.activeFiles ? `${node.metrics.activeFiles.length} file(s)` : `${node.latencyMs}ms`}
                    </span>
                    <span className="text-indigo-300 font-medium">
                      {node.budgetUsedUSD ? `$${node.budgetUsedUSD.toFixed(4)}` : node.metrics.tokensPerSec ? `${node.metrics.tokensPerSec} t/s` : `${node.metrics.turnsCount || 1} turns`}
                    </span>
                  </div>

                  {isAnimated && (
                    <div className="absolute -right-2 top-1/2 -translate-y-1/2 hidden md:block">
                      <div className="h-1.5 w-1.5 rounded-full bg-indigo-400 animate-ping" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TIER 4: LLM Inference Fleet & Fallbacks */}
        {(filterMode === 'all' || filterMode === 'models') && (
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-white/[0.06] pb-1.5">
              <span className="text-[11px] font-mono uppercase tracking-wider text-pink-400 font-semibold flex items-center gap-1.5">
                <Sparkles className="h-3 w-3" />
                Tier 4: Inference Fleet
              </span>
              <span className="text-[10px] font-mono text-zinc-500">{tier4Nodes.length} Models</span>
            </div>

            <div className="space-y-2.5">
              {tier4Nodes.map((node) => (
                <div
                  key={node.id}
                  onMouseEnter={(e) => handleNodeMouseEnter(node, e)}
                  onMouseLeave={handleNodeMouseLeave}
                  onClick={() => handleNodeClick(node)}
                  className={`group relative cursor-pointer rounded-xl border p-3.5 transition-all duration-150 ${
                    hoveredNode?.id === node.id || selectedNode?.id === node.id
                      ? 'bg-pink-950/20 border-pink-500/60 shadow-[0_0_16px_rgba(244,114,182,0.2)]'
                      : 'bg-[#0a0c12]/80 hover:bg-[#0c0e16] border-white/[0.08] hover:border-pink-500/40'
                  }`}
                  data-testid={`topology-node-${node.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-pink-500/10 border border-pink-500/20">
                        {getNodeIcon(node.type)}
                      </div>
                      <div>
                        <h4 className="text-xs font-semibold text-zinc-100 font-mono group-hover:text-pink-300 transition-colors">
                          {node.title}
                        </h4>
                        <span className="text-[10px] text-zinc-400 font-mono block truncate max-w-[140px]">
                          {node.subtitle}
                        </span>
                      </div>
                    </div>
                    {getStatusBadge(node.status)}
                  </div>

                  <div className="mt-2.5 flex items-center justify-between text-[11px] font-mono text-zinc-400 pt-2 border-t border-white/[0.04]">
                    <span>RTT: {node.latencyMs}ms</span>
                    <span className="text-pink-300 font-medium">
                      {node.metrics.tokensPerSec ? `${node.metrics.tokensPerSec} t/s` : 'Standby'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Floating Glassmorphism Hover Card */}
      {hoveredNode && hoverPosition && (
        <div className="absolute pointer-events-none transition-all duration-75">
          <NodeHoverInspectionCard
            node={hoveredNode}
            position={hoverPosition}
            onInspectNode={() => {
              setSelectedNode(hoveredNode);
              setIsDrawerOpen(true);
            }}
          />
        </div>
      )}

      {/* Slide-Over Deep-Dive Inspector Drawer */}
      <NodeDetailsDrawer
        node={selectedNode}
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        onFilterByNode={(nodeId) => {
          if (onSelectAgentTask) {
            onSelectAgentTask(nodeId);
          }
          setIsDrawerOpen(false);
        }}
      />
    </div>
  );
}

export default LiveSwarmTopologyCanvas;
