# Letter construction conventions

The Blazek alphabet books (Books 1, 2, 3) are the source for everything in this file. The intro is identical across all three books; per-letter pages differ. Miller (1935) Ch. VII "Glass Bending" pp. 106–133 gives the operator's perspective and adds quantitative details where Blazek shows only topology.

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

Miller corroborates this sequencing convention:

> "In complicated letters like E, F, H, and so on, the **middle double-back of each is made first**, since this is by far the easiest way of doing the job. The bends on either side of the middle bend are then performed until the letter is complete." *(Miller, Ch. VII, p. 125)*

> "**The turn-up angle bend is not made, however, until all the letters have been formed.**" *(Miller, p. 124)* — i.e. the lead-in (electrode-end) 90° bend is **always last**.

So the canonical sequence is: middle DBs first → outward to letter ends → lead-in 90° turn-up at the very end.

Each numbered bend is annotated with its **type** — see `glossary.md` for the full vocabulary (DB, RISE TURN, DROP TURN, RISE, DROP, CLOSE, REHEAT & CLOSE, YIELD, RIBBON HEAT, CORRECTION BEND, etc.).

Implication for the tool: if we ever want to generate a working pattern (not just validate a vector), we need to emit a bend sequence in this order. For now, validation only needs the *geometry*, not the order.

## Splitting tall/large letters

> "When making large letters, it is much wiser to cut the letters in half than to attempt to make them in one unit. They are easier to bend, pump, install and service this way, and, if a large double stroke powdered unit should break, it will not have to be completely remade."
> — *Blazek Book 1 introduction (identical in Books 2 & 3)*

Miller gives the **size threshold**:

> "**For letters of 12 inches in height or larger**, one or more 46-inch lengths of tube must be used for each letter, and splices must often be made in the middle of the letter. For smaller letters, often two or three letters may be made from one length of tube, the splices being made between letters where the painted-out portion appears." *(Miller, p. 125)*

So the trade rule is:

- **Cap height ≤ 12 in (305 mm):** typically multiple letters fit in a single 46-in (1,168 mm) glass blank. Splices between letters are hidden by blockout paint.
- **Cap height > 12 in (305 mm):** at least one splice required *inside* the letter, ideally at a discrete location like a crossbar (Blazek's "WELD" annotation on letter "H").
- The blank length is **46 inches** = **1,168 mm** *(Miller, p. 58, p. 115)*. Reserving 6 in (152 mm) for handling at each end leaves **34 in (864 mm)** of usable letter perimeter per blank.

Miller's worked **letter-O recipe (18 in / 457 mm diameter)** *(Miller, p. 118)* uses **two 46-in blanks** spliced together via two double-backs at the bottom — the canonical example of how a tall letter is built from multiple blanks.

## Stroke width

The four PDFs do not state stroke-width-as-fraction-of-cap-height ratios. Blazek's letter pages are unscaled patterns — they show topology and bend sequence but not absolute dimensions. Miller is also silent on stroke-width-to-height ratios as a design rule.

**Strattman (1997) is also silent.** *(NT Ch.5 "The Type of Sign")* discusses the categories of letter forms — flat painted, raised, channel, raised-channel, cut-out — and the categories of letter forms — block, outline, double, script — but **never states a numeric stroke-width-to-cap-height ratio**. Strattman's "Letter types" section *(NT Ch.5)* shows photographs and named categories only:

> "Various glass letter forms: (a) script-type letters, (b) standard block letters, (c) outline letters, (d) double-tubing letters." *(NT Fig. 5.10 caption)*

> "The simplest type of letter background is the flat letter shown in Figure 5.10 (a). This is simply a letter of the metal box immediately behind the tubing. ... The raised letter, shown in Figure 5.10 (b), is a simple metal letter raised above the surface of the metal box immediately behind the tubing. ... The channel letter, in either Figure 5.10 (c), (d), or (e), is a raised letter usually but not always made of metal. The desired angle of visibility ... If a sharp-angled visibility is desired, the channel must be relatively shallow." *(NT Ch.5)*

So Strattman, like Miller, treats stroke width as an **artistic / readability decision** governed by viewing distance and channel-depth requirements, not a validatable parameter. Confirms the missing-rules entry.

Miller does give a **footage-vs-height estimator** *(Fig. 38, p. 101)*: "20 letters, 5 inches high, require nearly 27 feet of tubing." That's ≈ **1.35 ft (411 mm) of tube per 5-in (127 mm) letter**, i.e. tube length ≈ **3.2 × cap height** for a typical sans-serif letter at average stroke complexity. This is an estimating heuristic, not a validation rule.

## Counter widths (interior whitespace)

Not addressed in any of the four PDFs or in Miller. The interior of an "O" or "P" is governed by minimum bend radius (see `bend-radius.md`) and by the parallel-tube spacing if doubled (see `spacing.md`).

Miller's worked example: the **18-in (457 mm) diameter O** is built with the inside curve matching a 12-in (305 mm) chord and 18-in (457 mm) overall arc *(Miller, p. 118)* — implying the counter is roughly 12 in (305 mm) inner-bore for that example. Cannot generalize.

## Electrode placement on letter pages

The diamond ♦ symbol in Blazek's letter drawings marks "where to house electrode centers" — *Blazek intro*. Placement is flexible: top, bottom, or middle of the letter, depending on installation. See `electrodes.md`.

Miller (p. 124) constrains the lead-in geometry: there must be a straight 50–254 mm "turn-up" segment at each electrode, terminating with a 90° bend joining it to the first decorative bend.

## Double-back as a structural element

Most Blazek letters use one or more **double-backs (DB)** as part of the path. Examples on the letter pages:

- "A" single tube: DB across the crossbar (bend 1 to bend 2).
- "B" single tube: two DBs, one for each lobe.
- "E" single tube: 90°, then DB, then a series of rises and drops.
- "Z" single tube: starts with two 50° bends.

Miller corroborates and adds the bender's perspective:

> "For such letters as R, E, F, G, the tube must be bent back upon itself, as shown in Fig. 49-A. Such bends are known as double-backs. They are made in the cross fires, in somewhat the same fashion as the angle bend. **A longer length of tube is heated, about 1 inch**, and more glass is gathered together. When the glass is glowing red, the tube is bent sharply back on itself…" *(Miller, p. 119–120)*

So a double-back consumes about **1 inch (25 mm)** of heated glass — this is the absolute minimum *bend-region length*, not the inside clearance of the U.

> "When the bend back occurs at right angles to the face of the sign, as it does in almost every case, care should be taken to see that the rear part of the bend lies directly behind the front part; **otherwise, the bend back will appear thicker than the rest of the tube, when the sign is lighted.**" *(Miller, p. 120)*

So the two legs of a DB must be **stacked in the z-axis** (front leg / back leg), not offset in-plane. This is a 3D geometry rule that 2D Blazek patterns hide.

The DB is **not** a tight-radius error condition; it is a primary construction technique. **Validation must treat 180° hairpin geometries as legitimate**, not as bend-radius failures. See `bend-radius.md`.

## Combination Bend (Miller)

> "**Combination Bends.** The type of bend [Fig. 49-C] must be used in many cases, particularly in connection with the angle bend. This bend, sometimes called the **combination bend**, is in reality two bends close together. **Its main purpose is to bring the rear piece of glass in a bend-back flush with the face of the sign and at the same time to make the required angle.**" *(Miller, p. 120)*

A combination bend is a 3D operation: it converts a stacked-in-z double-back into a same-plane continuation. Blazek doesn't name this; Miller does. Useful for our glossary.

**Strattman (1997) confirms and elaborates the combination bend** *(NT Ch.7 "Glass Bending", "Combination bend")*:

> "A combination bend involves two bends made at the same time from one heating in the fire. Many different types of combination bends can be made, depending upon the layout of the glasswork and upon the capability of the glassblower. However, there are a few fundamental combination bends which, if thoroughly understood, will act as a basis from which all the more complicated bends can be achieved.
>
> The straight-drop combination bend, also known as the lift or drop bend, is one in which two right angle bends are made at the same time in a straight line. The drop is marked off at a 1-1/2 times the diameter of the tubing. ... When making a long flowing curve and using the various pictures of the letter A drop and 'C' shapes pictured to the same time. ...
>
> Another form of combination is when a fairly complicated double-outline letter S is made from a single piece of glass. The various stages of bending are indicated in Figure 7.24. The first and most important operation is to make the inside circular bend of the letter S as shown in Figure 7.24 (b). Careful study of the bending layout before actual bending should be done when making a single piece..." *(NT Ch.7)*

Strattman's **figure 7.24 ("Double drop bends with uniform thickness and incorrect bends")** is the modern equivalent of Miller's Fig. 49 and shows the geometry of (a) drop bend, (b) lift bend, (c) angle bend with twist, (d) twist-inwardly-90° composite — modern names for Miller's 1935 vocabulary, no supersession of geometry. **Strattman adds: the drop offset for a "straight-drop combination bend" is 1.5× the tube diameter.** *(NT Ch.7)* — first numeric spec we have for double-back / Z-offset depth.

### Double-back wall thickness diagnosis (Strattman Fig. 7.24)

Strattman's "**correct wall / too heavy / too thin**" panel is the canonical visual diagnostic for double-back quality. The bender judges the bend by the **outside-wall thickness post-bend** *(NT Ch.7, Fig. 7.24)*. No numeric thickness threshold — use the source tubing's wall spec (0.042–0.058 in / 1.07–1.47 mm clear glass per *Table 3.10*) as the reference baseline.

## Window-sign vs cabinet-sign electrode layouts

> "The double-backing of the electrodes on the pattern are for window sign layout."
> — *Blazek intro*

For window signs (typically viewed from one side, mounted to a glass storefront), both electrode legs run back to the same side of the letter so all wiring is hidden behind a single edge. For a cabinet sign with a back face, electrodes can exit straight through the back at each end of the path. Our tool may need to be told which mode to validate against.

Miller's separate treatment of **window borders, skeleton signs, and box (cabinet) signs** *(Ch. XI pp. 197–222)* confirms this is a real distinction with different mounting hardware (extension posts up to 152 mm tall for window borders vs 35–70 mm posts for cabinets).

## Implication for validation

| Concept | Validate? | How |
|---|---|---|
| Single vs double tube | mode/parameter input | user picks before vectorize |
| Bend sequence | ignore for now | future, for pattern generation |
| Splitting tall letters | **warn at cap height ≥ 305 mm** *(Miller, p. 125)* | suggest WELD location |
| Stroke width as fraction of height | not validated | no source rule |
| Double-back as legitimate construction | exempt from bend-radius failure | required to reduce false positives |
| Window-sign electrode mode | mode/parameter input | affects electrode-end-of-path validation |
| Lead-in turn-up: straight 50–254 mm + 90° last bend | **gap, enforceable** | *(Miller, p. 124)* |
| DB stacked in z (front leg behind front leg) | **3D rule we currently can't validate** in 2D | 3D layout future feature *(Miller, p. 120)* |
| Footage estimate ≈ 3.2 × cap height per letter | informational | *(Miller, Fig. 38, p. 101)* |
| Tube blank length 1,168 mm; usable 864 mm | **forces splice in tall letters** | *(Miller, p. 115, 125)* |
| Combination-bend Z-offset depth | not validated | **Strattman NT Ch.7 — straight-drop combination = 1.5× tube ø** | first numeric Z-offset spec |
| Double-back outside wall ≥ 80% of source spec | not validated | **Strattman Fig. 7.24 ("correct wall / too heavy / too thin")** + Table 3.10 wall thickness | qualitative threshold; visually judged |
