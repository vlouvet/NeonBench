# Tier 3 #143 — Should the double-back exemption window scale with the design?

> **Status:** active · drafted 2026-09-02 · branch `task/3-doubleback-window`
> · follow-up from Tier 1 #131

## Goal

`isDoubleBackHairpin` (`internal/validate/rules.go:509`) exempts a vertex from
bend-radius and sharp-angle errors when it looks like a deliberate 180° U-turn.
Its window is tube-relative:

```go
lookMM := math.Max(3*tubeDiameterMM, 10)
K      := int(math.Ceil(lookMM / stepMM))
...
if dist(points[prev], points[next]) > 4*tubeDiameterMM { return false }
```

So a wider tube looks further along the polyline **and** accepts a wider
separation between the flanks. The consequence, measured during #131: on the
OPEN fixture the error count still **falls** across the four seeded tube specs
(9, 7, 6, 5) after that row's fix, purely because a fatter tube reclassifies more
U-turns as intentional double-backs.

**Done** means somebody has decided whether that is correct, written the
reasoning down, and made the code match the decision.

## This is a modelling question, not a bug — do not "fix" it reflexively

There is a real argument for the current behaviour: a fatter tube genuinely
cannot turn as tightly, so what counts as a deliberate hairpin *should* scale
with the glass. #131 explicitly declined to change it and flagged it here
instead.

There is also a real argument against: the exemption is about **intent** —
did the designer mean this as a double-back? — and intent does not scale with
tube diameter. Under that reading the window should come from the design (or
from an explicit user mark) and the count should be diameter-stable.

**The deliverable is the decision plus its rationale, in the spec's Findings
section, before any code changes.** If the answer is "current behaviour is
correct", that is a successful outcome and the row closes by documenting it and
adding the test that pins it — which does not exist today.

Note that `hasUserDoubleback` already exists: the designer can mark a
double-back explicitly. That is evidence for the intent reading, and it means an
option here is to **narrow** the geometric heuristic and lean on the explicit
mark. Weigh it.

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-doubleback-window origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/validate/rules.go` — `isDoubleBackHairpin` only, and only if the
  decision calls for it.
- `internal/validate/` — tests pinning whichever behaviour is chosen.

**Don't touch:**

- `checkBendRadius` or its heat-zone estimator (Tier 1 #131).
- `checkSharpBendAngles`' step and cluster radius — that is Tier 1 #142, and it
  must land first because it changes `stepMM`, which feeds `K` here.
- `hasUserDoubleback`'s semantics.

## Sequencing

**Ships after Tier 1 #142.** That row changes where `stepMM` comes from, and `K`
is computed from it, so doing this first means measuring against a window that is
about to move.

## Deliverables

1. The written decision, with a sweep across the four seeded tube specs on a
   fixture whose double-backs are known by construction.
2. Whatever code change the decision justifies — possibly none.
3. A test pinning the exemption's behaviour across tube specs, which is missing
   today either way.

## Report back

PR URL, the decision and its reasoning in a few sentences, the before/after
sweep, and whether you changed code or only documented and pinned.
