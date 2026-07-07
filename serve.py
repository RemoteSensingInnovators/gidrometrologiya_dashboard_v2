#!/usr/bin/env python3
"""Local dev server for the dashboard, plus a same-origin OpenStreetMap
tile proxy (with on-disk caching) so the 3D scene can use raster tiles as
WebGL textures without hitting CORS restrictions."""

import http.server
import os
import re
import socketserver
import ssl
import urllib.request

PORT = 8000
ROOT = os.path.dirname(os.path.abspath(__file__))
TILE_CACHE_DIR = os.path.join(ROOT, '.tile_cache')
TILE_RE = re.compile(r'^/osmtiles/(\d+)/(\d+)/(\d+)\.png$')
SUBDOMAINS = ['a', 'b', 'c']

os.makedirs(TILE_CACHE_DIR, exist_ok=True)

# Some antivirus/corporate networks intercept HTTPS with their own certificate.
# Windows (and your browser) trusts it automatically; Python's own CA bundle
# usually doesn't, so tile downloads fail with a certificate error even though
# the browser itself works fine. Fall back to an unverified context only for
# this one case, and only for fetching public, non-sensitive map tile images.
_INSECURE_SSL_CONTEXT = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
_INSECURE_SSL_CONTEXT.check_hostname = False
_INSECURE_SSL_CONTEXT.verify_mode = ssl.CERT_NONE
_warned_insecure = False


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        match = TILE_RE.match(self.path)
        if match:
            self.serve_tile(*match.groups())
            return
        super().do_GET()

    def end_headers(self):
        # Force the browser to always fetch fresh HTML/JS/CSS instead of an old
        # cached copy from before the last edit (tile responses set their own
        # long-lived cache headers separately, in serve_tile).
        if not TILE_RE.match(self.path.split('?')[0]):
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
        super().end_headers()

    def serve_tile(self, z, x, y):
        global _warned_insecure
        cache_path = os.path.join(TILE_CACHE_DIR, f'{z}_{x}_{y}.png')
        if not os.path.exists(cache_path):
            sub = SUBDOMAINS[(int(x) + int(y)) % len(SUBDOMAINS)]
            url = f'https://{sub}.tile.openstreetmap.org/{z}/{x}/{y}.png'
            req = urllib.request.Request(url, headers={'User-Agent': 'samarqand-dashboard/1.0'})
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = resp.read()
            except Exception as exc:
                # urllib wraps SSL failures inside URLError, so check the message
                # rather than the exception type.
                is_cert_error = 'CERTIFICATE_VERIFY_FAILED' in str(exc) or isinstance(
                    getattr(exc, 'reason', None), ssl.SSLCertVerificationError
                )
                if not is_cert_error:
                    self.send_error(502, f'Tile fetch failed: {exc}')
                    return
                if not _warned_insecure:
                    print('WARNING: tile server TLS certificate could not be verified '
                          '(likely antivirus/corporate HTTPS interception) — '
                          'falling back to an unverified connection for map tiles only.')
                    _warned_insecure = True
                try:
                    with urllib.request.urlopen(req, timeout=10, context=_INSECURE_SSL_CONTEXT) as resp:
                        data = resp.read()
                except Exception as exc2:
                    self.send_error(502, f'Tile fetch failed: {exc2}')
                    return
            with open(cache_path, 'wb') as f:
                f.write(data)
        with open(cache_path, 'rb') as f:
            data = f.read()
        self.send_response(200)
        self.send_header('Content-Type', 'image/png')
        self.send_header('Cache-Control', 'public, max-age=604800')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        if TILE_RE.match(self.path.split('?')[0]):
            return
        super().log_message(fmt, *args)


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == '__main__':
    os.chdir(ROOT)
    with ThreadingHTTPServer(('', PORT), Handler) as httpd:
        print(f'Serving {ROOT} on http://localhost:{PORT}')
        print(f'OSM tile proxy: http://localhost:{PORT}/osmtiles/{{z}}/{{x}}/{{y}}.png (cached in .tile_cache/)')
        httpd.serve_forever()
