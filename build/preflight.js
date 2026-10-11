// 出貨前檢查：找出殘留的開發痕跡與失效程式碼
const fs = require('fs');
const src = fs.readFileSync('snippet/line-bulk-paste.js', 'utf8');
const lines = src.split(/\r?\n/);

const suspects = [
  ['__LBP__', '__LBP__'],
  ['__CLEANED__', '__CLEANED__'],
  ['tagProbe', 'tagProbe'],
  ['listProbe', 'listProbe'],
  ['scrollTest', 'scrollTest'],
  ['dialogParts', 'dialogParts'],
  ['topLayerRoot', 'topLayerRoot'],
  ['makeResizable', 'makeResizable'],
  ['colGroups', 'colGroups'],
  ['tagColIndex', 'tagColIndex'],
  ['cellObjs', 'cellObjs'],
  ['locateTagControl', 'locateTagControl'],
  ['visibleInputs', 'visibleInputs'],
  ['describeEditors', 'describeEditors'],
  ['hasTag', 'hasTag'],
  ['statusOfRow', 'statusOfRow'],
  ['typeOfRow', 'typeOfRow'],
  ['127.0.0.1:8765', '本機服務位址'],
  ['lbp-down', '服務中斷提示']
];
console.log('=== 符號出現次數 ===');
for (const [label, needle] of suspects) {
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const n = (src.match(re) || []).length;
  if (n > 0) console.log('  ' + label + ' : ' + n);
}

console.log('=== 對外按鈕清單 ===');
const btns = [...src.matchAll(/<button id="([a-z]+)"[^>]*>([^<]*)</g)];
for (const m of btns) console.log('  ' + m[1] + ' → ' + m[2]);

console.log('=== 檢查有沒有「呼叫了但未定義」的函式 ===');
const called = new Set([...src.matchAll(/(?:await\s+)?([a-zA-Z_$][\w$]*)\(/g)].map(m => m[1]));
const defined = new Set([...src.matchAll(/function\s+([a-zA-Z_$][\w$]*)/g)].map(m => m[1]));
const builtins = new Set(['if','for','while','switch','catch','return','typeof','function','new','await','String','Number','Array','Object','JSON','Math','Date','RegExp','Map','Set','parseInt','parseFloat','isNaN','setTimeout','setInterval','clearTimeout','clearInterval','encodeURIComponent','decodeURIComponent','alert','console','fetch','Blob','URL','Event','KeyboardEvent','MutationObserver','ResizeObserver','getComputedStyle','requestAnimationFrame','Function','Promise','Boolean','Error']);
const missing = [...called].filter(f => !defined.has(f) && !builtins.has(f) && !src.includes(f + ':') && !src.includes(f + ' ='));
console.log('  可能未定義：' + (missing.length ? missing.join(', ') : '（無）'));
