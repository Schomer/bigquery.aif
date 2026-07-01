'use client';

import type { AccessPatternResult, AccessPatternEntry } from '@/lib/types';
import { useState, useMemo } from 'react';

interface Props {
  result: AccessPatternResult;
  onSendMessage?: (msg: string) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  const val = n / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

function tableShortName(ref: string): string {
  const parts = ref.split('.');
  return parts[parts.length - 1] || ref;
}

function userShortName(email: string): string {
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

function heatColor(count: number, max: number): string {
  if (count === 0 || max === 0) return 'transparent';
  const t = count / max;
  // white -> #dbeafe -> #3b82f6 -> #1e40af
  if (t < 0.33) {
    const s = t / 0.33;
    return lerpColor([255, 255, 255], [219, 234, 254], s);
  }
  if (t < 0.66) {
    const s = (t - 0.33) / 0.33;
    return lerpColor([219, 234, 254], [59, 130, 246], s);
  }
  const s = (t - 0.66) / 0.34;
  return lerpColor([59, 130, 246], [30, 64, 175], s);
}

function lerpColor(a: number[], b: number[], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

// ─── Tooltip state ────────────────────────────────────────────────────────────

interface TooltipInfo {
  tableRef: string;
  email: string;
  queryCount: number;
  bytesProcessed: number;
  lastAccessed: string;
  x: number;
  y: number;
}

// ─── Matrix computation ──────────────────────────────────────────────────────

interface MatrixData {
  tables: string[];
  users: string[];
  grid: Map<string, AccessPatternEntry>;
  maxCount: number;
  uniqueTables: number;
  uniqueUsers: number;
  totalQueries: number;
  totalBytes: number;
  topTables: { tableRef: string; queryCount: number; totalBytes: number }[];
}

function buildMatrix(entries: AccessPatternEntry[]): MatrixData {
  // Aggregate per-table and per-user totals
  const tableAgg = new Map<string, number>();
  const userAgg = new Map<string, number>();
  let totalQueries = 0;
  let totalBytes = 0;

  for (const e of entries) {
    tableAgg.set(e.tableRef, (tableAgg.get(e.tableRef) ?? 0) + e.queryCount);
    userAgg.set(e.userEmail, (userAgg.get(e.userEmail) ?? 0) + e.queryCount);
    totalQueries += e.queryCount;
    totalBytes += e.totalBytesProcessed;
  }

  // Sort descending by total query count, then take top N
  const tables = [...tableAgg.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([t]) => t);

  const users = [...userAgg.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([u]) => u);

  const tableSet = new Set(tables);
  const userSet = new Set(users);

  // Build grid keyed by "table||user"
  const grid = new Map<string, AccessPatternEntry>();
  let maxCount = 0;
  for (const e of entries) {
    if (tableSet.has(e.tableRef) && userSet.has(e.userEmail)) {
      const key = `${e.tableRef}||${e.userEmail}`;
      grid.set(key, e);
      if (e.queryCount > maxCount) maxCount = e.queryCount;
    }
  }

  // Top 5 tables for the ranked list
  const topTables = [...tableAgg.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tableRef, queryCount]) => {
      let tb = 0;
      for (const e of entries) {
        if (e.tableRef === tableRef) tb += e.totalBytesProcessed;
      }
      return { tableRef, queryCount, totalBytes: tb };
    });

  return {
    tables,
    users,
    grid,
    maxCount,
    uniqueTables: tableAgg.size,
    uniqueUsers: userAgg.size,
    totalQueries,
    totalBytes,
    topTables,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AccessPatternView({ result, onSendMessage }: Props) {
  const send = onSendMessage ?? (() => {});
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);

  const matrix = useMemo(() => buildMatrix(result.entries), [result.entries]);

  if (result.entries.length === 0) {
    return (
      <div style={{ padding: '24px 16px', color: 'var(--text-muted)', fontSize: 13 }}>
        No access pattern data available for this time range.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Summary stats */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <StatCard label="Unique tables" value={String(matrix.uniqueTables)} />
        <StatCard label="Unique users" value={String(matrix.uniqueUsers)} />
        <StatCard label="Total queries" value={matrix.totalQueries.toLocaleString()} />
        <StatCard label="Data processed" value={formatBytes(matrix.totalBytes)} />
      </div>

      {/* Heatmap matrix */}
      <div style={{ position: 'relative' }}>
        <div style={{
          overflowX: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--surface-2)',
        }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                {/* Corner cell */}
                <th style={{
                  padding: '8px 12px',
                  position: 'sticky',
                  left: 0,
                  background: 'var(--surface-2)',
                  zIndex: 2,
                  borderBottom: '1px solid var(--border-subtle)',
                  borderRight: '1px solid var(--border-subtle)',
                }} />
                {matrix.users.map((user) => (
                  <th key={user} style={{
                    padding: '4px 6px',
                    borderBottom: '1px solid var(--border-subtle)',
                    height: 80,
                    verticalAlign: 'bottom',
                    minWidth: 60,
                  }}>
                    <div style={{
                      transform: 'rotate(-45deg)',
                      transformOrigin: 'bottom left',
                      whiteSpace: 'nowrap',
                      fontSize: 10,
                      color: 'var(--text-muted)',
                      fontWeight: 500,
                      width: 20,
                      marginLeft: 12,
                    }}>
                      {truncate(userShortName(user), 14)}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.tables.map((table) => (
                <tr key={table}>
                  <td style={{
                    padding: '4px 12px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--text)',
                    whiteSpace: 'nowrap',
                    position: 'sticky',
                    left: 0,
                    background: 'var(--surface-2)',
                    zIndex: 1,
                    borderRight: '1px solid var(--border-subtle)',
                  }}>
                    {truncate(tableShortName(table), 20)}
                  </td>
                  {matrix.users.map((user) => {
                    const key = `${table}||${user}`;
                    const entry = matrix.grid.get(key);
                    const count = entry?.queryCount ?? 0;
                    return (
                      <td
                        key={user}
                        onMouseEnter={(e) => {
                          const rect = (e.target as HTMLElement).getBoundingClientRect();
                          setTooltip({
                            tableRef: table,
                            email: user,
                            queryCount: count,
                            bytesProcessed: entry?.totalBytesProcessed ?? 0,
                            lastAccessed: entry?.lastAccessed ?? '--',
                            x: rect.left + rect.width / 2,
                            y: rect.top,
                          });
                        }}
                        onMouseLeave={() => setTooltip(null)}
                        style={{
                          minWidth: 60,
                          height: 32,
                          textAlign: 'center',
                          fontSize: 11,
                          fontWeight: count > 0 ? 600 : 400,
                          color: count > 0 && count / matrix.maxCount > 0.5
                            ? '#ffffff'
                            : count > 0 ? '#1e3a5f' : 'transparent',
                          background: heatColor(count, matrix.maxCount),
                          borderRight: '1px solid var(--border-subtle)',
                          borderBottom: '1px solid var(--border-subtle)',
                          cursor: 'default',
                          transition: 'background 0.15s',
                        }}
                      >
                        {count > 0 ? count : ''}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Tooltip */}
        {tooltip && (
          <div style={{
            position: 'fixed',
            left: tooltip.x,
            top: tooltip.y - 8,
            transform: 'translate(-50%, -100%)',
            background: '#1a1a2e',
            color: '#e0e0e0',
            padding: '8px 12px',
            borderRadius: 6,
            fontSize: 11,
            lineHeight: 1.6,
            zIndex: 100,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}>
            <div><span style={{ color: '#9ca3af' }}>Table:</span> {tooltip.tableRef}</div>
            <div><span style={{ color: '#9ca3af' }}>User:</span> {tooltip.email}</div>
            <div><span style={{ color: '#9ca3af' }}>Queries:</span> {tooltip.queryCount.toLocaleString()}</div>
            <div><span style={{ color: '#9ca3af' }}>Bytes:</span> {formatBytes(tooltip.bytesProcessed)}</div>
            <div><span style={{ color: '#9ca3af' }}>Last access:</span> {tooltip.lastAccessed}</div>
          </div>
        )}
      </div>

      {/* Top tables list */}
      {matrix.topTables.length > 0 && (
        <div>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            marginBottom: 8,
          }}>
            Most queried tables
          </div>
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
          }}>
            {matrix.topTables.map((t, i) => (
              <TopTableRow
                key={t.tableRef}
                rank={i + 1}
                tableRef={t.tableRef}
                queryCount={t.queryCount}
                totalBytes={t.totalBytes}
                isLast={i === matrix.topTables.length - 1}
                onSendMessage={send}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      background: 'var(--surface-2)',
      borderRadius: 8,
      padding: '12px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
    }}>
      <span style={{
        fontSize: 11,
        color: 'var(--text-muted)',
        fontWeight: 500,
      }}>
        {label}
      </span>
      <span style={{
        fontSize: 16,
        fontWeight: 700,
        color: 'var(--text)',
      }}>
        {value}
      </span>
    </div>
  );
}

// ─── Top table row ────────────────────────────────────────────────────────────

function TopTableRow({
  rank,
  tableRef,
  queryCount,
  totalBytes,
  isLast,
  onSendMessage,
}: {
  rank: number;
  tableRef: string;
  queryCount: number;
  totalBytes: number;
  isLast: boolean;
  onSendMessage: (msg: string) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onSendMessage(`Tell me more about ${tableRef}`)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 12px',
        cursor: 'pointer',
        background: hovered ? 'var(--accent-dim)' : '#F5FBFF',
        borderRadius: 10,
        transition: 'background 0.12s',
      }}
    >
      <span style={{
        fontSize: 12,
        fontWeight: 700,
        color: 'var(--text-dim)',
        minWidth: 20,
        textAlign: 'right',
      }}>
        {rank}
      </span>
      <span style={{
        fontSize: 12,
        fontFamily: 'var(--font-mono)',
        color: hovered ? 'var(--accent)' : 'var(--text)',
        flex: 1,
        transition: 'color 0.12s',
      }}>
        {tableRef}
      </span>
      <span style={{
        fontSize: 11,
        color: 'var(--text-muted)',
        whiteSpace: 'nowrap',
      }}>
        {queryCount.toLocaleString()} queries
      </span>
      <span style={{
        fontSize: 11,
        color: 'var(--text-dim)',
        whiteSpace: 'nowrap',
      }}>
        {formatBytes(totalBytes)}
      </span>
    </div>
  );
}
