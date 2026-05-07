# Tier 3 #30 — Glass-to-grounded-metal / HV-cable spacing

> **Status:** **BLOCKED** — design draft only · branch (when unblocked) `task/30-hv-cable-spacing`

## Why this is blocked

The validator rule we want to add is: **the live tube must maintain a minimum clearance from any grounded conductive substrate (cabinet wall, raceway frame, mounting screws) and from any HV cable run.** Per Miller App I §103, NEC Article 600, and Saving Neon Ch.4, the standard clearance is ½″ glass-to-metal and 1½″ HV-cable-to-metal at 9 kV transformers (scales with secondary voltage).

To enforce this, the design doc needs a model of:

1. **The cabinet / substrate footprint** — where is the metal? Today the design doc has runs + labels + dimensions, but no representation of the surrounding box.
2. **HV cable routing** — where do the high-voltage leads run between the transformer and the electrodes? Today electrodes are points; the cable that connects them isn't modeled.
3. **Transformer position(s)** — needed to anchor the cable routing.

None of these exist in `internal/designdoc/types.go` today. Building this rule on hand-waved approximations would produce false positives that train users to ignore the validator.

**Do not dispatch this spec for implementation.** Instead, treat it as the design contract that lights up the day a cabinet/HV-routing model lands.

## Prerequisite work (split into separate Tier 3 rows when ready)

Before this rule can ship, we need three model additions:

### A. Cabinet outline

Extend `Doc` with an optional `Cabinet` struct:

```go
type Cabinet struct {
    Polygon Polyline    `json:"polygon"`             // closed; mm
    MaterialMM float64  `json:"material_mm,omitempty"` // wall thickness
    IsGrounded bool     `json:"is_grounded"`         // typically true for steel raceways
}
```

The user draws this on the canvas as a separate "Cabinet" tool. Existing screw/bolt mounts can be a follow-up after the basic outline lands.

### B. Transformer placement

Add a `Transformer` model with position, secondary voltage, and which electrodes it feeds:

```go
type Transformer struct {
    XMM, YMM        float64
    SecondaryKV     float64        // 9, 12, 15, 30 kV typical
    ElectrodeRefs   []ElectrodeRef // (run_id, electrode_index) pairs
}
```

### C. HV cable routing

Lines connecting each transformer secondary terminal to its electrodes — either auto-routed (axis-aligned with sensible bends) or user-drawn:

```go
type HVCable struct {
    TransformerIndex int
    ElectrodeRef     ElectrodeRef
    Polyline         Polyline       // mm
}
```

Each prerequisite is its own ~200-line spec. They likely need editor canvas tools (cabinet drawing, transformer placement, cable routing) which puts them in heavy contention with `EditorCanvas.tsx` — coordinate carefully when the time comes.

## What the rule looks like (when prerequisites land)

**Severity:** error (this is a UL/NEC compliance issue, not a stylistic preference).

**Algorithm:**

1. Sample each run's polyline at uniform 10 mm steps (use existing `resampleUniform`).
2. For each sampled point, compute distance to:
   - The nearest edge of `Cabinet.Polygon`.
   - Each `HVCable.Polyline` segment.
3. Required clearance:
   - Glass-to-cabinet: `0.5" = 12.7 mm` baseline; scales with voltage above 9 kV (suggest +1 mm per kV — confirm with Miller's table).
   - Glass-to-HV-cable: `1.5" = 38.1 mm` at 9 kV; scales similarly.
4. If any sample point is below the required clearance, emit an `Issue{Rule: RuleHVSpacing, Severity: SeverityError, ...}` at that location.

`RuleHVSpacing` constant lives in `internal/validate/types.go` once the rule lands.

## File scope (when unblocked)

- `internal/validate/rules.go` — `checkHVSpacing(...)` implementation.
- `internal/validate/types.go` — rule constant + Limits fields.
- `internal/validate/rules_test.go` — tests.
- `internal/designdoc/types.go` — assumed already extended by prerequisite specs; this rule consumes those types.

## Tests (when unblocked)

- Synthetic doc with a tube 5 mm from the cabinet edge → error.
- Same doc, tube 20 mm away → no issue.
- Tube 30 mm from an HV cable at 9 kV → error (need 38.1 mm).
- 12 kV transformer raises the threshold; assert.

## Workflow

1. **Wait for prerequisites A, B, C.** Each will have its own Tier 3 row when filed.
2. When all three have shipped to main, re-read this spec, fill in the file scope with the actual type names that landed, and dispatch as `task/30-hv-cable-spacing`.
3. Pre-merge + smoke.
4. PR titled "HV-cable / glass-to-metal spacing rule (Tier 3 #30)".
5. **Move this spec** to `specs/done/`.

## Report back (when implementation completes)

Under 250 words. Include: PR URL, voltage scaling formula chosen, citation sources, edge cases (tube tangent to cabinet edge), CI state, follow-ups (per-shop policy override, multi-transformer coordination).

## Note for the parent agent reading this

If a user asks "why isn't HV spacing checked?" — the answer is: the cabinet/HV-routing model isn't in the design doc yet, and a clearance check on a hand-waved cabinet would produce useless markers. The honest path is to build the model first, then enable the rule.
