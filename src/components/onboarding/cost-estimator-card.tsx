'use client';

import * as React from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { DollarSign, Calculator, Sliders, ShieldAlert, CheckCircle2, TrendingUp, Sparkles, AlertTriangle } from 'lucide-react';

import { ProviderConfigRecord, PersonaSetting, ModelRegistryItem } from '@/types/dashboard';
import { isProviderEnabled } from '@/lib/model-filtering';
import { fetchProviders } from '@/lib/api-client';

export interface SpendingCapSettings {
  monthlyCapUsd: number;
  alertThresholdPercent: number;
  overflowAction: 'throttle_non_critical' | 'notify_admin' | 'hard_cap_stop';
}

export interface SpendingCapModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: SpendingCapSettings;
  onSaveSettings: (settings: SpendingCapSettings) => void;
}

export function SpendingCapModal({
  open,
  onOpenChange,
  settings: initialSettings,
  onSaveSettings,
}: SpendingCapModalProps) {
  const [capUsd, setCapUsd] = React.useState(initialSettings.monthlyCapUsd);
  const [alertThreshold, setAlertThreshold] = React.useState(initialSettings.alertThresholdPercent);
  const [overflowAction, setOverflowAction] = React.useState(initialSettings.overflowAction);
  const [savedSuccess, setSavedSuccess] = React.useState(false);

  React.useEffect(() => {
    setCapUsd(initialSettings.monthlyCapUsd);
    setAlertThreshold(initialSettings.alertThresholdPercent);
    setOverflowAction(initialSettings.overflowAction);
  }, [initialSettings, open]);

  const handleSave = () => {
    onSaveSettings({
      monthlyCapUsd: capUsd,
      alertThresholdPercent: alertThreshold,
      overflowAction,
    });
    setSavedSuccess(true);
    setTimeout(() => {
      setSavedSuccess(false);
      onOpenChange(false);
    }, 1000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md bg-card border-border/80 shadow-2xl p-0 overflow-hidden">
        <DialogHeader className="p-6 pb-4 border-b border-border/60 bg-muted/20">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-emerald-500/10 text-emerald-400">
              <DollarSign className="h-6 w-6" />
            </div>
            <div>
              <DialogTitle className="text-base font-bold">Configure Organization Spending Cap</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Set monthly budget ceilings and automatic failover actions for AI model token consumption.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="p-6 space-y-4 text-xs">
          <div>
            <label className="font-semibold text-foreground block mb-1">
              Monthly Budget Limit ($ USD)
            </label>
            <div className="relative">
              <span className="absolute left-3 top-2.5 text-muted-foreground font-mono">$</span>
              <Input
                type="number"
                min="10"
                max="10000"
                value={capUsd}
                onChange={(e) => setCapUsd(Number(e.target.value))}
                className="pl-7 bg-background/80 font-mono text-sm"
              />
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              Maximum allowed token expenditure across all 11 reviewer personas per month.
            </p>
          </div>

          <div>
            <label className="font-semibold text-foreground block mb-1">
              Email &amp; Slack Alert Threshold ({alertThreshold}%)
            </label>
            <input
              type="range"
              min="50"
              max="95"
              step="5"
              value={alertThreshold}
              onChange={(e) => setAlertThreshold(Number(e.target.value))}
              className="w-full accent-emerald-500 cursor-pointer"
            />
            <div className="flex justify-between text-[10px] font-mono text-muted-foreground mt-0.5">
              <span>50%</span>
              <span className="text-emerald-400 font-semibold">{alertThreshold}% (${Math.round((capUsd * alertThreshold) / 100)})</span>
              <span>95%</span>
            </div>
          </div>

          <div>
            <label className="font-semibold text-foreground block mb-1">
              Budget Exhaustion Action
            </label>
            <Select
              value={overflowAction}
              onValueChange={(val: any) => setOverflowAction(val)}
            >
              <SelectTrigger className="bg-background/80 text-xs">
                <SelectValue placeholder="Select action" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="throttle_non_critical">
                  Throttle Non-Critical Personas (Fallback to fast models)
                </SelectItem>
                <SelectItem value="notify_admin">
                  Notify Admin Only (Continue reviews)
                </SelectItem>
                <SelectItem value="hard_cap_stop">
                  Hard Cap Stop (Pause automated reviews until next cycle)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {savedSuccess && (
            <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" />
              <span>Spending cap settings saved successfully!</span>
            </div>
          )}
        </div>

        <DialogFooter className="p-4 border-t border-border/60 bg-muted/20 flex items-center justify-between">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} className="text-xs">
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs gap-1.5"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Save Spending Cap
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface CostEstimatorCardProps {
  providers?: Record<string, ProviderConfigRecord>;
  personas?: Record<string, PersonaSetting>;
  modelRegistry?: Record<string, ModelRegistryItem>;
}

interface PresetDefinition {
  id: 'budget' | 'balanced' | 'premium' | 'max_reasoning';
  ratePer1M: number;
  label: string;
  description: string;
  requiredProviders: string[];
}

const ALL_PRESETS: PresetDefinition[] = [
  {
    id: 'budget',
    ratePer1M: 0.8,
    label: 'Budget (GPT-4o Mini + DeepSeek V3)',
    description: 'Ideal for small teams and public open-source repos',
    requiredProviders: ['openai', 'deepseek'],
  },
  {
    id: 'balanced',
    ratePer1M: 3.5,
    label: 'Balanced (Claude 3.5 Sonnet + GPT-4o + Grok)',
    description: 'Standard enterprise blend for 11 reviewer personas',
    requiredProviders: ['anthropic', 'openai', 'grok'],
  },
  {
    id: 'premium',
    ratePer1M: 8.5,
    label: 'Premium (Claude 3.7 Sonnet + Grok 4.5)',
    description: 'Deep security and architectural code inspection',
    requiredProviders: ['anthropic', 'grok'],
  },
  {
    id: 'max_reasoning',
    ratePer1M: 15.0,
    label: 'Max Reasoning (AGY Opus Thinking + Codex GPT-5.6)',
    description: 'Maximum multi-pass reasoning and formal verification',
    requiredProviders: ['agy', 'codex'],
  },
];

export function CostEstimatorCard({ providers, personas, modelRegistry }: CostEstimatorCardProps = {}) {
  const [monthlyPrs, setMonthlyPrs] = React.useState(120);
  const [tokensPerPr, setTokensPerPr] = React.useState(25000); // 25k tokens per PR
  const [ensemblePreset, setEnsemblePreset] = React.useState<'budget' | 'balanced' | 'premium' | 'max_reasoning'>('balanced');
  const [modalOpen, setModalOpen] = React.useState(false);

  const [effectiveProviders, setEffectiveProviders] = React.useState<Record<string, ProviderConfigRecord>>(providers || {});

  React.useEffect(() => {
    if (providers) {
      setEffectiveProviders(providers);
    } else {
      fetchProviders().then((res) => {
        if (res?.providers) setEffectiveProviders(res.providers);
      }).catch(() => {});
    }
  }, [providers]);

  const enabledPresets = React.useMemo(() => {
    return ALL_PRESETS.filter((preset) =>
      preset.requiredProviders.every((pId) => isProviderEnabled(pId, effectiveProviders))
    );
  }, [effectiveProviders]);

  const currentPreset = enabledPresets.find((p) => p.id === ensemblePreset) || enabledPresets[0] || null;

  React.useEffect(() => {
    if (enabledPresets.length > 0 && !enabledPresets.some((p) => p.id === ensemblePreset)) {
      setEnsemblePreset(enabledPresets[0].id);
    }
  }, [enabledPresets, ensemblePreset]);

  const [capSettings, setCapSettings] = React.useState<SpendingCapSettings>({
    monthlyCapUsd: 150,
    alertThresholdPercent: 80,
    overflowAction: 'throttle_non_critical',
  });

  const totalMonthlyTokens = monthlyPrs * tokensPerPr;
  const estimatedMonthlyCost = currentPreset ? (totalMonthlyTokens / 1_000_000) * currentPreset.ratePer1M : 0;
  const costPerPr = estimatedMonthlyCost / (monthlyPrs || 1);

  const isOverCap = estimatedMonthlyCost > capSettings.monthlyCapUsd;

  return (
    <Card className="border-border/60 bg-card/80 backdrop-blur-xl shadow-lg">
      <CardHeader className="pb-3 border-b border-border/40">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-emerald-500/10 text-emerald-400">
              <Calculator className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base font-bold flex items-center gap-2">
                Interactive Model Token Cost Estimator
                <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 text-[10px]">
                  Real-time Pricing
                </Badge>
              </CardTitle>
              <CardDescription className="text-xs text-muted-foreground">
                Estimate monthly token usage and set organization budget spending caps.
              </CardDescription>
            </div>
          </div>

          <Button
            onClick={() => setModalOpen(true)}
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs font-semibold border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"
          >
            <DollarSign className="h-3.5 w-3.5" />
            Configure Spending Cap (${capSettings.monthlyCapUsd}/mo)
          </Button>
        </div>
      </CardHeader>

      <CardContent className="p-6 space-y-6">
        {enabledPresets.length === 0 ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 flex items-center gap-3 text-amber-300 text-sm font-medium">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
            <span>Active provider configurations are required to calculate token cost estimates. Please enable at least one provider preset.</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Inputs Section */}
          <div className="md:col-span-2 space-y-4 text-xs">
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="font-semibold text-foreground">
                  Estimated Monthly Pull Requests: <strong className="text-indigo-400">{monthlyPrs} PRs / mo</strong>
                </label>
              </div>
              <input
                type="range"
                min="10"
                max="1000"
                step="10"
                value={monthlyPrs}
                onChange={(e) => setMonthlyPrs(Number(e.target.value))}
                className="w-full accent-indigo-500 cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground font-mono mt-0.5">
                <span>10 PRs</span>
                <span>500 PRs</span>
                <span>1,000 PRs</span>
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="font-semibold text-foreground">
                  Average Tokens per PR: <strong className="text-indigo-400">{(tokensPerPr / 1000).toFixed(0)}k tokens</strong>
                </label>
              </div>
              <input
                type="range"
                min="5000"
                max="100000"
                step="5000"
                value={tokensPerPr}
                onChange={(e) => setTokensPerPr(Number(e.target.value))}
                className="w-full accent-indigo-500 cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground font-mono mt-0.5">
                <span>5k (Small PR)</span>
                <span>50k (Medium PR)</span>
                <span>100k (Large PR)</span>
              </div>
            </div>

            <div>
              <label className="font-semibold text-foreground block mb-1">
                Persona Model Ensemble Tier Preset
              </label>
              <Select
                value={currentPreset.id}
                onValueChange={(val: any) => setEnsemblePreset(val)}
              >
                <SelectTrigger className="bg-background/80 text-xs">
                  <SelectValue placeholder="Select Ensemble Preset" />
                </SelectTrigger>
                <SelectContent>
                  {enabledPresets.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">
                {currentPreset.description}
              </p>
            </div>
          </div>

          {/* Results Summary Box */}
          <div className="rounded-xl border border-border/80 bg-muted/30 p-4 flex flex-col justify-between space-y-4">
            <div className="space-y-3">
              <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                <TrendingUp className="h-4 w-4 text-emerald-400" />
                Monthly Cost Estimate Summary
              </span>

              <div>
                <span className="text-3xl font-extrabold text-foreground tracking-tight font-mono">
                  ${estimatedMonthlyCost.toFixed(2)}
                </span>
                <span className="text-xs text-muted-foreground ml-1">/ month</span>
              </div>

              <div className="space-y-1.5 text-xs pt-2 border-t border-border/40 font-mono">
                <div className="flex justify-between text-muted-foreground">
                  <span>Total Tokens:</span>
                  <strong className="text-foreground">{(totalMonthlyTokens / 1_000_000).toFixed(2)}M tokens</strong>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>Avg Cost per PR:</span>
                  <strong className="text-emerald-400">${costPerPr.toFixed(3)}</strong>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>Spending Cap:</span>
                  <strong className="text-foreground">${capSettings.monthlyCapUsd}.00</strong>
                </div>
              </div>
            </div>

            {isOverCap ? (
              <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 text-[11px] flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>Estimated cost exceeds monthly spending cap!</span>
              </div>
            ) : (
              <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[11px] flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>Within configured monthly budget cap.</span>
              </div>
            )}
          </div>
        </div>
      )}
    </CardContent>

      <SpendingCapModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        settings={capSettings}
        onSaveSettings={setCapSettings}
      />
    </Card>
  );
}
