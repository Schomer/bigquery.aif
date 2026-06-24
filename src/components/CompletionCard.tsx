'use client';

import type { DataManagementCompleteResult } from '@/lib/types';

interface Props { result: DataManagementCompleteResult; }

const CREATION_OPERATIONS = ['CREATE_TABLE', 'CREATE_VIEW', 'CREATE_SCHEMA', 'COPY_TABLE', 'RENAME'];

export function CompletionCard({ result }: Props) {
  const isCreation = CREATION_OPERATIONS.includes(result.operation);

  if (isCreation) {
    return (
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {result.completionMessage && (
          <Metric label="Result" value={result.completionMessage} color="var(--positive)" />
        )}
        {result.jobId && (
          <Metric label="Job ID" value={result.jobId} color="var(--text-dim)" mono />
        )}
      </div>
    );
  }

  // Mutation operations (DELETE, UPDATE, DEDUPE, etc.)
  const rowLabel = result.operation === 'DEDUPE' ? 'Rows removed' : 'Rows affected';

  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <Metric
        label={rowLabel}
        value={result.rowsAffected.toLocaleString()}
        color={result.mismatch ? 'var(--attention)' : 'var(--positive)'}
      />
      {result.mismatch && (
        <Metric label="Rows expected" value={result.rowsExpected.toLocaleString()} color="var(--text-muted)" />
      )}
      {result.jobId && (
        <Metric label="Job ID" value={result.jobId} color="var(--text-dim)" mono />
      )}
    </div>
  );
}

function Metric({ label, value, color, mono }: { label: string; value: string; color: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      <span style={{ fontSize: 20, fontWeight: 700, color, fontFamily: mono ? 'var(--font-mono)' : 'inherit', letterSpacing: mono ? -0.5 : undefined }}>{value}</span>
    </div>
  );
}
