/**
 * Gmail → OpenRouter HR-классификатор v2
 * • добавляет НОВЫЕ ярлыки: interview_v2 / rejected_v2 / received_v2 / to_check_v2
 * • старые метки НЕ трогает
 * • проходит по всей папке “Входящие”
 * • кэширует результаты, пишет лог в Google Sheets
 * Автор: ChatGPT (o3), 2025-07-03
 */

/* ── НАСТРОЙКИ ─────────────────────────────────────────────────────────── */
const API_KEY  = 'OPEN-ROUTER-KEY';   // ← вставь свой ключ
const MODEL_ID = 'deepseek/deepseek-chat-v3-0324:free';
const CACHE_TTL_SEC = 24 * 3600;                         // сутки кэша

/* ── ЯРЛЫКИ v2 ─────────────────────────────────────────────────────────── */
const LABELS = (() => ({
  interview_v2 : getOrCreateLabel_('interview_v2'),
  rejected_v2  : getOrCreateLabel_('rejected_v2'),
  received_v2  : getOrCreateLabel_('received_v2'),
  to_check_v2  : getOrCreateLabel_('to_check_v2')
}))();

/* ── ОСНОВНАЯ ФУНКЦИЯ ──────────────────────────────────────────────────── */
function classifyHRMails() {
  const threads = GmailApp.search('label:inbox');      // ВСЯ входящая
  const cache   = CacheService.getUserCache();
  const sheet   = getLogSheet_();

  threads.forEach(thread => {
    try {
      if (!thread || typeof thread.addLabel !== 'function') return;
      const id = thread.getId();
      if (cache.get(id)) return;                       // уже размечено этой версией

      const msg   = thread.getMessages().pop();
      const body  = (msg.getPlainBody() || msg.getBody()).trim().slice(0, 4000);
      const cat   = classifyWithLLM_(body);            // 'Interview', 'Rejected', ...

      /* ── ставим НОВУЮ метку v2 ── */
      const map = {
        interview:  LABELS.interview_v2,
        rejected:   LABELS.rejected_v2,
        received:   LABELS.received_v2,
        other:      LABELS.to_check_v2
      };
      const label = map[cat.toLowerCase()] || LABELS.to_check_v2;
      thread.addLabel(label);

      /* ── лог + кэш ── */
      cache.put(id, cat, CACHE_TTL_SEC);
      sheet.appendRow([new Date(), id, thread.getFirstMessageSubject(), cat]);
      Logger.log(`📧 ${thread.getFirstMessageSubject()} → ${cat}`);

    } catch (e) {
      Logger.log(`❌ Ошибка: ${e}`);
    }
  });
}

/* ── LLM ──────────────────────────────────────────────────────────────── */
function classifyWithLLM_(text) {
  const prompt = `
You're an expert email classifier for job applications.
Classify the email into one word: Interview, Rejected, Received or Other.

Email:
"""${text}"""
`.trim();

  const resp = UrlFetchApp.fetch(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        model: MODEL_ID,
        messages: [{ role: 'user', content: prompt }]
      }),
      headers: {
        Authorization : `Bearer ${API_KEY}`,
        'HTTP-Referer': 'https://script.google.com',
        'X-Title'    : 'Gmail-HR-Classifier-v2'
      },
      muteHttpExceptions: false
    }
  );

  const json = JSON.parse(resp.getContentText());
  const answer = (json.choices && json.choices[0].message.content || 'Other').trim();
  Logger.log('🧠 Ответ LLM: ' + answer);
  return answer;
}

/* ── ЛОГ В SHEETS ─────────────────────────────────────────────────────── */
function getLogSheet_() {
  const prop = PropertiesService.getScriptProperties();
  const id = prop.getProperty('LOG_SHEET_ID_V2');
  let ss;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.create('HR Mail Classifier Log v2');
    ss.appendRow(['Timestamp','ThreadID','Subject','Category_v2']);
    prop.setProperty('LOG_SHEET_ID_V2', ss.getId());
  }
  return ss.getActiveSheet();
}
