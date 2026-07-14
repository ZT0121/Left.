# Left.

Left. 是手機優先的「最低存款控制助手」。它不是傳統分類記帳 App，而是用來回答一件事：

> 照目前這樣花，本期月底至少還能不能留下 5,000 元？

## 功能

- Supabase Auth Email Magic Link 登入
- Supabase Postgres 儲存週期、支出、代墊、待收款與設定
- Row Level Security，登入者只能存取自己的資料
- 手動開始發薪週期，通常從月底發薪日開始
- 新週期輸入本期實領薪水、媽媽提供金額，最低保留預設 5,000 元
- 首頁顯示預估月底可留下、安全餘裕、已花、待收、每日可花
- 首頁同時顯示本期信用卡應繳與未來分期未償餘額
- 一般支出只需要金額、日期與備註
- 代墊只計入自己負擔，其他人的部分列為待收款
- 待收款標記已收時不會算成收入，避免重複計算
- 「我想買」試算購買後是否仍達到最低存款
- 信用卡帳戶管理：卡片名稱、結帳日、繳款日、啟用狀態
- 信用卡帳單明細：一般刷卡、本期分期、費用／利息、期初帳單
- 分期計畫會把本期應繳列入本期支出，並顯示未來尚未到期的承諾金額
- 近期紀錄可編輯、刪除
- JSON 備份與還原
- 全站固定使用 `assets/fonts/SarasaMonoTC-SemiBold.ttf`

## 資料儲存

財務資料不可儲存在 `localStorage`。收入、支出、週期、代墊與待收款都存在 Supabase。

前端只會使用 Supabase 的公開 URL 與 publishable/anon key。不要把 service role key 放進此 repository 或 GitHub Pages。

## 信用卡與分期規則

Left. 把「花錢決定」和「卡費繳款」分開處理：

- 一般刷卡在刷卡當下就計入本期支出，因為預算應該在決定購買時被扣掉。
- 同一筆刷卡也會進入信用卡待繳明細，用來提醒本期或後續要繳多少卡費。
- 繳卡費時只要在信用卡明細按「標記已繳」，不會再新增支出，避免重複計算。
- 代墊若用信用卡付款，預算只扣自己的負擔金額；信用卡待繳會記整筆刷卡金額；同事回款只沖銷待收款，不算收入。
- 分期商品會建立分期計畫。本期到期的分期金額會列入本期支出與信用卡應繳，未來尚未到期的分期會顯示在「未來分期未償」。
- 首頁的安全餘裕會扣掉未來分期承諾，讓你看得到「完整承諾金額」對最低存款的影響。

### 從 0 開始輸入目前卡費

如果你剛開始使用 Left.，目前這期信用卡帳單可以用「期初帳單」輸入：

1. 先新增信用卡帳戶。
2. 到「信用卡」分頁輸入目前這期帳單總額。
3. 這筆期初帳單會整筆算入本期支出，也會列入本期信用卡應繳。
4. 未來尚未到期的分期餘額不要放進期初帳單，等新增分期計畫後由 Left. 自動列入未來承諾。

## Supabase 設定

1. 建立 Supabase 專案。
2. 到 SQL Editor 執行 [`schema.sql`](./schema.sql)。
3. 到 Authentication 設定 Email 登入。
4. 若使用 GitHub Pages，將 Site URL 設為你的 Pages 網址，例如：

   ```text
   https://zt0121.github.io/MyLedger/
   ```

5. 將 `js/config.js` 填入：

   ```js
   window.LEFT_SUPABASE = {
     url: "https://your-project-ref.supabase.co",
     anonKey: "your-supabase-publishable-or-anon-key"
   };
   ```

   `js/config.example.js` 是設定範例。Supabase publishable/anon key 可以放在前端；service role key 不可以。

## GitHub Pages

這是純靜態網站，可直接用 GitHub Pages 發佈。

建議 Pages 設定：

- Source: Deploy from a branch
- Branch: `main`
- Folder: `/ (root)`

## 開發檢查

本專案不需要 build step。修改後可用任一靜態伺服器開啟，例如：

```bash
python -m http.server 4173
```

檢查重點：

- 未設定 Supabase 時會顯示設定提醒
- 未登入時不顯示任何財務資料
- 一般支出會降低預估月底可留下金額
- 最低存款安全餘裕會正確變化
- 代墊只把自己負擔計入支出
- 待收款標記已收不會新增收入
- 編輯、刪除紀錄後首頁數字會更新
- 備份檔是 JSON，還原會寫回 Supabase
