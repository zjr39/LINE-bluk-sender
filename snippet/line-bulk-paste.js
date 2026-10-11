/* =====================================================================
   LINE 聯絡人批量助手（批次發送 / 批次貼標籤 / 匯出清單）
   用法：
     1. 到 LINE 官方帳號管理後台的「聯絡人」頁面
     2. 整段貼上後按 Enter
     3. 右下角出現面板；先按「掃描聯絡人」確認名單，再按「只跑第一位」測試
   ===================================================================== */
(() => {
  'use strict';

  const KEY = '__LINE_BULK_PASTE_V1__';
  if (window[KEY]) {
    console.warn('[LINE 批量粘貼] 已經載入過了，先把頁面重新整理再執行一次。');
    return;
  }
  window[KEY] = true;

  // 面板腳本由本機服務提供；若服務沒開，就在頁面上明講（而不是靜默失敗）
  const _f = window.fetch;
  window.fetch = function (u) {
    const url = String(u);
    if (url.indexOf('127.0.0.1:8765') >= 0) {
      return _f.apply(this, arguments).catch((e) => {
        if (!document.getElementById('lbp-down')) {
          const d = document.createElement('div');
          d.id = 'lbp-down';
          d.style.cssText = 'position:fixed;z-index:2147483647;right:16px;top:16px;max-width:360px;' +
            'background:#b71c1c;color:#fff;font:12px/1.6 "Microsoft YaHei",system-ui,sans-serif;' +
            'padding:10px 14px;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.3)';
          d.textContent = '本機服務（127.0.0.1:8765）沒有回應。請在 LINE 資料夾執行 start-server.cmd 後，重新整理並再點一次書籤小工具。';
          document.documentElement.appendChild(d);
          setTimeout(() => d.remove(), 15000);
        }
        throw e;
      });
    }
    return _f.apply(this, arguments);
  };

  const DEFAULT_TEXT = '';

  // 你輸入過的文本會存在瀏覽器裡，下次開啟自動帶回
  const MSG_KEY = 'lbp_message_v1';
  function loadSavedText() {
    try {
      const v = window.localStorage.getItem(MSG_KEY);
      return v === null ? DEFAULT_TEXT : v;
    } catch (e) { return DEFAULT_TEXT; }
  }
  function saveText(t) {
    try { window.localStorage.setItem(MSG_KEY, t); } catch (e) {}
  }

  // 一般用途的設定讀寫
  function loadSaved(key) {
    try { return window.localStorage.getItem(key) || ''; } catch (e) { return ''; }
  }
  function saveSetting(key, v) {
    try { window.localStorage.setItem(key, v || ''); } catch (e) {}
  }

  // 自動傳送的開關也記住（預設開啟）
  const SEND_KEY = 'lbp_autosend_v1';
  function loadAutoSend() {
    try {
      const v = window.localStorage.getItem(SEND_KEY);
      return v === null ? true : v === '1';
    } catch (e) { return true; }
  }
  function saveAutoSend(on) {
    try { window.localStorage.setItem(SEND_KEY, on ? '1' : '0'); } catch (e) {}
  }

  const state = {
    running: false,
    paused: false,
    stop: false,
    rows: [],
    results: [],
    text: loadSavedText(),
    autoSend: loadAutoSend(),
    filterNames: loadSaved('lbp_filter_names'),
    filterInclude: loadSaved('lbp_filter_inc'),
    filterExclude: loadSaved('lbp_filter_exc'),
    tagList: loadSaved('lbp_taglist'),
    tagName: loadSaved('lbp_tagname') || 'VIP',
    friendOnly: loadSaved('lbp_friendonly') !== '0',
    image: null,
    // ---- 禮包碼（每人一組）----
    giftCodes: [],
    giftCodesText: loadSaved('lbp_gift_codes'),
    giftTemplate: loadSaved('lbp_gift_tpl'),   // 預設空白，由使用者自行填寫
    giftPairs: [],          // 鎖定的配對快照 [{ idx, name, code }]
    giftLedger: [],         // 發送帳本 [{ idx, name, code, uid, status, reason, at }]
    intervalMs: 1200,
    pollTimer: null
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const normalize = (s) => (s || '').replace(/[\s\u200b\u200c\u200d\ufeff\u2060]/g, '');
  const textOf = (el) => (el ? (el.textContent || '').trim() : '');
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // 把進度回報到本機收集器（失敗時靜默）
  function beacon(tag, extra) {
    try {
      const body = JSON.stringify(Object.assign({
        at: new Date().toISOString(),
        tag: tag,
        url: location.href,
        total: state.rows.length,
        done: state.results.length,
        success: state.results.filter((r) => r.status === '成功').length,
        failed: state.results.filter((r) => r.status === '失敗').length,
        running: state.running
      }, extra || {}));
      fetch('http://127.0.0.1:8765/result', {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: body
      }).catch(() => {});
    } catch (e) {}
  }

  function record(rec) {
    state.results.push(rec);
    render();
    beacon('item', { item: rec });
  }

  /* ------------------------------ DOM 定位 ------------------------------ */

  function findChatButtons(root) {
    const out = [];
    for (const b of (root || document).querySelectorAll('button')) {
      const t = textOf(b);
      if (t.includes('聊天') && t.length <= 8 && isVisible(b)) out.push(b);
    }
    return out;
  }

  function rowOf(button) {
    let n = button;
    for (let i = 0; i < 10 && n && n.parentElement; i++) {
      n = n.parentElement;
      if (n.matches && n.matches('[class*="contact-chat"]')) return n;
      const r = n.getBoundingClientRect();
      if (r.width > 600 && r.height < 200 && n.querySelector('button')) return n;
    }
    return null;
  }

  // 取出這一列的所有欄位文字（依 DOM 順序）
  // 實測結構： [0]名稱  [1]標籤(如 VIP / 新增標籤)  [2]類型(好友)  [3]負責人員  [4]日期+聊天+詳情
  function cellsOfRow(row) {
    const out = [];
    const all = row.querySelectorAll('*');
    for (const el of all) {
      // 只取葉節點（自己不含其他有文字的元素），避免祖先重複計入
      let hasTextChild = false;
      for (const ch of el.children) {
        if (ch.textContent && ch.textContent.trim()) { hasTextChild = true; break; }
      }
      if (hasTextChild) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (t.length > 60) continue;
      if (out[out.length - 1] === t) continue;   // 去連續重複
      out.push(t);
    }
    return out;
  }

  function nameOfRow(row) {
    const cells = cellsOfRow(row);
    return cells[0] || '(未知)';
  }

  /* ---- 標籤識別：先切欄，再依「身分」歸類（不硬編碼任何標籤值） ---- */

  // 非標籤文字的身分規則。日後遇到新的非標籤文字，只要往這裡加一行。
  const NOT_TAG_RULES = [
    { kind: 'ui',     re: /^(新增標籤|新增标签|加標籤|設定負責人員|設定負責人)$/ },
    { kind: 'status', re: /^(待處理|待处理|處理完畢|处理完毕|已處理|已完成)$/ },
    { kind: 'type',   re: /^(好友|只傳訊的用戶|只传讯的用户|群組|群组|グループ|垃圾訊息|垃圾信息)$/ },
    { kind: 'person', re: /^(tt|admin)$/i },
    { kind: 'date',   re: /^\d{4}\/\d{1,2}\/\d{1,2}/ },
    { kind: 'action', re: /^(聊天|詳情|详情)$/ }
  ];

  function classifyCell(t) {
    for (const r of NOT_TAG_RULES) {
      if (r.re.test(t)) return r.kind;
    }
    return 'tag';
  }

  // 淨化標籤欄文字 → { tags, status, type }；未知的一律保留為標籤
  function parseTagCell(text) {
    const tags = [], stat = [], typ = [];
    for (const raw of String(text || '').split(/[\s,，、]+/)) {
      const t = raw.trim();
      if (!t) continue;
      const kind = classifyCell(t);
      if (kind === 'ui' || kind === 'date' || kind === 'action' || kind === 'person') continue;
      if (kind === 'status') { if (stat.indexOf(t) < 0) stat.push(t); continue; }
      if (kind === 'type') { if (typ.indexOf(t) < 0) typ.push(t); continue; }
      if (tags.indexOf(t) < 0) tags.push(t);
    }
    return { tags: tags, status: stat.join(' '), type: typ.join(' ') };
  }

  // 一次掃描建立「欄位 → 文字」索引（效能關鍵：不可對每列重複走訪 DOM）
  function buildColIndex(row) {
    const objs = [];
    for (const el of row.querySelectorAll('*')) {
      let hasTextChild = false;
      for (const ch of el.children) {
        if (ch.textContent && ch.textContent.trim()) { hasTextChild = true; break; }
      }
      if (hasTextChild) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 60) continue;
      let x = NaN;
      try { x = el.getBoundingClientRect().x; } catch (e) {}
      const prev = objs[objs.length - 1];
      if (prev && prev.text === t) continue;
      const newCol = !!(prev && !isNaN(x) && !isNaN(prev.x) && (x - prev.x) > 100);
      objs.push({ text: t, x: x, newCol: newCol });
    }

    const groups = [];
    let cur = null;
    for (const o of objs) {
      if (!cur || o.newCol) { cur = { texts: [], xs: [] }; groups.push(cur); }
      cur.texts.push(o.text);
      if (!isNaN(o.x)) cur.xs.push(o.x);
    }
    const texts = groups.map((g) => g.texts.join(' '));
    const spans = groups.map((g) => (g.xs.length
      ? { min: Math.min.apply(null, g.xs), max: Math.max.apply(null, g.xs) } : null));

    let tagIdx = -1;
    if (spans.some((s) => s)) {
      const addCtl = findAddTagControl(row);
      if (addCtl) {
        let ax = NaN;
        try { ax = addCtl.getBoundingClientRect().x; } catch (e) {}
        for (let i = 1; i < spans.length; i++) {
          const sp = spans[i];
          if (sp && !isNaN(ax) && ax >= sp.min - 40 && ax <= sp.max + 140) { tagIdx = i; break; }
        }
      }
      if (tagIdx < 0) {
        for (let i = 1; i < texts.length; i++) {
          const kinds = texts[i].split(' ').map(classifyCell);
          if (kinds.indexOf('tag') >= 0) { tagIdx = i; break; }
          if (kinds.indexOf('ui') >= 0) { tagIdx = i; break; }
          if (kinds.indexOf('date') >= 0 || kinds.indexOf('person') >= 0) break;
        }
      }
    }
    return { texts: texts, tagIdx: tagIdx };
  }

  function tagInfoOfRow(row) {
    let idx = null;
    try { idx = buildColIndex(row); } catch (e) { idx = null; }

    if (idx && idx.tagIdx > 0 && idx.texts[idx.tagIdx] !== undefined) {
      const parsed = parseTagCell(idx.texts[idx.tagIdx]);
      for (let i = 1; i < idx.texts.length; i++) {
        if (i === idx.tagIdx) continue;
        const p2 = parseTagCell(idx.texts[i]);
        if (p2.status && !parsed.status) parsed.status = p2.status;
        if (p2.type && !parsed.type) parsed.type = p2.type;
      }
      return parsed;
    }

    const flat = (idx && idx.texts.length) ? idx.texts : cellsOfRow(row);
    const cut = flat.slice(0, 1).concat(flat.slice(1).filter((t) => classifyCell(t) !== 'date'));
    return parseTagCell(cut.join(' '));
  }

  function tagsOfRow(row) {
    return tagInfoOfRow(row).tags.join(' ');
  }

  /* ---- 發圖探測：找出聊天室的圖片上傳管道 ---- */

  function probeImageChannel() {
    const out = { fileInputs: [], imgButtons: [], dropHints: [], contentEditable: [], notes: [] };

    // 1) 所有 file input（LINE 通常有隱藏的 file input 負責上傳）
    for (const el of document.querySelectorAll('input[type="file"]')) {
      out.fileInputs.push({
        accept: el.getAttribute('accept') || '',
        multiple: !!el.multiple,
        hidden: el.offsetParent === null || el.getBoundingClientRect().width === 0,
        cls: (el.className || '').toString().slice(0, 60),
        id: el.id || '',
        name: el.getAttribute('name') || ''
      });
    }

    // 2) 輸入區附近的按鈕（找圖片鈕）
    const composers = [];
    for (const sel of ['textarea-ex', '[placeholder*="傳送"]', '[contenteditable]']) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width > 150 && r.top > window.innerHeight * 0.5) composers.push(el);
      }
    }
    for (const comp of composers) {
      // 往上找整個輸入區容器
      let box = comp;
      for (let i = 0; i < 6 && box && box.parentElement; i++) box = box.parentElement;
      if (!box) continue;
      for (const b of box.querySelectorAll('button, a, [role="button"], i, span[class*="icon"]')) {
        const r = b.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        out.imgButtons.push({
          tag: b.tagName,
          text: (b.textContent || '').trim().slice(0, 12),
          cls: (b.className || '').toString().slice(0, 70),
          title: b.getAttribute('title') || '',
          aria: b.getAttribute('aria-label') || '',
          icon: b.className ? String(b.className).slice(0, 40) : '',
          x: Math.round(r.x), y: Math.round(r.y)
        });
      }
      break;   // 只看第一個輸入區
    }

    // 3) contenteditable 是否可直接吃貼上的圖片
    out.notes.push('若 fileInputs 為空，代表圖片上傳可能綁在按鈕點擊時才動態建立');

    return out;
  }

  function scanRows() {
    const rows = [];
    let idx = 0;
    for (const btn of findChatButtons(document)) {
      const row = rowOf(btn);
      if (!row) continue;
      idx += 1;
      const name = nameOfRow(row);
      let tags = '', status = '', type = '', date = '';
      try { const ti = tagInfoOfRow(row); tags = ti.tags.join(' '); status = ti.status; type = ti.type; } catch (e) {}
      try { date = dateOfRow(row); } catch (e) {}
      rows.push({ idx, name, tags, status, type, date, button: btn, row });
    }
    return rows;
  }

  // 從這一列讀「最近聊天日期」
  function dateOfRow(row) {
    const r = /(\d{4})\/(\d{1,2})\/(\d{1,2})/;
    for (const c of cellsOfRow(row)) {
      const m = c.match(r);
      if (m) return m[1] + '/' + m[2] + '/' + m[3];
    }
    const m = textOf(row).match(r);
    return m ? m[1] + '/' + m[2] + '/' + m[3] : '';
  }

  // 找出這一列「新增標籤 / 標籤」的控件（為批次加標籤做準備）
  // 產生 CSV 並下載（先試 blob 下載；失敗則開新視窗／複製到剪貼板）
  function downloadCsv(filename, header, rows) {
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [header.map(esc).join(',')].concat(rows.map((r) => r.map(esc).join(',')));
    const csv = '\ufeff' + lines.join('\r\n');

    let blobUrl = '';
    try {
      blobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      a.style.display = 'none';
      document.documentElement.appendChild(a);
      a.click();
      setTimeout(() => {
        try { document.documentElement.removeChild(a); } catch (e) {}
        try { URL.revokeObjectURL(blobUrl); } catch (e) {}
      }, 1500);
      return { ok: true, how: 'blob', chars: csv.length };
    } catch (e) {
      // 備援 1：開新視窗（data URI）
      try {
        const w = window.open('data:text/csv;charset=utf-8,' + encodeURIComponent(csv), '_blank');
        if (w) return { ok: true, how: 'window', chars: csv.length };
      } catch (e2) {}
      // 備援 2：複製到剪貼板，讓你手動貼到 Excel
      try {
        const ta = document.createElement('textarea');
        ta.value = csv;
        ta.style.cssText = 'position:fixed;left:-9999px;';
        document.documentElement.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.documentElement.removeChild(ta);
        return { ok: true, how: 'clipboard', chars: csv.length };
      } catch (e3) {}
      return { ok: false, error: e.message, chars: csv.length };
    }
  }

  function stampText() {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  // 匯出「聯絡人名單」：姓名 / 標籤 / 最近聊天日期 / 是否會發送
  function exportContacts() {
    if (!state.rows.length) {
      log('⚠ 名單是空的：請先按「掃描全部（反覆載入）」再匯出。');
      return 0;
    }
    const rows = state.rows.map((r) => [
      r.idx,
      r.name,
      (r.tags || '').trim(),
      (r.type || '').trim(),
      (r.status || '').trim(),
      r.date || (r.row ? dateOfRow(r.row) : ''),
      passesFilter(r) ? '會發送' : '跳過'
    ]);
    const fn = 'LINE聯絡人_' + stampText() + '.csv';
    const res = downloadCsv(
      fn,
      ['#', '聯絡人姓名', '標籤', '類型', '狀態', '最近聊天日期', '依目前篩選'],
      rows
    );
    if (res.ok) {
      log('已匯出 ' + rows.length + ' 位 → ' + fn + '（方式：' + res.how + '，' + res.chars + ' 字元）');
      if (res.how === 'clipboard') log('  ⚠ 無法自動下載，內容已複製到剪貼板，請貼到 Excel。');
      const kinds = {};
      for (const r of state.rows) {
        for (const t of String(r.tags || '').split(/\s+/)) { if (t) kinds[t] = (kinds[t] || 0) + 1; }
      }
      const klist = Object.keys(kinds).sort((a, b) => kinds[b] - kinds[a]);
      log('  讀到的標籤種類：' + (klist.length ? klist.map((k) => k + '(' + kinds[k] + ')').join('、') : '（無）'));
      if (klist.length > 12) log('  ⚠ 標籤種類偏多，請確認是否有非標籤文字被讀進來');
      const colStats = {};
      for (const r of state.rows.slice(0, 10)) {
        try {
          const g = buildColIndex(r.row);
          const key = '欄數' + g.texts.length + '/標籤欄#' + g.tagIdx;
          colStats[key] = (colStats[key] || 0) + 1;
        } catch (e) {}
      }
      log('  欄位切割（前 10 列）：' +
          (Object.keys(colStats).map((k) => k + '×' + colStats[k]).join('，') || '無法判定'));
      const st = {}, ty = {};
      for (const r of state.rows) {
        if (r.status) st[r.status] = (st[r.status] || 0) + 1;
        if (r.type) ty[r.type] = (ty[r.type] || 0) + 1;
      }
      log('  狀態分布：' + (Object.keys(st).map((k) => k + '(' + st[k] + ')').join('、') || '（無）'));
      log('  類型分布：' + (Object.keys(ty).map((k) => k + '(' + ty[k] + ')').join('、') || '（無）'));
    } else {
      log('✗ 匯出失敗：' + (res.error || '未知錯誤'));
    }
    return rows.length;
  }

  // 匯出「批次執行結果」
  function exportResults() {
    if (!state.results.length) {
      log('⚠ 還沒有批次結果可匯出（請先跑一次批次）。');
      return 0;
    }
    const rows = state.results.map((r) => [r.idx, r.name, r.status, r.reason]);
    const fn = 'LINE發送結果_' + stampText() + '.csv';
    const res = downloadCsv(fn, ['#', '聯絡人', '狀態', '原因'], rows);
    if (res.ok) {
      log('已匯出批次結果 ' + rows.length + ' 筆 → ' + fn + '（方式：' + res.how + '）');
    } else {
      log('✗ 匯出失敗：' + (res.error || '未知錯誤'));
    }
    return rows.length;
  }

  /* ---------------------- 禮包碼（每人一組） ---------------------- */

  // 一行一個。保留前導零與字母，一律當字串處理（絕不轉數字）。
  function parseCodes(text) {
    return String(text || '')
      .split(/[\r\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // 回傳重複出現的碼（同一碼給兩人 = 資料錯誤）
  function findDuplicateCodes(codes) {
    const seen = {};
    const dup = [];
    for (const c of (codes || [])) {
      if (seen[c]) { if (dup.indexOf(c) < 0) dup.push(c); }
      seen[c] = true;
    }
    return dup;
  }

  // 產生配對表：名單由上往下，依序取碼。
  // rows 需為 [{ idx, name }]；碼不足時後面的人不配對。
  function buildGiftPairs(codes, rows) {
    const list = codes || [];
    const people = rows || [];
    const pairs = [];
    const unpaired = [];
    const limit = Math.min(list.length, people.length);
    for (let i = 0; i < limit; i++) {
      pairs.push({ idx: people[i].idx, name: people[i].name, code: list[i] });
    }
    for (let i = limit; i < people.length; i++) {
      unpaired.push({ idx: people[i].idx, name: people[i].name });
    }
    const unused = list.slice(limit);
    return { pairs: pairs, unpaired: unpaired, unused: unused };
  }

  // 把碼套進模板；沒有 {CODE} 佔位符就接在結尾
  function renderGiftMessage(tpl, code) {
    const t = String(tpl == null ? '' : tpl);
    const c = String(code == null ? '' : code);
    if (t.indexOf('{CODE}') >= 0) return t.split('{CODE}').join(c);
    return t ? (t + c) : c;
  }

  // 解析 UID 對照表：支援 CSV / TSV / 空白分隔，自動判斷哪一欄是 UID
  // 回傳 { map: {名稱: UID}, rows: [[名稱, UID]...], skipped: n }
  // 禮包碼帳本持久化（崩潰／重新整理後可續跑）
  const GIFT_KEY = 'lbp_gift_state_v1';

  function saveGiftState() {
    try {
      window.localStorage.setItem(GIFT_KEY, JSON.stringify({
        at: new Date().toISOString(),
        template: state.giftTemplate,
        pairs: state.giftPairs,
        ledger: state.giftLedger
      }));
    } catch (e) {}
  }

  function loadGiftState() {
    try {
      const raw = window.localStorage.getItem(GIFT_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || !Array.isArray(o.pairs)) return null;
      return o;
    } catch (e) {
      return null;
    }
  }

  function clearGiftState() {
    try { window.localStorage.removeItem(GIFT_KEY); } catch (e) {}
  }

  // 帳本裡已成功處理過的名稱（續跑時跳過）
  function giftDoneNames(ledger) {
    const done = {};
    for (const r of (ledger || [])) {
      if (r && r.status === '成功') done[r.name] = true;
    }
    return done;
  }

  // 匯出最終對照表：禮包碼 / LINE名稱 / UID / 時間 / 狀態
  function exportGiftReport() {
    const ledger = state.giftLedger || [];
    if (!ledger.length) {
      log('⚠ 還沒有發送記錄可匯出。');
      return 0;
    }
    const rows = ledger.map((r) => [
      r.code || '',
      r.name || '',
      (r.uid || ''),            // UID 欄位保留但留空，供你事後自行填寫
      r.at || '',
      r.status || '',
      r.reason || ''
    ]);
    const okN = ledger.filter((r) => r.status === '成功').length;
    const ngN = ledger.filter((r) => r.status === '失敗').length;
    rows.push([]);
    rows.push(['統計', '成功 ' + okN, '失敗 ' + ngN, '共 ' + ledger.length, '', '']);
    const fn = '禮包碼對照表_' + stampText() + '.csv';
    const res = downloadCsv(fn, ['禮包碼', 'LINE名稱', 'UID', '發送時間', '狀態', '失敗原因'], rows);
    if (res.ok) {
      log('已匯出對照表：' + ledger.length + ' 筆 → ' + fn + '（成功 ' + okN + ' / 失敗 ' + ngN + '）');
    } else {
      log('✗ 匯出失敗：' + (res.error || '未知錯誤'));
    }
    return rows.length;
  }

  /* ------------------------------ 篩選 ------------------------------ */

  // "a|b|c" → ['a','b','c']（支援半形、全形逗號與頓號）
  function splitTerms(s) {
    return (s || '').split(/[|,，、]/).map((x) => x.trim()).filter(Boolean);
  }

  // 受限類型：LINE 的「只傳訊的用戶」無法接收主動訊息，
  // 即使掛了 VIP 標籤也不能發送（官方帳號無法對其發起聊天）。
  const RESTRICTED_TYPES = ['只傳訊的用戶', '只传讯的用户'];

  function isRestricted(entry) {
    const t = String(entry && entry.type ? entry.type : '');
    if (!t) return false;
    for (const r of RESTRICTED_TYPES) {
      if (t.indexOf(r) >= 0) return true;
    }
    return false;
  }

  // 關鍵字比對範圍：名稱 + 標籤 + 類型（類型可被關鍵字命中，但受限者一律排除）
  // 在指定欄位中比對關鍵字（任一命中即算通過）
  function matchesIn(fields, terms) {
    if (!terms.length) return false;
    const hay = fields.map((s) => String(s || '')).join(' ').toLowerCase();
    for (const t of terms) {
      if (hay.indexOf(t.toLowerCase()) >= 0) return true;
    }
    return false;
  }

  // 「只發給」只比對標籤與類型（名稱改由下面的名稱清單負責）
  function matchesAny(entry, terms) {
    return matchesIn([entry.tags, entry.type], terms);
  }

  // 名稱清單：一行一個（也支援逗號／頓號）。用「精確比對」避免部分命中 —
  // 例：清單有 s1.abc 時，s1.abcdef 不該被選中。
  function parseNameList(text) {
    if (text == null) return [];
    return String(text)
      .split(/[\r\n,，、]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function matchesNames(entry, names) {
    const mine = String(entry && entry.name ? entry.name : '').trim();
    if (!mine) return false;
    for (const n of names) {
      if (mine === n) return true;
    }
    return false;
  }

  // 名稱清單比對：只比對 LINE 名稱
  function matchesName(entry, terms) {
    return matchesIn([entry.name], terms);
  }

  function passesFilter(entry) {
    // 規則 1（強制）：只傳訊的用戶不發，即使有 VIP
    if (isRestricted(entry)) return false;
    // 規則 2：只發給「好友」＋有標籤者（可在下方開關關閉）
    if (state.friendOnly) {
      if (String(entry.type || '').indexOf('好友') < 0) return false;
      if (!String(entry.tags || '').trim()) return false;
    }
    // 規則 3：名稱清單（填了＝只發給名單內的人，精確比對整串名稱）
    const names = parseNameList(state.filterNames);
    if (names.length && !matchesNames(entry, names)) return false;
    // 規則 4：標籤／類型白名單與黑名單
    const inc = splitTerms(state.filterInclude);
    const exc = splitTerms(state.filterExclude);
    if (inc.length && !matchesAny(entry, inc)) return false;   // 白名單：必須命中
    // 黑名單：命中即排除（名稱、標籤、類型都算，方便直接排除某個人）
    if (exc.length && (matchesAny(entry, exc) || matchesName(entry, exc))) return false;
    return true;
  }

  function applyFilter(rows) {
    return rows.filter(passesFilter);
  }

  /* --------------------- 自動捲動載入整份清單 --------------------- */
  /* ---------------------------- 批次加標籤 ---------------------------- */


  function parseTagList(text) {
    return String(text || '')
      .split(/[\r\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // 標籤名稱可一次填多個，用 , ， 、 | 分隔（例：繁體,英語）
  function parseTagNames(text) {
    return String(text || '')
      .split(/[|,，、]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((t, i, a) => a.indexOf(t) === i);
  }

  // 找出「新增標籤」控件（標籤欄裡可點的那個）
  // 找出「新增標籤」控件：必須取最內層可點元素（<A>），
  // 不能取外層容器（否則點到空白處，完全沒反應）
  function findAddTagControl(row) {
    // 快速路徑：直接找 class 帶 btn / text-info 的連結（實測「新增標籤」是 <A class="btn px-0 text-info">）
    // 只在這一列的子樹中找，成本 O(k)，不像逐元素掃描那樣 O(n²)
    for (const sel of ['a.btn', 'button.btn', 'a[class*="text-info"]', '[class*="tag"] a', '[class*="tag"] button']) {
      let list = [];
      try { list = row.querySelectorAll(sel); } catch (e) { continue; }
      for (const el of list) {
        const t = textOf(el);
        if (!t || t.length > 30) continue;
        if (!/新增標籤|新增标签|加標籤/.test(t)) continue;
        let r;
        try { r = el.getBoundingClientRect(); } catch (e) { continue; }
        if (r.width > 0 && r.height > 0) return el;
      }
    }
    // 慢速路徑（版面不同時的備援）
    let best = null;
    let bestArea = Infinity;
    for (const el of row.querySelectorAll('*')) {
      const t = textOf(el);
      if (!t || t.length > 30) continue;
      if (!/新增標籤|新增标签|加標籤/.test(t)) continue;
      let r;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.width > 200) continue;                 // 太寬＝容器，跳過
      const isClickable = (el.tagName === 'A' || el.tagName === 'BUTTON' ||
                           el.getAttribute('role') === 'button' ||
                           (el.className || '').toString().indexOf('btn') >= 0);
      const area = r.width * r.height;
      if (isClickable) {
        if (area < bestArea) { bestArea = area; best = el; }
      } else if (!best && area < bestArea) {
        bestArea = area; best = el;
      }
    }
    return best;
  }

  function findByText(re, scope) {
    const root = scope || document;
    for (const el of root.querySelectorAll('button, a, [role="button"]')) {
      const t = textOf(el);
      if (!t || t.length > 20) continue;
      if (re.test(t)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return el;
      }
    }
    return null;
  }

  function tagRegex(tag) {
    // 標籤名稱可能是多個（用 , ， 、 | 分隔）；驗證以第一個為準
    const first = (typeof parseTagNames === 'function' ? parseTagNames(tag)[0] : '') || String(tag || '').trim();
    return new RegExp('(^|[\\s,，])' + first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[\\s,，])', 'i');
  }

  // 取標籤編輯彈窗（實測 class 含 pc-chat-tag-edit-modal）
  function tagDialog() {
    for (const sel of ['[class*="pc-chat-tag-edit-modal"]', '[class*="tag-edit-modal"]']) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // 取彈窗內的標籤輸入框（實測 placeholder = 輸入標籤）
  function tagDialogInput(dlg) {
    const scope = dlg || document;
    let el = scope.querySelector('input[placeholder="輸入標籤"]');
    if (el) return el;
    // 退而求其次：彈窗內第一個可見的 text input
    for (const i of scope.querySelectorAll('input[type="text"], input:not([type])')) {
      const r = i.getBoundingClientRect();
      if (r.width > 60 && r.height > 10) return i;
    }
    return null;
  }

  function tagDialogSaveButton(dlg) {
    const scope = dlg || document;
    for (const b of scope.querySelectorAll('button, [role="button"], a')) {
      const t = textOf(b).trim();
      if (/^(儲存|存储|存儲|保存|确定|確定|確認|OK|Save)$/i.test(t)) {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return b;
      }
    }
    return null;
  }

  async function waitFor(fn, timeoutMs, step) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeoutMs || 4000)) {
      let v = null;
      try { v = fn(); } catch (e) {}
      if (v) return v;
      await sleep(step || 150);
    }
    return null;
  }

  // 為單一聯絡人加上標籤（照實測流程：新增標籤 → 輸入 → Enter → 儲存）
  async function addTagToRow(entry, tag) {
    const steps = [];
    const findRow = () => scanRows().find((r) => r.name === entry.name) || null;

    let target = findRow();
    if (!target) {
      const c2 = findScrollContainer();
      for (let i = 0; i < 40 && !target && c2; i++) {
        c2.scrollTop = Math.min(c2.scrollHeight, c2.scrollTop + Math.max(400, c2.clientHeight * 0.9));
        c2.dispatchEvent(new Event('scroll', { bubbles: true }));
        await sleep(350);
        target = findRow();
      }
    }
    if (!target) return { ok: false, steps, reason: '清單中找不到這位聯絡人' };

    if (tagRegex(tag).test(target.tags || '')) {
      return { ok: true, steps: ['已有標籤，跳過'], reason: '' };
    }

    target.row.scrollIntoView({ block: 'center' });
    await sleep(150);

    // 保險：若上一位留下未關閉的彈窗，先關掉
    let stale = tagDialog();
    if (stale) {
      const cancel = findByText(/^(取消|關閉|关闭|Cancel)$/i);
      if (cancel) { cancel.click(); await sleep(400); }
      if (tagDialog()) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); await sleep(400); }
    }

    const add = findAddTagControl(target.row);
    if (!add) return { ok: false, steps, reason: '找不到「新增標籤」控件' };
    add.click();
    steps.push('點新增標籤');

    const dlg = await waitFor(() => tagDialog(), 4000);
    if (!dlg) return { ok: false, steps, reason: '標籤彈窗沒出現（等 4 秒）' };
    steps.push('彈窗已出現');

    const input = await waitFor(() => tagDialogInput(tagDialog()), 3000);
    if (!input) return { ok: false, steps, reason: '彈窗內找不到輸入框' };
    // 逐一輸入每個標籤（支援一次加多個）
    const tagNames = parseTagNames(tag);
    if (!tagNames.length) return { ok: false, steps, reason: '標籤名稱是空的' };
    const kopt = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    for (let ti = 0; ti < tagNames.length; ti++) {
      const one = tagNames[ti];
      const inp = (ti === 0) ? input : await waitFor(() => tagDialogInput(tagDialog()), 2500);
      if (!inp) { steps.push('第 ' + (ti + 1) + ' 個標籤找不到輸入框'); break; }
      inp.focus();
      inp.value = one;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      steps.push('輸入 ' + one);
      await sleep(300);
      inp.dispatchEvent(new KeyboardEvent('keydown', kopt));
      inp.dispatchEvent(new KeyboardEvent('keypress', kopt));
      inp.dispatchEvent(new KeyboardEvent('keyup', kopt));
      steps.push('按 Enter');
      await sleep(500);
    }

    const save = await waitFor(() => tagDialogSaveButton(tagDialog()), 3000);
    if (!save) return { ok: false, steps, reason: '找不到「儲存」按鈕' };
    save.click();
    steps.push('點儲存');

    const closed = await waitFor(() => (tagDialog() ? null : true), 4000);
    if (!closed) {
      // 嘗試補救：再點一次儲存或按 Esc
      const s2 = tagDialogSaveButton(tagDialog());
      if (s2) { s2.click(); await sleep(600); }
      if (tagDialog()) return { ok: false, steps, reason: '儲存後彈窗仍未關閉' };
    }
    steps.push('彈窗已關閉');
    await sleep(400);

    // 驗證：彈窗已關閉代表 UI 已接受儲存；再盡力回讀確認標籤確實寫入。
    // 用多種方式回讀（結構化標籤欄 / 整列文字），避免版面微調造成誤判。
    let rowSeen = false;
    let rowTextSawTag = false;
    for (let i = 0; i < 8; i++) {
      const after = findRow();
      if (after) {
        rowSeen = true;
        if (tagRegex(tag).test(after.tags || '')) {
          steps.push('已確認標籤存在');
          return { ok: true, steps, reason: '' };
        }
        // 退一步：整列文字含這個標籤，也算寫入成功
        try {
          const rt = textOf(after.row);
          if (rt && rt.indexOf(tag) >= 0) {
            rowTextSawTag = true;
            steps.push('已確認（由列文字比對）');
            return { ok: true, steps, reason: '' };
          }
        } catch (e) {}
      }
      await sleep(300);
    }

    if (!rowSeen) {
      // 列不在目前渲染範圍（虛擬清單卸載），無法回讀；彈窗已關閉視為成功
      steps.push('列已卸載，無法回讀（彈窗已關閉，視為成功）');
      return { ok: true, steps, reason: '已儲存但無法回讀確認' };
    }
    if (rowTextSawTag) {
      steps.push('已確認（列文字）');
      return { ok: true, steps, reason: '' };
    }
    return { ok: false, steps, reason: '儲存後仍未讀到標籤（該列有找到，但標籤欄讀不到）' };
  }

  async function runTagBatch(names, tag) {
    if (state.running) return;
    state.running = true;
    state.stop = false;
    state.results = [];
    render();

    const available = scanRows().map((r) => r.name);
    const missing = names.filter((n) => available.indexOf(n) < 0);
    log('開始加標籤：' + names.length + ' 位，標籤「' + tag + '」');

    for (let i = 0; i < names.length; i++) {
      if (state.stop) break;
      const name = names[i];
      log('[' + (i + 1) + '/' + names.length + '] ' + name);
      let rec;
      try {
        const r = await addTagToRow({ idx: i + 1, name: name }, tag);
        rec = {
          idx: i + 1, name: name,
          status: r.ok ? '成功' : '失敗',
          reason: r.reason ? r.reason : ('已加標籤（' + r.steps.join(' → ') + '）')
        };
      } catch (err) {
        rec = { idx: i + 1, name: name, status: '失敗', reason: (err && err.message) || String(err) };
      }
      record(rec);
      if (rec.status === '失敗') log('   ✗ ' + rec.reason);
      await sleep(250);
    }

    state.running = false;
    const ok = state.results.filter((r) => r.status === '成功').length;
    log('加標籤結束：成功 ' + ok + ' / 失敗 ' + (state.results.length - ok));
    if (missing.length) log('⚠ 有 ' + missing.length + ' 位目前找不到：' + missing.slice(0, 5).join('、'));
    beacon('tagdone', {
      total: names.length, ok: ok, fail: state.results.length - ok, missing: missing.slice(0, 30)
    });
    render();
  }


  // 找出「聯絡人清單」的可捲動容器：
  // 只考慮畫面左側（聯絡人清單在左半邊），避免誤選右側的聊天訊息區
  function findScrollContainer() {
    let best = null;
    let bestRange = 0;
    const limitX = window.innerWidth * 0.6;
    for (const el of document.querySelectorAll('div, main, section, ul, table')) {
      const rect = el.getBoundingClientRect();
      if (rect.left > limitX || rect.width < 300) continue;   // 不在左半邊就跳過
      const canScroll =
        el.scrollHeight - el.clientHeight > 40 &&
        el.clientHeight > 200;
      if (!canScroll) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue;
      const range = el.scrollHeight - el.clientHeight;
      if (range > bestRange) { bestRange = range; best = el; }
    }
    return best;
  }

  function uniqueNames() {
    const seen = {};
    let n = 0;
    for (const r of scanRows()) {
      if (!seen[r.name]) { seen[r.name] = true; n++; }
    }
    return n;
  }

  // 反覆掃描直到名單不再成長
  // 實測發現：這個頁面每次「重新查詢」才會多載入一批（20 位），捲動本身不會觸發。
  // 所以做法是「掃描 → 等 → 再掃描」，累積去重，直到連續數輪不再增加。
  async function scanUntilStable(opts) {
    const maxPasses = (opts && opts.maxPasses) || 2;    // 總輪數上限（預設就只跑 2 輪）
    const pauseMs = (opts && opts.pauseMs) || 3000;
    const patience = (opts && opts.patience) || 1;      // 連續幾輪沒新增就提前停

    const collected = new Map();
    const trace = [];
    const t0 = Date.now();
    const maxMs = (opts && opts.maxMs) || 8 * 60 * 1000;   // 總時間上限，避免跑太久

    function harvest() {
      for (const r of scanRows()) {
        if (!collected.has(r.name)) collected.set(r.name, { idx: collected.size + 1, name: r.name, tags: r.tags, status: r.status, type: r.type, date: r.date });
      }
    }

    let stable = 0;
    let passes = 0;

    for (let i = 0; i < maxPasses; i++) {
      if (Date.now() - t0 > maxMs) { log('  （已達時間上限，停止載入）'); break; }
      passes = i + 1;
      const before = collected.size;

      // 每一輪都做一次完整捲動（同時也能觸發部分 lazy-load）
      await scrollLoadAll({ maxRounds: 40, settle: 400 });
      harvest();

      const after = collected.size;
      trace.push({ pass: passes, before: before, after: after });
      log('  第 ' + passes + ' 輪：' + before + ' → ' + after + ' 位');

      if (after > before) {
        stable = 0;
      } else {
        stable++;
        if (stable >= patience) break;   // 連續數輪都沒新增 → 完成
      }
      await sleep(pauseMs);              // 等待下一批載入
    }

    return { ok: true, passes: passes, collected: [...collected.values()], names: collected.size, trace: trace };
  }

  // 反覆捲到底，並在過程中累積名單
  // 注意：清單是「虛擬化」的 —— 捲回頂端後下方列會被卸載，
  // 所以必須邊捲邊收集，不能等捲完才數。
  async function scrollLoadAll(opts) {
    const maxRounds = (opts && opts.maxRounds) || 120;
    const settle = (opts && opts.settle) || 700;
    const container = findScrollContainer();
    if (!container) return { ok: false, reason: '找不到可捲動的清單容器', rounds: 0, collected: [], trace: [] };

    const collected = new Map();   // name -> { idx, name }
    const trace = [];

    // 暖機：剛載入頁面時，清單容器的高度還沒長出來（scrollHeight 偏小），
    // 此時「已到底」會誤判，導致只收到第一段就結束。
    // 先反覆試捲，直到 scrollHeight 連續兩次不再變化。
    let warmStable = 0;
    let warmRounds = 0;
    let lastH = -1;
    const warmStart = Date.now();
    while (warmStable < 2 && warmRounds < 20 && Date.now() - warmStart < 6000) {
      warmRounds++;
      const h = container.scrollHeight;
      if (h === lastH) { warmStable++; } else { warmStable = 0; lastH = h; }
      container.scrollTop = Math.min(h, container.scrollTop + Math.max(300, container.clientHeight));
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(300);
    }
    container.scrollTop = 0;
    container.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(400);
    const heightAfterWarmup = container.scrollHeight;

    function harvest() {
      for (const r of scanRows()) {
        if (!collected.has(r.name)) collected.set(r.name, { idx: collected.size + 1, name: r.name, tags: r.tags, status: r.status, type: r.type, date: r.date });
      }
    }

    harvest();   // 先收目前渲染中的

    let stuck = 0;
    let rounds = 0;
    let lastTop = -1;
    let everScrolled = false;

    for (let i = 0; i < maxRounds; i++) {
      rounds = i + 1;
      const beforeCount = collected.size;
      const beforeTop = container.scrollTop;

      // 逐步往下捲（一次跳到底對虛擬清單常常無效）
      const step = Math.max(300, Math.floor(container.clientHeight * 1.5));
      container.scrollTop = Math.min(container.scrollHeight, container.scrollTop + step);
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(settle);
      harvest();

      const top = container.scrollTop;
      const maxTop = container.scrollHeight - container.clientHeight;
      const atBottom = top >= maxTop - 8;
      if (Math.abs(top - beforeTop) > 1) everScrolled = true;

      trace.push({ r: rounds, top: top, scrollH: container.scrollHeight, clientH: container.clientHeight, names: collected.size, atBottom: atBottom });
      if (trace.length > 12) trace.shift();

      // 只有「已經到底」且連續幾輪都沒有新名字，才真的結束
      if (atBottom && collected.size === beforeCount) {
        stuck++;
        if (stuck >= 3) break;
      } else {
        stuck = 0;
      }

      // 位置完全沒動、也沒新名字 → 可能捲錯容器
      if (top === lastTop && collected.size === beforeCount) {
        stuck++;
        if (stuck >= 4) break;
      }
      lastTop = top;
    }

    // 捲回頂端（名單已在手上，不怕卸載）
    container.scrollTop = 0;
    container.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(400);

    const last = trace[trace.length - 1] || {};
    return {
      ok: true,
      rounds: rounds,
      warmRounds: warmRounds,
      heightAfterWarmup: heightAfterWarmup,
      reachedBottom: !!last.atBottom,
      everScrolled: everScrolled,
      collected: [...collected.values()],
      names: collected.size,
      trace: trace
    };
  }

  function collectDocs() {
    const docs = [document];
    const walk = (d) => {
      let frames = [];
      try { frames = Array.from(d.querySelectorAll('iframe, frame')); } catch (e) {}
      for (const f of frames) {
        try {
          const cd = f.contentDocument;
          if (cd && docs.indexOf(cd) < 0) { docs.push(cd); walk(cd); }
        } catch (e) { /* cross-origin */ }
      }
    };
    walk(document);
    return docs;
  }

  function isComposerCandidate(el) {
    if (!el) return false;
    const ph = (el.getAttribute && (el.getAttribute('placeholder') || el.getAttribute('data-placeholder'))) || '';
    if (ph.indexOf('傳送') >= 0 || ph.indexOf('Enter') >= 0) return true;
    const al = (el.getAttribute && el.getAttribute('aria-label')) || '';
    if (al.indexOf('訊息') >= 0 || al.indexOf('メッセージ') >= 0) return true;
    return false;
  }

  // 先找 placeholder 命中者；找不到就退回右下角最大塊的可編輯元素
  function findComposer() {
    const docs = collectDocs();
    const sels = [
      'textarea-ex', '[placeholder*="傳送"]', '[data-placeholder*="傳送"]',
      '[placeholder*="Enter"]', '[contenteditable]', 'textarea',
      '[role="textbox"]', '[data-placeholder]'
    ];
    let fallback = null;
    let bestArea = 0;
    for (const d of docs) {
      for (const sel of sels) {
        let list = [];
        try { list = Array.from(d.querySelectorAll(sel)); } catch (e) { continue; }
        for (const el of list) {
          if (isComposerCandidate(el)) return el;
          const r = el.getBoundingClientRect();
          const area = r.width * r.height;
          if (r.width > 150 && r.height > 18 && r.x > window.innerWidth * 0.45 && area > bestArea) {
            bestArea = area;
            fallback = el;
          }
        }
      }
    }
    return fallback;
  }

  // 真正的可寫入目標：自訂元素通常把 textarea 藏在 shadow root 裡
  function editorTarget(el) {
    if (!el) return null;
    if (el.shadowRoot) {
      const inner = el.shadowRoot.querySelector('textarea, [contenteditable]');
      if (inner) return inner;
    }
    if (el.tagName === 'TEXTAREA-EX') {
      const inner = el.querySelector('textarea, [contenteditable]');
      if (inner) return inner;
    }
    return el;
  }

  function describeEditors() {
    const docs = collectDocs();
    const out = [];
    for (let i = 0; i < docs.length; i++) {
      let list = [];
      try {
        list = Array.from(docs[i].querySelectorAll(
          '[contenteditable], textarea, textarea-ex, [role="textbox"], [data-placeholder], [placeholder], input'
        ));
      } catch (e) {}
      for (const el of list) {
        const r = el.getBoundingClientRect();
        let inner = '';
        if (el.shadowRoot) {
          const t = el.shadowRoot.querySelector('textarea, [contenteditable]');
          if (t) inner = t.tagName + '(shadow)';
        }
        out.push({
          doc: i,
          tag: el.tagName,
          inner: inner,
          ce: el.getAttribute ? String(el.getAttribute('contenteditable')) : '',
          ph: (el.getAttribute && (el.getAttribute('placeholder') || el.getAttribute('data-placeholder'))) || '',
          cls: (el.className || '').toString().slice(0, 40),
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height)
        });
      }
    }
    return { docs: docs.length, vw: window.innerWidth, vh: window.innerHeight, editors: out };
  }

  const composerText = (el) => {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return el.innerText !== undefined ? el.innerText : (el.textContent || '');
  };

  // 以原生 setter 寫入並派發 input 事件（讓框架的狀態同步）
  function setNativeValue(el, text) {
    let proto = null;
    if (el.tagName === 'TEXTAREA') proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    else if (el.tagName === 'INPUT') proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
    if (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) {
        desc.set.call(el, text);
        return true;
      }
    }
    el.value = text;
    return true;
  }

  function dispatchInput(el, text) {
    try { el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); } catch (e) {}
    try { el.dispatchEvent(new Event('change', { bubbles: true, composed: true })); } catch (e) {}
  }

  function dispatchPaste(el, text) {
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      return true;
    } catch (e) {
      return false;
    }
  }

  async function insertText(el, text) {
    el.focus();
    await sleep(60);

    const isField = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';

    if (isField) {
      // 原生表單欄位：先用原生 setter + input 事件
      setNativeValue(el, text);
      dispatchInput(el, text);
      await sleep(150);
      if (normalize(composerText(el)).length > 0) return;
      // 備援：全選後以 insertText 取代
      try { el.select(); document.execCommand('insertText', false, text); } catch (e) {}
      await sleep(150);
      if (normalize(composerText(el)).length > 0) return;
      // 最後備援：paste 事件
      dispatchPaste(el, text);
      await sleep(180);
      return;
    }

    // contenteditable 路徑
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.addRange(range);
      document.execCommand('delete', false, null);
    } catch (e) {}
    await sleep(40);
    try {
      document.execCommand('insertText', false, text);
    } catch (e) {}
    await sleep(140);
    if (!normalize(composerText(el)).includes(normalize(text).slice(0, 40))) {
      dispatchPaste(el, text);
      await sleep(180);
    }
  }

  /* ------------------------------ 主流程 ------------------------------ */

  async function openChat(entry) {
    // 清單是虛擬化的：先找到目標列（不存在就先捲動讓它掛載），再點它的「聊天」
    let target = null;
    for (let attempt = 0; attempt < 3 && !target; attempt++) {
      const rows = scanRows();
      target = rows.find((r) => r.name === entry.name) || null;
      if (!target) {
        // 目標不在目前渲染範圍：反覆往清單底部捲，直到它出現
        const c = findScrollContainer();
        if (!c) break;
        c.scrollTop = Math.min(c.scrollHeight, c.scrollTop + Math.max(400, c.clientHeight * 0.9));
        c.dispatchEvent(new Event('scroll', { bubbles: true }));
        await sleep(500);
      }
    }
    if (!target) throw new Error('在清單中找不到「' + entry.name + '」（可能未載入或名稱變動）');

    target.button.scrollIntoView({ block: 'center' });
    await sleep(120);

    // scrollIntoView 可能讓該列重新掛載，重新取一次按鈕
    let btn = target.button;
    if (!document.contains(btn)) {
      const again = scanRows().find((r) => r.name === entry.name);
      if (again) btn = again.button;
    }
    btn.click();
    await sleep(state.intervalMs * 0.6);

    // 等「目前開啟的列」變成目標；確認後才允許粘貼，避免貼錯人
    const t0 = Date.now();
    let seen = '';
    while (Date.now() - t0 < 4000) {
      const cur = currentOpenName();
      if (cur) {
        seen = cur;
        if (cur === entry.name) return;
      }
      await sleep(150);
    }
    throw new Error('無法確認已開啟「' + entry.name + '」' + (seen ? '（目前為「' + seen + '」）' : '（未偵測到開啟中的聊天）'));
  }

  // 目前 UI 上被標記為開啟中的那一列名稱（LINE 會在該列加上 contact-chat-selected）
  function currentOpenName() {
    const sel = document.querySelector('[class*="contact-chat-selected"]');
    if (!sel) return '';
    const t = textOf(sel);
    // 該列的 innerText 會串上其他欄位，取最長的已知列名作為前綴比對依據
    const hit = state.rows.find((r) => r.name && t.indexOf(r.name) === 0);
    return hit ? hit.name : t.split('\n')[0].trim();
  }

  async function waitComposer(timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeoutMs || 6000)) {
      const h = findComposer();
      if (h) return h;
      await sleep(200);
    }
    return null;
  }

  // 找出「傳送」按鈕：必須是帶文字「傳送」的小按鈕（排除「升級聊天管理功能」等長字串）
  function findSendButton() {
    const limitY = window.innerHeight * 0.5;   // 傳送鈕在畫面下半部
    let best = null;
    for (const b of document.querySelectorAll('button, [role="button"], a')) {
      const t = textOf(b).replace(/[\s\u200b-\u200d\ufeff]/g, '');
      if (t !== '傳送' && t !== '发送' && t !== '送信') continue;
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.y < limitY) continue;
      if (r.x < window.innerWidth * 0.5) continue;   // 輸入區在右半邊
      if (!best || r.y > best.r.y) best = { el: b, r: r };   // 取最下方那個
    }
    return best ? best.el : null;
  }

  async function composerEmpty(composer) {
    return normalize(composerText(composer)).length === 0;
  }

  /* ---------------------- 發圖（批次） ---------------------- */

  const IMG_KEY = 'lbp_image_v1';

  // 取得目前選定的圖片：{ file, url, name, size, type }
  function getImage() {
    if (state.image && state.image.file) return state.image;
    return null;
  }

  // 把 File 轉成 dataURL 以便跨頁面保存
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('讀取檔案失敗'));
      fr.readAsDataURL(file);
    });
  }

  function dataUrlToFile(dataUrl, name, type) {
    const parts = String(dataUrl).split(',');
    const bin = atob(parts[1] || '');
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name || 'image.png', { type: type || 'image/png' });
  }

  // 若 file input 尚未存在（點過圖片鈕才建立），先點一下圖片鈕把它生出來
  function ensureImageFileInput() {
    const fi = findImageFileInput();
    if (fi) return fi;
    const btn = findImageButton();
    if (!btn) return null;
    try { btn.click(); } catch (e) { return null; }
    return null;   // 建立是同步的，呼叫端再查一次
  }

  // 找出輸入區附近「可能是圖片/附件」的按鈕。
  // 注意：不可往上找到整頁（實測輸入框抓不到時會往上爬到 body，抓到 168 個無關按鈕）。
  function findImageButton() {
    const composer = findComposer();
    const container = composer && composer.parentElement ? composer.parentElement.parentElement : null;
    if (!container) return null;
    const want = /image|photo|圖片|图片|照片|写真|画像|attach|附件|ファイル|上傳|上传/i;
    for (const b of container.querySelectorAll('button, a, [role="button"], input')) {
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const hay = ((b.className || '') + ' ' + (b.getAttribute('title') || '') + ' ' +
                   (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).toString();
      if (want.test(hay)) return b;
    }
    return null;
  }


  // 找出 LINE 聊天室負責上傳圖片的 file input
  function findImageFileInput() {
    let best = null;
    for (const el of document.querySelectorAll('input[type="file"]')) {
      const acc = String(el.getAttribute('accept') || '');
      const isImg = acc.indexOf('image') >= 0 || acc === '';
      if (!isImg) continue;
      // 優先取 accept 明確含 image 的
      if (acc.indexOf('image') >= 0) return el;
      if (!best) best = el;
    }
    return best;
  }

  // 把圖片設定到 file input（框架才會收到變更）
  function setInputFile(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 送出：等傳送鈕可用後點它（圖片送出通常靠這顆）
  async function sendAttached(composer) {
    // 等輸入框清空（有些流程貼上即送出）
    for (let i = 0; i < 12; i++) {
      await sleep(400);
      if (composer && !composerText(composer).trim()) {
        // 可能已送出，但圖片預覽仍在，繼續等傳送鈕
      }
      const btn = findSendButton();
      if (btn) {
        const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
        if (!disabled) {
          btn.click();
          await sleep(900);
          return { ok: true, how: 'sendButton' };
        }
      }
    }
    // 備援：Enter
    if (composer) {
      const opt = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
      composer.dispatchEvent(new KeyboardEvent('keydown', opt));
      composer.dispatchEvent(new KeyboardEvent('keyup', opt));
      await sleep(900);
      return { ok: true, how: 'enter' };
    }
    return { ok: false, how: 'none' };
  }

  /* 實測：LINE 選圖後會跳「確定要傳送檔案至此聊天室嗎」確認彈窗，
     按「傳送」才會真的送出 —— 也就是圖片無法只附加不送出。
     因此這裡會自動處理該彈窗。 */

  // 找出確認彈窗裡的「傳送」按鈕
  function findConfirmSendButton() {
    let best = null;
    let bestZ = -1;
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      const t = textOf(el).replace(/[\s\u200b-\u200d\ufeff]/g, '');
      if (t !== '傳送' && t !== '传送' && t !== '確定' && t !== '确定' && t !== 'OK') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      // 取 z-index 最高者（彈窗通常在覆蓋層）
      let z = 0, n = el;
      for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
        const zz = parseInt(getComputedStyle(n).zIndex, 10);
        if (!isNaN(zz) && zz > z) z = zz;
      }
      if (z > bestZ) { bestZ = z; best = el; }
    }
    return best;
  }

  // 設定檔案到 file input
  function applyImageToInput(image) {
    let input = findImageFileInput();
    if (!input) { ensureImageFileInput(); input = findImageFileInput(); }
    if (!input) return { ok: false, reason: '找不到上傳用的 file input' };
    try {
      setInputFile(input, image.file);
    } catch (e) {
      return { ok: false, reason: '設定檔案失敗：' + e.message };
    }
    return { ok: true };
  }

  // 送出圖片：設定檔案 → 處理確認彈窗 → 等預覽出現
  async function sendImage(image) {
    const steps = [];
    const a = applyImageToInput(image);
    if (!a.ok) return { ok: false, steps, reason: a.reason };
    steps.push('已設定檔案');

    // 等確認彈窗（或直接開始上傳）
    let confirmed = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      await sleep(300);
      const btn = findConfirmSendButton();
      if (btn) {
        steps.push('出現確認彈窗');
        try { btn.click(); } catch (e) {}
        confirmed = true;
        steps.push('已按「傳送」');
        break;
      }
    }
    if (!confirmed) steps.push('未出現確認彈窗（直接上傳）');

    // 等送出完成：輸入框清空 或 出現預覽後又消失 或 傳送鈕消失
    let sent = false;
    const t1 = Date.now();
    while (Date.now() - t1 < 25000) {
      await sleep(500);
      const stillConfirm = findConfirmSendButton();
      if (stillConfirm) {
        try { stillConfirm.click(); } catch (e) {}
        continue;
      }
      const composer = editorTarget(findComposer());
      const empty = composer ? !composerText(composer).trim() : true;
      const pending = document.querySelectorAll('img[src^="blob:"]').length > 0;
      if (empty && !pending) { sent = true; break; }
    }
    steps.push(sent ? '已送出' : '送出狀態未知（請人工確認）');
    return { ok: true, sent: sent, steps: steps, reason: sent ? '' : '未能確認送出結果' };
  }

  // 向後相容：舊名稱
  async function attachImageToComposer(image) { return sendImage(image); }



  // 批次發圖
  async function runImageBatch(entries) {
    if (state.running) return;
    const image = getImage();
    if (!image) { log('⚠ 還沒選圖片，請先按「選擇圖片」'); return; }

    state.running = true;
    state.paused = false;
    state.stop = false;
    state.results = [];
    render();
    log('開始批次發圖：' + entries.length + ' 位（圖片：' + image.name + '）');

    for (const entry of entries) {
      if (state.stop) break;
      while (state.paused && !state.stop) await sleep(300);
      if (state.stop) break;
      log('[' + entry.idx + '] 發圖給 ' + entry.name);
      let rec;
      try {
        await openChat(entry);
        const holder = await waitComposer(7000);
        if (!holder) throw new Error('找不到輸入框（聊天室未載入？）');
        const r = await attachImageToComposer(state.image);
        rec = {
          idx: entry.idx, name: entry.name,
          status: r.ok ? '成功' : '失敗',
          reason: r.ok ? ((r.sent === false ? '已附加未送出（' : '已發圖（') + r.steps.join(' → ') + '）') : r.reason
        };
      } catch (err) {
        rec = { idx: entry.idx, name: entry.name, status: '失敗', reason: (err && err.message) || String(err) };
      }
      record(rec);
      if (rec.status === '失敗') log('   ✗ ' + rec.reason);
      await sleep(state.intervalMs * 0.5);
    }

    state.running = false;
    const ok = state.results.filter((r) => r.status === '成功').length;
    log('發圖結束：成功 ' + ok + ' / 失敗 ' + (state.results.length - ok));
    beacon('imgdone', { total: entries.length, ok: ok, fail: state.results.length - ok });
    render();
  }

  // 送出訊息：實測發現「點傳送鈕」不被接受、Enter 鍵事件才有效，所以 Enter 為主、點鈕為備援
  async function sendMessage(composer) {
    const opts = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true
    };
    try { composer.dispatchEvent(new KeyboardEvent('keydown', opts)); } catch (e) {}
    try { composer.dispatchEvent(new KeyboardEvent('keypress', opts)); } catch (e) {}
    try { composer.dispatchEvent(new KeyboardEvent('keyup', opts)); } catch (e) {}
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      await sleep(200);
      if (await composerEmpty(composer)) return { ok: true, how: 'enter' };
    }

    // 備援：點「傳送」按鈕
    const btn = findSendButton();
    if (btn) {
      try { btn.click(); } catch (e) {}
      const t1 = Date.now();
      while (Date.now() - t1 < 2500) {
        await sleep(200);
        if (await composerEmpty(composer)) return { ok: true, how: 'clickButton' };
      }
    }
    return { ok: false, how: btn ? 'enter+clickButton' : 'enter' };
  }

  async function processOne(entry) {
    const rec = { idx: entry.idx, name: entry.name, status: '待處理', reason: '' };
    try {
      await openChat(entry);
      const holder = await waitComposer(7000);
      if (!holder) throw new Error('找不到輸入框（等 7 秒仍未出現）');
      const composer = editorTarget(holder);
      await insertText(composer, state.text);
      await sleep(260);
      const got = normalize(composerText(composer));
      const want = normalize(state.text);
      if (!got.includes(want.slice(0, 30))) {
        rec.status = '失敗';
        rec.reason = '粘貼未生效（讀回輸入框為空或不相符）';
        return rec;
      }

      // 只有確認粘貼成功才送出，避免送出空訊息或殘留內容
      if (state.autoSend) {
        const s = await sendMessage(composer);
        if (s.ok) {
          rec.status = '成功';
          rec.reason = '已粘貼並送出（' + s.how + '）';
        } else {
          rec.status = '失敗';
          rec.reason = '已粘貼但送出失敗（輸入框仍有內容，請手動確認）';
        }
        return rec;
      }

      rec.status = '成功';
      rec.reason = '已粘貼，未發送';
      return rec;
    } catch (err) {
      rec.status = '失敗';
      rec.reason = (err && err.message) || String(err);
      return rec;
    }
  }

  async function runBatch(entries) {
    if (state.running) return;
    state.running = true;
    state.paused = false;
    state.stop = false;
    state.results = [];
    render();
    for (const entry of entries) {
      if (state.stop) break;
      while (state.paused && !state.stop) await sleep(300);
      if (state.stop) break;
      log('處理 #' + entry.idx + ' ' + entry.name);
      const rec = await processOne(entry);
      record(rec);
      if (rec.status === '失敗') log('   ✗ ' + rec.reason);
      await sleep(state.intervalMs * 0.3);
    }
    state.running = false;
    const ok = state.results.filter((r) => r.status === '成功').length;
    const ng = state.results.filter((r) => r.status === '失敗').length;
    log('結束：成功 ' + ok + ' / 失敗 ' + ng);
    render();
    beacon('done');
    console.table(state.results);
  }

  /* ---------------------- 禮包碼批次發送 ---------------------- */

  // 對單一對象發送他的禮包碼
  async function sendGiftTo(entry) {
    const rec = {
      idx: entry.idx, name: entry.name, code: entry.code,
      uid: '',
      status: '', reason: '', at: ''
    };
    try {
      if (!entry.code) throw new Error('這位沒有配對到禮包碼');
      await openChat(entry);                         // 內含「貼對人」防護，不符會丟錯
      const holder = await waitComposer(7000);
      if (!holder) throw new Error('找不到輸入框（聊天室未載入？）');
      const composer = editorTarget(holder);

      const msg = renderGiftMessage(state.giftTemplate, entry.code);
      await insertText(composer, msg);
      await sleep(260);

      const got = normalize(composerText(composer));
      // 驗證：輸入框內容必須含「這一位的」禮包碼
      if (got.indexOf(normalize(entry.code)) < 0) {
        throw new Error('輸入框未出現該禮包碼（讀回不符）');
      }

      if (state.autoSend) {
        const s = await sendMessage(composer);
        if (!s.ok) throw new Error('已填入但送出失敗（輸入框仍有內容）');
        rec.status = '成功';
        rec.reason = '已發送（' + s.how + '）';
      } else {
        rec.status = '成功';
        rec.reason = '已填入，未送出（自動傳送已關閉）';
      }
      rec.at = new Date().toLocaleString();
      return rec;
    } catch (err) {
      rec.status = '失敗';
      rec.reason = (err && err.message) || String(err);
      rec.at = new Date().toLocaleString();
      return rec;
    }
  }

  // 批次發送禮包碼。onlyPending=true 時只處理帳本中未成功的（續跑）
  async function runGiftBatch(onlyPending) {
    if (state.running) return;
    const pairs = state.giftPairs || [];
    if (!pairs.length) { log('⚠ 還沒有配對表，請先按「預覽配對」'); return; }

    const done = giftDoneNames(state.giftLedger);
    const queue = pairs.filter((p) => !(onlyPending && done[p.name]));
    if (!queue.length) { log('✅ 沒有待處理的對象（全部已完成）'); return; }

    state.running = true;
    state.paused = false;
    state.stop = false;
    render();
    log((onlyPending ? '續跑' : '開始發送禮包碼') + '：' + queue.length + ' 位' +
        (state.autoSend ? '（會自動送出）' : '（只填入，不送出）'));

    for (let i = 0; i < queue.length; i++) {
      if (state.stop) break;
      while (state.paused && !state.stop) await sleep(300);
      if (state.stop) break;
      const p = queue[i];
      log('[' + (i + 1) + '/' + queue.length + '] ' + p.name + ' → ' + p.code);
      const rec = await sendGiftTo(p);

      // 寫入帳本（同一位只留最新一筆）
      const at = state.giftLedger.findIndex((r) => r.name === p.name);
      if (at >= 0) state.giftLedger[at] = rec; else state.giftLedger.push(rec);
      saveGiftState();                    // 每筆立刻持久化 → 可續跑
      record(rec);
      if (rec.status === '失敗') log('   ✗ ' + rec.reason);
      await sleep(state.intervalMs * 0.3);
    }

    state.running = false;
    const ok = state.giftLedger.filter((r) => r.status === '成功').length;
    const ng = state.giftLedger.filter((r) => r.status === '失敗').length;
    log('結束：帳本累計 成功 ' + ok + ' / 失敗 ' + ng + '（共 ' + state.giftLedger.length + ' 筆）');
    log('→ 可按「匯出對照表 CSV」取得 禮包碼 / LINE名稱 / UID');
    render();
    beacon('giftdone', { total: state.giftLedger.length, ok: ok, fail: ng });
    console.table(state.giftLedger);
  }

  /* ------------------------------ 介面 ------------------------------ */

  let logEl, statsEl, tableEl;

  function log(msg) {
    const line = document.createElement('div');
    line.textContent = new Date().toLocaleTimeString() + '  ' + msg;
    if (logEl) {
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    }
    console.log('[LINE 批量粘貼] ' + msg);
  }

  function render() {
    if (!statsEl) return;
    const s = state.results.filter((r) => r.status === '成功').length;
    const f = state.results.filter((r) => r.status === '失敗').length;
    statsEl.textContent =
      '聯絡人 ' + state.rows.length + ' 位 ｜ 已處理 ' + state.results.length +
      ' ｜ 成功 ' + s + ' ｜ 失敗 ' + f + (state.running ? ' ｜ 執行中' : '');
    tableEl.innerHTML = '';
    for (const r of state.results) {
      const tr = document.createElement('tr');
      for (const v of [r.idx, r.name, r.status, r.reason]) {
        const td = document.createElement('td');
        td.textContent = v;
        td.style.cssText = 'padding:2px 6px;border-bottom:1px solid #eee;font-size:11px;';
        tr.appendChild(td);
      }
      tableEl.appendChild(tr);
    }
  }

  function buildPanel() {
    if (document.getElementById('lbp-host')) return;
    const host = document.createElement('div');
    host.id = 'lbp-host';
    host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;top:16px;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .panel{width:520px;max-height:82vh;display:flex;flex-direction:column;font:12px/1.5 "Microsoft YaHei",system-ui,sans-serif;color:#111;background:#fff;border:1px solid #cfd8dc;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);overflow:hidden}
        .hd button{cursor:pointer}
        .drag{display:inline-block;width:12px;text-align:center;cursor:nwse-resize;opacity:.85;font-size:12px}
        .bd{min-height:0}
        textarea{display:block;min-height:44px;overflow:auto;resize:none}
        .log{min-height:50px;overflow:auto;flex:0 0 auto}
        .grip{height:9px;margin:1px 0 3px;border-radius:4px;background:repeating-linear-gradient(90deg,#cfd8dc 0 6px,transparent 6px 12px);cursor:ns-resize;flex:0 0 auto}
        .grip:hover{background:repeating-linear-gradient(90deg,#06c755 0 6px,transparent 6px 12px)}
        .hd{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#06c755;color:#fff;font-weight:700}
        .hd button{all:unset;cursor:pointer;padding:0 6px;font-size:14px}
        .note{padding:6px 10px;background:#fff8e1;color:#8d6e00;font-size:11px;border-bottom:1px solid #f0e6c8}
        .bd{padding:8px 10px;display:flex;flex-direction:column;gap:8px;overflow:auto}
        textarea{width:100%;box-sizing:border-box;height:96px;resize:vertical;font:11px/1.5 "Microsoft YaHei",monospace;padding:6px;border:1px solid #cfd8dc;border-radius:6px}
        .row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
        .row button{all:unset;cursor:pointer;padding:5px 10px;border-radius:6px;background:#eceff1;border:1px solid #cfd8dc}
        .row button.p{background:#06c755;color:#fff;border-color:#06c755;font-weight:700}
        .row button.d{background:#ffebee;border-color:#ffcdd2;color:#b71c1c}
        .row input[type=number]{width:62px;padding:4px;border:1px solid #cfd8dc;border-radius:6px}
        .stats{font-size:11px;color:#37474f}
        .log{height:110px;overflow:auto;background:#fafafa;border:1px solid #eee;border-radius:6px;padding:4px 6px;font-size:11px;color:#455a64}
        .tbl{max-height:190px;overflow:auto;border:1px solid #eee;border-radius:6px}
        table{width:100%;border-collapse:collapse}
        th{text-align:left;font-size:11px;color:#607d8b;padding:2px 6px;border-bottom:1px solid #cfd8dc;background:#fff}
        label{display:flex;gap:4px;align-items:center}
      </style>
      <div class="panel">
        <div class="hd"><span>LINE 聯絡人批量助手</span><span><span class="drag" id="drag" title="拖我調整面板大小">◢</span><button id="hide" title="收合">—</button><button id="kill" title="關閉面板">✕</button></span></div>
        <div class="note">預設<b>粘貼後自動傳送</b>（送出後無法收回）。要改成只粘不送，請取消勾選下方的「粘貼後自動傳送」。</div>
        <div class="bd">
          <textarea id="txt" spellcheck="false"></textarea>
          <div class="row">
            <button id="scan">掃描聯絡人</button>
            <button id="scanall">掃描全部（反覆載入）</button>
            <button id="start" class="p">開始全部</button>
            <button id="pause">暫停</button>
            <button id="stop" class="d">停止</button>
            <button id="dbg">檢查輸入框</button>
            <button id="imgprobe">發圖探測</button>
          </div>
          <div class="row">
            <label>從 <input type="number" id="from" min="1" value="1"></label>
            <label>到 <input type="number" id="to" min="1" value="0"></label>
            <label>間隔(ms) <input type="number" id="interval" min="300" step="100" value="1200"></label>
            <label>掃描輪數 <input type="number" id="passes" min="1" max="60" step="1" value="2" title="反覆載入清單的總輪數；清單越長需要越多輪"></label>
            <label style="font-weight:700;color:#b71c1c"><input type="checkbox" id="autosend" checked> 粘貼後自動傳送</label>
            <button id="export">匯出結果 CSV</button>
          </div>
          <div class="row" style="background:#e3f2fd;border:1px solid #bbdefb;border-radius:6px;padding:6px">
            <b style="color:#0d47a1">批次發圖</b>
            <input type="file" id="imgfile" accept="image/*" style="display:none">
            <button id="imgpick">選擇圖片</button>
            <img id="imgprev" alt="" style="display:none;max-height:46px;max-width:120px;border:1px solid #90caf9;border-radius:4px">
            <span id="imginfo" style="font-size:11px;color:#0d47a1">尚未選擇圖片</span>
            <button id="imgclear">清除</button>
            <button id="imgtest">試送一張</button>
            <button id="imgsend" class="p" style="background:#1565c0;border-color:#1565c0">批次發圖</button>
            <span style="font-size:11px;color:#0d47a1">選一張圖，對名單逐位發送（LINE 會跳確認彈窗，本工具自動按傳送）</span>
          </div>
          <div class="row" style="background:#f3e5f5;border:1px solid #e1bee7;border-radius:6px;padding:6px;flex-direction:column;align-items:stretch">
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              <b style="color:#6a1b9a">🎁 批次禮包碼</b>
              <span style="font-size:11px;color:#6a1b9a">模板用 {CODE} 代表禮包碼；沒有 {CODE} 就接在結尾</span>
            </div>
            <div style="font-size:11px;color:#6a1b9a">訊息模板（每位都一樣，{CODE} 會換成各自的禮包碼）</div>
            <textarea id="gifttpl" spellcheck="false" placeholder="在這裡輸入訊息內容，用 {CODE} 代表每個人的禮包碼&#10;例：這是我們的一週年禮包碼：{CODE}"></textarea>
            <div style="font-size:11px;color:#6a1b9a">禮包碼（一行一個，依名單由上往下一一對應）</div>
            <textarea id="giftcodes" spellcheck="false" placeholder="VIP1STPWZ1V7HM9&#10;VIP1STPWZ1VLNQJ&#10;…"></textarea>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              <span id="giftinfo" style="font-size:11px;color:#6a1b9a">尚未貼上禮包碼</span>
            </div>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              <button id="giftpreview">預覽配對</button>
              <button id="gifttest">試發前 3 位</button>
              <button id="giftrun" class="p" style="background:#6a1b9a;border-color:#6a1b9a">開始發送</button>
              <button id="giftresume">續跑未完成</button>
              <button id="giftreport">匯出對照表 CSV</button>
              <button id="giftclearbook">清除帳本</button>
            </div>
            <div style="font-size:11px;color:#6a1b9a">配對＝名單（依篩選）由上往下 ↔ 禮包碼由上往下。<b>是否送出由上面的「粘貼後自動傳送」決定。</b></div>
          </div>
          <div class="row" style="background:#fff8e1;border:1px solid #f0e6c8;border-radius:6px;padding:6px">
            <b style="color:#8d6e00">篩選</b>
            <label>只發給（標籤/類型含）<input type="text" id="finc" placeholder="例：VIP 或 繁體,英語" style="width:150px"></label>
            <label>排除（含）<input type="text" id="fexc" placeholder="例：測試|黑名單" style="width:130px"></label>
            <label style="font-weight:700;color:#b71c1c"><input type="checkbox" id="friendonly" checked> 只發好友＋有標籤</label>
            <button id="fpreview">預覽名單</button>
            <button id="expcontacts">匯出聯絡人 CSV</button>
            <span style="font-size:11px;color:#8d6e00">多個關鍵字用 , 分隔（滿足任一）；留空＝不篩選</span>
            <div style="width:100%;font-size:11px;color:#8d6e00;margin-top:2px">
              只發給下列 LINE 名稱（一行一個，留空＝不限制名稱）
            </div>
            <textarea id="fnames" spellcheck="false" style="height:70px" placeholder="一行一個 LINE 名稱&#10;Alice&#10;Bob"></textarea>
          </div>
          <div class="row" style="background:#e8f5e9;border:1px solid #c8e6c9;border-radius:6px;padding:6px;flex-direction:column;align-items:stretch">
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              <b style="color:#1b5e20">批次加標籤</b>
              <label>標籤名稱 <input type="text" id="tagname" value="VIP" placeholder="可用 , 分隔多個" style="width:120px" title="可一次加多個標籤，例如：繁體,英語"></label>
              <button id="tagpreview">預覽符合</button>
              <button id="tagrun" class="p" style="background:#2e7d32;border-color:#2e7d32">開始加標籤</button>
            </div>
            <textarea id="taglist" spellcheck="false" style="height:70px;font:11px monospace" placeholder="一行一個聯絡人名稱（依這份名單加標籤）"></textarea>
            <div style="font-size:11px;color:#1b5e20">流程：點「新增標籤」→ 輸入標籤 → Enter → 點「儲存」，逐位處理。標籤名稱可用 <b>,</b> 分隔一次加多個（例：繁體,英語）。已有第一個標籤者會自動跳過。</div>
          </div>
          <div class="stats" id="stats"></div>
          <div class="tbl"><table>
            <thead><tr><th>#</th><th>聯絡人</th><th>狀態</th><th>原因</th></tr></thead>
            <tbody id="body"></tbody></table></div>
          <div class="log" id="log"></div>
        </div>
      </div>`;
    document.documentElement.appendChild(host);

    const $ = (id) => root.getElementById(id);
    logEl = $('log');
    statsEl = $('stats');
    tableEl = $('body');
    $('txt').value = state.text;
    const cb = $('autosend');
    if (cb) cb.checked = !!state.autoSend;
    if ($('finc')) $('finc').value = state.filterInclude || '';
    if ($('fexc')) $('fexc').value = state.filterExclude || '';
    if ($('fnames')) $('fnames').value = state.filterNames || '';
    if ($('fnames')) $('fnames').addEventListener('input', (e) => {
      state.filterNames = e.target.value;
      saveSetting('lbp_filter_names', state.filterNames);
    });
    if ($('finc')) $('finc').addEventListener('input', (e) => {
      state.filterInclude = e.target.value;
      saveSetting('lbp_filter_inc', state.filterInclude);
    });
    const fo = $('friendonly');
    if (fo) {
      fo.checked = !!state.friendOnly;
      fo.addEventListener('change', (e) => {
        state.friendOnly = !!e.target.checked;
        saveSetting('lbp_friendonly', state.friendOnly ? '1' : '0');
        log(state.friendOnly ? '已開啟：只發好友＋有標籤' : '已關閉：不限制類型');
      });
    }
    if ($('fexc')) $('fexc').addEventListener('input', (e) => {
      state.filterExclude = e.target.value;
      saveSetting('lbp_filter_exc', state.filterExclude);
    });
    if ($('fpreview')) $('fpreview').addEventListener('click', () => {
      if (!state.rows.length) state.rows = scanRows();
      const keep = applyFilter(state.rows);
      const drop = state.rows.length - keep.length;
      log('── 篩選結果 ──');
      log('清單 ' + state.rows.length + ' 位 → 會發送 ' + keep.length + ' 位（排除 ' + drop + ' 位）');
      if (state.filterInclude) log('  只發給含：' + splitTerms(state.filterInclude).join(' / '));
      if (state.filterExclude) log('  排除含：' + splitTerms(state.filterExclude).join(' / '));
      log('  會發送的對象（前 10）：' + keep.slice(0, 10).map((r) => r.name).join('、'));
      const dropped = state.rows.filter((r) => !passesFilter(r));
      if (drop) {
        log('  被排除的（前 10）：' + dropped.slice(0, 10)
              .map((r) => r.name + '[' + (r.tags || '無標籤') + ']').join('、'));
      }
      // 讓你用眼睛核對：直接列出前 20 列的「名稱 + 讀到的標籤」
      log('── 核對用：前 20 列讀到的標籤 ──');
      for (const r of state.rows.slice(0, 20)) {
        log('  ' + r.name + ' → 標籤「' + (r.tags || '（空）') + '」' +
            (passesFilter(r) ? '  ✅會發' : '  ⛔跳過'));
      }
      beacon('filterpreview', {
        total: state.rows.length, keep: keep.length, drop: drop,
        include: state.filterInclude, exclude: state.filterExclude,
        sample: keep.slice(0, 20).map((r) => ({ name: r.name, tags: r.tags })),
        dropped: dropped.slice(0, 20).map((r) => ({ name: r.name, tags: r.tags })),
        allKept: keep.map((r) => ({ name: r.name, tags: r.tags }))
      });
      render();
    });

    // 為某個框加上下方拖曳把手（自製，不受 max-height 限制）
    function attachGrip(el, key, minH, maxH) {
      if (!el || !el.parentNode) return null;
      const saved = parseInt(loadSaved(key), 10);
      el.style.height = Math.min(maxH, Math.max(minH, saved > 0 ? saved : el.getBoundingClientRect().height || 60)) + 'px';
      el.style.overflow = 'auto';

      const grip = document.createElement('div');
      grip.className = 'grip';
      grip.title = '拖我調整這個框的高度';
      el.parentNode.insertBefore(grip, el.nextSibling);

      grip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const h0 = el.getBoundingClientRect().height;
        const y0 = e.clientY;
        const move = (ev) => {
          const h = Math.max(minH, Math.min(maxH, h0 + (ev.clientY - y0)));
          el.style.height = h + 'px';
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          saveSetting(key, String(Math.round(el.getBoundingClientRect().height)));
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
      return grip;
    }

    // 面板右下角把手：拖曳調整整個面板大小
    (function () {
      const panel = root.querySelector('.panel');
      const grip = $('drag');
      if (!panel || !grip) return;
      const sw = parseInt(loadSaved('lbp_panel_w'), 10);
      const sh = parseInt(loadSaved('lbp_panel_h'), 10);
      if (sw > 300) panel.style.width = sw + 'px';
      if (sh > 300) panel.style.height = sh + 'px';
      grip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const r0 = panel.getBoundingClientRect();
        const sx = e.clientX, sy = e.clientY;
        const move = (ev) => {
          const w = Math.max(340, Math.min(window.innerWidth - 40, r0.width + (ev.clientX - sx)));
          const h = Math.max(260, Math.min(window.innerHeight - 40, r0.height + (ev.clientY - sy)));
          panel.style.width = w + 'px';
          panel.style.height = h + 'px';
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          saveSetting('lbp_panel_w', String(Math.round(panel.getBoundingClientRect().width)));
          saveSetting('lbp_panel_h', String(Math.round(panel.getBoundingClientRect().height)));
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    })();

    if ($('hide')) $('hide').addEventListener('click', () => {
      const bd = root.querySelector('.bd');
      const note = root.querySelector('.note');
      const hide = bd.style.display !== 'none';
      bd.style.display = hide ? 'none' : 'flex';
      note.style.display = hide ? 'none' : 'block';
      $('hide').textContent = hide ? '+' : '—';
    });
    if ($('kill')) $('kill').addEventListener('click', () => {
      try { window[KEY] = false; } catch (e) {}
      host.remove();
      console.log('[LINE 批量粘貼] 面板已關閉；再點一次書籤小工具即可重新開啟。');
    });
    if ($('txt')) $('txt').addEventListener('input', (e) => {
      state.text = e.target.value;
      saveText(state.text);        // 記住你貼上的內容，下次開啟自動帶回
    });
    if ($('autosend')) $('autosend').addEventListener('change', (e) => {
      state.autoSend = !!e.target.checked;
      saveAutoSend(state.autoSend);
      log(state.autoSend ? '已開啟：粘貼後自動傳送' : '已關閉：只粘貼，不傳送');
    });
    if ($('interval')) $('interval').addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      if (v >= 300) state.intervalMs = v;
    });
    if ($('scan')) $('scan').addEventListener('click', () => {
      state.rows = scanRows();
      state.results = [];
      log('掃描到 ' + state.rows.length + ' 位聯絡人（依目前排序）');
      log('前 5 位：' + state.rows.slice(0, 5).map((r) => r.name).join(' / '));
      log('後 3 位：' + state.rows.slice(-3).map((r) => r.name).join(' / '));
      log('⚠ 清單是邊捲動邊載入的：請把左側清單捲到最底部，再按一次「掃描聯絡人」，' +
          '確認最後一位就是你看到的最後一位，否則會漏掉後面的聯絡人。');
      $('to').value = String(state.rows.length);
      render();
      beacon('scan', { names: state.rows.map((r) => r.name) });
    });
    if ($('scanall')) $('scanall').addEventListener('click', async () => {
      if (state.running) return log('批次進行中，請先停止');
      const passes = Math.max(1, parseInt($('passes').value, 10) || 2);
      log('反覆掃描載入清單中…（總共 ' + passes + ' 輪，請不要動滑鼠）');
      const before = uniqueNames();
      const r = await scanUntilStable({ maxPasses: passes });
      state.rows = r.collected;
      state.results = [];
      log('共 ' + r.passes + ' 輪：可見 ' + before + ' → 收集到 ' + r.names + ' 位');
      log('前 3 位：' + state.rows.slice(0, 3).map((x) => x.name).join(' / '));
      log('後 3 位：' + state.rows.slice(-3).map((x) => x.name).join(' / '));
      $('to').value = String(state.rows.length);
      render();
      beacon('scrollloaded', {
        before: before,
        after: r.names,
        rounds: r.passes,
        reachedBottom: true,
        everScrolled: true,
        trace: r.trace,
        names: state.rows.map((x) => x.name)
      });
    });

    if ($('start')) $('start').addEventListener('click', async () => {
      if (state.running) return log('批次進行中，請先停止');
      const from = parseInt($('from').value, 10) || 1;

      // 直接沿用現有清單（按過「掃描全部」就用它的完整名單），不再自動載入，
      // 避免在你已經載好之後又白等好幾輪。
      if (!state.rows.length) {
        state.rows = scanRows();
        log('（尚未掃描過，先抓目前畫面上的 ' + state.rows.length + ' 位）');
      } else {
        log('沿用現有清單：' + state.rows.length + ' 位');
        if (state.rows.length <= 25) {
          log('⚠ 這份清單只有 ' + state.rows.length + ' 位；若其實更長，' +
              '請先按「掃描全部（反覆載入）」再開始，否則會漏掉後面的聯絡人。');
        }
      }
      if (!state.rows.length) return log('沒有掃到聯絡人，請確認在聯絡人頁面');
      // 同名聯絡人會讓「是否貼對人」的判斷失效，先提醒使用者
      const seen = {};
      const dups = [];
      for (const r of state.rows) {
        if (seen[r.name]) { if (dups.indexOf(r.name) < 0) dups.push(r.name); }
        seen[r.name] = true;
      }
      if (dups.length) {
        log('⚠ 有 ' + dups.length + ' 組同名聯絡人，無法保證貼對人，建議先取消勾選或自行處理：');
        log('   ' + dups.slice(0, 5).join(' / '));
      }
      let to = parseInt($('to').value, 10) || state.rows.length;
      if (to <= 0 || to > state.rows.length) to = state.rows.length;
      const inRange = state.rows.filter((r) => r.idx >= from && r.idx <= to);
      const kept = applyFilter(inRange);                       // 套用篩選
      const entries = kept.map((r) => ({ idx: r.idx, name: r.name, tags: r.tags }));
      if (inRange.length !== entries.length) {
        log('篩選：' + inRange.length + ' 位 → 實際發送 ' + entries.length +
            ' 位（排除 ' + (inRange.length - entries.length) + ' 位）');
      }
      if (!entries.length) return log('⚠ 篩選後沒有任何人符合，已中止（請調整篩選條件）');
      log('批次 ' + from + '–' + to + '，共 ' + entries.length + ' 位');
      runBatch(entries);
    });
    if ($('pause')) $('pause').addEventListener('click', () => {
      state.paused = !state.paused;
      $('pause').textContent = state.paused ? '繼續' : '暫停';
      log(state.paused ? '已暫停' : '繼續');
    });
    if ($('stop')) $('stop').addEventListener('click', () => {
      state.stop = true;
      state.paused = false;
      log('已要求停止');
    });
    // 排錯用：列出目前找得到的輸入框，以及名單/標籤的讀取狀況
    if ($('dbg')) $('dbg').addEventListener('click', () => {
      try {
        const info = describeEditors();
        log('── 排錯資訊 ──');
        log('  頁面上的輸入框候選：' + info.editors.length + ' 個');
        for (const e of info.editors.slice(0, 6)) {
          log('    <' + e.tag + '> ph="' + e.ph + '" @' + e.x + ',' + e.y);
        }
        const c2 = findComposer();
        log(c2 ? ('  已找到訊息輸入框：<' + c2.tagName + '>') : '  ⚠ 找不到訊息輸入框（請先點一位聯絡人的「聊天」）');
        const g = tagDialog();
        log(g ? '  ⚠ 目前有未關閉的標籤彈窗（可能影響後續操作）' : '  標籤彈窗：無殘留');
        beacon('debug', { editors: info.editors.length, picked: !!c2, dialogOpen: !!g });
      } catch (err) {
        log('✗ 排錯時發生錯誤：' + ((err && err.message) || err));
      }
    });

    if ($('export')) $('export').addEventListener('click', () => {
      exportResults();
    });
    if ($('expcontacts')) $('expcontacts').addEventListener('click', () => {
      try {
        if (!state.rows.length) {
          log('名單是空的，先抓目前畫面上的列…（建議先按「掃描全部」）');
          state.rows = scanRows();
        }
        log('準備匯出 ' + state.rows.length + ' 位…');
        const n = exportContacts();
        if (n) {
          beacon('csvexport', {
            count: n,
            sample: state.rows.slice(0, 15).map((r) => ({ name: r.name, tags: r.tags, date: r.date }))
          });
        }
      } catch (err) {
        log('✗ 匯出時發生錯誤：' + ((err && err.message) || err));
        console.error('[LINE 批量粘貼] 匯出錯誤', err);
      }
    });

    // ---- 批次加標籤 ----
    if ($('taglist')) $('taglist').value = state.tagList || '';
    if ($('taglist')) $('taglist').addEventListener('input', (e) => {
      state.tagList = e.target.value;
      saveSetting('lbp_taglist', state.tagList);
    });
    $('tagname').value = state.tagName || 'VIP';
    if ($('tagname')) $('tagname').addEventListener('input', (e) => {
      state.tagName = e.target.value;
      saveSetting('lbp_tagname', state.tagName);
    });

    // ---- 加標籤預覽 / 開始加標籤 ----
    if ($('tagpreview')) $('tagpreview').addEventListener('click', () => {
      try {
        state.rows = scanRows();
        const names = parseTagList($('taglist').value);
        const have = state.rows.map((r) => r.name);
        const hit = names.filter((n) => have.indexOf(n) >= 0);
        const miss = names.filter((n) => have.indexOf(n) < 0);
        const tag = ($('tagname').value || 'VIP').trim();
        const already = state.rows.filter((r) =>
          names.indexOf(r.name) >= 0 && tagRegex(tag).test(r.tags || ''));
        log('── 加標籤預覽 ──');
        log('名單 ' + names.length + ' 位；畫面上找得到 ' + hit.length + ' 位，找不到 ' + miss.length + ' 位');
        log('已有「' + tag + '」標籤：' + already.length + ' 位（會自動跳過）');
        if (miss.length) log('  找不到（前 10）：' + miss.slice(0, 10).join('、'));
        log('  ⚠ 若「找不到」很多，請先按「掃描全部（反覆載入）」把清單載完');
        beacon('tagpreview', {
          listCount: names.length, found: hit.length, missing: miss.length,
          already: already.length, missingSample: miss.slice(0, 20)
        });
      } catch (err) {
        log('✗ 加標籤預覽發生錯誤：' + ((err && err.message) || err));
      }
    });

    if ($('tagrun')) $('tagrun').addEventListener('click', () => {
      try {
        if (state.running) return log('已有工作在進行中，請先停止');
        const names = parseTagList($('taglist').value);
        const tag = ($('tagname').value || '').trim() || 'VIP';
        if (!names.length) return log('⚠ 名單是空的，請在文字框貼上聯絡人名單');
        log('⚠ 即將為 ' + names.length + ' 位加上標籤「' + tag + '」');
        runTagBatch(names, tag);
      } catch (err) {
        log('✗ 開始加標籤時發生錯誤：' + ((err && err.message) || err));
      }
    });

    // 各文字框的拖曳把手
    if ($('fnames')) attachGrip($('fnames'), 'lbp_fnames_h', 60, 360);
    attachGrip($('txt'), 'lbp_msg_h', 44, 360);
    attachGrip($('taglist'), 'lbp_taglist_h', 44, 360);
    attachGrip(logEl, 'lbp_log_h', 50, 360);
    if ($('gifttpl')) attachGrip($('gifttpl'), 'lbp_gifttpl_h', 60, 360);
    if ($('giftcodes')) attachGrip($('giftcodes'), 'lbp_giftcodes_h', 60, 360);

    if ($('imgprobe')) $('imgprobe').addEventListener('click', () => {
      try {
        ensureImageFileInput();
        const p = probeImageChannel();
        log('── 發圖探測 ──');
        log('  file input：' + p.fileInputs.length + ' 個');
        if (p.fileInputs.length) {
          const fi = findImageFileInput();
          log('  → 選用的 file input：' + (fi ? '已鎖定' : '未鎖定'));
        }
        log('  輸入框狀態：' + (findComposer() ? '已找到' : '⚠ 找不到（請先點一位聯絡人的「聊天」）'));
        for (const f of p.fileInputs) {
          log('    accept="' + f.accept + '" multiple=' + f.multiple + ' 隱藏=' + f.hidden + ' class="' + f.cls + '"');
        }
        log('  輸入區按鈕：' + p.imgButtons.length + ' 個');
        for (const b of p.imgButtons.slice(0, 20)) {
          log('    [' + b.tag + '] 文字="' + b.text + '" title="' + b.title + '" aria="' + b.aria + '"');
          log('         class="' + b.cls + '"');
        }
        beacon('imgprobe', p);
      } catch (err) {
        log('✗ 發圖探測錯誤：' + ((err && err.message) || err));
      }
    });
    // ---- 批次發圖 ----
    function showImage(img) {
      const prev = $('imgprev'), info = $('imginfo');
      if (!prev || !info) return;
      if (img) {
        prev.src = img.url;
        prev.style.display = 'inline-block';
        info.textContent = img.name + '（' + Math.round(img.size / 1024) + ' KB）';
      } else {
        prev.style.display = 'none';
        prev.removeAttribute('src');
        info.textContent = '尚未選擇圖片';
      }
    }

    // 開頁時還原上次選的圖（存在 localStorage）
    try {
      const saved = loadSaved(IMG_KEY);
      if (saved && saved.indexOf('data:') === 0) {
        const meta = loadSaved(IMG_KEY + '_meta');
        let name = 'image.png', type = 'image/png';
        try { const m = JSON.parse(meta || '{}'); name = m.name || name; type = m.type || type; } catch (e) {}
        const f = dataUrlToFile(saved, name, type);
        state.image = { file: f, url: saved, name: name, size: f.size };
        showImage(state.image);
      }
    } catch (e) {}

    if ($('imgpick')) $('imgpick').addEventListener('click', () => { if ($('imgfile')) $('imgfile').click(); });
    if ($('imgfile')) $('imgfile').addEventListener('change', async (e) => {
      try {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        if (f.type.indexOf('image') < 0) return log('⚠ 請選擇圖片檔');
        const url = await fileToDataUrl(f);
        state.image = { file: f, url: url, name: f.name, size: f.size };
        showImage(state.image);
        log('已選擇圖片：' + f.name + '（' + Math.round(f.size / 1024) + ' KB）');
        if (url.length > 4 * 1024 * 1024) {
          log('  ⚠ 圖片較大，重新整理後可能無法自動帶回（本次仍可正常發送）');
        } else {
          try {
            saveSetting(IMG_KEY, url);
            saveSetting(IMG_KEY + '_meta', JSON.stringify({ name: f.name, type: f.type }));
          } catch (err) { log('  （圖片較大，未保存到瀏覽器）'); }
        }
      } catch (err) {
        log('✗ 讀取圖片失敗：' + ((err && err.message) || err));
      }
    });
    if ($('imgclear')) $('imgclear').addEventListener('click', () => {
      state.image = null;
      showImage(null);
      saveSetting(IMG_KEY, '');
      saveSetting(IMG_KEY + '_meta', '');
      if ($('imgfile')) $('imgfile').value = '';
      log('已清除圖片');
    });
    // 試送一張：對「目前開啟的聊天室」附加並送出圖片，用來驗證上傳管道
    // 試送一張：對「目前開啟的聊天室」送出圖片（LINE 會跳確認彈窗，本工具自動按傳送）
    if ($('imgtest')) $('imgtest').addEventListener('click', async () => {
      try {
        if (state.running) return log('已有工作在進行中，請先停止');
        const img = getImage();
        if (!img) return log('⚠ 請先按「選擇圖片」選一張圖');
        log('── 試送圖片（LINE 會要求確認，本工具自動處理）──');
        let fi = findImageFileInput();
        if (!fi) { ensureImageFileInput(); await sleep(700); fi = findImageFileInput(); }
        log('  找到 file input：' + (fi ? ('是（accept="' + (fi.getAttribute('accept') || '') + '"）') : '⚠ 否'));
        if (!fi) {
          const ib = findImageButton();
          log('  圖片鈕：' + (ib ? ('找到（' + ((ib.className || '') + '').toString().slice(0, 40) + '）') : '找不到'));
          return log('  → 找不到上傳管道，發圖可能不可行');
        }
        const r = await sendImage(img);
        if (r.ok) {
          log('  ✅ 圖片已送出（' + r.steps.join(' → ') + '）');
          log('  → 請去聊天室確認圖片有出現');
        } else {
          log('  ✗ 失敗：' + r.reason);
          log('  步驟：' + r.steps.join(' → '));
        }
        beacon('imgtest', { ok: r.ok, steps: r.steps, reason: r.reason || '',
                            sent: r.sent, previewSeen: !!r.previewSeen,
                            accept: fi.getAttribute('accept') || '' });
      } catch (err) {
        log('✗ 試送錯誤：' + ((err && err.message) || err));
      }
    });
    if ($('imgsend')) $('imgsend').addEventListener('click', () => {
      try {
        if (state.running) return log('已有工作在進行中，請先停止');
        if (!getImage()) return log('⚠ 請先按「選擇圖片」選一張圖');
        if (!state.rows.length) state.rows = scanRows();
        if (!state.rows.length) return log('沒有名單，請先按「掃描全部（反覆載入）」');
        const from = parseInt(($('from') && $('from').value) || '1', 10) || 1;
        let to = parseInt(($('to') && $('to').value) || '0', 10) || state.rows.length;
        if (to <= 0 || to > state.rows.length) to = state.rows.length;
        const inRange = state.rows.filter((r) => r.idx >= from && r.idx <= to);
        const kept = applyFilter(inRange);
        const entries = kept.map((r) => ({ idx: r.idx, name: r.name, tags: r.tags }));
        log('篩選後將發圖給 ' + entries.length + ' 位（原 ' + inRange.length + ' 位）');
        if (!entries.length) return log('⚠ 篩選後沒有對象，已中止');
        runImageBatch(entries);
      } catch (err) {
        log('✗ 批次發圖啟動失敗：' + ((err && err.message) || err));
      }
    });
    // ---- 🎁 批次禮包碼 ----
    function giftRefreshInfo() {
      const codes = parseCodes($('giftcodes') ? $('giftcodes').value : '');
      const dup = findDuplicateCodes(codes);
      const el = $('giftinfo');
      if (!el) return;
      let s = codes.length ? ('讀到 ' + codes.length + ' 個禮包碼') : '尚未貼上禮包碼';
      if (dup.length) s += '　⚠ 有 ' + dup.length + ' 個重複：' + dup.slice(0, 3).join('、');
      el.textContent = s;
      el.style.color = dup.length ? '#b71c1c' : '#6a1b9a';
    }

    if ($('giftcodes')) $('giftcodes').value = state.giftCodesText || '';
    if ($('giftcodes')) $('giftcodes').addEventListener('input', (e) => {
      state.giftCodesText = e.target.value;
      saveSetting('lbp_gift_codes', state.giftCodesText);
      giftRefreshInfo();
    });
    if ($('gifttpl')) $('gifttpl').value = state.giftTemplate;
    if ($('gifttpl')) $('gifttpl').addEventListener('input', (e) => {
      state.giftTemplate = e.target.value;
      saveSetting('lbp_gift_tpl', state.giftTemplate);
    });
    giftRefreshInfo();

    if ($('giftpreview')) $('giftpreview').addEventListener('click', () => {
      try {
        const codes = parseCodes($('giftcodes').value);
        if (!codes.length) return log('⚠ 請先貼上禮包碼（一行一個）');
        if (!state.rows.length) state.rows = scanRows();
        if (!state.rows.length) return log('⚠ 沒有名單，請先按「掃描全部（反覆載入）」');
        const from = parseInt(($('from') && $('from').value) || '1', 10) || 1;
        let to = parseInt(($('to') && $('to').value) || '0', 10) || state.rows.length;
        if (to <= 0 || to > state.rows.length) to = state.rows.length;
        const inRange = state.rows.filter((r) => r.idx >= from && r.idx <= to);
        const kept = applyFilter(inRange);
        const r = buildGiftPairs(codes, kept);
        state.giftPairs = r.pairs;
        state.giftCodes = codes;
        saveGiftState();
        log('── 配對預覽 ──');
        log('  名單（依篩選）' + kept.length + ' 位；禮包碼 ' + codes.length + ' 個');
        log('  已配對 ' + r.pairs.length + ' 位' +
            (r.unpaired.length ? ('　⚠ 未配對 ' + r.unpaired.length + ' 位（碼不夠）') : '') +
            (r.unused.length ? ('　⚠ 未使用 ' + r.unused.length + ' 個碼') : ''));
        const dup = findDuplicateCodes(codes);
        if (dup.length) log('  ⚠ 重複的碼（同一碼會給兩人）：' + dup.slice(0, 5).join('、'));
        for (const p of r.pairs.slice(0, 15)) {
          log('    ' + p.name + '  ←  ' + p.code);
        }
        if (r.pairs.length > 15) log('    …（其餘 ' + (r.pairs.length - 15) + ' 位未列出，可匯出對照表查看）');
        log('  ⚠ 這只是預覽，尚未發送。確認無誤再按「開始發送」。');
        beacon('giftpreview', {
          people: kept.length, codes: codes.length, pairs: r.pairs.length,
          unpaired: r.unpaired.length, unused: r.unused.length, dups: dup.length,
          sample: r.pairs.slice(0, 20)
        });
      } catch (err) {
        log('✗ 配對預覽錯誤：' + ((err && err.message) || err));
      }
    });

    if ($('gifttest')) $('gifttest').addEventListener('click', () => {
      try {
        if (state.running) return log('已有工作在進行中，請先停止');
        if (!state.giftPairs.length) return log('⚠ 請先按「預覽配對」建立配對表');
        state.giftPairs = state.giftPairs.slice(0, 3);
        log('⚠ 試發前 3 位（' + state.giftPairs.map((p) => p.name).join('、') + '）');
        runGiftBatch(false);
      } catch (err) { log('✗ 試發啟動失敗：' + ((err && err.message) || err)); }
    });

    if ($('giftrun')) $('giftrun').addEventListener('click', () => {
      try {
        if (state.running) return log('已有工作在進行中，請先停止');
        if (!state.giftPairs.length) return log('⚠ 請先按「預覽配對」建立配對表');
        const dup = findDuplicateCodes(state.giftCodes || []);
        if (dup.length && !window.confirm('偵測到 ' + dup.length + ' 個重複的禮包碼，同一個碼會發給兩個人。\n仍要繼續嗎？')) {
          return log('已取消（重複的碼未處理）');
        }
        log('⚠ 即將對 ' + state.giftPairs.length + ' 位發送各自的禮包碼');
        runGiftBatch(false);
      } catch (err) { log('✗ 啟動失敗：' + ((err && err.message) || err)); }
    });

    if ($('giftresume')) $('giftresume').addEventListener('click', () => {
      try {
        if (state.running) return log('已有工作在進行中，請先停止');
        if (!state.giftPairs.length) return log('⚠ 沒有可續跑的配對表（帳本為空？）');
        const done = giftDoneNames(state.giftLedger);
        const left = state.giftPairs.filter((p) => !done[p.name]).length;
        log('續跑：待處理 ' + left + ' 位（已成功 ' + (state.giftPairs.length - left) + ' 位會跳過）');
        runGiftBatch(true);
      } catch (err) { log('✗ 續跑失敗：' + ((err && err.message) || err)); }
    });

    if ($('giftreport')) $('giftreport').addEventListener('click', () => { exportGiftReport(); });

    if ($('giftclearbook')) $('giftclearbook').addEventListener('click', () => {
      if (!window.confirm('確定要清除發送帳本嗎？清除後「續跑未完成」將無法判斷已發送對象。')) return;
      state.giftLedger = [];
      state.results = [];
      clearGiftState();
      render();
      log('已清除發送帳本');
    });

    log('面板已就緒 → 先按「掃描全部（反覆載入）」帶入名單。');
    render();
  }


  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel, { once: true });
  } else {
    buildPanel();
  }
})();

