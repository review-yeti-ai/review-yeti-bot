'use client';

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  ShieldCheck,
  Cpu,
  Zap,
  CheckCircle2,
  Box,
  FileCode,
  FileText,
  Layers,
  ArrowRight,
  Sparkles,
  Scissors,
  Check,
  AlertCircle,
  Clock,
  Terminal,
} from 'lucide-react';
import type { TaskDimension } from '@/types/live';

export interface SwarmTaskItem {
  id: string;
  dimension: 'security' | 'architecture' | 'performance' | 'testing' | 'dependencies' | 'contract' | 'licensing' | string;
  description: string;
  paths?: string[];
  priority: number;
  status: 'PENDING' | 'PLANNING' | 'IN_FLIGHT' | 'RUNNING' | 'COMPACTING' | 'VERIFYING' | 'COMPLETED' | 'FAILED';
  progress: number;
  findingsCount: number;
  lastMessage?: string;
  durationMs?: number;
}

export interface ContextCompactionMetrics {
  rawDiffTokens: number;
  compactedTokens: number;
  compactionRatio: number;
  boundsReductionLines: number;
  lockfilesBypassed: number;
  astOutlineNodes: number;
}

export interface SwarmTaskMatrixProps {
  tasks?: SwarmTaskItem[];
  compaction?: ContextCompactionMetrics | null;
  selectedTaskId?: string | null;
  onSelectTask?: (taskId: string) => void;
  activeTurnByTask?: Record<string, { current: number; max: number }>;
  className?: string;
}

const DIMENSION_CONFIG: Record<
  string,
  { label: string; icon: React.ReactNode; color: string; badgeClass: string }
> = {
  security: {
    label: 'Security Floor',
    icon: <ShieldCheck className="h-3.5 w-3.5 text-rose-400" />,
    color: 'text-rose-400',
    badgeClass: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  },
  architecture: {
    label: 'Architecture & Boundary',
    icon: <Cpu className="h-3.5 w-3.5 text-indigo-400" />,
    color: 'text-indigo-400',
    badgeClass: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300',
  },
  performance: {
    label: 'Performance & Budgets',
    icon: <Zap className="h-3.5 w-3.5 text-amber-400" />,
    color: 'text-amber-400',
    badgeClass: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  },
  testing: {
    label: 'Test Coverage & Quality',
    icon: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />,
    color: 'text-emerald-400',
    badgeClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  },
  dependencies: {
    label: 'Dependencies & Lockfiles',
    icon: <Box className="h-3.5 w-3.5 text-cyan-400" />,
    color: 'text-cyan-400',
    badgeClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  },
  contract: {
    label: 'API & Wire Contract',
    icon: <FileCode className="h-3.5 w-3.5 text-purple-400" />,
    color: 'text-purple-400',
    badgeClass: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  },
  licensing: {
    label: 'Licensing & Compliance',
    icon: <FileText className="h-3.5 w-3.5 text-blue-400" />,
    color: 'text-blue-400',
    badgeClass: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  },
};

const DEFAULT_SWARM_TASKS: SwarmTaskItem[] = [
  {
    id: 'task_sec_boundary',
    dimension: 'security',
    description: 'Enforce security floor: secret redaction, credential scanning, and edge boundary fences',
    paths: ['src/gateway/edgeCompactionEngine.ts'],
    priority: 1,
    status: 'COMPLETED',
    progress: 100,
    findingsCount: 0,
    lastMessage: 'Pass — Zero security vulnerabilities detected',
    durationMs: 4200,
  },
  {
    id: 'task_arch_compaction',
    dimension: 'architecture',
    description: 'Context compaction audit: verify AST outline depth and eliminate diff leakage across turns',
    paths: ['src/gateway/edgeCompactionEngine.ts', 'cf-orchestrator/src/worker.ts'],
    priority: 2,
    status: 'RUNNING',
    progress: 80,
    findingsCount: 1,
    lastMessage: 'Context compaction: 4.2x ratio achieved on unified diff',
    durationMs: 6800,
  },
  {
    id: 'task_perf_worker_budget',
    dimension: 'performance',
    description: 'Cloudflare Worker budget: CPU execution time and memory limits validation',
    paths: ['cf-orchestrator/src/worker.ts'],
    priority: 3,
    status: 'RUNNING',
    progress: 60,
    findingsCount: 0,
    lastMessage: 'Cloudflare Worker CPU execution time: 8.4ms (within 50ms SLA)',
    durationMs: 3100,
  },
  {
    id: 'task_test_coverage',
    dimension: 'testing',
    description: 'Test coverage & invariant verification across Edge orchestrator routes',
    paths: ['cf-orchestrator/test/dashboardRoutes.test.ts'],
    priority: 4,
    status: 'PENDING',
    progress: 10,
    findingsCount: 0,
    lastMessage: 'Queued for AST verification and test assertions',
    durationMs: 0,
  },
];

const DEFAULT_COMPACTION: ContextCompactionMetrics = {
  rawDiffTokens: 24800,
  compactedTokens: 5900,
  compactionRatio: 4.2,
  boundsReductionLines: 1420,
  lockfilesBypassed: 1,
  astOutlineNodes: 18,
};

export function SwarmTaskMatrix({
  tasks = DEFAULT_SWARM_TASKS,
  compaction = DEFAULT_COMPACTION,
  selectedTaskId,
  onSelectTask,
  activeTurnByTask = {},
  className = '',
}: SwarmTaskMatrixProps) {
  const activeTasks = tasks && tasks.length > 0 ? tasks : DEFAULT_SWARM_TASKS;
  const metrics = compaction || DEFAULT_COMPACTION;

  const completedCount = activeTasks.filter(
    (t) => t.status === 'COMPLETED' || t.progress >= 100
  ).length;

  return (
    <div className={`space-y-3 ${className}`}>
      {/* 1. Header & Live Compaction HUD */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className="status-dot-indigo animate-pulse" />
            <h3 className="text-xs font-semibold tracking-wider text-zinc-200 uppercase font-mono">
              Composed Swarm Review Tasks
            </h3>
          </div>
          <span className="linear-kbd text-[10px] font-mono text-zinc-400">
            {completedCount}/{activeTasks.length} Done
          </span>
        </div>

        {/* Real-time Context Compaction HUD */}
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
          <div className="flex items-center gap-1 px-2 py-0.5 rounded border border-indigo-500/30 bg-indigo-500/10 text-indigo-300">
            <Scissors className="h-3 w-3 text-indigo-400" />
            <span>AST Compaction:</span>
            <strong className="text-white font-bold">{metrics.compactionRatio.toFixed(1)}x</strong>
          </div>
          <div className="flex items-center gap-1 px-2 py-0.5 rounded border border-white/[0.08] bg-white/[0.02] text-zinc-400">
            <span>Raw: {metrics.rawDiffTokens.toLocaleString()} tok</span>
            <ArrowRight className="h-2.5 w-2.5 text-zinc-600" />
            <span className="text-emerald-400 font-medium">{metrics.compactedTokens.toLocaleString()} tok</span>
          </div>
          <div className="hidden md:flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-500/20 bg-emerald-500/5 text-emerald-400">
            <Check className="h-2.5 w-2.5" />
            <span>±3 line bounds clamped</span>
          </div>
        </div>
      </div>

      {/* 2. Swarm Task Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        {activeTasks.map((task) => {
          const dim = DIMENSION_CONFIG[task.dimension] || {
            label: task.dimension,
            icon: <Cpu className="h-3.5 w-3.5 text-zinc-400" />,
            color: 'text-zinc-400',
            badgeClass: 'border-white/[0.1] bg-white/[0.05] text-zinc-300',
          };

          const isSelected = selectedTaskId === task.id;
          const isDone = task.status === 'COMPLETED' || task.progress >= 100;
          const isRunning = task.status === 'RUNNING' || task.status === 'IN_FLIGHT';

          return (
            <div
              key={task.id}
              onClick={() => onSelectTask?.(task.id)}
              className={`p-3 rounded-lg border transition-all cursor-pointer ${
                isSelected
                  ? 'bg-indigo-950/30 border-indigo-500/60 shadow-sm shadow-indigo-500/10'
                  : 'bg-[#0a0b0e] border-white/[0.06] hover:border-white/[0.14] hover:bg-[#0f1117]'
              }`}
            >
              {/* Card Header: Task ID & Dimension */}
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <div className="p-1 rounded bg-white/[0.04] border border-white/[0.06]">
                    {dim.icon}
                  </div>
                  <span className="text-[11px] font-mono font-medium text-zinc-200 truncate">
                    {task.id}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {activeTurnByTask && (activeTurnByTask[task.id] || activeTurnByTask[task.dimension]) && (
                    <span
                      className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 font-semibold"
                      data-testid={`task-turn-badge-${task.id}`}
                    >
                      T{(activeTurnByTask[task.id] || activeTurnByTask[task.dimension]).current}/{(activeTurnByTask[task.id] || activeTurnByTask[task.dimension]).max}
                    </span>
                  )}
                  <Badge
                    variant="outline"
                    className={`text-[9px] uppercase font-mono px-1.5 py-0 ${dim.badgeClass}`}
                  >
                    {task.dimension}
                  </Badge>
                </div>
              </div>

              {/* Task Description */}
              <p className="text-[11px] text-zinc-400 line-clamp-2 leading-relaxed mb-2 min-h-[32px]">
                {task.description}
              </p>

              {/* Scoped Paths Badge */}
              {task.paths && task.paths.length > 0 && (
                <div className="flex items-center gap-1 mb-2 text-[10px] text-zinc-400 font-mono truncate">
                  <span className="text-zinc-500">Path:</span>
                  <span className="truncate text-zinc-300">
                    {task.paths[0]}
                    {task.paths.length > 1 && ` +${task.paths.length - 1}`}
                  </span>
                </div>
              )}

              {/* Progress & Status */}
              <div className="space-y-1 pt-1.5 border-t border-white/[0.05]">
                <div className="flex items-center justify-between text-[10px] font-mono">
                  <div className="flex items-center gap-1.5">
                    {isDone ? (
                      <span className="status-dot-green" />
                    ) : isRunning ? (
                      <span className="status-dot-indigo animate-pulse" />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />
                    )}
                    <span className={isDone ? 'text-emerald-400' : isRunning ? 'text-indigo-300' : 'text-zinc-500'}>
                      {task.status}
                    </span>
                  </div>

                  <span className="text-zinc-400 tabular-nums">{task.progress}%</span>
                </div>

                <Progress
                  value={task.progress}
                  className="h-1 bg-white/[0.06]"
                />

                {/* Subagent message / findings indicator */}
                <div className="flex items-center justify-between text-[10px] text-zinc-400 font-mono pt-0.5">
                  <span className="truncate max-w-[140px] text-zinc-400">
                    {task.lastMessage || 'Executing review task...'}
                  </span>
                  {task.findingsCount > 0 ? (
                    <span className="text-amber-400 font-bold shrink-0">
                      {task.findingsCount} {task.findingsCount === 1 ? 'finding' : 'findings'}
                    </span>
                  ) : isDone ? (
                    <span className="text-emerald-400 font-medium shrink-0">Clean</span>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
