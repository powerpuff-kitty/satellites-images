"""Offline real-SDK request-path probe; reuses existing compiled Rust artifacts.
Run: python3 tools/audit/results/2026-10-16-codebase-rust-path.py
If rlibs were built with another toolchain, set AUDIT_RUST_TOOLCHAIN accordingly.
"""
import http.server
import json
import os
import pathlib
import subprocess
import tempfile
import threading
root = pathlib.Path(__file__).resolve().parents[3]
deps = root / 'crates/satellites-images/target/debug/deps'
latest = lambda pattern: max(deps.glob(pattern), key=lambda p: p.stat().st_mtime)
sdk = latest('libsatellites_images*.rlib')
fingerprint = deps.parent / '.fingerprint'
sdk_meta = json.loads((fingerprint / ('satellites-images-' + sdk.stem.split('-')[-1]) / 'lib-satellites_images.json').read_text())
tokio_id = next(dep[3] for dep in sdk_meta['deps'] if dep[1] == 'tokio')
tokio_dir = next(directory for directory in fingerprint.glob('tokio-*') if (directory / 'lib-tokio').exists() and int.from_bytes(bytes.fromhex((directory / 'lib-tokio').read_text()), 'little') == tokio_id)
tokio_rlib = deps / ('lib' + tokio_dir.name + '.rlib')
binary = pathlib.Path(tempfile.mkdtemp(prefix='satellites-audit-rust-')) / 'probe'
subprocess.run(['rustc', '+' + os.environ.get('AUDIT_RUST_TOOLCHAIN', '1.88.0'), '--edition=2021', str(pathlib.Path(__file__).with_suffix('.rs')),
    '--extern', f'satellites_images={sdk}',
    '--extern', f'tokio={tokio_rlib}', '-L', f'dependency={deps}', '-o', str(binary)], check=True)
seen = []
class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length', 0)))
        seen.append(self.path)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"features":[],"links":[]}')
    def log_message(self, *args):
        pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    for path in ['/api/stac/v1', '/bdc/stac/v1', '/stac/ASF', '/v1/']:
        print('base path:', path, flush=True)
        subprocess.run([str(binary), f'http://127.0.0.1:{server.server_port}' + path], check=True)
        print('observed request:', seen[-1], flush=True)
finally:
    server.shutdown()
