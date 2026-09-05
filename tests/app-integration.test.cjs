/* Runs shipped app.js and NoteMedia against a small DOM and storage port.
 * Verifies lifecycle/ownership across modules; does not emulate layout, permissions,
 * the actual spline editor, or IndexedDB (covered by live browser / other tests). */
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path').resolve(__dirname, '..') + '/';
const RealStore = require('../store.js');
const createMedia = require('../note-media.js');
const clone = x => JSON.parse(JSON.stringify(x));
const empty = () => ({ format: 'spline-v2', aspect: 370 / 405, roads: [], features: [], raw: [] });
const drawing = () => ({ ...empty(), roads: [{ id: 1, route: true, type: 'tarmac', p: [{x:.2,y:.9},{x:.2,y:.6},{x:.5,y:.3},{x:.8,y:.3}] }], raw: [[{x:.2,y:.9,t:123},{x:.8,y:.3,t:124}]] });
const note = (sketch = drawing()) => ({ id:'point-saved', number:1, createdAt:'2026-09-05T10:00:00.000Z', updatedAt:'2026-09-05T10:00:00.000Z', anchor:{markedAt:'2026-09-05T10:00:00.000Z',location:null}, tripKm:null, text:'Saved turn', review:false, revision:2, sketch });
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r}); return {promise,resolve}; };
async function harness(options = {}) {
  const selectors = new Map(), timers = new Map(), local = new Map(), all = [], logs = [], urls = new Map(), downloads = [];
  let timerId = 0, serial = 0;
  class Element {
    constructor(tag='div', attrs={}) {
      this.tagName=tag.toLowerCase();this.attrs={...attrs};this.dataset={};this.listeners={};this.children=[];this.hidden='hidden' in attrs;this.disabled='disabled' in attrs;this.value='';this.textContent='';this.className=attrs.class||'';this.files=[];
      this.classList={toggle:(name,enabled)=>{const c=new Set(this.className.split(' '));if(enabled===undefined)enabled=!c.has(name);enabled?c.add(name):c.delete(name);this.className=[...c].join(' ');return enabled}};
    }
    setAttribute(k,v){this.attrs[k]=String(v)}
    removeAttribute(k){delete this.attrs[k]}
    addEventListener(k,fn){(this.listeners[k]||=[]).push(fn)}
    emit(k,event={}){for(const fn of this.listeners[k]||[])fn({type:k,target:this,preventDefault(){},...event})}
    append(...nodes){nodes.forEach(n=>this.appendChild(n))}
    appendChild(node){node.parent=this;this.children.push(node)}
    replaceChildren(...nodes){this.children=[];this.append(...nodes)}
    remove(){if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1)}
    matches(selector){return selector[0]==='.'?this.className.split(' ').includes(selector.slice(1)):this.tagName===selector}
    querySelector(selector){for(const node of this.children){if(node.matches(selector))return node;const result=node.querySelector(selector);if(result)return result}return null}
    querySelectorAll(selector){return this.children.flatMap(node=>[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)])}
    click(){if(this.disabled)return;if(this.tagName==='a'&&this.download)downloads.push({name:this.download,blob:urls.get(this.href)});this.emit('click');return this.onclick?.({target:this})}
    setCustomValidity(message){this.validation=message}
    reportValidity(){return !this.validation}
    pause(){} load(){}
  }
  const html=fs.readFileSync(path+'index.html','utf8');
  for(const match of html.matchAll(/<([a-z][a-z0-9]*)([^>]*?)>/g)){
    const attrs={};for(const a of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g))attrs[a[1]]=a[2]??'';
    const element=new Element(match[1],attrs);all.push(element);
    for(const name of (attrs.class||'').split(' '))if(name&&!selectors.has('.'+name))selectors.set('.'+name,element);
  }
  const root=new Element(), document=new Element(), window=new Element();
  const get=selector=>{assert.ok(selectors.has(selector),'Missing HTML selector '+selector);return selectors.get(selector)};
  root.querySelector=get;root.querySelectorAll=selector=>selector==='[data-close-sheet]'?all.filter(e=>'data-close-sheet'in e.attrs):all.filter(e=>e.matches(selector));
  document.getElementById=id=>{assert.equal(id,'tulip-thumb-flow');return root};document.createElement=tag=>new Element(tag);document.importNode=node=>node;document.body=new Element('body');
  get('.tt-gps-toggle').append(new Element('span'));
  const durable=new Map((options.notes||[]).map(n=>[n.id,clone(n)])), drafts=new Map((options.drafts||[]).map(n=>[n.id,clone(n)])), attachments=new Map();
  const control={failSave:false,failMedia:false,failExport:false,saveGate:null};
  class Store {
    static migrateSketch(s){return RealStore.migrateSketch(clone(s))}
    async open(){}
    async listNotes(){return [...durable.values()].map(clone)}
    readDrafts(){return [...drafts.values()].map(clone)}
    writeDraft(n){drafts.set(n.id,RealStore.validateNote(clone(n)))}
    clearDraft(id,revision){if(drafts.get(id)?.revision===revision)drafts.delete(id)}
    async saveNote(n){logs.push(['save-start',n.id]);if(control.saveGate)await control.saveGate.promise;if(control.failSave)throw new Error('Quota exceeded');durable.set(n.id,RealStore.validateNote(clone(n)));logs.push(['save-committed',n.id])}
    async putMedia(record){assert.ok(durable.has(record.noteId),'Media owner must be durable before blob write');if(control.failMedia)throw new Error('Media quota exceeded');attachments.set(record.id,record);logs.push(['media-committed',record.noteId]);return record}
    async listMedia(id){return [...attachments.values()].filter(m=>m.noteId===id).map(({blob,...meta})=>meta)}
    async getMedia(id){return attachments.get(id)}
    async deleteMedia(id){attachments.delete(id)}
    async exportProject(){if(control.failExport)throw new Error('Database read failed');return {format:'rallymaker-roadbook',version:1,exportedAt:new Date().toISOString(),notes:[...durable.values()].map(clone),media:await Promise.all([...attachments.values()].map(async({blob,...meta})=>({...meta,size:blob.size,base64:Buffer.from(await blob.arrayBuffer()).toString('base64')})))}}
  }
  if(options.last!==undefined)local.set('rallymaker:last-point',options.last);
  let state=empty();const loaded=[];
  const editor={getState:()=>clone(state),setState:s=>{state=clone(s);loaded.push(clone(s))},commitPending(){},exportSVG:()=>'<svg xmlns="http://www.w3.org/2000/svg"></svg>'};
  const URL={createObjectURL:blob=>{const id='blob:test-'+(++serial);urls.set(id,blob);return id},revokeObjectURL:id=>urls.delete(id)};
  const setTimeout=(fn,delay)=>{timers.set(++timerId,{fn,delay});return timerId},clearTimeout=id=>timers.delete(id);
  const localStorage={getItem:key=>local.get(key)??null,setItem:(key,value)=>local.set(key,String(value))};
  Object.assign(window,{document,Blob,URL,crypto:{randomUUID:()=>`test-${++serial}`},navigator:{},setTimeout,clearTimeout,setInterval:()=>0,clearInterval(){},TulipEditor:editor});
  const media=createMedia(window);assert.ok(media);window.NoteMedia=media;
  const context={window,document,navigator:window.navigator,RoadbookStore:Store,crypto:window.crypto,localStorage,Blob,URL,Uint8Array,btoa:s=>Buffer.from(s,'binary').toString('base64'),DOMParser:class{parseFromString(){return {documentElement:new Element('svg')}}},setTimeout,clearTimeout,console};
  vm.runInNewContext(fs.readFileSync(path+'app.js','utf8'),context,{filename:'app.js'});
  const settle=async()=>{for(let i=0;i<70;i++)await Promise.resolve()};await settle();
  const click=async selector=>{await get(selector).click();await settle()};
  const flush=async()=>{for(const[id,timer]of [...timers])if(timer.delay<=250&&timers.has(id)){timers.delete(id);timer.fn()}await settle()};
  const text=async value=>{get('.tt-note-text').value=value;get('.tt-note-text').emit('input');await settle()};
  const draw=async()=>{get('.tt-sketch').emit('pointerdown');state=drawing();root.emit('sketchchange');await settle()};
  const photo=async()=>{const blob=new Blob(['photo bytes'],{type:'image/jpeg'});blob.name='junction.jpg';get('.tt-note-photo-input').files=[blob];get('.tt-note-photo-input').emit('change');await settle()};
  return {get,root,window,click,text,draw,photo,flush,settle,durable,drafts,attachments,control,logs,media,downloads,local,loaded,state:()=>clone(state)};
}

test('restoring a committed point immediately reports Saved on device without rewriting it',async()=>{
  const original=note(),h=await harness({notes:[original],last:original.id});
  assert.equal(h.get('.tt-point-title').textContent,'Point 01');assert.equal(h.get('.tt-save-state').textContent,'Saved on device');
  assert.equal(h.get('.tt-note-text').value,'Saved turn');assert.deepEqual(h.state(),original.sketch);assert.equal(h.logs.length,0);
});

test('legacy restore preserves the original drawing and stores both formats only after an edit',async()=>{
  const sketch={pts:{a:{x:120,y:400},b:{x:120,y:200},c:{x:350,y:200}},roads:[{id:'r',p:['a','b','c'],type:'gravel',route:true}],landmarks:[],crossings:[],raw:[[{x:120,y:400,t:100},{x:350,y:200,t:200}]]};
  const original=note(sketch),h=await harness({notes:[original]});
  assert.equal(h.state().format,'spline-v2');assert.equal(h.state().aspect,1);assert.equal(h.state().roads.length,2);
  assert.deepEqual(h.durable.get(original.id),original);assert.equal(h.logs.length,0);
  await h.text('Edited legacy point');await h.flush();
  const saved=h.durable.get(original.id);assert.deepEqual(saved.legacySketch,sketch);assert.equal(saved.sketch.format,'spline-v2');assert.deepEqual(saved.anchor,original.anchor);
});

test('drawing and text survive Done, Keep next, and reopening without creating phantom points',async()=>{
  const h=await harness();await h.draw();await h.text('House left, take right fork');await h.flush();
  const saved=[...h.durable.values()][0],anchor=clone(saved.anchor);
  h.root.emit('finishpoint');await h.settle();assert.equal(h.get('.tt-review').hidden,false);assert.equal(h.get('.tt-review-text').textContent,'House left, take right fork');
  await h.click('.tt-keep-next');assert.equal(h.get('.tt-point-title').textContent,'New point');assert.equal(h.get('.tt-note-text').value,'');assert.equal(h.state().roads.length,0);assert.equal(h.durable.size,1);
  await h.click('.tt-open-points');const button=h.get('.tt-point-list').children[0];await button.click();await h.settle();
  assert.equal(h.get('.tt-point-title').textContent,'Point 01');assert.equal(h.get('.tt-note-text').value,'House left, take right fork');assert.deepEqual(h.state(),saved.sketch);assert.deepEqual(h.durable.get(saved.id).anchor,anchor);assert.equal(h.get('.tt-save-state').textContent,'Saved on device');
});

test('a failed point save blocks Keep next and preserves draft, text and sketch for retry',async()=>{
  const h=await harness();h.control.failSave=true;await h.draw();await h.text('Unsaved fork');await h.click('.tt-keep-next');
  assert.equal(h.get('.tt-point-title').textContent,'Point 01');assert.equal(h.get('.tt-note-text').value,'Unsaved fork');assert.equal(h.state().roads.length,1);assert.equal(h.durable.size,0);assert.equal(h.drafts.size,1);assert.equal(h.get('.tt-save-state').textContent,'Not saved');assert.equal(h.get('.tt-phone').inert,false);
  h.control.failSave=false;await h.click('.tt-keep-next');assert.equal(h.get('.tt-point-title').textContent,'New point');assert.equal(h.durable.size,1);assert.equal([...h.durable.values()][0].text,'Unsaved fork');
});

test('opening the camera freezes point ownership synchronously and blob writes wait for note commit',async()=>{
  const h=await harness(),gate=deferred();h.control.saveGate=gate;
  h.get('.tt-note-photo').click();
  assert.equal(h.get('.tt-point-title').textContent,'Point 01');assert.equal(h.drafts.size,1,'Owner is journalled before chooser opens');
  const owner=[...h.drafts.keys()][0];await h.photo();assert.equal(h.attachments.size,0);assert.equal(h.durable.size,0);
  gate.resolve();await h.media.finish();await h.settle();
  assert.equal(h.attachments.size,1);assert.equal([...h.attachments.values()][0].noteId,owner);
  const noteCommit=h.logs.findIndex(([action,id])=>action==='save-committed'&&id===owner),mediaCommit=h.logs.findIndex(([action])=>action==='media-committed');assert.ok(noteCommit>=0&&mediaCommit>noteCommit);
});

test('a delayed camera result stays with its original point after another point is opened',async()=>{
  const h=await harness();h.get('.tt-note-photo').click();const owner=[...h.drafts.keys()][0];await h.settle();
  await h.click('.tt-keep-next');await h.text('Second point');await h.flush();assert.equal(h.get('.tt-point-title').textContent,'Point 02');
  await h.photo();await h.media.finish();await h.settle();
  assert.equal([...h.attachments.values()][0].noteId,owner);assert.equal(h.get('.tt-note-text').value,'Second point');assert.equal(h.get('.tt-note-attachments').children.length,0);
  assert.equal(h.durable.get(owner).text,'');assert.equal(h.durable.size,2);
});

test('backup recovers current unsaved text/sketch and attachment bytes when database reads fail',async()=>{
  const h=await harness();h.control.failSave=true;h.control.failMedia=true;h.control.failExport=true;
  await h.draw();await h.text('Keep the original evidence');h.get('.tt-note-photo').click();await h.photo();await h.media.finish();
  assert.equal(h.media.hasUnsaved(),true);await h.click('.tt-backup');assert.equal(h.downloads.length,1);
  const backup=JSON.parse(await h.downloads[0].blob.text());assert.equal(backup.format,'rallymaker-roadbook');assert.match(backup.recoveryWarning,/Database could not be read/);assert.equal(backup.notes.length,1);assert.equal(backup.notes[0].text,'Keep the original evidence');assert.equal(backup.notes[0].sketch.roads.length,1);assert.equal(backup.media.length,1);assert.equal(backup.media[0].noteId,backup.notes[0].id);assert.equal(Buffer.from(backup.media[0].base64,'base64').toString(),'photo bytes');
  assert.match(h.get('.tt-options-status').textContent,/Recovery downloaded/);assert.equal(h.get('.tt-phone').inert,false);
});

test('a newer recovery draft is saved and restored ahead of an older durable point',async()=>{
  const original=note(),draft={...clone(original),text:'Recovered edit',revision:3};const h=await harness({notes:[original],drafts:[draft]});
  assert.equal(h.get('.tt-note-text').value,'Recovered edit');assert.equal(h.durable.get(original.id).revision,3);assert.equal(h.drafts.size,0);assert.equal(h.get('.tt-save-state').textContent,'Saved on device');
});
