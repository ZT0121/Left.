const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('js/app.js', 'utf8');
const code = ['resetCreditCardForm','editCreditCard','addCreditCard'].map(name => {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  const rest = source.slice(start + 1);
  const end = rest.search(/\n  (?:async )?function /);
  return source.slice(start, start + 1 + end);
}).join('\n');
const summary = {};
const details = {querySelector:()=>summary};
const fields = Object.fromEntries(['cardName','cardClosingDay','cardPaymentDay','cardSubmitButton','cancelCardEdit'].map(id=>[id,{value:'',focus(){}}]));
fields.cardForm = {dataset:{},reset(){},closest:()=>details,scrollIntoView(){}};
let payload, filters, refreshed=0, failure=null;
const context = {
  state:{user:{id:'user'},creditCards:[{id:'cube',name:'Cube',closing_day:15,payment_day:26,is_active:false}]},
  $:id=>fields[id],toNumber:Number,showToast(){},refresh:async()=>{refreshed++;},
  client:{from:()=>({update(values){payload=values;filters=[];return {
    eq(key,value){filters.push([key,value]);return this;},select(){return this;},
    async single(){return {error:failure};}
  };}})}
};
vm.createContext(context);vm.runInContext(code,context);
(async()=>{
  context.editCreditCard('cube');
  assert.equal(fields.cardClosingDay.value,15);
  assert.equal(fields.cardForm.dataset.editCardId,'cube');
  assert.equal(details.open,true);
  fields.cardClosingDay.value='10';
  await context.addCreditCard({preventDefault(){},target:fields.cardForm});
  assert.equal(payload.closing_day,10);
  assert.equal(payload.payment_day,26);
  assert.equal('is_active' in payload,false);
  assert.deepEqual(filters,[['id','cube'],['user_id','user']]);
  assert.equal(refreshed,1);
  assert.equal(fields.cardForm.dataset.editCardId,undefined);
  context.editCreditCard('cube');
  fields.cardClosingDay.value='32';
  await assert.rejects(context.addCreditCard({preventDefault(){},target:fields.cardForm}));
  fields.cardClosingDay.value='10';failure=new Error('save failed');
  await assert.rejects(context.addCreditCard({preventDefault(){},target:fields.cardForm}));
  assert.equal(fields.cardForm.dataset.editCardId,'cube');
  assert.equal(refreshed,1);
  context.resetCreditCardForm();
  assert.equal(fields.cancelCardEdit.hidden,true);
  console.log('card editing, scoped update, validation, cancellation and failure checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
