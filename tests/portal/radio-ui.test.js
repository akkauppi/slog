import test from 'node:test';
import assert from 'node:assert/strict';
import {RadioWorkspace} from '../../portal/js/radio-ui.js';

function fixture(lines=[]) {
 const elements=new Map();
 const element=id=>{
  if(!elements.has(id)) elements.set(id,{value:'',checked:false,disabled:false,hidden:false,textContent:'',
   addEventListener(){},setAttribute(){},querySelectorAll(){return [...elements.values()];}});
  return elements.get(id);
 };
 const writes=[];
 const transport={isOpen:true,runExclusive:f=>f(),drainInputUntilQuiet:async()=>{},writeLine:async line=>writes.push(line),
  readRecord:async()=>{if(!lines.length)throw new Error('No scripted response');return {line:lines.shift()};}};
 const busy=[];
 const ui=new RadioWorkspace({document:{getElementById:element},connectBoard:async()=>transport,
  getTransport:()=>transport,disconnectBoard:async()=>{transport.isOpen=false;ui.handleConnectionClosed();},
  onBusyChange:()=>busy.push(ui.busy)});
 return {ui,transport,writes,busy,element};
}

test('radio UI reuses supplied connection and distinguishes standby from failure',async()=>{
 const {ui,writes,element}=fixture([
  'RADIO_STATUS protocol=1 role=logger mac=020000000001 sleeping=1 active=1 fault=0 restart_required=0',
  'POWER_STATUS mode=normal state=standby sample_ms=150000 heartbeat_ms=900000',
 ]);
 await ui.run(()=>ui.status());
 assert.deepEqual(writes,['RADIO STATUS','POWER STATUS']);
 assert.match(element('radio-health').textContent,/Sleeping between cold heartbeats/);
 assert.equal(element('radio-power-controls').hidden,false);
 assert.equal(element('radio-power-wake').disabled,false);
 assert.equal(element('radio-apply').disabled,true);
 ui.handleConnectionClosed();
 assert.equal(element('radio-power-controls').hidden,true);
 assert.equal(element('radio-reboot').disabled,true);
});

test('receiver connection reads receiver status without sending logger power commands',async()=>{
 const {ui,writes,element}=fixture([
  'RADIO_STATUS protocol=1 role=receiver mac=020000000002 active=1 fault=0 restart_required=0',
  'RECEIVER_STATUS received=10 age_ms=100',
 ]);
 await ui.run(()=>ui.status());
 assert.deepEqual(writes,['RADIO STATUS','RECEIVER STATUS']);
 assert.equal(element('radio-power-controls').hidden,true);
 assert.match(element('radio-board').textContent,/Receiver/);
});

test('radio operation participates in portal busy guard and releases it on failure',async()=>{
 const {ui,busy,element}=fixture();
 await ui.run(async()=>{assert.equal(ui.busy,true);throw new Error('USB lost');});
 assert.deepEqual(busy,[true,false]);
 assert.match(element('radio-message').textContent,/USB lost/);
 assert.equal(ui.busy,false);
});
