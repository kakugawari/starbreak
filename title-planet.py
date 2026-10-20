"""タイトルの惑星 (丸ごと回す版) の絵 title_planet.jpg を作る。

  python3 title-planet.py 送ってもらった惑星の絵.jpg

送ってもらったマゼンタ地の惑星の絵から、円の中だけを正方形に切り出す。
- 円: 左のふちと右下のふちに当てはめた (中心 687.2, 383.7・半径 389.3)
- 上下 6px ずつ絵から切れている所は、絵の端で折り返した行で埋める
- 右上に焼き込まれた太陽の光 (1000, 181) は、円の中心のまわりに 26° ずらした所の地表で埋める
  (ゲームでは惑星を回し、太陽の光は止めたまま別に描く)
- 円の外は円のふちの色を外へ延ばしておく (回したときに、ふちで背景の色が混ざらないように)。透明は使わないので JPEG
"""
import sys
import numpy as np
from PIL import Image
src=np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(float)
H,W,_=src.shape
CX,CY,R=687.25,383.66,389.33
RR=R-4                       # ふちの大気の光 (マゼンタが混ざる) を落とす
S=1024
def sample(x,y):
    # 双一次で読む。上下にはみ出した行は絵の端で折り返す
    y=np.where(y<0,-y,y); y=np.where(y>H-1,2*(H-1)-y,y)
    x=np.clip(x,0,W-1.001); y=np.clip(y,0,H-1.001)
    x0=np.floor(x).astype(int); y0=np.floor(y).astype(int); fx=(x-x0)[...,None]; fy=(y-y0)[...,None]
    a=src[y0,x0]; b=src[y0,x0+1]; c=src[y0+1,x0]; d=src[y0+1,x0+1]
    return (a*(1-fx)+b*fx)*(1-fy)+(c*(1-fx)+d*fx)*fy
# 出力の正方形: 中心 = 円の中心、半径 0.5 = RR
u=(np.arange(S)+0.5)/S-0.5
X,Y=np.meshgrid(u,u)
rad=np.hypot(X,Y)
k=np.minimum(1,0.497/np.maximum(rad,1e-6))       # 円の外は、円のすぐ内側の色を延ばす
px=CX+X*k*2*RR; py=CY+Y*k*2*RR
out=sample(px,py)
# 太陽の光を消す: 光の中心からの距離で重みをつけ、円の中心のまわりに回した所の地表を混ぜる
FX,FY=1000.0,181.0
dist=np.hypot(px-FX,py-FY)
w=np.clip(1-(dist-38)/52,0,1)[...,None]
th=np.deg2rad(26)
qx=CX+(px-CX)*np.cos(th)-(py-CY)*np.sin(th); qy=CY+(px-CX)*np.sin(th)+(py-CY)*np.cos(th)
patch=sample(qx,qy)
out=out*(1-w)+patch*w
img=Image.fromarray(np.clip(out,0,255).astype(np.uint8))
img.save('title_planet.jpg',quality=88)
import os; print(os.path.getsize('title_planet.jpg'))
