#!/usr/bin/env python3
"""
Parse Wizz Air MCC Daily Report PDF into data/daily_report.json for MEL Dispatch Assistant.

Usage:
  python tools/parse_daily_report.py "reports/Daily Report 20022026.pdf" data/daily_report.json

The parser focuses on the table:
  "Reg No WO Open/Due Date MEL/CDL Description"
It extracts:
  - tail (Reg No)
  - wo
  - mel_ref (normalized, keeps trailing letter without extra hyphen)
  - desc (Description)
It also keeps a "raw" line for audit.
"""
import re, json, sys, hashlib
from pathlib import Path
from PyPDF2 import PdfReader

REF_RE = re.compile(r"\b\d{2}-\d{2}-\d{2}(?:/\d{2})?(?:-?[A-Z])?\b", re.I)
TAIL_RE = re.compile(r"^(?P<tail>[A-Z0-9]{1,2}-[A-Z0-9]{3})\s+(?P<wo>\d{6,})\s+(?P<rest>.*)$")

def norm_ref(r: str) -> str:
    r = r.upper()
    r = re.sub(r"(\d{2}-\d{2}-\d{2}(?:/\d{2})?)-([A-Z])$", r"\1\2", r)
    return r

def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024*1024), b""):
            h.update(chunk)
    return h.hexdigest()

def extract_lines(pdf_path: Path):
    reader = PdfReader(str(pdf_path))
    for page in reader.pages:
        txt = page.extract_text() or ""
        for line in txt.splitlines():
            line = line.strip()
            if line:
                yield line

def parse(pdf_path: Path):
    lines = list(extract_lines(pdf_path))

    # Find start of MEL/CDL items table
    start_idx = None
    for i, line in enumerate(lines):
        if line.strip().startswith("Reg No WO Open/Due Date MEL/CDL Description"):
            start_idx = i + 1
            break
    if start_idx is None:
        raise RuntimeError("Could not find 'Reg No WO Open/Due Date MEL/CDL Description' header in PDF text.")

    rows=[]
    cur=None

    for line in lines[start_idx:]:
        # Stop when another big section header starts
        if line.startswith("MEL / CDL Items") or line.startswith("MEL/CDL Items"):
            # this can appear later; don't stop immediately, but if we already collected many rows, we can break
            if len(rows) > 10:
                break

        m = TAIL_RE.match(line)
        if m:
            # finalize previous
            if cur:
                rows.append(cur)
            tail = m.group("tail").strip()
            wo = m.group("wo").strip()
            rest = m.group("rest").strip()

            # mel ref inside rest
            mel = None
            mm = REF_RE.search(rest)
            if mm:
                mel = norm_ref(mm.group(0))
            # strip "MEL " prefix if present in rest
            rest_clean = re.sub(r"\bMEL\b\s*", "", rest, flags=re.I).strip()

            cur = {
                "tail": tail,
                "wo": wo,
                "ata": "",  # not in this table reliably
                "desc": rest_clean,
                "raw": line,
            }
            if mel:
                cur["mel_ref"] = mel
        else:
            # wrapped continuation line
            if cur:
                cur["desc"] = (cur["desc"] + " " + line).strip()
                cur["raw"] = cur["raw"] + " | " + line

    if cur:
        rows.append(cur)

    return rows

def main():
    if len(sys.argv) < 3:
        print("Usage: parse_daily_report.py <input.pdf> <output.json>")
        sys.exit(2)
    in_pdf = Path(sys.argv[1])
    out_json = Path(sys.argv[2])
    rows = parse(in_pdf)

    out = {
        "type": "daily_report",
        "source_pdf": in_pdf.name,
        "pdf_sha256": sha256_file(in_pdf),
        "generated_utc": __import__("datetime").datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "rows": rows,
    }
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {out_json} with {len(rows)} rows.")

if __name__ == "__main__":
    main()
