// 中军帐桌面 · 界面逻辑：连本机 serve API，按人分组渲染消息（Huddo 质感）
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let slug = localStorage.getItem('zjz.slug') || '';
let currentRoom = null;
let roomsCache = [];
let lastSeq = 0;
let pollTimer = null;

// 显示名：slug 里剥掉前缀和尾号（E34：人要看名字，不看内部 id）
function shortName(s) {
  let x = String(s || '');
  x = x.replace(/^zjz-/, '');
  x = x.replace(/-[0-9a-f]{6,}$/i, '');
  return x || String(s || '');
}
// 正文里去掉内部流水号/重复时间标（E34）
function cleanBody(t) {
  let x = String(t || '');
  x = x.replace(/\[huddo:msg_[^\]]*\]/g, '');
  x = x.replace(/【?时间标[^\】\]]*[】\]]?/g, '');
  return x.trim();
}
function timeShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function dayKey(iso) {
  const d = new Date(iso || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function avatarChar(name) { return String(name || '?').trim().slice(0, 1).toUpperCase(); }

// —— 载入房间栏 ——
async function loadRooms() {
  const j = await window.zjz.get(`/api/rooms?slug=${encodeURIComponent(slug)}`);
  const list = $('roomList');
  if (!j || !j.ok) { list.innerHTML = '<div class="loading">房间载入失败</div>'; return; }
  // 没有当前身份时，自动落到有房的身份（E24-C）
  if ((!j.rooms || j.rooms.length === 0)) {
    const alt = await window.zjz.get('/api/rooms?slug=');
    if (alt && alt.current_slug && alt.current_slug !== slug) {
      slug = alt.current_slug; localStorage.setItem('zjz.slug', slug);
      return loadRooms();
    }
  }
  roomsCache = j.rooms || [];
  if (roomsCache.length === 0) {
    list.innerHTML = '<div class="loading" style="padding:28px 18px">还没有项目房间<br><br>点右上角「＋」开一个</div>';
    return;
  }
  list.innerHTML = roomsCache.map((r) => `
    <div class="room${r.archived ? ' arch' : ''}${r.room_id === currentRoom ? ' sel' : ''}" data-room="${esc(r.room_id)}">
      <div class="rn">${esc(r.name || r.room_id)}${r.unread ? `<span class="un">${r.unread}</span>` : ''}</div>
      <div class="rm"><span>${esc(shortName(r.owner))}</span><span>${r.archived ? '已归档' : '进行中'}</span></div>
    </div>`).join('');
  list.querySelectorAll('.room').forEach((el) => {
    el.onclick = () => openRoom(el.dataset.room);
  });
  // 首屏自动进第一个活房
  if (!currentRoom) {
    const first = roomsCache.find((r) => !r.archived);
    if (first) openRoom(first.room_id);
  }
}

// —— 打开房间 ——
async function openRoom(roomId) {
  currentRoom = roomId;
  lastSeq = 0;
  const r = roomsCache.find((x) => x.room_id === roomId) || {};
  $('roomHead').style.display = 'flex';
  $('roomTitle').textContent = r.name || roomId;
  $('roomMeta').textContent = `${shortName(r.owner)} · ${r.archived ? '已归档' : '进行中'}`;
  $('roomTag').textContent = r.unread ? `未读 ${r.unread}` : '已读';
  document.querySelectorAll('.room').forEach((el) => el.classList.toggle('sel', el.dataset.room === roomId));
  $('stream').innerHTML = '<div class="loading">载入房讯…</div>';
  await pull();
  loadRooms();
}

// —— 拉消息并按人分组渲染 ——
async function pull() {
  if (!currentRoom || !slug) return;
  const j = await window.zjz.get(`/api/rooms/${currentRoom}/messages?slug=${encodeURIComponent(slug)}&after=${lastSeq}&limit=200`);
  if (!j || !j.ok) { $('stream').innerHTML = `<div class="loading">${esc(j && j.code)}：${esc(j && j.message)}</div>`; return; }
  const msgs = j.messages || [];
  if (msgs.length === 0 && lastSeq === 0) {
    $('stream').innerHTML = '<div class="loading" style="padding:36px">这个房间还没有消息<br><br>在下面发第一条吧</div>';
    return;
  }
  if (msgs.length === 0) return;
  msgs.forEach((m) => renderMessage(m));
  lastSeq = Math.max(lastSeq, ...msgs.map((m) => Number(m.seq) || 0));
  $('stream').scrollTop = $('stream').scrollHeight;
}

// 按人分组：同人连续发言合并成一块（Huddo 手感）
function renderMessage(m) {
  const stream = $('stream');
  const empty = stream.querySelector('.empty, .loading');
  if (empty) stream.innerHTML = '';

  const dk = dayKey(m.ts);
  const lastDay = stream.dataset.day;
  if (dk !== lastDay) {
    const sep = document.createElement('div');
    sep.className = 'daysep';
    sep.textContent = dk;
    stream.appendChild(sep);
    stream.dataset.day = dk;
    stream.dataset.author = '';
  }

  const author = String(m.author || '?');
  const display = String(m.display_name || shortName(author));
  const mine = author === slug;
  const sameAuthor = stream.dataset.author === author;

  if (sameAuthor) {
    const grp = stream.lastElementChild;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (m.reply_to) bubble.innerHTML += `<div class="reply"><b>回复</b> #${esc(m.reply_to)}</div>`;
    bubble.innerHTML += esc(cleanBody(m.text));
    grp.querySelector('.col').appendChild(bubble);
    grp.querySelector('.tm').textContent = timeShort(m.ts);
  } else {
    const grp = document.createElement('div');
    grp.className = 'grp' + (mine ? ' mine' : '');
    grp.innerHTML = `
      <div class="avatar">${esc(avatarChar(display))}</div>
      <div class="col">
        <div class="who"><span class="nm">${esc(display)}</span><span class="hd">@${esc(shortName(author))}</span><span class="tm">${esc(timeShort(m.ts))}</span></div>
        ${m.reply_to ? `<div class="bubble"><div class="reply"><b>回复</b> #${esc(m.reply_to)}</div>${esc(cleanBody(m.text))}</div>` : `<div class="bubble">${esc(cleanBody(m.text))}</div>`}
      </div>`;
    stream.appendChild(grp);
    stream.dataset.author = author;
  }
}

// —— 发消息 ——
async function sendMsg() {
  const input = $('msgInput');
  const text = input.value.trim();
  if (!text) return;
  // 参谋长：聊天框里说"参谋长：我要做X"，就拆解→派活→汇报（一人成军的入口）。
  if (/^参谋长[：:]/.test(text)) {
    if (!currentRoom) { alert('先在左侧选一个项目房间'); return; }
    input.value = '';
    const r = await window.zjz.post('/api/chief', { goal: text, by: slug, room_id: currentRoom });
    if (r && r.ok) {
      await pull();
      $('stream').scrollTop = $('stream').scrollHeight;
    } else {
      const grp = document.createElement('div');
      grp.className = 'grp';
      grp.innerHTML = `<div class="col"><div class="bubble" style="border-color:var(--bad);color:var(--bad)">参谋长出错：${esc(r && r.code)} ${esc(r && r.message)}</div></div>`;
      $('stream').appendChild(grp);
    }
    return;
  }
  if (!currentRoom) { alert('先在左侧选一个项目房间'); return; }
  input.value = '';
  const r = await window.zjz.post(`/api/rooms/${currentRoom}/messages`, { slug, room_id: currentRoom, text });
  if (!r || !r.ok) {
    const grp = document.createElement('div');
    grp.className = 'grp';
    grp.innerHTML = `<div class="col"><div class="bubble" style="border-color:var(--bad);color:var(--bad)">${esc(r && r.code)}：${esc(r && r.message)}</div></div>`;
    $('stream').appendChild(grp);
    return;
  }
  await pull();
  $('stream').scrollTop = $('stream').scrollHeight;
}

// —— 连接状态 + 轮询实时刷新 ——
async function tickHealth() {
  const h = await window.zjz.get('/api/health');
  const ok = h && h.ok;
  $('connDot').className = 'dot' + (ok ? '' : ' off');
  $('connTxt').textContent = ok ? '已连接' : '未连接';
}

function startPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    await tickHealth();
    if (currentRoom) await pull();
    await loadRooms();
  }, 3000);
}

// —— 视图切换：房讯 / 智能体 ——
function switchView(v) {
  $('tabChat').classList.toggle('on', v === 'chat');
  $('tabAgents').classList.toggle('on', v === 'agents');
  $('agentsPanel').classList.toggle('show', v === 'agents');
  $('stream').style.display = v === 'chat' ? 'block' : 'none';
  $('roomHead').style.display = (v === 'chat' && currentRoom) ? 'flex' : 'none';
  document.querySelector('.composer').style.display = v === 'chat' ? 'flex' : 'none';
  if (v === 'agents') { loadAgentRooms(); loadAgents(); detectAgents(); }
}

// —— 智能体：本机探测 ——
function defaultAgentArgs(exe, name) {
  const key = `${String(exe || '')} ${String(name || '')}`.toLowerCase();
  if (key.includes('opencode')) return 'run {task}';
  if (key.includes('codex')) return 'exec {task}';
  if (key.includes('claude')) return '-p {task}';
  return '{task}';
}

async function detectAgents() {
  const j = await window.zjz.get('/api/agents/discover');
  const box = $('agDetect');
  const list = (j && j.agents) || [];
  if (list.length === 0) { box.innerHTML = '<span style="color:var(--warn)">本机没检测到已知智能体 CLI，可手动填</span>'; return; }
  box.innerHTML = '<span style="color:var(--dim2)">本机检测到：</span>' + list.map((a) =>
    `<span class="chip fill-one" data-exe="${esc(a.exe)}" data-name="${esc(a.name)}">＋ ${esc(a.name)}</span><button type="button" class="chip add-one" data-exe="${esc(a.exe)}" data-name="${esc(a.name)}">一键加入</button>`).join('');
  box.querySelectorAll('.chip.fill-one').forEach((c) => {
    c.onclick = () => {
      $('agExe').value = c.dataset.exe;
      if (!$('agDispName').value) $('agDispName').value = c.dataset.name + '分身';
      $('agArgs').value = defaultAgentArgs(c.dataset.exe, c.dataset.name);
    };
  });
  box.querySelectorAll('.chip.add-one').forEach((c) => {
    c.onclick = () => {
      const room_id = $('agRoom').value;
      const msg = $('agInviteMsg');
      if (!room_id) { msg.className = 'amsg bad'; msg.textContent = '先在“进入房间”里选一个项目房'; return; }
      $('agExe').value = c.dataset.exe;
      $('agDispName').value = c.dataset.name + '分身';
      $('agArgs').value = defaultAgentArgs(c.dataset.exe, c.dataset.name);
      $('agInvite').click();
    };
  });
}
// —— 智能体：进房下拉（带房主） ——
async function loadAgentRooms() {
  const j = await window.zjz.get(`/api/rooms?slug=${encodeURIComponent(slug)}`);
  const rooms = (j && j.rooms) || [];
  $('agRoom').innerHTML = rooms.map((r) =>
    `<option value="${esc(r.room_id)}">${esc(r.name || r.room_id)}（房主：${esc(shortName(r.owner))}）</option>`).join('')
    || '<option value="">（先开一个项目房）</option>';
}

// —— 智能体：帐内列表（逐房移出，E37 契约） ——
async function loadAgents() {
  const j = await window.zjz.get('/api/agents');
  const rows = (j && j.agents) || [];
  const box = $('agList');
  if (rows.length === 0) { box.innerHTML = '<div style="color:var(--dim2)">还没有智能体，上面请一个进来</div>'; return; }
  box.innerHTML = rows.map((r) => {
    const wired = r.wired;
    const rooms = (r.rooms || []);
    return `<div class="agent-item">
      <span class="an">${esc(r.name || shortName(r.slug))}</span>
      <span class="aw ${wired ? 'on' : 'off'}">${wired ? '已接通' : '未接线'}</span>
      ${rooms.map((rm) => `<button class="ax" data-rm="${esc(r.slug)}" data-rmroom="${esc(rm.room_id)}" data-by="${esc(rm.owner || slug)}">移出 ${esc(rm.name || shortName(rm.room_id))}</button>`).join('')}
      ${rooms.length === 0 ? '<span class="arm">未进房</span>' : ''}
    </div>`;
  }).join('');
  box.querySelectorAll('.ax').forEach((b) => {
    b.onclick = async () => {
      const res = await window.zjz.post('/api/agents/remove', { slug: b.dataset.rm, room_id: b.dataset.rmroom, by: b.dataset.by });
      const msg = $('agInviteMsg');
      if (res && res.ok) {
        msg.className = 'amsg ok';
        const still = (res.still_in_rooms || []).length;
        msg.textContent = `已移出「${shortName(b.dataset.rmroom)}」` + (still ? `（还在 ${still} 个房）` : '（已退出所有房）');
        loadAgents();
      } else {
        msg.className = 'amsg bad';
        msg.textContent = (res && res.code ? res.code + '：' : '') + (res && res.message ? res.message : '移出失败');
      }
    };
  });
}

// —— 主题：深色/浅色可选 ——
function applyTheme(name) {
  if (name === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  localStorage.setItem('zjz.theme', name);
  const b = document.getElementById('themeBtn');
  if (b) b.textContent = name === 'light' ? '☾ 深色' : '☀ 浅色';
}

// —— 启动 ——
(async function main() {
  applyTheme(localStorage.getItem('zjz.theme') || 'dark');
  $('themeBtn').onclick = () => applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
  // 页签切换
  $('tabChat').onclick = () => switchView('chat');
  $('tabAgents').onclick = () => switchView('agents');
  // 开新项目房
  $('agCreate').onclick = async () => {
    const msg = $('agCreateMsg'); msg.className = 'amsg'; msg.textContent = '';
    const name = $('agName').value.trim();
    const by = slug;
    if (!by) { msg.className = 'amsg bad'; msg.textContent = '先在左侧选一个身份（建房人/房主）'; return; }
    if (!name) { msg.className = 'amsg bad'; msg.textContent = '先给项目房起个名字'; return; }
    const r = await window.zjz.post('/api/rooms/create', { name, by });
    if (r && r.ok) {
      msg.className = 'amsg ok'; msg.textContent = `已开项目房「${r.name || name}」`;
      $('agCreated').innerHTML = `<div class="acard" style="margin:10px 0 0"><b>${esc(r.name || name)}</b>　房号 <code style="color:var(--gold)">${esc(r.room_id)}</code>
        <div style="font-size:11px;color:var(--dim2);margin-top:5px">邀请码（凭码请智能体/成员进房）：</div>
        <div style="font-size:19px;letter-spacing:3px;color:var(--gold);font-weight:700;margin:3px 0">${esc(r.invite_code || '')}</div>
        <button class="abtn ghost" id="agCopy">复制邀请码</button></div>`;
      $('agName').value = '';
      $('agCopy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText(r.invite_code || ''); $('agCopy').textContent = '已复制'; };
      await Promise.all([loadRooms(), loadAgentRooms()]);
    } else {
      msg.className = 'amsg bad'; msg.textContent = (r && r.code ? r.code + '：' : '') + (r && r.message ? r.message : '建房失败');
    }
  };
  // 请智能体
  $('agInvite').onclick = async () => {
    const msg = $('agInviteMsg'); msg.className = 'amsg'; msg.textContent = '';
    const name = $('agDispName').value.trim();
    const room_id = $('agRoom').value;
    const exe = $('agExe').value.trim();
    const args = String($('agArgs').value || '').trim().split(/\s+/).filter(Boolean);
    const argv = [exe, ...args];
    if (!room_id) { msg.className = 'amsg bad'; msg.textContent = '先选一个项目房间'; return; }
    if (!exe) { msg.className = 'amsg bad'; msg.textContent = '先填可执行文件'; return; }
    if (!argv.some((x) => x.includes('{task}'))) { msg.className = 'amsg bad'; msg.textContent = '参数里必须含 {task}（房讯从这进去）'; return; }
    const r = await window.zjz.post('/api/agents/invite', {
      name: name || undefined, slug: name || undefined, room_id,
      adapter_kind: 'spawn', argv, wake_policy: $('agWake').value, by: slug,
      timeout_ms: Number($('agTimeout').value) || 600000,
    });
    if (r && r.ok) {
      msg.className = 'amsg ok';
      msg.textContent = `已请进帐：${shortName(r.slug)}（${r.joined}，${r.wiring && r.wiring.wired ? '已接通' : '待接线'}）`;
      loadAgents();
    } else {
      msg.className = 'amsg bad';
      msg.textContent = (r && r.code ? r.code + '：' : '') + (r && r.message ? r.message : '邀请失败');
    }
  };
  $('sendBtn').onclick = sendMsg;
  $('msgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMsg(); });
  $('newRoom').onclick = async () => {
    const name = prompt('新项目房间叫什么名字？');
    if (!name) return;
    const by = slug || prompt('用哪个身份建房（房主）？');
    if (!by) return;
    const r = await window.zjz.post('/api/rooms/create', { name, by });
    if (r && r.ok) {
      alert(`已开项目房「${r.name || name}」\n邀请码：${r.invite_code}\n\n凭码请智能体/成员进房。`);
      slug = by; localStorage.setItem('zjz.slug', slug);
      await Promise.all([loadRooms(), loadAgentRooms()]);
    } else {
      alert(`建房失败：${r && r.code} ${r && r.message}`);
    }
  };
  // 当前身份必须属于本 home；换 home/清数据后，旧 localStorage 不得挡住首启建房
  const memberState = await window.zjz.get('/api/members');
  const available = (memberState && memberState.slugs) || [];
  if (!slug || !available.includes(slug)) {
    slug = available[0] || '';
    if (slug) {
      localStorage.setItem('zjz.slug', slug);
    } else {
      const created = await window.zjz.post('/api/identity/create', { name: '主人' });
      if (created && created.ok && created.slug) {
        slug = created.slug;
        localStorage.setItem('zjz.slug', slug);
      }
    }
  }
  await tickHealth();
  await loadRooms();
  startPoll();
})();
