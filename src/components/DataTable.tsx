'use client';

import type { QueryResult } from '@/lib/types';
import { useState } from 'react';
import { drillDownMessage } from './charts/chart-utils';

interface Props {
  result: QueryResult;
  onSendMessage?: (msg: string) => void;
}

export function DataTable({ result, onSendMessage }: Props) {
  const [filter, setFilter] = useState('');
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const { columns, rows } = result;

  let filtered = filter
    ? rows.filter((row) =>
        row.some((cell) =>
          String(cell).toLowerCase().includes(filter.toLowerCase())
        )
      )
    : rows;

  if (sortCol !== null) {
    filtered = [...filtered].sort((a, b) => {
      const av = a[sortCol];
      const bv = b[sortCol];
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  function toggleSort(i: number) {
    if (sortCol === i) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(i);
      setSortDir('asc');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Filter bar (only if > 8 rows) */}
      {rows.length > 8 && (
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter rows..."
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 12,
            color: 'var(--text)',
            outline: 'none',
            width: '100%',
          }}
        />
      )}

      <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid var(--border)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
              {columns.map((col, i) => (
                <th
                  key={col}
                  onClick={() => toggleSort(i)}
                  style={{
                    padding: '8px 12px',
                    textAlign: 'left',
                    color: 'var(--text-muted)',
                    fontWeight: 500,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    userSelect: 'none',
                    transition: 'color 0.1s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
                >
                  {col}
                  {sortCol === i && (
                    <span style={{ marginLeft: 4, opacity: 0.7 }}>
                      {sortDir === 'asc' ? '↑' : '↓'}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 200).map((row, ri) => (
              <tr
                key={ri}
                style={{ borderBottom: '1px solid var(--border-subtle)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    onClick={() => {
                      if (cell !== null && cell !== undefined && onSendMessage) {
                        const colLower = columns[ci].toLowerCase();
                        const isEntityCol = /^(dataset|table|view|schema)[_\s]?(name|id)?$/.test(colLower)
                          || colLower === 'table_catalog'
                          || colLower === 'table_schema';
                        if (isEntityCol) {
                          onSendMessage(`Tell me more about ${cell}`);
                        } else {
                          onSendMessage(drillDownMessage(columns[ci], cell));
                        }
                      }
                    }}
                    style={{
                      padding: '7px 12px',
                      color: typeof cell === 'number' ? 'var(--text)' : 'var(--text-muted)',
                      fontFamily: typeof cell === 'number' ? 'var(--font-mono)' : 'inherit',
                      whiteSpace: 'nowrap',
                      maxWidth: 300,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      cursor: 'pointer',
                      transition: 'background-color 0.1s, color 0.1s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = 'var(--accent-dim)';
                      e.currentTarget.style.color = 'var(--accent-text)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                      e.currentTarget.style.color = typeof cell === 'number' ? 'var(--text)' : 'var(--text-muted)';
                    }}
                    title={cell !== null && cell !== undefined
                      ? (/^(dataset|table|view|schema)[_\s]?(name|id)?$/.test(columns[ci].toLowerCase()) || columns[ci].toLowerCase() === 'table_catalog' || columns[ci].toLowerCase() === 'table_schema'
                        ? `Click to learn more about ${cell}`
                        : `Click to filter where ${columns[ci]} = ${cell}`)
                      : undefined}
                  >
                    {cell === null || cell === undefined ? (
                      <span style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>null</span>
                    ) : typeof cell === 'object' ? JSON.stringify(cell) : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Row count footer */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--text-dim)' }}>
        <span style={{ fontStyle: 'italic' }}>
          Tip: Click any cell to explore further.
        </span>
        <span>
          {filtered.length < rows.length
            ? `${filtered.length} of ${rows.length} rows`
            : `${rows.length} rows`}
          {rows.length > 200 && ' (showing first 200)'}
        </span>
      </div>
    </div>
  );
}
