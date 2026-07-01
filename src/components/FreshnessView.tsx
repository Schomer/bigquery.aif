'use client';

import type { FreshnessResult, FreshnessEntry } from '@/lib/types';
import { useState, useMemo } from 'react';

interface Props {
  result: FreshnessResult;
  onSendMessage?: (msg: string) => void;
}

const STATUS_COLORS: Record<FreshnessEntry['status'], string> = {
  FRESH: '#10b981',
  STALE: '#f59e0b',
  VERY_STALE: '#ef4444',
};

function formatRelativeTime(isoString: string): string {
  if (!isoString) return 'unknown';
  const now = Date.now();
  const then = new Date(isoString).getTime();
  if (isNaN(then)) return 'unknown';
  const diffMs = now - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function formatAge(hours: number): string {
  if (isNaN(hours) || hours <= 0) return '---';
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.floor(hours / 24);
  const rem = Math.round(hours % 24);
  return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
}

export function FreshnessView({ result, onSendMessage }: Props) {
  const send = onSendMessage ?? (() => {});
  const { dataset, entries, thresholds } = result;

  const sorted = useMemo(
    () => [...entries].sort((a, b) => b.ageHours - a.ageHours),
    [entries],
  );

  const counts = useMemo(() => {
    const c = { FRESH: 0, STALE: 0, VERY_STALE: 0 };
    for (const e of entries) c[e.status]++;
    return c;
  }, [entries]);

  if (entries.length === 0) {
    const scopeLabel = result.dataset
      ? `dataset '${result.dataset}'`
      : `project '${result.project || 'unknown'}'`;
    return (
      <div style={{
        padding: '20px 16px',
        borderRadius: 8,
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        color: 'var(--text-muted)',
        fontSize: 13,
      }}>
        No tables found in this {result.dataset ? 'dataset' : 'project'}.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Summary badges */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Badge label="Fresh" count={counts.FRESH} color={STATUS_COLORS.FRESH} />
          <Badge label="Stale" count={counts.STALE} color={STATUS_COLORS.STALE} />
          <Badge label="Very Stale" count={counts.VERY_STALE} color={STATUS_COLORS.VERY_STALE} />
          <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 6 }}>
            {entries.length} table{entries.length === 1 ? '' : 's'} in{' '}
            <span style={{ fontFamily: 'var(--font-mono)' }}>{dataset || result.project || 'project'}</span>
            {!dataset && <span> (project)</span>}
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          Fresh: {'<'}{thresholds.freshHours}h | Stale: {thresholds.freshHours}-{thresholds.staleHours}h | Very Stale: {'>'}{thresholds.staleHours}h
        </div>
      </div>

      {/* Table list */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        maxHeight: 500,
        overflowY: 'auto',
      }}>
        {sorted.map((entry, i) => (
          <EntryRow
            key={entry.tableRef}
            entry={entry}
            isLast={i === sorted.length - 1}
            onSendMessage={send}
          />
        ))}
      </div>
    </div>
  );
}

function Badge({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <span style={{
      fontSize: 13,
      fontWeight: 500,
      color: '#fff',
      background: color,
      borderRadius: 999,
      padding: '6px 16px',
      lineHeight: 1,
      whiteSpace: 'nowrap',
    }}>
      {label}: {count}
    </span>
  );
}

function EntryRow({
  entry,
  isLast,
  onSendMessage,
}: {
  entry: FreshnessEntry;
  isLast: boolean;
  onSendMessage: (msg: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const tableName = entry.tableRef.split('.').pop() ?? entry.tableRef;
  const dotColor = STATUS_COLORS[entry.status];

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onSendMessage(`Show me the schema for ${entry.tableRef}`)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '10px 14px',
        background: hovered ? 'var(--accent-dim)' : '#F5FBFF',
        borderRadius: 10,
        transition: 'background 0.1s',
        cursor: 'pointer',
      }}
    >
      {/* Status dot */}
      <div style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: dotColor,
        flexShrink: 0,
        marginTop: 4,
      }} />

      {/* Name + metadata */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          color: 'var(--text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {tableName}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {formatRelativeTime(entry.lastModified)}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            {new Date(entry.lastModified).toLocaleString()}
          </span>
        </div>
      </div>

      {/* Age pill */}
      <span style={{
        fontSize: 11,
        fontWeight: 500,
        color: dotColor,
        border: `1px solid ${dotColor}`,
        borderRadius: 999,
        padding: '2px 8px',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}>
        {formatAge(entry.ageHours)}
      </span>

      {/* Row count */}
      <span style={{
        fontSize: 12,
        color: 'var(--text-dim)',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        minWidth: 60,
        textAlign: 'right',
      }}>
        {entry.rowCount.toLocaleString()} rows
      </span>
    </div>
  );
}
