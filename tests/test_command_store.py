import unittest
from tempfile import TemporaryDirectory

import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1] / "backend"))

from command_store import CommandStore


class CommandStoreTests(unittest.TestCase):
    def test_appends_command_history_and_persists_status(self):
        with TemporaryDirectory() as directory:
            store = CommandStore(Path(directory))
            entry = store.append({
                "source": "manual_charge",
                "channel": "home_assistant",
                "mode": "charge",
                "ok": True,
            })
            status = store.save_status({
                "ok": True,
                "source": "manual_charge",
                "command_id": entry["id"],
            })

            self.assertEqual(store.list(limit=1)[0]["id"], entry["id"])
            self.assertEqual(store.load_status()["command_id"], entry["id"])
            self.assertTrue(status["ok"])


if __name__ == "__main__":
    unittest.main()
