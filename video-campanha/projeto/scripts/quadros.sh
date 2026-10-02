#!/bin/sh
# Renderiza quadros-chave e monta uma folha de contato. Uso: sh scripts/quadros.sh nome f1 f2 ...
nome=$1; shift
mkdir -p ../quadros
for fr in "$@"; do npx remotion still Filme ../quadros/q$fr.png --frame=$fr --log=error >/dev/null 2>&1 || echo "falhou $fr"; done
python - "$nome" "$@" <<'PY'
import sys
from PIL import Image, ImageDraw
nome=sys.argv[1]; fs=sys.argv[2:]
ims=[]
for f in fs:
    try: ims.append((f,Image.open(f'../quadros/q{f}.png').convert('RGB').resize((640,360))))
    except Exception as e: print('sem', f)
cols=2; rows=(len(ims)+1)//2
s=Image.new('RGB',(cols*650,rows*390),(0,0,0))
d=ImageDraw.Draw(s)
for i,(f,im) in enumerate(ims):
    x=(i%cols)*650; y=(i//cols)*390
    s.paste(im,(x,y)); d.text((x+6,y+364),f'{int(f)//30//60}:{int(f)//30%60:02d}.{int(f)%30:02d}  q{f}',fill=(200,190,255))
s.save(f'../quadros/{nome}.png')
PY
