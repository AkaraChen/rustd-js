"""Generate the committed constant oracle corpus using the current Go architecture."""
from pathlib import Path
import re
import subprocess
import sys

output = Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)
source = Path('packages/rustd-gotool/test/constant.test.mjs').read_text()
pattern = r"const generated = go\(\['([^']+)'\]\);\s*assert.equal\(generated.status, 0, generated.stderr\);\s*const committed = readFileSync\(new URL\('\./([^']+)'"
cases = re.findall(pattern, source)
if not cases:
    raise RuntimeError('No fixture generation commands found')
subprocess.run(['go', 'version'], check=True)
subprocess.run(['go', 'env', 'GOOS', 'GOARCH'], check=True)
for flag, filename in cases:
    result = subprocess.run(['go', 'run', './tools/gofixtures/gotool', flag], check=True, capture_output=True)
    (output / filename).write_bytes(result.stdout)
    print(f'go run ./tools/gofixtures/gotool {flag} -> {filename}: {len(result.stdout)} bytes', flush=True)
