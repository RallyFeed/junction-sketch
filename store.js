/* RoadbookStore — local note/media persistence and portable project backups.
 * Browser global: RoadbookStore. Also CommonJS-exported for validation tests.
 * All durable-write promises resolve only after the IndexedDB transaction commits.
 */
(function (root, factory) {
  'use strict';
  const Store = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = Store;
  else root.RoadbookStore = Store;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';
  const LIMITS = Object.freeze({
    noteBytes: 2 * 1024 * 1024,
    projectNoteBytes: 16 * 1024 * 1024,
    mediaBytes: 50 * 1024 * 1024,
    notes: 5000,
    media: 10000,
    points: 20000,
    roads: 1000,
    rawStrokes: 2000,
    rawPoints: 50000,
    landmarks: 1000
  });
  const plain = value => value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const requireValue = (condition, message) => { if (!condition) throw new TypeError(message); };
  const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  const isId = value => typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    !['__proto__', 'constructor', 'prototype'].includes(value);
  const dateString = value => typeof value === 'string' && value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
  const position = p => plain(p) && finite(p.x, -1000000, 1000000) && finite(p.y, -1000000, 1000000);
  const byteLength = text => new TextEncoder().encode(text).length;

  // Validate before cloning: JSON.stringify otherwise silently loses NaN, undefined,
  // custom objects and functions. Explicit key checks also exclude prototype payloads.
  function cloneJSON(value) {
    let nodes = 0;
    const seen = new Set();
    function walk(v, depth) {
      requireValue(++nodes <= 350000 && depth <= 24, 'Note structure is too large or too deeply nested.');
      if (v === null || typeof v === 'boolean') return;
      if (typeof v === 'number') { requireValue(Number.isFinite(v), 'Note contains a non-finite number.'); return; }
      if (typeof v === 'string') { requireValue(v.length <= LIMITS.noteBytes, 'Note text is too long.'); return; }
      requireValue(Array.isArray(v) || plain(v), 'Notes must contain only plain JSON values.');
      requireValue(!seen.has(v), 'Notes cannot contain circular references.');
      seen.add(v);
      const keys = Object.keys(v);
      requireValue(keys.length <= 100000, 'Note contains too many values.');
      for (const key of keys) {
        requireValue(key.length <= 256 && !['__proto__', 'constructor', 'prototype'].includes(key), 'Invalid note property.');
        walk(v[key], depth + 1);
      }
      seen.delete(v);
    }
    walk(value, 0);
    const text = JSON.stringify(value);
    requireValue(byteLength(text) <= LIMITS.noteBytes, 'Note exceeds the 2 MiB limit.');
    return JSON.parse(text);
  }

  function validateNote(input) {
    const note = cloneJSON(input);
    requireValue(plain(note) && isId(note.id), 'Note needs a valid id.');
    requireValue(Number.isSafeInteger(note.number) && note.number > 0, 'Note number must be a positive integer.');
    requireValue(dateString(note.createdAt) && dateString(note.updatedAt), 'Note timestamps must be ISO date strings.');
    requireValue(plain(note.anchor) && dateString(note.anchor.markedAt), 'Note needs an anchored capture time.');
    const loc = note.anchor.location;
    if (loc !== null) {
      requireValue(plain(loc) && finite(loc.lat, -90, 90) && finite(loc.lon, -180, 180) &&
        finite(loc.accuracyM, 0, 10000000), 'Invalid anchored location.');
      requireValue(finite(loc.timestamp, 0, 8640000000000000) || dateString(loc.timestamp), 'Invalid location timestamp.');
      if (loc.heading !== undefined && loc.heading !== null) requireValue(finite(loc.heading, 0, 360), 'Invalid location heading.');
      if (loc.speed !== undefined && loc.speed !== null) requireValue(finite(loc.speed, 0, 10000), 'Invalid location speed.');
    }
    requireValue(note.tripKm === null || finite(note.tripKm, 0, 100000000), 'Invalid trip distance.');
    requireValue(typeof note.text === 'string' && note.text.length <= 100000, 'Invalid note text.');
    requireValue(typeof note.review === 'boolean', 'Invalid review flag.');
    requireValue(Number.isSafeInteger(note.revision) && note.revision >= 0, 'Invalid note revision.');
    const s = note.sketch;
    requireValue(plain(s) && plain(s.pts) && Array.isArray(s.roads) && Array.isArray(s.raw) &&
      Array.isArray(s.landmarks) && Array.isArray(s.crossings), 'Invalid sketch structure.');
    requireValue(Object.keys(s.pts).length <= LIMITS.points && s.roads.length <= LIMITS.roads &&
      s.raw.length <= LIMITS.rawStrokes && s.landmarks.length <= LIMITS.landmarks && s.crossings.length <= 1000,
      'Sketch contains too many objects.');
    for (const [id, p] of Object.entries(s.pts)) requireValue(isId(id) && position(p), 'Invalid sketch point.');
    const roadIds = new Set();
    for (const road of s.roads) {
      requireValue(plain(road) && isId(road.id) && !roadIds.has(road.id), 'Invalid or duplicate road id.');
      roadIds.add(road.id);
      requireValue(Array.isArray(road.p) && road.p.length >= 2 && road.p.length <= LIMITS.points &&
        road.p.every(id => isId(id) && owns(s.pts, id)), 'Road refers to missing points.');
      requireValue(['tarmac', 'gravel', 'track'].includes(road.type) && typeof road.route === 'boolean', 'Invalid road type or route flag.');
      let length = 0;
      for (let i = 1; i < road.p.length; i++) {
        requireValue(road.p[i] !== road.p[i - 1], 'Road contains consecutive duplicate points.');
        const a = s.pts[road.p[i - 1]], b = s.pts[road.p[i]];
        length += Math.hypot(b.x - a.x, b.y - a.y);
      }
      requireValue(length > 0, 'Road must have a nonzero length.');
    }
    let rawPoints = 0;
    for (const stroke of s.raw) {
      requireValue(Array.isArray(stroke) && stroke.length <= LIMITS.rawPoints, 'Invalid original ink stroke.');
      rawPoints += stroke.length;
      requireValue(rawPoints <= LIMITS.rawPoints, 'Too many original ink points.');
      for (const p of stroke) requireValue(position(p) && (p.t === undefined || finite(p.t, 0, 8640000000000000)), 'Invalid original ink point.');
    }
    const landmarkIds = new Set();
    for (const landmark of s.landmarks) {
      requireValue(plain(landmark) && isId(landmark.id) && !landmarkIds.has(landmark.id), 'Invalid or duplicate landmark id.');
      landmarkIds.add(landmark.id);
      requireValue(typeof landmark.symbol === 'string' && landmark.symbol.length > 0 && landmark.symbol.length <= 100 &&
        roadIds.has(landmark.roadId) && finite(landmark.t, 0, 1) && finite(landmark.offset, -1000000, 1000000),
        'Invalid landmark or road reference.');
    }
    // Crossing semantics are reserved in v1; never import unknown graph topology.
    requireValue(s.crossings.length === 0, 'This version cannot import crossing records.');
    return note;
  }

  function mediaMetadata(input) {
    requireValue(plain(input) && isId(input.id) && isId(input.noteId), 'Media needs valid media and note ids.');
    requireValue(typeof input.kind === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(input.kind), 'Invalid media kind.');
    requireValue(dateString(input.createdAt), 'Invalid media capture timestamp.');
    const mimeType = input.mimeType || (input.blob && input.blob.type) || 'application/octet-stream';
    requireValue(typeof mimeType === 'string' && mimeType.length <= 200 && /^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[^\r\n]*)?$/i.test(mimeType), 'Invalid media MIME type.');
    const result = { id: input.id, noteId: input.noteId, kind: input.kind, createdAt: input.createdAt, mimeType };
    if (input.name !== undefined) {
      requireValue(typeof input.name === 'string' && input.name.length <= 255, 'Invalid media name.');
      result.name = input.name;
    }
    if (input.blob) result.size = input.blob.size;
    else if (input.size !== undefined) {
      requireValue(Number.isSafeInteger(input.size) && input.size >= 0 && input.size <= LIMITS.mediaBytes, 'Invalid media size.');
      result.size = input.size;
    }
    return result;
  }
  const withoutBlob = record => { const { blob, ...metadata } = record; return metadata; };
  const newestFirst = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id);
  function freshId(prefix) {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return prefix + root.crypto.randomUUID();
    requireValue(root.crypto && typeof root.crypto.getRandomValues === 'function', 'Secure random ids are unavailable.');
    return prefix + Array.from(root.crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
  }
  async function blobBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const parts = [];
    for (let i = 0; i < bytes.length; i += 32768) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 32768)));
    return root.btoa(parts.join(''));
  }
  function decodeBase64(text, maximumBytes) {
    requireValue(typeof text === 'string' && text.length <= Math.ceil(maximumBytes / 3) * 4 &&
      text.length % 4 === 0, 'Invalid or oversized base64 media.');
    const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
    // A flat invalid-character scan avoids grouped-regex stack growth on large files.
    requireValue(!/[^A-Za-z0-9+/]/.test(text.slice(0, text.length - padding)), 'Invalid base64 media.');
    const length = text.length * 3 / 4 - padding;
    requireValue(length <= maximumBytes, 'Project media exceeds the 50 MiB import limit.');
    const binary = root.atob(text), bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  class RoadbookStore {
    constructor(options) {
      this.name = options && options.name || 'rallymaker-roadbook-v1';
      this.db = null;
      this.opening = null;
      this.draftPrefix = this.name + ':draft:';
    }
    static validateNote(note) { return validateNote(note); }
    static get limits() { return LIMITS; }
    async open() {
      if (this.db) return this;
      if (this.opening) return this.opening;
      if (!root.indexedDB) throw new Error('This browser does not provide local database storage.');
      this.opening = new Promise((resolve, reject) => {
        let failed = false;
        const request = root.indexedDB.open(this.name, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('media')) {
            const media = db.createObjectStore('media', { keyPath: 'id' });
            media.createIndex('noteId', 'noteId', { unique: false });
          }
        };
        request.onerror = () => { failed = true; reject(request.error || new Error('Cannot open local storage.')); };
        request.onblocked = () => { failed = true; reject(new Error('Another tab is blocking local storage. Close it and retry.')); };
        request.onsuccess = () => {
          if (failed) { request.result.close(); return; }
          const db = request.result;
          this.db = db;
          db.onversionchange = () => { db.close(); if (this.db === db) this.db = null; };
          db.onclose = () => { if (this.db === db) this.db = null; };
          resolve(this);
        };
      });
      try { return await this.opening; } finally { this.opening = null; }
    }
    close() { if (this.db) this.db.close(); this.db = null; }
    async _transaction(names, mode, work) {
      await this.open();
      return new Promise((resolve, reject) => {
        let result, failure;
        const tx = this.db.transaction(names, mode);
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(failure || tx.error || new Error('Local storage transaction was aborted.'));
        tx.onerror = () => { failure = failure || tx.error; };
        const fail = error => { failure = error; try { tx.abort(); } catch (_) { reject(error); } };
        try { work(tx, value => { result = value; }, fail); } catch (error) { fail(error); }
      });
    }
    async listNotes() {
      const notes = await this._transaction(['notes'], 'readonly', (tx, set) => {
        tx.objectStore('notes').getAll().onsuccess = event => set(event.target.result);
      });
      return notes.sort(newestFirst);
    }
    async getNote(id) {
      requireValue(isId(id), 'Invalid note id.');
      return this._transaction(['notes'], 'readonly', (tx, set) => {
        tx.objectStore('notes').get(id).onsuccess = event => set(event.target.result);
      });
    }
    async saveNote(input) {
      const note = validateNote(input);
      return this._transaction(['notes'], 'readwrite', (tx, set) => { tx.objectStore('notes').put(note); set(note); });
    }
    async putMedia(input) {
      requireValue(input && Object.prototype.toString.call(input.blob) === '[object Blob]', 'Media needs a Blob.');
      requireValue(input.blob.size <= LIMITS.mediaBytes, 'An attachment cannot exceed 50 MiB.');
      const metadata = mediaMetadata(input), record = { ...metadata, blob: input.blob };
      return this._transaction(['notes', 'media'], 'readwrite', (tx, set, fail) => {
        tx.objectStore('notes').get(metadata.noteId).onsuccess = event => {
          if (!event.target.result) { fail(new Error('Save the junction before attaching media.')); return; }
          tx.objectStore('media').put(record);
          set(metadata);
        };
      });
    }
    async getMedia(id) {
      requireValue(isId(id), 'Invalid media id.');
      return this._transaction(['media'], 'readonly', (tx, set) => {
        tx.objectStore('media').get(id).onsuccess = event => set(event.target.result);
      });
    }
    async listMedia(noteId) {
      requireValue(isId(noteId), 'Invalid note id.');
      const records = await this._transaction(['media'], 'readonly', (tx, set) => {
        tx.objectStore('media').index('noteId').getAll(noteId).onsuccess = event => set(event.target.result);
      });
      return records.map(withoutBlob).sort(newestFirst);
    }
    async deleteMedia(id) {
      requireValue(isId(id), 'Invalid media id.');
      return this._transaction(['media'], 'readwrite', tx => { tx.objectStore('media').delete(id); });
    }
    async deleteNote(id) {
      requireValue(isId(id), 'Invalid note id.');
      await this._transaction(['notes', 'media'], 'readwrite', tx => {
        tx.objectStore('notes').delete(id);
        tx.objectStore('media').index('noteId').openCursor(id).onsuccess = event => {
          const cursor = event.target.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
        };
      });
      // Journal cleanup can independently fail; caller is told if it does.
      this.clearDraft(id);
    }
    writeDraft(input) {
      const note = validateNote(input);
      root.localStorage.setItem(this.draftPrefix + note.id, JSON.stringify(note));
      return note;
    }
    readDrafts() {
      const drafts = [];
      for (let i = 0; i < root.localStorage.length; i++) {
        const key = root.localStorage.key(i);
        if (key && key.startsWith(this.draftPrefix)) {
          const note = validateNote(JSON.parse(root.localStorage.getItem(key)));
          requireValue(key === this.draftPrefix + note.id, 'Draft id does not match its journal entry.');
          drafts.push(note);
        }
      }
      return drafts.sort(newestFirst);
    }
    clearDraft(id, expectedRevision) {
      requireValue(isId(id), 'Invalid draft id.');
      const key = this.draftPrefix + id;
      if (expectedRevision !== undefined) {
        const value = root.localStorage.getItem(key);
        if (value && JSON.parse(value).revision !== expectedRevision) return false;
      }
      root.localStorage.removeItem(key);
      return true;
    }
    async exportProject() {
      const snapshot = await this._transaction(['notes', 'media'], 'readonly', (tx, set) => {
        const data = { notes: [], media: [] };
        tx.objectStore('notes').getAll().onsuccess = event => { data.notes = event.target.result; };
        tx.objectStore('media').getAll().onsuccess = event => { data.media = event.target.result; };
        set(data);
      });
      const media = [];
      // Convert sequentially to avoid duplicating every attachment in memory at once.
      for (const record of snapshot.media) media.push({ ...withoutBlob(record), base64: await blobBase64(record.blob) });
      return { format: 'rallymaker-roadbook', version: 1, exportedAt: new Date().toISOString(), notes: snapshot.notes.sort(newestFirst), media };
    }
    async importProject(data) {
      requireValue(plain(data) && data.format === 'rallymaker-roadbook' && data.version === 1,
        'This file is not a supported RallyMaker roadbook backup.');
      requireValue(Array.isArray(data.notes) && data.notes.length <= LIMITS.notes &&
        Array.isArray(data.media) && data.media.length <= LIMITS.media, 'Project has too many notes or attachments.');
      const noteIds = new Map(), mediaIds = new Map(), notes = [], media = [];
      let noteBytes = 0, decodedBytes = 0;
      for (const input of data.notes) {
        const note = validateNote(input);
        requireValue(!noteIds.has(note.id), 'Project contains duplicate note ids.');
        noteBytes += byteLength(JSON.stringify(note));
        requireValue(noteBytes <= LIMITS.projectNoteBytes, 'Project note data exceeds the 16 MiB import limit.');
        const id = freshId('note_'); noteIds.set(note.id, id); note.id = id; notes.push(note);
      }
      for (const input of data.media) {
        const meta = mediaMetadata(input);
        requireValue(noteIds.has(meta.noteId) && !mediaIds.has(meta.id), 'Media has a missing note or duplicate id.');
        const bytes = decodeBase64(input.base64, LIMITS.mediaBytes - decodedBytes);
        decodedBytes += bytes.byteLength;
        requireValue(meta.size === undefined || meta.size === bytes.byteLength, 'Attachment size does not match its data.');
        const id = freshId('media_'); mediaIds.set(meta.id, id);
        media.push({ ...meta, id, noteId: noteIds.get(meta.noteId), size: bytes.byteLength, blob: new Blob([bytes], { type: meta.mimeType }) });
      }
      await this._transaction(['notes', 'media'], 'readwrite', tx => {
        // add() guarantees that even a random-id collision cannot replace local work.
        for (const note of notes) tx.objectStore('notes').add(note);
        for (const record of media) tx.objectStore('media').add(record);
      });
      return { noteCount: notes.length, mediaCount: media.length, noteIdMap: Object.fromEntries(noteIds), mediaIdMap: Object.fromEntries(mediaIds) };
    }
  }
  return RoadbookStore;
});
