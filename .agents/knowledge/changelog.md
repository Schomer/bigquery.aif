# Session Changelog

A record of what changed in each coding session. Read this to understand recent changes without digging through git diffs.

---

## 2026-07-01: Context chips in the prompt area

**What changed**:
- Added visual context indicator above the textarea in the prompt area
- Context chips auto-populate from the last response (dataset, table, result row count)
- Chips are dismissable -- removing a chip excludes that piece from the next orchestrator call
- Any previous ArtifactCard result can be pinned as context via a "chat" icon button in the card footer
- Pinning replaces the current context chips with the pinned result's context
- All orchestrator calls now derive context from the visible chips (source of truth)
- Context resets on new conversation
- Works in all three prompt bar locations: empty state, floating bar, split-mode sidebar

**Files modified**:
- `src/lib/types.ts` -- added `ContextItem` interface
- `src/app/page.tsx` -- `contextItems` state, `extractContextItems()`, `deriveContextFromItems()`, `pinEnvelopeContext()`, chips row rendering, ArtifactCard wiring
- `src/components/ArtifactCard.tsx` -- added `onPin`/`isPinned` props, chat icon button in footer
- `src/app/globals.css` -- `.context-chips-row`, `.context-chip`, `.context-chip-dismiss`, `.context-action-btn` styles

---

## 2026-07-01: Plan caching, conditional self-review, and result quality flags

**What changed**:
- Added session-scoped query plan cache (`plan-cache.ts`) that reuses SQL templates on iterative queries
- Made self-review Gemini call conditional -- skipped for schema listings, KPI cards, and high-confidence small results
- Added heuristic result quality analysis (`result-quality.ts`) for null rates, categorical near-duplicates, zero rows, and single-value columns
- Quality flags render as dismissible banners in `ArtifactCard.tsx` with amber/gray severity styling
- Quality flag suggested actions convert to next-action chips via the composer
- Single-value column detection suppresses WHERE-clause-filtered columns per user feedback

**Files created**:
- `src/lib/plan-cache.ts` -- session-scoped cache with parameter diffing and FIFO eviction
- `src/lib/result-quality.ts` -- pure heuristic checks, no model calls

**Files modified**:
- `src/lib/chat-orchestrator.ts` -- plan cache integration in `handleQuery()`, `routerConfidence` tracking, conditional self-review gate
- `src/lib/composer.ts` -- accepts and folds `qualityFlags` into envelopes, converts suggested actions to chips
- `src/lib/types.ts` -- added `qualityFlags` to `CompositionEnvelope`, re-exported `QualityFlag` type
- `src/components/ArtifactCard.tsx` -- dismissible quality flag banner rendering

---

## 2026-07-01: Freshness monitoring project-vs-dataset fix

**What changed**:
- Fixed `handleMonitoring` FRESHNESS handler to resolve dataset from enriched context, not just handoff context
- Made `FreshnessResult.dataset` nullable (null = project scope), added `project` field
- Updated composer and FreshnessView to correctly label project-scope vs dataset-scope results

**Files modified**:
- `src/lib/chat-orchestrator.ts` -- expanded monitoring handler context type, fixed dataset resolution chain
- `src/lib/types.ts` -- `FreshnessResult.dataset` now `string | null`, added `project?: string`
- `src/lib/composer.ts` -- `composeFreshness` handles empty entries and project-scope labeling
- `src/components/FreshnessView.tsx` -- empty state and summary badges distinguish project vs dataset

---

## 2026-06-30: Knowledge System Implementation

**What changed**:
- Created `.agents/knowledge/` directory with 7 knowledge files
- Updated `AGENTS.md` to reference knowledge system and enforce pre-change checks
- Established operational memory for the project

**Files created**:
- `.agents/knowledge/ops-ledger.md` -- operations log (pre-populated from history)
- `.agents/knowledge/invariants.md` -- system rules that must hold
- `.agents/knowledge/data-encyclopedia.md` -- BigQuery domain knowledge
- `.agents/knowledge/test-cases.md` -- canonical regression test cases
- `.agents/knowledge/component-map.md` -- codebase structure guide
- `.agents/knowledge/prompt-versions.md` -- LLM prompt tracking
- `.agents/knowledge/changelog.md` -- this file

**Why**: The project had no institutional memory. Each coding session started from scratch, leading to regressions and oscillating fixes. This knowledge system gives future sessions context about what works, what doesn't, and why.

---

## 2026-06-30: Data Lineage Visualization

**What changed**:
- Added `LineageDagView.tsx` component for DAG visualization
- Updated discovery handler to support LINEAGE sub-type
- Lineage data sourced from `INFORMATION_SCHEMA.JOBS_BY_PROJECT`

---

## 2026-06-30: Dataset Table Listing Fix

**What changed**:
- Fixed `handleSchema()` to correctly distinguish dataset scope vs table scope
- Added dataset name validation against `availableDatasets` list
- Fixed `extractSchemaIdentifiers()` to check known datasets before defaulting to TABLE scope

**Root cause**: The schema handler treated all unqualified names as table names, even when they matched known dataset names.

---

## 2026-06-30: Infinite Refresh Loop Fix

**What changed**:
- Fixed auth state handler to be idempotent
- Added state comparison before calling setState in auth context

**Root cause**: Auth token expiration triggered setState which triggered re-render which re-checked auth in a loop.

---

## 2026-06-26: Table Duplication Support

**What changed**:
- Added copy/duplicate/replicate verbs to `MUTATING_VERBS` in router
- Added counterbalancing "find duplicates" / "check for duplicates" phrases to `DATA_QUALITY_SIGNALS`
- Updated data-management handler to support COPY_TABLE operation

**Lesson learned**: Ambiguous words added to MUTATING_VERBS need high-weight counterparts in quality signals to prevent misrouting.

---

## 2026-06-24: UI Styling and Controls

**What changed**:
- Flat segmented control styling
- Header control repositioning
- Regenerate button repositioning

---

## Template for Future Entries

Copy this when adding a new entry:

```
## YYYY-MM-DD: [Short Description]

**What changed**:
- [List of changes]

**Files modified**:
- [List of files]

**Root cause** (if fixing a bug):
- [Why the bug existed]

**Lesson learned** (if applicable):
- [What to remember for next time]
```
