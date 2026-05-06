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

## Implication for validation

The PDFs support a simple model:

- **Each disjoint subpath has exactly two ends, each of which is an electrode.** Both ends must terminate at a housing-hole location.
- **Lead-in segment** = the short straight piece between the housing and the first decorative bend. The PDFs don't quantify a minimum length, but it must be long enough to (a) exit the substrate at 90°, (b) accommodate the electrode itself inside the housing, and (c) leave room for the brass button. Trade convention puts this around **1-2 inches (25-50 mm)** of straight lead-in but the four PDFs do not state this.
- **Window signs** (double-back electrode) wire from one end. **Wall/cabinet signs** typically wire from both ends through the substrate.

## Current code vs gap

| | Code | Source | Verdict |
|---|---|---|---|
| Tube run count | counted, not enforced | (no source numeric limit) | OK |
| Lead-in length | not checked | implied by *Saving Neon, p. 23* and electrode geometry | gap |
| Lead-in 90° angle to substrate | not checked | *Saving Neon, p. 19, 23* explicit | gap |
| Electrode at both ends of every subpath | implicit (a subpath has two ends) | *Saving Neon, p. 19* | OK |
| Housing-hole alignment tolerance | not checked | "off even a quarter of an inch" *(p. 23)* | gap (~±6 mm) |
| Window-sign mode (both electrodes on same side) | not represented | Blazek intro | gap, configurable mode |

## Anti-patterns from the sources

- External rubber-boot termination of an electrode — banned *(Saving Neon, pp. 3, 22)*.
- Drilling new housing holes — banned, breaks porcelain *(p. 3)*.
- Wire run from housing to a remote electrode (instead of electrode at the housing) — banned *(p. 23)*.
- Bushings (smaller-than-original housings) used as a workaround — banned *(p. 23)*.
