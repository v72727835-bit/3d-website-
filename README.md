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

- the detailed horse/knight scan uses continuous GPU deformation fields for
  four staggered legs, knee flexion, neck nod, tail movement and rider response;
  the same deformation runs in its shadow pass;
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

Surfaces carry drawn detail maps — a hair grain on the coats, brushing and
scuffs on the metal, overlapping scales on the dragon — because a single
uniform highlight is what makes a rendered surface look like moulded plastic.
The maps are painted to a canvas at load and their normal maps are derived from
them, so the page still ships no image files. A shadow-mapped key light follows
the ride for self-shadowing, and a soft contact shadow keeps it standing in the
room rather than pasted over it.

## Sound

`dist/entrysfx.js` synthesises the entrance audio — no sound files either.
Hooves are a noise crack over a pitched thud, struck on a gallop rhythm that
matches the leg cycle; the coach adds iron-rim rumble and harness bells; the
bike is two detuned sawtooths through a moving lowpass with gear shifts,
turbo whistle and exhaust pops; the dragon is a formant-filtered roar over a
sub, with wingbeats on the rig's flap rate and fire on the centre hold.

Every voice for an entrance is scheduled up front against the audio clock, so
the sound holds its timing even if the frame rate dips and nothing runs per
frame. The mix pans right to left with the ride and passes through a small
generated reverb, into a limiter. Sound is off by default and the toggle
unlocks the audio context from the click, as browsers require.

The pegasus's animated horse base is the CC0 “Horse” model by Quaternius from Poly Pizza
(https://poly.pizza/m/qvTrSG9pZF). It is public domain and permitted for
commercial use. It has been refined with two Loop subdivision passes, interpolated
skin weights, smooth normals and coat UVs using `scripts/refine-horse.py` (NumPy).
The page supplies its own materials, tapered feather geometry, bridle and staging.
The collar and wing roots follow the animated neck. The coach has green window
panes, a ribbed gold dome, leaf scrolls, suspension and leather traces.

`dist/horse-motion.js` also renders the moving sunset, clouds, distant mountains
and arrival mist directly in WebGL. They are generated shaders, not reference
video overlays. First playback waits for model preparation to finish.

The clips in `dist/assets/` are kept only as a fallback: if the browser cannot
give the page a WebGL context, `main.js` drops the `gl` class and the previous
video and CSS entrances play instead.

## Dropping in a 3D model

`dist/index.html` lists which rides load a GLB instead of their built-in rig:

```html
<script>window.ENTRY3D_MODELS = ['horse'];</script>
```

Each listed key loads `dist/assets/models/<key>.glb`. Keys are `horse`,
`carriage`, `bike` and `dragon`; remove one to go back to the procedural
version. The flight path, lighting, shadows, trail, sparks, camera and sound
all apply unchanged.

Downloaded models arrive facing any direction at any scale, so each entry in
`ENTRIES` carries a `model` block — `rotationY` to turn it onto the path,
`length` and `groundY` to fit it to the same space the built-in rig occupies.
`horse` is set to `rotationY: -Math.PI / 2` because that model faces +z.
Imported materials get a stronger environment contribution and lose the
double-sided flag exporters tend to set, since photographic textures need more
neutral fill than the stage's warm key light gives the stylised rigs.

If a model carries animation clips the first one plays. The supplied detailed
horse has no skeleton: `horse-motion.js` articulates its original vertices in a
vertex shader with smooth leg/neck/tail masks. This preserves the scan and its
UV texture but is an approximation, not a replacement for a professionally
weight-painted skeleton. Other imported static models use a small body bounce.

Models need preparing for the web before they go in here. The horse started as
a 57 MB, 1.07-million-vertex scan, which would have taken minutes to load on a
phone. Simplified to 110k vertices, its texture resized to 1024 and the whole
thing meshopt-compressed, it ships at 1.4 MB:

```
gltf-transform simplify in.glb a.glb --ratio 0.07 --error 0.002
gltf-transform resize   a.glb  b.glb --width 1024 --height 1024
gltf-transform meshopt  b.glb  dist/assets/models/horse.glb
```

## Notes

`npm run check` syntax-checks the page scripts. The page works on touch and
keyboard; a reduced-motion preference shortens the entrances and stops the
decorative CSS motion. Sound is off by default. Rendering resolution is capped
on low-core devices. This is a visual entry demonstration, not a live
multi-user voice-chat service.
