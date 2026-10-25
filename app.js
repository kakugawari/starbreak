/*!
 * app.js — 描画と操作。ゲームの中身は core.js が進め、ここはそれを描いて、指の操作を渡す。
 */
(function () {
  'use strict';

  const VERSION = 'v0.11.0';
  const C = window.Core;
  const THREE = window.THREE;
  const K = C.TUNING;

  const $ = function (id) { return document.getElementById(id); };
  const els = {
    gl: $('gl'), hud: $('hud'), controls: $('controls'),
    stickZone: $('stickZone'), stick: $('stick'), stickKnob: $('stickKnob'),
    btnFire: $('btnFire'), btnBoost: $('btnBoost'), btnMissile: $('btnMissile'), missileCount: $('missileCount'),
    btnTarget: $('btnTarget'),
    btnPause: $('btnPause'),
    title: $('title'), pause: $('pause'), result: $('result'),
    resultHead: $('resultHead'), resultRank: $('resultRank'), resultStats: $('resultStats'),
    diag: $('diag'), version: $('version')
  };

  // ------------------------------------------------------------ 設定 (端末ごと)

  const settings = { invert: false, shake: true, sound: true };
  try {
    const saved = JSON.parse(localStorage.getItem('starbreak.settings') || '{}');
    for (const k in settings) if (typeof saved[k] === 'boolean') settings[k] = saved[k];
  } catch (e) { /* 保存できない環境でも遊べる */ }
  function saveSettings() {
    try { localStorage.setItem('starbreak.settings', JSON.stringify(settings)); } catch (e) { /* 無視 */ }
  }
  function bindToggle(ids, key) {
    ids.forEach(function (id) {
      const el = $(id);
      el.checked = settings[key];
      el.addEventListener('change', function () {
        settings[key] = el.checked;
        ids.forEach(function (o) { $(o).checked = settings[key]; });
        saveSettings();
        if (key === 'sound') { audio.setEnabled(settings.sound); syncMusic(); }
      });
    });
  }

  // ------------------------------------------------------------ 描画の土台

  const renderer = new THREE.WebGLRenderer({ canvas: els.gl, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.localClippingEnabled = true; // ワープの光から出てくるボスを、光の面で切って描く
  renderer.setClearColor(0x02040a, 1);
  let pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(pixelRatio);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(68, 16 / 9, 0.5, 30000);
  scene.add(camera);

  const SUN_DIR = new THREE.Vector3(0.75, 0.42, 0.35).normalize();
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.3);
  sun.position.copy(SUN_DIR).multiplyScalar(100);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0x5c7dbf, 0x1a1020, 0.75));
  const flashLight = new THREE.PointLight(0xffa860, 0, 600, 1.6);
  scene.add(flashLight);

  const hud = els.hud.getContext('2d');
  let W = 932, H = 430, hudScale = 2;

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    // 回転の途中などで 0 が来ることがある。そのときは前の大きさのまま
    if (!(w >= 1 && h >= 1)) return;
    W = w; H = h;
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    hudScale = Math.min(window.devicePixelRatio || 1, 2);
    els.hud.width = Math.round(W * hudScale);
    els.hud.height = Math.round(H * hudScale);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 200); });
  resize();

  // ------------------------------------------------------------ 小道具: 絵を作る

  function canvasTex(w, h, draw, srgb) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    draw(cv.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(cv);
    if (srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /** 中心が明るく、外へ消える丸。光・炎・爆発に使う。 */
  const glowTex = canvasTex(128, 128, function (c, w) {
    const g = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,.85)');
    g.addColorStop(0.45, 'rgba(255,255,255,.25)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, w);
  });

  /**
   * 噴射の光 (縦長)。上が噴射口で白く、下 (後ろ) へ細く消える。幅は中心が明るい。
   * 十字に組んだ 2 枚の板に貼る (煙の玉ではなく、光の筋に見せるため)。
   */
  const jetTex = canvasTex(64, 256, function (c, w, h) {
    const img = c.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const t = y / (h - 1);
      const along = Math.pow(1 - t, 1.6);
      const halfW = 0.5 * (1 - t * 0.75);
      for (let x = 0; x < w; x++) {
        const u = Math.abs((x + 0.5) / w - 0.5) / halfW;
        const across = u >= 1 ? 0 : Math.pow(1 - u * u, 2);
        const core = Math.exp(-u * u * 18) * Math.pow(1 - t, 3);
        const v = Math.min(1, along * across * 0.85 + core);
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(v * 255);
      }
    }
    c.putImageData(img, 0, 0);
  });

  const JET_ROOT = 0.53; // plume.png の根もとの光の幅 (絵の幅に対する割合、明るさ 15% 以上)
  const JET_MAT = new THREE.MeshBasicMaterial({
    map: jetTex, color: 0x8fd4ff, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide
  });
  // 噴射の光は送ってもらった絵 (plume.png: 横から見た噴射を切り出し、噴射口を上に向けたもの) を使う。
  // 読めるまでは自前の jetTex で描く

  /**
   * 自機の噴射を推力に合わせる。光だけで見せる: 噴射口の白い芯・小さな青い光・後ろへ延びる光の筋。
   * thrust はふだん 1 前後、ブーストで 1.9
   */
  function setThrust(ship, thrust) {
    const fl = 0.92 + Math.random() * 0.16;
    ship.userData.flames.forEach(function (f, i) {
      const s = (i % 2 ? 2.2 + 0.8 * thrust : 1.5 + 0.5 * thrust) * fl;
      f.scale.set(s, s, 1);
    });
    // 長さは送ってもらった絵に合わせて機体 (11m) の 0.9 倍ほど (ふだん 10m・ブースト約 17m)。
    // 幅は、絵の根もとの光 (絵の幅の 53%) がエンジンの筒 (直径 1.6m) に収まるように決める
    const len = 10 * (0.5 + 0.5 * Math.pow(thrust, 1.4)) * fl, wid = 2.85 + 0.1 * thrust;
    ship.userData.jetRoot = wid * JET_ROOT;
    ship.userData.jets.forEach(function (j) { j.scale.set(wid, wid, len); });
    ship.userData.jetBase = len / fl; // ゆらぎを除いた長さ (見張り用)
  }

  function glowSprite(color, size, opacity) {
    const m = new THREE.SpriteMaterial({
      map: glowTex, color: color, transparent: true, opacity: opacity === undefined ? 1 : opacity,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    const s = new THREE.Sprite(m);
    s.scale.set(size, size, 1);
    return s;
  }

  /**
   * 絵のファイル。1 枚にまとめた版 (bundle.js) では埋め込んだ data URI を使う。
   * 読めなくても遊べるよう、失敗したら呼ばない (暗い空のまま)。
   */
  const texLoader = new THREE.TextureLoader();
  function loadTex(name, done) {
    const src = (window.__ASSETS && window.__ASSETS[name]) || './' + name;
    texLoader.load(src, function (t) {
      t.colorSpace = THREE.SRGBColorSpace;
      done(t);
      assetsLoaded[name] = true;
    }, undefined, function () { assetsLoaded[name] = false; });
  }
  loadTex('plume.png', function (t) { JET_MAT.map = t; JET_MAT.color.set(0xffffff); JET_MAT.needsUpdate = true; });

  const assetsLoaded = {};

  // ------------------------------------------------------------ 宇宙: 星雲・星・惑星・太陽

  // 背景の明るさ。1 だと絵のまま。遊んでいる間は、敵や赤い印が明るい星雲に埋もれないよう沈める
  // (星雲のいちばん明るい所 上位10% の輝度: 1.0 で 69 → 0.55 で 51)。タイトルでは絵を見せる
  const SKY_DIM = { play: 0.55, title: 0.5 };
  let skyDim = SKY_DIM.title;
  function setSkyDim(v) {
    skyDim = v;
    if (sky.userData.mat && sky.userData.mat.map) sky.userData.mat.color.setScalar(v);
  }

  const sky = new THREE.Group();
  scene.add(sky);

  (function buildSky() {
    // 空全体に巻く 2:1 のパノラマ (space.jpg)。読めるまでは暗い紺
    const mat = new THREE.MeshBasicMaterial({ color: 0x03050c, side: THREE.BackSide, depthWrite: false, fog: false });
    const m = new THREE.Mesh(new THREE.SphereGeometry(20000, 64, 32), mat);
    m.renderOrder = -10;
    sky.add(m);
    // 1 面は紫の星雲 (space.jpg)、2 面は灰色の星雲 (space2.jpg)、3 面は琥珀色の星雲 (space3.jpg)、4 面は木星色の星雲 (space4.jpg)。面が変わったら setSkyKind で替える
    sky.userData.tex = {};
    sky.userData.kind = 'space';
    function useSky(name) {
      const t = sky.userData.tex[name];
      if (!t) return;
      mat.map = t;
      mat.color.setScalar(skyDim);
      mat.needsUpdate = true;
    }
    sky.userData.use = useSky;
    ['space', 'space2', 'space3', 'space4'].forEach(function (name) {
      loadTex(name + '.jpg', function (t) {
        // 内側から見ると左右が反転するので戻す
        t.wrapS = THREE.RepeatWrapping;
        t.repeat.x = -1;
        t.anisotropy = 4;
        sky.userData.tex[name] = t;
        if (sky.userData.kind === name) useSky(name);
      });
    });
    sky.userData.mat = mat;

    // 星: 画面に対して一定の大きさの点 (絵の星より手前でくっきり光る)
    const rng = C.mulberry32(99);
    const n = 1400;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = rng() * 2 - 1, th = rng() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      pos[i * 3] = r * Math.cos(th) * 18000; pos[i * 3 + 1] = u * 18000; pos[i * 3 + 2] = r * Math.sin(th) * 18000;
      const b = 0.35 + Math.pow(rng(), 3) * 0.9, tint = rng();
      col[i * 3] = b * (tint < 0.2 ? 1 : tint > 0.85 ? 0.75 : 0.9);
      col[i * 3 + 1] = b * 0.92;
      col[i * 3 + 2] = b * (tint > 0.85 ? 1.1 : tint < 0.2 ? 0.7 : 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const stars = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false, transparent: true, fog: false
    }));
    stars.renderOrder = -9;
    sky.add(stars);

    // 太陽
    const sunS = glowSprite(0xfff0d0, 2600, 1);
    sunS.position.copy(SUN_DIR).multiplyScalar(17000);
    sky.add(sunS);
    const sunHalo = glowSprite(0x88aaff, 9000, 0.25);
    sunHalo.position.copy(sunS.position);
    sky.add(sunHalo);
  })();

  // 地球: 遠くに置いた 1 枚の絵 (earth.jpg)。いつもカメラの方を向く。
  // 黒い背景はシェーダーで抜く: 円の内側は不透明 (夜の側も後ろの星を隠す)、外は光のにじみだけ残す
  const EARTH_DISK = 0.4464;      // 絵の幅に対する地球の半径 (earth.jpg を切り出したときに測った値)
  const planet = new THREE.Group();
  scene.add(planet);
  (function buildPlanet() {
    const R = 4200;
    const size = R / EARTH_DISK;
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: null }, disk: { value: EARTH_DISK } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'uniform sampler2D map; uniform float disk; varying vec2 vUv;' +
        'void main(){ vec4 c = texture2D(map, vUv); float d = distance(vUv, vec2(0.5));' +
        'float inside = 1.0 - smoothstep(disk - 0.002, disk + 0.002, d);' +
        'float glow = clamp(max(c.r, max(c.g, c.b)) * 2.2, 0.0, 1.0);' +
        'float a = max(inside, glow); if (a < 0.004) discard;' +
        'gl_FragColor = vec4(c.rgb / max(a, 0.001), a);' +
        '\n#include <colorspace_fragment>\n}',
      transparent: true, depthWrite: false, fog: false
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    m.renderOrder = -8;
    m.visible = false;
    planet.add(m);
    // 1 面は地球、2 面は水星 (mercury.jpg)、3 面は火星 (mars.jpg。地球の絵と同じ割合: 円の中心が真ん中・半径は幅の 0.44 になるよう切り出した)
    planet.userData.tex = {};
    planet.userData.kind = 'earth';
    loadTex('earth.jpg', function (t) { planet.userData.tex.earth = t; if (planet.userData.kind === 'earth') { mat.uniforms.map.value = t; m.visible = true; } });
    loadTex('mars.jpg', function (t) { planet.userData.tex.mars = t; if (planet.userData.kind === 'mars') { mat.uniforms.map.value = t; m.visible = true; } });
    loadTex('mercury.jpg', function (t) { planet.userData.tex.mercury = t; if (planet.userData.kind === 'mercury') { mat.uniforms.map.value = t; m.visible = true; } });
    loadTex('jupiter.jpg', function (t) { planet.userData.tex.jupiter = t; if (planet.userData.kind === 'jupiter') { mat.uniforms.map.value = t; m.visible = true; } });
    planet.userData.mat = mat;
    planet.userData.offset = new THREE.Vector3(-3400, -5200, -9000);
    planet.userData.ball = m;
  })();

  // タイトルの大きな惑星 (送ってもらった絵の円の中だけを切り出した title_planet.jpg)。
  // 画面に貼り付けた板として、機体より奥・空より手前に描く。置き場所と大きさは画面の高さを 1 とした割合。
  // 惑星はゆっくり回し続け (円の中心が軸)、大気のふちと太陽の光は止めたまま別の板に描く
  // (絵に焼き込まれていた太陽の光は、切り出すときに消してある)
  const TITLE_SHIP = { a: -0.7, dist: 30, y0: 6, x: 0.74, y: 0.56 };
  const TITLE_PLANET = { cx: 0.107, cy: 0.856, r: 1.061, dist: 600, shade: 0.32,
    ang0: -0.09, spinT: 600,                 // はじめの向き (rad) と、1 周の秒数 (時計回り)
    flare: 28 * Math.PI / 180,               // 太陽の光を置くふちの向き (右から上へ)
    driftX: 0.012, driftXT: 53, driftY: 0.015, driftYT: 41 };
  const titlePlanet = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, ang: { value: 0 }, shade: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    // 円の中だけ描き、絵は円の中心のまわりに回して読む (回しても半径は変わらないので、ふちの外は読まない)
    fragmentShader: 'uniform sampler2D map; uniform float ang; uniform float shade; varying vec2 vUv;' +
      'void main(){ vec2 p = (vUv - 0.5) * 2.0; float r = length(p); float a = 1.0 - smoothstep(0.986, 1.0, r); if (a <= 0.0) discard;' +
      'float c = cos(ang), s = sin(ang); vec2 q = vec2(c * p.x + s * p.y, -s * p.x + c * p.y);' +
      'vec4 t = texture2D(map, q * 0.497 + 0.5); gl_FragColor = vec4(t.rgb * shade, a);' +
      '\n#include <colorspace_fragment>\n}',
    transparent: true, depthWrite: false, fog: false
  }));
  titlePlanet.renderOrder = -7;
  titlePlanet.visible = false;
  titlePlanet.userData.loaded = false;
  scene.add(titlePlanet);
  loadTex('title_planet.jpg', function (t) { titlePlanet.material.uniforms.map.value = t; titlePlanet.userData.loaded = true; });
  // 大気のふち (日の当たる側ほど明るい) と太陽の光。回さない。惑星の半径を 1 として、板は半径 1.6 ぶん
  const TP_GLOW = 1.6;
  const titleGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    uniforms: { flare: { value: new THREE.Vector2(1, 0) }, k: { value: TP_GLOW } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec2 flare; uniform float k; varying vec2 vUv;' +
      'void main(){ vec2 p = (vUv - 0.5) * 2.0 * k; float r = length(p);' +
      'float lit = 0.3 + 0.7 * max(0.0, dot(p / max(r, 1e-4), flare));' +
      'float w = r > 1.0 ? 0.045 : 0.015; float rim = exp(-pow((r - 1.0) / w, 2.0)) * (0.3 + 0.5 * lit);' +
      'vec3 rimC = mix(vec3(0.18, 0.45, 1.0), vec3(0.7, 0.9, 1.0), lit);' +
      'vec2 d = p - flare; float dl = length(d);' +
      'float core = exp(-pow(dl / 0.026, 2.0)) * 2.2 + exp(-pow(dl / 0.085, 2.0)) * 0.6 + exp(-pow(dl / 0.26, 2.0)) * 0.14;' +
      'float streak = exp(-pow(d.y / 0.005, 2.0)) * exp(-abs(d.x) / 0.36) * 0.85;' +
      'vec3 col = rimC * rim + vec3(1.0, 0.95, 0.86) * (core + streak);' +
      'gl_FragColor = vec4(col, 1.0); }',
    transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending
  }));
  titleGlow.renderOrder = -6;
  titleGlow.visible = false;
  scene.add(titleGlow);
  function titlePlanetAngle() { return TITLE_PLANET.ang0 - titleT / TITLE_PLANET.spinT * Math.PI * 2; }
  function placeTitlePlanet() {
    camera.updateMatrixWorld();
    const P = TITLE_PLANET;
    const halfH = Math.tan(camera.fov * Math.PI / 360) * P.dist;     // 画面の高さの半分 (その奥行きでの長さ)
    const unit = halfH * 2;                                            // 画面の高さ 1 ぶん
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    // 円の中心を画面で決めて、ふわりと漂わせる
    const t = titleT, TAU = Math.PI * 2;
    const sx = (P.cx * H - W / 2) / H + P.driftX * Math.sin(t / P.driftXT * TAU);
    const sy = (H / 2 - P.cy * H) / H + P.driftY * Math.sin(t / P.driftYT * TAU);
    titlePlanet.position.copy(camera.position).addScaledVector(fwd, P.dist).addScaledVector(right, sx * unit).addScaledVector(up, sy * unit);
    titlePlanet.quaternion.copy(camera.quaternion);
    titlePlanet.scale.set(P.r * 2 * unit, P.r * 2 * unit, 1);
    titlePlanet.material.uniforms.ang.value = titlePlanetAngle();
    titlePlanet.material.uniforms.shade.value = P.shade;
    titlePlanet.visible = titlePlanet.userData.loaded;
    // 大気と太陽の光: 同じ所に、回さずに (手前に少しだけ寄せて重ねる)
    titleGlow.position.copy(titlePlanet.position).addScaledVector(fwd, -1);
    titleGlow.quaternion.copy(camera.quaternion);
    titleGlow.scale.set(P.r * 2 * TP_GLOW * unit, P.r * 2 * TP_GLOW * unit, 1);
    titleGlow.material.uniforms.flare.value.set(Math.cos(P.flare), Math.sin(P.flare));
    titleGlow.visible = titlePlanet.visible;
  }

  /** 空の絵を面に合わせて替える (1 面 space / 2 面 space2 / 3 面 space3)。 */
  function setSkyKind(kind) {
    if (sky.userData.kind === kind) return;
    sky.userData.kind = kind;
    sky.userData.use(kind);
  }

  /** ゲームの空の惑星を地球 / 水星 / 火星に切り替える (面が変わったとき)。 */
  function setPlanetKind(kind) {
    const u = planet.userData;
    if (u.kind === kind) return;
    u.kind = kind;
    const t = u.tex[kind];
    if (t) { u.mat.uniforms.map.value = t; u.ball.visible = true; }
  }

  // 宇宙のちり: 自分の動きが分かるよう、通り過ぎる細い筋を描く
  const DUST_N = 420, DUST_BOX = 260;
  const dust = (function () {
    const pos = new Float32Array(DUST_N * 6);
    const col = new Float32Array(DUST_N * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false
    }));
    lines.frustumCulled = false;
    scene.add(lines);
    const rng = C.mulberry32(5);
    const pts = [];
    for (let i = 0; i < DUST_N; i++) pts.push(new THREE.Vector3((rng() - 0.5) * DUST_BOX, (rng() - 0.5) * DUST_BOX, (rng() - 0.5) * DUST_BOX));
    return { lines: lines, pos: pos, col: col, pts: pts, geo: geo };
  })();

  function updateDust(camPos, vel) {
    const half = DUST_BOX / 2;
    const k = 0.05;           // 筋の長さ = 速さ x k
    const sp = vel.length();
    const bright = Math.min(1, 0.25 + sp / 160);
    for (let i = 0; i < DUST_N; i++) {
      const p = dust.pts[i];
      // カメラのまわりの箱に巻き戻す (ちりは空間に止まっている)
      p.x = camPos.x + ((((p.x - camPos.x + half) % DUST_BOX) + DUST_BOX) % DUST_BOX) - half;
      p.y = camPos.y + ((((p.y - camPos.y + half) % DUST_BOX) + DUST_BOX) % DUST_BOX) - half;
      p.z = camPos.z + ((((p.z - camPos.z + half) % DUST_BOX) + DUST_BOX) % DUST_BOX) - half;
      const j = i * 6;
      dust.pos[j] = p.x; dust.pos[j + 1] = p.y; dust.pos[j + 2] = p.z;
      dust.pos[j + 3] = p.x + vel.x * k; dust.pos[j + 4] = p.y + vel.y * k; dust.pos[j + 5] = p.z + vel.z * k;
      const d = p.distanceTo(camPos) / half;
      const a = Math.max(0, 1 - d) * bright;
      dust.col[j] = 0.55 * a; dust.col[j + 1] = 0.7 * a; dust.col[j + 2] = a;
      dust.col[j + 3] = 0; dust.col[j + 4] = 0; dust.col[j + 5] = 0;
    }
    dust.geo.attributes.position.needsUpdate = true;
    dust.geo.attributes.color.needsUpdate = true;
  }

  // ------------------------------------------------------------ 機体

  const MAT = {
    hull: new THREE.MeshPhongMaterial({ color: 0xd8dde6, shininess: 70, specular: 0x667788 }),
    dark: new THREE.MeshPhongMaterial({ color: 0x2b303b, shininess: 40 }),
    red: new THREE.MeshPhongMaterial({ color: 0xc42430, shininess: 60 }),
    glass: new THREE.MeshPhongMaterial({ color: 0x1d4a8a, emissive: 0x0a1d3a, shininess: 120, specular: 0xaaccff }),
    engine: new THREE.MeshBasicMaterial({ color: 0x9fd8ff })
  };

  /**
   * 左右反対の板。geometry.scale(-1) で鏡にすると面の裏表が逆になり、光の当たり方が
   * 逆になって黒く見える。点の x を反転してから形を作れば、向きは Shape が直してくれる。
   */
  function wingGeoMirrored(pts, thick, sx) {
    return wingGeo(pts.map(function (p) { return [p[0] * sx, p[1]]; }), thick);
  }

  function wingGeo(pts, thick) {
    const s = new THREE.Shape();
    s.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false });
    g.translate(0, 0, -thick / 2);
    g.rotateX(Math.PI / 2);     // 形の y → 世界の z (後ろが +)
    return g;
  }

  function mesh(geo, mat, x, y, z) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x || 0, y || 0, z || 0);
    return m;
  }

  /**
   * 断面をつないだ胴体。sections は機首から順に { z, w (半幅), h (半高), y (中心の高さ) }。
   * 角の丸い四角 (超楕円) の断面にして、ずんぐりしすぎない形にする。color(z) で部分ごとの色。
   */
  function loftGeo(sections, n, color) {
    const pos = [], col = [], idx = [];
    const p = 2.6;
    sections.forEach(function (sc) {
      const c = new THREE.Color(color(sc.z));
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        const ct = Math.cos(t), st = Math.sin(t);
        const x = sc.w * Math.sign(ct) * Math.pow(Math.abs(ct), 2 / p);
        const y = sc.h * Math.sign(st) * Math.pow(Math.abs(st), 2 / p);
        pos.push(x, (sc.y || 0) + y, sc.z);
        col.push(c.r, c.g, c.b);
      }
    });
    for (let r = 0; r < sections.length - 1; r++) {
      for (let i = 0; i < n; i++) {
        const a = r * n + i, b = r * n + (i + 1) % n, c = a + n, d = b + n;
        idx.push(a, c, b, b, c, d);
      }
    }
    // 後ろの端はふさぐ
    const last = (sections.length - 1) * n;
    for (let i = 1; i < n - 1; i++) idx.push(last, last + i, last + i + 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /** 縦の板 (尾翼など)。pts は (z, y) の点。厚みは x 方向。 */
  function finGeo(pts, thick) {
    const s = new THREE.Shape();
    s.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false });
    g.translate(0, 0, -thick / 2);
    g.rotateY(-Math.PI / 2);    // 形の x → 世界の z
    return g;
  }

  const SHIP = {
    white: 0xe9e5da, yellow: 0xf2c21c, dark: 0x30333b, navy: 0x1d2740
  };
  const SHIP_MAT = {
    body: new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 60, specular: 0x555555 }),
    white: new THREE.MeshPhongMaterial({ color: SHIP.white, shininess: 60, specular: 0x555555 }),
    yellow: new THREE.MeshPhongMaterial({ color: SHIP.yellow, shininess: 70, specular: 0x666644 }),
    dark: new THREE.MeshPhongMaterial({ color: SHIP.dark, shininess: 40 }),
    navy: new THREE.MeshPhongMaterial({ color: SHIP.navy, shininess: 80, specular: 0x6688aa }),
    glass: new THREE.MeshPhongMaterial({ color: 0x173a78, emissive: 0x06142e, shininess: 140, specular: 0xbfd8ff }),
    fan: new THREE.MeshBasicMaterial({ color: 0x5fb8ff }),
    nozzle: new THREE.MeshBasicMaterial({ color: 0xbfe6ff })
  };

  /** 機首の横の「01」。透明な地に字だけ。 */
  const markTex = canvasTex(128, 64, function (c) {
    c.font = '900 52px -apple-system, "Helvetica Neue", sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#2a2c33';
    c.fillText('01', 64, 34);
  });

  /**
   * 自機 RZ-1。前は -Z。全長 12m・全幅 10m・全高 3.5m (送ってもらった三面図から測った寸法)。
   * 白地に黄色の差し色、大きなキャノピー、太いエンジン 2 基、後ろへ流れる主翼、外へ開く尾翼 2 枚。
   */
  function makePlayerShip() {
    const g = new THREE.Group();
    const body = new THREE.Group();
    g.add(body);

    // 胴体: 機首の先 (黄) → キャノピーの下 → エンジンの間 → 尾
    const fus = loftGeo([
      { z: -6.0, w: 0.02, h: 0.02, y: -0.1 },
      { z: -5.4, w: 0.22, h: 0.16, y: -0.08 },
      { z: -4.4, w: 0.45, h: 0.4, y: -0.04 },
      { z: -4.2, w: 0.5, h: 0.44, y: -0.03 },
      { z: -3.0, w: 0.72, h: 0.64, y: 0 },
      { z: -1.4, w: 0.88, h: 0.78, y: 0.02 },
      { z: 0.5, w: 0.98, h: 0.74, y: 0 },
      { z: 2.6, w: 0.92, h: 0.62, y: -0.02 },
      { z: 4.6, w: 0.62, h: 0.44, y: -0.02 },
      { z: 5.4, w: 0.3, h: 0.26, y: 0 }
    ], 18, function (z) { return z < -4.3 ? SHIP.yellow : SHIP.white; });
    body.add(mesh(fus, SHIP_MAT.body));

    // キャノピー (大きく細長い)
    const canopy = mesh(new THREE.SphereGeometry(1, 20, 12), SHIP_MAT.glass, 0, 0.56, -2.6);
    canopy.scale.set(0.55, 0.55, 1.8);
    body.add(canopy);
    // キャノピーの後ろの背中 (濃い灰の装備)
    body.add(mesh(new THREE.BoxGeometry(0.9, 0.34, 2.2), SHIP_MAT.dark, 0, 0.74, 0.4));
    body.add(mesh(new THREE.BoxGeometry(0.6, 0.22, 1.4), SHIP_MAT.white, 0, 0.94, 0.5));

    // 胴の脇の張り出し (機首から主翼へ)。ふちが黄色
    [1, -1].forEach(function (sx) {
      const a = wingGeoMirrored([[0.45, -3.6], [1.25, -0.6], [1.6, 0.6], [0.6, 0.6]], 0.12, sx);
      const e = wingGeoMirrored([[0.45, -3.6], [1.25, -0.6], [1.16, -0.52], [0.42, -3.3]], 0.14, sx);
      body.add(mesh(a, SHIP_MAT.white, 0, -0.08, 0), mesh(e, SHIP_MAT.yellow, 0, -0.08, 0));
    });

    // エンジン 2 基: 前半は白い覆い、後ろは紺。前に吸気口、後ろに青く光る噴射口
    const flames = [], jets = [];
    const EX = 1.55, EY = -0.12;
    const cowl = new THREE.CylinderGeometry(0.72, 0.6, 2.9, 20); cowl.rotateX(Math.PI / 2);
    const rear = new THREE.CylinderGeometry(0.8, 0.78, 2.6, 20); rear.rotateX(Math.PI / 2);
    const ring = new THREE.TorusGeometry(0.78, 0.07, 6, 20);
    const intake = new THREE.CircleGeometry(0.5, 20); intake.rotateY(Math.PI);
    const noz = new THREE.CircleGeometry(0.62, 20);
    [-EX, EX].forEach(function (x) {
      body.add(mesh(cowl, SHIP_MAT.white, x, EY, 1.0));
      body.add(mesh(rear, SHIP_MAT.navy, x, EY, 3.75));
      [2.9, 3.7, 4.5].forEach(function (z) { body.add(mesh(ring, SHIP_MAT.dark, x, EY, z)); });
      body.add(mesh(intake, SHIP_MAT.fan, x, EY, -0.4));
      body.add(mesh(new THREE.TorusGeometry(0.6, 0.1, 6, 20), SHIP_MAT.dark, x, EY, -0.46));
      body.add(mesh(noz, SHIP_MAT.nozzle, x, EY, 5.06));
      // エンジンと胴をつなぐ板
      body.add(mesh(new THREE.BoxGeometry(Math.abs(x) - 0.4, 0.5, 3.6), SHIP_MAT.white, x / 2 + Math.sign(x) * 0.2, EY + 0.05, 1.6));
      const f1 = glowSprite(0xbfe8ff, 3.0, 1); f1.position.set(x, EY, 5.3);
      const f2 = glowSprite(0x3a7dff, 4, 0.5); f2.position.set(x, EY, 5.6);
      body.add(f1, f2);
      flames.push(f1, f2);
      // 噴射口から後ろへ延びる光の筋 (十字の板 2 枚)。長さは推力で変える
      const jet = new THREE.Group();
      jet.position.set(x, EY, 5.1);
      [0, Math.PI / 2].forEach(function (rz) {
        const g = new THREE.PlaneGeometry(1, 1); g.translate(0, -0.5, 0); g.rotateX(-Math.PI / 2); g.rotateZ(rz);
        jet.add(new THREE.Mesh(g, JET_MAT));
      });
      body.add(jet);
      jets.push(jet);
    });

    // 主翼: 後ろ寄りで約 46° 後退、前のふちが黄色、外へわずかに下がる
    [1, -1].forEach(function (sx) {
      const w = new THREE.Group();
      const a = wingGeoMirrored([[1.9, -0.2], [5.0, 4.2], [4.7, 4.35], [3.0, 3.1], [2.2, 3.7], [1.9, 3.7]], 0.14, sx);
      const e = wingGeoMirrored([[1.9, -0.2], [5.0, 4.2], [4.85, 4.25], [1.9, 0.25]], 0.16, sx);
      w.add(mesh(a, SHIP_MAT.white), mesh(e, SHIP_MAT.yellow));
      w.position.set(0, EY - 0.05, 0);
      w.rotation.z = sx * -0.07;
      body.add(w);
    });

    // 尾翼 2 枚: エンジンの上から外へ約 25° 開く。上半分が黄色
    const fin = finGeo([[2.5, 0], [4.7, 0], [5.45, 1.55], [4.95, 1.6]], 0.1);
    const finTip = finGeo([[3.7, 0.8], [5.08, 0.8], [5.45, 1.55], [4.95, 1.6]], 0.12);
    [1, -1].forEach(function (sx) {
      const f = new THREE.Group();
      f.add(mesh(fin, SHIP_MAT.white), mesh(finTip, SHIP_MAT.yellow));
      f.position.set(sx * 1.25, EY + 0.65, 0);
      f.rotation.z = sx * -0.44;
      body.add(f);
    });

    // 機首の横の「01」
    const markGeo = new THREE.PlaneGeometry(0.7, 0.35);
    const markMat = new THREE.MeshBasicMaterial({ map: markTex, transparent: true, depthWrite: false });
    [1, -1].forEach(function (sx) {
      const m = mesh(markGeo, markMat, sx * 0.64, -0.06, -3.55);
      m.rotation.y = sx * Math.PI / 2;
      m.rotation.x = 0;
      body.add(m);
    });

    g.userData = { body: body, flames: flames, jets: jets };
    return g;
  }

  const ENEMY_MAT = {
    // 暗い灰 (見本より少しだけ明るく)。明るい灰と赤の塗りも試したが、暗い灰の方がよいと決まった。
    // 見つけやすさは、赤いライトと大きめのエンジンの光でまかなう
    hull: new THREE.MeshPhongMaterial({ color: 0x62666f, shininess: 45, specular: 0x4a4d55, flatShading: true }),
    dark: new THREE.MeshPhongMaterial({ color: 0x23252b, shininess: 30, flatShading: true }),
    canopy: new THREE.MeshPhongMaterial({ color: 0x5a0a12, emissive: 0x2a0306, shininess: 140, specular: 0xff9090 }),
    glow: new THREE.MeshBasicMaterial({ color: 0xff2a3a })
  };

  /**
   * 敵戦闘機。前は -Z。全長 10m・全幅 9m・全高 3.2m (送ってもらった三面図から測った寸法)。
   * 角ばった機体、小さな赤いキャノピー、機首の横の前翼、後ろの大きなエンジン 1 基が赤く光る。
   * 色は暗い灰。赤いのは光る所 (キャノピー・ライト・吸気口・エンジン) だけ。
   */
  function makeEnemyShip(red) {
    const g = new THREE.Group();
    const body = new THREE.Group();
    g.add(body);
    // 当たったときに白く光らせるので、機体ごとに材質を分ける
    const hull = ENEMY_MAT.hull.clone();
    if (red) { hull.color.setHex(0xb02024); hull.specular.setHex(0xff8070); }

    // 胴体: 断面を 8 角にして、面で角ばった形に
    const fus = loftGeo([
      { z: -5.0, w: 0.02, h: 0.02, y: -0.08 },
      { z: -4.2, w: 0.34, h: 0.2, y: -0.06 },
      { z: -3.0, w: 0.58, h: 0.44, y: -0.02 },
      { z: -1.6, w: 0.82, h: 0.6, y: 0.02 },
      { z: 0.4, w: 1.05, h: 0.68, y: 0 },
      { z: 2.4, w: 1.0, h: 0.72, y: 0 },
      { z: 3.4, w: 0.98, h: 0.82, y: 0.05 },
      { z: 4.5, w: 0.92, h: 0.86, y: 0.05 }
    ], 8, function () { return 0xffffff; });
    body.add(mesh(fus, hull));

    // 小さな赤いキャノピー
    const canopy = mesh(new THREE.SphereGeometry(1, 12, 8), ENEMY_MAT.canopy, 0, 0.44, -2.4);
    canopy.scale.set(0.34, 0.3, 1.05);
    body.add(canopy);

    // 脇の吸気口 (前が赤く光る)
    [1, -1].forEach(function (sx) {
      body.add(mesh(new THREE.BoxGeometry(0.55, 0.62, 2.6), hull, sx * 1.02, -0.05, 0.2));
      const lip = mesh(new THREE.PlaneGeometry(0.42, 0.42), ENEMY_MAT.glow, sx * 1.02, -0.05, -1.11);
      lip.rotation.y = Math.PI;
      body.add(lip);
      // 胴の横の赤い線
      body.add(mesh(new THREE.BoxGeometry(0.04, 0.06, 1.2), ENEMY_MAT.glow, sx * 1.31, 0.12, 0.4));
    });

    // 機首の横の前翼。先に丸い筒と赤いライト
    [1, -1].forEach(function (sx) {
      body.add(mesh(wingGeoMirrored([[0.3, -4.0], [2.0, -3.6], [2.0, -3.1], [0.4, -3.1]], 0.1, sx), hull, 0, -0.05, 0));
      const podGeo = new THREE.CylinderGeometry(0.15, 0.15, 1.0, 8); podGeo.rotateX(Math.PI / 2);
      body.add(mesh(podGeo, ENEMY_MAT.dark, sx * 2.05, -0.05, -3.45));
      body.add(mesh(new THREE.SphereGeometry(0.08, 6, 4), ENEMY_MAT.glow, sx * 2.05, -0.05, -3.97));
      const b1 = glowSprite(0xff3040, 2.6, 0.9); b1.position.set(sx * 2.05, -0.05, -4.05);
      body.add(b1);
    });

    // 主翼: 後ろ寄りで大きく後退、外へわずかに下がる。先に赤いライト
    [1, -1].forEach(function (sx) {
      const w = new THREE.Group();
      w.add(mesh(wingGeoMirrored([[1.0, -0.9], [4.5, 2.3], [4.35, 2.65], [2.3, 2.0], [1.0, 2.6]], 0.14, sx), hull));
      w.add(mesh(new THREE.SphereGeometry(0.09, 6, 4), ENEMY_MAT.glow, sx * 4.42, 0, 2.45));
      // 翼の先の赤いライト。遠くからでも敵だと分かる光の玉
      const b2 = glowSprite(0xff3040, 3.6, 0.95); b2.position.set(sx * 4.45, 0, 2.5);
      w.add(b2);
      w.position.y = -0.1;
      w.rotation.z = sx * -0.06;
      body.add(w);
      // 水平の尾翼
      body.add(mesh(wingGeoMirrored([[0.85, 3.2], [2.5, 4.7], [2.3, 5.0], [0.85, 4.8]], 0.1, sx), hull, 0, -0.05, 0));
    });

    // 背中の尾翼 2 枚 (外へ開く) と、腹の小さな尾翼 2 枚
    const topFin = finGeo([[0.8, 0], [3.1, 0], [4.0, 2.0], [3.35, 2.05]], 0.1);
    const lowFin = finGeo([[3.2, 0], [4.6, 0], [5.0, -0.9], [4.5, -0.95]], 0.08);
    [1, -1].forEach(function (sx) {
      const t = mesh(topFin, hull, sx * 0.55, 0.55, 0); t.rotation.z = sx * -0.38;
      const b = mesh(lowFin, hull, sx * 0.6, -0.55, 0); b.rotation.z = sx * 0.35;
      body.add(t, b);
    });

    // 後ろの大きなエンジン 1 基 (八角形)。奥が赤く光る
    const eng = new THREE.CylinderGeometry(0.95, 1.0, 1.4, 8); eng.rotateX(Math.PI / 2); eng.rotateZ(Math.PI / 8);
    body.add(mesh(eng, ENEMY_MAT.dark, 0, 0.05, 4.7));
    const noz = new THREE.CircleGeometry(0.72, 8); noz.rotateZ(Math.PI / 8);
    body.add(mesh(noz, ENEMY_MAT.glow, 0, 0.05, 5.41));
    // エンジンの光は大きめに (遠くからでも、横からでも「敵がいる」と分かるように)。
    // 外の輪は足さずに重ねて塗る: 足すと紫や青の星雲と混ざって桃色に見える
    const e1 = glowSprite(0xff5a50, 6, 1); e1.position.set(0, 0.05, 5.9);
    const e2 = glowSprite(0xff1424, 12, 0.75); e2.position.set(0, 0.05, 7.2);
    e2.material.blending = THREE.NormalBlending;
    e2.renderOrder = 1;
    body.add(e1, e2);

    g.userData = { body: body, mats: [hull] };
    return g;
  }

  // ------------------------------------------------------------ 巨大戦艦
  //
  // 立体の表 (core.js の BOSS_SOLIDS) から作る。当たり判定と見た目が同じ立体。
  // 表面には装甲の絵 (hull.jpg) を、40m 四方ごとに 1 枚の大きさで貼る。

  const HULL_TILE = 40;
  const hullMat = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 30, specular: 0x50555e, flatShading: true });
  loadTex('hull.jpg', function (t) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    hullMat.map = t;
    hullMat.needsUpdate = true;
  });

  /**
   * 立体 (上から見た凸の多角形を高さで押し出したもの) の三角形。
   * 面ごとに外向きの法線を持たせ、頂点の並びもそれにそろえる (片側が黒く見える不具合よけ)。
   * 絵の座標は、上下の面は (x, z)、横の面は (ふちに沿った長さ, y) を HULL_TILE で割ったもの。
   */
  function prismGeo(solid, shade, out) {
    const P = solid.poly;
    const rng0 = C.solidRange(solid), y0 = rng0[0], y1 = rng0[1];
    // 横向きの立体 (axis: 'z') は、計算した形の y と z を入れ替えて置く
    const swap = solid.axis === 'z';
    const mapv0 = function (v) { return swap ? [v[0], v[2], v[1]] : v; };
    // 立体に回転 (solid.m)・ずらし (solid.at) があるときは、点と法線をその分だけ回す (木星要塞の輪・軸・台座)
    const SM = solid.m, SA = solid.at;
    const mapv = SM ? function (v) {
      v = mapv0(v);
      return [SM[0] * v[0] + SM[1] * v[1] + SM[2] * v[2], SM[3] * v[0] + SM[4] * v[1] + SM[5] * v[2], SM[6] * v[0] + SM[7] * v[1] + SM[8] * v[2]];
    } : mapv0;
    const mapp = function (v) { v = mapv(v); return SA ? [v[0] + SA[0], v[1] + SA[1], v[2] + SA[2]] : v; };
    let cx = 0, cz = 0;
    P.forEach(function (q) { cx += q[0]; cz += q[1]; });
    cx /= P.length; cz /= P.length;
    const tri = function (a, b, c, n, ua, ub, uc) {
      a = mapp(a); b = mapp(b); c = mapp(c); n = mapv(n);
      // 表向き (頂点の並び) を法線にそろえる (入れ替えは鏡と同じなので、入れ替えた後で見る)
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] < 0) { const t = b; b = c; c = t; const tu = ub; ub = uc; uc = tu; }
      [a, b, c].forEach(function (v) { out.pos.push(v[0], v[1], v[2]); out.nor.push(n[0], n[1], n[2]); out.col.push(shade[0], shade[1], shade[2]); });
      out.uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
    };
    const S = HULL_TILE;
    // 上と下の面 (扇形に割る)
    for (let i = 1; i < P.length - 1; i++) {
      const a = P[0], b = P[i], c = P[i + 1];
      tri([a[0], y1, a[1]], [b[0], y1, b[1]], [c[0], y1, c[1]], [0, 1, 0], [a[0] / S, a[1] / S], [b[0] / S, b[1] / S], [c[0] / S, c[1] / S]);
      tri([a[0], y0, a[1]], [b[0], y0, b[1]], [c[0], y0, c[1]], [0, -1, 0], [a[0] / S, a[1] / S], [b[0] / S, b[1] / S], [c[0] / S, c[1] / S]);
    }
    // 横の面
    let run = 0;
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let n = [b[1] - a[1], 0, -(b[0] - a[0])];
      const nl = Math.hypot(n[0], n[2]); n = [n[0] / nl, 0, n[2] / nl];
      if (n[0] * ((a[0] + b[0]) / 2 - cx) + n[2] * ((a[1] + b[1]) / 2 - cz) < 0) n = [-n[0], 0, -n[2]];
      const u0 = run / S, u1 = (run + L) / S, v0 = y0 / S, v1 = y1 / S;
      tri([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], n, [u0, v0], [u1, v0], [u1, v1]);
      tri([a[0], y0, a[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], n, [u0, v0], [u1, v1], [u0, v1]);
      run += L;
    }
  }

  function geoFrom(out) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(out.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(out.col, 3));
    if (out.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(out.uv, 2));
    return g;
  }

  function insidePoly(P, x, z) {
    let sign = 0;
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      const c = (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]);
      if (Math.abs(c) < 1e-9) continue;
      const sg = c > 0 ? 1 : -1;
      if (sign === 0) sign = sg; else if (sg !== sign) return false;
    }
    return true;
  }

  function makeBossModel(level, type) {
    if (type === 'fortress') return makeFortressModel();
    if (type === 'driller') return makeDrillerModel();
    const mat = hullMat;
    const group = new THREE.Group();
    const rng = C.mulberry32(1234);
    const hull = { pos: [], nor: [], col: [], uv: [] };
    const lights = { pos: [], nor: [], col: [] };
    const shadeOf = function (k) { const v = 0.62 + k * 0.38; return [v * 0.96, v * 0.98, v * 1.04]; };
    const light = function (x, y, z, size, c) {
      const g = new THREE.BoxGeometry(size, size * 0.6, size).toNonIndexed();
      g.translate(x, y, z);
      const P = g.attributes.position.array, N = g.attributes.normal.array;
      for (let i = 0; i < P.length; i += 3) { lights.pos.push(P[i], P[i + 1], P[i + 2]); lights.nor.push(N[i], N[i + 1], N[i + 2]); lights.col.push(c[0], c[1], c[2]); }
      g.dispose();
    };

    C.BOSS_SOLIDS.forEach(function (sd) {
      if (sd.armor) return;
      prismGeo(sd, shadeOf(rng()), hull);
      if (sd.axis === 'z') return;      // 横向きの円盤には凸凹と明かりを足さない
      const P = sd.poly;
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      P.forEach(function (q) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); });
      // 上の面に細かい凸凹 (判定には入れない小さな物)。多角形の内側にだけ置く
      const area = (x1 - x0) * (z1 - z0);
      const count = Math.floor(area / 700);
      for (let i = 0; i < count; i++) {
        const sx = 4 + rng() * 18, sz = 3 + rng() * 14, h = 0.8 + rng() * 4;
        const x = x0 + rng() * (x1 - x0), z = z0 + rng() * (z1 - z0);
        if (!insidePoly(P, x - sx / 2, z - sz / 2) || !insidePoly(P, x + sx / 2, z - sz / 2) ||
            !insidePoly(P, x + sx / 2, z + sz / 2) || !insidePoly(P, x - sx / 2, z + sz / 2)) continue;
        prismGeo({ poly: [[x - sx / 2, z - sz / 2], [x + sx / 2, z - sz / 2], [x + sx / 2, z + sz / 2], [x - sx / 2, z + sz / 2]], y0: sd.y1, y1: sd.y1 + h }, shadeOf(rng() * 0.7), hull);
        // ところどころ赤い明かり
        if (rng() < 0.25) light(x, sd.y1 + h + 0.3, z, 1.2, [1, 0.18, 0.15]);
      }
      // 横の面に、小さな明かりの列 (赤と、少しだけ暖色)
      for (let i = 0; i < P.length; i++) {
        const a = P[i], b = P[(i + 1) % P.length];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        let nx = b[1] - a[1], nz = -(b[0] - a[0]);
        const nl = Math.hypot(nx, nz); nx /= nl; nz /= nl;
        const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
        let cx = 0, cz = 0; P.forEach(function (q) { cx += q[0]; cz += q[1]; }); cx /= P.length; cz /= P.length;
        if (nx * (mx - cx) + nz * (mz - cz) < 0) { nx = -nx; nz = -nz; }
        const n = Math.floor(L / 9);
        for (let k = 0; k < n; k++) {
          if (rng() < 0.55) continue;
          const t = rng();
          const y = sd.y0 + (0.25 + rng() * 0.5) * (sd.y1 - sd.y0);
          const warm = rng() < 0.3;
          light(a[0] + (b[0] - a[0]) * t + nx * 0.4, y, a[1] + (b[1] - a[1]) * t + nz * 0.4, 1.1, warm ? [1, 0.7, 0.4] : [1, 0.15, 0.12]);
        }
      }
    });
    const hullMesh = new THREE.Mesh(geoFrom(hull), mat);
    const lightMesh = new THREE.Mesh(geoFrom(lights), new THREE.MeshBasicMaterial({ vertexColors: true }));
    group.add(hullMesh, lightMesh);

    // 飾り (判定には入れない): 光る輪、主砲の砲身、アンテナ
    const glowRed = new THREE.MeshBasicMaterial({ color: 0xff2a3a });
    const darkMat = new THREE.MeshPhongMaterial({ color: 0x3a3d44, shininess: 50, flatShading: true });
    const hub = C.BOSS_SOLIDS.find(function (sd) { return sd.name === 'hub'; });
    // 真ん中の胴の上の、赤く光る輪 (脈打たせる)
    const topRing = mesh(new THREE.TorusGeometry(56, 6, 8, 48), glowRed, 0, hub.y1 + 1, 0);
    topRing.rotation.x = Math.PI / 2;
    const topGlow = glowSprite(0xff2030, 190, 0.55);
    topGlow.position.set(0, hub.y1 + 6, 0);
    group.add(topRing, topGlow);
    // 左右の船体の外側の、赤い輪の円盤
    const sideRings = [];
    [-1, 1].forEach(function (sz) {
      // 横向きの円盤 (wheelL / wheelR) の外の面に、赤く光る輪
      const wheel = C.BOSS_SOLIDS.find(function (sd) { return sd.name === (sz < 0 ? 'wheelL' : 'wheelR'); });
      const face = sz < 0 ? wheel.z0 : wheel.z1;
      const r = mesh(new THREE.TorusGeometry(36, 4, 8, 40), glowRed, 0, 0, face + sz * 0.8);
      const inner = mesh(new THREE.TorusGeometry(18, 2.5, 6, 28), glowRed, 0, 0, face + sz * 0.8);
      const gl = glowSprite(0xff2030, 120, 0.45); gl.position.set(0, 0, face + sz * 6);
      group.add(r, inner, gl);
      sideRings.push(gl);
    });
    // 主砲の砲身 (前の真ん中の台から突き出す) と、付け根の光る輪
    const cn = C.BOSS_CANNON;
    const barrel = new THREE.CylinderGeometry(4.2, 5.2, 64, 12); barrel.rotateZ(Math.PI / 2);
    group.add(mesh(barrel, darkMat, cn.x + 32, cn.y, cn.z));
    const muzzle = new THREE.TorusGeometry(5.6, 1.6, 6, 16); muzzle.rotateY(Math.PI / 2);
    group.add(mesh(muzzle, darkMat, cn.x + 1, cn.y, cn.z));
    const baseRing = new THREE.TorusGeometry(15, 2.4, 8, 24); baseRing.rotateY(Math.PI / 2);
    group.add(mesh(baseRing, glowRed, -292, 0, 0));
    // 艦橋の上のアンテナ
    const br = C.BOSS_SOLIDS.find(function (sd) { return sd.name === 'bridge'; });
    const mast = new THREE.CylinderGeometry(0.6, 0.9, 22, 5);
    group.add(mesh(mast, darkMat, 150, br.y1 + 11, -10), mesh(mast, darkMat, 162, br.y1 + 8, 12), mesh(mast, darkMat, 172, br.y1 + 6, -2));

    // 装甲 (コアの蓋)。外れたら消す
    const ab = C.BOSS_SOLIDS.filter(function (sd) { return sd.armor; })[0];
    const armorGeo = { pos: [], nor: [], col: [], uv: [] };
    prismGeo(ab, [0.85, 0.85, 0.9], armorGeo);
    const armor = new THREE.Mesh(geoFrom(armorGeo), mat);
    group.add(armor);

    // 部位
    const parts = [];
    C.BOSS_PARTS.forEach(function (p) {
      const pg = new THREE.Group();
      pg.position.set(p.at.x, p.at.y, p.at.z);
      const mat = new THREE.MeshPhongMaterial({ color: 0x6a707e, shininess: 50, emissive: 0x000000 });
      if (p.kind === 'turret') {
        const base = mesh(new THREE.CylinderGeometry(9, 11, 7, 10), mat);
        const head = new THREE.Group();
        head.add(mesh(new THREE.SphereGeometry(7.5, 12, 8), mat));
        const barrelGeo = new THREE.CylinderGeometry(1.2, 1.4, 16, 6); barrelGeo.rotateX(Math.PI / 2); barrelGeo.translate(0, 0, -9);
        head.add(mesh(barrelGeo, ENEMY_MAT.dark, -2.6, 1, 0), mesh(barrelGeo, ENEMY_MAT.dark, 2.6, 1, 0));
        head.add(mesh(new THREE.BoxGeometry(5, 1.4, 1), new THREE.MeshBasicMaterial({ color: 0xff5a3a }), 0, 3.5, -5));
        // 面の向きに合わせて立てる
        const up = new THREE.Vector3(p.face.x, p.face.y, p.face.z);
        pg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
        head.position.y = 4;
        pg.add(base, head);
        pg.userData.head = head;
      } else if (p.kind === 'engine') {
        const geo = new THREE.CylinderGeometry(15, 17, 14, 16); geo.rotateZ(Math.PI / 2);
        pg.add(mesh(geo, mat));
        const core = mesh(new THREE.CircleGeometry(12, 20), new THREE.MeshBasicMaterial({ color: 0xff5040 }), 7.2, 0, 0);
        core.rotation.y = Math.PI / 2;
        pg.add(core);
        const gl = glowSprite(0xff3a30, 70, 0.8); gl.position.x = 14;
        pg.add(gl);
        pg.userData.glow = gl; pg.userData.disc = core;
      } else {
        const core = mesh(new THREE.IcosahedronGeometry(13, 1), new THREE.MeshPhongMaterial({ color: 0xff3050, emissive: 0x801020, shininess: 90, flatShading: true }));
        pg.add(core);
        const gl = glowSprite(0xff3a5a, 80, 0.9);
        pg.add(gl);
        pg.userData.glow = gl; pg.userData.coreMesh = core;
        pg.visible = false;
      }
      pg.userData.mat = mat;
      pg.userData.kind = p.kind;
      group.add(pg);
      parts.push(pg);
    });

    // 主砲: チャージの光・射線の予告・光線
    const charge = glowSprite(0xff3a2a, 10, 0);
    charge.position.set(cn.x - 6, cn.y, cn.z);
    group.add(charge);
    const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true); beamGeo.rotateX(Math.PI / 2); beamGeo.translate(0, 0, 0.5);
    const beamOuter = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0xff3a2a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    const beamCore = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0xffe0c0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    const guide = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0xff2020, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    [beamOuter, beamCore, guide].forEach(function (m) { m.frustumCulled = false; scene.add(m); m.visible = false; });

    // 左右の船体の後ろの噴射 (赤)。上下 2 段ずつ。弱点のエンジン (部位) とは別の飾り
    const thrusters = [];
    [-75, 75].forEach(function (z) {
      [-15, 15].forEach(function (y) {
        const t = glowSprite(0xff3a30, 42, 0.6);
        t.position.set(300, y, z);
        group.add(t);
        thrusters.push(t);
      });
    });
    group.userData = { topRing: topRing, topGlow: topGlow, sideRings: sideRings, parts: parts, armor: armor, charge: charge, beamOuter: beamOuter, beamCore: beamCore, guide: guide, thrusters: thrusters, hull: hullMesh };
    return group;
  }

  // ------------------------------------------------------------ 木星要塞
  //
  // core.js の C.FORTRESS (立体の表) から作る。輪・軸・支柱・台座・主砲の砲身は、当たり判定と同じ立体 (prismGeo)。
  // 中央の球は、六角の装甲板を重ねた見た目 (当たり判定は外接する多面体で、板より外側)。
  // 色は木星の縞: 青銅・暗い銅・炭の灰・くすんだ琥珀。

  const FORT_TINT = {
    bronze: [0.58, 0.40, 0.23], copper: [0.44, 0.25, 0.17], charcoal: [0.26, 0.26, 0.30], amber: [0.64, 0.48, 0.22],
    pin: [0.40, 0.40, 0.44], mount: [0.38, 0.35, 0.34], housing: [0.48, 0.33, 0.24], shield: [0.8, 0.8, 0.85], sphere: [0.5, 0.36, 0.2]
  };
  const FORT_BANDS = ['bronze', 'copper', 'charcoal', 'amber', 'bronze', 'charcoal', 'copper', 'amber', 'bronze', 'charcoal', 'copper'];
  let fortMat = null;

  /** 大赤斑のような赤い嵐の渦 (主砲の砲口に貼る絵)。 */
  function makeStormTexture() {
    const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
    const x = c.getContext('2d'), R = S / 2;
    const bg = x.createRadialGradient(R, R, 0, R, R, R);
    bg.addColorStop(0, '#ffe9c4'); bg.addColorStop(0.18, '#ff9a3c'); bg.addColorStop(0.55, '#c2200f'); bg.addColorStop(1, '#3a0505');
    x.fillStyle = bg; x.fillRect(0, 0, S, S);
    const rng = C.mulberry32(42);
    for (let arm = 0; arm < 3; arm++) {
      for (let i = 0; i < 2200; i++) {
        const t = rng(), r = 8 + t * (R - 14), a = arm * 2.094 + t * 7.5 + (rng() - 0.5) * 0.32;
        const px = R + Math.cos(a) * r, py = R + Math.sin(a) * r;
        const hot = rng() < 0.5;
        x.fillStyle = hot ? 'rgba(255,190,110,' + (0.10 + 0.22 * (1 - t)) + ')' : 'rgba(60,5,5,' + (0.10 + 0.25 * t) + ')';
        x.beginPath(); x.arc(px, py, 1.2 + rng() * 3.4 * (0.4 + t), 0, 6.283); x.fill();
      }
    }
    const rim = x.createRadialGradient(R, R, R * 0.8, R, R, R);
    rim.addColorStop(0, 'rgba(0,0,0,0)'); rim.addColorStop(1, 'rgba(10,0,0,0.85)');
    x.fillStyle = rim; x.fillRect(0, 0, S, S);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  }
  /** 光の盾の六角の網目。 */
  function makeShieldTexture() {
    const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
    const x = c.getContext('2d');
    x.strokeStyle = 'rgba(255,170,110,0.9)'; x.lineWidth = 2.5;
    const r = 26, h = r * Math.sqrt(3) / 2;
    for (let row = -1; row < S / h + 1; row++) {
      for (let col = -1; col < S / (r * 1.5) + 1; col++) {
        const cx = col * r * 1.5, cy = row * h * 2 + (col % 2 ? h : 0);
        x.beginPath();
        for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; x.lineTo(cx + r * 0.94 * Math.cos(a), cy + r * 0.94 * Math.sin(a)); }
        x.closePath(); x.stroke();
        x.fillStyle = 'rgba(255,120,70,0.07)'; x.fill();
      }
    }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /** 球の六角の装甲板 (頂点のまわりの三角形の重心を結んだ多角形)。縞の色で塗り、緯度によって厚みを変える */
  function addSpherePlates(out, rng) {
    const F = C.FORTRESS, RS = F.RS, V = F.ico.verts, Fc = F.ico.faces;
    const vf = V.map(function () { return []; });
    Fc.forEach(function (f, fi) { f.forEach(function (vi) { vf[vi].push(fi); }); });
    const cent = Fc.map(function (f) {
      const x = V[f[0]][0] + V[f[1]][0] + V[f[2]][0], y = V[f[0]][1] + V[f[1]][1] + V[f[2]][1], z = V[f[0]][2] + V[f[1]][2] + V[f[2]][2];
      const l = Math.hypot(x, y, z); return [x / l, y / l, z / l];
    });
    const cross3 = function (a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; };
    const dot3 = function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
    const nrm3 = function (a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const push = function (a, b, c, n, col) {
      // 表向きを法線にそろえる
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      if (dot3(cross3(e1, e2), n) < 0) { const t = b; b = c; c = t; }
      [a, b, c].forEach(function (v) {
        out.pos.push(v[0], v[1], v[2]); out.nor.push(n[0], n[1], n[2]); out.col.push(col[0], col[1], col[2]);
        // 絵: 法線のいちばん大きい軸を落として、残り 2 軸 / HULL_TILE
        const ax = Math.abs(n[0]) > Math.abs(n[1]) ? (Math.abs(n[0]) > Math.abs(n[2]) ? 0 : 2) : (Math.abs(n[1]) > Math.abs(n[2]) ? 1 : 2);
        const u = ax === 0 ? v[1] : v[0], w = ax === 2 ? v[1] : v[2];
        out.uv.push(u / HULL_TILE, w / HULL_TILE);
      });
    };
    V.forEach(function (n, vi) {
      const u = nrm3(cross3(Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], n)), w = cross3(n, u);
      const ring = vf[vi].map(function (fi) { return cent[fi]; }).sort(function (p, q) { return Math.atan2(dot3(p, w), dot3(p, u)) - Math.atan2(dot3(q, w), dot3(q, u)); });
      const lat = n[1];
      const band = FORT_BANDS[Math.max(0, Math.min(FORT_BANDS.length - 1, Math.floor((lat * 0.5 + 0.5) * FORT_BANDS.length + (rng() - 0.5) * 0.7)))];
      const tint = FORT_TINT[band], bright = 0.82 + rng() * 0.32;
      const belt = Math.abs(Math.abs(lat) - 0.18) < 0.07;           // 2 本の盛り上がった帯
      const h = belt ? 7 : 3 + rng() * 1.5;
      const baseR = RS - 1, topR = RS + h, shrink = 0.86;
      const base = ring.map(function (c) { return [c[0] * baseR, c[1] * baseR, c[2] * baseR]; });
      const ctr = [n[0] * topR, n[1] * topR, n[2] * topR];
      const top = ring.map(function (c) { return [ctr[0] + (c[0] * topR - ctr[0]) * shrink, ctr[1] + (c[1] * topR - ctr[1]) * shrink, ctr[2] + (c[2] * topR - ctr[2]) * shrink]; });
      const topCol = [tint[0] * bright, tint[1] * bright, tint[2] * bright], sideCol = [topCol[0] * 0.55, topCol[1] * 0.55, topCol[2] * 0.55];
      for (let i = 1; i < top.length - 1; i++) push(top[0], top[i], top[i + 1], n, topCol);
      for (let i = 0; i < top.length; i++) {
        const j = (i + 1) % top.length;
        const mid = [(base[i][0] + base[j][0] + top[i][0] + top[j][0]) / 4, (base[i][1] + base[j][1] + top[i][1] + top[j][1]) / 4, (base[i][2] + base[j][2] + top[i][2] + top[j][2]) / 4];
        const sn = nrm3(cross3([base[j][0] - base[i][0], base[j][1] - base[i][1], base[j][2] - base[i][2]], [top[i][0] - base[i][0], top[i][1] - base[i][1], top[i][2] - base[i][2]]));
        const nn = dot3(sn, mid) < 0 ? [-sn[0], -sn[1], -sn[2]] : sn;
        push(base[i], base[j], top[j], nn, sideCol); push(base[i], top[j], top[i], nn, sideCol);
      }
    });
  }

  function makeFortressModel() {
    const F = C.FORTRESS;
    if (!fortMat) {
      fortMat = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 40, specular: 0x302a24, flatShading: true, emissive: 0x100a06 });
    }
    fortMat.map = hullMat.map;                // 装甲の絵は読み込みが遅れることがあるので、使うたびに合わせる
    const group = new THREE.Group();
    const rng = C.mulberry32(777);
    const hull = { pos: [], nor: [], col: [], uv: [] };       // 当たり判定と同じ立体
    const deco = { pos: [], nor: [], col: [], uv: [] };       // 判定には入れない飾り (板・球の装甲)
    const lights = { pos: [], nor: [], col: [] };
    const mm = function (sd, x, y, z) {                        // 立体の局所の点 → 要塞の座標
      const M = sd.m;
      const o = M ? [M[0] * x + M[1] * y + M[2] * z, M[3] * x + M[4] * y + M[5] * z, M[6] * x + M[7] * y + M[8] * z] : [x, y, z];
      return sd.at ? [o[0] + sd.at[0], o[1] + sd.at[1], o[2] + sd.at[2]] : o;
    };
    const light = function (p, size, c) {
      const g = new THREE.BoxGeometry(size, size * 0.6, size).toNonIndexed();
      g.translate(p[0], p[1], p[2]);
      const P = g.attributes.position.array, N = g.attributes.normal.array;
      for (let i = 0; i < P.length; i += 3) { lights.pos.push(P[i], P[i + 1], P[i + 2]); lights.nor.push(N[i], N[i + 1], N[i + 2]); lights.col.push(c[0], c[1], c[2]); }
      g.dispose();
    };

    // ① 当たり判定と同じ立体 (輪の扇・軸・支柱・台座・砲身)。球と盾は別に作る
    F.solids.forEach(function (sd) {
      if (sd.sphere || sd.armor) return;
      const t = FORT_TINT[sd.tint] || FORT_TINT.pin;
      const k = 0.85 + rng() * 0.3;
      prismGeo(sd, [t[0] * k, t[1] * k, t[2] * k], hull);
      // 輪の扇の上面・下面に、六角の装甲板 (低い板を 2 枚) と、ふちの明かり
      if (sd.ring) {
        const R = F.rings[sd.ring], idx = parseInt(sd.name.slice(5), 10);
        const a0 = (idx + 0.04) * 2 * Math.PI / R.n, a1 = (idx + 0.96) * 2 * Math.PI / R.n, am = (a0 + a1) / 2;
        const rm = (R.r0 + R.r1) / 2, wR = (R.r1 - R.r0) * 0.7;
        [1, -1].forEach(function (side) {
          for (let j = 0; j < 2; j++) {
            const rr = rm + (j - 0.5) * wR * 0.55, aa = am + (j - 0.5) * (a1 - a0) * 0.2;
            const cx = rr * Math.cos(aa), cz = rr * Math.sin(aa), r = (R.r1 - R.r0) * 0.3;
            const hexP = []; for (let q = 0; q < 6; q++) hexP.push([cx + r * Math.cos(q * Math.PI / 3), cz + r * Math.sin(q * Math.PI / 3)]);
            const top = side > 0 ? R.up[idx] : -R.down[idx];
            const plate = side > 0 ? { poly: hexP, y0: top, y1: top + 2.2 } : { poly: hexP, y0: top - 2.2, y1: top };
            plate.m = sd.m; plate.at = sd.at;
            prismGeo(plate, [t[0] * (0.9 + rng() * 0.25), t[1] * (0.9 + rng() * 0.25), t[2] * (0.9 + rng() * 0.25)], deco);
          }
          if (rng() < 0.7) light(mm(sd, R.r1 * Math.cos(am) - Math.cos(am) * 0.4, side > 0 ? R.up[idx] + 0.4 : -R.down[idx] - 0.4, R.r1 * Math.sin(am) - Math.sin(am) * 0.4), 1.6, rng() < 0.3 ? [1, 0.75, 0.4] : [1, 0.2, 0.14]);
        });
      }
    });
    // ② 球の六角の装甲板 + 土台の球
    addSpherePlates(deco, rng);
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(F.RS - 3, 2), new THREE.MeshPhongMaterial({ color: 0x1b1814, shininess: 20, flatShading: true }));
    group.add(core);
    const hullMesh = new THREE.Mesh(geoFrom(hull), fortMat);
    const decoMesh = new THREE.Mesh(geoFrom(deco), fortMat);
    const lightMesh = new THREE.Mesh(geoFrom(lights), new THREE.MeshBasicMaterial({ vertexColors: true }));
    group.add(hullMesh, decoMesh, lightMesh);

    // ③ 主砲: 前 (-x) の砲口に赤い嵐の渦。ふちの輪と、渦の前の光の盾 (六角の網目の浅いドーム)
    const darkMat = new THREE.MeshPhongMaterial({ color: 0x3a3631, shininess: 55, flatShading: true });
    const glowRed = new THREE.MeshBasicMaterial({ color: 0xff3a1a });
    const faceX = -178;                                               // 砲身の前の面 (core.js の cannon の y1)
    const rimGeo = new THREE.TorusGeometry(66, 5, 8, 36); rimGeo.rotateY(Math.PI / 2);
    const rimGlow = new THREE.TorusGeometry(58, 2.2, 6, 36); rimGlow.rotateY(Math.PI / 2);
    group.add(mesh(rimGeo, darkMat, faceX, 0, 0), mesh(rimGlow, glowRed, faceX - 0.5, 0, 0));
    for (let i = 0; i < 8; i++) {                                     // 砲口の八方の支え
      const a = i * Math.PI / 4;
      const fin = mesh(new THREE.BoxGeometry(16, 7, 14), darkMat, faceX - 3, Math.cos(a) * 66, Math.sin(a) * 66);
      fin.rotation.x = -a; group.add(fin);
    }
    const storm = new THREE.Group(); storm.position.set(faceX - 1, 0, 0); storm.rotation.y = -Math.PI / 2;
    const stormDisc = new THREE.Mesh(new THREE.CircleGeometry(57, 40), new THREE.MeshBasicMaterial({ map: makeStormTexture() }));
    storm.add(stormDisc); group.add(storm);
    const stormGlow = glowSprite(0xff3a1a, 190, 0.6); stormGlow.position.set(faceX - 6, 0, 0); group.add(stormGlow);

    const shieldGroup = new THREE.Group(); shieldGroup.position.set(-206, 0, 0);
    const domeGeo = new THREE.SphereGeometry(66, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2); domeGeo.scale(1, 0.2, 1); domeGeo.rotateZ(Math.PI / 2);
    const shieldTex = makeShieldTexture(); shieldTex.repeat.set(3, 1.5);
    const dome = new THREE.Mesh(domeGeo, new THREE.MeshBasicMaterial({ map: shieldTex, color: 0xff9a60, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    const slab = new THREE.Mesh(new THREE.CylinderGeometry(66, 66, 10, 12), new THREE.MeshBasicMaterial({ color: 0xff8050, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }));
    slab.rotation.z = Math.PI / 2; slab.position.x = -5;
    shieldGroup.add(dome, slab); group.add(shieldGroup);

    // ④ 部位: 砲塔 (太く大きい)・動力の節 (赤熱する輪の節)・コア
    const parts = [];
    const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);
    F.parts.forEach(function (p) {
      const pg = new THREE.Group();
      pg.position.set(p.at.x, p.at.y, p.at.z);
      const mat = new THREE.MeshPhongMaterial({ color: 0x625c56, shininess: 55, emissive: 0x000000 });
      const face = new THREE.Vector3(p.face.x, p.face.y, p.face.z);
      if (p.kind === 'turret') pg.scale.setScalar(1.45);
      if (p.kind === 'turret') {
        const base = mesh(new THREE.CylinderGeometry(11, 13.5, 7, 12), mat);
        const head = new THREE.Group();
        head.add(mesh(new THREE.SphereGeometry(10, 14, 10), mat));
        const barrelGeo = new THREE.CylinderGeometry(1.7, 2, 24, 8); barrelGeo.rotateX(Math.PI / 2); barrelGeo.translate(0, 0, -13);
        head.add(mesh(barrelGeo, ENEMY_MAT.dark, -3.6, 1, 0), mesh(barrelGeo, ENEMY_MAT.dark, 3.6, 1, 0));
        head.add(mesh(new THREE.BoxGeometry(7, 2, 1.4), new THREE.MeshBasicMaterial({ color: 0xff5a3a }), 0, 4.6, -7));
        pg.quaternion.setFromUnitVectors(Y, face);
        head.position.y = 5;
        pg.add(base, head);
        pg.userData.head = head;
      } else if (p.kind === 'engine') {
        const geo = new THREE.CylinderGeometry(15, 18, 14, 6); geo.rotateZ(Math.PI / 2);
        pg.add(mesh(geo, mat));
        const disc = mesh(new THREE.CircleGeometry(12.5, 6), new THREE.MeshBasicMaterial({ color: 0xff5040 }), 7.3, 0, 0);
        disc.rotation.y = Math.PI / 2;
        pg.add(disc);
        const gl = glowSprite(0xff3a30, 80, 0.8); gl.position.x = 14;
        pg.add(gl);
        pg.quaternion.setFromUnitVectors(X, face);
        pg.userData.glow = gl; pg.userData.disc = disc;
      } else {
        const cm = mesh(new THREE.IcosahedronGeometry(14, 1), new THREE.MeshPhongMaterial({ color: 0xff3050, emissive: 0x801020, shininess: 90, flatShading: true }));
        pg.add(cm);
        const gl = glowSprite(0xff3a5a, 80, 0.9);
        pg.add(gl);
        pg.userData.glow = gl; pg.userData.coreMesh = cm;
      }
      pg.userData.mat = mat; pg.userData.kind = p.kind;
      group.add(pg); parts.push(pg);
    });

    // ⑤ 主砲: チャージの光・射線の予告・光線 (戦艦と同じ作り。場面に直接置く)
    const charge = glowSprite(0xff3a2a, 10, 0);
    charge.position.set(F.cannon.x - 6, F.cannon.y, F.cannon.z);
    group.add(charge);
    const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true); beamGeo.rotateX(Math.PI / 2); beamGeo.translate(0, 0, 0.5);
    const beamOuter = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0xff3a2a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    const beamCore = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0xffe0c0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    const guide = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0xff2020, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    [beamOuter, beamCore, guide].forEach(function (m) { m.frustumCulled = false; scene.add(m); m.visible = false; });

    group.userData = { type: 'fortress', topRing: null, topGlow: stormGlow, sideRings: [], parts: parts, armor: shieldGroup, charge: charge, beamOuter: beamOuter, beamCore: beamCore, guide: guide, thrusters: [], hull: hullMesh, storm: storm, stormDisc: stormDisc, dome: dome };
    return group;
  }

  // ------------------------------------------------------------ 火星の採掘母艦 (3 面のボス)
  //
  // core.js の C.DRILLER (立体の表) から作る。船体・軌道・タンク・塔は当たり判定と同じ立体 (prismGeo)。
  // ドリルだけは、段々の当たりの代わりに滑らかな円すい + らせんの刃で見せ、ゆっくり回す。
  // 色は火星: 錆びた赤茶・黒鉄・酸化した橙。光は白熱の橙。

  const DRILL_TINT = {
    rust: [0.98, 0.42, 0.22], iron: [0.42, 0.38, 0.37], tank: [1.0, 0.62, 0.30], tower: [0.88, 0.36, 0.19],
    bridge: [0.52, 0.45, 0.42], collar: [1.0, 0.66, 0.32], drill: [0.7, 0.66, 0.62]
  };
  let drillMat = null;

  function makeDrillerModel() {
    const D = C.DRILLER, DS = D.DS;
    if (!drillMat) {
      // 日の当たらない側も錆びた赤茶が見えるよう、装甲の絵を少しだけ自ら光らせる (ゲームの中では横腹が影になりやすい)
      drillMat = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 28, specular: 0x3a2a20, flatShading: true, emissive: 0xc0502a });
    }
    drillMat.map = hullMat.map;               // 装甲の絵は読み込みが遅れることがあるので、使うたびに合わせる
    drillMat.emissiveMap = hullMat.map;
    const group = new THREE.Group();
    const rng = C.mulberry32(3030);
    const hull = { pos: [], nor: [], col: [], uv: [] };
    const lights = { pos: [], nor: [], col: [] };
    const tint = function (name, k) { const t = DRILL_TINT[name] || DRILL_TINT.iron; return [t[0] * k, t[1] * k, t[2] * k]; };
    const light = function (x, y, z, size, c) {
      const g = new THREE.BoxGeometry(size, size * 0.6, size).toNonIndexed();
      g.translate(x, y, z);
      const P = g.attributes.position.array, N = g.attributes.normal.array;
      for (let i = 0; i < P.length; i += 3) { lights.pos.push(P[i], P[i + 1], P[i + 2]); lights.nor.push(N[i], N[i + 1], N[i + 2]); lights.col.push(c[0], c[1], c[2]); }
      g.dispose();
    };
    const HOT = [1, 0.55, 0.22], WHITE = [1, 0.85, 0.6];

    // ① 当たり判定と同じ立体 (ドリルの段々と装甲は別に作る)
    D.solids.forEach(function (sd) {
      if (sd.drill || sd.armor) return;
      prismGeo(sd, tint(sd.tint, 0.88 + rng() * 0.24), hull);
    });
    // 船体の上に細かい凸凹 (判定には入れない)。甲板の y・前後の範囲は船体の形から
    const deckY = 32 * DS;
    for (let i = 0; i < 90; i++) {
      const x = (-110 + rng() * 360) * DS, z = (rng() * 2 - 1) * 64 * DS;
      if (x > 45 * DS && x < 165 * DS && Math.abs(z) < 47 * DS) continue;          // 塔の足もと
      if (x < 0 && x > -105 * DS && Math.abs(z) > 14 * DS && Math.abs(z) < 66 * DS) continue;   // タンクの足もと
      const sx = (4 + rng() * 16) * DS, sz = (3 + rng() * 12) * DS, h = (1 + rng() * 4) * DS;
      prismGeo({ poly: [[x - sx / 2, z - sz / 2], [x + sx / 2, z - sz / 2], [x + sx / 2, z + sz / 2], [x - sx / 2, z + sz / 2]], y0: deckY, y1: deckY + h }, tint(rng() < 0.5 ? 'rust' : 'iron', 0.8 + rng() * 0.3), hull);
      if (rng() < 0.25) light(x, deckY + h + 0.4, z, 1.6, HOT);
    }
    // 横腹の明かりの列・軌道の車輪の並び
    [-1, 1].forEach(function (sz) {
      for (let i = 0; i < 46; i++) {
        if (rng() < 0.45) continue;
        const x = (-110 + i * 8) * DS, y = (-30 + rng() * 50) * DS;
        light(x, y, sz * (72 * DS + 0.6), 1.6, rng() < 0.3 ? WHITE : HOT);
      }
      for (let i = 0; i < 9; i++) {
        const w = new THREE.CylinderGeometry(15 * DS, 15 * DS, 6, 14); w.rotateX(Math.PI / 2);
        group.add(mesh(w, new THREE.MeshPhongMaterial({ color: 0x2a2624, shininess: 30, flatShading: true }), (-70 + i * 36) * DS, -59 * DS, sz * 99 * DS));
      }
    });
    // 塔の窓 (橙の帯) と、艦橋のまわりの白い明かり
    [-1, 1].forEach(function (sz) {
      for (let r = 0; r < 4; r++) for (let c = 0; c < 9; c++) {
        if (rng() < 0.3) continue;
        light((66 + c * 10) * DS, (130 + r * 18) * DS, sz * (32 * DS + 0.6), 2, rng() < 0.2 ? WHITE : HOT);
      }
      for (let c = 0; c < 12; c++) light((60 + c * 8) * DS, 213 * DS, sz * (52 * DS + 0.6), 1.8, WHITE);
    });
    const hullMesh = new THREE.Mesh(geoFrom(hull), drillMat);
    const lightMesh = new THREE.Mesh(geoFrom(lights), new THREE.MeshBasicMaterial({ vertexColors: true }));
    group.add(hullMesh, lightMesh);

    // ② ドリル: 円すい + らせんの刃 + 白熱の先端。軸のまわりにゆっくり回す
    const dr = D.drill, dLen = dr.x1 - dr.x0;
    const drill = new THREE.Group();
    drill.position.set(-dr.x0, 0, 0);
    const steel = new THREE.MeshPhongMaterial({ color: 0xa08c80, shininess: 70, specular: 0x6a5040, flatShading: true, emissive: 0x2a1c16 });
    const dark = new THREE.MeshPhongMaterial({ color: 0x5a4a44, shininess: 40, flatShading: true });
    const cone = new THREE.ConeGeometry(dr.r, dLen, 24, 1); cone.rotateZ(Math.PI / 2); cone.translate(-dLen / 2, 0, 0);
    drill.add(new THREE.Mesh(cone, steel));
    // らせんの刃: 円すいの表面をなぞる帯 (3 本)
    for (let k = 0; k < 3; k++) {
      const pts = [];
      for (let i = 0; i <= 60; i++) {
        const t = i / 60, r = dr.r * (1 - t) + 2, a = k * 2.094 + t * 11;
        pts.push(new THREE.Vector3(-t * dLen, Math.cos(a) * r, Math.sin(a) * r));
      }
      drill.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 120, 5.5 * DS, 5, false), dark));
    }
    const tip = mesh(new THREE.SphereGeometry(6 * DS, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffb060 }), -dLen + 4, 0, 0);
    drill.add(tip);
    // 付け根の太い輪 (回る)
    const base = new THREE.TorusGeometry(dr.r - 2, 7 * DS, 8, 28); base.rotateY(Math.PI / 2);
    drill.add(mesh(base, dark, -2, 0, 0));
    group.add(drill);
    // 軸のまわりの白熱した継ぎ目
    const seam = new THREE.TorusGeometry(31 * DS, 2.4 * DS, 6, 24); seam.rotateY(Math.PI / 2);
    group.add(mesh(seam, new THREE.MeshBasicMaterial({ color: 0xff8a30 }), -116 * DS, 0, 0));

    // ③ 装甲の輪 (動力炉を包む)。外れたら消す
    const collarSd = D.solids.filter(function (sd) { return sd.armor; })[0];
    const collarGeo = { pos: [], nor: [], col: [], uv: [] };
    prismGeo(collarSd, tint('collar', 1), collarGeo);
    // 輪の表に、白熱の溝を 3 本
    const armor = new THREE.Group();
    armor.add(new THREE.Mesh(geoFrom(collarGeo), drillMat));
    [0.25, 0.5, 0.75].forEach(function (f) {
      const g = new THREE.TorusGeometry(84 * DS + 1, 1.6 * DS, 6, 32); g.rotateY(Math.PI / 2);
      armor.add(mesh(g, new THREE.MeshBasicMaterial({ color: 0xff7a2a }), -(118 + 54 * f) * DS, 0, 0));
    });
    group.add(armor);
    const coreGlow = glowSprite(0xff7a2a, 170 * DS, 0.5);
    coreGlow.position.set(-145 * DS, 50 * DS, 0);
    group.add(coreGlow);

    // ④ 艦橋の上のアンテナと、艦尾の排気 (橙)
    const mast = new THREE.CylinderGeometry(0.8, 1.2, 40 * DS, 5);
    group.add(mesh(mast, dark, 80 * DS, 246 * DS, -30 * DS), mesh(mast, dark, 130 * DS, 240 * DS, 30 * DS));
    const thrusters = [];
    [-40, 40].forEach(function (z) {
      [-30, 5].forEach(function (y) {
        const t = glowSprite(0xff7a30, 60 * DS, 0.6);
        t.position.set(287 * DS, y * DS, z * DS);
        group.add(t); thrusters.push(t);
      });
    });

    // ⑤ 部位: 砲台 (戦艦と同じ作りを大きく)・鉱石タンクのふた (弱点)・動力炉 (コア)
    const parts = [];
    const Y = new THREE.Vector3(0, 1, 0);
    D.parts.forEach(function (p) {
      const pg = new THREE.Group();
      pg.position.set(p.at.x, p.at.y, p.at.z);
      const mat = new THREE.MeshPhongMaterial({ color: 0x6a5a52, shininess: 50, emissive: 0x000000 });
      if (p.kind === 'turret') {
        pg.scale.setScalar(DS);
        const base = mesh(new THREE.CylinderGeometry(9, 11, 7, 10), mat);
        const head = new THREE.Group();
        head.add(mesh(new THREE.SphereGeometry(7.5, 12, 8), mat));
        const barrelGeo = new THREE.CylinderGeometry(1.2, 1.4, 16, 6); barrelGeo.rotateX(Math.PI / 2); barrelGeo.translate(0, 0, -9);
        head.add(mesh(barrelGeo, ENEMY_MAT.dark, -2.6, 1, 0), mesh(barrelGeo, ENEMY_MAT.dark, 2.6, 1, 0));
        head.add(mesh(new THREE.BoxGeometry(5, 1.4, 1), new THREE.MeshBasicMaterial({ color: 0xff8a3a }), 0, 3.5, -5));
        pg.quaternion.setFromUnitVectors(Y, new THREE.Vector3(p.face.x, p.face.y, p.face.z));
        head.position.y = 4;
        pg.add(base, head);
        pg.userData.head = head;
      } else if (p.kind === 'engine') {
        // 鉱石タンクのふた: 半球の窓。中の鉱石が橙に光る
        const dome = new THREE.SphereGeometry(16 * DS, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
        const disc = mesh(dome, new THREE.MeshBasicMaterial({ color: 0x7a3a1a }), 0, -8 * DS, 0);
        pg.add(disc);
        const rim = new THREE.TorusGeometry(19 * DS, 2.4 * DS, 6, 20); rim.rotateX(Math.PI / 2);
        pg.add(mesh(rim, mat, 0, -8 * DS, 0));
        const gl = glowSprite(0xff7a30, 70 * DS, 0.5); gl.position.y = 4 * DS;
        pg.add(gl);
        pg.userData.glow = gl; pg.userData.disc = disc;
      } else {
        const cm = mesh(new THREE.IcosahedronGeometry(14 * DS, 1), new THREE.MeshPhongMaterial({ color: 0xff8a30, emissive: 0x803010, shininess: 90, flatShading: true }));
        pg.add(cm);
        const gl = glowSprite(0xff8a3a, 90 * DS, 0.9);
        pg.add(gl);
        pg.userData.glow = gl; pg.userData.coreMesh = cm;
        pg.visible = false;
      }
      pg.userData.mat = mat; pg.userData.kind = p.kind;
      group.add(pg); parts.push(pg);
    });

    // ⑥ 主砲 (ドリルの先): チャージの光・射線の予告・光線
    const charge = glowSprite(0xff8a3a, 10, 0);
    charge.position.set(D.cannon.x - 6, D.cannon.y, D.cannon.z);
    group.add(charge);
    const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true); beamGeo.rotateX(Math.PI / 2); beamGeo.translate(0, 0, 0.5);
    const beamOuter = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0xff6a2a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    const beamCore = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0xffe8c8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    const guide = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0xff5020, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    [beamOuter, beamCore, guide].forEach(function (m) { m.frustumCulled = false; scene.add(m); m.visible = false; });

    group.userData = { type: 'driller', topRing: null, topGlow: coreGlow, sideRings: [], parts: parts, armor: armor, charge: charge, beamOuter: beamOuter, beamCore: beamCore, guide: guide, thrusters: thrusters, hull: hullMesh, drill: drill };
    return group;
  }

  // ------------------------------------------------------------ 弾 (まとめて1回で描く)

  function makeBoltPool(max, color, w, length) {
    const geo = new THREE.BoxGeometry(w, w, 1);
    geo.translate(0, 0, -0.5);
    const matl = new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const inst = new THREE.InstancedMesh(geo, matl, max);
    inst.frustumCulled = false;
    inst.count = 0;
    scene.add(inst);
    return { inst: inst, max: max, length: length };
  }
  const playerBolts = makeBoltPool(160, 0x7fe6ff, 0.55, 18);
  const playerBoltsGlow = makeBoltPool(160, 0x2a7dff, 1.6, 22);
  const enemyBolts = makeBoltPool(200, 0xff6a50, 0.6, 12);
  const enemyBoltsGlow = makeBoltPool(200, 0xff2010, 1.5, 14);

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _f = new THREE.Vector3(0, 0, -1), _d = new THREE.Vector3();
  function drawBolts(shots, owner, pool, glowPool) {
    let n = 0;
    for (let i = 0; i < shots.length && n < pool.max; i++) {
      const s = shots[i];
      if (s.owner !== owner) continue;
      _d.set(s.vel.x, s.vel.y, s.vel.z).normalize();
      _q.setFromUnitVectors(_f, _d);
      _p.set(s.pos.x, s.pos.y, s.pos.z);
      // 撃った直後は短く (銃口から伸びるように)
      const age = (owner === 'player' ? K.laserLife : 99) - s.life;
      const L = Math.min(pool.length, 6 + age * 400);
      _s.set(1, 1, L);
      _m.compose(_p, _q, _s);
      pool.inst.setMatrixAt(n, _m);
      _s.set(1, 1, L * 1.1);
      _m.compose(_p, _q, _s);
      glowPool.inst.setMatrixAt(n, _m);
      n++;
    }
    pool.inst.count = n; glowPool.inst.count = n;
    pool.inst.instanceMatrix.needsUpdate = true;
    glowPool.inst.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------ 粒 (爆発・火花・煙)

  const PART_MAX = 2400;
  const particles = (function () {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(PART_MAX * 3), col = new Float32Array(PART_MAX * 3), size = new Float32Array(PART_MAX), alpha = new Float32Array(PART_MAX);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { tex: { value: glowTex }, scale: { value: 400 } },
      vertexShader: 'attribute float size; attribute float alpha; attribute vec3 color; varying vec3 vC; varying float vA;' +
        'uniform float scale; void main(){ vC = color; vA = alpha; vec4 mv = modelViewMatrix*vec4(position,1.0);' +
        'gl_PointSize = min(size*scale/max(-mv.z,0.1), 400.0); gl_Position = projectionMatrix*mv; }',
      fragmentShader: 'uniform sampler2D tex; varying vec3 vC; varying float vA;' +
        'void main(){ vec4 t = texture2D(tex, gl_PointCoord); gl_FragColor = vec4(vC*t.r*vA, t.r*vA); }',
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);
    const list = [];
    for (let i = 0; i < PART_MAX; i++) list.push({ on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, s0: 1, s1: 1, r: 1, g: 1, b: 1, r1: 1, g1: 1, b1: 1, drag: 0 });
    return { geo: geo, pos: pos, col: col, size: size, alpha: alpha, list: list, mat: mat, next: 0 };
  })();

  function spawnParticle(x, y, z, vx, vy, vz, life, s0, s1, c0, c1, drag) {
    const L = particles.list;
    for (let k = 0; k < PART_MAX; k++) {
      const i = (particles.next + k) % PART_MAX;
      if (!L[i].on) {
        const p = L[i];
        p.on = true; p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz;
        p.life = life; p.max = life; p.s0 = s0; p.s1 = s1;
        p.r = c0[0]; p.g = c0[1]; p.b = c0[2]; p.r1 = c1[0]; p.g1 = c1[1]; p.b1 = c1[2];
        p.drag = drag || 0;
        particles.next = (i + 1) % PART_MAX;
        return;
      }
    }
  }

  function updateParticles(dt) {
    const L = particles.list;
    let n = 0;
    for (let i = 0; i < PART_MAX; i++) {
      const p = L[i];
      if (!p.on) continue;
      p.life -= dt;
      if (p.life <= 0) { p.on = false; continue; }
      const dr = Math.exp(-p.drag * dt);
      p.vx *= dr; p.vy *= dr; p.vz *= dr;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const k = 1 - p.life / p.max;
      particles.pos[n * 3] = p.x; particles.pos[n * 3 + 1] = p.y; particles.pos[n * 3 + 2] = p.z;
      particles.col[n * 3] = p.r + (p.r1 - p.r) * k;
      particles.col[n * 3 + 1] = p.g + (p.g1 - p.g) * k;
      particles.col[n * 3 + 2] = p.b + (p.b1 - p.b) * k;
      particles.size[n] = p.s0 + (p.s1 - p.s0) * k;
      particles.alpha[n] = Math.min(1, (1 - k) * 1.6);
      n++;
    }
    particles.geo.setDrawRange(0, n);
    ['position', 'color', 'size', 'alpha'].forEach(function (a) { particles.geo.attributes[a].needsUpdate = true; });
    return n;
  }

  const FIRE = [1.0, 0.85, 0.5], EMBER = [0.9, 0.25, 0.05], SPARK = [0.7, 0.9, 1.0];

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function rndDir() {
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    return [r * Math.cos(th), u, r * Math.sin(th)];
  }

  // 一瞬の閃光 (スプライト)
  const flashes = [];
  for (let i = 0; i < 24; i++) {
    const s = glowSprite(0xffc890, 1, 0);
    s.visible = false;
    scene.add(s);
    flashes.push({ s: s, t: 0, max: 1, size: 1 });
  }
  function flash(pos, size, dur, color) {
    let f = flashes[0];
    for (let i = 0; i < flashes.length; i++) if (flashes[i].t <= 0) { f = flashes[i]; break; }
    f.s.position.set(pos.x, pos.y, pos.z);
    f.s.material.color.set(color || 0xffc890);
    f.t = dur; f.max = dur; f.size = size;
    f.s.visible = true;
  }
  function updateFlashes(dt) {
    for (let i = 0; i < flashes.length; i++) {
      const f = flashes[i];
      if (f.t <= 0) continue;
      f.t -= dt;
      if (f.t <= 0) { f.s.visible = false; continue; }
      const k = 1 - f.t / f.max;
      f.s.scale.setScalar(f.size * (0.5 + k * 1.2));
      f.s.material.opacity = (1 - k) * (1 - k);
    }
  }

  /**
   * 爆発。k は見せる大きさの倍率 (粒の数は変えず、大きさと広がりだけ拡げる)。
   * 遠くの撃墜でも画面で小さくなりすぎないよう、撃墜では距離に応じて k を上げる (killBurst)。
   * 宇宙なので煙は出さない: 火の玉・燃えさし・飛び散る光のかけらだけ
   */
  function explosion(pos, size, vel, k) {
    const v = vel || { x: 0, y: 0, z: 0 };
    k = k || 1;
    const n = Math.round(26 * Math.min(size, 6));
    // 火の玉: 大きく明るく始まり、縮みながら消える (膨らむと煙の玉に見える)
    const kk = Math.sqrt(k);
    for (let i = 0; i < n; i++) {
      const d = rndDir(), sp = rnd(10, 46) * size * k;
      spawnParticle(pos.x, pos.y, pos.z, d[0] * sp + v.x * 0.6, d[1] * sp + v.y * 0.6, d[2] * sp + v.z * 0.6,
        rnd(0.25, 0.55) * Math.sqrt(size), 9 * size * kk, 1.5 * size * kk, FIRE, EMBER, 2.2);
    }
    // 飛び散るかけら (速い光の粒)
    for (let i = 0; i < n * 1.2; i++) {
      const d = rndDir(), sp = rnd(60, 160) * Math.sqrt(size) * k;
      spawnParticle(pos.x, pos.y, pos.z, d[0] * sp + v.x, d[1] * sp + v.y, d[2] * sp + v.z,
        rnd(0.3, 0.9), 1.2 * k, 0.4 * k, [1, 0.9, 0.6], [1, 0.3, 0.05], 1.5);
    }
    flash(pos, 30 * size * k, 0.35 + size * 0.05);
    flashLight.position.set(pos.x, pos.y, pos.z);
    flashLight.intensity = Math.max(flashLight.intensity, 40 * size);
    flashLight.distance = 120 * size * k;
  }

  // 衝撃波の輪 (撃墜の瞬間に広がる)。いつもカメラを向く板
  const ringTex = canvasTex(128, 128, function (c, w) {
    const g = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.62, 'rgba(255,255,255,0)');
    g.addColorStop(0.8, 'rgba(255,255,255,1)');
    g.addColorStop(0.9, 'rgba(255,255,255,.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, w);
  });
  // ボスが出てくるワープの光 (敵の色の赤)。カットインの間に開き、艦が出きると閉じる
  const warpGlow = glowSprite(0xff2a30, 1, 0);
  const warpCore = glowSprite(0xffd8d0, 1, 0);
  const warpRing = new THREE.Sprite(new THREE.SpriteMaterial({ map: null, color: 0xff3a40, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
  warpGlow.add(warpCore);
  warpGlow.visible = false;
  scene.add(warpGlow);
  // 光の面より向こう (+x) にある艦の部分は描かない (光の中から出てくるように見せる)
  const bossClip = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1e9);
  function clipBoss(obj) {
    obj.traverse(function (o) {
      if (!o.material) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.clippingPlanes = [bossClip]; });
    });
  }

  warpRing.material.map = ringTex;
  warpGlow.add(warpRing);
  const rings = [];
  for (let i = 0; i < 8; i++) {
    const m = new THREE.SpriteMaterial({ map: ringTex, color: 0xffd8a0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 });
    const sp = new THREE.Sprite(m);
    sp.visible = false;
    scene.add(sp);
    rings.push({ s: sp, t: 0, max: 1, size: 1 });
  }
  function shockRing(pos, size, dur, color) {
    let r = rings[0];
    for (let i = 0; i < rings.length; i++) if (rings[i].t <= 0) { r = rings[i]; break; }
    r.s.material.color.set(color || 0xffd8a0);
    r.s.position.set(pos.x, pos.y, pos.z);
    r.t = dur; r.max = dur; r.size = size;
    r.s.scale.setScalar(size * 0.1);
    r.s.material.opacity = 1;
    r.s.visible = true;
  }
  function updateRings(dt) {
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      if (r.t <= 0) continue;
      r.t -= dt;
      if (r.t <= 0) { r.s.visible = false; continue; }
      const k = 1 - r.t / r.max;
      r.s.scale.setScalar(r.size * (0.1 + 0.9 * (1 - Math.pow(1 - k, 3))));
      r.s.material.opacity = Math.pow(1 - k, 1.5);
    }
  }

  // 撃墜の瞬間: タメ (時を止める) ・白い閃光・衝撃波の輪・大きめの爆発。遠くても画面で小さくなりすぎない
  const KILL = {
    fighter: { stop: 0.06, ring: 40, shake: 0.5 },
    turret: { stop: 0.08, ring: 34, shake: 0.7 },
    engine: { stop: 0.1, ring: 34, shake: 0.9 },
    core: { stop: 0.14, ring: 30, shake: 1.2 }
  };
  const KILL_NEAR = 140; // この距離より遠い撃墜は、見せる大きさを距離に比例して拡げる
  let lastBurst = null;
  function killBurst(e, d) {
    const kd = KILL[e.kind];
    const k = Math.max(1, d / KILL_NEAR);
    explosion(e.pos, e.size, e.vel, k);
    flash(e.pos, 55 * e.size * k, 0.14, 0xffffff);
    shockRing(e.pos, kd.ring * e.size * k, 0.45);
    fx.stopT = Math.max(fx.stopT, kd.stop);
    shake(Math.max(kd.shake, Math.min(1.4, e.size * 60 / Math.max(60, d))));
    audio.kill(game.stats.combo || 1, e.size);
    lastBurst = { kind: e.kind, dist: d, k: k, ring: kd.ring * e.size * k, tAt: game.t, frozen: 0, tFrozen: game.t };
  }

  function sparks(pos, n, color) {
    for (let i = 0; i < n; i++) {
      const d = rndDir(), sp = rnd(30, 120);
      spawnParticle(pos.x, pos.y, pos.z, d[0] * sp, d[1] * sp, d[2] * sp, rnd(0.12, 0.3), 1.6, 0.5, color || SPARK, [0.2, 0.4, 1], 3);
    }
  }

  // ------------------------------------------------------------ 音 (その場で合成)

  const audio = (function () {
    let ctx = null, master = null, comp = null, analyser = null, noiseBuf = null, engine = null, enabled = settings.sound;
    function init() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      master = ctx.createGain();
      master.gain.value = enabled ? 0.9 : 0;
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      master.connect(comp); comp.connect(analyser); analyser.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      // 主人公機のエンジン (ずっと鳴らし、速さとブーストで少しずつ変える)。青い双発に似合う、滑らかな電子機械音:
      //  ① タービンのうなり: 左右のエンジンをわずかにずらした三角波 (うなりの揺らぎ) + 1 オクターブ上の正弦波
      //  ② 深いとどろき: 低い正弦波 + 丸めた雑音。③ かすかな電子の高鳴き: 2 本の正弦波 (ゆっくり揺れる)
      //  ④ 青いエネルギーの噴射: 帯域を絞った雑音 (ブーストで増える)
      const eg = ctx.createGain(); eg.gain.value = 0; eg.connect(master);
      const humF = ctx.createBiquadFilter(); humF.type = 'lowpass'; humF.frequency.value = 700; humF.Q.value = 0.5;
      const humG = ctx.createGain(); humG.gain.value = 0.55; humF.connect(humG); humG.connect(eg);
      const hums = [];
      [-1, 1].forEach(function (side) {
        const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 112 + side * 0.9;
        const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 224 - side * 1.1;
        const g2 = ctx.createGain(); g2.gain.value = 0.35; o2.connect(g2);
        const mix = ctx.createGain(); mix.gain.value = 0.5; o.connect(mix); g2.connect(mix);
        if (ctx.createStereoPanner) { const sp = ctx.createStereoPanner(); sp.pan.value = side * 0.3; mix.connect(sp); sp.connect(humF); } else mix.connect(humF);
        o.start(); o2.start(); hums.push(o, o2);
      });
      const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = 44;
      const subG = ctx.createGain(); subG.gain.value = 0.5; sub.connect(subG); subG.connect(eg); sub.start();
      const rumble = ctx.createBufferSource(); rumble.buffer = noiseBuf; rumble.loop = true;
      const rumF = ctx.createBiquadFilter(); rumF.type = 'lowpass'; rumF.frequency.value = 150;
      const rumG = ctx.createGain(); rumG.gain.value = 0.55; rumble.connect(rumF); rumF.connect(rumG); rumG.connect(eg); rumble.start();
      const whineG = ctx.createGain(); whineG.gain.value = 0.014; whineG.connect(eg);
      const whines = [];
      [2600, 3900].forEach(function (f, i) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        const lf = ctx.createOscillator(); lf.frequency.value = 0.27 + i * 0.11;
        const lg = ctx.createGain(); lg.gain.value = 22; lf.connect(lg); lg.connect(o.frequency);
        const vg = ctx.createGain(); vg.gain.value = i ? 0.5 : 1; o.connect(vg); vg.connect(whineG);
        o.start(); lf.start(); whines.push(o, lf);
      });
      const jet = ctx.createBufferSource(); jet.buffer = noiseBuf; jet.loop = true;
      const jetF = ctx.createBiquadFilter(); jetF.type = 'bandpass'; jetF.frequency.value = 800; jetF.Q.value = 0.7;
      const jetL = ctx.createBiquadFilter(); jetL.type = 'lowpass'; jetL.frequency.value = 2200;
      const jetG = ctx.createGain(); jetG.gain.value = 0.05; jet.connect(jetF); jetF.connect(jetL); jetL.connect(jetG); jetG.connect(eg); jet.start();
      engine = { g: eg, hums: hums, humF: humF, sub: sub, rumF: rumF, whines: whines, whineG: whineG, jetF: jetF, jetG: jetG };
    }
    function env(g, t, a, peak, dec) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
    }
    function tone(type, f0, f1, dur, vol, filt) {
      if (!ctx || !enabled) return;
      const t = ctx.currentTime;
      const o = ctx.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      const g = ctx.createGain();
      env(g, t, 0.004, vol, dur);
      let node = o;
      if (filt) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filt; o.connect(f); node = f; }
      node.connect(g); g.connect(master);
      o.start(t); o.stop(t + dur + 0.05);
    }
    /** 指定の時刻 (when 秒後) に鳴らす音。予約なので、描画が遅れてもずれない。 */
    function toneAt(when, type, f0, f1, dur, vol, filt, atk) {
      if (!ctx || !enabled) return;
      const t = ctx.currentTime + when;
      const o = ctx.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      const g = ctx.createGain();
      env(g, t, atk || 0.004, vol, dur);
      let node = o;
      if (filt) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filt; o.connect(f); node = f; }
      node.connect(g); g.connect(master);
      o.start(t); o.stop(t + dur + 0.05);
    }
    function noise(dur, vol, f0, f1, type, q) {
      if (!ctx || !enabled) return;
      const t = ctx.currentTime;
      const s = ctx.createBufferSource(); s.buffer = noiseBuf;
      const f = ctx.createBiquadFilter(); f.type = type || 'lowpass'; f.Q.value = q || 0.7;
      f.frequency.setValueAtTime(f0, t);
      f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
      const g = ctx.createGain();
      env(g, t, 0.005, vol, dur);
      s.connect(f); f.connect(g); g.connect(master);
      s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
    }
    // ---- タイトルの曲 (その場で合成) ----
    // 暗い宇宙を漂う孤独感。70 BPM・16 小節 (約 55 秒) をくり返す。ずっと鳴り続ける低い唸り + 4 小節ごとに替わる 4 つの和音のパッド
    // (Am9 → Fmaj7 → Dm9 → Esus) + まばらな水晶のような音 (ペンタトニック、付点 8 分のこだま) + ときどき遠い電波のような信号。
    // 小節の組み立ては先読みで 2 秒先まで予約する。盛り上がりは 12 小節かけて少しずつ、残り 4 小節でゆっくり戻る (つなぎ目なし)
    const BPM = 70, BEAT = 60 / BPM, BAR = BEAT * 4;
    const CHORDS = [[45, 52, 59, 60, 64], [41, 48, 52, 57, 64], [38, 45, 52, 57, 62], [40, 47, 52, 57, 59]];
    const BELLS = [69, 72, 76, 79, 81, 84];   // A4 C5 E5 G5 A5 C6
    const mtof = function (m) { return 440 * Math.pow(2, (m - 69) / 12); };
    let mus = null;
    function build(bar) {   // 0..1: 12 小節で上がり、4 小節で戻る
      const k = bar % 16;
      return k < 12 ? k / 12 : 1 - (k - 12) / 4;
    }
    function pan(node, p, dest) {
      if (!ctx.createStereoPanner) { node.connect(dest); return; }
      const sp = ctx.createStereoPanner(); sp.pan.value = p; node.connect(sp); sp.connect(dest);
    }

    // ---- 通常戦闘の曲 (その場で合成) ----
    // 速さ・正確さ・追われる緊張。120 BPM・16 小節 (32 秒) をくり返し、長い前置きも終わりも無い。
    // 刻むシンセの低音 (8 分) + 引き締まったキックとスネア + 機械のような 16 分の音列 + 暗い弦のパッド (Am → F → Dm → E) +
    // ときどき低い金管のひと吹き。緊張は 16 小節かけて少しずつ上がる (音列 → ハイハット → 最後の小節のスネアの連打)。
    // 中高音は空けておく: 音列は低め・小さく、ハイハットは裏拍だけ、シンバルは無し (レーザー・ロック音・爆発が聞こえるように)
    const CBT_BPM = 120, CBT_BEAT = 60 / CBT_BPM, CBT_BAR = CBT_BEAT * 4, CBT_S = CBT_BEAT / 4, CBT_VOL = 0.75;
    const CBT_ROOT = [33, 29, 26, 28];                                     // A1 F1 D1 E1
    const CBT_PAD = [[57, 60, 64, 69], [53, 57, 60, 65], [50, 57, 62, 65], [52, 56, 59, 64]];
    const CBT_KICK = [0, 6, 8, 13], CBT_ARP = [0, 2, 1, 3, 2, 1, 3, 2, 0, 2, 1, 3, 2, 3, 1, 2];
    function cNoise(t, dur, vol, type, f, q, p) {
      const s = ctx.createBufferSource(); s.buffer = noiseBuf;
      const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q || 0.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(fl); fl.connect(g); pan(g, p || 0, mus.bus);
      s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.02);
    }
    function cTone(t, type, f0, f1, dur, vol, lpf, p) {
      const o = ctx.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      let node = o;
      if (lpf) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(lpf, t); f.frequency.exponentialRampToValueAtTime(Math.max(80, lpf * 0.35), t + dur); o.connect(f); node = f; }
      node.connect(g); pan(g, p || 0, mus.bus);
      o.start(t); o.stop(t + dur + 0.03); mus.voices.push(o);
    }
    function scheduleCombatBar(bar, t) {
      const k = bar % 16, lv = 0.3 + 0.7 * k / 15, ci = Math.floor(k / 4) % 4;
      const root = CBT_ROOT[ci], pad = CBT_PAD[ci];
      if (mus.voices.length > 160) mus.voices = mus.voices.slice(-80);
      // 弦: 4 小節ごと。暗く、少しずつ開く
      if (k % 4 === 0) {
        const len = CBT_BAR * 4;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.8;
        lp.frequency.setValueAtTime(550 + 500 * lv, t); lp.frequency.linearRampToValueAtTime(650 + 700 * lv, t + len);
        const g = ctx.createGain(), pk = 0.02 + 0.012 * lv;
        g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(pk, t + 1.0);
        g.gain.setValueAtTime(pk, t + len - 0.3); g.gain.linearRampToValueAtTime(0.0001, t + len + 1.0);
        lp.connect(g); g.connect(mus.bus);
        pad.forEach(function (m, i) {
          [-8, 8].forEach(function (dt) {
            const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = dt;
            const vg = ctx.createGain(); vg.gain.value = 0.6; o.connect(vg); pan(vg, (i % 2 ? 1 : -1) * 0.3, lp);
            o.start(t); o.stop(t + len + 1.1); mus.voices.push(o);
          });
        });
        // 低い金管: 和音の頭にひと吹き
        cTone(t, 'sawtooth', mtof(root + 24), mtof(root + 24), 0.7, 0.05, 520, 0);
      }
      for (let st = 0; st < 16; st++) {
        const at = t + st * CBT_S;
        // 低音: 8 分で刻む。裏の拍で 1 オクターブ上へ
        if (st % 2 === 0) cTone(at, 'sawtooth', mtof(root + (st === 6 || st === 14 ? 12 : 0)), mtof(root + (st === 6 || st === 14 ? 12 : 0)), CBT_S * 1.8, 0.1, 380, 0);
        if (st === 0) cTone(at, 'sine', mtof(root), mtof(root), CBT_BEAT * 1.6, 0.1, 0, 0);
        // キック・スネア (引き締めて短く)
        if (CBT_KICK.indexOf(st) >= 0) cTone(at, 'sine', 140, 42, 0.2, 0.45, 0, 0);
        if (st === 4 || st === 12) { cNoise(at, 0.13, 0.2, 'bandpass', 1900, 0.8); cTone(at, 'triangle', 200, 150, 0.09, 0.09, 0, 0); }
        // 最後の小節: スネアの連打で次の周回へ
        if (k === 15 && st >= 12 && st % 1 === 0) cNoise(at, 0.07, 0.07 + 0.012 * (st - 12), 'bandpass', 2000, 0.8);
        // 機械のような音列: 2 小節目以降。低めで小さい
        if (lv >= 0.35 && st !== 3 && st !== 11) {
          const m = pad[CBT_ARP[st]] + (CBT_ARP[st] % 2 ? 0 : 12) - 12;
          cTone(at, 'square', mtof(m + 12), mtof(m + 12), CBT_S * 1.2, st % 4 === 0 ? 0.034 : 0.022, 1300, st % 2 ? 0.35 : -0.35);
        }
        // ハイハット: 裏拍だけ。終盤は 16 分
        if ((lv >= 0.55 && st % 4 === 2) || (lv >= 0.85 && st % 2 === 1)) cNoise(at, 0.035, 0.035, 'highpass', 7500, 0.7, st % 4 === 2 ? 0.3 : -0.3);
      }
    }

    // ---- 巨大戦艦戦の曲 (その場で合成) ----
    // 重厚感 (巨大戦艦の圧力) + ノリ (止まらない戦闘) + 盛り上がり (勝負の熱さ)。140 BPM・16 小節 (約 27 秒) をくり返す。前置きは無く、戦艦が現れた瞬間から刻み始める。
    // 重い太鼓と強いキック (少しずらしたキック + 2・4 拍のタイトなスネア) / うなる低音の 16 分のパルス (のこぎり波・Em → C → D → B) /
    // 速い弦の刻み (16 分・和音の音) / 低い金管の太い一撃 / 裏拍の金属の打音 / 主役の繰り返しのリフ (5〜8 小節目から。和音ごとに平行移動する 2 小節の形)。
    // 8 小節目の頭に大きな一撃で爆発的に戻り、8 小節目の最後の 1 拍と 13 小節目の後半は太鼓を抜いて張りつめる (短い間)。16 小節目は連打で頭へ戻る。
    // 高い音は削り (リフも 2.2kHz まで)、主砲や爆発の効果音が聞こえる中域の隙間を残す
    const BSS_BPM = 140, BSS_BEAT = 60 / BSS_BPM, BSS_BAR = BSS_BEAT * 4, BSS_S = BSS_BEAT / 4, BSS_VOL = 0.7;
    const BSS_ROOT = [40, 36, 38, 35];                          // E2 C2 D2 B1 (1 小節ごとに替わる)
    const BSS_SHIFT = [0, -4, -2, -5];                          // リフの平行移動 (Em の形を C・D・B へ)
    const BSS_CH = [[0, 3, 7, 12], [0, 4, 7, 12], [0, 4, 7, 12], [0, 3, 6, 11]];   // 弦の刻みに使う和音の音 (根音からの半音)
    // リフ: [16 分の位置, 音 (E4=64 が基準), 長さ (16 分)] 2 小節 (問いと答え)。ずらした拍が「ノリ」の決め手
    const BSS_RIFF = [
      [[0, 64, 2], [3, 64, 1], [6, 67, 2], [8, 69, 2], [10, 67, 1], [12, 64, 2], [14, 62, 2]],
      [[0, 60, 2], [3, 60, 1], [6, 64, 2], [8, 67, 3], [12, 69, 2], [14, 71, 2]]
    ];
    function bossHit(t, big) {                                   // 金属の衝撃: 合わない倍音を重ね、高いところは削る
      const base = 150;
      [1, 2.76, 5.4, 8.93].forEach(function (r, i) {
        cTone(t, 'sine', base * r, base * r * 0.97, big ? 1.4 : 0.7, (big ? 0.1 : 0.06) / (1 + i * 0.7), 2600, 0);
      });
      cNoise(t, big ? 0.8 : 0.3, big ? 0.28 : 0.14, 'lowpass', big ? 1500 : 1000, 0.7, 0);
      cTone(t, 'sine', 72, 30, big ? 1.1 : 0.6, big ? 0.55 : 0.32, 0, 0);
    }
    function scheduleBossBar(bar, t) {
      if (mus.voices.length > 220) mus.voices = mus.voices.slice(-110);
      const k = bar % 16, ci = k % 4, root = BSS_ROOT[ci], shift = BSS_SHIFT[ci];
      const riffOn = k >= 4, full = k >= 8;
      const brk = k === 7 ? 12 : k === 12 ? 8 : 99;              // この拍の位置から先は太鼓を抜く (張りつめる間)
      const fillBar = k === 7 || k === 15;
      // 8 小節目の頭: 大きな一撃 (爆発的な復帰)。1 小節目の頭は戦艦の登場に合わせた金属の一撃
      if (k === 8 || k === 0) bossHit(t, true);
      // 低い金管: 小節の頭に太い一撃 (根音 + 5 度 + オクターブ)。全開の小節は 3 拍目にも
      [0, 7, 12].forEach(function (iv, i) {
        [-8, 8].forEach(function (dt) {
          const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(root + 12 + iv); o.detune.value = dt;
          const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.8;
          lp.frequency.setValueAtTime(320, t); lp.frequency.linearRampToValueAtTime(900, t + BSS_BEAT * 0.5); lp.frequency.linearRampToValueAtTime(380, t + BSS_BEAT * 3.2);
          const g = ctx.createGain(), pk = (full ? 0.06 : 0.045) / (1 + i * 0.3);
          g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(pk, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + BSS_BEAT * 3.2);
          o.connect(lp); lp.connect(g); pan(g, (i - 1) * 0.25, mus.bus);
          o.start(t); o.stop(t + BSS_BEAT * 3.3); mus.voices.push(o);
        });
      });
      for (let st = 0; st < 16; st++) {
        const at = t + st * BSS_S, drums = st < brk;
        if (drums) {
          // キック: 頭・拍・少しずらした位置。重く、太い
          const kicks = (k % 2 === 1) ? [0, 4, 8, 10, 12, 14] : [0, 4, 8, 11, 12];
          if (kicks.indexOf(st) >= 0) cTone(at, 'sine', 130, 40, 0.22, 0.55, 0, 0);
          // スネア: 2・4 拍。タイトに
          if (st === 4 || st === 12) { cNoise(at, 0.12, 0.22, 'bandpass', 1800, 0.8); cTone(at, 'triangle', 190, 140, 0.08, 0.1, 0, 0); }
          // 重い太鼓 (低いタム): 小節の裏に
          if (full && (st === 6 || st === 14)) cTone(at, 'sine', 95, 45, 0.35, 0.3, 0, 0);
          // 裏拍の金属の打音: 短く、中低域
          if (st % 4 === 2) cNoise(at, 0.05, 0.08, 'bandpass', 3200, 2.5, st % 8 === 2 ? -0.3 : 0.3);
        }
        // 小節の最後の連打 (k=7, 15 の最後の 1 拍): スネアとタムでたたみかける
        if (fillBar && st >= 12) { cNoise(at, 0.08, 0.1 + 0.02 * (st - 12), 'bandpass', 1900, 0.8); if (st % 2 === 0) cTone(at, 'sine', 110 - (st - 12) * 6, 55, 0.2, 0.3, 0, 0); }
        // うなる低音: 16 分のパルス (跳ねる形)。のこぎり波を丸め、音の頭だけ開く
        if (drums && [0, 1, 3, 4, 6, 7, 8, 9, 11, 12, 14, 15].indexOf(st) >= 0) {
          const m = root + (st === 7 || st === 15 ? 12 : 0);
          cTone(at, 'sawtooth', mtof(m), mtof(m), BSS_S * 0.95, st % 4 === 0 ? 0.13 : 0.085, 330, 0);
        }
        // 速い弦の刻み: 16 分 (全開のあいだは強く)
        if (drums || st < 15) {
          const iv = BSS_CH[ci][[0, 2, 1, 3, 2, 1, 3, 2, 0, 2, 1, 3, 2, 3, 1, 2][st]];
          if (st !== 15 || !fillBar) cTone(at, 'sawtooth', mtof(root + 24 + iv), mtof(root + 24 + iv), BSS_S * 0.8, (full ? 0.034 : 0.026) * (st % 4 === 0 ? 1.4 : 1), 1250, (st % 2 ? 0.35 : -0.35));
        }
      }
      // 主役のリフ: 5 小節目から。2 小節で 1 つの形 (問い・答え) を、和音に合わせて平行移動
      if (riffOn) {
        const phrase = BSS_RIFF[k % 2];
        phrase.forEach(function (n) {
          const at = t + n[0] * BSS_S, f = mtof(n[1] + shift), len = n[2] * BSS_S * 0.98;
          if (n[0] >= brk) return;
          [-7, 7].forEach(function (dt) {
            const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = dt;
            const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200; lp.Q.value = 1;
            const g = ctx.createGain(), pk = full ? 0.04 : 0.03;
            g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(pk, at + 0.01); g.gain.setValueAtTime(pk, at + len * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, at + len + 0.08);
            o.connect(lp); lp.connect(g); pan(g, dt > 0 ? 0.2 : -0.2, mus.bus);
            o.start(at); o.stop(at + len + 0.12); mus.voices.push(o);
          });
        });
      }
    }
    function startMusic(kind) {
      kind = kind || 'title';
      if (!ctx || !enabled) return;
      if (mus && mus.kind === kind) return;
      if (mus) stopMusic(0.8);
      const combat = kind === 'combat', bossK = kind === 'boss';
      const bus = ctx.createGain(); bus.gain.value = 0; bus.connect(master);
      bus.gain.setTargetAtTime(combat ? CBT_VOL : bossK ? BSS_VOL : 0.55, ctx.currentTime, kind === 'title' ? 1.6 : 0.4);   // タイトルはゆっくり入る。戦闘はすぐ
      // こだま: 付点 8 分。戻りは暗く (高い音を削る)
      const dly = ctx.createDelay(2); dly.delayTime.value = BEAT * 0.75;
      const fb = ctx.createGain(); fb.gain.value = 0.5;
      const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 1800;
      const wet = ctx.createGain(); wet.gain.value = 0.55;
      dly.connect(dlp); dlp.connect(fb); fb.connect(dly); dlp.connect(wet); wet.connect(bus);
      const send = ctx.createGain(); send.gain.value = 1; send.connect(dly);
      // 低い唸り: 深い正弦 (A1) + ほんの少しずらした 2 本ののこぎり波 (A2) を、ゆっくり開閉するフィルターへ
      const dg = ctx.createGain(); dg.gain.value = combat ? 0 : bossK ? 0.05 : 0.13; dg.connect(bus);
      const dlp2 = ctx.createBiquadFilter(); dlp2.type = 'lowpass'; dlp2.frequency.value = 200; dlp2.Q.value = 2;
      dlp2.connect(dg);
      const oscs = [];
      (bossK ? [[41.2, 'sine', 0, 1], [82.4, 'sawtooth', -9, 0.4], [82.4, 'sawtooth', 9, 0.4]] : [[55, 'sine', 0, 1], [110, 'sawtooth', -7, 0.35], [110, 'sawtooth', 7, 0.35]]).forEach(function (d) {
        const o = ctx.createOscillator(); o.type = d[1]; o.frequency.value = d[0]; o.detune.value = d[2];
        const g = ctx.createGain(); g.gain.value = d[3]; o.connect(g); g.connect(dlp2); o.start(); oscs.push(o);
      });
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.045;
      const lg = ctx.createGain(); lg.gain.value = 90; lfo.connect(lg); lg.connect(dlp2.frequency); lfo.start(); oscs.push(lfo);
      mus = { kind: kind, barLen: combat ? CBT_BAR : bossK ? BSS_BAR : BAR, bus: bus, send: send, oscs: oscs, voices: [], nodes: [bus, dly, dg], bar: 0, t: ctx.currentTime + 0.1, timer: null };
      const tick = function () {
        if (!mus) return;
        while (mus.t < ctx.currentTime + 2) { (mus.kind === 'combat' ? scheduleCombatBar : mus.kind === 'boss' ? scheduleBossBar : scheduleBar)(mus.bar, mus.t); mus.bar++; mus.t += mus.barLen; }
      };
      tick();
      mus.timer = setInterval(tick, 250);
    }
    function scheduleBar(bar, t) {
      const lv = build(bar);
      if (mus.voices.length > 80) mus.voices = mus.voices.slice(-40);   // 鳴り終えた音は覚えておかない
      // 4 小節ごとに和音を替える。前の和音の余韻と重ねる
      if (bar % 4 === 0) {
        const ch = CHORDS[(bar / 4) % 4], len = BAR * 4;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.7;
        lp.frequency.setValueAtTime(600 + 500 * lv, t); lp.frequency.linearRampToValueAtTime(700 + 600 * lv, t + len);
        const g = ctx.createGain(), peak = 0.026 + 0.012 * lv;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(peak, t + 3.2);
        g.gain.setValueAtTime(peak, t + len - 0.4);
        g.gain.linearRampToValueAtTime(0.0001, t + len + 3.4);
        lp.connect(g); g.connect(mus.bus); g.connect(mus.send);
        ch.forEach(function (m, i) {
          [-9, 9].forEach(function (dt, j) {
            const o = ctx.createOscillator(); o.type = i === 0 ? 'sawtooth' : 'triangle'; o.frequency.value = mtof(m); o.detune.value = dt + (i - 2) * 1.5;
            const vg = ctx.createGain(); vg.gain.value = i === 0 ? 0.7 : 0.55;
            o.connect(vg); pan(vg, (i % 2 ? 1 : -1) * (0.25 + 0.15 * j), lp);
            o.start(t); o.stop(t + len + 3.6); mus.voices.push(o);
          });
        });
      }
      // 水晶のような音: まばら。盛り上がるほど少しだけ増える
      for (let k = 0; k < 2; k++) {
        if (Math.random() < 0.16 + 0.3 * lv) {
          const bt = t + Math.floor(Math.random() * 8) * BEAT / 2 + k * BAR / 2;
          const m = BELLS[Math.floor(Math.random() * BELLS.length)];
          const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = mtof(m);
          const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = mtof(m) * 2.76;   // 金属的な上の響き
          const g = ctx.createGain(), g2 = ctx.createGain(), pk = 0.05 + 0.03 * Math.random();
          g.gain.setValueAtTime(0.0001, bt); g.gain.linearRampToValueAtTime(pk, bt + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, bt + 3.4);
          g2.gain.setValueAtTime(0.0001, bt); g2.gain.linearRampToValueAtTime(pk * 0.12, bt + 0.008); g2.gain.exponentialRampToValueAtTime(0.0001, bt + 0.9);
          o.connect(g); o2.connect(g2);
          const p = Math.random() * 1.2 - 0.6;
          pan(g, p, mus.bus); pan(g2, p, mus.bus); g.connect(mus.send);
          o.start(bt); o.stop(bt + 3.5); o2.start(bt); o2.stop(bt + 1); mus.voices.push(o, o2);
        }
      }
      // 遠い電波のような信号: ときどき、ごく小さく。3 つの短い音が並ぶ
      if (Math.random() < 0.08) {
        const rt = t + Math.random() * BAR * 0.5, base = 1100 + Math.random() * 1400, p = Math.random() < 0.5 ? -0.8 : 0.8;
        for (let i = 0; i < 3; i++) {
          const nt = rt + i * 0.19;
          const s = ctx.createBufferSource(); s.buffer = noiseBuf;
          const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = base * (1 + 0.12 * i); f.Q.value = 14;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, nt); g.gain.linearRampToValueAtTime(0.05, nt + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, nt + 0.12);
          s.connect(f); f.connect(g); pan(g, p, mus.bus); g.connect(mus.send);
          s.start(nt, Math.random() * 1.5); s.stop(nt + 0.14);
        }
      }
    }
    function stopMusic(fade) {
      if (!mus) return;
      const m = mus; mus = null;
      clearInterval(m.timer);
      m.bus.gain.cancelScheduledValues(ctx.currentTime);
      m.bus.gain.setTargetAtTime(0, ctx.currentTime, (fade || 1.2) / 3);
      // 予約済みのパッドや水晶の音も、余韻が消えたら一緒に止める (鳴りっぱなしにすると、出撃直後の描画が遅くなった)
      const end = ctx.currentTime + (fade || 1.2) + 0.15;
      m.voices.forEach(function (o) { try { o.stop(end); } catch (e) { /* もう止まっている */ } });
      m.oscs.forEach(function (o) { try { o.stop(end); } catch (e) { /* もう止まっている */ } });
      setTimeout(function () { m.bus.disconnect(); }, ((fade || 1.2) + 0.3) * 1000);
    }
    return {
      init: init,
      music: startMusic,
      stopMusic: stopMusic,
      musicOn: function () { return !!mus; },
      musicKind: function () { return mus ? mus.kind : null; },
      ready: function () { return !!ctx && ctx.state === 'running'; },
      setEnabled: function (on) {
        enabled = on;
        if (master) { master.gain.cancelScheduledValues(ctx.currentTime); master.gain.setTargetAtTime(on ? 0.9 : 0, ctx.currentTime, 0.03); }
      },
      suspend: function () { if (ctx && ctx.state === 'running') ctx.suspend(); },
      resume: function () { if (ctx && ctx.state === 'suspended') ctx.resume(); },
      engine: function (speed, boosting, on) {
        if (!engine) return;
        const t = ctx.currentTime, k = 0.3;   // ゆっくり追いかける (急に変わらない)
        const sp = Math.min(1.6, speed / 60);
        // タービン: 速いほど高く。ブーストでさらに少し高く
        const hf = 100 + sp * 22 + (boosting ? 14 : 0);
        engine.hums.forEach(function (o, i) { o.frequency.setTargetAtTime(hf * (i % 2 ? 2 : 1) + (i < 2 ? -0.9 : 0.9) * (i % 2 ? -1.2 : 1), t, k); });
        engine.humF.frequency.setTargetAtTime(520 + sp * 220 + (boosting ? 380 : 0), t, k);
        engine.sub.frequency.setTargetAtTime(42 + sp * 5, t, k);
        engine.rumF.frequency.setTargetAtTime(130 + sp * 40 + (boosting ? 90 : 0), t, k);
        engine.whines.forEach(function (o, i) { if (i % 2 === 0) o.frequency.setTargetAtTime((i ? 3900 : 2600) * (1 + sp * 0.06 + (boosting ? 0.05 : 0)), t, k); });
        engine.whineG.gain.setTargetAtTime(boosting ? 0.022 : 0.012, t, k);
        engine.jetF.frequency.setTargetAtTime(700 + sp * 250 + (boosting ? 500 : 0), t, k);
        engine.jetG.gain.setTargetAtTime(boosting ? 0.2 : 0.05, t, 0.2);
        engine.g.gain.setTargetAtTime(on ? (boosting ? 0.11 : 0.045) : 0, t, on ? 0.25 : 0.15);
      },
      // レーザー (主人公機): 約 0.3 秒。「シュバッ」「ズシュン」という、瞬間の圧力と切れ味。音程のある電子音 (ピコピコ) は使わず、
      // すべて下がる掃引と雑音で作る: ① 鋭い立ち上がり (短い帯域雑音のひび割れ) ② 引き締まった中低域の衝撃 (150→48Hz) ③ 空気を裂く速い掃引 (3200→700Hz の雑音)
      // ④ 深い機械的なエネルギーの爆ぜ (のこぎり波 95→55Hz を丸める) ⑤ かすかにざらつく電気の唸り (方形波 110→70Hz + 丸めた雑音)。
      // 連射でも力強く澄んでいるよう、1 発ごとに ±4% ふらつかせ、尾は短く切る
      laser: function () {
        const r = 1 + (Math.random() - 0.5) * 0.08;
        noise(0.03, 0.12, 4200, 2600, 'bandpass', 0.7);                    // ひび割れ
        tone('sine', 150 * r, 48 * r, 0.14, 0.22);                         // 衝撃
        noise(0.15, 0.14, 3200 * r, 700 * r, 'bandpass', 0.8);              // 空気を裂く
        tone('sawtooth', 95 * r, 55 * r, 0.26, 0.1, 420);                 // 機械的な爆ぜ
        tone('square', 110 * r, 70 * r, 0.2, 0.04, 600);                   // 電気の唸り
        noise(0.26, 0.05, 900, 300, 'lowpass', 0.7);
      },
      enemyLaser: function () { tone('sawtooth', 700, 180, 0.12, 0.03, 1500); },
      hit: function () { tone('square', 2400, 1800, 0.03, 0.05); noise(0.04, 0.08, 6000, 3000, 'highpass'); },
      armored: function () { tone('triangle', 3200, 2600, 0.05, 0.05); },
      explode: function (size) {
        noise(0.5 + size * 0.15, Math.min(0.9, 0.35 + size * 0.1), 2400, 60);
        tone('sine', 120, 30, 0.35 + size * 0.1, Math.min(0.8, 0.3 + size * 0.1));
      },
      big: function () { noise(2.4, 1, 1800, 40); tone('sine', 80, 20, 2.0, 0.9); },
      // ワープ明け: 上がっていく唸りから、重い轟音へ
      warp: function () {
        tone('sawtooth', 120, 1400, 0.35, 0.12, 3000); noise(1.6, 0.9, 3500, 60); tone('sine', 70, 24, 1.8, 0.9);
        // 巨大戦艦が現れる: 重低音のあとに金属の共鳴 (合わない倍音を低めに重ねて、ゆっくり消す)
        [96, 265, 519, 857].forEach(function (f, i) { toneAt(0.12, 'sine', f, f * 0.985, 2.4 - i * 0.3, 0.16 / (1 + i * 0.6), 1800, 0.05); });
      },
      // ボス登場の警報 (約 1.5 秒): 深い警告音のあと、下がっていく鋭い 2 つのパルス + かすかな金属の響き。
      // 救急車のようなサイレンにならないよう、音程は一度ずつ下がって止まる。中低域を強く、高い音は削る。「BOSS BATTLE」の帯の出現と同時に鳴らす
      bossAlert: function () {
        toneAt(0, 'sawtooth', 98, 90, 0.6, 0.2, 650, 0.03);
        toneAt(0, 'sine', 49, 46, 0.6, 0.3, 0, 0.03);
        [0.62, 0.98].forEach(function (w) {
          toneAt(w, 'square', 820, 430, 0.22, 0.13, 2300, 0.004);
          toneAt(w, 'triangle', 410, 215, 0.24, 0.14, 0, 0.004);
          toneAt(w, 'sine', 90, 55, 0.3, 0.22, 0, 0.004);
        });
        [330, 905, 1760].forEach(function (f, i) { toneAt(0.6, 'sine', f, f, 0.9 - i * 0.18, 0.05 / (1 + i * 0.8), 2400, 0.006); });
      },
      // 音楽を一瞬弱める (演出のあいだ、効果音を聞かせる)
      duck: function (v) { if (mus) mus.bus.gain.setTargetAtTime(v, ctx.currentTime, 0.06); },
      // 撃墜: 重い爆発 + はじける高い音。コンボが続くほど高くなる (2 半音ずつ、8 段まで)
      kill: function (combo, size) {
        const r = Math.pow(2, Math.min(combo - 1, 8) * 2 / 12);
        noise(0.6 + size * 0.15, Math.min(0.95, 0.5 + size * 0.1), 3000, 50);
        tone('sine', 140, 28, 0.5 + size * 0.1, 0.9);
        tone('square', 1320 * r, 660 * r, 0.12, 0.09);
        tone('triangle', 1980 * r, 1980 * r, 0.18, 0.07);
      },
      missile: function (n) {
        noise(0.6, 0.3, 800, 3000, 'bandpass', 1.2);
        // 一斉発射は少しずつずらして重ねる (数だけシュッと鳴る)
        for (let i = 1; i < (n || 1); i++) setTimeout(function () { noise(0.45, 0.25, 900 + i * 150, 3200, 'bandpass', 1.2); }, i * 55);
      },
      // マルチロック: 捕まえるたびに短く、数が増えるほど高く
      mlock: function (n) { const f = 1320 * Math.pow(1.19, n - 1); toneAt(0, 'sine', f, f, 0.1, 0.07, 0, 0.003); toneAt(0, 'triangle', f * 2, f * 2, 0.05, 0.02, 3500, 0.003); },
      // ロックオン (約 0.4 秒): 音程の上がる正確な 2 つの電子音 → かすかなデジタルの走査 → 澄んだ確認の「ピン」。
      // 冷たく、短く、サイレンではない。高い音は 3.5kHz まで・響きなしで、何度聞いても疲れにくい
      lock: function () {
        toneAt(0, 'sine', 1320, 1320, 0.07, 0.07, 0, 0.003);
        toneAt(0.085, 'sine', 1760, 1760, 0.07, 0.07, 0, 0.003);
        for (let i = 0; i < 6; i++) toneAt(0.07 + i * 0.03, 'square', 2300 + i * 90, 2300 + i * 90, 0.02, 0.012, 2800, 0.002);   // 走査の刻み
        toneAt(0.25, 'sine', 2640, 2640, 0.16, 0.075, 0, 0.003);                                                                 // 確認のピン
        toneAt(0.25, 'sine', 3960, 3960, 0.08, 0.02, 0, 0.003);
      },
      // ブースト点火 (約 1.2 秒): 鋭い電子の点火 → のぼっていく青いエネルギーの轟き + 深い低音の衝撃 + 速い空気のうねり + 明るく響く電子音。
      // 立ち上がりが強く、尾は滑らかに消える。通常のエンジン音から一気に解き放たれる感じ。高い音はやや削る
      boost: function () {
        toneAt(0, 'square', 280, 1900, 0.13, 0.09, 3200, 0.003);                 // 点火
        toneAt(0.02, 'sine', 95, 38, 0.55, 0.5, 0, 0.004);                       // 低音の衝撃
        toneAt(0.04, 'sawtooth', 70, 430, 1.0, 0.11, 1500, 0.05);                // のぼる轟き
        toneAt(0.04, 'sawtooth', 70.7, 436, 1.0, 0.08, 1500, 0.05);
        if (ctx && enabled) {                                                     // 速い空気のうねり (帯域を上へ掃く)
          const t = ctx.currentTime + 0.03, s2 = ctx.createBufferSource(); s2.buffer = noiseBuf;
          const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.9;
          f.frequency.setValueAtTime(350, t); f.frequency.exponentialRampToValueAtTime(3000, t + 0.6);
          const g = ctx.createGain(); env(g, t, 0.05, 0.32, 0.85);
          s2.connect(f); f.connect(g); g.connect(master); s2.start(t, Math.random() * 1.5); s2.stop(t + 1);
        }
        toneAt(0.1, 'sine', 1320, 1400, 1.0, 0.05, 0, 0.01);                      // 明るく響く電子音
        toneAt(0.1, 'sine', 1980, 2100, 0.8, 0.03, 0, 0.01);
      },
      hurt: function (big) { noise(0.25, big ? 0.6 : 0.35, 900, 200); tone('square', 200, 90, 0.18, 0.12); },
      alarm: function () { tone('square', 880, 870, 0.18, 0.08); setTimeout(function () { tone('square', 660, 650, 0.18, 0.08); }, 220); },
      charge: function () { tone('sawtooth', 80, 900, 2.6, 0.08, 2000); },
      beam: function () { noise(1.2, 0.7, 500, 150); tone('sawtooth', 70, 40, 1.1, 0.25, 600); },
      ui: function () { tone('sine', 1200, 1600, 0.06, 0.08); },
      level: function () {
        if (!analyser) return null;
        const a = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(a);
        let mx = 0, sum = 0;
        for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > mx) mx = v; sum += v; }
        return { max: mx, avg: sum / a.length };
      }
    };
  })();

  // ------------------------------------------------------------ 入力

  const input = { stickX: 0, stickY: 0, fire: false, boost: false, missile: false, select: false };
  const touch = { stickId: null, stickOrigin: null, fireIds: new Set(), boostIds: new Set(), trackIds: new Set() };
  const STICK_R = 54;

  function setStickVisual(x, y, on) {
    els.stickKnob.style.transform = 'translate(' + (x * STICK_R).toFixed(1) + 'px,' + (y * STICK_R).toFixed(1) + 'px)';
    els.stick.classList.toggle('on', on);
  }

  els.stickZone.addEventListener('pointerdown', function (e) {
    if (touch.stickId !== null) return;
    e.preventDefault();
    touch.stickId = e.pointerId;
    els.stickZone.setPointerCapture(e.pointerId);
    const r = els.stickZone.getBoundingClientRect();
    // 押した所にスティックを出す (どこを押しても使える)
    const ox = C.clamp(e.clientX - r.left, 64, r.width - 20), oy = C.clamp(e.clientY - r.top, 64, r.height - 64);
    touch.stickOrigin = { x: ox + r.left, y: oy + r.top };
    els.stick.style.left = ox + 'px';
    els.stick.style.top = oy + 'px';
    moveStick(e);
  });
  function moveStick(e) {
    if (e.pointerId !== touch.stickId) return;
    let dx = (e.clientX - touch.stickOrigin.x) / STICK_R, dy = (e.clientY - touch.stickOrigin.y) / STICK_R;
    const m = Math.hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; }
    // 真ん中の少しは遊び
    const dead = 0.06, mm = Math.min(1, m);
    const k = mm < dead ? 0 : (mm - dead) / (1 - dead) / (mm || 1);
    input.stickX = dx * k * (m > 1 ? 1 : 1);
    input.stickY = -dy * k * (settings.invert ? -1 : 1);
    setStickVisual(dx, dy, true);
  }
  function endStick(e) {
    if (e.pointerId !== touch.stickId) return;
    touch.stickId = null;
    input.stickX = 0; input.stickY = 0;
    setStickVisual(0, 0, false);
  }
  els.stickZone.addEventListener('pointermove', moveStick);
  els.stickZone.addEventListener('pointerup', endStick);
  els.stickZone.addEventListener('pointercancel', endStick);

  function holdButton(el, set, onDown, onRelease) {
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      set.add(e.pointerId);
      el.classList.add('on');
      if (onDown) onDown();
    });
    const up = function (e) {
      if (!set.has(e.pointerId)) return;
      set.delete(e.pointerId);
      if (set.size === 0) { el.classList.remove('on'); if (onRelease && e.type === 'pointerup') onRelease(); }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }
  holdButton(els.btnFire, touch.fireIds);
  holdButton(els.btnBoost, touch.boostIds);
  const missileIds = new Set();
  // ミサイル: 押している間に照準の近くの敵を次々ロックし、離したら一斉に撃つ (ロックが無ければ 1 発)
  holdButton(els.btnMissile, missileIds, null, function () { input.missile = true; });
  // ロックオン: 押した瞬間に敵を選ぶ (2 回目からは次の敵へ)。押している間はその敵へ機首を向ける
  holdButton(els.btnTarget, touch.trackIds, function () { input.select = true; });
  // 指を置いた瞬間に止める (遊んでいる間は touchend を打ち消すので click が来ない)
  els.btnPause.addEventListener('pointerdown', function (e) { e.preventDefault(); setPaused(true); });

  // iPhone は「拡大しない」と指定しても、連続タップで拡大することがある。
  // 遊んでいる間は、指を離したときの既定の動作 (連続タップの拡大) と、2本指の拡大を打ち消す。
  // 操作はすべて pointerdown/pointermove で受けているので、ここで打ち消しても効く。
  function blockZoom(e) {
    if (screen === 'play' && !paused) e.preventDefault();
  }
  document.addEventListener('touchend', blockZoom, { passive: false });
  document.addEventListener('dblclick', blockZoom, { passive: false });
  document.addEventListener('gesturestart', blockZoom, { passive: false });
  document.addEventListener('gesturechange', blockZoom, { passive: false });

  // キーボード (手もとで試す用)
  const keys = {};
  window.addEventListener('keydown', function (e) {
    if (e.repeat) { if (e.code !== 'Space') return; }
    keys[e.code] = true;
    if (e.code === 'KeyQ' || e.code === 'KeyT') input.select = true;
    if ((e.code === 'Escape' || e.code === 'KeyP') && screen === 'play') setPaused(!paused);
    if (e.code === 'Space' || e.code.indexOf('Arrow') === 0) e.preventDefault();
  });
  window.addEventListener('keyup', function (e) {
    keys[e.code] = false;
    if ((e.code === 'KeyE' || e.code === 'KeyM') && !keys.KeyE && !keys.KeyM) input.missile = true;
  });
  window.addEventListener('blur', function () { for (const k in keys) keys[k] = false; });

  function missileHeld() { return missileIds.size > 0 || !!(keys.KeyE || keys.KeyM); }

  function readKeys(dt) {
    const kx = (keys.ArrowRight || keys.KeyD ? 1 : 0) - (keys.ArrowLeft || keys.KeyA ? 1 : 0);
    const ky = (keys.ArrowUp || keys.KeyW ? 1 : 0) - (keys.ArrowDown || keys.KeyS ? 1 : 0);
    return {
      kx: kx, ky: ky * (settings.invert ? -1 : 1), fire: !!(keys.Space || keys.KeyJ),
      boost: !!(keys.ShiftLeft || keys.ShiftRight || keys.KeyK), track: !!(keys.KeyQ || keys.KeyT),
      missileHold: !!(keys.KeyE || keys.KeyM)
    };
  }

  // ------------------------------------------------------------ ゲームの状態

  let game = null;
  let screen = 'title';     // title / play / result
  let paused = false;
  let shipObj = null;
  const enemyObjs = new Map();
  let bossObj = null;
  const fx = {
    shake: 0, hitMarker: 0, killMarker: 0, hurt: [], banners: [], popups: [],
    fovKick: 0, bossCam: 0, timeScale: 1, slowT: 0, stopT: 0, lastHurt: 0, alarmT: 0
  };
  const cam = { dir: new THREE.Vector3(0, 0, -1), pos: new THREE.Vector3(0, 6, 18), roll: 0, back: 16, fov: 68 };
  let titleT = 0;
  let resultShown = false;

  function clearWorld() {
    if (shipObj) { scene.remove(shipObj); shipObj = null; }
    enemyObjs.forEach(function (o) { scene.remove(o); });
    enemyObjs.clear();
    if (bossObj) {
      scene.remove(bossObj);
      ['beamOuter', 'beamCore', 'guide'].forEach(function (k) { scene.remove(bossObj.userData[k]); });
      bossObj = null;
    }
    particles.list.forEach(function (p) { p.on = false; });
    flashes.forEach(function (f) { f.t = 0; f.s.visible = false; });
    if (cutinAnim) { cutinAnim.cancel(); cutinAnim = null; }
    $('cutin').hidden = true;
    warpGlow.visible = false;
    fx.banners.length = 0; fx.popups.length = 0; fx.hurt.length = 0; fx.cardT = 0;
    if (stageCardAnim) { stageCardAnim.cancel(); stageCardAnim = null; }
    $('stageCard').hidden = true;
  }

  /** タイトルの間だけ曲を鳴らす (音の設定を切ったら止める)。 */
  let bossMusic = false;   // 戦艦が現れたあと true
  function syncMusic() {
    if (!settings.sound) { audio.stopMusic(0.6); return; }
    if (screen === 'title') audio.music('title');
    // 戦艦が出たら戦艦戦の曲へ。沈められる (撃沈の演出) 間と結果では止める
    else if (screen === 'play' && game && game.state === 'play') {
      // 戦艦が出る知らせのあいだは、戦闘の曲を弱めて警報と帯を聞かせ、戦艦が現れた瞬間 (bossWarp) から戦艦戦の曲へ
      if (game.boss && !bossMusic) audio.duck(0.12);
      else audio.music(game.boss ? 'boss' : 'combat');
    }
    else audio.stopMusic(1.2);
  }
  // 音は最初の指のあとでないと鳴らせない (iOS)。タイトルで最初に触れた瞬間に始める
  ['pointerup', 'touchend'].forEach(function (type) {
    document.addEventListener(type, function once() {
      audio.init();
      syncMusic();
      if (audio.ready()) { ['pointerup', 'touchend'].forEach(function (t) { document.removeEventListener(t, once, true); }); }
    }, true);
  });

  let lastStart;
  function startGame(opts) {
    opts = opts || {};
    lastStart = opts.start;
    bossMusic = false;
    audio.init();
    clearWorld();
    game = C.createGame({ seed: opts.seed !== undefined ? opts.seed : (Math.random() * 1e9) >>> 0, start: opts.start, level: opts.level });
    shipObj = makePlayerShip();
    scene.add(shipObj);
    input.stickX = 0; input.stickY = 0; input.missile = false;
    touch.fireIds.clear(); touch.boostIds.clear(); touch.trackIds.clear(); missileIds.clear();
    els.btnFire.classList.remove('on'); els.btnBoost.classList.remove('on'); els.btnTarget.classList.remove('on'); els.btnMissile.classList.remove('on');
    setStickVisual(0, 0, false);
    cam.dir.set(0, 0, -1);
    fx.timeScale = 1; fx.slowT = 0; fx.stopT = 0; fx.bossCam = 0;
    rings.forEach(function (r) { r.t = 0; r.s.visible = false; });
    resultShown = false;
    setSkyDim(SKY_DIM.play);
    screen = 'play';
    paused = false;
    syncMusic();
    els.title.hidden = true; els.result.hidden = true; els.pause.hidden = true;
    els.controls.hidden = false;
    // 巨大戦艦からのときは、すぐ出るカットインが知らせる
    if (opts.start !== 'boss') showStageCard(1);
    consumeEvents();
  }

  // 設定・遊び方の板を開く (もう一度押すと閉じる)。null で閉じる
  function showMenu(id) {
    if (id && !$(id).hidden) id = null;
    ['menuSettings', 'menuHowto'].forEach(function (k) { $(k).hidden = k !== id; });
    $('titleMenu').hidden = !id;
    $('btnSettings').classList.toggle('on', id === 'menuSettings');
    $('btnHowto').classList.toggle('on', id === 'menuHowto');
  }

  function toTitle() {
    showMenu(null);
    clearWorld();
    game = null;
    setSkyDim(SKY_DIM.title);
    setSkyKind('space');
    screen = 'title';
    paused = false;
    syncMusic();
    els.title.hidden = false; els.result.hidden = true; els.pause.hidden = true; els.controls.hidden = true;
    shipObj = makePlayerShip();
    scene.add(shipObj);
  }

  function setPaused(on) {
    if (screen !== 'play') return;
    paused = on;
    els.pause.hidden = !on;
    if (on) {
      touch.fireIds.clear(); touch.boostIds.clear(); touch.trackIds.clear(); missileIds.clear();
      els.btnFire.classList.remove('on'); els.btnBoost.classList.remove('on'); els.btnTarget.classList.remove('on'); els.btnMissile.classList.remove('on');
      input.stickX = 0; input.stickY = 0; touch.stickId = null; setStickVisual(0, 0, false);
      els.diag.textContent = VERSION + ' · ' + fps.toFixed(0) + 'fps · 画素 x' + pixelRatio.toFixed(2) + ' · ' + W + 'x' + H;
      audio.suspend();
      if (cutinAnim) cutinAnim.pause();
    } else {
      audio.resume();
      if (cutinAnim) cutinAnim.play();
    }
  }

  function showResult() {
    resultShown = true;
    const r = C.result(game);
    els.resultHead.textContent = r.cleared ? 'MISSION CLEAR' : 'MISSION FAILED';
    els.resultHead.classList.toggle('fail', !r.cleared);
    els.resultRank.textContent = r.cleared ? r.rank : '—';
    const mm = Math.floor(r.time / 60), ss = Math.floor(r.time % 60);
    const rows = [
      ['時間', mm + ':' + String(ss).padStart(2, '0')],
      ['撃墜', r.kills + ' 機'],
      ['命中率', Math.round(r.accuracy * 100) + '%'],
      ['被ダメージ', String(Math.round(r.damage))],
      ['スコア', r.score.toLocaleString()],
      ['ボーナス', r.bonus.toLocaleString()]
    ];
    els.resultStats.innerHTML = '';
    rows.forEach(function (row) {
      const dt = document.createElement('dt'); dt.textContent = row[0];
      const dd = document.createElement('dd'); dd.textContent = row[1];
      els.resultStats.append(dt, dd);
    });
    const dt = document.createElement('dt'); dt.textContent = '合計'; dt.className = 'total';
    const dd = document.createElement('dd'); dd.textContent = r.total.toLocaleString(); dd.className = 'total';
    els.resultStats.append(dt, dd);
    els.result.hidden = false;
    els.controls.hidden = true;
    screen = 'result';
    syncMusic();
  }

  /**
   * ボス戦のカットイン: 右から斜めに飛び込み、少し震えながら止まり、左へ抜ける (2.4 秒)。
   * 位置は CSS で決め、動きは element.animate で付ける (同じコマで書き換えると動かないため)
   */
  const CUTIN_MS = 2400;
  let cutinAnim = null;
  let cutinGlow = null;
  function showCutin() {
    const el = $('cutin');
    el.hidden = false;
    if (cutinAnim) cutinAnim.cancel();
    cutinAnim = el.animate([
      { transform: 'translateX(110%) skewX(-18deg)', opacity: 0, offset: 0 },
      { transform: 'translateX(-4%) skewX(-6deg)', opacity: 1, offset: 0.07 },
      { transform: 'translateX(1.5%) skewX(0deg)', opacity: 1, offset: 0.12 },
      { transform: 'translateX(0) skewX(0deg)', opacity: 0.7, offset: 0.15 },
      { transform: 'translateX(0) skewX(0deg)', opacity: 1, offset: 0.17 },
      { transform: 'translate(-0.4%, 0.6%)', opacity: 1, offset: 0.45 },
      { transform: 'translate(0.4%, -0.4%)', opacity: 0.85, offset: 0.47 },
      { transform: 'translateX(0)', opacity: 1, offset: 0.49 },
      { transform: 'translateX(-1%) skewX(4deg)', opacity: 1, offset: 0.86 },
      { transform: 'translateX(-115%) skewX(18deg)', opacity: 0, offset: 1 }
    ], { duration: CUTIN_MS, easing: 'linear' });
    // 帯は光らせる: 赤い光のにじみが脈を打つ (明るさと光の広がりを往復)
    if (cutinGlow) cutinGlow.cancel();
    cutinGlow = el.querySelector('img').animate([
      { filter: 'drop-shadow(0 0 10px rgba(255,40,60,.6)) brightness(1)' },
      { filter: 'drop-shadow(0 0 30px rgba(255,60,80,1)) drop-shadow(0 0 8px rgba(255,200,200,.6)) brightness(1.3)' }
    ], { duration: 380, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
    cutinAnim.onfinish = function () { el.hidden = true; cutinAnim = null; if (cutinGlow) { cutinGlow.cancel(); cutinGlow = null; } };
    shake(1.0);
  }

  // 面の始まりの札 (STAGE n / 英名 / 日本語名)。3 秒。出ている間は、あとから来る知らせ (第1波) を札が消えるまで待たせる
  const STAGE_CARD = {
    1: { en: 'PLANETARY ORBIT', ja: '惑星軌道' },
    2: { en: 'MERCURY ORBIT', ja: '水星軌道' },
    3: { en: 'MARS ORBIT', ja: '火星軌道' },
    4: { en: 'JUPITER ORBIT', ja: '木星軌道' }
  };
  const STAGE_CARD_MS = 3000;
  let stageCardAnim = null;
  function showStageCard(level) {
    const el = $('stageCard'), d = STAGE_CARD[level] || STAGE_CARD[1];
    $('scNum').textContent = 'STAGE ' + level;
    $('scEn').textContent = d.en;
    $('scJa').textContent = d.ja;
    el.hidden = false;
    if (stageCardAnim) stageCardAnim.cancel();
    stageCardAnim = el.animate([
      { opacity: 0, transform: 'scale(.9)', offset: 0 },
      { opacity: 1, transform: 'scale(1)', offset: 0.1 },
      { opacity: 1, transform: 'scale(1.015)', offset: 0.85 },
      { opacity: 0, transform: 'scale(1.04)', offset: 1 }
    ], { duration: STAGE_CARD_MS, easing: 'ease-out' });
    stageCardAnim.onfinish = function () { el.hidden = true; stageCardAnim = null; };
    fx.cardT = STAGE_CARD_MS / 1000;
    audio.lock();
  }

  function banner(text, dur, color, big) {
    // 札が出ている間に来た知らせは、札が消えてから出す
    fx.banners.push({ text: text, t: dur, max: dur, color: color || '#fff', big: !!big, delay: fx.cardT > 0 ? fx.cardT : 0 });
    if (fx.banners.length > 3) fx.banners.shift();
  }

  function shake(amount) {
    if (!settings.shake) return;
    fx.shake = Math.min(2.5, fx.shake + amount);
  }

  // ------------------------------------------------------------ 出来事 → 演出

  function consumeEvents() {
    if (!game) return;
    const pl = game.player;
    for (let i = 0; i < game.events.length; i++) {
      const e = game.events[i];
      switch (e.type) {
        case 'laser': {
          audio.laser();
          const f = new THREE.Vector3(pl.dir.x, pl.dir.y, pl.dir.z);
          spawnParticle(e.pos.x + f.x * 2, e.pos.y + f.y * 2, e.pos.z + f.z * 2, pl.vel.x, pl.vel.y, pl.vel.z, 0.06, 3.5, 1, [0.6, 0.9, 1], [0.2, 0.5, 1]);
          break;
        }
        case 'enemyLaser': case 'turretFire':
          if (dist3(e.pos, pl.pos) < 700) audio.enemyLaser();
          flash(e.pos, e.type === 'turretFire' ? 26 : 10, 0.12, 0xff6040);
          break;
        case 'hit':
          sparks(e.pos, e.by === 'missile' ? 20 : 7, e.kind === 'fighter' ? [1, 0.8, 0.5] : [1, 0.6, 0.3]);
          fx.hitMarker = 0.14;
          audio.hit();
          break;
        case 'spark':
          sparks(e.pos, 4, e.armored ? [0.6, 0.8, 1] : [0.9, 0.8, 0.6]);
          if (e.armored) audio.armored();
          break;
        case 'explode': {
          const size = e.size;
          if (!KILL[e.kind]) explosion(e.pos, size, e.vel);
          const d = dist3(e.pos, pl.pos);
          if (e.kind === 'boss') {
            audio.big();
            shake(2.5);
            fx.slowT = 1.6;
            flash(e.pos, 1600, 1.6, 0xffe0b0);
            for (let k = 0; k < 6; k++) {
              const o = { x: e.pos.x + rnd(-300, 300), y: e.pos.y + rnd(-40, 60), z: e.pos.z + rnd(-60, 60) };
              setTimeout(function () { explosion(o, rnd(4, 8)); }, k * 120);
            }
          } else if (KILL[e.kind]) {
            killBurst(e, d);
          } else {
            audio.explode(size);
            shake(Math.min(1.4, size * 60 / Math.max(60, d)));
          }
          if (KILL[e.kind]) fx.killMarker = 0.35;
          break;
        }
        case 'score':
          fx.popups.push({ text: '+' + e.pts + (e.combo > 1 ? '  x' + e.combo : ''), pos: e.pos, t: 1.2 });
          break;
        case 'missile': audio.missile(e.salvo); break;
        case 'lock': if (e.multi) audio.mlock(e.n); else audio.lock(); break;
        case 'target': audio.ui(); break;
        case 'boost': audio.boost(); fx.fovKick = 1; break;
        case 'playerHit': {
          const big = e.amount >= 20;
          audio.hurt(big);
          shake(big ? 2 : 0.6);
          fx.hurt.push({ from: e.from, t: 0.9 });
          fx.lastHurt = 0.35;
          break;
        }
        case 'scrape': sparks(e.pos, 16, [1, 0.8, 0.4]); break;
        case 'stage': banner(e.text, 2.6, '#cfe8ff'); break;
        case 'stageStart': showStageCard(e.level); bossMusic = false; setTimeout(syncMusic, 0); break;
        case 'waveClear': banner('殲滅', 1.6, '#9fe6ff', true); break;
        case 'bossWarning':
          bossMusic = false;
          setTimeout(syncMusic, 0);
          showCutin();
          audio.bossAlert();
          fx.bossCam = 6;
          break;
        case 'bossPhase':
          banner(e.text, e.phase === 'dying' ? 3 : 3.2, e.phase === 'dying' ? '#ffd27a' : '#ffb26a', e.phase === 'dying');
          if (e.phase === 'dying') { fx.slowT = 1.2; shake(2); }
          break;
        case 'aceWarning':
          banner(e.text, 2.4, '#ff6a5a', true);
          audio.alarm(); setTimeout(audio.alarm, 500);
          break;
        case 'aceDown': banner(e.text, 3, '#ffd27a', true); fx.slowT = 1.0; shake(1.5); break;
        case 'escorts': banner('護衛機 発進', 1.8, '#ff8a7a'); break;
        case 'drones': banner('迎撃機 接近', 1.4, '#ff8a7a'); break;
        case 'bossWarp':
          // 光の中から出はじめる瞬間: 赤い閃光・大きな衝撃波・揺れ・轟音
          flash(e.pos, 900, 0.7, 0xff5040);
          shockRing(e.pos, 1400, 1.0, 0xff6050);
          shake(2.0);
          audio.warp();
          bossMusic = true;
          setTimeout(syncMusic, 0);
          break;
        case 'bossLand': shake(1.0); audio.explode(3); break;
        case 'cannonCharge': audio.charge(); break;
        case 'cannonLock': audio.alarm(); break;
        case 'cannonFire': audio.beam(); shake(1.2); break;
        case 'cannonDodged': banner('回避', 1.0, '#9fe6ff'); break;
        case 'gameOver': shake(2.5); fx.slowT = 1.0; break;
        default: break;
      }
    }
    game.events.length = 0;
  }

  function dist3(a, b) { const x = a.x - b.x, y = a.y - b.y, z = a.z - b.z; return Math.sqrt(x * x + y * y + z * z); }

  // ------------------------------------------------------------ 世界を描きそろえる

  function syncWorld(dt) {
    const pl = game.player;
    // 自機
    shipObj.visible = pl.alive;
    shipObj.position.set(pl.pos.x, pl.pos.y, pl.pos.z);
    shipObj.rotation.order = 'YXZ';
    shipObj.rotation.set(pl.pitch, pl.yaw, pl.roll);
    const thrust = pl.boosting ? 1.9 : 0.6 + pl.throttle * 0.7;
    setThrust(shipObj, thrust);
    // ブースト: 煙の玉ではなく、噴射口から後ろへ飛ぶ小さな光の粒
    if (pl.boosting && pl.alive) {
      const back = { x: pl.pos.x - pl.dir.x * 5.5, y: pl.pos.y - pl.dir.y * 5.5, z: pl.pos.z - pl.dir.z * 5.5 };
      for (let k = 0; k < 2; k++) {
        const sx = (k ? 1 : -1) * 1.55;
        spawnParticle(back.x + rnd(-0.3, 0.3) + sx * Math.cos(pl.yaw), back.y + rnd(-0.3, 0.3), back.z + rnd(-0.3, 0.3) - sx * Math.sin(pl.yaw),
          pl.vel.x * 0.5 + rnd(-3, 3), pl.vel.y * 0.5 + rnd(-3, 3), pl.vel.z * 0.5 + rnd(-3, 3), rnd(0.15, 0.28), 0.6, 0.05, [0.9, 0.97, 1], [0.3, 0.55, 1]);
      }
    }

    // 敵戦闘機
    const seen = new Set();
    game.fighters.forEach(function (f) {
      seen.add(f.id);
      let o = enemyObjs.get(f.id);
      if (!o) {
        o = makeEnemyShip(f.ace);
        if (f.drone) o.scale.setScalar(0.6); // ドローンは小さく
        if (f.ace) o.scale.setScalar(C.TUNING.aceScale); // エース機は大きく
        enemyObjs.set(f.id, o); scene.add(o);
      }
      o.position.set(f.pos.x, f.pos.y, f.pos.z);
      const yp = C.yawPitchOf(f.dir);
      o.rotation.order = 'YXZ';
      o.rotation.set(yp.pitch, yp.yaw, f.bank * 0.9);
      const eb = f.ace ? 0.16 : 0; // エース機は赤い地の光を残す
      o.userData.mats.forEach(function (m) { m.emissive.setRGB(eb + f.flash * 1.2, f.flash * 0.9, f.flash * 0.7); });
    });
    enemyObjs.forEach(function (o, id) {
      if (!seen.has(id)) { scene.remove(o); enemyObjs.delete(id); }
    });

    // ミサイル: 炎と光の跡を出す
    game.missiles.forEach(function (m) {
      spawnParticle(m.pos.x, m.pos.y, m.pos.z, 0, 0, 0, 0.12, 4, 1, [1, 0.9, 0.6], [1, 0.4, 0.1]);
      // 煙ではなく、細く消えていく光の跡
      spawnParticle(m.pos.x, m.pos.y, m.pos.z, rnd(-0.5, 0.5), rnd(-0.5, 0.5), rnd(-0.5, 0.5), 0.45, 1.1, 0.15, [1, 0.62, 0.3], [0.5, 0.12, 0.04]);
    });

    // 戦艦
    const b = game.boss;
    if (b && b.phase !== 'dead') {
      if (!bossObj) { bossObj = makeBossModel(b.level, b.type); bossObj.userData.level = b.level; clipBoss(bossObj); scene.add(bossObj); }
      const u = bossObj.userData;
      // ワープの登場: カットインの間に右側 (+x) に赤い光が開き、艦はその光の中から艦首を先にゆっくり出てくる。
      // 光の面より向こうにある部分は描かない (bossClip)
      const arriving = b.phase === 'arrive';
      bossObj.visible = !arriving || b.shown;
      bossObj.position.set(b.pos.x, b.pos.y, b.pos.z);
      bossObj.scale.setScalar(b.size || 1);
      bossObj.rotation.y = b.rot || 0;     // 木星要塞はゆっくり回る (戦艦は 0)
      bossClip.constant = arriving ? b.portal.x : 1e9;
      const TM = C.BOSS_TIMING;
      if (arriving) {
        const open = Math.min(1, b.arriveT / TM.delay);                                        // 開いていく
        const close = Math.max(0, (b.arriveT - TM.delay - TM.emerge) / (TM.arrive - TM.delay - TM.emerge)); // 出きったら閉じる
        const flick = 0.85 + 0.15 * Math.sin(b.arriveT * 37);
        const size = (160 + 640 * open * open) * (1 - close) * (b.size || 1);
        warpGlow.visible = size > 1;
        warpGlow.position.set(b.portal.x, b.portal.y, b.portal.z);
        warpGlow.scale.setScalar(Math.max(1, size));
        warpGlow.material.opacity = (0.4 + 0.6 * open) * flick;
        warpCore.scale.setScalar(0.1 + 0.12 * open);
        warpCore.material.opacity = open * open * flick;
        warpRing.scale.setScalar(0.55 + 0.08 * Math.sin(b.arriveT * 6));
        warpRing.material.opacity = 0.8 * open * flick;
        if (b.shown && b.emerge < 1) {
          // 艦が光の面をくぐる所に、赤い火花がこぼれる
          for (let i = 0; i < 5; i++) {
            spawnParticle(b.portal.x, b.portal.y + rnd(-70, 70), b.portal.z + rnd(-120, 120), rnd(-60, -10), rnd(-15, 15), rnd(-15, 15), rnd(0.3, 0.7), rnd(6, 12), 1, [1, 0.6, 0.5], [0.8, 0.08, 0.05], 1);
          }
        }
      } else warpGlow.visible = false;
      u.armor.visible = b.armor;
      b.parts.forEach(function (p, i) {
        const o = u.parts[i];
        const fl = p.flash;
        if (p.kind === 'turret') {
          o.visible = true;
          if (p.alive) {
            const local = new THREE.Vector3(pl.pos.x, pl.pos.y, pl.pos.z);
            o.worldToLocal(local);
            const h = o.userData.head;
            h.rotation.order = 'YXZ';
            h.rotation.y = Math.atan2(-(local.x - h.position.x), -(local.z - h.position.z));
            h.rotation.x = Math.atan2(local.y - h.position.y, Math.hypot(local.x - h.position.x, local.z - h.position.z));
            o.userData.mat.emissive.setRGB(fl, fl * 0.7, fl * 0.5);
          } else if (!o.userData.dead) {
            o.userData.dead = true;
            o.userData.head.visible = false;
            o.userData.mat.color.setRGB(0.08, 0.07, 0.07);
          }
          // 壊れた砲台: 煙ではなく、ときどき火花が噴き出す
          if (!p.alive && Math.random() < dt * 6) {
            spawnParticle(p.pos.x + rnd(-4, 4), p.pos.y + rnd(-2, 2), p.pos.z + rnd(-4, 4), p.face.x * 30 + rnd(-12, 12), p.face.y * 30 + rnd(-12, 12), p.face.z * 30 + rnd(-12, 12), rnd(0.3, 0.7), 2.2, 0.3, [1, 0.75, 0.4], [0.9, 0.2, 0.05], 1.5);
          }
        } else if (p.kind === 'engine') {
          const g = o.userData.glow;
          if (!p.alive) {
            g.visible = false;
            o.userData.disc.material.color.setRGB(0.05, 0.03, 0.03);
            o.userData.mat.color.setRGB(0.08, 0.07, 0.07);
          } else if (p.active) {
            // 弱点: 赤熱して脈打つ
            const pulse = 0.7 + 0.3 * Math.sin(game.t * 8);
            g.material.color.setRGB(1, 0.35, 0.2);
            g.scale.setScalar(80 * pulse);
            o.userData.disc.material.color.setRGB(1, 0.5 + fl * 0.5, 0.2 + fl * 0.6);
            o.userData.mat.emissive.setRGB(0.3 * pulse + fl, 0.05 + fl * 0.6, fl * 0.4);
          }
        } else {
          // 戦艦のコアは装甲が外れるまで隠れている。要塞のコアは、光の盾 (半透明) の奥に最初から見える
          o.visible = p.alive && (!b.armor || u.type === 'fortress');
          if (o.visible) {
            const pulse = 0.75 + 0.25 * Math.sin(game.t * 10);
            o.userData.glow.scale.setScalar(90 * pulse);
            o.userData.coreMesh.rotation.y += dt * 1.5;
            o.userData.coreMesh.rotation.x += dt * 0.7;
            o.userData.coreMesh.material.emissive.setRGB(0.5 + fl, 0.06 + fl * 0.7, 0.12 + fl * 0.6);
          }
        }
      });
      // 噴射: 来るときは強く
      u.thrusters.forEach(function (t) {
        const s = (b.phase === 'arrive' ? 70 : 42) * (0.9 + Math.random() * 0.2) * (aliveEngines(b) / 2 * 0.7 + 0.3);
        t.scale.setScalar(s);
      });
      // 真ん中の輪: ゆっくり脈打つ。コアがむき出しになったら強く速く
      const exposed = !b.armor;
      const beat = 0.75 + 0.25 * Math.sin(game.t * (exposed ? 9 : 2.5));
      u.topGlow.material.opacity = (exposed ? 0.85 : 0.5) * beat;
      u.topGlow.scale.setScalar((exposed ? 230 : 190) * (0.95 + 0.05 * beat));
      u.sideRings.forEach(function (gl) { gl.material.opacity = 0.45 * beat; });
      if (u.drill) u.drill.rotation.x += dt * (exposed ? 2.2 : 0.9);   // 採掘母艦: ドリルが回る (動力炉がむき出しになると速く)
      if (u.storm) {
        // 要塞: 赤い嵐の渦がゆっくり回り、光の盾が揺らぐ
        u.stormDisc.rotation.z += dt * (exposed ? 1.4 : 0.5);
        u.dome.material.opacity = 0.42 + 0.16 * Math.sin(game.t * 3.1) + 0.05 * Math.sin(game.t * 17);
      }
      // 主砲
      const c = b.cannon;
      const from = new THREE.Vector3(c.from.x, c.from.y, c.from.z);
      const dir = new THREE.Vector3(c.dir.x, c.dir.y, c.dir.z);
      _q.setFromUnitVectors(_f.set(0, 0, 1), dir); _f.set(0, 0, -1);
      if (c.state === 'charge') {
        const k = c.t / K.cannonCharge;
        u.charge.material.opacity = 0.5 + k * 0.5;
        u.charge.scale.setScalar(10 + k * 70 + Math.random() * 8);
        const locked = c.t >= K.cannonCharge - K.cannonLockBefore;
        u.guide.visible = true;
        u.guide.position.copy(from); u.guide.quaternion.copy(_q);
        const w = locked ? 2.2 : 0.8;
        u.guide.scale.set(w, w, K.cannonLength);
        u.guide.material.opacity = locked ? (0.5 + 0.5 * Math.sin(game.t * 40)) : 0.25;
        // 吸い込まれる光の粒
        if (Math.random() < 0.6) {
          const d = rndDir();
          spawnParticle(from.x + d[0] * 60, from.y + d[1] * 60, from.z + d[2] * 60, -d[0] * 70, -d[1] * 70, -d[2] * 70, 0.8, 4, 1, [1, 0.4, 0.3], [1, 0.9, 0.8]);
        }
      } else {
        u.guide.visible = false;
        u.charge.material.opacity = Math.max(0, u.charge.material.opacity - dt * 3);
      }
      if (c.state === 'fire') {
        const k = c.t / K.cannonFire;
        const a = k < 0.1 ? k / 0.1 : 1 - Math.max(0, (k - 0.6) / 0.4);
        [u.beamOuter, u.beamCore].forEach(function (m, i) {
          m.visible = true;
          m.position.copy(from); m.quaternion.copy(_q);
          const r = (i === 0 ? K.cannonRadius * 1.6 : K.cannonRadius * 0.5) * (0.9 + Math.random() * 0.2);
          m.scale.set(r, r, K.cannonLength);
          m.material.opacity = a * (i === 0 ? 0.7 : 1);
        });
      } else {
        u.beamOuter.visible = false; u.beamCore.visible = false;
      }
    } else if (bossObj && (!b || b.phase === 'dead')) {
      scene.remove(bossObj);
      ['beamOuter', 'beamCore', 'guide'].forEach(function (k) { scene.remove(bossObj.userData[k]); });
      bossObj = null;
    }

    drawBolts(game.shots, 'player', playerBolts, playerBoltsGlow);
    drawBolts(game.shots, 'enemy', enemyBolts, enemyBoltsGlow);
  }

  function aliveEngines(b) {
    let n = 0;
    b.parts.forEach(function (p) { if (p.kind === 'engine' && p.alive) n++; });
    return n;
  }

  // ------------------------------------------------------------ カメラ

  const _up = new THREE.Vector3(), _look = new THREE.Vector3(), _tmp = new THREE.Vector3();
  function updateCamera(dt, realDt) {
    const pl = game.player;
    const dir = _d.set(pl.dir.x, pl.dir.y, pl.dir.z);
    // 向きは少し遅れて追う (旋回が見える)
    const k = 1 - Math.exp(-dt * 6.5);
    cam.dir.lerp(dir, k).normalize();
    const boost = pl.boosting ? 1 : 0;
    fx.bossCam = Math.max(0, fx.bossCam - realDt);
    const bossK = fx.bossCam > 0 ? Math.min(1, fx.bossCam / 1.5) : 0;
    cam.back = C.approach(cam.back, 19 + boost * 7 + bossK * 26, 3, realDt);
    const height = 5.6 + bossK * 10;
    const targetFov = 66 + (pl.speed - 60) * 0.06 + boost * 12 + bossK * 8;
    cam.fov = C.approach(cam.fov, targetFov, 4, realDt);
    fx.fovKick = Math.max(0, fx.fovKick - realDt * 3);
    camera.fov = cam.fov + fx.fovKick * 5;
    camera.updateProjectionMatrix();

    _up.set(0, 1, 0);
    const right = _tmp.crossVectors(cam.dir, _up).normalize();
    const camUp = new THREE.Vector3().crossVectors(right, cam.dir).normalize();
    cam.pos.set(pl.pos.x, pl.pos.y, pl.pos.z).addScaledVector(cam.dir, -cam.back).addScaledVector(camUp, height);
    _look.set(pl.pos.x, pl.pos.y, pl.pos.z).addScaledVector(cam.dir, 40).addScaledVector(camUp, height * 0.35);
    // 戦艦の登場: 大きさが分かるよう、そちらを少し見る
    if (bossK > 0 && game.boss) {
      const bp = game.boss.phase === 'arrive' ? game.boss.at : game.boss.pos; // 登場の間は現れる所を見る
      _tmp.set(bp.x, bp.y, bp.z);
      _look.lerp(_tmp, (game.boss.phase === 'arrive' ? 0.4 : 0.25) * bossK);
    }
    camera.position.copy(cam.pos);
    // 傾き: 機体の傾きを少しだけ
    cam.roll = C.approach(cam.roll, pl.roll * 0.3, 5, realDt);
    camera.up.copy(camUp).applyAxisAngle(cam.dir, cam.roll);
    camera.lookAt(_look);
    // ゆれ
    if (fx.shake > 0) {
      const s = fx.shake * fx.shake * 0.35;
      camera.position.x += rnd(-s, s); camera.position.y += rnd(-s, s);
      camera.rotateZ(rnd(-s, s) * 0.01);
      fx.shake = Math.max(0, fx.shake - realDt * 3.2);
    }
    sky.position.copy(camera.position);
    planet.position.copy(camera.position).multiplyScalar(0.85).add(planet.userData.offset);
    planet.quaternion.copy(camera.quaternion);
    planet.visible = true; titlePlanet.visible = false; titleGlow.visible = false;
    setPlanetKind(['earth', 'earth', 'mercury', 'mars', 'jupiter'][game.level] || 'earth');
    setSkyKind(['space', 'space', 'space2', 'space3', 'space4'][game.level] || 'space');
  }

  // 見本と見比べる用: 機体だけを決まった向きから写す (テストから __app.inspect で使う)
  let inspectView = null;
  const inspectLight = new THREE.DirectionalLight(0xffffff, 1.6);
  inspectLight.visible = false;
  scene.add(inspectLight);
  const INSPECT = {
    side: { pos: [-30, 0, 0], up: [0, 1, 0] },
    top: { pos: [0, 30, 0.001], up: [1, 0, 0] },
    front: { pos: [0, 0.5, -30], up: [0, 1, 0] },
    rear: { pos: [-14, 9, 16], up: [0, 1, 0] },
    // アプリのアイコン用: 斜め後ろ上から、噴射を長く (icon-shot.js が背景の色を変えて 2 回写す)
    icon: { pos: [-9, 10, 15], up: [0, 1, 0], rot: [0.05, 0.1, -0.5], k: 1.25, thrust: 1.9 },
    // 木星要塞の確認用 (正面 = 主砲の面 -x、斜め前方、上、横、後ろ)。暗い背景
    fortFront: { pos: [-1, 0.12, 0], up: [0, 1, 0], k: 0.95, bg: 0x07070c },
    fortOblique: { pos: [-1, 0.5, -0.8], up: [0, 1, 0], k: 0.95, bg: 0x07070c },
    fortTop: { pos: [0, 1, 0.001], up: [1, 0, 0], k: 0.95, bg: 0x07070c },
    fortSide: { pos: [0, 0.15, 1], up: [0, 1, 0], k: 0.95, bg: 0x07070c },
    fortRear: { pos: [1, 0.35, 0.5], up: [0, 1, 0], k: 0.95, bg: 0x07070c }
  };
  let inspectObj = null;
  function renderInspect() {
    const v = INSPECT[inspectView];
    const obj = inspectObj || shipObj;
    obj.position.set(0, 0, 0);
    obj.rotation.order = 'YXZ';
    obj.rotation.set(v.rot ? v.rot[0] : 0, v.rot ? v.rot[1] : 0, v.rot ? v.rot[2] : 0);
    obj.updateMatrixWorld(true);
    // 写す物の大きさに合わせて離れる (機体は 30m、戦艦はその 22 倍ほど)。噴射の光は大きさに入れない
    const box3 = new THREE.Box3().setFromObject(obj.userData.body || obj);
    const center = box3.getCenter(new THREE.Vector3());
    const dist = box3.getSize(new THREE.Vector3()).length() * (v.k || 1.75);
    camera.position.set(v.pos[0], v.pos[1], v.pos[2]).normalize().multiplyScalar(dist).add(center);
    camera.far = Math.max(30000, dist * 4);
    camera.up.set(v.up[0], v.up[1], v.up[2]);
    camera.fov = 30; camera.updateProjectionMatrix();
    camera.lookAt(center);
    sky.visible = !!v.sky; planet.visible = !!v.planet; dust.lines.visible = false; titlePlanet.visible = false; titleGlow.visible = false;
    if (v.sky) { sky.position.copy(camera.position); planet.position.copy(camera.position).multiplyScalar(0.85).add(planet.userData.offset); }
    if (v.thrust && obj === shipObj) setThrust(shipObj, v.thrust);
    inspectLight.visible = true;
    inspectLight.position.copy(camera.position);
    scene.background = v.sky ? null : new THREE.Color(v.bg !== undefined ? v.bg : 0xd400c8);
    renderer.render(scene, camera);
    hud.setTransform(1, 0, 0, 1, 0, 0);
    hud.clearRect(0, 0, els.hud.width, els.hud.height);
  }

  function updateTitleCamera(dt) {
    titleT += dt;
    shipObj.position.set(0, 0, 0);
    shipObj.rotation.order = 'YXZ';
    shipObj.rotation.set(0.05 * Math.sin(titleT * 0.7), -0.15, 0.12 * Math.sin(titleT * 0.5));
    setThrust(shipObj, 1);
    // 斜め後ろの右上から (噴射の光が見える向き)。ゆっくり少しだけ回り込む
    const TS = TITLE_SHIP;
    const a = TS.a + Math.sin(titleT * 0.12) * 0.12;
    camera.position.set(Math.sin(a) * TS.dist, TS.y0 + Math.sin(titleT * 0.2) * 1.2, Math.cos(a) * TS.dist);
    camera.up.set(0, 1, 0);
    camera.fov = 52; camera.updateProjectionMatrix();
    // 機体が画面の右下寄り (x・y は TITLE_SHIP) に来るよう、見る所をずらす
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const d = camera.position.length();
    const halfH = Math.tan(camera.fov * Math.PI / 360) * d, halfW = halfH * camera.aspect;
    const sx = TS.x * 2 - 1, sy = 1 - TS.y * 2;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    camera.lookAt(right.multiplyScalar(-sx * halfW).add(up.multiplyScalar(-sy * halfH)));
    sky.position.copy(camera.position);
    planet.visible = false;   // タイトルは大きな惑星の絵だけ (ゲームの地球は出さない)
    placeTitlePlanet();
    updateDust(camera.position, new THREE.Vector3(0, 0, -40));
  }

  // ------------------------------------------------------------ 計器 (2D)

  const _v = new THREE.Vector3();
  /** 世界の点 → 画面の点。カメラの後ろなら behind。 */
  function toScreen(p) {
    _v.set(p.x, p.y, p.z);
    const behind = _tmp.set(p.x - camera.position.x, p.y - camera.position.y, p.z - camera.position.z).dot(camera.getWorldDirection(_up)) < 0;
    _v.project(camera);
    return { x: (_v.x * 0.5 + 0.5) * W, y: (-_v.y * 0.5 + 0.5) * H, behind: behind };
  }

  const hudInfo = { reticle: null, focusLead: null, markers: 0, brackets: [], arrows: [], gauges: [] };

  function drawHud(dt) {
    const c = hud;
    c.setTransform(hudScale, 0, 0, hudScale, 0, 0);
    c.clearRect(0, 0, W, H);
    if (!game) return;
    const pl = game.player;
    const sal = 59, sar = 59;     // iPhone 16 Plus 横向きの左右の安全域 (決め打ち)
    c.lineCap = 'round';
    c.lineJoin = 'round';

    // 被弾: 画面のふちを赤く
    if (fx.lastHurt > 0) {
      const a = fx.lastHurt;
      const g = c.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.62);
      g.addColorStop(0, 'rgba(255,40,40,0)');
      g.addColorStop(1, 'rgba(255,40,40,' + (a * 0.9).toFixed(3) + ')');
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
      fx.lastHurt = Math.max(0, fx.lastHurt - dt);
    }
    // ブースト: 周りに速度の線
    if (pl.boosting) {
      c.strokeStyle = 'rgba(160,210,255,.18)';
      c.lineWidth = 1.5;
      for (let i = 0; i < 18; i++) {
        const a = Math.random() * Math.PI * 2, r0 = H * (0.45 + Math.random() * 0.2), r1 = r0 + 40 + Math.random() * 80;
        c.beginPath();
        c.moveTo(W / 2 + Math.cos(a) * r0 * 1.6, H / 2 + Math.sin(a) * r0);
        c.lineTo(W / 2 + Math.cos(a) * r1 * 1.6, H / 2 + Math.sin(a) * r1);
        c.stroke();
      }
    }

    if (pl.alive && game.state !== 'clear') {
      // 敵のしるし
      const ts = C.targets(game);
      let markers = 0;
      hudInfo.brackets = []; hudInfo.arrows = [];
      const near = nearestPart(ts, pl);
      camera.updateMatrixWorld();
      const view = camera.matrixWorldInverse;
      ts.forEach(function (t) {
        const s = toScreen(t.pos);
        const d = dist3(t.pos, pl.pos);
        const isFocus = pl.focus && pl.focus.target === t;
        const isTarget = pl.targetId === t.id;
        const col = isTarget ? '255,214,106' : t.kind === 'fighter' ? '255,90,90' : t.kind === 'turret' ? '255,170,80' : '255,80,200';
        const on = !s.behind && s.x > 10 && s.x < W - 10 && s.y > 10 && s.y < H - 10;
        if (on) {
          markers++;
          hudInfo.brackets.push({ id: t.id, x: s.x, y: s.y });
          const size = Math.max(9, Math.min(40, t.radius * 900 / Math.max(d, 1) * (H / 430))) + (isTarget ? 5 : 0);
          c.strokeStyle = 'rgba(' + col + ',' + (isFocus || isTarget ? 0.95 : 0.6) + ')';
          c.lineWidth = isTarget ? 2.6 : isFocus ? 2 : 1.4;
          const q = size * 0.45;
          c.beginPath();
          [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (k) {
            c.moveTo(s.x + k[0] * size, s.y + k[1] * size - k[1] * q);
            c.lineTo(s.x + k[0] * size, s.y + k[1] * size);
            c.lineTo(s.x + k[0] * size - k[0] * q, s.y + k[1] * size);
          });
          c.stroke();
          if (isTarget) {
            // 狙う相手: 上に小さな三角の札
            c.fillStyle = 'rgba(' + col + ',.95)';
            c.beginPath(); c.moveTo(s.x, s.y - size - 4); c.lineTo(s.x - 6, s.y - size - 13); c.lineTo(s.x + 6, s.y - size - 13); c.closePath(); c.fill();
          }
          if (isFocus || isTarget) {
            // 体力と距離
            c.fillStyle = 'rgba(' + col + ',.95)';
            c.font = '600 10px -apple-system, sans-serif';
            c.textAlign = 'left';
            c.fillText(Math.round(d) + 'm', s.x + size + 4, s.y - size + 8);
            const hpw = size * 2;
            c.fillStyle = 'rgba(0,0,0,.45)';
            c.fillRect(s.x - size, s.y + size + 4, hpw, 3);
            c.fillStyle = 'rgba(' + col + ',.95)';
            c.fillRect(s.x - size, s.y + size + 4, hpw * t.hp / t.maxHp, 3);
          }
        } else if (t.kind === 'fighter' || isTarget || (game.boss && t === near)) {
          // 画面の外: ふちに三角。向きはカメラから見た向き (横 x・上 y) で出す。
          // 画面に映した位置から出すと、真後ろの物ほど向きがでたらめになる
          _v.set(t.pos.x, t.pos.y, t.pos.z).applyMatrix4(view);
          let dx = _v.x, dy = -_v.y;
          if (Math.abs(dx) + Math.abs(dy) < 1e-3) dy = 1;     // 真後ろ: 下を指す
          const ang = Math.atan2(dy, dx);
          // ボタンに隠れない楕円に並べる (右下のボタン群の内側)
          const rx = W / 2 - 200, ry = H / 2 - 58;
          const ex = W / 2 + Math.cos(ang) * rx, ey = H / 2 + Math.sin(ang) * ry;
          hudInfo.arrows.push({ id: t.id, x: ex, y: ey, target: isTarget });
          c.save();
          c.translate(ex, ey); c.rotate(ang);
          c.fillStyle = 'rgba(' + col + ',.9)';
          const k = isTarget ? 1.6 : 1;
          c.beginPath(); c.moveTo(12 * k, 0); c.lineTo(-4 * k, -8 * k); c.lineTo(-1 * k, 0); c.lineTo(-4 * k, 8 * k); c.closePath(); c.fill();
          c.restore();
          if (isTarget) {
            c.fillStyle = 'rgba(' + col + ',.95)';
            c.font = '700 11px -apple-system, sans-serif';
            c.textAlign = 'center';
            c.fillText(Math.round(d) + 'm', ex - Math.cos(ang) * 22, ey - Math.sin(ang) * 22 + 4);
          }
        }
      });
      hudInfo.markers = markers;

      // 偏差の印 (ここを撃てば当たる)
      hudInfo.focusLead = null;
      if (pl.focus) {
        const s = toScreen(pl.focus.lead);
        const t = toScreen(pl.focus.target.pos);
        if (!s.behind) {
          hudInfo.focusLead = s;
          const assist = !!pl.assist;
          c.strokeStyle = assist ? 'rgba(255,90,90,.95)' : 'rgba(255,220,120,.9)';
          c.lineWidth = 1.6;
          if (!t.behind) {
            c.setLineDash([3, 4]);
            c.beginPath(); c.moveTo(t.x, t.y); c.lineTo(s.x, s.y); c.stroke();
            c.setLineDash([]);
          }
          const r = 7;
          c.beginPath(); c.moveTo(s.x, s.y - r); c.lineTo(s.x + r, s.y); c.lineTo(s.x, s.y + r); c.lineTo(s.x - r, s.y); c.closePath(); c.stroke();
          c.beginPath(); c.arc(s.x, s.y, 1.6, 0, Math.PI * 2); c.fillStyle = c.strokeStyle; c.fill();
        }
      }

      // ロックオン
      if (pl.lockId && pl.lockT > 0 && !missileHeld() && pl.mlock.length === 0) {
        const t = C.targets(game).find(function (x) { return x.id === pl.lockId; });
        if (t) {
          const s = toScreen(t.pos);
          if (!s.behind) {
            const k = Math.min(1, pl.lockT / K.lockTime);
            const r = pl.locked ? 18 : 46 - k * 28;
            c.save();
            c.translate(s.x, s.y);
            c.rotate(pl.locked ? game.t * 3 : Math.PI / 4 * (1 - k));
            c.strokeStyle = pl.locked ? 'rgba(255,60,70,1)' : 'rgba(255,120,120,' + (0.4 + k * 0.5) + ')';
            c.lineWidth = pl.locked ? 2.4 : 1.6;
            c.strokeRect(-r, -r, r * 2, r * 2);
            c.restore();
            if (pl.locked) {
              c.fillStyle = 'rgba(255,70,80,1)';
              c.font = '800 11px -apple-system, sans-serif';
              c.textAlign = 'center';
              c.fillText('LOCK', s.x, s.y - 26);
            }
          }
        }
      }

      // マルチロック: 押している間は捕まえる範囲の輪、捕まえた敵には数つきの赤い菱形、捕まえかけの敵には縮む枠
      hudInfo.mlock = [];
      if (missileHeld() || pl.mlock.length > 0) {
        const ts = C.targets(game);
        if (missileHeld()) {
          const ap = toScreen({ x: pl.pos.x + pl.dir.x * 300, y: pl.pos.y + pl.dir.y * 300, z: pl.pos.z + pl.dir.z * 300 });
          if (!ap.behind) {
            const rr = (H / 2) * Math.tan(K.multiCone) / Math.tan(camera.fov * Math.PI / 360);
            hudInfo.mlockRing = rr;
            c.strokeStyle = 'rgba(255,90,100,.35)'; c.lineWidth = 1.2;
            c.setLineDash([6, 8]);
            c.beginPath(); c.arc(ap.x, ap.y, rr, 0, Math.PI * 2); c.stroke();
            c.setLineDash([]);
          }
          if (pl.mlockCand && pl.mlockT > 0) {
            const t = ts.find(function (x) { return x.id === pl.mlockCand; });
            const s = t && toScreen(t.pos);
            if (s && !s.behind) {
              const k = Math.min(1, pl.mlockT / K.multiLockTime);
              const r = 34 - k * 18;
              c.save(); c.translate(s.x, s.y); c.rotate(Math.PI / 4 * (1 - k));
              c.strokeStyle = 'rgba(255,120,120,' + (0.4 + k * 0.5) + ')'; c.lineWidth = 1.6;
              c.strokeRect(-r, -r, r * 2, r * 2);
              c.restore();
            }
          }
        }
        const counts = new Map();
        pl.mlock.forEach(function (id) { counts.set(id, (counts.get(id) || 0) + 1); });
        counts.forEach(function (n, id) {
          const t = ts.find(function (x) { return x.id === id; });
          const s = t && toScreen(t.pos);
          if (!s || s.behind) return;
          hudInfo.mlock.push({ id: id, n: n, x: s.x, y: s.y });
          const r = 15;
          c.save(); c.translate(s.x, s.y); c.rotate(game.t * 2.5);
          c.strokeStyle = 'rgba(255,60,70,1)'; c.lineWidth = 2.4;
          c.beginPath(); c.moveTo(0, -r); c.lineTo(r, 0); c.lineTo(0, r); c.lineTo(-r, 0); c.closePath(); c.stroke();
          c.restore();
          // 字は重なりやすいので、同じ敵に 2 発以上のときだけ数を添える
          if (n > 1) {
            c.fillStyle = 'rgba(255,70,80,1)';
            c.font = '800 12px -apple-system, sans-serif';
            c.textAlign = 'left';
            c.fillText('x' + n, s.x + 17, s.y - 10);
          }
        });
      }

      // 照準 (機首の先)
      const aimP = { x: pl.pos.x + pl.dir.x * 300, y: pl.pos.y + pl.dir.y * 300, z: pl.pos.z + pl.dir.z * 300 };
      const r = toScreen(aimP);
      hudInfo.reticle = r;
      const assist = !!pl.assist;
      c.strokeStyle = assist ? 'rgba(255,110,110,.95)' : 'rgba(170,230,255,.9)';
      c.lineWidth = 1.8;
      const R = 17;
      c.beginPath();
      for (let i = 0; i < 4; i++) {
        const a0 = i * Math.PI / 2 + 0.35, a1 = (i + 1) * Math.PI / 2 - 0.35;
        c.moveTo(r.x + Math.cos(a0) * R, r.y + Math.sin(a0) * R);
        c.arc(r.x, r.y, R, a0, a1);
      }
      c.stroke();
      c.beginPath(); c.arc(r.x, r.y, 2, 0, Math.PI * 2); c.fillStyle = c.strokeStyle; c.fill();
      // 当たった印
      if (fx.hitMarker > 0 || fx.killMarker > 0) {
        const kill = fx.killMarker > 0;
        const a = kill ? fx.killMarker / 0.35 : fx.hitMarker / 0.14;
        const L = kill ? 14 : 8, o = kill ? 9 : 7;
        c.strokeStyle = kill ? 'rgba(255,210,90,' + a + ')' : 'rgba(255,255,255,' + a + ')';
        c.lineWidth = kill ? 3 : 2;
        c.beginPath();
        [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(function (k) {
          c.moveTo(r.x + k[0] * o, r.y + k[1] * o);
          c.lineTo(r.x + k[0] * (o + L), r.y + k[1] * (o + L));
        });
        c.stroke();
        fx.hitMarker = Math.max(0, fx.hitMarker - dt);
        fx.killMarker = Math.max(0, fx.killMarker - dt);
      }
    }

    // 被弾した向き
    fx.hurt = fx.hurt.filter(function (h) { return (h.t -= dt) > 0; });
    fx.hurt.forEach(function (h) {
      if (!h.from) return;
      const s = toScreen(h.from);
      let dx = s.x - W / 2, dy = s.y - H / 2;
      if (s.behind) { dx = -dx; dy = -dy; if (Math.abs(dx) + Math.abs(dy) < 1) dy = 1; }
      const ang = Math.atan2(dy, dx);
      c.strokeStyle = 'rgba(255,60,60,' + (h.t / 0.9) + ')';
      c.lineWidth = 5;
      c.beginPath();
      c.ellipse(W / 2, H / 2, 150, 110, 0, ang - 0.35, ang + 0.35);
      c.stroke();
    });

    // 得点の数字
    fx.popups = fx.popups.filter(function (p) { return (p.t -= dt) > 0; });
    c.textAlign = 'center';
    fx.popups.forEach(function (p) {
      const s = toScreen(p.pos);
      if (s.behind) return;
      const a = Math.min(1, p.t / 0.4);
      c.font = '800 15px -apple-system, sans-serif';
      c.fillStyle = 'rgba(255,215,110,' + a + ')';
      c.fillText(p.text, s.x, s.y - 24 - (1.2 - p.t) * 30);
    });

    // 左上: シールド・装甲・ブースト
    // 左上: シールド・機体・ブーストのゲージ (送ってもらった絵の枠に、目盛りを描く)
    const gx = sal - 2, gy = 6;
    let gyy = gy;
    gyy += drawGauge(c, 0, gx, gyy, pl.shield / K.shieldMax, false) + 1;
    gyy += drawGauge(c, 1, gx, gyy, pl.hull / K.hullMax, pl.hull < 35 && Math.sin(game.t * 10) > 0) + 1;
    drawGauge(c, 2, gx, gyy, pl.boost / 100, false, pl.boosting);
    // 速度
    c.textAlign = 'left';
    c.font = '700 12px -apple-system, sans-serif';
    c.fillStyle = 'rgba(200,225,255,.9)';
    c.fillText(Math.round(pl.speed) + ' m/s', sal + 8, H - 14);
    // 速さは自動。急旋回で減速しているときは、そう出す
    if ((pl.autoSlow || 0) > 0.3) {
      c.fillStyle = 'rgba(255,214,106,' + Math.min(1, pl.autoSlow * 1.4).toFixed(2) + ')';
      c.fillText('減速  小回り', sal + 64, H - 14);
    }

    // 右上: スコア
    c.textAlign = 'right';
    c.font = '700 18px -apple-system, sans-serif';
    c.fillStyle = '#fff';
    c.fillText(game.stats.score.toLocaleString(), W - sar - 60, 26);
    if (game.stats.combo > 1) {
      c.font = '800 12px -apple-system, sans-serif';
      c.fillStyle = '#ffd27a';
      c.fillText('COMBO x' + game.stats.combo, W - sar - 60, 42);
    }

    // 上の真ん中: 戦艦の体力
    const b = game.boss;
    if (b && b.phase !== 'dead') {
      let hp = 0, max = 0;
      b.parts.forEach(function (p) { hp += Math.max(0, p.hp); max += p.maxHp; });
      const bw = 260, bx = W / 2 - bw / 2;
      c.textAlign = 'center';
      c.font = '700 10px -apple-system, sans-serif';
      c.fillStyle = 'rgba(255,190,170,.95)';
      const phaseName = C.BOSS_TYPES[b.type].phaseNames[b.phase] || '';
      c.fillText(C.BOSS_TYPES[b.type].name + '  ' + phaseName, W / 2, 14);
      c.fillStyle = 'rgba(0,0,0,.5)';
      c.fillRect(bx, 19, bw, 5);
      c.fillStyle = '#ff5a5a';
      c.fillRect(bx, 19, bw * hp / max, 5);
      // 主砲の予告
      if (b.cannon.state === 'charge') {
        const locked = b.cannon.t >= K.cannonCharge - K.cannonLockBefore;
        if (locked || Math.sin(game.t * 18) > 0) {
          c.font = '800 16px -apple-system, sans-serif';
          c.fillStyle = locked ? '#ff3a3a' : '#ff8a5a';
          c.fillText(locked ? '主砲 発射  よけろ！' : '主砲 チャージ中', W / 2, 52);
        }
      }
    }
    const ace = game.ace;
    if (ace && ace.alive && !b) {
      const bw = 200, bx = W / 2 - bw / 2;
      c.textAlign = 'center';
      c.font = '700 10px -apple-system, sans-serif';
      c.fillStyle = 'rgba(255,190,170,.95)';
      c.fillText('エース機', W / 2, 14);
      c.fillStyle = 'rgba(0,0,0,.5)';
      c.fillRect(bx, 19, bw, 5);
      c.fillStyle = '#ff5a5a';
      c.fillRect(bx, 19, bw * Math.max(0, ace.hp) / ace.maxHp, 5);
    }
    if (pl.outside) {
      c.textAlign = 'center';
      c.font = '800 14px -apple-system, sans-serif';
      c.fillStyle = Math.sin(game.t * 10) > 0 ? '#ffb547' : 'rgba(255,181,71,.4)';
      c.fillText('戦域外  引き返します', W / 2, H * 0.3);
    }

    // 帯の文字 (段階・警告)
    fx.cardT = Math.max(0, (fx.cardT || 0) - dt);
    fx.banners = fx.banners.filter(function (bn) { if (bn.delay > 0) { bn.delay -= dt; return true; } return (bn.t -= dt) > 0; });
    fx.banners.forEach(function (bn, i) {
      if (bn.delay > 0) return;
      const k = 1 - bn.t / bn.max;
      const a = Math.min(1, k * 6, bn.t * 2);
      const y = H * (bn.big ? 0.36 : 0.26) + i * 30;
      c.textAlign = 'center';
      c.font = (bn.big ? '800 28px' : '700 17px') + ' -apple-system, sans-serif';
      c.globalAlpha = a;
      const tw = c.measureText(bn.text).width;
      const gr = c.createLinearGradient(W / 2 - tw, 0, W / 2 + tw, 0);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.5, 'rgba(0,0,0,.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = gr;
      c.fillRect(W / 2 - tw, y - (bn.big ? 28 : 20), tw * 2, bn.big ? 40 : 28);
      c.fillStyle = bn.color;
      c.fillText(bn.text, W / 2 + (1 - Math.min(1, k * 5)) * 30, y);
      c.globalAlpha = 1;
    });
  }

  function nearestPart(ts, pl) {
    let best = null, bd = 1e9;
    ts.forEach(function (t) {
      if (t.kind === 'fighter') return;
      const d = dist3(t.pos, pl.pos);
      if (d < bd) { bd = d; best = t; }
    });
    return best;
  }

  /**
   * ゲージ 1 本。枠・アイコン・名前は gauges.png (送ってもらった絵から、目盛りの溝だけ塗り直したもの)。
   * 目盛りはその溝の中に、絵と同じ「/」向きで 14 本描き、いまの量のぶんだけ光らせる。
   * 表に出すのは幅 190pt (絵は 2 倍の 380px)。戻り値は描いた高さ。
   */
  const GAUGE_SCALE = 0.5;
  const GAUGES = [
    // sy, h: 絵の中の段の位置と高さ / t: 目盛りの溝 (x0, y0, x1, y1) / 色: 光る目盛りの上と下、暗い目盛り
    { sy: 0, h: 67, t: [119.5, 10.2, 367.5, 44.4], top: '#b4f0ff', bot: '#3b95dc', dim: 'rgba(90,140,180,.32)' },
    { sy: 67, h: 65, t: [119.5, 9.7, 367.5, 41.0], top: '#ffffff', bot: '#b5cdea', dim: 'rgba(120,140,175,.32)' },
    { sy: 132, h: 71, t: [119.5, 8.0, 367.5, 44.4], top: '#ffe28c', bot: '#ee8a2a', dim: 'rgba(160,112,48,.38)' }
  ];
  const GAUGE_SEGS = 14;
  const gaugeImg = new Image();
  (function () {
    const src = (window.__ASSETS && window.__ASSETS['gauges.png']) || './gauges.png';
    gaugeImg.onload = function () { assetsLoaded['gauges.png'] = true; };
    gaugeImg.onerror = function () { assetsLoaded['gauges.png'] = false; };
    gaugeImg.src = src;
  })();
  const gaugeGrad = [];
  function drawGauge(c, i, x, y, v, warn, hot) {
    const g = GAUGES[i], k = GAUGE_SCALE;
    if (!gaugeImg.complete || !gaugeImg.naturalWidth) return g.h * k;
    c.drawImage(gaugeImg, 0, g.sy, 380, g.h, x, y, 380 * k, g.h * k);
    const tx0 = x + g.t[0] * k, ty0 = y + g.t[1] * k, tx1 = x + g.t[2] * k, ty1 = y + g.t[3] * k;
    const pad = 2.5, th = ty1 - ty0 - pad * 2, lean = th * 0.45;
    const step = (tx1 - tx0 - pad * 2 - lean) / GAUGE_SEGS, w = step * 0.66;
    const yb = ty1 - pad, yt = ty0 + pad;
    // 光る目盛りの色 (上が明るい)。段ごとに作り置く
    if (!gaugeGrad[i] || gaugeGrad[i].y !== y) {
      const gr = c.createLinearGradient(0, yt, 0, yb);
      gr.addColorStop(0, g.top); gr.addColorStop(1, g.bot);
      const wr = c.createLinearGradient(0, yt, 0, yb);
      wr.addColorStop(0, '#ffb0a0'); wr.addColorStop(1, '#e8303a');
      gaugeGrad[i] = { y: y, lit: gr, warn: wr };
    }
    const lit = C.clamp(v, 0, 1) * GAUGE_SEGS;
    hudInfo.gauges[i] = lit;
    for (let s = 0; s < GAUGE_SEGS; s++) {
      const bx = tx0 + pad + s * step;
      c.beginPath();
      c.moveTo(bx, yb); c.lineTo(bx + w, yb); c.lineTo(bx + w + lean, yt); c.lineTo(bx + lean, yt); c.closePath();
      c.globalAlpha = 1;
      c.fillStyle = g.dim;
      c.fill();
      const f = C.clamp(lit - s, 0, 1);
      if (f > 0) {
        c.globalAlpha = f * (hot ? 1 : 0.95);
        c.fillStyle = warn ? gaugeGrad[i].warn : gaugeGrad[i].lit;
        c.fill();
      }
    }
    c.globalAlpha = 1;
    return g.h * k;
  }



  // 操作部品の表示 (変わったときだけ書き換える)
  const shown = { missiles: -1, locked: null, boostEmpty: null };
  function updateControlsView() {
    const pl = game.player;
    if (shown.missiles !== pl.missiles) {
      shown.missiles = pl.missiles;
      els.btnMissile.classList.toggle('empty', pl.missiles === 0);
    }
    const lockedNow = pl.locked || pl.mlock.length > 0;
    if (shown.locked !== lockedNow) { shown.locked = lockedNow; els.btnMissile.classList.toggle('locked', lockedNow); }
    // ロックした数をボタンに出す (残り弾数の代わりに「n/残り」)
    const mtext = pl.mlock.length > 0 ? pl.mlock.length + '/' + pl.missiles : String(pl.missiles);
    if (shown.mtext !== mtext) { shown.mtext = mtext; els.missileCount.textContent = mtext; }
    const hasTarget = !!pl.targetId;
    if (shown.hasTarget !== hasTarget) { shown.hasTarget = hasTarget; els.btnTarget.classList.toggle('has-target', hasTarget); }
    const be = pl.boost < 5 && !pl.boosting;
    if (shown.boostEmpty !== be) { shown.boostEmpty = be; els.btnBoost.classList.toggle('empty', be); }
  }

  // ------------------------------------------------------------ メインループ

  let last = 0, fps = 60, frames = 0, perfAcc = 0, perfN = 0, perfChecked = 0;
  const frameLog = [];

  const costLog = [];
  const prof = { step: 0, sync: 0, render: 0, hud: 0, n: 0 };
  function frame(now) {
    requestAnimationFrame(frame);
    const t0 = performance.now();
    work(now);
    costLog.push(performance.now() - t0);
    if (costLog.length > 240) costLog.shift();
  }

  function work(now) {
    const realDt = last ? C.frameDt(now - last) : 0;
    last = now;
    frames++;
    if (realDt > 0) fps = fps * 0.95 + (1 / realDt) * 0.05;
    frameLog.push(realDt);
    if (frameLog.length > 240) frameLog.shift();

    if (inspectView && shipObj) {
      renderInspect();
      return;
    }
    if (screen === 'title' || !game) {
      if (shipObj) updateTitleCamera(realDt);
      updateParticles(realDt);
      renderer.render(scene, camera);
      hud.setTransform(1, 0, 0, 1, 0, 0);
      hud.clearRect(0, 0, els.hud.width, els.hud.height);
      return;
    }

    let dt = realDt * (window.__timeScale || 1); // __timeScale: 演出を写すテスト用 (ゆっくり流す)
    if (paused) dt = 0;
    // 撃沈の瞬間はゆっくりに
    if (fx.slowT > 0) { fx.slowT = Math.max(0, fx.slowT - realDt); dt *= 0.35; }
    // 撃墜のタメ: ほんの一瞬だけ時を止める (画面は描き続ける)
    if (fx.stopT > 0 && !paused) {
      fx.stopT = Math.max(0, fx.stopT - realDt); dt = 0;
      if (lastBurst) { lastBurst.frozen++; lastBurst.tFrozen = game.t; }
    }

    if (dt > 0 && screen === 'play') {
      const kb = readKeys(realDt);
      const stepInput = {
        stickX: C.clamp(input.stickX + kb.kx, -1, 1),
        stickY: C.clamp(input.stickY + kb.ky, -1, 1),
        fire: touch.fireIds.size > 0 || kb.fire,
        boost: touch.boostIds.size > 0 || kb.boost,
        missile: input.missile,
        missileHold: missileIds.size > 0 || kb.missileHold,
        select: input.select,
        track: touch.trackIds.size > 0 || kb.track
      };
      if (window.__autopilot) Object.assign(stepInput, C.autopilot(game, 1));
      input.missile = false;
      input.select = false;
      const ts = performance.now();
      C.step(game, stepInput, dt);
      consumeEvents();
      prof.step += performance.now() - ts;
    }

    const tsy = performance.now();
    if (dt > 0) {
      syncWorld(dt);
      updateParticles(dt);
      updateFlashes(dt);
      updateRings(dt);
      flashLight.intensity *= Math.exp(-realDt * 9);
    }
    updateCamera(dt, paused ? 0 : realDt);
    const pv = game.player.vel;
    updateDust(camera.position, new THREE.Vector3(pv.x, pv.y, pv.z));
    if (screen === 'play') {
      audio.engine(game.player.speed, game.player.boosting, game.player.alive && !paused);
      updateControlsView();
    }
    const tr = performance.now();
    prof.sync += tr - tsy;
    renderer.render(scene, camera);
    const th = performance.now();
    prof.render += th - tr;
    drawHud(paused ? 0 : realDt);
    prof.hud += performance.now() - th;
    prof.n++;

    if (!resultShown && ((game.state === 'clear') || (game.state === 'over' && game.endT > 2.2))) {
      audio.engine(0, false, false);
      showResult();
    }

    // 遅い端末: 2 秒ずつ測って、重ければ画素を減らす
    if (screen === 'play' && !paused && realDt > 0) {
      perfAcc += realDt; perfN++;
      if (perfAcc > 2) {
        const avg = perfAcc / perfN;
        if (avg > 0.024 && pixelRatio > 1.25 && perfChecked < 3) {
          pixelRatio = Math.max(1.25, pixelRatio - 0.35);
          renderer.setPixelRatio(pixelRatio);
          resize();
          perfChecked++;
        }
        perfAcc = 0; perfN = 0;
      }
    }
  }

  // ------------------------------------------------------------ 起動

  function main() {
    els.version.textContent = VERSION;
    // 画面に置いた絵 (タイトルのロゴ・出撃ボタン)。1 枚版では埋め込んだ data URI を使う
    document.querySelectorAll('img[data-asset]').forEach(function (img) {
      const name = img.dataset.asset;
      img.onload = function () { assetsLoaded[name] = true; };
      img.onerror = function () { assetsLoaded[name] = false; };
      img.src = (window.__ASSETS && window.__ASSETS[name]) || './' + name;
    });
    bindToggle(['optInvert', 'optInvert2'], 'invert');
    bindToggle(['optShake', 'optShake2'], 'shake');
    bindToggle(['optSound', 'optSound2'], 'sound');
    $('btnStart').addEventListener('click', function () { startGame(); });
    $('btnBossOnly').addEventListener('click', function () { startGame({ start: 'boss' }); });
    $('btnSettings').addEventListener('click', function () { showMenu('menuSettings'); });
    $('btnHowto').addEventListener('click', function () { showMenu('menuHowto'); });
    document.querySelectorAll('[data-back]').forEach(function (b) { b.addEventListener('click', function () { showMenu(null); }); });
    $('btnResume').addEventListener('click', function () { setPaused(false); });
    $('btnRetry').addEventListener('click', function () { startGame({ start: lastStart }); });
    $('btnToTitle').addEventListener('click', toTitle);
    $('btnAgain').addEventListener('click', function () { startGame({ start: lastStart }); });
    $('btnResultTitle').addEventListener('click', toTitle);

    // 別のアプリへ切り替えたら止める
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (screen === 'play' && !paused) setPaused(true);
        audio.suspend();
      }
    });

    toTitle();
    requestAnimationFrame(frame);

    // 自動テストから中身をのぞくための入口
    window.__app = {
      version: VERSION,
      game: function () { return game; },
      screen: function () { return screen; },
      paused: function () { return paused; },
      input: input,
      touch: touch,
      hudInfo: hudInfo,
      frames: function () { return frames; },
      frameLog: function () { return frameLog.slice(); },
      costLog: function () { return costLog.slice(); },
      profile: function (reset) {
        const n = Math.max(1, prof.n), o = { step: prof.step / n, sync: prof.sync / n, render: prof.render / n, hud: prof.hud / n, n: prof.n };
        if (reset) { prof.step = prof.sync = prof.render = prof.hud = 0; prof.n = 0; }
        return o;
      },
      pixelRatio: function () { return pixelRatio; },
      particles: function () { return particles.list.filter(function (p) { return p.on; }).length; },
      start: startGame,
      setPaused: setPaused,
      toTitle: toTitle,
      audioLevel: function () { return audio.level(); },
      musicOn: function () { return audio.musicOn(); },
      musicKind: function () { return audio.musicKind(); },
      sfx: function (name) { audio[name](); },
      settings: settings,
      assetsLoaded: function () { return Object.assign({}, assetsLoaded); },
      // 自機のまわり r m にある、大きな (煙の玉のような) 粒の数。ブーストで煙を出さない見張り用
      bigParticlesNear: function (r, minSize) {
        const p = game.player.pos;
        return particles.list.filter(function (q) {
          return q.on && Math.max(q.s0, q.s1) >= minSize && Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < r;
        }).length;
      },
      titlePlanet: TITLE_PLANET, titleShip: TITLE_SHIP,
      setTitleTime: function (v) { titleT = v; },
      // タイトルの惑星: 出ているか・ゲームの地球は隠れているか・円の中心と太陽の光の画面の位置・いまの向き
      titlePlanetInfo: function () {
        const c = toScreen(titlePlanet.position);
        const P = TITLE_PLANET, R = 0.5 / TP_GLOW;
        const f = toScreen(new THREE.Vector3(Math.cos(P.flare) * R, Math.sin(P.flare) * R, 0).applyMatrix4(titleGlow.matrixWorld));
        const rr = toScreen(new THREE.Vector3(0.5, 0, 0).applyMatrix4(titlePlanet.matrixWorld));
        return { shown: titlePlanet.visible, glow: titleGlow.visible, earth: planet.visible, cx: c.x, cy: c.y, radius: Math.hypot(rr.x - c.x, rr.y - c.y), flareX: f.x, flareY: f.y, ang: titlePlanetAngle() };
      },
      // ボスの船体の色 (頂点の色の平均) と型・いまの面
      bossLook: function () {
        if (!bossObj) return null;
        // 船体の頂点の色の平均 (錆びた赤茶か、などを見る)
        const col = bossObj.userData.hull.geometry.attributes.color.array;
        let r = 0, g = 0, bl = 0;
        for (let i = 0; i < col.length; i += 3) { r += col[i]; g += col[i + 1]; bl += col[i + 2]; }
        const n = col.length / 3;
        return { level: bossObj.userData.level, type: bossObj.userData.type || 'battleship', hull: [r / n, g / n, bl / n] };
      },
      skyKind: function () { return sky.userData.kind; },
      planetKind: function () { return planet.userData.kind; },
      bossVisible: function () { return !!(bossObj && bossObj.visible); },
      stageCard: function () { const el = $('stageCard'); return { shown: !el.hidden, num: $('scNum').textContent, en: $('scEn').textContent, ja: $('scJa').textContent, pe: getComputedStyle(el).pointerEvents }; },
      banners: function () { return fx.banners.map(function (b) { return b.text; }); },
      aceLook: function () { const f = game.ace, o = f && enemyObjs.get(f.id); return o ? { scale: o.scale.x, color: o.userData.mats[0].color.getHexString() } : null; },
      enemyScale: function (id) { const o = enemyObjs.get(id); return o ? o.scale.x : 0; },
      bossClipX: function () { return bossClip.constant; },
      jetLength: function () { return shipObj.userData.jetBase; },
      jetRoot: function () { return shipObj.userData.jetRoot; },
      // 膨らみながら消える大きな粒 (煙の玉に見える) の数
      growingParticles: function () {
        return particles.list.filter(function (q) { return q.on && q.s1 > q.s0 * 1.2 && q.s1 >= 6; }).length;
      },
      setSkyDim: setSkyDim,
      // 面の表向き (頂点の並び) と、光の計算に使う向き (法線) が食い違う三角形の数。
      // 鏡にした板 (geometry.scale(-1)) はここが食い違い、片側だけ黒く見える
      flippedFaces: function () {
        const out = {};
        const boss = makeBossModel();
        ['beamOuter', 'beamCore', 'guide'].forEach(function (k) { scene.remove(boss.userData[k]); });
        [['player', makePlayerShip()], ['enemy', makeEnemyShip()], ['boss', boss]].forEach(function (pair) {
          let bad = 0, total = 0;
          pair[1].traverse(function (o) {
            if (!o.isMesh || o.isSprite || !o.geometry.attributes.normal) return;
            const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
            const P = g.attributes.position, N = g.attributes.normal;
            const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
            for (let i = 0; i < P.count; i += 3) {
              a.fromBufferAttribute(P, i); b.fromBufferAttribute(P, i + 1); c.fromBufferAttribute(P, i + 2);
              n.fromBufferAttribute(N, i).add(_v.fromBufferAttribute(N, i + 1)).add(_v.fromBufferAttribute(N, i + 2));
              const face = b.sub(a).cross(c.sub(a));
              if (face.lengthSq() < 1e-12) continue;
              total++;
              if (face.dot(n) < 0) bad++;
            }
          });
          out[pair[0]] = { bad: bad, total: total };
        });
        return out;
      },
      inspect: function (view, kind) {
        inspectView = view || null;
        if (inspectObj) {
          scene.remove(inspectObj);
          if (inspectObj.userData.beamOuter) ['beamOuter', 'beamCore', 'guide'].forEach(function (k) { scene.remove(inspectObj.userData[k]); });
          inspectObj = null;
        }
        if (view && kind === 'enemy') { inspectObj = makeEnemyShip(); scene.add(inspectObj); }
        if (view && kind === 'boss') { inspectObj = makeBossModel(); scene.add(inspectObj); }
        if (view && kind === 'fortress') { inspectObj = makeFortressModel(); scene.add(inspectObj); }
        if (view && kind === 'driller') { inspectObj = makeDrillerModel(); scene.add(inspectObj); }
        if (shipObj) shipObj.visible = !inspectObj;
        if (!view) { sky.visible = true; planet.visible = true; dust.lines.visible = true; scene.background = null; inspectLight.visible = false; }
        els.title.hidden = !!view || screen !== 'title';
      },
      inspectViews: INSPECT,
      // 撃墜の演出の見張り用: 最後の撃墜の大きさと、いまのタメ・輪
      killFx: function () {
        const r = rings.find(function (q) { return q.t > 0; });
        const fpx = (els.gl.clientHeight / 2) / Math.tan(camera.fov * Math.PI / 360);
        return { last: lastBurst, stopT: fx.stopT, ringOn: !!r, ringPx: lastBurst ? lastBurst.ring / Math.max(1, lastBurst.dist) * fpx : 0, gameT: game ? game.t : 0 };
      },
      skyDim: function () { return skyDim; },
      renderInfo: function () { return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }; }
    };
  }

  main();
})();
