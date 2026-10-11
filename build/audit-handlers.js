// 稽核：結構完整性（改為從 HTML 動態取得按鈕，避免硬編碼清單過期誤報）
const fs = require('fs');
const c = fs.readFileSync('snippet/line-bulk-paste.js', 'utf8');

// 動態取得所有 HTML 按鈕 id
const btns = [...c.matchAll(/<button id="([a-z0-9]+)"/g)].map((m) => m[1]);
const bad = [];
for (const id of btns) {
  if (c.indexOf("$('" + id + "').addEventListener") < 0) bad.push(id);
}

console.log('HTML 按鈕 ' + btns.length + ' 個，未掛載處理器：' + (bad.length ? bad.join(', ') : '（無）'));
console.log('attachGrip 呼叫：' + (c.match(/attachGrip\(/g) || []).length + ' 處');
console.log('面板已就緒訊息：' + c.includes('面板已就緒'));
console.log('buildPanel(); 呼叫：' + c.includes('buildPanel();'));
console.log('孤兒 setMsg：' + c.includes('setMsg: (t)'));
console.log('__LBP__ 殘留：' + c.includes('__LBP__'));
console.log('friendonly 開關（變數式）：' + c.includes("fo.addEventListener('change'"));
console.log('檔案大小：' + (c.length / 1024).toFixed(1) + ' KB');

process.exit(bad.length === 0 ? 0 : 1);
