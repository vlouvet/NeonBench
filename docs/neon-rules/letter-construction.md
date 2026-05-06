# Letter construction conventions

The Blazek alphabet books (Books 1, 2, 3) are the source for everything in this file. The intro is identical across all three books; per-letter pages differ.

## Single Tube vs Double Tube

**Every letter in Blazek's books is shown in two layouts** side by side:

- **SINGLE TUBE** ("single stroke"): the letter outline traced as one continuous tube path, with bends numbered 1, 2, 3 … in the order the bender works them.
- **DOUBLE TUBE** ("double stroke" / "powdered unit"): the letter built as two parallel tubes following the inside and outside of a thick stroke. Used for bolder, brighter letters with a wider apparent stroke. Often used with phosphor-coated ("powdered") tubes.

Implication for the tool: a vectorized bitmap will usually correspond to **either** the single-stroke or the double-stroke layout. We need a mode/parameter for which.

## Bend numbering & sequence

Each Blazek letter shows the bender's working sequence as numbers in small circles:

- Bend 1 is the first bend made (typically near one electrode end).
- Subsequent bends are made one at a time, each one re-heated on the gas-fired ribbon burner *(Saving Neon, p. 19: "all in about five seconds")*.
- The numbered sequence ends at the other electrode.

Each numbered bend is annotated with its **type** — see `glossary.md` for the full vocabulary (DB, RISE TURN, DROP TURN, RISE, DROP, CLOSE, REHEAT & CLOSE, YIELD, RIBBON HEAT, CORRECTION BEND, etc.).

Implication for the tool: if we ever want to generate a working pattern (not just validate a vector), we need to emit a bend sequence in this order. For now, validation only needs the *geometry*, not the order.

## Splitting tall/large letters

> "When making large letters, it is much wiser to cut the letters in half than to attempt to make them in one unit. They are easier to bend, pump, install and service this way, and, if a large double stroke powdered unit should break, it will not have to be completely remade."
> — *Blazek Book 1 introduction (identical in Books 2 & 3)*

This is the only **size-based construction rule** in any of the four PDFs. It does not state a numeric threshold. It implies:

- Above some size, a single letter becomes one **multi-segment unit** joined by welds. See the letter "H" in Book 1: a "WELD" annotation is shown on the crossbar between the two halves of the H.
- Each segment then has its own electrode pair (or shares electrodes via a series weld — see `electrodes.md`).
- Repair-friendliness is the dominant concern: a broken half can be rebuilt without remaking the whole letter.

## Stroke width

The four PDFs do not state stroke-width-as-fraction-of-cap-height ratios. Blazek's letter pages are unscaled patterns — they show topology and bend sequence but not absolute dimensions. Stroke-width-to-height is a **design** decision that determines whether the letter is built single-tube or double-tube, and how wide the double-tube tracks sit, but no rule is given.

## Counter widths (interior whitespace)

Not addressed in any of the four PDFs. The interior of an "O" or "P" is governed by minimum bend radius (see `bend-radius.md`) and by the parallel-tube spacing if doubled (see `spacing.md`).

## Electrode placement on letter pages

The diamond ♦ symbol in Blazek's letter drawings marks "where to house electrode centers" — *Blazek intro*. Placement is flexible: top, bottom, or middle of the letter, depending on installation. See `electrodes.md`.

## Double-back as a structural element

Most Blazek letters use one or more **double-backs (DB)** as part of the path. Examples on the letter pages:

- "A" single tube: DB across the crossbar (bend 1 to bend 2).
- "B" single tube: two DBs, one for each lobe.
- "E" single tube: 90°, then DB, then a series of rises and drops.
- "Z" single tube: starts with two 50° bends.

The DB is **not** a tight-radius error condition; it is a primary construction technique. **Validation must treat 180° hairpin geometries as legitimate**, not as bend-radius failures. See `bend-radius.md`.

## Window-sign vs cabinet-sign electrode layouts

> "The double-backing of the electrodes on the pattern are for window sign layout."
> — *Blazek intro*

For window signs (typically viewed from one side, mounted to a glass storefront), both electrode legs run back to the same side of the letter so all wiring is hidden behind a single edge. For a cabinet sign with a back face, electrodes can exit straight through the back at each end of the path. Our tool may need to be told which mode to validate against.

## Implication for validation

| Concept | Validate? | How |
|---|---|---|
| Single vs double tube | mode/parameter input | user picks before vectorize |
| Bend sequence | ignore for now | future, for pattern generation |
| Splitting tall letters | suggest, not enforce | warn above some height; surface "WELD" suggestion |
| Stroke width as fraction of height | not validated | no source rule |
| Double-back as legitimate construction | exempt from bend-radius failure | required to reduce false positives |
| Window-sign electrode mode | mode/parameter input | affects electrode-end-of-path validation |
