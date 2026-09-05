const fs=require('node:fs');
const vm=require('node:vm');
const test=require('node:test');
const assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../editor.js'),'utf8');
class Element{
 constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.style={setProperty(){}};this.attrs={};this.listeners={};this.hidden=false;this.value='';this.classList={toggle(){}};this.rect={left:0,top:0,width:370,height:405}}
 append(...nodes){for(const n of nodes)n.parent=this;this.children.push(...nodes)}
 replaceChildren(...nodes){this.children=[];this.append(...nodes)}
 replaceWith(n){const index=this.parent.children.indexOf(this);n.parent=this.parent;this.parent.children[index]=n}
 setAttribute(k,v){this.attrs[k]=String(v);if(k.startsWith('data-'))this.dataset[k.slice(5)]=String(v)}
 getAttribute(k){return this.attrs[k]??null}
 removeAttribute(k){delete this.attrs[k]}
 querySelectorAll(q){return this.children.flatMap(n=>[...(q==='[data-feature]'?n.dataset.feature?[n]:[]:n.tag===q?[n]:[]),...n.querySelectorAll(q)])}
 querySelector(q){return this.querySelectorAll(q)[0]||null}
 addEventListener(k,f){this.listeners[k]=f}
 dispatchEvent(e){this.listeners[e.type]?.(e);return true}
 setPointerCapture(){}hasPointerCapture(){return false}
 getBoundingClientRect(){return {...this.rect,...this.style.width?{width:parseFloat(this.style.width)}:{},...this.style.height?{height:parseFloat(this.style.height)}:{},...this.style.left?{left:parseFloat(this.style.left)}:{},...this.style.top?{top:parseFloat(this.style.top)}:{}}}
 cloneNode(deep){const n=new Element(this.tag);n.attrs={...this.attrs};n.dataset={...this.dataset};if(deep)n.append(...this.children.map(c=>c.cloneNode(true)));return n}
}
function setup(storage=new Map()){
 const nodes=new Map(),root=new Element(),events=[];root.querySelector=s=>{if(!nodes.has(s))nodes.set(s,new Element(s==='.tt-sketch'?'svg':'div'));return nodes.get(s)};
 const find=s=>root.querySelector(s);find('.tt-picker').hidden=true;find('.tt-add').hidden=true;
 const surfaces=['tarmac','gravel','track'].map(type=>{const n=new Element('button');n.dataset.surface=type;return n});root.querySelectorAll=q=>q==='[data-surface]'?surfaces:[];
 root.dispatchEvent=e=>events.push(e.type);
 const tasks=new Map();let taskId=0;
 const context={document:{getElementById:()=>root,createElement:t=>new Element(t),createElementNS:(_,t)=>new Element(t)},ResizeObserver:class{constructor(f){this.f=f}observe(){}},CustomEvent:class{constructor(type){this.type=type}},setTimeout:f=>{tasks.set(++taskId,f);return taskId},clearTimeout:id=>tasks.delete(id),console,localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},XMLSerializer:class{serializeToString(n){return `<${n.tag} ${Object.entries(n.attrs).map(([k,v])=>`${k}="${v}"`).join(' ')}>${n.children.map(c=>this.serializeToString(c)).join('')}</${n.tag}>`}}};
 vm.createContext(context);vm.runInContext(source,context);
 const svg=find('.tt-sketch'),api=context.TulipEditor;
 const event=(x,y)=>({pointerId:1,isPrimary:true,clientX:x,clientY:y,preventDefault(){}});
 const down=(x,y)=>svg.listeners.pointerdown(event(x,y)),move=(x,y)=>svg.listeners.pointermove(event(x,y)),up=(x,y)=>svg.listeners.pointerup(event(x,y));
 const tap=(x,y)=>{down(x,y);up(x,y)};
 const stroke=(points,commit=true)=>{down(...points[0]);for(const p of points.slice(1))move(...p);up(...points.at(-1));if(commit)api.commitPending()};
 const click=n=>n.onclick({preventDefault(){}});
 return{api,svg,events,storage,find,click,tap,stroke,down,move,up,event,tasks,surfaces,favourite:type=>find('.tt-favourites').children.find(n=>n.dataset.feature===type)};
}
const plain=o=>JSON.parse(JSON.stringify(o));
const bez=(p,t)=>{const u=1-t;return{x:u*u*u*p[0].x+3*u*u*t*p[1].x+3*u*t*t*p[2].x+t*t*t*p[3].x,y:u*u*u*p[0].y+3*u*u*t*p[1].y+3*u*t*t*p[2].y+t*t*t*p[3].y}};
const onCanvas=p=>[p.x*370,p.y*405];
const fixture=()=>({format:'spline-v2',aspect:370/405,roads:[{id:'main',type:'tarmac',route:true,p:[{x:.42,y:.88},{x:.42,y:.64},{x:.54,y:.43},{x:.72,y:.15}]}],features:[],raw:[]});

test('empty start, state hooks, save events only for completed changes and Done does not clear',()=>{
 const h=setup();assert.equal(h.api.hasContent(),false);assert.equal(h.api.getState().roads.length,0);assert.equal(h.find('.tt-undo').disabled,true);assert.deepEqual(h.events,[]);
 h.stroke([[100,340],[120,250],[160,170],[210,100]],false);assert.deepEqual(h.events,[]);assert.equal(h.api.getState().roads.length,0);
 h.api.commitPending();const state=h.api.getState();assert.equal(state.roads.length,1);assert.equal(state.roads[0].route,true);assert.equal(state.roads[0].p.length,4);assert.equal(state.raw.length,1);assert.deepEqual(h.events,['sketchchange']);
 h.api.render();assert.equal(h.events.length,1);h.click(h.find('.tt-done'));assert.equal(h.events.at(-1),'finishpoint');assert.equal(h.api.getState().roads.length,1);
 h.api.setState(state);assert.equal(h.find('.tt-undo').disabled,true);assert.equal(h.events.length,2);
});

test('fork start and finish snap to actual cubic without changing parent curve',()=>{
 const h=setup(),state=fixture();h.api.setState(state);const q=bez(state.roads[0].p,.49),start=onCanvas(q);
 h.stroke([start,[start[0]-30,start[1]-30],[75,155],[45,100]]);
 let loaded=h.api.getState(),fork=loaded.roads[1];assert.deepEqual(plain(loaded.roads[0].p),state.roads[0].p);assert.equal(fork.attach.id,'main');
 let junction=bez(loaded.roads[0].p,fork.attach.t);assert.ok(Math.hypot(fork.p[0].x-junction.x,fork.p[0].y-junction.y)<1e-8);
 const finish=onCanvas(bez(state.roads[0].p,.75));h.stroke([[330,300],[340,250],[300,170],finish]);loaded=h.api.getState();const endRoad=loaded.roads.at(-1);
 assert.equal(endRoad.endAttach.id,'main');junction=bez(loaded.roads[0].p,endRoad.endAttach.t);assert.ok(Math.hypot(endRoad.p[3].x-junction.x,endRoad.p[3].y-junction.y)<1e-8);assert.deepEqual(plain(loaded.roads[0].p),state.roads[0].p);
});

test('generous road selection, blank dismissal, selected delete and raw-preserving clear undo',()=>{
 const h=setup(),state=fixture();h.api.setState(state);let q=onCanvas(bez(state.roads[0].p,.5));h.tap(q[0]+20,q[1]);assert.equal(h.find('.tt-context').hidden,false);
 h.tap(330,350);assert.equal(h.find('.tt-context').hidden,true);
 h.stroke([[55,310],[65,260],[72,190],[55,125]]);const before=h.api.getState();h.tap(q[0],q[1]);h.click(h.find('.tt-delete'));assert.equal(h.api.getState().roads.length,1);assert.equal(h.api.getState().raw.length,1);
 h.click(h.find('.tt-quick'));assert.equal(h.api.getState().roads.length,2);
 h.click(h.find('.tt-clear'));assert.equal(h.api.getState().roads.length,0);assert.deepEqual(plain(h.api.getState().raw),plain(before.raw));assert.equal(h.find('.tt-quick').hidden,false);
 h.click(h.find('.tt-quick'));assert.deepEqual(plain(h.api.getState()),plain(before));
});

test('dragging a shared junction preserves both attachments and independent fork tangent',()=>{
 const h=setup(),state=fixture();h.api.setState(state);const q=onCanvas(bez(state.roads[0].p,.5));h.stroke([q,[q[0]-25,q[1]-30],[70,130],[45,80]]);
 const fork=h.api.getState().roads[1],mid=onCanvas(bez(fork.p,.5));h.tap(...mid);const start=onCanvas(fork.p[0]);h.down(...start);h.move(start[0]+16,start[1]+8);h.up(start[0]+16,start[1]+8);
 const result=h.api.getState(),child=result.roads[1],parent=result.roads[0],joined=bez(parent.p,child.attach.t);assert.ok(Math.hypot(child.p[0].x-joined.x,child.p[0].y-joined.y)<1e-8);
 const beforeDirection={x:fork.p[1].x-fork.p[0].x,y:fork.p[1].y-fork.p[0].y},afterDirection={x:child.p[1].x-child.p[0].x,y:child.p[1].y-child.p[0].y};assert.ok(Math.hypot(afterDirection.x-beforeDirection.x,afterDirection.y-beforeDirection.y)<1e-8);
});

test('short lift continues one stroke, while tap after lift selects completed road',()=>{
 const h=setup();h.stroke([[100,330],[110,260],[140,210]],false);h.down(142,208);h.move(170,160);h.up(210,100);h.api.commitPending();assert.equal(h.api.getState().roads.length,1);assert.equal(h.api.getState().raw.length,1);
 h.click(h.find('.tt-undo'));assert.equal(h.api.getState().roads.length,0);
 h.stroke([[100,330],[110,260],[140,210]],false);h.tap(140,210);assert.equal(h.api.getState().roads.length,1);assert.equal(h.find('.tt-context').hidden,false);
});

test('point and line landmarks, search, fixed favourites and persistent reorder',()=>{
 const h=setup();h.click(h.favourite('house'));h.tap(290,300);assert.equal(h.api.getState().features[0].type,'house');assert.equal(h.find('.tt-pen').attrs['aria-pressed'],'true');
 h.click(h.favourite('hedge'));h.stroke([[220,170],[245,190],[270,195],[300,215]]);assert.equal(h.api.getState().features[1].type,'hedge');assert.equal(h.api.getState().raw.length,1);assert.equal(h.api.getState().roads.length,0);
 h.click(h.find('.tt-arrange'));h.find('.tt-landmark-search').value='river';h.find('.tt-landmark-search').oninput();assert.equal(h.find('.tt-picker-results').children.length,1);assert.equal(h.find('.tt-picker-results').children[0].dataset.feature,'water');
 h.find('.tt-landmark-search').value='';h.find('.tt-landmark-search').oninput();h.click(h.find('.tt-picker-manage'));h.click(h.find('.tt-picker-results').children.find(n=>n.dataset.feature==='tree'));h.click(h.find('.tt-order-right'));
 const another=setup(h.storage);assert.equal(another.find('.tt-favourites').children[1].dataset.feature,'tree');assert.equal(another.find('.tt-favourites').children.length,4);
});

test('loaded aspect preserved, multi-piece route arrow uses final segment, and SVG excludes edit UI',()=>{
 const h=setup(),s=fixture();s.aspect=1;s.roads[0].p=[{x:.5,y:.9},{x:.5,y:.7},{x:.5,y:.6},{x:.5,y:.5}];s.roads.push({id:'route-2',route:true,type:'gravel',p:[{x:.5,y:.5},{x:.5,y:.4},{x:.7,y:.3},{x:.8,y:.2}]});h.api.setState(s);
 assert.equal(h.api.getState().aspect,1);assert.match(h.svg.children[3].attrs.d,/L296 74 L/);h.tap(185,220);assert.equal(h.find('.tt-context').hidden,false);
 const exported=h.api.exportSVG();assert.match(exported,/viewBox="0 0 370 370"/);assert.doesNotMatch(exported,/#245fce|foreignObject|polyline/);assert.equal(h.find('.tt-context').hidden,false);
});

test('fresh paper fills its viewport and saved paper has a physically fitted drawing target',()=>{
 const h=setup();h.find('.tt-paper').rect={left:0,top:0,width:320,height:620};h.api.setState({format:'spline-v2',roads:[],features:[],raw:[]});
 assert.equal(h.api.getState().aspect,320/620);assert.equal(h.svg.getBoundingClientRect().height,620);
 h.stroke([[160,550],[160,450],[190,260],[220,80]]);const saved=h.api.getState();
 h.find('.tt-paper').rect={left:0,top:0,width:540,height:300};h.api.setState(saved);
 assert.equal(h.api.getState().aspect,320/620);assert.equal(h.svg.getBoundingClientRect().height,300);assert.ok(h.svg.getBoundingClientRect().width<155);
 const state=fixture();state.aspect=1;h.api.setState(state);const target=h.svg.getBoundingClientRect();assert.equal(target.width,target.height);assert.equal(target.width,300);assert.equal(target.left,120);
});
