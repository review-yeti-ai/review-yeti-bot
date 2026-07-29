'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { updateDashboardConfig } from '@/lib/api-client';
import { Coins, AlertTriangle, ShieldAlert, Loader2, Check } from 'lucide-react';

interface SpendingCapModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  currentMonthlyCap?: number;
  currentDailyCap?: number;
}

export function SpendingCapModal({
  open,
  onOpenChange,
  onSuccess,
  currentMonthlyCap = 150,
  currentDailyCap,
}: SpendingCapModalProps) {
  const [monthlyBudgetUSD, setMonthlyBudgetUSD] = React.useState<string>(String(currentMonthlyCap));
  const [dailyBudgetUSD, setDailyBudgetUSD] = React.useState<string>(
    String(currentDailyCap ?? Math.round(currentMonthlyCap / 30))
  );
  const [alertThresholdPercent, setAlertThresholdPercent] = React.useState<string>('80');
  const [actionOnCapBreach, setActionOnCapBreach] = React.useState<'fail_closed' | 'disable_optional'>('fail_closed');

  const [saving, setSaving] = React.useState(false);
  const [savedSuccess, setSavedSuccess] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const timerRef = React.useRef<NodeJS.Timeout | null>(null);

  React.useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    if (open) {
      setMonthlyBudgetUSD(String(currentMonthlyCap));
      setDailyBudgetUSD(String(currentDailyCap ?? Math.round(currentMonthlyCap / 30)));
      setSavedSuccess(false);
      setError(null);
    }
  }, [open, currentMonthlyCap, currentDailyCap]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const monthlyNum = parseFloat(monthlyBudgetUSD);
    const dailyNum = parseFloat(dailyBudgetUSD);
    const alertNum = parseInt(alertThresholdPercent, 10);

    if (isNaN(monthlyNum) || monthlyNum <= 0) {
      setError('Monthly cap must be a positive number');
      setSaving(false);
      return;
    }

    try {
      await updateDashboardConfig({
        monthlyCostCapUSD: monthlyNum,
        providerCostCaps: {
          monthlyBudgetUSD: monthlyNum,
          dailyBudgetUSD: isNaN(dailyNum) ? monthlyNum / 30 : dailyNum,
          alertThresholdPercent: isNaN(alertNum) ? 80 : alertNum,
          actionOnCapBreach,
        },
      });

      setSavedSuccess(true);
      if (onSuccess) onSuccess();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setSavedSuccess(false);
        onOpenChange(false);
      }, 1000);
    } catch (err: any) {
      setError(err?.message || 'Failed to save spending cap settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md bg-card border-border p-6 text-foreground">
        <DialogHeader className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Coins className="w-5 h-5" />
            </div>
            <div>
              <DialogTitle className="text-lg font-bold">Edit Spending Cap & Budget</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Configure global monthly cost limits and breach protection enforcement policies.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSave} className="space-y-4 my-2">
          {error && (
            <div className="p-3 rounded-md bg-destructive/10 border border-destructive/30 text-destructive text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {savedSuccess && (
            <div className="p-3 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs flex items-center gap-2">
              <Check className="w-4 h-4 flex-shrink-0" />
              <span>Spending cap settings updated successfully!</span>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground flex items-center justify-between">
              <span>Monthly Budget Cap ($ USD)</span>
              <span className="text-muted-foreground font-mono text-[11px]">$ USD</span>
            </label>
            <Input
              type="number"
              step="10"
              min="10"
              value={monthlyBudgetUSD}
              onChange={(e) => setMonthlyBudgetUSD(e.target.value)}
              placeholder="150"
              className="bg-muted/40 font-mono text-sm"
              required
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground flex items-center justify-between">
              <span>Daily Budget Cap ($ USD)</span>
              <span className="text-muted-foreground font-mono text-[11px]">$ USD</span>
            </label>
            <Input
              type="number"
              step="1"
              min="1"
              value={dailyBudgetUSD}
              onChange={(e) => setDailyBudgetUSD(e.target.value)}
              placeholder="15"
              className="bg-muted/40 font-mono text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground flex items-center justify-between">
              <span>Alert Threshold (%)</span>
              <span className="text-muted-foreground font-mono text-[11px]">% of monthly cap</span>
            </label>
            <Input
              type="number"
              step="5"
              min="50"
              max="100"
              value={alertThresholdPercent}
              onChange={(e) => setAlertThresholdPercent(e.target.value)}
              placeholder="80"
              className="bg-muted/40 font-mono text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
              <span>Breach Enforcement Policy</span>
            </label>
            <Select
              value={actionOnCapBreach}
              onValueChange={(val: any) => setActionOnCapBreach(val)}
            >
              <SelectTrigger className="bg-muted/40 font-mono text-xs">
                <SelectValue placeholder="Select enforcement policy" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fail_closed">
                  Fail Closed (Block all PR reviews until reset)
                </SelectItem>
                <SelectItem value="disable_optional">
                  Disable Optional (Only run required security personas)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <DialogFooter className="pt-3 border-t border-border/60">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={saving}
              className="bg-emerald-600 hover:bg-emerald-500 text-white gap-1.5"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {saving ? 'Saving...' : 'Save Cap Settings'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
