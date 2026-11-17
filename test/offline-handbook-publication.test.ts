import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlState } from '../src/control/state.js';
import { members, developmentGrants, DEV, fixtureSources } from '../src/dev-fixture.js';
import { decideParticipation } from '../src/participation.js';
import { OfflineHandbookPublisher, OFFLINE_HANDBOOK_SOURCE } from '../src/control/offline-handbook.js';
import type { OfflinePreparationDependencies } from '../src/research/handbook-preparation.js';
function setup() {
  const scope = { conversationId: DEV.conversationId, threadId: DEV.threadId };
  const state = new ControlState({ members: structuredClone(members), grants: developmentGrants(), tokens: {},
    memberships: { alex: [scope], sam: [scope] }, researchMemberId: 'sam', sources: [...fixtureSources, {...OFFLINE_HANDBOOK_SOURCE}] });
  const {message} = state.createMessage('alex', scope, '比较一下 type 和 interface，给我两点摘要', crypto.randomUUID());
  assert.equal(decideParticipation(message,'human').participate,true);
  const {run} = state.claim('sam', message.id);
  let modelCalls = 0;
  const deps: Omit<OfflinePreparationDependencies,'assertCurrent'> = {
    mode:'offline-fixture',
    transport: { resolveIPv4:async()=>['93.184.215.14'],openPinned:async()=>({
      status:200,headers:{'content-type':'text/plain; charset=utf-8'},
      body:(async function*(){yield Buffer.from(OFFLINE_HANDBOOK_SOURCE.excerpt);})(),close(){} })},
    extractText:text=>text,
    model:async input=>{modelCalls++;return {conclusion:'2 点模拟摘要：1. type 可描述联合类型；2. interface 描述对象形状。',
      claims:[{receiptId:input.receiptId,excerpt:input.text}]};},
  };
  return {state,scope,message,run,deps,calls:()=>modelCalls};
}
test('natural chat → background mock → atomic original-thread synthetic publication',async()=>{
  const s=setup();const bridge=new OfflineHandbookPublisher(s.state,s.deps);
  const result=await bridge.publish('sam',s.run.id);
  assert.equal(result.message.conversationId,s.scope.conversationId);
  assert.equal(result.message.threadId,s.scope.threadId);
  assert.equal(result.message.sourceMessageId,s.message.id);
  assert.match(result.message.text,/2 点模拟摘要/);
  assert.equal(result.message.result!.evidence,'synthetic-fixture');
  assert.deepEqual(result.message.result!.sources,[OFFLINE_HANDBOOK_SOURCE]);
  assert.equal(result.message.result!.sources[0]!.url.startsWith('https://fixtures.invalid/'),true);
  assert.equal(s.run.receiptId,result.receiptId);
});
test('concurrent duplicate and later retry share preparation and publication',async()=>{
  const s=setup();const bridge=new OfflineHandbookPublisher(s.state,s.deps);
  const [a,b]=await Promise.all([bridge.publish('sam',s.run.id),bridge.publish('sam',s.run.id)]);
  const c=await bridge.publish('sam',s.run.id);
  assert.equal(a.receiptId,b.receiptId);assert.equal(c.receiptId,a.receiptId);
  assert.equal(s.calls(),1);
  assert.equal([...s.state.messages.values()].filter(m=>m.origin==='research').length,1);
});
test('revocation during model prevents commit and duplicate cannot revive it',async()=>{
  const s=setup();const model=s.deps.model;
  s.deps.model=async(input,signal)=>{s.state.config.grants.find(g=>g.memberId==='sam')!.revoked=true;return model(input,signal);};
  const bridge=new OfflineHandbookPublisher(s.state,s.deps);
  await assert.rejects(bridge.publish('sam',s.run.id));await assert.rejects(bridge.publish('sam',s.run.id));
  assert.equal(s.run.receiptId,undefined);
});
test('source edit during model prevents commit',async()=>{
  const s=setup();const model=s.deps.model;
  s.deps.model=async(input,signal)=>{s.state.changeMessage('alex',s.message.id,'edit',1,crypto.randomUUID(),'查一下另一个问题');return model(input,signal);};
  await assert.rejects(new OfflineHandbookPublisher(s.state,s.deps).publish('sam',s.run.id));
  assert.equal(s.run.receiptId,undefined);
});
test('abort during model rejects late output',async()=>{
  const s=setup();const abort=new AbortController();const model=s.deps.model;
  s.deps.model=async(input,signal)=>{abort.abort();return model(input,signal);};
  await assert.rejects(new OfflineHandbookPublisher(s.state,s.deps).publish('sam',s.run.id,abort.signal));
  assert.equal(s.run.receiptId,undefined);
});
test('wrong actor or unconfigured fixture cannot start',async()=>{
  const s=setup();const bridge=new OfflineHandbookPublisher(s.state,s.deps);
  await assert.rejects(bridge.publish('alex',s.run.id));assert.equal(s.calls(),0);
  s.state.config.sources=[...fixtureSources];
  assert.throws(()=>new OfflineHandbookPublisher(s.state,s.deps),/not_configured/);
});
test('model cannot redirect citation or forge configured fixture text',async()=>{
  const s=setup();s.deps.model=async input=>({conclusion:'fake',claims:[{receiptId:input.receiptId,excerpt:'Fixture:'}]});
  await assert.rejects(new OfflineHandbookPublisher(s.state,s.deps).publish('sam',s.run.id),/excerpt_mismatch/);
  assert.equal(s.run.receiptId,undefined);
});
test('existing synthetic publication behavior unchanged',()=>{
  const s=setup();const result={conclusion:'Existing fixture result',sources:[fixtureSources[0]!],limitations:['Synthetic'],evidence:'synthetic-fixture'};
  const first=s.state.publish('sam',s.run.id,result);const second=s.state.publish('sam',s.run.id,result);
  assert.equal(first.receiptId,second.receiptId);assert.equal(second.duplicate,true);
});

test('bridge restart refuses recorded run before repeating preparation',async()=>{
  const s=setup();await new OfflineHandbookPublisher(s.state,s.deps).publish('sam',s.run.id);
  const restarted=new OfflineHandbookPublisher(s.state,s.deps);
  s.deps.transport.resolveIPv4=async()=>{assert.fail('restart must not recollect');};
  await assert.rejects(restarted.publish('sam',s.run.id),/already_recorded/);
  assert.equal(s.calls(),1);
  assert.equal([...s.state.messages.values()].filter(m=>m.origin==='research').length,1);
});
test('post-publication revoked grant cannot read cached result via retry',async()=>{
  const s=setup();const bridge=new OfflineHandbookPublisher(s.state,s.deps);
  await bridge.publish('sam',s.run.id);
  s.state.config.grants.find(g=>g.memberId==='sam')!.revoked=true;
  await assert.rejects(bridge.publish('sam',s.run.id));
  assert.equal(s.calls(),1);
});
test('failed attempt cache is bounded and does not reopen on saturation',async()=>{
  const s=setup();s.deps.model=async()=>{throw Error('mock_failed');};
  const bridge=new OfflineHandbookPublisher(s.state,s.deps);
  for(let i=0;i<128;i++){
    const {message}=s.state.createMessage('alex',s.scope,'查一下类型区别',crypto.randomUUID());
    const {run}=s.state.claim('sam',message.id);
    await assert.rejects(bridge.publish('sam',run.id),/mock_failed/);
  }
  await assert.rejects(bridge.publish('sam',s.run.id),/capacity/);
  await assert.rejects(bridge.publish('sam',s.run.id),/capacity/);
  assert.equal(s.run.receiptId,undefined);
});
