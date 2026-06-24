export const COLORS = [
  '#62a8ea',
  '#aaa47c',
  '#a8d95e',
  '#40bdd4',
  '#7375c9',
  '#ea75b0',
  '#f59e0b',
  '#ef4444',
  '#10b981',
  '#8b5cf6',
];

export const AXIS_STYLE = {
  tick: { fill: 'var(--text-muted)', fontSize: 11 },
  axisLine: false,
  tickLine: false,
};

export const TOOLTIP_STYLE = {
  contentStyle: {
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    fontSize: 12,
    color: 'var(--text)',
  },
};

export const GRID_STYLE = {
  stroke: 'var(--border-subtle)',
  vertical: false,
};

export const CHART_HEIGHT = 260;

export const CHART_MARGIN = { top: 4, right: 16, left: 0, bottom: 4 };

/**
 * Maps columnar query results into an array of row objects keyed by column name.
 */
export function buildChartData(
  columns: string[],
  rows: unknown[][],
): Record<string, unknown>[] {
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

/**
 * Resolves which column is the x-axis and which columns are y-axes.
 * Falls back to first column for x and all remaining columns for y.
 */
export function resolveAxes(
  columns: string[],
  xAxis?: string | null,
  yAxis?: string[] | null,
): { xKey: string; yKeys: string[] } {
  const xKey = xAxis ?? columns[0];
  const yKeys = yAxis ?? columns.filter((c) => c !== xKey);
  return { xKey, yKeys };
}

/**
 * Returns a Gaussian KDE estimator function for the given data.
 * Uses Silverman's rule of thumb for bandwidth when not provided.
 */
export function gaussianKDE(
  data: number[],
  bandwidth?: number,
): (x: number) => number {
  const n = data.length;
  if (n === 0) return () => 0;

  const h =
    bandwidth ??
    (() => {
      const mean = data.reduce((s, v) => s + v, 0) / n;
      const variance = data.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
      const stdDev = Math.sqrt(variance);
      // Silverman's rule: h = 0.9 * min(stdDev, IQR/1.34) * n^(-1/5)
      const sorted = [...data].sort((a, b) => a - b);
      const q1 = sorted[Math.floor(n * 0.25)];
      const q3 = sorted[Math.floor(n * 0.75)];
      const iqr = q3 - q1;
      const spread = Math.min(stdDev, iqr / 1.34);
      return 0.9 * (spread > 0 ? spread : stdDev > 0 ? stdDev : 1) * n ** -0.2;
    })();

  const kernel = (u: number) =>
    (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * u * u);

  return (x: number) => {
    const sum = data.reduce((s, xi) => s + kernel((x - xi) / h), 0);
    return sum / (n * h);
  };
}

/**
 * Computes five-number summary (min, q1, median, q3, max) for boxplot rendering.
 */
export function computeQuartiles(values: number[]): {
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;

  const quantile = (arr: number[], p: number): number => {
    const idx = p * (arr.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return arr[lo];
    return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
  };

  return {
    min: sorted[0],
    q1: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    q3: quantile(sorted, 0.75),
    max: sorted[n - 1],
  };
}

/**
 * Build a natural-language drill-down message from a column + value.
 * Replaces the old technical "Filter the last query where ..." text.
 */
export function drillDownMessage(column: string, rawValue: unknown): string {
  const display = rawValue === null || rawValue === undefined
    ? String(rawValue)
    : String(rawValue);
  return `Show only rows where ${column} is ${display}`;
}
