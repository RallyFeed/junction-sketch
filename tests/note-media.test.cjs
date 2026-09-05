'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createNoteMedia = require('../note-media.js');

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.events = {}; this.dataset = {}; this.attrs = {}; this.value = ''; this.isConnected = true; this.disabled = false; }
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  emit(name, value = {}) { for (const fn of this.events[name] || []) fn(value); }
  click() { if (!this.disabled) this.emit('click'); }
  setAttribute(key, value) { this.attrs[key] = value; }
  removeAttribute(key) { delete this.attrs[key]; }
  append(...items) { for (const item of items) this.appendChild(item); }
  appendChild(item) { item.parent = this; this.children.push(item); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  querySelector(selector) {
    return this.children.map(child => (selector.startsWith('.') ? child.className === selector.slice(1) : child.tagName === selector) ? child : child.querySelector(selector)).find(Boolean) || null;
  }
  pause() {}
  load() {}
}
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function setup(options = {}) {
  const selectors = ['text','photo','photo-input','voice','voice-label','audio','audio-input','attachments','status','count','record-mini','record-time'];
  const fields = Object.fromEntries(selectors.map(name => [`.tt-note-${name}`, new Element()]));
  fields['.tt-paper'] = new Element();
  const root = new Element();
  root.querySelector = selector => fields[selector];
  const document = new Element();
  document.getElementById = () => root;
  document.createElement = tag => new Element(tag);
  const revoked = [];
  const stream = { stopped: 0, getTracks() { return [{ stop: () => stream.stopped++ }]; } };
  class Recorder extends Element {
    static isTypeSupported() { return true; }
    constructor(source, settings = {}) { super(); this.mimeType = settings.mimeType || 'audio/webm'; this.state = 'inactive'; Recorder.instances.push(this); }
    start() { if (options.startError) throw new Error('Cannot start'); this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.emit('dataavailable', { data: new Blob(['final audio'], { type: this.mimeType }) }); this.emit('stop'); }); }
  }
  Recorder.instances = [];
  let uuid = 0, urlId = 0;
  const env = {
    document, Blob, isSecureContext: true, MediaRecorder: Recorder,
    navigator: { mediaDevices: { getUserMedia: options.getUserMedia || (async () => stream) } },
    URL: { createObjectURL: () => `blob:${++urlId}`, revokeObjectURL: value => revoked.push(value) },
    crypto: { randomUUID: () => `test-${++uuid}` },
    addEventListener() {}, setInterval() { return 1; }, setTimeout() { return 2; }, clearInterval() {}, clearTimeout() {}
  };
  const api = createNoteMedia(env), records = new Map(), errors = [];
  let noteId = 'point-1';
  api.configure({
    ensurePoint: () => Promise.resolve(noteId), saveMedia: async record => records.set(record.id, record),
    listMedia: async owner => [...records.values()].filter(record => record.noteId === owner),
    deleteMedia: async id => records.delete(id), onError: message => errors.push(message)
  });
  const field = name => fields[`.tt-note-${name}`];
  const photo = () => {
    const blob = new Blob(['photo bytes'], { type: 'image/jpeg' }); blob.name = 'junction.jpg';
    field('photo-input').files = [blob]; field('photo-input').emit('change');
  };
  return { api, env, records, errors, field, photo, Recorder, stream, revoked, setPoint: id => { noteId = id; } };
}

test('Done waits for selected pictures to commit and a reopened point restores the same blob', async () => {
  const h = setup(), commit = deferred();
  await h.api.loadPoint('point-1', 'Original note');
  h.api.configure({ saveMedia: async record => { await commit.promise; h.records.set(record.id, record); } });
  h.field('photo').click(); h.photo();
  let finished = false;
  const done = h.api.finish().then(result => { finished = true; return result; });
  await flush(); assert.equal(finished, false);
  commit.resolve(); assert.equal(await done, true);
  assert.equal(h.field('count').textContent, '2');
  assert.equal(h.records.size, 1);
  await h.api.loadPoint('point-2', '');
  assert.equal(h.field('count').textContent, '0');
  assert.equal(h.revoked.length, 1);
  await h.api.loadPoint('point-1', 'Original note');
  assert.equal(h.field('attachments').children.length, 1);
  assert.equal(await [...h.records.values()][0].blob.text(), 'photo bytes');
});

test('a camera result belongs to the point where the chooser opened even after another point loads', async () => {
  const h = setup();
  await h.api.loadPoint('point-1', '');
  h.field('photo').click();
  h.setPoint('point-2'); await h.api.loadPoint('point-2', '');
  h.photo(); await h.api.finish();
  assert.equal([...h.records.values()][0].noteId, 'point-1');
  assert.equal(h.field('attachments').children.length, 0);
  await h.api.loadPoint('point-1', '');
  assert.equal(h.field('attachments').children.length, 1);
});

test('failed media saves block Done, retain recoverable bytes, and can later retry', async () => {
  const h = setup();
  await h.api.loadPoint('point-1', '');
  h.api.configure({ saveMedia: async () => { throw new Error('Quota exceeded'); } });
  h.field('photo').click(); h.photo();
  assert.equal(await h.api.finish(), false);
  assert.equal(h.api.hasUnsaved(), true);
  assert.equal(h.api.recoveryMedia().length, 1);
  assert.equal(await h.api.recoveryMedia()[0].blob.text(), 'photo bytes');
  assert.match(h.field('attachments').children[0].querySelector('.tt-note-attachment-label').textContent, /not saved/);
  h.api.configure({ saveMedia: async record => h.records.set(record.id, record) });
  assert.equal(await h.api.finish(), true);
  assert.equal(h.api.hasUnsaved(), false);
  assert.equal(h.records.size, 1);
});

test('cancelled microphone permission may resolve late without starting a recording', async () => {
  const permission = deferred(), h = setup({ getUserMedia: () => permission.promise });
  await h.api.loadPoint('point-1', '');
  h.field('voice').click(); await flush();
  assert.equal(h.api.isBusy(), true);
  assert.equal(await h.api.finish(), true);
  permission.resolve(h.stream); await flush();
  assert.ok(h.stream.stopped > 0);
  assert.equal(h.Recorder.instances.length, 0);
  assert.equal(h.api.isBusy(), false);
});

test('recording uses its original owner and Done awaits final audio storage', async () => {
  const h = setup(), commit = deferred();
  await h.api.loadPoint('point-1', '');
  h.field('voice').click(); await flush();
  assert.equal(h.field('record-mini').hidden, false);
  h.setPoint('point-2'); await h.api.loadPoint('point-2', '');
  h.api.configure({ saveMedia: async record => { await commit.promise; h.records.set(record.id, record); } });
  let finished = false;
  const done = h.api.finish().then(result => { finished = true; return result; });
  await flush(); assert.equal(finished, false);
  commit.resolve(); assert.equal(await done, true);
  assert.equal([...h.records.values()][0].noteId, 'point-1');
  assert.equal([...h.records.values()][0].kind, 'audio');
  assert.equal(await [...h.records.values()][0].blob.text(), 'final audio');
  assert.equal(h.field('record-mini').hidden, true);
});

test('recorder startup failure releases the microphone and leaves navigation usable', async () => {
  const h = setup({ startError: true });
  await h.api.loadPoint('point-1', '');
  h.field('voice').click(); await flush();
  assert.ok(h.stream.stopped > 0);
  assert.equal(h.api.isBusy(), false);
  assert.equal(await h.api.finish(), true);
  assert.match(h.field('status').textContent, /Attach an audio file/);
});

test('an attachment stays visible until durable deletion commits; failed deletion preserves it', async () => {
  const h = setup(), commit = deferred();
  await h.api.loadPoint('point-1', '');
  h.field('photo').click(); h.photo(); await h.api.finish();
  h.api.configure({ deleteMedia: async () => { await commit.promise; throw new Error('Storage unavailable'); } });
  const row = h.field('attachments').children[0];
  row.querySelector('.tt-note-remove').click();
  await flush(); assert.equal(h.field('attachments').children.length, 1);
  commit.resolve(); await h.api.finish();
  assert.equal(h.field('attachments').children.length, 1);
  assert.equal(h.records.size, 1);
  h.api.configure({ deleteMedia: async id => h.records.delete(id) });
  row.querySelector('.tt-note-remove').click(); await h.api.finish();
  assert.equal(h.field('attachments').children.length, 0);
  assert.equal(h.records.size, 0);
});

test('voice checkpoints and final audio use one media id and final save includes all chunks', async () => {
  const h = setup(), writes = [];
  await h.api.loadPoint('point-1', '');
  h.api.configure({ saveMedia: async record => { writes.push(record); h.records.set(record.id, record); } });
  h.field('voice').click(); await flush();
  const realNow = Date.now;
  try {
    const future = realNow() + 6000;
    Date.now = () => future;
    h.Recorder.instances[0].emit('dataavailable', { data: new Blob(['earlier audio|'], { type: 'audio/webm' }) });
    await flush();
  } finally { Date.now = realNow; }
  assert.equal(writes.length, 1);
  assert.equal(await h.api.finish(), true);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].id, writes[1].id);
  assert.equal(h.records.size, 1);
  assert.equal(await writes[1].blob.text(), 'earlier audio|final audio');
});
