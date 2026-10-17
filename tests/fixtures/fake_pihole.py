"""An isolated HTTP fixture for proxy tests; it never contacts a real Pi-hole."""

import argparse
import base64
import json
import ssl
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


class FixtureServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, name):
        super().__init__(address, FixtureHandler)
        self.fixture_name = name
        self.requests = []
        self.request_lock = threading.Lock()


class FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def send_json(self, value, status=200):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def handle_request(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        path = urlsplit(self.path).path
        if path == "/__fixture__/health":
            return self.send_json({"ready": True})
        if path == "/__fixture__/requests":
            with self.server.request_lock:
                requests = list(self.server.requests)
            return self.send_json(requests)
        if path == "/__fixture__/reset" and self.command == "POST":
            with self.server.request_lock:
                self.server.requests.clear()
            return self.send_json({"reset": True})

        record = {
            "backend": self.server.fixture_name,
            "method": self.command,
            "path": self.path,
            "headers": {key.lower(): value for key, value in self.headers.items()},
            "bodyBase64": base64.b64encode(body).decode("ascii"),
        }
        with self.server.request_lock:
            self.server.requests.append(record)
        if path == "/api/__fixture__/unauthorized":
            return self.send_json({"error": {"message": "Fixture authorization error"}}, 401)
        if path == "/api/__fixture__/no-content":
            self.send_response(204)
            self.end_headers()
            return
        if path == "/api/auth" and self.command == "POST":
            record["session"] = {"sid": "fixture-session-" + self.server.fixture_name}
        self.send_json(record)

    do_GET = handle_request
    do_HEAD = handle_request
    do_POST = handle_request
    do_PUT = handle_request
    do_DELETE = handle_request


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8081)
    parser.add_argument("--name", default="fixture")
    parser.add_argument("--tls-cert")
    parser.add_argument("--tls-key")
    args = parser.parse_args()
    if bool(args.tls_cert) != bool(args.tls_key):
        parser.error("--tls-cert and --tls-key must be supplied together")
    with FixtureServer(("0.0.0.0", args.port), args.name) as server:
        if args.tls_cert:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(args.tls_cert, args.tls_key)
            server.socket = context.wrap_socket(server.socket, server_side=True)
        print(f"Fixture ready on port {server.server_port}", flush=True)
        server.serve_forever()
