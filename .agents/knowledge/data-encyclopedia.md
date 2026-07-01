# Data Encyclopedia

Practical reference for working with BigQuery data in this application. Not a BigQuery tutorial -- a distilled guide to the patterns, edge cases, and gotchas that matter for this specific app.

Consult this before writing SQL generation prompts, modifying skill handlers, or changing how the app interacts with BigQuery APIs.

Last updated: 2026-06-30

---

## BigQuery Behavioral Facts

### API vs INFORMATION_SCHEMA
- **BigQuery REST API** (`bigquery.googleapis.com/v2/projects/`) is faster for listing datasets and tables. Returns metadata like row count, size, creation time directly.
- **INFORMATION_SCHEMA** gives more detail for columns, constraints, jobs, and storage. But it requires a region qualifier for project-level queries: `` `project`.`region-US`.INFORMATION_SCHEMA.TABLES ``.
- The app uses the REST API for schema skill (listing datasets/tables) and INFORMATION_SCHEMA for enriched queries, monitoring, and discovery.
- **Region detection**: `detectBqRegion()` in `bigquery-client.ts` determines the region. If detection fails, default is `US`.

### Partitioned Tables
- Queries without a partition filter scan the entire table. This can be extremely expensive.
- Always include a filter on the partition column (usually a date/timestamp) when generating SQL for partitioned tables.
- The schema skill returns partitioning info: `{ field: 'order_date', type: 'DAY' }`. Use this to inject partition filters.
- Date-partitioned tables: filter with `DATE(partition_column) >= '2024-01-01'`, not `CAST`.  `DATE()` is partition-pruning compatible; `CAST` may not be.
- If the table is partitioned by `_PARTITIONTIME` (ingestion-time), filter with `_PARTITIONTIME >= TIMESTAMP('2024-01-01')`.

### Nested and Repeated Fields
- BigQuery supports `RECORD` (struct) and `REPEATED` (array) types.
- These cannot be displayed in a flat table without transformation.
- To flatten: `UNNEST(array_column)` in a cross join, or `column.nested_field` for struct access.
- `DISTINCT` does not work on STRUCT, ARRAY, or JSON columns. The auto-retry handler knows to exclude these.
- `GROUP BY` does not work on GEOGRAPHY columns. Cast to `ST_ASTEXT()`.

### Table Constraints
- `tableConstraints` (primary keys, foreign keys) is almost always empty in practice.
- BigQuery supports declaring PK/FK but does not enforce them.
- The data quality skill's referential integrity check handles this by falling back to heuristic column matching when no declared FK exists.
- ER diagrams (discovery skill) use both declared constraints AND column name matching to infer relationships.

### Cost Model
- BigQuery charges by bytes scanned (on-demand pricing), not by rows returned.
- `dryRun()` returns `totalBytesProcessed` before execution.
- Cost tiers in this app (from `bigquery-client.ts`):
  - Tier 1: < 100MB -- execute immediately
  - Tier 2: 100MB - 1GB -- execute immediately
  - Tier 3: 1GB - 10GB -- show cost warning, require confirmation
  - Tier 4: 10GB+ -- show strong warning, require confirmation
- Partition pruning dramatically reduces bytes scanned. Always encourage it.

### Query Limits and Timeouts
- Default max results: 1000 rows (set in `bqQuery()` in schema.ts)
- Query execution timeout: controlled by BigQuery (default 6 hours), but the app's fetch timeout is effectively ~30 seconds.
- For very long-running queries, BigQuery returns a job reference. The app does not currently poll for job completion -- it waits synchronously.

---

## SQL Generation Patterns That Work

### Date Filtering (partition-pruning compatible)
```sql
-- Good: DATE() is partition-pruning compatible
WHERE DATE(created_at) >= '2024-01-01'

-- Bad: CAST may prevent partition pruning
WHERE CAST(created_at AS DATE) >= '2024-01-01'

-- For ingestion-time partitioning:
WHERE _PARTITIONTIME >= TIMESTAMP('2024-01-01')
```

### Time Series Aggregation
```sql
-- Monthly aggregation with proper ordering
SELECT
  DATE_TRUNC(order_date, MONTH) AS month,
  COUNT(*) AS order_count,
  SUM(revenue) AS total_revenue
FROM `project.dataset.orders`
GROUP BY month
ORDER BY month
```
- Always `ORDER BY` the time column ascending for time series.
- Always alias the truncated column for readability.
- Suggested visualization: `LINE_CHART` for time series.

### Top-N Queries
```sql
SELECT category, COUNT(*) AS order_count
FROM `project.dataset.orders`
GROUP BY category
ORDER BY order_count DESC
LIMIT 20
```
- Default LIMIT is 20 unless user specifies otherwise.
- Suggested visualization: `COLUMN_CHART` for 5-15 categories, `BAR_CHART` for horizontal layout.

### Deduplication
```sql
-- Find duplicate groups
SELECT col1, col2, COUNT(*) AS dup_count
FROM `project.dataset.table`
GROUP BY col1, col2
HAVING COUNT(*) > 1
ORDER BY dup_count DESC

-- Remove duplicates (keep one per group)
CREATE OR REPLACE TABLE `project.dataset.table` AS
SELECT * EXCEPT(row_num) FROM (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY col1, col2
    ORDER BY updated_at DESC  -- keep most recent
  ) AS row_num
  FROM `project.dataset.table`
)
WHERE row_num = 1
```
- The PARTITION BY columns should be the dedup key (columns that define what "duplicate" means).
- The ORDER BY in the window function determines which row to keep (usually most recent by some timestamp).
- The data-management handler generates both preview SQL (shows duplicates) and execution SQL (removes them).

### Single Aggregate (KPI)
```sql
SELECT COUNT(*) AS total_orders
FROM `project.dataset.orders`
```
- Single-value results should use `KPI_CARD` visualization.
- The composer detects single-row, single-column results and formats them as KPI cards.

### Null Analysis
```sql
SELECT
  COUNTIF(column_name IS NULL) AS null_count,
  COUNT(*) AS total_count,
  ROUND(COUNTIF(column_name IS NULL) / COUNT(*) * 100, 2) AS null_pct
FROM `project.dataset.table`
```

### Cost Estimation (Dry Run)
```sql
-- The app calls dryRun() with the generated SQL
-- dryRun() sets dryRun: true in the BigQuery API request
-- Returns totalBytesProcessed without executing
```

---

## Response Patterns That Work

### Schema Responses
- Lead with the most actionable structural fact:
  - If partitioned: "Partitioned by order_date (DAY) -- filter on this to keep queries cheap"
  - If clustered: "Clustered by customer_id -- queries filtering on this will be faster"
  - If neither: lead with row count and a notable column pattern
- List columns in a table, not paragraph text
- Include data types -- users need to know if a column is STRING vs INT64

### Query Results
- Show the data first, then explain
- Users scan the table/chart before reading prose
- The `resultSummary` field from the LLM becomes the headline
- Notable findings (from `notableFindings`) appear as insight text below the chart

### Error States
- Say what failed AND what to try next
- Never just "An error occurred"
- For BigQuery errors: include the specific error message from BigQuery
- For auth errors: tell the user to sign in again
- For quota errors: tell the user to wait or try a smaller query

### Confirmation Cards
- Show exactly what will happen: "This will delete 847 rows where status = 'cancelled'"
- Show the SQL that will execute
- Show a preview of affected data when possible
- Make the confirm/cancel buttons prominent

---

## Common User Intent Patterns

### Ambiguous Phrases

| Phrase | Could Mean | This App Does |
|--------|-----------|---------------|
| "What's in [X]?" | Dataset contents OR table contents | Check if X is a known dataset first. If yes, list tables. If no, show table schema/data. |
| "Show me [X]" | Query/display data | Routes to query skill, not schema |
| "Fix [X]" | Fix data (DML) OR fix the query | Routes to data-management due to mutating verb. Could be wrong -- DM safety net will catch misroutes. |
| "Show me the duplicates" | Find duplicates (read) | Routes to data-quality. The word "show" indicates read intent. |
| "Duplicate [X]" | Copy the table | Routes to data-management. "Duplicate" as a verb means copy. |
| "Clean the data" | Remove bad rows/values | Routes to data-management. "Clean" is a mutating verb. |
| "How clean is the data?" | Profile/quality check | Routes to data-quality. No mutating verb, "quality" signal matches. |
| "Profile [X]" | Data profiling (nulls, distributions) | Routes to data-quality. "Profile" is a quality signal. |
| "Compare [X] and [Y]" | Schema diff | Routes to discovery. "Compare" is a discovery signal. |

### Natural Drill-Down Patterns
Users typically follow this flow:
1. "What datasets do I have?" (schema, PROJECT)
2. "What's in [dataset]?" (schema, DATASET)
3. "Describe [table]" (schema, TABLE)
4. "Show me the top 10 rows" (query)
5. "How many nulls are there?" (data-quality)
6. "Export that to Sheets" (data-loading)

The app supports this flow via:
- Handoff chips that pre-seed the next skill's context
- Context boosts in the router for natural follow-ups
- Reference resolution for "that table", "those rows", "it"

### Reference Resolution
The router's `resolveReferences()` handles:
- "that table" / "this table" -> replaces with last table name from context
- "from it" / "in it" / "about it" -> replaces "it" only after prepositions
- Bare "it" is NOT replaced (too aggressive -- "make it faster" shouldn't become "make orders faster")

---

## BigQuery INFORMATION_SCHEMA Reference

Quick reference for the INFORMATION_SCHEMA views used in this app:

### Tables
```sql
SELECT * FROM `project.dataset`.INFORMATION_SCHEMA.TABLES
-- Returns: table_catalog, table_schema, table_name, table_type, creation_time, ...
```

### Columns
```sql
SELECT * FROM `project.dataset`.INFORMATION_SCHEMA.COLUMNS
-- Returns: table_name, column_name, ordinal_position, data_type, is_nullable, ...
```

### Table Storage
```sql
SELECT * FROM `project.dataset`.INFORMATION_SCHEMA.TABLE_STORAGE
-- Returns: table_name, total_rows, total_logical_bytes, active_logical_bytes, ...
```

### Jobs (project-level, requires region)
```sql
SELECT * FROM `project`.`region-US`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
-- Returns: job_id, user_email, query, statement_type, total_bytes_processed, ...
-- Used by: monitoring (jobs, cost analysis) and discovery (lineage)
```

### Constraints
```sql
SELECT * FROM `project.dataset`.INFORMATION_SCHEMA.TABLE_CONSTRAINTS
SELECT * FROM `project.dataset`.INFORMATION_SCHEMA.KEY_COLUMN_USAGE
SELECT * FROM `project.dataset`.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE
-- Used by: schema skill for PK/FK, discovery for ER diagrams
```

### Region Requirement
- Project-level INFORMATION_SCHEMA queries (JOBS, TABLE_STORAGE across datasets) require a region qualifier.
- Format: `` `project`.`region-US`.INFORMATION_SCHEMA.VIEW ``
- The app detects region via `detectBqRegion()` which checks the first dataset's location.

---

## BigQuery API Patterns

### Authentication
- The app uses Google Identity Services (GIS) for OAuth2 in the browser.
- Access tokens are managed by `gis-auth.ts` via `getAccessToken()`.
- Tokens expire. The auth context must handle refresh gracefully (see ops-ledger entry on infinite refresh loop).
- For the test harness, tokens are managed by `scripts/token-manager.mjs`.

### Error Categories
1. **Auth errors** (401/403): Token expired or insufficient permissions. Tell user to sign in again.
2. **Not found** (404): Dataset, table, or column doesn't exist. For tables, trigger cross-dataset search.
3. **Query errors** (400): Syntax error, unsupported operation, invalid column. Trigger auto-retry with LLM fix.
4. **Quota/rate limit** (429): Too many requests. Exponential backoff with jitter (handled by `callGemini()`).
5. **Server errors** (5xx): Transient. Retry with backoff.

### Pagination
- BigQuery list APIs return `nextPageToken` when there are more results.
- Always loop on `nextPageToken` -- never assume a single page is complete.
- Default `maxResults` per page: 1000 for datasets and tables.
