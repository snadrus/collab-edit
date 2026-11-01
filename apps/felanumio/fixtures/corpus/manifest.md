# Felanumio vs Google Sheets: load-test corpus
Made by /workspace/sheets-compare/gen.py (seed 1). /workspace/sheets-compare/pastes/ holds tab-separated versions of each file (one per sheet, made by totsv.py). These are what you would paste in from another spreadsheet.

| File | Tests |
|---|---|
| small.csv | 4 cols × 7 rows: header, text, ints and decimals, `=B2*C2` row formulas, a `=SUM` totals row. Baseline import, formula detection and recalc. |
| large_10k_x20.csv | 10,000 data rows + header × 20 cols (~950 KB): ints, floats, text, a letter category, ISO dates. Load time, rendering, scroll performance. |
| quirks_utf8.csv | UTF-8 emoji (incl. a ZWJ sequence), CJK/Korean, accented text. Quoted commas, quoted newline, embedded `"quotes"`. Leading zeros (`001`, `02134`, `00000`). Dates as ISO, US m/d/y, EU d.m.y, long-form, ISO datetime, short US with time. Trailing space. A text cell that looks like a formula (`=1+1 formula-looking`). |
| quirks_semicolon.csv | `;` delimiter (European style), a quoted field containing `;`, decimal comma `4,50`, thousands dot `1.234,56`, d.m.y dates, umlauts. Delimiter auto-detection and locale. |
| data.tsv | Tab-delimited, per-row `=SUM(B:E)` formulas, a field with a comma, a quoted field. |
| features.xlsx | 3 sheets (Sales, Products, Summary). Formulas: arithmetic, SUM, absolute refs, IF, TEXT on dates, cross-sheet VLOOKUP, INDEX/MATCH, COUNTIF, TODAY, cross-sheet SUMIF and refs. Number formats: currency, percent, mm/dd/yyyy. Styling: bold/white header on blue fill, thin borders, merged K1:M1 with an orange fill, frozen row 1, custom column widths. Also: a bar chart on Summary, list data validation on B2:B21, conditional formatting (cell-is fill plus a color scale), a comment on A1, an external hyperlink and an internal one (#Products!A1). |
| basic.ods | 2-sheet OpenDocument: numbers, text, `of:=` formulas, a SUM, and a cross-sheet ref (`Second.A2 = Sheet1.B4`). |
