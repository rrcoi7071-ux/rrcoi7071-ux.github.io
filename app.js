const ALLOWED_DURATIONS = [5, 10, 20, 30];
const LIFE_STAGES = [
  { id: 'kindergarten', label: '幼稚園', prompt: '幼稚園の頃' },
  { id: 'elementary', label: '小学校', prompt: '小学生の頃' },
  { id: 'middle', label: '中学校', prompt: '中学生の頃' },
  { id: 'high', label: '高校', prompt: '高校生の頃' },
  { id: 'university', label: '大学', prompt: '大学生の頃' },
];
const DB_NAME = 'goblin-moment-db';
const DB_VERSION = 2;
const SCHEMA_VERSION = 6;
const OMNI_MODEL = 'gemini-omni-1.1-flash';
const SEEDANCE_MODEL = 'dreamina-seedance-2-0-mini-260615';
const OPENAI_MODEL = 'gpt-5.6-luna';
const GEMINI_KEY_STORAGE = 'goblin-moment-gemini-api-key';
const VIDEO_PROVIDER_STORAGE = 'goblin-moment-video-provider';
const API_BASE_STORAGE = 'goblin-moment-api-base-url';
const MAX_MEDIA = 8;

const els = {};
let db;
let state = freshDraft();
let draftTimer = null;
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
let lifeObjectUrls = [];
let swipeStart = null;

function $(id) { return document.getElementById(id); }
function normalizeDuration(value) { const n = Number(value); return ALLOWED_DURATIONS.includes(n) ? n : 10; }
function stageById(id) { return LIFE_STAGES.find(stage => stage.id === id) || null; }
function stageLabel(id) { return stageById(id)?.label || 'これまでの記録'; }
function stagePrompt(id) { return stageById(id)?.prompt || '人生のある時期'; }
function freshDraft() {
  return {
    key: 'active',
    schemaVersion: SCHEMA_VERSION,
    lifeStage: 'university',
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
    lifeStage: saved.lifeStage || saved.stage || base.lifeStage,
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
    lifeStage: record.lifeStage || record.stage || 'unclassified',
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
function formatSavedAt(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
function escapeHtml(value = '') { return String(value).replace(/[&<>\'\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
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
function setLifeStage(stageId, save = true) {
  if (!stageById(stageId)) return;
  state.lifeStage = stageId;
  els.stageLabel.textContent = stageLabel(stageId);
  els.stageOptions.querySelectorAll('[data-stage]').forEach(button => button.classList.toggle('selected', button.dataset.stage === stageId));
  if (save) queueDraft();
}
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
  els.note.value = ''; els.noteCount.textContent = '0';
  setLifeStage(state.lifeStage, false); setComposerDuration(10, false);
  await renderMedia(); refreshEditUI();
  toast('リセットしました');
}

function getGeminiKey() { return localStorage.getItem(GEMINI_KEY_STORAGE) || ''; }
function getApiBase() { return (localStorage.getItem(API_BASE_STORAGE) || '').trim().replace(/\/$/, ''); }
function apiUrl(path) { return `${getApiBase()}${path}`; }
function backendConfigured() { return Boolean(getApiBase()) || !location.hostname.endsWith('github.io'); }
function getVideoProvider() {
  const value = localStorage.getItem(VIDEO_PROVIDER_STORAGE);
  return value === 'gemini' ? 'gemini' : 'seedance';
}
function providerLabel(provider = getVideoProvider()) { return provider === 'gemini' ? 'Gemini Omni Flash' : 'Seedance 2.0 Mini'; }
function setProviderButtons(provider) {
  els.videoProviderOptions?.querySelectorAll('[data-provider]').forEach(button => button.classList.toggle('selected', button.dataset.provider === provider));
}
function applyProviderDurationRules(provider = getVideoProvider()) {
  const seedance = provider === 'seedance';
  for (const root of [els.durationOptions, els.detailDurationOptions]) {
    if (!root) continue;
    root.querySelectorAll('[data-duration]').forEach(button => {
      const duration = Number(button.dataset.duration);
      button.disabled = seedance && duration > 15;
      button.title = button.disabled ? 'Seedance 2.0 Miniは最大15秒です' : '';
    });
  }
  if (seedance && state.videoDuration > 15) setComposerDuration(10, false);
  if (seedance && detailDuration > 15) setDetailDuration(10);
}
function openSettings() {
  const provider = getVideoProvider();
  els.apiBaseUrl.value = getApiBase();
  els.geminiKey.value = getGeminiKey();
  setProviderButtons(provider);
  applyProviderDurationRules(provider);
  els.settingsSheet.classList.add('open'); els.settingsSheet.setAttribute('aria-hidden', 'false');
}
function closeSettings() { els.settingsSheet.classList.remove('open'); els.settingsSheet.setAttribute('aria-hidden', 'true'); }
async function pasteIntoApiField(input, label) {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) { toast('クリップボードが空です'); return; }
    input.value = text.trim(); input.focus(); toast(`${label}を貼り付けました`);
  } catch (error) {
    console.error(error); input.focus(); toast('自動貼り付けが使えません。入力欄を長押しして貼り付けてください');
  }
}
async function saveSettings() {
  const apiBaseUrl = els.apiBaseUrl.value.trim().replace(/\/$/, '');
  const geminiKey = els.geminiKey.value.trim();
  const provider = els.videoProviderOptions.querySelector('[data-provider].selected')?.dataset.provider || 'seedance';
  if (apiBaseUrl && !/^https:\/\//i.test(apiBaseUrl)) { toast('中継サーバーURLはhttps://から入力してください'); return; }
  if (apiBaseUrl) localStorage.setItem(API_BASE_STORAGE, apiBaseUrl); else localStorage.removeItem(API_BASE_STORAGE);
  localStorage.removeItem('goblin-moment-openai-api-key');
  localStorage.removeItem('goblin-moment-byteplus-api-key');
  if (geminiKey) localStorage.setItem(GEMINI_KEY_STORAGE, geminiKey); else localStorage.removeItem(GEMINI_KEY_STORAGE);
  localStorage.setItem(VIDEO_PROVIDER_STORAGE, provider);
  applyProviderDurationRules(provider);
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

async function openAIText(developerText, userText) {
  let response;
  try {
    response = await fetch(apiUrl('/api/openai'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      store: false,
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: developerText }] },
        { role: 'user', content: [{ type: 'input_text', text: userText }] }
      ]
    })
    });
  } catch (error) {
    console.error('OpenAI proxy network error', error);
    throw new Error('AI中継サーバーへ接続できません。設定のURLを確認してください');
  }
  const raw = await response.text();
  let payload = {}; try { payload = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI API ${response.status}`);
  const result = extractResponseText(payload);
  if (!result) throw new Error('GPTから応答が返りませんでした');
  return result;
}
function parseJsonObject(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('GPTの動画用データを読み取れませんでした');
  try { return JSON.parse(cleaned.slice(start, end + 1)); }
  catch { throw new Error('GPTの動画用データ形式が壊れていました'); }
}
function normalizeVideoPlan(plan) {
  const summary = String(plan?.neutralSummary || '').trim();
  const storyBeats = Array.isArray(plan?.storyBeats) ? plan.storyBeats.map(v => String(v || '').trim()).filter(Boolean) : [];
  const emotionalArc = Array.isArray(plan?.emotionalArc) ? plan.emotionalArc.map(item => ({
    beat: String(item?.beat || '').trim(),
    emotion: String(item?.emotion || '').trim(),
    intensity: Math.max(0, Math.min(3, Number(item?.intensity) || 0)),
    expressionGuidance: String(item?.expressionGuidance || '').trim(),
  })).filter(item => item.beat || item.emotion || item.expressionGuidance) : [];
  const uncertainties = Array.isArray(plan?.uncertainties) ? plan.uncertainties.map(v => String(v || '').trim()).filter(Boolean) : [];
  if (!summary && !storyBeats.length) throw new Error('GPTが動画化できる事実を整理できませんでした');
  return { neutralSummary: summary, storyBeats, emotionalArc, uncertainties };
}
async function prepareVerifiedVideoPlan(record, onStage = () => {}) {
  const source = (record.rawNote ?? record.note ?? record.polishedNote ?? '').trim();
  if (!source) return { neutralSummary: '', storyBeats: [], emotionalArc: [], uncertainties: ['No written record. Use only supplied reference media as evidence.'] };
  const period = stagePrompt(record.lifeStage);
  onStage('GPTが出来事を動画用に整理しています…');
  const plannerInstruction = [
    'You are a factual intermediary between a person’s life record and a video-generation model.',
    'Your job is NOT to bypass another model’s safety system. Your job is to convert informal, voice-dictated, ambiguous wording into neutral, precise, model-ready language while preserving the user’s actual facts.',
    'Preserve every supported event, relationship, chronology, outcome, and stated emotion. Do not invent, delete, intensify, sanitize, or reinterpret facts.',
    'Clarify wording that could be misread. For example, ordinary childhood affection or being described as cute should be expressed explicitly as age-appropriate non-romantic care when that is what the source says. Never infer sexual, romantic, violent, criminal, or other sensitive meaning unless the source actually states it.',
    'If something is uncertain, keep it uncertain. Never guess exact age, identity, place, dialogue, motive, or causal connection.',
    'For emotion, separate FACT from PERFORMANCE. You may suggest stronger visible performance only when the source clearly states or strongly supports that emotion. Emotional performance may amplify how an existing emotion is shown, but may not create a new emotion or new event.',
    'Do not write a moral lesson, psychological diagnosis, or interpretation of what the memory means.',
    'Return JSON only with exactly these keys: neutralSummary (string), storyBeats (array of factual strings in chronological order), emotionalArc (array of objects with beat, emotion, intensity from 0 to 3, expressionGuidance), uncertainties (array of strings).'
  ].join('\n');
  const firstText = await openAIText(plannerInstruction, `Life period: ${period}\nOriginal record:\n${source}`);
  const firstPlan = normalizeVideoPlan(parseJsonObject(firstText));

  onStage('GPTが元の文章と照合しています…');
  const verifierInstruction = [
    'You are a strict factual verifier for a personal-memory video plan.',
    'Compare the ORIGINAL RECORD against the DRAFT PLAN. Return a corrected final plan.',
    'Hard rule: every factual statement in the final plan must be directly supported by the original record. Remove or correct unsupported people, actions, ages, places, dialogue, motives, emotions, sequence, causality, and outcomes.',
    'Hard rule: do not omit a supported factual beat merely to make the story cleaner. Keep ambiguity as ambiguity rather than resolving it by guessing.',
    'Neutral clarification is allowed only when it preserves meaning. Do not disguise genuinely unsafe content to evade safety systems.',
    'Emotional expression guidance can be vivid, including voice and body language, only for emotions supported by the original. It must be labeled as performance guidance, not as a newly asserted fact.',
    'Return JSON only with exactly these keys: neutralSummary, storyBeats, emotionalArc, uncertainties.'
  ].join('\n');
  const verificationInput = `ORIGINAL RECORD:\n${source}\n\nDRAFT PLAN:\n${JSON.stringify(firstPlan)}`;
  const verifiedText = await openAIText(verifierInstruction, verificationInput);
  return normalizeVideoPlan(parseJsonObject(verifiedText));
}
async function polishNote(rawNote) {
  const text = rawNote.trim();
  if (!text) return '';
  return openAIText(
    'あなたは個人の人生記録を整える編集者です。ユーザーの入力を、後から読み返して出来事の流れと当時の感情が思い出せる、自然で読みやすい一人称の日本語に整理してください。事実、人物関係、時系列、結果、本人が書いた感情を絶対に変えないでください。入力にない出来事・動機・感情・結論を追加しないでください。道徳的評価、助言、分析、見出し、箇条書きは不要です。重複、言い直し、音声入力由来の崩れだけを整理し、本人の温度感は残してください。本文だけを返してください。',
    text
  );
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
  if (!stageById(state.lifeStage)) state.lifeStage = 'university';
  await putDraft();
  els.note.value = state.rawNote || ''; els.noteCount.textContent = String((state.rawNote || '').length);
  setLifeStage(state.lifeStage, false); setComposerDuration(state.videoDuration, false); applyProviderDurationRules(getVideoProvider()); await renderMedia(); refreshEditUI(); closeDetail(); showComposer();
  toast('編集できます');
}

async function saveRecord() {
  if (els.save.disabled) return;
  if (!stageById(state.lifeStage)) { toast('幼稚園・小学校・中学校・高校・大学から時期を選んでください'); return; }
  if (!recordHasContent(state)) { toast('まず写真・動画か出来事を残してください'); return; }
  const rawNote = (state.rawNote || '').trim();
  if (rawNote && !backendConfigured()) {
    pendingAction = { type: 'save' }; openSettings(); toast('文章整理に中継サーバーURLが必要です'); return;
  }
  els.save.disabled = true; els.save.textContent = '保存中…'; clearTimeout(draftTimer);
  try {
    let polishedNote = rawNote;
    if (rawNote) {
      els.draftIndicator.textContent = 'GPTが文章を整理中…';
      try { polishedNote = await polishNote(rawNote); }
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
        lifeStage: state.lifeStage,
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
        lifeStage: state.lifeStage,
        createdAt: now.toISOString(), occurredAt: now.toISOString(), localDate: localDate(now),
        rawNote, polishedNote, note: polishedNote || rawNote,
        mediaIds: [...state.mediaIds], videoId: state.videoId || null,
        videoDuration: normalizeDuration(state.videoDuration),
        aiPolishedAt: rawNote ? now.toISOString() : null,
      };
      const tx = db.transaction(['moments', 'draft'], 'readwrite');
      tx.objectStore('moments').put(saved); tx.objectStore('draft').delete('active'); await txDone(tx);
      toast(`${stageLabel(saved.lifeStage)}に保存しました`);
    }
    state = freshDraft(); await putDraft();
    els.note.value = ''; els.noteCount.textContent = '0'; setLifeStage(state.lifeStage, false); setComposerDuration(10, false); await renderMedia(); refreshEditUI();
    await renderLifeTimeline();
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
  await txDone(tx); closeDetail(); await renderLifeTimeline(); toast('削除しました');
}

function showComposer() { els.lifeTimeline.querySelectorAll('video').forEach(video => video.pause()); els.pages.classList.remove('show-life'); }
async function showLife() { els.pages.classList.add('show-life'); await renderLifeTimeline(); }
function jumpToStage(stageId) {
  const target = document.getElementById(`life-${stageId}`);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function buildLifeNav() {
  els.lifeStageNav.innerHTML = '';
  for (const stage of LIFE_STAGES) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = stage.label;
    button.addEventListener('click', () => jumpToStage(stage.id));
    els.lifeStageNav.append(button);
  }
}
async function appendRecordPreview(container, record) {
  const preview = document.createElement('div'); preview.className = 'life-record-preview';
  if (record.videoId) {
    const stored = await getVideo(record.videoId);
    if (stored?.blob) {
      const url = URL.createObjectURL(stored.blob); lifeObjectUrls.push(url);
      const video = document.createElement('video'); video.src = url; video.controls = true; video.playsInline = true; video.preload = 'metadata';
      preview.append(video); container.append(preview); return;
    }
  }
  const firstId = record.mediaIds?.[0];
  if (firstId) {
    const media = await getMedia(firstId);
    if (media?.blob) {
      const url = URL.createObjectURL(media.blob); lifeObjectUrls.push(url);
      if (media.blob.type.startsWith('video/')) {
        const video = document.createElement('video'); video.src = url; video.muted = true; video.playsInline = true; video.preload = 'metadata';
        preview.append(video);
      } else {
        const img = document.createElement('img'); img.src = url; img.alt = '記録した写真'; preview.append(img);
      }
      container.append(preview);
    }
  }
}
async function buildLifeRecordCard(record) {
  const article = document.createElement('article'); article.className = 'life-record-card';
  await appendRecordPreview(article, record);
  const body = document.createElement('div'); body.className = 'life-record-body';
  const meta = document.createElement('div'); meta.className = 'life-record-meta';
  meta.innerHTML = `<span>${record.videoId ? '生成動画あり' : '記録'}</span><span>${escapeHtml(formatSavedAt(record.createdAt))}</span>`;
  const p = document.createElement('p');
  p.textContent = (record.polishedNote || record.rawNote || '').trim() || '写真・動画の記録';
  const actions = document.createElement('div'); actions.className = 'life-record-actions';
  const open = document.createElement('button'); open.type = 'button'; open.className = 'life-record-open'; open.textContent = '開く'; open.addEventListener('click', () => openDetail(record.id));
  actions.append(open); body.append(meta, p, actions); article.append(body); return article;
}
async function renderLifeTimeline() {
  revokeUrls(lifeObjectUrls);
  const all = (await getAllRecords()).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  els.lifeTimeline.innerHTML = '';
  let index = 1;
  for (const stage of LIFE_STAGES) {
    const records = all.filter(record => record.lifeStage === stage.id);
    const section = document.createElement('section'); section.className = 'life-section'; section.id = `life-${stage.id}`;
    const head = document.createElement('div'); head.className = 'life-section-head';
    head.innerHTML = `<div class="life-stage-title"><span class="life-stage-index">${String(index).padStart(2, '0')}</span><h2>${stage.label}</h2></div><span class="life-section-count">${records.length ? `${records.length}件` : ''}</span>`;
    const list = document.createElement('div'); list.className = 'life-records';
    if (!records.length) {
      const empty = document.createElement('div'); empty.className = 'life-empty'; empty.textContent = `${stage.label}の記憶はまだありません。`; list.append(empty);
    } else {
      for (const record of records) list.append(await buildLifeRecordCard(record));
    }
    section.append(head, list); els.lifeTimeline.append(section); index++;
  }
  const legacy = all.filter(record => !stageById(record.lifeStage));
  if (legacy.length) {
    const section = document.createElement('section'); section.className = 'life-section'; section.id = 'life-unclassified';
    const head = document.createElement('div'); head.className = 'life-section-head';
    head.innerHTML = `<div class="life-stage-title"><span class="life-stage-index">旧</span><h2>これまでの記録</h2></div><span class="life-section-count">${legacy.length}件</span>`;
    const list = document.createElement('div'); list.className = 'life-records';
    for (const record of legacy) list.append(await buildLifeRecordCard(record));
    section.append(head, list); els.lifeTimeline.append(section);
  }
}

function renderDetailStory(record) {
  const polished = (record.polishedNote || record.rawNote || '').trim();
  const raw = (record.rawNote || record.note || '').trim();
  if (!polished) detailStoryMode = 'raw';
  els.detailPolishedTab.classList.toggle('selected', detailStoryMode === 'polished');
  els.detailRawTab.classList.toggle('selected', detailStoryMode === 'raw');
  els.detailStory.textContent = detailStoryMode === 'polished' ? (polished || '文章はありません。') : (raw || '元の文章はありません。');
}
async function openDetail(id) {
  const record = await getRecord(id); if (!record) return;
  detailRecordId = id; detailStoryMode = record.polishedNote ? 'polished' : 'raw';
  els.detailStage.textContent = stageLabel(record.lifeStage);
  els.detailTime.textContent = `保存 ${formatSavedAt(record.createdAt)}${record.editedAt ? ' · 編集済み' : ''}`;
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
async function buildVideoPrompt(record, segmentDuration, totalDuration, plan) {
  const media = await mediaSummary(record);
  const lifePeriod = stagePrompt(record.lifeStage);
  const beats = plan.storyBeats.length ? plan.storyBeats.map((beat, i) => `${i + 1}. ${beat}`).join('\n') : 'No written story beats. Use only supplied reference media as factual evidence.';
  const emotions = plan.emotionalArc.length ? plan.emotionalArc.map((item, i) => `${i + 1}. Beat: ${item.beat || 'unspecified'} | Emotion: ${item.emotion || 'unspecified'} | Intensity: ${item.intensity}/3 | Performance guidance: ${item.expressionGuidance || 'none'}`).join('\n') : 'No explicit emotional arc was established. Do not invent one.';
  const uncertainties = plan.uncertainties.length ? plan.uncertainties.map(v => `- ${v}`).join('\n') : '- None stated.';
  const continuation = totalDuration > segmentDuration
    ? `This is the opening ${segmentDuration} seconds of a ${totalDuration}-second final video. Cover as many early story beats as possible and leave a clean transition for continuation.`
    : `The complete output is about ${segmentDuration} seconds. Fit the whole recorded experience into this duration.`;
  return [
    'Create a vertical AI memory video from the FACT-CHECKED VIDEO PLAN below.',
    'The plan was prepared from the user’s original life record and then independently checked against that original for factual fidelity. Do not reconstruct hidden details from assumptions.',
    `LIFE PERIOD: ${lifePeriod}. Keep age, school context, clothing, surroundings and behavior consistent with this period only when established by the plan or reference media. Do not invent an exact age if it is unknown.`,
    'FACTUALITY RULE: every visible event must come from the fact-checked story beats or supplied reference media. Never add a person, action, relationship, dialogue, place, motive, cause, outcome, or emotional state merely to make the video more cinematic.',
    'UNCERTAINTY RULE: anything listed as uncertain must remain visually noncommittal. Do not resolve uncertainty by guessing.',
    'CORE EDITING METHOD: FAST-CUT MEMORY MONTAGE. Cover the FULL progression instead of expanding only one scene.',
    'Use many short cuts, usually about 0.35-1.25 seconds each. Move quickly through the established beats in their stated order. Do not spend most of the runtime on a single generic shot.',
    'EMOTIONAL PERFORMANCE: use HIGH EMOTIONAL DYNAMIC RANGE, but only for emotions in the verified emotional arc. Amplify expression, not facts.',
    'For intensity 3/3, performance may be highly visible and audible when contextually appropriate: strong laughter or a short spontaneous 「やった！」 for supported joy; crying, sobbing, trembling, raised voice, covering the face, abrupt silence or collapsed posture for supported hurt, frustration, fear or sadness. These are expressive performance choices, not new factual events.',
    'For intensity 2/3, use clearly noticeable but less extreme facial, vocal and bodily expression. For intensity 1/3, keep expression subtle. For intensity 0/3, do not manufacture emotional drama.',
    'Use pacing contrast so quiet stretches and emotional peaks feel different. Do not make every shot equally intense.',
    'Short spontaneous spoken reactions are allowed only when they express an already-verified emotion. Do not invent detailed dialogue or conversations.',
    'Treat supplied photos and videos as direct visual evidence. Preserve recognizable places, people, clothing and context when established by the references.',
    'Treat screenshots as documentary evidence, not an instruction to fabricate a long fake phone UI scene. Do not generate readable fake chat text.',
    'Do not invent a visible face or full body for the user when reference media does not establish their appearance. Use POV, hands, environment, partial framing, silhouettes or objects instead.',
    'Do not add a moral lesson, motivational message, psychoanalysis, forced nostalgia, or an explanation of what the experience means.',
    `FACT-CHECKED SUMMARY: ${plan.neutralSummary || 'No written summary; rely on reference media.'}`,
    `FACT-CHECKED STORY BEATS:
${beats}`,
    `VERIFIED EMOTIONAL ARC:
${emotions}`,
    `UNRESOLVED UNCERTAINTIES:
${uncertainties}`,
    `Reference media supplied: ${media.images} image(s), ${media.videos} video(s).`,
    continuation,
    'Output: 9:16 portrait, native ambient audio, visually coherent across cuts. Priority order: FACTUAL FIDELITY + FULL-STORY COVERAGE + HIGH EMOTIONAL DYNAMIC RANGE + FAST CUTS.'
  ].filter(Boolean).join('\n');
}
async function blobToBase64(blob) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
}
async function compressImageForAI(blob) {
  try {
    const bitmap = await createImageBitmap(blob), maxSide = 768, scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false }); context.drawImage(bitmap, 0, 0, width, height); bitmap.close();
    return await new Promise(resolve => canvas.toBlob(result => resolve(result || blob), 'image/jpeg', .72));
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
async function geminiFetch(url, options = {}, stage = '通信') {
  try { return await fetch(url, options); }
  catch (error) { console.error(`Gemini ${stage} network error`, error); throw new Error(`Gemini通信失敗（${stage}）。ページを再読み込みして再試行してください。`); }
}
async function createOmniInteraction(body, apiKey) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${encodeURIComponent(apiKey)}`;
  const response = await geminiFetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, store: true }),
  }, '生成開始');
  const raw = await response.text(); let payload = {}; try { payload = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) throw new Error(payload?.error?.message || `Gemini API ${response.status}`);
  return payload;
}
async function getInteractionInlineVideo(interactionId, apiKey) {
  if (!interactionId) return null;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/interactions/${encodeURIComponent(interactionId)}?key=${encodeURIComponent(apiKey)}`;
  const response = await geminiFetch(endpoint, { method: 'GET' }, '動画取得');
  const raw = await response.text(); let payload = {}; try { payload = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) throw new Error(payload?.error?.message || `Gemini動画取得 ${response.status}`);
  if (payload?.status === 'failed') throw new Error(payload?.errors?.[0]?.message || 'Gemini側で動画生成に失敗しました');
  const output = extractVideoOutput(payload);
  if (output?.data) return base64ToBlob(output.data, output.mime_type || 'video/mp4');
  return null;
}
async function resolveVideoOutput(payload, apiKey) {
  const output = extractVideoOutput(payload);
  if (!output) throw new Error('Geminiから動画情報が返りませんでした');
  if (output.data) return base64ToBlob(output.data, output.mime_type || 'video/mp4');
  if (payload?.id) {
    for (let i = 0; i < 8; i++) {
      const inline = await getInteractionInlineVideo(payload.id, apiKey);
      if (inline) return inline;
      await sleep(1500);
    }
  }
  if (!output.uri) throw new Error('動画データも動画URIも返りませんでした');
  const fileId = fileIdFromUri(output.uri);
  if (!fileId) throw new Error('動画ファイルIDを取得できませんでした');
  for (let i = 0; i < 120; i++) {
    const statusResponse = await geminiFetch(`https://generativelanguage.googleapis.com/v1beta/files/${encodeURIComponent(fileId)}?key=${encodeURIComponent(apiKey)}`, { method: 'GET' }, '動画処理確認');
    if (!statusResponse.ok) throw new Error(`動画処理の確認に失敗しました (${statusResponse.status})`);
    const info = await statusResponse.json();
    const status = typeof info.state === 'string' ? info.state : info.state?.name;
    if (status === 'ACTIVE') break;
    if (status === 'FAILED') throw new Error('Gemini側で動画生成に失敗しました');
    if (i === 119) throw new Error('動画生成がタイムアウトしました');
    await sleep(3000);
  }
  const download = await geminiFetch(`https://generativelanguage.googleapis.com/v1beta/files/${encodeURIComponent(fileId)}:download?alt=media&key=${encodeURIComponent(apiKey)}`, { method: 'GET' }, '動画ダウンロード');
  if (!download.ok) throw new Error(`動画の取得に失敗しました (${download.status})`);
  return download.blob();
}
async function omniGenerateVideo(record, apiKey, duration, plan) {
  duration = normalizeDuration(duration);
  const firstDuration = Math.min(duration, 10);
  const prompt = await buildVideoPrompt(record, firstDuration, duration, plan);
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
      input: `Extend the video by 10 seconds. Continue the FAST-CUT MEMORY MONTAGE across any remaining factual life beats from the original record. Keep HIGH EMOTIONAL DYNAMIC RANGE and strong physical/vocal emotional performance where supported. Do not linger on one scene. Preserve the same people, age period, context and factual outcome. Target total length: about ${currentTotal} seconds.`,
      response_format: { type: 'video', delivery: 'uri', aspect_ratio: '9:16', resolution: '720p' },
      generation_config: { video_config: { task: 'extend' } },
      background: false, stream: false,
    }, apiKey);
    blob = await resolveVideoOutput(payload, apiKey); interactionId = payload.id || interactionId;
  }
  return { blob, interactionId };
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('ファイルを読み取れませんでした'));
    reader.readAsDataURL(blob);
  });
}
async function extractVideoFrameForSeedance(blob) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = url;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('動画フレームの読み込みがタイムアウトしました')), 12000);
      video.onloadeddata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new Error('動画フレームを読み取れませんでした')); };
      video.load();
    });
    const target = Number.isFinite(video.duration) && video.duration > .3 ? Math.min(.5, video.duration * .2) : 0;
    if (target > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('動画フレームの取得がタイムアウトしました')), 8000);
        video.onseeked = () => { clearTimeout(timer); resolve(); };
        video.currentTime = target;
      });
    }
    const width = video.videoWidth || 720, height = video.videoHeight || 1280;
    const maxSide = 768, scale = Math.min(1, maxSide / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return await new Promise(resolve => canvas.toBlob(result => resolve(result), 'image/jpeg', .72));
  } finally {
    video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
  }
}
async function prepareSeedanceContent(record, prompt) {
  const content = [{ type: 'text', text: prompt }];
  let referenceCount = 0;
  for (const id of (record.mediaIds || []).slice(0, MAX_MEDIA)) {
    if (referenceCount >= 4) break;
    const media = await getMedia(id); if (!media?.blob) continue;
    try {
      let imageBlob = null;
      if (media.blob.type.startsWith('image/')) imageBlob = await compressImageForAI(media.blob);
      else if (media.blob.type.startsWith('video/')) imageBlob = await extractVideoFrameForSeedance(media.blob);
      if (!imageBlob) continue;
      content.push({
        type: 'image_url',
        image_url: { url: await blobToDataUrl(imageBlob) },
        role: 'reference_image'
      });
      referenceCount++;
    } catch (error) {
      console.warn('Seedance reference preparation skipped', error);
    }
  }
  return content;
}
async function seedanceFetch(url, options = {}, stage = '通信') {
  try { return await fetch(url, options); }
  catch (error) {
    console.error(`Seedance ${stage} network error`, error);
    throw new Error(`Seedance通信失敗（${stage}）。中継サーバーのURLと設定を確認してください。`);
  }
}
async function parseProviderResponse(response) {
  const raw = await response.text();
  let payload = {}; try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw }; }
  return payload;
}
function bytePlusError(payload, fallback) {
  return payload?.error?.message || payload?.error?.code || payload?.message || payload?.raw || fallback;
}
async function seedanceGenerateVideo(record, duration, plan) {
  duration = Math.max(4, Math.min(15, Number(duration) || 10));
  const prompt = await buildVideoPrompt(record, duration, duration, plan);
  const content = await prepareSeedanceContent(record, prompt);
  const base = apiUrl('/api/seedance');
  const response = await seedanceFetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: SEEDANCE_MODEL,
      content,
      resolution: '720p',
      ratio: '9:16',
      duration,
      generate_audio: true,
      watermark: false,
      return_last_frame: false,
    })
  }, '生成開始');
  const created = await parseProviderResponse(response);
  if (!response.ok) throw new Error(bytePlusError(created, `BytePlus API ${response.status}`));
  const taskId = created?.id;
  if (!taskId) throw new Error('SeedanceのタスクIDを取得できませんでした');

  let completed = null;
  for (let i = 0; i < 180; i++) {
    if (i > 0) await sleep(3000);
    const statusResponse = await seedanceFetch(`${base}?taskId=${encodeURIComponent(taskId)}`, { method: 'GET' }, '動画処理確認');
    const task = await parseProviderResponse(statusResponse);
    if (!statusResponse.ok) throw new Error(bytePlusError(task, `Seedance動画確認 ${statusResponse.status}`));
    const status = String(task?.status || '').toLowerCase();
    if (status === 'succeeded') { completed = task; break; }
    if (['failed','cancelled','expired'].includes(status)) throw new Error(bytePlusError(task, `Seedance側で動画生成に失敗しました (${status || 'unknown'})`));
    els.videoLoadingCopy.textContent = status === 'queued' ? 'Seedance 2.0 Miniで生成待ちです…' : 'Seedance 2.0 Miniが動画を生成しています…';
  }
  if (!completed) throw new Error('Seedance動画生成がタイムアウトしました');
  if (!completed?.video_ready) throw new Error('Seedanceから動画URLが返りませんでした');
  const download = await seedanceFetch(`${base}?taskId=${encodeURIComponent(taskId)}&download=1`, { method: 'GET' }, '動画ダウンロード');
  if (!download.ok) throw new Error(`Seedance動画の取得に失敗しました (${download.status})`);
  const blob = await download.blob();
  if (!blob?.size) throw new Error('Seedance動画データが空でした');
  return { blob, taskId, usage: completed?.usage || null };
}

function openVideoLoading(duration = 10, provider = getVideoProvider()) {
  if (activeVideoUrl) { URL.revokeObjectURL(activeVideoUrl); activeVideoUrl = null; }
  els.videoPlayer.pause(); els.videoPlayer.removeAttribute('src'); els.videoPlayer.hidden = true;
  els.videoModelLabel.textContent = providerLabel(provider);
  els.videoLoading.hidden = false;
  els.videoLoadingCopy.textContent = duration > 10 ? `${duration}秒動画を生成中… 人生の流れをつないでいます。` : '人生の記憶を高速なカットと強い感情表現で構成しています。';
  els.videoModal.classList.add('open'); els.videoModal.setAttribute('aria-hidden', 'false');
}
function showVideoBlob(blob) {
  if (activeVideoUrl) URL.revokeObjectURL(activeVideoUrl);
  activeVideoUrl = URL.createObjectURL(blob); els.videoLoading.hidden = true; els.videoPlayer.hidden = false; els.videoPlayer.src = activeVideoUrl; els.videoPlayer.play().catch(() => {});
}
function closeVideo() { els.videoModal.classList.remove('open'); els.videoModal.setAttribute('aria-hidden', 'true'); els.videoPlayer.pause(); }
async function viewStoredVideo(videoId) {
  const record = await getVideo(videoId); if (!record?.blob) { toast('動画が見つかりません'); return; }
  els.videoModelLabel.textContent = record.provider === 'seedance' || record.model === SEEDANCE_MODEL ? 'Seedance 2.0 Mini' : 'Gemini Omni Flash';
  els.videoModal.classList.add('open'); els.videoModal.setAttribute('aria-hidden', 'false'); showVideoBlob(record.blob);
}
async function startGeneration(job) {
  if (generationBusy) { toast('動画を生成中です'); return; }
  const provider = getVideoProvider();
  if (!backendConfigured() || (provider === 'gemini' && !getGeminiKey())) {
    pendingAction = { type: 'generate', job }; openSettings();
    if (!backendConfigured()) toast('動画生成に中継サーバーURLが必要です');
    else toast('動画生成にGemini APIキーが必要です');
    return;
  }
  let record;
  if (job.type === 'draft') record = { ...structuredClone(state), createdAt: new Date().toISOString(), localDate: localDate(new Date()) };
  else { record = await getRecord(job.id); if (!record) { toast('記録が見つかりません'); return; } }
  if (!stageById(record.lifeStage)) { toast('まず人生の時期を選んでください'); return; }
  if (!recordHasContent(record)) { toast('まず写真・動画か出来事を残してください'); return; }
  const duration = normalizeDuration(job.duration || record.videoDuration || 10);
  if (provider === 'seedance' && duration > 15) { toast('Seedance 2.0 Miniは最大15秒です。5秒か10秒を選んでください'); return; }
  generationBusy = true; els.generateVideo.disabled = true; els.detailGenerateVideo.disabled = true; openVideoLoading(duration, provider);
  try {
    const plan = await prepareVerifiedVideoPlan(record, message => { els.videoLoadingCopy.textContent = message; });
    let result, model;
    if (provider === 'seedance') {
      els.videoLoadingCopy.textContent = 'Seedance 2.0 Miniが事実確認済みの設計図から動画を生成しています…';
      result = await seedanceGenerateVideo(record, duration, plan);
      model = SEEDANCE_MODEL;
    } else {
      els.videoLoadingCopy.textContent = 'Geminiが事実確認済みの設計図から動画を生成しています…';
      result = await omniGenerateVideo(record, getGeminiKey(), duration, plan);
      model = OMNI_MODEL;
    }
    const newId = await saveVideo(result.blob, { model, provider, interactionId: result.interactionId || null, taskId: result.taskId || null, duration, lifeStage: record.lifeStage });
    if (job.type === 'draft') {
      const oldId = state.videoId, originalVideoId = editOriginalRecord?.videoId || null;
      if (oldId && oldId !== originalVideoId) await deleteVideo(oldId).catch(() => {});
      state.videoId = newId; state.videoDuration = duration; setComposerDuration(duration, false); queueDraft();
    } else {
      const latest = await getRecord(job.id);
      if (latest) {
        if (latest.videoId) await deleteVideo(latest.videoId).catch(() => {});
        latest.videoId = newId; latest.videoDuration = duration; latest.videoGeneratedAt = new Date().toISOString(); latest.videoModel = model; latest.videoProvider = provider; await putRecord(latest);
      }
      if (detailRecordId === job.id) { els.detailViewVideo.hidden = false; els.detailGenerateVideo.textContent = '動画を再生成'; setDetailDuration(duration); }
      await renderLifeTimeline();
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
    if (event.target.closest('textarea,input,button,label,video')) return;
    const touch = event.touches[0]; swipeStart = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });
  document.addEventListener('touchend', event => {
    if (!swipeStart) return;
    const touch = event.changedTouches[0], dx = touch.clientX - swipeStart.x, dy = touch.clientY - swipeStart.y; swipeStart = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    if (dx < 0) showLife(); else showComposer();
  }, { passive: true });
}

function cacheElements() {
  const ids = [
    'app','pages','draft-indicator','settings-open','reset-draft','life-open','stage-label','stage-options','media-input','media-strip','media-empty','note','note-count','duration-label','duration-options','save','generate-video',
    'life-back','life-new','life-stage-nav','life-timeline',
    'settings-sheet','settings-close','video-provider-options','api-base-url','api-base-paste','gemini-key','gemini-paste','settings-save',
    'detail-modal','detail-stage','detail-time','detail-edit','detail-close','detail-media','detail-polished-tab','detail-raw-tab','detail-story','detail-duration-label','detail-duration-options','detail-generate-video','detail-view-video','detail-delete',
    'video-modal','video-close','video-model-label','video-loading','video-loading-copy','video-player','toast'
  ];
  for (const id of ids) els[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = $(id);
}
function bindEvents() {
  els.note.addEventListener('input', () => { state.rawNote = els.note.value; state.polishedNote = ''; els.noteCount.textContent = String(state.rawNote.length); queueDraft(); });
  els.stageOptions.addEventListener('click', event => { const button = event.target.closest('[data-stage]'); if (button) setLifeStage(button.dataset.stage); });
  els.mediaInput.addEventListener('change', () => addMedia(els.mediaInput.files));
  els.durationOptions.addEventListener('click', event => { const button = event.target.closest('[data-duration]'); if (button) setComposerDuration(button.dataset.duration); });
  els.save.addEventListener('click', saveRecord);
  els.generateVideo.addEventListener('click', () => startGeneration({ type: 'draft', duration: state.videoDuration }));
  els.resetDraft.addEventListener('click', () => resetComposer(true));
  els.lifeOpen.addEventListener('click', showLife); els.lifeBack.addEventListener('click', showComposer); els.lifeNew.addEventListener('click', showComposer);
  els.settingsOpen.addEventListener('click', () => { pendingAction = null; openSettings(); });
  els.settingsClose.addEventListener('click', closeSettings); document.querySelector('[data-close-settings]').addEventListener('click', closeSettings); els.settingsSave.addEventListener('click', saveSettings);
  els.videoProviderOptions.addEventListener('click', event => {
    const button = event.target.closest('[data-provider]'); if (!button) return;
    setProviderButtons(button.dataset.provider); applyProviderDurationRules(button.dataset.provider);
  });
  els.apiBasePaste.addEventListener('click', () => pasteIntoApiField(els.apiBaseUrl, '中継サーバーURL'));
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
  cacheElements(); bindEvents(); buildLifeNav();
  localStorage.removeItem('goblin-moment-openai-api-key');
  localStorage.removeItem('goblin-moment-byteplus-api-key');
  try {
    db = await openDB();
    const saved = await getDraft(); state = normalizeDraft(saved);
    editingRecordId = state.editingRecordId || null;
    if (editingRecordId) editOriginalRecord = await getRecord(editingRecordId);
    if (!stageById(state.lifeStage)) state.lifeStage = 'university';
    els.note.value = state.rawNote || ''; els.noteCount.textContent = String((state.rawNote || '').length);
    setLifeStage(state.lifeStage, false); setComposerDuration(state.videoDuration, false); applyProviderDurationRules(getVideoProvider()); await renderMedia(); refreshEditUI();
    await putDraft(); await renderLifeTimeline();
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  } catch (error) {
    console.error(error); toast('記録データを読み込めませんでした', 5000);
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js?v=14').catch(console.error);
}

window.addEventListener('beforeunload', () => {
  revokeUrls(mediaObjectUrls); revokeUrls(detailObjectUrls); revokeUrls(lifeObjectUrls); if (activeVideoUrl) URL.revokeObjectURL(activeVideoUrl);
});
init();
