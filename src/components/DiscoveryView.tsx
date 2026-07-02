'use client';

import type { DiscoveryResult, DiscoverySearchResult } from '@/lib/types';
import { LineageDagView } from './LineageDagView';
import { ErDiagramView } from './ErDiagramView';
import { useState } from 'react';

interface Props {
  result: DiscoveryResult;
  onSendMessage?: (msg: string) => void;
}

export function DiscoveryView({ result, onSendMessage }: Props) {
  const send = onSendMessage ?? (() => {});
  if (result.discoveryType === 'LINEAGE') {
    return <LineageDagView result={result} onSendMessage={send} />;
  }
  if (result.discoveryType === 'ER_DIAGRAM' && result.erDiagram) {
    return <ErDiagramView data={result.erDiagram} onSendMessage={send} />;
  }
  if (result.discoveryType === 'COMPARISON') {
    return <ComparisonView result={result} onSendMessage={send} />;
  }
  return <SearchView result={result} onSendMessage={send} />;
}

// ─── Search results ────────────────────────────────────────────────────────────

function SearchView({ result, onSendMessage }: { result: DiscoveryResult; onSendMessage: (msg: string) => void }) {
  if (result.results.length === 0) {
    return (
      <div style={{ padding: '8px 0' }}>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 12px' }}>
          No tables found matching &quot;{result.query}&quot;
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={() => onSendMessage(`show me the schema for ${result.query}`)}
            style={{
              padding: '6px 14px', borderRadius: 18,
              border: '1px solid var(--accent, #4285f4)', background: 'transparent',
              color: 'var(--accent, #4285f4)', fontSize: 13, cursor: 'pointer',
            }}
          >
            Try as schema lookup
          </button>
          <button
            onClick={() => onSendMessage('list my datasets')}
            style={{
              padding: '6px 14px', borderRadius: 18,
              border: '1px solid var(--accent, #4285f4)', background: 'transparent',
              color: 'var(--accent, #4285f4)', fontSize: 13, cursor: 'pointer',
            }}
          >
            List datasets
          </button>
          <button
            onClick={() => onSendMessage(`profile the ${result.query} table`)}
            style={{
              padding: '6px 14px', borderRadius: 18,
              border: '1px solid var(--accent, #4285f4)', background: 'transparent',
              color: 'var(--accent, #4285f4)', fontSize: 13, cursor: 'pointer',
            }}
          >
            Profile {result.query}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {result.results.map((r, i) => (
        <SearchResultRow key={i} item={r} onSendMessage={onSendMessage} />
      ))}
    </div>
  );
}

function SearchResultRow({ item, onSendMessage }: { item: DiscoverySearchResult; onSendMessage: (msg: string) => void }) {
  const [hovered, setHovered] = useState(false);
  const iconMap: Record<string, string> = {
    TABLE: 'table_chart',
    VIEW: 'visibility',
    MATERIALIZED_VIEW: 'table_rows',
    EXTERNAL: 'cloud',
    DATASET: 'database',
  };

  return (
    <div
      title={`Click to inspect ${item.ref}`}
      onClick={() => onSendMessage(`Tell me more about ${item.ref}`)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '6px 8px',
        background: hovered ? 'var(--accent-dim)' : '#F5FBFF',
        borderRadius: 10,
        border: 'none',
        cursor: 'pointer',
        transition: 'background 0.12s',
        userSelect: 'none',
      }}
    >
      <span
        className="material-symbols-outlined"
        title={item.type}
        style={{ fontSize: 15, color: 'var(--text-dim)', flexShrink: 0 }}
      >
        {iconMap[item.type] ?? 'help_outline'}
      </span>
      <span style={{
        fontSize: 12,
        fontWeight: 500,
        color: hovered ? 'var(--accent)' : 'var(--text)',
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        transition: 'color 0.12s',
      }}>
        {item.ref}
      </span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
        {item.matchedOn}{item.description ? ` \u00b7 ${item.description}` : ''}
      </span>
    </div>
  );
}

// ─── Comparison diff view ──────────────────────────────────────────────────────

function ComparisonView({ result, onSendMessage }: { result: DiscoveryResult; onSendMessage: (msg: string) => void }) {
  const cmp = result.comparison;

  if (!cmp) {
    return (
      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0, padding: '8px 0' }}>
        Unable to compare schemas.
      </p>
    );
  }

  const hasChanges =
    cmp.addedColumns.length > 0 ||
    cmp.removedColumns.length > 0 ||
    cmp.changedColumns.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text)' }}>{cmp.left}</span>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>vs</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text)' }}>{cmp.right}</span>
      </div>

      {!hasChanges ? (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>Schemas are identical</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['Change', 'Column', 'Type'].map((h) => (
                <th key={h} style={{
                  padding: '6px 12px',
                  textAlign: 'left',
                  color: 'var(--text-muted)',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cmp.addedColumns.map((col) => (
              <tr key={`add-${col.name}`} style={{ background: 'rgba(34,197,94,0.08)', borderBottom: '1px solid var(--border-subtle)' }}>
                <td style={{ padding: '7px 12px', color: '#22c55e', fontWeight: 500 }}>+</td>
                <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{col.name}</td>
                <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: 11 }}>{col.type}</td>
              </tr>
            ))}
            {cmp.removedColumns.map((col) => (
              <tr key={`rem-${col.name}`} style={{ background: 'rgba(239,68,68,0.08)', borderBottom: '1px solid var(--border-subtle)' }}>
                <td style={{ padding: '7px 12px', color: '#ef4444', fontWeight: 500 }}>−</td>
                <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{col.name}</td>
                <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: 11 }}>{col.type}</td>
              </tr>
            ))}
            {cmp.changedColumns.map((col) => (
              <tr key={`chg-${col.name}`} style={{ background: 'rgba(234,179,8,0.08)', borderBottom: '1px solid var(--border-subtle)' }}>
                <td style={{ padding: '7px 12px', color: '#eab308', fontWeight: 500 }}>~</td>
                <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{col.name}</td>
                <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: 11 }}>
                  {col.fromType} → {col.toType}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
