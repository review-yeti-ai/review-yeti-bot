'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { RefreshCw, Sparkles, ExternalLink, FileCode, BookOpen, Calculator } from 'lucide-react';
import { FiveStepWizard } from '@/components/onboarding/five-step-wizard';
import { OnboardingWizard } from '@/components/github-app/onboarding-wizard';
import { HowToGuideCard } from '@/components/onboarding/how-to-guide-card';
import { CostEstimatorCard } from '@/components/onboarding/cost-estimator-card';
import { ManifestDrawer } from '@/components/onboarding/manifest-drawer';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import Link from 'next/link';
import {
  fetchGitHubAppConfig,
  fetchEnforcementPolicy,
  updateEnforcementPolicy,
  verifyGitHubApp,
} from '@/lib/api-client';
import { GitHubAppConfig, EnforcementPolicy } from '@/types/dashboard';

export default function GitHubAppPage() {
  const [config, setConfig] = React.useState<GitHubAppConfig | null>(null);
  const [policy, setPolicy] = React.useState<EnforcementPolicy | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    try {
      const [cfgRes, polRes] = await Promise.allSettled([
        fetchGitHubAppConfig(),
        fetchEnforcementPolicy(),
      ]);
      if (cfgRes.status === 'fulfilled') setConfig(cfgRes.value);
      if (polRes.status === 'fulfilled') setPolicy(polRes.value);
    } catch {
      // Fallbacks
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  const handleVerify = async (data: any) => {
    await verifyGitHubApp(data);
  };

  const handleSavePolicy = async (newPolicy: Partial<EnforcementPolicy>) => {
    const updated = await updateEnforcementPolicy(newPolicy);
    setPolicy(updated);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground">
            GitHub App &amp; OAuth Onboarding Portal
          </h2>
          <p className="text-sm text-muted-foreground">
            Installation manifest callback, permissions, private key RSA upload, 5-step wizard, how-to guides, and token cost estimator.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => setDrawerOpen(true)}
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs border-indigo-500/40 text-indigo-400 hover:bg-indigo-500/10 font-semibold"
          >
            <FileCode className="h-3.5 w-3.5" />
            Manifest Drawer
          </Button>

          <Button asChild variant="outline" size="sm" className="gap-1.5 text-xs">
            <Link href="/onboarding">
              <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
              Full Onboarding Page
              <ExternalLink className="h-3 w-3 ml-0.5" />
            </Link>
          </Button>

          <Button variant="outline" size="sm" onClick={loadData} disabled={loading} className="gap-1.5 text-xs">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      <Tabs defaultValue="settings" className="space-y-4">
        <TabsList className="bg-card border border-border/60 p-1">
          <TabsTrigger value="wizard" className="text-xs font-semibold gap-2">
            <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
            5-Step Onboarding Wizard
          </TabsTrigger>
          <TabsTrigger value="guides" className="text-xs font-semibold gap-2">
            <BookOpen className="h-3.5 w-3.5 text-amber-400" />
            How-To Guides &amp; Documentation
          </TabsTrigger>
          <TabsTrigger value="cost" className="text-xs font-semibold gap-2">
            <Calculator className="h-3.5 w-3.5 text-emerald-400" />
            Token Cost Estimator &amp; Spending Cap
          </TabsTrigger>
          <TabsTrigger value="settings" className="text-xs font-semibold gap-2">
            GitHub App Credentials &amp; Policy
          </TabsTrigger>
        </TabsList>

        <TabsContent value="wizard">
          <FiveStepWizard />
        </TabsContent>

        <TabsContent value="guides">
          <HowToGuideCard />
        </TabsContent>

        <TabsContent value="cost">
          <CostEstimatorCard />
        </TabsContent>

        <TabsContent value="settings">
          <OnboardingWizard
            config={config}
            policy={policy}
            onVerify={handleVerify}
            onSavePolicy={handleSavePolicy}
          />
        </TabsContent>
      </Tabs>

      <ManifestDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />
    </div>
  );
}
