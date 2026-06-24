// src/lib/preview-client.ts
// Client-side table preview helper executing queries directly from the browser.

import { executeQuery } from './bigquery-client';
import type { PreviewResponse, PreviewColumn } from './types';

export async function fetchTablePreview(
  tableRef: string,
  columns: Array<{ name: string; type: string }>,
  project?: string
): Promise<PreviewResponse> {
  const sampleSql = `SELECT * FROM \`${tableRef}\` LIMIT 20`;

  // Build a single-pass profile query with per-column aggregations
  const profileSelects = columns.map((col) => {
    const q = `\`${col.name}\``;
    const isNumeric = ['INTEGER', 'INT64', 'FLOAT', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC'].includes(col.type.toUpperCase());
    const isString = ['STRING', 'BYTES'].includes(col.type.toUpperCase());

    const noDistinctTypes = ['GEOGRAPHY', 'STRUCT', 'RECORD', 'ARRAY', 'JSON'];
    const supportsDistinct = !noDistinctTypes.includes(col.type.toUpperCase());

    const parts: string[] = [
      `COUNTIF(${q} IS NULL) AS \`__null_${col.name}\``,
      supportsDistinct
        ? `COUNT(DISTINCT ${q}) AS \`__distinct_${col.name}\``
        : `NULL AS \`__distinct_${col.name}\``,
    ];

    if (isNumeric) {
      parts.push(
        `CAST(MIN(${q}) AS STRING) AS \`__min_${col.name}\``,
        `CAST(MAX(${q}) AS STRING) AS \`__max_${col.name}\``,
      );
    } else if (isString) {
      parts.push(
        `MIN(${q}) AS \`__min_${col.name}\``,
        `MAX(${q}) AS \`__max_${col.name}\``,
      );
    } else {
      parts.push(
        `NULL AS \`__min_${col.name}\``,
        `NULL AS \`__max_${col.name}\``,
      );
    }

    return parts.join(',\n  ');
  });

  const totalCountSelect = `COUNT(*) AS __total_rows`;
  const profileSql = `SELECT\n  ${totalCountSelect},\n  ${profileSelects.join(',\n  ')}\nFROM \`${tableRef}\``;

  // Build top-values queries for string columns (up to 6 columns to keep cost low)
  const stringCols = columns
    .filter((c) => ['STRING'].includes(c.type.toUpperCase()))
    .slice(0, 6);

  const topValueQueries = stringCols.map((col) =>
    executeQuery(
      `SELECT \`${col.name}\` AS value, COUNT(*) AS cnt
       FROM \`${tableRef}\`
       WHERE \`${col.name}\` IS NOT NULL
       GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
      project,
    )
  );

  const [sampleResult, profileResult, ...topValueResults] = await Promise.all([
    executeQuery(sampleSql, project),
    executeQuery(profileSql, project),
    ...topValueQueries,
  ]);

  // Parse profile result
  const profileRow = profileResult.rows[0] ?? [];
  const profileCols = profileResult.columns;
  const totalRows = Number(profileRow[profileCols.indexOf('__total_rows')] ?? 0);

  const profile: PreviewColumn[] = columns.map((col, i) => {
    const nullIdx = profileCols.indexOf(`__null_${col.name}`);
    const distinctIdx = profileCols.indexOf(`__distinct_${col.name}`);
    const minIdx = profileCols.indexOf(`__min_${col.name}`);
    const maxIdx = profileCols.indexOf(`__max_${col.name}`);

    const nullCount = nullIdx >= 0 ? Number(profileRow[nullIdx] ?? 0) : 0;
    const distinctCount = distinctIdx >= 0 ? Number(profileRow[distinctIdx] ?? 0) : null;
    const minVal = minIdx >= 0 ? String(profileRow[minIdx] ?? '') || null : null;
    const maxVal = maxIdx >= 0 ? String(profileRow[maxIdx] ?? '') || null : null;

    // Find top values for this column if it was a string col we queried
    const stringColIdx = stringCols.findIndex((sc) => sc.name === col.name);
    let topValues: Array<{ value: string; count: number }> = [];
    if (stringColIdx >= 0 && topValueResults[stringColIdx]) {
      const tvResult = topValueResults[stringColIdx];
      topValues = tvResult.rows.map((r) => ({
        value: String(r[0] ?? ''),
        count: Number(r[1] ?? 0),
      }));
    }

    return {
      name: col.name,
      type: col.type,
      nullPct: totalRows > 0 ? Math.round((nullCount / totalRows) * 1000) / 10 : null,
      distinctCount,
      min: minVal,
      max: maxVal,
      topValues,
    };
  });

  return {
    sample: {
      columns: sampleResult.columns,
      rows: sampleResult.rows,
      rowCount: sampleResult.rowCount,
    },
    profile,
  };
}
