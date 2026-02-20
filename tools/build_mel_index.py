#!/usr/bin/env python3
"""Build mel_pdf_index.json from a MEL.pdf.

Usage:
  python3 tools/build_mel_index.py path/to/MEL.pdf

Outputs:
  data/mel_pdf_index.json

This avoids using pdf.js/CDN in the browser. The webapp will compare the uploaded PDF's SHA-256
with the generated index and warn if they differ.
"""
import re, json, hashlib, sys, datetime
from pathlib import Path
from pypdf import PdfReader

def sha256_file(p: Path)->str:
    h=hashlib.sha256()
    with p.open("rb") as f:
        for ch in iter(lambda: f.read(1024*1024), b""):
            h.update(ch)
    return h.hexdigest()

def main():
    if len(sys.argv)<2:
        print(__doc__)
        sys.exit(2)
    pdf_path=Path(sys.argv[1]).expanduser().resolve()
    if not pdf_path.exists():
        raise SystemExit(f"File not found: {pdf_path}")
    reader=PdfReader(str(pdf_path))
    pat=re.compile(r"\b\d{2}-\d{2}-\d{2}[A-Z]?\b")
    cat_pat=re.compile(r"\bCAT\s*I{1,3}B?\b|CAT\s*IIIA|CAT\s*IIIB|CAT\s*III\b", re.IGNORECASE)

    refs={}
    cat_summary={}
    for i,page in enumerate(reader.pages):
        txt=page.extract_text() or ""
        if not txt:
            continue
        if '-' not in txt and 'CAT' not in txt and 'autoland' not in txt.lower():
            continue
        found=set(pat.findall(txt))
        if found:
            sn=" ".join(txt.split())[:250]
            for r in found:
                refs.setdefault(r,{"page":i+1,"snippet":sn})
        if ('CAT' in txt) or ('autoland' in txt.lower()):
            sn=" ".join(txt.split())
            if cat_pat.search(sn) or ('autoland' in sn.lower()):
                cats=[]
                u=sn.upper()
                cats += [x.replace(" ","") for x in re.findall(r"CAT\s*3[A|B]", u)]
                cats += [x.replace(" ","") for x in re.findall(r"CAT\s*IIIB|CAT\s*IIIA|CAT\s*III|CAT\s*II|CAT\s*I\b", u)]
                cats=list(dict.fromkeys(cats))
                for r in (found or ["__NO_REF__"]):
                    if cats and r not in cat_summary:
                        cat_summary[r]={"page":i+1,"cats":cats,"snippet":sn[:500]}
    out={
        "pdf_sha256": sha256_file(pdf_path),
        "generated_utc": datetime.datetime.utcnow().isoformat()+"Z",
        "refs": refs,
        "cat_summary": cat_summary,
    }
    target=Path(__file__).resolve().parent.parent/"data"/"mel_pdf_index.json"
    target.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {target} (refs={len(refs)}, cat={len(cat_summary)})")

if __name__=="__main__":
    main()
