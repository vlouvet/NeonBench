package printpdf

// Paper describes a sheet of paper in millimeters (always portrait;
// orientation is a separate flag at render time).
type Paper struct {
	Name             string
	WidthMM, HeightMM float64
}

var (
	PaperLetter  = Paper{"Letter", 215.9, 279.4}
	PaperLegal   = Paper{"Legal", 215.9, 355.6}
	PaperTabloid = Paper{"Tabloid", 279.4, 431.8}
	PaperA4      = Paper{"A4", 210, 297}
	PaperA3      = Paper{"A3", 297, 420}
	PaperA2      = Paper{"A2", 420, 594}
)

var allPapers = []Paper{
	PaperLetter, PaperLegal, PaperTabloid,
	PaperA4, PaperA3, PaperA2,
}

// PaperByName returns a paper size by case-insensitive name. Returns zero
// value and false if not recognized.
func PaperByName(name string) (Paper, bool) {
	for _, p := range allPapers {
		if equalFoldASCII(p.Name, name) {
			return p, true
		}
	}
	return Paper{}, false
}

func equalFoldASCII(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if ca >= 'A' && ca <= 'Z' {
			ca += 32
		}
		if cb >= 'A' && cb <= 'Z' {
			cb += 32
		}
		if ca != cb {
			return false
		}
	}
	return true
}
