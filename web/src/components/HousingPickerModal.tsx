// HousingPickerModal — picks a stock shell or enters custom dimensions
// for one electrode (Tier 3 #62, NW #120 + #126). The modal stays
// agnostic of the doc / save flow; it just emits a HousingInput (or
// null = cancel) so the parent can dispatch setElectrodeHousing via
// editDoc and keep undo coherent.
//
// Layout:
//   - Title row with the run+electrode label.
//   - Tab strip: "Common" / "Custom".
//   - Common tab: "None" + the two HOUSING_LIBRARY entries as radios.
//   - Custom tab: bore-diameter + elevation number inputs (mm).
//   - Footer: Cancel / Save.
//
// Reusing the existing .modal-backdrop / .modal CSS in App.css keeps
// the file scope tight (no styles touched) and matches HersheyTextDialog.

import { useEffect, useState } from 'react';
import {
  HOUSING_LIBRARY,
  isStockHousing,
  type HousingType,
} from '../lib/housingLibrary';
import type { HousingInput } from '../lib/docOps';
import { NumericField } from './NumericField';

type Tab = 'common' | 'custom';

type Props = {
  // Initial values pulled from the electrode the user right-clicked,
  // so the modal opens "showing the current housing" rather than
  // resetting to None on every open.
  initial?: {
    housing_type?: HousingType;
    bore_diameter_mm?: number;
    elevation_mm?: number;
  };
  // Free-form caption (e.g. "run-1 · electrode 1 of 2") shown under
  // the dialog title to anchor the operator on which electrode is
  // being edited. The modal doesn't touch the doc; the caption is
  // pre-built by the parent.
  caption?: string;
  onCancel: () => void;
  onSave: (housing: HousingInput) => void;
};

export default function HousingPickerModal({
  initial,
  caption,
  onCancel,
  onSave,
}: Props) {
  const initialType: HousingType = initial?.housing_type ?? '';
  const initialTab: Tab = initialType === 'custom' ? 'custom' : 'common';
  const [tab, setTab] = useState<Tab>(initialTab);
  // Common-tab radio: '' (None) | 'shell-15' | 'shell-19'.
  const [stockChoice, setStockChoice] = useState<'' | 'shell-15' | 'shell-19'>(
    isStockHousing(initialType) ? initialType : '',
  );
  // Custom-tab inputs. Default bore picks the closer of the two stock
  // bores so the operator's first edit lands near a sensible value.
  const [boreMM, setBoreMM] = useState<string>(
    initial?.bore_diameter_mm != null && initial.bore_diameter_mm > 0
      ? String(initial.bore_diameter_mm)
      : '11.0',
  );
  const [elevationMM, setElevationMM] = useState<string>(
    initial?.elevation_mm != null && initial.elevation_mm > 0
      ? String(initial.elevation_mm)
      : '50',
  );
  const [error, setError] = useState<string | null>(null);

  // Esc closes the modal, matching every other dialog in the app.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function handleSave() {
    setError(null);
    const elevationNum = Number(elevationMM);
    const elevation = Number.isFinite(elevationNum) && elevationNum > 0 ? elevationNum : undefined;
    if (tab === 'common') {
      // 'None' (empty stockChoice) clears every housing field.
      onSave({
        housing_type: stockChoice,
        elevation_mm: stockChoice === '' ? undefined : elevation,
      });
      return;
    }
    const boreNum = Number(boreMM);
    if (!Number.isFinite(boreNum) || boreNum <= 0) {
      setError('Bore diameter must be a positive number (mm).');
      return;
    }
    onSave({
      housing_type: 'custom',
      bore_diameter_mm: boreNum,
      elevation_mm: elevation,
    });
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal housing-picker-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Electrode housing</h2>
        {caption && <p className="meta">{caption}</p>}
        <div className="housing-picker-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'common'}
            className={tab === 'common' ? 'tool-btn active' : 'tool-btn'}
            onClick={() => {
              setError(null);
              setTab('common');
            }}
          >
            Common
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'custom'}
            className={tab === 'custom' ? 'tool-btn active' : 'tool-btn'}
            onClick={() => {
              setError(null);
              setTab('custom');
            }}
          >
            Custom
          </button>
        </div>

        {tab === 'common' && (
          <div className="housing-picker-body">
            <p className="meta">
              Trade-standard porcelain housings. Pick "None" to clear an
              existing housing.
            </p>
            <label className="housing-picker-radio">
              <input
                type="radio"
                name="stock"
                checked={stockChoice === ''}
                onChange={() => setStockChoice('')}
              />
              <span>None (no housing)</span>
            </label>
            {(Object.keys(HOUSING_LIBRARY) as Array<keyof typeof HOUSING_LIBRARY>).map((key) => {
              const dims = HOUSING_LIBRARY[key];
              return (
                <label key={key} className="housing-picker-radio">
                  <input
                    type="radio"
                    name="stock"
                    checked={stockChoice === key}
                    onChange={() => setStockChoice(key)}
                  />
                  <span>
                    {dims.label}
                    {' '}
                    <span className="meta">
                      bore {dims.boreMM} mm · OD {dims.outsideMM} mm
                    </span>
                  </span>
                </label>
              );
            })}
            {stockChoice !== '' && (
              <label>
                Elevation (mm)
                <NumericField
                  min="0"
                  value={elevationMM}
                  onChange={(e) => setElevationMM(e.target.value)}
                />
              </label>
            )}
          </div>
        )}

        {tab === 'custom' && (
          <div className="housing-picker-body">
            <p className="meta">
              Custom housing — enter bore inner diameter and mounting
              elevation in millimeters.
            </p>
            <label>
              Bore diameter (mm)
              <NumericField
                min="0"
                value={boreMM}
                onChange={(e) => setBoreMM(e.target.value)}
                autoFocus
              />
            </label>
            <label>
              Elevation (mm)
              <NumericField
                min="0"
                value={elevationMM}
                onChange={(e) => setElevationMM(e.target.value)}
              />
            </label>
          </div>
        )}

        {error && <p className="error">{error}</p>}

        <div className="actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
