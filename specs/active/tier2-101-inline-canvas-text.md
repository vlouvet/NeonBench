# Tier 2 #101 — Inline text editing on the canvas

> **Status:** active · drafted 2026-08-31 · branch `task/2-inline-text`

## Goal

Text is entered through a modal. You type blind, press Insert, and only then
see the result in place — so every adjustment is a round trip through a dialog.
The parity audit names this precisely twice: **#1 Direct Text Entry** is 🟡
because *"inline-on-canvas typing remains the gap"*, and **#15 Kerning** is 🟡
because *"inline-on-canvas kerning still ❌"*.

Closing it promotes **two 🟡 rows to ✅** without building any new geometry —
every primitive already exists.

## Strict file scope

**Modify:** `web/src/components/EditorCanvas.tsx` (a `text` tool + caret
rendering), `web/src/pages/EditorPage.tsx` (tool entry, minimal),
`README.md`.

**New:** `web/src/components/InlineTextEditor.tsx` and its state helper +
tests. Put as much logic as possible in the helper so it is testable without a
DOM — the repo has no DOM test environment by design.

**Don't touch:** `web/src/lib/hershey/**`. `hersheyTextToRuns` and the layout
transforms from PR #146 are the engine; this is a new front end for them. If
you find yourself editing the glyph walk, stop — the design is wrong.

## Deliverables

1. A `text` tool. Click on the canvas to place a caret; type and the glyphs
   appear in place, at the current cap height, in the selected face.
2. **Re-generation on every keystroke, committed as one undo step.** Each
   keystroke rebuilds the runs, so naive `editDoc` calls would give one undo
   entry per character. Use the existing 500 ms coalescing in `EditorPage.tsx`,
   and route mutations through `applyOp` — a bare `editDoc` whose result you
   read back is the race documented in CLAUDE.md's recurring bug classes.
3. Caret and selection rendering in world coordinates, surviving pan and zoom.
   Arrow keys, Home/End, Backspace/Delete, and Enter for a new line.
4. **Escape and click-away commit, they do not cancel.** Losing typed text to
   a stray click is the failure mode operators will actually hit. Provide undo
   as the way back.
5. Inline kerning: with the caret between two glyphs, a modifier + arrow
   adjusts that pair's kern, writing into the same `perPairKerningMM` array the
   modal's drag handles use. The two editors must agree — round-trip a doc
   through both and assert the arrays match.
6. Editing an **existing** text run is out of scope for V1 unless it falls out
   for free: nothing persists the source string (verified — nothing in
   `internal/designdoc` or `web/src/api.ts` stores text parameters), so
   re-editing means either storing them or re-deriving them from geometry.
   Say which you chose; do not add a schema field without asking.

## The trap this feature is most likely to hit

`EditorCanvas` already binds a lot of single-key shortcuts (`o`, `c`, tool
keys, Delete/Backspace on a selected guideline, Escape). A text tool captures
**all** printable keys, so every one of those bindings must be suppressed while
the caret is active, and restored when it is not. Get this wrong and typing
"open channel" deletes a guideline and switches tools mid-word. Add a test for
the suppression, not just the typing.

## Tests

- The state helper: insertion, deletion, caret movement, multi-line, Home/End
- Kerning array round-trips identically between inline and modal editors
- Shortcut suppression while the caret is active; restoration after commit
- A typed string produces the same runs as the modal given the same parameters
- One undo reverts a whole typed word, not one character

## Pre-merge

Standard four checks, plus a real browser: type a word, kern a pair inline,
commit, save, reload, and confirm the geometry read back from the API matches
what was on screen.
