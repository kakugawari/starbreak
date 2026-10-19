/*!
 * app.js — 描画と操作。ゲームの中身は core.js が進め、ここはそれを描いて、指の操作を渡す。
 */
(function () {
  'use strict';

  const VERSION = 'v0.2.1';
  const C = window.Core;
  const THREE = window.THREE;
  const K = C.TUNING;

  const $ = function (id) { return document.getElementById(id); };
  const els = {
    gl: $('gl'), hud: $('hud'), controls: $('controls'),
    throttle: $('throttle'), throttleFill: $('throttleFill'), throttleKnob: $('throttleKnob'),
    stickZone: $('stickZone'), stick: $('stick'), stickKnob: $('stickKnob'),
    btnFire: $('btnFire'), btnBoost: $('btnBoost'), btnMissile: $('btnMissile'), missileCount: $('missileCount'),
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
        if (key === 'sound') audio.setEnabled(settings.sound);
      });
    });
  }

  // ------------------------------------------------------------ 描画の土台

  const renderer = new THREE.WebGLRenderer({ canvas: els.gl, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
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
  const assetsLoaded = {};

  // ------------------------------------------------------------ 宇宙: 星雲・星・惑星・太陽

  // 背景の明るさ。1 だと絵のまま。遊んでいる間は、敵や赤い印が明るい星雲に埋もれないよう沈める
  // (星雲のいちばん明るい所 上位10% の輝度: 1.0 で 69 → 0.55 で 51)。タイトルでは絵を見せる
  const SKY_DIM = { play: 0.55, title: 0.9 };
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
    loadTex('space.jpg', function (t) {
      // 内側から見ると左右が反転するので戻す
      t.wrapS = THREE.RepeatWrapping;
      t.repeat.x = -1;
      t.anisotropy = 4;
      mat.map = t;
      mat.color.setScalar(skyDim);
      mat.needsUpdate = true;
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
    loadTex('earth.jpg', function (t) { mat.uniforms.map.value = t; m.visible = true; });
    planet.userData.offset = new THREE.Vector3(-3400, -5200, -9000);
    planet.userData.ball = m;
  })();

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

  /** 自機 RZ-1。前は -Z。全長 12m ほど。 */
  function makePlayerShip() {
    const g = new THREE.Group();
    const body = new THREE.Group();
    g.add(body);
    const nose = mesh(new THREE.ConeGeometry(0.95, 5.2, 6), MAT.hull, 0, 0, -5.4);
    nose.rotation.x = -Math.PI / 2;
    body.add(nose);
    body.add(mesh(new THREE.BoxGeometry(2.0, 1.2, 6.2), MAT.hull, 0, 0, -0.2));
    body.add(mesh(new THREE.BoxGeometry(1.2, 0.5, 4), MAT.dark, 0, -0.75, 0));
    const canopy = mesh(new THREE.SphereGeometry(0.72, 16, 10), MAT.glass, 0, 0.62, -2.1);
    canopy.scale.set(1, 0.65, 2.1);
    body.add(canopy);
    // 翼 (後退翼)
    const wR = wingGeo([[0.8, -1.6], [6.2, 2.0], [6.4, 3.0], [0.9, 2.4]], 0.22);
    const wL = wR.clone(); wL.scale(-1, 1, 1);
    const wingR = mesh(wR, MAT.hull, 0, -0.1, 0); wingR.rotation.z = -0.06;
    const wingL = mesh(wL, MAT.hull, 0, -0.1, 0); wingL.rotation.z = 0.06;
    body.add(wingR, wingL);
    // 赤い帯
    body.add(mesh(new THREE.BoxGeometry(2.2, 0.26, 0.5), MAT.red, 3.6, 0.1, 1.1));
    body.add(mesh(new THREE.BoxGeometry(2.2, 0.26, 0.5), MAT.red, -3.6, 0.1, 1.1));
    body.add(mesh(new THREE.BoxGeometry(0.3, 0.9, 2.6), MAT.red, 0, 0.9, 1.6));
    // 翼端の砲
    const gunGeo = new THREE.CylinderGeometry(0.12, 0.16, 3.4, 6); gunGeo.rotateX(Math.PI / 2);
    body.add(mesh(gunGeo, MAT.dark, 6.15, -0.05, 1.0), mesh(gunGeo, MAT.dark, -6.15, -0.05, 1.0));
    // エンジン2基
    const engGeo = new THREE.CylinderGeometry(0.62, 0.7, 3.6, 12); engGeo.rotateX(Math.PI / 2);
    const nozGeo = new THREE.CylinderGeometry(0.52, 0.52, 0.1, 12); nozGeo.rotateX(Math.PI / 2);
    const flames = [];
    [-1.45, 1.45].forEach(function (x) {
      body.add(mesh(engGeo, MAT.dark, x, 0, 2.4));
      body.add(mesh(nozGeo, MAT.engine, x, 0, 4.22));
      const f1 = glowSprite(0x6fc8ff, 3.2, 1); f1.position.set(x, 0, 4.6);
      const f2 = glowSprite(0x3a7dff, 5, 0.7); f2.position.set(x, 0, 5.6);
      body.add(f1, f2);
      flames.push(f1, f2);
    });
    g.userData = { body: body, flames: flames };
    return g;
  }

  const ENEMY_MAT = {
    hull: new THREE.MeshPhongMaterial({ color: 0x4a4f5c, shininess: 50, specular: 0x333844 }),
    dark: new THREE.MeshPhongMaterial({ color: 0x1b1d24, shininess: 30 }),
    glow: new THREE.MeshBasicMaterial({ color: 0xff3a3a })
  };

  /** 敵戦闘機。尖った前進翼。 */
  function makeEnemyShip() {
    const g = new THREE.Group();
    const body = new THREE.Group();
    g.add(body);
    const hull = ENEMY_MAT.hull.clone();
    const nose = mesh(new THREE.ConeGeometry(1.0, 6, 4), hull, 0, 0, -3.6);
    nose.rotation.x = -Math.PI / 2; nose.rotation.y = Math.PI / 4;
    body.add(nose);
    body.add(mesh(new THREE.BoxGeometry(1.8, 1.2, 4), hull, 0, 0, 1.0));
    const wR = wingGeo([[0.8, 2.2], [5.0, -1.2], [5.4, -0.4], [0.9, 3.4]], 0.2);
    const wL = wR.clone(); wL.scale(-1, 1, 1);
    body.add(mesh(wR, hull, 0, 0, 0), mesh(wL, hull, 0, 0, 0));
    const finGeo = new THREE.BoxGeometry(0.2, 2.4, 1.6);
    const f1 = mesh(finGeo, ENEMY_MAT.dark, 5.2, 0.6, -0.8), f2 = mesh(finGeo, ENEMY_MAT.dark, -5.2, 0.6, -0.8);
    body.add(f1, f2);
    body.add(mesh(new THREE.BoxGeometry(1.1, 0.25, 1.4), ENEMY_MAT.glow, 0, 0.62, -1.2));
    const eng = glowSprite(0xff5040, 4.5, 0.95); eng.position.set(0, 0, 3.4);
    const eng2 = glowSprite(0xff2a1a, 7, 0.5); eng2.position.set(0, 0, 4.6);
    body.add(eng, eng2);
    g.userData = { body: body, mat: hull };
    return g;
  }

  // ------------------------------------------------------------ 巨大戦艦
  //
  // 箱の表 (core.js の BOSS_BOXES) から作る。当たり判定と見た目が同じ箱。

  function makeBossModel() {
    const group = new THREE.Group();
    const rng = C.mulberry32(1234);
    const hullGeos = [], lightGeos = [];
    const box = function (cx, cy, cz, sx, sy, sz, shade, list) {
      const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
      g.translate(cx, cy, cz);
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = shade[0]; col[i * 3 + 1] = shade[1]; col[i * 3 + 2] = shade[2]; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.deleteAttribute('uv');
      (list || hullGeos).push(g);
    };
    const shadeOf = function (k) { const v = 0.16 + k * 0.2; return [v * 0.92, v * 0.97, v * 1.1]; };

    C.BOSS_BOXES.forEach(function (b) {
      if (b.armor) return;
      box(b.c.x, b.c.y, b.c.z, b.s.x, b.s.y, b.s.z, shadeOf(rng()));
      // 上面と側面に細かい凹凸 (判定には入れない小さな物)
      const top = b.c.y + b.s.y / 2;
      const count = Math.floor(b.s.x * b.s.z / 900);
      for (let i = 0; i < count; i++) {
        const sx = 4 + rng() * 22, sz = 4 + rng() * 18, sy = 1 + rng() * 5;
        const x = b.c.x + (rng() - 0.5) * (b.s.x - sx), z = b.c.z + (rng() - 0.5) * (b.s.z - sz);
        box(x, top + sy / 2, z, sx, sy, sz, shadeOf(rng() * 0.8));
      }
      const sideN = Math.floor(b.s.x / 14);
      for (let i = 0; i < sideN; i++) {
        const sx = 6 + rng() * 26, sy = 3 + rng() * (b.s.y * 0.5), sz = 1 + rng() * 3;
        const x = b.c.x + (rng() - 0.5) * (b.s.x - sx), y = b.c.y + (rng() - 0.5) * (b.s.y - sy);
        box(x, y, b.c.z + b.s.z / 2 + sz / 2, sx, sy, sz, shadeOf(rng() * 0.6));
        box(x, y, b.c.z - b.s.z / 2 - sz / 2, sx, sy, sz, shadeOf(rng() * 0.6));
      }
      // 窓の明かり
      const winN = Math.floor(b.s.x / 6);
      for (let i = 0; i < winN; i++) {
        if (rng() < 0.4) continue;
        const x = b.c.x + (rng() - 0.5) * b.s.x * 0.95, y = b.c.y + (rng() - 0.5) * b.s.y * 0.8;
        const warm = rng() < 0.75;
        const c = warm ? [1.0, 0.8, 0.5] : [0.5, 0.8, 1.0];
        box(x, y, b.c.z + b.s.z / 2 + 0.3, 2.2, 0.9, 0.4, c, lightGeos);
        box(x, y, b.c.z - b.s.z / 2 - 0.3, 2.2, 0.9, 0.4, c, lightGeos);
      }
    });
    // 艦首の主砲の筒
    const cn = C.BOSS_CANNON;
    box(cn.x + 20, cn.y, cn.z, 40, 22, 22, [0.2, 0.2, 0.24]);

    const hullMesh = new THREE.Mesh(mergeGeos(hullGeos), new THREE.MeshPhongMaterial({
      vertexColors: true, shininess: 40, specular: 0x6a7a90, flatShading: true
    }));
    const lightMesh = new THREE.Mesh(mergeGeos(lightGeos), new THREE.MeshBasicMaterial({ vertexColors: true }));
    group.add(hullMesh, lightMesh);

    // 装甲 (コアの蓋)。外れたら消す
    const ab = C.BOSS_BOXES.filter(function (b) { return b.armor; })[0];
    const armor = mesh(new THREE.BoxGeometry(ab.s.x, ab.s.y, ab.s.z), new THREE.MeshPhongMaterial({ color: 0x5a6070, shininess: 60, flatShading: true }), ab.c.x, ab.c.y, ab.c.z);
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
        const core = mesh(new THREE.CircleGeometry(12, 20), new THREE.MeshBasicMaterial({ color: 0x66aaff }), 7.2, 0, 0);
        core.rotation.y = Math.PI / 2;
        pg.add(core);
        const gl = glowSprite(0x4a8dff, 70, 0.8); gl.position.x = 14;
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

    // 艦尾の噴射
    const thrusters = [];
    for (let i = -2; i <= 2; i++) {
      const t = glowSprite(0x6a9dff, 60, 0.55);
      t.position.set(362, -18, i * 30);
      group.add(t);
      thrusters.push(t);
    }

    group.userData = { parts: parts, armor: armor, charge: charge, beamOuter: beamOuter, beamCore: beamCore, guide: guide, thrusters: thrusters, hull: hullMesh };
    return group;
  }

  function mergeGeos(list) {
    let n = 0;
    list.forEach(function (g) { n += g.attributes.position.count; });
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let o = 0;
    list.forEach(function (g) {
      pos.set(g.attributes.position.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      col.set(g.attributes.color.array, o * 3);
      o += g.attributes.position.count;
      g.dispose();
    });
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return out;
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

  const FIRE = [1.0, 0.85, 0.5], EMBER = [0.9, 0.25, 0.05], SMOKE = [0.12, 0.1, 0.1], SPARK = [0.7, 0.9, 1.0];

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

  function explosion(pos, size, vel) {
    const v = vel || { x: 0, y: 0, z: 0 };
    const n = Math.round(26 * Math.min(size, 6));
    for (let i = 0; i < n; i++) {
      const d = rndDir(), sp = rnd(10, 46) * size;
      spawnParticle(pos.x, pos.y, pos.z, d[0] * sp + v.x * 0.6, d[1] * sp + v.y * 0.6, d[2] * sp + v.z * 0.6,
        rnd(0.4, 0.9) * Math.sqrt(size), 4 * size, 12 * size, FIRE, EMBER, 2.2);
    }
    for (let i = 0; i < n * 0.6; i++) {
      const d = rndDir(), sp = rnd(4, 18) * size;
      spawnParticle(pos.x, pos.y, pos.z, d[0] * sp + v.x * 0.4, d[1] * sp + v.y * 0.4, d[2] * sp + v.z * 0.4,
        rnd(1.0, 2.2) * Math.sqrt(size), 6 * size, 22 * size, [0.35, 0.22, 0.15], SMOKE, 1.4);
    }
    // 飛び散るかけら (速い光の粒)
    for (let i = 0; i < n * 0.8; i++) {
      const d = rndDir(), sp = rnd(60, 160) * Math.sqrt(size);
      spawnParticle(pos.x, pos.y, pos.z, d[0] * sp + v.x, d[1] * sp + v.y, d[2] * sp + v.z,
        rnd(0.3, 0.9), 1.2, 0.4, [1, 0.9, 0.6], [1, 0.3, 0.05], 1.5);
    }
    flash(pos, 30 * size, 0.35 + size * 0.05);
    flashLight.position.set(pos.x, pos.y, pos.z);
    flashLight.intensity = Math.max(flashLight.intensity, 40 * size);
    flashLight.distance = 120 * size;
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
      // エンジンのうなり (ずっと鳴らし、速さで音色を変える)
      const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300;
      const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 55;
      const og = ctx.createGain(); og.gain.value = 0.05;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(lp); osc.connect(og); og.connect(lp); lp.connect(g); g.connect(master);
      src.start(); osc.start();
      engine = { lp: lp, osc: osc, g: g };
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
    return {
      init: init,
      setEnabled: function (on) {
        enabled = on;
        if (master) { master.gain.cancelScheduledValues(ctx.currentTime); master.gain.setTargetAtTime(on ? 0.9 : 0, ctx.currentTime, 0.03); }
      },
      suspend: function () { if (ctx && ctx.state === 'running') ctx.suspend(); },
      resume: function () { if (ctx && ctx.state === 'suspended') ctx.resume(); },
      engine: function (speed, boosting, on) {
        if (!engine) return;
        const t = ctx.currentTime;
        engine.lp.frequency.setTargetAtTime(180 + speed * 4 + (boosting ? 900 : 0), t, 0.1);
        engine.osc.frequency.setTargetAtTime(40 + speed * 0.5, t, 0.1);
        engine.g.gain.setTargetAtTime(on ? (boosting ? 0.32 : 0.16) : 0, t, 0.15);
      },
      laser: function () { tone('square', 1500, 260, 0.075, 0.07, 3200); },
      enemyLaser: function () { tone('sawtooth', 700, 180, 0.12, 0.03, 1500); },
      hit: function () { tone('square', 2400, 1800, 0.03, 0.05); noise(0.04, 0.08, 6000, 3000, 'highpass'); },
      armored: function () { tone('triangle', 3200, 2600, 0.05, 0.05); },
      explode: function (size) {
        noise(0.5 + size * 0.15, Math.min(0.9, 0.35 + size * 0.1), 2400, 60);
        tone('sine', 120, 30, 0.35 + size * 0.1, Math.min(0.8, 0.3 + size * 0.1));
      },
      big: function () { noise(2.4, 1, 1800, 40); tone('sine', 80, 20, 2.0, 0.9); },
      missile: function () { noise(0.6, 0.3, 800, 3000, 'bandpass', 1.2); },
      lock: function () { tone('square', 1760, 1760, 0.05, 0.06); setTimeout(function () { tone('square', 2350, 2350, 0.07, 0.06); }, 70); },
      boost: function () { noise(0.7, 0.35, 300, 4000, 'bandpass', 1); },
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

  const input = { stickX: 0, stickY: 0, throttle: 0.5, fire: false, boost: false, missile: false };
  const touch = { stickId: null, stickOrigin: null, throttleId: null, fireIds: new Set(), boostIds: new Set() };
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

  function setThrottleFrom(e) {
    const r = els.throttle.querySelector('.track').getBoundingClientRect();
    input.throttle = C.clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
  }
  els.throttle.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    touch.throttleId = e.pointerId;
    els.throttle.setPointerCapture(e.pointerId);
    setThrottleFrom(e);
  });
  els.throttle.addEventListener('pointermove', function (e) { if (e.pointerId === touch.throttleId) setThrottleFrom(e); });
  els.throttle.addEventListener('pointerup', function (e) { if (e.pointerId === touch.throttleId) touch.throttleId = null; });
  els.throttle.addEventListener('pointercancel', function (e) { if (e.pointerId === touch.throttleId) touch.throttleId = null; });

  function holdButton(el, set, onDown) {
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      set.add(e.pointerId);
      el.classList.add('on');
      if (onDown) onDown();
    });
    const up = function (e) {
      set.delete(e.pointerId);
      if (set.size === 0) el.classList.remove('on');
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }
  holdButton(els.btnFire, touch.fireIds);
  holdButton(els.btnBoost, touch.boostIds);
  const missileIds = new Set();
  holdButton(els.btnMissile, missileIds, function () { input.missile = true; });
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
    if (e.code === 'KeyE' || e.code === 'KeyM') input.missile = true;
    if ((e.code === 'Escape' || e.code === 'KeyP') && screen === 'play') setPaused(!paused);
    if (e.code === 'Space' || e.code.indexOf('Arrow') === 0) e.preventDefault();
  });
  window.addEventListener('keyup', function (e) { keys[e.code] = false; });
  window.addEventListener('blur', function () { for (const k in keys) keys[k] = false; });

  function readKeys(dt) {
    const kx = (keys.ArrowRight || keys.KeyD ? 1 : 0) - (keys.ArrowLeft || keys.KeyA ? 1 : 0);
    const ky = (keys.ArrowUp || keys.KeyW ? 1 : 0) - (keys.ArrowDown || keys.KeyS ? 1 : 0);
    if (keys.KeyR) input.throttle = Math.min(1, input.throttle + dt * 0.6);
    if (keys.KeyF) input.throttle = Math.max(0, input.throttle - dt * 0.6);
    return { kx: kx, ky: ky * (settings.invert ? -1 : 1), fire: !!(keys.Space || keys.KeyJ), boost: !!(keys.ShiftLeft || keys.ShiftRight || keys.KeyK) };
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
    fovKick: 0, bossCam: 0, timeScale: 1, slowT: 0, lastHurt: 0, alarmT: 0
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
    fx.banners.length = 0; fx.popups.length = 0; fx.hurt.length = 0;
  }

  let lastStart;
  function startGame(opts) {
    opts = opts || {};
    lastStart = opts.start;
    audio.init();
    clearWorld();
    game = C.createGame({ seed: opts.seed !== undefined ? opts.seed : (Math.random() * 1e9) >>> 0, start: opts.start });
    shipObj = makePlayerShip();
    scene.add(shipObj);
    input.throttle = 0.5; input.stickX = 0; input.stickY = 0; input.missile = false;
    touch.fireIds.clear(); touch.boostIds.clear();
    els.btnFire.classList.remove('on'); els.btnBoost.classList.remove('on');
    setStickVisual(0, 0, false);
    cam.dir.set(0, 0, -1);
    fx.timeScale = 1; fx.slowT = 0; fx.bossCam = 0;
    resultShown = false;
    setSkyDim(SKY_DIM.play);
    screen = 'play';
    paused = false;
    els.title.hidden = true; els.result.hidden = true; els.pause.hidden = true;
    els.controls.hidden = false;
    banner(opts.start === 'boss' ? '巨大戦艦戦' : 'STAGE 1  惑星軌道', 2.4, '#cfe8ff');
    consumeEvents();
  }

  function toTitle() {
    clearWorld();
    game = null;
    setSkyDim(SKY_DIM.title);
    screen = 'title';
    paused = false;
    els.title.hidden = false; els.result.hidden = true; els.pause.hidden = true; els.controls.hidden = true;
    shipObj = makePlayerShip();
    scene.add(shipObj);
  }

  function setPaused(on) {
    if (screen !== 'play') return;
    paused = on;
    els.pause.hidden = !on;
    if (on) {
      touch.fireIds.clear(); touch.boostIds.clear();
      els.btnFire.classList.remove('on'); els.btnBoost.classList.remove('on');
      input.stickX = 0; input.stickY = 0; touch.stickId = null; setStickVisual(0, 0, false);
      els.diag.textContent = VERSION + ' · ' + fps.toFixed(0) + 'fps · 画素 x' + pixelRatio.toFixed(2) + ' · ' + W + 'x' + H;
      audio.suspend();
    } else {
      audio.resume();
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
  }

  function banner(text, dur, color, big) {
    fx.banners.push({ text: text, t: dur, max: dur, color: color || '#fff', big: !!big });
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
          explosion(e.pos, size, e.vel);
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
          } else {
            audio.explode(size);
            shake(Math.min(1.4, size * 60 / Math.max(60, d)));
          }
          if (e.kind === 'fighter' || e.kind === 'turret' || e.kind === 'engine' || e.kind === 'core') fx.killMarker = 0.35;
          break;
        }
        case 'score':
          fx.popups.push({ text: '+' + e.pts + (e.combo > 1 ? '  x' + e.combo : ''), pos: e.pos, t: 1.2 });
          break;
        case 'missile': audio.missile(); break;
        case 'lock': audio.lock(); break;
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
        case 'waveClear': banner('殲滅', 1.6, '#9fe6ff', true); break;
        case 'bossWarning':
          banner(e.text, 4, '#ff5a5a', true);
          audio.alarm(); setTimeout(audio.alarm, 500); setTimeout(audio.alarm, 1000);
          fx.bossCam = 6;
          break;
        case 'bossPhase':
          banner(e.text, e.phase === 'dying' ? 3 : 3.2, e.phase === 'dying' ? '#ffd27a' : '#ffb26a', e.phase === 'dying');
          if (e.phase === 'dying') { fx.slowT = 1.2; shake(2); }
          break;
        case 'escorts': banner('護衛機 発進', 1.8, '#ff8a7a'); break;
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
    shipObj.userData.flames.forEach(function (f, i) {
      const big = i % 2 === 1;
      const s = (big ? 5 : 3.2) * thrust * (0.9 + Math.random() * 0.2);
      f.scale.set(s, s, 1);
      f.position.z = big ? 4.4 + thrust * 1.6 : 4.5;
    });
    if (pl.boosting && pl.alive) {
      const back = { x: pl.pos.x - pl.dir.x * 6, y: pl.pos.y - pl.dir.y * 6, z: pl.pos.z - pl.dir.z * 6 };
      for (let k = 0; k < 2; k++) spawnParticle(back.x + rnd(-1, 1), back.y + rnd(-0.5, 0.5), back.z + rnd(-1, 1), 0, 0, 0, 0.35, 3, 0.5, [0.4, 0.7, 1], [0.1, 0.2, 0.8]);
    }

    // 敵戦闘機
    const seen = new Set();
    game.fighters.forEach(function (f) {
      seen.add(f.id);
      let o = enemyObjs.get(f.id);
      if (!o) { o = makeEnemyShip(); enemyObjs.set(f.id, o); scene.add(o); }
      o.position.set(f.pos.x, f.pos.y, f.pos.z);
      const yp = C.yawPitchOf(f.dir);
      o.rotation.order = 'YXZ';
      o.rotation.set(yp.pitch, yp.yaw, f.bank * 0.9);
      o.userData.mat.emissive.setRGB(f.flash * 1.2, f.flash * 0.9, f.flash * 0.7);
    });
    enemyObjs.forEach(function (o, id) {
      if (!seen.has(id)) { scene.remove(o); enemyObjs.delete(id); }
    });

    // ミサイル: 炎と煙を出す
    game.missiles.forEach(function (m) {
      spawnParticle(m.pos.x, m.pos.y, m.pos.z, 0, 0, 0, 0.12, 4, 1, [1, 0.9, 0.6], [1, 0.4, 0.1]);
      spawnParticle(m.pos.x, m.pos.y, m.pos.z, rnd(-2, 2), rnd(-2, 2), rnd(-2, 2), 0.9, 1.5, 5, [0.35, 0.35, 0.4], [0.05, 0.05, 0.06], 1);
    });

    // 戦艦
    const b = game.boss;
    if (b && b.phase !== 'dead') {
      if (!bossObj) { bossObj = makeBossModel(); scene.add(bossObj); }
      const u = bossObj.userData;
      bossObj.visible = true;
      bossObj.position.set(b.pos.x, b.pos.y, b.pos.z);
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
          if (!p.alive && Math.random() < dt * 6) {
            spawnParticle(p.pos.x + rnd(-4, 4), p.pos.y + rnd(-2, 2), p.pos.z + rnd(-4, 4), p.face.x * 8 + rnd(-2, 2), p.face.y * 8 + rnd(-2, 2), p.face.z * 8 + rnd(-2, 2), 2.0, 6, 20, [0.4, 0.25, 0.15], [0.05, 0.05, 0.05], 0.3);
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
          o.visible = !b.armor && p.alive;
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
        const s = (b.phase === 'arrive' ? 90 : 55) * (0.9 + Math.random() * 0.2) * (aliveEngines(b) / 2 * 0.7 + 0.3);
        t.scale.setScalar(s);
      });
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
    } else if (bossObj && b && b.phase === 'dead') {
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
      _tmp.set(game.boss.pos.x, game.boss.pos.y, game.boss.pos.z);
      _look.lerp(_tmp, 0.25 * bossK);
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
  }

  function updateTitleCamera(dt) {
    titleT += dt;
    shipObj.position.set(0, 0, 0);
    shipObj.rotation.order = 'YXZ';
    shipObj.rotation.set(0.05 * Math.sin(titleT * 0.7), -0.15, 0.12 * Math.sin(titleT * 0.5));
    shipObj.userData.flames.forEach(function (f, i) { const s = (i % 2 ? 5 : 3.2) * (0.9 + Math.random() * 0.2); f.scale.set(s, s, 1); });
    const a = -0.85 + Math.sin(titleT * 0.12) * 0.25;
    camera.position.set(Math.sin(a) * 26, 6 + Math.sin(titleT * 0.2) * 2, Math.cos(a) * 26 - 4);
    camera.up.set(0, 1, 0);
    camera.fov = 52; camera.updateProjectionMatrix();
    camera.lookAt(-6, 1.5, -6);
    sky.position.copy(camera.position);
    planet.position.copy(camera.position).multiplyScalar(0.85).add(planet.userData.offset);
    planet.quaternion.copy(camera.quaternion);
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

  const hudInfo = { reticle: null, focusLead: null, markers: 0 };

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
      ts.forEach(function (t) {
        const s = toScreen(t.pos);
        const d = dist3(t.pos, pl.pos);
        const isFocus = pl.focus && pl.focus.target === t;
        const col = t.kind === 'fighter' ? '255,90,90' : t.kind === 'turret' ? '255,170,80' : '255,80,200';
        const on = !s.behind && s.x > 10 && s.x < W - 10 && s.y > 10 && s.y < H - 10;
        if (on) {
          markers++;
          const size = Math.max(9, Math.min(40, t.radius * 900 / Math.max(d, 1) * (H / 430)));
          c.strokeStyle = 'rgba(' + col + ',' + (isFocus ? 0.95 : 0.6) + ')';
          c.lineWidth = isFocus ? 2 : 1.4;
          const q = size * 0.45;
          c.beginPath();
          [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (k) {
            c.moveTo(s.x + k[0] * size, s.y + k[1] * size - k[1] * q);
            c.lineTo(s.x + k[0] * size, s.y + k[1] * size);
            c.lineTo(s.x + k[0] * size - k[0] * q, s.y + k[1] * size);
          });
          c.stroke();
          if (isFocus) {
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
        } else if (t.kind === 'fighter' || (game.boss && t === nearestPart(ts, pl))) {
          // 画面の外: ふちに矢印
          let dx = s.x - W / 2, dy = s.y - H / 2;
          if (s.behind) { dx = -dx; dy = -dy; }
          const ang = Math.atan2(dy, dx);
          const rx = W / 2 - sar - 30, ry = H / 2 - 34;
          const ex = W / 2 + Math.cos(ang) * rx, ey = H / 2 + Math.sin(ang) * ry;
          c.save();
          c.translate(ex, ey); c.rotate(ang);
          c.fillStyle = 'rgba(' + col + ',.85)';
          c.beginPath(); c.moveTo(12, 0); c.lineTo(-4, -8); c.lineTo(-1, 0); c.lineTo(-4, 8); c.closePath(); c.fill();
          c.restore();
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
      if (pl.lockId && pl.lockT > 0) {
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
    const x0 = sal + 4, y0 = 12;
    bar(c, x0, y0, 150, 7, pl.shield / K.shieldMax, '#5ab8ff', 'SHIELD');
    bar(c, x0, y0 + 20, 150, 7, pl.hull / K.hullMax, pl.hull < 35 ? '#ff5a5a' : '#e8ecf4', 'HULL');
    bar(c, x0, y0 + 40, 110, 5, pl.boost / 100, pl.boosting ? '#ffe08a' : '#ffb547', 'BOOST');
    // 速度
    c.textAlign = 'left';
    c.font = '700 12px -apple-system, sans-serif';
    c.fillStyle = 'rgba(200,225,255,.9)';
    c.fillText(Math.round(pl.speed) + ' m/s', sal + 4 + 64, H - 14);

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
      const phaseName = { arrive: '接近中', battle: '砲台', cannon: '砲台 / 主砲', weak: 'エンジン', core: 'コア', dying: '撃沈' }[b.phase] || '';
      c.fillText('巨大戦艦  ' + phaseName, W / 2, 14);
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
    if (pl.outside) {
      c.textAlign = 'center';
      c.font = '800 14px -apple-system, sans-serif';
      c.fillStyle = Math.sin(game.t * 10) > 0 ? '#ffb547' : 'rgba(255,181,71,.4)';
      c.fillText('戦域外  引き返します', W / 2, H * 0.3);
    }

    // 帯の文字 (段階・警告)
    fx.banners = fx.banners.filter(function (bn) { return (bn.t -= dt) > 0; });
    fx.banners.forEach(function (bn, i) {
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

  function bar(c, x, y, w, h, v, color, label) {
    c.fillStyle = 'rgba(0,0,0,.45)';
    c.fillRect(x, y, w, h);
    c.fillStyle = color;
    c.fillRect(x, y, w * C.clamp(v, 0, 1), h);
    c.strokeStyle = 'rgba(160,200,255,.35)';
    c.lineWidth = 1;
    c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    c.font = '600 9px -apple-system, sans-serif';
    c.textAlign = 'left';
    c.fillStyle = 'rgba(200,220,255,.75)';
    c.fillText(label, x + w + 6, y + h);
  }

  // 操作部品の表示 (変わったときだけ書き換える)
  const shown = { throttle: -1, missiles: -1, locked: null, boostEmpty: null };
  function updateControlsView() {
    const pl = game.player;
    if (Math.abs(shown.throttle - input.throttle) > 0.002) {
      shown.throttle = input.throttle;
      els.throttleFill.style.height = (input.throttle * 100).toFixed(1) + '%';
      els.throttleKnob.style.top = (10 + (1 - input.throttle) * 200).toFixed(1) + 'px';
    }
    if (shown.missiles !== pl.missiles) {
      shown.missiles = pl.missiles;
      els.missileCount.textContent = String(pl.missiles);
      els.btnMissile.classList.toggle('empty', pl.missiles === 0);
    }
    if (shown.locked !== pl.locked) { shown.locked = pl.locked; els.btnMissile.classList.toggle('locked', pl.locked); }
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

    if (screen === 'title' || !game) {
      if (shipObj) updateTitleCamera(realDt);
      updateParticles(realDt);
      renderer.render(scene, camera);
      hud.setTransform(1, 0, 0, 1, 0, 0);
      hud.clearRect(0, 0, els.hud.width, els.hud.height);
      return;
    }

    let dt = realDt;
    if (paused) dt = 0;
    // 撃沈の瞬間はゆっくりに
    if (fx.slowT > 0) { fx.slowT = Math.max(0, fx.slowT - realDt); dt *= 0.35; }

    if (dt > 0 && screen === 'play') {
      const kb = readKeys(realDt);
      const stepInput = {
        stickX: C.clamp(input.stickX + kb.kx, -1, 1),
        stickY: C.clamp(input.stickY + kb.ky, -1, 1),
        throttle: input.throttle,
        fire: touch.fireIds.size > 0 || kb.fire,
        boost: touch.boostIds.size > 0 || kb.boost,
        missile: input.missile
      };
      if (window.__autopilot) Object.assign(stepInput, C.autopilot(game, 1));
      input.missile = false;
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
    bindToggle(['optInvert', 'optInvert2'], 'invert');
    bindToggle(['optShake', 'optShake2'], 'shake');
    bindToggle(['optSound', 'optSound2'], 'sound');
    $('btnStart').addEventListener('click', function () { startGame(); });
    $('btnBossOnly').addEventListener('click', function () { startGame({ start: 'boss' }); });
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
      settings: settings,
      assetsLoaded: function () { return Object.assign({}, assetsLoaded); },
      setSkyDim: setSkyDim,
      skyDim: function () { return skyDim; },
      renderInfo: function () { return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }; }
    };
  }

  main();
})();
