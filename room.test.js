import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Room} from './room.js';
import {newGame,snapshot} from './game.js';

class Connection extends EventEmitter {
  open=false;closed=false;sent=[];
  send(data){this.sent.push(data);}
  establish(){this.open=true;this.emit('open');}
  close(){if(this.closed)return;this.closed=true;this.open=false;this.emit('close');}
}
class FakePeer extends EventEmitter {
  static instances=[];
  open=false;disconnected=false;destroyed=false;connections=[];reconnects=0;
  constructor(...args){super();this.args=args;FakePeer.instances.push(this);}
  establish(){this.open=true;this.disconnected=false;this.emit('open','fake-id');}
  connect(){const c=new Connection();this.connections.push(c);return c;}
  reconnect(){this.reconnects++;}
  destroy(){this.destroyed=true;this.open=false;}
}
const code='ABCDEFGHJK';
function setup(t,role='guest'){
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:100000});
  const previousWindow=globalThis.window,previousStorage=globalThis.sessionStorage;
  globalThis.window=new EventTarget();globalThis.sessionStorage={setItem(){}};
  const navigatorDescriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{value:{onLine:true},configurable:true});
  FakePeer.instances=[];
  const session={version:1,role,code,name:'玩家',token:'a'.repeat(48),state:role==='host'?newGame(code,'玩家'):undefined};
  const room=new Room(session,()=>{},()=>{},{PeerClass:FakePeer});
  t.after(()=>{room.stop();globalThis.window=previousWindow;globalThis.sessionStorage=previousStorage;Object.defineProperty(globalThis,'navigator',navigatorDescriptor);});
  return room;
}
function joinedState(){const s=newGame(code,'房主');s.names[1]='朋友';return snapshot(s);}

test('guest keeps the same pending channel across 4-second heartbeats and retry clicks',t=>{
  const room=setup(t);room.peer.establish();const c=room.conn;
  for(let i=0;i<6;i++){t.mock.timers.tick(4000);room.reconnect();}
  assert.equal(room.conn,c);assert.equal(c.closed,false);assert.equal(room.peer.connections.length,1);
  c.establish();c.emit('data',{type:'state',state:joinedState()});
  assert.equal(room.connected,true);assert.equal(c.sent[0].type,'hello');
});

test('host waits for slow ICE, then gives hello its own timeout',async t=>{
  const room=setup(t,'host');room.peer.establish();const c=new Connection();room.peer.emit('connection',c);
  t.mock.timers.tick(24000);assert.equal(c.closed,false);
  c.establish();t.mock.timers.tick(8000);assert.equal(c.closed,false);
  c.emit('data',{type:'hello',version:1,token:'a'.repeat(48),name:'朋友'});await room.queue;
  assert.equal(room.connected,true);assert.equal(room.s.state.names[1],'朋友');
});

test('host registration is not destroyed by heartbeat while opening',t=>{
  const room=setup(t,'host'),peer=room.peer;
  t.mock.timers.tick(24000);assert.equal(room.peer,peer);assert.equal(peer.destroyed,false);
  peer.establish();t.mock.timers.tick(10000);assert.equal(room.peer,peer);
});

test('a genuinely timed-out channel is closed and replaced once after backoff',t=>{
  const room=setup(t);room.peer.establish();const first=room.conn;
  t.mock.timers.tick(35000);assert.equal(first.closed,true);assert.equal(room.conn,null);
  t.mock.timers.tick(2000);const second=room.conn;
  assert.ok(second);assert.notEqual(second,first);assert.equal(room.peer.connections.length,2);
  first.emit('data',{type:'state',state:joinedState()});first.emit('error',new Error('stale'));
  assert.equal(room.conn,second);assert.equal(room.connected,false);
});

test('an open data channel without a room handshake also times out',t=>{
  const room=setup(t);room.peer.establish();const c=room.conn;c.establish();
  t.mock.timers.tick(12000);assert.equal(c.closed,true);assert.equal(room.connected,false);
});

test('late events from an obsolete signaling peer do not alter the new peer',t=>{
  const room=setup(t,'host'),first=room.peer;
  t.mock.timers.tick(30000);assert.equal(first.destroyed,true);
  t.mock.timers.tick(2000);const second=room.peer;assert.notEqual(second,first);
  first.emit('open');first.emit('error',{type:'network'});
  assert.equal(room.peer,second);assert.equal(room.retry,null);
  second.establish();assert.match(room.status,/房间已开好/);
});

test('a connection survives a short pause and reconnects after a real heartbeat timeout',t=>{
  const room=setup(t);room.peer.establish();const c=room.conn;c.establish();
  c.emit('data',{type:'state',state:joinedState()});
  t.mock.timers.tick(24000);assert.equal(c.closed,false);assert.equal(room.connected,true);
  t.mock.timers.tick(40000);assert.equal(c.closed,true);assert.equal(room.connected,false);
});

test('stop cancels pending negotiation and cannot restart from timers',t=>{
  const room=setup(t);room.peer.establish();const c=room.conn;room.stop();
  t.mock.timers.tick(120000);assert.equal(c.closed,true);assert.equal(FakePeer.instances.length,1);
  c.emit('open');assert.equal(room.connected,false);
});


test('signaling reconnect is single-flight and a restored service leaves the data channel intact',t=>{
  const room=setup(t);room.peer.establish();const c=room.conn;c.establish();
  c.emit('data',{type:'state',state:joinedState()});
  room.peer.open=false;room.peer.disconnected=true;room.peer.emit('disconnected');
  room.reconnect();room.reconnect();assert.equal(room.peer.reconnects,1);
  room.peer.establish();assert.equal(room.conn,c);assert.equal(room.connected,true);
});

test('offline closes the obsolete channel so online can perform a fresh handshake',t=>{
  const room=setup(t);room.peer.establish();const c=room.conn;c.establish();
  c.emit('data',{type:'state',state:joinedState()});
  window.dispatchEvent(new Event('offline'));assert.equal(c.closed,true);assert.equal(room.connected,false);
  window.dispatchEvent(new Event('online'));const second=room.conn;assert.ok(second);assert.notEqual(second,c);
  second.establish();second.emit('data',{type:'state',state:joinedState()});assert.equal(room.connected,true);
});
