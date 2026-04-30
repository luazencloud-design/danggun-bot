# 🥕 당근 자동응답 봇 (danggun-bot)

> **당근마켓 판매자를 위한 Gemini AI 기반 자동응답 봇 + 크롬 확장**
> 구매자 메시지에 1~2문장으로 자연스럽게 응대하고, 위험 신호(계좌이체·외부 메신저 등) 감지 시 즉시 수동 모드로 전환합니다.

- **GitHub:** [luazencloud-design/danggun-bot](https://github.com/luazencloud-design/danggun-bot) *(또는 TriplePistol/danggun-bot)*
- **버전:** v0.5
- **기술 스택:** React 18 + Vite · Tailwind · Gemini 2.5 Flash · Chrome Extension MV3
- **구조:** 웹앱(설정/테스트) + 크롬 확장(실시간 당근 채팅 연동) 2-tier

---

## 📋 목차

1. [한눈에 보는 구조](#-한눈에-보는-구조)
2. [핵심 기능](#-핵심-기능)
3. [파일 구성](#-파일-구성)
4. [코드 원리](#-코드-원리)
5. [핸드오프(수동 전환) 동작](#-핸드오프수동-전환-동작)
6. [다운로드 방법](#-다운로드-방법)
7. [외부 서비스 연동](#-외부-서비스-연동)
8. [실행 방법 (3가지)](#-실행-방법-3가지)
9. [사용 방법](#-사용-방법)
10. [LocalStorage / chrome.storage 구조](#-localstorage--chromestorage-구조)
11. [트러블슈팅](#-트러블슈팅)
12. [후임자 메모](#-후임자-메모)

---

## 🗺 한눈에 보는 구조

```
┌─────────────────────────────────────────────────────────┐
│                      웹 애플리케이션                        │
│                (http://localhost:5173)                   │
├─────────────────────────────────────────────────────────┤
│ • 상품 설정 (가격, 마지노선, 거래방법, 말투)              │
│ • URL/텍스트로 상품 자동 불러오기 (Gemini Search grounding) │
│ • 채팅 시뮬레이터 (확장 없이 봇 로직 테스트)             │
│ • 실시간 방 상태 모니터링 (확장 연동 시)                 │
└────────────┬────────────────────────────────┬───────────┘
             │ window.postMessage              │ window.postMessage
             │ (bridge.js)                     │ (content.js)
┌────────────▼─────────────┐   ┌──────────────▼──────────┐
│  Chrome 확장 Bridge.js   │   │ Content Script (당근)    │
│  localhost ↔ 확장 통신   │   │ • 사이드바 스크래핑      │
│  (SYNC_CONFIG, GET_ROOMS)│   │ • 글 제목 추출          │
└────────────┬─────────────┘   │ • 새 메시지 감지(MutObs) │
             │ chrome.storage  │ • 답변 입력창 주입+엔터  │
             │                 └──────────────┬──────────┘
┌────────────▼────────────────────────────────▼──────────┐
│           Background Service Worker (background.js)     │
│  • NEW_MESSAGE 수신                                     │
│  • SCAM_PATTERNS 키워드 사전 차단                        │
│  • VILLAIN_PATTERNS 10종 사전 차단                      │
│  • Gemini API 호출 (대화 이력 8개 유지)                 │
│  • [HANDOFF:사유] 태그 파싱                             │
│  • 위험도 누적 (riskScore 0~100)                        │
│  • INJECT_REPLY로 답변 주입                             │
└─────────────────────────────────────────────────────────┘
             │
        Gemini generativelanguage API
             │
        Google Gemini 2.5 Flash
```

---

## ✨ 핵심 기능

- **🔗 URL 자동 불러오기** — 당근 상품 URL 붙여넣기 → Gemini가 상품명/가격/상태 자동 채움
- **📋 텍스트 백업 모드** — URL 차단 시 상품 설명 텍스트 붙여넣기로도 자동 분석
- **⚙️ 상품별 정책** — 판매가, 마지노선(자동 97% 계산), 네고 정책(불가/소폭/협의), 거래방법(직거래·택배 중 1개만)
- **💬 자연스러운 응답** — 1~2문장, 이모지 금지, tone(친근/정중/쿨)
- **🚨 자동 핸드오프** — 위험 키워드 / 빌런 10종 / AI 판단 / 안전필터 / 오프토픽 누적 시 즉시 수동 전환
- **📊 위험도 누적 엔진** — 메시지마다 점수 가감, 50점 도달 시 자동 수동 전환
- **🔌 크롬 확장 연동** — 당근 채팅창에 직접 답변 주입 + 새 메시지 자동 감지

---

## 📁 파일 구성

```
danggeun-autobot/
├── 실행.bat                    Windows 더블클릭 런처 (npm install + dev 서버)
├── 배포용_만들기.bat / .ps1     dist/ 정적 빌드 생성
├── 크롬확장_설치.bat            chrome://extensions 자동 오픈
├── index.html                  Vite 진입점
├── package.json                React 18 + Vite + @google/generative-ai + Tailwind
├── vite.config.js              포트 5173 + auto-open 브라우저
├── tailwind.config.js / postcss.config.js
├── src/
│   ├── main.jsx                React DOM 마운트
│   ├── App.jsx                 ⭐ 메인 컴포넌트 (~3,000줄)
│   │                            - ConfigPanel (상품 카드 CRUD)
│   │                            - CustomerPanel / ExtensionRoomCard (실시간 방 모니터)
│   │                            - ChatPanel (시뮬레이터)
│   │                            - useExtensionBridge (postMessage 훅)
│   │                            - DEFAULT_CONFIG / SCAM_PATTERNS / DEFAULT_PRODUCT
│   └── index.css               Tailwind + 커스텀 스타일
├── extension/                  ⭐ Chrome Extension MV3
│   ├── manifest.json           v0.4.0, host_permissions, content_scripts
│   ├── bridge.js               localhost ↔ chrome.storage 동기화
│   ├── content.js              당근 채팅 페이지 직접 주입 (~548줄)
│   │                            - 사이드바 스크래핑 (300ms debounce)
│   │                            - MutationObserver로 새 메시지 감지
│   │                            - 핸드오프 배너 (Shadow DOM)
│   │                            - INJECT_REPLY 처리 (입력창 채우기 + 엔터)
│   └── background.js           ⭐ 핵심 로직 (~945줄)
│                                - SCAM_PATTERNS (8종)
│                                - VILLAIN_PATTERNS (10종)
│                                - EMOTION_PATTERNS / STUCK_PATTERNS
│                                - buildSystemPrompt (~1500줄 시스템 프롬프트)
│                                - callGemini (재시도 포함)
│                                - cleanReply (이모지/이모티콘 정리)
│                                - 대화 이력 (방별 8개)
└── README.md                   이 문서
```

---

## 🧬 코드 원리

### A. 메시지 수신 → 응답 전체 흐름

```
1️⃣  당근 채팅 페이지에 사용자가 메시지 입력
    ↓
2️⃣  content.js MutationObserver 감지
    - 메시지 ID 추출 (id="for-scroll-{id}")
    - 판매자(right) 메시지는 무시, 구매자(left)만 처리
    - safeSend({ type: 'NEW_MESSAGE', roomUrl, articleTitle, text, timestamp })
    ↓
3️⃣  background.js handleNewMessage()
    [a] 웹앱 설정 로드 (chrome.storage.local: webapp_config, webapp_apikey)
    [b] articleTitle로 상품 매칭 → product 객체
    [c] roomSettings 확인 — enabled? manualActive?
    ↓
4️⃣  4단계 위험 신호 감지 (사전 차단)
    SCAM_PATTERNS  → /계좌이체|카톡|010-xxx|이메일|페이팔|중고나라/ 등 8종
    VILLAIN_PATTERNS → 빌런 10종 (예약 잠수, 현장 재네고 등)
    EMOTION_PATTERNS → /환불|반품|신고|컴플레인/
    STUCK_PATTERNS → /무슨 말|다시 설명/
    ↓ 모두 통과 시
5️⃣  위험도 갱신 (riskScore 0~100)
    delta = computeRiskDelta(text)
    -3 ~ -1: 정상 문의 (재고/가격/상태)
    +10 ~ +15: 네고/예약
    +30 ~ +40: 환불/신고/계좌
    next = clamp(0, 100)
    if (next >= 50) → 자동 수동 전환
    ↓
6️⃣  Gemini API 호출
    callGemini({
      apiKey,
      model: 'gemini-2.5-flash',
      systemInstruction: buildSystemPrompt(product),  // 1500줄
      history: 최근 8개 메시지 (chrome.storage room_history),
      userMessage: text
    })
    ↓
7️⃣  응답 처리
    - finishReason === 'SAFETY' → HANDOFF
    - [HANDOFF:사유] 태그 감지 → HANDOFF
    - 정상 응답 → cleanReply (이모지/HANDOFF 흔적 제거, tone별 이모티콘 처리)
    ↓
8️⃣  답변 주입
    chrome.tabs.sendMessage(tabId, { type: 'INJECT_REPLY', roomUrl, reply })
    ↓
9️⃣  content.js INJECT_REPLY 처리
    - textarea[maxlength="1000"] 찾기
    - value = reply
    - input 이벤트 dispatch (자동 height 조정)
    - 전송 버튼 클릭 또는 Enter dispatch
    ↓
🔟  대화 이력 append (chrome.storage.local: room_history[roomUrl])
```

### B. URL 자동 불러오기 (`MODEL_IMPORT`)

```js
// Gemini Google Search grounding 활성화
const result = await genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  tools: [{ googleSearch: {} }]
}).generateContent({
  contents: [{ role: 'user', parts: [{ text: `${url}\n\n위 URL의 상품 정보를 JSON으로 추출` }] }]
})

// JSON 파싱: { productName, askingPrice, condition, includes, extraInfo, localNote }
```

### C. 시스템 프롬프트 (`buildSystemPrompt` ~1500줄)

위치: `extension/background.js` 줄 293~497

**구조:**
1. 역할 정의 — "너는 당근마켓 판매자야"
2. 절대 규칙 5개
   - 이모지 금지 (😊 등 유니코드)
   - 1~2문장
   - 최저가 미만 절대 금지
   - 주소·연락처 정보 금지
   - 거래 방법 1개만 ("둘 다 가능" X)
3. 사람답게 응대 6가지 (상대 톤 매칭, 인사 회피 등)
4. HANDOFF 태그 규칙 (`[HANDOFF:이유]`, 20자 이내)
5. 명확화 질문 (모호한 질문에)
6. 빌런 10종 대응 가이드
7. 상품 정보 (filled-in by template)
8. 거래 방법 (택배 OR 직거래)
9. 가격 정책 (네고 한계)
10. 응대 스타일 (말투)

---

## 🚨 핸드오프(수동 전환) 동작

봇은 다음 신호 감지 시 **즉시 일시 정지** + 빨강 배너 표시:

### 감지 포인트 (5단계)

```
[1] 키워드 필터 (사전 차단, API 전)   → SCAM_PATTERNS 8종
[2] 빌런 10종 (사전 차단, API 전)     → VILLAIN_PATTERNS
[3] AI 판단 (API 후)                  → [HANDOFF:사유] 태그
[4] 안전 필터 (Gemini)                → finishReason === 'SAFETY'
[5] 오프토픽 누적 2회 + 위험도 50+    → 자동 수동
```

### SCAM_PATTERNS (사전 차단)

```js
[
  { re: /계좌\s*이체|입금\s*계좌/, label: '계좌이체·무통장 입금' },
  { re: /카톡|카카오톡|오픈\s*채팅/, label: '카톡·외부 메신저 이동' },
  { re: /010[-\s.]?\d{3,4}[-\s.]?\d{4}/, label: '전화번호 교환' },
  { re: /외부\s*결제|직접\s*결제/, label: '외부/직접 결제' },
  { re: /해외\s*배송|국제\s*배송/, label: '해외 배송' },
  { re: /이메일|@\w+\.\w+|http(s)?:\/\//, label: '이메일·외부 링크' },
  { re: /페이팔|위챗|알리페이/, label: '해외 결제 수단' },
  { re: /중고나라|번개장터/, label: '외부 플랫폼 언급' },
]
```

### UI 변화

```
┌─────────────────────────────────────────┐
│ 🚨 봇 일시 정지 — 사람 확인 필요          │
│ 사유: 계좌이체·무통장 입금                │
│ [봇 재개] 버튼                            │
└─────────────────────────────────────────┘
```

- 채팅 입력창은 **비어있는 상태 유지** (사용자가 실수로 엔터 눌러도 안전)
- 봇이 정지된 동안 구매자가 추가 메시지를 보내도 **사일런스** 상태

---

## 📥 다운로드 방법

```bash
git clone https://github.com/luazencloud-design/danggun-bot.git
cd danggun-bot
```

또는 GitHub에서 **Code → Download ZIP**.

---

## 🔑 외부 서비스 연동

### 1. Node.js 18+ 설치

[nodejs.org](https://nodejs.org)에서 LTS 다운로드.

### 2. Gemini API Key 발급

[aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)에서 무료 발급. `AIza...`로 시작.

**비용 (Gemini 2.5 Flash):**
- 일반 채팅: 메시지당 약 $0.0001 내외
- URL 불러오기: Search grounding 포함이라 약간 더 높음
- 무료 할당량부터 시작 가능

### 3. (선택) 크롬 확장 설치

크롬 → `chrome://extensions` → **개발자 모드 ON** → **압축해제된 확장 프로그램 로드** → `extension/` 폴더 선택.

---

## ▶ 실행 방법 (3가지)

### 방법 A — 더블클릭 (가장 쉬움) ⭐

`실행.bat` 파일을 더블클릭.
- 첫 실행 시 의존성 자동 설치 (1~2분)
- 이후엔 바로 dev 서버 + 브라우저 자동 열림
- 종료: 검은 창에서 `Ctrl+C`

### 방법 B — 명령줄

```bash
cd danggeun-autobot
npm install     # 최초 1회
npm run dev     # 자동으로 http://localhost:5173 오픈
```

### 방법 C — 정적 빌드 + 배포

```bash
npm run build  # 또는 배포용_만들기.bat
# → dist/ 폴더에 정적 번들 생성
# 정적 호스팅 (GitHub Pages, Vercel 등)에 배포 가능
```

---

## 📖 사용 방법

### 1단계: 상품 정보 불러오기 (3가지)

**A. 당근 URL로 자동 불러오기 ⭐**
1. 당근 앱 → 내 상품 → 공유 → 링크 복사
2. 설정 탭 상단 **"URL"** 모드에 붙여넣기
3. **"불러오기"** 버튼 → 자동 채움

**B. 텍스트 직접 붙여넣기** (URL 차단 시)
1. **"직접 붙여넣기"** 탭
2. 상품 페이지의 제목·가격·설명 복붙
3. **"텍스트에서 불러오기"** 클릭

**C. 직접 입력**
- 각 필드 수동 입력

### 2단계: 판매 정책 설정

- **가격·네고**: 판매가, 마지노선(판매가의 97% 자동), 네고 정책(불가/소폭/협의)
- **거래 방법**: 직거래 OR 택배 (둘 중 하나만, 절대 둘 다 가능 X)
- **응대 스타일**: 친근/정중/쿨, 추가 규칙

### 3단계: 채팅 테스트

상단 **"채팅 테스트"** 탭에서 구매자 입장 메시지 보내기:
- 정상: "판매 중인가요?" / "상태 어떤가요?" / "네고 가능?" / "택배 가능?"
- 위험: "계좌번호 알려주세요" / "카톡으로 얘기해요" / "실물 사진 보내주세요"
  → 빨강 배너로 수동 모드 전환 확인

### 4단계: 크롬 확장으로 실전 운영

1. `chrome://extensions` → 확장 로드 (`extension/` 폴더)
2. 당근 웹페이지 (`chat.daangn.com`) 열기
3. 웹앱에서 상품 설정 + API 키 저장 → 확장에 자동 동기화
4. 구매자 메시지가 오면 자동 응답 + 입력창에 답변 주입

---

## 💾 LocalStorage / chrome.storage 구조

### 웹 앱 (LocalStorage)

```js
localStorage.setItem('danggeun_autobot_config_v2', JSON.stringify({
  products: [
    {
      id: 'p_xxx', label: '아이폰 14',
      articleTitle: '...', productName: '...', askingPrice: 780000, minPrice: 760000,
      negoPolicy: 'small', condition: '...', includes: '...', extraInfo: '...',
      tradeMethod: 'local', shippingNote: '', localNote: '',
      tone: 'friendly', customRules: '', enabled: true
    }
  ],
  customers: [...],
  roomSettings: {
    '/room/xxxxx': {
      enabled, manualProductId, manualActive, manualReason, manualSource,
      manualAt, riskScore, offTopicCount, askedForTradeInfo,
      tradeInfo: { meetingTime, meetingPlace, recipientName, recipientAddress, recipientPhone }
    }
  }
}))

localStorage.setItem('danggeun_autobot_gemini_apikey', 'AIza...')
```

### 크롬 확장 (chrome.storage.local)

```js
{
  webapp_config: { ...웹앱과 동기화 },
  webapp_apikey: 'AIza...',
  daangn_rooms: [ { roomUrl, nickname, articleTitle, official, selected, ... } ],
  daangn_rooms_updated_at: timestamp,
  daangn_article_title_cache: { '/room/xxxxx': '아이폰 14 ...' },
  room_history: { '/room/xxxxx': [ { role: 'user'|'model', text, at }, ... 최근 8개 ] }
}
```

### manualSource 종류

`'keyword' | 'emotion' | 'stuck' | 'nego2' | 'risk' | 'villain' | 'llm' | 'safety' | 'end-detect'`

---

## 🛠 트러블슈팅

| 증상 | 원인 / 해결 |
|------|-------------|
| URL 불러오기 실패 | 당근이 봇 접근 차단. **"직접 붙여넣기"** 탭 사용 |
| 답변이 안 주입됨 | 당근 DOM 구조 변경 가능성. content.js의 selector 점검 |
| Gemini 응답 늦음 | 무료 한도 초과 / 503 에러 → 자동 재시도 포함 |
| 봇이 자꾸 정지함 | riskScore 누적 또는 키워드 매칭. SCAM_PATTERNS 점검 |
| 이모지가 응답에 들어감 | `cleanReply()`의 `stripStrongEmoji` 동작 확인 |
| 확장이 웹앱과 동기화 안 됨 | `bridge.js`의 host_permissions 확인 (localhost 포함되어야 함) |

---

## 📝 후임자 메모

### 자주 변경하는 곳

| 변경 항목 | 위치 |
|----------|------|
| 시스템 프롬프트 (응대 톤/규칙) | `extension/background.js` 줄 293~497 (`buildSystemPrompt`) |
| 위험 키워드 추가 | `extension/background.js` 줄 106~121 (`SCAM_PATTERNS`) |
| 빌런 패턴 추가 | `extension/background.js` 줄 ~ (`VILLAIN_PATTERNS`) |
| 위험도 임계값 | `extension/background.js` `RISK_THRESHOLD_AUTO_MANUAL = 50` |
| 대화 이력 길이 | `extension/background.js` `MAX_HISTORY_TURNS = 8` |
| Gemini 모델 | `src/App.jsx` 상단 / `extension/background.js` 상단 `MODEL_CHAT`, `MODEL_IMPORT` |
| 마지노선 자동 비율 | `src/App.jsx` `applyToConfig` 함수의 `0.97` |

### 보안 주의

- **API 키는 LocalStorage 저장** (브라우저 내) — 본인 PC 전용
- 실제 웹서비스 배포 시 백엔드 서버 경유 필수 (직접 노출 X)
- 당근 DOM 변경에 대비해 selector를 폴백 형태로 유지

### 알려진 제약

1. **MV3 service worker 휘발성** — chrome.storage 사용 (메모리 X)
2. **당근 DOM 변경 시 content.js 깨짐** — 정기 점검 필요
3. **Gemini 응답 지연** — 1~3초, 너무 빠르면 부자연스러움 (적당한 딜레이 의도적)
4. **이모지 검출 한계** — 새 유니코드 이모지 추가 시 `stripStrongEmoji` 정규식 갱신 필요

### 디버깅

**웹 앱** (F12 콘솔):
```
[당근봇 bg] service worker alive (v0.5)
[당근봇] content script loaded at https://chat.daangn.com/room/...
[당근봇 bridge] loaded on http://localhost:5173
```

**확장 background**: `chrome://extensions` → "당근 자동응답 봇" → "백그라운드 페이지" 클릭 → DevTools

---

*당근 자동응답 봇 v0.5 — Gemini 2.5 Flash · React 18 · Chrome Extension MV3*
