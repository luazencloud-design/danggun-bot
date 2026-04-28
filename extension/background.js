// ============================================================
// 당근 자동응답 봇 - background service worker (v0.5)
//
// 새 기능:
//  - 이모티콘 전면 금지
//  - 빌런 10종 대응 문구 내장
//  - 확장 키워드: 감정/컴플레인, 대화막힘, 협상 2차, 사기, 빌런
//  - 위험도 엔진 (누적 점수 + 자동 수동 전환)
//  - 수동 채팅 상태는 roomSettings에 직접 저장 (봇 OFF와 분리)
// ============================================================

const TAG = '[당근봇 bg]';
console.log(TAG, 'service worker alive (v0.5)');

const MODEL_CHAT = 'gemini-2.5-flash';
const RISK_THRESHOLD_AUTO_MANUAL = 50;

// ============================================================
// 유틸 — App.jsx와 동일 로직 복제
// ============================================================
function normalizeForMatch(s) {
  return (s || '').replace(/\s+/g, '').toLowerCase();
}
function matchProductByArticleTitle(products, articleTitle) {
  if (!articleTitle || !products?.length) return null;
  const norm = normalizeForMatch(articleTitle);
  for (const p of products) {
    const c = normalizeForMatch(p.articleTitle);
    if (!c) continue;
    if (norm.includes(c) || c.includes(norm)) return p;
  }
  return null;
}
function getRoomSettings(roomSettings, roomUrl) {
  const stored = roomSettings?.[roomUrl] || {};
  const defaults = {
    enabled: true,
    manualProductId: null,
    manualActive: false,
    manualReason: null,
    manualSource: null,
    manualAt: null,
    riskScore: 0,
    offTopicCount: 0,
    askedForTradeInfo: false,
  };
  return {
    ...defaults,
    ...stored,
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

function isTradeInfoComplete(tradeInfo, tradeMethod) {
  if (!tradeInfo) return false;
  if (tradeMethod === 'shipping') {
    return !!(tradeInfo.recipientName?.trim() && tradeInfo.recipientAddress?.trim() && tradeInfo.recipientPhone?.trim());
  }
  return !!(tradeInfo.meetingTime?.trim() && tradeInfo.meetingPlace?.trim());
}

function checkMissingTradeInfo(tradeInfo, tradeMethod) {
  const missing = [];
  if (tradeMethod === 'shipping') {
    if (!tradeInfo?.recipientName?.trim()) missing.push('recipientName');
    if (!tradeInfo?.recipientAddress?.trim()) missing.push('recipientAddress');
    if (!tradeInfo?.recipientPhone?.trim()) missing.push('recipientPhone');
  } else {
    if (!tradeInfo?.meetingTime?.trim()) missing.push('meetingTime');
    if (!tradeInfo?.meetingPlace?.trim()) missing.push('meetingPlace');
  }
  return missing;
}

// 대화 종료 직전 — 누락 정보 묻는 자연스러운 한국어 문구 생성
function generateTradeInfoAsk(missing, tradeMethod) {
  if (tradeMethod === 'local') {
    if (missing.includes('meetingTime') && missing.includes('meetingPlace')) {
      return '거래 마무리 전에 만날 시간과 장소 알려주실 수 있을까요?';
    }
    if (missing.includes('meetingTime')) return '몇 시쯤 만나면 좋을까요?';
    if (missing.includes('meetingPlace')) return '어디서 만나면 될까요?';
  } else {
    const labels = {
      recipientName: '수령인 성함',
      recipientAddress: '배송 주소',
      recipientPhone: '연락 가능한 번호',
    };
    const items = missing.map((m) => labels[m]).filter(Boolean);
    if (items.length === 0) return '';
    return `발송 전에 ${items.join(', ')} 알려주실 수 있을까요?`;
  }
  return '';
}

// ============================================================
// 사기·위험 키워드 (기존 SCAM 확장)
// ============================================================
const SCAM_PATTERNS = [
  { re: /계좌\s*이체|입금\s*계좌|계좌\s*번호|무통장|계좌\s*먼저/, label: '계좌이체·무통장 요구' },
  { re: /카톡|카카오톡|오픈\s*채팅|오카방|오픈카톡/, label: '카톡·외부 메신저 이동' },
  { re: /010[-\s.]?\d{3,4}[-\s.]?\d{4}|핸드폰\s*번호|전화번호/, label: '전화번호 교환' },
  { re: /외부\s*결제|직접\s*결제|현금\s*결제|직접\s*송금|안전결제\s*링크/, label: '외부 결제 요구' },
  { re: /해외\s*배송|해외\s*발송|해외\s*직구/, label: '해외 배송 요청' },
  { re: /이메일\s*주소|메일\s*주소|@[\w-]+\.(com|co\.kr|net|org)/i, label: '이메일/외부 링크' },
  { re: /paypal|페이팔|위챗|wechat|알리페이|alipay/i, label: '해외 결제수단' },
  { re: /중고나라|번개장터|당근\s*외|다른\s*플랫폼/, label: '외부 플랫폼 이동' },
  { re: /먼저\s*보내|송장\s*먼저|입금\s*전에\s*보내/, label: '선발송 사기 의심' },
  { re: /문자로\s*주소|주소\s*먼저\s*(알려|보내)/, label: '주소 선요구 (사기 의심)' },
];
function detectScamKeyword(text) {
  for (const { re, label } of SCAM_PATTERNS) if (re.test(text)) return label;
  return null;
}

// ============================================================
// 추가 감지 — 감정/컴플레인, 대화막힘, 협상, 빌런
// ============================================================
const EMOTION_PATTERNS = [
  { re: /환불\s*해|반품\s*해|취소\s*해/, label: '환불·반품 요청' },
  { re: /신고\s*(하|할)|고소|컴플레인/, label: '신고·컴플레인' },
  { re: /사기\s*(꾼|당|치|네)|속였|속이|거짓말/, label: '사기 의혹 제기' },
  { re: /불만|짜증|화가|실망|기분\s*(나|안)|어이없/, label: '감정 격화' },
];
function detectEmotion(text) {
  for (const { re, label } of EMOTION_PATTERNS) if (re.test(text)) return label;
  return null;
}

const STUCK_PATTERNS = [
  { re: /무슨\s*말|다시\s*설명|이해가\s*안|이해\s*안\s*(되|가)/, label: '대화 이해 실패' },
  { re: /제\s*말은\s*그게\s*아|아니\s*그게|그게\s*아니/, label: '의사소통 막힘' },
  { re: /동문서답|알아듣|못\s*알아\s*들/, label: '대화 동문서답 호소' },
];
function detectStuck(text) {
  for (const { re, label } of STUCK_PATTERNS) if (re.test(text)) return label;
  return null;
}

const NEGO_PATTERNS = [
  { re: /택배비\s*포함/, label: '택배비 네고' },
  { re: /(\d+\s*개|두\s*개|세\s*개|여러\s*개|묶음|세트)\s*(사|구매|하면)/, label: '묶음 할인 요구' },
  { re: /오늘\s*바로\s*사(면|면은|면요)/, label: '즉시구매 조건 네고' },
];
function detectNegoAgain(text) {
  for (const { re, label } of NEGO_PATTERNS) if (re.test(text)) return label;
  return null;
}

// 빌런 10종 — 감지되면 바로 수동 전환
const VILLAIN_PATTERNS = [
  { id: 1, re: /내일까지\s*(빼|보류|예약)|월급\s*들어오면|밤에\s*(갈게|뵐게)|꼭\s*(살게|가겠|구매)/, label: '① 예약 잠수 의심' },
  { id: 2, re: /현장\s*(가서|와서|도착).*(네고|깎|할인)|흠집\s*(있|보이)/, label: '② 현장 재네고 시도' },
  { id: 3, re: /집\s*(앞|까지)\s*(가져|배달)|택배비\s*(도|내\s*주|부담)/, label: '③ 무료나눔 갑질' },
  { id: 4, re: /정품\s*맞|영수증\s*(있|보내)|구매처|박스\s*안쪽|택\s*사진\s*더/, label: '④ 과도한 검증' },
  { id: 5, re: /집에\s*와서\s*보니|생각보다\s*(작|커|달)|마음에\s*안\s*(들|드)/, label: '⑤ 변심 환불' },
  { id: 6, re: /먼저\s*보내\s*주|송장\s*먼저|회사라\s*(지금|이체)|나중에\s*이체/, label: '⑥ 선발송 요구 (사기)' },
  { id: 7, re: /카톡으로\s*(얘기|이야기|넘어)|링크에서\s*결제|안전결제\s*링크|문자로\s*주소/, label: '⑦ 외부 유도 (사기)' },
  { id: 8, re: /아이가\s*잘못|남편이\s*반대|엄마가\s*필요\s*없|다른\s*데서\s*(더\s*싸|샀)/, label: '⑧ 취소 빌런' },
  { id: 9, re: /\d+분\s*(늦|지연)|길을\s*못\s*찾|내일\s*다시\s*가능|근처인데\s*길/, label: '⑨ 시간 약속 파괴' },
  { id: 10, re: /왜\s*파세요|사연\s*(이|있)|요즘\s*장사|저도\s*예전에/, label: '⑩ 감정 교환' },
];
function detectVillain(text) {
  for (const v of VILLAIN_PATTERNS) if (v.re.test(text)) return v;
  return null;
}

// HANDOFF 태그 감지 — 모든 변형 형태 잡음
//  - 정상: "[HANDOFF:이유]"
//  - 닫는 ] 없음: "[HANDOFF:설"
//  - 여는 [ 없음: "HANDOFF:실물"
//  - 대시 구분자: "HANDOFF - 실물"
//  - 빈 태그: "[HANDOFF" 또는 "HANDOFF" 단독
//  - 소문자: "[handoff:실]"
function detectHandoffIntent(text) {
  if (!text) return null;
  // 첫째: 텍스트 어디에든 "HANDOFF" 단어가 있는지
  const idx = text.search(/\[?\s*HANDOFF\b/i);
  if (idx === -1) return null;

  // HANDOFF 위치부터 잘라내서 이유 추출
  const sub = text.slice(idx);
  // [optional [ + HANDOFF + optional space/colon/dash + reason + optional ]
  const m = sub.match(/\[?\s*HANDOFF\s*[:\-]?\s*([^\]\n]*?)\s*\]?$/i)
         || sub.match(/\[?\s*HANDOFF\s*[:\-]?\s*([^\]\n]*)/i);
  const reason = (m && m[1] ? m[1].trim() : '').replace(/[^\w\s가-힣·,()]/g, '').trim();
  return reason.slice(0, 60) || '사람 확인 필요 (태그 형식 불완전)';
}

// 이모티콘 강제 제거 (어떤 톤이든 사기성 이모지·심볼은 항상 제거)
function stripStrongEmoji(text) {
  if (!text) return '';
  let out = text;
  out = out.replace(/[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{1F600}-\u{1F64F}\u{1F900}-\u{1F9FF}]/gu, '');
  out = out.replace(/[\u{FE0F}\u{200D}]/gu, '');
  return out;
}

// 톤별 답변 정리
//  - friendly: 이모지·이모티콘 일부 허용 (^^, ㅎ 1개, ~ 1개)
//  - polite/cool: 모든 이모티콘 강제 제거
//  - 모든 톤에서: HANDOFF 흔적 강제 제거 (방어 차원)
function cleanReply(text, tone) {
  if (!text) return '';
  let out = text;

  // 방어망: 어떤 형태든 HANDOFF 흔적이 있으면 강제 제거
  // (detectHandoffIntent가 이미 잡아야 하지만, 혹시 누락 대비)
  out = out.replace(/\[?\s*HANDOFF\s*[:\-]?\s*[^\]\n]*\]?/gi, '').trim();

  // 유니코드 이모지는 모든 톤에서 제거 (😊 같은 봇 티 나는 것)
  out = stripStrongEmoji(out);

  if (tone !== 'friendly') {
    // 정중·쿨: 텍스트 이모티콘도 모두 제거
    out = out.replace(/\^[_\-\^]?\^/g, '');
    out = out.replace(/[ㅋㅎ]+/g, '');
    out = out.replace(/[~]{1,}/g, '');
  } else {
    // 친근: 텍스트 이모티콘 살리되 과한 건 정리
    out = out.replace(/[ㅋㅎ]{3,}/g, (m) => m[0].repeat(2));
    out = out.replace(/[~]{3,}/g, '~~');
  }
  out = out.replace(/[!?]{3,}/g, (m) => m[0]);
  return out.replace(/\s+/g, ' ').trim();
}

// ============================================================
// 오프토픽 감지 — 거래 무관 대화 (놀림/비방/정치/종교/AI테스트/위협)
// 1차: "네?" 식으로 짧게 응답. 2차 누적: 수동 전환
// ============================================================
const OFFTOPIC_PATTERNS = [
  // 욕설·비방 (심한 것만)
  { re: /멍청이|바보\s*(야|냐)|등신|개새|씨\s*발|존나|좆|병신|꺼져|닥쳐|시끄러워/, label: '욕설·비방' },
  // 정치
  { re: /대통령|국회의원|여당|야당|민주당|국민의힘|정의당|윤석열|이재명|탄핵|선거/, label: '정치 주제' },
  // 종교
  { re: /하나님|예수|부처|불교|기독교|천주교|이슬람|교회\s*(오세|나와)|성경|전도\s*하|포교/, label: '종교 주제' },
  // AI 정체성 테스트
  { re: /너\s*(AI|봇|로봇|사람|인공지능|인간)\s*(이|인|맞|냐|야|니|지)|AI\s*(야|냐|맞|니|지|아니)|진짜\s*사람\s*(맞|이|인)|chat\s*gpt|gemini|claude|gpt|알고리즘|프롬프트/i, label: 'AI 정체성 확인 시도' },
  // 판매자 신원·배경 질문 (외국인이세요?, 결혼하셨어요? 등 — Q "외국인이세요?" 같은 함정에 엉뚱한 답 방지)
  { re: /외국인\s*(이|인)\s*(세|시|에)|한국인\s*(이|인)\s*(세|시|에)|어디\s*살|어느\s*동네|몇\s*살|결혼\s*(하|했|했나)|(남자|여자)\s*(세요|시|이세)|학생|직업\s*(이|뭐)|어디\s*다(녀|니)|성별/, label: '판매자 신원 질문' },
  // 위협성
  { re: /죽여\s*(버|주)|때릴\s*(거|꺼)|때린다|집\s*앞\s*(으로|까지)|찾아갈\s*(거|꺼)|주소\s*알아\s*(내|두)|신상\s*(털|공개)|(너|당신)\s*죽/, label: '위협성 메시지' },
  // 기타 명백한 거래 이탈
  { re: /(여친|남친|애인|연애)\s*(있|해)|전화번호\s*(줘|알려)|만나\s*(주|보)/, label: '개인 친분 시도' },
  // 조롱·놀림 (구매 의사 없이 떠보기)
  { re: /진짜\s*파(는|시는)\s*거|이거\s*진짜\s*맞|혹시\s*낚시|어\s*그건/, label: '구매 의사 떠보기/조롱' },
];

function detectOffTopic(text) {
  for (const { re, label } of OFFTOPIC_PATTERNS) if (re.test(text)) return label;
  return null;
}

// ============================================================
// 위험도 엔진 — 메시지마다 델타 계산
// ============================================================
function computeRiskDelta(text) {
  let delta = 0;
  // 낮음 (정상 문의) — 감소
  if (/재고|남아|있나요|팔렸|가격|얼마|상태|어때|사용감|택배\s*(가능|돼|돼요)|구성/.test(text)) delta -= 3;
  if (/^네\s*$|^넵\s*$|^ㅇㅋ|^확인/.test(text.trim())) delta -= 1;
  // 중간
  if (/네고|깎|할인/.test(text)) delta += 10;
  if (/오늘\s*꼭|지금\s*꼭|왜\s*답장|답장\s*해|빨리\s*답/.test(text)) delta += 15;
  if (/예약|빼\s*(주|놔)/.test(text)) delta += 15;
  // 높음
  if (/환불|반품/.test(text)) delta += 30;
  if (/신고|사기|고소/.test(text)) delta += 35;
  if (/정품|가품|하자|고장/.test(text)) delta += 20;
  if (/계좌|송장|먼저\s*보내/.test(text)) delta += 30;
  if (/카톡|링크|외부\s*결제/.test(text)) delta += 40;
  // clamp per-message so a single message doesn't destroy score range
  return Math.max(-10, Math.min(50, delta));
}

function updateRiskScore(current, text) {
  const next = (current || 0) + computeRiskDelta(text);
  return Math.max(0, Math.min(100, next));
}

// ============================================================
// 시스템 프롬프트 빌더 (이모티콘 금지, 빌런 10종 대응 내장)
// ============================================================
function buildSystemPrompt(product) {
  // 거래 방법: 둘 중 하나만 (답변 못하는 케이스 방지)
  const method = product.tradeMethod || 'local';
  const methodNote = method === 'shipping' ? (product.shippingNote || '').trim() : (product.localNote || '').trim();
  // 안내 텍스트가 비어 있으면 placeholder 노출 X — 그냥 거래 방식만 짧게
  const methodLine = method === 'shipping'
    ? (methodNote ? `택배 거래만 가능. 안내: ${methodNote}` : `택배 거래만 가능 (구체 안내는 사람 응대로 처리).`)
    : (methodNote ? `직거래만 가능. 안내: ${methodNote}` : `직거래만 가능 (구체 장소·시간은 사람 응대로 처리).`);
  const methodLabel = method === 'shipping' ? '택배' : '직거래';
  const oppositeLabel = method === 'shipping' ? '직거래' : '택배';
  // 안내가 비어 있으면 시간·장소 협의는 HANDOFF로 가야 함
  const noteEmptyHint = methodNote ? '' : '\n  - 안내가 비어 있어 구체 시간·장소 질문은 [HANDOFF:거래 안내 미상]으로 처리.';

  const asking = (product.askingPrice || 0).toLocaleString();
  const min = (product.minPrice || 0).toLocaleString();

  const negoDesc = product.negoPolicy === 'none'
    ? `네고 불가. 가격 문의시 ${asking}원 그대로 안내.`
    : product.negoPolicy === 'small'
    ? `최저 ${min}원까지만 가능. 그 이하는 "${min}원까지가 최선이에요" 정도로 정중히 거절.`
    : `협의 가능하지만 절대 ${min}원 미만 불가.`;

  const toneDesc = product.tone === 'friendly'
    ? '친근한 "~요" 체. 딱딱하지 않게. 이모티콘(^^ 등)은 한 번에 한두 번 사용 가능.'
    : product.tone === 'polite'
    ? '정중한 "~습니다/~입니다" 체. 이모티콘 절대 금지.'
    : '간결하고 쿨하게. 인사 생략, 핵심만. 이모티콘 절대 금지.';

  return `너는 당근마켓 판매자야. 당근은 이웃 간 중고거래 플랫폼이고, 너의 역할은 **구매자 문의에 짧게 사실만 답변**하는 것이야.

★★★ 절대 규칙 ★★★
1. **이모지(😊 등) 절대 금지**. ${product.tone === 'friendly' ? '단, 친근 톤이라 ^^ / ㅎ / ~ 정도 텍스트 이모티콘은 한 답변에 1개까지 허용.' : '텍스트 이모티콘(^^, ㅎㅎ, ~~)도 모두 금지.'}
2. 1~2문장 이내로 짧게.
3. ${min}원 미만 가격 절대 언급 금지.
4. 주소·연락처·계좌번호·송장·결제 관련 정보 묻지도 답하지도 말 것 (당근페이가 알아서 처리).
5. **거래 방법은 ${methodLabel}만**. 절대 ${oppositeLabel} 가능하다고 답하지 말 것. ${oppositeLabel} 문의가 오면:
   - "${methodLabel}만 가능해요" 짧게 답.
   - 절대 "둘 다 가능", "${oppositeLabel}도 됩니다" 같은 표현 금지.
6. **거래 안내(시간·장소) 표현 규칙**:
   - "(안내 미설정)", "거래 방법이 설정되지 않음" 같은 시스템 표현을 답변에 절대 그대로 쓰지 말 것.
   - 안내가 비어 있으면 "${methodLabel}만 가능해요. 구체 시간(또는 장소)은 잠시만요." 정도로 답하고 [HANDOFF:거래 안내 미상].

★★★ 사람답게 답하기 — 봇 티 안 나게 ★★★
A. **상대 톤 매칭** (필수):
   - 구매자가 "~습니다/~입니다" 격식체 → 너도 "~습니다/~입니다"로 답변.
   - 구매자가 "~요/~네요" 반존대 → 너도 "~요" 체로 답변.
   - 첫 메시지에서 상대 톤 파악 후 일관 유지.
B. **종결어 다양화**: 매 답변마다 "~요" 만 쓰지 말 것. "~네요", "~죠", "~예요", "~인데요", "~겠죠?", "~잖아요", "~던데요" 등 자연스럽게 섞기.
C. **격식체 단답 30~40% 허용** (사람은 항상 완결문 안 씀):
   - 동의/확인엔 "넵", "네", "넵 가능해요", "맞아요" 등 짧은 답.
   - 절대 "ㅇㅋ", "ㅇㅇ", "ㅋ" 같은 채팅체·축약 사용 금지. (친근 톤이라도)
   - 공손함은 유지하면서 짧게.
D. **상품 호칭 변동**: 매번 "${product.productName || product.articleTitle || '이 상품'}" 풀네임 쓰지 말 것.
   - 처음엔 풀네임. 두 번째부턴 "이거", "이 폰", "그 제품", "이 상품" 같이 짧게.
E. **인사 회피**: 이미 인사 교환했으면 다시 "안녕하세요" 안 함. (이전 대화 이력 참고)
F. **자연스러운 한 박자**: 너무 즉답하지 말고 가끔 "음", "아 네" 같은 작은 호흡어 사용 가능 (단 친근 톤만).

[네가 해야 할 일]
- 상품 상태·구성·가격·거래 방법 같은 **사실 질문에만** 간단히 답하기.
- 1차 네고 요청에 정중히 응답 (마지노선 지킴).
- 감사 인사·일상 대화는 "네~" 정도로 짧게.

[★ 다른 상품을 묻는 경우 — HANDOFF 절대 쓰지 말고 직접 짧게 안내 ★]
구매자가 우리가 파는 게 아닌 **다른 상품**을 묻는 경우 (예: "나이키 에어맥스 파세요?", "노트북도 있나요?", "다른 색은 없나요?" — 단, 우리 상품의 색깔 옵션은 제외):
→ 다음 중 하나로 간단히 답변하고 끝.
   "여기는 ${product.productName || product.articleTitle || '이 상품'} 거래용 채팅이에요."
   "여긴 ${product.productName || product.articleTitle || '이 상품'} 파는 곳이에요. 다른 건 다른 게시글 확인 부탁드려요."
→ 절대 [HANDOFF] 태그 쓰지 말 것. 추가 설명도 하지 말 것.

[★★★ HANDOFF 태그 출력 규칙 (가장 중요) ★★★]
HANDOFF가 필요하면 **반드시 답변의 맨 첫 글자부터** 정확히 "[HANDOFF:이유]" 형식으로만 출력.
- 절대 앞에 다른 텍스트(인사·설명·서론) 붙이지 말 것.
- 절대 줄바꿈·공백 없이 한 줄.
- 닫는 ] 까지 반드시 포함. 잘리면 안 됨.
- 이유는 짧게(20자 이내). 예: "[HANDOFF:실물 사진 요청]", "[HANDOFF:판매자 신원 질문]".
- 위 규칙 어기면 봇이 사용자에게 잘못된 답을 보냄. 반드시 지킬 것.

[★★★ 사람 확인 필요 — 아래 중 하나라도 해당하면 답변 쓰지 말고 위 규칙대로 "[HANDOFF:이유]" 형식만 출력 ★★★]
- 실물/추가 사진 요청
- **판매자 개인정보·신원 질문** (이름·나이·직업·거주지·국적·성별·결혼·학생 여부 — 예: "외국인이세요?", "어디 사세요?", "결혼하셨어요?")
- **명시적 구매 확정 의사** (정확히 다음 문구만 해당): "구매할게요", "구매하겠습니다", "결제할게요", "예약해 주세요", "이걸로 할게요", "사겠습니다"
- **우리 상품의 모르는 세부 스펙·히스토리** (위 [상품] 섹션에 없는 정보 — 정확한 배터리 사이클, 전 주인 정보, 잔기스 위치, 박스 안쪽 상태, 버튼 작동 여부, 정확한 무게/크기 등)
- 분쟁·환불·AS·교환·하자·정품 의혹
- URL/링크 포함 메시지

[★ 거래 시간 협의 — HANDOFF 아님, [거래 방법]의 안내 기반 답변 ★]
구매자가 만나는 시간을 묻는 경우 (예: "내일 2시 될까요?", "오늘 5시 가능?", "주말 가능?", "퇴근하고 9시?"):
- 절대 [HANDOFF:구매 확정] 처리하지 말 것 (시간 협의는 구매 확정과 다름)
- 위 [거래 방법] 안내에 **시간·장소 정보가 명시된 경우**에만 그 기반으로 답변
  - 예: 안내가 "역삼역 1번 출구 · 평일 저녁 7시 이후"인 상황
    Q: "내일 2시 될까요?" → "평일 저녁 7시 이후만 가능해요"
    Q: "오늘 8시?" → "네 8시 가능해요"
    Q: "주말도?" → "평일만 가능해요"
- 안내가 비어 있거나 해당 정보가 없으면 → 절대 추측 X → "[HANDOFF:거래 시간 협의]"
- 위치 협상 ("강남역도?", "다른 곳 가능?") → "[HANDOFF:거래 위치 협의]"
- 단, 위치/시간 정보 다 맞고 단순 확인이면 짧게 "네 가능해요" / "그 시간 괜찮아요"
- **절대 금지**: "거래 방법이 설정되지 않음", "안내 미설정" 같이 시스템 내부 표현을 답변에 그대로 쓰지 말 것.

[★ 모르는 디테일 — 절대 환각 답변 금지, 무조건 [HANDOFF] ★]
구매자가 [상품] 섹션에 명시되지 않은 세부 정보를 물으면:
- 절대 추측·환각해서 답하지 말 것 ("아마 ~", "보통 ~", "대충 ~" 표현 모두 금지)
- 무조건 [HANDOFF:구체적 사유] 포맷
- 예시:
  Q: "잔기스가 정확히 어디에 있어요?" → "[HANDOFF:잔기스 위치 정보 없음]"
  Q: "박스 안쪽도 멀쩡해요?" → "[HANDOFF:박스 상태 미확인]"
  Q: "버튼은 잘 눌려요?" → "[HANDOFF:버튼 작동 여부 확인 필요]"
  Q: "정확한 무게가 어떻게 되나요?" → "[HANDOFF:무게 정보 없음]"
  Q: "AS 받으신 적 있어요?" → "[HANDOFF:AS 이력 미상]"
  Q: "보증 기간 남았어요?" → "[HANDOFF:보증 기간 미상]"
  Q: "원래 얼마에 사셨어요?" → "[HANDOFF:판매자 구매가 미상]"
  Q: "어디서 사셨어요?" → "[HANDOFF:판매자 구매처 미상]"

[★ 함정·맥락 오해 방지 — 절대 하지 말 것 ★]
- 거래 무관 영역(신원·정치·종교·AI 정체성)은 추측 X. → [HANDOFF] 또는 "네?"
- 예: "혹시 외국인이세요?" → 절대 변명 X → [HANDOFF:판매자 신원 질문]
- 예: "혹시 낚시예요?" → [HANDOFF:구매 의사 떠보기]
- 예: "이거 진짜 파시는 거 맞아요?" → "네 판매 중이에요" 정도만 짧게. 추가 변명 X.

[★★★ 모호한 질문 — HANDOFF 전에 먼저 "명확화 질문"으로 다음 응답 유도 ★★★]
질문이 모호하거나 단순 정보 요청에 가까운 경우, **HANDOFF 대신 짧은 명확화 질문**을 던져서 구매자의 의도를 명확하게 만들 것. 환각 답변 절대 X.

대표 예시:
- Q: "정품 맞나요?" / "정품인가요?" / "진품인가요?" → A: "사진 보내드릴까요?"
  (구매자가 "네"라고 하면 다음 메시지에서 [HANDOFF:실물 사진 요청]로 사람 응대)
- Q: "이거 어때요?" / "괜찮아요?" → A: "어떤 부분이 궁금하세요?"
- Q: "그게 그건가요?" / "이게 맞아요?" → A: "어떤 부분 말씀이세요?"
- Q: 말이 끊기거나 한 단어 ("혹시...", "음...", "그게...") → A: "네? 어떤 점 궁금하세요?"
- Q: "사이즈 맞을까요?" / "잘 어울릴까요?" / "이거로 될까요?" → A: "어떤 용도로 쓰실 거예요?"
  (사용 맥락 끌어내서 답변 가능 여부 결정)

규칙:
- 명확화 질문은 **한 답변에 한 번만** 사용. 같은 질문 반복 X.
- 이전 답변이 이미 명확화 질문이었는데 구매자 답변이 **또 모호**하면 → [HANDOFF:대화 모호]
  (이전 대화 맥락을 보고 판단 — 같은 패턴 두 번 안 나오게)
- 명확화 질문은 항상 짧게 (8자 이내 권장).

[★ 부정형·의심 표현 — 명백한 의심·위협만 즉시 HANDOFF ★]
다음은 명확화 없이 즉시 [HANDOFF]:
- "사기 아니죠?" / "사기치는 거 아니죠?" / "이거 사기예요?" → [HANDOFF:사기 의혹]
- "가품 아니죠?" / "가짜 아니죠?" → [HANDOFF:정품 의혹]
- "혹시 하자 있는 거 아니죠?" / "고장 났어요?" → [HANDOFF:하자 의혹]
- "신고할 거예요" / "고소할게요" / "경찰에 신고" → [HANDOFF:신고·법적 위협]
- "환불해 주세요" / "반품 받아주세요" → [HANDOFF:환불 요청]
- "왜 이렇게 싸죠?" → [HANDOFF:가격 의심 — 사유 설명 필요]
- "왜 답장 안 해요?" / "빨리 답해주세요" → 압박. 짧게 "최대한 빨리 답변드릴게요" 정도. 페이스 유지.

[★ 감정 호소·압박 처리 ★]
- "ㅠㅠ 돈이 없어서 깎아주세요" / "꼭 사고 싶어요 양보 좀" / "사정이 있어서요" → 짧게 "마지노선이라 더는 어려워요" 정도. 절대 더 깎지 말 것.
- "왜 답장 안 해요" / "오늘 안에 빨리" → 압박. "최대한 빨리 답변드릴게요" 정도. 페이스 유지.
- "다른 분이 더 비싸게 사겠대요" / "다른 곳에서 더 싸게 봤어요" → "[HANDOFF:비교 협상]"

[★ 예약·찜·미래 거래 ★]
- "팔리면 알려주세요" / "다음에 또 올려주세요" → "[HANDOFF:예약/재판매 요청]"
- "잠시만 빼주세요" → "[HANDOFF:예약 요청]" (예약은 입금 전엔 받지 않는 게 원칙)
- **2차 네고** (이미 네고 한 번 합의 후 또 깎으려는 시도 — "택배비 포함", "묶음 할인", "현장에서 더 깎") → [HANDOFF:2차 네고]
- **감정적 표현** (화남·짜증·욕설·컴플레인·"사기" 언급) → [HANDOFF:감정 격화]
- **대화 막힘** ("무슨 말이에요?", "다시 설명해주세요", "제 말은 그게 아니라") → [HANDOFF:AI 대화 막힘]
- **사기 의심 패턴** (계좌 먼저, 외부링크, 카톡, 주소 먼저) → [HANDOFF:사기 의심]
- **빌런 10종** (아래 참고) → [HANDOFF:빌런 유형]

[빌런 10종 대응 문구 — 아래 상황이면 **HANDOFF가 아니라 해당 문구만** 짧게 응답]
① 예약 잠수 ("내일까지 빼주세요" "월급 들어오면 살게요" "밤에 갈게요"):
   → "먼저 오시는 분께 판매됩니다. 예약은 입금 또는 확정 일정이 있을 때만 가능해요."
③ 무료나눔 갑질 (무료나눔인데 택배·배달·과도한 사진 요구):
   → "무료 나눔이라 직접 오시는 분께만 드려요."
④ 과도한 정품 검증 (5회째 정품 확인 반복):
   → "사진과 설명 기준으로 판매합니다. 추가 확인은 구매 전 충분히 검토 부탁드려요."
⑤ 변심 반품 ("집에 와서 보니 작네요" "생각보다 달라요"):
   → "직거래 시 확인 후 구매하신 상품이라 단순 변심 반품은 어려워요. 고지하지 않은 하자가 있다면 확인해 볼게요."
⑥ 선발송 요구 ("먼저 보내주세요" "회사라 지금 이체 안 돼요"):
   → "입금 확인 후 발송 가능해요."
⑦ 외부 유도 ("카톡으로 얘기해요" "링크에서 결제"):
   → "거래 관련 대화는 당근 채팅에서만 진행할게요."
⑧ 취소 빌런 ("애가 잘못 눌렀어요" "남편이 반대해서"):
   → "알겠습니다. 다음부터는 확정 후 연락 부탁드려요."
⑨ 시간 파괴 ("30분만요" "길을 못 찾겠어요"):
   → "약속 시간 기준 10분 이상 지연 시 거래 취소될 수 있어요."
⑩ 감정 교환 ("이거 왜 파세요?" "사연 있나요?"):
   → "상품 관련 문의만 답변드려요. 구매 원하시면 거래 가능 시간 알려주세요."

유형 ② (현장 재네고), ⑤ (변심 반품), ⑦ (외부 유도), ⑥ (선발송)은 **위 문구 + 뒤이어 반드시 [HANDOFF]** 로도 사람 확인 유도.

[상품]
- ${product.productName || product.articleTitle}
- 판매가: ${asking}원
- 상태: ${product.condition || '명시 없음'}
- 구성: ${product.includes || '명시 없음'}
- 기타: ${product.extraInfo || '없음'}

[거래 방법 — ${methodLabel}만 가능]
- ${methodLine}${noteEmptyHint}
- ${oppositeLabel}는 받지 않음. ${oppositeLabel} 문의 오면 "죄송하지만 ${methodLabel}만 가능해요" 정도로만.

[가격 정책]
${negoDesc}

[응대 스타일]
${toneDesc}

${product.customRules ? `[추가 규칙]\n${product.customRules}\n` : ''}
[철칙 재확인]
- 이모티콘·이모지 일절 금지.
- 1문장, 길어야 2문장. HANDOFF 태그는 태그만 단독으로.
- ${min}원 미만 절대 불가.`;
}

// ============================================================
// Gemini API (대화 이력 history 포함)
// ============================================================
async function callGemini({ apiKey, model, systemInstruction, history, userMessage }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  // history는 [{role:'user'|'model', text}] 형태. user/model 교대 + 첫 항목은 user.
  const safeHistory = [];
  for (const h of (history || [])) {
    if (!h.text) continue;
    if (h.role !== 'user' && h.role !== 'model') continue;
    if (safeHistory.length === 0 && h.role !== 'user') continue; // 첫 항목은 반드시 user
    const last = safeHistory[safeHistory.length - 1];
    if (last && last.role === h.role) {
      last.parts[0].text += '\n' + h.text;
    } else {
      safeHistory.push({ role: h.role, parts: [{ text: h.text }] });
    }
  }

  const contents = [
    ...safeHistory,
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: { maxOutputTokens: 600, temperature: 0.7 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
  const candidate = json.candidates?.[0];
  if (candidate?.finishReason === 'SAFETY' || candidate?.finishReason === 'BLOCKED') {
    return { safety: true };
  }
  const text = candidate?.content?.parts?.map((p) => p.text).join('').trim() || '';
  return { text };
}

// ============================================================
// 방별 대화 이력 (최근 N쌍 — 맥락 유지)
// ============================================================
const MAX_HISTORY_TURNS = 8; // user+model 합쳐서 최대 8개 (4쌍)

async function getRoomHistory(roomUrl) {
  const { room_history } = await chrome.storage.local.get('room_history');
  return room_history?.[roomUrl] || [];
}

async function appendToHistory(roomUrl, role, text) {
  if (!text) return;
  const { room_history } = await chrome.storage.local.get('room_history');
  const cur = { ...(room_history || {}) };
  const arr = [...(cur[roomUrl] || []), { role, text, at: Date.now() }];
  while (arr.length > MAX_HISTORY_TURNS) arr.shift();
  cur[roomUrl] = arr;
  await chrome.storage.local.set({ room_history: cur });
}

async function clearRoomHistory(roomUrl) {
  const { room_history } = await chrome.storage.local.get('room_history');
  if (!room_history) return;
  const cur = { ...room_history };
  delete cur[roomUrl];
  await chrome.storage.local.set({ room_history: cur });
}

// ============================================================
// roomSettings 조작 (chrome.storage.webapp_config.roomSettings)
// ============================================================
async function getWebappConfig() {
  const { webapp_config, webapp_apikey } = await chrome.storage.local.get(['webapp_config', 'webapp_apikey']);
  return {
    config: webapp_config || { products: [], customers: [], roomSettings: {} },
    apiKey: webapp_apikey || '',
  };
}

async function patchRoomSettings(roomUrl, patch) {
  const { webapp_config } = await chrome.storage.local.get('webapp_config');
  const cfg = webapp_config || { products: [], customers: [], roomSettings: {} };
  const current = cfg.roomSettings?.[roomUrl] || {
    enabled: true, manualProductId: null,
    manualActive: false, manualReason: null, manualSource: null, manualAt: null,
    riskScore: 0,
  };
  const next = {
    ...cfg,
    roomSettings: {
      ...(cfg.roomSettings || {}),
      [roomUrl]: { ...current, ...patch },
    },
  };
  await chrome.storage.local.set({ webapp_config: next });
}

async function enterManualMode(roomUrl, reason, source, tabId) {
  await patchRoomSettings(roomUrl, {
    manualActive: true,
    manualReason: reason,
    manualSource: source,
    manualAt: Date.now(),
  });
  // 사람이 답변하는 동안의 대화는 봇이 추측하면 안 되니 이력 초기화
  await clearRoomHistory(roomUrl);
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { type: 'SHOW_HANDOFF_BANNER', roomUrl, reason, source }).catch(() => {});
  }
}

async function exitManualMode(roomUrl, tabId) {
  await patchRoomSettings(roomUrl, {
    manualActive: false,
    manualReason: null,
    manualSource: null,
    manualAt: null,
    riskScore: 0,
    offTopicCount: 0,
    askedForTradeInfo: false, // 다음 사이클에 다시 수집 시도 가능
  });
  await clearRoomHistory(roomUrl);
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { type: 'HIDE_HANDOFF_BANNER', roomUrl }).catch(() => {});
  }
}

// 대화 종료 감지 시 — 거래정보 누락이면 마지막 한 번 묻고, 충분하면 manual 모드 진입
async function handlePauseRoom(msg, sender) {
  const tabId = sender?.tab?.id;
  const { roomUrl, reason } = msg;
  const reasonText = reason || '대화 종료 감지';

  const { config } = await getWebappConfig();
  const settings = getRoomSettings(config.roomSettings, roomUrl);

  // 이미 한 번 물어봤으면 그냥 manual로 직행
  if (settings.askedForTradeInfo) {
    await enterManualMode(roomUrl, reasonText, 'end-detect', tabId);
    return;
  }

  // 매칭된 상품 찾기
  const { daangn_rooms } = await chrome.storage.local.get('daangn_rooms');
  const articleTitle = (daangn_rooms || []).find((r) => r.roomUrl === roomUrl)?.articleTitle || '';
  const product = settings.manualProductId
    ? config.products.find((p) => p.id === settings.manualProductId)
    : matchProductByArticleTitle(config.products, articleTitle);

  if (!product || product.enabled === false) {
    // 상품 없거나 비활성 → 그냥 manual
    await enterManualMode(roomUrl, reasonText, 'end-detect', tabId);
    return;
  }

  // 누락 거래정보 확인
  const missing = checkMissingTradeInfo(settings.tradeInfo, product.tradeMethod);
  if (missing.length === 0) {
    // 모든 정보 수집됨 → manual로 직행
    await enterManualMode(roomUrl, reasonText, 'end-detect', tabId);
    return;
  }

  // 누락 있음 → 마지막 시도: 자연스러운 한국어 질문 주입
  const askMsg = generateTradeInfoAsk(missing, product.tradeMethod);
  if (!askMsg) {
    await enterManualMode(roomUrl, reasonText, 'end-detect', tabId);
    return;
  }
  await patchRoomSettings(roomUrl, { askedForTradeInfo: true });
  await logDecision({
    roomUrl, action: 'reply',
    reason: `대화 종료 감지 → 거래정보 수집 마지막 시도 (누락: ${missing.join(',')})`,
    product: product.label,
    reply: askMsg.slice(0, 60),
  });

  if (tabId) {
    const delayMs = 4000 + Math.random() * 3000; // 4~7초 (보통보다 빠르게 - 대화 끊기기 전)
    chrome.tabs.sendMessage(tabId, {
      type: 'INJECT_REPLY', roomUrl, text: askMsg, delayMs: Math.round(delayMs),
    }).catch(() => {});
  }
}

// ============================================================
// 결정 로그 (최대 20개 롤링)
// ============================================================
async function logDecision(entry) {
  try {
    const { decision_log } = await chrome.storage.local.get('decision_log');
    const next = [...(decision_log || []), { ...entry, at: Date.now() }];
    while (next.length > 20) next.shift();
    await chrome.storage.local.set({ decision_log: next });
  } catch (e) { console.warn(TAG, 'logDecision 실패:', e); }
}

// ============================================================
// 처리 락
// ============================================================
const processingLock = {};

// ============================================================
// 메시지 핸들러
// ============================================================
chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log(TAG, '확장 설치/업데이트:', reason);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'NEW_MESSAGE') {
        await handleNewMessage(msg, sender);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'RESUME_BOT') {
        await exitManualMode(msg.roomUrl, sender?.tab?.id);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'PAUSE_ROOM') {
        await handlePauseRoom(msg, sender);
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false, error: 'unknown type: ' + msg.type });
    } catch (err) {
      console.error(TAG, 'handler 오류:', err);
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true;
});

async function handleNewMessage(msg, sender) {
  const { roomUrl, articleTitle: msgArticleTitle, text, messageId } = msg;
  const tabId = sender?.tab?.id;
  const logBase = { roomUrl, messageId, textSnippet: (text || '').slice(0, 40) };

  if (processingLock[roomUrl]) {
    await logDecision({ ...logBase, action: 'skip', reason: '이미 처리 중' });
    return;
  }

  // 수면시간(01:00~05:59)엔 봇 응답 보류 — 새벽에 답하면 봇 티 남
  const hour = new Date().getHours();
  if (hour >= 1 && hour < 6) {
    await logDecision({ ...logBase, action: 'skip', reason: `수면시간(${hour}시) 자동 보류` });
    return;
  }

  const { config, apiKey } = await getWebappConfig();
  let settings = getRoomSettings(config.roomSettings, roomUrl);

  // 수동 모드 처리:
  //  - source === 'end-detect'면 새 메시지가 왔다는 건 대화 재개 신호 → 자동 재개
  //  - 그 외 사유는 그대로 수동 유지 (사람이 직접 처리)
  if (settings.manualActive) {
    if (settings.manualSource === 'end-detect') {
      console.log(TAG, '대화 종료 후 새 메시지 → 자동 재개:', roomUrl);
      await exitManualMode(roomUrl, tabId);
      // 갱신된 settings 다시 로드
      const refreshed = await getWebappConfig();
      settings = getRoomSettings(refreshed.config.roomSettings, roomUrl);
      await logDecision({ ...logBase, action: 'reply', reason: '대화 종료 후 자동 재개', product: '(처리 계속)' });
      // 아래 일반 흐름으로 계속 진행
    } else {
      await logDecision({ ...logBase, action: 'skip', reason: `수동 모드: ${settings.manualReason || '(사유 없음)'}` });
      return;
    }
  }

  // 사이드바 fallback
  let articleTitle = msgArticleTitle;
  if (!articleTitle) {
    const { daangn_rooms } = await chrome.storage.local.get('daangn_rooms');
    articleTitle = (daangn_rooms || []).find((r) => r.roomUrl === roomUrl)?.articleTitle || '';
  }

  if (!config.products || config.products.length === 0) {
    await logDecision({ ...logBase, action: 'skip', reason: '상품 미설정' });
    return;
  }
  if (!apiKey) {
    await logDecision({ ...logBase, action: 'skip', reason: 'Gemini API 키 미설정' });
    return;
  }
  if (!settings.enabled) {
    await logDecision({ ...logBase, action: 'skip', reason: '방 봇 OFF' });
    return;
  }

  const manualProduct = settings.manualProductId
    ? config.products.find((p) => p.id === settings.manualProductId)
    : null;
  const product = manualProduct || matchProductByArticleTitle(config.products, articleTitle);

  if (!product) {
    await logDecision({ ...logBase, action: 'skip', reason: `매칭 실패 (글 제목: "${(articleTitle || '').slice(0, 30)}")` });
    return;
  }
  if (product.enabled === false) {
    await logDecision({ ...logBase, action: 'skip', reason: `상품 "${product.label}" OFF`, product: product.label });
    return;
  }

  // ==== 1. 위험도 갱신 ====
  const newRisk = updateRiskScore(settings.riskScore, text);

  // ==== 2. 즉시 수동 전환 트리거 (우선순위대로) ====
  const villain = detectVillain(text);
  const scam = detectScamKeyword(text);
  const emotion = detectEmotion(text);
  const stuck = detectStuck(text);
  const nego2nd = detectNegoAgain(text);

  // scam/사기 의심은 즉시 수동
  if (scam) {
    await patchRoomSettings(roomUrl, { riskScore: newRisk });
    await enterManualMode(roomUrl, scam, 'keyword', tabId);
    await logDecision({ ...logBase, action: 'manual', reason: `🚨 사기 키워드: ${scam}`, product: product.label });
    return;
  }
  // 빌런 유형 ⑥⑦: 사기 성향 → 즉시 수동 (문구는 Gemini에 맡김)
  if (villain && (villain.id === 6 || villain.id === 7)) {
    await patchRoomSettings(roomUrl, { riskScore: newRisk });
    await enterManualMode(roomUrl, villain.label, 'villain', tabId);
    await logDecision({ ...logBase, action: 'manual', reason: `빌런 ${villain.label}`, product: product.label });
    return;
  }
  // 감정/컴플레인 → 즉시 수동
  if (emotion) {
    await patchRoomSettings(roomUrl, { riskScore: newRisk });
    await enterManualMode(roomUrl, emotion, 'emotion', tabId);
    await logDecision({ ...logBase, action: 'manual', reason: `감정: ${emotion}`, product: product.label });
    return;
  }
  // 대화 막힘 → 즉시 수동
  if (stuck) {
    await patchRoomSettings(roomUrl, { riskScore: newRisk });
    await enterManualMode(roomUrl, stuck, 'stuck', tabId);
    await logDecision({ ...logBase, action: 'manual', reason: `대화 막힘: ${stuck}`, product: product.label });
    return;
  }
  // 2차 네고 → 즉시 수동
  if (nego2nd) {
    await patchRoomSettings(roomUrl, { riskScore: newRisk });
    await enterManualMode(roomUrl, nego2nd, 'nego2', tabId);
    await logDecision({ ...logBase, action: 'manual', reason: `2차 네고: ${nego2nd}`, product: product.label });
    return;
  }
  // 위험도 임계값 초과 → 수동
  if (newRisk >= RISK_THRESHOLD_AUTO_MANUAL) {
    await patchRoomSettings(roomUrl, { riskScore: newRisk });
    await enterManualMode(roomUrl, `위험도 ${newRisk} 초과 (임계 ${RISK_THRESHOLD_AUTO_MANUAL})`, 'risk', tabId);
    await logDecision({ ...logBase, action: 'manual', reason: `위험도 누적 ${newRisk}`, product: product.label });
    return;
  }

  // ==== 2.5. 거래 무관 대화 (오프토픽) — 1차 "네?" / 2차 수동 ====
  const offtopic = detectOffTopic(text);
  if (offtopic) {
    const newCount = (settings.offTopicCount || 0) + 1;
    if (newCount >= 2) {
      await patchRoomSettings(roomUrl, { riskScore: newRisk, offTopicCount: 0 });
      await enterManualMode(roomUrl, `대화 이탈 2회 (${offtopic})`, 'offtopic', tabId);
      await logDecision({ ...logBase, action: 'manual', reason: `오프토픽 2회: ${offtopic}`, product: product.label });
      return;
    }
    // 1차: "네?" 식 짧은 응답 (Gemini 호출 없이 직접)
    await patchRoomSettings(roomUrl, { riskScore: newRisk, offTopicCount: newCount });
    const shortReply = '네?';
    const delayMs = 2000 + Math.random() * 2500;
    if (tabId) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'INJECT_REPLY', roomUrl, text: shortReply, delayMs: Math.round(delayMs),
        });
        await logDecision({ ...logBase, action: 'reply', reason: `오프토픽 1차 (${offtopic})`, product: product.label, reply: shortReply });
      } catch (e) {
        await logDecision({ ...logBase, action: 'error', reason: `주입 실패: ${e.message}`, product: product.label });
      }
    }
    return;
  }

  // ==== 3. 위험도 저장 + 오프토픽 카운터 리셋 후 Gemini 호출 ====
  await patchRoomSettings(roomUrl, { riskScore: newRisk, offTopicCount: 0 });

  // 대화 이력 로드 (맥락 유지)
  const history = await getRoomHistory(roomUrl);

  processingLock[roomUrl] = true;
  try {
    const result = await callGemini({
      apiKey, model: MODEL_CHAT,
      systemInstruction: buildSystemPrompt(product),
      history,
      userMessage: text,
    });

    if (result.safety) {
      await enterManualMode(roomUrl, 'Gemini 안전 필터', 'safety', tabId);
      await logDecision({ ...logBase, action: 'manual', reason: 'Gemini 안전 필터', product: product.label });
      return;
    }

    // truncated 태그도 잡는 강화된 핸드오프 감지
    const handoffReason = detectHandoffIntent(result.text);
    if (handoffReason) {
      await enterManualMode(roomUrl, handoffReason, 'llm', tabId);
      await logDecision({ ...logBase, action: 'manual', reason: `AI: ${handoffReason}`, product: product.label });
      return;
    }

    // 이모티콘·이모지·텍스트 이모티콘 강력 제거
    const reply = cleanReply(result.text, product.tone) || '네';
    // 사람다운 타이핑 지연: 20~40초 랜덤
    const delayMs = 20000 + Math.random() * 20000;

    if (tabId) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'INJECT_REPLY', roomUrl, text: reply, delayMs: Math.round(delayMs),
        });
        // 대화 맥락 보존: user 메시지 + 봇 답변 양쪽 모두 history에 추가
        await appendToHistory(roomUrl, 'user', text);
        await appendToHistory(roomUrl, 'model', reply);
        await logDecision({ ...logBase, action: 'reply', reason: `예약 ${Math.round(delayMs/1000)}초`, product: product.label, reply: reply.slice(0, 60) });
      } catch (e) {
        await logDecision({ ...logBase, action: 'error', reason: `주입 실패: ${e.message}`, product: product.label });
      }
    }
  } catch (err) {
    console.error(TAG, 'Gemini 오류:', err);
    await logDecision({ ...logBase, action: 'error', reason: `Gemini 오류: ${err.message}`, product: product.label });
  } finally {
    processingLock[roomUrl] = false;
  }
}
