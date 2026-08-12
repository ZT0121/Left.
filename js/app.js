(function () {
  const config = window.LEFT_SUPABASE || window.MYLEDGER_SUPABASE || {};
  const hasConfig = Boolean(config.url && config.anonKey);
  const recoveryLinkParams = new URLSearchParams(window.location.hash.slice(1));
  const openedFromRecoveryLink = recoveryLinkParams.get("type") === "recovery";
  const recoveryLinkTokens = {
    access_token: recoveryLinkParams.get("access_token") || "",
    refresh_token: recoveryLinkParams.get("refresh_token") || ""
  };
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
    accountBalanceTransfers: [],
    accountBalanceIncomeRecords: [],
    accountBalanceTransactions: [],
    accountBalanceCardCharges: [],
    incomeRecords: [],
    subscriptions: [],
    emailCandidates: [],
    gmailConnection: null,
    historyCycles: [],
    historyTransactions: [],
    historyIncomeRecords: [],
    historyReimbursements: [],
    historyLoaded: false,
    passwordRecovery: false
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
  const pushPublicKey = "BN6FJFRU6jNrwzJ_bhi9K-2TADOYFwIwEvahgezvjl8hs87n2DcWw_f8ts9ol0rtN7_YYDneDHubzB9ZCq3-mH8";
  const preferredCardOrder = [
    { rank: 0, patterns: ["cube", "國泰世華"], displayName: "Cube" },
    { rank: 1, patterns: ["hsbc", "匯豐"], displayName: null },
    { rank: 2, patterns: ["富邦costco", "costco", "富邦"], displayName: null },
    { rank: 3, patterns: ["台新"], displayName: null },
    { rank: 4, patterns: ["中國信託", "中信"], displayName: null }
  ];

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

  function normalizedCardName(card) {
    return String(card?.name || "").replace(/\s+/g, "").toLowerCase();
  }

  function cardPreference(card) {
    const normalized = normalizedCardName(card);
    return preferredCardOrder.find((item) => item.patterns.some((pattern) => normalized.includes(pattern.toLowerCase())));
  }

  function cardDisplayName(card) {
    return cardPreference(card)?.displayName || card?.name || "信用卡";
  }

  function sortCards(cards) {
    return [...cards].sort((a, b) => {
      const aRank = cardPreference(a)?.rank ?? 99;
      const bRank = cardPreference(b)?.rank ?? 99;
      if (aRank !== bRank) return aRank - bRank;
      return cardDisplayName(a).localeCompare(cardDisplayName(b), "zh-Hant");
    });
  }

  function isEstimatedCardCharge(row) {
    return estimatedCardSources.has(row.source_type) && !isStatementLinkedCharge(row);
  }

  function isActualStatement(row) {
    return row.source_type === "opening_bill";
  }

  function getCardChargeTransaction(row) {
    if (!row?.transaction_id) return null;
    return state.transactions.find((item) => item.id === row.transaction_id)
      || state.accountBalanceTransactions.find((item) => item.id === row.transaction_id)
      || null;
  }

  function getActualStatementAmount(row) {
    const transaction = getCardChargeTransaction(row);
    const transactionAmount = toNumber(transaction?.gross_amount || transaction?.amount);
    return transactionAmount > 0 ? transactionAmount : toNumber(row.amount);
  }

  function isStatementLinkedCharge(row) {
    const transaction = getCardChargeTransaction(row);
    return transaction?.kind === "opening_card_bill";
  }

  function normalizeCardChargeAmounts(rows) {
    return (rows || []).map((row) => (
      isActualStatement(row)
        ? { ...row, amount: getActualStatementAmount(row) }
        : row
    ));
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

  function cardEstimateItemKey(row) {
    if (row.transaction_id) return `tx:${row.transaction_id}`;
    if (row.source_type === "subscription" && row.id) return `subscription:${row.id}`;
    if (row.installment_plan_id && row.installment_number) {
      return `installment:${row.installment_plan_id}:${row.installment_number}`;
    }
    return [
      row.source_type,
      row.card_id,
      row.charge_date || row.due_date || "",
      row.title || "",
      toNumber(row.amount)
    ].join(":");
  }

  function uniqueCardEstimateItems(rows) {
    const seen = new Set();
    return (rows || []).filter((row) => {
      const key = cardEstimateItemKey(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function urlBase64ToUint8Array(value) {
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = window.atob(base64);
    return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
  }

  function getEstimateFor(cardId, dueDate) {
    if (!cardId || !dueDate) return 0;
    const actualRow = state.cardCharges.find((row) => isActualStatement(row) && row.card_id === cardId && row.due_date === dueDate);
    const statementKey = actualRow ? cardStatementKey(actualRow) : `${cardId}:${String(dueDate).slice(0, 7)}`;
    return uniqueCardEstimateItems([...state.cardCharges, ...getSubscriptionCardEstimateRows(), ...getUpcomingInstallmentEstimateRows()]
      .filter((row) => isEstimatedCardCharge(row) && row.card_id === cardId && cardStatementKey(row) === statementKey)
    )
      .reduce((sum, row) => sum + toNumber(row.amount), 0);
  }

  function getEstimateItemsForActual(row) {
    if (!isActualStatement(row) || !row.card_id || !row.due_date) return [];
    const key = cardStatementKey(row);
    return uniqueCardEstimateItems([...state.cardCharges, ...getSubscriptionCardEstimateRows(), ...getUpcomingInstallmentEstimateRows()]
      .filter((item) => isEstimatedCardCharge(item) && item.card_id === row.card_id && cardStatementKey(item) === key)
    )
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

    uniqueCardEstimateItems([...state.cardCharges, ...getSubscriptionCardEstimateRows(), ...getUpcomingInstallmentEstimateRows()])
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
      navigator.serviceWorker.register("./sw.js?v=20260812-15")
        .then((registration) => {
          registration.update()
            .catch((error) => console.warn("Service worker update check failed", error));
        })
        .catch((error) => console.warn("Service worker registration failed", error));
    });
  }

  function showToast(message, duration = 2600) {
    const toast = $("toast");
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      toast.hidden = true;
    }, duration);
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
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${supabaseUrl}/auth/v1/settings`, {
        headers: { apikey: config.anonKey },
        signal: controller.signal
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
      if (error?.name === "AbortError") {
        return "連線等候過久。你仍可嘗試登入，或按上方重新載入。";
      }
      return formatSupabaseFetchError(error);
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function getDefaultNextPayDate() {
    const date = new Date();
    date.setMonth(date.getMonth() + 1);
    date.setDate(0);
    return date.toISOString().slice(0, 10);
  }

  function calculateSummary(extraSpend = 0) {
    const accountBalances = getAccountBalances();
    const simulatedCardCharge = extraSpend > 0
      ? [{ source_type: "general", amount: extraSpend, status: "pending" }]
      : [];
    return window.LeftBudget.summarizeBudget({
      ...state,
      accountBalances,
      cardCharges: [
        ...state.cardCharges,
        ...getSubscriptionCardEstimateRows(),
        ...getUpcomingInstallmentEstimateRows(),
        ...simulatedCardCharge
      ]
    }, {
      today: today(),
      currentMonth: currentMonth()
    });
  }

  function applyStatus(buffer) {
    const hero = $("heroCard");
    const pill = $("statusPill");
    const headline = $("statusHeadline");
    hero.classList.remove("safe", "warning", "danger");
    pill.classList.remove("safe", "warning", "danger");

    if (buffer < 0) {
      hero.classList.add("danger");
      pill.classList.add("danger");
      pill.textContent = "低於底線";
      if (headline) headline.textContent = "最近先緩一緩";
      return;
    }

    if (buffer <= 1000) {
      hero.classList.add("warning");
      pill.classList.add("warning");
      pill.textContent = "接近底線";
      if (headline) headline.textContent = "留下的餘裕不多";
      return;
    }

    hero.classList.add("safe");
    pill.classList.add("safe");
    pill.textContent = "高於底線";
    if (headline) headline.textContent = "目前有留住";
  }

  function renderAttentionBanner() {
    const banner = $("attentionBanner");
    const list = $("attentionList");
    if (!banner || !list) return;
    const current = today();
    const reminders = [];

    state.cardCharges
      .filter((row) => isActualStatement(row) && row.status === "pending" && row.due_date)
      .forEach((row) => {
        const days = Math.ceil((parseLocalDate(row.due_date) - parseLocalDate(current)) / 86400000);
        if (days > 3) return;
        const timing = days < 0
          ? `已逾期 ${Math.abs(days)} 天`
          : days === 0
            ? "今天到期"
            : `${days} 天後到期`;
        reminders.push({
          type: "card",
          title: row.title || "信用卡帳單尚未繳款",
          detail: timing,
          amount: toNumber(row.amount)
        });
      });

    state.reimbursements
      .filter((row) => row.status === "pending" && Date.now() - Date.parse(row.created_at) > 86400000)
      .forEach((row) => {
        const elapsedDays = Math.floor((Date.now() - Date.parse(row.created_at)) / 86400000);
        reminders.push({
          type: "reimbursement",
          title: row.title || "待收款尚未收回",
          detail: `已等待 ${elapsedDays} 天`,
          amount: toNumber(row.amount)
        });
      });

    banner.hidden = reminders.length === 0;
    $("attentionCount").textContent = reminders.length ? `${reminders.length} 件` : "";
    list.innerHTML = reminders.map((reminder) => `
      <button class="attention-item" type="button" data-attention-type="${reminder.type}">
        <span>
          <strong>${escapeHtml(reminder.title)}</strong>
          <span>${reminder.detail}</span>
        </span>
        <strong>${money(reminder.amount)}</strong>
      </button>
    `).join("");
  }

  async function updateNotificationSetup() {
    const setup = $("notificationSetup");
    const button = $("enableNotificationsButton");
    if (!setup || !button || !state.user) return;
    const supported = "Notification" in window
      && "serviceWorker" in navigator
      && "PushManager" in window;
    if (!supported) {
      setup.hidden = false;
      button.hidden = true;
      $("notificationSetupTitle").textContent = "此瀏覽器不支援推播";
      $("notificationSetupText").textContent = "請使用最新版 Android Chrome，並將 Left. 安裝到主畫面。";
      return;
    }

    if (Notification.permission === "granted") {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      setup.hidden = Boolean(subscription);
      button.hidden = false;
      button.textContent = subscription ? "已開啟" : "完成通知設定";
      return;
    }

    setup.hidden = false;
    button.hidden = Notification.permission === "denied";
    $("notificationSetupTitle").textContent = Notification.permission === "denied"
      ? "手機通知已被封鎖"
      : "開啟手機通知";
    $("notificationSetupText").textContent = Notification.permission === "denied"
      ? "請到 Android 的網站或 App 通知設定中允許 Left. 通知。"
      : "卡費到期前 3 天、到期當天，以及待收款超過 1 天時提醒你。";
  }

  async function enablePushNotifications() {
    if (!state.user) throw new Error("請先登入");
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      throw new Error("此瀏覽器不支援推播通知");
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      await updateNotificationSetup();
      throw new Error("需要允許通知，才能在手機收到提醒");
    }

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(pushPublicKey)
      });
    }
    const serialized = subscription.toJSON();
    const { error } = await client.from("push_subscriptions").upsert({
      user_id: state.user.id,
      endpoint: subscription.endpoint,
      p256dh: serialized.keys?.p256dh,
      auth: serialized.keys?.auth
    }, { onConflict: "endpoint" });
    if (error) throw error;

    showToast("手機通知已開啟");
    await updateNotificationSetup();
  }

  function renderDashboard() {
    if (!state.cycle) return;

    const summary = calculateSummary();
    $("projectedSavings").textContent = money(summary.afterCardPayment);
    $("safetyBuffer").textContent = money(Math.abs(summary.safeToSpend));
    const bottomLineLabel = $("bottomLineLabel");
    if (bottomLineLabel) bottomLineLabel.textContent = summary.safeToSpend >= 0 ? "高於底線" : "低於底線";
    const safetyBreakdown = $("safetyBreakdown");
    if (safetyBreakdown) {
      safetyBreakdown.textContent = `帳戶 ${money(summary.accountBalance)} - 未繳卡費 ${money(summary.cardDue)} - 固定扣款 ${money(summary.subscriptionEstimate)} - 未繳分期 ${money(summary.futureInstallmentBalance)} - 最低保留 ${money(state.cycle.minimum_savings)}`;
    }
    $("spentAmount").textContent = money(summary.afterCardPayment);
    $("pendingAmount").textContent = money(summary.pending);
    $("dailyAllowance").textContent = money(summary.accountBalance);
    $("cardDueAmount").textContent = money(summary.cardDue);
    const cardDueDetail = $("cardDueDetail");
    if (cardDueDetail) {
      const paidActual = state.cardCharges
        .filter((row) => isActualStatement(row) && row.status === "paid")
        .reduce((sum, row) => sum + toNumber(row.amount), 0);
      cardDueDetail.textContent = `已繳 ${money(paidActual)} · 預估未出帳 ${money(summary.cardDueEstimate)}`;
    }
    $("futureInstallmentAmount").textContent = money(summary.futureInstallmentBalance);
    $("cycleRange").textContent = `${state.cycle.start_date} 以來`;
    $("safetyText").textContent = summary.safeToSpend >= 0
      ? `卡費、固定扣款和分期都算進去後，還比你設定的底線多 ${money(summary.safeToSpend)}。`
      : `卡費、固定扣款和分期都算進去後，還差 ${money(Math.abs(summary.safeToSpend))} 才能留到你設定的金額。`;
    applyStatus(summary.safeToSpend);
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
    renderEmailCandidates();
    renderWishPurchases();
    renderBillReminders();
    renderMotherRequest();
    renderAttentionBanner();
    updateNotificationSetup().catch((error) => console.warn("Notification setup check failed", error));
  }

  function renderTransactions() {
    const list = $("recordList");
    const transactionRows = [...state.transactions]
      .filter((row) => row.kind === "expense" || row.kind === "advance")
      .map((row) => ({
        ...row,
        activityKind: "transaction",
        activityType: row.kind === "advance" ? "代墊" : "支出",
        activityDate: row.date,
        activityTitle: row.title || (row.kind === "advance" ? "代墊" : "一般支出"),
        activityAmount: row.amount,
        amountPrefix: "−"
      }));
    const incomeRows = state.incomeRecords.map((row) => ({
      ...row,
      activityKind: "income",
      activityType: "收入",
      activityDate: row.date,
      activityTitle: row.title || "收入",
      activityAmount: row.amount,
      amountPrefix: "+"
    }));
    const transactionDates = new Map(state.transactions.map((row) => [row.id, row.date]));
    const reimbursementRows = state.reimbursements.map((row) => ({
      ...row,
      activityKind: "reimbursement",
      activityType: row.status === "received" ? "已收回補" : "待收",
      activityDate: transactionDates.get(row.transaction_id) || row.received_at || String(row.created_at || "").slice(0, 10),
      activityTitle: row.title || "待收款",
      activityAmount: row.amount,
      amountPrefix: ""
    }));
    const accountsById = new Map(state.accounts.map((account) => [account.id, account]));
    const transferRows = state.accountTransfers.map((row) => ({
      ...row,
      activityKind: "transfer",
      activityType: "轉帳／儲值",
      activityDate: row.date,
      activityTitle: row.title || "轉帳／儲值",
      activityMeta: `${accountsById.get(row.from_account_id)?.name || "來源"} → ${accountsById.get(row.to_account_id)?.name || "目的"}`,
      activityAmount: row.amount,
      amountPrefix: ""
    }));
    const allRows = [...transactionRows, ...incomeRows, ...reimbursementRows, ...transferRows]
      .sort((a, b) => `${b.activityDate || ""}${b.created_at || ""}`.localeCompare(`${a.activityDate || ""}${a.created_at || ""}`));
    const fullList = $("allRecordList");
    const searchText = $("recordSearch")?.value.trim().toLocaleLowerCase("zh-Hant") || "";
    const typeFilter = $("recordTypeFilter")?.value || "all";
    const filteredRows = allRows.filter((row) => {
      const matchesType = typeFilter === "all" || row.activityKind === typeFilter;
      const searchable = `${row.activityTitle || ""} ${row.activityType || ""} ${row.activityMeta || ""}`.toLocaleLowerCase("zh-Hant");
      return matchesType && (!searchText || searchable.includes(searchText));
    });

    if (!allRows.length) {
      list.innerHTML = '<p class="empty-state">還沒有紀錄。記下第一筆收入或支出吧。</p>';
      if (fullList) fullList.innerHTML = '<p class="empty-state">還沒有任何紀錄。</p>';
      return;
    }

    const renderRow = (row, showActions) => {
      let actions = "";
      if (showActions && row.activityKind === "transaction") {
        actions = `<button type="button" data-edit="${row.id}">編輯</button><button type="button" data-delete="${row.id}">刪除</button>`;
      } else if (showActions && row.activityKind === "income") {
        actions = `<button type="button" data-delete-income="${row.id}">刪除</button>`;
      } else if (showActions && row.activityKind === "reimbursement") {
        actions = `${row.status === "pending" ? `<button type="button" data-received="${row.id}">標記已收</button>` : ""}<button type="button" data-delete-reimbursement="${row.id}">刪除</button>`;
      } else if (showActions && row.activityKind === "transfer") {
        actions = `<button type="button" data-delete-transfer="${row.id}">刪除</button>`;
      }

      const details = [
        row.activityDate || "未填日期",
        row.activityType,
        row.activityMeta,
        row.kind === "advance" ? `總金額 ${money(row.gross_amount)}` : ""
      ].filter(Boolean).join(" · ");

      return `
      <article class="record-item">
        <div>
          <p class="record-title">${escapeHtml(row.activityTitle)}</p>
          <p class="record-meta">${escapeHtml(details)}</p>
        </div>
        <div class="record-amount">${row.amountPrefix}${money(row.activityAmount)}</div>
        ${actions ? `<div class="record-actions">${actions}</div>` : ""}
      </article>
    `;
    };

    list.innerHTML = allRows.slice(0, 3).map((row) => renderRow(row, false)).join("");
    if (fullList) {
      fullList.innerHTML = filteredRows.length
        ? filteredRows.map((row) => renderRow(row, true)).join("")
        : '<p class="empty-state">找不到符合條件的紀錄。</p>';
    }
  }

  function renderWishPurchases() {
    const list = $("wishPurchaseList");
    if (!list) return;

    const rows = [...state.transactions]
      .filter((row) => row.kind === "expense" && row.payment_method === "credit_card")
      .sort((a, b) => `${b.date || ""}${b.created_at || ""}`.localeCompare(`${a.date || ""}${a.created_at || ""}`))
      .slice(0, 8);

    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">還沒有從這裡記下購物。試算後可以直接記成信用卡支出。</p>';
      return;
    }

    const cardsById = new Map(state.creditCards.map((card) => [card.id, card]));
    list.innerHTML = rows.map((row) => {
      const card = cardsById.get(row.credit_card_id);
      return `
        <article class="record-item">
          <div>
            <p class="record-title">${escapeHtml(row.title || "一般消費")}</p>
            <p class="record-meta">${row.date || "未填日期"} · ${escapeHtml(cardDisplayName(card))}</p>
          </div>
          <div class="record-amount">${money(row.amount)}</div>
          <div class="record-actions">
            <button type="button" data-edit-wish="${row.id}">編輯</button>
            <button type="button" data-delete-wish="${row.id}">刪除</button>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderReimbursements() {
    const list = $("reimbursementList");
    const transactionDates = new Map(state.transactions.map((row) => [row.id, row.date]));
    const rows = [...state.reimbursements]
      .filter((row) => row.status === "pending")
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
        return String(b.created_at).localeCompare(String(a.created_at));
      });

    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">目前沒有等著收回的款項。</p>';
      return;
    }

    list.innerHTML = rows.map((row) => `
      <article class="record-item">
        <div>
          <p class="record-title">${escapeHtml(row.title || "待收款")}</p>
          <p class="record-meta">${transactionDates.get(row.transaction_id) || String(row.created_at || "").slice(0, 10)} · ${row.status === "received" ? `已收 ${row.received_at || ""}` : "未收"}</p>
        </div>
        <div class="record-amount">${money(row.amount)}</div>
        <div class="record-actions">
          ${row.status === "pending" ? `<button type="button" data-received="${row.id}">標記已收</button>` : ""}
          <button type="button" data-delete-reimbursement="${row.id}">刪除</button>
        </div>
      </article>
    `).join("");
  }

  function compactText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeCandidateText(value) {
    return compactText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  }

  function merchantSimilarity(a, b) {
    const left = normalizeCandidateText(a);
    const right = normalizeCandidateText(b);
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.includes(right) || right.includes(left)) return 0.85;
    const leftChars = new Set([...left]);
    const rightChars = new Set([...right]);
    const overlap = [...leftChars].filter((char) => rightChars.has(char)).length;
    return overlap / Math.max(leftChars.size, rightChars.size);
  }

  function daysApart(a, b) {
    if (!a || !b) return Infinity;
    return Math.abs(Math.ceil((parseLocalDate(a) - parseLocalDate(b)) / 86400000));
  }

  function formatLocalDateTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const parts = new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(date);
    const pick = (type) => parts.find((part) => part.type === type)?.value || "";
    return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
  }

  function parseCandidateDate(text) {
    const full = text.match(/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})/);
    if (full) {
      return `${full[1]}-${String(full[2]).padStart(2, "0")}-${String(full[3]).padStart(2, "0")}`;
    }
    const short = text.match(/(?:消費|交易|授權|入帳|日期|時間)[^\d]{0,8}(\d{1,2})[/-](\d{1,2})/);
    if (short) {
      return `${today().slice(0, 4)}-${String(short[1]).padStart(2, "0")}-${String(short[2]).padStart(2, "0")}`;
    }
    return today();
  }

  function parseCandidateAmount(text) {
    const amountPatterns = [
      /(?:NT\$|TWD|新臺幣|新台幣|金額|消費金額|交易金額|授權金額)[^\d]{0,12}([\d,]+)(?:\.\d+)?/i,
      /\$[\s]*([\d,]+)(?:\.\d+)?/
    ];
    for (const pattern of amountPatterns) {
      const match = text.match(pattern);
      const amount = toNumber(String(match?.[1] || "").replace(/,/g, ""));
      if (amount > 0 && amount < 10000000) return amount;
    }
    const candidates = [...text.matchAll(/(?:^|[^\d])([\d,]{2,})(?:\.\d+)?(?:[^\d]|$)/g)]
      .map((match) => toNumber(String(match[1]).replace(/,/g, "")))
      .filter((amount) => amount > 0 && amount < 10000000)
      .filter((amount) => !/^20\d{6}$/.test(String(amount)));
    return candidates.length ? Math.max(...candidates) : 0;
  }

  function parseCandidateMerchant(text) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const labelPatterns = [
      /(?:商店|商家|特店|店家|消費店家|交易店家|merchant)[：:\s]+(.+)/i,
      /(?:於|在)\s*([^，,。\n]{2,40})\s*(?:消費|交易|刷卡)/
    ];
    for (const line of lines) {
      for (const pattern of labelPatterns) {
        const match = line.match(pattern);
        const value = compactText(match?.[1] || "").replace(/[。；;，,].*$/, "");
        if (value && !/\d{4,}/.test(value)) return value.slice(0, 80);
      }
    }
    const subject = lines.find((line) => /刷卡|消費|交易|授權|通知/.test(line));
    return compactText(subject || lines[0] || "未命名消費").slice(0, 80);
  }

  function buildCandidateKey(row) {
    return [
      row.card_id || "no-card",
      row.occurred_at,
      toNumber(row.amount),
      normalizeCandidateText(row.merchant).slice(0, 24)
    ].join(":");
  }

  function parseEmailCandidateText(text, cardId) {
    const raw = String(text || "").trim();
    const amount = parseCandidateAmount(raw);
    if (amount <= 0) throw new Error("找不到可信的消費金額");
    const occurredAt = parseCandidateDate(raw);
    const merchant = parseCandidateMerchant(raw);
    const firstLine = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
    const candidate = {
      card_id: cardId,
      candidate_kind: "purchase",
      occurred_at: occurredAt,
      merchant,
      amount,
      currency: "TWD",
      raw_subject: firstLine.slice(0, 160),
      raw_excerpt: raw.slice(0, 700),
      source_type: "manual_email",
      source_count: 1,
      source_refs: [{ imported_at: new Date().toISOString(), subject: firstLine.slice(0, 160) }]
    };
    return { ...candidate, candidate_key: buildCandidateKey(candidate) };
  }

  function findSimilarCandidate(candidate) {
    return state.emailCandidates.find((row) => (
      ["pending", "duplicate"].includes(row.status)
      && row.card_id === candidate.card_id
      && toNumber(row.amount) === toNumber(candidate.amount)
      && daysApart(row.occurred_at, candidate.occurred_at) <= 3
      && merchantSimilarity(row.merchant, candidate.merchant) >= 0.55
    ));
  }

  function findMatchedTransaction(candidate) {
    return state.transactions.find((row) => (
      row.payment_method === "credit_card"
      && row.credit_card_id === candidate.card_id
      && toNumber(row.gross_amount || row.amount) === toNumber(candidate.amount)
      && daysApart(row.date, candidate.occurred_at) <= 3
      && merchantSimilarity(row.title, candidate.merchant) >= 0.45
    ));
  }

  function renderEmailCandidates() {
    const list = $("emailCandidateList");
    const count = $("emailCandidateCount");
    const status = $("gmailConnectionStatus");
    if (!list) return;
    if (status) {
      status.textContent = state.gmailConnection
        ? `已連接 ${state.gmailConnection.gmail_email || "Gmail"}${state.gmailConnection.last_sync_at ? ` · 上次同步 ${formatLocalDateTime(state.gmailConnection.last_sync_at)}` : ""}`
        : "尚未連接 Gmail";
    }
    const rows = [...state.emailCandidates]
      .filter((row) => ["pending", "duplicate"].includes(row.status))
      .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
    if (count) count.textContent = rows.length ? `${rows.length} 筆待確認` : "沒有待確認";
    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">目前沒有待確認交易。</p>';
      return;
    }

    list.innerHTML = rows.map((row) => {
      const card = state.creditCards.find((item) => item.id === row.card_id);
      const duplicateText = row.matched_transaction_id ? " · 疑似已記錄" : "";
      const sourceText = row.source_count > 1 ? ` · 合併 ${row.source_count} 封` : "";
      const kindText = row.candidate_kind === "statement" ? " · 實際帳單" : "";
      const acceptText = row.candidate_kind === "statement" ? "建立帳單" : "加入帳本";
      const refs = Array.isArray(row.source_refs) ? row.source_refs : [];
      const sourceSubject = row.raw_subject || refs.find((ref) => ref?.subject)?.subject || "";
      const sourceLine = sourceSubject ? `<p class="record-meta">來源：${escapeHtml(sourceSubject)}</p>` : "";
      return `
        <article class="record-item ${row.matched_transaction_id ? "reminder-item" : ""}">
          <div>
            <p class="record-title">${escapeHtml(row.merchant)}</p>
            <p class="record-meta">${row.occurred_at} · ${escapeHtml(cardDisplayName(card))}${kindText}${sourceText}${duplicateText}</p>
            ${sourceLine}
          </div>
          <div class="record-amount">${money(row.amount)}</div>
          <div class="record-actions">
            <button type="button" data-accept-email-candidate="${row.id}">${acceptText}</button>
            <button type="button" data-skip-email-candidate="${row.id}">略過</button>
          </div>
        </article>
      `;
    }).join("");
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

  let detailHistoryActive = false;

  function closeDetailView() {
    document.body.classList.remove("detail-view-active");
    $("dashboard")?.classList.remove("detail-view");
    $("detailHeader").hidden = true;
    document.querySelectorAll(".tab-button[data-panel]").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".work-panel").forEach((item) => item.classList.remove("active"));
    $("openAppMenuButton")?.classList.remove("active");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openDetailView(panelId, title, pushHistory = true) {
    const panel = $(panelId);
    if (!panel) return;
    document.querySelectorAll(".tab-button[data-panel]").forEach((item) => {
      item.classList.toggle("active", item.dataset.panel === panelId);
    });
    document.querySelectorAll(".work-panel").forEach((item) => item.classList.remove("active"));
    panel.classList.add("active");
    document.body.classList.add("detail-view-active");
    $("dashboard").classList.add("detail-view");
    $("detailTitle").textContent = title;
    $("detailHeader").hidden = false;
    $("appMenuBackdrop").hidden = true;
    $("openAppMenuButton")?.classList.toggle("active", Boolean(document.querySelector(`.app-menu [data-panel="${panelId}"]`)));
    if (pushHistory && !detailHistoryActive) {
      window.history.pushState({ ...(window.history.state || {}), leftDetail: true }, "");
      detailHistoryActive = true;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
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
    openDetailView("reimbursementPanel", "待收款");
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
    const activeCards = sortCards(state.creditCards.filter((card) => card.is_active));
    const options = activeCards.length
      ? activeCards.map((card) => `<option value="${card.id}">${escapeHtml(cardDisplayName(card))}</option>`).join("")
      : '<option value="">請先新增信用卡</option>';

    ["expenseCardSelect", "advanceCardSelect", "openingBillCardSelect", "installmentCardSelect", "cardFeeCardSelect", "subscriptionCardSelect", "editCardSelect", "emailCandidateCardSelect"].forEach((id) => {
      const select = $(id);
      if (select) select.innerHTML = options;
    });

    toggleCardFields();
    fillOpeningBillDatesFromCard();
  }

  function renderAccountOptions() {
    const activeAccounts = state.accounts.filter((account) => account.is_active !== false);
    const preferredIncomeAccount = getPreferredIncomeAccount(activeAccounts);
    const options = activeAccounts.length
      ? activeAccounts.map((account) => `<option value="${account.id}">${escapeHtml(account.name)}</option>`).join("")
      : '<option value="">請先新增帳戶</option>';
    const incomeOptions = activeAccounts.length
      ? activeAccounts.map((account) => `<option value="${account.id}"${account.id === preferredIncomeAccount?.id ? " selected" : ""}>${escapeHtml(account.name)}</option>`).join("")
      : options;

    ["expenseAccountSelect", "advanceAccountSelect", "incomeAccountSelect", "transferFromSelect", "transferToSelect", "subscriptionAccountSelect", "editAccountSelect"].forEach((id) => {
      const select = $(id);
      if (select) select.innerHTML = id === "incomeAccountSelect" ? incomeOptions : options;
    });

    selectPreferredIncomeAccount(activeAccounts);
  }

  function getPreferredIncomeAccount(accounts) {
    return accounts.find((account) => {
      const name = String(account.name || "").replace(/\s+/g, "").toLowerCase();
      return name.includes("富邦") || name.includes("fubon");
    });
  }

  function selectPreferredIncomeAccount(accounts) {
    const select = $("incomeAccountSelect");
    const preferredAccount = getPreferredIncomeAccount(accounts);
    if (select && preferredAccount) select.value = preferredAccount.id;
  }

  function getAccountBalances() {
    return window.LeftBudget.calculateAccountBalances({
      ...state,
      accountTransfers: state.accountBalanceTransfers,
      incomeRecords: state.accountBalanceIncomeRecords,
      transactions: state.accountBalanceTransactions,
      cardCharges: state.accountBalanceCardCharges,
      asOfDate: today()
    });
  }

  function renderAccounts() {
    const list = $("accountList");
    if (!list) return;
    const rows = getAccountBalances();
    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">先新增一個帳戶，之後就能記錄餘額和轉帳。</p>';
      return;
    }

    const typeLabel = {
      bank: "銀行",
      wallet: "電子錢包",
      cash: "現金",
      other: "其他"
    };

    list.innerHTML = rows.map((account) => {
      const breakdown = account.balance_breakdown || {};
      const detail = `原有 ${money(breakdown.opening)} + 收入 ${money(breakdown.income)} + 轉入 ${money(breakdown.transferIn)} - 轉出 ${money(breakdown.transferOut)} - 支出 ${money(breakdown.spent)} - 繳卡費 ${money(breakdown.paidCardCharges)}`;
      return `
      <article class="record-item">
        <div>
          <p class="record-title">${escapeHtml(account.name)}</p>
          <p class="record-meta">${typeLabel[account.type] || "其他"} · ${account.balance_date || "未設定日期"} 的餘額是 ${money(account.opening_balance)}</p>
          <p class="record-meta">${detail}</p>
        </div>
        <div class="record-amount">${money(account.balance)}</div>
        <div class="record-actions">
          <button type="button" data-edit-account="${account.id}">編輯</button>
        </div>
      </article>
    `;
    }).join("");
  }

  function renderTransfers() {
    const list = $("transferList");
    if (!list) return;
    const accountsById = new Map(state.accounts.map((account) => [account.id, account]));
    const rows = [...state.accountTransfers]
      .sort((a, b) => `${b.date}${b.created_at}`.localeCompare(`${a.date}${a.created_at}`))
      .slice(0, 8);

    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">還沒有轉帳或儲值紀錄。</p>';
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
      list.innerHTML = '<p class="empty-state">還沒記過收入。</p>';
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
      list.innerHTML = '<p class="empty-state">還沒有固定扣款。</p>';
      return;
    }

    list.innerHTML = rows.map((row) => {
      const payTarget = row.payment_method === "credit_card"
        ? cardDisplayName(cardsById.get(row.credit_card_id))
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
      list.innerHTML = '<p class="empty-state">還沒有固定扣款。</p>';
      return;
    }

    list.innerHTML = rows.map((row) => {
      const payTarget = row.payment_method === "credit_card"
        ? cardDisplayName(cardsById.get(row.credit_card_id))
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
      list.innerHTML = '<p class="empty-state">還沒有固定扣款。</p>';
      return;
    }

    list.innerHTML = rows.map((row) => {
      const payTarget = row.payment_method === "credit_card"
        ? cardDisplayName(cardsById.get(row.credit_card_id))
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
    return window.LeftBudget.getCardPaymentReminders(state.cardCharges, today(), 7)
      .map((row) => ({ ...row, row_type: "actual" }));
  }

  function renderBillReminders() {
    const list = $("billReminderList");
    if (!list) return;
    const rows = getBillReminderRows();
    if (!rows.length) {
      list.innerHTML = '<p class="empty-state">接下來 7 天沒有已出帳的卡費要繳。</p>';
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
            <p class="record-meta">${escapeHtml(cardDisplayName(card))} · ${row.due_date} · ${dueText}</p>
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
      list.innerHTML = '<p class="empty-state">接下來 7 天沒有已出帳的卡費要繳。</p>';
      return;
    }

    list.innerHTML = rows.map((row) => {
      const card = state.creditCards.find((item) => item.id === row.card_id);
      const cardName = cardDisplayName(card);
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
      list.innerHTML = '<p class="empty-state">先新增一張信用卡，就能開始記刷卡和分期。</p>';
      return;
    }

    list.innerHTML = sortCards(state.creditCards).map((card) => `
      <article class="record-item">
        <div>
          <p class="record-title">${escapeHtml(cardDisplayName(card))}</p>
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
      list.innerHTML = '<p class="empty-state">目前沒有未繳卡費。</p>';
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
            <p class="record-meta">${sourceLabel} · ${escapeHtml(cardDisplayName(card))} · 消費 ${row.charge_date} · 結帳 ${closingDate || "未設定"} · 繳款 ${row.due_date || "未設定"}${row.status === "paid" ? ` · 已繳 ${row.paid_at || ""}` : ""}</p>
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
      list.innerHTML = '<p class="empty-state">還沒有信用卡帳單。</p>';
      return;
    }

    list.innerHTML = rows.map((row) => {
      const card = state.creditCards.find((item) => item.id === row.card_id);

      if (row.row_type === "estimate") {
        const cardName = cardDisplayName(card);
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
      const cardName = cardDisplayName(card);
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
      const cardName = cardDisplayName(card);
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
      const cardName = cardDisplayName(card);
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
      const estimateItems = isActualStatement(row) ? getEstimateItemsForActual(row) : [];
      const estimateSourceLabel = {
        general: "一般刷卡",
        advance: "代墊",
        installment: "分期",
        subscription: "訂閱"
      };
      const estimateDetailRows = estimateItems.map((item) => `
        <div class="statement-detail-row">
          <span>${item.charge_date || item.due_date || "未填日期"} · ${estimateSourceLabel[item.source_type] || "預估"} · ${escapeHtml(item.title || "未命名")}</span>
          <strong>${money(item.amount)}</strong>
        </div>
      `).join("");
      const differenceDetails = isActualStatement(row)
        ? `
          <details class="statement-details" open>
            <summary>查看預估明細（${estimateItems.length} 筆，共 ${money(estimate)}）</summary>
            <div class="statement-detail-list">
              ${estimateDetailRows || '<p class="record-meta">這期目前沒有 App 預估明細。</p>'}
              <div class="statement-detail-row statement-difference-row">
                <span>實際帳單 - App 預估</span>
                <strong>${formatDifference(toNumber(row.amount) - estimate)}</strong>
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
      list.innerHTML = '<p class="empty-state">目前沒有分期。</p>';
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
            <p class="record-meta">${escapeHtml(cardDisplayName(card))} · ${plan.installment_count} 期 · 首期 ${plan.first_due_date}</p>
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

  function splitSharedFeeForMealRows(total, count, mealRowCount) {
    const otherCount = Math.max(0, mealRowCount);
    if (!total || !count) {
      return {
        own: 0,
        others: Array.from({ length: otherCount }, () => 0)
      };
    }

    const ownParticipates = count > otherCount;
    const shares = splitSharedFee(total, count);
    return {
      own: ownParticipates ? shares[0] : 0,
      others: Array.from(
        { length: otherCount },
        (_, index) => shares[ownParticipates ? index + 1 : index] || 0
      )
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
    await loadAccountBalanceEntries();
    await loadSubscriptions();
    await loadInstallmentPlans();
    await generateDueInstallments();

    const [txResult, reimbursementResult, chargeResult, candidateResult] = await Promise.all([
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
        .eq("cycle_id", state.cycle.id),
      client
        .from("email_transaction_candidates")
        .select("*")
        .eq("user_id", state.user.id)
        .eq("cycle_id", state.cycle.id)
        .order("occurred_at", { ascending: false })
    ]);

    if (txResult.error) throw txResult.error;
    if (reimbursementResult.error) throw reimbursementResult.error;
    if (chargeResult.error) throw chargeResult.error;
    if (candidateResult.error) {
      if (candidateResult.error.code === "42P01") {
        state.emailCandidates = [];
        showConfigWarning("待確認交易資料表尚未建立", "請先在 Supabase SQL Editor 執行最新版 <code>schema.sql</code>。");
      } else {
        throw candidateResult.error;
      }
    }
    state.transactions = txResult.data || [];
    state.reimbursements = reimbursementResult.data || [];
    state.cardCharges = normalizeCardChargeAmounts(chargeResult.data);
    state.emailCandidates = candidateResult.error ? [] : candidateResult.data || [];
    await loadGmailConnection();
  }

  async function callGmailSync(path, payload = {}) {
    const { data } = await client.auth.getSession();
    const response = await fetch(`${supabaseUrl}/functions/v1/gmail-sync/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${data.session?.access_token || ""}`
      },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Gmail 同步失敗");
    return body;
  }

  async function loadGmailConnection() {
    try {
      const result = await callGmailSync("status");
      state.gmailConnection = result.connection || null;
    } catch (error) {
      state.gmailConnection = null;
    }
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

  async function loadAccountBalanceEntries() {
    const [transferResult, incomeResult, transactionResult, cardChargeResult] = await Promise.all([
      client
        .from("account_transfers")
        .select("*")
        .eq("user_id", state.user.id)
        .order("date", { ascending: false }),
      client
        .from("income_records")
        .select("*")
        .eq("user_id", state.user.id)
        .order("date", { ascending: false }),
      client
        .from("transactions")
        .select("*")
        .eq("user_id", state.user.id)
        .order("date", { ascending: false }),
      client
        .from("credit_card_charges")
        .select("*")
        .eq("user_id", state.user.id)
        .order("charge_date", { ascending: false })
    ]);

    if (transferResult.error) throw transferResult.error;
    if (incomeResult.error) throw incomeResult.error;
    if (transactionResult.error) throw transactionResult.error;
    if (cardChargeResult.error) throw cardChargeResult.error;
    state.accountBalanceTransfers = transferResult.data || [];
    state.accountBalanceIncomeRecords = incomeResult.data || [];
    state.accountBalanceTransactions = transactionResult.data || [];
    state.accountBalanceCardCharges = normalizeCardChargeAmounts(cardChargeResult.data);
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
    const reminder = new URL(window.location.href).searchParams.get("reminder");
    if (reminder === "card") document.querySelector('[data-panel="cardPanel"]')?.click();
    if (reminder === "reimbursement") showReimbursementDetails();
    if (reminder) {
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("reminder");
      window.history.replaceState({}, "", cleanUrl.toString());
    }
  }

  function fillCycleDefaults() {
    const settings = state.settings || {};
    $("minimumInput").value = settings.default_minimum_savings || 5000;
  }

  function enterPasswordRecoveryMode() {
    state.passwordRecovery = true;
    setVisible("bootPanel", false);
    setVisible("authPanel", true);
    setVisible("cyclePanel", false);
    setVisible("dashboard", false);
    $("authEmailLabel").hidden = true;
    $("emailInput").required = false;
    $("passwordInput").value = "";
    $("passwordInput").autocomplete = "new-password";
    $("signInButton").textContent = "儲存新密碼";
    $("resetPasswordButton").hidden = true;
    $("authMessage").textContent = "請輸入新的密碼（至少 6 個字元）。";
  }

  async function ensureRecoverySession() {
    const { data } = await client.auth.getSession();
    if (data.session) return data.session;

    if (recoveryLinkTokens.access_token && recoveryLinkTokens.refresh_token) {
      const { data: sessionData, error } = await client.auth.setSession(recoveryLinkTokens);
      if (error) throw error;
      if (sessionData.session) return sessionData.session;
    }

    throw new Error("重設連結已失效，請回登入頁重新寄送忘記密碼信。");
  }

  async function initAuth() {
    if (!hasConfig || !client) {
      setVisible("bootPanel", false);
      showConfigWarning(
        hasConfig ? "無法載入 Supabase。" : "尚未設定 Supabase。",
        hasConfig
          ? "連線元件載入失敗，請重新整理頁面後再試。"
          : '請先依 README 建立 Supabase 專案，並填入 <code>js/config.js</code>。'
      );
      setVisible("authPanel", hasConfig);
      return;
    }

    const connectionError = await checkSupabaseConnection();
    if (connectionError) {
      setVisible("bootPanel", false);
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

    client.auth.onAuthStateChange((event) => {
      if (event !== "PASSWORD_RECOVERY") return;
      enterPasswordRecoveryMode();
    });

    const { data } = await client.auth.getSession();
    setVisible("bootPanel", false);
    state.user = data.session?.user || null;
    $("signOutButton").hidden = !state.user;
    $("changePasswordButton").hidden = !state.user;

    if (state.user && openedFromRecoveryLink) {
      enterPasswordRecoveryMode();
      return;
    }

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

    showToast("設定完成，可以開始記帳了");
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
    showToast("這筆支出已記下");
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
    const ownParticipatesInMealSplit = usesMealSplit && personal > 0;
    const minimumSplitPeople = usesMealSplit
      ? mealRows.length + (ownParticipatesInMealSplit ? 1 : 0)
      : 0;
    const splitPeople = peopleInput || minimumSplitPeople;
    const mealSubtotal = personal + mealRows.reduce((sum, row) => sum + row.amount, 0);
    if (usesMealSplit && grossInput < mealSubtotal) {
      throw new Error(`個別餐點合計 ${money(mealSubtotal)}，已經超過總金額 ${money(grossInput)}。`);
    }
    const sharedToSplit = usesMealSplit
      ? Math.max(0, grossInput - mealSubtotal)
      : shared;
    if (usesMealSplit && splitPeople < minimumSplitPeople) {
      throw new Error("分攤人數不能少於有餐點明細的人數。");
    }
    const mealShares = splitSharedFeeForMealRows(sharedToSplit, splitPeople, mealRows.length);
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
    showToast("這筆代墊已記下");
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
    showToast(status === "received" ? "回補款已記下" : "待收款已記下");
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
    selectPreferredIncomeAccount(state.accounts.filter((account) => account.is_active !== false));
    showToast("這筆收入已記下");
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

  async function importEmailCandidate(event) {
    event.preventDefault();
    const text = $("emailCandidateText").value;
    const cardId = requireCard("emailCandidateCardSelect");
    const parsed = parseEmailCandidateText(text, cardId);
    const similar = findSimilarCandidate(parsed);
    const matched = findMatchedTransaction(parsed);

    if (similar) {
      const refs = Array.isArray(similar.source_refs) ? similar.source_refs : [];
      const { error } = await client
        .from("email_transaction_candidates")
        .update({
          source_count: toNumber(similar.source_count) + 1,
          source_refs: [...refs, ...parsed.source_refs],
          raw_excerpt: parsed.raw_excerpt,
          matched_transaction_id: similar.matched_transaction_id || matched?.id || null
        })
        .eq("id", similar.id)
        .eq("user_id", state.user.id);
      if (error) throw error;
      showToast("已合併到既有待確認交易");
    } else {
      const { error } = await client
        .from("email_transaction_candidates")
        .insert({
          user_id: state.user.id,
          cycle_id: state.cycle.id,
          ...parsed,
          matched_transaction_id: matched?.id || null
        });
      if (error) {
        if (error.code === "23505") {
          showToast("這封信看起來已經匯入過");
        } else {
          throw error;
        }
      } else {
        showToast(matched ? "已匯入，並標示疑似已記錄" : "已匯入待確認交易");
      }
    }

    $("emailCandidateText").value = "";
    await refresh();
  }

  async function acceptEmailCandidate(id) {
    const row = state.emailCandidates.find((item) => item.id === id);
    if (!row) return;
    const title = row.merchant || (row.candidate_kind === "statement" ? "實際信用卡帳單" : "信用卡消費");
    if (row.candidate_kind === "statement") {
      const tx = await insertTransaction({
        kind: "opening_card_bill",
        date: row.occurred_at,
        title,
        amount: toNumber(row.amount),
        gross_amount: toNumber(row.amount),
        payment_method: "credit_card",
        credit_card_id: row.card_id
      }, false);
      await insertCardCharge({
        card_id: row.card_id,
        transaction_id: tx.id,
        source_type: "opening_bill",
        title,
        charge_date: row.occurred_at,
        due_date: row.due_date || getCardDueDate(row.card_id, row.occurred_at),
        amount: toNumber(row.amount)
      });
      const { error } = await client
        .from("email_transaction_candidates")
        .update({ status: "accepted", matched_transaction_id: tx.id })
        .eq("id", id)
        .eq("user_id", state.user.id);
      if (error) throw error;
      showToast("已建立實際帳單");
      await refresh();
      return;
    }

    const tx = await insertTransaction({
      kind: "expense",
      date: row.occurred_at,
      title,
      amount: toNumber(row.amount),
      gross_amount: toNumber(row.amount),
      payment_method: "credit_card",
      credit_card_id: row.card_id
    }, false);
    await insertCardCharge({
      card_id: row.card_id,
      transaction_id: tx.id,
      source_type: "general",
      title,
      charge_date: row.occurred_at,
      due_date: getCardDueDate(row.card_id, row.occurred_at),
      amount: toNumber(row.amount)
    });
    const { error } = await client
      .from("email_transaction_candidates")
      .update({ status: "accepted", matched_transaction_id: tx.id })
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;
    showToast("已加入帳本");
    await refresh();
  }

  async function skipEmailCandidate(id) {
    const { error } = await client
      .from("email_transaction_candidates")
      .update({ status: "skipped" })
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;
    showToast("已略過");
    await refresh();
  }

  async function connectGmail() {
    const result = await callGmailSync("start", { redirect_to: window.location.href });
    window.location.href = result.auth_url;
  }

  function showGmailSyncResult(title, result, resetText = "") {
    const dialog = $("syncResultDialog");
    const titleEl = $("syncResultTitle");
    const body = $("syncResultBody");
    const reasonLabels = {
      non_purchase: "非消費信",
      weak_purchase_signal: "不像刷卡通知",
      no_labeled_amount: "找不到金額"
    };
    const stats = [
      ["掃描", `${result.scanned || 0} 封`],
      ["解析", `${result.parsed || 0} 筆`],
      ["新增", `${result.imported || 0} 筆`],
      ["合併", `${result.merged || 0} 筆`],
      ["已記住", `${result.remembered || 0} 封`],
      ["略過", `${result.skipped || 0} 封`]
    ];
    const reasonRows = Object.entries(result.skip_reasons || {})
      .filter(([, count]) => Number(count) > 0)
      .map(([key, count]) => `${reasonLabels[key] || key} ${count}`)
      .join(" / ");
    const sampleRows = (result.skip_samples || [])
      .slice(0, 5)
      .map((item) => `
        <li>
          <strong>${escapeHtml(reasonLabels[item.reason] || item.reason)}</strong><br>
          ${escapeHtml(item.subject || "(無主旨)")}
        </li>
      `).join("");

    titleEl.textContent = title;
    body.innerHTML = `
      ${resetText ? `<p class="sync-result-section"><strong>${escapeHtml(resetText)}</strong></p>` : ""}
      <dl class="sync-result-grid">
        ${stats.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}
      </dl>
      ${reasonRows ? `<p class="sync-result-section"><strong>略過原因</strong><br>${escapeHtml(reasonRows)}</p>` : ""}
      ${sampleRows ? `<div class="sync-result-section"><strong>略過樣本</strong><ul class="sync-sample-list">${sampleRows}</ul></div>` : ""}
    `;
    if (dialog?.showModal) dialog.showModal();
    else showToast(`${title}：掃描 ${result.scanned || 0} 封，解析 ${result.parsed || 0} 筆`, 6000);
  }

  async function syncGmail() {
    const result = await callGmailSync("sync");
    if (result.failed) throw new Error(`Gmail 同步有 ${result.failed} 筆寫入失敗：${(result.failures || []).join(" / ")}`);
    showGmailSyncResult("Gmail 同步完成", result);
    await refresh();
  }

  async function rerunGmailInbox() {
    const result = await callGmailSync("sync", { reset_pending: true });
    if (result.failed) throw new Error(`Inbox 重跑有 ${result.failed} 筆寫入失敗：${(result.failures || []).join(" / ")}`);
    const resetText = result.reset_skipped
      ? "沒有解析到可匯入項目，已保留原 Inbox"
      : `清掉 ${result.reset || 0} 筆`;
    showGmailSyncResult("Inbox 已重跑", result, resetText);
    await refresh();
  }

  function runWish(event) {
    event.preventDefault();
    const amount = toNumber($("wishAmount").value);
    const title = $("wishTitle").value.trim() || "這筆購物";
    const summary = calculateSummary(amount);
    const canBuy = summary.safeToSpend >= 0;
    const result = $("wishResult");
    result.hidden = false;
    result.innerHTML = `
      <p class="eyebrow">${escapeHtml(title)}</p>
      <span>${canBuy ? "買下後仍高於底線" : "買下後會低於底線"}</span>
      <strong>${money(Math.abs(summary.safeToSpend))}</strong>
      <p>${canBuy ? `這筆刷下去後，還比你設定的底線多 ${money(summary.safeToSpend)}。` : `這筆刷下去後，會比你設定的底線少 ${money(Math.abs(summary.safeToSpend))}。`}</p>
      <button class="primary-button full-width" type="button" id="buyNowButton">記為信用卡支出</button>
    `;
    $("buyNowButton").addEventListener("click", async () => {
      const cardId = requireCard("expenseCardSelect");
      const tx = await insertTransaction({
        kind: "expense",
        date: today(),
        title,
        amount,
        gross_amount: amount,
        payment_method: "credit_card",
        credit_card_id: cardId,
        account_id: null
      }, false);
      await insertCardCharge({
        card_id: cardId,
        transaction_id: tx.id,
        source_type: "general",
        title: tx.title,
        charge_date: tx.date,
        due_date: getCardDueDate(cardId, tx.date),
        amount
      });
      $("wishForm").reset();
      result.hidden = true;
      showToast("這筆支出已記下");
      await refresh();
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
      balance_date: $("accountBalanceDate").value,
      is_active: true
    });
    if (error) throw error;
    event.target.reset();
    $("accountOpeningBalance").value = 0;
    $("accountBalanceDate").value = today();
    showToast("帳戶已新增");
    await refresh();
  }

  async function editAccount(id) {
    const account = state.accounts.find((item) => item.id === id);
    if (!account) return;

    const name = window.prompt("帳戶名稱", account.name);
    if (name === null) return;
    const openingText = window.prompt("這天的餘額", account.opening_balance);
    if (openingText === null) return;
    const balanceDate = window.prompt("餘額日期（YYYY-MM-DD）", account.balance_date || today());
    if (balanceDate === null) return;
    const type = window.prompt("類型：bank / wallet / cash / other", account.type || "bank");
    if (type === null) return;

    const openingBalance = toNumber(openingText);
    const normalizedBalanceDate = balanceDate.trim();
    const normalizedType = type.trim();
    if (openingBalance < 0) throw new Error("餘額不能小於 0");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedBalanceDate)) {
      throw new Error("餘額日期請使用 YYYY-MM-DD 格式");
    }
    if (!["bank", "wallet", "cash", "other"].includes(normalizedType)) {
      throw new Error("類型只能是 bank、wallet、cash、other");
    }

    const { error } = await client
      .from("accounts")
      .update({
        name: name.trim() || account.name,
        opening_balance: openingBalance,
        balance_date: normalizedBalanceDate,
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

  function choosePaymentAccount() {
    const accounts = state.accounts.filter((account) => account.is_active !== false);
    if (!accounts.length) throw new Error("請先新增一個付款帳戶");
    if (accounts.length === 1) return accounts[0].id;

    const options = accounts
      .map((account, index) => `${index + 1}. ${account.name}`)
      .join("\n");
    const answer = window.prompt(`這筆卡費從哪個帳戶扣款？\n${options}`);
    if (answer === null) return null;

    const index = Number(answer.trim()) - 1;
    if (!Number.isInteger(index) || !accounts[index]) {
      throw new Error("請輸入付款帳戶前面的編號");
    }
    return accounts[index].id;
  }

  async function markCardChargePaid(id) {
    const row = state.cardCharges.find((item) => item.id === id);
    if (!row) throw new Error("找不到這筆帳單，請重新整理後再試");
    const paymentAccountId = choosePaymentAccount();
    if (!paymentAccountId) return;

    const { data, error } = await client
      .from("credit_card_charges")
      .update({ status: "paid", paid_at: today(), payment_account_id: paymentAccountId })
      .eq("id", id)
      .eq("user_id", state.user.id)
      .select("id, status, paid_at, payment_account_id")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("帳單狀態沒有更新，請重新登入後再試");

    row.status = data.status;
    row.paid_at = data.paid_at;
    row.payment_account_id = data.payment_account_id;
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
      list.innerHTML = '<p class="empty-state">還沒有過去的紀錄。</p>';
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
            <p class="record-meta">${transactions.length} 筆消費 · 已按日期整理</p>
            <div class="history-summary">
              <span>當月收入<strong>${money(income)}</strong></span>
              <span>當月支出<strong>${money(spent)}</strong></span>
              <span>當月結餘<strong>${money(balance)}</strong></span>
            </div>
            <details class="statement-details">
              <summary>查看類型與明細</summary>
              <div class="statement-detail-list">
                ${typeRows || '<p class="record-meta">這個月沒有支出。</p>'}
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
    ["expenseDate", "incomeDate", "advanceDate", "openingBillDate", "installmentFirstDate", "cardFeeDate", "cardFeeDueDate", "transferDate", "accountBalanceDate"].forEach((id) => {
      const input = $(id);
      if (input) input.value = today();
    });
  }

  function setLabelText(controlId, text) {
    const label = $(controlId)?.closest("label");
    if (!label || !label.firstChild) return;
    label.firstChild.textContent = `\n            ${text}\n            `;
  }

  function wrapPanelForm(formId, label) {
    const form = $(formId);
    if (!form || form.closest(".panel-disclosure")) return;
    const details = document.createElement("details");
    details.className = "panel-disclosure";
    const summary = document.createElement("summary");
    summary.textContent = label;
    form.before(details);
    form.classList.remove("sub-form");
    details.append(summary, form);
  }

  function wrapPanelElement(elementId, label) {
    const element = $(elementId);
    if (!element || element.closest(".panel-disclosure")) return;
    const details = document.createElement("details");
    details.className = "panel-disclosure";
    const summary = document.createElement("summary");
    summary.textContent = label;
    element.before(details);
    details.append(summary, element);
  }

  function applyCopyOverrides() {
    ensureSubscriptionPanel();
    ensureEmailCandidatePanel();
    organizeDashboardSections();
    wrapPanelElement("cardList", "管理信用卡");
    wrapPanelForm("cardForm", "新增信用卡");
    wrapPanelForm("openingBillForm", "輸入實際帳單");
    wrapPanelForm("cardFeeForm", "新增費用或利息");
    wrapPanelForm("accountForm", "新增帳戶");
    wrapPanelForm("transferForm", "轉帳或儲值");
    const heroEyebrow = $("heroCard")?.querySelector(".eyebrow");
    if (heroEyebrow) heroEyebrow.textContent = "目前狀況";
    setLabelText("openingBillAmount", "實際帳單金額");
    setLabelText("openingBillDate", "帳單日");
    setLabelText("openingBillCardSelect", "信用卡");
    setLabelText("openingBillDueDate", "繳款日");
    const billReminderTitle = $("billReminderList")?.closest(".list-section")?.querySelector("h2");
    if (billReminderTitle) billReminderTitle.textContent = "帳單提醒";
    const billReminderDetail = $("billReminderList")?.closest(".list-section")?.querySelector(".section-title span");
    if (billReminderDetail) billReminderDetail.textContent = "只提醒已輸入的實際帳單";
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
    if (helper) helper.textContent = "收到帳單後，填入帳單總額，就能和目前記下的刷卡金額核對。";
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
      if (detail) detail.textContent = "最新 3 筆";
    }

    const reimbursementSection = $("reimbursementList")?.closest(".list-section");
    const reminderSection = $("billReminderList")?.closest(".list-section");
    if (reimbursementSection) {
      reimbursementSection.id = "reimbursementPanel";
      reimbursementSection.classList.add("work-panel");
      const title = reimbursementSection.querySelector("h2");
      if (title) title.textContent = "待收款明細";
      const detail = reimbursementSection.querySelector(".section-title span");
      if (detail) detail.textContent = "收到錢後會結清，不會再算一次收入";
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
    button.innerHTML = "<strong>固定扣款</strong><span>管理訂閱和定期費用</span>";
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
        <button class="primary-button full-width" type="submit">新增固定扣款</button>
        <p class="helper-text full-width">啟用的項目會先算進固定扣款。取消或暫停後，按「停用」就好。</p>
      </form>
      <div class="inline-list" id="subscriptionList"></div>
    `;
    const installmentPanel = $("installmentPanel");
    installmentPanel?.after(panel);
  }

  function ensureEmailCandidatePanel() {
    if ($("emailCandidatePanel")) return;
    const menu = document.querySelector(".app-menu-list");
    const recordsButton = menu?.querySelector('[data-panel="recordsPanel"]');
    const button = document.createElement("button");
    button.className = "tab-button";
    button.type = "button";
    button.dataset.panel = "emailCandidatePanel";
    button.innerHTML = "<strong>待確認</strong><span>從通知信匯入候選交易</span>";
    recordsButton?.before(button);

    const panel = document.createElement("section");
    panel.className = "work-panel";
    panel.id = "emailCandidatePanel";
    panel.innerHTML = `
      <section class="list-section gmail-sync-panel">
        <div class="section-title">
          <div>
            <p class="eyebrow">Gmail</p>
            <h2>自動匯入通知信</h2>
          </div>
          <span id="gmailConnectionStatus">尚未連接 Gmail</span>
        </div>
        <div class="button-row">
          <button class="secondary-button" id="connectGmailButton" type="button">連接 Gmail</button>
          <button class="primary-button" id="syncGmailButton" type="button">同步 Gmail</button>
          <button class="secondary-button" id="rerunGmailInboxButton" type="button">重跑 Inbox</button>
        </div>
        <p class="helper-text">同步會讀近 30 天信用卡通知信，匯入到待確認，不會直接入帳。</p>
      </section>
      <form id="emailCandidateForm" class="form-grid">
        <label>
          信用卡
          <select id="emailCandidateCardSelect" required></select>
        </label>
        <label class="full-width">
          Mail 內容
          <textarea id="emailCandidateText" placeholder="貼上信用卡消費通知信內容" required></textarea>
        </label>
        <button class="primary-button full-width" type="submit">匯入待確認</button>
        <p class="helper-text full-width">同卡片、同金額、日期接近、商家相似的通知會合併，不會直接入帳。</p>
      </form>
      <section class="list-section">
        <div class="section-title">
          <div>
            <p class="eyebrow">Inbox</p>
            <h2>待確認交易</h2>
          </div>
          <span id="emailCandidateCount">沒有待確認</span>
        </div>
        <div class="inline-list" id="emailCandidateList"></div>
      </section>
    `;
    $("recordsPanel")?.before(panel);
  }

  function wireEvents() {
    function getAuthCredentials() {
      const email = $("emailInput").value.trim();
      const password = $("passwordInput").value;
      return { email, password };
    }

    async function signInWithPassword() {
      const { email, password } = getAuthCredentials();
      if (state.passwordRecovery) {
        try {
          await ensureRecoverySession();
        } catch (error) {
          state.passwordRecovery = false;
          $("authEmailLabel").hidden = false;
          $("emailInput").required = true;
          $("passwordInput").autocomplete = "current-password";
          $("signInButton").textContent = "登入";
          $("resetPasswordButton").hidden = false;
          $("authMessage").textContent = error.message;
          return;
        }
        const { error } = await client.auth.updateUser({ password });
        if (error) {
          $("authMessage").textContent = `無法更新密碼：${error.message}`;
          return;
        }
        state.passwordRecovery = false;
        $("authMessage").textContent = "密碼已更新，正在登入…";
        window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}`);
        await refresh();
        return;
      }

      const { data, error } = await client.auth.signInWithPassword({
        email,
        password
      });

      if (error) {
        $("authMessage").textContent = error.message === "Invalid login credentials"
          ? "登入失敗：Email 或密碼不正確。忘記密碼可以按下方重新設定。"
          : `登入失敗：${error.message}`;
        return;
      }

      state.user = data.user;
      $("signOutButton").hidden = false;
      $("changePasswordButton").hidden = false;
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
      $("changePasswordButton").hidden = false;
      $("authMessage").textContent = "帳號已建立並登入成功。";
      await refresh();
    }

    $("authForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      await signInWithPassword();
    });

    $("signUpButton").addEventListener("click", wrap(signUpWithPassword));

    $("resetPasswordButton").addEventListener("click", wrap(async () => {
      const email = $("emailInput").value.trim();
      if (!email) {
        $("authMessage").textContent = "請先輸入你的 Email。";
        $("emailInput").focus();
        return;
      }
      const redirectTo = `${window.location.origin}${window.location.pathname}`;
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw error;
      $("authMessage").textContent = "重設密碼信已寄出，請到信箱點連結後設定新密碼。";
    }));

    $("changePasswordButton").addEventListener("click", () => {
      $("appMenuBackdrop").hidden = true;
      enterPasswordRecoveryMode();
    });

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
    $("wishPurchaseList").addEventListener("click", wrap(async (event) => {
      const editId = event.target.closest("[data-edit-wish]")?.dataset.editWish;
      const deleteId = event.target.closest("[data-delete-wish]")?.dataset.deleteWish;
      if (editId) await editTransaction(editId);
      else if (deleteId) await deleteTransaction(deleteId);
    }));
    $("cardForm").addEventListener("submit", wrap(addCreditCard));
    $("openingBillForm").addEventListener("submit", wrap(addOpeningBill));
    $("installmentForm").addEventListener("submit", wrap(addInstallment));
    $("cardFeeForm").addEventListener("submit", wrap(addCardFee));
    $("accountForm").addEventListener("submit", wrap(addAccount));
    $("transferForm").addEventListener("submit", wrap(addTransfer));
    $("editForm").addEventListener("submit", wrap(saveEdit));
    $("emailCandidateForm").addEventListener("submit", wrap(importEmailCandidate));
    $("connectGmailButton").addEventListener("click", wrap(connectGmail));
    $("syncGmailButton").addEventListener("click", wrap(syncGmail));
    $("rerunGmailInboxButton").addEventListener("click", wrap(rerunGmailInbox));
    $("cancelEditButton").addEventListener("click", () => $("editDialog").close());
    $("closeSyncResultButton").addEventListener("click", () => $("syncResultDialog").close());
    $("backupButton").addEventListener("click", wrap(downloadBackup));
    $("historyButton").addEventListener("click", wrap(toggleHistory));
    $("enableNotificationsButton").addEventListener("click", wrap(enablePushNotifications));
    $("attentionList").addEventListener("click", (event) => {
      const type = event.target.closest("[data-attention-type]")?.dataset.attentionType;
      if (type === "card") document.querySelector('[data-panel="cardPanel"]')?.click();
      if (type === "reimbursement") showReimbursementDetails();
    });
    $("copyMotherRequestButton").addEventListener("click", wrap(copyMotherRequest));
    $("restoreInput").addEventListener("change", wrap(restoreBackup));
    $("emailCandidateList").addEventListener("click", wrap(async (event) => {
      const acceptId = event.target.closest("[data-accept-email-candidate]")?.dataset.acceptEmailCandidate;
      const skipId = event.target.closest("[data-skip-email-candidate]")?.dataset.skipEmailCandidate;
      if (acceptId) await acceptEmailCandidate(acceptId);
      if (skipId) await skipEmailCandidate(skipId);
    }));
    document.querySelectorAll("[data-expense-note]").forEach((button) => {
      button.addEventListener("click", () => {
        const input = $("expenseTitle");
        input.value = button.dataset.expenseNote || "";
        input.focus();
      });
    });
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
        const title = button.querySelector("strong")?.textContent.trim() || button.textContent.trim();
        openDetailView(button.dataset.panel, title);
        closeAppMenu();
      });
    });

    document.querySelectorAll(".panel-disclosure").forEach((disclosure) => {
      disclosure.addEventListener("toggle", () => {
        if (!disclosure.open) return;
        disclosure.parentElement?.querySelectorAll(":scope > .panel-disclosure").forEach((item) => {
          if (item !== disclosure) item.open = false;
        });
      });
    });

    $("detailBackButton").addEventListener("click", () => {
      if (detailHistoryActive) {
        window.history.back();
      } else {
        closeDetailView();
      }
    });

    window.addEventListener("popstate", () => {
      if (!detailHistoryActive) return;
      detailHistoryActive = false;
      closeDetailView();
    });

    $("recordList").addEventListener("click", wrap(async (event) => {
      const editId = event.target.dataset.edit;
      const deleteId = event.target.dataset.delete;
      if (editId) await editTransaction(editId);
      if (deleteId) await deleteTransaction(deleteId);
    }));

    $("allRecordList").addEventListener("click", wrap(async (event) => {
      const editId = event.target.closest("[data-edit]")?.dataset.edit;
      const deleteId = event.target.closest("[data-delete]")?.dataset.delete;
      const deleteIncomeId = event.target.closest("[data-delete-income]")?.dataset.deleteIncome;
      const receivedId = event.target.closest("[data-received]")?.dataset.received;
      const deleteReimbursementId = event.target.closest("[data-delete-reimbursement]")?.dataset.deleteReimbursement;
      const deleteTransferId = event.target.closest("[data-delete-transfer]")?.dataset.deleteTransfer;
      if (editId) await editTransaction(editId);
      else if (deleteId) await deleteTransaction(deleteId);
      else if (deleteIncomeId) await deleteIncome(deleteIncomeId);
      else if (receivedId) await markReceived(receivedId);
      else if (deleteReimbursementId) await deleteReimbursement(deleteReimbursementId);
      else if (deleteTransferId) await deleteTransfer(deleteTransferId);
    }));
    $("recordSearch").addEventListener("input", renderTransactions);
    $("recordTypeFilter").addEventListener("change", renderTransactions);

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
      const form = event?.target instanceof HTMLFormElement ? event.target : null;
      const submitter = event?.submitter || form?.querySelector("button[type=\"submit\"]");
      if (form?.dataset.submitting === "true") return;
      try {
        if (form) form.dataset.submitting = "true";
        if (submitter) submitter.disabled = true;
        await fn(event);
        if (submitter) submitter.disabled = false;
        if (form) delete form.dataset.submitting;
      } catch (error) {
        console.error(error);
        if (submitter) submitter.disabled = false;
        if (form) delete form.dataset.submitting;
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
    $("bootTitle").textContent = "Left. 暫時無法載入";
    $("bootText").textContent = error.message || "請按下方按鈕重新載入。";
    $("bootReloadButton").hidden = false;
    setVisible("bootPanel", true);
    showToast("初始化失敗，請檢查 Supabase 設定");
  });
})();
