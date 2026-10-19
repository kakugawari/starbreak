# アイコンの組み立て (icon-shot.js の続き): python3 icon-compose.py 写した絵のある所/ 書き出し先/
from PIL import Image, ImageDraw, ImageFilter
import numpy as np, sys
D=sys.argv[1]; OUTDIR=sys.argv[2]
CROP=(200,288,1640,1728); S=1024
O1=np.asarray(Image.open(D+'icon_k0.png').convert('RGB').crop(CROP).resize((S,S),Image.LANCZOS)).astype(float)/255
O2=np.asarray(Image.open(D+'icon_kM.png').convert('RGB').crop(CROP).resize((S,S),Image.LANCZOS)).astype(float)/255
T=np.clip(((O2[...,0]-O1[...,0])+(O2[...,2]-O1[...,2]))/2,0,1)
sp=Image.open(OUTDIR+'space.jpg').convert('RGB'); W,H=sp.size
neb=sp.crop((int(W*0.30),int(H*0.25),int(W*0.30)+int(H*0.5),int(H*0.75))).resize((S,S),Image.LANCZOS).filter(ImageFilter.GaussianBlur(10))
bg=np.asarray(neb).astype(float)/255*0.75
rng=np.random.default_rng(7)
stars=Image.new('L',(S,S),0); d=ImageDraw.Draw(stars)
for _ in range(260):
    x,y=rng.uniform(0,S,2); r=rng.choice([0.8,1.0,1.3,1.8,2.6],p=[.35,.3,.2,.1,.05]); v=int(rng.uniform(120,255))
    d.ellipse((x-r,y-r,x+r,y+r),fill=v)
st=np.asarray(stars.filter(ImageFilter.GaussianBlur(0.7))).astype(float)/255
glow=np.asarray(stars.filter(ImageFilter.GaussianBlur(4))).astype(float)/255
bg=np.clip(bg+st[...,None]*np.array([0.95,0.97,1])+glow[...,None]*np.array([0.35,0.45,0.8])*0.6,0,1)
yy,xx=np.mgrid[0:S,0:S]/(S-1)
r=np.sqrt((xx-0.45)**2+(yy-0.42)**2)
bg=bg*np.clip(1-0.6*np.clip((r-0.3)/0.5,0,1)**1.4,0,1)[...,None]
out=Image.fromarray((np.clip(O1+T[...,None]*bg,0,1)*255+0.5).astype(np.uint8))
for s in [1024,512,192,180]:
    out.resize((s,s),Image.LANCZOS).save(OUTDIR+f'icon-{s}.png',optimize=True)
