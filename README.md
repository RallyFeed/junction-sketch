# RallyMaker · mobile roadbook notes

Live app: https://rallyfeed.github.io/junction-sketch/

A white, one-hand roadbook sketchpad with blue controls. No build step or external runtime dependencies.

## Capture a point

Draw the route from its entry dot toward the exit arrow. Strokes become cubic curves. Draw a fork from a road and it snaps to that curve; the original road keeps its shape. A brief lift near the previous endpoint continues the stroke.

Tap a road to edit with a few handles. Tap empty paper to return to Pen. Selected roads offer surface style and Delete. Undo is always in the thumb toolbar, with a quick Undo immediately after drawing. Clear removes the visible sketch and can be undone; text, attachments and original ink stay with the point.

Four landmark favourites sit above the toolbar. More opens the full searchable collection; Edit lets you choose and reorder favourites. House, tree and similar symbols use tap-to-place. Hedge, sandbank and waterline follow a drawn curve. Selected sandbanks can flip their hatching side.

Note opens text, photos, voice recording and attached audio. Closing Note lets recording continue, with a Stop control on the drawing. Done finishes media writes and opens the point review. Add an optional trip-meter reading and choose Next point. The header opens saved points.

## Device storage and backups

Points and attachment blobs are saved to IndexedDB on this browser and origin. A small localStorage journal protects recent sketch/text changes. This is device storage, not account sync: use Options → Download complete backup to move or preserve all points and media. Import adds copies without replacing existing points. SVG export contains a clean tulip without the drawing grid.

Existing v1 roadbook points remain readable. Their geometry is converted in memory when opened; the original sketch is retained in the note on its first edited save. Original ink and capture timestamps are retained. Invalid legacy geometry is left intact for backup/recovery rather than replaced.

GPS is optional and enabled explicitly in Options. A recent location fix and capture time are frozen when a new point is first touched or noted. Camera, microphone and GPS depend on the browser, device permissions and HTTPS. Voice recordings are limited to five minutes, with periodic durable checkpoints. Audio-file attachment remains available when recording is unsupported. Test physical capture controls on the target phone before field use.

Photo files are limited to 20 MiB, audio attachments to 50 MiB. Backups can contain all stored data; import accepts up to 50 MiB of decoded media and 16 MiB of note data per file. The interface reports save failures and retains unsaved attachments for a recovery backup.

## Files and verification

- `index.html`, `styles.css`: approved mobile interface and native page layout.
- `editor.js`: curve geometry, snapping, editing, landmarks, undo and SVG export.
- `app.js`: point ownership, persistence, review, GPS and backups.
- `note-media.js`: native media capture, durable writes, recovery and playback.
- `store.js`: validated point/media storage and portable backup/import.
- `icons.js`, `LICENSE.icons`: bundled Lucide icons; no remote icon requests.
- `model.js`: retained legacy geometry implementation, not loaded by the new app.
- `sw.js`: complete offline app shell after the first successful online load.

Run `node --test tests/*.test.cjs` and `node --check app.js`. Tests cover geometry, shared endpoints, gesture continuation, legacy migration, backup round trips, save ownership and media failure recovery. Browser layout and actual phone permissions need browser/device testing.

GitHub Pages serves the root of `main`. The service worker installs a complete new release and activates after existing app tabs close, avoiding mixed old and new scripts. Close all app tabs and reopen if an older cached interface remains visible.
