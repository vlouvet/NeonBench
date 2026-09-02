# Design notes

Why parts of NeonBench work the way they do. This is the *reasoning*
behind decisions a reader might otherwise assume were arbitrary — the
user-facing "how do I" lives in the [user manual](USER_MANUAL.md), and the
task backlog lives in [`todo.md`](../todo.md).

## Quantity takeoff and estimate

Each saved design version has an **Estimate** link, opening
`/projects/:id/versions/:vid/estimate`. The
**takeoff** half needs no prices at all and answers the ordering
question directly: net tube (what glows) against gross glass (what
leaves the supplier's shelf), grouped per diameter and colour, with
stick and splice counts derived from a configurable stick yield —
glass is bought in fixed lengths and cut down, so the length
consumed and the length purchased are different numbers. Also
electrode pairs, pumped sections, blockout linear feet, backing area
(labelled "bounding box", because a panel cut to the sign's
silhouette is smaller) and fabrication hours. The **estimate** half
applies a rate card and shows the cost side next to the price, so a
shop can see when a job has gone underwater rather than only what it
sells for. A "Quote sheet (PDF)" button renders a one-page
`estimate.pdf` — separate from `print.pdf` on purpose, since a
pattern goes to the bench and a quote goes to the customer.

**A missing rate is never treated as zero.** A rate card item's cost
is nullable: blank means "nobody has priced this", a typed `0` means
"deliberately free". Unpriced lines are *excluded* from the total
rather than counted at nothing, the estimate is flagged
**provisional** on screen and on the PDF, and a rate quoted in the
wrong unit (paint by the litre against a line measured in feet) is
rejected as **"wrong unit"** rather than silently multiplied. A
quote that quietly omits its most expensive line and still looks
complete is the failure this is built to prevent. Supplier minimum
orders are carried too, as an advisory purchase figure alongside
what the job actually draws — a one-off sign consuming 3 electrode
pairs against a 50-pair minimum should not put a case of electrodes
on the customer's quote.

---

Back to the [README](../README.md) · [Architecture](architecture.md)
