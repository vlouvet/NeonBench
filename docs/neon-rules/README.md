# Neon design rules — research index

Notes extracted from the four PDFs in `docs/` for use by future Claude sessions building NeonBench validation features.

## Sources

| File | Pages | Type | Useful for |
|---|---|---|---|
| `Saving Neon - Best Practices Guide.pdf` | 40 | Restoration/preservation guidebook (Neon Speaks, 2018) | Glossary, gas-color, wire spacing (3in), block-out paint, electrode placement principles, watts-per-foot. **Almost no fabrication tolerances.** |
| `NEON ABC ALPHABETS BY DEAN BLAZEK Book 1 San Serif.pdf` | 41 | Letter pattern book — sans serif | Bend taxonomy, single-vs-double-tube construction, electrode (♦) placement convention. **No numeric tolerances on letter pages.** |
| `NEON ABC ALPHEBETS BY DEAN BLAZEK BOOK 2 Script.pdf` | 61 | Letter pattern book — script | Same intro as Book 1; script-specific bends (ribbon heat, correction bend, crossfire flyover). |
| `NEON ABC ALPHEBETS BY DEAN BLAZEK BOOK 3 - SERIF_Roman.pdf` | 35 | Letter pattern book — serif/Roman | Same intro as Book 1; double-stroke (parallel-tube) layouts annotated with DB, 90, etc. |

The Saving Neon guide is a preservation/conservation document for sign owners, not a fabrication manual. The Blazek books are working patterns by a 35-year tube bender, presented without commentary. Neither source provides quantitative bend-radius, spacing, or max-run-length values. **For those numbers we will need to look elsewhere** (candidate references the Saving Neon bibliography points to: *Neon Techniques* by Miller & Strattman, 1997; *The Neon Engineers Notebook* by Crook & Fishman, 2002 — see `docs/neon-rules/missing-rules.md`).

## Files

- `bend-radius.md` — what the sources say (and don't say) about minimum bend radius
- `segment-length.md` — max tube run between electrodes
- `spacing.md` — minimum spacing between parallel tubes; clearances around blockouts and double-backs
- `electrodes.md` — placement, lead-in, double-end vs single-end, electrode count per letter
- `letter-construction.md` — single-tube vs double-tube layouts, bend sequencing, splitting tall letters in halves
- `gas-and-color.md` — noble gases, phosphor coatings, color rules
- `glossary.md` — terms of art (DB, ribbon heat, blockout, GTO, etc.)
- `missing-rules.md` — rules our code currently checks (or should) where the four PDFs are silent. Where to look next.
