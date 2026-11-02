# Tier 3 #153 — Canvas-first editor layout

> **Status:** proposed · spec for review, nothing built · branches `task/153a-…`, `task/153b-…`, `task/153c-…`

## Goal

Make the canvas the page. Today 29 labelled buttons sit in rows above it, so at
1280×800 it gets 39% of the window, starts 368 px down, and the page scrolls.
This is the largest gap between NeonBench and NeonWizard, and it closes NW #51
Streamlined UI.

Done means all of these, measured in a real build at 1280×800:

| Measure | Today | Target |
|---|---|---|
| Canvas share of the window, panels showing | 39% | at least 60% |
| Canvas share, panels hidden | n/a | at least 85% |
| Canvas top edge | 368 px | at most 100 px |
| Page scrolls | Yes, 848 px tall | No |

70% with panels showing is not reachable with these bars: a 44 px rail, a 300 px
panel and two 42 px bars leave 65%, before the app header.

## Layout

```
+----------------------------------------------------------------+
| ← Project  Label [Save]  Undo Redo  Insert▾ Output▾  Spec Units ✓ |  top bar
+----------------------------------------------------------------+
| context bar: options for the current tool or selection   Snap   |
+----+---------------------------------------------+-------------+
| ▣  |                                             | Properties  |
| ⌖  |                                             | Objects     |
| ✎  |                 canvas                      | Issues (3)  |
| ▭▸ |                                             |             |
| T▸ |                                             |  tab body   |
| ⚡ |                                             |             |
+----+---------------------------------------------+-------------+
```

**Top bar.** Back link, version label, Save, Undo, Redo, an Insert menu, an
Output menu, tube spec, units, the validation badge and the `?` button. Insert
holds the actions that are not tools: Hershey text, OpenType text and the
channel-letter wizard. Output holds Print, the print options and Quick plot.

**Tool rail.** Ten slots, so it fits 800 px with no scrolling:

| Slot | Tools |
|---|---|
| Select | Select `V` |
| Node | Node edit `N` |
| Opening | Break / move opening `O` |
| Pen | Pen `P` |
| Shape ▸ | Rectangle `R`, Circle `Shift+R`, Arc `A` |
| Type ▸ | Text `T`, Label `L` |
| Dimension | Dimension `M` |
| Electrode | Place electrode `E` |
| Marks ▸ | Blockout `B`, Jump `U`, Drop `Shift+U`, Support `S`, Double-back `D`, Insert double-back `I`, Bend `G` |
| Connect | Connect tubes `C` |

A flyout slot shows its last-used tool. Clicking it picks that tool, and the
corner arrow or a long press opens the flyout. Hotkeys are unchanged and reach
every tool directly. Tooltips keep using `tip(id, text)`, so they show remapped
keys.

**Context bar.** One row, replacing the status rows. Text tool: cap height, font.
Pen and shapes: nothing yet. Selection: size and run count. Snap, the grid
step and rulers stay at the right end. Row 155's readout lands here later, so leave it room.

**Messages.** The draft offer, the error banner and the status message overlay
the top of the canvas, so they never move it.

**Right panel.** Three tabs, keeping the existing resizer and
`nb.editorSidebarWidth`:

- **Properties:** the selected run, Arrange, Join tubes, Merge outlines, and raceway fields.
- **Objects:** Layers, Circuits, Runs, Dimensions.
- **Issues:** the validation list, with a count on the tab.

The tab persists in `nb.editorPanelTab`. Selecting something never switches tabs.
Clicking the validation badge opens Issues.

**Hide panels.** New hotkey `view.togglePanels`, default `Mod+\`, in the remap
list. It hides the rail, context bar and right panel, and persists in
`nb.editorPanelsHidden`. Tool hotkeys keep working while hidden. Tab breaks
keyboard focus and F12 opens devtools, so neither is the default.

## Phases

Each phase is one PR and leaves the editor fully working. No other PR that
touches `EditorPage.tsx` should be open during a phase.

1. **153a, shell and rail:** full-bleed editor, top bar, tool rail with flyouts, Insert and Output menus.
2. **153b, context bar:** tool options move out of the toolbar, and messages overlay the canvas.
3. **153c, tabs:** right panel tabs, hide-panels key, overflow fix. Closes the row.

## File scope

**New:** `web/src/components/ToolRail.tsx`, `web/src/components/ContextBar.tsx`,
`web/src/lib/toolRail.ts` for the slot table, plus their tests.

**Modify:** `web/src/pages/EditorPage.tsx`, `web/src/App.css`,
`web/src/lib/hotkeys.ts`, `docs/USER_MANUAL.md`.

**Don't touch:** `EditorCanvas.tsx` beyond what a resize needs, the doc ops, or
anything server-side.

## Constraints

- No new dependencies. Icons are hand-written inline SVG.
- No schema or API change.
- Every tool and action stays reachable. Nothing is removed in this row.
- `applyOp`, `runHotkey` and the hotkey guards stay as they are.

## Traps

- **Tabs must hide, not unmount.** `ArrangePanel` and others hold input state, so
  a switch must use `hidden`. Otherwise a half-typed value disappears.
- **Canvas size.** It must refit when panels hide or the sidebar resizes. Check
  with a drag and a node click after toggling, not only a screenshot.
- **Flyouts use `role="menu"`.** `matchHotkey` treats that as an open overlay, so
  hotkeys pause while one is open. That is wanted. Esc must close it first.
- **Print CSS** names `.editor-toolbar` and `.editor-sidebar`. Update the list, or
  the new bars print on a direct page print.
- **Below 800 px** the sidebar stacks over the canvas today. Keep that working
  and put the rail along the top there.
- **Overflow.** At 1600 px the panel clips "Block out crossings". Give the panel
  `min-width: 0` and wrap its controls rather than hiding the overflow.

## Tests

- `toolRail.test.ts`: every tool in `HOTKEYS` appears in exactly one slot, so a new tool cannot go missing.
- `renderToStaticMarkup` on the rail: tool buttons carry their tooltip and active state.
- Browser, each phase: the targets table at 1280×800 and 1920×1080, every tool by click and by key, draw and save a run, read it back from the API.
- Browser, 153c: panel `scrollWidth` is at most `clientWidth` at 1600 px, and an Arrange value survives a tab switch.
- Negative control: delete a tool from the slot table and watch the test fail.

## Decisions for review

1. **Icons:** hand-written SVG, which is about 20 glyphs of work. The alternative is `lucide-react`, which is the boring dependency choice but has no neon-specific marks.
2. **Hide key:** `Mod+\`.
3. **Target:** 60% with panels showing. Going higher means a narrower default panel than today's 340 px, which is already reduced to 300 here.
