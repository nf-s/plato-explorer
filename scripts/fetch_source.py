"""Download the pinned Hugging Face Parquet to data/good-one.parquet for local use."""

import argparse
import hashlib
from http.client import HTTPException
from pathlib import Path
import shutil
import tempfile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
SOURCE_URL = (
    "https://huggingface.co/datasets/hugfaceguy0001/stanford_plato/resolve/"
    "1076853c2f3eefc47bba652dc00459018ce695d1/"
    "data/train-00000-of-00001-65b5548e09cbc609.parquet"
)
SOURCE_SHA256 = "de10c1cfd554b974ff60c93bca0af72cfc8bd1c17b1b10db957fbfe112f7a7f6"


def verify(path):
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != SOURCE_SHA256:
        raise ValueError(f"{path} does not match the pinned dataset's SHA-256 checksum.")


def fetch_source(destination):
    if destination.exists():
        verify(destination)
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".fetch-", dir=destination.parent) as directory:
        download = Path(directory) / destination.name
        with urlopen(SOURCE_URL, timeout=60) as response, download.open("wb") as stream:
            shutil.copyfileobj(response, stream)
        verify(download)
        try:
            destination.hardlink_to(download)
        except FileExistsError:
            # A concurrent download may already have installed the same verified file.
            verify(destination)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    destination = ROOT / "data/good-one.parquet"
    try:
        fetch_source(destination)
    except (OSError, ValueError, HTTPException) as error:
        raise SystemExit(f"Could not prepare the local dataset: {error}") from error
    print(f"Verified {destination}")
