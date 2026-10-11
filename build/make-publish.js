// 產生乾淨的交付資料夾 publish\（只含同事需要的檔案）
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'publish');
const SRC = path.join(ROOT, 'portable');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'server'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'snippet'), { recursive: true });

// 必要檔案
const files = [
  ['安裝說明.html', '安裝說明.html'],
  ['使用說明.md', '使用說明.md'],
  ['start-server.cmd', 'start-server.cmd'],
  [path.join('server', 'server.js'), path.join('server', 'server.js')],
  [path.join('snippet', 'line-bulk-paste.js'), path.join('snippet', 'line-bulk-paste.js')]
];

let total = 0;
for (const [from, to] of files) {
  const src = path.join(SRC, from);
  if (!fs.existsSync(src)) { console.error('缺少 ' + from); process.exit(1); }
  fs.copyFileSync(src, path.join(OUT, to));
  total += fs.statSync(src).size;
}

// 交付清單
const list = [
  'LINE 聯絡人批量助手 — 交付清單',
  '',
  '把整個資料夾複製給同事即可（約 ' + (total / 1024).toFixed(0) + ' KB）。',
  '',
  '內容：',
  '  安裝說明.html                 安裝步驟（雙擊用 Edge 開啟）',
  '  使用說明.md                   完整使用文件',
  '  start-server.cmd              每次要用之前雙擊這個',
  '  server\\server.js              服務程式',
  '  snippet\\line-bulk-paste.js    面板本體',
  '',
  '使用順序：',
  '  1. 雙擊 start-server.cmd（黑色視窗要一直開著）',
  '  2. 開啟 安裝說明.html，把綠色按鈕拖到 Edge 書籤列',
  '  3. 到 LINE 聯絡人頁面，點書籤列上的「LINE 批量助手」',
  '',
  '注意：',
  '  - 需要 Node.js；start-server.cmd 會在缺少時自動安裝',
  '  - 這個工具會真的發送訊息，第一次請先用「只跑第一位（測試）」',
  ''
].join('\r\n');
fs.writeFileSync(path.join(OUT, '交付清單.txt'), list, 'utf8');

console.log('已產生交付資料夾：' + OUT);
console.log('  總大小 ' + (total / 1024).toFixed(0) + ' KB（不含交付清單）');
for (const [from, to] of files) {
  console.log('  ' + to + '  ' + (fs.statSync(path.join(OUT, to)).size / 1024).toFixed(1) + ' KB');
}
