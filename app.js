
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  rules: [],
  csvRows: [],
  tails: new Map(),      // tail -> { items: [...], relevantItems: [...], tags: Set, score: number }
  selectedTail: null,
  pdfFile: null,
  lastSnapshotKey: 'mel_dispatch_last_snapshot_v1'
};

// -------- CSV parsing (handles quotes) --------
function parseCSV(text){
  const rows = [];
  let row = [];
  let cur = '';
  let i = 0;
  let inQuotes = false;
  while (i < text.length){
    const c = text[i];
    if (inQuotes){
      if (c === '"'){
        if (text[i+1] === '"'){ cur += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cur += c; i++; continue;
    } else {
      if (c === '"'){ inQuotes = true; i++; continue; }
      if (c === ','){ row.push(cur); cur=''; i++; continue; }
      if (c === '\r'){ i++; continue; }
      if (c === '\n'){ row.push(cur); rows.push(row); row=[]; cur=''; i++; continue; }
      cur += c; i++; continue;
    }
  }
  // last
  row.push(cur);
  if (row.length > 1 || row[0].trim() !== '') rows.push(row);

  if (!rows.length) return {headers:[], records:[]};
  const headers = rows[0].map(h=>h.trim());
  const records = rows.slice(1).filter(r=>r.some(x=>String(x||'').trim()!=='')).map(r=>{
    const obj = {};
    headers.forEach((h,idx)=>obj[h]= (r[idx] ?? '').trim());
    return obj;
  });
  return {headers, records};
}

function norm(s){
  return String(s||'').toUpperCase().replace(/\s+/g,' ').trim();
}

function extractMelCodes(text){
  const t = String(text||'');
  const codes = new Set();
  const re1 = /\b(\d{2}-\d{2}-\d{2}(?:\/\d{2})?)\b/g;
  let m;
  while ((m=re1.exec(t))!==null){ codes.add(m[1]); }
  // Some CSVs have MEL xx-xx-xxA like 31-30-07A
  const re2 = /\b(\d{2}-\d{2}-\d{2}[A-Z])\b/g;
  while ((m=re2.exec(t))!==null){ codes.add(m[1]); }
  return [...codes];
}

function matchRule(haystack, codes){
  const h = norm(haystack);
  for (const r of state.rules){
    // code match
    if (r.codes && r.codes.length){
      for (const c of r.codes){
        if (codes.includes(c) || h.includes(c)) return r;
      }
    }
    // keyword match (strict)
    for (const kw of (r.match_keywords||[])){
      const k = norm(kw);
      if (k.length < 3) continue;
      if (h.includes(k)) return r;
    }
  }
  return null;
}

// Strict fallback keywords (dispatch-impact only)
const FALLBACK = [
  {tag:'TCAS', re:/\bTCAS\b/i},
  {tag:'CPDLC', re:/\bCPDLC\b|\bDATALINK\b|\bDAT\/CPDLC/i},
  {tag:'ADS-B', re:/\bADS[\s-]?B\b|\bADSB\b|\bSUR\/EUADSBX\b/i},
  {tag:'RVSM', re:/\bRVSM\b/i},
  {tag:'RNP', re:/\bRNP\b|\bPBN:\s*S2\b|\bAPPCH\b/i},
  {tag:'WXR', re:/WX\s*RADAR|\bWXR\b|\bWEATHER RADAR\b/i},
  {tag:'NO ICING', re:/NO\s+ICING|\bICING\b/i},
  {tag:'ILS CAT', re:/\bCAT\s*II\b|\bCAT\s*III\b|\bAUTOLAND\b|\bLANDING CAPABILITY\b/i},
  {tag:'NAV DB', re:/NAV\s*DB|DATABASE\s*(OUT|EXPIR)/i},
  {tag:'EGPWS', re:/\bEGPWS\b|\bGPWS\b/i},
  {tag:'MCDU', re:/\bMCDU\b/i},
  {tag:'CENTER TANK', re:/CENTER\s+TANK|TRANSFER\s+VALVE/i},
  {tag:'MAX FL', re:/MAX\s*FL\b|FL\s*\d{2,3}\b/i},
];

const EXCLUDE = [
  /\bLAV(ATORY)?\b/i, /\bTOILET\b/i, /\bGALLEY\b/i, /\bSEAT\b/i, /\bIFE\b/i,
  /\bCARPET\b/i, /\bODOR\b/i, /\bDIRTY SOCKS\b/i, /\bCATERING\b/i, /\bCOFFEE\b/i,
];

function isExcluded(text){
  const t = String(text||'');
  return EXCLUDE.some(rx=>rx.test(t));
}

function deriveTagsFromText(text){
  const tags = new Set();
  for (const f of FALLBACK){
    if (f.re.test(text)) tags.add(f.tag);
  }
  return tags;
}

// ---------- FPL parsing ----------
function parseFplFromLido(lidoText){
  const t = String(lidoText||'').replace(/\s+/g,' ').trim();
  const res = { item10a:{add:new Set(), remove:new Set()}, item10b:{add:new Set(), remove:new Set()}, item18:{add:new Set(), remove:new Set()} };
  if (!t) return res;

  // Split into clauses starting with Remove/Insert/Add/Overwrite
  const clauses = t.split(/\b(?=Remove:|Insert:|Insert\b|Add:|Overwrite:|Overwrit[e|o]:|Please\b)/i).map(s=>s.trim()).filter(Boolean);
  for (const c of clauses){
    const lc = c.toLowerCase();
    const isRemove = lc.startsWith('remove:') || lc.startsWith('remove ');
    const isInsert = lc.startsWith('insert') || lc.startsWith('add:') || lc.startsWith('insert:');
    // identify item
    let item = null;
    if (/item\s*10a/i.test(c) || /10a:/i.test(c)) item = 'item10a';
    else if (/item\s*10b/i.test(c) || /10b:/i.test(c)) item = 'item10b';
    else if (/item\s*18/i.test(c)) item = 'item18';

    // Extract tokens like X, J1, J4 from "10a:J1,J4" or "item 18 TCAS" or "PBN:S2"
    const tokens = [];
    // pbn tokens
    const pbn = c.match(/PBN:\s*([A-Z0-9,]+)/i);
    if (pbn){ pbn[1].split(',').forEach(x=>tokens.push('PBN:'+x.trim().toUpperCase())); }
    const sur = c.match(/SUR\/([A-Z0-9]+)/i);
    if (sur){ tokens.push('SUR/'+sur[1].toUpperCase()); }
    const dat = c.match(/DAT\/([A-Z0-9]+)/i);
    if (dat){ tokens.push('DAT/'+dat[1].toUpperCase()); }
    // codes like "10a:X" or "10b:L and B1"
    const codeList = c.match(/10[AB]:\s*([A-Z0-9, ]+)/i);
    if (codeList){
      codeList[1].replace(/and/ig,',').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean).forEach(x=>tokens.push(x));
      if (!item) item = /10a:/i.test(c) ? 'item10a' : 'item10b';
    }
    // plain tokens (TCAS etc) for item 18 remove
    if (/item\s*18/i.test(c)){
      const after = c.split(/item\s*18/i)[1] || '';
      after.replace(/[:]/g,' ').split(/\s+/).map(x=>x.trim().toUpperCase()).filter(x=>x && x.length<=12).forEach(x=>{
        if (['REMOVE','INSERT','FROM','ITEM'].includes(x)) return;
        if (/^\d+$/.test(x)) return;
        if (x==='10A' || x==='10B' || x==='18') return;
        if (x==='PBN' || x==='SUR' || x==='DAT') return;
        // keep alnum tokens like TCAS
        if (/^[A-Z0-9\/]+$/.test(x)) tokens.push(x);
      });
      if (!item) item = 'item18';
    }

    if (!item || !tokens.length) continue;
    const bucket = isRemove ? res[item].remove : (isInsert ? res[item].add : null);
    if (!bucket) continue;
    tokens.forEach(x=>bucket.add(x));
  }
  // Remove precedence: if token in both, keep remove only
  for (const it of ['item10a','item10b','item18']){
    for (const x of [...res[it].add]){
      if (res[it].remove.has(x)) res[it].add.delete(x);
    }
  }
  return res;
}

function formatFpl(fpl){
  const fmt = (set) => set.size ? [...set].sort().join(', ') : '—';
  return [
    'ITEM10A:',
    `  • ADD: ${fmt(fpl.item10a.add)}`,
    `  • REMOVE: ${fmt(fpl.item10a.remove)}`,
    'ITEM10B:',
    `  • ADD: ${fmt(fpl.item10b.add)}`,
    `  • REMOVE: ${fmt(fpl.item10b.remove)}`,
    'ITEM18:',
    `  • ADD: ${fmt(fpl.item18.add)}`,
    `  • REMOVE: ${fmt(fpl.item18.remove)}`
  ].join('\n');
}

// -------- UI --------
function setFleetMeta(msg){ $('fleetMeta').textContent = msg; }
function setSelMeta(msg){ $('selMeta').textContent = msg; }

function openModal(){
  $('pasteModal').setAttribute('aria-hidden','false');
  $('csvPaste').focus();
}
function closeModal(){
  $('pasteModal').setAttribute('aria-hidden','true');
}

function clearAll(){
  state.csvRows = [];
  state.tails = new Map();
  state.selectedTail = null;
  $('tailList').innerHTML = '<div class="empty">Nincs adat.</div>';
  $('selItems').innerHTML = '<div class="empty">Nincs kiválasztott lajstrom.</div>';
  $('todoTitle').textContent = 'Teendők (dispatch)';
  $('fplBox').textContent = '—';
  $('lidoBox').innerHTML = '';
  $('opsBox').textContent = '—';
  setFleetMeta('Tölts fel egy AMOS WO Summary CSV‑t.');
  setSelMeta('Válassz egy lajstromot bal oldalt.');
  $('handoverBtn').disabled = true;
  $('clearBtn').disabled = true;
  $('copyBtn').disabled = true;
  $('deltaPill').textContent = 'Δ: —';
}

function buildSnapshot(records){
  // create deterministic string: tail|wo|ata|desc|due
  const parts = records.map(r=>{
    const tail = r['A/C'] || r['A/C ' ] || '';
    const wo = r['W/O'] || '';
    const ata = r['ATA'] || '';
    const desc = r['Workorder-description and/or complaint'] || r['Workorder-description'] || '';
    const due = r['Due-/C.-Date'] || '';
    return `${tail}|${wo}|${ata}|${desc}|${due}`;
  }).sort();
  const blob = parts.join('\n');
  return sha1(blob);
}

function sha1(str){
  // lightweight SHA-1 via SubtleCrypto if available
  // fallback: simple hash (not cryptographic) if needed
  if (crypto?.subtle?.digest){
    const enc = new TextEncoder().encode(str);
    return crypto.subtle.digest('SHA-1', enc).then(buf=>{
      const arr = Array.from(new Uint8Array(buf));
      return arr.map(b=>b.toString(16).padStart(2,'0')).join('');
    });
  }
  let h=0;
  for (let i=0;i<str.length;i++){ h = (h*31 + str.charCodeAt(i))|0; }
  return Promise.resolve(String(h));
}

function computeDelta(newKey){
  const oldKey = localStorage.getItem(state.lastSnapshotKey);
  localStorage.setItem(state.lastSnapshotKey, newKey);
  if (!oldKey) return {label:'NEW', detail:'Első import'};
  if (oldKey === newKey) return {label:'0', detail:'Nincs változás'};
  return {label:'!', detail:'Változás van (NEW/REMOVED/CHANGED részletezés a következő iterációban)'}; // keep minimal
}

function renderTailList(){
  const tails = [...state.tails.values()].sort((a,b)=>b.score-a.score || a.tail.localeCompare(b.tail));
  if (!tails.length){
    $('tailList').innerHTML = '<div class="empty">Nincs dispatch-releváns tétel a CSV-ben.</div>';
    return;
  }
  $('tailList').innerHTML = '';
  for (const t of tails){
    const div = document.createElement('div');
    div.className = 'item' + (state.selectedTail === t.tail ? ' active' : '');
    div.dataset.tail = t.tail;

    const scoreBadge = document.createElement('span');
    scoreBadge.className = 'badge ' + (t.score>=4 ? 'crit' : (t.score>=2 ? 'hot' : ''));
    scoreBadge.textContent = `${t.relevantItems.length} MEL`;

    const title = document.createElement('div');
    title.className = 'item-title';
    title.innerHTML = `<span>${escapeHtml(t.tail)}</span>`;
    title.appendChild(scoreBadge);

    const sub = document.createElement('div');
    sub.className = 'item-sub';
    sub.textContent = `Dispatch releváns tételek: ${t.relevantItems.length}`;

    const tags = document.createElement('div');
    tags.className = 'tags';
    [...t.tags].slice(0,7).forEach(tag=>{
      const s = document.createElement('span');
      s.className = 'tag';
      s.textContent = tag;
      tags.appendChild(s);
    });
    if (!t.tags.size){
      const s = document.createElement('span');
      s.className = 'tag muted';
      s.textContent = 'match: actions.json';
      tags.appendChild(s);
    }

    const main = document.createElement('div');
    main.className = 'item-main';
    main.appendChild(title);
    main.appendChild(sub);
    main.appendChild(tags);

    div.appendChild(main);
    div.addEventListener('click', ()=>selectTail(t.tail));
    $('tailList').appendChild(div);
  }
}

function renderSelectedItems(t){
  if (!t){
    $('selItems').innerHTML = '<div class="empty">Nincs kiválasztott lajstrom.</div>';
    setSelMeta('Válassz egy lajstromot bal oldalt.');
    return;
  }
  setSelMeta(`Aktív dispatch-releváns tételek: ${t.relevantItems.length}`);
  if (!t.relevantItems.length){
    $('selItems').innerHTML = '<div class="empty">Nincs releváns tétel.</div>';
    return;
  }
  $('selItems').innerHTML = '';
  for (const it of t.relevantItems){
    const div = document.createElement('div');
    div.className = 'item';
    const title = document.createElement('div');
    title.className = 'item-title';
    title.innerHTML = `<span>${escapeHtml(it.title)}</span> <span class="badge">${escapeHtml(it.reason)}</span>`;
    const sub = document.createElement('div');
    sub.className = 'item-sub';
    sub.textContent = it.sourceSummary;
    const main = document.createElement('div');
    main.className = 'item-main';
    main.appendChild(title);
    main.appendChild(sub);
    div.appendChild(main);
    $('selItems').appendChild(div);
  }
}

function renderTodos(t){
  $('copyBtn').disabled = !t;
  if (!t){
    $('todoTitle').textContent = 'Teendők (dispatch)';
    $('fplBox').textContent = '—';
    $('lidoBox').innerHTML = '';
    $('opsBox').textContent = '—';
    return;
  }
  $('todoTitle').textContent = `Teendők – ${t.tail}`;

  // Aggregate rules
  const fplAgg = { item10a:{add:new Set(), remove:new Set()}, item10b:{add:new Set(), remove:new Set()}, item18:{add:new Set(), remove:new Set()} };
  const lidoSteps = [];
  const opsNotes = [];
  const seenStep = new Set();
  const seenOps = new Set();

  for (const it of t.relevantItems){
    if (!it.rule) continue;
    const fpl = parseFplFromLido(it.rule.lido);
    // merge
    for (const k of ['item10a','item10b','item18']){
      for (const x of fpl[k].add) fplAgg[k].add.add(x);
      for (const x of fpl[k].remove) fplAgg[k].remove.add(x);
    }
    if (it.rule.lido){
      const step = it.rule.lido.replace(/\s+/g,' ').trim();
      if (step && !seenStep.has(step)){ seenStep.add(step); lidoSteps.push(step); }
    }
    if (it.rule.other){
      const op = it.rule.other.trim();
      if (op && !seenOps.has(op)){ seenOps.add(op); opsNotes.push(op); }
    }
  }
  // precedence remove > add
  for (const k of ['item10a','item10b','item18']){
    for (const x of [...fplAgg[k].add]){
      if (fplAgg[k].remove.has(x)) fplAgg[k].add.delete(x);
    }
  }

  $('fplBox').textContent = formatFpl(fplAgg);
  $('lidoBox').innerHTML = lidoSteps.length ? lidoSteps.map((s,i)=>`<div class="li"><b>${i+1}.</b> ${escapeHtml(s)}</div>`).join('') : '<div class="empty">—</div>';
  $('opsBox').textContent = opsNotes.length ? opsNotes.join('\n\n') : '—';
}

function escapeHtml(s){
  return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function selectTail(tail){
  // hard reset selection
  state.selectedTail = tail;
  // rerender list active state
  renderTailList();
  const t = state.tails.get(tail);
  renderSelectedItems(t);
  renderTodos(t);
  $('handoverBtn').disabled = false;
}

function buildTailsFromCsv(records){
  state.tails = new Map();

  for (const r of records){
    const tail = (r['A/C'] || '').trim();
    if (!tail) continue;
    const desc = r['Workorder-description and/or complaint'] || r['Workorder-description'] || '';
    const ata = r['ATA'] || '';
    const due = r['Due-/C.-Date'] || '';
    const wo = r['W/O'] || '';
    const hay = `${desc} ${ata} ${wo}`;

    if (isExcluded(hay)) continue;

    const codes = extractMelCodes(hay);
    const rule = matchRule(hay, codes);

    let relevant = false;
    let reason = '';
    let tags = new Set();

    if (rule){
      relevant = true;
      reason = `MATCH: ${rule.title}`;
      tags = deriveTagsFromText(rule.title + ' ' + rule.other + ' ' + rule.lido);
    } else {
      // strict fallback (must hit dispatch-impact keywords)
      const ftags = deriveTagsFromText(hay);
      if (ftags.size){
        relevant = true;
        reason = `KEYWORD: ${[...ftags][0]}`;
        tags = ftags;
      }
    }

    if (!relevant) continue;

    if (!state.tails.has(tail)){
      state.tails.set(tail, { tail, items: [], relevantItems: [], tags:new Set(), score:0 });
    }
    const entry = state.tails.get(tail);
    const title = rule ? rule.title : (tags.size ? [...tags][0] + ' (fallback)' : 'Dispatch relevant');
    const src = `W/O ${wo} • ATA ${ata || '—'} • Due ${due || '—'}`;

    const item = { tail, title, rule, reason, sourceSummary: src };
    entry.relevantItems.push(item);
    tags.forEach(x=>entry.tags.add(x));
    entry.score = Math.max(entry.score, Math.min(5, entry.relevantItems.length + entry.tags.size/3));
  }

  // remove empty
  for (const [k,v] of [...state.tails.entries()]){
    if (!v.relevantItems.length) state.tails.delete(k);
  }
}

async function importCsvText(text){
  const {records} = parseCSV(text);
  state.csvRows = records;

  if (!records.length){
    setFleetMeta('A CSV üres vagy nem értelmezhető.');
    clearAll();
    return;
  }

  buildTailsFromCsv(records);
  renderTailList();
  state.selectedTail = null;
  renderSelectedItems(null);
  renderTodos(null);

  $('handoverBtn').disabled = state.tails.size === 0;
  $('clearBtn').disabled = false;

  setFleetMeta(`Importált sorok: ${records.length} • Dispatch‑releváns lajstromok: ${state.tails.size}`);

  const snap = await buildSnapshot(records);
  const delta = computeDelta(snap);
  $('deltaPill').textContent = `Δ: ${delta.label}`;
  $('deltaPill').title = delta.detail;
}

function handoverExport(){
  const tails = [...state.tails.values()].sort((a,b)=>b.score-a.score || a.tail.localeCompare(b.tail));
  const lines = [];
  lines.push(`DISPATCH MEL SUMMARY (${new Date().toLocaleString()})`);
  lines.push(`Impacted A/C: ${tails.length}`);
  lines.push('');
  for (const t of tails){
    const topTags = [...t.tags].slice(0,6).join(', ') || '—';
    lines.push(`${t.tail} • ${t.relevantItems.length} item(s) • tags: ${topTags}`);
    // top 2 rules
    const top = t.relevantItems.slice(0,2).map(x=>x.rule?x.rule.title:x.title).join(' | ');
    if (top) lines.push(`  - ${top}`);
  }
  return lines.join('\n');
}

async function copyText(txt){
  try{
    await navigator.clipboard.writeText(txt);
    return true;
  }catch{
    // fallback
    const ta=document.createElement('textarea');
    ta.value=txt; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  }
}

async function init(){
  // load rules
  try{
    const r = await fetch('data/actions.json', {cache:'no-store'});
    const j = await r.json();
    state.rules = j.rules || [];
  }catch(e){
    console.error('actions.json load failed', e);
    state.rules = [];
  }

  // bind
  $('pasteCsvBtn').addEventListener('click', openModal);
  $('closePaste').addEventListener('click', closeModal);
  $('cancelPaste').addEventListener('click', closeModal);
  $('importPaste').addEventListener('click', async ()=>{
    const txt = $('csvPaste').value;
    closeModal();
    await importCsvText(txt);
  });

  $('csvFile').addEventListener('change', async (ev)=>{
    const f = ev.target.files?.[0];
    if (!f) return;
    const txt = await f.text();
    await importCsvText(txt);
    ev.target.value = '';
  });

  $('pdfFile').addEventListener('change', async (ev)=>{
    const f = ev.target.files?.[0];
    if (!f) return;
    state.pdfFile = f;
    // We don't parse PDF here (no pdf.js). This is just to keep workflow consistent & allow user to open it.
    // We'll just update meta.
    const mb = (f.size/1024/1024).toFixed(1);
    const old = $('fleetMeta').textContent;
    $('fleetMeta').textContent = old + ` • MEL PDF: ${f.name} (${mb} MB)`;
    ev.target.value='';
  });

  $('handoverBtn').addEventListener('click', async ()=>{
    const txt = handoverExport();
    await copyText(txt);
  });

  $('clearBtn').addEventListener('click', ()=>{
    clearAll();
  });

  $('copyBtn').addEventListener('click', async ()=>{
    if (!state.selectedTail) return;
    const t = state.tails.get(state.selectedTail);
    const txt = [
      `A/C: ${t.tail}`,
      '',
      $('fplBox').textContent,
      '',
      'LIDO / DISPATCH STEPS:',
      ...t.relevantItems.filter(x=>x.rule?.lido).map(x=>`- ${x.rule.lido.replace(/\s+/g,' ').trim()}`),
      '',
      'OPS NOTES:',
      ...t.relevantItems.filter(x=>x.rule?.other).map(x=>`- ${x.rule.other.replace(/\s+/g,' ').trim()}`)
    ].join('\n');
    await copyText(txt);
  });

  clearAll();
}

init();
