/* MEL Ops Assistant
 * - Structured dispatcher actions from data/mel_actions.json
 * - Optional local PDF search using pdf.js (user loads MEL PDF via file input)
 */
let ACTIONS = [];
let ACTION_INDEX = null; // keyword -> [{a, w}]
let pdfDoc = null;
let pdfPageTextCache = new Map(); // pageNo -> lowercase text
let pdfPageRawCache = new Map();  // pageNo -> raw text

const el = (id) => document.getElementById(id);

function norm(s){ return (s||"").toString().trim(); }
function normLower(s){ return norm(s).toLowerCase(); }

async function loadActions(){
  const res = await fetch("data/mel_actions.json", {cache:"no-store"});
  const js = await res.json();
  ACTIONS = js.actions || [];
  buildActionIndex();
}

function escapeHtml(s){
  return (s||"").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}


function buildActionIndex(){
  const map = new Map(); // key -> array of {a,w}
  const add = (key, a, w)=>{
    const k = normLower(key);
    if(!k) return;
    if(!map.has(k)) map.set(k, []);
    map.get(k).push({a, w});
  };
  for(const a of ACTIONS){
    for(const t of (a.triggers||[])) add(t, a, 8);
    for(const m of (a.mel_numbers||[])) add(m, a, 10);

    // limitation words (weak signals)
    const words = normLower(a.limitation).replace(/[^a-z0-9\-]+/g, " ").split(/\s+/).filter(x=>x.length>=3);
    for(const w of words) add(w, a, 1);
  }
  ACTION_INDEX = {map};
}

function matchLineToActions(line){
  if(!ACTION_INDEX || !ACTION_INDEX.map) return [];
  const low = normLower(line);
  if(!low) return [];
  const scores = new Map(); // actionId -> {a,score}
  for(const [k, arr] of ACTION_INDEX.map){
    if(k.length < 3) continue;
    if(low.includes(k)){
      for(const {a,w} of arr){
        const id = a.id || a.limitation;
        const cur = scores.get(id);
        scores.set(id, {a, score: (cur?cur.score:0) + w});
      }
    }
  }
  const ranked = Array.from(scores.values()).sort((x,y)=>y.score-x.score);
  return ranked.map(x=>x.a);
}

function bulkAddFromText(text){
  const lines = (text||"").split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  let recognized = 0;
  let addedActions = 0;
  let addedLabels = 0;

  for(const line of lines){
    const matches = matchLineToActions(line);
    if(matches.length){
      recognized++;
      // Add the top 2 matches if they have strong signals (trigger/mel number hit).
      for(const a of matches.slice(0,2)){
        addActive(a.limitation, a.id || null);
        addedActions++;
      }
    } else {
      addActive(line, null);
      addedLabels++;
    }
  }

  const report = `Sorok: ${lines.length} • Felismert: ${recognized} • Hozzáadott (akció): ${addedActions} • Hozzáadott (címke): ${addedLabels}`;
  const repEl = document.getElementById("bulkReport");
  if(repEl) repEl.textContent = report;
}


function parseManualMaxFL(tokens){
  // Accept: FL350, FL 350, MAX FL 330, MAXFL330
  let best = null;
  for(const t of tokens){
    const m = t.match(/\b(?:max\s*)?fl\s*([0-9]{2,3})\b/i) || t.match(/\bfl([0-9]{2,3})\b/i);
    if(m){
      const v = parseInt(m[1],10);
      if(!Number.isNaN(v)){
        if(best===null || v < best) best = v;
      }
    }
  }
  return best; // in hundreds of feet e.g. 350
}

function combine(actionsSelected, manualTags){
  const combined = {
    fpl: { item10a:{add:new Set(), remove:new Set()}, item10b:{add:new Set(), remove:new Set()}, item18:{add:new Set(), remove:new Set()} },
    fplConflicts: { item10a:new Set(), item10b:new Set(), item18:new Set() },
    flags: {
      nat_hla_not_permitted:false,
      no_class_e:false,
      no_icing:false,
      no_rnp_apch:false,
      no_ts_forecast:false,
      wx_radar_inop:false,
      adsb_out_inop:false,
      datalink_inop:false,
      fms_reduced:false,
      cat2_not_available:false,
      cat3_not_available:false,
      mx_req_at_refuel:false,
      rvsm_not_permitted:false,
      adsb_ses_3day:false,
      adsc_inop:false,
      ils_category_limited:false,
      gps_degraded:false,
      vor_degraded:false,
      fuel_transfer_limited:false,
      egpws_inop:false,
    },
    maxFL: null,
    lidoSteps: [],
    otherTasks: [],
    notes: []
  };

  // manual parsing
  const manualTokens = manualTags.map(t => t.toUpperCase());
  const mf = parseManualMaxFL(manualTags);
  if(mf !== null) combined.maxFL = mf;

  for(const a of actionsSelected){
    // Steps
    if(a.lido) combined.lidoSteps.push(norm(a.lido).replace(/\s+/g," ").trim());
    if(a.other_tasks) combined.otherTasks.push(a.other_tasks);

    // constraints
    const c = a.constraints || {};
    for(const k of Object.keys(combined.flags)){
      if(c[k] === true) combined.flags[k] = true;
    }
    if(typeof c.max_fl === "number") {
      if(combined.maxFL === null || c.max_fl < combined.maxFL) combined.maxFL = c.max_fl;
    }

    if(c.requires_max_fl) {
      combined.notes.push("FL LIMIT aktív: adj meg kézi címkét pl. 'FL350' / 'MAX FL 330', különben csak a LIDO teendőt listázom.");
    }
    // FPL changes (structured from Excel)
    const fpl = a.fpl || {};
    const addFrom = (item, arr) => { (arr||[]).forEach(x => combined.fpl[item].add.add(x)); };
    const remFrom = (item, arr) => { (arr||[]).forEach(x => combined.fpl[item].remove.add(x)); };

    if(fpl.item10a){ addFrom("item10a", fpl.item10a.add); remFrom("item10a", fpl.item10a.remove); }
    if(fpl.item10b){ addFrom("item10b", fpl.item10b.add); remFrom("item10b", fpl.item10b.remove); }
    if(fpl.item18){ addFrom("item18", fpl.item18.add); remFrom("item18", fpl.item18.remove); }


    (a.fpl_mods||[]).forEach(m => {
      // we keep as note; exact parsing can be messy
      combined.notes.push(`${a.limitation}: ${m.action.toUpperCase()}: ${m.text}`);
    });
  }

  // detect contradictions: add+remove same code
  const contradictions = [];
  for(const item of ["item10a","item10b","item18"]){
    const addSet = combined.fpl[item].add;
    const remSet = combined.fpl[item].remove;
    for(const code of addSet){
      if(remSet.has(code)) contradictions.push(`${item.toUpperCase()} code '${code}' egyszerre ADD és REMOVE — ellenőrizd kézzel.`);
    }
  }
  if(contradictions.length) combined.notes.push(...contradictions);

  // de-duplicate steps preserving order (simple)
  const uniq = (arr) => {
    const seen=new Set();
    const out=[];
    for(const x of arr){
      const k = x.trim();
      if(!k) continue;
      const key = k.toLowerCase();
      if(seen.has(key)) continue;
      seen.add(key);
      out.push(k);
    }
    return out;
  };
  combined.lidoSteps = uniq(combined.lidoSteps);
  combined.otherTasks = uniq(combined.otherTasks);
  combined.notes = uniq(combined.notes);


  // Resolve FPL conflicts: if something is both ADD and REMOVE, treat it as REMOVE (conservative)
  for(const item of ["item10a","item10b","item18"]){
    for(const x of Array.from(combined.fpl[item].add)){
      if(combined.fpl[item].remove.has(x)){
        combined.fplConflicts[item].add(x);
        combined.fpl[item].add.delete(x);
      }
    }
  }

  return combined;
}

function formatCombined(c){
  const lines = [];
  // Key restrictions
  const flags = c.flags;
  const restr = [];
  if(flags.nat_hla_not_permitted) restr.push("NAT HLA: NOT PERMITTED");
  if(flags.no_class_e) restr.push("Class E airspace: NOT PERMITTED (TCAS INOP)");
  if(flags.no_icing) restr.push("ICING ops: NOT PERMITTED");
  if(flags.no_rnp_apch) restr.push("RNP APCH: NOT PERMITTED");
  if(flags.wx_radar_inop) restr.push("WX RADAR INOP: TS/hazardous wx forecast korlát (ellenőrzés szükséges)");
  if(flags.no_ts_forecast) restr.push("TS forecast condition: NO FCST TS (dispatch constraint)");
  if(flags.datalink_inop) restr.push("CPDLC/DATALINK: INOP (FPL + ATC constraints)");
  if(flags.adsb_out_inop) restr.push("ADS-B OUT: INOP (airspace/route constraints lehetséges)");
  if(flags.fms_reduced) restr.push("FMS/MCDU: degraded (PBN / navaid coverage ellenőrzés)");
  if(flags.rvsm_not_permitted) restr.push("RVSM: NOT PERMITTED (tipikusan RTE ≤ FL285)");
  if(flags.adsb_ses_3day) restr.push("ADS-B OUT INOP: SES-en belül tipikusan max 3 nap (CRAR ellenőrzés)");
  if(flags.adsc_inop) restr.push("ADS-C: INOP (oceanic/CPDLC/ATC constraints lehetséges)");
  if(flags.ils_category_limited) restr.push("ILS CAT capability: korlátozott (minima/RVR + landing capability átírás LIDO-ban)");
  if(flags.gps_degraded) restr.push("GPS degraded: PBN/RNAV capability csökkent (FPL PBN módosítás + navaid coverage check)");
  if(flags.vor_degraded) restr.push("VOR degraded: route/alt navaid coverage + FPL nav capability módosítás");
  if(flags.fuel_transfer_limited) restr.push("Fuel transfer limit: long flights tiltás (fuel system MEL – ellenőrizd a listát)");
  if(flags.egpws_inop) restr.push("(E)GPWS INOP: OM-C Airport Briefing korlátozások (special airports)");
  if(flags.cat2_not_available) restr.push("CAT II: NOT AVAILABLE");
  if(flags.cat3_not_available) restr.push("CAT III: NOT AVAILABLE");
  if(c.maxFL !== null) restr.push(`MAX FL: FL${c.maxFL}`);

  lines.push("OPERÁCIÓS KORLÁTOK");
  if(restr.length){
    restr.forEach(x=>lines.push(`- ${x}`));
  } else {
    lines.push("- (nincs explicit operációs tiltás a jelenlegi szabálykészlet alapján)");
  }

  // FPL changes
  const fmtSet = (s) => Array.from(s).sort((a,b)=>a.localeCompare(b));
  lines.push("\nICAO FPL VÁLTOZÁSOK (összegzett)");
  const fmtList = (item, arr) => {
    if(item !== "item18") return arr.length ? arr.join(", ") : "—";
    const pbn = arr.filter(x=>x.startsWith("PBN/")).map(x=>x.slice(4)).sort((a,b)=>a.localeCompare(b));
    const other = arr.filter(x=>!x.startsWith("PBN/")).sort((a,b)=>a.localeCompare(b));
    const parts = [];
    if(pbn.length) parts.push(`PBN/${pbn.join(",")}`);
    if(other.length) parts.push(...other);
    return parts.length ? parts.join("; ") : "—";
  };
  for(const item of ["item10a","item10b","item18"]){
    const add = fmtSet(c.fpl[item].add);
    const rem = fmtSet(c.fpl[item].remove);
    const conf = fmtSet((c.fplConflicts && c.fplConflicts[item]) ? c.fplConflicts[item] : new Set());
    lines.push(`- ${item.toUpperCase()}:`);
    lines.push(`  • ADD: ${fmtList(item, add)}`);
    lines.push(`  • REMOVE: ${fmtList(item, rem)}`);
    if(conf.length){
      lines.push(`  • CONFLICT (REMOVE > ADD): ${fmtList(item, conf)}`);
    }
  }

  // LIDO steps
  lines.push("\nLIDO 4D / DISPATCH TEENDŐK");
  if(c.lidoSteps.length){
    c.lidoSteps.forEach((s,i)=>lines.push(`${i+1}. ${s}`));
  } else {
    lines.push("—");
  }

  // Other tasks
  lines.push("\nEGYÉB (OM / CRAR / briefing) TEENDŐK");
  if(c.otherTasks.length){
    c.otherTasks.forEach((s,i)=>lines.push(`${i+1}. ${s}`));
  } else {
    lines.push("—");
  }

  if(c.notes.length){
    lines.push("\nMEGJEGYZÉS / PARSING INFO");
    c.notes.forEach(x=>lines.push(`- ${x}`));
  }

  return lines.join("\n");
}

function renderActionsMatches(matches){
  const out = [];
  if(!matches.length){
    out.push(`<div class="muted">Nincs találat a strukturált adatbázisban. (Próbáld a PDF keresést vagy adj hozzá kézzel.)</div>`);
    el("results").innerHTML = out.join("");
    return;
  }
  for(const a of matches){
    const tags = [];
    if((a.mel_numbers||[]).length) tags.push(...a.mel_numbers.map(x=>`MEL ${x}`));
    if((a.triggers||[]).length) tags.push(...a.triggers.slice(0,6));
    out.push(`
      <div class="item">
        <div class="itemTop">
          <div>
            <div class="itemTitle">${escapeHtml(a.limitation)}</div>
            <div class="tags">${tags.map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>
          </div>
          <div class="itemActions">
            <button class="btn primary" data-add="${escapeHtml(a.id)}">+ Aktív</button>
          </div>
        </div>
        <div class="kv">
          <div class="k">LIDO</div><div class="v">${escapeHtml(a.lido||"—")}</div>
          <div class="k">Other</div><div class="v">${escapeHtml(a.other_tasks||"—")}</div>
        </div>
      </div>
    `);
  }
  el("results").innerHTML = out.join("");
  // bind add buttons
  document.querySelectorAll("button[data-add]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.getAttribute("data-add");
      const a = ACTIONS.find(x=>x.id===id);
      if(a) addActive(a.limitation, a.id);
    });
  });
}

function actionSearch(query){
  const q = normLower(query);
  if(!q) return [];
  const hits = [];
  for(const a of ACTIONS){
    const lim = normLower(a.limitation);
    const lido = normLower(a.lido);
    const other = normLower(a.other_tasks);
    const trig = (a.triggers||[]).map(x=>x.toLowerCase());
    const mel = (a.mel_numbers||[]).map(x=>x.toLowerCase());
    const score =
      (lim.includes(q)? 4:0) +
      (trig.some(t=>t===q)? 6:0) +
      (trig.some(t=>t.includes(q))? 3:0) +
      (mel.some(m=>m===q)? 7:0) +
      (mel.some(m=>m.includes(q))? 5:0) +
      (lido.includes(q)? 1:0) +
      (other.includes(q)? 1:0);
    if(score>0) hits.push({score, a});
  }
  hits.sort((x,y)=>y.score-x.score);
  return hits.slice(0, 20).map(x=>x.a);
}

// Active limitations state
const active = []; // {label, id?}

function addActive(label, id=null){
  const L = norm(label);
  if(!L) return;
  if(active.some(x=>x.label.toLowerCase()===L.toLowerCase())) return;
  active.push({label:L, id});
  renderActive();
}
function removeActive(label){
  const idx = active.findIndex(x=>x.label===label);
  if(idx>=0) active.splice(idx,1);
  renderActive();
}
function clearActive(){
  active.splice(0, active.length);
  renderActive();
}

function renderActive(){
  const chips = active.map(x=>`
    <span class="chip">
      <span>${escapeHtml(x.label)}</span>
      <button title="Eltávolítás" data-del="${escapeHtml(x.label)}">×</button>
    </span>
  `);
  el("activeList").innerHTML = chips.join("") || `<span class="muted">—</span>`;

  document.querySelectorAll("button[data-del]").forEach(b=>{
    b.addEventListener("click", ()=> removeActive(b.getAttribute("data-del")));
  });

  // Build combined summary
  const selectedActions = active
    .map(x => x.id ? ACTIONS.find(a=>a.id===x.id) : null)
    .filter(Boolean);
  // also try to match manual labels to actions by fuzzy
  for(const x of active){
    if(x.id) continue;
    const m = actionSearch(x.label)[0];
    if(m) selectedActions.push(m);
  }

  const combined = combine(selectedActions, active.map(x=>x.label));
  el("summary").textContent = formatCombined(combined);
}


function extractPdfHints(raw){
  // Heuristic extraction from MEL text (keeps it short and actionable)
  const t = (raw||"").replace(/\s+/g, " ").trim();
  const out = { fpl: [], prohibitions: [], limits: [], conditions: [] };

  // FPL: look for Item 10/18 and Remove/Insert hints
  const fplMatches = [];
  const reFpl = /\b(?:item\s*10a|item\s*10b|item\s*18|item10a|item10b|item18)\b.{0,80}?\b(?:remove|insert|delete|add)\b.{0,90}/ig;
  let m;
  while((m = reFpl.exec(t)) !== null && fplMatches.length < 8){
    fplMatches.push(m[0]);
  }
  out.fpl = fplMatches;

  // Prohibitions/mandatory phrases
  const phrases = [
    /not permitted/ig,
    /shall not/ig,
    /do not/ig,
    /prohibited/ig,
    /must not/ig,
    /not allowed/ig
  ];
  const hits = [];
  for(const r of phrases){
    let mm;
    while((mm = r.exec(t)) !== null && hits.length < 10){
      const start = Math.max(0, mm.index - 80);
      const end = Math.min(t.length, mm.index + 120);
      hits.push(t.slice(start, end));
    }
  }
  out.prohibitions = hits;

  // Numeric limits (days/FL)
  const lim = [];
  const reLim = /\b(max(?:imum)?\s*)?(\d{1,3})\s*(days?|day)\b/ig;
  while((m = reLim.exec(t)) !== null && lim.length < 6){
    lim.push(m[0]);
  }
  const reFl = /\bFL\s*\d{2,3}\b/ig;
  while((m = reFl.exec(t)) !== null && lim.length < 10){
    lim.push(m[0]);
  }
  out.limits = lim;

  // Conditions (IF/WHEN/PROVIDED)
  const cond = [];
  const reCond = /\b(?:provided|if|when|only when|only if|subject to)\b.{0,120}/ig;
  while((m = reCond.exec(t)) !== null && cond.length < 8){
    cond.push(m[0]);
  }
  out.conditions = cond;

  // De-dup
  const uniq = (arr) => {
    const s = new Set();
    const o = [];
    for(const x of arr){
      const k = x.toLowerCase();
      if(s.has(k)) continue;
      s.add(k);
      o.push(x);
    }
    return o;
  };
  out.fpl = uniq(out.fpl);
  out.prohibitions = uniq(out.prohibitions);
  out.limits = uniq(out.limits);
  out.conditions = uniq(out.conditions);

  return out;
}

function formatPdfHints(h){
  const lines = [];
  const addSection = (title, arr) => {
    if(!arr || !arr.length) return;
    lines.push(title);
    arr.slice(0,8).forEach(x=>lines.push(`- ${x}`));
    lines.push("");
  };
  addSection("AUTO-HINT (PDF): FPL / Item 10/18 nyomok", h.fpl);
  addSection("AUTO-HINT (PDF): Tiltás / kötelező művelet nyomok", h.prohibitions);
  addSection("AUTO-HINT (PDF): Limits", h.limits);
  addSection("AUTO-HINT (PDF): Feltételek", h.conditions);
  return lines.length ? lines.join("\n") : "—";
}

// PDF logic
async function loadPdfFromFile(file){
  if(!file) return;

  // pdf.js may fail to load if the CDN is blocked in a corporate network.
  if(typeof pdfjsLib === "undefined"){
    throw new Error("pdfjsLib_not_loaded");
  }

  // Ensure workerSrc is sane and reachable.
  // Many corporate networks block jsDelivr; prefer cdnjs (same CDN family as pdf.min.js in index.html).
  try{
    const preferred = window.__PDFJS_WORKER_SRC__ || "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";
    if(pdfjsLib.GlobalWorkerOptions){
      const cur = pdfjsLib.GlobalWorkerOptions.workerSrc || "";
      const lc = cur.toLowerCase();
      // Force override if empty OR points to jsDelivr OR looks like a mismatched npm 'pdfjs-dist@...' path.
      if(!cur || lc.includes("jsdelivr") || lc.includes("pdfjs-dist@")){
        pdfjsLib.GlobalWorkerOptions.workerSrc = preferred;
      }
    }
  }catch(_){ }

  const buf = await file.arrayBuffer();
  el("pdfStatus").textContent = "PDF: betöltés…";

  // Try with worker first; if the worker cannot be started (blocked CDN / CSP), retry without worker.
  try{
    pdfDoc = await pdfjsLib.getDocument({data: buf}).promise;
  }catch(err){
    // Robust fallback: force main-thread parsing.
    try{ pdfjsLib.disableWorker = true; }catch(_){ }
    try{ if(pdfjsLib.GlobalWorkerOptions) pdfjsLib.GlobalWorkerOptions.workerSrc = ""; }catch(_){ }
    pdfDoc = await pdfjsLib.getDocument({data: buf, disableWorker: true}).promise;
  }

  pdfPageTextCache.clear();
  pdfPageRawCache.clear();
  el("pdfStatus").textContent = `PDF: OK (${pdfDoc.numPages} oldal)`;
}

async function extractPageText(pageNo){
  if(pdfPageRawCache.has(pageNo)) return pdfPageRawCache.get(pageNo);
  const page = await pdfDoc.getPage(pageNo);
  const tc = await page.getTextContent();
  const strings = tc.items.map(it => it.str).filter(Boolean);
  const raw = strings.join(" ").replace(/\s+/g, " ").trim();
  pdfPageRawCache.set(pageNo, raw);
  pdfPageTextCache.set(pageNo, raw.toLowerCase());
  return raw;
}

function makeSnippet(raw, qLower){
  const rawLower = raw.toLowerCase();
  const idx = rawLower.indexOf(qLower);
  if(idx<0) return raw.slice(0, 220) + (raw.length>220 ? "…" : "");
  const start = Math.max(0, idx-90);
  const end = Math.min(raw.length, idx+140);
  let sn = raw.slice(start, end);
  if(start>0) sn = "…" + sn;
  if(end<raw.length) sn = sn + "…";
  // highlight (simple)
  const esc = escapeHtml(sn);
  const re = new RegExp(qLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
  return esc.replace(re, m=>`<mark>${escapeHtml(m)}</mark>`);
}

async function searchPdf(query){
  const q = normLower(query);
  if(!pdfDoc || !q){
    el("pdfAutoHints").textContent = "—";
    el("pdfHits").innerHTML = "—";
    return;
  }
  el("pdfHits").innerHTML = "";
  el("pdfProgress").textContent = "Keresés a PDF-ben… (oldalanként cache-elve)";
  const hits = [];
  const maxHits = 12;

  for(let p=1; p<=pdfDoc.numPages; p++){
    // update progress occasionally
    if(p % 25 === 0) el("pdfProgress").textContent = `Keresés: ${p}/${pdfDoc.numPages} oldal… találat: ${hits.length}`;
    const low = pdfPageTextCache.get(p);
    if(low){
      if(low.includes(q)){
        const raw = pdfPageRawCache.get(p) || "";
        hits.push({page:p, raw});
      }
    } else {
      const raw = await extractPageText(p);
      if(raw.toLowerCase().includes(q)){
        hits.push({page:p, raw});
      }
    }
    if(hits.length >= maxHits) break;
  }

  el("pdfProgress").textContent = hits.length ? `Találat: ${hits.length} (max ${maxHits})` : "Nincs találat (vagy még nem került feldolgozásra a releváns oldal).";

  if(!hits.length){
    el("pdfAutoHints").textContent = "—";
    el("pdfHits").innerHTML = `<div class="muted">Nincs találat a betöltött PDF-ben a megadott kifejezésre.</div>`;
    return;
  }

  // Auto-hints from the first hit (heuristic)
  try{
    const hints = extractPdfHints(hits[0].raw);
    el("pdfAutoHints").textContent = formatPdfHints(hints);
  }catch(e){
    el("pdfAutoHints").textContent = "—";
  }

  const html = hits.map(h=>{
    // Provide viewer hint; user can open locally in another tab if they have viewer; cannot link to local file reliably
    return `
      <div class="hit">
        <div class="meta">
          <div>Oldal: <b>${h.page}</b></div>
          <div class="muted">PDF snippet (lokális)</div>
        </div>
        <div class="snip">${makeSnippet(h.raw, q)}</div>
      </div>
    `;
  });
  el("pdfHits").innerHTML = html.join("");
}

async function doSearch(){
  const query = el("q").value;
  const doA = el("searchActions").checked;
  const doP = el("searchPdf").checked;

  if(doA){
    const matches = actionSearch(query);
    renderActionsMatches(matches);
  } else {
    el("results").innerHTML = `<div class="muted">Strukturált adatbázis keresés kikapcsolva.</div>`;
  }
  if(doP){
    await searchPdf(query);
  } else {
    el("pdfAutoHints").textContent = "—";
    el("pdfHits").innerHTML = "—";
    el("pdfProgress").textContent = "";
  }
}

function bind(){
  el("btnSearch").addEventListener("click", doSearch);
  el("q").addEventListener("keydown", (e)=>{ if(e.key==="Enter") doSearch(); });

  el("btnAddManual").addEventListener("click", ()=>{
    const v = el("manualAdd").value;
    el("manualAdd").value = "";
    addActive(v);
  });
  el("manualAdd").addEventListener("keydown", (e)=>{ if(e.key==="Enter"){ el("btnAddManual").click(); }});
  
  // Bulk import
  const bulkAddBtn = document.getElementById("btnBulkAdd");
  if(bulkAddBtn){
    bulkAddBtn.addEventListener("click", ()=>{
      const t = (document.getElementById("bulkPaste")?.value)||"";
      bulkAddFromText(t);
    });
  }
  const bulkClearBtn = document.getElementById("btnBulkClear");
  if(bulkClearBtn){
    bulkClearBtn.addEventListener("click", ()=>{
      const tp = document.getElementById("bulkPaste");
      if(tp) tp.value = "";
      const rep = document.getElementById("bulkReport");
      if(rep) rep.textContent = "";
    });
  }

el("btnClearActive").addEventListener("click", clearActive);

  el("btnCopySummary").addEventListener("click", async ()=>{
    const txt = el("summary").textContent || "";
    try{
      await navigator.clipboard.writeText(txt);
      el("btnCopySummary").textContent = "Másolva ✓";
      setTimeout(()=> el("btnCopySummary").textContent = "Másolás", 900);
    }catch{
      alert("Nem sikerült a vágólapra másolni. Jelöld ki kézzel a szöveget.");
    }
  });

  el("pdfFile").addEventListener("change", async (e)=>{
    const f = e.target.files && e.target.files[0];
    if(!f) return;
    try{
      await loadPdfFromFile(f);
    }catch(err){
      console.error(err);
      el("pdfStatus").textContent = "PDF: hiba (nem olvasható)";
      const msg = (err && err.message) ? err.message : String(err);
      if(msg==="pdfjsLib_not_loaded"){
        alert("A PDF feldolgozó modul (pdf.js) nem töltődött be. Gyakori ok: vállalati hálózat blokkolja a CDN-t. Próbáld meg más hálózatról, vagy jelezd és adok teljesen offline (vendorolt) verziót.");
      } else {
        alert("A PDF betöltése nem sikerült. Nem jelszó-védett? Akkor tipikusan a pdf.js worker indítása bukik. Most már van fallback, de ha mégis fennáll: " + msg);
      }
    }
  });
}

(async function init(){
  await loadActions();
  bind();
  // Preload a few common ones for quick demo
  addActive("TCAS INOP", ACTIONS.find(a=>/TCAS/i.test(a.limitation))?.id || null);
  addActive("CPDLC INOP", ACTIONS.find(a=>/CPDLC/i.test(a.limitation))?.id || null);
})();
