/* JunctionModel: dependency-free graph geometry for a phone-sized tulip canvas.
 * Coordinates are logical canvas units; roads render as straight polyline segments.
 * Raw ink never changes during geometry edits, reversal, deletion or reset. Undoing
 * its creation removes that stroke from the active state; redo restores it.
 * reset() keeps raw history. Create a new model for a genuinely new note.
 * Landmark t is fractional arc length; offset is the signed (-dy, dx) normal.
 * movePoint/moveLandmark require the caller to beginChange() once per drag.
 * Disconnection duplicates topology at the same coordinates; it does not draw a
 * bridge. crossings is reserved metadata, not inferred bridge classification.
 */
(function (root, factory) {
  const Model = factory();
  if (typeof module === 'object' && module.exports) module.exports = Model;
  else root.JunctionModel = Model;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const TOL = 1e-5;
  const types = new Set(['tarmac', 'gravel', 'track']);
  const clone = value => JSON.parse(JSON.stringify(value));
  const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
  const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const length = ps => ps.slice(1).reduce((n, p, i) => n + distance(ps[i], p), 0);
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  const minus = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  function projection(p, a, b) {
    const v = minus(b, a), l2 = v.x * v.x + v.y * v.y;
    const t = l2 ? clamp(((p.x - a.x) * v.x + (p.y - a.y) * v.y) / l2, 0, 1) : 0;
    const q = { x: a.x + v.x * t, y: a.y + v.y * t };
    return { q, t, d: distance(p, q) };
  }
  function nearest(p, ps) {
    let best = null;
    for (let i = 0; i < ps.length - 1; i++) {
      const n = projection(p, ps[i], ps[i + 1]);
      if (!best || n.d < best.d) best = { ...n, segment: i };
    }
    return best;
  }
  function simplify(ps, epsilon) {
    if (ps.length < 3 || epsilon <= 0) return ps.slice();
    const keep = new Set([0, ps.length - 1]), stack = [[0, ps.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let max = epsilon, at = -1;
      for (let i = a + 1; i < b; i++) {
        const d = projection(ps[i], ps[a], ps[b]).d;
        if (d > max) { max = d; at = i; }
      }
      if (at >= 0) { keep.add(at); stack.push([a, at], [at, b]); }
    }
    return [...keep].sort((a, b) => a - b).map(i => ps[i]);
  }
  function intersections(a, b, c, d) {
    const r = minus(b, a), s = minus(d, c), ca = minus(c, a);
    const den = cross(r, s);
    if (Math.abs(den) > TOL) {
      const t = cross(ca, s) / den, u = cross(ca, r) / den;
      if (t < -TOL || t > 1 + TOL || u < -TOL || u > 1 + TOL) return [];
      return [{ t: clamp(t, 0, 1), u: clamp(u, 0, 1),
        x: a.x + clamp(t, 0, 1) * r.x, y: a.y + clamp(t, 0, 1) * r.y }];
    }
    // Collinear overlap: connect its boundary nodes, without inventing a crossing.
    const out = [];
    for (const p of [a, b, c, d]) {
      const x = projection(p, a, b), y = projection(p, c, d);
      if (x.d <= TOL && y.d <= TOL && !out.some(q => distance(q, p) < TOL))
        out.push({ x: p.x, y: p.y, t: x.t, u: y.t });
    }
    return out;
  }

  class JunctionModel {
    constructor(data) {
      const d = data && typeof data === 'object' ? data : {};
      this.state = { pts: {}, roads: [], raw: [], landmarks: [], crossings: [] };
      this._history = []; this._future = []; this._sequence = 0;
      for (const [id, p] of Object.entries(d.pts || {}))
        if (finitePoint(p) && id !== '__proto__') this.state.pts[id] = { x: p.x, y: p.y };
      const used = new Set();
      for (const road of Array.isArray(d.roads) ? d.roads : []) {
        if (!road || typeof road.id !== 'string' || used.has(road.id) || !Array.isArray(road.p)) continue;
        used.add(road.id);
        this.state.roads.push({ id: road.id, p: road.p.filter(id => Object.hasOwn(this.state.pts, id)),
          type: types.has(road.type) ? road.type : 'tarmac', route: !!road.route });
      }
      this.state.raw = (Array.isArray(d.raw) ? d.raw : []).filter(Array.isArray)
        .map(stroke => stroke.filter(finitePoint).map(p => Number.isFinite(p.t)
          ? { x: p.x, y: p.y, t: p.t } : { x: p.x, y: p.y }));
      for (const m of Array.isArray(d.landmarks) ? d.landmarks : []) {
        if (!m || typeof m.id !== 'string' || used.has(m.id) || typeof m.symbol !== 'string') continue;
        used.add(m.id);
        if (Number.isFinite(m.t) && Number.isFinite(m.offset))
          this.state.landmarks.push({ id: m.id, symbol: m.symbol, roadId: m.roadId,
            t: clamp(m.t, 0, 1), offset: m.offset });
      }
      this.state.crossings = Array.isArray(d.crossings) ? clone(d.crossings) : [];
      this._clean(); this._repairRoute();
      const allIds = [...Object.keys(this.state.pts), ...used];
      for (const id of allIds) {
        const value = +(id.match(/\d+$/) || [0])[0];
        if (Number.isSafeInteger(value) && value < 1e12) this._sequence = Math.max(this._sequence, value);
      }
    }
    serialize() { return clone(this.state); }
    beginChange() {
      const snapshot = this.serialize();
      if (JSON.stringify(this._history[this._history.length - 1]) !== JSON.stringify(snapshot))
        this._history.push(snapshot);
      if (this._history.length > 100) this._history.shift();
    }
    canUndo() {
      if (!this._history.length) return false;
      const current = JSON.stringify(this.state);
      for (let i = this._history.length - 1; i >= 0; i--)
        if (JSON.stringify(this._history[i]) !== current) return true;
      return false;
    }
    canRedo() { return this._future.length > 0; }
    undo() {
      while (this._history.length) {
        const s = this._history.pop();
        if (JSON.stringify(s) === JSON.stringify(this.state)) continue;
        this._future.push(this.serialize()); this.state = s; return true;
      }
      return false;
    }
    redo() {
      if (!this._future.length) return false;
      this._history.push(this.serialize()); this.state = this._future.pop(); return true;
    }
    _edit(action) {
      const before = this.serialize(), result = action();
      if (result === null || result === false) { this.state = before; return result; }
      if (JSON.stringify(before) !== JSON.stringify(this.state)) {
        this._history.push(before); if (this._history.length > 100) this._history.shift();
        this._future = [];
      }
      return result;
    }
    _id(prefix) { return prefix + (++this._sequence); }
    _point(p) { const id = this._id('p'); this.state.pts[id] = { x: p.x, y: p.y }; return id; }
    _road(id) { return this.state.roads.find(r => r.id === id); }
    roadPoints(road) { return road ? road.p.map(id => this.state.pts[id]).filter(finitePoint) : []; }
    _clean() {
      for (const r of this.state.roads)
        r.p = r.p.filter((id, i, ps) => Object.hasOwn(this.state.pts, id) && (!i || id !== ps[i - 1]));
      this.state.roads = this.state.roads.filter(r => r.p.length >= 2 && length(this.roadPoints(r)) > TOL);
      const used = new Set(this.state.roads.flatMap(r => r.p));
      for (const id of Object.keys(this.state.pts)) if (!used.has(id)) delete this.state.pts[id];
      this.state.landmarks = this.state.landmarks.filter(m => this._road(m.roadId));
    }
    _repairRoute() {
      let previous = null, disconnected = false;
      for (const r of this.state.roads.filter(r => r.route)) {
        if (previous !== null && previous !== r.p[0]) disconnected = true;
        if (disconnected) r.route = false;
        else previous = r.p[r.p.length - 1];
      }
    }
    reset() {
      return this._edit(() => { this.state = { pts: {}, roads: [], raw: this.state.raw,
        landmarks: [], crossings: [] }; return true; });
    }
    hitPoint(point, radius = 24) {
      if (!finitePoint(point)) return null;
      let best = null, d = radius;
      for (const [id, p] of Object.entries(this.state.pts)) {
        const n = distance(p, point);
        if (n <= d) { best = id; d = n; }
      }
      return best;
    }
    hitRoad(point, radius = 24) {
      if (!finitePoint(point)) return null;
      let best = null;
      for (const road of this.state.roads) {
        const n = nearest(point, this.roadPoints(road));
        if (n && n.d <= radius && (!best || n.d < best.d)) best = { road, ...n };
      }
      return best;
    }
    _insert(road, hit) {
      const a = road.p[hit.segment], b = road.p[hit.segment + 1];
      if (distance(this.state.pts[a], hit.q) <= TOL) return a;
      if (distance(this.state.pts[b], hit.q) <= TOL) return b;
      const id = this._point(hit.q); road.p.splice(hit.segment + 1, 0, id); return id;
    }
    commitStroke(raw, options = {}) {
      if (!Array.isArray(raw)) return null;
      const ink = raw.filter(finitePoint).map(p => Number.isFinite(p.t)
        ? { x: p.x, y: p.y, t: p.t } : { x: p.x, y: p.y });
      const clean = ink.filter((p, i) => !i || distance(p, ink[i - 1]) > TOL);
      if (clean.length < 2 || length(clean) < 8) return null;
      const radius = Number.isFinite(options.snapRadius) ? Math.max(0, options.snapRadius) : 24;
      const epsilon = Number.isFinite(options.epsilon) ? Math.max(0, options.epsilon) : 3;
      return this._edit(() => {
        const points = simplify(clean, epsilon), ids = points.map(p => this._point(p));
        // Projection-based endpoint snapping preserves nearby intentional junctions.
        for (const index of [0, ids.length - 1]) {
          const hit = this.hitRoad(points[index], radius);
          if (hit) ids[index] = this._insert(hit.road, hit);
        }
        const route = !this.state.roads.some(r => r.route);
        const lastRoute = this.state.roads.filter(r => r.route).at(-1);
        const road = { id: this._id('r'), p: ids,
          type: types.has(options.type) ? options.type : (lastRoute ? lastRoute.type : 'tarmac'), route };
        if (options.connectCrossings !== false) this._connect(road);
        this.state.roads.push(road); this._clean();
        if (!this._road(road.id)) return null;
        this.state.raw.push(ink);
        return road;
      });
    }
    _connect(road) {
      const roads = [...this.state.roads, road], parent = Object.create(null), registry = [];
      const root = id => { while (parent[id]) id = parent[id]; return id; };
      const events = new Map(roads.map(r => [r, r.p.slice(1).map((id, i) =>
        [{ t: 0, id: r.p[i] }, { t: 1, id }])]));
      const attach = (x, candidates) => {
        const found = registry.find(e => distance(e, x) <= TOL);
        const matching = candidates.filter(id => distance(this.state.pts[id], x) <= TOL);
        const id = root(found ? found.id : matching[0] || this._point(x));
        for (const other of matching) if (root(other) !== id) parent[root(other)] = id;
        if (!found) registry.push({ x: x.x, y: x.y, id });
        return id;
      };
      for (const existing of this.state.roads) {
        for (let i = 0; i < road.p.length - 1; i++) {
          for (let j = 0; j < existing.p.length - 1; j++) {
            const candidates = [existing.p[j], existing.p[j + 1], road.p[i], road.p[i + 1]];
            const [c, d, a, b] = candidates.map(id => this.state.pts[id]);
            for (const x of intersections(a, b, c, d)) {
              const id = attach(x, candidates);
              events.get(road)[i].push({ t: x.t, id });
              events.get(existing)[j].push({ t: x.u, id });
            }
          }
        }
      }
      // A looped new stroke can cross itself, too. Adjacent segments already join.
      for (let i = 0; i < road.p.length - 1; i++) for (let j = i + 2; j < road.p.length - 1; j++) {
        const candidates = [road.p[i], road.p[i + 1], road.p[j], road.p[j + 1]];
        const [a, b, c, d] = candidates.map(id => this.state.pts[id]);
        for (const x of intersections(a, b, c, d)) {
          const id = attach(x, candidates);
          events.get(road)[i].push({ t: x.t, id });
          events.get(road)[j].push({ t: x.u, id });
        }
      }
      for (const r of roads) {
        r.p = events.get(r).flatMap(es => es.sort((a, b) => a.t - b.t).map(e => root(e.id)))
          .filter((id, i, ps) => !i || id !== ps[i - 1]);
      }
    }
    movePoint(id, point) {
      if (!Object.hasOwn(this.state.pts, id) || !finitePoint(point)) return false;
      // Reject a collapsed edge while dragging; no node merging is implicit here.
      for (const r of this.state.roads) for (let i = 0; i < r.p.length; i++) {
        if (r.p[i] !== id) continue;
        for (const other of [r.p[i - 1], r.p[i + 1]])
          if (other && other !== id && distance(this.state.pts[other], point) <= TOL) return false;
      }
      if (distance(this.state.pts[id], point) > 0) this._future = [];
      this.state.pts[id] = { x: point.x, y: point.y }; return true;
    }
    splitRoad(id, point) {
      const road = this._road(id);
      if (!road || !finitePoint(point)) return null;
      const ps = this.roadPoints(road), hit = nearest(point, ps);
      if (!hit || hit.d > 24 || distance(hit.q, ps[0]) <= TOL || distance(hit.q, ps.at(-1)) <= TOL) return null;
      return this._edit(() => {
        const fullLength = length(ps), fraction = this._fraction(road, hit);
        if (fraction * fullLength <= TOL || (1 - fraction) * fullLength <= TOL) return null;
        const anchors = new Map(this.state.landmarks.filter(m => m.roadId === id)
          .map(m => [m, this._frame(road, m.t).segment]));
        const node = this._insert(road, hit), index = road.p.indexOf(node);
        const second = { id: this._id('r'), p: road.p.slice(index), type: road.type, route: road.route };
        road.p = road.p.slice(0, index + 1);
        this.state.roads.splice(this.state.roads.indexOf(road) + 1, 0, second);
        for (const m of this.state.landmarks.filter(m => m.roadId === id)) {
          const onSecond = Math.abs(m.t - fraction) * fullLength <= TOL && anchors.get(m) > hit.segment;
          if (m.t <= fraction && !onSecond) m.t = clamp(m.t / fraction, 0, 1);
          else { m.roadId = second.id; m.t = clamp((m.t - fraction) / (1 - fraction), 0, 1); }
        }
        return second.id;
      });
    }
    deleteRoad(id) {
      if (!this._road(id)) return false;
      return this._edit(() => {
        this.state.roads = this.state.roads.filter(r => r.id !== id);
        this._clean(); this._repairRoute(); return true;
      });
    }
    setRoadType(id, type) {
      const road = this._road(id);
      if (!road || !types.has(type)) return false;
      return this._edit(() => { road.type = type; return true; });
    }
    disconnectRoad(id, pointId) {
      const road = this._road(id);
      if (!road || !road.p.includes(pointId) || !this.state.roads.some(r => r.id !== id && r.p.includes(pointId))) return false;
      return this._edit(() => {
        const replacement = this._point(this.state.pts[pointId]);
        road.p = road.p.map(p => p === pointId ? replacement : p);
        this._repairRoute(); return true;
      });
    }
    reverseRoute() {
      const route = this.state.roads.filter(r => r.route);
      if (!route.length) return false;
      return this._edit(() => {
        const reversed = route.slice().reverse();
        for (const r of reversed) {
          r.p.reverse();
          for (const m of this.state.landmarks.filter(m => m.roadId === r.id)) {
            m.t = 1 - m.t; m.offset = -m.offset;
          }
        }
        let i = 0;
        this.state.roads = this.state.roads.map(r => r.route ? reversed[i++] : r);
        return true;
      });
    }
    _fraction(road, hit) {
      const ps = this.roadPoints(road), total = length(ps);
      return total ? (length(ps.slice(0, hit.segment + 1)) +
        distance(ps[hit.segment], ps[hit.segment + 1]) * hit.t) / total : 0;
    }
    _landmarkAnchor(point) {
      const hit = this.hitRoad(point, Infinity);
      if (!hit) return null;
      const ps = this.roadPoints(hit.road), a = ps[hit.segment], b = ps[hit.segment + 1];
      const len = distance(a, b);
      return { roadId: hit.road.id, t: this._fraction(hit.road, hit),
        offset: len ? ((point.x - hit.q.x) * -(b.y - a.y) + (point.y - hit.q.y) * (b.x - a.x)) / len : 0 };
    }
    addLandmark(symbol, point) {
      if (typeof symbol !== 'string' || !symbol || !finitePoint(point)) return null;
      const anchor = this._landmarkAnchor(point);
      if (!anchor) return null;
      return this._edit(() => {
        const landmark = { id: this._id('l'), symbol, ...anchor };
        this.state.landmarks.push(landmark); return landmark;
      });
    }
    moveLandmark(id, point) {
      const landmark = this.state.landmarks.find(m => m.id === id);
      if (!landmark || !finitePoint(point)) return false;
      const anchor = this._landmarkAnchor(point);
      if (!anchor) return false;
      if (Object.keys(anchor).some(key => anchor[key] !== landmark[key])) this._future = [];
      Object.assign(landmark, anchor); return true;
    }
    deleteLandmark(id) {
      if (!this.state.landmarks.some(m => m.id === id)) return false;
      return this._edit(() => { this.state.landmarks = this.state.landmarks.filter(m => m.id !== id); return true; });
    }
    _frame(road, fraction) {
      const ps = this.roadPoints(road); let remaining = clamp(fraction, 0, 1) * length(ps);
      for (let i = 0; i < ps.length - 1; i++) {
        let a = ps[i], b = ps[i + 1], len = distance(a, b);
        if (!len) continue;
        if (remaining <= len + TOL || i === ps.length - 2) {
          let t = clamp(remaining / len, 0, 1);
          // Pick the same physical incident segment at a vertex in either route
          // direction. This keeps signed offsets stable through reversal/splitting.
          if (Math.abs(remaining - len) <= TOL && i < ps.length - 2 && road.p[i + 2] < road.p[i]) {
            i++; a = ps[i]; b = ps[i + 1]; len = distance(a, b); t = 0;
          }
          return { q: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
            nx: len ? -(b.y - a.y) / len : 0, ny: len ? (b.x - a.x) / len : 0, segment: i };
        }
        remaining -= len;
      }
      return { q: ps[0], nx: 0, ny: 0, segment: 0 };
    }
    landmarkPosition(landmark) {
      const road = landmark && this._road(landmark.roadId);
      if (!road) return null;
      const frame = this._frame(road, landmark.t);
      return { x: frame.q.x + frame.nx * landmark.offset, y: frame.q.y + frame.ny * landmark.offset };
    }
    routeStart() {
      const road = this.state.roads.find(r => r.route);
      return road ? this.state.pts[road.p[0]] : null;
    }
    routeEnd() {
      const road = this.state.roads.filter(r => r.route).at(-1);
      return road ? { point: this.state.pts[road.p.at(-1)], previous: this.state.pts[road.p.at(-2)] } : null;
    }
  }
  return JunctionModel;
});
