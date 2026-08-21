'use client';

import * as React from 'react';
import { Check, Shield, GitBranch, Cpu, Users, Activity } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface StepInfo {
  id: number;
  title: string;
  shortTitle: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const WIZARD_STEPS: StepInfo[] = [
  {
    id: 1,
    title: 'Organization Connection',
    shortTitle: 'GitHub App',
    description: 'Manifest registration & RS256 key',
    icon: Shield,
  },
  {
    id: 2,
    title: 'Repositories Picker',
    shortTitle: 'Repositories',
    description: 'Monitored repos & strictness',
    icon: GitBranch,
  },
  {
    id: 3,
    title: 'AI Providers & Models',
    shortTitle: 'AI Providers',
    description: '11 OmniRoute providers & keys',
    icon: Cpu,
  },
  {
    id: 4,
    title: 'Persona Ensemble',
    shortTitle: 'Personas',
    description: '11 Reviewer persona assignments',
    icon: Users,
  },
  {
    id: 5,
    title: 'Diagnostic Scan',
    shortTitle: 'Diagnostic',
    description: 'Webhook, latency & quorum check',
    icon: Activity,
  },
];

interface StepIndicatorProps {
  currentStep: number;
  completedSteps?: number[];
  onStepClick?: (step: number) => void;
}

export function StepIndicator({ currentStep, completedSteps = [], onStepClick }: StepIndicatorProps) {
  return (
    <div className="w-full py-4 px-2">
      <div className="grid grid-cols-5 gap-2 sm:gap-4 relative">
        {WIZARD_STEPS.map((step, idx) => {
          const StepIcon = step.icon;
          const isCompleted = completedSteps.includes(step.id) || step.id < currentStep;
          const isActive = step.id === currentStep;

          return (
            <div
              key={step.id}
              onClick={() => onStepClick && isCompleted && onStepClick(step.id)}
              className={cn(
                'flex flex-col items-center text-center group cursor-pointer transition-all duration-200',
                !isCompleted && !isActive && 'opacity-60 cursor-not-allowed'
              )}
            >
              {/* Step Circle */}
              <div
                className={cn(
                  'w-10 h-10 rounded-full flex items-center justify-center border-2 transition-all duration-200 relative z-10',
                  isActive &&
                    'border-primary bg-primary/20 text-primary shadow-md shadow-primary/20 ring-4 ring-primary/10',
                  isCompleted && !isActive &&
                    'border-emerald-500 bg-emerald-500/20 text-emerald-400',
                  !isCompleted && !isActive &&
                    'border-border bg-card text-muted-foreground'
                )}
              >
                {isCompleted && !isActive ? (
                  <Check className="h-5 w-5" />
                ) : (
                  <StepIcon className="h-5 w-5" />
                )}
              </div>

              {/* Step Label */}
              <div className="mt-2 flex flex-col items-center">
                <span
                  className={cn(
                    'text-xs font-semibold tracking-tight transition-colors',
                    isActive && 'text-primary font-bold',
                    isCompleted && !isActive && 'text-foreground font-medium',
                    !isCompleted && !isActive && 'text-muted-foreground'
                  )}
                >
                  <span className="hidden md:inline">Step {step.id}: {step.shortTitle}</span>
                  <span className="md:hidden">Step {step.id}</span>
                </span>
                <span className="text-[11px] text-muted-foreground hidden lg:block max-w-[120px] truncate">
                  {step.description}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Progress Bar Track */}
      <div className="mt-4 h-1.5 w-full bg-secondary/50 rounded-full overflow-hidden flex">
        <div
          className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-emerald-500 transition-all duration-300 rounded-full"
          style={{ width: `${((currentStep - 1) / (WIZARD_STEPS.length - 1)) * 100}%` }}
        />
      </div>
    </div>
  );
}
