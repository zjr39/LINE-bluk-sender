// 標籤識別單元測試：直接從 snippet 取原始碼載入，避免與正式程式分歧
// 用法： node tests/test-tag-parse.js
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'snippet', 'line-bulk-paste.js');
const src = fs.readFileSync(SRC, 'utf8');

function extract(name) {
  // 用「名字(」比對，避免 matchesName 誤命中 matchesNames 的開頭
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到函式 ' + name);
  // 由函式起點做括號配對
  let depth = 0, started = false;
  for (let k = i; k < src.length; k++) {
    const ch = src[k];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') {
      depth--;
      if (started && depth === 0) return src.slice(i, k + 1);
    }
  }
  throw new Error('括號不平：' + name);
}

// 取需要的規則與函式
const rules = src.slice(src.indexOf('const NOT_TAG_RULES'), src.indexOf('function classifyCell'));
const code = [
  rules,
  'const NOT_TAG_RULES_DONE = 1;',
  extract('classifyCell'),
  extract('parseTagCell')
].join('\n');

const factory = new Function(code + '\nreturn { classifyCell, parseTagCell };');
const { classifyCell, parseTagCell } = factory();

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + '\n      期望 ' + e + '\n      實得 ' + a); }
}

console.log('=== 1. 真實 CSV 出現過的值（來自使用者提供的檔案）===');
check('"待處理 VIP" → 標籤只有 VIP',
  parseTagCell('待處理 VIP'),
  { tags: ['VIP'], status: '待處理', type: '' });
check('"VIP 只傳訊的用戶" → 標籤只有 VIP，類型另收',
  parseTagCell('VIP 只傳訊的用戶'),
  { tags: ['VIP'], status: '', type: '只傳訊的用戶' });
check('"只傳訊的用戶" → 無標籤（這是類型）',
  parseTagCell('只傳訊的用戶'),
  { tags: [], status: '', type: '只傳訊的用戶' });
check('"設定負責人員" → 無標籤（這是 UI 提示）',
  parseTagCell('設定負責人員'),
  { tags: [], status: '', type: '' });
check('"新增標籤" → 無標籤（這是 UI 提示）',
  parseTagCell('新增標籤'),
  { tags: [], status: '', type: '' });
check('"待處理" → 無標籤（這是狀態）',
  parseTagCell('待處理'),
  { tags: [], status: '待處理', type: '' });
check('"VIP" → VIP',
  parseTagCell('VIP'),
  { tags: ['VIP'], status: '', type: '' });
check('"" → 全空',
  parseTagCell(''),
  { tags: [], status: '', type: '' });
check('"好友" → 無標籤（這是類型）',
  parseTagCell('好友'),
  { tags: [], status: '', type: '好友' });

console.log('=== 2. 未來新標籤必須自動生效（不可硬編碼 VIP）===');
check('"VVIP" → 保留為標籤',
  parseTagCell('VVIP'),
  { tags: ['VVIP'], status: '', type: '' });
check('"已回購 VIP" → 兩個標籤都保留',
  parseTagCell('已回購 VIP'),
  { tags: ['已回購', 'VIP'], status: '', type: '' });
check('"待處理 已回購" → 狀態歸狀態、標籤歸標籤',
  parseTagCell('待處理 已回購'),
  { tags: ['已回購'], status: '待處理', type: '' });
check('"高價值客戶,黑名單" → 逗號分隔也支援',
  parseTagCell('高價值客戶,黑名單'),
  { tags: ['高價值客戶', '黑名單'], status: '', type: '' });

console.log('=== 3. 身分歸類 ===');
check('classifyCell("待處理") = status', classifyCell('待處理'), 'status');
check('classifyCell("只傳訊的用戶") = type', classifyCell('只傳訊的用戶'), 'type');
check('classifyCell("設定負責人員") = ui', classifyCell('設定負責人員'), 'ui');
check('classifyCell("2026/10/3") = date', classifyCell('2026/10/3'), 'date');
check('classifyCell("聊天") = action', classifyCell('聊天'), 'action');
check('classifyCell("tt") = person', classifyCell('tt'), 'person');
check('classifyCell("VIP") = tag', classifyCell('VIP'), 'tag');

/* ---------------- 篩選規則 ---------------- */
console.log('=== 4. 篩選規則（受限類型／好友＋標籤／關鍵字）===');

function extractBetween(startNeedle, endNeedle) {
  const i = src.indexOf(startNeedle);
  const j = src.indexOf(endNeedle, i);
  if (i < 0 || j < 0) throw new Error('找不到區段 ' + startNeedle);
  return src.slice(i, j);
}

const filterCode = [
  extractBetween('const RESTRICTED_TYPES', 'function matchesIn'),
  extract('matchesIn'),
  extract('matchesAny'),
  extract('parseNameList'),
  extract('matchesName'),
  extract('matchesNames'),
  extract('passesFilter'),
  'function splitTerms(s) { return (s || "").split(/[|,，、]/).map((x) => x.trim()).filter(Boolean); }'
].join('\n');

function makeFilter(state) {
  return new Function('state', filterCode + '\nreturn { passesFilter, isRestricted, matchesNames, matchesAny, parseNameList };')(state);
}

const base = { filterInclude: '', filterExclude: '', filterNames: '', friendOnly: true };
const { passesFilter: pass1 } = makeFilter(base);

// 4.1 只傳訊的用戶：即使有 VIP 也不發（本次新增的核心規則）
check('只傳訊的用戶 + VIP → 不發',
  pass1({ name: 'RestrictedUser', tags: 'VIP', type: '只傳訊的用戶' }), false);
check('只傳訊的用戶 + 無標籤 → 不發',
  pass1({ name: 'binshao', tags: '', type: '只傳訊的用戶' }), false);

// 4.2 好友 + VIP → 發
check('好友 + VIP → 發',
  pass1({ name: 'FriendUser', tags: 'VIP', type: '好友' }), true);
check('好友 + 多標籤（含 VIP）→ 發',
  pass1({ name: 'X', tags: '已回購 VIP', type: '好友' }), true);

// 4.3 好友但沒有標籤 → 不發（規則：必須有標籤）
check('好友 + 無標籤 → 不發',
  pass1({ name: 'Alan', tags: '', type: '好友' }), false);

// 4.4 關閉「只發好友＋有標籤」時，好友/標籤條件不再限制
const off = makeFilter({ filterInclude: '', filterExclude: '', filterNames: '', friendOnly: false });
check('關閉開關：好友 + 無標籤 → 發',
  off.passesFilter({ name: 'Alan', tags: '', type: '好友' }), true);
check('關閉開關：只傳訊的用戶 + VIP → 仍不發（強制規則）',
  off.passesFilter({ name: 'RestrictedUser', tags: 'VIP', type: '只傳訊的用戶' }), false);

// 4.5 關鍵字規則仍有效
const inc = makeFilter({ filterInclude: 'VIP', filterExclude: '', filterNames: '', friendOnly: true });
check('只發給關鍵字 VIP：無標籤者不發',
  inc.passesFilter({ name: 'Alan', tags: '', type: '好友' }), false);
const exc = makeFilter({ filterInclude: '', filterExclude: '測試', filterNames: '', friendOnly: false });
check('排除關鍵字：命中就不發',
  exc.passesFilter({ name: '測試帳號', tags: 'VIP', type: '好友' }), false);
check('排除關鍵字：未命中就發',
  exc.passesFilter({ name: 'Alan', tags: 'VIP', type: '好友' }), true);

console.log('=== 5. 多標籤（逗號分隔 = 滿足任一）===');
const multi = makeFilter({ filterInclude: '繁體,英語', filterExclude: '', filterNames: '', friendOnly: false });
check('有「繁體」→ 發',
  multi.passesFilter({ name: 'A', tags: '繁體', type: '好友' }), true);
check('有「英語」→ 發',
  multi.passesFilter({ name: 'B', tags: '英語', type: '好友' }), true);
check('兩個都有 → 發',
  multi.passesFilter({ name: 'C', tags: '繁體 英語', type: '好友' }), true);
check('兩個都沒有 → 不發',
  multi.passesFilter({ name: 'D', tags: '日語', type: '好友' }), false);
check('沒有標籤 → 不發',
  multi.passesFilter({ name: 'E', tags: '', type: '好友' }), false);

// 全形逗號與頓號也可用
const multi2 = makeFilter({ filterInclude: '繁體，英語', filterExclude: '', filterNames: '', friendOnly: false });
check('全形逗號分隔也生效',
  multi2.passesFilter({ name: 'B', tags: '英語', type: '好友' }), true);
const multi3 = makeFilter({ filterInclude: '繁體、英語', filterExclude: '', filterNames: '', friendOnly: false });
check('頓號分隔也生效',
  multi3.passesFilter({ name: 'B', tags: '英語', type: '好友' }), true);
const multi4 = makeFilter({ filterInclude: '繁體|英語', filterExclude: '', filterNames: '', friendOnly: false });
check('直線分隔也生效',
  multi4.passesFilter({ name: 'B', tags: '英語', type: '好友' }), true);

// 多標籤 + 只傳訊的用戶 → 仍不發（強制規則優先）
check('多標籤但類型受限 → 不發',
  multi.passesFilter({ name: 'F', tags: '繁體', type: '只傳訊的用戶' }), false);

/* ---------------- 名稱清單（只發給指定 LINE 名稱）---------------- */
console.log('=== 5.5 名稱清單（與「只發給」分離）===');

const nl = makeFilter({
  filterInclude: '', filterExclude: '', friendOnly: false,
  filterNames: 'Alice\nBob'
});
check('名稱在清單內 → 發',
  nl.passesFilter({ name: 'Alice', tags: 'VIP', type: '好友' }), true);
check('名稱不在清單內 → 不發',
  nl.passesFilter({ name: 's1.other', tags: 'VIP', type: '好友' }), false);
check('名稱清單為空 → 全部放行（不限制名稱）',
  makeFilter({ filterInclude: '', filterExclude: '', friendOnly: false, filterNames: '' })
    .passesFilter({ name: '任何人', tags: '', type: '好友' }), true);

// 精確比對：避免部分命中
const nl2 = makeFilter({ filterInclude: '', filterExclude: '', friendOnly: false, filterNames: 's1.abc' });
check('精確比對：s1.abc 命中',
  nl2.passesFilter({ name: 's1.abc', tags: '', type: '好友' }), true);
check('精確比對：s1.abcdef 不該被選中（不可部分命中）',
  nl2.passesFilter({ name: 's1.abcdef', tags: '', type: '好友' }), false);
check('精確比對：前後空白會忽略',
  makeFilter({ filterInclude: '', filterExclude: '', friendOnly: false, filterNames: '  s1.abc  ' })
    .passesFilter({ name: 's1.abc', tags: '', type: '好友' }), true);

// 「只發給」不再比對名稱
const tagOnly = makeFilter({ filterInclude: 'VIP', filterExclude: '', friendOnly: false, filterNames: '' });
check('「只發給」不再比對名稱：名稱含 VIP 但標籤沒有 → 不發',
  tagOnly.passesFilter({ name: 'VIP小明', tags: '', type: '好友' }), false);
check('「只發給」比對標籤：標籤有 VIP → 發',
  tagOnly.passesFilter({ name: '小明', tags: 'VIP', type: '好友' }), true);
const typeOnly = makeFilter({ filterInclude: '只傳訊', filterExclude: '', friendOnly: false, filterNames: '' });
check('「只發給」比對類型：類型符合 → 命中（但仍被受限規則擋下）',
  typeOnly.passesFilter({ name: '小明', tags: 'VIP', type: '只傳訊的用戶' }), false);

// 名稱清單 + 標籤條件 = 交集
const both = makeFilter({
  filterInclude: 'VIP', filterExclude: '', friendOnly: false,
  filterNames: 'Alice\nBob'
});
check('名稱清單＋標籤＝交集：兩者都符合 → 發',
  both.passesFilter({ name: 'Alice', tags: 'VIP', type: '好友' }), true);
check('名稱清單＋標籤＝交集：名稱符合但標籤不符 → 不發',
  both.passesFilter({ name: 'Alice', tags: '其他', type: '好友' }), false);
check('名稱清單＋標籤＝交集：標籤符合但名稱不在清單 → 不發',
  both.passesFilter({ name: 's9.路人', tags: 'VIP', type: '好友' }), false);

// 排除清單仍可比對名稱（方便排除某個人）
const exName = makeFilter({ filterInclude: '', filterExclude: '測試帳號', friendOnly: false, filterNames: '' });
check('排除可比對名稱：命中就排除',
  exName.passesFilter({ name: '測試帳號', tags: 'VIP', type: '好友' }), false);
check('排除可比對名稱：未命中就發',
  exName.passesFilter({ name: '正常帳號', tags: 'VIP', type: '好友' }), true);

console.log('=== 6. 多標籤加註：解析標籤名稱 ===');
function extractFn(name) {
  const i = src.indexOf('function ' + name);
  let depth = 0, started = false;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') { depth++; started = true; }
    else if (src[k] === '}') { depth--; if (started && depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error('括號不平 ' + name);
}
const parseTagNames = new Function(extractFn('parseTagNames') + '\nreturn parseTagNames;')();
check('"繁體,英語" → 兩個標籤',
  parseTagNames('繁體,英語'), ['繁體', '英語']);
check('"繁體，英語" → 兩個標籤',
  parseTagNames('繁體，英語'), ['繁體', '英語']);
check('"VIP" → 一個標籤',
  parseTagNames('VIP'), ['VIP']);
check('重複會去重',
  parseTagNames('VIP,VIP'), ['VIP']);
check('空字串 → 空陣列',
  parseTagNames(''), []);
check('"  繁體 , , 英語  " → 兩個標籤（忽略空白與空項）',
  parseTagNames('  繁體 , , 英語  '), ['繁體', '英語']);


/* ---------------- 禮包碼功能 ---------------- */
console.log('=== 7. 禮包碼：解析與去重 ===');
const fns = {};
for (const n of ['parseCodes', 'findDuplicateCodes', 'buildGiftPairs', 'renderGiftMessage', 'giftDoneNames']) {
  fns[n] = new Function('return ' + extractFn(n))();
}

check('parseCodes：一行一個',
  fns.parseCodes('AAA\nBBB\nCCC'), ['AAA', 'BBB', 'CCC']);
check('parseCodes：去空行與空白',
  fns.parseCodes('  AAA  \n\n  \nBBB\n'), ['AAA', 'BBB']);
check('parseCodes：保留前導零（不可轉數字）',
  fns.parseCodes('00123'), ['00123']);
check('parseCodes：保留字母與連字號',
  fns.parseCodes('VIP1STPWZ1V7HM9'), ['VIP1STPWZ1V7HM9']);
check('parseCodes：全空 → 空陣列',
  fns.parseCodes('   \n  \n'), []);
check('parseCodes：CRLF 也支援',
  fns.parseCodes('A\r\nB\r\nC'), ['A', 'B', 'C']);

check('findDuplicateCodes：無重複',
  fns.findDuplicateCodes(['A', 'B', 'C']), []);
check('findDuplicateCodes：找出重複',
  fns.findDuplicateCodes(['A', 'B', 'A', 'C', 'B']), ['A', 'B']);
check('findDuplicateCodes：大小寫視為不同',
  fns.findDuplicateCodes(['a', 'A']), []);

console.log('=== 8. 禮包碼：配對（名單由上往下）===');
const people5 = [{ idx: 1, name: 'P1' }, { idx: 2, name: 'P2' }, { idx: 3, name: 'P3' }, { idx: 4, name: 'P4' }, { idx: 5, name: 'P5' }];
const r1 = fns.buildGiftPairs(['C1', 'C2', 'C3'], people5);
check('碼少於人：只配前 3 位',
  r1.pairs.map((p) => p.name + '=' + p.code), ['P1=C1', 'P2=C2', 'P3=C3']);
check('碼少於人：後面列為未配對',
  r1.unpaired.map((p) => p.name), ['P4', 'P5']);
check('碼少於人：沒有未使用的碼', r1.unused, []);

const r2 = fns.buildGiftPairs(['C1', 'C2', 'C3', 'C4', 'C5', 'C6'], people5);
check('碼多於人：只配 5 位', r2.pairs.length, 5);
check('碼多於人：多出的碼列為未使用', r2.unused, ['C6']);
check('碼多於人：無人未配對', r2.unpaired, []);

const r3 = fns.buildGiftPairs(['C1', 'C2'], [{ idx: 1, name: 'P1' }, { idx: 2, name: 'P2' }]);
check('數量相等：全部配對', r3.pairs.length, 2);

check('名單為空：沒有配對', fns.buildGiftPairs(['C1'], []).pairs, []);

console.log('=== 9. 禮包碼：訊息模板 ===');
check('有 {CODE} 佔位符',
  fns.renderGiftMessage('這是我們的一週年禮包碼：{CODE}', 'VIP1STPWZ1V7HM9'),
  '這是我們的一週年禮包碼：VIP1STPWZ1V7HM9');
check('多個 {CODE} 全部替換',
  fns.renderGiftMessage('{CODE} 與 {CODE}', 'X'), 'X 與 X');
check('沒有佔位符 → 接在結尾',
  fns.renderGiftMessage('禮包碼：', 'ABC'), '禮包碼：ABC');
check('模板為空 → 只輸出碼',
  fns.renderGiftMessage('', 'ABC'), 'ABC');
check('碼為空 → 原樣輸出模板',
  fns.renderGiftMessage('測試', ''), '測試');

console.log('=== 10. 續跑：帳本判定 ===');
check('giftDoneNames：只收成功者',
  Object.keys(fns.giftDoneNames([
    { name: 'A', status: '成功' }, { name: 'B', status: '失敗' }, { name: 'C', status: '成功' }
  ])).sort(), ['A', 'C']);
check('giftDoneNames：空帳本', Object.keys(fns.giftDoneNames([])), []);

console.log('');
console.log(fail === 0
  ? '✅ 全部通過：' + pass + ' 項'
  : '❌ 失敗 ' + fail + ' 項 / 共 ' + (pass + fail) + ' 項');
process.exit(fail === 0 ? 0 : 1);
