/*
 * glTF rig for the hero avatar, for when a modelled avatar replaces the portrait. Set
 * data-model="models/<file>.glb" on #avatar3d and avatar3d.js loads THREE.GLTFLoader and this rig.
 *
 * The model is driven through named nodes; any that are missing are skipped:
 *   Head                     turns toward the pointer, idles, tilts
 *   Pupil_L/R, Iris_L/R      gaze
 *   EyeWhite_L/R             blinks and squints (with the iris and pupil)
 *   Brow_L/R                 lift
 * A smile or other face shapes are left as modelled.
 *
 * Registers window.SwabriAvatar.rigs.glb for avatar3d.js; see the rig contract there.
 */
(() => {
  "use strict";

  const TUNE = {
    gazeX: 0.055,     // pupil/iris travel sideways (model units, head space)
    gazeY: 0.036,     // pupil/iris travel up/down
    headYaw: 0.17,    // radians
    headPitch: 0.08,
    headRoll: 0.05,
    browLift: 0.03,   // model units
    blinkDepth: 0.91, // how far the eyes close (1 = fully)
    squint: 0.2,
    float: 0.03,      // model units
    hop: 0.12,        // jump height for a hop of 1, model units
    squash: 0.035,    // stretch/squash while hopping
    sway: 0.03,       // radians
    framePad: 0.06,   // empty space around the bust inside the canvas
  };
  const EYE_PARTS = ["Pupil_L", "Pupil_R", "Iris_L", "Iris_R", "EyeWhite_L", "EyeWhite_R", "Brow_L", "Brow_R"];

  function create(T, renderer, mount, options) {
    renderer.outputEncoding = T.sRGBEncoding;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(30, 1, 0.1, 100);

    // Small studio environment for soft reflections, baked once.
    const env = new T.Scene();
    env.add(new T.Mesh(new T.SphereGeometry(20, 24, 16), new T.MeshBasicMaterial({ color: 0x1a1428, side: T.BackSide })));
    for (const [w, h, hex, k, p] of [[10, 6, 0xffe9d6, 4, [-6, 7, 8]], [6, 10, 0x7a4bff, 3, [9, 1, -3]], [6, 10, 0xff8a4a, 3, [-9, 0, -3]]]) {
      const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: new T.Color(hex).multiplyScalar(k), side: T.DoubleSide }));
      m.position.set(p[0], p[1], p[2]); m.lookAt(0, 0, 0); env.add(m);
    }
    const pmrem = new T.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(env, 0.03).texture;
    pmrem.dispose();
    env.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });

    // Warm key, soft fill, and the page's purple/orange rim lights.
    scene.add(new T.HemisphereLight(0xfff1e6, 0x2a1740, 0.55));
    for (const [hex, k, p] of [[0xffe2c8, 2.0, [-3, 4, 6]], [0x9a86ff, 0.5, [4, 0.5, 5]], [0x7a4bff, 1.5, [5, 3, -4]], [0xff8a4a, 1.4, [-5, 2, -4]]]) {
      const l = new T.DirectionalLight(hex, k); l.position.set(p[0], p[1], p[2]); scene.add(l);
    }

    return new Promise((resolve, reject) => {
      new T.GLTFLoader().load(options.model, (gltf) => {
        const model = gltf.scene;
        const head = model.getObjectByName("Head");
        const parts = {}, base = {};
        for (const name of EYE_PARTS) {
          const o = model.getObjectByName(name);
          if (o) { parts[name] = o; base[name] = { pos: o.position.clone(), scale: o.scale.clone() }; }
        }
        if (!head || !parts.Pupil_L || !parts.Pupil_R) console.warn("avatar glb rig: control nodes missing", Object.keys(parts));
        model.traverse((o) => {
          if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.envMapIntensity = 0.35; });
        });
        scene.add(model);
        model.updateMatrixWorld(true);
        const box = new T.Box3().setFromObject(model);
        const headBase = head ? head.rotation.clone() : null;
        const rig = {
          scene,
          camera,
          faceAnchor: { x: 0.5, y: 0.35 },
          resize(w, h) {
            camera.aspect = w / h;
            const size = box.getSize(new T.Vector3()), center = box.getCenter(new T.Vector3());
            const tan = Math.tan(T.MathUtils.degToRad(camera.fov) / 2);
            const dist = Math.max(size.y * (1 + TUNE.framePad * 2) / (2 * tan), size.x * (1 + TUNE.framePad * 2) / (2 * tan * camera.aspect));
            camera.position.set(center.x, center.y, box.max.z + dist);
            camera.lookAt(center);
            camera.near = dist / 20; camera.far = dist * 4;
            camera.updateProjectionMatrix();
            if (head) {
              camera.updateMatrixWorld();
              const p = head.getWorldPosition(new T.Vector3()).project(camera);
              rig.faceAnchor = { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
            }
          },
          apply(pose) {
            model.position.y = pose.floatY * TUNE.float + pose.hop * TUNE.hop;
            model.scale.set(1 - pose.squash * TUNE.squash * 0.5, 1 + pose.squash * TUNE.squash, 1 - pose.squash * TUNE.squash * 0.5);
            model.rotation.y = pose.sway * TUNE.sway;
            if (head) {
              head.rotation.set(headBase.x - pose.headPitch * TUNE.headPitch, headBase.y + pose.headYaw * TUNE.headYaw, headBase.z - pose.headRoll * TUNE.headRoll);
            }
            for (const side of ["L", "R"]) {
              // The model's _L eye sits on the screen right (the character's left).
              const closed = side === "L" ? pose.blinkR : pose.blinkL;
              const open = 1 - Math.max(closed * TUNE.blinkDepth, pose.squint * TUNE.squint);
              const white = parts["EyeWhite_" + side];
              if (white) white.scale.y = base["EyeWhite_" + side].scale.y * open;
              const cy = white ? base["EyeWhite_" + side].pos.y : 0;
              for (const p of ["Iris_", "Pupil_"]) {
                const o = parts[p + side];
                if (!o) continue;
                const b = base[p + side];
                o.position.x = b.pos.x + pose.gazeX * TUNE.gazeX;
                o.position.y = cy + (b.pos.y + pose.gazeY * TUNE.gazeY - cy) * open; // flatten toward the eye line with the lid
                o.scale.y = b.scale.y * open;
              }
              const brow = parts["Brow_" + side];
              if (brow) brow.position.y = base["Brow_" + side].pos.y + (side === "L" ? pose.browL : pose.browR) * TUNE.browLift;
            }
          },
          dispose() {
            model.traverse((o) => {
              if (o.geometry) o.geometry.dispose();
              if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
                for (const k in m) if (m[k] && m[k].isTexture) m[k].dispose();
                m.dispose();
              });
            });
            scene.environment.dispose();
          },
        };
        resolve(rig);
      }, undefined, (err) => { scene.environment.dispose(); reject(err); });
    });
  }

  const ns = (window.SwabriAvatar = window.SwabriAvatar || { rigs: {} });
  ns.rigs.glb = { create };
})();
