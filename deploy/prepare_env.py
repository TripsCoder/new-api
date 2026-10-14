#!/usr/bin/env python3
"""Preserve app/Nginx settings outside Git; direct the gateway to native new-api."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit

GATEWAY_KEYS = (
    "NGINX_SERVER_NAME", "NGINX_CLIENT_MAX_BODY_SIZE",
    "NGINX_PROXY_READ_TIMEOUT", "NGINX_PROXY_SEND_TIMEOUT",
    "NGINX_SSL_ENABLED", "NGINX_HTTP_REDIRECT_TO_HTTPS",
    "NGINX_SSL_CERTIFICATE", "NGINX_SSL_CERTIFICATE_KEY",
    "NGINX_SSL_PROTOCOLS", "NGINX_SSL_CIPHERS", "NGINX_SSL_SESSION_TIMEOUT",
    "NGINX_HSTS_ENABLED", "NGINX_HSTS_MAX_AGE",
)


def read_runtime(component="app"):
    names = ["new-api-frontend"] if component == "gateway" else ["new-api-dev", "postgres", "redis"]
    result = subprocess.run(
        ["docker", "inspect", *names],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise ValueError("Cannot inspect the existing containers; no files written.")
    try:
        containers = {item["Name"].lstrip("/"): item for item in json.loads(result.stdout)}
        for name in names:
            item = containers[name]
            if not item["State"]["Running"] or "new-api-network" not in item["NetworkSettings"]["Networks"]:
                raise ValueError("Existing containers must be running on new-api-network.")
        current = containers[names[0]]
        mounts = {m["Destination"]: m["Source"] for m in current["Mounts"]}
        if component == "gateway":
            if mounts:
                raise ValueError("Nginx mounts changed; include them in the reviewed Compose before proceeding.")
        else:
            for target, source in (("/data", "/home/ubuntu/code/new-api/data"), ("/app/logs", "/home/ubuntu/code/new-api/logs")):
                if mounts.get(target) != source:
                    raise ValueError("Current bind mounts differ from compose.app.yml; review before proceeding.")
        values = dict(entry.split("=", 1) for entry in current["Config"]["Env"])
        if component == "gateway":
            values = {key: values[key] for key in GATEWAY_KEYS}
            values["NEW_API_UPSTREAM"] = "http://new-api:3000"
    except (KeyError, TypeError, json.JSONDecodeError):
        raise ValueError("Unexpected Docker metadata; no files written.") from None
    # PATH belongs to the image. Keep all application variables, including any existing secrets.
    values.pop("PATH", None)
    validate_values(values, component)
    return values


def validate_values(values, component="app"):
    for key, value in values.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or any(c in value for c in "\r\n\x00"):
            raise ValueError("An environment entry cannot be represented safely as a raw env file.")
    if component == "gateway":
        if set(values) != set(GATEWAY_KEYS) | {"NEW_API_UPSTREAM"} or any(not values[k] for k in GATEWAY_KEYS):
            raise ValueError("All existing Nginx settings must be preserved; unrelated environment entries are forbidden.")
        if values["NEW_API_UPSTREAM"] != "http://new-api:3000":
            raise ValueError("Nginx must target the native new-api service.")
        return
    if not values.get("SQL_DSN") or not values.get("REDIS_CONN_STRING"):
        raise ValueError("SQL_DSN and REDIS_CONN_STRING must already exist; defaults are forbidden.")
    try:
        db = urlsplit(values["SQL_DSN"])
        redis = urlsplit(values["REDIS_CONN_STRING"])
        valid = (db.scheme in ("postgres", "postgresql") and db.hostname == "postgres"
                 and (db.port or 5432) == 5432 and db.path == "/new-api"
                 and redis.scheme in ("redis", "rediss") and redis.hostname == "redis"
                 and (redis.port or 6379) == 6379)
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("Database/Redis targets differ from the reviewed deployment; values are not printed.")


def write_private_env(output, values, component="app"):
    validate_values(values, component)
    output = output.expanduser().absolute()
    if output.is_symlink():
        raise ValueError("Refusing a symlink destination.")
    output = output.resolve()
    repo = Path(__file__).resolve().parent.parent
    if repo in output.parents or any((p / ".git").exists() for p in output.parents):
        raise ValueError("The env file must be outside every Git working tree.")
    if os.name != "posix":
        raise ValueError("Writing production secrets requires the Linux server (0600 permissions).")
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if output.parent.stat().st_mode & 0o077:
        raise ValueError("Output directory must already be private (mode 0700).")
    # O_EXCL rejects existing files and symlinks. No overwrite or secret rotation.
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
        for key in sorted(values):
            stream.write(f"{key}={values[key]}\n")
    restored = dict(line.split("=", 1) for line in output.read_text(encoding="utf-8").splitlines())
    if restored != values:
        raise ValueError("Environment round-trip failed; do not deploy.")
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--component", choices=("app", "gateway"), default="app")
    parser.add_argument("--write", type=Path, metavar="ABSOLUTE_PATH", help="Explicitly write a new private file outside Git; otherwise read-only")
    args = parser.parse_args()
    try:
        values = read_runtime(args.component)
        print("Preserved " + args.component + " variable names: " + ", ".join(sorted(values)))
        print("Targets and bind mounts match the reviewed deployment; values are hidden.")
        print("No inactive .env entries are activated; no session/crypto secret is generated.")
        if args.component == "gateway":
            print("Only NEW_API_UPSTREAM changes to http://new-api:3000; all Nginx settings retain their source values.")
        if args.write:
            if not args.write.is_absolute():
                raise ValueError("--write requires an absolute path.")
            destination = write_private_env(args.write, values, args.component)
            print(f"Saved {destination} (0600); exact value round-trip verified.")
        else:
            print("Read-only check complete. No file or container was changed.")
    except (ValueError, OSError) as error:
        # Do not include Docker stderr, exception inputs, DSNs, passwords or values.
        message = str(error) if isinstance(error, ValueError) else type(error).__name__
        parser.exit(1, f"Preparation stopped: {message}\n")


if __name__ == "__main__":
    main()
