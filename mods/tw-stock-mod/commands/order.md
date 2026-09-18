---
description: 用永豐 Shioaji 下單、查委託狀態、取消委託——模擬優先
---

# 下單 / 查詢 / 取消

呼叫 `scripts/order-shioaji.py`。**這支腳本跟 band／看板無關**——band 從不下單，這是獨立工具。
**模擬是預設值**：不加 `--live`，一律用 `sj.Shioaji(simulation=True)` 登入，不會動到真實部位。

正式交易需要**兩個條件同時成立**：user-level `~/.claude/stock-band.json` 要有
`"order": { "live": true }`，**而且**這次呼叫要帶 `--live`；兩者缺一都留在模擬。專案層級的
`stock-band.json` 寫 `order.live` 一律被忽略——不要以為改專案檔可以開啟正式交易。正式還需要
CA 憑證設定好並啟用成功，沒設定或啟用失敗，腳本會印 `需要 CA 憑證` 然後什麼都不做。**除非使用者
明確要求正式交易、且你已經確認這是他真的想做的事，否則永遠不要自己加 `--live`。**

用哪個 Python：`~/.claude/stock-band-venv/bin/python`（跟看板的永豐 fetcher 共用同一個 venv）；
沒有這個 venv 就退回 `python3`，但要先跟使用者確認裝了 `shioaji`。

## 三個子指令

- **`place`**：下單。`--code --side buy|sell --price --qty`，選填 `--lot common|odd`（股票用，
  預設 common／張）、`--octype auto|new|cover`（期貨用，預設 auto）。
- **`status`**：`update_status` 之後 `list_trades`，逐筆印出 id / 代號 / 買賣 / 價格 / 數量 /
  狀態 / 已成量。
- **`cancel --id <委託 id>`**：取消一筆委託，id 是 `status` 或前一次 `place` 印出的那個。

每次 `place`／`status`／`cancel` 都會在 `~/.claude/stock-band/orders.log` 多一行 JSON 紀錄，
不需要自己額外記錄。

## 怎麼把使用者的話變成指令

從使用者的描述抽出代號、買賣方向、價格、數量，組成一行指令，例如「幫我用 105 塊買一張 2330」→

```sh
~/.claude/stock-band-venv/bin/python mods/tw-stock-mod/scripts/order-shioaji.py \
  place --code 2330 --side buy --price 105 --qty 1
```

期貨代號可以是月合約（`TXFJ6`）或永豐的連續別名（`TXFR1`／`TXFR2`）——不用自己解析，腳本會查
合約並在確認畫面顯示實際解析到哪個月份。

## 確認關卡——不要幫使用者按確認

`place` 一定會先印出合約、方向、LMT、價格、數量（帶單位：股票張／股，期貨口）、帳號、模式
（模擬／正式），然後等 stdin 收到一模一樣的兩個字「確認」才會真的送單。**把這段確認文字原樣貼給
使用者看，然後停下來等他自己回覆**——不要幫他判斷「這應該沒問題」就自己在 stdin 打「確認」，
也不要用別的話（好、可以、ok）替他確認，腳本只認字面上的「確認」。

- 使用者接下來的訊息如果就是「確認」兩個字，把它原封不動接進去重新呼叫這支指令（同樣的
  `place` 參數，把「確認」餵進 stdin），再把腳本的輸出（送單結果或失敗訊息）貼給他看。
- 只有模擬模式才吃得動 `--yes`（跳過確認、免互動的腳本模式）；正式模式下 `--yes` 一律被忽略，
  腳本還是會等 stdin，這點也不要自己繞過。
- 使用者回覆的不是「確認」（改主意、打了別的字、沒回應就換話題）——當作取消，不要重試、
  不要追問「你確定要取消嗎」，除非使用者自己重新要求下單。

`status`／`cancel` 沒有這個確認關卡，執行完直接把腳本輸出貼給使用者。

## 永遠原樣轉述腳本輸出

不管是確認文字、送單結果、`SKIPPED` 提示、`需要 CA 憑證` 或任何錯誤訊息，都原樣貼給使用者，
不要重新措辭或摘要掉細節——漲跌停範圍、被拒絕的原因、委託 id 這些都是使用者需要的資訊。
