'use client';

import type { SchemaResult, SchemaColumn, PreviewResponse, PreviewColumn } from '@/lib/types';
import { fetchTablePreview } from '@/lib/preview-client';
import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '@/lib/auth-context';

interface Props {
  result: SchemaResult;
  onSendMessage?: (msg: string) => void;
}

// Hover row style helper
const hoverRowStyle = {
  cursor: 'pointer',
  transition: 'background 0.1s',
};

export function SchemaView({ result, onSendMessage }: Props) {
  const send = onSendMessage ?? (() => {});

  if (result.scope === 'PROJECT') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {result.columns.map((ds, i) => (
          <ClickableRow
            key={ds.name}
            onClick={() => send(`Tell me more about ${ds.name}`)}
            tooltip={`Click to list tables in ${ds.name}`}
            index={i}
          >
            <IconBadge icon="database" color="#6366f1" />
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ds.name}</span>
            {ds.tableCount != null && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {ds.tableCount} table{ds.tableCount !== 1 ? 's' : ''}
              </span>
            )}
          </ClickableRow>
        ))}
        <ListAnimationStyle />
      </div>
    );
  }

  if (result.scope === 'DATASET') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {result.columns.map((t, i) => {
          const badge = TYPE_BADGE_MAP[t.type ?? ''] ?? { icon: 'help_outline', color: '#94a3b8', label: t.type ?? 'Unknown' };
          const meta: string[] = [];
          if (t.rowCount != null) meta.push(`${t.rowCount.toLocaleString()} rows`);
          if (t.sizeBytes != null) meta.push(formatBytes(t.sizeBytes));
          if (t.creationTime) {
            try {
              meta.push(new Date(t.creationTime).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }));
            } catch { /* skip bad date */ }
          }
          return (
            <ClickableRow
              key={t.name}
              onClick={() => send(`Show me more about ${result.dataset}.${t.name}`)}
              tooltip={`Click to inspect ${t.name}`}
              index={i}
            >
              <IconBadge icon={badge.icon} color={badge.color} />
              <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
              {meta.length > 0 && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {meta.join(' · ')}
                </span>
              )}
              <TypePill label={badge.label} color={badge.color} />
            </ClickableRow>
          );
        })}
        <ListAnimationStyle />
      </div>
    );
  }

  // TABLE scope — render tabbed view
  return <TableSchemaView result={result} onSendMessage={send} />;
}

// ─── Tabbed TABLE view ────────────────────────────────────────────────────────

type Tab = 'schema' | 'sample' | 'profile';

function TableSchemaView({ result, onSendMessage }: { result: SchemaResult; onSendMessage: (msg: string) => void }) {
  const [activeTab, setActiveTab] = useState<Tab>('sample');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const { accessToken, activeProject } = useAuth();

  const tableRef = `${result.project}.${result.dataset}.${result.table}`;

  // Eagerly fetch sample + profile on mount
  useEffect(() => {
    let cancelled = false;

    async function fetchPreview() {
      try {
        const data = await fetchTablePreview(
          tableRef,
          result.columns.map((c) => ({ name: c.name, type: c.type })),
          activeProject || result.project
        );
        if (!cancelled) setPreview(data);
      } catch (e) {
        if (!cancelled) setPreviewError(e instanceof Error ? e.message : 'Failed to load preview');
      }
    }

    fetchPreview();
    return () => { cancelled = true; };
  }, [tableRef, accessToken, activeProject]);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'sample', label: 'Sample rows' },
    { id: 'schema', label: 'Schema' },
    { id: 'profile', label: 'Profile' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Table stats */}
      {(result.rowCount || result.sizeBytes || result.partitioning) && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
          {result.rowCount && (
            <Stat label="Rows" value={result.rowCount.toLocaleString()} />
          )}
          {result.sizeBytes && (
            <Stat label="Size" value={formatBytes(result.sizeBytes)} />
          )}
          {result.partitioning && (
            <Stat
              label="Partitioned by"
              value={`${result.partitioning.field} (${result.partitioning.type})`}
              highlight
            />
          )}
          {result.clustering && (
            <Stat
              label="Clustered by"
              value={result.clustering.join(', ')}
              highlight
            />
          )}
        </div>
      )}

      {/* Tab bar */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid var(--border-subtle)',
        marginBottom: 0,
        gap: 0,
      }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '7px 14px',
              fontSize: 13,
              fontWeight: 500,
              color: activeTab === tab.id ? 'var(--accent)' : 'var(--text-muted)',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1,
              cursor: 'pointer',
              transition: 'color 0.12s, border-color 0.12s',
              whiteSpace: 'nowrap',
            }}
          >
            {tab.label}
            {(tab.id === 'sample' || tab.id === 'profile') && !preview && !previewError && (
              <span style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--accent)',
                opacity: 0.5,
                marginLeft: 6,
                verticalAlign: 'middle',
                animation: 'pulse 1.2s ease-in-out infinite',
              }} />
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ paddingTop: 12 }}>
        {activeTab === 'schema' && (
          <SchemaTab result={result} tableRef={tableRef} onSendMessage={onSendMessage} />
        )}
        {activeTab === 'sample' && (
          <SampleTab preview={preview} error={previewError} />
        )}
        {activeTab === 'profile' && (
          <ProfileTab preview={preview} error={previewError} />
        )}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 0.8; }
        }
      `}</style>
    </div>
  );
}

// ─── Schema tab ───────────────────────────────────────────────────────────────

function SchemaTab({ result, tableRef, onSendMessage }: {
  result: SchemaResult;
  tableRef: string;
  onSendMessage: (msg: string) => void;
}) {
  return (
    <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 480, borderRadius: 6, border: '1px solid var(--border-subtle)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            {['Column', 'Type', 'Mode', 'Description', ''].map((h) => (
              <th key={h} style={{
                padding: '6px 12px',
                textAlign: 'left',
                color: 'var(--text-muted)',
                fontWeight: 500,
                whiteSpace: 'nowrap',
                position: 'sticky',
                top: 0,
                background: 'var(--surface)',
                zIndex: 1,
                boxShadow: '0 1px 0 var(--border)',
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.columns.map((col) => (
            <ColumnRow
              key={col.name}
              col={col}
              tableRef={tableRef}
              isPk={result.tableConstraints.primaryKey.includes(col.name)}
              isPartition={result.partitioning?.field === col.name}
              isCluster={result.clustering?.includes(col.name) ?? false}
              onSendMessage={onSendMessage}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Sample rows tab ──────────────────────────────────────────────────────────

function SampleTab({ preview, error }: { preview: PreviewResponse | null; error: string | null }) {
  if (error) {
    return (
      <div style={{
        padding: '24px 12px',
        textAlign: 'center',
        color: 'var(--text-dim)',
        fontSize: 12,
      }}>
        <span style={{ color: 'var(--attention)', marginRight: 6 }}>[!]</span>
        {error}
      </div>
    );
  }

  if (!preview) {
    return <SkeletonRows />;
  }

  const { columns, rows } = preview.sample;

  if (rows.length === 0) {
    return (
      <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
        No rows returned
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 480, borderRadius: 6, border: '1px solid var(--border-subtle)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {columns.map((col) => (
                <th key={col} style={{
                  padding: '6px 12px',
                  textAlign: 'left',
                  color: 'var(--text-muted)',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                  position: 'sticky',
                  top: 0,
                  background: 'var(--surface)',
                  zIndex: 1,
                  boxShadow: '0 1px 0 var(--border)',
                }}>{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr
                key={ri}
                style={{ borderBottom: '1px solid var(--border-subtle)' }}
              >
                {(row as unknown[]).map((cell, ci) => (
                  <td key={ci} style={{
                    padding: '6px 12px',
                    color: cell === null ? 'var(--text-dim)' : 'var(--text)',
                    fontSize: 12,
                    whiteSpace: 'nowrap',
                    maxWidth: 240,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {cell === null ? <span style={{ opacity: 0.4 }}>NULL</span> : typeof cell === 'object' ? JSON.stringify(cell) : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-dim)' }}>
        Showing {rows.length} sample rows
      </div>
    </div>
  );
}

// ─── Profile tab ──────────────────────────────────────────────────────────────

function ProfileTab({ preview, error }: { preview: PreviewResponse | null; error: string | null }) {
  const [selected, setSelected] = useState<PreviewColumn | null>(null);

  if (error) {
    return (
      <div style={{
        padding: '24px 12px',
        textAlign: 'center',
        color: 'var(--text-dim)',
        fontSize: 12,
      }}>
        <span style={{ color: 'var(--attention)', marginRight: 6 }}>[!]</span>
        {error}
      </div>
    );
  }

  if (!preview) {
    return <ProfileSkeletonCards />;
  }

  // Precompute numeric sample values per column for real histograms
  const sampleNumsByCol = React.useMemo<Record<string, number[]>>(() => {
    if (!preview) return {};
    const out: Record<string, number[]> = {};
    for (const col of preview.profile) {
      const idx = preview.sample.columns.indexOf(col.name);
      if (idx >= 0) {
        const nums = preview.sample.rows
          .map(r => parseFloat(String(r[idx] ?? '')))
          .filter(n => !isNaN(n));
        if (nums.length > 0) out[col.name] = nums;
      }
    }
    return out;
  }, [preview]);

  return (
    <>
      <div style={{ overflowY: 'auto', maxHeight: 480, borderRadius: 6 }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 14,
          padding: '4px 2px 8px',
        }}>
          {preview.profile.map((col) => (
            <FieldProfileCard
              key={col.name}
              col={col}
              sampleNums={sampleNumsByCol[col.name]}
              onOpen={() => setSelected(col)}
            />
          ))}
          <style>{`
            @keyframes profileCardIn {
              from { opacity: 0; transform: translateY(6px); }
              to   { opacity: 1; transform: translateY(0); }
            }
            .field-profile-card {
              animation: profileCardIn 0.22s ease both;
            }
            .field-profile-card:hover {
              border-color: var(--accent) !important;
              box-shadow: 0 4px 20px rgba(0,0,0,0.18) !important;
              transform: translateY(-1px);
            }
            .field-profile-card { transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s; }
          `}</style>
        </div>
      </div>

      {selected && (
        <FieldDetailDialog
          col={selected}
          sample={preview.sample}
          sampleNums={sampleNumsByCol[selected.name]}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

// Determine high-level field category
function fieldCategory(type: string): 'numeric' | 'string' | 'date' | 'bool' | 'other' {
  const t = type.toUpperCase();
  if (['INTEGER','INT64','FLOAT','FLOAT64','NUMERIC','BIGNUMERIC','INT','SMALLINT','BIGINT'].some(k => t.startsWith(k))) return 'numeric';
  if (['STRING','BYTES'].includes(t)) return 'string';
  if (['DATE','DATETIME','TIMESTAMP'].some(k => t.startsWith(k))) return 'date';
  if (['BOOL','BOOLEAN'].includes(t)) return 'bool';
  return 'other';
}

// Accent colours per category
const CAT_COLOR: Record<string, string> = {
  numeric: '#6ee7b7',   // emerald
  string:  '#93c5fd',   // sky
  date:    '#c4b5fd',   // violet
  bool:    '#fda4af',   // rose
  other:   '#94a3b8',   // slate
};

const CAT_ICON: Record<string, string> = {
  numeric: 'bar_chart',
  string:  'sort',
  date:    'calendar_month',
  bool:    'toggle_on',
  other:   'code',
};

const CAT_LABEL: Record<string, string> = {
  numeric: 'Numeric',
  string:  'Categorical',
  date:    'Date / Time',
  bool:    'Boolean',
  other:   'Other',
};

// Compute real histogram bucket heights from sample values
function computeHistogram(values: number[], bucketCount: number): number[] {
  if (!values || values.length === 0) {
    // Fallback: flat line so it's obvious there's no data
    return Array(bucketCount).fill(0.3);
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    // All values identical — single spike
    const h = Array(bucketCount).fill(0.05);
    h[Math.floor(bucketCount / 2)] = 1;
    return h;
  }
  const counts = Array(bucketCount).fill(0);
  for (const v of values) {
    const idx = Math.min(Math.floor(((v - min) / (max - min)) * bucketCount), bucketCount - 1);
    counts[idx]++;
  }
  const peak = Math.max(...counts);
  return counts.map(c => peak > 0 ? c / peak : 0);
}

function FieldProfileCard({ col, sampleNums, onOpen }: { col: PreviewColumn; sampleNums?: number[]; onOpen: () => void }) {
  const cat = fieldCategory(col.type);
  const accent = CAT_COLOR[cat];
  const nullPct = col.nullPct ?? 0;
  const fillPct = Math.min(nullPct, 100);
  const nullColor = nullPct === 0 ? '#34d399' : nullPct > 20 ? '#fb923c' : '#94a3b8';

  return (
    <div
      className="field-profile-card"
      onClick={onOpen}
      style={{
        background: 'var(--surface-2)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 10,
        padding: '14px 16px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        cursor: 'pointer',
      }}
    >
      {/* ── Card header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        {/* Icon badge */}
        <div style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          background: `${accent}22`,
          border: `1px solid ${accent}44`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}>
          <span className="material-symbols-outlined" style={{ fontSize: 15, color: accent }}>{CAT_ICON[cat]}</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }} title={col.name}>{col.name}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 3, alignItems: 'center' }}>
            <span style={{
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: accent,
              background: `${accent}18`,
              padding: '1px 6px',
              borderRadius: 4,
            }}>{CAT_LABEL[cat]}</span>
            <span style={{
              fontSize: 9,
              fontWeight: 500,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--text-dim)',
              fontFamily: 'var(--font-mono)',
            }}>{col.type}</span>
          </div>
        </div>
      </div>

      {/* ── Shape visualization ── */}
      <div style={{ minHeight: 80 }}>
        {cat === 'string' && col.topValues.length > 0
          ? <CategoricalBars values={col.topValues} accent={accent} />
          : cat === 'numeric' && col.min !== null && col.max !== null
          ? <NumericRangeViz min={col.min} max={col.max} sampleNums={sampleNums} accent={accent} />
          : (cat === 'date') && col.min !== null && col.max !== null
          ? <DateRangeViz min={col.min} max={col.max} accent={accent} />
          : cat === 'bool'
          ? <BoolViz col={col} accent={accent} />
          : <GenericViz col={col} accent={accent} />
        }
      </div>

      {/* ── Footer stats ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '6px 10px',
        borderTop: '1px solid var(--border-subtle)',
        paddingTop: 10,
      }}>
        <StatPill
          label="Distinct"
          value={col.distinctCount !== null ? col.distinctCount.toLocaleString() : '—'}
        />
        <StatPill
          label="Null %"
          value={col.nullPct !== null ? `${col.nullPct}%` : '—'}
          valueColor={nullColor}
          extra={
            <div style={{ width: '100%', height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', marginTop: 3 }}>
              <div style={{ width: `${fillPct}%`, height: '100%', background: nullColor, borderRadius: 2, transition: 'width 0.4s' }} />
            </div>
          }
        />
      </div>
    </div>
  );
}

// ── Shape: categorical horizontal bar chart ──────────────────────────────────
function CategoricalBars({ values, accent }: { values: Array<{ value: string; count: number }>; accent: string }) {
  const top = values.slice(0, 5);
  const maxCount = Math.max(...top.map(v => v.count), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {top.map((v, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <div style={{
            flex: 1,
            height: 18,
            background: 'var(--border-subtle)',
            borderRadius: 4,
            overflow: 'hidden',
            position: 'relative',
          }}>
            <div style={{
              position: 'absolute',
              left: 0, top: 0, bottom: 0,
              width: `${(v.count / maxCount) * 100}%`,
              background: `${accent}55`,
              borderRadius: 4,
              transition: 'width 0.5s cubic-bezier(0.4,0,0.2,1)',
              transitionDelay: `${i * 50}ms`,
            }} />
            <span style={{
              position: 'relative',
              fontSize: 10,
              color: 'var(--text)',
              fontFamily: 'var(--font-mono)',
              padding: '0 6px',
              lineHeight: '18px',
              display: 'inline-block',
              maxWidth: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>{v.value || '∅ empty'}</span>
          </div>
          <span style={{
            fontSize: 10,
            color: 'var(--text-dim)',
            fontFamily: 'var(--font-mono)',
            flexShrink: 0,
            minWidth: 30,
            textAlign: 'right',
          }}>{v.count.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

// ── Shape: numeric range with a real histogram ───────────────────────────────
function NumericRangeViz({ min, max, sampleNums, accent }: { min: string; max: string; sampleNums?: number[]; accent: string }) {
  const minNum = parseFloat(min);
  const maxNum = parseFloat(max);
  const range = maxNum - minNum;
  const isValid = !isNaN(minNum) && !isNaN(maxNum);

  const BUCKETS = 12;
  const heights = computeHistogram(sampleNums ?? [], BUCKETS);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Histogram bars */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 48 }}>
        {heights.map((h, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: `${Math.max(h * 100, 4)}%`,
              background: `${accent}${Math.round(55 + h * 130).toString(16).padStart(2,'0')}`,
              borderRadius: '3px 3px 0 0',
              transition: `height 0.5s cubic-bezier(0.4,0,0.2,1) ${i * 30}ms`,
            }}
          />
        ))}
      </div>
      {/* Range labels */}
      {isValid && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {minNum.toLocaleString()}
          </span>
          {range > 0 && (
            <span style={{ fontSize: 9, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
              range: {range.toLocaleString()}
            </span>
          )}
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {maxNum.toLocaleString()}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Shape: date range with a timeline ───────────────────────────────────────
function DateRangeViz({ min, max, accent }: { min: string; max: string; accent: string }) {
  const fmtDate = (s: string) => {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const minDate = new Date(min);
  const maxDate = new Date(max);
  const spanMs = maxDate.getTime() - minDate.getTime();
  const spanDays = Math.round(spanMs / (1000 * 60 * 60 * 24));
  const years = (spanDays / 365).toFixed(1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Timeline bar */}
      <div style={{ position: 'relative', height: 28 }}>
        {/* Track */}
        <div style={{
          position: 'absolute',
          top: '50%',
          left: 0,
          right: 0,
          height: 4,
          background: 'var(--border-subtle)',
          borderRadius: 2,
          transform: 'translateY(-50%)',
        }} />
        {/* Fill */}
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '10%',
          right: '10%',
          height: 4,
          background: `linear-gradient(90deg, ${accent}88, ${accent})`,
          borderRadius: 2,
          transform: 'translateY(-50%)',
        }} />
        {/* Dot start */}
        <div style={{
          position: 'absolute',
          left: '10%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: accent,
          boxShadow: `0 0 0 3px ${accent}33`,
        }} />
        {/* Dot end */}
        <div style={{
          position: 'absolute',
          right: '10%',
          top: '50%',
          transform: 'translate(50%, -50%)',
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: accent,
          boxShadow: `0 0 0 3px ${accent}33`,
        }} />
      </div>

      {/* Date labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Start</span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{fmtDate(min)}</span>
        </div>
        {spanDays > 0 && (
          <div style={{ textAlign: 'center' }}>
            <span style={{
              fontSize: 9,
              color: accent,
              background: `${accent}18`,
              padding: '2px 7px',
              borderRadius: 20,
              fontFamily: 'var(--font-mono)',
            }}>
              {spanDays > 730 ? `${years}y` : `${spanDays}d`}
            </span>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-end' }}>
          <span style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>End</span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{fmtDate(max)}</span>
        </div>
      </div>
    </div>
  );
}

// ── Shape: boolean split visualization ──────────────────────────────────────
function BoolViz({ col, accent }: { col: PreviewColumn; accent: string }) {
  // For booleans we show a split bar based on top values if available, else generic
  const trueVal = col.topValues.find(v => v.value.toLowerCase() === 'true');
  const falseVal = col.topValues.find(v => v.value.toLowerCase() === 'false');
  const total = (trueVal?.count ?? 0) + (falseVal?.count ?? 0);
  const truePct = total > 0 ? Math.round((trueVal?.count ?? 0) / total * 100) : 50;
  const falsePct = 100 - truePct;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4 }}>
      {/* Split bar */}
      <div style={{ display: 'flex', height: 24, borderRadius: 6, overflow: 'hidden', gap: 2 }}>
        <div style={{
          flex: truePct,
          background: `${accent}88`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 16,
        }}>
          {truePct > 15 && <span style={{ fontSize: 10, color: 'var(--text)', fontWeight: 600 }}>{truePct}%</span>}
        </div>
        <div style={{
          flex: falsePct,
          background: 'var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 16,
        }}>
          {falsePct > 15 && <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 }}>{falsePct}%</span>}
        </div>
      </div>
      {/* Legend */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div style={{ width: 8, height: 8, borderRadius: 2, background: `${accent}88` }} />
          <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            true {total > 0 ? `(${(trueVal?.count ?? 0).toLocaleString()})` : ''}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            false {total > 0 ? `(${(falseVal?.count ?? 0).toLocaleString()})` : ''}
          </span>
          <div style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--border)' }} />
        </div>
      </div>
    </div>
  );
}

// ── Shape: generic / unknown type ───────────────────────────────────────────
function GenericViz({ col, accent }: { col: PreviewColumn; accent: string }) {
  const distinct = col.distinctCount ?? 0;
  const hasRange = col.min && col.max;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
      {/* Cardinality indicator */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Cardinality</span>
          <span style={{ fontSize: 10, color: accent, fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
            {distinct.toLocaleString()} unique
          </span>
        </div>
        {/* Dot grid for cardinality feel */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, padding: '4px 0' }}>
          {Array.from({ length: Math.min(distinct, 30) }).map((_, i) => (
            <div key={i} style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: i < Math.round(distinct / Math.max(distinct, 30) * 30)
                ? `${accent}cc`
                : 'var(--border)',
            }} />
          ))}
        </div>
      </div>
      {hasRange && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '45%' }}>{col.min}</span>
          <span style={{ color: 'var(--border)', flexShrink: 0 }}>→</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '45%', textAlign: 'right' }}>{col.max}</span>
        </div>
      )}
    </div>
  );
}

// ── Stat pill ────────────────────────────────────────────────────────────────
function StatPill({
  label, value, valueColor, extra,
}: { label: string; value: string; valueColor?: string; extra?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 600, color: valueColor ?? 'var(--text-muted)' }}>{value}</span>
      {extra}
    </div>
  );
}

// ── Skeleton for card loading state ─────────────────────────────────────────
function ProfileSkeletonCards() {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
      gap: 14,
      padding: '4px 2px 8px',
    }}>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} style={{
          height: 190,
          background: 'var(--surface-2)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 10,
          opacity: 1 - i * 0.08,
          animation: 'shimmer 1.4s ease-in-out infinite',
          animationDelay: `${i * 80}ms`,
        }} />
      ))}
      <style>{`
        @keyframes shimmer {
          0%, 100% { opacity: 0.35; }
          50% { opacity: 0.65; }
        }
      `}</style>
    </div>
  );
}

// ── Field Detail Dialog ───────────────────────────────────────────────────────
function FieldDetailDialog({
  col,
  sample,
  sampleNums,
  onClose,
}: {
  col: PreviewColumn;
  sample: PreviewResponse['sample'];
  sampleNums?: number[];
  onClose: () => void;
}) {
  const cat = fieldCategory(col.type);
  const accent = CAT_COLOR[cat];
  const nullPct = col.nullPct ?? 0;
  const nullColor = nullPct === 0 ? '#34d399' : nullPct > 20 ? '#fb923c' : '#94a3b8';

  // Extract sample values for this column
  const colIdx = sample.columns.indexOf(col.name);
  const sampleValues: string[] = colIdx >= 0
    ? sample.rows
        .map(r => String(r[colIdx] ?? ''))
        .filter(v => v !== '' && v !== 'null')
        .slice(0, 20)
    : [];

  // Close on Escape
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const stats = [
    { label: 'Type', value: col.type },
    { label: 'Category', value: CAT_LABEL[cat] },
    { label: 'Distinct', value: col.distinctCount !== null ? col.distinctCount.toLocaleString() : '—' },
    { label: 'Null %', value: col.nullPct !== null ? `${col.nullPct}%` : '—', color: nullColor },
    { label: 'Min', value: col.min ?? '—' },
    { label: 'Max', value: col.max ?? '—' },
  ];

  // Use portal so dialog mounts at document.body — immune to parent transforms
  return createPortal(
    <React.Fragment>
      <style>{`
        @keyframes dialogBackdropIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes dialogPanelIn {
          from { opacity: 0; transform: scale(0.96) translateY(12px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
        .field-detail-dialog-backdrop { animation: dialogBackdropIn 0.18s ease both; }
        .field-detail-dialog-panel { animation: dialogPanelIn 0.22s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
      `}</style>

      {/* Backdrop */}
      <div
        className="field-detail-dialog-backdrop"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(4px)',
          zIndex: 1000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        {/* Panel */}
        <div
          className="field-detail-dialog-panel"
          onClick={e => e.stopPropagation()}
          style={{
            background: 'var(--surface)',
            border: `1px solid ${accent}44`,
            borderRadius: 16,
            width: '100%',
            maxWidth: 680,
            maxHeight: '88vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: `0 24px 80px rgba(0,0,0,0.5), 0 0 0 1px ${accent}22`,
          }}
        >
          {/* Dialog header */}
          <div style={{
            padding: '20px 24px 16px',
            borderBottom: `1px solid var(--border-subtle)`,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            background: `linear-gradient(135deg, ${accent}0a, transparent)`,
            flexShrink: 0,
          }}>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              background: `${accent}22`,
              border: `1px solid ${accent}55`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}>
              <span className="material-symbols-outlined" style={{ fontSize: 20, color: accent }}>{CAT_ICON[cat]}</span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 16,
                fontWeight: 700,
                color: 'var(--text)',
                fontFamily: 'var(--font-mono)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>{col.name}</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: '0.07em',
                  textTransform: 'uppercase',
                  color: accent,
                  background: `${accent}18`,
                  padding: '2px 8px',
                  borderRadius: 5,
                }}>{CAT_LABEL[cat]}</span>
                <span style={{
                  fontSize: 10,
                  color: 'var(--text-dim)',
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.04em',
                }}>{col.type}</span>
              </div>
            </div>
            <button
              onClick={onClose}
              style={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 8,
                width: 32,
                height: 32,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: 'var(--text-dim)',
                flexShrink: 0,
                transition: 'background 0.1s, color 0.1s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--border)'; (e.currentTarget as HTMLElement).style.color = 'var(--text)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--text-dim)'; }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
            </button>
          </div>

          {/* Scrollable body */}
          <div style={{ overflow: 'auto', flex: 1, padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 24 }}>

            {/* ── Stats grid ── */}
            <div>
              <SectionLabel>Statistics</SectionLabel>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 10,
                marginTop: 10,
              }}>
                {stats.map(s => (
                  <div key={s.label} style={{
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 8,
                    padding: '10px 12px',
                  }}>
                    <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{s.label}</div>
                    <div style={{
                      fontSize: 13,
                      fontFamily: 'var(--font-mono)',
                      fontWeight: 600,
                      color: s.color ?? 'var(--text)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }} title={s.value}>{s.value}</div>
                  </div>
                ))}
              </div>

              {/* Null % bar */}
              <div style={{ marginTop: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>Null coverage</span>
                  <span style={{ fontSize: 10, color: nullColor, fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{nullPct}%</span>
                </div>
                <div style={{ height: 6, background: 'var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    width: `${Math.min(nullPct, 100)}%`,
                    height: '100%',
                    background: nullColor,
                    borderRadius: 3,
                    transition: 'width 0.5s',
                  }} />
                </div>
              </div>
            </div>

            {/* ── Expanded visualization ── */}
            <div>
              <SectionLabel>
                {cat === 'string' ? 'Top Values' :
                 cat === 'numeric' ? 'Distribution Shape' :
                 cat === 'date' ? 'Date Range' :
                 cat === 'bool' ? 'True / False Split' :
                 'Data Shape'}
              </SectionLabel>
              <div style={{ marginTop: 10 }}>
                {cat === 'string' && col.topValues.length > 0
                  ? <CategoricalBarsLarge values={col.topValues} accent={accent} />
                  : cat === 'numeric' && col.min !== null && col.max !== null
                  ? <NumericRangeVizLarge min={col.min} max={col.max} sampleNums={sampleNums} accent={accent} />
                  : cat === 'date' && col.min !== null && col.max !== null
                  ? <DateRangeVizLarge min={col.min} max={col.max} accent={accent} />
                  : cat === 'bool'
                  ? <BoolVizLarge col={col} accent={accent} />
                  : <GenericVizLarge col={col} accent={accent} />
                }
              </div>
            </div>

            {/* ── Sample values ── */}
            {sampleValues.length > 0 && (
              <div>
                <SectionLabel>Sample Values ({sampleValues.length})</SectionLabel>
                <div style={{
                  marginTop: 10,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                }}>
                  {sampleValues.map((v, i) => (
                    <span key={i} style={{
                      fontSize: 11,
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--text-muted)',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 5,
                      padding: '3px 8px',
                      maxWidth: 200,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      display: 'inline-block',
                    }} title={v}>{v}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </React.Fragment>,
    document.body
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{children}</span>
      <div style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
    </div>
  );
}

// ── Large visualizations for dialog ──────────────────────────────────────────

function CategoricalBarsLarge({ values, accent }: { values: Array<{ value: string; count: number }>; accent: string }) {
  const maxCount = Math.max(...values.map(v => v.count), 1);
  const totalCount = values.reduce((s, v) => s + v.count, 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {values.map((v, i) => {
        const pct = Math.round(v.count / totalCount * 100);
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 140,
              flexShrink: 0,
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textAlign: 'right',
            }} title={v.value}>{v.value || '∅ empty'}</div>
            <div style={{
              flex: 1,
              height: 22,
              background: 'var(--border-subtle)',
              borderRadius: 5,
              overflow: 'hidden',
              position: 'relative',
            }}>
              <div style={{
                position: 'absolute',
                left: 0, top: 0, bottom: 0,
                width: `${(v.count / maxCount) * 100}%`,
                background: `linear-gradient(90deg, ${accent}66, ${accent}99)`,
                borderRadius: 5,
                transition: `width 0.6s cubic-bezier(0.4,0,0.2,1) ${i * 60}ms`,
              }} />
            </div>
            <div style={{ display: 'flex', gap: 8, minWidth: 80, justifyContent: 'flex-end' }}>
              <span style={{ fontSize: 11, color: accent, fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{pct}%</span>
              <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>{v.count.toLocaleString()}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NumericRangeVizLarge({ min, max, sampleNums, accent }: { min: string; max: string; sampleNums?: number[]; accent: string }) {
  const minNum = parseFloat(min);
  const maxNum = parseFloat(max);
  const range = maxNum - minNum;
  const BUCKETS = 20;
  const heights = computeHistogram(sampleNums ?? [], BUCKETS);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 100 }}>
        {heights.map((h, i) => (
          <div key={i} style={{
            flex: 1,
            height: `${Math.max(h * 100, 3)}%`,
            background: `${accent}${Math.round(60 + h * 130).toString(16).padStart(2,'0')}`,
            borderRadius: '4px 4px 0 0',
            transition: `height 0.6s cubic-bezier(0.4,0,0.2,1) ${i * 20}ms`,
          }} />
        ))}
      </div>
      <div style={{ height: 2, background: `linear-gradient(90deg, ${accent}44, ${accent})`, borderRadius: 1 }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Min</span>
          <span style={{ fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{minNum.toLocaleString()}</span>
        </div>
        <div style={{ textAlign: 'center' }}>
          <span style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block' }}>Range</span>
          <span style={{ fontSize: 13, color: accent, fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{range.toLocaleString()}</span>
        </div>
        <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Max</span>
          <span style={{ fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{maxNum.toLocaleString()}</span>
        </div>
      </div>
      {sampleNums && sampleNums.length > 0 && (
        <div style={{ fontSize: 9, color: 'var(--text-dim)', textAlign: 'center', marginTop: 2 }}>
          Based on {sampleNums.length} sample values
        </div>
      )}
    </div>
  );
}

function DateRangeVizLarge({ min, max, accent }: { min: string; max: string; accent: string }) {
  const fmtDate = (s: string) => {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  };
  const minDate = new Date(min);
  const maxDate = new Date(max);
  const spanMs = maxDate.getTime() - minDate.getTime();
  const spanDays = Math.round(spanMs / (1000 * 60 * 60 * 24));
  const spanYears = (spanDays / 365).toFixed(1);
  const spanMonths = Math.round(spanDays / 30);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Big timeline */}
      <div style={{ position: 'relative', height: 40 }}>
        <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 6, background: 'var(--border-subtle)', borderRadius: 3, transform: 'translateY(-50%)' }} />
        <div style={{
          position: 'absolute', top: '50%', left: '8%', right: '8%', height: 6,
          background: `linear-gradient(90deg, ${accent}55, ${accent})`,
          borderRadius: 3, transform: 'translateY(-50%)',
        }} />
        {[{ side: 'left' as const, val: '8%' }, { side: 'right' as const, val: '8%' }].map(({ side, val }) => (
          <div key={side} style={{
            position: 'absolute',
            [side]: val,
            top: '50%',
            transform: `translate(${side === 'left' ? '-50%' : '50%'}, -50%)`,
            width: 14, height: 14, borderRadius: '50%',
            background: accent,
            boxShadow: `0 0 0 4px ${accent}33, 0 0 0 8px ${accent}11`,
          }} />
        ))}
      </div>

      {/* Labels */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 12, alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Start</span>
          <span style={{ fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{fmtDate(min)}</span>
        </div>
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Span</span>
          <span style={{
            fontSize: 14,
            fontWeight: 700,
            color: accent,
            fontFamily: 'var(--font-mono)',
            background: `${accent}18`,
            padding: '4px 12px',
            borderRadius: 20,
          }}>
            {spanDays > 730 ? `${spanYears}y` : spanDays > 60 ? `${spanMonths}mo` : `${spanDays}d`}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-end' }}>
          <span style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>End</span>
          <span style={{ fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{fmtDate(max)}</span>
        </div>
      </div>
    </div>
  );
}

function BoolVizLarge({ col, accent }: { col: PreviewColumn; accent: string }) {
  const trueVal = col.topValues.find(v => v.value.toLowerCase() === 'true');
  const falseVal = col.topValues.find(v => v.value.toLowerCase() === 'false');
  const total = (trueVal?.count ?? 0) + (falseVal?.count ?? 0);
  const truePct = total > 0 ? Math.round((trueVal?.count ?? 0) / total * 100) : 50;
  const falsePct = 100 - truePct;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', height: 40, borderRadius: 8, overflow: 'hidden', gap: 3 }}>
        <div style={{ flex: truePct, background: `${accent}99`, display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 20 }}>
          {truePct > 12 && <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{truePct}%</span>}
        </div>
        <div style={{ flex: falsePct, background: 'var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 20 }}>
          {falsePct > 12 && <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)' }}>{falsePct}%</span>}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {[{ label: 'true', count: trueVal?.count ?? 0, pct: truePct, bg: `${accent}99` },
          { label: 'false', count: falseVal?.count ?? 0, pct: falsePct, bg: 'var(--border)' }].map(item => (
          <div key={item.label} style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: '10px 14px',
            display: 'flex',
            gap: 10,
            alignItems: 'center',
          }}>
            <div style={{ width: 10, height: 10, borderRadius: 3, background: item.bg, flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>{item.label}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>
                {total > 0 ? item.count.toLocaleString() : '—'}
                {total > 0 && <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 400, marginLeft: 6 }}>({item.pct}%)</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GenericVizLarge({ col, accent }: { col: PreviewColumn; accent: string }) {
  const distinct = col.distinctCount ?? 0;
  const dotCount = Math.min(distinct, 60);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 6, padding: '12px 0' }}>
        <span style={{ fontSize: 36, fontWeight: 700, color: accent, fontFamily: 'var(--font-mono)' }}>{distinct.toLocaleString()}</span>
        <span style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Unique Values</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'center' }}>
        {Array.from({ length: dotCount }).map((_, i) => (
          <div key={i} style={{
            width: 8, height: 8, borderRadius: '50%',
            background: `${accent}cc`,
            opacity: 0.4 + (i / dotCount) * 0.6,
          }} />
        ))}
      </div>
      {col.min && col.max && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {[{ label: 'Min', val: col.min }, { label: 'Max', val: col.max }].map(x => (
            <div key={x.label} style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 8,
              padding: '10px 14px',
            }}>
              <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>{x.label}</div>
              <div style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'var(--font-mono)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={x.val}>{x.val}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Skeleton loader ──────────────────────────────────────────────────────────

function SkeletonRows({ count = 5 }: { count?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{
          height: 28,
          background: 'var(--surface-2)',
          borderRadius: 4,
          opacity: 1 - i * 0.12,
          animation: 'shimmer 1.4s ease-in-out infinite',
        }} />
      ))}
      <style>{`
        @keyframes shimmer {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.7; }
        }
      `}</style>
    </div>
  );
}

// ─── Clickable row wrapper ─────────────────────────────────────────────────────

function ClickableRow({
  children,
  onClick,
  tooltip,
  index = 0,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tooltip: string;
  index?: number;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      className="schema-list-row"
      title={tooltip}
      onClick={onClick}
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
        transition: 'background 0.12s ease',
        userSelect: 'none',
        animationName: 'listRowSlideIn',
        animationDuration: '0.2s',
        animationTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
        animationFillMode: 'both',
        animationDelay: `${index * 25}ms`,
      }}
    >
      {children}
    </div>
  );
}

// ─── Column row with hover action menu ────────────────────────────────────────

function ColumnRow({
  col,
  tableRef,
  isPk,
  isPartition,
  isCluster,
  depth = 0,
  onSendMessage,
}: {
  col: SchemaColumn;
  tableRef: string;
  isPk: boolean;
  isPartition: boolean;
  isCluster: boolean;
  depth?: number;
  onSendMessage: (msg: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isSpecial = isPk || isPartition || isCluster;

  return (
    <>
      <tr
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          borderBottom: '1px solid var(--border-subtle)',
          background: hovered
            ? 'var(--accent-dim)'
            : isSpecial ? 'rgba(79,127,255,0.04)' : undefined,
          transition: 'background 0.1s',
        }}
      >
        <td style={{ padding: '7px 12px', paddingLeft: 12 + depth * 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              fontFamily: 'var(--font-mono)',
              color: isSpecial ? 'var(--accent)' : 'var(--text)',
            }}>{col.name}</span>
            {isPk && <Badge label="PK" color="var(--accent)" />}
            {isPartition && <Badge label="partition" color="var(--attention)" />}
            {isCluster && <Badge label="cluster" color="var(--positive)" />}
          </div>
        </td>
        <td style={{ padding: '7px 12px' }}>
          <span style={{
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)',
            fontSize: 11,
          }}>{col.type}</span>
        </td>
        <td style={{ padding: '7px 12px' }}>
          <span style={{ color: col.mode === 'REQUIRED' ? 'var(--text-muted)' : 'var(--text-dim)', fontSize: 11 }}>
            {col.mode}
          </span>
        </td>
        <td style={{ padding: '7px 12px', color: 'var(--text-muted)', fontSize: 11 }}>
          {col.description ?? ''}
        </td>
        {/* Inline column actions — visible on hover */}
        <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>
          {hovered && (
            <div style={{ display: 'flex', gap: 4 }}>
              <InlineAction
                label="Sample"
                onClick={() => onSendMessage(`What are the top values for ${col.name}?`)}
              />
              <InlineAction
                label="Nulls?"
                onClick={() => onSendMessage(`How many nulls are in ${col.name}?`)}
              />
            </div>
          )}
        </td>
      </tr>
      {/* Render nested fields for RECORD types */}
      {col.fields?.map((f) => (
        <ColumnRow
          key={`${col.name}.${f.name}`}
          col={f}
          tableRef={tableRef}
          isPk={false}
          isPartition={false}
          isCluster={false}
          depth={depth + 1}
          onSendMessage={onSendMessage}
        />
      ))}
    </>
  );
}

function InlineAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        fontSize: 10,
        padding: '2px 7px',
        borderRadius: 4,
        border: '1px solid var(--border)',
        background: 'var(--surface)',
        color: 'var(--text-muted)',
        cursor: 'pointer',
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

const TYPE_BADGE_MAP: Record<string, { icon: string; color: string; label: string }> = {
  TABLE:             { icon: 'table_chart',   color: '#1a73e8', label: 'Table' },
  VIEW:              { icon: 'visibility',    color: '#7c3aed', label: 'View' },
  MATERIALIZED_VIEW: { icon: 'table_rows',    color: '#059669', label: 'Mat. View' },
  EXTERNAL:          { icon: 'cloud',         color: '#d97706', label: 'External' },
  DATASET:           { icon: 'database',      color: '#6366f1', label: 'Dataset' },
};

function ArrowIcon() {
  return (
    <span
      className="material-symbols-outlined schema-list-arrow"
      style={{
        fontSize: 14,
        color: 'var(--text-dim)',
        flexShrink: 0,
        transition: 'transform 0.15s ease, color 0.15s ease',
      }}
    >
      chevron_right
    </span>
  );
}

function IconBadge({ icon, color }: { icon: string; color: string }) {
  return (
    <span
      className="material-symbols-outlined"
      style={{ fontSize: 15, color, flexShrink: 0 }}
    >
      {icon}
    </span>
  );
}

function TypePill({ label, color }: { label: string; color?: string }) {
  const c = color ?? 'var(--text-muted)';
  return (
    <span style={{
      fontSize: 9,
      fontWeight: 500,
      color: c,
      background: `${c}12`,
      border: `1px solid ${c}25`,
      padding: '1px 6px',
      borderRadius: 10,
      letterSpacing: '0.02em',
      whiteSpace: 'nowrap',
      flexShrink: 0,
    }}>
      {label}
    </span>
  );
}

function ListAnimationStyle() {
  return (
    <style>{`
      @keyframes listRowSlideIn {
        from { opacity: 0; transform: translateY(8px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .schema-list-row:hover .schema-list-arrow {
        transform: translateX(3px);
        color: var(--accent) !important;
      }
    `}</style>
  );
}

function TypeBadge({ type }: { type?: string }) {
  const entry = TYPE_BADGE_MAP[type ?? ''] ?? { icon: 'help_outline', color: '#94a3b8', label: type ?? '' };
  return <IconBadge icon={entry.icon} color={entry.color} />;
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontSize: 9,
      fontWeight: 500,
      color,
      border: `1px solid ${color}`,
      borderRadius: 3,
      padding: '1px 4px',
      letterSpacing: 0.5,
      opacity: 0.8,
    }}>{label.toUpperCase()}</span>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      <span style={{
        fontSize: 12,
        color: highlight ? 'var(--accent)' : 'var(--text)',
        fontFamily: 'var(--font-mono)',
      }}>{value}</span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  return `${bytes} bytes`;
}
