'use client';

import type { QueryResult } from '@/lib/types';
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  ScatterChart, Scatter, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

type ChartType = 'LINE_CHART' | 'BAR_CHART' | 'AREA_CHART' | 'SCATTER' | 'PIE_CHART';

interface Props {
  result: QueryResult;
  chartType: ChartType;
  onSendMessage: (msg: string) => void;
}

const COLORS = ['#4f7fff', '#22c55e', '#f59e0b', '#ec4899', '#a78bfa', '#34d399', '#fb923c'];

export function ChartView({ result, chartType, onSendMessage }: Props) {
  const { columns, rows, xAxis, yAxis } = result;

  // Build data array for Recharts
  const data = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });

  const xKey = xAxis ?? columns[0];
  const yKeys = yAxis ?? columns.filter((c) => c !== xKey);

  const commonProps = {
    data,
    margin: { top: 4, right: 16, left: 0, bottom: 4 },
  };

  const axisStyle = { tick: { fill: 'var(--text-muted)', fontSize: 11 }, axisLine: false, tickLine: false };
  const tooltipStyle = {
    contentStyle: {
      background: 'var(--surface-2)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      fontSize: 12,
      color: 'var(--text)',
    },
  };

  function handleChartClick(state: any) {
    if (!onSendMessage) return;
    if (state && state.activePayload && state.activePayload.length > 0) {
      const clickedData = state.activePayload[0].payload;
      const xValue = clickedData[xKey];
      if (xValue !== null && xValue !== undefined) {
        const formattedValue = typeof xValue === 'number' ? xValue : `'${xValue}'`;
        onSendMessage(`Filter the last query where \`${xKey}\` = ${formattedValue}`);
      }
    } else if (state && state.activeLabel !== undefined) {
      const xValue = state.activeLabel;
      if (xValue !== null && xValue !== undefined) {
        const formattedValue = typeof xValue === 'number' ? xValue : `'${xValue}'`;
        onSendMessage(`Filter the last query where \`${xKey}\` = ${formattedValue}`);
      }
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ width: '100%', height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          {chartType === 'LINE_CHART' ? (
            <LineChart {...commonProps} onClick={handleChartClick}>
              <CartesianGrid stroke="var(--border-subtle)" vertical={false} />
              <XAxis dataKey={xKey} {...axisStyle} />
              <YAxis {...axisStyle} />
              <Tooltip {...tooltipStyle} />
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
          ) : chartType === 'BAR_CHART' ? (
            <BarChart {...commonProps} onClick={handleChartClick}>
              <CartesianGrid stroke="var(--border-subtle)" vertical={false} />
              <XAxis dataKey={xKey} {...axisStyle} />
              <YAxis {...axisStyle} />
              <Tooltip {...tooltipStyle} />
              {yKeys.map((k, i) => (
                <Bar key={k} dataKey={k} fill={COLORS[i % COLORS.length]} radius={[3, 3, 0, 0]} />
              ))}
              {yKeys.length > 1 && <Legend iconSize={8} />}
            </BarChart>
          ) : chartType === 'AREA_CHART' ? (
            <AreaChart {...commonProps} onClick={handleChartClick}>
              <CartesianGrid stroke="var(--border-subtle)" vertical={false} />
              <XAxis dataKey={xKey} {...axisStyle} />
              <YAxis {...axisStyle} />
              <Tooltip {...tooltipStyle} />
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
            </AreaChart>
          ) : chartType === 'SCATTER' ? (
            <ScatterChart {...commonProps} onClick={handleChartClick}>
              <CartesianGrid stroke="var(--border-subtle)" />
              <XAxis dataKey={xKey} {...axisStyle} />
              <YAxis dataKey={yKeys[0]} {...axisStyle} />
              <Tooltip {...tooltipStyle} />
              <Scatter data={data} fill={COLORS[0]} opacity={0.7} />
            </ScatterChart>
          ) : (
            // PIE
            <PieChart>
              <Pie
                data={data}
                dataKey={yKeys[0] ?? columns[1]}
                nameKey={xKey}
                cx="50%"
                cy="50%"
                outerRadius={100}
                strokeWidth={0}
                onClick={(clickedEntry) => {
                  const payload = clickedEntry.payload || clickedEntry;
                  const xValue = payload[xKey];
                  if (xValue !== null && xValue !== undefined) {
                    const formattedValue = typeof xValue === 'number' ? xValue : `'${xValue}'`;
                    onSendMessage(`Filter the last query where \`${xKey}\` = ${formattedValue}`);
                  }
                }}
              >
                {data.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} opacity={0.9} />
                ))}
              </Pie>
              <Tooltip {...tooltipStyle} />
              <Legend iconSize={8} iconType="circle" />
            </PieChart>
          )}
        </ResponsiveContainer>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', textAlign: 'right', fontStyle: 'italic', paddingRight: 8 }}>
        Tip: Click a chart element to filter and dive into the data.
      </div>
    </div>
  );
}
