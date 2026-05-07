# Tier 3 #23 — Job-tracking polish: sort, search, overdue badge, .job-field CSS

> **Status:** active · started 2026-05-07 · branch `task/23-job-tracking-polish`

## Goal

PR #14 added the four shop metadata fields (customer / designer / due date / job number) to projects and wired the click-to-edit UI on `ProjectDetail`. From `todo.md` Appendix B row 23, four follow-ups remain:

1. **Sort the project list by `due_date`** (next-up dispatcher view) alongside the existing recency order.
2. **Overdue badge** on rows where `due_date < today` (and on the project-detail header).
3. **Cross-project search by name / customer / job_number** — substring match, client-side.
4. **`.job-field` CSS** so the click-to-edit fields on `ProjectDetail` visually match `.meta` text instead of inheriting the default body style.

"Done" means: the project list has a sort dropdown + search box; rows whose due date is in the past show a red "Overdue" pill; the existing field UI on ProjectDetail looks consistent with the rest of the muted metadata text; all changes are pure-frontend (no API or schema changes); the existing ProjectDetail tests / behavior are unchanged.

## Branch + setup

```sh
git fetch origin
git checkout -b task/23-job-tracking-polish origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )   # required before any Go command can compile
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `web/src/pages/ProjectList.tsx` — add a controls row above the list (search input + sort `<select>`); compute `displayedProjects` via `useMemo` from the raw `projects` plus query/sort state; render an "Overdue" badge inside each row's meta line when applicable.
- `web/src/pages/ProjectDetail.tsx` — replace the in-file `humanizeDueDate` with an import from the new shared lib; render the same "Overdue" badge inside the existing `<span className="meta">Due …</span>` block when the date is in the past. Otherwise leave the page unchanged.
- `web/src/App.css` — three new rule blocks: `.job-field` + `.job-field-value` (match `.meta` muted color and font size, with a subtle hover affordance to telegraph click-to-edit), `.badge-overdue` (small inline red pill), and `.project-list-controls` (the row holding the search + sort selectors). Keep all rules at the bottom of the file in a clearly-commented `/* Tier 3 #23 */` block — no edits to existing rules.

**New:**

- `web/src/lib/dueDate.ts` — exports `humanizeDueDate(iso: string): string` (moved from ProjectDetail; behavior unchanged) and `isOverdue(iso: string, today?: Date): boolean`. The optional `today` parameter exists for tests; production callers omit it.
- `web/src/lib/dueDate.test.ts` — vitest unit tests for both helpers (see Tests).

**Don't touch:**

- Anything in `internal/` — pure frontend change. No new endpoints, no query string parsing on the backend.
- `web/src/api.ts` — the existing `listProjects` already returns every field needed.
- `web/src/components/EditorCanvas.tsx`, `EditorPage.tsx` — high-coupling editor files.
- Any migration. The schema added in `0005_project_metadata.sql` is sufficient.

## Deliverables

### 1. Sort + search on the project list

- A small controls row above the `<ul className="project-list">`:
  - `<input type="search" placeholder="Search by name, customer, or job number" />` bound to a `query` state.
  - `<select>` with three options: `Recently updated` (default), `Due date (next first)`, `Name (A–Z)`.
- Filtering: case-insensitive substring match against `project.name`, `project.customer`, `project.job_number`. Empty query = match all. Trim before matching. Designer is **not** a search field (per the task description, which calls out customer / job_number specifically).
- Sorting:
  - `Recently updated` — descending `updated_at`. This must be the existing order (the current code already iterates the server response, which is presumably already in this order — verify by reading `storage.ListProjects` briefly; if it isn't, sort explicitly to make the default deterministic).
  - `Due date (next first)` — ascending `due_date`. Projects with empty `due_date` sink to the bottom in `updated_at`-descending order. (Empty-string is normal — backend returns `""` for unset fields per the existing struct.)
  - `Name (A–Z)` — case-insensitive ascending on `name`.
- Empty-state copy stays the same when no projects exist. Add a separate empty state when the filter/sort hides every project: "No projects match this search." (Don't show "No projects yet" if there are projects but the query filters them all out.)
- State lives in component state only — **no URL params, no localStorage**. Persistence is a Tier 3 follow-up.

### 2. Overdue badge

- A reusable inline element rendered as `<span className="badge-overdue">Overdue</span>`.
- Shown on `ProjectList` rows when `isOverdue(p.due_date)` is true, placed inside the existing meta line, after the due date text. Example output: `tube-12mm-clear · due 2026-05-01 [Overdue] · updated …`
- Shown on `ProjectDetail`'s existing "Due …" span when `isOverdue(project.due_date)` is true.
- The badge must be a single visual element with consistent sizing — no full-row tinting.

### 3. `.job-field` CSS

- The `job-field` and `job-field-value` classes are already used in `ProjectDetail.tsx` (e.g. line 412-427 / 519-534) but have no CSS rules. Today they inherit body color and font size, which makes the click-to-edit affordance look like primary content rather than metadata.
- Add rules so the labels match `.meta` styling: muted color (`var(--muted)`), `font-size: 0.875rem`, with `.job-field-value` getting a subtle border-bottom or hover background tint to suggest "click to edit". Don't add a heavy outline — the existing dropdown-driven tube-spec field is the visual reference for what "click-to-edit affordance" means in this app; mirror that.

### 4. Shared date lib

- Move `humanizeDueDate` out of `ProjectDetail.tsx` into `web/src/lib/dueDate.ts`. The implementation is **unchanged** — the only behavior change is the call site (replace the local function with an import). Verify `ProjectDetail`'s rendered output is byte-identical.
- Add `isOverdue(iso: string, today: Date = new Date()): boolean`:
  - Parse `iso + 'T00:00:00'` as a local date (matching `humanizeDueDate`'s convention).
  - Return false on parse failure (`Number.isNaN(d.getTime())`).
  - Compare to `today` with both values normalized to local midnight (zero out hours/minutes/seconds/ms on a fresh `Date(today.getFullYear(), today.getMonth(), today.getDate())`).
  - Return `due < todayMidnight`.

## Constraints

- **No new third-party deps** — no fuzzy-search libs, no date libs (`date-fns`, `dayjs`, etc.). The list is small enough that substring + native `Date` math is plenty.
- **No backend changes.** No new query string parsing on `/api/projects`, no new sort/filter endpoint. The list is small (single-shop tool); client-side is correct.
- **No URL or localStorage persistence** for sort/search state in V1 — that's a separate follow-up to keep this PR focused.
- **No Designer field in search** — task description names customer and job_number explicitly. Adding designer drift-creeps the scope.
- **No row-level styling** for overdue projects beyond the badge. Don't tint the whole row red; some shops have many overdue projects and the noise is unhelpful.
- **Existing ProjectDetail behavior unchanged** apart from the badge addition + import swap. Don't refactor the click-to-edit fields' inner implementation as part of this PR.

## Geometry / algorithms

**`isOverdue` reference implementation.**

```ts
export function isOverdue(iso: string, today: Date = new Date()): boolean {
  if (!iso) return false;
  const due = new Date(iso + 'T00:00:00');
  if (Number.isNaN(due.getTime())) return false;
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return due < todayMidnight;
}
```

A project due **today** is not overdue. A project due **yesterday** is.

**Sort comparator for "due date next-first".** Use a stable two-key sort: primary key is the parsed due-date timestamp (with empty/invalid pushed to `+Infinity`); secondary is `-updated_at` to break ties. Plain `Array.prototype.sort` is stable in every supported runtime; one comparator function is enough.

**Filter normalization.** Lowercase the query once, lowercase each candidate field once, `String#includes`. Empty query short-circuits to `true`.

**Search input semantics.** Use `<input type="search">` so the browser shows a clear-X button on focus. No autosubmit, no debouncing — the list is small, recompute on every keystroke is fine.

## Tests

Add to `web/src/lib/dueDate.test.ts`:

- `humanizeDueDate('2026-05-15')` → contains `'2026'` and `'May'` (locale-agnostic substring check; the formatted output varies by environment).
- `humanizeDueDate('')` → `''`.
- `humanizeDueDate('garbage')` → `'garbage'` (fallback).
- `isOverdue('2026-05-06', new Date('2026-05-07T10:00:00'))` → `true`.
- `isOverdue('2026-05-07', new Date('2026-05-07T10:00:00'))` → `false` (due today is not overdue).
- `isOverdue('2026-05-08', new Date('2026-05-07T10:00:00'))` → `false`.
- `isOverdue('', new Date())` → `false`.
- `isOverdue('not-a-date', new Date())` → `false`.
- `isOverdue('2026-05-06', new Date('2026-05-07T00:00:00'))` → `true` (boundary: midnight today).

For `ProjectList` and `ProjectDetail`, no unit tests — manual smoke covers it.

## Pre-merge checks

```sh
./scripts/test.sh                # Go tests + vitest, all green
( cd web && npm run build )      # tsc -b + vite build
go vet ./...
( cd web && npm run lint )       # advisory; no NEW diagnostics
```

Manual smoke test in a browser:

```sh
( cd web && npm run dev )
```

1. Create three test projects: one with `due_date` = yesterday, one = today, one = three days from now. Give two of them distinct `customer` values and the third a `job_number`.
2. Open the project list. Verify `Recently updated` is the default sort and matches today's behavior.
3. Switch to `Due date (next first)`. Verify ascending order; the project with no due date is last.
4. Type the customer's first three letters in the search box. Verify only matching projects show. Type a job_number fragment; verify it filters too.
5. Verify the yesterday-due row shows the red `Overdue` badge; today's row does not; future row does not.
6. Open the overdue project's detail page. Verify the same badge appears next to the "Due …" line.
7. On the detail page, verify the customer / designer / due-date / job-number fields render in muted color matching the rest of the metadata. Hover one — confirm the click-to-edit affordance is visible.
8. Clear the search box and verify all rows return.
9. Type a query that matches nothing — verify the "No projects match this search." empty state appears (and the original "No projects yet" copy doesn't).

## Workflow

1. Create `web/src/lib/dueDate.ts` with `humanizeDueDate` (verbatim move) and `isOverdue`. Land its tests first; verify all green.
2. Switch `ProjectDetail.tsx` to import from the new lib. Confirm no visual change.
3. Add the search/sort controls and `Overdue` badge to `ProjectList.tsx`.
4. Add the CSS rules in `App.css` under a `/* Tier 3 #23 */` block.
5. Run all four pre-merge checks. Run the manual smoke list above.
6. Open PR titled "Job-tracking polish: sort, search, overdue, .job-field CSS (Tier 3 #23)". Body links to `todo.md` Appendix B row 23.
7. **Move this spec** from `specs/active/tier3-23-job-tracking-polish.md` to `specs/done/tier3-23-job-tracking-polish.md` as part of your final commit.

## Report back

Under 300 words. Include:

- PR URL
- Implementation summary
- Judgment calls — sort tie-break choice, the exact `.job-field` styling decisions (border-bottom vs hover-tint vs both), and any UX choice on where the search/sort controls sit relative to the existing buttons.
- File-size deltas on `ProjectList.tsx` and `App.css`
- CI final state
- Tier 3 follow-ups worth tracking (URL/localStorage persistence for sort/search, server-side filtering when project counts grow, "Hide completed" once a completion flag exists, designer in the search field, calendar-view of due dates).
