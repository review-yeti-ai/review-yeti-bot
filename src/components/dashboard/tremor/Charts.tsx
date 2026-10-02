'use client';

import * as React from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { cn } from '@/lib/utils';

export interface ChartItem {
  [key: string]: any;
}

export interface AreaChartProps extends React.HTMLAttributes<HTMLDivElement> {
  data: ChartItem[];
  index: string;
  categories: string[];
  colors?: string[];
  valueFormatter?: (value: number) => string;
  showGrid?: boolean;
  showLegend?: boolean;
  height?: number | string;
}

const defaultChartColors = [
  '#6366f1', // indigo
  '#10b981', // emerald
  '#f43f5e', // rose
  '#f59e0b', // amber
  '#06b6d4', // cyan
];

export const TremorAreaChart: React.FC<AreaChartProps> = ({
  className,
  data = [],
  index,
  categories = [],
  colors = defaultChartColors,
  valueFormatter = (val) => val.toLocaleString(),
  showGrid = true,
  height = 240,
}) => {
  return (
    <div className={cn('w-full', className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <defs>
            {categories.map((cat, idx) => {
              const color = colors[idx % colors.length];
              return (
                <linearGradient key={cat} id={`grad-${cat}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.4} />
                  <stop offset="95%" stopColor={color} stopOpacity={0.0} />
                </linearGradient>
              );
            })}
          </defs>
          {showGrid && <CartesianGrid stroke="#ffffff0d" strokeDasharray="3 3" vertical={false} />}
          <XAxis
            dataKey={index}
            stroke="#71717a"
            fontSize={11}
            tickLine={false}
            axisLine={{ stroke: '#ffffff14' }}
          />
          <YAxis
            stroke="#71717a"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={valueFormatter}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#0c0d12',
              borderColor: '#ffffff14',
              borderRadius: 8,
              fontSize: 12,
              fontFamily: 'monospace',
              color: '#e4e4e7',
            }}
          />
          {categories.map((cat, idx) => (
            <Area
              key={cat}
              type="monotone"
              dataKey={cat}
              stroke={colors[idx % colors.length]}
              strokeWidth={2}
              fillOpacity={1}
              fill={`url(#grad-${cat})`}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

export interface BarChartProps extends React.HTMLAttributes<HTMLDivElement> {
  data: ChartItem[];
  index: string;
  categories: string[];
  colors?: string[];
  valueFormatter?: (value: number) => string;
  showGrid?: boolean;
  height?: number | string;
}

export const TremorBarChart: React.FC<BarChartProps> = ({
  className,
  data = [],
  index,
  categories = [],
  colors = defaultChartColors,
  valueFormatter = (val) => val.toLocaleString(),
  showGrid = true,
  height = 240,
}) => {
  return (
    <div className={cn('w-full', className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          {showGrid && <CartesianGrid stroke="#ffffff0d" strokeDasharray="3 3" vertical={false} />}
          <XAxis
            dataKey={index}
            stroke="#71717a"
            fontSize={11}
            tickLine={false}
            axisLine={{ stroke: '#ffffff14' }}
          />
          <YAxis
            stroke="#71717a"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={valueFormatter}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#0c0d12',
              borderColor: '#ffffff14',
              borderRadius: 8,
              fontSize: 12,
              fontFamily: 'monospace',
              color: '#e4e4e7',
            }}
          />
          {categories.map((cat, idx) => (
            <Bar
              key={cat}
              dataKey={cat}
              fill={colors[idx % colors.length]}
              radius={[4, 4, 0, 0]}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

export interface DonutChartProps extends React.HTMLAttributes<HTMLDivElement> {
  data: Array<{ name: string; value: number }>;
  category?: string;
  index?: string;
  colors?: string[];
  valueFormatter?: (value: number) => string;
  height?: number | string;
}

export const TremorDonutChart: React.FC<DonutChartProps> = ({
  className,
  data = [],
  colors = defaultChartColors,
  valueFormatter = (val) => val.toLocaleString(),
  height = 200,
}) => {
  return (
    <div className={cn('w-full flex items-center justify-center', className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip
            contentStyle={{
              backgroundColor: '#0c0d12',
              borderColor: '#ffffff14',
              borderRadius: 8,
              fontSize: 12,
              fontFamily: 'monospace',
              color: '#e4e4e7',
            }}
            formatter={(value: any) => [valueFormatter(Number(value)), '']}
          />
          <Pie
            data={data}
            innerRadius="60%"
            outerRadius="80%"
            paddingAngle={3}
            dataKey="value"
          >
            {data.map((_, index) => (
              <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
};
