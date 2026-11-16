# Database ERD (Postgres, schema `spc`)

Source: [backend/app/db/schema.sql](../backend/app/db/schema.sql). Checked against the local database `spc-pg` on 2 Nov 2026: 20 tables, 2 views, 17 foreign keys, all as below. Update this file when `schema.sql` changes.

The tables fall in three groups that do not reference each other: the CN extract, the gift file and saved scenarios. Lines are real foreign keys only. References that exist in the data but have no foreign key are listed under [Links without a foreign key](#links-without-a-foreign-key).

All three on one image: [erd-combined.png](erd-combined.png). PNG copies of each diagram: [erd-1-cn-extract.png](erd-1-cn-extract.png), [erd-2-gift-file.png](erd-2-gift-file.png), [erd-3-scenarios.png](erd-3-scenarios.png). To regenerate them after a change: `npx -y @mermaid-js/mermaid-cli@11.4.2 -i docs/erd.md -o out.md -e png -w 2000 -s 2 -b white`, then rename `out-1.png` … `out-3.png`.

## 1. CN extract (one current version per month)

```mermaid
erDiagram
    source_file ||--o{ dealer_month : "month"
    source_file ||--o{ raw_layout : "month"
    source_file ||--o{ raw_row : "month"
    dealer ||--o{ dealer_month : "customer_code"
    dealer_month ||--o{ dealer_component_month : "month, customer_code"
    scheme ||--o{ scheme_component : "scheme_key"
    scheme_component ||--o{ dealer_component_month : "scheme_key, component"

    source_file {
        date month PK "first day of the scheme month"
        text file_name
        text gcs_path
        text gcs_generation "changes on re-upload"
        integer version "v-N of the file name"
        date extract_date "upload date, IST"
        smallint month_days
        boolean complete
        timestamptz loaded_at
    }
    dealer {
        bigint customer_code PK
        text customer_name "client data"
        text zone
        text region
        integer depot_code
        timestamptz updated_at
    }
    scheme {
        text scheme_key PK
        text label
        boolean is_currency "false: pays gifts"
        text origin "file or user"
        timestamptz updated_at
    }
    scheme_component {
        text scheme_key PK, FK
        text component PK
        text formula "percent, fixed, per_pack, qualifier"
        integer pack_size
    }
    dealer_month {
        date month PK, FK
        bigint customer_code PK, FK
        text zone
        text region
        integer depot_code
        float8 total_gsr "dealer's whole book"
        boolean od_blocked
    }
    dealer_component_month {
        date month PK, FK
        bigint customer_code PK, FK
        text scheme_key PK, FK
        text component PK, FK
        float8 base_value
        float8 cn_rate
        float8 cn_units
        float8 current_cn
        float8 volume
        float8 gsr
        integer gsr_src "source column of gsr"
        integer vol_src
        float8 slab_basis
        float8 next_slab
        float8 condonation_amount
        float8 scheme_cn
        float8 settled_cn
        float8 component_clear_cut
        float8 clear_cut_total
    }
    raw_layout {
        date month PK, FK
        smallint col_no PK "0-based sheet column"
        text header_1
        text header_2
        text block_name
    }
    raw_row {
        date month PK, FK
        text customer_code PK "as in the file"
        text zone
        text region
        text depot_code
        text customer_name
        float8_array vals "float8[], columns 5 onwards"
    }
```

## 2. Gift / contest file (kept apart from CN)

```mermaid
erDiagram
    gift_file ||--o{ dealer_gift_month : "month"
    gift_file ||--o{ gift_raw_layout : "month"
    gift_file ||--o{ gift_raw_row : "month"
    gift_scheme ||--o{ dealer_gift_month : "scheme_key"

    gift_file {
        date month PK
        text file_name
        text gcs_path
        text gcs_generation
        integer version
        date extract_date
        timestamptz loaded_at
    }
    gift_scheme {
        text scheme_key PK
        text label
        text unit "gifts or rupees"
        timestamptz updated_at
    }
    dealer_gift_month {
        date month PK, FK
        bigint customer_code PK "no FK to dealer"
        text scheme_key PK, FK
        text zone
        text region
        integer depot_code
        float8 volume
        float8 gsr
        float8 level "1 once qualified"
        float8 clear_cut "gifts earned, or rupees"
        float8 next_slab
        float8 shortfall
    }
    gift_raw_layout {
        date month PK, FK
        smallint col_no PK
        text header_1
        text header_2
        text block_name
    }
    gift_raw_row {
        date month PK, FK
        text customer_code PK
        text zone
        text region
        text depot_code
        text customer_name
        float8_array vals "float8[], columns 5 onwards"
    }
```

## 3. Saved scenarios

```mermaid
erDiagram
    scenario ||--o{ scenario_adjustment : "scenario_id"
    scenario ||--o{ scenario_layout : "scenario_id"
    scenario ||--o{ scenario_dealer_result : "scenario_id"
    scenario ||--o{ scenario_snapshot : "scenario_id"
    scenario_snapshot ||--o{ scenario_snapshot_scheme : "snapshot_id"
    scenario_snapshot ||--o{ scenario_snapshot_slab : "snapshot_id"

    scenario {
        bigint scenario_id PK "identity"
        text name
        text note
        date base_month "live month when saved"
        float8 volume_growth_pct "V"
        text_array removed_schemes "text[]"
        text status "DRAFT, SAVED, ARCHIVED"
        text created_by "empty, no login yet"
        timestamptz created_at
        timestamptz updated_at
        text computed_source
        timestamptz computed_at
    }
    scenario_adjustment {
        bigint scenario_id PK, FK
        text period PK "current or next"
        text scope_kind PK "all, zone, region, depot, dealer"
        text scope_value PK
        text product PK
        text metric PK "gsr or volume"
        text mode PK "A, B, P, Q, R, S"
        text adjust_type "delta, pct, share"
        float8 value
        text reason
    }
    scenario_layout {
        bigint scenario_id PK, FK
        text scheme_key PK
        text component PK
        jsonb layout "SlabLayout"
    }
    scenario_dealer_result {
        bigint scenario_id PK, FK
        date month PK
        bigint customer_code PK
        text scheme_key PK
        text component PK
        float8 actual_basis
        float8 actual_lower
        float8 actual_rate
        float8 actual_cn
        float8 scenario_basis
        float8 scenario_lower
        float8 scenario_rate
        float8 scenario_cn
    }
    scenario_snapshot {
        bigint snapshot_id PK "identity"
        bigint scenario_id FK
        text kind "live or save"
        timestamptz taken_at
        text source_file
        date as_of
        date month
        float8 factor
        integer dealers
        integer dealers_moved
        float8 actual_gsr
        float8 scenario_gsr
        float8 actual_cn
        float8 scenario_cn
        text_array warnings "text[]"
    }
    scenario_snapshot_scheme {
        bigint snapshot_id PK, FK
        text scheme_key PK
        boolean is_currency
        boolean removed
        integer dealers
        integer dealers_moved
        float8 actual_volume
        float8 scenario_volume
        float8 actual_gsr
        float8 scenario_gsr
        float8 actual_cn
        float8 scenario_cn
    }
    scenario_snapshot_slab {
        bigint snapshot_id PK, FK
        text scheme_key PK
        text component PK
        text side PK "actual or scenario"
        smallint row_no PK
        text slab_mode
        text formula
        integer pack_size
        float8 slab_lower
        float8 slab_upper
        float8 rate
        integer dealers
        float8 volume
        float8 gsr
        float8 cn
    }
```

## Delete rules

- `ON DELETE CASCADE`: every foreign key to `source_file`, `gift_file`, `scheme`, `scenario` and `scenario_snapshot`, and `dealer_component_month` → `dealer_month`. Deleting a month (retention) removes all its rows; deleting a scenario removes all its rows.
- No cascade (delete blocked while referenced): `dealer_month` → `dealer`, `dealer_component_month` → `scheme_component`, `dealer_gift_month` → `gift_scheme`.

## Links without a foreign key

| Column | Points to | Why no foreign key |
| --- | --- | --- |
| `dealer_gift_month.customer_code` | `dealer.customer_code` | A dealer can be in the gift file and not in the main one. |
| `raw_row.customer_code`, `gift_raw_row.customer_code` (text) | dealer code | Kept exactly as in the file. |
| `scenario.base_month`, `scenario_dealer_result.month`, `scenario_snapshot.month` | `source_file.month` | A scenario is kept after its month is pruned. |
| `scenario_layout`, `scenario_dealer_result`, `scenario_snapshot_scheme`, `scenario_snapshot_slab` (`scheme_key`, `component`) | `scheme_component` | Results stay valid as saved even if a scheme changes. |
| `scenario_dealer_result.customer_code` | `dealer.customer_code` | Same: kept after the dealer is pruned. |
| `scenario.removed_schemes` (`text[]`) | `scheme.scheme_key` | Array of keys. |

## Indexes besides primary keys

| Index | Columns |
| --- | --- |
| `dealer_month_scope` | `dealer_month (month, zone, region, depot_code)` |
| `dealer_component_month_scheme` | `dealer_component_month (month, scheme_key, component)` |
| `dealer_gift_month_scope` | `dealer_gift_month (month, zone, region, depot_code)` |
| `scenario_snapshot_live` (unique, `WHERE kind = 'live'`) | `scenario_snapshot (scenario_id, month)` |

## Views

| View | Shows |
| --- | --- |
| `raw_value` | `raw_row` × `raw_layout` as one row per dealer and column: `month, customer_code, col_no, block_name, metric, value` (`value = vals[col_no - 4]`). |
| `gift_raw_value` | The same for `gift_raw_row` × `gift_raw_layout`. |

Type note: Mermaid does not accept `[]` in a type, so `float8_array` and `text_array` stand for `float8[]` and `text[]`.
