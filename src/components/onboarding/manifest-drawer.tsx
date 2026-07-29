'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { FileJson, FileCode, Download, Settings, Sparkles, ExternalLink, ShieldCheck } from 'lucide-react';

import { ProviderConfigRecord, PersonaSetting } from '@/types/dashboard';
import { getEnabledProviders, isModelEnabled, getProviderIdForModel, getFallbackModelForPersona } from '@/lib/model-filtering';
import { PERSONA_ENSEMBLE_DEFINITIONS, AVAILABLE_MODEL_OPTIONS } from './steps/step-4-persona-ensemble';
import { fetchProviders, fetchPersonas } from '@/lib/api-client';

export interface ManifestDrawerProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: React.ReactNode;
  orgName?: string;
  appName?: string;
  webhookUrl?: string;
  providers?: Record<string, ProviderConfigRecord>;
  personas?: Record<string, PersonaSetting>;
}

export function ManifestDrawer({
  open: controlledOpen,
  onOpenChange: setControlledOpen,
  trigger,
  orgName: initialOrg = 'calltelemetry',
  appName: initialApp = 'ct-review-bot-app',
  webhookUrl: initialWebhook = 'https://api.calltelemetry.com/api/webhooks/github',
  providers,
  personas,
}: ManifestDrawerProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;
  const setIsOpen = isControlled && setControlledOpen ? setControlledOpen : setInternalOpen;

  const [effectiveProviders, setEffectiveProviders] = React.useState<Record<string, ProviderConfigRecord>>(providers || {});
  const [effectivePersonas, setEffectivePersonas] = React.useState<Record<string, PersonaSetting>>(personas || {});

  React.useEffect(() => {
    if (providers) {
      setEffectiveProviders(providers);
    } else {
      fetchProviders().then((res) => {
        if (res?.providers) setEffectiveProviders(res.providers);
      }).catch(() => {});
    }
  }, [providers]);

  React.useEffect(() => {
    if (personas) {
      setEffectivePersonas(personas);
    } else {
      fetchPersonas().then((res) => {
        if (res) setEffectivePersonas(res);
      }).catch(() => {});
    }
  }, [personas]);

  // Customization state
  const [org, setOrg] = React.useState(initialOrg);
  const [appName, setAppName] = React.useState(initialApp);
  const [webhookUrl, setWebhookUrl] = React.useState(initialWebhook);
  const [webhookSecret, setWebhookSecret] = React.useState('whsec_prod_secret_key_82710');
  const [defaultBranch, setDefaultBranch] = React.useState('main');
  const [spendingCap, setSpendingCap] = React.useState('150');
  const [strictness, setStrictness] = React.useState<'chill' | 'balanced' | 'assertive'>('balanced');

  // Generated GitHub App Manifest JSON object
  const manifestJsonObject = React.useMemo(() => {
    return {
      name: appName,
      url: `https://github.com/${org}`,
      hook_attributes: {
        url: webhookUrl,
        active: true,
      },
      redirect_url: `https://${org}.calltelemetry.com/api/github/manifest-callback`,
      callback_urls: [`https://${org}.calltelemetry.com/api/github/manifest-callback`],
      public: false,
      default_events: [
        'pull_request',
        'pull_request_review',
        'pull_request_review_comment',
        'issue_comment',
        'push',
        'check_run',
        'check_suite',
      ],
      default_permissions: {
        pull_requests: 'write',
        issues: 'write',
        contents: 'read',
        checks: 'write',
        statuses: 'write',
        metadata: 'read',
        organization_hooks: 'read',
      },
    };
  }, [appName, org, webhookUrl]);

  const manifestJsonString = React.useMemo(
    () => JSON.stringify(manifestJsonObject, null, 2),
    [manifestJsonObject]
  );

  // Generated .ct-review.yml configuration content
  const ctReviewYamlString = React.useMemo(() => {
    const activeProviders = getEnabledProviders(effectiveProviders);

    const enabledModelOptions = AVAILABLE_MODEL_OPTIONS.filter((opt) =>
      isModelEnabled(opt.value, effectiveProviders)
    );

    const personasYamlLines = PERSONA_ENSEMBLE_DEFINITIONS.map((def) => {
      const p = effectivePersonas[def.id] || {
        id: def.id,
        displayName: def.name,
        model: def.defaultModel,
        effort: 'low',
        confidenceThreshold: 75,
        enabled: true,
      };

      const isEnabled = p.enabled !== false;
      const rawModel = p.model || def.defaultModel;
      const effectiveModel = getFallbackModelForPersona(rawModel, enabledModelOptions, def.defaultModel);
      const providerId = getProviderIdForModel(effectiveModel);

      return `  ${def.id}:
    enabled: ${isEnabled}
    provider: "${providerId}"
    model: "${effectiveModel}"
    effort: "${p.effort || 'low'}"
    confidence_threshold: ${p.confidenceThreshold || 75}`;
    }).join('\n');

    const providerPriorityYamlLines = activeProviders.map((pId) => `  - "${pId}"`).join('\n');

    return `# CT Review Bot - Organization & Repository Configuration
version: "1.5.0"
organization: "${org}"
app_name: "${appName}"

# Review Enforcement & Strictness Profile
enforcement:
  default_profile: "${strictness}" # chill | balanced | assertive
  auto_review_prs: true
  draft_reviews_enabled: true
  default_branch: "${defaultBranch}"

# Monthly Token Spending Cap ($ USD)
spending_cap:
  monthly_budget_usd: ${spendingCap}
  alert_threshold_percent: 80
  overflow_action: "throttle_non_critical"

# Reviewer Personas Ensemble Configuration (11 Personas)
personas:
${personasYamlLines}

# OmniRoute Failover Chain Order
provider_priority:
${providerPriorityYamlLines}
`;
  }, [org, appName, strictness, defaultBranch, spendingCap, effectiveProviders, effectivePersonas]);

  // Download File Handler
  const handleDownload = (filename: string, content: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleGitHubManifestSubmit = () => {
    const targetUrl = `https://github.com/organizations/${org}/settings/apps/new`;
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = targetUrl;
    form.target = '_blank';

    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'manifest';
    input.value = manifestJsonString;
    form.appendChild(input);

    document.body.appendChild(form);
    form.submit();
    document.body.removeChild(form);
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}

      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col bg-card border-border/80 shadow-2xl p-0">
        <DialogHeader className="p-6 pb-4 border-b border-border/60 bg-muted/20">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-indigo-500/10 text-indigo-400">
                <FileCode className="h-6 w-6" />
              </div>
              <div>
                <DialogTitle className="text-lg font-bold flex items-center gap-2">
                  GitHub App Manifest &amp; YAML Generator
                  <Badge variant="outline" className="bg-indigo-500/10 text-indigo-400 border-indigo-500/30 text-[10px]">
                    v1.5.0
                  </Badge>
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                  Generate copyable 1-click GitHub App Manifest JSON and repository level `.ct-review.yml` config.
                </DialogDescription>
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Quick Customization Controls */}
          <div className="p-4 rounded-xl border border-border/60 bg-muted/30 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
            <div>
              <label className="font-medium text-muted-foreground block mb-1">GitHub Org Name</label>
              <Input
                value={org}
                onChange={(e) => setOrg(e.target.value)}
                placeholder="calltelemetry"
                className="bg-background/80 h-8 text-xs font-mono"
              />
            </div>
            <div>
              <label className="font-medium text-muted-foreground block mb-1">App Name</label>
              <Input
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                placeholder="ct-review-bot-app"
                className="bg-background/80 h-8 text-xs font-mono"
              />
            </div>
            <div>
              <label className="font-medium text-muted-foreground block mb-1">Monthly Spending Cap ($)</label>
              <Input
                type="number"
                value={spendingCap}
                onChange={(e) => setSpendingCap(e.target.value)}
                placeholder="150"
                className="bg-background/80 h-8 text-xs font-mono"
              />
            </div>
          </div>

          {/* Configuration Code Preview Tabs */}
          <Tabs defaultValue="manifest_json" className="space-y-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <TabsList className="bg-muted/50 p-1 border border-border/40">
                <TabsTrigger value="manifest_json" className="text-xs font-semibold gap-2">
                  <FileJson className="h-3.5 w-3.5 text-indigo-400" />
                  GitHub App Manifest (manifest.json)
                </TabsTrigger>
                <TabsTrigger value="ct_review_yml" className="text-xs font-semibold gap-2">
                  <FileCode className="h-3.5 w-3.5 text-emerald-400" />
                  .ct-review.yml Specification
                </TabsTrigger>
              </TabsList>

              <div className="flex items-center gap-2">
                <Button
                  onClick={handleGitHubManifestSubmit}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs gap-1.5 h-8 font-semibold"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Create GitHub App on GitHub
                </Button>
              </div>
            </div>

            {/* Tab 1: Manifest JSON */}
            <TabsContent value="manifest_json" className="space-y-3">
              <div className="flex items-center justify-between bg-muted/40 p-2.5 rounded-t-lg border border-b-0 border-border/60">
                <span className="text-xs font-mono text-muted-foreground flex items-center gap-2">
                  <FileJson className="h-4 w-4 text-indigo-400" />
                  manifest.json
                </span>
                <div className="flex items-center gap-2">
                  <CopyButton value={manifestJsonString} label="Copy JSON" size="sm" />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDownload('manifest.json', manifestJsonString, 'application/json')}
                    className="h-8 text-xs gap-1.5"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download JSON
                  </Button>
                </div>
              </div>
              <pre className="p-4 rounded-b-lg border border-border/60 bg-slate-950 text-slate-100 text-xs font-mono overflow-x-auto max-h-[350px]">
                <code>{manifestJsonString}</code>
              </pre>
            </TabsContent>

            {/* Tab 2: .ct-review.yml */}
            <TabsContent value="ct_review_yml" forceMount className="space-y-3">
              <div className="flex items-center justify-between bg-muted/40 p-2.5 rounded-t-lg border border-b-0 border-border/60">
                <span className="text-xs font-mono text-muted-foreground flex items-center gap-2">
                  <FileCode className="h-4 w-4 text-emerald-400" />
                  .ct-review.yml
                </span>
                <div className="flex items-center gap-2">
                  <CopyButton value={ctReviewYamlString} label="Copy YAML" size="sm" />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDownload('.ct-review.yml', ctReviewYamlString, 'text/yaml')}
                    className="h-8 text-xs gap-1.5"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download YAML
                  </Button>
                </div>
              </div>
              <pre className="p-4 rounded-b-lg border border-border/60 bg-slate-950 text-slate-100 text-xs font-mono overflow-x-auto max-h-[350px]">
                <code>{ctReviewYamlString}</code>
              </pre>
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter className="p-4 border-t border-border/60 bg-muted/20 flex flex-row items-center justify-between sm:justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            <span>Includes 11 reviewer personas &amp; OmniRoute failover rules.</span>
          </div>
          <Button variant="outline" size="sm" onClick={() => setIsOpen(false)} className="text-xs">
            Close Drawer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
