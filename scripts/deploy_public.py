"""Verify and deploy the app to Cloudflare Pages, or upload one realm's stored files to object storage."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from realms import app_settings, built_realms, load_realm, realm_index, restricted_names

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
    "account.js",
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
ACCESS_BINDING = "AUTH_DB"
COMPATIBILITY_DATE = "2026-01-01"
# The Function imports the sign-in service from this folder, which is staged beside the release
# and bundled into the Function by Wrangler. Its files are never uploaded as assets.
ACCESS_SOURCE = Path("worker/auth")
# The full realm list, for a signed-in viewer's realm menu.
REALM_LIST_KEY = "realms.json"
# Wrangler uploads objects through the Cloudflare API, which accepts 1,200
# requests in five minutes. Each attempt at a batch stays under that, and a
# batch is recorded when it finishes, so an interrupted upload resumes.
UPLOAD_BATCH = 100
UPLOAD_INTERVAL = 30
UPLOAD_ATTEMPTS = 5


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


def function_routes(public, restricted):
    """Sign-in, a public realm's articles and everything in a restricted realm invoke the Function.
    Every other request is a free static asset."""
    include = ["/api/*", "/auth/*"]
    include.extend(f"/data/{realm.name}/articles/*" for realm in public)
    include.extend(f"/data/{realm.name}/*" for realm in restricted)
    return {"version": 1, "include": include, "exclude": []}


def split_realms(realms):
    """Separate the realms anyone can open from those a release shows only to approved accounts."""
    names = restricted_names()
    return [realm for realm in realms if realm.name not in names], [realm for realm in realms if realm.name in names]


def search_files(realm):
    return sorted((realm.output / "search").rglob("*.json"))


def public_index(index):
    return {"realms": [entry for entry in index["realms"] if not entry.get("restricted")]}


def prepare_app(destination):
    """Stage the app with each public realm's settings, graph and search index. Articles and
    restricted realms go to object storage."""
    source = ROOT / "web"
    realms = built_realms()
    if not realms:
        raise SystemExit("Build the generated data first; see README.md.")
    public, restricted = split_realms(realms)
    if not public:
        raise SystemExit("Build a public realm first; see README.md.")
    # Explicit files keep the earlier private Worker's code and any credentials out.
    files = [(source / name, Path(name)) for name in PUBLIC_FILES]
    for realm in realms:
        for name in REALM_FILES + ("search/manifest.json",):
            if not (realm.output / name).is_file():
                raise SystemExit(f"Build the {realm.name} data and search index first; see README.md.")
    for realm in public:
        data = Path("data") / realm.name
        files.extend((realm.output / name, data / name) for name in REALM_FILES)
        files.extend((path, data / path.relative_to(realm.output)) for path in search_files(realm))
    stage(files, destination)
    hidden = {realm.name for realm in restricted}
    for realm in public:
        # A restricted realm lists its own links to this realm, for those who can open it.
        links = destination / "data" / realm.name / "links.json"
        kept = {name: nodes for name, nodes in json.loads(links.read_text()).items() if name not in hidden}
        links.write_text(json.dumps(kept, ensure_ascii=False, separators=(",", ":")) + "\n")
    (destination / "data/realms.json").write_text(json.dumps(public_index(realm_index(restricted=hidden)), ensure_ascii=False, indent=2) + "\n")
    (destination / "_routes.json").write_text(json.dumps(function_routes(public, restricted), indent=2) + "\n")
    stage_access(destination.parent)
    return destination


def stage_access(working_directory):
    """Copy the sign-in service and its database migrations beside the release, where the Function's import finds them."""
    target = working_directory / ACCESS_SOURCE
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(ROOT / ACCESS_SOURCE, target, ignore=shutil.ignore_patterns("*.test.mjs", "test-support.mjs"))


def article_files(realm):
    """Map each article's object key to its file. Files left behind by an earlier build are not in the graph."""
    nodes = json.loads((realm.output / "graph.json").read_text())["nodes"]
    return {f"{realm.name}/articles/{node['id']}.json": realm.output / "articles" / f"{node['id']}.json" for node in nodes if node["article"]}


def stored_files(realm):
    """Map each object key to its file: a realm's articles, and for a restricted realm its settings,
    graph and search index as well, which a release keeps out of the static assets."""
    files = article_files(realm)
    if realm.name in restricted_names():
        files.update((f"{realm.name}/{name}", realm.output / name) for name in REALM_FILES)
        files.update((f"{realm.name}/{path.relative_to(realm.output).as_posix()}", path) for path in search_files(realm))
    return files


def digests(files):
    return {key: hashlib.sha256(path.read_bytes()).hexdigest() for key, path in files.items()}


def upload_record(bucket, realm):
    return STAGING / "uploaded" / bucket / f"{realm.name}.json"


def read_record(path):
    return json.loads(path.read_text()) if path.is_file() else {}


def pending(current, uploaded):
    """Keys whose article is new or has changed since it was uploaded."""
    return sorted(key for key, digest in current.items() if uploaded.get(key) != digest)


def wait_for_request_limit(began):
    time.sleep(max(0.0, UPLOAD_INTERVAL - (time.monotonic() - began)))


def put_batch(command, bucket, pairs, working_directory):
    """Upload the listed articles and return when the upload began.

    Wrangler stops a batch at the first object Cloudflare rejects, so a failed batch is sent again."""
    for _ in range(UPLOAD_ATTEMPTS):
        began = time.monotonic()
        result = subprocess.run(
            command + ["r2", "bulk", "put", bucket, "--remote", "--force", "--filename", str(pairs),
                       "--content-type", "application/json"],
            cwd=working_directory,
            check=False,
            stdout=subprocess.DEVNULL,
        )
        if result.returncode == 0:
            return began
        wait_for_request_limit(began)
    raise SystemExit(f"A batch failed {UPLOAD_ATTEMPTS} times. Run the same command again to resume.")


def upload_articles(command, bucket, realm):
    """Upload the realm's new and changed files, one object each."""
    files = stored_files(realm)
    current = digests(files)
    record = upload_record(bucket, realm)
    uploaded = read_record(record)
    keys = pending(current, uploaded)
    print(f"{realm.name}: {len(keys):,} of {len(files):,} files to upload", flush=True)
    record.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="explorer-articles-") as temporary:
        working_directory = clean_directory(temporary)
        pairs = working_directory / "articles.json"
        for start in range(0, len(keys), UPLOAD_BATCH):
            batch = keys[start:start + UPLOAD_BATCH]
            pairs.write_text(json.dumps([{"key": key, "file": str(files[key])} for key in batch]))
            began = put_batch(command, bucket, pairs, working_directory)
            uploaded.update((key, current[key]) for key in batch)
            record.write_text(json.dumps(uploaded, sort_keys=True) + "\n")
            print(f"{realm.name}: {min(start + UPLOAD_BATCH, len(keys)):,} uploaded", flush=True)
            if start + UPLOAD_BATCH < len(keys):
                wait_for_request_limit(began)
    stale = sorted(set(uploaded) - set(current))
    if stale:
        print(f"{realm.name}: {len(stale):,} uploaded files are no longer in the realm; see docs/public-deployment.md.", flush=True)


def check_uploaded(bucket, realms):
    """The app is released after the files its realms need from object storage."""
    for realm in realms:
        missing = pending(digests(stored_files(realm)), read_record(upload_record(bucket, realm)))
        if missing:
            raise SystemExit(f"{len(missing):,} {realm.name} files are not uploaded. Run this script with --articles {realm.name} first.")


def upload_realm_list(command, bucket, working_directory):
    """Store the full realm list, which the Function gives to signed-in accounts."""
    listing = working_directory / REALM_LIST_KEY
    listing.write_text(json.dumps(realm_index(restricted=restricted_names()), ensure_ascii=False, indent=2) + "\n")
    pairs = working_directory / "realm-list.json"
    pairs.write_text(json.dumps([{"key": REALM_LIST_KEY, "file": str(listing)}]))
    put_batch(command, bucket, pairs, working_directory)


def database_id(command, name, working_directory):
    """Look the access database up by name, which keeps its identifier out of the repository."""
    result = subprocess.run(command + ["d1", "info", name, "--json"], cwd=working_directory, check=True, capture_output=True, text=True)
    identifier = json.loads(result.stdout).get("uuid")
    if not isinstance(identifier, str) or not identifier:
        raise SystemExit(f"The database {name} was not found. See the one-time setup in docs/public-deployment.md.")
    return identifier


def configuration(project, directory, settings, public, access_database_id):
    """Wrangler takes the Function's bindings and variables from this file, written beside the release.
    The Google client and the administrator are Pages secrets and are not named here."""
    return {
        "name": project,
        "pages_build_output_dir": directory,
        "compatibility_date": COMPATIBILITY_DATE,
        "r2_buckets": [{"binding": ARTICLES_BINDING, "bucket_name": settings["articlesBucket"]}],
        "d1_databases": [{
            "binding": ACCESS_BINDING,
            "database_name": settings["accessDatabase"],
            "database_id": access_database_id,
            "migrations_dir": (ACCESS_SOURCE / "migrations").as_posix(),
        }],
        "vars": {"PUBLIC_URL": settings["publicUrl"], "PUBLIC_REALMS": ",".join(realm.name for realm in public)},
    }


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
    realms = built_realms()
    check_uploaded(bucket, realms)
    public, restricted = split_realms(realms)
    with tempfile.TemporaryDirectory(prefix="explorer-pages-") as temporary:
        working_directory = clean_directory(temporary)
        directory = prepare_app(working_directory / "public")
        identifier = database_id(command, settings["accessDatabase"], working_directory)
        (working_directory / "wrangler.json").write_text(json.dumps(configuration(project, directory.name, settings, public, identifier), indent=2) + "\n")
        subprocess.run(command + ["d1", "migrations", "apply", settings["accessDatabase"], "--remote"], cwd=working_directory, check=True)
        if restricted:
            upload_realm_list(command, bucket, working_directory)
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
    parser.add_argument("--articles", metavar="REALM", help="Upload this realm's new and changed articles to object storage instead of releasing the app. A restricted realm's settings, graph and search index go with them")
    parser.add_argument("--prepare-only", action="store_true", help="Stage public files without running checks or deploying")
    deploy(parser.parse_args())
