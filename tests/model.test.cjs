const test = require('node:test');
const assert = require('node:assert/strict');
const Model = require('../model.js');
const p = (x, y, t) => t === undefined ? { x, y } : { x, y, t };
const draw = (m, points, opts = {}) => m.commitStroke(points, { snapRadius: 0, epsilon: 0, ...opts });
const close = (a, b) => { assert.ok(a && b); assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-5, JSON.stringify({a,b})); };
function valid(m) {
  for (const r of m.state.roads) {
    assert.ok(r.p.length >= 2);
    for (let i = 0; i < r.p.length; i++) {
      assert.ok(m.state.pts[r.p[i]]);
      if (i) assert.notEqual(r.p[i], r.p[i - 1]);
    }
  }
  for (const mark of m.state.landmarks) assert.ok(m.state.roads.find(r => r.id === mark.roadId));
}

test('first stroke is route; raw precision, timestamps and direction survive reversal', () => {
  const m = new Model(), ink = [p(10.12345, 100, 10), p(10.23456, 0, 11)];
  const r = draw(m, ink);
  assert.equal(r.route, true); assert.deepEqual(m.state.raw[0], ink);
  const end = m.routeEnd().point;
  m.reverseRoute(); close(m.routeStart(), end); assert.deepEqual(m.state.raw[0], ink);
  const exported = m.serialize(); exported.pts[r.p[0]].x = -900;
  assert.notEqual(m.routeStart().x, -900);
});

test('endpoint projection adds a shared node and preserves a nearby intentional junction', () => {
  const m = new Model(), base = draw(m, [p(0, 50), p(100, 50)]);
  const a = draw(m, [p(40, 54), p(40, 100)], {snapRadius: 10});
  const b = draw(m, [p(43, 51), p(90, 100)], {snapRadius: 10});
  assert.notEqual(a.p[0], b.p[0]);
  assert.ok(base.p.includes(a.p[0])); assert.ok(base.p.includes(b.p[0]));
  m.beginChange(); m.movePoint(a.p[0], p(35, 55));
  close(m.roadPoints(base)[base.p.indexOf(a.p[0])], p(35, 55));
  m.undo(); close(m.state.pts[a.p[0]], p(40, 50)); valid(m);
});

test('crossing through an existing node creates exactly one shared junction', () => {
  const m = new Model(), route = draw(m, [p(0,50), p(50,50), p(100,50)]);
  const branch = draw(m, [p(50,0), p(50,100)]);
  assert.equal(route.p.length, 3); assert.equal(branch.p.length, 3);
  assert.equal(branch.p[1], route.p[1]);
  assert.equal(Object.values(m.state.pts).filter(q => q.x === 50 && q.y === 50).length, 1);
  valid(m);
});

test('multiple crossings are sorted along each road and undo atomically', () => {
  const m = new Model();
  draw(m, [p(20,0), p(20,100)]); draw(m,[p(70,0),p(70,100)]);
  const before = m.serialize();
  const crossing = draw(m, [p(100,50),p(0,50)]);
  assert.deepEqual(m.roadPoints(crossing).map(q=>q.x), [100,70,20,0]);
  valid(m); m.undo(); assert.deepEqual(m.serialize(), before);
  m.redo(); assert.equal(m.state.roads.length, 3); valid(m);
});

test('crossings can stay disconnected; explicit road disconnect is undoable', () => {
  const m = new Model(), route = draw(m, [p(0,50),p(100,50)]);
  const over = draw(m,[p(50,0),p(50,100)],{connectCrossings:false});
  assert.equal(route.p.length,2); assert.equal(over.p.length,2);
  const joined = draw(m,[p(70,0),p(70,100)]);
  const joint = joined.p[1]; assert.ok(route.p.includes(joint));
  assert.equal(m.disconnectRoad(joined.id, joint),true);
  assert.equal(joined.p.includes(joint),false); close(m.state.pts[joined.p[1]],m.state.pts[joint]);
  m.undo(); assert.ok(m.state.roads.find(r=>r.id===joined.id).p.includes(joint)); valid(m);
});

test('splitting preserves landmark placement, type, route continuity and complete undo', () => {
  const m = new Model(), r = draw(m,[p(0,0),p(100,0),p(100,100)],{type:'gravel'});
  const first = m.addLandmark('house',p(25,8)), second = m.addLandmark('danger',p(110,70));
  const positions = [m.landmarkPosition(first),m.landmarkPosition(second)], before=m.serialize();
  const next = m.splitRoad(r.id,p(100,30));
  assert.ok(next); assert.equal(m.state.roads[1].type,'gravel');
  assert.equal(m.state.roads[1].route,true); assert.equal(second.roadId,next);
  close(m.landmarkPosition(first),positions[0]); close(m.landmarkPosition(second),positions[1]);
  m.undo(); assert.deepEqual(m.serialize(),before); valid(m);
});

test('route reversal preserves all landmarks including a bend and split boundary', () => {
  const m = new Model(), r=draw(m,[p(0,0),p(100,0),p(100,100)]);
  const a=m.addLandmark('tree',p(50,10)), b=m.addLandmark('house',p(110,50));
  const corner={id:'corner',symbol:'danger',roadId:r.id,t:0.5,offset:12};
  m.state.landmarks.push(corner);
  const before=m.state.landmarks.map(x=>m.landmarkPosition(x));
  m.reverseRoute(); m.state.landmarks.forEach((x,i)=>close(m.landmarkPosition(x),before[i]));
  const raw=m.state.raw[0]; m.reverseRoute(); assert.deepEqual(m.state.raw[0],raw);
  m.splitRoad(r.id,p(100,0)); m.state.landmarks.forEach((x,i)=>close(m.landmarkPosition(x),before[i]));
  valid(m);
});

test('deleting a middle route section does not leave a false route across a gap', () => {
  const m = new Model(), r=draw(m,[p(0,0),p(150,0)]);
  const mid=m.splitRoad(r.id,p(50,0)), last=m.splitRoad(mid,p(100,0));
  const lm=m.addLandmark('tree',p(75,10));
  m.deleteRoad(mid);
  assert.equal(m.state.roads.find(x=>x.id===last).route,false);
  assert.equal(m.state.landmarks.some(x=>x.id===lm.id),false);
  close(m.routeEnd().point,p(50,0)); assert.equal(m.state.raw.length,1); valid(m);
});

test('reset retains raw evidence and is undoable; new notes start empty', () => {
  const m = new Model(); draw(m,[p(0,0),p(90,90)]);
  const before=m.serialize(); m.reset();
  assert.equal(m.state.roads.length,0); assert.deepEqual(m.state.raw,before.raw);
  m.undo(); assert.deepEqual(m.serialize(),before);
  assert.equal(new Model().state.raw.length,0);
});

test('invalid strokes, imports and endpoint splits cannot make dangling roads', () => {
  const m=new Model(); assert.equal(draw(m,[p(0,0),p(0,0)]),null);
  assert.equal(draw(m,[p(0,0),p(NaN,5)]),null); assert.equal(m.canUndo(),false);
  const r=draw(m,[p(0,0),p(100,0)]);
  assert.equal(m.splitRoad(r.id,p(0,0)),null);
  const before=m.serialize(); assert.equal(m.movePoint(r.p[1],p(0,0)),false);
  assert.deepEqual(m.serialize(),before);
  const bad=new Model({pts:{a:p(0,0),b:p(10,0)},roads:[{id:'r99',p:['a','missing'],route:true}],landmarks:[{id:'l9',symbol:'house',roadId:'none',t:0,offset:1}]});
  assert.equal(bad.state.roads.length,0); assert.equal(bad.state.landmarks.length,0); valid(bad);
});

test('shallow forks retain their original angle and polyline hit tests match visible segments', () => {
  const m=new Model(), r=draw(m,[p(0,0),p(100,8)],{epsilon:3});
  close(m.roadPoints(r)[1],p(100,8));
  const hit=m.hitRoad(p(50,4),1); assert.equal(hit.road.id,r.id); assert.equal(hit.segment,0);
  assert.equal(m.hitRoad(p(50,40),4),null);
});

test('self-crossing strokes form a shared graph node and closed loops remain valid', () => {
  const m=new Model(), r=draw(m,[p(0,0),p(100,100),p(0,100),p(100,0)]);
  const shared=r.p.filter(id=>m.state.pts[id].x===50&&m.state.pts[id].y===50);
  assert.equal(shared.length,2); assert.equal(shared[0],shared[1]); valid(m);
  const loop=new Model(), l=draw(loop,[p(0,0),p(100,0),p(100,100),p(0,100),p(0,0)]);
  assert.equal(l.p[0],l.p.at(-1)); valid(loop);
});

test('drag groups undo once; a cancelled drag keeps redo; a changed drag forks history', () => {
  const m=new Model(), r=draw(m,[p(0,0),p(100,0)]), id=r.p[1];
  m.beginChange(); m.movePoint(id,p(100,10)); m.movePoint(id,p(100,20));
  m.undo(); close(m.state.pts[id],p(100,0)); assert.equal(m.canRedo(),true);
  m.beginChange(); assert.equal(m.canRedo(),true);
  m.movePoint(id,p(100,30)); assert.equal(m.canRedo(),false);
  m.undo(); close(m.state.pts[id],p(100,0));
});

test('landmarks at a reversed split bend retain position on the correct section', () => {
  const m=new Model(), r=draw(m,[p(0,0),p(100,0),p(100,100)]);
  const mark={id:'corner',symbol:'danger',roadId:r.id,t:0.5,offset:12};
  m.state.landmarks.push(mark); const position=m.landmarkPosition(mark);
  m.reverseRoute(); const next=m.splitRoad(r.id,p(100,0));
  assert.equal(mark.roadId,next); close(m.landmarkPosition(mark),position); valid(m);
});
