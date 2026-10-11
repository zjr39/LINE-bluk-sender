# LINE 聯絡人批量助手 — 專案交接文件

> 給「未來的我」或接手的人：這份文件記錄專案全貌、關鍵決策與踩過的坑。
> 看完這份就能繼續開發，不必依賴對話紀錄。

---

## 1. 這是什麼

給 LINE 官方帳號管理後台（chat.line.biz）「聯絡人」頁面用的批次工具。以**書籤小工具**注入一個控制面板，提供：

| 功能 | 說明 |
|---|---|
| 批次發送文字 | 逐位開啟聊天室 → 粘貼文字 →（可選）自動送出 |
| 篩選 | 多標籤任一、排除關鍵字、只發好友＋有標籤、受限類型不發 |
| 匯出 CSV | 聯絡人清單（姓名／標籤／類型／狀態／日期／是否發送） |
| 批次加標籤 | 對指定名單批次加上一個或多個標籤 |
| 批次發圖 | 選一張本地圖片，對名單逐位發送 |

---

## 2. 檔案地圖

```
LINE\
├── snippet\line-bulk-paste.js      ★ 面板本體（所有邏輯都在這，約 94 KB）
├── tests\test-tag-parse.js         ★ 單元測試（45 項，node tests\test-tag-parse.js）
├── server\server.js                  本機服務，把上面那個檔案提供給書籤
├── start-server.cmd                  雙擊啟動服務
│
├── build\                            產生交付包的工具
│   ├── build-portable.js             portable\ 與 安裝說明.html
│   ├── make-publish.js               publish\ 交付資料夾
│   ├── audit-buttons.js              稽核：按鈕 ↔ 事件處理器
│   ├── audit-dupes.js                稽核：重複的函式定義
│   ├── audit-handlers.js             稽核：處理器與結構完整性
│   ├── vip-names.txt                 122 位要加 VIP 的名單
│   └── *.js                          各種一次性修正腳本（見第 6 節）
│
├── scripts\                          PowerShell 版工具（UIA/座標控制，早期路線）
├── portable\                         給同事的資料夾（含使用說明）
├── publish\                          ★ 最終交付包（複製給同事的就是這個）
├── logs\                             beacon 日誌（UTF-8，需指定編碼讀取）
├── shots\                            截圖
├── extension\                        已停用的擴充（保留守衛腳本）
└── report-line-paste.md/.csv         第一次批次發送的報告
```

---

## 3. 架構（為什麼是書籤小工具）

**走不通的路（別重試）**：

1. **CDP / remote debugging** — Edge 封鎖 `--remote-debugging-port`（預設 profile 不允許），`browser_prepare` 也需要授權。
2. **瀏覽器擴充** — 實測能載入，但在同事電腦上「開發人員模式 + 載入解壓縮」太麻煩，改為書籤小工具。
3. **單一自足 HTML（腳本內嵌書籤）** — 編碼後 9 萬字元，書籤裝不下。
4. **`file://` 載入腳本** — https 頁面被禁止載入本機檔案。
5. **Windows UIA / 座標控制** — Chromium 的無障礙樹會休眠、座標點擊常落空，不穩定。

**目前架構**：

```
start-server.cmd → node server\server.js（127.0.0.1:8765）
                        ↓ 提供 snippet.js
書籤小工具（206 字元的 javascript: URL）
   → fetch http://127.0.0.1:8765/snippet.js → new Function(code)()
   → 在頁面內建立面板（Shadow DOM，id=lbp-host）
```

---

## 4. LINE 頁面的實測結構（重要，別再重新摸索）

### 聯絡人表格（每一列）

```
[0] 名稱        （含頭像）
[1] 標籤        ← 「VIP」或「新增標籤」（點它會開標籤彈窗）
[2] 類型        ← 「好友」/「只傳訊的用戶」
[3] 負責人員    ← 通常是「tt」
[4] 最近聊天日期 + 「聊天」按鈕 + 「詳情」
```

- 列容器：class 含 `contact-chat`（例如 `contact-chat-selected` 代表目前開啟的那一列）
- **「新增標籤」是 `<A class="btn px-0 text-info">`（約 80px 寬）**；
  外層容器是 `<DIV class="d-flex flex-wrap align-items-center">`（256px 寬）——
  **點到外層容器等於點在空白處，完全沒反應**。這是最容易踩的坑。
- 標籤彈窗：class 含 `pc-chat-tag-edit-modal`
  - 輸入框：`input[placeholder="輸入標籤"]`，輸入後按 Enter 建立
  - 儲存鈕：**「儲存」**（不是「存儲」！）／取消鈕「取消」
- 訊息輸入框：**自訂元素 `<TEXTAREA-EX>`**，placeholder 含「傳送／Shift + Enter：換行」
  - 真正的可寫元素在它的 shadow root 內（`textarea` 或 contenteditable）
- 圖片上傳：**一個隱藏的 `<input type="file" class="d-none" multiple>`**（`accept` 為空）
- 送出訊息：**Enter 鍵事件有效**；點「傳送」按鈕無效（文字）
- **圖片送出**：選圖後 LINE 一定跳「確定要傳送檔案至此聊天室嗎」，按「傳送」才送出
  → **圖片無法只附加不送出**

### 清單載入機制（反直覺）

- **不是捲動載入**。軌跡顯示容器已到底（`top = maxTop`）但 `scrollHeight` 不變。
- 真正機制是**每次重新查詢多載一批（約 20 位）**。
- 因此做法是「掃描 → 等 → 再掃描」，累積去重，連續 N 輪無新增才停。
- 清單**虛擬化**：捲回頂端後下方列會被卸載 → **必須邊捲邊收集**，不能捲完才數。
- 帳號不同，名單長度差很多（實測 20 / 40 / 75 / 133 / 224 / 504 位）。

---

## 5. 核心設計決策

### 5.1 標籤識別（別硬編碼 VIP）

`buildColIndex(row)` 依元素 x 座標切出欄位，`tagColIndex` 用「新增標籤」控件定位標籤欄；
`parseTagCell(text)` 用 `NOT_TAG_RULES` 依**身分**歸類：

```js
{ kind: 'ui',     re: /^(新增標籤|設定負責人員|設定負責人)$/ }     // 丟棄
{ kind: 'status', re: /^(待處理|處理完畢|已處理|已完成)$/ }         // 歸 status
{ kind: 'type',   re: /^(好友|只傳訊的用戶|群組|垃圾訊息)$/ }        // 歸 type
{ kind: 'person', re: /^(tt|admin)$/i }
{ kind: 'date',   re: /^\d{4}\/\d{1,2}\/\d{1,2}/ }
{ kind: 'action', re: /^(聊天|詳情)$/ }
// 其餘一律視為標籤並保留 ← 關鍵：未來新標籤不需改程式
```

**要新增排除規則時，只改 `NOT_TAG_RULES` 一行**，並在 `tests\test-tag-parse.js` 加案例。

### 5.2 篩選規則（`passesFilter`）

1. **強制**：類型含「只傳訊的用戶」→ 不發（即使有 VIP）。LINE 平台限制。
2. **開關**「只發好友＋有標籤」：類型須含「好友」且標籤非空。
3. 關鍵字：比對範圍 = 名稱 + 標籤 + 類型；`只發給`（白名單）/`排除`（黑名單）。
   多個關鍵字用 `,`、`，`、`、`、`|` 分隔，**滿足任一**。

### 5.3 貼對人防護

`openChat()` 點擊後會輪詢等「目前開啟的列」＝目標名稱才允許粘貼，否則跳過並記為失敗。
同名聯絡人無法區分，面板會警告。

### 5.4 一律使用存在檢查

所有事件處理器都寫成 `if ($('xxx')) $('xxx').addEventListener(...)`。
**原因**：曾發生「HTML 少了按鈕但處理器已加」→ `$()` 回 undefined → 整個面板建不起來。
`build\audit-buttons.js` 會稽核這件事。

---

## 5.5 禮包碼功能（每人一組不同的碼）

**用途**：把一份「只有禮包碼」的清單，依名單順序一一對應到人，發送個人化訊息；
發完產出 `禮包碼 / LINE名稱 / UID` 對照表。

**資料流**

```
禮包碼清單（一行一個）
   ↓ buildGiftPairs()：名單（依篩選）由上往下 ↔ 碼由上往下
配對快照 state.giftPairs（鎖定後不再變動）
   ↓ 逐位 sendGiftTo()
帳本 state.giftLedger → exportGiftReport() → CSV
```

**關鍵設計**

| 機制 | 說明 |
|---|---|
| 配對鎖定 | 按「預覽配對」時把配對存成快照；日後重新掃描清單也不影響已配對內容 |
| 貼對人防護 | 沿用 `openChat()`：開啟的聊天室姓名不符就跳過記失敗，**絕不發送** |
| 內文驗證 | 送出前讀回輸入框，必須含「這一位的」碼，否則視為失敗 |
| 崩潰續跑 | 每筆完成即 `saveGiftState()` 寫入 localStorage；「續跑未完成」只補未成功的 |
| 重複碼攔截 | `findDuplicateCodes()` 偵測到同碼給兩人時警告，且開始前需二次確認 |
| 前導零保留 | 碼一律當字串處理，`parseCodes` 絕不轉數字 |

**新函式**（全部為純函式，可單元測試）
`parseCodes` / `findDuplicateCodes` / `buildGiftPairs` / `renderGiftMessage` /
`saveGiftState` / `loadGiftState` / `clearGiftState` /
`giftDoneNames` / `exportGiftReport` / `sendGiftTo` / `runGiftBatch`

**localStorage 鍵**：`lbp_gift_state_v1`（帳本＋配對快照）、`lbp_gift_codes`（貼上的碼）、
`lbp_gift_tpl`（訊息模板）

**訊息模板**：用 `{CODE}` 當佔位符；沒有佔位符就接在結尾。

**匯出 CSV 欄位**：`禮包碼 / LINE名稱 / UID / 發送時間 / 狀態 / 失敗原因`
→ **UID 欄保留但固定留空**，由使用者事後自行填寫。

**刻意不做的事（使用者明確要求移除，別再加回來）**
- ❌ **UID 資料庫／對照表匯入**：使用者認為「要經常更新太麻煩」，只要匯出後自己填 UID。
  曾經實作過 `parseUidTable` / `uidOf` / `state.uidMap` / 匯入按鈕，已全部移除。
- ❌ **「只跑第一位（測試）」按鈕**：它會執行 `state.rows = scanRows()`，
  **把掃描好的完整名單覆蓋成畫面上可見的約 20 位**，且測到的是「畫面第一列」而非名單第一位。
  已刪除；測試請改用禮包碼區的「試發前 3 位」。

**掛鉤關係（實測確認）**
- 配對基準 = `state.rows`（**只由「掃描全部」寫入**）→ 先依「從/到」篩 `idx`，再套 `applyFilter()`
- 因此**篩選全部生效**：只發給／排除／好友＋有標籤／只傳訊的用戶一律不發
- 是否送出 = 「粘貼後自動傳送」選框（`state.autoSend`），與文字批次共用
- 配對在「預覽配對」時**鎖定成快照**；之後改範圍或篩選必須**重新預覽**才會生效

---

## 6. 踩過的坑（血淚史，別重犯）

| 症狀 | 真因 |
|---|---|
| 面板完全不出現 | `DEFAULT_TEXT` 在 `state` 之後才宣告（TDZ ReferenceError） |
| 按鈕按了沒反應 | 事件處理器沒掛上（HTML 與處理器字串縮排不符，替換失敗但處理器已插入） |
| 整個面板掛掉 | 處理器引用了不存在的元素；或清理腳本**刪過頭**（連 `buildPanel` 結尾都刪了） |
| 貼標籤永遠失敗 | 抓到外層容器而非 `<A>` → 點在空白處 |
| 找不到「存儲」按鈕 | 實際文字是「**儲存**」 |
| 捲到底只拿到 20 位 | 清單不是捲動載入，是「每次查詢多一批」 |
| 捲完再數只剩 20 位 | 清單虛擬化，捲回頂端就卸載 |
| 匯出 CSV 是空的 | 只匯出 `state.results`（批次結果），沒跑批次當然空 |
| 匯出時拋 `querySelectorAll` 錯誤 | 收集名單時沒存 `row`／`date`，匯出時去讀不存在的物件 |
| 標籤欄混入「待處理」等雜訊 | 把整列文字攤平後用黑名單過濾，欄位界線消失 |
| 腳本內的中文變亂碼 | 用 Windows PowerShell 5.1 寫檔沒加 UTF-8 BOM；`Set-Clipboard` 也一樣 |
| 日誌中文亂碼 | 伺服器寫 UTF-8，PowerShell 預設用 ANSI 讀 → 要指定 `[Text.Encoding]::UTF8` |
| 檔案替換失敗但沒發現 | PowerShell 單引號內 `` `n `` 不轉義、CRLF/LF 不符、縮排不符 → **替換後務必 `node --check`** |

**通用教訓**：任何字串替換都要 (1) 用行號或 `indexOf` 而非含縮排的字串、(2) 替換後跑 `node --check`、(3) 跑 `audit-buttons.js` 與 `audit-dupes.js`、(4) 失敗就還原備份。

**新增的第四個地雷類別**：改動 `state` 時，若「程式引用了新欄位但忘了在 `state = {}` 裡宣告」，
執行時會直接拋錯 → 整個面板建不起來（曾經發生在禮包碼功能：43 處引用、0 個宣告）。
`build\audit-state-fields.js` 就是為此而寫，**每次改動 state 後務必執行**。

### 改動後的完整驗證清單（四稽核 + 測試）

```powershell
node --check snippet\line-bulk-paste.js
node build\audit-state-fields.js     # state 欄位都必須有宣告
node build\audit-buttons.js          # 按鈕 ↔ 事件處理器 雙向對照
node build\audit-dupes.js            # 頂層函式不可重複定義
node build\audit-handlers.js         # 結構完整性（buildPanel 結尾、握把等）
node tests\test-tag-parse.js         # 78 項應全過
```

---

## 6.5 回滾（出事了怎麼辦）

**一鍵回滾**：雙擊 `rollback.cmd`
它會讀 `backups\最新版本.txt` 指向的備份，覆蓋回這六個檔案（先把現況另存一份，不刪任何東西）：

```
snippet\line-bulk-paste.js     面板本體
tests\test-tag-parse.js
server\server.js
build\build-portable.js
build\make-publish.js
HANDOFF.md
```

回滾後：LINE 分頁 `F5` → 重貼書籤即可（本機服務每次都讀磁碟檔案，不用重啟）。

**手動回滾**：把 `backups\<時間戳>\` 裡的同名檔案複製回原位即可。備份清單見 `backups\<時間戳>\backup-info.txt`。

**開發中途的安全網**：每個修改步驟都先 `Copy-Item` 一份到 `backups\pre-*.js`，失敗立刻還原。

---

## 7. 開發流程

```powershell
# 1. 改 snippet\line-bulk-paste.js（面板本體）

# 2. 驗證
node --check snippet\line-bulk-paste.js
node tests\test-tag-parse.js          # 45 項應全過
node build\audit-buttons.js           # 按鈕 ↔ 處理器
node build\audit-dupes.js             # 重複函式
node build\audit-handlers.js          # 結構完整性

# 3. 生效：LINE 分頁 F5 → 重貼書籤（服務提供的是磁碟上的檔案，改完立即可用）

# 4. 重生交付包
node build\build-portable.js
node build\make-publish.js
```

**服務**：`node server\server.js`（背景執行，`LBP_PORT` 可改埠；`/snippet.js` 提供腳本、`/ping` 健康檢查）

**讀日誌**：`logs\results-*.jsonl`，UTF-8，每行一個 JSON beacon（`tag` 欄分辨種類）。
beacon 種類：`scan` / `scrollloaded` / `item` / `done` / `tagdone` / `csvexport` / `filterpreview` / `imgtest` / `imgprobe` / `debug`

---

## 8. 目前狀態與待辦

**已完成並實測**：
- 批次發文字（20 位、133 位、504 位等多次實跑）
- 篩選（多標籤任一、好友＋有標籤、受限類型排除）
- 批次加標籤（122 位全數成功，流程：點新增標籤→輸入→Enter→點儲存）
- 批次發圖（實測送出成功，自動處理確認彈窗）
- 匯出 CSV、交付包（`publish\`，117 KB）

**未做（使用者可能之後要）**：
- **圖文同時發送**（目前「開始全部」只發文字、「批次發圖」只發圖，是兩顆獨立按鈕）
- 多標籤加註的跳過判斷只看第一個標籤（若要「全部缺才處理」需改）
- `狀態` 欄目前全空（舊資料有「待處理」，現行頁面匯出時讀不到）

---

## 9. 環境注意事項

- 目標瀏覽器：**Microsoft Edge**（Windows），LINE 官方帳號為多帳號環境
- 服務必須執行，否則書籤會 alert「本機服務沒有啟動」
- 使用者的 Edge **無法用 F12 開 DevTools**（猜測是功能鍵列或熱鍵工具攔截），
  所以早期走過 `javascript:` URL、書籤小工具等各種注入路線
- **不要主動重啟使用者的 Edge**（曾經為開除錯埠而重啟，導致他的分頁沒全部還原）
- 面板注入的 Shadow DOM host id：`lbp-host`；舊版擴充留下的 `line-bulk-paste-host` 已移除

---

## 10. GitHub 發布

| 項目 | 值 |
|---|---|
| 存放庫 | <https://github.com/zjr39/LINE-bluk-sender>（Public） |
| 預設分支 | `main` |
| 授權 | MIT，著作權人 `zjr39` |
| git | PortableGit 2.56.0（`%LOCALAPPDATA%\Programs\PortableGit`），已加入使用者 PATH |
| commit 身分 | `zjr39` / `zjr20031214@outlook.com` |

### repo 是「清理後的副本」，不是這個開發資料夾

公開內容由 `build\stage-github.js` 產生到**部署副本**
（`%USERPROFILE%\Desktop\LINE-bluk-sender-deploy`），
這個開發資料夾**完全不動、也沒有 `.git`**。

**永遠不進版控**（含真實客戶資料）：

```
logs/                       真實客戶姓名、帳號 ID、發送內容
backups/                    歷史備份（含硬編碼客戶名單）
shots/                      除錯截圖
build/vip-names.txt         122 筆真實客戶姓名
report-line-paste.*         執行報告（含帳號 ID 與客戶姓名）
snippet/*.backup*.js        舊版（含 122 筆硬編碼姓名）
snippet/*.pre*.js           修改前的快照
```

`stage-github.js` 是**只複製白名單**（不是排除黑名單），所以不可能漏掉；
並會把測試資料裡的客戶名稱換成 `Alice` / `Bob`。

### 更新流程

雙擊桌面 **`update-and-push.cmd`**（會依序做：重建副本 → commit → 安全掃描 → push）。

或手動：

```powershell
cd C:\Users\29496\Documents\DeepSeekHarness\LINE
node build\stage-github.js "$env:USERPROFILE\Desktop\LINE-bluk-sender-deploy"
cd "$env:USERPROFILE\Desktop\LINE-bluk-sender-deploy"
git add -A
git commit -m "更新說明"
git push
```

### 推送前的安全關卡

`.git` 會保留，所以重建副本不會弄壞歷史。推送前務必確認零命中：

```powershell
# U + 32 位十六進位 = LINE 官方帳號 ID 的格式
git grep -n -E "U[0-9a-f]{32}"
git ls-files
```

`push-to-github.cmd` 與 `update-and-push.cmd` 都會自動做這個掃描。

### 認證

GitHub 不接受密碼推送，需要 **Personal Access Token**（classic，勾 `repo`）：
<https://github.com/settings/tokens> —— 推送時於彈出視窗貼上。
**Token 不要寫進任何檔案、不要 commit、不要給任何人。**

### 已知小瑕疵

存放庫名稱拼字為 `bluk`（應為 `bulk`）。要改的話在 GitHub Settings → Rename，
再更新部署副本的 remote 與 `push-to-github.ps1` 裡的 `$RepoUrl`。

