// Table Scraper — content script. Injected on toolbar-icon click; re-click toggles the panel.
// Works like Instant Data Scraper (detects repeating element lists, not just <table>),
// plus a multi-step mode: click each row, wait, grab taught fields from the detail panel.
//
// No chrome.* APIs are used in here, so the panel keeps working even if the
// extension is reloaded while the page stays open.
// No innerHTML anywhere: pages with Trusted-Types CSP (google.com) would block it.

(() => {
  'use strict';

  if (window.__tableScraper) {
    window.__tableScraper.toggle();
    return;
  }

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'SOURCE', 'LINK', 'META']);
  const JUNK_RE = /^[\s·•|.,;:\-–—()/]*$/; // columns where every value matches this are auto-excluded

  const S = {
    candidates: [],          // [{container, sig, n, score}]
    candIdx: -1,
    current: null,           // selected candidate
    cols: new Map(),         // path -> {name, order, meaningful, user}
    colOrder: 0,
    rows: new Map(),         // rowKey -> {cells: {path: value}, details: {fieldName: value}}
    fields: [],              // [{name, selectors: []}]
    scrolling: false,
    detailing: false,
    picking: false,
  };

  // ---------- tiny utils ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => Math.round(Math.min(a, b) + Math.random() * Math.abs(b - a));
  const qesc = (s) => String(s).replace(/["\\]/g, '\\$&');
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

  // DOM builder (Trusted-Types-safe, no innerHTML)
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style') el.style.cssText = v;
      else if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids) {
      if (kid == null) continue;
      el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return el;
  }

  // ---------- panel UI ----------
  const host = document.createElement('div');
  host.id = '__table-scraper-host';
  host.style.cssText = 'all:initial; position:fixed; top:16px; right:16px; left:auto; z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });

  const CSS_TEXT = `
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .panel { width: 348px; max-height: calc(100vh - 32px); display: flex; flex-direction: column;
      background: #1b1e25; color: #e8eaed; border: 1px solid #2e3440; border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,.5); font-size: 12.5px; line-height: 1.45; overflow: hidden; }
    header { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: #22262f; cursor: grab; user-select: none; flex: 0 0 auto; }
    header .dot { width: 8px; height: 8px; border-radius: 50%; background: #7aa2ff; }
    header b { flex: 1; font-size: 13px; font-weight: 600; color: #e8eaed; }
    .body { overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 14px; }
    section { display: flex; flex-direction: column; gap: 7px; }
    .step { display: flex; align-items: center; gap: 7px; font-weight: 600; color: #aeb6c2; font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; }
    .step .n { width: 16px; height: 16px; border-radius: 50%; background: #2e3440; color: #cfd6e4; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; flex: 0 0 auto; }
    .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    button.b { background: #2a3140; color: #e8eaed; border: 1px solid #39414f; border-radius: 8px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
    button.b:hover { background: #343d50; }
    button.b.primary { background: #3b5bdb; border-color: #4263eb; color: #fff; }
    button.b.primary:hover { background: #4263eb; }
    button.b.danger { background: #5c2e2e; border-color: #7a4040; }
    button.b.small { padding: 3px 8px; font-size: 11px; }
    button.b:disabled { opacity: .45; cursor: default; }
    input.t { background: #12141a; color: #e8eaed; border: 1px solid #39414f; border-radius: 7px; padding: 5px 7px; font-size: 12px; width: 64px; }
    .muted { color: #8b93a1; font-size: 11.5px; }
    .muted input[type="checkbox"] { accent-color: #3b5bdb; margin: 0 3px 0 0; vertical-align: -2px; }
    .pill { background: #242a35; border: 1px solid #333b49; border-radius: 999px; padding: 2px 9px; font-size: 11px; color: #cfd6e4; }
    .fields { display: flex; flex-direction: column; gap: 4px; }
    .fieldrow { display: flex; align-items: center; gap: 6px; background: #242a35; border: 1px solid #333b49; border-radius: 8px; padding: 4px 8px; }
    .fieldrow b { flex: 0 0 auto; color: #9ec1ff; font-weight: 600; }
    .fieldrow span { flex: 1; color: #8b93a1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; }
    .fieldrow button { background: none; border: none; color: #d08080; cursor: pointer; font-size: 13px; padding: 0 2px; }
    .bar { height: 6px; background: #242a35; border-radius: 4px; overflow: hidden; display: none; }
    .bar i { display: block; height: 100%; width: 0%; background: #6fd08c; transition: width .2s; }
    .preview { overflow: auto; max-height: 260px; border: 1px solid #2e3440; border-radius: 8px; display: none; }
    table { border-collapse: collapse; font-size: 11px; }
    th, td { border-bottom: 1px solid #2a3038; border-right: 1px solid #2a3038; padding: 3px 6px; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; color: #cfd6e4; }
    th { position: sticky; top: 0; background: #22262f; cursor: pointer; color: #9ec1ff; z-index: 1; }
    th.f { color: #6fd08c; }
    th.off { color: #5c6470; text-decoration: line-through; }
    .colpick { display: none; flex-direction: column; gap: 6px; border: 1px solid #2e3440; border-radius: 8px; padding: 8px; background: #171a21; }
    .collist { display: flex; flex-direction: column; gap: 2px; max-height: 170px; overflow-y: auto; }
    .colrow { display: flex; align-items: center; gap: 7px; padding: 3px 6px; border-radius: 6px; cursor: pointer; }
    .colrow:hover { background: #242a35; }
    .colrow b { color: #cfd6e4; font-weight: 600; font-size: 11.5px; white-space: nowrap; }
    .colrow.off b { color: #5c6470; text-decoration: line-through; }
    .colrow .sample { flex: 1; color: #7d8694; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .colrow input { accent-color: #3b5bdb; margin: 0; flex: 0 0 auto; }
    .tag { background: #1e3527; color: #6fd08c; border-radius: 4px; font-size: 9.5px; padding: 1px 5px; text-transform: uppercase; letter-spacing: .04em; flex: 0 0 auto; }
    .status { padding: 8px 12px; background: #161920; border-top: 1px solid #2e3440; font-size: 11.5px; color: #aeb6c2; min-height: 33px; flex: 0 0 auto; }
  `;

  const U = {}; // ui element refs

  function buildPanel() {
    const style = document.createElement('style');
    style.textContent = CSS_TEXT;

    U.status = h('div', { class: 'status', text: 'Detecting lists…' });
    U.tblInfo = h('span', { class: 'pill', text: 'no table' });
    U.rowCount = h('span', { class: 'pill', text: '0 rows' });
    U.dMin = h('input', { class: 't', type: 'number', value: '800', min: '0' });
    U.dMax = h('input', { class: 't', type: 'number', value: '2200', min: '0' });
    U.chkScroll = h('input', { type: 'checkbox' });
    U.chkScroll.checked = true;
    U.btnRescan = h('button', { class: 'b', text: '↻ Rescan', onclick: () => { if (!busy()) rescan(); } });
    U.btnNext = h('button', { class: 'b', text: 'Try another table', onclick: () => {
      if (busy() || !S.candidates.length) return;
      selectCandidate((S.candIdx + 1) % S.candidates.length);
    } });
    U.btnScroll = h('button', { class: 'b primary', text: '▶ Scroll & collect', onclick: () => {
      if (S.scrolling) { S.scrolling = false; return; }
      if (S.detailing) return;
      scrollLoop();
    } });
    U.btnPick = h('button', { class: 'b', text: '＋ Pick detail field', onclick: () => {
      if (S.picking) { stopPicker(); setStatus('Picker cancelled.'); return; }
      startPicker();
    } });
    U.fieldsBox = h('div', { class: 'fields' });
    U.fName = h('input', { class: 't', style: 'width:120px', placeholder: 'column name' });
    U.fSave = h('button', { class: 'b primary small', text: 'Save', onclick: saveField });
    U.fCancel = h('button', { class: 'b small', text: 'Cancel', onclick: () => { pendingField = null; U.nameForm.style.display = 'none'; } });
    U.nameForm = h('div', { class: 'row', style: 'display:none' }, U.fName, U.fSave, U.fCancel);
    U.btnDetails = h('button', { class: 'b primary', text: '▶ Click each row & grab', disabled: '', onclick: () => {
      if (S.detailing) { S.detailing = false; return; }
      if (S.scrolling) return;
      detailLoop('all');
    } });
    U.btnRetry = h('button', { class: 'b', style: 'display:none', text: '↻ Retry empties', onclick: () => {
      if (S.detailing) { S.detailing = false; return; }
      if (S.scrolling) return;
      detailLoop('retry');
    } });
    U.cDelay = h('input', { class: 't', type: 'number', value: '250', min: '0', title: 'Pause between listing clicks (ms). Lower = faster. Separate from the scroll delay.' });
    U.barFill = h('i');
    U.bar = h('div', { class: 'bar' }, U.barFill);
    U.btnCsv = h('button', { class: 'b primary', text: '⬇ Export CSV', onclick: exportCsv });
    U.btnCopy = h('button', { class: 'b', title: 'Tab-separated — pastes into Google Sheets / Excel as real cells', text: '⧉ Copy table', onclick: copyCsv });
    U.btnCols = h('button', { class: 'b', text: '☰ Columns', onclick: () => { colsOn = !colsOn; renderAll(); } });
    U.btnPrev = h('button', { class: 'b', text: 'Preview', onclick: () => { previewOn = !previewOn; renderPreview(); } });
    U.btnReset = h('button', { class: 'b danger', text: 'Clear data', onclick: () => {
      if (busy()) return;
      clearData();
      renderAll();
      setStatus('Collected data cleared (table choice and detail fields kept).');
    } });
    U.colPick = h('div', { class: 'colpick' });
    U.preview = h('div', { class: 'preview' });
    U.body = h('div', { class: 'body' },
      h('section', {},
        h('div', { class: 'step' }, h('span', { class: 'n', text: '1' }), 'Pick the list & collect'),
        h('div', { class: 'row' }, U.btnRescan, U.btnNext, U.tblInfo),
        h('div', { class: 'row' },
          h('label', { class: 'muted' }, 'delay min ', U.dMin),
          h('label', { class: 'muted' }, 'max ', U.dMax),
          h('span', { class: 'muted', text: 'ms' })),
        h('div', { class: 'row' },
          U.btnScroll,
          h('label', { class: 'muted', title: 'Untick to scroll the list yourself — rows are still collected while it runs' }, U.chkScroll, 'auto-scroll'),
          U.rowCount)),
      h('section', {},
        h('div', { class: 'step' }, h('span', { class: 'n', text: '2' }), 'Detail fields (click-through)'),
        h('div', { class: 'muted', text: 'Optional. Open ONE listing’s detail panel yourself, then pick the value in it (e.g. the phone number). Then run — it clicks every row and grabs that field.' }),
        h('div', { class: 'row' }, U.btnPick),
        U.fieldsBox,
        U.nameForm,
        h('div', { class: 'row' }, U.btnDetails, U.btnRetry,
          h('label', { class: 'muted' }, 'click delay ', U.cDelay, ' ms')),
        U.bar),
      h('section', {},
        h('div', { class: 'step' }, h('span', { class: 'n', text: '3' }), 'Export'),
        h('div', { class: 'row' }, U.btnCsv, U.btnCopy),
        h('div', { class: 'row' }, U.btnCols, U.btnPrev, U.btnReset),
        U.colPick,
        U.preview));

    U.btnMin = h('button', { class: 'b small', title: 'Collapse', text: '–', onclick: () => {
      const hidden = U.body.style.display === 'none';
      U.body.style.display = hidden ? '' : 'none';
      U.status.style.display = hidden ? '' : 'none';
      U.btnMin.textContent = hidden ? '–' : '+';
    } });
    U.btnClose = h('button', { class: 'b small', title: 'Hide (re-open via toolbar icon)', text: '✕', onclick: () => api.toggle() });
    U.hdr = h('header', {}, h('span', { class: 'dot' }), h('b', { text: 'Table Scraper' }), U.btnMin, U.btnClose);

    root.appendChild(style);
    root.appendChild(h('div', { class: 'panel' }, U.hdr, U.body, U.status));
    document.documentElement.appendChild(host);

    // drag by header
    let on = false, sx = 0, sy = 0, ox = 0, oy = 0;
    U.hdr.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      on = true; sx = e.clientX; sy = e.clientY;
      const r = host.getBoundingClientRect(); ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!on) return;
      host.style.left = Math.max(0, Math.min(innerWidth - 60, ox + e.clientX - sx)) + 'px';
      host.style.top = Math.max(0, Math.min(innerHeight - 40, oy + e.clientY - sy)) + 'px';
      host.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => { on = false; });
  }

  function setStatus(msg) { U.status.textContent = msg; }
  function busy() { return S.scrolling || S.detailing; }

  function delays() {
    let lo = parseInt(U.dMin.value, 10); if (isNaN(lo)) lo = 800;
    let hi = parseInt(U.dMax.value, 10); if (isNaN(hi)) hi = 2200;
    if (hi < lo) [lo, hi] = [hi, lo];
    return { lo: Math.max(0, lo), hi: Math.max(0, hi) };
  }

  // small pause between detail clicks (separate from the scroll delay); slight jitter for politeness
  function clickDelay() {
    let d = parseInt(U.cDelay.value, 10); if (isNaN(d)) d = 250;
    d = Math.max(0, d);
    return d + Math.round(Math.random() * d * 0.3);
  }

  // ---------- list detection (IDS-style: repeating sibling structures, not just <table>) ----------
  const sigOf = (el) => el.tagName + (el.classList.length ? '.' + [...el.classList].sort().join('.') : '');

  function findCandidates() {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.currentNode; el; el = walker.nextNode()) {
      if (el === host || el instanceof SVGElement || SKIP_TAGS.has(el.tagName)) continue;
      if (el.children.length < 4) continue;
      const groups = new Map();
      for (const ch of el.children) {
        const s = sigOf(ch);
        let g = groups.get(s);
        if (!g) groups.set(s, (g = []));
        g.push(ch);
      }
      for (const [sig, els] of groups) {
        if (els.length < 4) continue;
        let txt = 0;
        for (const e of els) txt += Math.min(norm(e.textContent).length, 1500);
        const avg = txt / els.length;
        if (avg < 6) continue; // skip icon strips / empty separators
        out.push({ container: el, sig, n: els.length, score: els.length * avg });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 25);
  }

  let hlCont = null;
  function highlight(el) {
    if (hlCont) hlCont.style.outline = '';
    hlCont = el;
    if (el) { el.style.outline = '2px dashed #7aa2ff'; el.style.outlineOffset = '-2px'; }
  }

  let hlRowEl = null;
  function hlRow(el) {
    if (hlRowEl) hlRowEl.style.outline = '';
    hlRowEl = el;
    if (el) { el.style.outline = '2px solid #6fd08c'; el.style.outlineOffset = '-2px'; }
  }

  function clearData() {
    S.cols = new Map();
    S.colOrder = 0;
    S.rows.clear();
  }

  function selectCandidate(i) {
    const c = S.candidates[i];
    if (!c) return;
    S.candIdx = i;
    const changed = !S.current || S.current.sig !== c.sig || S.current.container !== c.container;
    S.current = c;
    if (changed) clearData();
    highlight(c.container);
    collect();
    renderAll();
    setStatus(`Table ${i + 1}/${S.candidates.length} (outlined on page) — ${getRowEls().length} rows in view. Wrong one? “Try another table”.`);
  }

  function rescan() {
    const prev = S.current;
    S.candidates = findCandidates();
    if (!S.candidates.length) {
      S.candIdx = -1; S.current = null;
      highlight(null);
      renderAll();
      setStatus('No repeating lists found on this page.');
      return;
    }
    let idx = 0;
    if (prev) {
      const same = S.candidates.findIndex((c) => c.container === prev.container && c.sig === prev.sig);
      if (same >= 0) idx = same;
    }
    selectCandidate(idx);
  }

  function getRowEls() {
    const c = S.current;
    if (!c) return [];
    if (!c.container || !c.container.isConnected) {
      // page re-rendered: relocate a container whose children match our row signature
      let best = null, bestN = 0;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      for (let el = walker.currentNode; el; el = walker.nextNode()) {
        if (el === host || el.children.length < 2) continue;
        let n = 0;
        for (const ch of el.children) if (sigOf(ch) === c.sig) n++;
        if (n > bestN) { bestN = n; best = el; }
      }
      if (best && bestN >= 2) { c.container = best; highlight(best); }
      else return [];
    }
    return [...c.container.children].filter((ch) => sigOf(ch) === c.sig);
  }

  // ---------- row extraction ----------
  function rowKey(rowEl) {
    const a = rowEl.querySelector('a[href]');
    if (a && a.href) return a.href;
    return 'txt:' + norm(rowEl.textContent).slice(0, 180);
  }

  function colName(path) {
    let kind = '';
    let p = path;
    const m = p.match(/@(href|src|label)$/);
    if (m) { kind = m[1]; p = p.slice(0, -m[0].length); }
    const last = p.split('>').pop();
    const occ = (last.match(/~(\d+)$/) || [])[1];
    const seg = last.replace(/~\d+$/, '');
    const cls = seg.split('.').slice(1);
    let base = cls.length ? cls[cls.length - 1] : seg.toLowerCase();
    if (kind === 'href') base = 'link';
    else if (kind === 'src') base += '_img';
    else if (kind === 'label') base += '_label';
    return occ ? base + '_' + occ : base;
  }

  function regCol(path) {
    let col = S.cols.get(path);
    if (!col) {
      col = { name: colName(path), order: S.colOrder++, meaningful: false, user: undefined };
      S.cols.set(path, col);
    }
    return col;
  }

  function extractCells(rowEl) {
    const cells = {};
    const add = (path, v) => {
      v = norm(v);
      if (!v) return;
      cells[path] = v;
      const col = regCol(path);
      if (!JUNK_RE.test(v)) col.meaningful = true;
    };
    (function walk(el, base) {
      const seen = {};
      for (const ch of el.children) {
        if (ch instanceof SVGElement || SKIP_TAGS.has(ch.tagName)) continue;
        const s0 = sigOf(ch);
        seen[s0] = (seen[s0] || 0) + 1;
        const p = (base ? base + '>' : '') + s0 + (seen[s0] > 1 ? '~' + seen[s0] : '');
        let own = '';
        for (const n of ch.childNodes) if (n.nodeType === 3) own += n.nodeValue;
        own = norm(own);
        if (own) add(p, own);
        else {
          const al = ch.getAttribute('aria-label');
          // overlay links / icon-only elements carry their value in aria-label
          if (al && !ch.textContent.trim()) add(p + '@label', al);
        }
        if (ch.tagName === 'A' && ch.href) add(p + '@href', ch.href);
        if (ch.tagName === 'IMG') {
          const src = ch.currentSrc || ch.src;
          if (src && !src.startsWith('data:')) add(p + '@src', src);
        }
        walk(ch, p);
      }
    })(rowEl, '');
    return cells;
  }

  function collect() {
    let added = 0;
    for (const rowEl of getRowEls()) {
      const key = rowKey(rowEl);
      const cells = extractCells(rowEl);
      const ex = S.rows.get(key);
      if (ex) Object.assign(ex.cells, cells); // refresh (lazy-loaded images etc.)
      else { S.rows.set(key, { cells, details: {} }); added++; }
    }
    return added;
  }

  // ---------- infinite scroll ----------
  function scrollerFor(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/auto|scroll|overlay/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 10) return n;
    }
    return document.scrollingElement || document.documentElement;
  }

  async function scrollLoop() {
    if (!S.current) { setStatus('Pick a table first (Rescan).'); return; }
    const auto = U.chkScroll.checked;
    S.scrolling = true;
    U.btnScroll.textContent = '⏹ Stop';
    U.btnScroll.classList.add('danger');
    collect();
    renderAll();
    let stagnant = 0, ticks = 0;
    // auto mode stops after 3 idle rounds; manual mode keeps collecting until Stop
    while (S.scrolling && ticks < 2000 && (!auto || stagnant < 3)) {
      ticks++;
      if (auto) {
        const rowEls = getRowEls();
        const sc = scrollerFor(rowEls[rowEls.length - 1] || S.current.container);
        if (stagnant > 0) { sc.scrollTop -= 300; await sleep(180); } // jiggle to re-trigger lazy loaders
        sc.scrollTop = sc.scrollHeight;
      }
      const { lo, hi } = delays();
      await sleep(rand(lo, hi));
      const before = S.rows.size;
      collect();
      if (auto) stagnant = S.rows.size === before ? stagnant + 1 : 0;
      setStatus(auto
        ? `Scrolling… ${S.rows.size} rows collected${stagnant ? ` (no new ×${stagnant})` : ''}. Press Stop to end early.`
        : `Watching — scroll the list yourself. ${S.rows.size} rows collected. Press Stop when done.`);
      renderAll();
    }
    S.scrolling = false;
    U.btnScroll.textContent = '▶ Scroll & collect';
    U.btnScroll.classList.remove('danger');
    renderAll();
    setStatus(`Collecting done — ${S.rows.size} rows. Next: add a detail field (step 2) or Export (step 3).`);
  }

  // ---------- element picker (teach a detail field) ----------
  let pickBox = null, pickTip = null, pendingField = null;

  function inPanel(e) { return e.composedPath && e.composedPath().includes(host); }

  function startPicker() {
    if (S.picking) return;
    S.picking = true;
    U.btnPick.textContent = '✕ Cancel picking';
    pickBox = document.createElement('div');
    pickBox.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #7aa2ff;background:rgba(122,162,255,.18);border-radius:4px;display:none;';
    pickTip = document.createElement('div');
    pickTip.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;background:#1b1e25;color:#e8eaed;font:12px system-ui;padding:4px 8px;border-radius:6px;border:1px solid #39414f;max-width:340px;display:none;';
    document.documentElement.append(pickBox, pickTip);
    document.addEventListener('mousemove', pkMove, true);
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) document.addEventListener(t, pkBlock, true);
    document.addEventListener('keydown', pkKey, true);
    setStatus('Picker active — hover the page, click the value you want (e.g. the phone number). Esc cancels.');
  }

  function stopPicker() {
    S.picking = false;
    U.btnPick.textContent = '＋ Pick detail field';
    document.removeEventListener('mousemove', pkMove, true);
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) document.removeEventListener(t, pkBlock, true);
    document.removeEventListener('keydown', pkKey, true);
    if (pickBox) pickBox.remove();
    if (pickTip) pickTip.remove();
    pickBox = pickTip = null;
  }

  function pkMove(e) {
    if (!pickBox) return;
    if (inPanel(e)) { pickBox.style.display = 'none'; pickTip.style.display = 'none'; return; }
    const t = e.target;
    const r = t.getBoundingClientRect();
    Object.assign(pickBox.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    const txt = norm(t.textContent || t.getAttribute('aria-label') || '').slice(0, 60);
    pickTip.textContent = txt ? `“${txt}” — click to capture (Esc cancels)` : 'Click to capture (Esc cancels)';
    Object.assign(pickTip.style, { display: 'block', left: Math.min(e.clientX + 14, innerWidth - 300) + 'px', top: Math.min(e.clientY + 18, innerHeight - 40) + 'px' });
  }

  function pkBlock(e) {
    if (inPanel(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click') finishPick(e.target);
  }

  function pkKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      stopPicker();
      setStatus('Picker cancelled.');
    }
  }

  const valueOf = (el) => norm(el.textContent) || norm(el.getAttribute('aria-label') || '');

  function finishPick(el) {
    stopPicker();
    const selectors = buildSelectors(el);
    if (!selectors.length) {
      setStatus('Could not build a stable selector for that element — try clicking its parent row instead.');
      return;
    }
    const val = valueOf(el);
    pendingField = { selectors };
    U.nameForm.style.display = 'flex';
    U.fName.value = suggestName(el) || 'phone';
    U.fName.focus();
    U.fName.select();
    setStatus(`Captured “${val.slice(0, 45)}”. Name the column, then Save.`);
  }

  function saveField() {
    if (!pendingField) return;
    const name = U.fName.value.trim() || 'field' + (S.fields.length + 1);
    S.fields.push({ name, selectors: pendingField.selectors });
    pendingField = null;
    U.nameForm.style.display = 'none';
    renderFields();
    renderAll();
    setStatus(`Field “${name}” added. Now press “Click each row & grab”.`);
  }

  function suggestName(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      for (const a of n.attributes || []) {
        if (a.name === 'aria-label' || a.name.startsWith('data-')) {
          const m = String(a.value).match(/^([A-Za-z][A-Za-z ]{1,18}?)[\s:：]*[\d+(]/);
          if (m) return m[1].trim().toLowerCase().replace(/\s+/g, '_');
        }
      }
    }
    return '';
  }

  // ---------- selector generation ----------
  function cssSig(el) {
    let s = el.tagName.toLowerCase();
    for (const c of el.classList) s += '.' + CSS.escape(c);
    return s;
  }

  // stable prefix of an attribute value: everything before the first digit/+/(
  // e.g. data-item-id="phone:tel:+61393291300" -> "phone:tel:"  |  aria-label="Phone: 03 9329" -> "Phone:"
  function stablePrefix(v) {
    const m = String(v).match(/^[^0-9+(]*/);
    const p = m ? m[0].replace(/\s+$/, '') : '';
    return p.length >= 3 ? p : null;
  }

  function attrSelectors(el) {
    const out = [];
    const tag = el.tagName.toLowerCase();
    for (const a of el.attributes) {
      const { name, value: v } = a;
      if (!v) continue;
      const ok = name.startsWith('data-') || ['aria-label', 'itemprop', 'title', 'name', 'rel'].includes(name);
      if (!ok || v.length > 120) continue;
      const pfx = stablePrefix(v);
      if (pfx && pfx.length < v.length) out.push(`${tag}[${name}^="${qesc(pfx)}"]`);
      else if (!/\d/.test(v) && v.length <= 60) out.push(`${tag}[${name}="${qesc(v)}"]`);
    }
    return out;
  }

  function buildSelectors(target) {
    const cands = [];
    if (target.id && !/\d/.test(target.id)) cands.push('#' + CSS.escape(target.id));
    cands.push(...attrSelectors(target));
    let node = target.parentElement;
    for (let d = 0; node && node !== document.body && d < 6; d++, node = node.parentElement) {
      for (const aSel of attrSelectors(node)) cands.push(aSel + ' ' + cssSig(target));
      if (node.id && !/\d/.test(node.id)) cands.push('#' + CSS.escape(node.id) + ' ' + cssSig(target));
    }
    // pure class-path fallback (least robust, tried last)
    let path = cssSig(target), n2 = target.parentElement;
    for (let d = 0; n2 && n2 !== document.body && d < 2; d++, n2 = n2.parentElement) path = cssSig(n2) + ' > ' + path;
    cands.push(path);

    const strong = [], weak = [];
    for (const sel of [...new Set(cands)]) {
      let m;
      try { m = document.querySelectorAll(sel); } catch { continue; }
      if (!m.length) continue;
      if (m[0] === target) (m.length === 1 ? strong : weak).push(sel);
      else if (m[0].contains(target) || target.contains(m[0])) weak.push(sel);
    }
    return [...strong, ...weak].slice(0, 8);
  }

  function queryField(f) {
    for (const sel of f.selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch { /* ignore bad selector */ }
    }
    return null;
  }

  // ---------- multi-step detail pass ----------
  function simulateClick(el) {
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: Math.max(0, r.left + r.width / 2), clientY: Math.max(0, r.top + r.height / 2),
      button: 0, detail: 1,
    };
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const ev = t.startsWith('pointer')
        ? new PointerEvent(t, { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true })
        : new MouseEvent(t, base);
      el.dispatchEvent(ev);
    }
  }

  // Maps changes location.href when a listing is opened — that's the fast, reliable
  // "panel switched" signal. Also accept any taught field becoming a new node.
  async function waitPanelSwitch(prevUrl, prev, ms) {
    const deadline = Date.now() + ms;
    while (S.detailing && Date.now() < deadline) {
      if (location.href !== prevUrl) return true;
      for (let i = 0; i < S.fields.length; i++) {
        const el = queryField(S.fields[i]);
        if (el && el !== prev[i].el) return true;
      }
      await sleep(70);
    }
    return location.href !== prevUrl;
  }

  // Grab all fields together in one poll loop. Returns as soon as every field is found,
  // so a value-less listing waits once (maxMs) instead of 5s PER field.
  async function grabAll(prev, switched, maxMs) {
    const out = new Array(S.fields.length).fill('');
    const need = new Set(S.fields.map((_, i) => i));
    const deadline = Date.now() + maxMs;
    while (S.detailing && need.size && Date.now() < deadline) {
      for (const i of [...need]) {
        const el = queryField(S.fields[i]);
        if (!el) continue;
        const v = valueOf(el);
        // panel already switched => any present value is the new listing's; else guard against stale
        if (v && (switched || el !== prev[i].el || v !== prev[i].val)) { out[i] = v; need.delete(i); }
      }
      if (need.size) await sleep(90);
    }
    return out;
  }

  async function detailLoop(mode) {
    if (!S.fields.length) { setStatus('Pick a detail field first.'); return; }
    if (!S.rows.size) collect();
    S.detailing = true;
    U.btnDetails.textContent = '⏹ Stop';
    U.btnDetails.classList.add('danger');
    U.btnRetry.style.display = 'none';
    U.bar.style.display = 'block';
    U.barFill.style.width = '0%';

    // 'retry' -> only rows where a grab came back empty; otherwise any row missing a value
    const todoKeys = [];
    for (const el of getRowEls()) {
      const k = rowKey(el);
      const row = S.rows.get(k);
      if (row && S.fields.some((f) => (mode === 'retry' ? row.details[f.name] === '' : !row.details[f.name]))) todoKeys.push(k);
    }
    if (!todoKeys.length) {
      S.detailing = false;
      U.btnDetails.textContent = '▶ Click each row & grab';
      U.btnDetails.classList.remove('danger');
      U.bar.style.display = 'none';
      renderAll();
      setStatus(mode === 'retry' ? 'No empty values left to retry.' : 'Every row already has its values — nothing to do.');
      return;
    }

    let done = 0, captured = 0, missing = 0, skipped = 0;
    for (const key of todoKeys) {
      if (!S.detailing) break;
      const rowEl = getRowEls().find((e) => rowKey(e) === key);
      const row = S.rows.get(key);
      if (!rowEl || !row) { skipped++; continue; }
      try { rowEl.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch { /* ignore */ }
      hlRow(rowEl);
      const prevUrl = location.href;
      const prev = S.fields.map((f) => {
        const el = queryField(f);
        return { el, val: el ? valueOf(el) : '' };
      });
      simulateClick(rowEl.querySelector('a[href]') || rowEl);
      // wait for the listing panel to actually switch (URL change) — event-driven, not a fixed sleep
      const switched = await waitPanelSwitch(prevUrl, prev, 3500);
      await sleep(clickDelay()); // small settle + politeness pause
      // switched => trust values fast (≤1.2s for a blank); fallback keeps the stale-guard a bit longer
      const vals = await grabAll(prev, switched, switched ? 1200 : 3000);
      for (let i = 0; i < S.fields.length; i++) {
        row.details[S.fields[i].name] = vals[i];
        if (vals[i]) captured++; else missing++;
      }
      done++;
      U.barFill.style.width = Math.round((done / todoKeys.length) * 100) + '%';
      setStatus(`Details: ${done}/${todoKeys.length} rows · ${captured} captured · ${missing} empty`);
      renderSoon();
    }
    hlRow(null);
    const stopped = done < todoKeys.length;
    S.detailing = false;
    U.btnDetails.textContent = '▶ Click each row & grab';
    U.btnDetails.classList.remove('danger');
    renderAll();
    setStatus(`Detail pass ${stopped ? 'stopped' : 'finished'}: ${done}/${todoKeys.length} rows, ${captured} values, ${missing} empty${skipped ? `, ${skipped} rows gone from page` : ''}. Re-running only retries missing ones.`);
  }

  // ---------- preview & CSV ----------
  let previewOn = false;
  let colsOn = false;
  let lastRender = 0;
  function renderSoon() {
    if (Date.now() - lastRender > 400) { renderPreview(); lastRender = Date.now(); }
  }

  function effExcluded(col) { return col.user !== undefined ? col.user : !col.meaningful; }
  function orderedCols() {
    return [...S.cols.entries()].map(([path, col]) => ({ path, col })).sort((a, b) => a.col.order - b.col.order);
  }

  function renderPreview() {
    const box = U.preview;
    const prevTop = box.scrollTop, prevLeft = box.scrollLeft;
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!previewOn || !S.rows.size) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    // all rows, only the ticked columns — manage ticks in ☰ Columns
    const cols = orderedCols().filter((e) => !effExcluded(e.col));
    const flds = S.fields.filter((f) => !f.excluded);
    if (!cols.length && !flds.length) {
      box.appendChild(h('div', { class: 'muted', style: 'padding:8px', text: 'All columns hidden — tick some in ☰ Columns.' }));
      return;
    }
    const table = h('table');
    const trh = h('tr');
    for (const e of cols) trh.appendChild(h('th', { title: e.path, text: e.col.name }));
    for (const f of flds) trh.appendChild(h('th', { class: 'f', title: 'detail field', text: f.name }));
    table.appendChild(trh);
    for (const row of S.rows.values()) {
      const tr = h('tr');
      for (const e of cols) tr.appendChild(h('td', { title: row.cells[e.path] || '', text: (row.cells[e.path] || '').slice(0, 60) }));
      for (const f of flds) tr.appendChild(h('td', { text: (row.details[f.name] || '').slice(0, 60) }));
      table.appendChild(tr);
    }
    box.appendChild(table);
    box.scrollTop = prevTop;
    box.scrollLeft = prevLeft;
  }

  function sampleFor(path) {
    for (const r of S.rows.values()) {
      if (r.cells[path]) return r.cells[path];
    }
    return '';
  }

  function sampleField(name) {
    for (const r of S.rows.values()) {
      if (r.details[name]) return r.details[name];
    }
    return '';
  }

  function colRow(name, sample, on, isField, toggle) {
    const cb = h('input', { type: 'checkbox', onchange: toggle });
    cb.checked = on;
    return h('label', { class: 'colrow' + (on ? '' : ' off') },
      cb,
      h('b', { text: name }),
      isField ? h('span', { class: 'tag', text: 'detail' }) : null,
      h('span', { class: 'sample', text: sample ? sample.slice(0, 48) : '—' }));
  }

  function renderCols() {
    const box = U.colPick;
    const prevScroll = U.colList ? U.colList.scrollTop : 0;
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!colsOn) { box.style.display = 'none'; return; }
    box.style.display = 'flex';
    if (!S.cols.size && !S.fields.length) {
      box.appendChild(h('div', { class: 'muted', text: 'No columns yet — collect rows first (step 1).' }));
      return;
    }
    box.appendChild(h('div', { class: 'row' },
      h('button', { class: 'b small', text: 'All', onclick: () => {
        for (const { col } of orderedCols()) col.user = false;
        for (const f of S.fields) f.excluded = false;
        renderAll();
      } }),
      h('button', { class: 'b small', text: 'None', onclick: () => {
        for (const { col } of orderedCols()) col.user = true;
        for (const f of S.fields) f.excluded = true;
        renderAll();
      } }),
      h('button', { class: 'b small', text: 'Auto', title: 'Back to automatic junk-column detection', onclick: () => {
        for (const { col } of orderedCols()) col.user = undefined;
        for (const f of S.fields) f.excluded = false;
        renderAll();
      } }),
      h('span', { class: 'muted', text: 'ticked = exported' })));
    const list = h('div', { class: 'collist' });
    for (const { path, col } of orderedCols()) {
      list.appendChild(colRow(col.name, sampleFor(path), !effExcluded(col), false, () => {
        col.user = !effExcluded(col);
        renderAll();
      }));
    }
    for (const f of S.fields) {
      list.appendChild(colRow(f.name, sampleField(f.name), !f.excluded, true, () => {
        f.excluded = !f.excluded;
        renderAll();
      }));
    }
    box.appendChild(list);
    U.colList = list;
    list.scrollTop = prevScroll; // keep position — rebuilding the list must not jump to top
  }

  function renderFields() {
    const box = U.fieldsBox;
    while (box.firstChild) box.removeChild(box.firstChild);
    S.fields.forEach((f, i) => {
      box.appendChild(h('div', { class: 'fieldrow' },
        h('b', { text: f.name }),
        h('span', { title: f.selectors.join('\n'), text: f.selectors[0] }),
        h('button', { title: 'remove', text: '✕', onclick: () => { S.fields.splice(i, 1); renderFields(); renderAll(); } })));
    });
    U.btnDetails.disabled = !S.fields.length;
  }

  function renderAll() {
    U.rowCount.textContent = `${S.rows.size} rows`;
    U.tblInfo.textContent = S.current
      ? `table ${S.candIdx + 1}/${S.candidates.length} · ${getRowEls().length} in view`
      : 'no table';
    U.btnDetails.disabled = !S.fields.length;
    const inc = orderedCols().filter((e) => !effExcluded(e.col)).length + S.fields.filter((f) => !f.excluded).length;
    const tot = S.cols.size + S.fields.length;
    U.btnCols.textContent = tot ? `☰ Columns (${inc}/${tot})` : '☰ Columns';
    const empties = S.fields.length
      ? [...S.rows.values()].filter((r) => S.fields.some((f) => r.details[f.name] === '')).length
      : 0;
    U.btnRetry.textContent = `↻ Retry empties (${empties})`;
    U.btnRetry.style.display = !S.detailing && empties ? '' : 'none';
    renderCols();
    renderPreview();
  }

  function csvData() {
    if (!S.rows.size) return null;
    const cols = orderedCols().filter((c) => !effExcluded(c.col));
    const flds = S.fields.filter((f) => !f.excluded);
    if (!cols.length && !flds.length) return null;
    const used = new Map();
    const uniq = (n) => {
      const k = used.get(n) || 0;
      used.set(n, k + 1);
      return k ? `${n}_${k + 1}` : n;
    };
    const header = [];
    for (const c of cols) header.push(uniq(c.col.name));
    for (const f of flds) header.push(uniq(f.name));
    const matrix = [];
    for (const row of S.rows.values()) {
      const vals = cols.map((c) => row.cells[c.path] || '');
      for (const f of flds) vals.push(row.details[f.name] || '');
      matrix.push(vals);
    }
    return { header, matrix, nCols: header.length };
  }

  function exportCsv() {
    const data = csvData();
    if (!data) { setStatus('Nothing to export — collect rows (step 1) and tick at least one column.'); return; }
    const { matrix, nCols } = data;
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [data.header.map(q).join(','), ...matrix.map((r) => r.map(q).join(','))];
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (norm(document.title).replace(/[^\w-]+/g, '_').slice(0, 50) || 'scrape')
      + '_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setStatus(`Exported ${S.rows.size} rows × ${nCols} columns to CSV.`);
  }

  function copyCsv() {
    const data = csvData();
    if (!data) { setStatus('Nothing to copy — collect rows (step 1) and tick at least one column.'); return; }
    // tab-separated: Google Sheets / Excel split it into real cells on paste
    const clean = (v) => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');
    const csv = [data.header, ...data.matrix].map((r) => r.map(clean).join('\t')).join('\n');
    const ok = () => setStatus(`Copied ${S.rows.size} rows × ${data.nCols} columns — paste into Sheets/Excel.`);
    const fail = () => setStatus('Copy blocked by the page — use Export CSV instead.');
    const legacy = () => {
      const ta = document.createElement('textarea');
      ta.value = csv;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      let done = false;
      try { done = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
      done ? ok() : fail();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(csv).then(ok, legacy);
    else legacy();
  }

  // ---------- public api ----------
  const api = {
    toggle() {
      const visible = host.style.display !== 'none';
      if (visible) {
        S.scrolling = false;
        S.detailing = false;
        stopPicker();
        hlRow(null);
        highlight(null);
        host.style.display = 'none';
      } else {
        host.style.display = '';
        rescan();
      }
    },
  };
  window.__tableScraper = api;

  // ---------- init ----------
  buildPanel();
  renderFields();
  rescan();
})();
