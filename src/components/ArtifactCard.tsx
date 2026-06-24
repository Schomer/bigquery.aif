'use client';

import type { CompositionEnvelope, HandoffEnvelope } from '@/lib/types';
import { SchemaView } from './SchemaView';
import { DataTable } from './DataTable';
import { ConfirmationCard } from './ConfirmationCard';
import { CompletionCard } from './CompletionCard';
import { ChartView } from './ChartView';
import { KpiCard } from './KpiCard';
import { CostConfirmCard } from './CostConfirmCard';
import { DiscoveryView } from './DiscoveryView';
import { DataQualityView } from './DataQualityView';
import { MonitoringView } from './MonitoringView';
import { DataLoadingView } from './DataLoadingView';
import { MultistepView } from './MultistepView';
import { useState } from 'react';

interface Props {
  envelope: CompositionEnvelope;
  onConfirm?: () => void;
  onCancel?: () => void;
  onChipClick?: (chip: HandoffEnvelope) => void;
  onInlineClick?: (message: string) => void;
}

const TONE_CLASSES: Record<string, string> = {
  NEUTRAL: 'tone-neutral',
  POSITIVE: 'tone-positive',
  ATTENTION: 'tone-attention',
};

export function ArtifactCard({ envelope, onConfirm, onCancel, onChipClick, onInlineClick }: Props) {
  const [provenanceOpen, setProvenanceOpen] = useState(false);
  const toneClass = TONE_CLASSES[envelope.headline.tone] ?? 'tone-neutral';

  // Convert chip click -> send the chip's label as a message (primary path)
  // The label is meaningful natural language, e.g. "Inspect orders", "Show sample rows"
  function handleInlineClick(message: string) {
    if (onInlineClick) {
      onInlineClick(message);
    } else {
      // Create a synthetic handoff envelope to preserve context
      const syntheticChip: HandoffEnvelope = {
        targetSkill: 'query',
        label: message,
        context: {},
        sourceSkill: envelope.skill,
        sourceResultRef: envelope.id,
      };
      onChipClick?.(syntheticChip);
    }
  }

  return (
    <div
      className={`fade-up ${toneClass}`}
      style={{
        background: '#ffffff',
        border: '1px solid var(--border)',
        borderRadius: 12,
        overflow: 'hidden',
      }}
    >
      {/* Headline */}
      <div style={{ padding: '16px 20px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <p style={{
            margin: 0,
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--text)',
            lineHeight: 1.5,
          }}>
            {typeof envelope.headline.text === 'string' ? envelope.headline.text : String(envelope.headline.text ?? '')}
          </p>
        </div>
      </div>

      {/* Primary artifact — onSendMessage threaded into every view */}
      <div style={{ padding: '0 20px 16px' }}>
        <Artifact
          envelope={envelope}
          onConfirm={onConfirm}
          onCancel={onCancel}
          onSendMessage={handleInlineClick}
        />

        {envelope.insight && (
          <div style={{
            marginTop: 16,
            padding: '12px 16px',
            background: '#f5f3ff',
            border: '1px solid #ddd6fe',
            borderLeft: '4px solid #7c3aed',
            borderRadius: 8,
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginBottom: 4,
            }}>
              <span style={{
                fontSize: 10,
                fontWeight: 600,
                color: '#6d28d9',
                background: '#ede9fe',
                padding: '2px 6px',
                borderRadius: 4,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}>
                Insight
              </span>
            </div>
            <p style={{
              margin: 0,
              fontSize: 13,
              color: 'var(--text)',
              lineHeight: 1.4,
            }}>
              {typeof envelope.insight === 'string' ? envelope.insight : String(envelope.insight ?? '')}
            </p>
          </div>
        )}
      </div>

      {/* Provenance (collapsible) */}
      {envelope.provenance.sql && (
        <div style={{
          borderTop: '1px solid var(--border-subtle)',
          padding: '0 20px',
        }}>
          {envelope.provenance.visibility === 'VISIBLE' ? (
            <ProvenanceContent envelope={envelope} />
          ) : (
            <details
              style={{ paddingTop: 8, paddingBottom: 8 }}
              open={provenanceOpen}
              onToggle={(e) => setProvenanceOpen((e.target as HTMLDetailsElement).open)}
            >
              <summary style={{
                fontSize: 11,
                color: 'var(--text-dim)',
                cursor: 'pointer',
                listStyle: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}>
                <span style={{ transform: provenanceOpen ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block', transition: 'transform 0.15s' }}>▶</span>
                SQL + cost details
              </summary>
              <div style={{ paddingTop: 8, paddingBottom: 8 }}>
                <ProvenanceContent envelope={envelope} />
              </div>
            </details>
          )}
        </div>
      )}

      {/* Next actions */}
      {!envelope.requiresConfirmation && envelope.nextActions.length > 0 && (
        <div style={{
          padding: '12px 20px 16px',
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          borderTop: '1px solid var(--border-subtle)',
        }}>
          {envelope.nextActions.slice(0, 5).map((action, i) => (
            <button
              key={i}
              className="chip"
              onClick={() => onChipClick?.(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      {/* Fallback: no next actions and not a confirmation — offer to suggest */}
      {!envelope.requiresConfirmation && envelope.nextActions.length === 0 && (
        <div style={{
          padding: '8px 20px 12px',
          borderTop: '1px solid var(--border-subtle)',
        }}>
          <button
            className="chip"
            style={{ opacity: 0.7, fontSize: 11 }}
            onClick={() => handleInlineClick('What can I do next with these results?')}
          >
            Suggest next steps →
          </button>
        </div>
      )}
    </div>
  );
}

function Artifact({
  envelope,
  onConfirm,
  onCancel,
  onSendMessage,
}: {
  envelope: CompositionEnvelope;
  onConfirm?: () => void;
  onCancel?: () => void;
  onSendMessage: (msg: string) => void;
}) {
  const { type, data } = envelope.primaryArtifact;

  switch (type) {
    case 'SCHEMA_VIEW':
      return <SchemaView result={data as import('@/lib/types').SchemaResult} onSendMessage={onSendMessage} />;
    case 'TABLE':
      return <DataTable result={data as import('@/lib/types').QueryResult} onSendMessage={onSendMessage} />;
    case 'LINE_CHART':
    case 'BAR_CHART':
    case 'AREA_CHART':
    case 'SCATTER':
    case 'PIE_CHART':
      return <ChartWithToggle result={data as import('@/lib/types').QueryResult} chartType={type} onSendMessage={onSendMessage} />;
    case 'KPI_CARD':
      return <KpiCard result={data as import('@/lib/types').QueryResult} />;
    case 'CONFIRMATION_CARD':
      return <ConfirmationCard result={data as import('@/lib/types').DataManagementConfirmResult} onConfirm={onConfirm} onCancel={onCancel} />;
    case 'COMPLETION_CARD':
      return <CompletionCard result={data as import('@/lib/types').DataManagementCompleteResult} />;
    case 'COST_CONFIRM_CARD':
      return <CostConfirmCard result={data as import('@/lib/types').CostEstimate} onConfirm={onConfirm} onCancel={onCancel} />;
    case 'DISCOVERY_VIEW':
      return <DiscoveryView result={data as import('@/lib/types').DiscoveryResult} onSendMessage={onSendMessage} />;
    case 'DATA_QUALITY_VIEW':
      return <DataQualityView result={data as import('@/lib/types').DataQualityResult} onSendMessage={onSendMessage} />;
    case 'MONITORING_VIEW':
      return <MonitoringView result={data as import('@/lib/types').MonitoringResult} onSendMessage={onSendMessage} />;
    case 'DATA_LOADING_VIEW':
      return <DataLoadingView result={data as import('@/lib/types').DataLoadingResult} />;
    case 'MULTISTEP_VIEW':
      return <MultistepView envelope={envelope} onSendMessage={onSendMessage} />;
    default:
      return (
        <pre style={{ fontSize: 11, color: 'var(--text-muted)', overflowX: 'auto' }}>
          {JSON.stringify(data, null, 2)}
        </pre>
      );
  }
}

// ─── Chart ↔ Table toggle ─────────────────────────────────────────────────
type ChartToggleType = 'LINE_CHART' | 'BAR_CHART' | 'AREA_CHART' | 'SCATTER' | 'PIE_CHART';

function ChartWithToggle({
  result,
  chartType,
  onSendMessage,
}: {
  result: import('@/lib/types').QueryResult;
  chartType: ChartToggleType;
  onSendMessage: (msg: string) => void;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Toggle pill */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div
          style={{
            display: 'inline-flex',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 20,
            padding: 2,
            gap: 2,
          }}
        >
          {(['chart', 'table'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                padding: '3px 12px',
                borderRadius: 16,
                fontSize: 11,
                fontWeight: 500,
                border: 'none',
                cursor: 'pointer',
                transition: 'background 0.15s, color 0.15s',
                background: view === v ? 'var(--accent, #4f7fff)' : 'transparent',
                color: view === v ? '#fff' : 'var(--text-muted)',
              }}
            >
              {v === 'chart' ? '▲ Chart' : '⊞ Table'}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      {view === 'chart' ? (
        <ChartView result={result} chartType={chartType} onSendMessage={onSendMessage} />
      ) : (
        <DataTable result={result} onSendMessage={onSendMessage} />
      )}
    </div>
  );
}

function ProvenanceContent({ envelope }: { envelope: CompositionEnvelope }) {
  const { sql, cost, freshness } = envelope.provenance;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {cost && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 16 }}>
          <span>{formatBytes(cost.totalBytesProcessed)} processed</span>
          <span>Tier {cost.tier}</span>
          {freshness && <span>{freshness}</span>}
        </div>
      )}
      {sql && <div className="sql-block">{sql}</div>}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_099_511_627_776) return `${(bytes / 1_099_511_627_776).toFixed(1)} TB`;
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  return `${bytes} bytes`;
}
