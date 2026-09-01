const ALLOWED_DURATIONS = [5, 10, 20, 30];
const DB_NAME = 'goblin-moment-db';
const DB_VERSION = 2;
const SCHEMA_VERSION = 4;
const OMNI_MODEL = 'gemini-omni-1.1-flash';
const OPENAI_MODEL = 'gpt-5.6-luna';
const OPENAI_KEY_STORAGE = 'goblin-moment-openai-api-key';
const GEMINI_KEY_STORAGE = 'goblin-moment-gemini-api-key';
const MAX_MEDIA = 8;

const els = {};
let db;
let state = freshDraft();
let draftTimer = null;
let currentMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedDate = localDate(new Date());
let detailRecordId = null;
let detailDuration = 10;
let detailStoryMode = 'polished';
let editingRecordId = null;
let editOriginalRecord = null;
let generationBusy = false;
let pendingAction = null;
let activeVideoUrl = null;
let mediaObjectUrls = [];
let detailObjectUrls = [];
let swipeStart = null;

function $(id) { return document.getElementById(id); }
function normalizeDuration(value) { const n = Number(value); return ALLOWED_DURATIONS.includes(n) ? n : 10; }
function freshDraft() {
  return {
    key: 'active',
    schemaVersion: SCHEMA_VERSION,
    rawNote: '',
    polishedNote: '',
    mediaIds: [],
    videoId: null,
    videoDuration: 10,
    editingRecordId: null,
    updatedAt: new Date().toISOString(),
  };
}
function normalizeDraft(saved) {
  const base = freshDraft();
  if (!saved) return base;
  return {
    ...base,
    ...saved,
    schemaVersion: SCHEMA_VERSION,
    rawNote: saved.rawNote ?? saved.note ?? '',
    polishedNote: saved.polishedNote ?? '',
    mediaIds: Array.isArray(saved.mediaIds) ? saved.mediaIds : [],
    videoId: saved.videoId || null,
    videoDuration: normalizeDuration(saved.videoDuration),
    editingRecordId: saved.editingRecordId || saved.editingMomentId || null,
  };
}
function normalizeRecord(record) {
  if (!record) return null;
  return {
    ...record,
    schemaVersion: Math.max(Number(record.schemaVersion) || 0, SCHEMA_VERSION),
    rawNote: record.rawNote ?? record.note ?? '',
    polishedNote: record.polishedNote ?? record.note ?? '',
    mediaIds: Array.isArray(record.mediaIds) ? record.mediaIds : [],
    videoId: record.videoId || null,
    videoDuration: normalizeDuration(record.videoDuration),
  };
}
function localDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function formatTime(iso) { return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); }
function formatLongDate(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); return `${y}年${m}月${d}日`; }
function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function toast(message, ms = 2800) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => els.toast.classList.remove('show'), ms);
}
function recordHasContent(record) { return Boolean(record?.rawNote?.trim() || record?.note?.trim() || record?.mediaIds?.length); }

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains('moments')) {
        const store = database.createObjectStore('moments', { keyPath: 'id' });
        store.createIndex('localDate', 'localDate', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!database.objectStoreNames.contains('media')) database.createObjectStore('media', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('draft')) database.createObjectStore('draft', { keyPath: 'key' });
      if (!database.objectStoreNames.contains('videos')) database.createObjectStore('videos', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbReq(req) { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
function txDone(tx) { return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('transaction aborted')); }); }
async function getDraft() { return idbReq(db.transaction('draft', 'readonly').objectStore('draft').get('active')); }
async function putDraft() { state.updatedAt = new Date().toISOString(); return idbReq(db.transaction('draft', 'readwrite').objectStore('draft').put(structuredClone(state))); }
async function deleteDraftRecord() { return idbReq(db.transaction('draft', 'readwrite').objectStore('draft').delete('active')); }
async function saveMedia(blob) { const id = crypto.randomUUID(); await idbReq(db.transaction('media', 'readwrite').objectStore('media').put({ id, blob, createdAt: new Date().toISOString() })); return id; }
async function getMedia(id) { return idbReq(db.transaction('media', 'readonly').objectStore('media').get(id)); }
async function deleteMedia(id) { return idbReq(db.transaction('media', 'readwrite').objectStore('media').delete(id)); }
async function saveVideo(blob, meta = {}) { const id = crypto.randomUUID(); await idbReq(db.transaction('videos', 'readwrite').objectStore('videos').put({ id, blob, createdAt: new Date().toISOString(), ...meta })); return id; }
async function getVideo(id) { return id ? idbReq(db.transaction('videos', 'readonly').objectStore('videos').get(id)) : null; }
async function deleteVideo(id) { if (id) await idbReq(db.transaction('videos', 'readwrite').objectStore('videos').delete(id)); }
async function getAllRecords() { return (await idbReq(db.transaction('moments', 'readonly').objectStore('moments').getAll())).map(normalizeRecord); }
async function getRecord(id) { return normalizeRecord(await idbReq(db.transaction('moments', 'readonly').objectStore('moments').get(id))); }
async function putRecord(record) { return idbReq(db.transaction('moments', 'readwrite').objectStore('moments').put(record)); }
async function getRecordsByDate(date) { return (await idbReq(db.transaction('moments', 'readonly').objectStore('moments').index('localDate').getAll(date))).map(normalizeRecord); }

function queueDraft() {
  els.draftIndicator.textContent = editingRecordId ? '編集中・保存中…' : '下書きを保存中…';
  clearTimeout(draftTimer);
  draftTimer = setTimeout(async () => {
    try {
      await putDraft();
      els.draftIndicator.textContent = editingRecordId ? '記録を編集中' : '下書き保存済み';
    } catch (error) {
      console.error(error);
      els.draftIndicator.textContent = '保存できません';
      toast('下書きを保存できませんでした');
    }
  }, 180);
}

function revokeUrls(list) { for (const url of list) URL.revokeObjectURL(url); list.length = 0; }
async function renderMedia() {
  revokeUrls(mediaObjectUrls);
  els.mediaStrip.querySelectorAll('.media-thumb').forEach(node => node.remove());
  els.mediaEmpty.hidden = state.mediaIds.length > 0;
  for (const id of state.mediaIds) {
    const media = await getMedia(id);
    if (!media?.blob) continue;
    const url = URL.createObjectURL(media.blob);
    mediaObjectUrls.push(url);
    const wrap = document.createElement('div');
    wrap.className = 'media-thumb';
    let node;
    if (media.blob.type.startsWith('video/')) {
      node = document.createElement('video');
      node.src = url; node.muted = true; node.playsInline = true; node.preload = 'metadata';
      const mark = document.createElement('span'); mark.className = 'media-kind'; mark.textContent = '▶'; wrap.append(mark);
    } else {
      node = document.createElement('img'); node.src = url; node.alt = '選択した写真';
    }
    const remove = document.createElement('button');
    remove.className = 'media-remove'; remove.type = 'button'; remove.textContent = '×';
    remove.addEventListener('click', () => removeMediaFromState(id));
    wrap.prepend(node); wrap.append(remove); els.mediaStrip.append(wrap);
  }
}
async function addMedia(files) {
  if (!files?.length) return;
  const remaining = Math.max(0, MAX_MEDIA - state.mediaIds.length);
  els.draftIndicator.textContent = 'メディアを保存中…';
  try {
    for (const file of [...files].slice(0, remaining)) {
      if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) continue;
      state.mediaIds.push(await saveMedia(file));
    }
    await renderMedia(); queueDraft();
    if (files.length > remaining) toast(`写真・動画は合計${MAX_MEDIA}個までです`);
  } catch (error) {
    console.error(error); toast('写真・動画を保存できませんでした');
  } finally {
    els.mediaInput.value = '';
  }
}
async function removeMediaFromState(id) {
  const originalIds = editOriginalRecord?.mediaIds || [];
  const belongsToOriginal = Boolean(editingRecordId && originalIds.includes(id));
  state.mediaIds = state.mediaIds.filter(mediaId => mediaId !== id);
  if (!belongsToOriginal) await deleteMedia(id).catch(() => {});
  await renderMedia(); queueDraft();
}

function setComposerDuration(duration, save = true) {
  state.videoDuration = normalizeDuration(duration);
  els.durationLabel.textContent = `${state.videoDuration}秒`;
  els.durationOptions.querySelectorAll('[data-duration]').forEach(button => button.classList.toggle('selected', Number(button.dataset.duration) === state.videoDuration));
  if (save) queueDraft();
}
function setDetailDuration(duration) {
  detailDuration = normalizeDuration(duration);
  els.detailDurationLabel.textContent = `${detailDuration}秒`;
  els.detailDurationOptions.querySelectorAll('[data-duration]').forEach(button => button.classList.toggle('selected', Number(button.dataset.duration) === detailDuration));
}
function refreshEditUI() {
  els.save.textContent = editingRecordId ? '変更を保存' : '保存';
  els.resetDraft.textContent = editingRecordId ? '編集をやめる' : 'リセット';
  els.draftIndicator.textContent = editingRecordId ? '記録を編集中' : '下書き保存済み';
}
async function cleanDiscardedEditingAssets() {
  if (!editingRecordId || !editOriginalRecord) return;
  const originalMedia = new Set(editOriginalRecord.mediaIds || []);
  for (const id of state.mediaIds || []) if (!originalMedia.has(id)) await deleteMedia(id).catch(() => {});
  if (state.videoId && state.videoId !== editOriginalRecord.videoId) await deleteVideo(state.videoId).catch(() => {});
}
async function resetComposer(ask = true) {
  const hasSomething = recordHasContent(state) || Boolean(state.videoId) || Boolean(editingRecordId);
  if (ask && hasSomething && !confirm(editingRecordId ? '編集内容を破棄して編集をやめますか？' : '今の入力をすべてリセットしますか？')) return;
  clearTimeout(draftTimer);
  if (editingRecordId) await cleanDiscardedEditingAssets();
  else {
    for (const id of state.mediaIds || []) await deleteMedia(id).catch(() => {});
    if (state.videoId) await deleteVideo(state.videoId).catch(() => {});
  }
  editingRecordId = null; editOriginalRecord = null; state = freshDraft();
  await deleteDraftRecord().catch(() => {}); await putDraft();
  els.note.value = ''; els.noteCount.textContent = '0'; setComposerDuration(10, false);
  await renderMedia(); refreshEditUI();
  toast('リセットしました');
}

function getOpenAIKey() { return localStorage.getItem(OPENAI_KEY_STORAGE) || ''; }
function getGeminiKey() { return localStorage.getItem(GEMINI_KEY_STORAGE) || ''; }
function openSettings() {
  els.openaiKey.value = getOpenAIKey();
  els.geminiKey.value = getGeminiKey();
  els.settingsSheet.classList.add('open'); els.settingsSheet.setAttribute('aria-hidden', 'false');
}
function closeSettings() { els.settingsSheet.classList.remove('open'); els.settingsSheet.setAttribute('aria-hidden', 'true'); }

async function pasteIntoApiField(input, label) {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) { toast('クリップボードが空です'); return; }
    input.value = text.trim();
    input.focus();
    toast(`${label}を貼り付けました`);
  } catch (error) {
    console.error(error);
    input.focus();
    toast('自動貼り付けが使えません。入力欄を長押しして貼り付けてください');
  }
}
async function saveSettings() {
  const openAIKey = els.openaiKey.value.trim();
  const geminiKey = els.geminiKey.value.trim();
  if (openAIKey) localStorage.setItem(OPENAI_KEY_STORAGE, openAIKey); else localStorage.removeItem(OPENAI_KEY_STORAGE);
  if (geminiKey) localStorage.setItem(GEMINI_KEY_STORAGE, geminiKey); else localStorage.removeItem(GEMINI_KEY_STORAGE);
  closeSettings(); toast('API設定を保存しました');
  if (pendingAction) {
    const action = pendingAction; pendingAction = null;
    if (action.type === 'save') await saveRecord();
    if (action.type === 'generate') await startGeneration(action.job);
  }
}
function extractResponseText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  const texts = [];
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) if ((part?.type === 'output_text' || part?.type === 'text') && part?.text) texts.push(part.text);
  }
  return texts.join('\n').trim();
}
async function polishNote(rawNote, apiKey) {
  const text = rawNote.trim();
  if (!text) return '';
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      store: false,
      input: [
        {
          role: 'developer',
          content: [{
            type: 'input_text',
            text: 'あなたは個人の記録を整える編集者です。ユーザーの入力を、後から読み返して出来事の流れと当時の感情が思い出せる、自然で読みやすい一人称の日本語に整理してください。事実、人物関係、時系列、結果、本人が書いた感情を絶対に変えないでください。入力にない出来事・動機・感情・結論を追加しないでください。道徳的評価、助言、分析、見出し、箇条書きは不要です。重複、言い直し、音声入力由来の崩れだけを整理し、本人の温度感は残してください。本文だけを返してください。'
          }]
        },
        { role: 'user', content: [{ type: 'input_text', text }] }
      ]
    })
  });
  const raw = await response.text();
  let payload = {}; try { payload = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI API ${response.status}`);
  const result = extractResponseText(payload);
  if (!result) throw new Error('GPTから文章が返りませんでした');
  return result;
}

async function beginEditRecord(id) {
  const record = await getRecord(id); if (!record) return;
  if (!editingRecordId && recordHasContent(state)) {
    if (!confirm('現在の入力を破棄して、この記録を編集しますか？')) return;
    for (const mediaId of state.mediaIds || []) await deleteMedia(mediaId).catch(() => {});
    if (state.videoId) await deleteVideo(state.videoId).catch(() => {});
  }
  editingRecordId = id; editOriginalRecord = structuredClone(record);
  state = normalizeDraft({ ...record, key: 'active', editingRecordId: id });
  await putDraft();
  els.note.value = state.rawNote || ''; els.noteCount.textContent = String((state.rawNote || '').length);
  setComposerDuration(state.videoDuration, false); await renderMedia(); refreshEditUI(); closeDetail(); showComposer();
  toast('編集できます');
}

async function saveRecord() {
  if (els.save.disabled) return;
  if (!recordHasContent(state)) { toast('まず写真・動画か出来事を残してください'); return; }
  const rawNote = (state.rawNote || '').trim();
  if (rawNote && !getOpenAIKey()) {
    pendingAction = { type: 'save' }; openSettings(); toast('文章整理にOpenAI APIキーが必要です'); return;
  }
  els.save.disabled = true; els.save.textContent = '保存中…'; clearTimeout(draftTimer);
  try {
    let polishedNote = rawNote;
    if (rawNote) {
      els.draftIndicator.textContent = 'GPTが文章を整理中…';
      try { polishedNote = await polishNote(rawNote, getOpenAIKey()); }
      catch (error) { console.error(error); polishedNote = rawNote; toast('GPTの文章整理に失敗したため、元の文章で保存します', 4200); }
    }
    state.polishedNote = polishedNote;
    await putDraft();
    const now = new Date();
    let saved;
    if (editingRecordId) {
      const original = await getRecord(editingRecordId) || editOriginalRecord;
      if (!original) throw new Error('編集元の記録が見つかりません');
      saved = {
        ...original,
        schemaVersion: SCHEMA_VERSION,
        rawNote,
        polishedNote,
        note: polishedNote || rawNote,
        mediaIds: [...state.mediaIds],
        videoId: state.videoId || null,
        videoDuration: normalizeDuration(state.videoDuration),
        aiPolishedAt: rawNote ? now.toISOString() : null,
        editedAt: now.toISOString(),
      };
      const tx = db.transaction(['moments', 'draft'], 'readwrite');
      tx.objectStore('moments').put(saved); tx.objectStore('draft').delete('active'); await txDone(tx);
      const kept = new Set(saved.mediaIds);
      for (const oldId of original.mediaIds || []) if (!kept.has(oldId)) await deleteMedia(oldId).catch(() => {});
      if (original.videoId && original.videoId !== saved.videoId) await deleteVideo(original.videoId).catch(() => {});
      editingRecordId = null; editOriginalRecord = null; toast('変更を保存しました');
    } else {
      saved = {
        id: crypto.randomUUID(),
        schemaVersion: SCHEMA_VERSION,
        createdAt: now.toISOString(), occurredAt: now.toISOString(), localDate: localDate(now),
        rawNote, polishedNote, note: polishedNote || rawNote,
        mediaIds: [...state.mediaIds], videoId: state.videoId || null,
        videoDuration: normalizeDuration(state.videoDuration),
        aiPolishedAt: rawNote ? now.toISOString() : null,
      };
      const tx = db.transaction(['moments', 'draft'], 'readwrite');
      tx.objectStore('moments').put(saved); tx.objectStore('draft').delete('active'); await txDone(tx);
      toast('保存しました');
    }
    selectedDate = saved.localDate;
    state = freshDraft(); await putDraft();
    els.note.value = ''; els.noteCount.textContent = '0'; setComposerDuration(10, false); await renderMedia(); refreshEditUI();
    await renderCalendar(); await renderSelectedDate();
  } catch (error) {
    console.error(error); toast(error?.message || '保存できませんでした。入力は残っています', 4200); try { await putDraft(); } catch {}
  } finally {
    els.save.disabled = false; refreshEditUI();
  }
}

async function deleteRecord(id) {
  const record = await getRecord(id); if (!record) return;
  const stores = ['moments', 'media']; if (db.objectStoreNames.contains('videos')) stores.push('videos');
  const tx = db.transaction(stores, 'readwrite');
  tx.objectStore('moments').delete(id);
  for (const mediaId of record.mediaIds || []) tx.objectStore('media').delete(mediaId);
  if (record.videoId && stores.includes('videos')) tx.objectStore('videos').delete(record.videoId);
  await txDone(tx); closeDetail(); await renderCalendar(); await renderSelectedDate(); toast('削除しました');
}

function showComposer() { els.pages.classList.remove('show-calendar'); }
async function showCalendar() { els.pages.classList.add('show-calendar'); await renderCalendar(); await renderSelectedDate(); }
async function renderCalendar() {
  const all = await getAllRecords();
  const grouped = new Map();
  for (const record of all) { if (!grouped.has(record.localDate)) grouped.set(record.localDate, []); grouped.get(record.localDate).push(record); }
  const y = currentMonth.getFullYear(), month = currentMonth.getMonth();
  els.monthTitle.textContent = `${y}年 ${month + 1}月`; els.calendar.innerHTML = '';
  const first = new Date(y, month, 1), start = new Date(y, month, 1 - first.getDay());
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const date = localDate(d), records = grouped.get(date) || [];
    const button = document.createElement('button'); button.type = 'button'; button.className = 'calendar-cell';
    if (d.getMonth() !== month) button.classList.add('other');
    if (date === localDate(new Date())) button.classList.add('today');
    if (date === selectedDate) button.classList.add('selected');
    button.innerHTML = `<span class="day-num">${d.getDate()}</span>${records.length ? `<span class="count">${records.length}</span><span class="record-dot"></span>` : '<span class="count" style="visibility:hidden">0</span>'}`;
    button.addEventListener('click', async () => {
      selectedDate = date; if (d.getMonth() !== month) currentMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      await renderCalendar(); await renderSelectedDate();
    });
    els.calendar.append(button);
  }
}
async function renderSelectedDate() {
  els.selectedDateTitle.textContent = formatLongDate(selectedDate);
  const records = (await getRecordsByDate(selectedDate)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  els.selectedDateCount.textContent = records.length ? `${records.length}件` : ''; els.recordList.innerHTML = '';
  if (!records.length) { els.recordList.innerHTML = '<p class="empty-message">この日はまだ何も残していません。</p>'; return; }
  for (const record of records) {
    const snippet = (record.polishedNote || record.rawNote || '').trim() || (record.mediaIds?.length ? '写真・動画の記録' : '記録');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'record-item';
    button.innerHTML = `<span class="record-copy"><strong>${formatTime(record.createdAt)}${record.videoId ? ' · 生成動画あり' : ''}</strong><span>${escapeHtml(snippet)}</span></span><span class="record-arrow">›</span>`;
    button.addEventListener('click', () => openDetail(record.id)); els.recordList.append(button);
  }
}

function renderDetailStory(record) {
  const polished = (record.polishedNote || record.rawNote || '').trim();
  const raw = (record.rawNote || record.note || '').trim();
  const canShowPolished = Boolean(polished);
  if (!canShowPolished) detailStoryMode = 'raw';
  els.detailPolishedTab.classList.toggle('selected', detailStoryMode === 'polished');
  els.detailRawTab.classList.toggle('selected', detailStoryMode === 'raw');
  els.detailStory.textContent = detailStoryMode === 'polished' ? (polished || '文章はありません。') : (raw || '元の文章はありません。');
}
async function openDetail(id) {
  const record = await getRecord(id); if (!record) return;
  detailRecordId = id; detailStoryMode = record.polishedNote ? 'polished' : 'raw';
  els.detailDate.textContent = formatLongDate(record.localDate);
  els.detailTime.textContent = formatTime(record.createdAt) + (record.editedAt ? ' · 編集済み' : '');
  revokeUrls(detailObjectUrls); els.detailMedia.innerHTML = '';
  for (const mediaId of record.mediaIds || []) {
    const media = await getMedia(mediaId); if (!media?.blob) continue;
    const url = URL.createObjectURL(media.blob); detailObjectUrls.push(url);
    if (media.blob.type.startsWith('video/')) {
      const video = document.createElement('video'); video.src = url; video.controls = true; video.playsInline = true; video.preload = 'metadata'; els.detailMedia.append(video);
    } else {
      const img = document.createElement('img'); img.src = url; img.alt = '保存した写真'; els.detailMedia.append(img);
    }
  }
  renderDetailStory(record);
  els.detailViewVideo.hidden = !record.videoId;
  els.detailGenerateVideo.textContent = record.videoId ? '動画を再生成' : '動画生成';
  setDetailDuration(record.videoDuration);
  els.detailModal.classList.add('open'); els.detailModal.setAttribute('aria-hidden', 'false');
}
function closeDetail() {
  els.detailModal.classList.remove('open'); els.detailModal.setAttribute('aria-hidden', 'true'); detailRecordId = null;
  els.detailMedia.querySelectorAll('video').forEach(video => video.pause()); els.detailMedia.innerHTML = ''; revokeUrls(detailObjectUrls);
}

async function mediaSummary(record) {
  let images = 0, videos = 0;
  for (const id of record.mediaIds || []) {
    const media = await getMedia(id);
    if (media?.blob?.type?.startsWith('video/')) videos++;
    else if (media?.blob?.type?.startsWith('image/')) images++;
  }
  return { images, videos };
}
async function buildVideoPrompt(record, segmentDuration, totalDuration) {
  const rawNote = (record.rawNote ?? record.note ?? '').trim() || '(no written record)';
  const polished = (record.polishedNote || '').trim();
  const media = await mediaSummary(record);
  const continuation = totalDuration > segmentDuration
    ? `This is the opening ${segmentDuration} seconds of a ${totalDuration}-second final video. Cover as many early story beats as possible and leave a clean transition for continuation.`
    : `The complete output is about ${segmentDuration} seconds. Fit the whole recorded event into this duration.`;
  return [
    'Create a vertical video that traces a real personal experience from the supplied record.',
    'CORE EDITING METHOD: FAST-CUT MEMORY MONTAGE. First identify every distinct factual story beat in the written record and reference media. Then cover the FULL progression instead of expanding only one scene.',
    'Use many short cuts, usually about 0.4-1.4 seconds each. Move quickly through setup, effort/actions, encounters, changes, turning points, outcome, and aftermath when those beats exist. Do not spend most of the runtime on a single generic shot.',
    'Make the emotional contrast strong and immediately legible while staying natural. Joy can be visibly exuberant, lively, close and energetic. Strong disappointment or hurt can be visibly embodied and intense. If strong sadness is clearly supported by the record, tears may be used as expressive dramatization. Never change the factual outcome or invent a new event just to create drama.',
    'Use pacing contrast: fast montage for repeated actions and passage of time; briefly slow down the strongest turning point; then accelerate or cut sharply into the result. The viewer should feel the rise and fall of the experience, not a flat reenactment.',
    'Treat supplied photos and videos as direct visual evidence. Preserve recognizable places, people, clothing and context when established by the references.',
    'Treat screenshots as documentary evidence of what happened, not an instruction to fabricate a long fake phone UI scene. Use their meaning without letting a screenshot dominate the whole video.',
    'Do not invent a visible face or full body for the user when the references do not establish their appearance. In that case use POV, hands, environment, partial framing, silhouettes, objects or other grounded visual choices.',
    'Do not add a moral lesson, motivational message, psychoanalysis, forced nostalgia, or forced beauty. Do not add captions, generated readable chat text, or narration unless the record itself clearly requires spoken dialogue.',
    `Original written record: ${rawNote}`,
    polished ? `Readable version of the same record: ${polished}` : '',
    `Reference media: ${media.images} image(s), ${media.videos} video(s).`,
    continuation,
    'Output: 9:16 portrait, native ambient audio, visually coherent across cuts. The priority is FULL-STORY COVERAGE + STRONG EMOTIONAL DYNAMICS + FIDELITY TO THE RECORD.'
  ].filter(Boolean).join('\n');
}
async function blobToBase64(blob) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
}
async function compressImageForAI(blob) {
  try {
    const bitmap = await createImageBitmap(blob), maxSide = 1100, scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false }); context.drawImage(bitmap, 0, 0, width, height); bitmap.close();
    return await new Promise(resolve => canvas.toBlob(result => resolve(result || blob), 'image/jpeg', .82));
  } catch { return blob; }
}
async function prepareOmniInput(record, prompt) {
  const parts = []; let videoAdded = false;
  for (const id of (record.mediaIds || []).slice(0, MAX_MEDIA)) {
    const media = await getMedia(id); if (!media?.blob) continue;
    if (media.blob.type.startsWith('video/')) {
      if (videoAdded) continue; videoAdded = true;
      if (media.blob.size > 28 * 1024 * 1024) throw new Error('動画が大きすぎます。短い動画で試してください');
      parts.push({ type: 'video', data: await blobToBase64(media.blob), mime_type: media.blob.type || 'video/mp4' });
    } else if (media.blob.type.startsWith('image/')) {
      const compressed = await compressImageForAI(media.blob);
      parts.push({ type: 'image', data: await blobToBase64(compressed), mime_type: compressed.type || 'image/jpeg' });
    }
  }
  parts.push({ type: 'text', text: prompt });
  return videoAdded ? [{ type: 'user_input', content: parts }] : parts;
}
function extractVideoOutput(payload) {
  if (payload?.output_video) return payload.output_video;
  for (const step of payload?.steps || []) for (const content of step?.content || []) if (content?.type === 'video') return content;
  return null;
}
function base64ToBlob(base64, mime = 'video/mp4') { const bytes = atob(base64), arr = new Uint8Array(bytes.length); for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i); return new Blob([arr], { type: mime }); }
function fileIdFromUri(uri = '') { return uri.match(/files\/([^/:?]+)/)?.[1] || null; }
async function createOmniInteraction(body, apiKey) {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, 'Api-Revision': '2026-05-20' },
    body: JSON.stringify({ ...body, store: true }),
  });
  const raw = await response.text(); let payload = {}; try { payload = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) throw new Error(payload?.error?.message || `Gemini API ${response.status}`);
  return payload;
}
async function resolveVideoOutput(payload, apiKey) {
  const output = extractVideoOutput(payload); if (!output) throw new Error('動画データが返りませんでした');
  if (output.data) return base64ToBlob(output.data, output.mime_type || 'video/mp4');
  if (!output.uri) throw new Error('動画URIが返りませんでした');
  const fileId = fileIdFromUri(output.uri); if (!fileId) throw new Error('動画ファイルIDを取得できませんでした');
  for (let i = 0; i < 120; i++) {
    const statusResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/files/${encodeURIComponent(fileId)}?key=${encodeURIComponent(apiKey)}`);
    if (!statusResponse.ok) throw new Error(`動画処理の確認に失敗しました (${statusResponse.status})`);
    const info = await statusResponse.json(); const status = typeof info.state === 'string' ? info.state : info.state?.name;
    if (status === 'ACTIVE') break;
    if (status === 'FAILED') throw new Error('動画生成に失敗しました');
    if (i === 119) throw new Error('動画生成がタイムアウトしました');
    await sleep(3000);
  }
  const download = await fetch(`https://generativelanguage.googleapis.com/v1beta/files/${encodeURIComponent(fileId)}:download?alt=media&key=${encodeURIComponent(apiKey)}`);
  if (!download.ok) throw new Error(`動画の取得に失敗しました (${download.status})`);
  return download.blob();
}
async function omniGenerateVideo(record, apiKey, duration) {
  duration = normalizeDuration(duration);
  const firstDuration = Math.min(duration, 10);
  const prompt = await buildVideoPrompt(record, firstDuration, duration);
  const input = await prepareOmniInput(record, prompt);
  const summary = await mediaSummary(record);
  const task = summary.videos > 0 || summary.images > 1 ? 'reference_to_video' : summary.images === 1 ? 'image_to_video' : 'text_to_video';
  let payload = await createOmniInteraction({
    model: OMNI_MODEL,
    input,
    response_format: { type: 'video', delivery: 'uri', aspect_ratio: '9:16', resolution: '720p' },
    generation_config: { video_config: { task } },
    background: false, stream: false,
  }, apiKey);
  let blob = await resolveVideoOutput(payload, apiKey);
  let interactionId = payload.id || null;
  const extensionCount = Math.ceil((duration - firstDuration) / 10);
  if (extensionCount && !interactionId) throw new Error('長尺動画の延長IDを取得できませんでした');
  for (let i = 0; i < extensionCount; i++) {
    const currentTotal = firstDuration + (i + 1) * 10;
    els.videoLoadingCopy.textContent = `${duration}秒動画を生成中… ${currentTotal}秒まで構成しています。`;
    payload = await createOmniInteraction({
      model: OMNI_MODEL,
      previous_interaction_id: interactionId,
      input: `Extend the video by 10 seconds. Continue the FAST-CUT MEMORY MONTAGE across any remaining factual story beats from the original record. Do not linger on one scene. Preserve the same people, context, emotional curve and factual outcome. Keep strong emotional contrast without inventing new events. Target total length: about ${currentTotal} seconds.`,
      response_format: { type: 'video', delivery: 'uri', aspect_ratio: '9:16', resolution: '720p' },
      generation_config: { video_config: { task: 'extend' } },
      background: false, stream: false,
    }, apiKey);
    blob = await resolveVideoOutput(payload, apiKey); interactionId = payload.id || interactionId;
  }
  return { blob, interactionId };
}

function openVideoLoading(duration = 10) {
  if (activeVideoUrl) { URL.revokeObjectURL(activeVideoUrl); activeVideoUrl = null; }
  els.videoPlayer.pause(); els.videoPlayer.removeAttribute('src'); els.videoPlayer.hidden = true;
  els.videoLoading.hidden = false; els.videoLoadingCopy.textContent = duration > 10 ? `${duration}秒動画を生成中… 全体の流れをつないでいます。` : '記録の全体を高速なカットで構成しています。';
  els.videoModal.classList.add('open'); els.videoModal.setAttribute('aria-hidden', 'false');
}
function showVideoBlob(blob) {
  if (activeVideoUrl) URL.revokeObjectURL(activeVideoUrl);
  activeVideoUrl = URL.createObjectURL(blob); els.videoLoading.hidden = true; els.videoPlayer.hidden = false; els.videoPlayer.src = activeVideoUrl; els.videoPlayer.play().catch(() => {});
}
function closeVideo() { els.videoModal.classList.remove('open'); els.videoModal.setAttribute('aria-hidden', 'true'); els.videoPlayer.pause(); }
async function viewStoredVideo(videoId) {
  const record = await getVideo(videoId); if (!record?.blob) { toast('動画が見つかりません'); return; }
  els.videoModal.classList.add('open'); els.videoModal.setAttribute('aria-hidden', 'false'); showVideoBlob(record.blob);
}
async function startGeneration(job) {
  if (generationBusy) { toast('動画を生成中です'); return; }
  if (!getGeminiKey()) { pendingAction = { type: 'generate', job }; openSettings(); toast('動画生成にGemini APIキーが必要です'); return; }
  let record;
  if (job.type === 'draft') record = { ...structuredClone(state), createdAt: new Date().toISOString(), localDate: localDate(new Date()) };
  else { record = await getRecord(job.id); if (!record) { toast('記録が見つかりません'); return; } }
  if (!recordHasContent(record)) { toast('まず写真・動画か出来事を残してください'); return; }
  const duration = normalizeDuration(job.duration || record.videoDuration || 10);
  generationBusy = true; els.generateVideo.disabled = true; els.detailGenerateVideo.disabled = true; openVideoLoading(duration);
  try {
    const result = await omniGenerateVideo(record, getGeminiKey(), duration);
    const newId = await saveVideo(result.blob, { model: OMNI_MODEL, interactionId: result.interactionId || null, duration });
    if (job.type === 'draft') {
      const oldId = state.videoId, originalVideoId = editOriginalRecord?.videoId || null;
      if (oldId && oldId !== originalVideoId) await deleteVideo(oldId).catch(() => {});
      state.videoId = newId; state.videoDuration = duration; setComposerDuration(duration, false); queueDraft();
    } else {
      const latest = await getRecord(job.id);
      if (latest) {
        if (latest.videoId) await deleteVideo(latest.videoId).catch(() => {});
        latest.videoId = newId; latest.videoDuration = duration; latest.videoGeneratedAt = new Date().toISOString(); latest.videoModel = OMNI_MODEL; await putRecord(latest);
      }
      if (detailRecordId === job.id) { els.detailViewVideo.hidden = false; els.detailGenerateVideo.textContent = '動画を再生成'; setDetailDuration(duration); }
      await renderSelectedDate();
    }
    showVideoBlob(result.blob); toast('動画を生成しました');
  } catch (error) {
    console.error(error); closeVideo(); toast(error?.message || '動画生成に失敗しました', 5200);
  } finally {
    generationBusy = false; els.generateVideo.disabled = false; els.detailGenerateVideo.disabled = false;
  }
}

function bindSwipe() {
  document.addEventListener('touchstart', event => {
    if (els.detailModal.classList.contains('open') || els.videoModal.classList.contains('open') || els.settingsSheet.classList.contains('open')) return;
    if (event.target.closest('textarea,input,button,label')) return;
    const touch = event.touches[0]; swipeStart = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });
  document.addEventListener('touchend', event => {
    if (!swipeStart) return;
    const touch = event.changedTouches[0], dx = touch.clientX - swipeStart.x, dy = touch.clientY - swipeStart.y; swipeStart = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    if (dx < 0) showCalendar(); else showComposer();
  }, { passive: true });
}

function cacheElements() {
  const ids = [
    'app','pages','draft-indicator','settings-open','reset-draft','calendar-open','media-input','media-strip','media-empty','note','note-count','duration-label','duration-options','save','generate-video',
    'calendar-back','month-prev','month-next','month-title','today','calendar','selected-date-title','selected-date-count','record-list',
    'settings-sheet','settings-close','openai-key','openai-paste','gemini-key','gemini-paste','settings-save',
    'detail-modal','detail-date','detail-time','detail-edit','detail-close','detail-media','detail-polished-tab','detail-raw-tab','detail-story','detail-duration-label','detail-duration-options','detail-generate-video','detail-view-video','detail-delete',
    'video-modal','video-close','video-loading','video-loading-copy','video-player','toast'
  ];
  for (const id of ids) els[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = $(id);
}
function bindEvents() {
  els.note.addEventListener('input', () => { state.rawNote = els.note.value; state.polishedNote = ''; els.noteCount.textContent = String(state.rawNote.length); queueDraft(); });
  els.mediaInput.addEventListener('change', () => addMedia(els.mediaInput.files));
  els.durationOptions.addEventListener('click', event => { const button = event.target.closest('[data-duration]'); if (button) setComposerDuration(button.dataset.duration); });
  els.save.addEventListener('click', saveRecord);
  els.generateVideo.addEventListener('click', () => startGeneration({ type: 'draft', duration: state.videoDuration }));
  els.resetDraft.addEventListener('click', () => resetComposer(true));
  els.calendarOpen.addEventListener('click', showCalendar); els.calendarBack.addEventListener('click', showComposer);
  els.monthPrev.addEventListener('click', async () => { currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1); await renderCalendar(); });
  els.monthNext.addEventListener('click', async () => { currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1); await renderCalendar(); });
  els.today.addEventListener('click', async () => { const now = new Date(); currentMonth = new Date(now.getFullYear(), now.getMonth(), 1); selectedDate = localDate(now); await renderCalendar(); await renderSelectedDate(); });
  els.settingsOpen.addEventListener('click', () => { pendingAction = null; openSettings(); });
  els.settingsClose.addEventListener('click', closeSettings); document.querySelector('[data-close-settings]').addEventListener('click', closeSettings); els.settingsSave.addEventListener('click', saveSettings);
  els.openaiPaste.addEventListener('click', () => pasteIntoApiField(els.openaiKey, 'OpenAI APIキー'));
  els.geminiPaste.addEventListener('click', () => pasteIntoApiField(els.geminiKey, 'Gemini APIキー'));
  els.detailClose.addEventListener('click', closeDetail); document.querySelector('[data-close-detail]').addEventListener('click', closeDetail);
  els.detailEdit.addEventListener('click', () => detailRecordId && beginEditRecord(detailRecordId));
  els.detailDelete.addEventListener('click', async () => { if (detailRecordId && confirm('この記録を削除しますか？')) await deleteRecord(detailRecordId); });
  els.detailPolishedTab.addEventListener('click', async () => { if (!detailRecordId) return; detailStoryMode = 'polished'; renderDetailStory(await getRecord(detailRecordId)); });
  els.detailRawTab.addEventListener('click', async () => { if (!detailRecordId) return; detailStoryMode = 'raw'; renderDetailStory(await getRecord(detailRecordId)); });
  els.detailDurationOptions.addEventListener('click', event => { const button = event.target.closest('[data-duration]'); if (button) setDetailDuration(button.dataset.duration); });
  els.detailGenerateVideo.addEventListener('click', () => detailRecordId && startGeneration({ type: 'record', id: detailRecordId, duration: detailDuration }));
  els.detailViewVideo.addEventListener('click', async () => { if (!detailRecordId) return; const record = await getRecord(detailRecordId); if (record?.videoId) await viewStoredVideo(record.videoId); });
  els.videoClose.addEventListener('click', closeVideo); document.querySelector('[data-close-video]').addEventListener('click', closeVideo);
  bindSwipe();
}

async function init() {
  cacheElements(); bindEvents();
  try {
    db = await openDB();
    const saved = await getDraft(); state = normalizeDraft(saved);
    editingRecordId = state.editingRecordId || null;
    if (editingRecordId) editOriginalRecord = await getRecord(editingRecordId);
    els.note.value = state.rawNote || ''; els.noteCount.textContent = String((state.rawNote || '').length);
    setComposerDuration(state.videoDuration, false); await renderMedia(); refreshEditUI();
    await putDraft(); await renderCalendar(); await renderSelectedDate();
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  } catch (error) {
    console.error(error); toast('記録データを読み込めませんでした', 5000);
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js?v=8').catch(console.error);
}

window.addEventListener('beforeunload', () => { revokeUrls(mediaObjectUrls); revokeUrls(detailObjectUrls); if (activeVideoUrl) URL.revokeObjectURL(activeVideoUrl); });
init();
