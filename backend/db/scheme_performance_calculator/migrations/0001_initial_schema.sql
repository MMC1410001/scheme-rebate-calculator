-- Initial schema spi. See ../README.md. Schema spi only: it can live in its own database or in an existing one
-- shared with other apps (dev's app_db, user's choice 5 Nov 2026); nothing outside the schema is created or changed.
-- Raw dealer measures are float8: the file's own Excel doubles, kept exact so results match the files.

-- With two logins (spi_owner runs migrations and loads, spi_app the API), the app's login reads and writes data and
-- never changes the schema; set before the tables so all get it. With one login for both (an existing database
-- where no spi_app role exists), that login owns every table and needs no grant, so the grants are skipped.
DO $grants$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spi_app') THEN
        GRANT USAGE ON SCHEMA spi TO spi_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA spi GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO spi_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA spi GRANT USAGE, SELECT ON SEQUENCES TO spi_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA spi TO spi_app;  -- schema_migration, by the runner
    END IF;
END
$grants$;

-- ---------- Reference: geography, products, schemes, components ----------
-- Geography as the files give it: a region can move zone and a depot can serve two regions.
CREATE TABLE spi.geo_unit (
    geo_id          smallint    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    zone            text        NOT NULL,
    region          text        NOT NULL,
    depot_code      integer     NOT NULL,
    UNIQUE (zone, region, depot_code)
);

CREATE TABLE spi.product (
    product_id      smallint    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            text        NOT NULL UNIQUE,
    sort_order      smallint    NOT NULL
);

CREATE TABLE spi.scheme (
    scheme_id       smallint    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code            text        NOT NULL UNIQUE,                -- 'enamel_primer'
    label           text        NOT NULL,                       -- 'Enamel Primer'
    product_id      smallint    REFERENCES spi.product,
    role            text        NOT NULL CHECK (role IN ('base', 'addon', 'whole_book', 'other', 'gift')),
    pays_in         text        NOT NULL DEFAULT 'rupees' CHECK (pays_in IN ('rupees', 'gifts'))
);

CREATE TABLE spi.component (
    component_id    smallint    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scheme_id       smallint    NOT NULL REFERENCES spi.scheme,
    name            text        NOT NULL,                       -- 'GLOSSA RO & YO PRMR'
    UNIQUE (scheme_id, name)
);

-- ---------- Source files: every GCS file version, never overwritten ----------
CREATE TABLE spi.source_file (
    file_id         integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    month           date        NOT NULL CHECK (extract(day FROM month) = 1),
    file_name       text        NOT NULL,
    gcs_path        text        NOT NULL,
    gcs_generation  text        NOT NULL,
    version         integer,                                    -- _v<n> in the file name
    extract_date    date,
    complete        boolean     NOT NULL,                       -- the month is over (settled)
    dealer_rows     integer     NOT NULL,
    component_rows  integer     NOT NULL,
    file_payout     numeric(16,2) NOT NULL,                     -- sum of current_cn as parsed: reconciliation target
    loaded_at       timestamptz NOT NULL DEFAULT now(),
    kind            text        NOT NULL DEFAULT 'main' CHECK (kind IN ('main', 'gift')),
    loader_version  smallint    NOT NULL,                       -- app/spi/load.py LOADER_VERSION; older is reloaded
    parser_version  smallint    NOT NULL,                       -- app/ingest/parse_raw.py CONFIG_VERSION; older is reloaded
    scheme_configs  jsonb,                                      -- scheme definitions read from the file header (main)
    UNIQUE (file_name, gcs_generation)
);

-- The newest file of each month and kind (extract date, then version): what the app shows.
CREATE VIEW spi.live_file AS
SELECT DISTINCT ON (month, kind) month, kind, file_id, file_name, version, extract_date, complete
FROM spi.source_file
ORDER BY month, kind, extract_date DESC, version DESC NULLS LAST;

-- ---------- File contents (main file) ----------
-- How each component pays in a file: formula and pack size change between months.
CREATE TABLE spi.file_component (
    file_id         integer     NOT NULL REFERENCES spi.source_file ON DELETE CASCADE,
    component_id    smallint    NOT NULL REFERENCES spi.component,
    scheme_label    text        NOT NULL,
    formula         text        NOT NULL,                       -- percent | per_pack | per_unit | fixed | qualifier
    pack_size       integer     NOT NULL,
    PRIMARY KEY (file_id, component_id)
);

-- One row per dealer in a file (name and geography can change between files).
CREATE TABLE spi.file_dealer (
    file_id         integer     NOT NULL REFERENCES spi.source_file ON DELETE CASCADE,
    dealer_code     bigint      NOT NULL,
    geo_id          smallint    NOT NULL REFERENCES spi.geo_unit,
    customer_name   text,
    total_gsr       float8      NOT NULL,
    od_blocked      boolean     NOT NULL,
    PRIMARY KEY (file_id, dealer_code)
);

-- The engine's input: one row per dealer x component. One partition per file, created by the loader.
CREATE TABLE spi.file_dealer_component (
    file_id             integer     NOT NULL,
    dealer_code         bigint      NOT NULL,
    component_id        smallint    NOT NULL,
    row_no              integer     NOT NULL,                   -- position in the parsed file: keeps the engine's order
    geo_id              smallint    NOT NULL,                   -- copied from file_dealer so filters need no join
    base_value          float8,
    cn_rate             float8      NOT NULL,                   -- rate paid, as in the file
    cn_units            float8      NOT NULL,                   -- payout = units x rate
    current_cn          float8      NOT NULL,                   -- payout, as in the file (Clear Cut)
    volume              float8      NOT NULL,
    gsr                 float8      NOT NULL,
    gsr_src             smallint    NOT NULL,                   -- source column: GSR counts once per column per dealer
    vol_src             smallint    NOT NULL,
    slab_basis          float8      NOT NULL,                   -- achievement that decides the slab
    next_slab           float8      NOT NULL,                   -- shortfall to the next slab
    condonation_amount  float8      NOT NULL,
    scheme_cn           float8      NOT NULL,
    settled_cn          float8      NOT NULL,
    component_clear_cut float8,
    clear_cut_total     float8,                                 -- the dealer's scheme total, as the file gives it
    is_currency         boolean,
    PRIMARY KEY (file_id, dealer_code, component_id),
    FOREIGN KEY (file_id, dealer_code) REFERENCES spi.file_dealer ON DELETE CASCADE,
    FOREIGN KEY (file_id, component_id) REFERENCES spi.file_component ON DELETE CASCADE
) PARTITION BY LIST (file_id);

-- ---------- File contents (gift file, source_file.kind = 'gift') ----------
-- One row per dealer and gift scheme with any figure.
CREATE TABLE spi.file_dealer_gift (
    file_id         integer     NOT NULL REFERENCES spi.source_file ON DELETE CASCADE,
    dealer_code     bigint      NOT NULL,
    scheme_id       smallint    NOT NULL REFERENCES spi.scheme,
    row_no          integer     NOT NULL,                       -- the file's order
    geo_id          smallint    NOT NULL REFERENCES spi.geo_unit,
    volume          float8,
    gsr             float8,
    level           float8,                                     -- the file's "CN%": the gift level reached
    clear_cut       float8,                                     -- gifts earned (rupees for a rupee scheme)
    next_slab       float8,
    shortfall       float8,
    PRIMARY KEY (file_id, dealer_code, scheme_id)
);

-- ---------- Saved versions (the user's what-if edits and their results) ----------
CREATE TABLE spi.saved_version (
    version_id          integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                text        NOT NULL,
    note                text,
    base_month          date        NOT NULL CHECK (extract(day FROM base_month) = 1),   -- the live month when saved
    volume_growth_pct   float8      NOT NULL DEFAULT 0,                                   -- V: next month's volume change
    removed_schemes     text[]      NOT NULL DEFAULT '{}',
    status              text        NOT NULL DEFAULT 'SAVED' CHECK (status IN ('DRAFT', 'SAVED', 'ARCHIVED')),
    created_by          text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    computed_source     text,                                                             -- file the live results use
    computed_at         timestamptz
);
-- Names are unique, case and outer spaces ignored.
CREATE UNIQUE INDEX saved_version_name_idx ON spi.saved_version (lower(btrim(name)));

-- What the user typed: modes A B C P Q R S (app/core/scenario.py). A slab edit's scope lists its dealers, so the key
-- holds the scope's md5.
CREATE TABLE spi.saved_version_edit (
    version_id      integer     NOT NULL REFERENCES spi.saved_version ON DELETE CASCADE,
    period          text        NOT NULL CHECK (period IN ('current', 'next')),
    scope_kind      text        NOT NULL CHECK (scope_kind IN ('all', 'zone', 'region', 'depot', 'dealer')),
    scope_value     text        NOT NULL DEFAULT '',
    product         text        NOT NULL DEFAULT '*',
    metric          text        NOT NULL CHECK (metric IN ('gsr', 'volume')),
    mode            text        NOT NULL CHECK (mode IN ('A', 'B', 'C', 'P', 'Q', 'R', 'S')),
    adjust_type     text        NOT NULL CHECK (adjust_type IN ('delta', 'pct', 'share')),
    value           float8      NOT NULL,
    reason          text,
    scope_hash      text        GENERATED ALWAYS AS (md5(scope_value)) STORED,
    PRIMARY KEY (version_id, period, scope_kind, scope_hash, product, metric, mode)
);

-- Edited slab tables: the current month's (next month uses them too) and next month's own.
CREATE TABLE spi.saved_version_layout (
    version_id      integer     NOT NULL REFERENCES spi.saved_version ON DELETE CASCADE,
    period          text        NOT NULL CHECK (period IN ('current', 'next')),
    scheme_key      text        NOT NULL,
    component       text        NOT NULL,
    layout          jsonb       NOT NULL,
    PRIMARY KEY (version_id, period, scheme_key, component)
);

-- Results: one 'live' snapshot per month (rewritten when the version or the month's file changes) and one 'save'
-- snapshot per month and save (never rewritten).
CREATE TABLE spi.saved_version_snapshot (
    snapshot_id     integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    version_id      integer     NOT NULL REFERENCES spi.saved_version ON DELETE CASCADE,
    kind            text        NOT NULL CHECK (kind IN ('live', 'save')),
    taken_at        timestamptz NOT NULL DEFAULT now(),
    source_file     text        NOT NULL,
    as_of           date,
    month           date        NOT NULL,                       -- the month the figures are for (base, or base + 1)
    factor          float8      NOT NULL,                       -- next month: 1 + V
    dealers         integer     NOT NULL,
    dealers_moved   integer     NOT NULL,
    actual_gsr      float8      NOT NULL,
    version_gsr     float8      NOT NULL,
    actual_cn       float8      NOT NULL,
    version_cn      float8      NOT NULL,
    warnings        text[]      NOT NULL DEFAULT '{}',
    schemes         jsonb       NOT NULL                        -- per scheme: figures and both sides' slab rows
);
CREATE INDEX saved_version_snapshot_version_id_idx ON spi.saved_version_snapshot (version_id);
CREATE UNIQUE INDEX saved_version_snapshot_live_idx ON spi.saved_version_snapshot (version_id, month) WHERE kind = 'live';

-- Dealers whose slab or rate moved in a live result (the dealer list of a saved version).
CREATE TABLE spi.saved_version_dealer_result (
    version_id      integer     NOT NULL REFERENCES spi.saved_version ON DELETE CASCADE,
    month           date        NOT NULL,
    customer_code   bigint      NOT NULL,
    scheme_key      text        NOT NULL,
    component       text        NOT NULL,
    actual_basis    float8      NOT NULL,
    actual_lower    float8,
    actual_rate     float8      NOT NULL,
    actual_cn       float8      NOT NULL,
    version_basis   float8      NOT NULL,
    version_lower   float8,
    version_rate    float8      NOT NULL,
    version_cn      float8      NOT NULL,
    PRIMARY KEY (version_id, month, customer_code, scheme_key, component)
);

-- ---------- Load log ----------
CREATE TABLE spi.load_run (
    run_id          integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    month           date        NOT NULL,
    file_name       text        NOT NULL,
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,
    status          text        NOT NULL CHECK (status IN ('running', 'loaded', 'skipped', 'failed')),
    rows            integer,
    message         text
);
