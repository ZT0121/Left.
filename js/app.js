(function () {
  const config = window.LEFT_SUPABASE || window.MYLEDGER_SUPABASE || {};
  const hasConfig = Boolean(config.url && config.anonKey);
  const client = hasConfig && window.supabase
    ? window.supabase.createClient(config.url, config.anonKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "implicit",
        persistSession: true
      }
    })
    : null;

  const state = {
    user: null,
    settings: null,
    cycle: null,
    transactions: [],
    reimbursements: [],
    creditCards: [],
    cardCharges: [],
    installmentPlans: [],
    accounts: [],
    accountTransfers: [],
    incomeRecords: [],
    subscriptions: [],
    historyCycles: [],
    historyTransactions: [],
    historyIncomeRecords: [],
    historyReimbursements: [],
    historyLoaded: false
  };

  const $ = (id) => document.getElementById(id);
  const money = (value) => new Intl.NumberFormat("zh-TW", {
    style: "currency",
    currency: "TWD",
    maximumFractionDigits: 0
  }).format(Number(value || 0));
  const formatDate = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };
  const parseLocalDate = (value) => {
    const [year, month, day] = String(value).split("-").map(Number);
    return new Date(year, month - 1, day);
  };
  const today = () => formatDate(new Date());
  const toNumber = window.LeftBudget.toNumber;
  const supabaseUrl = String(config.url || "").replace(/\/+$/, "");
  const daysBetween = window.LeftBudget.daysBetween;
  const estimatedCardSources = new Set(["general", "advance", "installment", "subscription"]);

  function currentMonth() {
    return today().slice(0, 7);
  }

  function dateForMonthDay(month, day) {
    const [year, monthIndex] = month.split("-").map(Number);
    const lastDay = new Date(year, monthIndex, 0).getDate();
    return `${month}-${String(Math.min(Number(day) || 1, lastDay)).padStart(2, "0")}`;
  }

  function isSubscriptionDueInMonth(row, month = currentMonth()) {
    if (row.is_active === false) return false;
    if ((row.billing_cycle || "monthly") !== "yearly") return true;
    return Number(row.charge_month) === Number(month.slice(5, 7));
  }

  function isEstimatedCardCharge(row) {
    return estimatedCardSources.has(row.source_type);
  }

  function isActualStatement(row) {
    return row.source_type === "opening_bill";
  }

  function shouldDeriveStatementDate(row) {
    return row.source_type === "general" || row.source_type === "advance" || row.source_type === "subscription";
  }

  function getCardStatementDate(row) {
    if (!row.card_id) return row.charge_date || row.due_date || "";
    if (isEstimatedCardCharge(row) && row.charge_date && shouldDeriveStatementDate(row)) {
      return getCardClosingDate(row.card_id, row.charge_date);
    }
    return row.charge_date || row.due_date || "";
  }

  function getEffectiveCardChargeDueDate(row) {
    if (!row.card_id) return row.due_date || "";
    if (isEstimatedCardCharge(row) && row.charge_date && shouldDeriveStatementDate(row)) {
      return getCardDueDate(row.card_id, row.charge_date);
    }
    return row.due_date || "";
  }

  function cardStatementKey(row) {
    const statementDate = getCardStatementDate(row);
    return row.card_id && statementDate ? `${row.card_id}:${String(statementDate).slice(0, 7)}` : "";
  }

  function formatDifference(value) {
    const amount = toNumber(value);
    if (amount === 0) return "$0";
    return `${amount > 0 ? "+" : "-"}${money(Math.abs(amount))}`;
  }

  function getEstimateFor(cardId, dueDate) {
    if (!cardId || !dueDate) return 0;
    const actualRow = state.cardCharges.find((row) => isActualStatement(row) && row.card_id === cardId && row.due_date === dueDate);
    const statementKey = actualRow ? cardStatementKey(actualRow) : `${cardId}:${String(dueDate).slice(0, 7)}`;
    return [...state.cardCharges, ...getSubscriptionCardEstimateRows(), ...getUpcomingInstallmentEstimateRows()]
      .filter((row) => isEstimatedCardCharge(row) && row.card_id === cardId && cardStatementKey(row) === statementKey)
      .reduce((sum, row) => sum + toNumber(row.amount), 0);
  }

  function getEstimateItemsForActual(row) {
    if (!isActualStatement(row) || !row.card_id || !row.due_date) return [];
    const key = cardStatementKey(row);
    return [...state.cardCharges, ...getSubscriptionCardEstimateRows(), ...getUpcomingInstallmentEstimateRows()]
      .filter((item) => isEstimatedCardCharge(item) && item.card_id === row.card_id && cardStatementKey(item) === key)
      .sort((a, b) => String(a.charge_date || a.due_date || "").localeCompare(String(b.charge_date || b.due_date || "")));
  }

  function getSubscriptionCardEstimateRows() {
    const month = currentMonth();
    return state.subscriptions
      .filter((row) => isSubscriptionDueInMonth(row, month) && row.payment_method === "credit_card" && row.credit_card_id)
      .map((row) => {
        const chargeDate = dateForMonthDay(month, row.charge_day);
        return {
          id: `subscription:${row.id}:${month}`,
          source_type: "subscription",
          title: row.title,
          card_id: row.credit_card_id,
          charge_date: chargeDate,
          due_date: getCardDueDate(row.credit_card_id, chargeDate),
          amount: toNumber(row.amount),
          status: "pending",
          created_at: row.created_at || chargeDate
        };
      });
  }

  function getUpcomingInstallmentEstimateRows() {
    const month = currentMonth();
    const nextMonth = window.LeftBudget.addMonths(`${month}-01`, 1).slice(0, 7);
    const visibleMonths = new Set([month, nextMonth]);
    const existingKeys = new Set(
      state.cardCharges
        .filter((row) => row.installment_plan_id && row.installment_number)
        .map((row) => `${row.installment_plan_id}:${row.installment_number}`)
    );

    return state.installmentPlans
      .filter((plan) => plan.is_active !== false)
      .flatMap((plan) => window.LeftBudget.createInstallmentSchedule(plan)
        .filter((item) => visibleMonths.has(String(item.due_date).slice(0, 7)))
        .filter((item) => !existingKeys.has(`${plan.id}:${item.installment_number}`))
        .map((item) => ({
          id: `installment-estimate:${plan.id}:${item.installment_number}`,
          source_type: "installment",
          title: `${plan.title} ${item.installment_number}/${plan.installment_count}`,
          card_id: plan.card_id,
          installment_plan_id: plan.id,
          installment_number: item.installment_number,
          charge_date: item.due_date,
          due_date: item.due_date,
          amount: item.amount,
          status: "pending",
          created_at: item.due_date
        })));
  }

  function getEstimatedStatementGroups() {
    const actualKeys = new Set(
      state.cardCharges
        .filter(isActualStatement)
        .map(cardStatementKey)
        .filter(Boolean)
    );
    const groups = new Map();

    [...state.cardCharges, ...getSubscriptionCardEstimateRows(), ...getUpcomingInstallmentEstimateRows()]
      .filter((row) => isEstimatedCardCharge(row) && (row.due_date || row.charge_date))
      .forEach((row) => {
        const key = cardStatementKey(row);
        if (!key || actualKeys.has(key)) return;
        const dueDate = getEffectiveCardChargeDueDate(row);
        const current = groups.get(key) || {
          key,
          card_id: row.card_id,
          due_date: dueDate,
          amount: 0,
          count: 0,
          items: [],
          first_charge_date: row.charge_date || row.created_at || "",
          last_charge_date: row.charge_date || row.created_at || ""
        };
        if (dueDate && (!current.due_date || dueDate > current.due_date)) {
          current.due_date = dueDate;
        }
        current.amount += toNumber(row.amount);
        current.count += 1;
        current.items.push(row);
        if (row.charge_date && (!current.first_charge_date || row.charge_date < current.first_charge_date)) {
          current.first_charge_date = row.charge_date;
        }
        if (row.charge_date && (!current.last_charge_date || row.charge_date > current.last_charge_date)) {
          current.last_charge_date = row.charge_date;
        }
        groups.set(key, current);
      });

    return [...groups.values()]
      .sort((a, b) => `${b.due_date}${b.last_charge_date}`.localeCompare(`${a.due_date}${a.last_charge_date}`));
  }

  function getCardStatementRows() {
    return [
      ...getEstimatedStatementGroups().map((row) => ({ ...row, row_type: "estimate" })),
      ...state.cardCharges
        .filter((row) => !isEstimatedCardCharge(row))
        .map((row) => ({ ...row, row_type: "actual" }))
    ].sort((a, b) => `${b.due_date || ""}${b.created_at || b.last_charge_date || ""}`.localeCompare(`${a.due_date || ""}${a.created_at || a.last_charge_date || ""}`));
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js?v=20260719.12")
        .then((registration) => {
          registration.addEventListener("updatefound", () => {
            const worker = registration.installing;
            if (!worker) return;
            worker.addEventListener("statechange", () => {
              if (worker.state === "activated" && navigator.serviceWorker.controller) {
                showToast("新版已準備好，重新整理後套用");
              }
            });
          });
        })
        .catch((error) => console.warn("Service worker registration failed", error));
    });
  }

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

  function showConfigWarning(title, text) {
    $("configWarningTitle").textContent = title;
    $("configWarningText").innerHTML = text;
    setVisible("configWarning", true);
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
    return window.LeftBudget.summarizeBudget({
      ...state,
      cardCharges: [...state.cardCharges, ...getSubscriptionCardEstimateRows(), ...getUpcomingInstallmentEstimateRows()]
    }, {
      spend: extraSpend,
      today: today(),
      currentMonth: currentMonth()
    });
  }

  function applyStatus(buffer) {
    const hero = $("heroCard");
    const pill = $("statusPill");
    hero.classList.remove("safe", "warning", "danger");
    pill.classList.remove("safe", "warning", "danger");

    if (buffer < 0) {
      hero.classList.add("danger");
      pill.classList.add("danger");
      pill.textContent = "低於最低保留";
      return;
    }

    if (buffer <= 1000) {
      hero.classList.add("warning");
      pill.classList.add("warning");
      pill.textContent = "接近最低保留";
      return;
    }

    hero.classList.add("safe");
    pill.classList.add("safe");
    pill.textContent = "最低保留已守住";
  }

  function renderDashboard() {
    if (!state.cycle) return;

    const summary = calculateSummary();
    $("projectedSavings").textContent = money(summary.projected);
    $("safetyBuffer").textContent = money(summary.commitmentBuffer);
    const safetyBreakdown = $("safetyBreakdown");
    if (safetyBreakdown) {
      safetyBreakdown.textContent = `結餘 ${money(summary.projected)} − 最低保留 ${money(state.cycle.minimum_savings)} − 未來分期 ${money(summary.futureInstallmentBalance)}`;
    }
    $("spentAmount").textContent = money(summary.spent);
    $("pendingAmount").textContent = money(summary.pending);
    $("dailyAllowance").textContent = money(summary.totalIncome);
    $("cardDueAmount").textContent = money(summary.cardDueActual);
    const cardDueDetail = $("cardDueDetail");
    if (cardDueDetail) {
      const paidActual = state.cardCharges
        .filter((row) => isActualStatement(row) && row.status === "paid")
        .reduce((sum, row) => sum + toNumber(row.amount), 0);
      cardDueDetail.textContent = `本期已繳 ${money(paidActual)} · 下期預估 ${money(summary.cardDueEstimate)}`;
    }
    $("futureInstallmentAmount").textContent = money(summary.futureInstallmentBalance);
    $("cycleRange").textContent = `從 ${state.cycle.start_date} 開始`;
    const subscriptionText = summary.subscriptionEstimate
      ? `含本月訂閱預估 ${money(summary.subscriptionEstimate)}。`
      : "";
    $("safetyText").textContent = summary.commitmentBuffer >= 0
      ? `保留 ${money(state.cycle.minimum_savings)} 並扣掉未來分期後，接下來可安排 ${money(summary.commitmentBuffer)}；尚未記錄的生活費仍會從這裡支出。${subscriptionText}`
      : `扣掉未來分期後，還差 ${money(Math.abs(summary.commitmentBuffer))} 才能保留 ${money(state.cycle.minimum_savings)}。${subscriptionText}`;
    applyStatus(summary.commitmentBuffer);
    renderCardOptions();
    renderCreditCards();
    renderTransactions();
    renderReimbursements();
    renderCardCharges();
    renderInstallments();
    renderAccountOptions();
    renderAccounts();
    renderTransfers();
    renderIncomeRecords();
    renderSubscriptions();
    renderBillReminders();
    renderMotherRequest();
  }

  function renderTransactions() {
    const list = $("recordList");
    const transactionRows = [...state.transactions]
      .filter((row) => row.kind === "expense" || row.kind === "advance")
      .map((row) => ({
        ...row,
        activityType: row.kind === "advance" ? "代墊" : "支出",
        activityDate: row.date,
        activityTitle: row.title || (row.kind === "advance" ? "代墊" : "一般支出"),
        activityAmount: row.amount,
        amountPrefix: "−"
      }));
    const incomeRows = state.incomeRecords.map((row) => ({
      ...row,
      activityType: "收入",
      activityDate: row.date,
      activityTitle: row.title || "收入",
      activityAmount: row.amount,
      amountPrefix: "+"
    }));
    const reimbursementRows = state.reimbursements.map((row) => ({
      ...row,
      activityType: row.status === "received" ? "已收回補" : "待收",
      activityDate: row.received_at || String(row.created_at || "").slice(0, 10),
      activityTitle: row.title || "待收款",
      activityAmount: row.amount,
      amountPrefix: ""
    }));
    const rows = [...transactionRows, ...incomeRows, ...reimbursementRows]
      .sort((a, b) => `${b.activityDate || ""}${b.created_at || ""}`.localeCompare(`${a.activityDate || ""}${a.created_at || ""}`))
      .slice(0, 5);

    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">目前還沒有動態。第一筆就從最常見的支出開始。</p>';
      return;
    }

    list.innerHTML = rows.map((row) => `
      <article class="record-item">
        <div>
          <p class="record-title">${escapeHtml(row.activityTitle)}</p>
          <p class="record-meta">${row.activityDate || "未填日期"} · ${row.activityType}${row.kind === "advance" ? ` · 總金額 ${money(row.gross_amount)}` : ""}</p>
        </div>
        <div class="record-amount">${row.amountPrefix}${money(row.activityAmount)}</div>
        ${row.activityType === "支出" || row.activityType === "代墊" ? `
          <div class="record-actions">
            <button type="button" data-edit="${row.id}">編輯</button>
            <button type="button" data-delete="${row.id}">刪除</button>
          </div>
        ` : ""}
      </article>
    `).join("");
  }

  function renderReimbursements() {
    const list = $("reimbursementList");
    const rows = [...state.reimbursements]
      .filter((row) => row.status === "pending")
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

  function setupListTabs() {
    if ($("listTabs")) return;

    const sections = [
      { id: "recordSection", key: "records", listId: "recordList", label: "近期紀錄" },
      { id: "reimbursementSection", key: "reimbursements", listId: "reimbursementList", label: "待收款" },
      { id: "billReminderSection", key: "billReminders", listId: "billReminderList", label: "帳單提醒" },
      { id: "cardChargeSection", key: "cardCharges", listId: "cardChargeList", label: "信用卡明細" },
      { id: "installmentSection", key: "installments", listId: "installmentList", label: "分期計畫" }
    ].map((item) => ({
      ...item,
      section: $(item.listId)?.closest(".list-section")
    })).filter((item) => item.section);

    if (!sections.length) return;

    sections.forEach((item) => {
      if (item.key === "billReminders") item.label = "帳單提醒";
      if (item.key === "cardCharges") item.label = "信用卡帳單";
      if (item.key === "installments") item.label = "分期計畫";
    });

    const nav = document.createElement("nav");
    nav.id = "listTabs";
    nav.className = "list-tabs";
    nav.setAttribute("aria-label", "資料清單");

    sections.forEach((item) => {
      item.section.id = item.id;
      item.section.classList.add("collapsible-list-section");
      item.section.classList.remove("active");

      const button = document.createElement("button");
      button.className = "list-tab-button";
      button.type = "button";
      button.dataset.listSection = item.id;
      button.dataset.listKey = item.key;
      button.innerHTML = `<span>${item.label}</span><strong class="list-tab-count">0</strong>`;
      nav.appendChild(button);
    });

    sections[0].section.before(nav);

    nav.addEventListener("click", (event) => {
      const button = event.target.closest(".list-tab-button");
      if (!button) return;
      const shouldOpen = !button.classList.contains("active");
      nav.querySelectorAll(".list-tab-button").forEach((item) => {
        item.classList.toggle("active", shouldOpen && item === button);
      });
      sections.forEach((item) => {
        item.section.classList.toggle("active", shouldOpen && item.id === button.dataset.listSection);
      });
    });
  }

  function updateListTabCounts() {
    const nav = $("listTabs");
    if (!nav) return;
    const counts = {
      records: state.transactions.filter((row) => row.kind === "expense" || row.kind === "advance").length,
      reimbursements: state.reimbursements.filter((row) => row.status === "pending").length,
      billReminders: getBillReminderRows().length,
      cardCharges: getCardStatementRows().length,
      installments: state.installmentPlans.length
    };
    nav.querySelectorAll(".list-tab-button").forEach((button) => {
      const count = counts[button.dataset.listKey] || 0;
      const badge = button.querySelector(".list-tab-count");
      if (badge) badge.textContent = count;
      button.classList.toggle("has-items", count > 0);
    });
  }

  function openListSection(sectionId) {
    const nav = $("listTabs");
    if (!nav) return;
    nav.querySelectorAll(".list-tab-button").forEach((button) => {
      button.classList.toggle("active", button.dataset.listSection === sectionId);
    });
    document.querySelectorAll(".collapsible-list-section").forEach((section) => {
      section.classList.toggle("active", section.id === sectionId);
    });
  }

  function showPendingCardEstimateDetails() {
    const list = $("cardChargeList");
    if (!list) return;
    list.dataset.cardStatementTab = "estimate";
    renderCardCharges();
    document.querySelector('[data-panel="cardPanel"]')?.click();
    const target = list.closest(".list-section") || list;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    if (!getEstimatedStatementGroups().length) {
      showToast("目前沒有未出帳預估明細");
    }
  }

  function showReimbursementDetails() {
    const list = $("reimbursementList");
    if (!list) return;
    document.querySelectorAll(".tab-button[data-panel]").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".work-panel").forEach((item) => item.classList.remove("active"));
    $("openAppMenuButton")?.classList.remove("active");
    $("reimbursementPanel")?.classList.add("active");
    $("reimbursementPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (!state.reimbursements.some((row) => row.status === "pending")) {
      showToast("目前沒有待收款明細");
    }
  }

  function showIncomeDetails() {
    const panelButton = document.querySelector('[data-panel="incomePanel"]');
    if (panelButton) panelButton.click();
    const target = $("incomeList") || $("incomePanel");
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (!state.incomeRecords.length) {
      showToast("目前沒有收入明細");
    }
  }

  function showInstallmentDetails() {
    const list = $("installmentList");
    if (!list) return;
    document.querySelector('[data-panel="installmentPanel"]')?.click();
    const target = list.closest(".list-section") || list;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    if (!state.installmentPlans.length) {
      showToast("目前沒有分期細項");
    }
  }

  function makeMetricClickable(amountId, label, handler) {
    const metric = $(amountId)?.closest(".metric-card");
    if (!metric) return;
    metric.classList.add("clickable-metric");
    metric.setAttribute("role", "button");
    metric.setAttribute("tabindex", "0");
    metric.setAttribute("aria-label", label);
    metric.addEventListener("click", handler);
    metric.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      handler();
    });
  }

  function renderCardOptions() {
    const activeCards = state.creditCards.filter((card) => card.is_active);
    const options = activeCards.length
      ? activeCards.map((card) => `<option value="${card.id}">${escapeHtml(card.name)}</option>`).join("")
      : '<option value="">請先新增信用卡</option>';

    ["expenseCardSelect", "advanceCardSelect", "openingBillCardSelect", "installmentCardSelect", "cardFeeCardSelect", "subscriptionCardSelect", "editCardSelect"].forEach((id) => {
      const select = $(id);
      if (select) select.innerHTML = options;
    });

    toggleCardFields();
    fillOpeningBillDatesFromCard();
  }

  function renderAccountOptions() {
    const activeAccounts = state.accounts.filter((account) => account.is_active !== false);
    const options = activeAccounts.length
      ? activeAccounts.map((account) => `<option value="${account.id}">${escapeHtml(account.name)}</option>`).join("")
      : '<option value="">請先新增帳戶</option>';

    ["expenseAccountSelect", "advanceAccountSelect", "incomeAccountSelect", "transferFromSelect", "transferToSelect", "subscriptionAccountSelect", "editAccountSelect"].forEach((id) => {
      const select = $(id);
      if (select) select.innerHTML = options;
    });
  }

  function getAccountBalances() {
    return window.LeftBudget.calculateAccountBalances(state);
  }

  function renderAccounts() {
    const list = $("accountList");
    if (!list) return;
    const rows = getAccountBalances();
    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">先新增銀行、現金或街口支付帳戶，之後儲值就可以用轉帳記錄。</p>';
      return;
    }

    const typeLabel = {
      bank: "銀行",
      wallet: "電子錢包",
      cash: "現金",
      other: "其他"
    };

    list.innerHTML = rows.map((account) => `
      <article class="record-item">
        <div>
          <p class="record-title">${escapeHtml(account.name)}</p>
          <p class="record-meta">${typeLabel[account.type] || "其他"} · 期初 ${money(account.opening_balance)}</p>
        </div>
        <div class="record-amount">${money(account.balance)}</div>
        <div class="record-actions">
          <button type="button" data-edit-account="${account.id}">編輯</button>
        </div>
      </article>
    `).join("");
  }

  function renderTransfers() {
    const list = $("transferList");
    if (!list) return;
    const accountsById = new Map(state.accounts.map((account) => [account.id, account]));
    const rows = [...state.accountTransfers]
      .sort((a, b) => `${b.date}${b.created_at}`.localeCompare(`${a.date}${a.created_at}`))
      .slice(0, 8);

    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">還沒有轉帳／儲值紀錄。</p>';
      return;
    }

    list.innerHTML = rows.map((row) => `
      <article class="record-item">
        <div>
          <p class="record-title">${escapeHtml(row.title || "轉帳／儲值")}</p>
          <p class="record-meta">${row.date} · ${escapeHtml(accountsById.get(row.from_account_id)?.name || "來源")} → ${escapeHtml(accountsById.get(row.to_account_id)?.name || "目的")}</p>
        </div>
        <div class="record-amount">${money(row.amount)}</div>
        <div class="record-actions">
          <button type="button" data-delete-transfer="${row.id}">刪除</button>
        </div>
      </article>
    `).join("");
  }

  function renderIncomeRecords() {
    const list = $("incomeList");
    if (!list) return;
    const accountsById = new Map(state.accounts.map((account) => [account.id, account]));
    const rows = [...state.incomeRecords]
      .sort((a, b) => `${b.date}${b.created_at}`.localeCompare(`${a.date}${a.created_at}`))
      .slice(0, 8);

    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">還沒有收入紀錄。</p>';
      return;
    }

    const typeLabel = {
      salary: "薪水",
      mother: "媽媽支援",
      other: "其他收入"
    };

    list.innerHTML = rows.map((row) => `
      <article class="record-item">
        <div>
          <p class="record-title">${escapeHtml(row.title || typeLabel[row.income_type] || "收入")}</p>
          <p class="record-meta">${row.date} · ${typeLabel[row.income_type] || "收入"} · ${escapeHtml(accountsById.get(row.account_id)?.name || "未指定帳戶")}</p>
        </div>
        <div class="record-amount">${money(row.amount)}</div>
        <div class="record-actions">
          <button type="button" data-delete-income="${row.id}">刪除</button>
        </div>
      </article>
    `).join("");
  }

  function renderSubscriptions() {
    const list = $("subscriptionList");
    if (!list) return;
    const cardsById = new Map(state.creditCards.map((card) => [card.id, card]));
    const accountsById = new Map(state.accounts.map((account) => [account.id, account]));
    const rows = [...state.subscriptions]
      .sort((a, b) => Number(a.charge_day) - Number(b.charge_day) || String(a.title).localeCompare(String(b.title)));

    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">還沒有每月訂閱項目。</p>';
      return;
    }

    list.innerHTML = rows.map((row) => {
      const payTarget = row.payment_method === "credit_card"
        ? cardsById.get(row.credit_card_id)?.name || "信用卡"
        : accountsById.get(row.account_id)?.name || "帳戶／現金";
      const statusText = row.is_active === false ? "已停用" : isRecorded ? "本月已記入" : "本月待記入";

      return `
        <article class="record-item">
          <div>
            <p class="record-title">${escapeHtml(row.title)}</p>
            <p class="record-meta">每月 ${row.charge_day} 日 · ${escapeHtml(payTarget)} · ${statusText}</p>
          </div>
          <div class="record-amount">${money(row.amount)}</div>
          <div class="record-actions">
            ${row.is_active !== false && !isRecorded ? `<button type="button" data-record-subscription="${row.id}">記入本月</button>` : ""}
            <button type="button" data-toggle-subscription="${row.id}">${row.is_active === false ? "啟用" : "停用"}</button>
            <button type="button" data-delete-subscription="${row.id}">刪除</button>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderSubscriptions() {
    const list = $("subscriptionList");
    if (!list) return;
    const cardsById = new Map(state.creditCards.map((card) => [card.id, card]));
    const accountsById = new Map(state.accounts.map((account) => [account.id, account]));
    const rows = [...state.subscriptions]
      .sort((a, b) => Number(a.charge_day) - Number(b.charge_day) || String(a.title).localeCompare(String(b.title)));

    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">還沒有每月訂閱項目。</p>';
      return;
    }

    list.innerHTML = rows.map((row) => {
      const payTarget = row.payment_method === "credit_card"
        ? cardsById.get(row.credit_card_id)?.name || "信用卡"
        : accountsById.get(row.account_id)?.name || "帳戶／現金";
      const statusText = row.is_active === false ? "已停用" : "每月自動預估";

      return `
        <article class="record-item">
          <div>
            <p class="record-title">${escapeHtml(row.title)}</p>
            <p class="record-meta">每月 ${row.charge_day} 日 · ${escapeHtml(payTarget)} · ${statusText}</p>
          </div>
          <div class="record-amount">${money(row.amount)}</div>
          <div class="record-actions">
            <button type="button" data-toggle-subscription="${row.id}">${row.is_active === false ? "啟用" : "停用"}</button>
            <button type="button" data-delete-subscription="${row.id}">刪除</button>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderSubscriptions() {
    const list = $("subscriptionList");
    if (!list) return;
    const cardsById = new Map(state.creditCards.map((card) => [card.id, card]));
    const accountsById = new Map(state.accounts.map((account) => [account.id, account]));
    const rows = [...state.subscriptions]
      .sort((a, b) => Number(a.charge_month || 0) - Number(b.charge_month || 0)
        || Number(a.charge_day) - Number(b.charge_day)
        || String(a.title).localeCompare(String(b.title)));

    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">還沒有每月或每年訂閱項目。</p>';
      return;
    }

    list.innerHTML = rows.map((row) => {
      const payTarget = row.payment_method === "credit_card"
        ? cardsById.get(row.credit_card_id)?.name || "信用卡"
        : accountsById.get(row.account_id)?.name || "帳戶／現金";
      const scheduleText = (row.billing_cycle || "monthly") === "yearly"
        ? `每年 ${row.charge_month || "?"} 月 ${row.charge_day} 日`
        : `每月 ${row.charge_day} 日`;
      const statusText = row.is_active === false ? "已停用" : "自動納入預估";

      return `
        <article class="record-item">
          <div>
            <p class="record-title">${escapeHtml(row.title)}</p>
            <p class="record-meta">${scheduleText} · ${escapeHtml(payTarget)} · ${statusText}</p>
          </div>
          <div class="record-amount">${money(row.amount)}</div>
          <div class="record-actions">
            <button type="button" data-toggle-subscription="${row.id}">${row.is_active === false ? "啟用" : "停用"}</button>
            <button type="button" data-delete-subscription="${row.id}">刪除</button>
          </div>
        </article>
      `;
    }).join("");
  }

  function getBillReminderRows() {
    const current = today();
    const actualRows = state.cardCharges
      .filter((row) => !isEstimatedCardCharge(row) && row.status !== "paid" && row.due_date)
      .map((row) => ({
        ...row,
        row_type: "actual",
        daysLeft: Math.ceil((parseLocalDate(row.due_date) - parseLocalDate(current)) / 86400000)
      }));
    const estimateRows = getEstimatedStatementGroups()
      .map((row) => ({
        ...row,
        id: row.key,
        title: "預估帳單",
        row_type: "estimate",
        daysLeft: Math.ceil((parseLocalDate(row.due_date) - parseLocalDate(current)) / 86400000)
      }));

    return [...actualRows, ...estimateRows]
      .filter((row) => row.daysLeft <= 7)
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }

  function renderBillReminders() {
    const list = $("billReminderList");
    if (!list) return;
    const rows = getBillReminderRows();
    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">7 天內沒有需要提醒的信用卡帳單。</p>';
      return;
    }

    list.innerHTML = rows.map((row) => {
      const card = state.creditCards.find((item) => item.id === row.card_id);
      const dueText = row.daysLeft < 0
        ? `逾期 ${Math.abs(row.daysLeft)} 天`
        : row.daysLeft === 0
          ? "今天到期"
          : `${row.daysLeft} 天後到期`;

      return `
        <article class="record-item reminder-item ${row.daysLeft < 0 ? "overdue" : ""}">
          <div>
            <p class="record-title">${escapeHtml(row.title)}</p>
            <p class="record-meta">${escapeHtml(card?.name || "信用卡")} · ${row.due_date} · ${dueText}</p>
          </div>
          <div class="record-amount">${money(row.amount)}</div>
          <div class="record-actions">
            <button type="button" data-pay-card-charge="${row.id}">標記已繳</button>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderBillReminders() {
    const list = $("billReminderList");
    if (!list) return;
    const rows = getBillReminderRows();
    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">7 天內沒有信用卡帳單要處理。</p>';
      return;
    }

    list.innerHTML = rows.map((row) => {
      const card = state.creditCards.find((item) => item.id === row.card_id);
      const cardName = card?.name || "信用卡";
      const dueText = row.daysLeft < 0
        ? `逾期 ${Math.abs(row.daysLeft)} 天`
        : row.daysLeft === 0
          ? "今天到期"
          : `${row.daysLeft} 天後到期`;
      const note = row.row_type === "estimate" ? "尚未輸入實際帳單" : "實際帳單待繳";
      const title = row.row_type === "estimate" ? `${cardName} 預估帳單` : `${cardName} ${row.title || "實際帳單"}`;

      return `
        <article class="record-item reminder-item ${row.daysLeft < 0 ? "overdue" : ""}">
          <div>
            <p class="record-title">${escapeHtml(title)}</p>
            <p class="record-meta">${row.due_date} · ${dueText} · ${note}</p>
          </div>
          <div class="record-amount">${money(row.amount)}</div>
          <div class="record-actions">
            ${row.row_type === "actual" ? `<button type="button" data-pay-card-charge="${row.id}">已繳款</button>` : ""}
          </div>
        </article>
      `;
    }).join("");
  }

  function renderMotherRequest() {
    const total = $("motherRequestTotal");
    const message = $("motherRequestMessage");
    if (!total || !message) return;

    const request = window.LeftBudget.calculateMotherRequest(state);
    const pendingRows = state.reimbursements.filter((row) => row.status === "pending");
    total.textContent = money(request.total);
    const details = pendingRows.length
      ? pendingRows.map((row) => `- ${row.title || "待收"}：${money(row.amount)}`).join("\n")
      : "- 目前沒有額外待收";
    message.value = [
      `媽媽，這個月生活費 ${money(request.support)}。`,
      `另外待收／代墊是 ${money(request.pending)}：`,
      details,
      `所以這次一共是 ${money(request.total)}，謝謝。`
    ].join("\n");
  }

  function renderCreditCards() {
    const list = $("cardList");
    if (!list) return;
    if (!state.creditCards.length) {
      list.innerHTML = '<p class="empty-state">先新增一張信用卡，刷卡與分期才有地方歸帳。</p>';
      return;
    }

    list.innerHTML = state.creditCards.map((card) => `
      <article class="record-item">
        <div>
          <p class="record-title">${escapeHtml(card.name)}</p>
          <p class="record-meta">結帳 ${card.closing_day} 號 · 繳款 ${card.payment_day} 號 · ${card.is_active ? "啟用中" : "已停用"}</p>
        </div>
        <div class="record-amount">${card.is_active ? "啟用" : "停用"}</div>
        <div class="record-actions">
          <button type="button" data-toggle-card="${card.id}">${card.is_active ? "停用" : "啟用"}</button>
          <button type="button" data-delete-card="${card.id}">刪除</button>
        </div>
      </article>
    `).join("");
  }

  function renderCardCharges() {
    const list = $("cardChargeList");
    const rows = [...state.cardCharges]
      .sort((a, b) => `${b.due_date || ""}${b.created_at}`.localeCompare(`${a.due_date || ""}${a.created_at}`));

    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">目前沒有本期信用卡待繳。</p>';
      return;
    }

    list.innerHTML = rows.map((row) => {
      const card = state.creditCards.find((item) => item.id === row.card_id);
      const closingDate = row.card_id ? getCardClosingDate(row.card_id, row.charge_date) : "";
      const sourceLabel = {
        general: "一般刷卡",
        advance: "代墊刷卡",
        installment: "本期分期",
        opening_bill: "期初帳單",
        fee: "費用／利息"
      }[row.source_type] || "信用卡";

      return `
        <article class="record-item">
          <div>
            <p class="record-title">${escapeHtml(row.title)}</p>
            <p class="record-meta">${sourceLabel} · ${escapeHtml(card?.name || "信用卡")} · 消費 ${row.charge_date} · 結帳 ${closingDate || "未設定"} · 繳款 ${row.due_date || "未設定"}${row.status === "paid" ? ` · 已繳 ${row.paid_at || ""}` : ""}</p>
          </div>
          <div class="record-amount">${money(row.amount)}</div>
          <div class="record-actions">
            ${row.status === "pending" ? `<button type="button" data-pay-card-charge="${row.id}">標記已繳</button>` : ""}
            <button type="button" data-edit-card-charge="${row.id}">編輯</button>
            <button type="button" data-delete-card-charge="${row.id}">刪除</button>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderCardCharges() {
    const list = $("cardChargeList");
    const rows = getCardStatementRows();

    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">還沒有信用卡帳單資料。</p>';
      return;
    }

    list.innerHTML = rows.map((row) => {
      const card = state.creditCards.find((item) => item.id === row.card_id);

      if (row.row_type === "estimate") {
        const cardName = card?.name || "信用卡";
        const periodText = row.first_charge_date && row.last_charge_date
          ? `${row.first_charge_date} 到 ${row.last_charge_date}`
          : "依目前刷卡紀錄";
        const sourceLabel = {
          general: "一般刷卡",
          advance: "代墊",
          installment: "分期",
          subscription: "訂閱"
        };
        const detailSourceLabel = {
          general: "一般刷卡",
          advance: "代墊",
          installment: "分期",
          subscription: "訂閱"
        };
        const detailRows = [...(row.items || [])]
          .sort((a, b) => String(a.charge_date || "").localeCompare(String(b.charge_date || "")))
          .map((item) => `
            <div class="statement-detail-row">
              <span>${item.charge_date || "未填"} · ${sourceLabel[item.source_type] || "預估"} · ${escapeHtml(item.title || "未命名")}</span>
              <strong>${money(item.amount)}</strong>
            </div>
          `).join("");
        const visibleDetailRows = [...(row.items || [])]
          .sort((a, b) => String(a.charge_date || "").localeCompare(String(b.charge_date || "")))
          .map((item) => `
            <div class="statement-detail-row">
              <span>${item.charge_date || "未填"} · ${detailSourceLabel[item.source_type] || "預估"} · ${escapeHtml(item.title || "未命名")}</span>
              <strong>${money(item.amount)}</strong>
            </div>
          `).join("");
        return `
          <article class="record-item statement-estimate">
            <div>
              <p class="record-title">${escapeHtml(cardName)} 預估帳單</p>
              <p class="record-meta">繳款日 ${row.due_date} · ${row.count} 筆紀錄預估 · ${periodText} · 尚未輸入實際帳單</p>
              <details class="statement-details">
                <summary>查看未出帳明細</summary>
                <div class="statement-detail-list">${visibleDetailRows}</div>
              </details>
            </div>
            <div class="record-amount">${money(row.amount)}</div>
            <div class="record-actions"></div>
          </article>
        `;
      }

      const sourceLabel = {
        opening_bill: "實際帳單",
        installment: "分期",
        fee: "費用／利息"
      }[row.source_type] || "信用卡";
      const cardName = card?.name || "信用卡";
      const displayTitle = isActualStatement(row)
        ? `${cardName} ${sourceLabel}`
        : `${cardName} ${row.title || sourceLabel}`;
      const estimate = isActualStatement(row) ? getEstimateFor(row.card_id, row.due_date) : 0;
      const diffText = isActualStatement(row) && row.due_date
        ? ` · 預估 ${money(estimate)} · 差額 ${formatDifference(toNumber(row.amount) - estimate)}`
        : "";
      const paidText = row.status === "paid" ? ` · 已繳 ${row.paid_at || ""}` : "";
      const estimateItems = isActualStatement(row) ? getEstimateItemsForActual(row) : [];
      const estimateSourceLabel = {
        general: "單筆消費",
        advance: "代墊",
        installment: "分期",
        subscription: "訂閱"
      };
      const differenceAmount = toNumber(row.amount) - estimate;
      const estimateDetailRows = estimateItems.map((item) => `
        <div class="statement-detail-row">
          <span>${item.charge_date || item.due_date || "未填日期"} · ${estimateSourceLabel[item.source_type] || "預估"} · ${escapeHtml(item.title || "未命名")}</span>
          <strong>${money(item.amount)}</strong>
        </div>
      `).join("");
      const differenceDetails = isActualStatement(row)
        ? `
          <details class="statement-details">
            <summary>查看預估明細與差額</summary>
            <div class="statement-detail-list">
              ${estimateDetailRows || '<p class="record-meta">這期目前沒有 App 預估明細。</p>'}
              <div class="statement-detail-row statement-difference-row">
                <span>實際帳單 - App 預估</span>
                <strong>${formatDifference(differenceAmount)}</strong>
              </div>
            </div>
          </details>
        `
        : "";

      return `
        <article class="record-item">
          <div>
            <p class="record-title">${escapeHtml(displayTitle)}</p>
            <p class="record-meta">${sourceLabel} · 帳單日 ${row.charge_date || "未填"} · 繳款日 ${row.due_date || "未填"}${diffText}${paidText}</p>
            ${differenceDetails}
          </div>
          <div class="record-amount">${money(row.amount)}</div>
          <div class="record-actions">
            ${row.status === "pending" ? `<button type="button" data-pay-card-charge="${row.id}">已繳款</button>` : ""}
            <button type="button" data-edit-card-charge="${row.id}">編輯</button>
            <button type="button" data-delete-card-charge="${row.id}">刪除</button>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderCardCharges() {
    const list = $("cardChargeList");
    const rows = getCardStatementRows();
    const activeTab = list.dataset.cardStatementTab || "actual";
    const actualRows = rows.filter((row) => row.row_type !== "estimate");
    const estimateRows = rows.filter((row) => row.row_type === "estimate");
    const visibleRows = activeTab === "estimate" ? estimateRows : actualRows;

    const renderEstimateRow = (row) => {
      const card = state.creditCards.find((item) => item.id === row.card_id);
      const cardName = card?.name || "信用卡";
      const sourceLabel = {
        general: "一般刷卡",
        advance: "代墊",
        installment: "分期",
        subscription: "訂閱"
      };
      const detailRows = [...(row.items || [])]
        .sort((a, b) => String(a.charge_date || "").localeCompare(String(b.charge_date || "")))
        .map((item) => `
          <div class="statement-detail-row">
            <span>${item.charge_date || "未填"} · ${sourceLabel[item.source_type] || "預估"} · ${escapeHtml(item.title || "未命名")}</span>
            <strong>${money(item.amount)}</strong>
          </div>
        `).join("");

      return `
        <article class="record-item statement-estimate">
          <div>
            <p class="record-title">${escapeHtml(cardName)} 下期預估帳單</p>
            <p class="record-meta">繳款日 ${row.due_date || "未填"} · ${row.count} 筆未出帳預估</p>
            <details class="statement-details" open>
              <summary>查看未出帳明細</summary>
              <div class="statement-detail-list">${detailRows}</div>
            </details>
          </div>
          <div class="record-amount">${money(row.amount)}</div>
          <div class="record-actions"></div>
        </article>
      `;
    };

    const renderActualRow = (row) => {
      const card = state.creditCards.find((item) => item.id === row.card_id);
      const cardName = card?.name || "信用卡";
      const sourceLabel = {
        opening_bill: "實際帳單",
        installment: "分期",
        fee: "費用／利息"
      }[row.source_type] || "信用卡";
      const displayTitle = isActualStatement(row)
        ? `${cardName} ${sourceLabel}`
        : `${cardName} ${row.title || sourceLabel}`;
      const estimate = isActualStatement(row) ? getEstimateFor(row.card_id, row.due_date) : 0;
      const diffText = isActualStatement(row) && row.due_date
        ? ` · 預估 ${money(estimate)} · 差額 ${formatDifference(toNumber(row.amount) - estimate)}`
        : "";
      const paidText = row.status === "paid" ? ` · 已繳 ${row.paid_at || ""}` : "";

      return `
        <article class="record-item">
          <div>
            <p class="record-title">${escapeHtml(displayTitle)}</p>
            <p class="record-meta">${sourceLabel} · 帳單日 ${row.charge_date || "未填"} · 繳款日 ${row.due_date || "未填"}${diffText}${paidText}</p>
          </div>
          <div class="record-amount">${money(row.amount)}</div>
          <div class="record-actions">
            ${row.status === "pending" ? `<button type="button" data-pay-card-charge="${row.id}">已繳款</button>` : ""}
            <button type="button" data-edit-card-charge="${row.id}">編輯</button>
            <button type="button" data-delete-card-charge="${row.id}">刪除</button>
          </div>
        </article>
      `;
    };

    const body = visibleRows.length
      ? visibleRows.map((row) => activeTab === "estimate" ? renderEstimateRow(row) : renderActualRow(row)).join("")
      : `<p class="empty-state">${activeTab === "estimate" ? "目前沒有下期預估帳單。" : "目前沒有實際信用卡帳單。"}</p>`;

    list.innerHTML = `
      <div class="statement-tabbar" role="tablist" aria-label="信用卡帳單分類">
        <button type="button" class="${activeTab === "actual" ? "active" : ""}" data-card-statement-tab="actual">實際帳單 <strong>${actualRows.length}</strong></button>
        <button type="button" class="${activeTab === "estimate" ? "active" : ""}" data-card-statement-tab="estimate">下期預估帳單 <strong>${estimateRows.length}</strong></button>
      </div>
      <div class="statement-tab-panel">${body}</div>
    `;
  }

  function renderInstallments() {
    const list = $("installmentList");
    const rows = [...state.installmentPlans]
      .sort((a, b) => String(b.purchase_date).localeCompare(String(a.purchase_date)));

    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">目前沒有分期計畫。</p>';
      return;
    }

    list.innerHTML = rows.map((plan) => {
      const card = state.creditCards.find((item) => item.id === plan.card_id);
      const schedule = window.LeftBudget.createInstallmentSchedule(plan);
      const billed = new Set(state.cardCharges
        .filter((charge) => charge.installment_plan_id === plan.id)
        .map((charge) => Number(charge.installment_number)));
      const future = schedule
        .filter((item) => !billed.has(item.installment_number) && item.due_date > state.cycle.expected_pay_date)
        .reduce((sum, item) => sum + toNumber(item.amount), 0);

      return `
        <article class="record-item">
          <div>
            <p class="record-title">${escapeHtml(plan.title)}</p>
            <p class="record-meta">${escapeHtml(card?.name || "信用卡")} · ${plan.installment_count} 期 · 首期 ${plan.first_due_date}</p>
          </div>
          <div class="record-amount">${money(future)}</div>
          <div class="record-actions">
            <button type="button" data-delete-installment="${plan.id}">刪除</button>
          </div>
        </article>
      `;
    }).join("");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function toggleCardFields() {
    const expenseUsesCard = $("expensePaymentMethod")?.value === "credit_card";
    const advanceUsesCard = $("advancePaymentMethod")?.value === "credit_card";
    const subscriptionUsesCard = $("subscriptionPaymentMethod")?.value === "credit_card";
    const subscriptionIsYearly = $("subscriptionBillingCycle")?.value === "yearly";
    const editUsesCard = $("editPaymentMethod")?.value === "credit_card";
    if ($("expenseCardLabel")) $("expenseCardLabel").hidden = !expenseUsesCard;
    if ($("advanceCardLabel")) $("advanceCardLabel").hidden = !advanceUsesCard;
    if ($("subscriptionCardLabel")) $("subscriptionCardLabel").hidden = !subscriptionUsesCard;
    if ($("subscriptionMonthLabel")) $("subscriptionMonthLabel").hidden = !subscriptionIsYearly;
    if ($("editCardLabel")) $("editCardLabel").hidden = !editUsesCard;
    if ($("expenseAccountLabel")) $("expenseAccountLabel").hidden = expenseUsesCard;
    if ($("advanceAccountLabel")) $("advanceAccountLabel").hidden = advanceUsesCard;
    if ($("subscriptionAccountLabel")) $("subscriptionAccountLabel").hidden = subscriptionUsesCard;
    if ($("editAccountLabel")) $("editAccountLabel").hidden = editUsesCard;
  }

  function requireCard(selectId) {
    const cardId = $(selectId).value;
    if (!cardId) throw new Error("請先新增並選擇一張信用卡");
    return cardId;
  }

  function optionalAccount(selectId) {
    return $(selectId)?.value || null;
  }

  function getLatestCardClosingDate(cardId, baseDate = today()) {
    const card = state.creditCards.find((item) => item.id === cardId);
    if (!card) return baseDate;
    const base = parseLocalDate(baseDate);
    let year = base.getFullYear();
    let month = base.getMonth();
    const closingDay = Number(card.closing_day);
    if (base.getDate() < closingDay) {
      month -= 1;
      if (month < 0) {
        month = 11;
        year -= 1;
      }
    }

    const lastDay = new Date(year, month + 1, 0).getDate();
    const closing = new Date(year, month, Math.min(closingDay, lastDay));
    return formatDate(closing);
  }

  function getCardClosingDate(cardId, chargeDate) {
    const card = state.creditCards.find((item) => item.id === cardId);
    if (!card) return chargeDate;
    const date = parseLocalDate(chargeDate);
    const chargeDay = date.getDate();
    let closingMonth = date.getMonth();
    let closingYear = date.getFullYear();
    if (chargeDay > Number(card.closing_day)) {
      closingMonth += 1;
      if (closingMonth > 11) {
        closingMonth = 0;
        closingYear += 1;
      }
    }

    const lastDay = new Date(closingYear, closingMonth + 1, 0).getDate();
    const closing = new Date(closingYear, closingMonth, Math.min(Number(card.closing_day), lastDay));
    return formatDate(closing);
  }

  function parseAmountLines(value, fieldName) {
    return String(value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(.*?)[\s:：,，]+(\d+(?:\.\d+)?)$/);
        if (!match) {
          throw new Error(`${fieldName}格式看不懂：「${line}」。請用「姓名 金額」。`);
        }

        const title = match[1].trim();
        const amount = toNumber(match[2]);
        if (!title || amount <= 0) {
          throw new Error(`${fieldName}格式看不懂：「${line}」。請用「姓名 金額」。`);
        }

        return { title, amount };
      });
  }

  function splitSharedFee(total, count) {
    if (!total || !count) return Array.from({ length: count }, () => 0);
    const base = Math.floor(total / count);
    const remainder = total - (base * count);
    return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
  }

  function splitSharedFeeForMealRows(total, count) {
    const otherCount = Math.max(0, count - 1);
    if (!total || !count) {
      return {
        own: 0,
        others: Array.from({ length: otherCount }, () => 0)
      };
    }

    const base = Math.floor(total / count);
    const remainder = total - (base * count);
    return {
      own: base + remainder,
      others: Array.from({ length: otherCount }, () => base)
    };
  }

  function fillOpeningBillDatesFromCard() {
    const select = $("openingBillCardSelect");
    if (!select?.value) return;
    const closingDate = getLatestCardClosingDate(select.value);
    $("openingBillDate").value = closingDate;
    $("openingBillDueDate").value = getCardDueDate(select.value, closingDate);
  }

  function getCardDueDate(cardId, chargeDate) {
    const card = state.creditCards.find((item) => item.id === cardId);
    if (!card) return chargeDate;
    const closingDate = parseLocalDate(getCardClosingDate(cardId, chargeDate));
    let paymentMonth = closingDate.getMonth();
    let paymentYear = closingDate.getFullYear();

    if (Number(card.payment_day) <= Number(card.closing_day)) {
      paymentMonth += 1;
      if (paymentMonth > 11) {
        paymentMonth = 0;
        paymentYear += 1;
      }
    }

    const lastDay = new Date(paymentYear, paymentMonth + 1, 0).getDate();
    const due = new Date(paymentYear, paymentMonth, Math.min(Number(card.payment_day), lastDay));
    return formatDate(due);
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

    await loadCreditCards();
    await loadAccounts();
    await loadAccountTransfers();
    await loadIncomeRecords();
    await loadSubscriptions();
    await loadInstallmentPlans();
    await generateDueInstallments();

    const [txResult, reimbursementResult, chargeResult] = await Promise.all([
      client
        .from("transactions")
        .select("*")
        .eq("user_id", state.user.id)
        .eq("cycle_id", state.cycle.id),
      client
        .from("reimbursements")
        .select("*")
        .eq("user_id", state.user.id)
        .eq("cycle_id", state.cycle.id),
      client
        .from("credit_card_charges")
        .select("*")
        .eq("user_id", state.user.id)
        .eq("cycle_id", state.cycle.id)
    ]);

    if (txResult.error) throw txResult.error;
    if (reimbursementResult.error) throw reimbursementResult.error;
    if (chargeResult.error) throw chargeResult.error;
    state.transactions = txResult.data || [];
    state.reimbursements = reimbursementResult.data || [];
    state.cardCharges = chargeResult.data || [];
  }

  async function loadCreditCards() {
    const { data, error } = await client
      .from("credit_cards")
      .select("*")
      .eq("user_id", state.user.id)
      .order("name", { ascending: true });
    if (error) throw error;
    state.creditCards = data || [];
    fillOpeningBillDatesFromCard();
  }

  async function loadInstallmentPlans() {
    const { data, error } = await client
      .from("installment_plans")
      .select("*")
      .eq("user_id", state.user.id)
      .order("purchase_date", { ascending: false });
    if (error) throw error;
    state.installmentPlans = data || [];
  }

  async function loadAccounts() {
    const { data, error } = await client
      .from("accounts")
      .select("*")
      .eq("user_id", state.user.id)
      .order("name", { ascending: true });
    if (error) throw error;
    state.accounts = data || [];
  }

  async function loadAccountTransfers() {
    const { data, error } = await client
      .from("account_transfers")
      .select("*")
      .eq("user_id", state.user.id)
      .eq("cycle_id", state.cycle.id)
      .order("date", { ascending: false });
    if (error) throw error;
    state.accountTransfers = data || [];
  }

  async function loadIncomeRecords() {
    const { data, error } = await client
      .from("income_records")
      .select("*")
      .eq("user_id", state.user.id)
      .eq("cycle_id", state.cycle.id)
      .order("date", { ascending: false });
    if (error) throw error;
    state.incomeRecords = data || [];
  }

  async function loadSubscriptions() {
    const { data, error } = await client
      .from("monthly_subscriptions")
      .select("*")
      .eq("user_id", state.user.id)
      .order("charge_day", { ascending: true });
    if (error) {
      if (error.code === "42P01" || /monthly_subscriptions/i.test(error.message || "")) {
        state.subscriptions = [];
        showConfigWarning("需要更新資料表", "請到 Supabase SQL Editor 執行最新版 <code>schema.sql</code>，新增每月訂閱項目資料表。");
        return;
      }
      throw error;
    }
    state.subscriptions = data || [];
  }

  async function generateDueInstallments() {
    if (!state.cycle || !state.installmentPlans.length) return;

    const existing = await client
      .from("credit_card_charges")
      .select("installment_plan_id, installment_number")
      .eq("user_id", state.user.id)
      .eq("cycle_id", state.cycle.id)
      .eq("source_type", "installment");
    if (existing.error) throw existing.error;

    const existingKeys = new Set((existing.data || []).map((row) => (
      `${row.installment_plan_id}:${row.installment_number}`
    )));

    for (const plan of state.installmentPlans.filter((item) => item.is_active !== false)) {
      const schedule = window.LeftBudget.createInstallmentSchedule(plan);
      for (const item of schedule) {
        const key = `${plan.id}:${item.installment_number}`;
        if (existingKeys.has(key)) continue;
        if (!window.LeftBudget.isDateInCycle(item.due_date, state.cycle)) continue;

        const tx = await insertTransaction({
          kind: "installment",
          date: item.due_date,
          title: `${plan.title} ${item.installment_number}/${plan.installment_count}`,
          amount: item.amount,
          gross_amount: item.amount,
          payment_method: "credit_card",
          credit_card_id: plan.card_id,
          installment_plan_id: plan.id
        }, false);

        const { error } = await client.from("credit_card_charges").insert({
          user_id: state.user.id,
          cycle_id: state.cycle.id,
          card_id: plan.card_id,
          transaction_id: tx.id,
          installment_plan_id: plan.id,
          installment_number: item.installment_number,
          source_type: "installment",
          title: `${plan.title} ${item.installment_number}/${plan.installment_count}`,
          charge_date: item.due_date,
          due_date: item.due_date,
          amount: item.amount
        });
        if (error && error.code !== "23505") throw error;
      }
    }
  }

  async function refresh() {
    state.historyLoaded = false;
    if ($("historyList")) $("historyList").hidden = true;
    if ($("historyButton")) $("historyButton").textContent = "查看歷史";
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
    $("minimumInput").value = settings.default_minimum_savings || 5000;
  }

  async function initAuth() {
    if (!hasConfig || !client) {
      showConfigWarning(
        "尚未設定 Supabase。",
        '請先依 README 建立 Supabase 專案，並填入 <code>js/config.js</code>。'
      );
      setVisible("authPanel", false);
      return;
    }

    const connectionError = await checkSupabaseConnection();
    if (connectionError) {
      showConfigWarning(
        "Supabase 設定無法使用。",
        '目前 <code>js/config.js</code> 有設定值，但專案網址或 key 無法連線。'
      );
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
      expected_pay_date: "2999-12-31",
      salary_income: 0,
      mother_support: 0,
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
        default_minimum_savings: payload.minimum_savings
      }, { onConflict: "user_id" });

    showToast("連續帳本已開始");
    await refresh();
  }

  async function addExpense(event) {
    event.preventDefault();
    const amount = toNumber($("expenseAmount").value);
    const paymentMethod = $("expensePaymentMethod").value;
    const cardId = paymentMethod === "credit_card" ? requireCard("expenseCardSelect") : null;
    const accountId = paymentMethod === "credit_card" ? null : optionalAccount("expenseAccountSelect");
    const tx = await insertTransaction({
      kind: "expense",
      date: $("expenseDate").value,
      title: $("expenseTitle").value.trim() || "一般支出",
      amount,
      gross_amount: amount,
      payment_method: paymentMethod,
      credit_card_id: cardId,
      account_id: accountId
    }, false);
    if (cardId) {
      await insertCardCharge({
        card_id: cardId,
        transaction_id: tx.id,
        source_type: "general",
        title: tx.title,
        charge_date: tx.date,
        due_date: getCardDueDate(cardId, tx.date),
        amount
      });
    }
    event.target.reset();
    setDefaultDates();
    toggleCardFields();
    showToast("支出已新增");
    await refresh();
  }

  async function addAdvance(event) {
    event.preventDefault();
    const grossInput = toNumber($("advanceGross").value);
    const peopleInput = toNumber($("advancePeople").value);
    const personal = toNumber($("advancePersonal").value);
    const shared = toNumber($("advanceShared").value);
    const mealRows = parseAmountLines($("advanceMeals").value, "別人的餐點明細");
    const usesMealSplit = mealRows.length > 0;
    const splitPeople = peopleInput || (usesMealSplit ? mealRows.length + 1 : 0);
    const mealSubtotal = personal + mealRows.reduce((sum, row) => sum + row.amount, 0);
    if (usesMealSplit && grossInput < mealSubtotal) {
      throw new Error(`個別餐點合計 ${money(mealSubtotal)}，已經超過總金額 ${money(grossInput)}。`);
    }
    const sharedToSplit = usesMealSplit
      ? Math.max(0, grossInput - mealSubtotal)
      : shared;
    const mealShares = splitSharedFeeForMealRows(sharedToSplit, splitPeople);
    const ownMealTotal = personal + mealShares.own;
    const mealTotals = mealRows.map((row, index) => ({
      ...row,
      amount: row.amount + (mealShares.others[index] || 0)
    }));
    const mealTotal = ownMealTotal + mealTotals.reduce((sum, row) => sum + row.amount, 0);
    const gross = usesMealSplit ? mealTotal : grossInput;
    const usesItemizedSplit = Boolean($("advancePersonal").value || $("advanceShared").value);
    if (!usesMealSplit && usesItemizedSplit && shared > 0 && peopleInput <= 0) {
      throw new Error("有平均分攤費時，請填分攤人數。");
    }
    if (usesMealSplit && shared > 0 && splitPeople <= 0) {
      throw new Error("有平均分攤費時，請填分攤人數或別人的餐點明細。");
    }

    const own = $("advanceOwn").value
      ? toNumber($("advanceOwn").value)
      : usesMealSplit
        ? ownMealTotal
      : usesItemizedSplit
        ? personal + (peopleInput > 0 ? Math.ceil(shared / peopleInput) : 0)
      : peopleInput > 0
        ? Math.ceil(gross / peopleInput)
        : gross;
    if (own > gross) throw new Error("自己負擔不能大於總金額。");
    const receivable = Math.max(0, gross - own);
    const receivableRows = usesMealSplit
      ? mealTotals
      : [];
    const detailedReceivable = receivableRows.reduce((sum, row) => sum + row.amount, 0);
    if (receivableRows.length && detailedReceivable !== receivable) {
      throw new Error(`待收明細合計 ${money(detailedReceivable)}，但應待收 ${money(receivable)}。`);
    }
    const title = $("advanceTitle").value.trim() || "代墊";
    const paymentMethod = $("advancePaymentMethod").value;
    const cardId = paymentMethod === "credit_card" ? requireCard("advanceCardSelect") : null;
    const accountId = paymentMethod === "credit_card" ? null : optionalAccount("advanceAccountSelect");
    const tx = await insertTransaction({
      kind: "advance",
      date: $("advanceDate").value,
      title,
      amount: own,
      gross_amount: gross,
      participant_count: splitPeople || peopleInput || null,
      payment_method: paymentMethod,
      credit_card_id: cardId,
      account_id: accountId
    }, false);

    if (cardId) {
      await insertCardCharge({
        card_id: cardId,
        transaction_id: tx.id,
        source_type: "advance",
        title,
        charge_date: tx.date,
        due_date: getCardDueDate(cardId, tx.date),
        amount: gross
      });
    }

    if (receivable > 0) {
      const rows = receivableRows.length
        ? receivableRows.map((row) => ({
          user_id: state.user.id,
          cycle_id: state.cycle.id,
          transaction_id: tx.id,
          title: `${title} - ${row.title}`,
          amount: row.amount,
          status: "pending"
        }))
        : [{
          user_id: state.user.id,
          cycle_id: state.cycle.id,
          transaction_id: tx.id,
          title,
          amount: receivable,
          status: "pending"
        }];
      const { error } = await client.from("reimbursements").insert(rows);
      if (error) throw error;
    }

    event.target.reset();
    setDefaultDates();
    toggleCardFields();
    showToast("代墊已新增");
    await refresh();
  }

  async function addManualReimbursement(event) {
    event.preventDefault();
    const amount = toNumber($("reimbursementAmount").value);
    const status = $("reimbursementStatus").value;
    const title = $("reimbursementTitle").value.trim() || "媽媽信用卡帳單回補";
    const { error } = await client.from("reimbursements").insert({
      user_id: state.user.id,
      cycle_id: state.cycle.id,
      transaction_id: null,
      title,
      amount,
      status,
      received_at: status === "received" ? today() : null
    });
    if (error) throw error;
    event.target.reset();
    $("reimbursementStatus").value = "received";
    showToast(status === "received" ? "回補已加入月底餘額" : "待收款已新增");
    await refresh();
  }

  async function addIncome(event) {
    event.preventDefault();
    const incomeType = $("incomeType").value;
    const defaultTitle = {
      salary: "薪水",
      mother: "媽媽生活費",
      other: "其他收入"
    }[incomeType] || "收入";

    const { error } = await client.from("income_records").insert({
      user_id: state.user.id,
      cycle_id: state.cycle.id,
      account_id: optionalAccount("incomeAccountSelect"),
      date: $("incomeDate").value,
      income_type: incomeType,
      title: $("incomeTitle").value.trim() || defaultTitle,
      amount: toNumber($("incomeAmount").value)
    });
    if (error) throw error;
    event.target.reset();
    setDefaultDates();
    showToast("收入已新增");
    await refresh();
  }

  async function addSubscription(event) {
    event.preventDefault();
    const paymentMethod = $("subscriptionPaymentMethod").value;
    const usesCard = paymentMethod === "credit_card";
    const billingCycle = $("subscriptionBillingCycle")?.value || "monthly";
    const { error } = await client.from("monthly_subscriptions").insert({
      user_id: state.user.id,
      title: $("subscriptionTitle").value.trim(),
      amount: toNumber($("subscriptionAmount").value),
      billing_cycle: billingCycle,
      charge_month: billingCycle === "yearly" ? toNumber($("subscriptionMonth").value) : null,
      charge_day: toNumber($("subscriptionDay").value),
      payment_method: paymentMethod,
      credit_card_id: usesCard ? requireCard("subscriptionCardSelect") : null,
      account_id: usesCard ? null : optionalAccount("subscriptionAccountSelect"),
      is_active: true
    });
    if (error) throw error;
    event.target.reset();
    $("subscriptionDay").value = new Date().getDate();
    toggleCardFields();
    showToast("訂閱項目已新增");
    await refresh();
  }

  async function toggleSubscription(id) {
    const row = state.subscriptions.find((item) => item.id === id);
    if (!row) return;
    const { error } = await client
      .from("monthly_subscriptions")
      .update({ is_active: row.is_active === false })
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;
    showToast(row.is_active === false ? "訂閱已啟用" : "訂閱已停用");
    await refresh();
  }

  async function deleteSubscription(id) {
    if (!window.confirm("確定要刪除這個訂閱項目嗎？")) return;
    const { error } = await client
      .from("monthly_subscriptions")
      .delete()
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;
    showToast("訂閱項目已刪除");
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

  async function insertCardCharge(payload) {
    const { data, error } = await client
      .from("credit_card_charges")
      .insert({
        user_id: state.user.id,
        cycle_id: state.cycle.id,
        ...payload
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  function runWish(event) {
    event.preventDefault();
    const amount = toNumber($("wishAmount").value);
    const title = $("wishTitle").value.trim() || "這筆購物";
    const summary = calculateSummary(amount);
    const canBuy = summary.commitmentBuffer >= 0;
    const result = $("wishResult");
    result.hidden = false;
    result.innerHTML = `
      <p class="eyebrow">${escapeHtml(title)}</p>
      <span>${canBuy ? "買完仍守住最低保留" : "買完會低於最低保留"}</span>
      <strong>${money(summary.projected)}</strong>
      <p>${canBuy ? `接下來可運用剩 ${money(summary.commitmentBuffer)}` : `還差 ${money(Math.abs(summary.commitmentBuffer))} 才守住最低保留`}</p>
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

  async function addCreditCard(event) {
    event.preventDefault();
    const { error } = await client.from("credit_cards").insert({
      user_id: state.user.id,
      name: $("cardName").value.trim(),
      closing_day: toNumber($("cardClosingDay").value),
      payment_day: toNumber($("cardPaymentDay").value),
      is_active: true
    });
    if (error) throw error;
    event.target.reset();
    showToast("信用卡已新增");
    await refresh();
  }

  async function toggleCreditCard(id) {
    const card = state.creditCards.find((item) => item.id === id);
    if (!card) return;
    const { error } = await client
      .from("credit_cards")
      .update({ is_active: !card.is_active })
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;
    showToast(card.is_active ? "信用卡已停用" : "信用卡已啟用");
    await refresh();
  }

  async function deleteCreditCard(id) {
    if (!window.confirm("確定刪除這張信用卡？相關刷卡明細與分期計畫也會一起刪除。")) return;
    const { error } = await client
      .from("credit_cards")
      .delete()
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;
    showToast("信用卡已刪除");
    await refresh();
  }

  async function addOpeningBill(event) {
    event.preventDefault();
    const amount = toNumber($("openingBillAmount").value);
    const cardId = requireCard("openingBillCardSelect");
    const title = "期初信用卡帳單";
    const date = $("openingBillDate").value;
    const tx = await insertTransaction({
      kind: "opening_card_bill",
      date,
      title,
      amount,
      gross_amount: amount,
      payment_method: "credit_card",
      credit_card_id: cardId
    }, false);
    await insertCardCharge({
      card_id: cardId,
      transaction_id: tx.id,
      source_type: "opening_bill",
      title,
      charge_date: date,
      due_date: $("openingBillDueDate").value || null,
      amount
    });
    event.target.reset();
    setDefaultDates();
    fillOpeningBillDatesFromCard();
    showToast("期初帳單已新增");
    await refresh();
  }

  async function addOpeningBill(event) {
    event.preventDefault();
    const amount = toNumber($("openingBillAmount").value);
    const cardId = requireCard("openingBillCardSelect");
    const title = "實際信用卡帳單";
    const date = $("openingBillDate").value;
    const tx = await insertTransaction({
      kind: "opening_card_bill",
      date,
      title,
      amount,
      gross_amount: amount,
      payment_method: "credit_card",
      credit_card_id: cardId
    }, false);
    await insertCardCharge({
      card_id: cardId,
      transaction_id: tx.id,
      source_type: "opening_bill",
      title,
      charge_date: date,
      due_date: $("openingBillDueDate").value || null,
      amount
    });
    event.target.reset();
    setDefaultDates();
    fillOpeningBillDatesFromCard();
    showToast("實際帳單已新增");
    await refresh();
  }

  async function addInstallment(event) {
    event.preventDefault();
    const cardId = requireCard("installmentCardSelect");
    const planPayload = {
      user_id: state.user.id,
      card_id: cardId,
      title: $("installmentTitle").value.trim(),
      purchase_date: today(),
      total_amount: toNumber($("installmentTotal").value),
      installment_count: toNumber($("installmentCount").value),
      first_due_date: $("installmentFirstDate").value,
      fee_total: toNumber($("installmentFee").value),
      is_active: true
    };
    const { data, error } = await client
      .from("installment_plans")
      .insert(planPayload)
      .select()
      .single();
    if (error) throw error;

    state.installmentPlans = [data, ...state.installmentPlans];
    await generateDueInstallments();
    event.target.reset();
    setDefaultDates();
    showToast("分期已新增");
    await refresh();
  }

  async function addCardFee(event) {
    event.preventDefault();
    const amount = toNumber($("cardFeeAmount").value);
    const cardId = requireCard("cardFeeCardSelect");
    const title = $("cardFeeTitle").value.trim() || "信用卡費用／利息";
    const date = $("cardFeeDate").value;
    const tx = await insertTransaction({
      kind: "card_fee",
      date,
      title,
      amount,
      gross_amount: amount,
      payment_method: "credit_card",
      credit_card_id: cardId
    }, false);
    await insertCardCharge({
      card_id: cardId,
      transaction_id: tx.id,
      source_type: "fee",
      title,
      charge_date: date,
      due_date: $("cardFeeDueDate").value,
      amount
    });
    event.target.reset();
    setDefaultDates();
    showToast("費用／利息已新增");
    await refresh();
  }

  async function addAccount(event) {
    event.preventDefault();
    const { error } = await client.from("accounts").insert({
      user_id: state.user.id,
      name: $("accountName").value.trim(),
      type: $("accountType").value,
      opening_balance: toNumber($("accountOpeningBalance").value),
      is_active: true
    });
    if (error) throw error;
    event.target.reset();
    $("accountOpeningBalance").value = 0;
    showToast("帳戶已新增");
    await refresh();
  }

  async function editAccount(id) {
    const account = state.accounts.find((item) => item.id === id);
    if (!account) return;

    const name = window.prompt("帳戶名稱", account.name);
    if (name === null) return;
    const openingText = window.prompt("期初餘額", account.opening_balance);
    if (openingText === null) return;
    const type = window.prompt("類型：bank / wallet / cash / other", account.type || "bank");
    if (type === null) return;

    const openingBalance = toNumber(openingText);
    const normalizedType = type.trim();
    if (openingBalance < 0) throw new Error("期初餘額不能小於 0");
    if (!["bank", "wallet", "cash", "other"].includes(normalizedType)) {
      throw new Error("類型只能是 bank、wallet、cash、other");
    }

    const { error } = await client
      .from("accounts")
      .update({
        name: name.trim() || account.name,
        opening_balance: openingBalance,
        type: normalizedType
      })
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;
    showToast("帳戶已更新");
    await refresh();
  }

  async function addTransfer(event) {
    event.preventDefault();
    const fromId = $("transferFromSelect").value;
    const toId = $("transferToSelect").value;
    if (!fromId || !toId) throw new Error("請先新增來源與目的帳戶");
    if (fromId === toId) throw new Error("來源與目的帳戶不能相同");

    const { error } = await client.from("account_transfers").insert({
      user_id: state.user.id,
      cycle_id: state.cycle.id,
      from_account_id: fromId,
      to_account_id: toId,
      date: $("transferDate").value,
      title: $("transferTitle").value.trim() || "轉帳／儲值",
      amount: toNumber($("transferAmount").value)
    });
    if (error) throw error;
    event.target.reset();
    setDefaultDates();
    showToast("轉帳／儲值已新增");
    await refresh();
  }

  async function deleteTransfer(id) {
    if (!window.confirm("確定要刪除這筆轉帳／儲值嗎？")) return;
    const { error } = await client
      .from("account_transfers")
      .delete()
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;
    showToast("轉帳／儲值已刪除");
    await refresh();
  }

  async function deleteIncome(id) {
    if (!window.confirm("確定要刪除這筆收入嗎？")) return;
    const { error } = await client
      .from("income_records")
      .delete()
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;
    showToast("收入已刪除");
    await refresh();
  }

  async function copyMotherRequest() {
    const text = $("motherRequestMessage").value;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    showToast("已複製給媽媽的訊息");
  }

  async function editTransaction(id) {
    const row = state.transactions.find((item) => item.id === id);
    if (!row) return;
    ensureEditPaymentFields();
    renderCardOptions();
    renderAccountOptions();
    $("editId").value = row.id;
    $("editAmount").value = row.amount;
    $("editDate").value = row.date;
    $("editTitle").value = row.title || "";
    $("editPaymentMethod").value = row.payment_method || "cash";
    if (row.credit_card_id && $("editCardSelect")) $("editCardSelect").value = row.credit_card_id;
    if (row.account_id && $("editAccountSelect")) $("editAccountSelect").value = row.account_id;
    toggleCardFields();
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
    if (existing?.payment_method === "credit_card" && existing.kind === "expense") {
      const chargeError = await client
        .from("credit_card_charges")
        .update({ amount, title: $("editTitle").value.trim() || "一般支出" })
        .eq("transaction_id", id)
        .eq("user_id", state.user.id);
      if (chargeError.error) throw chargeError.error;
    }
    $("editDialog").close();
    showToast("紀錄已更新");
    await refresh();
  }

  async function saveEdit(event) {
    event.preventDefault();
    const id = $("editId").value;
    const existing = state.transactions.find((item) => item.id === id);
    if (!existing) return;

    const amount = toNumber($("editAmount").value);
    const date = $("editDate").value;
    const title = $("editTitle").value.trim() || (existing.kind === "advance" ? "代墊" : "一般消費");
    const paymentMethod = $("editPaymentMethod")?.value || existing.payment_method || "cash";
    const cardId = paymentMethod === "credit_card" ? requireCard("editCardSelect") : null;
    const accountId = paymentMethod === "credit_card" ? null : optionalAccount("editAccountSelect");
    const grossAmount = existing.kind === "advance" ? Math.max(toNumber(existing.gross_amount), amount) : amount;

    const { error } = await client
      .from("transactions")
      .update({
        amount,
        gross_amount: grossAmount,
        date,
        title,
        payment_method: paymentMethod,
        credit_card_id: cardId,
        account_id: accountId
      })
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;

    if (existing.kind === "expense" || existing.kind === "advance") {
      if (paymentMethod === "credit_card") {
        const chargeAmount = existing.kind === "advance" ? grossAmount : amount;
        const sourceType = existing.kind === "advance" ? "advance" : "general";
        const existingCharge = state.cardCharges.find((charge) => charge.transaction_id === id);
        if (existingCharge) {
          const chargeError = await client
            .from("credit_card_charges")
            .update({
              card_id: cardId,
              source_type: sourceType,
              amount: chargeAmount,
              title,
              charge_date: date,
              due_date: getCardDueDate(cardId, date)
            })
            .eq("transaction_id", id)
            .eq("user_id", state.user.id);
          if (chargeError.error) throw chargeError.error;
        } else {
          await insertCardCharge({
            card_id: cardId,
            transaction_id: id,
            source_type: sourceType,
            title,
            charge_date: date,
            due_date: getCardDueDate(cardId, date),
            amount: chargeAmount
          });
        }
      } else {
        const chargeDelete = await client
          .from("credit_card_charges")
          .delete()
          .eq("transaction_id", id)
          .eq("user_id", state.user.id);
        if (chargeDelete.error) throw chargeDelete.error;
      }
    }

    $("editDialog").close();
    showToast("紀錄已更新");
    await refresh();
  }

  async function deleteTransaction(id) {
    if (!window.confirm("確定刪除這筆紀錄？相關待收款也會一起刪除。")) return;
    const chargeDelete = await client
      .from("credit_card_charges")
      .delete()
      .eq("transaction_id", id)
      .eq("user_id", state.user.id);
    if (chargeDelete.error) throw chargeDelete.error;
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

  async function markCardChargePaid(id) {
    const row = state.cardCharges.find((item) => item.id === id);
    if (!row) throw new Error("找不到這筆帳單，請重新整理後再試");

    const { data, error } = await client
      .from("credit_card_charges")
      .update({ status: "paid", paid_at: today() })
      .eq("id", id)
      .eq("user_id", state.user.id)
      .select("id, status, paid_at")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("帳單狀態沒有更新，請重新登入後再試");

    row.status = data.status;
    row.paid_at = data.paid_at;
    renderDashboard();
    showToast("卡費已標記為已繳");
    await refresh();
  }

  async function editCardCharge(id) {
    const row = state.cardCharges.find((item) => item.id === id);
    if (!row) return;
    const title = window.prompt("明細名稱", row.title);
    if (title === null) return;
    const amountText = window.prompt("金額", row.amount);
    if (amountText === null) return;
    const dueDate = window.prompt("繳款日（YYYY-MM-DD，可留空）", row.due_date || "");
    if (dueDate === null) return;
    const amount = toNumber(amountText);
    if (amount <= 0) throw new Error("金額必須大於 0");

    const { error } = await client
      .from("credit_card_charges")
      .update({ title: title.trim() || row.title, amount, due_date: dueDate.trim() || null })
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;

    if (row.transaction_id && ["general", "opening_bill", "installment", "fee"].includes(row.source_type)) {
      const txError = await client
        .from("transactions")
        .update({ title: title.trim() || row.title, amount, gross_amount: amount })
        .eq("id", row.transaction_id)
        .eq("user_id", state.user.id);
      if (txError.error) throw txError.error;
    }

    showToast("信用卡明細已更新");
    await refresh();
  }

  async function deleteCardCharge(id) {
    const row = state.cardCharges.find((item) => item.id === id);
    if (!row) return;
    if (!window.confirm("確定刪除這筆信用卡明細？若是期初帳單或本期分期，對應支出也會刪除。")) return;
    const { error } = await client
      .from("credit_card_charges")
      .delete()
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;

    if (row.transaction_id && ["opening_bill", "installment", "fee"].includes(row.source_type)) {
      const txError = await client
        .from("transactions")
        .delete()
        .eq("id", row.transaction_id)
        .eq("user_id", state.user.id);
      if (txError.error) throw txError.error;
    }

    showToast("信用卡明細已刪除");
    await refresh();
  }

  async function deleteInstallment(id) {
    if (!window.confirm("確定刪除這個分期計畫？本期已產生的分期明細也會一起刪除。")) return;
    const relatedCharges = state.cardCharges.filter((charge) => charge.installment_plan_id === id);
    for (const charge of relatedCharges) {
      if (charge.transaction_id) {
        const txError = await client
          .from("transactions")
          .delete()
          .eq("id", charge.transaction_id)
          .eq("user_id", state.user.id);
        if (txError.error) throw txError.error;
      }
    }
    const { error } = await client
      .from("installment_plans")
      .delete()
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;
    showToast("分期計畫已刪除");
    await refresh();
  }

  async function closeCycle() {
    if (!state.cycle) return;
    if (!window.confirm("要結束目前週期並開始新的發薪週期嗎？")) return;
    const { error } = await client
      .from("budget_cycles")
      .update({
        is_closed: true,
        expected_pay_date: today(),
        closed_at: new Date().toISOString()
      })
      .eq("id", state.cycle.id)
      .eq("user_id", state.user.id);
    if (error) throw error;
    state.cycle = null;
    showToast("已結束本期");
    await refresh();
  }

  function renderHistory() {
    const list = $("historyList");
    if (!list) return;

    const kindLabels = {
      expense: "一般消費",
      advance: "代墊",
      installment: "分期",
      opening_card_bill: "信用卡帳單",
      card_fee: "費用／利息"
    };
    const months = new Set([
      ...state.historyTransactions.map((row) => String(row.date || "").slice(0, 7)),
      ...state.historyIncomeRecords.map((row) => String(row.date || "").slice(0, 7)),
      ...state.historyCycles.map((row) => String(row.start_date || "").slice(0, 7))
    ].filter((month) => /^\d{4}-\d{2}$/.test(month)));
    const sortedMonths = [...months].sort((a, b) => b.localeCompare(a));
    if (!sortedMonths.length) {
      list.innerHTML = '<p class="empty-state">目前還沒有可整理的歷史資料。</p>';
      return;
    }

    list.innerHTML = sortedMonths.map((month) => {
      const transactions = state.historyTransactions
        .filter((row) => String(row.date || "").startsWith(month))
        .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
      const incomeRecords = state.historyIncomeRecords.filter((row) => String(row.date || "").startsWith(month));
      const cycleIncome = state.historyCycles
        .filter((cycle) => String(cycle.start_date || "").startsWith(month))
        .reduce((sum, cycle) => sum + toNumber(cycle.salary_income) + toNumber(cycle.mother_support), 0);
      const income = cycleIncome
        + incomeRecords.reduce((sum, row) => sum + toNumber(row.amount), 0);
      const spent = transactions.reduce((sum, row) => sum + toNumber(row.amount), 0);
      const receivedManual = state.historyReimbursements
        .filter((row) => row.status === "received" && !row.transaction_id && String(row.received_at || "").startsWith(month))
        .reduce((sum, row) => sum + toNumber(row.amount), 0);
      const balance = income + receivedManual - spent;
      const typeTotals = transactions.reduce((totals, row) => {
        totals[row.kind] = (totals[row.kind] || 0) + toNumber(row.amount);
        return totals;
      }, {});
      const typeRows = Object.entries(typeTotals)
        .filter(([, amount]) => amount > 0)
        .map(([kind, amount]) => `
          <div class="statement-detail-row">
            <span>${kindLabels[kind] || "其他"}</span>
            <strong>${money(amount)}</strong>
          </div>
        `).join("");
      const transactionRows = transactions.map((row) => `
        <div class="statement-detail-row">
          <span>${row.date || "未填日期"} · ${kindLabels[row.kind] || "其他"} · ${escapeHtml(row.title || "未命名")}</span>
          <strong>${money(row.amount)}</strong>
        </div>
      `).join("");

      return `
        <article class="record-item">
          <div>
            <p class="record-title">${month.replace("-", " 年 ")} 月</p>
            <p class="record-meta">${transactions.length} 筆消費 · 系統依日期自動整理</p>
            <div class="history-summary">
              <span>當月收入<strong>${money(income)}</strong></span>
              <span>當月支出<strong>${money(spent)}</strong></span>
              <span>當月結餘<strong>${money(balance)}</strong></span>
            </div>
            <details class="statement-details">
              <summary>查看類型與明細</summary>
              <div class="statement-detail-list">
                ${typeRows || '<p class="record-meta">本期沒有支出。</p>'}
                ${transactionRows ? `<div class="statement-detail-row statement-difference-row"><span>全部消費明細</span><strong>${transactions.length} 筆</strong></div>${transactionRows}` : ""}
              </div>
            </details>
          </div>
        </article>
      `;
    }).join("");
  }

  async function toggleHistory() {
    const list = $("historyList");
    const button = $("historyButton");
    if (!list || !button) return;

    if (!list.hidden) {
      list.hidden = true;
      button.textContent = "查看歷史";
      return;
    }

    button.disabled = true;
    button.textContent = "讀取中…";
    try {
      if (!state.historyLoaded) {
        const [cycles, transactions, incomeRecords, reimbursements] = await Promise.all([
          client.from("budget_cycles").select("*").eq("user_id", state.user.id).order("start_date", { ascending: false }),
          client.from("transactions").select("*").eq("user_id", state.user.id),
          client.from("income_records").select("*").eq("user_id", state.user.id),
          client.from("reimbursements").select("*").eq("user_id", state.user.id)
        ]);
        [cycles, transactions, incomeRecords, reimbursements].forEach((result) => {
          if (result.error) throw result.error;
        });
        state.historyCycles = cycles.data || [];
        state.historyTransactions = transactions.data || [];
        state.historyIncomeRecords = incomeRecords.data || [];
        state.historyReimbursements = reimbursements.data || [];
        state.historyLoaded = true;
      }
      renderHistory();
      list.hidden = false;
      button.textContent = "收起歷史";
    } finally {
      button.disabled = false;
      if (list.hidden) button.textContent = "查看歷史";
    }
  }

  async function downloadBackup() {
    const [cycles, transactions, reimbursements, settings, creditCards, cardCharges, installmentPlans, accounts, accountTransfers, incomeRecords, subscriptions] = await Promise.all([
      client.from("budget_cycles").select("*").eq("user_id", state.user.id),
      client.from("transactions").select("*").eq("user_id", state.user.id),
      client.from("reimbursements").select("*").eq("user_id", state.user.id),
      client.from("user_settings").select("*").eq("user_id", state.user.id),
      client.from("credit_cards").select("*").eq("user_id", state.user.id),
      client.from("credit_card_charges").select("*").eq("user_id", state.user.id),
      client.from("installment_plans").select("*").eq("user_id", state.user.id),
      client.from("accounts").select("*").eq("user_id", state.user.id),
      client.from("account_transfers").select("*").eq("user_id", state.user.id),
      client.from("income_records").select("*").eq("user_id", state.user.id),
      client.from("monthly_subscriptions").select("*").eq("user_id", state.user.id)
    ]);
    [cycles, transactions, reimbursements, settings, creditCards, cardCharges, installmentPlans, accounts, accountTransfers, incomeRecords, subscriptions].forEach((result) => {
      if (result.error) throw result.error;
    });
    const blob = new Blob([JSON.stringify({
      exported_at: new Date().toISOString(),
      budget_cycles: cycles.data,
      transactions: transactions.data,
      reimbursements: reimbursements.data,
      user_settings: settings.data,
      credit_cards: creditCards.data,
      credit_card_charges: cardCharges.data,
      installment_plans: installmentPlans.data,
      accounts: accounts.data,
      account_transfers: accountTransfers.data,
      income_records: incomeRecords.data,
      monthly_subscriptions: subscriptions.data
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

    for (const table of ["budget_cycles", "credit_cards", "accounts", "installment_plans", "monthly_subscriptions", "transactions", "reimbursements", "credit_card_charges", "account_transfers", "income_records", "user_settings"]) {
      const rows = rewrite(backup[table]);
      if (!rows.length) continue;
      const { error } = await client.from(table).upsert(rows);
      if (error) throw error;
    }
    showToast("備份已還原");
    await refresh();
  }

  function setDefaultDates() {
    ["expenseDate", "incomeDate", "advanceDate", "openingBillDate", "installmentFirstDate", "cardFeeDate", "cardFeeDueDate", "transferDate"].forEach((id) => {
      const input = $(id);
      if (input) input.value = today();
    });
  }

  function setLabelText(controlId, text) {
    const label = $(controlId)?.closest("label");
    if (!label || !label.firstChild) return;
    label.firstChild.textContent = `\n            ${text}\n            `;
  }

  function applyCopyOverrides() {
    ensureSubscriptionPanel();
    organizeDashboardSections();
    const heroEyebrow = $("heroCard")?.querySelector(".eyebrow");
    if (heroEyebrow) heroEyebrow.textContent = "預估月底總結餘";
    setLabelText("openingBillAmount", "實際帳單金額");
    setLabelText("openingBillDate", "帳單日");
    setLabelText("openingBillCardSelect", "信用卡");
    setLabelText("openingBillDueDate", "繳款日");
    const billReminderTitle = $("billReminderList")?.closest(".list-section")?.querySelector("h2");
    if (billReminderTitle) billReminderTitle.textContent = "帳單提醒";
    const cardChargeTitle = $("cardChargeList")?.closest(".list-section")?.querySelector("h2");
    if (cardChargeTitle) cardChargeTitle.textContent = "信用卡帳單";
    const cardDueMetric = $("cardDueAmount")?.closest(".metric-card");
    if (cardDueMetric && !$("cardDueDetail")) {
      const detail = document.createElement("small");
      detail.id = "cardDueDetail";
      detail.className = "metric-detail";
      cardDueMetric.appendChild(detail);
    }
    const openingButton = $("openingBillForm")?.querySelector("button[type=\"submit\"]");
    if (openingButton) openingButton.textContent = "新增實際帳單";
    const helper = $("openingBillForm")?.querySelector(".helper-text");
    if (helper) helper.textContent = "收到信用卡帳單後，把帳單上的總金額填在這裡；系統會拿已記錄的刷卡預估和實際帳單比對差額。";
    if ($("subscriptionDay") && !$("subscriptionDay").value) {
      $("subscriptionDay").value = new Date().getDate();
    }
    if ($("subscriptionMonth") && !$("subscriptionMonth").value) {
      $("subscriptionMonth").value = new Date().getMonth() + 1;
    }
    ensureEditPaymentFields();
  }

  function organizeDashboardSections() {
    const recordSection = $("recordList")?.closest(".list-section");
    if (recordSection) {
      recordSection.id = "recentActivitySection";
      const title = recordSection.querySelector("h2");
      if (title) title.textContent = "最近動態";
      const detail = recordSection.querySelector(".section-title span");
      if (detail) detail.textContent = "最近 5 筆收入、支出與待收狀態";
    }

    const reimbursementSection = $("reimbursementList")?.closest(".list-section");
    const reminderSection = $("billReminderList")?.closest(".list-section");
    if (reimbursementSection) {
      reimbursementSection.id = "reimbursementPanel";
      reimbursementSection.classList.add("work-panel");
      const title = reimbursementSection.querySelector("h2");
      if (title) title.textContent = "待收款明細";
      const detail = reimbursementSection.querySelector(".section-title span");
      if (detail) detail.textContent = "收回後只會結清待收，不算收入";
    }
    if (reminderSection && $("cardPanel") && !reminderSection.closest("#cardPanel")) {
      $("cardPanel").appendChild(reminderSection);
    }

    const cardChargeSection = $("cardChargeList")?.closest(".list-section");
    if (cardChargeSection && $("cardPanel") && !cardChargeSection.closest("#cardPanel")) {
      $("cardPanel").appendChild(cardChargeSection);
    }

    const installmentSection = $("installmentList")?.closest(".list-section");
    if (installmentSection && $("installmentPanel") && !installmentSection.closest("#installmentPanel")) {
      $("installmentPanel").appendChild(installmentSection);
    }
  }

  function ensureEditPaymentFields() {
    if ($("editPaymentMethod")) return;
    const titleInput = $("editTitle");
    const titleLabel = titleInput?.closest("label");
    if (!titleLabel) return;

    const paymentLabel = document.createElement("label");
    paymentLabel.innerHTML = `
      付款方式
      <select id="editPaymentMethod">
        <option value="cash">帳戶／現金</option>
        <option value="credit_card">信用卡</option>
      </select>
    `;
    const cardLabel = document.createElement("label");
    cardLabel.id = "editCardLabel";
    cardLabel.innerHTML = `
      信用卡
      <select id="editCardSelect"></select>
    `;
    const accountLabel = document.createElement("label");
    accountLabel.id = "editAccountLabel";
    accountLabel.innerHTML = `
      扣款帳戶
      <select id="editAccountSelect"></select>
    `;

    titleLabel.after(paymentLabel, cardLabel, accountLabel);
    $("editPaymentMethod").addEventListener("change", toggleCardFields);
  }

  function ensureSubscriptionPanel() {
    if ($("subscriptionPanel")) return;
    const menu = document.querySelector(".app-menu-list");
    const installmentButton = menu?.querySelector('[data-panel="installmentPanel"]');
    const accountButton = menu?.querySelector('[data-panel="accountPanel"]');
    const button = document.createElement("button");
    button.className = "tab-button";
    button.type = "button";
    button.dataset.panel = "subscriptionPanel";
    button.innerHTML = "<strong>訂閱</strong><span>固定扣款與續訂管理</span>";
    menu?.insertBefore(button, accountButton || installmentButton?.nextSibling || null);

    const panel = document.createElement("section");
    panel.className = "work-panel";
    panel.id = "subscriptionPanel";
    panel.innerHTML = `
      <form id="subscriptionForm" class="form-grid">
        <label>
          金額
          <input id="subscriptionAmount" type="number" min="1" step="1" inputmode="numeric" required>
        </label>
        <label>
          繳費頻率
          <select id="subscriptionBillingCycle">
            <option value="monthly">月繳</option>
            <option value="yearly">年繳</option>
          </select>
        </label>
        <label id="subscriptionMonthLabel" hidden>
          扣款月份
          <input id="subscriptionMonth" type="number" min="1" max="12" step="1" inputmode="numeric">
        </label>
        <label>
          每月扣款日
          <input id="subscriptionDay" type="number" min="1" max="31" step="1" inputmode="numeric" required>
        </label>
        <label class="full-width">
          名稱
          <input id="subscriptionTitle" type="text" maxlength="80" placeholder="Netflix、iCloud、手機費" required>
        </label>
        <label>
          付款方式
          <select id="subscriptionPaymentMethod">
            <option value="cash">帳戶／現金</option>
            <option value="credit_card">信用卡</option>
          </select>
        </label>
        <label id="subscriptionCardLabel">
          信用卡
          <select id="subscriptionCardSelect"></select>
        </label>
        <label id="subscriptionAccountLabel">
          扣款帳戶
          <select id="subscriptionAccountSelect"></select>
        </label>
        <button class="primary-button full-width" type="submit">新增訂閱</button>
        <p class="helper-text full-width">啟用中的訂閱會自動納入每月預估；退訂或暫停時按停用即可。</p>
      </form>
      <div class="inline-list" id="subscriptionList"></div>
    `;
    const installmentPanel = $("installmentPanel");
    installmentPanel?.after(panel);
  }

  function wireEvents() {
    function getAuthCredentials() {
      const email = $("emailInput").value.trim();
      const password = $("passwordInput").value;
      return { email, password };
    }

    async function signInWithPassword() {
      const { email, password } = getAuthCredentials();
      const { data, error } = await client.auth.signInWithPassword({
        email,
        password
      });

      if (error) {
        $("authMessage").textContent = `登入失敗：${error.message}`;
        return;
      }

      state.user = data.user;
      $("signOutButton").hidden = false;
      $("authMessage").textContent = "登入成功。";
      await refresh();
    }

    async function signUpWithPassword() {
      const { email, password } = getAuthCredentials();
      const { data, error } = await client.auth.signUp({
        email,
        password
      });

      if (error) {
        $("authMessage").textContent = `建立帳號失敗：${error.message}`;
        return;
      }

      if (!data.session) {
        $("authMessage").textContent = "帳號已建立，請先到信箱完成確認，再回來用密碼登入。";
        return;
      }

      state.user = data.user;
      $("signOutButton").hidden = false;
      $("authMessage").textContent = "帳號已建立並登入成功。";
      await refresh();
    }

    $("authForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      await signInWithPassword();
    });

    $("signUpButton").addEventListener("click", wrap(signUpWithPassword));

    $("signOutButton").addEventListener("click", async () => {
      await client.auth.signOut();
      window.location.reload();
    });

    $("cycleForm").addEventListener("submit", wrap(createCycle));
    $("expenseForm").addEventListener("submit", wrap(addExpense));
    $("incomeForm").addEventListener("submit", wrap(addIncome));
    $("subscriptionForm").addEventListener("submit", wrap(addSubscription));
    $("advanceForm").addEventListener("submit", wrap(addAdvance));
    $("reimbursementForm").addEventListener("submit", wrap(addManualReimbursement));
    $("wishForm").addEventListener("submit", runWish);
    $("cardForm").addEventListener("submit", wrap(addCreditCard));
    $("openingBillForm").addEventListener("submit", wrap(addOpeningBill));
    $("installmentForm").addEventListener("submit", wrap(addInstallment));
    $("cardFeeForm").addEventListener("submit", wrap(addCardFee));
    $("accountForm").addEventListener("submit", wrap(addAccount));
    $("transferForm").addEventListener("submit", wrap(addTransfer));
    $("editForm").addEventListener("submit", wrap(saveEdit));
    $("cancelEditButton").addEventListener("click", () => $("editDialog").close());
    $("backupButton").addEventListener("click", wrap(downloadBackup));
    $("historyButton").addEventListener("click", wrap(toggleHistory));
    $("copyMotherRequestButton").addEventListener("click", wrap(copyMotherRequest));
    $("restoreInput").addEventListener("change", wrap(restoreBackup));
    $("expensePaymentMethod").addEventListener("change", toggleCardFields);
    $("advancePaymentMethod").addEventListener("change", toggleCardFields);
    $("subscriptionPaymentMethod").addEventListener("change", toggleCardFields);
    $("subscriptionBillingCycle").addEventListener("change", toggleCardFields);
    $("openingBillCardSelect").addEventListener("change", fillOpeningBillDatesFromCard);
    makeMetricClickable("pendingAmount", "查看待收款明細", showReimbursementDetails);
    makeMetricClickable("dailyAllowance", "查看收入明細", showIncomeDetails);
    makeMetricClickable("cardDueAmount", "查看未出帳信用卡明細", showPendingCardEstimateDetails);
    makeMetricClickable("futureInstallmentAmount", "查看分期細項", showInstallmentDetails);

    const closeAppMenu = () => {
      $("appMenuBackdrop").hidden = true;
    };

    $("openAppMenuButton").addEventListener("click", () => {
      $("appMenuBackdrop").hidden = false;
    });
    $("closeAppMenuButton").addEventListener("click", closeAppMenu);
    $("appMenuBackdrop").addEventListener("click", (event) => {
      if (event.target === $("appMenuBackdrop")) closeAppMenu();
    });

    document.querySelectorAll(".tab-button[data-panel]").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".tab-button[data-panel]").forEach((item) => item.classList.remove("active"));
        document.querySelectorAll(".work-panel").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        $("openAppMenuButton").classList.toggle("active", Boolean(button.closest(".app-menu")));
        $(button.dataset.panel).classList.add("active");
        closeAppMenu();
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

    $("cardChargeList").addEventListener("click", wrap(async (event) => {
      const tab = event.target.closest("[data-card-statement-tab]")?.dataset.cardStatementTab;
      const paidButton = event.target.closest("[data-pay-card-charge]");
      const paidId = paidButton?.dataset.payCardCharge;
      const editId = event.target.closest("[data-edit-card-charge]")?.dataset.editCardCharge;
      const deleteId = event.target.closest("[data-delete-card-charge]")?.dataset.deleteCardCharge;
      if (tab) {
        $("cardChargeList").dataset.cardStatementTab = tab;
        renderCardCharges();
        return;
      }
      if (paidId) {
        const originalText = paidButton.textContent;
        paidButton.disabled = true;
        paidButton.textContent = "處理中…";
        try {
          await markCardChargePaid(paidId);
        } finally {
          if (paidButton.isConnected) {
            paidButton.disabled = false;
            paidButton.textContent = originalText;
          }
        }
      }
      if (editId) await editCardCharge(editId);
      if (deleteId) await deleteCardCharge(deleteId);
    }));

    $("billReminderList").addEventListener("click", wrap(async (event) => {
      const paidButton = event.target.closest("[data-pay-card-charge]");
      const paidId = paidButton?.dataset.payCardCharge;
      if (paidId) {
        const originalText = paidButton.textContent;
        paidButton.disabled = true;
        paidButton.textContent = "處理中…";
        try {
          await markCardChargePaid(paidId);
        } finally {
          if (paidButton.isConnected) {
            paidButton.disabled = false;
            paidButton.textContent = originalText;
          }
        }
      }
    }));

    $("cardList").addEventListener("click", wrap(async (event) => {
      const toggleId = event.target.dataset.toggleCard;
      const deleteId = event.target.dataset.deleteCard;
      if (toggleId) await toggleCreditCard(toggleId);
      if (deleteId) await deleteCreditCard(deleteId);
    }));

    $("accountList").addEventListener("click", wrap(async (event) => {
      const editId = event.target.dataset.editAccount;
      if (editId) await editAccount(editId);
    }));

    $("installmentList").addEventListener("click", wrap(async (event) => {
      const deleteId = event.target.dataset.deleteInstallment;
      if (deleteId) await deleteInstallment(deleteId);
    }));

    $("transferList").addEventListener("click", wrap(async (event) => {
      const deleteId = event.target.dataset.deleteTransfer;
      if (deleteId) await deleteTransfer(deleteId);
    }));

    $("incomeList").addEventListener("click", wrap(async (event) => {
      const deleteId = event.target.dataset.deleteIncome;
      if (deleteId) await deleteIncome(deleteId);
    }));

    $("subscriptionList").addEventListener("click", wrap(async (event) => {
      const toggleId = event.target.dataset.toggleSubscription;
      const deleteId = event.target.dataset.deleteSubscription;
      if (toggleId) await toggleSubscription(toggleId);
      if (deleteId) await deleteSubscription(deleteId);
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
  applyCopyOverrides();
  registerServiceWorker();
  wireEvents();
  initAuth().catch((error) => {
    console.error(error);
    showToast("初始化失敗，請檢查 Supabase 設定");
  });
})();
