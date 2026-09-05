/* RallyMaker roadbook notes. Static, device-local, no external services. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const svg = $('drawing'), NS = 'http://www.w3.org/2000/svg';
  const db = new RoadbookStore();
  const clone = value => JSON.parse(JSON.stringify(value));
  const uid = prefix => prefix + (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join(''));
  const time = value => new Date(value).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
  const number = n => String(n).padStart(2, '0');
  const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
  const symbols = {house:'House', tree:'Tree', gate:'Gate', bridge:'Bridge', sign:'Sign', danger:'Danger'};
  let model = new JunctionModel(), active = null, notes = new Map(), models = new Map();
  let ready = false, storageReady = false, writeQueue = Promise.resolve(), saveTimer = null, errorShown = false, transitioning = false;
  const savedRevisions = new Map();
  const unsavedMedia = new Map();
  let mode = 'draw', rawVisible = false, selectedRoad = null, selectedPoint = null, selectedLandmark = null, splitAt = null, placing = null;
  let pointer = null, ink = [], pendingTimer = null, drag = null, lastJournal = 0, toastTimer = null;
  let latestLocation = null, gpsWatch = null, gpsState = 'off', mediaGeneration = 0, mediaURLs = [];
  let recorder = null, recordingTarget = null, recordChunks = [], recordingStarted = null, recordInterval = null, recordingSave = Promise.resolve(), audioBusy = false, photoTarget = null;
  const make = (tag,attrs={},text) => {const node=document.createElementNS(NS,tag);Object.entries(attrs).forEach(([k,v])=>node.setAttribute(k,String(v)));if(text!==undefined)node.textContent=text;return node;};
  const pressed = (id,value) => $(id).setAttribute('aria-pressed',String(value));
  const hint = message => $('gesture-hint').textContent=message;
  function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000);}
  function saveStatus(message,error=false){$('save-status').textContent=message;$('save-status').classList.toggle('error',error);}
  function storageError(error){saveStatus('Not saved — export a backup',true);if(!errorShown){toast('Local save failed. Keep this tab open and export a backup.');errorShown=true;}console.error('Local save:',error);}
  function safeLocation(){if(!latestLocation||Date.now()-latestLocation.timestamp>15000)return null;return clone(latestLocation);}
  function markPoint(){
    if(!ready||transitioning)return null;
    const now=new Date().toISOString(), next=Math.max(0,...Array.from(notes.values(),n=>n.number))+1;
    model=new JunctionModel();active={id:uid('point-'),number:next,createdAt:now,updatedAt:now,anchor:{markedAt:now,location:safeLocation()},tripKm:null,text:'',review:false,sketch:model.serialize(),revision:0};
    notes.set(active.id,active);models.set(active.id,model);resetTools();persist(true);render();renderLists();renderMedia();
    if(navigator.vibrate)navigator.vibrate(12);return active;
  }
  function ensurePoint(){return active||markPoint();}
  function captureState(){if(!active)return;active.sketch=model.serialize();active.updatedAt=new Date().toISOString();active.revision++;if(ink.length)active.pendingInk=clone(ink);else delete active.pendingInk;notes.set(active.id,active);models.set(active.id,model);}
  function persist(immediate=false){
    if(!active)return;captureState();const note=clone(active);
    try{db.writeDraft(note);}catch(error){storageError(error);}
    saveStatus('Saving…');clearTimeout(saveTimer);
    if(immediate)enqueueSave(note);else saveTimer=setTimeout(()=>{saveTimer=null;enqueueSave(note);},180);
  }
  function enqueueSave(note){
    writeQueue=writeQueue.then(async()=>{
      await db.saveNote(note);storageReady=true;savedRevisions.set(note.id,note.revision);try{db.clearDraft(note.id,note.revision);}catch(error){console.warn('Draft journal cleanup:',error);}
      if(active&&active.id===note.id&&active.revision===note.revision){saveStatus('Saved on device');errorShown=false;}
      return true;
    }).catch(error=>{storageError(error);return false;});
    return writeQueue;
  }
  async function flushSave(){clearTimeout(saveTimer);saveTimer=null;if(active){captureState();try{db.writeDraft(active);}catch(error){storageError(error);}const note=clone(active);await enqueueSave(note);return savedRevisions.get(note.id)===note.revision;}await writeQueue;return true;}
  function resetTools(){mode='draw';selectedRoad=null;selectedPoint=null;selectedLandmark=null;splitAt=null;placing=null;pointer=null;drag=null;ink=[];clearTimeout(pendingTimer);pendingTimer=null;$('landmark-palette').hidden=true;}
  function recoverInk(){if(!active||!Array.isArray(active.pendingInk)||!active.pendingInk.length)return;const pending=active.pendingInk;delete active.pendingInk;const recovered=model.commitStroke(pending,{snapRadius:24,epsilon:3});if(!recovered)model.state.raw.push(pending);active.review=true;persist(true);toast('Interrupted ink recovered. This point is marked for review.');}
  async function selectNote(id){if(transitioning)return false;if(audioBusy){toast('Wait for the microphone to finish opening.');return false;}transitioning=true;$('app').inert=true;try{await stopRecording();commitInk();if(!await flushSave()){toast('This point could not be saved. Export a backup before changing points.');return false;}const next=notes.get(id);if(!next)return false;active=next;model=models.get(id)||new JunctionModel(next.sketch);models.set(id,model);resetTools();recoverInk();render();renderLists();await renderMedia();return true;}finally{transitioning=false;$('app').inert=false;}}
  async function keepNext(){if(!active||transitioning)return false;if(audioBusy){toast('Wait for the microphone to finish opening.');return false;}transitioning=true;$('app').inert=true;try{await stopRecording();commitInk();if(!await flushSave()){toast('This point could not be saved. Export a backup before moving on.');return false;}const previous=active;active=null;model=new JunctionModel();resetTools();render();renderLists();await renderMedia();toast(`Point ${number(previous.number)} kept. Mark the next point when you reach it.`);return true;}finally{transitioning=false;$('app').inert=false;}}
  function units(px){const matrix=svg.getScreenCTM();return matrix?px/Math.hypot(matrix.a,matrix.b):px;}
  function position(e){const matrix=svg.getScreenCTM();if(!matrix)return{x:240,y:240,t:Date.now()};const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse());return{x:Math.max(20,Math.min(460,p.x)),y:Math.max(20,Math.min(460,p.y)),t:Date.now()};}
  function polyline(target,points,attrs){if(points.length<2)return;target.append(make('polyline',{points:points.map(p=>`${p.x},${p.y}`).join(' '),fill:'none','stroke-linejoin':'round','stroke-linecap':'round',...attrs}));}
  function renderTulip(target,m,options={}){
    target.replaceChildren();const state=m.state,roadIds=new Set(state.roads.map(r=>r.id));
    target.append(make('title',{},'Tulip: arrival ball to departure arrow'));
    if(options.fit){const points=Object.values(state.pts).concat(state.landmarks.map(l=>m.landmarkPosition(l)).filter(Boolean));if(points.length){const xs=points.map(p=>p.x),ys=points.map(p=>p.y),minX=Math.min(...xs),minY=Math.min(...ys),w=Math.max(...xs)-minX,h=Math.max(...ys)-minY,size=Math.max(140,w,h)+90;target.setAttribute('viewBox',`${minX-(size-w)/2} ${minY-(size-h)/2} ${size} ${size}`);}else target.setAttribute('viewBox','0 0 480 480');}
    if(options.raw)for(const stroke of state.raw)polyline(target,stroke,{stroke:'#8b97aa','stroke-width':2,'stroke-dasharray':'5 5',opacity:.7});
    for(const road of [...state.roads].sort((a,b)=>Number(a.route)-Number(b.route))){const points=m.roadPoints(road),selected=options.edit&&road.id===selectedRoad;polyline(target,points,{stroke:selected?'#265bca':'#01143c','stroke-width':road.route?8:4,'stroke-dasharray':road.type==='gravel'?(road.route?'13 9':'8 7'):road.type==='track'?(road.route?'1 10':'1 8'):'none'});}
    const start=m.routeStart(),end=m.routeEnd();
    if(start)target.append(make('circle',{cx:start.x,cy:start.y,r:10,fill:'#01143c'}));
    if(end){const p=end.point,q=end.previous,angle=Math.atan2(p.y-q.y,p.x-q.x),size=18;target.append(make('polyline',{points:`${p.x-size*Math.cos(angle-.55)},${p.y-size*Math.sin(angle-.55)} ${p.x},${p.y} ${p.x-size*Math.cos(angle+.55)},${p.y-size*Math.sin(angle+.55)}`,fill:'none',stroke:'#01143c','stroke-width':7,'stroke-linecap':'round','stroke-linejoin':'round'}));}
    for(const landmark of state.landmarks){if(!roadIds.has(landmark.roadId))continue;const p=m.landmarkPosition(landmark);if(!p)continue;const selected=options.edit&&landmark.id===selectedLandmark;target.append(make('circle',{cx:p.x,cy:p.y-2,r:4,fill:selected?'#265bca':'#01143c'}));target.append(make('text',{x:p.x,y:p.y+18,'text-anchor':'middle','font-family':'Arial, sans-serif','font-size':13,'font-weight':600,fill:selected?'#265bca':'#01143c','paint-order':'stroke',stroke:'#fff','stroke-width':5,'stroke-linejoin':'round'},symbols[landmark.symbol]||landmark.symbol));}
    if(options.edit&&mode==='adjust'){for(const [id,p]of Object.entries(state.pts)){target.append(make('circle',{cx:p.x,cy:p.y,r:8,fill:'#fff',stroke:id===selectedPoint?'#265bca':'#6c7d94','stroke-width':2.5}));}if(splitAt&&selectedRoad)target.append(make('circle',{cx:splitAt.x,cy:splitAt.y,r:10,fill:'none',stroke:'#265bca','stroke-width':2,'stroke-dasharray':'3 3'}));}
    if(options.edit&&ink.length){polyline(target,ink,{stroke:'#265bca','stroke-width':model.state.roads.some(r=>r.route)?4:7,opacity:.6});const near=model.hitRoad(ink[0],units(24));if(near)target.append(make('circle',{cx:near.q.x,cy:near.q.y,r:units(14),fill:'#265bca22',stroke:'#265bca','stroke-width':2}));}
    if(options.edit&&drag){const p=drag.kind==='point'?state.pts[drag.id]:m.landmarkPosition(state.landmarks.find(l=>l.id===drag.id));if(p)target.append(make('circle',{cx:p.x,cy:p.y-units(35),r:units(9),fill:'#265bca',opacity:.8}));}
  }
  function render(){
    renderTulip(svg,model,{edit:true,raw:rawVisible});$('empty-state').hidden=model.state.roads.length>0||ink.length>0;$('mark-point').hidden=!!active;
    $('point-title').textContent=active?`Point ${number(active.number)}`:'Ready for the next point';
    $('point-meta').textContent=active?`Marked ${time(active.anchor.markedAt)} · ${active.anchor.location?'GPS ±'+Math.round(active.anchor.location.accuracyM)+' m':'no GPS fix'}`:'Mark it now. Finish the note when you can.';
    $('paper-caption').textContent=active?(active.tripKm===null?'Arrival → exit':active.tripKm.toFixed(3)+' km · trip meter'):'Arrival → exit';
    if(!active)saveStatus(storageReady?'Ready · saved locally':'Ready · export if saving fails',!storageReady);
    else if(savedRevisions.get(active.id)===active.revision)saveStatus('Saved on device');
    $('undo').disabled=!model.canUndo()&&!ink.length;$('redo').disabled=!model.canRedo();
    for(const tool of ['draw','adjust']){$(tool+'-mode').classList.toggle('selected',mode===tool);pressed(tool+'-mode',mode===tool);}pressed('raw-ink',rawVisible);pressed('review-flag',!!active?.review);
    $('edit-extras').hidden=mode!=='adjust';const road=model.state.roads.find(r=>r.id===selectedRoad);
    $('road-tools').hidden=mode!=='adjust'||!road;$('landmark-tools').hidden=mode!=='adjust'||!selectedLandmark;
    $('split-road').disabled=!road||!splitAt;$('unjoin-road').disabled=!road||!selectedPoint||model.state.roads.filter(r=>r.p.includes(selectedPoint)).length<2;
    document.querySelectorAll('[data-surface]').forEach(b=>{const selected=!!road&&road.type===b.dataset.surface;b.classList.toggle('active',selected);b.setAttribute('aria-pressed',String(selected));});
    $('keep-next').disabled=!active;$('preview').disabled=!active;$('review-flag').disabled=!active;
    $('quick-note').value=active?.text||'';$('quick-note').disabled=!ready;
    $('note-count').textContent=notes.size;
  }
  function commitInk(){clearTimeout(pendingTimer);pendingTimer=null;if(!ink.length)return;const stroke=ink;ink=[];pointer=null;const added=model.commitStroke(stroke,{snapRadius:units(24),epsilon:units(3),connectCrossings:true});if(added){persist(true);hint(added.route?'Route set. Pull the other roads out from it.':'Road added. Draw another, or keep this point.');if(navigator.vibrate)navigator.vibrate(8);}else if(active)persist(true);render();}
  function setMode(next){commitInk();mode=next;placing=null;selectedRoad=null;selectedPoint=null;selectedLandmark=null;splitAt=null;$('landmark-palette').hidden=true;$('landmark-mode').setAttribute('aria-expanded','false');hint(next==='adjust'?'Tap a road. Drag a point or landmark to adjust it.':'Draw from an existing road to add a branch.');render();}
  function closestLandmark(p){let best=null;for(const l of model.state.landmarks){const q=model.landmarkPosition(l),d=q?distance(p,q):Infinity;if(d<units(25)&&(!best||d<best.d))best={landmark:l,d};}return best?.landmark||null;}
  svg.addEventListener('contextmenu',e=>e.preventDefault());
  svg.addEventListener('pointerdown',e=>{
    if(!ready||transitioning||pointer!==null||(e.pointerType==='mouse'&&e.button!==0))return;e.preventDefault();const p=position(e);if(!ensurePoint())return;pointer=e.pointerId;svg.setPointerCapture(e.pointerId);
    if(placing){const landmark=model.addLandmark(placing,p);placing=null;pointer=null;if(landmark){persist(true);hint('Landmark placed. Adjust lets you move it.');}render();return;}
    if(mode==='adjust'){
      const landmark=closestLandmark(p);if(landmark){selectedLandmark=landmark.id;selectedRoad=null;selectedPoint=null;drag={kind:'landmark',id:landmark.id,start:p,moved:false};$('selected-landmark').textContent=symbols[landmark.symbol]||landmark.symbol;render();return;}
      selectedLandmark=null;const pid=model.hitPoint(p,units(24)),hit=model.hitRoad(p,units(20));selectedPoint=pid;splitAt=hit?.q||null;
      if(pid){if(!model.state.roads.find(r=>r.id===selectedRoad)?.p.includes(pid))selectedRoad=(hit?.road.p.includes(pid)?hit.road.id:null)||model.state.roads.find(r=>r.p.includes(pid))?.id||null;splitAt={...model.state.pts[pid]};drag={kind:'point',id:pid,start:p,moved:false};}else selectedRoad=hit?.road.id||null;render();return;
    }
    if(pendingTimer){clearTimeout(pendingTimer);pendingTimer=null;if(!ink.length||distance(p,ink[ink.length-1])>units(26)){commitInk();pointer=e.pointerId;}}
    ink.push(p);lastJournal=Date.now();persist();render();
  });
  svg.addEventListener('pointermove',e=>{
    if(e.pointerId!==pointer)return;const p=position(e);
    if(drag){if(!drag.moved&&distance(p,drag.start)>units(3)){model.beginChange();drag.moved=true;splitAt=null;}if(drag.moved){if(drag.kind==='point')model.movePoint(drag.id,p);else model.moveLandmark(drag.id,p);if(Date.now()-lastJournal>200){persist();lastJournal=Date.now();}render();}return;}
    if(mode==='draw'&&ink.length&&distance(p,ink[ink.length-1])>units(1.5)){ink.push(p);if(Date.now()-lastJournal>200){persist();lastJournal=Date.now();}render();}
  });
  function finishPointer(e){if(e.pointerId!==pointer)return;pointer=null;const final=e.type==='pointercancel'?null:position(e);if(drag){if(final&&distance(final,drag.start)>units(3)){if(!drag.moved)model.beginChange();drag.moved=true;splitAt=null;if(drag.kind==='point')model.movePoint(drag.id,final);else model.moveLandmark(drag.id,final);}const moved=drag.moved;drag=null;if(moved)persist(true);render();return;}if(ink.length){if(final&&distance(final,ink[ink.length-1])>.1)ink.push(final);pendingTimer=setTimeout(commitInk,280);render();}}
  svg.addEventListener('pointerup',finishPointer);svg.addEventListener('pointercancel',finishPointer);
  $('draw-mode').onclick=()=>setMode('draw');$('adjust-mode').onclick=()=>setMode('adjust');
  $('undo').onclick=()=>{if(ink.length){clearTimeout(pendingTimer);ink=[];pointer=null;}else model.undo();selectedRoad=null;selectedPoint=null;selectedLandmark=null;splitAt=null;persist(true);render();};
  $('redo').onclick=()=>{commitInk();model.redo();persist(true);render();};
  $('raw-ink').onclick=()=>{rawVisible=!rawVisible;render();};
  $('landmark-mode').onclick=()=>{commitInk();if(!model.state.roads.length){toast('Draw a road first, then place its landmark.');return;}const show=$('landmark-palette').hidden;$('landmark-palette').hidden=!show;$('landmark-mode').setAttribute('aria-expanded',String(show));};
  document.querySelectorAll('[data-symbol]').forEach(button=>button.onclick=()=>{placing=button.dataset.symbol;mode='draw';$('landmark-palette').hidden=true;$('landmark-mode').setAttribute('aria-expanded','false');hint(`Tap beside the road to place: ${symbols[placing]}.`);render();});
  document.querySelectorAll('[data-surface]').forEach(button=>button.onclick=()=>{if(selectedRoad){model.setRoadType(selectedRoad,button.dataset.surface);persist(true);render();}});
  $('split-road').onclick=()=>{if(!selectedRoad||!splitAt)return;const id=model.splitRoad(selectedRoad,splitAt);if(id){selectedRoad=id;selectedPoint=null;splitAt=null;persist(true);hint('Choose the surface of the new section.');render();}else toast('Tap farther from the end of the road to mark a surface change.');};
  $('unjoin-road').onclick=()=>{if(model.disconnectRoad(selectedRoad,selectedPoint)){selectedPoint=null;persist(true);render();hint('Point unjoined. Drag its road clear, or add a bridge label for review.');}};
  $('delete-road').onclick=()=>{if(!selectedRoad)return;model.deleteRoad(selectedRoad);selectedRoad=null;selectedPoint=null;splitAt=null;persist(true);render();hint('Road deleted. Undo restores it.');};
  $('delete-landmark').onclick=()=>{if(!selectedLandmark)return;model.deleteLandmark(selectedLandmark);selectedLandmark=null;persist(true);render();};
  $('reverse-route').onclick=()=>{model.reverseRoute();persist(true);render();hint('Arrival and departure reversed.');};
  $('clear-sketch').onclick=()=>{model.reset();selectedRoad=null;selectedPoint=null;selectedLandmark=null;splitAt=null;persist(true);render();hint('Sketch cleared. Original ink is kept; Undo restores the roads.');};
  $('mark-point').onclick=()=>{markPoint();hint('Point marked. Start drawing where you arrive.');};
  $('keep-next').onclick=keepNext;
  $('review-flag').onclick=()=>{if(active){active.review=!active.review;persist(true);render();renderLists();}};
  function changeText(text){if(!ensurePoint())return;active.text=text.slice(0,100000);$('quick-note').value=active.text;persist();}
  $('quick-note').addEventListener('input',e=>changeText(e.target.value));
  $('note-text').addEventListener('input',e=>{changeText(e.target.value);$('quick-note').value=e.target.value;});
  $('trip-km').addEventListener('input',e=>{if(!active)return;const value=e.target.value===''?null:Number(e.target.value);if(value!==null&&(!Number.isFinite(value)||value<0||value>100000)){e.target.setCustomValidity('Enter a distance between 0 and 100000 km.');return;}e.target.setCustomValidity('');active.tripKm=value;persist();});
  function openDialog(id){commitInk();const dialog=$(id);if(!dialog.open)dialog.showModal();}
  document.querySelectorAll('.close-dialog').forEach(b=>b.onclick=()=>b.closest('dialog').close());
  document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}}));
  function renderLists(){
    const ordered=[...notes.values()].sort((a,b)=>b.number-a.number||b.createdAt.localeCompare(a.createdAt));
    for(const [container,limit]of [[$('notes-list'),5000],[$('recent-notes'),4]]){container.replaceChildren();for(const note of ordered.slice(0,limit)){const button=document.createElement('button');button.type='button';button.className='note-card'+(note.id===active?.id?' active':'');const thumb=document.createElement('span');thumb.className='thumb';const drawing=make('svg',{viewBox:'0 0 480 480','aria-hidden':'true'});renderTulip(drawing,models.get(note.id)||new JunctionModel(note.sketch),{fit:true});thumb.append(drawing);const info=document.createElement('span'),title=document.createElement('strong'),subtitle=document.createElement('small');title.textContent=`Point ${number(note.number)}`;subtitle.textContent=(note.tripKm===null?'':note.tripKm.toFixed(3)+' km · ')+time(note.anchor.markedAt);info.append(title,subtitle);button.append(thumb,info);if(note.review){const flag=document.createElement('span');flag.className='flag';flag.textContent='Needs check';button.append(flag);}button.onclick=async()=>{await selectNote(note.id);$('notes-dialog').close();};container.append(button);}}
    $('notes-empty').hidden=ordered.length>0;$('note-count').textContent=ordered.length;
  }
  $('open-notes').onclick=()=>{commitInk();renderLists();openDialog('notes-dialog');};
  $('new-point').onclick=async()=>{if(transitioning)return;if(active&&!await keepNext())return;$('notes-dialog').close();markPoint();};
  function updateAnchorDetail(){if(!active)return;const a=active.anchor,l=a.location;$('anchor-detail').replaceChildren();for(const text of [`Marked ${new Date(a.markedAt).toLocaleString()}`,l?`${l.lat.toFixed(6)}, ${l.lon.toFixed(6)} · reported accuracy ±${Math.round(l.accuracyM)} m`:'No GPS fix was available at the marked moment.','The original mark stays fixed while you edit.']){const p=document.createElement('div');p.textContent=text;$('anchor-detail').append(p);}}
  function openDetails(){if(!ensurePoint())return;$('detail-number').textContent=`Point ${number(active.number)}`;$('note-text').value=active.text;$('trip-km').value=active.tripKm??'';updateAnchorDetail();openDialog('detail-dialog');renderMedia();}
  $('open-detail').onclick=openDetails;$('detail-done').onclick=async()=>{if(!$('trip-km').reportValidity())return;await flushSave();$('detail-dialog').close();render();renderLists();};
  $('gps-toggle').onclick=()=>{
    if(gpsWatch!==null){navigator.geolocation.clearWatch(gpsWatch);gpsWatch=null;gpsState='off';latestLocation=null;$('gps-toggle').textContent='Enable GPS';pressed('gps-toggle',false);return;}
    if(!navigator.geolocation){toast('GPS is unavailable in this browser. Points can still be marked.');return;}
    gpsState='waiting';$('gps-toggle').textContent='Finding GPS…';pressed('gps-toggle',true);
    gpsWatch=navigator.geolocation.watchPosition(result=>{const c=result.coords;latestLocation={lat:c.latitude,lon:c.longitude,accuracyM:c.accuracy,timestamp:result.timestamp,heading:Number.isFinite(c.heading)?c.heading:null,speed:Number.isFinite(c.speed)?c.speed:null};gpsState='on';$('gps-toggle').textContent=`GPS ±${Math.round(c.accuracy)} m`;$('gps-toggle').setAttribute('aria-label','Disable GPS');},error=>{gpsState='error';if(gpsWatch!==null)navigator.geolocation.clearWatch(gpsWatch);gpsWatch=null;latestLocation=null;pressed('gps-toggle',false);$('gps-toggle').textContent='Retry GPS';toast(error.code===1?'GPS permission was not granted. You can still sketch and mark points.':'No GPS fix yet. Your existing points stay unchanged.');},{enableHighAccuracy:true,maximumAge:5000,timeout:15000});
  };
  async function renderMedia(){
    const generation=++mediaGeneration,target=active?.id;for(const url of mediaURLs)URL.revokeObjectURL(url);mediaURLs=[];$('attachments').replaceChildren();$('detail-media').replaceChildren();$('attachments').hidden=true;if(!target||!storageReady)return;
    try{const list=await db.listMedia(target);if(generation!==mediaGeneration||active?.id!==target)return;$('attachments').hidden=!list.length;for(const item of list){const record=await db.getMedia(item.id);if(generation!==mediaGeneration||active?.id!==target)return;if(!record?.blob)continue;const url=URL.createObjectURL(record.blob);mediaURLs.push(url);const chip=document.createElement('button');chip.type='button';chip.textContent=item.kind==='photo'?'Photo':'Voice note';chip.onclick=openDetails;$('attachments').append(chip);const wrap=document.createElement('div');wrap.className='media-item';if(item.kind==='photo'){const img=document.createElement('img');img.src=url;img.alt='Photo attached to this roadbook point';img.loading='lazy';wrap.append(img);}else if(item.kind==='audio'){const audio=document.createElement('audio');audio.controls=true;audio.preload='metadata';audio.src=url;wrap.append(audio);}const caption=document.createElement('p');caption.textContent=`${item.kind==='photo'?'Added':'Recorded'} ${time(item.createdAt)}`;wrap.append(caption);$('detail-media').append(wrap);}}
    catch(error){console.error(error);toast('Attachments could not be loaded. Try reopening this point.');}
  }
  async function addMedia(target,kind,blob,createdAt,name,mediaId=uid('media-'),refresh=true){
    const record={id:mediaId,noteId:target,kind,blob,createdAt,mimeType:blob.type||'application/octet-stream',name};
    try{await writeQueue;const note=notes.get(target);if(!note)throw new Error('The original point is unavailable.');await db.saveNote(clone(note));const media=await db.putMedia(record);unsavedMedia.delete(mediaId);storageReady=true;if(refresh&&active?.id===target)await renderMedia();return media;}catch(error){unsavedMedia.set(mediaId,record);throw error;}
  }
  $('photo').onclick=()=>{commitInk();if(!ensurePoint())return;photoTarget=active.id;persist(true);$('photo-input').value='';$('photo-input').click();};
  $('photo-input').addEventListener('change',async e=>{const file=e.target.files[0],target=photoTarget;photoTarget=null;if(!file||!target)return;if(!file.type.startsWith('image/')||file.type==='image/svg+xml'){toast('Choose a photo in JPEG, PNG, HEIC or another image format.');return;}if(file.size>20*1024*1024){toast('Choose a photo smaller than 20 MB.');return;}try{await addMedia(target,'photo',file,new Date().toISOString(),file.name);toast('Photo kept with its original point.');}catch(error){storageError(error);download(file,file.name||'roadbook-photo');toast('Photo could not be stored. A separate copy has been downloaded.');}});
  async function startRecording(){
    if(audioBusy||recorder)return;if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){toast('Voice recording is unavailable in this browser. Add a text note or photo.');return;}
    commitInk();if(!ensurePoint())return;audioBusy=true;$('voice').disabled=true;const target=active.id;await flushSave();let stream=null,resolveStop=null;
    try{stream=await navigator.mediaDevices.getUserMedia({audio:true});const preferred=['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg;codecs=opus'].find(m=>MediaRecorder.isTypeSupported(m));recorder=new MediaRecorder(stream,preferred?{mimeType:preferred}:undefined);recordChunks=[];recordingTarget=target;recordingStarted=new Date().toISOString();recordingSave=new Promise(resolve=>resolveStop=resolve);const ownRecorder=recorder,started=recordingStarted;
      const mediaId=uid('media-');let checkpoint=Promise.resolve(),checkpointAt=Date.now();
      ownRecorder.ondataavailable=e=>{if(e.data.size)recordChunks.push(e.data);if(Date.now()-checkpointAt>=5000&&recordChunks.length){checkpointAt=Date.now();const blob=new Blob(recordChunks,{type:ownRecorder.mimeType||'audio/webm'});checkpoint=checkpoint.catch(()=>{}).then(()=>addMedia(target,'audio',blob,started,'voice-note',mediaId,false));checkpoint.catch(error=>console.warn('Audio checkpoint:',error));}};
      ownRecorder.onerror=()=>{toast('Recording was interrupted. Keeping the available audio.');if(ownRecorder.state!=='inactive')ownRecorder.stop();};
      ownRecorder.onstop=async()=>{clearInterval(recordInterval);stream.getTracks().forEach(t=>t.stop());const blob=new Blob(recordChunks,{type:ownRecorder.mimeType||'audio/webm'});recorder=null;recordingTarget=null;$('voice').classList.remove('recording');$('voice-label').textContent='Voice';try{await checkpoint.catch(()=>{});if(blob.size){await addMedia(target,'audio',blob,started,'voice-note',mediaId);toast('Voice note kept.');}}catch(error){storageError(error);download(blob,'voice-note.'+(blob.type.includes('mp4')?'m4a':blob.type.includes('ogg')?'ogg':'webm'));toast('Audio could not be stored. Export a backup to keep the in-memory recording.');}finally{resolveStop();}};
      ownRecorder.start(1000);$('voice').classList.add('recording');$('voice-label').textContent='Stop · 0:00';recordInterval=setInterval(()=>{const seconds=Math.floor((Date.now()-Date.parse(started))/1000);$('voice-label').textContent=`Stop · ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;if(seconds>=600){stopRecording();toast('Ten-minute voice note kept. Start another if needed.');}},500);
    }catch(error){clearInterval(recordInterval);if(stream)stream.getTracks().forEach(track=>track.stop());recorder=null;recordingTarget=null;$('voice').classList.remove('recording');$('voice-label').textContent='Voice';if(resolveStop)resolveStop();toast(error.name==='NotAllowedError'?'Microphone permission was not granted. Your sketch is kept.':'Microphone could not start. Your sketch is kept.');console.error(error);}finally{audioBusy=false;$('voice').disabled=false;}
  }
  async function stopRecording(){if(recorder&&recorder.state!=='inactive')recorder.stop();await recordingSave;}
  $('voice').onclick=()=>recorder?stopRecording():startRecording();
  function partialDistance(){if(!active||active.tripKm===null)return null;const previous=[...notes.values()].filter(n=>n.number<active.number).sort((a,b)=>b.number-a.number)[0];return previous?.tripKm!==null&&previous?.tripKm!==undefined&&active.tripKm>=previous.tripKm?active.tripKm-previous.tripKm:null;}
  function openPreview(){commitInk();if(!active)return;renderTulip($('cell-tulip'),model,{fit:true});$('cell-total').textContent=active.tripKm===null?'—':active.tripKm.toFixed(3);const partial=partialDistance();$('cell-partial').textContent=partial===null?'—':partial.toFixed(3);$('cell-number').textContent=number(active.number);$('cell-text').textContent=active.text||'No text note.';$('preview-warning').textContent=(active.review?'Needs check. ':'')+(model.routeStart()?'Draft symbols and surface patterns. Review against your event’s roadbook conventions.':'No route drawn yet. This point is kept as an incomplete note.');openDialog('preview-dialog');}
  $('preview').onclick=openPreview;$('preview-back').onclick=()=>$('preview-dialog').close();
  function download(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  async function portableMedia(record){const {blob,...meta}=record,bytes=new Uint8Array(await blob.arrayBuffer()),parts=[];for(let i=0;i<bytes.length;i+=32768)parts.push(String.fromCharCode.apply(null,bytes.subarray(i,i+32768)));return {...meta,size:blob.size,base64:btoa(parts.join(''))};}
  function svgBlob(){const target=make('svg',{xmlns:NS,width:480,height:480,viewBox:'0 0 480 480'});renderTulip(target,model,{fit:true});const rect=make('rect',{x:'-100000',y:'-100000',width:'200000',height:'200000',fill:'#fff'});target.prepend(rect);return new Blob([new XMLSerializer().serializeToString(target)],{type:'image/svg+xml'});}
  function exportSVG(){commitInk();if(!active||!model.state.roads.length){toast('Draw a road to export a tulip.');return;}download(svgBlob(),`point-${number(active.number)}-tulip.svg`);}
  $('download-svg').onclick=exportSVG;$('export-svg').onclick=exportSVG;
  $('open-export').onclick=()=>{commitInk();$('download-note').disabled=!active;$('export-svg').disabled=!active||!model.state.roads.length;$('export-raw').disabled=!active||!model.state.raw.length;$('download-backup').disabled=!notes.size;openDialog('export-dialog');};
  $('download-note').onclick=()=>{commitInk();if(!active)return;captureState();download(new Blob([JSON.stringify({format:'rallymaker-point',version:1,canvas:{width:480,height:480,yDirection:'down'},...clone(active)},null,2)],{type:'application/json'}),`point-${number(active.number)}.json`);};
  $('download-backup').onclick=async()=>{const button=$('download-backup');button.disabled=true;$('export-state').textContent='Preparing notes and attachments…';try{await stopRecording();commitInk();await flushSave();let backup,partial=false;try{backup=await db.exportProject();}catch(error){partial=true;backup={format:'rallymaker-roadbook',version:1,exportedAt:new Date().toISOString(),notes:[],media:[],warnings:['Device storage could not be read. This file includes notes and recordings still held in this tab.']};}const latest=new Map(backup.notes.map(n=>[n.id,n]));for(const n of notes.values())latest.set(n.id,clone(n));backup.notes=[...latest.values()];const media=new Map(backup.media.map(m=>[m.id,m]));for(const record of unsavedMedia.values())media.set(record.id,await portableMedia(record));backup.media=[...media.values()];download(new Blob([JSON.stringify(backup)],{type:'application/json'}),`roadbook-backup-${new Date().toISOString().slice(0,10)}.json`);$('export-state').textContent=partial?'Recovery backup downloaded. Some stored attachments could not be read; this file includes current notes and available in-memory media.':'Backup downloaded. It contains original ink and available media.';}catch(error){$('export-state').textContent='Backup failed: '+error.message;}finally{button.disabled=false;}};
  $('export-raw').onclick=()=>{commitInk();if(!active||!model.state.raw.length)return;const canvas=document.createElement('canvas');canvas.width=960;canvas.height=960;const c=canvas.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,960,960);c.scale(2,2);c.strokeStyle='#01143c';c.lineWidth=3;c.lineCap='round';c.lineJoin='round';for(const stroke of model.state.raw){if(!stroke.length)continue;c.beginPath();c.moveTo(stroke[0].x,stroke[0].y);stroke.slice(1).forEach(p=>c.lineTo(p.x,p.y));c.stroke();}const filename=`point-${number(active.number)}-raw.png`;canvas.toBlob(blob=>{if(blob)download(blob,filename);},'image/png');};
  $('import-project').onclick=()=>{$('import-input').value='';$('import-input').click();};
  $('import-input').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;if(file.size>90*1024*1024){toast('Import limit: 50 MB of attachments per backup.');return;}try{await stopRecording();commitInk();await flushSave();const result=await db.importProject(JSON.parse(await file.text()));const loaded=await db.listNotes();for(const n of loaded)if(!notes.has(n.id))notes.set(n.id,n);storageReady=true;renderLists();toast(`Imported ${result.noteCount} points. Existing notes were preserved.`);}catch(error){toast('Import failed: '+error.message);}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){if(ink.length)commitInk();if(drag){drag=null;pointer=null;persist(true);}flushSave();if(recorder)stopRecording();}});
  window.addEventListener('pagehide',()=>{if(active){captureState();try{db.writeDraft(active);}catch(_){}}});
  window.addEventListener('beforeunload',e=>{if(recorder||audioBusy){e.preventDefault();e.returnValue='';}});
  window.addEventListener('keydown',e=>{if(/INPUT|TEXTAREA/.test(e.target.tagName))return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?$('redo').click():$('undo').click();}});
  async function boot(){
    try{await db.open();storageReady=true;for(const note of await db.listNotes()){notes.set(note.id,note);savedRevisions.set(note.id,note.revision);}}catch(error){storageError(error);}
    try{for(const draft of db.readDrafts()){const current=notes.get(draft.id);if(!current||draft.revision>current.revision){notes.set(draft.id,draft);await enqueueSave(draft);}}}catch(error){console.error('Draft recovery:',error);}
    ready=true;$('app').setAttribute('aria-busy','false');const latest=[...notes.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];if(latest){active=latest;model=new JunctionModel(latest.sketch);models.set(latest.id,model);recoverInk();}
    render();renderLists();await renderMedia();
    if('serviceWorker'in navigator&&location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(error=>console.warn('Offline app cache unavailable:',error));
  }
  boot().catch(error=>{ready=true;$('app').setAttribute('aria-busy','false');storageError(error);render();});
})();
