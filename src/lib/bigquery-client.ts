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

// ─── Google Sheets export ─────────────────────────────────────────────────────

export async function exportToSheets(
  title: string,
  columns: string[],
  rows: unknown[][],
): Promise<{ spreadsheetUrl: string }> {
  const totalCells = columns.length * (rows.length + 1);
  if (totalCells > 10_000_000) {
    throw new Error(`Result exceeds the 10 million cell limit for Google Sheets (${totalCells.toLocaleString()} cells). Use CSV export instead.`);
  }

  const token = getAccessToken();
  if (!token) throw new Error('Not authenticated. Please sign in again.');

  // Create a new spreadsheet
  const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      properties: { title },
      sheets: [{ properties: { title: 'Query Results' } }],
    }),
  });
  const createData = await createRes.json();
  if (!createRes.ok) {
    const msg = createData?.error?.message || `HTTP ${createRes.status}`;
    throw new Error(`Failed to create spreadsheet: ${msg}`);
  }

  const spreadsheetId = createData.spreadsheetId;
  const spreadsheetUrl = createData.spreadsheetUrl;

  // Write data: header row + data rows
  const values = [
    columns,
    ...rows.map((row) => row.map((cell) => {
      if (cell === null || cell === undefined) return '';
      if (typeof cell === 'object') return JSON.stringify(cell);
      return cell;
    })),
  ];

  const writeRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Query%20Results!A1?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ range: 'Query Results!A1', values }),
    },
  );
  if (!writeRes.ok) {
    const writeData = await writeRes.json();
    throw new Error(`Failed to write data to spreadsheet: ${writeData?.error?.message || `HTTP ${writeRes.status}`}`);
  }

  return { spreadsheetUrl };
}

// ─── Scheduled Query ──────────────────────────────────────────────────────────

export async function createScheduledQuery(
  project: string,
  displayName: string,
  sql: string,
  schedule: string,
  enableFailureEmail?: boolean,
): Promise<{ transferConfigName: string }> {
  const token = getAccessToken();
  if (!token) throw new Error('Not authenticated. Please sign in again.');

  const url = `https://bigquerydatatransfer.googleapis.com/v1/projects/${project}/locations/us/transferConfigs`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      dataSourceId: 'scheduled_query',
      displayName,
      schedule,
      params: { query: sql },
      ...(enableFailureEmail ? { emailPreferences: { enableFailureEmail: true } } : {}),
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Failed to create scheduled query: ${msg}`);
  }

  return { transferConfigName: data.name || displayName };
}
