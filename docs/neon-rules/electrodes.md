# Electrode placement & wiring

## What the four PDFs say

### Placement convention

> "The drawings show how to lay out the letters, where to start bending, and, with step-by-step directions, how to complete each letter and number. The symbol ♦ shows where to house electrode centers; however, placement of the electrodes could be compromised depending on the installation methods. In some cases, all of the electrodes may need to be placed on the bottom of the letter; in other cases, on the top or middle. **The double-backing of the electrodes on the pattern are for window sign layout.**" — *Blazek Book 1 introduction (identical text in Books 2 & 3)*

Key takeaways:

- The **diamond ♦ symbol** on a Blazek pattern marks the electrode (housing center) location.
- Placement is **flexible** — top, bottom, or middle of the letter as installation requires.
- "Double-backing of the electrodes" refers to running both electrode legs back to the same end of the letter, common in **window-sign layouts** where everything wires from one side.

### Lead-in / "tube ends bent at 90°"

> "It is very important that the ends of the glass tubes are bent at a 90-degree angle to precisely fit inside the original housing holes. **Don't use double-backs/rubber boots as a short cut to re-engineer the original design of the tubes.**" — *Saving Neon, p. 19*

> "Tube ends should be bent at a 90-degree angle to fit perfectly in the original housing holes." — *Saving Neon, p. 3 (checklist)*

> "Tubes should always be bent at a 90-degree angle to precisely fit inside the original housing holes. So, if your pattern is off even a quarter of an inch, the glass tube might not fit." — *Saving Neon, p. 23*

The **electrode lead-in (the short straight segment between the housing and the first decorative bend)** must:

1. exit the letter face at a **90° angle** to the substrate,
2. align with a pre-existing **housing hole** to within roughly ±¼ inch (±6.35 mm) — *(p. 23)*,
3. terminate inside a **glass or porcelain housing** that contains a spring contact — *(pp. 22-23)*.

### Wiring

- **GTO wire** (Gas Tube Only) is the high-voltage secondary cable from transformer to electrode *(Saving Neon, p. 21)*.
- "GTO wire leads should be as short as possible and kept at least three inches apart" — *p. 21*.
- "Never run wire from the housing hole to an electrode or through a rubber boot or end cap" *(checklist, p. 3)* — i.e. the electrode itself sits inside the housing, with the wire connecting on the inside of the cabinet.
- Wire connections must be **inside the cabinet**, not external. Rubber boots / silicone end caps are explicitly banned for double-back electrode shortcuts *(p. 22)*.

### One transformer, multiple tubes

> "In some cases, one neon tube may be wired to another in series." — *Saving Neon, p. 22*

This is the only mention of multi-tube circuits per transformer in the four PDFs. No quantitative limit on how many.

### Brass electrode buttons

> "Attach a brass electrode button to the end of the electrode. These cost-effective buttons provide increased electrical connection and are corrosion-resistant." — *Saving Neon, p. 21*

Material/maintenance note, not a layout rule.

## What Miller (1935) adds — quantitative electrode and lead-in specs

### Electrode physical dimensions

- **Electrode shell open-end diameter:** "**⅜ to ⅝ inch**" (9.5 to 15.9 mm) *(Miller, p. 50)*. Sets the minimum housing-bore size and is the upper bound for the glass jacket inner diameter.
- **Shell wall thickness:** 0.007 to 0.03 in (0.18–0.76 mm) *(Miller, p. 50)*. Not a layout dimension but explains why electrode glass jackets are physically larger than the tube it joins.
- **Shell-to-glass-jacket spacing:** the heat-insulating ring (mica/porcelain/lava) keeps the hot electrode shell away from the glass jacket. "Sufficient spacing between shell and glass" is the design intent *(Miller, p. 47)*.
- **Lead-in wire (dumet wire):** 6-mil (0.15 mm) wire carries 200 mA *(Miller, p. 47)*. So electrode lead-in wire is electrically over-rated for 30–60 mA neon currents — not a constraint we need to enforce.
- **Electrode area rule (Claude's law):** "at least **1.5 square decimeters** (about 23 square inches) of untreated surface area are required for every ampere of current carried. For a 30-milliampere sign, therefore, the required area per electrode should exceed approximately **⅔ square inch** (4.3 cm²) for reasonably long life." *(Miller, p. 49)*. Modern coated electrodes can be smaller.

### Lead-in / "turn-up" length

> "A mark is made with chalk **about 6 inches** from the end of the tube. This 6 inches is reserved for handling the tube. From this mark another length of from **2 to 10 inches** is laid out for the turned-up portion which will be joined to the electrode. **The turn-up angle bend is not made, however, until all the letters have been formed.**" *(Miller, Ch. VII, p. ~124)*

This is the most direct quantitative lead-in spec we have:

- **Lead-in (turn-up) straight length: 2 to 10 inches = 50 to 254 mm** *(Miller, p. 124)*.
- The bend at the substrate (the 90° turn-up) is the **last** bend made on the letter.
- Between the turn-up bend and the cut/handling end is a **6-in (152 mm) handling reserve**, which becomes part of the electrode glass jacket.

So a properly built letter has, at each electrode:
1. A 50–254 mm straight lead-in segment perpendicular to the substrate,
2. A 90° bend joining lead-in to the first decorative bend in the plane of the letter,
3. A glass jacket / electrode housing on the substrate side.

Our existing **±6.35 mm housing-hole alignment** *(Saving Neon, p. 23)* applies at the substrate end of the lead-in.

### Electrode housings, receptacles, and bushings

Miller dedicates Ch. IV pp. 62–63 and Appendix I §129–138 (UL Standard pp. 275–276) to electrode receptacles. Quantitative rules from Miller:

- **Housing height (elevation post + housing combined):** the elevation post is **1⅜ to 2¾ in (35–70 mm)** *(Miller, p. 62)*. The housing sits at the substrate; the post supports the tube body above. This sets the **z-distance from substrate to first bend** on the lead-in.
- **Tube to grounded-metal minimum:** **¼ in (6.35 mm)** *(Miller, App I §126, p. 275)*.
- **High-voltage cable to metal:** **2¾ in (70 mm)** *(Miller, p. 202)*. Applies inside the cabinet, between the electrode terminal end of the lead-in and the cabinet wall.
- **Cable support within 6 in (152 mm) of the electrode connection** when no support is provided at the terminal *(Miller, App I §88, p. 271)*.
- **Cable supports spaced not more than 18 in (457 mm) apart** *(Miller, App I §89, p. 271)*.
- **Lamp-holder terminal to other terminals or metal: ⅜ in (9.5 mm)** *(Miller, App I §120, p. 274–275)*. Doesn't apply to neon-only signs but informs combination-sign rules.

### Sign cable voltage rating

> "Cable is available for use at three different maximum voltages. The 5000-volt cable is identified by a red thread in the wire strands; 10,000-volt cable, by a yellow thread; and 15,000-volt cable, by a blue thread. The voltage rating of the cable should never be exceeded if satisfactory service is expected from it." *(Miller, p. 64–65)*

Three rated cable voltages — 5 kV / 10 kV / 15 kV — match the three transformer-secondary tiers.

### Series wiring across multiple electrodes

> "If a skeleton sign contains more than one line and more than one color, it becomes quite complicated, and it is very necessary that it be thoroughly laid out for the glass blower so that the points of connection between the two sections are as short as possible and not visible…" *(Miller, p. 200–201)*

> "When two electrodes come very close together, as they usually do in a skeleton or border sign, cable is not used to connect them, since it would mar the finished appearance of the sign. The lead wires of the two electrodes in such cases are connected by twisting them together… A length of glass tubing is usually slipped over the connection, to insulate it and to produce a finished appearance." *(Miller, p. 204–205)*

So for adjacent letters with electrodes face-to-face, the inter-electrode cable is **replaced by a twisted-lead-wire join inside a glass sleeve (16 mm OD typical)**, not run as cable. This is a different wiring convention from what *Saving Neon* describes; both are valid.

### Cabinet mid-point grounding

> "For transformers of lower than 7500 volts, no mid-point ground is provided. For higher-voltage transformers (7500 up to 15,000 volts), the mid-point is grounded to the metal case of the transformer." *(Miller, p. 206)*

So the cabinet is at ground potential (0 V); the two electrodes are at +V/2 and –V/2 of the secondary. **The 70 mm "live to grounded-metal" rule applies to each electrode independently.**

## Implication for validation

The PDFs support a simple model:

- **Each disjoint subpath has exactly two ends, each of which is an electrode.** Both ends must terminate at a housing-hole location.
- **Lead-in segment** = the short straight piece between the housing and the first decorative bend. **Miller p. 124 quantifies this as 50–254 mm (2 to 10 inches).** Below 50 mm there is no room for the electrode glass jacket; above 254 mm is wasteful and mechanically weak.
- The lead-in must (a) exit the substrate at 90°, (b) reach the housing hole within ±6.35 mm tolerance *(Saving Neon, p. 23)*, (c) terminate in a glass or porcelain housing of bore ⅜–⅝ in *(Miller, p. 50)*.
- **Window signs** (double-back electrode) wire from one end. **Wall/cabinet signs** typically wire from both ends through the substrate.
- **Cable inside the cabinet must clear all grounded metal by ≥ 70 mm** *(Miller, p. 202)*.
- **Tube-glass to cabinet minimum: 6.35 mm** *(Miller, App I §126)*.

## Current code vs gap

| | Code | Source | Verdict |
|---|---|---|---|
| Tube run count | counted, not enforced | (no source numeric limit) | OK |
| Lead-in length | not checked | **Miller p. 124: 50–254 mm (2–10 in)** | **gap, source-supported** |
| Lead-in 90° angle to substrate | not checked | *Saving Neon, p. 19, 23* explicit; Miller p. 124 ("turn-up angle bend") corroborates | gap |
| Electrode at both ends of every subpath | implicit (a subpath has two ends) | *Saving Neon, p. 19* | OK |
| Housing-hole alignment tolerance | not checked | "off even a quarter of an inch" *(Saving Neon, p. 23)*; Miller p. 50 housing bore ⅜–⅝ in | gap (~±6 mm) |
| Window-sign mode (both electrodes on same side) | not represented | Blazek intro | gap, configurable mode |
| Glass-tube to cabinet metal | not checked | **Miller App I §126: ≥ 6.35 mm** | **gap, source-supported** |
| HV cable / electrode terminal to grounded metal | not checked | **Miller p. 202: ≥ 70 mm** | **gap, source-supported** |
| Cable support within 6 in of electrode | not modeled (we don't model cable) | Miller App I §88 | n/a until we model wiring |
| Tube z-offset from substrate (post height) | not checked | **Miller p. 62: 35–70 mm cabinet, p. 201: 50–152 mm window** | gap (3D dimension) |
| Electrode count per series circuit (transformer load) | not enforced | Miller p. 41–43 (gas-dependent footage) | informational |

## Anti-patterns from the sources

- External rubber-boot termination of an electrode — banned *(Saving Neon, pp. 3, 22)*.
- Drilling new housing holes — banned, breaks porcelain *(p. 3)*.
- Wire run from housing to a remote electrode (instead of electrode at the housing) — banned *(p. 23)*.
- Bushings (smaller-than-original housings) used as a workaround — banned *(p. 23)*.
- **Cable with metallic shielding on the secondary side** — banned, causes transformer burnout from capacitive effects *(Miller, p. 223)*.
- **Conducting (metallic) blockout paint near electrodes** — "if metallic paint is used near the electrodes, it will conduct the high voltage out on the sign" *(Miller, p. 60)*.
- **Pull-chain transformers** for permanent installations — banned by *Saving Neon p. 3*; Miller (p. 65, p. 73) describes them as window-display-only equipment.
