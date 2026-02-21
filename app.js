
let ACTIONS=[], GLOSS={}, MELIDX=null;
let state={tails:[], selectedTail:null};

const $=id=>document.getElementById(id);
const esc=s=>(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const url=p=>new URL(p, window.location.href).toString();

function setLast(msg){ $("last").textContent=msg; }
function normRef(r){ return String(r).toUpperCase().replace(/(\d{2}-\d{2}-\d{2}(?:\/\d{2})?)-([A-Z])$/,'$1$2'); }

async function loadDB(){
  const h=$("health");
  try {
    ACTIONS=await fetch(url("data/actions.json"),{cache:"no-store"}).then(r=>r.json());
    GLOSS=await fetch(url("data/fpl_glossary.json"),{cache:"no-store"}).then(r=>r.json());
    try {
      const idx=await fetch(url("data/mel_pdf_index.json"),{cache:"no-store"}).then(r=>r.json());
      MELIDX=idx.index||null;
    } catch(e) { MELIDX=null; }
    for(const a of ACTIONS) a._mel_refs_norm=(a.mel_refs||[]).map(normRef);
    h.textContent=`DB: ${ACTIONS.length} rules`;
    h.style.borderColor="rgba(34,197,94,.35)";
    h.style.color="#bbf7d0";
    setLast("DB loaded.");
  } catch(e) {
    console.error(e);
    h.textContent="DB: HIBA";
    h.style.borderColor="rgba(239,68,68,.55)";
    h.style.color="#fecaca";
    setLast("DB load HIBA (data mappa?)");
  }
}

function splitCsvLine(line){
  const out=[]; let cur=""; let inQ=false;
  for(let i=0;i<line.length;i++) {
    const ch=line[i];
    if(ch=='"') {
      if(inQ && line[i+1]=='"') { cur+='"'; i++; }
      else inQ=!inQ;
    } else if(ch==',' && !inQ) { out.push(cur); cur=""; }
    else cur+=ch;
  }
  out.push(cur); return out;
}

function parseCsv(text){
  const lines=text.replace(/\r/g,"").split("\n").filter(l=>l.trim().length>0);
  if(lines.length<2) return [];
  const header=splitCsvLine(lines[0]).map(h=>h.trim().toLowerCase());
  const find=pred=>header.findIndex(pred);
  const iTail=find(h=>h.includes("aircraft")||h.includes("a/c")||h==="ac");
  const iWO=find(h=>h.includes("w/o")||h.includes("wo"));
  const iATA=find(h=>h.includes("ata"));
  const textCols=header.map((h,i)=>(h.includes("desc")||h.includes("reason")||h.includes("workorder")||h.includes("title")||h.includes("text"))?i:-1).filter(i=>i>=0);
  const rows=[];
  for(let k=1;k<lines.length;k++) {
    const cols=splitCsvLine(lines[k]);
    const tail=(cols[iTail]||"").trim();
    if(!tail) continue;
    const desc=textCols.map(ci=>(cols[ci]||"").trim()).join(" • ");
    rows.push({tail, wo:(cols[iWO]||"").trim(), ata:(cols[iATA]||"").trim(), desc, raw:lines[k]});
  }
  return rows;
}

function escapeRe(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function wordHit(hay, kw){
  const k=kw.toUpperCase();
  if(["GPS","MCDU","ADF","VOR"].includes(k)) {
    const re=new RegExp(`\\b${k}\\s*\\d?\\b`);
    if(re.test(hay)) return true;
  }
  if(k.includes(" ")) return hay.includes(k);
  return new RegExp(`\\b${escapeRe(k)}\\b`).test(hay);
}
function melRefs(hay){
  const re=/\b\d{2}-\d{2}-\d{2}(?:\/\d{2})?(?:-?[A-Z])?\b/g;
  const m=hay.match(re);
  if(!m) return [];
  return Array.from(new Set(m.map(x=>normRef(x))));
}

function deriveTag(act){
  if(act.tag==="ILS CAT") {
    const up=act.limitation.toUpperCase();
    const m=up.match(/CAT\s*IIIB.*IIIA|CAT\s*3B.*3A|CAT\s*II|CAT\s*III[A|B]?|CAT\s*I/);
    if(m) return "ILS "+m[0].replace(/\s+/g,"");
    return "ILS CAT";
  }
  if (act.tag==="GPS/PBN") {
    const up = (act.limitation||"").toUpperCase();
    if (up.includes("BOTH") && up.includes("GPS") && up.includes("INOP")) return "BOTH GPS INOP";
    if (up.includes("GPS") && up.includes("INOP")) return "GPS INOP";
    if (up.includes("GNSS") && up.includes("INOP")) return "GNSS INOP";
    return "PBN/GNSS";
  }
  return act.tag;
}

function matchRow(row){
  const hay=(row.ata+" "+row.desc+" "+row.raw).toUpperCase();
  const refs=melRefs(hay);
  const out=[];
  for(const act of ACTIONS) {
    let score=0, hits=0;
    for(const r of (act._mel_refs_norm||[])) if(refs.includes(String(r).toUpperCase())) score+=5;
    for(const kw of (act.keywords||[])) if(kw && kw.length>=3 && wordHit(hay, kw)) hits++;
    if(score===0) {
      if(hits===0) continue;
      if(act.tag==="ILS CAT" && !/(ILS|AUTOLAND|LANDING|CAT)/.test(hay)) continue;
      score += Math.min(3,hits);
    }
    const highSignal=["ADF","VOR","MCDU","GPS/PBN","CPDLC","ADS-B","TCAS","WX RADAR","RNP APCH","NAT HLA"].includes(act.tag);
    const pass=(score>=2) || (highSignal && hits>=1);
    if(pass) out.push({row, act, refs});
  }
  const seen=new Set(), uniq=[];
  for(const f of out) {
    const key=`${f.row.wo||f.row.tail+"|"+f.row.desc}|${f.act.id}`;
    if(seen.has(key)) continue;
    seen.add(key); uniq.push(f);
  }
  return uniq;
}

function buildTails(rows){
  const map=new Map(); let imported=0; let findings=0;
  for(const r of rows) {
    imported++;
    const fs=matchRow(r);
    if(fs.length===0) continue;
    findings+=fs.length;
    if(!map.has(r.tail)) map.set(r.tail, []);
    map.get(r.tail).push(...fs);
  }
  const tails=[];
  for(const [tail, fs] of map.entries()) {
    const seen=new Set(), uniq=[];
    for(const f of fs) {
      const key=`${f.row.wo||f.row.tail+"|"+f.row.desc}|${f.act.id}`;
      if(seen.has(key)) continue;
      seen.add(key); uniq.push(f);
    }
    const tagCounts=new Map();
    for(const f of uniq) {
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
  for(let ch of chunks) {
    ch=ch.trim(); if(!ch) continue;
    const isRem=/^remove:/i.test(ch);
    const isAdd=/^(insert|add:|overwrite:)/i.test(ch);
    if(!isRem && !isAdd) continue;
    const itemM=ch.match(/item\s*(10a|10b|18)\b/i);
    const item=itemM?`ITEM${itemM[1].toUpperCase()}`:"—";
    const codes=new Set();
    const pbn=ch.match(/PBN\s*:\s*([A-Z0-9,\/ ]+)/i);
    if(pbn) pbn[1].split(/[, ]+/).filter(Boolean).forEach(p=>codes.add(`PBN:${p.toUpperCase()}`));
    const tok=ch.replace(/PBN\s*:\s*[A-Z0-9,\/ ]+/ig," ");
    for(const m of tok.matchAll(/\b([A-Z]\d|TCAS|DAT\/CPDLCX|SUR\/EUADSBX|EUADSBX|X|Z|L|F|G|S|H|J1|J4)\b/g)) codes.add(m[1].toUpperCase());
    steps.push({kind:isAdd?"ADD":"REM", item, codes:[...codes]});
  }
  return steps;
}

function aggregate(findings){
  const agg={"ITEM10A":{add:new Set(),rem:new Set()}, "ITEM10B":{add:new Set(),rem:new Set()}, "ITEM18":{add:new Set(),rem:new Set()}};
  const lidoLines=[]; const ops=[]; const gloss=new Set();
  const melRefsUsed=new Set();
  for(const f of findings) {
    (f.refs||[]).forEach(r=>melRefsUsed.add(r));
    if(f.act.other && f.act.other.trim()) ops.push(f.act.other.trim());
    for(const s of parseLido(f.act.lido)) {
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
    const a=[...agg[it].add].sort(), r=[...agg[it].rem].sort();
    return `${it}: ADD ${a.length?a.join(", "):"—"}\n      REM ${r.length?r.join(", "):"—"}`;
  }).join("\n\n");

  let melInfo="—";
  if(MELIDX && melRefsUsed.size) {
    const lines=[];
    for(const ref of Array.from(melRefsUsed).slice(0,20)) {
      const ent=MELIDX[ref];
      if(!ent) continue;
      const cats=(ent.cat_tokens||[]).join(", ");
      const pg=(ent.pages||[]).slice(0,3).map(p=>p+1).join(", ");
      const sn=(ent.snippets||[])[0]||"";
      lines.push(`• ${ref} (p. ${pg})${cats? " ["+cats+"]":""} — ${sn.slice(0,160)}`);
    }
    if(lines.length) melInfo=lines.join("\n");
  }

  
  const mk = (s) => String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const fplHtml = (() => {
    const row = (it, addArr, remArr) => `
      <div class="fplRow fplItem">${mk(it)}</div>
      <div class="fplRow fplCell"><span class="hlAddBadge">ADD</span>\n${mk(addArr.length?addArr.join(", "):"—")}</div>
      <div class="fplRow fplCell"><span class="hlRemBadge">REMOVE</span>\n${mk(remArr.length?remArr.join(", "):"—")}</div>`;
    const parts = [];
    parts.push('<div class="fplTable">');
    for (const it of ["ITEM10A","ITEM10B","ITEM18"]) {
      const addArr=[...agg[it].add].sort();
      const remArr=[...agg[it].rem].sort();
      parts.push(row(it, addArr, remArr));
    }
    parts.push('</div>');
    return parts.join("");
  })();

  const lidoHtml = (() => {
    if(!lidoLines.length) return '<span class="muted">—</span>';
    const lines = lidoLines.map(line=>{
      const up=line.toUpperCase();
      if(up.startsWith("ADD:")) {
        const rest=line.slice(4).trim();
        return `<div class="lidoLine"><span class="hlAddBadge">INSERT</span> <span class="hlAdd">${mk(rest)}</span></div>`;
      }
      if(up.startsWith("REMOVE:") || up.startsWith("REM:")) {
        const rest=line.replace(/^REMOVE:|^REM:/i,"").trim();
        return `<div class="lidoLine"><span class="hlRemBadge">REMOVE</span> <span class="hlRem">${mk(rest)}</span></div>`;
      }
      return `<div class="lidoLine">${mk(line)}</div>`;
    }).join("");
    return `<div class="lidoList">${lines}</div>`;
  })();


  // ---- Explanation builder (Hungarian) ----
  const explainCode = (code) => {
    const c = String(code||"").toUpperCase();
    if (c === "G") return "Item 10a 'G' = GNSS. Ha GPS/GNSS INOP, a GNSS-képességet nem szabad deklarálni → REMOVE.";
    if (c === "J1" || c === "J4") return "CPDLC capability code (J1/J4). CPDLC INOP esetén törlendő.";
    if (c === "TCAS") return "TCAS/ACAS capability. INOP esetén a TCAS jelölés(ek)et ki kell venni.";
    if (c === "DAT/CPDLCX") return "Item 18 DAT/CPDLCX: datalink/CPDLC jelölés. INOP esetén törlendő / működő esetben deklarálandó (policy szerint).";
    if (c === "SUR/EUADSBX" || c === "EUADSBX") return "ADS-B special filing (SUR/EUADSBX). ADS-B OUT INOP esetén a policy szerinti jelölések változhatnak.";
    if (c.startsWith("PBN:")) return "PBN/ mezőben deklarált RNAV/RNP képesség. MEL miatt (pl. GNSS kiesés) GNSS-függő kódokat el kell távolítani, és csak a ténylegesen rendelkezésre álló szenzoros módokat szabad hagyni.";
    if (/^[A-Z]\d$/.test(c)) return "PBN kód: RNAV/RNP navspec + szenzor. Csak akkor maradhat, ha a vonatkozó navigációs mód ténylegesen elérhető.";
    if (c === "Z") return "Item 10a 'Z' = egyéb felszerelés, részletezés az Item 18-ban.";
    return "";
  };

  const expLines = [];
  for (const it of ["ITEM10A","ITEM10B","ITEM18"]) {
    for (const c of [...agg[it].add]) expLines.push({kind:"ADD", item:it, code:c});
    for (const c of [...agg[it].rem]) expLines.push({kind:"REMOVE", item:it, code:c});
  }
  const seenExp = new Set();
  const uniqExp = expLines.filter(x=>{
    const k = `${x.kind}|${x.item}|${x.code}`;
    if (seenExp.has(k)) return false;
    seenExp.add(k); return true;
  });

  const srcText = (refsArr) => {
    const refs = Array.from(new Set(refsArr||[])).slice(0,6);
    return refs.length ? `Forrás: Excel action-mátrix + MEL ref: ${refs.join(", ")} (PDF index, ha elérhető)` : "Forrás: Excel action-mátrix (MEL ref nem azonosítható a CSV-ben)";
  };

  const refsForAudit = Array.from(melRefsUsed||[]);
  const whyCards = [];
  if (uniqExp.length === 0) {
    whyCards.push(`
      <div class="whyCard">
        <div class="whyHead">
          <div class="whyTitle">Nincs FPL/LIDO változtatás</div>
          <div class="whySrc">${mk(srcText(refsForAudit))}</div>
        </div>
        <div class="whyBody">Ehhez a lajstromhoz nem került azonosításra olyan dispatch-releváns teendő, ami FPL módosítást igényel.</div>
      </div>`);
  } else {
    const byItem = {};
    for (const x of uniqExp) (byItem[x.item] ||= []).push(x);
    for (const item of Object.keys(byItem)) {
      const arr = byItem[item].sort((a,b)=>a.kind.localeCompare(b.kind)||String(a.code).localeCompare(String(b.code)));
      const lines = arr.map(x=>{
        const reason = explainCode(x.code);
        const badge = x.kind === "ADD" ? '<span class="hlAddBadge">INSERT</span>' : '<span class="hlRemBadge">REMOVE</span>';
        const colClass = x.kind === "ADD" ? "hlAdd" : "hlRem";
        return `<div class="whyLine">${badge} <span class="k">${mk(item)}</span> <b class="${colClass}">${mk(x.code)}</b>${reason?`<div class="cardSub">${mk(reason)}</div>`:""}</div>`;
      }).join("");
      whyCards.push(`
        <div class="whyCard">
          <div class="whyHead">
            <div class="whyTitle">${mk(item)} – miért ez a változás?</div>
            <div class="whySrc">${mk(srcText(refsForAudit))}</div>
          </div>
          <div class="whyCodes">${lines}</div>
          <div class="cardSub">Hivatkozás: EUROCONTROL IFPS User Manual / Learning Zone (kódfeltöltési szabályok) + belső action-mátrix.</div>
        </div>`);
    }
  }
  const whyHtml = `<div class="whyList">${whyCards.join("")}</div>`;

return {fplText, fplHtml, lidoText:lidoLines.length?lidoLines.join("\n"):"—", lidoHtml, opsText:ops.length?[...new Set(ops)].join("\n\n"):"—", gloss:[...gloss], melInfo, whyHtml};
}

function renderTails(){
  const list=$("tailList");
  if(state.tails.length===0) {
    list.classList.add("empty");
    list.textContent="Nincs dispatch-releváns találat.";
    return;
  }
  list.classList.remove("empty");
  list.innerHTML="";
  for(const t of state.tails) {
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

function selectTail(tail){ state.selectedTail=tail; renderTails(); renderSelected(); }

function renderSelected(){
  const box=$("itemList");
  if(!state.selectedTail) {
    box.classList.add("empty"); box.textContent="Válassz egy lajstromot.";
    $("selCount").textContent="—";
    $("selTitle").textContent="Teendők";
    $("fplBox").innerHTML="—"; $("lidoBox").innerHTML="—"; $("opsBox").textContent="—"; $("glossBox").textContent="—"; $("melBox").textContent="—";
    return;
  }
  const t=state.tails.find(x=>x.tail===state.selectedTail);
  const fs=t?t.findings:[];
  $("selTitle").textContent=`Teendők – ${state.selectedTail}`;
  $("selCount").textContent=`Aktív dispatch-releváns tételek: ${fs.length}`;
  box.classList.remove("empty"); box.innerHTML="";
  for(const f of fs) {
    const el=document.createElement("div"); el.className="item";
    el.innerHTML=`<div class="row"><div><b>${esc(f.act.limitation)}</b></div><div class="badge">${esc(deriveTag(f.act))}</div></div>
      <div class="cardSub">W/O ${esc(f.row.wo||"—")} • ATA ${esc(f.row.ata||"—")}</div>
      <div class="cardSub">${esc(f.row.desc||"")}</div>`;
    box.appendChild(el);
  }
  const out=aggregate(fs);
  $("fplBox").innerHTML=out.fplHtml;
  $("lidoBox").innerHTML=out.lidoHtml;
  $("opsBox").textContent=out.opsText;
  $("glossBox").innerHTML=renderGloss(out.gloss);
  $("melBox").textContent=out.melInfo;
  $("whyBox").innerHTML=out.whyHtml;
}

async function handleCsvText(text) {
  setLast("CSV feldolgozás…");
  const rows=parseCsv(text);
  const built=buildTails(rows);
  state.tails=built.tails;
  state.selectedTail=built.tails[0]?.tail||null;
  $("stats").textContent=`Importált sorok: ${built.imported} • Lajstromok: ${built.tails.length} • Találatok: ${built.findings}`;
  renderTails(); renderSelected();
  setLast(`Kész. Találatok: ${built.findings} • Lajstrom: ${built.tails.length}`);
}

function copySummary() {
  if(!state.selectedTail) return;
  const t=state.tails.find(x=>x.tail===state.selectedTail);
  const out=aggregate(t.findings);
  navigator.clipboard?.writeText(`MEL Dispatch – ${state.selectedTail}\n\nICAO FPL:\n${out.fplText}\n\nLIDO:\n${out.lidoText}\n\nOPS:\n${out.opsText}\n\nMEL refs:\n${out.melInfo}\n`);
  setLast("Másolva.");
}

function handover() {
  if(state.tails.length===0) return;
  const lines=state.tails.map(t=>{
    const tags=[...t.tagCounts.entries()].sort((a,b)=>b[1]-a[1]).map(([k,n])=>`${k}${n>1?`×${n}`:""}`).join(", ");
    return `${t.tail} – ${t.melCount} MEL – ${tags}`;
  }).join("\n");
  navigator.clipboard?.writeText(lines);
  setLast("Handover a vágólapon.");
}

function clearAll() {
  state={tails:[], selectedTail:null};
  $("tailList").classList.add("empty"); $("tailList").textContent="Tölts fel CSV-t.";
  $("itemList").classList.add("empty"); $("itemList").textContent="Válassz egy lajstromot.";
  $("stats").textContent="—"; $("selCount").textContent="—";
  $("selTitle").textContent="Teendők";
  $("fplBox").innerHTML="—"; $("lidoBox").innerHTML="—"; $("opsBox").textContent="—"; $("glossBox").textContent="—"; $("melBox").textContent="—";
  setLast("Törölve.");
}

async function sha256(file) {
  const buf=await file.arrayBuffer();
  const hash=await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

function enableDnD() {
  const dropTargets=[document.body, $("csvFile")];
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

function bind() {
  $("btnImportPaste").onclick=async()=>{ await handleCsvText($("csvPaste").value); };
  $("btnClear").onclick=clearAll;
  $("btnHandover").onclick=handover;
  $("btnCopy").onclick=copySummary;

  $("dailyPdf")?.addEventListener("change", async (e)=>{
  const f=e.target.files?.[0];
  if(!f){ setLast("Daily PDF választás megszakítva."); return; }
  setLast(`Daily PDF: ${f.name} – feldolgozás…`);
  const dbg=document.getElementById("dailyDebug");
  try{
    const lines = await extractPdfLinesDaily(f);
    if(dbg) dbg.textContent = `Extracted lines: ${lines.length}`;
    const rows = parseDailyFromLines(lines);
    if(!rows.length){ setLast("Daily PDF: 0 sor (header megtalálva, de üres)."); return; }
    await handleRows(rows, "Daily(PDF)");
    setLast(`Daily(PDF) import kész: ${rows.length} sor`);
  }catch(err){ console.error(err); if(dbg) dbg.textContent = String(err); setLast("Daily PDF parse hiba (pdf.js / header)."); }
  finally{ e.target.value=""; }
});

$("csvFile").addEventListener("change", async (e)=>{
    const f=e.target.files?.[0];
    if(!f) { setLast("CSV választás megszakítva."); return; }
    setLast(`CSV: ${f.name} – olvasás…`);
    const text=await f.text();
    await handleCsvText(text);
    e.target.value="";
  });
  $("pdfFile").addEventListener("change", async (e)=>{
    const f=e.target.files?.[0];
    if(!f) { setLast("PDF választás megszakítva."); return; }
    setLast(`PDF: ${f.name} – SHA…`);
    const hex=await sha256(f);
    $("stats").textContent = ($("stats").textContent==="—"?"":$("stats").textContent+" • ")+`PDF SHA: ${hex.slice(0,12)}…`;
    setLast("PDF SHA OK.");
    e.target.value="";
  });
}

(async function init() {
  await loadDB();
  bind();
  enableDnD();
  setLast("Ready. Válassz CSV-t.");
  console.log("MEL Dispatch Assistant v3.5.0-melindex");
})();
