import Peer from 'peerjs';
import {act, newGame, snapshot, commitment, randomId} from './game.js';
const KEY = 'tongpin-session-v1';
const NEGOTIATION_TIMEOUT = 35000;
const HANDSHAKE_TIMEOUT = 12000;
const SERVICE_TIMEOUT = 30000;
// Cloudflare and Google both provide public STUN. Do not rely on PeerJS's
// bundled TURN hostnames: they no longer resolve (checked 2026-11-27).
const ICE_CONFIG = {iceServers:[
  {urls:'stun:stun.cloudflare.com:3478'},
  {urls:'stun:stun.l.google.com:19302'}
]};
export function savedSession() { try { const s=JSON.parse(sessionStorage.getItem(KEY)); return s?.version===1 && s.code && s.role && s.name ? s : null; } catch { return null; } }
export function clearSession() { try{sessionStorage.removeItem(KEY);}catch{} }
export class Room {
  constructor(session, onChange, onError, {PeerClass=Peer}={}) {
    this.s=session; this.view=session.role==='host'?snapshot(session.state):null;
    this.onChange=onChange; this.onError=onError; this.connected=false; this.status='正在连接房间服务…';
    this.queue=Promise.resolve(); this.dead=false; this.lastSeen=Date.now(); this.retry=null; this.peer=null; this.conn=null;
    this.PeerClass=PeerClass; this.attempts=0; this.pending=new Map();
    this.persist(); this.start();
    this.online=()=>{this.setStatus('网络恢复，正在重连…'); this.reconnect();};
    this.offline=()=>{this.connected=false;this.conn?.close();this.setStatus('网络已断开，恢复后会自动重连');};
    window.addEventListener('online',this.online);window.addEventListener('offline',this.offline);
    this.heartbeat=setInterval(()=>this.tick(),4000);
  }
  static create(name, onChange, onError) {
    const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code=Array.from(crypto.getRandomValues(new Uint8Array(10)),b=>alphabet[b%32]).join('');
    return new Room({version:1,role:'host',code,name,state:newGame(code,name),guestToken:null,secret:null},onChange,onError);
  }
  static join(code,name,onChange,onError) { return new Room({version:1,role:'guest',code,name,token:randomId(),secret:null},onChange,onError); }
  get seat(){return this.s.role==='host'?0:1;}
  persist(){try{sessionStorage.setItem(KEY,JSON.stringify(this.s));}catch{this.onError('浏览器无法保存房间，请保持此页面打开。');}}
  setStatus(text){if(this.dead)return;this.status=text;this.onChange(this);}
  clearRetry(){clearTimeout(this.retry);this.retry=null;}
  serviceDeadline(peer){
    clearTimeout(this.serviceTimer);
    this.serviceTimer=setTimeout(()=>{
      if(this.dead||peer!==this.peer||peer.open)return;
      // Keep a working game channel even if only the signaling service is down.
      this.peer=null;peer.destroy();
      this.setStatus(this.connected?'双方仍已连接，正在恢复房间服务…':'房间服务连接超时，正在重试…');
      this.schedule();
    },SERVICE_TIMEOUT);
  }
  start(){
    if(this.dead||this.peer)return;
    this.serviceReconnecting=false;
    const options={debug:0,config:ICE_CONFIG};
    const peer=this.s.role==='host'?new this.PeerClass(`tongpin-v1-${this.s.code}`,options):new this.PeerClass(options);
    this.peer=peer;this.serviceDeadline(peer);
    const current=()=>!this.dead&&peer===this.peer;
    peer.on('open',()=>{
      if(!current())return;
      clearTimeout(this.serviceTimer);
      if(this.s.role==='host'){
        if(!this.connected)this.setStatus(this.s.state.names[1]?'房间已恢复，等待朋友重连…':'房间已开好，等待朋友加入');
      }else this.connectGuest();
    });
    peer.on('connection',connection=>{
      if(!current()||this.s.role!=='host'){connection.close();return;}
      this.accept(connection);
    });
    peer.on('disconnected',()=>{
      if(!current())return;
      this.setStatus(this.connected?'双人连接正常，房间服务正在重连…':'房间服务中断，正在重连…');this.schedule();
    });
    peer.on('error',error=>{
      if(!current())return;
      const messages={'peer-unavailable':'房间暂未在线，请确认房间码，并让房主保持页面打开。','unavailable-id':'房间仍在断开旧连接，正在重新接入…','network':'连接房间服务失败，正在重试…','webrtc':'网络未能建立双人通道，正在重试。公司 VPN 可能限制直连。','browser-incompatible':'当前浏览器不支持双人连接，请使用新版 Safari、Chrome 或 Edge。'};
      this.setStatus(messages[error.type]||'连接未成功，正在重试…');
      if(error.type==='browser-incompatible'){this.stop();return;}
      if(['peer-unavailable','webrtc'].includes(error.type)&&this.s.role==='guest'&&!this.connected)this.dropGuest(this.conn);
      if(peer.destroyed){clearTimeout(this.serviceTimer);this.peer=null;}
      this.schedule();
    });
  }
  schedule(){
    if(this.dead||this.retry)return;
    const delay=Math.min(2000*2**Math.min(this.attempts++,4),20000);
    this.retry=setTimeout(()=>{this.retry=null;this.reconnect();},delay);
  }
  reconnect(){
    if(this.dead||!navigator.onLine)return;
    // Neither a heartbeat nor repeated clicks may replace an in-flight attempt.
    if(!this.peer||this.peer.destroyed){this.peer=null;this.start();return;}
    if(this.peer.disconnected){
      if(this.serviceReconnecting)return;
      this.serviceReconnecting=true;this.serviceDeadline(this.peer);
      this.peer.once('open',()=>{this.serviceReconnecting=false;});
      try{this.peer.reconnect();}catch{this.serviceReconnecting=false;const old=this.peer;this.peer=null;old.destroy();this.start();}
      return;
    }
    if(this.s.role==='guest'&&!this.conn&&this.peer.open)this.connectGuest();
  }
  arm(connection,delay,callback){
    this.disarm(connection);
    this.pending.set(connection,setTimeout(()=>{this.pending.delete(connection);callback();},delay));
  }
  disarm(connection){clearTimeout(this.pending.get(connection));this.pending.delete(connection);}
  dropGuest(connection){
    if(!connection||connection!==this.conn)return;
    this.disarm(connection);this.conn=null;this.connected=false;
    try{connection.close();}catch{}
  }
  connectGuest(){
    if(this.dead||this.conn||!this.peer?.open)return;
    this.clearRetry();this.setStatus('已找到房间，正在建立双人通道…');
    const connection=this.peer.connect(`tongpin-v1-${this.s.code}`,{reliable:true,serialization:'json'});
    this.conn=connection;this.watch(connection,false);
    const timeout=()=>{
      if(this.dead||connection!==this.conn)return;
      this.dropGuest(connection);
      this.setStatus('双人通道连接超时，正在重试。公司 VPN 可能限制直连。');this.schedule();
    };
    this.arm(connection,NEGOTIATION_TIMEOUT,timeout);
    connection.on('open',()=>{
      if(this.dead||connection!==this.conn){connection.close();return;}
      this.lastSeen=Date.now();
      // The room handshake gets its own clock, after ICE and DTLS have finished.
      this.arm(connection,HANDSHAKE_TIMEOUT,timeout);
      connection.send({type:'hello',version:1,token:this.s.token,name:this.s.name});
      this.setStatus('双人通道已连接，正在同步房间…');
    });
  }
  accept(connection){
    let authorized=false;
    const expire=()=>{if(!authorized)connection.close();};
    this.arm(connection,NEGOTIATION_TIMEOUT,expire);
    connection.on('open',()=>{
      if(this.dead){connection.close();return;}
      if(!authorized)this.arm(connection,HANDSHAKE_TIMEOUT,expire);
    });
    connection.on('data',message=>{
      if(this.dead||!message||typeof message!=='object'||JSON.stringify(message).length>20000){connection.close();return;}
      if(!authorized){
        if(message.type!=='hello'||message.version!==1||typeof message.token!=='string'||!/^[0-9a-f]{48}$/.test(message.token)||typeof message.name!=='string'||!message.name.trim()||[...message.name].length>12){connection.close();return;}
        if(this.s.guestToken&&this.s.guestToken!==message.token){connection.send({type:'fatal',message:'房间已满，两位玩家都已入座。'});this.arm(connection,300,()=>connection.close());return;}
        authorized=true;this.disarm(connection);this.clearRetry();this.attempts=0;this.s.guestToken=message.token;
        const previous=this.conn;this.conn=connection;if(previous&&previous!==connection)previous.close();
        this.watch(connection,true);this.connected=true;this.lastSeen=Date.now();
        if(!this.s.state.names[1])this.enqueue(1,{type:'join',name:message.name});else this.broadcast();
        this.setStatus('双方已连接');return;
      }
      if(connection!==this.conn)return;
      this.lastSeen=Date.now();
      if(message.type==='nudge'){this.receiveNudge();return;}
      if(message.type==='ping'){connection.send({type:'pong'});return;}
      if(message.type==='sync'){this.broadcast();return;}
      if(message.type==='action')this.enqueue(1,message.action);
    });
    connection.on('close',()=>this.disarm(connection));
    connection.on('error',()=>{this.disarm(connection);connection.close();});
  }
  watch(connection,host){
    const closed=()=>{
      this.disarm(connection);
      if(connection!==this.conn||this.dead)return;
      this.conn=null;this.connected=false;
      this.setStatus(host?'朋友暂时断开，正在等待重连…':'双人连接中断，正在重连…');this.schedule();
    };
    connection.on('close',closed);
    connection.on('error',()=>{closed();connection.close();});
    if(host)return;
    connection.on('data',message=>{
      if(this.dead||connection!==this.conn||!message||typeof message!=='object'||JSON.stringify(message).length>200000)return;
      this.lastSeen=Date.now();
      if(message.type==='fatal'){this.connected=false;this.status=message.message;this.stop();this.onError(message.message);return;}
      if(message.type==='error'){this.onError(message.message);return;}
      if(message.type==='nudge'){this.receiveNudge();return;}
      if(message.type==='ping'){connection.send({type:'pong'});return;}
      if(message.type==='state'&&message.state?.code===this.s.code&&message.state.version===1){
        this.disarm(connection);this.clearRetry();this.attempts=0;
        this.connected=true;this.view=message.state;this.s.view=this.view;this.persist();this.status='双方已连接';this.onChange(this);this.flush();
      }
    });
  }
  enqueue(seat,message){
    this.queue=this.queue.then(async()=>{
      if(this.dead)return;
      try{await act(this.s.state,seat,message);this.broadcast();}
      catch(error){if(seat===0)this.onError(error.message);else if(this.conn?.open)this.conn.send({type:'error',message:error.message});}
    });return this.queue;
  }
  broadcast(){
    this.view=snapshot(this.s.state);this.persist();
    if(this.conn?.open)this.conn.send({type:'state',state:this.view});
    this.onChange(this);this.flush();
  }
  send(action){
    if(!this.view)return;
    if(!this.connected){this.onError('请等待双方重新连接后再操作。');return;}
    const message={...action,game:this.view.game,round:this.view.round.no};
    if(this.s.role==='host')return this.enqueue(0,message);
    if(this.conn?.open)this.conn.send({type:'action',action:message});
  }
  async submit(word){
    if(!this.view||!this.connected)return;
    const r=this.view.round;
    if(this.s.secret?.game===this.view.game&&this.s.secret?.round===r.no){this.flush();return;}
    const secret={game:this.view.game,round:r.no,word:word.trim(),nonce:randomId()};
    secret.hash=await commitment(this.s.code,secret.game,secret.round,secret.word,secret.nonce);
    this.s.secret=secret;this.persist();this.flush();this.onChange(this);
  }
  flush(){
    const state=this.view,secret=this.s.secret;
    if(!state||!secret||!this.connected||secret.game!==state.game||secret.round!==state.round.no||state.round.status!=='writing')return;
    const r=state.round;
    if(!r.commits[this.seat]){this.send({type:'commit',hash:secret.hash});return;}
    if(r.commits.every(Boolean)){
      if(this.s.role==='host'&&this.s.state.round.words[0])return;
      const marker=`${state.game}:${r.no}:${state.revision}`;
      if(this.revealMarker===marker)return;this.revealMarker=marker;
      this.send({type:'reveal',word:secret.word,nonce:secret.nonce});
    }
  }
  tick(){
    if(this.dead)return;
    if(this.conn?.open){
      if(Date.now()-this.lastSeen>60000){this.conn.close();return;}
      this.conn.send({type:'ping'});
      if(this.s.role==='guest')this.conn.send({type:'sync'});
      this.flush();
    }else if(!this.retry)this.reconnect();
  }
  nudge(){
    if(!this.connected||!this.conn?.open)return;
    if(Date.now()-(this.lastNudgeSent||0)<3500){this.onNotice?.('稍等一下，再抖一抖 ☺');return;}
    this.lastNudgeSent=Date.now();this.conn.send({type:'nudge'});this.onNotice?.('你向好友发送了一个窗口抖动。');
  }
  receiveNudge(){if(Date.now()-(this.lastNudgeReceived||0)<3000)return;this.lastNudgeReceived=Date.now();this.onNudge?.();}
  stop(){
    this.dead=true;this.clearRetry();clearTimeout(this.serviceTimer);clearInterval(this.heartbeat);
    for(const [connection,timer] of this.pending){clearTimeout(timer);connection.close();}
    this.pending.clear();this.conn?.close();this.peer?.destroy();
    window.removeEventListener('online',this.online);window.removeEventListener('offline',this.offline);
  }
}
