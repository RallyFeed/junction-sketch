'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Store = require('../store.js');
const JunctionModel = require('../model.js');
const clone = value => JSON.parse(JSON.stringify(value));
const point = (x, y) => ({ x, y });
const curve = (id, route = false) => ({ id, route, type: 'tarmac', p: [point(.2, .9), point(.2, .6), point(.5, .3), point(.8, .3)] });
const sketch = () => ({ format: 'spline-v2', aspect: 370 / 405, roads: [curve(1, true)], features: [], raw: [[{ x: .2, y: .9, t: 123 }]] });
const note = (drawing = sketch()) => ({ id: 'point-original', number: 1, createdAt: '2026-09-05T10:00:00.000Z', updatedAt: '2026-09-05T10:00:00.000Z', anchor: { markedAt: '2026-09-05T10:00:00.000Z', location: null }, tripKm: null, text: 'Turn at the hedge', review: false, revision: 2, sketch: drawing });
const legacy = () => ({ pts: { a: point(120, 430), b: point(120, 240), c: point(360, 240), d: point(240, 80) }, roads: [{ id: 'route', p: ['a', 'b', 'c'], route: true, type: 'gravel' }, { id: 'fork', p: ['b', 'd'], route: false, type: 'track' }], landmarks: [{ id: 'house', symbol: 'house', roadId: 'route', t: .6, offset: 25 }, { id: 'custom', symbol: 'Old mill', roadId: 'fork', t: .4, offset: -10 }], raw: [[point(120, 430), { x: 120, y: 240, t: 1234 }]], crossings: [] });
function cubic(p, t) { const u = 1 - t; return { x: u ** 3 * p[0].x + 3 * u ** 2 * t * p[1].x + 3 * u * t ** 2 * p[2].x + t ** 3 * p[3].x, y: u ** 3 * p[0].y + 3 * u ** 2 * t * p[1].y + 3 * u * t ** 2 * p[2].y + t ** 3 * p[3].y }; }
function near(a, b) { assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-10, `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

test('v2 validates mixed numeric/string ids, curves, landmarks and clones without changing input', () => {
  const s = sketch();
  s.roads.push({ ...curve('fork'), attach: { id: 1, t: .4 } });
  s.features.push({ id: 3, type: 'house', at: point(.7, .8) }, { id: 'hedge', type: 'hedge', p: curve(99).p, side: -1 });
  const original = note(s), validated = Store.validateNote(original);
  assert.deepEqual(validated, original); assert.notEqual(validated, original);
  validated.sketch.roads[0].p[0].x = .5;
  assert.equal(original.sketch.roads[0].p[0].x, .2);
});

test('v2 rejects malformed curves, ambiguous ids, missing refs and wrong attachment id types', () => {
  for (const change of [
    s => { s.roads[0].p[0].x = NaN; },
    s => { s.roads[0].p[1].y = 10.01; },
    s => { s.roads[0].p.pop(); },
    s => { s.roads[0].p = Array(4).fill(point(.1, .1)); },
    s => { s.roads.push(curve('1')); },
    s => { s.features.push({ id: 1, type: 'house', at: point(.1, .1) }); },
    s => { s.roads[0].attach = { id: 'missing', t: .3 }; },
    s => { s.roads.push({ ...curve('fork'), attach: { id: '1', t: .3 } }); },
    s => { s.roads.push({ ...curve('fork'), attach: { id: 1, t: 1.1 } }); },
    s => { s.features.push({ id: 2, type: 'hedge', p: curve(99).p, at: point(.1, .1) }); },
    s => { s.features.push({ id: 2, type: 'hedge', p: curve(99).p, side: 0 }); },
    s => { s.raw[0][0].t = -1; },
    s => { s.aspect = 4.1; },
  ]) { const s = sketch(); change(s); assert.throws(() => Store.validateNote(note(s)), TypeError); }
});

test('v2 rejects self/cyclic attachments while permitting shared-parent DAGs', () => {
  const self = sketch(); self.roads[0].attach = { id: 1, t: .5 };
  assert.throws(() => Store.validateNote(note(self)), /attachment/);
  const loop = sketch(); loop.roads.push(curve(2), curve(3));
  loop.roads[0].endAttach = { id: 2, t: .2 }; loop.roads[1].attach = { id: 3, t: .3 }; loop.roads[2].attach = { id: 1, t: .4 };
  assert.throws(() => Store.validateNote(note(loop)), /cycle/);
  const shared = sketch(); shared.roads.push({ ...curve(2), attach: { id: 1, t: .2 }, endAttach: { id: 1, t: .8 } });
  assert.deepEqual(Store.validateNote(note(shared)).sketch, shared);
});

test('validation rejects non-JSON prototypes and prototype property payloads', () => {
  const customPoint = note(); customPoint.sketch.roads[0].p[0] = Object.assign(Object.create({ inherited: 1 }), point(.2, .9));
  assert.throws(() => Store.validateNote(customPoint), /plain JSON/);
  class CustomArray extends Array {}
  const customArray = note(); customArray.sketch.raw = new CustomArray();
  assert.throws(() => Store.validateNote(customArray), /plain JSON/);
  const payload = note(); payload.extra = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => Store.validateNote(payload), /Invalid note property/);
  assert.equal({}.polluted, undefined);
});

test('v2 enforces feature and raw-point limits', () => {
  const s = sketch(); s.features = Array.from({ length: Store.limits.landmarks + 1 }, (_, i) => ({ id: 'f' + i, type: 'tree', at: point(.1, .1) }));
  assert.throws(() => Store.validateNote(note(s)), /too many objects/);
  const raw = sketch(); raw.raw = [Array.from({ length: Store.limits.rawPoints + 1 }, () => point(0, 0))];
  assert.throws(() => Store.validateNote(note(raw)), /ink stroke/);
});

test('legacy validation and new no-op migration preserve input values', () => {
  const old = legacy(), original = clone(old);
  assert.deepEqual(Store.validateNote(note(old)).sketch, original);
  const s = sketch(), migrated = Store.migrateSketch(s);
  assert.deepEqual(migrated, s); assert.notEqual(migrated, s);
  assert.deepEqual(old, original);
});

test('v2 migration supplies the approved preview aspect when older v2 input omits it', () => {
  const s = sketch(); delete s.aspect;
  Store.validateNote(note(s));
  assert.equal(Store.migrateSketch(s).aspect, 370 / 405);
  assert.equal(s.aspect, undefined);
});

test('migration preserves all polyline segments exactly as straight cubic pieces and shared forks', () => {
  const old = legacy(), original = clone(old), migrated = Store.migrateSketch(old);
  assert.equal(migrated.roads.length, 3);
  assert.equal(migrated.aspect, 1);
  assert.deepEqual(migrated.roads.map(r => r.route), [true, true, false]);
  assert.deepEqual(migrated.roads.map(r => r.type), ['gravel', 'gravel', 'track']);
  const segments = [[old.pts.a, old.pts.b], [old.pts.b, old.pts.c], [old.pts.b, old.pts.d]];
  for (let i = 0; i < segments.length; i++) for (const t of [0, .13, .5, .82, 1]) {
    const [a, b] = segments[i];
    near(cubic(migrated.roads[i].p, t), point((a.x + (b.x - a.x) * t) / 480, (a.y + (b.y - a.y) * t) / 480));
  }
  assert.deepEqual(migrated.roads[1].attach, { id: migrated.roads[0].id, t: 1 });
  assert.deepEqual(migrated.roads[2].attach, { id: migrated.roads[0].id, t: 1 });
  assert.deepEqual(migrated.raw, [[point(.25, 430 / 480), { x: .25, y: .5, t: 1234 }]]);
  assert.deepEqual(old, original);
  Store.validateNote(note(migrated));
});

test('migration places legacy landmarks at the same arc-length offset including corner tie-breaks', () => {
  const old = legacy();
  old.landmarks.push({ id: 'corner', symbol: 'gate', roadId: 'route', t: 190 / 430, offset: 30 });
  const model = new JunctionModel(old), migrated = Store.migrateSketch(old);
  for (let i = 0; i < old.landmarks.length; i++) {
    const at = model.landmarkPosition(old.landmarks[i]);
    near(migrated.features[i].at, point(at.x / 480, at.y / 480));
  }
  assert.equal(migrated.features[1].label, 'Old mill'); assert.equal(migrated.features[1].type, 'sign');
});

test('legacy named line landmarks map to editor catalog IDs and unknown danger retains its label', () => {
  const old = legacy();
  old.landmarks = ['sandbank', 'waterline', 'danger'].map((symbol, i) => ({ id: 'landmark-' + i, symbol, roadId: 'route', t: .5, offset: 20 }));
  const migrated = Store.migrateSketch(old);
  assert.deepEqual(migrated.features.map(f => f.type), ['bank', 'water', 'sign']);
  assert.equal(migrated.features[2].label, 'danger');
});

test('migration retains closed loops without attachment cycles', () => {
  const old = legacy(); old.roads[0].p.push('a');
  const migrated = Store.migrateSketch(old);
  Store.validateNote(note(migrated));
  const closing = migrated.roads.find(r => r.legacyRoadId === 'route' && r.legacySegment === 2);
  assert.deepEqual(closing.endAttach, { id: migrated.roads[0].id, t: 0 });
});

test('zero-length legacy edges retain shared topology without creating invalid cubics', () => {
  const old = legacy(); old.pts.z = clone(old.pts.a); old.roads[0].p.unshift('z'); old.roads[1].p = ['z', 'd'];
  const migrated = Store.migrateSketch(old);
  assert.equal(migrated.roads.length, 3);
  assert.deepEqual(migrated.roads[2].attach, { id: migrated.roads[0].id, t: 0 });
  Store.validateNote(note(migrated));
});

// This deliberately tests backup serialization and import validation, not IndexedDB
// implementation. Transactions are an in-memory port so media bytes can roundtrip.
class MemoryStore extends Store {
  constructor(data = { notes: [], media: [] }) { super(); this.data = data; }
  async _transaction(names, mode, work) {
    let result; const jobs = [], additions = [];
    const tx = { objectStore: name => ({
      getAll: () => { const request = {}; jobs.push(() => request.onsuccess({ target: { result: structuredClone(this.data[name]) } })); return request; },
      add: value => { assert.ok(!this.data[name].some(row => row.id === value.id)); additions.push([name, value]); },
    }) };
    work(tx, value => { result = value; }, error => { throw error; });
    for (const job of jobs) job();
    for (const [name, value] of additions) this.data[name].push(value);
    return result;
  }
}

test('backup/import roundtrips legacy and v2 sketches plus photo/voice bytes, remapping only note/media ids', async () => {
  const v2 = note(); v2.sketch.roads.push({ ...curve('fork'), attach: { id: 1, t: .5 } });
  v2.legacySketch = legacy();
  const v1 = note(legacy()); v1.id = 'legacy-note'; v1.number = 2;
  const media = [
    { id: 'photo-original', noteId: v2.id, kind: 'photo', createdAt: v2.createdAt, mimeType: 'image/jpeg', name: 'junction.jpg', blob: new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' }) },
    { id: 'voice-original', noteId: v1.id, kind: 'voice', createdAt: v1.createdAt, mimeType: 'audio/webm', blob: new Blob(['voice recording'], { type: 'audio/webm' }) },
  ];
  const source = new MemoryStore({ notes: [v2, v1], media }), before = clone([v2, v1]);
  const backup = await source.exportProject(), target = new MemoryStore();
  const imported = await target.importProject(JSON.parse(JSON.stringify(backup)));
  assert.equal(imported.noteCount, 2); assert.equal(imported.mediaCount, 2);
  assert.deepEqual(source.data.notes, before);
  for (const original of [v2, v1]) {
    const saved = target.data.notes.find(n => n.id === imported.noteIdMap[original.id]);
    assert.notEqual(saved.id, original.id);
    assert.deepEqual({ ...saved, id: original.id }, original);
  }
  for (const original of media) {
    const saved = target.data.media.find(m => m.id === imported.mediaIdMap[original.id]);
    assert.notEqual(saved.id, original.id); assert.equal(saved.noteId, imported.noteIdMap[original.noteId]);
    assert.deepEqual(new Uint8Array(await saved.blob.arrayBuffer()), new Uint8Array(await original.blob.arrayBuffer()));
  }
  const again = await target.exportProject();
  assert.equal(again.format, 'rallymaker-roadbook'); assert.equal(again.version, 1);
  assert.deepEqual(again.notes.find(n => n.id === imported.noteIdMap[v2.id]).sketch, v2.sketch);
});

test('invalid imported attachment graph fails before writing any note or media', async () => {
  const bad = note(); bad.sketch.roads[0].attach = { id: 1, t: 0 };
  const target = new MemoryStore();
  await assert.rejects(target.importProject({ format: 'rallymaker-roadbook', version: 1, notes: [bad], media: [] }), /attachment/);
  assert.deepEqual(target.data, { notes: [], media: [] });
});
