"""Verify and deploy the app, or one realm's data, to Cloudflare Pages."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from realms import REALMS, app_settings, built_realms, load_realm, realm_index

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
STAGING = ROOT / ".artifacts"
# The Pages Free plan accepts this many files in one project.
FILE_LIMIT = 20000
CONNECT_SOURCES = "connect-src 'self'"
USER_AGENT = "explorer-release-check/0.1"


def data_project(project, realm):
    """Each realm's data has a Pages project of its own, named after the app's."""
    return f"{project}-{realm.name}"


def data_address(project, realm):
    return f"https://{data_project(project, realm)}.pages.dev/"


def stage(files, destination):
    if len(files) > FILE_LIMIT:
        raise SystemExit(f"{destination.name} has {len(files):,} files; a Pages project accepts {FILE_LIMIT:,}.")
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


def prepare_app(project):
    """Stage the app with the list of realms and the address of each realm's data."""
    source = ROOT / "web"
    realms = built_realms()
    if not realms:
        raise SystemExit("Build the generated data first; see README.md.")
    # Explicit files keep legacy account/login code and any credentials out.
    destination = stage([(source / name, Path(name)) for name in PUBLIC_FILES], STAGING / "public")
    addresses = {realm.name: data_address(project, realm) for realm in realms}
    (destination / "data").mkdir()
    (destination / "data/realms.json").write_text(json.dumps(realm_index(addresses), ensure_ascii=False, indent=2) + "\n")
    # The app may fetch only from itself and from the realms it lists.
    headers = destination / "_headers"
    rules = headers.read_text()
    if rules.count(CONNECT_SOURCES) != 1:
        raise SystemExit("web/_headers no longer has the expected connect-src rule.")
    origins = " ".join(address.rstrip("/") for address in addresses.values())
    headers.write_text(rules.replace(CONNECT_SOURCES, f"{CONNECT_SOURCES} {origins}"))
    return destination, addresses


def prepare_realm(realm):
    """Stage one realm's settings, graph, search index and one file per article."""
    for name in REALM_FILES + ("search/manifest.json",):
        if not (realm.output / name).is_file():
            raise SystemExit(f"Build the {realm.name} data and search index first; see README.md.")
    files = [(realm.output / name, Path(name)) for name in REALM_FILES]
    # Article files left behind by an earlier build are not in the graph.
    nodes = json.loads((realm.output / "graph.json").read_text())["nodes"]
    files.extend((realm.output / "articles" / f"{node['id']}.json", Path("articles") / f"{node['id']}.json") for node in nodes if node["article"])
    files.extend((path, path.relative_to(realm.output)) for path in sorted((realm.output / "search").rglob("*.json")))
    files.append((REALMS / "_headers", Path("_headers")))
    files.append((ROOT / "web/robots.txt", Path("robots.txt")))
    return stage(files, STAGING / "realms" / realm.name)


def check_released(addresses):
    """The app is released after the data it lists."""
    for name, address in addresses.items():
        try:
            with urlopen(Request(address + "realm.json", headers={"User-Agent": USER_AGENT}), timeout=30) as response:
                released = json.load(response)
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
            raise SystemExit(f"The {name} data is not released yet: {error}. Run this script with --realm {name} first.") from error
        if not isinstance(released, dict) or released.get("id") != name:
            raise SystemExit(f"The address for the {name} data serves something else.")


def deploy(args):
    project = args.project_name or app_settings()["pagesProject"]
    realm = load_realm(args.realm) if args.realm else None
    if args.prepare_only:
        print(prepare_realm(realm) if realm else prepare_app(project)[0])
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
    if realm:
        directory, target = prepare_realm(realm), data_project(project, realm)
    else:
        directory, addresses = prepare_app(project)
        check_released(addresses)
        target = project
    # Pages rejects custom config paths. A clean working directory prevents it
    # from reading the separate private Worker's wrangler.jsonc or .dev.vars.
    with tempfile.TemporaryDirectory(prefix="explorer-pages-") as working_directory:
        if args.create_project:
            subprocess.run(command + ["pages", "project", "create", target, "--production-branch", "main"], cwd=working_directory, check=True)
        subprocess.run(
            command + ["pages", "deploy", str(directory), "--project-name", target,
                       "--branch", "main"],
            cwd=working_directory,
            check=True,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wrangler", default=os.environ.get("WRANGLER_JS"), help="Path to Wrangler's JavaScript entry point")
    parser.add_argument("--project-name", help="The app's Pages project; defaults to the one in realms/app.json")
    parser.add_argument("--realm", help="Release this realm's data to its own project instead of the app")
    parser.add_argument("--create-project", action="store_true", help="Create the Pages project before its first release")
    parser.add_argument("--prepare-only", action="store_true", help="Stage public files without running checks or deploying")
    deploy(parser.parse_args())
