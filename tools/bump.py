# 使い方: python3 tools/bump.py 1.5.1  （画面・API・version.json の版をまとめて更新）
import re, sys, json, pathlib
v = sys.argv[1]; root = pathlib.Path(__file__).resolve().parent.parent
def sub(path, pat, rep):
    p = root / path; s = p.read_text(encoding='utf-8'); n = re.sub(pat, rep, s); p.write_text(n, encoding='utf-8')
sub('app.js', r"const VER = '[^']*'", f"const VER = '{v}'")
sub('index.html', r"\?v=[0-9.]+", f"?v={v}")
sub('index.html', r"var V='[^']*'", f"var V='{v}'")
sub('worker/worker.js', r"const VERSION = '[^']*'", f"const VERSION = '{v}'")
(root / 'version.json').write_text(json.dumps({'v': v}) + '\n', encoding='utf-8')
print('version', v)
