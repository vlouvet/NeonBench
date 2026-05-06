# Rules our code needs that the source PDFs do NOT cover

This file is a **deliberate inventory of holes in the source material**. It now reflects the addition of Miller (1935) **and Strattman (1997)** — most of the gaps that existed before Miller and Strattman are now filled. Future Claude sessions should treat anything below as "unverified — defaults are best-effort heuristics" until a proper trade reference is consulted.

## What Strattman (1997, 4th ed.) adds beyond Miller (1935)

Strattman explicitly fills these gaps that Miller couldn't:

1. **Modern Luminous Tube Footage Chart** — *Table 6.2*: feet-by-(15/12/9/7.5/6/5/4/3/2.5 kV) × (30/60/90/120 mA) × (9/10/11/12/13/14/15/18/20/22 mm tube ø) for clear/fluorescent-red tubes. **First explicit machine-tabulated form of Miller's unreadable Table VI, p. 97.**
2. **Mercury-filled tube footage** — *Table 6.3* (indoor ≥40 °F vs indoor+outdoor) — first explicit table by tube ø × mA for mercury tubes.
3. **Mercury dosage per tube** — *Ch.10*: 300–600 mg sign tubing (long/short × warm/cold); 50–200 mg cold-cathode (15–25 mm tube ø × 30/100/200 mA).
4. **Phosphor catalog** — *Tables 3.11, 3.12*: 7 base phosphors + 5 rare-earth activators with peak emission wavelength, excitation range, sensitivity peak.
5. **Modern standardized electrode shells** — *Table 3.4*: 15-shell (3/8 × 1-5/16 in) and 19-shell (1/2 × 1-5/8 in) with explicit voltage-drop-by-coating numbers (200/120 V and 170/90 V).
6. **Modern HV-to-grounded-metal clearance** — *Ch.11*: **63.5 mm (2-1/2 in)** for jacketed GTO, **supersedes Miller p. 202's 70 mm (2-3/4 in)**.
7. **Modern mid-point ground threshold** — *Ch.4*: **9,000 V**, **supersedes Miller p. 206's 7,500 V**.
8. **Cold-weather mercury derate** — *Ch.11*: ≤25% of normal footage when ambient < 40 °F (4 °C), or avoid mercury and use pure neon.
9. **Transformer loading band** — *Ch.11*: secondary current must be 78–83% of nameplate; outside band = overloaded or underloaded.
10. **Heat-zone length for a 90° angle bend** — *Fig. 7.20*: 2× tube diameter.
11. **Combination-bend Z-offset depth** — *Ch.7*: 1.5× tube diameter for the straight-drop combination.
12. **Window-border jumper glass** — *Fig. 11.3*: 10–11 mm OD glass with flared end (replaces Miller's 16 mm cable sleeve).
13. **Helium = 50% of neon footage** — *Ch.6 Table 6.3 note*: confirms Miller p. 41 exactly, 62 years later.
14. **Cathode-fall = 1 ft of tube length** — *Ch.6*: deduct 1 ft per electrode pair from Table 6.2.
15. **Glass codes & properties** — *Table 3.6*: SG 10/12 lead glass, SG 772 borosilicate, SG 81 lead-free Coleman; strain/annealing/softening/working points all tabulated.
16. **Glass weights & wall thickness** — *Table 3.10*: feet-per-pound and wall thickness by tube ø, for clear and colored glass.
17. **Dumet vs tungsten lead-in seals** — *Table 3.5*: which metal goes with which glass family.

### What Strattman explicitly does NOT add (still gaps after both editions)

- **Per-diameter minimum bend radius table.** Both editions defer to bender visual judgement of the outside-wall thickness.
- **Per-diameter minimum parallel-tube glass-to-glass spacing.** Both editions are silent.
- **Per-stroke double-tube layout spacing** (the gap between the two parallel tubes of a double-stroke letter).
- **Stroke-width-to-cap-height ratio** for legibility.
- **Counter (interior) clearance** for closed-form letters (O/P/D).
- **Minimum letter-to-letter spacing** in a word.

## What Miller (1935) does and does NOT cover

### Now answered (was a gap in the four PDFs):

1. **Lead-in length** between the electrode housing and the first decorative bend: **2 to 10 inches (50–254 mm)** *(Miller, p. 124)*. — *Was a complete gap; now enforceable.*
2. **Tube z-offset from substrate** (elevation post height): **35–70 mm cabinet, 50–152 mm window** *(Miller, p. 62, 201; Strattman Ch.11 confirms window-border range "two to six inches" = 50–152 mm)*. — *3D dimension, was completely unmodeled.*
3. **Tube body to grounded metal minimum: 6.35 mm (¼ in)** *(Miller, App I §126, UL Standard p. 275)*. — *Now enforceable.*
4. **HV cable / electrode terminal to grounded metal: ~~70 mm (2¾ in)~~ updated to 63.5 mm (2½ in)** *(Strattman Ch.11, supersedes Miller p. 202)*. — *Now enforceable; use modern value.*
5. **Cable support spacing: ≤ 18 in (457 mm), and within 6 in (152 mm) of electrode** *(Miller, App I §88–89)*. — *Wiring rule; gap until we model wiring.*
6. **Elevation post spacing along tube: ≤ 15 in (381 mm), min 2 per section** *(Miller, p. 98)*. — *Informational, partially gap.*
7. **Gas fill pressures**: neon 5–15 mm Hg (typically 10), helium ~3 mm Hg, Ar-Hg carrier 5–15 mm Hg *(Miller, p. 138, 17, 40)*. **Strattman Table 6.1 adds a per-tube-ø × per-mA fill table**: 7–25 mm tube × 30 / 60 mA → 7–18 mm Hg neon. — *Now enforceable per ø.*
8. **Gas-dependent footage multipliers**: helium = ½ neon footage; helium-Ar-Ne mixture even less. Standard transformer = 30 mA, helium often needs 60 mA *(Miller, p. 41; Strattman Ch.6 confirms 50% — 62-year corroboration)*. — *Now enforceable as a warning.*
9. **Letter-size threshold for forced splice: cap height ≥ 12 in (305 mm)** requires multi-blank construction *(Miller, p. 125)*. — *Was qualitative-only ("split tall letters"); now quantified.*
10. **Tube blank usable length: 864 mm (34 in)** out of 1,168-mm (46-in) blanks after handling reserve *(Miller, p. 115, 124)*. — *Was unknown.*
11. **Standard tube diameter range: 7–15 mm OD** *(Miller, p. 18)*; **modern Strattman Table 6.2 covers 9–22 mm; Table 3.10 covers 7–25 mm.** — *Confirms 8/10/12/15 mm code defaults are within trade practice; Strattman extends the range upward.*
12. **Standard secondary current: 30 mA (some 60 mA)** *(Miller, p. 19, 71)*; **Strattman Table 6.2 adds 90 and 120 mA tiers** for high-output cold-cathode. — *Sets the family of expected loads.*
13. **Secondary voltage range: 2,000–15,000 V** in three cable tiers (5 / 10 / 15 kV) *(Miller, p. 64–65, 71)*; **Strattman Ch.4 confirms identical range, no supersession.** — *Confirms three-tier cable model.*
14. **Cabinet mid-point grounding above ~~7,500~~ 9,000 V** *(Strattman Ch.4 supersedes Miller p. 206)*. — *Wiring rule, modern threshold.*
15. **UL spacings table for HV parts vs grounded metal** *(Miller, App I §101–108, p. 273)*. — *Schema known; numeric values not OCR-readable from the PDF table. Modern UL 48 (current) is the live source.*
16. **Footage estimator: ~1.35 ft tube per 5-in cap height letter** *(Miller, Fig. 38, p. 101)*. — *Sanity-check rule of thumb.*
17. **Modern Luminous Tube Footage Chart** *(Strattman Table 6.2)* — full per-(15/12/9/7.5/6/5/4/3/2.5 kV) × per-(30/60/90/120 mA) × per-(9–22 mm tube ø) tabulation. — *NEW; was Miller's unreadable Table VI.*
18. **Mercury-Filled Tube Footage Chart** *(Strattman Table 6.3)* — per-tube-ø footage for indoor (≥40 °F) and indoor+outdoor mercury operation. — *NEW; phosphor era.*
19. **Mercury dosage per tube** *(Strattman Ch.10)* — 300/400/600 mg sign tubing by length × climate; 50/100/200 mg cold-cathode by ø × mA. — *NEW; fills the "mg per linear meter" gap in trade-standard quantum (per tube).*
20. **Phosphor catalog** *(Strattman Tables 3.11, 3.12)* — 7 base phosphors + 5 rare-earth activators with peak emission wavelengths. — *NEW; phosphor era.*
21. **Standardized modern electrode shells** *(Strattman Table 3.4)* — 15-shell (3/8 × 1-5/16 in) and 19-shell (1/2 × 1-5/8 in) with explicit voltage drops. — *NEW.*
22. **Cold-weather mercury threshold and derate** *(Strattman Ch.11)* — <40 °F → ≤25% normal footage, or use pure neon. — *NEW; quantifies Miller's qualitative warning.*
23. **Transformer loading band** *(Strattman Ch.11)* — secondary current 78–83% of nameplate; voltage ratio 0.77–0.83. — *NEW.*
24. **Heat-zone length for 90° angle bend** *(Strattman Fig. 7.20)* — 2× tube diameter. — *NEW.*
25. **Combination-bend Z-offset depth** *(Strattman Ch.7)* — 1.5× tube diameter for straight-drop combination. — *NEW; first numeric Z-offset.*
26. **Modern dumet vs tungsten lead-in seal classification** *(Strattman Table 3.5)* — dumet for soft glass, tungsten for hard glass (Pyrex / Nonex). — *NEW.*
27. **Modern glass codes and properties** *(Strattman Table 3.6)* — strain/annealing/softening/working points for SG 10/12 lead, SG 772 borosilicate, SG 81 lead-free. — *NEW.*
28. **Modern glass weights and wall thickness** *(Strattman Table 3.10)* — feet-per-pound and wall thickness by tube ø, clear vs colored. — *NEW; refines Miller p. 115.*

### Still NOT covered, even by Miller (status updated post-Strattman):

1. **Numeric minimum bend radius per tube diameter.** Miller treats radius as bender's craft, not a tabulated spec. *Worked-example bound:* in his 18-in O recipe, smallest planned curvature is ≈ 152 mm radius for 12 mm tube — but he does not state a minimum. **Strattman (1997) Ch.7 also does not tabulate this** — same conclusion 62 years later. **STILL OPEN.**
2. **Numeric minimum spacing between parallel glass tubes.** Miller's only related rule is qualitative (avoid "long lengths of tubing doubled back upon each other" near the metal box, p. 224). UL §101–108 covers cable spacings but not glass-to-glass. **Strattman (1997) is also silent on the per-diameter glass-to-glass spacing.** **STILL OPEN — both editions silent.**
3. ~~Phosphor-coated tube rules.~~ — **Strattman Tables 3.11, 3.12 give the modern phosphor catalog with peak-emission wavelengths.** **ANSWERED.**
4. **Modern solid-state transformer behavior.** Miller's transformer-load math assumes electromagnetic transformers operating at line frequency. **Strattman (1997) Ch.4 mentions electronic power supplies but explicitly says** "*so much variation exists in the various designs of electronic power supplies that no single, industry-wide footage chart has been developed*" *(NT Table 6.3 Notes)*. **PARTIALLY ANSWERED — Strattman acknowledges the gap but doesn't fill it.** Use Strattman's electromagnetic-core-and-coil chart as the rough guide.
5. ~~Modern argon-mercury phosphor-tube length-per-transformer table.~~ — **Strattman Table 6.3 (Mercury-filled tube footage chart) tabulates this for both indoor and indoor+outdoor.** **ANSWERED.**
6. ~~Mercury volume per linear meter.~~ — **Strattman Ch.10 gives per-tube doses by length × climate (300/400/600 mg sign tubing; 50/100/200 mg cold-cathode).** Not strictly per-meter, but per-tube which is the trade-standard quantum. **ANSWERED.**
7. **Counter (interior) widths** for letters with closed forms. Implied by bend-radius and double-tube spacing. **Strattman silent.** **STILL OPEN.**
8. **Stroke-width-as-fraction-of-cap-height** ratios for legibility. **Strattman silent (treats as artistic decision).** **STILL OPEN.**
9. **Minimum letter spacing in a word.** **Strattman silent.** **STILL OPEN.**
10. ~~Cold-weather mercury behavior quantified.~~ — **Strattman Ch.11 quantifies: ambient < 40 °F → derate to ≤25% of normal footage, or avoid mercury entirely.** **ANSWERED.**
11. **Per-tube max length** as distinct from per-transformer total. Miller's Table VI is per-transformer only. **Strattman Table 6.2 + Ch.6 worked example** give the same per-transformer-total approach (sum the per-section voltage drops to match the open-circuit secondary voltage at chosen current). The trade does not separately tabulate per-tube max length — it is a *derived* quantity from the per-transformer total + electrode count. **PARTIALLY ANSWERED.**

### Net status post-Strattman

| Original gap | Pre-Miller | Post-Miller (1935) | Post-Strattman (1997) |
|---|---|---|---|
| Per-ø bend radius minimum | open | open | **STILL OPEN** (both editions silent) |
| Per-ø parallel-tube spacing | open | open | **STILL OPEN** (both editions silent) |
| Phosphor catalog | open | open (didn't exist in 1935) | **CLOSED** *(NT Tables 3.11, 3.12)* |
| Modern solid-state transformer | open | open | **PARTIAL** (acknowledged but not tabulated) |
| Mercury dose per tube | open | partial (qualitative) | **CLOSED** *(NT Ch.10)* |
| Cold-weather mercury threshold | open | partial (qualitative) | **CLOSED** at 40 °F / 25% derate *(NT Ch.11)* |
| Modern transformer footage table | open | partial (Table VI unreadable) | **CLOSED** *(NT Tables 6.2, 6.3)* |
| Modern HV clearance | (Miller 70 mm) | answered at 70 mm | **CLOSED, supersedes** at 63.5 mm *(NT Ch.11)* |
| Mid-point ground threshold | (Miller 7.5 kV) | answered at 7.5 kV | **CLOSED, supersedes** at 9 kV *(NT Ch.4)* |
| Heat-zone for 90° bend | open | open | **CLOSED** at 2× tube ø *(NT Fig. 7.20)* |
| Z-offset depth for combination bend | open | open | **CLOSED** at 1.5× tube ø *(NT Ch.7)* |
| Standard electrode shells | partial (Miller p. 50 range) | partial | **CLOSED** at two specific sizes *(NT Table 3.4)* |
| Counter widths / stroke-width / letter-spacing | open | open | **STILL OPEN** (artistic decisions) |

## What the four source PDFs do not give us (pre-Miller summary, kept for context)

1. ~~Numeric minimum bend radius per tube diameter.~~ Still not in Miller.
2. ~~Numeric maximum tube run between electrodes, by gas / voltage / transformer rating.~~ Miller adds gas-dependent and voltage-dependent transformer-load tables — partially answered.
3. ~~Minimum spacing between parallel glass tubes.~~ Still not in Miller (qualitative only).
4. ~~Lead-in length~~ — **answered by Miller p. 124: 50–254 mm.**
5. ~~Housing-hole alignment tolerance~~ — Miller p. 50 (housing bore ⅜–⅝ in) plus *Saving Neon p. 23* (±¼ in) corroborate: tolerance ≈ ±6.35 mm.
6. ~~Voltage / transformer rating-vs-tube length relationships.~~ Miller Ch. III, IV, VI (Table VI page 97) give this — but the numeric table is not OCR-readable.
7. ~~Gas-fill pressures~~ — **answered by Miller p. 138, 40, 186.**
8. ~~Cold-weather mercury behavior.~~ Miller mentions, doesn't quantify.
9. **Stroke-width-as-fraction-of-cap-height** conventions for legibility/buildability. Still not.
10. **Counter (interior) widths** for letters with closed forms. Still not.
11. **Minimum letter spacing in a word.** Still not.

## Where to look next

After Strattman (1997), only **two big-ticket gaps remain quantitatively unanswered by any neon-trade textbook we have**:

1. **Per-diameter minimum bend radius.** Both Miller (1935) and Strattman (1997) defer to bender visual judgement of outside-wall thickness. Our 16/20/25/30 mm defaults remain a NeonBench engineering heuristic.
2. **Per-diameter minimum parallel-tube glass-to-glass spacing.** Both editions silent. Our 10/12/14/18 mm defaults remain a NeonBench engineering heuristic and remain the highest false-positive risk in the validator.

Remaining trade references on the Saving Neon bibliography (p. 38):

- ~~Samuel Miller & Wayne Strattman, *Neon Techniques*, 1997.~~ — **MINED (this session)**. 4th edition, Wayne Strattman ed., 1997 (©1997, 2001, 2003). Filled most modern-era gaps; per-ø bend radius and per-ø spacing remain open.
- **Morgan Crook & Jacob Fishman, *The Neon Engineers Notebook*, 2002.** ← *Next reference to consult.* Targeted at the engineer, likely tabular and quantitative. Best remaining candidate for **per-tube minimum bend radius** and **per-diameter parallel-tube minimum spacing**, which Strattman did not tabulate.
- **Museum of Neon Art, *Steps to Take in the Restoration of Vintage Electric, Illuminated Signs*** — PDF available on request. More likely to corroborate restoration-side rules than to fill bend-radius/spacing gaps.

Other references to seek out:
- **Underwriters' Laboratories Standard for Electric Signs (current edition)** — UL 48 today (2018, 5th ed.). The numeric values for the spacings table (Miller App I §101–108) are in the modern UL standard. UL 48 governs **electrical** clearances (cable-to-cable, cable-to-grounded-metal) but is **silent on glass-tube-to-glass-tube** like both editions of Miller/Strattman.
- **NEC Article 600 (Electric Signs and Outline Lighting)** — current National Electrical Code section governing neon-sign installations. Modern equivalent of Miller's Appendix I.
- **International Sign Association / IAEI joint publications** — referenced in Strattman's TOC ("Neon Installation Manual by The International Association of Electrical Inspectors and The International Sign Association").
- **Crook & Fishman's *Neon Engineers Notebook* (2002)** — should be the highest-value remaining reference.

If those become available in `docs/`, future Claude should re-read the rule files in this folder and replace each remaining "(none)" / "uncited" / "engineering heuristic" entry with the cited number.

## Rules our code currently checks where the gap matters most

| Validator | Source-supported? | Action |
|---|---|---|
| Min bend radius (16/20/25/30 mm by ø) | NO direct cite (Miller AND Strattman silent on per-ø minimum). Strattman heat-zone rule (2× tube ø) implies r ≈ 1.27 D as a hard lower bound; our defaults are 2× this lower bound — conservative | Defaults plausible. Keep but mark "engineering heuristic — neither Miller (1935) nor Strattman (1997) tabulates this". **Add an exemption for legitimate 180° double-back hairpins.** |
| Max segment length (2500/3000 mm per pair) | DIRECTLY supported by **Strattman Table 6.2** for typical 30 mA / 12-15 mm circuits when divided by typical 2-3 letters in series | Defaults plausible. Add a separate **per-transformer total** check using Strattman Table 6.2 (now machine-tabulatable). |
| Min spacing (10/12/14/18 mm parallel) | NO direct cite (Miller AND Strattman silent on glass-to-glass) | **Highest false-positive risk; remains open.** Add (a) a crossing-with-blockout-paint exemption, (b) a double-back inner-leg exemption. See `spacing.md`. |
| Tube run count (informational) | OK | No source rule, but the count is an obvious complexity / cost proxy. |
| Glass-tube to grounded-metal | NOT CHECKED. **Miller App I §126: ≥ 6.35 mm.** | **Add as new validator.** |
| HV cable / electrode terminal to grounded metal | NOT CHECKED. **Miller p. 202: ≥ 70 mm; Strattman Ch.11: ≥ 63.5 mm (use modern value).** | **Add as new validator at 63.5 mm; flag legacy installations against 70 mm.** |
| Lead-in turn-up length | NOT CHECKED. **Miller p. 124: 50–254 mm.** | **Add as new validator.** |
| Gas fill pressure | NOT MODELED. **Miller p. 138 + Strattman Table 6.1 (per-ø by 30/60 mA): 5-18 mm Hg neon depending on ø.** | Add to data model; validate user-entered fill pressure against Strattman Table 6.1. |
| Letter cap-height threshold for forced splice | NOT WARNED. **Miller p. 125: ≥ 305 mm cap height needs internal splice.** | Add as warning. |
| **Mid-point ground threshold** | NOT MODELED. **Strattman Ch.4: 9 kV** (supersedes Miller's 7.5 kV) | Add to electrical-config data model. |
| **Mercury dose** | NOT MODELED. **Strattman Ch.10: 300–600 mg sign / 50–200 mg cold-cathode** | Add to data model; warn if user-entered mercury wildly off. |
| **Cold-weather mercury derate** | NOT MODELED. **Strattman Ch.11: <40°F → ≤25% normal footage** | Add as warning when ambient temperature is set. |
| **Standard electrode shells (15 / 19)** | NOT MODELED. **Strattman Table 3.4: 15-shell 9.5×33 mm; 19-shell 12.7×41 mm** | Add to electrode data model. |
| **Phosphor coating** | NOT MODELED. **Strattman Tables 3.11, 3.12: full catalog with peak wavelengths** | Add to gas-and-color data model with emission-peak rendering. |
| **Transformer loading band 78-83%** | NOT MODELED. **Strattman Ch.11** | Add as warning when loading is computed. |
| **Heat-zone for 90° bend = 2× ø** | NOT MODELED. **Strattman Fig. 7.20** | Informational; constrains arc length of 90° bends. |
| **Combination-bend Z-offset = 1.5× ø** | NOT MODELED. **Strattman Ch.7** | Informational; first numeric Z-offset spec. |

## Rules our code does NOT check that the source DOES support

| Concept | Source | Suggested validation |
|---|---|---|
| Tube end exits substrate at 90° | *Saving Neon* pp. 19, 23; **Miller p. 124** | Validate that the lead-in segment is normal to substrate within tolerance. |
| GTO wire spacing ≥ 3 in / 76 mm | *Saving Neon* pp. 21, 22; Miller p. 202 (2¾ in / 70 mm to grounded metal) | Once we model wiring, validate. |
| Power estimate at 4 W per foot of tubing | *Saving Neon* p. 36; Miller Fig. 37 (350 VA for 35 ft of 12 mm tube on 30 mA) | Display as informational power estimate. |
| Window-sign mode (both electrodes on one side) | Blazek intro; Miller p. 200, 254–261 | Configurable mode. |
| Split tall letters into halves with weld | Blazek intro; **Miller p. 125 (cap height ≥ 305 mm)** | Warn at quantified height. |
| Phosphor coating + gas type per segment | *Saving Neon* p. 20 (Miller silent on phosphor) | Data model field. |
| Gas fill pressure per segment | **Miller p. 138, 40** | Data model + validator. |
| Per-transformer total footage by gas | **Miller p. 41–43** | Validator, with 30 mA / 60 mA family selection. |
| Tube z-offset from substrate (3D) | **Miller p. 62, 201** | Data model field for 3D layout future. |
| Elevation post spacing along tube | **Miller p. 98 (≤ 381 mm, min 2)** | Informational warning. |

## Heuristics our code probably needs that NO PDF (including Miller AND Strattman) covers

- **Detect double-back as an intentional construction**, not a bend-radius failure. Look for two near-parallel segments separated by a 180° tight curve and connected as one subpath. Exempt the curve from the bend-radius test.
- **Detect crossings (non-parallel, near-perpendicular) and exempt from spacing test** if user has marked the crossing as "blockout/jump" (see `spacing.md`).
- **Acute (50°) bends** are a recognized vocabulary item, not an error condition. Our bend-radius check should be radius-based, not angle-based — verify this is the case in code.
- **DB stacked in z-axis** (front leg behind front leg) — Miller p. 120 explicit 3D rule that 2D Blazek patterns hide. Strattman Fig. 7.24 corroborates ("rear part of the bend lies directly behind the front part"). Validating this requires a 3D layout model.
- ~~Modern phosphor-coated tube length-per-transformer rules~~ — **resolved by Strattman Tables 6.2–6.3.**
- **Per-ø minimum bend radius** — **still a heuristic**; both editions silent. Use our 16/20/25/30 mm defaults as engineering values, derived from outside-wall thinning analysis (target outside wall ≥80% original thickness gives r ≥ 2.25 D, slightly tighter than our defaults). Mark as "industry-typical lower bound, neither Miller (1935) nor Strattman (1997) tabulates this".
- **Per-ø minimum parallel-tube spacing** — **still a heuristic**; both editions silent. Trade convention typically uses ≥1× tube ø for parallel runs and ≥2× tube ø for parallel runs longer than 24 in. Mark as "trade convention, neither Miller (1935) nor Strattman (1997) tabulates this".
