"""Verify and deploy only Plato's public static assets to Cloudflare Pages."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_FILES = (
    "index.html",
    "app.js",
    "graph-view.js",
    "data-model.js",
    "navigation.js",
    "reader.js",
    "evidence.js",
    "categories.js",
    "full-text-search.js",
    "styles.css",
    "manifest.webmanifest",
    "icons/icon.svg",
    "icons/apple-touch-icon.png",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "robots.txt",
    "_headers",
)


def prepare():
    source = ROOT / "web"
    destination = ROOT / ".artifacts/public"
    required = ("graph.json", "search/manifest.json", "articles/nietzsche.json")
    for name in required:
        if not (source / "data" / name).is_file():
            raise SystemExit("Build the generated data first; see README.md.")
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    # Explicit files keep legacy account/login code and any credentials out.
    files = [source / name for name in PUBLIC_FILES]
    files.extend((source / "data").rglob("*.json"))
    for path in files:
        relative = path.relative_to(source)
        if path.is_symlink() or any(part.startswith(".") for part in relative.parts):
            raise SystemExit(f"Refusing to publish hidden or linked asset: {relative}")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    return destination


def deploy(args):
    if args.prepare_only:
        print(prepare())
        return
    if not os.environ.get("CLOUDFLARE_ACCOUNT_ID"):
        raise SystemExit("Set CLOUDFLARE_ACCOUNT_ID to the destination Pages account before deploying.")
    if args.wrangler:
        command = ["node", str(Path(args.wrangler).expanduser().resolve())]
    else:
        executable = shutil.which("wrangler")
        if not executable:
            raise SystemExit("Provide --wrangler /path/to/wrangler/bin/wrangler.js or install Wrangler on PATH.")
        command = [executable]
    subprocess.run(["npm", "run", "check"], cwd=ROOT, check=True)
    subprocess.run(["node", "--check", "web/navigation.js"], cwd=ROOT, check=True)
    subprocess.run(["npm", "test"], cwd=ROOT, check=True)
    directory = prepare()
    # Pages rejects custom config paths. A clean working directory prevents it
    # from reading the separate private Worker's wrangler.jsonc or .dev.vars.
    with tempfile.TemporaryDirectory(prefix="plato-pages-") as working_directory:
        subprocess.run(
            command + ["pages", "deploy", str(directory), "--project-name", args.project_name,
                       "--branch", "main"],
            cwd=working_directory,
            check=True,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wrangler", default=os.environ.get("WRANGLER_JS"), help="Path to Wrangler's JavaScript entry point")
    parser.add_argument("--project-name", default="plato-network")
    parser.add_argument("--prepare-only", action="store_true", help="Stage public files without running checks or deploying")
    deploy(parser.parse_args())
