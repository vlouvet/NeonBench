# Bug #08 — "electrode lead-in" warning is confusing when no electrodes are placed

> **Status:** active · drafted 2026-06-04 · found via Playwright OPEN-sign workflow test · **low priority / messaging — NOT a logic bug** · branch (when dispatched) `task/bug-08-leadin-wording`

## What was observed

In the default "OPEN" workflow test, the validator emitted:

> *electrode lead-in 18.6mm below recommended minimum 24.0mm — short lead-ins crack at the seal under handling and thermal cycling*

…even though **0 electrodes were placed** (every run showed `0/2 ⬥`). At first glance this reads like a false-positive: "why warn about an electrode lead-in when there are no electrodes?"

## Verdict: working as designed (verified) — fix the wording, not the logic

This is **intentional behavior**, confirmed in code. [`internal/validate/rules.go:609-613`](../../internal/validate/rules.go#L609):

> *"The validator only sees the live arc … so OPEN polyline endpoints are the electrode positions for this rule. Closed polylines have no electrodes by definition and are skipped."*

`checkMinLeadIn` ([rules.go:620](../../internal/validate/rules.go#L620)) walks inward from each **open-run endpoint**, accumulating straight length until the first real bend; if that's below the limit it warns **at the endpoint** ([rules.go:683-691](../../internal/validate/rules.go#L683)). The rationale is sound: every open run *will* get electrodes at its two ends, and a too-short straight lead-in there cracks at the seal — so flagging it **before** electrodes are placed is the correct, proactive behavior. (In the OPEN case the `O` is an open Hershey stroke whose two endpoints sit near the top with a short straight run before the curve — hence the 18.6mm lead-in.)

**So do not suppress the warning or gate it on placed electrodes** — that would remove useful early feedback. The only real problem is that the wording implies an electrode exists.

## Goal

Make the warning's wording unambiguous that it refers to a **run endpoint (where an electrode will sit)**, not a placed electrode — so users don't read it as a false-positive. Optionally surface the "endpoints are implicit electrode sites" model in the UI.

## Options (pick with user; recommend A)

- **A — reword the message only (smallest).** e.g. *"run-end lead-in 18.6mm below recommended minimum 24.0mm — the straight section at this run end (where an electrode will sit) is too short; short lead-ins crack at the seal…"*. One string in [rules.go:686-688](../../internal/validate/rules.go#L686). Keep `Rule: min_lead_in` and severity unchanged.
- **B — A, plus a UI affordance.** Also add a one-line hint near the validation group or a tooltip explaining that open-run endpoints are treated as future electrode positions. Touches the editor sidebar.
- **C — leave as-is.** Acceptable if the team considers "electrode lead-in" trade-standard terminology; then this spec just documents the rationale and is closed as won't-fix.

## Strict file scope (Option A)

**Modify:**
- `internal/validate/rules.go` — the `fmt.Sprintf` message in `checkMinLeadIn` ([:686](../../internal/validate/rules.go#L686)) only. **Do not** change the walk logic, the rule id, the severity, or `effectiveMinLeadInMM`.

**Don't touch:**
- The lead-in geometry/threshold logic — it's correct.
- Other rules' messages.

## Constraints

- Keep `Rule == "min_lead_in"` (consumers and tests key on it).
- Keep severity = warning.
- Don't change the numeric threshold or the closed-run skip.

## Tests

- Update `TestMinLeadInWarnsWhenTooShort` ([internal/validate/rules_test.go:33](../../internal/validate/rules_test.go#L33)) if it asserts on the message substring; assert the new wording. The rule's firing conditions and count must be unchanged (geometry behavior is untouched).

## Manual smoke test

1. App on :7373. Default "OPEN" (per bug-07 repro) with 0 electrodes.
2. The lead-in warning still fires, but its text clearly refers to a run end / future electrode site, not a placed electrode.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Note on overlap with Bug #07

After Bug #07 (smoothing Hershey glyphs) lands, the `O`'s endpoints may shift and this specific 18.6mm lead-in could change or disappear — but the wording issue is independent and worth fixing regardless. Sequence #08 after #07 and re-confirm the message on a still-short example.

## Workflow

1. Confirm Option A/B/C with the user.
2. Reword the message; update the test assertion.
3. Move this spec to `specs/done/`.
4. PR title: `Clarify min_lead_in warning wording for run endpoints (Bug #08)`.

## Report back

Under 150 words: PR URL, the old vs new message text, confirmation rule id/severity/firing conditions unchanged, test state, pre-merge state.
