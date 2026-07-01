# System Invariants

Rules that must hold true across all code changes. Violating any of these has caused bugs in the past or would break critical functionality. Before making a change, check it against this list. If a change would violate an invariant, either the invariant needs updating (with justification) or the change needs rethinking.

Last verified: 2026-06-30

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
- **Available datasets are fetched once per turn**: The `getAvailableDatasets()` result is passed through `enrichedContext` to all handlers. Handlers must not re-fetch this list independently.
- **Cross-dataset search on table not found**: When `handleSchema()` gets a 'Not found' error for a table, it searches all other datasets in parallel before failing. This is intentional -- users often reference tables without specifying the dataset.
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
- **Next-action chips are capped at 4 per envelope**: Each composed result generates at most 4 handoff chips. This is a UX constraint.

---

## BigQuery Client (`src/lib/bigquery-client.ts`)

- **OAuth token is fetched per-request via `getAccessToken()`**: Never cache the token at module level. The GIS auth module manages token refresh internally.
- **`dryRun()` must be called before `executeQuery()` for user-initiated queries**: The dry run checks estimated bytes and returns a cost tier. Tier 3+ requires user confirmation.
- **DML operations use `executeDml()`**, not `executeQuery()`: These are separate functions with different error handling.

---

## UI Components

- **`SchemaView.tsx` is the largest component (67KB)**: Changes here are high-risk. Test all three schema scopes (project/dataset/table) after any modification.
- **Error boundaries wrap skill-specific views**: Each view component should gracefully handle missing or malformed data from the orchestrator.
- **Confirmation cards block execution**: `ConfirmationCard` and `CostConfirmCard` must prevent any data-modifying operation until the user explicitly confirms.
