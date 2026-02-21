
let ACTIONS = [];
let GLOSS = {};
let state = {
  rows: [],
  tails: [],
  selectedTail: null,
  selectedFindings: [],
  pdfShaOk: null,
};

const $ = (id)=>document.getElementById(id);

function baseUrl(path){
  return new URL(path, window.location.href).toString();
}

async function loadData(){
  const health = $("health");
  try{
    const [a,g] = await Promise.all([
      fetch(baseUrl("data/actions.json")).then(r=>r.json()),
      fetch(baseUrl("data/fpl_glossary.json")).then(r=>r.json()),
    ]);
    ACTIONS = a;
    GLOSS = g;
    health.textContent = `DB: ${ACTIONS.length} rules`;
    health.style.borderColor = "rgba(34,197,94,.35)";
    health.style.color = "#bbf7d0";
  }catch(e){
    console.error(e);
    health.textContent = "DB: HIBA (actions.json?)";
    health.style.borderColor = "rgba(239,68,68,.55)";
    health.style.color = "#fecaca";
  }
}

function togglePaste(show){
  $("pastePanel").classList.toggle("hidden", !show);
}

function parseCsv(text){
  // very simple CSV parser handling quoted commas
  const lines = text.replace(/\r/g,"").split("\n").filter(l=>l.trim().length>0);
  if(lines.length<2) return [];
  const header = splitCsvLine(lines[0]).map(h=>h.trim());
  const idx = (name)=> header.findIndex(h=>h.toLowerCase().includes(name));
  const iTail = idx("aircraft");
  const iWO   = idx("w/o")>=0 ? idx("w/o") : idx("wo");
  const iATA  = idx("ata");
  const iDesc = header.findIndex(h=>h.toLowerCase().includes("workorder") || h.toLowerCase().includes("description") || h.toLowerCase().includes("reason"));
  const rows=[];
  for(let k=1;k<lines.length;k++){
    const cols = splitCsvLine(lines[k]);
    const tail = (cols[iTail]||"").trim();
    if(!tail) continue;
    rows.push({
      tail,
      wo: (cols[iWO]||"").trim(),
      ata: (cols[iATA]||"").trim(),
      desc: (cols[iDesc]||"").trim(),
      raw: lines[k]
    });
  }
  return rows;
}

function splitCsvLine(line){
  const out=[]; let cur=""; let inQ=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch === '"'){
      if(inQ && line[i+1] === '"'){ cur+='"'; i++; }
      else inQ=!inQ;
    }else if(ch===',' && !inQ){
      out.push(cur); cur="";
    }else cur+=ch;
  }
  out.push(cur);
  return out;
}

function norm(s){ return (s||"").toUpperCase(); }

function wordHit(hay, kw){
  const k = kw.toUpperCase();
  if(k.includes(" ")) return hay.includes(k);
  return new RegExp(`\\b${escapeRe(k)}\\b`).test(hay);
}
function escapeRe(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}

function extractMelRefs(hay){
  const m = hay.match(/\b\d{2}-\d{2}-\d{2}(?:\/\d{2})?(?:-[A-Z])?\b/g);
  return m ? Array.from(new Set(m)) : [];
}

function matchActions(row){
  const hay = norm(`${row.tail} ${row.ata} ${row.desc} ${row.raw}`);
  const refs = extractMelRefs(hay);
  const findings=[];
  for(const act of ACTIONS){
    // strict: ref match OR strong keyword match
    let score=0;
    // ref match gives high confidence
    for(const r of act.mel_refs||[]){
      if(refs.includes(r.toUpperCase())) score += 5;
    }
    // keywords
    let hits=0;
    for(const kw of act.keywords||[]){
      if(!kw || kw.length<3) continue;
      if(wordHit(hay, kw)) hits++;
    }
    // require at least 1 hit for non-ref rules; and avoid generic explosion
    if(score==0){
      if(hits==0) continue;
      // for very generic categories require 2 hits
      const generic = ["MAX FL","FL LIMITATION"].some(x=>act.limitation.toUpperCase().includes(x));
      if(generic && hits<2) continue;
      // for ILS CAT require ILS or AUTOLAND or LANDING or CAT in row
      if(act.tag==="ILS CAT" && !/(ILS|AUTOLAND|LANDING|CAT)/.test(hay)) continue;
      score += Math.min(3, hits);
    }
    if(score>=2){
      findings.push(buildFinding(row, act));
    }
  }
  // de-dup by (wo, actionId)
  const seen=new Set();
  const out=[];
  for(const f of findings){
    const key = `${f.wo||f.fallbackKey}|${f.action.id}`;
    if(seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function buildFinding(row, act){
  return {
    tail: row.tail,
    wo: row.wo,
    ata: row.ata,
    desc: row.desc,
    action: act,
    fallbackKey: `${row.tail}|${row.ata}|${row.desc}`.slice(0,120)
  };
}

function buildTails(rows){
  const byTail=new Map();
  let imported=0, findingsTotal=0;
  for(const r of rows){
    imported++;
    const fs = matchActions(r);
    if(fs.length===0) continue;
    findingsTotal += fs.length;
    if(!byTail.has(r.tail)) byTail.set(r.tail, []);
    byTail.get(r.tail).push(...fs);
  }
  const tails=[];
  for(const [tail, fs] of byTail.entries()){
    // unique findings by (wo, action)
    const unique=[];
    const seen=new Set();
    for(const f of fs){
      const key=`${f.wo||f.fallbackKey}|${f.action.id}`;
      if(seen.has(key)) continue;
      seen.add(key);
      unique.push(f);
    }
    // tags summary
    const tagCounts=new Map();
    for(const f of unique){
      const tag = deriveTagLabel(f.action, f);
      tagCounts.set(tag, (tagCounts.get(tag)||0)+1);
    }
    tails.push({tail, findings: unique, melCount: unique.length, tagCounts});
  }
  tails.sort((a,b)=> b.melCount - a.melCount || a.tail.localeCompare(b.tail));
  return {tails, imported, findingsTotal};
}

function deriveTagLabel(action, finding){
  // show more detail for ILS CAT from action text
  const up = action.limitation.toUpperCase();
  if(action.tag==="ILS CAT"){
    const m = up.match(/CAT\s*3B.*CAT\s*3A|CAT\s*IIIB.*IIIA|CAT\s*II|CAT\s*III[A|B]?|CAT\s*I/);
    if(m) return "ILS " + m[0].replace(/\s+/g,"");
    if(/CAT3B/.test(up) && /3A/.test(up)) return "ILS CAT3B→3A";
    return "ILS CAT";
  }
  return action.tag || action.limitation;
}

function parseFplAndLido(findings){
  // parse from action.lido strings, aggregate add/remove by item
  const agg = { "ITEM10A": {add: new Set(), rem: new Set()}, "ITEM10B": {add:new Set(), rem:new Set()}, "ITEM18": {add:new Set(), rem:new Set()} };
  const lidoLines=[];
  const opsLines=[];
  const usedGloss=new Set();

  for(const f of findings){
    const act=f.action;
    if(act.other && act.other.trim()) opsLines.push(act.other.trim());
    const lido = (act.lido||"").trim();
    if(lido){
      const parsed = parseLidoText(lido);
      for(const step of parsed.steps){
        lidoLines.push(step.rendered);
        // apply to agg if recognized
        if(step.item && agg[step.item]){
          const tgt = step.kind==="ADD" ? agg[step.item].add : agg[step.item].rem;
          for(const code of step.codes) tgt.add(code);
          for(const code of step.codes){
            if(code.startsWith("PBN")) usedGloss.add("PBN/");
            if(GLOSS[code]) usedGloss.add(code);
            if(code.includes("CPDLC")) usedGloss.add("DAT/CPDLCX");
            if(code==="TCAS") usedGloss.add("TCAS");
            if(/^[BCDGJ]\d$/.test(code)) usedGloss.add(code);
            if(code==="Z") usedGloss.add("Z");
            if(code==="J1"||code==="J4") usedGloss.add(code);
          }
        }
      }
    }
  }

  // build FPL box text
  const fplParts=[];
  for(const item of ["ITEM10A","ITEM10B","ITEM18"]){
    const a=[...agg[item].add].sort();
    const r=[...agg[item].rem].sort();
    fplParts.push(`${item}:  ADD ${a.length?a.join(", "):"—"}\n       REM ${r.length?r.join(", "):"—"}`);
  }
  return {fplText: fplParts.join("\n\n"), lidoText: lidoLines.length? lidoLines.join("\n"):"—", opsText: opsLines.length? uniqLines(opsLines).join("\n\n"):"—", usedGloss:[...usedGloss] };
}

function uniqLines(lines){
  const seen=new Set(); const out=[];
  for(const l of lines){
    const key=l.trim();
    if(!key || seen.has(key)) continue;
    seen.add(key); out.push(key);
  }
  return out;
}

function parseLidoText(t){
  // Turn freeform into structured steps: REMOVE/ADD + ITEM + codes
  const raw = t.replace(/\s+/g," ").trim();
  // split by keywords
  const chunks = raw.split(/(?=(?:Remove:|REMOVE:|Insert|INSERT|Overwrite:|OVERWRITE:|Add:|ADD:))/);
  const steps=[];
  for(let ch of chunks){
    ch = ch.trim();
    if(!ch) continue;
    let kind=null;
    if(/^remove:/i.test(ch)) kind="REM";
    else if(/^insert/i.test(ch) || /^add:/i.test(ch)) kind="ADD";
    else if(/^overwrite:/i.test(ch)) { kind="ADD"; }
    else continue;
    // item detection
    const itemMatch = ch.match(/item\s*(10a|10b|18)\b/i);
    const item = itemMatch ? `ITEM${itemMatch[1].toUpperCase()}` : null;
    // codes list: after item ... take tokens like X, J1, J4, TCAS, DAT/CPDLCX, PBN:A1
    const codes=[];
    // PBN:
    const pbnMatch = ch.match(/PBN\s*:\s*([A-Z0-9,\/ ]+)/i);
    if(pbnMatch){
      const parts=pbnMatch[1].split(/[, ]+/).filter(Boolean);
      for(const p of parts) codes.push(`PBN:${p}`);
    }
    // general tokens
    const tok = ch.replace(/PBN\s*:\s*[A-Z0-9,\/ ]+/ig," ");
    for(const m of tok.matchAll(/\b([A-Z]\d|TCAS|DAT\/CPDLCX|EUADSBX|SUR\/EUADSBX|X|Z|L|F|G|S|H|B1|G1)\b/g)){
      codes.push(m[1].toUpperCase());
    }
    const codesUniq=[...new Set(codes)];
    const rendered = (kind==="ADD")
      ? `ADD:    ${item||"—"} → ${codesUniq.length?codesUniq.join(", "):"—"}`
      : `REMOVE: ${item||"—"} → ${codesUniq.length?codesUniq.join(", "):"—"}`;
    steps.push({kind: kind==="ADD"?"ADD":"REM", item, codes: codesUniq, rendered});
  }
  return {steps};
}

function renderTails(){
  const list=$("tailList");
  if(state.tails.length===0){
    list.classList.add("empty");
    list.textContent="Nincs dispatch-releváns találat ebben a CSV-ben.";
    return;
  }
  list.classList.remove("empty");
  list.innerHTML="";
  for(const t of state.tails){
    const el=document.createElement("div");
    el.className="item"+(state.selectedTail===t.tail?" active":"");
    el.addEventListener("click", ()=>selectTail(t.tail));
    const tagsHtml=[...t.tagCounts.entries()]
      .sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
      .map(([tag,n])=>`<span class="tag">${escapeHtml(tag)}${n>1?` ×${n}`:""}</span>`).join("");
    el.innerHTML = `
      <div class="row">
        <div class="tail">${escapeHtml(t.tail)}</div>
        <div class="badge">${t.melCount} MEL</div>
      </div>
      <div class="cardSub">Dispatch releváns tételek: ${t.melCount}</div>
      <div class="tags">${tagsHtml}</div>
    `;
    list.appendChild(el);
  }
}

function renderSelectedItems(){
  const box=$("itemList");
  if(!state.selectedTail){
    box.classList.add("empty");
    box.textContent="Válassz egy lajstromot.";
    $("selCount").textContent="—";
    return;
  }
  const t = state.tails.find(x=>x.tail===state.selectedTail);
  const fs = t ? t.findings : [];
  $("selCount").textContent = `Aktív dispatch-releváns tételek: ${fs.length}`;
  box.classList.remove("empty");
  box.innerHTML="";
  for(const f of fs){
    const el=document.createElement("div");
    el.className="item";
    el.innerHTML = `
      <div class="row">
        <div><b>${escapeHtml(f.action.limitation)}</b></div>
        <div class="badge">${escapeHtml(f.action.tag||"")}</div>
      </div>
      <div class="cardSub">W/O ${escapeHtml(f.wo||"—")} • ATA ${escapeHtml(f.ata||"—")}</div>
      <div class="cardSub">${escapeHtml(f.desc||"")}</div>
    `;
    box.appendChild(el);
  }
}

function renderDetails(){
  if(!state.selectedTail){
    $("selTitle").textContent="Teendők";
    $("fplBox").textContent="—";
    $("lidoBox").textContent="—";
    $("opsBox").textContent="—";
    $("glossBox").textContent="—";
    return;
  }
  const t = state.tails.find(x=>x.tail===state.selectedTail);
  const findings = t ? t.findings : [];
  $("selTitle").textContent = `Teendők – ${state.selectedTail}`;
  const out = parseFplAndLido(findings);
  $("fplBox").textContent = out.fplText;
  $("lidoBox").innerHTML = highlightLido(out.lidoText);
  $("opsBox").textContent = out.opsText;
  $("glossBox").innerHTML = renderGloss(out.usedGloss);
}

function renderGloss(keys){
  if(!keys || keys.length===0) return `<span class="muted">Nincs FPL-kód a kiválasztott tételekben.</span>`;
  const uniq=[...new Set(keys)];
  const cards = uniq.map(k=>{
    const g=GLOSS[k];
    if(!g) return `<div class="k">${escapeHtml(k)}</div>`;
    return `<div class="item" style="cursor:default">
      <div class="row"><div><b>${escapeHtml(g.title)}</b></div><div class="badge">${escapeHtml(k)}</div></div>
      <div class="cardSub">${escapeHtml(g.why)}</div>
      <div class="cardSub muted">${escapeHtml(g.see)}</div>
    </div>`;
  }).join("");
  return `<div class="kv">${cards}</div>`;
}

function highlightLido(text){
  if(!text || text==="—") return `<span class="muted">—</span>`;
  const lines = text.split("\n").map(l=>{
    const up=l.toUpperCase();
    if(up.startsWith("ADD:")) return `<div class="hiAdd">${escapeHtml(l)}</div>`;
    if(up.startsWith("REMOVE:")) return `<div class="hiRem">${escapeHtml(l)}</div>`;
    return `<div>${escapeHtml(l)}</div>`;
  }).join("");
  return lines;
}

function escapeHtml(s){
  return (s||"").replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function selectTail(tail){
  state.selectedTail = tail;
  renderTails();
  renderSelectedItems();
  renderDetails();
}

function copySummary(){
  if(!state.selectedTail) return;
  const t = state.tails.find(x=>x.tail===state.selectedTail);
  const out = parseFplAndLido(t.findings);
  const txt = `MEL Dispatch – ${state.selectedTail}\n\nICAO FPL:\n${out.fplText}\n\nLIDO:\n${out.lidoText}\n\nOPS:\n${out.opsText}\n`;
  navigator.clipboard?.writeText(txt);
}

function handoverExport(){
  if(state.tails.length===0) return;
  const lines=[];
  for(const t of state.tails){
    const tags=[...t.tagCounts.entries()].sort((a,b)=>b[1]-a[1]).map(([k,n])=>`${k}${n>1?`×${n}`:""}`).join(", ");
    lines.push(`${t.tail} – ${t.melCount} MEL – ${tags}`);
  }
  navigator.clipboard?.writeText(lines.join("\n"));
}

async function handleCsvText(text){
  const rows=parseCsv(text);
  state.rows=rows;
  const built=buildTails(rows);
  state.tails=built.tails;
  $("stats").textContent = `Importált sorok: ${built.imported} • Dispatch-releváns lajstromok: ${built.tails.length} • Találatok: ${built.findingsTotal}`;
  state.selectedTail = built.tails.length ? built.tails[0].tail : null;
  renderTails();
  renderSelectedItems();
  renderDetails();
}

function clearAll(){
  state.rows=[]; state.tails=[]; state.selectedTail=null;
  $("tailList").textContent="Tölts fel CSV-t.";
  $("tailList").classList.add("empty");
  $("itemList").textContent="Válassz egy lajstromot.";
  $("itemList").classList.add("empty");
  $("stats").textContent="—";
  renderDetails();
}

function bind(){
  $("btnPaste").addEventListener("click", ()=>togglePaste(true));
  $("btnPasteClose").addEventListener("click", ()=>togglePaste(false));
  $("btnImportPaste").addEventListener("click", async ()=>{
    await handleCsvText($("csvPaste").value);
    togglePaste(false);
  });
  $("csvFile").addEventListener("change", async (e)=>{
    const f=e.target.files?.[0]; if(!f) return;
    const text = await f.text();
    await handleCsvText(text);
  });
  $("btnClear").addEventListener("click", clearAll);
  $("btnCopy").addEventListener("click", copySummary);
  $("btnHandover").addEventListener("click", handoverExport);
  // PDF just sha check
  $("pdfFile").addEventListener("change", async (e)=>{
    const f=e.target.files?.[0]; if(!f) return;
    const buf = await f.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", buf);
    const hex = [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");
    // show in stats line (no external index in this v3)
    $("stats").textContent = ($("stats").textContent==="—"?"":$("stats").textContent+" • ") + `MEL PDF SHA256: ${hex.slice(0,12)}…`;
  });
}

(async function init(){
  bind();
  await loadData();
})();
