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

test('ロックオンボタン: タップ 1 回で、押しっぱなしにしなくても、その敵へ向き続ける (追いかけ)。スティックを大きく倒すとやめる', () => {
  const g = quietGame();
  const f = fighterAhead(g, 150, 300);
  f.mode = 'hold'; f.fireCd = 99;
  C.step(g, { select: true }, 1 / 60);
  assert.ok(g.player.follow, '追いかけ中');
  let t = 0;
  while (t < 6 && C.angleBetween(g.player.dir, C.sub(f.pos, g.player.pos)) > 8 * DEG) { C.step(g, { fire: true }, 1 / 60); t += 1 / 60; }
  assert.ok(t < 4, `撃ちながら (ボタンを離したまま) 4 秒以内に向く (${t.toFixed(1)} 秒)`);
  // スティックを大きく倒すと追いかけをやめ、離しても敵へ戻らない
  run(g, 0.5, { stickX: 1 });
  assert.ok(!g.player.follow, 'スティックで追いかけをやめる');
  const before = C.angleBetween(g.player.dir, C.sub(f.pos, g.player.pos));
  run(g, 2, {});
  assert.ok(C.angleBetween(g.player.dir, C.sub(f.pos, g.player.pos)) > before - 5 * DEG, '離しても勝手には向かない');
});

test('ロックオン: 狙う相手を倒したら、次の敵を自動では選ばない (追いかけも止まる)。次の波が出ても選ばない', () => {
  const g = C.createGame({ seed: 3 });
  g.events.length = 0;
  C.step(g, { select: true }, 1 / 30);
  assert.ok(g.player.targetId && g.player.follow);
  // 第 1 波を消す → 選びも追いかけも止まる。第 2 波が出ても、自分で押すまで選ばない
  run(g, 0.5, (gg) => { gg.fighters.forEach((f) => { f.alive = false; }); return {}; }, 1 / 30);
  assert.ok(!g.player.targetId && !g.player.follow, '倒したら選びも追いかけも止まる');
  run(g, 6, {}, 1 / 30);
  assert.ok(g.fighters.some((f) => f.alive), '第 2 波');
  assert.ok(!g.player.targetId && !g.player.follow, '第 2 波の敵を勝手に選ばない');
  C.step(g, { select: true }, 1 / 30);
  assert.ok(g.player.targetId && g.player.follow, 'もう一度押せば選んで追いかける');
});

test('ロックオンの追いかけでボスの部位を追っても、船体へ突っ込んでこすり続けない (子どもの操作: LOCK 1 回 + 撃ちっぱなし)', () => {
  let scrapes = 0;
  for (let seed = 1; seed <= 4; seed++) {
    const g = C.createGame({ seed: seed, start: 'boss' });
    run(g, 14, {}, 1 / 30);
    g.fighters = [];
    C.step(g, { select: true }, 1 / 30);
    run(g, 40, (gg) => { for (const e of gg.events) if (e.type === 'scrape') scrapes++; gg.events.length = 0; return gg.state === 'play' ? { fire: true } : {}; }, 1 / 30);
  }
  assert.ok(scrapes <= 8, `4 通り x 40 秒でこすったのは ${scrapes} 回 (よけないと 30 回以上)`);
});

test('ロックオンボタン: 狙う相手を倒すと選びが外れる。押し直すと次の敵を選び、円の外でも偏差の印が出る', () => {
  const g = quietGame();
  const a = fighterAhead(g, 0, 250);
  const b = fighterAhead(g, 60, 300);
  [a, b].forEach((f) => { f.mode = 'hold'; f.fireCd = 99; });
  C.step(g, { select: true }, 1 / 60);
  assert.strictEqual(g.player.targetId, a.id);
  // 追いかけを止めて、向きを変えずに撃つ (60° 横の b へ向かないように)
  g.player.follow = false;
  run(g, 1.2, { fire: true });
  assert.strictEqual(a.alive, false, '撃墜');
  assert.strictEqual(g.player.targetId, 0, '次の敵へは移らない');
  C.step(g, { select: true }, 1 / 60);
  assert.strictEqual(g.player.targetId, b.id, '押し直すと次の敵');
  // 印 (focus) は次のコマの照準の計算で付く (選ぶのは照準の計算のあと)
  g.player.follow = false;
  C.step(g, {}, 1 / 60);
  assert.ok(g.player.focus && g.player.focus.target === b, `60° 横でも狙う相手に偏差の印が出る`);
});

test('ボスを沈めたら、次の面へ移る少し前に暗転の知らせ (stageOut) が出て、そのあと次の面が始まる', () => {
  const g = C.createGame({ seed: 6 });
  g.fighters = []; g.stage = 'test';
  g.boss = C.makeBoss(g); g.boss.phase = 'dead';
  g.state = 'ending'; g.endT = 0;
  let outT = -1, startT = -1;
  run(g, T.bossEndWait + 0.5, (gg) => {
    for (const e of gg.events) { if (e.type === 'stageOut' && outT < 0) outT = gg.endT; if (e.type === 'stageStart' && startT < 0) startT = gg.t; }
    gg.events.length = 0; return {};
  }, 1 / 30);
  assert.ok(outT > 0, '暗転の知らせが出る');
  assert.ok(Math.abs(outT - (T.bossEndWait - T.stageOutLead)) < 0.1, `次の面の ${T.stageOutLead} 秒前 (${outT.toFixed(2)})`);
  assert.strictEqual(g.level, 2);
});

test('1 面の補給船団: 第1波のあと輸送船が護衛機と来て、途中で後ろから増援。残りは時間でワープして逃げ、落とした数だけ戦艦の砲台が減る', () => {
  const g = C.createGame({ seed: 3 });
  g.fighters = [];
  const ev = [];
  const grab = (gg) => { gg.events.forEach((e) => ev.push(e)); gg.events.length = 0; return {}; };
  run(g, 3, grab, 1 / 30);
  assert.strictEqual(g.stage, 'convoy', '第1波のあとは補給船団');
  const ships = g.fighters.filter((f) => f.transport), escorts = g.fighters.filter((f) => f.guard);
  assert.strictEqual(ships.length, T.convoyCount);
  assert.strictEqual(escorts.length, T.convoyEscorts);
  assert.ok(ev.some((e) => e.type === 'convoy'), '知らせが出る');
  // 輸送船は自機より遅く、まっすぐ進む。護衛機は輸送船の横に付き、自機が遠いうちは撃たない
  const p0 = Object.assign({}, ships[0].pos);
  g.player.pos = C.add(ships[0].pos, C.vec(0, 900, 0));   // 遠くに置く (近づかない)
  const shots0 = g.shots.length;
  run(g, 5, (gg) => { gg.player.pos = C.add(gg.fighters.find((f) => f.transport).pos, C.vec(0, 900, 0)); return grab(gg); }, 1 / 30);
  const moved = C.dist(p0, ships[0].pos);
  assert.ok(moved > T.convoySpeed * 4 && moved < T.convoySpeed * 6, `輸送船は ${T.convoySpeed}m/s で進む (5 秒で ${moved.toFixed(0)}m)`);
  assert.ok(escorts.every((e) => e.mode === 'guard'), '自機が遠いうちは、護衛機は輸送船の横に付いたまま');
  assert.strictEqual(g.shots.filter((s) => s.owner === 'enemy').length, 0, '遠いうちは誰も撃たない');
  assert.ok(escorts.every((e) => C.dist(e.pos, g.fighters.find((f) => f.id === e.guard).pos) < 120), '護衛機は輸送船のそばにいる');
  // 3 隻を落とす (体力を少しにして、輸送船を貫く自機の弾を置く。撃墜の道すじをそのまま通す)
  assert.ok(!g.convoy.reinforced, 'まだ増援は来ていない');
  ships.slice(0, 3).forEach((s) => { s.hp = 0.01; g.shots.push({ owner: 'player', pos: C.add(s.pos, C.scale(s.dir, 2)), prev: C.add(s.pos, C.scale(s.dir, -40)), vel: C.scale(s.dir, -600), life: 1, dmg: 5, dead: false }); });
  run(g, 0.2, grab, 1 / 60);
  assert.strictEqual(g.convoy.down, 3, '3 隻落とした');
  assert.ok(ev.some((e) => e.type === 'reinforce'), '輸送船を落とすと、後ろから増援が来る');
  // 時間が来ると残りの 1 隻はワープで逃げる。敵機を片づけると結果が出る
  run(g, T.convoyTime + 1, (gg) => { gg.fighters = gg.fighters.filter((f) => f.transport); return grab(gg); }, 1 / 30);
  const res = ev.find((e) => e.type === 'convoyResult');
  assert.ok(ev.some((e) => e.type === 'convoyWarn'), 'ワープの 10 秒前に知らせ');
  assert.ok(ev.some((e) => e.type === 'transportEscape'), '残りは逃げる');
  assert.ok(res && res.down === 3 && res.escaped === 1 && res.turrets === 3, `結果: 3 撃破・1 逃走・砲台 3 基減 (${JSON.stringify(res)})`);
  // 戦艦は砲台が 3 つ壊れた状態で来る
  run(g, T.convoyResultWait + 1, grab, 1 / 30);
  assert.ok(g.boss && g.boss.type === 'battleship');
  const tur = g.boss.parts.filter((p) => p.kind === 'turret');
  assert.strictEqual(tur.filter((p) => !p.alive && p.preDestroyed).length, 3, '落とした数だけ砲台が壊れている');
  assert.strictEqual(tur.filter((p) => p.alive).length, tur.length - 3);
});

test('補給船団は 1 面だけ。「巨大戦艦から」と、面のやり直しでは砲台は全部そろう', () => {
  const g2 = C.createGame({ seed: 4, start: 'stage', level: 2 });
  run(g2, T.stageIntro + 0.5, {}, 1 / 30);
  g2.fighters = [];
  run(g2, 3, (gg) => { gg.events.length = 0; return {}; }, 1 / 30);
  assert.strictEqual(g2.stage, 'wave2', '2 面の第2波はふつうの編隊');
  const gb = C.createGame({ seed: 5, start: 'boss' });
  run(gb, 0.1, {}, 1 / 30);
  assert.ok(gb.boss.parts.filter((p) => p.kind === 'turret').every((p) => p.alive), '巨大戦艦から始めると、砲台は全部ある');
  // 補給船団を落とした回でも、負けて続けると砲台は全部ある (やり直しの面では、もう一度補給船団から)
  const g = C.createGame({ seed: 6 });
  g.convoy = { total: 4, down: 4, escaped: 0, t: 0, done: true };
  g.player.alive = false; g.state = 'over';
  const c = C.continueGame(g, 9);
  assert.ok(!c.convoy, 'やり直しでは補給船団の結果は残らない');
});

test('負けたら、その面の始まりから続けられる: 機体は直り、成績はその面を始めたときに戻り、続けた回数が残る', () => {
  const g = C.createGame({ seed: 5 });
  g.stats.score = 1234; g.stats.kills = 9;
  // 1 面の戦艦を沈めて 2 面へ進んだことにする (面を始めたときの成績を覚える)
  g.fighters = []; g.stage = 'test';
  g.boss = C.makeBoss(g); g.boss.phase = 'dead';
  g.state = 'ending'; g.endT = 99;
  C.step(g, {}, 1 / 30);     // 1 面 → 2 面へ (startStage)
  assert.strictEqual(g.level, 2);
  g.stats.score += 500; g.player.hull = 0; g.player.alive = false; g.state = 'over';
  const c = C.continueGame(g, 77);
  assert.strictEqual(c.level, 2, '負けた面から');
  assert.strictEqual(c.state, 'play');
  assert.strictEqual(c.stage, 'intro', '面の始まりの間から');
  assert.ok(c.events.some((e) => e.type === 'stageStart' && e.level === 2), '面の札が出る');
  assert.ok(c.player.alive && c.player.hull === T.hullMax && c.player.shield === T.shieldMax, '機体は直る');
  assert.strictEqual(c.stats.score, 1234, '負けた面の点は数えない (面を始めたときの点に戻る)');
  assert.strictEqual(c.stats.kills, 9);
  assert.strictEqual(C.result(c).continues, 1);
  // 間のあとに 2 面の第 1 波が出る
  run(c, T.stageIntro + 0.5, {}, 1 / 30);
  assert.strictEqual(c.fighters.filter((f) => f.alive).length, 4, '2 面の第 1 波 (4 機)');
  // もう一度負けて続けると 2 回
  c.state = 'over';
  assert.strictEqual(C.result(C.continueGame(c)).continues, 2);
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
  // 2 面のボスはエース機。ボス戦として、知らせのあとワープの間をおいて護衛機と現れる。落とすと 3 面へ進む
  g.stage = 'gap2'; g.stageTimer = 99; g.fighters = [];
  const ev2 = [];
  run(g, 1, (gg) => { gg.events.forEach((e) => ev2.push(e.type)); gg.events.length = 0; return {}; });
  assert.ok(ev2.includes('aceWarning') && !g.ace && g.stage === 'aceIn', '知らせのあいだは、まだ現れない');
  run(g, 2, (gg) => { gg.events.forEach((e) => ev2.push(e.type)); gg.events.length = 0; return {}; });
  assert.ok(ev2.includes('aceWarp') && g.ace && g.ace.alive && g.stage === 'ace', 'ワープの間のあとに現れる');
  assert.strictEqual(g.fighters.filter((f) => !f.ace && f.alive).length, T.aceEscorts, '護衛機を連れてくる');
  assert.strictEqual(g.boss, null, '2 面に戦艦はいない');
  g.ace.hp = 0.1; g.ace.pos = C.add(g.player.pos, C.vec(0, 0, -60));
  for (let i = 0; i < 90 && g.ace.alive; i++) { g.ace.pos = C.add(g.player.pos, C.vec(0, 0, -60)); C.step(g, { fire: true, throttle: 0 }, 1 / 30); }
  assert.strictEqual(g.stage, 'aceDown');
  assert.strictEqual(g.fighters.filter((f) => f.alive).length, 0, 'エース機を落とすと、残った護衛機も片づく (暗転とワープのあいだに撃たれない)');
  assert.strictEqual(g.shots.filter((s) => s.owner !== 'player').length, 0, '敵の弾も消える');
  run(g, T.aceDownDelay + 1, (gg) => { gg.fighters = []; return {}; });
  assert.strictEqual(g.level, 3);
  // 3 面の採掘母艦まで飛ばして、同じ順で沈めると 4 面へ
  g.stage = 'gap2'; g.stageTimer = 99; g.fighters = [];
  run(g, 14, (gg) => { gg.fighters = []; return {}; });
  assert.strictEqual(g.boss.level, 3);
  assert.strictEqual(g.boss.type, 'driller');
  assert.strictEqual(g.boss.phase, 'battle');
  for (const k of ['turret', 'engine', 'core']) { killParts(g, k); run(g, 0.1, {}); }
  assert.strictEqual(g.boss.phase, 'dying');
  run(g, 15, {});
  assert.strictEqual(g.state, 'play', '3 面の採掘母艦でも終わらず、4 面へ進む');
  assert.strictEqual(g.level, 4);
  // 4 面の木星要塞も同じ順で沈めると 5 面へ。5 面 (冥王星) のハデスを沈めるとクリア
  g.stage = 'gap2'; g.stageTimer = 99; g.fighters = [];
  run(g, 14, (gg) => { gg.fighters = []; return {}; });
  assert.strictEqual(g.boss.type, 'fortress');
  assert.strictEqual(g.boss.phase, 'battle');
  for (const k of ['turret', 'engine', 'core']) { killParts(g, k); run(g, 0.1, {}); }
  assert.strictEqual(g.boss.phase, 'dying');
  run(g, 15, {});
  assert.strictEqual(g.state, 'play', '4 面の木星要塞でも終わらず、5 面へ進む');
  assert.strictEqual(g.level, 5);
  g.stage = 'gap2'; g.stageTimer = 99; g.fighters = [];
  run(g, 14, (gg) => { gg.fighters = []; return {}; });
  assert.strictEqual(g.boss.type, 'hades');
  assert.strictEqual(g.boss.phase, 'battle');
  for (const k of ['turret', 'engine', 'core']) { killParts(g, k); run(g, 0.1, {}); }
  assert.strictEqual(g.boss.phase, 'dying');
  run(g, 15, {});
  assert.strictEqual(g.boss.phase, 'dead');
  assert.strictEqual(g.state, 'clear');
});

function hadesGame() {
  const g = C.createGame({ seed: 7, start: 'boss', level: 5 });
  run(g, 14, {});
  g.fighters = [];
  return g;
}
// 自機を、ある点からある点へ向けて置き、弾を 1 発その向きに置く
function shootAt(g, from, to) {
  const d = C.norm(C.sub(to, from));
  g.player.pos = from;
  g.shots.push({ owner: 'player', pos: C.add(from, C.scale(d, 2)), prev: from, vel: C.scale(d, T.laserSpeed), life: 3, dmg: 1, dead: false });
}

test('5 面のハデス: バリア (膜) があるうちはコアに弾が届かない。スラスター 5 つを壊すとバリアが消え、コアに効く', () => {
  const g = hadesGame();
  assert.strictEqual(g.boss.type, 'hades');
  const core = g.boss.parts.find((p) => p.kind === 'core');
  assert.strictEqual(g.boss.parts.filter((p) => p.kind === 'turret').length, 10, '砲台 10');
  assert.strictEqual(g.boss.parts.filter((p) => p.kind === 'engine').length, 5, 'スラスター (バリア発生器) 5');
  // 横 (+z) の開口から撃つ: バリアの膜に当たって止まる
  const hp0 = core.hp;
  for (let i = 0; i < 10; i++) { shootAt(g, C.add(core.pos, C.vec(0, 0, 200)), core.pos); run(g, 0.5, {}); }
  assert.strictEqual(core.hp, hp0, 'バリアがあるうちは効かない');
  killParts(g, 'turret'); run(g, 0.1, {});
  assert.strictEqual(g.boss.phase, 'weak');
  killParts(g, 'engine'); run(g, 0.1, {});
  assert.strictEqual(g.boss.phase, 'core');
  assert.strictEqual(g.boss.armor, false, 'スラスターを全部壊すとバリアが消える');
  shootAt(g, C.add(core.pos, C.vec(0, 0, 200)), core.pos); run(g, 0.5, {});
  assert.ok(core.hp < hp0, `むき出しのコアに効く (${core.hp} / ${hp0})`);
  // 反対の開口 (-z) からも撃てる
  const hp1 = core.hp;
  shootAt(g, C.add(core.pos, C.vec(0, 0, -200)), core.pos); run(g, 0.5, {});
  assert.ok(core.hp < hp1, '反対側からも効く');
});

test('5 面のハデス: コアの向き (構える所) は自機のいる側。主砲は自分の船体ごしには撃たない', () => {
  const g = hadesGame();
  const b = g.boss, core = b.parts.find((p) => p.kind === 'core');
  g.player.pos = C.add(core.pos, C.vec(0, 50, -400)); run(g, 0.05, {});
  assert.ok(core.face.z < 0, 'コアの向きは -z (自機の側)');
  g.player.pos = C.add(core.pos, C.vec(0, 50, 400)); run(g, 0.05, {});
  assert.ok(core.face.z > 0, 'コアの向きは +z (自機の側)');
  // 艦尾の真後ろ (+x): 艦首の砲から見ると船体の陰。溜め始めない
  killParts(g, 'turret'); run(g, 0.1, {});
  const behind = C.add(b.pos, C.vec(900, 0, 0));
  b.cannon.state = 'idle'; b.cannon.next = 0;
  run(g, 3, (gg) => { gg.player.pos = behind; gg.player.alive = true; return {}; });
  assert.strictEqual(b.cannon.state, 'idle', '船体の陰では主砲を溜めない');
  // 艦首の前 (-x) へ出ると溜め始める
  run(g, 1, (gg) => { gg.player.pos = C.add(gg.boss.pos, C.vec(-1200, 0, 0)); return {}; });
  assert.notStrictEqual(b.cannon.state, 'idle', '射線が通れば溜める');
});

test('5 面のハデス: コアがむき出しになると、リングの左右の開口から遅い紫の弾を全方位へ撒く', () => {
  const g = hadesGame();
  killParts(g, 'turret'); run(g, 0.1, {}); killParts(g, 'engine'); run(g, 0.1, {});
  assert.strictEqual(g.boss.phase, 'core');
  g.player.pos = C.add(g.boss.pos, C.vec(0, 0, 900));
  g.boss.burstCd = 0.05;
  let ev = null;
  run(g, 0.2, (gg) => { gg.player.pos = C.add(gg.boss.pos, C.vec(0, 0, 900)); for (const e of gg.events) if (e.type === 'coreBurst') ev = e; gg.events.length = 0; return {}; });
  const shots = g.shots.filter((s) => s.src === 'burst');
  assert.ok(ev && ev.n === T.hadesBurstN, `一度に ${T.hadesBurstN} 発 (${ev && ev.n})`);
  assert.strictEqual(shots.length, T.hadesBurstN);
  assert.ok(shots.every((s) => Math.abs(s.vel.z) / C.len(s.vel) >= 0.45 - 1e-9), 'どの弾もリングの開口 (横 ±z) から出る向き');
  assert.ok(shots.some((s) => s.vel.z > 0) && shots.some((s) => s.vel.z < 0), '左右の両方へ');
  assert.ok(shots.every((s) => Math.abs(C.len(s.vel) - T.hadesBurstSpeed) < 1e-6 && T.hadesBurstSpeed < T.turretShotSpeed), '砲台の弾より遅い (よけられる)');
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

test('上手な自動操縦は、8通りの始め方のうち7つ以上で 5 面の最後まで勝てる', () => {
  let cleared = 0;
  const times = [];
  for (let seed = 1; seed <= 8; seed++) {
    const g = C.createGame({ seed: seed });
    run(g, 2600, (gg) => { gg.events.length = 0; return gg.state === 'play' ? C.autopilot(gg, 1) : {}; }, 1 / 30);
    if (g.state === 'clear') { cleared++; times.push(Math.round(g.stats.time)); }
  }
  assert.ok(cleared >= 7, `勝てたのは ${cleared}/8 (${times.join(', ')} 秒)`);
  assert.ok(Math.max.apply(null, times) < 1800, 'どれも 5 面あわせて 30 分以内');
});

test('5 面の流れ: 1 面の戦艦 → 2 面 (水星・エース機) → 3 面 (火星・採掘母艦) → 4 面 (木星要塞) → 5 面 (冥王星・ハデス) → クリア。面が変わるたびに機体が直る', () => {
  const g = C.createGame({ seed: 4 });
  const seen = [], starts = {}, waves = { 2: [], 3: [], 4: [], 5: [] };
  let boss3 = null, boss4 = null, boss5 = null, aceWarn = 0, aceDown = 0, aceMax = 0, bossIn2 = false;
  run(g, 3000, (gg) => {
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
    if (gg.level === 4 && gg.boss && !boss4) boss4 = gg.boss;
    if (gg.level === 5 && gg.boss && !boss5) boss5 = gg.boss;
    gg.events.length = 0;
    return gg.state === 'play' ? C.autopilot(gg, 1) : {};
  }, 1 / 30);
  [2, 3, 4, 5].forEach((lv) => {
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
  assert.ok(boss3 && boss3.level === 3 && boss3.type === 'driller', '3 面は火星の採掘母艦');
  assert.ok(boss4 && boss4.type === 'fortress' && boss4.level === 4, '4 面は木星要塞');
  assert.strictEqual(waves[4].length, 2, '4 面も第1波・第2波');
  assert.ok(boss5 && boss5.type === 'hades' && boss5.level === 5, '5 面は冥王星のハデス');
  assert.deepStrictEqual(waves[5], [5, 7], '5 面の敵は 5 機・7 機');
  assert.deepStrictEqual(seen, ['clear@5'], '4 面の木星要塞まではクリアにならず、5 面のハデスを沈めてクリア');
});

test('3 面の採掘母艦: 1 面の戦艦とは形が違う (前にドリル・縦に高い塔)。砲台 7・鉱石タンク 4・動力炉は装甲の輪の中', () => {
  const mk = (level) => { const g = C.createGame({ seed: 1 }); g.level = level; return C.makeBoss(g); };
  const b1 = mk(1), b3 = mk(3);
  assert.strictEqual(b1.type, 'battleship'); assert.strictEqual(b3.type, 'driller');
  const count = (b, k) => b.parts.filter((p) => p.kind === k).length;
  assert.strictEqual(count(b3, 'turret'), 7); assert.strictEqual(count(b3, 'engine'), 4); assert.strictEqual(count(b3, 'core'), 1);
  assert.strictEqual(b3.parts.find((p) => p.kind === 'engine').maxHp, Math.round(T.engineHp * T.drillTankHp));
  // 外形: 大きさ (外接する箱) を比べる。採掘母艦は背が高く (塔)、前に長い (ドリル)
  const box = (b) => {
    let mn = C.vec(1e9, 1e9, 1e9), mx = C.vec(-1e9, -1e9, -1e9);
    C.bossSolids(b).forEach((sd) => { mn = C.vec(Math.min(mn.x, sd.min.x), Math.min(mn.y, sd.min.y), Math.min(mn.z, sd.min.z)); mx = C.vec(Math.max(mx.x, sd.max.x), Math.max(mx.y, sd.max.y), Math.max(mx.z, sd.max.z)); });
    return { h: mx.y - mn.y, l: mx.x - mn.x, w: mx.z - mn.z, top: mx.y - b.pos.y, bow: mn.x - b.pos.x };
  };
  const s1 = box(b1), s3 = box(b3);
  assert.ok(s3.h > 2.5 * s1.h, `背の高さ 1 面 ${s1.h.toFixed(0)}m / 3 面 ${s3.h.toFixed(0)}m`);
  assert.ok(s3.h / s3.l > 0.4 && s1.h / s1.l < 0.25, '横から見た縦横の比がはっきり違う');
  // ドリルの先 (艦首の少し内側) は当たり、その先は素通り
  const inside = (b, p) => C.bossSolids(b).some((sd) => C.pointInSolid(p, sd.planes));
  assert.ok(inside(b3, C.add(b3.pos, C.vec(C.DRILLER.bow + 60, 0, 0))), 'ドリルの先の近くは当たる');
  assert.ok(!inside(b3, C.add(b3.pos, C.vec(C.DRILLER.bow - 20, 0, 0))), 'ドリルの先より前は素通り');
  assert.ok(Math.abs(b3.cannon.from.x - C.DRILLER.cannon.x) < 1e-9 && C.DRILLER.cannon.x < C.DRILLER.bow, '主砲はドリルの先から撃つ');
  // 動力炉 (コア) は装甲の輪にすっぽり包まれ、装甲が外れると、どの立体の中にもない (撃てる)
  const core = b3.parts.find((p) => p.kind === 'core');
  const sides = [C.vec(0, 1, 0), C.vec(0, 0, 1), C.vec(0, 0, -1), C.vec(-1, 0, 0)];
  assert.ok(sides.every((d) => inside(b3, C.add(core.pos, C.scale(d, core.radius)))), '装甲があるうちは、コアのまわりはどこも装甲の中');
  b3.armor = false;
  assert.ok(!inside(b3, C.add(core.pos, C.vec(0, core.radius, 0))) && !inside(b3, core.pos), '装甲が外れるとコアの上は空く');
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

// ------------------------------------------------------------ 4 面: 木星要塞

function fortGame() {
  const g = C.createGame({ seed: 3, level: 4, start: 'boss' });
  run(g, 14, {}, 1 / 30);
  g.fighters = [];
  return g;
}

test('木星要塞: 球と輪の要塞。砲塔 12・エンジン 4・コア 1・主砲があり、戦艦とは型が違う', () => {
  const g = fortGame();
  const b = g.boss;
  assert.strictEqual(b.type, 'fortress'); assert.strictEqual(b.level, 4);
  const count = (k) => b.parts.filter((p) => p.kind === k).length;
  assert.strictEqual(count('turret'), 12); assert.strictEqual(count('engine'), 4); assert.strictEqual(count('core'), 1);
  assert.strictEqual(b.parts.find((p) => p.kind === 'turret').maxHp, T.fortTurretHp);
  assert.strictEqual(b.parts.find((p) => p.kind === 'core').maxHp, T.fortCoreHp);
  assert.ok(b.cannon && b.cannon.from, '主砲');
  // 立体の数は戦艦より桁違いに多い (球の板・輪の殻・砲塔の台)
  const sb = C.makeBoss(Object.assign(C.createGame({ seed: 3, level: 1 }), { level: 1 }));
  assert.ok(C.bossSolids(b).length > 4 * C.bossSolids(sb).length);
  assert.ok(C.BOSS_TYPES.fortress.name !== C.BOSS_TYPES.battleship.name);
});

test('木星要塞: 中心の球は撃てる (弾が止まる)。向きを変えても球は中心のまわりのまま、部位は向きに合わせて回る', () => {
  const g = fortGame();
  const b = g.boss;
  const inside = (p) => C.bossSolids(b).some((sd) => C.pointInSolid(p, sd.planes));
  for (const rot of [0, 1.1, -2.4]) {
    b.rot = rot;
    for (const d of [C.vec(1, 0, 0), C.vec(0, 1, 0), C.vec(0, 0, -1), C.vec(0.6, 0.6, 0.5)]) {
      const u = C.norm(d);
      assert.ok(inside(C.add(b.pos, C.scale(u, 100))), '球の内側は当たる rot=' + rot);
      assert.ok(!inside(C.add(b.pos, C.scale(u, 700))), '遠くは素通り');
    }
  }
  // 部位の位置は、艦の向きで回した local
  b.rot = 0.9;
  run(g, 0.05, {});
  const c = Math.cos(b.rot), sn = Math.sin(b.rot);
  b.parts.forEach((p) => {
    const lx = p.local.x, lz = p.local.z;
    assert.ok(Math.abs((p.pos.x - b.pos.x) - (c * lx + sn * lz)) < 1 && Math.abs((p.pos.z - b.pos.z) - (-sn * lx + c * lz)) < 1, '部位が艦と一緒に回る');
  });
});

test('木星要塞: 自分の方を向いていないと主砲を溜めない', () => {
  const g = fortGame();
  const b = g.boss;
  b.parts.filter((p) => p.kind === 'turret').forEach((p) => { p.hp = 0; p.alive = false; });
  b.rot = Math.PI;   // 主砲は -x 側 → 背を向ける
  g.player.pos = C.vec(b.pos.x - 10, b.pos.y, b.pos.z + 700);
  b.cannon.next = 0;
  let charged = false;
  run(g, 3, (gg) => { if (gg.boss.cannon.state !== 'idle') charged = true; gg.player.pos = C.vec(b.pos.x - 10, b.pos.y, b.pos.z + 700); return {}; }, 1 / 30);
  assert.ok(['cannon', 'weak', 'core'].includes(b.phase), '主砲を撃てる段階 ' + b.phase);
  assert.ok(!charged, '背を向けている間は主砲を溜めない');
  // 向き直れば溜め始める
  b.rot = 0;
  run(g, 1, (gg) => { if (gg.boss.cannon.state !== 'idle') charged = true; gg.player.pos = C.vec(b.pos.x - 400, b.pos.y, b.pos.z + 10); return {}; }, 1 / 30);
  assert.ok(charged, '向き直れば溜める');
});

test('5 面の成績: 腕前の線は 3.9 倍 (5 面まで遊ぶと 62400 点で S)。4 面までなら 3 倍', () => {
  const mk5 = (score) => { const g = C.createGame({ seed: 1 }); g.level = 5; g.state = 'clear'; g.stats.score = score; g.stats.time = 5000; g.player.hull = 0; return C.result(g); };
  assert.strictEqual(mk5(62000).rank, 'A');
  assert.strictEqual(mk5(63000).rank, 'S');
  assert.strictEqual(mk5(46000).rank, 'B');
  const mk = (score) => { const g = C.createGame({ seed: 1 }); g.level = 4; g.state = 'clear'; g.stats.score = score; g.stats.time = 5000; g.player.hull = 0; return C.result(g); };
  assert.strictEqual(mk(47000).rank, 'A');
  assert.strictEqual(mk(49000).rank, 'S');
  assert.strictEqual(mk(30000).rank, 'B');
});
