// HTML 按鈕 與 事件處理器 對照（避免孤兒處理器讓面板崩掉）
const fs = require('fs');
const c = fs.readFileSync('snippet/line-bulk-paste.js', 'utf8');

const btns = [...c.matchAll(/<button id="([a-z0-9]+)"/g)].map((m) => m[1]);
const fields = [
  ...[...c.matchAll(/<input[^>]*id="([a-z0-9]+)"/g)].map((m) => m[1]),
  ...[...c.matchAll(/<textarea[^>]*id="([a-z0-9]+)"/g)].map((m) => m[1])
];
const handlers = [...c.matchAll(/\$\('([a-z0-9]+)'\)\)\s*\$\('\1'\)\.addEventListener/g)].map((m) => m[1]);
const unguarded = [...c.matchAll(/^\s*\$\('([a-z0-9]+)'\)\.addEventListener/gm)].map((m) => m[1]);

const missing = btns.filter((b) => !handlers.includes(b));          // 按鈕沒接線＝按了沒反應
const orphan = handlers.filter((h) => !btns.includes(h) && !fields.includes(h)); // 處理器找不到元素＝拋錯
const fieldsGuarded = handlers.filter((h) => fields.includes(h));

console.log('HTML 按鈕 ' + btns.length + ' 個：' + btns.join(', '));
console.log('輸入欄位 ' + fields.length + ' 個（皆有防護：' + fieldsGuarded.length + '）');
console.log('缺處理器的按鈕（按了沒反應）：' + (missing.length ? missing.join(', ') : '（無）'));
console.log('找不到元素的處理器（會拋錯）：' + (orphan.length ? orphan.join(', ') : '（無）'));
console.log('未防護的處理器：' + (unguarded.length ? unguarded.join(', ') : '（無）'));
process.exit(missing.length === 0 && orphan.length === 0 && unguarded.length === 0 ? 0 : 1);
