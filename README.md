# 交接銜接缺口分析系統

輕量級本地 web 工具。把 **JD** 和三類內部文件（**產品架構**、**客戶名單**、**客戶狀態與交涉紀錄**）
一起餵給 Gemini，產出「這次交接哪裡會出事」的結構化分析。

不是產生漂亮的交接摘要 — 是找出 **JD 上的職責 vs 內部文件實際涵蓋** 之間的缺口。

## 快速開始

```bash
npm install
cp .env.example .env      # 填入 GEMINI_API_KEY（https://aistudio.google.com/apikey）
npm run seed              # 選用：載入 samples/ 的假資料試跑
npm start                 # → http://localhost:5173
```

## 資料怎麼放

`data/` 下四個資料夾就是資料庫，改檔案即生效；網頁上也能拖拉上傳。

| 資料夾 | 放什麼 |
|---|---|
| `data/jd/` | 職務說明書 — 交接的「應該負責什麼」那一半 |
| `data/product/` | 產品架構圖與模組說明（`.md` `.txt` 或 `.png` `.pdf` 圖檔） |
| `data/customer-list/` | 客戶名單（`.csv` 最好 — 含金額、到期日、使用模組、負責人） |
| `data/customer-status/` | 每個客戶的近幾次交涉成果、卡點、未結承諾 |

支援格式：`.md` `.txt` `.csv` `.tsv` `.json` `.yaml` `.log`（文字）、
`.png` `.jpg` `.webp` `.gif`（圖檔）、`.pdf`。
圖檔與 PDF 走 Gemini 多模態，架構圖直接丟圖檔就行。

`data/` 與 `runs/` 已在 `.gitignore` 內 — 裡面是客戶名稱與報價，不該進版控。

## 分析產出什麼

| 區塊 | 內容 |
|---|---|
| 交接準備度 | 0–100 分 + 一句話結論 + 阻擋交接的項數 |
| 銜接缺口 | 每項含嚴重度、類別、後果、交接前動作、**引用到哪個檔案** |
| 客戶覆蓋盤點 | 逐一比對名單 vs 狀態文件，抓出無人承接（orphaned）的客戶 |
| 必須補齊的文件 | 缺什麼、為什麼要、去哪拿 |
| 交接檢查清單 | 依序列出，標明該由移交人/接手人/主管負責 |

結果可複製或下載成 Markdown，也會存到 `runs/`，左側「分析紀錄」點回去看。

## 提問視窗

右下角「向文件提問」開啟浮動視窗，針對同一批文件追問。

- **建議問題按鈕**：跑過分析後，按鈕會換成模型針對這批文件生成的具體問題
  （例如「青田零售 9/15 到期，降階報價與特案申請目前處理進度？」），點一下直接發問。
  還沒跑分析時用 `lib/prompts.js` 的 `FALLBACK_QUESTIONS` 那組通用問題。
- **回答依據**：目前勾選的文件 + 最新一次的分析結果。視窗標題下方會寫清楚範圍。
- 回答**串流輸出**，每個事實後面用反引號標出來源檔名；文件沒寫的會直說「文件裡沒有寫」
  並指出該去問誰，不會自己編。
- Enter 送出、Shift+Enter 換行、Esc 關閉。只帶最近 20 則對話，避免越聊越貴。

缺口分類固定六類：職責無人承接、客戶無人負責、資料缺漏、產品知識斷點、
客戶關係風險、流程與權限未移轉（定義在 `lib/prompts.js`）。

## 範例資料刻意埋的缺口

`npm run seed` 載入的假資料裡，名單有 6 家客戶但只有 3 家有狀態文件，
且有客戶使用的 `Edge Sync` 模組在架構文件裡標註「待補」。JD 的六項職責中，
客戶稽核問卷與 pipeline 管理在內部文件中幾乎沒有對應紀錄。
這些都是分析應該抓到的東西 — 拿來驗證輸出品質。

## 操作要點

- **不勾選任何檔案** = 分析全部文件。勾選則只送勾的那些。
- **交接背景**欄位填「誰交給誰、什麼時間、接手人的經驗落差」，分析會針對性很多。
- 模型下拉是即時從 Gemini API 撈的，已濾掉圖像／語音／機器人等不相干型號。
  **但 ListModels 會列出你的帳號其實不能呼叫的型號** — `gemini-2.5-pro` 已對新用戶下架（404），
  pro 系列在免費方案沒有配額（429）。選到會跳出對應的處理建議。
  預設用 `gemini-flash-latest` 這個 alias，Google 換代時不會突然壞掉。
- 文件很大時會截斷（預設單檔 6 萬字、總量 40 萬字），上限在 `.env` 調。
  被截斷或跳過的檔案會列在結果最下方的「本次分析依據」。

## 架構

```
server.js              Express：靜態頁 + REST API（問答走 SSE 串流）
lib/store.js           data/ 四個 bucket 的讀寫、格式判斷、路徑防護、送模型前的內容組裝
lib/prompts.js         缺口分析與問答的 system instruction、responseSchema、預設建議問題
lib/gemini.js          generateContent／streamGenerateContent、退避重試、回傳解析
lib/runs.js            分析結果存檔（保留最近 50 筆）
lib/env.js             極簡 .env 讀取
public/                單頁前端，原生 ES module，無建置步驟
scripts/seed.js        samples/ → data/
```

要改分析的產出結構，改 `lib/prompts.js` 的 `GAP_SCHEMA` 與 `SYSTEM_INSTRUCTION`，
再對應調 `public/app.js` 的渲染與 `toMarkdown()`。

## 注意

伺服器沒有身分驗證，只綁本機使用。不要部署到公開網路 —
`data/` 裡是客戶資料，API 沒有任何存取控制。
