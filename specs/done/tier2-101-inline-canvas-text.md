# Tier 2 #101 — Inline text editing on the canvas

> **Status:** DONE · drafted 2026-08-31 · shipped 2026-09-01 · branch
> `task/101-inline-canvas-text`

## What shipped, and where it differs from this spec

Three premises in the deliverables below turned out to be wrong or
incomplete. Corrections, with the reasoning:

1. **Deliverable 2 asked for re-generation into the DOC on every
   keystroke, coalesced into one undo step by EditorPage's 500 ms
   window.** That cannot hold: the coalescing is time-based, so any
   pause longer than 500 ms mid-word splits the word across two undo
   entries — and it would fire the debounced server-side validation on
   every character. It also contradicts deliverable 4, which talks
   about *committing* on Esc / click-away: if every keystroke were
   already in the doc there would be nothing left to commit. Shipped
   instead: the session (string, caret, kerning) is React state, the
   preview re-lays out on every keystroke, and the runs reach the doc
   in ONE `applyOp` at commit. One undo takes back the whole word at
   any typing speed. Verified in a browser against the saved doc.

2. **The trap section attributes the bare-key shortcuts (`o`, `c`,
   tool keys) to `EditorCanvas`.** They are in `EditorPage`: `o`
   (break/move opening), `c` (connect), `j` / `k` / `[` / `]` (issue
   nav), Cmd-A, and Delete/Backspace-deletes-the-selection. The canvas
   binds only Escape / Enter / Shift and Delete-on-a-selected-
   guideline. Suppression that only covered this file would have left
   the worse half live, so both files stand down: a capture-phase
   `keydown` listener on `window` swallows the keys the caret claims,
   and each of EditorPage's three handlers has an explicit guard.

3. **Deliverable 6's premise checks out.** Nothing in
   `internal/designdoc` or `web/src/api.ts` persists text parameters —
   a committed word is tube geometry. Editing existing text is
   therefore out of scope for V1 and no schema field was added; the
   README says so plainly rather than leaving the operator to discover
   it.

One more thing worth knowing: `EditorPage.tsx` is on the
`NUMERIC_INPUT_EXEMPT_FILES` list in `web/eslint.config.js`, so the
`no-restricted-syntax` ban on raw `<input type="number">` does NOT fire
there. The cap-height field uses `<NumericField>` by discipline, not
because lint would have caught it.

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
