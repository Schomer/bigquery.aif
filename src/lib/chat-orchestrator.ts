// src/lib/chat-orchestrator.ts
// Per-turn client-side orchestration: receive message → router → skill dispatch → compose → return envelopes
// Runs entirely in the browser using the Gemini API REST endpoint via the configured API key.

import { classifyIntent, resolveReferences } from './router';
import { fetchSchema } from './skills/schema';
import { compose } from './composer';
import { dryRun, executeQuery, executeDml } from './bigquery-client';
import type {
  ChatMessage,
  CompositionEnvelope,
  DataManagementResult,
  DataQualityResult,
  DqFinding,
  MonitoringJob,
  MonitoringResult,
  DiscoveryResult,
  DiscoverySearchResult,
  DataLoadingResult,
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
    suggestedVisualization: { type: 'STRING', enum: ['TABLE', 'LINE_CHART', 'BAR_CHART', 'AREA_CHART', 'SCATTER', 'PIE_CHART', 'KPI_CARD'] },
    xAxis: { type: 'STRING' },
    yAxis: { type: 'ARRAY', items: { type: 'STRING' } },
    notableFindings: { type: 'STRING' },
    resultSummary: { type: 'STRING' }
  },
  required: ['sql', 'suggestedVisualization']
};

const DataManagementResponseSchema = {
  type: 'OBJECT',
  properties: {
    operation: { type: 'STRING', enum: ['DEDUPE', 'DELETE', 'UPDATE', 'FILL_NULLS', 'CREATE_TABLE', 'ALTER_TABLE', 'CREATE_VIEW', 'RENAME', 'COPY_TABLE'] },
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
    discoveryType: { type: 'STRING', enum: ['SEARCH', 'COMPARISON'] },
    query: { type: 'STRING' },
    secondTable: { type: 'STRING' }
  },
  required: ['discoveryType', 'query']
};

const DqIntentSchema = {
  type: 'OBJECT',
  properties: {
    checkType: { type: 'STRING', enum: ['PROFILE', 'NULLS', 'DUPLICATES', 'FRESHNESS'] },
    table: { type: 'STRING' },
    dataset: { type: 'STRING' }
  },
  required: ['checkType']
};

const DataLoadingIntentSchema = {
  type: 'OBJECT',
  properties: {
    operationType: { type: 'STRING', enum: ['EXPORT_CSV', 'EXPORT_SHEETS', 'SCHEDULE'] },
    tableName: { type: 'STRING' },
    sql: { type: 'STRING' }
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
    confirmedPayload?: DataManagementResult;
    forcedSkill?: SkillName;
    resolvedDataset?: string;
    availableDatasets?: string[];
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

    // ── Classify intent via LLM (unified skill routing + multistep detection) ──
    let skill = context?.forcedSkill;
    if (!skill) {
      try {
        const available = availableDatasets ?? await getAvailableDatasets(project);
        const dataset = resolvedDataset ?? resolveDefaultDatasetFromList(available, context?.dataset, project);
        availableDatasets = available;
        resolvedDataset = dataset;
        const messages = history.slice(-6).map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

        onStatus?.('Classifying request...');

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

      // Fallback: keyword-based classification if LLM didn't return a skill
      if (!skill) {
        const routerOutput = classifyIntent(resolvedMessage, context);
        skill = routerOutput.skill;
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
    onStatus?.(`Routing to ${skillLabels[skill] || skill}...`);

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

// Try to extract a dataset or table identifier from the message.
// Handles patterns like "tables in ecomm", "describe orders", "schema of users",
// and backtick-quoted refs like `project.dataset.table`.
function extractSchemaIdentifiers(
  message: string,
  contextDataset?: string,
  availableDatasets?: string[],
): { scope: 'PROJECT' | 'DATASET' | 'TABLE'; dataset?: string; table?: string } | null {
  const lower = message.toLowerCase();

  // PROJECT scope: listing datasets
  if (DATASET_LIST_SIGNALS.some((s) => lower.includes(s))) {
    return { scope: 'PROJECT' };
  }

  // DATASET scope: listing tables -- try to extract dataset name
  if (TABLE_LIST_SIGNALS.some((s) => lower.includes(s))) {
    // "tables in ecomm", "list tables in my_dataset"
    const dsMatch = message.match(/\btables?\s+(?:in|of|from)\s+[`]?(\w[\w-]*)[`]?/i);
    return { scope: 'DATASET', dataset: dsMatch?.[1] ?? contextDataset };
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
      /(?:describe|schema\s+(?:of|for)|(?:tell|more|details)\s+(?:me\s+)?(?:more\s+)?about|inspect|explore|look\s+at|what'?s?\s+in)\s+(?:the\s+)?[`]?(\w[\w-]*)\.(\w[\w-]*)[`]?/i
    );
    if (dottedMatch) {
      return { scope: 'TABLE', dataset: dottedMatch[1], table: dottedMatch[2] };
    }
    // "describe orders", "schema of users", "tell me about orders"
    const tblMatch = message.match(
      /(?:describe|schema\s+(?:of|for)|(?:tell|more|details)\s+(?:me\s+)?(?:more\s+)?about|inspect|explore|look\s+at|what'?s?\s+in)\s+(?:the\s+)?[`]?(\w[\w-]*)[`]?/i
    );
    if (tblMatch) {
      const name = tblMatch[1];
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
    onStatus?.('Analyzing request...');
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
  // generate a custom INFORMATION_SCHEMA query that honors their instructions.
  if (!table && ENRICHMENT_PATTERNS.some((p) => p.test(message))) {
    onStatus?.('Building enriched query...');

    const scope = resolvedDataset ? 'DATASET' : 'PROJECT';
    const dsRef = resolvedDataset
      ? `\`${project}.${resolvedDataset}\``
      : '\`region-us\`';

    const enrichPrompt = `Generate a BigQuery INFORMATION_SCHEMA SQL query that fulfills the user's request.

The user is requesting a ${scope}-level listing${resolvedDataset ? ` within dataset \`${resolvedDataset}\`` : ''} with additional requirements.

Project: ${project}
${resolvedDataset ? `Dataset: ${resolvedDataset}` : `Available datasets: ${available.join(', ')}`}

INFORMATION_SCHEMA reference:
- Project-level dataset list: SELECT schema_name FROM \`region-us\`.INFORMATION_SCHEMA.SCHEMATA
- Cross-dataset table info: SELECT table_schema, table_name, table_type, creation_time FROM \`region-us\`.INFORMATION_SCHEMA.TABLES
- Cross-dataset storage: SELECT table_schema, table_name, total_rows, total_logical_bytes, total_physical_bytes FROM \`region-us\`.INFORMATION_SCHEMA.TABLE_STORAGE
- Dataset-level tables: SELECT * FROM ${dsRef}.INFORMATION_SCHEMA.TABLES
- Dataset-level storage: SELECT table_name, total_rows, total_logical_bytes FROM ${dsRef}.INFORMATION_SCHEMA.TABLE_STORAGE
- Dataset-level columns: SELECT table_name, column_name, data_type, is_nullable FROM ${dsRef}.INFORMATION_SCHEMA.COLUMNS

Rules:
- The FIRST column MUST be the primary entity identifier: alias as 'dataset_name' (project scope) or 'table_name' (dataset scope).
- Use descriptive aliases for all other columns (e.g., 'table_count', 'total_size_bytes', 'row_count', 'last_modified').
- Always wrap identifiers containing hyphens in backticks.
- Return valid GoogleSQL only.`;

    const plan = await callGemini({
      systemInstruction: enrichPrompt,
      prompt: message,
      schema: EnrichedSchemaQuerySchema,
      project,
    });

    onStatus?.('Running query...');
    const executed = await executeQuery(plan.sql, project);

    const queryResult: QueryResult = {
      skill: 'query',
      sql: plan.sql,
      requiresConfirmation: false,
      costConfirm: null,
      columns: executed.columns,
      rows: executed.rows,
      rowCount: executed.rowCount,
      totalBytesProcessed: 0,
      costTier: 1,
      suggestedVisualization: 'TABLE',
      notableFindings: null,
      resultSummary: plan.resultSummary,
    };

    return [compose('query', queryResult)];
  }

  onStatus?.('Fetching schema...');

  // For table-level lookups, if the table isn't found in the assumed dataset,
  // search across all datasets. Handles "tell me more about X" when the table
  // lives in a different dataset than the current context.
  if (table) {
    try {
      const result = await fetchSchema(resolvedDataset, table, project);
      return [compose('schema', result)];
    } catch (err: any) {
      if (err.message?.includes('Not found')) {
        onStatus?.('Searching other datasets...');
        const allDatasets = await getAvailableDatasets(project);
        for (const ds of allDatasets) {
          if (ds === resolvedDataset) continue;
          try {
            const result = await fetchSchema(ds, table, project);
            return [compose('schema', result)];
          } catch {
            // not in this dataset either -- keep looking
          }
        }
      }
      throw err; // re-throw if not a "Not found" error or table truly doesn't exist
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
  const dataset = context?.resolvedDataset ?? resolveDefaultDatasetFromList(available, context?.dataset, project);

  const messages = history.slice(-6).map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  const schemaContext = await buildSchemaContext(project, dataset);

  onStatus?.('Building SQL query...');
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
Also generate a resultSummary field: a brief, contextual one-line summary of what the query results likely show (e.g., 'Revenue by month for the last 12 months' or 'Top 10 customers by order count'). This will be used as the headline shown to the user.`,
    messages: [...messages, { role: 'user' as const, content: message }],
    schema: QueryResponseSchema,
    project,
  });

  // Run dry-run and execution in parallel -- if the dry run says the query
  // needs confirmation (tier 3+), we discard the execution result.
  onStatus?.('Executing query...');
  const [costResult, executed] = await Promise.all([
    dryRun(queryPlan.sql, project),
    executeQuery(queryPlan.sql, project),
  ]);

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

  const result: QueryResult = {
    skill: 'query',
    sql: queryPlan.sql,
    requiresConfirmation: false,
    costConfirm: null,
    columns: executed.columns,
    rows: executed.rows,
    rowCount: executed.rowCount,
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
  context?: { project?: string; dataset?: string; resolvedDataset?: string; availableDatasets?: string[] },
  onStatus?: (status: string) => void
): Promise<CompositionEnvelope[]> {
  const project = context?.project || '';

  // Parallelize: skill doc and dataset resolution
  const [skillDoc, available] = await Promise.all([
    loadSkillDoc('data-management'),
    context?.availableDatasets ?? getAvailableDatasets(project),
  ]);
  const dataset = context?.resolvedDataset ?? resolveDefaultDatasetFromList(available, context?.dataset, project);

  const messages = history.slice(-6).map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  const schemaContext = await buildSchemaContext(project, dataset);

  onStatus?.('Planning operation...');
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
    messages: [...messages, { role: 'user' as const, content: message }],
    schema: DataManagementResponseSchema,
    project,
  });


  // ── Strategy-based execution ─────────────────────────────────────────────
  // Gemini decides the strategy based on the operation's risk level.
  const strategy = plan.executionStrategy || 'PREVIEW_AND_CONFIRM';

  // DIRECT_EXECUTE: no preview, no confirmation. Used for operations that
  // create new objects or are inherently safe (CREATE TABLE, CREATE VIEW, etc.).
  if (strategy === 'DIRECT_EXECUTE') {
    onStatus?.('Executing...');
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
    onStatus?.('Running preview...');
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

    onStatus?.('Estimating cost...');
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
  onStatus?.('Running preview...');
  const previewResult = await executeQuery(plan.previewSql, project);
  const rawCount = Number(previewResult.rows[0]?.[0]);
  const affectedRowCount = Number.isFinite(rawCount) ? Math.round(rawCount) : 0;

  onStatus?.('Estimating cost...');
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
  _message: string,
  context?: { project?: string },
  onStatus?: (status: string) => void
): Promise<CompositionEnvelope[]> {
  const project = context?.project || '';
  const sql = `SELECT job_id, user_email, statement_type, state, creation_time, total_bytes_processed, error_result, referenced_tables FROM \`region-us\`.INFORMATION_SCHEMA.JOBS_BY_PROJECT WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR) ORDER BY creation_time DESC LIMIT 50`;

  onStatus?.('Fetching job history...');
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
      createTime: String(row[iCreateTime] ?? ''),
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
  context?: { project?: string; dataset?: string; lastTable?: string; resolvedDataset?: string; availableDatasets?: string[] },
  onStatus?: (status: string) => void
): Promise<CompositionEnvelope[]> {
  const project = context?.project || '';

  // Parallelize dataset resolution
  const available = context?.availableDatasets ?? await getAvailableDatasets(project);
  const dataset = context?.resolvedDataset ?? resolveDefaultDatasetFromList(available, context?.dataset, project);

  onStatus?.('Classifying check type...');
  const intent = await callGemini({
    systemInstruction: `You classify BigQuery data quality requests. Extract check type and table name. Available check types: PROFILE (general stats), NULLS (null analysis), DUPLICATES (find duplicate rows), FRESHNESS (when was the table last updated). The active project is ${project}, default dataset is ${dataset}, available datasets are: ${available.join(', ')}.`,
    prompt: message,
    schema: DqIntentSchema,
    project,
  });
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
    onStatus?.('Running quality checks...');
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
      base.push(`APPROX_COUNT_DISTINCT(${col.name}) AS \`${col.name}__distinct\``);
    }
    return base;
  });

  sql = `SELECT COUNT(*) AS __total_rows, ${exprs.join(', ')} FROM ${fqTable}`;
  onStatus?.('Running quality checks...');
  onStatus?.('Preparing export...');
  const executed = await executeQuery(sql, project);
  const row = executed.rows[0] ?? [];
  const colMap = Object.fromEntries(executed.columns.map((c, i) => [c, row[i]]));
  const totalRows = Number(colMap['__total_rows'] ?? 0);

  for (const col of columns) {
    const nullCount = Number(colMap[`${col.name}__nulls`] ?? 0);
    const nullRate = totalRows > 0 ? nullCount / totalRows : 0;
    const nullSeverity: DqFinding['severity'] = nullRate > 0.5 ? 'ISSUE' : nullRate > 0.1 ? 'WARNING' : 'INFO';
    findings.push({ column: col.name, metric: 'null_rate', value: parseFloat(nullRate.toFixed(4)), severity: nullSeverity });

    if (intent.checkType === 'PROFILE') {
      const distinct = Number(colMap[`${col.name}__distinct`] ?? 0);
      findings.push({ column: col.name, metric: 'distinct_count', value: distinct, severity: 'INFO' });
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
  context?: { project?: string; dataset?: string; lastTable?: string },
  onStatus?: (status: string) => void
): Promise<CompositionEnvelope[]> {
  const project = context?.project || '';
  let dataset = context?.dataset || '';
  if (dataset && project && dataset.toLowerCase() === project.toLowerCase()) {
    dataset = '';
  }

  onStatus?.('Analyzing search request...');
  const intent = await callGemini({
    systemInstruction: `Classify a BigQuery data loading request. EXPORT_CSV = download as CSV. EXPORT_SHEETS = send to Google Sheets. SCHEDULE = schedule a recurring query. Extract the table name or SQL to use. Project: ${project}, dataset: ${dataset}`,
    prompt: message,
    schema: DataLoadingIntentSchema,
    project,
  });

  if (intent.operationType === 'SCHEDULE') {
    const sql = intent.sql ?? (intent.tableName ? `SELECT * FROM \`${project}.${dataset}.${intent.tableName}\`` : '');
    const result: DataLoadingResult = {
      skill: 'data-loading',
      operationType: 'SCHEDULE_INFO',
      message: 'Scheduling requires the BigQuery Data Transfer API. Copy the SQL below into BigQuery → Scheduled Queries in the Google Cloud Console.',
      sql,
    };
    return [compose('data-loading', result)];
  }

  if (intent.operationType === 'EXPORT_SHEETS') {
    const result: DataLoadingResult = {
      skill: 'data-loading',
      operationType: 'SCHEDULE_INFO',
      message: 'Google Sheets export requires additional OAuth scopes (spreadsheets) that are not yet configured. Use CSV export instead, or connect to Sheets manually from the Google Cloud Console.',
      sql: intent.sql ?? null,
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
  context?: { project?: string; dataset?: string },
  onStatus?: (status: string) => void
): Promise<CompositionEnvelope[]> {
  const project = context?.project || '';
  const available = await getAvailableDatasets(project);

  const intent = await callGemini({
    systemInstruction: `You are a BigQuery discovery assistant. Classify the user's request as either SEARCH (find tables/views matching a term) or COMPARISON (compare two specific tables' schemas). Extract the search term or first table name into 'query'. For COMPARISON, extract the second table into 'secondTable'. The active project is ${project}, available datasets are: ${available.join(', ')}.`,
    prompt: message,
    schema: DiscoveryResponseSchema,
    project,
  });

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
  const resultsMap = new Map<string, DiscoverySearchResult>();

  onStatus?.('Searching across datasets...');
  await Promise.all(
    datasets.map(async (dataset) => {
      try {
        // Match table names
        const tablesSql = [
          `SELECT t.table_name, t.table_type, o.option_value AS description`,
          `FROM \`${project}.${dataset}\`.INFORMATION_SCHEMA.TABLES t`,
          `LEFT JOIN \`${project}.${dataset}\`.INFORMATION_SCHEMA.TABLE_OPTIONS o`,
          `  ON t.table_name = o.table_name AND o.option_name = 'description'`,
          `WHERE LOWER(t.table_name) LIKE '%${term}%'`,
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
          `WHERE LOWER(column_name) LIKE '%${term}%'`,
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
