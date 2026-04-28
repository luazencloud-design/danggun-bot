import React, { useState, useRef, useEffect, useMemo } from 'react';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ChevronLeft, MoreVertical, Plus, Send, Settings, Save, MessageCircle, RotateCcw, Check, Package, Key, AlertCircle, Link2, Loader2, Download, X, Play, ShieldAlert, Trash2, ChevronDown, ChevronUp, Copy } from 'lucide-react';

// ============================================================
// 상수 / 기본값
// ============================================================
const STORAGE_CONFIG_KEY = 'danggeun_autobot_config_v2';
const STORAGE_APIKEY = 'danggeun_autobot_gemini_apikey';
const MODEL_CHAT = 'gemini-2.5-flash';
const MODEL_IMPORT = 'gemini-2.5-flash';

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'p_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function createEmptyProduct(label = '새 상품') {
  return {
    id: newId(),
    label,
    articleTitle: '',
    enabled: false, // 새 상품은 기본 OFF (설정 완료 후 사용자가 켜도록)
    productName: '',
    askingPrice: 0,
    minPrice: 0,
    negoPolicy: 'small',
    condition: '',
    includes: '',
    extraInfo: '',
    // 거래 방법은 둘 중 하나만 선택 (답변 못하는 케이스 방지)
    tradeMethod: 'local', // 'local' | 'shipping'
    shippingNote: '',
    localNote: '',
    tone: 'friendly',
    customRules: '',
  };
}

// 기존 데이터(shippingAvailable/localAvailable) → 새 모델(tradeMethod)
function migrateProduct(p) {
  if (p.tradeMethod) return p; // 이미 마이그레이션됨
  const { shippingAvailable, localAvailable, ...rest } = p;
  let tradeMethod = 'local';
  if (shippingAvailable && !localAvailable) tradeMethod = 'shipping';
  else if (localAvailable || !shippingAvailable) tradeMethod = 'local';
  return { ...rest, tradeMethod };
}

const SAMPLE_PRODUCT = {
  ...createEmptyProduct('예시 상품'),
  enabled: false, // 예시도 기본 OFF
  articleTitle: '아이폰 14 Pro 256GB 딥퍼플',
  productName: '아이폰 14 Pro 256GB 딥퍼플',
  askingPrice: 780000,
  minPrice: 760000,
  condition: '사용감 적음, 잔기스만 살짝 있음',
  includes: '본체, 박스, 정품 충전케이블, 미개봉 보호필름',
  extraInfo: '배터리 성능 95%, 사용기간 1년 5개월',
  tradeMethod: 'local',
  shippingNote: 'CJ대한통운 익일 발송, 배송비 3,500원 구매자 부담',
  localNote: '역삼역 1번 출구 · 평일 저녁 7시 이후',
};

function createCustomer(nickname = '새 고객') {
  return {
    id: newId(),
    nickname,
    articleTitle: '',
    manualProductId: null, // null = articleTitle로 자동 매칭
    enabled: true,
    note: '',
  };
}

const DEFAULT_CONFIG = {
  products: [SAMPLE_PRODUCT],
  customers: [],
  roomSettings: {}, // {roomUrl: {enabled: bool, manualProductId: string|null}}
};

// 방별 설정 기본값 헬퍼 (설정 없으면 자동 ON + 자동 매칭)
// 항상 모든 필드를 보장하기 위해 deep-merge로 반환
function getRoomSettings(roomSettings, roomUrl) {
  const stored = roomSettings?.[roomUrl] || {};
  const defaults = {
    enabled: true,
    manualProductId: null,
    // 수동 채팅 모드 (봇 OFF와 별개 — background.js가 위험 감지 시 true로 설정)
    manualActive: false,
    manualReason: null,
    manualSource: null, // 'keyword'|'emotion'|'stuck'|'nego2'|'risk'|'villain'|'offtopic'|'llm'|'safety'|'end-detect'
    manualAt: null,
    // 위험도 점수 (0~100, background.js가 메시지별로 누적)
    riskScore: 0,
    // 거래 무관 대화 감지 횟수 (2회 누적시 자동 수동 전환)
    offTopicCount: 0,
    // 대화 종료 직전 마지막으로 거래 정보 수집 시도했는지 (루프 방지)
    askedForTradeInfo: false,
  };
  return {
    ...defaults,
    ...stored,
    // tradeInfo는 nested merge — 직거래는 meetingTime/Place, 택배는 recipient*
    tradeInfo: {
      meetingTime: '',
      meetingPlace: '',
      recipientName: '',
      recipientAddress: '',
      recipientPhone: '',
      ...(stored.tradeInfo || {}),
    },
  };
}

// 방의 거래 정보가 모두 채워졌는지 확인 (필터·자동 수집 트리거에 사용)
function isTradeInfoComplete(tradeInfo, tradeMethod) {
  if (!tradeInfo) return false;
  if (tradeMethod === 'shipping') {
    return !!(tradeInfo.recipientName?.trim() && tradeInfo.recipientAddress?.trim() && tradeInfo.recipientPhone?.trim());
  }
  // local
  return !!(tradeInfo.meetingTime?.trim() && tradeInfo.meetingPlace?.trim());
}

function riskLevelOf(score) {
  if (score >= 50) return 'high';
  if (score >= 20) return 'med';
  return 'low';
}

// 방 현재 상태 계산 (UI 배지·필터에 사용)
function computeRoomStatus(settings, activeProduct) {
  if (!settings.enabled) return 'bot-off';
  if (!activeProduct) return 'no-match';
  if (activeProduct.enabled === false) return 'product-off';
  if (settings.manualActive) return 'manual';
  return 'bot-on';
}

// ============================================================
// 글 제목 매칭 — 공백 무시 + 부분 문자열
// ============================================================
function normalizeForMatch(s) {
  return (s || '').replace(/\s+/g, '').toLowerCase();
}

function matchProductByArticleTitle(products, articleTitle) {
  if (!articleTitle || !products?.length) return null;
  const norm = normalizeForMatch(articleTitle);
  for (const p of products) {
    const configNorm = normalizeForMatch(p.articleTitle);
    if (!configNorm) continue;
    if (norm.includes(configNorm) || configNorm.includes(norm)) {
      return p;
    }
  }
  return null;
}

// ============================================================
// 크롬 확장 브릿지 훅
// ============================================================
const PAGE_SRC = 'danggeun-autobot-page';
const EXT_SRC = 'danggeun-autobot-ext';

const EXT_SESSION_KEY = 'danggeun_ext_seen_this_session';

function useExtensionBridge() {
  const [rooms, setRooms] = useState([]);
  // 세션 중 이전에 확장이 감지됐으면 probing(낙관) 상태로 시작 — 빨강 플래시 방지
  const [status, setStatus] = useState(() => {
    try {
      return sessionStorage.getItem(EXT_SESSION_KEY) === '1' ? 'probing' : 'probing';
    } catch { return 'probing'; }
  });
  const [updatedAt, setUpdatedAt] = useState(null);
  const [version, setVersion] = useState(null);

  useEffect(() => {
    let connected = false;
    let probeCount = 0;

    function postPage(payload) {
      window.postMessage({ source: PAGE_SRC, ...payload }, window.location.origin);
    }

    function markConnected(ver) {
      connected = true;
      setStatus('connected');
      if (ver) setVersion(ver);
      try { sessionStorage.setItem(EXT_SESSION_KEY, '1'); } catch {}
    }

    function handleMessage(event) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== EXT_SRC) return;

      switch (data.type) {
        case 'BRIDGE_READY':
        case 'PONG':
          markConnected(data.version);
          break;
        case 'ROOMS':
          setRooms(Array.isArray(data.rooms) ? data.rooms : []);
          if (data.updatedAt) setUpdatedAt(data.updatedAt);
          markConnected(data.version);
          break;
        default:
          break;
      }
    }

    window.addEventListener('message', handleMessage);

    function doPing() {
      probeCount++;
      postPage({ type: 'PING' });
      postPage({ type: 'GET_ROOMS' });
    }

    // 초기 0.3초 간격으로 최대 10번 빠른 PING (최대 3초간 타이밍 레이스 흡수)
    doPing();
    const fastPing = setInterval(() => {
      if (connected || probeCount >= 10) {
        clearInterval(fastPing);
        return;
      }
      doPing();
    }, 300);

    // 5초 후에도 응답 없으면 disconnected 확정
    const verdictTimer = setTimeout(() => {
      if (!connected) setStatus('disconnected');
    }, 5000);

    // 이후엔 10초마다 폴링 (확장이 나중에 설치/새로고침돼도 자동 감지)
    const slowPoll = setInterval(() => {
      postPage({ type: 'PING' });
    }, 10000);

    return () => {
      window.removeEventListener('message', handleMessage);
      clearInterval(fastPing);
      clearTimeout(verdictTimer);
      clearInterval(slowPoll);
    };
  }, []);

  return { rooms, status, updatedAt, version };
}

// ============================================================
// 핸드오프 감지 (기존 로직 유지)
// ============================================================
const SCAM_PATTERNS = [
  { re: /계좌\s*이체|입금\s*계좌|계좌\s*번호|무통장/, label: '계좌이체·무통장 입금 요청' },
  { re: /카톡|카카오톡|오픈\s*채팅|오카방|오픈카톡/, label: '카톡·외부 메신저 이동 요청' },
  { re: /010[-\s.]?\d{3,4}[-\s.]?\d{4}|핸드폰\s*번호|전화번호/, label: '전화번호·연락처 교환 요청' },
  { re: /외부\s*결제|직접\s*결제|현금\s*결제|직접\s*송금/, label: '외부 결제 요청' },
  { re: /해외\s*배송|해외\s*발송|해외\s*직구/, label: '해외 배송 요청' },
  { re: /이메일\s*주소|메일\s*주소|@[\w-]+\.(com|co\.kr|net|org)/i, label: '이메일·외부 링크 포함' },
  { re: /paypal|페이팔|위챗|wechat|알리페이|alipay/i, label: '해외 결제수단 언급' },
  { re: /중고나라|번개장터|당근\s*외|다른\s*플랫폼/, label: '외부 플랫폼 이동 요청' },
];

function detectScamKeyword(text) {
  for (const { re, label } of SCAM_PATTERNS) if (re.test(text)) return label;
  return null;
}

function parseHandoffTag(text) {
  const m = text.match(/\[HANDOFF\s*:\s*([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

// ============================================================
// App
// ============================================================
export default function App() {
  const [view, setView] = useState('config');

  // localStorage를 useState 초기화 시점에 동기적으로 읽기 (auto-save useEffect가 덮어쓰지 않게)
  const [config, setConfig] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_CONFIG_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed.products) && parsed.products.length > 0) {
          return {
            products: parsed.products.map(migrateProduct),
            customers: Array.isArray(parsed.customers) ? parsed.customers : [],
            roomSettings: (parsed.roomSettings && typeof parsed.roomSettings === 'object') ? parsed.roomSettings : {},
          };
        }
      }
    } catch {}
    return DEFAULT_CONFIG;
  });

  const [apiKey, setApiKey] = useState(() => {
    try { return localStorage.getItem(STORAGE_APIKEY) || ''; } catch { return ''; }
  });
  const [saved, setSaved] = useState(false);
  const [showKeyModal, setShowKeyModal] = useState(() => {
    try { return !localStorage.getItem(STORAGE_APIKEY); } catch { return true; }
  });
  const extension = useExtensionBridge();

  function handleSave() {
    // "전체 저장" 버튼 — 단순 토스트 (실제 저장은 useEffect가 자동 처리)
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  }

  function syncToExtension() {
    try {
      window.postMessage(
        { source: PAGE_SRC, type: 'SYNC_CONFIG', config, apiKey },
        window.location.origin
      );
    } catch {}
  }

  // config나 apiKey가 바뀌면 즉시 localStorage 저장 + 확장 동기화
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(config));
    } catch (e) { console.error('localStorage 저장 실패:', e); }
    syncToExtension();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, apiKey]);

  // 확장이 새로 감지됐을 때도 즉시 설정 재전송
  // (사용자가 확장 설치 전에 설정을 저장한 케이스 구제)
  useEffect(() => {
    if (extension.status === 'connected') {
      syncToExtension();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extension.status]);

  function handleSaveApiKey(key) {
    localStorage.setItem(STORAGE_APIKEY, key);
    setApiKey(key);
    setShowKeyModal(false);
  }

  function handleReset() {
    if (window.confirm('모든 상품 설정을 기본값으로 되돌릴까요?')) setConfig(DEFAULT_CONFIG);
  }

  return (
    <div className="min-h-screen bg-neutral-200 py-4 px-3">
      <style>{`
        @keyframes bubble-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes dot-bounce { 0%, 80%, 100% { transform: scale(0.6); opacity: 0.5; } 40% { transform: scale(1); opacity: 1; } }
        @keyframes slide-down { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pulse-ring { 0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5); } 70% { box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); } 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); } }
        .msg-animate { animation: bubble-in 0.22s ease-out both; }
        .dot { animation: dot-bounce 1.2s infinite ease-in-out both; }
        .dot:nth-child(2) { animation-delay: 0.15s; }
        .dot:nth-child(3) { animation-delay: 0.3s; }
        .saved-toast { animation: slide-down 0.25s ease-out; }
        .fade-in { animation: fade-in 0.3s ease-out; }
        .handoff-banner { animation: slide-down 0.3s ease-out; }
        .handoff-pulse { animation: pulse-ring 2s infinite; }
        .scroll-area::-webkit-scrollbar { width: 4px; height: 4px; }
        .scroll-area::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 4px; }
      `}</style>

      {showKeyModal && <ApiKeyModal onSave={handleSaveApiKey} initialKey={apiKey} />}

      <div className="max-w-[960px] mx-auto">
        <div className="flex items-center justify-between mb-4 px-1">
          <div>
            <h1 className="text-xl font-bold text-neutral-900 flex items-center gap-2">
              <span className="text-2xl">🥕</span> 당근 자동응답 봇
            </h1>
            <p className="text-[12px] text-neutral-500 mt-0.5">다중 상품 · 글 제목 자동 매칭 · 위험 키워드 감지시 수동 전환</p>
          </div>
          <div className="flex items-center gap-2">
            <ExtensionBadge status={extension.status} version={extension.version} roomCount={extension.rooms.length} />
            <button
              onClick={() => setShowKeyModal(true)}
              className={`text-[12px] px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 transition ${
                apiKey ? 'text-neutral-600 bg-white hover:bg-neutral-50 border border-neutral-200' : 'text-white bg-red-500 hover:bg-red-600'
              }`}
            >
              <Key size={12} />
              {apiKey ? 'Gemini 키' : 'API 키 필요'}
            </button>
            <div className="flex items-center gap-1.5 bg-white rounded-full p-1 shadow-sm border border-neutral-200">
              <button
                onClick={() => setView('config')}
                className={`px-3 py-1.5 text-[13px] font-medium rounded-full flex items-center gap-1.5 transition ${
                  view === 'config' ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:text-neutral-900'
                }`}
              >
                <Settings size={14} /> 설정
              </button>
              <button
                onClick={() => setView('chat')}
                className={`px-3 py-1.5 text-[13px] font-medium rounded-full flex items-center gap-1.5 transition ${
                  view === 'chat' ? 'bg-[#FF6F0F] text-white' : 'text-neutral-600 hover:text-neutral-900'
                }`}
              >
                <MessageCircle size={14} /> 채팅 테스트
              </button>
            </div>
          </div>
        </div>

        {view === 'config' ? (
          <ConfigPanel config={config} setConfig={setConfig} onSave={handleSave} onReset={handleReset} saved={saved} apiKey={apiKey} onMissingKey={() => setShowKeyModal(true)} extension={extension} />
        ) : (
          <ChatPanel config={config} apiKey={apiKey} onMissingKey={() => setShowKeyModal(true)} />
        )}
      </div>
    </div>
  );
}

// ============================================================
// ExtensionBadge — 확장 연결 상태 표시
// ============================================================
function ExtensionBadge({ status, version, roomCount }) {
  const statusMap = {
    probing: { color: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-400 animate-pulse', text: '확장 확인 중…' },
    connected: { color: 'bg-green-50 text-green-700 border-green-200', dot: 'bg-green-500', text: `확장 연결됨 · ${roomCount}개 방` },
    disconnected: { color: 'bg-red-50 text-red-600 border-red-200', dot: 'bg-red-400', text: '확장 미설치/비활성' },
  };
  const s = statusMap[status] || statusMap.probing;
  return (
    <div className={`text-[11px] px-2 py-1.5 rounded-lg border flex items-center gap-1.5 ${s.color}`} title={version ? `v${version}` : undefined}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot} ${status === 'connected' ? 'animate-pulse' : ''}`} />
      <span className="font-medium">{s.text}</span>
    </div>
  );
}

// ============================================================
// ApiKeyModal
// ============================================================
function ApiKeyModal({ onSave, initialKey }) {
  const [key, setKey] = useState(initialKey || '');
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
        <div className="flex items-center gap-2 mb-3">
          <Key size={20} className="text-[#FF6F0F]" />
          <h2 className="text-lg font-bold text-neutral-900">Gemini API 키 입력</h2>
        </div>
        <p className="text-[13px] text-neutral-600 mb-4 leading-relaxed">
          이 프로그램은 Google Gemini API를 사용합니다.{' '}
          <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-[#FF6F0F] underline">
            aistudio.google.com
          </a>
          에서 API 키를 무료로 발급받을 수 있어요.
        </p>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="AIza..."
          className="w-full bg-neutral-50 border border-neutral-200 rounded-lg px-3 py-2.5 text-[13px] font-mono focus:outline-none focus:border-[#FF6F0F] focus:bg-white mb-3"
        />
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 flex gap-2">
          <AlertCircle size={16} className="text-amber-600 shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-800 leading-relaxed">
            API 키는 브라우저 로컬 저장소에만 저장됩니다. 본인 PC에서만 사용하세요.
          </p>
        </div>
        <button
          onClick={() => key.trim() && onSave(key.trim())}
          disabled={!key.trim()}
          className="w-full bg-[#FF6F0F] hover:bg-[#ee6200] disabled:bg-neutral-300 text-white font-semibold text-[14px] py-2.5 rounded-lg transition"
        >
          저장하고 시작
        </button>
      </div>
    </div>
  );
}

// ============================================================
// UrlImporter — 선택된 상품에 적용
// ============================================================
function UrlImporter({ onImport, apiKey, onMissingKey, productLabel }) {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState('url');
  const [pasteText, setPasteText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function runGemini({ prompt, useSearch }) {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: MODEL_IMPORT,
      ...(useSearch ? { tools: [{ googleSearch: {} }] } : {}),
    });
    const result = await model.generateContent(prompt);
    return (result.response.text() || '').trim();
  }

  const promptFor = (sourceLabel, sourceBody) => `${sourceLabel}:
${sourceBody}

위에서 당근마켓 상품 정보를 추출해서 JSON으로만 반환:
{
  "productName": "상품 제목 (간결하게)",
  "askingPrice": 판매가격_숫자만,
  "condition": "상품 상태 한 줄 요약",
  "includes": "구성품",
  "extraInfo": "기타 정보 한 줄",
  "localNote": "직거래 동네 (상세주소 제외)"
}
가격은 반드시 숫자로. 정보 없으면 빈 문자열 또는 0. JSON 외 절대 아무것도 포함하지 말 것.`;

  async function handleImportFromUrl() {
    if (!url.trim()) return;
    if (!apiKey) { onMissingKey(); return; }
    setLoading(true); setError(''); setSuccess('');
    try {
      const text = await runGemini({ prompt: promptFor('URL', url.trim()), useSearch: true });
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('상품 정보를 찾지 못했습니다');
      applyToConfig(JSON.parse(jsonMatch[0]));
    } catch (err) {
      console.error(err);
      const msg = err.message || '';
      if (msg.includes('401') || msg.includes('403') || msg.includes('API_KEY')) {
        setError('Gemini API 키가 유효하지 않아요.');
      } else if (msg.includes('parse') || msg.includes('JSON')) {
        setError('페이지에서 상품 정보를 추출하지 못했어요. 직접 복사·붙여넣기를 시도해 보세요.');
      } else {
        setError('URL을 불러오지 못했어요. "직접 붙여넣기" 옵션을 써보세요.');
      }
    } finally { setLoading(false); }
  }

  async function handleImportFromPaste() {
    if (!pasteText.trim()) return;
    if (!apiKey) { onMissingKey(); return; }
    setLoading(true); setError(''); setSuccess('');
    try {
      const text = await runGemini({ prompt: promptFor('당근 상품 설명 텍스트', pasteText.trim()), useSearch: false });
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('parse failed');
      applyToConfig(JSON.parse(jsonMatch[0]));
    } catch (err) {
      console.error(err);
      setError('정보 추출에 실패했어요. 텍스트를 다시 확인해 주세요.');
    } finally { setLoading(false); }
  }

  function applyToConfig(parsed) {
    const updates = {};
    if (parsed.productName) {
      updates.productName = parsed.productName;
      updates.articleTitle = parsed.productName; // 매칭용 글 제목도 같이 채움
    }
    if (parsed.askingPrice && Number(parsed.askingPrice) > 0) {
      updates.askingPrice = Number(parsed.askingPrice);
      updates.minPrice = Math.floor(Number(parsed.askingPrice) * 0.97 / 1000) * 1000;
    }
    if (parsed.condition) updates.condition = parsed.condition;
    if (parsed.includes) updates.includes = parsed.includes;
    if (parsed.extraInfo) updates.extraInfo = parsed.extraInfo;
    if (parsed.localNote) updates.localNote = parsed.localNote;

    onImport(updates);
    setSuccess(`"${parsed.productName || '상품'}" 정보를 "${productLabel}"에 적용했어요! 글 제목 필드도 같이 채웠으니 필요시 수정하세요.`);
    setUrl(''); setPasteText('');
    setTimeout(() => setSuccess(''), 5000);
  }

  return (
    <div className="bg-gradient-to-br from-orange-50 to-amber-50 border border-orange-200 rounded-xl p-3 mb-3 fade-in">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-[#FF6F0F] text-white flex items-center justify-center"><Download size={12} strokeWidth={2.5} /></div>
          <div className="text-[12px] font-semibold text-neutral-900">URL/텍스트로 자동 불러오기</div>
        </div>
        <div className="flex bg-white rounded-lg p-0.5 gap-0.5 border border-orange-200">
          <button onClick={() => setMode('url')} className={`text-[10px] px-2 py-0.5 rounded-md font-medium transition ${mode === 'url' ? 'bg-[#FF6F0F] text-white' : 'text-neutral-500'}`}>URL</button>
          <button onClick={() => setMode('paste')} className={`text-[10px] px-2 py-0.5 rounded-md font-medium transition ${mode === 'paste' ? 'bg-[#FF6F0F] text-white' : 'text-neutral-500'}`}>붙여넣기</button>
        </div>
      </div>
      {mode === 'url' ? (
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <Link2 size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleImportFromUrl()} placeholder="https://www.daangn.com/articles/..." disabled={loading} className="w-full bg-white border border-neutral-200 rounded-lg pl-7 pr-3 py-1.5 text-[11px] focus:outline-none focus:border-[#FF6F0F] disabled:opacity-50" />
          </div>
          <button onClick={handleImportFromUrl} disabled={!url.trim() || loading} className="bg-[#FF6F0F] hover:bg-[#ee6200] disabled:bg-neutral-300 text-white text-[11px] font-semibold px-3 py-1.5 rounded-lg whitespace-nowrap flex items-center gap-1 transition">
            {loading ? <><Loader2 size={11} className="animate-spin" /> 읽는 중</> : '불러오기'}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder="당근 상품 페이지 텍스트 전체를 붙여넣어 주세요." disabled={loading} rows={3} className="w-full bg-white border border-neutral-200 rounded-lg px-2 py-1.5 text-[11px] focus:outline-none focus:border-[#FF6F0F] disabled:opacity-50 resize-none" />
          <button onClick={handleImportFromPaste} disabled={!pasteText.trim() || loading} className="w-full bg-[#FF6F0F] hover:bg-[#ee6200] disabled:bg-neutral-300 text-white text-[11px] font-semibold py-1.5 rounded-lg flex items-center justify-center gap-1 transition">
            {loading ? <><Loader2 size={11} className="animate-spin" /> 분석 중</> : '텍스트에서 불러오기'}
          </button>
        </div>
      )}
      {error && <div className="mt-2 flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-2"><AlertCircle size={12} className="text-red-500 shrink-0 mt-0.5" /><div className="flex-1 text-[10px] text-red-700 leading-relaxed">{error}</div><button onClick={() => setError('')} className="text-red-400 hover:text-red-600"><X size={11} /></button></div>}
      {success && <div className="mt-2 flex items-start gap-2 bg-green-50 border border-green-200 rounded-lg p-2"><Check size={12} className="text-green-600 shrink-0 mt-0.5" /><div className="flex-1 text-[10px] text-green-700 leading-relaxed">{success}</div></div>}
    </div>
  );
}

// ============================================================
// ProductCard — 접기/펼치기 + 편집 세션 (자동 OFF + 팝업 확인)
// ============================================================
const EDIT_AUTO_OFF_FIELDS = new Set([
  'articleTitle', 'productName', 'condition', 'includes', 'extraInfo',
  'askingPrice', 'minPrice', 'negoPolicy', 'shippingAvailable', 'shippingNote',
  'localAvailable', 'localNote', 'tone', 'customRules',
]);
const EDIT_IDLE_MS = 8000;

function ProductCard({ product, onUpdate, onDelete, canDelete, apiKey, onMissingKey, index, onSave }) {
  const [expanded, setExpanded] = useState(index === 0);
  // editSession: null | { wasEnabled, lastEditAt, snapshot }
  // 세션이 있으면 = 하단 바 표시 중. showBar 따로 두지 않음.
  const [editSession, setEditSession] = useState(null);

  // 필드 수정 래퍼:
  //  - 편집 시작되는 순간 바로 바 띄움 (OFF 상태에서도)
  //  - 봇 ON이었으면 자동으로 끄고 wasEnabled=true로 기록
  //  - 편집 때마다 lastEditAt 갱신 (8초 타이머 리셋)
  const update = (key, value) => {
    if (key === 'enabled' || key === 'label') {
      onUpdate({ ...product, [key]: value });
      return;
    }
    if (!EDIT_AUTO_OFF_FIELDS.has(key)) {
      onUpdate({ ...product, [key]: value });
      return;
    }

    const now = Date.now();
    if (!editSession) {
      // 첫 편집 — snapshot 캡처 + 즉시 바 표시
      const wasEnabled = product.enabled;
      setEditSession({ wasEnabled, lastEditAt: now, snapshot: { ...product } });
      if (wasEnabled) {
        onUpdate({ ...product, [key]: value, enabled: false }); // 자동 OFF
      } else {
        onUpdate({ ...product, [key]: value }); // 이미 OFF였으면 그대로
      }
    } else {
      // 재편집 — 타이머 리셋, 바는 이미 떠있음
      setEditSession({ ...editSession, lastEditAt: now });
      onUpdate({ ...product, [key]: value });
    }
  };

  const handleImport = (updates) => {
    const now = Date.now();
    if (!editSession) {
      const wasEnabled = product.enabled;
      setEditSession({ wasEnabled, lastEditAt: now, snapshot: { ...product } });
      if (wasEnabled) {
        onUpdate({ ...product, ...updates, enabled: false });
      } else {
        onUpdate({ ...product, ...updates });
      }
    } else {
      setEditSession({ ...editSession, lastEditAt: now });
      onUpdate({ ...product, ...updates });
    }
  };

  // 8초 무편집 → 세션 종료 + 바 숨김 (현상 유지, 저장·리셋·업로드 X)
  useEffect(() => {
    if (!editSession) return;
    const timer = setTimeout(() => {
      setEditSession(null);
    }, EDIT_IDLE_MS);
    return () => clearTimeout(timer);
  }, [editSession?.lastEditAt]);

  // 하단 바의 3개 액션
  function handleReset() {
    if (editSession?.snapshot) {
      onUpdate(editSession.snapshot); // 편집 전 상태로 전체 복원 (enabled 포함)
    }
    setEditSession(null);
  }
  function handleSaveOnly() {
    // 현재 편집 상태 유지. enabled는 건드리지 않음
    //  - ON이었다가 편집으로 꺼진 경우: OFF 유지
    //  - 원래 OFF였던 경우: OFF 유지
    if (onSave) onSave();
    setEditSession(null);
  }
  function handleSaveAndUpload() {
    // 편집 내용 유지 + 봇 무조건 ON 전환 (원래 ON이었든 OFF였든 업로드=활성화)
    onUpdate({ ...product, enabled: true });
    if (onSave) onSave();
    setEditSession(null);
  }

  return (
    <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
      {/* 카드 헤더 — 항상 보임 */}
      <div className="flex items-center gap-2 px-3 py-2.5 bg-neutral-50 border-b border-neutral-100">
        <button onClick={() => setExpanded(!expanded)} className="text-neutral-500 hover:text-neutral-800 transition">
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        <input
          value={product.label}
          onChange={(e) => update('label', e.target.value)}
          placeholder="상품 라벨 (예: 아이폰, 그래픽카드)"
          className="flex-1 bg-transparent text-[13px] font-semibold text-neutral-900 focus:outline-none focus:bg-white rounded px-1"
        />
        <label className="flex items-center gap-1.5 text-[11px] text-neutral-500 shrink-0 cursor-pointer select-none">
          <Toggle checked={product.enabled} onChange={(v) => update('enabled', v)} />
          <span className={product.enabled ? 'text-green-600 font-semibold' : 'text-neutral-400'}>{product.enabled ? '봇 ON' : '봇 OFF'}</span>
        </label>
        {canDelete && (
          <button onClick={() => onDelete(product.id)} className="text-neutral-400 hover:text-red-500 transition shrink-0 p-1" title="이 상품 삭제">
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {/* 접혔을 때 요약 */}
      {!expanded && (
        <div className="px-3 py-2 text-[11px] text-neutral-500 space-y-0.5">
          <div><span className="text-neutral-400">글 제목 매칭:</span> <span className={product.articleTitle ? 'text-neutral-700 font-medium' : 'text-red-500'}>{product.articleTitle || '(비어있음 — 매칭 불가)'}</span></div>
          <div><span className="text-neutral-400">판매가:</span> <span className="text-neutral-700">{product.askingPrice ? product.askingPrice.toLocaleString() + '원' : '미설정'}</span> <span className="text-neutral-400 ml-2">마지노선:</span> <span className="text-[#FF6F0F] font-semibold">{product.minPrice ? product.minPrice.toLocaleString() + '원' : '미설정'}</span></div>
        </div>
      )}

      {/* 펼쳤을 때 전체 폼 */}
      {expanded && (
        <div className="p-4 space-y-4">
          <UrlImporter onImport={handleImport} apiKey={apiKey} onMissingKey={onMissingKey} productLabel={product.label || '이 상품'} />

          <Section title="매칭 키 · 자동 판별" emoji="🎯">
            <Field label="글 제목 (당근 채팅방 상단에 뜨는 게시글 제목과 매칭됨)">
              <textarea
                value={product.articleTitle}
                onChange={(e) => update('articleTitle', e.target.value)}
                placeholder="게시글의 제목을 복사 붙여놓기 해주세요"
                rows={2}
                className={inputCls + ' resize-none font-mono text-[12px]'}
              />
            </Field>
            <div className="text-[11px] text-neutral-500 bg-blue-50 border border-blue-100 rounded-lg p-2 leading-relaxed">
              💡 <strong>매칭 규칙</strong>: 공백은 무시, 부분 문자열 허용 (앞뒤 "판매완료", "디지털기기·10개월 전" 같은 부가 텍스트 OK). 오타는 매칭 안 됨.
            </div>
          </Section>

          <Section title="상품 정보" emoji="📦">
            <Field label="상품명 (내부 표시용)">
              <input value={product.productName} onChange={(e) => update('productName', e.target.value)} className={inputCls} />
            </Field>
            <Field label="상품 상태">
              <input value={product.condition} onChange={(e) => update('condition', e.target.value)} className={inputCls} />
            </Field>
            <Field label="구성품">
              <input value={product.includes} onChange={(e) => update('includes', e.target.value)} className={inputCls} />
            </Field>
            <Field label="추가 정보 (배터리·사용기간 등)">
              <textarea value={product.extraInfo} onChange={(e) => update('extraInfo', e.target.value)} rows={2} className={inputCls + ' resize-none'} />
            </Field>
          </Section>

          <Section title="가격 · 네고" emoji="💰">
            <div className="grid grid-cols-2 gap-2.5">
              <Field label="판매가">
                <div className="relative">
                  <input type="number" value={product.askingPrice} onChange={(e) => update('askingPrice', Number(e.target.value) || 0)} className={inputCls + ' pr-8'} />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-neutral-400">원</span>
                </div>
              </Field>
              <Field label="마지노선 (최저가)">
                <div className="relative">
                  <input type="number" value={product.minPrice} onChange={(e) => update('minPrice', Number(e.target.value) || 0)} className={inputCls + ' pr-8'} />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-neutral-400">원</span>
                </div>
              </Field>
            </div>
            <Field label="네고 정책">
              <SegmentedControl value={product.negoPolicy} onChange={(v) => update('negoPolicy', v)}
                options={[{ value: 'none', label: '불가' }, { value: 'small', label: '소폭' }, { value: 'open', label: '협의' }]} />
            </Field>
            {product.askingPrice > 0 && product.minPrice > 0 && product.negoPolicy !== 'none' && (
              <div className="text-[12px] text-neutral-500 bg-neutral-50 rounded-lg px-3 py-2">
                최대 <span className="font-semibold text-[#FF6F0F]">{(product.askingPrice - product.minPrice).toLocaleString()}원</span>{' '}
                ({Math.round(((product.askingPrice - product.minPrice) / product.askingPrice) * 100)}%) 할인 허용
              </div>
            )}
          </Section>

          <Section title="거래 방법" emoji="🚚">
            <Field label="거래 방식 (둘 중 하나만 선택 — 답변 실패 방지)">
              <SegmentedControl
                value={product.tradeMethod || 'local'}
                onChange={(v) => update('tradeMethod', v)}
                options={[
                  { value: 'local', label: '직거래' },
                  { value: 'shipping', label: '택배거래' },
                ]}
              />
            </Field>
            {product.tradeMethod === 'shipping' ? (
              <Field label="택배 안내">
                <input
                  value={product.shippingNote}
                  onChange={(e) => update('shippingNote', e.target.value)}
                  className={inputCls}
                  placeholder="예: CJ 익일 발송, 배송비 3500원 구매자 부담"
                />
              </Field>
            ) : (
              <Field label="직거래 안내">
                <input
                  value={product.localNote}
                  onChange={(e) => update('localNote', e.target.value)}
                  className={inputCls}
                  placeholder="예: 역삼역 1번 출구, 평일 저녁 7시 이후"
                />
              </Field>
            )}
          </Section>

          <Section title="응대 스타일" emoji="💬">
            <Field label="말투">
              <SegmentedControl value={product.tone} onChange={(v) => update('tone', v)}
                options={[{ value: 'friendly', label: '친근' }, { value: 'polite', label: '정중' }, { value: 'cool', label: '쿨' }]} />
            </Field>
            <Field label="추가 규칙 (선택)">
              <textarea value={product.customRules} onChange={(e) => update('customRules', e.target.value)} rows={2} className={inputCls + ' resize-none'} placeholder={'예: 교환·환불 불가'} />
            </Field>

          </Section>
        </div>
      )}

      {/* 하단 고정 저장 바 — 편집 즉시 표시, 8초 무반응 시 자동 닫힘 (현상 유지) */}
      {editSession && (
        <div className="fixed bottom-4 left-4 right-4 lg:left-auto lg:right-4 lg:max-w-xl z-50 pointer-events-none saved-toast">
          <div className="bg-neutral-800 text-white rounded-xl shadow-2xl p-3 flex items-center gap-3 pointer-events-auto border border-neutral-700">
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-white">봇이 수정되었습니다</div>
              <div className="text-[11px] text-neutral-300 mt-0.5">
                <span className="font-semibold text-white">{product.label || '(이름 없음)'}</span> · 봇을 저장하고 업로드 하겠습니까?
              </div>
            </div>
            <button
              onClick={handleReset}
              className="shrink-0 text-[12px] text-neutral-300 hover:text-white px-2 py-1.5 underline decoration-dotted underline-offset-2"
              title="편집 전 상태로 되돌리기"
            >
              리셋
            </button>
            <button
              onClick={handleSaveOnly}
              className="shrink-0 text-[12px] bg-neutral-600 hover:bg-neutral-500 text-white px-3 py-1.5 rounded-lg font-semibold transition"
              title="저장만 (봇은 꺼진 채로)"
            >
              저장
            </button>
            <button
              onClick={handleSaveAndUpload}
              className="shrink-0 text-[12px] bg-green-600 hover:bg-green-500 text-white px-3 py-1.5 rounded-lg font-semibold transition"
              title="저장 + 봇 다시 켜기"
            >
              저장 후 업로드
            </button>
          </div>
          <div className="text-[9px] text-neutral-400 text-center mt-1 pointer-events-none">
            8초 동안 추가 수정이 없으면 이 창은 사라져요 (현상 유지)
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// ConfigPanel — 다중 상품 관리 + 고객 채팅방 패널
// ============================================================
function ConfigPanel({ config, setConfig, onSave, onReset, saved, apiKey, onMissingKey, extension }) {
  const updateProduct = (updated) => {
    setConfig((c) => ({ ...c, products: c.products.map((p) => p.id === updated.id ? updated : p) }));
  };
  const addProduct = () => {
    setConfig((c) => ({ ...c, products: [...c.products, createEmptyProduct(`상품 ${c.products.length + 1}`)] }));
  };
  const deleteProduct = (id) => {
    if (config.products.length <= 1) return;
    if (!window.confirm('이 상품을 정말 삭제할까요?')) return;
    setConfig((c) => ({ ...c, products: c.products.filter((p) => p.id !== id) }));
  };

  const updateCustomer = (updated) => {
    setConfig((c) => ({ ...c, customers: c.customers.map((x) => x.id === updated.id ? updated : x) }));
  };
  const addCustomer = () => {
    setConfig((c) => ({ ...c, customers: [...(c.customers || []), createCustomer(`고객 ${(c.customers?.length || 0) + 1}`)] }));
  };
  const deleteCustomer = (id) => {
    if (!window.confirm('이 채팅방을 목록에서 삭제할까요?')) return;
    setConfig((c) => ({ ...c, customers: c.customers.filter((x) => x.id !== id) }));
  };

  const updateRoomSettings = (roomUrl, patch) => {
    setConfig((c) => ({
      ...c,
      roomSettings: {
        ...(c.roomSettings || {}),
        [roomUrl]: { ...getRoomSettings(c.roomSettings, roomUrl), ...patch },
      },
    }));
  };

  return (
    <div className="grid lg:grid-cols-[1fr_340px] gap-4 items-start">
      {/* 왼쪽: 상품 관리 */}
      <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-neutral-100 flex items-center justify-between bg-gradient-to-r from-orange-50 to-amber-50">
          <div>
            <div className="text-[14px] font-bold text-neutral-900">상품 관리 ({config.products.length}개)</div>
            <div className="text-[11px] text-neutral-500 mt-0.5">각 상품마다 글 제목을 입력하면 당근 채팅방 제목과 자동 매칭됩니다.</div>
          </div>
          <button onClick={addProduct} className="bg-[#FF6F0F] hover:bg-[#ee6200] text-white text-[13px] font-semibold px-3 py-2 rounded-lg flex items-center gap-1.5 transition shrink-0">
            <Plus size={14} /> 상품 추가
          </button>
        </div>

        <div className="p-4 space-y-3 bg-neutral-50 max-h-[760px] overflow-y-auto scroll-area">
          {config.products.map((p, i) => (
            <ProductCard key={p.id} product={p} index={i} onUpdate={updateProduct} onDelete={deleteProduct} canDelete={config.products.length > 1} apiKey={apiKey} onMissingKey={onMissingKey} onSave={onSave} />
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-neutral-100 bg-neutral-50">
          <button onClick={onReset} className="text-[13px] text-neutral-500 hover:text-neutral-800 px-3 py-2 rounded-lg flex items-center gap-1.5 transition">
            <RotateCcw size={14} /> 기본값으로
          </button>
          <div className="flex items-center gap-2">
            {saved && <span className="saved-toast text-[12px] text-green-600 font-medium flex items-center gap-1"><Check size={14} /> 저장됨</span>}
            <button onClick={onSave} className="bg-neutral-900 hover:bg-black text-white text-[13px] font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5 transition">
              <Save size={14} /> 전체 저장
            </button>
          </div>
        </div>
      </div>

      {/* 오른쪽: 고객 채팅방 패널 */}
      <CustomerPanel
        customers={config.customers || []}
        products={config.products}
        onAdd={addCustomer}
        onUpdate={updateCustomer}
        onDelete={deleteCustomer}
        extension={extension}
        roomSettings={config.roomSettings || {}}
        onRoomSettingsChange={updateRoomSettings}
      />
    </div>
  );
}

// ============================================================
// CustomerPanel — 현재 채팅 중인 고객 목록 + 당근 실시간 방
// ============================================================
function CustomerPanel({ customers, products, onAdd, onUpdate, onDelete, extension, roomSettings, onRoomSettingsChange }) {
  const allExtRooms = (extension?.rooms || []).filter((r) => !r.official); // 공식 계정 제외
  const extConnected = extension?.status === 'connected';
  const lastSyncText = useMemo(() => {
    if (!extension?.updatedAt) return '';
    const d = new Date(extension.updatedAt);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }, [extension?.updatedAt]);

  // 필터 상태
  const [filter, setFilter] = useState('all');
  const [selectedRooms, setSelectedRooms] = useState(new Set()); // roomUrl Set

  // 각 방 상태 계산 + 필터 적용
  const roomsWithStatus = useMemo(() => {
    return allExtRooms.map((r) => {
      const settings = getRoomSettings(roomSettings, r.roomUrl);
      const autoMatched = matchProductByArticleTitle(products, r.articleTitle);
      const active = settings.manualProductId
        ? products.find((p) => p.id === settings.manualProductId)
        : autoMatched;
      const status = computeRoomStatus(settings, active);
      const tradeReady = active ? isTradeInfoComplete(settings.tradeInfo, active.tradeMethod) : false;
      const localReady = active?.tradeMethod === 'local' && tradeReady;
      const shippingReady = active?.tradeMethod === 'shipping' && tradeReady;
      return { room: r, settings, status, activeProduct: active, localReady, shippingReady };
    });
  }, [allExtRooms, roomSettings, products]);

  const extRooms = useMemo(() => {
    if (filter === 'all') return roomsWithStatus;
    if (filter === 'local-ready') return roomsWithStatus.filter((x) => x.localReady);
    if (filter === 'shipping-ready') return roomsWithStatus.filter((x) => x.shippingReady);
    return roomsWithStatus.filter((x) => x.status === filter);
  }, [roomsWithStatus, filter]);

  const filterCounts = useMemo(() => {
    const counts = { all: roomsWithStatus.length, 'bot-on': 0, 'bot-off': 0, 'no-match': 0, 'product-off': 0, manual: 0, 'local-ready': 0, 'shipping-ready': 0 };
    for (const x of roomsWithStatus) {
      counts[x.status] = (counts[x.status] || 0) + 1;
      if (x.localReady) counts['local-ready']++;
      if (x.shippingReady) counts['shipping-ready']++;
    }
    return counts;
  }, [roomsWithStatus]);

  // 모두 선택 체크박스
  const visibleUrls = extRooms.map((x) => x.room.roomUrl);
  const allSelected = visibleUrls.length > 0 && visibleUrls.every((u) => selectedRooms.has(u));
  const someSelected = visibleUrls.some((u) => selectedRooms.has(u));

  function toggleAll() {
    const next = new Set(selectedRooms);
    if (allSelected) visibleUrls.forEach((u) => next.delete(u));
    else visibleUrls.forEach((u) => next.add(u));
    setSelectedRooms(next);
  }
  function toggleOne(url) {
    const next = new Set(selectedRooms);
    if (next.has(url)) next.delete(url); else next.add(url);
    setSelectedRooms(next);
  }

  // 일괄 변경
  function bulkAction(action) {
    if (selectedRooms.size === 0) return;
    for (const url of selectedRooms) {
      if (action === 'enable') onRoomSettingsChange(url, { enabled: true });
      else if (action === 'disable') onRoomSettingsChange(url, { enabled: false });
      else if (action === 'resume') onRoomSettingsChange(url, { manualActive: false, manualReason: null, manualSource: null, manualAt: null, riskScore: 0 });
    }
    setSelectedRooms(new Set());
  }
  return (
    <aside className="bg-white rounded-2xl shadow-sm border border-neutral-200 overflow-hidden lg:sticky lg:top-4">
      <div className="px-4 py-3 border-b border-neutral-100 bg-gradient-to-r from-blue-50 to-indigo-50">
        <div className="flex items-center justify-between mb-2">
          <div>
            <div className="text-[13px] font-bold text-neutral-900">채팅방 관리</div>
            <div className="text-[10px] text-neutral-500 mt-0.5">
              당근 {allExtRooms.length}방 + 수동 {customers.length}건
            </div>
          </div>
          <button onClick={onAdd} className="bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-semibold px-2.5 py-1.5 rounded-lg flex items-center gap-1 transition shrink-0">
            <Plus size={11} /> 수동 추가
          </button>
        </div>

        {/* 상태별 필터 */}
        <div className="flex flex-wrap gap-1">
          {[
            { k: 'all',            t: '전체',         color: 'neutral' },
            { k: 'bot-on',         t: '봇 ON',        color: 'green' },
            { k: 'bot-off',        t: '봇 OFF',       color: 'neutral' },
            { k: 'manual',         t: '수동 채팅',    color: 'purple' },
            { k: 'no-match',       t: '매칭 없음',    color: 'red' },
            { k: 'product-off',    t: '상품 OFF',     color: 'orange' },
            { k: 'local-ready',    t: '📍 직거래 준비',  color: 'emerald' },
            { k: 'shipping-ready', t: '📦 택배거래 준비', color: 'blue' },
          ].map(({ k, t, color }) => {
            const active = filter === k;
            const base = 'text-[10px] px-2 py-1 rounded-full font-medium transition border';
            const colors = {
              neutral: active ? 'bg-neutral-800 text-white border-neutral-800' : 'bg-white text-neutral-600 border-neutral-200 hover:border-neutral-400',
              green:   active ? 'bg-green-600 text-white border-green-600'     : 'bg-white text-green-700 border-green-200 hover:border-green-400',
              purple:  active ? 'bg-purple-600 text-white border-purple-600'   : 'bg-white text-purple-700 border-purple-200 hover:border-purple-400',
              red:     active ? 'bg-red-600 text-white border-red-600'         : 'bg-white text-red-700 border-red-200 hover:border-red-400',
              orange:  active ? 'bg-orange-500 text-white border-orange-500'   : 'bg-white text-orange-700 border-orange-200 hover:border-orange-400',
              emerald: active ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-emerald-700 border-emerald-200 hover:border-emerald-400',
              blue:    active ? 'bg-blue-600 text-white border-blue-600'       : 'bg-white text-blue-700 border-blue-200 hover:border-blue-400',
            };
            return (
              <button key={k} onClick={() => setFilter(k)} className={`${base} ${colors[color]}`}>
                {t} <span className="opacity-70">{filterCounts[k] || 0}</span>
              </button>
            );
          })}
        </div>

        {/* 모두 선택 + 일괄 변경 */}
        {extRooms.length > 0 && (
          <div className="mt-2 flex items-center gap-2 text-[10px]">
            <label className="flex items-center gap-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected; }}
                onChange={toggleAll}
                className="w-3 h-3 accent-blue-600"
              />
              <span className="text-neutral-600">모두 선택 ({selectedRooms.size})</span>
            </label>
            {selectedRooms.size > 0 && (
              <div className="flex gap-1 ml-auto">
                <button onClick={() => bulkAction('enable')}  className="bg-green-600 hover:bg-green-700 text-white px-1.5 py-0.5 rounded font-semibold">전부 ON</button>
                <button onClick={() => bulkAction('disable')} className="bg-neutral-600 hover:bg-neutral-700 text-white px-1.5 py-0.5 rounded font-semibold">전부 OFF</button>
                <button onClick={() => bulkAction('resume')}  className="bg-purple-600 hover:bg-purple-700 text-white px-1.5 py-0.5 rounded font-semibold">일괄 재개</button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="max-h-[700px] overflow-y-auto scroll-area bg-neutral-50">
        {/* 당근 실시간 방 (확장 연결시) */}
        <div className="p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] font-bold text-green-700 uppercase tracking-wider flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${extConnected ? 'bg-green-500 animate-pulse' : 'bg-neutral-400'}`} />
              당근 실시간 ({extRooms.length})
            </div>
            {lastSyncText && <div className="text-[9px] text-neutral-400">동기화 {lastSyncText}</div>}
          </div>

          {!extConnected ? (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-[10px] text-amber-800 leading-relaxed">
              <div className="font-bold mb-1">🔌 크롬 확장 미연결</div>
              <div>`크롬확장_설치.bat` 실행 → chat.daangn.com 열면 자동 동기화됩니다.</div>
            </div>
          ) : allExtRooms.length === 0 ? (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-2.5 text-[10px] text-blue-800 leading-relaxed">
              확장은 연결됐지만 방 목록이 비어 있어요. chat.daangn.com 탭을 새로고침하거나 로그인 상태를 확인하세요.
            </div>
          ) : extRooms.length === 0 ? (
            <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-2.5 text-[10px] text-neutral-500 text-center">
              현재 필터에 해당하는 방이 없어요. 다른 필터를 눌러보세요.
            </div>
          ) : (
            <div className="space-y-1.5">
              {extRooms.map(({ room: r }) => (
                <div key={r.roomUrl} className="flex items-start gap-1.5">
                  <input
                    type="checkbox"
                    checked={selectedRooms.has(r.roomUrl)}
                    onChange={() => toggleOne(r.roomUrl)}
                    className="mt-2 w-3 h-3 accent-blue-600 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <ExtensionRoomCard
                      room={r}
                      products={products}
                      settings={getRoomSettings(roomSettings, r.roomUrl)}
                      onChange={(patch) => onRoomSettingsChange(r.roomUrl, patch)}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 수동 등록 */}
        {customers.length > 0 && (
          <div className="p-3 border-t border-neutral-200">
            <div className="text-[10px] font-bold text-neutral-500 uppercase tracking-wider mb-2">✋ 수동 추가 ({customers.length})</div>
            <div className="space-y-2">
              {customers.map((c) => (
                <CustomerCard key={c.id} customer={c} products={products} onUpdate={onUpdate} onDelete={onDelete} />
              ))}
            </div>
          </div>
        )}

        {/* 완전 빈 상태 */}
        {!extConnected && customers.length === 0 && (
          <div className="p-6 text-center text-[11px] text-neutral-500 leading-relaxed">
            <div className="text-2xl mb-2">💬</div>
            <div>등록된 채팅방이 없어요.</div>
            <div className="mt-1">확장을 설치하거나 "수동 추가"를 눌러주세요.</div>
          </div>
        )}
      </div>

      <div className="px-4 py-2 border-t border-neutral-100 bg-blue-50/50">
        <div className="text-[10px] text-blue-700 leading-relaxed">
          💡 공식 계정(당근·당근알바 등)은 자동 제외됩니다. 새 메시지/방이 들어오면 여기에 실시간 반영돼요.
        </div>
      </div>
    </aside>
  );
}

// ============================================================
// ExtensionRoomCard — 확장이 제공하는 방 (방별 봇 ON/OFF + 상품 오버라이드)
// ============================================================
function ExtensionRoomCard({ room, products, settings, onChange }) {
  const autoMatched = matchProductByArticleTitle(products, room.articleTitle);
  const manualProduct = settings.manualProductId ? products.find((p) => p.id === settings.manualProductId) : null;
  const activeProduct = manualProduct || autoMatched;
  const isAutoMatching = !settings.manualProductId;
  const productEnabled = activeProduct?.enabled ?? false;

  const status = computeRoomStatus(settings, activeProduct);
  // 상태 우선순위: 봇 OFF > 매칭 없음 > 상품 OFF > 수동 채팅 > 봇 ON
  const statusMap = {
    'bot-off':     { color: 'bg-neutral-400', text: '방 OFF' },
    'no-match':    { color: 'bg-red-500',     text: '매칭 없음' },
    'product-off': { color: 'bg-orange-500',  text: '상품 OFF' },
    'manual':      { color: 'bg-purple-500',  text: '수동 채팅' },
    'bot-on':      { color: 'bg-green-500',   text: '봇 ON' },
  };
  const { color: statusColor, text: statusText } = statusMap[status];

  // 위험도
  const riskScore = settings.riskScore || 0;
  const risk = riskLevelOf(riskScore);
  const riskColor = risk === 'high' ? 'bg-red-500' : risk === 'med' ? 'bg-orange-400' : 'bg-green-500';
  const riskLabel = risk === 'high' ? '높음' : risk === 'med' ? '중간' : '낮음';

  const handleResumeFromManual = () => {
    onChange({
      manualActive: false,
      manualReason: null,
      manualSource: null,
      manualAt: null,
      riskScore: 0,
    });
  };

  const sourceLabel = {
    keyword: '위험 키워드',
    emotion: '감정 격화',
    stuck: 'AI 대화 막힘',
    nego2: '2차 네고',
    risk: '위험도 누적',
    villain: '빌런 유형',
    llm: 'AI 판단',
    safety: '안전 필터',
    'end-detect': '대화 종료',
  }[settings.manualSource] || '알 수 없음';

  return (
    <div className="bg-white border border-neutral-200 rounded-lg p-2 hover:border-blue-300 transition">
      {/* 헤더: 아바타 + 이름 + 상태 배지 */}
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-green-400 to-emerald-500 text-white flex items-center justify-center text-[11px] font-bold shrink-0">
          {(room.nickname || '?').charAt(0)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            <div className="text-[12px] font-semibold text-neutral-900 truncate">{room.nickname}</div>
            {room.selected && <span className="text-[8px] bg-orange-100 text-orange-600 px-1 rounded font-semibold shrink-0">현재</span>}
          </div>
          <div className="text-[9px] text-neutral-400 truncate">{room.subText}</div>
        </div>
        <span className={`text-[8px] px-1.5 py-0.5 rounded-full font-semibold text-white shrink-0 ${statusColor}`}>
          {statusText}
        </span>
      </div>

      {/* 글 제목 */}
      {room.articleTitle && (
        <div className="mt-1.5 pl-9 text-[9px] text-neutral-600 truncate" title={room.articleTitle}>
          📦 {room.articleTitle}
        </div>
      )}

      {/* 상품 선택 드롭다운 */}
      <div className="mt-1.5 pl-9">
        <select
          value={settings.manualProductId || 'auto'}
          onChange={(e) => onChange({ manualProductId: e.target.value === 'auto' ? null : e.target.value })}
          className="w-full bg-neutral-50 border border-neutral-200 rounded px-1.5 py-0.5 text-[10px] focus:outline-none focus:border-blue-400 focus:bg-white"
        >
          <option value="auto">자동 매칭 ({autoMatched ? autoMatched.label : '없음'})</option>
          <option disabled>─────────</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        {activeProduct && (
          <div className="text-[9px] text-neutral-500 mt-0.5">
            {isAutoMatching ? '🎯 자동' : '✋ 수동'} · {activeProduct.askingPrice?.toLocaleString()}원
            {!productEnabled && <span className="ml-1 text-orange-600 font-semibold">· 상품 OFF</span>}
          </div>
        )}
      </div>

      {/* 거래 정보 (직거래 → 시간·장소 / 택배 → 수령인·주소·연락처) */}
      {activeProduct && (() => {
        const tradeInfo = settings.tradeInfo || {};
        const updateTradeInfo = (field, value) => onChange({ tradeInfo: { ...tradeInfo, [field]: value } });
        const isLocal = activeProduct.tradeMethod === 'local';
        const tradeReady = isTradeInfoComplete(tradeInfo, activeProduct.tradeMethod);
        const wrapCls = tradeReady
          ? 'mt-1.5 pl-9 -mx-2 px-2 py-1.5 border-y bg-emerald-50 border-emerald-200'
          : 'mt-1.5 pl-9 -mx-2 px-2 py-1.5 border-y bg-blue-50 border-blue-200';
        const headerCls = tradeReady
          ? 'flex items-center justify-between mb-1 text-[9px] font-bold text-emerald-700'
          : 'flex items-center justify-between mb-1 text-[9px] font-bold text-blue-700';
        const inputCls = tradeReady
          ? 'w-full text-[10px] px-1.5 py-0.5 border border-emerald-200 rounded bg-white focus:outline-none focus:border-emerald-500'
          : 'w-full text-[10px] px-1.5 py-0.5 border border-blue-200 rounded bg-white focus:outline-none focus:border-blue-500';
        return (
          <div className={wrapCls}>
            <div className={headerCls}>
              <span>{isLocal ? '📍 직거래 준비' : '📦 택배거래 준비'}</span>
              {tradeReady && <span className="text-[8px] bg-emerald-200 text-emerald-800 px-1 py-px rounded">✓ 준비됨</span>}
            </div>
            {isLocal ? (
              <div className="space-y-1">
                <input value={tradeInfo.meetingTime || ''} onChange={(e) => updateTradeInfo('meetingTime', e.target.value)} placeholder="만날 시간 (예: 내일 5시)" className={inputCls} />
                <input value={tradeInfo.meetingPlace || ''} onChange={(e) => updateTradeInfo('meetingPlace', e.target.value)} placeholder="만날 장소 (예: 역삼역 1번 출구)" className={inputCls} />
              </div>
            ) : (
              <div className="space-y-1">
                <input value={tradeInfo.recipientName || ''} onChange={(e) => updateTradeInfo('recipientName', e.target.value)} placeholder="수령인 이름" className={inputCls} />
                <input value={tradeInfo.recipientAddress || ''} onChange={(e) => updateTradeInfo('recipientAddress', e.target.value)} placeholder="배송 주소" className={inputCls} />
                <input value={tradeInfo.recipientPhone || ''} onChange={(e) => updateTradeInfo('recipientPhone', e.target.value)} placeholder="전화번호 (010-XXXX-XXXX)" className={inputCls} />
              </div>
            )}
          </div>
        );
      })()}

      {/* 봇 ON/OFF 토글 */}
      <div className="mt-1.5 pl-9 flex items-center justify-between">
        <span className="text-[9px] text-neutral-600 font-medium">이 방 봇 자동 응답</span>
        <button
          onClick={() => onChange({ enabled: !settings.enabled })}
          className={`relative w-7 h-4 rounded-full transition ${settings.enabled ? 'bg-green-500' : 'bg-neutral-300'}`}
          aria-label="봇 자동 응답 토글"
        >
          <span className={`absolute top-0.5 w-3 h-3 bg-white rounded-full shadow-sm transition ${settings.enabled ? 'left-[14px]' : 'left-0.5'}`} />
        </button>
      </div>

      {/* 위험도 바 */}
      <div className="mt-2 pl-9">
        <div className="flex items-center justify-between text-[9px] text-neutral-600 mb-0.5">
          <span>위험도</span>
          <span className={`font-semibold ${risk === 'high' ? 'text-red-600' : risk === 'med' ? 'text-orange-500' : 'text-green-600'}`}>
            {riskLabel} · {riskScore}/100
          </span>
        </div>
        <div className="h-1.5 bg-neutral-200 rounded-full overflow-hidden">
          <div className={`h-full ${riskColor} transition-all`} style={{ width: `${Math.min(100, riskScore)}%` }} />
        </div>
      </div>

      {/* 수동 채팅 섹션 (manualActive일 때만) */}
      {settings.manualActive && (
        <div className="mt-2 pl-9 border-t border-purple-200 pt-2 bg-purple-50 -mx-2 px-2 pb-2 rounded-b-lg">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] font-bold text-purple-700 flex items-center gap-1">
              <span>🚨</span> 수동 채팅 모드
            </div>
            <button
              onClick={handleResumeFromManual}
              className="text-[10px] bg-purple-600 hover:bg-purple-700 text-white px-2 py-0.5 rounded font-semibold transition"
              title="봇 다시 켜기 (상품 설정대로 이어서 답변)"
            >
              ▶ 재개
            </button>
          </div>
          <div className="text-[9px] text-purple-800 leading-relaxed">
            <strong>사유:</strong> {settings.manualReason}
          </div>
          <div className="text-[8px] text-purple-500 mt-0.5">
            {sourceLabel}
            {settings.manualAt && ` · ${new Date(settings.manualAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`}
          </div>
        </div>
      )}
    </div>
  );
}

function CustomerCard({ customer, products, onUpdate, onDelete }) {
  const autoMatched = matchProductByArticleTitle(products, customer.articleTitle);
  const activeProduct = customer.manualProductId
    ? products.find((p) => p.id === customer.manualProductId)
    : autoMatched;
  const isAutoMatching = !customer.manualProductId;
  const productEnabled = activeProduct?.enabled ?? false;

  const update = (key, value) => onUpdate({ ...customer, [key]: value });
  const patch = (p) => onUpdate({ ...customer, ...p });

  // 수동 채팅 상태 계산 (수동 고객은 customer.manualActive로 직접 관리 가능)
  const manualActive = !!customer.manualActive;

  let status = 'bot-on';
  if (!customer.enabled) status = 'bot-off';
  else if (!activeProduct) status = 'no-match';
  else if (!productEnabled) status = 'product-off';
  else if (manualActive) status = 'manual';

  const statusMap = {
    'bot-off':     { color: 'bg-neutral-400', text: '봇 OFF' },
    'no-match':    { color: 'bg-red-500',     text: '매칭 없음' },
    'product-off': { color: 'bg-orange-500',  text: '상품 OFF' },
    'manual':      { color: 'bg-purple-500',  text: '수동 채팅' },
    'bot-on':      { color: 'bg-green-500',   text: '봇 ON' },
  };
  const { color: statusColor, text: statusText } = statusMap[status];

  const riskScore = customer.riskScore || 0;
  const risk = riskLevelOf(riskScore);
  const riskColor = risk === 'high' ? 'bg-red-500' : risk === 'med' ? 'bg-orange-400' : 'bg-green-500';
  const riskLabel = risk === 'high' ? '높음' : risk === 'med' ? '중간' : '낮음';

  const handleResumeFromManual = () => {
    patch({ manualActive: false, manualReason: null, manualSource: null, manualAt: null, riskScore: 0 });
  };

  const sourceLabel = {
    keyword: '위험 키워드', emotion: '감정 격화', stuck: 'AI 대화 막힘',
    nego2: '2차 네고', risk: '위험도 누적', villain: '빌런 유형',
    llm: 'AI 판단', safety: '안전 필터', 'end-detect': '대화 종료',
  }[customer.manualSource] || '알 수 없음';

  return (
    <div className="bg-white border border-neutral-200 rounded-lg p-2.5 space-y-2">
      {/* 상단: 이름 + 상태 + 삭제 */}
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-400 to-indigo-500 text-white flex items-center justify-center text-[11px] font-bold shrink-0">
          {(customer.nickname || '?').charAt(0)}
        </div>
        <input
          value={customer.nickname}
          onChange={(e) => update('nickname', e.target.value)}
          placeholder="고객 닉네임"
          className="flex-1 text-[12px] font-semibold text-neutral-900 bg-transparent focus:outline-none focus:bg-neutral-50 rounded px-1 py-0.5 min-w-0"
        />
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold text-white shrink-0 ${statusColor}`}>
          {statusText}
        </span>
        <button onClick={() => onDelete(customer.id)} className="text-neutral-300 hover:text-red-500 transition shrink-0" title="삭제">
          <Trash2 size={12} />
        </button>
      </div>

      {/* 글 제목 */}
      <div>
        <div className="text-[9px] font-medium text-neutral-500 mb-0.5">글 제목 (자동 매칭용)</div>
        <textarea
          value={customer.articleTitle}
          onChange={(e) => update('articleTitle', e.target.value)}
          placeholder="채팅방 상단 게시글 제목"
          rows={2}
          className="w-full bg-neutral-50 border border-neutral-200 rounded px-2 py-1 text-[10px] focus:outline-none focus:border-blue-400 focus:bg-white resize-none font-mono leading-tight"
        />
      </div>

      {/* 매칭된 상품 선택 */}
      <div>
        <div className="text-[9px] font-medium text-neutral-500 mb-0.5">매칭된 상품</div>
        <select
          value={customer.manualProductId || 'auto'}
          onChange={(e) => update('manualProductId', e.target.value === 'auto' ? null : e.target.value)}
          className="w-full bg-neutral-50 border border-neutral-200 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-blue-400 focus:bg-white"
        >
          <option value="auto">
            자동 매칭 ({autoMatched ? autoMatched.label : '매칭 없음'})
          </option>
          <option disabled>─────────────</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        {activeProduct && (
          <div className="text-[9px] text-neutral-500 mt-0.5">
            {isAutoMatching ? '🎯 자동' : '✋ 수동'} · {activeProduct.productName || activeProduct.label} · {activeProduct.askingPrice?.toLocaleString()}원
          </div>
        )}
      </div>

      {/* 봇 ON/OFF */}
      <div className="flex items-center justify-between pt-1.5 border-t border-neutral-100">
        <span className="text-[10px] text-neutral-600 font-medium">이 채팅방 봇 자동 응답</span>
        <Toggle checked={customer.enabled} onChange={(v) => update('enabled', v)} />
      </div>

      {/* 위험도 */}
      <div>
        <div className="flex items-center justify-between text-[9px] text-neutral-600 mb-0.5">
          <span>위험도</span>
          <span className={`font-semibold ${risk === 'high' ? 'text-red-600' : risk === 'med' ? 'text-orange-500' : 'text-green-600'}`}>
            {riskLabel} · {riskScore}/100
          </span>
        </div>
        <div className="h-1.5 bg-neutral-200 rounded-full overflow-hidden">
          <div className={`h-full ${riskColor} transition-all`} style={{ width: `${Math.min(100, riskScore)}%` }} />
        </div>
      </div>

      {/* 수동 채팅 (활성 시) */}
      {manualActive && (
        <div className="border-t border-purple-200 pt-1.5 bg-purple-50 -mx-2 px-2 pb-1.5 rounded-b-lg">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] font-bold text-purple-700 flex items-center gap-1">
              <span>🚨</span> 수동 채팅 모드
            </div>
            <button
              onClick={handleResumeFromManual}
              className="text-[10px] bg-purple-600 hover:bg-purple-700 text-white px-2 py-0.5 rounded font-semibold transition"
              title="봇 다시 켜기"
            >
              ▶ 재개
            </button>
          </div>
          <div className="text-[9px] text-purple-800 leading-relaxed">
            <strong>사유:</strong> {customer.manualReason || '(없음)'}
          </div>
          <div className="text-[8px] text-purple-500 mt-0.5">
            {sourceLabel}
            {customer.manualAt && ` · ${new Date(customer.manualAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// ChatPanel — 글 제목 시뮬레이터 + 자동 매칭
// ============================================================
function ChatPanel({ config, apiKey, onMissingKey }) {
  const [articleTitle, setArticleTitle] = useState('');
  const [messages, setMessages] = useState(() => [
    { role: 'bot', text: '안녕하세요 🥕', time: getTime() },
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [mode, setMode] = useState('auto');
  const [handoffInfo, setHandoffInfo] = useState(null);
  const scrollRef = useRef(null);

  const matched = useMemo(() => matchProductByArticleTitle(config.products, articleTitle), [config.products, articleTitle]);
  const botActive = !!matched && matched.enabled;

  function getTime() {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes().toString().padStart(2, '0');
    const ampm = h < 12 ? '오전' : '오후';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${ampm} ${h12}:${m}`;
  }

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, isTyping]);

  // 글 제목이 바뀌면 대화 초기화
  useEffect(() => {
    setMessages([{ role: 'bot', text: '안녕하세요 🥕', time: getTime() }]);
    setMode('auto');
    setHandoffInfo(null);
  }, [matched?.id]);

  function resetChat() {
    setMessages([{ role: 'bot', text: '안녕하세요 🥕', time: getTime() }]);
    setMode('auto');
    setHandoffInfo(null);
  }

  function resumeBot() {
    setMode('auto');
    setHandoffInfo(null);
    setMessages((prev) => [...prev, { role: 'system', kind: 'resume', text: '봇 자동 응답 재개됨', time: getTime() }]);
  }

  function buildSystemPrompt(product) {
    const tradeMethods = [];
    if (product.shippingAvailable) tradeMethods.push(`택배 가능: ${product.shippingNote || '(안내 미설정)'}`);
    if (product.localAvailable) tradeMethods.push(`직거래 가능: ${product.localNote || '(안내 미설정)'}`);
    if (tradeMethods.length === 0) tradeMethods.push('거래 방법 미설정');

    const negoDesc = product.negoPolicy === 'none'
      ? `네고 불가. 가격 문의시 ${product.askingPrice.toLocaleString()}원 그대로 안내.`
      : product.negoPolicy === 'small'
      ? `최저 ${product.minPrice.toLocaleString()}원까지만 가능. 그 이하는 "${product.minPrice.toLocaleString()}원까지가 최선이에요" 정도로 정중히 거절.`
      : `협의 가능하지만 절대 ${product.minPrice.toLocaleString()}원 미만 불가.`;

    const toneDesc = product.tone === 'friendly'
      ? '친근하고 편안한 존댓말 ("~요" 체). 🥕 이모티콘 아주 가끔.'
      : product.tone === 'polite'
      ? '정중한 존댓말 ("~습니다/~입니다" 체). 이모티콘 없이.'
      : '간결하고 쿨하게. 인사·이모티콘 없이 핵심만.';

    return `너는 당근마켓에서 중고 물건을 파는 판매자야. 당근은 쇼핑몰이 아니라 이웃 간 중고거래 플랫폼이라, 판매자 챗봇이 할 일은 **최소한도의 대응**이야.

중요: 당근페이(안전결제)와 택배 시스템이 주소·결제·송장을 다 알아서 처리해줘. 너는 채팅으로 주소 받거나 결제 안내하거나 송장 관리할 필요 **없어**.

[네가 해야 할 일]
1. 상품에 대한 질문에 간단히 답하기
2. 가격 네고 요청 처리 (마지노선 지키면서)
3. 거래 방법 문의에 답하기
4. 감사 인사나 일상 대화에 짧게 받아주기

[★★★ 사람 확인 필요 — 아래 중 하나라도 해당하면 답변 쓰지 말고 정확히 "[HANDOFF:이유]" 형식으로만 출력 ★★★]
- 실물/추가 사진 요청
- 판매자 개인정보 질문
- 구매 확정 의사 ("구매할게요", "결제할게요", "예약해 주세요")
- 설정에 없는 상품 정보 질문
- 분쟁·환불·AS·교환·하자 얘기
- URL/링크 포함 메시지

형식 예: [HANDOFF:실물 사진 요청] / [HANDOFF:구매 확정] / [HANDOFF:모르는 스펙 질문]
이 태그를 쓸 땐 **다른 텍스트 절대 같이 쓰지 말 것**.

[상품]
- ${product.productName || product.articleTitle}
- 판매가: ${product.askingPrice.toLocaleString()}원
- 상태: ${product.condition || '명시 없음'}
- 구성: ${product.includes || '명시 없음'}
- 기타: ${product.extraInfo || '없음'}

[거래 방법]
${tradeMethods.map((t) => '- ' + t).join('\n')}

[가격 정책]
${negoDesc}

[응대 스타일]
${toneDesc}

${product.customRules ? `[추가 규칙]\n${product.customRules}\n` : ''}
[철칙]
- 1문장, 길어야 2문장. 단 HANDOFF 태그는 그대로만.
- 애매하면 "네~" 한 마디도 충분.
- ${product.minPrice.toLocaleString()}원 미만 절대 불가.`;
  }

  async function sendToAPI(userMessage, history) {
    if (!apiKey) { onMissingKey(); return { type: 'error', text: 'API 키를 먼저 설정해 주세요.' }; }
    if (!matched) return { type: 'error', text: '매칭된 상품이 없어요. 글 제목을 확인하세요.' };
    if (!matched.enabled) return { type: 'error', text: '이 상품은 봇 OFF 상태예요.' };

    const scamHit = detectScamKeyword(userMessage);
    if (scamHit) return { type: 'handoff', reason: scamHit, source: 'keyword' };

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: MODEL_CHAT, systemInstruction: buildSystemPrompt(matched) });

      const chatHistory = [];
      for (const m of history) {
        if (m.role !== 'user' && m.role !== 'bot') continue;
        const role = m.role === 'user' ? 'user' : 'model';
        if (chatHistory.length === 0 && role === 'model') continue;
        const last = chatHistory[chatHistory.length - 1];
        if (last && last.role === role) last.parts[0].text += '\n' + m.text;
        else chatHistory.push({ role, parts: [{ text: m.text }] });
      }

      const chat = model.startChat({ history: chatHistory, generationConfig: { maxOutputTokens: 200 } });
      const result = await chat.sendMessage(userMessage);

      const candidate = result.response?.candidates?.[0];
      if (candidate?.finishReason === 'SAFETY' || candidate?.finishReason === 'BLOCKED') {
        return { type: 'handoff', reason: 'Gemini 안전 필터 발동', source: 'safety' };
      }

      const text = (result.response.text() || '').trim();
      const handoffReason = parseHandoffTag(text);
      if (handoffReason) return { type: 'handoff', reason: handoffReason, source: 'llm' };
      return { type: 'reply', text: text || '네~' };
    } catch (err) {
      console.error('[Gemini API 오류]', err);
      const raw = err?.message || String(err);
      const lower = raw.toLowerCase();
      let hint;
      if (lower.includes('api_key') || (lower.includes('invalid') && lower.includes('key'))) hint = 'API 키 문제';
      else if (raw.includes('401') || raw.includes('403')) hint = '인증 실패';
      else if (raw.includes('404') || lower.includes('not found')) hint = '모델 접근 불가';
      else if (raw.includes('429') || lower.includes('quota')) hint = '할당량 초과';
      else if (lower.includes('fetch') || lower.includes('network')) hint = '네트워크 실패';
      else if (lower.includes('first content') || lower.includes('role')) hint = '대화 이력 형식 오류';
      else hint = '알 수 없음';
      return { type: 'error', text: `❌ ${hint}\n(F12 콘솔 확인) ${raw.slice(0, 120)}` };
    }
  }

  async function handleSend(override) {
    const text = (override ?? input).trim();
    if (!text || isTyping) return;
    if (!botActive) {
      setMessages((prev) => [...prev, { role: 'user', text, time: getTime() }]);
      setMessages((prev) => [...prev, { role: 'system', kind: 'silenced', text: matched ? `"${matched.label}" 봇 OFF — 직접 답해주세요` : '매칭된 상품이 없어 봇 비활성화', time: getTime() }]);
      setInput('');
      return;
    }

    const userMsg = { role: 'user', text, time: getTime() };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');

    if (mode === 'handoff') {
      setMessages((prev) => [...prev, { role: 'system', kind: 'silenced', text: '봇 일시 정지 중 — 사람이 직접 답해야 해요', time: getTime() }]);
      return;
    }

    setIsTyping(true);
    const result = await sendToAPI(text, messages);

    if (result.type === 'handoff') {
      setIsTyping(false);
      setMode('handoff');
      setHandoffInfo({ reason: result.reason, source: result.source, at: getTime() });
      setMessages((prev) => [...prev, { role: 'system', kind: 'handoff', text: `사람 확인 필요: ${result.reason}`, source: result.source, time: getTime() }]);
      return;
    }
    if (result.type === 'error') {
      setMessages((prev) => [...prev, { role: 'bot', text: result.text, time: getTime() }]);
      setIsTyping(false);
      return;
    }
    const chunks = result.text.split(/\n+/).filter((c) => c.trim().length > 0);
    const finalChunks = chunks.length > 0 ? chunks : [result.text];
    for (let i = 0; i < finalChunks.length; i++) {
      await new Promise((r) => setTimeout(r, 400 + Math.min(finalChunks[i].length * 18, 600)));
      setMessages((prev) => [...prev, { role: 'bot', text: finalChunks[i], time: getTime() }]);
    }
    setIsTyping(false);
  }

  const quickTests = [
    '판매 중인가요?', '상태 어떤가요?', '택배 가능해요?', '네고 가능할까요?',
    '구매할게요', '계좌번호 알려주세요', '카톡으로 얘기해요', '실물 사진 보내주세요',
  ];

  // 미리 정의된 예시 채팅방 (빠른 시뮬레이션용)
  const sampleRooms = [
    { name: '이슬비 (GTX 1060)', title: '판매완료고장난 ZOTAC 지포스 GTX 1060 그래픽카드 팝니다' },
    { name: '알버퉁 (GTX 1060)', title: '고장난 ZOTAC 지포스 GTX 1060 그래픽카드 팝니다\n디지털기기 · 10개월 전' },
    { name: '오타 테스트', title: '고장난 ZOTAC 지포스 GTX 1060 그래픽카드 팝나다' },
  ];

  return (
    <div className="grid md:grid-cols-[280px_1fr] gap-4">
      <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 p-4 h-fit">
        <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider mb-2">📌 시뮬레이터 안내</div>
        <div className="text-[11px] text-neutral-600 leading-relaxed bg-blue-50 border border-blue-100 rounded-lg p-2 mb-3">
          확장 프로그램 없이 봇 로직만 확인하는 화면이에요. 위 글 제목이 바뀌면 봇이 어떤 상품 설정을 쓰는지 자동으로 매칭돼요.
        </div>

        <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider mb-2 mt-4">📦 매칭된 상품</div>
        {matched ? (
          <div className="space-y-2 text-[12px]">
            <div className="bg-green-50 border border-green-200 rounded-lg p-2">
              <div className="flex items-center gap-1.5 text-green-700 font-bold text-[12px]"><Check size={12} /> {matched.label}</div>
              <div className="text-[10px] text-green-600 mt-0.5">{matched.productName || '(상품명 미설정)'}</div>
            </div>
            <SummaryRow label="판매가" value={`${matched.askingPrice.toLocaleString()}원`} />
            <SummaryRow label="마지노선" value={`${matched.minPrice.toLocaleString()}원`} highlight />
            <SummaryRow label="네고" value={matched.negoPolicy === 'none' ? '불가' : matched.negoPolicy === 'small' ? '소폭' : '협의'} />
            <SummaryRow label="거래" value={[matched.shippingAvailable && '택배', matched.localAvailable && '직거래'].filter(Boolean).join(' · ') || '미설정'} />
            <SummaryRow label="말투" value={matched.tone === 'friendly' ? '친근' : matched.tone === 'polite' ? '정중' : '쿨'} />
          </div>
        ) : (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-[11px] text-red-700">
            <div className="font-bold mb-1">❌ 매칭된 상품 없음</div>
            <div className="leading-relaxed">위에 글 제목을 입력하거나, 설정 탭에서 상품을 추가하고 "글 제목"을 채워주세요.</div>
          </div>
        )}

        <div className="mt-4 pt-4 border-t border-neutral-100">
          <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider mb-2">🤖 봇 상태</div>
          <div className={`rounded-lg px-3 py-2 text-[12px] font-semibold flex items-center justify-between ${
            !botActive ? 'bg-neutral-100 text-neutral-500 border border-neutral-200' :
            mode === 'handoff' ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-green-50 text-green-700 border border-green-200'
          }`} data-testid="mode-badge-sidebar">
            <span className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${!botActive ? 'bg-neutral-400' : mode === 'handoff' ? 'bg-red-500' : 'bg-green-500'}`} />
              {!botActive ? (matched ? '봇 OFF' : '매칭 없음') : mode === 'handoff' ? '수동 모드' : '자동 응답 중'}
            </span>
            {mode === 'handoff' && <button onClick={resumeBot} className="text-[11px] text-red-600 hover:text-red-800 underline" data-testid="resume-btn-sidebar">재개</button>}
          </div>
          {mode === 'handoff' && handoffInfo && (
            <div className="mt-2 text-[11px] text-neutral-600 leading-relaxed">
              <div className="font-medium text-neutral-800">전환 사유</div>
              <div className="mt-0.5">{handoffInfo.reason}</div>
              <div className="text-[10px] text-neutral-400 mt-1">{handoffInfo.source === 'keyword' ? '키워드 감지' : handoffInfo.source === 'safety' ? '안전 필터' : 'AI 판단'} · {handoffInfo.at}</div>
            </div>
          )}
        </div>

        <button onClick={resetChat} className="mt-4 w-full text-[12px] text-neutral-500 hover:text-neutral-900 border border-neutral-200 hover:border-neutral-400 rounded-lg py-2 transition flex items-center justify-center gap-1.5">
          <RotateCcw size={12} /> 대화 초기화
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 flex flex-col h-[760px] overflow-hidden">
        {/* 글 제목 시뮬레이터 */}
        <div className="px-4 py-3 bg-gradient-to-r from-blue-50 to-indigo-50 border-b border-blue-100">
          <div className="text-[11px] font-semibold text-blue-700 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
            <Copy size={11} /> 채팅방 글 제목 시뮬레이터
          </div>
          <input
            value={articleTitle}
            onChange={(e) => setArticleTitle(e.target.value)}
            placeholder="당근 채팅방 상단의 게시글 제목을 입력하면 자동으로 매칭된 상품 설정을 쓰게 됩니다"
            className="w-full bg-white border border-blue-200 rounded-lg px-3 py-1.5 text-[12px] focus:outline-none focus:border-blue-400 font-mono"
          />
          <div className="mt-2 flex gap-1.5 flex-wrap">
            <span className="text-[10px] text-blue-700 font-medium pt-1 mr-1">샘플:</span>
            {sampleRooms.map((r) => (
              <button key={r.name} onClick={() => setArticleTitle(r.title)} className="text-[10px] bg-white border border-blue-200 hover:border-blue-400 hover:bg-blue-50 rounded-full px-2 py-0.5 transition">
                {r.name}
              </button>
            ))}
            {articleTitle && <button onClick={() => setArticleTitle('')} className="text-[10px] bg-white border border-neutral-200 hover:border-neutral-400 rounded-full px-2 py-0.5 transition text-neutral-500">초기화</button>}
          </div>
        </div>

        {/* 채팅 헤더 */}
        <div className="flex items-center justify-between px-3 py-3 border-b border-neutral-100">
          <button className="p-1 text-neutral-800 hover:bg-neutral-100 rounded-full"><ChevronLeft size={24} strokeWidth={2.2} /></button>
          <div className="flex flex-col items-center leading-tight">
            <div className="font-semibold text-[15px] text-neutral-900 flex items-center gap-1.5">
              {matched?.label || '(매칭 없음)'}
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
                !botActive ? 'bg-neutral-400 text-white' : mode === 'handoff' ? 'bg-red-500 text-white handoff-pulse' : 'bg-green-500 text-white'
              }`} data-testid="mode-badge-header">
                {!botActive ? 'OFF' : mode === 'handoff' ? '수동' : '자동'}
              </span>
            </div>
            <div className="text-[11px] text-neutral-500">매너온도 42.5°C</div>
          </div>
          <button className="p-1 text-neutral-800 hover:bg-neutral-100 rounded-full"><MoreVertical size={22} strokeWidth={2.2} /></button>
        </div>

        {/* 핸드오프 배너 */}
        {mode === 'handoff' && handoffInfo && (
          <div className="handoff-banner px-4 py-3 bg-gradient-to-r from-red-50 to-orange-50 border-b-2 border-red-500 flex items-start gap-3" data-testid="handoff-banner">
            <div className="w-9 h-9 rounded-full bg-red-500 text-white flex items-center justify-center shrink-0 handoff-pulse"><ShieldAlert size={18} /></div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-bold text-red-700">봇 일시 정지 — 사람 확인 필요</div>
              <div className="text-[12px] text-red-600 mt-0.5 font-medium">
                {handoffInfo.reason}
                <span className="text-red-400 ml-1.5 font-normal">({handoffInfo.source === 'keyword' ? '위험 키워드 감지' : handoffInfo.source === 'safety' ? '안전 필터' : 'AI 판단'})</span>
              </div>
              <div className="text-[11px] text-neutral-600 mt-1 leading-relaxed">아래 입력창은 비어 있으니 직접 답변하거나, "봇 재개" 버튼을 누르세요.</div>
            </div>
            <button onClick={resumeBot} className="shrink-0 text-[12px] bg-red-500 hover:bg-red-600 text-white font-semibold px-3 py-2 rounded-lg flex items-center gap-1 transition" data-testid="resume-btn-banner">
              <Play size={12} /> 봇 재개
            </button>
          </div>
        )}

        {/* 상품 카드 (매칭된 상품 또는 안내) */}
        {matched ? (
          <div className="flex items-center gap-3 px-4 py-3 bg-neutral-50 border-b border-neutral-100">
            <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-neutral-700 to-neutral-900 flex items-center justify-center text-white shrink-0"><Package size={20} /></div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] text-neutral-500 truncate">{matched.productName || matched.articleTitle}</div>
              <div className="font-bold text-[15px] text-neutral-900">{matched.askingPrice.toLocaleString()}원</div>
            </div>
            <span className={`text-[11px] font-medium px-2 py-1 rounded border ${!botActive ? 'text-neutral-500 bg-neutral-100 border-neutral-200' : mode === 'handoff' ? 'text-red-600 bg-red-50 border-red-200' : 'text-[#FF6F0F] bg-orange-50 border-orange-200'}`}>
              {!botActive ? 'OFF' : mode === 'handoff' ? 'MANUAL' : 'AUTO'}
            </span>
          </div>
        ) : (
          <div className="px-4 py-3 bg-amber-50 border-b border-amber-200 text-[12px] text-amber-800 leading-relaxed">
            ⚠️ 매칭된 상품이 없어요. 위 시뮬레이터에 글 제목을 입력하거나 설정 탭에서 상품을 추가해 주세요.
          </div>
        )}

        {/* 메시지 피드 */}
        <div ref={scrollRef} className="scroll-area flex-1 overflow-y-auto px-3 py-4 space-y-3">
          <div className="flex justify-center"><span className="text-[11px] text-neutral-400 bg-neutral-100 px-3 py-0.5 rounded-full">오늘</span></div>
          {messages.map((m, i) => {
            if (m.role === 'system') {
              const kindStyles = {
                handoff: 'bg-red-100 text-red-700 border-red-200',
                resume: 'bg-green-100 text-green-700 border-green-200',
                silenced: 'bg-amber-100 text-amber-700 border-amber-200',
              };
              const kindIcons = { handoff: '🚨', resume: '▶️', silenced: '⏸️' };
              return (
                <div key={i} className="flex justify-center my-1 msg-animate" data-testid={`sys-msg-${m.kind}`}>
                  <div className={`text-[11px] px-3 py-1.5 rounded-lg max-w-[80%] text-center leading-relaxed border ${kindStyles[m.kind] || 'bg-neutral-100 text-neutral-700 border-neutral-200'}`}>
                    <span className="mr-1">{kindIcons[m.kind] || 'ℹ️'}</span>{m.text}
                  </div>
                </div>
              );
            }
            const isBot = m.role === 'bot';
            const prev = messages[i - 1];
            const next = messages[i + 1];
            const sameSenderAbove = prev && prev.role === m.role;
            const sameSenderBelow = next && next.role === m.role && next.time === m.time;
            const showTime = !sameSenderBelow;
            return (
              <div key={i} className={`flex ${isBot ? 'justify-start' : 'justify-end'} items-end gap-1.5 msg-animate`}>
                {isBot && <div className={`w-8 h-8 rounded-full bg-[#FF6F0F] text-white flex items-center justify-center text-sm shrink-0 ${sameSenderAbove ? 'invisible' : ''}`}>🥕</div>}
                {!isBot && showTime && <span className="text-[10px] text-neutral-400 mb-0.5 mr-0.5 whitespace-nowrap">{m.time}</span>}
                <div className={`max-w-[75%] px-3.5 py-2 text-[14px] leading-snug whitespace-pre-wrap break-words ${isBot ? 'bg-neutral-100 text-neutral-900 rounded-[18px] rounded-bl-[4px]' : 'bg-[#FF6F0F] text-white rounded-[18px] rounded-br-[4px]'}`}>{m.text}</div>
                {isBot && showTime && <span className="text-[10px] text-neutral-400 mb-0.5 ml-0.5 whitespace-nowrap">{m.time}</span>}
              </div>
            );
          })}
          {isTyping && (
            <div className="flex justify-start items-end gap-1.5 msg-animate">
              <div className="w-8 h-8 rounded-full bg-[#FF6F0F] text-white flex items-center justify-center text-sm shrink-0">🥕</div>
              <div className="bg-neutral-100 rounded-[18px] rounded-bl-[4px] px-4 py-3 flex items-center gap-1">
                <span className="dot w-1.5 h-1.5 bg-neutral-400 rounded-full inline-block" />
                <span className="dot w-1.5 h-1.5 bg-neutral-400 rounded-full inline-block" />
                <span className="dot w-1.5 h-1.5 bg-neutral-400 rounded-full inline-block" />
              </div>
            </div>
          )}
        </div>

        {/* 퀵 테스트 */}
        <div className="px-3 py-2 border-t border-neutral-100 bg-neutral-50/50">
          <div className="flex gap-2 overflow-x-auto scroll-area pb-1">
            {quickTests.map((q) => {
              const isHandoffTest = /계좌|카톡|실물 사진|구매할게요/.test(q);
              return (
                <button key={q} onClick={() => handleSend(q)} disabled={isTyping} className={`shrink-0 text-[12px] border px-3 py-1.5 rounded-full transition whitespace-nowrap disabled:opacity-50 bg-white ${isHandoffTest ? 'border-red-200 hover:border-red-500 hover:text-red-600 text-red-500' : 'border-neutral-200 hover:border-[#FF6F0F] hover:text-[#FF6F0F] text-neutral-600'}`} data-testid={`quick-${q}`}>{q}</button>
              );
            })}
          </div>
        </div>

        {/* 입력창 */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-t border-neutral-100">
          <button className="w-9 h-9 rounded-full bg-neutral-100 hover:bg-neutral-200 flex items-center justify-center text-neutral-600 shrink-0 transition"><Plus size={20} strokeWidth={2.2} /></button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSend())}
            placeholder={
              !matched ? '먼저 위에 글 제목을 입력해 주세요' :
              !matched.enabled ? '이 상품은 봇 OFF 상태예요' :
              mode === 'handoff' ? '봇 일시 정지 — 직접 답장하거나 위에서 재개하세요' :
              '구매자 입장에서 메시지 보내기'
            }
            disabled={isTyping}
            className="flex-1 bg-neutral-100 rounded-full px-4 py-2 text-[14px] text-neutral-900 placeholder-neutral-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-[#FF6F0F]/30 border border-transparent focus:border-[#FF6F0F]/40 transition"
            data-testid="chat-input"
          />
          <button onClick={() => handleSend()} disabled={!input.trim() || isTyping} className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition ${input.trim() && !isTyping ? 'bg-[#FF6F0F] text-white hover:bg-[#ee6200]' : 'bg-neutral-200 text-neutral-400'}`} data-testid="send-btn">
            <Send size={17} strokeWidth={2.3} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 작은 헬퍼들
// ============================================================
const inputCls = 'w-full bg-neutral-50 border border-neutral-200 rounded-lg px-3 py-2 text-[13px] text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-[#FF6F0F] focus:bg-white transition';

function Section({ title, emoji, children }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2.5"><span className="text-base">{emoji}</span><h3 className="font-semibold text-[14px] text-neutral-900">{title}</h3></div>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[11px] font-medium text-neutral-500 mb-1">{label}</div>
      {children}
    </label>
  );
}

function SegmentedControl({ value, onChange, options }) {
  return (
    <div className="flex bg-neutral-100 rounded-lg p-0.5 gap-0.5">
      {options.map((opt) => (
        <button key={opt.value} onClick={() => onChange(opt.value)} className={`flex-1 text-[12px] py-1.5 rounded-md font-medium transition ${value === opt.value ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-500 hover:text-neutral-800'}`}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange }) {
  return (
    <button onClick={() => onChange(!checked)} className={`relative w-10 h-6 rounded-full transition ${checked ? 'bg-[#FF6F0F]' : 'bg-neutral-300'}`}>
      <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition ${checked ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

function SummaryRow({ label, value, highlight }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="text-[11px] text-neutral-400 shrink-0">{label}</span>
      <span className={`text-[12px] text-right ${highlight ? 'font-semibold text-[#FF6F0F]' : 'text-neutral-800'}`}>{value}</span>
    </div>
  );
}
