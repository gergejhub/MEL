
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


function findRuleByTag(tag){
  const t = norm(tag);
  let best = null;
  for (const r of state.rules){
    const title = norm(r.title||'');
    if (!title) continue;
    if (title === t || title.includes(t)){ best = r; break; }
  }
  if (best) return best;
  for (const r of state.rules){
    for (const kw of (r.match_keywords||[])){
      if (norm(kw) === t) return r;
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
  {tag:'ADF', re:/\bADF\b/i},
  {tag:'VOR', re:/\bVOR\b/i},
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
function cleanToken(x){
  return String(x||'').trim().toUpperCase().replace(/[;]+$/,'').replace(/[,]+$/,'').replace(/\.$/,'');
}

function parseInstructionsFromLido(lidoText){
  const t = String(lidoText||'').replace(/\s+/g,' ').trim();
  if (!t) return [];
  const clauses = t.split(/\b(?=Remove:|Insert:|Insert\b|Add:|Overwrite:|Overwrit[e|o]:|Please\b)/i)
    .map(s=>s.trim()).filter(Boolean);

  const out = [];
  let lastItem = null;

  for (const c0 of clauses){
    const c = String(c0||'').trim();
    const lc = c.toLowerCase();
    const isRemove = lc.startsWith('remove:') || lc.startsWith('remove ');
    const isInsert = lc.startsWith('insert') || lc.startsWith('add:') || lc.startsWith('insert:');
    const isOverwrite = lc.startsWith('overwrite') || lc.startsWith('please overwrite') || lc.startsWith('overwrit');

    let verb = 'NOTE';
    if (isRemove) verb = 'REMOVE';
    else if (isInsert) verb = 'ADD';
    else if (isOverwrite) verb = 'OVERWRITE';

    let item = null;
    if (/item\s*10a/i.test(c) || /10a:/i.test(c)) item = 'item10a';
    else if (/item\s*10b/i.test(c) || /10b:/i.test(c)) item = 'item10b';
    else if (/item\s*18/i.test(c)) item = 'item18';

    const tokens = [];
    const pbnCodes = new Set();
    const pbn = c.match(/PBN:\s*([A-Z0-9,]+)/i);
    if (pbn){
      pbn[1].split(',').map(x=>cleanToken(x)).filter(Boolean).forEach(x=>{ pbnCodes.add(x); tokens.push('PBN:'+x); });
    }
    const sur = c.match(/SUR\/([A-Z0-9]+)/i);
    if (sur){ tokens.push('SUR/'+cleanToken(sur[1])); }
    const dat = c.match(/DAT\/([A-Z0-9]+)/i);
    if (dat){ tokens.push('DAT/'+cleanToken(dat[1])); }
    const codeList = c.match(/10[AB]:\s*([A-Z0-9, ]+)/i);
    if (codeList){
      codeList[1].replace(/and/ig,',').split(',')
        .map(x=>cleanToken(x)).filter(Boolean)
        .forEach(x=>tokens.push(x));
      if (!item) item = /10a:/i.test(c) ? 'item10a' : 'item10b';
    }
    if (/item\s*18/i.test(c) || /\bitem18\b/i.test(c)){
      const after = c.split(/item\s*18/i)[1] || '';
      after.replace(/[:]/g,' ').split(/\s+/)
        .map(x=>cleanToken(x))
        .filter(x=>x && x.length<=12)
        .forEach(x=>{
          if (['REMOVE','INSERT','FROM','ITEM','ADD','OVERWRITE','PLEASE'].includes(x)) return;
          if (/^\d+$/.test(x)) return;
          if (x==='10A' || x==='10B' || x==='18') return;
          if (x==='PBN' || x==='SUR' || x==='DAT') return;
          // avoid duplicating PBN codes already captured as PBN:XX
          if (/^[A-Z]\d$/.test(x) && pbnCodes.has(x)) return;
          if (/^[A-Z0-9\/]+$/.test(x)) tokens.push(x);
        });
      if (!item) item = 'item18';
    }

    // Generic capability codes list (e.g. "insert: B3, B4, C4") even if no item text present
    if (!tokens.length && (isInsert || isRemove)){
      const cap = [...c.matchAll(/\b([A-Z]\d)\b/g)].map(m=>cleanToken(m[1]));
      // Only accept if looks like a list (>=2) to avoid false positives
      const uniq = [...new Set(cap)].filter(Boolean);
      if (uniq.length >= 2) uniq.forEach(x=>tokens.push(x));
    }

    if (!item && lastItem && tokens.length){
      const looksLikeCaps = tokens.every(x=>/^(PBN:)?[A-Z]\d$/.test(x) || /^PBN:/.test(x));
      if (looksLikeCaps) item = lastItem;
    }
    if (item) lastItem = item;

    out.push({verb, item, tokens: tokens.map(cleanToken).filter(Boolean), raw: c});
  }
  return out;
}

function parseFplFromLido(lidoText){
  const res = { item10a:{add:new Set(), remove:new Set()}, item10b:{add:new Set(), remove:new Set()}, item18:{add:new Set(), remove:new Set()} };
  const instr = parseInstructionsFromLido(lidoText);
  for (const i of instr){
    if (!i.item || !i.tokens.length) continue;
    const bucket = i.verb==='REMOVE' ? res[i.item].remove : (i.verb==='ADD' ? res[i.item].add : null);
    if (!bucket) continue;
    i.tokens.forEach(x=>{
      const tok = cleanToken(x);
      if (!tok) return;
      if (tok==='PBN:' || tok==='PBN') return;
      bucket.add(tok);
    });
  }
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
  $('fplBox').innerHTML = '<span class="muted">—</span>';
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
    const distinct = t.ruleMap ? t.ruleMap.size : t.relevantItems.length;

    const div = document.createElement('div');
    div.className = 'item' + (state.selectedTail === t.tail ? ' active' : '');
    div.dataset.tail = t.tail;

    const scoreBadge = document.createElement('span');
    scoreBadge.className = 'badge ' + (t.score>=4 ? 'crit' : (t.score>=2 ? 'hot' : ''));
    scoreBadge.textContent = `${distinct} MEL`;

    const title = document.createElement('div');
    title.className = 'item-title';
    title.innerHTML = `<span>${escapeHtml(t.tail)}</span>`;
    title.appendChild(scoreBadge);

    const sub = document.createElement('div');
    sub.className = 'item-sub';
    sub.textContent = `Dispatch releváns tételek: ${distinct}`;

    const tags = document.createElement('div');
    tags.className = 'tags';

    const tc = t.tagCounts || new Map();
    const tagList = [...tc.entries()].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]));
    tagList.slice(0,7).forEach(([tag,count])=>{
      const s = document.createElement('span');
      s.className = 'tag';
      s.textContent = count>1 ? `${tag} ×${count}` : tag;
      tags.appendChild(s);
    });

    if (!tagList.length){
      const s = document.createElement('span');
      s.className = 'tag muted';
      const why = (t.relevantItems[0] && t.relevantItems[0].reason) ? t.relevantItems[0].reason : 'MATCH';
      s.textContent = why.replace(/^MATCH:\s*/,'match: ');
      tags.appendChild(s);
    } else if (tagList.length > 7){
      const s = document.createElement('span');
      s.className = 'tag muted';
      s.textContent = `+${tagList.length-7}`;
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
    $('fplBox').innerHTML = '<span class="muted">—</span>';
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
      const step = formatLidoForDisplay(it.rule.lido);
      if (step && !seenStep.has(step)){ seenStep.add(step); lidoSteps.push(step); }
    }
    if (it.rule.other){
      const op = it.rule.other.trim();
      if (op && !seenOps.has(op)){ seenOps.add(op); opsNotes.push(op); }
    }

    // Extra: ILS CAT detail (what exact CAT capability remains)
    if (/ILS\s+Category\s+limitation/i.test(it.rule.title||'')){
      const det = deriveIlsCatDetail(it.rule.title, it.rule.lido);
      if (det && !seenOps.has(det)) { seenOps.add(det); opsNotes.unshift(det); }
    }
  }
  // precedence remove > add
  for (const k of ['item10a','item10b','item18']){
    for (const x of [...fplAgg[k].add]){
      if (fplAgg[k].remove.has(x)) fplAgg[k].add.delete(x);
    }
  }

  $('fplBox').innerHTML = formatFplHtml(fplAgg);
  $('lidoBox').innerHTML = lidoSteps.length
    ? lidoSteps.map((s,i)=>`<div class="li"><div class="li-n">${i+1}.</div><pre class="li-t">${highlightInstr(s)}</pre></div>`).join('')
    : '<div class="empty">—</div>';
  $('opsBox').textContent = opsNotes.length ? opsNotes.join('\n\n') : '—';
}

function deriveIlsCatDetail(title, lido){
  const t = String(title||'');
  const l = String(lido||'');
  // Try to extract the "autoland cat 3A" style hint
  const m = t.match(/cat\s*3\s*([ab])/i);
  const aut = t.match(/autoland\s*cat\s*3\s*([ab])/i);
  const basic = t.match(/basic:\s*cat\s*3\s*([ab])/i);
  const basicCat = basic ? ('CAT III' + basic[1].toUpperCase()) : null;
  const autoCat = aut ? ('CAT III' + aut[1].toUpperCase()) : (m ? ('CAT III' + m[1].toUpperCase()) : null);

  // Extract RVR mapping if present
  const rvr = {};
  const map = [...l.matchAll(/CAT\s*(I{1,3}[AB]?)\s*:\s*(\d+)m/ig)];
  for (const mm of map){
    rvr[mm[1].toUpperCase()] = mm[2] + 'm';
  }

  const parts = [];
  if (basicCat || autoCat){
    parts.push(`ILS CAT – capability: ${basicCat ? basicCat : 'CAT III'}${autoCat ? ` (autoland limited to ${autoCat})` : ''}.`);
    if (basicCat && autoCat && basicCat !== autoCat){
      parts.push(`Expected impact: ${basicCat} not available as autoland; plan with ${autoCat} minima where applicable.`);
    }
  } else {
    parts.push('ILS CAT – landing capability degraded per MEL.');
  }
  if (Object.keys(rvr).length){
    // present in human terms
    const seq = ['I','II','IIIA','IIIB'].filter(k=>rvr[k]);
    const line = seq.map(k=>`CAT ${k.replace('I','I').replace('II','II').replace('IIIA','IIIA').replace('IIIB','IIIB')}: RVR ${rvr[k]}`).join(' | ');
    parts.push(`Reference RVR mapping (ICAO FPL item 18): ${line}.`);
  }
  parts.push('Action: update LIDO 4D Landing Capability per MEL; verify DEP/DES/ALT minima/briefing.');
  return parts.join(' ');
}


function formatLidoForDisplay(raw){
  const instr = parseInstructionsFromLido(raw);
  if (!instr.length) return '';

  const lines = [];
  for (const i of instr){
    if (i.verb === 'NOTE'){
      // keep short notes only
      const s = String(i.raw||'').trim();
      if (s) lines.push(s);
      continue;
    }
    if (i.verb === 'OVERWRITE'){
      // show as overwrite instruction (not an ICAO item change)
      lines.push(`OVERWRITE: ${String(i.raw||'').replace(/\s+/g,' ').trim()}`);
      continue;
    }
    if (i.item && i.tokens.length){
      const itemLabel = i.item.toUpperCase().replace('ITEM','ITEM ');
      lines.push(`${i.verb}: ${itemLabel} → ${i.tokens.join(', ')}`);
    } else {
      lines.push(String(i.raw||'').replace(/\s+/g,' ').trim());
    }
  }
  return lines.join('\n');
}


function highlightInstr(text){
  const esc = escapeHtml(text);
  return esc
    .replace(/^(Remove:[^\n]*)/gmi, '<span class="rm">$1</span>')
    .replace(/^(Insert:[^\n]*|Insert\b[^\n]*|Add:[^\n]*|Overwrite:[^\n]*)/gmi, '<span class="ins">$1</span>');
}

function formatFplHtml(fpl){
  const fmt = (set, cls) => {
    if (!set.size) return '<span class="muted">—</span>';
    const txt = [...set].sort().join(', ');
    return `<span class="${cls}">${escapeHtml(txt)}</span>`;
  };
  const row = (label, addSet, rmSet) =>
    `<div class="fpl-row"><div class="fpl-k">${label}</div>` +
    `<div class="fpl-v"><span class="k">ADD</span> ${fmt(addSet,'ins')} ` +
    `<span class="k">REMOVE</span> ${fmt(rmSet,'rm')}</div></div>`;
  return `<div class="fpl">` +
    row('ITEM10A', fpl.item10a.add, fpl.item10a.remove) +
    row('ITEM10B', fpl.item10b.add, fpl.item10b.remove) +
    row('ITEM18',  fpl.item18.add,  fpl.item18.remove) +
  `</div>`;
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
    let rule = matchRule(hay, codes);

    let relevant = false;
    let reason = '';
    let tags = new Set();

    if (rule){
      relevant = true;
      reason = `MATCH: ${rule.title}`;
      tags = deriveTagsFromText(rule.title + ' ' + rule.other + ' ' + rule.lido);
    } else {
      const ftags = deriveTagsFromText(hay);
      if (ftags.size){
        const primary = [...ftags][0];
        const mapped = findRuleByTag(primary);
        if (mapped){
          rule = mapped;
          relevant = true;
          reason = `MATCH: ${mapped.title}`;
          tags = deriveTagsFromText(mapped.title + ' ' + mapped.other + ' ' + mapped.lido);
          tags.add(primary);
        } else {
          relevant = true;
          reason = `KEYWORD: ${primary}`;
          tags = ftags;
        }
      }
    }

    if (!relevant) continue;

    if (!state.tails.has(tail)){
      state.tails.set(tail, { tail, relevantItems: [], ruleMap: new Map(), tagCounts: new Map(), score:0 });
    }
    const entry = state.tails.get(tail);

    const src = `W/O ${wo} • ATA ${ata || '—'} • Due ${due || '—'}`;
    const title = rule ? rule.title : (tags.size ? [...tags][0] + ' (fallback)' : 'Dispatch relevant');
    const ruleKey = rule ? String(rule.id || rule.title || title) : title;

    if (!entry.ruleMap.has(ruleKey)){
      const item = { tail, title, rule, reason, sourceSummary: src, occurrences: 1, tags: new Set(tags) };
      entry.ruleMap.set(ruleKey, item);
      entry.relevantItems.push(item);

      const ptags = tags.size ? tags : deriveTagsFromText(title);
      const primaryTag = ptags.size ? [...ptags][0] : title;
      entry.tagCounts.set(primaryTag, (entry.tagCounts.get(primaryTag)||0) + 1);
    } else {
      entry.ruleMap.get(ruleKey).occurrences += 1;
    }

    const distinct = entry.ruleMap.size;
    const tagWeight = entry.tagCounts.size / 3;
    entry.score = Math.max(entry.score, Math.min(5, distinct + tagWeight));
  }

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
