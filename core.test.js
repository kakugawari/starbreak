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

test('自動の速さ: スティックを大きく倒すと減速して小回りが利き、まっすぐなら戻る', () => {
  const g = quietGame();
  run(g, 1, {});
  assert.ok(Math.abs(g.player.speed - T.speedNormal) < 0.5, `ふだんは ${T.speedNormal}m/s (${g.player.speed.toFixed(1)})`);
  // 中くらいに倒すだけなら速さは変わらない (狙うときに勝手に遅くならない)
  run(g, 1, { stickX: 0.5 });
  assert.ok(g.player.speed > T.speedNormal - 1, `半分くらいでは減速しない (${g.player.speed.toFixed(1)})`);
  // いっぱいに倒すと減速し、小回りが利く
  run(g, 1.2, { stickX: 1 });
  const slow = g.player.speed, rate = Math.abs(g.player.yawRate) / DEG;
  assert.ok(slow < T.autoSlowSpeed + 3, `いっぱいで ${T.autoSlowSpeed}m/s 近くまで落ちる (${slow.toFixed(1)})`);
  assert.ok(rate > C.turnLimit(T.speedNormal, false) / DEG + 8, `ふだんより速く曲がる (${rate.toFixed(0)}°/秒)`);
  // 離すと戻る
  run(g, 1.5, {});
  assert.ok(g.player.speed > T.speedNormal - 1, `離すとふだんの速さへ戻る (${g.player.speed.toFixed(1)})`);
  // ブーストはそのまま効く
  run(g, 1.2, { stickX: 1, boost: true });
  assert.ok(g.player.speed > 130, `ブースト中は減速しない (${g.player.speed.toFixed(1)})`);
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

test('マルチロック: MSL を押している間に照準のまわりの敵を別々にロックし、離すと同じ数を一斉に撃つ', () => {
  const g = quietGame();
  const fs = [-8, 0, 9, 45].map((a) => { const f = fighterAhead(g, a, 320); f.hp = 1; f.mode = 'test'; return f; });
  const locks = [];
  run(g, 1.4, (gg) => { for (const e of gg.events) if (e.type === 'lock' && e.multi) locks.push(e); gg.events.length = 0; return { missileHold: true }; });
  const ids = g.player.mlock.slice().sort();
  assert.deepStrictEqual(ids, [fs[0].id, fs[1].id, fs[2].id].sort(), '範囲の 3 機を 1 回ずつ。45° 先の 1 機は範囲の外');
  assert.deepStrictEqual(locks.map((e) => e.n), [1, 2, 3], 'ロックの知らせは数つき');
  C.step(g, { missile: true }, 1 / 60);
  assert.strictEqual(g.player.missiles, T.missileMax - 3);
  assert.deepStrictEqual(g.missiles.map((m) => m.target).sort(), ids, '1 発ずつ別の敵へ');
  assert.strictEqual(g.player.mlock.length, 0, '撃ったらロックは空');
  const salvo = g.events.find((e) => e.type === 'missile');
  assert.strictEqual(salvo.salvo, 3);
  run(g, 4, {});
  assert.ok(fs.slice(0, 3).every((f) => !f.alive), '3 機とも落ちる');
});

test('マルチロック: 硬い敵には要る数だけ重ねてロックし、残り弾数より多くはロックしない', () => {
  const g = quietGame();
  const big = fighterAhead(g, 0, 320); big.hp = T.missileDamage * 2; big.mode = 'test';
  run(g, 2, { missileHold: true });
  assert.deepStrictEqual(g.player.mlock, [big.id, big.id], '2 発で落ちる敵には 2 つまで');
  const h = quietGame();
  [-6, 0, 6].forEach((a) => { const f = fighterAhead(h, a, 320); f.hp = 1; f.mode = 'test'; });
  h.player.missiles = 2;
  run(h, 2, { missileHold: true });
  assert.strictEqual(h.player.mlock.length, 2, '残り 2 発なら 2 つまで');
});

test('マルチロック: ロックせずに離せば (タップ) 1 発だけ撃つ。押したまま外へ逃げられた敵は外れる', () => {
  const g = quietGame();
  [-6, 0, 6].forEach((a) => { const f = fighterAhead(g, a, 320); f.hp = 1; f.mode = 'test'; });
  C.step(g, { missileHold: true }, 1 / 60);
  C.step(g, { missile: true }, 1 / 60);
  assert.strictEqual(g.player.missiles, T.missileMax - 1);
  assert.strictEqual(g.missiles.length, 1);
  const h = quietGame();
  const f = fighterAhead(h, 0, 320); f.hp = 1; f.mode = 'test';
  run(h, 0.5, { missileHold: true });
  assert.strictEqual(h.player.mlock.length, 1);
  f.alive = false;
  run(h, 1 / 60, { missileHold: true });
  assert.strictEqual(h.player.mlock.length, 0, '落ちた敵のロックは消える');
});

// ------------------------------------------------------------ ロックオンボタン (狙う相手)

test('ロックオンボタン: タップで照準にいちばん近い敵を選び、もう一度で次へ切り替わる', () => {
  const g = quietGame();
  const a = fighterAhead(g, 30, 300);     // 30° 右
  const b = fighterAhead(g, -8, 400);     // 8° 左 (照準にいちばん近い)
  const c = fighterAhead(g, 120, 300);    // 後ろ寄り
  [a, b, c].forEach((f) => { f.mode = 'hold'; f.fireCd = 99; });
  C.step(g, { select: true }, 1 / 60);
  assert.strictEqual(g.player.targetId, b.id, '照準にいちばん近い敵');
  C.step(g, { select: true }, 1 / 60);
  assert.strictEqual(g.player.targetId, a.id, '次に近い敵');
  C.step(g, { select: true }, 1 / 60);
  assert.strictEqual(g.player.targetId, c.id, 'その次 (後ろの敵も選べる)');
  C.step(g, { select: true }, 1 / 60);
  assert.strictEqual(g.player.targetId, b.id, '一周して最初へ');
});

test('ロックオンボタン: 押しっぱなしで、真後ろの敵へも機首が向く', () => {
  const g = quietGame();
  const f = fighterAhead(g, 180, 300);
  f.mode = 'hold'; f.fireCd = 99;
  C.step(g, { select: true }, 1 / 60);
  assert.strictEqual(g.player.targetId, f.id);
  let t = 0;
  while (t < 6 && C.angleBetween(g.player.dir, C.sub(f.pos, g.player.pos)) > 8 * DEG) {
    C.step(g, { track: true }, 1 / 60); t += 1 / 60;
  }
  const ang = C.angleBetween(g.player.dir, C.sub(f.pos, g.player.pos)) / DEG;
  assert.ok(ang <= 8, `機首と敵のなす角 ${ang.toFixed(1)}° (${t.toFixed(1)} 秒)`);
  assert.ok(t < 4, `4 秒以内に向く (${t.toFixed(1)} 秒)`);
  // 手を離せば、それ以上は勝手に向かない (スティックを優先)
  const g2 = quietGame();
  const f2 = fighterAhead(g2, 90, 300); f2.mode = 'hold'; f2.fireCd = 99;
  C.step(g2, { select: true }, 1 / 60);
  run(g2, 1, { track: true, stickX: -1 });
  assert.ok(g2.player.dir.x < 0, 'スティックを左いっぱいに倒すと、右の敵ではなく左へ曲がる');
});

test('ロックオンボタン: 狙う相手を倒すと、次の敵へ移る。狙う相手は円の外でも偏差の印が出る', () => {
  const g = quietGame();
  const a = fighterAhead(g, 0, 250);
  const b = fighterAhead(g, 60, 300);
  [a, b].forEach((f) => { f.mode = 'hold'; f.fireCd = 99; });
  C.step(g, { select: true }, 1 / 60);
  assert.strictEqual(g.player.targetId, a.id);
  run(g, 1.2, { fire: true });
  assert.strictEqual(a.alive, false, '撃墜');
  assert.strictEqual(g.player.targetId, b.id, '次の敵へ移る');
  assert.ok(g.player.focus && g.player.focus.target === b, `60° 横でも狙う相手に偏差の印が出る`);
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
  assert.strictEqual(g.state, 'play', '1 面の戦艦では終わらず、2 面へ進む');
  assert.strictEqual(g.level, 2);
  assert.strictEqual(g.boss, null);
  // 2 面のボスはエース機。落とすと 3 面へ進む
  g.stage = 'gap2'; g.stageTimer = 99; g.fighters = [];
  run(g, 1, (gg) => { gg.fighters = gg.fighters.filter((f) => f.ace); return {}; });
  assert.ok(g.ace && g.ace.alive && g.stage === 'ace', 'エース機が出る');
  assert.strictEqual(g.boss, null, '2 面に戦艦はいない');
  g.ace.hp = 0.1; g.ace.pos = C.add(g.player.pos, C.vec(0, 0, -60));
  for (let i = 0; i < 90 && g.ace.alive; i++) { g.ace.pos = C.add(g.player.pos, C.vec(0, 0, -60)); C.step(g, { fire: true, throttle: 0 }, 1 / 30); }
  run(g, T.aceDownDelay + 1, (gg) => { gg.fighters = []; return {}; });
  assert.strictEqual(g.level, 3);
  // 3 面の戦艦まで飛ばして、同じ順で沈めるとクリア
  g.stage = 'gap2'; g.stageTimer = 99; g.fighters = [];
  run(g, 14, (gg) => { gg.fighters = []; return {}; });
  assert.strictEqual(g.boss.level, 3);
  assert.strictEqual(g.boss.phase, 'battle');
  for (const k of ['turret', 'engine', 'core']) { killParts(g, k); run(g, 0.1, {}); }
  assert.strictEqual(g.boss.phase, 'dying');
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

test('円い胴・横向きの円盤・斜めの船首: 箱で近似せず、形の外の弾は素通りし、中の弾は当たる', () => {
  // 真ん中の円い胴 (半径 72m の 16 角形)。それを囲む箱の角 (70, 70) は胴の外
  const hub = C.solidPlanes(C.BOSS_SOLIDS.find((sd) => sd.name === 'hub'), C.vec(0, 0, 0));
  const down = (planes, x, z) => C.segmentSolid(C.vec(x, 200, z), C.vec(x, -200, z), planes);
  assert.ok(down(hub.planes, 0, 0) >= 0, '真ん中は当たる');
  assert.ok(down(hub.planes, 0, 70) >= 0, 'ふちの内側は当たる');
  assert.strictEqual(down(hub.planes, 70, 70), -1, '囲む箱の角は素通り (箱で近似していたら当たってしまう所)');
  assert.ok(hub.max.x > 70 && hub.max.z > 70, '外接する箱の中ではある');
  // 左右の船体の、斜めに落とした船首
  const pod = C.solidPlanes(C.BOSS_SOLIDS.find((sd) => sd.name === 'podFrontR'), C.vec(0, 0, 0));
  assert.ok(down(pod.planes, -200, 75) >= 0, '船体の真ん中は当たる');
  assert.strictEqual(down(pod.planes, -325, 110), -1, '斜めに落とした角の外は素通り');
  // 横から撃っても同じ
  const side = (x, y) => C.segmentSolid(C.vec(x, y, 500), C.vec(x, y, -500), hub.planes);
  assert.ok(side(0, 0) >= 0 && side(0, 35) === -1 && side(0, -35) === -1, '高さの範囲 (-32〜32m) の中だけ当たる');
  // 横向きの円盤 (半径 55m・z 40〜116m)。横から撃つと円の中だけ当たる
  const wheel = C.solidPlanes(C.BOSS_SOLIDS.find((sd) => sd.name === 'wheelR'), C.vec(0, 0, 0));
  const fromSide = (x, y) => C.segmentSolid(C.vec(x, y, 400), C.vec(x, y, 0), wheel.planes);
  assert.ok(fromSide(0, 50) >= 0, '円盤の上のふちの内側は当たる');
  assert.strictEqual(fromSide(45, 45), -1, '円盤を囲む箱の角は素通り');
  assert.ok(Math.abs(wheel.max.z - 116) < 1e-9 && Math.abs(wheel.min.z - 40) < 1e-9 && Math.abs(wheel.max.y - 55) < 0.01, `横向きの外接する箱 (z 40〜116・y ±55)`);
  assert.strictEqual(C.segmentSolid(C.vec(0, 0, 30), C.vec(0, 0, 38), wheel.planes), -1, '円盤の厚みの手前 (z 40 より内) は素通り');
});

test('船体にぶつかっても、中に入り込まない', () => {
  const g = bossGame();
  // 艦首寄りの船体の真上から突っ込む
  g.player.pos = C.add(g.boss.pos, C.vec(-150, 60, 0));
  g.player.pitch = -60 * DEG;
  let inside = 0, scrapes = 0;
  run(g, 3, (gg) => {
    for (const sd of C.bossSolids(gg.boss)) {
      // 0.5m より深く入っていたら「中」
      const deep = sd.planes.every((pl) => C.dot(pl.n, gg.player.pos) - pl.d < -0.5);
      if (deep) inside++;
    }
    for (const e of gg.events) if (e.type === 'scrape') scrapes++;
    gg.events.length = 0;
    return { stickY: -1, throttle: 1 };
  });
  assert.strictEqual(inside, 0, '立体の中に入らない');
  assert.ok(scrapes > 0, 'こすった知らせが出る');
});

test('船体にぶつかったら跳ね返る: 手を離していれば、こすり続けない', () => {
  // 上部構造の壁 (二段目の前の面) へ、まっすぐ水平に突っ込む
  const g = bossGame();
  g.player.pos = C.add(g.boss.pos, C.vec(-60, 38, 0));
  g.player.yaw = -90 * DEG; g.player.pitch = 0;          // +X (艦尾の方) を向く
  let scrapes = 0;
  run(g, 4, (gg) => {
    for (const e of gg.events) if (e.type === 'scrape') scrapes++;
    gg.events.length = 0;
    return { throttle: 0.5 };
  });
  assert.ok(scrapes >= 1, 'ぶつかってはいる');
  assert.ok(scrapes <= 1, `こすったのは ${scrapes} 回`);
});

test('見た目と当たり判定は同じ立体の表から作る (装甲だけが外れる)', () => {
  const g = bossGame();
  assert.strictEqual(C.bossSolids(g.boss).length, C.BOSS_SOLIDS.length);
  g.boss.armor = false;
  assert.strictEqual(C.bossSolids(g.boss).length, C.BOSS_SOLIDS.length - 1);
  // 部位は船体の外側に顔を出している (その面の向きから撃てる)
  const zero = C.vec(0, 0, 0);
  for (const p of C.BOSS_PARTS) {
    const from = C.add(p.at, C.scale(p.face, 1000));
    let first = 1;
    for (const sd of C.BOSS_SOLIDS) {
      if (sd.armor && p.kind === 'core') continue;
      const t = C.segmentSolid(from, p.at, C.solidPlanes(sd, zero).planes);
      if (t >= 0) first = Math.min(first, t);
    }
    const tPart = C.segmentSphere(from, p.at, p.at, p.kind === 'turret' ? 12 : p.kind === 'engine' ? 17 : 15);
    assert.ok(tPart < first, `${p.kind} (${p.at.x},${p.at.y},${p.at.z}) は外から撃てる`);
  }
  // 装甲があるうちは、コアは上から撃っても装甲に当たる
  const core = C.BOSS_PARTS.find((p) => p.kind === 'core');
  const armor = C.solidPlanes(C.BOSS_SOLIDS.find((sd) => sd.armor), zero);
  const from = C.add(core.at, C.vec(0, 1000, 0));
  assert.ok(C.segmentSolid(from, core.at, armor.planes) < C.segmentSphere(from, core.at, core.at, 15), 'コアは装甲の中');
});

test('護衛機は船体の外から出て、船体にめり込まない', () => {
  const g = C.createGame({ seed: 1, start: 'boss' });
  let worst = 0, launched = 0;
  run(g, 40, (gg) => {
    for (const e of gg.events) if (e.type === 'escorts') launched++;
    gg.events.length = 0;
    if (gg.boss && gg.boss.phase !== 'arrive') {
      for (const f of gg.fighters) for (const sd of C.bossSolids(gg.boss)) {
        const push = C.sphereSolidPush(f.pos, T.fighterRadius, sd.planes);
        if (push) worst = Math.max(worst, push.depth);
      }
    }
    return {};
  });
  assert.ok(launched >= 1, '護衛機が出る');
  assert.ok(worst < 0.05, `いちばん深いめり込み ${worst.toFixed(3)}m`);
});

// ------------------------------------------------------------ 通しで遊ぶ

test('上手な自動操縦は、8通りの始め方のうち7つ以上で 3 面の最後まで勝てる', () => {
  let cleared = 0;
  const times = [];
  for (let seed = 1; seed <= 8; seed++) {
    const g = C.createGame({ seed: seed });
    run(g, 1500, (gg) => { gg.events.length = 0; return gg.state === 'play' ? C.autopilot(gg, 1) : {}; }, 1 / 30);
    if (g.state === 'clear') { cleared++; times.push(Math.round(g.stats.time)); }
  }
  assert.ok(cleared >= 7, `勝てたのは ${cleared}/8 (${times.join(', ')} 秒)`);
  assert.ok(Math.max.apply(null, times) < 900, 'どれも 3 面あわせて 15 分以内');
});

test('3 面の流れ: 1 面の戦艦 → 2 面 (水星・エース機) → 3 面 (火星・蛍光緑の強い戦艦) → クリア。面が変わるたびに機体が直る', () => {
  const g = C.createGame({ seed: 4 });
  const seen = [], starts = {}, waves = { 2: [], 3: [] };
  let boss3 = null, aceWarn = 0, aceDown = 0, aceMax = 0, bossIn2 = false;
  run(g, 1500, (gg) => {
    for (const e of gg.events) {
      if (e.type === 'stageStart') starts[e.level] = { hull: gg.player.hull, shield: gg.player.shield, missiles: gg.player.missiles, state: gg.state, boss: gg.boss, ace: gg.ace };
      if (e.type === 'stage' && gg.level > 1) waves[gg.level].push(gg.fighters.filter((f) => !f.drone && !f.ace).length);
      if (e.type === 'clear') seen.push('clear@' + gg.level);
      if (e.type === 'aceWarning') aceWarn++;
      if (e.type === 'aceDown') aceDown++;
    }
    if (gg.ace) aceMax = Math.max(aceMax, gg.ace.maxHp);
    if (gg.level === 2 && gg.boss) bossIn2 = true;
    if (gg.level === 3 && gg.boss && !boss3) boss3 = gg.boss;
    gg.events.length = 0;
    return gg.state === 'play' ? C.autopilot(gg, 1) : {};
  }, 1 / 30);
  [2, 3].forEach((lv) => {
    const s = starts[lv];
    assert.ok(s, lv + ' 面へ進んだ');
    assert.strictEqual(s.state, 'play');
    assert.strictEqual(s.boss, null, '前の面のボスは片づく');
    assert.ok(s.hull === T.hullMax && s.shield === T.shieldMax && s.missiles === T.missileMax, lv + ' 面に入るとき機体が直る');
  });
  assert.deepStrictEqual(waves[2], [4, 4], '2 面の敵は 4 機・4 機');
  assert.deepStrictEqual(waves[3], [4, 5], '3 面の敵は 4 機・5 機 (1 面は 3 機・4 機)');
  assert.ok(!bossIn2, '2 面のボスは戦艦ではなくエース機');
  assert.strictEqual(aceWarn, 1); assert.strictEqual(aceDown, 1);
  assert.strictEqual(aceMax, T.aceHp);
  assert.ok(boss3 && boss3.level === 3, '3 面の戦艦');
  const turret = boss3.parts.find((p) => p.kind === 'turret'), core = boss3.parts.find((p) => p.kind === 'core');
  assert.strictEqual(turret.maxHp, Math.round(T.turretHp * T.boss3Hp));
  assert.strictEqual(core.maxHp, Math.round(T.coreHp * T.boss3Hp));
  assert.deepStrictEqual(seen, ['clear@3'], '1 面の戦艦・エース機ではクリアにならず、3 面の戦艦を沈めてクリア');
});

test('3 面の戦艦は 1.5 倍の大きさ: 部位の位置・当たりの大きさ・立体・主砲の位置がそろって大きくなる', () => {
  const mk = (level) => { const g = C.createGame({ seed: 1 }); g.level = level; return C.makeBoss(g); };
  const b1 = mk(1), b3 = mk(3), k = T.boss3Size;
  assert.strictEqual(b1.size, 1); assert.strictEqual(b3.size, k);
  assert.strictEqual(b3.parts.length, b1.parts.length, '砲台の数はそのまま');
  b1.parts.forEach((p, i) => {
    const q = b3.parts[i];
    assert.ok(Math.abs(q.local.x - p.local.x * k) < 1e-9 && Math.abs(q.local.z - p.local.z * k) < 1e-9, '部位の位置が k 倍');
    assert.ok(Math.abs(q.radius - p.radius * k) < 1e-9, '部位の大きさが k 倍');
  });
  // 立体: 艦首の先 (x = -360 k) の少し外は素通り、少し内は当たる
  const solidAt = (b, x) => C.bossSolids(b).some((sd) => C.pointInSolid(C.add(b.pos, C.vec(x, 0, 0)), sd.planes));
  assert.ok(solidAt(b3, -250 * k), '大きくした立体の中');
  assert.ok(!solidAt(b3, -400 * k), '艦首の先は素通り');
  assert.ok(solidAt(b3, 240 * k) && !solidAt(b1, 240 * k), '艦尾も k 倍 (1 面の艦尾 246 の先は 3 面では中)');
  assert.ok(Math.abs(b3.cannon.from.x - C.BOSS_CANNON.x * k) < 1e-9, '主砲の位置も k 倍');
});

test('エース機の強さ: 通常の敵より大きく、体力が 10 倍以上', () => {
  assert.ok(T.aceHp >= 10 * T.fighterHp, 'ふつうの敵の 10 倍以上の体力');
  assert.ok(T.aceRadius > T.fighterRadius && T.aceScale > 1.2, '大きい');
});

test('巨大戦艦から始めても、沈めたあと 2 面へ進む', () => {
  const g = C.createGame({ seed: 2, start: 'boss' });
  let first = 0;
  run(g, 420, (gg) => { for (const e of gg.events) if (e.type === 'stageStart' && !first) first = e.level; gg.events.length = 0; return gg.state === 'play' ? C.autopilot(gg, 1) : {}; }, 1 / 30);
  assert.strictEqual(first, 2, '沈めたあと 2 面 (エース機) へ進む');
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
  run(g, 1500, (gg) => { gg.events.length = 0; return gg.state === 'play' ? C.autopilot(gg, 1) : {}; }, 1 / 30);
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

test('ボス戦で何も当たらない時間が続くと、撃てる迎撃機が正面から来る。撃ってこず、しばらくで去る', () => {
  const g = C.createGame({ seed: 5, start: 'boss' });
  run(g, 1 / 60, {});
  run(g, C.BOSS_TIMING.arrive + 0.5, (gg) => { gg.fighters = []; gg.events.length = 0; return {}; });
  const b = g.boss;
  assert.notStrictEqual(b.phase, 'arrive', '戦闘が始まっている');
  g.fighters = []; g.shots = [];
  let at = null;
  run(g, T.droneLull + 0.5, (gg) => { if (at === null && gg.events.some((e) => e.type === 'drones')) at = gg.t; gg.events.length = 0; return {}; });
  assert.ok(at !== null, '迎撃機が出た');
  assert.ok(at - Math.max(b.battleT, g.lastHitT || 0) >= T.droneLull - 0.05, '当てない時間が ' + T.droneLull + ' 秒続いてから');
  const ds = g.fighters.filter((f) => f.drone);
  assert.strictEqual(ds.length, T.droneCount);
  const pl = g.player;
  for (const d of ds) {
    assert.ok(C.angleBetween(pl.dir, C.sub(d.pos, pl.pos)) < 30 * DEG, '自機の前に出る');
    assert.ok(C.dot(d.vel, pl.dir) < 0, 'こちらへ向かってくる');
  }
  const ids = new Set(ds.map((d) => d.id));
  // 迎撃機のすぐそばで生まれた敵の弾を数える (砲台の弾は除く)
  let shot = 0;
  const seen = new Set(g.shots);
  run(g, T.droneLife + 0.5, (gg) => {
    for (const s of gg.shots) {
      if (seen.has(s)) continue;
      seen.add(s);
      if (s.owner !== 'player' && gg.fighters.some((f) => ids.has(f.id) && C.dist(f.pos, s.pos) < 20)) shot++;
    }
    gg.events.length = 0; return {};
  });
  assert.ok(!g.fighters.some((f) => ids.has(f.id)), '時間が来たら去る');
  assert.strictEqual(shot, 0, '撃ってこない');
});

test('ボスはカットインのあいだ光の向こうにいて、そのあと光の中から艦首を先にゆっくり出てくる', () => {
  const BT = C.BOSS_TIMING;
  const g = C.createGame({ seed: 3 });
  for (let i = 0; i < 80 * 30 && !g.boss; i++) { C.step(g, C.autopilot(g, 0.7), 1 / 30); g.events.length = 0; }
  const b = g.boss;
  assert.ok(b, 'ボスが来ている');
  // 来たばかり: まだ見えず、狙えない。艦全体が光の向こう (+x) にある
  assert.ok(!b.shown && C.targets(g).every((t) => t.kind === 'fighter'), 'カットインの間は隠れていて狙えない');
  assert.ok(b.pos.x + BT.bow >= b.portal.x - 0.5, '艦首が光の面より向こうにある');
  assert.ok(b.portal.x > b.at.x + BT.stern, '光は止まる所の右 (+x)。止まったとき艦尾まで光の外に出ている');
  let warp = null, land = null, scrape = 0, battleAt = null, t = b.arriveT, half = null, lastX = b.pos.x, back = 0;
  const pAtWarn = Object.assign({}, g.player.pos);
  run(g, 8, (gg) => {
    for (const e of gg.events) {
      if (e.type === 'bossWarp') warp = { t: t, pos: e.pos };
      if (e.type === 'bossLand') land = t;
      if (e.type === 'scrape') scrape++;
      if (e.type === 'bossPhase' && e.phase === 'battle' && battleAt === null) battleAt = t;
    }
    gg.events.length = 0; t += 1 / 30;
    const bb = gg.boss;
    if (bb.pos.x > lastX + 1e-6) back++;
    lastX = bb.pos.x;
    if (half === null && bb.emerge >= 0.5) half = { bow: bb.pos.x + BT.bow, stern: bb.pos.x + BT.stern, portal: bb.portal.x };
    return {};
  }, 1 / 30);
  assert.ok(warp && Math.abs(warp.t - BT.delay) < 0.1, `カットインが終わる頃 (${BT.delay} 秒) に出はじめる: ${warp && warp.t.toFixed(2)}`);
  const d = C.dist(b.at, pAtWarn);
  assert.ok(d > 600 && d < 850, `近くに止まる (知らせの時の自機から ${d.toFixed(0)}m。前は約 2600m 先から来ていた)`);
  assert.ok(pAtWarn.y - b.at.y >= BT.drop - 1, '自機より下 (見下ろす形)');
  assert.ok(half && half.bow < half.portal && half.stern > half.portal, '出ている途中は、艦首は光のこちら側・艦尾はまだ光の向こう (いきなり全体が出ない)');
  assert.strictEqual(back, 0, '光から出る向き (-x) にだけ進む');
  assert.ok(land !== null && Math.abs(land - warp.t - BT.emerge) < 0.1, `${BT.emerge} 秒かけて出てきて止まる`);
  assert.ok(battleAt !== null && battleAt <= BT.arrive + 0.1, `戦闘が ${BT.arrive} 秒で始まる (前は 13 秒): ${battleAt && battleAt.toFixed(2)}`);
  assert.strictEqual(scrape, 0, '登場の間に自機とぶつからない');
});

test('ボスのワープ先は、戦う場所の外へはみ出さない', () => {
  const g = C.createGame({ seed: 1 });
  const c = T.arenaCenter;
  // 戦う場所のふちで、外を向いている
  g.player.pos = C.vec(c.x + T.arenaRadius - 100, 0, c.z);
  g.player.dir = C.vec(1, 0, 0);
  g.player.yaw = -Math.PI / 2;
  const b = C.makeBoss(g);
  const r = Math.hypot(b.at.x - c.x, b.at.z - c.z);
  assert.ok(r <= T.arenaRadius - 800 + 1, `中心から ${r.toFixed(0)}m (上限 ${T.arenaRadius - 800})`);
});
