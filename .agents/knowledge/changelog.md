# Session Changelog

A record of what changed in each coding session. Read this to understand recent changes without digging through git diffs.

---

## 2026-07-01: Orbiting stars and particles on signed-out page

**What changed**:
- Added three concentric orbit rings around the crystal ball on the signed-out page
- Ring 1 (240px, 18s) has 3 twinkling 4-point stars
- Ring 2 (360px, 28s, reverse) has 1 star and 3 glowing dot particles
- Ring 3 (520px, 40s) has 2 stars and 3 particles
- Stars use clip-path for a 4-point sparkle shape, particles are soft glowing circles
- Each element twinkles/pulses at staggered delays for a layered feel

**Files modified**:
- `src/components/shell/SignedOutPage.tsx` -- wrapped icon-ring in orbit-container, added orbit ring divs with star/particle children
- `src/app/globals.css` -- added `.so-orbit-container`, `.so-orbit-*`, `.so-star-*`, `.so-particle-*` styles and `so-spin`, `so-twinkle`, `so-pulse` keyframes

---

## 2026-07-01: Project selection CTA with Firestore-backed favorites

**What changed**:
- Removed the small info-field with icon that said "Select a GCP project from the sidebar to get started"
- Replaced with a larger call-to-action area that displays two sections: Favorites (starred projects from TopBar) and Recent Projects
- Both sections render clickable buttons that call `setActiveProject()` directly
- Migrated favorite projects from localStorage-only to Firestore-backed persistence (`users/{uid}.favoriteProjects`)
- localStorage still used as a synchronous cache for instant UI on mount; Firestore is the authoritative source
- TopBar `toggleFavorite` now writes to both localStorage and Firestore
- Added `getFavoriteProjects()` and `saveFavoriteProjects()` to firestore-service
- Recent projects still tracked in localStorage (`hdn_recent_projects`), updated on project switch

**Files modified**:
- `src/lib/firestore-service.ts` -- added `getFavoriteProjects()` and `saveFavoriteProjects()`
- `src/components/shell/TopBar.tsx` -- load favorites from Firestore on mount, persist toggles to Firestore
- `src/app/page.tsx` -- load favorites from Firestore, added `getFavoriteProjects` import

---

## 2026-07-01: BQ Console deep-links in thinking steps

**What changed**:
- Thinking steps with dataset/table/project context now show a small external-link icon on hover that opens the corresponding view in BigQuery Cloud Console
- Added `StepInfo` type and `StatusCallback` alias to `types.ts` -- `onStatus` now accepts `string | StepInfo`
- Added `bqConsoleUrl()` and `stepWithLink()` helpers to orchestrator
- Key orchestrator steps enriched: "Building SQL...", "Dry-running query...", schema lookups, data management operations
- Dataset and table names in the thinking metadata section are now clickable links to BQ Console
- Hover-reveal link icon uses `opacity: 0` -> `1` transition on `.thinking-step:hover`
- Entity links use dotted underline styling via `.thinking-entity-link`

**Files modified**:
- `src/lib/types.ts` -- added `StepInfo` interface and `StatusCallback` type alias
- `src/lib/chat-orchestrator.ts` -- added `bqConsoleUrl()`/`stepWithLink()`, updated all 9 handler signatures to `StatusCallback`, enriched 7 key onStatus call sites
- `src/app/page.tsx` -- updated state types, onStatus callbacks, step rendering, and metadata entity links
- `src/app/globals.css` -- added `.step-link` and `.thinking-entity-link` styles

---

## 2026-07-01: Editable SQL block with re-run

**What changed**:
- SQL blocks now wrap multi-line (`pre-wrap`) instead of scrolling off-screen horizontally
- Added `max-height: 240px` with vertical scrolling for long queries
- SQL in query result cards can be edited inline: click "Edit" to switch to a textarea, modify the SQL, then click "Run" to re-execute the modified query
- "Reset" link reverts edits to the original SQL
- Re-run uses the existing chip-click orchestration path (`forcedSkill: 'query'` with SQL context)

**Files modified**:
- `src/app/globals.css` -- updated `.sql-block`, added `.sql-block-editor`, `.sql-action-btn`, `.sql-run-btn`
- `src/components/ArtifactCard.tsx` -- replaced static SQL div with editable textarea + action bar
- `src/app/page.tsx` -- added `handleRunSql()` and passed `onRunSql` prop to ArtifactCard
- `src/components/AlertView.tsx` -- added pre-wrap and max-height to Check SQL block

---

## 2026-07-01: Fix session expired sign-in loop

**What changed**:
- "Session Expired" error banner now shows "Sign in again" button (was "Try again") that opens the Google sign-in popup to get a fresh OAuth token, instead of retrying the message with the expired token
- `handleAuthError()` in `bigquery-client.ts` now clears the stale token from sessionStorage before redirecting, so the redirect lands on the sign-in page instead of the app with a broken token

**Files modified**:
- `src/app/page.tsx` -- pull `signIn` from useAuth, use it as retryFn for auth errors, change button label
- `src/lib/bigquery-client.ts` -- clear sessionStorage before hard redirect

---

## 2026-07-01: Auto-scroll shows result top instead of overshooting

**What changed**:
- When a prompt returns results, the chat now scrolls to the top of the last assistant message instead of scrolling past it to a bottom sentinel div
- User messages still scroll to the bottom (to keep the loading spinner visible)
- Added `data-msg-idx` data attributes to message wrapper divs in both center and sidebar layouts so the scroll logic can find the target element
- Used `requestAnimationFrame` to let DOM render the new content before scrolling

**Files modified**:
- `src/app/page.tsx` -- updated auto-scroll `useEffect`, added `data-msg-idx` attributes to message divs

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
