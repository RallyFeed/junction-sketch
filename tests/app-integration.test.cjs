/* Dependency-free DOM/event harness; exercises the shipped app.js with real model.js.
 * It does not replace browser layout, permission, media, or IndexedDB testing. */
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path').resolve(__dirname, '..') + '/';
const Model = require(path+'model.js');
const clone=x=>JSON.parse(JSON.stringify(x));
async function app() {
  const html=fs.readFileSync(path+'index.html','utf8'), elements=new Map(), selectors=new Map(), timers=new Map(), instances=[];
  let timerId=0;
  class Element {
    constructor(tag='div',attrs={}) {this.tagName=tag.toUpperCase();this.attrs={...attrs};this.dataset={};this.listeners={};this.children=[];this.hidden='hidden'in attrs;this.disabled='disabled'in attrs;this.value='';this.textContent='';this.open=false;this.classes=new Set((attrs.class||'').split(' '));this.classList={toggle:(c,b)=>b===undefined?this.classes.has(c)?this.classes.delete(c):this.classes.add(c):b?this.classes.add(c):this.classes.delete(c),add:c=>this.classes.add(c),remove:c=>this.classes.delete(c)};for(const [k,v]of Object.entries(attrs))if(k.startsWith('data-'))this.dataset[k.slice(5)]=v;}
    setAttribute(k,v){this.attrs[k]=String(v);}
    addEventListener(k,fn){(this.listeners[k]||=[]).push(fn);}
    dispatch(k,event={}){event={type:k,pointerId:1,pointerType:'touch',button:0,target:this,preventDefault(){},...event};for(const fn of this.listeners[k]||[])fn(event);}
    append(...nodes){this.children.push(...nodes);}
    prepend(...nodes){this.children.unshift(...nodes);}
    replaceChildren(...nodes){this.children=nodes;}
    getScreenCTM(){return {a:1,b:0,inverse(){return this;}};}
    setPointerCapture(){} releasePointerCapture(){} remove(){}
    getBoundingClientRect(){return {left:0,top:0,right:480,bottom:480,width:480,height:480};}
    showModal(){this.open=true;}close(){this.open=false;}
    closest(){return elements.get('notes-dialog');}
    setCustomValidity(s){this.validation=s;}reportValidity(){return !this.validation;}
    click(){if(!this.disabled)return this.onclick?.({target:this});}
  }
  const all=[];
  for(const match of html.matchAll(/<([a-z][a-z0-9]*)([^>]*?)>/g)){
    const attrs={};for(const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g))attrs[attr[1]]=attr[2]??'';
    const el=new Element(match[1],attrs);all.push(el);if(attrs.id)elements.set(attrs.id,el);
  }
  selectors.set('[data-symbol]',all.filter(e=>'symbol'in e.dataset));selectors.set('[data-surface]',all.filter(e=>'surface'in e.dataset));selectors.set('.close-dialog',all.filter(e=>e.classes.has('close-dialog')));selectors.set('dialog',all.filter(e=>e.tagName==='DIALOG'));
  const document=new Element();document.body=new Element('body');document.getElementById=id=>{assert.ok(elements.has(id),'Missing HTML id '+id);return elements.get(id);};document.querySelectorAll=s=>selectors.get(s)||[];document.createElement=t=>new Element(t);document.createElementNS=(_,t)=>new Element(t);
  class TrackingModel extends Model {constructor(data){super(data);instances.push(this);}}
  const saved=new Map(),drafts=new Map();
  class Store {async open(){}async listNotes(){return [...saved.values()].map(clone);}readDrafts(){return [];}writeDraft(n){drafts.set(n.id,clone(n));}clearDraft(id){drafts.delete(id);}async saveNote(n){saved.set(n.id,clone(n));}async listMedia(){return [];}async exportProject(){return {notes:[...saved.values()].map(clone),media:[]};}}
  const context={document,window:new Element(),navigator:{vibrate(){}},location:{protocol:'http:'},JunctionModel:TrackingModel,RoadbookStore:Store,crypto:require('node:crypto').webcrypto,DOMPoint:class {constructor(x,y){this.x=x;this.y=y;}matrixTransform(){return this;}},console,Blob,URL,Uint8Array,Date,Map,Set,Promise,Math,Number,Array,Object,String,JSON,setTimeout:(fn,delay)=>{timers.set(++timerId,{fn,delay});return timerId;},clearTimeout:id=>timers.delete(id),setInterval:()=>0,clearInterval(){}};
  vm.runInNewContext(fs.readFileSync(path+'app.js','utf8'),context,{filename:'app.js'});
  const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};await settle();
  const click=async id=>{const result=elements.get(id).click();if(result?.then)await result;await settle();};
  const fire=(type,x,y)=>elements.get('drawing').dispatch(type,{clientX:x,clientY:y});
  const finish=async()=>{const ready=[...timers.entries()].filter(([,t])=>t.delay<=300);for(const[id,t]of ready)if(timers.has(id)){timers.delete(id);t.fn();}await settle();};
  const stroke=async points=>{fire('pointerdown',...points[0]);for(const p of points.slice(1))fire('pointermove',...p);fire('pointerup',...points.at(-1));await finish();};
  return {click,fire,finish,stroke,settle,elements,selectors,saved,model:()=>instances.at(-1)};
}

test('ordinary mark / route / branch / undo / split / landmark / reverse / keep-next flow',async()=>{
  const a=await app();await a.click('mark-point');
  await a.stroke([[240,400],[240,240],[380,150]]);let m=a.model();assert.equal(m.state.roads.length,1);assert.equal(m.state.roads[0].route,true);
  await a.stroke([[240,240],[100,240]]);assert.equal(m.state.roads.length,2);assert.ok(m.state.roads[0].p.includes(m.state.roads[1].p[0]));
  await a.click('undo');assert.equal(m.state.roads.length,1);await a.click('redo');assert.equal(m.state.roads.length,2);
  await a.click('adjust-mode');a.fire('pointerdown',240,320);a.fire('pointerup',240,320);await a.click('split-road');assert.equal(m.state.roads.length,3);
  a.selectors.get('[data-surface]').find(e=>e.dataset.surface==='gravel').click();assert.equal(m.state.roads.filter(r=>r.route)[1].type,'gravel');
  await a.click('landmark-mode');a.selectors.get('[data-symbol]').find(e=>e.dataset.symbol==='house').click();a.fire('pointerdown',280,320);a.fire('pointerup',280,320);assert.equal(m.state.landmarks.length,1);
  await a.click('adjust-mode');a.fire('pointerdown',280,320);a.fire('pointermove',290,330);a.fire('pointerup',300,335);
  assert.deepEqual(clone(m.landmarkPosition(m.state.landmarks[0])),{x:300,y:335});
  await a.click('undo');assert.deepEqual(clone(m.landmarkPosition(m.state.landmarks[0])),{x:280,y:320});
  await a.click('redo');const p=m.landmarkPosition(m.state.landmarks[0]);await a.click('reverse-route');assert.deepEqual(m.landmarkPosition(m.state.landmarks[0]),p);
  await a.click('keep-next');assert.equal(a.model().state.roads.length,0);assert.equal(a.saved.size,1);assert.equal([...a.saved.values()][0].sketch.landmarks.length,1);
  await a.click('mark-point');assert.equal(a.elements.get('point-title').textContent,'Point 02');
});

test('quick restart near the previous lift continues the same stroke',async()=>{
  const a=await app();await a.click('mark-point');a.fire('pointerdown',240,400);a.fire('pointermove',240,300);a.fire('pointerup',240,300);a.fire('pointerdown',244,296);a.fire('pointermove',380,160);a.fire('pointerup',380,160);await a.finish();
  assert.equal(a.model().state.roads.length,1);assert.equal(a.model().state.raw.length,1);assert.equal(a.model().routeEnd().point.x,380);
});

test('release coordinates are the end of the committed stroke',async()=>{
  const a=await app();await a.click('mark-point');a.fire('pointerdown',240,400);a.fire('pointermove',240,300);a.fire('pointerup',360,150);await a.finish();
  assert.deepEqual(clone(a.model().routeEnd().point),{x:360,y:150});
});

test('moving a point clears the old surface-change marker',async()=>{
  const a=await app();await a.click('mark-point');await a.stroke([[240,400],[240,240],[380,150]]);await a.click('adjust-mode');
  a.fire('pointerdown',240,240);a.fire('pointermove',300,260);a.fire('pointerup',300,260);
  assert.equal(a.elements.get('split-road').disabled,true);
});

test('a fast double Keep-next never throws or creates a new point',async()=>{
  const a=await app();await a.click('mark-point');await a.stroke([[240,400],[240,200]]);
  const results=await Promise.allSettled([a.elements.get('keep-next').click(),a.elements.get('keep-next').click()]);
  assert.equal(results.some(r=>r.status==='rejected'),false,results.filter(r=>r.status==='rejected').map(r=>String(r.reason)).join());assert.equal(a.saved.size,1);
});

test('selection belongs to the point being dragged when two roads are close',async()=>{
  const a=await app();await a.click('mark-point');const m=a.model();
  const r1=m.commitStroke([{x:100,y:100},{x:100,y:300}],{snapRadius:0});
  const r2=m.commitStroke([{x:120,y:220},{x:300,y:220}],{snapRadius:0});
  await a.click('adjust-mode');a.fire('pointerdown',120,200);a.fire('pointerup',120,200);
  a.selectors.get('[data-surface]').find(e=>e.dataset.surface==='gravel').click();
  assert.equal(m.state.roads.find(r=>r.id===r2.id).type,'gravel');assert.equal(m.state.roads.find(r=>r.id===r1.id).type,'tarmac');
});

test('pointer cancellation preserves available ink without inventing a release coordinate',async()=>{
  const a=await app();await a.click('mark-point');a.fire('pointerdown',240,400);a.fire('pointermove',240,300);a.fire('pointercancel',0,0);await a.finish();
  assert.deepEqual(clone(a.model().routeEnd().point),{x:240,y:300});
  await a.stroke([[240,350],[100,350]]);assert.equal(a.model().state.roads.length,2);
});
