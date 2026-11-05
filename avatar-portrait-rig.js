/*
 * Portrait rig for the hero avatar: brings the 2D avatar render (images/swabri-avatar.webp, a
 * cut-out of images/swabri-avatar-source.webp) to life in Three.js. It is not a rigged 3D model:
 *
 *   - Depth: the picture is a finely divided plane pushed into a relief (head ellipsoid, face,
 *     nose, neck, torso). Turning the head rotates the relief above the neck, so near parts
 *     (nose, glasses) shift more than far ones (ears, hair), with matching shading changes.
 *   - Eyes: inside each eye opening the shader paints its own sclera, iris, pupil and highlights,
 *     so the gaze can move. The upper lids slide down to blink (lash line kept sharp), the lower
 *     lids rise for a happy squint, and the brows lift by warping the picture locally.
 *
 * Every coordinate below is in source pixels (1312 x 1199, y down). If the render is replaced,
 * re-measure the eye outlines, iris centres, brows and the face/neck points to match.
 *
 * Registers window.SwabriAvatar.rigs.portrait for avatar3d.js; see the rig contract there.
 */
(() => {
  "use strict";

  const SRC = { w: 1312, h: 1199 };

  // Eye openings: upper lid edge (bottom of the lash line) and lower lid edge, left to right.
  // cx/cy/r: iris centre when looking straight at the viewer, and iris radius.
  const EYES = [
    {
      cx: 567, cy: 489, r: 38.5,
      up: [[502, 498], [508, 494], [520, 485], [536, 479], [548, 476], [570, 475], [588, 476], [600, 478], [612, 481], [622, 486], [632, 500]],
      lo: [[502, 500], [508, 512], [520, 519], [540, 520], [570, 520], [600, 519], [615, 517], [625, 512], [632, 502]],
    },
    {
      cx: 779, cy: 478, r: 36,
      up: [[717, 490], [722, 481], [730, 470], [740, 463], [750, 459], [770, 457], [790, 458], [800, 460], [810, 463], [820, 468], [830, 476], [838, 483], [842, 489]],
      lo: [[717, 494], [722, 502], [730, 508], [745, 509], [770, 508], [790, 506], [810, 503], [825, 500], [835, 495], [842, 490]],
    },
  ];
  const EYE_SPLIT_X = 675;        // columns left of this belong to the first eye
  const LOWER_OVERLAP = 1.8;      // px the painted eye extends below the measured lower lid

  // Brows: centre, half-width, and how far the lift reaches below / above the centre.
  const BROWS = [
    { x: 556, y: 390, rx: 100, below: 28, above: 46 },
    { x: 782, y: 384, rx: 100, below: 28, above: 46 },
  ];

  const HEAD = {
    pivot: [680, 800],            // neck: the head turns around this point
    turnTop: 730,                 // fully part of the head above this row …
    turnBottom: 835,              // … and fully part of the body below this one
  };

  // Movement range for a pose value of 1.
  const TUNE = {
    irisX: 24,        // px the irises travel sideways
    irisY: 7,         // px up/down
    converge: 3,      // px the eyes turn inward when the visitor is close
    headYaw: 0.17,    // radians
    headPitch: 0.1,
    headRoll: 0.05,
    bodyYaw: 0.035,   // shoulders follow the head a little, plus the idle sway
    bodyRoll: 0.012,
    float: 0.014,     // vertical float, as a fraction of the picture height
    hop: 0.06,        // jump height for a hop of 1, same unit
    squash: 0.035,    // stretch/squash while hopping
    browLift: 6,      // px
    squint: 0.3,      // fraction of the eye height the lower lid rises
    lookDownLid: 0.18,// upper lid follows the eyes when they look down
    depth: 1,         // relief strength
    shade: 0.55,      // lighting change as the head turns
    pad: 0.04,        // space around the picture inside the canvas (must match the CSS poster inset)
    bottomFade: 0.14, // bottom share of the picture that fades out
    segments: [120, 110],
  };

  // ---------- relief ----------
  const ellipsoid = (x, y, cx, cy, rx, ry, amp) => {
    const u = (x - cx) / rx, v = (y - cy) / ry, k = 1 - u * u - v * v;
    return k > 0 ? amp * Math.sqrt(k) : 0;
  };
  const smoothMax = (a, b, k) => {           // soft max, k in px
    const h = Math.max(k - Math.abs(a - b), 0) / k;
    return Math.max(a, b) + h * h * k * 0.25;
  };
  const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  function depthAt(x, y) {
    const head = ellipsoid(x, y, 672, 470, 365, 430, 230)
      + ellipsoid(x, y, 676, 600, 225, 235, 55)                                       // cheeks, mouth, chin
      + 48 * Math.exp(-((x - 680) ** 2 + (y - 556) ** 2) / (2 * 36 * 36))              // nose
      + 18 * Math.exp(-((x - 676) ** 2 + (y - 485) ** 2) / (2 * 150 * 40));            // glasses
    const neck = ellipsoid(x, 0, 682, 0, 165, 1, 125) * smoothstep(690, 760, y);
    const torso = ellipsoid(x, 0, 660, 0, 660, 1, 175) * smoothstep(820, 980, y)
      + ellipsoid(x, y, 660, 1150, 330, 330, 40);                                     // chest
    return smoothMax(smoothMax(head * (1 - smoothstep(780, 860, y)), neck, 40), torso, 60);
  }

  // ---------- eyelid table ----------
  // One texel per source column: upper and lower lid edge (px * 32, 16 bits each).
  function curveAt(points, x) {
    let i = 0;
    while (i < points.length - 2 && x > points[i + 1][0]) i++;
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
    const t = Math.min(1, Math.max(0, (x - p1[0]) / (p2[0] - p1[0])));
    const t2 = t * t, t3 = t2 * t;   // Catmull-Rom on the y values
    return 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
  }
  function lidTable(T) {
    const data = new Uint8Array(SRC.w * 4);
    for (const eye of EYES) {
      const x0 = Math.max(eye.up[0][0], eye.lo[0][0]), x1 = Math.min(eye.up[eye.up.length - 1][0], eye.lo[eye.lo.length - 1][0]);
      eye.mid = (x0 + x1) / 2; eye.half = (x1 - x0) / 2;
      for (let x = Math.ceil(x0); x <= Math.floor(x1); x++) {
        // The painted eye reaches slightly under the lower lash line, so no sliver of the
        // original eye white is left showing when the lids close.
        const up = Math.round(curveAt(eye.up, x + 0.5) * 32), lo = Math.round((curveAt(eye.lo, x + 0.5) + LOWER_OVERLAP) * 32);
        data.set([up >> 8, up & 255, lo >> 8, lo & 255], x * 4);
      }
    }
    const tex = new T.DataTexture(data, SRC.w, 1, T.RGBAFormat, T.UnsignedByteType);
    tex.magFilter = tex.minFilter = T.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  // ---------- shaders ----------
  const VERT = /* glsl */ `
    attribute float depth;
    attribute float headW;
    uniform mat3 headRot;
    uniform vec3 pivot;
    uniform vec3 lightDir;
    varying vec2 vUv;
    varying float vShade;
    void main() {
      vUv = uv;
      vec3 p = vec3(position.xy, depth);
      vec3 turned = headRot * (p - pivot) + pivot;
      vec3 n1 = normalize(mix(normal, headRot * normal, headW));
      vShade = dot(n1, lightDir) - dot(normal, lightDir);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(mix(p, turned, headW), 1.0);
    }`;

  const FRAG = /* glsl */ `
    uniform sampler2D map;
    uniform sampler2D lids;
    uniform vec2 size;
    uniform vec4 eyeA;      // iris centre x, y, radius, pupil radius (fraction of the iris)
    uniform vec4 eyeB;
    uniform vec4 spanA;     // eye mid x, half width, gaze x, gaze y (px)
    uniform vec4 spanB;
    uniform float splitX;
    uniform vec2 blink;     // per eye (first, second): 0 open .. 1 closed
    uniform float squint;   // lower lid rise, fraction of the eye height
    uniform vec2 browLift;  // px, left and right
    uniform vec4 browA;     // x, y, half width, reach below
    uniform vec4 browB;
    uniform vec2 browAbove;
    uniform float shade;
    uniform float bottomFade;  // row where the bottom fade-out starts
    varying vec2 vUv;
    varying float vShade;

    const float LID = 20.0;   // px of eyelid (lash line + skin) above the eye that slides down when blinking
    const float LASH = 11.0;  // thickness of the upper lash line, which moves without stretching
    const float LOW = 9.0;    // px of skin below the lower lid that rises in a squint
    const float LOWLASH = 3.0;

    vec4 pick(vec2 p) { return texture2D(map, vec2(p.x / size.x, 1.0 - p.y / size.y)); }

    float lidEdge(float hi, float lo) { return (hi * 255.0 * 256.0 + lo * 255.0) / 32.0; }

    float browWeight(vec2 p, vec4 b, float above) {
      float dy = p.y - b.y;
      vec2 q = vec2((p.x - b.x) / b.z, dy / (dy > 0.0 ? b.w : above));
      return 1.0 - smoothstep(0.45, 1.0, length(q));
    }

    vec3 eyeball(vec2 p, vec4 eye, vec4 span, float lidY, float h) {
      vec2 c = eye.xy + span.zw;
      float r = eye.z;
      vec2 d = (p - c) / r;
      float dist = length(d);
      float aa = 1.1 / r;
      // Sclera: shaded under the lid and toward the corners.
      float fromLid = clamp((p.y - lidY) / max(h, 1.0), 0.0, 1.0);
      vec3 sclera = mix(vec3(0.66, 0.53, 0.52), vec3(0.90, 0.81, 0.78), smoothstep(0.0, 0.55, fromLid));
      sclera *= 1.0 - 0.28 * smoothstep(0.5, 1.0, abs(p.x - span.x) / span.y);
      // Iris: dark brown, glowing warmer toward the bottom, fibres, darker rim.
      float glow = smoothstep(-0.25, 0.85, d.y) * smoothstep(eye.w, 0.9, dist);
      vec3 iris = mix(vec3(0.12, 0.05, 0.018), vec3(0.47, 0.21, 0.085), glow);
      iris *= 0.88 + 0.12 * sin(atan(d.y, d.x) * 27.0 + dist * 9.0);
      iris *= mix(1.0, 0.42, smoothstep(0.84, 1.0, dist));
      vec3 col = mix(iris, sclera, smoothstep(1.0 - aa, 1.0 + aa, dist));
      col = mix(vec3(0.022, 0.016, 0.016), col, smoothstep(eye.w - aa, eye.w + aa, dist));
      // Reflections stay almost still while the eye turns.
      vec2 hl = c - span.zw * 0.3;
      float spec = 1.0 - smoothstep(0.75, 1.0, length((p - hl - vec2(0.04, -0.33) * r) / (r * vec2(0.2, 0.12))));
      float spec2 = 1.0 - smoothstep(0.6, 1.0, length((p - hl - vec2(0.33, 0.22) * r) / (r * 0.065)));
      col = mix(col, vec3(0.94, 0.95, 1.0), spec * step(dist, 1.05));
      col = mix(col, vec3(0.85, 0.8, 0.85), spec2 * 0.7 * step(dist, 1.0));
      // Soft shadow from the upper lid over the whole eyeball.
      col *= mix(0.5, 1.0, smoothstep(0.0, 0.32, fromLid));
      return col;
    }

    // The portrait is sampled exactly once, outside any branch. Branches only work out WHERE to
    // sample (pure arithmetic). A mipmapped texture read inside a branch that covers part of the
    // screen gets broken derivatives along the branch edge, so the GPU picks the wrong mip level
    // in 2x2 pixel blocks there: that showed as dark dashed lines around the eye regions.
    void main() {
      vec2 p = vec2(vUv.x * size.x, (1.0 - vUv.y) * size.y);
      vec2 src = p;
      // Brows: pull the picture up locally.
      src.y += browLift.x * browWeight(p, browA, browAbove.x) + browLift.y * browWeight(p, browB, browAbove.y);

      // Eyelid table: nearest-filtered, no mipmaps, read for every fragment. The two nearest
      // columns are blended so the lid edges are smooth curves rather than 1 px steps; at the
      // eye corners (a neighbour outside the eye) the column counts as closed.
      float fx = p.x - 0.5, x0 = floor(fx), f = fx - x0;
      vec4 l0 = texture2D(lids, vec2((x0 + 0.5) / size.x, 0.5));
      vec4 l1 = texture2D(lids, vec2((x0 + 1.5) / size.x, 0.5));
      float up0 = lidEdge(l0.r, l0.g), lo0 = lidEdge(l0.b, l0.a);
      float up1 = lidEdge(l1.r, l1.g), lo1 = lidEdge(l1.b, l1.a);
      float inside = step(up0 + 0.5, lo0) * step(up1 + 0.5, lo1);
      float up = mix(up0, up1, f), lo = mix(up, mix(lo0, lo1, f), inside);

      float open = 0.0;        // how much of the painted eyeball shows here
      float lidShade = 1.0;    // darkening of a closing lid
      vec3 ball = vec3(0.0);
      if (lo > up + 0.5 && p.y > up - LID && p.y < lo + LOW) {
        bool first = p.x < splitX;
        float h = lo - up;
        float closed = first ? blink.x : blink.y;
        float lidY = up + h * closed * 1.04;
        float lowY = max(lo - h * squint, lidY);
        if (p.y < lidY) {
          // Upper lid, slid down: the lash line moves rigidly, the skin above it stretches.
          float top = up - LID;
          src.y = p.y > lidY - LASH ? up - (lidY - p.y) : top + (p.y - top) * (LID - LASH) / max(lidY - LASH - top, 0.001);
          // A closing lid is a rounded surface: a touch darker toward its lash line.
          if (p.y > up - 0.5) lidShade = 1.0 - 0.12 * smoothstep(up - LID, lidY, p.y) * closed;
        } else if (p.y > lowY) {
          // Lower lid, risen: same idea with a thinner lash line.
          float bottom = lo + LOW;
          src.y = p.y < lowY + LOWLASH ? lo + (p.y - lowY) : lo + LOWLASH + (p.y - lowY - LOWLASH) * (LOW - LOWLASH) / max(bottom - lowY - LOWLASH, 0.001);
        }
        open = smoothstep(lidY - 0.7, lidY + 0.7, p.y) * (1.0 - smoothstep(lowY - 0.7, lowY + 0.7, p.y));
        if (open > 0.0) ball = eyeball(p, first ? eyeA : eyeB, first ? spanA : spanB, lidY, h);
      }

      vec4 col = pick(src);
      col.rgb = mix(col.rgb * lidShade, ball, open);
      col.a = max(col.a, open);
      col.rgb *= 1.0 + vShade * shade;
      // The bust is cut off at the bottom of the picture. Fade it out before that edge, so the
      // cut never shows when the character floats or hops up (premultiplied: scale everything).
      col *= 1.0 - smoothstep(bottomFade, size.y, p.y);
      gl_FragColor = col;
    }`;

  // ---------- rig ----------
  function create(T, renderer, mount, options) {
    return new Promise((resolve, reject) => {
      new T.TextureLoader().load(options.src, (map) => {
        map.minFilter = T.LinearMipmapLinearFilter;
        // Premultiplied on upload: mipmaps and filtering then average colour weighted by alpha,
        // so the soft edges of the cut-out never pick up colour from transparent pixels.
        map.premultiplyAlpha = true;
        map.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
        resolve(build(T, map));
      }, undefined, () => reject(new Error("portrait failed to load: " + options.src)));
    });
  }

  function build(T, map) {
    const H = SRC.h, W = SRC.w;
    const toX = (x) => (x - W / 2) / H, toY = (y) => (H / 2 - y) / H;

    // Relief mesh, in units of the picture height.
    const geo = new T.PlaneGeometry(W / H, 1, TUNE.segments[0], TUNE.segments[1]);
    const pos = geo.attributes.position, nrm = geo.attributes.normal, n = pos.count;
    const depth = new Float32Array(n), headW = new Float32Array(n);
    const e = 4; // px step for the slope
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i) * H + W / 2, y = H / 2 - pos.getY(i) * H;
      depth[i] = (depthAt(x, y) / H) * TUNE.depth;
      headW[i] = 1 - smoothstep(HEAD.turnTop, HEAD.turnBottom, y);
      const dzdx = (depthAt(x + e, y) - depthAt(x - e, y)) / (2 * e) * TUNE.depth;
      const dzdy = -(depthAt(x, y + e) - depthAt(x, y - e)) / (2 * e) * TUNE.depth; // picture y is down
      const len = Math.hypot(dzdx, dzdy, 1);
      nrm.setXYZ(i, -dzdx / len, -dzdy / len, 1 / len);
    }
    geo.setAttribute("depth", new T.BufferAttribute(depth, 1));
    geo.setAttribute("headW", new T.BufferAttribute(headW, 1));

    const lids = lidTable(T);
    const [a, b] = EYES;
    const u = {
      map: { value: map },
      lids: { value: lids },
      size: { value: new T.Vector2(W, H) },
      eyeA: { value: new T.Vector4(a.cx, a.cy, a.r, 0.56) },
      eyeB: { value: new T.Vector4(b.cx, b.cy, b.r, 0.56) },
      spanA: { value: new T.Vector4(a.mid, a.half, 0, 0) },
      spanB: { value: new T.Vector4(b.mid, b.half, 0, 0) },
      splitX: { value: EYE_SPLIT_X },
      blink: { value: new T.Vector2() },
      squint: { value: 0 },
      browLift: { value: new T.Vector2() },
      browA: { value: new T.Vector4(BROWS[0].x, BROWS[0].y, BROWS[0].rx, BROWS[0].below) },
      browB: { value: new T.Vector4(BROWS[1].x, BROWS[1].y, BROWS[1].rx, BROWS[1].below) },
      browAbove: { value: new T.Vector2(BROWS[0].above, BROWS[1].above) },
      shade: { value: TUNE.shade },
      bottomFade: { value: SRC.h * (1 - TUNE.bottomFade) },
      headRot: { value: new T.Matrix3() },
      pivot: { value: new T.Vector3(toX(HEAD.pivot[0]), toY(HEAD.pivot[1]), (depthAt(HEAD.pivot[0], HEAD.pivot[1]) / H) * 0.5) },
      lightDir: { value: new T.Vector3(-0.35, 0.45, 0.82).normalize() },
    };
    // Depth-tested, so the nose and glasses stay in front of the cheeks while the head turns.
    // The shader outputs premultiplied colour (the texture is premultiplied; the painted eyes are
    // opaque), blended with ONE, ONE_MINUS_SRC_ALPHA.
    const mat = new T.ShaderMaterial({ uniforms: u, vertexShader: VERT, fragmentShader: FRAG, transparent: true, premultipliedAlpha: true });
    const mesh = new T.Mesh(geo, mat);

    const scene = new T.Scene();
    scene.add(mesh);
    // Orthographic, so the picture at rest lines up exactly with the poster image behind it.
    const camera = new T.OrthographicCamera(-1, 1, 1, -1, -10, 10);
    camera.position.z = 5;

    const m4 = new T.Matrix4(), euler = new T.Euler(0, 0, 0, "YXZ");

    return {
      scene,
      camera,
      // Face centre as a fraction of the canvas (0..1, y down), for measuring the pointer.
      faceAnchor: { x: (676 / W + TUNE.pad) / (1 + 2 * TUNE.pad), y: (485 / H + TUNE.pad) / (1 + 2 * TUNE.pad) },
      resize(w, h) {
        const halfH = (1 + 2 * TUNE.pad) / 2, halfW = halfH * (w / h);
        Object.assign(camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
        camera.updateProjectionMatrix();
      },
      apply(pose) {
        euler.set(-pose.headPitch * TUNE.headPitch, pose.headYaw * TUNE.headYaw, -pose.headRoll * TUNE.headRoll);
        u.headRot.value.setFromMatrix4(m4.makeRotationFromEuler(euler));
        mesh.position.y = pose.floatY * TUNE.float + pose.hop * TUNE.hop;
        mesh.scale.set(1 - pose.squash * TUNE.squash * 0.5, 1 + pose.squash * TUNE.squash, 1);
        mesh.rotation.y = pose.headYaw * TUNE.bodyYaw * 0.4 + pose.sway * TUNE.bodyYaw;
        mesh.rotation.z = pose.sway * TUNE.bodyRoll;
        const gx = pose.gazeX * TUNE.irisX, gy = -pose.gazeY * TUNE.irisY, cv = pose.converge * TUNE.converge;
        u.spanA.value.z = gx + cv; u.spanA.value.w = gy;
        u.spanB.value.z = gx - cv; u.spanB.value.w = gy;
        u.eyeA.value.w = u.eyeB.value.w = 0.5 + pose.pupil * 0.12;
        const lookDown = Math.max(0, -pose.gazeY) * TUNE.lookDownLid;
        u.blink.value.set(Math.max(pose.blinkL, lookDown), Math.max(pose.blinkR, lookDown));
        u.squint.value = pose.squint * TUNE.squint;
        u.browLift.value.set(pose.browL * TUNE.browLift, pose.browR * TUNE.browLift);
      },
      dispose() {
        geo.dispose(); mat.dispose(); map.dispose(); lids.dispose();
      },
    };
  }

  const ns = (window.SwabriAvatar = window.SwabriAvatar || { rigs: {} });
  ns.rigs.portrait = { create, pad: TUNE.pad };
})();
