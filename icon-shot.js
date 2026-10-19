/*
 * アプリのアイコンの元を写す: node icon-shot.js 出力先/   (npm start などで 8080 が動いていること)
 * 機体を黒地とマゼンタ地で 1 回ずつ写す (icon_k0.png / icon_kM.png)。
 * 2 枚の差から透け具合が分かるので、噴射の光ごと機体を抜ける。続けて
 *   python3 icon-compose.py 出力先/ ./
 * で、描き直した宇宙に重ねて icon-1024/512/192/180.png を作る。
 */
const { chromium } = require('playwright');
const OUT = process.argv[2] || './';
const VIEW = { pos: [-9, 10, 15], rot: [0.05, 0.1, -0.5], k: 1.25, sky: false };
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await (await b.newContext({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 4 })).newPage();
  await p.goto('http://localhost:' + (process.env.PORT || 8080) + '/');
  await p.waitForFunction(() => window.__app && window.__app.frames() > 3);
  await p.addStyleTag({ content: '#rotate{display:none!important}' });
  for (const [name, bg] of [['k0', 0x000000], ['kM', 0xff00ff]]) {
    await p.evaluate((v) => { Object.assign(window.__app.inspectViews.icon, v); window.__app.inspect('icon'); }, Object.assign({ bg }, VIEW));
    await p.waitForTimeout(500);
    await p.screenshot({ path: OUT + 'icon_' + name + '.png' });
  }
  await b.close();
})();
