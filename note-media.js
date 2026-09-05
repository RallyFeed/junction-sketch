(function (global, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  if (global.document) global.NoteMedia = factory(global);
})(typeof window === 'object' ? window : globalThis, function createNoteMedia(env) {
  'use strict';
  const document = env.document;
  const root = document.getElementById('tulip-thumb-flow');
  if (!root) return null;
  const find = selector => root.querySelector(selector);
  const ui = {
    text: find('.tt-note-text'), photo: find('.tt-note-photo'), photoInput: find('.tt-note-photo-input'),
    voice: find('.tt-note-voice'), voiceLabel: find('.tt-note-voice-label'), audio: find('.tt-note-audio'),
    audioInput: find('.tt-note-audio-input'), attachments: find('.tt-note-attachments'),
    status: find('.tt-note-status'), count: find('.tt-note-count'), mini: find('.tt-note-record-mini'),
    time: find('.tt-note-record-time'), paper: find('.tt-paper')
  };
  if (Object.values(ui).some(element => !element)) return null;
  const PHOTO_LIMIT = 20 * 1024 * 1024, AUDIO_LIMIT = 50 * 1024 * 1024, RECORD_LIMIT = 5 * 60 * 1000;
  let hooks = {
    ensurePoint: async () => null,
    saveMedia: async () => { throw new Error('Note storage is not ready.'); },
    listMedia: async () => [],
    deleteMedia: async () => { throw new Error('Note storage is not ready.'); },
    onError: () => {}, onChange: () => {}
  };
  const attachments = new Map(), unsaved = new Map(), pending = new Set(), saves = new Map();
  const fileOwners = new Map();
  let activeNoteId = null, phase = 'idle', generation = 0, loadGeneration = 0, current = null, serial = 0;
  const clock = () => Date.now();
  const id = () => `media-${env.crypto?.randomUUID?.() || `${clock().toString(36)}-${++serial}-${Math.random().toString(36).slice(2)}`}`;
  const status = message => { ui.status.textContent = message; };
  function report(message, error) {
    status(message);
    try { hooks.onError(message, error); } catch (_) {}
  }
  function changed(record, kind) {
    try { hooks.onChange({ noteId: record.noteId, id: record.id, kind }); } catch (_) {}
  }
  function track(promise) {
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }
  function countNotes() {
    const count = attachments.size + (ui.text.value.trim() ? 1 : 0);
    ui.count.textContent = String(count);
    ui.count.hidden = count === 0;
    ui.attachments.hidden = attachments.size === 0;
    ui.count.setAttribute('aria-label', `${count} note ${count === 1 ? 'item' : 'items'}`);
  }
  function duration(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function recordingUI() {
    const recording = phase === 'recording';
    ui.voice.disabled = phase === 'stopping';
    ui.voice.setAttribute('aria-pressed', String(recording));
    ui.voiceLabel.textContent = phase === 'requesting' ? 'Cancel microphone request'
      : phase === 'stopping' ? 'Saving voice note…'
      : recording ? `Stop · ${duration(clock() - current.startedAt)}` : 'Voice';
    ui.mini.hidden = !recording;
    ui.mini.disabled = !recording;
    ui.paper.dataset.recording = String(recording);
    if (recording) ui.time.textContent = duration(clock() - current.startedAt);
  }
  function releaseTracks(stream) {
    if (stream) stream.getTracks().forEach(track => { try { track.stop(); } catch (_) {} });
  }
  function dispose(item) {
    const audio = item.row.querySelector('audio');
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    env.URL.revokeObjectURL(item.url);
    item.row.remove();
  }
  function clearAttachments() {
    attachments.forEach(dispose);
    attachments.clear();
    countNotes();
  }
  function renderAttachment(record) {
    if (record.noteId !== activeNoteId || !record.blob) return;
    if (attachments.has(record.id)) dispose(attachments.get(record.id));
    const item = { record, url: env.URL.createObjectURL(record.blob) };
    const label = record.name || (record.kind === 'photo' ? 'Picture note' : 'Voice note');
    const row = document.createElement('div');
    item.row = row;
    row.className = 'tt-note-attachment';
    row.dataset.kind = record.kind;
    row.dataset.mediaId = record.id;
    const media = document.createElement('div');
    media.className = 'tt-note-attachment-media';
    if (record.kind === 'photo') {
      const img = document.createElement('img');
      img.alt = label;
      img.src = item.url;
      img.onerror = () => {
        img.hidden = true;
        const fallback = document.createElement('span');
        fallback.className = 'tt-note-preview-unavailable';
        fallback.textContent = 'Picture attached · preview unavailable';
        media.appendChild(fallback);
      };
      media.appendChild(img);
    } else {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = item.url;
      audio.setAttribute('aria-label', `Play ${label}`);
      audio.addEventListener('error', () => {
        if (media.querySelector('.tt-note-preview-unavailable')) return;
        const fallback = document.createElement('span');
        fallback.className = 'tt-note-preview-unavailable';
        fallback.textContent = 'This audio format cannot play in this browser.';
        media.appendChild(fallback);
      });
      media.appendChild(audio);
    }
    const name = document.createElement('span');
    name.className = 'tt-note-attachment-label';
    name.textContent = `${label}${unsaved.has(record.id) ? ' · not saved' : ''}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'tt-note-remove';
    const removeIcon = document.createElement('i');
    removeIcon.setAttribute('data-lucide', 'trash-2');
    removeIcon.setAttribute('aria-hidden', 'true');
    remove.appendChild(removeIcon);
    remove.setAttribute('aria-label', `Remove ${label}`);
    remove.addEventListener('click', () => {
      if (remove.disabled) return;
      remove.disabled = true;
      track((async () => {
        try {
          // A pending checkpoint must finish before removal, otherwise it could recreate the attachment.
          await saves.get(record.id);
          await hooks.deleteMedia(record.id);
          unsaved.delete(record.id);
          const shown = attachments.get(record.id);
          if (shown) { dispose(shown); attachments.delete(record.id); }
          countNotes();
          status(`${record.kind === 'photo' ? 'Picture' : 'Audio'} removed.`);
          changed(record, 'deleted');
        } catch (error) {
          remove.disabled = false;
          report('Could not remove this attachment. It is still attached.', error);
        }
      })());
    });
    row.append(media, name, remove);
    attachments.set(record.id, item);
    ui.attachments.appendChild(row);
    if (env.lucide?.createIcons) env.lucide.createIcons({ attrs: { width: 18, height: 18 } });
    countNotes();
  }
  function save(record) {
    const previous = saves.get(record.id) || Promise.resolve();
    const work = previous.then(async () => {
      try {
        await hooks.saveMedia(record);
        unsaved.delete(record.id);
        changed(record, 'saved');
        return true;
      } catch (error) {
        unsaved.set(record.id, record);
        report('Attachment is not saved. Keep this page open and try Done again, or download a backup.', error);
        return false;
      }
    });
    saves.set(record.id, work);
    work.then(() => { if (saves.get(record.id) === work) saves.delete(record.id); });
    return track(work);
  }
  function ensureOwner() {
    let owner;
    try { owner = hooks.ensurePoint(); } catch (error) { owner = Promise.reject(error); }
    return track(Promise.resolve(owner).then(noteId => {
      if (!noteId) throw new Error('Mark the point before adding an attachment.');
      return noteId;
    }).catch(error => { report('Could not save this point. Try again before adding an attachment.', error); return null; }));
  }
  function choose(input, kind) {
    // Invoke before opening the camera/file picker. The returned id belongs to this capture forever.
    fileOwners.set(kind, ensureOwner());
    input.click();
  }
  function selectFiles(input, kind) {
    const files = Array.from(input.files || []);
    const owner = fileOwners.get(kind) || ensureOwner();
    fileOwners.delete(kind);
    input.value = '';
    if (!files.length) return;
    track((async () => {
      const noteId = await owner;
      if (!noteId) return;
      let added = 0;
      const errors = [];
      for (const file of files) {
        const photo = kind === 'photo';
        const valid = photo ? /^image\//i.test(file.type) && !/svg/i.test(file.type)
          : /^audio\//i.test(file.type) || (!file.type && /\.(m4a|mp3|wav|ogg|opus|webm|aac|flac)$/i.test(file.name));
        if (!valid) { errors.push(photo ? 'Choose a picture such as JPG or PNG.' : 'Choose an audio file.'); continue; }
        if (file.size > (photo ? PHOTO_LIMIT : AUDIO_LIMIT)) { errors.push(photo ? 'Each picture must be 20 MB or smaller.' : 'Each audio file must be 50 MB or smaller.'); continue; }
        if (!file.size) { errors.push('That file is empty. Choose another file.'); continue; }
        const extension = (file.name || '').split('.').pop().toLowerCase();
        const audioTypes = { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', aac: 'audio/aac', flac: 'audio/flac' };
        const blob = new env.Blob([file], { type: file.type || audioTypes[extension] || 'audio/webm' });
        const record = { id: id(), noteId, kind, blob, createdAt: new Date().toISOString(), mimeType: blob.type, name: (file.name || (photo ? 'Picture note' : 'Audio note')).slice(0, 255) };
        const saved = await save(record);
        renderAttachment(record);
        if (saved) added++;
      }
      if (unsaved.size) return;
      const addedText = added ? `${added} ${kind === 'photo' ? (added === 1 ? 'picture' : 'pictures') : (added === 1 ? 'audio note' : 'audio notes')} saved.` : '';
      status([addedText, ...new Set(errors)].filter(Boolean).join(' '));
    })().catch(error => report('Could not attach this file. Keep the original and try again.', error)));
  }
  function cancelRequest(message) {
    if (phase !== 'requesting') return;
    generation++;
    phase = 'idle';
    recordingUI();
    status(message || 'Microphone request cancelled.');
  }
  function recordingRecord(session) {
    const mimeType = session.recorder.mimeType || session.mime || session.chunks[0]?.type || 'audio/webm';
    const blob = new env.Blob(session.chunks, { type: mimeType });
    const extension = /mp4|aac/i.test(mimeType) ? 'm4a' : /ogg/i.test(mimeType) ? 'ogg' : 'webm';
    return { id: session.id, noteId: session.noteId, kind: 'audio', blob, mimeType,
      createdAt: new Date(session.startedAt).toISOString(),
      name: `Voice note ${new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.${extension}` };
  }
  async function finishSession(session) {
    if (session.finished) return session.done;
    session.finished = true;
    if (current === session) { phase = 'stopping'; recordingUI(); }
    env.clearInterval(session.timer);
    env.clearTimeout(session.limitTimer);
    releaseTracks(session.stream);
    const record = recordingRecord(session);
    let ok = false;
    if (record.blob.size) {
      ok = await save(record);
      renderAttachment(record);
      if (ok) status(session.error ? 'Recording interrupted. Available audio saved; check playback.'
        : session.reason === 'limit' ? 'Voice note saved. Recordings are limited to 5 minutes.'
        : session.reason === 'size' ? 'Voice note reached 50 MB. Available audio saved; check playback.'
        : session.reason === 'hidden' ? 'Recording stopped and saved when you left the page.' : 'Voice note saved.');
    } else {
      report(session.error ? 'Recording failed. Attach an audio file instead.' : 'No audio was recorded. Try again or attach an audio file.');
      ok = !session.error;
    }
    if (current === session) { current = null; phase = 'idle'; recordingUI(); }
    session.resolve(ok);
    return ok;
  }
  function stopRecording(reason) {
    if (phase === 'requesting') { cancelRequest(); return Promise.resolve(true); }
    const session = current;
    if (!session) return Promise.resolve(true);
    if (phase === 'stopping') return session.done;
    session.reason = reason || 'user';
    phase = 'stopping';
    env.clearInterval(session.timer);
    env.clearTimeout(session.limitTimer);
    recordingUI();
    try {
      if (session.recorder.state !== 'inactive') session.recorder.stop();
      else void finishSession(session);
    } catch (_) {
      session.error = true;
      void finishSession(session);
    } finally { releaseTracks(session.stream); }
    return session.done;
  }
  async function startRecording() {
    if (phase !== 'idle') return;
    if (!env.isSecureContext || !env.navigator.mediaDevices?.getUserMedia || !env.MediaRecorder) {
      status('Microphone unavailable here. Attach an audio file.'); return;
    }
    const attempt = ++generation;
    phase = 'requesting';
    recordingUI();
    const owner = ensureOwner();
    status('Allow microphone access to record a voice note.');
    let stream, session;
    try {
      // The owner is captured before the permission request can outlive this point.
      const noteId = await owner;
      if (!noteId || attempt !== generation) { if (attempt === generation) cancelRequest(); return; }
      stream = await env.navigator.mediaDevices.getUserMedia({ audio: true });
      if (attempt !== generation || phase !== 'requesting' || !root.isConnected || document.hidden) {
        releaseTracks(stream);
        if (attempt === generation && phase === 'requesting') cancelRequest();
        return;
      }
      const formats = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
      const mime = typeof env.MediaRecorder.isTypeSupported === 'function' ? formats.find(type => env.MediaRecorder.isTypeSupported(type)) : '';
      const recorder = mime ? new env.MediaRecorder(stream, { mimeType: mime }) : new env.MediaRecorder(stream);
      session = { id: id(), noteId, recorder, stream, mime, chunks: [], bytes: 0, startedAt: clock(), lastCheckpoint: clock(), finished: false, error: false };
      session.done = new Promise(resolve => { session.resolve = resolve; });
      current = session;
      recorder.addEventListener('dataavailable', event => {
        if (session.finished || !event.data?.size) return;
        if (session.bytes + event.data.size > AUDIO_LIMIT) { stopRecording('size'); return; }
        session.bytes += event.data.size;
        session.chunks.push(event.data);
        if (clock() - session.lastCheckpoint >= 5000 && phase === 'recording') {
          session.lastCheckpoint = clock();
          void save(recordingRecord(session));
        }
      });
      recorder.addEventListener('stop', () => { void finishSession(session); });
      recorder.addEventListener('error', () => { session.error = true; void stopRecording('error'); });
      recorder.start(1000);
      phase = 'recording';
      recordingUI();
      status('Recording… close this panel to keep sketching. Tap Stop to finish.');
      session.timer = env.setInterval(recordingUI, 500);
      session.limitTimer = env.setTimeout(() => stopRecording('limit'), RECORD_LIMIT);
    } catch (error) {
      releaseTracks(stream);
      if (session) {
        session.finished = true;
        env.clearInterval(session.timer);
        env.clearTimeout(session.limitTimer);
        try { if (session.recorder.state !== 'inactive') session.recorder.stop(); } catch (_) {}
        session.resolve(false);
      }
      if (attempt !== generation) return;
      current = null; phase = 'idle'; recordingUI();
      report('Microphone unavailable here. Attach an audio file.', error);
    }
  }
  async function finish() {
    const recordingSaved = await stopRecording('done');
    while (pending.size) await Promise.allSettled(Array.from(pending));
    const retry = Array.from(unsaved.values());
    if (retry.length) await Promise.all(retry.map(save));
    retry.forEach(record => renderAttachment(record));
    if (retry.length && !unsaved.size) status('Photos and voice saved with this point.');
    return (recordingSaved || retry.length > 0) && unsaved.size === 0;
  }
  async function loadPoint(noteId, text) {
    const token = ++loadGeneration;
    activeNoteId = noteId || null;
    clearAttachments();
    if (typeof text === 'string') ui.text.value = text;
    countNotes();
    if (!noteId) { status('Photos and voice stay with this point.'); return true; }
    try {
      const records = await hooks.listMedia(noteId);
      if (token !== loadGeneration) return false;
      const merged = new Map(records.map(record => [record.id, record]));
      unsaved.forEach(record => { if (record.noteId === noteId) merged.set(record.id, record); });
      Array.from(merged.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).forEach(renderAttachment);
      if (phase === 'idle') status(unsaved.size ? 'Some attachments are not saved. Keep this page open and download a backup.' : 'Photos and voice stay with this point.');
      return true;
    } catch (error) {
      if (token !== loadGeneration) return false;
      unsaved.forEach(renderAttachment);
      report('Could not load saved attachments. Try reopening this point.', error);
      return false;
    }
  }
  ui.text.addEventListener('input', countNotes);
  ui.photo.addEventListener('click', () => choose(ui.photoInput, 'photo'));
  ui.photoInput.addEventListener('change', () => selectFiles(ui.photoInput, 'photo'));
  ui.audio.addEventListener('click', () => choose(ui.audioInput, 'audio'));
  ui.audioInput.addEventListener('change', () => selectFiles(ui.audioInput, 'audio'));
  ui.voice.addEventListener('click', () => {
    if (phase === 'requesting') cancelRequest();
    else if (phase === 'recording') void stopRecording('user');
    else if (phase === 'idle') void startRecording();
  });
  ui.mini.addEventListener('click', () => { void stopRecording('user'); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) void stopRecording('hidden'); });
  env.addEventListener('pagehide', () => { void stopRecording('hidden'); });
  status('Photos and voice stay with this point.');
  countNotes();
  recordingUI();
  return {
    configure(options) { hooks = { ...hooks, ...options }; },
    loadPoint, finish,
    isBusy: () => phase !== 'idle' || pending.size > 0,
    hasUnsaved: () => unsaved.size > 0,
    recoveryMedia: () => Array.from(unsaved.values())
  };
});
