"""Verify and deploy the app and every built realm to Cloudflare Pages."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from realms import DATA, app_settings, built_realms

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_FILES = (
    "index.html",
    "app.js",
    "graph-view.js",
    "data-model.js",
    "navigation.js",
    "reader.js",
    "realm.js",
    "article-preview.js",
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


# Local reports stay out of releases.
REALM_FILES = ("realm.json", "links.json", "graph.json")
REALM_FOLDERS = ("packs", "search")


def prepare():
    source = ROOT / "web"
    destination = ROOT / ".artifacts/public"
    realms = built_realms()
    if not realms or not (DATA / "realms.json").is_file():
        raise SystemExit("Build the generated data first; see README.md.")
    # Explicit files keep legacy account/login code and any credentials out.
    files = [(source / name, Path(name)) for name in PUBLIC_FILES]
    files.append((DATA / "realms.json", Path("data/realms.json")))
    for realm in realms:
        for name in REALM_FILES + ("packs/manifest.json", "search/manifest.json"):
            if not (realm.output / name).is_file():
                raise SystemExit(f"Build the {realm.name} data and search index first; see README.md.")
        paths = [realm.output / name for name in REALM_FILES]
        for folder in REALM_FOLDERS:
            paths.extend(sorted((realm.output / folder).rglob("*.json")))
        files.extend((path, Path("data") / path.relative_to(DATA)) for path in paths)
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    for path, relative in files:
        if path.is_symlink() or any(part.startswith(".") for part in relative.parts):
            raise SystemExit(f"Refusing to publish hidden or linked asset: {relative}")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    return destination


def deploy(args):
    project = args.project_name or app_settings()["pagesProject"]
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
    with tempfile.TemporaryDirectory(prefix="explorer-pages-") as working_directory:
        subprocess.run(
            command + ["pages", "deploy", str(directory), "--project-name", project,
                       "--branch", "main"],
            cwd=working_directory,
            check=True,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wrangler", default=os.environ.get("WRANGLER_JS"), help="Path to Wrangler's JavaScript entry point")
    parser.add_argument("--project-name", help="Pages project; defaults to the one in realms/app.json")
    parser.add_argument("--prepare-only", action="store_true", help="Stage public files without running checks or deploying")
    deploy(parser.parse_args())
