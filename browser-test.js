/*
 * ブラウザで実際に動かして確かめるテスト。
 *
 *   npm i -D playwright && npm run test:ui
 *
 * 本物のブラウザを立ち上げ、指の操作 (複数の指を同時に) をそのまま再現する。
 * 直した不具合には、かならず見張り役をここに置く。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const PORT = Number(process.env.PORT || 8123);
const URL = `http://localhost:${PORT}/`;
const ROOT = __dirname;
const CHROMIUM = process.env.CHROMIUM_PATH;

let passed = 0;
let failed = 0;

function ok(condition, message) {
  if (condition) {
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + message);
  } else {
    failed++;
    console.log('  \x1b[31m✗ FAIL\x1b[0m ' + message);
  }
}
function skip(message) { console.log('  \x1b[90m- とばした: ' + message + '\x1b[0m'); }
function section(name) { console.log('\n' + name); }

function waitForServer() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      http.get(URL, (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() - started > 10000) reject(new Error('サーバーが起動しない'));
          else setTimeout(tick, 100);
        });
    };
    tick();
  });
}

/**
 * 対象は iPhone 16 Plus の横向き (932x430)。playwright がその名前を知らなければ、
 * 同じ大きさの端末を自分で組み立てる (名前の決め打ちでテストが動かなくなった落とし穴)。
 */
function phoneDevice(devices, portrait) {
  const named = devices['iPhone 16 Plus' + (portrait ? '' : ' landscape')];
  const base = named || devices['iPhone 15 Plus'] || {};
  const w = portrait ? 430 : 932, h = portrait ? 932 : 430;
  return {
    userAgent: base.userAgent,
    viewport: { width: w, height: h },
    screen: { width: w, height: h },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true
  };
}

/**
 * 複数の指。CDP で触れている指の全部を毎回送る。
 * 注意: CDP は「送らなかった指」を離したことにしない (離せるのは touchEnd で全部だけ)。
 * 1本だけ離すときは、その指が押した要素へ本物と同じ pointerId で pointerup を送る。
 */
function fingers(cdp, page) {
  const active = new Map();
  const send = (type) => cdp.send('Input.dispatchTouchEvent', {
    type: type,
    touchPoints: type === 'touchEnd' ? [] : [...active.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id: id }))
  });
  return {
    async down(id, x, y) { active.set(id, { x, y }); await send(active.size === 1 ? 'touchStart' : 'touchStart'); },
    async move(id, x, y) { active.set(id, { x, y }); await send('touchMove'); },
    async up(id) {
      const p = active.get(id);
      active.delete(id);
      if (!active.size) { await send('touchEnd'); return; }
      await page.evaluate(({ x, y }) => {
        const hit = window.__downs.filter((d) => d.x === Math.round(x) && d.y === Math.round(y)).pop();
        hit.el.dispatchEvent(new PointerEvent('pointerup', { pointerId: hit.id, pointerType: 'touch', bubbles: true, clientX: x, clientY: y }));
      }, p);
    },
    async upAll() { active.clear(); await send('touchEnd'); }
  };
}

function center(r) { return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }

async function rectOf(page, sel) {
  return page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  }, sel);
}

/** ゲームの中の時計が sec 秒ぶん進むまで待つ。 */
async function waitGameTime(page, sec, timeout) {
  const t0 = await page.evaluate(() => window.__app.game().t);
  await page.waitForFunction((t) => window.__app.game().t >= t, t0 + sec, { timeout: timeout || 60000 });
}

async function run() {
  let chromium, devices;
  try {
    ({ chromium, devices } = require('playwright'));
  } catch (e) {
    console.error('playwright が必要です:  npm i -D playwright');
    process.exit(1);
  }

  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(PORT)], { stdio: 'ignore' });
  await waitForServer();

  const browser = await chromium.launch(Object.assign(
    { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    CHROMIUM ? { executablePath: CHROMIUM } : {}
  ));
  const errors = [];
  const watch = (page, name) => {
    page.on('pageerror', (e) => errors.push(name + ': ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(name + ': ' + m.text()); });
  };

  try {
    // ------------------------------------------------ 開く
    section('iPhone 16 Plus (横 932x430) で開く');
    const ctx = await browser.newContext(phoneDevice(devices, false));
    const page = await ctx.newPage();
    watch(page, '横');
    await page.goto(URL);
    await page.waitForFunction(() => window.__app && window.__app.frames() > 3);
    ok(true, 'ページが開いて、描画が回る');
    const title = await page.evaluate(() => ({
      visible: !document.getElementById('title').hidden,
      version: document.getElementById('version').textContent,
      wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tall: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      rotate: getComputedStyle(document.getElementById('rotate')).display
    }));
    ok(title.visible, 'タイトルが出る');
    ok(/^v\d+\.\d+\.\d+$/.test(title.version), `版の番号が出ている (${title.version})`);
    ok(title.wide <= 0 && title.tall <= 0, 'はみ出してスクロールしない');
    ok(title.rotate === 'none', '横向きでは「横にして」が出ない');
    await page.waitForFunction(() => ['space.jpg', 'earth.jpg', 'hull.jpg', 'logo.png', 'btn_start.png'].every((f) => window.__app.assetsLoaded()[f] !== undefined), null, { timeout: 20000 });
    const assets = await page.evaluate(() => window.__app.assetsLoaded());
    ok(assets['space.jpg'] === true && assets['earth.jpg'] === true && assets['hull.jpg'] === true, '宇宙の背景・地球・戦艦の装甲の絵が読み込まれる');
    ok(assets['logo.png'] === true && assets['btn_start.png'] === true, 'タイトルのロゴと出撃ボタンの絵が読み込まれる');
    // ロゴとメニューの板が重ならない (ロゴは左、板は右)
    const titleRects = await page.evaluate(() => {
      const r = (q) => { const b = document.querySelector(q).getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width }; };
      return { logo: r('#title .logo'), menu: r('.title-menu'), start: r('#btnStart'), tag: r('#title .title-block'), H: innerHeight };
    });
    // タイトルの機体は画面の y 74% に映す (機体の上端はおよそ 63%)。ロゴの塊の下はそれより上に収める
    ok(titleRects.tag.b <= titleRects.H * 0.6, `ロゴが機体に重ならない (ロゴの下 ${titleRects.tag.b.toFixed(0)} / 機体の上 約${(titleRects.H * 0.63).toFixed(0)})`);
    ok(titleRects.logo.r <= titleRects.menu.l - 8 && titleRects.logo.w > 300, `ロゴとメニューが重ならない (ロゴの右 ${titleRects.logo.r.toFixed(0)} / 板の左 ${titleRects.menu.l.toFixed(0)})`);
    // ロゴのふちは出撃ボタンの青緑 (送ってもらった絵ではマゼンタ)。紫〜マゼンタの色の画素が残っていない
    const logoHue = await page.evaluate(() => {
      const img = document.querySelector('#title .logo');
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let magenta = 0, teal = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 128) continue;
        const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx - mn < 0.3 * mx) continue;
        if (r > g + 30 && b > g + 30) magenta++;
        else if (g > r + 30 && b > r + 30) teal++;
      }
      return { magenta, teal };
    });
    ok(logoHue.magenta < 50 && logoHue.teal > 3000, `ロゴのふちが青緑 (マゼンタ ${logoHue.magenta} / 青緑 ${logoHue.teal} 画素)`);
    ok(titleRects.start.b - titleRects.start.t >= 44, `出撃ボタンは押せる高さ (${(titleRects.start.b - titleRects.start.t).toFixed(0)}pt)`);

    // 安全域を差し込んで、ボタンが画面に収まるか (chromium の安全域は 0 なので、まねる)
    await page.evaluate(() => {
      const s = document.documentElement.style;
      s.setProperty('--sa-l', '59px'); s.setProperty('--sa-r', '59px'); s.setProperty('--sa-b', '21px');
    });
    const titleFit = await page.evaluate(() => [...document.querySelectorAll('#title button, #title label')].every((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    }));
    ok(titleFit, '安全域を入れても、タイトルのボタンが画面に収まる');

    // タイトルの板: 中は始めるボタン 2 つだけ。設定・遊び方は下の小さなボタンから同じ板に開く
    const menuState = () => page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const panel = document.getElementById('titleMenu').getBoundingClientRect();
      return {
        buttons: [...document.querySelectorAll('#titleMenu button')].filter(vis).map((b) => b.id || b.textContent.trim()),
        toggles: [...document.querySelectorAll('#titleMenu input')].filter(vis).length,
        howto: vis(document.querySelector('#titleMenu .howto')),
        top: panel.top,
        sub: ['btnSettings', 'btnHowto'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return Math.round(r.left) + ',' + Math.round(r.top); }).join(' '),
        invert: window.__app.settings.invert
      };
    });
    const mn0 = await menuState();
    ok(mn0.buttons.join() === 'btnStart,btnBossOnly' && mn0.toggles === 0 && !mn0.howto, `タイトルの板は 出撃・巨大戦艦から の 2 つだけ (${mn0.buttons.join()} / スイッチ ${mn0.toggles})`);
    const tapEl = async (sel) => { const r = await rectOf(page, sel); await page.touchscreen.tap(center(r).x, center(r).y); await page.waitForTimeout(120); };
    await tapEl('#btnSettings');
    const mn1 = await menuState();
    ok(mn1.toggles === 3 && !mn1.buttons.includes('btnStart'), `設定を押すと、板の中がスイッチ 3 つに替わる (${mn1.toggles})`);
    await tapEl('#optInvert');
    ok((await menuState()).invert === !mn0.invert, '設定のスイッチを指で押すと切り替わる (上下反転)');
    await tapEl('#optInvert');
    await tapEl('#btnHowto');
    const mn2 = await menuState();
    ok(mn2.howto && mn2.toggles === 0, '遊び方を押すと、板の中が説明に替わる');
    ok(mn0.top === mn1.top && mn1.top === mn2.top && mn0.sub === mn1.sub && mn1.sub === mn2.sub, `中身を替えても、板の上端と下の小さなボタンが動かない (上端 ${mn0.top}/${mn1.top}/${mn2.top})`);
    await tapEl('#menuHowto [data-back]');
    const mn3 = await menuState();
    ok(mn3.buttons.join() === 'btnStart,btnBossOnly' && mn3.invert === mn0.invert, '戻るで始めるボタンの板に戻る');

    // 機体の面: 鏡にした翼が片側だけ黒く見えた不具合の見張り
    const faces = await page.evaluate(() => window.__app.flippedFaces());
    ok(faces.player.bad === 0 && faces.enemy.bad === 0 && faces.boss.bad === 0,
      `機体の面の表向きと光の向きがそろっている (自機 ${faces.player.bad}/${faces.player.total}・敵機 ${faces.enemy.bad}/${faces.enemy.total}・戦艦 ${faces.boss.bad}/${faces.boss.total} 枚が逆)`);

    // ------------------------------------------------ 出撃
    section('出撃 (ボタンを指で押す)');
    const startBtn = await rectOf(page, '#btnStart');
    await page.touchscreen.tap(center(startBtn).x, center(startBtn).y);
    await page.waitForFunction(() => window.__app.screen() === 'play');
    const playing = await page.evaluate(() => ({
      controls: !document.getElementById('controls').hidden,
      title: document.getElementById('title').hidden,
      fighters: window.__app.game().fighters.length
    }));
    ok(playing.controls && playing.title, '操作の部品が出て、タイトルが消える');
    ok(playing.fighters === 3, `第1波は 3 機 (${playing.fighters})`);
    ok(await page.evaluate(() => window.__app.skyDim() < 0.7), '遊んでいる間は背景を沈める (敵や印が埋もれないように)');

    // 操作の部品: 安全域の内側に収まり、重ならず、指で押せる大きさ
    const layout = await page.evaluate(() => {
      const ids = ['btnFire', 'btnBoost', 'btnMissile', 'btnTarget', 'btnPause'];
      const rs = ids.map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { id, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; });
      const inside = rs.every((r) => r.l >= 59 - 0.5 && r.r <= innerWidth - 59 + 0.5 && r.t >= 0 && r.b <= innerHeight - 21 + 0.5);
      let overlap = [];
      for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i], b = rs[j];
        if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) overlap.push(a.id + '/' + b.id);
      }
      const small = rs.filter((r) => Math.min(r.w, r.h) < 42).map((r) => r.id);
      return { inside, overlap, small };
    });
    ok(layout.inside, '操作の部品が安全域の内側にある');
    ok(layout.overlap.length === 0, '部品どうしが重ならない' + (layout.overlap.length ? ' (' + layout.overlap.join(', ') + ')' : ''));
    ok(layout.small.length === 0, '部品は 42pt 以上' + (layout.small.length ? ' (' + layout.small.join(', ') + ')' : ''));

    // ブースト: 煙の玉 (大きな粒) を出さず、噴射の光の筋が延びる
    await page.waitForTimeout(300);
    const jetNormal = await page.evaluate(() => window.__app.jetLength());
    await page.keyboard.down('Shift');
    await page.waitForTimeout(700);
    const boostFx = await page.evaluate(() => ({ big: window.__app.bigParticlesNear(40, 2), jet: window.__app.jetLength(), boosting: window.__app.game().player.boosting }));
    await page.keyboard.up('Shift');
    ok(boostFx.boosting && boostFx.big === 0, `ブーストで煙の玉を出さない (自機の 40m 以内の大きな粒 ${boostFx.big})`);
    ok(boostFx.jet > jetNormal * 1.6, `ブーストで噴射の光が延びる (${jetNormal.toFixed(1)} → ${boostFx.jet.toFixed(1)})`);

    const cdp = await ctx.newCDPSession(page);
    const f = fingers(cdp, page);
    const cdp0Tap = async (x, y) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 9 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    // どの指 (pointerId) がどの要素を押したかを覚えておく (1本だけ離すため)
    await page.evaluate(() => {
      window.__downs = [];
      document.addEventListener('pointerdown', (e) => {
        window.__downs.push({ id: e.pointerId, x: Math.round(e.clientX), y: Math.round(e.clientY), el: e.currentTarget === document ? e.target.closest('#btnFire,#btnBoost,#btnMissile,#btnTarget,#stickZone') : e.target });
      }, true);
    });

    // ------------------------------------------------ 連続タップで拡大しない
    section('連続タップで拡大しない (iPhone は指定を無視して拡大することがある)');
    await page.evaluate(() => {
      window.__ends = [];
      window.addEventListener('touchend', (e) => window.__ends.push(e.defaultPrevented), false);
    });
    for (const [x, y] of [[466, 150], [250, 330]]) {
      await cdp0Tap(x, y); await cdp0Tap(x, y);
    }
    const ends = await page.evaluate(() => window.__ends.splice(0));
    ok(ends.length === 4 && ends.every(Boolean), `遊んでいる間は、指を離した動作を打ち消す (${ends.join(',')})`);

    // ------------------------------------------------ スティック
    section('スティック');
    await page.bringToFront();
    const zone = await rectOf(page, '#stickZone');
    const sx = zone.x + 150, sy = zone.y + zone.height - 110;
    const yaw0 = await page.evaluate(() => window.__app.game().player.yaw);
    await f.down(1, sx, sy);
    await f.move(1, sx + 30, sy);
    await f.move(1, sx + 60, sy);
    const stick = await page.evaluate(() => ({ x: window.__app.input.stickX, y: window.__app.input.stickY }));
    ok(stick.x > 0.95 && Math.abs(stick.y) < 0.05, `右へ倒すと右いっぱい (${stick.x.toFixed(2)}, ${stick.y.toFixed(2)})`);
    await waitGameTime(page, 0.6);
    const yaw1 = await page.evaluate(() => window.__app.game().player.yaw);
    ok(yaw1 < yaw0 - 0.1, `機首が右へ回る (yaw ${yaw0.toFixed(2)} → ${yaw1.toFixed(2)})`);

    // 指をスティックの場所の外 (画面の右側) まで滑らせても、指を捕まえたまま
    await f.move(1, 700, sy - 150);
    const outside = await page.evaluate(() => ({ x: window.__app.input.stickX, y: window.__app.input.stickY }));
    ok(Math.hypot(outside.x, outside.y) > 0.95, `スティックの場所の外へ滑らせても効き続ける (${outside.x.toFixed(2)}, ${outside.y.toFixed(2)})`);
    await f.move(1, sx, sy - 60);
    const up = await page.evaluate(() => window.__app.input.stickY);
    ok(up > 0.95, `上へ倒すと機首上げ (上下反転が切のとき) (${up.toFixed(2)})`);
    await f.up(1);
    const released = await page.evaluate(() => ({ x: window.__app.input.stickX, y: window.__app.input.stickY }));
    ok(released.x === 0 && released.y === 0, '指を離すと 0 に戻る');

    // ------------------------------------------------ 同時に押す
    section('2本の指: スティックを倒しながら撃つ');
    const fire = center(await rectOf(page, '#btnFire'));
    const shots0 = await page.evaluate(() => window.__app.game().stats.shots);
    await f.down(1, sx, sy);
    await f.move(1, sx - 50, sy);
    await f.down(2, fire.x, fire.y);
    await waitGameTime(page, 0.6);
    const both = await page.evaluate(() => ({ shots: window.__app.game().stats.shots, x: window.__app.input.stickX, on: document.getElementById('btnFire').classList.contains('on') }));
    ok(both.shots - shots0 >= 5, `撃ち続ける (${both.shots - shots0} 発)`);
    ok(both.x < -0.9, 'その間もスティックが効いている');
    ok(both.on, '押している間、ボタンが光る');
    await f.up(2);
    const stillStick = await page.evaluate(() => window.__app.input.stickX);
    ok(stillStick < -0.9, '撃つ指を離しても、スティックの指はそのまま');
    await waitGameTime(page, 0.2);
    const shotsA = await page.evaluate(() => window.__app.game().stats.shots);
    await waitGameTime(page, 0.4);
    const shotsB = await page.evaluate(() => window.__app.game().stats.shots);
    ok(shotsB === shotsA, '離すと撃ち止む');
    await f.upAll();

    // ------------------------------------------------ 速さ (自動)・ブースト・ミサイル
    section('速さ (自動)・ブースト・ミサイル');
    ok(await page.evaluate(() => !document.getElementById('throttle')), 'スロットルは無い (左手はスティックだけ)');
    // スティックをいっぱいに倒すと減速して小回り、離すと戻る
    await f.down(3, sx, sy);
    await f.move(3, sx + 30, sy);
    await f.move(3, sx + 70, sy);
    await waitGameTime(page, 1.2);
    const slowed = await page.evaluate(() => window.__app.game().player.speed);
    await f.up(3);
    ok(slowed < 35, `スティックをいっぱいに倒すと減速する (${slowed.toFixed(0)} m/s)`);
    await waitGameTime(page, 1.6);
    const back = await page.evaluate(() => window.__app.game().player.speed);
    ok(back > 58, `離すと元の速さに戻る (${back.toFixed(0)} m/s)`);

    const boost = center(await rectOf(page, '#btnBoost'));
    await f.down(4, boost.x, boost.y);
    await waitGameTime(page, 1.0);
    const boosted = await page.evaluate(() => ({ speed: window.__app.game().player.speed, energy: window.__app.game().player.boost }));
    await f.up(4);
    ok(boosted.speed > 120, `ブーストで加速 (${boosted.speed.toFixed(0)} m/s)`);
    ok(boosted.energy < 80, `エネルギーが減る (${boosted.energy.toFixed(0)})`);

    const mBtn = center(await rectOf(page, '#btnMissile'));
    const m0 = await page.evaluate(() => window.__app.game().player.missiles);
    await f.down(5, mBtn.x, mBtn.y);
    await waitGameTime(page, 0.1);
    await f.up(5);
    const m1 = await page.evaluate(() => ({ n: window.__app.game().player.missiles, shown: document.getElementById('missileCount').textContent }));
    ok(m1.n === m0 - 1, `ミサイルを1発撃つ (${m0} → ${m1.n})`);
    await waitGameTime(page, 0.1);
    const shown = await page.evaluate(() => document.getElementById('missileCount').textContent);
    ok(shown === String(m1.n), `残りの数の表示も変わる (${shown})`);

    // ------------------------------------------------ ゲージ (送ってもらった絵)
    section('左上のゲージ');
    ok(await page.evaluate(() => window.__app.assetsLoaded()['gauges.png'] === true), 'ゲージの絵が読み込まれる');
    await page.evaluate(() => { const pl = window.__app.game().player; pl.shield = 30; pl.hull = 100; pl.sinceHit = 0; });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const gz = await page.evaluate(() => window.__app.hudInfo.gauges.slice());
    ok(Math.abs(gz[0] - 7) < 0.6 && Math.abs(gz[1] - 14) < 0.01, `目盛りが量どおりに光る (シールド半分 → ${gz[0] && gz[0].toFixed(1)}/14 本・機体満タン → ${gz[1] && gz[1].toFixed(1)}/14 本)`);

    // ------------------------------------------------ 計器
    section('計器');
    const reticle = await page.evaluate(() => window.__app.hudInfo.reticle);
    ok(reticle && reticle.x > 932 * 0.3 && reticle.x < 932 * 0.7 && reticle.y > 30 && reticle.y < 300,
      `照準が画面の中ほどにあり、自機に隠れない (${reticle && reticle.x.toFixed(0)}, ${reticle && reticle.y.toFixed(0)})`);

    // ------------------------------------------------ 画面の外の敵を示す三角
    section('画面の外の敵を示す三角 (どの向きでも出て、ボタンに隠れない)');
    // 止めた状態で、敵 3 機を自機のまわりの 24 方向 (真後ろ・真上・真下を含む) に置き直して写す
    await page.evaluate(() => window.__app.setPaused(true));
    await page.evaluate(() => { document.getElementById('pause').hidden = true; });
    const dirs = [];
    for (let i = 0; i < 8; i++) for (const el of [-60, 0, 60]) dirs.push([i * 45, el]);
    dirs.push([180, 0], [0, 89], [0, -89]);
    let missing = 0, hidden = 0, checked = 0;
    const hiddenAt = [];
    for (let k = 0; k < dirs.length; k += 3) {
      await page.evaluate((group) => {
        const g = window.__app.game();
        const pl = g.player;
        // 自機の向きを基準に、右へ az°・上へ el° の方向 400m に置く
        const fwd = pl.dir, up0 = { x: 0, y: 1, z: 0 };
        const right = { x: fwd.y * up0.z - fwd.z * up0.y, y: fwd.z * up0.x - fwd.x * up0.z, z: fwd.x * up0.y - fwd.y * up0.x };
        const rl = Math.hypot(right.x, right.y, right.z); right.x /= rl; right.y /= rl; right.z /= rl;
        const up = { x: right.y * fwd.z - right.z * fwd.y, y: right.z * fwd.x - right.x * fwd.z, z: right.x * fwd.y - right.y * fwd.x };
        g.fighters.forEach((f, i) => {
          const [az, el] = group[i % group.length];
          const a = az * Math.PI / 180, e = el * Math.PI / 180;
          const cf = Math.cos(a) * Math.cos(e), cr = Math.sin(a) * Math.cos(e), cu = Math.sin(e);
          f.pos = { x: pl.pos.x + (fwd.x * cf + right.x * cr + up.x * cu) * 400, y: pl.pos.y + (fwd.y * cf + right.y * cr + up.y * cu) * 400, z: pl.pos.z + (fwd.z * cf + right.z * cr + up.z * cu) * 400 };
        });
      }, dirs.slice(k, k + 3));
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const res = await page.evaluate(() => {
        const g = window.__app.game(), h = window.__app.hudInfo;
        const rects = ['btnFire', 'btnBoost', 'btnMissile', 'btnTarget', 'btnPause'].map((id) => document.getElementById(id).getBoundingClientRect());
        return g.fighters.map((f) => {
          const b = h.brackets.find((x) => x.id === f.id), a = h.arrows.find((x) => x.id === f.id);
          const under = a && rects.some((r) => a.x > r.left - 10 && a.x < r.right + 10 && a.y > r.top - 10 && a.y < r.bottom + 10);
          return { shown: !!(b || a), under: !!under, a: a ? [Math.round(a.x), Math.round(a.y)] : null };
        });
      });
      res.forEach((r, i) => {
        checked++;
        if (!r.shown) missing++;
        if (r.under) { hidden++; hiddenAt.push(JSON.stringify(dirs[k + i]) + '→' + r.a); }
      });
    }
    ok(missing === 0, `どの向きの敵にも、枠か三角が出る (${checked} 方向中 出ない ${missing})`);
    ok(hidden === 0, `三角がボタンに隠れない (${checked} 方向中 隠れた ${hidden}${hiddenAt.length ? ' ' + hiddenAt.join(' ') : ''})`);

    // ------------------------------------------------ ロックオンボタン
    section('ロックオンボタン');
    // 敵の 1 機を真横 (右 90°) に置き、ほかは遠くへ
    await page.evaluate(() => {
      const g = window.__app.game(), pl = g.player;
      g.fighters.forEach((f, i) => {
        const right = { x: -pl.dir.z, y: 0, z: pl.dir.x };
        const rl = Math.hypot(right.x, right.z);
        f.pos = i === 0 ? { x: pl.pos.x + right.x / rl * 350, y: pl.pos.y, z: pl.pos.z + right.z / rl * 350 }
          : { x: pl.pos.x - pl.dir.x * 1100, y: pl.pos.y + 300, z: pl.pos.z - pl.dir.z * 1100 };
        f.mode = 'hold'; f.fireCd = 99; f.speed = 0;
      });
      window.__app.setPaused(false);
    });
    const tgtBtn = center(await rectOf(page, '#btnTarget'));
    const before = await page.evaluate(() => ({ id: window.__app.game().fighters[0].id, ang: (() => { const g = window.__app.game(), p = g.player, f = g.fighters[0]; const v = { x: f.pos.x - p.pos.x, y: f.pos.y - p.pos.y, z: f.pos.z - p.pos.z }; const l = Math.hypot(v.x, v.y, v.z); return Math.acos((v.x * p.dir.x + v.y * p.dir.y + v.z * p.dir.z) / l) * 180 / Math.PI; })() }));
    await f.down(7, tgtBtn.x, tgtBtn.y);
    await waitGameTime(page, 0.15);
    const picked = await page.evaluate(() => window.__app.game().player.targetId);
    ok(picked === before.id, `タップで敵を選ぶ (真横の敵 ${before.id} → 選んだ ${picked})`);
    await waitGameTime(page, 1.6);
    const after = await page.evaluate(() => { const g = window.__app.game(), p = g.player, f = g.fighters.find((x) => x.id === p.targetId); const v = { x: f.pos.x - p.pos.x, y: f.pos.y - p.pos.y, z: f.pos.z - p.pos.z }; const l = Math.hypot(v.x, v.y, v.z); return Math.acos((v.x * p.dir.x + v.y * p.dir.y + v.z * p.dir.z) / l) * 180 / Math.PI; });
    await f.up(7);
    ok(after < before.ang - 40, `押しっぱなしで、その敵へ機首が向く (なす角 ${before.ang.toFixed(0)}° → ${after.toFixed(0)}°)`);
    ok(await page.evaluate(() => document.getElementById('btnTarget').classList.contains('has-target')), '敵を選んでいる間、ボタンが光る');

    // ------------------------------------------------ 一時停止
    section('一時停止');
    const pauseBtn = center(await rectOf(page, '#btnPause'));
    await page.touchscreen.tap(pauseBtn.x, pauseBtn.y);
    await page.waitForFunction(() => window.__app.paused());
    const tP = await page.evaluate(() => window.__app.game().t);
    await page.waitForTimeout(500);
    const tP2 = await page.evaluate(() => window.__app.game().t);
    ok(tP2 === tP, '止めている間、時間が進まない');
    ok(await page.evaluate(() => !document.getElementById('pause').hidden), '一時停止の画面が出る');
    ok(/v\d/.test(await page.evaluate(() => document.getElementById('diag').textContent)), '一時停止の画面に版の番号が出る');
    const resume = center(await rectOf(page, '#btnResume'));
    await page.touchscreen.tap(resume.x, resume.y);
    await waitGameTime(page, 0.2);
    ok(!(await page.evaluate(() => window.__app.paused())), '再開すると進む');

    // アプリを切り替えたら止まる。ヘッドレスでは visibilitychange が来ないので、自分で送る
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    ok(await page.evaluate(() => window.__app.paused()), '画面が隠れたら一時停止する');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      window.__app.setPaused(false);
    });

    // ------------------------------------------------ 音
    section('音');
    await f.down(6, fire.x, fire.y);
    await waitGameTime(page, 0.3);
    const level = await page.evaluate(() => window.__app.audioLevel());
    await f.up(6);
    if (!level) skip('このブラウザでは音を測れない');
    else ok(level.max > 0.005 && level.max < 1.0, `撃つと音が鳴り、割れない (最大 ${level.max.toFixed(3)})`);

    // ------------------------------------------------ 負け → 結果
    section('撃墜されたとき');
    await page.evaluate(() => {
      const g = window.__app.game();
      const pl = g.player;
      g.fighters = [];
      pl.shield = 0; pl.hull = 1;
      const p = { x: pl.pos.x + pl.dir.x * 15, y: pl.pos.y + pl.dir.y * 15, z: pl.pos.z + pl.dir.z * 15 };
      g.shots.push({ owner: 'enemy', pos: p, prev: p, vel: { x: -pl.dir.x * 300, y: -pl.dir.y * 300, z: -pl.dir.z * 300 }, life: 1, dmg: 5, dead: false });
    });
    await page.waitForFunction(() => window.__app.screen() === 'result', null, { timeout: 60000 });
    const lost = await page.evaluate(() => ({ head: document.getElementById('resultHead').textContent, rank: document.getElementById('resultRank').textContent, controls: document.getElementById('controls').hidden }));
    ok(lost.head === 'MISSION FAILED' && lost.rank === '—', `負けの結果が出る (${lost.head})`);
    ok(lost.controls, '結果の画面では操作の部品を隠す');

    // ------------------------------------------------ 巨大戦艦 → 勝ち
    section('巨大戦艦から → 撃沈 → 結果');
    const toTitle = center(await rectOf(page, '#btnResultTitle'));
    await page.touchscreen.tap(toTitle.x, toTitle.y);
    await page.waitForFunction(() => window.__app.screen() === 'title');
    const bossBtn = center(await rectOf(page, '#btnBossOnly'));
    await page.touchscreen.tap(bossBtn.x, bossBtn.y);
    await page.waitForFunction(() => window.__app.game() && window.__app.game().boss);
    await page.evaluate(() => { window.__app.game().boss.arriveT = 12.9; });
    await page.waitForFunction(() => window.__app.game().boss.phase === 'battle', null, { timeout: 30000 });
    const kill = async (kind) => {
      await page.evaluate((k) => {
        window.__app.game().boss.parts.forEach((p) => { if (p.kind === k) { p.hp = 0; p.alive = false; } });
        window.__app.game().fighters = [];
      }, kind);
      await waitGameTime(page, 0.1);
    };
    await kill('turret');
    ok(await page.evaluate(() => window.__app.game().boss.phase === 'weak'), '砲台を全部こわすと、エンジンが弱点になる');
    await kill('engine');
    ok(await page.evaluate(() => window.__app.game().boss.phase === 'core'), 'エンジンをこわすと、装甲が外れる');
    await kill('core');
    await page.waitForFunction(() => window.__app.screen() === 'result', null, { timeout: 120000 });
    const won = await page.evaluate(() => ({ head: document.getElementById('resultHead').textContent, rank: document.getElementById('resultRank').textContent }));
    ok(won.head === 'MISSION CLEAR' && /^[SABC]$/.test(won.rank), `勝ちの結果とランクが出る (${won.head} / ${won.rank})`);
    const again = center(await rectOf(page, '#btnAgain'));
    await page.touchscreen.tap(again.x, again.y);
    await page.waitForFunction(() => window.__app.screen() === 'play');
    ok(await page.evaluate(() => window.__app.game().stage === 'bossIn' || window.__app.game().stage === 'boss'), '「もう一度」で同じところから始まる');

    // ------------------------------------------------ 1 枚にまとめた版 (テストプレイ用)
    section('1 枚にまとめた版');
    const os = require('node:os');
    const fs = require('node:fs');
    const single = path.join(os.tmpdir(), 'starbreak-single-test.html');
    require('node:child_process').execFileSync(process.execPath, [path.join(ROOT, 'bundle.js'), single]);
    const sctx = await browser.newContext(phoneDevice(devices, false));
    await sctx.route(/^https?:/, (r) => r.abort());     // ネットには出ない
    const sp = await sctx.newPage();
    watch(sp, '1枚版');
    await sp.goto('file://' + single);
    await sp.waitForFunction(() => window.__app && ['space.jpg', 'earth.jpg', 'hull.jpg', 'gauges.png', 'logo.png', 'btn_start.png'].every((f) => window.__app.assetsLoaded()[f] !== undefined), null, { timeout: 20000 });
    const sa = await sp.evaluate(() => window.__app.assetsLoaded());
    ok(['space.jpg', 'earth.jpg', 'hull.jpg', 'gauges.png', 'logo.png', 'btn_start.png'].every((f) => sa[f] === true), 'ほかのファイルなしで、絵まで出る (背景・地球・装甲・ゲージ・ロゴ・出撃ボタン)');
    const vp = await sp.evaluate(() => ({
      meta: (document.querySelector('meta[name=viewport]') || {}).content || '',
      scale: visualViewport.scale, w: innerWidth
    }));
    ok(/user-scalable=no/.test(vp.meta) && /maximum-scale=1/.test(vp.meta), '1 枚版にも「拡大しない」指定が入っている');
    ok(vp.scale === 1 && vp.w === 932, `1 枚版も倍率 1 で、幅 932 (倍率 ${vp.scale} / 幅 ${vp.w})`);
    ok(fs.statSync(single).size < 4 * 1024 * 1024, `大きさ ${(fs.statSync(single).size / 1024 / 1024).toFixed(1)}MB`);
    await sctx.close();

    // ------------------------------------------------ 縦向き
    section('縦向き');
    const pctx = await browser.newContext(phoneDevice(devices, true));
    const pp = await pctx.newPage();
    watch(pp, '縦');
    await pp.goto(URL);
    await pp.waitForFunction(() => window.__app);
    ok(await pp.evaluate(() => getComputedStyle(document.getElementById('rotate')).display !== 'none'), '縦向きなら「横向きにして」が出る');
    await pctx.close();

    section('エラー');
    ok(errors.length === 0, errors.length ? '画面のエラー: ' + errors.join(' / ') : 'JS エラーなし');
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
