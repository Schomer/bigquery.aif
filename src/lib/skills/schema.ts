// src/lib/skills/schema.ts
// Client-side schema skill using direct BigQuery REST API calls.

import { getAccessToken } from '../gis-auth';
import {
  getCacheKey,
  getFromCache,
  setInCache,
} from '../schema-cache';
import type { SchemaResult, SchemaColumn } from '../types';

const BQ_BASE = 'https://bigquery.googleapis.com/bigquery/v2/projects';

async function bqGet(url: string): Promise<any> {
  const token = getAccessToken();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data?.error?.message || `HTTP ${res.status}`);
  }
  return data;
}

async function bqQuery(sql: string, project: string): Promise<{ columns: string[]; rows: any[][] }> {
  const token = getAccessToken();
  const res = await fetch(`${BQ_BASE}/${encodeURIComponent(project)}/queries`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: sql,
      useLegacySql: false,
      maxResults: 1000,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data?.error?.message || `HTTP ${res.status}`);
  }
  const fields = data.schema?.fields ?? [];
  const columns = fields.map((f: any) => f.name);
  const rawRows = data.rows ?? [];
  const rows = rawRows.map((r: any) =>
    (r.f ?? []).map((cell: any) => cell.v ?? null)
  );
  return { columns, rows };
}

async function resolveDefaultDatasetForProject(project: string): Promise<string> {
  try {
    const data = await bqGet(`${BQ_BASE}/${encodeURIComponent(project)}/datasets`);
    const datasets = data.datasets || [];
    if (datasets.length > 0) {
      return datasets[0].datasetReference?.datasetId || '';
    }
  } catch {}
  return '';
}

// ─── Public entrypoint ────────────────────────────────────────────────────────

export async function fetchSchema(
  dataset?: string,
  table?: string,
  projectOverride?: string,
): Promise<SchemaResult> {
  const PROJ = projectOverride || '';

  // Guard against confusing project name with dataset name
  let resolvedDataset = dataset;
  if (resolvedDataset && PROJ && resolvedDataset.toLowerCase() === PROJ.toLowerCase()) {
    resolvedDataset = table ? await resolveDefaultDatasetForProject(PROJ) : undefined;
  }

  const key = getCacheKey(PROJ, resolvedDataset, table);
  const cached = getFromCache(key);
  if (cached) return cached;

  let result: SchemaResult;

  if (table && resolvedDataset) {
    result = await fetchTableSchema(PROJ, resolvedDataset, table);
  } else if (resolvedDataset) {
    result = await fetchDatasetSchema(PROJ, resolvedDataset);
  } else {
    result = await fetchProjectSchema(PROJ);
  }

  setInCache(key, result);
  return result;
}

// ─── Project-level: list all datasets ─────────────────────────────────────────

async function fetchProjectSchema(project: string): Promise<SchemaResult> {
  const data = await bqGet(`${BQ_BASE}/${encodeURIComponent(project)}/datasets`);

  const datasets = data.datasets || [];
  const columns: SchemaColumn[] = datasets.map((ds: any) => ({
    name: ds.datasetReference?.datasetId ?? '',
    type: 'DATASET',
    mode: 'NULLABLE' as const,
    description: null,
    fields: [],
  }));

  return {
    skill: 'schema', scope: 'PROJECT', project, dataset: null, table: null,
    columns, tableConstraints: { primaryKey: [], foreignKeys: [] },
    fetchedAt: new Date().toISOString(),
  };
}

// ─── Dataset-level: list all tables ───────────────────────────────────────────

async function fetchDatasetSchema(project: string, dataset: string): Promise<SchemaResult> {
  const data = await bqGet(
    `${BQ_BASE}/${encodeURIComponent(project)}/datasets/${encodeURIComponent(dataset)}/tables`
  );

  const tables = data.tables || [];
  const columns: SchemaColumn[] = tables.map((t: any) => ({
    name: t.tableReference?.tableId ?? '',
    type: t.type ?? 'TABLE',
    mode: 'NULLABLE' as const,
    description: t.friendlyName || null,
    fields: [],
    rowCount: t.numRows ? parseInt(t.numRows, 10) : null,
    sizeBytes: t.numBytes ? parseInt(t.numBytes, 10) : null,
    creationTime: t.creationTime
      ? new Date(parseInt(t.creationTime, 10)).toISOString()
      : null,
  }));

  return {
    skill: 'schema', scope: 'DATASET', project, dataset, table: null,
    columns, tableConstraints: { primaryKey: [], foreignKeys: [] },
    fetchedAt: new Date().toISOString(),
  };
}

// ─── Table-level: full schema ─────────────────────────────────────────────────

async function fetchTableSchema(
  project: string,
  dataset: string,
  table: string,
): Promise<SchemaResult> {
  const data = await bqGet(
    `${BQ_BASE}/${encodeURIComponent(project)}/datasets/${encodeURIComponent(dataset)}/tables/${encodeURIComponent(table)}`
  );

  const schema = data.schema || {};
  const columns = (schema.fields ?? []).map(mapField);

  const constraints = await fetchTableConstraints(project, dataset, table);

  const partitioning = data.timePartitioning
    ? { field: data.timePartitioning.field ?? '_PARTITIONTIME', type: data.timePartitioning.type ?? 'DAY' }
    : data.rangePartitioning
      ? { field: data.rangePartitioning.field ?? '', type: 'RANGE' }
      : null;

  return {
    skill: 'schema', scope: 'TABLE', project, dataset, table,
    description: data.description ?? null,
    type: data.type ?? 'TABLE',
    columns,
    partitioning,
    clustering: data.clustering?.fields ?? null,
    rowCount: data.numRows ? parseInt(data.numRows, 10) : null,
    sizeBytes: data.numBytes ? parseInt(data.numBytes, 10) : null,
    lastModifiedTime: data.lastModifiedTime
      ? new Date(parseInt(data.lastModifiedTime, 10)).toISOString()
      : null,
    tableConstraints: constraints,
    fetchedAt: new Date().toISOString(),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapField(field: {
  name: string;
  type: string;
  mode?: string;
  description?: string;
  fields?: unknown[];
}): SchemaColumn {
  return {
    name: field.name,
    type: field.type,
    mode: (field.mode as SchemaColumn['mode']) ?? 'NULLABLE',
    description: field.description ?? null,
    fields: (field.fields ?? []).map((f) =>
      mapField(f as Parameters<typeof mapField>[0])
    ),
  };
}

async function fetchTableConstraints(
  project: string,
  dataset: string,
  table: string,
): Promise<SchemaResult['tableConstraints']> {
  try {
    const query = `
      SELECT
        tc.CONSTRAINT_TYPE,
        kcu.COLUMN_NAME,
        ccu.TABLE_CATALOG AS ref_project,
        ccu.TABLE_SCHEMA  AS ref_dataset,
        ccu.TABLE_NAME    AS ref_table,
        ccu.COLUMN_NAME   AS ref_column
      FROM \`${project}.${dataset}\`.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      LEFT JOIN \`${project}.${dataset}\`.INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      LEFT JOIN \`${project}.${dataset}\`.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu
        ON tc.CONSTRAINT_NAME = ccu.CONSTRAINT_NAME
        AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
      WHERE tc.TABLE_NAME = '${table}'
      ORDER BY tc.CONSTRAINT_TYPE, kcu.ORDINAL_POSITION
    `;

    const { columns: cols, rows } = await bqQuery(query, project);
    const getVal = (row: any[], fieldName: string) => {
      const idx = cols.indexOf(fieldName);
      return idx !== -1 ? row[idx] : null;
    };

    const primaryKey: string[] = [];
    const foreignKeyMap = new Map<
      string,
      { columns: string[]; refTable: string; refColumns: string[] }
    >();

    for (const row of rows) {
      const constraintType = getVal(row, 'CONSTRAINT_TYPE');
      const columnName = getVal(row, 'COLUMN_NAME');
      const refProject = getVal(row, 'ref_project');
      const refDataset = getVal(row, 'ref_dataset');
      const refTable = getVal(row, 'ref_table');
      const refColumn = getVal(row, 'ref_column');

      if (constraintType === 'PRIMARY KEY' && columnName) {
        primaryKey.push(columnName);
      } else if (constraintType === 'FOREIGN KEY' && columnName) {
        const fullRefTable = `${refProject}.${refDataset}.${refTable}`;
        const existing = foreignKeyMap.get(fullRefTable) ?? {
          columns: [],
          refTable: fullRefTable,
          refColumns: [],
        };
        existing.columns.push(columnName);
        if (refColumn) existing.refColumns.push(refColumn);
        foreignKeyMap.set(fullRefTable, existing);
      }
    }

    return {
      primaryKey,
      foreignKeys: Array.from(foreignKeyMap.values()).map((fk) => ({
        columns: fk.columns,
        referencedTable: fk.refTable,
        referencedColumns: fk.refColumns,
      })),
    };
  } catch {
    // INFORMATION_SCHEMA may not be accessible -- return empty gracefully
    return { primaryKey: [], foreignKeys: [] };
  }
}
