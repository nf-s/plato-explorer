import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import deploy_public
import realms


class ArticleUploadTests(unittest.TestCase):
    def test_only_new_and_changed_articles_are_pending(self):
        current = {"philosophy/articles/a.json": "1", "philosophy/articles/b.json": "2", "philosophy/articles/c.json": "3"}
        uploaded = {"philosophy/articles/a.json": "1", "philosophy/articles/b.json": "old", "philosophy/articles/gone.json": "9"}
        self.assertEqual(deploy_public.pending(current, uploaded), ["philosophy/articles/b.json", "philosophy/articles/c.json"])
        self.assertEqual(deploy_public.pending(current, current), [])

    def test_an_article_changes_its_digest_when_its_text_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "a.json"
            path.write_text('{"id": "a"}')
            first = deploy_public.digests({"philosophy/articles/a.json": path})
            path.write_text('{"id": "a", "title": "A"}')
            second = deploy_public.digests({"philosophy/articles/a.json": path})
        self.assertEqual(list(first), ["philosophy/articles/a.json"])
        self.assertNotEqual(first, second)

    def test_a_batch_stays_under_the_request_limit(self):
        self.assertLess(deploy_public.UPLOAD_BATCH / deploy_public.UPLOAD_INTERVAL, 1200 / 300)

    def test_only_article_paths_invoke_the_function(self):
        chosen = [realms.load_realm(name) for name in realms.realm_names()[:2]]
        routes = deploy_public.article_routes(chosen)
        self.assertEqual(routes["include"], [f"/data/{realm.name}/articles/*" for realm in chosen])
        self.assertEqual(routes["exclude"], [])

    def test_wrangler_never_runs_inside_the_repository(self):
        with self.assertRaises(SystemExit):
            deploy_public.clean_directory(deploy_public.STAGING)
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(deploy_public.clean_directory(directory), Path(directory).resolve())

    def test_the_function_reads_the_binding_the_release_declares(self):
        source = (deploy_public.ROOT / "web/_worker.js").read_text()
        self.assertEqual(set(re.findall(r"env\.([A-Z_]+)", source)), {"ASSETS", deploy_public.ARTICLES_BINDING})
        self.assertIn("_worker.js", deploy_public.PUBLIC_FILES)


class AppSettingsTests(unittest.TestCase):
    def test_the_settings_name_a_project_a_bucket_and_realms(self):
        settings = realms.app_settings()
        self.assertEqual(set(settings), {"pagesProject", "articlesBucket", "realms"})
        self.assertRegex(settings["articlesBucket"], r"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$")
        self.assertEqual(json.loads((realms.REALMS / "app.json").read_text()), settings)


if __name__ == "__main__":
    unittest.main()
