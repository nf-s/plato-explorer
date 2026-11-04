"""Serve only the web directory, keeping the original datasets private."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "web"


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, format_string, *args):
        if args and str(args[1]) not in ("200", "304"):
            super().log_message(format_string, *args)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5173)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    handler = partial(Handler, directory=str(WEB))
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Plato Explorer: http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
