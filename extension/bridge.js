// ============================================================
// 당근 자동응답 봇 - bridge (localhost 웹앱 <-> 확장)
// window.postMessage로 페이지와 양방향 통신
// Extension context invalidated 방어 포함
// ============================================================

const TAG = '[당근봇 bridge]';
console.log(TAG, 'loaded on', location.href);

const PAGE = 'danggeun-autobot-page';
const EXT = 'danggeun-autobot-ext';

function isExtAlive() {
  try { return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id; }
  catch { return false; }
}

async function safeStorageGet(keys) {
  if (!isExtAlive()) return {};
  try { return await chrome.storage.local.get(keys); } catch { return {}; }
}
async function safeStorageSet(obj) {
  if (!isExtAlive()) return;
  try { await chrome.storage.local.set(obj); } catch {}
}

function postToPage(payload) {
  try {
    window.postMessage({ source: EXT, ...payload }, location.origin);
  } catch (e) { /* page 닫힘 등 */ }
}

async function sendCurrentRooms() {
  const { daangn_rooms, daangn_rooms_updated_at } = await safeStorageGet([
    'daangn_rooms',
    'daangn_rooms_updated_at',
  ]);
  postToPage({
    type: 'ROOMS',
    rooms: daangn_rooms || [],
    updatedAt: daangn_rooms_updated_at || null,
  });
}

// 페이지에서 오는 요청 수신
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== PAGE) return;

  switch (data.type) {
    case 'PING':
      postToPage({
        type: 'PONG',
        version: isExtAlive() ? chrome.runtime.getManifest().version : '0.0.0',
      });
      break;
    case 'GET_ROOMS':
      sendCurrentRooms();
      break;
    case 'SYNC_CONFIG':
      {
        const payload = { webapp_config: data.config || {} };
        if (typeof data.apiKey === 'string') payload.webapp_apikey = data.apiKey;
        safeStorageSet(payload).then(() => {
          postToPage({ type: 'CONFIG_SYNCED', at: Date.now() });
        });
      }
      break;
    default:
      break;
  }
});

// chrome.storage 변경시 자동으로 페이지에 푸시
if (isExtAlive()) {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.daangn_rooms) {
        postToPage({
          type: 'ROOMS',
          rooms: changes.daangn_rooms.newValue || [],
          updatedAt: Date.now(),
        });
      }
    });
  } catch (e) { console.warn(TAG, 'onChanged 등록 실패:', e); }
}

// 브릿지 준비 완료 알림을 여러 번 송신 (타이밍 레이스 방지)
const readyTimes = [50, 300, 800, 1500, 3000];
for (const delay of readyTimes) {
  setTimeout(() => {
    postToPage({ type: 'BRIDGE_READY', version: isExtAlive() ? chrome.runtime.getManifest().version : '0.0.0' });
    sendCurrentRooms();
  }, delay);
}
