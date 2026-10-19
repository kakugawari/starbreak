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
    assistCone: 5 * DEG,        // この角度の中にいる敵だけ補助する
    assistBend: 2.2 * DEG,      // 弾を曲げるのは最大これだけ
    magnetCone: 4 * DEG, magnetRate: 7 * DEG,
    // ミサイル
    lockCone: 12 * DEG, lockRange: 950, lockTime: 0.6,
    missileMax: 4, missileReload: 4, missileDamage: 8,
    missileSpeed0: 110, missileSpeed1: 330, missileTurn: 210 * DEG, missileLife: 6,
    // 敵戦闘機
    fighterHp: 5, fighterRadius: 7, fighterSpeed: 68, fighterTurn: 72 * DEG,
    enemyShotSpeed: 270, enemyShotLife: 2.2, fighterShotDamage: 5,
    fighterFireRange: 520, fighterFireCone: 9 * DEG, fighterAimError: 1.6 * DEG,
    maxBursting: 2,
    // 巨大戦艦
    turretHp: 14, engineHp: 30, coreHp: 50,
    turretShotDamage: 6, turretRange: 1150, turretShotSpeed: 240,
    cannonCharge: 2.8, cannonLockBefore: 1.0, cannonFire: 1.0,
    cannonRadius: 12, cannonDamage: 45, cannonLength: 3200,
    hullDamage: 12,
    // 戦域
    arenaCenter: vec(0, 0, -600), arenaRadius: 2600
  };

  // ------------------------------------------------------------ 巨大戦艦の形
  //
  // 当たり判定と見た目を同じ箱の表から作る。見た目と判定が食い違いようがない。
  // 戦艦は回さない (向きは常に艦首が -X)。だから箱は座標軸にそろったまま。

  const BOSS_BOXES = [
    { name: 'hull',   c: vec(0, 0, 0),     s: vec(640, 60, 140) },
    { name: 'keel',   c: vec(-20, -42, 0), s: vec(520, 24, 90) },
    { name: 'deck',   c: vec(40, 45, 0),   s: vec(420, 30, 90) },
    { name: 'bridge', c: vec(180, 95, 0),  s: vec(60, 70, 40) },
    { name: 'mast',   c: vec(190, 145, 0), s: vec(14, 30, 14) },
    { name: 'prow',   c: vec(-360, 0, 0),  s: vec(80, 40, 90) },
    { name: 'stern',  c: vec(335, 0, 0),   s: vec(30, 70, 160) },
    { name: 'armor',  c: vec(40, 73, 0),   s: vec(70, 26, 60), armor: true }
  ];

  const BOSS_PARTS = [
    { kind: 'turret', at: vec(100, 66, -28),  face: vec(0, 1, 0) },
    { kind: 'turret', at: vec(100, 66, 28),   face: vec(0, 1, 0) },
    { kind: 'turret', at: vec(-100, 66, -28), face: vec(0, 1, 0) },
    { kind: 'turret', at: vec(-100, 66, 28),  face: vec(0, 1, 0) },
    { kind: 'turret', at: vec(-230, 12, -76), face: vec(0, 0, -1) },
    { kind: 'turret', at: vec(-230, 12, 76),  face: vec(0, 0, 1) },
    { kind: 'engine', at: vec(354, 0, -45),   face: vec(1, 0, 0) },
    { kind: 'engine', at: vec(354, 0, 45),    face: vec(1, 0, 0) },
    { kind: 'core',   at: vec(40, 70, 0),     face: vec(0, 1, 0) }
  ];

  const BOSS_CANNON = vec(-406, 0, 0);
  const BOSS_FROM = vec(2300, -60, -1150);
  const BOSS_AT = vec(0, -60, -1150);
  const BOSS_ARRIVE = 13;

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
      bank: 0, flash: 0, skill: rand(g, 0.85, 1.15)
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

  function makeBoss(g) {
    const parts = BOSS_PARTS.map(function (d) {
      const hp = d.kind === 'turret' ? T.turretHp : d.kind === 'engine' ? T.engineHp : T.coreHp;
      return {
        id: g.nextId++, kind: d.kind, local: copy(d.at), face: copy(d.face),
        pos: add(BOSS_FROM, d.at), vel: vec(),
        radius: d.kind === 'turret' ? 12 : d.kind === 'engine' ? 17 : 15,
        hp: hp, maxHp: hp, alive: true,
        active: d.kind === 'turret',
        fireCd: rand(g, 1.5, 3.5), flash: 0, aim: vec(0, 1, 0)
      };
    });
    return {
      pos: copy(BOSS_FROM), vel: vec(), arriveT: 0,
      phase: 'arrive',        // arrive / battle / cannon / weak / core / dying / dead
      parts: parts,
      armor: true,
      cannon: { state: 'idle', t: 0, next: 4, dir: vec(1, 0, 0), from: copy(BOSS_CANNON), hitDone: false },
      dyingT: 0,
      boxes: BOSS_BOXES
    };
  }

  /** いま当たり判定に使う戦艦の箱 (世界座標)。装甲は外れたら消える。 */
  function bossBoxes(boss) {
    const out = [];
    for (let i = 0; i < BOSS_BOXES.length; i++) {
      const b = BOSS_BOXES[i];
      if (b.armor && !boss.armor) continue;
      const c = add(boss.pos, b.c);
      out.push({
        name: b.name,
        min: vec(c.x - b.s.x / 2, c.y - b.s.y / 2, c.z - b.s.z / 2),
        max: vec(c.x + b.s.x / 2, c.y + b.s.y / 2, c.z + b.s.z / 2)
      });
    }
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

  function turnLimit(speed, boosting) {
    if (boosting) return T.turnBoost;
    const k = clamp((speed - T.speedMin) / (T.speedMax - T.speedMin), 0, 1);
    return lerp(T.turnSlow, T.turnFast, k);
  }

  function updatePlayer(g, input, dt) {
    const pl = g.player;
    const sx = clamp(input.stickX || 0, -1, 1);
    const sy = clamp(input.stickY || 0, -1, 1);
    pl.throttle = clamp(input.throttle === undefined ? pl.throttle : input.throttle, 0, 1);

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

    const target = pl.boosting ? T.speedBoost : lerp(T.speedMin, T.speedMax, pl.throttle);
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
    const stickMag = Math.sqrt(sx * sx + sy * sy);
    if (pl.focus && pl.focus.ang <= T.magnetCone && stickMag < 0.5) {
      const want = yawPitchOf(sub(pl.focus.lead, pl.pos));
      const k = 1 - stickMag / 0.5;
      tYaw += clamp(wrapAngle(want.yaw - pl.yaw) * 4, -T.magnetRate, T.magnetRate) * k;
      tPitch += clamp((want.pitch - pl.pitch) * 4, -T.magnetRate, T.magnetRate) * k;
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

  function fireMissile(g, input, dt) {
    const pl = g.player;
    if (pl.missiles < T.missileMax) {
      pl.missileCd += dt;
      if (pl.missileCd >= T.missileReload) { pl.missileCd = 0; pl.missiles++; }
    } else {
      pl.missileCd = 0;
    }
    if (!input.missile || pl.missiles <= 0) return;
    pl.missiles--;
    const tgt = pl.locked ? pl.lockId : 0;
    const pos = addScaled(pl.pos, vec(0, -1, 0), 1.5);
    g.missiles.push({
      id: g.nextId++, pos: pos, prev: copy(pos), dir: copy(pl.dir),
      speed: Math.max(T.missileSpeed0, pl.speed), target: tgt, life: T.missileLife, age: 0, dead: false
    });
    emit(g, 'missile', { pos: pos, locked: !!tgt });
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
      const boxes = bossBoxes(g.boss);
      for (let i = 0; i < boxes.length; i++) {
        const t = segmentBox(p0, p1, boxes[i].min, boxes[i].max);
        if (t >= 0 && t < bestT) { bestT = t; best = { target: null, hull: boxes[i].name }; }
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
        const boxes = bossBoxes(g.boss);
        for (let k = 0; k < boxes.length; k++) {
          const ahead = addScaled(f.pos, f.dir, 60);
          const pad = 30;
          const b = boxes[k];
          if (ahead.x > b.min.x - pad && ahead.x < b.max.x + pad && ahead.y > b.min.y - pad &&
              ahead.y < b.max.y + pad && ahead.z > b.min.z - pad && ahead.z < b.max.z + pad) {
            const c = scale(add(b.min, b.max), 0.5);
            desired = add(norm(sub(f.pos, c)), vec(0, 0.8, 0));
          }
          const push = sphereBoxPush(f.pos, f.radius, b.min, b.max);
          if (push) f.pos = addScaled(f.pos, push.normal, push.depth);
        }
      }

      const before = f.dir;
      f.dir = rotateToward(f.dir, desired, T.fighterTurn * f.skill * dt);
      f.speed = approach(f.speed, speed, 2, dt);
      f.vel = scale(f.dir, f.speed);
      f.pos = addScaled(f.pos, f.vel, dt);
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

  function launchEscorts(g, n) {
    const b = g.boss;
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const pos = add(b.pos, vec(300 - i * 30, -10, side * 110));
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
      const e = 1 - Math.pow(1 - k, 3);
      const prev = b.pos;
      b.pos = vec(lerp(BOSS_FROM.x, BOSS_AT.x, e), BOSS_AT.y, BOSS_AT.z);
      b.vel = dt > 0 ? scale(sub(b.pos, prev), 1 / dt) : vec();
      if (k >= 1) {
        b.phase = 'battle';
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
        const box = BOSS_BOXES[Math.floor(g.rng() * 7)];
        const p = add(add(b.pos, box.c), vec(rand(g, -0.5, 0.5) * box.s.x, rand(g, -0.5, 0.5) * box.s.y, rand(g, -0.5, 0.5) * box.s.z));
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
      emit(g, 'explode', { pos: add(b.pos, BOSS_BOXES[7].c), size: 3, kind: 'armor' });
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
    const boxes = bossBoxes(g.boss);
    for (let i = 0; i < boxes.length; i++) if (segmentBox(p0, p1, boxes[i].min, boxes[i].max) >= 0) return true;
    return false;
  }

  function collidePlayer(g, dt) {
    const pl = g.player;
    pl.scrapeCd = Math.max(0, pl.scrapeCd - dt);
    if (!g.boss || g.boss.phase === 'dead' || !pl.alive) return;
    const boxes = bossBoxes(g.boss);
    for (let i = 0; i < boxes.length; i++) {
      const push = sphereBoxPush(pl.pos, T.playerRadius, boxes[i].min, boxes[i].max);
      if (!push) continue;
      pl.pos = addScaled(pl.pos, push.normal, push.depth + 0.01);
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
   * 1ステップ進める。input = { stickX, stickY, throttle, fire, boost, missile }
   * missile は「押した瞬間」だけ true にする。
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
    return { stickX: input.stickX, stickY: input.stickY, throttle: input.throttle, fire: input.fire, boost: input.boost, missile: false };
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
      updateAim(g);
      if (g.state === 'play') {
        fireLasers(g, input, dt);
        fireMissile(g, input, dt);
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
    const input = { stickX: 0, stickY: 0, throttle: 0.45, fire: false, boost: false, missile: false };
    if (!pl.alive || g.state !== 'play') return input;
    // 狙う相手: いちばん近い的 (戦艦の部位を含む)
    const ts = targets(g);
    let tgt = null, best = 1e9;
    for (let i = 0; i < ts.length; i++) {
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
      const boxes = bossBoxes(g.boss);
      const ahead = addScaled(pl.pos, pl.dir, 70);
      for (let i = 0; i < boxes.length; i++) {
        const push = sphereBoxPush(ahead, 25, boxes[i].min, boxes[i].max);
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
    BOSS_BOXES: BOSS_BOXES,
    BOSS_PARTS: BOSS_PARTS,
    BOSS_CANNON: BOSS_CANNON,
    mulberry32: mulberry32,
    vec: vec, add: add, sub: sub, scale: scale, dot: dot, cross: cross, len: len, dist: dist, norm: norm,
    clamp: clamp, lerp: lerp, approach: approach, angleBetween: angleBetween, rotateToward: rotateToward,
    forwardFrom: forwardFrom, yawPitchOf: yawPitchOf, wrapAngle: wrapAngle,
    intercept: intercept, segmentSphere: segmentSphere, segmentBox: segmentBox, sphereBoxPush: sphereBoxPush,
    frameDt: frameDt, turnLimit: turnLimit, beamHits: beamHits,
    createGame: createGame, step: step, targets: targets, bossBoxes: bossBoxes, result: result,
    autopilot: autopilot, makeFighter: makeFighter, makeBoss: makeBoss
  };
});
