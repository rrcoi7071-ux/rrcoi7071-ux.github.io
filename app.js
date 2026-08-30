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
const DB_VERSION = 1;
const SCHEMA_VERSION = 1;
const MAX_GOBLINS = 3;
const MAX_LEVEL = 4;
const els = {};
let db;
let state = freshDraft();
let draftTimer = null;
let currentMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedDate = localDate(new Date());
let detailMomentId = null;
let touchStart = null;

function $(id){ return document.getElementById(id); }
function freshDraft(){ return { key:'active', schemaVersion:SCHEMA_VERSION, note:'', goblins:[{id:crypto.randomUUID(), level:0}], emojis:[], mediaIds:[], updatedAt:new Date().toISOString() }; }
function localDate(d){ const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; }
function clamp(n,min,max){ return Math.max(min,Math.min(max,n)); }
function moodFromLevel(level){ return level > 0 ? 'positive' : level < 0 ? 'negative' : 'neutral'; }
function averageLevel(goblins){ return goblins.length ? goblins.reduce((a,g)=>a+g.level,0)/goblins.length : 0; }
function formatTime(iso){ return new Intl.DateTimeFormat('ja-JP',{hour:'2-digit',minute:'2-digit'}).format(new Date(iso)); }
function formatLongDate(dateStr){ const [y,m,d]=dateStr.split('-').map(Number); return `${y}年${m}月${d}日`; }
function escapeHtml(s=''){ return s.replace(/[&<>'"]/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c])); }
function toast(msg){ els.toast.textContent=msg; els.toast.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(()=>els.toast.classList.remove('show'),1800); }

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
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
function idbReq(req){ return new Promise((resolve,reject)=>{ req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error); }); }
async function getDraft(){ return idbReq(db.transaction('draft','readonly').objectStore('draft').get('active')); }
async function putDraft(){ state.updatedAt=new Date().toISOString(); return idbReq(db.transaction('draft','readwrite').objectStore('draft').put(structuredClone(state))); }
async function clearDraft(){ return idbReq(db.transaction('draft','readwrite').objectStore('draft').delete('active')); }
async function saveMedia(blob){ const id=crypto.randomUUID(); await idbReq(db.transaction('media','readwrite').objectStore('media').put({id,blob,createdAt:new Date().toISOString()})); return id; }
async function getMedia(id){ return idbReq(db.transaction('media','readonly').objectStore('media').get(id)); }
async function deleteMedia(id){ return idbReq(db.transaction('media','readwrite').objectStore('media').delete(id)); }
async function getAllMoments(){ return idbReq(db.transaction('moments','readonly').objectStore('moments').getAll()); }
async function getMoment(id){ return idbReq(db.transaction('moments','readonly').objectStore('moments').get(id)); }
async function getMomentsByDate(date){ return idbReq(db.transaction('moments','readonly').objectStore('moments').index('localDate').getAll(date)); }

function queueDraft(){
  els.draftIndicator.textContent='下書きを保存中…';
  clearTimeout(draftTimer);
  draftTimer=setTimeout(async()=>{
    try{ await putDraft(); els.draftIndicator.textContent='下書き保存済み'; }
    catch(e){ console.error(e); els.draftIndicator.textContent='保存できません'; toast('下書きを保存できませんでした'); }
  },280);
}

function applyTone(){
  const avg=clamp(averageLevel(state.goblins),-4,4);
  const app=els.app;
  let bg, ink, tone='neutral';
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
  app.style.setProperty('--bg',bg);
  app.dataset.tone=tone;
  document.querySelector('meta[name="theme-color"]').setAttribute('content',bg);
}

function renderGoblins(){
  els.goblins.dataset.count=String(state.goblins.length);
  els.goblins.innerHTML='';
  for(const g of state.goblins){
    const mood=moodFromLevel(g.level);
    const card=document.createElement('div'); card.className='goblin-card'; card.dataset.id=g.id;
    const viewer=document.createElement('model-viewer');
    viewer.setAttribute('src',MODEL_URLS[mood]); viewer.setAttribute('alt','ゴブリン'); viewer.setAttribute('loading','eager'); viewer.setAttribute('reveal','auto'); viewer.setAttribute('shadow-intensity','0.5'); viewer.setAttribute('camera-orbit','0deg 83deg 105%'); viewer.setAttribute('field-of-view','28deg'); viewer.setAttribute('interaction-prompt','none');
    const level=document.createElement('div'); level.className='goblin-level'; level.textContent=g.level===0?'0':g.level>0?`+${g.level}`:`${g.level}`;
    const upper=document.createElement('button'); upper.type='button'; upper.className='goblin-hit upper'; upper.setAttribute('aria-label','プラス感情'); upper.addEventListener('click',e=>{e.stopPropagation(); changeLevel(g.id,+1);});
    const lower=document.createElement('button'); lower.type='button'; lower.className='goblin-hit lower'; lower.setAttribute('aria-label','マイナス感情'); lower.addEventListener('click',e=>{e.stopPropagation(); changeLevel(g.id,-1);});
    card.append(viewer,level,upper,lower);
    if(state.goblins.length>1){ const rm=document.createElement('button'); rm.className='goblin-remove'; rm.type='button'; rm.textContent='×'; rm.addEventListener('click',e=>{e.stopPropagation(); removeGoblin(g.id);}); card.append(rm); }
    els.goblins.append(card);
  }
  applyTone();
}
function changeLevel(id,delta){ const g=state.goblins.find(x=>x.id===id); if(!g) return; g.level=clamp(g.level+delta,-MAX_LEVEL,MAX_LEVEL); renderGoblins(); queueDraft(); }
function addGoblin(){ if(state.goblins.length>=MAX_GOBLINS){ toast('ゴブリンは3体までです'); return; } state.goblins.push({id:crypto.randomUUID(),level:0}); renderGoblins(); queueDraft(); }
function removeGoblin(id){ if(state.goblins.length<=1) return; state.goblins=state.goblins.filter(g=>g.id!==id); renderGoblins(); queueDraft(); }

function renderEmojis(){
  els.emojiLayer.innerHTML='';
  state.emojis.forEach(item=>{
    const e=document.createElement('button'); e.type='button'; e.className='floating-emoji'; e.textContent=item.emoji; e.style.left=`${item.x*100}%`; e.style.top=`${item.y*100}%`; e.style.setProperty('--s',`${item.size}px`); e.style.setProperty('--r',`${item.rotation}deg`); e.style.animationDelay=`-${item.phase}s`; e.setAttribute('aria-label','絵文字を削除'); e.addEventListener('click',ev=>{ev.stopPropagation(); state.emojis=state.emojis.filter(x=>x.id!==item.id); renderEmojis(); queueDraft();}); els.emojiLayer.append(e);
  });
}
function addEmojiAt(clientX,clientY){
  const r=els.emotionStage.getBoundingClientRect();
  let x=(clientX-r.left)/r.width, y=(clientY-r.top)/r.height;
  if(y>.83) return;
  x=clamp(x+(Math.random()-.5)*.035,.04,.96); y=clamp(y+(Math.random()-.5)*.035,.04,.82);
  state.emojis.push({id:crypto.randomUUID(),emoji:els.selectedEmoji.textContent || '✨',x,y,size:28+Math.random()*18,rotation:-20+Math.random()*40,phase:Math.random()*2.6});
  renderEmojis(); queueDraft();
}
function buildEmojiSheet(){
  els.emojiCategories.innerHTML='';
  Object.entries(EMOJIS).forEach(([name,list])=>{
    const section=document.createElement('section'); section.className='emoji-category'; section.innerHTML=`<h3>${name}</h3>`;
    const grid=document.createElement('div'); grid.className='emoji-grid';
    list.forEach(emoji=>{ const b=document.createElement('button'); b.type='button'; b.className='emoji-choice'; b.textContent=emoji; b.addEventListener('click',()=>{els.selectedEmoji.textContent=emoji; closeEmojiSheet(); toast(`${emoji} を選択`);}); grid.append(b); });
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
    const url=URL.createObjectURL(media.blob); const wrap=document.createElement('div'); wrap.className='photo-thumb'; const img=document.createElement('img'); img.src=url; img.alt='選択した写真'; img.onload=()=>URL.revokeObjectURL(url); const rm=document.createElement('button'); rm.className='photo-remove'; rm.type='button'; rm.textContent='×'; rm.addEventListener('click',async()=>{ await deleteMedia(id); state.mediaIds=state.mediaIds.filter(x=>x!==id); await renderPhotos(); queueDraft(); }); wrap.append(img,rm); els.photoStrip.append(wrap);
  }
}
async function addPhotos(files){
  if(!files?.length) return;
  els.draftIndicator.textContent='写真を保存中…';
  try{
    for(const file of [...files].slice(0,8)){ if(!file.type.startsWith('image/')) continue; const id=await saveMedia(file); state.mediaIds.push(id); }
    await renderPhotos(); queueDraft();
  }catch(e){console.error(e); toast('写真を保存できませんでした');}
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
      id:crypto.randomUUID(), schemaVersion:SCHEMA_VERSION, createdAt:now.toISOString(), occurredAt:now.toISOString(), localDate:localDate(now), note:state.note,
      goblins:state.goblins.map(g=>({id:g.id,level:g.level})), emojis:state.emojis.map(e=>({...e})), mediaIds:[...state.mediaIds]
    };
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(['moments','draft'],'readwrite'); tx.objectStore('moments').put(moment); tx.objectStore('draft').delete('active'); tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error||new Error('transaction aborted'));
    });
    state=freshDraft(); els.memo.value=''; els.memoCount.textContent='0'; await renderPhotos(); renderGoblins(); renderEmojis(); await putDraft();
    toast('この瞬間を保存しました'); selectedDate=moment.localDate; await renderCalendar();
  }catch(e){ console.error(e); toast('保存できませんでした。入力は残っています'); try{await putDraft();}catch{} }
  finally{ els.save.disabled=false; els.save.textContent='この瞬間を保存'; }
}

async function deleteMoment(id){
  const moment=await getMoment(id); if(!moment) return;
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(['moments','media'],'readwrite'); tx.objectStore('moments').delete(id); for(const mid of moment.mediaIds||[]) tx.objectStore('media').delete(mid); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
  });
  closeDetail(); await renderCalendar(); await renderSelectedDate(); toast('削除しました');
}

function showComposer(){ els.pages.classList.remove('show-calendar'); }
async function showCalendar(){ els.pages.classList.add('show-calendar'); await renderCalendar(); await renderSelectedDate(); }

async function renderCalendar(){
  const all=await getAllMoments(); const grouped=new Map();
  for(const m of all){ if(!grouped.has(m.localDate)) grouped.set(m.localDate,[]); grouped.get(m.localDate).push(m); }
  const y=currentMonth.getFullYear(), mon=currentMonth.getMonth(); els.monthTitle.textContent=`${y}年 ${mon+1}月`; els.calendar.innerHTML='';
  const first=new Date(y,mon,1), start=new Date(y,mon,1-first.getDay());
  for(let i=0;i<42;i++){
    const d=new Date(start); d.setDate(start.getDate()+i); const ds=localDate(d); const entries=grouped.get(ds)||[];
    const b=document.createElement('button'); b.type='button'; b.className='calendar-cell'; if(d.getMonth()!==mon)b.classList.add('other'); if(ds===localDate(new Date()))b.classList.add('today'); if(ds===selectedDate)b.classList.add('selected');
    const avg=entries.length?entries.reduce((sum,m)=>sum+averageLevel(m.goblins),0)/entries.length:0;
    b.innerHTML=`<span class="day-num">${d.getDate()}</span>${entries.length?`<span class="count">${entries.length}</span><span class="mood-dot" style="opacity:${.35+Math.min(1,Math.abs(avg)/4)*.5}"></span>`:'<span class="count" style="visibility:hidden">0</span>'}`;
    b.addEventListener('click',async()=>{ selectedDate=ds; if(d.getMonth()!==mon) currentMonth=new Date(d.getFullYear(),d.getMonth(),1); await renderCalendar(); await renderSelectedDate(); }); els.calendar.append(b);
  }
}
async function renderSelectedDate(){
  els.selectedDateTitle.textContent=formatLongDate(selectedDate); const moments=(await getMomentsByDate(selectedDate)).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)); els.selectedDateCount.textContent=moments.length?`${moments.length}件`:''; els.momentList.innerHTML='';
  if(!moments.length){els.momentList.innerHTML='<p class="empty-message">この日はまだ何も残していません。</p>'; return;}
  for(const m of moments){
    const avg=averageLevel(m.goblins); const icon=avg>0?'☺':avg<0?'↓':'•'; const snippet=m.note?.trim() || (m.mediaIds?.length?'写真の記録':'感情の記録');
    const b=document.createElement('button'); b.type='button'; b.className='moment-item'; b.innerHTML=`<span class="moment-state">${icon}</span><span class="moment-copy"><strong>${formatTime(m.createdAt)}</strong><span>${escapeHtml(snippet)}</span></span><span class="moment-arrow">›</span>`; b.addEventListener('click',()=>openDetail(m.id)); els.momentList.append(b);
  }
}

async function openDetail(id){
  const m=await getMoment(id); if(!m) return; detailMomentId=id; els.detailDate.textContent=formatLongDate(m.localDate); els.detailTime.textContent=formatTime(m.createdAt); els.detailNote.textContent=m.note||'';
  const avg=averageLevel(m.goblins); let bg='#f3f2ee'; if(avg<0){const t=Math.abs(avg)/4,v=Math.round(243-205*t);bg=`rgb(${v},${v},${Math.max(32,v-2)})`;} else if(avg>0){const v=Math.round(243+12*(avg/4));bg=`rgb(${v},${v},${Math.min(255,v+1)})`; } els.detailStage.style.background=bg;
  els.detailGoblins.innerHTML=''; (m.goblins||[]).forEach(g=>{const viewer=document.createElement('model-viewer');viewer.setAttribute('src',MODEL_URLS[moodFromLevel(g.level)]);viewer.setAttribute('alt','保存されたゴブリン');viewer.setAttribute('loading','eager');viewer.setAttribute('shadow-intensity','.45');viewer.setAttribute('camera-orbit','0deg 83deg 105%');viewer.setAttribute('field-of-view','28deg');viewer.setAttribute('interaction-prompt','none');els.detailGoblins.append(viewer);});
  els.detailEmojis.innerHTML=''; (m.emojis||[]).forEach(item=>{const e=document.createElement('span');e.className='floating-emoji';e.textContent=item.emoji;e.style.left=`${item.x*100}%`;e.style.top=`${item.y*100}%`;e.style.setProperty('--s',`${item.size}px`);e.style.setProperty('--r',`${item.rotation}deg`);e.style.animationDelay=`-${item.phase||0}s`;els.detailEmojis.append(e);});
  els.detailPhotos.innerHTML=''; for(const mid of m.mediaIds||[]){const media=await getMedia(mid);if(media?.blob){const img=document.createElement('img');const url=URL.createObjectURL(media.blob);img.src=url;img.onload=()=>URL.revokeObjectURL(url);els.detailPhotos.append(img);}}
  els.detailModal.classList.add('open'); els.detailModal.setAttribute('aria-hidden','false');
}
function closeDetail(){ els.detailModal.classList.remove('open'); els.detailModal.setAttribute('aria-hidden','true'); detailMomentId=null; els.detailGoblins.innerHTML=''; els.detailPhotos.innerHTML=''; }

function setupSwipe(){
  const start=(e)=>{ const t=e.changedTouches?.[0]; if(!t) return; const target=e.target; if(target.closest('textarea,button,label,input,.sheet,.detail-modal')) return; touchStart={x:t.clientX,y:t.clientY}; };
  const end=(e)=>{ if(!touchStart)return; const t=e.changedTouches?.[0]; if(!t)return; const dx=t.clientX-touchStart.x,dy=t.clientY-touchStart.y; touchStart=null; if(Math.abs(dx)<70||Math.abs(dx)<Math.abs(dy)*1.35)return; if(dx<0&&!els.pages.classList.contains('show-calendar'))showCalendar(); else if(dx>0&&els.pages.classList.contains('show-calendar'))showComposer(); };
  document.addEventListener('touchstart',start,{passive:true}); document.addEventListener('touchend',end,{passive:true});
}

async function requestPersistence(){
  try{ if(navigator.storage?.persist){ const already=await navigator.storage.persisted(); if(!already) await navigator.storage.persist(); } }catch(e){ console.warn('persistent storage request failed',e); }
}

async function restoreDraft(){
  const saved=await getDraft(); if(saved?.schemaVersion===SCHEMA_VERSION){ state={...freshDraft(),...saved}; if(!Array.isArray(state.goblins)||!state.goblins.length)state.goblins=[{id:crypto.randomUUID(),level:0}]; }
  els.memo.value=state.note||''; els.memoCount.textContent=String((state.note||'').length); renderGoblins(); renderEmojis(); await renderPhotos();
}

function bind(){
  els.app=$('app'); els.pages=$('pages'); els.draftIndicator=$('draft-indicator'); els.calendarOpen=$('calendar-open'); els.calendarBack=$('calendar-back'); els.emotionStage=$('emotion-stage'); els.goblins=$('goblins'); els.emojiLayer=$('emoji-layer'); els.emojiPickerOpen=$('emoji-picker-open'); els.selectedEmoji=$('selected-emoji'); els.addGoblin=$('add-goblin'); els.photoInput=$('photo-input'); els.photoStrip=$('photo-strip'); els.photoEmpty=$('photo-empty'); els.memo=$('memo'); els.memoCount=$('memo-count'); els.save=$('save'); els.emojiSheet=$('emoji-sheet'); els.emojiCategories=$('emoji-categories'); els.emojiClose=$('emoji-close'); els.monthTitle=$('month-title'); els.monthPrev=$('month-prev'); els.monthNext=$('month-next'); els.today=$('today'); els.calendar=$('calendar'); els.selectedDateTitle=$('selected-date-title'); els.selectedDateCount=$('selected-date-count'); els.momentList=$('moment-list'); els.detailModal=$('detail-modal'); els.detailDate=$('detail-date'); els.detailTime=$('detail-time'); els.detailStage=$('detail-stage'); els.detailEmojis=$('detail-emojis'); els.detailGoblins=$('detail-goblins'); els.detailPhotos=$('detail-photos'); els.detailNote=$('detail-note'); els.detailClose=$('detail-close'); els.detailDelete=$('detail-delete'); els.toast=$('toast'); els.modelWarning=$('model-warning');

  els.calendarOpen.addEventListener('click',showCalendar); els.calendarBack.addEventListener('click',showComposer); els.addGoblin.addEventListener('click',addGoblin); els.emojiPickerOpen.addEventListener('click',openEmojiSheet); els.emojiClose.addEventListener('click',closeEmojiSheet); document.querySelector('[data-close-sheet]').addEventListener('click',closeEmojiSheet);
  els.emotionStage.addEventListener('click',e=>{ if(e.target.closest('.goblin-card,.stage-tools,.tap-guide'))return; addEmojiAt(e.clientX,e.clientY); });
  els.photoInput.addEventListener('change',e=>addPhotos(e.target.files));
  els.memo.addEventListener('input',()=>{state.note=els.memo.value; els.memoCount.textContent=String(state.note.length); queueDraft();}); els.save.addEventListener('click',saveMoment);
  els.monthPrev.addEventListener('click',async()=>{currentMonth=new Date(currentMonth.getFullYear(),currentMonth.getMonth()-1,1);await renderCalendar();}); els.monthNext.addEventListener('click',async()=>{currentMonth=new Date(currentMonth.getFullYear(),currentMonth.getMonth()+1,1);await renderCalendar();}); els.today.addEventListener('click',async()=>{const n=new Date();currentMonth=new Date(n.getFullYear(),n.getMonth(),1);selectedDate=localDate(n);await renderCalendar();await renderSelectedDate();});
  els.detailClose.addEventListener('click',closeDetail); document.querySelector('[data-close-detail]').addEventListener('click',closeDetail); els.detailDelete.addEventListener('click',async()=>{if(!detailMomentId)return; if(confirm('この記録を削除しますか？')) await deleteMoment(detailMomentId);});
  setupSwipe(); buildEmojiSheet();
}

async function init(){
  bind();
  try{ db=await openDB(); await requestPersistence(); await restoreDraft(); await renderCalendar(); await renderSelectedDate(); els.draftIndicator.textContent='下書き保存済み'; }
  catch(e){ console.error(e); els.draftIndicator.textContent='保存機能エラー'; toast('保存領域を開けませんでした'); }
  if('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(()=>{});
  setTimeout(()=>{ if(!customElements.get('model-viewer')) els.modelWarning.hidden=false; },7000);
}
init();
