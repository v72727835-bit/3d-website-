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

Surfaces carry drawn detail maps — a hair grain on the coats, brushing and
scuffs on the metal, overlapping scales on the dragon — because a single
uniform highlight is what makes a rendered surface look like moulded plastic.
The maps are painted to a canvas at load and their normal maps are derived from
them, so the page still ships no image files. A shadow-mapped key light follows
the ride for self-shadowing, and a soft contact shadow keeps it standing in the
room rather than pasted over it.

## The photoreal entrances

The horse rider and the royal rath render in a second look built for realism;
the superbike and dragon keep the stylised one. `ENTRIES.<key>.photoreal`
selects it, and `applyLook()` switches the whole stage when a ride starts:

- **Tone curve.** Khronos Neutral instead of ACES. ACES pushed the chestnut
  coat toward salmon pink, and AgX washed the sunset card out to pastel;
  Neutral keeps hues true and rolls highlights off gently.
- **Reflections.** A generated golden-hour studio — deep blue zenith, a warm
  low-sun horizon, three HDR softboxes — replaces the grey room environment for
  these two. Metal is mostly reflection, and this is what turns plaster-grey
  armour into polished steel.
- **Almost no bloom.** A glow around a white horse is the strongest "cartoon"
  cue there is. Sparkles, the flare and the comet trail are switched off; the
  floor glow and light shafts are dialled down; the pink stage fill is off.

The imported model is one mesh with one colour texture, so its armour rendered
exactly like its coat. `applyRealisticSurface()` classifies each texel in the
fragment shader — grey inside the rider's measured volume is steel (metallic,
polished), saturated is coat (satin, deepened to chestnut), dark is leather —
and a detail normal map is derived from the texture's own shading at load,
which brings out the engraving on the plate and the muscle under the coat. The
same patch with `tint: 'white'` makes the grey-white carriage team.

Hooves and wheels kick up dust: soft, non-additive puffs left where they were
kicked, so they trail behind the ride and take the light instead of glowing.
The knight carries a velvet swallowtail guidon — sheen material, gold
embroidery that is actually metallic, a real notch, and it streams *behind*
the horse, as a banner on a galloping horse must.

### The coach

`buildStateCoach()` replaces the old capsule-built pegasus and cart. The body
is a stack of rounded-rectangle rings that swell out and back in with height
(the bombé belly of a real state coach), closed by a domed roof, and every ring
is parameterised by arc length over fixed segments — so one (u, v) map lines up
with the geometry at every height. Colour, roughness/metalness and height are
painted against that map: crimson lacquer panels recessed into burnished gold,
matte chased scrolls, gadroons, egg-and-dart, the arms on the doors. Mouldings,
window frames and the door are real tubes laid along curves on the same map;
the windows are conforming glass patches over a lit interior with velvet
curtains. On top: a crown with pearl-strung arches and jewels, and turned urns
at the corners. Underneath: dished, lacquered spokes (merged into one mesh per
wheel), gilt felloes, iron tyres, turned naves, a perch, C-springs, and leather
braces the body actually sways from.

With `fairy: true` (what the room uses, matching the reference video) the
coach is gold all over — its panels a deeper, matte chased gold instead of
crimson — with teal glass in the windows. It is drawn by a single winged horse:
the scanned horse with its rider cut away in the fragment shader (the cut
volumes were measured off the mesh: above the saddle between cantle and withers
everything is rider; along the flank only the grey of the armoured legs is),
tinted white with a golden mane, tail, saddle and bridle. It rears in the
traces — the body pitches up about the hind hooves while the forelegs, raised
and folded, paw the air — under a pair of feathered wings (`buildWing()`:
primaries, secondaries and two rows of coverts, each a cupped quad with a drawn
vane, merged into one mesh per wing). The coach rides a luminous bank of white
and lavender cloud that streams past it, glides in from the right as it fades
up, holds centre stage, blooms a white flash around the horse, and fades away.

### The sunset card

The horse rider plays inside a full-width golden-hour scene card, as in the
reference: a low sun with a lens-smeared streak, torn cloud banks lit gold near
the sun and wine-dark away from it, three ranges of ridged-multifractal
mountains in aerial haze, and a thin bright line under the ground. It is one
procedural fragment shader (`SUNSET_FRAG`) on a fullscreen quad drawn first in
the opaque pass. The ranges scroll at different speeds, so the horse gallops in
place at centre while the land races past; embers and a hot glow flick off the
hooves. The whole layer — card, horse and effects — fades out together.

### First-play stall

WebGL compiles a shader the first time it is drawn, synchronously. With
physical materials and their shadow twins that can freeze the first entrance,
badly on phones. `warmUp()` waits for the models, then draws every rig once in
both looks while the stage is still transparent. `main.js` calls it right
after preparing the rides.

### Fixed along the way

Every wheel — coach and superbike — was spinning backwards. A wheel moving
toward -x must turn so its top edge also moves toward -x; the angle now grows
with distance travelled.

Every ride sat in a black box over the room. `UnrealBloomPass` blends its
result with additive blending, whose alpha term is `srcAlpha * srcAlpha +
dstAlpha`, and the bloom target's alpha is 1 everywhere — so every transparent
pixel of the frame came out opaque. Its blend now adds light rather than
opacity: RGB still adds, and alpha rises only by how bright the bloom is at
that pixel, which is also what lets a glow spill over the page.

The no-WebGL fallback asked for `assets/dragon.png`, which was never shipped —
a 404 on every load and a broken fallback. The file is now rendered from the
engine's own dragon (`node scripts/../mkdragon.mjs` in the working copy), so
the fallback shows the same dragon the WebGL path does.

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

If a model carries animation clips the first one plays. Most carry none, and
the horse is one of those, so its legs are swung in the vertex shader instead.
A `gallop` block on the entry describes the animal in its own axes — the belly
line legs hang from, the fore and hind hip positions, and the gap between them.
Each vertex below the belly is weighted from zero at the hip to one at the
hoof, bent about the knee in the rest pose, then swung about the hip; the same
rotation is applied to the normal, and a matching depth material keeps the
shadow in step with the visible mesh.

Two details matter. The four legs are blended rather than branched between: a
hard left/right test tears every triangle crossing the midline, because the two
sides are half a stride apart, so the chest and rump are interpolated and the
weight fades out along the centre line. And the belly line sits below the
rider's stirrups — set it too high and the boots swing with the legs.

An entry can also carry a `banner`: a pole and a cloth pennant that waves,
placed in rig space, for imported riders that come holding nothing but a sword.

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
