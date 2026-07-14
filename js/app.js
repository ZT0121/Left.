(function () {
  const config = window.LEFT_SUPABASE || window.MYLEDGER_SUPABASE || {};
  const hasConfig = Boolean(config.url && config.anonKey);
  const client = hasConfig && window.supabase
    ? window.supabase.createClient(config.url, config.anonKey)
    : null;

  const state = {
    user: null,
    settings: null,
    cycle: null,
    transactions: [],
    reimbursements: []
  };

  const $ = (id) => document.getElementById(id);
  const money = (value) => new Intl.NumberFormat("zh-TW", {
    style: "currency",
    currency: "TWD",
    maximumFractionDigits: 0
  }).format(Number(value || 0));
  const today = () => new Date().toISOString().slice(0, 10);
  const toNumber = (value) => Number(value || 0);
  const supabaseUrl = String(config.url || "").replace(/\/+$/, "");
  const daysBetween = (from, to) => {
    const start = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T00:00:00`);
    return Math.max(0, Math.ceil((end - start) / 86400000));
  };

  function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      toast.hidden = true;
    }, 2600);
  }

  function setVisible(id, visible) {
    $(id).hidden = !visible;
  }

  function formatSupabaseFetchError(error) {
    const message = error?.message || "";
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      return "無法連到 Supabase 專案。請確認 js/config.js 的 url 是 Dashboard 顯示的 Project URL，且專案沒有被暫停或刪除。";
    }
    return message;
  }

  async function checkSupabaseConnection() {
    try {
      const response = await fetch(`${supabaseUrl}/auth/v1/settings`, {
        headers: { apikey: config.anonKey }
      });

      if (response.status === 401 || response.status === 403) {
        return "Supabase key 驗證失敗。請確認 js/config.js 使用的是 publishable/anon key，不是 service role key。";
      }

      if (!response.ok) {
        return `Supabase 連線異常（HTTP ${response.status}）。請稍後再試，或到 Supabase Dashboard 檢查專案狀態。`;
      }

      return "";
    } catch (error) {
      console.error(error);
      return formatSupabaseFetchError(error);
    }
  }

  function getDefaultNextPayDate() {
    const date = new Date();
    date.setMonth(date.getMonth() + 1);
    date.setDate(0);
    return date.toISOString().slice(0, 10);
  }

  function calculateSummary(extraSpend = 0) {
    if (!state.cycle) {
      return {
        totalIncome: 0,
        spent: 0,
        pending: 0,
        projected: 0,
        buffer: 0,
        daysLeft: 0,
        daily: 0
      };
    }

    const totalIncome = toNumber(state.cycle.salary_income) + toNumber(state.cycle.mother_support);
    const spent = state.transactions.reduce((sum, row) => sum + toNumber(row.amount), 0) + toNumber(extraSpend);
    const pending = state.reimbursements
      .filter((row) => row.status === "pending")
      .reduce((sum, row) => sum + toNumber(row.amount), 0);
    const projected = totalIncome - spent;
    const buffer = projected - toNumber(state.cycle.minimum_savings);
    const daysLeft = daysBetween(today(), state.cycle.expected_pay_date);
    const daily = daysLeft > 0 ? Math.max(0, Math.floor(buffer / daysLeft)) : Math.max(0, buffer);

    return { totalIncome, spent, pending, projected, buffer, daysLeft, daily };
  }

  function applyStatus(buffer) {
    const hero = $("heroCard");
    const pill = $("statusPill");
    hero.classList.remove("safe", "warning", "danger");
    pill.classList.remove("safe", "warning", "danger");

    if (buffer < 0) {
      hero.classList.add("danger");
      pill.classList.add("danger");
      pill.textContent = "低於最低存款";
      return;
    }

    if (buffer <= 1000) {
      hero.classList.add("warning");
      pill.classList.add("warning");
      pill.textContent = "接近底線";
      return;
    }

    hero.classList.add("safe");
    pill.classList.add("safe");
    pill.textContent = "達標";
  }

  function renderDashboard() {
    if (!state.cycle) return;

    const summary = calculateSummary();
    $("projectedSavings").textContent = money(summary.projected);
    $("safetyBuffer").textContent = money(summary.buffer);
    $("spentAmount").textContent = money(summary.spent);
    $("pendingAmount").textContent = money(summary.pending);
    $("dailyAllowance").textContent = money(summary.daily);
    $("safetyText").textContent = summary.buffer >= 0
      ? `比最低保留 ${money(state.cycle.minimum_savings)} 多 ${money(summary.buffer)}。距離下次發薪還有 ${summary.daysLeft} 天。`
      : `還差 ${money(Math.abs(summary.buffer))} 才能守住最低保留 ${money(state.cycle.minimum_savings)}。`;
    $("cycleRange").textContent = `${state.cycle.start_date} 到 ${state.cycle.expected_pay_date}`;
    applyStatus(summary.buffer);
    renderTransactions();
    renderReimbursements();
  }

  function renderTransactions() {
    const list = $("recordList");
    const rows = [...state.transactions]
      .sort((a, b) => `${b.date}${b.created_at}`.localeCompare(`${a.date}${a.created_at}`))
      .slice(0, 12);

    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">本期還沒有紀錄。第一筆就從最常見的支出開始。</p>';
      return;
    }

    list.innerHTML = rows.map((row) => `
      <article class="record-item">
        <div>
          <p class="record-title">${escapeHtml(row.title || (row.kind === "advance" ? "代墊" : "一般支出"))}</p>
          <p class="record-meta">${row.date}${row.kind === "advance" ? ` · 總金額 ${money(row.gross_amount)}` : ""}</p>
        </div>
        <div class="record-amount">${money(row.amount)}</div>
        <div class="record-actions">
          <button type="button" data-edit="${row.id}">編輯</button>
          <button type="button" data-delete="${row.id}">刪除</button>
        </div>
      </article>
    `).join("");
  }

  function renderReimbursements() {
    const list = $("reimbursementList");
    const rows = [...state.reimbursements]
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
        return String(b.created_at).localeCompare(String(a.created_at));
      });

    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">目前沒有待收款。</p>';
      return;
    }

    list.innerHTML = rows.map((row) => `
      <article class="record-item">
        <div>
          <p class="record-title">${escapeHtml(row.title || "待收款")}</p>
          <p class="record-meta">${row.status === "received" ? `已收 · ${row.received_at || ""}` : "未收"}</p>
        </div>
        <div class="record-amount">${money(row.amount)}</div>
        <div class="record-actions">
          ${row.status === "pending" ? `<button type="button" data-received="${row.id}">標記已收</button>` : ""}
          <button type="button" data-delete-reimbursement="${row.id}">刪除</button>
        </div>
      </article>
    `).join("");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  async function ensureSettings() {
    const { data, error } = await client
      .from("user_settings")
      .select("*")
      .eq("user_id", state.user.id)
      .maybeSingle();

    if (error) throw error;
    if (data) {
      state.settings = data;
      return data;
    }

    const defaults = {
      user_id: state.user.id,
      default_mother_support: 20000,
      default_minimum_savings: 5000
    };
    const inserted = await client
      .from("user_settings")
      .insert(defaults)
      .select()
      .single();
    if (inserted.error) throw inserted.error;
    state.settings = inserted.data;
    return inserted.data;
  }

  async function loadActiveCycle() {
    const { data, error } = await client
      .from("budget_cycles")
      .select("*")
      .eq("user_id", state.user.id)
      .eq("is_closed", false)
      .order("start_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    state.cycle = data;
  }

  async function loadCycleData() {
    if (!state.cycle) return;

    const [txResult, reimbursementResult] = await Promise.all([
      client
        .from("transactions")
        .select("*")
        .eq("user_id", state.user.id)
        .eq("cycle_id", state.cycle.id),
      client
        .from("reimbursements")
        .select("*")
        .eq("user_id", state.user.id)
        .eq("cycle_id", state.cycle.id)
    ]);

    if (txResult.error) throw txResult.error;
    if (reimbursementResult.error) throw reimbursementResult.error;
    state.transactions = txResult.data || [];
    state.reimbursements = reimbursementResult.data || [];
  }

  async function refresh() {
    await ensureSettings();
    await loadActiveCycle();
    setVisible("authPanel", false);

    if (!state.cycle) {
      setVisible("cyclePanel", true);
      setVisible("dashboard", false);
      fillCycleDefaults();
      return;
    }

    await loadCycleData();
    setVisible("cyclePanel", false);
    setVisible("dashboard", true);
    renderDashboard();
  }

  function fillCycleDefaults() {
    const settings = state.settings || {};
    $("salaryInput").value = settings.last_salary || "";
    $("motherInput").value = settings.default_mother_support || 20000;
    $("minimumInput").value = settings.default_minimum_savings || 5000;
    $("nextPayDateInput").value = getDefaultNextPayDate();
  }

  async function initAuth() {
    if (!hasConfig || !client) {
      setVisible("configWarning", true);
      setVisible("authPanel", false);
      return;
    }

    const connectionError = await checkSupabaseConnection();
    if (connectionError) {
      setVisible("configWarning", true);
      setVisible("authPanel", true);
      setVisible("cyclePanel", false);
      setVisible("dashboard", false);
      $("authMessage").textContent = connectionError;
      return;
    }

    const { data } = await client.auth.getSession();
    state.user = data.session?.user || null;
    $("signOutButton").hidden = !state.user;

    if (!state.user) {
      setVisible("authPanel", true);
      setVisible("cyclePanel", false);
      setVisible("dashboard", false);
      return;
    }

    await refresh();
  }

  async function createCycle(event) {
    event.preventDefault();
    const payload = {
      user_id: state.user.id,
      start_date: today(),
      expected_pay_date: $("nextPayDateInput").value,
      salary_income: toNumber($("salaryInput").value),
      mother_support: toNumber($("motherInput").value),
      minimum_savings: toNumber($("minimumInput").value)
    };

    const { data, error } = await client
      .from("budget_cycles")
      .insert(payload)
      .select()
      .single();
    if (error) throw error;

    state.cycle = data;
    await client
      .from("user_settings")
      .upsert({
        user_id: state.user.id,
        last_salary: payload.salary_income,
        default_mother_support: payload.mother_support,
        default_minimum_savings: payload.minimum_savings
      }, { onConflict: "user_id" });

    showToast("新週期已開始");
    await refresh();
  }

  async function addExpense(event) {
    event.preventDefault();
    await insertTransaction({
      kind: "expense",
      date: $("expenseDate").value,
      title: $("expenseTitle").value.trim() || "一般支出",
      amount: toNumber($("expenseAmount").value),
      gross_amount: toNumber($("expenseAmount").value)
    });
    event.target.reset();
    setDefaultDates();
    showToast("支出已新增");
    await refresh();
  }

  async function addAdvance(event) {
    event.preventDefault();
    const gross = toNumber($("advanceGross").value);
    const people = toNumber($("advancePeople").value);
    const own = $("advanceOwn").value
      ? toNumber($("advanceOwn").value)
      : people > 0
        ? Math.ceil(gross / people)
        : gross;
    const receivable = Math.max(0, gross - own);
    const title = $("advanceTitle").value.trim() || "代墊";
    const tx = await insertTransaction({
      kind: "advance",
      date: $("advanceDate").value,
      title,
      amount: own,
      gross_amount: gross,
      participant_count: people || null
    }, false);

    if (receivable > 0) {
      const { error } = await client.from("reimbursements").insert({
        user_id: state.user.id,
        cycle_id: state.cycle.id,
        transaction_id: tx.id,
        title,
        amount: receivable,
        status: "pending"
      });
      if (error) throw error;
    }

    event.target.reset();
    setDefaultDates();
    showToast("代墊已新增");
    await refresh();
  }

  async function insertTransaction(payload, reload = true) {
    const { data, error } = await client
      .from("transactions")
      .insert({
        user_id: state.user.id,
        cycle_id: state.cycle.id,
        ...payload
      })
      .select()
      .single();
    if (error) throw error;
    if (reload) await refresh();
    return data;
  }

  function runWish(event) {
    event.preventDefault();
    const amount = toNumber($("wishAmount").value);
    const title = $("wishTitle").value.trim() || "這筆購物";
    const summary = calculateSummary(amount);
    const canBuy = summary.buffer >= 0;
    const result = $("wishResult");
    result.hidden = false;
    result.innerHTML = `
      <p class="eyebrow">${escapeHtml(title)}</p>
      <span>${canBuy ? "買完仍達標" : "買完會低於最低存款"}</span>
      <strong>${money(summary.projected)}</strong>
      <p>${canBuy ? `安全餘裕剩 ${money(summary.buffer)}` : `還差 ${money(Math.abs(summary.buffer))} 才達標`}</p>
      <button class="primary-button full-width" type="button" id="buyNowButton">直接記為支出</button>
    `;
    $("buyNowButton").addEventListener("click", async () => {
      await insertTransaction({
        kind: "expense",
        date: today(),
        title,
        amount,
        gross_amount: amount
      });
      $("wishForm").reset();
      result.hidden = true;
      showToast("已記為支出");
    });
  }

  async function editTransaction(id) {
    const row = state.transactions.find((item) => item.id === id);
    if (!row) return;
    $("editId").value = row.id;
    $("editAmount").value = row.amount;
    $("editDate").value = row.date;
    $("editTitle").value = row.title || "";
    $("editDialog").showModal();
  }

  async function saveEdit(event) {
    event.preventDefault();
    const id = $("editId").value;
    const existing = state.transactions.find((item) => item.id === id);
    const amount = toNumber($("editAmount").value);
    const { error } = await client
      .from("transactions")
      .update({
        amount,
        gross_amount: existing?.kind === "advance"
          ? Math.max(toNumber(existing.gross_amount), amount)
          : amount,
        date: $("editDate").value,
        title: $("editTitle").value.trim() || "一般支出"
      })
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;
    $("editDialog").close();
    showToast("紀錄已更新");
    await refresh();
  }

  async function deleteTransaction(id) {
    if (!window.confirm("確定刪除這筆紀錄？相關待收款也會一起刪除。")) return;
    const { error } = await client
      .from("transactions")
      .delete()
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;
    showToast("紀錄已刪除");
    await refresh();
  }

  async function markReceived(id) {
    const { error } = await client
      .from("reimbursements")
      .update({ status: "received", received_at: today() })
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;
    showToast("待收款已結清");
    await refresh();
  }

  async function deleteReimbursement(id) {
    if (!window.confirm("確定刪除這筆待收款？")) return;
    const { error } = await client
      .from("reimbursements")
      .delete()
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;
    showToast("待收款已刪除");
    await refresh();
  }

  async function closeCycle() {
    if (!state.cycle) return;
    if (!window.confirm("要結束目前週期並開始新的發薪週期嗎？")) return;
    const { error } = await client
      .from("budget_cycles")
      .update({ is_closed: true, closed_at: new Date().toISOString() })
      .eq("id", state.cycle.id)
      .eq("user_id", state.user.id);
    if (error) throw error;
    state.cycle = null;
    showToast("已結束本期");
    await refresh();
  }

  async function downloadBackup() {
    const [cycles, transactions, reimbursements, settings] = await Promise.all([
      client.from("budget_cycles").select("*").eq("user_id", state.user.id),
      client.from("transactions").select("*").eq("user_id", state.user.id),
      client.from("reimbursements").select("*").eq("user_id", state.user.id),
      client.from("user_settings").select("*").eq("user_id", state.user.id)
    ]);
    [cycles, transactions, reimbursements, settings].forEach((result) => {
      if (result.error) throw result.error;
    });
    const blob = new Blob([JSON.stringify({
      exported_at: new Date().toISOString(),
      budget_cycles: cycles.data,
      transactions: transactions.data,
      reimbursements: reimbursements.data,
      user_settings: settings.data
    }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `left-backup-${today()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function restoreBackup(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const backup = JSON.parse(await file.text());
    if (!window.confirm("還原會新增備份中的資料，請確認這是自己的備份檔。")) return;

    const rewrite = (rows) => (rows || []).map((row) => {
      const copy = { ...row, user_id: state.user.id };
      delete copy.created_at;
      delete copy.updated_at;
      return copy;
    });

    for (const table of ["budget_cycles", "transactions", "reimbursements", "user_settings"]) {
      const rows = rewrite(backup[table]);
      if (!rows.length) continue;
      const { error } = await client.from(table).upsert(rows);
      if (error) throw error;
    }
    showToast("備份已還原");
    await refresh();
  }

  function setDefaultDates() {
    ["expenseDate", "advanceDate"].forEach((id) => {
      const input = $(id);
      if (input) input.value = today();
    });
  }

  function wireEvents() {
    $("authForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = $("emailInput").value.trim();
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.href }
      });
      $("authMessage").textContent = error
        ? `寄送失敗：${formatSupabaseFetchError(error)}`
        : "登入連結已寄出，請去信箱點選連結。";
    });

    $("signOutButton").addEventListener("click", async () => {
      await client.auth.signOut();
      window.location.reload();
    });

    $("cycleForm").addEventListener("submit", wrap(createCycle));
    $("expenseForm").addEventListener("submit", wrap(addExpense));
    $("advanceForm").addEventListener("submit", wrap(addAdvance));
    $("wishForm").addEventListener("submit", runWish);
    $("editForm").addEventListener("submit", wrap(saveEdit));
    $("cancelEditButton").addEventListener("click", () => $("editDialog").close());
    $("newCycleButton").addEventListener("click", wrap(closeCycle));
    $("backupButton").addEventListener("click", wrap(downloadBackup));
    $("restoreInput").addEventListener("change", wrap(restoreBackup));

    document.querySelectorAll(".tab-button").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".tab-button").forEach((item) => item.classList.remove("active"));
        document.querySelectorAll(".work-panel").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        $(button.dataset.panel).classList.add("active");
      });
    });

    $("recordList").addEventListener("click", wrap(async (event) => {
      const editId = event.target.dataset.edit;
      const deleteId = event.target.dataset.delete;
      if (editId) await editTransaction(editId);
      if (deleteId) await deleteTransaction(deleteId);
    }));

    $("reimbursementList").addEventListener("click", wrap(async (event) => {
      const receivedId = event.target.dataset.received;
      const deleteId = event.target.dataset.deleteReimbursement;
      if (receivedId) await markReceived(receivedId);
      if (deleteId) await deleteReimbursement(deleteId);
    }));
  }

  function wrap(fn) {
    return async function wrapped(event) {
      try {
        await fn(event);
      } catch (error) {
        console.error(error);
        showToast(error.message || "操作失敗，請稍後再試");
      }
    };
  }

  setDefaultDates();
  wireEvents();
  initAuth().catch((error) => {
    console.error(error);
    showToast("初始化失敗，請檢查 Supabase 設定");
  });
})();
