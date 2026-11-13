"""Serve the web directory with one explorer's generated data, keeping the snapshots private."""

import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from sites import load_site, site_names

WEB = Path(__file__).resolve().parents[1] / "web"


def handler_for(site):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(WEB), **kwargs)

        def translate_path(self, path):
            # Every explorer shares the interface; only /data/ differs.
            translated = Path(super().translate_path(path))
            try:
                relative = translated.relative_to(WEB / "data")
            except ValueError:
                return str(translated)
            return str(site.output / relative)

        def end_headers(self):
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            super().end_headers()

        def log_message(self, format_string, *args):
            if args and str(args[1]) not in ("200", "304"):
                super().log_message(format_string, *args)

    return Handler


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", default="plato", choices=site_names())
    parser.add_argument("--port", type=int, default=5173)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    site = load_site(args.site)
    server = ThreadingHTTPServer((args.host, args.port), handler_for(site))
    print(f"{site.name} explorer: http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
