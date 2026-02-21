
let ACTIONS=[], GLOSS={};
let state={tails:[], selectedTail:null};
const $=id=>document.getElementById(id);

function setLast(msg){
  $("last").textContent = msg;
}
function url(p){ return new URL(p, window.location.href).toString(); }
function esc(s){ return (s||"").replace(/[&<>"']/g,c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

async function loadDB(){
  const h=$("health");
  try{

    ACTIONS=await fetch(url("data/actions.json"), {cache:"no-store"}).then(r=>r.json());
    // Normalize MEL refs in rules to match CSV variants (e.g. 30-45-03-A -> 30-45-03A)
    for (const a of ACTIONS){
      if(!a.mel_refs) continue;
      a._mel_refs_norm = a.mel_refs.map(x => String(x).toUpperCase().replace(/(\d{2}-\d{2}-\d{2}(?:\/\d{2})?)-([A-Z])$/,'$1$2'));
    }

    GLOSS=await fetch(url("data/fpl_glossary.json"), {cache:"no-store"}).then(r=>r.json());
    h.textContent=`DB: ${ACTIONS.length} rules`;
    h.style.borderColor="rgba(34,197,94,.35)";
    h.style.color="#bbf7d0";
    setLast("DB loaded.");
  }catch(e){
    console.error(e);
    h.textContent="DB: HIBA";
    h.style.borderColor="rgba(239,68,68,.55)";
    h.style.color="#fecaca";
    setLast("DB load HIBA (data mappa hiányzik?)");
  }
}

function splitCsvLine(line){
  const out=[]; let cur=""; let inQ=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch === '"'){
      if(inQ && line[i+1] === '"'){ cur+='"'; i++; }
      else inQ=!inQ;
    } else if(ch===',' && !inQ){ out.push(cur); cur=""; }
    else cur+=ch;
  }
  out.push(cur); return out;
}

function parseCsv(text){
  const lines=text.replace(/\r/g,"").split("\n").filter(l=>l.trim().length>0);
  if(lines.length<2) return [];
  const header=splitCsvLine(lines[0]).map(h=>h.trim().toLowerCase());
  const find=(pred)=>header.findIndex(pred);
  const iTail=find(h=>h.includes("aircraft")||h.includes("a/c")||h==="ac");
  const iWO=find(h=>h.includes("w/o")||h.includes("wo"));
  const iATA=find(h=>h.includes("ata"));
  const iDesc=find(h=>h.includes("workorder")||h.includes("description")||h.includes("reason"));
  const rows=[];
  for(let k=1;k<lines.length;k++){
    const cols=splitCsvLine(lines[k]);
    const tail=(cols[iTail]||"").trim();
    if(!tail) continue;
    rows.push({tail, wo:(cols[iWO]||"").trim(), ata:(cols[iATA]||"").trim(), desc:(cols[iDesc]||"").trim(), raw:lines[k]});
  }
  return rows;
}

function escapeRe(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function wordHit(hay, kw){
  const k=kw.toUpperCase();
  if(k.includes(" ")) return hay.includes(k);
  return new RegExp(`\\b${escapeRe(k)}\\b`).test(hay);
}

function melRefs(hay){
  // Capture common MEL reference variants:
  //  - 30-45-03A
  //  - 30-45-03-A
  //  - 35-30-01-A
  //  - 22-82-01/02-A
  const re = /\b\d{2}-\d{2}-\d{2}(?:\/\d{2})?(?:-?[A-Z])?\b/g;
  const m = hay.match(re);
  if(!m) return [];
  const normed = m.map(x => x.toUpperCase().replace(/(\d{2}-\d{2}-\d{2}(?:\/\d{2})?)-([A-Z])$/,'$1$2'));
  return Array.from(new Set(normed));
}


function deriveTag(act){
  if(act.tag==="ILS CAT"){
    const up=act.limitation.toUpperCase();
    const m=up.match(/CAT\s*IIIB.*IIIA|CAT\s*3B.*3A|CAT\s*II|CAT\s*III[A|B]?|CAT\s*I/);
    if(m) return "ILS "+m[0].replace(/\s+/g,"");
    return "ILS CAT";
  }
  if(act.tag==="GPS/PBN") return "PBN";
  return act.tag;
}

function matchRow(row){
  const hay=(row.ata+" "+row.desc+" "+row.raw).toUpperCase();
  const refs=melRefs(hay);
  const out=[];
  for(const act of ACTIONS){
    let score=0, hits=0;
    for(const r of (act._mel_refs_norm||act.mel_refs||[])) if(refs.includes(String(r).toUpperCase())) score+=5;
    for(const kw of (act.keywords||[])) if(kw && kw.length>=3 && wordHit(hay, kw)) hits++;
    if(score===0){
      if(hits===0) continue;
      if(act.tag==="ILS CAT" && !/(ILS|AUTOLAND|LANDING|CAT)/.test(hay)) continue;
      score += Math.min(3,hits);
    }
    if(score>=2) out.push({row, act});
  }
  const seen=new Set(), uniq=[];
  for(const f of out){
    const key=`${f.row.wo||f.row.tail+"|"+f.row.desc}|${f.act.id}`;
    if(seen.has(key)) continue;
    seen.add(key); uniq.push(f);
  }
  return uniq;
}

function buildTails(rows){
  const map=new Map(); let imported=0; let findings=0;
  for(const r of rows){
    imported++;
    const fs=matchRow(r);
    if(fs.length===0) continue;
    findings+=fs.length;
    if(!map.has(r.tail)) map.set(r.tail, []);
    map.get(r.tail).push(...fs);
  }
  const tails=[];
  for(const [tail, fs] of map.entries()){
    const seen=new Set(), uniq=[];
    for(const f of fs){
      const key=`${f.row.wo||f.row.tail+"|"+f.row.desc}|${f.act.id}`;
      if(seen.has(key)) continue;
      seen.add(key); uniq.push(f);
    }
    const tagCounts=new Map();
    for(const f of uniq){
      const tag=deriveTag(f.act);
      tagCounts.set(tag,(tagCounts.get(tag)||0)+1);
    }
    tails.push({tail, findings:uniq, melCount:uniq.length, tagCounts});
  }
  tails.sort((a,b)=>b.melCount-a.melCount||a.tail.localeCompare(b.tail));
  return {tails, imported, findings};
}

function parseLido(lido){
  const raw=(lido||"").replace(/\s+/g," ").trim();
  if(!raw) return [];
  const chunks=raw.split(/(?=(?:Remove:|REMOVE:|Insert|INSERT|Overwrite:|OVERWRITE:|Add:|ADD:))/);
  const steps=[];
  for(let ch of chunks){
    ch=ch.trim(); if(!ch) continue;
    const isRem=/^remove:/i.test(ch);
    const isAdd=/^(insert|add:|overwrite:)/i.test(ch);
    if(!isRem && !isAdd) continue;
    const itemM=ch.match(/item\s*(10a|10b|18)\b/i);
    const item=itemM?`ITEM${itemM[1].toUpperCase()}`:"—";
    const codes=new Set();
    const pbn=ch.match(/PBN\s*:\s*([A-Z0-9,\/ ]+)/i);
    if(pbn){ pbn[1].split(/[, ]+/).filter(Boolean).forEach(p=>codes.add(`PBN:${p.toUpperCase()}`)); }
    const tok=ch.replace(/PBN\s*:\s*[A-Z0-9,\/ ]+/ig," ");
    for(const m of tok.matchAll(/\b([A-Z]\d|TCAS|DAT\/CPDLCX|SUR\/EUADSBX|EUADSBX|X|Z|L|F|G|S|H|J1|J4)\b/g)) codes.add(m[1].toUpperCase());
    steps.push({kind:isAdd?"ADD":"REM", item, codes:[...codes]});
  }
  return steps;
}

function aggregate(findings){
  const agg={"ITEM10A":{add:new Set(),rem:new Set()},"ITEM10B":{add:new Set(),rem:new Set()},"ITEM18":{add:new Set(),rem:new Set()}};
  const lidoLines=[]; const ops=[]; const gloss=new Set();
  for(const f of findings){
    if(f.act.other && f.act.other.trim()) ops.push(f.act.other.trim());
    for(const s of parseLido(f.act.lido)){
      const tgt = s.kind==="ADD" ? agg[s.item]?.add : agg[s.item]?.rem;
      if(tgt) s.codes.forEach(c=>tgt.add(c));
      lidoLines.push(`${s.kind}: ${s.item} → ${s.codes.length?s.codes.join(", "):"—"}`);
      s.codes.forEach(c=>{
        if(c.startsWith("PBN:")) gloss.add("PBN/");
        if(GLOSS[c]) gloss.add(c);
        if(c.includes("CPDLC")) gloss.add("DAT/CPDLCX");
        if(c==="TCAS") gloss.add("TCAS");
        if(/^[BCDGJ]\d$/.test(c)) gloss.add(c);
        if(c==="Z") gloss.add("Z");
        if(c==="J1"||c==="J4") gloss.add(c);
        if(c==="SUR/EUADSBX"||c==="EUADSBX") gloss.add("SUR/EUADSBX");
      });
    }
  }
  const fplText=["ITEM10A","ITEM10B","ITEM18"].map(it=>{
    const a=[...agg[it].add].sort(); const r=[...agg[it].rem].sort();
    return `${it}: ADD ${a.length?a.join(", "):"—"}\n      REM ${r.length?r.join(", "):"—"}`;
  }).join("\n\n");
  return {fplText, lidoText:lidoLines.length?lidoLines.join("\n"):"—", opsText:ops.length?[...new Set(ops)].join("\n\n"):"—", gloss:[...gloss]};
}

function renderTails(){
  const list=$("tailList");
  if(state.tails.length===0){
    list.classList.add("empty");
    list.textContent="Nincs dispatch-releváns találat.";
    return;
  }
  list.classList.remove("empty");
  list.innerHTML="";
  for(const t of state.tails){
    const el=document.createElement("div");
    el.className="item"+(state.selectedTail===t.tail?" active":"");
    el.onclick=()=>selectTail(t.tail);
    const tags=[...t.tagCounts.entries()].sort((a,b)=>b[1]-a[1]).map(([k,n])=>`<span class="tag">${esc(k)}${n>1?` ×${n}`:""}</span>`).join("");
    el.innerHTML=`<div class="row"><div class="tail">${esc(t.tail)}</div><div class="badge">${t.melCount} MEL</div></div>
      <div class="cardSub">Dispatch releváns tételek: ${t.melCount}</div><div class="tags">${tags}</div>`;
    list.appendChild(el);
  }
}

function renderGloss(keys){
  if(!keys||keys.length===0) return `<span class="muted">Nincs FPL-kód.</span>`;
  const uniq=[...new Set(keys)];
  return `<div class="kv">`+uniq.map(k=>{
    const g=GLOSS[k];
    if(!g) return `<span class="badge">${esc(k)}</span>`;
    return `<div class="item" style="cursor:default"><div class="row"><div><b>${esc(g.title)}</b></div><div class="badge">${esc(k)}</div></div>
      <div class="cardSub">${esc(g.why)}</div><div class="cardSub muted">${esc(g.see)}</div></div>`;
  }).join("")+`</div>`;
}

function selectTail(tail){
  state.selectedTail=tail;
  renderTails();
  renderSelected();
}

function renderSelected(){
  const box=$("itemList");
  if(!state.selectedTail){
    box.classList.add("empty"); box.textContent="Válassz egy lajstromot.";
    $("selCount").textContent="—";
    $("selTitle").textContent="Teendők";
    $("fplBox").textContent="—"; $("lidoBox").textContent="—"; $("opsBox").textContent="—"; $("glossBox").textContent="—";
    return;
  }
  const t=state.tails.find(x=>x.tail===state.selectedTail);
  const fs=t?t.findings:[];
  $("selTitle").textContent=`Teendők – ${state.selectedTail}`;
  $("selCount").textContent=`Aktív dispatch-releváns tételek: ${fs.length}`;
  box.classList.remove("empty"); box.innerHTML="";
  for(const f of fs){
    const el=document.createElement("div"); el.className="item";
    el.innerHTML=`<div class="row"><div><b>${esc(f.act.limitation)}</b></div><div class="badge">${esc(deriveTag(f.act))}</div></div>
      <div class="cardSub">W/O ${esc(f.row.wo||"—")} • ATA ${esc(f.row.ata||"—")}</div>
      <div class="cardSub">${esc(f.row.desc||"")}</div>`;
    box.appendChild(el);
  }
  const out=aggregate(fs);
  $("fplBox").textContent=out.fplText;
  $("lidoBox").textContent=out.lidoText;
  $("opsBox").textContent=out.opsText;
  $("glossBox").innerHTML=renderGloss(out.gloss);
}

async function handleCsvText(text){
  setLast("CSV feldolgozás…");
  const rows=parseCsv(text);
  const built=buildTails(rows);
  state.tails=built.tails;
  state.selectedTail=built.tails[0]?.tail||null;
  $("stats").textContent=`Importált sorok: ${built.imported} • Lajstromok: ${built.tails.length} • Találatok: ${built.findings}`;
  renderTails();
  renderSelected();
  setLast(`Kész. Találatok: ${built.findings} • Lajstrom: ${built.tails.length}`);
}

function copySummary(){
  if(!state.selectedTail) return;
  const t=state.tails.find(x=>x.tail===state.selectedTail);
  const out=aggregate(t.findings);
  navigator.clipboard?.writeText(`MEL Dispatch – ${state.selectedTail}\n\nICAO FPL:\n${out.fplText}\n\nLIDO:\n${out.lidoText}\n\nOPS:\n${out.opsText}\n`);
  setLast("Másolva.");
}
function handover(){
  if(state.tails.length===0) return;
  const lines=state.tails.map(t=>{
    const tags=[...t.tagCounts.entries()].sort((a,b)=>b[1]-a[1]).map(([k,n])=>`${k}${n>1?`×${n}`:""}`).join(", ");
    return `${t.tail} – ${t.melCount} MEL – ${tags}`;
  }).join("\n");
  navigator.clipboard?.writeText(lines);
  setLast("Handover a vágólapon.");
}
function clearAll(){
  state={tails:[], selectedTail:null};
  $("tailList").classList.add("empty"); $("tailList").textContent="Tölts fel CSV-t.";
  $("itemList").classList.add("empty"); $("itemList").textContent="Válassz egy lajstromot.";
  $("stats").textContent="—"; $("selCount").textContent="—";
  $("selTitle").textContent="Teendők";
  $("fplBox").textContent="—"; $("lidoBox").textContent="—"; $("opsBox").textContent="—"; $("glossBox").textContent="—";
  setLast("Törölve.");
}
async function sha256(file){
  const buf=await file.arrayBuffer();
  const hash=await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

function enableDnD(){
  const el=$("csvFile");
  const dropTargets=[document.body, el];
  dropTargets.forEach(t=>{
    t.addEventListener("dragover",(e)=>{ e.preventDefault(); setLast("Drop CSV…"); });
    t.addEventListener("drop", async (e)=>{
      e.preventDefault();
      const f=e.dataTransfer?.files?.[0];
      if(!f) return;
      if(!f.name.toLowerCase().endsWith(".csv")) { setLast("Nem CSV fájl."); return; }
      setLast(`Drop: ${f.name} – olvasás…`);
      const text=await f.text();
      await handleCsvText(text);
    });
  });
}

function bind(){
  $("btnImportPaste").onclick=async()=>{ await handleCsvText($("csvPaste").value); };
  $("btnClear").onclick=clearAll;
  $("btnHandover").onclick=handover;
  $("btnCopy").onclick=copySummary;

  $("csvFile").addEventListener("change", async (e)=>{
    const f=e.target.files?.[0];
    if(!f){ setLast("CSV választás megszakítva."); return; }
    setLast(`CSV: ${f.name} – olvasás…`);
    const text=await f.text();
    await handleCsvText(text);
    e.target.value="";
  });
  $("pdfFile").addEventListener("change", async (e)=>{
    const f=e.target.files?.[0];
    if(!f){ setLast("PDF választás megszakítva."); return; }
    setLast(`PDF: ${f.name} – SHA…`);
    const hex=await sha256(f);
    $("stats").textContent = ($("stats").textContent==="—"?"":$("stats").textContent+" • ")+`PDF SHA: ${hex.slice(0,12)}…`;
    setLast("PDF SHA OK.");
    e.target.value="";
  });
}

(async function init(){
  bind();
  enableDnD();
  await loadDB();
  setLast("Ready. Válassz CSV-t.");
})();
