// ============================================================
// 당근 자동응답 봇 - popup script (v0.3)
// 시스템 상태 + 방 목록 + 결정 로그 3단 구성
// ============================================================

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function setStatCard(id, cls, labelText, valText) {
  const el = document.getElementById(id);
  el.className = `stat ${cls}`;
  el.innerHTML = `<div class="label">${escapeHtml(labelText)}</div><div class="val">${escapeHtml(valText)}</div>`;
}

function showWebappAlert(tabOpen, apiKey, products) {
  const holder = document.getElementById('webappAlert');
  if (!holder) return;

  if (!tabOpen) {
    holder.style.display = 'block';
    holder.innerHTML = `
      <div class="alert alert-err">
        <div class="alert-title">⚠️ 웹앱 탭이 열려있지 않아요</div>
        <div class="alert-body">
          설정·API키·상품은 웹앱(<code>localhost:5173</code>)에서 관리합니다.
          <br><strong>먼저 <code>실행.bat</code>을 더블클릭해 웹앱을 켜세요.</strong>
          <br>그래도 이 메시지가 뜨면 확장을 <strong>새로고침</strong>해 주세요 (chrome://extensions).
        </div>
      </div>`;
    return;
  }

  if (!apiKey || products.length === 0) {
    holder.style.display = 'block';
    const missing = [];
    if (!apiKey) missing.push('Gemini API 키');
    if (products.length === 0) missing.push('상품 등록');
    holder.innerHTML = `
      <div class="alert alert-warn">
        <div class="alert-title">📝 웹앱에서 입력 필요</div>
        <div class="alert-body">
          <strong>${escapeHtml(missing.join(', '))}</strong>이(가) 비어 있어요.
          <br>웹앱 탭으로 가서 입력 후 <strong>"전체 저장"</strong> 눌러 주세요.
          <br>저장되면 여기에 자동 반영됩니다.
        </div>
      </div>`;
    return;
  }

  holder.style.display = 'none';
  holder.innerHTML = '';
}

function formatTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

async function safeStorageGet(keys) {
  try { return await chrome.storage.local.get(keys); } catch { return {}; }
}

async function refresh() {
  const {
    daangn_rooms, daangn_rooms_updated_at,
    webapp_config, webapp_apikey,
    handoff_state, decision_log,
  } = await safeStorageGet([
    'daangn_rooms', 'daangn_rooms_updated_at',
    'webapp_config', 'webapp_apikey',
    'handoff_state', 'decision_log',
  ]);

  // 웹앱 탭 열려있는지 감지
  let webappTabOpen = false;
  try {
    const tabs = await chrome.tabs.query({ url: ['http://localhost/*', 'https://localhost/*', 'http://127.0.0.1/*'] });
    webappTabOpen = tabs.length > 0;
  } catch {}

  // 시스템 상태 타일
  if (webapp_apikey && webapp_apikey.length > 10) {
    setStatCard('statApi', 'stat-ok', 'Gemini API 키', `✓ 설정됨 (${webapp_apikey.slice(0, 6)}…)`);
  } else if (!webappTabOpen) {
    setStatCard('statApi', 'stat-err', 'Gemini API 키', '✗ 웹앱 탭 없음');
  } else {
    setStatCard('statApi', 'stat-err', 'Gemini API 키', '✗ 미설정 (웹앱에서 입력)');
  }

  const products = webapp_config?.products || [];
  if (products.length > 0) {
    setStatCard('statProducts', 'stat-ok', '상품 등록', `✓ ${products.length}개`);
  } else if (!webappTabOpen) {
    setStatCard('statProducts', 'stat-err', '상품 등록', '✗ 웹앱 탭 없음');
  } else {
    setStatCard('statProducts', 'stat-err', '상품 등록', '✗ 0개');
  }

  // 웹앱 탭이 없으면 맨 위에 큰 경고
  showWebappAlert(webappTabOpen, webapp_apikey || '', products);

  const rooms = daangn_rooms || [];
  const nonOfficial = rooms.filter((r) => !r.official);
  if (rooms.length > 0) {
    setStatCard('statRooms', 'stat-ok', '동기화된 방', `${nonOfficial.length}개 + 공식 ${rooms.length - nonOfficial.length}`);
  } else {
    setStatCard('statRooms', 'stat-warn', '동기화된 방', '0 (당근 탭 열기)');
  }

  const handoffCount = Object.keys(handoff_state || {}).length;
  if (handoffCount > 0) {
    setStatCard('statHandoffs', 'stat-warn', '핸드오프 중', `${handoffCount}개 방 정지`);
  } else {
    setStatCard('statHandoffs', 'stat-ok', '핸드오프 중', '없음');
  }

  // 방 목록
  renderRooms(rooms);

  // 결정 로그
  renderLog(decision_log || []);

  // 시간
  document.getElementById('updated').textContent = formatTime(Date.now());
}

function renderRooms(rooms) {
  const container = document.getElementById('rooms');
  const count = document.getElementById('count');
  const displayRooms = rooms.filter((r) => !r.official);

  if (displayRooms.length === 0) {
    count.textContent = '';
    container.innerHTML = '<div class="empty"><div class="empty-icon">💤</div>chat.daangn.com 탭을 열어주세요.</div>';
    return;
  }

  count.textContent = `(${displayRooms.length})`;
  container.innerHTML = '';
  for (const r of displayRooms) {
    const row = document.createElement('div');
    row.className = 'room';
    const initial = (r.nickname || '?').charAt(0);
    const title = r.articleTitle ? r.articleTitle.slice(0, 36) : (r.lastMessage || '').slice(0, 36);
    row.innerHTML = `
      <div class="avatar">${escapeHtml(initial)}</div>
      <div class="title-col">
        <div><strong class="nick">${escapeHtml(r.nickname || '(이름 없음)')}</strong></div>
        <div class="last">${escapeHtml(title)}</div>
      </div>
      ${r.selected ? '<span class="badge badge-selected">현재</span>' : ''}
    `;
    row.addEventListener('click', async () => {
      const url = 'https://chat.daangn.com' + r.roomUrl;
      const tabs = await chrome.tabs.query({ url: 'https://chat.daangn.com/*' });
      if (tabs.length > 0) {
        await chrome.tabs.update(tabs[0].id, { active: true, url });
        await chrome.windows.update(tabs[0].windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url });
      }
    });
    container.appendChild(row);
  }
}

function renderLog(log) {
  const container = document.getElementById('decisionLog');
  if (!log.length) {
    container.innerHTML = '<div class="empty" style="padding:12px">아직 메시지 처리 기록이 없어요.<br>당근에서 메시지를 받으면 여기에 결정이 기록됩니다.</div>';
    return;
  }
  // 최신이 위로
  const sorted = [...log].reverse();
  container.innerHTML = sorted.map((entry) => {
    const cls = entry.action === 'reply' ? 'log-reply'
      : entry.action === 'handoff' ? 'log-handoff'
      : entry.action === 'error' ? 'log-error'
      : 'log-skip';
    const icon = entry.action === 'reply' ? '✅' : entry.action === 'handoff' ? '🚨' : entry.action === 'error' ? '⚠️' : '⏸️';
    const actionKo = entry.action === 'reply' ? '답변' : entry.action === 'handoff' ? '핸드오프' : entry.action === 'error' ? '오류' : '건너뜀';

    const parts = [];
    parts.push(`<div class="log-title">${icon} ${actionKo} <span class="log-time">${formatTime(entry.at)}</span></div>`);
    if (entry.textSnippet) parts.push(`<div>💬 "${escapeHtml(entry.textSnippet)}"</div>`);
    if (entry.product) parts.push(`<div>📦 ${escapeHtml(entry.product)}</div>`);
    if (entry.reason) parts.push(`<div class="log-reason">→ ${escapeHtml(entry.reason)}</div>`);
    if (entry.reply) parts.push(`<div>🥕 ${escapeHtml(entry.reply)}</div>`);
    return `<div class="log-entry ${cls}">${parts.join('')}</div>`;
  }).join('');
}

// 초기 로드
refresh();

// 실시간 업데이트
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.daangn_rooms || changes.decision_log || changes.webapp_config || changes.webapp_apikey || changes.handoff_state) {
    refresh();
  }
});

// 새로고침 버튼
document.getElementById('refreshBtn').addEventListener('click', refresh);

// 로그 지우기
document.getElementById('clearLogBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({ decision_log: [] });
  refresh();
});

// 당근 채팅 열기
document.getElementById('openDaangn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: 'https://chat.daangn.com/*' });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: 'https://chat.daangn.com/' });
  }
  window.close();
});
