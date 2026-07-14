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
    ...overrides
  }, { today: "2026-08-01" });
}

{
  const result = summarize({
    transactions: [
      { kind: "expense", amount: 300, payment_method: "credit_card" }
    ],
    cardCharges: [
      { source_type: "general", amount: 300, status: "pending" }
    ]
  });

  assert.equal(result.spent, 300);
  assert.equal(result.cardDue, 300);
  assert.equal(result.projected, 51700);
}

{
  const result = summarize({
    transactions: [
      { kind: "expense", amount: 300, payment_method: "credit_card" }
    ],
    cardCharges: [
      { source_type: "general", amount: 300, status: "paid", paid_at: "2026-08-15" }
    ]
  });

  assert.equal(result.spent, 300);
  assert.equal(result.cardDue, 0);
  assert.equal(result.projected, 51700);
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

console.log("budget tests passed");
