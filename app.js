/*!
 * app.js — 画面まわり。操作と描画はここに書く。
 */
(function () {
  'use strict';

  const C = window.Core;

  const els = {
    result: document.getElementById('result'),
    btnAction: document.getElementById('btnAction')
  };

  const state = {
    seed: (Math.random() * 4294967296) >>> 0,
    count: 0,
    last: null
  };

  function render() {
    els.result.textContent = state.last === null ? '—' : String(state.last);
  }

  function action() {
    // 同じ seed からは同じ並びが出る。state.count 回目の結果を出す。
    const rng = C.mulberry32(state.seed + state.count);
    state.count++;
    state.last = C.roll(rng);
    render();
  }

  function main() {
    els.btnAction.addEventListener('click', action);
    render();

    // 自動テストから中身をのぞくための入口
    window.__app = {
      state: function () { return state; },
      action: action,
      render: render
    };
  }

  main();
})();
