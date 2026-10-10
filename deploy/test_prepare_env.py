import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import prepare_env


class EnvironmentPreparationTests(unittest.TestCase):
    def setUp(self):
        # Synthetic fixtures only; no production values are stored in tests.
        self.values = {
            "SQL_DSN": "postgresql://example:a%24%23@postgres:5432/new-api?sslmode=disable",
            "REDIS_CONN_STRING": "redis://:example%23@redis:6379/2",
            "TZ": "Asia/Shanghai",
            "SESSION_SECRET": "synthetic-$literal#value 'double\" = preserved",
            "BATCH_UPDATE_ENABLED": "true",
        }

    def test_read_only_mode_preserves_effective_settings_without_exposing_values(self):
        containers = []
        for name in ("new-api-dev", "postgres", "redis"):
            containers.append({
                "Name": "/" + name, "State": {"Running": True},
                "NetworkSettings": {"Networks": {"new-api-network": {}}},
                "Mounts": [{"Destination": "/data", "Source": "/home/ubuntu/code/new-api/data"},
                           {"Destination": "/app/logs", "Source": "/home/ubuntu/code/new-api/logs"}],
                "Config": {"Env": [f"{k}={v}" for k, v in self.values.items()] + ["PATH=/old/image/bin"]},
            })
        result = SimpleNamespace(returncode=0, stdout=json.dumps(containers))
        with patch.object(prepare_env.subprocess, "run", return_value=result) as run:
            self.assertEqual(prepare_env.read_runtime(), self.values)
            self.assertEqual(run.call_args.args[0][:2], ["docker", "inspect"])
        output = io.StringIO()
        with patch.object(prepare_env, "read_runtime", return_value=self.values), \
             patch.object(prepare_env, "write_private_env") as write, \
             patch("sys.argv", ["prepare_env.py"]), contextlib.redirect_stdout(output):
            prepare_env.main()
            write.assert_not_called()
        self.assertIn("SESSION_SECRET", output.getvalue())
        self.assertNotIn(self.values["SESSION_SECRET"], output.getvalue())
        self.assertNotIn(self.values["SQL_DSN"], output.getvalue())

    def test_invalid_targets_and_multiline_values_are_rejected(self):
        for change in ({"SQL_DSN": "postgresql://example@other-db/new-api"},
                       {"SQL_DSN": "postgresql://example@postgres/new-api-empty"},
                       {"REDIS_CONN_STRING": "redis://other-redis:6379/0"},
                       {"SESSION_SECRET": "first\nINJECTED=yes"}, {"SQL_DSN": ""}):
            with self.subTest(change=list(change)), self.assertRaises(ValueError):
                prepare_env.validate_values(self.values | change)

    def test_gateway_preserves_nginx_settings_and_drops_old_frontend_environment(self):
        nginx_values = dict(zip(prepare_env.GATEWAY_KEYS, (
            "_", "100m", "600s", "600s", "false", "false",
            "/etc/nginx/ssl/fullchain.pem", "/etc/nginx/ssl/privkey.pem",
            "TLSv1.2 TLSv1.3", "HIGH:!aNULL:!MD5", "1d", "false", "15552000",
        )))
        values = nginx_values | {"NEW_API_UPSTREAM": "http://retired-app:8080",
                                 "VITE_REACT_APP_SERVER_URL": "http://retired-app:8080",
                                 "NGINX_VERSION": "1.31.2"}
        expected = nginx_values | {"NEW_API_UPSTREAM": "http://new-api:3000"}
        container = {"Name": "/new-api-frontend", "State": {"Running": True},
                     "NetworkSettings": {"Networks": {"new-api-network": {}}}, "Mounts": [],
                     "Config": {"Env": [f"{k}={v}" for k, v in values.items()] + ["PATH=/image/bin"]}}
        result = SimpleNamespace(returncode=0, stdout=json.dumps([container]))
        with patch.object(prepare_env.subprocess, "run", return_value=result):
            self.assertEqual(prepare_env.read_runtime("gateway"), expected)
        with self.assertRaises(ValueError):
            prepare_env.validate_values(expected | {"NEW_API_UPSTREAM": "http://retired-app:8080"}, "gateway")
        with self.assertRaises(ValueError):
            prepare_env.validate_values(expected | {"VITE_REACT_APP_SERVER_URL": "old"}, "gateway")
        with tempfile.TemporaryDirectory() as directory:
            # Also enforce the repository boundary for gateway environment exports.
            root = Path(directory)
            (root / ".git").mkdir()
            with self.assertRaises(ValueError):
                prepare_env.write_private_env(root / "gateway.env", expected, "gateway")

    def test_output_in_any_git_tree_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            (repo / ".git").mkdir()
            with self.assertRaisesRegex(ValueError, "outside every Git"):
                prepare_env.write_private_env(repo / "private" / "app.env", self.values)
            self.assertFalse((repo / "private").exists())

    @unittest.skipUnless(os.name == "posix", "Linux permissions are validated in the Linux container")
    def test_private_round_trip_and_existing_file_protection(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "private" / "app.env"
            prepare_env.write_private_env(output, self.values)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertEqual(output.parent.stat().st_mode & 0o777, 0o700)
            raw = output.read_text()
            self.assertEqual(dict(line.split("=", 1) for line in raw.splitlines()), self.values)
            with self.assertRaises(FileExistsError):
                prepare_env.write_private_env(output, self.values | {"TZ": "UTC"})
            self.assertEqual(output.read_text(), raw)
            link = Path(directory) / "linked.env"
            link.symlink_to(output)
            with self.assertRaisesRegex(ValueError, "symlink"):
                prepare_env.write_private_env(link, self.values)


if __name__ == "__main__":
    unittest.main()
