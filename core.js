/*!
 * core.js — STARBREAK のロジック。DOM も three.js も触らない。
 *
 * ゲームの中身 (飛行・照準補助・敵AI・巨大戦艦・当たり判定・進行) は
 * すべてここで進める。app.js は入力を渡して、結果を描くだけ。
 * だから node で「狙えば当たるか」「ボスは倒せるか」まで確かめられる。
 *
 * 座標は three.js と同じ: 右手系、Y が上、前は -Z。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.Core = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEG = Math.PI / 180;

  // ------------------------------------------------------------ 乱数

  /** 同じ seed からは必ず同じ並び (mulberry32)。 */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------ ベクトル

  function vec(x, y, z) { return { x: x || 0, y: y || 0, z: z || 0 }; }
  function copy(a) { return { x: a.x, y: a.y, z: a.z }; }
  function add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function scale(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
  function addScaled(a, b, s) { return { x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s }; }
  function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function cross(a, b) {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function dist(a, b) { return len(sub(a, b)); }
  function norm(a) {
    const l = len(a);
    return l > 1e-9 ? scale(a, 1 / l) : { x: 0, y: 0, z: -1 };
  }
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /** 指数で近づける。dt によらず同じ速さで寄る。 */
  function approach(cur, target, rate, dt) {
    return cur + (target - cur) * (1 - Math.exp(-rate * dt));
  }

  /** 2つの向きのなす角 (ラジアン)。 */
  function angleBetween(a, b) {
    return Math.acos(clamp(dot(norm(a), norm(b)), -1, 1));
  }

  /** 単位ベクトル a を b へ、最大 maxAngle だけ回す (球面補間)。 */
  function rotateToward(a, b, maxAngle) {
    a = norm(a); b = norm(b);
    const ang = Math.acos(clamp(dot(a, b), -1, 1));
    if (ang <= maxAngle || ang < 1e-6) return b;
    const t = maxAngle / ang;
    if (ang > Math.PI - 1e-3) {
      // 真後ろ: 回す軸が決まらないので、上か横を軸にする
      const axis = Math.abs(a.y) < 0.9 ? vec(0, 1, 0) : vec(1, 0, 0);
      const side = norm(cross(a, axis));
      return norm(add(scale(a, Math.cos(maxAngle)), scale(side, Math.sin(maxAngle))));
    }
    const s = Math.sin(ang);
    return norm(add(scale(a, Math.sin((1 - t) * ang) / s), scale(b, Math.sin(t * ang) / s)));
  }

  /** ヨー・ピッチから前の向き。yaw は左回りが正、pitch は上が正。 */
  function forwardFrom(yaw, pitch) {
    const c = Math.cos(pitch);
    return { x: -Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
  }
  function yawPitchOf(dir) {
    const d = norm(dir);
    return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.asin(clamp(d.y, -1, 1)) };
  }
  function wrapAngle(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  /**
   * 偏差射撃: 速さ speed の弾を撃って、等速で動く的に当たる点。
   * |P + V t| = s t を t について解く。当たらなければ null。
   */
  function intercept(from, targetPos, targetVel, speed) {
    const P = sub(targetPos, from);
    const V = targetVel;
    const a = dot(V, V) - speed * speed;
    const b = 2 * dot(P, V);
    const c = dot(P, P);
    let t;
    if (Math.abs(a) < 1e-6) {
      if (Math.abs(b) < 1e-9) return null;
      t = -c / b;
    } else {
      const disc = b * b - 4 * a * c;
      if (disc < 0) return null;
      const r = Math.sqrt(disc);
      const t1 = (-b - r) / (2 * a);
      const t2 = (-b + r) / (2 * a);
      t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
    }
    if (!(t > 0)) return null;
    return { t: t, point: addScaled(targetPos, V, t) };
  }

  /** 線分 p0→p1 が球に入る最初の位置 (0〜1)。入らなければ -1。速い弾のすり抜けを防ぐ。 */
  function segmentSphere(p0, p1, c, r) {
    const d = sub(p1, p0);
    const f = sub(p0, c);
    const a = dot(d, d);
    const cc = dot(f, f) - r * r;
    if (cc <= 0) return 0;            // 始めから中にいる
    if (a < 1e-12) return -1;
    const b = 2 * dot(f, d);
    const disc = b * b - 4 * a * cc;
    if (disc < 0) return -1;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    return t >= 0 && t <= 1 ? t : -1;
  }

  /** 線分 p0→p1 が箱 (min/max) に入る最初の位置 (0〜1)。入らなければ -1。 */
  function segmentBox(p0, p1, min, max) {
    let t0 = 0, t1 = 1;
    const axes = ['x', 'y', 'z'];
    for (let i = 0; i < 3; i++) {
      const k = axes[i];
      const d = p1[k] - p0[k];
      if (Math.abs(d) < 1e-12) {
        if (p0[k] < min[k] || p0[k] > max[k]) return -1;
      } else {
        let ta = (min[k] - p0[k]) / d;
        let tb = (max[k] - p0[k]) / d;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) return -1;
      }
    }
    return t0;
  }

  /** 球が箱にめり込んでいたら、押し出す向きと深さ。 */
  function sphereBoxPush(c, r, min, max) {
    const q = { x: clamp(c.x, min.x, max.x), y: clamp(c.y, min.y, max.y), z: clamp(c.z, min.z, max.z) };
    const d = sub(c, q);
    const l = len(d);
    if (l > 1e-6) {
      return l < r ? { normal: scale(d, 1 / l), depth: r - l } : null;
    }
    // 中心が箱の中: いちばん近い面から出す
    const cand = [
      { n: vec(-1, 0, 0), d: c.x - min.x }, { n: vec(1, 0, 0), d: max.x - c.x },
      { n: vec(0, -1, 0), d: c.y - min.y }, { n: vec(0, 1, 0), d: max.y - c.y },
      { n: vec(0, 0, -1), d: c.z - min.z }, { n: vec(0, 0, 1), d: max.z - c.z }
    ];
    cand.sort(function (a, b) { return a.d - b.d; });
    return { normal: cand[0].n, depth: cand[0].d + r };
  }

  /**
   * フレームの間隔 (ミリ秒の差) を秒にする。上も下も止める。
   * 負の dt が素通りすると全部が逆に飛ぶ (CLAUDE.md の落とし穴)。
   */
  function frameDt(ms) {
    if (!(ms > 0)) return 0;
    return Math.min(ms / 1000, 0.05);
  }

  // ------------------------------------------------------------ 調整値

  const T = {
    // 飛行 (企画書の初期値)
    speedMin: 20, speedMax: 100, speedNormal: 60, speedBoost: 140,
    accel: 55, boostAccel: 140,
    // 自動の速さ: スティックをこれより大きく倒すと減速を始め、いっぱいで autoSlowSpeed まで落とす
    autoSlowFrom: 0.6, autoSlowSpeed: 28,
    turnSlow: 90 * DEG,         // 低速時の最大旋回
    turnFast: 52 * DEG,         // 最高速時
    turnBoost: 40 * DEG,
    turnResponse: 7,            // 入力への追従 (大きいほど機敏)
    pitchLimit: 78 * DEG,
    rollMax: 45 * DEG,
    boostDrain: 38, boostRegen: 22, boostRegenDelay: 0.6,
    // 自機の耐久
    shieldMax: 60, hullMax: 100, shieldRegen: 9, shieldRegenDelay: 3.5,
    playerRadius: 4,
    // レーザー
    laserSpeed: 620, laserLife: 1.6, laserInterval: 0.09, laserDamage: 1,
    // 照準補助
    focusCone: 26 * DEG, focusRange: 1300,
    assistCone: 7 * DEG,        // この角度の中にいる敵だけ補助する
    assistBend: 3 * DEG,        // 弾を曲げるのは最大これだけ
    magnetCone: 8 * DEG, magnetRate: 14 * DEG,
    // ミサイル
    lockCone: 15 * DEG, lockRange: 950, lockTime: 0.6,
    missileMax: 4, missileReload: 4, missileDamage: 8,
    // マルチロック: MSL を押している間、照準のまわりの敵を 1 つずつ捕まえ、離すと捕まえた数だけ一斉に撃つ
    multiCone: 22 * DEG, multiLockTime: 0.28, multiFan: 9 * DEG,
    missileSpeed0: 110, missileSpeed1: 330, missileTurn: 210 * DEG, missileLife: 6,
    // 敵戦闘機
    // 敵は自機 (ふだん 60m/s・約70°/秒) より遅く、小回りも利かない。追えば背後を取れる
    fighterHp: 5, fighterRadius: 7, fighterSpeed: 54, fighterTurn: 58 * DEG,
    enemyShotSpeed: 270, enemyShotLife: 2.2, fighterShotDamage: 5,
    fighterFireRange: 520, fighterFireCone: 9 * DEG, fighterAimError: 1.6 * DEG,
    maxBursting: 2,
    // 巨大戦艦
    turretHp: 14, engineHp: 30, coreHp: 50,
    // ボス戦で、しばらく何も当てていない (次の的へ回り込んでいる) とき、撃ち返さない小さな的 (ドローン) を
    // 自機の正面の先からこちらへ飛ばす。1 発で落ち、少しで飛び去る。護衛機を出すと追い回してボス戦が 1.2〜1.7 倍に延び、
    // 前を横切らせると照準の前にいる時間が短くて空白があまり減らなかったため (droneMode 'cross' は試した形として残す)
    droneLull: 4, droneGap: 7, droneCount: 4, droneHp: 1, droneSpeed: 45, droneLife: 7, droneAhead: 420, droneSpan: 230, droneMode: 'oncoming',
    turretShotDamage: 6, turretRange: 1150, turretShotSpeed: 240,
    cannonCharge: 2.8, cannonLockBefore: 1.0, cannonFire: 1.0,
    cannonRadius: 12, cannonDamage: 45, cannonLength: 3200,
    hullDamage: 12,
    // 戦域
    arenaCenter: vec(0, 0, -600), arenaRadius: 2600
  };

  // ------------------------------------------------------------ 巨大戦艦の形
  //
  // 当たり判定と見た目を同じ表から作る。見た目と判定が食い違いようがない。
  // 1 つ 1 つの立体は「上から見た凸の多角形 (x, z) を、高さ y0〜y1 で押し出したもの」。
  // 円い胴も、斜めに落とした船首も、段々の艦橋も、箱も、これで表せる。
  // 戦艦は回さない (向きは常に艦首が -X)。
  // 形と比率は、送ってもらった三面図を測って決めた (絵の 705px = 640m、1px ≒ 0.91m)。
  // 真ん中に赤く光る輪のある円い胴、左右に前後へ延びる 2 本の船体、前の真ん中に長い主砲、
  // 後ろの真ん中に段々の艦橋。全長 640m・幅 228m。

  function box(x0, x1, z) { return [[x0, -z], [x1, -z], [x1, z], [x0, z]]; }
  function ring(n, r, cx, cz) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i + 0.5) / n * Math.PI * 2;
      out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
    return out;
  }
  /** 左右の船体の前半。前のはしを斜めに落とす (z の符号 sz で左右を作る)。 */
  function podFront(sz) {
    return [[-332, sz * 60], [-300, sz * 114], [-50, sz * 114], [-50, sz * 36], [-310, sz * 36]];
  }

  const BOSS_SOLIDS = [
    // 真ん中の円い胴 (上に赤く光る輪)
    { name: 'hub', poly: ring(16, 72, 0, 0), y0: -32, y1: 32 },
    // 左右の大きな円盤 (横向き)。船体の前半と後半のあいだに挟まる
    { name: 'wheelL', axis: 'z', poly: ring(14, 55, 0, 0), z0: -116, z1: -40 },
    { name: 'wheelR', axis: 'z', poly: ring(14, 55, 0, 0), z0: 40, z1: 116 },
    // 左右の船体 (前半・後半)
    { name: 'podFrontL', poly: podFront(-1), y0: -26, y1: 26 },
    { name: 'podFrontR', poly: podFront(1), y0: -26, y1: 26 },
    { name: 'podAftL', poly: [[50, -114], [282, -114], [282, -36], [50, -36]], y0: -26, y1: 26 },
    { name: 'podAftR', poly: [[50, 36], [282, 36], [282, 114], [50, 114]], y0: -26, y1: 26 },
    // 前の真ん中: 主砲の台
    { name: 'spine', poly: box(-291, -60, 23), y0: -18, y1: 18 },
    // 後ろの真ん中と、その上の段々の艦橋
    { name: 'aft', poly: box(60, 246, 36), y0: -26, y1: 34 },
    { name: 'tower1', poly: box(110, 200, 30), y0: 34, y1: 50 },
    { name: 'tower2', poly: box(125, 190, 22), y0: 50, y1: 66 },
    { name: 'bridge', poly: box(135, 185, 26), y0: 66, y1: 78 },
    // コアの蓋 (輪の真ん中をふさぐ)。エンジンをこわすと外れる。コア (中心 36・半径 15) をすっぽり覆う
    { name: 'armor', poly: ring(8, 40, 0, 0), y0: 32, y1: 54, armor: true }
  ];

  const BOSS_PARTS = [
    // 砲台: 左右の船体の上に前後 2 つずつ、下に 1 つずつ (下を死角にしない)
    { kind: 'turret', at: vec(-150, 32, -75), face: vec(0, 1, 0) },
    { kind: 'turret', at: vec(-150, 32, 75),  face: vec(0, 1, 0) },
    { kind: 'turret', at: vec(140, 32, -75),  face: vec(0, 1, 0) },
    { kind: 'turret', at: vec(140, 32, 75),   face: vec(0, 1, 0) },
    { kind: 'turret', at: vec(-200, -32, -75), face: vec(0, -1, 0) },
    { kind: 'turret', at: vec(-200, -32, 75),  face: vec(0, -1, 0) },
    // エンジン: 左右の船体の後ろ
    { kind: 'engine', at: vec(296, 0, -75),   face: vec(1, 0, 0) },
    { kind: 'engine', at: vec(296, 0, 75),    face: vec(1, 0, 0) },
    // コア: 真ん中の輪の中
    { kind: 'core',   at: vec(0, 36, 0),      face: vec(0, 1, 0) }
  ];

  // 主砲の砲身の先
  const BOSS_CANNON = vec(-352, 0, 0);
  // 自機 (高さ 0) より 300m 下に来る。真横からだと平たい船体が細い線にしか見えないので、
  // 甲板と段々の上部構造を見下ろせる高さにする
  // ボスの登場: カットインの間に、自機の近く (前へ 700m・下へ 150m) の右側 (+x) に赤いワープの光が開く。
  // 終わると、その光の中から艦首 (-x) を先にゆっくり出てきて止まる。遠くから来ると小さくてショボく見えたため。
  // 下に置くのは、真横からだと平たい船体が線にしか見えないため
  const BOSS_WARP_DELAY = 2.3;  // カットインのあいだ (光が開いていく。艦はまだ光の向こう)
  const BOSS_EMERGE = 3.0;      // 光の中から出きるまで (はじめ速く、だんだんゆっくり止まる)
  const BOSS_BOW = -360, BOSS_STERN = 320;  // 艦首 (主砲の先) と艦尾 (噴射の光) の x
  const BOSS_PORTAL = BOSS_STERN + 40;      // ワープの光は、止まる所から +x にこれだけ離れた所
  const BOSS_AHEAD = 700, BOSS_DROP = 150;  // 見下ろす角度 12°: 画面の下寄りの真ん中に出る (下 300m だと画面の下のふちに切れた)
  const BOSS_ARRIVE = 5.8;     // ここで戦闘が始まる (前は遠くから 13 秒かけて来ていた)

  /**
   * 立体を押し出す向き。ふつうは上下 (y)。axis: 'z' の立体は、横から見た多角形 (x, y) を
   * 左右 (z0〜z1) に押し出したもの (横向きの円盤など)。
   * 計算は「多角形が (x, z)・高さが y」の形でして、最後に y と z を入れ替える。
   */
  function solidRange(solid) {
    return solid.axis === 'z' ? [solid.z0, solid.z1] : [solid.y0, solid.y1];
  }
  function axisMap(solid, v) {
    return solid.axis === 'z' ? vec(v.x, v.z, v.y) : v;
  }

  /**
   * 立体を、外向きの面 (n・p <= d が内側) の並びにする。off は戦艦の位置。
   * 多角形の向き (時計回りか) によらず、重心から外を向く法線を選ぶ。
   */
  function solidPlanes(solid, off) {
    const P = solid.poly;
    const r = solidRange(solid);
    let cx = 0, cz = 0;
    for (let i = 0; i < P.length; i++) { cx += P[i][0]; cz += P[i][1]; }
    cx /= P.length; cz /= P.length;
    const canon = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      let n = norm(vec(b[1] - a[1], 0, -(b[0] - a[0])));
      const mid = vec((a[0] + b[0]) / 2 - cx, 0, (a[1] + b[1]) / 2 - cz);
      if (dot(n, mid) < 0) n = scale(n, -1);
      canon.push({ n: n, d: dot(n, vec(a[0], 0, a[1])) });
    }
    canon.push({ n: vec(0, 1, 0), d: r[1] });
    canon.push({ n: vec(0, -1, 0), d: -r[0] });
    // 押し出す向きに直して、戦艦の位置へずらす
    const planes = canon.map(function (pl) {
      const n = axisMap(solid, pl.n);
      return { n: n, d: pl.d + dot(n, off) };
    });
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (let i = 0; i < P.length; i++) {
      x0 = Math.min(x0, P[i][0]); x1 = Math.max(x1, P[i][0]);
      z0 = Math.min(z0, P[i][1]); z1 = Math.max(z1, P[i][1]);
    }
    const lo = axisMap(solid, vec(x0, r[0], z0)), hi = axisMap(solid, vec(x1, r[1], z1));
    return { name: solid.name, planes: planes, min: add(lo, off), max: add(hi, off) };
  }

  /** 線分 p0→p1 が凸の立体に入る最初の位置 (0〜1)。入らなければ -1。 */
  function segmentSolid(p0, p1, planes) {
    let t0 = 0, t1 = 1;
    const d = sub(p1, p0);
    for (let i = 0; i < planes.length; i++) {
      const pl = planes[i];
      const dn = dot(pl.n, d);
      const dist = dot(pl.n, p0) - pl.d;
      if (Math.abs(dn) < 1e-12) {
        if (dist > 0) return -1;
      } else {
        const t = -dist / dn;
        if (dn < 0) { if (t > t0) t0 = t; } else if (t < t1) t1 = t;
        if (t0 > t1) return -1;
      }
    }
    return t0;
  }

  /** 球が凸の立体にめり込んでいたら、押し出す向きと深さ (いちばん近い面から出す)。 */
  function sphereSolidPush(c, r, planes) {
    let best = -1e9, bi = -1;
    for (let i = 0; i < planes.length; i++) {
      const dist = dot(planes[i].n, c) - planes[i].d;
      if (dist > best) { best = dist; bi = i; }
    }
    if (best >= r) return null;
    return { normal: planes[bi].n, depth: r - best };
  }

  function pointInSolid(p, planes) {
    for (let i = 0; i < planes.length; i++) if (dot(planes[i].n, p) - planes[i].d > 0) return false;
    return true;
  }

  // ------------------------------------------------------------ ゲーム

  function createGame(opts) {
    opts = opts || {};
    const seed = (opts.seed === undefined ? 1 : opts.seed) >>> 0;
    const g = {
      seed: seed,
      rng: mulberry32(seed),
      t: 0,
      state: 'play',          // play / ending / clear / over
      stage: opts.start === 'boss' ? 'bossIn' : 'wave1',
      stageTimer: 0,
      nextId: 1,
      player: {
        pos: vec(0, 0, 0), yaw: 0, pitch: 0, roll: 0,
        yawRate: 0, pitchRate: 0,
        dir: vec(0, 0, -1), vel: vec(0, 0, -T.speedNormal),
        speed: T.speedNormal, throttle: 0.5,
        boost: 100, boosting: false, boostIdle: 0,
        shield: T.shieldMax, hull: T.hullMax, sinceHit: 99, scrapeCd: 0,
        laserCd: 0, gun: 0,
        missiles: T.missileMax, missileCd: 0,
        focus: null, assist: null, lockId: 0, lockT: 0, locked: false,
        mlock: [], mlockT: 0, mlockCand: 0,
        targetId: 0, tracking: false,
        aimDir: vec(0, 0, -1), alive: true, outside: false
      },
      fighters: [],
      shots: [],
      missiles: [],
      boss: null,
      events: [],
      stats: { shots: 0, hits: 0, kills: 0, score: 0, damage: 0, combo: 0, comboT: 0, time: 0 },
      endT: 0
    };
    if (g.stage === 'wave1') spawnWave(g, 1);
    return g;
  }

  function rand(g, a, b) { return a + (b - a) * g.rng(); }
  function emit(g, type, data) {
    const e = data || {};
    e.type = type;
    g.events.push(e);
  }

  function makeFighter(g, pos, dir) {
    return {
      id: g.nextId++, kind: 'fighter', pos: copy(pos), dir: norm(dir),
      vel: scale(norm(dir), T.fighterSpeed), speed: T.fighterSpeed,
      hp: T.fighterHp, maxHp: T.fighterHp, radius: T.fighterRadius, alive: true, active: true,
      mode: 'attack', modeT: 0, breakDir: vec(0, 0, -1),
      fireCd: rand(g, 1.0, 2.5), burst: 0, burstCd: 0,
      bank: 0, flash: 0, skill: rand(g, 0.9, 1.1)
    };
  }

  function spawnWave(g, n) {
    const p = g.player.pos;
    if (n === 1) {
      for (let i = 0; i < 3; i++) {
        const pos = add(p, vec(-140 + i * 140, rand(g, -40, 60), -760 - i * 40));
        g.fighters.push(makeFighter(g, pos, sub(p, pos)));
      }
      emit(g, 'stage', { text: '第1波  敵戦闘機 3機' });
    } else if (n === 2) {
      const offs = [vec(-260, 80, -720), vec(260, -40, -760), vec(-200, 30, 700), vec(220, 90, 680)];
      for (let i = 0; i < offs.length; i++) {
        const pos = add(p, offs[i]);
        g.fighters.push(makeFighter(g, pos, sub(p, pos)));
      }
      emit(g, 'stage', { text: '第2波  4機  後方にも注意' });
    }
  }

  /** ワープして現れる所: 自機の前 (水平の向き) 700m・下 150m。戦う場所の外へはみ出さないよう、中心寄りに詰める */
  function bossSpot(g) {
    const pl = g.player;
    let f = vec(pl.dir.x, 0, pl.dir.z);
    f = len(f) > 1e-3 ? norm(f) : vec(0, 0, -1);
    const at = vec(pl.pos.x + f.x * BOSS_AHEAD, pl.pos.y - BOSS_DROP, pl.pos.z + f.z * BOSS_AHEAD);
    const c = T.arenaCenter, maxR = T.arenaRadius - 800;
    const dx = at.x - c.x, dz = at.z - c.z, d = Math.hypot(dx, dz);
    if (d > maxR) { at.x = c.x + dx * maxR / d; at.z = c.z + dz * maxR / d; }
    return at;
  }

  function makeBoss(g) {
    const at = bossSpot(g);
    const portal = add(at, vec(BOSS_PORTAL, 0, 0));
    const from = add(portal, vec(-BOSS_BOW, 0, 0)); // 艦首がちょうど光の面にある所
    const parts = BOSS_PARTS.map(function (d) {
      const hp = d.kind === 'turret' ? T.turretHp : d.kind === 'engine' ? T.engineHp : T.coreHp;
      return {
        id: g.nextId++, kind: d.kind, local: copy(d.at), face: copy(d.face),
        pos: add(from, d.at), vel: vec(),
        radius: d.kind === 'turret' ? 12 : d.kind === 'engine' ? 17 : 15,
        hp: hp, maxHp: hp, alive: true,
        active: d.kind === 'turret',
        fireCd: rand(g, 1.5, 3.5), flash: 0, aim: vec(0, 1, 0)
      };
    });
    return {
      pos: copy(from), at: at, from: from, portal: portal, vel: vec(), arriveT: 0, shown: false, emerge: 0,
      phase: 'arrive',        // arrive / battle / cannon / weak / core / dying / dead
      parts: parts,
      armor: true,
      cannon: { state: 'idle', t: 0, next: 4, dir: vec(1, 0, 0), from: copy(BOSS_CANNON), hitDone: false },
      dyingT: 0
    };
  }

  /**
   * いま当たり判定に使う戦艦の立体 (世界座標の面の並び)。装甲は外れたら消える。
   * 弾ごと・コマごとに何度も呼ぶので、位置と装甲が変わらない間は作り直さない。
   */
  function bossSolids(boss) {
    const key = boss.pos.x + ',' + boss.pos.y + ',' + boss.pos.z + ',' + boss.armor;
    if (boss._solidsKey === key) return boss._solids;
    const out = [];
    for (let i = 0; i < BOSS_SOLIDS.length; i++) {
      const sd = BOSS_SOLIDS[i];
      if (sd.armor && !boss.armor) continue;
      out.push(solidPlanes(sd, boss.pos));
    }
    boss._solidsKey = key;
    boss._solids = out;
    return out;
  }

  /** 撃てる的の一覧 (戦闘機・戦艦の部位)。 */
  function targets(g) {
    const out = [];
    for (let i = 0; i < g.fighters.length; i++) if (g.fighters[i].alive) out.push(g.fighters[i]);
    if (g.boss && g.boss.phase !== 'arrive' && g.boss.phase !== 'dying' && g.boss.phase !== 'dead') {
      for (let i = 0; i < g.boss.parts.length; i++) {
        const p = g.boss.parts[i];
        if (p.alive && p.active) out.push(p);
      }
    }
    return out;
  }

  function findById(g, id) {
    const ts = targets(g);
    for (let i = 0; i < ts.length; i++) if (ts[i].id === id) return ts[i];
    return null;
  }

  /**
   * 照準: 機首に近い的を選び、偏差の点を出す。
   * focus  : 画面に偏差マーカーを出す相手 (広め)
   * assist : 弾を少し曲げる相手 (狭い。強すぎないように)
   */
  function updateAim(g) {
    const pl = g.player;
    let best = null, bestAng = T.focusCone;
    const ts = targets(g);
    // 狙う相手 (ロックオンボタンで選んだ敵) がいれば、円の外でもそれを優先する
    const sel = pl.targetId ? findById(g, pl.targetId) : null;
    if (sel && dist(sel.pos, pl.pos) <= T.focusRange) {
      const ic = intercept(pl.pos, sel.pos, sel.vel, T.laserSpeed);
      const lead = ic ? ic.point : sel.pos;
      best = { target: sel, lead: lead, ang: angleBetween(pl.dir, sub(lead, pl.pos)), dist: dist(sel.pos, pl.pos) };
      bestAng = -1;   // ほかの的に取られない
    }
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      const d = dist(t.pos, pl.pos);
      if (d > T.focusRange) continue;
      const ic = intercept(pl.pos, t.pos, t.vel, T.laserSpeed);
      const lead = ic ? ic.point : t.pos;
      // 大きい的ほど狙いやすい (見た目の大きさぶん角度を割り引く)
      const ang = angleBetween(pl.dir, sub(lead, pl.pos)) - Math.atan(t.radius / Math.max(d, 1)) * 0.5;
      if (ang < bestAng) { bestAng = ang; best = { target: t, lead: lead, ang: angleBetween(pl.dir, sub(lead, pl.pos)), dist: d }; }
    }
    pl.focus = best;
    pl.assist = best && best.ang <= T.assistCone ? best : null;
    if (pl.assist) {
      pl.aimDir = rotateToward(pl.dir, sub(pl.assist.lead, pl.pos), T.assistBend);
    } else {
      pl.aimDir = copy(pl.dir);
    }

    // ロックオン: 同じ的を円の中に捉え続ける
    const cand = best && best.ang <= T.lockCone && best.dist <= T.lockRange ? best.target : null;
    if (cand && cand.id === pl.lockId) {
      const was = pl.locked;
      pl.lockT += g.dt;
      pl.locked = pl.lockT >= T.lockTime;
      if (pl.locked && !was) emit(g, 'lock', { id: cand.id });
    } else if (cand) {
      pl.lockId = cand.id; pl.lockT = 0; pl.locked = false;
    } else {
      pl.lockT = Math.max(0, pl.lockT - g.dt * 2);
      if (pl.lockT === 0) { pl.lockId = 0; pl.locked = false; }
      else if (pl.locked && !findById(g, pl.lockId)) { pl.lockId = 0; pl.lockT = 0; pl.locked = false; }
    }
  }

  /**
   * 狙う相手を選ぶ (ロックオンボタンのタップ)。照準にいちばん近い敵から順に並べ、
   * いまの相手が並びの中にいれば、その次へ切り替える。
   */
  function selectTarget(g) {
    const pl = g.player;
    const ts = targets(g).filter(function (t) { return dist(t.pos, pl.pos) <= T.focusRange * 1.6; });
    if (!ts.length) { pl.targetId = 0; return null; }
    ts.sort(function (a, b) { return angleBetween(pl.dir, sub(a.pos, pl.pos)) - angleBetween(pl.dir, sub(b.pos, pl.pos)); });
    let i = -1;
    for (let k = 0; k < ts.length; k++) if (ts[k].id === pl.targetId) i = k;
    const t = ts[(i + 1) % ts.length];
    pl.targetId = t.id;
    emit(g, 'target', { id: t.id });
    return t;
  }

  /** 狙う相手を倒したら (いなくなったら)、照準にいちばん近い次の敵へ移る。 */
  function keepTarget(g) {
    const pl = g.player;
    if (!pl.targetId || findById(g, pl.targetId)) return;
    pl.targetId = 0;
    if (targets(g).length) selectTarget(g);
  }

  function turnLimit(speed, boosting) {
    if (boosting) return T.turnBoost;
    const k = clamp((speed - T.speedMin) / (T.speedMax - T.speedMin), 0, 1);
    return lerp(T.turnSlow, T.turnFast, k);
  }

  function updatePlayer(g, input, dt) {
    const pl = g.player;
    const sx = clamp(input.stickX || 0, -1, 1);
    const sy = clamp(input.stickY || 0, -1, 1);
    const stickMag = Math.sqrt(sx * sx + sy * sy);
    // ロックオンボタンを押しっぱなし: 狙う相手 (いれば)
    const sel = input.track && pl.targetId ? findById(g, pl.targetId) : null;

    // ブースト: 押している間だけ、エネルギーがある限り
    const wantBoost = !!input.boost && pl.boost > 0;
    if (wantBoost && !pl.boosting) emit(g, 'boost');
    pl.boosting = wantBoost;
    if (pl.boosting) {
      pl.boost = Math.max(0, pl.boost - T.boostDrain * dt);
      pl.boostIdle = 0;
    } else {
      pl.boostIdle += dt;
      if (pl.boostIdle > T.boostRegenDelay) pl.boost = Math.min(100, pl.boost + T.boostRegen * dt);
    }

    // 速さ: 指定があればその速さ (テスト・自動操縦用)。無ければ自動:
    // スティックを大きく倒して急旋回すると減速して小回りが利き、まっすぐならふだんの速さに戻る
    let target;
    if (pl.boosting) {
      target = T.speedBoost;
      pl.autoSlow = 0;
    } else if (input.throttle !== undefined) {
      pl.throttle = clamp(input.throttle, 0, 1);
      target = lerp(T.speedMin, T.speedMax, pl.throttle);
      pl.autoSlow = 0;
    } else {
      let k = clamp((stickMag - T.autoSlowFrom) / (1 - T.autoSlowFrom), 0, 1);
      // 狙う相手へ大きく回り込むときも減速する
      if (sel && stickMag < 0.6) k = Math.max(k, clamp((angleBetween(pl.dir, sub(sel.pos, pl.pos)) - 40 * DEG) / (50 * DEG), 0, 1));
      pl.autoSlow = approach(pl.autoSlow || 0, k, 8, dt);
      target = lerp(T.speedNormal, T.autoSlowSpeed, pl.autoSlow);
      pl.throttle = (target - T.speedMin) / (T.speedMax - T.speedMin);   // 炎の大きさなど見た目用
    }
    const acc = pl.boosting ? T.boostAccel : T.accel;
    if (pl.speed < target) pl.speed = Math.min(target, pl.speed + acc * dt);
    else pl.speed = Math.max(target, pl.speed - acc * 1.2 * dt);

    // 旋回: 入力 → 目標の角速度 → なめらかに追従。離すと静かに止まる
    const lim = turnLimit(pl.speed, pl.boosting);
    // 入力は2乗寄りにして、小さい入力で細かく狙えるようにする
    const shape = function (v) { return Math.sign(v) * (0.35 * Math.abs(v) + 0.65 * v * v); };
    let tYaw = -shape(sx) * lim;
    let tPitch = shape(sy) * lim * 0.85;

    // 照準補助 (吸いつき): スティックが小さいときだけ、ごく弱く
    if (pl.focus && pl.focus.ang <= T.magnetCone && stickMag < 0.5) {
      const want = yawPitchOf(sub(pl.focus.lead, pl.pos));
      const k = 1 - stickMag / 0.5;
      tYaw += clamp(wrapAngle(want.yaw - pl.yaw) * 4, -T.magnetRate, T.magnetRate) * k;
      tPitch += clamp((want.pitch - pl.pitch) * 4, -T.magnetRate, T.magnetRate) * k;
    }

    // ロックオンボタンを押しっぱなし: 狙う相手へ機首を向ける。スティックを大きく倒せばそちらが勝つ
    pl.tracking = !!sel && stickMag < 0.6;
    if (pl.tracking) {
      const want = yawPitchOf(sub(sel.pos, pl.pos));
      const k = 1 - stickMag / 0.6;
      tYaw = tYaw * (1 - k) + clamp(wrapAngle(want.yaw - pl.yaw) * 3, -lim, lim) * k;
      tPitch = tPitch * (1 - k) + clamp((want.pitch - pl.pitch) * 3, -lim * 0.85, lim * 0.85) * k;
    }

    // 戦域の外: 中心へ向けて自動で戻す
    const fromC = sub(pl.pos, T.arenaCenter);
    pl.outside = len(fromC) > T.arenaRadius;
    if (len(fromC) > T.arenaRadius + 200) {
      const want = yawPitchOf(scale(fromC, -1));
      tYaw = clamp(wrapAngle(want.yaw - pl.yaw) * 2, -lim, lim);
      tPitch = clamp((want.pitch - pl.pitch) * 2, -lim, lim);
    }

    pl.yawRate = approach(pl.yawRate, tYaw, T.turnResponse, dt);
    pl.pitchRate = approach(pl.pitchRate, tPitch, T.turnResponse, dt);
    pl.yaw = wrapAngle(pl.yaw + pl.yawRate * dt);
    // 真上・真下で向きがひっくり返らないよう、ピッチは手前で止める
    pl.pitch = clamp(pl.pitch + pl.pitchRate * dt, -T.pitchLimit, T.pitchLimit);
    if (Math.abs(pl.pitch) >= T.pitchLimit - 1e-6) pl.pitchRate = 0;

    // 傾き (見た目): 曲がっている強さに比例
    const rollTarget = clamp(pl.yawRate / T.turnSlow, -1, 1) * T.rollMax;
    pl.roll = approach(pl.roll, rollTarget, 6, dt);

    pl.dir = forwardFrom(pl.yaw, pl.pitch);
    pl.vel = scale(pl.dir, pl.speed);
    pl.pos = addScaled(pl.pos, pl.vel, dt);
  }

  function fireLasers(g, input, dt) {
    const pl = g.player;
    pl.laserCd -= dt;
    if (!input.fire || pl.laserCd > 0) return;
    pl.laserCd += T.laserInterval;
    if (pl.laserCd < 0) pl.laserCd = 0;
    // 左右の翼から交互に
    const right = norm(cross(pl.dir, vec(0, 1, 0)));
    const side = pl.gun === 0 ? -1 : 1;
    pl.gun = 1 - pl.gun;
    const muzzle = add(addScaled(pl.pos, right, side * 2.2), scale(pl.dir, 4));
    const dir = pl.aimDir;
    g.shots.push({
      owner: 'player', pos: muzzle, prev: copy(muzzle),
      vel: add(scale(dir, T.laserSpeed), scale(pl.vel, 0)),
      life: T.laserLife, dmg: T.laserDamage, dead: false
    });
    g.stats.shots++;
    emit(g, 'laser', { pos: muzzle, side: side });
  }

  /**
   * マルチロック: input.missileHold (MSL を押している間) に、照準のまわり (multiCone) の敵を
   * multiLockTime ごとに 1 つずつ捕まえる。同じ的は「残り体力を落とすのに要る数」まで重ねて捕まえる
   * (敵機は 1 発、砲台は 2 発…)。捕まえられる数は残りのミサイルまで。離すと (input.missile) 一斉に撃つ
   */
  function updateMultiLock(g, input, dt) {
    const pl = g.player;
    pl.mlock = pl.mlock.filter(function (id) { const t = findById(g, id); return t && t.alive; });
    if (!input.missileHold || !pl.alive) { pl.mlockT = 0; pl.mlockCand = 0; if (!input.missile) pl.mlock.length = 0; return; }
    const cap = Math.min(pl.missiles, T.missileMax);
    if (pl.mlock.length >= cap) { pl.mlockT = 0; pl.mlockCand = 0; return; }
    const ts = targets(g);
    let cand = null, candKey = 1e9;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      const d = dist(t.pos, pl.pos);
      if (d > T.lockRange) continue;
      const ang = angleBetween(pl.dir, sub(t.pos, pl.pos));
      if (ang > T.multiCone) continue;
      const have = pl.mlock.filter(function (id) { return id === t.id; }).length;
      if (have >= Math.ceil(t.hp / T.missileDamage)) continue;
      const key = have * 10 + ang; // まだ捕まえていない的を先に、その中で照準に近い順
      if (key < candKey) { candKey = key; cand = t; }
    }
    if (!cand) { pl.mlockT = 0; pl.mlockCand = 0; return; }
    if (cand.id !== pl.mlockCand) { pl.mlockCand = cand.id; pl.mlockT = 0; }
    pl.mlockT += dt;
    if (pl.mlockT >= T.multiLockTime) {
      pl.mlock.push(cand.id);
      pl.mlockT = 0;
      emit(g, 'lock', { id: cand.id, n: pl.mlock.length, multi: true });
    }
  }

  function launchMissile(g, tgt, dir) {
    const pl = g.player;
    pl.missiles--;
    const pos = addScaled(pl.pos, vec(0, -1, 0), 1.5);
    g.missiles.push({
      id: g.nextId++, pos: pos, prev: copy(pos), dir: dir,
      speed: Math.max(T.missileSpeed0, pl.speed), target: tgt, life: T.missileLife, age: 0, dead: false
    });
    return pos;
  }

  function fireMissile(g, input, dt) {
    const pl = g.player;
    if (pl.missiles < T.missileMax) {
      pl.missileCd += dt;
      if (pl.missileCd >= T.missileReload) { pl.missileCd = 0; pl.missiles++; }
    } else {
      pl.missileCd = 0;
    }
    updateMultiLock(g, input, dt);
    if (!input.missile || pl.missiles <= 0) return;
    // マルチロックで捕まえていれば、その数だけ扇に広げて一斉に撃つ
    if (pl.mlock.length > 0) {
      const n = Math.min(pl.mlock.length, pl.missiles);
      const right = norm(cross(pl.dir, vec(0, 1, 0)));
      let pos = null;
      for (let i = 0; i < n; i++) {
        const a = (i - (n - 1) / 2) * T.multiFan;
        const dir = norm(add(scale(pl.dir, Math.cos(a)), addScaled(scale(right, Math.sin(a)), vec(0, 1, 0), 0.08)));
        pos = launchMissile(g, pl.mlock[i], dir);
      }
      emit(g, 'missile', { pos: pos, locked: true, salvo: n });
      pl.mlock.length = 0; pl.mlockT = 0; pl.mlockCand = 0;
      pl.lockT = 0; pl.locked = false; pl.lockId = 0;
      return;
    }
    const tgt = pl.locked ? pl.lockId : 0;
    const pos = launchMissile(g, tgt, copy(pl.dir));
    emit(g, 'missile', { pos: pos, locked: !!tgt, salvo: 1 });
    if (tgt) { pl.lockT = 0; pl.locked = false; pl.lockId = 0; }
  }

  function updateMissiles(g, dt) {
    for (let i = 0; i < g.missiles.length; i++) {
      const m = g.missiles[i];
      m.age += dt;
      m.life -= dt;
      if (m.life <= 0) { m.dead = true; emit(g, 'fizzle', { pos: m.pos }); continue; }
      m.speed = Math.min(T.missileSpeed1, m.speed + 300 * dt);
      const t = m.target ? findById(g, m.target) : null;
      if (t && m.age > 0.15) {
        const ic = intercept(m.pos, t.pos, t.vel, m.speed);
        const aim = ic ? ic.point : t.pos;
        m.dir = rotateToward(m.dir, sub(aim, m.pos), T.missileTurn * dt);
      }
      m.prev = copy(m.pos);
      m.pos = addScaled(m.pos, m.dir, m.speed * dt);
      const hit = sweep(g, m.prev, m.pos, true, 3);
      if (hit) {
        m.dead = true;
        if (hit.target) damage(g, hit.target, T.missileDamage, hit.point, 'missile');
        emit(g, 'explode', { pos: hit.point, size: 0.8 });
      }
    }
    g.missiles = g.missiles.filter(function (m) { return !m.dead; });
  }

  /**
   * 線分に最初に当たる物。的 (戦闘機・部位) か、戦艦の船体。
   * 戦艦の部位は active でなくても弾を止める (装甲で弾かれる)。
   */
  function sweep(g, p0, p1, isPlayer, extra) {
    let bestT = 2, best = null;
    if (isPlayer) {
      for (let i = 0; i < g.fighters.length; i++) {
        const f = g.fighters[i];
        if (!f.alive) continue;
        const t = segmentSphere(p0, p1, f.pos, f.radius + (extra || 0));
        if (t >= 0 && t < bestT) { bestT = t; best = { target: f }; }
      }
    }
    if (g.boss && g.boss.phase !== 'arrive' && g.boss.phase !== 'dead') {
      if (isPlayer) {
        for (let i = 0; i < g.boss.parts.length; i++) {
          const p = g.boss.parts[i];
          if (!p.alive) continue;
          const t = segmentSphere(p0, p1, p.pos, p.radius + (extra || 0));
          if (t >= 0 && t < bestT) { bestT = t; best = { target: p.active ? p : null, part: p }; }
        }
      }
      const solids = bossSolids(g.boss);
      for (let i = 0; i < solids.length; i++) {
        const t = segmentSolid(p0, p1, solids[i].planes);
        if (t >= 0 && t < bestT) { bestT = t; best = { target: null, hull: solids[i].name }; }
      }
    }
    if (!best) return null;
    best.point = add(p0, scale(sub(p1, p0), bestT));
    return best;
  }

  function addScore(g, base, pos) {
    const s = g.stats;
    s.combo = s.comboT > 0 ? s.combo + 1 : 1;
    s.comboT = 3.5;
    const mult = Math.min(3, 1 + 0.25 * (s.combo - 1));
    const pts = Math.round(base * mult);
    s.score += pts;
    emit(g, 'score', { pts: pts, combo: s.combo, pos: pos });
  }

  function damage(g, t, amount, point, by) {
    if (!t.alive) return;
    t.hp -= amount;
    t.flash = 1;
    emit(g, 'hit', { pos: point, id: t.id, kind: t.kind, by: by, hp: t.hp, maxHp: t.maxHp });
    g.lastHitT = g.t;
    if (t.hp > 0) return;
    t.hp = 0;
    t.alive = false;
    if (t.kind === 'fighter') {
      g.stats.kills++;
      emit(g, 'explode', { pos: t.pos, size: 1.4, vel: t.vel, kind: 'fighter' });
      addScore(g, 100, t.pos);
    } else {
      emit(g, 'explode', { pos: t.pos, size: t.kind === 'core' ? 4 : 2.6, kind: t.kind });
      addScore(g, t.kind === 'turret' ? 300 : t.kind === 'engine' ? 600 : 3000, t.pos);
    }
  }

  function hurtPlayer(g, amount, from) {
    const pl = g.player;
    if (g.state !== 'play' || !pl.alive) return;
    g.stats.damage += amount;
    pl.sinceHit = 0;
    const s = Math.min(pl.shield, amount);
    pl.shield -= s;
    pl.hull -= amount - s;
    emit(g, 'playerHit', { amount: amount, shieldOnly: amount - s === 0, from: from });
    if (pl.hull <= 0) {
      pl.hull = 0;
      pl.alive = false;
      g.state = 'over';
      g.endT = 0;
      emit(g, 'explode', { pos: pl.pos, size: 2, kind: 'player' });
      emit(g, 'gameOver');
    }
  }

  function enemyShot(g, from, dir, dmg, speed) {
    g.shots.push({
      owner: 'enemy', pos: copy(from), prev: copy(from), vel: scale(norm(dir), speed),
      life: T.enemyShotLife * (speed < 250 ? 1.9 : 1), dmg: dmg, dead: false
    });
  }

  /** 狙いを少しだけ散らす (必ず当たる敵は理不尽)。 */
  function scatter(g, dir, err) {
    const d = norm(dir);
    const a = norm(cross(d, Math.abs(d.y) < 0.9 ? vec(0, 1, 0) : vec(1, 0, 0)));
    const b = cross(d, a);
    const r = err * Math.sqrt(g.rng());
    const th = g.rng() * Math.PI * 2;
    return norm(add(d, add(scale(a, Math.cos(th) * Math.tan(r)), scale(b, Math.sin(th) * Math.tan(r)))));
  }

  function updateFighters(g, dt) {
    const pl = g.player;
    let bursting = 0;
    for (let i = 0; i < g.fighters.length; i++) if (g.fighters[i].alive && g.fighters[i].burst > 0) bursting++;

    for (let i = 0; i < g.fighters.length; i++) {
      const f = g.fighters[i];
      if (!f.alive) continue;
      f.flash = Math.max(0, f.flash - dt * 5);
      if (f.drone) {
        // まっすぐ横切るだけ。撃たない。時間が来たら (撃墜にはならずに) 飛び去る
        f.life -= dt;
        if (f.life <= 0) { f.alive = false; f.escaped = true; continue; }
        f.pos = addScaled(f.pos, f.vel, dt);
        f.bank = Math.sin(f.life * 3) * 0.3;
        continue;
      }
      const toP = sub(pl.pos, f.pos);
      const d = len(toP);
      const ic = intercept(f.pos, pl.pos, pl.vel, T.enemyShotSpeed);
      const lead = ic ? ic.point : pl.pos;
      let desired;
      let speed = T.fighterSpeed * f.skill;

      f.modeT -= dt;
      if (f.mode === 'attack') {
        desired = sub(lead, f.pos);
        // 近づきすぎる前に離脱する。正面から来るときは近づく速さが大きいので早めに
        const closing = Math.max(0, -dot(sub(pl.vel, f.vel), norm(toP)));
        if (d < Math.max(110, closing * 1.5) || !pl.alive) {
          f.mode = 'break';
          f.modeT = rand(g, 1.8, 2.8);
          // 相手を結ぶ線から横へそれる (ぶつかってこない)
          const los = norm(toP);
          const side = norm(cross(los, vec(rand(g, -1, 1), rand(g, -1, 1), rand(g, -1, 1))));
          f.breakDir = norm(add(scale(side, 1.2), scale(los, -0.2)));
        }
      } else if (f.mode === 'break') {
        desired = f.breakDir;
        speed *= 1.25;
        if (f.modeT <= 0) { f.mode = d < 260 ? 'extend' : 'attack'; f.modeT = 2.5; }
      } else {
        // extend: 距離をとってから向き直る (背後を取りにいく動き)
        desired = add(scale(norm(toP), -1), scale(pl.dir, 0.6));
        speed *= 1.15;
        if (d > 340 || f.modeT <= 0) f.mode = 'attack';
      }

      // 戦艦の船体はよける
      if (g.boss && g.boss.phase !== 'dead') {
        const solids = bossSolids(g.boss);
        for (let k = 0; k < solids.length; k++) {
          const ahead = addScaled(f.pos, f.dir, 60);
          const pad = 30;
          const b = solids[k];
          if (ahead.x > b.min.x - pad && ahead.x < b.max.x + pad && ahead.y > b.min.y - pad &&
              ahead.y < b.max.y + pad && ahead.z > b.min.z - pad && ahead.z < b.max.z + pad) {
            const c = scale(add(b.min, b.max), 0.5);
            desired = add(norm(sub(f.pos, c)), vec(0, 0.8, 0));
          }
          const push = sphereSolidPush(f.pos, f.radius, b.planes);
          if (push) f.pos = addScaled(f.pos, push.normal, push.depth);
        }
      }

      const before = f.dir;
      f.dir = rotateToward(f.dir, desired, T.fighterTurn * f.skill * dt);
      f.speed = approach(f.speed, speed, 2, dt);
      f.vel = scale(f.dir, f.speed);
      f.pos = addScaled(f.pos, f.vel, dt);
      // 動いたあとにも船体から押し出す (動く前だけだと、そのコマで進んだぶんめり込む)
      if (g.boss && g.boss.phase !== 'dead') {
        const solids = bossSolids(g.boss);
        for (let k = 0; k < solids.length; k++) {
          const push = sphereSolidPush(f.pos, f.radius, solids[k].planes);
          if (push) f.pos = addScaled(f.pos, push.normal, push.depth);
        }
      }
      // 曲がる向きに機体を傾ける (見た目)
      const turn = cross(before, f.dir);
      const bankT = clamp(-dot(turn, vec(0, 1, 0)) / Math.max(dt, 1e-4) / T.fighterTurn, -1, 1) * 1.0;
      f.bank = approach(f.bank, bankT, 4, dt);

      // 射撃: 正面に捉えたら3連射。同時に撃つのは2機まで
      f.fireCd -= dt;
      if (f.burst > 0) {
        f.burstCd -= dt;
        if (f.burstCd <= 0) {
          f.burst--; f.burstCd = 0.13;
          const muzzle = addScaled(f.pos, f.dir, 7);
          enemyShot(g, muzzle, scatter(g, sub(lead, muzzle), T.fighterAimError), T.fighterShotDamage, T.enemyShotSpeed);
          emit(g, 'enemyLaser', { pos: muzzle });
        }
      } else if (f.mode === 'attack' && f.fireCd <= 0 && pl.alive && g.state === 'play' &&
                 d < T.fighterFireRange && angleBetween(f.dir, sub(lead, f.pos)) < T.fighterFireCone &&
                 bursting < T.maxBursting) {
        f.burst = 3; f.burstCd = 0; bursting++;
        f.fireCd = rand(g, 1.6, 2.6);
      }
    }
    g.fighters = g.fighters.filter(function (f) { return f.alive; });
  }

  function aliveParts(boss, kind) {
    let n = 0;
    for (let i = 0; i < boss.parts.length; i++) if (boss.parts[i].kind === kind && boss.parts[i].alive) n++;
    return n;
  }

  /**
   * ドローン: 自機の前 (水平の向き) を横切る、撃ち返さない小さな的。1 発で落ち、droneLife 秒で飛び去る
   */
  function launchDrones(g) {
    const pl = g.player;
    let f = vec(pl.dir.x, 0, pl.dir.z); f = len(f) > 1e-3 ? norm(f) : vec(0, 0, -1);
    const side = vec(-f.z, 0, f.x);
    const s0 = g.rng() < 0.5 ? -1 : 1;
    for (let i = 0; i < T.droneCount; i++) {
      let start, v;
      if (T.droneMode === 'cross') {
        // 前を横切る
        const base = add(addScaled(pl.pos, f, T.droneAhead), vec(0, rand(g, -30, 40), 0));
        start = addScaled(addScaled(base, side, -s0 * (T.droneSpan + i * 28)), f, i * 12);
        v = scale(side, s0 * T.droneSpeed);
      } else {
        // 正面の少し先から、少しずつ横へずれながらこちらへ来る (照準の前を長く通る)
        start = add(addScaled(addScaled(pl.pos, f, T.droneAhead + i * 40), side, s0 * (25 + i * 18)), vec(0, rand(g, -12, 18), 0));
        v = add(scale(f, -T.droneSpeed), scale(side, -s0 * 14));
      }
      const d = makeFighter(g, start, v);
      d.drone = true; d.life = T.droneLife;
      d.hp = d.maxHp = T.droneHp; d.radius = 6;
      d.speed = len(v); d.vel = v;
      g.fighters.push(d);
    }
    emit(g, 'drones', { n: T.droneCount });
  }

  function launchEscorts(g, n) {
    const b = g.boss;
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      // 船体の下 (竜骨の横) から出す。三角の船体の中に出ないように
      const pos = add(b.pos, vec(250 - i * 30, -48, side * 60));
      const dir = vec(-0.4, 0.2, side);
      g.fighters.push(makeFighter(g, pos, dir));
    }
    emit(g, 'escorts', { n: n });
  }

  function updateBoss(g, dt) {
    const b = g.boss;
    const pl = g.player;
    if (!b) return;

    if (b.phase === 'arrive') {
      b.arriveT += dt;
      const k = clamp(b.arriveT / BOSS_ARRIVE, 0, 1);
      // 光の中から出てくる: はじめ速く、だんだんゆっくりになって止まる
      const w = clamp((b.arriveT - BOSS_WARP_DELAY) / BOSS_EMERGE, 0, 1);
      const e = 1 - Math.pow(1 - w, 2);
      if (!b.shown && b.arriveT >= BOSS_WARP_DELAY) { b.shown = true; emit(g, 'bossWarp', { pos: copy(b.portal) }); }
      if (w >= 1 && !b.landed) { b.landed = true; emit(g, 'bossLand', { pos: copy(b.at) }); }
      const prev = b.pos;
      b.pos = vec(lerp(b.from.x, b.at.x, e), b.at.y, b.at.z);
      b.vel = dt > 0 && b.shown ? scale(sub(b.pos, prev), 1 / dt) : vec();
      b.emerge = w;
      if (k >= 1) {
        b.phase = 'battle';
        b.battleT = g.t;
        b.vel = vec();
        emit(g, 'bossPhase', { phase: 'battle', text: '砲台を破壊せよ' });
        launchEscorts(g, 3);
      }
    }

    for (let i = 0; i < b.parts.length; i++) {
      const p = b.parts[i];
      p.pos = add(b.pos, p.local);
      p.vel = b.vel;
      p.flash = Math.max(0, p.flash - dt * 5);
    }

    if (b.phase === 'dying') {
      b.dyingT += dt;
      if (Math.floor((b.dyingT - dt) * 5) !== Math.floor(b.dyingT * 5)) {
        const sd = bossSolids(b)[Math.floor(g.rng() * 6)];
        const p = vec(rand(g, sd.min.x, sd.max.x), rand(g, sd.min.y, sd.max.y), rand(g, sd.min.z, sd.max.z) * 0.5 + (sd.min.z + sd.max.z) * 0.25);
        emit(g, 'explode', { pos: p, size: rand(g, 2, 4), kind: 'chain' });
      }
      if (b.dyingT > 4.2) {
        b.phase = 'dead';
        emit(g, 'explode', { pos: add(b.pos, vec(0, 20, 0)), size: 14, kind: 'boss' });
        emit(g, 'bossDead');
      }
      return;
    }
    if (b.phase === 'arrive' || b.phase === 'dead') return;
    // 何も当たらない時間を埋める: 戦闘中にしばらく当てていなくて、敵機も場にいなければ、ドローンを横切らせる
    if (b.phase !== 'dying') {
      b.droneCd = Math.max(0, (b.droneCd || 0) - dt);
      const since = g.t - Math.max(g.lastHitT || 0, b.battleT || 0);
      if (b.droneCd === 0 && g.fighters.length === 0 && since > T.droneLull) {
        launchDrones(g);
        b.droneCd = T.droneGap;
      }
    }

    // 段階を進める
    const turrets = aliveParts(b, 'turret');
    if (b.phase === 'battle' && turrets <= 3) {
      b.phase = 'cannon';
      b.cannon.next = 2;
      emit(g, 'bossPhase', { phase: 'cannon', text: '主砲チャージ  射線から外れろ' });
    }
    if ((b.phase === 'battle' || b.phase === 'cannon') && turrets === 0) {
      b.phase = 'weak';
      for (let i = 0; i < b.parts.length; i++) if (b.parts[i].kind === 'engine') b.parts[i].active = true;
      emit(g, 'bossPhase', { phase: 'weak', text: '艦尾のエンジンが露出  弱点を撃て' });
    }
    if (b.phase === 'weak' && aliveParts(b, 'engine') === 0) {
      b.phase = 'core';
      b.armor = false;
      for (let i = 0; i < b.parts.length; i++) if (b.parts[i].kind === 'core') b.parts[i].active = true;
      const armorAt = BOSS_PARTS[BOSS_PARTS.length - 1].at;
      emit(g, 'explode', { pos: add(b.pos, vec(armorAt.x, armorAt.y + 6, armorAt.z)), size: 3, kind: 'armor' });
      emit(g, 'bossPhase', { phase: 'core', text: '装甲が吹き飛んだ  コアを撃ち抜け' });
      launchEscorts(g, 3);
    }
    if (b.phase === 'core' && aliveParts(b, 'core') === 0) {
      b.phase = 'dying';
      b.dyingT = 0;
      b.cannon.state = 'idle';
      g.state = 'ending';
      g.endT = 0;
      for (let i = 0; i < g.fighters.length; i++) {
        const f = g.fighters[i];
        if (f.alive) { f.alive = false; emit(g, 'explode', { pos: f.pos, size: 1.4, kind: 'fighter' }); }
      }
      g.shots = g.shots.filter(function (s) { return s.owner === 'player'; });
      emit(g, 'bossPhase', { phase: 'dying', text: '撃沈' });
      return;
    }

    // 砲台: 自分の面の側にいるときだけ撃つ
    const spread = b.phase !== 'battle';
    for (let i = 0; i < b.parts.length; i++) {
      const p = b.parts[i];
      if (p.kind !== 'turret' || !p.alive) continue;
      const to = sub(pl.pos, p.pos);
      const d = len(to);
      p.aim = norm(to);
      p.fireCd -= dt;
      if (p.fireCd > 0 || !pl.alive || g.state !== 'play') continue;
      if (d > T.turretRange || dot(to, p.face) < d * 0.1) { p.fireCd = 0.5; continue; }
      p.fireCd = rand(g, 2.2, 3.4);
      const ic = intercept(p.pos, pl.pos, pl.vel, T.turretShotSpeed);
      const aim = sub(ic ? ic.point : pl.pos, p.pos);
      const from = addScaled(p.pos, norm(aim), p.radius + 2);
      const n = spread ? 3 : 1;
      for (let k = 0; k < n; k++) {
        const dir = n === 1 ? aim : rotateToward(aim, cross(norm(aim), p.face), (k - 1) * 5 * DEG);
        enemyShot(g, from, scatter(g, dir, 2.2 * DEG), T.turretShotDamage, T.turretShotSpeed);
      }
      emit(g, 'turretFire', { pos: from });
    }

    // 主砲: チャージ → 狙いを固定 → 発射。固定のあとは動けばよけられる
    if (b.phase === 'cannon' || b.phase === 'weak' || b.phase === 'core') {
      const c = b.cannon;
      c.from = add(b.pos, BOSS_CANNON);
      if (c.state === 'idle') {
        c.next -= dt;
        if (c.next <= 0 && pl.alive && g.state === 'play') {
          c.state = 'charge'; c.t = 0; c.hitDone = false;
          emit(g, 'cannonCharge', { pos: c.from });
        }
      } else if (c.state === 'charge') {
        c.t += dt;
        if (c.t < T.cannonCharge - T.cannonLockBefore) c.dir = norm(sub(pl.pos, c.from));
        else if (!c.lockedEmit) { c.lockedEmit = true; emit(g, 'cannonLock'); }
        if (c.t >= T.cannonCharge) { c.state = 'fire'; c.t = 0; c.lockedEmit = false; emit(g, 'cannonFire', { pos: c.from }); }
      } else if (c.state === 'fire') {
        c.t += dt;
        if (!c.hitDone && beamHits(c.from, c.dir, pl.pos, T.cannonRadius + T.playerRadius)) {
          c.hitDone = true;
          hurtPlayer(g, T.cannonDamage, c.from);
        }
        if (c.t >= T.cannonFire) {
          c.state = 'idle';
          c.next = b.phase === 'core' ? 6.5 : 9;
          if (!c.hitDone) emit(g, 'cannonDodged');
        }
      }
    }
  }

  /** 光線 (from から dir へ cannonLength) の太さ r の中に点があるか。 */
  function beamHits(from, dir, p, r) {
    const rel = sub(p, from);
    const t = dot(rel, dir);
    if (t < 0 || t > T.cannonLength) return false;
    return len(sub(rel, scale(dir, t))) <= r;
  }

  function updateShots(g, dt) {
    const pl = g.player;
    for (let i = 0; i < g.shots.length; i++) {
      const s = g.shots[i];
      s.life -= dt;
      if (s.life <= 0) { s.dead = true; continue; }
      s.prev = copy(s.pos);
      s.pos = addScaled(s.pos, s.vel, dt);
      if (s.owner === 'player') {
        const hit = sweep(g, s.prev, s.pos, true, 0);
        if (hit) {
          s.dead = true;
          if (hit.target) {
            g.stats.hits++;
            damage(g, hit.target, s.dmg, hit.point, 'laser');
          } else {
            emit(g, 'spark', { pos: hit.point, armored: !!hit.part });
          }
        }
      } else {
        if (pl.alive && segmentSphere(s.prev, s.pos, pl.pos, T.playerRadius) >= 0) {
          s.dead = true;
          hurtPlayer(g, s.dmg, s.prev);
          continue;
        }
        const hit = g.boss && g.boss.phase !== 'dead' && s.life < 2.0 ? sweepHull(g, s.prev, s.pos) : false;
        if (hit) s.dead = true;
      }
    }
    g.shots = g.shots.filter(function (s) { return !s.dead; });
  }

  function sweepHull(g, p0, p1) {
    const solids = bossSolids(g.boss);
    for (let i = 0; i < solids.length; i++) if (segmentSolid(p0, p1, solids[i].planes) >= 0) return true;
    return false;
  }

  function collidePlayer(g, dt) {
    const pl = g.player;
    pl.scrapeCd = Math.max(0, pl.scrapeCd - dt);
    if (!g.boss || g.boss.phase === 'dead' || !pl.alive) return;
    const solids = bossSolids(g.boss);
    for (let i = 0; i < solids.length; i++) {
      const push = sphereSolidPush(pl.pos, T.playerRadius, solids[i].planes);
      if (!push) continue;
      pl.pos = addScaled(pl.pos, push.normal, push.depth + 0.01);
      // 壁へ向かっていたら、跳ね返る向きへ機首をそらす。押し出すだけだと
      // 機首が壁を向いたままで、壁沿いをこすり続けて落とされる
      const into = dot(pl.dir, push.normal);
      if (into < 0) {
        const out = norm(addScaled(pl.dir, push.normal, -into * 1.6));
        const yp = yawPitchOf(out);
        pl.yaw = yp.yaw;
        pl.pitch = clamp(yp.pitch, -T.pitchLimit, T.pitchLimit);
        pl.yawRate = 0; pl.pitchRate = 0;
        pl.dir = forwardFrom(pl.yaw, pl.pitch);
        pl.vel = scale(pl.dir, pl.speed);
      }
      if (pl.scrapeCd <= 0) {
        pl.scrapeCd = 0.6;
        emit(g, 'scrape', { pos: pl.pos });
        hurtPlayer(g, T.hullDamage, addScaled(pl.pos, push.normal, -5));
      }
    }
  }

  function updateStage(g, dt) {
    g.stageTimer += dt;
    if (g.stage === 'wave1' && g.fighters.length === 0) { g.stage = 'gap1'; g.stageTimer = 0; emit(g, 'waveClear'); }
    else if (g.stage === 'gap1' && g.stageTimer > 2.5) { g.stage = 'wave2'; g.stageTimer = 0; spawnWave(g, 2); }
    else if (g.stage === 'wave2' && g.fighters.length === 0) { g.stage = 'gap2'; g.stageTimer = 0; emit(g, 'waveClear'); }
    else if ((g.stage === 'gap2' && g.stageTimer > 3) || (g.stage === 'bossIn' && !g.boss)) {
      g.stage = 'boss'; g.stageTimer = 0;
      g.boss = makeBoss(g);
      emit(g, 'bossWarning', { text: '警告  巨大戦艦 接近' });
    }
  }

  /**
   * 1ステップ進める。input = { stickX, stickY, throttle, fire, boost, missile, missileHold, select, track }
   * missile (MSL を離した瞬間) と select (ロックオンボタンのタップ) は、その瞬間だけ true にする。
   * missileHold は MSL を押している間 true (マルチロック)。
   * track はロックオンボタンを押している間 true (狙う相手へ機首を向ける)。
   */
  function step(g, input, dt) {
    input = input || {};
    dt = clamp(dt || 0, 0, 0.05);
    // 細かく刻む: 速い物のふるまいがフレームの長さで変わらないように
    const n = Math.max(1, Math.ceil(dt / (1 / 60) - 1e-9));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      stepOnce(g, i === 0 ? input : withoutEdge(input), h);
    }
    return g;
  }
  function withoutEdge(input) {
    return { stickX: input.stickX, stickY: input.stickY, throttle: input.throttle, fire: input.fire, boost: input.boost, missile: false, missileHold: input.missileHold, track: input.track, select: false };
  }

  function stepOnce(g, input, dt) {
    g.dt = dt;
    if (dt <= 0) return;
    g.t += dt;
    const pl = g.player;
    if (g.state === 'play') g.stats.time += dt;
    const s = g.stats;
    s.comboT = Math.max(0, s.comboT - dt);
    if (s.comboT === 0) s.combo = 0;

    if (pl.alive) {
      updatePlayer(g, g.state === 'over' ? {} : input, dt);
      pl.sinceHit += dt;
      if (pl.sinceHit > T.shieldRegenDelay) pl.shield = Math.min(T.shieldMax, pl.shield + T.shieldRegen * dt);
      keepTarget(g);
      updateAim(g);
      if (g.state === 'play') {
        fireLasers(g, input, dt);
        fireMissile(g, input, dt);
        if (input.select) selectTarget(g);
      }
    }
    updateMissiles(g, dt);
    updateFighters(g, dt);
    updateBoss(g, dt);
    updateShots(g, dt);
    collidePlayer(g, dt);
    if (g.state === 'play') updateStage(g, dt);
    if (g.state === 'ending') {
      g.endT += dt;
      if (g.boss && g.boss.phase === 'dead' && g.endT > 7) {
        g.state = 'clear';
        emit(g, 'clear');
      }
    } else if (g.state === 'over') {
      g.endT += dt;
    }
  }

  /** 終わったときの成績。 */
  function result(g) {
    const s = g.stats;
    const acc = s.shots ? s.hits / s.shots : 0;
    const cleared = g.state === 'clear' || (g.boss && g.boss.phase === 'dead');
    let bonus = 0;
    if (cleared) {
      bonus += Math.max(0, Math.round((420 - s.time) * 20));
      bonus += Math.round(acc * 3000);
      bonus += Math.round((g.player.hull / T.hullMax) * 2000);
    }
    const total = s.score + bonus;
    let rank = 'C';
    if (cleared) rank = total >= 16000 ? 'S' : total >= 12000 ? 'A' : total >= 8000 ? 'B' : 'C';
    return {
      cleared: !!cleared, time: s.time, kills: s.kills, accuracy: acc,
      damage: s.damage, score: s.score, bonus: bonus, total: total, rank: rank
    };
  }

  /**
   * 自動操縦。テストで「最後まで遊べるか」を確かめるのに使う。
   * 下手な打ち方 (skill 低) と上手な打ち方 (skill 高) を出し分けられる。
   */
  function autopilot(g, skill) {
    skill = skill === undefined ? 1 : skill;
    const pl = g.player;
    // 速さは人と同じく自動 (throttle を渡さない)
    const input = { stickX: 0, stickY: 0, fire: false, boost: false, missile: false };
    if (!pl.alive || g.state !== 'play') return input;
    // 狙う相手: いちばん近い的 (戦艦の部位を含む)
    const ts = targets(g);
    let tgt = null, best = 1e9;
    for (let i = 0; i < ts.length; i++) {
      // ドローン (横切る的) は狙いに行かない。照準の前に来たときだけ撃つ (人と同じく、ボスへの攻めを続ける)
      if (ts[i].drone) continue;
      const d = dist(ts[i].pos, pl.pos) * (ts[i].kind === 'fighter' ? 0.7 : 1);
      if (d < best) { best = d; tgt = ts[i]; }
    }
    let aim = tgt ? (intercept(pl.pos, tgt.pos, tgt.vel, T.laserSpeed) || { point: tgt.pos }).point
      : (g.boss ? add(g.boss.pos, vec(0, 200, 400)) : add(pl.pos, scale(pl.dir, 100)));
    // 戦艦の部位は「離れて構える → 突っ込みながら撃つ → 抜ける」をくり返す
    const bot = g.bot || (g.bot = { mode: 'setup', id: 0 });
    if (tgt && tgt.face) {
      if (bot.id !== tgt.id) { bot.id = tgt.id; bot.mode = 'setup'; }
      const setup = add(addScaled(tgt.pos, tgt.face, 380), vec(0, 60, 0));
      const d = dist(tgt.pos, pl.pos);
      if (bot.mode === 'setup') {
        aim = setup;
        if (dist(setup, pl.pos) < 90) bot.mode = 'run';
      } else if (d < 120) {
        bot.mode = 'setup';
      }
    } else if (tgt && dist(tgt.pos, pl.pos) < 60) {
      aim = add(pl.pos, add(scale(pl.dir, 100), vec(0, 120, 0)));
    }
    // 船体に近づいたら上へ逃げる
    if (g.boss && g.boss.phase !== 'dead') {
      const solids = bossSolids(g.boss);
      const ahead = addScaled(pl.pos, pl.dir, 70);
      for (let i = 0; i < solids.length; i++) {
        const push = sphereSolidPush(ahead, 25, solids[i].planes);
        if (push) aim = add(pl.pos, add(scale(push.normal, 100), scale(pl.dir, 30)));
      }
    }
    const want = yawPitchOf(sub(aim, pl.pos));
    const k = 2.2 * skill;
    input.stickX = clamp(-wrapAngle(want.yaw - pl.yaw) * k, -1, 1);
    input.stickY = clamp((want.pitch - pl.pitch) * k, -1, 1);
    if (pl.focus && tgt && pl.focus.target === tgt && pl.focus.ang < (3 + (1 - skill) * 4) * DEG) input.fire = true;
    if (pl.focus && pl.focus.ang < 5 * DEG) input.fire = true;
    if (pl.locked && pl.missiles > 0 && g.rng() < 0.05) input.missile = true;
    // 主砲: 固定されたら射線から横へ逃げる
    const c = g.boss && g.boss.cannon;
    if (c && c.state !== 'idle' && skill > 0.5) {
      const rel = sub(pl.pos, c.from);
      const along = dot(rel, c.dir);
      const off = sub(rel, scale(c.dir, along));
      if (len(off) < 60 && (c.state === 'fire' || c.t > T.cannonCharge - T.cannonLockBefore - 0.2)) {
        const away = len(off) > 1 ? norm(off) : norm(cross(c.dir, vec(0, 1, 0)));
        const w = yawPitchOf(add(away, scale(pl.dir, 0.3)));
        input.stickX = clamp(-wrapAngle(w.yaw - pl.yaw) * 3, -1, 1);
        input.stickY = clamp((w.pitch - pl.pitch) * 3, -1, 1);
        input.boost = true;
        input.fire = false;
      }
    }
    return input;
  }

  return {
    DEG: DEG,
    TUNING: T,
    BOSS_SOLIDS: BOSS_SOLIDS,
    BOSS_PARTS: BOSS_PARTS,
    BOSS_CANNON: BOSS_CANNON,
    mulberry32: mulberry32,
    vec: vec, add: add, sub: sub, scale: scale, dot: dot, cross: cross, len: len, dist: dist, norm: norm,
    clamp: clamp, lerp: lerp, approach: approach, angleBetween: angleBetween, rotateToward: rotateToward,
    forwardFrom: forwardFrom, yawPitchOf: yawPitchOf, wrapAngle: wrapAngle,
    intercept: intercept, segmentSphere: segmentSphere, segmentBox: segmentBox, sphereBoxPush: sphereBoxPush,
    solidPlanes: solidPlanes, solidRange: solidRange, segmentSolid: segmentSolid, sphereSolidPush: sphereSolidPush, pointInSolid: pointInSolid,
    frameDt: frameDt, turnLimit: turnLimit, beamHits: beamHits,
    createGame: createGame, step: step, targets: targets, bossSolids: bossSolids, result: result,
    autopilot: autopilot, selectTarget: selectTarget, BOSS_TIMING: { delay: BOSS_WARP_DELAY, emerge: BOSS_EMERGE, arrive: BOSS_ARRIVE, ahead: BOSS_AHEAD, drop: BOSS_DROP, bow: BOSS_BOW, stern: BOSS_STERN }, makeFighter: makeFighter, makeBoss: makeBoss
  };
});
