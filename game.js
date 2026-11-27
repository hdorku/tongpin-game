export const normalize = word => word.normalize('NFKC').trim().replace(/\s+/gu, '').toLocaleLowerCase();
export const validWord = word => typeof word === 'string' && word.trim().length > 0 && [...word.trim()].length <= 20 && !/[\p{Cc}\p{Cf}]/u.test(word);
export const randomId = (bytes = 24) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
export async function commitment(code, game, round, word, nonce) {
  const data = new TextEncoder().encode(JSON.stringify([code, game, round, word, nonce]));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export function newRound(no) { return {no, commits:[null,null], words:[null,null], same:[false,false], ready:[false,false], status:'writing'}; }
export function newGame(code, name) { return {version:1, code, game:1, names:[name,null], round:newRound(1), history:[], rematch:[false,false], revision:0}; }
export function snapshot(state) {
  const copy = structuredClone(state);
  if(copy.round.status === 'writing') copy.round.words = [null,null];
  return copy;
}
export async function act(state, seat, message) {
  if (!Number.isInteger(seat) || seat < 0 || seat > 1) throw Error('无效的席位');
  if (!message || typeof message !== 'object') throw Error('无效的操作');
  if(message.type === 'join') {
    if(seat !== 1 || state.names[1]) throw Error('房间已满');
    if(typeof message.name !== 'string' || !message.name.trim() || [...message.name.trim()].length > 12) throw Error('昵称需为 1–12 个字');
    state.names[1] = message.name.trim(); state.revision++; return;
  }
  const r = state.round;
  if (!state.names[1]) throw Error('等朋友加入后再开始');
  if(message.game !== state.game || message.round !== r.no) throw Error('轮次已更新，请等待同步后重试');
  if(message.type === 'commit') {
    if(r.status !== 'writing') throw Error('这一轮已揭晓');
    if(typeof message.hash !== 'string' || !/^[0-9a-f]{64}$/.test(message.hash)) throw Error('提交格式有误');
    if(r.commits[seat] && r.commits[seat] !== message.hash) throw Error('提交后不能修改');
    r.commits[seat] = message.hash;
  } else if(message.type === 'reveal') {
    if(r.status !== 'writing') return;
    if(!r.commits.every(Boolean)) throw Error('等待双方提交');
    if(!validWord(message.word) || typeof message.nonce !== 'string' || !/^[0-9a-f]{48}$/.test(message.nonce)) throw Error('词语格式有误');
    if(await commitment(state.code,state.game,r.no,message.word,message.nonce) !== r.commits[seat]) throw Error('词语与之前提交的不一致');
    r.words[seat] = message.word.trim();
    if(r.words.every(Boolean)) r.status = normalize(r.words[0]) === normalize(r.words[1]) ? 'matched' : 'revealed';
  } else if(message.type === 'same') {
    if(r.status === 'matched' || r.status === 'agreed') return;
    if(r.status !== 'revealed') throw Error('揭晓后才能确认');
    if(r.ready.some(Boolean)) throw Error('本轮已选择继续联想');
    r.same[seat] = true;
    if(r.same.every(Boolean)) r.status = 'agreed';
  } else if(message.type === 'next') {
    if(r.status !== 'revealed') throw Error('当前不能进入下一轮');
    r.ready[seat] = true; r.same = [false,false];
    if(r.ready.every(Boolean)) { state.history.push(structuredClone(r)); state.round = newRound(r.no+1); }
  } else if(message.type === 'rematch') {
    if(!['matched','agreed'].includes(r.status)) throw Error('通关后才能再来一局');
    state.rematch[seat] = true;
    if(state.rematch.every(Boolean)) { state.game++; state.round = newRound(1); state.history=[]; state.rematch=[false,false]; }
  } else throw Error('未知操作');
  state.revision++;
}
