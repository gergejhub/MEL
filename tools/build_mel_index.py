#!/usr/bin/env python3
import argparse, hashlib, json, re, subprocess, tempfile, os, sys

def sha256_file(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for chunk in iter(lambda: f.read(1024*1024), b''):
            h.update(chunk)
    return h.hexdigest()

def pdf_to_text(pdf_path):
    with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as tf:
        out=tf.name
    try:
        subprocess.check_call(["pdftotext", pdf_path, out])
        with open(out,'r',errors='ignore') as f:
            return f.read()
    finally:
        try: os.remove(out)
        except: pass

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("pdf", help="MEL.pdf path")
    ap.add_argument("--out", default="data/mel_pdf_index.json")
    args=ap.parse_args()
    text=pdf_to_text(args.pdf)
    sha=sha256_file(args.pdf)
    ref_pat=re.compile(r'\\b(\\d{2}-\\d{2}-\\d{2}[A-Z]?)\\b')
    idx={"sha256":sha,"refs":{}}
    for m in ref_pat.finditer(text):
        ref=m.group(1)
        start=max(0,m.start()-400); end=min(len(text),m.end()+400)
        win=text[start:end]
        if re.search(r'\\bCAT\\s*(I|II|III|3A|3B|IIIA|IIIB)\\b', win, re.I) or "autoland" in win.lower():
            tokens=set()
            for tm in re.finditer(r'CAT\\s*(IIIB|IIIA|III|II|I)\\b', win, re.I):
                tokens.add(tm.group(0).upper().replace(" ",""))
            for tm in re.finditer(r'CAT3[AB]', win, re.I):
                tokens.add(tm.group(0).upper())
            if "AUTOLAND" in win.upper():
                tokens.add("AUTOLAND")
            snippet=re.sub(r'\\s+',' ',win.strip())
            if len(snippet)>300: snippet=snippet[:300]+"…"
            entry=idx["refs"].setdefault(ref, {"cat_tokens":[], "cat_summary":"", "snippets":[]})
            for t in tokens:
                if t not in entry["cat_tokens"]:
                    entry["cat_tokens"].append(t)
            entry["cat_tokens"]=sorted(entry["cat_tokens"])
            entry["cat_summary"]=";".join(entry["cat_tokens"])
            if snippet not in entry["snippets"]:
                entry["snippets"].append(snippet)
            entry["snippets"]=entry["snippets"][:3]
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out,"w") as f:
        json.dump(idx,f,indent=2)
    print(f"Wrote {args.out} with {len(idx['refs'])} MEL refs. SHA256={sha}")
if __name__=="__main__":
    main()
