'use client';

import * as React from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Shield,
  Key,
  Globe,
  Upload,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Copy,
  Lock,
  HelpCircle,
} from 'lucide-react';
import { GitHubAppConfig } from '@/types/dashboard';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { CopyButton } from '@/components/ui/copy-button';

interface Step1GitHubAppProps {
  config: Partial<GitHubAppConfig>;
  onUpdateConfig: (patch: Partial<GitHubAppConfig>) => void;
  onVerify: () => Promise<void>;
  loading?: boolean;
}

export function Step1GitHubApp({
  config,
  onUpdateConfig,
  onVerify,
  loading = false,
}: Step1GitHubAppProps) {
  const [copied, setCopied] = React.useState(false);
  const [dragActive, setDragActive] = React.useState(false);
  const [verifying, setVerifying] = React.useState(false);
  const [verifyStatus, setVerifyStatus] = React.useState<{
    success?: boolean;
    message?: string;
  }>({});

  const defaultWebhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/webhooks/github`
      : 'https://api.calltelemetry.com/api/webhooks/github';

  const webhookUrl = config.webhookSecretConfigured ? (config as any).webhookUrl || defaultWebhookUrl : defaultWebhookUrl;

  const handleCopyWebhook = () => {
    navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handlePemFileUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (content) {
        onUpdateConfig({
          privateKeyPemRaw: content,
          privateKeyConfigured: true,
        });
      }
    };
    reader.readAsText(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handlePemFileUpload(e.dataTransfer.files[0]);
    }
  };

  const handleRunVerification = async () => {
    setVerifying(true);
    setVerifyStatus({});
    try {
      await onVerify();
      setVerifyStatus({
        success: true,
        message: 'RS256 Private Key & Webhook Secret verified successfully!',
      });
    } catch (err: any) {
      setVerifyStatus({
        success: false,
        message: err.message || 'Verification failed. Please check credentials.',
      });
    } finally {
      setVerifying(false);
    }
  };

  const manifestUrl = `https://github.com/settings/apps/new?state=ct_review_wizard`;

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-indigo-500/10 text-indigo-400">
            <Shield className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">Step 1: GitHub Organization Connection</h3>
            <p className="text-xs text-muted-foreground">
              Register GitHub App manifest, configure Webhook delivery, and upload RS256 Private Key (.pem).
            </p>
          </div>
        </div>

        <Button
          asChild
          className="bg-indigo-600 hover:bg-indigo-500 text-white gap-2 shrink-0 text-xs font-semibold"
        >
          <a href={manifestUrl} target="_blank" rel="noreferrer">
            <ExternalLink className="h-4 w-4" />
            Install GitHub App on Org
          </a>
        </Button>
      </div>

      {/* Grid Layout for Configuration Fields */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* App IDs & Webhook Card */}
        <Card className="border-border/60 bg-card/50 backdrop-blur-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Globe className="h-4 w-4 text-indigo-400" />
              App Registration &amp; Webhook Credentials
            </CardTitle>
            <CardDescription className="text-xs">
              Identifiers and Webhook endpoint created during GitHub App registration
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <TooltipProvider>
              <div>
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5 mb-1">
                  GitHub App ID
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/70 hover:text-foreground cursor-pointer" />
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      Numeric ID generated by GitHub when registering your App (e.g. 1048293).
                    </TooltipContent>
                  </Tooltip>
                </label>
                <Input
                  placeholder="e.g. 1048293"
                  value={config.appId || ''}
                  onChange={(e) => onUpdateConfig({ appId: e.target.value })}
                  className="bg-background/80 text-xs font-mono"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5 mb-1">
                  Installation ID
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/70 hover:text-foreground cursor-pointer" />
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      Specific organization installation identifier after installing the App onto your GitHub Org.
                    </TooltipContent>
                  </Tooltip>
                </label>
                <Input
                  placeholder="e.g. 5829104"
                  value={config.installationId || ''}
                  onChange={(e) => onUpdateConfig({ installationId: e.target.value })}
                  className="bg-background/80 text-xs font-mono"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5 mb-1">
                  Webhook Target URL (`/api/webhooks/github`)
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/70 hover:text-foreground cursor-pointer" />
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      Target HTTP payload URL for GitHub pull_request and check_run webhook events.
                    </TooltipContent>
                  </Tooltip>
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={webhookUrl}
                    className="bg-muted/40 text-xs font-mono text-muted-foreground"
                  />
                  <CopyButton value={webhookUrl} label="Copy" size="sm" className="shrink-0 text-xs" />
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5 mb-1">
                  Webhook Secret Key (`webhookSecret`)
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/70 hover:text-foreground cursor-pointer" />
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      HMAC SHA256 signature secret used to verify webhook payload authenticity.
                    </TooltipContent>
                  </Tooltip>
                </label>
                <div className="relative">
                  <Input
                    type="password"
                    placeholder="whsec_..."
                    value={config.webhookSecretRaw || ''}
                    onChange={(e) =>
                      onUpdateConfig({
                        webhookSecretRaw: e.target.value,
                        webhookSecretConfigured: Boolean(e.target.value),
                      })
                    }
                    className="bg-background/80 text-xs font-mono pr-8"
                  />
                  <Lock className="h-3.5 w-3.5 text-muted-foreground absolute right-2.5 top-2.5" />
                </div>
              </div>
            </TooltipProvider>
          </CardContent>
        </Card>

        {/* RS256 Private Key PEM Dropzone Card */}
        <Card className="border-border/60 bg-card/50 backdrop-blur-sm flex flex-col justify-between">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Key className="h-4 w-4 text-emerald-400" />
              RS256 Private Key Upload (.pem)
            </CardTitle>
            <CardDescription className="text-xs">
              Upload GitHub App private key for authenticating API requests and signing JWTs
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-xl p-6 text-center transition-all duration-200 cursor-pointer ${
                dragActive
                  ? 'border-indigo-500 bg-indigo-500/10'
                  : config.privateKeyConfigured
                  ? 'border-emerald-500/40 bg-emerald-500/5'
                  : 'border-border/80 bg-background/40 hover:border-indigo-500/50'
              }`}
            >
              <input
                type="file"
                accept=".pem,.key,.txt"
                id="pem-file-input"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    handlePemFileUpload(e.target.files[0]);
                  }
                }}
              />
              <label htmlFor="pem-file-input" className="cursor-pointer block">
                <div className="mx-auto w-10 h-10 rounded-full bg-muted/60 flex items-center justify-center mb-3 text-muted-foreground">
                  <Upload className="h-5 w-5" />
                </div>
                <p className="text-xs font-medium text-foreground">
                  {config.privateKeyConfigured ? (
                    <span className="text-emerald-400 font-semibold flex items-center justify-center gap-1.5">
                      <CheckCircle2 className="h-4 w-4" />
                      RS256 Private Key Loaded
                    </span>
                  ) : (
                    'Drag & drop private key file (.pem) or click to browse'
                  )}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Supports RSA 2048-bit PKCS#1 / PKCS#8 `.pem` files
                </p>
              </label>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                Raw PEM Key Content (Paste directly)
              </label>
              <Textarea
                placeholder="-----BEGIN RSA PRIVATE KEY-----..."
                rows={3}
                value={config.privateKeyPemRaw || ''}
                onChange={(e) =>
                  onUpdateConfig({
                    privateKeyPemRaw: e.target.value,
                    privateKeyConfigured: Boolean(e.target.value.trim()),
                  })
                }
                className="bg-background/80 text-[11px] font-mono"
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Verification Status & Action Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 rounded-xl border border-border bg-card/40">
        <div className="flex items-center gap-3">
          {config.privateKeyConfigured && config.appId ? (
            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 gap-1 text-xs">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Credentials Configured
            </Badge>
          ) : (
            <Badge variant="outline" className="bg-amber-500/10 text-amber-400 border-amber-500/30 gap-1 text-xs">
              <AlertCircle className="h-3.5 w-3.5" />
              Configuration Pending
            </Badge>
          )}

          {verifyStatus.message && (
            <span
              className={`text-xs ${
                verifyStatus.success ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {verifyStatus.message}
            </span>
          )}
        </div>

        <Button
          onClick={handleRunVerification}
          disabled={verifying || loading || !config.appId}
          variant="outline"
          className="gap-2 text-xs"
        >
          {verifying ? (
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
          ) : (
            <Shield className="h-3.5 w-3.5 text-indigo-400" />
          )}
          Verify RS256 Connection
        </Button>
      </div>
    </div>
  );
}
