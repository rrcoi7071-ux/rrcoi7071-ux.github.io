const MODEL_URLS = {
  neutral: './models/normal.glb',
  positive: './models/positive.glb',
  negative: './models/negative.glb',
};

const REACTIONS = ['❤️','😂','😭','😡','🥹','🔥','💔','✨'];
const ALLOWED_DURATIONS = [5,10,20,30];
const DB_NAME = 'goblin-moment-db';
const DB_VERSION = 2;
const SCHEMA_VERSION = 3;
const MAX_LEVEL = 4;
const OMNI_MODEL = 'gemini-omni-1.1-flash';
const API_KEY_STORAGE = 'goblin-moment-gemini-api-key';
const els = {};

let db;
let state = freshDraft();
let draftTimer = null;
let currentMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedDate = localDate(new Date());
let detailMomentId = null;
let detailVideoDuration = 10;
let editingMomentId = null;
let editOriginalMoment = null;
let touchStart = null;
let pendingGeneration = null;
let activeVideoUrl = null;
let generationBusy = false;
let longPressTimer = null;
let longPressTriggered = false;

function $(id){ return document.getElementById(id); }
function normalizeDuration(value){ const n=Number(value); return ALLOWED_DURATIONS.includes(n)?n:10; }
function freshDraft(){
  return {
    key:'active',
    schemaVersion:SCHEMA_VERSION,
    note:'',
    goblins:[{id:crypto.randomUUID(),level:0}],
    emojis:[],
    mediaIds:[],
    videoId:null,
    videoDuration:10,
    editingMomentId:null,
    updatedAt:new Date().toISOString(),
  };
}
function localDate(d){ const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; }
function clamp(n,min,max){ return Math.max(min,Math.min(max,n)); }
function moodFromLevel(level){ return level>0?'positive':level<0?'negative':'neutral'; }
function averageLevel(goblins){ return goblins?.length?goblins.reduce((a,g)=>a+(Number(g.level)||0),0)/goblins.length:0; }
function formatTime(iso){ return new Intl.DateTimeFormat('ja-JP',{hour:'2-digit',minute:'2-digit'}).format(new Date(iso)); }
function formatLongDate(dateStr){ const [y,m,d]=dateStr.split('-').map(Number); return `${y}年${m}月${d}日`; }
function escapeHtml(s=''){ return String(s).replace(/[&<>'"]/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c])); }
function sleep(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }
function toast(msg){ els.toast.textContent=msg; els.toast.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(()=>els.toast.classList.remove('show'),2400); }
function normalizeGoblinList(goblins){
  const source=Array.isArray(goblins)&&goblins.length?goblins:[{id:crypto.randomUUID(),level:0}];
  const first=source[0];
  return [{id:first.id||crypto.randomUUID(),level:clamp(Number(first.level)||0,-MAX_LEVEL,MAX_LEVEL)}];
}
function normalizeReactionList(emojis){
  if(!Array.isArray(emojis)||!emojis.length) return [];
  const last=emojis[emojis.length-1];
  const emoji=typeof last==='string'?last:last?.emoji;
  return emoji?[{id:last?.id||crypto.randomUUID(),emoji}]:[];
}
function normalizeDraft(saved){
  const base=freshDraft();
  if(!saved) return base;
  return {
    ...base,
    ...saved,
    schemaVersion:SCHEMA_VERSION,
    goblins:normalizeGoblinList(saved.goblins),
    emojis:normalizeReactionList(saved.emojis),
    mediaIds:Array.isArray(saved.mediaIds)?saved.mediaIds:[],
    videoId:saved.videoId||null,
    videoDuration:normalizeDuration(saved.videoDuration),
    editingMomentId:saved.editingMomentId||null,
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
async function deleteDraftRecord(){ return idbReq(db.transaction('draft','readwrite').objectStore('draft').delete('active')); }
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
  els.draftIndicator.textContent=editingMomentId?'編集中・保存中…':'下書きを保存中…';
  clearTimeout(draftTimer);
  draftTimer=setTimeout(async()=>{
    try{
      await putDraft();
      els.draftIndicator.textContent=editingMomentId?'記録を編集中':'下書き保存済み';
    }catch(e){ console.error(e); els.draftIndicator.textContent='保存できません'; toast('下書きを保存できませんでした'); }
  },180);
}

function applyTone(){
  const avg=clamp(averageLevel(state.goblins),-4,4);
  let bg,tone='neutral';
  if(avg<0){
    const t=Math.abs(avg)/4;
    const v=Math.round(243-(205*t));
    bg=`rgb(${v},${v},${Math.max(32,v-2)})`;
    if(t>.52) tone='dark';
  }else if(avg>0){
    const t=avg/4;
    const v=Math.round(243+(12*t));
    bg=`rgb(${v},${v},${Math.min(255,v+1)})`;
  }else bg='#f3f2ee';
  els.app.style.setProperty('--bg',bg);
  els.app.dataset.tone=tone;
  document.querySelector('meta[name="theme-color"]').setAttribute('content',bg);
}

function closeReactionMenu(){ els.reactionMenu.hidden=true; }
function openReactionMenu(){
  longPressTriggered=true;
  els.reactionMenu.hidden=false;
  if(navigator.vibrate) navigator.vibrate(18);
}
function selectReaction(emoji){
  state.emojis=[{id:crypto.randomUUID(),emoji}];
  renderGoblinReaction();
  closeReactionMenu();
  queueDraft();
}
function buildReactionMenu(){
  els.reactionMenu.innerHTML='';
  for(const emoji of REACTIONS){
    const b=document.createElement('button');
    b.type='button'; b.className='reaction-choice'; b.textContent=emoji;
    b.addEventListener('click',e=>{ e.stopPropagation(); selectReaction(emoji); });
    els.reactionMenu.append(b);
  }
  const remove=document.createElement('button');
  remove.type='button'; remove.className='reaction-choice reaction-remove'; remove.textContent='×'; remove.setAttribute('aria-label','スタンプを外す');
  remove.addEventListener('click',e=>{ e.stopPropagation(); state.emojis=[]; renderGoblinReaction(); closeReactionMenu(); queueDraft(); });
  els.reactionMenu.append(remove);
}
function renderGoblinReaction(){
  const card=els.goblins.querySelector('.goblin-card');
  if(!card)return;
  card.querySelector('.goblin-reaction')?.remove();
  const emoji=state.emojis?.[0]?.emoji;
  if(!emoji)return;
  const badge=document.createElement('span');
  badge.className='goblin-reaction'; badge.textContent=emoji;
  card.append(badge);
}
function bindGoblinPress(button,delta){
  const cancel=()=>{ clearTimeout(longPressTimer); longPressTimer=null; };
  button.addEventListener('pointerdown',e=>{
    if(e.pointerType==='mouse'&&e.button!==0)return;
    longPressTriggered=false;
    cancel();
    longPressTimer=setTimeout(()=>openReactionMenu(),520);
  });
  button.addEventListener('pointerup',cancel);
  button.addEventListener('pointercancel',cancel);
  button.addEventListener('pointerleave',cancel);
  button.addEventListener('contextmenu',e=>e.preventDefault());
  button.addEventListener('click',e=>{
    e.stopPropagation();
    if(longPressTriggered){ longPressTriggered=false; return; }
    closeReactionMenu();
    changeLevel(delta);
  });
}
function ensureGoblinCard(){
  let card=els.goblins.querySelector('.goblin-card');
  if(card)return card;
  card=document.createElement('div'); card.className='goblin-card';
  const viewer=document.createElement('model-viewer');
  viewer.setAttribute('alt','ゴブリン'); viewer.setAttribute('loading','eager'); viewer.setAttribute('reveal','auto'); viewer.setAttribute('shadow-intensity','0.5'); viewer.setAttribute('camera-orbit','0deg 83deg 105%'); viewer.setAttribute('field-of-view','28deg'); viewer.setAttribute('interaction-prompt','none');
  const upper=document.createElement('button'); upper.type='button'; upper.className='goblin-hit upper'; upper.setAttribute('aria-label','プラス感情');
  const lower=document.createElement('button'); lower.type='button'; lower.className='goblin-hit lower'; lower.setAttribute('aria-label','マイナス感情');
  bindGoblinPress(upper,+1); bindGoblinPress(lower,-1);
  card.append(viewer,upper,lower); els.goblins.replaceChildren(card);
  return card;
}
function renderGoblin(){
  state.goblins=normalizeGoblinList(state.goblins);
  const g=state.goblins[0];
  const card=ensureGoblinCard();
  const viewer=card.querySelector('model-viewer');
  const mood=moodFromLevel(g.level); const src=MODEL_URLS[mood];
  if(viewer.getAttribute('src')!==src) viewer.setAttribute('src',src);
  card.dataset.mood=mood;
  renderGoblinReaction();
  applyTone();
}
function changeLevel(delta){
  const g=state.goblins[0]; if(!g)return;
  const previousMood=moodFromLevel(g.level);
  g.level=clamp(g.level+delta,-MAX_LEVEL,MAX_LEVEL);
  const nextMood=moodFromLevel(g.level);
  if(previousMood!==nextMood) renderGoblin(); else applyTone();
  queueDraft();
}

async function renderMedia(){
  els.photoStrip.querySelectorAll('.photo-thumb').forEach(n=>n.remove());
  els.photoEmpty.hidden=state.mediaIds.length>0;
  for(const id of state.mediaIds){
    const media=await getMedia(id); if(!media?.blob)continue;
    const url=URL.createObjectURL(media.blob);
    const wrap=document.createElement('div'); wrap.className='photo-thumb';
    let node;
    if(media.blob.type.startsWith('video/')){
      node=document.createElement('video'); node.src=url; node.muted=true; node.playsInline=true; node.preload='metadata'; node.addEventListener('loadedmetadata',()=>URL.revokeObjectURL(url),{once:true});
      const mark=document.createElement('span'); mark.className='media-kind'; mark.textContent='▶'; wrap.append(mark);
    }else{
      node=document.createElement('img'); node.src=url; node.alt='選択した写真'; node.onload=()=>URL.revokeObjectURL(url);
    }
    const rm=document.createElement('button'); rm.className='photo-remove'; rm.type='button'; rm.textContent='×';
    rm.addEventListener('click',()=>removeMediaFromState(id));
    wrap.prepend(node); wrap.append(rm); els.photoStrip.append(wrap);
  }
}
async function removeMediaFromState(id){
  const originalIds=editOriginalMoment?.mediaIds||[];
  const belongsToOriginal=Boolean(editingMomentId&&originalIds.includes(id));
  state.mediaIds=state.mediaIds.filter(x=>x!==id);
  if(!belongsToOriginal) await deleteMedia(id).catch(()=>{});
  await renderMedia(); queueDraft();
}
async function addMedia(files){
  if(!files?.length)return;
  els.draftIndicator.textContent='メディアを保存中…';
  try{
    const remaining=Math.max(0,8-state.mediaIds.length);
    for(const file of [...files].slice(0,remaining)){
      if(!file.type.startsWith('image/')&&!file.type.startsWith('video/'))continue;
      const id=await saveMedia(file); state.mediaIds.push(id);
    }
    await renderMedia(); queueDraft();
    if(files.length>remaining) toast('写真・動画は合計8個までです');
  }catch(e){ console.error(e); toast('写真・動画を保存できませんでした'); }
  finally{ els.photoInput.value=''; }
}

function refreshEditUI(){
  els.save.textContent=editingMomentId?'変更を保存':'保存';
  els.resetDraft.textContent=editingMomentId?'編集をやめる':'リセット';
  els.draftIndicator.textContent=editingMomentId?'記録を編集中':'下書き保存済み';
}
async function cleanDiscardedEditingAssets(){
  if(!editingMomentId||!editOriginalMoment)return;
  const originalMedia=new Set(editOriginalMoment.mediaIds||[]);
  for(const id of state.mediaIds||[]){ if(!originalMedia.has(id)) await deleteMedia(id).catch(()=>{}); }
  if(state.videoId&&state.videoId!==editOriginalMoment.videoId) await deleteVideo(state.videoId).catch(()=>{});
}
async function resetComposer(ask=true){
  const hasSomething=momentHasContent(state)||Boolean(state.videoId)||Boolean(editingMomentId);
  if(ask&&hasSomething&&!confirm(editingMomentId?'編集内容を破棄して編集をやめますか？':'今の入力をすべてリセットしますか？'))return;
  clearTimeout(draftTimer);
  if(editingMomentId){
    await cleanDiscardedEditingAssets();
  }else{
    for(const id of state.mediaIds||[]) await deleteMedia(id).catch(()=>{});
    if(state.videoId) await deleteVideo(state.videoId).catch(()=>{});
  }
  editingMomentId=null; editOriginalMoment=null;
  state=freshDraft();
  await deleteDraftRecord().catch(()=>{}); await putDraft();
  els.memo.value=''; els.memoCount.textContent='0';
  setComposerDuration(10,false);
  closeReactionMenu();
  renderGoblin(); await renderMedia(); refreshEditUI();
  toast('リセットしました');
}
async function beginEditMoment(id){
  const m=await getMoment(id); if(!m)return;
  if(!editingMomentId&&momentHasContent(state)){
    if(!confirm('現在の入力を破棄して、この記録を編集しますか？'))return;
    for(const mid of state.mediaIds||[]) await deleteMedia(mid).catch(()=>{});
    if(state.videoId) await deleteVideo(state.videoId).catch(()=>{});
  }
  editingMomentId=id; editOriginalMoment=structuredClone(m);
  state=normalizeDraft({...m,key:'active',editingMomentId:id,videoDuration:normalizeDuration(m.videoDuration)});
  await putDraft();
  els.memo.value=state.note||''; els.memoCount.textContent=String((state.note||'').length);
  setComposerDuration(state.videoDuration,false);
  renderGoblin(); await renderMedia(); refreshEditUI(); closeDetail(); showComposer();
  toast('編集できます');
}
async function saveMoment(){
  if(els.save.disabled)return;
  els.save.disabled=true; els.save.textContent='保存中…'; clearTimeout(draftTimer);
  try{
    await putDraft();
    if(editingMomentId){
      const original=await getMoment(editingMomentId)||editOriginalMoment;
      if(!original)throw new Error('編集元の記録が見つかりません');
      const updated={
        ...original,
        schemaVersion:SCHEMA_VERSION,
        note:state.note,
        goblins:normalizeGoblinList(state.goblins).map(g=>({...g})),
        emojis:normalizeReactionList(state.emojis),
        mediaIds:[...state.mediaIds],
        videoId:state.videoId||null,
        videoDuration:normalizeDuration(state.videoDuration),
        editedAt:new Date().toISOString(),
      };
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(['moments','draft'],'readwrite');
        tx.objectStore('moments').put(updated); tx.objectStore('draft').delete('active');
        tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error||new Error('transaction aborted'));
      });
      const kept=new Set(updated.mediaIds);
      for(const oldId of original.mediaIds||[]){ if(!kept.has(oldId)) await deleteMedia(oldId).catch(()=>{}); }
      if(original.videoId&&original.videoId!==updated.videoId) await deleteVideo(original.videoId).catch(()=>{});
      selectedDate=updated.localDate;
      editingMomentId=null; editOriginalMoment=null;
      toast('変更を保存しました');
    }else{
      const now=new Date();
      const moment={
        id:crypto.randomUUID(), schemaVersion:SCHEMA_VERSION, createdAt:now.toISOString(), occurredAt:now.toISOString(), localDate:localDate(now),
        note:state.note, goblins:normalizeGoblinList(state.goblins).map(g=>({...g})), emojis:normalizeReactionList(state.emojis), mediaIds:[...state.mediaIds], videoId:state.videoId||null, videoDuration:normalizeDuration(state.videoDuration),
      };
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(['moments','draft'],'readwrite');
        tx.objectStore('moments').put(moment); tx.objectStore('draft').delete('active');
        tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error||new Error('transaction aborted'));
      });
      selectedDate=moment.localDate; toast('保存しました');
    }
    state=freshDraft(); await putDraft();
    els.memo.value=''; els.memoCount.textContent='0'; setComposerDuration(10,false);
    renderGoblin(); await renderMedia(); refreshEditUI(); await renderCalendar(); await renderSelectedDate();
  }catch(e){ console.error(e); toast(e?.message||'保存できませんでした。入力は残っています'); try{await putDraft();}catch{} }
  finally{ els.save.disabled=false; refreshEditUI(); }
}

async function deleteMoment(id){
  const moment=await getMoment(id); if(!moment)return;
  await new Promise((resolve,reject)=>{
    const stores=['moments','media']; if(db.objectStoreNames.contains('videos'))stores.push('videos');
    const tx=db.transaction(stores,'readwrite');
    tx.objectStore('moments').delete(id);
    for(const mid of moment.mediaIds||[])tx.objectStore('media').delete(mid);
    if(moment.videoId&&stores.includes('videos'))tx.objectStore('videos').delete(moment.videoId);
    tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
  });
  closeDetail(); await renderCalendar(); await renderSelectedDate(); toast('削除しました');
}

function showComposer(){ els.pages.classList.remove('show-calendar'); }
async function showCalendar(){ els.pages.classList.add('show-calendar'); await renderCalendar(); await renderSelectedDate(); }
async function renderCalendar(){
  const all=await getAllMoments(); const grouped=new Map();
  for(const m of all){ if(!grouped.has(m.localDate))grouped.set(m.localDate,[]); grouped.get(m.localDate).push(m); }
  const y=currentMonth.getFullYear(),mon=currentMonth.getMonth();
  els.monthTitle.textContent=`${y}年 ${mon+1}月`; els.calendar.innerHTML='';
  const first=new Date(y,mon,1),start=new Date(y,mon,1-first.getDay());
  for(let i=0;i<42;i++){
    const d=new Date(start); d.setDate(start.getDate()+i);
    const ds=localDate(d),entries=grouped.get(ds)||[];
    const b=document.createElement('button'); b.type='button'; b.className='calendar-cell';
    if(d.getMonth()!==mon)b.classList.add('other'); if(ds===localDate(new Date()))b.classList.add('today'); if(ds===selectedDate)b.classList.add('selected');
    const avg=entries.length?entries.reduce((sum,m)=>sum+averageLevel(m.goblins),0)/entries.length:0;
    b.innerHTML=`<span class="day-num">${d.getDate()}</span>${entries.length?`<span class="count">${entries.length}</span><span class="mood-dot" style="opacity:${.35+Math.min(1,Math.abs(avg)/4)*.5}"></span>`:'<span class="count" style="visibility:hidden">0</span>'}`;
    b.addEventListener('click',async()=>{ selectedDate=ds; if(d.getMonth()!==mon)currentMonth=new Date(d.getFullYear(),d.getMonth(),1); await renderCalendar(); await renderSelectedDate(); });
    els.calendar.append(b);
  }
}
async function renderSelectedDate(){
  els.selectedDateTitle.textContent=formatLongDate(selectedDate);
  const moments=(await getMomentsByDate(selectedDate)).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  els.selectedDateCount.textContent=moments.length?`${moments.length}件`:''; els.momentList.innerHTML='';
  if(!moments.length){ els.momentList.innerHTML='<p class="empty-message">この日はまだ何も残していません。</p>'; return; }
  for(const m of moments){
    const avg=averageLevel(m.goblins),icon=avg>0?'☺':avg<0?'↓':'•';
    const snippet=m.note?.trim()||(m.mediaIds?.length?'写真・動画の記録':'感情の記録');
    const b=document.createElement('button'); b.type='button'; b.className='moment-item';
    b.innerHTML=`<span class="moment-state">${icon}</span><span class="moment-copy"><strong>${formatTime(m.createdAt)}${m.videoId?' · 生成動画あり':''}</strong><span>${escapeHtml(snippet)}</span></span><span class="moment-arrow">›</span>`;
    b.addEventListener('click',()=>openDetail(m.id)); els.momentList.append(b);
  }
}

function renderDetailReaction(container,emojis){
  container.querySelector('.goblin-reaction')?.remove();
  const emoji=normalizeReactionList(emojis)?.[0]?.emoji; if(!emoji)return;
  const badge=document.createElement('span'); badge.className='goblin-reaction detail-reaction'; badge.textContent=emoji; container.append(badge);
}
async function openDetail(id){
  const m=await getMoment(id); if(!m)return;
  detailMomentId=id;
  els.detailDate.textContent=formatLongDate(m.localDate); els.detailTime.textContent=formatTime(m.createdAt)+(m.editedAt?' · 編集済み':''); els.detailNote.textContent=m.note||'';
  const avg=averageLevel(m.goblins); let bg='#f3f2ee';
  if(avg<0){ const t=Math.abs(avg)/4,v=Math.round(243-205*t); bg=`rgb(${v},${v},${Math.max(32,v-2)})`; }
  else if(avg>0){ const v=Math.round(243+12*(avg/4)); bg=`rgb(${v},${v},${Math.min(255,v+1)})`; }
  els.detailStage.style.background=bg; els.detailGoblins.innerHTML='';
  const firstGoblin=(m.goblins||[])[0]||{level:0};
  const viewer=document.createElement('model-viewer');
  viewer.setAttribute('src',MODEL_URLS[moodFromLevel(firstGoblin.level)]); viewer.setAttribute('alt','保存されたゴブリン'); viewer.setAttribute('loading','eager'); viewer.setAttribute('shadow-intensity','.45'); viewer.setAttribute('camera-orbit','0deg 83deg 105%'); viewer.setAttribute('field-of-view','28deg'); viewer.setAttribute('interaction-prompt','none');
  els.detailGoblins.append(viewer); renderDetailReaction(els.detailGoblins,m.emojis);
  els.detailPhotos.innerHTML='';
  for(const mid of m.mediaIds||[]){
    const media=await getMedia(mid); if(!media?.blob)continue;
    const url=URL.createObjectURL(media.blob);
    if(media.blob.type.startsWith('video/')){
      const video=document.createElement('video'); video.src=url; video.controls=true; video.playsInline=true; video.preload='metadata'; video.addEventListener('loadedmetadata',()=>URL.revokeObjectURL(url),{once:true}); els.detailPhotos.append(video);
    }else{
      const img=document.createElement('img'); img.src=url; img.onload=()=>URL.revokeObjectURL(url); els.detailPhotos.append(img);
    }
  }
  els.detailViewVideo.hidden=!m.videoId; els.detailGenerateVideo.textContent=m.videoId?'動画を再生成':'動画生成';
  setDetailDuration(normalizeDuration(m.videoDuration),false);
  els.detailModal.classList.add('open'); els.detailModal.setAttribute('aria-hidden','false');
}
function closeDetail(){
  els.detailModal.classList.remove('open'); els.detailModal.setAttribute('aria-hidden','true'); detailMomentId=null;
  els.detailGoblins.innerHTML='';
  els.detailPhotos.querySelectorAll('video').forEach(v=>v.pause()); els.detailPhotos.innerHTML='';
}

function setComposerDuration(duration,save=true){
  duration=normalizeDuration(duration); state.videoDuration=duration; els.durationLabel.textContent=`${duration}秒`;
  els.durationOptions.querySelectorAll('[data-duration]').forEach(b=>b.classList.toggle('selected',Number(b.dataset.duration)===duration));
  if(save)queueDraft();
}
function setDetailDuration(duration){
  detailVideoDuration=normalizeDuration(duration); els.detailDurationLabel.textContent=`${detailVideoDuration}秒`;
  els.detailDurationOptions.querySelectorAll('[data-duration]').forEach(b=>b.classList.toggle('selected',Number(b.dataset.duration)===detailVideoDuration));
}

function getApiKey(){ return localStorage.getItem(API_KEY_STORAGE)||''; }
function openApiSheet(){ els.apiKey.value=getApiKey(); els.apiSheet.classList.add('open'); els.apiSheet.setAttribute('aria-hidden','false'); setTimeout(()=>els.apiKey.focus(),80); }
function closeApiSheet(){ els.apiSheet.classList.remove('open'); els.apiSheet.setAttribute('aria-hidden','true'); }
async function pasteApiKey(){
  try{ const text=await navigator.clipboard.readText(); if(text){ els.apiKey.value=text.trim(); toast('貼り付けました'); } }
  catch{ toast('貼り付けできません。入力欄を長押しして貼り付けてください'); }
}
async function saveApiKeyAndContinue(){
  const key=els.apiKey.value.trim(); if(!key){ toast('APIキーを入力してください'); return; }
  localStorage.setItem(API_KEY_STORAGE,key); closeApiSheet(); toast('APIキーを保存しました');
  if(pendingGeneration){ const job=pendingGeneration; pendingGeneration=null; await startGeneration(job); }
}

function momentHasContent(moment){
  const level=averageLevel(moment.goblins);
  return Boolean(moment.note?.trim()||moment.mediaIds?.length||moment.emojis?.length||level!==0);
}
async function mediaSummary(moment){
  let images=0,videos=0;
  for(const mid of moment.mediaIds||[]){ const m=await getMedia(mid); if(m?.blob?.type?.startsWith('video/'))videos++; else if(m?.blob?.type?.startsWith('image/'))images++; }
  return {images,videos};
}
async function buildVideoPrompt(moment,segmentDuration,totalDuration){
  const avg=clamp(averageLevel(moment.goblins),-4,4); const mood=moodFromLevel(avg);
  const stamp=normalizeReactionList(moment.emojis)?.[0]?.emoji||'none';
  const note=(moment.note||'').trim()||'(no memo)'; const dateTime=moment.createdAt||new Date().toISOString(); const media=await mediaSummary(moment);
  const continuation=totalDuration>segmentDuration?`This is the opening ${segmentDuration} seconds of a ${totalDuration}-second final video. Use the timeline [0-${segmentDuration}s] and end this segment in a way that can continue naturally.`:`The final output should be about ${segmentDuration} seconds long. Use the timeline [0-${segmentDuration}s] and end at approximately ${segmentDuration}s.`;
  return [
    'Create a vertical video that faithfully traces this personal moment.',
    'Do not force nostalgia, sadness, beauty, catharsis, hope, or a moral lesson. Do not psychoanalyze the user.',
    'Preserve the emotional direction and concrete details actually present in the record. Invent only minor connective visual details needed for coherence.',
    'The goblin is only an emotional input proxy and does not need to appear as a goblin in the video.',
    `Recorded time: ${dateTime}`,
    `Emotional proxy: ${mood}, intensity ${avg.toFixed(1)} on a -4 to +4 scale.`,
    `Single reaction stamp: ${stamp}. Treat it as an emotional/semantic cue; do not literally overlay emoji unless the record clearly calls for it.`,
    `Memo, possibly written in Japanese: ${note}`,
    `Reference media supplied: ${media.images} image(s), ${media.videos} video(s). Treat them as direct evidence of the recorded moment and preserve their real context as much as possible.`,
    continuation,
    `Output: 9:16 portrait, natural cinematic motion, native ambient audio, no captions, no added on-screen text, no narration unless the record itself clearly implies spoken dialogue.`,
    'The result should feel like a trace of the supplied record, not an interpretation imposed on it.'
  ].join('\n');
}
async function blobToBase64(blob){
  return new Promise((resolve,reject)=>{ const reader=new FileReader(); reader.onload=()=>resolve(String(reader.result).split(',')[1]||''); reader.onerror=()=>reject(reader.error); reader.readAsDataURL(blob); });
}
async function compressImageForAI(blob){
  try{
    const bitmap=await createImageBitmap(blob); const maxSide=1100; const scale=Math.min(1,maxSide/Math.max(bitmap.width,bitmap.height));
    const w=Math.max(1,Math.round(bitmap.width*scale)),h=Math.max(1,Math.round(bitmap.height*scale));
    const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h; const ctx=canvas.getContext('2d',{alpha:false}); ctx.drawImage(bitmap,0,0,w,h); bitmap.close();
    const out=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.82)); return out||blob;
  }catch{return blob;}
}
async function prepareOmniInput(moment,prompt){
  const parts=[]; let videoAdded=false;
  for(const mid of (moment.mediaIds||[]).slice(0,8)){
    const media=await getMedia(mid); if(!media?.blob)continue;
    if(media.blob.type.startsWith('video/')){
      if(videoAdded)continue;
      videoAdded=true;
      if(media.blob.size>28*1024*1024) throw new Error('動画が大きすぎます。短い動画で試してください');
      parts.push({type:'video',data:await blobToBase64(media.blob),mime_type:media.blob.type||'video/mp4'});
    }else if(media.blob.type.startsWith('image/')){
      const compressed=await compressImageForAI(media.blob);
      parts.push({type:'image',data:await blobToBase64(compressed),mime_type:compressed.type||'image/jpeg'});
    }
  }
  parts.push({type:'text',text:prompt});
  return videoAdded?[{type:'user_input',content:parts}]:parts;
}
function extractVideoOutput(payload){
  if(payload?.output_video)return payload.output_video;
  for(const step of payload?.steps||[]){ for(const content of step?.content||[]){ if(content?.type==='video')return content; } }
  return null;
}
function base64ToBlob(base64,mime='video/mp4'){
  const bytes=atob(base64); const arr=new Uint8Array(bytes.length); for(let i=0;i<bytes.length;i++)arr[i]=bytes.charCodeAt(i); return new Blob([arr],{type:mime});
}
function fileIdFromUri(uri=''){ const m=uri.match(/files\/([^/:?]+)/); return m?.[1]||null; }
async function createOmniInteraction(body,apiKey){
  const endpoint=`https://generativelanguage.googleapis.com/v1beta/interactions?key=${encodeURIComponent(apiKey)}`;
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const raw=await response.text(); let payload={}; try{payload=raw?JSON.parse(raw):{};}catch{}
  if(!response.ok)throw new Error(payload?.error?.message||`Gemini API ${response.status}`);
  return payload;
}
async function resolveVideoOutput(payload,apiKey){
  const output=extractVideoOutput(payload); if(!output)throw new Error('動画データが返りませんでした');
  if(output.data)return base64ToBlob(output.data,output.mime_type||'video/mp4');
  if(!output.uri)throw new Error('動画URIが返りませんでした');
  const fileId=fileIdFromUri(output.uri); if(!fileId)throw new Error('動画ファイルIDを取得できませんでした');
  for(let i=0;i<120;i++){
    const statusRes=await fetch(`https://generativelanguage.googleapis.com/v1beta/files/${encodeURIComponent(fileId)}?key=${encodeURIComponent(apiKey)}`);
    if(!statusRes.ok)throw new Error(`動画処理の確認に失敗しました (${statusRes.status})`);
    const info=await statusRes.json(); const status=typeof info.state==='string'?info.state:info.state?.name;
    if(status==='ACTIVE')break; if(status==='FAILED')throw new Error('動画生成に失敗しました'); if(i===119)throw new Error('動画生成がタイムアウトしました'); await sleep(3000);
  }
  const dl=await fetch(`https://generativelanguage.googleapis.com/v1beta/files/${encodeURIComponent(fileId)}:download?alt=media&key=${encodeURIComponent(apiKey)}`);
  if(!dl.ok)throw new Error(`動画の取得に失敗しました (${dl.status})`); return dl.blob();
}
async function omniGenerateVideo(moment,apiKey,duration){
  duration=normalizeDuration(duration);
  const firstDuration=Math.min(duration,10);
  const prompt=await buildVideoPrompt(moment,firstDuration,duration);
  const input=await prepareOmniInput(moment,prompt);
  const summary=await mediaSummary(moment);
  const task=summary.videos>0||summary.images>1?'reference_to_video':summary.images===1?'image_to_video':'text_to_video';
  const needsExtension=duration>10;
  let payload=await createOmniInteraction({
    model:OMNI_MODEL,
    input,
    response_format:{type:'video',delivery:'uri',aspect_ratio:'9:16',resolution:'720p'},
    generation_config:{video_config:{task}},
    background:false,
    store:true,
    stream:false,
  },apiKey);
  let blob=await resolveVideoOutput(payload,apiKey);
  let interactionId=payload.id||null;
  if(needsExtension&&!interactionId)throw new Error('長尺動画の延長IDを取得できませんでした');

  const extensionCount=Math.ceil((duration-firstDuration)/10);
  for(let i=0;i<extensionCount;i++){
    const currentTotal=firstDuration+(i+1)*10;
    const finalStep=i===extensionCount-1;
    els.videoLoadingCopy.textContent=`${duration}秒動画を生成中… ${currentTotal}秒までつないでいます。`;
    try{
      payload=await createOmniInteraction({
        model:OMNI_MODEL,
        previous_interaction_id:interactionId,
        input:`Extend this video by 10 seconds. Continue the same personal moment naturally and faithfully. Keep visual, motion, emotional, and audio continuity. Do not add a moral, nostalgia, or extra narrative. The resulting total length should be about ${currentTotal} seconds.`,
        response_format:{type:'video',delivery:'uri',aspect_ratio:'9:16',resolution:'720p'},
        generation_config:{video_config:{task:'extend'}},
        background:false,
        store:true,
        stream:false,
      },apiKey);
    }catch(e){
      throw new Error(`20秒・30秒の延長生成に失敗しました: ${e?.message||e}`);
    }
    blob=await resolveVideoOutput(payload,apiKey);
    interactionId=payload.id||interactionId;
  }
  return {blob,interactionId};
}

function openVideoLoading(duration=10){
  if(activeVideoUrl){ URL.revokeObjectURL(activeVideoUrl); activeVideoUrl=null; }
  els.videoPlayer.pause(); els.videoPlayer.removeAttribute('src'); els.videoPlayer.hidden=true;
  els.videoLoading.hidden=false; els.videoLoadingCopy.textContent=duration>10?`${duration}秒動画を生成中… 10秒ずつ自然につないでいます。`:`${duration}秒動画を生成中… 入力した記録をまとめています。`;
  els.videoModal.classList.add('open'); els.videoModal.setAttribute('aria-hidden','false');
}
function showVideoBlob(blob){
  if(activeVideoUrl)URL.revokeObjectURL(activeVideoUrl); activeVideoUrl=URL.createObjectURL(blob);
  els.videoLoading.hidden=true; els.videoPlayer.hidden=false; els.videoPlayer.src=activeVideoUrl; els.videoPlayer.play().catch(()=>{});
}
function closeVideo(){ els.videoModal.classList.remove('open'); els.videoModal.setAttribute('aria-hidden','true'); els.videoPlayer.pause(); }
async function viewStoredVideo(videoId){
  const record=await getVideo(videoId); if(!record?.blob){ toast('動画が見つかりません'); return; }
  els.videoModal.classList.add('open'); els.videoModal.setAttribute('aria-hidden','false'); showVideoBlob(record.blob);
}
async function startGeneration(job){
  if(generationBusy){ toast('動画を生成中です'); return; }
  const apiKey=getApiKey(); if(!apiKey){ pendingGeneration=job; openApiSheet(); return; }
  let moment;
  if(job.type==='draft') moment={...structuredClone(state),createdAt:new Date().toISOString(),localDate:localDate(new Date())};
  else{ moment=await getMoment(job.id); if(!moment){ toast('記録が見つかりません'); return; } }
  if(!momentHasContent(moment)){ toast('まず写真・動画・メモ・感情・スタンプのどれかを残してください'); return; }
  const duration=normalizeDuration(job.duration||moment.videoDuration||10);
  generationBusy=true; els.generateVideo.disabled=true; els.detailGenerateVideo.disabled=true; openVideoLoading(duration);
  try{
    const result=await omniGenerateVideo(moment,apiKey,duration);
    const newId=await saveVideo(result.blob,{model:OMNI_MODEL,interactionId:result.interactionId||null,duration});
    if(job.type==='draft'){
      const oldId=state.videoId;
      const originalVideoId=editOriginalMoment?.videoId||null;
      if(oldId&&oldId!==originalVideoId)await deleteVideo(oldId).catch(()=>{});
      state.videoId=newId; state.videoDuration=duration; setComposerDuration(duration,false); queueDraft();
    }else{
      const latest=await getMoment(job.id);
      if(latest){ if(latest.videoId)await deleteVideo(latest.videoId).catch(()=>{}); latest.videoId=newId; latest.videoDuration=duration; latest.videoGeneratedAt=new Date().toISOString(); latest.videoModel=OMNI_MODEL; await putMoment(latest); }
      if(detailMomentId===job.id){ els.detailViewVideo.hidden=false; els.detailGenerateVideo.textContent='動画を再生成'; setDetailDuration(duration); }
      await renderSelectedDate();
    }
    showVideoBlob(result.blob); toast(`${duration}秒動画を生成しました`);
  }catch(e){
    console.error(e); closeVideo(); const msg=String(e?.message||e);
    if(/API key|API_KEY_INVALID|403|401/i.test(msg)){ localStorage.removeItem(API_KEY_STORAGE); toast('APIキーを確認してください'); pendingGeneration=job; openApiSheet(); }
    else toast(msg.length>110?'動画生成に失敗しました':msg);
  }finally{ generationBusy=false; els.generateVideo.disabled=false; els.detailGenerateVideo.disabled=false; }
}

function setupSwipe(){
  const isBlockedTarget=target=>{
    // Goblin hit areas are buttons, but swiping across the goblin must still navigate.
    if(target.closest('.goblin-hit,.goblin-card,.emotion-stage')) return false;
    return !!target.closest('textarea,button,label,input,.sheet,.detail-modal,.video-modal,.reaction-menu');
  };
  const start=e=>{
    const t=e.changedTouches?.[0];
    if(!t||isBlockedTarget(e.target))return;
    touchStart={x:t.clientX,y:t.clientY};
  };
  const end=e=>{
    if(!touchStart)return;
    const t=e.changedTouches?.[0];
    if(!t)return;
    const dx=t.clientX-touchStart.x,dy=t.clientY-touchStart.y;
    touchStart=null;
    if(Math.abs(dx)<55||Math.abs(dx)<Math.abs(dy)*1.15)return;
    if(dx<0&&!els.pages.classList.contains('show-calendar'))showCalendar();
    else if(dx>0&&els.pages.classList.contains('show-calendar'))showComposer();
  };
  document.addEventListener('touchstart',start,{passive:true});
  document.addEventListener('touchend',end,{passive:true});
}
async function requestPersistence(){ try{ if(navigator.storage?.persist){ const already=await navigator.storage.persisted(); if(!already)await navigator.storage.persist(); } }catch(e){ console.warn('persistent storage request failed',e); } }
async function restoreDraft(){
  state=normalizeDraft(await getDraft());
  editingMomentId=state.editingMomentId||null;
  if(editingMomentId){ editOriginalMoment=await getMoment(editingMomentId); if(!editOriginalMoment){ editingMomentId=null; state.editingMomentId=null; } }
  els.memo.value=state.note||''; els.memoCount.textContent=String((state.note||'').length); setComposerDuration(state.videoDuration,false);
  renderGoblin(); await renderMedia(); refreshEditUI();
}
function idlePrefetchModels(){
  const work=()=>{ for(const url of [MODEL_URLS.positive,MODEL_URLS.negative]){ const link=document.createElement('link'); link.rel='prefetch'; link.href=url; link.as='fetch'; document.head.append(link); } };
  if('requestIdleCallback'in window)requestIdleCallback(work,{timeout:3500}); else setTimeout(work,2500);
}

function bind(){
  els.app=$('app'); els.pages=$('pages'); els.draftIndicator=$('draft-indicator'); els.resetDraft=$('reset-draft'); els.calendarOpen=$('calendar-open'); els.calendarBack=$('calendar-back'); els.emotionStage=$('emotion-stage'); els.goblins=$('goblins'); els.reactionMenu=$('reaction-menu'); els.photoInput=$('photo-input'); els.photoStrip=$('photo-strip'); els.photoEmpty=$('photo-empty'); els.memo=$('memo'); els.memoCount=$('memo-count'); els.durationOptions=$('duration-options'); els.durationLabel=$('duration-label'); els.save=$('save'); els.generateVideo=$('generate-video');
  els.apiSheet=$('api-sheet'); els.apiKey=$('api-key'); els.apiClose=$('api-close'); els.apiPaste=$('api-paste'); els.apiSave=$('api-save');
  els.monthTitle=$('month-title'); els.monthPrev=$('month-prev'); els.monthNext=$('month-next'); els.today=$('today'); els.calendar=$('calendar'); els.selectedDateTitle=$('selected-date-title'); els.selectedDateCount=$('selected-date-count'); els.momentList=$('moment-list');
  els.detailModal=$('detail-modal'); els.detailDate=$('detail-date'); els.detailTime=$('detail-time'); els.detailStage=$('detail-stage'); els.detailGoblins=$('detail-goblins'); els.detailPhotos=$('detail-photos'); els.detailNote=$('detail-note'); els.detailClose=$('detail-close'); els.detailEdit=$('detail-edit'); els.detailDelete=$('detail-delete'); els.detailDurationOptions=$('detail-duration-options'); els.detailDurationLabel=$('detail-duration-label'); els.detailGenerateVideo=$('detail-generate-video'); els.detailViewVideo=$('detail-view-video');
  els.videoModal=$('video-modal'); els.videoClose=$('video-close'); els.videoLoading=$('video-loading'); els.videoLoadingCopy=$('video-loading-copy'); els.videoPlayer=$('video-player');
  els.toast=$('toast'); els.modelWarning=$('model-warning');

  els.calendarOpen.addEventListener('click',showCalendar); els.calendarBack.addEventListener('click',showComposer); els.resetDraft.addEventListener('click',()=>resetComposer(true));
  els.emotionStage.addEventListener('click',e=>{ if(!e.target.closest('.reaction-menu'))closeReactionMenu(); });
  els.photoInput.addEventListener('change',e=>addMedia(e.target.files));
  els.memo.addEventListener('input',()=>{ state.note=els.memo.value; els.memoCount.textContent=String(state.note.length); queueDraft(); });
  els.durationOptions.addEventListener('click',e=>{ const b=e.target.closest('[data-duration]'); if(b)setComposerDuration(Number(b.dataset.duration)); });
  els.save.addEventListener('click',saveMoment); els.generateVideo.addEventListener('click',()=>startGeneration({type:'draft',duration:state.videoDuration}));

  els.apiClose.addEventListener('click',closeApiSheet); document.querySelector('[data-close-api]').addEventListener('click',closeApiSheet); els.apiPaste.addEventListener('click',pasteApiKey); els.apiSave.addEventListener('click',saveApiKeyAndContinue); els.apiKey.addEventListener('keydown',e=>{ if(e.key==='Enter')saveApiKeyAndContinue(); });

  els.monthPrev.addEventListener('click',async()=>{ currentMonth=new Date(currentMonth.getFullYear(),currentMonth.getMonth()-1,1); await renderCalendar(); });
  els.monthNext.addEventListener('click',async()=>{ currentMonth=new Date(currentMonth.getFullYear(),currentMonth.getMonth()+1,1); await renderCalendar(); });
  els.today.addEventListener('click',async()=>{ const n=new Date(); currentMonth=new Date(n.getFullYear(),n.getMonth(),1); selectedDate=localDate(n); await renderCalendar(); await renderSelectedDate(); });

  els.detailClose.addEventListener('click',closeDetail); document.querySelector('[data-close-detail]').addEventListener('click',closeDetail);
  els.detailEdit.addEventListener('click',()=>{ if(detailMomentId)beginEditMoment(detailMomentId); });
  els.detailDelete.addEventListener('click',async()=>{ if(!detailMomentId)return; if(confirm('この記録を削除しますか？'))await deleteMoment(detailMomentId); });
  els.detailDurationOptions.addEventListener('click',e=>{ const b=e.target.closest('[data-duration]'); if(b)setDetailDuration(Number(b.dataset.duration)); });
  els.detailGenerateVideo.addEventListener('click',()=>{ if(detailMomentId)startGeneration({type:'moment',id:detailMomentId,duration:detailVideoDuration}); });
  els.detailViewVideo.addEventListener('click',async()=>{ if(!detailMomentId)return; const m=await getMoment(detailMomentId); if(m?.videoId)await viewStoredVideo(m.videoId); });

  els.videoClose.addEventListener('click',closeVideo); document.querySelector('[data-close-video]').addEventListener('click',closeVideo);
  buildReactionMenu(); setupSwipe();
}

async function init(){
  bind();
  // Show the core interaction immediately, even if storage restoration has a problem.
  renderGoblin();
  try{
    db=await openDB(); await requestPersistence(); await restoreDraft(); await renderCalendar(); await renderSelectedDate();
    idlePrefetchModels();
  }catch(e){
    console.error(e);
    els.draftIndicator.textContent='保存機能エラー';
    toast('保存領域を開けませんでした');
  }
  if('serviceWorker'in navigator&&location.protocol.startsWith('http'))navigator.serviceWorker.register('./sw.js?v=6').catch(()=>{});
  setTimeout(()=>{ if(!customElements.get('model-viewer'))els.modelWarning.hidden=false; },7000);
}

init();
