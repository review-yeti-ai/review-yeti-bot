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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PersonaSetting } from '@/types/dashboard';
import { AlertTriangle, ArrowRight, Shield } from 'lucide-react';

export interface ModelRemappingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  impactedPersonas: PersonaSetting[];
  availableModels: string[];
  disablingTargetName?: string;
  onConfirm: (remappedPersonas: Record<string, string>) => void | Promise<void>;
}

export function ModelRemappingDialog({
  open,
  onOpenChange,
  impactedPersonas,
  availableModels,
  disablingTargetName,
  onConfirm,
}: ModelRemappingDialogProps) {
  const [remappings, setRemappings] = React.useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (open && impactedPersonas.length > 0) {
      const initial: Record<string, string> = {};
      const defaultModel = availableModels[0] || '';
      for (const p of impactedPersonas) {
        const alt = availableModels.find((m) => m !== p.model) || defaultModel;
        initial[p.id] = alt;
      }
      setRemappings(initial);
    }
  }, [open, impactedPersonas, availableModels]);

  const handleSelectChange = (personaId: string, model: string) => {
    setRemappings((prev) => ({
      ...prev,
      [personaId]: model,
    }));
  };

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      await onConfirm(remappings);
      onOpenChange(false);
    } catch (err) {
      console.error('Failed to remap personas and disable target:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="model-remapping-dialog"
        id="model-remapping-dialog"
        className="sm:max-w-lg bg-background/95 border-amber-500/40 backdrop-blur-xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-bold text-amber-400">
            <AlertTriangle className="h-5 w-5 text-amber-400" />
            Impacted Personas &amp; Model Remapping
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {disablingTargetName ? (
              <>
                Disabling <span className="font-semibold text-foreground">{disablingTargetName}</span> will leave active reviewer personas without a valid model. Please assign alternative active models below before completing disablement.
              </>
            ) : (
              'The selected model or provider is currently used by active reviewer personas. Please remap impacted personas to valid alternative active models.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 max-h-[60vh] overflow-y-auto">
          {impactedPersonas.map((persona) => (
            <div
              key={persona.id}
              className="p-3 rounded-lg border border-border/80 bg-accent/20 space-y-2"
              data-testid={`impacted-persona-${persona.id}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-foreground flex items-center gap-1.5">
                  <Shield className="h-3.5 w-3.5 text-indigo-400" />
                  {persona.displayName || persona.id}
                </span>
                <span className="text-[10px] font-mono text-muted-foreground">
                  ID: {persona.id}
                </span>
              </div>

              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono text-rose-400 line-through bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">
                  {persona.model}
                </span>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="flex-1">
                  <Select
                    value={remappings[persona.id] || availableModels[0] || ''}
                    onValueChange={(val) => handleSelectChange(persona.id, val)}
                  >
                    <SelectTrigger
                      id={`persona-select-${persona.id}`}
                      data-testid={`persona-select-${persona.id}`}
                      className="h-8 text-xs bg-background/80"
                    >
                      <SelectValue placeholder="Select alternative model..." />
                    </SelectTrigger>
                    <SelectContent>
                      {availableModels.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          ))}

          {availableModels.length === 0 && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
              No alternative active models are available. Please enable at least one other AI provider before disabling this provider.
            </div>
          )}
        </div>

        <DialogFooter className="pt-2 flex items-center justify-end gap-2">
          <Button
            id="remap-cancel-btn"
            data-testid="remap-cancel-btn"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
            className="text-xs"
          >
            Cancel
          </Button>
          <Button
            id="remap-confirm-btn"
            data-testid="remap-confirm-btn"
            size="sm"
            onClick={handleConfirm}
            disabled={isSubmitting || availableModels.length === 0}
            className="bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold"
          >
            {isSubmitting ? 'Remapping...' : 'Remap & Disable'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
