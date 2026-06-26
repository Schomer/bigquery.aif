# Intent Routing Reference

Task-to-skill mapping for the BigQuery AI assistant. Use this to determine which skill handles a user's request.

## Skill Routing Table

| Skill | Handles | Example phrases |
|---|---|---|
| schema | Viewing, listing, or describing datasets, tables, columns, schema structure. Browsing metadata. | "list my datasets", "show me the orders table", "describe X", "what columns does X have", "tell me more about X", "explore X", "what tables are in Y" |
| query | Running SELECT queries, aggregations, analytics, joining/combining data, pivot/unpivot, filtering, statistical summaries, percentiles, cohort analysis, funnel analysis, ranking, running totals, YoY comparisons, regex extraction, date parsing, derived fields. Also ML/AI functions: forecasting, anomaly detection, sentiment analysis, classification, clustering via AI.*/ML.* SQL functions. | "how many rows", "top 10 customers", "sales by region", "average order value", "join orders and customers", "group by category", "forecast next month's sales", "detect anomalies in revenue", "classify these reviews" |
| data-management | Modifying tables via DML/DDL. Requires an explicit mutating verb as a command. Includes: deduplicate, delete rows, update values, fill nulls, merge/upsert, create table/view, alter/add/drop/rename columns, partition, cluster, copy/clone/duplicate table, standardize values, type casting. | "dedupe the events table", "delete rows where X", "create a view", "add a column", "rename column X to Y", "update prices", "duplicate this table", "make a copy of orders", "copy this table", "merge these two tables", "upsert into X" |
| data-quality | Profiling tables, checking data health. Includes: find duplicates, null analysis, validate data types, referential integrity, data freshness, value range validation, completeness audit, schema drift detection. | "profile the users table", "check for nulls", "are there duplicates", "how fresh is this data", "validate completeness", "check referential integrity", "find out-of-range values", "has the schema changed" |
| discovery | Searching for tables/views across datasets, comparing schemas of two tables, viewing lineage. | "search for tables with customer data", "find tables matching X", "compare orders and orders_v2", "where does this come from" |
| monitoring | Checking query/job history, costs, performance, failures, storage, slot usage, query optimization. | "what failed", "expensive queries", "job status", "storage analysis", "who ran this", "show recent jobs", "slot usage", "how much storage", "query plan" |
| data-loading | Exporting data, downloading CSVs, scheduling queries, loading data, sharing results, exporting to Sheets. | "export as CSV", "download results", "schedule this query", "send to Sheets" |

## Critical Routing Rules

1. **Entity names are not action verbs.** A table NAMED "sales_deduped", "cleaned_orders", or "merged_data" does NOT mean the user wants to dedupe, clean, or merge. Classify based on the user's ACTION, not the object's name.

2. **Ambiguous read/write defaults to read.** "Show me the duplicates" -> data-quality. "Remove the duplicates" -> data-management. The distinguishing signal is an explicit mutating verb commanding a change. Its absence means the user wants to look, not modify.

3. **"Tell me more about X" is always schema.** Regardless of what X is named. The user wants to see/learn about an entity.

4. **Pivot, filter, string ops, and regex are query, not data-management.** These reshape or extract data without modifying the source table.

5. **ML/analytics tasks route to query.** Forecasting, anomaly detection, sentiment analysis, and classification use `AI.*`/`ML.*` SQL functions within a SELECT query.

## Disambiguation Guide

These prompts are commonly confused. Use this as a reference:

| User says | Correct skill | Why |
|---|---|---|
| "duplicate this table" | data-management | "Duplicate" is a verb meaning copy/clone the table |
| "find duplicates" | data-quality | "Find" is the verb; "duplicates" (noun) are what to look for |
| "show me duplicates in orders" | data-quality | Read-only inspection of duplicate rows |
| "remove the duplicates" | data-management | "Remove" is an explicit mutating verb |
| "make a copy of this table" | data-management | "Make a copy" is a creation/mutation action |
| "clean this data" | data-management | "Clean" as a verb implies modifying the data |
| "how clean is this data?" | data-quality | Asking about quality, not requesting a change |
| "what's wrong with this table?" | data-quality | Asking for a health assessment |
| "copy this to a new table called X" | data-management | Explicit copy/create action |
| "check for nulls and then fix them" | multistep | Two distinct actions: quality check then management |
| "export the clean_data table" | data-loading | "Export" is the verb; "clean_data" is a table name |
| "profile the sales_team table" | data-quality | "Profile" is the verb; "sales_team" is a table name |
| "detect anomalies in revenue" | query | ML function (AI.DETECT_ANOMALIES), not a quality check |
| "forecast next quarter" | query | ML function (AI.FORECAST) |
| "translate the description column" | query | Uses AI.GENERATE for translation |
