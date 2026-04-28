// ============================================================
// 당근 자동응답 봇 - content script (v0.3)
// chat.daangn.com 에 주입
//
// 기능:
//  1) 사이드바 방 목록 실시간 동기화
//  2) 현재 방 글 제목 정확 추출 + 캐시
//  3) 새 메시지(구매자 발신) 감지 → background
//  4) background → INJECT_REPLY 수신시 사람처럼 입력창에 답변 주입 + 전송
//  5) 채팅 종료 감지 (감사/종결어/거래완료) → 자동 정지 + 배너
//  6) 핸드오프 배너 (Shadow DOM, 당근 CSS와 격리)
// ============================================================

const TAG = '[당근봇]';
console.log(TAG, 'content script loaded at', location.href);

// ============================================================
// Extension context 방어 (재로드 감지 + 안전 호출)
// ============================================================
function isExtAlive() {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  } catch { return false; }
}

let reloadBannerShown = false;
function showReloadBanner() {
  if (reloadBannerShown) return;
  reloadBannerShown = true;
  try {
    const div = document.createElement('div');
    div.id = 'danggeun-bot-reload-notice';
    div.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#f59e0b;color:white;padding:10px 16px;z-index:2147483646;text-align:center;font-family:Pretendard,-apple-system,sans-serif;font-size:13px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,0.15);';
    div.innerHTML = '⚠️ 당근봇 확장이 업데이트/재로드됐어요. <u>이 페이지를 새로고침(Ctrl+R)</u> 해주세요. <button id="danggeun-bot-reload-btn" style="margin-left:12px;background:white;color:#d97706;border:0;padding:4px 10px;border-radius:6px;font-weight:700;cursor:pointer;">새로고침</button>';
    document.body?.appendChild(div);
    const btn = div.querySelector('#danggeun-bot-reload-btn');
    if (btn) btn.onclick = () => location.reload();
  } catch {}
}

async function safeSend(msg) {
  if (!isExtAlive()) { showReloadBanner(); return null; }
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    const m = e?.message || String(e);
    if (m.includes('context invalidated') || m.includes('Extension context') || m.includes('could not establish connection')) {
      showReloadBanner();
    } else {
      console.warn(TAG, 'sendMessage 실패:', m);
    }
    return null;
  }
}

async function safeStorageGet(keys) {
  if (!isExtAlive()) { showReloadBanner(); return {}; }
  try { return await chrome.storage.local.get(keys); }
  catch (e) {
    if (String(e?.message).includes('context invalidated')) showReloadBanner();
    return {};
  }
}

async function safeStorageSet(obj) {
  if (!isExtAlive()) { showReloadBanner(); return; }
  try { await chrome.storage.local.set(obj); }
  catch (e) {
    if (String(e?.message).includes('context invalidated')) showReloadBanner();
  }
}

function safeOnMessage(handler) {
  if (!isExtAlive()) return;
  try { chrome.runtime.onMessage.addListener(handler); }
  catch (e) { console.warn(TAG, 'onMessage 등록 실패:', e); }
}

// ============================================================
// 방 글 제목 캐시
// ============================================================
let articleTitleCache = {};
async function loadCacheFromStorage() {
  const { daangn_article_title_cache } = await safeStorageGet('daangn_article_title_cache');
  articleTitleCache = daangn_article_title_cache || {};
}
function saveCacheToStorage() {
  safeStorageSet({ daangn_article_title_cache: articleTitleCache });
}

// ============================================================
// 사이드바 스크래핑
// ============================================================
function isOfficialAccount(li) {
  const badge = li.querySelector('.badge-wrapper');
  if (!badge) return false;
  return !!badge.querySelector('path[fill="#00B493"]');
}
function scrapeSidebar() {
  const list = document.querySelector('ul[aria-label="내 채널 리스트"]');
  if (!list) return null;
  const rooms = [];
  for (const li of list.querySelectorAll('li')) {
    const anchor = li.querySelector('a[href^="/room/"]');
    if (!anchor) continue;
    const roomUrl = anchor.getAttribute('href');
    const nickname = li.querySelector('.preview-nickname')?.textContent?.trim() || '';
    const lastMessage = li.querySelector('.preview-description .description-text')?.textContent?.trim() || '';
    const subText = li.querySelector('.sub-text')?.textContent?.trim() || '';
    const thumbnailAlt = li.querySelector('.preview-image')?.alt || '';
    const profileImg = li.querySelector('.profile-image')?.src || '';
    const official = isOfficialAccount(li);
    const selected = anchor.classList.contains('selected');
    const articleTitle = articleTitleCache[roomUrl] || thumbnailAlt;
    rooms.push({ roomUrl, nickname, lastMessage, subText, articleTitle, profileImg, official, selected });
  }
  return rooms;
}

let lastSnapshot = '';
function pushSidebarToStorage() {
  const rooms = scrapeSidebar();
  if (!rooms) return;
  const fingerprint = rooms.map((r) => `${r.roomUrl}|${r.lastMessage}|${r.selected}|${r.articleTitle}`).join('||');
  if (fingerprint === lastSnapshot) return;
  lastSnapshot = fingerprint;
  safeStorageSet({ daangn_rooms: rooms, daangn_rooms_updated_at: Date.now() });
  console.log(TAG, '사이드바 동기화', rooms.length, '개 방');
}
let sidebarDebounceTimer;
function debouncedSidebarPush() {
  clearTimeout(sidebarDebounceTimer);
  sidebarDebounceTimer = setTimeout(pushSidebarToStorage, 300);
}

// ============================================================
// 현재 방 감지 + 글 제목 추출 + 거래완료 감지
// ============================================================
function getCurrentRoomUrl() {
  const m = location.pathname.match(/^\/room\/[^/?#]+/);
  return m ? m[0] : null;
}
function extractCurrentArticleTitle() {
  const img = document.querySelector('a[href*="/articles/"] img.article-image');
  if (img?.alt) return img.alt;
  const titleDiv = document.querySelector('a[href*="/articles/"] .reserved-main > div:first-child');
  return titleDiv?.textContent?.trim() || null;
}
function isCurrentRoomClosed() {
  // 거래완료 배지 확인
  const btn = document.querySelector('.reserve-button');
  if (!btn) return false;
  return btn.classList.contains('closed') || btn.textContent?.includes('거래완료');
}
function updateCurrentRoomTitle() {
  const roomUrl = getCurrentRoomUrl();
  if (!roomUrl) return;
  const title = extractCurrentArticleTitle();
  if (!title) return;
  if (articleTitleCache[roomUrl] === title) return;
  articleTitleCache[roomUrl] = title;
  saveCacheToStorage();
  console.log(TAG, '방 글 제목 캐시:', roomUrl, '→', title);
  lastSnapshot = '';
  debouncedSidebarPush();
}

// ============================================================
// 채팅 종료 감지 (자동 정지 시그널)
// ============================================================
const END_OF_CONV_PATTERNS = [
  /^감사합니다?!?\s*[.~!]*\s*$/,
  /^감사해요[!~.]*$/,
  /^고맙습니다[!~.]*$/,
  /^고마워요[!~.]*$/,
  /^안녕히\s*(계세요|가세요)/,
  /^수고하세요/,
  /^좋은 하루/,
  /^다음에 (봬요|뵙겠습니다)/,
  /잘\s*받았(어요|습니다)/,
  /거래\s*완료/,
];
function isEndOfConversation(text) {
  const t = (text || '').trim();
  if (!t) return false;
  return END_OF_CONV_PATTERNS.some((re) => re.test(t));
}

// ============================================================
// 새 메시지 감지
// ============================================================
let currentRoomBaseline = -1;
let messageObserver = null;

function extractMessageId(el) {
  const id = el?.id || '';
  const m = id.match(/for-scroll-(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
function getAllMessageIds() {
  return Array.from(document.querySelectorAll('[id^="for-scroll-"]')).map(extractMessageId).filter((n) => n !== null);
}

function processMessageNode(node) {
  if (!(node instanceof Element)) return;
  const container = node.classList?.contains('for-containment') ? node : node.closest?.('.for-containment');
  if (!container) return;

  const isSent = container.classList.contains('right');
  const isReceived = container.classList.contains('left');
  if (!isSent && !isReceived) return;
  if (container.querySelector('.template-message')) return;
  if (container.querySelector('.temp-message-wrap')) return;

  const id = extractMessageId(container);
  if (id === null) return;
  if (id <= currentRoomBaseline) return;
  currentRoomBaseline = id;

  const text = container.querySelector('.message-box')?.textContent?.trim();
  if (!text) return;

  const roomUrl = getCurrentRoomUrl();

  // 판매자(내)가 보낸 메시지이거나 구매자 메시지가 "감사합니다"류면 → 대화 종료 감지
  if (isEndOfConversation(text)) {
    console.log(TAG, '🛑 대화 종료 시그널 감지:', text);
    safeSend({
      type: 'PAUSE_ROOM',
      roomUrl,
      reason: `대화 종료 감지: "${text.slice(0, 20)}"`,
    });
    return;
  }

  // 내가 보낸 메시지는 더 이상 처리 안 함 (봇이 답하면 안 되니까)
  if (isSent) return;

  // 구매자 메시지 → background로 전달
  const articleTitle = articleTitleCache[roomUrl] || extractCurrentArticleTitle() || '';
  console.log(TAG, '🔔 새 메시지:', { roomUrl, id, text });
  safeSend({
    type: 'NEW_MESSAGE',
    roomUrl, articleTitle, messageId: id, text, timestamp: Date.now(),
  });
}

function startMessageObserverForCurrentRoom() {
  const roomUrl = getCurrentRoomUrl();
  if (!roomUrl) return;
  if (messageObserver) {
    messageObserver.disconnect();
    messageObserver = null;
  }
  const listRegion = document.querySelector('div[role="region"][aria-label="메시지 리스트"]');
  if (!listRegion) return;

  const ids = getAllMessageIds();
  currentRoomBaseline = ids.length > 0 ? Math.max(...ids) : -1;
  console.log(TAG, '방 진입:', roomUrl, '기준 ID:', currentRoomBaseline);

  // 거래완료 배지면 방 정지
  if (isCurrentRoomClosed()) {
    console.log(TAG, '🛑 거래완료 상태 - 방 정지:', roomUrl);
    safeSend({ type: 'PAUSE_ROOM', roomUrl, reason: '거래완료 상태' });
  }

  messageObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) processMessageNode(node);
    }
  });
  messageObserver.observe(listRegion, { childList: true, subtree: true });
}

// ============================================================
// 답변 주입 (React-safe)
// ============================================================
function setReactInputValue(element, value) {
  const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

async function injectReply({ roomUrl, text, delayMs }) {
  // 주입 시점의 현재 방이 일치하는지 확인
  if (getCurrentRoomUrl() !== roomUrl) {
    console.warn(TAG, '방이 바뀌어서 주입 취소:', roomUrl, '→', getCurrentRoomUrl());
    return;
  }

  const textarea = document.querySelector('form textarea[placeholder="메시지를 입력해주세요"]');
  if (!textarea) {
    console.warn(TAG, '입력창 없음 - 주입 실패');
    return;
  }

  // 사용자가 이미 뭔가 입력 중이면 주입 중단 (실수로 덮어쓰기 방지)
  if (textarea.value && textarea.value.trim().length > 0) {
    console.warn(TAG, '사용자 입력 중 - 주입 취소');
    return;
  }

  console.log(TAG, `⏳ ${Math.round(delayMs / 1000)}초 후 답변 전송: "${text}"`);
  await new Promise((r) => setTimeout(r, delayMs));

  // 지연 중 방 전환했거나 사용자가 타이핑 시작했으면 취소
  if (getCurrentRoomUrl() !== roomUrl) {
    console.warn(TAG, '지연 중 방 전환 - 취소');
    return;
  }
  if (textarea.value && textarea.value.trim().length > 0) {
    console.warn(TAG, '지연 중 사용자 타이핑 - 취소');
    return;
  }

  // 입력창 포커스 + 값 설정
  textarea.focus();
  setReactInputValue(textarea, text);

  // React 상태 반영 잠깐 대기
  await new Promise((r) => setTimeout(r, 150));

  // 전송 버튼 찾기
  const form = textarea.closest('form');
  const buttons = form ? [...form.querySelectorAll('button')] : [];
  const sendBtn = buttons.find((b) => b.textContent?.trim() === '전송');
  if (!sendBtn) {
    console.warn(TAG, '전송 버튼 없음');
    return;
  }
  if (sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true') {
    console.warn(TAG, '전송 버튼 비활성화 상태 - 입력 이벤트 재시도');
    // React 상태 미반영일 수 있어 다시 이벤트 발사
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
  }

  if (sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true') {
    console.warn(TAG, '전송 버튼 여전히 비활성화. Enter 키로 재시도.');
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return;
  }

  sendBtn.click();
  console.log(TAG, '✅ 전송 완료:', text);
}

// ============================================================
// 핸드오프 배너 (Shadow DOM)
// ============================================================
let bannerHost = null;
function ensureBannerHost() {
  if (bannerHost && document.body.contains(bannerHost)) return bannerHost;
  bannerHost = document.createElement('div');
  bannerHost.id = 'danggeun-bot-banner-host';
  bannerHost.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none;';
  document.body.appendChild(bannerHost);
  bannerHost.attachShadow({ mode: 'open' });
  bannerHost.shadowRoot.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { pointer-events: auto; display: flex; justify-content: center; padding: 8px 16px; }
      .banner { display: flex; align-items: center; gap: 12px; background: linear-gradient(135deg, #ef4444, #f97316); color: white; padding: 10px 14px; border-radius: 10px; box-shadow: 0 4px 20px rgba(239,68,68,0.4); font-family: Pretendard, -apple-system, sans-serif; max-width: 720px; width: 100%; animation: slide 0.3s ease; }
      @keyframes slide { from { transform: translateY(-20px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
      .icon { font-size: 20px; flex-shrink: 0; }
      .body { flex: 1; min-width: 0; }
      .title { font-weight: 700; font-size: 13px; line-height: 1.3; }
      .reason { font-size: 12px; opacity: 0.95; margin-top: 2px; }
      .actions { display: flex; gap: 6px; flex-shrink: 0; }
      button { background: rgba(255,255,255,0.2); color: white; border: 1px solid rgba(255,255,255,0.3); padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; }
      button:hover { background: rgba(255,255,255,0.3); }
      button.primary { background: white; color: #dc2626; border-color: white; }
      button.primary:hover { background: #fef2f2; }
    </style>
    <div id="container"></div>
  `;
  return bannerHost;
}

function showHandoffBanner({ roomUrl, reason, source }) {
  // 현재 방이 일치할 때만 표시
  if (getCurrentRoomUrl() !== roomUrl) return;
  const host = ensureBannerHost();
  const sourceText = source === 'keyword' ? '위험 키워드 감지'
    : source === 'llm' ? 'AI 판단'
    : source === 'safety' ? '안전 필터'
    : source === 'end-detect' ? '대화 종료 감지'
    : '사람 확인 필요';
  host.shadowRoot.querySelector('#container').innerHTML = `
    <div class="wrap">
      <div class="banner" role="alert">
        <div class="icon">🚨</div>
        <div class="body">
          <div class="title">봇 일시 정지 — 사람 확인 필요</div>
          <div class="reason">${reason} <span style="opacity:0.7">(${sourceText})</span></div>
        </div>
        <div class="actions">
          <button class="primary" id="resume">봇 재개</button>
          <button id="close">닫기</button>
        </div>
      </div>
    </div>
  `;
  host.shadowRoot.querySelector('#resume').onclick = () => {
    safeSend({ type: 'RESUME_BOT', roomUrl });
    hideHandoffBanner();
  };
  host.shadowRoot.querySelector('#close').onclick = hideHandoffBanner;
}
function hideHandoffBanner() {
  if (bannerHost?.shadowRoot) {
    bannerHost.shadowRoot.querySelector('#container').innerHTML = '';
  }
}

// 방 진입시 현재 핸드오프 상태가 있으면 배너 띄우기
async function reloadHandoffBannerForCurrentRoom() {
  const roomUrl = getCurrentRoomUrl();
  if (!roomUrl) { hideHandoffBanner(); return; }
  const { handoff_state } = await safeStorageGet('handoff_state');
  const state = handoff_state?.[roomUrl];
  if (state) {
    showHandoffBanner({ roomUrl, reason: state.reason, source: state.source });
  } else {
    hideHandoffBanner();
  }
}

// ============================================================
// background → content 메시지 수신
// ============================================================
safeOnMessage((msg, sender, sendResponse) => {
  if (msg.type === 'INJECT_REPLY') {
    injectReply(msg);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'SHOW_HANDOFF_BANNER') {
    showHandoffBanner(msg);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'HIDE_HANDOFF_BANNER') {
    hideHandoffBanner();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

// ============================================================
// SPA 라우팅 훅
// ============================================================
(function hookHistory() {
  const _push = history.pushState;
  const _replace = history.replaceState;
  history.pushState = function () { _push.apply(this, arguments); window.dispatchEvent(new Event('locationchange')); };
  history.replaceState = function () { _replace.apply(this, arguments); window.dispatchEvent(new Event('locationchange')); };
  window.addEventListener('popstate', () => window.dispatchEvent(new Event('locationchange')));
})();

function onRoomChanged() {
  console.log(TAG, '방 변경:', location.pathname);
  debouncedSidebarPush();
  setTimeout(() => {
    updateCurrentRoomTitle();
    startMessageObserverForCurrentRoom();
    reloadHandoffBannerForCurrentRoom();
  }, 800);
}
window.addEventListener('locationchange', onRoomChanged);

// ============================================================
// 초기화
// ============================================================
let sidebarAttached = false;
const waitForSidebar = setInterval(() => {
  if (sidebarAttached) { clearInterval(waitForSidebar); return; }
  const list = document.querySelector('ul[aria-label="내 채널 리스트"]');
  if (!list) return;
  sidebarAttached = true;
  clearInterval(waitForSidebar);
  console.log(TAG, '사이드바 감시 시작');
  pushSidebarToStorage();
  new MutationObserver(debouncedSidebarPush).observe(list, { childList: true, subtree: true, characterData: true });
}, 500);

loadCacheFromStorage().then(() => {
  setTimeout(() => {
    updateCurrentRoomTitle();
    startMessageObserverForCurrentRoom();
    reloadHandoffBannerForCurrentRoom();
  }, 1500);
});

// 디버그 헬퍼
window.__daangnBot = {
  scrapeSidebar,
  getCurrentRoomUrl,
  extractCurrentArticleTitle,
  isCurrentRoomClosed,
  articleTitleCache: () => ({ ...articleTitleCache }),
  baseline: () => currentRoomBaseline,
  showBanner: (reason) => showHandoffBanner({ roomUrl: getCurrentRoomUrl(), reason: reason || '테스트', source: 'keyword' }),
  hideBanner: hideHandoffBanner,
  // 수동 테스트: 한 줄로 전 chain (background → Gemini → 주입) 검증
  test: async (fakeText = '상태 어떤가요?') => {
    const roomUrl = getCurrentRoomUrl();
    const articleTitle = extractCurrentArticleTitle();
    console.log(TAG, '🧪 수동 테스트 전송:', { roomUrl, articleTitle, fakeText });
    if (!roomUrl) { console.error(TAG, '현재 방이 없어요. 채팅방 하나 열고 다시 실행하세요.'); return; }
    const res = await safeSend({
      type: 'NEW_MESSAGE',
      roomUrl, articleTitle, messageId: 999999, text: fakeText, timestamp: Date.now(),
    });
    console.log(TAG, '🧪 응답:', res);
    return res;
  },
  // 현재 상태 진단
  diag: async () => {
    const storage = isExtAlive() ? await safeStorageGet(null) : {};
    return {
      extAlive: isExtAlive(),
      page: { room: getCurrentRoomUrl(), title: extractCurrentArticleTitle(), closed: isCurrentRoomClosed(), baseline: currentRoomBaseline },
      textareaExists: !!document.querySelector('form textarea[placeholder="메시지를 입력해주세요"]'),
      listRegionExists: !!document.querySelector('div[role="region"][aria-label="메시지 리스트"]'),
      storage: {
        rooms: (storage.daangn_rooms || []).length,
        apiKey: storage.webapp_apikey ? storage.webapp_apikey.slice(0, 6) + '…' : '없음',
        products: (storage.webapp_config?.products || []).length,
        handoffs: Object.keys(storage.handoff_state || {}).length,
        decisionLog: (storage.decision_log || []).length,
      },
    };
  },
  dump: () => ({
    room: getCurrentRoomUrl(),
    title: extractCurrentArticleTitle(),
    closed: isCurrentRoomClosed(),
    baseline: currentRoomBaseline,
    cache: { ...articleTitleCache },
    rooms: scrapeSidebar(),
  }),
};
