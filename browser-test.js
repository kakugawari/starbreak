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
    await page.waitForFunction(() => ['space.jpg', 'space2.jpg', 'space3.jpg', 'earth.jpg', 'mercury.jpg', 'mars.jpg', 'jupiter.jpg', 'hull.jpg', 'title_planet.jpg'].every((f) => window.__app.assetsLoaded()[f] !== undefined), null, { timeout: 20000 });
    const assets = await page.evaluate(() => window.__app.assetsLoaded());
    ok(assets['space.jpg'] === true && assets['earth.jpg'] === true && assets['mars.jpg'] === true && assets['jupiter.jpg'] === true && assets['space2.jpg'] === true && assets['space3.jpg'] === true && assets['mercury.jpg'] === true && assets['hull.jpg'] === true, '宇宙の背景・地球・火星・木星・戦艦の装甲の絵が読み込まれる');
    ok(assets['title_planet.jpg'] === true, 'タイトルの大きな惑星の絵が読み込まれる');
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const tp = await page.evaluate(() => window.__app.titlePlanetInfo());
    ok(tp.shown && tp.glow && !tp.earth, `タイトルは大きな惑星 (と大気・太陽の光) だけを出し、ゲームの地球は出さない (惑星 ${tp.shown}・地球 ${tp.earth})`);
    // 惑星は円の中心を軸に回り続ける。太陽の光は回さない (惑星のふちに留まる)
    const spin = await page.evaluate(async () => {
      const a = window.__app, P = a.titlePlanet, frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const dx = P.driftX, dy = P.driftY; P.driftX = 0; P.driftY = 0;
      a.setTitleTime(0); await frame(); const s0 = a.titlePlanetInfo();
      a.setTitleTime(P.spinT / 4); await frame(); const s1 = a.titlePlanetInfo();
      P.driftX = dx; P.driftY = dy;
      return { turn: (s0.ang - s1.ang) / (Math.PI * 2), center: Math.hypot(s1.cx - s0.cx, s1.cy - s0.cy), flare: Math.hypot(s1.flareX - s0.flareX, s1.flareY - s0.flareY),
        onRim: Math.abs(Math.hypot(s0.flareX - s0.cx, s0.flareY - s0.cy) - s0.radius), flareX: s0.flareX, flareY: s0.flareY, W: innerWidth, H: innerHeight };
    });
    ok(Math.abs(spin.turn - 0.25) < 0.01 && spin.center < 0.5, `惑星は円の中心を軸に回り続ける (1 周の 4 分の 1 の時間で ${spin.turn.toFixed(2)} 周・中心のずれ ${spin.center.toFixed(1)}px)`);
    ok(spin.flare < 0.5 && spin.onRim < 2 && spin.flareX > 0 && spin.flareX < spin.W && spin.flareY > 0 && spin.flareY < spin.H,
      `太陽の光は回らず、惑星のふちの画面の中に留まる (動き ${spin.flare.toFixed(1)}px・ふちからのずれ ${spin.onRim.toFixed(1)}px・位置 ${Math.round(spin.flareX)},${Math.round(spin.flareY)})`);
    // ロゴ・左下のボタン・下の小さなボタンが重ならず、ロゴは機体 (画面の右下寄り) にかからない
    const titleRects = await page.evaluate(() => {
      const r = (q) => { const b = document.querySelector(q).getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width }; };
      return { logo: r('#title .logo-text'), sub: r('#title .logo-sub'), start: r('#btnStart'), boss: r('#btnBossOnly'), links: r('#title .title-links'), H: innerHeight, W: innerWidth,
        ship: window.__app.titleShip };
    });
    ok(titleRects.sub.b <= titleRects.start.t - 20, `ロゴと START が重ならない (ロゴの下 ${titleRects.sub.b.toFixed(0)} / START の上 ${titleRects.start.t.toFixed(0)})`);
    ok(titleRects.start.b <= titleRects.boss.t + 0.5 && titleRects.boss.b <= titleRects.links.t + 0.5, 'START・BOSS BATTLE・設定の並びが重ならない');
    ok(titleRects.start.l < titleRects.W * 0.15 && titleRects.start.t > titleRects.H * 0.5, `START と BOSS BATTLE は左下 (START ${titleRects.start.l.toFixed(0)},${titleRects.start.t.toFixed(0)})`);
    ok(titleRects.logo.r < titleRects.ship.x * titleRects.W - 90, `ロゴは機体にかからない (ロゴの右 ${titleRects.logo.r.toFixed(0)} / 機体の真ん中 ${(titleRects.ship.x * titleRects.W).toFixed(0)})`);
    ok(titleRects.boss.b - titleRects.boss.t >= 44, `BOSS BATTLE は押せる高さ (${(titleRects.boss.b - titleRects.boss.t).toFixed(0)}pt)`);
    ok(titleRects.start.b - titleRects.start.t >= 44, `START は押せる高さ (${(titleRects.start.b - titleRects.start.t).toFixed(0)}pt)`);

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

    // ホーム画面のアイコン: iOS は SVG を使えないので PNG (180x180) を指す
    const icon = await page.evaluate(() => new Promise((res) => {
      const l = document.querySelector('link[rel="apple-touch-icon"]');
      if (!l) return res(null);
      const im = new Image(); im.onload = () => res({ href: l.getAttribute('href'), w: im.naturalWidth, h: im.naturalHeight }); im.onerror = () => res({ href: l.getAttribute('href'), w: 0 });
      im.src = l.href;
    }));
    ok(icon && /\.png$/.test(icon.href) && icon.w === 180 && icon.h === 180, `ホーム画面のアイコンが PNG で読める (${icon ? icon.href + ' ' + icon.w + 'x' + icon.h : 'なし'})`);
    // 設定・遊び方: 下の小さなボタンで右に板が開く。もう一度押すか、戻るで閉じる
    const menuState = () => page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const panel = document.getElementById('titleMenu').getBoundingClientRect();
      const st = document.getElementById('btnStart').getBoundingClientRect();
      return {
        open: vis(document.getElementById('titleMenu')),
        toggles: [...document.querySelectorAll('#titleMenu input')].filter(vis).length,
        howto: vis(document.querySelector('#titleMenu .howto')),
        top: panel.top, bottom: panel.bottom, left: panel.left, H: innerHeight, startRight: st.right,
        invert: window.__app.settings.invert
      };
    });
    const mn0 = await menuState();
    ok(!mn0.open, 'はじめは設定・遊び方の板を出さない');
    const tapEl = async (sel) => { const r = await rectOf(page, sel); await page.touchscreen.tap(center(r).x, center(r).y); await page.waitForTimeout(120); };
    await tapEl('#btnSettings');
    const mn1 = await menuState();
    ok(mn1.open && mn1.toggles === 3, `SETTING を押すと、スイッチ 3 つの板が開く (${mn1.toggles})`);
    await tapEl('#optInvert');
    ok((await menuState()).invert === !mn0.invert, '設定のスイッチを指で押すと切り替わる (上下反転)');
    await tapEl('#optInvert');
    await tapEl('#btnHowto');
    const mn2 = await menuState();
    ok(mn2.howto && mn2.toggles === 0, 'HOW TO PLAY を押すと、板の中が説明に替わる');
    ok([mn1, mn2].every((m) => m.top >= 0 && m.bottom <= m.H && m.left > m.startRight + 20), `板は画面に収まり、左下のボタンにかからない (板 ${Math.round(mn2.top)}〜${Math.round(mn2.bottom)})`);
    await tapEl('#btnHowto');
    ok(!(await menuState()).open, 'もう一度押すと閉じる');
    await tapEl('#btnSettings');
    await tapEl('#menuSettings [data-back]');
    const mn3 = await menuState();
    ok(!mn3.open && mn3.invert === mn0.invert, '戻るで閉じる');

    // 機体の面: 鏡にした翼が片側だけ黒く見えた不具合の見張り
    const faces = await page.evaluate(() => window.__app.flippedFaces());
    ok(faces.player.bad === 0 && faces.enemy.bad === 0 && faces.boss.bad === 0,
      `機体の面の表向きと光の向きがそろっている (自機 ${faces.player.bad}/${faces.player.total}・敵機 ${faces.enemy.bad}/${faces.enemy.total}・戦艦 ${faces.boss.bad}/${faces.boss.total} 枚が逆)`);

    // ------------------------------------------------ タイトルの曲
    section('タイトルの曲');
    // 最初に触れたあとから鳴る (ここまでに何度か触れている)。静かで、割れず、効果音より小さい
    ok(await page.evaluate(() => window.__app.musicOn()), 'タイトルで触れたあと、曲が鳴っている');
    const mlv = [];
    for (let i = 0; i < 6; i++) { await page.waitForTimeout(500); mlv.push(await page.evaluate(() => window.__app.audioLevel())); }
    if (!mlv[0]) skip('このブラウザでは音を測れない');
    else {
      const mavg = mlv.reduce((a, l) => a + l.avg, 0) / mlv.length, mmax = Math.max.apply(null, mlv.map((l) => l.max));
      ok(mavg > 0.01 && mavg < 0.09 && mmax < 0.4, `曲は静かで割れない (平均 ${mavg.toFixed(3)}・最大 ${mmax.toFixed(3)})`);
    }

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
    ok(await page.evaluate(() => window.__app.musicKind() === 'combat'), '出撃すると、タイトルの曲から戦闘の曲に替わる');
    const clv = [];
    for (let i = 0; i < 8; i++) { await page.waitForTimeout(400); clv.push(await page.evaluate(() => window.__app.audioLevel())); }
    if (clv[0]) {
      const cavg = clv.reduce((a, l) => a + l.avg, 0) / clv.length, cmax = Math.max.apply(null, clv.map((l) => l.max));
      ok(cavg > 0.008 && cavg < 0.09 && cmax < 0.5, `戦闘の曲は割れず、効果音より小さい (平均 ${cavg.toFixed(3)}・最大 ${cmax.toFixed(3)})`);
    }
    ok(playing.fighters === 3, `第1波は 3 機 (${playing.fighters})`);
    ok(await page.evaluate(() => window.__app.skyDim() < 0.7), '遊んでいる間は背景を沈める (敵や印が埋もれないように)');
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const tp2 = await page.evaluate(() => window.__app.titlePlanetInfo());
    ok(!tp2.shown && !tp2.glow && tp2.earth, `遊んでいる間はタイトルの惑星を消し、ゲームの地球を出す (惑星 ${tp2.shown}・地球 ${tp2.earth})`);

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
    // 遅い機械では出撃直後のゲームが 1 秒で 0.1 秒ほどしか進まない。実時間 700ms ではなく、ゲームの時間で待つ
    await page.waitForFunction(() => window.__app.game().player.boosting, null, { timeout: 30000 });
    await waitGameTime(page, 0.6);
    const boostFx = await page.evaluate(() => ({ big: window.__app.bigParticlesNear(40, 2), jet: window.__app.jetLength(), root: window.__app.jetRoot(), boosting: window.__app.game().player.boosting }));
    await page.keyboard.up('Shift');
    ok(boostFx.boosting && boostFx.big === 0, `ブーストで煙の玉を出さない (自機の 40m 以内の大きな粒 ${boostFx.big})`);
    ok(boostFx.jet > jetNormal * 1.6, `ブーストで噴射の光が延びる (${jetNormal.toFixed(1)} → ${boostFx.jet.toFixed(1)})`);
    const rootN = await page.evaluate(() => window.__app.jetRoot());
    ok(rootN <= 1.65 && boostFx.root <= 1.65, `噴射の根もとがエンジンの筒 (直径 1.6m) からはみ出さない (ふだん ${rootN.toFixed(2)}m・ブースト ${boostFx.root.toFixed(2)}m)`);
    // 噴射の絵は、光の中心が絵の真ん中にある (ずれていると、板の上で噴射口からずれて見える)
    const plumeC = await page.evaluate(() => new Promise((res) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
        const x = c.getContext('2d'); x.drawImage(im, 0, 0);
        const d = x.getImageData(0, 0, c.width, 60).data;
        let sw = 0, sx = 0;
        for (let i = 0; i < d.length; i += 4) { const a = d[i + 3], px = (i / 4) % c.width; sw += a; sx += a * px; }
        res({ off: Math.abs(sx / sw - c.width / 2) / c.width });
      };
      im.src = (window.__ASSETS && window.__ASSETS['plume.png']) || './plume.png';
    }));
    ok(plumeC.off < 0.03, `噴射の絵の光の中心が真ん中にある (ずれ ${(plumeC.off * 100).toFixed(1)}%)`);
    ok(jetNormal >= 8.8, `ふだんの噴射は、送ってもらった絵と同じく機体 (11m) の 0.8 倍以上 (${jetNormal.toFixed(1)}m)`);

    // 撃墜の瞬間: タメ (時が止まる)・衝撃波の輪・遠くても画面で小さくならない・膨らむ煙の玉を出さない
    const killAt = (dist) => page.evaluate((dist) => {
      const g = window.__app.game(), pl = g.player;
      g.events.push({ type: 'explode', kind: 'fighter', size: 1.4, pos: { x: pl.pos.x + pl.dir.x * dist, y: pl.pos.y + pl.dir.y * dist, z: pl.pos.z + pl.dir.z * dist }, vel: { x: 0, y: 0, z: 0 } });
      return g.t;
    }, dist);
    await killAt(300);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const kf = await page.evaluate(() => Object.assign(window.__app.killFx(), { grow: window.__app.growingParticles() }));
    ok(kf.last && kf.last.kind === 'fighter' && kf.ringOn, '撃墜すると衝撃波の輪が出る');
    await page.waitForTimeout(250);
    const kfStop = await page.evaluate(() => window.__app.killFx().last);
    ok(kfStop.frozen >= 1 && kfStop.tFrozen === kfStop.tAt, `撃墜の瞬間は一瞬だけ時が止まる (止まった描画 ${kfStop.frozen} 回・その間に進んだ時間 ${((kfStop.tFrozen - kfStop.tAt) * 1000).toFixed(0)}ms)`);
    ok(kf.grow === 0, `撃墜の爆発に、膨らみながら消える大きな粒 (煙の玉) が無い (${kf.grow})`);
    await page.waitForTimeout(350);
    await killAt(700);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const kfFar = await page.evaluate(() => window.__app.killFx());
    ok(kf.ringPx >= 100 && kfFar.ringPx >= 100, `遠くの撃墜でも、衝撃波は画面で十分な大きさ (300m: ${kf.ringPx.toFixed(0)}px / 700m: ${kfFar.ringPx.toFixed(0)}px)`);

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
    await waitGameTime(page, 0.05);
    const m1 = await page.evaluate(() => ({ n: window.__app.game().player.missiles, shown: document.getElementById('missileCount').textContent }));
    ok(m1.n === m0 - 1, `ミサイルを1発撃つ (${m0} → ${m1.n})`);
    await waitGameTime(page, 0.1);
    const shown = await page.evaluate(() => document.getElementById('missileCount').textContent);
    ok(shown === String(m1.n), `残りの数の表示も変わる (${shown})`);

    // マルチロック: 押している間にロックが増え、離すと一斉に撃つ
    await page.evaluate(() => {
      const g = window.__app.game(), C = window.Core, pl = g.player;
      window.__savedFighters = g.fighters; // あとのテストは第1波の敵を使うので、とっておいて戻す
      g.fighters = []; g.missiles = []; pl.missiles = 4; pl.mlock = [];
      const right = C.norm(C.cross(pl.dir, C.vec(0, 1, 0)));
      [-0.14, 0, 0.15].forEach((a) => {
        const dir = C.norm(C.add(C.scale(pl.dir, Math.cos(a)), C.scale(right, Math.sin(a))));
        const fi = C.makeFighter(g, C.add(pl.pos, C.scale(dir, 340)), C.vec(0, 0, 1));
        fi.vel = C.vec(); fi.speed = 0; fi.mode = 'test'; fi.hp = 1;
        g.fighters.push(fi);
      });
    });
    await f.down(5, mBtn.x, mBtn.y);
    await waitGameTime(page, 1.3);
    const ml = await page.evaluate(() => ({
      n: window.__app.game().player.mlock.length, marks: window.__app.hudInfo.mlock.length, ring: window.__app.hudInfo.mlockRing,
      label: document.getElementById('missileCount').textContent, red: document.getElementById('btnMissile').classList.contains('locked'),
      fired: window.__app.game().missiles.length
    }));
    ok(ml.n === 3 && ml.fired === 0, `MSL を押している間に 3 機をロックし、まだ撃たない (ロック ${ml.n}・飛んでいる ${ml.fired})`);
    ok(ml.marks === 3 && ml.ring > 40, `ロックした敵に印が出て、捕まえる範囲の輪が出る (印 ${ml.marks}・輪 ${ml.ring && ml.ring.toFixed(0)}px)`);
    ok(ml.label === '3/4' && ml.red, `ボタンにロックの数が出る (${ml.label})`);
    await f.up(5);
    await waitGameTime(page, 0.05);
    const sv = await page.evaluate(() => ({ left: window.__app.game().player.missiles, fired: window.__app.game().missiles.map((m) => m.target), lock: window.__app.game().player.mlock.length, label: document.getElementById('missileCount').textContent }));
    ok(sv.left === 1 && new Set(sv.fired).size === 3 && sv.lock === 0, `離すと 3 発を別々の敵へ一斉に撃つ (残り ${sv.left}・的 ${new Set(sv.fired).size})`);
    await waitGameTime(page, 0.1);
    const lb = await page.evaluate(() => document.getElementById('missileCount').textContent);
    ok(lb === '1', `撃ったらボタンは残りの数に戻る (${lb})`);
    await page.evaluate(() => { const g = window.__app.game(); g.fighters = window.__savedFighters; g.missiles = []; g.player.missiles = 4; });

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
    // 主人公機のエンジン音: ずっと鳴り、静かで、割れない (曲を止めて、エンジンだけを測る)
    await page.evaluate(() => window.__app.sfx('stopMusic'));
    await page.waitForTimeout(2500);
    const elv = [];
    for (let i = 0; i < 8; i++) { await page.waitForTimeout(300); elv.push(await page.evaluate(() => window.__app.audioLevel())); }
    if (!elv[0]) skip('このブラウザでは音を測れない');
    else {
      const eavg = elv.reduce((a, l) => a + l.avg, 0) / elv.length, emax = Math.max.apply(null, elv.map((l) => l.max));
      ok(eavg > 0.004 && eavg < 0.05 && emax < 0.2, `エンジン音は鳴り続け、静かで割れない (平均 ${eavg.toFixed(3)}・最大 ${emax.toFixed(3)})`);
    }
    // ブーストとロックオンの音: 鳴って、割れない。ロックは小さく疲れにくく、ブーストは強い (どちらも時刻を使う連続ループで測る。setTimeout だと遅い機械で外す)
    const sfxMax = (name) => page.evaluate((name) => { const t0 = performance.now(); window.__app.sfx(name); let mx = 0; while (performance.now() - t0 < 1500) mx = Math.max(mx, window.__app.audioLevel().max); return mx; }, name);
    await page.waitForTimeout(1500);
    const bMax = await sfxMax('boost');
    await page.waitForTimeout(1500);
    const lMax = await sfxMax('lock');
    await page.waitForTimeout(1500);
    const gMax = await sfxMax('laser');
    if (bMax !== null) {
      ok(bMax > 0.12 && bMax < 0.9, `ブーストの音は強く、割れない (最大 ${bMax.toFixed(3)})`);
      ok(lMax > 0.03 && lMax < 0.3, `ロックオンの音は鳴り、小さく疲れにくい (最大 ${lMax.toFixed(3)})`);
      ok(gMax > 0.1 && gMax < 0.5, `レーザーの発射音は力強く、割れない (最大 ${gMax.toFixed(3)})`);
    }
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
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const hiddenAtStart = await page.evaluate(() => window.__app.game().boss.phase === 'arrive' && !window.__app.bossVisible());
    // ボス戦のカットイン: 出る・操作のボタンへの指は素通しする・終わると消える
    await page.waitForFunction(() => document.getElementById('cutin').getAnimations().length > 0, null, { timeout: 5000 });
    const cut = await page.evaluate(() => {
      const el = document.getElementById('cutin');
      const a = el.getAnimations()[0]; a.pause(); a.currentTime = 700; // 止まって見えている所で調べる
      const r = el.getBoundingClientRect();
      const mid = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const img = el.querySelector('img');
      const top = document.elementFromPoint(mid.x, mid.y);
      const glow = img.getAnimations().length;
      const res = { shown: !el.hidden && r.width > 800, loaded: img.complete && img.naturalWidth > 0,
        passThrough: getComputedStyle(el).pointerEvents === 'none' && !!top && !top.closest('#cutin'), glow: glow };
      a.play();
      return res;
    });
    ok(cut.shown && cut.loaded, 'ボス戦の始まりにカットインが出る (絵も読み込まれている)');
    ok(cut.passThrough, `カットインは指を素通しする (真ん中の点の一番上はカットインではない: ${cut.passThrough})`);
    ok(cut.glow >= 1, `帯が光る (光のアニメーション ${cut.glow} 本)`);
    await page.waitForFunction(() => document.getElementById('cutin').hidden, null, { timeout: 6000 });
    ok(true, 'カットインは終わると消える');
    await page.waitForFunction(() => window.__app.musicKind() === 'boss', null, { timeout: 60000 });
    ok(true, '戦艦が現れたら、戦艦戦の曲が始まる');
    const blv = [];
    for (let i = 0; i < 8; i++) { await page.waitForTimeout(400); blv.push(await page.evaluate(() => window.__app.audioLevel())); }
    if (blv[0]) {
      const bavg = blv.reduce((a, l) => a + l.avg, 0) / blv.length, bmax = Math.max.apply(null, blv.map((l) => l.max));
      ok(bavg > 0.008 && bavg < 0.1 && bmax < 0.6, `戦艦戦の曲は割れず、低く重い (平均 ${bavg.toFixed(3)}・最大 ${bmax.toFixed(3)})`);
    }
    await page.waitForFunction(() => window.__app.game().boss.shown, null, { timeout: 15000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const boss0 = await page.evaluate(() => { const g = window.__app.game(), b = g.boss, p = g.player.pos; return { vis: window.__app.bossVisible(), d: Math.hypot(b.at.x - p.x, b.at.y - p.y, b.at.z - p.z) }; });
    ok(hiddenAtStart && boss0.vis && boss0.d < 900, `戦艦はカットインの間は隠れていて、近く (${boss0.d.toFixed(0)}m) にワープして現れる`);
    // 出てくる途中は、光の面 (右側) より向こうの部分を描かない
    const clip = await page.evaluate(() => { const b = window.__app.game().boss; return { clip: window.__app.bossClipX(), portal: b.portal.x, emerging: b.phase === 'arrive' && b.emerge < 1 }; });
    ok(clip.emerging && Math.abs(clip.clip - clip.portal) < 0.01, '出てくる途中は、ワープの光の面で艦を切って描く (光の中から出てくる)');
    await page.evaluate(() => { window.__app.game().boss.arriveT = 100; });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    ok(await page.evaluate(() => window.__app.bossClipX() > 1e8), '出きったら、艦を切らずに全部描く');
    await page.waitForFunction(() => window.__app.game().boss.phase === 'battle', null, { timeout: 30000 });
    // 何も当たらない時間が続くと、迎撃機が来る (知らせが出て、小さめに描かれる)
    // (戦闘が始まった時刻も「10 秒前」にずらす。始まってすぐは迎撃機を出さないので、遅い機械では 10 秒で間に合わなかった)
    await page.evaluate(() => { const g = window.__app.game(); g.fighters = []; g.lastHitT = g.t - 10; g.boss.battleT = g.t - 10; g.boss.droneCd = 0; });
    await page.waitForFunction(() => window.__app.game().fighters.some((f) => f.drone), null, { timeout: 30000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const dr = await page.evaluate(() => { const fs = window.__app.game().fighters.filter((f) => f.drone); return { n: fs.length, scale: window.__app.enemyScale(fs[0].id), banner: window.__app.banners().indexOf('迎撃機 接近') >= 0 }; });
    ok(dr.n === 4 && dr.banner && Math.abs(dr.scale - 0.6) < 0.01, `ボス戦の空き時間に迎撃機が ${dr.n} 機来る (知らせ ${dr.banner}・大きさ ${dr.scale})`);
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
    // 1 面の戦艦を沈めると、結果ではなく 2 面へ進む
    await page.waitForFunction(() => window.__app.game().level === 2, null, { timeout: 60000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const card = (n, en, ja) => page.evaluate(([n, en, ja]) => { const c = window.__app.stageCard(); return c.shown && c.num === 'STAGE ' + n && c.en === en && c.ja === ja; }, [n, en, ja]);
    const st2 = await page.evaluate(() => ({ screen: window.__app.screen(), boss: window.__app.bossVisible() }));
    const kinds = await page.evaluate(() => window.__app.planetKind());
    const skyK = await page.evaluate(() => window.__app.skyKind());
    ok(kinds === 'mercury' && skyK === 'space2', `2 面では空の惑星が水星に、空の絵が灰色の星雲になる (${kinds} / ${skyK})`);
    ok(st2.screen === 'play' && await card(2, 'MERCURY ORBIT', '水星軌道') && !st2.boss, `1 面の戦艦を沈めると 2 面へ進む (画面 ${st2.screen}・「STAGE 2 水星軌道」の札・前の戦艦は消える)`);
    // 2 面のボスはエース機 (通常の敵を大きく赤くした機)。落とすと 3 面へ
    await page.evaluate(() => { const g = window.__app.game(); g.stage = 'gap2'; g.stageTimer = 99; g.fighters = []; });
    await page.waitForFunction(() => window.__app.game().ace && window.__app.aceLook(), null, { timeout: 30000 });
    const ace = await page.evaluate(() => ({ look: window.__app.aceLook(), warn: window.__app.banners().indexOf('警告  エース機 接近') >= 0, boss: window.__app.game().boss }));
    ok(ace.look.scale > 1.2 && ace.look.color === 'b02024' && !ace.boss, `2 面のボスは赤く大きいエース機 (大きさ ${ace.look.scale}・色 #${ace.look.color}・戦艦なし)`);
    await page.evaluate(() => { const g = window.__app.game(); g.ace.hp = 0; g.ace.alive = false; g.ace.dead = true; g.ace.active = false; });
    await page.waitForFunction(() => window.__app.game().level === 3, null, { timeout: 60000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    ok(await card(3, 'MARS ORBIT', '火星軌道') && await page.evaluate(() => window.__app.planetKind() === 'mars' && window.__app.skyKind() === 'space3'), 'エース機を落とすと 3 面 (火星・琥珀色の星雲・「STAGE 3」の札) へ進む');
    // 3 面の戦艦まで飛ばす: 蛍光緑に塗った艦が来る
    await page.evaluate(() => { const g = window.__app.game(); g.stage = 'gap2'; g.stageTimer = 99; g.fighters = []; });
    // 知らせのあいだは、戦闘の曲を弱めて残す (戦艦戦の曲は、戦艦が現れた瞬間から)
    await page.waitForFunction(() => window.__app.game().boss, null, { timeout: 30000 });
    ok(await page.evaluate(() => { const b = window.__app.game().boss; return b.phase === 'arrive' && b.arriveT < 2.3 && window.__app.musicKind() === 'combat'; }), '戦艦の知らせのあいだは、戦闘の曲のまま (戦艦戦の曲はまだ始まらない)');
    await page.waitForFunction(() => window.__app.game().boss && window.__app.game().boss.shown, null, { timeout: 30000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const look = await page.evaluate(() => window.__app.bossLook());
    ok(look && look.level === 3 && look.color === '9dff7a' && look.emissive === '39ff14', `3 面の戦艦は蛍光緑 (面 ${look && look.level}・色 #${look && look.color}・光 #${look && look.emissive})`);
    await page.evaluate(() => { window.__app.game().boss.arriveT = 100; });
    await page.waitForFunction(() => window.__app.game().boss.phase === 'battle', null, { timeout: 30000 });
    await kill('turret'); await kill('engine'); await kill('core');
    // 3 面の戦艦を沈めると 4 面 (木星) へ。ボスは球と輪の木星要塞
    await page.waitForFunction(() => window.__app.game().level === 4, null, { timeout: 60000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    ok(await card(4, 'JUPITER ORBIT', '木星軌道') && await page.evaluate(() => window.__app.planetKind() === 'jupiter' && window.__app.screen() === 'play'), '3 面の戦艦を沈めると 4 面 (木星・「STAGE 4」の札) へ進む');
    await page.evaluate(() => { const g = window.__app.game(); g.stage = 'gap2'; g.stageTimer = 99; g.fighters = []; });
    await page.waitForFunction(() => window.__app.game().boss && window.__app.game().boss.shown, null, { timeout: 30000 });
    await page.evaluate(() => { window.__app.game().boss.arriveT = 100; });
    await page.waitForFunction(() => window.__app.game().boss.phase === 'battle', null, { timeout: 30000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const fort = await page.evaluate(() => ({ type: window.__app.game().boss.type, level: window.__app.bossLook().level, vis: window.__app.bossVisible(), hud: document.getElementById('bossName') ? document.getElementById('bossName').textContent : '' }));
    ok(fort.type === 'fortress' && fort.level === 4 && fort.vis, `4 面のボスは木星要塞 (${fort.type} / 面 ${fort.level} / ${fort.hud})`);
    await kill('turret'); await kill('engine'); await kill('core');
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
    await sp.waitForFunction(() => window.__app && ['space.jpg', 'space2.jpg', 'space3.jpg', 'earth.jpg', 'mercury.jpg', 'mars.jpg', 'jupiter.jpg', 'hull.jpg', 'gauges.png', 'title_planet.jpg', 'cutin.png', 'plume.png'].every((f) => window.__app.assetsLoaded()[f] !== undefined), null, { timeout: 20000 });
    const sa = await sp.evaluate(() => window.__app.assetsLoaded());
    ok(['space.jpg', 'space2.jpg', 'space3.jpg', 'earth.jpg', 'mercury.jpg', 'mars.jpg', 'jupiter.jpg', 'hull.jpg', 'gauges.png', 'title_planet.jpg', 'cutin.png', 'plume.png'].every((f) => sa[f] === true), 'ほかのファイルなしで、絵まで出る (背景・地球・火星・装甲・ゲージ・タイトルの惑星・カットイン・噴射)');
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
