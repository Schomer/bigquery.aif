// src/lib/chat-orchestrator.ts
// Per-turn client-side orchestration: receive message → router → skill dispatch → compose → return envelopes
// Runs entirely in the browser using the Gemini API REST endpoint via the configured API key.

import { classifyIntent, resolveReferences } from './router';
import { fetchSchema } from './skills/schema';
import { compose } from './composer';
import { dryRun, executeQuery, executeDml, exportToSheets, createScheduledQuery, detectBqRegion } from './bigquery-client';
import { saveQuery as firestoreSaveQuery, saveCheck } from './firestore-service';
import type {
  ChatMessage,
  CompositionEnvelope,
  DataManagementResult,
  DataQualityResult,
  DqFinding,
  MonitoringJob,
  MonitoringResult,
  AlertResult,
  DiscoveryResult,
  DiscoverySearchResult,
  DataLoadingResult,
  SavedCheck,
  SkillName,
  QueryResult,
} from './types';

// ─── Load skill docs from public assets (cached in memory) ───────────────────

const _skillDocCache = new Map<string, string>();

async function loadSkillDoc(skillName: string): Promise<string> {
  const cached = _skillDocCache.get(skillName);
  if (cached) return cached;
  try {
    // Server-side: read from filesystem; client-side: use fetch
    let text: string;
    if (typeof window === 'undefined') {
      const { readFileSync } = await import('fs');
      const { join } = await import('path');
      text = readFileSync(join(process.cwd(), 'public', 'skills', `${skillName}.md`), 'utf-8');
    } else {
      const res = await fetch(`/skills/${skillName}.md`);
      if (!res.ok) throw new Error();
      text = await res.text();
    }
    _skillDocCache.set(skillName, text);
    return text;
  } catch {
    const fallback = `You are the ${skillName} skill. Help the user with their data request.`;
    _skillDocCache.set(skillName, fallback);
    return fallback;
  }
}

// ─── Gemini API via Vertex AI REST ─────────────────────────────────────────────

import { getAccessToken } from './gis-auth';

const DATA_ASSISTANT_INSTRUCTIONS = `You are a data assistant for BigQuery. When a user asks you to do something with their data, your job is to actually do it — not explain how to do it, not ask clarifying questions unless something is genuinely ambiguous, just do it.
Every request should follow this pattern:

Figure out what the user wants. Even if it's phrased casually or incompletely, make your best interpretation and act on it. If you truly can't proceed without more information, ask one specific question — not a list of questions.
Do the work. Run whatever queries, checks, or operations are needed. If it takes multiple steps, run them in order. Don't stop between steps to ask permission unless a step would permanently change or delete data.
For any step that will permanently change or delete data, pause and show the user exactly what you're about to do and how many rows or objects will be affected. Wait for them to confirm before proceeding.
Report what happened. When you're done, tell the user what you did and what you found — a result table, a chart, a number, a confirmation. If something went wrong, say what and why. If something interesting showed up in the data along the way, mention it briefly.

Keep your responses short and direct. Lead with the result, not with a description of what you're doing. If a task takes multiple steps, you can note the steps briefly, but the result is what matters.

CRITICAL SQL RULE:
Always wrap fully qualified table references in literal backticks: \`project.dataset.tablename\` (e.g., \`my-project.dataset.orders\`). This is CRITICAL to prevent syntax errors in BigQuery when project names or dataset names contain dashes/hyphens.`;

interface CallGeminiArgs {
  systemInstruction?: string;
  prompt?: string;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  schema: any;
  project?: string;
}

async function callGemini({
  systemInstruction,
  prompt,
  messages,
  schema,
  project,
}: CallGeminiArgs): Promise<any> {
  const projectId = project || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'malloy-data';
  const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY || '';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`;

  const contents = [];
  if (messages) {
    for (const m of messages) {
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      });
    }
  }
  if (prompt) {
    contents.push({
      role: 'user',
      parts: [{ text: prompt }]
    });
  }

  const finalSystemInstruction = systemInstruction
    ? `${DATA_ASSISTANT_INSTRUCTIONS}\n\n${systemInstruction}`
    : DATA_ASSISTANT_INSTRUCTIONS;

  const requestBody = {
    systemInstruction: {
      parts: [{ text: finalSystemInstruction }]
    },
    contents,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature: 0.1,
    },
  };

  const maxRetries = 3;
  let delay = 1000;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const data = await res.json();

      if (res.status === 401 || res.status === 403) {
        throw new Error('Not authenticated. Please sign in again.');
      }

      if (res.ok && !data.error) {
        // Vertex AI wraps the response in candidates[0].content.parts[0].text
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          return JSON.parse(text);
        }
        throw new Error('No content in Vertex AI response');
      }

      const errorMsg = data?.error?.message || data?.error || `HTTP ${res.status}`;

      // Check for transient errors
      const isTransient =
        res.status === 429 ||
        res.status >= 500 ||
        (typeof errorMsg === 'string' && (
          errorMsg.toLowerCase().includes('demand') ||
          errorMsg.toLowerCase().includes('temporary') ||
          errorMsg.toLowerCase().includes('limit') ||
          errorMsg.toLowerCase().includes('quota') ||
          errorMsg.toLowerCase().includes('resource')
        ));

      if (isTransient && attempt < maxRetries - 1) {
        const jitter = Math.random() * delay * 0.3;
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
        delay *= 2;
        continue;
      }

      throw new Error(`Gemini API failed: ${errorMsg}`);

    } catch (err: any) {
      if (err.message?.includes('fetch') || err.message?.includes('network') || err.message?.includes('Failed to fetch')) {
        if (attempt < maxRetries - 1) {
          const jitter = Math.random() * delay * 0.3;
          await new Promise((resolve) => setTimeout(resolve, delay + jitter));
          delay *= 2;
          continue;
        }
      }
      throw err;
    }
  }
  throw new Error('Gemini API overloaded: The model could not be reached after multiple retries.');
}

// ─── Gemini Response Schemas (OpenAPI 3.0 Uppercase Format) ────────────────────

const SchemaResponseSchema = {
  type: 'OBJECT',
  properties: {
    scope: { type: 'STRING', enum: ['PROJECT', 'DATASET', 'TABLE'] },
    dataset: { type: 'STRING' },
    table: { type: 'STRING' }
  },
  required: ['scope']
};

const QueryResponseSchema = {
  type: 'OBJECT',
  properties: {
    sql: { type: 'STRING' },
    suggestedVisualization: { type: 'STRING', enum: [
      'TABLE', 'KPI_CARD',
      // Recharts native
      'LINE_CHART', 'BAR_CHART', 'AREA_CHART', 'SCATTER', 'PIE_CHART',
      'DONUT_CHART', 'COLUMN_CHART', 'HISTOGRAM', 'SPARKLINE',
      'RADAR', 'FUNNEL', 'TREEMAP', 'SANKEY', 'COMPOSED_CHART',
      // Custom SVG
      'GAUGE', 'HEATMAP', 'BOXPLOT', 'CANDLESTICK',
      'VIOLIN', 'DENSITY_PLOT', 'RIDGELINE', 'NETWORK_GRAPH', 'TILE_MAP',
      // Maps
      'GEO_POINT_MAP', 'USA_MAP', 'WORLD_MAP',
    ] },
    xAxis: { type: 'STRING' },
    yAxis: { type: 'ARRAY', items: { type: 'STRING' } },
    notableFindings: { type: 'STRING' },
    resultSummary: { type: 'STRING' }
  },
  required: ['sql', 'suggestedVisualization']
};

const SelfReviewResponseSchema = {
  type: 'OBJECT',
  properties: {
    improvedHeadline: { type: 'STRING' },
    additionalInsight: { type: 'STRING' },
    betterVisualization: { type: 'STRING', enum: [
      'TABLE', 'KPI_CARD',
      'LINE_CHART', 'BAR_CHART', 'AREA_CHART', 'SCATTER', 'PIE_CHART',
      'DONUT_CHART', 'COLUMN_CHART', 'HISTOGRAM', 'SPARKLINE',
      'RADAR', 'FUNNEL', 'TREEMAP', 'SANKEY', 'COMPOSED_CHART',
      'GAUGE', 'HEATMAP', 'BOXPLOT', 'CANDLESTICK',
      'VIOLIN', 'DENSITY_PLOT', 'RIDGELINE', 'NETWORK_GRAPH', 'TILE_MAP',
      'GEO_POINT_MAP', 'USA_MAP', 'WORLD_MAP',
    ] },
    improvedXAxis: { type: 'STRING' },
    improvedYAxis: { type: 'ARRAY', items: { type: 'STRING' } },
    highlightColumns: { type: 'ARRAY', items: { type: 'STRING' } },
    deemphasizeColumns: { type: 'ARRAY', items: { type: 'STRING' } },
    designNotes: { type: 'STRING' },
  },
  required: [],
};

const DataManagementResponseSchema = {
  type: 'OBJECT',
  properties: {
    operation: { type: 'STRING', enum: ['DEDUPE', 'DELETE', 'UPDATE', 'FILL_NULLS', 'CREATE_TABLE', 'ALTER_TABLE', 'CREATE_VIEW', 'RENAME', 'COPY_TABLE', 'MERGE', 'PARTITION_TABLE'] },
    executionStrategy: { type: 'STRING', enum: ['DIRECT_EXECUTE', 'PREVIEW_AND_CONFIRM', 'PREVIEW_AND_CONFIRM_DEDUPE'] },
    dataset: { type: 'STRING' },
    table: { type: 'STRING' },
    previewSql: { type: 'STRING' },
    executionSql: { type: 'STRING' },
    completionMessage: { type: 'STRING' },
    tiebreakerColumn: { type: 'STRING' },
    tiebreakerDirection: { type: 'STRING', enum: ['KEEP_LATEST', 'KEEP_EARLIEST'] }
  },
  required: ['operation', 'executionStrategy', 'dataset', 'table', 'executionSql']
};

const DiscoveryResponseSchema = {
  type: 'OBJECT',
  properties: {
    discoveryType: { type: 'STRING', enum: ['SEARCH', 'COMPARISON', 'LINEAGE', 'ER_DIAGRAM'] },
    query: { type: 'STRING' },
    secondTable: { type: 'STRING' },
    tableName: { type: 'STRING' }
  },
  required: ['discoveryType', 'query']
};

const DqIntentSchema = {
  type: 'OBJECT',
  properties: {
    checkType: { type: 'STRING', enum: ['PROFILE', 'NULLS', 'DUPLICATES', 'FRESHNESS', 'COMPLETENESS', 'RANGE_VALIDATION', 'REFERENTIAL_INTEGRITY', 'SCHEMA_DRIFT'] },
    table: { type: 'STRING' },
    dataset: { type: 'STRING' }
  },
  required: ['checkType']
};

const MonitoringIntentSchema = {
  type: 'OBJECT',
  properties: {
    monitoringType: { type: 'STRING', enum: ['JOBS', 'STORAGE', 'SLOTS', 'QUERY_PLAN', 'ALERT', 'STORAGE_BREAKDOWN', 'ACCESS_PATTERNS', 'COST_ANALYSIS', 'FRESHNESS'] },
    jobId: { type: 'STRING' },
    table: { type: 'STRING' },
    dataset: { type: 'STRING' }
  },
  required: ['monitoringType']
};

const DataLoadingIntentSchema = {
  type: 'OBJECT',
  properties: {
    operationType: { type: 'STRING', enum: ['EXPORT_CSV', 'EXPORT_SHEETS', 'SCHEDULE', 'SAVED_QUERY', 'SHARE'] },
    tableName: { type: 'STRING' },
    sql: { type: 'STRING' },
    displayName: { type: 'STRING' },
    schedule: { type: 'STRING' },
  },
  required: ['operationType']
};

const IntentClassifierSchema = {
  type: 'OBJECT',
  properties: {
    isMultistep: { type: 'BOOLEAN' },
    skill: { type: 'STRING', enum: ['schema', 'query', 'data-management', 'data-quality', 'discovery', 'monitoring', 'data-loading'] },
    steps: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          skill: { type: 'STRING', enum: ['schema', 'query', 'data-management', 'data-quality', 'discovery', 'monitoring', 'data-loading'] },
          description: { type: 'STRING' },
          prompt: { type: 'STRING' }
        },
        required: ['skill', 'description', 'prompt']
      }
    }
  },
  required: ['isMultistep', 'skill']
};

async function getAvailableDatasets(project: string): Promise<string[]> {
  try {
    const schema = await fetchSchema(undefined, undefined, project);
    return schema.columns
      .map((c) => c.name)
      .filter((name) => name && name.toLowerCase() !== project.toLowerCase());
  } catch {
    return [];
  }
}

function resolveDefaultDatasetFromList(available: string[], contextDataset?: string, project?: string): string {
  if (contextDataset && project && contextDataset.toLowerCase() === project.toLowerCase()) {
    return ''; // context dataset is actually the project name -- ignore it
  }
  return contextDataset || '';
}

async function resolveDefaultDataset(project: string, contextDataset?: string): Promise<string> {
  const available = await getAvailableDatasets(project);
  return resolveDefaultDatasetFromList(available, contextDataset, project);
}

/**
 * Scan the user's message for a known dataset name from the available list.
 * Matches case-insensitively using word boundaries to avoid substring false
 * positives. Returns the first matched dataset name (in its canonical casing)
 * or undefined if none found.
 */
function extractDatasetFromMessage(message: string, available: string[]): string | undefined {
  if (!available.length) return undefined;
  // Sort by length descending so longer names match first (e.g., "formula_1_data"
  // is preferred over "formula_1" if both exist).
  const sorted = [...available].sort((a, b) => b.length - a.length);
  for (const ds of sorted) {
    const escaped = ds.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(message)) return ds;
  }
  return undefined;
}

// ─── Intent classification ────────────────────────────────────────────────────
// A single Gemini call classifies the target skill AND detects multistep requests.
// Falls back to keyword-based classifyIntent if the LLM call fails.

// ─── Orchestrator client class ────────────────────────────────────────────────

export interface ProcessMessageArgs {
  message: string;
  history: ChatMessage[];
  context?: {
    lastSkill?: SkillName;
    lastResultRef?: string;
    lastTable?: string;
    dataset?: string;
    project?: string;
    uid?: string;
    confirmedPayload?: DataManagementResult;
    forcedSkill?: SkillName;
    resolvedDataset?: string;
    availableDatasets?: string[];
    // Handoff chain: full envelope context from chip clicks (§B)
    handoffContext?: Record<string, unknown>;
  };
  onStatus?: (status: string) => void;
}

export interface OrchestrationResult {
  envelopes: CompositionEnvelope[];
  skill?: SkillName;
}

export class ChatOrchestrator {
  static async processMessage({ message, history, context, onStatus }: ProcessMessageArgs): Promise<OrchestrationResult> {
    // ── Handle confirmation responses ───────────────────────────────────────
    if (context?.confirmedPayload && 'executionSql' in context.confirmedPayload) {
      const confirmed = context.confirmedPayload;
      const project = context?.project || '';
      const envelopes = await executeConfirmedOperation(confirmed, project);
      return { envelopes };
    }

    const project = context?.project || '';

    // ── Resolve referential language ─────────────────────────────────────────
    const resolvedMessage = resolveReferences(message, context);

    let resolvedDataset = context?.resolvedDataset;
    let availableDatasets = context?.availableDatasets;

    // ── Classify intent ────────────────────────────────────────────────────────
    // Try keyword-based classification first to avoid an unnecessary Gemini
    // round-trip for obvious requests (e.g., "list my datasets").
    let skill = context?.forcedSkill;
    if (!skill) {
      const keywordResult = classifyIntent(resolvedMessage, context);
      if (keywordResult.confidence === 'high') {
        skill = keywordResult.skill;
        // Still need available datasets for downstream handlers
        if (!availableDatasets) {
          const available = await getAvailableDatasets(project);
          availableDatasets = available;
          resolvedDataset = resolvedDataset ?? resolveDefaultDatasetFromList(available, context?.dataset, project);
        }
      } else {
        // Low/medium confidence or ambiguous: fall back to LLM intent classifier
        if (keywordResult.ambiguousReadWrite) {
          onStatus?.('Analyzing intent (ambiguous read/write signals detected)...');
        }
        try {
          const available = availableDatasets ?? await getAvailableDatasets(project);
          const dataset = resolvedDataset ?? resolveDefaultDatasetFromList(available, context?.dataset, project);
          availableDatasets = available;
          resolvedDataset = dataset;
          const messages = history.slice(-6).map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          }));

          onStatus?.(`Classifying intent for: "${resolvedMessage.slice(0, 80)}${resolvedMessage.length > 80 ? '...' : ''}"`);

          const routingRef = await loadSkillDoc('intent-routing');

          const classifierPrompt = `You are the intent classifier for a BigQuery AI assistant.
You have two jobs:
1. Classify which SKILL should handle the user's request.
2. Detect if the request requires MULTIPLE DISTINCT ACTIONS (multistep).

Use the following routing reference to determine the correct skill:

${routingRef}

MULTISTEP RULES:
- A request with ONE VERB acting on ONE OBJECT is NEVER multistep.
- Only return isMultistep: true when the message contains EXPLICIT multi-action language: 'and then', 'after that', 'first...then', 'followed by', 'next', or a numbered list of distinct actions.
- When isMultistep is false, return an empty steps array.
- When isMultistep is true, decompose into steps. Each step needs: skill, description (short label), prompt (fully self-contained with explicit table refs like \`${project}.${dataset}.tablename\`).
- NEVER decompose an analytical question into a schema step followed by a query step. The query skill already loads schema context internally. Examples that are SINGLE-STEP query (NOT multistep): "show sales at store X over time", "analyze revenue by month", "what are the top products", "sales trend for category Y".
- Analytical phrases like 'analyze', 'show me', 'trend', 'over time', 'breakdown', 'compare', 'top N' are READ-ONLY query operations, NEVER data-management.

Current active project: ${project}
Current active dataset: ${dataset}
Available datasets: ${available.join(', ')}`;

          const result = await callGemini({
            systemInstruction: classifierPrompt,
            messages: [...messages, { role: 'user' as const, content: resolvedMessage }],
            schema: IntentClassifierSchema,
            project,
          });

          if (result && result.isMultistep && result.steps && result.steps.length > 1) {
            const envelope: CompositionEnvelope = {
              id: 'workflow_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
              skill: 'multistep',
              headline: {
                text: `Created a workflow with ${result.steps.length} steps to complete your request.`,
                tone: 'NEUTRAL',
                basis: 'STATUS',
              },
              primaryArtifact: {
                type: 'MULTISTEP_VIEW',
                data: {
                  steps: result.steps,
                },
              },
              provenance: {
                visibility: 'COLLAPSED',
              },
              nextActions: [],
            };
            return { envelopes: [envelope], skill: 'multistep' };
          }

          // Single-step: use the LLM-classified skill
          if (result && result.skill) {
            skill = result.skill as SkillName;
          }
        } catch (e) {
          console.warn('[Intent classifier failed, falling back to keyword router]', e);
        }

        // Final fallback: use the keyword result even if low confidence
        if (!skill) {
          skill = keywordResult.skill;
        }
      }
    }

    const skillLabels: Record<string, string> = {
      'schema': 'schema lookup',
      'query': 'query builder',
      'data-management': 'data management',
      'data-quality': 'data quality check',
      'monitoring': 'monitoring',
      'discovery': 'discovery search',
      'data-loading': 'data export',
    };
    onStatus?.(`Matched skill: ${skillLabels[skill] || skill}`);

    // ── Dispatch to skill ─────────────────────────────────────────────────────
    let envelopes: CompositionEnvelope[] = [];

    // Pass pre-resolved context to handlers to avoid redundant fetches
    const enrichedContext = { ...context, resolvedDataset, availableDatasets };

    switch (skill) {
      case 'schema':
        envelopes = await handleSchema(resolvedMessage, enrichedContext, onStatus);
        break;
      case 'query':
        envelopes = await handleQuery(resolvedMessage, history, enrichedContext, onStatus);
        break;
      case 'data-management':
        envelopes = await handleDataManagement(resolvedMessage, history, enrichedContext, onStatus);
        break;
      case 'data-quality':
        envelopes = await handleDataQuality(resolvedMessage, enrichedContext, onStatus);
        break;
      case 'monitoring':
        envelopes = await handleMonitoring(resolvedMessage, enrichedContext, onStatus);
        break;
      case 'discovery':
        envelopes = await handleDiscovery(resolvedMessage, enrichedContext, onStatus);
        break;
      case 'data-loading':
        envelopes = await handleDataLoading(resolvedMessage, enrichedContext, onStatus);
        break;
      default:
        envelopes = await handleQuery(resolvedMessage, history, enrichedContext, onStatus);
    }

    // ── Self-review: run for skills that benefit from it ─────────────────────
    // Skip review for fast-path metadata results (simple INFORMATION_SCHEMA
    // queries with canned SQL) since the output is straightforward tabular data.
    if (envelopes.length > 0) {
      const needsReview = envelopes.some((env) =>
        !env.requiresConfirmation && !env.skipSelfReview
      );
      if (needsReview) {
        onStatus?.('Reviewing output quality...');
        const reviewed = await Promise.all(
          envelopes.map((env) =>
            (env.requiresConfirmation || env.skipSelfReview)
              ? Promise.resolve(env)
              : selfReviewEnvelope(env, resolvedMessage, project, onStatus)
          )
        );
        envelopes = reviewed;
      }
    }

    return { envelopes, skill };
  }
}

async function buildSchemaContext(project: string, dataset: string): Promise<string> {
  if (!dataset) return '';
  try {
    const datasetSchema = await fetchSchema(dataset, undefined, project);
    const tables = datasetSchema.columns.map((col) => col.name);
    if (!tables.length) return '';

    const schemaPromises = tables.slice(0, 5).map(async (tableId) => {
      try {
        const tableSchema = await fetchSchema(dataset, tableId, project);
        const colString = tableSchema.columns
          .map((col) => `${col.name} (${col.type})`)
          .join(', ');
        return `Table \`${project}.${dataset}.${tableId}\` columns: ${colString}`;
      } catch {
        return null;
      }
    });

    const schemaStrings = (await Promise.all(schemaPromises)).filter(Boolean);
    if (schemaStrings.length > 0) {
      return `\nTable Schemas in default dataset:\n${schemaStrings.join('\n')}\n`;
    }
  } catch (err) {
    console.warn('[buildSchemaContext failed]', err);
  }
  return '';
}

// ─── Schema handler ────────────────────────────────────────────────────────────

// Keyword-based scope classifier -- avoids a Gemini round-trip for obvious cases.
const DATASET_LIST_SIGNALS = [
  'list datasets', 'show datasets', 'list my datasets', 'what datasets',
  'list of datasets', 'list all datasets', 'show me datasets',
  'show me the datasets', 'list of all datasets', 'datasets in',
  'datasets of',
];
const TABLE_LIST_SIGNALS = [
  'list tables', 'show tables', 'what tables', 'list of tables',
  'list all tables', 'show me tables', 'show me the tables',
  'list of all tables', 'tables in', 'tables of',
];
const TABLE_DESCRIBE_SIGNALS = [
  'describe', 'schema', 'what fields', 'what columns', 'show columns',
  'list columns', 'column types', 'structure', 'what is in', "what's in",
  'tell me more', 'tell me about', 'show me more about', 'more about',
  'inspect', 'details about', 'explore', 'look at',
  'find the', 'find dataset',
];

// Enrichment detection: signals that the user wants more than a basic listing
const ENRICHMENT_PATTERNS = [
  /\bwith\b(?!out)/i,
  /\bsorted\b/i,
  /\border(?:ed)?\s+by\b/i,
  /\bonly\b/i,
  /\bthat\s+have\b/i,
  /\bmore\s+than\b/i,
  /\bless\s+than\b/i,
  /\bfor\s+each\b/i,
  /\band\s+(their|its|how|row|table|column|last|size|number|count)\b/i,
  /\bincluding\b/i,
  /\balong\b/i,
  /\blargest\b/i,
  /\bsmallest\b/i,
  /\bbiggest\b/i,
  /\bhow\s+many\b/i,
];

const EnrichedSchemaQuerySchema = {
  type: 'OBJECT',
  properties: {
    sql: { type: 'STRING' },
    resultSummary: { type: 'STRING' },
  },
  required: ['sql', 'resultSummary']
};

// ─── Fast-path enrichment: generate SQL directly for common patterns ──────────
// Avoids a Gemini round-trip for well-known enrichment requests.

interface FastEnrichResult {
  sql: string;
  resultSummary: string;
}

function tryFastEnrichment(
  message: string,
  project: string,
  resolvedDataset: string | undefined,
  region: string,
): FastEnrichResult | null {
  const lower = message.toLowerCase();
  const isProjectScope = !resolvedDataset;

  // ── PROJECT scope: datasets with table counts, sizes, etc. ──
  if (isProjectScope) {
    // "list datasets with the number of tables" / "datasets and their table count"
    if (/\b(table|tables)\b/i.test(lower) && /\b(count|number|how\s+many|each)\b/i.test(lower)) {
      return {
        sql: `SELECT table_schema AS dataset_name, COUNT(*) AS table_count FROM \`${project}\`.\`region-${region}\`.INFORMATION_SCHEMA.TABLES GROUP BY table_schema ORDER BY table_count DESC`,
        resultSummary: `Datasets in ${project} with number of tables in each`,
      };
    }
    // "datasets with size" / "datasets sorted by size" / "largest datasets"
    if (/\b(sizes?|bytes|storage|largest|biggest|smallest)\b/i.test(lower)) {
      return {
        sql: `SELECT table_schema AS dataset_name, COUNT(*) AS table_count, SUM(total_logical_bytes) AS total_size_bytes, SUM(total_rows) AS total_rows FROM \`${project}\`.\`region-${region}\`.INFORMATION_SCHEMA.TABLE_STORAGE GROUP BY table_schema ORDER BY total_size_bytes DESC`,
        resultSummary: `Datasets in ${project} with size and row counts`,
      };
    }
    // "datasets with row count" / "datasets and how many rows"
    if (/\b(row|rows|row.?count)\b/i.test(lower)) {
      return {
        sql: `SELECT table_schema AS dataset_name, COUNT(*) AS table_count, SUM(total_rows) AS total_rows FROM \`${project}\`.\`region-${region}\`.INFORMATION_SCHEMA.TABLE_STORAGE GROUP BY table_schema ORDER BY total_rows DESC`,
        resultSummary: `Datasets in ${project} with table and row counts`,
      };
    }
  }

  // ── DATASET scope: tables with row counts, sizes, etc. ──
  if (!isProjectScope) {
    const dsRef = `\`${project}.${resolvedDataset}\``;
    // "tables with row count" / "how many rows in each table"
    if (/\b(row|rows|row.?count)\b/i.test(lower) && !/\b(size|bytes|storage)\b/i.test(lower)) {
      return {
        sql: `SELECT table_name, total_rows AS row_count FROM ${dsRef}.INFORMATION_SCHEMA.TABLE_STORAGE ORDER BY total_rows DESC`,
        resultSummary: `Tables in ${resolvedDataset} with row counts`,
      };
    }
    // "tables with size" / "largest tables"
    if (/\b(size|bytes|storage|largest|biggest|smallest)\b/i.test(lower)) {
      return {
        sql: `SELECT table_name, total_rows AS row_count, total_logical_bytes AS size_bytes FROM ${dsRef}.INFORMATION_SCHEMA.TABLE_STORAGE ORDER BY total_logical_bytes DESC`,
        resultSummary: `Tables in ${resolvedDataset} with sizes and row counts`,
      };
    }
    // "tables with column count" / "how many columns"
    if (/\b(column|columns|column.?count|field|fields)\b/i.test(lower)) {
      return {
        sql: `SELECT table_name, COUNT(*) AS column_count FROM ${dsRef}.INFORMATION_SCHEMA.COLUMNS GROUP BY table_name ORDER BY column_count DESC`,
        resultSummary: `Tables in ${resolvedDataset} with column counts`,
      };
    }
  }

  return null; // no fast-path match -- fall back to Gemini
}


// Try to extract a dataset or table identifier from the message.
// Handles patterns like "tables in ecomm", "describe orders", "schema of users",
// and backtick-quoted refs like `project.dataset.table`.
function extractSchemaIdentifiers(
  message: string,
  contextDataset?: string,
  availableDatasets?: string[],
): { scope: 'PROJECT' | 'DATASET' | 'TABLE'; dataset?: string; table?: string } | null {
  const lower = message.toLowerCase();

  // Common pronouns that should never be treated as identifiers
  const PRONOUNS = new Set(['it', 'them', 'that', 'this', 'those', 'these', 'its', 'they']);

  // PROJECT scope: listing datasets
  if (DATASET_LIST_SIGNALS.some((s) => lower.includes(s))) {
    return { scope: 'PROJECT' };
  }

  // Named dataset lookup: "find the iowa_liquor_sales dataset", "find dataset ecomm"
  // Check this early so "find the X dataset and show me what's in it" resolves X
  // as a dataset before the TABLE_DESCRIBE_SIGNALS path captures the pronoun "it".
  const findDatasetMatch = message.match(
    /\bfind\s+(?:the\s+)?(?:dataset\s+)?[`]?(\w[\w-]*)[`]?(?:\s+dataset)?\b/i
  );
  if (findDatasetMatch) {
    const name = findDatasetMatch[1];
    if (!PRONOUNS.has(name.toLowerCase()) && name.toLowerCase() !== 'the') {
      // Check if it matches a known dataset
      if (availableDatasets && availableDatasets.some((ds) => ds.toLowerCase() === name.toLowerCase())) {
        return { scope: 'DATASET', dataset: name };
      }
      // Even if not in the cached list, treat it as a dataset lookup
      // (the user explicitly said "dataset")
      if (/\bdataset\b/i.test(message)) {
        return { scope: 'DATASET', dataset: name };
      }
    }
  }

  // DATASET scope: listing tables -- try to extract dataset name
  if (TABLE_LIST_SIGNALS.some((s) => lower.includes(s))) {
    // "tables in ecomm", "list tables in my_dataset", "tables in the formula_1 dataset"
    // Allow optional filler words (e.g., "are", "available", "exist") between "tables" and the preposition
    const dsMatch = message.match(/\btables?\s+(?:\w+\s+)*?(?:in|of|from)\s+(?:the\s+|a\s+|an\s+)?[`]?(\w[\w-]*)[`]?/i);
    let extracted = dsMatch?.[1];
    // Filter out noise words that the regex might capture instead of a dataset name
    if (extracted && ['dataset', 'project', 'the', 'this', 'my'].includes(extracted.toLowerCase())) {
      extracted = undefined;
    }
    // Validate against known datasets; fall back to context dataset if not recognized
    if (extracted && availableDatasets?.some((ds) => ds.toLowerCase() === extracted!.toLowerCase())) {
      return { scope: 'DATASET', dataset: extracted };
    }
    // If regex didn't capture a dataset name, try scanning for known dataset names in the message
    if (!extracted && availableDatasets) {
      const scanned = extractDatasetFromMessage(message, availableDatasets);
      if (scanned) {
        return { scope: 'DATASET', dataset: scanned };
      }
    }
    return { scope: 'DATASET', dataset: extracted ?? contextDataset };
  }

  // TABLE scope: describing a specific table
  if (TABLE_DESCRIBE_SIGNALS.some((s) => lower.includes(s))) {
    // Guard: if the message contains a column = value comparison,
    // it's a filter request, not a table lookup. Bail out.
    if (/[`']?\w+[`']?\s*=\s*(?:'[^']*'|\d+)/i.test(message)) {
      return null;
    }

    // Backtick-quoted fully qualified ref: `project.dataset.table`
    const fqMatch = message.match(/`(\w[\w-]*)\.(\w[\w-]*)\.(\w[\w]*)`/);
    if (fqMatch) {
      return { scope: 'TABLE', dataset: fqMatch[2], table: fqMatch[3] };
    }
    // Dotted dataset.table ref (no backticks): "show me more about iowa_liquor_sales.sales_deduped"
    // Must be checked BEFORE the single-name regex, which would stop at the dot.
    const dottedMatch = message.match(
      /(?:describe|schema\s+(?:of|for)|(?:tell|more|details)\s+(?:me\s+)?(?:more\s+)?about|inspect|explore|look\s+at|what'?s?\s+in|find\s+(?:the\s+)?)\s*(?:the\s+)?[`]?(\w[\w-]*)\.(\w[\w-]*)[`]?/i
    );
    if (dottedMatch) {
      return { scope: 'TABLE', dataset: dottedMatch[1], table: dottedMatch[2] };
    }
    // "describe orders", "schema of users", "tell me about orders"
    const tblMatch = message.match(
      /(?:describe|schema\s+(?:of|for)|(?:tell|more|details)\s+(?:me\s+)?(?:more\s+)?about|inspect|explore|look\s+at|what'?s?\s+in|find\s+(?:the\s+)?)\s*(?:the\s+)?[`]?(\w[\w-]*)[`]?/i
    );
    if (tblMatch) {
      const name = tblMatch[1];
      // Skip pronouns -- these are referential ("what's in it") not identifiers
      if (PRONOUNS.has(name.toLowerCase())) {
        return null; // fall back to Gemini for pronoun resolution
      }
      if (availableDatasets && availableDatasets.some((ds) => ds.toLowerCase() === name.toLowerCase())) {
        return { scope: 'DATASET', dataset: name };
      }
      return { scope: 'TABLE', dataset: contextDataset, table: name };
    }
  }

  return null; // ambiguous -- fall back to Gemini
}

async function handleSchema(
  message: string,
  context?: { project?: string; dataset?: string; availableDatasets?: string[] },
  onStatus?: (status: string) => void
): Promise<CompositionEnvelope[]> {
  const project = context?.project || '';

  const available = context?.availableDatasets ?? await getAvailableDatasets(project);

  // Try fast keyword extraction first
  const fast = extractSchemaIdentifiers(message, context?.dataset, available);

  let resolvedDataset: string | undefined;
  let table: string | undefined;

  if (fast) {
    resolvedDataset = fast.dataset ?? context?.dataset ?? undefined;
    table = fast.table;
    if (fast.scope === 'PROJECT') {
      resolvedDataset = undefined; // project-level: no dataset
      table = undefined;
    }
  } else {
    // Fall back to Gemini for ambiguous messages
    const skillDoc = await loadSkillDoc('schema');
    onStatus?.(`Analyzing schema request using LLM (project: ${project}${context?.dataset ? `, dataset: ${context.dataset}` : ''})...`);
    const intent = await callGemini({
      systemInstruction: `${skillDoc}\n\nExtract the requested scope from the user's message. Dataset and table should be the BigQuery identifiers mentioned. If none mentioned, return null. The active project is: ${project}${context?.dataset ? `. The active dataset context is: ${context.dataset}` : ''}.`,
      prompt: message,
      schema: SchemaResponseSchema,
      project,
    });
    resolvedDataset = intent.dataset ?? context?.dataset ?? undefined;
    table = intent.table ?? undefined;
  }

  // If the extracted/inferred table name is actually an available dataset in the project,
  // treat it as a dataset scope lookup instead of a table lookup.
  if (table) {
    const matchedDataset = available.find((ds) => ds.toLowerCase() === table!.toLowerCase());
    if (matchedDataset) {
      resolvedDataset = matchedDataset;
      table = undefined;
    }
  }

  if (table && !resolvedDataset) {
    resolvedDataset = await resolveDefaultDataset(project, undefined);
  }

  // Enriched listing: when the user asks for more than a basic list,
  // try a fast-path first (direct SQL), then fall back to Gemini for unusual requests.
  // This applies to both project-scope (datasets with sizes/rows) and dataset-scope.
  if (!table && ENRICHMENT_PATTERNS.some((p) => p.test(message))) {
    // Fast-path: generate SQL directly for common enrichment patterns
    const bqRegion = await detectBqRegion(project);
    const fastResult = tryFastEnrichment(message, project, resolvedDataset, bqRegion);
    if (fastResult) {
      onStatus?.(`Running INFORMATION_SCHEMA query against ${resolvedDataset || project}...`);
      const executed = await executeQuery(fastResult.sql, project);

      const queryResult: QueryResult = {
        skill: 'query',
        sql: fastResult.sql,
        requiresConfirmation: false,
        costConfirm: null,
        columns: executed.columns,
        rows: executed.rows,
        rowCount: executed.rowCount,
        jobId: executed.jobId || undefined,
        totalBytesProcessed: 0,
        costTier: 1,
        suggestedVisualization: 'TABLE',
        notableFindings: null,
        resultSummary: fastResult.resultSummary,
      };

      const envelope = compose('query', queryResult);
      envelope.skipSelfReview = true;
      return [envelope];
    }

    // Slow path: ask Gemini to generate the SQL for complex enrichment requests
    onStatus?.(`Building enriched query for ${resolvedDataset ? `dataset ${resolvedDataset}` : `project ${project}`}...`);

    const isProjectScope = !resolvedDataset;
    const dsRef = isProjectScope
      ? `\`${project}\`.\`region-${bqRegion}\``
      : `\`${project}.${resolvedDataset}\``;
    const scopeLabel = isProjectScope ? `project \`${project}\`` : `dataset \`${resolvedDataset}\``;

    const enrichPrompt = `Generate a BigQuery INFORMATION_SCHEMA SQL query that fulfills the user's request.

The user is requesting a listing within ${scopeLabel} with additional requirements.

Project: ${project}
${resolvedDataset ? `Dataset: ${resolvedDataset}` : `Scope: project-wide (all datasets)`}

INFORMATION_SCHEMA reference:
- Tables: SELECT * FROM ${dsRef}.INFORMATION_SCHEMA.TABLES
- Storage: SELECT table_name, total_rows, total_logical_bytes FROM ${dsRef}.INFORMATION_SCHEMA.TABLE_STORAGE
- Columns: SELECT table_name, column_name, data_type, is_nullable FROM ${dsRef}.INFORMATION_SCHEMA.COLUMNS
${isProjectScope ? `- For project-scope, use table_schema column to identify datasets.` : ''}

Rules:
- The FIRST column MUST be the primary entity identifier: alias as '${isProjectScope ? 'dataset_name' : 'table_name'}'.
- Use descriptive aliases for all other columns (e.g., 'table_count', 'total_size_bytes', 'row_count', 'last_modified').
- Always wrap identifiers containing hyphens in backticks.
- Return valid GoogleSQL only.`;

    const plan = await callGemini({
      systemInstruction: enrichPrompt,
      prompt: message,
      schema: EnrichedSchemaQuerySchema,
      project,
    });

    onStatus?.(`Running enriched INFORMATION_SCHEMA query against ${resolvedDataset || project}...`);
    const executed = await executeQuery(plan.sql, project);

    const queryResult: QueryResult = {
      skill: 'query',
      sql: plan.sql,
      requiresConfirmation: false,
      costConfirm: null,
      columns: executed.columns,
      rows: executed.rows,
      rowCount: executed.rowCount,
      jobId: executed.jobId || undefined,
      totalBytesProcessed: 0,
      costTier: 1,
      suggestedVisualization: 'TABLE',
      notableFindings: null,
      resultSummary: plan.resultSummary,
    };

    return [compose('query', queryResult)];
  }

  onStatus?.(table
    ? `Fetching schema for table ${resolvedDataset ? `${resolvedDataset}.` : ''}${table}...`
    : resolvedDataset
      ? `Listing tables in dataset ${resolvedDataset}...`
      : `Listing datasets in project ${project}...`
  );

  // For table-level lookups, if the table isn't found in the assumed dataset,
  // search other datasets in parallel.
  if (table) {
    try {
      const result = await fetchSchema(resolvedDataset, table, project);
      return [compose('schema', result)];
    } catch (err: any) {
      if (err.message?.includes('Not found')) {
        onStatus?.(`Table ${table} not found in ${resolvedDataset}, searching other datasets...`);
        const allDatasets = await getAvailableDatasets(project);
        const otherDatasets = allDatasets.filter((ds) => ds !== resolvedDataset);
        const results = await Promise.all(
          otherDatasets.map((ds) =>
            fetchSchema(ds, table, project).catch(() => null)
          )
        );
        const found = results.find((r) => r !== null);
        if (found) return [compose('schema', found)];
      }
      throw err;
    }
  }

  const result = await fetchSchema(
    resolvedDataset,
    table,
    project,
  );

  const envelope = compose('schema', result);
  return [envelope];
}
// ─── Self-review refinement ───────────────────────────────────────────────────
// A single Gemini pass that reviews any composed output from the user's
// perspective across comprehension, completeness, presentation, and visual
// design -- then optionally improves it before the envelope reaches the UI.

function buildReviewSnapshot(envelope: CompositionEnvelope): Record<string, unknown> {
  const data = envelope.primaryArtifact.data as Record<string, unknown> | null;
  const snapshot: Record<string, unknown> = {
    skill: envelope.skill,
    artifactType: envelope.primaryArtifact.type,
    headline: envelope.headline.text,
    headlineTone: envelope.headline.tone,
    insight: envelope.insight ?? null,
    nextActions: envelope.nextActions.map((a) => a.label),
  };

  if (!data) return snapshot;

  // Query-specific fields
  if ('rows' in data && 'columns' in data) {
    const qd = data as unknown as QueryResult;
    snapshot.visualization = qd.suggestedVisualization;
    snapshot.columns = qd.columns;
    snapshot.rowCount = qd.rowCount;
    snapshot.sampleRows = qd.rows.slice(0, 5).map((row) =>
      Object.fromEntries(qd.columns.map((col, i) => [col, (row as unknown[])[i]]))
    );
    snapshot.xAxis = qd.xAxis ?? null;
    snapshot.yAxis = qd.yAxis ?? null;
    snapshot.notableFindings = qd.notableFindings ?? null;
  }

  // Schema-specific fields
  if ('scope' in data && 'columns' in data && data.skill === 'schema') {
    snapshot.scope = data.scope;
    snapshot.dataset = data.dataset ?? null;
    snapshot.table = data.table ?? null;
    const cols = data.columns as Array<{ name: string; type: string }>;
    snapshot.columnCount = cols.length;
    snapshot.columnSample = cols.slice(0, 10).map((c) => `${c.name} (${c.type})`);
  }

  // Data quality fields
  if ('findings' in data && data.skill === 'data-quality') {
    const dq = data as unknown as DataQualityResult;
    snapshot.checkType = dq.checkType;
    snapshot.table = dq.table;
    snapshot.issuesFound = dq.summary.issuesFound;
    snapshot.rowsScanned = dq.summary.rowsScanned;
    snapshot.findingSample = dq.findings.slice(0, 8).map((f) =>
      `${f.column}: ${f.metric}=${f.value} (${f.severity})`
    );
  }

  // Monitoring fields (only for MonitoringResult, not specialized subtypes like StorageBreakdownResult)
  if ('items' in data && data.skill === 'monitoring' && 'summary' in data) {
    const mon = data as unknown as MonitoringResult;
    snapshot.totalJobs = mon.summary.totalJobs;
    snapshot.errorCount = mon.summary.errorCount;
    snapshot.totalBytesProcessed = mon.summary.totalBytesProcessed;
  }

  // Discovery fields
  if ('results' in data && data.skill === 'discovery') {
    const disc = data as unknown as DiscoveryResult;
    snapshot.discoveryType = disc.discoveryType;
    snapshot.resultCount = disc.results.length;
    snapshot.resultSample = disc.results.slice(0, 5).map((r) => `${r.type}: ${r.ref}`);
  }

  return snapshot;
}

async function selfReviewEnvelope(
  envelope: CompositionEnvelope,
  userMessage: string,
  project: string,
  _onStatus?: (status: string) => void,
): Promise<CompositionEnvelope> {
  const snapshot = buildReviewSnapshot(envelope);

  const reviewPrompt = `You are a senior data analyst, expert graphic designer, and UI designer reviewing output from a BigQuery data assistant. A user asked a question and the assistant produced a result. Your job is to review the output and decide if anything should be improved BEFORE it reaches the user.

The output's skill type is: ${envelope.skill}
The artifact type is: ${envelope.primaryArtifact.type}

Evaluate these four dimensions:

1. COMPREHENSION: Is the headline clear and informative? Does it tell the user what they are looking at in plain language? If not, write a better one. A good headline leads with the key finding or answers the user's question directly -- not just "N rows from table" or generic status text.

2. COMPLETENESS: Would a user naturally want additional context? For example: percentage changes, comparisons to baselines, time range annotations, totals, callouts about outliers, or a note about what they should look at first. If so, write a short additionalInsight (1-2 sentences) that adds this context.

3. PRESENTATION: Is the artifact type / visualization the best fit for this data and the user's intent? For query results, consider number of rows, columns, time axes, categorical vs numeric data, part-to-whole relationships, etc. For schema/monitoring/discovery/data-quality results, consider whether the current view type communicates the most important information effectively. Only suggest a betterVisualization if a different type would genuinely improve comprehension -- this field only applies to query skill results.

4. VISUAL DESIGN & LAYOUT: Think as an expert graphic designer and UI designer. Evaluate the overall presentation quality:
   - Is the headline written in a way that feels polished and professional, not generic or robotic?
   - Would the output feel like it came from a premium, highly-designed application?
   - For data with columns: which columns/series are the most important to the user's question and should be visually emphasized? Which are supporting detail that should be de-emphasized so the layout feels clean and focused?
   - Write a designNotes field with brief, actionable guidance on spacing, hierarchy, or emphasis that would elevate the visual quality (e.g., "Lead with the total revenue KPI, group the breakdown below", "De-emphasize the ID columns to reduce clutter").

Rules:
- Only return fields where you have an actual improvement. Leave fields empty/null if the current output is already good.
- Do not repeat what is already there -- only override if you can make it measurably better.
- Keep headlines under 120 characters. Write them as a human analyst would speak, not as a system status message.
- Keep insights under 200 characters.
- designNotes should be under 200 characters.
- For highlightColumns and deemphasizeColumns, use exact column names from the data (only applies to query results with columns).`;

  try {
    const review = await callGemini({
      systemInstruction: reviewPrompt,
      prompt: `User's question: "${userMessage}"

Current output snapshot:
${JSON.stringify(snapshot, null, 2)}`,
      schema: SelfReviewResponseSchema,
      project,
    });

    if (!review) return envelope;

    // Apply non-empty overrides
    const updated = { ...envelope };
    updated.headline = { ...envelope.headline };
    updated.primaryArtifact = { ...envelope.primaryArtifact };

    if (review.improvedHeadline) {
      updated.headline.text = review.improvedHeadline;
    }

    if (review.additionalInsight) {
      updated.insight = review.additionalInsight;
    }

    // Visualization override only applies to query-skill envelopes
    const data = envelope.primaryArtifact.data as Record<string, unknown> | null;
    if (envelope.skill === 'query' && data && 'rows' in data) {
      const qd = data as unknown as QueryResult;

      if (review.betterVisualization && review.betterVisualization !== qd.suggestedVisualization) {
        const updatedData = { ...qd, suggestedVisualization: review.betterVisualization };
        if (review.improvedXAxis) updatedData.xAxis = review.improvedXAxis;
        if (review.improvedYAxis && review.improvedYAxis.length > 0) updatedData.yAxis = review.improvedYAxis;
        const recomposed = compose('query', updatedData);
        if (review.improvedHeadline) recomposed.headline.text = review.improvedHeadline;
        if (review.additionalInsight) recomposed.insight = review.additionalInsight;
        if (review.highlightColumns?.length || review.deemphasizeColumns?.length) {
          recomposed.primaryArtifact.emphasis = {
            highlight: review.highlightColumns ?? [],
            deemphasize: review.deemphasizeColumns ?? [],
          };
        }
        return recomposed;
      }

      // Apply axis overrides without changing visualization type
      if (review.improvedXAxis || (review.improvedYAxis && review.improvedYAxis.length > 0)) {
        const updatedData = { ...qd };
        if (review.improvedXAxis) updatedData.xAxis = review.improvedXAxis;
        if (review.improvedYAxis && review.improvedYAxis.length > 0) updatedData.yAxis = review.improvedYAxis;
        updated.primaryArtifact = { ...updated.primaryArtifact, data: updatedData };
      }
    }

    // Apply visual emphasis (query results with columns)
    if (review.highlightColumns?.length || review.deemphasizeColumns?.length) {
      updated.primaryArtifact.emphasis = {
        highlight: review.highlightColumns ?? [],
        deemphasize: review.deemphasizeColumns ?? [],
      };
    }

    return updated;
  } catch (err) {
    // Self-review is non-fatal -- if it fails, return the original envelope
    console.warn('[self-review failed, returning original]', err);
    return envelope;
  }
}

// ─── Query handler ────────────────────────────────────────────────────────────

async function handleQuery(
  message: string,
  history: ChatMessage[],
  context?: { project?: string; dataset?: string; lastTable?: string; resolvedDataset?: string; availableDatasets?: string[] },
  onStatus?: (status: string) => void
): Promise<CompositionEnvelope[]> {
  const project = context?.project || '';

  // Parallelize: skill doc, dataset resolution, and available datasets
  const [skillDoc, available] = await Promise.all([
    loadSkillDoc('query'),
    context?.availableDatasets ?? getAvailableDatasets(project),
  ]);
  let dataset = context?.resolvedDataset ?? resolveDefaultDatasetFromList(available, context?.dataset, project);
  // If no dataset was pre-selected, try to extract one from the user's message
  // to avoid the LLM misinterpreting natural language (e.g., "the formula_1 dataset").
  if (!dataset) {
    dataset = extractDatasetFromMessage(message, available) ?? '';
  }

  const messages = history.slice(-6).map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  const schemaContext = await buildSchemaContext(project, dataset);

  onStatus?.(`Building SQL for dataset ${dataset} in project ${project}...`);
  const datasetLine = dataset
    ? `The active dataset is: ${dataset}`
    : 'No dataset is pre-selected. Infer the correct dataset from the user\'s prompt and the available datasets listed below.';
  const queryPlan = await callGemini({
    systemInstruction: `${skillDoc}

The BigQuery project is: ${project}
${datasetLine}
The available datasets in project ${project} are: ${available.join(', ')}
${schemaContext}
Always wrap fully qualified table references in literal backticks: \`${project}.DATASET.tablename\` (e.g. \`${project}.ecomm.orders\`). This is CRITICAL to prevent syntax errors when project names contain dashes/hyphens.
Today's date is: ${new Date().toISOString().split('T')[0]}
Also generate a resultSummary field: a brief, contextual one-line summary of what the query results likely show (e.g., 'Revenue by month for the last 12 months' or 'Top 10 customers by order count'). This will be used as the headline shown to the user.

VISUALIZATION SELECTION: Pick the suggestedVisualization that best matches both the data shape AND the user's explicit request. If the user asks for a specific chart type, you MUST use that exact type -- do not substitute a similar one. In particular, "column chart" means COLUMN_CHART (vertical bars) and "bar chart" means BAR_CHART (horizontal bars); these are different chart types and must not be confused. Otherwise use these guidelines:
- TABLE: default for raw data, lists, or when no chart fits.
- KPI_CARD: single aggregate value (count, sum, average).
- LINE_CHART: trends over time, time series.
- BAR_CHART: horizontal bars comparing categories. NOT the same as COLUMN_CHART.
- COLUMN_CHART: vertical bars comparing 5-15 discrete categories. NOT the same as BAR_CHART.
- AREA_CHART: volume/magnitude changes over time, stacked areas.
- SCATTER: correlation between two numeric variables.
- PIE_CHART: part-to-whole composition (3-7 slices).
- DONUT_CHART: part-to-whole with a summary metric in the center.
- HISTOGRAM: frequency distribution of a single numeric column. Query should return individual values or pre-binned ranges.
- SPARKLINE: tiny inline trend for a single metric over time.
- RADAR: multivariate comparison across 3-8 dimensions.
- FUNNEL: sequential stage drop-off (pipeline, conversion).
- TREEMAP: hierarchical part-to-whole by area.
- SANKEY: flow/transition between categories. Query must return source, target, and value columns.
- COMPOSED_CHART: mixed series types (e.g., bars + lines on same axes).
- GAUGE: single KPI value against a target or range.
- HEATMAP: intensity across two categorical dimensions. Query must return row_label, column_label, and value.
- BOXPLOT: distribution comparison showing median, quartiles, outliers.
- CANDLESTICK: OHLC financial data. Query must return date, open, high, low, close columns.
- VIOLIN: distribution shape comparison across categories.
- DENSITY_PLOT: continuous probability distribution of a single variable.
- RIDGELINE: multiple distributions stacked for comparison across groups.
- NETWORK_GRAPH: entity relationships. Query must return source and target columns.
- TILE_MAP: abstract geographic grid with colored tiles.
- GEO_POINT_MAP: data points on a map. Query must return latitude and longitude columns.
- USA_MAP: US state-level data. Query must return a state name or abbreviation column.
- WORLD_MAP: country-level data. Query must return a country name or code column.`,
    messages: [...messages, { role: 'user' as const, content: message }],
    schema: QueryResponseSchema,
    project,
  });

  // Run dry-run first for cost check
  onStatus?.(`Dry-running query to estimate cost (${dataset})...`);
  const costResult = await dryRun(queryPlan.sql, project);

  if (costResult.requiresConfirmation) {
    const result: QueryResult = {
      skill: 'query',
      sql: queryPlan.sql,
      requiresConfirmation: true,
      costConfirm: {
        totalBytesProcessed: costResult.totalBytesProcessed,
        tier: costResult.tier,
        requiresConfirmation: true,
      },
      columns: [],
      rows: [],
      rowCount: 0,
      totalBytesProcessed: costResult.totalBytesProcessed,
      costTier: costResult.tier,
      suggestedVisualization: 'TABLE',
      notableFindings: null,
    };
    return [compose('query', result)];
  }

  // Execute query with auto-retry: if BigQuery returns a query-content error
  // (syntax, unsupported type, etc.), send the error back to Gemini to fix the
  // SQL and retry once.
  let finalSql = queryPlan.sql;
  let executed: Awaited<ReturnType<typeof executeQuery>>;
  try {
    executed = await executeQuery(finalSql, project);
  } catch (firstErr: unknown) {
    const errMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    // Only auto-fix query-content errors, not auth/quota/network issues
    const isQueryError = errMsg.includes('query failed') || errMsg.includes('Syntax error');
    if (!isQueryError) throw firstErr;

    onStatus?.(`Query failed, asking LLM to fix SQL error...`);
    try {
      const fixResult = await callGemini({
        systemInstruction: `You are a BigQuery SQL repair agent. The user ran a query and BigQuery returned an error. Your job is to fix the SQL so it runs successfully. Return ONLY valid GoogleSQL. Do not change the intent of the query -- only fix the error.

Common fixes:
- GEOGRAPHY columns cannot be used with DISTINCT, GROUP BY, or ORDER BY. Cast to ST_ASTEXT() or exclude them.
- STRUCT/ARRAY/JSON columns cannot be used with DISTINCT. Exclude or flatten them.
- Ambiguous column names need table aliases.
- Backtick-wrap project/dataset names containing hyphens.

Return the corrected SQL and a short explanation of what you changed.`,
        prompt: `Original SQL:\n\`\`\`sql\n${finalSql}\n\`\`\`\n\nBigQuery error:\n${errMsg}`,
        schema: {
          type: 'OBJECT',
          properties: {
            sql: { type: 'STRING' },
            explanation: { type: 'STRING' },
          },
          required: ['sql'],
        },
        project,
      });

      if (fixResult?.sql) {
        finalSql = fixResult.sql;
        onStatus?.(`Retrying with corrected SQL...`);
        executed = await executeQuery(finalSql, project);
      } else {
        throw firstErr;
      }
    } catch (fixErr: unknown) {
      // If the fix attempt itself fails, throw the original error
      const fixErrMsg = fixErr instanceof Error ? fixErr.message : String(fixErr);
      if (fixErrMsg === errMsg || fixErrMsg.includes('Gemini')) throw firstErr;
      throw fixErr;
    }
  }

  const result: QueryResult = {
    skill: 'query',
    sql: finalSql,
    requiresConfirmation: false,
    costConfirm: null,
    columns: executed.columns,
    rows: executed.rows,
    rowCount: executed.rowCount,
    jobId: executed.jobId || undefined,
    totalBytesProcessed: costResult.totalBytesProcessed,
    costTier: costResult.tier,
    suggestedVisualization: queryPlan.suggestedVisualization,
    xAxis: queryPlan.xAxis ?? null,
    yAxis: queryPlan.yAxis ?? null,
    notableFindings: queryPlan.notableFindings ?? null,
    resultSummary: queryPlan.resultSummary ?? null,
  };

  return [compose('query', result)];
}

// ─── Data Management handler ───────────────────────────────────────────────────

async function handleDataManagement(
  message: string,
  history: ChatMessage[],
  context?: { project?: string; dataset?: string; resolvedDataset?: string; availableDatasets?: string[]; handoffContext?: Record<string, unknown> },
  onStatus?: (status: string) => void
): Promise<CompositionEnvelope[]> {
  const project = context?.project || '';

  // Safety net: re-check the message against the keyword router.
  // If the router does not independently confirm data-management intent,
  // this was likely misrouted (e.g., "analyze sales over time" is analytical,
  // not a mutation). Redirect to the query handler instead.
  const routerCheck = classifyIntent(message);
  if (routerCheck.skill !== 'data-management') {
    return handleQuery(message, history, context, onStatus);
  }

  const hc = context?.handoffContext;

  // Enrich message with handoff context so the LLM has full context
  let enrichedMessage = message;
  if (hc?.operationHint && typeof hc.operationHint === 'string') {
    enrichedMessage = `${message}. Operation type: ${hc.operationHint}.`;
    if (hc.table && typeof hc.table === 'string') {
      enrichedMessage += ` Target table: ${hc.table}.`;
    }
    if (hc.filter && typeof hc.filter === 'string') {
      enrichedMessage += ` Filter: ${hc.filter}.`;
    }
  }

  // Parallelize: skill doc and dataset resolution
  const [skillDoc, available] = await Promise.all([
    loadSkillDoc('data-management'),
    context?.availableDatasets ?? getAvailableDatasets(project),
  ]);
  let dataset = context?.resolvedDataset ?? resolveDefaultDatasetFromList(available, context?.dataset, project);
  if (!dataset) {
    dataset = extractDatasetFromMessage(enrichedMessage, available) ?? '';
  }

  const messages = history.slice(-6).map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  const schemaContext = await buildSchemaContext(project, dataset);

  onStatus?.(`Planning data management operation on dataset ${dataset}...`);
  const dmDatasetLine = dataset
    ? `The active dataset is: ${dataset}`
    : 'No dataset is pre-selected. Infer the correct dataset from the user\'s prompt and the available datasets listed below.';
  const plan = await callGemini({
    systemInstruction: `${skillDoc}

The BigQuery project is: ${project}
${dmDatasetLine}
The available datasets in project ${project} are: ${available.join(', ')}
${schemaContext}
Always wrap fully qualified table references in literal backticks: \`${project}.DATASET.tablename\` (e.g. \`${project}.ecomm.orders\`). This is CRITICAL to prevent syntax errors when project names contain dashes/hyphens.\``,
    messages: [...messages, { role: 'user' as const, content: enrichedMessage }],
    schema: DataManagementResponseSchema,
    project,
  });


  // ── Strategy-based execution ─────────────────────────────────────────────
  // Gemini decides the strategy based on the operation's risk level.
  const strategy = plan.executionStrategy || 'PREVIEW_AND_CONFIRM';

  // DIRECT_EXECUTE: no preview, no confirmation. Used for operations that
  // create new objects or are inherently safe (CREATE TABLE, CREATE VIEW, etc.).
  if (strategy === 'DIRECT_EXECUTE') {
    onStatus?.(`Executing ${plan.operation} directly on ${plan.table || dataset}...`);
    const dmlResult = await executeDml(plan.executionSql, project);
    const completeResult: DataManagementResult = {
      skill: 'data-management',
      requiresConfirmation: false,
      operation: plan.operation,
      rowsAffected: dmlResult.rowsAffected,
      rowsExpected: 0,
      mismatch: false,
      mismatchNote: null,
      schemaInvalidated: [`${project}.${dataset}.${plan.table}`],
      jobId: dmlResult.jobId,
      completionMessage: plan.completionMessage ?? null,
    };
    return [compose('data-management', completeResult)];
  }

  // PREVIEW_AND_CONFIRM_DEDUPE: preview + example group + group count + confirmation.
  if (strategy === 'PREVIEW_AND_CONFIRM_DEDUPE') {
    onStatus?.(`Running dedupe preview on ${plan.table || dataset}...`);
    const previewResult = await executeQuery(plan.previewSql, project);
    const rawCount = Number(previewResult.rows[0]?.[0]);
    const affectedRowCount = Number.isFinite(rawCount) ? Math.round(rawCount) : 0;

    let exampleGroup = undefined;
    const snapshotRowIds: number[] = [];
    let affectedGroupCount = undefined;

    if (plan.tiebreakerColumn) {
      const exampleSql = `
        WITH ranked AS (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY id
            ORDER BY ${plan.tiebreakerColumn} ${plan.tiebreakerDirection === 'KEEP_LATEST' ? 'DESC' : 'ASC'}
          ) AS rn
          FROM \`${project}.${dataset}.${plan.table}\`
          WHERE id IN (
            SELECT id FROM \`${project}.${dataset}.${plan.table}\`
            GROUP BY id HAVING COUNT(*) > 1
            LIMIT 1
          )
        )
        SELECT * FROM ranked
      `;

      try {
        const exampleResult = await executeQuery(exampleSql, project);
        if (exampleResult.rows.length > 0) {
          const toObj = (row: unknown[]) =>
            Object.fromEntries(exampleResult.columns.map((c, i) => [c, row[i]]));
          const keepRow = toObj(exampleResult.rows[0]);
          const removeRows = exampleResult.rows.slice(1).map(toObj);
          exampleGroup = {
            keyValue: { id: keepRow['id'] },
            keepRow,
            removeRows,
          };
        }
      } catch {
        // Non-fatal -- confirmation card still works without example
      }

      const groupCountSql = `
        SELECT COUNT(DISTINCT id) as group_count
        FROM \`${project}.${dataset}.${plan.table}\`
        GROUP BY id HAVING COUNT(*) > 1
      `;
      try {
        const groupResult = await executeQuery(
          `SELECT COUNT(*) as group_count FROM (${groupCountSql})`,
          project,
        );
        affectedGroupCount = Number(groupResult.rows[0]?.[0] ?? 0);
      } catch { /* ignore */ }
    }

    onStatus?.(`Estimating cost for ${plan.operation} on ${plan.table || dataset}...`);
    const costResult = await dryRun(plan.executionSql, project);

    const confirmResult: DataManagementResult = {
      skill: 'data-management',
      requiresConfirmation: true,
      operation: plan.operation,
      previewSql: plan.previewSql,
      affectedRowCount,
      affectedGroupCount,
      exampleGroup,
      costEstimate: costResult,
      tiebreakerColumn: plan.tiebreakerColumn ?? undefined,
      tiebreakerDirection: plan.tiebreakerDirection ?? undefined,
      executionSql: plan.executionSql,
      snapshotRowIds,
    };
    return [compose('data-management', confirmResult)];
  }

  // PREVIEW_AND_CONFIRM (default): preview affected rows + confirmation card.
  // Used for DELETE, UPDATE, FILL_NULLS, destructive ALTER TABLE, etc.
  onStatus?.(`Running preview for ${plan.operation} on ${plan.table || dataset}...`);
  const previewResult = await executeQuery(plan.previewSql, project);
  const rawCount = Number(previewResult.rows[0]?.[0]);
  const affectedRowCount = Number.isFinite(rawCount) ? Math.round(rawCount) : 0;

  onStatus?.(`Estimating cost for ${plan.operation} on ${plan.table || dataset}...`);
  const costResult = await dryRun(plan.executionSql, project);

  const confirmResult: DataManagementResult = {
    skill: 'data-management',
    requiresConfirmation: true,
    operation: plan.operation,
    previewSql: plan.previewSql,
    affectedRowCount,
    costEstimate: costResult,
    executionSql: plan.executionSql,
    snapshotRowIds: [],
  };
  return [compose('data-management', confirmResult)];
}

// ─── Execute confirmed operation ───────────────────────────────────────────────

async function executeConfirmedOperation(
  confirmed: DataManagementResult,
  project?: string
): Promise<CompositionEnvelope[]> {
  if (!confirmed.requiresConfirmation) return [];

  const dmlResult = await executeDml(
    confirmed.executionSql,
    project,
  );

  const mismatch = dmlResult.rowsAffected !== confirmed.affectedRowCount;

  const completeResult: DataManagementResult = {
    skill: 'data-management',
    requiresConfirmation: false,
    operation: confirmed.operation,
    rowsAffected: dmlResult.rowsAffected,
    rowsExpected: confirmed.affectedRowCount,
    mismatch,
    mismatchNote: mismatch
      ? `Removed ${dmlResult.rowsAffected} of the ${confirmed.affectedRowCount} rows — the other ${confirmed.affectedRowCount - dmlResult.rowsAffected} no longer matched by the time this ran.`
      : null,
    schemaInvalidated: [],
    jobId: dmlResult.jobId,
  };

  return [compose('data-management', completeResult)];
}

// ─── Monitoring handler ────────────────────────────────────────────────────────

async function handleMonitoring(
  message: string,
  context?: { project?: string; uid?: string; handoffContext?: Record<string, unknown> },
  onStatus?: (status: string) => void
): Promise<CompositionEnvelope[]> {
  const project = context?.project || '';
  const region = await detectBqRegion(project);
  const uid = context?.uid;
  const hc = context?.handoffContext;

  // --- Handle save_check / schedule_check actions from alert chips ---
  if (hc?.action === 'save_check' && hc?.checkSql && uid) {
    const checkId = `chk_${Date.now()}`;
    const check: SavedCheck = {
      id: checkId,
      createdAt: new Date().toISOString(),
      label: `dq_check: ${String(hc.conditionDescription || 'Unnamed check')}`,
      sql: String(hc.checkSql),
      conditionDescription: String(hc.conditionDescription || ''),
      tier: 'TIER_0',
    };
    onStatus?.('Saving check...');
    try {
      await saveCheck(uid, check);
      const result: AlertResult = {
        skill: 'monitoring',
        monitoringType: 'ALERT',
        alertCategory: (hc.alertCategory as AlertResult['alertCategory']) || 'DATA_CONDITION',
        conditionDescription: `Check saved: ${check.label}`,
        savedCheckId: checkId,
        tier: 'TIER_0',
        guidance: `Saved as a reusable check (Tier 0). You can find it in your saved prompts and re-run it anytime.\n\nCheck ID: ${checkId}`,
        nextActions: [
          { label: 'Run it now', action: String(hc.checkSql) },
          { label: 'Schedule with email alert', action: 'schedule_check' },
        ],
      };
      return [compose('monitoring', result)];
    } catch (err) {
      const result: AlertResult = {
        skill: 'monitoring',
        monitoringType: 'ALERT',
        alertCategory: 'DATA_CONDITION',
        conditionDescription: 'Failed to save check',
        guidance: `Could not save the check: ${err instanceof Error ? err.message : String(err)}`,
      };
      return [compose('monitoring', result)];
    }
  }

  if (hc?.action === 'schedule_check' && hc?.checkSql) {
    const label = String(hc.conditionDescription || 'Scheduled check');
    const conditionSql = String(hc.checkSql);
    // Wrap in IF/ERROR pattern for failure-email alerting
    const wrappedSql = `DECLARE violation_count INT64;\nSET violation_count = (${conditionSql});\nIF violation_count > 0 THEN\n  SELECT ERROR(CONCAT('Alert: ', '${label.replace(/'/g, "''")}', ' -- ', CAST(violation_count AS STRING), ' violations found'));\nEND IF;`;
    const schedule = 'every 24 hours';
    onStatus?.('Creating scheduled check with failure email...');
    try {
      const { transferConfigName } = await createScheduledQuery(
        project,
        `Alert: ${label}`,
        wrappedSql,
        schedule,
        true, // enableFailureEmail
      );
      const checkId = `chk_${Date.now()}`;
      if (uid) {
        const check: SavedCheck = {
          id: checkId,
          createdAt: new Date().toISOString(),
          label: `dq_check: ${label}`,
          sql: conditionSql,
          conditionDescription: label,
          tier: 'TIER_1',
          schedule,
          transferConfigName,
        };
        await saveCheck(uid, check);
      }
      const result: AlertResult = {
        skill: 'monitoring',
        monitoringType: 'ALERT',
        alertCategory: (hc.alertCategory as AlertResult['alertCategory']) || 'DATA_CONDITION',
        conditionDescription: `Scheduled alert: ${label}`,
        savedCheckId: checkId,
        tier: 'TIER_1',
        guidance: `Scheduled check created (Tier 1). It will run ${schedule} and send an email notification when the condition is violated.\n\nTransfer config: ${transferConfigName}`,
        nextActions: [
          { label: 'Run it now', action: conditionSql },
          { label: 'Show job history', action: 'show my recent BigQuery job history' },
        ],
      };
      return [compose('monitoring', result)];
    } catch (err) {
      const result: AlertResult = {
        skill: 'monitoring',
        monitoringType: 'ALERT',
        alertCategory: 'DATA_CONDITION',
        conditionDescription: 'Failed to create scheduled check',
        guidance: `Could not create the scheduled check: ${err instanceof Error ? err.message : String(err)}\n\nYou may need to ensure the BigQuery Data Transfer API is enabled for project ${project}.`,
        nextActions: [
          { label: 'Save as check instead', action: 'save_check' },
        ],
      };
      return [compose('monitoring', result)];
    }
  }

  // If handoff context carries a pre-classified monitoring type, skip LLM
  let monitoringType: string;
  if (hc?.monitoringHint && typeof hc.monitoringHint === 'string') {
    const hintMap: Record<string, string> = {
      'JOB_LIST': 'JOBS', 'COST_ANALYSIS': 'COST_ANALYSIS', 'DIAGNOSE_FAILURES': 'JOBS',
      'STORAGE_ANALYSIS': 'STORAGE', 'STORAGE': 'STORAGE',
      'SLOTS': 'SLOTS', 'QUERY_PLAN': 'QUERY_PLAN', 'ALERT': 'ALERT',
      'STORAGE_BREAKDOWN': 'STORAGE_BREAKDOWN', 'ACCESS_PATTERNS': 'ACCESS_PATTERNS',
      'FRESHNESS': 'FRESHNESS',
    };
    monitoringType = hintMap[hc.monitoringHint as string] || 'JOBS';
    onStatus?.(`Running ${monitoringType} analysis (from handoff)...`);
  } else {
    // Keyword-based fast path for types the LLM sometimes misroutes to JOBS
    const lower = message.toLowerCase();
    const costKeywords = ['cost', 'spending', 'spend', 'expensive', 'cheapest', 'billing', 'price', 'pricing'];
    const freshnessKeywords = ['fresh', 'stale', 'outdated', 'last updated', 'not been updated', 'most recent update', 'when was .* updated'];
    const isCost = costKeywords.some(k => lower.includes(k)) && !lower.includes('job') && !lower.includes('history');
    const isFresh = freshnessKeywords.some(k => new RegExp(k).test(lower)) && !lower.includes('job') && !lower.includes('history');

    if (isCost) {
      monitoringType = 'COST_ANALYSIS';
      onStatus?.(`Running cost analysis (keyword match)...`);
    } else if (isFresh) {
      monitoringType = 'FRESHNESS';
      onStatus?.(`Running freshness check (keyword match)...`);
    } else {
      // Classify monitoring sub-type via Gemini
      onStatus?.(`Classifying monitoring request...`);
      const intent = await callGemini({
        systemInstruction: `You classify BigQuery monitoring requests. Available types: JOBS (job history, recent queries, errors, failed jobs), STORAGE (table sizes, storage usage, row counts), SLOTS (slot utilization, resource usage over time), QUERY_PLAN (query execution plan, dry run, explain), ALERT (set up alerts, watch a metric, threshold notifications), STORAGE_BREAKDOWN (storage treemap, disk usage breakdown, largest tables), ACCESS_PATTERNS (who queries which tables, table usage patterns, most queried), COST_ANALYSIS (query cost over time, spending breakdown, how much am I spending), FRESHNESS (data freshness, stale tables, when was a table last updated, outdated tables). Extract a jobId if the user mentions a specific job. Extract a table name if relevant. Extract a dataset name if relevant.`,
        prompt: message,
        schema: MonitoringIntentSchema,
        project,
      });
      monitoringType = intent.monitoringType || 'JOBS';
    }
  }

  // STORAGE — query INFORMATION_SCHEMA.TABLE_STORAGE
  if (monitoringType === 'STORAGE') {
    const storageSql = `SELECT table_schema, table_name, total_rows, total_logical_bytes, active_logical_bytes FROM \`${project}\`.\`region-${region}\`.INFORMATION_SCHEMA.TABLE_STORAGE ORDER BY total_logical_bytes DESC LIMIT 50`;
    onStatus?.(`Fetching storage usage for project ${project}...`);
    const executed = await executeQuery(storageSql, project);

    const items: MonitoringJob[] = executed.rows.map((row) => ({
      jobId: `${row[0]}.${row[1]}`,
      userEmail: '',
      statementType: 'STORAGE',
      status: 'DONE' as const,
      createTime: new Date().toISOString(),
      totalBytesProcessed: Number(row[3] ?? 0),
      errorMessage: null,
      referencedTables: [`${project}.${row[0]}.${row[1]}`],
    }));

    const now = new Date();
    const result: MonitoringResult = {
      skill: 'monitoring',
      monitoringType: 'JOB_LIST',
      timeRange: { start: now.toISOString(), end: now.toISOString() },
      items,
      summary: {
        totalJobs: items.length,
        totalBytesProcessed: items.reduce((acc, j) => acc + j.totalBytesProcessed, 0),
        errorCount: 0,
      },
    };
    return [compose('monitoring', result)];
  }

  // SLOTS — query INFORMATION_SCHEMA.JOBS_TIMELINE for slot usage
  if (monitoringType === 'SLOTS') {
    const slotsSql = `SELECT period_start, SUM(period_slot_ms) AS total_slot_ms, COUNT(DISTINCT job_id) AS concurrent_jobs FROM \`${project}\`.\`region-${region}\`.INFORMATION_SCHEMA.JOBS_TIMELINE_BY_PROJECT WHERE period_start > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR) GROUP BY period_start ORDER BY period_start DESC LIMIT 100`;
    onStatus?.(`Fetching slot utilization for project ${project}...`);
    const executed = await executeQuery(slotsSql, project);

    const items: MonitoringJob[] = executed.rows.map((row) => ({
      jobId: String(row[0] ?? ''),
      userEmail: '',
      statementType: 'SLOT_USAGE',
      status: 'DONE' as const,
      createTime: String(row[0] ?? ''),
      totalBytesProcessed: Number(row[1] ?? 0),
      errorMessage: `${row[2] ?? 0} concurrent jobs`,
      referencedTables: [],
    }));

    const now = new Date();
    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const result: MonitoringResult = {
      skill: 'monitoring',
      monitoringType: 'JOB_LIST',
      timeRange: { start: start.toISOString(), end: now.toISOString() },
      items,
      summary: {
        totalJobs: items.length,
        totalBytesProcessed: items.reduce((acc, j) => acc + j.totalBytesProcessed, 0),
        errorCount: 0,
      },
    };
    return [compose('monitoring', result)];
  }

  // QUERY_PLAN — placeholder guidance
  if (monitoringType === 'QUERY_PLAN') {
    const result: MonitoringResult = {
      skill: 'monitoring',
      monitoringType: 'JOB_LIST',
      timeRange: { start: new Date().toISOString(), end: new Date().toISOString() },
      items: [{
        jobId: 'query_plan_info',
        userEmail: '',
        statementType: 'INFO',
        status: 'DONE',
        createTime: new Date().toISOString(),
        totalBytesProcessed: 0,
        errorMessage: 'To analyze a query plan: use the dry-run feature by prefixing your query request with "dry run" or "explain". The system will show estimated bytes processed and cost tier without executing the query. For detailed execution plans, use the BigQuery Console Query Plan tab after running a query.',
        referencedTables: [],
      }],
      summary: { totalJobs: 0, totalBytesProcessed: 0, errorCount: 0 },
    };
    return [compose('monitoring', result)];
  }

  // ALERT -- three-way classification per shared-harness-policies SS C
  if (monitoringType === 'ALERT') {
    const AlertClassSchema = {
      type: 'OBJECT' as const,
      properties: {
        alertCategory: {
          type: 'STRING' as const,
          enum: ['PROJECT_WIDE', 'JOB_SPECIFIC', 'DATA_CONDITION'],
          description: 'PROJECT_WIDE: aggregate system metrics (total slot usage, overall error rate, storage growth). JOB_SPECIFIC: condition about a specific job, schedule, or query pattern. DATA_CONDITION: row-level or column-level data condition (nulls, duplicates, freshness, thresholds).',
        },
        conditionDescription: {
          type: 'STRING' as const,
          description: 'Plain-English description of what the user wants to be alerted about',
        },
        table: {
          type: 'STRING' as const,
          description: 'Fully qualified table reference (project.dataset.table) if the condition involves a specific table',
        },
        metric: {
          type: 'STRING' as const,
          description: 'The metric or column to check (e.g., null_rate, row_count, bytes_processed)',
        },
        threshold: {
          type: 'STRING' as const,
          description: 'The threshold value if specified (e.g., "> 1000", "< 0.95")',
        },
      },
      required: ['alertCategory', 'conditionDescription'],
    };

    onStatus?.('Classifying alert type...');
    const alertClass = await callGemini({
      systemInstruction: 'You classify BigQuery alert requests into one of three categories: PROJECT_WIDE (aggregate system metrics like slot usage, error rate, storage growth), JOB_SPECIFIC (conditions about specific jobs, schedules, or query patterns), or DATA_CONDITION (row-level or column-level data conditions like nulls, duplicates, freshness, thresholds). Extract the condition description, table, metric, and threshold if mentioned.',
      prompt: message,
      schema: AlertClassSchema,
      project,
    });
    const { alertCategory, conditionDescription, table, metric, threshold } = alertClass;

    // --- PROJECT_WIDE: guidance for Cloud Monitoring ---
    if (alertCategory === 'PROJECT_WIDE') {
      const result: AlertResult = {
        skill: 'monitoring',
        monitoringType: 'ALERT',
        alertCategory: 'PROJECT_WIDE',
        conditionDescription,
        guidance: `To set up a project-wide alert for "${conditionDescription}":\n\n` +
          `1. Go to Cloud Monitoring > Alerting > Create Policy\n` +
          `2. Resource type: BigQuery Project\n` +
          `3. Metric: ${metric || 'Choose the relevant BigQuery metric'}\n` +
          `4. Condition: ${threshold || 'Set your threshold'}\n\n` +
          `Or use gcloud:\n` +
          `gcloud alpha monitoring policies create \\\n` +
          `  --display-name="${conditionDescription}" \\\n` +
          `  --condition-filter='resource.type="bigquery.googleapis.com/Project"' \\\n` +
          `  --condition-threshold-value=${threshold || '<THRESHOLD>'} \\\n` +
          `  --notification-channels=<CHANNEL_ID>`,
        nextActions: [
          { label: 'Show current usage', action: 'show my current slot usage and query costs' },
        ],
      };
      return [compose('monitoring', result)];
    }

    // --- JOB_SPECIFIC: author SQL check against INFORMATION_SCHEMA.JOBS ---
    if (alertCategory === 'JOB_SPECIFIC') {
      const checkSql = `SELECT COUNT(*) as violation_count\nFROM \`${project}\`.\`region-${region}\`.INFORMATION_SCHEMA.JOBS_BY_PROJECT\nWHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)\n  AND ${metric ? `${metric} ${threshold || '> 0'}` : `error_result IS NOT NULL`}`;

      const result: AlertResult = {
        skill: 'monitoring',
        monitoringType: 'ALERT',
        alertCategory: 'JOB_SPECIFIC',
        conditionDescription,
        checkSql,
        guidance: `This check queries INFORMATION_SCHEMA.JOBS to detect: ${conditionDescription}.\n\nYou can save this as a reusable check (Tier 0) or schedule it to run automatically with email alerts (Tier 1).`,
        nextActions: [
          { label: 'Save as check', action: 'save_check' },
          { label: 'Schedule with email alert', action: 'schedule_check' },
          { label: 'Run it now', action: checkSql },
        ],
      };
      return [compose('monitoring', result)];
    }

    // --- DATA_CONDITION: author DQ check SQL ---
    if (alertCategory === 'DATA_CONDITION') {
      const targetTable = table || '<project.dataset.table>';
      let checkSql: string;

      if (metric?.toLowerCase().includes('null')) {
        checkSql = `SELECT\n  '${metric}' as check_name,\n  COUNTIF(${metric} IS NULL) as null_count,\n  COUNT(*) as total_rows,\n  ROUND(COUNTIF(${metric} IS NULL) / COUNT(*) * 100, 2) as null_pct\nFROM \`${targetTable}\`\nHAVING null_pct ${threshold || '> 5'}`;
      } else if (metric?.toLowerCase().includes('duplicate') || conditionDescription.toLowerCase().includes('duplicate')) {
        checkSql = `SELECT COUNT(*) as duplicate_groups\nFROM (\n  SELECT ${metric || '*'}, COUNT(*) as cnt\n  FROM \`${targetTable}\`\n  GROUP BY ${metric || 'ALL'}\n  HAVING cnt > 1\n)\nHAVING duplicate_groups > 0`;
      } else if (conditionDescription.toLowerCase().includes('fresh') || conditionDescription.toLowerCase().includes('stale')) {
        checkSql = `SELECT\n  TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(${metric || 'created_at'}), HOUR) as hours_since_update\nFROM \`${targetTable}\`\nHAVING hours_since_update ${threshold || '> 24'}`;
      } else {
        checkSql = `SELECT COUNT(*) as violation_count\nFROM \`${targetTable}\`\nWHERE ${metric || '1=1'} ${threshold || ''}`;
      }

      const result: AlertResult = {
        skill: 'monitoring',
        monitoringType: 'ALERT',
        alertCategory: 'DATA_CONDITION',
        conditionDescription,
        checkSql,
        guidance: `This check monitors: ${conditionDescription}.\n\nSave it as a reusable check you can run anytime (Tier 0), or schedule it to run automatically with email notifications when the condition is violated (Tier 1).`,
        nextActions: [
          { label: 'Save as check', action: 'save_check' },
          { label: 'Schedule with email alert', action: 'schedule_check' },
          { label: 'Run it now', action: checkSql },
        ],
      };
      return [compose('monitoring', result)];
    }
  }

  // Helper: BigQuery timestamps may be epoch-ms numbers, {value:'...'} objects, or ISO strings
  function normalizeTimestamp(val: unknown): string {
    if (val == null) return '';
    // If it's an object with a .value property (BigQuery client format)
    if (typeof val === 'object' && val !== null && 'value' in val) {
      return normalizeTimestamp((val as { value: unknown }).value);
    }
    // If it's a number, treat as epoch milliseconds
    if (typeof val === 'number') {
      // BigQuery sometimes uses microseconds -- if > year 5000 in ms, assume micros
      const ms = val > 1e16 ? val / 1000 : val;
      return new Date(ms).toISOString();
    }
    const s = String(val);
    // If it's a purely numeric string, parse as epoch
    if (/^\d{10,}$/.test(s)) {
      const num = Number(s);
      const ms = num > 1e16 ? num / 1000 : num;
      return new Date(ms).toISOString();
    }
    // Try parsing as-is -- if valid, return ISO
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString();
    return s;
  }

  // STORAGE_BREAKDOWN -- hierarchical treemap of storage by dataset and table
  if (monitoringType === 'STORAGE_BREAKDOWN') {
    const storageSql = `SELECT table_schema, table_name, total_rows, total_logical_bytes FROM \`${project}\`.\`region-${region}\`.INFORMATION_SCHEMA.TABLE_STORAGE ORDER BY total_logical_bytes DESC LIMIT 200`;
    onStatus?.(`Fetching storage breakdown for project ${project} (region: ${region})...`);
    try {
      const executed = await executeQuery(storageSql, project);
      if (executed.rows.length === 0) {
        // TABLE_STORAGE returned 0 rows -- fall back to __TABLES__ per dataset
        onStatus?.(`TABLE_STORAGE empty, querying per-dataset metadata...`);
        const { listDatasets } = await import('./bigquery-client');
        const datasets = await listDatasets(project);
        const items: import('./types').StorageItem[] = [];
        let totalBytes = 0;
        for (const ds of datasets.slice(0, 20)) {
          const dsId = ds.datasetId || ds.id || '';
          try {
            const tablesMeta = await executeQuery(
              `SELECT table_id, row_count, size_bytes FROM \`${project}.${dsId}.__TABLES__\``,
              project
            );
            let dsBytes = 0;
            let dsRows = 0;
            const children: import('./types').StorageItem[] = [];
            for (const row of tablesMeta.rows) {
              const tId = String(row[0] ?? '');
              const tRows = Number(row[1] ?? 0);
              const tBytes = Number(row[2] ?? 0);
              dsBytes += tBytes;
              dsRows += tRows;
              children.push({ ref: `${project}.${dsId}.${tId}`, label: tId, sizeBytes: tBytes, rowCount: tRows, type: 'TABLE' as const });
            }
            children.sort((a, b) => b.sizeBytes - a.sizeBytes);
            totalBytes += dsBytes;
            items.push({ ref: `${project}.${dsId}`, label: dsId, sizeBytes: dsBytes, rowCount: dsRows, type: 'DATASET' as const, children });
          } catch {
            // Skip datasets we can't query
            items.push({ ref: `${project}.${dsId}`, label: dsId, sizeBytes: 0, rowCount: 0, type: 'DATASET' as const });
          }
        }
        items.sort((a, b) => b.sizeBytes - a.sizeBytes);
        const result: import('./types').StorageBreakdownResult = {
          skill: 'monitoring', monitoringType: 'STORAGE_BREAKDOWN',
          project, totalBytes, items,
        };
        return [compose('monitoring', result as unknown as MonitoringResult)];
      }
      const datasetMap = new Map<string, { sizeBytes: number; rowCount: number; tables: Array<{ ref: string; label: string; sizeBytes: number; rowCount: number }> }>();
      for (const row of executed.rows) {
        const ds = String(row[0] ?? '');
        const tbl = String(row[1] ?? '');
        const rows = Number(row[2] ?? 0);
        const bytes = Number(row[3] ?? 0);
        if (!datasetMap.has(ds)) datasetMap.set(ds, { sizeBytes: 0, rowCount: 0, tables: [] });
        const entry = datasetMap.get(ds)!;
        entry.sizeBytes += bytes;
        entry.rowCount += rows;
        entry.tables.push({ ref: `${project}.${ds}.${tbl}`, label: tbl, sizeBytes: bytes, rowCount: rows });
      }
      const items: import('./types').StorageItem[] = Array.from(datasetMap.entries()).map(([ds, data]) => ({
        ref: `${project}.${ds}`,
        label: ds,
        sizeBytes: data.sizeBytes,
        rowCount: data.rowCount,
        type: 'DATASET' as const,
        children: data.tables.map(t => ({ ref: t.ref, label: t.label, sizeBytes: t.sizeBytes, rowCount: t.rowCount, type: 'TABLE' as const })),
      })).sort((a, b) => b.sizeBytes - a.sizeBytes);
      const result: import('./types').StorageBreakdownResult = {
        skill: 'monitoring',
        monitoringType: 'STORAGE_BREAKDOWN',
        project,
        totalBytes: items.reduce((acc, i) => acc + i.sizeBytes, 0),
        items,
      };
      return [compose('monitoring', result as unknown as MonitoringResult)];
    } catch (err) {
      // TABLE_STORAGE query failed -- fall back to __TABLES__ per dataset
      onStatus?.(`Query failed: ${err instanceof Error ? err.message : String(err)}. Trying per-dataset metadata...`);
      try {
        const { listDatasets } = await import('./bigquery-client');
        const datasets = await listDatasets(project);
        const items: import('./types').StorageItem[] = [];
        let totalBytes = 0;
        for (const ds of datasets.slice(0, 20)) {
          const dsId = ds.datasetId || ds.id || '';
          try {
            const tablesMeta = await executeQuery(
              `SELECT table_id, row_count, size_bytes FROM \`${project}.${dsId}.__TABLES__\``,
              project
            );
            let dsBytes = 0;
            let dsRows = 0;
            const children: import('./types').StorageItem[] = [];
            for (const row of tablesMeta.rows) {
              const tId = String(row[0] ?? '');
              const tRows = Number(row[1] ?? 0);
              const tBytes = Number(row[2] ?? 0);
              dsBytes += tBytes;
              dsRows += tRows;
              children.push({ ref: `${project}.${dsId}.${tId}`, label: tId, sizeBytes: tBytes, rowCount: tRows, type: 'TABLE' as const });
            }
            children.sort((a, b) => b.sizeBytes - a.sizeBytes);
            totalBytes += dsBytes;
            items.push({ ref: `${project}.${dsId}`, label: dsId, sizeBytes: dsBytes, rowCount: dsRows, type: 'DATASET' as const, children });
          } catch {
            items.push({ ref: `${project}.${dsId}`, label: dsId, sizeBytes: 0, rowCount: 0, type: 'DATASET' as const });
          }
        }
        items.sort((a, b) => b.sizeBytes - a.sizeBytes);
        const result: import('./types').StorageBreakdownResult = {
          skill: 'monitoring', monitoringType: 'STORAGE_BREAKDOWN',
          project, totalBytes, items,
        };
        return [compose('monitoring', result as unknown as MonitoringResult)];
      } catch {
        const result: import('./types').StorageBreakdownResult = {
          skill: 'monitoring', monitoringType: 'STORAGE_BREAKDOWN',
          project, totalBytes: 0, items: [],
        };
        return [compose('monitoring', result as unknown as MonitoringResult)];
      }
    }
  }

  // ACCESS_PATTERNS -- who queries which tables
  if (monitoringType === 'ACCESS_PATTERNS') {
    const accessSql = `SELECT user_email, referenced_tables, COUNT(*) AS query_count, SUM(total_bytes_processed) AS total_bytes, MAX(creation_time) AS last_accessed FROM \`${project}\`.\`region-${region}\`.INFORMATION_SCHEMA.JOBS_BY_PROJECT WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY) AND statement_type = 'SELECT' AND referenced_tables IS NOT NULL GROUP BY user_email, referenced_tables ORDER BY query_count DESC LIMIT 200`;
    onStatus?.(`Analyzing access patterns for project ${project}...`);
    try {
      const executed = await executeQuery(accessSql, project);
      const entries: import('./types').AccessPatternEntry[] = [];
      for (const row of executed.rows) {
        const email = String(row[0] ?? '');
        const refsRaw = row[1];
        const qCount = Number(row[2] ?? 0);
        const totalBytes = Number(row[3] ?? 0);
        const lastAccessed = String(row[4] ?? '');
        let tables: string[] = [];
        try {
          const parsed = typeof refsRaw === 'string' ? JSON.parse(refsRaw) : refsRaw;
          if (Array.isArray(parsed)) {
            tables = parsed.map((t: { projectId?: string; datasetId?: string; tableId?: string }) =>
              [t.projectId, t.datasetId, t.tableId].filter(Boolean).join('.')
            );
          }
        } catch { /* non-fatal */ }
        for (const tableRef of tables) {
          entries.push({ tableRef, userEmail: email, queryCount: qCount, totalBytesProcessed: totalBytes, lastAccessed });
        }
      }
      const now = new Date();
      const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const result: import('./types').AccessPatternResult = {
        skill: 'monitoring',
        monitoringType: 'ACCESS_PATTERNS',
        timeRange: { start: start.toISOString(), end: now.toISOString() },
        entries,
      };
      return [compose('monitoring', result as unknown as MonitoringResult)];
    } catch {
      const now = new Date();
      const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const result: import('./types').AccessPatternResult = {
        skill: 'monitoring', monitoringType: 'ACCESS_PATTERNS',
        timeRange: { start: start.toISOString(), end: now.toISOString() }, entries: [],
      };
      return [compose('monitoring', result as unknown as MonitoringResult)];
    }
  }

  // COST_ANALYSIS -- query costs over time by user
  if (monitoringType === 'COST_ANALYSIS') {
    const costSql = `SELECT DATE(creation_time) AS period, user_email, SUM(total_bytes_processed) AS total_bytes, COUNT(*) AS job_count FROM \`${project}\`.\`region-${region}\`.INFORMATION_SCHEMA.JOBS_BY_PROJECT WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY) AND total_bytes_processed > 0 GROUP BY period, user_email ORDER BY period DESC, total_bytes DESC LIMIT 500`;
    onStatus?.(`Analyzing query costs for project ${project}...`);
    try {
      const executed = await executeQuery(costSql, project);
      const costPerTb = 6.25; // BigQuery on-demand pricing per TB
      const buckets: import('./types').CostBucket[] = executed.rows.map(row => {
        const bytes = Number(row[2] ?? 0);
        return {
          period: String(row[0] ?? ''),
          user: String(row[1] ?? ''),
          bytesProcessed: bytes,
          estimatedCostUsd: (bytes / 1e12) * costPerTb,
          jobCount: Number(row[3] ?? 0),
        };
      });
      const totalCost = buckets.reduce((acc, b) => acc + b.estimatedCostUsd, 0);
      const now = new Date();
      const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const result: import('./types').CostAnalysisResult = {
        skill: 'monitoring',
        monitoringType: 'COST_ANALYSIS',
        timeRange: { start: start.toISOString(), end: now.toISOString() },
        totalEstimatedCostUsd: totalCost,
        buckets,
      };
      return [compose('monitoring', result as unknown as MonitoringResult)];
    } catch {
      const now = new Date();
      const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const result: import('./types').CostAnalysisResult = {
        skill: 'monitoring', monitoringType: 'COST_ANALYSIS',
        timeRange: { start: start.toISOString(), end: now.toISOString() },
        totalEstimatedCostUsd: 0, buckets: [],
      };
      return [compose('monitoring', result as unknown as MonitoringResult)];
    }
  }

  // FRESHNESS -- data freshness by table in a dataset
  if (monitoringType === 'FRESHNESS') {
    const dataset = (hc?.dataset as string) || '';
    const freshnessSql = dataset
      ? `SELECT table_schema, table_name, TIMESTAMP_MILLIS(last_modified_time) AS last_modified, row_count AS total_rows FROM \`${project}.${dataset}\`.INFORMATION_SCHEMA.TABLES ORDER BY last_modified_time ASC LIMIT 100`
      : `SELECT table_schema, table_name, TIMESTAMP_MILLIS(last_modified_time) AS last_modified, row_count AS total_rows FROM \`${project}\`.\`region-${region}\`.INFORMATION_SCHEMA.TABLES ORDER BY last_modified_time ASC LIMIT 100`;
    onStatus?.(`Checking data freshness${dataset ? ` for ${dataset}` : ''}...`);
    try {
      const executed = await executeQuery(freshnessSql, project);
      const now = Date.now();
      const freshHours = 24;
      const staleHours = 72;
      const entries: import('./types').FreshnessEntry[] = executed.rows.map(row => {
        const ds = String(row[0] ?? '');
        const tbl = String(row[1] ?? '');
        const lastMod = String(row[2] ?? '');
        const rowCount = Number(row[3] ?? 0);
        const modTime = new Date(lastMod).getTime();
        const ageHours = Math.max(0, (now - modTime) / (1000 * 60 * 60));
        const status: import('./types').FreshnessEntry['status'] =
          ageHours <= freshHours ? 'FRESH' : ageHours <= staleHours ? 'STALE' : 'VERY_STALE';
        return { tableRef: `${project}.${ds}.${tbl}`, lastModified: lastMod, ageHours, rowCount, status };
      });
      const result: import('./types').FreshnessResult = {
        skill: 'monitoring',
        monitoringType: 'FRESHNESS',
        dataset: dataset || project,
        entries,
        thresholds: { freshHours, staleHours },
      };
      return [compose('monitoring', result as unknown as MonitoringResult)];
    } catch {
      const result: import('./types').FreshnessResult = {
        skill: 'monitoring', monitoringType: 'FRESHNESS',
        dataset: dataset || project, entries: [],
        thresholds: { freshHours: 24, staleHours: 72 },
      };
      return [compose('monitoring', result as unknown as MonitoringResult)];
    }
  }

  // JOBS (default) — existing INFORMATION_SCHEMA.JOBS query
  const sql = `SELECT job_id, user_email, statement_type, state, creation_time, total_bytes_processed, error_result, referenced_tables FROM \`${project}\`.\`region-${region}\`.INFORMATION_SCHEMA.JOBS_BY_PROJECT WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR) ORDER BY creation_time DESC LIMIT 50`;

  onStatus?.(`Fetching last 24h of job history for project ${project}...`);
  const executed = await executeQuery(sql, project);

  // Map column indices
  const idx = (name: string) => executed.columns.indexOf(name);
  const iJobId       = idx('job_id');
  const iEmail       = idx('user_email');
  const iType        = idx('statement_type');
  const iState       = idx('state');
  const iCreateTime  = idx('creation_time');
  const iBytes       = idx('total_bytes_processed');
  const iError       = idx('error_result');
  const iTables      = idx('referenced_tables');

  const items: MonitoringJob[] = executed.rows.map((row) => {
    const stateVal = String(row[iState] ?? '').toUpperCase();
    const status: MonitoringJob['status'] =
      stateVal === 'RUNNING' ? 'RUNNING'
      : stateVal === 'DONE' && row[iError] != null ? 'ERROR'
      : 'DONE';

    let errorMessage: string | null = null;
    if (row[iError] != null) {
      try {
        const parsed = typeof row[iError] === 'string' ? JSON.parse(row[iError] as string) : row[iError];
        errorMessage = parsed?.message ?? String(row[iError]);
      } catch {
        errorMessage = String(row[iError]);
      }
    }

    let referencedTables: string[] = [];
    if (row[iTables] != null) {
      try {
        const parsed = typeof row[iTables] === 'string' ? JSON.parse(row[iTables] as string) : row[iTables];
        if (Array.isArray(parsed)) {
          referencedTables = parsed.map((t: { projectId?: string; datasetId?: string; tableId?: string }) =>
            [t.projectId, t.datasetId, t.tableId].filter(Boolean).join('.')
          );
        }
      } catch {
        // non-fatal — leave as empty array
      }
    }

    return {
      jobId: String(row[iJobId] ?? ''),
      userEmail: String(row[iEmail] ?? ''),
      statementType: String(row[iType] ?? ''),
      status,
      createTime: normalizeTimestamp(row[iCreateTime]),
      totalBytesProcessed: Number(row[iBytes] ?? 0),
      errorMessage,
      referencedTables,
    };
  });

  const now = new Date();
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const result: MonitoringResult = {
    skill: 'monitoring',
    monitoringType: 'JOB_LIST',
    timeRange: { start: start.toISOString(), end: now.toISOString() },
    items,
    summary: {
      totalJobs: items.length,
      totalBytesProcessed: items.reduce((acc, j) => acc + j.totalBytesProcessed, 0),
      errorCount: items.filter((j) => j.status === 'ERROR').length,
    },
  };

  return [compose('monitoring', result)];
}

// ─── Data Quality handler ──────────────────────────────────────────────────────

async function handleDataQuality(
  message: string,
  context?: { project?: string; dataset?: string; lastTable?: string; resolvedDataset?: string; availableDatasets?: string[]; handoffContext?: Record<string, unknown> },
  onStatus?: (status: string) => void
): Promise<CompositionEnvelope[]> {
  const project = context?.project || '';
  const hc = context?.handoffContext;

  // Parallelize dataset resolution
  const available = context?.availableDatasets ?? await getAvailableDatasets(project);
  let dataset = context?.resolvedDataset ?? resolveDefaultDatasetFromList(available, context?.dataset, project);
  if (!dataset) {
    dataset = extractDatasetFromMessage(message, available) ?? '';
  }

  // If handoff context carries a pre-classified check type, skip LLM classification
  let intent: { checkType: string; table?: string; dataset?: string };
  if (hc?.checkType && typeof hc.checkType === 'string') {
    intent = {
      checkType: hc.checkType as string,
      table: (hc.table as string) ?? undefined,
      dataset: (hc.dataset as string) ?? undefined,
    };
    onStatus?.(`Running ${intent.checkType} check (from handoff)...`);
  } else {
    onStatus?.(`Classifying quality check type for: "${message.slice(0, 60)}${message.length > 60 ? '...' : ''}"`);
    intent = await callGemini({
      systemInstruction: `You classify BigQuery data quality requests. Extract check type and table name. Available check types: PROFILE (general stats), NULLS (null analysis), DUPLICATES (find duplicate rows), FRESHNESS (when was the table last updated), COMPLETENESS (overall completeness percentage across all columns), RANGE_VALIDATION (check numeric columns for out-of-range values), REFERENTIAL_INTEGRITY (check foreign key relationships for orphaned rows), SCHEMA_DRIFT (compare current schema against expected structure). The active project is ${project}, default dataset is ${dataset}, available datasets are: ${available.join(', ')}.`,
      prompt: message,
      schema: DqIntentSchema,
      project,
    });
  }
  const tableName = intent.table ?? context?.lastTable ?? null;
  let ds = intent.dataset ?? dataset;
  if (ds && ds.toLowerCase() === project.toLowerCase()) {
    ds = dataset;
  }
  const checkedAt = new Date().toISOString();

  // FRESHNESS — no query needed, use schema metadata
  if (intent.checkType === 'FRESHNESS') {
    const schema = await fetchSchema(ds, tableName ?? undefined, project);
    const lastMod = schema.lastModifiedTime ?? 'unknown';
    const ageMs = lastMod !== 'unknown' ? Date.now() - new Date(lastMod).getTime() : null;
    const ageHours = ageMs !== null ? Math.round(ageMs / 3_600_000) : null;
    const severity: DqFinding['severity'] = ageHours === null ? 'INFO' : ageHours > 48 ? 'ISSUE' : ageHours > 24 ? 'WARNING' : 'INFO';
    const result: DataQualityResult = {
      skill: 'data-quality',
      checkType: 'FRESHNESS',
      table: `${project}.${ds}.${tableName ?? ''}`,
      sql: '',
      findings: [{
        column: '_table',
        metric: 'last_modified',
        value: lastMod,
        severity,
      }],
      summary: { rowsScanned: 0, issuesFound: severity !== 'INFO' ? 1 : 0, checkedAt },
    };
    return [compose('data-quality', result)];
  }

  if (!tableName) {
    return [compose('data-quality', {
      skill: 'data-quality', checkType: intent.checkType,
      table: `${project}.${ds}.<table>`, sql: '',
      findings: [{ column: '_', metric: 'error', value: 'No table name found — please specify a table', severity: 'INFO' }],
      summary: { rowsScanned: 0, issuesFound: 0, checkedAt },
    } as DataQualityResult)];
  }

  const fqTable = `\`${project}.${ds}.${tableName}\``;

  // Fetch schema to get column names + types
  const schema = await fetchSchema(ds, tableName, project);
  const columns = schema.columns.filter((c) => !['RECORD', 'REPEATED'].includes(c.type));

  let sql = '';
  const findings: DqFinding[] = [];

  if (intent.checkType === 'DUPLICATES') {
    // Find key-like columns
    const keyCol = columns.find((c) => c.name === 'id' || c.name.endsWith('_id') || c.name.endsWith('_key'))?.name ?? columns[0]?.name;
    if (!keyCol) {
      return [compose('data-quality', { skill: 'data-quality', checkType: 'DUPLICATES', table: fqTable, sql: '', findings: [], summary: { rowsScanned: 0, issuesFound: 0, checkedAt } } as DataQualityResult)];
    }
    sql = `SELECT ${keyCol}, COUNT(*) as duplicate_count FROM ${fqTable} GROUP BY ${keyCol} HAVING COUNT(*) > 1 ORDER BY duplicate_count DESC LIMIT 50`;
    onStatus?.(`Checking for duplicates in ${fqTable} using key column ${keyCol}...`);
    const executed = await executeQuery(sql, project);
    const dupCount = executed.rowCount;
    if (dupCount > 0) {
      findings.push({ column: keyCol, metric: 'duplicate_groups', value: dupCount, severity: 'ISSUE' });
    }
    const result: DataQualityResult = {
      skill: 'data-quality', checkType: 'DUPLICATES', table: fqTable, sql,
      findings,
      summary: { rowsScanned: executed.rowCount, issuesFound: dupCount > 0 ? 1 : 0, checkedAt },
    };
    return [compose('data-quality', result)];
  }

  // COMPLETENESS — compute null rate across all columns, then aggregate
  if (intent.checkType === 'COMPLETENESS') {
    const nullExprs = columns.map((col) =>
      `COUNTIF(${col.name} IS NULL) AS \`${col.name}__nulls\``
    );
    sql = `SELECT COUNT(*) AS __total_rows, ${nullExprs.join(', ')} FROM ${fqTable}`;
    onStatus?.(`Computing completeness across ${columns.length} columns in ${fqTable}...`);
    const executed = await executeQuery(sql, project);
    const row = executed.rows[0] ?? [];
    const colMap = Object.fromEntries(executed.columns.map((c, i) => [c, row[i]]));
    const totalRows = Number(colMap['__total_rows'] ?? 0);

    let totalCells = 0;
    let totalFilled = 0;
    for (const col of columns) {
      const nullCount = Number(colMap[`${col.name}__nulls`] ?? 0);
      const fillRate = totalRows > 0 ? (totalRows - nullCount) / totalRows : 1;
      totalCells += totalRows;
      totalFilled += totalRows - nullCount;
      const severity: DqFinding['severity'] = fillRate < 0.5 ? 'ISSUE' : fillRate < 0.9 ? 'WARNING' : 'INFO';
      findings.push({ column: col.name, metric: 'fill_rate', value: parseFloat(fillRate.toFixed(4)), severity });
    }
    const overallCompleteness = totalCells > 0 ? totalFilled / totalCells : 1;
    findings.unshift({
      column: '_table',
      metric: 'overall_completeness',
      value: parseFloat(overallCompleteness.toFixed(4)),
      severity: overallCompleteness < 0.8 ? 'ISSUE' : overallCompleteness < 0.95 ? 'WARNING' : 'INFO',
    });

    const issueCount = findings.filter((f) => f.severity !== 'INFO').length;
    const result: DataQualityResult = {
      skill: 'data-quality', checkType: 'COMPLETENESS', table: fqTable, sql,
      findings,
      summary: { rowsScanned: totalRows, issuesFound: issueCount, checkedAt },
    };
    return [compose('data-quality', result)];
  }

  // RANGE_VALIDATION — check numeric columns for min/max out-of-range values
  if (intent.checkType === 'RANGE_VALIDATION') {
    const numericCols = columns.filter((c) =>
      ['INT64', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC', 'INTEGER', 'FLOAT'].includes(c.type)
    );
    if (numericCols.length === 0) {
      const result: DataQualityResult = {
        skill: 'data-quality', checkType: 'RANGE_VALIDATION', table: fqTable, sql: '',
        findings: [{ column: '_table', metric: 'info', value: 'No numeric columns found for range validation', severity: 'INFO' }],
        summary: { rowsScanned: 0, issuesFound: 0, checkedAt },
      };
      return [compose('data-quality', result)];
    }

    // Ask Gemini for expected ranges
    const RangeSchema = {
      type: 'OBJECT' as const,
      properties: {
        ranges: {
          type: 'ARRAY' as const,
          items: {
            type: 'OBJECT' as const,
            properties: {
              column: { type: 'STRING' as const },
              min: { type: 'NUMBER' as const },
              max: { type: 'NUMBER' as const },
            },
            required: ['column', 'min', 'max'],
          },
        },
      },
      required: ['ranges'],
    };
    const rangeResult = await callGemini({
      systemInstruction: `Given a BigQuery table ${fqTable} with numeric columns: ${numericCols.map((c) => `${c.name} (${c.type})`).join(', ')}, suggest reasonable expected min/max ranges for each column based on the column name and type. Be practical -- use domain knowledge (e.g. age: 0-150, percentage: 0-100, price: 0-1000000).`,
      prompt: `Return expected ranges for these numeric columns: ${numericCols.map((c) => c.name).join(', ')}`,
      schema: RangeSchema,
      project,
    });

    const ranges: Array<{ column: string; min: number; max: number }> = rangeResult?.ranges ?? [];
    if (ranges.length === 0) {
      // Fallback: just report min/max stats
      const statsExprs = numericCols.flatMap((col) => [
        `MIN(CAST(${col.name} AS FLOAT64)) AS \`${col.name}__min\``,
        `MAX(CAST(${col.name} AS FLOAT64)) AS \`${col.name}__max\``,
      ]);
      sql = `SELECT COUNT(*) AS __total_rows, ${statsExprs.join(', ')} FROM ${fqTable}`;
      onStatus?.(`Checking value ranges for ${numericCols.length} numeric columns in ${fqTable}...`);
      const executed = await executeQuery(sql, project);
      const row = executed.rows[0] ?? [];
      const colMap = Object.fromEntries(executed.columns.map((c, i) => [c, row[i]]));
      const totalRows = Number(colMap['__total_rows'] ?? 0);
      for (const col of numericCols) {
        findings.push({ column: col.name, metric: 'min_value', value: Number(colMap[`${col.name}__min`] ?? 0), severity: 'INFO' });
        findings.push({ column: col.name, metric: 'max_value', value: Number(colMap[`${col.name}__max`] ?? 0), severity: 'INFO' });
      }
      const result: DataQualityResult = {
        skill: 'data-quality', checkType: 'RANGE_VALIDATION', table: fqTable, sql,
        findings,
        summary: { rowsScanned: totalRows, issuesFound: 0, checkedAt },
      };
      return [compose('data-quality', result)];
    }

    // Build query to check ranges
    const rangeExprs = ranges.flatMap((r) => [
      `MIN(CAST(${r.column} AS FLOAT64)) AS \`${r.column}__min\``,
      `MAX(CAST(${r.column} AS FLOAT64)) AS \`${r.column}__max\``,
      `COUNTIF(CAST(${r.column} AS FLOAT64) < ${r.min} OR CAST(${r.column} AS FLOAT64) > ${r.max}) AS \`${r.column}__out_of_range\``,
    ]);
    sql = `SELECT COUNT(*) AS __total_rows, ${rangeExprs.join(', ')} FROM ${fqTable}`;
    onStatus?.(`Validating value ranges for ${ranges.length} columns in ${fqTable}...`);
    const executed = await executeQuery(sql, project);
    const row = executed.rows[0] ?? [];
    const colMap = Object.fromEntries(executed.columns.map((c, i) => [c, row[i]]));
    const totalRows = Number(colMap['__total_rows'] ?? 0);

    for (const r of ranges) {
      const outOfRange = Number(colMap[`${r.column}__out_of_range`] ?? 0);
      const actualMin = Number(colMap[`${r.column}__min`] ?? 0);
      const actualMax = Number(colMap[`${r.column}__max`] ?? 0);
      const severity: DqFinding['severity'] = outOfRange > 0 ? 'ISSUE' : 'INFO';
      findings.push({ column: r.column, metric: 'expected_range', value: `${r.min} - ${r.max}`, severity: 'INFO' });
      findings.push({ column: r.column, metric: 'actual_range', value: `${actualMin} - ${actualMax}`, severity: 'INFO' });
      findings.push({ column: r.column, metric: 'out_of_range_count', value: outOfRange, severity });
    }

    const issueCount = findings.filter((f) => f.severity !== 'INFO').length;
    const result: DataQualityResult = {
      skill: 'data-quality', checkType: 'RANGE_VALIDATION', table: fqTable, sql,
      findings,
      summary: { rowsScanned: totalRows, issuesFound: issueCount, checkedAt },
    };
    return [compose('data-quality', result)];
  }

  // REFERENTIAL_INTEGRITY — check FK relationships for orphaned rows
  if (intent.checkType === 'REFERENTIAL_INTEGRITY') {
    // Ask Gemini to identify likely FK relationships
    const FkSchema = {
      type: 'OBJECT' as const,
      properties: {
        relationships: {
          type: 'ARRAY' as const,
          items: {
            type: 'OBJECT' as const,
            properties: {
              fkColumn: { type: 'STRING' as const },
              referencedTable: { type: 'STRING' as const },
              referencedColumn: { type: 'STRING' as const },
            },
            required: ['fkColumn', 'referencedTable', 'referencedColumn'],
          },
        },
      },
      required: ['relationships'],
    };
    const fkResult = await callGemini({
      systemInstruction: `Given a BigQuery table ${fqTable} in project ${project} dataset ${ds} with columns: ${columns.map((c) => `${c.name} (${c.type})`).join(', ')}, identify likely foreign key relationships. Look for columns ending in _id, _key, or matching common patterns. For referencedTable, use the format \`${project}.${ds}.table_name\`. If no likely FK relationships exist, return an empty array.`,
      prompt: `Identify foreign key relationships for ${fqTable}`,
      schema: FkSchema,
      project,
    });

    const relationships: Array<{ fkColumn: string; referencedTable: string; referencedColumn: string }> = fkResult?.relationships ?? [];
    if (relationships.length === 0) {
      const result: DataQualityResult = {
        skill: 'data-quality', checkType: 'REFERENTIAL_INTEGRITY', table: fqTable, sql: '',
        findings: [{ column: '_table', metric: 'info', value: 'No foreign key relationships identified', severity: 'INFO' }],
        summary: { rowsScanned: 0, issuesFound: 0, checkedAt },
      };
      return [compose('data-quality', result)];
    }

    // Check each relationship with LEFT JOIN ... WHERE IS NULL
    onStatus?.(`Checking ${relationships.length} FK relationships for orphaned rows in ${fqTable}...`);
    let totalOrphans = 0;
    const queries: string[] = [];
    for (const rel of relationships) {
      const refTable = rel.referencedTable.includes('.') ? `\`${rel.referencedTable}\`` : `\`${project}.${ds}.${rel.referencedTable}\``;
      const checkSql = `SELECT COUNT(*) AS orphan_count FROM ${fqTable} a LEFT JOIN ${refTable} b ON a.${rel.fkColumn} = b.${rel.referencedColumn} WHERE b.${rel.referencedColumn} IS NULL AND a.${rel.fkColumn} IS NOT NULL`;
      queries.push(checkSql);
      try {
        const executed = await executeQuery(checkSql, project);
        const orphanCount = Number(executed.rows[0]?.[0] ?? 0);
        totalOrphans += orphanCount;
        const severity: DqFinding['severity'] = orphanCount > 0 ? 'ISSUE' : 'INFO';
        findings.push({
          column: rel.fkColumn,
          metric: 'orphaned_rows',
          value: orphanCount,
          severity,
        });
        findings.push({
          column: rel.fkColumn,
          metric: 'references',
          value: `${rel.referencedTable}.${rel.referencedColumn}`,
          severity: 'INFO',
        });
      } catch {
        findings.push({
          column: rel.fkColumn,
          metric: 'check_error',
          value: `Could not verify against ${rel.referencedTable}`,
          severity: 'WARNING',
        });
      }
    }

    sql = queries.join(';\n');
    const issueCount = findings.filter((f) => f.severity !== 'INFO').length;
    const result: DataQualityResult = {
      skill: 'data-quality', checkType: 'REFERENTIAL_INTEGRITY', table: fqTable, sql,
      findings,
      summary: { rowsScanned: totalOrphans, issuesFound: issueCount, checkedAt },
    };
    return [compose('data-quality', result)];
  }

  // SCHEMA_DRIFT — show current schema profile (no stored baseline yet)
  if (intent.checkType === 'SCHEMA_DRIFT') {
    sql = `SELECT column_name, data_type, is_nullable, ordinal_position FROM \`${project}.${ds}\`.INFORMATION_SCHEMA.COLUMNS WHERE table_name = '${tableName}' ORDER BY ordinal_position`;
    onStatus?.(`Fetching current schema for ${fqTable} to check for drift...`);
    const executed = await executeQuery(sql, project);

    for (const row of executed.rows) {
      const colName = String(row[0] ?? '');
      const dataType = String(row[1] ?? '');
      const nullable = String(row[2] ?? '');
      const position = Number(row[3] ?? 0);
      findings.push({
        column: colName,
        metric: 'data_type',
        value: dataType,
        severity: 'INFO',
      });
      findings.push({
        column: colName,
        metric: 'nullable',
        value: nullable,
        severity: 'INFO',
      });
      findings.push({
        column: colName,
        metric: 'ordinal_position',
        value: position,
        severity: 'INFO',
      });
    }

    // Add a note that no baseline is stored yet
    findings.unshift({
      column: '_table',
      metric: 'baseline_status',
      value: 'No stored baseline -- showing current schema as profile. Future runs can compare against this snapshot.',
      severity: 'INFO',
    });

    const result: DataQualityResult = {
      skill: 'data-quality', checkType: 'SCHEMA_DRIFT', table: fqTable, sql,
      findings,
      summary: { rowsScanned: executed.rowCount, issuesFound: 0, checkedAt },
    };
    return [compose('data-quality', result)];
  }

  // PROFILE or NULLS — build a single batched query
  const exprs = columns.flatMap((col) => {
    const base = [
      `COUNTIF(${col.name} IS NULL) AS \`${col.name}__nulls\``,
    ];
    if (intent.checkType === 'PROFILE') {
      if (['INT64', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC', 'INTEGER', 'FLOAT'].includes(col.type)) {
        base.push(
          `MIN(CAST(${col.name} AS FLOAT64)) AS \`${col.name}__min\``,
          `MAX(CAST(${col.name} AS FLOAT64)) AS \`${col.name}__max\``,
          `AVG(CAST(${col.name} AS FLOAT64)) AS \`${col.name}__avg\``,
        );
      }
      const noDistinctTypes = ['GEOGRAPHY', 'STRUCT', 'RECORD', 'ARRAY', 'JSON'];
      if (noDistinctTypes.includes(col.type.toUpperCase())) {
        base.push(`NULL AS \`${col.name}__distinct\``);
      } else {
        base.push(`APPROX_COUNT_DISTINCT(${col.name}) AS \`${col.name}__distinct\``);
      }
    }
    return base;
  });

  sql = `SELECT COUNT(*) AS __total_rows, ${exprs.join(', ')} FROM ${fqTable}`;
  onStatus?.(`Profiling ${columns.length} columns in ${fqTable}...`);

  // Cost gate: dry-run before profile/null scan to catch expensive tables
  try {
    const costResult = await dryRun(sql, project);
    if (costResult.requiresConfirmation) {
      const result: DataQualityResult = {
        skill: 'data-quality',
        checkType: intent.checkType as DataQualityResult['checkType'],
        table: fqTable,
        sql,
        findings: [],
        summary: { rowsScanned: 0, issuesFound: 0, checkedAt },
      };
      // Return cost confirmation envelope
      const envelope = compose('data-quality', result);
      envelope.requiresConfirmation = true;
      envelope.primaryArtifact = {
        type: 'COST_CONFIRM_CARD',
        data: {
          skill: 'query',
          sql,
          requiresConfirmation: true,
          costConfirm: {
            totalBytesProcessed: costResult.totalBytesProcessed,
            tier: costResult.tier,
            requiresConfirmation: true,
          },
          columns: [],
          rows: [],
          rowCount: 0,
          totalBytesProcessed: costResult.totalBytesProcessed,
          costTier: costResult.tier,
          suggestedVisualization: 'TABLE',
          notableFindings: null,
        } as QueryResult,
      };
      return [envelope];
    }
  } catch {
    // dry-run failed, proceed with execution (non-blocking)
  }

  let executed: Awaited<ReturnType<typeof executeQuery>>;
  try {
    executed = await executeQuery(sql, project);
  } catch (err) {
    // Auto-retry with safe query: null counts only (no DISTINCT/MIN/MAX)
    console.warn('[data-quality] Full profile query failed, retrying safe version:', err);
    onStatus?.(`Full profile query failed, retrying with null-counts only on ${fqTable}...`);
    const safeExprs = columns.map((col) =>
      `COUNTIF(${col.name} IS NULL) AS \`${col.name}__nulls\``
    );
    sql = `SELECT COUNT(*) AS __total_rows, ${safeExprs.join(', ')} FROM ${fqTable}`;
    executed = await executeQuery(sql, project);
  }

  const row = executed.rows[0] ?? [];
  const colMap = Object.fromEntries(executed.columns.map((c, i) => [c, row[i]]));
  const totalRows = Number(colMap['__total_rows'] ?? 0);

  for (const col of columns) {
    const nullCount = Number(colMap[`${col.name}__nulls`] ?? 0);
    const nullRate = totalRows > 0 ? nullCount / totalRows : 0;
    const nullSeverity: DqFinding['severity'] = nullRate > 0.5 ? 'ISSUE' : nullRate > 0.1 ? 'WARNING' : 'INFO';
    findings.push({ column: col.name, metric: 'null_rate', value: parseFloat(nullRate.toFixed(4)), severity: nullSeverity });

    if (intent.checkType === 'PROFILE') {
      const distinctKey = `${col.name}__distinct`;
      // Only add distinct count if the column exists in the result (may be absent in safe mode)
      if (distinctKey in colMap) {
        const distinct = Number(colMap[distinctKey] ?? 0);
        findings.push({ column: col.name, metric: 'distinct_count', value: distinct, severity: 'INFO' });
      }
    }
  }

  const issueCount = findings.filter((f) => f.severity !== 'INFO').length;
  const result: DataQualityResult = {
    skill: 'data-quality', checkType: intent.checkType as DataQualityResult['checkType'],
    table: fqTable, sql,
    findings,
    summary: { rowsScanned: totalRows, issuesFound: issueCount, checkedAt },
  };
  return [compose('data-quality', result)];
}

// ─── Data Loading handler ──────────────────────────────────────────────────────

async function handleDataLoading(
  message: string,
  context?: { project?: string; dataset?: string; lastTable?: string; uid?: string; handoffContext?: Record<string, unknown> },
  onStatus?: (status: string) => void
): Promise<CompositionEnvelope[]> {
  const project = context?.project || '';
  const hc = context?.handoffContext;
  let dataset = context?.dataset || '';
  if (dataset && project && dataset.toLowerCase() === project.toLowerCase()) {
    dataset = '';
  }

  // If handoff context carries a pre-classified operation type, skip LLM
  let intent: { operationType: string; tableName?: string; sql?: string; displayName?: string; schedule?: string };
  if (hc?.operationType && typeof hc.operationType === 'string') {
    intent = {
      operationType: hc.operationType as string,
      tableName: (hc.table as string) ?? (hc.tableName as string) ?? undefined,
      sql: (hc.sql as string) ?? undefined,
      displayName: (hc.displayName as string) ?? undefined,
      schedule: (hc.schedule as string) ?? undefined,
    };
    onStatus?.(`Running ${intent.operationType} (from handoff)...`);
  } else {
    onStatus?.(`Analyzing export request (project: ${project}, dataset: ${dataset || 'none'})...`);
    intent = await callGemini({
      systemInstruction: `Classify a BigQuery data loading request. EXPORT_CSV = download as CSV. EXPORT_SHEETS = send to Google Sheets. SCHEDULE = schedule a recurring query. SAVED_QUERY = save a query for later reuse. SHARE = share or copy query results. Extract the table name or SQL to use. For SCHEDULE, also extract a schedule frequency into 'schedule' (e.g. 'every 24 hours', 'every monday 09:00') and a display name into 'displayName'. Project: ${project}, dataset: ${dataset}`,
      prompt: message,
      schema: DataLoadingIntentSchema,
      project,
    });
  }

  // SCHEDULE — create via Data Transfer API, fall back to guidance
  if (intent.operationType === 'SCHEDULE') {
    const sql = intent.sql ?? (intent.tableName ? `SELECT * FROM \`${project}.${dataset}.${intent.tableName}\`` : '');
    const displayName = intent.displayName || 'Scheduled Query';
    const schedule = intent.schedule || 'every 24 hours';

    try {
      onStatus?.(`Creating scheduled query "${displayName}" (${schedule})...`);
      const { transferConfigName } = await createScheduledQuery(project, displayName, sql, schedule);
      const result: DataLoadingResult = {
        skill: 'data-loading',
        operationType: 'SCHEDULE_CREATED',
        message: `Scheduled query created: "${displayName}" running ${schedule}.`,
        sql,
        scheduleName: transferConfigName,
        scheduleFrequency: schedule,
      };
      return [compose('data-loading', result)];
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const fallbackMsg = `Could not create scheduled query automatically (${errMsg}).\n\nTo schedule manually, run:\nbq query --schedule="${schedule}" --display_name="${displayName}" --destination_table=${project}:${dataset || 'dataset'}.scheduled_results --replace "${sql.replace(/"/g, '\\"')}"\n\nOr use the BigQuery Console: open bigquery.cloud.google.com, paste the SQL into the editor, and click More > Schedule.`;
      const result: DataLoadingResult = {
        skill: 'data-loading',
        operationType: 'SCHEDULE_INFO',
        message: fallbackMsg,
        sql,
      };
      return [compose('data-loading', result)];
    }
  }

  // SAVED_QUERY — save to Firestore Prompts Library
  if (intent.operationType === 'SAVED_QUERY') {
    const sqlToSave = intent.sql ?? (intent.tableName ? `SELECT * FROM \`${project}.${dataset}.${intent.tableName}\`` : '');
    const label = intent.displayName || 'Saved Query';
    const uid = context?.uid;

    if (uid && sqlToSave) {
      try {
        onStatus?.(`Saving query "${label}"...`);
        await firestoreSaveQuery(uid, label, sqlToSave);
        const result: DataLoadingResult = {
          skill: 'data-loading',
          operationType: 'QUERY_SAVED',
          message: `Query saved as "${label}". You can find it in the Prompts Library.`,
          sql: sqlToSave,
          savedQueryLabel: label,
        };
        return [compose('data-loading', result)];
      } catch {
        // Fall through to guidance
      }
    }

    const result: DataLoadingResult = {
      skill: 'data-loading',
      operationType: 'SCHEDULE_INFO',
      message: 'To save this query:\n\n1. Open the BigQuery Console at bigquery.cloud.google.com\n2. Paste the SQL below into the query editor\n3. Click "Save" > "Save query" in the toolbar\n4. Name it and optionally share with your team\n\nSaved queries appear under "Saved Queries" in the BigQuery Console sidebar.',
      sql: sqlToSave,
    };
    return [compose('data-loading', result)];
  }

  // EXPORT_SHEETS — create a Google Spreadsheet and write results
  if (intent.operationType === 'EXPORT_SHEETS') {
    const sheetsSql = intent.sql ?? (intent.tableName
      ? `SELECT * FROM \`${project}.${dataset}.${intent.tableName}\` LIMIT 50000`
      : null);

    if (sheetsSql) {
      try {
        onStatus?.(`Running query for Sheets export...`);
        const executed = await executeQuery(sheetsSql, project);
        onStatus?.(`Creating Google Spreadsheet with ${executed.rowCount} rows...`);
        const title = `BQ Export - ${new Date().toLocaleDateString()} - ${intent.tableName || 'query'}`;
        const { spreadsheetUrl } = await exportToSheets(title, executed.columns, executed.rows);
        const result: DataLoadingResult = {
          skill: 'data-loading',
          operationType: 'EXPORT_SHEETS',
          message: `Exported ${executed.rowCount} rows to Google Sheets.`,
          sheetsUrl: spreadsheetUrl,
          rowCount: executed.rowCount,
          columnCount: executed.columns.length,
          sql: sheetsSql,
        };
        return [compose('data-loading', result)];
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const result: DataLoadingResult = {
          skill: 'data-loading',
          operationType: 'SCHEDULE_INFO',
          message: `Could not export to Sheets automatically (${errMsg}).\n\nTo export manually:\n1. Run the query in the BigQuery Console\n2. Click "Explore Data" > "Explore with Sheets" in the results toolbar\n3. This opens a connected Sheet that stays linked to the query\n\nNote: Direct Sheets export is limited to 10 million cells.`,
          sql: sheetsSql,
        };
        return [compose('data-loading', result)];
      }
    }

    const result: DataLoadingResult = {
      skill: 'data-loading',
      operationType: 'NOT_SUPPORTED',
      message: 'No table or SQL found to export. Please specify a table name or run a query first.',
    };
    return [compose('data-loading', result)];
  }

  // SHARE — copy results as formatted text
  if (intent.operationType === 'SHARE') {
    const shareSql = intent.sql ?? (intent.tableName
      ? `SELECT * FROM \`${project}.${dataset}.${intent.tableName}\` LIMIT 100`
      : null);

    if (shareSql) {
      try {
        onStatus?.(`Running query for sharing...`);
        const executed = await executeQuery(shareSql, project);
        // Build a text table for clipboard
        const colWidths = executed.columns.map((col, ci) => {
          const vals = executed.rows.slice(0, 20).map(r => String(r[ci] ?? '').length);
          return Math.max(col.length, ...vals, 4);
        });
        const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
        const header = executed.columns.map((c, i) => pad(c, colWidths[i])).join(' | ');
        const separator = colWidths.map(w => '-'.repeat(w)).join('-+-');
        const dataRows = executed.rows.slice(0, 50).map(row =>
          row.map((cell, i) => pad(String(cell ?? ''), colWidths[i])).join(' | ')
        );
        const shareText = [header, separator, ...dataRows].join('\n');

        const result: DataLoadingResult = {
          skill: 'data-loading',
          operationType: 'SHARE_CLIPBOARD',
          message: `Query results ready to share (${executed.rowCount} rows, showing first ${Math.min(50, executed.rowCount)}).`,
          shareText,
          sql: shareSql,
          rowCount: executed.rowCount,
          columnCount: executed.columns.length,
        };
        return [compose('data-loading', result)];
      } catch {
        // Fall through
      }
    }

    const result: DataLoadingResult = {
      skill: 'data-loading',
      operationType: 'NOT_SUPPORTED',
      message: 'No table or SQL found to share. Please specify a table name or run a query first.',
    };
    return [compose('data-loading', result)];
  }

  // EXPORT_CSV — run the query and convert to CSV
  const sql = intent.sql ?? (intent.tableName
    ? `SELECT * FROM \`${project}.${dataset}.${intent.tableName}\` LIMIT 1000`
    : null);

  if (!sql) {
    const result: DataLoadingResult = {
      skill: 'data-loading', operationType: 'NOT_SUPPORTED',
      message: 'No table or SQL found to export. Please specify a table name.',
    };
    return [compose('data-loading', result)];
  }

  const executed = await executeQuery(sql, project);

  // Build CSV
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csvLines = [
    executed.columns.join(','),
    ...executed.rows.map((row) => row.map(escape).join(',')),
  ];
  const csvContent = csvLines.join('\n');

  const result: DataLoadingResult = {
    skill: 'data-loading',
    operationType: 'EXPORT_CSV',
    message: `Ready to download ${executed.rowCount} rows.`,
    csvContent,
    rowCount: executed.rowCount,
    columnCount: executed.columns.length,
    sql,
  };
  return [compose('data-loading', result)];
}

// ─── Discovery handler ─────────────────────────────────────────────────────────

async function handleDiscovery(
  message: string,
  context?: { project?: string; dataset?: string; handoffContext?: Record<string, unknown> },
  onStatus?: (status: string) => void
): Promise<CompositionEnvelope[]> {
  const project = context?.project || '';
  const hc = context?.handoffContext;
  const available = await getAvailableDatasets(project);

  // If handoff context carries a pre-classified discovery type, skip LLM
  let intent: { discoveryType: string; query: string; tableName?: string; secondTable?: string };
  if (hc?.discoveryType && typeof hc.discoveryType === 'string') {
    intent = {
      discoveryType: hc.discoveryType as string,
      query: (hc.query as string) ?? (hc.table as string) ?? '',
      tableName: (hc.tableName as string) ?? (hc.table as string) ?? undefined,
      secondTable: (hc.secondTable as string) ?? undefined,
    };
    onStatus?.(`Running ${intent.discoveryType} (from handoff)...`);
  } else {
    intent = await callGemini({
      systemInstruction: `You are a BigQuery discovery assistant. Classify the user's request as either SEARCH (find tables/views matching a term), COMPARISON (compare two specific tables' schemas), LINEAGE (trace where data comes from or what depends on a table), or ER_DIAGRAM (show entity relationships, foreign keys, table relationships in a dataset). Extract the search term or table name into 'query'. For COMPARISON, extract the second table into 'secondTable'. For LINEAGE, extract the table name into 'tableName'. For ER_DIAGRAM, extract the dataset name into 'query'. The active project is ${project}, available datasets are: ${available.join(', ')}.`,
      prompt: message,
      schema: DiscoveryResponseSchema,
      project,
    });
  }

  // LINEAGE: trace upstream and downstream dependencies via INFORMATION_SCHEMA.JOBS
  if (intent.discoveryType === 'LINEAGE') {
    const tableName = intent.tableName || intent.query;
    const tableLower = tableName.toLowerCase().replace(/`/g, '');
    onStatus?.(`Tracing lineage for "${tableName}"...`);

    const lineageRegion = await detectBqRegion(project);
    const lineageSql = `SELECT job_id, user_email, statement_type, creation_time, destination_table, referenced_tables FROM \`${project}\`.\`region-${lineageRegion}\`.INFORMATION_SCHEMA.JOBS_BY_PROJECT WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY) AND (LOWER(CAST(destination_table AS STRING)) LIKE '%${tableLower}%' OR LOWER(CAST(referenced_tables AS STRING)) LIKE '%${tableLower}%') ORDER BY creation_time DESC LIMIT 50`;

    let readsFrom: string[] = [];
    let writtenBy: string[] = [];
    const nodes: import('./types').LineageNode[] = [];
    const edgeMap = new Map<string, import('./types').LineageEdge>();
    const nodeSet = new Set<string>();

    const ensureNode = (id: string, type: import('./types').LineageNode['type'] = 'TABLE') => {
      const lower = id.toLowerCase();
      if (nodeSet.has(lower)) return;
      nodeSet.add(lower);
      const parts = id.split('.');
      const ds = parts.length >= 2 ? parts[parts.length - 2] : '';
      nodes.push({ id: lower, label: parts[parts.length - 1] || id, type, dataset: ds });
    };

    const addEdge = (source: string, target: string, stmtType: string, time: string) => {
      const key = `${source}->${target}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.jobCount++;
        if (time > existing.lastSeen) existing.lastSeen = time;
        if (!existing.statementTypes.includes(stmtType)) existing.statementTypes.push(stmtType);
      } else {
        edgeMap.set(key, { source, target, jobCount: 1, lastSeen: time, statementTypes: [stmtType] });
      }
    };

    try {
      const executed = await executeQuery(lineageSql, project);
      const iDest = executed.columns.indexOf('destination_table');
      const iRefs = executed.columns.indexOf('referenced_tables');
      const iStmt = executed.columns.indexOf('statement_type');
      const iTime = executed.columns.indexOf('creation_time');

      const upstreamSet = new Set<string>();
      const downstreamSet = new Set<string>();

      for (const row of executed.rows) {
        const destStr = String(row[iDest] ?? '').toLowerCase();
        const refsStr = String(row[iRefs] ?? '').toLowerCase();
        const stmtType = String(row[iStmt] ?? '');
        const timeStr = String(row[iTime] ?? '');

        const destMatchesTarget = destStr.includes(tableLower);
        const refsMatchTarget = refsStr.includes(tableLower);

        if (destMatchesTarget && refsStr) {
          const refs = refsStr.match(/[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/g);
          if (refs) {
            refs.forEach(r => {
              upstreamSet.add(r);
              ensureNode(r, 'TABLE');
              addEdge(r, tableLower, stmtType, timeStr);
            });
          }
        }
        if (refsMatchTarget && destStr) {
          const dests = destStr.match(/[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/g);
          if (dests) {
            dests.forEach(d => {
              downstreamSet.add(d);
              ensureNode(d, 'TABLE');
              addEdge(tableLower, d, stmtType, timeStr);
            });
          }
        }
      }

      upstreamSet.delete(tableLower);
      downstreamSet.delete(tableLower);
      readsFrom = Array.from(upstreamSet);
      writtenBy = Array.from(downstreamSet);
    } catch {
      // INFORMATION_SCHEMA.JOBS access may fail -- return empty lineage
    }

    // Ensure the target node exists
    ensureNode(tableLower, 'TARGET');

    const result: DiscoveryResult = {
      skill: 'discovery',
      discoveryType: 'LINEAGE',
      query: intent.query,
      results: [],
      comparison: null,
      lineage: {
        tableName,
        readsFrom,
        writtenBy,
        nodes,
        edges: Array.from(edgeMap.values()),
      },
    };
    return [compose('discovery', result)];
  }

  // ER_DIAGRAM: show foreign key relationships in a dataset
  if (intent.discoveryType === 'ER_DIAGRAM') {
    const datasetName = intent.query || intent.tableName || '';
    onStatus?.(`Building ER diagram for "${datasetName}"...`);

    try {
      // Fetch all tables and their columns with constraints
      const colsSql = `SELECT table_name, column_name, data_type, ordinal_position FROM \`${project}.${datasetName}\`.INFORMATION_SCHEMA.COLUMNS ORDER BY table_name, ordinal_position`;
      const constraintsSql = `SELECT ccu.table_name AS from_table, ccu.column_name AS from_column, kcu.table_name AS to_table, kcu.column_name AS to_column FROM \`${project}.${datasetName}\`.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu JOIN \`${project}.${datasetName}\`.INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON ccu.constraint_name = kcu.constraint_name WHERE ccu.table_name != kcu.table_name`;
      const pkSql = `SELECT kcu.table_name, kcu.column_name FROM \`${project}.${datasetName}\`.INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu JOIN \`${project}.${datasetName}\`.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ON kcu.constraint_name = tc.constraint_name WHERE tc.constraint_type = 'PRIMARY KEY'`;

      const [colsResult, pkResult] = await Promise.all([
        executeQuery(colsSql, project),
        executeQuery(pkSql, project).catch(() => ({ columns: [], rows: [] as unknown[][] })),
      ]);

      // Build table/column map
      const tableMap = new Map<string, Array<{ name: string; type: string; isPk: boolean }>>();
      const pkSet = new Set<string>();
      for (const row of pkResult.rows) {
        pkSet.add(`${row[0]}.${row[1]}`);
      }
      for (const row of colsResult.rows) {
        const tbl = String(row[0] ?? '');
        const col = String(row[1] ?? '');
        const type = String(row[2] ?? '');
        if (!tableMap.has(tbl)) tableMap.set(tbl, []);
        tableMap.get(tbl)!.push({ name: col, type, isPk: pkSet.has(`${tbl}.${col}`) });
      }

      const tables: import('./types').ErTableInfo[] = Array.from(tableMap.entries()).map(([name, columns]) => ({
        name,
        columns,
      }));

      // Fetch FK relationships
      let relationships: import('./types').ErRelationship[] = [];
      try {
        const fkResult = await executeQuery(constraintsSql, project);
        const fkMap = new Map<string, import('./types').ErRelationship>();
        for (const row of fkResult.rows) {
          const fromTable = String(row[0] ?? '');
          const fromCol = String(row[1] ?? '');
          const toTable = String(row[2] ?? '');
          const toCol = String(row[3] ?? '');
          const key = `${fromTable}->${toTable}`;
          if (!fkMap.has(key)) {
            fkMap.set(key, { fromTable, fromColumns: [], toTable, toColumns: [], type: 'FOREIGN_KEY' });
          }
          const rel = fkMap.get(key)!;
          if (!rel.fromColumns.includes(fromCol)) rel.fromColumns.push(fromCol);
          if (!rel.toColumns.includes(toCol)) rel.toColumns.push(toCol);
        }
        relationships = Array.from(fkMap.values());
      } catch {
        // Constraints query may fail -- return tables without relationships
      }

      const erData: import('./types').ErDiagramData = {
        dataset: datasetName,
        tables,
        relationships,
      };

      const result: DiscoveryResult = {
        skill: 'discovery',
        discoveryType: 'ER_DIAGRAM',
        query: datasetName,
        results: [],
        comparison: null,
        lineage: null,
        erDiagram: erData,
      };
      return [compose('discovery', result)];
    } catch {
      const result: DiscoveryResult = {
        skill: 'discovery',
        discoveryType: 'ER_DIAGRAM',
        query: datasetName,
        results: [],
        comparison: null,
        lineage: null,
        erDiagram: { dataset: datasetName, tables: [], relationships: [] },
      };
      return [compose('discovery', result)];
    }
  }

  if (intent.discoveryType === 'COMPARISON') {
    const leftRef = intent.query;
    const rightRef = intent.secondTable ?? '';

    const parseRef = (ref: string) => {
      const parts = ref.replace(/`/g, '').split('.');
      return { dataset: parts[parts.length - 2] ?? '', table: parts[parts.length - 1] ?? '' };
    };

    const leftParsed = parseRef(leftRef);
    const rightParsed = parseRef(rightRef);

    const [leftSchema, rightSchema] = await Promise.all([
      fetchSchema(leftParsed.dataset || undefined, leftParsed.table || undefined, project).catch(() => null),
      fetchSchema(rightParsed.dataset || undefined, rightParsed.table || undefined, project).catch(() => null),
    ]);

    const leftCols = new Map((leftSchema?.columns ?? []).map((c) => [c.name, c.type]));
    const rightCols = new Map((rightSchema?.columns ?? []).map((c) => [c.name, c.type]));

    const addedColumns: Array<{ name: string; type: string }> = [];
    const removedColumns: Array<{ name: string; type: string }> = [];
    const changedColumns: Array<{ name: string; fromType: string; toType: string }> = [];

    for (const [name, type] of rightCols) {
      if (!leftCols.has(name)) {
        addedColumns.push({ name, type });
      } else if (leftCols.get(name) !== type) {
        changedColumns.push({ name, fromType: leftCols.get(name)!, toType: type });
      }
    }
    for (const [name, type] of leftCols) {
      if (!rightCols.has(name)) {
        removedColumns.push({ name, type });
      }
    }

    const result: DiscoveryResult = {
      skill: 'discovery',
      discoveryType: 'COMPARISON',
      query: intent.query,
      results: [],
      comparison: {
        left: leftRef,
        right: rightRef,
        addedColumns,
        removedColumns,
        changedColumns,
      },
    };
    return [compose('discovery', result)];
  }

  // SEARCH: query INFORMATION_SCHEMA across all datasets
  const projectSchema = await fetchSchema(undefined, undefined, project);
  const datasets = projectSchema.columns
    .map((c) => c.name)
    .filter((name) => name && name.toLowerCase() !== project.toLowerCase());

  const term = intent.query.toLowerCase();
  // Build search variants for basic plural/singular stemming
  const searchTerms = new Set<string>([term]);
  if (term.endsWith('ies')) searchTerms.add(term.slice(0, -3) + 'y');
  if (term.endsWith('es')) searchTerms.add(term.slice(0, -2));
  if (term.endsWith('s') && !term.endsWith('ss')) searchTerms.add(term.slice(0, -1));
  // Also add plural of singular
  if (!term.endsWith('s')) searchTerms.add(term + 's');
  const likeConditions = Array.from(searchTerms)
    .map((t) => `LOWER(t.table_name) LIKE '%${t}%'`)
    .join(' OR ');
  const colLikeConditions = Array.from(searchTerms)
    .map((t) => `LOWER(column_name) LIKE '%${t}%'`)
    .join(' OR ');
  const resultsMap = new Map<string, DiscoverySearchResult>();

  onStatus?.(`Searching for \"${term}\" across ${datasets.length} datasets in ${project}...`);
  await Promise.all(
    datasets.map(async (dataset) => {
      try {
        // Match table names
        const tablesSql = [
          `SELECT t.table_name, t.table_type, o.option_value AS description`,
          `FROM \`${project}.${dataset}\`.INFORMATION_SCHEMA.TABLES t`,
          `LEFT JOIN \`${project}.${dataset}\`.INFORMATION_SCHEMA.TABLE_OPTIONS o`,
          `  ON t.table_name = o.table_name AND o.option_name = 'description'`,
          `WHERE ${likeConditions}`,
        ].join(' ');

        const tablesResult = await executeQuery(tablesSql, project).catch(() => null);
        if (tablesResult) {
          for (const row of tablesResult.rows) {
            const name = String(row[0] ?? '');
            const rawType = String(row[1] ?? 'TABLE').toUpperCase();
            const type: DiscoverySearchResult['type'] =
              rawType === 'VIEW' ? 'VIEW' : 'TABLE';
            const ref = `${project}.${dataset}.${name}`;
            if (!resultsMap.has(ref)) {
              resultsMap.set(ref, {
                type,
                ref,
                matchedOn: 'table_name',
                description: row[2] ? String(row[2]).replace(/^"|"+$/g, '') : null,
              });
            }
          }
        }

        // Match column names
        const colsSql = [
          `SELECT DISTINCT table_name`,
          `FROM \`${project}.${dataset}\`.INFORMATION_SCHEMA.COLUMNS`,
          `WHERE ${colLikeConditions}`,
        ].join(' ');

        const colsResult = await executeQuery(colsSql, project).catch(() => null);
        if (colsResult) {
          for (const row of colsResult.rows) {
            const name = String(row[0] ?? '');
            const ref = `${project}.${dataset}.${name}`;
            if (!resultsMap.has(ref)) {
              resultsMap.set(ref, {
                type: 'TABLE',
                ref,
                matchedOn: 'column_name',
                description: null,
              });
            } else {
              const existing = resultsMap.get(ref)!;
              if (existing.matchedOn === 'table_name') {
                existing.matchedOn = 'table_name, column_name';
              }
            }
          }
        }
      } catch {
        // Non-fatal — skip inaccessible datasets
      }
    })
  );

  const result: DiscoveryResult = {
    skill: 'discovery',
    discoveryType: 'SEARCH',
    query: intent.query,
    results: Array.from(resultsMap.values()),
    comparison: null,
  };
  return [compose('discovery', result)];
}
