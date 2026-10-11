// 檢查重複的函式定義（後定義者會覆蓋前者，是隱性地雷）
const fs = require('fs');
const c = fs.readFileSync('snippet/line-bulk-paste.js', 'utf8');
const lines = c.split('\n');
const map = new Map();
for (let i = 0; i < lines.length; i++) {
  // 只看頂層（縮排 2 空白）的函式宣告，避免把各函式內的巢狀宣告誤判為重複
  const m = lines[i].match(/^ {2}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (!m) continue;
  const name = m[1];
  if (!map.has(name)) map.set(name, []);
  map.get(name).push(i + 1);
}
let dup = 0;
for (const [name, ls] of map) {
  if (ls.length > 1) { dup++; console.log('  ⚠ ' + name + ' 定義 ' + ls.length + ' 次：行 ' + ls.join(', ')); }
}
console.log(dup ? ('共 ' + dup + ' 個重複') : '（無重複）');
