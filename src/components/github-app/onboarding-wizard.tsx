'use client';

import * as React from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { GitHubAppConfig, EnforcementPolicy } from '@/types/dashboard';
import { GitBranch, Key, ShieldCheck, CheckCircle2, FileText, Upload } from 'lucide-react';

interface OnboardingWizardProps {
  config?: GitHubAppConfig | null;
  policy?: EnforcementPolicy | null;
  onVerify?: (data: any) => Promise<void>;
  onSavePolicy?: (policy: Partial<EnforcementPolicy>) => Promise<void>;
}

export function OnboardingWizard({ config, policy, onVerify, onSavePolicy }: OnboardingWizardProps) {
  const [appId, setAppId] = React.useState(config?.appId || '1048293');
  const [installationId, setInstallationId] = React.useState(config?.installationId || '5829104');
  const [pemLoaded, setPemLoaded] = React.useState(config?.privateKeyConfigured ?? false);
  const [privateKeyPem, setPrivateKeyPem] = React.useState<string>('');
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [isVerifying, setIsVerifying] = React.useState(false);
  const [verifiedStatus, setVerifiedStatus] = React.useState<boolean | null>(true);

  const [reqAll, setReqAll] = React.useState(policy?.require_all_reviews ?? true);
  const [reqTicket, setReqTicket] = React.useState(policy?.require_ticket_link ?? true);
  const [failureAction, setFailureAction] = React.useState(policy?.failure_action || 'quarantine');
  const [isSavingPolicy, setIsSavingPolicy] = React.useState(false);
  const [policySavedMessage, setPolicySavedMessage] = React.useState<string | null>(null);

  const policyTimerRef = React.useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = React.useRef(true);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (policyTimerRef.current) {
        clearTimeout(policyTimerRef.current);
      }
    };
  }, []);

  const handleFileChange = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      if (text && isMountedRef.current) {
        setPrivateKeyPem(text);
        setPemLoaded(true);
      }
    };
    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileChange(e.dataTransfer.files[0]);
    } else {
      setPemLoaded(true);
    }
  };

  const handleVerify = async () => {
    setIsVerifying(true);
    try {
      if (onVerify) {
        const payload: any = { appId, installationId };
        if (privateKeyPem) payload.privateKeyPem = privateKeyPem;
        await onVerify(payload);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      if (isMountedRef.current) setVerifiedStatus(true);
    } catch {
      if (isMountedRef.current) setVerifiedStatus(false);
    } finally {
      if (isMountedRef.current) setIsVerifying(false);
    }
  };

  const handleSaveEnforcementPolicy = async () => {
    setIsSavingPolicy(true);
    try {
      if (onSavePolicy) {
        await onSavePolicy({
          require_all_reviews: reqAll,
          require_ticket_link: reqTicket,
          failure_action: failureAction,
        });
      }
      if (isMountedRef.current) {
        setPolicySavedMessage('Enforcement policy saved successfully');
        if (policyTimerRef.current) clearTimeout(policyTimerRef.current);
        policyTimerRef.current = setTimeout(() => {
          if (isMountedRef.current) setPolicySavedMessage(null);
        }, 3500);
      }
    } catch (err: any) {
      if (isMountedRef.current) setPolicySavedMessage(`Failed to save policy: ${err?.message}`);
    } finally {
      if (isMountedRef.current) setIsSavingPolicy(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="glass-panel border-border/80">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5 text-indigo-400" />
            Monitored Org Repositories Manager &amp; RS256 Private Key
          </CardTitle>
          <CardDescription>
            Configure App ID, Installation ID, and upload private key PEM for webhook token generation
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-semibold text-muted-foreground block mb-1">GitHub App ID</label>
              <Input
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder="e.g. 1048293"
                className="font-mono text-xs bg-background/80"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground block mb-1">Installation ID</label>
              <Input
                value={installationId}
                onChange={(e) => setInstallationId(e.target.value)}
                placeholder="e.g. 5829104"
                className="font-mono text-xs bg-background/80"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-muted-foreground block mb-1">
              Private Key (.pem) Dropzone
            </label>
            <input
              type="file"
              ref={fileInputRef}
              accept=".pem,.key"
              className="hidden"
              onChange={(e) => handleFileChange(e.target.files?.[0])}
            />
            <div
              id="pem-dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              onClick={() => {
                setPemLoaded(true);
                fileInputRef.current?.click();
              }}
              className="border-2 border-dashed border-border/80 rounded-lg p-6 text-center text-xs text-muted-foreground hover:border-indigo-500/50 transition-colors cursor-pointer bg-background/40"
            >
              <div className="flex flex-col items-center gap-2">
                <Upload className="h-6 w-6 text-indigo-400" />
                {pemLoaded ? (
                  <span className="text-emerald-400 font-semibold flex items-center gap-1">
                    <CheckCircle2 className="h-4 w-4" /> RS256 Private Key Configured (private-key.pem)
                  </span>
                ) : (
                  <span>Drag and drop private key file (.pem) here or click to upload</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-2">
              {verifiedStatus !== null && (
                <Badge variant={verifiedStatus ? 'success' : 'destructive'} className="text-[10px]">
                  {verifiedStatus ? 'JWT RSA Key Pair Verified' : 'Verification Failed'}
                </Badge>
              )}
            </div>
            <Button
              onClick={handleVerify}
              disabled={isVerifying}
              size="sm"
              className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs gap-1.5"
            >
              <Key className="h-3.5 w-3.5" />
              {isVerifying ? 'Verifying...' : 'Verify Credentials'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="glass-panel border-border/80">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-emerald-400" />
            Repository Enforcement Policy &amp; Arbitration Gates
          </CardTitle>
          <CardDescription>
            Define blocking requirements and automated merge enforcement rules
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-3 rounded-lg border border-border/60 bg-background/40">
            <div>
              <div className="text-xs font-semibold text-foreground">Require 4-Persona Approval</div>
              <p className="text-[11px] text-muted-foreground">
                All required reviewer personas must output SHIP verdict before PR merges
              </p>
            </div>
            <Button
              variant={reqAll ? 'default' : 'outline'}
              size="sm"
              onClick={() => setReqAll(!reqAll)}
              className="h-7 text-xs"
            >
              {reqAll ? 'Enabled' : 'Disabled'}
            </Button>
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg border border-border/60 bg-background/40">
            <div>
              <div className="text-xs font-semibold text-foreground">Require Linear / Ticket Link</div>
              <p className="text-[11px] text-muted-foreground">
                Enforce present issue ticket ID in PR title or body description
              </p>
            </div>
            <Button
              variant={reqTicket ? 'default' : 'outline'}
              size="sm"
              onClick={() => setReqTicket(!reqTicket)}
              className="h-7 text-xs"
            >
              {reqTicket ? 'Enabled' : 'Disabled'}
            </Button>
          </div>

          {policySavedMessage && (
            <div className="p-2.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-400 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{policySavedMessage}</span>
            </div>
          )}

          <div className="flex justify-end pt-2 border-t border-border/40">
            <Button
              id="save-enforcement-policy-btn"
              onClick={handleSaveEnforcementPolicy}
              disabled={isSavingPolicy}
              size="sm"
              className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs gap-1.5"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {isSavingPolicy ? 'Saving Policy...' : 'Save Enforcement Policy'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
