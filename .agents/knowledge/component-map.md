# Component Boundary Map

A guide to the codebase structure, key files, their responsibilities, and where to find things. Consult this before making changes to understand what you're touching and what might be affected.

Last updated: 2026-06-30

---

## Architecture Overview

```
User Message
    |
    v
API Route (src/app/api/chat/route.ts)
    |
    v
Router (src/lib/router.ts)
  - Keyword scoring: classifyIntent()
  - Reference resolution: resolveReferences()
    |
    v
Orchestrator (src/lib/chat-orchestrator.ts)
  - LLM classifier (medium/low confidence fallback)
  - Skill dispatch (switch on skill name)
  - Self-review pass
    |
    v
Skill Handlers (inline in chat-orchestrator.ts)
  - handleSchema, handleQuery, handleDataManagement,
    handleDataQuality, handleMonitoring, handleDiscovery,
    handleDataLoading
    |
    v
Composer (src/lib/composer.ts)
  - compose(skill, result) -> CompositionEnvelope
    |
    v
UI Components (src/components/)
  - Render envelopes as cards/charts/tables
```

---

## Core Files

### `src/lib/router.ts` (456 lines)
**Responsibility**: Intent classification via weighted keyword scoring.
- Lines 14-231: Signal lists (MUTATING_VERBS, DATA_QUALITY_SIGNALS, SCHEMA_SIGNALS, etc.)
- Lines 233-253: `scoreSignals()` -- the scoring engine
- Lines 255-302: `getContextBoosts()` -- follow-up action pattern matching
- Lines 316-433: `classifyIntent()` -- main classification function
- Lines 440-455: `resolveReferences()` -- pronoun resolution

**Key invariant**: Mutating verbs get checked first (line 328). High-confidence mutating verb match returns immediately unless a strong quality signal is also present.

---

### `src/lib/chat-orchestrator.ts` (3384 lines)
**Responsibility**: Everything else. This is the monolith.

#### Infrastructure (lines 1-370)
- Lines 27-53: `loadSkillDoc()` -- loads skill .md files from /public/skills/
- Lines 80-187: `callGemini()` -- Gemini API client with retry logic
- Lines 189-327: Response schemas for all skills (JSON Schema for structured output)
- Lines 329-369: Dataset resolution helpers

#### Orchestration (lines 370-584)
- Lines 402-583: `ChatOrchestrator.processMessage()` -- main entry point
  - Lines 404-410: Confirmation handling
  - Lines 414-416: Reference resolution
  - Lines 420-517: Intent classification (keyword first, LLM fallback)
  - Lines 536-560: Skill dispatch switch
  - Lines 562-580: Self-review pass

#### Schema Handler (lines 615-1018)
- Lines 618-663: Keyword-based scope classifier signals
- Lines 665-734: `tryFastEnrichment()` -- direct SQL for common patterns
- Lines 740-838: `extractSchemaIdentifiers()` -- regex-based entity extraction
- Lines 841-1018: `handleSchema()` -- main schema handler

#### Self-Review (lines 1019-1197)
- Lines 1024-1064: `buildReviewSnapshot()` -- prepares data for review
- Lines 1066-1197: `selfReviewEnvelope()` -- LLM review pass

#### Query Handler (lines ~1242-1441)
- `handleQuery()` -- plan cache check, SQL generation, dry-run, execution, auto-retry, result quality analysis

#### Data Management Handler (lines 1375-1600)
- Lines 1377-1562: `handleDataManagement()` -- plan generation, safety net, confirmation flow
- Lines 1564-1600: `executeConfirmedOperation()` -- runs confirmed DML

#### Monitoring Handler (lines 1598-2299)
- 8 sub-types: JOBS, STORAGE, SLOTS, QUERY_PLAN, ALERT, STORAGE_BREAKDOWN, ACCESS_PATTERNS, COST_ANALYSIS, FRESHNESS

#### Data Quality Handler (lines 2303-2780)
- 8 check types: PROFILE, NULLS, DUPLICATES, FRESHNESS, COMPLETENESS, RANGE_VALIDATION, REFERENTIAL_INTEGRITY, SCHEMA_DRIFT

#### Data Loading Handler (lines 2784-3005)
- 5 operation types: EXPORT_CSV, EXPORT_SHEETS, SCHEDULE, SAVED_QUERY, SHARE

#### Discovery Handler (lines 3009-3384)
- 4 types: SEARCH, COMPARISON, LINEAGE, ER_DIAGRAM

---

### `src/lib/composer.ts` (~865 lines)
**Responsibility**: Transforms skill results into CompositionEnvelopes.
- Each skill has a dedicated `compose[Skill]` function
- Determines headline text and tone
- Selects artifact type
- Generates next-action handoff chips (including from quality flag suggested actions)
- Formats provenance metadata
- Accepts optional `qualityFlags` parameter, attaches to envelope for query results

---

### `src/lib/plan-cache.ts` (174 lines)
**Responsibility**: Session-scoped cache of recent query plans.
- `findReusablePlan(message, dataset)` -- checks cache for reusable SQL template
- `cachePlan(skill, dataset, sql, ...)` -- stores a new plan entry
- `clearPlanCache()` -- clears on session reset
- FIFO eviction at 20 entries
- Parameter substitution handles date literals, LIMIT values

---

### `src/lib/result-quality.ts` (~200 lines)
**Responsibility**: Heuristic data quality checks on query result sets. No model calls.
- `analyzeResultQuality(columns, rows, sql)` -- main entry point
- Checks: null rates >20%, categorical near-duplicates, zero-row results, single-value columns
- Single-value check suppresses columns that appear in WHERE clauses
- Returns `QualityFlag[]` (capped at 5)

---

### `src/lib/skills/schema.ts` (305 lines)
**Responsibility**: Direct BigQuery REST API calls for metadata.
- The ONLY skill extracted into its own file
- `fetchSchema()` -- public entry point, delegates to scope-specific functions
- `fetchProjectSchema()` -- lists datasets with table counts
- `fetchDatasetSchema()` -- lists tables in a dataset
- `fetchTableSchema()` -- full table metadata
- `fetchTableConstraints()` -- PK/FK via INFORMATION_SCHEMA

---

### `src/lib/bigquery-client.ts` (~14KB)
**Responsibility**: BigQuery REST API wrapper.
- `executeQuery()` -- runs read-only queries
- `dryRun()` -- cost estimation
- `executeDml()` -- runs DML statements
- `exportToSheets()` -- Google Sheets export
- `createScheduledQuery()` -- Data Transfer API
- `detectBqRegion()` -- region detection for INFORMATION_SCHEMA

---

### `src/lib/types.ts` (502 lines)
**Responsibility**: All TypeScript interfaces.
- `SkillName`, `CompositionEnvelope`, `SchemaResult`, `QueryResult`
- `DataManagementResult`, `DataQualityResult`, `MonitoringResult`
- `DiscoveryResult`, `DataLoadingResult`, `AlertResult`

---

## UI Components (`src/components/`)

| Component | Size | Renders |
|-----------|------|--------|
| SchemaView.tsx | 67KB | Dataset/table listings, full table schemas |
| PromptsLibrary.tsx | 33KB | Saved prompts and quick actions |
| MultistepView.tsx | 15KB | Multi-step workflow cards |
| ErDiagramView.tsx | 14KB | Entity-relationship diagrams |
| LineageDagView.tsx | 14KB | Data lineage DAG visualization |
| ArtifactCard.tsx | 15KB | Generic artifact rendering wrapper |
| CostAnalysisView.tsx | 15KB | Cost breakdown visualizations |
| AccessPatternView.tsx | 15KB | Table access pattern analysis |
| StorageBreakdownView.tsx | 15KB | Storage treemaps |
| SettingsPage.tsx | 15KB | App settings UI |
| DataLoadingView.tsx | 9KB | Export/schedule confirmations |
| DiscoveryView.tsx | 9KB | Search results |
| DataQualityView.tsx | 8KB | Quality check results |
| EmptyCanvasAnimation.tsx | 8KB | Welcome screen animation |
| AnimatedCrystalBall.tsx | 8KB | Loading animation |
| DataTable.tsx | 6KB | Generic data table renderer |
| GlobalSearch.tsx | 7KB | Command palette / global search |
| MonitoringView.tsx | 6KB | Job/resource monitoring |
| FreshnessView.tsx | 6KB | Table freshness checks |
| ConfirmationCard.tsx | 6KB | Destructive op confirmation UI |
| CrystalBallSpinner.tsx | 6KB | Loading spinner |
| ChartView.tsx | 3KB | Chart rendering dispatcher |

---

## Skill Documentation

### Build-time skill definitions (`skills/`)
- `schema.md` -- Schema skill prompt (67 lines)
- `query.md` -- Query skill prompt (106 lines)  
- `data-management.md` -- Data management skill prompt (106 lines)

### Runtime skill docs (`public/skills/`)
- Loaded by `loadSkillDoc()` in orchestrator
- Cached in memory (`_skillDocCache`)
- 8 files: one per skill + `intent-routing.md`

### Design specs (`docs from claude/`)
- 15 files, ~145KB total
- Aspirational specifications, not implementation docs
- See `docs from claude/README.md` for index

---

## Test Infrastructure

- `scripts/test-loop.mjs` -- End-to-end test harness (sends messages to API, evaluates responses)
- `scripts/task-catalog.mjs` -- Test scenario definitions
- `scripts/token-manager.mjs` -- OAuth token management for tests
- `scripts/generate-report.mjs` -- Markdown report generator
- No unit tests exist. No jest/vitest configuration.
