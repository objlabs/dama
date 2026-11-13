"""Dependency-free smoke-test app, not a production Python server template."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        base = os.environ.get("DAMA_BASE_PATH", "").rstrip("/")
        path = urlsplit(self.path).path
        allowed = (base + "/", base + "/health")
        body = json.dumps({"service": "python-api", "ok": path in allowed}).encode()
        self.send_response(200 if path in allowed else 404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8000"))), Handler).serve_forever()
