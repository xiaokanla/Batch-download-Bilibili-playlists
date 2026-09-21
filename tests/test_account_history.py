import tempfile
import unittest
from pathlib import Path

import manager as manager_module
from manager import BiliManager


class AccountHistoryTests(unittest.TestCase):
    def test_switching_uid_restores_separate_download_history(self):
        old_base_dir = manager_module.BASE_DIR
        old_last_cookie = manager_module.LAST_LOGIN_COOKIE
        old_netscape_temp = manager_module.NETSCAPE_TEMP
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                manager_module.BASE_DIR = str(root / "userdata")
                manager_module.LAST_LOGIN_COOKIE = str(root / "last_login_cookie.json")
                manager_module.NETSCAPE_TEMP = str(root / "bili_netscape_temp.txt")

                manager = BiliManager()
                manager.switch_user("10001")
                manager.history.add("BV_ACCOUNT_A")
                manager.save_data()

                manager.switch_user("20002")
                self.assertEqual(manager.history, set())
                manager.history.add("BV_ACCOUNT_B")
                manager.save_data()

                manager.switch_user("10001")
                self.assertEqual(manager.history, {"BV_ACCOUNT_A"})
                manager.switch_user("20002")
                self.assertEqual(manager.history, {"BV_ACCOUNT_B"})
        finally:
            manager_module.BASE_DIR = old_base_dir
            manager_module.LAST_LOGIN_COOKIE = old_last_cookie
            manager_module.NETSCAPE_TEMP = old_netscape_temp


if __name__ == "__main__":
    unittest.main()
