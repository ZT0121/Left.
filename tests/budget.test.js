const assert = require("node:assert/strict");
const budget = require("../js/budget.js");

const cycle = {
  start_date: "2026-07-31",
  expected_pay_date: "2026-08-31",
  salary_income: 32000,
  mother_support: 20000,
  minimum_savings: 5000
};

function summarize(overrides = {}) {
  return budget.summarizeBudget({
    cycle,
    transactions: [],
    reimbursements: [],
    cardCharges: [],
    installmentPlans: [],
    subscriptions: [],
    ...overrides
  }, { today: "2026-08-01", currentMonth: "2026-08" });
}

{
  const result = summarize({
    transactions: [
      { kind: "expense", amount: 300, payment_method: "credit_card" }
    ],
    cardCharges: [
      { source_type: "general", amount: 300, status: "pending", card_id: "card-1", due_date: "2026-08-15" }
    ]
  });

  assert.equal(result.spent, 300);
  assert.equal(result.cardDue, 300);
  assert.equal(result.cardDueActual, 0);
  assert.equal(result.cardDueEstimate, 300);
  assert.equal(result.projected, 51700);
}

{
  const result = summarize({
    transactions: [
      { kind: "expense", amount: 300, payment_method: "credit_card" }
    ],
    cardCharges: [
      { source_type: "general", amount: 300, status: "paid", paid_at: "2026-08-15", card_id: "card-1", due_date: "2026-08-15" }
    ]
  });

  assert.equal(result.spent, 300);
  assert.equal(result.cardDue, 0);
  assert.equal(result.projected, 51700);
}

{
  const result = summarize({
    cardCharges: [
      { source_type: "subscription", amount: 149, status: "pending", card_id: "card-1", due_date: "2026-08-15" }
    ]
  });

  assert.equal(result.cardDue, 149);
  assert.equal(result.cardDueActual, 0);
  assert.equal(result.cardDueEstimate, 149);
}

{
  const result = summarize({
    transactions: [
      { kind: "expense", amount: 500, payment_method: "credit_card" },
      { kind: "opening_card_bill", amount: 480 }
    ],
    cardCharges: [
      { source_type: "general", amount: 300, status: "pending", card_id: "card-1", due_date: "2026-08-15" },
      { source_type: "advance", amount: 200, status: "pending", card_id: "card-1", due_date: "2026-08-15" },
      { source_type: "installment", amount: 100, status: "pending", card_id: "card-1", due_date: "2026-08-15" },
      { source_type: "opening_bill", amount: 480, status: "pending", card_id: "card-1", due_date: "2026-08-15" }
    ]
  });

  assert.equal(result.cardDue, 480);
  assert.equal(result.cardDueActual, 480);
  assert.equal(result.cardDueEstimate, 0);
  assert.equal(result.projected, 51020);
}

{
  const result = summarize({
    transactions: [
      { kind: "expense", amount: 500, payment_method: "credit_card" },
      { kind: "opening_card_bill", amount: 480 }
    ],
    cardCharges: [
      { source_type: "general", amount: 500, status: "pending", card_id: "card-1", due_date: "2026-08-08" },
      { source_type: "opening_bill", amount: 480, status: "pending", card_id: "card-1", due_date: "2026-08-23" }
    ]
  });

  assert.equal(result.cardDue, 480);
  assert.equal(result.cardDueActual, 480);
  assert.equal(result.cardDueEstimate, 0);
}

{
  const result = summarize({
    transactions: [
      { kind: "expense", amount: 1664, payment_method: "credit_card" },
      { kind: "opening_card_bill", amount: 1664 }
    ],
    cardCharges: [
      { source_type: "general", amount: 1664, status: "pending", card_id: "card-1", charge_date: "2026-07-09", due_date: "2026-07-09" },
      { source_type: "opening_bill", amount: 1664, status: "pending", card_id: "card-1", charge_date: "2026-07-15", due_date: "2026-08-03" }
    ]
  });

  assert.equal(result.cardDue, 1664);
  assert.equal(result.cardDueActual, 1664);
  assert.equal(result.cardDueEstimate, 0);
}

{
  const result = summarize({
    transactions: [
      { kind: "expense", amount: 500, payment_method: "credit_card" },
      { kind: "opening_card_bill", amount: 480 }
    ],
    cardCharges: [
      { source_type: "general", amount: 300, status: "pending", card_id: "card-1", due_date: "2026-08-15" },
      { source_type: "advance", amount: 200, status: "pending", card_id: "card-1", due_date: "2026-08-15" },
      { source_type: "installment", amount: 100, status: "pending", card_id: "card-1", due_date: "2026-08-15" },
      { source_type: "opening_bill", amount: 480, status: "paid", paid_at: "2026-08-10", card_id: "card-1", due_date: "2026-08-15" }
    ]
  });

  assert.equal(result.cardDue, 0);
  assert.equal(result.cardDueActual, 0);
  assert.equal(result.cardDueEstimate, 0);
  assert.equal(result.projected, 51020);
}

{
  const plan = {
    id: "plan-1",
    title: "手機",
    total_amount: 12000,
    fee_total: 0,
    installment_count: 6,
    first_due_date: "2026-08-15",
    is_active: true
  };
  const result = summarize({
    transactions: [
      { kind: "installment", amount: 2000, installment_plan_id: "plan-1" }
    ],
    cardCharges: [
      { source_type: "installment", amount: 2000, status: "pending", installment_plan_id: "plan-1", installment_number: 1 }
    ],
    installmentPlans: [plan]
  });

  assert.equal(result.spent, 2000);
  assert.equal(result.cardDue, 2000);
  assert.equal(result.futureInstallmentBalance, 10000);
  assert.equal(result.commitmentBuffer, 35000);
}

{
  const result = summarize({
    subscriptions: [
      { title: "iCloud", amount: 90, is_active: true },
      { title: "Spotify", amount: 149, is_active: true },
      { title: "Disney+", amount: 2790, is_active: true, billing_cycle: "yearly", charge_month: 8 },
      { title: "Domain", amount: 1200, is_active: true, billing_cycle: "yearly", charge_month: 9 },
      { title: "Paused", amount: 500, is_active: false }
    ]
  });

  assert.equal(result.subscriptionEstimate, 3029);
  assert.equal(result.projected, 48971);
}

{
  const result = summarize({
    transactions: [
      { kind: "opening_card_bill", amount: 18500 }
    ],
    cardCharges: [
      { source_type: "opening_bill", amount: 18500, status: "pending" }
    ]
  });

  assert.equal(result.spent, 18500);
  assert.equal(result.cardDue, 18500);
  assert.equal(result.futureInstallmentBalance, 0);
}

{
  const result = summarize({
    transactions: [
      { kind: "advance", amount: 300, gross_amount: 900, payment_method: "credit_card" }
    ],
    reimbursements: [
      { amount: 600, status: "pending" }
    ],
    cardCharges: [
      { source_type: "advance", amount: 900, status: "pending" }
    ]
  });

  assert.equal(result.spent, 300);
  assert.equal(result.pending, 600);
  assert.equal(result.cardDue, 900);
  assert.equal(result.projected, 51700);
}

{
  const result = summarize({
    transactions: [
      { kind: "opening_card_bill", amount: 28000 }
    ],
    reimbursements: [
      { amount: 14000, status: "received", transaction_id: null }
    ]
  });

  assert.equal(result.spent, 28000);
  assert.equal(result.projected, 38000);
}

{
  const result = summarize({
    transactions: [
      { id: "tx-1", kind: "advance", amount: 300, gross_amount: 900 }
    ],
    reimbursements: [
      { amount: 600, status: "received", transaction_id: "tx-1" }
    ]
  });

  assert.equal(result.spent, 300);
  assert.equal(result.projected, 51700);
}

{
  const balances = budget.calculateAccountBalances({
    accounts: [
      { id: "bank", name: "銀行", opening_balance: 1000 },
      { id: "jkopay", name: "街口支付", opening_balance: 0 }
    ],
    incomeRecords: [
      { account_id: "bank", amount: 32000 }
    ],
    accountTransfers: [
      { from_account_id: "bank", to_account_id: "jkopay", amount: 500 }
    ],
    transactions: [
      { account_id: "jkopay", payment_method: "cash", amount: 80, gross_amount: 80 }
    ]
  });

  assert.equal(balances.find((row) => row.id === "bank").balance, 32500);
  assert.equal(balances.find((row) => row.id === "jkopay").balance, 420);
}

{
  const result = summarize({
    incomeRecords: [
      { amount: 32000 },
      { amount: 20000 }
    ]
  });

  assert.equal(result.totalIncome, 104000);
  assert.equal(result.projected, 104000);
}

{
  const result = budget.calculateMotherRequest({
    cycle,
    reimbursements: [
      { amount: 600, status: "pending" },
      { amount: 300, status: "received" }
    ]
  });

  assert.equal(result.support, 20000);
  assert.equal(result.pending, 600);
  assert.equal(result.total, 20600);
}

console.log("budget tests passed");
