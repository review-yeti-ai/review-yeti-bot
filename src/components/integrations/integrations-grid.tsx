'use client';

import * as React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { IntegrationItem, McpServerConfig } from '@/types/dashboard';
import { updateIntegration, testIntegration } from '@/lib/api-client';
import {
  Blocks,
  CheckCircle,
  AlertCircle,
  Plug,
  Server,
  RefreshCw,
  Key,
  ShieldCheck,
  KeyRound,
  ShieldAlert,
  Ticket,
  MessageSquare,
  GitBranch,
  Search,
  Check,
  Loader2,
} from 'lucide-react';

interface IntegrationsGridProps {
  integrations?: IntegrationItem[];
  mcpServers?: McpServerConfig[];
}

export function IntegrationsGrid({ integrations = [], mcpServers = [] }: IntegrationsGridProps) {
  const [items, setItems] = React.useState<IntegrationItem[]>(integrations);

  React.useEffect(() => {
    if (integrations && integrations.length > 0) {
      setItems(integrations);
    }
  }, [integrations]);

  const [selectedIntegration, setSelectedIntegration] = React.useState<IntegrationItem | null>(null);

  // Form field state for service-specific credentials
  const [apiKeyInput, setApiKeyInput] = React.useState('');
  const [secretInput, setSecretInput] = React.useState('');
  const [hostUrlInput, setHostUrlInput] = React.useState('');
  const [emailInput, setEmailInput] = React.useState('');
  const [orgSlugInput, setOrgSlugInput] = React.useState('');
  const [projectSlugInput, setProjectSlugInput] = React.useState('');
  const [webhookUrlInput, setWebhookUrlInput] = React.useState('');
  const [channelInput, setChannelInput] = React.useState('');
  const [dopplerProjectInput, setDopplerProjectInput] = React.useState('');
  const [dopplerConfigInput, setDopplerConfigInput] = React.useState('');

  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ success: boolean; message: string; latencyMs?: number } | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (integrations.length > 0) {
      setItems((prev) => {
        // Merge provided integrations while ensuring doppler, sentry, jira, slack exist
        const map = new Map(prev.map((i) => [i.id, i]));
        integrations.forEach((item) => map.set(item.id, item));
        return Array.from(map.values());
      });
    }
  }, [integrations]);

  const handleOpenConfig = (item: IntegrationItem) => {
    setSelectedIntegration(item);
    setApiKeyInput(item.apiKeyMasked || item.oauthClientId || '');
    setSecretInput('');
    setHostUrlInput(item.settings?.hostUrl || 'https://calltelemetry.atlassian.net');
    setEmailInput(item.settings?.email || 'bot@calltelemetry.com');
    setOrgSlugInput(item.settings?.orgSlug || 'calltelemetry');
    setProjectSlugInput(item.settings?.projectSlug || 'review-bot');
    setWebhookUrlInput(item.webhookUrl || 'https://hooks.slack.com/services/T00/B00/X00');
    setChannelInput(item.settings?.defaultChannel || '#code-reviews');
    setDopplerProjectInput(item.settings?.project || 'ct-review-bot');
    setDopplerConfigInput(item.settings?.configName || 'prd');
    setTestResult(null);
  };

  const getPayloadForCurrentPlatform = () => {
    if (!selectedIntegration) return {};
    switch (selectedIntegration.id) {
      case 'doppler':
        return {
          apiKey: apiKeyInput,
          settings: { project: dopplerProjectInput, configName: dopplerConfigInput },
        };
      case 'sentry':
        return {
          apiKey: apiKeyInput,
          settings: { orgSlug: orgSlugInput, projectSlug: projectSlugInput },
        };
      case 'jira':
        return {
          apiKey: apiKeyInput,
          settings: { hostUrl: hostUrlInput, email: emailInput, projectKey: dopplerProjectInput || 'CT' },
        };
      case 'slack':
        return {
          apiKey: apiKeyInput,
          webhookUrl: webhookUrlInput,
          settings: { defaultChannel: channelInput },
        };
      default:
        return {
          apiKey: apiKeyInput,
          oauthClientSecret: secretInput,
        };
    }
  };

  const handleTestConnection = async () => {
    if (!selectedIntegration) return;
    setTesting(true);
    setTestResult(null);

    // Optimistically update status to 'verifying'
    setItems((prev) =>
      prev.map((i) => (i.id === selectedIntegration.id ? { ...i, status: 'verifying' } : i))
    );

    try {
      const payload = getPayloadForCurrentPlatform();
      const res = await testIntegration(selectedIntegration.id, payload);
      setTestResult({
        success: res.success,
        message: res.message || `Connection to ${selectedIntegration.name} verified!`,
        latencyMs: res.latencyMs,
      });

      if (res.success) {
        setItems((prev) =>
          prev.map((i) => (i.id === selectedIntegration.id ? { ...i, status: 'connected', lastSyncAt: 'Just now' } : i))
        );
      } else {
        setItems((prev) =>
          prev.map((i) => (i.id === selectedIntegration.id ? { ...i, status: 'error' } : i))
        );
      }
    } catch (err: any) {
      setTestResult({
        success: false,
        message: err?.message || 'Connection verification failed.',
      });
      setItems((prev) =>
        prev.map((i) => (i.id === selectedIntegration.id ? { ...i, status: 'error' } : i))
      );
    } finally {
      setTesting(false);
    }
  };

  const handleSaveCredential = async () => {
    if (!selectedIntegration) return;
    setSaving(true);
    const payload = getPayloadForCurrentPlatform();
    try {
      const updated = await updateIntegration(selectedIntegration.id, payload);
      setItems((prev) =>
        prev.map((i) =>
          i.id === selectedIntegration.id
            ? {
                ...i,
                ...updated,
                status: 'connected',
                apiKeyMasked: apiKeyInput ? apiKeyInput.slice(0, 8) + '...' : i.apiKeyMasked,
                lastSyncAt: 'Just now',
              }
            : i
        )
      );
      setSelectedIntegration(null);
    } catch (err: any) {
      setItems((prev) =>
        prev.map((i) =>
          i.id === selectedIntegration.id
            ? {
                ...i,
                status: 'error',
              }
            : i
        )
      );
      setTestResult({
        success: false,
        message: err?.message || `Failed to save credentials for ${selectedIntegration.name}`,
      });
    } finally {
      setSaving(false);
    }
  };

  const getIntegrationIcon = (id: string) => {
    switch (id) {
      case 'doppler':
        return <KeyRound className="h-4 w-4 text-emerald-400" />;
      case 'sentry':
        return <ShieldAlert className="h-4 w-4 text-rose-400" />;
      case 'jira':
        return <Ticket className="h-4 w-4 text-cyan-400" />;
      case 'slack':
        return <MessageSquare className="h-4 w-4 text-indigo-400" />;
      case 'linear':
        return <GitBranch className="h-4 w-4 text-purple-400" />;
      case 'context7':
        return <Search className="h-4 w-4 text-amber-400" />;
      default:
        return <Blocks className="h-4 w-4 text-indigo-400" />;
    }
  };

  const renderStatusBadge = (status: string) => {
    switch (status) {
      case 'connected':
        return <Badge variant="success" className="text-[10px]">Connected</Badge>;
      case 'verifying':
        return <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-500/30 animate-pulse">Verifying...</Badge>;
      case 'error':
        return <Badge variant="destructive" className="text-[10px]">Error</Badge>;
      case 'configuring':
        return <Badge variant="outline" className="text-[10px] text-indigo-400">Configuring</Badge>;
      case 'disconnected':
      default:
        return <Badge variant="secondary" className="text-[10px]">Disconnected</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold tracking-tight text-foreground mb-3 flex items-center gap-2">
          <Blocks className="h-4 w-4 text-amber-400" />
          Service Integrations & Connection Manager
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {items.map((item) => (
            <Card
              key={item.id}
              className="glass-panel border-border/80 p-4 hover:border-indigo-500/50 transition-all duration-200"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-2.5">
                  <div className="p-2 rounded-lg bg-muted/40 border border-border/60 mt-0.5">
                    {getIntegrationIcon(item.id)}
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-foreground">{item.name}</h4>
                    <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                      {item.apiKeyMasked || item.oauthClientId || (item.webhookUrl ? 'Webhook configured' : 'Not configured')}
                    </p>
                  </div>
                </div>
                {renderStatusBadge(item.status)}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 mt-4 pt-3 border-t border-border/40 text-xs text-muted-foreground">
                <span>Last Sync: {item.lastSyncAt || 'Never'}</span>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleOpenConfig(item)}
                  className="h-7 text-[11px] gap-1"
                >
                  <Key className="w-3 h-3 text-amber-400" />
                  Configure
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* Modal Dialog for Service Credential Editing */}
      {selectedIntegration && (
        <Dialog open={!!selectedIntegration} onOpenChange={(open) => !open && setSelectedIntegration(null)}>
          <DialogContent className="max-w-lg bg-card border-border p-6 text-foreground">
            <DialogHeader className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
                  {getIntegrationIcon(selectedIntegration.id)}
                </div>
                <div>
                  <DialogTitle className="text-lg font-bold">
                    Configure {selectedIntegration.name}
                  </DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground">
                    Enter service API keys or webhook endpoint configuration to connect.
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="space-y-4 my-2 text-xs">
              {/* Service-Specific Form Inputs */}
              {selectedIntegration.id === 'doppler' && (
                <>
                  <div className="space-y-1">
                    <label className="font-semibold text-muted-foreground">Doppler Service Token</label>
                    <Input
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder="dp.pt.xxxxxxxxxxxxxxxx"
                      className="font-mono text-xs bg-muted/30"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="font-semibold text-muted-foreground">Project Name</label>
                      <Input
                        value={dopplerProjectInput}
                        onChange={(e) => setDopplerProjectInput(e.target.value)}
                        placeholder="ct-review-bot"
                        className="font-mono text-xs bg-muted/30"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="font-semibold text-muted-foreground">Environment Config</label>
                      <Input
                        value={dopplerConfigInput}
                        onChange={(e) => setDopplerConfigInput(e.target.value)}
                        placeholder="prd"
                        className="font-mono text-xs bg-muted/30"
                      />
                    </div>
                  </div>
                </>
              )}

              {selectedIntegration.id === 'sentry' && (
                <>
                  <div className="space-y-1">
                    <label className="font-semibold text-muted-foreground">Sentry User Auth Token</label>
                    <Input
                      type="password"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder="sntry_xxxxxxxxxxxxxxxx"
                      className="font-mono text-xs bg-muted/30"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="font-semibold text-muted-foreground">Organization Slug</label>
                      <Input
                        value={orgSlugInput}
                        onChange={(e) => setOrgSlugInput(e.target.value)}
                        placeholder="calltelemetry"
                        className="font-mono text-xs bg-muted/30"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="font-semibold text-muted-foreground">Project Slug</label>
                      <Input
                        value={projectSlugInput}
                        onChange={(e) => setProjectSlugInput(e.target.value)}
                        placeholder="review-bot"
                        className="font-mono text-xs bg-muted/30"
                      />
                    </div>
                  </div>
                </>
              )}

              {selectedIntegration.id === 'jira' && (
                <>
                  <div className="space-y-1">
                    <label className="font-semibold text-muted-foreground">Jira Host URL</label>
                    <Input
                      value={hostUrlInput}
                      onChange={(e) => setHostUrlInput(e.target.value)}
                      placeholder="https://calltelemetry.atlassian.net"
                      className="font-mono text-xs bg-muted/30"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="font-semibold text-muted-foreground">Atlassian Account Email</label>
                      <Input
                        value={emailInput}
                        onChange={(e) => setEmailInput(e.target.value)}
                        placeholder="bot@calltelemetry.com"
                        className="font-mono text-xs bg-muted/30"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="font-semibold text-muted-foreground">API Token</label>
                      <Input
                        type="password"
                        value={apiKeyInput}
                        onChange={(e) => setApiKeyInput(e.target.value)}
                        placeholder="ATATT3..."
                        className="font-mono text-xs bg-muted/30"
                      />
                    </div>
                  </div>
                </>
              )}

              {selectedIntegration.id === 'slack' && (
                <>
                  <div className="space-y-1">
                    <label className="font-semibold text-muted-foreground">Slack Bot User OAuth Token</label>
                    <Input
                      type="password"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder="xoxb-xxxxxxxxxxxx"
                      className="font-mono text-xs bg-muted/30"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-muted-foreground">Incoming Webhook URL</label>
                    <Input
                      value={webhookUrlInput}
                      onChange={(e) => setWebhookUrlInput(e.target.value)}
                      placeholder="https://hooks.slack.com/services/..."
                      className="font-mono text-xs bg-muted/30"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-muted-foreground">Default Notification Channel</label>
                    <Input
                      value={channelInput}
                      onChange={(e) => setChannelInput(e.target.value)}
                      placeholder="#code-reviews"
                      className="font-mono text-xs bg-muted/30"
                    />
                  </div>
                </>
              )}

              {/* Default / Fallback form fields */}
              {!['doppler', 'sentry', 'jira', 'slack'].includes(selectedIntegration.id) && (
                <>
                  <div className="space-y-1">
                    <label className="font-semibold text-muted-foreground block">
                      API Key / Client ID
                    </label>
                    <Input
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder="e.g. lin_api_secret_key"
                      className="font-mono text-xs bg-muted/30"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-muted-foreground block">
                      Secret Key / Signing Token
                    </label>
                    <Input
                      type="password"
                      value={secretInput}
                      onChange={(e) => setSecretInput(e.target.value)}
                      placeholder="••••••••••••••••"
                      className="font-mono text-xs bg-muted/30"
                    />
                  </div>
                </>
              )}

              {testResult && (
                <div
                  className={`p-3 rounded-md border text-xs font-mono flex items-center justify-between gap-2 ${
                    testResult.success
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                      : 'bg-red-500/10 border-red-500/30 text-red-400'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {testResult.success ? (
                      <CheckCircle className="h-4 w-4 shrink-0 text-emerald-400" />
                    ) : (
                      <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
                    )}
                    <span>{testResult.message}</span>
                  </div>
                  {testResult.latencyMs && (
                    <span className="text-[10px] opacity-80">{testResult.latencyMs}ms</span>
                  )}
                </div>
              )}
            </div>

            <DialogFooter className="gap-2 pt-2 border-t border-border/60">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTestConnection}
                disabled={testing}
                className="text-xs gap-1.5"
              >
                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {testing ? 'Testing...' : 'Test Connection'}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleSaveCredential}
                disabled={saving}
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs gap-1.5"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                {saving ? 'Saving...' : 'Save & Connect'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <div>
        <h3 className="text-sm font-semibold tracking-tight text-foreground mb-3 flex items-center gap-2">
          <Server className="h-4 w-4 text-purple-400" />
          MCP (Model Context Protocol) Server Fleet
        </h3>
        <Card className="glass-panel border-border/80 p-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-border/40 pb-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <Plug className="h-4 w-4 text-indigo-400" />
                <span>Registered MCP Servers ({mcpServers.length})</span>
              </div>
            </div>

            {mcpServers.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">
                No external MCP servers registered. Local vector search adapter active.
              </p>
            ) : (
              <div className="space-y-2">
                {mcpServers.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between p-2.5 rounded bg-background/60 border border-border/60 text-xs"
                  >
                    <div>
                      <span className="font-semibold text-foreground">{s.name}</span>
                      <span className="ml-2 font-mono text-[11px] text-muted-foreground">({s.transport})</span>
                    </div>
                    <Badge variant={s.status === 'online' ? 'success' : 'outline'} className="text-[10px]">
                      {s.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
