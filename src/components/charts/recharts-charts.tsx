'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import type { QueryResult } from '@/lib/types';
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  ScatterChart, Scatter, PieChart, Pie, Cell,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  FunnelChart, Funnel, Treemap, Sankey, ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, LabelList,
} from 'recharts';
import {
  COLORS, AXIS_STYLE, TOOLTIP_STYLE, GRID_STYLE, CHART_HEIGHT, CHART_MARGIN,
  buildChartData, resolveAxes,
} from './chart-utils';

interface ChartProps {
  result: QueryResult;
  onSendMessage: (msg: string) => void;
}

function makeClickHandler(xKey: string, onSendMessage: (msg: string) => void) {
  return (state: any) => {
    if (!onSendMessage) return;
    if (state?.activePayload?.length > 0) {
      const clickedData = state.activePayload[0].payload;
      const xValue = clickedData[xKey];
      if (xValue !== null && xValue !== undefined) {
        const formattedValue = typeof xValue === 'number' ? xValue : `'${xValue}'`;
        onSendMessage(`Filter the last query where \`${xKey}\` = ${formattedValue}`);
      }
    } else if (state?.activeLabel !== undefined) {
      const xValue = state.activeLabel;
      if (xValue !== null && xValue !== undefined) {
        const formattedValue = typeof xValue === 'number' ? xValue : `'${xValue}'`;
        onSendMessage(`Filter the last query where \`${xKey}\` = ${formattedValue}`);
      }
    }
  };
}

function makePieClickHandler(xKey: string, onSendMessage: (msg: string) => void) {
  return (clickedEntry: any) => {
    if (!onSendMessage) return;
    const payload = clickedEntry.payload || clickedEntry;
    const xValue = payload[xKey];
    if (xValue !== null && xValue !== undefined) {
      const formattedValue = typeof xValue === 'number' ? xValue : `'${xValue}'`;
      onSendMessage(`Filter the last query where \`${xKey}\` = ${formattedValue}`);
    }
  };
}

const TIP_STYLE: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-dim)',
  textAlign: 'right',
  fontStyle: 'italic',
  paddingRight: 8,
  marginTop: 6,
};

function ChartTip() {
  return (
    <div style={TIP_STYLE}>
      Tip: Click a chart element to filter and dive into the data.
    </div>
  );
}

function useChartSetup(result: QueryResult) {
  const { columns, rows, xAxis, yAxis } = result;
  const data = buildChartData(columns, rows);
  const { xKey, yKeys } = resolveAxes(columns, xAxis, yAxis);
  return { data, xKey, yKeys };
}

// ---------------------------------------------------------------------------
// 1. LineChartRenderer
// ---------------------------------------------------------------------------
export function LineChartRenderer({ result, onSendMessage }: ChartProps) {
  const { data, xKey, yKeys } = useChartSetup(result);
  return (
    <div>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <LineChart data={data} margin={CHART_MARGIN} onClick={makeClickHandler(xKey, onSendMessage)}>
          <CartesianGrid {...GRID_STYLE} />
          <XAxis dataKey={xKey} {...AXIS_STYLE} />
          <YAxis {...AXIS_STYLE} />
          <Tooltip {...TOOLTIP_STYLE} />
          {yKeys.map((k, i) => (
            <Line
              key={k}
              type="monotone"
              dataKey={k}
              stroke={COLORS[i % COLORS.length]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          ))}
          {yKeys.length > 1 && <Legend iconSize={8} iconType="circle" />}
        </LineChart>
      </ResponsiveContainer>
      <ChartTip />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. BarChartRenderer (horizontal bars)
// ---------------------------------------------------------------------------
const BAR_ROW_HEIGHT = 32;
const BAR_CHART_MAX_VISIBLE = 400;
const BAR_CHART_MIN_HEIGHT = 200;

export function BarChartRenderer({ result, onSendMessage }: ChartProps) {
  const { data, xKey, yKeys } = useChartSetup(result);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const chartHeight = Math.max(BAR_CHART_MIN_HEIGHT, data.length * BAR_ROW_HEIGHT);
  const needsScroll = chartHeight > BAR_CHART_MAX_VISIBLE;

  // Measure width once on mount and on window resize (not via ResizeObserver
  // on the scroll container, which causes an infinite loop with Recharts).
  const measure = useCallback(() => {
    if (containerRef.current) {
      setContainerWidth(containerRef.current.clientWidth);
    }
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const chart = (
    <BarChart
      data={data}
      layout="vertical"
      width={containerWidth || undefined}
      height={chartHeight}
      margin={CHART_MARGIN}
      onClick={makeClickHandler(xKey, onSendMessage)}
    >
      <CartesianGrid {...GRID_STYLE} />
      <XAxis type="number" {...AXIS_STYLE} />
      <YAxis type="category" dataKey={xKey} {...AXIS_STYLE} width={100} />
      <Tooltip {...TOOLTIP_STYLE} />
      {yKeys.map((k, i) => (
        <Bar key={k} dataKey={k} fill={COLORS[i % COLORS.length]} />
      ))}
      {yKeys.length > 1 && <Legend iconSize={8} />}
    </BarChart>
  );

  return (
    <div ref={containerRef}>
      {needsScroll ? (
        <div style={{ maxHeight: BAR_CHART_MAX_VISIBLE, overflowY: 'auto' }}>
          {containerWidth > 0 && chart}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={chartHeight}>
          {chart}
        </ResponsiveContainer>
      )}
      <ChartTip />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. ColumnChartRenderer (vertical bars, standard)
// ---------------------------------------------------------------------------
export function ColumnChartRenderer({ result, onSendMessage }: ChartProps) {
  const { data, xKey, yKeys } = useChartSetup(result);
  return (
    <div>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <BarChart data={data} margin={CHART_MARGIN} onClick={makeClickHandler(xKey, onSendMessage)}>
          <CartesianGrid {...GRID_STYLE} />
          <XAxis dataKey={xKey} {...AXIS_STYLE} />
          <YAxis {...AXIS_STYLE} />
          <Tooltip {...TOOLTIP_STYLE} />
          {yKeys.map((k, i) => (
            <Bar key={k} dataKey={k} fill={COLORS[i % COLORS.length]} radius={[3, 3, 0, 0]} />
          ))}
          {yKeys.length > 1 && <Legend iconSize={8} />}
        </BarChart>
      </ResponsiveContainer>
      <ChartTip />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. AreaChartRenderer
// ---------------------------------------------------------------------------
export function AreaChartRenderer({ result, onSendMessage }: ChartProps) {
  const { data, xKey, yKeys } = useChartSetup(result);
  return (
    <div>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <AreaChart data={data} margin={CHART_MARGIN} onClick={makeClickHandler(xKey, onSendMessage)}>
          <CartesianGrid {...GRID_STYLE} />
          <XAxis dataKey={xKey} {...AXIS_STYLE} />
          <YAxis {...AXIS_STYLE} />
          <Tooltip {...TOOLTIP_STYLE} />
          {yKeys.map((k, i) => (
            <Area
              key={k}
              type="monotone"
              dataKey={k}
              stroke={COLORS[i % COLORS.length]}
              fill={COLORS[i % COLORS.length]}
              fillOpacity={0.1}
              strokeWidth={2}
            />
          ))}
          {yKeys.length > 1 && <Legend iconSize={8} iconType="circle" />}
        </AreaChart>
      </ResponsiveContainer>
      <ChartTip />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. ScatterChartRenderer
// ---------------------------------------------------------------------------
export function ScatterChartRenderer({ result, onSendMessage }: ChartProps) {
  const { data, xKey, yKeys } = useChartSetup(result);
  return (
    <div>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <ScatterChart margin={CHART_MARGIN} onClick={makeClickHandler(xKey, onSendMessage)}>
          <CartesianGrid {...GRID_STYLE} />
          <XAxis dataKey={xKey} {...AXIS_STYLE} />
          <YAxis dataKey={yKeys[0]} {...AXIS_STYLE} />
          <Tooltip {...TOOLTIP_STYLE} />
          <Scatter data={data} fill={COLORS[0]} opacity={0.7} />
        </ScatterChart>
      </ResponsiveContainer>
      <ChartTip />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6. PieChartRenderer
// ---------------------------------------------------------------------------
export function PieChartRenderer({ result, onSendMessage }: ChartProps) {
  const { data, xKey, yKeys } = useChartSetup(result);
  return (
    <div>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <PieChart>
          <Pie
            data={data}
            dataKey={yKeys[0] ?? result.columns[1]}
            nameKey={xKey}
            cx="50%"
            cy="50%"
            outerRadius={100}
            strokeWidth={0}
            onClick={makePieClickHandler(xKey, onSendMessage)}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} opacity={0.9} />
            ))}
          </Pie>
          <Tooltip {...TOOLTIP_STYLE} />
          <Legend iconSize={8} iconType="circle" />
        </PieChart>
      </ResponsiveContainer>
      <ChartTip />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 7. DonutChartRenderer
// ---------------------------------------------------------------------------
export function DonutChartRenderer({ result, onSendMessage }: ChartProps) {
  const { data, xKey, yKeys } = useChartSetup(result);
  const valueKey = yKeys[0] ?? result.columns[1];
  const total = data.reduce((sum, d) => {
    const v = Number(d[valueKey]);
    return sum + (isNaN(v) ? 0 : v);
  }, 0);

  return (
    <div>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <PieChart>
          <Pie
            data={data}
            dataKey={valueKey}
            nameKey={xKey}
            cx="50%"
            cy="50%"
            innerRadius={55}
            outerRadius={100}
            strokeWidth={0}
            onClick={makePieClickHandler(xKey, onSendMessage)}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} opacity={0.9} />
            ))}
          </Pie>
          <Tooltip {...TOOLTIP_STYLE} />
          <Legend iconSize={8} iconType="circle" />
          {/* Centered total label */}
          <text
            x="50%"
            y="50%"
            textAnchor="middle"
            dominantBaseline="central"
            style={{ fontSize: 18, fontWeight: 600, fill: 'var(--text)' }}
          >
            {total.toLocaleString()}
          </text>
        </PieChart>
      </ResponsiveContainer>
      <ChartTip />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 8. HistogramRenderer
// ---------------------------------------------------------------------------
export function HistogramRenderer({ result, onSendMessage }: ChartProps) {
  const { data, xKey, yKeys } = useChartSetup(result);
  return (
    <div>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <BarChart
          data={data}
          margin={CHART_MARGIN}
          barCategoryGap={0}
          barGap={0}
          onClick={makeClickHandler(xKey, onSendMessage)}
        >
          <CartesianGrid {...GRID_STYLE} />
          <XAxis dataKey={xKey} {...AXIS_STYLE} />
          <YAxis {...AXIS_STYLE} />
          <Tooltip {...TOOLTIP_STYLE} />
          <Bar dataKey={yKeys[0]} fill={COLORS[0]} />
        </BarChart>
      </ResponsiveContainer>
      <ChartTip />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 9. SparklineRenderer (minimal, no tip)
// ---------------------------------------------------------------------------
export function SparklineRenderer({ result }: ChartProps) {
  const { data, xKey, yKeys } = useChartSetup(result);
  return (
    <ResponsiveContainer width="100%" height={60}>
      <LineChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
        <Line
          type="monotone"
          dataKey={yKeys[0]}
          stroke={COLORS[0]}
          strokeWidth={1.5}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// 10. RadarChartRenderer
// ---------------------------------------------------------------------------
export function RadarChartRenderer({ result, onSendMessage }: ChartProps) {
  const { data, xKey, yKeys } = useChartSetup(result);
  return (
    <div>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <RadarChart data={data} cx="50%" cy="50%" outerRadius="75%" onClick={makeClickHandler(xKey, onSendMessage)}>
          <PolarGrid stroke="var(--border-subtle)" />
          <PolarAngleAxis dataKey={xKey} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
          <PolarRadiusAxis tick={{ fill: 'var(--text-muted)', fontSize: 10 }} />
          {yKeys.map((k, i) => (
            <Radar
              key={k}
              dataKey={k}
              stroke={COLORS[i % COLORS.length]}
              fill={COLORS[i % COLORS.length]}
              fillOpacity={0.15}
            />
          ))}
          <Tooltip {...TOOLTIP_STYLE} />
          {yKeys.length > 1 && <Legend iconSize={8} iconType="circle" />}
        </RadarChart>
      </ResponsiveContainer>
      <ChartTip />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 11. FunnelChartRenderer
// ---------------------------------------------------------------------------
export function FunnelChartRenderer({ result, onSendMessage }: ChartProps) {
  const { data, xKey, yKeys } = useChartSetup(result);
  const valueKey = yKeys[0] ?? result.columns[1];

  // Enrich data with conversion percentages and fill colors
  const funnelData = data.map((d, i) => {
    const current = Number(d[valueKey]) || 0;
    const previous = i > 0 ? Number(data[i - 1][valueKey]) || 1 : current;
    const conversionPct = i === 0 ? 100 : Math.round((current / previous) * 100);
    return {
      ...d,
      fill: COLORS[i % COLORS.length],
      _conversionLabel: i === 0 ? `${current.toLocaleString()}` : `${current.toLocaleString()} (${conversionPct}%)`,
    };
  });

  return (
    <div>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <FunnelChart onClick={makeClickHandler(xKey, onSendMessage)}>
          <Tooltip {...TOOLTIP_STYLE} />
          <Funnel
            dataKey={valueKey}
            nameKey={xKey}
            data={funnelData}
            isAnimationActive
          >
            {funnelData.map((entry, i) => (
              <Cell key={i} fill={entry.fill} />
            ))}
            <LabelList
              dataKey="_conversionLabel"
              position="center"
              style={{ fill: '#fff', fontSize: 12, fontWeight: 500 }}
            />
          </Funnel>
        </FunnelChart>
      </ResponsiveContainer>
      <ChartTip />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 12. TreemapRenderer
// ---------------------------------------------------------------------------
interface TreemapContentProps {
  x: number;
  y: number;
  width: number;
  height: number;
  name?: string;
  value?: number;
  index: number;
}

function TreemapContent({ x, y, width, height, name, value, index }: TreemapContentProps) {
  if (width < 40 || height < 30) return null;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={COLORS[index % COLORS.length]}
        stroke="var(--surface-1)"
        strokeWidth={2}
        rx={3}
      />
      <text
        x={x + width / 2}
        y={y + height / 2 - 7}
        textAnchor="middle"
        dominantBaseline="central"
        style={{ fill: '#fff', fontSize: 12, fontWeight: 500 }}
      >
        {name}
      </text>
      <text
        x={x + width / 2}
        y={y + height / 2 + 10}
        textAnchor="middle"
        dominantBaseline="central"
        style={{ fill: 'rgba(255,255,255,0.8)', fontSize: 11 }}
      >
        {value?.toLocaleString()}
      </text>
    </g>
  );
}

export function TreemapRenderer({ result, onSendMessage }: ChartProps) {
  const { data, xKey, yKeys } = useChartSetup(result);
  const valueKey = yKeys[0] ?? result.columns[1];

  const treemapData = data.map((d) => ({
    name: String(d[xKey] ?? ''),
    [valueKey]: Number(d[valueKey]) || 0,
  }));

  return (
    <div>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <Treemap
          data={treemapData}
          dataKey={valueKey}
          stroke="var(--surface-1)"
          content={<TreemapContent x={0} y={0} width={0} height={0} index={0} />}
          onClick={(node: any) => {
            if (!onSendMessage || !node?.name) return;
            const xValue = node.name;
            const formattedValue = typeof xValue === 'number' ? xValue : `'${xValue}'`;
            onSendMessage(`Filter the last query where \`${xKey}\` = ${formattedValue}`);
          }}
        />
      </ResponsiveContainer>
      <ChartTip />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 13. SankeyRenderer
// ---------------------------------------------------------------------------
export function SankeyRenderer({ result, onSendMessage }: ChartProps) {
  const { columns, rows } = result;

  if (columns.length < 3) {
    return (
      <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>
        Sankey charts require at least 3 columns: source, target, and value.
      </div>
    );
  }

  const sourceCol = columns[0];
  const targetCol = columns[1];
  const valueCol = columns[2];

  // Build unique node names and links
  const nodeNames: string[] = [];
  const nodeIndex = (name: string) => {
    let idx = nodeNames.indexOf(name);
    if (idx === -1) {
      idx = nodeNames.length;
      nodeNames.push(name);
    }
    return idx;
  };

  const data = buildChartData(columns, rows);
  const links = data.map((d) => ({
    source: nodeIndex(String(d[sourceCol] ?? '')),
    target: nodeIndex(String(d[targetCol] ?? '')),
    value: Number(d[valueCol]) || 0,
  }));

  const nodes = nodeNames.map((name) => ({ name }));

  const sankeyData = { nodes, links };

  return (
    <div>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <Sankey
          data={sankeyData}
          nodePadding={24}
          nodeWidth={10}
          linkCurvature={0.5}
          margin={{ top: 8, right: 40, left: 40, bottom: 8 }}
          link={{ stroke: 'var(--border)' }}
          onClick={(node: any) => {
            if (!onSendMessage || !node?.name) return;
            const xValue = node.name;
            const formattedValue = typeof xValue === 'number' ? xValue : `'${xValue}'`;
            onSendMessage(`Filter the last query where \`${sourceCol}\` = ${formattedValue}`);
          }}
        >
          <Tooltip {...TOOLTIP_STYLE} />
        </Sankey>
      </ResponsiveContainer>
      <ChartTip />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 14. ComposedChartRenderer
// ---------------------------------------------------------------------------
export function ComposedChartRenderer({ result, onSendMessage }: ChartProps) {
  const { data, xKey, yKeys } = useChartSetup(result);
  return (
    <div>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <ComposedChart data={data} margin={CHART_MARGIN} onClick={makeClickHandler(xKey, onSendMessage)}>
          <CartesianGrid {...GRID_STYLE} />
          <XAxis dataKey={xKey} {...AXIS_STYLE} />
          <YAxis {...AXIS_STYLE} />
          <Tooltip {...TOOLTIP_STYLE} />
          {yKeys.length > 0 && (
            <Bar dataKey={yKeys[0]} fill={COLORS[0]} radius={[3, 3, 0, 0]} />
          )}
          {yKeys.slice(1).map((k, i) => (
            <Line
              key={k}
              type="monotone"
              dataKey={k}
              stroke={COLORS[(i + 1) % COLORS.length]}
              strokeWidth={2}
              dot={false}
            />
          ))}
          <Legend iconSize={8} />
        </ComposedChart>
      </ResponsiveContainer>
      <ChartTip />
    </div>
  );
}
