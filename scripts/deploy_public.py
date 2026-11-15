"""Verify and deploy the app to Cloudflare Pages, or upload one realm's articles to object storage."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from realms import app_settings, built_realms, load_realm, realm_index

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
    "_worker.js",
)


# Local reports stay out of releases.
REALM_FILES = ("realm.json", "links.json", "graph.json")
STAGING = ROOT / ".artifacts"
# The Pages Free plan accepts this many files in one project.
FILE_LIMIT = 20000
ARTICLES_BINDING = "ARTICLES"
COMPATIBILITY_DATE = "2026-01-01"
# Wrangler uploads objects through the Cloudflare API, which accepts 1,200
# requests in five minutes. Each batch stays under that and is recorded when
# it finishes, so an interrupted upload resumes.
UPLOAD_BATCH = 1000
UPLOAD_INTERVAL = 300


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


def article_routes(realms):
    """Only article requests invoke the Function. Every other request is a free static asset."""
    return {"version": 1, "include": [f"/data/{realm.name}/articles/*" for realm in realms], "exclude": []}


def prepare_app(destination):
    """Stage the app with each realm's settings, graph and search index. Articles go to object storage."""
    source = ROOT / "web"
    realms = built_realms()
    if not realms:
        raise SystemExit("Build the generated data first; see README.md.")
    # Explicit files keep legacy account/login code and any credentials out.
    files = [(source / name, Path(name)) for name in PUBLIC_FILES]
    for realm in realms:
        for name in REALM_FILES + ("search/manifest.json",):
            if not (realm.output / name).is_file():
                raise SystemExit(f"Build the {realm.name} data and search index first; see README.md.")
        data = Path("data") / realm.name
        files.extend((realm.output / name, data / name) for name in REALM_FILES)
        files.extend((path, data / path.relative_to(realm.output)) for path in sorted((realm.output / "search").rglob("*.json")))
    stage(files, destination)
    (destination / "data/realms.json").write_text(json.dumps(realm_index(), ensure_ascii=False, indent=2) + "\n")
    (destination / "_routes.json").write_text(json.dumps(article_routes(realms), indent=2) + "\n")
    return destination


def article_files(realm):
    """Map each article's object key to its file. Files left behind by an earlier build are not in the graph."""
    nodes = json.loads((realm.output / "graph.json").read_text())["nodes"]
    return {f"{realm.name}/articles/{node['id']}.json": realm.output / "articles" / f"{node['id']}.json" for node in nodes if node["article"]}


def digests(files):
    return {key: hashlib.sha256(path.read_bytes()).hexdigest() for key, path in files.items()}


def upload_record(bucket, realm):
    return STAGING / "uploaded" / bucket / f"{realm.name}.json"


def read_record(path):
    return json.loads(path.read_text()) if path.is_file() else {}


def pending(current, uploaded):
    """Keys whose article is new or has changed since it was uploaded."""
    return sorted(key for key, digest in current.items() if uploaded.get(key) != digest)


def upload_articles(command, bucket, realm):
    """Upload the realm's new and changed articles, one object each."""
    files = article_files(realm)
    current = digests(files)
    record = upload_record(bucket, realm)
    uploaded = read_record(record)
    keys = pending(current, uploaded)
    print(f"{realm.name}: {len(keys):,} of {len(files):,} articles to upload", flush=True)
    record.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="explorer-articles-") as temporary:
        working_directory = clean_directory(temporary)
        pairs = working_directory / "articles.json"
        for start in range(0, len(keys), UPLOAD_BATCH):
            began = time.monotonic()
            batch = keys[start:start + UPLOAD_BATCH]
            pairs.write_text(json.dumps([{"key": key, "file": str(files[key])} for key in batch]))
            subprocess.run(
                command + ["r2", "bulk", "put", bucket, "--remote", "--force", "--filename", str(pairs),
                           "--content-type", "application/json"],
                cwd=working_directory,
                check=True,
                stdout=subprocess.DEVNULL,
            )
            uploaded.update((key, current[key]) for key in batch)
            record.write_text(json.dumps(uploaded, sort_keys=True) + "\n")
            print(f"{realm.name}: {min(start + UPLOAD_BATCH, len(keys)):,} uploaded", flush=True)
            if start + UPLOAD_BATCH < len(keys):
                time.sleep(max(0.0, UPLOAD_INTERVAL - (time.monotonic() - began)))
    stale = sorted(set(uploaded) - set(current))
    if stale:
        print(f"{realm.name}: {len(stale):,} uploaded articles are no longer in the graph; see docs/public-deployment.md.", flush=True)


def check_uploaded(bucket, realms):
    """The app is released after the articles its graphs list."""
    for realm in realms:
        missing = pending(digests(article_files(realm)), read_record(upload_record(bucket, realm)))
        if missing:
            raise SystemExit(f"{len(missing):,} {realm.name} articles are not uploaded. Run this script with --articles {realm.name} first.")


def clean_directory(path):
    """Wrangler reads the nearest configuration above its working directory. Running it outside
    the repository keeps it from the private Worker's wrangler.jsonc and .dev.vars."""
    directory = Path(path).resolve()
    if ROOT == directory or ROOT in directory.parents:
        raise SystemExit("Set TMPDIR to a folder outside the repository before running Wrangler.")
    return directory


def wrangler_command(args):
    if not os.environ.get("CLOUDFLARE_ACCOUNT_ID"):
        raise SystemExit("Set CLOUDFLARE_ACCOUNT_ID to the destination Cloudflare account before deploying.")
    if args.wrangler:
        return ["node", str(Path(args.wrangler).expanduser().resolve())]
    executable = shutil.which("wrangler")
    if not executable:
        raise SystemExit("Provide --wrangler /path/to/wrangler/bin/wrangler.js or install Wrangler on PATH.")
    return [executable]


def deploy(args):
    settings = app_settings()
    project = args.project_name or settings["pagesProject"]
    bucket = settings["articlesBucket"]
    if args.prepare_only:
        print(prepare_app(STAGING / "public"))
        return
    command = wrangler_command(args)
    if args.articles:
        upload_articles(command, bucket, load_realm(args.articles))
        return
    subprocess.run(["npm", "run", "check"], cwd=ROOT, check=True)
    subprocess.run(["node", "--check", "web/navigation.js"], cwd=ROOT, check=True)
    subprocess.run(["npm", "test"], cwd=ROOT, check=True)
    check_uploaded(bucket, built_realms())
    with tempfile.TemporaryDirectory(prefix="explorer-pages-") as temporary:
        working_directory = clean_directory(temporary)
        directory = prepare_app(working_directory / "public")
        # Wrangler takes the Function's bindings from the configuration beside the release.
        configuration = {
            "name": project,
            "pages_build_output_dir": directory.name,
            "compatibility_date": COMPATIBILITY_DATE,
            "r2_buckets": [{"binding": ARTICLES_BINDING, "bucket_name": bucket}],
        }
        (working_directory / "wrangler.json").write_text(json.dumps(configuration, indent=2) + "\n")
        subprocess.run(
            command + ["pages", "deploy", directory.name, "--project-name", project,
                       "--branch", "main"],
            cwd=working_directory,
            check=True,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wrangler", default=os.environ.get("WRANGLER_JS"), help="Path to Wrangler's JavaScript entry point")
    parser.add_argument("--project-name", help="The app's Pages project; defaults to the one in realms/app.json")
    parser.add_argument("--articles", metavar="REALM", help="Upload this realm's new and changed articles to object storage instead of releasing the app")
    parser.add_argument("--prepare-only", action="store_true", help="Stage public files without running checks or deploying")
    deploy(parser.parse_args())
