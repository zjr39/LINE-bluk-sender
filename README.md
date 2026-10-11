# LINE 聯絡人批次助手

給 **LINE 官方帳號管理後台**（chat.line.biz）「聯絡人」頁面用的批次工具。
以**書籤小工具**在頁面注入一個控制面板，不需要安裝瀏覽器擴充功能。

> 繁體中文文件 ｜ [English summary](#english-summary)

---

## ⚠️ 負責任使用聲明（請務必先讀）

**這個工具會真的把訊息發送給你的客戶，送出後無法收回。**

- 發送前請確認你**有權限**對這些聯絡人發送訊息，並遵守
  [LINE 官方帳號使用規範](https://www.linebiz.com/tw/) 與你所在國家／地區的法令
  （包含但不限於個人資料保護、電子通訊與廣告相關規範）。
- **不要**用它發送垃圾訊息、未經同意的廣告，或任何騷擾性內容。
- 大量、短時間、內容重複的發送行為有被平台限制的風險，請自行評估發送頻率。
- **第一次使用務必先小範圍測試**（只跑 1 位），確認文案與對象正確後再跑全部。
- 本軟體依「現狀」提供，**作者不對使用後果負任何責任**。詳見 [LICENSE](LICENSE)。

---

## 功能

| 功能 | 說明 |
|---|---|
| **批次發送文字** | 逐位開啟聊天室 → 粘貼文字 →（可選）自動送出 |
| **批次發送圖片** | 選一張本地圖片，對名單逐位發送（自動處理 LINE 的確認彈窗） |
| **批次貼標籤** | 對指定名單批次加上一個或多個標籤 |
| **個人化禮包碼** | 每個人收到不同的碼，同一段文案；發完產出「禮包碼／LINE 名稱／UID」對照表 |
| **篩選** | 多標籤任一、名稱清單、排除關鍵字、只發好友＋有標籤、受限類型自動排除 |
| **匯出 CSV** | 聯絡人清單（姓名／標籤／類型／狀態／日期／是否發送）與批次結果 |

### 幾個實測得來的重要行為

- **「只傳訊的用戶」一律不發**，即使他有 VIP 標籤 —— 這是 LINE 的平台限制，官方帳號無法對這類用戶發起聊天。
- **圖片無法只附加不送出**。選圖後 LINE 一定跳出「確定要傳送檔案至此聊天室嗎」，按「傳送」就立即發給客戶。
- 聯絡人清單是**分批載入**的，不是捲動載入。跑批次前**一定要先按「掃描全部（反覆載入）」**，否則會漏掉後面的聯絡人。
- 每位對象在粘貼前都會**核對目前開啟的聊天室是不是本人**，不符就跳過並記為失敗，不會貼錯人。
  但**同名聯絡人無法自動區分**，面板會提出警告。

---

## 快速開始

### 需要什麼

- Windows + Microsoft Edge（其他 Chromium 瀏覽器應可用，未經完整測試）
- [Node.js](https://nodejs.org/) 18 以上（LTS 版即可）
- 可登入 LINE 官方帳號管理後台的帳號

### 三步安裝

**1. 下載專案**

```cmd
git clone https://github.com/zjr39/LINE-bluk-sender.git
cd LINE-bluk-sender
```

或用 GitHub 網頁右上角 **Code → Download ZIP** 解壓。

**2. 啟動本機服務**

雙擊 `start-server.cmd`（或 `node server/server.js`）。
看到這段就成功：

```
  ✅ 服務已啟動
     面板腳本： http://127.0.0.1:8765/snippet.js
```

> **這個視窗要一直開著**，關掉它面板就會失效。服務只是把面板腳本提供給書籤，不會連到任何外部伺服器。

**3. 安裝書籤小工具**

用 Edge 開啟 `docs/安裝說明.html`，頁面會自動偵測服務狀態，然後把那顆綠色按鈕**拖到書籤列**。

> 拖曳沒反應？按 `Ctrl+Shift+O` 開書籤管理員 →「⋯」→「新增書籤」，
> 名稱填 `LINE 批量助手`，網址貼上安裝頁最下方那串。

### 使用

1. 登入 LINE 官方帳號管理後台，打開「**聯絡人**」頁面
2. 點一下書籤列上的「**LINE 批量助手**」→ 畫面右上角出現綠色面板
3. 貼上要發送的內容 → 按「**掃描全部（反覆載入）**」→「**預覽名單**」確認對象
4. 先小範圍測試 → 確認無誤後「**開始全部**」

完整操作說明（含各功能與常見問題）：[docs/使用說明.md](docs/使用說明.md)

---

## 專案結構

```
LINE-bluk-sender/
├── snippet/line-bulk-paste.js    ★ 面板本體（所有邏輯都在這一個檔案）
├── server/server.js                本機服務：把面板腳本提供給書籤
├── tests/test-tag-parse.js       ★ 單元測試（83 項）
├── docs/
│   ├── 安裝說明.html                給同事看的安裝頁（會偵測服務狀態）
│   ├── 使用說明.md                  完整使用文件
│   └── start-server.cmd             交付版啟動腳本（缺 Node 會自動安裝）
├── build/                          稽核與打包工具
│   ├── audit-state-fields.js       state 欄位是否都有宣告
│   ├── audit-buttons.js            按鈕 ↔ 事件處理器雙向對照
│   ├── audit-dupes.js              頂層函式不可重複定義
│   ├── audit-handlers.js           結構完整性
│   ├── preflight.js                殘留符號與未定義函式掃描
│   ├── build-portable.js           產生交付包（含安裝說明）
│   └── make-publish.js             產生 publish 資料夾
├── start-server.cmd
├── HANDOFF.md                    ★ 技術交接文件（設計決策、踩過的坑、LINE 頁面結構）
└── LICENSE
```

---

## 開發

面板本體是**單一檔案** `snippet/line-bulk-paste.js`。改完存檔後，服務提供的就是磁碟上的最新版本，
只要在 LINE 分頁按 `F5`、重新點一次書籤即可生效（**不需要重啟服務**）。

### 改完一定要跑這五個檢查

```cmd
node --check snippet\line-bulk-paste.js
node build\audit-state-fields.js
node build\audit-buttons.js
node build\audit-dupes.js
node build\audit-handlers.js
node tests\test-tag-parse.js
```

最後一項應該顯示 `✅ 全部通過：83 項`。

這四個稽核不是裝飾用的 —— 這個專案實際發生過這些問題，每個稽核都是為了攔住其中一類：

| 稽核 | 攔住的問題 |
|---|---|
| `audit-state-fields` | 程式引用了 `state.xxx` 但忘了在 `state = {}` 宣告 → 面板一開就拋錯建不起來 |
| `audit-buttons` | HTML 少了按鈕但處理器已加 → `$()` 回傳 undefined → 整個面板掛掉 |
| `audit-dupes` | 同名函式重複定義，後者覆蓋前者 |
| `audit-handlers` | 清理腳本刪過頭（連 `buildPanel` 的結尾都刪掉） |

### 架構說明（為什麼是書籤小工具）

走不通的路都試過了，記錄下來避免重複踩坑：

- **CDP / remote debugging**：Edge 預設設定檔會忽略 `--remote-debugging-port`
- **瀏覽器擴充功能**：可行，但要同事開開發人員模式載入解壓縮檔，太麻煩
- **單一自足 HTML**：腳本內嵌後編碼長度超過書籤上限
- **`file://` 載入腳本**：https 頁面禁止載入本機檔案
- **Windows UIA / 座標點擊**：Chromium 的無障礙樹會休眠，不穩定

最後採用：**本機服務（127.0.0.1:8765）+ 書籤小工具**，書籤只有 206 字元。

技術細節、LINE 頁面的 DOM 結構、踩過的坑，全部記在 [HANDOFF.md](HANDOFF.md)。

---

## 已知限制

- 只支援 Windows + Edge（Chromium）
- 聯絡人清單為分批載入，掃描需要時間；清單越長越久
- 同名聯絡人無法自動區分
- 圖片無法「只附加不送出」（LINE 的設計）
- 訊息模板與面板設定存在瀏覽器 localStorage，換瀏覽器或清除資料後會消失
- 沒有多語系介面（介面文字為繁體中文）

---

## English summary

A bookmarklet-based bulk tool for the **LINE Official Account Manager** contact page
(chat.line.biz). It injects a control panel into the page — no browser extension required.

Features: batch text sending, batch image sending, batch tagging, personalized gift codes
(one unique code per contact with a shared message template), contact filtering, and CSV export.

**Requires** Windows + Edge and Node.js 18+. Run `node server/server.js` (or double-click
`start-server.cmd`), then install the bookmarklet from `docs/安裝說明.html`.

⚠️ **This tool really sends messages to your customers and cannot be undone.**
Only use it on contacts you are permitted to message, comply with the LINE Official Account
terms and your local laws, and never use it for spam. Test on a single contact first.
Provided "as is", without warranty of any kind — see [LICENSE](LICENSE).

---

## 授權

[MIT](LICENSE) © 2026 zjr39
