const fs = require('fs');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = fs.readFileSync('js/app.js', 'utf8');
const names = ['dateForMonthDay', 'isSubscriptionDueInMonth', 'getSubscriptionCardEstimateRows', 'getCardClosingDate', 'getCardDueDate', 'renderCardCharges'];
const functions = names.map(name => {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf('\n  function ', start + 1);
  return source.slice(start, end);
}).join('\n');
const list = { dataset: {}, innerHTML: '' };
const context = {
  state: { creditCards: [{id: 'taishin', closing_day: 5, payment_day: 22}], subscriptions: [{ id:'fixed', title:'固定扣款', amount:500, charge_day:10, payment_method:'credit_card', credit_card_id:'taishin' }] },
  currentMonth: () => '2026-09',
  formatDate: d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,
  parseLocalDate: s => new Date(`${s}T00:00:00`), toNumber: Number,
  $: () => list, cardDisplayName: () => '台新', money: String, escapeHtml: String,
  isActualStatement: () => false,
  getCardStatementRows: () => [ {id:'sept', row_type:'actual', status:'pending', amount:500}, {id:'paid', row_type:'actual', status:'paid', amount:600}, {row_type:'estimate', amount:700} ]
};
vm.createContext(context); vm.runInContext(functions,context);
const estimates = context.getSubscriptionCardEstimateRows();
assert.deepEqual(Array.from(estimates, r=>r.due_date).sort(), ['2026-09-22','2026-10-22']);
context.state.subscriptions[0].is_active=false;
assert.equal(context.getSubscriptionCardEstimateRows().length,0);
context.state.subscriptions[0].is_active=true;
context.state.subscriptions[0].billing_cycle='yearly'; context.state.subscriptions[0].charge_month=8;
assert.deepEqual(Array.from(context.getSubscriptionCardEstimateRows(),r=>r.due_date),['2026-09-22']);
context.renderCardCharges();
assert.ok(list.innerHTML.includes('data-pay-card-charge="sept"'));
assert.ok(!list.innerHTML.includes('data-edit-card-charge="paid"'));
assert.ok(list.innerHTML.includes('待繳</span>'));
list.dataset.cardStatementTab='paid'; context.renderCardCharges();
assert.ok(list.innerHTML.includes('data-edit-card-charge="paid"'));
assert.ok(!list.innerHTML.includes('data-pay-card-charge='));
assert.ok(list.innerHTML.includes('已繳清</span>'));
list.dataset.cardStatementTab='estimate'; context.renderCardCharges();
assert.ok(list.innerHTML.includes('預估</span>'));
assert.ok(!list.innerHTML.includes('data-pay-card-charge='));
console.log('statement rendering and cross-month subscription checks passed');
