"""Run the requested gates, preserving stdout/stderr and actual exit codes."""
import json
import os
from pathlib import Path
import subprocess
import time

root = Path(__file__).resolve().parents[2]
raw = root / 'reports/tls-merge/raw'
steps = [
    ('install', ['zsh', '-c', 'rm -rf node_modules && pnpm install --frozen-lockfile'], 'rm -rf node_modules && pnpm install --frozen-lockfile'),
    ('mail-build', ['nice', '-n', '10', 'pnpm', '--filter', 'rustd-mail', 'build'], 'CARGO_BUILD_JOBS=4 nice -n 10 pnpm --filter rustd-mail build'),
    ('mail-test', ['nice', '-n', '10', 'pnpm', '--filter', 'rustd-mail', 'test'], 'CARGO_BUILD_JOBS=4 nice -n 10 pnpm --filter rustd-mail test'),
    ('typecheck', ['pnpm', 'typecheck'], 'pnpm typecheck'),
]
# main changed these native sources too. Rebuild sequentially before full tests.
for package in ('rustd-gotool', 'rustd-mime', 'rustd-serial'):
    steps.append((package + '-build', ['nice', '-n', '10', 'pnpm', '--filter', package, 'build'], f'CARGO_BUILD_JOBS=4 nice -n 10 pnpm --filter {package} build'))
steps.append(('test', ['pnpm', 'test'], 'pnpm test'))
results = []
with (raw / 'environment.log').open('w') as log:
    for command in (['node', '--version'], ['pnpm', '--version'], ['rustc', '--version'], ['go', 'version']):
        log.write('$ ' + ' '.join(command) + '\n'); log.flush()
        subprocess.run(command, cwd=root, stdout=log, stderr=subprocess.STDOUT, check=True)
    log.write(f"RUSTD_GO={os.environ['RUSTD_GO']} CARGO_BUILD_JOBS={os.environ['CARGO_BUILD_JOBS']}\n")
for name, command, display in steps:
    path = raw / f'{name}.log'
    print('START', name, flush=True)
    start = time.monotonic()
    with path.open('w') as log:
        log.write('$ ' + display + '\n'); log.flush()
        result = subprocess.run(command, cwd=root, stdout=log, stderr=subprocess.STDOUT)
        seconds = round(time.monotonic() - start, 3)
        log.write(f'\nexit_code={result.returncode} elapsed_seconds={seconds}\n')
    results.append({'step': name, 'command': display, 'exit_code': result.returncode, 'elapsed_seconds': seconds, 'log': str(path.relative_to(root))})
    (raw / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print('END', name, 'exit', result.returncode, 'seconds', seconds, flush=True)
    if result.returncode:
        raise SystemExit(result.returncode)
