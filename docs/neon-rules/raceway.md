# Raceways and wireways

> **⚠️ Source quality — read first.** Every other file in this directory is
> extracted from trade textbooks: Miller (1935), Strattman (1997), Blazek,
> *Saving Neon*. **This file is not.** All four books are silent on raceways —
> Miller pre-dates the practice, and Strattman covers tube fabrication rather
> than sign mounting. What follows is compiled from **supplier specification
> pages, trade-press interviews, and a professional forum**, gathered
> 2026-08-31. Treat it as *current commercial practice*, not as a codified
> trade rule, and prefer a shop's own spec sheet over anything here when the
> two disagree.
>
> A second caveat runs through everything below: **most of the modern web
> sources describe LED signage.** Where a figure is specific to LED-era
> hardware it is flagged, because the numbers differ substantially for neon —
> a neon transformer is far larger than an LED driver, and raceway depth
> follows from what has to fit inside.

## What a raceway is

A rectangular aluminum enclosure that mounts to the building and that the
channel letters mount to. It houses the transformers / power supplies, wiring
and the disconnect, and it spans the letter set.

> "A rectangular structure that serves as enclosure for electrical components
> and wiring made of aluminum." — [Signfab](https://signfab.com/wireway-remote-or-raceway-whats-the-difference/)

> "An enclosed aluminum channel typically 8" by 8" that **spans the entire
> length of the letters**. Channel letters are pre-installed on the raceway in
> the shop, thus simplifying installation in the field."

The commercial driver is the building owner, not the sign shop:

> "Landlords who mandate raceways want the fewest possible penetrations of the
> building envelope and a clean removal at tenant turnover. The raceway, with
> the letters attached, only requires **4 to 8 anchors, plus one electrical
> pass-thru**, which is much less damaging to the landlord's sign band than
> with flush mounted letters." — [Graphics Pro](https://graphics-pro.com/education/raceways-and-wireways/)

### Raceway vs. wireway vs. remote

Three distinct mounting strategies, and the vocabulary matters because they
imply different geometry:

| | Contains | Depth | Notes |
|---|---|---|---|
| **Raceway** | Power supplies + wiring | 4.5″–8″ | Letters mount to it; it mounts to the wall |
| **Wireway** | Wiring only, **no** power supplies | **2″** | Used where protrusion distance is restricted; supplies live inside the wall |
| **Remote** | Nothing — letters mount direct to fascia | — | Cleanest look, most penetrations |

Source: [Signfab](https://signfab.com/wireway-remote-or-raceway-whats-the-difference/).

## Cross-section

Reported figures, which do **not** agree — the spread is real, not sloppy
reporting, and it tracks the LED transition:

| Depth × Height | Context | Source |
|---|---|---|
| **8″ × 8″** | **The historic standard for *neon*-illuminated letters** | [Signs101](https://www.signs101.com/threads/raceways-for-channel-letters.163597/) ("Big Rice Field": *"an 8"x8" raceway was the defacto standard"*) |
| 7¼″ × 7¼″ | General, 10 ft lengths | [Graphics Pro](https://graphics-pro.com/education/raceways-and-wireways/) |
| 7″ high × 4.5″ wide | Extruded | [Signfab](https://signfab.com/wireway-remote-or-raceway-whats-the-difference/) |
| 5″ deep | Modern LED; *"enough room to get his hands inside to make connections"* | Tony Wheeler, SignMonkey, via [Graphics Pro](https://graphics-pro.com/feature/behind-the-letter-raceways-roles-in-channel-letter-projects/) |
| 4″ wide | Extruded, with integral mounting flange + transformer heat sink | [Howard Industries](https://www.howardindustries.com/sign-components/product/channel-letter-raceway) |
| 5″ deep | LED; letter depth also 5″, total assembly 10″ | [SignMonkey](https://signmonkey.com/products/face-lit-channel-letters-and-logos-on-raceway/) |
| ~2″ | Anecdotal modern minimum | [Signs101](https://www.signs101.com/threads/raceways-for-channel-letters.163597/) ("Texas_Signmaker") |

**For NeonBench, 8″ × 8″ (203 × 203 mm) is the defensible default**, because it
is the only figure any source ties specifically to neon. The 4″–5″ figures
exist because LED drivers shrank; they do not describe a raceway that has to
swallow a neon transformer.

That is corroborated by transformer dimensions. Typical modern electronic neon
transformers:

- 10 kV / 9 kV @ 30 mA — **6¼″ L × 3‑13/16″ W × 1⅞″ H** (159 × 97 × 48 mm)
- 6 kV / 3 kV @ 30 mA — **5¾″ L × 2⅝″ W × 1⅝″ H** (146 × 67 × 41 mm)

A 6¼″-long transformer does not fit *across* a 5″ raceway; it has to lie along
the run. In an 8″ box it fits either way, with room for GTO routing and hand
access. This is the physical reason the neon-era standard was larger, and it is
checkable geometry rather than folklore.

## Length

**The raceway spans the letter set.** Multiple sources say "runs the length of
the letters" / "spans the entire length of the letters". No source found states
a rule for extending *beyond* the outermost letters — see Open questions.

Shipping and splicing govern the sections:

- *"Always 10′ or shorter-length sections"* — Wheeler, [Graphics Pro](https://graphics-pro.com/feature/behind-the-letter-raceways-roles-in-channel-letter-projects/)
- *"Size continuous lengths up to 20′, then we butt splice as additional length is required"* — Jeffrey Stewart, Howard Industries, same source
- Available in 24′ lengths — Warren Sciortino, LetterFab, same source
- Stock extrusion sold in 12 ft lengths — [Howard Industries](https://www.howardindustries.com/sign-components/product/channel-letter-raceway)
- *"Lit Letter Signs over 10 feet long are divided into easily manageable sections"* that *"simply plug together as they are attached to the wall"* — [SignMonkey](https://signmonkey.com/products/face-lit-channel-letters-and-logos-on-raceway/)

**Implication for the tool:** a raceway longer than ~10 ft (3048 mm) implies a
splice, which is a fabrication and shipping fact worth surfacing the way the
tube-length limit already is.

## Material and gauge

| Component | Spec | Source |
|---|---|---|
| Fabricated raceway skin | **.050″ aluminum**, over a 1″ aluminum square-tube frame, brackets every 5′ | [Signfab](https://signfab.com/wireway-remote-or-raceway-whats-the-difference/) |
| Extruded raceway | **.125″ aluminum** | [Signfab](https://signfab.com/wireway-remote-or-raceway-whats-the-difference/) |
| Letter returns | .040″ (interior/small), **.063″ (exterior workhorse)**, .080″ (>36″ letters), .125″ (structural) | [Ascent Equipment](https://ascentequipment.com/channel-letter-materials-guide/) |
| Letter backs | .040″ or .063″ aluminum | [Ascent Equipment](https://ascentequipment.com/channel-letter-materials-guide/) |
| Alloys | 3003-H14 (bends easily, standard); 5052-H32 (stronger, large/outdoor) | [Ascent Equipment](https://ascentequipment.com/channel-letter-materials-guide/) |
| Coil widths | 2″–15″; most letters 3″–8″ deep | [Ascent Equipment](https://ascentequipment.com/channel-letter-materials-guide/) |

Extruded is preferred where heat matters:

> "Extruded aluminum is the best (because) it's an excellent heat sink to
> dissipate heat." — Stewart, Howard Industries

## Mounting

- **Letters → raceway:** double hanger bars on the raceway back
  ([Direct Sign Wholesale](https://www.directsignwholesale.com/blog/channel-letter-signs/raceway-mounted-channel-letters-guide/)); sliding brackets top and bottom (LetterFab); 2″-wide mounting clips ([Howard Industries](https://www.howardindustries.com/sign-components/product/channel-letter-raceway))
- **Raceway → building:** 4–8 anchors plus one electrical pass-through
- Letters are mounted to the raceway **in the shop**, so the assembly ships and
  hangs as one unit — *"one clean unit instead of leveling a pile of letters on
  a lift"*
- Default placement is **centered** on the letter span: *"tell us nothing and
  we center mount, every time"* ([DSW](https://www.directsignwholesale.com/blog/channel-letter-signs/raceway-mounted-channel-letters-guide/))
- Colour-matched to the **building**, not the brand. Wheeler recommends *"a
  color just a shade darker than the wall color"* so it recedes.

## Code and compliance

- UL certification on the assembly; a disconnect switch with a UL sticker
- Standard fit-out includes a three-way switch and a photo eye (Wheeler)
- Some municipalities require **wind-load engineering** documentation
- Protrusion limits are a common driver for choosing a wireway over a raceway

## Open questions

1. **Does the raceway extend past the outermost letters?** Every source says it
   "spans" or "runs the length of" the letters; none states whether it stops
   flush with the first and last letter or overhangs by a margin. Centered
   default placement is documented; the length rule is not. **Ask a shop before
   encoding a formula.**
2. **Raceway height as a function of letter height.** Wheeler says *"the height
   of the raceway is determined by the height of the letter"*, but no source
   gives the relation. One source lists "standard height options 18″, 21″, 24″"
   ([Tupps](https://tuppsigns.com/the-ultimate-guide-to-channel-letter-signs/)),
   but in context those are almost certainly **letter** heights, not raceway
   heights — a 24″-tall raceway would be extraordinary. Do not encode that
   figure as a raceway dimension.
3. **Modern neon-specific practice.** The 8″×8″ figure is described in the past
   tense by a forum contributor. Whether shops building neon today still use it,
   or have adopted a smaller box around modern electronic transformers, is
   unresolved.

## ⚠️ Terminology collision in the NeonBench codebase

Two distinct meanings of "raceway" are live in this repo, and one of them is
wrong:

1. `Guideline{Kind: "raceway"}` and `splitTubesAtRaceway` — a horizontal line
   where tubes are cut because below it they pass into the raceway. **Correct
   usage.**
2. `internal/printpdf/raceway.go` → `emitRacewayStrip` — despite the name, this
   emits a **combined channel-letter return strip**: it concatenates the
   unfolded *letter perimeter* bands of several faces onto one piece of coil
   stock, width = sum of perimeters, height = max letter depth. That is
   return-strip nesting, **not** a raceway. A raceway is one rectangular box
   sized to the sign's overall length and height; it follows no letter's
   perimeter.

The depths give the collision away: NeonBench's default `ChannelLetterDepthMM`
is 100 mm — how far the *letter* projects — while a neon raceway is ~203 mm
deep for the unrelated reason that a transformer has to fit inside. Two
objects, two depths, one name.

Renaming (2) to something like `emitNestedReturnStrip` would free the term for
a real raceway model. See `todo.md` NW #133.
