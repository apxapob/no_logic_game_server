'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function demo() {
  const sent = [], timers = [], intervals = [], raf = [], listeners = {};
  const ctx = new Proxy({}, {get: (o,k) => o[k] || (() => {})});
  const canvas = {getContext:()=>ctx,addEventListener:(k,f)=>listeners[k]=f,getBoundingClientRect:()=>({top:0,height:100})};
  const status = {textContent:'',appendChild() {}};
  class WS { static OPEN = 1; constructor(url) { this.url=url; this.readyState=1; WS.instance=this; } send(text) { sent.push(JSON.parse(text)); } }
  const sandbox = {document:{getElementById:id=>id==='game'?canvas:status,createElement:()=>({})},sessionStorage:{getItem:()=>null,setItem() {},removeItem() {}},crypto:{randomUUID:()=> 'tab'},WebSocket:WS,location:{protocol:'http:',host:'localhost:8081',reload() {}},innerWidth:800,innerHeight:600,devicePixelRatio:2,addEventListener() {},setTimeout:f=>timers.push(f),setInterval:(f,ms)=>intervals.push({f,ms}),requestAnimationFrame:f=>raf.push(f),Math,JSON};
  vm.createContext(sandbox);
  const html = fs.readFileSync(path.join(__dirname,'../demo.html'),'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],sandbox);
  timers.shift()(); WS.instance.onopen();
  return {sent,timers,intervals,raf,listeners,canvas,get ws() { return WS.instance; },eval:code=>vm.runInContext(code,sandbox),event:(method,data,extra={})=>WS.instance.onmessage({data:JSON.stringify({method,data,...extra})})};
}
test('first frame authentication, IDs, room marker and ownership',()=>{
  const d=demo(); assert.deepEqual(d.sent[0],{method:'authenticate',data:{}}); assert.equal(d.ws.url,'ws://127.0.0.1:8080/');
  d.event('accountCreated',{playerId:'me',password:'secret'}); d.event('onConnected',{}); d.timers.shift()();
  d.event('onGetRooms',[{roomId:'r',ownerId:'other',players:['other'],maxPlayers:2,hasPassword:false,gameStarted:false,gameData:{demo:'no-logic-pong-v2'}}]);
  assert.deepEqual(d.sent.at(-1),{method:'enterRoom',data:{roomId:'r',password:null}});
  d.event('onRoomEnter',{roomId:'r',ownerId:'other',players:['other','me'],gameStarted:true}); assert.equal(d.eval('owner()'),false);
  d.event('newRoomOwner','me'); assert.equal(d.eval('owner()'),true);
  d.event('gameStateRequested',{playerId:'other'}); assert.deepEqual(d.sent.at(-1).data.to,['other']);
});
test('heartbeat echoes timestamp; unknown events and RTT are safe',()=>{
  const d=demo(); d.event('Ping',123); assert.deepEqual(d.sent.at(-1),{method:'Pong',data:123});
  const n=d.sent.length; d.event('toString',{}); d.event('unknown',{}); d.event('RoomRTT',{}); assert.equal(d.sent.length,n);
});
test('pointer and RAF never send; network is a separate 20 Hz tick',()=>{
  const d=demo(); d.event('accountCreated',{playerId:'me',password:'secret'}); d.event('onConnected',{});
  d.event('onRoomEnter',{roomId:'r',ownerId:'other',players:['other','me'],gameStarted:true});
  const n=d.sent.length; for(let i=0;i<100;i++) d.listeners.pointermove({clientY:60});
  for(let i=0;i<10;i++) d.raf.shift()(i*16);
  assert.equal(d.sent.length,n); assert.equal(d.intervals[0].ms,50);
  d.intervals[0].f(); assert.deepEqual(d.sent.at(-1),{method:'sendToRoom',data:{y:.6}}); d.intervals[0].f(); assert.equal(d.sent.length,n+1);
  assert.equal(d.canvas.width,1600);
});
test('physics measures seconds rather than rendered frames',()=>{
  const d=demo(); d.event('accountCreated',{playerId:'me',password:'secret'});
  d.event('onRoomEnter',{roomId:'r',ownerId:'me',players:['me','other'],gameStarted:true});
  d.eval('step(.1)'); assert.ok(Math.abs(d.eval('state.ballX')-.53)<1e-9);
  assert.ok(Math.abs(d.eval('state.ballY')-.524)<1e-9);
});
function roomDTO(roomId, ownerId, extra={}) {
  return {roomId,ownerId,players:[ownerId],maxPlayers:2,hasPassword:false,gameStarted:false,gameData:{demo:'no-logic-pong-v2'},...extra};
}
function authenticate(d, playerId) {
  d.event('accountCreated',{playerId,password:'secret'}); d.event('onConnected',{}); d.timers.shift()();
}
test('reconnect prioritizes an eligible started room over an open demo room',()=>{
  const d=demo(); authenticate(d,'me');
  d.event('onRoomEnter',roomDTO('saved','other',{players:['other','me'],gameStarted:true}));
  d.ws.onclose(); d.timers.shift()(); d.ws.onopen();
  assert.deepEqual(d.sent.at(-1),{method:'authenticate',data:{playerId:'me',password:'secret'}});
  d.event('onConnected',{}); d.timers.shift()();
  d.event('onGetRooms',[roomDTO('a','stranger'),roomDTO('saved','other',{gameStarted:true})]);
  assert.deepEqual(d.sent.at(-1),{method:'enterRoom',data:{roomId:'saved',password:null}});
  d.event('onRoomEnter',roomDTO('saved','other',{players:['other','me'],gameStarted:true}));
  assert.equal(d.sent.at(-1).method,'requestGameState');
  const n=d.sent.length; d.intervals[1].f(); assert.equal(d.sent.length,n);
});
test('active socket restoration cancels delayed lobby matchmaking',()=>{
  const d=demo(); d.event('accountCreated',{playerId:'me',password:'secret'}); d.event('onConnected',{});
  d.event('onRoomEnter',roomDTO('r','other',{players:['other','me'],gameStarted:true}));
  const n=d.sent.length; d.timers.shift()(); assert.equal(d.sent.length,n);
});
test('simultaneous empty lists converge on the smallest solo room without stale sends',()=>{
  const a=demo(), b=demo(); authenticate(a,'A'); authenticate(b,'B');
  a.event('onGetRooms',[]); b.event('onGetRooms',[]);
  assert.equal(a.sent.at(-1).method,'createRoom'); assert.equal(b.sent.at(-1).method,'createRoom');
  const ra=roomDTO('a','A'), rb=roomDTO('b','B');
  a.event('onRoomEnter',ra); b.event('onRoomEnter',rb);
  // No roomCreated event is needed. Only one discovery request may be in flight.
  a.intervals[1].f(); b.intervals[1].f(); const pending=b.sent.length;
  b.intervals[1].f(); assert.equal(b.sent.length,pending);
  a.event('onGetRooms',[rb,ra]); b.event('onGetRooms',[rb,ra]);
  assert.equal(a.sent.at(-1).method,'getRooms');
  assert.deepEqual(b.sent.slice(-2),[{method:'leaveRoom'},{method:'enterRoom',data:{roomId:'a',password:null}}]);
  const n=b.sent.length;
  b.intervals[0].f(); b.intervals[1].f(); b.event('onGetRooms',[ra,rb]); assert.equal(b.sent.length,n);
  a.event('playerEnter',{playerId:'B'}); assert.equal(a.sent.at(-1).method,'startGame');
  b.event('onRoomEnter',roomDTO('a','A',{players:['A','B']}));
  b.event('gameStarted',b.eval('JSON.parse(JSON.stringify(state))'));
  b.intervals[1].f(); assert.equal(b.sent.length,n);
});
test('matchmaking follows paced pages before choosing a room',()=>{
  const d=demo(); authenticate(d,'me');
  const before=d.sent.length;
  d.event('onGetRooms',[roomDTO('a','other',{gameData:{unrelated:'x'.repeat(1000)}})],{nextCursor:'a'});
  assert.equal(d.sent.length,before); assert.equal(d.eval('roomsRequested'),true);
  d.intervals[1].f(); assert.equal(d.sent.length,before);
  d.timers.shift()(); assert.deepEqual(d.sent.at(-1),{method:'getRooms',data:{after:'a'}});
  d.event('onGetRooms',[roomDTO('b','other')],{nextCursor:null});
  assert.deepEqual(d.sent.at(-1),{method:'enterRoom',data:{roomId:'b',password:null}});
  assert.equal(d.eval('roomPages.length'),0);
});
test('a stale page continuation cannot run after socket close',()=>{
  const d=demo(); authenticate(d,'me');
  d.event('onGetRooms',[],{nextCursor:'a'});
  const before=d.sent.length; d.ws.onclose(); d.timers.shift()();
  assert.equal(d.sent.length,before); assert.equal(d.eval('roomsRequested'),false);
});
test('solo matchmaking excludes protected, full, started and unrelated rooms',()=>{
  const d=demo(); authenticate(d,'me'); const own=roomDTO('z','me'); d.event('onRoomEnter',own);
  d.intervals[1].f(); const n=d.sent.length;
  d.event('onGetRooms',[roomDTO('a','x',{hasPassword:true}),roomDTO('b','x',{players:['x','y']}),roomDTO('c','x',{gameStarted:true}),roomDTO('d','x',{gameData:{demo:'other'}}),own]);
  assert.equal(d.sent.length,n); assert.equal(d.eval('room.roomId'),'z');
});
