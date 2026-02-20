
(() => {
  'use strict';

  const state = {
    actions: [],
    glossary: {},
    pdfIndex: null,
    csvRows: [],
    tails: new Map(), // tail -> {tail, items:[{wo, desc, action, refCats:[]}]}
    selectedTail: null,
    lastImportSig: null,
    delta: {new:0, removed:0, changed:0}
  };

  const el = (id) => document.getElementById(id);
  const tailsList = () => el('tailsList');

  function setStatus(msg){ el('statusLine').textContent = msg; }

  async function loadJson(path){
    const url = new URL(path, window.location.href);
    const res = await fetch(url);
    if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  }

  async function init(){
    bindUI();
    try{
      const [a,g,p] = await Promise.all([
        loadJson('data/actions.json'),
        loadJson('data/fpl_glossary.json'),
        loadJson('data/mel_pdf_index.json')
      ]);
      state.actions = a.actions || [];
      state.glossary = g || {};
      state.pdfIndex = p || null;
      setStatus(`Rules: ${a.version || 'n/a'} • PDF index: ${p?.sha256 ? 'loaded' : 'missing'}`);
    } catch(err){
      console.error(err);
      setStatus(`HIBA: nem sikerült betölteni a data/*.json fájlokat. Console: ${err.message}`);
    }
    render();
  }

  function bindUI(){
    el('csvFile').addEventListener('change', async (ev) => {
      const f = ev.target.files?.[0];
      if(!f) return;
      const txt = await f.text();
      importCsvText(txt, f.name);
    });
    el('pdfFile').addEventListener('change', async (ev) => {
      const f = ev.target.files?.[0];
      if(!f) return;
      await checkPdfSha(f);
    });
    el('clearBtn').addEventListener('click', () => {
      state.csvRows=[]; state.tails.clear(); state.selectedTail=null;
      render();
      setStatus('CSV törölve.');
    });
    el('csvPasteBtn').addEventListener('click', () => {
      el('pastePanel').hidden = false;
      el('csvPasteArea').value='';
      el('csvPasteArea').focus();
    });
    el('pasteCloseBtn').addEventListener('click', () => el('pastePanel').hidden = true);
    el('pasteImportBtn').addEventListener('click', () => {
      const txt = el('csvPasteArea').value || '';
      el('pastePanel').hidden = true;
      importCsvText(txt, 'pasted.csv');
    });
    el('copyBtn').addEventListener('click', () => {
      const txt = buildCopyTextForSelected();
      navigator.clipboard.writeText(txt);
    });
    el('handoverBtn').addEventListener('click', () => {
      const txt = buildHandoverExport();
      navigator.clipboard.writeText(txt);
    });
  }

  async function checkPdfSha(file){
    const buf = await file.arrayBuffer();
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    const hashArr = Array.from(new Uint8Array(hashBuf));
    const sha = hashArr.map(b=>b.toString(16).padStart(2,'0')).join('');
    const ok = state.pdfIndex?.sha256 && sha === state.pdfIndex.sha256;
    const msg = ok ? `OK (index egyezik)` : `FIGYELEM: a feltöltött MEL PDF SHA eltér az indexeltől. Futtasd: tools/build_mel_index.py`;
    setStatus(`MEL PDF: ${file.name} • SHA256: ${sha.slice(0,8)}… • ${msg}`);
  }

  function detectDelimiter(line){
    const commas=(line.match(/,/g)||[]).length;
    const semis=(line.match(/;/g)||[]).length;
    return semis>commas ? ';' : ',';
  }

  function parseCsv(text){
    const lines = text.split(/\r?\n/).filter(l=>l.trim().length>0);
    if(lines.length<2) return [];
    const delim = detectDelimiter(lines[0]);
    const header = splitCsvLine(lines[0], delim).map(h=>h.trim());
    const rows=[];
    for(let i=1;i<lines.length;i++){
      const cols = splitCsvLine(lines[i], delim);
      const obj={};
      header.forEach((h,idx)=> obj[h]= (cols[idx]||'').trim());
      rows.push(obj);
    }
    return rows;
  }

  function splitCsvLine(line, delim){
    // minimal CSV parser with quotes
    const out=[]; let cur=''; let inQ=false;
    for(let i=0;i<line.length;i++){
      const ch=line[i];
      if(ch === '"'){ inQ = !inQ; continue; }
      if(ch===delim && !inQ){ out.push(cur); cur=''; continue; }
      cur+=ch;
    }
    out.push(cur);
    return out;
  }

  function normalize(s){ return (s||'').toUpperCase(); }

  function extractRefs(text){
    const m = normalize(text).match(/\b\d{2}-\d{2}-\d{2}[A-Z]?\b/g);
    return m ? Array.from(new Set(m)) : [];
  }

  function matchActions(hay){
    const H = normalize(hay);
    const matches=[];
    for(const a of state.actions){
      const tks = a.triggers || [a.title];
      let hit=false;
      for(const t of tks){
        const T = normalize(t);
        if(T.length<3) continue;
        if(H.includes(T)){ hit=true; break; }
      }
      if(hit) matches.push(a);
    }
    // additional mapping: ATC DATALINK -> CPDLC INOP
    if(H.includes('DATALINK') && !matches.some(m=>normalize(m.title).includes('CPDLC'))){
      const cp = state.actions.find(m=>normalize(m.title).includes('CPDLC'));
      if(cp) matches.push(cp);
    }
    return matches;
  }

  function catTagForRefs(refs){
    if(!state.pdfIndex?.refs) return null;
    for(const r of refs){
      const entry = state.pdfIndex.refs[r];
      if(entry?.cat_tokens?.length){
        // prefer explicit CAT II/III tokens
        const tokens = entry.cat_tokens;
        // build compact label
        if(tokens.includes('CAT3B') && tokens.includes('CAT3A')) return 'CAT3B→3A';
        if(tokens.includes('CATII')) return 'CATII';
        if(tokens.includes('CATIII')) return 'CATIII';
        if(tokens.includes('CATI')) return 'CATI';
        const cat3 = tokens.find(t=>t.startsWith('CAT3'));
        if(cat3) return cat3;
      }
    }
    return null;
  }

  function importCsvText(text, name){
    try{
      const rows = parseCsv(text);
      state.csvRows = rows;
      buildTailsFromRows(rows);
      setStatus(`CSV: ${name} • importált sorok: ${rows.length} • dispatch-releváns lajstromok: ${state.tails.size}`);
      render();
    }catch(err){
      console.error(err);
      setStatus(`CSV import hiba: ${err.message}`);
    }
  }

  function getTailField(row){
    const keys = Object.keys(row);
    const k = keys.find(k=>normalize(k).includes('AIRCRAFT')) || keys.find(k=>normalize(k)==='A/C') || keys.find(k=>normalize(k).includes('AC'));
    return k || keys[0];
  }
  function getWoField(row){
    const keys=Object.keys(row);
    return keys.find(k=>normalize(k).includes('W/O')) || keys.find(k=>normalize(k).includes('WO')) || keys.find(k=>normalize(k).includes('WORK')) || null;
  }
  function getDescField(row){
    const keys=Object.keys(row);
    return keys.find(k=>normalize(k).includes('DESCR')) || keys.find(k=>normalize(k).includes('REASON')) || keys.find(k=>normalize(k).includes('TITLE')) || null;
  }

  function buildTailsFromRows(rows){
    state.tails.clear();
    if(!rows.length) return;
    const tailKey = getTailField(rows[0]);
    const woKey = getWoField(rows[0]);
    const descKey = getDescField(rows[0]);

    for(const row of rows){
      const tail = (row[tailKey]||'').trim();
      if(!tail) continue;
      const wo = woKey ? (row[woKey]||'').trim() : '';
      const desc = descKey ? (row[descKey]||'').trim() : JSON.stringify(row);
      const hay = `${tail} ${wo} ${desc} ${Object.values(row).join(' ')}`;

      const refs = extractRefs(hay);
      const acts = matchActions(hay);

      // dispatch relevant only if at least one action match
      if(!acts.length) continue;

      const t = state.tails.get(tail) || {tail, entries:[]};
      for(const a of acts){
        t.entries.push({
          tail, wo, desc,
          action: a,
          refs,
          cat: (normalize(a.title).includes('ILS') || normalize(a.title).includes('CAT')) ? catTagForRefs(refs) : null
        });
      }
      state.tails.set(tail, t);
    }

    // sort entries per tail unique by (wo|action.id|desc)
    for(const t of state.tails.values()){
      const seen=new Set();
      const uniq=[];
      for(const e of t.entries){
        const key = `${e.wo}|${e.action.id}|${e.desc}`;
        if(seen.has(key)) continue;
        seen.add(key); uniq.push(e);
      }
      t.entries = uniq;
    }
  }

  function render(){
    renderTails();
    renderSelected();
  }

  function renderTails(){
    const list = tailsList();
    list.innerHTML='';
    const tails = Array.from(state.tails.values()).sort((a,b)=>b.entries.length - a.entries.length || a.tail.localeCompare(b.tail));
    if(!tails.length){
      list.innerHTML = `<div class="meta" style="padding:10px">Nincs adat.</div>`;
      return;
    }
    for(const t of tails){
      const div=document.createElement('div');
      div.className='item' + (state.selectedTail===t.tail ? ' active':'');
      const count=t.entries.length;
      const tags = buildTagsForTail(t);
      div.innerHTML = `
        <div class="row">
          <div class="tail">${t.tail}</div>
          <div class="badge ${count>1?'warn':''}">${count} MEL</div>
        </div>
        <div class="meta">Dispatch releváns tételek: ${count}</div>
        <div class="chips">${tags.map(x=>`<span class="chip">${x}</span>`).join('')}</div>
      `;
      div.addEventListener('click', ()=>{ state.selectedTail=t.tail; render(); });
      list.appendChild(div);
    }
  }

  function buildTagsForTail(t){
    const map=new Map(); // label->count
    for(const e of t.entries){
      let tag = e.action.tag || 'MEL';
      if(tag==='ILS' && e.cat) tag = `ILS ${e.cat}`;
      map.set(tag, (map.get(tag)||0)+1);
    }
    const tags = Array.from(map.entries()).sort((a,b)=>b[1]-a[1]).map(([k,v])=> v>1 ? `${k} ×${v}`: k);
    return tags.slice(0,4);
  }

  function renderSelected(){
    const selItems = el('selItems');
    const selMeta = el('selMeta');
    const rightTitle = el('rightTitle');
    const fplBox = el('fplBox');
    const lidoBox = el('lidoBox');
    const opsBox = el('opsBox');
    const glossaryBox = el('glossaryBox');

    selItems.innerHTML=''; fplBox.textContent=''; lidoBox.textContent=''; opsBox.textContent=''; glossaryBox.innerHTML='';
    if(!state.selectedTail){
      rightTitle.textContent='Teendők (dispatch)';
      selMeta.textContent='Válassz egy lajstromot bal oldalt.';
      return;
    }
    const t = state.tails.get(state.selectedTail);
    rightTitle.textContent = `Teendők – ${state.selectedTail}`;
    selMeta.textContent = `Aktív dispatch-releváns tételek: ${t.entries.length}`;

    // list entries
    for(const e of t.entries){
      const d=document.createElement('div');
      d.className='item';
      const tag = e.action.tag==='ILS' && e.cat ? `ILS ${e.cat}` : e.action.tag;
      d.innerHTML = `
        <div class="row">
          <div style="font-weight:900">${escapeHtml(e.action.title)}</div>
          <div class="pill">${escapeHtml(tag)}</div>
        </div>
        <div class="meta">${escapeHtml(e.wo ? `W/O ${e.wo} • `:'' )}${escapeHtml(e.desc).slice(0,140)}</div>
      `;
      selItems.appendChild(d);
    }

    // aggregate actions
    const agg = aggregateActions(t.entries.map(e=>e.action));
    fplBox.innerHTML = renderFplAgg(agg.fpl);
    lidoBox.innerHTML = renderLidoLines(agg.lidoLines);
    opsBox.textContent = agg.ops.join('\n') || '—';
    glossaryBox.innerHTML = renderGlossary(agg.fpl);
  }

  function aggregateActions(actions){
    // parse lido lines and fpl changes
    const fpl = {item10a:{add:new Set(), rem:new Set()}, item10b:{add:new Set(), rem:new Set()}, item18:{add:new Set(), rem:new Set()}};
    const lidoLines=[];
    const ops=[];
    for(const a of actions){
      if(a.other && a.other.trim() && !ops.includes(a.other.trim())) ops.push(a.other.trim());
      if(a.lido && a.lido.trim()){
        const lines = a.lido.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
        for(const ln of lines){
          const parsed = parseLidoClause(ln);
          if(parsed){
            lidoLines.push(parsed);
            applyToFpl(fpl, parsed);
          } else {
            // keep as note
            lidoLines.push({kind:'NOTE', text:ln});
          }
        }
      }
    }
    // dedupe lidoLines by kind+item+codes
    const seen=new Set(); const uniq=[];
    for(const l of lidoLines){
      const key = `${l.kind}|${l.item||''}|${(l.codes||[]).join(',')}|${l.text||''}`;
      if(seen.has(key)) continue;
      seen.add(key); uniq.push(l);
    }
    return {fpl, lidoLines: uniq, ops};
  }

  function parseLidoClause(line){
    const up = line.toUpperCase();
    // examples:
    // Remove: from item 10a:X
    // Insert item 18 DAT/CPDLCX
    const m = up.match(/^(REMOVE|INSERT|ADD|OVERWRITE)\s*:\s*(.*)$/);
    if(!m) return null;
    const kind = m[1];
    const rest = m[2];
    // item 10a / item10a / item 18
    const im = rest.match(/ITEM\s*([0-9]{2})([AB])?/);
    let item = null;
    if(im){
      item = `ITEM${im[1]}${im[2]||''}`.toUpperCase();
    } else if(rest.includes('ITEM10A')) item='ITEM10A';
    else if(rest.includes('ITEM10B')) item='ITEM10B';
    else if(rest.includes('ITEM18')) item='ITEM18';

    // codes after -> or colon
    let codesPart = rest;
    codesPart = codesPart.replace(/FROM\s+/,'').replace(/ITEM\s*[0-9]{2}[AB]?\s*/,'').replace(/ITEM10A|ITEM10B|ITEM18/,'');
    codesPart = codesPart.replace(/→/g,' ').replace(/:/g,' ');
    const codes = (codesPart.match(/[A-Z0-9\/]+(?:\:[A-Z0-9,]+)?/g)||[])
      .map(s=>s.replace(/,$/,'').trim())
      .filter(s=>s && !['FROM','ITEM','REMOVE','INSERT','ADD','OVERWRITE'].includes(s));
    return {kind, item, codes, text: line};
  }

  function applyToFpl(fpl, clause){
    const kind = clause.kind;
    const item = clause.item;
    if(!item || !clause.codes?.length) return;
    const target = item==='ITEM10A'? fpl.item10a : item==='ITEM10B'? fpl.item10b : item==='ITEM18'? fpl.item18 : null;
    if(!target) return;
    if(kind==='REMOVE'){
      clause.codes.forEach(c=>target.rem.add(cleanCode(c)));
    } else if(kind==='INSERT' || kind==='ADD' || kind==='OVERWRITE'){
      clause.codes.forEach(c=>target.add.add(cleanCode(c)));
    }
  }

  function cleanCode(c){
    // remove junk tokens
    return c.replace(/^PBN\:?$/,'PBN').replace(/^\s+|\s+$/g,'');
  }

  function renderFplAgg(fpl){
    function row(label, addSet, remSet){
      const add=[...addSet].filter(Boolean).join(', ') || '—';
      const rem=[...remSet].filter(Boolean).join(', ') || '—';
      return `<div class="kv"><div class="k">${label}</div><div><span class="hlAdd">ADD</span> ${escapeHtml(add)}</div><div><span class="hlRem">REMOVE</span> ${escapeHtml(rem)}</div></div>`;
    }
    return row('ITEM10A', fpl.item10a.add, fpl.item10a.rem) +
           row('ITEM10B', fpl.item10b.add, fpl.item10b.rem) +
           row('ITEM18',  fpl.item18.add,  fpl.item18.rem);
  }

  function renderLidoLines(lines){
    if(!lines.length) return '—';
    const out=[];
    let n=1;
    for(const l of lines){
      if(l.kind==='NOTE'){
        out.push(`<div>${escapeHtml(l.text)}</div>`);
        continue;
      }
      const codes = (l.codes||[]).join(', ');
      const kindClass = l.kind==='REMOVE' ? 'hlRem' : 'hlAdd';
      out.push(`<div><span class="${kindClass}">${escapeHtml(l.kind)}</span>: ${escapeHtml(l.item||'')} → ${escapeHtml(codes)}</div>`);
    }
    return out.join('');
  }

  function renderGlossary(fpl){
    const codes = new Set();
    for(const c of [...fpl.item10a.add, ...fpl.item10a.rem, ...fpl.item10b.add, ...fpl.item10b.rem, ...fpl.item18.add, ...fpl.item18.rem]){
      if(!c || c==='—') continue;
      const base = c.split(':')[0];
      codes.add(base);
      if(c.includes(':')) codes.add(c); // keep full too
    }
    // also pull PBN subcodes if present in item18 add/rem
    const pbnCodes=[];
    for(const c of [...fpl.item18.add, ...fpl.item18.rem]){
      if(typeof c==='string' && c.startsWith('PBN:')){
        c.replace('PBN:','').split(',').forEach(x=>pbnCodes.push(x.trim()));
      }
    }
    pbnCodes.forEach(x=>codes.add(x));

    const items=[];
    for(const code of Array.from(codes)){
      const entry = state.glossary[code] || state.glossary[code.split(':')[0]];
      if(!entry) continue;
      items.push(`<div class="g"><div class="code">${escapeHtml(code)}</div><div class="meta">${escapeHtml(entry.desc||'')}</div><div class="meta">${escapeHtml(entry.ref||'')}</div></div>`);
    }
    return items.length ? items.join('') : `<div class="meta">Nincs releváns kód a fenti FPL változásokból.</div>`;
  }

  function buildCopyTextForSelected(){
    if(!state.selectedTail) return '';
    const t=state.tails.get(state.selectedTail);
    const agg=aggregateActions(t.entries.map(e=>e.action));
    const fpl = agg.fpl;
    const lines=[];
    lines.push(`A/C ${state.selectedTail} – Dispatch teendők`);
    lines.push(`ITEM10A add: ${[...fpl.item10a.add].join(', ')||'-'} | remove: ${[...fpl.item10a.rem].join(', ')||'-'}`);
    lines.push(`ITEM10B add: ${[...fpl.item10b.add].join(', ')||'-'} | remove: ${[...fpl.item10b.rem].join(', ')||'-'}`);
    lines.push(`ITEM18  add: ${[...fpl.item18.add].join(', ')||'-'} | remove: ${[...fpl.item18.rem].join(', ')||'-'}`);
    lines.push('LIDO:');
    for(const l of agg.lidoLines){
      if(l.kind==='NOTE') continue;
      lines.push(`- ${l.kind} ${l.item||''}: ${(l.codes||[]).join(', ')}`);
    }
    if(agg.ops.length){
      lines.push('OPS notes:');
      agg.ops.forEach(o=>lines.push(`- ${o}`));
    }
    return lines.join('\n');
  }

  function buildHandoverExport(){
    const tails = Array.from(state.tails.values()).sort((a,b)=>b.entries.length-a.entries.length);
    const lines=[];
    lines.push(`DISPATCH MEL HANDOVER – impacted tails: ${tails.length}`);
    for(const t of tails){
      const tags=buildTagsForTail(t).join(' / ');
      lines.push(`${t.tail}: ${t.entries.length} MEL • ${tags}`);
    }
    return lines.join('\n');
  }

  function escapeHtml(s){
    return (s||'').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }

  window.addEventListener('DOMContentLoaded', init);
})();
