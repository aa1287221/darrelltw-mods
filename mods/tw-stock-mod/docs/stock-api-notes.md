# 股價來源盤點（cc-stock-band 接 API 的規劃）

> 📍 **要選報價來源、接永豐／自己的 fetcher，看
> [`mods/cc-stock-band/references/quote-sources.md`](../mods/cc-stock-band/references/quote-sources.md)。**
> 這份筆記是那個選擇背後的證據——每個端點、每個數字、每個踩過的坑都留在這裡，
> 但不是「現在該接哪個」的入口，那份 reference 才是。

> 🔴 **2026-09-16 更新：兩邊都接上了，Yahoo 是兩個市場的預設。** 現況的 source
> of truth 是文末 **§6（美股／Yahoo，2026-09-15）** 與 **§7（台股批次補測，
> 2026-09-16）**；台股當前實作細節見上面連結的 reference。§1-§5 保留當作來源
> 盤點，但 §1 的架構結論已經作廢（hooks 模組有 `$.http.fetch`，不需要外部
> fetcher）。

> 🔴 **2026-09-18 更新：第三個市場（加密貨幣）接上了，資料層與設定 only —
> 市場切換 UI 是下一階段。** source of truth 是文末 **§11（Pionex，
> 2026-09-18）**。跟 tw/us 不同：24/7 無開收盤、不進 auto 市場輪替（只有
> `market: "crypto"` 明確指定才顯示）、漲跌是 24 小時漲跌不是對昨收。

現況：**三個市場都由 hooks 模組自己抓**，tw/us 預設都是 Yahoo（免金鑰、台美
一支 API 搞定），crypto 預設是 Pionex（免金鑰，見 §11）。台股要盤中真即時，
macOS／Linux 接永豐 Shioaji（見 §8）、Windows 接群益 Capital（見 §10）；其他
券商／付費行情走 `.claude/stock-quotes.json` 這個 override 檔案接縫（見
§9）——這個接縫目前只服務 tw/us，crypto 還沒接進去。

> ⚠️ §1-§5 的驗證狀態：這些端點是在更早的 session 盤點的，當時對外連線走政策代理，
> 這幾支端點的 CONNECT 都被 gateway 回 403（組織政策拒絕，不是端點壞掉），
> 所以**沒有實測過**。2026-09-15 在本機重測的結果以 §6 為準。

## 1. ~~架構決定：API 不要寫在 hooks 模組裡~~（已作廢，見 §6）

> ❌ **這一節的結論是錯的。** function hooks 有 `$.http.fetch(url, init)`
> （型別在 `.claude/types/claude-code.d.ts`，`$` 上還有 `$.process` 可以跑指令）。
> 所以模組可以自己抓價，不需要外部 fetcher、不需要 cron。實際做法見 §6。
> 下面保留原本的推論，因為那個「檔案接縫」仍然存在，只是降級成 override 用。

`hooks/register.tsx` 只用 `$.clock` / `$.fs` / `$.ui`（見 `docs/api-notes.md`）。
function hooks 目前**沒有經過驗證的 fetch/網路 API**，而且 API key 放進 plugin
目錄也不對。所以分工是：

```
外部抓價程式（scripts/fetch-quotes.*，cron 或背景 loop）
        │  每 10-20 秒寫一次
        ▼
<project>/.claude/stock-quotes.json      ← 格式見 mods/cc-stock-band/stock-quotes.example.json
        │  hooks 模組每 3 秒讀一次（$.fs.read）
        ▼
band（hooks/register.tsx → hooks/board.tsx）
```

這個接縫**已經寫好了**：report 檔存在且 `asOf` 在 120 秒內，band 就用檔案裡的
價格、右下角標記改成「報價檔」；檔案不在、過期或壞掉就自動退回示範資料。
換句話說「接 API」= 寫一支只負責產生那個 JSON 的程式，band 不用再改。

金鑰放 `~/.claude/stock-band.env` 之類的檔案由抓價程式讀，不要進 repo。

## 2. 台股候選（有，而且免費的不少）

| 來源 | 端點 / 方式 | 認證 | 即時性 | 備註 |
| --- | --- | --- | --- | --- |
| 台灣證券交易所 OpenAPI | `https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_AVG_ALL`、`.../BWIBBU_ALL`、`.../MI_INDEX` | 無 | **日頻**（收盤後） | 官方、穩定、有 swagger。當「昨收 / 收盤價」基準很好用，不能當盤中報價。 |
| 台灣證券交易所日成交 | `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=20260901&stockNo=2330&response=json` | 無 | 日頻 | 單檔歷史，補 `prevClose` 用。 |
| 櫃買中心 OpenAPI | `https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes` | 無 | 日頻/延遲 | 只有上櫃需要。目前 5 檔都是上市，用不到。 |
| FinMind | `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=2330&start_date=...` | 免費 token（有額度） | 日頻為主 | 歷史/回測方便，盤中不建議。 |
| 富果 Fugle | `https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/2330`（`X-API-KEY`） | 需申請（富果帳戶） | **真即時**，有 WebSocket | 想要秒級更新就走這條。 |
| 永豐 Shioaji | Python SDK | 需券商帳號＋憑證 | 真即時 tick | 重裝備，band 用不到這麼重。 |
| Yahoo Finance（非官方） | `https://query1.finance.yahoo.com/v8/finance/chart/2330.TW?interval=1m&range=1d` | 無 | 約 15 分延遲 | 好處是**台美一支搞定**（`2330.TW`、`0050.TW`、`006208.TW`、`NVDA`）。`meta.regularMarketPrice` / `meta.chartPreviousClose` 就是我們要的兩個數。非官方 API，會變、會 429。 |

結論：**台股有免費可用的來源** → Yahoo 當主力（免金鑰、台美一支搞定，但台股
落後約 20 分鐘），昨收/收盤用 OpenAPI 或 Yahoo 的 `meta.previousClose`，要更
即時就換永豐或富果。

## 3. 美股候選

| 來源 | 端點 | 認證 | 即時性 | 免費額度 |
| --- | --- | --- | --- | --- |
| **Finnhub**（首選） | `https://finnhub.io/api/v1/quote?symbol=NVDA&token=...` | 免費 key | 美股即時 | 約 60 calls/min，5 檔每 5 秒綽綽有餘。回傳 `c` 現價、`pc` 昨收、`d`/`dp` 漲跌，欄位剛好對上 band。 |
| Yahoo chart（非官方） | 同上，`.../chart/NVDA` | 無 | ~15 分延遲 | 無金鑰、台美同一支，最省事的第一版。 |
| Stooq CSV | `https://stooq.com/q/l/?s=nvda.us&f=sd2t2ohlcv&h&e=csv` | 無 | 延遲/EOD | 純 CSV 好解析，當 fallback。 |
| Twelve Data | `https://api.twelvedata.com/quote?symbol=NVDA&apikey=...` | 免費 key | 延遲/即時分方案 | 約 800/day、8/min。 |
| Alpha Vantage | `GLOBAL_QUOTE` | 免費 key | 延遲 | 25 req/day，**不夠**跑常駐 band。 |
| Polygon | `/v2/last/trade/...` | 免費 key | 延遲 15 分 | 免費 5 req/min。 |

（IEX Cloud 已停止服務，不要用。）

## 3.5 K 棒（趨勢圖要的資料）

band 的趨勢圖需要「一檔、依時間排好的 OHLC 陣列」（約 31 根就塞滿 80 欄），
sparkline 只需要收盤價序列（20 點）。上面那些「即時報價」端點大多**只給當下快照**，
所以 K 棒要另外一條路：

| 來源 | K 棒端點 | 粒度 | 備註 |
| --- | --- | --- | --- |
| **Yahoo chart**（最省事） | `https://query1.finance.yahoo.com/v8/finance/chart/2330.TW?interval=5m&range=1d` | 1m/5m/15m/1d | `timestamp[]` 搭 `indicators.quote[0].{open,high,low,close}`，直接對上 `bars`。台美同一支、免金鑰，但非官方、約 15 分延遲。第一版建議走這條。 |
| 富果 Fugle | `/marketdata/v1.0/stock/historical/candles/{symbol}?timeframe=5` | 1/5/10/30/60 分、日 | 台股真即時 K，需金鑰。 |
| 台灣證券交易所 STOCK_DAY | `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=...&stockNo=2330&response=json` | **日 K** | 官方，但盤中畫不出當日走勢。 |
| FinMind | `dataset=TaiwanStockPrice`（日）／分 K 與 tick 在較高方案 | 日／分 | 免費額度以日 K 為主。 |
| Twelve Data | `time_series?symbol=NVDA&interval=5min` | 1/5/15/30/60 分、日 | 美股 K 棒免費額度可用（800/day）。 |
| Polygon | `/v2/aggs/ticker/NVDA/range/5/minute/...` | 任意聚合 | 免費延遲 15 分、5 req/min。 |
| Finnhub | `/stock/candle` | 分/日 | ⚠️ 免費方案對 candle 端點的開放狀況會變，接之前先用自己的 token 打一次確認；`/quote`（現價）不受影響。 |

實務上最順的組合：**現價走 Yahoo（台股）/ Finnhub（美股），K 棒走 Yahoo chart 或
富果**；fetcher 兩邊都寫進同一個 `stock-quotes.json`（`price` 用即時的、`bars` 用
K 棒來源的），band 不需要知道它們來自不同地方。

## 4. 建議的第一版實作

1. `scripts/fetch-quotes.py`（還沒寫）：讀 `.claude/stock-band.json` 的清單 →
   台股打 Yahoo spark 一次抓清單＋加權指數；美股打 Finnhub（或先用 Yahoo 免金鑰版）
   → 寫 `.claude/stock-quotes.json`。趨勢圖要的 `bars` 頻率低很多（每檔 1-5 分鐘
   更新一次就夠），跟現價分開排程，別每 10 秒重抓一次 K 棒。
2. 只在該市場開盤時抓（開盤判斷的規則已經在 `register.tsx`：
   台股 09:00-13:30 UTC+8、美股 09:30-16:00 ET 含日光節約時間），收盤後停手，
   band 會自動顯示「收盤 13:30」。
3. 抓價失敗就**不要動** `stock-quotes.json`：120 秒後 band 自己退回示範資料，
   不會在畫面上留下一個假裝是即時的舊價格。
4. 還缺的：台股假日行事曆（現在只判斷週一到週五，`phaseOf()` 有標 PROTOTYPE LIMIT）。
   台灣證券交易所有「開休市日期」開放資料可以之後補。

## 5. 自己機器上的驗證指令

```sh
# 台股官方日頻
curl -sS 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_AVG_ALL' | head -c 300

# 台美同一支（非官方）；interval=5m 的版本就是趨勢圖要的 K 棒
curl -sS -A 'Mozilla/5.0' 'https://query1.finance.yahoo.com/v8/finance/chart/2330.TW?interval=1d&range=2d' | head -c 400
curl -sS -A 'Mozilla/5.0' 'https://query1.finance.yahoo.com/v8/finance/chart/2330.TW?interval=5m&range=1d' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["chart"]["result"][0]; q=d["indicators"]["quote"][0]; print(len(d["timestamp"]), "bars"); print(list(zip(q["open"],q["high"],q["low"],q["close"]))[-3:])' 

# 美股即時（要自己的 token）
curl -sS "https://finnhub.io/api/v1/quote?symbol=NVDA&token=$FINNHUB_TOKEN"
```

---

## 6. 已實作（2026-09-15 實測）

**這一節是現況的 source of truth。** 以下每個數字都是在這台機器上實際跑出來的，
不是查文件抄的；查來的東西會標明出處。

### 6.1 架構：hooks 模組自己抓，沒有外部 fetcher

`$.http.fetch(url, { method, headers, body, auth })` 存在且可用
（`.claude/types/claude-code.d.ts`；`$.process` 也在，可以跑指令）。所以：

```
hooks/register.tsx  ──$.http.fetch──▶  query1.finance.yahoo.com
        │  每 feedMs（預設 30 秒）一次
        ▼
  模組記憶體裡的 live 快照 ──▶ hooks/board.tsx
```

`.claude/stock-quotes.json` 那個檔案接縫**還在**，但降級成 override：
檔案新鮮（`asOf` 在 120 秒內）就壓過 feed，否則用 feed，兩個都沒有才退回示範資料。
右下角標籤分三種：`Yahoo 即時` / `報價檔` / `示範資料（未接 API）`。

### 6.2 用哪兩支端點

| 用途 | 端點 | 一次要幾個請求 |
| --- | --- | --- |
| 現價＋昨收＋當日 5 分鐘收盤序列 | `https://query1.finance.yahoo.com/v7/finance/spark?symbols=A,B,C&range=1d&interval=5m` | **1 個**（整個清單＋指數一次打包） |
| 單檔 OHLC（K 棒） | `https://query1.finance.yahoo.com/v8/finance/chart/<SYM>?range=1d&interval=5m&includePrePost=false` | 每檔 1 個 |

spark 回的 `spark.result[].response[0]` 裡：`meta.regularMarketPrice`（現價）、
`meta.previousClose`（昨收）、`meta.regularMarketTime`（**成交時戳**，band 拿它當
「更新」時間）、`indicators.quote[0].close[]`（當日 5 分鐘收盤序列，給 sparkline）。

三大指數 `^DJI` / `^GSPC` / `^IXIC` 跟股票在同一個 spark 請求裡，**多抓不用多打**。

### 6.3 三個會讓你以為壞掉的坑（都實測過）

1. **沒帶瀏覽器 User-Agent 直接 429**，第一個請求就擋。可用的 UA 是
   `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)`（短的那種）。
   實測**長版 Chrome UA 一樣被 429**，不是「有 UA 就好」。
   被擋之後這台機器約 3 分鐘才恢復。
2. **同一個 URL 會被快取，價格整個凍住。** 實測 80 秒內連抓 6 次，回來的位元組數
   完全一樣、`regularMarketPrice` 一個字都沒變。對策：每個請求帶
   `_=<timestamp>` 並加 `Cache-Control: no-cache` / `Pragma: no-cache`。
   加了之後每 15 秒抓都看得到價格在動。
3. **`$.http.fetch` 的錯誤不會自己浮上來**——非 2xx 要自己判 `res.ok`。

### 6.4 速率限制（🔴 這條會影響設定，別亂調）

Yahoo 這幾支是**沒有官方文件**的內部端點，也沒有官方公布的限制。
社群收斂出來的數字是**每小時 360 個請求**
（出處：[yfinance #2128](https://github.com/ranaroussi/yfinance/issues/2128)，
一個使用者跑 7000 檔、到第 950 個開始吃 429，量級對得上）。

實測過的部分：2 秒間隔連打 12 次、5 秒間隔連打 10 次，共 22 個請求全部 200。
**但那只有 24 秒，證明不了持續跑一小時會怎樣**，別拿它當「2 秒可以用」的依據。

對照現在的設定：

| 設定 | 每小時請求 | 對 360 |
| --- | --- | --- |
| 30 秒（預設） | 120 | 1/3，安全 |
| 30 秒 + `trend: kbar` | 240 | 2/3 |
| 15 秒（`FEED_MS_MIN`） | 240 | 2/3 |
| **15 秒 + `trend: kbar`** | **480** | **超標 1.3 倍** ⚠️ |
| 2 秒 | 1800 | 5 倍，一定被擋 |

🔴 **已知缺陷（尚未修）**：`FEED_MS_MIN = 15_000` 只管間隔、不管總量，
所以「15 秒 + K 棒」這個組合設得出來而且會超標。修法是改成用「每小時請求預算」
往回推最小間隔（預算抓 300/小時：單請求 → 12 秒；帶 K 棒 → 24 秒）。
預設值（30 秒、K 棒關）不會踩到。

失敗時的行為：每次非 2xx 就把等待時間加倍，最多退到 5 分鐘；**絕不編價格**，
上一份快照撐 120 秒後就退回示範資料並改標籤。

### 6.5 備選來源（2026-09-15 查證）

| 來源 | 結論 |
| --- | --- |
| **Yahoo（現用）** | 台美一支搞定。實測台股符號也通：`2330.TW` / `0050.TW` / `^TWII` 都回得來，所以之後接台股是加後綴的事，不用換來源。風險是非官方端點，會改格式、可能哪天要 cookie+crumb。 |
| **Finnhub** | ❌ **當不了備選。** 官方帳號在自家 repo 明講 free plan **從來沒有**開放 `/stock/candle`（[#546](https://github.com/finnhubio/Finnhub-API/issues/546)），所以 sparkline 和 K 棒全都拿不到，只剩一個現價數字。而且 `/quote` 不能批次（5 檔＝5 個請求，Yahoo 是 1 個），免費 60 calls/min 換算下來最快只能 6 秒一輪。免費版只有美股（[#397](https://github.com/finnhubio/Finnhub-API/issues/397)）。唯一勝過 Yahoo 的地方：它是有文件的正式 API。 |
| Shioaji | ❌ 只有台灣市場，合約種類 STK/FUT/OPT/IND/WRT，交易所 TSE/OTC/TAIFEX。**沒有美股、沒有海外期貨**（[官方 tutor](https://sinotrade.github.io/tutor/contract/)）。永豐的複委託是券商業務，這支 API 沒開。且需券商帳號＋憑證，本機沒設定。 |
| Stooq | ❌ 走不通，報價 CSV 端點 `https://stooq.com/q/l/?s=nvda.us&f=sd2t2ohlcv&h&e=csv` 回 404。 |

### 6.6 驗證手法（下次改版直接複用）

動畫和版面**不能靠截圖問使用者**，要自己看。scratchpad 裡有一組 pty 探針：

```
pty.fork() + TIOCSWINSZ 45x140 + TERM=xterm-256color
  → 跑真的 claude --debug-file <log>
  → 把輸出餵進 pyte（終端機模擬器）還原「真正畫在螢幕上的字」
  → 每 0.02 秒取一次 screen.display，記錄有變化的那一列
```

🔴 **不要直接對原始輸出流做 regex**——終端機只重畫有變動的格子，抓到的是資料流
不是畫面，會讀出不存在的畫面（本 session 就這樣誤判過閃燈沒在動）。一定要過 pyte。

pyte 需要 patch 掉 `report_device_status`（Claude Code 會送 private DSR，pyte 會炸）：

```python
class S2(pyte.Screen):
    def report_device_status(self, *a, **k): pass
```

型別檢查：`npx --yes -p typescript@5.6 tsc -p mods/cc-stock-band/tsconfig.json`
（本機沒有 tsc 也沒有 node_modules，要用 `-p` 帶套件名，`npx typescript tsc` 會失敗）。

## 7. 2026-09-16 補測：spark 的代號上限與批次成本

**spark 端點一次最多 20 個代號**，這是 Yahoo 明講的，不是猜的：

```
$ curl '.../v7/finance/spark?symbols=<21 個代號>&range=1d&interval=5m'
{"spark":{"result":null,"error":{"code":"Bad Request",
 "description":"Number of symbols needs to be less than or equal to 20"}}}
```

逐一試出來的邊界（同一次量測，UA 帶瀏覽器字串）：

| 代號數 | HTTP | 回幾筆 |
| --- | --- | --- |
| 18 | 200 | 18 |
| 19 | 200 | 19 |
| 20 | 200 | 20 |
| 21 | 400 | – |
| 25 | 400 | – |

所以觀察清單上限原本訂在 **20 檔**（＝看板 4 頁 ×5 列）。清單 20 檔 + 3 個指數 = 23，
一次 tick 要拆成兩個請求。2026-09-19 起 `MAX_SYMBOLS` 放寬到 40：`fetchSpark` 本來就每
20 檔拆一批，§7.1 的速率預算會照批數放慢間隔，所以上限只剩頁數考量。

### 7.1 速率預算（取代只看間隔的舊做法）

`feedMs` 只是間隔，**間隔不等於速率**：一次 tick 發幾個請求會把總量乘上去。
現在 `register.tsx` 用每小時 300 個請求的預算反推最短間隔：

| 清單長度 | trend | 一次 tick 請求數 | 最短間隔 |
| --- | --- | --- | --- |
| ≤17 檔 | none | 1 | 15 秒（FEED_MS_MIN） |
| 18-20 檔 | none | 2 | 24 秒 |
| 18-20 檔 | kbar | 3 | 36 秒 |

被撐開時 `$.ui.log` 會寫一行說明。§6.4 那張「15 秒 + kbar = 480/hr 超標」的表
已經被這個機制擋掉了，不會再靠使用者自律。

### 7.2 效能（2026-09-16 實測，45 秒視窗 ×3 取中位數）

量的是整個 process tree 的 **cumulative CPU time 差值**，不是 `ps %cpu`
（後者是自開機以來的衰減平均，對「這 45 秒花多少」完全沒有意義）。

| 設定 | CPU | 峰值 RSS |
| --- | --- | --- |
| 不裝 band | 1.1% | 407 MB |
| 20 檔 animation full | 4.8% | 440 MB |
| 20 檔 animation off | 3.3% | 433 MB |
| off + countdown false | 2.2% | 423 MB |

+33 MB 是 hooks 的 worker process，跟動畫無關。動畫本身約 2.6 個百分點的 CPU，
所以 `animation: "off"` 是有意義的設定，不是裝飾。

⚠️ 單次量測的雜訊約 ±0.3 個百分點，會蓋掉小幅最佳化——要比較就跑 3 次取中位數。
腳本：scratchpad `perf_rep.py`（同時會改 `.claude/settings.json` 開關 plugin，
結束時還原）。


### 7.3 台股批次與已知坑（Yahoo）

台股 spark 一樣能把清單＋加權指數包進同一個請求（見 §6.2）；`^TWII`（加權指數）
沒問題，但 **`^TWOII`（櫃買指數）回的是 2024-10-12 的收盤、序列長度 0，不能用**
（2026-09-16 實測）——台股指數目前只能顯示 `^TWII` 一個。K 棒一樣走 Yahoo chart，
每檔 1 個請求、round-robin。


---

## 8. 永豐 Shioaji（2026-09-16 實測，走報價檔那條路）

### 8.1 先講結論：沒有「永豐 CLI」這種東西

`pip install shioaji` 會裝一個 `shioaji` 執行檔。實際跑：

```
$ shioaji --help
Hello from shioaji!
```

原始碼就是 `def main(): print("Hello from shioaji!")`（`shioaji/__init__.py:18`）。
**它不是 CLI，只是一個 placeholder entry point。** 永豐的介面就是那個 Python SDK，
所以「支援永豐 cli」實際做出來的東西是一支我們自己的腳本：
`mods/cc-stock-band/scripts/fetch-quotes-shioaji.py`。

### 8.2 為什麼不直接接進 hooks 模組

Yahoo 是「一個 HTTP GET 就有價格」，`$.http.fetch` 直接打。Shioaji 不是：

- 它是 Python SDK，hooks 模組跑在 JS 沙箱裡，只能用 `$.process` 去 spawn。
- `api.login()` 要幾秒，而且會**建立並持有一個 session**（實測 login 後
  `api.usage()` 回 `connections=1, limit_bytes=524288000`）。每 30 秒 spawn 一次
  等於每 30 秒登入登出一次，錯的離譜。

所以走的是 band 早就留好的 override 接縫：腳本登入一次、常駐、每 N 秒改寫
`<project>/.claude/stock-quotes.json`，band 每 3 秒讀一次，右下角顯示 `永豐 即時`
（這一版新增：報價檔可以用 `"source"` 欄位自己命名、用 `"indices"` 交出整組指數）。

### 8.3 用到的 API

| 要什麼 | 怎麼拿 |
| --- | --- |
| 現價／開高低／漲跌 | `api.snapshots([contract, ...])` → `close`、`open`、`high`、`low`、`change_price`、`change_rate`、`ts` |
| 昨收（漲跌基準） | `contract.reference`（2330 實測 2380.0） |
| 上市／上櫃 | `api.Contracts.Stocks["6488"]` **自己解析**，不必像其他路線那樣在設定檔標 `"ex": "otc"` |
| 加權指數 | `api.Contracts.Indexs.TSE["IX0001"]`（發行量加權股價指數） |
| 櫃買指數 | `api.Contracts.Indexs.OTC["IX0043"]` |

⚠️ 指數代號不是 `001`／`t00`：TSE 那邊 `IR0001` 是**報酬**指數（45,835 vs 105,100，
差很多），要的是 `IX0001`。

### 8.4 🔴 時戳是台北時間當成 UTC 算的

`snapshot.ts` 是奈秒，但它把**台北牆上時間當作 UTC** 記。實測 10:55 抓的快照，
`ts // 1e6` 換算出來是 18:55——整整快 8 小時。band 會把這個值當成「成交時戳」印在
`更新` 欄，所以腳本要先減掉 8 小時（台北全年 UTC+8，一個常數就夠）。
第一版沒減，band 上就顯示 `更新 18:55:15`。

### 8.5 其他實測到的事

- `snapshot.close` 就是最後成交價，**不會出現 `-`**，沒有「這一刻
  沒成交」的洞要補。
- `login(subscribe_trade=False)` 可以不訂閱委託回報，只要報價。
- 環境：shioaji 鎖 Python ≤ 3.13。本機能跑的是本機的 venv
  （Python 3.12.6 + shioaji 1.7.2）；homebrew 那個 python@3.14 下的 shioaji 1.3.3
  `import` 得到但不是拿來用的。
- `api.Contracts` 會噴 DeprecationWarning（v2 改叫 `api.contracts`），功能還在。

### 8.6 跟 Yahoo 比，什麼時候該用哪個

| | Yahoo | 永豐 Shioaji |
| --- | --- | --- |
| 要不要帳號 | 不用 | 要（API 開通＋簽署中心） |
| 怎麼跑 | hooks 模組自己抓 | 要另外跑一支常駐腳本 |
| 上櫃 | 設定檔要標 `"ex": "otc"` | 自動 |
| 昨收 | `meta.previousClose` | `contract.reference`（券商口徑，除權息後比較準） |
| 台股即時性 | 落後約 20 分鐘 | 真即時 tick |

一般情況用 Yahoo 就夠；已經是永豐客戶、要盤中真即時、或要跟自己的部位／下單
流程共用同一份行情，才值得多跑那支腳本。


---

## 9. 富果 Fugle 評估（2026-09-16，結論：先不接）

起因：想找有沒有免費、有明文使用條款的即時報價替代，而不是只能依賴沒有文件、
沒有條款的內部端點。

### 9.1 先否定一個直覺：Yahoo 本身也不是安全牌

Yahoo 那幾支端點一樣沒有文件、沒有條款、沒有金鑰，而且 Yahoo 自己的服務條款
就禁止程式化取用金融資料——找免費替代不是為了「換到比較安全的」，是想知道有
沒有明文可查的選項。

**台灣證券交易所真正有文件的官方 API 做不了這件事**：`openapi.twse.com.tw` 的
swagger 實查有 143 支端點，全部是 `exchangeReport/*` 這類收盤後日頻資料，沒有
任何一支盤中即時。

### 9.2 富果免費層的實際條件（實查）

| 項目 | 結果 | 出處 |
| --- | --- | --- |
| 要不要券商帳戶 | **不用**，註冊免費富果會員即可申請行情 API Key（要券商帳戶的是交易 API） | support.fugle.tw/fugle-special/5164 |
| 上櫃 | 有，資料來源含證券櫃檯買賣中心；symbol 就是代號，不必自己分 tse/otc | developer.fugle.tw/docs/data/intro |
| 日內行情 REST | **60 次/分**，`GET /intraday/quote/{symbol}`，**一次一檔** | docs/pricing、docs/data/http-api/intraday/quote |
| 行情快照（批次多檔） | **免費層不支援** | docs/pricing |
| WebSocket | 5 訂閱 1 連線（hooks 模組只有 `$.http.fetch`，開不了長連線，用不到） | docs/pricing |
| 欄位 | `lastPrice`／`previousClose`／`change`／`closeTime`，對得上 band | docs/…/intraday/quote |

### 9.3 為什麼先不接

沒有批次端點 → 20 檔 = 20 個請求/tick，卡在 60 次/分，**最快只能 60 秒更新一次**；
現在 Yahoo 一個請求抓完 20 檔、最快 24 秒一次。用了會變慢一倍以上，換到的只有
「條款寫得出來」。

### 9.4 條款重點（`developer.fugle.tw/docs/data/intro#statement`）

真的要接的時候這幾條會影響設計：

- 禁止「盜接、轉接交易資訊，或以其他方式出售、出租、轉讓、再授權」，以及
  **「將交易資訊⋯傳送予第三人」** → **plugin 不能內建金鑰、不能代抓後轉發，
  每個使用者必須自己申請自己的 key**，README 要寫清楚。
- 「每位使用者僅限申請及使用一個帳號」，不得以多帳號規避免費限制。
- 取得金鑰即同意遵守台灣證券交易所／期交所／櫃買中心的交易資訊使用管理辦法。

### 9.5 富果與永豐的取捨（決策當下的狀態）

| | 富果 Fugle | 永豐 Shioaji |
| --- | --- | --- |
| 明文條款 | 有 | 券商合約 |
| 帳號 | 富果會員（免費） | 既有永豐帳戶 |
| 20 檔更新一次 | 20 個請求 | 1 次 `snapshots()` |
| 最快間隔 | 60 秒 | 10 秒 |
| 怎麼跑 | 模組自己抓 | 常駐腳本 |

**2026-09-16 決定：永豐當可選（已實作）。富果先不接。**
（台股的預設路線後來定案為 Yahoo，見開頭的 📍 連結；富果與永豐這兩節的
取捨本身沒有變。）
要翻案的訊號：富果把批次快照開放到免費層，或現有免金鑰路線開始被擋。

## 10. 群益 Capital API / SKCOM（2026-09-18 接上，Windows 那條路）

> ✅ **驗證狀態：2026-09-18 在 Windows 11 + Python 3.12 (64-bit) 上實測過**
> ——真的註冊元件、真的登入、真的訂閱、真的收到報價與庫存。下面每個「實測」
> 標記的數字都是那次跑出來的。唯一沒實測的是 32-bit（`元件\x86`）那條，
> 手上沒有 32-bit Python。
> 重跑一次的指令：`scripts/fetch-quotes-capital.py --check`，它會把整串走完並逐項印 ✅／❌。

### 10.1 為什麼要有這條：永豐那條在 Windows 上根本起不來

`hooks/register.tsx` 用 `nohup ... &` 包 `/bin/sh -c` 來讓一次性的
`$.process.run` 能夠返回（見 §8.2）。Windows 沒有 `nohup`、沒有 `/bin/sh`，而
`fetch-quotes-shioaji.py --check` 本來就直接把 `sys.platform == "win32"` 判成
失敗。所以在 Windows 上，台股即時只剩 `mis`（證交所，免帳號）可選——這條補上
的是「有券商帳號、而且人在 Windows」的那一格。

兩條路線剛好互為鏡像：**永豐只跑 POSIX（band 用 nohup 啟動），群益只跑
Windows（SKCOM 是 COM DLL，沒有 macOS／Linux 版）。**

### 10.2 用到的 API（讀過原始碼／官方文件）

登入到出價的順序是 SDK 自己規定的，跳步就拿不到東西：

```
SKCenterLib_SetLogPath(dir)        # 不設就寫到 process 的工作目錄
SKCenterLib_Login(id, password)    # 0 = 成功
SKQuoteLib_EnterMonitorLONG()      # 非同步
  -> OnConnection(nKind=3003)      # SK_SUBJECT_CONNECTION_STOCKS_READY，等到這個才算連上
SKQuoteLib_RequestStocks(1, "2330,2454,…")   # psPageNo「請固定帶 1」，上限 100 檔
  -> OnNotifyQuoteLONG(...)        # 推到 SDK 自己的快取
SKQuoteLib_GetStockByNoLONG(code, SKSTOCKLONG())  # 從那個快取讀出來
```

庫存走下單元件，是另一組：

```
SKOrderLib_Initialize()
ReadCertByID(id)                   # 下單一定要；查詢不一定，所以腳本只是 best-effort
GetUserAccount() -> OnAccount("市場,分公司代碼,分公司,帳號,身份證字號,姓名")
   # 證券是市場別 "TS"，帳號 = 分公司代碼(4) + 帳號(7)
GetProfitLossGWReport(id, TSPROFITLOSSGWQUERY{nTPQueryType=0, nFunc=0})
  -> OnProfitLossGWReport(bstrData)  # 第一筆是查詢結果，之後每筆一檔
```

未實現損益**彙總**那個格式正好就是損益檢視要的東西（手冊 4-2-p 的欄位表，
1-based）：1 股票名稱、2 股票代號、5 庫存股數、6 市價、7 今日市價漲跌、
11 平均買進成本、27 交易種類代號。`qty` 直接是股數（不是張），`cost` 就是每股
平均成本——跟 band 的 `Holding` 契約一對一。

也有 `GetRealBalanceReport`（證券即時庫存）可以用，但它**沒有成本價**，所以
損益算不出來；選未實現損益彙總是因為它同時帶股數跟成本。

### 10.3 五個會讓你以為壞掉的坑

- 🔴🔴 **`comtypes.client.PumpEvents` 收不到 SKCOM 的事件，要自己寫
  `PeekMessage`／`DispatchMessage` 迴圈。** 這個坑吃掉最多時間，而且症狀
  完全誤導：登入成功、`EnterMonitorLONG` 回 `SK_SUCCESS`、SDK 自己的
  `Quote.log` 也寫了 `OnSessionConnect, Code: 3001`，但 Python 這側
  **一個 `OnConnection` 都收不到**，`IsConnected()` 卡在 2（下載中）不動。
  同一支帳號、同一台機器，換成原生 Win32 訊息迴圈之後 **2.5 秒**就收到
  3001 + 3003、`IsConnected()` 變 1。
  （實測 2026-09-18：`PumpEvents` 等 180 秒 = 0 個事件；raw pump = 2.5 秒。）
  原因大概是 `PumpEvents` 走 `CoWaitForMultipleHandles`，派送的訊息種類跟
  SKCOM 需要的不一樣。群益自己的範例踩不到，是因為它們跑在 Tkinter 的
  `mainloop()` 裡——那就是一個原生訊息迴圈。見 `Capital.pump()`。
- 🔴 **價格是整數，除數看 `sDecimal`。** `SKSTOCKLONG` 每個價格欄位都是整數，
  乘過該商品自己的小數位數：台積電 1188.0 收到的是 `118800`、`sDecimal = 2`。
  **群益自己的 Python 範例是寫死 `/100.0` 的**（`Quote.py` 的
  `OnNotifyQuoteLONG`），證券剛好對，四位小數的匯率類商品就錯。腳本除
  `10 ** sDecimal`。
- 🔴 **沒有 epoch，只有 `nTradingDay`(YYYYMMDD) + `nDealTime`(hhmmss)。**
  跟永豐那個「台北時間當 UTC 算」的坑（§8.4）方向相反：這邊根本沒給時間戳，
  給的是交易所當地的年月日時分秒。腳本用 UTC+8 換算，不走機器自己的時區，
  不然時區設在別的地方的筆電會把 `更新` 印錯。
- **開盤前 `nClose` 是 0。** 這時候寫 `nRef`（昨收）進去會畫出一根根本沒成交過
  的平盤，所以腳本直接把那幾筆丟掉——那個 tick 就落到 `twSources` 的下一條。
- **元件位元數要跟 Python 對得上。** `regsvr32` 註冊的是 `元件\x64` 還是
  `元件\x86`，要跟跑腳本的 Python 是 64-bit 還是 32-bit 一致。不一致的症狀是
  「明明註冊過了還是說 class not registered」。

### 10.4 指數代號：手冊沒寫，而且直覺猜的是錯的（已實測）

整份 `群益API元件使用手冊_V2.13.59.docx` 裡找不到加權指數／櫃買指數的商品代號
（搜過「指數」「加權」「TSE」都只有選擇權算 Greeks 的那個 `S` 參數和市場別字樣）。

**猜 `TSE01`／`OTC01` 是錯的**：`TSE01` 查得到，但它是**水泥類股**（類股指數），
`OTC01` 根本不存在（rc=9999）。正確代號是把 `SKQuoteLib_RequestStockList(0/1)`
的商品清單整包倒出來找到的：

| 代號 | 名稱 | 市場 | sDecimal |
| --- | --- | --- | --- |
| `TSEA` | 加權指 | 0 上市 | 2 |
| `OTCA` | 櫃檯指 | 1 上櫃 | 2 |

拿證交所自己的 MIS 端點對帳（2026-09-18 12:39，兩邊差幾秒）：

| | 群益 SKCOM | 證交所 MIS |
| --- | --- | --- |
| 加權指數 | `TSEA` nClose 4700427 / 10² = **47004.27** | `t00` z = **47001.67** |
| 櫃買指數 | `OTCA` nClose 40911 / 10² = **409.11** | `o00` z = **409.12** |

順便驗掉 `sDecimal`：2330 同一時間 nClose 245000 / 10² = 2450，跟 `--check`
印的一致。

🔴 **指數也要訂閱才有價。** 沒進 `RequestStocks` 的話 `nClose` 是 0，只有
`nRef`（昨收）有值——所以腳本是把指數代號跟觀察清單一起送進 `RequestStocks`，
不是直接讀快取。

保險機制沒拿掉：腳本啟動時仍會逐一探測，查不到的丟掉並留一行 log，而不是往頁尾
寫一個 0 進去。`--check` 會把每個指數代號解析到的名稱與數值印出來；不想要頁尾
指數就設 `"indices": []`。

### 10.5 detach：Windows 這邊是腳本自己做的

`$.process.run` 是一次性的，而且會等 child 的 stdout/stderr 管線關閉——常駐
fetcher 的管線不會自己關。永豐那條靠 `nohup ... >>log 2>&1 &` 解決；Windows
沒有 `nohup`，而 `start /b` 等於把「python 路徑可能含空白」的引號問題交給
`cmd.exe`。所以改成**腳本自己 detach**：band 傳 `--detach`，腳本用
`subprocess.Popen(..., creationflags=DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP,
stdout=log, stderr=log)` 重開一個自己然後立刻返回。心跳檔、pid 檔、120 秒過期、
一分鐘只重生一次這些規則跟永豐完全共用（`register.tsx` 的 `feedTwFetcher`
現在是兩條路線共同的那一份）。

### 10.6 順手修掉的 Windows 前置問題

接這條之前，band 的兩個路徑規則在 Windows 上本來就是壞的——不修的話報價檔會
寫進專案的 `.claude/`：

- **`$HOME` 在 Windows 沒有。** `$.env.get("HOME")` 回 undefined，
  `runtimeDir()` 就退回 `<project>/.claude/`。改成 `HOME` 找不到時
  再找 `USERPROFILE`（TS 的 `userHome()` 與 Python 的 `user_home()` 同一套）。
- **slug 沒處理磁碟機代號。** 舊規則只把 `/` 換成 `-`，`D:\app` 會原封不動變成
  目錄名，裡面帶著 `:` 和 `\`。改成 `/`、`\`、`:` 都換成 `-`（`D:\app` →
  `D--app`）。POSIX 路徑不含後兩者，所以**既有的執行期目錄一個都不會搬家**。

`scripts/dev/sources-order.mjs` 的 case (e)/(f) 就是釘這兩件事的：(e) 確認
`capital` 這條會用純 argv（不是 `/bin/sh` + `nohup`）啟動而且帶 `--detach`，
(f) 用「只有 `%USERPROFILE%`、cwd 是 `D:\fake-project`」跑一次，確認 `--out-dir`
落在 `/fake-home/.claude/stock-band/D--fake-project/`。

### 10.7 跟其他台股路線比

| | Yahoo | 證交所 MIS | 永豐 Shioaji | 群益 Capital |
| --- | --- | --- | --- | --- |
| 平台 | 都可以 | 都可以 | macOS／Linux | **Windows** |
| 帳號 | 不用 | 不用 | 永豐帳戶＋API | 群益帳戶＋API＋證券帳戶 |
| 前置 | 無 | 無 | `pip install shioaji` | 解壓 SDK＋`regsvr32`＋`pip install comtypes` |
| 延遲 | 約 20 分 | 即時 | 即時 | 即時 |
| 20 檔一次 | 2 個請求 | 1 個請求 | 1 次 `snapshots()` | 1 次訂閱，之後讀快取 |
| 昨收 | 有 | 有 | `contract.reference` | `SKSTOCKLONG.nRef` |
| K 棒／spark | 原生 | 無 | 無 | 無（都退回 Yahoo 的逐檔 chart） |
| 庫存 | — | — | `list_positions` | 未實現損益彙總 |

要翻案的訊號：群益把 K 線（`SKQuoteLib_RequestKLineAMByDate`，分線／新版輸出
格式是 `年/月/日, 時:分, 開,高,低,收, 量`）也接進來，就能讓這條路線同時供 `bars`
跟 `series`，比永豐那條多一截——目前兩條都沒做，K 棒一律走 Yahoo。

---

## 11. Pionex（加密貨幣第三個市場，2026-09-18 實測）

### 11.1 端點與資料形狀

公開、免金鑰、**免任何 header**（跟 Yahoo 不同——Yahoo 沒有瀏覽器 UA 會被
擋，Pionex 一支裸 `curl` 就 200）：

```
GET https://api.pionex.com/api/v1/market/tickers?symbol=BTC_USDT
GET https://api.pionex.com/api/v1/market/tickers            # 不帶 symbol，回全市場
```

成功（HTTP 200）：

```json
{"result":true,"data":{"tickers":[{"symbol":"BTC_USDT","time":1789746167017,
 "open":"76846.01","close":"80707.58","high":"81153.69","low":"76259.98",
 "volume":"38480.088467","amount":"3017756588.53451109","count":499384}]},
 "timestamp":1789746167461}
```

失敗（**HTTP 仍是 200**——`result` 欄位才是成敗，不是狀態碼）：

```json
{"result":false,"code":"MARKET_INVALID_SYMBOL","message":"symbol error","timestamp":1789746227}
```

**`symbol=A,B` 不能一次帶多檔**（2026-09-18 實測）：

```sh
$ curl -s 'https://api.pionex.com/api/v1/market/tickers?symbol=BTC_USDT,ETH_USDT'
{"result":false,"code":"MARKET_INVALID_SYMBOL","message":"symbol error","timestamp":1789746632}
```

所以 `feedCrypto()` 走「不帶 `symbol` 拉全市場（~330 檔、約 55 KB）再本地
filter」這條路，watchlist 幾檔都是一次 tick 一個請求，不是逐檔打。

其他欄位坑（實作細節見 `hooks/register.tsx` 的 `feedCrypto`/`pionexSymbol`
註解，這裡只記證據）：

- 所有數值是字串，要 `parseFloat`。
- **沒有 changePercent 欄位。** `close` 是現價，`open` 是「24 小時前」的價，
  不是「昨收」——這個市場的漲跌語意因此是 **24 小時漲跌**，跟 tw/us 的「對
  昨收」不是同一件事。`feedCrypto` 把 `open` 塞進 `FileQuote.prevClose`，
  借用既有的 `quoteRow()` 算式（沿用它，不是重寫一套）。
- `symbol` 是 `BASE_QUOTE`（底線分隔），如 `BTC_USDT`。
- 時間戳是 epoch 毫秒、UTC 基準，`new Date(ms)` 直接可用；但**錯誤物件的
  `timestamp` 是秒**，不要拿來用。
- **上架清單是 Pionex 自己的，不是幣圈通用的。** TON（`TON_USDT`）在 Pionex
  上完全沒有市場（對照過完整 ~330 檔清單，2026-09-18／19 兩次都確認）。原本
  的預設清單有 TON，而 `crypto-feed.mjs` 的 fixture 自己捏了一筆 `TON_USDT`
  出來，於是**測試對著一個不存在的市場通過了**。兩邊都換成 BCH（Pionex 有，
  且是成交額排得上的主流幣）。
  - 教訓兩條：①預設清單的每個代號都要對照真實回應驗過，別假設某個幣「一定
    有」；②fixture 的每一列都必須對應真實市場，否則測試證明不了真實 feed 的
    任何事。
  - 代號不存在本身不會壞：board 既有的「有快照但這個代號沒被定價」路徑會把
    它畫成灰色 placeholder，不是假價格。但預設清單不該出一列永遠填不上的。
  - 查法：`curl -s 'https://api.pionex.com/api/v1/market/tickers' | python3 -c "import json,sys; print([t['symbol'] for t in json.load(sys.stdin)['data']['tickers']])"`

### 11.2 限流：weight 桶子實測（2026-09-18）

官方文件只寫「10 per second」，且明講單位是 **weight**，不是 request 數，
也不公開各端點的 weight 對照表
（<https://pionex-doc.gitbook.io/apidocs/restful/general/rate-limit>）。以下是
針對 `market/tickers` 這支端點本機實測出來的桶子形狀，**只對這支端點成立**，
不要外推到 `depth`／`klines`／私有端點：

- 每個回應都帶 `x-ratelimit-tokens`（剩餘額度，含小數）與 `x-ratelimit-last`
  （unix 秒、含小數，看起來是上次計費的時間戳——目前只記錄，沒有用在程式邏輯
  裡）。
- 閒置穩定在 **29~30**，這是桶子容量；約 **10 tokens/秒**回補（跟官方講的
  "10 per second" 對得上），停手後 **2 秒內**回補到 29。
- **payload 大小不影響 weight**：拉全量（`?type=PERP`，612 檔、107 KB）跟拉
  單檔（`?symbol=BTC_USDT`）用平行對照組量，兩組每發 tokens 掉幅一致（約
  −1）——`market/tickers` 是純 per-request 計費，全量拉取沒有額外代價。
- 25 發平行請求打下去，桶子掉到 **8.43**，**25/25 全部 HTTP 200，一次 429
  都沒有**——這是驗證「10 連發不會撞牆」的證據，**不是**「限制其實更寬鬆」的
  證據（10 連發剛好貼著上限，沒有超過），輪詢間隔仍維持 30 秒一次不放寬。
- **`x-ratelimit-tokens` 是整個 IP 共用的桶，不是這支程式自己的用量**——同一
  台機器上任何其他東西打 Pionex，都會讓這支程式讀到偏低的值。`feedCrypto`
  在讀到低於 5 時跳過那一 tick 不打，這是正常的「主動讓路」，可能被別人的
  流量觸發，不代表這支程式有 bug，也**不會**因此加重試或縮短輪詢間隔去補償
  ——加重試正是官方文件警告的「failing to back off」，會把封鎖時間疊上去。

429 本身：blocks the IP 60 秒，且**封鎖期間收到的請求會再疊加 +10 秒**，所以
`CRYPTO_COOLDOWN_MS` 訂在 90 秒（比官方 60 秒門檻留一截安全邊界），是固定等待，
不是像 Yahoo 那樣的指數退避（Yahoo 的節流行為沒有這麼明確寫在文件上，才需要
指數退避去摸索；Pionex 這支是文件寫死的固定長度封鎖，不需要再發明一條曲線）。

### 11.3 一個順手修掉的既有 bug：`round2()` 對小數價格失真

寫 `scripts/dev/crypto-feed.mjs` 的快樂路徑測試時抓到：`quoteRow()` 原本用
`round2()`（固定四捨五入到小數點後 2 位）算 `change`，這對 tw/us（沒有低於
$1 的標的）無感，但 DOGE 這種 <$1 的幣會被輾壓——0.08177 → 0.08735 的真實漲幅
是 $0.00558，`round2` 四捨五入成 $0.01，`pct` 又是從這個被捨入過的 `change`
算出來的，等於把 6.8% 的真實漲跌顯示成 12.2%，不是顯示層的小瑕疵，是資料本身
就算錯了。改成 `roundPrice()`：依數值本身的量級決定小數位數（≥1000 用 0
位、≥1 用 2 位、<1 用 4 位，跟 `board.tsx` 的 `quotePriceDecimals()` 同一套
門檻），tw/us 的值全部 ≥1，行為不變；`register.tsx` 裡所有 `round2(` 的呼叫點
（`quoteRow`／`publish` 的指數計算）都換成了 `roundPrice(`。
