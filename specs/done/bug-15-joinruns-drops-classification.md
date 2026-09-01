# Bug #15 — `joinRuns` drops the merged run's classification fields

> **Status:** done · PR #161 · found 2026-08-31 (PR #152 merged first, as required)

## Symptom

Join two runs and the result silently loses its channel-letter flag, raceway
membership, group membership, and jumper/tube kind. The most visible
consequence is the same one PR #140 fixed for `splitRun`: **join the two halves
of a channel-letter face and the merged run stops emitting a return-strip
page** — the pattern the fabricator bends the metal from just isn't in the PDF.

## Root cause

`joinRuns` (`web/src/lib/docOps.ts`) builds the merged run from an explicit
allow-list:

```ts
// Result inherits runA's metadata (color, diameter, notes) and id.
const joined: DesignRun = { id: runA.id, polyline: {...} };
if (runA.tube_diameter_mm != null) joined.tube_diameter_mm = ...;
if (runA.color != null) joined.color = ...;
if (runA.notes != null) joined.notes = ...;
```

Five fields are missing: `is_channel_letter_face`, `channel_letter_depth_mm`,
`raceway_id`, `group_id`, `kind`. The comment states the list as if it were
complete, which is what makes it easy to read past.

Each has a real consequence: dropping `is_channel_letter_face` /
`channel_letter_depth_mm` removes the return-strip page; `raceway_id` drops the
run out of the combined raceway strip; `group_id` silently ejects it from its
group; `kind` turns a jumper back into a live tube, which changes both the 3D
render and the printed legend.

## This is the fourth instance of one bug class

`CLAUDE.md` → **Recurring bug classes → 1** documents the pattern. Instances so
far: `splitRun` (PR #140), `reverseRun` (Bug #11 / PR #149),
`joinRuns.reversedRun` (Bug #14 / PR #152), and now `joinRuns` itself. Two of
the four are in this one function.

That frequency is the actual finding. Consider whether the durable fix is a
shared helper — something like `carryRunClassification(from, to)` — used by
every op that produces a new run from an existing one, so the next op cannot
forget by omission. If you add one, make `splitRun` and the doubleback/neonize
paths use it too, and check whether any of *those* are also dropping fields.

## Merge conflict: A vs B

`joinRuns` merges two runs, so "inherit runA's" needs a rule when they disagree:

- `is_channel_letter_face` — true if **either** is true. A face joined to a
  non-face is still a face; losing the strip page is the expensive error.
- `channel_letter_depth_mm` — runA's if set, else runB's. Warn if they differ
  and disagree, rather than silently picking one.
- `raceway_id`, `group_id` — runA's if set, else runB's.
- `kind` — if one is a `jumper` and the other is not, the result is **not** a
  jumper: a jumper is glass-sleeved lead wire, and joining it to live tube
  makes the union live. State this in a comment; it is the one case where
  "inherit A" would be actively wrong.

Document each choice at the call site. These are trade decisions, not
preferences — if any of them contradicts `docs/neon-rules/`, ask.

## Strict file scope

**Modify:** `web/src/lib/docOps.ts`, `web/src/lib/docOps.test.ts`. If you add a
shared carry helper and wire it into `splitRun`, that is in scope; nothing else
is.

## Tests

- Join two face runs → merged run is a face and keeps the depth override.
- Join a face to a non-face → still a face (the either-side rule).
- `raceway_id` / `group_id` survive from A, and from B when A has none.
- jumper + non-jumper → not a jumper.
- **The consumer test, which is the one that matters:** a joined channel-letter
  face still produces a return-strip page. PR #140 proved a unit test is not
  enough here — it was measured against a real `print.pdf` (1 strip page with
  the fix, 0 without). Do the same.
- Joining two plain runs is unchanged.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run lint && npm run build )
```
