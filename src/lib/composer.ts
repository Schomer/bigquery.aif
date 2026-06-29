// src/lib/composer.ts
// Transforms a skill's normalized result into a CompositionEnvelope
// Implements bigquery-response-composition.md

function randomUUID(): string {
  if (typeof window !== 'undefined' && window.crypto && window.crypto.randomUUID) {
    return window.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
import type {
  CompositionEnvelope,
  SchemaResult,
  QueryResult,
  DataManagementResult,
  MonitoringResult,
  DiscoveryResult,
  DataQualityResult,
  DataLoadingResult,
  Tone,
  HeadlineBasis,
  ArtifactType,
  HandoffEnvelope,
  SkillName,
} from './types';

// ─── Main compose function ────────────────────────────────────────────────────

export function compose(
  skill: SkillName,
  result: SchemaResult | QueryResult | DataManagementResult | MonitoringResult | DiscoveryResult | DataQualityResult | DataLoadingResult
): CompositionEnvelope {
  switch (skill) {
    case 'schema':
      return composeSchema(result as SchemaResult);
    case 'query':
      return composeQuery(result as QueryResult);
    case 'data-management':
      return composeDataManagement(result as DataManagementResult);
    case 'monitoring':
      return composeMonitoring(result as MonitoringResult);
    case 'discovery':
      return composeDiscovery(result as DiscoveryResult);
    case 'data-quality':
      return composeDataQuality(result as DataQualityResult);
    case 'data-loading':
      return composeDataLoading(result as DataLoadingResult);
    default:
      return composeGeneric(skill, result);
  }
}

// ─── Schema composition ───────────────────────────────────────────────────────

function composeSchema(result: SchemaResult): CompositionEnvelope {
  const id = randomUUID();
  let headlineText = '';
  const tone: Tone = 'NEUTRAL';
  let basis: HeadlineBasis = 'STATUS';
  const artifactType: ArtifactType = 'SCHEMA_VIEW';
  const nextActions: HandoffEnvelope[] = [];

  if (result.scope === 'PROJECT') {
    const count = result.columns.length;
    headlineText = `Found ${count} dataset${count !== 1 ? 's' : ''}`;
    // Add a chip for each dataset (up to 4) so the user can drill in immediately
    result.columns.slice(0, 4).forEach((ds) => {
      nextActions.push({
        targetSkill: 'schema',
        label: `Explore ${ds.name}`,
        context: { dataset: ds.name, project: result.project },
        sourceSkill: 'schema',
        sourceResultRef: id,
      });
    });
    // Always offer a search option
    nextActions.push({
      targetSkill: 'discovery',
      label: 'Search across all tables',
      context: { project: result.project },
      sourceSkill: 'schema',
      sourceResultRef: id,
    });
  } else if (result.scope === 'DATASET') {
    const count = result.columns.length;
    headlineText = `${result.dataset} has ${count} table${count !== 1 ? 's' : ''}`;
    // Add a chip for each table (up to 4) so the user can inspect one immediately
    result.columns.slice(0, 4).forEach((t) => {
      nextActions.push({
        targetSkill: 'schema',
        label: `Inspect ${t.name}`,
        context: { dataset: result.dataset, table: t.name, project: result.project },
        sourceSkill: 'schema',
        sourceResultRef: id,
      });
    });
    // Offer to profile the dataset
    nextActions.push({
      targetSkill: 'data-quality',
      label: `Profile ${result.dataset}`,
      context: { dataset: result.dataset, project: result.project, checkType: 'PROFILE' },
      sourceSkill: 'schema',
      sourceResultRef: id,
    });
  } else {
    // TABLE scope — lead with the most actionable structural fact
    const parts: string[] = [];
    if (result.partitioning) {
      parts.push(`partitioned by \`${result.partitioning.field}\``);
    }
    if (result.clustering?.length) {
      parts.push(`clustered by ${result.clustering.map((c) => `\`${c}\``).join(', ')}`);
    }

    if (parts.length > 0) {
      headlineText = `\`${result.table}\` is ${parts.join(' and ')} — filter on these to keep queries efficient`;
      basis = 'DIRECT_ANSWER';
    } else {
      const colCount = result.columns.length;
      const rowCount = result.rowCount?.toLocaleString() ?? 'unknown';
      headlineText = `\`${result.table}\` — ${colCount} columns, ${rowCount} rows`;
    }

    // Sample rows and profile are now surfaced inline as tabs in SchemaView — no chips needed.
  }

  return {
    id,
    skill: 'schema',
    headline: { text: headlineText, tone, basis },
    primaryArtifact: { type: artifactType, data: result },
    provenance: { visibility: 'COLLAPSED' },
    nextActions,
  };
}

// ─── Query composition ────────────────────────────────────────────────────────

function composeQuery(result: QueryResult): CompositionEnvelope {
  const id = randomUUID();

  // Cost confirm card — don't show results
  if (result.requiresConfirmation && result.costConfirm) {
    return {
      id,
      skill: 'query',
      headline: {
        text: `This query will process ~${formatBytes(result.costConfirm.totalBytesProcessed)}. Confirm to run?`,
        tone: 'ATTENTION',
        basis: 'THRESHOLD',
      },
      primaryArtifact: { type: 'COST_CONFIRM_CARD', data: result.costConfirm },
      provenance: { visibility: 'VISIBLE', sql: result.sql },
      nextActions: [],
      requiresConfirmation: true,
    };
  }

  // Normal result
  const tone: Tone = 'NEUTRAL';
  const basis: HeadlineBasis = 'STATUS';
  const headlineText = (result as any).resultSummary || buildQueryHeadline(result.rowCount, result.sql);
  const insight = result.notableFindings ?? null;

  const artifactType = vizTypeToArtifactType(result.suggestedVisualization);

  const nextActions: HandoffEnvelope[] = [];
  // Always offer export if there are results
  if (result.rowCount > 0) {
    nextActions.push({
      targetSkill: 'data-loading',
      label: 'Export results',
      context: { sql: result.sql },
      sourceSkill: 'query',
      sourceResultRef: id,
    });
  }
  // If anomalies or nulls might be present, offer Data Quality
  if (result.notableFindings) {
    nextActions.push({
      targetSkill: 'data-quality',
      label: 'Check data quality',
      context: { sql: result.sql },
      sourceSkill: 'query',
      sourceResultRef: id,
    });
  }

  return {
    id,
    skill: 'query',
    headline: { text: headlineText, tone, basis },
    primaryArtifact: {
      type: artifactType,
      data: result,
      emphasis: result.notableFindings
        ? { highlight: [], deemphasize: [] }
        : undefined,
    },
    provenance: {
      visibility: result.costTier >= 1 ? 'VISIBLE' : 'COLLAPSED',
      sql: result.sql,
      cost: {
        totalBytesProcessed: result.totalBytesProcessed,
        tier: result.costTier,
        requiresConfirmation: false,
      },
      jobId: result.jobId,
      project: extractProjectFromSql(result.sql),
    },
    nextActions,
    insight,
  };
}

// ─── Data Management composition ──────────────────────────────────────────────

function composeDataManagement(
  result: DataManagementResult
): CompositionEnvelope {
  const id = randomUUID();

  if (result.requiresConfirmation) {
    // Confirmation card
    let headlineText = '';
    if (result.operation === 'DEDUPE') {
      const dupeCount = Number.isFinite(result.affectedRowCount) ? Math.round(result.affectedRowCount).toLocaleString() : 'some';
      headlineText = `Found ${dupeCount} duplicate rows across ${result.affectedGroupCount ?? 0} groups -- I'll keep the most recently updated copy of each`;
    } else {
      const count = Number.isFinite(result.affectedRowCount)
        ? Math.round(result.affectedRowCount).toLocaleString()
        : 'an unknown number of';
      headlineText = `This will affect ${count} rows. Review the preview and confirm.`;
    }

    return {
      id,
      skill: 'data-management',
      headline: { text: headlineText, tone: 'NEUTRAL', basis: 'DIRECT_ANSWER' },
      primaryArtifact: { type: 'CONFIRMATION_CARD', data: result },
      provenance: {
        visibility: 'VISIBLE',
        sql: result.previewSql,
        cost: result.costEstimate ?? undefined,
      },
      nextActions: [], // Confirm/Cancel are rendered by the card itself
      requiresConfirmation: true,
    };
  } else {
    // Completion card
    const tone: Tone = result.mismatch ? 'ATTENTION' : 'NEUTRAL';
    let headlineText: string;
    if (result.mismatch) {
      headlineText = result.mismatchNote ?? `Completed with unexpected result`;
    } else if (result.completionMessage) {
      headlineText = result.completionMessage;
    } else if (result.operation === 'DEDUPE') {
      headlineText = `Done — removed ${result.rowsAffected} duplicate rows`;
    } else {
      headlineText = `Done — ${result.rowsAffected} rows affected`;
    }

    const nextActions: HandoffEnvelope[] = [
      {
        targetSkill: 'query',
        label: 'Show the updated table',
        context: {},
        sourceSkill: 'data-management',
        sourceResultRef: id,
      },
    ];

    return {
      id,
      skill: 'data-management',
      headline: { text: headlineText, tone, basis: result.mismatch ? 'DEVIATION' : 'STATUS' },
      primaryArtifact: { type: 'COMPLETION_CARD', data: result },
      provenance: { visibility: 'COLLAPSED' },
      nextActions,
    };
  }
}

// ─── Generic fallback ─────────────────────────────────────────────────────────

function composeGeneric(
  skill: SkillName,
  result: unknown
): CompositionEnvelope {
  return {
    id: randomUUID(),
    skill,
    headline: { text: 'Result', tone: 'NEUTRAL', basis: 'STATUS' },
    primaryArtifact: { type: 'TABLE', data: result },
    provenance: { visibility: 'COLLAPSED' },
    nextActions: [],
  };
}

// ─── Monitoring composition ───────────────────────────────────────────────────

function composeMonitoring(result: MonitoringResult): CompositionEnvelope {
  const id = randomUUID();
  const { summary, items } = result;

  const tone: Tone = summary.errorCount > 0 ? 'ATTENTION' : 'NEUTRAL';
  let headlineText: string;
  if (summary.errorCount > 0) {
    const errorTypes = items.filter(j => j.status === 'ERROR');
    const uniqueErrors = new Set(errorTypes.map(j => j.statementType)).size;
    if (uniqueErrors === 1 && errorTypes.length > 1) {
      headlineText = `${summary.errorCount} failed ${errorTypes[0].statementType} jobs in the last 24h (${summary.totalJobs} total)`;
    } else {
      headlineText = `${summary.errorCount} failed job${summary.errorCount !== 1 ? 's' : ''} out of ${summary.totalJobs} in the last 24h`;
    }
  } else {
    headlineText = `${summary.totalJobs} jobs in the last 24h -- all successful, ${formatBytes(summary.totalBytesProcessed)} processed`;
  }

  const nextActions: HandoffEnvelope[] = [];

  // Always offer a cost drill-in
  nextActions.push({
    targetSkill: 'monitoring',
    label: 'Show most expensive queries',
    context: { monitoringHint: 'COST_ANALYSIS' },
    sourceSkill: 'monitoring',
    sourceResultRef: id,
  });

  // If there are errors, offer to diagnose them
  if (summary.errorCount > 0) {
    const failedJob = items.find((j) => j.status === 'ERROR');
    nextActions.push({
      targetSkill: 'monitoring',
      label: 'Diagnose failed jobs',
      context: { monitoringHint: 'DIAGNOSE_FAILURES', jobId: failedJob?.jobId },
      sourceSkill: 'monitoring',
      sourceResultRef: id,
    });
  }

  // Always offer storage analysis
  nextActions.push({
    targetSkill: 'monitoring',
    label: 'Storage analysis',
    context: { monitoringHint: 'STORAGE_ANALYSIS' },
    sourceSkill: 'monitoring',
    sourceResultRef: id,
  });

  return {
    id,
    skill: 'monitoring',
    headline: { text: headlineText, tone, basis: 'STATUS' },
    primaryArtifact: { type: 'MONITORING_VIEW', data: result },
    provenance: {
      visibility: 'COLLAPSED',
      sql: `SELECT job_id, user_email, statement_type, state, creation_time, total_bytes_processed, error_result, referenced_tables FROM \`region-us\`.INFORMATION_SCHEMA.JOBS_BY_PROJECT WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR) ORDER BY creation_time DESC LIMIT 50`,
    },
    nextActions,
  };
}

// ─── Discovery composition ────────────────────────────────────────────────────

function composeDiscovery(result: DiscoveryResult): CompositionEnvelope {
  const id = randomUUID();
  let headlineText = '';
  let tone: Tone = 'NEUTRAL';
  const basis: HeadlineBasis = 'STATUS';

  if (result.discoveryType === 'LINEAGE') {
    const lin = result.lineage;
    if (!lin) {
      headlineText = 'Lineage data unavailable';
    } else {
      headlineText = `Lineage for \`${lin.tableName}\`: ${lin.readsFrom.length} upstream, ${lin.writtenBy.length} downstream`;
    }
  } else if (result.discoveryType === 'COMPARISON') {
    const cmp = result.comparison;
    if (!cmp) {
      headlineText = 'Schema comparison unavailable';
    } else {
      const total = cmp.addedColumns.length + cmp.removedColumns.length + cmp.changedColumns.length;
      if (total === 0) {
        headlineText = `\`${cmp.left}\` and \`${cmp.right}\` have identical schemas`;
      } else {
        tone = 'ATTENTION';
        headlineText = `${total} difference${total !== 1 ? 's' : ''} between \`${cmp.left}\` and \`${cmp.right}\``;
      }
    }
  } else {
    const count = result.results.length;
    if (count > 0) {
      const tableCount = result.results.filter(r => r.type === 'TABLE').length;
      const viewCount = result.results.filter(r => r.type === 'VIEW').length;
      const parts: string[] = [];
      if (tableCount > 0) parts.push(`${tableCount} table${tableCount !== 1 ? 's' : ''}`);
      if (viewCount > 0) parts.push(`${viewCount} view${viewCount !== 1 ? 's' : ''}`);
      headlineText = parts.length > 0
        ? `Found ${parts.join(' and ')} matching "${result.query}"`
        : `Found ${count} result${count !== 1 ? 's' : ''} matching "${result.query}"`;
    } else {
      headlineText = `No tables or views found matching "${result.query}"`;
      tone = 'ATTENTION';
    }
  }

  const nextActions: HandoffEnvelope[] = [];

  if (result.discoveryType === 'COMPARISON') {
    // After a comparison, offer to inspect each table's full schema
    if (result.comparison) {
      nextActions.push({
        targetSkill: 'schema',
        label: `Inspect ${result.comparison.left.split('.').pop()}`,
        context: { table: result.comparison.left },
        sourceSkill: 'discovery',
        sourceResultRef: id,
      });
      nextActions.push({
        targetSkill: 'schema',
        label: `Inspect ${result.comparison.right.split('.').pop()}`,
        context: { table: result.comparison.right },
        sourceSkill: 'discovery',
        sourceResultRef: id,
      });
    }
  } else {
    // Search results: chip for each found item (up to 2)
    result.results.slice(0, 2).forEach((r) => {
      nextActions.push({
        targetSkill: 'schema',
        label: `Inspect ${r.ref.split('.').pop()}`,
        context: { table: r.ref },
        sourceSkill: 'discovery',
        sourceResultRef: id,
      });
    });
    // Always offer to run a query against first result
    if (result.results.length > 0) {
      nextActions.push({
        targetSkill: 'query',
        label: `Sample ${result.results[0].ref.split('.').pop()}`,
        context: { table: result.results[0].ref, sql: `SELECT * FROM \`${result.results[0].ref}\` LIMIT 20` },
        sourceSkill: 'discovery',
        sourceResultRef: id,
      });
    }
  }

  return {
    id,
    skill: 'discovery',
    headline: { text: headlineText, tone, basis },
    primaryArtifact: { type: 'DISCOVERY_VIEW', data: result },
    provenance: { visibility: 'COLLAPSED' },
    nextActions,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function vizTypeToArtifactType(viz: QueryResult['suggestedVisualization']): ArtifactType {
  const map: Record<string, ArtifactType> = {
    TABLE: 'TABLE',
    // Recharts native
    LINE_CHART: 'LINE_CHART',
    BAR_CHART: 'BAR_CHART',
    AREA_CHART: 'AREA_CHART',
    SCATTER: 'SCATTER',
    PIE_CHART: 'PIE_CHART',
    DONUT_CHART: 'DONUT_CHART',
    COLUMN_CHART: 'COLUMN_CHART',
    HISTOGRAM: 'HISTOGRAM',
    SPARKLINE: 'SPARKLINE',
    RADAR: 'RADAR',
    FUNNEL: 'FUNNEL',
    TREEMAP: 'TREEMAP',
    SANKEY: 'SANKEY',
    COMPOSED_CHART: 'COMPOSED_CHART',
    // Custom SVG
    GAUGE: 'GAUGE',
    HEATMAP: 'HEATMAP',
    BOXPLOT: 'BOXPLOT',
    CANDLESTICK: 'CANDLESTICK',
    VIOLIN: 'VIOLIN',
    DENSITY_PLOT: 'DENSITY_PLOT',
    RIDGELINE: 'RIDGELINE',
    NETWORK_GRAPH: 'NETWORK_GRAPH',
    TILE_MAP: 'TILE_MAP',
    // Maps
    GEO_POINT_MAP: 'GEO_POINT_MAP',
    USA_MAP: 'USA_MAP',
    WORLD_MAP: 'WORLD_MAP',
    KPI_CARD: 'KPI_CARD',
  };
  return map[viz] ?? 'TABLE';
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_099_511_627_776) return `${(bytes / 1_099_511_627_776).toFixed(1)} TB`;
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  return `${bytes} bytes`;
}

// Extract the leaf table name (last `.`-separated segment) from a SQL string.
// Handles both backtick-quoted refs (`project.dataset.table`) and unquoted names.
function extractTableFromSql(sql: string): string | null {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  // Match FROM or JOIN followed by an optional backtick-quoted identifier or bare word
  const match = normalized.match(/\bFROM\s+`?([A-Za-z0-9_.]+)`?/i);
  if (!match) return null;
  const ref = match[1];
  // Return only the final segment (table name, not project/dataset prefix)
  return ref.split('.').pop() ?? null;
}

// Extract the project ID from a fully qualified backtick-quoted table reference in SQL.
// Handles `project.dataset.table` patterns.
function extractProjectFromSql(sql: string): string | undefined {
  const match = sql.match(/`([A-Za-z0-9_-]+)\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+`/);
  return match?.[1] ?? undefined;
}

function buildQueryHeadline(rowCount: number, sql: string): string {
  if (!rowCount || rowCount === 0) {
    return 'Query returned no results -- try broadening your criteria or checking the table name';
  }
  const count = rowCount.toLocaleString();
  const rowWord = rowCount === 1 ? 'row' : 'rows';
  const table = extractTableFromSql(sql);
  if (table) {
    return `${count} ${rowWord} from \`${table}\``;
  }
  return `${count} ${rowWord} returned`;
}

// ─── Data Quality composition ─────────────────────────────────────────────────

function composeDataQuality(result: DataQualityResult): CompositionEnvelope {
  const id = randomUUID();
  const { summary } = result;
  const tone: Tone = summary.issuesFound > 0 ? 'ATTENTION' : 'NEUTRAL';
  let headlineText: string;
  if (summary.issuesFound === 0) {
    headlineText = `\`${result.table.split('.').pop()}\` looks clean -- no issues found`;
  } else {
    const highNullCols = result.findings.filter(f => f.metric === 'null_rate' && Number(f.value) > 0.5);
    const warningNullCols = result.findings.filter(f => f.metric === 'null_rate' && Number(f.value) > 0.1 && Number(f.value) <= 0.5);
    const dupeFindings = result.findings.filter(f => f.metric === 'duplicate_groups' && Number(f.value) > 0);

    const parts: string[] = [];
    if (highNullCols.length > 0) {
      parts.push(`${highNullCols.length} column${highNullCols.length !== 1 ? 's' : ''} with >50% nulls`);
    }
    if (warningNullCols.length > 0) {
      parts.push(`${warningNullCols.length} column${warningNullCols.length !== 1 ? 's' : ''} with >10% nulls`);
    }
    if (dupeFindings.length > 0) {
      const dupeCount = Number(dupeFindings[0].value);
      parts.push(`${dupeCount.toLocaleString()} duplicate group${dupeCount !== 1 ? 's' : ''}`);
    }

    if (parts.length > 0) {
      headlineText = `\`${result.table.split('.').pop()}\`: ${parts.join(', ')}`;
    } else {
      headlineText = `${summary.issuesFound} issue${summary.issuesFound !== 1 ? 's' : ''} found in \`${result.table.split('.').pop()}\``;
    }
  }

  const nextActions: HandoffEnvelope[] = [];
  const hasDupes = result.findings.some((f) => f.metric === 'duplicate_groups' && Number(f.value) > 0);
  const hasNulls = result.findings.some((f) => f.metric === 'null_rate' && Number(f.value) > 0.1);
  if (hasDupes) {
    nextActions.push({ targetSkill: 'data-management', label: 'Remove duplicates', context: { table: result.table, operationHint: 'DEDUPE' }, sourceSkill: 'data-quality', sourceResultRef: id });
  }
  if (hasNulls) {
    nextActions.push({ targetSkill: 'data-management', label: 'Fix nulls', context: { table: result.table, operationHint: 'UPDATE' }, sourceSkill: 'data-quality', sourceResultRef: id });
  }
  // Always offer to query the table
  nextActions.push({
    targetSkill: 'query',
    label: `Sample ${result.table.split('.').pop()}`,
    context: { table: result.table, sql: `SELECT * FROM \`${result.table}\` LIMIT 20` },
    sourceSkill: 'data-quality',
    sourceResultRef: id,
  });
  // Always offer to view the schema
  nextActions.push({
    targetSkill: 'schema',
    label: 'View schema',
    context: { table: result.table },
    sourceSkill: 'data-quality',
    sourceResultRef: id,
  });

  return {
    id,
    skill: 'data-quality',
    headline: { text: headlineText, tone, basis: 'STATUS' },
    primaryArtifact: { type: 'DATA_QUALITY_VIEW', data: result },
    provenance: result.sql ? { visibility: 'COLLAPSED', sql: result.sql } : { visibility: 'COLLAPSED' },
    nextActions,
  };
}

// ─── Data Loading composition ─────────────────────────────────────────────────

function composeDataLoading(result: DataLoadingResult): CompositionEnvelope {
  const id = randomUUID();
  let headlineText = result.message;
  const tone: Tone = 'NEUTRAL';

  if (result.operationType === 'EXPORT_CSV' && result.rowCount !== undefined) {
    headlineText = `${result.rowCount.toLocaleString()} rows${result.columnCount ? ` across ${result.columnCount} columns` : ''} ready to download`;
  } else if (result.operationType === 'EXPORT_SHEETS' && result.sheetsUrl) {
    headlineText = `Exported ${result.rowCount?.toLocaleString() ?? ''} rows to Google Sheets`;
  } else if (result.operationType === 'SCHEDULE_CREATED') {
    headlineText = `Scheduled query created: ${result.scheduleFrequency || 'recurring'}`;
  } else if (result.operationType === 'QUERY_SAVED') {
    headlineText = `Query saved: "${result.savedQueryLabel || 'Saved Query'}"`;
  } else if (result.operationType === 'SHARE_CLIPBOARD') {
    headlineText = `Results ready to share (${result.rowCount?.toLocaleString() ?? ''} rows)`;
  } else if (result.operationType === 'SCHEDULE_INFO') {
    headlineText = 'Scheduling information';
  }

  return {
    id,
    skill: 'data-loading',
    headline: { text: headlineText, tone, basis: 'STATUS' },
    primaryArtifact: { type: 'DATA_LOADING_VIEW', data: result },
    provenance: { visibility: 'COLLAPSED' },
    nextActions: [
      {
        targetSkill: 'query',
        label: 'Run another query',
        context: {},
        sourceSkill: 'data-loading',
        sourceResultRef: id,
      },
      {
        targetSkill: 'monitoring',
        label: 'View job history',
        context: { monitoringHint: 'JOB_LIST' },
        sourceSkill: 'data-loading',
        sourceResultRef: id,
      },
    ],
  };
}
