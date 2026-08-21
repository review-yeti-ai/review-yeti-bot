#!/usr/bin/env node

/**
 * Benchmark Plotted Chart Generator
 * scripts/generate-benchmark-charts.mjs
 *
 * Generates standalone responsive SVG Pareto Frontier charts and markdown diagrams
 * from benchmark evaluation baseline JSON reports (model-benchmark-matrix-v*.json).
 *
 * Primary Plotted Charts:
 * 1. Pareto Frontier: Verdict Accuracy (%) vs Total Cost ($ USD)
 * 2. Defect Recall vs Cost Efficiency (TP / $ USD)
 * 3. Signal-to-Noise Ratio (SNR dB) vs Latency / TTFT (ms)
 * 4. Multi-Tier Reasoning Progression (Low -> Medium -> High)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

export function parseModelIdentifier(rawModelId) {
  const clean = rawModelId.trim();
  let effort = 'default';

  if (clean.endsWith(':low') || clean.endsWith('-low')) effort = 'low';
  else if (clean.endsWith(':medium') || clean.endsWith(':med') || clean.endsWith('-medium') || clean.endsWith('-med')) effort = 'medium';
  else if (clean.endsWith(':high') || clean.endsWith('-high')) effort = 'high';

  let family = clean.split(':')[0].replace(/-(low|medium|med|high)$/, '');
  if (family.includes('deepseek')) family = 'DeepSeek V4 Flash';
  else if (family.includes('luna')) family = 'OpenRouter 5.6 Luna';
  else if (family.includes('gemini')) family = 'Google Gemini 3.7 Flash';
  else if (family.includes('qwen')) family = 'Qwen 3.8 27B';
  else if (family.includes('sonnet')) family = 'Anthropic Claude 5 Sonnet';
  else if (family.includes('haiku') || family.includes('claude')) family = 'Anthropic Claude 5 Haiku';

  return { exactModel: clean, family, effort };
}

/**
 * Computes Pareto-optimal frontier points (maximizing Accuracy, minimizing Cost).
 * A point A dominates point B if Acc(A) >= Acc(B) and Cost(A) <= Cost(B), with at least one strict inequality.
 */
export function computeParetoFrontier(points) {
  const nonDominated = [];

  for (const candidate of points) {
    let dominated = false;
    for (const other of points) {
      if (candidate.exactModel === other.exactModel) continue;

      const higherOrEqualAcc = other.verdictAccuracyPct >= candidate.verdictAccuracyPct;
      const lowerOrEqualCost = other.totalCostUSD <= candidate.totalCostUSD;
      const strictlyBetterAcc = other.verdictAccuracyPct > candidate.verdictAccuracyPct;
      const strictlyBetterCost = other.totalCostUSD < candidate.totalCostUSD;

      if (higherOrEqualAcc && lowerOrEqualCost && (strictlyBetterAcc || strictlyBetterCost)) {
        dominated = true;
        break;
      }
    }

    if (!dominated) {
      nonDominated.push(candidate);
    }
  }

  // Sort Pareto frontier by ascending cost
  return nonDominated.sort((a, b) => a.totalCostUSD - b.totalCostUSD);
}

/**
 * Extracts normalized model points from benchmark summary JSON dictionary.
 */
export function extractModelPoints(summaryDict) {
  const points = [];

  for (const [modelId, metrics] of Object.entries(summaryDict)) {
    const { exactModel, family, effort } = parseModelIdentifier(modelId);

    const verdictAccuracyPct = typeof metrics.verdictAccuracyPct === 'number'
      ? metrics.verdictAccuracyPct
      : (typeof metrics.verdictAccuracy === 'number'
          ? metrics.verdictAccuracy
          : (typeof metrics.accuracy === 'number'
              ? (metrics.accuracy <= 1 ? metrics.accuracy * 100 : metrics.accuracy)
              : (metrics.verdictMatches && metrics.totalScenarios ? (metrics.verdictMatches / metrics.totalScenarios) * 100 : 0)));

    const recall = typeof metrics.recall === 'number' ? metrics.recall : 0;
    const precision = typeof metrics.precision === 'number' ? metrics.precision : 0;
    const f1Score = typeof metrics.f1Score === 'number' ? metrics.f1Score : 0;
    const avgSnrDb = typeof metrics.avgSnrDb === 'number' ? metrics.avgSnrDb : (typeof metrics.snrDb === 'number' ? metrics.snrDb : 0);
    const avgTtftMs = typeof metrics.avgTtftMs === 'number' ? metrics.avgTtftMs : (typeof metrics.ttftMs === 'number' ? metrics.ttftMs : 0);
    const totalCostUSD = typeof metrics.totalCostUSD === 'number' ? metrics.totalCostUSD : (typeof metrics.costUSD === 'number' ? metrics.costUSD : 0);
    const costEfficiency = typeof metrics.costEfficiency === 'number' ? metrics.costEfficiency : 0;
    const totalTokens = typeof metrics.totalTokens === 'number' ? metrics.totalTokens : 0;

    points.push({
      id: modelId,
      exactModel,
      family,
      effort,
      verdictAccuracyPct,
      recall,
      precision,
      f1Score,
      avgSnrDb,
      avgTtftMs,
      totalCostUSD,
      costEfficiency,
      totalTokens,
    });
  }

  return points;
}

const FAMILY_COLORS = {
  'DeepSeek V4 Flash': { stroke: '#3b82f6', fill: '#60a5fa', text: '#93c5fd' },
  'Google Gemini 3.7 Flash': { stroke: '#10b981', fill: '#34d399', text: '#6ee7b7' },
  'Anthropic Claude 5 Haiku': { stroke: '#ec4899', fill: '#f472b6', text: '#fbcfe8' },
  'Anthropic Claude 5 Sonnet': { stroke: '#f43f5e', fill: '#fb7185', text: '#fecdd3' },
  'OpenRouter 5.6 Luna': { stroke: '#f59e0b', fill: '#fbbf24', text: '#fde68a' },
  'Qwen 3.8 27B': { stroke: '#8b5cf6', fill: '#a78bfa', text: '#c4b5fd' },
};

const DEFAULT_COLOR = { stroke: '#06b6d4', fill: '#22d3ee', text: '#67e8f9' };

/**
 * Generates high-resolution SVG Pareto Frontier Chart: Accuracy vs Total Cost.
 * Position the legend at bottom right and use anti-collision pill labels to ensure clean readability.
 */
export function generateParetoFrontierSVG(points, title = 'Pareto Frontier: Verdict Accuracy vs. Total Cost') {
  const width = 1040;
  const height = 620;
  const padding = { top: 75, right: 60, bottom: 85, left: 85 };

  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  // Min and Max bounds for clean 2D scatter distribution
  const minCost = 0.0;
  const maxCost = 0.40;
  const minAcc = 88.0;
  const maxAcc = 101.0;

  const getX = (cost) => {
    const ratio = Math.max(0, Math.min(1, (cost - minCost) / (maxCost - minCost)));
    return padding.left + ratio * plotWidth;
  };

  const getY = (acc) => {
    const ratio = Math.max(0, Math.min(1, (acc - minAcc) / (maxAcc - minAcc)));
    return padding.top + plotHeight - (ratio * plotHeight);
  };

  const paretoPoints = computeParetoFrontier(points);

  // Cost Grid Lines (Linear $0.00 to $0.40)
  const costTicks = [0.00, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40];
  let xGridLines = '';
  for (const tick of costTicks) {
    const x = getX(tick);
    xGridLines += `
      <line x1="${x}" y1="${padding.top}" x2="${x}" y2="${height - padding.bottom}" stroke="#334155" stroke-dasharray="2,2" stroke-width="1" />
      <text x="${x}" y="${height - padding.bottom + 22}" fill="#94a3b8" font-size="12" font-family="system-ui, sans-serif" text-anchor="middle">$${tick.toFixed(2)}</text>
    `;
  }

  // Accuracy Grid Lines (90% to 100%)
  const accTicks = [90, 92, 94, 96, 98, 100];
  let yGridLines = '';
  for (const tick of accTicks) {
    const y = getY(tick);
    yGridLines += `
      <line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" stroke="#334155" stroke-dasharray="2,2" stroke-width="1" />
      <text x="${padding.left - 15}" y="${y + 4}" fill="#94a3b8" font-size="12" font-family="system-ui, sans-serif" text-anchor="end">${tick}%</text>
    `;
  }

  // Label Offset Heuristic to Prevent Overlaps
  const customOffsets = {
    'deepseek/deepseek-v4-flash-0731:low': { dx: 14, dy: 14, anchor: 'start' },
    'deepseek/deepseek-v4-flash-0731:medium': { dx: 14, dy: -8, anchor: 'start' },
    'deepseek/deepseek-v4-flash-0731:high': { dx: 14, dy: -18, anchor: 'start' },
    'google/gemini-3.7-flash:low': { dx: 14, dy: 16, anchor: 'start' },
    'google/gemini-3.7-flash:medium': { dx: 14, dy: -4, anchor: 'start' },
    'google/gemini-3.7-flash:high': { dx: 14, dy: -20, anchor: 'start' },
    'claude-5-haiku:low': { dx: 14, dy: 14, anchor: 'start' },
    'claude-5-haiku:medium': { dx: 14, dy: -6, anchor: 'start' },
    'claude-5-haiku:high': { dx: 14, dy: 20, anchor: 'start' },
    'anthropic/claude-5-haiku:low': { dx: 14, dy: 14, anchor: 'start' },
    'anthropic/claude-5-haiku:medium': { dx: 14, dy: -6, anchor: 'start' },
    'anthropic/claude-5-haiku:high': { dx: 14, dy: 20, anchor: 'start' },
    'qwen/qwen-3.8-27b:low': { dx: 14, dy: 16, anchor: 'start' },
    'qwen/qwen-3.8-27b:medium': { dx: 14, dy: -10, anchor: 'start' },
    'qwen/qwen-3.8-27b:high': { dx: 14, dy: 6, anchor: 'start' },
    'openrouter/5.6-luna-low': { dx: -14, dy: 16, anchor: 'end' },
    'openrouter/5.6-luna-medium': { dx: -14, dy: -10, anchor: 'end' },
    'openrouter/5.6-luna-high': { dx: -14, dy: -22, anchor: 'end' },
  };

  // Render Data Points with Badges (No leader lines)
  let dataPointsSvg = '';
  for (const p of points) {
    const cx = getX(p.totalCostUSD);
    const cy = getY(p.verdictAccuracyPct);
    const colors = FAMILY_COLORS[p.family] || DEFAULT_COLOR;
    const isPareto = paretoPoints.some((front) => front.exactModel === p.exactModel);
    const radius = isPareto ? 8 : 6;

    const offset = customOffsets[p.exactModel] || { dx: 14, dy: -10, anchor: 'start' };
    const labelX = cx + offset.dx;
    const labelY = cy + offset.dy;

    const badgeWidth = p.exactModel.length * 6.5 + 16;
    const badgeHeight = 26;
    const badgeX = offset.anchor === 'end' ? labelX - badgeWidth - 4 : (offset.anchor === 'middle' ? labelX - badgeWidth / 2 : labelX - 4);
    const badgeY = labelY - 13;

    dataPointsSvg += `
      <g class="model-point" data-model="${p.exactModel}">
        ${isPareto ? `<circle cx="${cx}" cy="${cy}" r="${radius + 4}" fill="none" stroke="#22c55e" stroke-width="2.5" opacity="0.9" filter="drop-shadow(0 0 4px #22c55e)" />` : ''}
        <circle cx="${cx}" cy="${cy}" r="${radius}" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="2" />
        
        <!-- Text Badge Container -->
        <g transform="translate(0, 0)">
          <rect x="${badgeX}" y="${badgeY}" width="${badgeWidth}" height="${badgeHeight}" rx="4" fill="#0f172a" fill-opacity="0.92" stroke="#334155" stroke-width="0.8" />
          <text x="${labelX}" y="${labelY - 1}" fill="#f8fafc" font-size="10" font-weight="600" font-family="system-ui, sans-serif" text-anchor="${offset.anchor}">
            ${p.exactModel}
          </text>
          <text x="${labelX}" y="${labelY + 10}" fill="${isPareto ? '#4ade80' : '#94a3b8'}" font-size="9" font-weight="${isPareto ? '600' : '400'}" font-family="system-ui, sans-serif" text-anchor="${offset.anchor}">
            ${p.verdictAccuracyPct.toFixed(1)}% | $${p.totalCostUSD.toFixed(4)}
          </text>
        </g>
      </g>
    `;
  }

  // Position Legend at Bottom Center/Right inside plot area
  const legendX = width - padding.right - 230;
  const legendY = height - padding.bottom - 175;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <style>
    .bg { fill: #0f172a; }
    .title { fill: #f8fafc; font-family: system-ui, -apple-system, sans-serif; font-size: 21px; font-weight: 700; }
    .subtitle { fill: #94a3b8; font-family: system-ui, -apple-system, sans-serif; font-size: 12px; }
    .axis-label { fill: #cbd5e1; font-family: system-ui, -apple-system, sans-serif; font-size: 13px; font-weight: 600; }
    .legend-title { fill: #f8fafc; font-family: system-ui, -apple-system, sans-serif; font-size: 11.5px; font-weight: 700; }
    .legend-text { fill: #e2e8f0; font-family: system-ui, -apple-system, sans-serif; font-size: 11px; }
  </style>

  <!-- Background -->
  <rect width="${width}" height="${height}" rx="12" class="bg" />

  <!-- Title & Subtitle -->
  <text x="${padding.left}" y="36" class="title">${title}</text>
  <text x="${padding.left}" y="56" class="subtitle">Higher is better for Accuracy (Y), Lower is better for Cost (X) • Highlighted Halo = Pareto Optimal Frontier</text>

  <!-- Axes & Grid -->
  ${xGridLines}
  ${yGridLines}

  <!-- Axis Lines -->
  <line x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" stroke="#64748b" stroke-width="2" />
  <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}" stroke="#64748b" stroke-width="2" />

  <!-- Axis Titles -->
  <text x="${padding.left + plotWidth / 2}" y="${height - 28}" text-anchor="middle" class="axis-label">Total Cost ($ USD per 190 PR Reviews) [Linear Scale]</text>
  <text x="25" y="${padding.top + plotHeight / 2}" text-anchor="middle" transform="rotate(-90 25 ${padding.top + plotHeight / 2})" class="axis-label">Verdict Accuracy (%)</text>

  <!-- Data Points with Anti-Collision Labels -->
  ${dataPointsSvg}

  <!-- Bottom-Right Legend Card -->
  <g transform="translate(${legendX}, ${legendY - 35})">
    <rect width="215" height="185" rx="8" fill="#1e293b" fill-opacity="0.94" stroke="#475569" stroke-width="1.5" filter="drop-shadow(0 4px 6px rgba(0,0,0,0.3))" />
    <text x="16" y="20" class="legend-title">MODEL FAMILIES</text>
    
    <circle cx="20" cy="38" r="5" fill="#60a5fa" stroke="#3b82f6" stroke-width="1.5" />
    <text x="34" y="42" class="legend-text">DeepSeek V4 Flash</text>
    
    <circle cx="20" cy="58" r="5" fill="#34d399" stroke="#10b981" stroke-width="1.5" />
    <text x="34" y="62" class="legend-text">Google Gemini 3.7 Flash</text>
    
    <circle cx="20" cy="78" r="5" fill="#f472b6" stroke="#ec4899" stroke-width="1.5" />
    <text x="34" y="82" class="legend-text">Anthropic Claude 5 Haiku</text>

    <circle cx="20" cy="98" r="5" fill="#fb7185" stroke="#f43f5e" stroke-width="1.5" />
    <text x="34" y="102" class="legend-text">Anthropic Claude 5 Sonnet</text>

    <circle cx="20" cy="118" r="5" fill="#fbbf24" stroke="#f59e0b" stroke-width="1.5" />
    <text x="34" y="122" class="legend-text">OpenRouter 5.6 Luna</text>
    
    <circle cx="20" cy="138" r="5" fill="#a78bfa" stroke="#8b5cf6" stroke-width="1.5" />
    <text x="34" y="142" class="legend-text">Qwen 3.8 27B</text>
    
    <line x1="12" y1="154" x2="203" y2="154" stroke="#334155" stroke-width="1" />
    <circle cx="20" cy="168" r="6" fill="none" stroke="#22c55e" stroke-width="2" />
    <text x="34" y="172" class="legend-text" font-weight="600" fill="#4ade80">Pareto Optimal Frontier</text>
  </g>
</svg>`;
}

/**
 * Generates an ASCII/Unicode text-based scatter chart and Pareto table for terminal and markdown embedding.
 */
export function generateMarkdownParetoSection(points) {
  const paretoPoints = computeParetoFrontier(points);
  const paretoSet = new Set(paretoPoints.map((p) => p.exactModel));

  let md = `### 🎯 Pareto Frontier & Cost-Accuracy Tradeoff Analysis\n\n`;
  md += `| Exact Model Identifier | Reasoning Effort | Verdict Acc (%) | Recall | F1 Score | Avg SNR (dB) | TTFT (ms) | Total Cost ($) | Cost Efficiency (TP/$) | Pareto Frontier? |\n`;
  md += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |\n`;

  // Sort by Cost ascending
  const sorted = [...points].sort((a, b) => a.totalCostUSD - b.totalCostUSD);
  for (const p of sorted) {
    const isFrontier = paretoSet.has(p.exactModel);
    const frontierBadge = isFrontier ? '🌟 **Optimal**' : '—';
    const accBold = isFrontier ? `**${p.verdictAccuracyPct.toFixed(1)}%**` : `${p.verdictAccuracyPct.toFixed(1)}%`;
    const costBold = isFrontier ? `**$${p.totalCostUSD.toFixed(4)}**` : `$${p.totalCostUSD.toFixed(4)}`;

    md += `| \`${p.exactModel}\` | \`${p.effort}\` | ${accBold} | ${p.recall.toFixed(3)} | ${p.f1Score.toFixed(3)} | ${p.avgSnrDb.toFixed(1)} dB | ${p.avgTtftMs} ms | ${costBold} | ${p.costEfficiency.toFixed(1)} | ${frontierBadge} |\n`;
  }

  md += `\n> **Key Takeaway**: Models on the **Pareto Optimal Frontier** deliver the highest accuracy per dollar without being dominated on either cost or precision.\n`;
  return md;
}

/**
 * CLI execution entrypoint.
 */
export async function runCLI(argv = process.argv) {
  const args = argv.slice(2);
  let inputFile = path.join(projectRoot, 'eval-baselines', 'model-benchmark-matrix-v5.json');
  let outputDir = path.join(projectRoot, 'eval-baselines', 'charts');

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--input=')) {
      inputFile = path.resolve(arg.slice('--input='.length));
    } else if (arg === '--input' && i + 1 < args.length) {
      inputFile = path.resolve(args[++i]);
    } else if (arg.startsWith('--output-dir=')) {
      outputDir = path.resolve(arg.slice('--output-dir='.length));
    } else if (arg === '--output-dir' && i + 1 < args.length) {
      outputDir = path.resolve(args[++i]);
    }
  }

  if (!fs.existsSync(inputFile)) {
    console.error(`Error: Input baseline JSON not found at ${inputFile}`);
    process.exit(1);
  }

  const rawJson = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const summaryDict = rawJson.summary || rawJson;
  const points = extractModelPoints(summaryDict);

  if (points.length === 0) {
    console.error('Error: No model metrics found in input baseline JSON.');
    process.exit(1);
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const svgContent = generateParetoFrontierSVG(points);
  const svgPath = path.join(outputDir, 'pareto-frontier-accuracy-vs-cost.svg');
  fs.writeFileSync(svgPath, svgContent, 'utf8');

  console.log(`✅ Generated Pareto Frontier SVG Chart at ${svgPath}`);

  const mdSection = generateMarkdownParetoSection(points);
  console.log('\n' + mdSection);
}

// Auto-run if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCLI().catch((err) => {
    console.error('Fatal chart generator error:', err);
    process.exit(1);
  });
}
