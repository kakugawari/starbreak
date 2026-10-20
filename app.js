/*!
 * app.js — 描画と操作。ゲームの中身は core.js が進め、ここはそれを描いて、指の操作を渡す。
 */
(function () {
  'use strict';

  const VERSION = 'v0.5.10';
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

  const JET_MAT = new THREE.MeshBasicMaterial({
    map: jetTex, color: 0x8fd4ff, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide
  });

  /**
   * 自機の噴射を推力に合わせる。光だけで見せる: 噴射口の白い芯・小さな青い光・後ろへ延びる光の筋。
   * thrust はふだん 1 前後、ブーストで 1.9
   */
  function setThrust(ship, thrust) {
    const fl = 0.92 + Math.random() * 0.16;
    ship.userData.flames.forEach(function (f, i) {
      const s = (i % 2 ? 2.6 + 1.2 * thrust : 1.6 + 0.7 * thrust) * fl;
      f.scale.set(s, s, 1);
    });
    const len = (1.5 + 3.5 * Math.pow(thrust, 1.5)) * fl, wid = 0.8 + 0.45 * thrust;
    ship.userData.jets.forEach(function (j) { j.scale.set(wid, wid, len); });
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
  function makeEnemyShip() {
    const g = new THREE.Group();
    const body = new THREE.Group();
    g.add(body);
    // 当たったときに白く光らせるので、機体ごとに材質を分ける
    const hull = ENEMY_MAT.hull.clone();

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
    const mapv = function (v) { return swap ? [v[0], v[2], v[1]] : v; };
    let cx = 0, cz = 0;
    P.forEach(function (q) { cx += q[0]; cz += q[1]; });
    cx /= P.length; cz /= P.length;
    const tri = function (a, b, c, n, ua, ub, uc) {
      a = mapv(a); b = mapv(b); c = mapv(c); n = mapv(n);
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

  function makeBossModel() {
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
    const hullMesh = new THREE.Mesh(geoFrom(hull), hullMat);
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
    const armor = new THREE.Mesh(geoFrom(armorGeo), hullMat);
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
    if (e.code === 'KeyE' || e.code === 'KeyM') input.missile = true;
    if (e.code === 'KeyQ' || e.code === 'KeyT') input.select = true;
    if ((e.code === 'Escape' || e.code === 'KeyP') && screen === 'play') setPaused(!paused);
    if (e.code === 'Space' || e.code.indexOf('Arrow') === 0) e.preventDefault();
  });
  window.addEventListener('keyup', function (e) { keys[e.code] = false; });
  window.addEventListener('blur', function () { for (const k in keys) keys[k] = false; });

  function readKeys(dt) {
    const kx = (keys.ArrowRight || keys.KeyD ? 1 : 0) - (keys.ArrowLeft || keys.KeyA ? 1 : 0);
    const ky = (keys.ArrowUp || keys.KeyW ? 1 : 0) - (keys.ArrowDown || keys.KeyS ? 1 : 0);
    return {
      kx: kx, ky: ky * (settings.invert ? -1 : 1), fire: !!(keys.Space || keys.KeyJ),
      boost: !!(keys.ShiftLeft || keys.ShiftRight || keys.KeyK), track: !!(keys.KeyQ || keys.KeyT)
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
    input.stickX = 0; input.stickY = 0; input.missile = false;
    touch.fireIds.clear(); touch.boostIds.clear(); touch.trackIds.clear();
    els.btnFire.classList.remove('on'); els.btnBoost.classList.remove('on'); els.btnTarget.classList.remove('on');
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

  // タイトルの板の中身を切り替える (始めるボタン / 設定 / 遊び方)。もう一度押すと戻る
  function showMenu(id) {
    if (id !== 'menuMain' && !$(id).hidden) id = 'menuMain';
    ['menuMain', 'menuSettings', 'menuHowto'].forEach(function (k) { $(k).hidden = k !== id; });
    $('btnSettings').classList.toggle('on', id === 'menuSettings');
    $('btnHowto').classList.toggle('on', id === 'menuHowto');
  }

  function toTitle() {
    showMenu('menuMain');
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
      touch.fireIds.clear(); touch.boostIds.clear(); touch.trackIds.clear();
      els.btnFire.classList.remove('on'); els.btnBoost.classList.remove('on'); els.btnTarget.classList.remove('on');
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
      if (!o) { o = makeEnemyShip(); enemyObjs.set(f.id, o); scene.add(o); }
      o.position.set(f.pos.x, f.pos.y, f.pos.z);
      const yp = C.yawPitchOf(f.dir);
      o.rotation.order = 'YXZ';
      o.rotation.set(yp.pitch, yp.yaw, f.bank * 0.9);
      o.userData.mats.forEach(function (m) { m.emissive.setRGB(f.flash * 1.2, f.flash * 0.9, f.flash * 0.7); });
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
        const s = (b.phase === 'arrive' ? 70 : 42) * (0.9 + Math.random() * 0.2) * (aliveEngines(b) / 2 * 0.7 + 0.3);
        t.scale.setScalar(s);
      });
      // 真ん中の輪: ゆっくり脈打つ。コアがむき出しになったら強く速く
      const exposed = !b.armor;
      const beat = 0.75 + 0.25 * Math.sin(game.t * (exposed ? 9 : 2.5));
      u.topGlow.material.opacity = (exposed ? 0.85 : 0.5) * beat;
      u.topGlow.scale.setScalar((exposed ? 230 : 190) * (0.95 + 0.05 * beat));
      u.sideRings.forEach(function (gl) { gl.material.opacity = 0.45 * beat; });
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
    icon: { pos: [-9, 10, 15], up: [0, 1, 0], rot: [0.05, 0.1, -0.5], k: 1.25, thrust: 1.9 }
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
    sky.visible = !!v.sky; planet.visible = !!v.planet; dust.lines.visible = false;
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
    // 斜め前の右から (日の当たる側)。ゆっくり少しだけ回り込む
    const a = 2.3 + Math.sin(titleT * 0.12) * 0.2;
    camera.position.set(Math.sin(a) * 24, 5 + Math.sin(titleT * 0.2) * 1.5, Math.cos(a) * 24);
    camera.up.set(0, 1, 0);
    camera.fov = 52; camera.updateProjectionMatrix();
    // 機体がロゴとメニューの間の下 (画面の x 48%・y 74%) に来るよう、見る所をずらす
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const d = camera.position.length();
    const halfH = Math.tan(camera.fov * Math.PI / 360) * d, halfW = halfH * camera.aspect;
    const sx = 0.48 * 2 - 1, sy = 1 - 0.74 * 2;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    camera.lookAt(right.multiplyScalar(-sx * halfW).add(up.multiplyScalar(-sy * halfH)));
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
      els.missileCount.textContent = String(pl.missiles);
      els.btnMissile.classList.toggle('empty', pl.missiles === 0);
    }
    if (shown.locked !== pl.locked) { shown.locked = pl.locked; els.btnMissile.classList.toggle('locked', pl.locked); }
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

    let dt = realDt;
    if (paused) dt = 0;
    // 撃沈の瞬間はゆっくりに
    if (fx.slowT > 0) { fx.slowT = Math.max(0, fx.slowT - realDt); dt *= 0.35; }

    if (dt > 0 && screen === 'play') {
      const kb = readKeys(realDt);
      const stepInput = {
        stickX: C.clamp(input.stickX + kb.kx, -1, 1),
        stickY: C.clamp(input.stickY + kb.ky, -1, 1),
        fire: touch.fireIds.size > 0 || kb.fire,
        boost: touch.boostIds.size > 0 || kb.boost,
        missile: input.missile,
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
    document.querySelectorAll('[data-back]').forEach(function (b) { b.addEventListener('click', function () { showMenu('menuMain'); }); });
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
      // 自機のまわり r m にある、大きな (煙の玉のような) 粒の数。ブーストで煙を出さない見張り用
      bigParticlesNear: function (r, minSize) {
        const p = game.player.pos;
        return particles.list.filter(function (q) {
          return q.on && Math.max(q.s0, q.s1) >= minSize && Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < r;
        }).length;
      },
      jetLength: function () { return shipObj.userData.jets[0].scale.z; },
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
        if (shipObj) shipObj.visible = !inspectObj;
        if (!view) { sky.visible = true; planet.visible = true; dust.lines.visible = true; scene.background = null; inspectLight.visible = false; }
        els.title.hidden = !!view || screen !== 'title';
      },
      inspectViews: INSPECT,
      skyDim: function () { return skyDim; },
      renderInfo: function () { return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }; }
    };
  }

  main();
})();
