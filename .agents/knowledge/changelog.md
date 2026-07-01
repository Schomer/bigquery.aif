# Session Changelog

A record of what changed in each coding session. Read this to understand recent changes without digging through git diffs.

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
