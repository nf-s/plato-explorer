"""Verify and deploy one explorer's public static assets to Cloudflare Pages."""

import argparse
import html
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from sites import load_site, site_names

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_FILES = (
    "index.html",
    "app.js",
    "graph-view.js",
    "data-model.js",
    "navigation.js",
    "reader.js",
    "site.js",
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


# The shared page shell carries neutral text; each release states its own name.
SHELL_TEXT = (
    ("<title>Explorer</title>", "<title>{name}</title>"),
    ('<meta name="apple-mobile-web-app-title" content="Explorer" />', '<meta name="apple-mobile-web-app-title" content="{shortName}" />'),
    ('content="Browse encyclopedia articles and the connections between them."', 'content="{description}"'),
)


def staging_directory(site):
    return ROOT / (".artifacts/public" if site.name == "plato" else f".artifacts/public-{site.name}")


def prepare(site):
    source = ROOT / "web"
    destination = staging_directory(site)
    required = ("graph.json", "site.json", "partner.json", "search/manifest.json")
    for name in required:
        if not (site.output / name).is_file():
            raise SystemExit("Build the generated data first; see README.md.")
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    # Explicit files keep legacy account/login code and any credentials out.
    files = [(source / name, Path(name)) for name in PUBLIC_FILES]
    files.extend((path, Path("data") / path.relative_to(site.output)) for path in site.output.rglob("*.json"))
    for path, relative in files:
        if path.is_symlink() or any(part.startswith(".") for part in relative.parts):
            raise SystemExit(f"Refusing to publish hidden or linked asset: {relative}")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    settings = json.loads(site.config.read_text())
    shell = (destination / "index.html").read_text()
    for placeholder, template in SHELL_TEXT:
        if shell.count(placeholder) != 1:
            raise SystemExit(f"The page shell no longer contains: {placeholder}")
        shell = shell.replace(placeholder, template.format(**{field: html.escape(settings[field]) for field in ("name", "shortName", "description")}))
    (destination / "index.html").write_text(shell)
    manifest = json.loads((destination / "manifest.webmanifest").read_text())
    manifest.update(name=settings["name"], short_name=settings["shortName"], description=settings["description"])
    (destination / "manifest.webmanifest").write_text(json.dumps(manifest, indent=2) + "\n")
    return destination


def deploy(args):
    site = load_site(args.site)
    project = args.project_name or site.pages_project
    if args.prepare_only:
        print(prepare(site))
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
    directory = prepare(site)
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
    parser.add_argument("--site", default="plato", choices=site_names())
    parser.add_argument("--project-name", help="Pages project; defaults to the site's own")
    parser.add_argument("--prepare-only", action="store_true", help="Stage public files without running checks or deploying")
    deploy(parser.parse_args())
