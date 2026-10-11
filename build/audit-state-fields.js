// 稽核：所有 state.xxx 引用都必須在 state 物件裡宣告（避免執行時拋錯）
const fs = require('fs');
const c = fs.readFileSync('snippet/line-bulk-paste.js', 'utf8');

// 取出 state 物件本文
const si = c.indexOf('const state = {');
if (si < 0) { console.error('找不到 state'); process.exit(1); }
let depth = 0, started = false, ei = -1;
for (let k = si; k < c.length; k++) {
  if (c[k] === '{') { depth++; started = true; }
  else if (c[k] === '}') { depth--; if (started && depth === 0) { ei = k; break; } }
}
const body = c.slice(si, ei);

// 物件字面中的鍵名（含巢狀與註解干擾，用寬鬆比對）
const declared = new Set();
for (const m of body.matchAll(/(?:^|[\s{,])([A-Za-z_$][\w$]*)\s*:/g)) declared.add(m[1]);

// 所有 state.xxx 引用
const used = new Set();
for (const m of c.matchAll(/state\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);

const missing = [...used].filter((k) => !declared.has(k)).sort();
const unused = [...declared].filter((k) => !used.has(k)).sort();

console.log('state 宣告 ' + declared.size + ' 個欄位，程式引用 ' + used.size + ' 個');
console.log('引用但未宣告（會拋錯）：' + (missing.length ? missing.join(', ') : '（無）'));
console.log('宣告但未使用（可清理）：' + (unused.length ? unused.join(', ') : '（無）'));
process.exit(missing.length === 0 ? 0 : 1);
