// Stock electrode-housing dimensions library. Tier 3 #62 (NW #120 + #126).
//
// "Common Housings" (NW #120) is the trade-standard porcelain/ceramic
// shell that holds the spring contact at the cabinet end of an
// electrode lead-in. Two sizes account for ~95% of installs per
// Strattman NT Ch.3 Table 3.4:
//
//   - 15-shell: 3/8" × 1-5/16"  →  bore 9.5 mm, outside 33.3 mm
//   - 19-shell: 1/2" × 1-5/8"   →  bore 12.7 mm, outside 41.3 mm
//
// "Create Custom Housings" (NW #126) lets the operator override with
// any positive bore diameter (the housing-picker UI feeds this through
// the Electrode.bore_diameter_mm field). For the stock shells, the
// library is the source of truth — bore_diameter_mm on the doc is
// ignored when housing_type is "shell-15" or "shell-19".
//
// Citation: Strattman, "Neon Techniques and Handling," Ch.3 — table of
// common housing shells used in domestic and architectural sign work.

export type HousingType = '' | 'shell-15' | 'shell-19' | 'custom';

export const HOUSING_LIBRARY = {
  'shell-15': {
    boreMM: 9.5,
    outsideMM: 33.3,
    label: '15-shell (3/8" x 1-5/16")',
  },
  'shell-19': {
    boreMM: 12.7,
    outsideMM: 41.3,
    label: '19-shell (1/2" x 1-5/8")',
  },
} as const;

export type StockHousingKey = keyof typeof HOUSING_LIBRARY;

// ElectrodeWithHousing extends the (deliberately minimal) Electrode shape
// in api.ts with the three new optional housing fields. The parallel
// agent for Tier 3 #51 owns api.ts this round, so rather than widening
// that type inline we surface a local wider view here. Callers that need
// to read or write housing fields cast through this view; the JSON
// round-trip is transparent because the design-doc blob carries
// whatever extra keys we add.
export type ElectrodeWithHousing = {
  point_index: number;
  housing_type?: HousingType;
  bore_diameter_mm?: number;
  elevation_mm?: number;
};

// HousingDims is the resolved dimensions for an electrode's housing.
// `boreMM === 0` is the sentinel for "no housing configured" and means
// the 3D preview / print PDF should omit any housing-specific render.
export type HousingDims = {
  boreMM: number;
  outsideMM: number;
  label: string;
};

const NO_HOUSING: HousingDims = { boreMM: 0, outsideMM: 0, label: 'None' };

// resolveHousing returns the dimensions for a given housing configuration.
//
// - housing_type === ''       → NO_HOUSING (boreMM = 0, label "None").
// - housing_type === stock    → library lookup (operator-supplied
//                               bore is ignored; the library wins).
// - housing_type === 'custom' → operator-supplied bore + label "Custom"
//                               (outsideMM heuristic = bore + 24 mm,
//                               matching the bore→outside gap in the
//                               two stock shells; the print + 3D
//                               renders use bore primarily, so the
//                               outsideMM here is just a render hint).
export function resolveHousing(
  housingType: string | undefined,
  boreDiameterMM?: number,
): HousingDims {
  if (!housingType) return NO_HOUSING;
  if (housingType === 'shell-15' || housingType === 'shell-19') {
    return { ...HOUSING_LIBRARY[housingType] };
  }
  if (housingType === 'custom') {
    const bore = boreDiameterMM ?? 0;
    return { boreMM: bore, outsideMM: bore + 24, label: 'Custom' };
  }
  return NO_HOUSING;
}

// isStockHousing returns true if the key is a stock-library entry.
// Used by the picker UI to choose the "Common" tab vs "Custom" tab
// when re-opening on an existing electrode with a housing already set.
export function isStockHousing(housingType: string | undefined): housingType is StockHousingKey {
  return housingType === 'shell-15' || housingType === 'shell-19';
}
