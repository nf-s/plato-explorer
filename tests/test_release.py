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

    def test_only_sign_in_articles_and_restricted_realms_invoke_the_function(self):
        public, restricted = deploy_public.split_realms([realms.load_realm(name) for name in realms.realm_names()])
        self.assertEqual([realm.name for realm in restricted], realms.restricted_names())
        routes = deploy_public.function_routes(public, restricted)
        self.assertEqual(routes["include"], ["/api/*", "/auth/*"] + [f"/data/{realm.name}/articles/*" for realm in public] + [f"/data/{realm.name}/*" for realm in restricted])
        self.assertEqual(routes["exclude"], [])
        # Pages accepts 100 rules.
        self.assertLessEqual(len(routes["include"]), 100)

    def test_the_public_realm_list_leaves_out_restricted_realms(self):
        index = {"realms": [{"id": "philosophy", "restricted": True}, {"id": "psychology"}]}
        self.assertEqual(deploy_public.public_index(index), {"realms": [{"id": "psychology"}]})

    def test_wrangler_never_runs_inside_the_repository(self):
        with self.assertRaises(SystemExit):
            deploy_public.clean_directory(deploy_public.STAGING)
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(deploy_public.clean_directory(directory), Path(directory).resolve())

    def test_the_function_reads_the_bindings_the_release_declares(self):
        settings = realms.app_settings()
        public, _ = deploy_public.split_realms([realms.load_realm(name) for name in realms.realm_names()])
        configuration = deploy_public.configuration("project", "public", settings, public, "database-id")
        declared = {"ASSETS"} | {entry["binding"] for entry in configuration["r2_buckets"] + configuration["d1_databases"]} | set(configuration["vars"])
        source = (deploy_public.ROOT / "web/_worker.js").read_text()
        self.assertLessEqual(set(re.findall(r"env\.([A-Z_]+)", source)), declared)
        self.assertIn("_worker.js", deploy_public.PUBLIC_FILES)
        # The account service reads its database and address; its other settings are Pages secrets.
        service = "".join(path.read_text() for path in (deploy_public.ROOT / deploy_public.ACCESS_SOURCE).glob("*.mjs") if "test" not in path.name)
        self.assertLessEqual(set(re.findall(r"env\.([A-Z_]+)", service)) - {"GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ADMIN_EMAIL", "ADMIN_SUBJECT"}, declared)
        self.assertEqual(configuration["vars"]["PUBLIC_REALMS"], ",".join(realm.name for realm in public))
        self.assertNotIn(realms.restricted_names()[0], configuration["vars"]["PUBLIC_REALMS"].split(","))
        self.assertTrue((deploy_public.ROOT / configuration["d1_databases"][0]["migrations_dir"]).is_dir())

    def test_a_restricted_realm_keeps_its_graph_and_search_index_in_storage(self):
        name = realms.restricted_names()[0]
        if not (realms.DATA / name / "search/manifest.json").is_file():
            self.skipTest("Build the dataset and full-text index first.")
        keys = set(deploy_public.stored_files(realms.load_realm(name)))
        self.assertLessEqual({f"{name}/{file}" for file in deploy_public.REALM_FILES} | {f"{name}/search/manifest.json"}, keys)
        self.assertTrue(any(key.startswith(f"{name}/articles/") for key in keys))


class AppSettingsTests(unittest.TestCase):
    def test_the_settings_name_a_project_a_bucket_and_realms(self):
        settings = realms.app_settings()
        self.assertEqual(set(settings), {"pagesProject", "publicUrl", "articlesBucket", "accessDatabase", "realms", "restrictedRealms"})
        self.assertLess(set(settings["restrictedRealms"]), set(settings["realms"]))
        self.assertRegex(settings["articlesBucket"], r"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$")
        self.assertEqual(json.loads((realms.REALMS / "app.json").read_text()), settings)


if __name__ == "__main__":
    unittest.main()
