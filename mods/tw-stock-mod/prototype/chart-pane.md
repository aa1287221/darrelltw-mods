# PROTOTYPE：K 線 pane（一次性，不合併）

分支 `prototype/chart-pane`。這是試用用的雛形，不是正式功能：不 bump 版本、不進 README、不推送。

## 要回答的問題

在擁有者的 Windows Terminal 上，按需開的 K 線 pane（docked）是否勝過目前股票列裡的圖表：
高度、寬度（dock 分配 vs 要求的寬度）、用 status-pane 的 tab 切換、Esc 關閉。

## 怎麼試

```
TW_STOCK_CHART_PANE=1 claude --plugin-dir /project/darrelltw-mods-chart-pane/mods/tw-stock-mod
```

不設 `TW_STOCK_CHART_PANE`（或設成 1 以外的值）時，這個分支與 main 的行為相同。

引擎 2.1.301 的字串裡有 "from --plugin-dir overrides installed version"，這一點本機還沒實測。
若仍載到已安裝的版本，請在 `/plugin` 確認實際載入的路徑。

## 看什麼

- 股票列按 `趨勢圖`，或直接點表格的某一列：開 pane，股票列留在清單。
- pane 第一列：`◀ 上一檔`、`下一檔 ▶ n/N`、週期（有 K 棒時）、K線／曲線、`寬度 [預設]`／`寬度 [寬]`、`回 band`、`關閉`。
- pane 第二列狀態：`pane 欄×列 dock · 寬度要求 …`，對照實際分到的寬高。
- `寬`：寬度要求設為視窗的 60%（最少 100 欄、最多視窗減 40 欄）；`預設`：交給 dock 分配。
- 停靠區可能只有約 40 欄（status-pane SPEC 記載），手動拖過的寬度優先於 `寬` 的要求；
  狀態列的實際欄數與「寬度要求」不同，就是要求被蓋掉了。判斷高度之前先把停靠區邊界拖寬。
- Esc 或 `關閉` 關 pane；`回 band` 關 pane，並在股票列圖表看同一檔。
- 股票列圖表列上的 `開 pane`：反過來，開 pane 並讓股票列回到清單。
- pane 高度 24 列以上時，成交量區會隨列數加高（列數的六分之一），只有 pane 這樣。
- 視窗放不下 pane 時，股票列會改成圖表，並在除錯 log 寫下 `K 線 pane 沒有開成`。

## 怎麼回去

不加 `--plugin-dir` 重新啟動 claude，就會回到正式安裝的版本。
