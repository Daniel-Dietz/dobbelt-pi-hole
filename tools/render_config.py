#!/usr/bin/env python3
"""Validate the canonical configuration and generate browser/nginx configuration.

The renderer uses only Python's standard library. It performs no network requests,
stores no passwords and never starts an application backend.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
from html.parser import HTMLParser
import ipaddress
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlsplit, urlunsplit


MAX_CONFIG_BYTES = 128 * 1024
MAX_APP_BYTES = 4 * 1024 * 1024
LANGUAGES = {"auto", "da", "en", "de"}
CONFIG_FIELDS = {"version", "defaultLanguage", "servers"}
SERVER_FIELDS = {"id", "label", "apiUrl", "verifyTls"}
API_PATH = re.compile(r"/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*/?\Z")
HOST_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?\Z")
STALE_RESPONSE = '{"error":{"code":"dashboard_config_changed"}}'


class ConfigError(ValueError):
    """An invalid source configuration or renderer argument; safe to show to operators."""


def _has_controls(value: str) -> bool:
    """Return whether decoded text contains C0, DEL or C1 control characters.

    Check the original string before URL parsing can discard characters. The
    caller remains responsible for other restrictions such as whitespace or
    unpaired Unicode surrogates; this helper neither normalizes nor changes it.
    """
    return any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in value)


def _known_fields(value: dict, allowed: set[str], location: str) -> None:
    """Require the keys in value to belong to the allowed configuration fields.

    location identifies the object in a ConfigError when unknown keys are
    present. Values are not inspected or modified here; the caller validates
    their types and contents after this spelling/schema check succeeds.
    """
    unknown = set(value) - allowed
    if unknown:
        raise ConfigError(f"{location}: unknown field(s): {', '.join(sorted(map(str, unknown)))}")


def normalize_api_url(value: str) -> str:
    """Return a canonical HTTP(S) API URL suitable for routing and identity hashing.

    Scheme, DNS names and IP addresses are normalized; default ports and the final
    slash are removed. Credentials, URL queries/fragments and unsafe path syntax
    are rejected. No name resolution or connection attempt is made.

    value is the untrusted apiUrl field, including a non-string value when the
    input document is malformed. Return a string with an explicit HTTP(S)
    scheme, normalized authority and nonempty API path, or raise ConfigError.
    The same result is used for duplicate detection, proxying and session
    identity, so equivalent spellings must not create separate destinations.
    """
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise ConfigError("apiUrl must be a nonempty URL of at most 2048 characters")
    if _has_controls(value) or any(character.isspace() for character in value) or "\\" in value:
        raise ConfigError("apiUrl must not contain whitespace, control characters or backslashes")
    if "?" in value or "#" in value:
        raise ConfigError("apiUrl must not contain a query string or fragment")
    try:
        parsed = urlsplit(value)
        scheme = parsed.scheme.lower()
        hostname = parsed.hostname
        port = parsed.port
    except ValueError as error:
        raise ConfigError(f"apiUrl has an invalid host or port: {error}") from None
    if scheme not in {"http", "https"} or not parsed.netloc or not hostname:
        raise ConfigError("apiUrl must use http:// or https:// with a valid host")
    if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
        raise ConfigError("apiUrl must not contain credentials")
    if parsed.netloc.endswith(":"):
        raise ConfigError("apiUrl has an empty port")
    if port is not None and not 1 <= port <= 65535:
        raise ConfigError("apiUrl port must be between 1 and 65535")
    if "%" in hostname:
        raise ConfigError("apiUrl host must not contain percent escapes or IPv6 zone identifiers")
    hostname = hostname.rstrip(".")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        if re.fullmatch(r"[0-9.]+", hostname):
            raise ConfigError("apiUrl contains an invalid IPv4 address") from None
        try:
            hostname = hostname.encode("idna").decode("ascii").lower()
        except UnicodeError:
            raise ConfigError("apiUrl contains an invalid internationalized host name") from None
        if len(hostname) > 253 or not all(HOST_LABEL.fullmatch(label) for label in hostname.split(".")):
            raise ConfigError("apiUrl contains an invalid host name")
        authority = hostname
    else:
        hostname = address.compressed
        authority = f"[{hostname}]" if address.version == 6 else hostname
    if port is not None and port != (443 if scheme == "https" else 80):
        authority += f":{port}"
    if not API_PATH.fullmatch(parsed.path) or any(segment in {".", ".."} for segment in parsed.path.split("/")):
        raise ConfigError("apiUrl must have an absolute API path with only safe segments (no dot segments or escapes)")
    return urlunsplit((scheme, authority, parsed.path.rstrip("/"), "", ""))


def validate_config(data: object) -> dict:
    """Validate a parsed document and return a new normalized canonical model.

    The result contains only known fields, explicit defaults and two to four
    distinct instances. Input data is not modified.

    data is the JSON-decoded source object. Check the format version, language,
    stable instance IDs, display labels, API destinations and TLS flags. Raise
    ConfigError for invalid fields or duplicate IDs/normalized destinations.
    This checks local configuration syntax and consistency, not API availability
    or whether the supplied Pi-hole credentials will authorize an operation.
    """
    if not isinstance(data, dict):
        raise ConfigError("configuration must be a JSON object")
    _known_fields(data, CONFIG_FIELDS, "configuration")
    if type(data.get("version")) is not int or data["version"] != 1:
        raise ConfigError("version must be the integer 1")
    language = data.get("defaultLanguage", "auto")
    if not isinstance(language, str) or language not in LANGUAGES:
        raise ConfigError("defaultLanguage must be auto, da, en or de")
    servers = data.get("servers")
    if not isinstance(servers, list) or not 2 <= len(servers) <= 4:
        raise ConfigError("servers must contain two, three or four instances")
    normalized = []
    identifiers = set()
    destinations = set()
    for index, server in enumerate(servers):
        location = f"servers[{index}]"
        if not isinstance(server, dict):
            raise ConfigError(f"{location} must be an object")
        _known_fields(server, SERVER_FIELDS, location)
        identifier = server.get("id")
        if not isinstance(identifier, str) or identifier not in {"1", "2", "3", "4"}:
            raise ConfigError(f"{location}.id must be one of the strings 1, 2, 3 or 4")
        if identifier in identifiers:
            raise ConfigError(f"{location}.id duplicates another instance ID")
        label = server.get("label")
        if (
            not isinstance(label, str)
            or not label.strip()
            or len(label.strip()) > 120
            or _has_controls(label)
            or any(0xD800 <= ord(character) <= 0xDFFF for character in label)
        ):
            raise ConfigError(f"{location}.label must be valid Unicode, nonblank, contain no controls and have at most 120 characters")
        try:
            api_url = normalize_api_url(server.get("apiUrl"))
        except ConfigError as error:
            raise ConfigError(f"{location}.{error}") from None
        if api_url in destinations:
            raise ConfigError(f"{location}.apiUrl duplicates another normalized API URL")
        verify_tls = server.get("verifyTls", True)
        if type(verify_tls) is not bool:
            raise ConfigError(f"{location}.verifyTls must be a boolean")
        identifiers.add(identifier)
        destinations.add(api_url)
        normalized.append({"id": identifier, "label": label.strip(), "apiUrl": api_url, "verifyTls": verify_tls})
    return {"version": 1, "defaultLanguage": language, "servers": normalized}


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict:
    """Build one JSON object while rejecting repeated field names.

    json.loads calls this object_pairs_hook for every object, including nested
    server entries. pairs retains duplicate names that a normal dict decoder
    would discard. Return a new dict or raise ConfigError at the first duplicate.
    """
    result = {}
    for key, value in pairs:
        if key in result:
            raise ConfigError(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def load_config(path: str | Path) -> dict:
    """Read the private JSON source at path and return a normalized configuration.

    Accept UTF-8 with or without a byte-order mark, enforce MAX_CONFIG_BYTES,
    and reject duplicate JSON fields before validating the decoded document.
    File access, encoding, JSON and configuration failures become ConfigError
    messages suitable for the CLI. The source file is opened only for reading.
    """
    try:
        with Path(path).open("rb") as source:
            content = source.read(MAX_CONFIG_BYTES + 1)
    except OSError as error:
        raise ConfigError(f"cannot read configuration {path}: {error.strerror}") from None
    if len(content) > MAX_CONFIG_BYTES:
        raise ConfigError(f"configuration exceeds {MAX_CONFIG_BYTES} bytes")
    try:
        document = json.loads(content.decode("utf-8-sig"), object_pairs_hook=_unique_json_object)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ConfigError(f"configuration is not valid UTF-8 JSON: {error}") from None
    return validate_config(document)


def make_public_config(config: dict) -> dict:
    """Return the browser-safe projection of an already validated configuration.

    Include version, default language, IDs, labels and generated route bases;
    omit upstream URLs and TLS settings. Each base hashes the stable ID plus
    normalized API URL, so renaming/reordering preserves identity while a new
    destination invalidates old routes and browser sessions. No files are written
    and config is unchanged; callers must normalize it with validate_config first.
    """
    servers = []
    for server in config["servers"]:
        identity = f"{server['id']}\0{server['apiUrl']}".encode("utf-8")
        fingerprint = hashlib.sha256(identity).hexdigest()
        servers.append({"id": server["id"], "label": server["label"], "base": f"/api{server['id']}/{fingerprint}"})
    return {"version": config["version"], "defaultLanguage": config["defaultLanguage"], "servers": servers}


def read_resolvers(path: str | Path) -> list[str]:
    """Return unique IP nameservers, in order, from the UTF-8 resolv.conf at path.

    Ignore comments and unrelated directives, normalize literal IPv4/IPv6
    addresses, and reject malformed nameserver entries with ConfigError.
    An unreadable file also raises ConfigError. An empty list is permitted here;
    render_nginx decides whether configured API hostnames require a resolver.
    This reads existing DNS settings without changing them or querying a server.
    """
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise ConfigError(f"cannot read resolver configuration {path}: {error.strerror}") from None
    resolvers = []
    for line in lines:
        fields = line.split("#", 1)[0].split(";", 1)[0].split()
        if not fields or fields[0] != "nameserver":
            continue
        if len(fields) != 2 or "%" in fields[1]:
            raise ConfigError("resolver configuration contains an invalid nameserver")
        try:
            address = ipaddress.ip_address(fields[1]).compressed
        except ValueError:
            raise ConfigError("resolver nameservers must be IPv4 or IPv6 addresses") from None
        if address not in resolvers:
            resolvers.append(address)
    return resolvers


def _nginx_path(value: str | Path, label: str) -> str:
    """Resolve value to an absolute path and quote it for an nginx directive.

    Reject control characters and nginx variable/directive syntax rather than
    interpolating it into generated configuration. label names the setting in
    the resulting ConfigError. The referenced file need not exist, and this
    helper does not create it or inspect its contents.
    """
    path = str(Path(value).resolve())
    if _has_controls(path) or any(character in path for character in ['"', "'", "$", "\\", "{", "}", ";"]):
        raise ConfigError(f"{label} contains unsupported path characters")
    return f'"{path}"'


class _InlineScripts(HTMLParser):
    """Collect inline script bodies for CSP hashes without executing JavaScript.

    scripts contains completed inline bodies in document order. current holds
    chunks for the active inline script, while open_script also tracks external
    scripts so the caller can reject a document ending inside any script tag.
    """

    def __init__(self) -> None:
        """Initialize empty collection state and preserve character references.

        HTMLParser supplies tags and raw script data to the handlers below.
        Nothing is read until the caller feeds the installed document text.
        """
        super().__init__(convert_charrefs=False)
        self.open_script = False
        self.current: list[str] | None = None
        self.scripts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        """Begin collecting a script tag unless its attributes include src.

        tag and attrs come from HTMLParser. External scripts are tracked as open
        but are not collected or fetched; all other element names are ignored.
        """
        if tag == "script":
            self.open_script = True
            self.current = None if any(name == "src" for name, _ in attrs) else []

    def handle_data(self, data: str) -> None:
        """Append a parser-delivered chunk only while inside an inline script.

        Preserve data exactly for hashing; text outside an inline script has no
        effect. The collected JavaScript is never interpreted by this parser.
        """
        if self.current is not None:
            self.current.append(data)

    def handle_endtag(self, tag: str) -> None:
        """Finish a script body and reset collection state at its closing tag.

        For an inline script, join its chunks into scripts. External scripts
        only clear the open flag. Closing tags for other elements are ignored.
        """
        if tag == "script":
            if self.current is not None:
                self.scripts.append("".join(self.current))
            self.current = None
            self.open_script = False


def content_security_policy(index_path: str | Path) -> str:
    """Build a CSP string from the installed HTML document at index_path.

    HTML normalizes CRLF and CR before hashing inline scripts. Regenerate the
    nginx configuration whenever index.html changes so that the hashes match.
    Inline styles remain necessary for the dashboard's dynamic layouts/charts.

    Read at most MAX_APP_BYTES and allow UTF-8 with an optional byte-order mark.
    Raise ConfigError for unreadable, oversized or non-UTF-8 input, NULs,
    an unfinished script or a document with no completed inline script. Return
    the policy without writing files or executing scripts. Comments inside an
    inline script contribute to its hash just like executable script text.
    """
    try:
        with Path(index_path).open("rb") as source:
            raw = source.read(MAX_APP_BYTES + 1)
    except OSError as error:
        raise ConfigError(f"cannot read dashboard index.html: {error.strerror}") from None
    if len(raw) > MAX_APP_BYTES:
        raise ConfigError(f"dashboard index.html exceeds {MAX_APP_BYTES} bytes")
    try:
        html = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    except UnicodeError:
        raise ConfigError("dashboard index.html must be valid UTF-8") from None
    if "\0" in html:
        raise ConfigError("dashboard index.html must not contain NUL characters")
    parser = _InlineScripts()
    parser.feed(html)
    parser.close()
    if parser.open_script or not parser.scripts:
        raise ConfigError("dashboard index.html must contain a complete inline application script")
    hashes = dict.fromkeys(
        "'sha256-" + base64.b64encode(hashlib.sha256(script.encode("utf-8")).digest()).decode("ascii") + "'"
        for script in parser.scripts
    )
    return (
        "default-src 'self'; script-src 'self' " + " ".join(hashes) + "; script-src-attr 'none'; "
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; "
        "object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none';"
    )


def render_nginx(
    config: dict,
    public_config_path: str | Path,
    web_root: str | Path,
    resolvers: list[str],
    listen_port: int = 8080,
    ca_bundle: str | Path = "/etc/ssl/certs/ca-certificates.crt",
    listen_address: str | None = None,
) -> str:
    """Generate an nginx HTTP-context include from the same model as public JSON.

    Variable proxy_pass targets defer DNS to request time. Maps use request_uri,
    not the normalized uri, so percent-encoded API suffixes and queries survive.
    Only the current target fingerprints are routed; stale routes return 409.

    config must already be normalized by validate_config. public_config_path is
    the public JSON alias destination; web_root supplies assets and the deployed
    index.html used for CSP hashes. resolvers contains literal nameserver IPs.
    listen_address restricts the bind to one literal IP, or None enables both
    wildcard IPv4/IPv6 listeners. listen_port is the numeric backend port and
    ca_bundle names the trust file for verified HTTPS upstreams.

    Return configuration text only: this reads index.html but does not write
    files, contact Pi-hole, test certificate trust or start/reload nginx. Raise
    ConfigError for invalid listener/resolver/path inputs, unusable script input
    or a hostname upstream without a resolver. The caller must still run nginx
    validation before activation. /healthz tests the HTTP service, not Pi-hole.
    """
    if type(listen_port) is not int or not 1 <= listen_port <= 65535:
        raise ConfigError("listen port must be between 1 and 65535")
    listen_targets = [str(listen_port), f"[::]:{listen_port}"]
    if listen_address is not None:
        if not isinstance(listen_address, str) or "%" in listen_address:
            raise ConfigError("listen address must be a literal IPv4 or IPv6 address")
        try:
            address = ipaddress.ip_address(listen_address)
        except ValueError:
            raise ConfigError("listen address must be a literal IPv4 or IPv6 address") from None
        host = f"[{address.compressed}]" if address.version == 6 else address.compressed
        listen_targets = [f"{host}:{listen_port}"]
    resolver_addresses = []
    for value in resolvers:
        try:
            address = ipaddress.ip_address(value)
        except ValueError:
            raise ConfigError("resolver addresses must be valid IP addresses") from None
        resolver_addresses.append(f"[{address.compressed}]" if address.version == 6 else address.compressed)
    needs_dns = False
    for server in config["servers"]:
        try:
            ipaddress.ip_address(urlsplit(server["apiUrl"]).hostname)
        except ValueError:
            needs_dns = True
    if needs_dns and not resolver_addresses:
        raise ConfigError("at least one nameserver in resolv.conf is required for API host names")
    public = make_public_config(config)
    csp = content_security_policy(Path(web_root) / "index.html")
    lines = ["# Generated from the canonical configuration. Do not edit this file.", ""]
    for server, visible in zip(config["servers"], public["servers"]):
        identifier = server["id"]
        lines.extend([
            f"map $request_uri $dashboard_target_{identifier} {{",
            '    default "";',
            f'    ~^{visible["base"]}(?<dashboard_suffix_{identifier}>(?:/|\\?).*)?$ "{server["apiUrl"]}$dashboard_suffix_{identifier}";',
            "}", "",
        ])
    lines.extend([
        "server {",
        *(f"    listen {target};" for target in listen_targets),
        "    server_name _;",
        f"    root {_nginx_path(web_root, 'web root')};",
        "    autoindex off;",
        "    server_tokens off;",
        "    client_max_body_size 1m;",
        "    client_header_timeout 15s;",
        "    client_body_timeout 15s;",
        "    send_timeout 60s;",
        "    keepalive_timeout 15s;",
        f'    add_header Content-Security-Policy "{csp}" always;',
        '    add_header X-Content-Type-Options "nosniff" always;',
        '    add_header X-Frame-Options "DENY" always;',
        '    add_header Referrer-Policy "no-referrer" always;',
        '    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;',
        '    add_header Cross-Origin-Resource-Policy "same-origin" always;',
        '    add_header Cache-Control "no-store" always;',
    ])
    if resolver_addresses:
        lines.extend([f"    resolver {' '.join(resolver_addresses)} valid=30s;", "    resolver_timeout 5s;"])
    lines.extend([
        "",
        "    location = /healthz {",
        "        access_log off;",
        "        default_type text/plain;",
        '        return 200 "ok\\n";',
        "    }",
        "    location = /config.json {",
        "        default_type application/json;",
        f"        alias {_nginx_path(public_config_path, 'public configuration path')};",
        "        etag off;",
        "        if_modified_since off;",
        "    }",
        "    location = / { try_files /index.html =404; }",
        "    location = /index.html { try_files $uri =404; }",
        "    location = /chart.umd.min.js { try_files $uri =404; }",
        "",
    ])
    for server, visible in zip(config["servers"], public["servers"]):
        parsed = urlsplit(server["apiUrl"])
        identifier = server["id"]
        for location in [f"= {visible['base']}", f"^~ {visible['base']}/"]:
            lines.extend([
                f"    location {location} {{",
                f'        if ($dashboard_target_{identifier} = "") {{ return 409 \'{STALE_RESPONSE}\'; }}',
                "        default_type application/json;",
                f"        proxy_pass $dashboard_target_{identifier};",
                "        proxy_http_version 1.1;",
                '        proxy_set_header Connection "";',
                f'        proxy_set_header Host "{parsed.netloc}";',
                '        proxy_set_header Authorization "";',
                '        proxy_set_header Cookie "";',
                "        proxy_hide_header Set-Cookie;",
                "        proxy_hide_header WWW-Authenticate;",
                "        proxy_connect_timeout 10s;",
                "        proxy_send_timeout 30s;",
                "        proxy_read_timeout 300s;",
                "        proxy_buffering off;",
                "        proxy_request_buffering on;",
                "        proxy_cache off;",
                "        proxy_intercept_errors off;",
                "        proxy_ignore_headers X-Accel-Redirect X-Accel-Buffering X-Accel-Expires X-Accel-Limit-Rate X-Accel-Charset;",
                "        proxy_redirect off;",
            ])
            if parsed.scheme == "https":
                lines.extend([
                    "        proxy_ssl_server_name on;",
                    "        proxy_ssl_protocols TLSv1.2 TLSv1.3;",
                    f'        proxy_ssl_name "{parsed.hostname}";',
                    f"        proxy_ssl_verify {'on' if server['verifyTls'] else 'off'};",
                ])
                if server["verifyTls"]:
                    lines.extend([
                        f"        proxy_ssl_trusted_certificate {_nginx_path(ca_bundle, 'CA bundle path')};",
                        "        proxy_ssl_verify_depth 5;",
                    ])
            lines.extend(["    }", ""])
    lines.extend([
        "    # Old fingerprints and pre-configuration /api1..4 routes never reach an upstream.",
        "    location ~ ^/api[1-4](?:/|$) {",
        "        default_type application/json;",
        f"        return 409 '{STALE_RESPONSE}';",
        "    }",
        "    # Serve only the application assets above, never source configuration or scripts.",
        "    location / { return 404; }",
        "}", "",
    ])
    return "\n".join(lines)


def _atomic_write(path: Path, content: str) -> None:
    """Replace one generated file with UTF-8 content and mode 0644.

    path.parent must already exist. Write and fsync a temporary file in the same
    directory, then replace path with os.replace; remove leftover temporary
    state even if writing fails. Filesystem errors propagate as OSError. This
    protects one replacement, not the coordinated activation of both outputs
    or the running nginx configuration.
    """
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as target:
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
            os.fchmod(target.fileno(), 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main(argv: list[str] | None = None) -> int:
    """Render deployment files from CLI arguments and report an exit status.

    argv is an argument list, or None to read the process command line. Validate
    the private source and render both outputs before creating the destination
    directory; refuse an output path that would overwrite the source. Write the
    public JSON and nginx include separately, then print a success summary.

    Return 0 on success or 2 after reporting configuration/filesystem errors to
    stderr. argparse handles help and malformed CLI arguments itself. This entry
    point never starts nginx or rolls back a previously replaced output file.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("/config/config.json"))
    parser.add_argument("--output-dir", type=Path, default=Path("/run/dobbelt-pi-hole"))
    parser.add_argument("--web-root", type=Path, default=Path("/usr/share/nginx/html"))
    parser.add_argument("--listen-port", type=int, default=8080)
    parser.add_argument("--listen-address", help="literal IPv4 or IPv6 bind address; default: all interfaces")
    parser.add_argument("--resolver-file", type=Path, default=Path("/etc/resolv.conf"))
    parser.add_argument("--ca-bundle", type=Path, default=Path("/etc/ssl/certs/ca-certificates.crt"))
    arguments = parser.parse_args(argv)
    try:
        config = load_config(arguments.config)
        public = make_public_config(config)
        output = arguments.output_dir.resolve()
        config_path = output / "config.json"
        nginx_path = output / "nginx.conf"
        if arguments.config.resolve() in {config_path.resolve(), nginx_path.resolve()}:
            raise ConfigError("source configuration must not be overwritten by generated configuration")
        nginx = render_nginx(config, config_path, arguments.web_root, read_resolvers(arguments.resolver_file),
                             arguments.listen_port, arguments.ca_bundle, arguments.listen_address)
        output.mkdir(parents=True, exist_ok=True)
        _atomic_write(config_path, json.dumps(public, ensure_ascii=False, indent=2) + "\n")
        _atomic_write(nginx_path, nginx)
    except (ConfigError, OSError) as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        return 2
    print(f"Validated {len(config['servers'])} instances; generated public config and nginx routes in {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
