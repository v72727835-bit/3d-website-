import * as THREE from './vendor/three/three.module.js';

// The detailed horse/knight asset is a single unrigged scan. These continuous
// deformation fields articulate its four legs, neck, tail and seated rider in
// its original (normalised) coordinates, retaining the original UV texture.
// Use the identical function for the colour and shadow passes.
const deformation = `
uniform float horseTime;
vec2 horseRotate(vec2 p, float a) {
  float s = sin(a), c = cos(a);
  return vec2(c*p.x-s*p.y, s*p.x+c*p.y);
}
vec3 horsePose(vec3 p) {
  vec3 q = p;
  // A diagonal-pair canter: fore and hind legs alternate while the near side
  // leads by a small amount.  This retains a readable footfall at phone size.
  float cycle = horseTime * 7.65;
  float fore = step(0.12, p.z);
  float side = step(0.0, p.x);
  float phase = cycle + mix(3.14159, 0.0, fore) + side * 0.46;
  float legs = (1.0-smoothstep(-0.64, -0.47, p.y));
  // Exclude the flowing tail from the hind-leg field.
  legs *= smoothstep(-0.57, -0.32, p.z);
  float stride = sin(phase);
  float airborne = max(0.0, stride);
  float landing = max(0.0, -stride);
  float thighAngle = stride * mix(0.50, 0.64, fore);
  float kneeAngle = -airborne * mix(0.88, 1.14, fore) + landing * 0.12;
  float shin = 1.0-smoothstep(-0.80, -0.69, p.y);
  vec2 knee = vec2(-0.75, mix(-0.24, 0.43, fore));
  vec2 hip = vec2(-0.46, mix(-0.10, 0.43, fore));
  vec2 bent = knee + horseRotate(p.yz-knee, kneeAngle*shin);
  bent = hip + horseRotate(bent-hip, thighAngle);
  q.yz = mix(p.yz, bent, legs);
  // Lift is concentrated at the hoof during the swing and fades at the hip,
  // making each planted hoof read as a separate, grounded step.
  float hoof = 1.0-smoothstep(-0.97, -0.76, p.y);
  q.y += airborne * hoof * mix(0.065, 0.12, fore) * legs;
  float head = smoothstep(0.43, 0.73, p.z) * smoothstep(-0.40, -0.16, p.y);
  q.yz = mix(q.yz, vec2(-0.22,0.46)+horseRotate(q.yz-vec2(-0.22,0.46),sin(cycle+0.5)*0.065),head);
  float tail = 1.0-smoothstep(-0.70,-0.30,p.z);
  q.y += tail*sin(cycle*0.8+p.z*5.0)*0.052;
  q.x += tail*sin(cycle*0.55+p.z*6.0)*0.067;
  float rider = smoothstep(-0.13,0.05,p.y);
  q.yz = mix(q.yz, vec2(-0.10,0.10)+horseRotate(q.yz-vec2(-0.10,0.10),sin(cycle+1.3)*0.023),rider);
  return q;
}
`;

export function articulateDetailedHorse(model) {
  const time = { value: 0 };
  let previousTime = 0;
  let strideTime = 0;
  model.traverse((part) => {
    if (!part.isMesh) return;
    part.frustumCulled = false; // The animated hooves extend past the rest bounds.
    const configure = (material, colour) => {
      material.onBeforeCompile = (shader) => {
        shader.uniforms.horseTime = time;
        shader.vertexShader = deformation + (colour ? 'varying vec3 horseRest;\n' : '') + shader.vertexShader;
        if (colour) {
          shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `
            #include <beginnormal_vertex>
            vec3 hn = normalize(objectNormal);
            vec3 ht = normalize(cross(hn, abs(hn.y) < 0.9 ? vec3(0,1,0) : vec3(1,0,0)));
            vec3 hb = cross(hn, ht);
            vec3 hp = horsePose(position);
            objectNormal = normalize(cross(horsePose(position+ht*0.001)-hp,horsePose(position+hb*0.001)-hp));
          `);
        }
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `${colour ? 'horseRest = position;' : ''}\nvec3 transformed = horsePose(position);`);
        if (colour) {
          shader.fragmentShader = 'varying vec3 horseRest;\n' + shader.fragmentShader;
          shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `
            #include <roughnessmap_fragment>
            float armour = smoothstep(-0.04, 0.10, horseRest.y);
            roughnessFactor = mix(0.51, 0.31, armour);
          `).replace('#include <metalnessmap_fragment>', `
            #include <metalnessmap_fragment>
            metalnessFactor = mix(0.025, 0.72, smoothstep(-0.04,0.10,horseRest.y));
          `);
        }
      };
      material.customProgramCacheKey = () => `horse-articulation-v2-${colour}`;
      material.needsUpdate = true;
      return material;
    };
    const mats = Array.isArray(part.material) ? part.material : [part.material];
    const enhanced = mats.map((original) => {
      const material = original.clone();
      material.envMapIntensity = 1.35;
      return configure(material, true);
    });
    part.material = Array.isArray(part.material) ? enhanced : enhanced[0];
    part.customDepthMaterial = configure(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), false);
    part.customDistanceMaterial = configure(new THREE.MeshDistanceMaterial(), false);
  });
  return {
    update(t, carrier, pace = 1) {
      // Keep a separate stride clock.  Playback may slow to an arrival hold;
      // scaling raw time would snap a hoof backward whenever that speed changes.
      if (t < previousTime) strideTime = 0;
      const dt = Math.min(Math.max(t - previousTime, 0), 0.08);
      previousTime = t;
      strideTime += dt * pace;
      time.value = strideTime;
      const beat = strideTime * 7.65;
      // A subtle two-beat rise keeps the body weight over the planted legs.
      carrier.position.y = 0.065 + (Math.sin(beat * 2 - 0.6) * 0.045 + Math.abs(Math.sin(beat)) * 0.035) * pace;
      carrier.rotation.z = Math.sin(beat + 0.5) * 0.032 * pace;
      carrier.rotation.x = Math.sin(beat * 0.5) * 0.018 * pace;
    }
  };
}

// A moving landscape generated entirely in the WebGL shader, not a video or
// screenshot. The soft edge keeps the surrounding voice-room UI readable.
export function createSunsetLandscape() {
  const uniforms = { time: { value: 0 }, visibility: { value: 0 } };
  const material = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, toneMapped: false,
    vertexShader: 'varying vec2 uvSky; void main(){uvSky=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `
      varying vec2 uvSky; uniform float time; uniform float visibility;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);}
      float noise(vec2 p){vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.0),f.x),f.y);}
      float cloud(vec2 p){float n=0.0,a=0.5;for(int i=0;i<5;i++){n+=noise(p)*a;p=p*2.03+7.13;a*=0.5;}return n;}
      void main(){
        vec2 uv=uvSky;
        vec3 sky=mix(vec3(1.0,0.39,0.065),vec3(0.08,0.075,0.21),smoothstep(0.35,0.98,uv.y));
        sky=mix(vec3(0.55,0.16,0.075),sky,smoothstep(0.15,0.44,uv.y));
        float sun=length((uv-vec2(0.26,0.41))*vec2(1.7,1.0));
        sky+=vec3(1.0,0.51,0.12)*exp(-sun*10.0)*0.65;
        sky=mix(sky,vec3(1.0,0.94,0.65),1.0-smoothstep(0.037,0.057,sun));
        float c=cloud(vec2(uv.x*5.5+time*0.012,uv.y*13.0));
        float cm=smoothstep(0.39,0.68,c)*smoothstep(0.42,0.68,uv.y);
        vec3 cloudColour=mix(vec3(0.21,0.105,0.15),vec3(1.0,0.50,0.18),smoothstep(0.5,0.8,c)*(1.0-uv.y)*2.0);
        sky=mix(sky,cloudColour,cm*0.9);
        sky+=vec3(0.5,0.17,0.04)*exp(-abs(c-0.43)*60.0)*smoothstep(0.45,0.58,uv.y)*(1.0-uv.y);
        for(int i=0;i<3;i++){
          float layer=float(i);
          float x=uv.x*4.0+layer*3.7+time*(0.010+layer*0.008);
          float ridge=0.24-layer*0.053+abs(noise(vec2(x,layer+8.0))*2.0-1.0)*0.19+noise(vec2(x*8.0,5.0))*0.022;
          vec3 mountain=mix(vec3(0.28,0.13,0.17),vec3(0.038,0.045,0.10),layer/2.0);
          mountain*=0.83+noise(vec2(uv.x*36.0+layer*11.0,uv.y*12.0))*0.24;
          sky=mix(sky,mountain,1.0-smoothstep(ridge-0.004,ridge+0.003,uv.y));
        }
        float edge=smoothstep(0.0,0.15,uv.y)*(1.0-smoothstep(0.86,1.0,uv.y));
        gl_FragColor=vec4(sky,edge*visibility*0.96);
      }
    `
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(15, 6.3), material);
  plane.position.set(0, 0.12, -4.5);
  plane.renderOrder = -10;
  plane.visible = false;
  return { plane, update(t, opacity) { uniforms.time.value=t; uniforms.visibility.value=opacity; plane.visible=opacity>0.001; } };
}

export function createArrivalMist() {
  const uniforms={time:{value:0},visibility:{value:0}};
  const material=new THREE.ShaderMaterial({uniforms,transparent:true,depthWrite:false,toneMapped:false,
    vertexShader:'varying vec2 fogUV;void main(){fogUV=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader:`
      varying vec2 fogUV;uniform float time;uniform float visibility;
      float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
      float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+1.0),f.x),f.y);}
      void main(){vec2 uv=fogUV;vec2 p=uv*vec2(7.0,3.0)-vec2(time*.48,time*.09);
        float f=n(p)*.55+n(p*2.1)*.28+n(p*4.2)*.14;
        float shape=pow(max(0.0,sin(uv.x*3.14159)),.6)*pow(max(0.0,sin(uv.y*3.14159)),1.8);
        float alpha=smoothstep(.20,.8,f)*shape*visibility*.56;
        gl_FragColor=vec4(mix(vec3(.58,.62,.88),vec3(1.0,.87,.59),uv.x),alpha);
      }`});
  const plane=new THREE.Mesh(new THREE.PlaneGeometry(7.5,1.5),material);
  plane.position.set(0,-1.1,1.25);plane.renderOrder=5;plane.visible=false;
  return {plane,update(t,opacity,x){uniforms.time.value=t;uniforms.visibility.value=opacity;plane.position.x=x;plane.visible=opacity>.001;}};
}
