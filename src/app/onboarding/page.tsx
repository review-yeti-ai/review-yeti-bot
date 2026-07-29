'use client';

import * as React from 'react';
import { FiveStepWizard } from '@/components/onboarding/five-step-wizard';
import { HowToGuideCard } from '@/components/onboarding/how-to-guide-card';
import { CostEstimatorCard } from '@/components/onboarding/cost-estimator-card';
import { ManifestDrawer } from '@/components/onboarding/manifest-drawer';
import { Button } from '@/components/ui/button';
import { FileCode, Sparkles } from 'lucide-react';

function OnboardingContent() {
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  return (
    <div className="space-y-8 max-w-7xl mx-auto pb-12">
      {/* Page Title & Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            GitHub Organization Onboarding Wizard
            <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 font-mono border border-indigo-500/30">
              CodeRabbit Spec
            </span>
          </h2>
          <p className="text-sm text-muted-foreground">
            5-Step organization setup: GitHub App registration, monorepo selection, 11 OmniRoute AI providers, reviewer persona ensemble, and diagnostic probes.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={() => setDrawerOpen(true)}
            variant="outline"
            size="sm"
            className="gap-2 text-xs font-semibold border-indigo-500/40 text-indigo-400 hover:bg-indigo-500/10"
          >
            <FileCode className="h-4 w-4" />
            Open Manifest Drawer
          </Button>
        </div>
      </div>

      {/* 5-Step Main Wizard */}
      <FiveStepWizard />

      {/* Auxiliary Help & Cost Tools Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <HowToGuideCard />
        <CostEstimatorCard />
      </div>

      <ManifestDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <React.Suspense
      fallback={
        <div className="p-8 text-center text-muted-foreground text-sm flex items-center justify-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
          Loading Onboarding Wizard...
        </div>
      }
    >
      <OnboardingContent />
    </React.Suspense>
  );
}
