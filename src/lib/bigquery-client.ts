// src/lib/bigquery-client.ts
// Client-side BigQuery REST API calls using the user's OAuth access token.

import { getAccessToken } from './gis-auth';
import type { CostEstimate, CostTier } from './types';

const BQ_BASE = 'https://bigquery.googleapis.com/bigquery/v2/projects';

// ─── Cost tiers ───────────────────────────────────────────────────────────────

function classifyTier(bytes: number): CostTier {
  if (bytes <= 0) return 0;
  const mb = bytes / (1024 * 1024);
  if (mb < 10) return 1;
  if (mb < 500) return 2;
  if (mb < 5000) return 3;
  return 4;
}

// ─── Shared fetch helper ──────────────────────────────────────────────────────

async function bqFetch(url: string, init?: RequestInit): Promise<any> {
  const token = getAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    const msg = data?.error?.message || data?.error || `HTTP ${res.status}`;
    checkAuthError(res.status, data);
    throw new Error(String(msg));
  }
  return data;
}

function checkAuthError(status: number, data: any) {
  const errMsg = data?.error?.message ? String(data.error.message).toLowerCase() : '';
  const isAuth =
    status === 401 ||
    errMsg.includes('invalid authentication credentials') ||
    errMsg.includes('unauthenticated') ||
    errMsg.includes('oauth 2 access token');
  if (isAuth) {
    handleAuthError();
  }
}

export function handleAuthError() {
  if (typeof window !== 'undefined') {
    window.location.href = '/';
  }
}

// ─── Parse BigQuery query response into flat rows ─────────────────────────────

function parseQueryResponse(data: any): {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  jobId: string;
} {
  const fields = data.schema?.fields ?? [];
  const columns = fields.map((f: any) => f.name);
  const rawRows = data.rows ?? [];
  const rows = rawRows.map((r: any) =>
    (r.f ?? []).map((cell: any) => cell.v ?? null)
  );
  return {
    columns,
    rows,
    rowCount: parseInt(data.totalRows ?? '0', 10),
    jobId: data.jobReference?.jobId ?? '',
  };
}

// ─── Cost dry-run ─────────────────────────────────────────────────────────────

export interface DryRunResult {
  totalBytesProcessed: number;
  tier: CostTier;
  requiresConfirmation: boolean;
}

export async function dryRun(sql: string, project?: string): Promise<DryRunResult> {
  const projectId = project || '';
  try {
    const data = await bqFetch(`${BQ_BASE}/${encodeURIComponent(projectId)}/jobs`, {
      method: 'POST',
      body: JSON.stringify({
        configuration: {
          query: {
            query: sql,
            useLegacySql: false,
            dryRun: true,
          },
        },
      }),
    });
    const bytes = parseInt(data.statistics?.query?.totalBytesProcessed ?? '0', 10);
    const tier = classifyTier(bytes);
    return {
      totalBytesProcessed: bytes,
      tier,
      requiresConfirmation: tier >= 3,
    };
  } catch (err: unknown) {
    throw new Error(`BigQuery dry run failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Query execution ──────────────────────────────────────────────────────────

export interface QueryExecuteResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  jobId: string;
}

export async function executeQuery(sql: string, project?: string): Promise<QueryExecuteResult> {
  const projectId = project || '';
  try {
    const data = await bqFetch(`${BQ_BASE}/${encodeURIComponent(projectId)}/queries`, {
      method: 'POST',
      body: JSON.stringify({
        query: sql,
        useLegacySql: false,
        maxResults: 1000,
      }),
    });
    return parseQueryResponse(data);
  } catch (err: unknown) {
    throw new Error(`BigQuery query failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── DML execution ────────────────────────────────────────────────────────────

export interface DmlResult {
  rowsAffected: number;
  jobId: string;
}

export async function executeDml(sql: string, project?: string): Promise<DmlResult> {
  const projectId = project || '';
  try {
    const data = await bqFetch(`${BQ_BASE}/${encodeURIComponent(projectId)}/jobs`, {
      method: 'POST',
      body: JSON.stringify({
        configuration: {
          query: {
            query: sql,
            useLegacySql: false,
          },
        },
      }),
    });
    // Poll for completion if needed
    let job = data;
    const jobId = job.jobReference?.jobId ?? '';
    while (job.status?.state !== 'DONE') {
      await new Promise((r) => setTimeout(r, 1000));
      job = await bqFetch(
        `${BQ_BASE}/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}`
      );
    }
    if (job.status?.errors?.length) {
      throw new Error(job.status.errors[0].message);
    }
    const affected = parseInt(job.statistics?.query?.numDmlAffectedRows ?? '0', 10);
    return { rowsAffected: affected, jobId };
  } catch (err: unknown) {
    throw new Error(`BigQuery DML failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function buildCostEstimate(dr: DryRunResult): CostEstimate {
  return {
    totalBytesProcessed: dr.totalBytesProcessed,
    tier: dr.tier,
    requiresConfirmation: dr.requiresConfirmation,
  };
}

export { getAccessToken } from './gis-auth';


export function checkResponse(res: Response, data: any) {
  checkAuthError(res.status, data);
}
