"""Deterministic, key-free extension ZIP. Uses only Python's standard library."""
import argparse, hashlib, json, re, zipfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--tag', help='Release tag must exactly match v<manifest version>')
args = parser.parse_args()
manifest = json.loads((root / 'extension/manifest.json').read_text())
package = json.loads((root / 'package.json').read_text())
version = manifest['version']
if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version) or any(int(x)>65535 for x in version.split('.')):
    raise SystemExit('Invalid Chrome version')
if package['version'] != version:
    raise SystemExit('Version mismatch; use npm run version:set -- X.Y.Z')
if args.tag and args.tag != f'v{version}':
    raise SystemExit(f'Tag {args.tag} does not match manifest version v{version}')
files = sorted(p for p in (root / 'extension').rglob('*') if p.is_file())
for p in files:
    if p.is_symlink() or p.suffix not in {'.js', '.json', '.html', '.css', '.png', '.svg'} or any(part.startswith('.') for part in p.relative_to(root / 'extension').parts):
        raise SystemExit(f'Unexpected extension file: {p.name}')
    if p.suffix in {'.js', '.json', '.html', '.css'} and re.search(r'(?:sk-|apikey_)[A-Za-z0-9_]{16,}', p.read_text()):
        raise SystemExit(f'Possible secret in {p.name}')
dist = root / 'dist'
dist.mkdir(exist_ok=True)
archive = dist / f'bilibili-ad-skipper-v{version}.zip'
with zipfile.ZipFile(archive, 'w') as z:
    for p in files:
        info = zipfile.ZipInfo(p.relative_to(root / 'extension').as_posix(), (2020,1,1,0,0,0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        z.writestr(info, p.read_bytes())
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    assert 'manifest.json' in z.namelist()
    assert json.loads(z.read('manifest.json'))['version'] == version
    for p in files:
        assert z.read(p.relative_to(root / 'extension').as_posix()) == p.read_bytes()
stable = dist / 'bilibili-ad-skipper.zip'
stable.write_bytes(archive.read_bytes())
checksums = '\n'.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}' for p in [archive,stable])+'\n'
(dist / 'SHA256SUMS.txt').write_text(checksums)
print(f'Built {archive.name}: {len(files)} files, {archive.stat().st_size} bytes; ZIP root has manifest.json')
