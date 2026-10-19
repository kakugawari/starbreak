/*
 * テストプレイ用に、全ファイルを 1 枚の HTML にまとめる: node bundle.js 出力先.html
 * CSS も JS も埋め込む。three.js も同梱するので、ネットにつながる先は無い。
 */
const fs = require('node:fs');
const path = require('node:path');

const out = process.argv[2];
if (!out) { console.error('使い方: node bundle.js 出力先.html'); process.exit(1); }
const ASSETS = ['space.jpg', 'earth.jpg'];
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
// </script> が中にあると、そこで埋め込みが切れる
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

const html = read('index.html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script'));
const page = [
  '<title>STARBREAK</title>',
  '<meta name="claude:viewport-fit-sides" content="cover">',
  '<style>', read('styles.css'), '</style>',
  body.trim(),
  '<script>', safe(read('three.min.js')), '</script>',
  // 絵は data URI にして埋め込む (app.js の loadTex が window.__ASSETS を先に見る)
  '<script>window.__ASSETS = ' + JSON.stringify(Object.fromEntries(ASSETS.map((f) =>
    [f, 'data:image/jpeg;base64,' + fs.readFileSync(path.join(__dirname, f)).toString('base64')]))) + ';</script>',
  '<script>', safe(read('core.js')), '</script>',
  '<script>', safe(read('app.js')), '</script>'
].join('\n');
fs.writeFileSync(out, page);
console.log(out + ' (' + Math.round(page.length / 1024) + ' KB)');
