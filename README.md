# Junction sketch — concept handover

Finger-drawn roadbook junctions at a recce waypoint, converted to tulip vectors in the field.
Part of the RallyMaker organiser tooling; the sketch is one more attachment on a waypoint, next to the voice note and photo.

**Status:** interaction model agreed, working browser prototype, Figma flow. Not yet in the React Native app.
**Date:** 5 September 2026 · **Owners:** Kris Männama, Alexander Kovatchev

## Links

| What | Where |
|---|---|
| Live prototype | https://rallyfeed.github.io/junction-sketch/ |
| Repo (source of the prototype, this document) | https://github.com/RallyFeed/junction-sketch |
| Figma flow (5 screens, RallyFeed team) | https://www.figma.com/design/Uz7daLsTIYvnqNXWuYomwW |
| Target app | `RallyFeed/RallyTracking` (private) — waypoint model, FIA pictogram picker, design tokens |
| Design system reference | *RallyFeed · Tracking design system* PDF, baseline 0.5.0 / 93175ae (2 Sep 2026) |

## 1. Why

During recce an organiser records the stage once: video, GPS, speed, GSM level, voice notes per waypoint. At junctions a spoken note is not enough; the roadbook needs a tulip. Drawing it later at the desk means re-remembering the junction. Drawing it in the field with a finger, on a bumpy track, possibly with gloves, means the drawing tool has to be nearly rule-free.

Same principle as the voice notes: **capture stays dumb and offline; structure is added on the spot only where it is free, and everything else can wait for the desk.**

## 2. Interaction model

These are the rules the prototype implements. They came out of the 4 Sep discussion and should be treated as the spec until field testing says otherwise.

1. **First stroke is the route.** Where you start is where you arrive (ball). Where you lift is where you leave (arrow). Direction is never asked.
2. **Lift converts.** The raw stroke becomes a spline immediately, silently, with an Undo toast. No modal, no handles appear. The raw ink is kept underneath and can be shown.
3. **Every later stroke is another road.** Drawn thin. If an end lands within a glove-sized radius of an existing road it snaps onto it and becomes a shared node. If it crosses a road, a junction node is created in both.
4. **Lift grace.** If the finger comes back within ~280 ms close to where it left, the stroke continues. Corrugations lift fingers.
5. **Incremental, not batch.** Each stroke converts on its own lift. Reasons: you see the fit while the junction is in front of you; later strokes snap to geometry, not to raw ink; undo is one stroke. Batch conversion was considered and rejected.
6. **Edit is optional and separate.** Tap a road to select it. Drag nodes (shared nodes move every road that uses them). Tap the line to mark a spot, then *Split*. Set road type per section: tarmac (solid), gravel (dashed), track (dotted). Road type of a new road defaults to the route's type ("what you were driving on").
7. **Two strokes already make a valid tulip.** Splits, types and landmarks are refinements, not requirements.

### Agreed but not in the prototype

- **Landmark ring.** Hold on empty paper → a radial menu of 7 fixed slots (favourites) around the finger; drag or tap to pick; the seventh slot opens the full FIA pictogram grid that RallyTracking already has. Slots never auto-reorder (muscle memory). Landmark lands where you held and snaps to a left/right lane along the route. The same ring component, with different contents, serves road type on a selected section.
- **Glyph recognition.** A compact or closed stroke drawn away from any road is a pictogram candidate (house, gate, tree, danger). $1 / $P template recognisers (Wobbrock et al.) are ~100 lines, on-device, no ML. Adding a template is the same gesture as saving a favourite. Deferred deliberately.
- **Mistake detection.** The most likely error is drawing route + side road in one stroke. The converter can detect a self-crossing or reversal and offer to split.

## 3. The prototype

Single file, `index.html`, no dependencies, no build. Push to `main` and Pages redeploys.

```
index.html
├── <style>               design tokens + layout (mobile-first, glove-sized targets)
├── <script id="model">   pure logic: geometry, state, conversion, split, undo, export
└── <script>              UI: canvas rendering, pointer handling, toolbar, export sheet
```

The model script has no DOM dependency and was tested standalone in Node. It ports to React Native as-is.

### Data model

```js
state = {
  pts:   { p1: {x, y}, p2: {x, y}, ... },        // every point once
  roads: [ { id, p: ['p1','p2',...], type: 'tarmac'|'gravel'|'track', route: bool } ],
  raw:   [ [{x,y}, ...], ... ]                    // original ink, kept
}
```

Points are shared by id. A junction is simply a point id that appears in two roads' `p` arrays; a split is one road becoming two that share the split point. Dragging a shared point moves every road through it. Route pieces are the roads with `route: true`, in array order; the ball is the first point of the first piece, the arrow the last point of the last.

Undo is a stack of JSON snapshots of `{state, nextId}`.

### Algorithms

| Step | Method |
|---|---|
| Simplify | Ramer–Douglas–Peucker, ε = 7 px |
| Straightness | max deviation from chord < max(10 px, 6 % of chord) → 2 points |
| Angle snap | straight roads only, 15° steps, rotating the free end (a shared end never moves) |
| Smoothing | midpoint quadratic curves through interior points; a turn > ~50° is kept as a sharp corner |
| Snap-to-road | nearest point on polyline, radius 28 px; reuse an existing node within 12 px, else insert one |
| Crossings | segment–segment intersection, excluding shared endpoints; inserts a shared node in both roads |
| Hit test | nodes 22 px, route line 20 px, other roads 16 px |

### Constants to field-test

All at the top of the model script.

| Name | Value | What it does |
|---|---|---|
| `SNAP_R` | 28 | how close a stroke end must be to snap onto a road |
| `NODE_R` | 22 | node grab radius in edit mode |
| `MIN_LEN` | 20 | shorter strokes are taps, not roads |
| `RDP_EPS` | 7 | simplification tolerance |
| `REUSE_R` | 12 | reuse an existing node instead of inserting a new one |
| grace | 280 ms | lift grace before a stroke commits (`pendingTimer`) |
| sharp corner | 0.28 π | turn angle above which a point is a corner, not a bend |

Expect all of these to grow with gloves, corrugations and the OS font scale.

### Export

`Done` shows the roadbook cell and the JSON the desktop would receive:

```json
{
  "waypoint": "WP 14",
  "coords": "normalized to the longest side, y down",
  "route": [ { "type": "tarmac", "points": [[x,y], ...] }, { "type": "gravel", "points": [...] } ],
  "roads": [ { "type": "track",  "points": [[x,y], ...] } ],
  "rawStrokes": 3
}
```

Proposed deliverables per waypoint: `tulip.json` (above), `tulip.svg` rendered from it, `freehand.png` of the raw ink, all on the same clock as the voice note and the recce video so the desktop can jump between them.

## 4. Design constraints

- **Tokens** from the tracking design system: navy `#01143C` ground, tan `#D0A27C` accent on dark surfaces, blue `#265BCA` accent on light surfaces (the paper), off-white `#F4F4F5`, danger `#EF2D56`. Floating pills over the paper, no header bar, sheet radius 24, pill radius 1024. Type should be Doumbar / Inter / Iosevka Aile in the app; the prototype falls back to Inter.
- **Targets**: toolbar 64 px, type chips 60 px, floating controls 44 px. Sized for gloves.
- **Dynamic Type / display zoom** (Alexander, 4 Sep): targets, snap radii and node sizes must scale with the OS font scale, not just the text. Verify at iOS xxxLarge and one AX size, iOS Display Zoom, Android font scale 1.3 + display size.
- **Landscape and tablet** are real recce setups (dash-mounted iPad). The canvas should sit beside the map in landscape, not below it. Not designed yet.
- The sketch surface should be a **sheet with detents**, not a full-screen page, matching the rest of the tracking app.

## 5. Integration notes for RallyTracking

- Model script → a plain TS module. No React in it. Unit-test the scenario in this handover: L-shaped route, a crossing stroke, a stroke snapping onto the route, split, undo chain.
- Rendering: `@shopify/react-native-skia` is the natural fit (paths, dashes, high-frequency pointer input). `react-native-svg` works for the static tulip in the roadbook row.
- Input: Gesture Handler pan with `minDistance: 0`; implement the lift grace with a short timer exactly as the prototype does.
- Attachment shape on the waypoint: `{ kind: 'sketch', raw, roads, pts, createdAt }` alongside voice and photo. Keep `raw` forever; the vectors are derived.
- Landmarks: reuse the existing FIA pictogram picker (icon font, colours immune to theming) as the "more" target of the ring.
- Thumbnail in the roadbook row: render `tulip.json` at 6/3 px line weights, ball 8, arrow 14, as the prototype's `drawWith()` does.

## 6. Open questions

1. Snap radius, grace time and corner threshold — field test in a car, with gloves, then fix them.
2. Ring gesture: hold-then-drag vs hold-then-tap; both are supported in the concept, only one should ship.
3. Roadbook conventions to confirm with organisers: thin-vs-thick for non-route roads, dash patterns per road type, whether junction nodes should be visible in the final tulip.
4. Where refinement happens: allow full editing in the field, or hide splits/types behind "stopped" and do them at the desk?
5. Export target: does RallyMaker desktop consume `tulip.json` directly, or does it need SVG + a symbol library id per landmark?
6. Half-height sheet: the roadbook sheet lost its half-height detent in the layout pass; the sketch sheet has the same "map disappears" problem. Decide once for both.

## 7. Figma flow (for reference)

Five frames left to right: **01 Waypoint** (attachments, Sketch junction CTA) · **02 Draw** (two-stroke model) · **03 Convert (on lift)** (raw ink under spline, nodes, handles, undo toast) · **04 Edit** (split nodes, road type chips, landmark ring) · **05 Roadbook cell** (distance / tulip / notes, what the desktop gets). Colours match the tracking design system; Doumbar and Iosevka are not installed in the Figma workspace, so type there is Inter.
