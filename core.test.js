const test = require('node:test');
const assert = require('node:assert');
const C = require('./core.js');

const T = C.TUNING;
const DEG = C.DEG;

/** 何もしない入力で n 秒すすめる。 */
function run(g, sec, input, dt) {
  dt = dt || 1 / 60;
  const steps = Math.round(sec / dt);
  for (let i = 0; i < steps; i++) {
    C.step(g, typeof input === 'function' ? input(g) : (input || {}), dt);
  }
  return g;
}

/** 戦闘機だけを置いた静かな場を作る (第1波を片づける)。 */
function quietGame(seed) {
  const g = C.createGame({ seed: seed || 1 });
  g.fighters = [];
  g.stage = 'test';         // 進行を止める
  g.events.length = 0;
  return g;
}

// ------------------------------------------------------------ 土台

test('同じ seed と同じ入力からは、同じ結果になる', () => {
  const a = C.createGame({ seed: 42 });
  const b = C.createGame({ seed: 42 });
  run(a, 20, (g) => C.autopilot(g, 1));
  run(b, 20, (g) => C.autopilot(g, 1));
  assert.deepStrictEqual(a.player.pos, b.player.pos);
  assert.strictEqual(a.stats.score, b.stats.score);
});

test('フレームの間隔は上も下も止める (負の dt で全部が逆に飛ばない)', () => {
  assert.strictEqual(C.frameDt(-4040), 0);
  assert.strictEqual(C.frameDt(NaN), 0);
  assert.strictEqual(C.frameDt(undefined), 0);
  assert.strictEqual(C.frameDt(16), 0.016);
  assert.strictEqual(C.frameDt(5000), 0.05);
  const g = quietGame();
  const before = C.vec(g.player.pos.x, g.player.pos.y, g.player.pos.z);
  C.step(g, {}, -3);
  assert.deepStrictEqual(g.player.pos, before, 'dt が負なら何も動かない');
});

test('偏差射撃: 出した点へ撃つと、動いている的に当たる', () => {
  const from = C.vec(0, 0, 0);
  const cases = [
    [C.vec(0, 0, -400), C.vec(70, 0, 0)],
    [C.vec(150, 80, -300), C.vec(-40, 30, 60)],
    [C.vec(-500, -40, 200), C.vec(0, 0, -90)]
  ];
  for (const [pos, vel] of cases) {
    const ic = C.intercept(from, pos, vel, T.laserSpeed);
    assert.ok(ic, '解がある');
    const dir = C.norm(C.sub(ic.point, from));
    const bullet = C.scale(dir, T.laserSpeed * ic.t);
    const target = C.add(pos, C.scale(vel, ic.t));
    assert.ok(C.dist(bullet, target) < 1e-6, `的と弾が同じ時に同じ所にいる (${C.dist(bullet, target)})`);
  }
});

test('速い弾でも的をすり抜けない (線分で当てる)', () => {
  // 1 コマで 620/60 ≒ 10m 進む弾と、半径 7m の的。どこで区切っても当たる
  const r = T.fighterRadius;
  for (let off = 0; off < 10.3; off += 0.37) {
    let hit = false;
    for (let k = 0; k < 6 && !hit; k++) {
      const p0 = C.vec(0, 3, -off - k * 10.3);
      const p1 = C.vec(0, 3, -off - (k + 1) * 10.3);
      if (C.segmentSphere(p0, p1, C.vec(0, 0, -30), r) >= 0) hit = true;
    }
    assert.ok(hit, `区切り ${off.toFixed(2)} でも当たる`);
  }
  assert.strictEqual(C.segmentSphere(C.vec(0, 10, 0), C.vec(0, 10, -100), C.vec(0, 0, -50), 7), -1, '外れる弾は外れる');
});

// ------------------------------------------------------------ 飛行

test('旋回の速さ: 低速で 90°/秒、速いほど小回りが利かない', () => {
  const rates = {};
  for (const thr of [0, 1]) {
    const g = quietGame();
    g.player.speed = C.lerp(T.speedMin, T.speedMax, thr);
    run(g, 1.5, { stickX: 1, throttle: thr });
    rates[thr] = Math.abs(g.player.yawRate) / DEG;
  }
  assert.ok(Math.abs(rates[0] - 90) < 3, `低速 ${rates[0].toFixed(1)}°/秒`);
  assert.ok(rates[1] < 60 && rates[1] > 45, `最高速 ${rates[1].toFixed(1)}°/秒`);
});

test('スティックを右に倒すと右へ曲がり、右へ傾く', () => {
  const g = quietGame();
  run(g, 0.8, { stickX: 1 });
  assert.ok(g.player.dir.x > 0.3, `右を向く (${g.player.dir.x.toFixed(2)})`);
  assert.ok(g.player.roll < -20 * DEG, `右に傾く (${(g.player.roll / DEG).toFixed(0)}°)`);
});

test('スティックを離すと、急に暴れずに止まる', () => {
  const g = quietGame();
  run(g, 1, { stickX: 1, stickY: 0.7 });
  run(g, 0.8, {});
  assert.ok(Math.abs(g.player.yawRate) < 2 * DEG, `ヨーが止まる (${(g.player.yawRate / DEG).toFixed(2)}°/秒)`);
  assert.ok(Math.abs(g.player.pitchRate) < 2 * DEG, 'ピッチも止まる');
  run(g, 1.2, {});
  assert.ok(Math.abs(g.player.roll) < 3 * DEG, `傾きが戻る (${(g.player.roll / DEG).toFixed(1)}°)`);
});

test('上を向き続けても、真上で裏返らない', () => {
  const g = quietGame();
  let prevYaw = g.player.yaw;
  let maxJump = 0;
  for (let i = 0; i < 300; i++) {
    C.step(g, { stickY: 1 }, 1 / 60);
    maxJump = Math.max(maxJump, Math.abs(C.wrapAngle(g.player.yaw - prevYaw)));
    prevYaw = g.player.yaw;
  }
  assert.ok(g.player.pitch <= T.pitchLimit + 1e-9, 'ピッチは上限で止まる');
  assert.ok(maxJump < 1 * DEG, 'ヨーが急に跳ばない');
});

test('スロットルで速さが変わり、ブーストで 140m/s まで出る。エネルギーは減って戻る', () => {
  const g = quietGame();
  run(g, 3, { throttle: 0 });
  assert.ok(Math.abs(g.player.speed - T.speedMin) < 0.5, `最低速 ${g.player.speed.toFixed(1)}`);
  run(g, 3, { throttle: 1 });
  assert.ok(Math.abs(g.player.speed - T.speedMax) < 0.5, `最高速 ${g.player.speed.toFixed(1)}`);
  run(g, 1.2, { throttle: 1, boost: true });
  assert.ok(g.player.speed > 135, `ブースト ${g.player.speed.toFixed(1)}`);
  const used = g.player.boost;
  assert.ok(used < 60, 'エネルギーを使う');
  run(g, 3, { throttle: 1 });
  assert.ok(g.player.boost > used + 30, '離すと戻る');
});

test('戦域の外へまっすぐ飛び続けても、自動で戻ってくる', () => {
  const g = quietGame();
  let far = 0;
  run(g, 150, (gg) => { far = Math.max(far, C.dist(gg.player.pos, T.arenaCenter)); return { throttle: 1 }; });
  assert.ok(far < T.arenaRadius + 700, `いちばん遠くて ${far.toFixed(0)}m`);
});

// ------------------------------------------------------------ 照準・射撃

function fighterAhead(g, angleDeg, d) {
  const dir = C.forwardFrom(-angleDeg * DEG, 0);
  const f = C.makeFighter(g, C.scale(dir, d || 300), C.vec(0, 0, 1));
  f.vel = C.vec(); f.speed = 0;
  g.fighters.push(f);
  return f;
}

test('照準補助: 近くの敵にだけ弾を少し曲げる。曲げすぎない', () => {
  const near = quietGame();
  fighterAhead(near, 3);
  run(near, 1 / 60, {});
  const a1 = C.angleBetween(near.player.aimDir, near.player.dir) / DEG;
  assert.ok(near.player.assist, '3° なら補助が入る');
  assert.ok(a1 > 1 && a1 <= T.assistBend / DEG + 1e-6, `曲げるのは最大 ${(T.assistBend / DEG).toFixed(1)}° (${a1.toFixed(2)}°)`);

  const far = quietGame();
  fighterAhead(far, 9);
  run(far, 1 / 60, {});
  assert.ok(far.player.focus, '9° でも偏差マーカーは出す');
  assert.strictEqual(far.player.assist, null, '9° では弾を曲げない');
  assert.ok(C.angleBetween(far.player.aimDir, far.player.dir) < 1e-6);
});

test('照準補助の吸いつきは、スティックを大きく倒すと効かない', () => {
  const free = quietGame();
  fighterAhead(free, 3);
  run(free, 0.3, {});
  const pulled = free.player.yaw;
  const held = quietGame();
  fighterAhead(held, 3);
  run(held, 0.3, { stickX: -0.8 });
  assert.ok(pulled < 0, '手を離していると、敵の方へわずかに寄る');
  assert.ok(held.player.yaw > 0.05, 'スティックを倒せば、その向きへ曲がる');
});

test('正面の敵をレーザーで撃つと、5発で落ちる', () => {
  const g = quietGame();
  const f = fighterAhead(g, 0, 250);
  let hits = 0;
  run(g, 1.2, (gg) => {
    for (const e of gg.events) if (e.type === 'hit') hits++;
    gg.events.length = 0;
    return { fire: true };
  });
  assert.strictEqual(f.alive, false, '撃墜');
  assert.strictEqual(hits, T.fighterHp);
  assert.strictEqual(g.stats.kills, 1);
  assert.ok(g.stats.score >= 100);
});

test('ロックオンしたミサイルは、動く敵を追って当たる', () => {
  const g = quietGame();
  const f = fighterAhead(g, 4, 400);
  f.hp = 1;
  run(g, 0.8, {});
  assert.ok(g.player.locked, 'ロックできている');
  f.vel = C.vec(60, 20, 0);
  f.dir = C.norm(f.vel);
  f.speed = 60;
  f.mode = 'test';            // AI を止めて直進させる
  C.step(g, { missile: true }, 1 / 60);
  assert.strictEqual(g.player.missiles, T.missileMax - 1);
  run(g, 4, {});
  assert.strictEqual(f.alive, false, 'ミサイルで撃墜');
});

// ------------------------------------------------------------ 敵

test('敵は追いかけている最中、ふだんの自機より遅く、小回りも利かない (追えば背後を取れる)', () => {
  const g = quietGame();
  const myTurn = C.turnLimit(T.speedNormal, false);
  for (let i = 0; i < 200; i++) {
    const f = C.makeFighter(g, C.vec(0, 0, -500), C.vec(0, 0, 1));
    assert.ok(T.fighterSpeed * f.skill < T.speedNormal, `速さ ${(T.fighterSpeed * f.skill).toFixed(1)} < ${T.speedNormal}`);
    assert.ok(T.fighterTurn * f.skill < myTurn, `旋回 ${(T.fighterTurn * f.skill / DEG).toFixed(1)}° < ${(myTurn / DEG).toFixed(1)}°`);
  }
});

test('敵戦闘機は撃ってくるが、体当たりはしてこない', () => {
  const g = C.createGame({ seed: 5 });
  let minD = 1e9, shots = 0;
  run(g, 40, (gg) => {
    for (const f of gg.fighters) minD = Math.min(minD, C.dist(f.pos, gg.player.pos));
    for (const e of gg.events) if (e.type === 'enemyLaser') shots++;
    gg.events.length = 0;
    return { stickX: 0.3, throttle: 0.4 };
  });
  assert.ok(shots > 10, `撃ってくる (${shots}発)`);
  assert.ok(minD > 20, `いちばん近づいて ${minD.toFixed(0)}m`);
});

// ------------------------------------------------------------ 巨大戦艦

function bossGame() {
  const g = C.createGame({ seed: 7, start: 'boss' });
  run(g, 14, {});
  g.fighters = [];
  return g;
}
function killParts(g, kind) {
  for (const p of g.boss.parts) if (p.kind === kind) { p.hp = 0; p.alive = false; }
}

test('戦艦は 砲台 → 主砲 → エンジン → コア → 撃沈 の順に進む', () => {
  const g = bossGame();
  assert.strictEqual(g.boss.phase, 'battle');
  const turrets = g.boss.parts.filter((p) => p.kind === 'turret');
  turrets.slice(0, 3).forEach((p) => { p.hp = 0; p.alive = false; });
  run(g, 0.1, {});
  assert.strictEqual(g.boss.phase, 'cannon');
  assert.ok(g.boss.parts.filter((p) => p.kind === 'engine').every((p) => !p.active), 'エンジンはまだ撃てない');
  killParts(g, 'turret');
  run(g, 0.1, {});
  assert.strictEqual(g.boss.phase, 'weak');
  assert.ok(g.boss.armor, '装甲はまだある');
  killParts(g, 'engine');
  run(g, 0.1, {});
  assert.strictEqual(g.boss.phase, 'core');
  assert.strictEqual(g.boss.armor, false, '装甲が外れる');
  killParts(g, 'core');
  run(g, 0.1, {});
  assert.strictEqual(g.boss.phase, 'dying');
  assert.strictEqual(g.state, 'ending');
  run(g, 15, {});
  assert.strictEqual(g.boss.phase, 'dead');
  assert.strictEqual(g.state, 'clear');
});

test('装甲があるうちはコアを撃っても効かない。外れたら効く', () => {
  const g = bossGame();
  const core = g.boss.parts.find((p) => p.kind === 'core');
  // コアの真上から撃ち下ろす
  // ピッチは上限 (78°) で止まるので、その角度でコアへ向く位置に置く
  const aim = () => {
    const dir = C.forwardFrom(0, -T.pitchLimit);
    g.player.pos = C.add(core.pos, C.scale(dir, -160));
    g.player.pitch = -T.pitchLimit; g.player.yaw = 0;
    g.player.yawRate = 0; g.player.pitchRate = 0;
  };
  for (let i = 0; i < 60; i++) { aim(); C.step(g, { fire: true, throttle: 0 }, 1 / 60); }
  assert.strictEqual(core.hp, core.maxHp, '装甲に弾かれる');
  killParts(g, 'turret');
  run(g, 0.05, {});
  killParts(g, 'engine');
  run(g, 0.05, {});
  assert.strictEqual(g.boss.armor, false);
  g.fighters = [];
  for (let i = 0; i < 60; i++) { aim(); C.step(g, { fire: true, throttle: 0 }, 1 / 60); }
  assert.ok(core.hp < core.maxHp, `コアに当たる (残り ${core.hp})`);
});

function cannonGame() {
  const g = bossGame();
  killParts(g, 'turret');        // 砲台を消して主砲だけにする
  run(g, 0.05, {});
  g.fighters = [];
  g.shots = [];
  return g;
}

test('主砲: 射線に乗ったままだと当たる。固定されてから横へ動けばよけられる', () => {
  // 主砲の正面 600m に置き、主砲へ向かってまっすぐ飛ぶ → 当たる
  const stay = cannonGame();
  const from = C.add(stay.boss.pos, C.BOSS_CANNON);
  stay.player.pos = C.add(from, C.vec(-600, 0, 0));
  stay.player.yaw = -90 * DEG; stay.player.pitch = 0;   // +X を向く
  stay.player.speed = 30;
  let hitStay = 0;
  run(stay, 6, (gg) => {
    for (const e of gg.events) if (e.type === 'playerHit' && e.amount === T.cannonDamage) hitStay++;
    gg.events.length = 0;
    return { throttle: 0.1 };
  });
  assert.strictEqual(hitStay, 1, '射線の上にいると当たる');

  // 同じ場所から、射線に対して横向きに飛ぶ → 当たらない
  const dodge = cannonGame();
  dodge.player.pos = C.add(from, C.vec(-600, 0, 0));
  dodge.player.yaw = 0; dodge.player.pitch = 0;        // -Z を向く (射線と直角)
  let hitDodge = 0, fired = 0;
  run(dodge, 6, (gg) => {
    for (const e of gg.events) {
      if (e.type === 'playerHit' && e.amount === T.cannonDamage) hitDodge++;
      if (e.type === 'cannonFire') fired++;
    }
    gg.events.length = 0;
    return { throttle: 0.5 };
  });
  assert.ok(fired >= 1, '主砲は撃っている');
  assert.strictEqual(hitDodge, 0, '動いていればよけられる');
});

test('船体にぶつかっても、中に入り込まない', () => {
  const g = bossGame();
  const hull = C.bossBoxes(g.boss)[0];
  g.player.pos = C.vec((hull.min.x + hull.max.x) / 2, hull.max.y + 30, (hull.min.z + hull.max.z) / 2);
  g.player.pitch = -60 * DEG;
  let inside = 0, scrapes = 0;
  run(g, 3, (gg) => {
    for (const b of C.bossBoxes(gg.boss)) {
      const p = gg.player.pos;
      if (p.x > b.min.x + 0.5 && p.x < b.max.x - 0.5 && p.y > b.min.y + 0.5 && p.y < b.max.y - 0.5 &&
          p.z > b.min.z + 0.5 && p.z < b.max.z - 0.5) inside++;
    }
    for (const e of gg.events) if (e.type === 'scrape') scrapes++;
    gg.events.length = 0;
    return { stickY: -1, throttle: 1 };
  });
  assert.strictEqual(inside, 0, '箱の中に入らない');
  assert.ok(scrapes > 0, 'こすった知らせが出る');
});

test('見た目と当たり判定は同じ箱の表から作る (装甲だけが外れる)', () => {
  const g = bossGame();
  assert.strictEqual(C.bossBoxes(g.boss).length, C.BOSS_BOXES.length);
  g.boss.armor = false;
  assert.strictEqual(C.bossBoxes(g.boss).length, C.BOSS_BOXES.length - 1);
  // 部位は船体の箱の外側に顔を出している (撃てる)
  for (const p of C.BOSS_PARTS) {
    const top = C.add(p.at, C.scale(p.face, 1000));
    let first = 1;
    for (const b of C.BOSS_BOXES) {
      if (b.armor && p.kind === 'core') continue;
      const min = C.sub(b.c, C.scale(b.s, 0.5)), max = C.add(b.c, C.scale(b.s, 0.5));
      const t = C.segmentBox(top, p.at, min, max);
      if (t >= 0) first = Math.min(first, t);
    }
    const tPart = C.segmentSphere(top, p.at, p.at, p.kind === 'turret' ? 12 : p.kind === 'engine' ? 17 : 15);
    assert.ok(tPart < first, `${p.kind} (${p.at.x},${p.at.y},${p.at.z}) は外から撃てる`);
  }
});

// ------------------------------------------------------------ 通しで遊ぶ

test('上手な自動操縦は、8通りの始め方のうち7つ以上で最後まで勝てる', () => {
  let cleared = 0;
  const times = [];
  for (let seed = 1; seed <= 8; seed++) {
    const g = C.createGame({ seed: seed });
    run(g, 420, (gg) => { gg.events.length = 0; return gg.state === 'play' ? C.autopilot(gg, 1) : {}; }, 1 / 30);
    if (g.state === 'clear') { cleared++; times.push(Math.round(g.stats.time)); }
  }
  assert.ok(cleared >= 7, `勝てたのは ${cleared}/8 (${times.join(', ')} 秒)`);
  assert.ok(Math.max.apply(null, times) < 330, 'どれも 5 分半以内');
});

test('主砲は脅威になる: よけない操縦では当たり、よける操縦ではほとんど当たらない', () => {
  const count = (skill) => {
    let fired = 0, hit = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const g = C.createGame({ seed: seed, start: 'boss' });
      run(g, 200, (gg) => {
        for (const e of gg.events) {
          if (e.type === 'cannonFire') fired++;
          if (e.type === 'playerHit' && e.amount === T.cannonDamage) hit++;
        }
        gg.events.length = 0;
        return gg.state === 'play' ? C.autopilot(gg, skill) : {};
      }, 1 / 30);
    }
    return { fired: fired, hit: hit };
  };
  const good = count(1);
  const lazy = count(0.45);
  assert.ok(good.fired >= 8 && good.hit / good.fired < 0.15, `よける: ${good.hit}/${good.fired} 発 当たる`);
  assert.ok(lazy.hit >= 1, `よけない: ${lazy.hit}/${lazy.fired} 発 当たる`);
});

test('成績: 勝てばランクが付き、負ければ付かない', () => {
  const g = C.createGame({ seed: 2 });
  run(g, 420, (gg) => { gg.events.length = 0; return gg.state === 'play' ? C.autopilot(gg, 1) : {}; }, 1 / 30);
  const r = C.result(g);
  assert.ok(r.cleared && ['S', 'A', 'B', 'C'].includes(r.rank));
  assert.ok(r.total >= r.score);
  const lose = quietGame();
  lose.player.shield = 0; lose.player.hull = 1;
  lose.shots.push({ owner: 'enemy', pos: C.vec(0, 0, -20), prev: C.vec(0, 0, -20), vel: C.vec(0, 0, 200), life: 1, dmg: 5, dead: false });
  run(lose, 0.5, {});
  assert.strictEqual(lose.state, 'over');
  assert.strictEqual(C.result(lose).cleared, false);
});
