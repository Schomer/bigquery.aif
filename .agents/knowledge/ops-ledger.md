# Operations Ledger

A reverse-chronological log of changes, fixes, and lessons learned. Read this before making code changes to avoid repeating past mistakes.

## How to use this file
- **Before coding**: Scan recent entries for relevant context
- **After coding**: Add a new entry for any non-trivial change
- **When debugging**: Search for similar symptoms in past entries

## How to write an entry
Every entry should answer: What changed? What worked? What broke? Why? What's the generalizable lesson?

---

### 2026-07-01: Plan caching, conditional self-review, and result quality flags
**Scope**: `src/lib/plan-cache.ts` [NEW], `src/lib/result-quality.ts` [NEW], `src/lib/chat-orchestrator.ts`, `src/lib/composer.ts`, `src/lib/types.ts`, `src/components/ArtifactCard.tsx`
**What changed**: Three latency and quality improvements:
1. **Plan cache**: Session-scoped cache of recent query plans. When the user iterates on the same question with different parameters (dates, filters, LIMIT), the cached SQL template is reused with parameter substitution, skipping the Gemini SQL generation call entirely. FIFO eviction at 20 entries.
2. **Conditional self-review**: The self-review Gemini call is now skipped for: (a) schema results at PROJECT/DATASET scope, (b) KPI_CARD results, (c) high-confidence keyword-routed queries with <100 rows. Saves 1-3s on ~40-60% of requests.
3. **Result quality flags**: After query execution, `analyzeResultQuality()` scans result rows for null rates >20%, categorical near-duplicates, zero-row results, and single-value columns. Flags appear as dismissible banners in the UI with context-aware next-action chips.
**Design decision**: Single-value column detection suppresses columns that appear in WHERE clauses, since a single value is expected when the user explicitly filtered on that column.
**Rule**: When adding new heuristic flags, cap total flags at 5 per result and next-action chips at 4 per envelope (existing invariant). Plan cache entries are keyed by dataset, not table -- SQL template substitution handles the rest.

### 2026-07-01: Freshness monitoring handler treating project name as dataset name
**Scope**: `src/lib/chat-orchestrator.ts` (handleMonitoring FRESHNESS block), `src/lib/types.ts`, `src/lib/composer.ts`, `src/components/FreshnessView.tsx`
**What broke**: "check data freshness" returned "No tables found in the 'malloy-data' dataset" -- but malloy-data is a project, not a dataset.
**Root cause**: `handleMonitoring()`'s context type only accepted `project`, `uid`, and `handoffContext`. The FRESHNESS handler's dataset resolution (`const dataset = (hc?.dataset as string) || ''`) only checked handoff context, ignoring `context.resolvedDataset` and `context.dataset` from the enriched context. When dataset was empty, it set `result.dataset = dataset || project`, making the project name appear as a dataset name in the UI.
**Fix**: (1) Expanded `handleMonitoring` context type to include `resolvedDataset`, `dataset`, `availableDatasets`. (2) Changed FRESHNESS dataset resolution to fall through: `hc.dataset -> context.resolvedDataset -> context.dataset -> extractDatasetFromMessage()`. (3) Made `FreshnessResult.dataset` nullable (null = project scope). (4) Updated composer and FreshnessView to distinguish project-scope vs dataset-scope labeling.
**Rule**: Every skill handler that needs dataset context MUST accept and use `resolvedDataset` from the enriched context, not just handoff context. When a result can be at project scope, the `dataset` field should be null/empty, with a separate `project` field for labeling.

### 2026-06-30: Data lineage visualization implementation
**Scope**: `src/components/LineageDagView.tsx`, `src/lib/chat-orchestrator.ts` -- `handleDiscovery()`
**What worked**: Built a DAG visualization using JOBS_BY_PROJECT INFORMATION_SCHEMA to extract source->destination table relationships from job history.
**Rule**: Lineage data comes from `INFORMATION_SCHEMA.JOBS_BY_PROJECT` -- filter for `statement_type` in ('SELECT', 'CREATE_TABLE_AS_SELECT', 'INSERT', 'MERGE') and extract referenced/destination tables.

### 2026-06-30: Dataset table listing returning all datasets instead of tables in dataset
**Scope**: `src/lib/chat-orchestrator.ts` -- `handleSchema()` / `extractSchemaIdentifiers()`
**What worked**: The schema handler needed to check if the extracted name matches a known dataset name before defaulting to TABLE scope. Added dataset name validation against available datasets list.
**What broke on first attempt**: Changed the conditional but didn't account for unqualified names (no project prefix). Entity resolution in the router doesn't distinguish dataset names from table names when no qualifier is present.
**Root cause**: `extractSchemaIdentifiers()` was using `TABLE_DESCRIBE_SIGNALS` matches without checking if the extracted name was actually a dataset. When user says "what's in analytics", "analytics" is a dataset, not a table.
**Rule**: Always check extracted identifiers against the `availableDatasets` list before deciding scope. A name that matches a known dataset should route to DATASET scope, not TABLE scope.

### 2026-06-30: Infinite refresh loop after session expiration
**Scope**: `src/app/layout.tsx`, `src/app/page.tsx`, authentication middleware
**What worked**: Added proper session state guards to prevent re-render cycles when auth token expires.
**What broke on first attempt**: The auth context was triggering a re-render which triggered auth check which triggered re-render.
**Root cause**: The auth state change handler was calling setState unconditionally, causing a render loop when the token was expired.
**Rule**: Auth state handlers must be idempotent -- only call setState when the new state actually differs from current state. Use a ref to track the previous auth state and compare before updating.

### 2026-06-26: Table duplication task routing
**Scope**: `src/lib/router.ts` -- `MUTATING_VERBS`
**What worked**: Added 'duplicate', 'copy', 'replicate', 'make a copy' to mutating verbs list.
**What broke on first attempt**: 'duplicate' as a noun ("find duplicates") was now routing to data-management instead of data-quality.
**Root cause**: The word 'duplicate' is ambiguous -- as a verb it means 'copy this table', as a noun/adjective it means 'find duplicate rows'.
**Rule**: When adding ambiguous words to MUTATING_VERBS, also add the full-phrase counterpart to DATA_QUALITY_SIGNALS with high weight (>=3). The scoring system resolves conflicts by checking if a multi-word quality phrase is present alongside the verb match.

### 2026-06-24: Dataset listing performance issues
**Scope**: `src/lib/skills/schema.ts` -- `fetchProjectSchema()`
**What worked**: Added pagination support and parallel table count fetching.
**Root cause**: Was fetching all datasets sequentially without pagination. Large projects with many datasets would timeout.
**Rule**: All BigQuery list operations must support pagination (check for `nextPageToken`). Use `Promise.all()` for independent per-dataset fetches.

### 2026-06-24: App flashing on reload
**Scope**: `src/app/page.tsx`, `src/app/globals.css`
**What worked**: Ensured initial render state matches server-side render to prevent hydration flash.
**Root cause**: Client-side state initialization differed from server-side, causing a visible flash during hydration.
**Rule**: Initial state for any component that renders on first paint must produce the same HTML on server and client. Use CSS to hide content until hydrated if necessary, not conditional rendering.
