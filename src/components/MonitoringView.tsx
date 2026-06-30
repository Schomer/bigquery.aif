'use client';

import type { MonitoringResult, MonitoringJob } from '@/lib/types';
import { useState } from 'react';

interface Props {
  result: MonitoringResult;
  onSendMessage?: (msg: string) => void;
}

export function MonitoringView({ result, onSendMessage }: Props) {
  const send = onSendMessage ?? (() => {});
  const { summary, items } = result;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Summary stats */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <Stat label="Total jobs" value={summary.totalJobs.toLocaleString()} />
        <Stat label="Data processed" value={formatBytes(summary.totalBytesProcessed)} />
        <Stat
          label="Errors"
          value={summary.errorCount.toLocaleString()}
          highlight={summary.errorCount > 0}
        />
      </div>

      {/* Jobs table */}
      {items.length === 0 ? (
        <div style={{
          padding: '24px 0',
          textAlign: 'center',
          color: 'var(--text-dim)',
          fontSize: 13,
        }}>
          No recent jobs found
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Status', 'User', 'Type', 'Bytes', 'Created', ''].map((h) => (
                  <th key={h} style={{
                    padding: '6px 12px',
                    textAlign: 'left',
                    color: 'var(--text-muted)',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((job) => (
                <JobRow key={job.jobId} job={job} onSendMessage={send} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function JobRow({ job, onSendMessage }: { job: MonitoringJob; onSendMessage: (msg: string) => void }) {
  const [hovered, setHovered] = useState(false);
  const isError = job.status === 'ERROR';

  function handleClick() {
    if (isError) {
      onSendMessage(`Diagnose the failed BigQuery job ${job.jobId}. What went wrong?`);
    } else {
      onSendMessage(`Tell me more about job ${job.jobId}`);
    }
  }

  return (
    <tr
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={isError ? 'Click to diagnose this failure' : 'Click to view job details'}
      style={{
        borderBottom: '1px solid var(--border-subtle)',
        background: hovered
          ? 'var(--accent-dim)'
          : isError ? 'rgba(220,53,69,0.06)' : undefined,
        cursor: 'pointer',
        transition: 'background 0.1s',
      }}
    >
      <td style={{ padding: '7px 12px', whiteSpace: 'nowrap' }}>
        <StatusBadge status={job.status} />
      </td>
      <td style={{ padding: '7px 12px', color: 'var(--text)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {job.userEmail}
      </td>
      <td style={{ padding: '7px 12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        {job.statementType || '—'}
      </td>
      <td style={{ padding: '7px 12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11, whiteSpace: 'nowrap' }}>
        {formatBytes(job.totalBytesProcessed)}
      </td>
      <td style={{ padding: '7px 12px', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
        {relativeTime(job.createTime)}
      </td>
      <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>
        {hovered && (
          <span style={{ fontSize: 11, color: isError ? '#dc3545' : 'var(--accent)' }}>
            {isError ? 'Diagnose →' : 'Details →'}
          </span>
        )}
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: MonitoringJob['status'] }) {
  const config: Record<MonitoringJob['status'], { symbol: string; color: string; label: string }> = {
    DONE:    { symbol: 'OK', color: 'var(--positive)',  label: 'DONE' },
    RUNNING: { symbol: '~',  color: 'var(--accent)',    label: 'RUNNING' },
    ERROR:   { symbol: 'X',  color: '#dc3545',          label: 'ERROR' },
  };
  const { symbol, color, label } = config[status];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color, fontWeight: 500 }}>
      <span style={{ fontSize: 13 }}>{symbol}</span>
      <span style={{ fontSize: 11 }}>{label}</span>
    </span>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </span>
      <span style={{
        fontSize: 12,
        color: highlight ? '#dc3545' : 'var(--text)',
        fontFamily: 'var(--font-mono)',
        fontWeight: 500,
      }}>
        {value}
      </span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 bytes';
  if (bytes >= 1_099_511_627_776) return `${(bytes / 1_099_511_627_776).toFixed(1)} TB`;
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  return `${bytes} bytes`;
}

function relativeTime(iso: string): string {
  try {
    const ts = new Date(iso).getTime();
    if (isNaN(ts)) return iso || '---';
    const diffMs = Date.now() - ts;
    if (diffMs < 0) return 'just now';
    const secs = Math.floor(diffMs / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch {
    return iso || '---';
  }
}
