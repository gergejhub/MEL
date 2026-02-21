# MEL Dispatch Assistant (v3.7.0-dailyreport)

## Daily Report PDF import (ajánlott)

1. Tedd fel a napi PDF-et a repo `reports/` mappájába (pl. `reports/Daily Report 20022026.pdf`).
2. A GitHub Actions workflow automatikusan lefut és legenerálja: `data/daily_report.json`
3. Nyisd meg az oldalt: a rendszer automatikusan beolvassa a `data/daily_report.json`-t (Daily(auto)).

Alternatíva: a weboldalon feltölthetsz `Daily Report (JSON)` fájlt kézzel is.

## CSV import (opcionális)

Továbbra is megy a WO Summary CSV feltöltés / beillesztés.
