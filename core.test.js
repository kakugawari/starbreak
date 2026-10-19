const test = require('node:test');
const assert = require('node:assert');
const Core = require('./core.js');

test('同じ seed からは同じ数が出る', () => {
  const a = Core.mulberry32(42);
  const b = Core.mulberry32(42);
  for (let i = 0; i < 10; i++) assert.strictEqual(a(), b());
});

test('seed が違えば並びも変わる', () => {
  const a = Core.mulberry32(1);
  const b = Core.mulberry32(2);
  assert.notStrictEqual(a(), b());
});

test('shuffle は中身を減らさない', () => {
  const source = [1, 2, 3, 4, 5, 6, 7, 8];
  const mixed = Core.shuffle(source.slice(), Core.mulberry32(7));
  assert.deepStrictEqual(mixed.slice().sort((x, y) => x - y), source);
});

test('roll は 1〜6 を返す', () => {
  const rng = Core.mulberry32(3);
  for (let i = 0; i < 100; i++) {
    const value = Core.roll(rng);
    assert.ok(Number.isInteger(value) && value >= 1 && value <= 6, `1〜6 のはず: ${value}`);
  }
});
