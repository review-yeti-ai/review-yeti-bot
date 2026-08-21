import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseModelIdentifier,
  computeParetoFrontier,
  extractModelPoints,
  generateParetoFrontierSVG,
  generateMarkdownParetoSection,
  ModelPoint,
} from '../../scripts/generate-benchmark-charts.mjs';

describe('Benchmark Chart & Pareto Frontier Generator', () => {
  it('correctly parses exact model identifiers and reasoning effort levels', () => {
    expect(parseModelIdentifier('deepseek/deepseek-v4-flash-0731:low')).toEqual({
      exactModel: 'deepseek/deepseek-v4-flash-0731:low',
      family: 'DeepSeek V4 Flash',
      effort: 'low',
    });

    expect(parseModelIdentifier('google/gemini-3.7-flash:medium')).toEqual({
      exactModel: 'google/gemini-3.7-flash:medium',
      family: 'Google Gemini 3.7 Flash',
      effort: 'medium',
    });

    expect(parseModelIdentifier('openrouter/5.6-luna-high')).toEqual({
      exactModel: 'openrouter/5.6-luna-high',
      family: 'OpenRouter 5.6 Luna',
      effort: 'high',
    });

    expect(parseModelIdentifier('qwen/qwen-3.8-27b:high')).toEqual({
      exactModel: 'qwen/qwen-3.8-27b:high',
      family: 'Qwen 3.8 27B',
      effort: 'high',
    });
  });

  it('computes Pareto-optimal frontier points without dominated entries', () => {
    const mockPoints: ModelPoint[] = [
      {
        id: 'model-a',
        exactModel: 'model-a:low',
        family: 'Model A',
        effort: 'low',
        verdictAccuracyPct: 90.0,
        recall: 0.90,
        precision: 1.0,
        f1Score: 0.94,
        avgSnrDb: 10.0,
        avgTtftMs: 100,
        totalCostUSD: 0.0100,
        costEfficiency: 1000,
        totalTokens: 100000,
      },
      {
        id: 'model-b',
        exactModel: 'model-b:med',
        family: 'Model B',
        effort: 'medium',
        verdictAccuracyPct: 95.0,
        recall: 0.95,
        precision: 1.0,
        f1Score: 0.97,
        avgSnrDb: 11.5,
        avgTtftMs: 110,
        totalCostUSD: 0.0200,
        costEfficiency: 800,
        totalTokens: 120000,
      },
      {
        id: 'model-c',
        exactModel: 'model-c:high',
        family: 'Model C',
        effort: 'high',
        verdictAccuracyPct: 92.0, // Dominated by model-b (lower acc, higher cost)
        recall: 0.92,
        precision: 1.0,
        f1Score: 0.95,
        avgSnrDb: 10.5,
        avgTtftMs: 130,
        totalCostUSD: 0.0300,
        costEfficiency: 400,
        totalTokens: 150000,
      },
      {
        id: 'model-d',
        exactModel: 'model-d:high',
        family: 'Model D',
        effort: 'high',
        verdictAccuracyPct: 100.0,
        recall: 1.0,
        precision: 1.0,
        f1Score: 1.0,
        avgSnrDb: 12.2,
        avgTtftMs: 140,
        totalCostUSD: 0.0400,
        costEfficiency: 350,
        totalTokens: 200000,
      },
    ];

    const pareto = computeParetoFrontier(mockPoints);
    const paretoIds = pareto.map((p) => p.exactModel);

    expect(paretoIds).toContain('model-a:low');
    expect(paretoIds).toContain('model-b:med');
    expect(paretoIds).toContain('model-d:high');
    expect(paretoIds).not.toContain('model-c:high'); // Dominated
  });

  it('generates valid SVG output with axes, titles, and exact model points', () => {
    const points: ModelPoint[] = [
      {
        id: 'deepseek/deepseek-v4-flash-0731:low',
        exactModel: 'deepseek/deepseek-v4-flash-0731:low',
        family: 'DeepSeek V4 Flash',
        effort: 'low',
        verdictAccuracyPct: 92.1,
        recall: 0.907,
        precision: 1.0,
        f1Score: 0.951,
        avgSnrDb: 10.7,
        avgTtftMs: 95,
        totalCostUSD: 0.1699,
        costEfficiency: 800.3,
        totalTokens: 1140232,
      },
      {
        id: 'deepseek/deepseek-v4-flash-0731:high',
        exactModel: 'deepseek/deepseek-v4-flash-0731:high',
        family: 'DeepSeek V4 Flash',
        effort: 'high',
        verdictAccuracyPct: 100.0,
        recall: 1.0,
        precision: 1.0,
        f1Score: 1.0,
        avgSnrDb: 12.2,
        avgTtftMs: 105,
        totalCostUSD: 0.0228,
        costEfficiency: 6578.9,
        totalTokens: 145049,
      },
    ];

    const svg = generateParetoFrontierSVG(points, 'Custom Test Pareto Chart');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('Custom Test Pareto Chart');
    expect(svg).toContain('deepseek/deepseek-v4-flash-0731:low');
    expect(svg).toContain('deepseek/deepseek-v4-flash-0731:high');
    expect(svg).toContain('Pareto');
  });

  it('generates markdown table highlighting Pareto frontier models', () => {
    const points: ModelPoint[] = [
      {
        id: 'deepseek/deepseek-v4-flash-0731:high',
        exactModel: 'deepseek/deepseek-v4-flash-0731:high',
        family: 'DeepSeek V4 Flash',
        effort: 'high',
        verdictAccuracyPct: 100.0,
        recall: 1.0,
        precision: 1.0,
        f1Score: 1.0,
        avgSnrDb: 12.2,
        avgTtftMs: 105,
        totalCostUSD: 0.0228,
        costEfficiency: 6578.9,
        totalTokens: 145049,
      },
      {
        id: 'google/gemini-3.7-flash:high',
        exactModel: 'google/gemini-3.7-flash:high',
        family: 'Google Gemini 3.7 Flash',
        effort: 'high',
        verdictAccuracyPct: 100.0,
        recall: 1.0,
        precision: 1.0,
        f1Score: 1.0,
        avgSnrDb: 12.2,
        avgTtftMs: 115,
        totalCostUSD: 0.0296,
        costEfficiency: 5067.6,
        totalTokens: 145049,
      },
    ];

    const md = generateMarkdownParetoSection(points);
    expect(md).toContain('Pareto Frontier');
    expect(md).toContain('deepseek/deepseek-v4-flash-0731:high');
    expect(md).toContain('google/gemini-3.7-flash:high');
    expect(md).toContain('Optimal');
  });
});
