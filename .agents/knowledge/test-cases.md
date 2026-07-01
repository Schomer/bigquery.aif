# Canonical Test Cases

Known-good scenarios that must produce correct results. Before deploying any change, verify that these cases still work. Each test specifies the expected routing, expected behavior, and what a failure looks like.

Last verified: 2026-06-30

---

## Routing Tests

These test that messages route to the correct skill.

### R1: Dataset listing routes to schema
- **Input**: "What datasets are in this project?"
- **Expected skill**: schema
- **Expected scope**: PROJECT
- **Expected output**: A list of dataset names with table counts
- **Failure looks like**: Returns a query result or routes to discovery

### R2: Table listing within a dataset routes to schema
- **Input**: "What tables are in the analytics dataset?"
- **Expected skill**: schema
- **Expected scope**: DATASET
- **Expected dataset**: analytics
- **Expected output**: A list of table names within the analytics dataset
- **Failure looks like**: Lists all datasets instead of tables, or routes to query

### R3: Table description routes to schema
- **Input**: "Describe the orders table"
- **Expected skill**: schema
- **Expected scope**: TABLE
- **Expected output**: Full schema with columns, types, partitioning info
- **Failure looks like**: Runs a SELECT query on the table instead of showing metadata

### R4: Analytical question routes to query
- **Input**: "Show me the top 10 orders by revenue"
- **Expected skill**: query
- **Expected output**: SQL with ORDER BY and LIMIT 10, executed and displayed
- **Failure looks like**: Routes to schema or data-management

### R5: "Show duplicates" routes to data-quality, not data-management
- **Input**: "Show me the duplicates in the orders table"
- **Expected skill**: data-quality
- **Expected check type**: DUPLICATES
- **Failure looks like**: Routes to data-management (would try to DELETE)

### R6: "Remove duplicates" routes to data-management
- **Input**: "Remove the duplicates from the orders table"
- **Expected skill**: data-management
- **Expected operation**: DEDUPE
- **Failure looks like**: Routes to data-quality (would just SHOW duplicates)

### R7: Ambiguous read/write defaults to read
- **Input**: "Are there any duplicates in orders?"
- **Expected skill**: data-quality
- **Expected output**: Shows duplicate analysis, does NOT modify data
- **Failure looks like**: Routes to data-management

### R8: Filter with equality pattern routes to query
- **Input**: "Show me more about `status` = 'shipped'"
- **Expected skill**: query
- **Expected output**: SQL with WHERE clause
- **Failure looks like**: Routes to schema (because of "show me more about")

### R9: Follow-up action after data-quality routes to data-management
- **Input**: "Clean those up" (after a data-quality check)
- **Expected skill**: data-management (via context boost)
- **Failure looks like**: Routes to query or stays in data-quality

### R10: Export after query routes to data-loading
- **Input**: "Export that to Google Sheets" (after a query)
- **Expected skill**: data-loading
- **Expected operation**: EXPORT_SHEETS
- **Failure looks like**: Routes to query or generates new SQL

---

## Schema Tests

These test the schema skill's behavior.

### S1: Project scope lists datasets, not tables
- **Input**: "List my datasets"
- **Expected**: Returns SchemaResult with scope=PROJECT, columns containing dataset names
- **Failure looks like**: Returns table names or throws an error

### S2: Qualified dataset.table reference resolves correctly
- **Input**: "Describe analytics.orders"
- **Expected**: dataset=analytics, table=orders, scope=TABLE
- **Failure looks like**: Treats "analytics.orders" as a single table name in the wrong dataset

### S3: Unknown table triggers cross-dataset search
- **Input**: "Describe the orders table" (when orders is not in the context dataset)
- **Expected**: Searches all datasets, finds the table in the correct one
- **Failure looks like**: Returns "Not found" without searching other datasets

### S4: Dataset name matching is case-insensitive
- **Input**: "What's in ANALYTICS?"
- **Expected**: Matches the `analytics` dataset regardless of case
- **Failure looks like**: Treats ANALYTICS as a table name

---

## Query Tests

### Q1: Time series generates appropriate chart
- **Input**: "Show me orders per month for the last year"
- **Expected**: SQL with DATE_TRUNC and GROUP BY, visualization=LINE_CHART
- **Failure looks like**: Returns TABLE visualization for time-series data

### Q2: Single aggregate generates KPI card
- **Input**: "How many orders are there?"
- **Expected**: SQL with COUNT(*), visualization=KPI_CARD
- **Failure looks like**: Returns a full table with one row

### Q3: SQL error triggers auto-retry
- **Input**: Any query that would fail due to GEOGRAPHY/STRUCT columns
- **Expected**: First query fails, Gemini repairs SQL (e.g., excludes problematic columns), retry succeeds
- **Failure looks like**: Error thrown to user without retry attempt

### Q4: Expensive query triggers cost confirmation
- **Input**: Any query against a very large table without partition filter
- **Expected**: Dry run detects high cost tier, returns confirmation card
- **Failure looks like**: Query executes immediately without cost warning

---

## Data Management Tests

### DM1: Destructive operation requires confirmation
- **Input**: "Delete all rows where status = 'cancelled'"
- **Expected**: Preview showing affected rows, confirmation card, execution only after confirm
- **Failure looks like**: Rows deleted without preview/confirmation

### DM2: Misrouted analytical query gets redirected
- **Input**: "Analyze sales trends over time" (if LLM classifier misroutes to data-management)
- **Expected**: Safety net detects mismatch, redirects to query handler
- **Failure looks like**: Tries to generate DML for an analytical question

---

## Integration Tests

### I1: End-to-end conversation flow
1. "What datasets do I have?" -> schema, PROJECT scope
2. "What's in [dataset]?" -> schema, DATASET scope
3. "Describe [table]" -> schema, TABLE scope
4. "Show me the top 10 rows" -> query
5. "Export that to sheets" -> data-loading

### I2: Data quality to data management handoff
1. "Check for duplicates in orders" -> data-quality, DUPLICATES
2. "Remove those" -> data-management, DEDUPE (via context boost)
