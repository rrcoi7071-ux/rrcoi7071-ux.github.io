const MODEL_URLS = {
  neutral: './models/normal.glb',
  positive: './models/positive.glb',
  negative: './models/negative.glb',
};

const EMOJIS = {
  'よく使う': ['✨','❤️','😂','😭','😡','🥹','🔥','💢','💔','🥳','😮‍💨','😵‍💫','🫠','😈','💯','🫶'],
  '顔': ['😀','😃','😄','😁','😆','😂','🤣','😊','🙂','🙃','🥹','🥲','😌','😍','🥰','😘','😋','😛','🤪','🤨','🧐','🤓','😎','🥸','😏','😒','😞','😔','😟','😕','🙁','☹️','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🫣','🤗','🫡','🤔','🫠','🙄','😮‍💨','😵','😵‍💫','🤢','🤮','😴','🥱'],
  '心・気持ち': ['❤️','🩷','🧡','💛','💚','💙','🩵','💜','🤎','🖤','🩶','🤍','💔','❤️‍🔥','❤️‍🩹','💕','💞','💓','💗','💖','💘','💝','💟','❣️','💋','🫶','🤝','🙏','💪','🫂'],
  '勢い': ['🔥','✨','⚡','💥','💢','💯','🎉','🎊','🥳','🏆','👑','⭐','🌟','☀️','🌈','🚀','💨','🌀','❗','‼️','❓','⁉️'],
  '日常': ['☕','🍚','🍜','🍰','🍺','📚','💻','📱','🎧','🎮','💤','🛌','🚃','🚗','✈️','🌙','☔','🌧️','🌸','🌊','🏠','🏫','💼','💸'],
};

const DB_NAME = 'goblin-moment-db';
const DB_VERSION = 2;
const SCHEMA_VERSION = 2;
const MAX_LEVEL = 4;
const MAX_EMOJIS = 120;
const OMNI_MODEL = 'gemini-omni-1.1-flash';
const API_KEY_STORAGE = 'goblin-moment-gemini-api-key';
const els = {};
let db;
let state = freshDraft();
let draftTimer = null;
let currentMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedDate = localDate(new Date());
let detailMomentId = null;
let touchStart = null;
let pendingGeneration = null;
let activeVideoUrl = null;
let generationBusy = false;

function $(id){ return document.getElementById(id); }
function freshDraft(){
  return {
    key:'active',
    schemaVersion:SCHEMA_VERSION,
    note:'',
    goblins:[{id:crypto.randomUUID(), level:0}],
    emojis:[],
    mediaIds:[],
    videoId:null,
    updatedAt:new Date().toISOString(),
  };
}
function localDate(d){ const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; }
function clamp(n,min,max){ return Math.max(min,Math.min(max,n)); }
function moodFromLevel(level){ return level > 0 ? 'positive' : level < 0 ? 'negative' : 'neutral'; }
function averageLevel(goblins){ return goblins?.length ? goblins.reduce((a,g)=>a+(Number(g.level)||0),0)/goblins.length : 0; }
function formatTime(iso){ return new Intl.DateTimeFormat('ja-JP',{hour:'2-digit',minute:'2-digit'}).format(new Date(iso)); }
function formatLongDate(dateStr){ const [y,m,d]=dateStr.split('-').map(Number); return `${y}年${m}月${d}日`; }
function escapeHtml(s=''){ return String(s).replace(/[&<>'"]/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c])); }
function sleep(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }
function toast(msg){ els.toast.textContent=msg; els.toast.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(()=>els.toast.classList.remove('show'),2200); }
function normalizeGoblinList(goblins){
  const source=Array.isArray(goblins)&&goblins.length?goblins:[{id:crypto.randomUUID(),level:0}];
  const first=source[0];
  return [{id:first.id||crypto.randomUUID(),level:clamp(Number(first.level)||0,-MAX_LEVEL,MAX_LEVEL)}];
}
function normalizeDraft(saved){
  const base=freshDraft();
  if(!saved) return base;
  return {
    ...base,
    ...saved,
    schemaVersion:SCHEMA_VERSION,
    goblins:normalizeGoblinList(saved.goblins),
    emojis:Array.isArray(saved.emojis)?saved.emojis.slice(-MAX_EMOJIS):[],
    mediaIds:Array.isArray(saved.mediaIds)?saved.mediaIds:[],
    videoId:saved.videoId||null,
  };
}

function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{
      const d=req.result;
      if(!d.objectStoreNames.contains('moments')){
        const s=d.createObjectStore('moments',{keyPath:'id'});
        s.createIndex('localDate','localDate',{unique:false});
        s.createIndex('createdAt','createdAt',{unique:false});
      }
      if(!d.objectStoreNames.contains('media')) d.createObjectStore('media',{keyPath:'id'});
      if(!d.objectStoreNames.contains('draft')) d.createObjectStore('draft',{keyPath:'key'});
      if(!d.objectStoreNames.contains('videos')) d.createObjectStore('videos',{keyPath:'id'});
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
function idbReq(req){ return new Promise((resolve,reject)=>{ req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error); }); }
async function getDraft(){ return idbReq(db.transaction('draft','readonly').objectStore('draft').get('active')); }
async function putDraft(){ state.updatedAt=new Date().toISOString(); return idbReq(db.transaction('draft','readwrite').objectStore('draft').put(structuredClone(state))); }
async function saveMedia(blob){ const id=crypto.randomUUID(); await idbReq(db.transaction('media','readwrite').objectStore('media').put({id,blob,createdAt:new Date().toISOString()})); return id; }
async function getMedia(id){ return idbReq(db.transaction('media','readonly').objectStore('media').get(id)); }
async function deleteMedia(id){ return idbReq(db.transaction('media','readwrite').objectStore('media').delete(id)); }
async function saveVideo(blob,meta={}){ const id=crypto.randomUUID(); await idbReq(db.transaction('videos','readwrite').objectStore('videos').put({id,blob,createdAt:new Date().toISOString(),...meta})); return id; }
async function getVideo(id){ if(!id)return null; return idbReq(db.transaction('videos','readonly').objectStore('videos').get(id)); }
async function deleteVideo(id){ if(!id)return; return idbReq(db.transaction('videos','readwrite').objectStore('videos').delete(id)); }
async function getAllMoments(){ return idbReq(db.transaction('moments','readonly').objectStore('moments').getAll()); }
async function getMoment(id){ return idbReq(db.transaction('moments','readonly').objectStore('moments').get(id)); }
async function putMoment(moment){ return idbReq(db.transaction('moments','readwrite').objectStore('moments').put(moment)); }
async function getMomentsByDate(date){ return idbReq(db.transaction('moments','readonly').objectStore('moments').index('localDate').getAll(date)); }

function queueDraft(){
  els.draftIndicator.textContent='下書きを保存中…';
  clearTimeout(draftTimer);
  draftTimer=setTimeout(async()=>{
    try{ await putDraft(); els.draftIndicator.textContent='下書き保存済み'; }
    catch(e){ console.error(e); els.draftIndicator.textContent='保存できません'; toast('下書きを保存できませんでした'); }
  },180);
}

function applyTone(){
  const avg=clamp(averageLevel(state.goblins),-4,4);
  let bg,tone='neutral';
  if(avg < 0){
    const t=Math.abs(avg)/4;
    const v=Math.round(243-(205*t));
    bg=`rgb(${v},${v},${Math.max(32,v-2)})`;
    if(t>.52) tone='dark';
  } else if(avg > 0){
    const t=avg/4;
    const v=Math.round(243+(12*t));
    bg=`rgb(${v},${v},${Math.min(255,v+1)})`;
  } else bg='#f3f2ee';
  els.app.style.setProperty('--bg',bg);
  els.app.dataset.tone=tone;
  document.querySelector('meta[name="theme-color"]').setAttribute('content',bg);
}

function ensureGoblinCard(){
  let card=els.goblins.querySelector('.goblin-card');
  if(card) return card;
  card=document.createElement('div');
  card.className='goblin-card';
  const viewer=document.createElement('model-viewer');
  viewer.setAttribute('alt','ゴブリン');
  viewer.setAttribute('loading','eager');
  viewer.setAttribute('reveal','auto');
  viewer.setAttribute('shadow-intensity','0.5');
  viewer.setAttribute('camera-orbit','0deg 83deg 105%');
  viewer.setAttribute('field-of-view','28deg');
  viewer.setAttribute('interaction-prompt','none');
  const upper=document.createElement('button');
  upper.type='button'; upper.className='goblin-hit upper'; upper.setAttribute('aria-label','プラス感情');
  upper.addEventListener('click',e=>{ e.stopPropagation(); changeLevel(+1); });
  const lower=document.createElement('button');
  lower.type='button'; lower.className='goblin-hit lower'; lower.setAttribute('aria-label','マイナス感情');
  lower.addEventListener('click',e=>{ e.stopPropagation(); changeLevel(-1); });
  card.append(viewer,upper,lower);
  els.goblins.replaceChildren(card);
  return card;
}
function renderGoblin(){
  state.goblins=normalizeGoblinList(state.goblins);
  const g=state.goblins[0];
  const card=ensureGoblinCard();
  const viewer=card.querySelector('model-viewer');
  const mood=moodFromLevel(g.level);
  const src=MODEL_URLS[mood];
  if(viewer.getAttribute('src')!==src) viewer.setAttribute('src',src);
  card.dataset.mood=mood;
  applyTone();
}
function changeLevel(delta){
  const g=state.goblins[0];
  if(!g)return;
  const previousMood=moodFromLevel(g.level);
  g.level=clamp(g.level+delta,-MAX_LEVEL,MAX_LEVEL);
  const nextMood=moodFromLevel(g.level);
  if(previousMood!==nextMood) renderGoblin(); else applyTone();
  queueDraft();
}

function renderEmojis(){
  const frag=document.createDocumentFragment();
  state.emojis.slice(-MAX_EMOJIS).forEach(item=>{
    const e=document.createElement('span');
    e.className='floating-emoji';
    e.textContent=item.emoji;
    e.style.left=`${item.x*100}%`;
    e.style.top=`${item.y*100}%`;
    e.style.setProperty('--s',`${item.size}px`);
    e.style.setProperty('--r',`${item.rotation}deg`);
    e.style.animationDelay=`-${item.phase||0}s`;
    frag.append(e);
  });
  els.emojiLayer.replaceChildren(frag);
}
function pushEmoji(emoji,x,y,spread=.02){
  state.emojis.push({
    id:crypto.randomUUID(),
    emoji,
    x:clamp(x+(Math.random()-.5)*spread,.04,.96),
    y:clamp(y+(Math.random()-.5)*spread,.05,.80),
    size:28+Math.random()*20,
    rotation:-22+Math.random()*44,
    phase:Math.random()*2.4,
  });
  if(state.emojis.length>MAX_EMOJIS) state.emojis=state.emojis.slice(-MAX_EMOJIS);
}
function addEmojiAt(clientX,clientY){
  const r=els.emotionStage.getBoundingClientRect();
  const x=clamp((clientX-r.left)/r.width,.04,.96);
  const y=clamp((clientY-r.top)/r.height,.05,.80);
  pushEmoji(els.selectedEmoji.textContent||'✨',x,y,.014);
  renderEmojis();
  queueDraft();
}
function addEmojiBurst(emoji,count=4){
  const centerX=.5+(Math.random()-.5)*.22;
  const centerY=.40+(Math.random()-.5)*.18;
  for(let i=0;i<count;i++) pushEmoji(emoji,centerX,centerY,.34);
  renderEmojis();
  queueDraft();
}
function buildEmojiSheet(){
  els.emojiCategories.innerHTML='';
  Object.entries(EMOJIS).forEach(([name,list])=>{
    const section=document.createElement('section');
    section.className='emoji-category';
    section.innerHTML=`<h3>${name}</h3>`;
    const grid=document.createElement('div'); grid.className='emoji-grid';
    list.forEach(emoji=>{
      const b=document.createElement('button');
      b.type='button'; b.className='emoji-choice'; b.textContent=emoji;
      b.addEventListener('click',()=>{
        els.selectedEmoji.textContent=emoji;
        addEmojiBurst(emoji,4);
        closeEmojiSheet();
        toast(`${emoji} を追加しました`);
      });
      grid.append(b);
    });
    section.append(grid); els.emojiCategories.append(section);
  });
}
function openEmojiSheet(){ els.emojiSheet.classList.add('open'); els.emojiSheet.setAttribute('aria-hidden','false'); }
function closeEmojiSheet(){ els.emojiSheet.classList.remove('open'); els.emojiSheet.setAttribute('aria-hidden','true'); }

async function renderPhotos(){
  els.photoStrip.querySelectorAll('.photo-thumb').forEach(n=>n.remove());
  els.photoEmpty.hidden=state.mediaIds.length>0;
  for(const id of state.mediaIds){
    const media=await getMedia(id); if(!media?.blob) continue;
    const url=URL.createObjectURL(media.blob);
    const wrap=document.createElement('div'); wrap.className='photo-thumb';
    const img=document.createElement('img'); img.src=url; img.alt='選択した写真'; img.onload=()=>URL.revokeObjectURL(url);
    const rm=document.createElement('button'); rm.className='photo-remove'; rm.type='button'; rm.textContent='×';
    rm.addEventListener('click',async()=>{ await deleteMedia(id); state.mediaIds=state.mediaIds.filter(x=>x!==id); await renderPhotos(); queueDraft(); });
    wrap.append(img,rm); els.photoStrip.append(wrap);
  }
}
async function addPhotos(files){
  if(!files?.length) return;
  els.draftIndicator.textContent='写真を保存中…';
  try{
    for(const file of [...files].slice(0,8)){
      if(!file.type.startsWith('image/')) continue;
      const id=await saveMedia(file); state.mediaIds.push(id);
    }
    await renderPhotos(); queueDraft();
  }catch(e){ console.error(e); toast('写真を保存できませんでした'); }
  finally{ els.photoInput.value=''; }
}

async function saveMoment(){
  if(els.save.disabled) return;
  els.save.disabled=true; els.save.textContent='保存中…';
  clearTimeout(draftTimer);
  try{
    await putDraft();
    const now=new Date();
    const moment={
      id:crypto.randomUUID(),
      schemaVersion:SCHEMA_VERSION,
      createdAt:now.toISOString(),
      occurredAt:now.toISOString(),
      localDate:localDate(now),
      note:state.note,
      goblins:normalizeGoblinList(state.goblins).map(g=>({...g})),
      emojis:state.emojis.map(e=>({...e})),
      mediaIds:[...state.mediaIds],
      videoId:state.videoId||null,
    };
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(['moments','draft'],'readwrite');
      tx.objectStore('moments').put(moment);
      tx.objectStore('draft').delete('active');
      tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error||new Error('transaction aborted'));
    });
    state=freshDraft();
    els.memo.value=''; els.memoCount.textContent='0';
    await renderPhotos(); renderGoblin(); renderEmojis(); await putDraft();
    toast('保存しました'); selectedDate=moment.localDate; await renderCalendar();
  }catch(e){ console.error(e); toast('保存できませんでした。入力は残っています'); try{await putDraft();}catch{} }
  finally{ els.save.disabled=false; els.save.textContent='保存'; }
}

async function deleteMoment(id){
  const moment=await getMoment(id); if(!moment) return;
  await new Promise((resolve,reject)=>{
    const stores=['moments','media']; if(db.objectStoreNames.contains('videos'))stores.push('videos');
    const tx=db.transaction(stores,'readwrite');
    tx.objectStore('moments').delete(id);
    for(const mid of moment.mediaIds||[]) tx.objectStore('media').delete(mid);
    if(moment.videoId && stores.includes('videos')) tx.objectStore('videos').delete(moment.videoId);
    tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
  });
  closeDetail(); await renderCalendar(); await renderSelectedDate(); toast('削除しました');
}

function showComposer(){ els.pages.classList.remove('show-calendar'); }
async function showCalendar(){ els.pages.classList.add('show-calendar'); await renderCalendar(); await renderSelectedDate(); }

async function renderCalendar(){
  const all=await getAllMoments(); const grouped=new Map();
  for(const m of all){ if(!grouped.has(m.localDate)) grouped.set(m.localDate,[]); grouped.get(m.localDate).push(m); }
  const y=currentMonth.getFullYear(), mon=currentMonth.getMonth();
  els.monthTitle.textContent=`${y}年 ${mon+1}月`; els.calendar.innerHTML='';
  const first=new Date(y,mon,1), start=new Date(y,mon,1-first.getDay());
  for(let i=0;i<42;i++){
    const d=new Date(start); d.setDate(start.getDate()+i);
    const ds=localDate(d), entries=grouped.get(ds)||[];
    const b=document.createElement('button'); b.type='button'; b.className='calendar-cell';
    if(d.getMonth()!==mon)b.classList.add('other');
    if(ds===localDate(new Date()))b.classList.add('today');
    if(ds===selectedDate)b.classList.add('selected');
    const avg=entries.length?entries.reduce((sum,m)=>sum+averageLevel(m.goblins),0)/entries.length:0;
    b.innerHTML=`<span class="day-num">${d.getDate()}</span>${entries.length?`<span class="count">${entries.length}</span><span class="mood-dot" style="opacity:${.35+Math.min(1,Math.abs(avg)/4)*.5}"></span>`:'<span class="count" style="visibility:hidden">0</span>'}`;
    b.addEventListener('click',async()=>{ selectedDate=ds; if(d.getMonth()!==mon) currentMonth=new Date(d.getFullYear(),d.getMonth(),1); await renderCalendar(); await renderSelectedDate(); });
    els.calendar.append(b);
  }
}
async function renderSelectedDate(){
  els.selectedDateTitle.textContent=formatLongDate(selectedDate);
  const moments=(await getMomentsByDate(selectedDate)).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  els.selectedDateCount.textContent=moments.length?`${moments.length}件`:''; els.momentList.innerHTML='';
  if(!moments.length){ els.momentList.innerHTML='<p class="empty-message">この日はまだ何も残していません。</p>'; return; }
  for(const m of moments){
    const avg=averageLevel(m.goblins), icon=avg>0?'☺':avg<0?'↓':'•';
    const snippet=m.note?.trim() || (m.mediaIds?.length?'写真の記録':'感情の記録');
    const b=document.createElement('button'); b.type='button'; b.className='moment-item';
    b.innerHTML=`<span class="moment-state">${icon}</span><span class="moment-copy"><strong>${formatTime(m.createdAt)}${m.videoId?' · 動画あり':''}</strong><span>${escapeHtml(snippet)}</span></span><span class="moment-arrow">›</span>`;
    b.addEventListener('click',()=>openDetail(m.id)); els.momentList.append(b);
  }
}

async function openDetail(id){
  const m=await getMoment(id); if(!m) return;
  detailMomentId=id;
  els.detailDate.textContent=formatLongDate(m.localDate); els.detailTime.textContent=formatTime(m.createdAt); els.detailNote.textContent=m.note||'';
  const avg=averageLevel(m.goblins); let bg='#f3f2ee';
  if(avg<0){ const t=Math.abs(avg)/4,v=Math.round(243-205*t); bg=`rgb(${v},${v},${Math.max(32,v-2)})`; }
  else if(avg>0){ const v=Math.round(243+12*(avg/4)); bg=`rgb(${v},${v},${Math.min(255,v+1)})`; }
  els.detailStage.style.background=bg;
  els.detailGoblins.innerHTML='';
  const firstGoblin=(m.goblins||[])[0]||{level:0};
  const viewer=document.createElement('model-viewer');
  viewer.setAttribute('src',MODEL_URLS[moodFromLevel(firstGoblin.level)]); viewer.setAttribute('alt','保存されたゴブリン'); viewer.setAttribute('loading','eager'); viewer.setAttribute('shadow-intensity','.45'); viewer.setAttribute('camera-orbit','0deg 83deg 105%'); viewer.setAttribute('field-of-view','28deg'); viewer.setAttribute('interaction-prompt','none');
  els.detailGoblins.append(viewer);
  els.detailEmojis.innerHTML='';
  (m.emojis||[]).forEach(item=>{ const e=document.createElement('span'); e.className='floating-emoji'; e.textContent=item.emoji; e.style.left=`${item.x*100}%`; e.style.top=`${item.y*100}%`; e.style.setProperty('--s',`${item.size}px`); e.style.setProperty('--r',`${item.rotation}deg`); e.style.animationDelay=`-${item.phase||0}s`; els.detailEmojis.append(e); });
  els.detailPhotos.innerHTML='';
  for(const mid of m.mediaIds||[]){ const media=await getMedia(mid); if(media?.blob){ const img=document.createElement('img'); const url=URL.createObjectURL(media.blob); img.src=url; img.onload=()=>URL.revokeObjectURL(url); els.detailPhotos.append(img); } }
  els.detailViewVideo.hidden=!m.videoId;
  els.detailGenerateVideo.textContent=m.videoId?'動画を再生成':'動画生成';
  els.detailModal.classList.add('open'); els.detailModal.setAttribute('aria-hidden','false');
}
function closeDetail(){ els.detailModal.classList.remove('open'); els.detailModal.setAttribute('aria-hidden','true'); detailMomentId=null; els.detailGoblins.innerHTML=''; els.detailPhotos.innerHTML=''; }

function getApiKey(){ return localStorage.getItem(API_KEY_STORAGE)||''; }
function openApiSheet(){
  els.apiKey.value=getApiKey();
  els.apiSheet.classList.add('open'); els.apiSheet.setAttribute('aria-hidden','false');
  setTimeout(()=>els.apiKey.focus(),80);
}
function closeApiSheet(){ els.apiSheet.classList.remove('open'); els.apiSheet.setAttribute('aria-hidden','true'); }
async function pasteApiKey(){
  try{ const text=await navigator.clipboard.readText(); if(text){ els.apiKey.value=text.trim(); toast('貼り付けました'); } }
  catch{ toast('貼り付けできません。入力欄を長押しして貼り付けてください'); }
}
async function saveApiKeyAndContinue(){
  const key=els.apiKey.value.trim();
  if(!key){ toast('APIキーを入力してください'); return; }
  localStorage.setItem(API_KEY_STORAGE,key);
  closeApiSheet();
  toast('APIキーを保存しました');
  if(pendingGeneration){ const job=pendingGeneration; pendingGeneration=null; await startGeneration(job); }
}

function momentHasContent(moment){
  const level=averageLevel(moment.goblins);
  return Boolean(moment.note?.trim() || moment.mediaIds?.length || moment.emojis?.length || level!==0);
}
function buildVideoPrompt(moment){
  const avg=clamp(averageLevel(moment.goblins),-4,4);
  const mood=moodFromLevel(avg);
  const stamps=(moment.emojis||[]).map(e=>e.emoji);
  const counts={}; stamps.forEach(s=>counts[s]=(counts[s]||0)+1);
  const stampText=Object.entries(counts).map(([e,n])=>`${e}×${n}`).join(', ')||'none';
  const note=(moment.note||'').trim()||'(no memo)';
  const dateTime=moment.createdAt||new Date().toISOString();
  return [
    'Create a short vertical video that faithfully traces this personal moment.',
    'Do not force nostalgia, sadness, beauty, catharsis, hope, or a moral lesson. Do not psychoanalyze the user.',
    'Preserve the emotional direction and concrete details actually present in the record. You may invent only minor connective visual details needed to make a coherent scene.',
    'The goblin is only an emotional input proxy and does not need to appear as a goblin in the video.',
    `Recorded time: ${dateTime}`,
    `Emotional proxy: ${mood}, intensity ${avg.toFixed(1)} on a -4 to +4 scale.` ,
    `Stamps used as emotional/semantic cues: ${stampText}. Do not literally overlay emoji unless the record clearly calls for it.`,
    `Memo, possibly written in Japanese: ${note}`,
    `Reference photos supplied: ${(moment.mediaIds||[]).length}. Treat them as direct visual evidence of the recorded moment and preserve their real context as much as possible.`,
    'Output: about 5 seconds, 9:16 portrait, natural cinematic motion, native ambient audio, no captions, no added on-screen text, no narration unless the memo itself clearly implies spoken dialogue.',
    'The result should feel like a trace of the supplied record, not an interpretation imposed on it.'
  ].join('\n');
}
async function blobToBase64(blob){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');
    reader.onerror=()=>reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
async function compressImageForAI(blob){
  try{
    const bitmap=await createImageBitmap(blob);
    const maxSide=1100;
    const scale=Math.min(1,maxSide/Math.max(bitmap.width,bitmap.height));
    const w=Math.max(1,Math.round(bitmap.width*scale)), h=Math.max(1,Math.round(bitmap.height*scale));
    const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h;
    const ctx=canvas.getContext('2d',{alpha:false}); ctx.drawImage(bitmap,0,0,w,h); bitmap.close();
    const out=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.82));
    return out||blob;
  }catch{ return blob; }
}
async function prepareOmniInput(moment){
  const input=[];
  for(const mid of (moment.mediaIds||[]).slice(0,8)){
    const media=await getMedia(mid); if(!media?.blob)continue;
    const compressed=await compressImageForAI(media.blob);
    input.push({type:'image',data:await blobToBase64(compressed),mime_type:compressed.type||'image/jpeg'});
  }
  input.push({type:'text',text:buildVideoPrompt(moment)});
  return input;
}
function extractVideoOutput(payload){
  if(payload?.output_video) return payload.output_video;
  for(const step of payload?.steps||[]){
    for(const content of step?.content||[]){ if(content?.type==='video') return content; }
  }
  return null;
}
function base64ToBlob(base64,mime='video/mp4'){
  const bytes=atob(base64); const arr=new Uint8Array(bytes.length);
  for(let i=0;i<bytes.length;i++) arr[i]=bytes.charCodeAt(i);
  return new Blob([arr],{type:mime});
}
function fileIdFromUri(uri=''){
  const m=uri.match(/files\/([^/:?]+)/); return m?.[1]||null;
}
async function omniGenerateVideo(moment,apiKey){
  const input=await prepareOmniInput(moment);
  const task=(moment.mediaIds||[]).length>1?'reference_to_video':(moment.mediaIds||[]).length===1?'image_to_video':'text_to_video';
  const body={
    model:OMNI_MODEL,
    input,
    response_format:{type:'video',delivery:'uri',aspect_ratio:'9:16'},
    generation_config:{video_config:{task,resolution:'720p'}},
    background:false,
    store:false,
    stream:false,
  };
  const endpoint=`https://generativelanguage.googleapis.com/v1beta/interactions?key=${encodeURIComponent(apiKey)}`;
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const raw=await response.text();
  let payload={}; try{ payload=raw?JSON.parse(raw):{}; }catch{}
  if(!response.ok) throw new Error(payload?.error?.message||`Gemini API ${response.status}`);
  const output=extractVideoOutput(payload);
  if(!output) throw new Error('動画データが返りませんでした');
  if(output.data) return {blob:base64ToBlob(output.data,output.mime_type||'video/mp4'),interactionId:payload.id||null};
  if(!output.uri) throw new Error('動画URIが返りませんでした');
  const fileId=fileIdFromUri(output.uri);
  if(!fileId) throw new Error('動画ファイルIDを取得できませんでした');
  for(let i=0;i<90;i++){
    const statusRes=await fetch(`https://generativelanguage.googleapis.com/v1beta/files/${encodeURIComponent(fileId)}?key=${encodeURIComponent(apiKey)}`);
    if(!statusRes.ok) throw new Error(`動画処理の確認に失敗しました (${statusRes.status})`);
    const info=await statusRes.json();
    const status=typeof info.state==='string'?info.state:info.state?.name;
    if(status==='ACTIVE') break;
    if(status==='FAILED') throw new Error('動画生成に失敗しました');
    if(i===89) throw new Error('動画生成がタイムアウトしました');
    await sleep(3000);
  }
  const dl=await fetch(`https://generativelanguage.googleapis.com/v1beta/files/${encodeURIComponent(fileId)}:download?alt=media&key=${encodeURIComponent(apiKey)}`);
  if(!dl.ok) throw new Error(`動画の取得に失敗しました (${dl.status})`);
  return {blob:await dl.blob(),interactionId:payload.id||null};
}

function openVideoLoading(){
  if(activeVideoUrl){ URL.revokeObjectURL(activeVideoUrl); activeVideoUrl=null; }
  els.videoPlayer.pause(); els.videoPlayer.removeAttribute('src'); els.videoPlayer.hidden=true;
  els.videoLoading.hidden=false;
  els.videoModal.classList.add('open'); els.videoModal.setAttribute('aria-hidden','false');
}
function showVideoBlob(blob){
  if(activeVideoUrl) URL.revokeObjectURL(activeVideoUrl);
  activeVideoUrl=URL.createObjectURL(blob);
  els.videoLoading.hidden=true; els.videoPlayer.hidden=false; els.videoPlayer.src=activeVideoUrl;
  els.videoPlayer.play().catch(()=>{});
}
function closeVideo(){
  els.videoModal.classList.remove('open'); els.videoModal.setAttribute('aria-hidden','true');
  els.videoPlayer.pause();
}
async function viewStoredVideo(videoId){
  const record=await getVideo(videoId);
  if(!record?.blob){ toast('動画が見つかりません'); return; }
  els.videoModal.classList.add('open'); els.videoModal.setAttribute('aria-hidden','false');
  showVideoBlob(record.blob);
}
async function startGeneration(job){
  if(generationBusy){ toast('動画を生成中です'); return; }
  const apiKey=getApiKey();
  if(!apiKey){ pendingGeneration=job; openApiSheet(); return; }
  let moment;
  if(job.type==='draft'){
    moment={...structuredClone(state),createdAt:new Date().toISOString(),localDate:localDate(new Date())};
  }else{
    moment=await getMoment(job.id); if(!moment){ toast('記録が見つかりません'); return; }
  }
  if(!momentHasContent(moment)){ toast('まず写真・メモ・感情・スタンプのどれかを残してください'); return; }
  generationBusy=true;
  els.generateVideo.disabled=true; els.detailGenerateVideo.disabled=true;
  openVideoLoading();
  try{
    const result=await omniGenerateVideo(moment,apiKey);
    const newId=await saveVideo(result.blob,{model:OMNI_MODEL,interactionId:result.interactionId||null});
    if(job.type==='draft'){
      if(state.videoId) await deleteVideo(state.videoId).catch(()=>{});
      state.videoId=newId; queueDraft();
    }else{
      const latest=await getMoment(job.id);
      if(latest){ if(latest.videoId) await deleteVideo(latest.videoId).catch(()=>{}); latest.videoId=newId; latest.videoGeneratedAt=new Date().toISOString(); latest.videoModel=OMNI_MODEL; await putMoment(latest); }
      if(detailMomentId===job.id){ els.detailViewVideo.hidden=false; els.detailGenerateVideo.textContent='動画を再生成'; }
      await renderSelectedDate();
    }
    showVideoBlob(result.blob);
    toast('動画を生成しました');
  }catch(e){
    console.error(e);
    closeVideo();
    const msg=String(e?.message||e);
    if(/API key|API_KEY_INVALID|403|401/i.test(msg)){
      localStorage.removeItem(API_KEY_STORAGE);
      toast('APIキーを確認してください');
      pendingGeneration=job;
      openApiSheet();
    }else toast(msg.length>90?'動画生成に失敗しました':msg);
  }finally{
    generationBusy=false;
    els.generateVideo.disabled=false; els.detailGenerateVideo.disabled=false;
  }
}

function setupSwipe(){
  const start=e=>{ const t=e.changedTouches?.[0]; if(!t)return; if(e.target.closest('textarea,button,label,input,.sheet,.detail-modal,.video-modal'))return; touchStart={x:t.clientX,y:t.clientY}; };
  const end=e=>{ if(!touchStart)return; const t=e.changedTouches?.[0]; if(!t)return; const dx=t.clientX-touchStart.x,dy=t.clientY-touchStart.y; touchStart=null; if(Math.abs(dx)<70||Math.abs(dx)<Math.abs(dy)*1.35)return; if(dx<0&&!els.pages.classList.contains('show-calendar'))showCalendar(); else if(dx>0&&els.pages.classList.contains('show-calendar'))showComposer(); };
  document.addEventListener('touchstart',start,{passive:true}); document.addEventListener('touchend',end,{passive:true});
}
async function requestPersistence(){ try{ if(navigator.storage?.persist){ const already=await navigator.storage.persisted(); if(!already) await navigator.storage.persist(); } }catch(e){ console.warn('persistent storage request failed',e); } }
async function restoreDraft(){
  state=normalizeDraft(await getDraft());
  els.memo.value=state.note||''; els.memoCount.textContent=String((state.note||'').length);
  renderGoblin(); renderEmojis(); await renderPhotos();
}
function idlePrefetchModels(){
  const work=()=>{
    for(const url of [MODEL_URLS.positive,MODEL_URLS.negative]){
      const link=document.createElement('link'); link.rel='prefetch'; link.href=url; link.as='fetch'; document.head.append(link);
    }
  };
  if('requestIdleCallback' in window) requestIdleCallback(work,{timeout:3500}); else setTimeout(work,2500);
}

function bind(){
  els.app=$('app'); els.pages=$('pages'); els.draftIndicator=$('draft-indicator'); els.calendarOpen=$('calendar-open'); els.calendarBack=$('calendar-back'); els.emotionStage=$('emotion-stage'); els.goblins=$('goblins'); els.emojiLayer=$('emoji-layer'); els.emojiPickerOpen=$('emoji-picker-open'); els.selectedEmoji=$('selected-emoji'); els.photoInput=$('photo-input'); els.photoStrip=$('photo-strip'); els.photoEmpty=$('photo-empty'); els.memo=$('memo'); els.memoCount=$('memo-count'); els.save=$('save'); els.generateVideo=$('generate-video');
  els.emojiSheet=$('emoji-sheet'); els.emojiCategories=$('emoji-categories'); els.emojiClose=$('emoji-close');
  els.apiSheet=$('api-sheet'); els.apiKey=$('api-key'); els.apiClose=$('api-close'); els.apiPaste=$('api-paste'); els.apiSave=$('api-save');
  els.monthTitle=$('month-title'); els.monthPrev=$('month-prev'); els.monthNext=$('month-next'); els.today=$('today'); els.calendar=$('calendar'); els.selectedDateTitle=$('selected-date-title'); els.selectedDateCount=$('selected-date-count'); els.momentList=$('moment-list');
  els.detailModal=$('detail-modal'); els.detailDate=$('detail-date'); els.detailTime=$('detail-time'); els.detailStage=$('detail-stage'); els.detailEmojis=$('detail-emojis'); els.detailGoblins=$('detail-goblins'); els.detailPhotos=$('detail-photos'); els.detailNote=$('detail-note'); els.detailClose=$('detail-close'); els.detailDelete=$('detail-delete'); els.detailGenerateVideo=$('detail-generate-video'); els.detailViewVideo=$('detail-view-video');
  els.videoModal=$('video-modal'); els.videoClose=$('video-close'); els.videoLoading=$('video-loading'); els.videoPlayer=$('video-player');
  els.toast=$('toast'); els.modelWarning=$('model-warning');

  els.calendarOpen.addEventListener('click',showCalendar); els.calendarBack.addEventListener('click',showComposer);
  els.emojiPickerOpen.addEventListener('click',openEmojiSheet); els.emojiClose.addEventListener('click',closeEmojiSheet); document.querySelector('[data-close-sheet]').addEventListener('click',closeEmojiSheet);
  els.emotionStage.addEventListener('click',e=>{ if(e.target.closest('.goblin-hit,.stage-tools'))return; addEmojiAt(e.clientX,e.clientY); });
  els.photoInput.addEventListener('change',e=>addPhotos(e.target.files));
  els.memo.addEventListener('input',()=>{ state.note=els.memo.value; els.memoCount.textContent=String(state.note.length); queueDraft(); });
  els.save.addEventListener('click',saveMoment); els.generateVideo.addEventListener('click',()=>startGeneration({type:'draft'}));

  els.apiClose.addEventListener('click',closeApiSheet); document.querySelector('[data-close-api]').addEventListener('click',closeApiSheet); els.apiPaste.addEventListener('click',pasteApiKey); els.apiSave.addEventListener('click',saveApiKeyAndContinue);
  els.apiKey.addEventListener('keydown',e=>{ if(e.key==='Enter')saveApiKeyAndContinue(); });

  els.monthPrev.addEventListener('click',async()=>{ currentMonth=new Date(currentMonth.getFullYear(),currentMonth.getMonth()-1,1); await renderCalendar(); });
  els.monthNext.addEventListener('click',async()=>{ currentMonth=new Date(currentMonth.getFullYear(),currentMonth.getMonth()+1,1); await renderCalendar(); });
  els.today.addEventListener('click',async()=>{ const n=new Date(); currentMonth=new Date(n.getFullYear(),n.getMonth(),1); selectedDate=localDate(n); await renderCalendar(); await renderSelectedDate(); });

  els.detailClose.addEventListener('click',closeDetail); document.querySelector('[data-close-detail]').addEventListener('click',closeDetail);
  els.detailDelete.addEventListener('click',async()=>{ if(!detailMomentId)return; if(confirm('この記録を削除しますか？')) await deleteMoment(detailMomentId); });
  els.detailGenerateVideo.addEventListener('click',()=>{ if(detailMomentId) startGeneration({type:'moment',id:detailMomentId}); });
  els.detailViewVideo.addEventListener('click',async()=>{ if(!detailMomentId)return; const m=await getMoment(detailMomentId); if(m?.videoId) await viewStoredVideo(m.videoId); });

  els.videoClose.addEventListener('click',closeVideo); document.querySelector('[data-close-video]').addEventListener('click',closeVideo);
  setupSwipe(); buildEmojiSheet();
}

async function init(){
  bind();
  try{
    db=await openDB();
    await requestPersistence();
    await restoreDraft();
    await renderCalendar();
    await renderSelectedDate();
    els.draftIndicator.textContent='下書き保存済み';
    idlePrefetchModels();
  }catch(e){ console.error(e); els.draftIndicator.textContent='保存機能エラー'; toast('保存領域を開けませんでした'); }
  if('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(()=>{});
  setTimeout(()=>{ if(!customElements.get('model-viewer')) els.modelWarning.hidden=false; },7000);
}

init();
