/*
 * テストプレイ用に、全ファイルを 1 枚の HTML にまとめる: node bundle.js 出力先.html
 * CSS も JS も埋め込む。three.js も同梱するので、ネットにつながる先は無い。
 */
const fs = require('node:fs');
const path = require('node:path');

const out = process.argv[2];
if (!out) { console.error('使い方: node bundle.js 出力先.html'); process.exit(1); }
const ASSETS = ['space.jpg', 'space2.jpg','space3.jpg','space4.jpg','mercury.jpg', 'earth.jpg', 'mars.jpg', 'jupiter.jpg', 'hull.jpg', 'gauges.png', 'title_planet.jpg', 'cutin.png', 'plume.png'];
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
// </script> が中にあると、そこで埋め込みが切れる
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

const html = read('index.html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script'));
const page = [
  '<title>STARBREAK</title>',
  // index.html の <head> は使わないので、拡大しない指定はここで入れる
  '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">',
  '<meta name="claude:viewport-fit-sides" content="cover">',
  '<style>', read('styles.css'), '</style>',
  body.trim(),
  '<script>', safe(read('three.min.js')), '</script>',
  // 絵は data URI にして埋め込む (app.js の loadTex が window.__ASSETS を先に見る)
  '<script>window.__ASSETS = ' + JSON.stringify(Object.fromEntries(ASSETS.map((f) =>
    [f, 'data:image/' + (f.endsWith('.png') ? 'png' : f.endsWith('.webp') ? 'webp' : 'jpeg') + ';base64,' + fs.readFileSync(path.join(__dirname, f)).toString('base64')]))) + ';</script>',
  '<script>', safe(read('core.js')), '</script>',
  '<script>', safe(read('app.js')), '</script>'
].join('\n');
fs.writeFileSync(out, page);
console.log(out + ' (' + Math.round(page.length / 1024) + ' KB)');
