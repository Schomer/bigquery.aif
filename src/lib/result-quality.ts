// src/lib/result-quality.ts
// Heuristic data quality checks on query result sets.
// Pure functions, no model calls. Runs after BigQuery execution
// to surface data quality issues as dismissible UI annotations
// and context-aware next-action chips.

import type { SkillName } from './types';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface QualityFlag {
  type: 'NULL_RATE' | 'CATEGORICAL_NEAR_DUPES' | 'LOW_ROW_COUNT' | 'SINGLE_VALUE_COLUMN';
  severity: 'info' | 'warning';
  message: string;
  column?: string;
  suggestedAction?: {
    label: string;
    skill: SkillName;
    context: Record<string, unknown>;
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const NULL_RATE_THRESHOLD = 0.20;       // Flag columns with >20% nulls
const CATEGORICAL_MAX_DISTINCT = 50;    // Only check near-dupes for low-cardinality columns
const MIN_ROWS_FOR_ANALYSIS = 3;        // Don't analyze tiny result sets

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract column names that appear in WHERE clauses of the SQL. */
function extractWhereColumns(sql: string): Set<string> {
  const cols = new Set<string>();
  // Match patterns like: WHERE col = ..., AND col = ..., OR col = ...
  const whereMatch = sql.match(/\bWHERE\b([\s\S]*?)(?:\bGROUP\b|\bORDER\b|\bLIMIT\b|\bHAVING\b|$)/i);
  if (!whereMatch) return cols;
  const whereClause = whereMatch[1];
  // Extract column names before comparison operators
  const colMatches = whereClause.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=|!=|<>|<|>|<=|>=|LIKE|IN\s*\(|IS\s+(?:NOT\s+)?NULL|BETWEEN)/gi);
  for (const m of colMatches) {
    cols.add(m[1].toLowerCase());
  }
  return cols;
}

/** Normalize a string value for near-duplicate detection. */
function normalize(val: string): string {
  return val.trim().toLowerCase().replace(/[_\-\s]+/g, ' ');
}

// ─── Analysis functions ──────────────────────────────────────────────────────

function checkNullRates(
  columns: string[],
  rows: unknown[][],
  sql: string,
): QualityFlag[] {
  const flags: QualityFlag[] = [];
  const totalRows = rows.length;
  if (totalRows < MIN_ROWS_FOR_ANALYSIS) return flags;

  // Extract table name from SQL for action chips
  const tableMatch = sql.match(/`([^`]+\.[^`]+\.[^`]+)`/);
  const tableName = tableMatch ? tableMatch[1] : undefined;

  for (let colIdx = 0; colIdx < columns.length; colIdx++) {
    let nullCount = 0;
    for (const row of rows) {
      const val = row[colIdx];
      if (val === null || val === undefined || val === '') {
        nullCount++;
      }
    }
    const rate = nullCount / totalRows;
    if (rate > NULL_RATE_THRESHOLD) {
      const pct = Math.round(rate * 100);
      const flag: QualityFlag = {
        type: 'NULL_RATE',
        severity: rate > 0.5 ? 'warning' : 'info',
        message: `Column "${columns[colIdx]}" has ${pct}% null/empty values (${nullCount} of ${totalRows} rows)`,
        column: columns[colIdx],
      };
      if (tableName) {
        flag.suggestedAction = {
          label: `Fill nulls in ${columns[colIdx]}`,
          skill: 'data-management',
          context: { table: tableName, column: columns[colIdx], operationHint: 'FILL_NULLS' },
        };
      }
      flags.push(flag);
    }
  }
  return flags;
}

function checkCategoricalNearDupes(
  columns: string[],
  rows: unknown[][],
  sql: string,
): QualityFlag[] {
  const flags: QualityFlag[] = [];
  if (rows.length < MIN_ROWS_FOR_ANALYSIS) return flags;

  const tableMatch = sql.match(/`([^`]+\.[^`]+\.[^`]+)`/);
  const tableName = tableMatch ? tableMatch[1] : undefined;

  for (let colIdx = 0; colIdx < columns.length; colIdx++) {
    // Collect distinct string values
    const valueMap = new Map<string, string[]>(); // normalized -> [original values]
    let isStringCol = false;
    let distinctCount = 0;

    for (const row of rows) {
      const val = row[colIdx];
      if (typeof val !== 'string' || val === '') continue;
      isStringCol = true;

      const norm = normalize(val);
      if (!valueMap.has(norm)) {
        valueMap.set(norm, []);
        distinctCount++;
      }
      const originals = valueMap.get(norm)!;
      if (!originals.includes(val)) {
        originals.push(val);
      }
    }

    if (!isStringCol || distinctCount > CATEGORICAL_MAX_DISTINCT) continue;

    // Find normalized keys that map to multiple original values
    const nearDupes: Array<{ normalized: string; variants: string[] }> = [];
    for (const [norm, originals] of valueMap) {
      if (originals.length > 1) {
        nearDupes.push({ normalized: norm, variants: originals });
      }
    }

    if (nearDupes.length > 0) {
      const examples = nearDupes
        .slice(0, 3)
        .map((d) => d.variants.map((v) => `"${v}"`).join(' / '))
        .join('; ');
      const flag: QualityFlag = {
        type: 'CATEGORICAL_NEAR_DUPES',
        severity: 'warning',
        message: `Column "${columns[colIdx]}" has inconsistent values that may be duplicates: ${examples}`,
        column: columns[colIdx],
      };
      if (tableName) {
        flag.suggestedAction = {
          label: `Standardize ${columns[colIdx]} values`,
          skill: 'data-management',
          context: { table: tableName, column: columns[colIdx], operationHint: 'UPDATE', nearDupes },
        };
      }
      flags.push(flag);
    }
  }
  return flags;
}

function checkLowRowCount(
  rows: unknown[][],
  sql: string,
): QualityFlag[] {
  const flags: QualityFlag[] = [];
  if (rows.length === 0) {
    const tableMatch = sql.match(/`([^`]+\.[^`]+\.[^`]+)`/);
    const tableName = tableMatch ? tableMatch[1] : undefined;
    const flag: QualityFlag = {
      type: 'LOW_ROW_COUNT',
      severity: 'info',
      message: 'Query returned 0 rows. The table may be empty or the filter may be too restrictive.',
    };
    if (tableName) {
      flag.suggestedAction = {
        label: `Check if ${tableName.split('.').pop()} has data`,
        skill: 'query',
        context: { table: tableName },
      };
    }
    flags.push(flag);
  }
  return flags;
}

function checkSingleValueColumns(
  columns: string[],
  rows: unknown[][],
  sql: string,
): QualityFlag[] {
  const flags: QualityFlag[] = [];
  if (rows.length < MIN_ROWS_FOR_ANALYSIS) return flags;

  // Columns that appear in WHERE clauses are expected to have a single value
  // (the user filtered on them), so don't flag those.
  const whereColumns = extractWhereColumns(sql);

  for (let colIdx = 0; colIdx < columns.length; colIdx++) {
    const colName = columns[colIdx];

    // Skip columns that appear in a WHERE clause -- single value is expected
    if (whereColumns.has(colName.toLowerCase())) continue;

    const firstNonNull = rows.find((r) => r[colIdx] !== null && r[colIdx] !== undefined)?.[colIdx];
    if (firstNonNull === undefined) continue; // all nulls, already caught by null check

    const allSame = rows.every((r) => {
      const val = r[colIdx];
      if (val === null || val === undefined) return true; // ignore nulls
      return String(val) === String(firstNonNull);
    });

    if (allSame) {
      flags.push({
        type: 'SINGLE_VALUE_COLUMN',
        severity: 'info',
        message: `Column "${colName}" has the same value ("${String(firstNonNull).slice(0, 40)}") in every row`,
        column: colName,
      });
    }
  }
  return flags;
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Analyze a query result set for data quality issues.
 * Returns an array of quality flags (may be empty if data is clean).
 * This is intentionally cheap -- no model calls, just heuristic rules.
 */
export function analyzeResultQuality(
  columns: string[],
  rows: unknown[][],
  sql: string,
): QualityFlag[] {
  if (!columns.length || !rows.length) {
    // Still check for zero rows
    return checkLowRowCount(rows, sql);
  }

  const flags: QualityFlag[] = [
    ...checkNullRates(columns, rows, sql),
    ...checkCategoricalNearDupes(columns, rows, sql),
    ...checkLowRowCount(rows, sql),
    ...checkSingleValueColumns(columns, rows, sql),
  ];

  // Cap at 5 flags to avoid overwhelming the UI
  return flags.slice(0, 5);
}
