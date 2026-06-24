// src/lib/router.ts
// Intent classification → skill selection
// Implements bigquery-router-orchestration.md §1-6

import type { SkillName, HandoffEnvelope } from './types';

// ─── Skill selection signals ──────────────────────────────────────────────────

const MUTATING_VERBS = [
  'delete', 'remove', 'drop', 'update', 'fix', 'merge', 'dedupe', 'deduplicate',
  'alter', 'rename', 'create table', 'create view', 'partition', 'cluster',
  'copy table', 'clone', 'truncate', 'insert into', 'fill null',
  // Value transformation verbs that imply UPDATE DML — must route to data-management
  'standardize', 'normaliz', 'format the', 'convert the', 'transform the',
  'replace values', 'replace null', 'set the', 'cast the', 'add a column',
  'add column', 'backfill', 'overwrite', 'populate the', 'uppercase', 'lowercase',
  'trim the', 'clean the', 'fix the', 'correct the',
  // DDL variants — 'create a view' and 'create a table' (with article) won't match without these
  'create a view', 'create a table', 'create or replace',
  'make a table', 'make a new table', 'make table',
];

// Pre-compiled word-boundary patterns for mutating verbs.
// Prevents table names like "sales_deduped" from false-matching "dedupe".
const MUTATING_VERB_PATTERNS = MUTATING_VERBS.map((verb) => {
  const escaped = verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 'normaliz' is an intentional prefix to match normalize/normalizing/etc.
  const suffix = verb === 'normaliz' ? '' : '\\b';
  return new RegExp(`\\b${escaped}${suffix}`, 'i');
});


const DATA_QUALITY_SIGNALS = [
  'profile', 'quality', 'duplicate', 'duplicates', 'null', 'nulls',
  'validate', 'freshness', 'completeness', 'drift', 'anomaly', 'outlier',
  'integrity', 'valid', 'invalid', 'clean',
  // Column drill-through from SchemaView inline actions
  'how many nulls', 'null rate',
];

const SCHEMA_SIGNALS = [
  'schema', 'describe', 'what fields', 'what tables',
  'what datasets', 'what is in', "what's in", 'structure', 'type of',
  'data type', 'list tables', 'show tables', 'list datasets',
  'show columns', 'list columns', 'what columns', 'column types',
  'list of datasets', 'list of tables', 'show datasets', 'datasets in',
  'tables in', 'datasets of', 'tables of',
  'list all datasets', 'list all tables', 'show me datasets',
  'show me the datasets', 'show me tables', 'show me the tables',
  'list of all datasets', 'list of all tables',
  // Natural click-through phrases ("tell me more about X", "explore X")
  'tell me more', 'show me more about', 'more about', 'tell me about',
  'inspect', 'details about', 'explore', 'look at',
  // Lookup-by-name phrases ("find the X dataset", "find dataset X")
  'find the', 'find dataset',
];

const DISCOVERY_SIGNALS = [
  'search', 'find a table', 'find tables', 'compare', 'lineage',
  'where does this come from', 'what depends on', 'related to',
];

const MONITORING_SIGNALS = [
  'slow query', 'expensive query', 'expensive job', 'expensive queries',
  'slot', 'failed job', 'failed jobs', 'job failed', 'who ran',
  'job status', 'query cost', 'storage cost', 'performance',
  'recent queries', 'recent jobs', 'recent job', 'what failed', 'did that job',
  'show jobs', 'job history', 'job list', "what's running", 'is running',
  'did it finish', 'did the job',
  // Job drill-through click phrase
  'tell me more about job', 'diagnose',
];

const DATA_LOADING_SIGNALS = [
  'export', 'download', 'schedule', 'recurring', 'save this query',
  'send to sheets', 'google sheets', 'connect to', 'load from', 'upload',
  'csv', 'json export',
];

// ─── Router output ────────────────────────────────────────────────────────────

export interface RouterOutput {
  skill: SkillName;
  confidence: 'high' | 'medium' | 'low';
  isHandoff: boolean;
  envelope?: Partial<HandoffEnvelope>;
  ambiguousReadWrite: boolean; // true if message looked like it might mutate but lacked explicit verb
}

// ─── Main classification function ─────────────────────────────────────────────

export function classifyIntent(
  message: string,
  conversationContext?: {
    lastSkill?: SkillName;
    lastResultRef?: string;
    lastTable?: string;
  }
): RouterOutput {
  const lower = message.toLowerCase();

  // ── Hard rule: Data Management requires explicit mutating verb ─────────────
  const hasMutatingVerb = MUTATING_VERB_PATTERNS.some((re) => re.test(lower));

  if (hasMutatingVerb) {
    return {
      skill: 'data-management',
      confidence: 'high',
      isHandoff: false,
      ambiguousReadWrite: false,
    };
  }

  // ── Data Quality ───────────────────────────────────────────────────────────
  if (DATA_QUALITY_SIGNALS.some((s) => lower.includes(s))) {
    return {
      skill: 'data-quality',
      confidence: 'high',
      isHandoff: false,
      ambiguousReadWrite: false,
    };
  }

  // ── Monitoring (checked before Schema to catch "tell me more about job X") ──
  if (MONITORING_SIGNALS.some((s) => lower.includes(s))) {
    return {
      skill: 'monitoring',
      confidence: 'high',
      isHandoff: false,
      ambiguousReadWrite: false,
    };
  }

  // ── Filter / equality pattern → Query ──────────────────────────────────
  // Messages like "show me more about `col` = 'VALUE'" or "filter where col = 42"
  // contain an equality comparison and should go to the query skill, not schema.
  const hasFilterPattern = /[`']?\w+[`']?\s*=\s*(?:'[^']*'|\d+)/i.test(message)
    || lower.includes('filter') || lower.includes('where');
  if (hasFilterPattern && !hasMutatingVerb) {
    return {
      skill: 'query',
      confidence: 'high',
      isHandoff: false,
      ambiguousReadWrite: false,
    };
  }

  // ── Schema ────────────────────────────────────────────────────────────────
  if (SCHEMA_SIGNALS.some((s) => lower.includes(s))) {
    return {
      skill: 'schema',
      confidence: 'high',
      isHandoff: false,
      ambiguousReadWrite: false,
    };
  }

  // ── Discovery ─────────────────────────────────────────────────────────────
  if (DISCOVERY_SIGNALS.some((s) => lower.includes(s))) {
    return {
      skill: 'discovery',
      confidence: 'high',
      isHandoff: false,
      ambiguousReadWrite: false,
    };
  }


  // ── Data Loading ──────────────────────────────────────────────────────────
  if (DATA_LOADING_SIGNALS.some((s) => lower.includes(s))) {
    return {
      skill: 'data-loading',
      confidence: 'high',
      isHandoff: false,
      ambiguousReadWrite: false,
    };
  }

  // ── Default: Query (analytical questions, anything else) ─────────────────
  // "show me / what's / how many / group by / top N / trend / join / filter"
  return {
    skill: 'query',
    confidence: 'medium',
    isHandoff: false,
    ambiguousReadWrite: false,
  };
}

/**
 * Resolve referential language ("that table", "those rows", "it") against
 * recent conversation context before classifying.
 * Returns the resolved message string.
 */
export function resolveReferences(
  message: string,
  context?: { lastTable?: string; lastResultRef?: string }
): string {
  if (!context?.lastTable) return message;

  // Simple referential resolution — replace common references with the last known table
  return message
    .replace(/\bthat table\b/gi, context.lastTable)
    .replace(/\bthis table\b/gi, context.lastTable)
    .replace(/\bit\b/gi, context.lastTable);
}
