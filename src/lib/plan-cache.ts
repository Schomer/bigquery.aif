// src/lib/plan-cache.ts
// Session-scoped cache of recent query plans.
// Allows reuse of SQL templates when users iterate on the same question
// with different parameters (time range, filter values, GROUP BY columns).

import type { SkillName, VisualizationType } from './types';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PlanCacheEntry {
  skill: SkillName;
  dataset: string;
  tables: string[];         // table names extracted from SQL
  sql: string;
  visualization: VisualizationType;
  xAxis: string | null;
  yAxis: string[] | null;
  operationShape: string;   // e.g., 'aggregation', 'top-n', 'time-series', 'filter'
  timestamp: number;
}

export interface PlanCacheHit {
  entry: PlanCacheEntry;
  substitutedSql: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_ENTRIES = 20;

// ─── Cache storage ───────────────────────────────────────────────────────────

const _cache: PlanCacheEntry[] = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract table names from SQL (backtick-wrapped fully qualified refs). */
function extractTablesFromSql(sql: string): string[] {
  const matches = sql.match(/`[^`]+\.[^`]+\.[^`]+`/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.replace(/`/g, '').toLowerCase()))];
}

/** Classify the operation shape from SQL keywords. */
function classifyShape(sql: string): string {
  const upper = sql.toUpperCase();
  if (/\bORDER\s+BY\b[\s\S]*\bLIMIT\b/.test(upper)) return 'top-n';
  if (/\bDATE_TRUNC\b|\bTIMESTAMP_TRUNC\b/i.test(upper) && /\bGROUP\s+BY\b/i.test(upper)) return 'time-series';
  if (/\bGROUP\s+BY\b/i.test(upper)) return 'aggregation';
  if (/\bWHERE\b/i.test(upper) && !/\bGROUP\s+BY\b/i.test(upper)) return 'filter';
  return 'general';
}

/**
 * Try to substitute parameter differences into an existing SQL template.
 * Returns the modified SQL if substitution succeeded, null if the queries
 * are too structurally different to reuse.
 *
 * Handles:
 * - Different WHERE clause literal values (dates, strings, numbers)
 * - Different LIMIT values
 * - Different date ranges in DATE_TRUNC / temporal filters
 */
function trySubstitute(cachedSql: string, newMessage: string): string | null {
  // Extract date-like values from the new message
  const dateMatch = newMessage.match(/\b(20\d{2}(?:-\d{2})?(?:-\d{2})?)\b/g);
  const numberMatch = newMessage.match(/\btop\s+(\d+)\b|\blimit\s+(\d+)\b|\b(\d+)\s+(?:rows|results|records)\b/i);

  let result = cachedSql;
  let changed = false;

  // Substitute date literals in WHERE clauses
  if (dateMatch && dateMatch.length > 0) {
    const existingDates = cachedSql.match(/'(20\d{2}(?:-\d{2})?(?:-\d{2})?)'/g);
    if (existingDates && existingDates.length > 0) {
      // Replace the most recent date literals with new ones
      for (let i = 0; i < Math.min(dateMatch.length, existingDates.length); i++) {
        result = result.replace(existingDates[i], `'${dateMatch[i]}'`);
        changed = true;
      }
    }
  }

  // Substitute LIMIT values
  if (numberMatch) {
    const newLimit = numberMatch[1] || numberMatch[2] || numberMatch[3];
    if (newLimit) {
      const limitRegex = /\bLIMIT\s+\d+/i;
      if (limitRegex.test(result)) {
        result = result.replace(limitRegex, `LIMIT ${newLimit}`);
        changed = true;
      }
    }
  }

  return changed ? result : null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Search the cache for a reusable plan.
 * Returns a hit with substituted SQL if the request matches an existing plan
 * with only parameter differences.
 */
export function findReusablePlan(
  message: string,
  dataset: string,
  _table?: string,
): PlanCacheHit | null {
  const lowerMessage = message.toLowerCase();

  for (let i = _cache.length - 1; i >= 0; i--) {
    const entry = _cache[i];

    // Must be same dataset
    if (entry.dataset.toLowerCase() !== dataset.toLowerCase()) continue;

    // Must be same operation shape category
    const entryShape = entry.operationShape;

    // Try parameter substitution
    const substituted = trySubstitute(entry.sql, lowerMessage);
    if (substituted) {
      // Verify the substituted SQL is structurally similar (same shape)
      if (classifyShape(substituted) === entryShape) {
        console.log(`[plan-cache] hit: reusing ${entryShape} plan for dataset ${dataset}`);
        return { entry, substitutedSql: substituted };
      }
    }
  }

  console.log(`[plan-cache] miss: no reusable plan for dataset ${dataset}`);
  return null;
}

/**
 * Store a new plan in the cache.
 */
export function cachePlan(
  skill: SkillName,
  dataset: string,
  sql: string,
  visualization: VisualizationType,
  xAxis: string | null,
  yAxis: string[] | null,
): void {
  const entry: PlanCacheEntry = {
    skill,
    dataset,
    tables: extractTablesFromSql(sql),
    sql,
    visualization,
    xAxis,
    yAxis,
    operationShape: classifyShape(sql),
    timestamp: Date.now(),
  };

  _cache.push(entry);

  // FIFO eviction
  while (_cache.length > MAX_ENTRIES) {
    _cache.shift();
  }
}

/**
 * Clear the entire cache. Called on session reset.
 */
export function clearPlanCache(): void {
  _cache.length = 0;
}
