# Bug #10 — Switching tube spec with unsaved edits desyncs the validation summary

> **Status:** shipped · drafted 2026-06-05 · found via Playwright manual-authoring session (cursive "Salon" build, project 16) · branch (when dispatched) `task/bug-10-spec-switch-revalidate-live-doc`

## Goal

Changing the project's **Tube spec** from the editor dropdown **while there are unsaved edits** makes
the validation summary go stale and falsely green: the canvas and Runs list still show the runs, but
the status line and sidebar report **"All rules pass · 0 runs · 0.00m total tube" / "Ready to print"**.
The operator sees a "passing, ready to print" sign that actually has runs (and, in the repro,
20-plus real errors).

"Done" means switching the tube spec re-validates the **in-memory** design against the **new** spec, so
the summary keeps reflecting the runs that are visibly on the canvas — never "0 runs" while runs exist.

## Reproduction (Playwright-verified)

1. New project, default **12 mm** tube spec → **New blank design** → **Add text** `Salon`
   (Cursive, cap 220 mm) → **Insert**. *Do not save.*
2. Status reads e.g. **"26 errors · 4 warnings · 3 runs · 4.40m total tube"** (correct — live validation
   of the unsaved doc).
3. In the editor, switch **Tube spec** 12 mm → **8 mm**.
4. **Bug:** status flips to **"All rules pass · 0 runs · 0.00m total tube"** and the sidebar shows
   **"Ready to print · 0 tube runs · 0mm total length · 0 × 0mm"** — while the **Runs** list still lists
   `text-1 / text-2 / text-3` (each `ø 12 mm`) and the canvas still draws the word ("3 runs" in the
   zoom readout). The runs also keep their **old** 12 mm diameter, not the newly-selected 8 mm.

## Root cause (code-verified)

Two compounding issues in [web/src/pages/EditorPage.tsx](../../web/src/pages/EditorPage.tsx):

1. **`changeTubeSpec` revalidates the persisted version, not the live doc.**
   [EditorPage.tsx:1285](../../web/src/pages/EditorPage.tsx#L1285) does:
   ```
   await api.updateProject(projectId, { tube_spec_id: nextSpecId });   // persist new spec
   const revalidated = await api.revalidate(projectId, versionId);     // validates the SAVED version
   setReport(parseReport(revalidated));
   ```
   `revalidate(projectId, versionId)` validates the **saved** design version on the server. With
   unsaved edits the saved version is stale — here it's the **blank** v1 (0 runs) — so the report comes
   back "0 runs / all pass" and **clobbers** the live report. The live editor renders the in-memory
   `doc` (3 runs); the report now describes a different (blank) document.

2. **The live-validate effect can't self-correct, because it doesn't depend on the spec.**
   The debounced live validator at [EditorPage.tsx:370](../../web/src/pages/EditorPage.tsx#L370) is what
   normally keeps the report honest for unsaved edits (`api.validateDoc(projectId, doc, …)`), but its
   deps are `[doc, dirty, projectId]`. A spec switch changes `project.tube_spec_id`, **not** `doc`, so
   the effect never re-fires and the clobbered "0 runs" report persists.

So the bug bites specifically on **dirty doc + spec switch**. On a clean doc the saved version matches
the editor, so `revalidate` is correct and there's no desync.

## Proposed fix

In `changeTubeSpec`, validate the **current in-memory doc** against the new spec instead of the stale
saved version when the doc is dirty:

```ts
await api.updateProject(projectId, { tube_spec_id: nextSpecId });
setProject(updatedProject);
setTubeSpec(...);
const rep = dirty && doc
  ? await api.validateDoc(projectId, doc)        // live doc, now validated vs the new spec
  : parseReport(await api.revalidate(projectId, versionId));  // clean doc → saved version is authoritative
setReport(rep);
```

Belt-and-suspenders: add `project?.tube_spec_id` to the live-validate effect's dependency array
([EditorPage.tsx:395](../../web/src/pages/EditorPage.tsx#L395)) so any spec change re-triggers a live
validate while dirty.

**RESOLVED (2026-08-31, confirmed with the user before coding):** yes — but by *clearing* the field,
not rewriting it. Runs still carrying the **old spec's** diameter have `tube_diameter_mm` deleted so
they inherit the project spec (`run.tube_diameter_mm ?? projectDiameterMM`); a run overridden to some
*other* diameter keeps it. Clearing rather than rewriting means the next spec change needs no
migration at all.

The spec's original framing below understated this. `tube_diameter_mm` is **not** display-only — it
feeds bend clustering ([designdoc/bends.go:145](../../internal/designdoc/bends.go#L145)), the takeoff's
glass grouping ([takeoff/takeoff.go:352](../../internal/takeoff/takeoff.go#L352)) and the ø printed on
the pattern ([printpdf/render.go:677](../../internal/printpdf/render.go#L677)). A stale value orders the
wrong glass stock and tells the bender the wrong size, so leaving it was not a neutral option. Runs are
also *seeded* with the project diameter at vectorize time
([designdoc/convert.go:41](../../internal/designdoc/convert.go#L41)), so most values are inherited
defaults rather than deliberate overrides — the data model cannot tell the two apart, which is why the
"matches the old spec" heuristic is the best available discriminator.

<details><summary>Original open question</summary>

**Open question for the implementer (confirm before coding):** should switching the spec also retag
existing runs' `tube_diameter_mm` to the new spec's diameter? Today they keep their seeded diameter
(the runs stayed `ø 12 mm` after switching to 8 mm). The run panel notes the per-run diameter is an
"editor-only override" and "validation still uses the project tube spec", so validation already uses
the new spec's bend/spacing limits — but the displayed `ø 12 mm` and the 3D tube thickness lag. This
may be intentional (preserve explicit overrides) or a second bug. Decide and document.

## Tests

- Component test (EditorPage): render with a dirty doc containing N runs, switch the tube spec, and
  assert the summary still reports N runs (not 0) and the error count matches a live `validateDoc` of
  the in-memory doc — not the saved version.
- Guard test: switching the spec on a **clean** doc still validates the saved version (no regression).

## Severity

High-confusion, ship-risk: the false "Ready to print · all rules pass" can send an invalid design to
the bender. Data is not corrupted (the doc is intact; only the report is wrong), and saving a new
version re-runs live validation and restores the true counts — but the operator has no reason to
distrust a green summary.


## Verification (2026-08-31)

Reproduced and fixed end-to-end with Playwright against real Windows builds of both `main` and the fix
(`scripts/windows-smoke.ps1`'s host, `.89`), using the spec's own repro shape — a **blank** saved
version with runs drawn live and left unsaved:

| | before switch | after switch |
|---|---|---|
| `main` | `10 errors · 3 warnings · 2 runs · 0.99m` | **`All rules pass · 0 runs · 0.00m`** (2 runs still listed) |
| fixed | `10 errors · 3 warnings · 2 runs · 0.99m` | `6 errors · 2 warnings · 2 runs · 0.99m` |

The error count *falling* 10 → 6 is the tell that validation genuinely re-ran against the new spec:
ø12 → ø8 permits a tighter minimum bend radius, so real violations disappear.

An earlier repro attempt that **vectorized** first did not reproduce the bug — the saved version then
already held the same runs, so revalidating it returned a plausible report and masked the desync. The
divergence between saved and live is the whole mechanism; any repro must create it.

**Testing note:** the component-level test this spec asks for needs React Testing Library, which the
repo deliberately does not wire up (see `PanelSection.test.tsx`). Adding it is a new dependency and
needs agreement per CLAUDE.md, so the unit coverage here is on `clearRunDiametersMatching` in
`docOps.test.ts`, and the desync itself is covered by the Playwright repro above.
