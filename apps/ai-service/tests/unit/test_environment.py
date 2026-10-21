import sys


# Testlerin Python 3.14 yorumlayıcısıyla çalıştığını doğrular.
def test_python_version_is_3_14() -> None:
    assert sys.version_info[:2] == (3, 14)
