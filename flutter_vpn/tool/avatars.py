"""Draws the 14 Pleat profile characters into assets/avatars/<id>.svg.

Run from flutter_vpn/: python3 tool/avatars.py. Edit the shapes here, not the SVG files.
Rules of the set: only the Pleat planes (navy, blue, ice, mist) and white, with peach and gold for
beaks and cheeks; eyes are shards at the mark's slant; one slanted pleat fold across each body;
every avatar carries its own round background, so it reads on light and on navy.
"""
import math, os
NAVY='#14284B'; BLUE='#2F89F5'; ICE='#A9D4F5'; MIST='#D7E9FA'; W='#FFFFFF'; INK='#16181D'
PEACH='#F4D8C6'; WARM='#E9A98A'; GOLD='#FFD58A'
SL=0.325
def f(x): return ('%.2f'%x).rstrip('0').rstrip('.')
def rp(pts,r):
    n=len(pts); d=[]
    for i in range(n):
        px,py=pts[i-1]; cx,cy=pts[i]; nx,ny=pts[(i+1)%n]
        ix,iy=cx-px,cy-py; ox,oy=nx-cx,ny-cy
        li=math.hypot(ix,iy); lo=math.hypot(ox,oy)
        rr=min(r,li/2,lo/2)
        ax,ay=cx-ix/li*rr,cy-iy/li*rr; bx,by=cx+ox/lo*rr,cy+oy/lo*rr
        d.append(('M' if i==0 else 'L')+f(ax)+' '+f(ay)+' Q'+f(cx)+' '+f(cy)+' '+f(bx)+' '+f(by))
    return ' '.join(d)+'Z'
def shard(cx,cy,w,h,r=None,slant=SL):
    run=h*slant
    if r is None: r=min(w,h)*0.45
    return rp([(cx-w/2+run/2,cy-h/2),(cx+w/2+run/2,cy-h/2),(cx+w/2-run/2,cy+h/2),(cx-w/2-run/2,cy+h/2)],r)
def P(d,fill,extra=''): return f'<path d="{d}" fill="{fill}"{extra}/>'
def eyes(x1,x2,y,c,w=6.5,h=11): return P(shard(x1,y,w,h),c)+P(shard(x2,y,w,h),c)
def circ(cx,cy,r,fill): return f'<circle cx="{f(cx)}" cy="{f(cy)}" r="{f(r)}" fill="{fill}"/>'
def ell(cx,cy,rx,ry,fill): return f'<ellipse cx="{f(cx)}" cy="{f(cy)}" rx="{f(rx)}" ry="{f(ry)}" fill="{fill}"/>'
uid=[0]
def pleat(shape_svg_d, color=W, op=0.16, x=78, w=16):
    """The signature: one slanted fold band across the main body, clipped to it."""
    uid[0]+=1; i=f'k{uid[0]}'
    band=shard(x,60,w,140,r=0)
    return f'<clipPath id="{i}"><path d="{shape_svg_d}"/></clipPath><path d="{band}" fill="{color}" opacity="{op}" clip-path="url(#{i})"/>'

C=[]
def ch(name, kind, bg, body): C.append((name,kind,bg,body))
def wh(cx,cy,r): return circ(cx,cy,r,PEACH)

# 1 Fox
head=rp([(26,24),(50,42),(70,42),(94,24),(92,64),(60,98),(28,64)],7)
ch('Vesper','Fox',ICE, P(head,BLUE)+P(rp([(60,42),(70,42),(94,24),(92,64),(60,98)],7),NAVY)
   +P(rp([(36,68),(84,68),(60,97)],6),W)+eyes(47,73,57,W,6,10)+P(rp([(54,85),(66,85),(60,93)],2.5),NAVY))
# 2 Kite (bird)
b='M24 78a36 36 0 1 0 72 0a36 36 0 1 0 -72 0Z'
ch('Kite','Bird',MIST, P(shard(52,34,10,26),NAVY)+P(shard(65,30,10,32),BLUE)
   +P(b,BLUE)+pleat(b)+ell(60,96,24,18,MIST)+P(shard(90,86,14,32),NAVY)+P(shard(30,86,14,32),NAVY)
   +eyes(48,72,68,NAVY,7,12)+P(rp([(54,78),(66,78),(60,88)],3),GOLD))
# 3 Cat
h=rp([(28,44),(36,20),(52,36),(68,36),(84,20),(92,44),(94,72),(78,96),(42,96),(26,72)],8)
ch('Miso','Cat',NAVY, P(h,ICE)+pleat(h,W,0.3)+P(rp([(36,30),(46,38),(36,44)],3),BLUE)+P(rp([(84,30),(74,38),(84,44)],3),BLUE)
   +eyes(47,73,62,NAVY,6.5,12)+P(rp([(56,74),(64,74),(60,79)],2),WARM)
   +'<g stroke="#14284B" stroke-width="2" stroke-linecap="round" opacity=".45"><path d="M24 74l16 2M24 82l16-2M96 74l-16 2M96 82l-16-2"/></g>')
# 4 Owl
o=rp([(30,28),(46,40),(74,40),(90,28),(94,66),(88,120),(32,120),(26,66)],9)
ch('Hoot','Owl',BLUE, P(o,NAVY)+pleat(o)+circ(46,64,14,MIST)+circ(74,64,14,MIST)
   +eyes(46,74,64,NAVY,6.5,11)+P(rp([(55,76),(65,76),(60,86)],2.5),GOLD)
   +P(shard(50,102,7,6,2.5),ICE)+P(shard(60,102,7,6,2.5),ICE)+P(shard(70,102,7,6,2.5),ICE))
# 5 Bear
hb='M28 68a32 32 0 1 0 64 0a32 32 0 1 0 -64 0Z'
ch('Bruno','Bear',MIST, circ(36,40,12,NAVY)+circ(84,40,12,NAVY)+circ(36,40,6,ICE)+circ(84,40,6,ICE)
   +P(hb,NAVY)+pleat(hb)+ell(60,80,15,12,ICE)+eyes(48,72,62,W,6,10)+P(rp([(54,74),(66,74),(60,81)],3),NAVY))
# 8 Robot
rh=rp([(28,36),(92,36),(92,90),(28,90)],14)
ch('Relay','Robot',MIST, '<path d="M60 22V36" stroke="#14284B" stroke-width="3"/>'+circ(60,21,5,BLUE)
   +P(rp([(20,54),(30,54),(30,72),(20,72)],3),BLUE)+P(rp([(90,54),(100,54),(100,72),(90,72)],3),BLUE)
   +P(rp([(40,90),(80,90),(80,120),(40,120)],0),NAVY)+P(rh,NAVY)+pleat(rh)
   +P(shard(60,58,52,22,9),BLUE)+eyes(49,71,58,W,6,11)
   +P(shard(48,78,6,4,2),ICE)+P(shard(60,78,6,4,2),ICE)+P(shard(72,78,6,4,2),ICE))
# 9 Astronaut
ch('Orbit','Astronaut',NAVY, P(rp([(18,124),(28,98),(92,98),(102,124)],12),W)+P(rp([(44,98),(76,98),(72,106),(48,106)],3),ICE)
   +circ(60,60,34,W)+P(shard(60,62,50,34,15),BLUE)
   +'<clipPath id="vz"><path d="'+shard(60,62,50,34,15)+'"/></clipPath><path d="'+shard(76,62,7,60,0)+'" fill="#fff" opacity=".35" clip-path="url(#vz)"/>'
   +eyes(50,70,62,W,6,11))
# 10 Ghost
gh='M32 112V58a28 28 0 0 1 56 0V112L81 104L74 112L67 104L60 112L53 104L46 112L39 104Z'
ch('Drift','Ghost',BLUE, P(gh,W)+pleat(gh,BLUE,0.10)+eyes(50,70,58,NAVY,6.5,12)+ell(60,76,4,5,NAVY)
   +circ(42,70,4,PEACH)+circ(78,70,4,PEACH))
# 11 Rabbit
hr='M32 78a28 28 0 1 0 56 0a28 28 0 1 0 -56 0Z'
ch('Hop','Rabbit',ICE, P(shard(47,32,15,46,7.5),W)+P(shard(73,30,15,46,7.5),W)
   +P(shard(47,34,6,30,3),MIST)+P(shard(73,32,6,30,3),MIST)
   +P(hr,W)+pleat(hr,ICE,0.35)+eyes(49,71,76,NAVY,6,10.5)+P(rp([(56,86),(64,86),(60,91)],2),WARM)
   +circ(41,88,4.5,PEACH)+circ(79,88,4.5,PEACH))
# 12 Cloud
cl='M30 86a16 16 0 0 1 4-30a24 24 0 0 1 44-6a18 18 0 0 1 14 36Z'
ch('Nimbus','Cloud',NAVY, P(cl,W)+pleat(cl,ICE,0.45)+eyes(52,72,68,NAVY,6,10.5)
   +'<path d="M56 78q6 5 12 0" stroke="#14284B" stroke-width="2.6" fill="none" stroke-linecap="round"/>'
   +P(shard(44,100,5,12),ICE)+P(shard(60,104,5,12),BLUE)+P(shard(76,100,5,12),ICE))
# 14 Dino
dh=rp([(30,124),(32,62),(48,40),(86,40),(98,54),(97,72),(66,76),(64,124)],10)
ch('Rex','Dino',ICE, P(shard(40,40,8,16),NAVY)+P(shard(30,56,8,16),NAVY)+P(shard(26,76,8,16),NAVY)+P(shard(26,96,8,16),NAVY)
   +P(dh,BLUE)+pleat(dh,W,0.16,70)+P(shard(76,54,6.5,11),W)+P(shard(92,50,3,4,1.5),NAVY)
   +'<path d="M70 70L92 68" stroke="#14284B" stroke-width="2.4" stroke-linecap="round"/>'+P(rp([(74,72),(80,72),(77,78)],1.5),W)+P(rp([(84,71),(90,71),(87,77)],1.5),W))

def person(skin, blush, top, hair_back, hair_front, extra='', eyec=NAVY):
    face='M38 68a22 25 0 1 0 44 0a22 25 0 1 0 -44 0Z'
    return (hair_back+P(rp([(20,126),(28,100),(92,100),(100,126)],16),top)+pleat(rp([(20,126),(28,100),(92,100),(100,126)],16),W,0.16,70)
      +P(rp([(52,82),(68,82),(68,102),(52,102)],4),skin)+P(face,skin)
      +circ(45,79,4.5,blush)+circ(75,79,4.5,blush)+eyes(51,69,70,eyec,5.5,9.5)
      +'<path d="M55 82q5 4 10 0" stroke="#14284B" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
      +hair_front+extra)
# Girl 1: long hair, slanted fringe
hb=rp([(30,52),(44,32),(80,32),(92,52),(96,112),(24,112)],18)
hf=rp([(36,66),(38,44),(58,32),(82,38),(86,64),(80,52),(50,54)],8)
ch('Luna','Long hair',ICE, person(PEACH,'#EDB9A4',BLUE,P(hb,NAVY)+pleat(hb,W,0.14,74),P(hf,NAVY),P(shard(78,48,4,10,2),GOLD)))
# Girl 2: top bun, bob
bb=rp([(32,58),(40,38),(80,38),(88,58),(90,88),(30,88)],14)
bf=rp([(36,64),(40,42),(62,34),(84,42),(86,62),(66,50),(44,52)],8)
ch('Mina','Bun',BLUE, person(WARM,'#DD9275',MIST,circ(60,28,13,NAVY)+P(bb,NAVY),P(bf,NAVY)+pleat(bf,W,0.16,66),P(shard(60,40,14,4,2),ICE)))
# Boy: short quiff, hoodie
qf=rp([(37,62),(36,44),(52,32),(78,30),(86,44),(84,60),(78,50),(46,50)],8)
ch('Kai','Short hair',MIST, person(PEACH,'#EDB9A4',NAVY,'',P(qf,NAVY)+pleat(qf,W,0.18,68,12),
   P(rp([(46,100),(60,112),(74,100)],3),ICE)+'<path d="M54 104v10M66 104v10" stroke="#A9D4F5" stroke-width="2.2" stroke-linecap="round"/>'))

OUT='assets/avatars'
import re
def svg(bg,body):
    # clip paths go in <defs> so every renderer (flutter_svg included) finds them
    clips=re.findall(r'<clipPath.*?</clipPath>',body); body=re.sub(r'<clipPath.*?</clipPath>','',body)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs>'
            f'<clipPath id="c"><circle cx="60" cy="60" r="60"/></clipPath>{"".join(clips)}</defs><g clip-path="url(#c)">'
            f'<rect width="120" height="120" fill="{bg}"/>{body}</g></svg>')
os.makedirs(OUT,exist_ok=True)
for n,k,bg,body in C:
    open(f'{OUT}/{n.lower()}.svg','w').write(svg(bg,body)+'\n')
print(', '.join(n.lower() for n,*_ in C))
