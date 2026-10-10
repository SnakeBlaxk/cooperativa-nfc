# Genera los íconos de Zuki Pay (opción J) para PWA y escritorio.
import re, io, cairosvg
from PIL import Image
SRC='/workspace/logo-zukipay/opcion-J/'
ic=open(SRC+'icon.svg').read()
lg=open(SRC+'logo.svg').read()
def png(svg,w,h=None):
    return Image.open(io.BytesIO(cairosvg.svg2png(bytestring=svg.encode(),output_width=w,output_height=h or w))).convert('RGBA')
inner=ic[ic.index('>')+1:ic.rindex('</svg>')]
defs=inner[:inner.index('</defs>')+7]; body=inner[inner.index('</defs>')+7:]
# opaco a sangre completa (fondo cuadrado navy), arte escalado a k
def full(k):
    b=body.replace('rx="230" fill="url(#g)"','fill="url(#g)"',1)
    first=b.index('/>')+2
    bg,rest=b[:first],b[first:]
    rest=re.sub(r'<rect width="1024" height="1024" rx="230" fill="url\(#sh\)"/><rect x="6"[^>]*/>','',rest)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">{defs}{bg}<g transform="translate(512 512) scale({k}) translate(-512 -512)">{rest}</g><rect width="1024" height="1024" fill="url(#sh)"/></svg>'
P='server/public/'
png(full(0.92),180).convert('RGB').save(P+'apple-touch-icon.png')
for s in (192,512):
    png(ic,s).save(P+f'icon-{s}.png')
    png(full(0.72),s).convert('RGB').save(P+f'icon-maskable-{s}.png')
png(ic,32).save(P+'favicon-32.png')
png(ic,256).save(P+'favicon.ico',sizes=[(16,16),(32,32),(48,48)])
png(ic,1024).save('build/icon.png')
big=png(ic,256); big.save('build/icon.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
# logo horizontal sin fondo blanco
t=lg.replace('<rect width="1400" height="400" fill="#fff"/>','',1)
png(t,700,200).save(P+'logo-zukipay.png')
t2=t.replace('fill="#0B1230"','fill="#FFFFFF"')
png(t2,700,200).save(P+'logo-zukipay-blanco.png')
