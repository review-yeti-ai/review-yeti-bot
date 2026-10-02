'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';

export interface TabGroupProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root> {}

export const TabGroup = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Root>,
  TabGroupProps
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Root
    ref={ref}
    className={cn('w-full space-y-4', className)}
    {...props}
  />
));
TabGroup.displayName = 'TabGroup';

export interface TabListProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> {
  variant?: 'line' | 'solid';
}

export const TabList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  TabListProps
>(({ className, variant = 'line', ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex items-center gap-2 border-b border-white/[0.08] w-full overflow-x-auto no-scrollbar',
      variant === 'solid' && 'bg-white/[0.03] p-1 rounded-lg border-none',
      className
    )}
    {...props}
  />
));
TabList.displayName = 'TabList';

export interface TabProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> {
  icon?: React.ComponentType<{ className?: string }>;
}

export const Tab = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  TabProps
>(({ className, icon: Icon, children, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex items-center gap-2 px-3 py-2 text-xs font-mono font-medium tracking-tight text-zinc-400 transition-all border-b-2 border-transparent hover:text-zinc-200 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-indigo-500 data-[state=active]:text-white data-[state=active]:bg-white/[0.02]',
      className
    )}
    {...props}
  >
    {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
    <span>{children}</span>
  </TabsPrimitive.Trigger>
));
Tab.displayName = 'Tab';

export const TabPanels = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('w-full outline-none', className)} {...props} />
));
TabPanels.displayName = 'TabPanels';

export interface TabPanelProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content> {}

export const TabPanel = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  TabPanelProps
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'w-full outline-none focus-visible:ring-0 focus-visible:outline-none transition-opacity',
      className
    )}
    {...props}
  />
));
TabPanel.displayName = 'TabPanel';
