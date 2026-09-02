 # Making NeonBench carry the proof workflow

Written 2026-09-02 after producing a customer sign-off proof for a real job —
Chachi's Italian-American, exposed channel letters, single-tube classic red on
a raceway — end to end. NeonBench did the part it was built for. This is a list
of what it could not do, ranked by how much work it pushed outside the tool.

**The test used throughout:** *how much of the pipeline had to live somewhere
else, and why?* Every item below is something that ran in
`/Users/v/code/neonbench-proofs` and arguably should not have.

**Backlog rows.** Every item below now has one, filed 2026-09-02 as rows
131-141 in [`todo.md`](../todo.md) Appendix B. The mapping:

| Item | Row | Tier |
|---|---|---|
| A1 proof sheet | #126 | 3 |
| A2 curves not polylines | #133 | 2 |
| A3 join along artwork | #134 | 2 |
| A4 block-outs from crossings | #135 | 2 |
| A5 headless render | #137 | 3 |
| B1 bend-radius validity | #131 | 1 |
| B2 circuits, not runs | #136 | 2 |
| B3 raceway in the preview | #138 | 3 |
| B4 exposed-letter render | #139 | 3 |
| C1 vectorize source frame | #132 | 1 |
| C2 schema discoverability | #140 | 3 |
| C3 side-section detail | #141 | 3 |

> **Corrected 2026-09-02.** This section first cited #127 for bend-radius
> validity and #128 for the raceway preview. Both numbers were already taken —
> they are the Artech Neon demo rows shipped the same day in PRs #191 and #192
> (Break/Open on a coincident-endpoint loop, and welding touching runs). The
> rows above are the real ones. #126 is the only pre-existing row here.

---

## Where the work actually happened

| Step | Ran in | Why not NeonBench |
|---|---|---|
| Letterform outlines | flexi-mcp | fine — Flexi is where the artwork lives |
| Raster → tube centerline | **NeonBench** | ✅ works, and works well |
| Trade validation | **NeonBench** | ✅ found the raceway/transformer conflict |
| Takeoff quantities | **NeonBench** | ✅ real numbers, no hand-counting |
| Centerline → smooth curves | outside | NeonBench emits polylines only |
| Fragments → continuous runs | outside | splits at junctions, never rejoins |
| Block-out placement | outside | knows where crossings are, won't act on it |
| Pan + tube composite | outside | preview draws glass, not pans |
| Proof sheet | outside | no such export |
| ISO render capture | outside (Playwright) | no headless render entry point |

Six of ten steps outside. Most of them are small, and several are small
*because* NeonBench already computed the hard part and then declined to use it.

---

## Tier A — each of these deletes a script

### A1. Proof sheet as an export

Already filed as **#126**; restating here because everything else on this list
is in service of it. A customer-facing sheet — hero render, overall dimensions,
specification block, notes, signature box — has no generator, so the dimensions
and gas/diameter callouts get retyped from the design instead of derived from
it, and nothing stops them drifting from the doc they claim to describe.

Everything it needs already exists: `internal/takeoff` has the quantities,
`handleEstimate` the priced roll-up, `captureCanvasToPNG` the bloom-correct
render, the doc's own bbox the overall size.

Shape: `GET /api/projects/{id}/design_versions/{vid}/proof.pdf` (+ `.png`),
rendered from the same `Doc` the pattern is, so an approved proof and the
pattern that fabricates it are provably the same version.

**Carry over the `TBD` discipline from the prototype.** Any value nobody
supplied renders as a visible placeholder rather than being guessed or quietly
omitted. A customer signature against an invented dimension is worse than an
obviously blank one.

### A2. Emit centerlines as curves, not polylines

`vectorize` returns pure polylines — measured on this job: **2115 `L` commands,
zero curve segments**. Correct for a bend list. Wrong for any picture: at proof
scale every vertex reads as a facet on the glass, and the sign looks faceted in
a way a customer will reject.

The obvious workaround is wrong. Raising `smoothing_mm` until the faceting
disappears also walks the centerline off the letterform it is supposed to run
down — you trade a visible defect for an invisible one.

What worked outside: fitting **centripetal** Catmull-Rom cubics (α=0.5).
Centripetal specifically — uniform Catmull-Rom overshoots into a cusp wherever
two samples sit close together, which is exactly what happens at the tight
turns in a script.

Suggested: a `curves=true` option on vectorize, or a `smoothed.svg` export
alongside the existing one. Keep the polyline as the source of truth for
bending; this is a rendering concern.

### A3. Join fragments back into runs — along the artwork

NeonBench splits a run at every junction. A connected script comes back as ~50
fragments meeting in V-shaped wedges. Nothing rejoins them, and nothing else
removes the wedges either:

- `min_spur_mm` swept 60 → 160 mm: run count moved 51 → 47, **every wedge still
  there**. They are junctions, not dead-end stubs.
- A within-polyline de-spike removed **nothing** — the V is formed by two
  *different* runs' ends diving into the same notch.
- Trimming the ends apart cleared the wedges and left ~50 mm gaps; the script
  read as broken glass.

Joining is what works, and it is closer to the trade: a bender runs one tube
through as much of a script as possible and splices only where necessary.

**The constraint is the whole feature.** A naive greedy join gets better on
every metric by cheating:

| near | min_cos | runs | glass | transformers | raceway |
|---|---|---|---|---|---|
| 35 mm | -0.2 | 15 | 80 ft | 15 | does not fit |
| 90 mm | -0.9 | 9 | 60 ft | 9 | **fits** |
| 120 mm | -0.95 | 6 | 50 ft | 6 | **fits** |

Every number improves because the runs got longer, and they got longer by
letting the tube **leave the letters and cut diagonally across blank sign
face**. Rendering the runs in per-run colours is what exposed it; no metric in
the table would have. With an on-artwork constraint the same sweep tops out at
12–14 runs and the raceway still does not fit — which is the honest answer.

So: a join op should refuse any hop whose path leaves the artwork, and should
say how many hops it refused. And it should be an **operator action in the
editor**, not an automatic pass — see B2.

### A4. Place block-outs from the crossing check

The validator already locates every place two tubes cross shallowly enough to
need paint (`crossing_needs_blockout`, with `x_mm`/`y_mm`). Turning that into
`Run.Blockouts` is mechanical and currently manual.

Two tuning facts worth baking into whatever ships, both learned by rendering
the wrong version first:

- **Only `crossing_needs_blockout`.** Including `min_spacing` seems reasonable —
  same geometric check, one severity up — but on a script it fires wherever two
  tubes run near-parallel, which is most of the piece. Painting those out
  swallowed whole strokes and the word stopped reading.
- **~2 tube diameters per span.** 90 mm severed the letterforms; 30 mm kills the
  bright X at a crossing while the letter still reads through it.

### A5. A headless render entry point

Producing the ISO view meant driving the browser UI with Playwright: navigate,
wait for the canvas, toggle the wall, click the preset, click Save PNG, catch
the download. That is a lot of moving parts for "render this version".

Wanted: `neonbench render --project 18 --version 62 --preset iso --wall steel
--out iso.png`, or a `GET .../preview.png?preset=iso` endpoint.

One detail to preserve: the app's **Save PNG** path calls `composer.render()`
before `toDataURL`, so bloom lands in the file. A naive page screenshot can come
back without the post-process pass. Whatever ships headless must take the
composer path, not the bare renderer — this is the same trap Tier 1 #68 fixed
once already.

---

## Tier B — correctness, not convenience

### B1. `min_bend_radius` is measuring the wrong thing

Filed as **#131**. Summarised because it is the one number on this job that
looked authoritative and was not: holding smoothing at 6 mm the error count
across 8/10/12/15 mm tube is **41/40/40/41** (flat, while the limit nearly
doubles); holding tube at 15 mm and sweeping smoothing 0.5 → 30 mm moves it
**86 → 23**. It tracks an input-preparation knob, not the glass.

Until it is resolved the count is not quotable to a customer, which makes a
validation report harder to hand over than it should be.

### B2. Transformers should hang off circuits, not runs

The takeoff derives one electrode pair — and therefore one transformer — per
run. On this job that produced **17 transformers needing 3135 mm laid along a
2170 mm raceway**, and `raceway_transformer_fit` correctly refused it.

But 17 is not a fabrication decision, it is an artifact of how the medial axis
happened to fragment. Every downstream number inherits it: electrode count,
boots and endcaps, gas fills, glass yield (**90 ft gross for 26 ft net**, 18
sticks at 5 ft with 305 mm waste each), and fabrication hours.

A `Circuit` grouping — several runs, one electrode pair, one transformer —
would let a shop model what they will actually build and would make the
raceway-fit and yield numbers mean something. Today the only way to get a
sensible transformer count is to get the run count right first, which needs A3
plus human judgement.

### B3. The 3D preview does not draw raceways

Filed as **#138**. `Doc.Raceways` is real data and the PDF uses it, but
`grep -ri raceway web/src/preview/` is empty. The ISO view — the one angle
where the box matters, and the one `PRESETS` calls the "marketing-render
angle" — shows glass floating in front of a grey plane.

### B4. Exposed letters have no render

The preview draws tubes. For a **face-lit** letter that is right. For an
**exposed** letter the pan is unlit metal and the tube is the only thing that
emits, so a render that paints the letterform as the light source is showing a
different product. Compositing pan and glass as separate objects had to happen
outside.

`Run.IsChannelLetterFace` already marks a face run; the preview could draw
those as unlit extruded pans and let the tube runs glow inside them.

---

## Tier C — friction and traps

### C1. Vectorize should return the frame it used

`target_width_mm` maps the **raster** to that width. If the raster was rendered
with padding — and it must be, or the trace clips — then passing the artwork
width instead of the padded width scales every returned coordinate by the
padding ratio. On this job that was 0.986, enough to walk the tube visibly off
the letterforms.

Worse, the obvious repair is also wrong: fitting the returned centerline's bbox
onto the artwork's bbox **overshoots**, because a skeleton's bbox is inset from
its outline's by about half a stroke width. It looks plausible and is wrong
everywhere the strokes are thick.

Returning the source frame — origin and scale, or the affine — in the vectorize
response makes registration exact and removes both traps.

### C2. Schema relationships need to be discoverable from the API

Two stumbles, both only solvable by reading Go source:

- A `Raceway`'s ID must match an existing `"raceway"` **Guideline**; it is not a
  separate id space. Documented thoroughly in `types.go`, invisible from the
  API. The failure is `UnmarshalJSON` rejecting the doc.
- `DisallowUnknownFields` plus a stale binary gives
  `unknown field "raceways"` — which reads as "bad request" and actually means
  "your binary predates PR #165". A version or capabilities endpoint listing the
  doc schema version would turn a confusing 400 into an obvious one.

### C3. Section detail from doc data

`channel_letter_depth_mm`, the raceway's `height_mm`/`depth_mm`, and the tube
diameter are all in the doc — enough to draw the side section that answers "how
does this attach to the building", which is the question a GC asks first. Drawn
by hand in the prototype.

---

## What NeonBench got right, and should not lose

Worth recording, because the list above is all complaints:

- **The centerline extraction is excellent.** Fed a clean 0.24 mm/px raster it
  followed every stroke of a connected script faithfully.
- **`raceway_transformer_fit` caught a real conflict** nobody would have noticed
  until parts were on a bench, and its message carried the arithmetic.
- **`splice_recommended` cited Miller (1935 p.125)** rather than asserting a
  rule — that citation is what makes it arguable with a customer.
- **The takeoff is money-free and pure.** Asking "how much glass" without
  filling in a rate card is exactly right, and it is why the materials panel
  could be populated at all.
