# System Invariants

Rules that must hold true across all code changes. Violating any of these has caused bugs in the past or would break critical functionality. Before making a change, check it against this list. If a change would violate an invariant, either the invariant needs updating (with justification) or the change needs rethinking.

Last verified: 2026-06-30

---

## Design Philosophy

These principles govern all design decisions. They are not suggestions -- they are requirements.

- **Conversational data tool, not pre-canned experiences**: This app exists to handle whatever data task the user needs, not to funnel users through pre-designed flows. Every prompt is part of an ongoing conversation about data. The system must be able to create whatever experience is needed for the task at hand, dynamically. Never design features that assume a fixed sequence of steps or a predetermined UX pattern. If a new data task doesn't fit existing skill categories, the system should adapt -- not force the task into an ill-fitting template.
- **Every prompt continues the conversation**: Each user prompt exists in the context of whatever output is currently on screen -- a table schema, query results, a quality report, a chart, monitoring data, anything. The system must treat follow-up prompts as continuations, not fresh requests. Re-deriving context that is already established (e.g., re-fetching a schema for a table the user is already looking at) is always a bug.
- **The LLM classifier must know the full conversational state**: The intent classifier receives conversation history and must also receive structured context about what the user is currently viewing (last skill, last table, last dataset). Without this, it cannot make correct routing or decomposition decisions.

---

## Global

- **Model**: Always `gemini-3.5-flash`. Never change to any other model variant. Verify: `grep -rn "gemini-" src/ scripts/`
- **No emojis**: Not in code, comments, UI text, log messages, commit messages, or any output.
- **Backtick-wrap table refs**: All fully qualified BigQuery table references must be wrapped in literal backticks: `` `project.dataset.table` ``. Project names often contain hyphens which break unquoted SQL.
- **Build before deploy**: Run `npm run build` after every source change. This project uses SSR, not static export.
- **Deploy after build**: `git add -A && git commit && git push` then `node scripts/deploy.mjs`. User tests on deployed app, not localhost.

---

## Router (`src/lib/router.ts`)

- **Ambiguous read/write defaults to read**: If a message has both mutating and quality signals, route to data-quality (or query), never to data-management. This is enforced by the `ambiguousReadWrite` flag.
- **Mutating verbs require word-boundary matching**: All entries in `MUTATING_VERBS` are compiled to regex patterns with `\b` boundaries. This prevents table names like `sales_deduped` from false-matching `dedupe`.
- **Ambiguous words need counterbalancing signals**: When adding a word to `MUTATING_VERBS` that could also be a noun/adjective (e.g., "duplicate"), add the full phrase (e.g., "find duplicates", "check for duplicates") to `DATA_QUALITY_SIGNALS` with weight >= 3.
- **Context boosts cap at +3**: Follow-up action patterns (e.g., "clean it" after data-quality) add a max bonus of 3 to the relevant skill score. Do not increase this.
- **No-signal default is query with medium confidence**: When no keyword signals match at all, the router returns `skill: 'query', confidence: 'medium'` so the LLM classifier decides.
- **Filter/equality patterns bypass scoring**: Messages containing `column = 'value'` or explicit `WHERE` clauses go directly to query with high confidence, skipping the scored classification.

---

## Orchestrator (`src/lib/chat-orchestrator.ts`)

- **High-confidence keyword match skips LLM classifier**: When `classifyIntent()` returns `confidence: 'high'`, the orchestrator dispatches directly to that skill without calling Gemini for intent classification. This saves latency and cost.
- **Data-management safety net**: `handleDataManagement()` re-checks the message against the keyword router before proceeding. If the router doesn't independently confirm data-management intent, it redirects to `handleQuery()`. This prevents analytical queries from being treated as mutations.
- **Query auto-retry is one-shot**: When a query fails with a BigQuery syntax/content error, the SQL is sent back to Gemini for repair and retried exactly once. If the retry also fails, the original error is thrown. Do not add more retry loops.
- **Self-review is non-fatal**: The `selfReviewEnvelope()` function catches all errors and returns the original envelope if review fails. Never make self-review failures block response delivery.
- **Schema context loads max 5 tables**: `buildSchemaContext()` fetches column lists for at most 5 tables from the active dataset. This prevents prompt bloat for datasets with many tables.
- **Target table always gets priority in schema context**: When a user references a specific table by name, that table's schema is always fetched first (via the `priorityTable` parameter to `buildSchemaContext`), and the remaining 4 slots are filled with other tables. The LLM prompt must also include an explicit `CRITICAL` instruction naming the target table. Without this, the LLM will hallucinate a table from its training data when the target is not in the first 5 alphabetically.
- **Available datasets are fetched once per turn**: The `getAvailableDatasets()` result is passed through `enrichedContext` to all handlers. Handlers must not re-fetch this list independently.
- **Cross-dataset search on table not found**: When `handleSchema()` gets a 'Not found' error for a table, it searches all other datasets in parallel before failing. This is intentional -- users often reference tables without specifying the dataset.
- **Schema+query multistep is always redundant**: `handleQuery()` calls `buildSchemaContext()` internally. A multistep workflow that fetches schema in step 1 and runs a query in step 2 is structurally redundant and must be collapsed to a single query step. This applies regardless of conversational context.
- **Dataset name vs project name guard**: `fetchSchema()` in `src/lib/skills/schema.ts` checks if the requested dataset name equals the project name and ignores it if so. This prevents the confusing case where the project name is treated as a dataset.
- **callGemini retries transient errors 3 times**: 429, 5xx, and errors containing 'demand', 'temporary', 'limit', 'quota', or 'resource' get exponential backoff with jitter. Auth errors (401/403) are never retried.

---

## Schema Skill (`src/lib/skills/schema.ts`)

- **Three scopes, strict hierarchy**: PROJECT (list datasets) -> DATASET (list tables) -> TABLE (full schema). Each scope has its own fetch function. Never mix them.
- **`fetchSchema()` requires both project AND dataset for table lookups**: Calling `fetchSchema(dataset, table, project)` with a dataset but no table returns dataset-level listing. With both dataset and table, returns full table schema.
- **Schema results are cached in memory**: `schema-cache.ts` provides `getFromCache`/`setInCache` keyed by `(project, dataset, table)`. Cache is per-session (browser tab). Do not add persistent caching without considering staleness.
- **Pagination is mandatory for list operations**: Both `fetchProjectSchema()` and `fetchDatasetSchema()` loop on `nextPageToken`. Removing pagination will break for projects with >1000 datasets or tables.
- **Table constraints query may fail**: INFORMATION_SCHEMA constraint tables may not be accessible. `fetchTableConstraints()` catches all errors and returns empty arrays. This is intentional.

---

## Composer (`src/lib/composer.ts`)

- **Chart type is determined by data shape, not user intent**: The composer selects visualization based on the actual result columns and row count. The LLM's `suggestedVisualization` is a hint, not a mandate.
- **Null/undefined cells must not throw**: Table rendering code must handle null, undefined, and empty string cell values gracefully.
- **Next-action chips are capped at 4 per envelope**: Each composed result generates at most 4 handoff chips. This is a UX constraint. Quality flag suggested actions also count toward this cap.
- **Quality flags are capped at 5 per result**: `analyzeResultQuality()` returns at most 5 flags to avoid overwhelming the UI.

---

## Plan Cache (`src/lib/plan-cache.ts`)

- **Session-scoped, not persistent**: The plan cache lives in module-level memory. It resets on page reload. Do not add persistent storage without considering SQL staleness (schema changes invalidate cached plans).
- **FIFO eviction at 20 entries**: When the cache exceeds 20 entries, the oldest is removed. Do not increase this without measuring memory impact.
- **Parameter substitution is conservative**: `trySubstitute()` only replaces date literals and LIMIT values. It does not rewrite WHERE clauses, table references, or GROUP BY columns. If substitution fails, the cache misses and Gemini generates fresh SQL.
- **Cache key is dataset, not table**: Plans are matched by dataset name. SQL template reuse across different tables in the same dataset is intentional but relies on structural similarity (same operation shape).

---

## Result Quality (`src/lib/result-quality.ts`)

- **No model calls, ever**: This module is pure heuristic analysis. Adding a Gemini call here would defeat the purpose (latency budget is zero).
- **Single-value column check suppresses WHERE columns**: Columns appearing in the SQL's WHERE clause are expected to have a single value (the user filtered on it). Do not flag these.
- **Null rate threshold is 20%**: Columns with >20% null/empty values are flagged. Adjusting this threshold changes sensitivity -- test with real data before modifying.

---

## Self-Review Gating (`src/lib/chat-orchestrator.ts`)

- **Self-review is skipped for simple, high-confidence results**: Schema PROJECT/DATASET scope, KPI_CARD artifacts, and high-confidence keyword-routed queries with <100 rows skip the self-review Gemini call.
- **Self-review always runs for**: data-management confirmations, complex queries (100+ rows), monitoring/quality reports, LLM-classified requests (medium/low confidence). Do not expand skip conditions to cover these.

---

## BigQuery Client (`src/lib/bigquery-client.ts`)

- **OAuth token is fetched per-request via `getAccessToken()`**: Never cache the token at module level. The GIS auth module manages token refresh internally.
- **`handleAuthError()` clears the token, does NOT redirect**: It calls `setAccessToken(null)` and lets the error propagate. The UI layer's `withAuthRetry` handles refresh. Never add `window.location.href` back.
- **`dryRun()` must be called before `executeQuery()` for user-initiated queries**: The dry run checks estimated bytes and returns a cost tier. Tier 3+ requires user confirmation.
- **DML operations use `executeDml()`**, not `executeQuery()`: These are separate functions with different error handling.

---

## Auth Token Refresh (`src/lib/auth-context.tsx`, `src/app/page.tsx`)

- **All orchestrator calls must be wrapped in `withAuthRetry()`**: This wrapper catches expired-token errors, calls `refreshAccessToken()` to get a fresh token via a quick popup, and retries the call once. Without this wrapper, users see "Session Expired" after ~1 hour.
- **`refreshAccessToken` uses a provider WITHOUT `prompt: 'consent'`**: This is intentional. The user already granted consent on initial sign-in. The refresh popup auto-completes almost instantly. Do not add `prompt: 'consent'` to the refresh provider.
- **Auth retry is one-shot**: The `authRetrying` ref prevents infinite retry loops. If the refresh fails, the error propagates to the existing catch block which shows the error banner.

---

## UI Components

- **`SchemaView.tsx` is the largest component (67KB)**: Changes here are high-risk. Test all three schema scopes (project/dataset/table) after any modification.
- **Error boundaries wrap skill-specific views**: Each view component should gracefully handle missing or malformed data from the orchestrator.
- **Google Sans is the only non-code font**: All UI text must use `'Google Sans', sans-serif`. Do not introduce Inter, Roboto, or other font families. Monospace (`var(--font-mono)`) is reserved for code blocks, SQL, and technical identifiers -- not table data cells.
- **Confirmation cards block execution**: `ConfirmationCard` and `CostConfirmCard` must prevent any data-modifying operation until the user explicitly confirms.

---

## Task Framework (`src/lib/tasks/`)

- **Executor host allowlist is mandatory**: `executeApiCall()` validates the resolved URL host against `ALLOWED_API_HOSTS`. Adding a new googleapis.com subdomain requires updating this list. Never remove the validation.
- **Learned plans are per-project, not per-user**: Stored in a top-level `learnedPlans` Firestore collection with a `project` field. The `getLearnedPlans()` query filters by project.
- **Zod v4 record syntax**: Always use `z.record(z.string(), valueSchema)` with two arguments. Single-argument `z.record(valueSchema)` does not compile in Zod v4.
- **Resolver uses createGoogle, not the default google export**: The default export reads `GOOGLE_GENERATIVE_AI_API_KEY` env var. This project uses `NEXT_PUBLIC_GEMINI_API_KEY`, so the resolver must use `createGoogle({ apiKey })`.
- **Learned plan match threshold is 0.7**: Plans with Gemini-scored semantic confidence below 0.7 are not reused. Lowering this risks reusing inappropriate plans.
- **In-memory cache is per-session**: The learned plans cache resets on page reload. Do not persist it.
