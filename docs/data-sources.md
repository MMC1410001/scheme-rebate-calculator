# Data Sources

## Primary input: sales / billing extract (GCS)

The project reads its input data from this Google Cloud Storage folder:

| Item | Value |
| --- | --- |
| GCP project | `example-project` |
| Bucket | `example-scheme-files` |
| Folder | `scheme-extracts/output/<YYYY>/<MM>/` (files directly in it; the `daily/` subfolder is **not** read) |
| Example folder | `gs://example-scheme-files/scheme-extracts/output/2026/10/` |
| Example file | `extract_October_2026_v20_no_condonation.xlsx` |
| Format | Excel (`.xlsx`) |
| Access | Read-only. The application never writes to this bucket (BRD §4.1, §18). |

What the file contains (columns, payout rules, totals, anomalies): [source-file-structure.md](source-file-structure.md).

### File name pattern

```
extract_<MonthName>_<YYYY>_v<N>_no_condonation.xlsx
```

| Part | Example | Meaning |
| --- | --- | --- |
| `<MonthName>_<YYYY>` | `October_2026` | Scheme month |
| `v<N>` | `v20` | Version: counts up through the month. The highest is the latest file |
| `no_condonation` | | No condonation applied (to confirm, see below) |

The name carries no date. The file's upload date (IST) is used as its extract date.

**Do not read `daily/`** (instruction from the user, 29 Oct 2026). Some extracts are also copied into `daily/` as `..._no_condonation_<YYYYMMDD>_v<N>.xlsx`, but not all of them. In one month `daily/` stopped at v15 (mid-month), while the month folder ran to v20 (near month end).

### How the period maps to the views

| View | What is read |
| --- | --- |
| Previous Month (locked) | `output/<prev YYYY>/<prev MM>/` — the newest no-condonation file of that month |
| Current Month | `output/<YYYY>/<MM>/` — the newest no-condonation file so far (as-of date shown on screen, NFR "Data Freshness") |

## What the bucket shows (checked 2026-10-29)

- **Two files per extract** in the month folder, `..._v<N>.xlsx` and `..._v<N>_no_condonation.xlsx`. The app reads **only the no-condonation file** (confirmed with the user).
- **File choice:** the newest upload date, then the highest `v<N>`. `v<N>` keeps counting across days, so it is not a per-day counter. For example, late in a month the newest file may be v20 for that month and v25 for the month before.
- **Small files between big ones:** some versions are only 1–6 MB against 50–80 MB for their neighbours (several versions in one month). If the newest version is one of these, the app loads it as-is.
- **Landing time:** about 07:30-07:45 UTC (13:00-13:15 IST). The app's daily sync runs at 14:00 IST.
- **The extract date is not the as-of date.** September's last files were uploaded 1–6 October. A file extracted after its month ended is treated as the full month.
- **Layout:** the no-condonation file parses with the existing "automated" loader. A month's file holds about half a million rows and tens of thousands of dealers.
- **Scheme blocks vary between versions.** An early version of a month had almost twice as many scheme blocks as a later one. The per-50 L / per-100 L add-ons, trip schemes, gift columns, Damp Guard FA and ADDN VIVID LIFE 40 are gone, and a new ALUMINIUM PNT block appears, which the prototype does not yet recognise. Their CN drops out of the totals when a version without them is loaded.
- **Total GSR** per dealer = `GSR(B) Value` + `GSR(B) Value %` + `GSR(B) TMBR Value Slab`. The EB full-month GSR is empty for all South dealers, because South has no EB full-month scheme. In a typical month South is about a fifth of the book.
- **Access:** a read-only service account (`…@example-project.iam.gserviceaccount.com`) can list and read the bucket.

## Scheme letter (next-month proposal)

Each month, Acme Paints pricing emails a scheme proposal for the next month. It lists every CN / OTC scheme with its slab tables, regions and key dates. Two attachments come with it: an in-bill change sheet (`.xlsx`, product × region) and a new-product deck (`.pptx`). These are client documents and are not part of this public copy.

- It arrives as an **email (PDF print)**, not as structured data. The slab tables have to be transcribed.
- It is a **proposal awaiting approval**. Rates can still change before 1st of the month.
- **GSR = DPL × (1 − in-bill %)**, so the in-bill sheet changes GSR and through it CN (rate base, and slab placement for rupee-slabbed schemes). It is also the best list of product × region × SKU with DPL.

## To confirm

1. **Daily files:** is each file cumulative month-to-date, or does it hold only that day's transactions? (The app assumes month-to-date, because the files grow through the month.)
2. **Granularity:** is the extract grouped by dealer, product or scheme? Are transaction dates kept? (Needed for overlapping qualifying periods, BRD §7.)
3. **`no_condonation`:** what does condonation mean here, and why is no-condonation the correct one for CN? (Using it as instructed.)
4. **Small files and missing schemes:** why are some versions only 1–6 MB, and why does a later version have far fewer scheme blocks than an earlier one (add-ons, trips and gifts missing)?
5. **Columns / sheets:** sheet names and column list (dealer, zone, region, depot, product, category, volume, GSR, scheme, ...).
6. Where do **scheme letter configuration** and **gift / contest qualification data** come from?
