/**
 * Gmail → OpenRouter HR-классификатор v4 (rate-limit safe)
 * • Ярлыки: interview_v4 / rejected_v4 / received_v4 / to_check_v4 / hr_sorted_v4
 * • Малый батч + дозирование LLM-запросов + уважение Retry-After/x-ratelimit-reset
 * Автор: Толик + ChatGPT, 2025-10-10 21:23
 */

/* ── НАСТРОЙКИ ─────────────────────────────────────────────────────────── */
const API_KEY  = 'OPEN-ROUTER-KEY';   // ← вставь свой ключ
const MODEL_ID = 'deepseek/deepseek-r1-0528:free';

const BATCH_SIZE          = 10;                     // Максимум тредов за один запуск (уменьшили!)
const TEXT_SLICE          = 4000;
const MAX_RUNTIME_MS      = 5 * 60 * 1000;
const BACKOFF_RETRIES     = 2;                     // теперь меньше бьем в стену
const BACKOFF_BASE_MS     = 800;                   // базовая задержка при 5xx/429
const MIN_INTERVAL_MS     = 5000;                  // НЕ чаще 1 запроса / 9 сек (регулятор нагрузки)
const MAX_429_STREAK      = 3;                     // при 3 подряд 429 — мягко завершаем запуск
const LABEL_PROCESSED_NAME = 'hr_sorted_v4';

/* ── ТОЧКА ВХОДА ───────────────────────────────────────────────────────── */
function classifyHRMails() {
  const startTs = Date.now();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) { Logger.log('⚠️ lock busy'); return; }

  try {
    const labels = getLabels_();
    const sheet  = getLogSheet_();

    const query = 'label:inbox -label:' + LABEL_PROCESSED_NAME + ' -label:spam -label:trash';
    const threads = GmailApp.search(query, 0, BATCH_SIZE);
    if (!threads || threads.length === 0) { Logger.log('✅ Новых потоков нет'); return; }

    const rows = [];
    let lastCallAt = getLastCallAt_();      // timestamp последнего удачного/неудачного запроса к LLM
    let streak429  = 0;

    for (let i = 0; i < threads.length; i++) {
      if (Date.now() - startTs > (MAX_RUNTIME_MS - 15000)) { Logger.log('⏱️ Выходим до таймаута'); break; }

      const thread = threads[i];
      try {
        // Пейсинг: выдерживаем MIN_INTERVAL_MS между LLM-вызовами
        lastCallAt = ensurePacing_(lastCallAt, MIN_INTERVAL_MS);

        const id      = thread.getId();
        const subject = (thread.getFirstMessageSubject() || '').toString();
        const msgs    = thread.getMessages();
        const last    = msgs[msgs.length - 1];
        const body    = (last.getPlainBody() || last.getBody() || '').toString().trim().slice(0, TEXT_SLICE);

        const result = classifyWithLLM_(subject, body); // {cat, meta:{status, headers}}
        setLastCallAt_(Date.now());                     // фиксируем момент вызова

        if (result.meta && result.meta.status === 429) {
          streak429++;
          Logger.log('🚦 429 streak = ' + streak429);
          // уважаем Retry-After/x-ratelimit-reset
          const waitMs = computeRetryWaitMs_(result.meta.headers);
          if (waitMs > 0) { Logger.log('⏳ Ждём по Retry-After/x-ratelimit-reset: ' + waitMs + 'ms'); Utilities.sleep(waitMs); }
          if (streak429 >= MAX_429_STREAK) { Logger.log('🛑 Много 429 — завершаем запуск'); break; }
          // не ставим метки/лог — перейдем к следующему треду или завершимся
          continue;
        } else {
          streak429 = 0; // сбрасываем полосу
        }

        const cat = result.cat || 'Other';

        const map = {
          interview: labels.interview_v4,
          rejected : labels.rejected_v4,
          received : labels.received_v4,
          other    : labels.to_check_v4
        };
        const label = map[cat.toLowerCase()] || labels.to_check_v4;

        safeAddLabel_(thread, label);
        safeAddLabel_(thread, labels.processed);

        rows.push([new Date(), id, subject, cat]);
        Utilities.sleep(100); // бережём Gmail-квоты
      } catch (e) {
        const msg = String(e);
        Logger.log('❌ Ошибка на потоке: ' + msg);
        if (msg.includes('Service invoked too many times for one day: gmail')) {
          Logger.log('🛑 Gmail daily quota hit — выходим'); break;
        }
      }
    }

    if (rows.length > 0) { appendRowsBatch_(sheet, rows); Logger.log('📝 Записано: ' + rows.length); }
  } finally {
    lock.releaseLock();
  }
}

/* ── КЛАССИФИКАЦИЯ ────────────────────────────────────────────────────── */
function classifyWithLLM_(subject, text) {
  const prompt = (
`You're an expert email classifier for job applications.
Reply with exactly ONE of these words and nothing else:
Interview, Rejected, Received, Other.

Subject: "${subject}"
Email:
"""${text}"""`
  ).trim();

  const payload = {
    model: MODEL_ID,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: 3
  };

  const resp = fetchWithBackoffRespectingRate_(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      headers: {
        Authorization : 'Bearer ' + API_KEY,
        'HTTP-Referer': 'https://script.google.com',
        'X-Title'    : 'Gmail-HR-Classifier-v4'
      },
      muteHttpExceptions: true
    },
    BACKOFF_RETRIES
  );

  const code = resp.getResponseCode();
  const headers = resp.getAllHeaders ? resp.getAllHeaders() : {};
  const textResp = resp.getContentText() || '';

  if (code === 429) {
    Logger.log('⚠️ OpenRouter 429: ' + textResp.slice(0, 300));
    return { cat: 'Other', meta: { status: 429, headers: headers } };
  }

  if (code < 200 || code >= 300) {
    Logger.log('⚠️ OpenRouter non-2xx (' + code + '): ' + textResp.slice(0, 300));
    return { cat: 'Other', meta: { status: code, headers: headers } };
  }

  let json;
  try { json = JSON.parse(textResp); }
  catch (e) { Logger.log('⚠️ JSON parse fail: ' + String(e)); return { cat: 'Other', meta: { status: code, headers: headers } }; }

  const raw = (json.choices && json.choices[0].message.content || '').trim();
  Logger.log('🧠 Ответ LLM: ' + raw);
  const match = raw.match(/interview|rejected|received|other/i);
  const cat = match ? (match[0].charAt(0).toUpperCase() + match[0].slice(1).toLowerCase()) : 'Other';
  return { cat: cat, meta: { status: code, headers: headers } };
}

/* ── УВАЖАЕМ RATE LIMIT ───────────────────────────────────────────────── */
function fetchWithBackoffRespectingRate_(url, options, retries) {
  let attempt = 0;
  while (true) {
    try {
      const resp = UrlFetchApp.fetch(url, options);
      const code = resp.getResponseCode();
      if (code === 429 || (code >= 500 && code < 600)) {
        throw decorateTransient_(code, resp);
      }
      return resp;
    } catch (e) {
      attempt++;
      // если это 429 — не долбим десятки раз, а ждём дольше и быстро выходим при превышении попыток
      const isTransient = ('' + e).includes('Transient HTTP');
      const code = extractCodeFromError_(e);
      if (attempt > retries || !isTransient) {
        Logger.log('🛑 fetch failed after retries (' + code + '): ' + String(e));
        throw e;
      }
      const delay = Math.floor(BACKOFF_BASE_MS * Math.pow(2, attempt - 1) + Math.random() * 400);
      Logger.log('⏳ Backoff #' + attempt + ' (' + code + '), sleep ' + delay + 'ms');
      Utilities.sleep(delay);
    }
  }
}

function decorateTransient_(code, resp) {
  const err = new Error('Transient HTTP ' + code);
  err.headers = resp && resp.getAllHeaders ? resp.getAllHeaders() : {};
  return err;
}

function extractCodeFromError_(e) {
  const s = String(e);
  const m = s.match(/HTTP\s+(\d{3})/);
  return m ? Number(m[1]) : 0;
}

function computeRetryWaitMs_(headers) {
  try {
    if (!headers) return 0;
    // Retry-After (секунды) — RFC
    const ra = headers['Retry-After'] || headers['retry-after'];
    if (ra) {
      const sec = Number(ra);
      if (!isNaN(sec) && isFinite(sec) && sec >= 0) return sec * 1000;
    }
    // x-ratelimit-reset: unix-seconds или delta
    const reset = headers['x-ratelimit-reset'] || headers['X-RateLimit-Reset'];
    if (reset) {
      const nowMs = Date.now();
      const resetNum = Number(reset);
      if (!isNaN(resetNum) && resetNum > 0) {
        // если значение похоже на unixtime в секундах
        if (resetNum > 10000) {
          const targetMs = resetNum * 1000;
          const wait = Math.max(0, targetMs - nowMs);
          return wait;
        } else {
          // иначе это, вероятно, "через N секунд"
          return resetNum * 1000;
        }
      }
    }
  } catch (_e) {}
  // запасной вариант — чуть подождать
  return 5000;
}

/* ── ПРОСТОЙ ПЕЙСЕР ───────────────────────────────────────────────────── */
function ensurePacing_(lastCallAt, minIntervalMs) {
  const now = Date.now();
  const dt = now - (lastCallAt || 0);
  if (dt < minIntervalMs) {
    const wait = minIntervalMs - dt;
    Utilities.sleep(wait);
    return Date.now();
  }
  return now;
}
function getLastCallAt_() {
  const prop = PropertiesService.getScriptProperties();
  const v = Number(prop.getProperty('LLM_LAST_CALL_AT_MS') || '0');
  return isNaN(v) ? 0 : v;
}
function setLastCallAt_(ts) {
  PropertiesService.getScriptProperties().setProperty('LLM_LAST_CALL_AT_MS', String(ts));
}

/* ── ЛОГ В SHEETS (ПАКЕТНО) ──────────────────────────────────────────── */
function getLogSheet_() {
  const prop = PropertiesService.getScriptProperties();
  let id = prop.getProperty('LOG_SHEET_ID_V4');
  let ss;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.create('HR Mail Classifier Log v4');
    const sh = ss.getActiveSheet();
    sh.appendRow(['Timestamp','ThreadID','Subject','Category_v4']);
    prop.setProperty('LOG_SHEET_ID_V4', ss.getId());
  }
  return ss.getActiveSheet();
}
function appendRowsBatch_(sheet, rows) {
  if (!rows || rows.length === 0) return;
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows);
}

/* ── МЕТКИ ────────────────────────────────────────────────────────────── */
function getLabels_() {
  return {
    interview_v4: getOrCreateLabel_('interview_v4'),
    rejected_v4 : getOrCreateLabel_('rejected_v4'),
    received_v4 : getOrCreateLabel_('received_v4'),
    to_check_v4 : getOrCreateLabel_('to_check_v4'),
    processed   : getOrCreateLabel_(LABEL_PROCESSED_NAME)
  };
}
function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}
function safeAddLabel_(thread, label) {
  try { thread.addLabel(label); }
  catch (e) { Logger.log('⚠️ Не удалось поставить метку ' + label.getName() + ': ' + String(e)); }
}

/* ── ТРИГГЕР ──────────────────────────────────────────────────────────── */
function installHourlyTrigger_() {
  ScriptApp.newTrigger('classifyHRMails').timeBased().everyHours(1).create();
}
