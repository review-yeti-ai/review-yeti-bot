'use client';

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { ShieldCheck, Cpu, Zap, CheckCircle2, Box, FileCode, Layers } from 'lucide-react';

export interface SwarmTaskTabsProps {
  selectedTaskId: string;
  onSelectTask: (taskId: string) => void;
  className?: string;
  tasks?: Array<{
    id: string;
    dimension: string;
    findingsCount?: number;
  }>;
}

export function SwarmTaskTabs({
  selectedTaskId,
  onSelectTask,
  className = '',
  tasks,
}: SwarmTaskTabsProps) {
  const defaultTabs = [
    { id: 'all', label: 'All Tasks', icon: <Layers className="h-3 w-3" /> },
    { id: 'security', label: 'Security Floor', icon: <ShieldCheck className="h-3 w-3 text-rose-400" /> },
    { id: 'architecture', label: 'Architecture & AST', icon: <Cpu className="h-3 w-3 text-indigo-400" /> },
    { id: 'performance', label: 'Performance & Budgets', icon: <Zap className="h-3 w-3 text-amber-400" /> },
    { id: 'testing', label: 'Test Coverage', icon: <CheckCircle2 className="h-3 w-3 text-emerald-400" /> },
  ];

  const availableTabs = tasks && tasks.length > 0
    ? [
        { id: 'all', label: 'All Tasks', icon: <Layers className="h-3 w-3" /> },
        ...tasks.map((t) => ({
          id: t.dimension || t.id,
          label: t.id.replace(/^task_/, '').replace(/_/g, ' '),
          icon: <Cpu className="h-3 w-3 text-indigo-400" />,
        })),
      ]
    : defaultTabs;

  return (
    <div className={`flex flex-wrap items-center gap-1.5 p-1 rounded-lg border border-white/[0.06] bg-[#08090a] ${className}`}>
      {availableTabs.map((tab) => {
        const isActive =
          selectedTaskId === tab.id ||
          (selectedTaskId === 'all' && tab.id === 'all') ||
          (tab.id !== 'all' && selectedTaskId.includes(tab.id));

        return (
          <button
            key={tab.id}
            id={`tab-task-${tab.id}`}
            onClick={() => onSelectTask(tab.id)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono transition-all ${
              isActive
                ? 'bg-white/[0.1] text-white border border-white/[0.12] shadow-sm font-semibold'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.03]'
            }`}
          >
            {tab.icon}
            <span className="capitalize">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
