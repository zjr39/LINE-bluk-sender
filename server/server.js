// LINE 批量粘貼：本機收件匣 + 指令佇列
// 用法： node server.js
//   GET  /snippet.js  提供控制面板腳本（書籤小工具會載入它）
//   POST /result      面板回報進度
//   GET  /state       目前累積狀態（名稱清單 + 每位處理結果）
//   POST /cmd         放入一筆指令    GET /next  取出指令
//   POST /reset       清空累積狀態（開始新一輪前用）
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const DIR = path.join(__dirname, '..', 'logs');
const SNIPPET = path.join(__dirname, '..', 'snippet', 'line-bulk-paste.js');
const STATE_FILE = path.join(DIR, 'state.json');
fs.mkdirSync(DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const RESULT_FILE = path.join(DIR, `results-${stamp}.jsonl`);

let latest = null;
let queue = [];
let seq = 0;
let byIdx = new Map();
let names = [];
let account = '';   // 帳號識別（由 URL 取出），避免不同帳號的資料互相污染

function accountOf(url) {
  const m = /chat\.line\.biz\/([A-Za-z0-9]+)/.exec(url || '');
  return m ? m[1] : '';
}

// 讀回上次的累積狀態，讓服務重啟不會遺失進度
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const o = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    account = o.account || '';
    if (Array.isArray(o.names)) names = o.names;
    if (Array.isArray(o.items)) byIdx = new Map(o.items.map((i) => [i.idx, i]));
    console.log(`[載入] 帳號 ${account || '(未知)'} / 名單 ${names.length} 位 / 已處理 ${byIdx.size} 位`);
  } catch (e) {
    console.log('[載入] 略過（' + e.message + '）');
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ at: new Date().toISOString(), account, names, items: [...byIdx.values()] }),
      'utf8'
    );
  } catch (e) {
    /* ignore */
  }
}

loadState();

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = (req.url || '').split('?')[0];

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }

    // 健康檢查（交付版也有，這裡補上以保持一致）
    if (req.method === 'GET' && url === '/ping') {
      return json(res, 200, { ok: true, names: names.length, processed: byIdx.size });
    }

    if (req.method === 'POST' && url === '/result') {
      let payload = null;
      try {
        payload = JSON.parse(raw);
      } catch (e) {
        payload = { raw };
      }
      latest = payload;
      fs.appendFileSync(RESULT_FILE, JSON.stringify(payload) + '\n', 'utf8');

      const acct = accountOf(payload && payload.url);
      if (acct && acct !== account) {
        // 切換到另一個 LINE 帳號：換掉整份狀態，不要混淆
        console.log(`[帳號] ${account || '(未知)'} → ${acct}，狀態已切換`);
        account = acct;
        names = [];
        byIdx = new Map();
      }

      if (payload && Array.isArray(payload.names)) {   // scan 與 scrollloaded 都帶 names
        names = payload.names;
        byIdx = new Map();
        console.log(`[掃描] 帳號 ${account || '(未知)'} 共 ${names.length} 位聯絡人：${names.slice(0, 6).join(' / ')} ...`);
      }
      if (payload && payload.item && payload.item.idx) {
        byIdx.set(payload.item.idx, payload.item);
        const it = payload.item;
        console.log(
          `[${it.status}] #${it.idx} ${it.name}${it.reason ? ' — ' + it.reason : ''}` +
            `  (完成 ${byIdx.size})`
        );
      }
      if (payload && payload.tag === 'tagprobe' && Array.isArray(payload.rows)) {
        console.log('[標籤探測] 取樣 ' + payload.rows.length + ' 列：');
        for (const r of payload.rows) {
          console.log('   《' + r.name + '》 標籤="' + (r.tags || '') + '"');
          if (Array.isArray(r.cells)) console.log('        欄位：' + r.cells.join(' ｜ '));
        }
      }
      if (payload && (payload.tag === 'done' || payload.tag === 'scan' || payload.tag === 'scrollloaded')) {
        console.log(`[${payload.tag}] 名單 ${names.length} 位 / 已處理 ${byIdx.size}`);
      }
      saveState();

      const p = payload && payload.payload ? payload.payload : payload;
      if (p && p.results) {
        const last = p.results[p.results.length - 1];
        console.log(
          `[結果] 總${p.total} 成功${p.success} 失敗${p.failed}` +
            (last ? ` | 最後：#${last.idx} ${last.name} ${last.status} ${last.reason || ''}` : '')
        );
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url === '/snippet.js') {
      const js = fs.readFileSync(SNIPPET, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Length': Buffer.byteLength(js),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      });
      return res.end(js);
    }

    if (req.method === 'POST' && url === '/reset') {
      byIdx = new Map();
      names = [];
      latest = null;
      saveState();
      console.log('[重置] 累積狀態已清空');
      return json(res, 200, { ok: true, reset: true });
    }

    if (req.method === 'GET' && url === '/state') {
      const items = [...byIdx.values()].sort((a, b) => a.idx - b.idx);
      return json(res, 200, {
        ok: true,
        account: account,
        names: names.length,
        processed: items.length,
        success: items.filter((i) => i.status === '成功').length,
        failed: items.filter((i) => i.status === '失敗').length,
        running: latest ? latest.running : null,
        lastTag: latest ? latest.tag : null,
        nameList: names,
        results: items
      });
    }

    if (req.method === 'POST' && url === '/cmd') {
      let cmd = {};
      try {
        cmd = JSON.parse(raw || '{}');
      } catch (e) {
        return json(res, 400, { ok: false, error: 'bad json' });
      }
      seq += 1;
      cmd.id = String(seq);
      queue.push(cmd);
      console.log('[指令]', JSON.stringify(cmd));
      return json(res, 200, { ok: true, id: cmd.id, queued: queue.length });
    }

    if (req.method === 'GET' && url === '/next') {
      const cmd = queue.length ? queue.shift() : null;
      return json(res, 200, cmd || { action: 'none', id: 'none' + Date.now() });
    }

    return json(res, 404, { ok: false });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LINE 批量粘貼收件匣已啟動： http://127.0.0.1:${PORT}`);
  console.log(`結果寫入： ${RESULT_FILE}`);
});
