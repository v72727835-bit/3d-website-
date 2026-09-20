# Royal Entry Room

A mobile-first voice-room page whose entrances are rendered live in WebGL.

Run `npm start`, then open http://localhost:4173. There is no build step and no
install: Three.js is vendored under `dist/vendor/three/`, so `dist/` is a static
site that also opens straight from `dist/index.html` over a local server.

The main button cycles through horse rider → royal rath → superbike → golden
dragon, then repeats. Replay repeats the previous entry without advancing the
order. The back arrow resets the sequence. The sound button enables generated
entrance sound effects. Edit changes the room and entrance names.

## How the entrances work

Earlier versions played perspective-cropped H.264 taken from phone recordings of
the reference app, which carried over that footage's blur, glare and fragments of
the original room UI. Each ride is now a Three.js rig built from articulated
joints in `dist/entry3d.js` and rendered in real time, so it is sharp at any
resolution and the motion is generated rather than replayed:

- the horse runs a real gallop cycle — four legs with staggered hip, knee and
  fetlock rotations, plus body bounce, mane and tail follow-through;
- the royal rath is drawn by a pegasus whose feathered wings beat while the
  coach's spoked wheels roll at the speed the coach is actually travelling;
- the superbike's wheels spin, the nose lifts under power, and the rider stays
  tucked over the tank;
- the dragon's spine is repositioned along a travelling sine each frame, with
  bat-style wings whose membrane is derived from where the finger bones end.

Lighting is image-based (a generated room environment) so the gold reads as
metal, with a bloom pass, a path-derived comet trail, drifting sparks and a
camera that eases in for the centre beat. The room UI around the stage is HTML
and CSS.

The clips in `dist/assets/` are kept only as a fallback: if the browser cannot
give the page a WebGL context, `main.js` drops the `gl` class and the previous
video and CSS entrances play instead.

## Dropping in a 3D model

To replace a procedural body with a GLB, list its key before `main.js` runs and
put the file next to the page:

```html
<script>window.ENTRY3D_MODELS = ['dragon'];</script>
```

with `dist/assets/models/dragon.glb`. The model is scaled and grounded
automatically, its first animation clip is played if it has one, and the flight
path, lighting, trail, sparks and camera work are applied unchanged. Keys are
`horse`, `carriage`, `bike` and `dragon`.

## Notes

`npm run check` syntax-checks the page scripts. The page works on touch and
keyboard; a reduced-motion preference shortens the entrances and stops the
decorative CSS motion. Sound is off by default. Rendering resolution is capped
on low-core devices. This is a visual entry demonstration, not a live
multi-user voice-chat service.
