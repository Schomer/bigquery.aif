// src/lib/router.ts
// Intent classification → skill selection
// Implements bigquery-router-orchestration.md §1-6
//
// Uses a scored multi-signal approach instead of first-match-wins.
// Each signal list contributes a weighted score to candidate skills.
// The highest-scoring skill wins; when two skills score within a margin,
// confidence drops to 'medium' so the LLM classifier can break the tie.

import type { SkillName, HandoffEnvelope } from './types';

// ─── Skill selection signals ──────────────────────────────────────────────────

const MUTATING_VERBS = [
  'delete', 'remove', 'drop', 'update', 'fix', 'merge', 'dedupe', 'deduplicate',
  'alter', 'rename', 'create table', 'create view', 'partition', 'cluster',
  'copy table', 'clone', 'truncate', 'insert into', 'fill null',
  // Copy/duplicate verbs — "duplicate" as a verb means copy, not quality check
  'duplicate', 'copy', 'replicate', 'make a copy',
  // Value transformation verbs that imply UPDATE DML — must route to data-management
  'standardize', 'normaliz', 'format the', 'convert the', 'transform the',
  'replace values', 'replace null', 'set the', 'cast the', 'add a column',
  'add column', 'backfill', 'overwrite', 'populate the', 'uppercase', 'lowercase',
  'trim the', 'clean the', 'fix the', 'correct the',
  // DDL variants — 'create a view' and 'create a table' (with article) won't match without these
  'create a view', 'create a table', 'create or replace',
  'make a table', 'make a new table', 'make table',
  // Merge/upsert variants
  'upsert', 'merge into',
];

// Pre-compiled word-boundary patterns for mutating verbs.
// Prevents table names like "sales_deduped" from false-matching "dedupe".
const MUTATING_VERB_PATTERNS = MUTATING_VERBS.map((verb) => {
  const escaped = verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 'normaliz' is an intentional prefix to match normalize/normalizing/etc.
  const suffix = verb === 'normaliz' ? '' : '\\b';
  return new RegExp(`\\b${escaped}${suffix}`, 'i');
});

// Data quality signals — uses multi-word phrases for ambiguous words.
// Single words like "duplicate", "clean", "profile" are too ambiguous on their own
// and now route through the scoring system or are handled as verbs above.
const DATA_QUALITY_SIGNALS: Array<{ phrase: string; weight: number }> = [
  // High-weight: unambiguous data-quality intent
  { phrase: 'data quality', weight: 3 },
  { phrase: 'data profile', weight: 3 },
  { phrase: 'column profile', weight: 3 },
  { phrase: 'null rate', weight: 3 },
  { phrase: 'null analysis', weight: 3 },
  { phrase: 'how many nulls', weight: 3 },
  { phrase: 'check for nulls', weight: 3 },
  { phrase: 'find duplicates', weight: 3 },
  { phrase: 'check for duplicates', weight: 3 },
  { phrase: 'duplicate rows', weight: 3 },
  { phrase: 'duplicate detection', weight: 3 },
  { phrase: 'are there duplicates', weight: 3 },
  { phrase: 'referential integrity', weight: 3 },
  { phrase: 'schema drift', weight: 3 },
  { phrase: 'schema change', weight: 3 },
  { phrase: 'value range', weight: 3 },
  { phrase: 'out of range', weight: 3 },
  { phrase: 'range validation', weight: 3 },
  { phrase: 'completeness audit', weight: 3 },
  { phrase: 'data completeness', weight: 3 },
  { phrase: 'how complete', weight: 3 },
  // Medium-weight: likely data-quality but could be part of other contexts
  { phrase: 'profile the', weight: 2 },
  { phrase: 'profile this', weight: 2 },
  { phrase: 'quality', weight: 2 },
  { phrase: 'freshness', weight: 2 },
  { phrase: 'validate', weight: 2 },
  { phrase: 'completeness', weight: 2 },
  { phrase: 'drift', weight: 2 },
  { phrase: 'integrity', weight: 2 },
  // Low-weight: ambiguous single words — only tip the balance, don't decide alone
  { phrase: 'nulls', weight: 1 },
  { phrase: 'outlier', weight: 1 },
  { phrase: 'anomaly', weight: 1 },
  { phrase: 'invalid', weight: 1 },
];

// All non-mutating signal lists now use the same weighted structure.
// Phrases are matched with word boundaries to avoid substring false positives.
const SCHEMA_SIGNALS: Array<{ phrase: string; weight: number }> = [
  // High-weight: unambiguous schema/metadata intent
  { phrase: 'schema', weight: 3 },
  { phrase: 'describe', weight: 3 },
  { phrase: 'what fields', weight: 3 },
  { phrase: 'what tables', weight: 3 },
  { phrase: 'what datasets', weight: 3 },
  { phrase: 'what is in', weight: 3 },
  { phrase: "what's in", weight: 3 },
  { phrase: 'structure', weight: 2 },
  { phrase: 'type of', weight: 2 },
  { phrase: 'data type', weight: 3 },
  { phrase: 'list tables', weight: 3 },
  { phrase: 'show tables', weight: 3 },
  { phrase: 'list datasets', weight: 3 },
  { phrase: 'show columns', weight: 3 },
  { phrase: 'list columns', weight: 3 },
  { phrase: 'what columns', weight: 3 },
  { phrase: 'column types', weight: 3 },
  { phrase: 'list of datasets', weight: 3 },
  { phrase: 'list of tables', weight: 3 },
  { phrase: 'show datasets', weight: 3 },
  { phrase: 'datasets in', weight: 3 },
  { phrase: 'tables in', weight: 3 },
  { phrase: 'datasets of', weight: 2 },
  { phrase: 'tables of', weight: 2 },
  { phrase: 'list all datasets', weight: 3 },
  { phrase: 'list all tables', weight: 3 },
  { phrase: 'show me datasets', weight: 3 },
  { phrase: 'show me the datasets', weight: 3 },
  { phrase: 'show me tables', weight: 3 },
  { phrase: 'show me the tables', weight: 3 },
  { phrase: 'list of all datasets', weight: 3 },
  { phrase: 'list of all tables', weight: 3 },
  // Natural click-through phrases
  { phrase: 'tell me more', weight: 2 },
  { phrase: 'show me more about', weight: 2 },
  { phrase: 'more about', weight: 1 },
  { phrase: 'tell me about', weight: 2 },
  { phrase: 'inspect', weight: 2 },
  { phrase: 'details about', weight: 2 },
  { phrase: 'explore', weight: 1 },
  { phrase: 'look at', weight: 1 },
  // Lookup-by-name phrases
  { phrase: 'find the', weight: 1 },
  { phrase: 'find dataset', weight: 2 },
];

const DISCOVERY_SIGNALS: Array<{ phrase: string; weight: number }> = [
  { phrase: 'search', weight: 2 },
  { phrase: 'find a table', weight: 3 },
  { phrase: 'find tables', weight: 3 },
  { phrase: 'compare', weight: 3 },
  { phrase: 'lineage', weight: 3 },
  { phrase: 'where does this come from', weight: 3 },
  { phrase: 'what depends on', weight: 3 },
  { phrase: 'related to', weight: 2 },
];

const MONITORING_SIGNALS: Array<{ phrase: string; weight: number }> = [
  { phrase: 'slow query', weight: 3 },
  { phrase: 'expensive query', weight: 3 },
  { phrase: 'expensive job', weight: 3 },
  { phrase: 'expensive queries', weight: 3 },
  { phrase: 'slot', weight: 2 },
  { phrase: 'slot usage', weight: 3 },
  { phrase: 'failed job', weight: 3 },
  { phrase: 'failed jobs', weight: 3 },
  { phrase: 'job failed', weight: 3 },
  { phrase: 'who ran', weight: 3 },
  { phrase: 'job status', weight: 3 },
  { phrase: 'query cost', weight: 3 },
  { phrase: 'storage cost', weight: 3 },
  { phrase: 'storage analysis', weight: 3 },
  { phrase: 'table storage', weight: 3 },
  { phrase: 'how much storage', weight: 3 },
  { phrase: 'performance', weight: 2 },
  { phrase: 'recent queries', weight: 3 },
  { phrase: 'recent jobs', weight: 3 },
  { phrase: 'recent job', weight: 3 },
  { phrase: 'what failed', weight: 3 },
  { phrase: 'did that job', weight: 2 },
  { phrase: 'show jobs', weight: 3 },
  { phrase: 'job history', weight: 3 },
  { phrase: 'job list', weight: 3 },
  { phrase: "what's running", weight: 3 },
  { phrase: 'is running', weight: 2 },
  { phrase: 'did it finish', weight: 2 },
  { phrase: 'did the job', weight: 2 },
  { phrase: 'tell me more about job', weight: 3 },
  { phrase: 'diagnose', weight: 2 },
  { phrase: 'query plan', weight: 3 },
  { phrase: 'optimize', weight: 2 },
];

const DATA_LOADING_SIGNALS: Array<{ phrase: string; weight: number }> = [
  { phrase: 'export', weight: 2 },
  { phrase: 'download', weight: 2 },
  { phrase: 'schedule', weight: 2 },
  { phrase: 'recurring', weight: 2 },
  { phrase: 'save this query', weight: 3 },
  { phrase: 'send to sheets', weight: 3 },
  { phrase: 'google sheets', weight: 3 },
  { phrase: 'connect to', weight: 2 },
  { phrase: 'load from', weight: 2 },
  { phrase: 'upload', weight: 2 },
  { phrase: 'csv', weight: 2 },
  { phrase: 'json export', weight: 3 },
];

// ─── Scoring engine ───────────────────────────────────────────────────────────

type SignalList = Array<{ phrase: string; weight: number }>;

/**
 * Score a message against a weighted signal list using word-boundary matching.
 * Returns the sum of weights for all matching phrases.
 */
function scoreSignals(lower: string, signals: SignalList): number {
  let score = 0;
  for (const { phrase, weight } of signals) {
    // Use word-boundary matching to avoid substring false positives
    // (e.g., "performance_metrics" table name matching "performance")
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(lower)) {
      score += weight;
    }
  }
  return score;
}

// ─── Context-aware routing boosts ─────────────────────────────────────────────

// Follow-up action patterns: after a read-only skill, these phrases
// suggest the user wants to act on the results (data-management).
const FOLLOWUP_ACTION_PATTERNS = [
  /\b(?:clean|fix|remove|delete)\s+(?:it|them|those|that)\b/i,
  /\b(?:now|go ahead and)\s+(?:clean|fix|remove|delete|dedupe)\b/i,
];

// Follow-up export patterns: after a query, these suggest data-loading.
const FOLLOWUP_EXPORT_PATTERNS = [
  /\b(?:save|export|download)\s+(?:this|that|those|it|the results)\b/i,
];

/**
 * Apply context-aware score boosts based on the previous turn's skill.
 * Returns a map of skill -> bonus score.
 */
function getContextBoosts(
  lower: string,
  lastSkill?: SkillName
): Partial<Record<SkillName, number>> {
  const boosts: Partial<Record<SkillName, number>> = {};
  if (!lastSkill) return boosts;

  // After a data-quality check, action phrases suggest data-management
  if (lastSkill === 'data-quality') {
    if (FOLLOWUP_ACTION_PATTERNS.some(re => re.test(lower))) {
      boosts['data-management'] = 3;
    }
  }

  // After a query, save/export phrases suggest data-loading
  if (lastSkill === 'query') {
    if (FOLLOWUP_EXPORT_PATTERNS.some(re => re.test(lower))) {
      boosts['data-loading'] = 3;
    }
  }

  // After schema viewing, "check it" / "profile it" suggests data-quality
  if (lastSkill === 'schema') {
    if (/\b(?:check|profile|audit)\s+(?:it|this|that)\b/i.test(lower)) {
      boosts['data-quality'] = 3;
    }
  }

  return boosts;
}

// ─── Router output ────────────────────────────────────────────────────────────

export interface RouterOutput {
  skill: SkillName;
  confidence: 'high' | 'medium' | 'low';
  isHandoff: boolean;
  envelope?: Partial<HandoffEnvelope>;
  ambiguousReadWrite: boolean; // true when signals conflict between read and write skills
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
  // Mutating verbs are always high confidence — these are unambiguous action words.
  const hasMutatingVerb = MUTATING_VERB_PATTERNS.some((re) => re.test(lower));

  if (hasMutatingVerb) {
    // Check for conflicting quality signals (e.g., "find duplicates" contains
    // "duplicate" which is now a mutating verb, but the full phrase signals quality).
    // Multi-word quality phrases take precedence over single-word verb matches.
    const qualityScore = scoreSignals(lower, DATA_QUALITY_SIGNALS);
    if (qualityScore >= 3) {
      // Strong quality signal present alongside a mutating verb — ambiguous.
      // Let the LLM decide.
      return {
        skill: 'data-management',
        confidence: 'medium',
        isHandoff: false,
        ambiguousReadWrite: true,
      };
    }

    return {
      skill: 'data-management',
      confidence: 'high',
      isHandoff: false,
      ambiguousReadWrite: false,
    };
  }

  // ── Filter / equality pattern → Query ──────────────────────────────────
  // Messages like "show me more about `col` = 'VALUE'" or "filter where col = 42"
  // contain an equality comparison and should go to the query skill.
  const hasFilterPattern = /[`']?\w+[`']?\s*=\s*(?:'[^']*'|\d+)/i.test(message)
    || lower.includes('filter') || lower.includes('where');
  if (hasFilterPattern) {
    return {
      skill: 'query',
      confidence: 'high',
      isHandoff: false,
      ambiguousReadWrite: false,
    };
  }

  // ── Scored multi-signal classification ──────────────────────────────────────
  // Score each skill based on weighted signal matches, then pick the winner.

  const scores: Record<string, number> = {
    'data-quality': scoreSignals(lower, DATA_QUALITY_SIGNALS),
    'monitoring': scoreSignals(lower, MONITORING_SIGNALS),
    'schema': scoreSignals(lower, SCHEMA_SIGNALS),
    'discovery': scoreSignals(lower, DISCOVERY_SIGNALS),
    'data-loading': scoreSignals(lower, DATA_LOADING_SIGNALS),
  };

  // Apply context-aware boosts
  const boosts = getContextBoosts(lower, conversationContext?.lastSkill);
  for (const [skill, boost] of Object.entries(boosts)) {
    scores[skill] = (scores[skill] || 0) + boost;
  }

  // Find the top two scores
  const sorted = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort(([, a], [, b]) => b - a);

  if (sorted.length === 0) {
    // No signals matched — default to query with medium confidence (LLM decides)
    return {
      skill: 'query',
      confidence: 'medium',
      isHandoff: false,
      ambiguousReadWrite: false,
    };
  }

  const [topSkill, topScore] = sorted[0];
  const secondScore = sorted.length > 1 ? sorted[1][1] : 0;

  // If the top score is from a single low-weight match (weight 1), defer to LLM
  if (topScore <= 1) {
    return {
      skill: topSkill as SkillName,
      confidence: 'medium',
      isHandoff: false,
      ambiguousReadWrite: false,
    };
  }

  // If two skills are within a small margin, flag as ambiguous and defer to LLM
  const margin = topScore - secondScore;
  if (margin <= 1 && secondScore > 0) {
    return {
      skill: topSkill as SkillName,
      confidence: 'medium',
      isHandoff: false,
      ambiguousReadWrite: false,
    };
  }

  // Clear winner — high confidence
  return {
    skill: topSkill as SkillName,
    confidence: 'high',
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

  // Replace table references — but only "this/that table" and "it" when it
  // appears in a clear table-reference position (after a verb or preposition).
  // Bare "it" is too aggressive ("make it faster" should not become "make orders faster").
  return message
    .replace(/\bthat table\b/gi, context.lastTable)
    .replace(/\bthis table\b/gi, context.lastTable)
    .replace(/\b(?:from|in|on|to|into|of|against|about)\s+it\b/gi, (match) =>
      match.replace(/\bit\b/i, context.lastTable!)
    );
}
