# Neon design rules — research index

Notes extracted from the source PDFs in `docs/` and `docs/neon-rules/` for use by future Claude sessions building NeonBench validation features.

## Sources

| File | Pages | Type | Useful for |
|---|---|---|---|
| `Saving Neon - Best Practices Guide.pdf` | 40 | Restoration/preservation guidebook (Neon Speaks, 2018) | Glossary, gas-color, wire spacing (3in), block-out paint, electrode placement principles, watts-per-foot. **Almost no fabrication tolerances.** |
| `NEON ABC ALPHABETS BY DEAN BLAZEK Book 1 San Serif.pdf` | 41 | Letter pattern book — sans serif | Bend taxonomy, single-vs-double-tube construction, electrode (♦) placement convention. **No numeric tolerances on letter pages.** |
| `NEON ABC ALPHEBETS BY DEAN BLAZEK BOOK 2 Script.pdf` | 61 | Letter pattern book — script | Same intro as Book 1; script-specific bends (ribbon heat, correction bend, crossfire flyover). |
| `NEON ABC ALPHEBETS BY DEAN BLAZEK BOOK 3 - SERIF_Roman.pdf` | 35 | Letter pattern book — serif/Roman | Same intro as Book 1; double-stroke (parallel-tube) layouts annotated with DB, 90, etc. |
| `neon-rules/neonsignsmanufac00millrich.pdf` (Miller, 1935) | 312 | Foundational trade textbook (Samuel C. Miller & Donald G. Fink, *Neon Signs: Manufacture--Installation--Maintenance*, McGraw-Hill, 1935; Internet Archive copy) | **The numeric source for the 1930s era.** Lead-in length (50–254 mm), tube z-offset (35–70 mm), gas fill pressures (5–15 mm Hg), gas-dependent transformer footage, electrode dimensions, UL Standard for Electric Signs (1930) §15–148 reproduced as Appendix I, glass tubing wall-thickness specs, bombarding/aging procedures, multi-color sign layout. **Pre-dates phosphor coatings and solid-state transformers.** |
| `docs/shot_*.png` (Strattman ed., 1997) — **191 Kindle screenshots** of Wayne Strattman (ed.), *Neon Techniques (formerly Neon Techniques and Handling): Handbook of Neon Sign and Cold-Cathode Lighting*, 4th ed., ST Media Group International, 1997 (©1997, 2001, 2003; ISBN 0-944094-27-9) | ≈ 16 chapters, full text reflowed | **The modern numeric source — Miller's 62-years-later successor.** Provides the **Luminous Tube Footage Chart (Table 6.2)** with explicit feet-by-tube-ø-by-voltage-by-mA, **Mercury-Filled Tube Footage Chart (Table 6.3)** for indoor/outdoor mercury, **mercury dosage by length × climate (Ch.10)**, **modern phosphor catalog (Tables 3.11–3.12)**, **standardized electrode shells (Table 3.4)**, **modern HV clearance 63.5 mm (Ch.11; supersedes Miller's 70 mm)**, **mid-point ground threshold 9 kV (Ch.4; supersedes Miller's 7.5 kV)**, **2× tube ø heat-zone for angle bends (Fig. 7.20)**, **1.5× tube ø Z-offset for combination bends (Ch.7)**, **cold-weather mercury derate to ≤25% under 40°F (Ch.11)**, **78–83% transformer loading band (Ch.11)**. **Like Miller, still does not tabulate per-diameter minimum bend radius or per-diameter minimum parallel-tube spacing.** |

The Saving Neon guide is a preservation/conservation document for sign owners, not a fabrication manual. The Blazek books are working patterns by a 35-year tube bender, presented without commentary. **Miller (1935) is the canonical 1930s trade textbook** and supplies most quantitative numbers we have for the pre-phosphor era. **Strattman (1997) is the modern successor** and supplies the modern footage charts, phosphor catalog, mercury dosage, and updated UL-style clearances. Where both Miller and Strattman are silent (per-tube min bend radius, per-diameter min parallel-tube spacing), the next reference to consult is *The Neon Engineers Notebook* (Crook & Fishman, 2002) — see `docs/neon-rules/missing-rules.md`.

## Files

- `bend-radius.md` — what the sources say (and don't say) about minimum bend radius
- `segment-length.md` — max tube run between electrodes; Miller's transformer-footage rules
- `spacing.md` — minimum spacing between parallel tubes; clearances around blockouts and double-backs; Miller's UL §126 / §202 numeric clearances
- `electrodes.md` — placement, lead-in (Miller p. 124: 50–254 mm), double-end vs single-end, electrode count per letter, electrode dimensions
- `letter-construction.md` — single-tube vs double-tube layouts, bend sequencing, splitting tall letters in halves (Miller p. 125: ≥ 305 mm cap height)
- `gas-and-color.md` — noble gases, phosphor coatings, color rules, Miller's fill-pressure ranges
- `glossary.md` — terms of art (DB, ribbon heat, blockout, GTO, bombardment, aging, dumet wire, etc.)
- `raceway.md` — raceway / wireway geometry, gauge, mounting and length practice. **Web-sourced, not book-sourced** — all four PDFs are silent on raceways, so this file is compiled from supplier spec pages, trade press and a professional forum, and is weaker evidence than the rest of this directory. Also records a terminology collision in our own code.
- `missing-rules.md` — rules our code currently checks (or should) where the sources are silent. Where to look next.
