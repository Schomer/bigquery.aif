# Prompt Version Tracking

The app's behavior is heavily driven by the prompts sent to Gemini. This file tracks the key prompts, where they live, and when/why they changed. Prompt changes are high-impact and should be tested against the canonical test cases before deploying.

Last updated: 2026-06-30

---

## Critical Prompts

### 1. Data Assistant System Instruction
- **Location**: `src/lib/chat-orchestrator.ts`, line 59 (`DATA_ASSISTANT_INSTRUCTIONS`)
- **Prepended to**: Every Gemini call via `callGemini()`
- **Purpose**: Sets the assistant's persona and behavioral rules
- **Key rules in this prompt**:
  - Act, don't explain how to act
  - Make best interpretation and execute
  - Pause only for permanent data changes
  - Lead with results, not descriptions
  - Always backtick-wrap fully qualified table references
- **Risk**: Changes here affect ALL skill outputs. Test thoroughly.

### 2. Intent Classifier Prompt
- **Location**: `src/lib/chat-orchestrator.ts`, lines 453-472 (inline in `processMessage()`)
- **Called when**: Router returns medium/low confidence
- **Purpose**: LLM-based skill classification and multistep detection
- **Key rules in this prompt**:
  - Single verb + single object = never multistep
  - Analytical phrases are read-only query operations, never data-management
  - Explicit multi-action language required for multistep
- **References**: `public/skills/intent-routing.md` (loaded at runtime)
- **Risk**: Changes here affect how ambiguous messages get routed. Always test R5, R6, R7 from test-cases.md.

### 3. Query Skill Prompt
- **Location**: `src/lib/chat-orchestrator.ts`, lines 1233-1271 (inline in `handleQuery()`)
- **Purpose**: SQL generation + visualization selection
- **Key rules**:
  - Must generate `resultSummary` for headline
  - Visualization enum must match `QueryResponseSchema`
  - Column chart != bar chart (explicit distinction)
  - Today's date is injected for temporal queries
- **Also loads**: `public/skills/query.md` via `loadSkillDoc('query')`

### 4. SQL Repair Prompt
- **Location**: `src/lib/chat-orchestrator.ts`, lines 1318-1326 (inline in `handleQuery()` catch block)
- **Purpose**: Fix BigQuery syntax errors on auto-retry
- **Key rules**:
  - GEOGRAPHY columns: use ST_ASTEXT() or exclude
  - STRUCT/ARRAY/JSON: exclude from DISTINCT
  - Backtick-wrap hyphenated identifiers
- **Risk**: Low -- only fires on query failure. But changes could cause infinite retry loops if not careful.

### 5. Self-Review Prompt
- **Location**: `src/lib/chat-orchestrator.ts`, lines 1066-1130 (inline in `selfReviewEnvelope()`)
- **Purpose**: Post-composition quality check
- **Reviews**: Comprehension, completeness, presentation, visual design
- **Can override**: Headline text, visualization type, x/y axis, column emphasis
- **Risk**: Changes affect the polish of all responses. Non-fatal (errors return original envelope).

### 6. Schema Enrichment Prompt
- **Location**: `src/lib/chat-orchestrator.ts`, lines 932-949 (inline in `handleSchema()`)
- **Purpose**: Generate INFORMATION_SCHEMA SQL for complex listing requests
- **Key rules**:
  - First column must be the entity identifier (dataset_name or table_name)
  - Use descriptive column aliases
  - Backtick-wrap identifiers with hyphens

---

## Skill Definition Prompts (Runtime)

Loaded from `public/skills/*.md` by `loadSkillDoc()`. Cached in memory.

| File | Used By | Purpose |
|------|---------|--------|
| `intent-routing.md` | Intent classifier | Routing reference table |
| `schema.md` | Schema LLM fallback | Scope classification |
| `query.md` | Query handler | SQL generation rules |
| `data-management.md` | Data management handler | DML/DDL planning |
| `data-quality.md` | Data quality handler | Check type classification |
| `monitoring.md` | Monitoring handler | Sub-type classification |
| `discovery.md` | Discovery handler | Discovery type classification |
| `data-loading.md` | Data loading handler | Operation classification |

---

## Prompt Change Log

### 2026-06-30 (initial tracking)
- All prompts documented at current state
- No prior change history available

---

## Rules for Changing Prompts

1. **Document the change**: Add an entry to the change log above with date, what changed, and why
2. **Test routing changes**: Run test cases R1-R10 from test-cases.md
3. **Test query changes**: Verify Q1-Q4 from test-cases.md
4. **Never change the model**: Prompt changes must not include model changes. Model is always `gemini-3.5-flash`.
5. **Keep behavioral instructions stable**: The DATA_ASSISTANT_INSTRUCTIONS prompt should rarely change. It defines the app's core personality.
