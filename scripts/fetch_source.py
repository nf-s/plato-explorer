"""Download and verify the article and author attribution snapshots for local use."""

import argparse
import hashlib
from http.client import HTTPException
from pathlib import Path
import shutil
import tempfile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
ARTICLE_FILENAME = "stanford_plato.parquet"
ATTRIBUTION_FILENAME = "stanford-encyclopedia-of-philosophy_dec23.jsonl"
SOURCES = (
    (
        ARTICLE_FILENAME,
        "https://huggingface.co/datasets/hugfaceguy0001/stanford_plato/resolve/"
        "1076853c2f3eefc47bba652dc00459018ce695d1/"
        "data/train-00000-of-00001-65b5548e09cbc609.parquet",
        "de10c1cfd554b974ff60c93bca0af72cfc8bd1c17b1b10db957fbfe112f7a7f6",
    ),
    (
        ATTRIBUTION_FILENAME,
        "https://huggingface.co/datasets/dmarx/stanford-encyclopedia-of-philosophy_dec23/resolve/"
        f"29a689adb181fa4daa7027e5b5072ba47f76ac95/{ATTRIBUTION_FILENAME}",
        "ee87394ca0f4840ad4e539baa61ee996fce556567e9210fe2d4a62414ccea640",
    ),
)


def verify(path, expected_sha256):
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != expected_sha256:
        raise ValueError(f"{path} does not match the pinned dataset's SHA-256 checksum.")


def fetch_source(destination, url, expected_sha256):
    if destination.exists():
        verify(destination, expected_sha256)
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".fetch-", dir=destination.parent) as directory:
        download = Path(directory) / destination.name
        with urlopen(url, timeout=60) as response, download.open("wb") as stream:
            shutil.copyfileobj(response, stream)
        verify(download, expected_sha256)
        try:
            destination.hardlink_to(download)
        except FileExistsError:
            # A concurrent download may already have installed the same verified file.
            verify(destination, expected_sha256)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    for filename, url, sha256 in SOURCES:
        destination = ROOT / "data" / filename
        try:
            fetch_source(destination, url, sha256)
        except (OSError, ValueError, HTTPException) as error:
            raise SystemExit(f"Could not prepare {filename}: {error}") from error
        print(f"Verified {destination}", flush=True)
