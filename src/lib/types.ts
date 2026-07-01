// src/lib/types.ts
// Shared type definitions matching the normalized shapes in the skill docs

// ─── Skill names ─────────────────────────────────────────────────────────────

export type SkillName =
  | 'schema'
  | 'query'
  | 'data-management'
  | 'data-quality'
  | 'discovery'
  | 'monitoring'
  | 'data-loading'
  | 'multistep';

// ─── Handoff envelope (bigquery-shared-harness-policies.md §B) ───────────────

export interface HandoffEnvelope {
  targetSkill: SkillName;
  label: string; // user-facing chip text
  context: Record<string, unknown>;
  sourceSkill: SkillName | 'user';
  sourceResultRef?: string;
}

// ─── Cost tier (bigquery-shared-harness-policies.md §A) ──────────────────────

export type CostTier = 0 | 1 | 2 | 3 | 4;

export interface CostEstimate {
  totalBytesProcessed: number;
  tier: CostTier;
  requiresConfirmation: boolean; // tier >= 3
}

// ─── Composition envelope (bigquery-response-composition.md §2) ──────────────

export type Tone = 'NEUTRAL' | 'POSITIVE' | 'ATTENTION';
export type HeadlineBasis =
  | 'STATUS'
  | 'DEVIATION'
  | 'THRESHOLD'
  | 'COMPARISON'
  | 'DIRECT_ANSWER';

export type ArtifactType =
  | 'TABLE'
  // Recharts native
  | 'LINE_CHART' | 'BAR_CHART' | 'AREA_CHART' | 'SCATTER' | 'PIE_CHART'
  | 'DONUT_CHART' | 'COLUMN_CHART' | 'HISTOGRAM' | 'SPARKLINE'
  | 'RADAR' | 'FUNNEL' | 'TREEMAP' | 'SANKEY' | 'COMPOSED_CHART'
  // Custom SVG
  | 'GAUGE' | 'HEATMAP' | 'BOXPLOT' | 'CANDLESTICK'
  | 'VIOLIN' | 'DENSITY_PLOT' | 'RIDGELINE' | 'NETWORK_GRAPH' | 'TILE_MAP'
  // Maps
  | 'GEO_POINT_MAP' | 'USA_MAP' | 'WORLD_MAP'
  // Non-chart artifact types
  | 'KPI_CARD'
  | 'SCHEMA_VIEW'
  | 'CONFIRMATION_CARD'
  | 'COMPLETION_CARD'
  | 'COST_CONFIRM_CARD'
  | 'DATA_QUALITY_VIEW'
  | 'DATA_LOADING_VIEW'
  | 'MONITORING_VIEW'
  | 'DISCOVERY_VIEW'
  | 'ALERT_VIEW'
  | 'MULTISTEP_VIEW'
  // Data views
  | 'LINEAGE_DAG_VIEW'
  | 'ER_DIAGRAM_VIEW'
  | 'STORAGE_VIEW'
  | 'ACCESS_PATTERN_VIEW'
  | 'COST_ANALYSIS_VIEW'
  | 'FRESHNESS_VIEW';

export interface CompositionEnvelope {
  id: string; // unique per response, used as sourceResultRef
  skill: SkillName;
  headline: {
    text: string;
    tone: Tone;
    basis: HeadlineBasis;
  };
  primaryArtifact: {
    type: ArtifactType;
    data: unknown;
    emphasis?: {
      highlight: string[]; // column names / series names / row keys
      deemphasize: string[];
    };
  };
  provenance: {
    visibility: 'COLLAPSED' | 'VISIBLE';
    sql?: string;
    cost?: CostEstimate;
    freshness?: string;
    sourceResultRef?: string;
    jobId?: string;
    project?: string;
  };
  nextActions: HandoffEnvelope[];
  requiresConfirmation?: boolean;
  skipSelfReview?: boolean;
  insight?: string | null;
  qualityFlags?: import('./result-quality').QualityFlag[];
}

// Re-export QualityFlag from result-quality module for convenience
export type { QualityFlag } from './result-quality';

// ─── Schema normalized result (bigquery-skill-schema.md §5) ──────────────────

export interface SchemaColumn {
  name: string;
  type: string;
  mode: 'REQUIRED' | 'NULLABLE' | 'REPEATED';
  description?: string | null;
  fields?: SchemaColumn[];
  // Dataset-level table metadata (populated when scope === 'DATASET')
  rowCount?: number | null;
  sizeBytes?: number | null;
  creationTime?: string | null;
  // Project-level dataset metadata (populated when scope === 'PROJECT')
  tableCount?: number | null;
}

export interface SchemaResult {
  skill: 'schema';
  scope: 'PROJECT' | 'DATASET' | 'TABLE';
  project: string;
  dataset?: string | null;
  table?: string | null;
  description?: string | null;
  type?: 'TABLE' | 'VIEW' | 'MATERIALIZED_VIEW' | 'EXTERNAL' | null;
  columns: SchemaColumn[];
  partitioning?: { field: string; type: string } | null;
  clustering?: string[] | null;
  rowCount?: number | null;
  sizeBytes?: number | null;
  lastModifiedTime?: string | null;
  tableConstraints: {
    primaryKey: string[];
    foreignKeys: Array<{
      columns: string[];
      referencedTable: string;
      referencedColumns: string[];
    }>;
  };
  fetchedAt: string;
}

// ─── Query normalized result (bigquery-skill-template.md) ────────────────────

export type VisualizationType =
  | 'TABLE'
  // Recharts native
  | 'LINE_CHART' | 'BAR_CHART' | 'AREA_CHART' | 'SCATTER' | 'PIE_CHART'
  | 'DONUT_CHART' | 'COLUMN_CHART' | 'HISTOGRAM' | 'SPARKLINE'
  | 'RADAR' | 'FUNNEL' | 'TREEMAP' | 'SANKEY' | 'COMPOSED_CHART'
  // Custom SVG
  | 'GAUGE' | 'HEATMAP' | 'BOXPLOT' | 'CANDLESTICK'
  | 'VIOLIN' | 'DENSITY_PLOT' | 'RIDGELINE' | 'NETWORK_GRAPH' | 'TILE_MAP'
  // Maps
  | 'GEO_POINT_MAP' | 'USA_MAP' | 'WORLD_MAP'
  | 'KPI_CARD';

export interface QueryResult {
  skill: 'query';
  sql: string;
  requiresConfirmation: boolean;
  costConfirm?: CostEstimate | null;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  jobId?: string;
  totalBytesProcessed: number;
  costTier: CostTier;
  suggestedVisualization: VisualizationType;
  xAxis?: string | null;
  yAxis?: string[] | null;
  notableFindings?: string | null;
  resultSummary?: string | null;
}

// ─── Data Management normalized result (bigquery-skill-data-management.md) ───

export type DmOperation =
  | 'DEDUPE'
  | 'DELETE'
  | 'UPDATE'
  | 'FILL_NULLS'
  | 'CREATE_TABLE'
  | 'ALTER_TABLE'
  | 'CREATE_VIEW'
  | 'RENAME'
  | 'COPY_TABLE'
  | 'MERGE'
  | 'PARTITION_TABLE';

export interface DmExampleGroup {
  keyValue: Record<string, unknown>;
  keepRow: Record<string, unknown>;
  removeRows: Record<string, unknown>[];
}

export interface DataManagementConfirmResult {
  skill: 'data-management';
  requiresConfirmation: true;
  operation: DmOperation;
  previewSql: string;
  affectedRowCount: number;
  affectedGroupCount?: number; // for DEDUPE
  exampleGroup?: DmExampleGroup; // for DEDUPE
  costEstimate?: CostEstimate | null;
  tiebreakerColumn?: string;
  tiebreakerDirection?: 'KEEP_LATEST' | 'KEEP_EARLIEST';
  executionSql: string;
  snapshotRowIds?: (string | number)[];
}

export interface DataManagementCompleteResult {
  skill: 'data-management';
  requiresConfirmation: false;
  operation: DmOperation;
  rowsAffected: number;
  rowsExpected: number;
  mismatch: boolean;
  mismatchNote?: string | null;
  schemaInvalidated: string[];
  jobId?: string;
  completionMessage?: string | null;
}

export type DataManagementResult =
  | DataManagementConfirmResult
  | DataManagementCompleteResult;

// ─── Data Quality types (bigquery-skill-data-quality) ─────────────────────────

export type DqCheckType = 'PROFILE' | 'NULLS' | 'DUPLICATES' | 'FRESHNESS' | 'COMPLETENESS' | 'RANGE_VALIDATION' | 'REFERENTIAL_INTEGRITY' | 'SCHEMA_DRIFT';
export type DqSeverity = 'INFO' | 'WARNING' | 'ISSUE';

export interface DqFinding {
  column: string;
  metric: string;
  value: number | string | null;
  severity: DqSeverity;
}

export interface DataQualityResult {
  skill: 'data-quality';
  checkType: DqCheckType;
  table: string;
  sql: string;
  findings: DqFinding[];
  summary: {
    rowsScanned: number;
    issuesFound: number;
    checkedAt: string;
  };
}

// ─── Data Loading normalized result ──────────────────────────────────────────

export interface DataLoadingResult {
  skill: 'data-loading'
  operationType: 'EXPORT_CSV' | 'EXPORT_SHEETS' | 'SCHEDULE_INFO' | 'SCHEDULE_CREATED' | 'QUERY_SAVED' | 'SHARE_CLIPBOARD' | 'NOT_SUPPORTED'
  message: string
  csvContent?: string | null
  sheetsUrl?: string | null
  rowCount?: number
  columnCount?: number
  sql?: string | null
  scheduleName?: string | null
  scheduleFrequency?: string | null
  shareText?: string | null
  savedQueryLabel?: string | null
}

// ─── Chat message ─────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  envelopes?: CompositionEnvelope[];
  timestamp: string;
}

// ─── Monitoring normalized result ─────────────────────────────────────────────

export interface MonitoringJob {
  jobId: string
  userEmail: string
  statementType: string
  status: 'DONE' | 'RUNNING' | 'ERROR'
  createTime: string
  totalBytesProcessed: number
  errorMessage?: string | null
  referencedTables: string[]
}

export interface MonitoringResult {
  skill: 'monitoring'
  monitoringType: 'JOB_LIST' | 'JOB_STATUS' | 'ALERT' | 'STORAGE_BREAKDOWN' | 'ACCESS_PATTERNS' | 'COST_ANALYSIS' | 'FRESHNESS'
  timeRange: { start: string; end: string }
  items: MonitoringJob[]
  summary: {
    totalJobs: number
    totalBytesProcessed: number
    errorCount: number
  }
}

// --- Saved Checks & Alerting -------------------------------------------------

export type AlertTier = 'TIER_0' | 'TIER_1';

export interface SavedCheck {
  id: string;
  createdAt: string;
  label: string;
  sql: string;
  conditionDescription: string;
  table?: string;
  tier: AlertTier;
  schedule?: string;       // cron expression for Tier 1
  transferConfigName?: string;  // BigQuery Data Transfer config name for Tier 1
}

export interface AlertResult {
  skill: 'monitoring';
  monitoringType: 'ALERT';
  alertCategory: 'PROJECT_WIDE' | 'JOB_SPECIFIC' | 'DATA_CONDITION';
  conditionDescription: string;
  checkSql?: string;
  savedCheckId?: string;
  tier?: AlertTier;
  guidance?: string;
  nextActions?: Array<{ label: string; action: string }>;
}

// ─── Discovery normalized result ──────────────────────────────────────────────

export interface DiscoverySearchResult {
  type: 'TABLE' | 'VIEW' | 'DATASET'
  ref: string
  matchedOn: string
  description?: string | null
}

export interface DiscoveryResult {
  skill: 'discovery'
  discoveryType: 'SEARCH' | 'COMPARISON' | 'LINEAGE' | 'ER_DIAGRAM'
  query: string
  results: DiscoverySearchResult[]
  comparison?: {
    left: string
    right: string
    addedColumns: Array<{ name: string; type: string }>
    removedColumns: Array<{ name: string; type: string }>
    changedColumns: Array<{ name: string; fromType: string; toType: string }>
  } | null
  lineage?: {
    tableName: string;
    readsFrom: string[];
    writtenBy: string[];
    nodes?: LineageNode[];
    edges?: LineageEdge[];
  } | null
  erDiagram?: ErDiagramData | null
}

// ─── Table Preview Types ──────────────────────────────────────────────────────

export interface PreviewColumn {
  name: string;
  type: string;
  nullPct: number | null;
  distinctCount: number | null;
  min: string | null;
  max: string | null;
  topValues: Array<{ value: string; count: number }>;
}

export interface PreviewResponse {
  sample: {
    columns: string[];
    rows: unknown[][];
    rowCount: number;
  };
  profile: PreviewColumn[];
}

// ─── Lineage DAG types ────────────────────────────────────────────────────────

export interface LineageNode {
  id: string;         // fully-qualified table ref
  label: string;      // short name
  type: 'TABLE' | 'VIEW' | 'EXTERNAL' | 'TARGET';
  dataset: string;
  rowCount?: number | null;
  lastModified?: string | null;
}

export interface LineageEdge {
  source: string;     // node id
  target: string;     // node id
  jobCount: number;   // how many jobs created this edge
  lastSeen: string;   // timestamp of most recent job
  statementTypes: string[];  // INSERT, MERGE, CREATE_TABLE_AS_SELECT, etc.
}

// ─── ER Diagram types ─────────────────────────────────────────────────────────

export interface ErTableInfo {
  name: string;
  columns: Array<{ name: string; type: string; isPk: boolean }>;
}

export interface ErRelationship {
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  type: 'FOREIGN_KEY' | 'INFERRED';
}

export interface ErDiagramData {
  dataset: string;
  tables: ErTableInfo[];
  relationships: ErRelationship[];
}

// ─── Storage Breakdown types ──────────────────────────────────────────────────

export interface StorageItem {
  ref: string;
  label: string;
  sizeBytes: number;
  rowCount: number;
  type: 'DATASET' | 'TABLE';
  children?: StorageItem[];
}

export interface StorageBreakdownResult {
  skill: 'monitoring';
  monitoringType: 'STORAGE_BREAKDOWN';
  project: string;
  totalBytes: number;
  items: StorageItem[];
}

// ─── Access Pattern types ─────────────────────────────────────────────────────

export interface AccessPatternEntry {
  tableRef: string;
  userEmail: string;
  queryCount: number;
  totalBytesProcessed: number;
  lastAccessed: string;
}

export interface AccessPatternResult {
  skill: 'monitoring';
  monitoringType: 'ACCESS_PATTERNS';
  timeRange: { start: string; end: string };
  entries: AccessPatternEntry[];
}

// ─── Cost Analysis types ──────────────────────────────────────────────────────

export interface CostBucket {
  period: string;
  user: string;
  bytesProcessed: number;
  estimatedCostUsd: number;
  jobCount: number;
}

export interface CostAnalysisResult {
  skill: 'monitoring';
  monitoringType: 'COST_ANALYSIS';
  timeRange: { start: string; end: string };
  totalEstimatedCostUsd: number;
  buckets: CostBucket[];
}

// ─── Data Freshness types ─────────────────────────────────────────────────────

export interface FreshnessEntry {
  tableRef: string;
  lastModified: string;
  ageHours: number;
  rowCount: number;
  status: 'FRESH' | 'STALE' | 'VERY_STALE';
}

export interface FreshnessResult {
  skill: 'monitoring';
  monitoringType: 'FRESHNESS';
  dataset: string;
  entries: FreshnessEntry[];
  thresholds: { freshHours: number; staleHours: number };
}
