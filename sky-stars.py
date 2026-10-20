"""空のパノラマから星を抜き出す。

space-src.jpg (送ってもらった元の絵) を読み、
  - 小さく光る点 (星) を見つけて、まわりの色で塗りつぶした絵を space.jpg に書く
  - 見つけた星の位置・明るさ・色を stars.js (window.SKY_STARS) に書く
app.js は星を画面の解像度で点として描き直す。元の絵は 1774x887 しかなく、
画面では 2.6〜3.4 倍に引き伸ばされて星がぼやけた玉に見えるため。

  python3 sky-stars.py
"""
import base64
import numpy as np
from PIL import Image

src = np.asarray(Image.open('space-src.jpg').convert('RGB')).astype(float)
H, W, _ = src.shape
L = src.mean(2)


def shift(a, dx, dy):
    return np.roll(np.roll(a, dy, 0), dx, 1)


def ring(R, n=16):
    return [(int(round(R * np.cos(t))), int(round(R * np.sin(t)))) for t in np.linspace(0, 2 * np.pi, n, endpoint=False)]


# 星: まわり (半径 4 の輪の中央値) よりはっきり明るい、3x3 でいちばん明るい点。明るい星雲の上ほど線を上げる
bg = np.median(np.stack([shift(L, dx, dy) for dx, dy in ring(4)]), 0)
peak = L - bg
top = np.ones_like(L, bool)
for dx in (-1, 0, 1):
    for dy in (-1, 0, 1):
        if dx or dy:
            top &= L >= shift(L, dx, dy)
ys, xs = np.where(top & (peak > 16 + 0.3 * bg))

clean = src.copy()
recs = []
for i in np.argsort(-peak[ys, xs]):          # 明るい星から (暗い星の埋め色に明るい星のにじみを使わない)
    x, y, p = xs[i], ys[i], peak[ys[i], xs[i]]
    r = 1
    for k in range(1, 4):
        v = np.mean([L[(y + dy) % H, (x + dx) % W] for dx, dy in ((k, 0), (-k, 0), (0, k), (0, -k))]) - bg[y, x]
        if v > p * 0.3:
            r = k + 1
        else:
            break
    rr = r + 1
    # 埋める色: 外側の輪のうち暗い方 5〜6 割の平均 (中央値だと星のにじみを拾って明るい円が残る)
    rv = np.array([clean[(y + dy) % H, (x + dx) % W] for dx, dy in ring(rr + 2, 32)])
    lum = rv.mean(1)
    b = rv[lum <= np.percentile(lum, 55)].mean(0)
    for dy in range(-rr - 1, rr + 2):
        for dx in range(-rr - 1, rr + 2):
            w = np.clip((rr + 1.0 - np.hypot(dx, dy)) / 1.5, 0, 1)
            if w > 0:
                yy, xx = (y + dy) % H, (x + dx) % W
                clean[yy, xx] = clean[yy, xx] * (1 - w) + b * w
    c = np.clip(src[y, x], 0, 255)
    recs.append((int(x), int(y), int(min(255, p)), int(c[0]), int(c[1]), int(c[2])))

Image.fromarray(np.clip(clean, 0, 255).astype(np.uint8)).save('space.jpg', quality=90)

# 1 つ 8 バイト: x (2) y (2) 明るさ (1) 色 r g b (3)。絵の大きさも先頭に入れる
buf = bytearray()
buf += W.to_bytes(2, 'little') + H.to_bytes(2, 'little')
for x, y, p, r, g, b in recs:
    buf += x.to_bytes(2, 'little') + y.to_bytes(2, 'little') + bytes((p, r, g, b))
with open('stars.js', 'w') as f:
    f.write('// sky-stars.py が書く。空のパノラマ (space.jpg) から抜き出した星 %d 個 (x, y, 明るさ, r, g, b)\n' % len(recs))
    f.write("window.SKY_STARS = '%s';\n" % base64.b64encode(bytes(buf)).decode())
print(len(recs), 'stars', len(buf), 'bytes')
