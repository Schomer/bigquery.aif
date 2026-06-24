'use client';

import { useState, useMemo, useCallback } from 'react';
import type { QueryResult } from '@/lib/types';
import {
  COLORS,
  CHART_HEIGHT,
  buildChartData,
  resolveAxes,
  gaussianKDE,
  computeQuartiles,
  drillDownMessage,
} from './chart-utils';

// ---------------------------------------------------------------------------
// Shared types & constants
// ---------------------------------------------------------------------------

interface ChartProps {
  result: QueryResult;
  onSendMessage: (msg: string) => void;
}

const PAD = { top: 20, right: 20, bottom: 40, left: 50 };
const SVG_W = 600;
const SVG_H = 260;
const plotW = SVG_W - PAD.left - PAD.right;
const plotH = SVG_H - PAD.top - PAD.bottom;

interface TooltipState {
  x: number;
  y: number;
  lines: string[];
}

const tipStyle = {
  fontSize: 11,
  color: 'var(--text-dim)',
  textAlign: 'right' as const,
  fontStyle: 'italic' as const,
  paddingRight: 8,
  marginTop: 6,
};

// ---------------------------------------------------------------------------
// Tooltip overlay rendered inside SVG
// ---------------------------------------------------------------------------

function SvgTooltip({ tip }: { tip: TooltipState | null }) {
  if (!tip) return null;
  const lineH = 16;
  const padX = 8;
  const padY = 6;
  const w = Math.max(...tip.lines.map((l) => l.length * 7)) + padX * 2;
  const h = tip.lines.length * lineH + padY * 2;
  // Flip if near edges
  const tx = tip.x + w + 10 > SVG_W ? tip.x - w - 6 : tip.x + 10;
  const ty = tip.y + h + 10 > SVG_H ? tip.y - h - 6 : tip.y + 10;
  return (
    <g pointerEvents="none">
      <rect
        x={tx}
        y={ty}
        width={w}
        height={h}
        rx={4}
        fill="var(--surface-2)"
        stroke="var(--border)"
        strokeWidth={1}
        opacity={0.95}
      />
      {tip.lines.map((line, i) => (
        <text
          key={i}
          x={tx + padX}
          y={ty + padY + (i + 1) * lineH - 3}
          fill="var(--text)"
          fontSize={11}
        >
          {line}
        </text>
      ))}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Helper: numeric coercion
// ---------------------------------------------------------------------------

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function formatNum(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toFixed(2);
}

// ---------------------------------------------------------------------------
// Axis helpers
// ---------------------------------------------------------------------------

function drawXLabels(labels: string[], plotWidth: number, rotated = false) {
  const step = plotWidth / labels.length;
  return labels.map((label, i) => {
    const x = PAD.left + step * i + step / 2;
    const display = label.length > 10 ? label.slice(0, 9) + '..' : label;
    return (
      <text
        key={i}
        x={x}
        y={SVG_H - 6}
        fill="var(--text-muted)"
        fontSize={10}
        textAnchor={rotated ? 'end' : 'middle'}
        transform={rotated ? `rotate(-45, ${x}, ${SVG_H - 6})` : undefined}
      >
        {display}
      </text>
    );
  });
}

function drawYAxis(min: number, max: number, ticks = 5) {
  const range = max - min || 1;
  const elements = [];
  for (let i = 0; i <= ticks; i++) {
    const val = min + (range * i) / ticks;
    const y = PAD.top + plotH - (plotH * i) / ticks;
    elements.push(
      <text
        key={i}
        x={PAD.left - 6}
        y={y + 3}
        fill="var(--text-muted)"
        fontSize={10}
        textAnchor="end"
      >
        {formatNum(val)}
      </text>,
    );
    elements.push(
      <line
        key={`g${i}`}
        x1={PAD.left}
        y1={y}
        x2={SVG_W - PAD.right}
        y2={y}
        stroke="var(--border-subtle)"
        strokeWidth={0.5}
      />,
    );
  }
  return elements;
}

// ---------------------------------------------------------------------------
// 1. GaugeRenderer
// ---------------------------------------------------------------------------

export function GaugeRenderer({ result, onSendMessage }: ChartProps) {
  const data = useMemo(() => buildChartData(result.columns, result.rows), [result]);
  const { xKey, yKeys } = useMemo(
    () => resolveAxes(result.columns, result.xAxis, result.yAxis),
    [result],
  );

  const valueCol = yKeys[0] ?? result.columns[1];
  const currentValue = toNum(data[0]?.[valueCol]);
  const label = String(data[0]?.[xKey] ?? '');

  const allVals = data.map((d) => toNum(d[valueCol]));
  const rawMin = Math.min(...allVals);
  const rawMax = Math.max(...allVals);
  const gaugeMin = rawMin >= 0 ? 0 : rawMin;
  const gaugeMax = rawMax;
  const range = gaugeMax - gaugeMin || 1;
  const pct = Math.max(0, Math.min(1, (currentValue - gaugeMin) / range));

  const cx = SVG_W / 2;
  const cy = SVG_H - 50;
  const r = 90;

  // Arc from PI to 0 (left to right semicircle)
  const arcPath = (startAngle: number, endAngle: number) => {
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const large = endAngle - startAngle > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };

  const bgPath = arcPath(Math.PI, 0);
  const fgEnd = Math.PI - pct * Math.PI;
  const fgPath = arcPath(Math.PI, fgEnd);

  const handleClick = useCallback(() => {
    if (label) {
      onSendMessage(drillDownMessage(xKey, currentValue));
    }
  }, [label, currentValue, xKey, onSendMessage]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ width: '100%', height: CHART_HEIGHT }}>
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          style={{ width: '100%', height: '100%' }}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Label */}
          <text
            x={cx}
            y={cy - r - 14}
            fill="var(--text-muted)"
            fontSize={13}
            textAnchor="middle"
          >
            {label}
          </text>
          {/* Background arc */}
          <path
            d={bgPath}
            fill="none"
            stroke="var(--border-subtle)"
            strokeWidth={18}
            strokeLinecap="round"
          />
          {/* Foreground arc */}
          <path
            d={fgPath}
            fill="none"
            stroke={COLORS[0]}
            strokeWidth={18}
            strokeLinecap="round"
            style={{ cursor: 'pointer' }}
            onClick={handleClick}
          />
          {/* Value text */}
          <text
            x={cx}
            y={cy + 8}
            fill="var(--text)"
            fontSize={28}
            fontWeight={700}
            textAnchor="middle"
          >
            {formatNum(currentValue)}
          </text>
          {/* Min / Max labels */}
          <text x={cx - r - 4} y={cy + 22} fill="var(--text-muted)" fontSize={10} textAnchor="end">
            {formatNum(gaugeMin)}
          </text>
          <text
            x={cx + r + 4}
            y={cy + 22}
            fill="var(--text-muted)"
            fontSize={10}
            textAnchor="start"
          >
            {formatNum(gaugeMax)}
          </text>
        </svg>
      </div>
      <div style={tipStyle}>Tip: Click a chart element to filter and dive into the data.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. HeatmapRenderer
// ---------------------------------------------------------------------------

export function HeatmapRenderer({ result, onSendMessage }: ChartProps) {
  const [tip, setTip] = useState<TooltipState | null>(null);

  const { rowLabels, colLabels, grid, valMin, valMax } = useMemo(() => {
    const cols = result.columns;
    const rows = result.rows;
    const rl = [...new Set(rows.map((r) => String(r[0])))];
    const cl = [...new Set(rows.map((r) => String(r[1])))];
    const g: Map<string, number> = new Map();
    let vMin = Infinity;
    let vMax = -Infinity;
    rows.forEach((r) => {
      const v = toNum(r[2]);
      g.set(`${r[0]}|${r[1]}`, v);
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    });
    return { rowLabels: rl, colLabels: cl, grid: g, valMin: vMin, valMax: vMax };
  }, [result]);

  const cellW = plotW / colLabels.length;
  const cellH = plotH / rowLabels.length;

  // Interpolate between COLORS[0] (#62a8ea, blue) and COLORS[7] (#ef4444, red)
  const colorFor = useCallback(
    (v: number) => {
      const t = valMax === valMin ? 0.5 : (v - valMin) / (valMax - valMin);
      const r = Math.round(0x62 + t * (0xef - 0x62));
      const g = Math.round(0xa8 + t * (0x44 - 0xa8));
      const b = Math.round(0xea + t * (0x44 - 0xea));
      return `rgb(${r},${g},${b})`;
    },
    [valMin, valMax],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ width: '100%', height: CHART_HEIGHT }}>
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          style={{ width: '100%', height: '100%' }}
          preserveAspectRatio="xMidYMid meet"
        >
          {rowLabels.map((rl, ri) =>
            colLabels.map((cl, ci) => {
              const key = `${rl}|${cl}`;
              const v = grid.get(key) ?? 0;
              const x = PAD.left + ci * cellW;
              const y = PAD.top + ri * cellH;
              return (
                <rect
                  key={key}
                  x={x}
                  y={y}
                  width={cellW - 1}
                  height={cellH - 1}
                  fill={colorFor(v)}
                  rx={2}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={(e) => {
                    const svg = e.currentTarget.ownerSVGElement;
                    if (!svg) return;
                    const pt = svg.createSVGPoint();
                    pt.x = e.clientX;
                    pt.y = e.clientY;
                    const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse());
                    setTip({ x: svgP.x, y: svgP.y, lines: [`${rl} / ${cl}`, `Value: ${formatNum(v)}`] });
                  }}
                  onMouseLeave={() => setTip(null)}
                  onClick={() => {
                    onSendMessage(drillDownMessage(result.columns[0], rl));
                  }}
                />
              );
            }),
          )}
          {/* Row labels */}
          {rowLabels.map((rl, ri) => {
            const display = rl.length > 8 ? rl.slice(0, 7) + '..' : rl;
            return (
              <text
                key={ri}
                x={PAD.left - 4}
                y={PAD.top + ri * cellH + cellH / 2 + 3}
                fill="var(--text-muted)"
                fontSize={10}
                textAnchor="end"
              >
                {display}
              </text>
            );
          })}
          {/* Column labels */}
          {colLabels.map((cl, ci) => {
            const display = cl.length > 8 ? cl.slice(0, 7) + '..' : cl;
            const x = PAD.left + ci * cellW + cellW / 2;
            return (
              <text
                key={ci}
                x={x}
                y={SVG_H - 4}
                fill="var(--text-muted)"
                fontSize={10}
                textAnchor="end"
                transform={`rotate(-45, ${x}, ${SVG_H - 4})`}
              >
                {display}
              </text>
            );
          })}
          <SvgTooltip tip={tip} />
        </svg>
      </div>
      <div style={tipStyle}>Tip: Click a chart element to filter and dive into the data.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. BoxplotRenderer
// ---------------------------------------------------------------------------

export function BoxplotRenderer({ result, onSendMessage }: ChartProps) {
  const [tip, setTip] = useState<TooltipState | null>(null);

  const { xKey, yKeys } = useMemo(
    () => resolveAxes(result.columns, result.xAxis, result.yAxis),
    [result],
  );
  const data = useMemo(() => buildChartData(result.columns, result.rows), [result]);
  const valueCol = yKeys[0] ?? result.columns[1];

  const { groups, globalMin, globalMax } = useMemo(() => {
    const grouped: Map<string, number[]> = new Map();
    data.forEach((d) => {
      const cat = String(d[xKey]);
      const v = toNum(d[valueCol]);
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat)!.push(v);
    });
    const entries = [...grouped.entries()];
    let gMin = Infinity;
    let gMax = -Infinity;
    const gps = entries.map(([cat, vals]) => {
      const q = computeQuartiles(vals);
      if (q.min < gMin) gMin = q.min;
      if (q.max > gMax) gMax = q.max;
      return { cat, ...q };
    });
    return { groups: gps, globalMin: gMin, globalMax: gMax };
  }, [data, xKey, valueCol]);

  const yRange = globalMax - globalMin || 1;
  const yScale = (v: number) => PAD.top + plotH - ((v - globalMin) / yRange) * plotH;

  const boxW = Math.min(40, plotW / groups.length - 8);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ width: '100%', height: CHART_HEIGHT }}>
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          style={{ width: '100%', height: '100%' }}
          preserveAspectRatio="xMidYMid meet"
        >
          {drawYAxis(globalMin, globalMax)}
          {groups.map((g, i) => {
            const step = plotW / groups.length;
            const cx = PAD.left + step * i + step / 2;
            const bx = cx - boxW / 2;
            return (
              <g
                key={g.cat}
                style={{ cursor: 'pointer' }}
                onMouseEnter={(e) => {
                  const svg = e.currentTarget.ownerSVGElement;
                  if (!svg) return;
                  const pt = svg.createSVGPoint();
                  pt.x = e.clientX;
                  pt.y = e.clientY;
                  const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse());
                  setTip({
                    x: svgP.x,
                    y: svgP.y,
                    lines: [
                      g.cat,
                      `Min: ${formatNum(g.min)}`,
                      `Q1: ${formatNum(g.q1)}`,
                      `Med: ${formatNum(g.median)}`,
                      `Q3: ${formatNum(g.q3)}`,
                      `Max: ${formatNum(g.max)}`,
                    ],
                  });
                }}
                onMouseLeave={() => setTip(null)}
                onClick={() => {
                  onSendMessage(drillDownMessage(xKey, g.cat));
                }}
              >
                {/* Whisker line min to max */}
                <line
                  x1={cx}
                  y1={yScale(g.max)}
                  x2={cx}
                  y2={yScale(g.min)}
                  stroke="var(--text-muted)"
                  strokeWidth={1}
                />
                {/* Whisker caps */}
                <line
                  x1={cx - boxW / 4}
                  y1={yScale(g.min)}
                  x2={cx + boxW / 4}
                  y2={yScale(g.min)}
                  stroke="var(--text-muted)"
                  strokeWidth={1}
                />
                <line
                  x1={cx - boxW / 4}
                  y1={yScale(g.max)}
                  x2={cx + boxW / 4}
                  y2={yScale(g.max)}
                  stroke="var(--text-muted)"
                  strokeWidth={1}
                />
                {/* Box q1 to q3 */}
                <rect
                  x={bx}
                  y={yScale(g.q3)}
                  width={boxW}
                  height={Math.max(1, yScale(g.q1) - yScale(g.q3))}
                  fill={COLORS[0]}
                  fillOpacity={0.4}
                  stroke={COLORS[0]}
                  strokeWidth={1.5}
                  rx={2}
                />
                {/* Median line */}
                <line
                  x1={bx}
                  y1={yScale(g.median)}
                  x2={bx + boxW}
                  y2={yScale(g.median)}
                  stroke={COLORS[0]}
                  strokeWidth={2}
                />
              </g>
            );
          })}
          {/* X labels */}
          {drawXLabels(
            groups.map((g) => g.cat),
            plotW,
          )}
          <SvgTooltip tip={tip} />
        </svg>
      </div>
      <div style={tipStyle}>Tip: Click a chart element to filter and dive into the data.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. CandlestickRenderer
// ---------------------------------------------------------------------------

function detectOHLC(columns: string[]): {
  dateCol: string;
  openCol: string;
  highCol: string;
  lowCol: string;
  closeCol: string;
} | null {
  const lower = columns.map((c) => c.toLowerCase());
  const find = (patterns: string[]) =>
    columns[lower.findIndex((l) => patterns.some((p) => l.includes(p)))];
  const dateCol = find(['date', 'time', 'timestamp', 'day', 'period']);
  const openCol = find(['open']);
  const highCol = find(['high']);
  const lowCol = find(['low']);
  const closeCol = find(['close']);
  if (!dateCol || !openCol || !highCol || !lowCol || !closeCol) return null;
  return { dateCol, openCol, highCol, lowCol, closeCol };
}

export function CandlestickRenderer({ result, onSendMessage }: ChartProps) {
  const [tip, setTip] = useState<TooltipState | null>(null);

  const data = useMemo(() => buildChartData(result.columns, result.rows), [result]);
  const ohlc = useMemo(() => detectOHLC(result.columns), [result.columns]);

  const { candles, priceMin, priceMax } = useMemo(() => {
    if (!ohlc) return { candles: [], priceMin: 0, priceMax: 0 };
    let pMin = Infinity;
    let pMax = -Infinity;
    const cs = data.map((d) => {
      const o = toNum(d[ohlc.openCol]);
      const h = toNum(d[ohlc.highCol]);
      const l = toNum(d[ohlc.lowCol]);
      const c = toNum(d[ohlc.closeCol]);
      const label = String(d[ohlc.dateCol] ?? '');
      if (l < pMin) pMin = l;
      if (h > pMax) pMax = h;
      return { label, o, h, l, c };
    });
    return { candles: cs, priceMin: pMin, priceMax: pMax };
  }, [data, ohlc]);

  if (!ohlc || candles.length === 0) {
    return (
      <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>
        Candlestick chart requires columns matching: date/time, open, high, low, close.
      </div>
    );
  }

  const yRange = priceMax - priceMin || 1;
  const yScale = (v: number) => PAD.top + plotH - ((v - priceMin) / yRange) * plotH;
  const candleW = Math.min(12, plotW / candles.length - 2);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ width: '100%', height: CHART_HEIGHT }}>
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          style={{ width: '100%', height: '100%' }}
          preserveAspectRatio="xMidYMid meet"
        >
          {drawYAxis(priceMin, priceMax)}
          {candles.map((c, i) => {
            const step = plotW / candles.length;
            const cx = PAD.left + step * i + step / 2;
            const bullish = c.c >= c.o;
            const color = bullish ? '#10b981' : '#ef4444';
            const bodyTop = bullish ? c.c : c.o;
            const bodyBot = bullish ? c.o : c.c;
            return (
              <g
                key={i}
                style={{ cursor: 'pointer' }}
                onMouseEnter={(e) => {
                  const svg = e.currentTarget.ownerSVGElement;
                  if (!svg) return;
                  const pt = svg.createSVGPoint();
                  pt.x = e.clientX;
                  pt.y = e.clientY;
                  const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse());
                  setTip({
                    x: svgP.x,
                    y: svgP.y,
                    lines: [
                      c.label,
                      `O: ${formatNum(c.o)}`,
                      `H: ${formatNum(c.h)}`,
                      `L: ${formatNum(c.l)}`,
                      `C: ${formatNum(c.c)}`,
                    ],
                  });
                }}
                onMouseLeave={() => setTip(null)}
                onClick={() => {
                  onSendMessage(drillDownMessage(ohlc.dateCol, c.label));
                }}
              >
                {/* Wick */}
                <line
                  x1={cx}
                  y1={yScale(c.h)}
                  x2={cx}
                  y2={yScale(c.l)}
                  stroke={color}
                  strokeWidth={1}
                />
                {/* Body */}
                <rect
                  x={cx - candleW / 2}
                  y={yScale(bodyTop)}
                  width={candleW}
                  height={Math.max(1, yScale(bodyBot) - yScale(bodyTop))}
                  fill={bullish ? color : color}
                  stroke={color}
                  strokeWidth={1}
                  rx={1}
                />
              </g>
            );
          })}
          {/* X labels -- show a subset to avoid overlap */}
          {(() => {
            const maxLabels = Math.floor(plotW / 50);
            const step = Math.max(1, Math.ceil(candles.length / maxLabels));
            return candles
              .filter((_, i) => i % step === 0)
              .map((c, i) => {
                const idx = i * step;
                const xPos = PAD.left + (plotW / candles.length) * idx + (plotW / candles.length) / 2;
                const display = c.label.length > 10 ? c.label.slice(0, 9) + '..' : c.label;
                return (
                  <text
                    key={i}
                    x={xPos}
                    y={SVG_H - 6}
                    fill="var(--text-muted)"
                    fontSize={10}
                    textAnchor="middle"
                  >
                    {display}
                  </text>
                );
              });
          })()}
          <SvgTooltip tip={tip} />
        </svg>
      </div>
      <div style={tipStyle}>Tip: Click a chart element to filter and dive into the data.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. ViolinRenderer
// ---------------------------------------------------------------------------

export function ViolinRenderer({ result, onSendMessage }: ChartProps) {
  const [tip, setTip] = useState<TooltipState | null>(null);

  const { xKey, yKeys } = useMemo(
    () => resolveAxes(result.columns, result.xAxis, result.yAxis),
    [result],
  );
  const data = useMemo(() => buildChartData(result.columns, result.rows), [result]);
  const valueCol = yKeys[0] ?? result.columns[1];

  const { groups, globalMin, globalMax, maxDensity } = useMemo(() => {
    const grouped: Map<string, number[]> = new Map();
    data.forEach((d) => {
      const cat = String(d[xKey]);
      const v = toNum(d[valueCol]);
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat)!.push(v);
    });
    let gMin = Infinity;
    let gMax = -Infinity;
    let mDens = 0;
    const entries = [...grouped.entries()];
    const gps = entries.map(([cat, vals]) => {
      const mn = Math.min(...vals);
      const mx = Math.max(...vals);
      if (mn < gMin) gMin = mn;
      if (mx > gMax) gMax = mx;
      const kde = gaussianKDE(vals);
      const steps = 50;
      const range = mx - mn || 1;
      const densityPts: { v: number; d: number }[] = [];
      for (let s = 0; s <= steps; s++) {
        const v = mn + (range * s) / steps;
        const d = kde(v);
        if (d > mDens) mDens = d;
        densityPts.push({ v, d });
      }
      return { cat, vals, densityPts };
    });
    return { groups: gps, globalMin: gMin, globalMax: gMax, maxDensity: mDens };
  }, [data, xKey, valueCol]);

  const yRange = globalMax - globalMin || 1;
  const yScale = (v: number) => PAD.top + plotH - ((v - globalMin) / yRange) * plotH;

  const violinHalfW = Math.min(30, plotW / groups.length / 2 - 4);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ width: '100%', height: CHART_HEIGHT }}>
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          style={{ width: '100%', height: '100%' }}
          preserveAspectRatio="xMidYMid meet"
        >
          {drawYAxis(globalMin, globalMax)}
          {groups.map((g, i) => {
            const step = plotW / groups.length;
            const cx = PAD.left + step * i + step / 2;
            const dScale = maxDensity > 0 ? violinHalfW / maxDensity : 0;

            // Build mirrored path
            const rightPts = g.densityPts.map(
              (p) => `${cx + p.d * dScale},${yScale(p.v)}`,
            );
            const leftPts = g.densityPts
              .map((p) => `${cx - p.d * dScale},${yScale(p.v)}`)
              .reverse();
            const pathD = `M ${rightPts[0]} L ${rightPts.join(' L ')} L ${leftPts.join(' L ')} Z`;

            return (
              <g
                key={g.cat}
                style={{ cursor: 'pointer' }}
                onMouseEnter={(e) => {
                  const svg = e.currentTarget.ownerSVGElement;
                  if (!svg) return;
                  const pt = svg.createSVGPoint();
                  pt.x = e.clientX;
                  pt.y = e.clientY;
                  const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse());
                  const q = computeQuartiles(g.vals);
                  setTip({
                    x: svgP.x,
                    y: svgP.y,
                    lines: [
                      g.cat,
                      `N: ${g.vals.length}`,
                      `Med: ${formatNum(q.median)}`,
                      `Q1: ${formatNum(q.q1)}`,
                      `Q3: ${formatNum(q.q3)}`,
                    ],
                  });
                }}
                onMouseLeave={() => setTip(null)}
                onClick={() => {
                  onSendMessage(drillDownMessage(xKey, g.cat));
                }}
              >
                <path d={pathD} fill={COLORS[i % COLORS.length]} fillOpacity={0.35} stroke={COLORS[i % COLORS.length]} strokeWidth={1.5} />
              </g>
            );
          })}
          {drawXLabels(
            groups.map((g) => g.cat),
            plotW,
          )}
          <SvgTooltip tip={tip} />
        </svg>
      </div>
      <div style={tipStyle}>Tip: Click a chart element to filter and dive into the data.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6. DensityPlotRenderer
// ---------------------------------------------------------------------------

export function DensityPlotRenderer({ result, onSendMessage }: ChartProps) {
  const [tip, setTip] = useState<TooltipState | null>(null);

  const { xKey, yKeys } = useMemo(
    () => resolveAxes(result.columns, result.xAxis, result.yAxis),
    [result],
  );
  const data = useMemo(() => buildChartData(result.columns, result.rows), [result]);
  const valueCol = result.columns.length === 2 ? result.columns[1] : yKeys[0] ?? result.columns[1];

  const { points, dataMin, dataMax, densMax } = useMemo(() => {
    const vals = data.map((d) => toNum(d[valueCol])).filter((v) => !isNaN(v));
    if (vals.length === 0) return { points: [], dataMin: 0, dataMax: 0, densMax: 0 };
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    const kde = gaussianKDE(vals);
    const nPts = 100;
    const range = mx - mn || 1;
    const pad = range * 0.1;
    let dMax = 0;
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= nPts; i++) {
      const x = mn - pad + ((mx - mn + pad * 2) * i) / nPts;
      const y = kde(x);
      if (y > dMax) dMax = y;
      pts.push({ x, y });
    }
    return { points: pts, dataMin: mn - pad, dataMax: mx + pad, densMax: dMax };
  }, [data, valueCol]);

  if (points.length === 0) {
    return (
      <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>
        No numeric data for density plot.
      </div>
    );
  }

  const xRange = dataMax - dataMin || 1;
  const xScale = (v: number) => PAD.left + ((v - dataMin) / xRange) * plotW;
  const yScale = (v: number) => PAD.top + plotH - (densMax > 0 ? (v / densMax) * plotH : 0);

  const areaPath =
    `M ${xScale(points[0].x)},${PAD.top + plotH}` +
    points.map((p) => ` L ${xScale(p.x)},${yScale(p.y)}`).join('') +
    ` L ${xScale(points[points.length - 1].x)},${PAD.top + plotH} Z`;

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.x)},${yScale(p.y)}`).join(' ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ width: '100%', height: CHART_HEIGHT }}>
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          style={{ width: '100%', height: '100%' }}
          preserveAspectRatio="xMidYMid meet"
          onMouseMove={(e) => {
            const svg = e.currentTarget;
            const pt = svg.createSVGPoint();
            pt.x = e.clientX;
            pt.y = e.clientY;
            const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse());
            const dataX = dataMin + ((svgP.x - PAD.left) / plotW) * xRange;
            if (svgP.x >= PAD.left && svgP.x <= SVG_W - PAD.right) {
              const closest = points.reduce((best, p) =>
                Math.abs(p.x - dataX) < Math.abs(best.x - dataX) ? p : best,
              );
              setTip({
                x: svgP.x,
                y: svgP.y,
                lines: [`${valueCol}: ${formatNum(closest.x)}`, `Density: ${closest.y.toFixed(4)}`],
              });
            }
          }}
          onMouseLeave={() => setTip(null)}
        >
          {drawYAxis(0, densMax)}
          {/* X axis labels */}
          {(() => {
            const ticks = 6;
            const els = [];
            for (let i = 0; i <= ticks; i++) {
              const v = dataMin + (xRange * i) / ticks;
              els.push(
                <text
                  key={i}
                  x={xScale(v)}
                  y={SVG_H - 6}
                  fill="var(--text-muted)"
                  fontSize={10}
                  textAnchor="middle"
                >
                  {formatNum(v)}
                </text>,
              );
            }
            return els;
          })()}
          <path d={areaPath} fill={COLORS[0]} fillOpacity={0.3} />
          <path d={linePath} fill="none" stroke={COLORS[0]} strokeWidth={2} />
          <SvgTooltip tip={tip} />
        </svg>
      </div>
      <div style={tipStyle}>Tip: Click a chart element to filter and dive into the data.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 7. RidgelineRenderer
// ---------------------------------------------------------------------------

export function RidgelineRenderer({ result, onSendMessage }: ChartProps) {
  const [tip, setTip] = useState<TooltipState | null>(null);

  const { xKey, yKeys } = useMemo(
    () => resolveAxes(result.columns, result.xAxis, result.yAxis),
    [result],
  );
  const data = useMemo(() => buildChartData(result.columns, result.rows), [result]);
  const valueCol = yKeys[0] ?? result.columns[1];

  const { ridges, globalMin, globalMax } = useMemo(() => {
    const grouped: Map<string, number[]> = new Map();
    data.forEach((d) => {
      const cat = String(d[xKey]);
      const v = toNum(d[valueCol]);
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat)!.push(v);
    });
    let gMin = Infinity;
    let gMax = -Infinity;
    const entries = [...grouped.entries()];
    const rs = entries.map(([cat, vals]) => {
      const mn = Math.min(...vals);
      const mx = Math.max(...vals);
      if (mn < gMin) gMin = mn;
      if (mx > gMax) gMax = mx;
      return { cat, vals, min: mn, max: mx };
    });
    return { ridges: rs, globalMin: gMin, globalMax: gMax };
  }, [data, xKey, valueCol]);

  const xRange = globalMax - globalMin || 1;
  const xScale = (v: number) => PAD.left + ((v - globalMin) / xRange) * plotW;

  const ridgeCount = ridges.length;
  const ridgeH = plotH / Math.max(ridgeCount, 1);
  const overlap = ridgeH * 0.3;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ width: '100%', height: CHART_HEIGHT }}>
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          style={{ width: '100%', height: '100%' }}
          preserveAspectRatio="xMidYMid meet"
        >
          {ridges.map((ridge, ri) => {
            const kde = gaussianKDE(ridge.vals);
            const baseline = PAD.top + ridgeH * (ri + 1) - overlap * ri;
            const nPts = 80;
            const pad = xRange * 0.05;
            let maxD = 0;
            const pts: { x: number; d: number }[] = [];
            for (let s = 0; s <= nPts; s++) {
              const x = globalMin - pad + ((xRange + pad * 2) * s) / nPts;
              const d = kde(x);
              if (d > maxD) maxD = d;
              pts.push({ x, d });
            }
            const dScale = maxD > 0 ? (ridgeH + overlap) * 0.8 / maxD : 0;
            const pathD =
              `M ${xScale(pts[0].x)},${baseline}` +
              pts.map((p) => ` L ${xScale(p.x)},${baseline - p.d * dScale}`).join('') +
              ` L ${xScale(pts[pts.length - 1].x)},${baseline} Z`;

            return (
              <g
                key={ridge.cat}
                style={{ cursor: 'pointer' }}
                onMouseEnter={(e) => {
                  const svg = e.currentTarget.ownerSVGElement;
                  if (!svg) return;
                  const pt = svg.createSVGPoint();
                  pt.x = e.clientX;
                  pt.y = e.clientY;
                  const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse());
                  setTip({
                    x: svgP.x,
                    y: svgP.y,
                    lines: [ridge.cat, `N: ${ridge.vals.length}`],
                  });
                }}
                onMouseLeave={() => setTip(null)}
                onClick={() => {
                  onSendMessage(drillDownMessage(xKey, ridge.cat));
                }}
              >
                <path
                  d={pathD}
                  fill={COLORS[ri % COLORS.length]}
                  fillOpacity={0.45}
                  stroke={COLORS[ri % COLORS.length]}
                  strokeWidth={1.5}
                />
                <text
                  x={PAD.left - 4}
                  y={baseline - ridgeH * 0.3}
                  fill="var(--text-muted)"
                  fontSize={10}
                  textAnchor="end"
                >
                  {ridge.cat.length > 10 ? ridge.cat.slice(0, 9) + '..' : ridge.cat}
                </text>
              </g>
            );
          })}
          {/* X axis labels */}
          {(() => {
            const ticks = 6;
            const els = [];
            for (let i = 0; i <= ticks; i++) {
              const v = globalMin + (xRange * i) / ticks;
              els.push(
                <text
                  key={i}
                  x={xScale(v)}
                  y={SVG_H - 6}
                  fill="var(--text-muted)"
                  fontSize={10}
                  textAnchor="middle"
                >
                  {formatNum(v)}
                </text>,
              );
            }
            return els;
          })()}
          <SvgTooltip tip={tip} />
        </svg>
      </div>
      <div style={tipStyle}>Tip: Click a chart element to filter and dive into the data.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 8. NetworkGraphRenderer
// ---------------------------------------------------------------------------

interface LayoutNode {
  id: string;
  x: number;
  y: number;
  connections: number;
}

interface LayoutLink {
  source: string;
  target: string;
  weight: number;
}

function computeForceLayout(
  nodes: LayoutNode[],
  links: LayoutLink[],
  width: number,
  height: number,
  iterations = 50,
): LayoutNode[] {
  // Initialize positions in a circle
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) * 0.35;
  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / nodes.length;
    node.x = cx + r * Math.cos(angle);
    node.y = cy + r * Math.sin(angle);
  });

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  for (let iter = 0; iter < iterations; iter++) {
    const cooling = 1 - iter / iterations;
    // Repulsion between all pairs
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (800 / (dist * dist)) * cooling;
        dx = (dx / dist) * force;
        dy = (dy / dist) * force;
        a.x -= dx;
        a.y -= dy;
        b.x += dx;
        b.y += dy;
      }
    }
    // Attraction along links
    for (const link of links) {
      const a = nodeMap.get(link.source);
      const b = nodeMap.get(link.target);
      if (!a || !b) continue;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - 60) * 0.05 * cooling;
      dx = (dx / dist) * force;
      dy = (dy / dist) * force;
      a.x += dx;
      a.y += dy;
      b.x -= dx;
      b.y -= dy;
    }
    // Keep nodes within bounds
    for (const node of nodes) {
      node.x = Math.max(20, Math.min(width - 20, node.x));
      node.y = Math.max(20, Math.min(height - 20, node.y));
    }
  }
  return nodes;
}

export function NetworkGraphRenderer({ result, onSendMessage }: ChartProps) {
  const [tip, setTip] = useState<TooltipState | null>(null);

  const { nodes, links } = useMemo(() => {
    const rows = result.rows;
    const cols = result.columns;
    const hasWeight = cols.length >= 3;

    const nodeSet = new Set<string>();
    const connectionCount = new Map<string, number>();
    const ls: LayoutLink[] = [];

    rows.forEach((r) => {
      const src = String(r[0]);
      const tgt = String(r[1]);
      const w = hasWeight ? toNum(r[2]) : 1;
      nodeSet.add(src);
      nodeSet.add(tgt);
      connectionCount.set(src, (connectionCount.get(src) ?? 0) + 1);
      connectionCount.set(tgt, (connectionCount.get(tgt) ?? 0) + 1);
      ls.push({ source: src, target: tgt, weight: w });
    });

    const ns: LayoutNode[] = [...nodeSet].map((id) => ({
      id,
      x: 0,
      y: 0,
      connections: connectionCount.get(id) ?? 1,
    }));

    computeForceLayout(ns, ls, plotW, plotH, 50);
    // Offset by padding
    ns.forEach((n) => {
      n.x += PAD.left;
      n.y += PAD.top;
    });

    return { nodes: ns, links: ls };
  }, [result]);

  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const maxConn = Math.max(...nodes.map((n) => n.connections), 1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ width: '100%', height: CHART_HEIGHT }}>
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          style={{ width: '100%', height: '100%' }}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Links */}
          {links.map((link, i) => {
            const a = nodeMap.get(link.source);
            const b = nodeMap.get(link.target);
            if (!a || !b) return null;
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="var(--border)"
                strokeWidth={Math.max(1, Math.min(3, link.weight))}
                strokeOpacity={0.5}
              />
            );
          })}
          {/* Nodes */}
          {nodes.map((node, i) => {
            const radius = 4 + (node.connections / maxConn) * 10;
            return (
              <g
                key={node.id}
                style={{ cursor: 'pointer' }}
                onMouseEnter={(e) => {
                  const svg = e.currentTarget.ownerSVGElement;
                  if (!svg) return;
                  const pt = svg.createSVGPoint();
                  pt.x = e.clientX;
                  pt.y = e.clientY;
                  const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse());
                  setTip({
                    x: svgP.x,
                    y: svgP.y,
                    lines: [node.id, `Connections: ${node.connections}`],
                  });
                }}
                onMouseLeave={() => setTip(null)}
                onClick={() => {
                  onSendMessage(drillDownMessage(result.columns[0], node.id));
                }}
              >
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={radius}
                  fill={COLORS[i % COLORS.length]}
                  fillOpacity={0.85}
                  stroke="var(--surface-2)"
                  strokeWidth={1.5}
                />
                <text
                  x={node.x}
                  y={node.y - radius - 3}
                  fill="var(--text-muted)"
                  fontSize={9}
                  textAnchor="middle"
                >
                  {node.id.length > 12 ? node.id.slice(0, 11) + '..' : node.id}
                </text>
              </g>
            );
          })}
          <SvgTooltip tip={tip} />
        </svg>
      </div>
      <div style={tipStyle}>Tip: Click a chart element to filter and dive into the data.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 9. TileMapRenderer
// ---------------------------------------------------------------------------

export function TileMapRenderer({ result, onSendMessage }: ChartProps) {
  const [tip, setTip] = useState<TooltipState | null>(null);

  const { tiles, gridCols, gridRows, valMin, valMax, labelCol, valueCol } = useMemo(() => {
    const cols = result.columns;
    const rows = result.rows;

    // Detect if we have explicit x/y position columns
    const lowerCols = cols.map((c) => c.toLowerCase());
    const hasPosition =
      lowerCols.some((c) => c.includes('row') || c.includes('x_pos') || c === 'x') &&
      lowerCols.some((c) => c.includes('col') || c.includes('y_pos') || c === 'y');

    let tileData: { row: number; col: number; value: number; label: string }[];
    let nCols: number;
    let nRows: number;
    let lCol = cols[0];
    let vCol = cols.length >= 3 ? cols[2] : cols[1];

    if (hasPosition && cols.length >= 3) {
      // Explicit positions: columns[0] = row, columns[1] = col, columns[2] = value, columns[3]? = label
      vCol = cols[2];
      lCol = cols.length >= 4 ? cols[3] : cols[2];
      tileData = rows.map((r) => ({
        row: toNum(r[0]),
        col: toNum(r[1]),
        value: toNum(r[2]),
        label: cols.length >= 4 ? String(r[3]) : formatNum(toNum(r[2])),
      }));
      nCols = Math.max(...tileData.map((t) => t.col)) + 1;
      nRows = Math.max(...tileData.map((t) => t.row)) + 1;
    } else {
      // Auto-arrange: columns[0] = label, columns[1] = value
      vCol = cols[1] ?? cols[0];
      lCol = cols[0];
      const n = rows.length;
      nCols = Math.ceil(Math.sqrt(n));
      nRows = Math.ceil(n / nCols);
      tileData = rows.map((r, i) => ({
        row: Math.floor(i / nCols),
        col: i % nCols,
        value: toNum(r[1] ?? r[0]),
        label: String(r[0]),
      }));
    }

    let vMin = Infinity;
    let vMax = -Infinity;
    tileData.forEach((t) => {
      if (t.value < vMin) vMin = t.value;
      if (t.value > vMax) vMax = t.value;
    });

    return {
      tiles: tileData,
      gridCols: nCols,
      gridRows: nRows,
      valMin: vMin,
      valMax: vMax,
      labelCol: lCol,
      valueCol: vCol,
    };
  }, [result]);

  const cellW = plotW / gridCols;
  const cellH = plotH / gridRows;
  const tileGap = 2;

  const colorFor = useCallback(
    (v: number) => {
      const t = valMax === valMin ? 0.5 : (v - valMin) / (valMax - valMin);
      const r = Math.round(0x62 + t * (0xef - 0x62));
      const g = Math.round(0xa8 + t * (0x44 - 0xa8));
      const b = Math.round(0xea + t * (0x44 - 0xea));
      return `rgb(${r},${g},${b})`;
    },
    [valMin, valMax],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ width: '100%', height: CHART_HEIGHT }}>
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          style={{ width: '100%', height: '100%' }}
          preserveAspectRatio="xMidYMid meet"
        >
          {tiles.map((tile, i) => {
            const x = PAD.left + tile.col * cellW + tileGap / 2;
            const y = PAD.top + tile.row * cellH + tileGap / 2;
            const w = cellW - tileGap;
            const h = cellH - tileGap;
            const display =
              tile.label.length > Math.floor(w / 6)
                ? tile.label.slice(0, Math.floor(w / 6) - 1) + '..'
                : tile.label;
            // Determine text color based on value intensity for readability
            const t = valMax === valMin ? 0.5 : (tile.value - valMin) / (valMax - valMin);
            const textFill = t > 0.6 ? '#fff' : 'var(--text)';
            return (
              <g
                key={i}
                style={{ cursor: 'pointer' }}
                onMouseEnter={(e) => {
                  const svg = e.currentTarget.ownerSVGElement;
                  if (!svg) return;
                  const pt = svg.createSVGPoint();
                  pt.x = e.clientX;
                  pt.y = e.clientY;
                  const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse());
                  setTip({
                    x: svgP.x,
                    y: svgP.y,
                    lines: [tile.label, `${valueCol}: ${formatNum(tile.value)}`],
                  });
                }}
                onMouseLeave={() => setTip(null)}
                onClick={() => {
                  onSendMessage(drillDownMessage(labelCol, tile.label));
                }}
              >
                <rect
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  fill={colorFor(tile.value)}
                  rx={3}
                />
                <text
                  x={x + w / 2}
                  y={y + h / 2 + 3}
                  fill={textFill}
                  fontSize={Math.min(11, w / 5)}
                  textAnchor="middle"
                >
                  {display}
                </text>
              </g>
            );
          })}
          <SvgTooltip tip={tip} />
        </svg>
      </div>
      <div style={tipStyle}>Tip: Click a chart element to filter and dive into the data.</div>
    </div>
  );
}
