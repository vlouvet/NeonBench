// Package takeoff turns a design doc into the physical quantities a shop
// orders and bills against: how much glass leaves the supplier's shelf, how
// many electrode pairs get sealed, how much tube gets blacked out.
//
// It is deliberately money-free. Nothing here knows a price, a currency or a
// markup — that is internal/estimate's job, and keeping the split means the
// footage answer ("how much 12 mm do I need to order") is available to a shop
// that has never filled in a rate card.
//
// Everything is pure: no database, no HTTP, no clock. Given the same doc and
// the same inputs it returns the same numbers, which is what makes a printed
// quote reproducible.
package takeoff

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/vlouvet/neonbench/internal/designdoc"
)

// Unit conversions. NeonBench is mm-internally; suppliers and the ERP both
// speak feet and square feet. Convert once, here at the boundary, so no
// downstream code has to guess which unit it is holding.
const (
	MMPerFoot   = 304.8
	MM2PerSqFt  = 92903.04
	sqFtPerSqMM = 1 / MM2PerSqFt
)

// Miller's lead-in band (docs/neon-rules/electrodes.md:172, Miller p.124):
// 50–254 mm (2–10 in) between the electrode housing and the first decorative
// bend. Below 50 mm there is no room for the electrode's glass jacket; above
// 254 mm is wasteful and mechanically weak. The derived 2×diameter default is
// clamped into this band rather than trusted blindly — 2×12 mm is 24 mm, which
// is not a buildable lead-in.
const (
	MinLeadInFloorMM = 50.0
	MinLeadInCeilMM  = 254.0
)

// Line kinds. Closed set — the rate card keys on these, so adding one without
// a matching rate-card row means the line prices as unpriced, not as free.
const (
	KindTube          = "tube"
	KindElectrode     = "electrode"
	KindGasFill       = "gas_fill"
	KindTransformer   = "transformer"
	KindGTOCable      = "gto_cable"
	KindTubeSupport   = "tube_support"
	KindBootEndcap    = "boot_endcap"
	KindStandoffSet   = "standoff_set"
	KindBacking       = "backing"
	KindBlockoutPaint = "blockout_paint"
	KindLabourFab     = "labour_fabrication"
	KindLabourInstall = "labour_install"
	KindLabourDesign  = "labour_design"
	KindFreight       = "freight"
	KindMisc          = "misc"
)

// Units a line can carry. These match what the suppliers and Odoo already
// use, so a rate pulled from either drops in without conversion.
const (
	UnitFoot  = "ft"
	UnitSqFt  = "ft2"
	UnitSheet = "sheet"
	UnitPair  = "pair"
	UnitSet   = "set"
	UnitEach  = "each"
	UnitHour  = "hour"
	UnitLitre = "L"
)

// Provenance of a quantity. A shop reading an estimate needs to know which
// numbers came out of the drawing and which someone typed in.
const (
	SourceDerived = "derived"
	SourceManual  = "manual"
)

// Spec carries the tube-spec fields the takeoff needs. Deliberately a local
// struct rather than storage.TubeSpec: this package must not import storage,
// or it stops being testable without a database.
type Spec struct {
	DiameterMM  float64
	MinLeadInMM *float64 // nil = derive from diameter
}

// Yield describes how stock is bought and how much of each unit survives
// handling. Both glass and sheet goods are sold in fixed sizes and cut down,
// so the quantity consumed and the quantity purchased are different numbers.
//
// StickLengthMM defaults to 5 ft (1524 mm) — what FMS / Brillite actually
// ships, confirmed with the shop 2026-08-24. docs/neon-rules/segment-length.md
// records Miller's 46 in (1168 mm) blank with 6 in reserved per end; that is
// 1935 stock, and it is the origin of the waste allowance, not of the length.
// Both are fields precisely because the trade literature and the live supplier
// disagree and the supplier wins.
type Yield struct {
	StickLengthMM float64
	StickWasteMM  float64
	SheetAreaSqFt float64
}

// DefaultYield is the shop-floor default: 5 ft sticks, 6 in of handling waste,
// 4x8 sheet goods.
func DefaultYield() Yield {
	return Yield{StickLengthMM: 1524, StickWasteMM: 305, SheetAreaSqFt: 32}
}

// usableStickMM is what a bender actually gets out of one stick.
func (y Yield) usableStickMM() float64 {
	u := y.StickLengthMM - y.StickWasteMM
	if u <= 0 {
		// A waste allowance at or beyond the stick length is a
		// misconfiguration, not a physical fact. Fall back to the whole
		// stick rather than dividing by zero and reporting infinite glass.
		return y.StickLengthMM
	}
	return u
}

// Inputs are the quantities geometry cannot know. A drawing does not say
// whether the wall is brick or drywall, so install hours are typed in.
type Inputs struct {
	TransformerCount     float64    `json:"transformer_count,omitempty"`
	TransformerQualifier string     `json:"transformer_qualifier,omitempty"`
	GasQualifier         string     `json:"gas_qualifier,omitempty"`
	GasFillSections      *float64   `json:"gas_fill_sections,omitempty"` // nil = use derived pumped sections
	GTOCableFt           float64    `json:"gto_cable_ft,omitempty"`
	TubeSupportCount     *float64   `json:"tube_support_count,omitempty"` // nil = use derived support annotations
	BootEndcapCount      *float64   `json:"boot_endcap_count,omitempty"`  // nil = 2 per pumped section
	StandoffSetCount     float64    `json:"standoff_set_count,omitempty"`
	BackingSqFt          *float64   `json:"backing_sq_ft,omitempty"` // nil = bounding box
	InstallHours         float64    `json:"install_hours,omitempty"`
	DesignHours          float64    `json:"design_hours,omitempty"`
	Freight              float64    `json:"freight,omitempty"`
	Misc                 []MiscLine `json:"misc,omitempty"`
}

// MiscLine is an operator-added quantity with no geometric basis.
type MiscLine struct {
	Label string  `json:"label"`
	Qty   float64 `json:"qty"`
	Unit  string  `json:"unit"`
}

// Line is one priceable quantity.
//
// Qualifier narrows Kind — "12mm/green" against KindTube. The rate card
// matches exact (Kind, Qualifier) first, then (Kind, ""), then reports the
// line unpriced. NeonBench knows a run's diameter and colour; it does NOT know
// whether green is bought as coated tube or through-coloured glass, and it
// must not guess — that mapping is the rate card's job and a 7x price
// difference rides on it.
type Line struct {
	Kind      string  `json:"kind"`
	Qualifier string  `json:"qualifier,omitempty"`
	Label     string  `json:"label"`
	Qty       float64 `json:"qty"`
	Unit      string  `json:"unit"`
	Source    string  `json:"source"`
	// PurchaseQty is Qty rounded up to whole purchasable units where the
	// stock is indivisible — sticks of glass, sheets of acrylic. Zero when
	// the distinction does not apply. Never silently substituted for Qty:
	// the sign consumes Qty, the purchase order buys PurchaseQty, and a
	// one-off job is the case where they diverge most.
	PurchaseQty  float64 `json:"purchase_qty,omitempty"`
	PurchaseUnit string  `json:"purchase_unit,omitempty"`
}

// Summary is the geometry at a glance — what the quantity table shows before
// any price is involved.
type Summary struct {
	RunCount    int `json:"run_count"`
	JumperCount int `json:"jumper_count"`
	BendCount   int `json:"bend_count"`
	SpliceCount int `json:"splice_count"`
	StickCount  int `json:"stick_count"`

	// CircuitCount is the number of modelled circuits (Tier 2 #136).
	// omitempty is load-bearing: a doc with no circuits must serialise a
	// byte-identical takeoff, so this key only appears once circuits exist.
	CircuitCount int `json:"circuit_count,omitempty"`

	ElectrodeCount int `json:"electrode_count"`
	ElectrodePairs int `json:"electrode_pairs"`
	PumpedSections int `json:"pumped_sections"`
	HousingCount   int `json:"housing_count"`
	SupportCount   int `json:"support_count"`
	JumpCount      int `json:"jump_count"`

	NetTubeFt     float64 `json:"net_tube_ft"`
	GrossGlassFt  float64 `json:"gross_glass_ft"`
	JumperFt      float64 `json:"jumper_ft"`
	BlockoutFt    float64 `json:"blockout_ft"`
	ReturnStripFt float64 `json:"return_strip_ft"`

	BackingBBoxSqFt float64 `json:"backing_bbox_sq_ft"`
	BackingSheets   int     `json:"backing_sheets"`
	// BackingIsBBox records that BackingBBoxSqFt is a bounding box and
	// overestimates a shaped panel. The UI must say so rather than present
	// it as a cut area.
	BackingIsBBox bool `json:"backing_is_bbox"`

	FabricationHours float64 `json:"fabrication_hours"`
}

// CircuitSummary is one circuit's share of the job (Tier 2 #136): what a shop
// looks at when it asks "where is the glass going, and which of these boxes is
// the expensive one".
//
// NOTE what StickCount is and is not. Sticks are counted PER RUN, exactly as
// they were before circuits existed, and this field is the sum over the
// circuit's members — it is NOT ceil(circuit glass / usable stick). Two
// geometrically separate runs are two physical pieces of bent glass, and a
// 1219 mm usable stick that has yielded one 700 mm piece cannot also yield a
// second: ceiling the circuit total would order 3 sticks for four 700 mm
// letters that need 4. Under-ordering glass is a worse failure than
// over-ordering it. Nesting offcuts across runs is a cut-planning question
// this package does not model, and a wiring grouping is not the licence to
// answer it. See the PR body for Tier 2 #136.
type CircuitSummary struct {
	ID             string  `json:"id"`
	Name           string  `json:"name,omitempty"`
	RunCount       int     `json:"run_count"`
	ElectrodePairs int     `json:"electrode_pairs"`
	StickCount     int     `json:"stick_count"`
	NetTubeFt      float64 `json:"net_tube_ft"`
	GrossGlassFt   float64 `json:"gross_glass_ft"`
}

// Takeoff is the whole result: quantities at a glance, plus the priceable
// lines the estimate consumes.
type Takeoff struct {
	Summary Summary `json:"summary"`
	Lines   []Line  `json:"lines"`
	// Circuits is the per-circuit breakdown, in doc declaration order.
	// omitempty, and only populated when the doc models circuits, so a
	// pre-#136 doc's takeoff JSON is byte-identical.
	Circuits []CircuitSummary `json:"circuits,omitempty"`
	// Yield and LeadInMM are echoed so a printed takeoff records the
	// assumptions that produced it. A footage number without the stick
	// length that yielded it cannot be checked later.
	Yield    Yield   `json:"yield"`
	LeadInMM float64 `json:"lead_in_mm"`
}

// LabourModel carries the fabrication-time coefficients. They live on the rate
// card (a shop-specific calibration, not a trade rule) but the takeoff needs
// them to report hours, so they are passed in.
//
// The default 30 + 30/ft is an exact fit to the three neon BoM operation times
// in the shop's ERP (4 ft/150 min, 7 ft/240 min, 11 ft/360 min). Note the fit
// is against NET footage — the BoM line is a material line, so the basis is
// genuinely ambiguous, and if it turns out to mean gross the coefficients
// re-fit but the model does not change.
type LabourModel struct {
	SetupMinutes   float64
	MinutesPerFoot float64
}

// DefaultLabourModel returns the coefficients calibrated against the shop's
// existing BoM operation times.
func DefaultLabourModel() LabourModel {
	return LabourModel{SetupMinutes: 30, MinutesPerFoot: 30}
}

// EffectiveLeadInMM resolves the per-electrode lead-in allowance: the spec's
// override when set, otherwise 2x diameter, and in either case clamped into
// Miller's buildable band.
func EffectiveLeadInMM(spec Spec) float64 {
	v := 2 * spec.DiameterMM
	if spec.MinLeadInMM != nil && *spec.MinLeadInMM > 0 {
		v = *spec.MinLeadInMM
	}
	if v < MinLeadInFloorMM {
		return MinLeadInFloorMM
	}
	if v > MinLeadInCeilMM {
		return MinLeadInCeilMM
	}
	return v
}

// tubeGroup accumulates footage for one (diameter, colour) pair. Glass is
// ordered per diameter and per colour, and sticks are counted per run because
// an offcut cannot cross to another run without a splice.
type tubeGroup struct {
	diameterMM float64
	color      string
	netMM      float64
	sticks     int
	splices    int
}

func (g tubeGroup) qualifier() string {
	d := strings.TrimSuffix(strings.TrimRight(fmt.Sprintf("%.1f", g.diameterMM), "0"), ".")
	if g.color == "" {
		return d + "mm"
	}
	return d + "mm/" + g.color
}

// Compute derives every quantity the design implies.
func Compute(doc *designdoc.Doc, spec Spec, y Yield, lab LabourModel, in Inputs) Takeoff {
	t := Takeoff{Yield: y, LeadInMM: EffectiveLeadInMM(spec)}
	if doc == nil {
		return t
	}
	if y.StickLengthMM <= 0 || y.SheetAreaSqFt <= 0 {
		d := DefaultYield()
		if y.StickLengthMM <= 0 {
			y.StickLengthMM, y.StickWasteMM = d.StickLengthMM, d.StickWasteMM
		}
		if y.SheetAreaSqFt <= 0 {
			y.SheetAreaSqFt = d.SheetAreaSqFt
		}
		t.Yield = y
	}

	leadIn := t.LeadInMM
	usable := y.usableStickMM()

	groups := map[string]*tubeGroup{}
	var order []string
	var jumperMM, blockoutMM, returnStripMM float64

	// Tier 2 #136 — a circuit is ONE tube between ONE pair of electrodes,
	// spliced from as many runs as the layout needs. Every circuit therefore
	// gets an electrode BUDGET of designdoc.CircuitElectrodeCap, spent over
	// its member runs in declaration order; electrodes beyond it are splice
	// points, not tube ends, so they buy no pair, no boot, no gas fill and no
	// lead-in tail. Nothing here touches the document — the electrodes stay
	// exactly where the designer put them.
	//
	// A doc with no circuits allocates an empty map and every run takes the
	// original path below unchanged, which is what keeps the takeoff JSON
	// byte-identical for every design that predates this field.
	budget := make(map[string]int, len(doc.Circuits))
	for _, c := range doc.Circuits {
		budget[c.ID] = designdoc.CircuitElectrodeCap
	}
	circuits := make(map[string]*CircuitSummary, len(doc.Circuits))
	for i := range doc.Circuits {
		c := doc.Circuits[i]
		circuits[c.ID] = &CircuitSummary{ID: c.ID, Name: c.Name}
	}

	for _, run := range doc.Runs {
		pts := run.Polyline.Points
		if len(pts) < 2 {
			continue
		}
		idx, closed := designdoc.LiveArcIndices(run)
		liveMM := arcLengthMM(&run.Polyline, idx, closed)

		if run.Kind == "jumper" {
			// Jumpers are short splice tubes bridging two primary runs.
			// They consume glass but they are not part of the lit design:
			// counting them in net footage would inflate both the tube
			// order and the labour estimate, which is keyed off net feet.
			t.Summary.JumperCount++
			jumperMM += liveMM
			continue
		}

		t.Summary.RunCount++
		t.Summary.BendCount += len(designdoc.EffectiveBends(run, spec.DiameterMM))

		// Electrodes this run gets to CLAIM. Identical to the run's own list
		// unless it belongs to a circuit that has already spent its budget.
		elecs := run.Electrodes
		circuit := circuits[run.CircuitID]
		if run.CircuitID != "" {
			room := budget[run.CircuitID]
			if room < 0 {
				room = 0
			}
			if len(elecs) > room {
				elecs = elecs[:room]
			}
			budget[run.CircuitID] = room - len(elecs)
		}
		t.Summary.ElectrodeCount += len(elecs)
		if run.CircuitID == "" && len(elecs) >= 2 {
			// Pumped sections for circuit members are counted once per
			// circuit after the loop — a circuit is one pumped section
			// however many runs it is spliced from.
			t.Summary.PumpedSections++
		}
		for _, e := range elecs {
			if e.HousingType != "" {
				t.Summary.HousingCount++
			}
		}
		for _, a := range run.Annotations {
			switch a.Kind {
			case "support":
				t.Summary.SupportCount++
			case "jump":
				t.Summary.JumpCount++
			}
		}
		blockoutMM += blockoutLengthMM(&run.Polyline, idx, run.Blockouts)
		if run.IsChannelLetterFace {
			returnStripMM += polylinePerimeterMM(run.Polyline.FlatPoints(), run.Polyline.Closed)
		}

		// Glass ordered for this run includes the electrode tails at each
		// end, which are consumed but never glow.
		//
		// A free-standing run gets both tails as soon as it carries any
		// electrode at all — the pre-#136 rule, kept verbatim. A circuit
		// member gets one tail per electrode it actually claimed, so the
		// circuit's tails total two no matter how it was fragmented; the
		// interior ends are splices, and a splice has no lead-in.
		glassMM := liveMM
		switch {
		case run.CircuitID != "":
			glassMM += float64(len(elecs)) * leadIn
		case len(run.Electrodes) > 0:
			glassMM += 2 * leadIn
		}
		// Sticks stay PER RUN, deliberately. A circuit is a wiring grouping;
		// whether two runs can be cut from one stick is a separate
		// fabrication question, and answering it here would UNDER-order
		// glass — four 700 mm letters need four sticks, while
		// ceil(2800/1219) says three. See CircuitSummary.StickCount.
		sticks := int(math.Ceil(glassMM / usable))
		if sticks < 1 {
			sticks = 1
		}
		if circuit != nil {
			circuit.RunCount++
			circuit.StickCount += sticks
			// Accumulated in mm and converted to feet in one place after
			// the loop, the same way netMM / grossMM are — rounding each
			// run's contribution to feet first would drift.
			circuit.NetTubeFt += liveMM
		}

		dia := run.TubeDiameterMM
		if dia <= 0 {
			dia = spec.DiameterMM
		}
		key := fmt.Sprintf("%.3f|%s", dia, strings.ToLower(strings.TrimSpace(run.Color)))
		g := groups[key]
		if g == nil {
			g = &tubeGroup{diameterMM: dia, color: strings.ToLower(strings.TrimSpace(run.Color))}
			groups[key] = g
			order = append(order, key)
		}
		g.netMM += liveMM
		g.sticks += sticks
		g.splices += sticks - 1
	}

	sort.Strings(order)

	var netMM, grossMM float64
	for _, k := range order {
		g := groups[k]
		netMM += g.netMM
		grossMM += float64(g.sticks) * y.StickLengthMM
		t.Summary.StickCount += g.sticks
		t.Summary.SpliceCount += g.splices

		t.Lines = append(t.Lines, Line{
			Kind:         KindTube,
			Qualifier:    g.qualifier(),
			Label:        fmt.Sprintf("Tube %s", g.qualifier()),
			Qty:          round4(float64(g.sticks) * y.StickLengthMM / MMPerFoot),
			Unit:         UnitFoot,
			Source:       SourceDerived,
			PurchaseQty:  float64(g.sticks),
			PurchaseUnit: "stick",
		})
	}

	t.Summary.NetTubeFt = round4(netMM / MMPerFoot)
	t.Summary.GrossGlassFt = round4(grossMM / MMPerFoot)
	t.Summary.JumperFt = round4(jumperMM / MMPerFoot)
	t.Summary.BlockoutFt = round4(blockoutMM / MMPerFoot)
	t.Summary.ReturnStripFt = round4(returnStripMM / MMPerFoot)
	t.Summary.ElectrodePairs = ceilDiv(t.Summary.ElectrodeCount, 2)

	// One pumped section per circuit that spent a full pair, and the
	// per-circuit breakdown, in doc declaration order.
	if len(doc.Circuits) > 0 {
		t.Summary.CircuitCount = len(doc.Circuits)
		t.Circuits = make([]CircuitSummary, 0, len(doc.Circuits))
		for _, c := range doc.Circuits {
			cs := circuits[c.ID]
			if cs == nil {
				continue
			}
			spent := designdoc.CircuitElectrodeCap - budget[c.ID]
			if spent >= 2 {
				t.Summary.PumpedSections++
			}
			cs.ElectrodePairs = ceilDiv(spent, 2)
			cs.GrossGlassFt = round4(float64(cs.StickCount) * y.StickLengthMM / MMPerFoot)
			cs.NetTubeFt = round4(cs.NetTubeFt / MMPerFoot)
			t.Circuits = append(t.Circuits, *cs)
		}
	}

	if t.Summary.ElectrodePairs > 0 {
		t.Lines = append(t.Lines, Line{
			Kind: KindElectrode, Qualifier: diaLabel(spec.DiameterMM),
			Label: "Electrodes", Qty: float64(t.Summary.ElectrodePairs),
			Unit: UnitPair, Source: SourceDerived,
		})
	}
	if blockoutMM > 0 {
		t.Lines = append(t.Lines, Line{
			Kind: KindBlockoutPaint, Label: "Blockout paint",
			Qty: t.Summary.BlockoutFt, Unit: UnitFoot, Source: SourceDerived,
		})
	}

	// Backing: bounding box of the design. Overestimates a shaped panel, and
	// the sheet count overestimates again because acrylic is bought whole.
	// Both numbers are reported; neither is silently substituted for the other.
	bboxSqFt := doc.ViewBoxMM[2] * doc.ViewBoxMM[3] * sqFtPerSqMM
	t.Summary.BackingBBoxSqFt = round4(bboxSqFt)
	backingSqFt := bboxSqFt
	t.Summary.BackingIsBBox = true
	if in.BackingSqFt != nil && *in.BackingSqFt > 0 {
		backingSqFt = *in.BackingSqFt
		t.Summary.BackingIsBBox = false
	}
	if backingSqFt > 0 {
		sheets := int(math.Ceil(backingSqFt / y.SheetAreaSqFt))
		t.Summary.BackingSheets = sheets
		src := SourceDerived
		if !t.Summary.BackingIsBBox {
			src = SourceManual
		}
		t.Lines = append(t.Lines, Line{
			Kind: KindBacking, Label: "Backing panel",
			Qty: round4(backingSqFt), Unit: UnitSqFt, Source: src,
			PurchaseQty: float64(sheets), PurchaseUnit: UnitSheet,
		})
	}

	t.Lines = append(t.Lines, manualLines(t.Summary, in)...)

	// Fabrication hours off net footage — see LabourModel.
	mins := lab.SetupMinutes + lab.MinutesPerFoot*t.Summary.NetTubeFt
	if t.Summary.RunCount == 0 {
		mins = 0
	}
	t.Summary.FabricationHours = round4(mins / 60)
	if t.Summary.FabricationHours > 0 {
		t.Lines = append(t.Lines, Line{
			Kind: KindLabourFab, Label: "Fabrication labour",
			Qty: t.Summary.FabricationHours, Unit: UnitHour, Source: SourceDerived,
		})
	}
	if in.InstallHours > 0 {
		t.Lines = append(t.Lines, Line{Kind: KindLabourInstall, Label: "Installation labour",
			Qty: in.InstallHours, Unit: UnitHour, Source: SourceManual})
	}
	if in.DesignHours > 0 {
		t.Lines = append(t.Lines, Line{Kind: KindLabourDesign, Label: "Design / shop drawings",
			Qty: in.DesignHours, Unit: UnitHour, Source: SourceManual})
	}
	if in.Freight > 0 {
		t.Lines = append(t.Lines, Line{Kind: KindFreight, Label: "Freight / delivery",
			Qty: in.Freight, Unit: UnitEach, Source: SourceManual})
	}
	for _, m := range in.Misc {
		u := m.Unit
		if u == "" {
			u = UnitEach
		}
		t.Lines = append(t.Lines, Line{Kind: KindMisc, Label: m.Label,
			Qty: m.Qty, Unit: u, Source: SourceManual})
	}
	return t
}

// manualLines emits the hardware quantities that either come from an operator
// input or fall back to a geometric proxy.
func manualLines(s Summary, in Inputs) []Line {
	var out []Line

	sections := float64(s.PumpedSections)
	src := SourceDerived
	if in.GasFillSections != nil {
		sections, src = *in.GasFillSections, SourceManual
	}
	if sections > 0 {
		q := in.GasQualifier
		out = append(out, Line{Kind: KindGasFill, Qualifier: q, Label: "Gas fill",
			Qty: sections, Unit: UnitEach, Source: src})
	}

	if in.TransformerCount > 0 {
		out = append(out, Line{Kind: KindTransformer, Qualifier: in.TransformerQualifier,
			Label: "Transformer", Qty: in.TransformerCount, Unit: UnitEach, Source: SourceManual})
	}
	if in.GTOCableFt > 0 {
		out = append(out, Line{Kind: KindGTOCable, Label: "GTO cable",
			Qty: in.GTOCableFt, Unit: UnitFoot, Source: SourceManual})
	}

	supports, ssrc := float64(s.SupportCount), SourceDerived
	if in.TubeSupportCount != nil {
		supports, ssrc = *in.TubeSupportCount, SourceManual
	}
	if supports > 0 {
		out = append(out, Line{Kind: KindTubeSupport, Label: "Tube supports",
			Qty: supports, Unit: UnitEach, Source: ssrc})
	}

	// Two boots per pumped section — one over each electrode seal.
	boots, bsrc := float64(s.PumpedSections*2), SourceDerived
	if in.BootEndcapCount != nil {
		boots, bsrc = *in.BootEndcapCount, SourceManual
	}
	if boots > 0 {
		out = append(out, Line{Kind: KindBootEndcap, Label: "Silicone boots / endcaps",
			Qty: boots, Unit: UnitEach, Source: bsrc})
	}

	if in.StandoffSetCount > 0 {
		out = append(out, Line{Kind: KindStandoffSet, Label: "Standoffs",
			Qty: in.StandoffSetCount, Unit: UnitSet, Source: SourceManual})
	}
	return out
}

// arcLengthMM sums the polyline distance along idx, closing the loop when the
// arc is a full closed polyline rather than an electrode-bounded span.
// Takes the whole polyline rather than just its points because an arc segment
// is ~15.9% longer than its chord (Tier 3 #78). This number becomes glass
// footage and then the estimate, so measuring chords would under-order tube
// and under-bill every curved run.
func arcLengthMM(pl *designdoc.Polyline, idx []int, closed bool) float64 {
	var total float64
	for i := 1; i < len(idx); i++ {
		total += pl.WalkSegmentLengthMM(idx[i-1], idx[i])
	}
	if closed && len(idx) > 2 {
		total += pl.WalkSegmentLengthMM(idx[len(idx)-1], idx[0])
	}
	return total
}

// blockoutLengthMM sums the live-arc length covered by blackout paint.
// Blockout indices are positions WITHIN the live arc, matching the convention
// in designdoc.Blockout, so they are clamped against the arc and not the raw
// polyline.
func blockoutLengthMM(pl *designdoc.Polyline, idx []int, bos []designdoc.Blockout) float64 {
	n := len(idx)
	if n < 2 {
		return 0
	}
	var total float64
	for _, b := range bos {
		s, e := b.StartLiveIndex, b.EndLiveIndex
		if s > e {
			s, e = e, s
		}
		if s < 0 {
			s = 0
		}
		if e > n-1 {
			e = n - 1
		}
		for i := s + 1; i <= e; i++ {
			total += pl.WalkSegmentLengthMM(idx[i-1], idx[i])
		}
	}
	return total
}

func polylinePerimeterMM(pts [][2]float64, closed bool) float64 {
	var total float64
	for i := 1; i < len(pts); i++ {
		total += dist(pts[i-1], pts[i])
	}
	if closed && len(pts) > 2 {
		total += dist(pts[len(pts)-1], pts[0])
	}
	return total
}

func dist(a, b [2]float64) float64 { return math.Hypot(b[0]-a[0], b[1]-a[1]) }

func ceilDiv(a, b int) int {
	if a <= 0 || b <= 0 {
		return 0
	}
	return (a + b - 1) / b
}

func diaLabel(mm float64) string {
	return strings.TrimSuffix(strings.TrimRight(fmt.Sprintf("%.1f", mm), "0"), ".") + "mm"
}

// round4 keeps serialized quantities readable without rounding mid-calculation
// — every accumulation above happens in full precision first.
func round4(v float64) float64 { return math.Round(v*1e4) / 1e4 }
