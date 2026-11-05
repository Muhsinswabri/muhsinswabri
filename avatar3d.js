/*
 * Hero avatar controller. The page first shows the poster image (images/swabri-avatar.webp) inside
 * #avatar3d. Once the page has loaded and the hero is on screen, this script lazy-loads Three.js,
 * builds a rig and fades the live character in over the poster.
 *
 * Rigs (window.SwabriAvatar.rigs):
 *   portrait  avatar-portrait-rig.js: the avatar render with a depth relief and shader-driven eyes,
 *             lids and brows. Used by default.
 *   glb       avatar-glb-rig.js: a modelled avatar with named nodes. Used when the mount has
 *             data-model="models/<file>.glb" (the rig script and GLTFLoader load on demand).
 *
 * Rig contract: create(THREE, renderer, mount, options) resolves to
 *   { scene, camera, faceAnchor: {x, y} (fractions of the canvas, y down),
 *     resize(width, height), apply(pose), dispose() }
 * where pose holds values from about -1 to 1 (0 to 1 for blinks, squint, pupil, converge):
 *   gazeX, gazeY (up +), headYaw (right +), headPitch (up +), headRoll, browL, browR,
 *   blinkL, blinkR (per eye, screen left/right), squint, pupil, converge, floatY, sway,
 *   hop (jump height), squash (stretch while rising +, squash while landing -).
 *
 * Behaviour (all blended, never switched abruptly):
 *   idle        smiling, floating, slow glances, eye contact most of the time
 *   tracking    eyes, then head, follow the cursor anywhere on the page
 *   curious     fast cursor movement, or the cursor leaving the window: quick searching glances,
 *               raised brows, head tilt
 *   hover       cursor near the character: eye contact, happy squint, warmer brows
 *   returning   a few seconds without input eases everything back to idle
 * Interactive reactions:
 *   click/tap   a happy hop with a wink and a big smile; three quick clicks make it giggle
 *   excited     hovering or focusing an element with data-avatar-react="excited": a nod and a
 *               delighted look (used on the Contact button)
 *   interest    data-avatar-react="interest": raised brows, wide pupils, head tilt (nav links)
 *   scroll      a glance in the direction the page is scrolling
 *   drowsy      no input for a while: heavy lids, drooping head, slow breathing; any input wakes
 *               it with a start (raised brows, small pupils, a jolt and a double blink)
 * Touch devices: the eyes and head follow the finger while it touches the page (and for a moment
 * after), plus the idle behaviour, occasional curious look-arounds, and the tap reaction.
 * Opened straight from disk (file://), the picture comes from images/swabri-avatar.data.js.
 * With prefers-reduced-motion the poster stays and nothing loads.
 *
 * Mount states (data-state): static (poster only) → loading → ready, or error (poster stays).
 */
(() => {
  "use strict";

  const mount = document.getElementById("avatar3d");
  if (!mount) return;
  const stage = mount.closest(".avatar-stage");
  const THREE_URL = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
  const GLTF_LOADER_URL = "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js";

  // ---------- behaviour tuning ----------
  const BEHAVIOUR = {
    reachX: 0.4,          // cursor this far from the face (fraction of the window width) gives full gaze
    reachY: 0.45,         // … and of the window height, vertically
    eyeEase: 16,          // how quickly the eyes catch up (higher = snappier)
    headEase: 3.2,        // how quickly the head follows
    headFollow: 0.85,     // head turn as a share of the gaze
    idleAfter: 3,         // seconds without cursor movement before returning to idle
    hoverNear: 0.28,      // cursor within this distance of the face (fraction of the avatar width) = full hover
    hoverFar: 0.75,       // … fading out by this distance
    curiousSpeed: 1.6,    // cursor speed (window diagonals per second) that makes the character curious
    curiousHold: 1.1,     // seconds curiosity lasts after fast movement
    searchAfterLeave: 2.6,// seconds of searching after the cursor leaves the window
    blinkMin: 2.4,        // seconds between blinks: min + random * range
    blinkRange: 3.4,
    doubleBlink: 0.18,    // chance of a double blink
    floatPeriod: 4.6,     // seconds per float cycle
    swayPeriod: 7.3,
    hopKick: 6,           // strength of the hop when the character is clicked or tapped
    nodKick: 7,           // strength of the excited nod (hovering an element marked "excited")
    wobbleKick: 12,       // strength of the giggle wobble on quick repeat clicks
    comboWindow: 0.9,     // seconds between clicks that still count as a repeat
    sleepAfter: 14,       // seconds without any input before the character gets drowsy
    touchHold: 1.5,       // seconds the eyes keep following a finger after it lifts
  };

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const setState = (s) => { mount.dataset.state = s; };
  if (reduceMotion) { setState("static"); return; }

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const damp = (cur, tgt, lambda, dt) => cur + (tgt - cur) * (1 - Math.exp(-lambda * dt));
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const rand = (a, b) => a + Math.random() * (b - a);
  const soft = (v) => clamp(v / Math.sqrt(1 + v * v) * 1.25, -1, 1); // eases off toward the edges

  // ---------- input ----------
  const pointer = { x: 0, y: 0, present: false, justLeft: false, lastMove: -1e9, speed: 0, lastT: 0, tapUntil: 0 };
  const scroll = { y: window.scrollY, t: performance.now(), speed: 0 };
  let lastInput = performance.now();
  let rect = mount.getBoundingClientRect();
  const measure = () => { rect = mount.getBoundingClientRect(); };

  function onPointerMove(ev) {
    if (ev.pointerType === "touch") return;
    const now = performance.now();
    const dtMove = Math.max(8, now - pointer.lastT);
    const dist = Math.hypot(ev.clientX - pointer.x, ev.clientY - pointer.y) / Math.hypot(window.innerWidth, window.innerHeight);
    if (pointer.present) pointer.speed = Math.max(pointer.speed, (dist / dtMove) * 1000);
    pointer.x = ev.clientX; pointer.y = ev.clientY;
    pointer.present = true; pointer.touch = false; pointer.lastMove = now; pointer.lastT = now;
    measure();
    wake();
  }
  // Touch screens: the eyes follow the finger while it is down, and for a moment after.
  function onTouch(ev) {
    const t = ev.touches[0];
    if (!t) return;
    pointer.x = t.clientX; pointer.y = t.clientY;
    pointer.present = true; pointer.touch = true; pointer.lastMove = performance.now();
    measure();
    wake();
  }
  function onPointerOut(ev) { if (!ev.relatedTarget && pointer.present) { pointer.present = false; pointer.justLeft = true; } }
  function onTap(ev) {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    if (ev.pointerType !== "mouse") pointer.tapUntil = performance.now() + 2200;
    wake();
    react();
  }
  function onScroll() {
    const now = performance.now();
    const v = ((window.scrollY - scroll.y) / Math.max(8, now - scroll.t)) * 1000; // px per second
    scroll.y = window.scrollY; scroll.t = now;
    if (Math.abs(v) > Math.abs(scroll.speed)) scroll.speed = v;
    measure();
    wake();
  }
  function onAnyInput() { wake(); }
  // Elements marked data-avatar-react="excited|interest" get a reaction on hover and focus.
  function onReactEnter(ev) {
    b.mood = ev.currentTarget.dataset.avatarReact;
    if (b.mood === "excited") { b.nod.v -= BEHAVIOUR.nodKick; b.hop.v += BEHAVIOUR.hopKick * 0.4; }
    wake();
  }
  function onReactLeave() { b.mood = null; }

  // ---------- behaviour ----------
  const b = {
    t: 0, gx: 0, gy: 0, hx: 0, hy: 0, roll: 0, engaged: 0, hover: 0, curious: 0, curiousUntil: 0,
    sacX: 0, sacY: 0, sacTX: 0, sacTY: 0, nextSac: 1.2, browL: 0, browR: 0, squint: 0.06, pupil: 0.35,
    blinkT: -1, blinkPause: 0, nextBlink: 1.6, blinkAgain: false, nextLook: rand(6, 10),
    // Reactions: springs for the hop, nod and head wobble, a timed wink, and moods.
    hop: { x: 0, v: 0 }, nod: { x: 0, v: 0 }, wobble: { x: 0, v: 0 },
    winkT: -1, winkSide: 0, joy: 0, joyUntil: 0, combo: 0, lastClick: -9,
    mood: null, moodW: 0, scrollLook: 0, drowsy: 0, surprise: 0, surpriseUntil: 0, floatPhase: 0,
  };
  const pose = {
    gazeX: 0, gazeY: 0, headYaw: 0, headPitch: 0, headRoll: 0, browL: 0, browR: 0, blinkL: 0, blinkR: 0,
    squint: 0, pupil: 0, converge: 0, floatY: 0, sway: 0, hop: 0, squash: 0,
  };

  function startBlink() { if (b.blinkT < 0 && b.blinkPause <= 0) b.blinkT = 0; }

  // Damped spring, stepped finely so it stays stable at low frame rates.
  function spring(s, k, c, dt) {
    const n = Math.ceil(dt / 0.008), h = dt / n;
    for (let i = 0; i < n; i++) { s.v += (-k * s.x - c * s.v) * h; s.x += s.v * h; }
  }

  // Click or tap on the character: a happy hop and a wink; quick repeat clicks make it giggle.
  function react() {
    b.combo = b.t - b.lastClick < BEHAVIOUR.comboWindow ? b.combo + 1 : 1;
    b.lastClick = b.t;
    if (b.combo >= 3) {
      b.hop.v += BEHAVIOUR.hopKick * 0.6;
      b.wobble.v += (b.combo % 2 ? 1 : -1) * BEHAVIOUR.wobbleKick;
      b.joyUntil = b.t + 2;
    } else {
      b.hop.v += BEHAVIOUR.hopKick;
      b.winkSide = Math.random() < 0.5 ? 0 : 1;
      b.winkT = 0;
      b.joyUntil = b.t + 1.4;
    }
  }

  // Any input after a while of nothing: wake up with a start.
  function wake() {
    lastInput = performance.now();
    if (b.drowsy > 0.35 && b.t > b.surpriseUntil) {
      b.surpriseUntil = b.t + 0.9;
      b.hop.v += BEHAVIOUR.hopKick * 0.5;
      startBlink();
      b.blinkAgain = true;
    }
  }

  function think(dt, rig) {
    const now = performance.now();
    b.t += dt;
    const t = b.t;

    // A finger that has lifted stops being followed after a moment.
    if (pointer.touch && now - pointer.lastMove > BEHAVIOUR.touchHold * 1000) { pointer.present = false; pointer.touch = false; }

    // Where the cursor is relative to the face.
    let nx = 0, ny = 0, near = 0;
    if (pointer.present) {
      const fx = rect.left + rig.faceAnchor.x * rect.width, fy = rect.top + rig.faceAnchor.y * rect.height;
      nx = soft((pointer.x - fx) / (window.innerWidth * BEHAVIOUR.reachX));
      ny = soft(-(pointer.y - fy) / (window.innerHeight * BEHAVIOUR.reachY));
      near = 1 - smoothstep(BEHAVIOUR.hoverNear, BEHAVIOUR.hoverFar, Math.hypot(pointer.x - fx, pointer.y - fy) / Math.max(rect.width, 1));
    }
    const active = pointer.present && now - pointer.lastMove < BEHAVIOUR.idleAfter * 1000;
    const tapped = now < pointer.tapUntil;

    // Curious after fast movement or when the cursor has just left; on touch, now and then.
    if (pointer.speed > BEHAVIOUR.curiousSpeed) b.curiousUntil = Math.max(b.curiousUntil, t + BEHAVIOUR.curiousHold);
    if (pointer.justLeft) { pointer.justLeft = false; b.curiousUntil = t + BEHAVIOUR.searchAfterLeave; }
    if (!finePointer && (b.nextLook -= dt) <= 0) { b.curiousUntil = t + rand(1.2, 2); b.nextLook = rand(8, 14); }
    pointer.speed = damp(pointer.speed, 0, 6, dt);

    b.engaged = damp(b.engaged, active ? 1 : 0, active ? 4 : 1.6, dt);
    b.hover = damp(b.hover, Math.max(tapped ? 1 : 0, pointer.present ? near : 0), 4, dt);
    b.curious = damp(b.curious, (t < b.curiousUntil ? 1 : 0) * (1 - b.hover), 3, dt);

    // Reactions and moods.
    const sleepy = (now - lastInput) / 1000 > BEHAVIOUR.sleepAfter;
    b.drowsy = damp(b.drowsy, sleepy ? 1 : 0, sleepy ? 0.6 : 6, dt);
    b.surprise = damp(b.surprise, t < b.surpriseUntil ? 1 : 0, t < b.surpriseUntil ? 14 : 3, dt);
    b.joy = damp(b.joy, t < b.joyUntil || b.mood === "excited" ? 1 : 0, 6, dt);
    b.moodW = damp(b.moodW, b.mood === "interest" ? 1 : 0, 5, dt);
    b.scrollLook = damp(b.scrollLook, clamp(-scroll.speed / 2500, -1, 1), 5, dt);
    scroll.speed = damp(scroll.speed, 0, 5, dt);
    spring(b.hop, 70, 6, dt);
    spring(b.nod, 90, 9, dt);
    spring(b.wobble, 120, 5, dt);
    let wink = 0;
    if (b.winkT >= 0) {
      b.winkT += dt;
      const k = b.winkT;
      wink = k < 0.07 ? smoothstep(0, 0.07, k) : k < 0.3 ? 1 : 1 - smoothstep(0.3, 0.45, k);
      if (k >= 0.45) b.winkT = -1;
    }
    const awake = 1 - b.drowsy;

    // Saccades: quick glances, frequent while curious, rare and small while idle.
    if ((b.nextSac -= dt) <= 0) {
      const ox = b.sacTX, oy = b.sacTY;
      if (b.curious > 0.4) {
        b.sacTX = rand(-0.8, 0.8); b.sacTY = rand(-0.4, 0.5); b.nextSac = rand(0.3, 0.75);
      } else if (b.engaged > 0.6) {
        b.sacTX = rand(-0.05, 0.05); b.sacTY = rand(-0.04, 0.04); b.nextSac = rand(0.6, 1.4);
      } else if (Math.random() < 0.55) {
        b.sacTX = 0; b.sacTY = 0; b.nextSac = rand(2, 4);            // back to eye contact
      } else {
        b.sacTX = rand(-0.45, 0.45); b.sacTY = rand(-0.2, 0.25); b.nextSac = rand(1.4, 3);
      }
      if (Math.hypot(b.sacTX - ox, b.sacTY - oy) > 0.5 && Math.random() < 0.25) startBlink();
    }
    b.sacX = damp(b.sacX, b.sacTX * awake, 22, dt);
    b.sacY = damp(b.sacY, b.sacTY * awake, 22, dt);

    // Gaze: follow the cursor, settle into eye contact when it is close or the character is
    // delighted, search when curious, glance along a scroll, look down when drowsy.
    const track = b.engaged * (1 - 0.8 * b.hover) * (1 - 0.6 * b.curious) * (1 - 0.6 * b.joy * (b.mood ? 0 : 1));
    const lookY = b.scrollLook * 0.6 - b.drowsy * 0.35;
    b.gx = damp(b.gx, clamp(nx * track + b.sacX, -1, 1), BEHAVIOUR.eyeEase, dt);
    b.gy = damp(b.gy, clamp(ny * track + b.sacY + lookY, -1, 1), BEHAVIOUR.eyeEase, dt);

    // Head: follows the gaze more slowly, with a gentle idle drift; droops when drowsy.
    const driftX = 0.12 * Math.sin(t * 0.37) + 0.05 * Math.sin(t * 0.83 + 1);
    const driftY = 0.1 * Math.sin(t * 0.29 + 2) + 0.04 * Math.sin(t * 0.71);
    const idle = (1 - b.engaged) * awake;
    b.hx = damp(b.hx, (nx * track + b.sacX * 0.4) * BEHAVIOUR.headFollow + driftX * idle, BEHAVIOUR.headEase, dt);
    b.hy = damp(b.hy, (ny * track + b.sacY * 0.4 + lookY * 0.5) * BEHAVIOUR.headFollow + driftY * idle - b.drowsy * 0.45, BEHAVIOUR.headEase, dt);
    const tilt = b.curious * 0.7 * (b.sacTX >= 0 ? 1 : -1) + b.hover * 0.3 + b.moodW * 0.35 + b.drowsy * 0.6
      + 0.18 * Math.sin(t * 0.23);
    b.roll = damp(b.roll, tilt, 2.4, dt);

    // Expression: brows up when curious (one more than the other), warm and soft on hover,
    // raised and bright-eyed when delighted or interested, high and small-pupilled when startled.
    const lift = b.hover * 0.35 + b.joy * 0.4 + b.moodW * 0.5 + b.gy * 0.25 - b.drowsy * 0.25;
    b.browL = damp(b.browL, clamp(b.curious * 0.95 + lift, -0.3, 1), 6, dt);
    b.browR = damp(b.browR, clamp(b.curious * 0.5 + lift, -0.3, 1), 6, dt);
    b.squint = damp(b.squint, 0.06 + b.hover * 0.6 + b.joy * 0.55 - b.curious * 0.05, 5, dt);
    b.pupil = damp(b.pupil, 0.35 + b.hover * 0.5 + b.joy * 0.3 + b.moodW * 0.3 - b.curious * 0.1, 2, dt);
    const startle = b.surprise;

    // Blink: close fast, hold a moment, open a little slower.
    if ((b.nextBlink -= dt) <= 0) {
      startBlink();
      b.blinkAgain = Math.random() < BEHAVIOUR.doubleBlink;
      b.nextBlink = BEHAVIOUR.blinkMin + Math.random() * BEHAVIOUR.blinkRange;
    }
    let blink = 0;
    if (b.blinkPause > 0 && (b.blinkPause -= dt) <= 0) b.blinkT = 0; // second close of a double blink
    if (b.blinkT >= 0) {
      b.blinkT += dt;
      const k = b.blinkT;
      blink = k < 0.075 ? smoothstep(0, 0.075, k) : k < 0.11 ? 1 : 1 - smoothstep(0.11, 0.25, k);
      if (k >= 0.25) {
        b.blinkT = -1;
        if (b.blinkAgain) { b.blinkAgain = false; b.blinkPause = 0.12; }
      }
    }

    // Drowsy: heavy lids that droop and lift as it nods off; the float slows to a sleepy breath.
    const droop = b.drowsy * (0.5 + 0.12 * Math.sin(t * 0.9));
    b.floatPhase += (dt / BEHAVIOUR.floatPeriod) * Math.PI * 2 * (1 - 0.5 * b.drowsy);

    Object.assign(pose, {
      gazeX: b.gx, gazeY: b.gy,
      headYaw: b.hx,
      headPitch: b.hy + b.nod.x * 1.6 + startle * 0.25,
      headRoll: b.roll + b.wobble.x,
      browL: clamp(b.browL + startle, -0.3, 1.2), browR: clamp(b.browR + startle, -0.3, 1.2),
      blinkL: Math.max(blink, droop, b.winkSide === 0 ? wink : 0),
      blinkR: Math.max(blink, droop, b.winkSide === 1 ? wink : 0),
      squint: clamp(b.squint * (1 - startle) + wink * 0.3, 0, 1),
      pupil: clamp(b.pupil - startle * 0.4, 0, 1),
      converge: Math.max(b.hover, b.joy * 0.6),
      floatY: Math.sin(b.floatPhase), sway: Math.sin((t / BEHAVIOUR.swayPeriod) * Math.PI * 2 + 0.7),
      hop: b.hop.x, squash: clamp(b.hop.v * 0.12, -1, 1),
    });
    return pose;
  }

  // ---------- loading ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error("failed to load " + src));
      document.head.appendChild(s);
    });
  }

  let renderer = null, rig = null, running = false, raf = 0, last = 0, visible = true, disposed = false, started = false;

  async function boot() {
    if (started || disposed) return;
    started = true;
    setState("loading");
    try {
      if (!window.THREE) await loadScript(THREE_URL);
      const T = window.THREE;
      const model = mount.dataset.model;
      if (model) {
        if (!T.GLTFLoader) await loadScript(GLTF_LOADER_URL);
        if (!window.SwabriAvatar || !window.SwabriAvatar.rigs.glb) await loadScript("avatar-glb-rig.js");
      }
      const factory = window.SwabriAvatar && window.SwabriAvatar.rigs[model ? "glb" : "portrait"];
      if (!factory) throw new Error("avatar rig script missing");

      renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
      if (!renderer.getContext()) throw new Error("WebGL unavailable");
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.setAttribute("aria-hidden", "true");

      const poster = mount.querySelector(".avatar-poster");
      let src = mount.dataset.portrait || (poster && (poster.currentSrc || poster.src));
      if (!model && location.protocol === "file:" && src && !src.startsWith("data:")) {
        // Opened straight from disk: browsers will not hand a file:// image to WebGL, so use
        // the data: URL copy generated next to it (tools/prepare_avatar.py).
        if (!window.SwabriAvatarPortrait) await loadScript(src.replace(/\.[a-z0-9]+$/i, ".data.js"));
        src = window.SwabriAvatarPortrait;
      }
      const built = await factory.create(T, renderer, mount, { src, model });
      if (disposed) { built.dispose(); return; }
      rig = built;
      mount.appendChild(renderer.domElement);
      resize(true);
      rig.apply(think(0, rig));
      render();
      setState("ready");
      sync();
    } catch (err) {
      console.error("avatar3d:", err);
      setState("error");
      teardown();
    }
  }

  // ---------- rendering ----------
  let width = 0, height = 0;
  function resize(force) {
    measure();
    if (!renderer || !rig) return;
    const w = mount.clientWidth, h = mount.clientHeight;
    if (!w || !h || (!force && w === width && h === height)) return;
    width = w; height = h;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, finePointer ? 2 : 1.5));
    renderer.setSize(w, h, false);
    rig.resize(w, h);
    if (!running) render();
  }
  function render() { renderer.render(rig.scene, rig.camera); }
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    rig.apply(think(dt, rig));
    if (stage) stage.style.setProperty("--lift", pose.floatY.toFixed(3));
    render();
  }
  function start() {
    if (running || !rig || disposed) return;
    running = true; last = performance.now(); raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }
  function sync() { if (visible && !document.hidden) start(); else stop(); }

  // ---------- wiring ----------
  const io = new IntersectionObserver((es) => {
    visible = es[es.length - 1].isIntersecting;
    if (visible && document.readyState === "complete") boot();
    sync();
  }, { rootMargin: "200px" });
  io.observe(mount);
  const ro = new ResizeObserver(() => resize(false));
  ro.observe(mount);
  // Wait for the page itself (fonts, images) before fetching Three.js.
  const whenIdle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  const onLoad = () => whenIdle(() => { if (visible) boot(); }, { timeout: 1500 });
  if (document.readyState === "complete") onLoad(); else window.addEventListener("load", onLoad, { once: true });

  document.addEventListener("visibilitychange", sync);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", measure);
  window.addEventListener("keydown", onAnyInput);
  window.addEventListener("touchstart", onTouch, { passive: true });
  window.addEventListener("touchmove", onTouch, { passive: true });
  const reactors = [...document.querySelectorAll("[data-avatar-react]")];
  for (const el of reactors) {
    el.addEventListener("pointerenter", onReactEnter);
    el.addEventListener("pointerleave", onReactLeave);
    el.addEventListener("focus", onReactEnter);
    el.addEventListener("blur", onReactLeave);
  }
  if (finePointer) {
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerout", onPointerOut);
  }
  mount.addEventListener("pointerdown", onTap);
  window.addEventListener("pagehide", onPageHide);

  // A page kept in the back/forward cache only pauses (visibilitychange stops the loop); a page
  // being unloaded frees the GPU resources.
  function onPageHide(ev) { if (!ev.persisted) dispose(); }

  // ---------- cleanup ----------
  function teardown() {
    stop();
    if (rig) { rig.dispose(); rig = null; }
    if (renderer) {
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      renderer = null;
    }
    if (stage) stage.style.removeProperty("--lift");
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    io.disconnect(); ro.disconnect();
    document.removeEventListener("visibilitychange", sync);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", measure);
    window.removeEventListener("keydown", onAnyInput);
    window.removeEventListener("touchstart", onTouch);
    window.removeEventListener("touchmove", onTouch);
    for (const el of reactors) {
      el.removeEventListener("pointerenter", onReactEnter);
      el.removeEventListener("pointerleave", onReactLeave);
      el.removeEventListener("focus", onReactEnter);
      el.removeEventListener("blur", onReactLeave);
    }
    window.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerout", onPointerOut);
    mount.removeEventListener("pointerdown", onTap);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("load", onLoad);
    teardown();
    setState("static");
  }
})();
