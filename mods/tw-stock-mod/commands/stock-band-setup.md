---
description: 引導使用者設定 tw-stock-mod 的台股／美股觀察清單
---

# 設定股票觀察清單

幫使用者設定 `<project>/.claude/stock-band.json`。照下面的步驟做，第 3 步的驗證不能跳過。
這份流程只涵蓋 `tw`/`us`（股票）——`futures` 觀察清單（`tf` 市場，永豐期貨帳戶）代號不吃
Yahoo spark 驗證、沒有檔數上限，設定方式見 README 的
[Taiwan futures (tf)](../README.md#taiwan-futures-tf)。

## 0. 先確認環境

在開始問代號之前，先確認看板畫得出來——不然設定寫完也是白搭。

- 跑 `claude --version`，把版號拆成三段**逐段比數字**，要 ≥ 2.1.269（不能整串當字串比大小：
  `"2.1.9" > "2.1.269"` 這種比法是錯的，2.1.9 其實比 2.1.269 舊）。
- 跑 `echo $CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`，要是 `1`。這一條本身就是判定依據，不必再翻
  settings 檔；只有印出空白時才去讀 `~/.claude/settings.json`，把該合併進去的 JSON 片段印給
  使用者自己貼上——**不要代他寫檔**，並提醒他「改完要完全關掉 Claude Code 再開，`/reload-plugins`
  不會重讀 env」。
- 互動式終端機**沒辦法從指令裡偵測**，不要假裝偵測得出來：印一句「看板只在終端機畫得出來，
  `claude -p`、桌面版、手機版不會顯示」，然後照常往下走。

前兩項只要有一項沒過，就印出對應的修法，然後問使用者「環境修好前看板不會出現，要現在先把
觀察清單設好，還是等環境修好再設」——不要沒問就默默往下做。

## 1. 檢查是否已有設定

先看 `<project>/.claude/stock-band.json` 存不存在。

- 存在 → 讀出來，跟使用者說目前 `tw` 和 `us` 清單各有哪些代號，問他是要整份重寫還是只加減幾檔。
- 不存在 → 先問他要設哪一邊（台股、美股、還是兩邊都要），再問代號。

兩邊是分開的清單，台股時段顯示 `tw`、美股時段顯示 `us`，各自算 40 檔上限。

## 2. 問使用者要哪些代號

跟使用者說清楚兩件事：

- 上限 40 檔——這是 band 的 `MAX_SYMBOLS`（`hooks/register.tsx`），不是排版限制；Yahoo 每 20 檔自動拆成一個請求，清單加上指數湊滿第 3 批時（美股 38 檔起、台股 40 檔）更新間隔會從 30 秒放慢到 36 秒。
- 看板一次只顯示 5 檔，超過 5 檔會自動翻頁（40 檔就是 8 頁輪流顯示），不是全部擠在一起。

代號跟公司名稱都收下來；名稱留白也沒關係，可以之後用 Yahoo 回傳的資料補上。

## 3. 驗證每個代號真的能報價——不要跳過

台股跟美股都用 Yahoo 的 spark endpoint 驗證；差別只在台股要多帶交易所後綴分辨上市／上櫃。

### 3a. 台股：打 Yahoo spark，同時帶 `.TW` 與 `.TWO` 後綴

band 的台股報價預設走 Yahoo（`twSources: ["yahoo"]`，見 3b），或 `twSources: ["shioaji"]`
（永豐即時，見 README）時也是走同一批代號。驗證代號用同一支 spark endpoint——代號本身看不出
是上市還是上櫃，所以每個代號**同時查兩個後綴**：

```
https://query1.finance.yahoo.com/v7/finance/spark?symbols=2330.TW,2330.TWO,6488.TW,6488.TWO&range=1d&interval=5m
```

回傳的 `spark.result` 只會列出查得到的那個後綴，查不到的後綴直接不出現在陣列裡（不是空物件）。
所以：

- `.TW` 有資料 → 上市，設定檔照常寫 `{ "code": "2330", "name": "台積電" }`。
- `.TWO` 有資料 → 上櫃，**設定檔必須多寫 `"ex": "otc"`**（例：
  `{ "code": "6488", "name": "環球晶", "ex": "otc" }`）。漏了這個欄位，band 會去查
  `6488.TW`，那個後綴查不到這檔，這一列就永遠沒有價格。
- 兩個後綴都沒回 → 代號查不到，**明確跟使用者說是哪幾檔**，不要默默寫進檔案。

這支端點跟 3b 一樣要帶瀏覽器 User-Agent。

### 3b. 美股：打 Yahoo spark

寫入設定檔之前，先用下面的 URL 打一次 Yahoo 的 spark endpoint，確認每個代號都有報價：

```
https://query1.finance.yahoo.com/v7/finance/spark?symbols=<用逗號分隔的代號>&range=1d&interval=5m
```

一次最多帶 20 個代號——Yahoo 對超過 20 個的請求會直接拒絕，不要分批塞超過這個數字。

打的時候要帶瀏覽器的 User-Agent（Yahoo 對沒有 User-Agent 的請求同樣會拒絕），例如：

```
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)
```

檢查回傳的 `spark.result` 裡每個代號是否都有資料：

- 有報價 → 這檔才算驗證過，可以寫進設定檔。
- Yahoo 沒回應這個代號（代號打錯、已下市，或不是美股代號）→ **明確跟使用者說哪些代號查不到**，不要默默略過，也不要把沒驗證過的代號默默寫進檔案。

## 4. 寫入設定檔

- `.claude/` 資料夾不存在就先建起來。
- 如果 `.claude/stock-band.json` 已經存在，**先把新舊內容的差異（diff）展示給使用者看，等他同意才覆蓋**——不要沒問就整份蓋掉既有設定。
- 把驗證過的代號寫進對應的 `tw` / `us` 陣列。**只有 `code` 是必填**，寫
  `{ "code": "NVDA", "name": "NVIDIA" }` 就夠了。台股上櫃多一個 `"ex": "otc"`（見 3a）。
- **不要自己編 `prevClose`。** 這個欄位是昨收價，band 拿它算漲跌幅；填一個猜的數字，使用者會在畫面上看到錯的漲跌幅，而且看不出是假的。省略它，即時報價會帶正確的昨收價進來。真的要寫死，只能填這次驗證時回傳的昨收（Yahoo 的 `meta.previousClose`），不能拿當下價格代替。

## 5. 提醒使用者重新載入

設定寫完後，提醒使用者跑一次 `/reload-plugins`。刷新頻率（`refreshMs`／`feedMs`）是 session 一開始就固定的，改了設定檔要重新載入 plugin 才會生效，單純等下一輪 poll 是吃不到新設定的。

## 附註：`twSources`（報價來源順序）別寫進專案設定檔

`twSources`（例如 `["shioaji", "yahoo"]`）跟 `shioaji` 區塊是**個人偏好**，不是專案設定——band 讀 `~/.claude/stock-band.json`（使用者層級，不進版本控制）疊在 `<project>/.claude/stock-band.json` 之下再合併。如果使用者要設定報價來源順序或永豐帳號路徑，寫進 `~/.claude/stock-band.json`，不要寫進這裡正在編輯的專案檔——這樣專案設定才能保持中立，其他人打開同一個專案時用的是他自己的順序。細節見 README 的「Your own source order」與 `references/quote-sources.md` 的「Preference order and the user-level file」。
