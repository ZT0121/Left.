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

// Each card stays on its first unentered statement, advancing only on an actual bill.
const groupStart = source.indexOf('  function getEstimatedStatementGroups()');
const groupEnd = source.indexOf('\n  function ', groupStart + 1);
vm.runInContext(source.slice(groupStart, groupEnd), context);
context.isActualStatement = r => r.source_type === 'opening_bill';
context.isEstimatedCardCharge = r => r.source_type === 'subscription';
context.cardStatementKey = r => `${r.card_id}:${r.charge_date.slice(0,7)}`;
context.getEffectiveCardChargeDueDate = r => r.due_date;
context.uniqueCardEstimateItems = r => r;
context.getUpcomingInstallmentEstimateRows = () => [];
context.getSubscriptionCardEstimateRows = () => [
  {card_id:'taishin', charge_date:'2026-09-05', due_date:'2026-09-22', source_type:'subscription',amount:500},
  {card_id:'taishin', charge_date:'2026-10-05', due_date:'2026-10-22', source_type:'subscription',amount:500},
  {card_id:'ctbc', charge_date:'2026-09-18', due_date:'2026-10-03', source_type:'subscription',amount:700},
  {card_id:'ctbc', charge_date:'2026-10-18', due_date:'2026-11-03', source_type:'subscription',amount:700}
];
context.state.cardCharges = [];
assert.deepEqual(Array.from(context.getEstimatedStatementGroups(),r=>r.due_date),['2026-09-22','2026-10-03']);
context.state.cardCharges = [{card_id:'taishin',charge_date:'2026-09-05',due_date:'2026-09-22',source_type:'opening_bill',status:'pending'}];
assert.deepEqual(Array.from(context.getEstimatedStatementGroups(),r=>r.due_date),['2026-10-03','2026-10-22']);
context.state.cardCharges[0].status='paid';
assert.deepEqual(Array.from(context.getEstimatedStatementGroups(),r=>r.due_date),['2026-10-03','2026-10-22']);
console.log('one upcoming estimate per card checks passed');

// A list container stores the active tab too; only tab buttons may trigger a rerender.
const listenerStart = source.indexOf('    $("cardChargeList").addEventListener("click", wrap(async (event) => {');
const listenerEnd = source.indexOf('\n    }));', listenerStart) + '\n    }));'.length;
let onCardClick;
let rerenders = 0;
const clickContext = {
  $: () => ({dataset:{cardStatementTab:'estimate'}, addEventListener: (_, handler) => {onCardClick=handler;}}),
  wrap: fn => fn,
  renderCardCharges: () => {rerenders++;}
};
vm.createContext(clickContext);
vm.runInContext(source.slice(listenerStart, listenerEnd), clickContext);
(async () => {
  await onCardClick({target:{closest: selector => selector === '[data-card-statement-tab]' ? {dataset:{cardStatementTab:'estimate'}} : null}});
  assert.equal(rerenders,0,'Clicking a summary must not redraw the list');
  await onCardClick({target:{closest: selector => selector.includes('data-card-statement-tab') ? {dataset:{cardStatementTab:'paid'}} : null}});
  assert.equal(rerenders,1,'Clicking a tab button must switch tabs');
  console.log('statement disclosure click regression checks passed');
})().catch(error => {console.error(error);process.exitCode=1;});

// Posting dates determine the statement; its actual due date can vary each month.
{
  const names = ['getInstallmentStatementSchedule', 'getCardClosingDate', 'getCardDueDate'];
  const code = names.map(name => {
    const start = source.indexOf(`  function ${name}(`);
    return source.slice(start, source.indexOf('\n  function ', start + 1));
  }).join('\n');
  const testContext = {
    window: {LeftBudget: require('../js/budget.js')},
    state: {creditCards:[{id:'dbs',closing_day:6,payment_day:24}],cardCharges:[
      {card_id:'dbs',source_type:'opening_bill',charge_date:'2026-04-06',due_date:'2026-04-24'},
      {card_id:'dbs',source_type:'opening_bill',charge_date:'2026-09-03',due_date:'2026-09-21'}
    ]},
    isActualStatement:r=>r.source_type==='opening_bill',getCardStatementDate:r=>r.charge_date,
    parseLocalDate:context.parseLocalDate,formatDate:context.formatDate
  };
  vm.createContext(testContext);vm.runInContext(code,testContext);
  const schedule=testContext.getInstallmentStatementSchedule({card_id:'dbs',first_due_date:'2026-04-02',total_amount:13000,installment_count:6});
  assert.equal(schedule[0].charge_date,'2026-04-02');
  assert.equal(schedule[0].due_date,'2026-04-24');
  assert.equal(schedule[5].charge_date,'2026-09-02');
  assert.equal(schedule[5].due_date,'2026-09-21');
  assert.equal(schedule[5].amount+497,2663);
  assert.equal(schedule.length,6);
  console.log('installment posting dates and variable bill deadlines passed');
}

// Actual statement cutoffs override the configured day for every estimate source.
{
  const names = ['getCardClosingDate', 'getCardDueDate', 'getCardStatementDate',
    'shouldDeriveStatementDate', 'cardStatementKey', 'getEstimateItemsForActual',
    'getEstimateFor', 'getEstimatedStatementGroups', 'getEffectiveCardChargeDueDate'];
  const code = names.map(name => {
    const start = source.indexOf(`  function ${name}(`);
    return source.slice(start, source.indexOf('\n  function ', start + 1));
  }).join('\n');
  const actual = {card_id:'cube',source_type:'opening_bill',charge_date:'2026-09-10',due_date:'2026-09-26'};
  const charges = ['general','advance','subscription','installment'].flatMap(source_type =>
    ['2026-08-13','2026-09-09','2026-09-10','2026-09-11','2026-09-12'].map(charge_date =>
      ({card_id:'cube',source_type,charge_date,due_date:'2026-09-26',amount:100})));
  const ctx = {
    state:{creditCards:[{id:'cube',closing_day:15,payment_day:26}],cardCharges:[actual,...charges]},
    parseLocalDate:context.parseLocalDate,formatDate:context.formatDate,toNumber:Number,
    isActualStatement:r=>r.source_type==='opening_bill',
    isEstimatedCardCharge:r=>r.source_type!=='opening_bill',
    uniqueCardEstimateItems:r=>r,
    getSubscriptionCardEstimateRows:()=>[], getUpcomingInstallmentEstimateRows:()=>[]
  };
  vm.createContext(ctx);vm.runInContext(code,ctx);
  assert.equal(ctx.getCardClosingDate('cube','2026-09-12'),'2026-10-15');
  assert.equal(ctx.getCardDueDate('cube','2026-09-12'),'2026-10-26');
  assert.equal(ctx.getEstimateItemsForActual(actual).length,8);
  assert.equal(ctx.getEstimateFor('cube','2026-09-26'),800);
  const groups = ctx.getEstimatedStatementGroups();
  assert.equal(groups.length,1);
  assert.equal(groups[0].due_date,'2026-10-26');
  assert.equal(groups[0].amount,800);
  // A later actual cutoff also includes purchases after the usual closing day.
  ctx.state.creditCards[0].closing_day=5;
  assert.equal(ctx.getCardClosingDate('cube','2026-09-09'),'2026-09-10');
  assert.equal(ctx.getCardDueDate('cube','2026-09-09'),'2026-09-26');
  ctx.state.cardCharges=[];
  ctx.state.creditCards[0].closing_day=10;
  assert.equal(ctx.getCardClosingDate('cube','2026-12-12'),'2027-01-10');
  assert.equal(ctx.getCardDueDate('cube','2026-12-12'),'2027-01-26');
  ctx.state.creditCards[0].closing_day=31;
  assert.equal(ctx.getCardClosingDate('cube','2026-02-28'),'2026-02-28');
  console.log('actual statement cutoff and next-period estimate regression checks passed');
}

vm.runInContext(functions, context);
context.currentMonth = () => '2026-09';
context.state.creditCards = [{id:'taishin', closing_day:5, payment_day:22}];
context.state.subscriptions = [{id:'fixed', amount:500, charge_day:10, payment_method:'credit_card', credit_card_id:'taishin'}];
context.state.subscriptions[0].billing_cycle = 'quarterly';
context.state.subscriptions[0].charge_month = 11;
assert.deepEqual(Array.from(context.getSubscriptionCardEstimateRows(), r => r.due_date), ['2026-09-22']);
assert.equal(context.isSubscriptionDueInMonth(context.state.subscriptions[0], '2027-02'), true);
assert.equal(context.isSubscriptionDueInMonth(context.state.subscriptions[0], '2027-03'), false);
context.state.subscriptions[0].is_active = false;
assert.equal(context.getSubscriptionCardEstimateRows().length, 0);
