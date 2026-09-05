# RallyMaker · Roadbook notes

A phone-first roadbook note maker, hosted on [GitHub Pages](https://rallyfeed.github.io/junction-sketch/).

## Capture at the point

Mark a point, draw the route from arrival to exit, then draw side roads. Ends snap to the displayed road geometry and crossings share junction points. Adjust moves connected points together. Undo and redo stay visible. Fixed landmarks attach to roads; surface changes split a road into independently styled sections.

The mark time and available GPS fix are frozen before editing. Enable GPS explicitly if wanted. Total distance is an optional trip-meter reading; the app does not invent a distance from a location fix. Voice, photos and text stay with the point that started their capture. Keep & next retains the note and returns to an unmarked drawing surface. Saved points can be reopened.

## Local data and backups

Notes, original ink and media are stored in IndexedDB on this device. A revision-guarded local draft journal helps recover interrupted sketching. Audio checkpoints are written approximately every five seconds during a recording, with a final save on stop. Browser termination can still lose work since the last completed write. Camera, microphone and GPS require the browser permissions chosen by the user.

Export a complete JSON backup before clearing site data or changing devices. It contains editable graphs, original ink, metadata, photos and audio. Import adds copies with new IDs; it does not overwrite existing notes. Imports currently support up to 50 MiB of decoded attachments and 16 MiB of note data. A point-only JSON export omits media bytes; SVG and original-ink PNG exports are also available. If storage fails, export a recovery backup while the tab is still open.

After the first successful online load, the service worker caches the app shell for offline use. New app versions wait for existing tabs to close, keeping HTML and scripts from the same release. Data remains local; this prototype has no server sync.

## Scope and conventions

This is a browser prototype, not yet a RallyTracking native screen. Landmark labels and road-surface patterns are draft conventions, not a certified FIA symbol set. Unjoin changes graph connectivity; add a bridge label or adjust geometry to make a crossing unambiguous. Automatic photo/voice interpretation, route reassignment by tracing and recce-video anchoring are future work.

The geometry is simplified to polylines with rounded line joins. Hit-testing and snapping use those same polylines; coarse angle rounding is deliberately absent so shallow forks and staggered junctions remain distinct. Clearing or deleting roads preserves the raw ink in the note; Undo restores the previous graph.

## Develop and deploy

No build, package install, API key or external CDN is needed.

```sh
python3 -m http.server 8080
node --test tests/*.test.cjs
```

Open localhost for local development (microphone APIs require a secure context, which browsers normally allow on localhost). Push these static files to the Pages source branch. Bump the cache name in `sw.js` for every published app release.

- `index.html`, `styles.css`, `app.js`: mobile interface, capture and exports
- `model.js`: pure shared-point geometry, undo/redo and road-relative landmarks
- `store.js`: local storage, validation and portable backup import/export
- `sw.js`, `manifest.webmanifest`, `icon.svg`: offline app shell and installation metadata
- `tests/`: geometry tests and a minimal DOM interaction harness

The interaction harness checks ordinary app transitions without a browser. It does not substitute for real-device microphone, camera, IndexedDB or layout tests. Field-test the actual phone, mount and gloves, including interruption/reload, and inspect every exported roadbook cell before publication.
