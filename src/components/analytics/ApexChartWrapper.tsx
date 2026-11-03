'use client';

import React, { useEffect, useRef } from 'react';
import type { ApexOptions } from 'apexcharts';

export interface ApexChartWrapperProps {
  options: ApexOptions;
  series: ApexAxisChartSeries | ApexNonAxisChartSeries;
  type:
    | 'line'
    | 'area'
    | 'bar'
    | 'donut'
    | 'radialBar'
    | 'scatter'
    | 'bubble'
    | 'heatmap'
    | 'candlestick'
    | 'boxPlot'
    | 'radar'
    | 'polarArea'
    | 'rangeBar'
    | 'rangeArea'
    | 'treemap';
  height?: number | string;
  className?: string;
}

export function ApexChartWrapper({
  options,
  series,
  type,
  height = 240,
  className = '',
}: ApexChartWrapperProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let chartInstance: any = null;
    let cancelled = false;

    async function mountChart() {
      if (!containerRef.current) return;
      const ApexChartsModule = await import('apexcharts');
      const ApexCharts = ApexChartsModule.default || ApexChartsModule;
      if (cancelled || !containerRef.current) return;

      containerRef.current.innerHTML = '';
      chartInstance = new ApexCharts(containerRef.current, {
        ...options,
        series,
        chart: {
          ...options.chart,
          type,
          height,
          background: 'transparent',
          toolbar: { show: false },
          zoom: { enabled: false },
          animations: {
            enabled: false,
          },
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        },
        theme: {
          mode: 'dark',
        },
      });
      await chartInstance.render();
    }

    mountChart();

    return () => {
      cancelled = true;
      if (chartInstance) {
        try {
          chartInstance.destroy();
        } catch {
          // ignore cleanup errors
        }
      }
    };
  }, [options, series, type, height]);

  return <div ref={containerRef} className={className} style={{ minHeight: typeof height === 'number' ? `${height}px` : height }} />;
}
