# MyLedger

MyLedger 是手機優先的「最低存款控制助手」。它不是傳統分類記帳 App，而是用來回答一件事：

> 照目前這樣花，本期月底至少還能不能留下 5,000 元？

## 功能

- Supabase Auth Email Magic Link 登入
- Supabase Postgres 儲存週期、支出、代墊、待收款與設定
- Row Level Security，登入者只能存取自己的資料
- 手動開始發薪週期，通常從月底發薪日開始
- 新週期輸入本期實領薪水、媽媽提供金額，最低保留預設 5,000 元
- 首頁顯示預估月底可留下、安全餘裕、已花、待收、每日可花
- 一般支出只需要金額、日期與備註
- 代墊只計入自己負擔，其他人的部分列為待收款
- 待收款標記已收時不會算成收入，避免重複計算
- 「我想買」試算購買後是否仍達到最低存款
- 近期紀錄可編輯、刪除
- JSON 備份與還原

## 資料儲存

財務資料不可儲存在 `localStorage`。收入、支出、週期、代墊與待收款都存在 Supabase。

前端只會使用 Supabase 的公開 URL 與 publishable/anon key。不要把 service role key 放進此 repository 或 GitHub Pages。

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
   window.MYLEDGER_SUPABASE = {
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
