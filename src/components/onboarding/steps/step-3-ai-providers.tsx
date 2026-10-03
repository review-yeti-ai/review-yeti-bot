'use client';

import * as React from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Cpu, CheckCircle2, AlertCircle, RefreshCw, Key, Globe, Eye, EyeOff, Sparkles, Server, HelpCircle } from 'lucide-react';
import { ProviderConfigRecord } from '@/types/dashboard';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';

export const OMNIROUTE_PROVIDERS = [
  { id: 'openai', name: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', name: 'Anthropic Claude', defaultBaseUrl: 'https://api.anthropic.com/v1' },
  { id: 'gemini', name: 'Google Gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { id: 'grok', name: 'xAI Grok', defaultBaseUrl: 'https://api.x.ai/v1' },
  { id: 'deepseek', name: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com/v1' },
  { id: 'glm', name: 'Zhipu GLM', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'doppler', name: 'Doppler Secret Vault', defaultBaseUrl: 'https://api.doppler.com/v3' },
  { id: 'ollama', name: 'Ollama Local Engine', defaultBaseUrl: 'http://localhost:11434/v1' },
  { id: 'custom-openai', name: 'Custom OpenAI-Compatible', defaultBaseUrl: 'https://api.custom-ai.internal/v1' },
  { id: 'codex', name: 'Codex AI Engine', defaultBaseUrl: 'https://codex.calltelemetry.com/v1' },
  { id: 'agy', name: 'AGY Thinking Engine', defaultBaseUrl: 'https://agy.calltelemetry.com/v1' },
];

interface Step3AIProvidersProps {
  providers: Record<string, ProviderConfigRecord>;
  onUpdateProvider: (id: string, patch: Partial<ProviderConfigRecord>) => void;
  onTestProvider: (id: string, payload?: any) => Promise<{ success: boolean; status?: string; latencyMs?: number; message?: string }>;
}

export function Step3AIProviders({
  providers,
  onUpdateProvider,
  onTestProvider,
}: Step3AIProvidersProps) {
  const [showKeys, setShowKeys] = React.useState<Record<string, boolean>>({});
  const [testingStatus, setTestingStatus] = React.useState<
    Record<string, { loading: boolean; success?: boolean; message?: string; latencyMs?: number }>
  >({});

  const toggleShowKey = (id: string) => {
    setShowKeys((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleTestConnection = async (id: string) => {
    setTestingStatus((prev) => ({ ...prev, [id]: { loading: true } }));
    try {
      const res = await onTestProvider(id);
      setTestingStatus((prev) => ({
        ...prev,
        [id]: {
          loading: false,
          success: res.success,
          message: res.message || (res.success ? 'Connected' : 'Connection Failed'),
          latencyMs: res.latencyMs,
        },
      }));
    } catch (err: any) {
      setTestingStatus((prev) => ({
        ...prev,
        [id]: {
          loading: false,
          success: false,
          message: err.message || 'Error testing connection',
        },
      }));
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-indigo-500/10 text-indigo-400">
            <Cpu className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">Step 3: AI Providers &amp; OmniRoute Models</h3>
            <p className="text-xs text-muted-foreground">
              Configure credentials, base URLs, subscription tiers, and active status for all 11 OmniRoute AI providers.
            </p>
          </div>
        </div>

        <Badge variant="outline" className="bg-indigo-500/10 text-indigo-400 border-indigo-500/30 gap-1.5 text-xs">
          <Sparkles className="h-3.5 w-3.5" />
          11 OmniRoute Providers Supported
        </Badge>
      </div>

      {/* Grid of 11 Providers */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {OMNIROUTE_PROVIDERS.map((meta) => {
          const legacyId = meta.id === 'custom-openai' ? 'custom_openai' : meta.id === 'agy' ? 'agy_thinking' : meta.id;
          const provider = providers[meta.id] || providers[legacyId] || {
            id: meta.id,
            displayName: meta.name,
            enabled: true,
            apiKeyRaw: '',
            apiKeyMasked: '****',
            baseUrl: meta.defaultBaseUrl,
            subscriptionTier: 'Pay-as-you-go',
            activeModels: [],
            updatedAt: new Date().toISOString(),
          };

          const isEnabled = provider.enabled !== false;
          const showKey = showKeys[meta.id];
          const testState = testingStatus[meta.id] || {};

          return (
            <Card
              key={meta.id}
              className={`border-border/60 backdrop-blur-sm transition-all duration-200 ${
                isEnabled ? 'bg-card/60 border-indigo-500/20' : 'bg-card/20 opacity-70'
              }`}
            >
              <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
                <div className="flex items-center gap-2.5">
                  <div className="p-1.5 rounded-md bg-indigo-500/10 text-indigo-400">
                    <Server className="h-4 w-4" />
                  </div>
                  <div>
                    <CardTitle className="text-sm font-semibold">{meta.name}</CardTitle>
                    <CardDescription className="text-[11px] font-mono text-muted-foreground">
                      ID: {meta.id}
                    </CardDescription>
                  </div>
                </div>

                <Button
                  variant={isEnabled ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => onUpdateProvider(meta.id, { enabled: !isEnabled })}
                  className={`h-7 text-xs font-semibold px-2.5 ${
                    isEnabled
                      ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {isEnabled ? 'Active' : 'Disabled'}
                </Button>
              </CardHeader>

              <CardContent className="space-y-3 pt-0 text-xs">
                <TooltipProvider>
                  {/* API Key */}
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground flex items-center gap-1 mb-1">
                      API Key
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <HelpCircle className="h-3 w-3 text-muted-foreground/70 hover:text-foreground cursor-pointer" />
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          Encrypted secret API key or service token for {meta.name}.
                        </TooltipContent>
                      </Tooltip>
                    </label>
                    <div className="relative">
                      <Input
                        type={showKey ? 'text' : 'password'}
                        placeholder={`Enter ${meta.name} API Key...`}
                        value={provider.apiKeyRaw || provider.apiKeyMasked || ''}
                        onChange={(e) =>
                          onUpdateProvider(meta.id, {
                            apiKeyRaw: e.target.value,
                            apiKeyMasked: e.target.value ? 'sk-...' : undefined,
                          })
                        }
                        className="bg-background/80 text-xs font-mono pr-8"
                      />
                      <button
                        type="button"
                        onClick={() => toggleShowKey(meta.id)}
                        className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                      >
                        {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>

                  {/* Base URL & Subscription Tier */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <label className="text-[11px] font-medium text-muted-foreground flex items-center gap-1 mb-1">
                        Base URL
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <HelpCircle className="h-3 w-3 text-muted-foreground/70 hover:text-foreground cursor-pointer" />
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            Target HTTP endpoint for provider REST calls (e.g. {meta.defaultBaseUrl}).
                          </TooltipContent>
                        </Tooltip>
                      </label>
                      <Input
                        placeholder={meta.defaultBaseUrl}
                        value={provider.baseUrl || ''}
                        onChange={(e) => onUpdateProvider(meta.id, { baseUrl: e.target.value })}
                        className="bg-background/80 text-[11px] font-mono"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] font-medium text-muted-foreground flex items-center gap-1 mb-1">
                        Subscription Tier
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <HelpCircle className="h-3 w-3 text-muted-foreground/70 hover:text-foreground cursor-pointer" />
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            Rate limit allocation tier (Free, Pay-as-you-go, Pro, Team, Enterprise).
                          </TooltipContent>
                        </Tooltip>
                      </label>
                      <Select
                        value={provider.subscriptionTier || 'Pay-as-you-go'}
                        onValueChange={(val: any) => onUpdateProvider(meta.id, { subscriptionTier: val })}
                      >
                        <SelectTrigger className="h-8 text-xs bg-background/80">
                          <SelectValue placeholder="Tier" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Free">Free</SelectItem>
                          <SelectItem value="Pay-as-you-go">Pay-as-you-go</SelectItem>
                          <SelectItem value="Pro">Pro</SelectItem>
                          <SelectItem value="Team">Team</SelectItem>
                          <SelectItem value="Enterprise">Enterprise</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </TooltipProvider>

                {/* Test Connection Action */}
                <div className="pt-2 flex items-center justify-between border-t border-border/40">
                  <div className="flex items-center gap-2">
                    {testState.success !== undefined && (
                      <Badge
                        variant="outline"
                        className={`text-[10px] gap-1 ${
                          testState.success
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                            : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                        }`}
                      >
                        {testState.success ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : (
                          <AlertCircle className="h-3 w-3" />
                        )}
                        {testState.message} {testState.latencyMs ? `(${testState.latencyMs}ms)` : ''}
                      </Badge>
                    )}
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleTestConnection(meta.id)}
                    disabled={testState.loading || !isEnabled}
                    className="h-7 text-[11px] gap-1.5"
                  >
                    {testState.loading ? (
                      <RefreshCw className="h-3 w-3 animate-spin text-indigo-400" />
                    ) : (
                      <Sparkles className="h-3 w-3 text-indigo-400" />
                    )}
                    Test Connection
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
