'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface GridProps extends React.HTMLAttributes<HTMLDivElement> {
  numItems?: 1 | 2 | 3 | 4 | 5 | 6;
  numItemsSm?: 1 | 2 | 3 | 4 | 5 | 6;
  numItemsMd?: 1 | 2 | 3 | 4 | 5 | 6;
  numItemsLg?: 1 | 2 | 3 | 4 | 5 | 6;
}

const gridCols = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
  5: 'grid-cols-5',
  6: 'grid-cols-6',
};

const gridColsSm = {
  1: 'sm:grid-cols-1',
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-4',
  5: 'sm:grid-cols-5',
  6: 'sm:grid-cols-6',
};

const gridColsMd = {
  1: 'md:grid-cols-1',
  2: 'md:grid-cols-2',
  3: 'md:grid-cols-3',
  4: 'md:grid-cols-4',
  5: 'md:grid-cols-5',
  6: 'md:grid-cols-6',
};

const gridColsLg = {
  1: 'lg:grid-cols-1',
  2: 'lg:grid-cols-2',
  3: 'lg:grid-cols-3',
  4: 'lg:grid-cols-4',
  5: 'lg:grid-cols-5',
  6: 'lg:grid-cols-6',
};

export const Grid = React.forwardRef<HTMLDivElement, GridProps>(
  (
    {
      className,
      numItems = 1,
      numItemsSm,
      numItemsMd,
      numItemsLg,
      children,
      ...props
    },
    ref
  ) => {
    return (
      <div
        ref={ref}
        className={cn(
          'grid gap-3',
          gridCols[numItems],
          numItemsSm && gridColsSm[numItemsSm],
          numItemsMd && gridColsMd[numItemsMd],
          numItemsLg && gridColsLg[numItemsLg],
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);
Grid.displayName = 'Grid';

export interface FlexProps extends React.HTMLAttributes<HTMLDivElement> {
  justifyContent?: 'start' | 'end' | 'center' | 'between' | 'around' | 'evenly';
  alignItems?: 'start' | 'end' | 'center' | 'baseline' | 'stretch';
  flexDirection?: 'row' | 'col' | 'row-reverse' | 'col-reverse';
}

const justifyMap = {
  start: 'justify-start',
  end: 'justify-end',
  center: 'justify-center',
  between: 'justify-between',
  around: 'justify-around',
  evenly: 'justify-evenly',
};

const alignMap = {
  start: 'items-start',
  end: 'items-end',
  center: 'items-center',
  baseline: 'items-baseline',
  stretch: 'items-stretch',
};

const dirMap = {
  row: 'flex-row',
  col: 'flex-col',
  'row-reverse': 'flex-row-reverse',
  'col-reverse': 'flex-col-reverse',
};

export const Flex = React.forwardRef<HTMLDivElement, FlexProps>(
  (
    {
      className,
      justifyContent = 'between',
      alignItems = 'center',
      flexDirection = 'row',
      children,
      ...props
    },
    ref
  ) => {
    return (
      <div
        ref={ref}
        className={cn(
          'flex gap-2',
          justifyMap[justifyContent],
          alignMap[alignItems],
          dirMap[flexDirection],
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);
Flex.displayName = 'Flex';

export interface DividerProps extends React.HTMLAttributes<HTMLHRElement> {}

export const Divider = React.forwardRef<HTMLHRElement, DividerProps>(
  ({ className, ...props }, ref) => {
    return (
      <hr
        ref={ref}
        className={cn('my-4 border-t border-white/[0.08]', className)}
        {...props}
      />
    );
  }
);
Divider.displayName = 'Divider';
