/* GitHub Pages shell: frozen point ownership, committed saves and portable backups. */
(function () {
'use strict';
const root=document.getElementById('tulip-thumb-flow'), $=s=>root.querySelector(s);
const phone=$('.tt-phone'), editor=window.TulipEditor, media=window.NoteMedia, store=new RoadbookStore();
const notes=new Map(), saved=new Map(), failures=new Map();
const LAST='rallymaker:last-point';
let active=null, ready=false, locked=false, timer=null, queue=Promise.resolve(true), noticeTimer=null;
let gpsWatch=null, latestFix=null;
const copy=x=>JSON.parse(JSON.stringify(x));
const now=()=>new Date().toISOString();
const empty=()=>({format:'spline-v2',aspect:370/405,roads:[],features:[],raw:[]});
const label=n=>`Point ${String(n.number).padStart(2,'0')}`;
function remember(id){try{localStorage.setItem(LAST,id||'new')}catch(_){}}
function notice(message){clearTimeout(noticeTimer);$('.tt-app-notice').textContent=message;$('.tt-app-notice').hidden=false;noticeTimer=setTimeout(()=>{$('.tt-app-notice').hidden=true},6000)}
function header(){
 $('.tt-point-title').textContent=active?label(active):'New point';
 const problem=active&&(failures.has(active.id)||media.hasUnsaved());
 $('.tt-save-state').classList.toggle('error',!!problem);
 $('.tt-save-state').textContent=!ready?'Opening…':problem?'Not saved':!active?'Ready':saved.get(active.id)>=active.revision?'Saved on device':'Saving…';
}
function journal(note){try{store.writeDraft(note)}catch(_){/* IndexedDB remains the durable source; save result is reported below. */}}
function persist(note){
 const snapshot=copy(note);journal(snapshot);header();
 const work=queue.then(async()=>{
  try{
   await store.saveNote(snapshot);saved.set(snapshot.id,snapshot.revision);failures.delete(snapshot.id);
   try{store.clearDraft(snapshot.id,snapshot.revision)}catch(_){}
   return true;
  }catch(error){failures.set(snapshot.id,error);notice('Point is not saved. Keep this page open and try Done again, or download a backup.');return false}
  finally{header()}
 });
 queue=work;return work;
}
function schedule(note){if(note!==active){void persist(note);return}journal(note);clearTimeout(timer);timer=setTimeout(()=>{timer=null;void persist(note)},220);header()}
function freshAnchor(){return {markedAt:now(),location:latestFix&&Date.now()-latestFix.timestamp<15000?copy(latestFix):null}}
function ensurePoint(){
 if(!ready||locked)return null;
 if(!active){
  const stamp=now();active={id:`note_${crypto.randomUUID()}`,number:Math.max(0,...Array.from(notes.values(),n=>n.number))+1,createdAt:stamp,updatedAt:stamp,anchor:freshAnchor(),tripKm:null,text:$('.tt-note-text').value,review:false,revision:0,sketch:editor.getState()};
  notes.set(active.id,active);remember(active.id);
  void media.loadPoint(active.id,active.text);schedule(active);
 }
 return active.id;
}
function touch(note=active){
 if(!note)return;
 if(note===active){note.sketch=editor.getState();note.text=$('.tt-note-text').value}
 note.updatedAt=now();note.revision++;notes.set(note.id,note);schedule(note);
}
async function flush(){
 editor.commitPending();clearTimeout(timer);timer=null;
 if(active)return persist(active);
 return queue;
}
function closeSheets(){for(const el of root.querySelectorAll('.tt-app-sheet'))el.hidden=true}
function showSheet(selector){editor.commitPending();closeSheets();$('.tt-picker').hidden=true;$('.tt-add').hidden=true;$('.tt-more').setAttribute('aria-expanded','false');$('.tt-arrange').setAttribute('aria-expanded','false');$(selector).hidden=false}
async function transition(task){
 if(locked||!ready)return;
 if(!$('.tt-review').hidden&&!$('.tt-trip').reportValidity())return;
 editor.commitPending();locked=true;phone.inert=true;
 try{
  const mediaOK=await media.finish(), noteOK=await flush();
  if(!mediaOK||!noteOK){notice('Keep this point open until it saves. You can download a backup in Options.');return}
  await task();
 }catch(error){notice(error.message||'Could not open that point. Your current work is retained.')}
 finally{locked=false;phone.inert=false;header()}
}
async function loadPoint(note){
 // Validate and migrate before replacing any visible work. Never mutate stored legacy data on load.
 const sketch=note?RoadbookStore.migrateSketch(note.sketch):empty();
 if(note&&note.sketch.format!=='spline-v2')note={...copy(note),legacySketch:copy(note.sketch),sketch};
 active=note;if(note)notes.set(note.id,note);
 editor.setState(sketch);$('.tt-note-text').value=note?.text||'';
 await media.loadPoint(note?.id||null,note?.text||'');remember(note?.id);closeSheets();header();
}
function renderPoints(){
 const list=$('.tt-point-list');list.replaceChildren();
 const ordered=Array.from(notes.values()).sort((a,b)=>b.number-a.number||b.createdAt.localeCompare(a.createdAt));
 if(!ordered.length){const p=document.createElement('p');p.className='tt-empty';p.textContent='Your points appear here as you draw or add a note.';list.append(p)}
 for(const note of ordered){
  const b=document.createElement('button');b.type='button';b.className='tt-saved-point';
  const title=document.createElement('strong');title.textContent=label(note)+(note.tripKm===null?'':` · ${note.tripKm.toFixed(3)} km`);
  const detail=document.createElement('span');detail.textContent=note.text.trim()||new Date(note.anchor.markedAt).toLocaleString();
  b.append(title,detail);b.onclick=()=>transition(()=>loadPoint(note));list.append(b);
 }
}
function showReview(){
 if(!active){notice('Draw a tulip or add a note to start a point.');return}
 $('.tt-review-title').textContent=label(active);$('.tt-trip').value=active.tripKm??'';
 const parsed=new DOMParser().parseFromString(editor.exportSVG(),'image/svg+xml');
 $('.tt-review-tulip').replaceChildren(document.importNode(parsed.documentElement,true));
 $('.tt-review-text').textContent=active.text||'Photos and voice are available in Note.';
 const loc=active.anchor.location;
 $('.tt-anchor').textContent=`Captured ${new Date(active.anchor.markedAt).toLocaleString()}`+(loc?` · ${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)} · ±${Math.round(loc.accuracyM)} m`:'');
 showSheet('.tt-review');
}
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000)}
async function base64(blob){const bytes=new Uint8Array(await blob.arrayBuffer());let value='';for(let i=0;i<bytes.length;i+=32768)value+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(value)}
async function backup(){
 if(locked)return;editor.commitPending();locked=true;phone.inert=true;
 try{
  await media.finish();await flush();let data,partial=false;
  try{data=await store.exportProject()}catch(_){data={format:'rallymaker-roadbook',version:1,exportedAt:now(),notes:[],media:[]};partial=true}
  const merged=new Map(data.notes.map(n=>[n.id,n]));
  for(const n of notes.values())if(!merged.has(n.id)||merged.get(n.id).revision<=n.revision)merged.set(n.id,copy(n));
  data.notes=Array.from(merged.values());
  const attachments=new Map(data.media.map(m=>[m.id,m]));
  for(const record of media.recoveryMedia()){const {blob,...metadata}=record;attachments.set(record.id,{...metadata,size:blob.size,base64:await base64(blob)})}
  data.media=Array.from(attachments.values());
  if(partial)data.recoveryWarning='Database could not be read. This recovery contains the points in memory and unsaved attachments only.';
  download(new Blob([JSON.stringify(data)],{type:'application/json'}),`rallymaker-${partial?'recovery-':''}${now().slice(0,10)}.json`);
  $('.tt-options-status').textContent=partial?'Recovery downloaded. Saved attachments could not be read; keep this page open and retry the complete backup.':'Backup downloaded with all points, photos and voice notes.';
 }catch(error){notice(`Backup failed: ${error.message}. Keep this page open.`)}
 finally{locked=false;phone.inert=false;header()}
}
media.configure({
 ensurePoint,
 saveMedia:async record=>{const owner=notes.get(record.noteId);if(!owner||!await persist(owner))throw new Error('The point could not be saved.');return store.putMedia(record)},
 listMedia:async id=>Promise.all((await store.listMedia(id)).map(m=>store.getMedia(m.id))),
 deleteMedia:id=>store.deleteMedia(id),
 onError:message=>{notice(message);header()},
 onChange:({noteId})=>{const note=notes.get(noteId);if(note)touch(note)}
});
// Capture the junction time at first contact, before the finger finishes a stroke.
$('.tt-sketch').addEventListener('pointerdown',()=>{ensurePoint()},{capture:true});
root.addEventListener('sketchchange',()=>{if(ready&&!locked){ensurePoint();touch()}});
$('.tt-note-text').addEventListener('input',()=>{ensurePoint();touch()});
root.addEventListener('finishpoint',()=>transition(async()=>{if(active){active.review=true;touch();if(!await flush())return}showReview()}));
$('.tt-open-points').onclick=()=>{renderPoints();showSheet('.tt-book')};
$('.tt-open-menu').onclick=()=>showSheet('.tt-options');
for(const close of root.querySelectorAll('[data-close-sheet]'))close.onclick=closeSheets;
$('.tt-new-point').onclick=$('.tt-keep-next').onclick=()=>transition(()=>loadPoint(null));
$('.tt-trip').addEventListener('input',()=>{
 const value=$('.tt-trip').value.trim(),n=value===''?null:Number(value);
 if(n!==null&&(!Number.isFinite(n)||n<0||n>100000)){$('.tt-trip').setCustomValidity('Enter a distance between 0 and 100,000 km.');return}
 $('.tt-trip').setCustomValidity('');if(active){active.tripKm=n;touch()}
});
$('.tt-backup').onclick=backup;
$('.tt-svg').onclick=()=>{editor.commitPending();download(new Blob([editor.exportSVG()],{type:'image/svg+xml'}),`rallymaker-${active?String(active.number).padStart(2,'0'):'tulip'}.svg`)};
$('.tt-import').onclick=()=>$('.tt-import-input').click();
$('.tt-import-input').addEventListener('change',()=>{
 const file=$('.tt-import-input').files[0];$('.tt-import-input').value='';if(!file)return;
 void transition(async()=>{
  if(file.size>90*1024*1024)throw new Error('Backup is too large to import on this device.');
  const result=await store.importProject(JSON.parse(await file.text()));
  for(const note of await store.listNotes()){if(!notes.has(note.id))notes.set(note.id,note);saved.set(note.id,note.revision)}
  renderPoints();showSheet('.tt-book');notice(`Imported ${result.noteCount} points and ${result.mediaCount} attachments.`);
 });
});
$('.tt-gps-toggle').onclick=()=>{
 const button=$('.tt-gps-toggle'),text=button.querySelector('span');
 if(gpsWatch!==null){navigator.geolocation.clearWatch(gpsWatch);gpsWatch=null;latestFix=null;button.setAttribute('aria-pressed','false');text.textContent='Enable GPS for new points';return}
 if(!navigator.geolocation){notice('GPS is unavailable in this browser.');return}
 button.setAttribute('aria-pressed','true');text.textContent='GPS on · waiting for location';
 gpsWatch=navigator.geolocation.watchPosition(position=>{
  const c=position.coords;latestFix={lat:c.latitude,lon:c.longitude,accuracyM:c.accuracy,timestamp:position.timestamp,heading:c.heading,speed:c.speed};
  text.textContent=`GPS on · ±${Math.round(c.accuracy)} m`;
 },error=>{latestFix=null;text.textContent=error.code===1?'GPS permission denied · tap to turn off':'GPS on · waiting for signal'}, {enableHighAccuracy:true,maximumAge:5000,timeout:15000});
};
function checkpoint(){if(!ready)return;editor.commitPending();if(active){active.sketch=editor.getState();active.text=$('.tt-note-text').value;journal(active);void flush()}}
window.addEventListener('pagehide',checkpoint);
document.addEventListener('visibilitychange',()=>{if(document.hidden)checkpoint()});
window.addEventListener('beforeunload',event=>{if(media.isBusy()||media.hasUnsaved()||active&&(saved.get(active.id)??-1)<active.revision){event.preventDefault();event.returnValue=''}});
async function start(){
 let issue='';
 try{await store.open();for(const n of await store.listNotes()){notes.set(n.id,n);saved.set(n.id,n.revision)}}catch(error){issue='Device storage is unavailable. Keep this page open and download a backup before leaving.'}
 try{for(const draft of store.readDrafts()){const durable=notes.get(draft.id);if(!durable||draft.revision>durable.revision){notes.set(draft.id,draft);void persist(draft)}}}catch(error){issue='A recovery draft could not be read. Existing saved points are still available.'}
 let last;try{last=localStorage.getItem(LAST)}catch(_){}
 const restore=last==='new'?null:notes.get(last)||Array.from(notes.values()).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0]||null;
 try{await loadPoint(restore)}catch(error){editor.setState(empty());issue='This older sketch needs recovery. Download a backup from Options; the original point is retained.'}
 ready=true;phone.inert=false;header();if(issue)notice(issue);
 if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
void start();
})();
