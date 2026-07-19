(function (root) {
  const DAY_MS = 86400000;

  function toNumber(value) {
    return Number(value || 0);
  }

  function parseDate(value) {
    return new Date(`${value}T00:00:00`);
  }

  function addMonths(dateValue, months) {
    const date = parseDate(dateValue);
    const day = date.getDate();
    const next = new Date(date);
    next.setMonth(next.getMonth() + months, 1);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, lastDay));
    return next.toISOString().slice(0, 10);
  }

  function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function getCardClosingDate(cards, cardId, chargeDate) {
    const card = (cards || []).find((item) => item.id === cardId);
    if (!card || !chargeDate) return chargeDate;
    const date = parseDate(chargeDate);
    let closingMonth = date.getMonth();
    let closingYear = date.getFullYear();
    if (date.getDate() > Number(card.closing_day)) {
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

  function daysBetween(from, to) {
    const start = parseDate(from);
    const end = parseDate(to);
    return Math.max(0, Math.ceil((end - start) / DAY_MS));
  }

  function isDateInCycle(dateValue, cycle) {
    return Boolean(
      cycle
      && dateValue
      && dateValue >= cycle.start_date
      && dateValue <= cycle.expected_pay_date
    );
  }

  function isSubscriptionDueInMonth(row, month) {
    if (row.is_active === false) return false;
    if ((row.billing_cycle || "monthly") !== "yearly") return true;
    return Number(row.charge_month) === Number(String(month).slice(5, 7));
  }

  function createInstallmentSchedule(plan) {
    const count = Math.max(1, Math.trunc(toNumber(plan.installment_count)));
    const totalWithFees = toNumber(plan.total_amount) + toNumber(plan.fee_total);
    const base = Math.floor(totalWithFees / count);
    const finalAmount = totalWithFees - (base * (count - 1));

    return Array.from({ length: count }, (_, index) => ({
      installment_number: index + 1,
      due_date: addMonths(plan.first_due_date, index),
      amount: index === count - 1 ? finalAmount : base
    }));
  }

  function summarizeBudget(input, extra = {}) {
    const cycle = input.cycle;
    if (!cycle) {
      return {
        totalIncome: 0,
        spent: 0,
        pending: 0,
        projected: 0,
        cashBuffer: 0,
        commitmentBuffer: 0,
        daysLeft: 0,
        daily: 0,
        cardDue: 0,
        cardDueActual: 0,
        cardDueEstimate: 0,
        futureInstallmentBalance: 0,
        subscriptionEstimate: 0
      };
    }

    const transactions = input.transactions || [];
    const reimbursements = input.reimbursements || [];
    const cardCharges = input.cardCharges || [];
    const creditCards = input.creditCards || [];
    const installmentPlans = input.installmentPlans || [];
    const incomeRecords = input.incomeRecords || [];
    const subscriptions = input.subscriptions || [];
    const today = extra.today || new Date().toISOString().slice(0, 10);
    const currentMonth = extra.currentMonth || today.slice(0, 7);

    const recordedIncome = incomeRecords.reduce((sum, row) => sum + toNumber(row.amount), 0);
    const totalIncome = toNumber(cycle.salary_income) + toNumber(cycle.mother_support) + recordedIncome;
    const spent = transactions.reduce((sum, row) => sum + toNumber(row.amount), 0) + toNumber(extra.spend);
    const subscriptionEstimate = subscriptions
      .filter((row) => isSubscriptionDueInMonth(row, currentMonth))
      .reduce((sum, row) => sum + toNumber(row.amount), 0);
    const pending = reimbursements
      .filter((row) => row.status === "pending")
      .reduce((sum, row) => sum + toNumber(row.amount), 0);
    const receivedManualReimbursements = reimbursements
      .filter((row) => row.status === "received" && !row.transaction_id)
      .reduce((sum, row) => sum + toNumber(row.amount), 0);
    const shouldDeriveStatementDate = (row) => row.source_type === "general" || row.source_type === "advance" || row.source_type === "subscription";
    const statementKey = (row) => {
      const statementDate = row.card_id && row.charge_date && shouldDeriveStatementDate(row)
        ? getCardClosingDate(creditCards, row.card_id, row.charge_date)
        : row.charge_date || row.due_date;
      return row.card_id && statementDate ? `${row.card_id}:${String(statementDate).slice(0, 7)}` : "";
    };
    const actualStatementKeys = new Set(
      cardCharges
        .filter((row) => row.source_type === "opening_bill")
        .map(statementKey)
        .filter(Boolean)
    );
    const payableCardCharges = cardCharges
      .filter((row) => row.status !== "paid")
      .filter((row) => {
        const isEstimate = row.source_type === "general" || row.source_type === "advance" || row.source_type === "installment" || row.source_type === "subscription";
        return !isEstimate || !actualStatementKeys.has(statementKey(row));
      });
    const cardDueActual = payableCardCharges
      .filter((row) => row.source_type !== "general" && row.source_type !== "advance" && row.source_type !== "installment" && row.source_type !== "subscription")
      .reduce((sum, row) => sum + toNumber(row.amount), 0);
    const cardDueEstimate = payableCardCharges
      .filter((row) => row.source_type === "general" || row.source_type === "advance" || row.source_type === "installment" || row.source_type === "subscription")
      .reduce((sum, row) => sum + toNumber(row.amount), 0);
    const cardDue = cardDueActual + cardDueEstimate;

    const futureInstallmentBalance = installmentPlans
      .filter((plan) => plan.is_active !== false)
      .reduce((sum, plan) => {
        const paidNumbers = new Set(
          cardCharges
            .filter((charge) => charge.installment_plan_id === plan.id)
            .map((charge) => Number(charge.installment_number))
        );
        const futureAmount = createInstallmentSchedule(plan)
          .filter((item) => {
            if (paidNumbers.has(item.installment_number)) return false;
            if (isDateInCycle(item.due_date, cycle)) return false;
            return item.due_date > cycle.expected_pay_date;
          })
          .reduce((subtotal, item) => subtotal + toNumber(item.amount), 0);
        return sum + futureAmount;
      }, 0) + toNumber(extra.futureCommitment);

    const projected = totalIncome + receivedManualReimbursements - spent - subscriptionEstimate;
    const cashBuffer = projected - toNumber(cycle.minimum_savings);
    const commitmentBuffer = cashBuffer - futureInstallmentBalance;
    const daysLeft = daysBetween(today, cycle.expected_pay_date);
    const daily = daysLeft > 0 ? Math.max(0, Math.floor(cashBuffer / daysLeft)) : Math.max(0, cashBuffer);

    return {
      totalIncome,
      spent,
      pending,
      projected,
      cashBuffer,
      commitmentBuffer,
      daysLeft,
      daily,
      cardDue,
      cardDueActual,
      cardDueEstimate,
      futureInstallmentBalance,
      subscriptionEstimate
    };
  }

  function calculateAccountBalances(input) {
    const accounts = input.accounts || [];
    const transfers = input.accountTransfers || [];
    const transactions = input.transactions || [];
    const incomeRecords = input.incomeRecords || [];

    return accounts.map((account) => {
      const opening = toNumber(account.opening_balance);
      const balanceDate = account.balance_date || "";
      const isOnOrAfterBalanceDate = (row) => !balanceDate || !row.date || row.date >= balanceDate;
      const income = incomeRecords
        .filter((row) => row.account_id === account.id && isOnOrAfterBalanceDate(row))
        .reduce((sum, row) => sum + toNumber(row.amount), 0);
      const transferIn = transfers
        .filter((row) => row.to_account_id === account.id && isOnOrAfterBalanceDate(row))
        .reduce((sum, row) => sum + toNumber(row.amount), 0);
      const transferOut = transfers
        .filter((row) => row.from_account_id === account.id && isOnOrAfterBalanceDate(row))
        .reduce((sum, row) => sum + toNumber(row.amount), 0);
      const spent = transactions
        .filter((row) => (
          row.account_id === account.id
          && row.payment_method !== "credit_card"
          && isOnOrAfterBalanceDate(row)
        ))
        .reduce((sum, row) => sum + toNumber(row.gross_amount || row.amount), 0);

      return {
        ...account,
        balance: opening + income + transferIn - transferOut - spent
      };
    });
  }

  function calculateMotherRequest(input) {
    const cycle = input.cycle || {};
    const reimbursements = input.reimbursements || [];
    const support = toNumber(cycle.mother_support);
    const pending = reimbursements
      .filter((row) => row.status === "pending")
      .reduce((sum, row) => sum + toNumber(row.amount), 0);

    return {
      support,
      pending,
      total: support + pending
    };
  }

  root.LeftBudget = {
    addMonths,
    calculateAccountBalances,
    calculateMotherRequest,
    createInstallmentSchedule,
    daysBetween,
    isDateInCycle,
    summarizeBudget,
    toNumber
  };

  if (typeof module !== "undefined") {
    module.exports = root.LeftBudget;
  }
})(typeof window !== "undefined" ? window : globalThis);
