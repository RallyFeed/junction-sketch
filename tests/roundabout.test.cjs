const test=require('node:test');
const assert=require('node:assert/strict');
const geometry=require('../roundabout.js');
const size={width:370,height:405},TAU=Math.PI*2;
const normalize=(p,s=size)=>({x:p.x/s.width,y:p.y/s.height});
const angleGap=(a,b)=>Math.abs(Math.atan2(Math.sin(a-b),Math.cos(a-b)));
function polyline(vertices,spacing=3){
 const points=[];
 for(let i=1;i<vertices.length;i++){
  const a=vertices[i-1],b=vertices[i],n=Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/spacing);
  for(let j=0;j<n;j++)points.push({x:a.x+(b.x-a.x)*j/n,y:a.y+(b.y-a.y)*j/n});
 }
 return [...points,vertices.at(-1)];
}
function stroke({direction=1,entry=Math.PI/2,extra=2.3,rough=false,s=size,center={x:s.width*.52,y:s.height*.46},radius=Math.min(s.width,s.height)*.22}={}){
 const polar=(angle,r)=>({x:center.x+r*Math.cos(angle),y:center.y+r*Math.sin(angle)});
 const vertices=[polar(entry,radius*2.1),polar(entry,radius*1.55),polar(entry,radius)];
 for(let i=1;i<=110;i++){
  const a=entry+direction*(TAU+extra)*i/110;
  const radial=rough?1+.065*Math.sin(i*1.71)+.035*Math.cos(i*.53):1;
  const p=polar(a,radius*radial);
  if(rough)p.y=center.y+(p.y-center.y)*1.12;
  vertices.push(p);
 }
 vertices.push(polar(entry+direction*extra,radius*1.5),polar(entry+direction*extra,radius*2.1));
 return polyline(vertices).map(p=>normalize(p,s));
}
test('one pen stroke recognizes a full loop with an approach and upper-left exit in either winding',()=>{
 for(const direction of [1,-1]){
  const input=stroke({direction,extra:direction===1?2.3:3.98}),original=JSON.stringify(input),found=geometry.detect(input,size);
  assert.ok(found,`direction ${direction}`);assert.equal(found.direction,direction);
  assert.ok(angleGap(found.relativeExitAngle,2.3)<.15);assert.equal(JSON.stringify(input),original);
 }
});
test('rough, elliptical hand loops and rotated approaches retain the exit relative to entry',()=>{
 for(const entry of [Math.PI/2,.2,-2.1])for(const direction of [1,-1]){
  const found=geometry.detect(stroke({entry,direction,rough:true,extra:2.0}),size);
  assert.ok(found,`${entry}, ${direction}`);assert.equal(found.direction,direction);
  assert.ok(angleGap(found.relativeExitAngle,direction*2.0)<.3);
 }
});
test('the supplied sketch shape tolerates a modest repeated inner section of the lap',()=>{
 // Approximate finger trace from the supplied image, scaled to its drawing box.
 const trace=[[383,1043],[365,955],[358,862],[366,781],[343,771],[303,739],[272,699],[258,651],[263,588],[278,547],[308,520],[351,502],[389,501],[437,516],[474,550],[494,592],[505,636],[507,671],[494,714],[478,752],[454,781],[414,795],[369,800],[340,790],[308,759],[278,724],[270,684],[277,632],[280,584],[291,550],[315,532],[286,533],[242,515],[197,493],[146,458],[108,422]];
 const points=polyline(trace.map(([x,y])=>({x:x-23,y:y-392}))).map(p=>normalize(p,{width:663,height:660}));
 const found=geometry.detect(points,{width:663,height:660});
 assert.ok(found);assert.equal(found.direction,1);
  assert.ok(found.relativeExitAngle>1.6&&found.relativeExitAngle<2.8);
});
test('the supplied image trace still recognizes when the phone canvas has a different aspect',()=>{
 const trace=[[382,1042],[370,982],[358,890],[364,800],[368,776],[341,766],[305,731],[281,708],[266,678],[259,649],[266,606],[279,568],[305,536],[340,514],[375,501],[416,505],[455,522],[484,553],[503,596],[510,644],[502,689],[483,734],[459,771],[424,792],[378,802],[340,792],[314,768],[283,733],[267,699],[267,666],[277,616],[279,568],[291,539],[314,535],[278,519],[230,498],[182,472],[144,447],[109,423]];
 const p=polyline(trace.map(([x,y])=>({x:(x-24)/663*370,y:(y-391)/665*405}))).map(q=>normalize(q));
 const found=geometry.detect(p,size);assert.ok(found);assert.equal(found.direction,1);
 const exit=Math.PI/2+found.relativeExitAngle;
 assert.ok(Math.cos(exit)<-.3&&Math.sin(exit)<-.3,'generated exit leaves toward upper-left');
});
test('plain circles, U-turns, squares, retraced lines, ordinary corners and scribbles stay freehand',()=>{
 const center={x:185,y:190},r=70;
 const circle=Array.from({length:100},(_,i)=>({x:center.x+r*Math.cos(TAU*i/99),y:center.y+r*Math.sin(TAU*i/99)}));
 const u=[{x:135,y:340},{x:135,y:150},...Array.from({length:41},(_,i)=>({x:185+50*Math.cos(Math.PI+Math.PI*i/40),y:150+50*Math.sin(Math.PI+Math.PI*i/40)})),{x:235,y:340}];
 const square=[[185,350],[185,260],[115,260],[115,120],[255,120],[255,260],[185,260],[115,260],[115,120],[55,60]].map(([x,y])=>({x,y}));
 const backtrack=[[180,350],[180,70],[180,350],[180,70]].map(([x,y])=>({x,y}));
 const corner=[[180,350],[180,200],[70,90]].map(([x,y])=>({x,y}));
 const shapes=[circle,u,square,backtrack,corner];
 shapes.forEach((points,i)=>assert.equal(geometry.detect(polyline(points).map(p=>normalize(p)),size),null,`negative ${i}`));
 assert.equal(geometry.detect(stroke({extra:TAU*2.2}),size),null,'more than two laps is a scribble');
 const zigzag=Array.from({length:22},(_,i)=>({x:i%2?300:80,y:60+i*13}));
 assert.equal(geometry.detect(polyline(zigzag).map(p=>normalize(p)),size),null,'zigzag');
});
test('rejects missing tails and validates inputs without throwing',()=>{
 const points=stroke(),short=points.slice(35,-35);
 assert.equal(geometry.detect(short,size),null);
 for(const value of [null,[],[{}],Array(20).fill({x:NaN,y:0})])assert.equal(geometry.detect(value,size),null);
 assert.equal(geometry.detect(points,{width:0,height:405}),null);
 assert.deepEqual(geometry.build(null,size),[]);
});
function bezier(p,t){const u=1-t;return {x:u*u*u*p[0].x+3*u*u*t*p[1].x+3*u*t*t*p[2].x+t*t*t*p[3].x,y:u*u*u*p[0].y+3*u*u*t*p[1].y+3*u*t*t*p[2].y+t*t*t*p[3].y}}
test('generated compact ring is physically circular across aspect ratios with a contiguous route',()=>{
 for(const s of [{width:320,height:400},{width:405,height:370},{width:620,height:300}])for(const direction of [1,-1]){
  const detection={relativeExitAngle:2.3,direction},original=JSON.stringify(detection),built=geometry.build(detection,s),ring=built.filter(p=>p.part==='ring'),route=built.filter(p=>p.route);
  assert.equal(built[0].part,'approach');assert.equal(route.at(-1).part,'exit');assert.equal(JSON.stringify(detection),original);
  assert.equal(built.filter(p=>p.part==='approach').length,1);assert.equal(built.filter(p=>p.part==='exit').length,1);
  const center={x:s.width*.5,y:s.height*.46},radius=Math.min(s.width,s.height)*.17;
  for(const piece of ring)for(let i=0;i<=20;i++){
   const p=bezier(piece.p,i/20),distance=Math.hypot(p.x*s.width-center.x,p.y*s.height-center.y);
   assert.ok(Math.abs(distance-radius)<radius*.0003,'circle arc error stays below 0.03%');
  }
  for(let i=1;i<route.length;i++)assert.ok(Math.hypot(route[i-1].p[3].x-route[i].p[0].x,route[i-1].p[3].y-route[i].p[0].y)<1e-10);
  for(const p of built.flatMap(piece=>piece.p))assert.ok(p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1);
  assert.deepEqual(route[0].p[0],{x:.5,y:.9});
  const end=route.at(-1).p[3];assert.ok(angleGap(Math.atan2(end.y*s.height-center.y,end.x*s.width-center.x),Math.PI/2+2.3)<1e-10);
  const firstArc=ring.find(piece=>piece.route),a=firstArc.p[0],b=bezier(firstArc.p,.1);
  const delta=Math.atan2(Math.sin(Math.atan2(b.y*s.height-center.y,b.x*s.width-center.x)-Math.atan2(a.y*s.height-center.y,a.x*s.width-center.x)),Math.cos(Math.atan2(b.y*s.height-center.y,b.x*s.width-center.x)-Math.atan2(a.y*s.height-center.y,a.x*s.width-center.x)));
  assert.equal(Math.sign(delta),direction);
 }
});
test('a full lap exiting at the entry arm remains continuous and detector work is bounded for dense ink',()=>{
 for(const relativeExitAngle of [0,.02,-.02]){
  const route=geometry.build({relativeExitAngle,direction:1},size).filter(p=>p.route);
  for(let i=1;i<route.length;i++)assert.ok(Math.hypot(route[i-1].p[3].x-route[i].p[0].x,route[i-1].p[3].y-route[i].p[0].y)<1e-10);
 }
 const source=stroke(),dense=Array.from({length:6000},(_,i)=>source[Math.min(source.length-1,Math.floor(i*source.length/6000))]);
 assert.ok(geometry.detect(dense,size));assert.equal(dense.length,6000);
});
