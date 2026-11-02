# Usability review: NeonBench vs NeonWizard, with ideas from Inkscape, GIMP and Krita

Reviewed 2026-11-02 against `main` at `9e7574b`. The work below is filed in
`todo.md` Appendix B as rows 149-161; row 102 already covered the keymap.

## How this was checked

**NeonBench** was built from `main` and driven in a real browser with
Playwright, on a text job ("EAT"). Negative results were only accepted with a
control: with a run selected, Delete took the count 9 → 8 and undo restored it,
so "nothing happened" below means the key really did nothing.

**NeonWizard was not run.** The demo is no longer a public download; it is
requested by email and cannot save, export or print without an X overlay. The
evidence is the vendor's own material: the 6.5 Upgrade Guide, the Sign Wizard 7
Upgrade Guide (same application family and main window), the feature page and
its animated GIFs. That is good evidence for how things are laid out and what
the steps are. It says nothing about how fast or pleasant NeonWizard is, so
every "NeonWizard is better" below should be re-tested once the demo arrives.

**Inkscape, GIMP and Krita** were read from shallow clones of current upstream,
2026-11-02. File paths below are relative to each project's root.

## Why it feels behind

Parity is not the problem. `todo.md` Appendix A counts features, and Neon Design
Tools has no ❌ left. The gap is the cost of each small action, which a feature
tally cannot show:

| | NeonWizard | NeonBench today |
|---|---|---|
| Neon ops on a tube | Click anywhere on the tube; one flat menu with a key for each op (`B D T M K Ins L A O Del`) | Right-click works only on a vertex in Node edit; no menu on a segment and none in Select; no menu keys |
| Screen layout | Thin icon toolbox on the left, one context property bar, tabbed side panels | 29 labelled buttons in rows above the canvas; canvas starts 368 px down at 1280×800 |
| Tool keys | Programmable, single letters allowed | Only `O` and `C` |
| Live numbers | Total / Tube / Object length and size always shown; segment Rad, Ctr, Len | Run and length totals in badges; no segment readout found |
| Seeing the glass | Tube drawn at its real width; past max length it drops to a bare centreline | Hairline centreline only |

Measured canvas share of the window: 880×455 of 1280×800 is **39%**; 1520×770 of
1920×1080 is **56%**. At 1280×800 the page itself also scrolls (848 px tall).

## Verified defects

These are not matters of taste. Each was reproduced in the running app or
confirmed by search, unless marked otherwise.

| Finding | Evidence |
|---|---|
| **Unsaved work is lost with no warning.** | Inserted 9 runs, reloaded: 0 runs, no prompt. No `beforeunload`, no `useBlocker`, no autosave anywhere in `web/src` |
| **No arrow-key nudge.** | Arrow, Shift+arrow and Alt+arrow left the selected run unchanged |
| **No copy, paste or duplicate.** | Ctrl and Cmd +C/+V/+D left the run count at 9; no clipboard code exists |
| **Inch projects still take millimetres.** | `parseLengthToMM` accepts `4' 6"` and `48 1/2`, but nothing calls it yet and `NumericField` is a number input. This was deliberate sequencing: row 130 shipped readouts first and left inputs for later |
| **Undo can skip a state.** | `editDoc` merges any edits within 500 ms into one step, even unrelated ones. Commit text to reach 15 runs, delete within 500 ms, undo: it lands on 9, and the 15-run state is unreachable. Reproduced on `main`; found while testing row 102 |
| **The side panel is wider than its column.** | At 1600 px the "Block out crossings" button and the span field are clipped; a scroll into view slid the whole panel sideways |

Two ledger corrections follow from this:

- **#109 Auto Save** is ✅ in Appendix A, but it means "each manual save writes a
  version". It should be 🟡 until there is real autosave.
- **#21/#34/#51 Streamlined UI** is 🚫 as "modern web stack". NeonWizard's row is
  about property bars replacing dialogs that cover the work, which is the gap
  described above, so a modern stack does not answer it. It should be reopened.

## Licensing: take the ideas, not the code

NeonBench has no LICENSE file, so although the repository is public it is all
rights reserved, and it ships as signed binaries.

| Project | Licence seen in the tree |
|---|---|
| Inkscape | GPL-2.0-or-later (e.g. `src/auto-save.cpp`, `src/ui/dialog/command-palette.cpp`); LGPL-3.0-or-later on `src/util/expression-evaluator.cpp` |
| GIMP | GPL-3.0 for the application; LGPL-3.0-or-later for `libgimpwidgets/gimpeevl.c` |
| Krita | Per-file SPDX: GPL-2.0-or-later on `libs/widgetutils/kis_num_parser.cpp`; LGPL-2.0-only on `libs/ui/kis_popup_palette.cpp` |

**Decision: copy no code, and do not translate it line by line.** A port of GPL
code into TypeScript would very likely make NeonBench a derivative work. Little
is lost, because these are C/C++ desktop apps on GTK and Qt, so nothing would
drop into a React and SVG editor anyway. Behaviour, shortcut conventions and
interaction patterns are free to reuse; write each implementation fresh. If
NeonBench is ever open-sourced under the GPL, this changes.

## Proposed work, in order

Effort: S is a day or less, M is a few days, L is a week or more.

### Round 1: stop losing work, fix the basics

Shipped 2026-11-02 in PRs #206 to #209. See `todo.md` Appendix B for what each one did.

| # | Change | Idea source | Effort |
|---|---|---|---|
| 1 (row 149) | **Warn before leaving** with unsaved edits, and **keep a local draft** with a restore prompt on reopen. Save the draft to `localStorage` on a debounce, never as a design version | Krita `libs/ui/KisAutoSaveRecoveryDialog.cpp`; Inkscape `src/auto-save.cpp` | S |
| 2 (row 102) | **Hotkey registry.** Build the existing spec, `specs/active/tier3-102-hotkeys-and-help.md`: one registry, a `?` reference, remapping and tooltips. Add single-letter tool keys on top. Do this first, because 3, 4, 7 and 10 all build on it | Inkscape `share/keys/*.xml` (includes CorelDRAW and Illustrator maps); Krita `krita/data/shortcuts/*.shortcuts`, `libs/widgetutils/kis_action_registry.cpp` | M |
| 3 (row 150) | **Arrow nudge**, Shift for ×10, with the step shown in display units | Inkscape `src/ui/tools/select-tool.cpp` (`nudgedistance`); GIMP `app/tools/gimpeditselectiontool.c` | S |
| 4 (row 151) | **Copy, paste, duplicate, paste in place** | Inkscape `share/keys/inkscape.xml` (`app.duplicate`, `win.paste-in-place`) | S–M |
| 5 (row 152) | **`LengthField`** wired to `parseLengthToMM` for every length input. Adding simple sums (`48 1/2 + 3`) later is a small step | Behaviour of GIMP `libgimpwidgets/gimpeevl.c`, Krita `libs/widgetutils/kis_num_parser.cpp` | S–M |

Items 3 and 4 must follow the rules in `CLAUDE.md`: new ids from `nextRunId`,
classification carried, and `raceway_id` dropped on copies as step-and-repeat
already does.

### Round 2: the NeonWizard feel

| # | Change | Idea source | Effort |
|---|---|---|---|
| 6 (row 153) | **Canvas-first layout.** Left tool rail with flyouts, one context property bar replacing the status rows, tabbed right panel, and a key to hide all panels. Fixes the panel overflow. Solo PR: it touches `EditorPage.tsx`, the highest-conflict file | NeonWizard layout; Inkscape `win.dialog-toggle` (F12); GIMP Hide Docks; Krita `libs/ui/input/KisCanvasOnlyAction.cpp` | L |
| 7 (row 154) | **Tube menu anywhere on the tube**, in Select as well as Node edit, acting at the clicked point, with a letter key per item. Extends `web/src/lib/nodeMenuItems.ts`. Use NeonWizard's letters where they fit, so its users feel at home | NeonWizard pop-up; Inkscape `src/ui/tool/curve-drag-point.cpp` for drag-a-segment to bow an arc | M |
| 8 (row 155) | **Always-on neon readout:** Total, Tube, Object, Size, plus selected segment radius and length | NeonWizard property bar | M |
| 9 (row 156) | **True-width tube view** on a toggle, with the glass past max length drawn as a bare centreline | NeonWizard F3 and max-length display; Inkscape outline modes | S–M |

### Round 3: power features

| # | Change | Idea source | Effort |
|---|---|---|---|
| 10 (row 157) | **Command search.** Type a few letters to find any action | GIMP `app/dialogs/action-search-dialog.c` (bound to `/`); Inkscape `src/ui/dialog/command-palette.cpp` | S after #2 |
| 11 (row 158) | **Keymap presets**, e.g. a NeonWizard-style set. Remapping itself ships with row 102 | Krita `krita/data/shortcuts/*.shortcuts`; Inkscape `share/keys/*.xml` | S |
| 12 (row 159) | **Anchor-point numeric transform:** nine-box reference with X, Y, W, H, rotation | NeonWizard 6.5 Anchor Points | M |
| 13 (row 160) | **Named undo list** and **snap labels** saying what was snapped to | GIMP `app/widgets/gimpundoeditor.c`, Inkscape `src/ui/dialog/undo-history.cpp`; Inkscape `src/display/control/snap-indicator.cpp` | M |
| 14 (row 161) | **Non-destructive Neonize / Auto Tube Layout.** Keep the source outline and parameters, edit them on the property bar with a live preview. Needs a schema decision, and would also answer row 113 (re-editable text) | Inkscape `src/live_effects/lpe-offset.cpp`, `lpe-parallel.cpp`; GIMP `gimp_drawable_filter_set_preview_split` | L |

## What not to change

- **Sticky tools for repeated marks.** Arm Mark support and click eight times is
  as good as or better than a menu per mark. The tube menu adds to this; it does
  not replace it.
- **Live validation, the 3D preview, the estimate, version history and
  cross-platform builds.** None of these depends on NeonWizard catching up.
- **The per-tool hint bar** at the bottom of the canvas. This is already
  NeonBench's version of NeonWizard's Help Bar. It only needs to survive the
  layout change.
- **A radial pop-up like Krita's.** It suits painting with a stylus. Neon
  operators want a list with letter keys, which is what they already know.

## When the demo arrives

Time the same five jobs in both apps and count clicks, then re-rank this list:

1. Type a word, set letter height in inches, centre it on a 4 ft panel.
2. Add electrodes and doublebacks to every tube.
3. Break a tube at max length, move an opening, add three supports.
4. Connect two letters and black out the jumper.
5. Run Auto Tube Layout on a channel letter along a raceway, then print.

Also check what this review could not: drawing speed on a large job, whether
NeonWizard's keys work without first selecting a mode, and how its bezier
editing compares. Read the demo's licence before running it, in case it limits
competitive evaluation.
