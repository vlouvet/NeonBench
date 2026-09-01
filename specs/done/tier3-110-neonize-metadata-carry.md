# Tier 3 #110 — What Neonize's output should inherit

> **Status:** done · drafted 2026-09-01 · branch `task/110-neonize-metadata-carry`

> **Amendments discovered during implementation.** Every per-field call in the
> table below survived contact with the code and shipped as written. Two things
> about the spec did not:
>
> 1. **The `raceway_id` safety argument is too narrow.** The spec justifies
>    carrying it with "`groupByRaceway` buckets only runs that are both
>    face-flagged and raceway-tagged". That is true, and the per-run strip loop
>    in `internal/printpdf/render.go` gates on the face flag as well, so no
>    strip page can appear — the conclusion holds. But `RacewayID` has two more
>    consumers that do **not** gate on the face flag:
>    `RacewayMemberExtentMM` (`internal/designdoc/raceway.go`, which drives
>    raceway auto-fit and the two Tier 2 #104 validation rules) and
>    `racewayMembers` (`internal/printpdf/racewaypage.go`, which places the
>    member marks on the raceway plan page). So carrying `raceway_id` **is**
>    observable in output — the box now sizes to the offset tubes rather than
>    to the face outline they replaced, which is half a spacing wider on each
>    side. That is the right answer for the same reason those consumers ignore
>    the face flag in the first place (`racewayMembers`' non-face fallback
>    exists precisely for designs whose raceway members are tube pieces, not
>    face outlines), but "safe because nothing else reads it" was not why.
>
> 2. **The PDF test contradicts the file scope.** The Tests section asks for a
>    real `print.pdf` measurement while the scope section allows only
>    `docOps.ts` and `docOps.test.ts`; a strip-page count can only be taken from
>    Go. Resolved the way `AGENTS.md` prescribes for claims about shipped code:
>    with a throwaway probe (`internal/printpdf/zz_probe_test.go`, deleted
>    afterwards) fed the doc JSON the real TS `neonize` emits. One ungrouped
>    channel-letter face, spacing 20:
>
>    | doc | runs | face-flagged | full PDF | strips-only |
>    |---|---|---|---|---|
>    | before neonize | 1 | 1 | 5 pages | 1 page |
>    | after (shipped — flag not carried) | 2 | 0 | 4 pages | refused, `ErrNoStripsToRender` |
>    | after (hypothetical — flag carried) | 2 | 2 | 6 pages | 2 pages |
>
>    The bottom row is the bug this decision avoids: two return-strip pages for
>    metal nobody is cutting. The same probe confirmed the emitted doc — with
>    `raceway_id`, `group_id` and `kind` on it — decodes through
>    `DisallowUnknownFields` unchanged. The committed regression test asserts
>    the TS-side condition those page counts are a function of (no emitted run
>    carries the flag), which is the most the declared scope allows.

## Why this is a decision, not a bug fix

`neonize`'s local `withMeta` helper builds each emitted run from an explicit
allow-list — `tube_diameter_mm`, `color`, `notes` — and drops
`is_channel_letter_face`, `channel_letter_depth_mm`, `raceway_id`, `group_id`
and `kind`.

That is structurally the same incomplete allow-list as Bug #15 (`joinRuns`),
and it is the fifth instance of `CLAUDE.md` recurring bug class 1. **But the
fix is not "carry everything."** Bug #15 was unambiguous: joining two runs
yields a run of the same nature, so dropping a field was pure loss. Neonize is
different — it consumes a **face outline** and emits the **tube paths that
light it**. The output is a different kind of object from the input, so each
field needs its own answer.

## The per-field call (made 2026-09-01)

| Field | Carry? | Why |
|---|---|---|
| `is_channel_letter_face` | **NO** | The emitted runs are glass, not sheet metal. Carrying it would flag tubes as faces and generate **spurious return-strip pages** — a fabrication drawing for a part that does not exist. This is the one where carrying would actively break output. |
| `channel_letter_depth_mm` | **NO** | It describes how far the *face* projects. Meaningless on a tube, and it only has effect alongside the face flag anyway. |
| `group_id` | **YES** | The offsets belong to the same logical letter as their source. Dropping it silently ejects freshly-generated geometry from the group the operator is working in. |
| `raceway_id` | **YES** | Those tubes really do terminate at that raceway. Safe: `groupByRaceway` buckets only runs that are **both** face-flagged and raceway-tagged, and the face flag is not carried, so this cannot produce a strip page. |
| `kind` | **YES** | Least-surprise. Neonizing a `jumper` is unusual, but if someone does, the result staying a jumper is more predictable than silently becoming live tube. |
| `direction` | **NO** | Matches `splitRun`, which deliberately does not carry it — the emitted path is not the same walk. |

If any of these disagrees with shop practice, the trade call wins — this is a
reasoned default, not a rule from `docs/neon-rules/`. Put each answer in a
comment at the field so a future reader sees the reasoning rather than a bare
list.

## Do it with the shared helper, carefully

Bug #15 introduced `carryRunClassification(to, a, b?)`. Neonize should **not**
just call it — the whole point above is that it needs a different subset. Add a
narrower variant, or give the helper an explicit field set, so the difference
between "join keeps everything" and "neonize keeps some" is expressed in code
rather than by two divergent allow-lists that will drift again.

## Strict file scope

**Modify:** `web/src/lib/docOps.ts` (`neonize`/`withMeta` and the carry helper),
`web/src/lib/docOps.test.ts`.

## Tests

- Neonizing a face-flagged run emits runs that are **not** face-flagged
- ...and therefore a `print.pdf` for that design gains **no** return-strip
  pages. Measure it against a real PDF — PR #140 established that a unit test
  is not enough for the strip-page path.
- `group_id`, `raceway_id`, `kind` survive to every emitted run, including the
  stitched-output variant
- `direction` is absent
- A source with none of these fields still emits clean runs (no `undefined`
  keys reaching the encoder — `DisallowUnknownFields` is unforgiving)
