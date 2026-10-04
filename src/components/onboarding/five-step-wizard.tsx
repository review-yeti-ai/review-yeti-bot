'use client';

import * as React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StepIndicator, WIZARD_STEPS } from './step-indicator';
import { Step1GitHubApp } from './steps/step-1-github-app';
import { Step2ReposPicker } from './steps/step-2-repos-picker';
import { Step3AIProviders } from './steps/step-3-ai-providers';
import { Step4PersonaEnsemble } from './steps/step-4-persona-ensemble';
import { Step5DiagnosticScan } from './steps/step-5-diagnostic-scan';
import { ArrowLeft, ArrowRight, CheckCircle2, Sparkles, RefreshCw } from 'lucide-react';
import {
  fetchGitHubAppConfig,
  updateGitHubAppConfig,
  verifyGitHubApp,
  fetchRepositories,
  updateRepository,
  createRepository,
  fetchProviders,
  updateProvider,
  testProvider,
  fetchPersonas,
  updatePersona,
  runDiagnosticScan,
} from '@/lib/api-client';
import {
  GitHubAppConfig,
  RepositorySetting,
  ProviderConfigRecord,
  PersonaSetting,
} from '@/types/dashboard';

export function FiveStepWizard() {
  const [currentStep, setCurrentStep] = React.useState(1);
  const [completedSteps, setCompletedSteps] = React.useState<number[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [finishSuccess, setFinishSuccess] = React.useState(false);

  // State data for 5 steps
  const [appConfig, setAppConfig] = React.useState<Partial<GitHubAppConfig>>({
    appId: '',
    installationId: '',
    webhookSecretConfigured: false,
    privateKeyConfigured: false,
    status: 'unconfigured',
  });

  const [repositories, setRepositories] = React.useState<RepositorySetting[]>([]);

  const [providers, setProviders] = React.useState<Record<string, ProviderConfigRecord>>({});
  const [personas, setPersonas] = React.useState<Record<string, PersonaSetting>>({});

  // Initial data loading
  const loadWizardData = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [cfgRes, repoRes, provRes, persRes] = await Promise.allSettled([
        fetchGitHubAppConfig(),
        fetchRepositories(),
        fetchProviders(),
        fetchPersonas(),
      ]);

      if (cfgRes.status === 'fulfilled' && cfgRes.value) {
        setAppConfig((prev) => ({ ...prev, ...cfgRes.value }));
      }
      if (repoRes.status === 'fulfilled' && repoRes.value) {
        setRepositories(repoRes.value);
      }
      if (provRes.status === 'fulfilled' && provRes.value && provRes.value.providers) {
        setProviders(provRes.value.providers);
      }
      if (persRes.status === 'fulfilled' && persRes.value) {
        setPersonas(persRes.value);
      }
      const failedLoads = [
        ['GitHub App configuration', cfgRes],
        ['repositories', repoRes],
        ['AI providers', provRes],
        ['personas', persRes],
      ] as const;
      const failedNames = failedLoads.filter(([, result]) => result.status === 'rejected').map(([name]) => name);
      if (failedNames.length > 0) {
        setLoadError(`Could not load ${failedNames.join(', ')}. Sync Store to retry; no sample configuration has been substituted.`);
      }
    } catch {
      setLoadError('Could not load onboarding settings. Sync Store to retry; no sample configuration has been substituted.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadWizardData();
  }, [loadWizardData]);

  // Step 1 actions
  const handleUpdateAppConfig = (patch: Partial<GitHubAppConfig>) => {
    setAppConfig((prev) => ({ ...prev, ...patch }));
    updateGitHubAppConfig(patch).catch(() => {});
  };

  const handleVerifyAppConfig = async () => {
    await verifyGitHubApp({
      appId: appConfig.appId,
      installationId: appConfig.installationId,
      privateKeyPem: appConfig.privateKeyPemRaw,
      webhookSecret: appConfig.webhookSecretRaw,
    });
  };

  // Step 2 actions
  const handleUpdateRepo = (owner: string, repo: string, patch: Partial<RepositorySetting>) => {
    setRepositories((prev) =>
      prev.map((r) => (r.owner === owner && r.repo === repo ? { ...r, ...patch } : r))
    );
    updateRepository(owner, repo, patch).catch(() => {});
  };

  const handleAddRepo = (owner: string, repo: string) => {
    const newRepo: RepositorySetting = {
      owner,
      repo,
      automationEnabled: true,
      customProfile: 'balanced',
      updatedAt: new Date().toISOString(),
    };
    setRepositories((prev) => [...prev, newRepo]);
    createRepository({ owner, repo, automationEnabled: true, customProfile: 'balanced' }).catch(
      () => {}
    );
  };

  // Step 3 actions
  const handleUpdateProvider = (id: string, patch: Partial<ProviderConfigRecord>) => {
    setProviders((prev) => ({
      ...prev,
      [id]: {
        ...(prev[id] || { id, displayName: id, enabled: true, activeModels: [], updatedAt: new Date().toISOString() }),
        ...patch,
      },
    }));
    updateProvider(id, patch).catch(() => {});
  };

  const handleTestProvider = async (id: string, payload?: any) => {
    return testProvider(id, payload);
  };

  // Step 4 actions
  const handleUpdatePersona = (personaId: string, patch: Partial<PersonaSetting>) => {
    setPersonas((prev) => ({
      ...prev,
      [personaId]: {
        ...(prev[personaId] || { id: personaId, displayName: personaId, model: 'reviewyeti-ai/yeti-pr-reviewer', effort: 'low', confidenceThreshold: 75, enabled: true }),
        ...patch,
      },
    }));
    updatePersona(personaId, patch).catch(() => {});
  };

  // Step 5 actions
  const handleRunDiagnostic = async () => {
    return await runDiagnosticScan({ appId: appConfig.appId });
  };

  // Navigation handlers
  const handleNext = () => {
    if (!completedSteps.includes(currentStep)) {
      setCompletedSteps((prev) => [...prev, currentStep]);
    }
    if (currentStep < 5) {
      setCurrentStep((prev) => prev + 1);
    } else {
      setFinishSuccess(true);
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep((prev) => prev - 1);
    }
  };

  return (
    <Card className="border-border/60 bg-card/80 backdrop-blur-xl shadow-xl">
      <CardContent className="p-4 sm:p-6 space-y-6">
        {/* Visual Step Indicator Header */}
        <StepIndicator
          currentStep={currentStep}
          completedSteps={completedSteps}
          onStepClick={(step) => setCurrentStep(step)}
        />

        {/* Step Component Content */}
        {loadError && (
          <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-400">
            {loadError}
          </p>
        )}
        <div className="pt-2">
          {currentStep === 1 && (
            <Step1GitHubApp
              config={appConfig}
              onUpdateConfig={handleUpdateAppConfig}
              onVerify={handleVerifyAppConfig}
              loading={loading}
            />
          )}

          {currentStep === 2 && (
            <Step2ReposPicker
              repositories={repositories}
              onUpdateRepo={handleUpdateRepo}
              onAddRepo={handleAddRepo}
            />
          )}

          {currentStep === 3 && (
            <Step3AIProviders
              providers={providers}
              onUpdateProvider={handleUpdateProvider}
              onTestProvider={handleTestProvider}
            />
          )}

          {currentStep === 4 && (
            <Step4PersonaEnsemble
              personas={personas}
              providers={providers}
              onUpdatePersona={handleUpdatePersona}
            />
          )}

          {currentStep === 5 && (
            <Step5DiagnosticScan onRunDiagnostic={handleRunDiagnostic} />
          )}
        </div>

        {/* Success Alert on Completion */}
        {finishSuccess && (
          <div className="p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 flex items-center justify-between text-xs">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-6 w-6 text-emerald-400" />
              <div>
                <h4 className="font-semibold text-emerald-300">Organization Onboarding Complete!</h4>
                <p className="text-emerald-400/80">
                  Your GitHub Organization, monitored repositories, OmniRoute AI providers, and 11 reviewer personas are fully configured.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Bottom Step Navigation Control Bar */}
        <div className="flex items-center justify-between pt-4 border-t border-border/40">
          <Button
            variant="outline"
            size="sm"
            onClick={handleBack}
            disabled={currentStep === 1 || loading}
            className="gap-2 text-xs"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Previous Step
          </Button>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={loadWizardData}
              disabled={loading}
              className="gap-1.5 text-xs hidden sm:flex"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Sync Store
            </Button>

            <Button
              onClick={handleNext}
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs gap-2"
            >
              {currentStep === 5 ? (
                <>
                  <CheckCircle2 className="h-4 w-4" />
                  Complete Onboarding Setup
                </>
              ) : (
                <>
                  Next Step: Step {currentStep + 1}
                  <ArrowRight className="h-3.5 w-3.5" />
                </>
              )}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
