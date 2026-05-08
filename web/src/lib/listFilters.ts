// Pure helpers for the project-list view-state round-trip across URL
// params, localStorage, and React state. Tier 3 #38c — Step 1 of the
// project-list bundle-preview + persistence PR.
//
// Why split this out:
//   1. Keeps ProjectList.tsx thin — it only wires hooks; the parsing,
//      validation, and merging logic is testable in isolation.
//   2. Defends against URL noise (unknown sort keys, garbage
//      characters) without leaking the validation onto every reader.
//   3. URL > localStorage > default, with localStorage updated from
//      whichever source won, so a refresh keeps the user's view and a
//      shared link round-trips cleanly.

// SortMode mirrors the dropdown values in ProjectList.tsx. Kept here so
// the parser can reject unknown values without ProjectList re-exporting
// the type from a component file. Order matches the dropdown.
export type SortMode = 'updated' | 'due' | 'name';

export const SORT_MODES = ['updated', 'due', 'name'] as const;
export const DEFAULT_SORT: SortMode = 'updated';

// LocalStorage shape under the v1 namespace. Bumping the suffix is the
// migration path if the field set ever changes — old keys then drift
// out of cache without throwing.
export const STORAGE_KEY = 'nb.projectList.v1';

export type ListFilters = {
  sort: SortMode;
  q: string;
};

export const DEFAULT_FILTERS: ListFilters = {
  sort: DEFAULT_SORT,
  q: '',
};

// isSortMode narrows an arbitrary string. Used by every call site that
// reads from URL or storage, so unknown values can never make it into
// state. The cast in the body is the one place we trust the literal
// values.
export function isSortMode(v: unknown): v is SortMode {
  return typeof v === 'string' && (SORT_MODES as readonly string[]).includes(v);
}

// parseFiltersFromSearch reads `?sort=...&q=...` and returns a fully
// resolved ListFilters. Unknown sort modes fall back to the default;
// missing fields stay at their defaults rather than throwing.
//
// We also clamp `q` to a sane length — the in-memory list is small,
// but a multi-megabyte URL would still bloat localStorage and the
// debounced write loop. 256 chars matches the project-name max in
// the backend (covers customer + job-number searches comfortably).
export const MAX_QUERY_LENGTH = 256;

export function parseFiltersFromSearch(search: string): ListFilters {
  // URLSearchParams accepts leading "?" or no prefix uniformly across
  // browsers. We don't reach for window.location to keep this pure.
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const rawSort = params.get('sort');
  const rawQ = params.get('q') ?? '';
  const sort: SortMode = isSortMode(rawSort) ? rawSort : DEFAULT_SORT;
  const q = rawQ.slice(0, MAX_QUERY_LENGTH);
  return { sort, q };
}

// filtersToSearchParams serialises a ListFilters back to URLSearchParams.
// Default values are *omitted* so the URL stays clean — a fresh user
// who never touched the controls sees no `?sort=updated` litter.
//
// Returns URLSearchParams (not string) so callers can merge with other
// params (e.g. selected-project anchors) before stringifying. Callers
// usually want `params.toString()` followed by a `?` prefix only when
// non-empty.
export function filtersToSearchParams(filters: ListFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.sort !== DEFAULT_SORT) params.set('sort', filters.sort);
  if (filters.q !== '') params.set('q', filters.q);
  return params;
}

// loadStoredFilters reads `nb.projectList.v1` from a Storage-like
// object. Accepts an injected Storage so tests can pass a stub without
// a jsdom environment. Returns DEFAULT_FILTERS on any failure (missing
// key, unparseable JSON, schema drift) — the user just gets the
// default view, never an exception.
export function loadStoredFilters(storage: Pick<Storage, 'getItem'> | null | undefined): ListFilters {
  if (!storage) return { ...DEFAULT_FILTERS };
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    // Some browsers throw on getItem in private mode / quota issues.
    return { ...DEFAULT_FILTERS };
  }
  if (raw === null) return { ...DEFAULT_FILTERS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_FILTERS };
  }
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_FILTERS };
  const obj = parsed as Record<string, unknown>;
  const sort = isSortMode(obj.sort) ? obj.sort : DEFAULT_SORT;
  const qRaw = typeof obj.q === 'string' ? obj.q : '';
  const q = qRaw.slice(0, MAX_QUERY_LENGTH);
  return { sort, q };
}

// saveStoredFilters writes the current filters to localStorage. Default
// values still get written (so the key is present and the next mount
// can short-circuit URL > storage merging consistently). Wrapped in
// try/catch so a quota error never crashes the page.
export function saveStoredFilters(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  filters: ListFilters,
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // Quota exceeded / disabled storage — persistence is best-effort.
  }
}

// resolveInitialFilters implements the URL > localStorage > defaults
// precedence. Used on mount to pick the starting state.
//
// The behaviour we want:
//   - URL has explicit ?sort and/or ?q → those values win.
//   - URL is empty → fall back to whatever localStorage has (which
//     may itself be DEFAULT_FILTERS, that's fine).
//   - URL has *some* fields but not others → URL wins for the present
//     fields; storage fills the gaps. This lets a shared link override
//     just the sort without losing the user's saved query.
export function resolveInitialFilters(
  search: string,
  storage: Pick<Storage, 'getItem'> | null | undefined,
): ListFilters {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const stored = loadStoredFilters(storage);
  const rawSort = params.get('sort');
  const rawQ = params.get('q');
  const sort: SortMode = isSortMode(rawSort) ? rawSort : stored.sort;
  let q: string;
  if (rawQ === null) {
    q = stored.q;
  } else {
    q = rawQ.slice(0, MAX_QUERY_LENGTH);
  }
  return { sort, q };
}
