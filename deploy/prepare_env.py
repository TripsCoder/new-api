#!/usr/bin/env python3
"""Copy effective new-api settings to a private file; never start or change containers."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit


def read_runtime():
    result = subprocess.run(
        ["docker", "inspect", "new-api-dev", "postgres", "redis"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise ValueError("Cannot inspect the three existing containers; no files written.")
    try:
        containers = {item["Name"].lstrip("/"): item for item in json.loads(result.stdout)}
        for name in ("new-api-dev", "postgres", "redis"):
            item = containers[name]
            if not item["State"]["Running"] or "new-api-network" not in item["NetworkSettings"]["Networks"]:
                raise ValueError("Existing containers must be running on new-api-network.")
        current = containers["new-api-dev"]
        mounts = {m["Destination"]: m["Source"] for m in current["Mounts"]}
        for target, source in (("/data", "/home/ubuntu/code/new-api/data"), ("/app/logs", "/home/ubuntu/code/new-api/logs")):
            if mounts.get(target) != source:
                raise ValueError("Current bind mounts differ from compose.app.yml; review before proceeding.")
        values = dict(entry.split("=", 1) for entry in current["Config"]["Env"])
    except (KeyError, TypeError, json.JSONDecodeError):
        raise ValueError("Unexpected Docker metadata; no files written.") from None
    # PATH belongs to the image. Keep all application variables, including any existing secrets.
    values.pop("PATH", None)
    validate_values(values)
    return values


def validate_values(values):
    for key, value in values.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or any(c in value for c in "\r\n\x00"):
            raise ValueError("An environment entry cannot be represented safely as a raw env file.")
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


def write_private_env(output, values):
    validate_values(values)
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
    parser.add_argument("--write", type=Path, metavar="ABSOLUTE_PATH", help="Explicitly write a new private file outside Git; otherwise read-only")
    args = parser.parse_args()
    try:
        values = read_runtime()
        print("Preserved application variable names: " + ", ".join(sorted(values)))
        print("Targets and bind mounts match the reviewed deployment; values are hidden.")
        print("No inactive .env entries are activated; no session/crypto secret is generated.")
        if args.write:
            if not args.write.is_absolute():
                raise ValueError("--write requires an absolute path.")
            destination = write_private_env(args.write, values)
            print(f"Saved {destination} (0600); exact value round-trip verified.")
        else:
            print("Read-only check complete. No file or container was changed.")
    except (ValueError, OSError) as error:
        # Do not include Docker stderr, exception inputs, DSNs, passwords or values.
        message = str(error) if isinstance(error, ValueError) else type(error).__name__
        parser.exit(1, f"Preparation stopped: {message}\n")


if __name__ == "__main__":
    main()
