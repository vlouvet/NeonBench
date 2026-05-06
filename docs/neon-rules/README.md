# Neon design rules — research index

Notes extracted from the source PDFs in `docs/` and `docs/neon-rules/` for use by future Claude sessions building NeonBench validation features.

## Sources

| File | Pages | Type | Useful for |
|---|---|---|---|
| `Saving Neon - Best Practices Guide.pdf` | 40 | Restoration/preservation guidebook (Neon Speaks, 2018) | Glossary, gas-color, wire spacing (3in), block-out paint, electrode placement principles, watts-per-foot. **Almost no fabrication tolerances.** |
| `NEON ABC ALPHABETS BY DEAN BLAZEK Book 1 San Serif.pdf` | 41 | Letter pattern book — sans serif | Bend taxonomy, single-vs-double-tube construction, electrode (♦) placement convention. **No numeric tolerances on letter pages.** |
| `NEON ABC ALPHEBETS BY DEAN BLAZEK BOOK 2 Script.pdf` | 61 | Letter pattern book — script | Same intro as Book 1; script-specific bends (ribbon heat, correction bend, crossfire flyover). |
| `NEON ABC ALPHEBETS BY DEAN BLAZEK BOOK 3 - SERIF_Roman.pdf` | 35 | Letter pattern book — serif/Roman | Same intro as Book 1; double-stroke (parallel-tube) layouts annotated with DB, 90, etc. |
| `neon-rules/neonsignsmanufac00millrich.pdf` (Miller, 1935) | 312 | Foundational trade textbook (Samuel C. Miller & Donald G. Fink, *Neon Signs: Manufacture--Installation--Maintenance*, McGraw-Hill, 1935; Internet Archive copy) | **The numeric source.** Lead-in length (50–254 mm), tube z-offset (35–70 mm), gas fill pressures (5–15 mm Hg), gas-dependent transformer footage, electrode dimensions, UL Standard for Electric Signs (1930) §15–148 reproduced as Appendix I, glass tubing wall-thickness specs, bombarding/aging procedures, multi-color sign layout. **Pre-dates phosphor coatings and solid-state transformers.** |

The Saving Neon guide is a preservation/conservation document for sign owners, not a fabrication manual. The Blazek books are working patterns by a 35-year tube bender, presented without commentary. **Miller (1935) is the canonical 1930s trade textbook** and supplies most quantitative numbers we have. Where Miller is silent (per-tube min bend radius, parallel-tube minimum spacing, phosphor-coated tube rules), the next reference to consult is *Neon Techniques* (Miller & Strattman, 1997) or *The Neon Engineers Notebook* (Crook & Fishman, 2002) — see `docs/neon-rules/missing-rules.md`.

## Files

- `bend-radius.md` — what the sources say (and don't say) about minimum bend radius
- `segment-length.md` — max tube run between electrodes; Miller's transformer-footage rules
- `spacing.md` — minimum spacing between parallel tubes; clearances around blockouts and double-backs; Miller's UL §126 / §202 numeric clearances
- `electrodes.md` — placement, lead-in (Miller p. 124: 50–254 mm), double-end vs single-end, electrode count per letter, electrode dimensions
- `letter-construction.md` — single-tube vs double-tube layouts, bend sequencing, splitting tall letters in halves (Miller p. 125: ≥ 305 mm cap height)
- `gas-and-color.md` — noble gases, phosphor coatings, color rules, Miller's fill-pressure ranges
- `glossary.md` — terms of art (DB, ribbon heat, blockout, GTO, bombardment, aging, dumet wire, etc.)
- `missing-rules.md` — rules our code currently checks (or should) where the sources are silent. Where to look next.
