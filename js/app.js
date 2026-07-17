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
    incomeRecords: []
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

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js?v=20260717.05")
        .then((registration) => {
          registration.addEventListener("updatefound", () => {
            const worker = registration.installing;
            if (!worker) return;
            worker.addEventListener("statechange", () => {
              if (worker.state === "activated" && navigator.serviceWorker.controller) {
                window.location.reload();
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
    return window.LeftBudget.summarizeBudget(state, {
      spend: extraSpend,
      today: today()
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
    $("safetyBuffer").textContent = money(summary.commitmentBuffer);
    $("spentAmount").textContent = money(summary.spent);
    $("pendingAmount").textContent = money(summary.pending);
    $("dailyAllowance").textContent = money(summary.daily);
    $("cardDueAmount").textContent = money(summary.cardDue);
    $("futureInstallmentAmount").textContent = money(summary.futureInstallmentBalance);
    $("safetyText").textContent = summary.commitmentBuffer >= 0
      ? `扣掉最低保留 ${money(state.cycle.minimum_savings)} 與未來分期後，安全餘裕 ${money(summary.commitmentBuffer)}。距離下次發薪還有 ${summary.daysLeft} 天。`
      : `扣掉未來分期後，還差 ${money(Math.abs(summary.commitmentBuffer))} 才能守住最低保留 ${money(state.cycle.minimum_savings)}。`;
    $("cycleRange").textContent = `${state.cycle.start_date} 到 ${state.cycle.expected_pay_date}`;
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
    renderBillReminders();
    renderMotherRequest();
    updateListTabCounts();
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
      records: state.transactions.length,
      reimbursements: state.reimbursements.filter((row) => row.status === "pending").length,
      billReminders: getBillReminderRows().length,
      cardCharges: state.cardCharges.length,
      installments: state.installmentPlans.length
    };
    nav.querySelectorAll(".list-tab-button").forEach((button) => {
      const count = counts[button.dataset.listKey] || 0;
      const badge = button.querySelector(".list-tab-count");
      if (badge) badge.textContent = count;
      button.classList.toggle("has-items", count > 0);
    });
  }

  function renderCardOptions() {
    const activeCards = state.creditCards.filter((card) => card.is_active);
    const options = activeCards.length
      ? activeCards.map((card) => `<option value="${card.id}">${escapeHtml(card.name)}</option>`).join("")
      : '<option value="">請先新增信用卡</option>';

    ["expenseCardSelect", "advanceCardSelect", "openingBillCardSelect", "installmentCardSelect", "cardFeeCardSelect"].forEach((id) => {
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

    ["expenseAccountSelect", "advanceAccountSelect", "incomeAccountSelect", "transferFromSelect", "transferToSelect"].forEach((id) => {
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

  function getBillReminderRows() {
    const current = today();
    return state.cardCharges
      .filter((row) => row.status !== "paid" && row.due_date)
      .map((row) => ({
        ...row,
        daysLeft: Math.ceil((parseLocalDate(row.due_date) - parseLocalDate(current)) / 86400000)
      }))
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
    if ($("expenseCardLabel")) $("expenseCardLabel").hidden = !expenseUsesCard;
    if ($("advanceCardLabel")) $("advanceCardLabel").hidden = !advanceUsesCard;
    if ($("expenseAccountLabel")) $("expenseAccountLabel").hidden = expenseUsesCard;
    if ($("advanceAccountLabel")) $("advanceAccountLabel").hidden = advanceUsesCard;
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
      <span>${canBuy ? "買完仍達標" : "買完會低於最低存款"}</span>
      <strong>${money(summary.projected)}</strong>
      <p>${canBuy ? `安全餘裕剩 ${money(summary.commitmentBuffer)}` : `還差 ${money(Math.abs(summary.commitmentBuffer))} 才達標`}</p>
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
    const { error } = await client
      .from("credit_card_charges")
      .update({ status: "paid", paid_at: today() })
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;
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
      .update({ is_closed: true, closed_at: new Date().toISOString() })
      .eq("id", state.cycle.id)
      .eq("user_id", state.user.id);
    if (error) throw error;
    state.cycle = null;
    showToast("已結束本期");
    await refresh();
  }

  async function downloadBackup() {
    const [cycles, transactions, reimbursements, settings, creditCards, cardCharges, installmentPlans, accounts, accountTransfers, incomeRecords] = await Promise.all([
      client.from("budget_cycles").select("*").eq("user_id", state.user.id),
      client.from("transactions").select("*").eq("user_id", state.user.id),
      client.from("reimbursements").select("*").eq("user_id", state.user.id),
      client.from("user_settings").select("*").eq("user_id", state.user.id),
      client.from("credit_cards").select("*").eq("user_id", state.user.id),
      client.from("credit_card_charges").select("*").eq("user_id", state.user.id),
      client.from("installment_plans").select("*").eq("user_id", state.user.id),
      client.from("accounts").select("*").eq("user_id", state.user.id),
      client.from("account_transfers").select("*").eq("user_id", state.user.id),
      client.from("income_records").select("*").eq("user_id", state.user.id)
    ]);
    [cycles, transactions, reimbursements, settings, creditCards, cardCharges, installmentPlans, accounts, accountTransfers, incomeRecords].forEach((result) => {
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
      income_records: incomeRecords.data
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

    for (const table of ["budget_cycles", "credit_cards", "accounts", "installment_plans", "transactions", "reimbursements", "credit_card_charges", "account_transfers", "income_records", "user_settings"]) {
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
    $("newCycleButton").addEventListener("click", wrap(closeCycle));
    $("backupButton").addEventListener("click", wrap(downloadBackup));
    $("copyMotherRequestButton").addEventListener("click", wrap(copyMotherRequest));
    $("restoreInput").addEventListener("change", wrap(restoreBackup));
    $("expensePaymentMethod").addEventListener("change", toggleCardFields);
    $("advancePaymentMethod").addEventListener("change", toggleCardFields);
    $("openingBillCardSelect").addEventListener("change", fillOpeningBillDatesFromCard);
    setupListTabs();

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

    $("cardChargeList").addEventListener("click", wrap(async (event) => {
      const paidId = event.target.dataset.payCardCharge;
      const editId = event.target.dataset.editCardCharge;
      const deleteId = event.target.dataset.deleteCardCharge;
      if (paidId) await markCardChargePaid(paidId);
      if (editId) await editCardCharge(editId);
      if (deleteId) await deleteCardCharge(deleteId);
    }));

    $("billReminderList").addEventListener("click", wrap(async (event) => {
      const paidId = event.target.dataset.payCardCharge;
      if (paidId) await markCardChargePaid(paidId);
    }));

    $("cardList").addEventListener("click", wrap(async (event) => {
      const toggleId = event.target.dataset.toggleCard;
      const deleteId = event.target.dataset.deleteCard;
      if (toggleId) await toggleCreditCard(toggleId);
      if (deleteId) await deleteCreditCard(deleteId);
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
  registerServiceWorker();
  wireEvents();
  initAuth().catch((error) => {
    console.error(error);
    showToast("初始化失敗，請檢查 Supabase 設定");
  });
})();
