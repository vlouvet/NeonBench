-- Rate cards: what a shop pays for the quantities internal/takeoff derives.
--
-- Two tables plus one column. `rate_cards` holds the shop-wide scalars (labour
-- rate, markup, and the stock geometry that decides how much glass a job
-- actually buys); `rate_card_items` holds one rate per takeoff line kind; and
-- `design_versions.estimate_inputs_json` carries the per-version quantities
-- geometry cannot derive.
--
-- WHY unit_cost IS NULLABLE, AND WHY THE SEED LEAVES IT NULL
--
-- NULL means "nobody has priced this yet" and forces the line to be reported
-- unpriced. 0.0 means "deliberately free". Collapsing the two produces an
-- estimate that quietly omits its most expensive line, which is the single
-- worst thing this feature could do. internal/estimate excludes unpriced lines
-- from totals rather than zeroing them into totals, and marks the whole
-- estimate provisional.
--
-- The seed therefore ships every material rate as NULL. NeonBench is
-- distributed as a binary to any shop; one shop's contract pricing does not
-- belong in a migration. What IS seeded is the kind -> SKU mapping, because
-- that is the part that needed human judgement and it is already settled.
--
-- The four scalars that DO get real values come from the shop's own ERP:
--   labour_rate_per_hour   48.00  -- mrp.workcenter "Artech Shop Labour"
--   labour_setup_minutes   30.0   -- exact fit to three neon BoM operation
--   labour_minutes_per_foot 30.0  --   times: 4ft/150min, 7ft/240min, 11ft/360min
--   markup_multiplier      2.22   -- mean of the neon SKUs' list / cost
--
-- CAUTION on markup_multiplier: 2.22 was derived from hand-typed estimates and
-- does NOT survive verified supplier prices -- the same products land near 40%
-- margin, not the 55% it implies. It is an editable default, never a fact.
-- internal/estimate computes implied margin from the numbers present.
--
-- STOCK GEOMETRY IS DATA, NOT CONSTANTS
--
-- Glass is bought in fixed-length sticks and cut down, so the length consumed
-- and the length purchased differ. docs/neon-rules/segment-length.md records
-- Miller (1935, p.58/p.115): 46 in blanks with 6 in reserved per end. That is
-- 1935 stock. The shop's actual supplier (FMS / Brillite) ships 5 ft sticks,
-- confirmed 2026-08-24, so stick_length_mm defaults to 1524 and carries
-- Miller's allowance forward as stick_waste_mm. Both are columns precisely
-- because the literature and the live supplier disagree.

-- +goose Up
CREATE TABLE rate_cards (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    name                    TEXT    NOT NULL UNIQUE,
    currency                TEXT    NOT NULL DEFAULT 'USD',
    is_default              INTEGER NOT NULL DEFAULT 0,

    markup_multiplier       REAL    NOT NULL DEFAULT 2.22,
    labour_rate_per_hour    REAL    NOT NULL DEFAULT 48.0,
    labour_setup_minutes    REAL    NOT NULL DEFAULT 30.0,
    labour_minutes_per_foot REAL    NOT NULL DEFAULT 30.0,

    stick_length_mm         REAL    NOT NULL DEFAULT 1524.0,
    stick_waste_mm          REAL    NOT NULL DEFAULT 305.0,
    sheet_area_sq_ft        REAL    NOT NULL DEFAULT 32.0,

    -- Provenance for the Odoo bridge (Tier 2 #82). NULL for a hand-edited
    -- card; 'odoo:<db>' plus a timestamp for a pulled one. Present now so
    -- #82 adds no columns.
    source                  TEXT,
    synced_at               TEXT,

    created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE rate_card_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    rate_card_id INTEGER NOT NULL REFERENCES rate_cards(id) ON DELETE CASCADE,
    -- Matches a takeoff line kind. Qualifier narrows it ('12mm/green');
    -- empty qualifier is the kind-wide fallback.
    kind         TEXT    NOT NULL,
    qualifier    TEXT    NOT NULL DEFAULT '',
    sku          TEXT,
    label        TEXT    NOT NULL,
    unit         TEXT    NOT NULL,
    unit_cost    REAL,             -- NULL = unpriced. See the header.
    min_qty      REAL    NOT NULL DEFAULT 0,
    pack_fee     REAL    NOT NULL DEFAULT 0,
    UNIQUE (rate_card_id, kind, qualifier)
);
CREATE INDEX idx_rate_card_items_card ON rate_card_items(rate_card_id);

ALTER TABLE design_versions ADD COLUMN estimate_inputs_json TEXT;

INSERT INTO rate_cards (name, is_default) VALUES ('Default (provisional)', 1);

-- Kind + SKU mapping seeded; every price left NULL on purpose.
INSERT INTO rate_card_items (rate_card_id, kind, qualifier, sku, label, unit, min_qty) VALUES
    (1, 'tube',            '',            'MAT-M52', 'Glass tubing',              'ft',   0),
    (1, 'electrode',       '',            'MAT-M55', 'Electrodes',                'pair', 0),
    (1, 'gas_fill',        '',            'MAT-M57', 'Gas fill',                  'each', 0),
    (1, 'transformer',     '',            'MAT-M58', 'Transformer',               'each', 0),
    (1, 'gto_cable',       '',            'MAT-M59', 'GTO cable',                 'ft',   0),
    (1, 'tube_support',    '',            'MAT-M60', 'Tube supports',             'each', 0),
    (1, 'boot_endcap',     '',            'MAT-M61', 'Silicone boots / endcaps',  'each', 0),
    (1, 'standoff_set',    '',            'MAT-M46', 'Standoffs',                 'set',  0),
    (1, 'backing',         '',            'MAT-M40', 'Backing panel',             'ft2',  0),
    (1, 'blockout_paint',  '',            'MAT-M62', 'Blockout paint',            'L',    0),
    (1, 'freight',         '',            NULL,      'Freight / delivery',        'each', 0),
    (1, 'misc',            '',            NULL,      'Miscellaneous',             'each', 0);

-- +goose Down
ALTER TABLE design_versions DROP COLUMN estimate_inputs_json;
DROP INDEX IF EXISTS idx_rate_card_items_card;
DROP TABLE IF EXISTS rate_card_items;
DROP TABLE IF EXISTS rate_cards;
