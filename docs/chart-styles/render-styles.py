# 用真的 TSLA 5 分 K，把幾種畫法各畫一次，都塞進 5 個文字列 × 62 欄
# Usage: python3 render-styles.py <path-to-yahoo-chart-json>
import json
import sys

data_path = sys.argv[1] if len(sys.argv) > 1 else 'tsla.json'
d = json.load(open(data_path))
r = d['chart']['result'][0]; q = r['indicators']['quote'][0]
prev = r['meta']['chartPreviousClose']
bars = [(o,h,l,c) for o,h,l,c in zip(q['open'],q['high'],q['low'],q['close']) if c is not None]
W, ROWS = 62, 5

def scale(vals):
    hi = max(max(b[1] for b in bars), prev); lo = min(min(b[2] for b in bars), prev)
    return hi, lo, (hi-lo) or 1

hi, lo, span = scale(bars)
def resample(n):
    out=[]
    for i in range(n):
        a=int(i*len(bars)/n); b=max(a+1,int((i+1)*len(bars)/n))
        chunk=bars[a:b]
        out.append((chunk[0][0], max(x[1] for x in chunk), min(x[2] for x in chunk), chunk[-1][3]))
    return out

# ---------- A. 現況：半形方塊 K 棒 ----------
def style_half():
    pix = ROWS*2
    grid=[[' ']*W for _ in range(pix)]
    bs = resample(W)
    def y(p): return min(pix-1, max(0, round((hi-p)/span*(pix-1))))
    for x,(o,h,l,c) in enumerate(bs):
        for yy in range(y(h), y(l)+1): grid[yy][x]='#'
    rows=[]
    for j in range(ROWS):
        line=''
        for x in range(W):
            t=grid[2*j][x]!=' '; b=grid[2*j+1][x]!=' '
            line += '█' if t and b else '▀' if t else '▄' if b else ' '
        rows.append(line)
    return rows

# ---------- B. Braille 折線 ----------
DOT=[[0x01,0x08],[0x02,0x10],[0x04,0x20],[0x40,0x80]]
def style_braille(fill=False):
    px, py = W*2, ROWS*4
    cells=[[0]*W for _ in range(ROWS)]
    bs = resample(px)
    def y(p): return min(py-1, max(0, round((hi-p)/span*(py-1))))
    ybase = y(prev)
    prev_y=None
    for x,(o,h,l,c) in enumerate(bs):
        yy=y(c)
        span_y = range(min(yy,ybase), max(yy,ybase)+1) if fill else (
            range(min(yy,prev_y), max(yy,prev_y)+1) if prev_y is not None else [yy])
        for t in span_y:
            cells[t//4][x//2] |= DOT[t%4][x%2]
        prev_y=yy
    return [''.join(chr(0x2800+v) if v else ' ' for v in row) for row in cells]

# ---------- C. 一格一根的粗 K 棒 ----------
def style_candles(n=30):
    pix=ROWS*2
    bs=resample(n)
    grid=[[' ']*W for _ in range(pix)]
    def y(p): return min(pix-1,max(0,round((hi-p)/span*(pix-1))))
    step = W//n
    for i,(o,h,l,c) in enumerate(bs):
        x = i*step
        for yy in range(y(h),y(l)+1): grid[yy][x]='|'
        for yy in range(min(y(o),y(c)),max(y(o),y(c))+1):
            for dx in range(0,min(step-1,2)): grid[yy][x+dx]='#'
    rows=[]
    for j in range(ROWS):
        line=''
        for x in range(W):
            t=grid[2*j][x]; b=grid[2*j+1][x]
            tf=t!=' '; bf=b!=' '
            line += '█' if tf and bf else '▀' if tf else '▄' if bf else ' '
        rows.append(line)
    return rows

for name, rows in [('A 現況（半形方塊 K 棒，79 根擠 62 欄）', style_half()),
                   ('B Braille 折線（2×4 點，垂直 20 級、水平 124 取樣）', style_braille(False)),
                   ('C Braille 面積（同上，從昨收填滿）', style_braille(True)),
                   ('D 聚合成 30 根的粗 K 棒', style_candles())]:
    print(f'--- {name} ---')
    for r_ in rows: print('|'+r_+'|')
    print()

# ---------- E. 昨收為 0 軸的落差柱 ----------
def style_dev():
    pix=ROWS*2
    grid=[[' ']*W for _ in range(pix)]
    bs=resample(W)
    def y(p): return min(pix-1,max(0,round((hi-p)/span*(pix-1))))
    base=y(prev)
    for x,(o,h,l,c) in enumerate(bs):
        yy=y(c)
        for t in range(min(yy,base),max(yy,base)+1): grid[t][x]='#'
    rows=[]
    for j in range(ROWS):
        line=''
        for x in range(W):
            t=grid[2*j][x]!=' '; b=grid[2*j+1][x]!=' '
            line += '█' if t and b else '▀' if t else '▄' if b else ' '
        rows.append(line)
    return rows

# ---------- F. 20 根、每根 3 欄的粗 K 棒 ----------
def style_fat(n=20):
    pix=ROWS*2
    bs=resample(n); grid=[[' ']*W for _ in range(pix)]
    def y(p): return min(pix-1,max(0,round((hi-p)/span*(pix-1))))
    step=W//n
    for i,(o,h,l,c) in enumerate(bs):
        x=i*step
        for yy in range(y(h),y(l)+1): grid[yy][x+1]='|'
        for yy in range(min(y(o),y(c)),max(y(o),y(c))+1):
            for dx in range(step-1): grid[yy][x+dx]='#'
    rows=[]
    for j in range(ROWS):
        line=''
        for x in range(W):
            t=grid[2*j][x]!=' '; b=grid[2*j+1][x]!=' '
            line += '█' if t and b else '▀' if t else '▄' if b else ' '
        rows.append(line)
    return rows

for name, rows in [('E 昨收為基準的落差柱', style_dev()), ('F 20 根粗 K 棒（每根 3 欄）', style_fat())]:
    print(f'--- {name} ---')
    for r_ in rows: print('|'+r_+'|')
    print()
