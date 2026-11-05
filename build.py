import pathlib
root = pathlib.Path(__file__).parent
engine = (root/'engine.js').read_text() + '\n' + (root/'app/worker.js').read_text()
assert '</script' not in engine.lower()
html = (root/'app/app.html').read_text().replace('/*ENGINE*/', engine)
(root/'dist').mkdir(exist_ok=True)
(root/'dist/index.html').write_text(html)
wrapped = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
           '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}</style></head><body>' + html + '</body></html>')
(root/'server/index.html').write_text(wrapped)
print('built', len(html)//1024, 'KB')

import base64, gzip
b64 = base64.b64encode(gzip.compress(wrapped.encode(), 9)).decode()
chunks = '",\n  "'.join(b64[i:i + 1200] for i in range(0, len(b64), 1200))
ts = (root/'server/railway_function.template.ts').read_text().replace('"__INDEX_GZ_B64__"', '[\n  "' + chunks + '",\n].join("")')
(root/'dist/railway_function.ts').write_text(ts)
print('railway function', len(ts)//1024, 'KB')
