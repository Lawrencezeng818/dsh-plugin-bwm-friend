const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEventBus, createPresenceMachine } = require('../src/index.js');
function setup() {
  const bus = createEventBus();
  const store = { presence: { state: 'idle' } };
  const stop = createPresenceMachine(bus, { get: k => store[k], set: (k,v) => { store[k] = v; } });
  return { bus, stop, state: () => store.presence.state };
}
test('old success timer cannot expire a later success with the same name', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup(); t.after(s.stop);
  s.bus.emit('agent.task.success'); t.mock.timers.tick(200);
  s.bus.emit('agent.tool.call'); t.mock.timers.tick(300);
  s.bus.emit('agent.task.success'); t.mock.timers.tick(1000);
  assert.equal(s.state(), 'success');
  t.mock.timers.tick(400); assert.equal(s.state(), 'idle');
});
test('disposing machine cancels pending reset', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup(); s.bus.emit('agent.task.success'); s.stop();
  t.mock.timers.tick(1500); assert.equal(s.state(), 'success');
});
test('blocked frames never reach live, late or explicit replay subscribers', () => {
  const bus = createEventBus(); let live=0,late=0;
  bus.route('private', () => ({ blocked:true }));
  bus.on('private', () => live++); bus.emit('private', {}, { private:true });
  bus.on('private', () => late++); bus.replay();
  assert.deepEqual({live,late},{live:0,late:0});
});
test('redirect and subscriber predicate apply identically during replay', () => {
  const bus=createEventBus();bus.route('source',()=>({channel:'target'}));
  bus.emit('source',{id:1},{allowed:true}); bus.emit('source',{id:2},{allowed:false});
  const got=[],wrong=[];
  bus.on('target',(p,m)=>got.push([p.id,m.allowed]),{when:(_,m)=>m.allowed});
  bus.on('source',p=>wrong.push(p));bus.replay();
  assert.deepEqual(got,[[1,true],[1,true]]);assert.deepEqual(wrong,[]);
});
test('late presence consumer receives current snapshot after history eviction', () => {
  const s=setup();s.bus.emit('agent.thinking.start');
  for(let i=0;i<501;i++)s.bus.emit('noise',{i});
  const got=[];s.bus.on('presence:state',p=>got.push(p.state));
  assert.deepEqual(got,['thinking']);s.stop();
});
test('presence recovery does not replay obsolete animations before current state', () => {
  const s=setup();s.bus.emit('agent.thinking.start');s.bus.emit('agent.tool.call');
  const got=[];s.bus.on('presence:state',p=>got.push(p.state));
  assert.deepEqual(got,['executing']);s.stop();
});
test('duplicate state does not restart transient duration or notify twice',t=>{
  t.mock.timers.enable({apis:['setTimeout']});const s=setup();t.after(s.stop);
  const got=[];s.bus.on('presence:state',p=>got.push(p.state));s.bus.emit('agent.task.success');
  t.mock.timers.tick(1000);s.bus.emit('agent.task.success');t.mock.timers.tick(400);
  assert.equal(s.state(),'idle');assert.deepEqual(got,['idle','success','idle']);
});
test('explicit history replay cannot re-run live-only lifecycle arbitration',t=>{
  t.mock.timers.enable({apis:['setTimeout']});const s=setup();t.after(s.stop);
  s.bus.emit('agent.thinking.start');s.bus.emit('agent.tool.call');
  const got=[];s.bus.on('presence:state',p=>got.push(p.state));s.bus.replay();
  assert.deepEqual(got,['executing','executing']);assert.equal(s.state(),'executing');
});
test('reentrant subscriber replacing success prevents stale reset registration',t=>{
  t.mock.timers.enable({apis:['setTimeout']});const s=setup();t.after(s.stop);
  s.bus.on('presence:state',p=>{if(p.state==='success')s.bus.emit('agent.tool.call');});
  s.bus.emit('agent.task.success');t.mock.timers.tick(1500);assert.equal(s.state(),'executing');
});
test('context watcher reentry cannot overwrite newer retained state',()=>{
  const bus=createEventBus(),store={presence:{state:'idle'}};
  const stop=createPresenceMachine(bus,{get:k=>store[k],set:(k,v)=>{store[k]=v;if(v.state==='success')bus.emit('agent.tool.call');}});
  bus.emit('agent.task.success');const late=[];bus.on('presence:state',p=>late.push(p.state));
  assert.equal(store.presence.state,'executing');assert.deepEqual(late,['executing']);stop();
});
test('reentrant first listener cannot send stale state to later listeners',()=>{
  const s=setup();s.bus.on('presence:state',p=>{if(p.state==='success')s.bus.emit('agent.tool.call');});
  const later=[];s.bus.on('presence:state',p=>later.push(p.state));s.bus.emit('agent.task.success');
  assert.deepEqual(later,['idle','executing']);s.stop();
});
