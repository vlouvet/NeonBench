// Tier 2 #99 / NW #20 — set text in the customer's own OpenType face.
//
// WHY A SIBLING DIALOG AND NOT A TAB IN HersheyTextDialog. The spec left
// the choice open. Three reasons it went this way:
//
//  1. The OUTPUT is a different kind of thing. Hershey emits OPEN
//     single-stroke runs; this emits CLOSED outline contours. They take
//     different insert paths (`closed: true`, counters, the face flag),
//     so a shared dialog would be a shared shell over two disjoint
//     bodies.
//  2. HersheyTextDialog is already ~1000 lines of single-stroke-specific
//     machinery — per-pair kerning handles, optical kerning, slant,
//     vertical stacking, text-on-an-arc — none of which applies here and
//     all of which would have to grow an "if outline" branch.
//  3. The distinction is the thing operators most need to see. Two
//     buttons named "Add text" and "Add outline text", each with its own
//     explanation, teaches it; one dialog with a hidden mode does not.
//
// THE MISTAKE THIS UI EXISTS TO PREVENT: an operator types their brand
// name in Helvetica, inserts it, bends it as drawn, and gets TWO TUBES
// PER STROKE — because an outline is the boundary of the ink, not the
// centre of a tube. Hershey strokes are centrelines and go straight to
// glass. Outlines must go on to Neonize (offset to a parallel pair) or
// become a channel-letter face. The blurb, the "What happens next"
// picker and the preview caption all say so; do not quietly trim them.
//
// Bundled fonts: none, ever. See `lib/fonts/face.ts` for why.

import { useMemo, useState } from 'react';
import {
  FontLoadError,
  describeLicence,
  loadFace,
  type LoadedFace,
} from '../lib/fonts/face';
import { DEFAULT_CHORD_TOLERANCE_MM } from '../lib/fonts/flatten';
import { MIN_CHORD_TOLERANCE_MM } from '../lib/fonts/outline';
import {
  outlineRunsBBox,
  outlineTextToRuns,
  type OutlineRun,
} from '../lib/fonts/text';
import type { DesignRun } from '../api';
import { NumericField } from './NumericField';

type Props = {
  onCancel: () => void;
  /** Receives closed outline runs plus the cap height (mm) the operator
   *  asked for. The parent recentres into doc coordinates and appends —
   *  same division of labour as HersheyTextDialog / the channel-letter
   *  wizard. */
  onInsert: (runs: DesignRun[], capHeightMM: number) => void;
};

/** What the operator intends to do with the outlines. Neither option
 *  bends as drawn, and the dialog says which is which. */
type NextStep = 'outlines' | 'face';

const PREVIEW_W = 360;
const PREVIEW_H = 190;
const MAX_TEXT_LEN = 128;
const DEFAULT_CAP_MM = 100;
const ACCEPT = '.ttf,.otf,.woff,font/ttf,font/otf,font/woff';

export default function OutlineTextDialog({ onCancel, onInsert }: Props) {
  const [face, setFace] = useState<LoadedFace | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState('');
  const [capHeightMM, setCapHeightMM] = useState(DEFAULT_CAP_MM);
  const [letterSpacingMM, setLetterSpacingMM] = useState(0);
  const [lineHeight, setLineHeight] = useState(1.2);
  const [chordToleranceMM, setChordToleranceMM] = useState(DEFAULT_CHORD_TOLERANCE_MM);
  const [applyKerning, setApplyKerning] = useState(true);
  const [nextStep, setNextStep] = useState<NextStep>('outlines');

  async function pickFont(file: File | undefined) {
    if (!file) return;
    setLoading(true);
    setLoadError(null);
    try {
      const buf = await file.arrayBuffer();
      setFace(loadFace(buf, file.name));
    } catch (err) {
      setFace(null);
      setLoadError(
        err instanceof FontLoadError
          ? err.message
          : `Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }

  const layout = useMemo(() => {
    if (!face || text.trim() === '') return null;
    return outlineTextToRuns({
      face,
      text,
      capHeightMM,
      letterSpacingMM,
      lineHeight,
      chordToleranceMM,
      applyKerning,
    });
  }, [face, text, capHeightMM, letterSpacingMM, lineHeight, chordToleranceMM, applyKerning]);

  const runs = useMemo(() => layout?.runs ?? [], [layout]);
  const bbox = useMemo(() => outlineRunsBBox(runs), [runs]);

  const previewViewBox = useMemo(() => {
    if (!bbox) return `0 0 ${PREVIEW_W} ${PREVIEW_H}`;
    const w = Math.max(bbox.maxX - bbox.minX, 1);
    const h = Math.max(bbox.maxY - bbox.minY, 1);
    const pad = Math.max(w, h) * 0.08;
    return `${bbox.minX - pad} ${bbox.minY - pad} ${w + pad * 2} ${h + pad * 2}`;
  }, [bbox]);

  // One <path> per glyph so `fill-rule: evenodd` can knock the counter
  // out of its parent. Drawing each contour as its own filled shape
  // would paint the hole of an 'o' solid, which is exactly the
  // misunderstanding this dialog is trying to head off.
  const glyphPaths = useMemo(() => groupIntoGlyphPaths(runs), [runs]);

  const vertexCount = runs.reduce((n, r) => n + r.points.length, 0);
  const counterCount = runs.filter((r) => r.role === 'counter').length;
  const canInsert = Boolean(face) && runs.length > 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canInsert) return;
    onInsert(toDesignRuns(runs, nextStep), capHeightMM);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal hershey-modal"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Outline text from an OpenType font"
        // This dialog carries more controls than its siblings (a file
        // picker, five numeric fields, the next-step choice, a preview
        // and a warnings list). `.modal` in App.css sets no height
        // bound, so on a 1000 px viewport the Insert button rendered
        // BELOW THE FOLD and could not be clicked — caught by the
        // browser smoke test, invisible to every unit test. Scroll the
        // body and pin the actions. Inline rather than in App.css
        // because parallel tasks own the shared stylesheet.
        style={{ maxHeight: '90vh', overflowY: 'auto' }}
      >
        <h2>Outline text (OpenType / TrueType)</h2>
        <p className="meta hershey-modal-blurb">
          <strong>These are outlines, not tube paths.</strong> "Add text" draws
          Hershey single-stroke letters, where every stroke is already the
          centreline a bender follows. An OpenType glyph is the <em>edge of
          the ink</em> — bend it as drawn and you get two tubes per stroke. Set
          the word here, then either <strong>Neonize</strong> each contour into
          a parallel tube pair or use it as a <strong>channel-letter face</strong>.
        </p>

        <form onSubmit={submit} onKeyDown={onKey}>
          <label>
            Font file (.ttf, .otf, .woff)
            <input
              type="file"
              accept={ACCEPT}
              onChange={(e) => void pickFont(e.target.files?.[0])}
              style={{ width: '100%' }}
            />
          </label>
          <p className="meta">
            NeonBench ships no fonts. Load the customer&apos;s licensed file from
            this machine — it is parsed in the browser and never uploaded or
            stored. macOS system faces are usually <code>.ttc</code> collections,
            which are not readable; export a single <code>.ttf</code>/<code>.otf</code>.
          </p>
          {loading && <p className="meta">Reading font…</p>}
          {loadError && (
            <p className="meta" role="alert" style={{ color: '#ff8a65' }}>
              {loadError}
            </p>
          )}
          {face && (
            <>
              <p className="meta">
                <strong>
                  {face.familyName} {face.styleName}
                </strong>{' '}
                · {face.numGlyphs} glyphs · {face.unitsPerEm} units/em · cap
                height {face.capHeight.capHeightUnits.toFixed(0)} units from{' '}
                {capHeightSourceLabel(face)}
              </p>
              <p className="meta">{describeLicence(face)}</p>
            </>
          )}

          <label>
            Text
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, MAX_TEXT_LEN))}
              placeholder="OPEN"
              rows={2}
              maxLength={MAX_TEXT_LEN}
              disabled={!face}
              style={{ width: '100%' }}
            />
          </label>
          <label>
            Cap height (mm) — the measured height of a capital H
            <NumericField
              min={1}
              value={capHeightMM}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0) setCapHeightMM(v);
              }}
            />
          </label>
          <label>
            Letter spacing (mm)
            <NumericField
              value={letterSpacingMM}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) setLetterSpacingMM(v);
              }}
            />
          </label>
          <label>
            Line height (× cap height)
            <NumericField
              min={0.5}
              value={lineHeight}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0) setLineHeight(v);
              }}
            />
          </label>
          <label>
            Curve tolerance (mm) — how far a flattened curve may stray
            <NumericField
              min={MIN_CHORD_TOLERANCE_MM}
              value={chordToleranceMM}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0) setChordToleranceMM(v);
              }}
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={applyKerning}
              onChange={(e) => setApplyKerning(e.target.checked)}
              style={{ marginRight: 4 }}
            />
            Use the font&apos;s own kerning pairs
          </label>

          <fieldset style={{ border: '1px solid #333', padding: '8px 10px', margin: '8px 0' }}>
            <legend className="meta">What happens next</legend>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="radio"
                name="outline-next-step"
                checked={nextStep === 'outlines'}
                onChange={() => setNextStep('outlines')}
              />
              Insert as plain closed outlines — then select each and{' '}
              <strong>Neonize</strong> it into a parallel tube pair.
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="radio"
                name="outline-next-step"
                checked={nextStep === 'face'}
                onChange={() => setNextStep('face')}
              />
              Insert as <strong>channel-letter faces</strong> — the print PDF
              emits an unfolded return strip per contour, counters included.
            </label>
          </fieldset>

          <div className="hershey-preview" aria-label="Outline text preview">
            <svg
              width={PREVIEW_W}
              height={PREVIEW_H}
              viewBox={previewViewBox}
              preserveAspectRatio="xMidYMid meet"
              style={{ touchAction: 'none', background: '#1c1c1c' }}
            >
              {glyphPaths.map((d, i) => (
                <path
                  key={`glyph-${i}`}
                  d={d}
                  fillRule="evenodd"
                  fill="#2f4858"
                  stroke="#7fd1ff"
                  strokeWidth={Math.max(capHeightMM * 0.008, 0.3)}
                  strokeLinejoin="round"
                />
              ))}
            </svg>
            <p className="meta hershey-preview-meta">
              {runs.length} contour{runs.length === 1 ? '' : 's'}
              {counterCount > 0 && ` (${counterCount} counter${counterCount === 1 ? '' : 's'})`}
              {' · '}
              {vertexCount} vertices
              {bbox && ` · ${(bbox.maxX - bbox.minX).toFixed(0)}mm wide`}
            </p>
            <p className="meta hershey-preview-meta">
              Filled here only so counters read as holes. Nothing above is a
              tube yet.
            </p>
          </div>

          {layout?.warnings.map((w, i) => (
            <p className="meta" key={`warn-${i}`} style={{ color: '#ffb74d' }}>
              {w}
            </p>
          ))}

          <div
            className="actions"
            style={{
              position: 'sticky',
              bottom: 0,
              background: 'var(--panel)',
              paddingTop: '0.5rem',
            }}
          >
            <button type="button" className="btn-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="submit"
              className={`btn-primary ${canInsert ? '' : 'disabled'}`}
              disabled={!canInsert}
            >
              {nextStep === 'face' ? 'Insert as faces' : 'Insert outlines'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function capHeightSourceLabel(face: LoadedFace): string {
  switch (face.capHeight.source) {
    case 'measured-H':
      return "this face's own 'H' outline";
    case 'os2-sCapHeight':
      return 'the OS/2 table';
    default:
      return 'a fraction of the em (approximate)';
  }
}

/** Group contours back into their source glyph and emit one SVG path
 *  data string each, so `fill-rule="evenodd"` can cut the counters out. */
function groupIntoGlyphPaths(runs: OutlineRun[]): string[] {
  const byGlyph = new Map<string, OutlineRun[]>();
  for (const r of runs) {
    const key = `${r.lineIndex}:${r.glyphIndex}`;
    const bucket = byGlyph.get(key);
    if (bucket) bucket.push(r);
    else byGlyph.set(key, [r]);
  }
  const out: string[] = [];
  for (const bucket of byGlyph.values()) {
    let d = '';
    for (const r of bucket) {
      r.points.forEach(([x, y], i) => {
        d += `${i === 0 ? 'M' : 'L'}${x.toFixed(3)} ${y.toFixed(3)} `;
      });
      d += 'Z ';
    }
    out.push(d.trim());
  }
  return out;
}

/**
 * Outline runs → DesignRuns. Ids are placeholders: `appendRuns` rewrites
 * every one of them, which is the repo's rule for never reusing an id.
 *
 * The channel-letter flag goes on EVERY contour, counters included, and
 * that is deliberate: a channel-letter 'O' is built with an outer return
 * AND an inner return around the counter, so both perimeters need a
 * strip page. Flagging only the outer would silently short the
 * fabricator a piece of metal.
 */
function toDesignRuns(runs: OutlineRun[], nextStep: NextStep): DesignRun[] {
  return runs.map((r) => {
    const run: DesignRun = {
      id: 'otf',
      polyline: { points: r.points, closed: true },
      notes: `${r.char} · ${r.role}`,
    };
    if (nextStep === 'face') run.is_channel_letter_face = true;
    return run;
  });
}
