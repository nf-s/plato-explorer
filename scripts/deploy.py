"""Build, verify, and deploy Plato with its private asset gate intact."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def deploy(wrangler):
    if not (ROOT / "wrangler.jsonc").is_file():
        raise SystemExit("Configure wrangler.jsonc from wrangler.example.jsonc before deploying the private Worker.")
    if wrangler:
        command = ["node", str(Path(wrangler).expanduser().resolve())]
    else:
        executable = shutil.which("wrangler")
        if not executable:
            raise SystemExit("Provide --wrangler /path/to/wrangler/bin/wrangler.js or install Wrangler on PATH.")
        command = [executable]
    secrets = ROOT / ".dev.vars"
    if not secrets.is_file():
        raise SystemExit("Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the ignored .dev.vars file first.")
    if secrets.stat().st_mode & 0o077:
        raise SystemExit("Restrict .dev.vars before deploying: chmod 600 .dev.vars")
    python = ROOT / ".venv/bin/python"
    if not python.is_file():
        raise SystemExit("Create the data build's .venv first; see README.md.")
    subprocess.run([str(python), "scripts/build_data.py"], cwd=ROOT, check=True)
    subprocess.run([str(python), "scripts/build_search.py"], cwd=ROOT, check=True)
    subprocess.run(["npm", "run", "check"], cwd=ROOT, check=True)
    subprocess.run(["npm", "test"], cwd=ROOT, check=True)
    subprocess.run(command + ["d1", "migrations", "apply", "AUTH_DB", "--remote"], cwd=ROOT, check=True)
    # The initial deployment denies private content until its secrets are set.
    subprocess.run(command + ["deploy"], cwd=ROOT, check=True)
    subprocess.run(command + ["secret", "bulk", str(secrets)], cwd=ROOT, check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wrangler", default=os.environ.get("WRANGLER_JS"), help="Path to Wrangler's JavaScript entry point")
    deploy(parser.parse_args().wrangler)
