'use client';
import React, { useState } from 'react';
import type { AlertResult } from '../lib/types';

interface AlertViewProps {
  data: AlertResult;
  onAction?: (action: string) => void;
}

export default function AlertView({ data, onAction }: AlertViewProps) {
  const [sqlExpanded, setSqlExpanded] = useState(false);

  const categoryLabels: Record<string, string> = {
    PROJECT_WIDE: 'Project-Wide Alert',
    JOB_SPECIFIC: 'Job-Specific Check',
    DATA_CONDITION: 'Data Condition Check',
  };

  const categoryColors: Record<string, string> = {
    PROJECT_WIDE: '#6366f1',
    JOB_SPECIFIC: '#0ea5e9',
    DATA_CONDITION: '#f59e0b',
  };

  return (
    <div style={{ padding: '16px 0' }}>
      {/* Category badge */}
      <div style={{ marginBottom: 12 }}>
        <span style={{
          display: 'inline-block',
          padding: '3px 10px',
          borderRadius: 4,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
          color: '#fff',
          background: categoryColors[data.alertCategory] || 'var(--accent)',
        }}>
          {categoryLabels[data.alertCategory] || data.alertCategory}
        </span>
      </div>

      {/* Condition description */}
      <h3 style={{
        margin: '0 0 12px',
        fontSize: 15,
        fontWeight: 600,
        color: 'var(--text)',
        lineHeight: 1.4,
      }}>
        {data.conditionDescription}
      </h3>

      {/* Guidance */}
      {data.guidance && (
        <div style={{
          padding: '12px 16px',
          borderRadius: 8,
          background: 'var(--accent-dim, rgba(66,133,244,0.08))',
          border: '1px solid var(--border-subtle)',
          fontSize: 13,
          lineHeight: 1.6,
          color: 'var(--text)',
          whiteSpace: 'pre-wrap',
          marginBottom: 16,
        }}>
          {data.guidance}
        </div>
      )}

      {/* Check SQL (collapsible) */}
      {data.checkSql && (
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={() => setSqlExpanded(!sqlExpanded)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--text-muted)',
              padding: '4px 0',
            }}
          >
            <span style={{ transform: sqlExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
              &#9654;
            </span>
            Check SQL
          </button>
          {sqlExpanded && (
            <pre style={{
              padding: '12px 16px',
              borderRadius: 8,
              background: 'var(--bg-code, #f5f5f5)',
              border: '1px solid var(--border-subtle)',
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              lineHeight: 1.5,
              overflow: 'auto',
              margin: '8px 0 0',
            }}>
              {data.checkSql}
            </pre>
          )}
        </div>
      )}

      {/* Action chips */}
      {data.nextActions && data.nextActions.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {data.nextActions.map((action, i) => (
            <button
              key={i}
              onClick={() => onAction?.(action.action)}
              style={{
                padding: '6px 14px',
                borderRadius: 18,
                border: '1px solid var(--accent, #4285f4)',
                background: 'transparent',
                color: 'var(--accent, #4285f4)',
                fontSize: 13,
                cursor: 'pointer',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-dim, rgba(66,133,244,0.08))')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
