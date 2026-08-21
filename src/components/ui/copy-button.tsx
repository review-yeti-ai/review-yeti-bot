'use client';

import * as React from 'react';
import { Button, ButtonProps } from '@/components/ui/button';
import { Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CopyButtonProps extends Omit<ButtonProps, 'onClick'> {
  value: string;
  label?: string;
  copiedLabel?: string;
  timeout?: number;
  iconClassName?: string;
  onCopy?: () => void;
}

export function CopyButton({
  value,
  label,
  copiedLabel = 'Copied!',
  timeout = 2000,
  variant = 'outline',
  size = 'sm',
  className,
  iconClassName,
  onCopy,
  ...props
}: CopyButtonProps) {
  const [hasCopied, setHasCopied] = React.useState(false);

  const handleCopy = React.useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      e.preventDefault();

      if (!value) return;

      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value);
        } else {
          // Fallback for older browsers or test environments without clipboard API
          const textarea = document.createElement('textarea');
          textarea.value = value;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.focus();
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
        }

        setHasCopied(true);
        if (onCopy) onCopy();

        setTimeout(() => {
          setHasCopied(false);
        }, timeout);
      } catch (err) {
        console.error('Failed to copy to clipboard', err);
      }
    },
    [value, timeout, onCopy]
  );

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleCopy}
      className={cn('transition-all duration-200 gap-1.5', className)}
      aria-label={hasCopied ? copiedLabel : label || 'Copy to clipboard'}
      {...props}
    >
      {hasCopied ? (
        <>
          <Check className={cn('h-3.5 w-3.5 text-emerald-400 animate-in zoom-in-50', iconClassName)} />
          {size !== 'icon' && (
            <span className="text-emerald-400 font-medium">{copiedLabel}</span>
          )}
        </>
      ) : (
        <>
          <Copy className={cn('h-3.5 w-3.5', iconClassName)} />
          {size !== 'icon' && label && <span>{label}</span>}
          {size !== 'icon' && !label && <span>Copy</span>}
        </>
      )}
    </Button>
  );
}
