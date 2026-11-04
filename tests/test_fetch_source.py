import hashlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import fetch_source


class FetchSourceTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.destination = Path(directory.name) / "data/good-one.parquet"
        self.contents = b"synthetic test bytes"
        self.enterContext(patch.object(fetch_source, "SOURCE_SHA256", hashlib.sha256(self.contents).hexdigest()))
        self.open_url = self.enterContext(patch.object(fetch_source, "urlopen"))

    def test_download_is_verified_and_reused_without_a_second_request(self):
        self.open_url.return_value = io.BytesIO(self.contents)
        fetch_source.fetch_source(self.destination)
        fetch_source.fetch_source(self.destination)
        self.open_url.assert_called_once_with(fetch_source.SOURCE_URL, timeout=60)
        self.assertEqual(self.destination.read_bytes(), self.contents)

    def test_different_existing_file_is_preserved(self):
        self.destination.parent.mkdir()
        self.destination.write_bytes(b"existing local bytes")
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            fetch_source.fetch_source(self.destination)
        self.assertEqual(self.destination.read_bytes(), b"existing local bytes")
        self.open_url.assert_not_called()

    def test_failed_verification_leaves_no_partial_file(self):
        self.open_url.return_value = io.BytesIO(b"truncated")
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            fetch_source.fetch_source(self.destination)
        self.assertEqual(list(self.destination.parent.iterdir()), [])
