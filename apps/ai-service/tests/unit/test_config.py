import inspect
import os
import shutil
import subprocess
import sys
import traceback
from collections.abc import Iterable, Mapping
from pathlib import Path

import pytest
from pydantic import SecretStr

from app.config import (
    DEFAULT_ENV_FILE,
    PLACEHOLDER,
    ConfigError,
    Settings,
    load_settings,
)

SERVICE_DIR = Path(__file__).resolve().parents[2]
MISSING_PREFIX = "Eksik ya da doldurulmamış ayarlar: "
INVALID_PREFIX = "Geçersiz ayarlar: "
SECRET_VALUES = {
    "AI_RABBITMQ_PASSWORD": "sahte-rabbitmq-sifresi",
    "S3_ACCESS_KEY": "sahte-s3-erisim-anahtari",
    "S3_SECRET_KEY": "sahte-s3-gizli-anahtari",
    "AI_API_KEY": "sahte-ai-api-anahtari",
}
REQUIRED_VALUES = {
    "RABBITMQ_HOST": "sahte-rabbitmq",
    "AI_RABBITMQ_USER": "sahte-ai-kullanicisi",
    "S3_ENDPOINT": "http://sahte-s3:8333",
    "AI_API_BASE_URL": "https://sahte-ai.example/v1",
    "AI_MODEL": "sahte-model",
    **SECRET_VALUES,
}
DEFAULTS = {
    "RABBITMQ_PORT": 5672,
    "S3_BUCKET": "medical-documents",
    "AI_REQUEST_TIMEOUT_SECONDS": 120,
    "AI_ENABLE_THINKING": True,
    "LOG_LEVEL": "INFO",
}
ALL_REQUIRED_NAMES = (
    "AI_API_BASE_URL",
    "AI_API_KEY",
    "AI_MODEL",
    "AI_RABBITMQ_PASSWORD",
    "AI_RABBITMQ_USER",
    "RABBITMQ_HOST",
    "S3_ACCESS_KEY",
    "S3_ENDPOINT",
    "S3_SECRET_KEY",
)
EXAMPLE_PLACEHOLDER_NAMES = (
    "AI_API_BASE_URL",
    "AI_API_KEY",
    "AI_MODEL",
    "AI_RABBITMQ_PASSWORD",
    "AI_RABBITMQ_USER",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
)
IMPORT_CHECK_CODE = (
    "import sys\n"
    "import pydantic_settings\n"
    "def blocked(*args, **kwargs):\n"
    "    raise AssertionError('ayarlar import sırasında okundu')\n"
    "pydantic_settings.BaseSettings.__init__ = blocked\n"
    "sys.path.insert(0, sys.argv[1])\n"
    "from app.config import DEFAULT_ENV_FILE\n"
    "print(DEFAULT_ENV_FILE)\n"
)


# Ayar değişkenlerini ortamdan siler ve yalnızca verilen değerleri ortama yazar.
def use_environment(monkeypatch: pytest.MonkeyPatch, values: Mapping[str, str]) -> None:
    for name in list(os.environ):
        if name.lower() in Settings.model_fields:
            monkeypatch.delenv(name)
    for name, value in values.items():
        monkeypatch.setenv(name, value)


# Verilen satırlarla tmp_path altında sahte bir env dosyası yazar.
def write_env_file(directory: Path, lines: Iterable[str]) -> Path:
    path = directory / "sahte.env"
    path.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")
    return path


# load_settings çağrısının fırlattığı ConfigError'ı yakalayıp döndürür.
def load_error(env_file: Path | None = None) -> ConfigError:
    with pytest.raises(ConfigError) as caught:
        load_settings(env_file)
    return caught.value


# Hatanın zincirsiz olduğunu ve traceback metninde değerlerin geçmediğini doğrular.
def assert_values_hidden(error: ConfigError, values: Iterable[str]) -> None:
    text = "".join(traceback.format_exception(error))
    assert error.__cause__ is None
    assert error.__context__ is None
    for value in values:
        assert value not in text


# Zorunlu değerlerle ayarların yüklendiğini ve varsayılanların doğru olduğunu doğrular.
def test_loads_required_values_with_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    use_environment(monkeypatch, REQUIRED_VALUES)

    settings = load_settings(None)

    assert settings.rabbitmq_host == "sahte-rabbitmq"
    assert settings.ai_rabbitmq_user == "sahte-ai-kullanicisi"
    assert settings.s3_endpoint == "http://sahte-s3:8333"
    assert settings.ai_api_base_url == "https://sahte-ai.example/v1"
    assert settings.ai_model == "sahte-model"
    for name, value in SECRET_VALUES.items():
        secret = getattr(settings, name.lower())
        assert isinstance(secret, SecretStr)
        assert secret.get_secret_value() == value
    assert settings.rabbitmq_port == 5672
    assert settings.s3_bucket == "medical-documents"
    assert settings.ai_request_timeout_seconds == 120
    assert settings.ai_enable_thinking is True
    assert settings.log_level == "INFO"


# str ve repr çıktılarında gizli değerlerin görünmediğini doğrular.
def test_str_and_repr_hide_secret_values(monkeypatch: pytest.MonkeyPatch) -> None:
    use_environment(monkeypatch, REQUIRED_VALUES)

    settings = load_settings(None)

    for value in SECRET_VALUES.values():
        assert value not in str(settings)
        assert value not in repr(settings)


# Eksik değerlerin yalnızca adlarıyla ve alfabetik sırayla bildirildiğini doğrular.
def test_missing_values_are_reported_by_sorted_names(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    values = dict(REQUIRED_VALUES)
    del values["S3_SECRET_KEY"]
    del values["AI_API_KEY"]
    use_environment(monkeypatch, values)

    error = load_error()

    assert str(error) == MISSING_PREFIX + "AI_API_KEY, S3_SECRET_KEY"
    assert_values_hidden(error, REQUIRED_VALUES.values())


# Hiçbir değer yokken tüm zorunlu adların alfabetik listelendiğini doğrular.
def test_lists_every_required_name_when_nothing_is_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    use_environment(monkeypatch, {})

    error = load_error()

    assert str(error) == MISSING_PREFIX + ", ".join(ALL_REQUIRED_NAMES)


# Ortamdaki yer tutucu, boş ve yalnızca boşluk değerlerin eksik sayıldığını doğrular.
def test_unfilled_environment_values_count_as_missing(
    monkeypatch: pytest.MonkeyPatch, subtests: pytest.Subtests
) -> None:
    unfilled_values = (
        PLACEHOLDER,
        f'"{PLACEHOLDER}"',
        f"'{PLACEHOLDER}'",
        f'  "{PLACEHOLDER}"  ',
        "",
        "   ",
        " \t ",
    )
    for value in unfilled_values:
        with subtests.test(value=value):
            use_environment(monkeypatch, {**REQUIRED_VALUES, "AI_API_KEY": value})

            error = load_error()

            assert str(error) == MISSING_PREFIX + "AI_API_KEY"


# Dosyadaki tırnaklı, tırnaksız yer tutucuların ve boşluğun eksik sayıldığını doğrular.
def test_unfilled_file_values_count_as_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    use_environment(monkeypatch, {})
    unfilled_lines = [
        f'AI_API_KEY="{PLACEHOLDER}"',
        f"AI_MODEL='{PLACEHOLDER}'",
        f"S3_SECRET_KEY={PLACEHOLDER}",
        'AI_API_BASE_URL="   "',
    ]
    filled_lines = [
        f"{name}={value}"
        for name, value in REQUIRED_VALUES.items()
        if name not in ("AI_API_KEY", "AI_MODEL", "S3_SECRET_KEY", "AI_API_BASE_URL")
    ]
    env_file = write_env_file(tmp_path, [*filled_lines, *unfilled_lines])

    error = load_error(env_file)

    assert str(error) == MISSING_PREFIX + (
        "AI_API_BASE_URL, AI_API_KEY, AI_MODEL, S3_SECRET_KEY"
    )
    assert_values_hidden(error, REQUIRED_VALUES.values())


# Örnek env dosyasındaki doldurulacak alanların eksik olarak bildirildiğini doğrular.
def test_example_file_placeholders_are_reported_as_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    use_environment(monkeypatch, {})
    env_file = tmp_path / "example.env"
    shutil.copyfile(SERVICE_DIR / ".env.example", env_file)

    error = load_error(env_file)

    assert str(error) == MISSING_PREFIX + ", ".join(EXAMPLE_PLACEHOLDER_NAMES)


# Örnek dosya ortamla tamamlanınca dosyadaki değerlerin okunduğunu doğrular.
def test_example_file_loads_when_environment_fills_placeholders(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    use_environment(
        monkeypatch, {name: REQUIRED_VALUES[name] for name in EXAMPLE_PLACEHOLDER_NAMES}
    )
    env_file = tmp_path / "example.env"
    shutil.copyfile(SERVICE_DIR / ".env.example", env_file)

    settings = load_settings(env_file)

    assert settings.rabbitmq_host == "rabbitmq"
    assert settings.rabbitmq_port == 5672
    assert settings.s3_endpoint == "http://seaweedfs:8333"
    assert settings.s3_bucket == "medical-documents"
    assert settings.ai_api_key.get_secret_value() == "sahte-ai-api-anahtari"
    assert settings.ai_request_timeout_seconds == 120
    assert settings.ai_enable_thinking is True
    assert settings.log_level == "INFO"


# Dosyadaki değerin okunduğunu ve aynı değişkende ortamın kazandığını doğrular.
def test_environment_overrides_file_values(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    use_environment(
        monkeypatch, {"RABBITMQ_HOST": "ortam-rabbitmq", "RABBITMQ_PORT": "5673"}
    )
    env_file = write_env_file(
        tmp_path,
        [
            *(f"{name}={value}" for name, value in REQUIRED_VALUES.items()),
            "RABBITMQ_PORT=5674",
            "S3_BUCKET=dosya-kovasi",
        ],
    )

    settings = load_settings(env_file)

    assert settings.rabbitmq_host == "ortam-rabbitmq"
    assert settings.rabbitmq_port == 5673
    assert settings.s3_bucket == "dosya-kovasi"
    assert settings.ai_model == "sahte-model"


# Env dosyası bulunmadığında hata verilmediğini ve ortamın kullanıldığını doğrular.
def test_missing_env_file_is_not_an_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    use_environment(monkeypatch, REQUIRED_VALUES)

    settings = load_settings(tmp_path / "olmayan.env")

    assert settings.rabbitmq_host == "sahte-rabbitmq"


# Dosyadaki ve ortamdaki bilinmeyen değişkenlerin yok sayıldığını doğrular.
def test_unknown_variables_are_ignored(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    use_environment(monkeypatch, {**REQUIRED_VALUES, "BILINMEYEN_ORTAM": "deger"})
    env_file = write_env_file(tmp_path, ["BILINMEYEN_DOSYA=deger"])

    settings = load_settings(env_file)

    assert set(settings.model_dump()) == set(Settings.model_fields)


# Geçersiz port, zaman aşımı ve log seviyesinin yalnızca adla bildirildiğini doğrular.
def test_invalid_values_are_reported_without_values(
    monkeypatch: pytest.MonkeyPatch, subtests: pytest.Subtests
) -> None:
    invalid_values = (
        ("RABBITMQ_PORT", "sahte-port"),
        ("RABBITMQ_PORT", "0"),
        ("RABBITMQ_PORT", "-1"),
        ("RABBITMQ_PORT", "65536"),
        ("AI_REQUEST_TIMEOUT_SECONDS", "0"),
        ("AI_REQUEST_TIMEOUT_SECONDS", "-5"),
        ("AI_REQUEST_TIMEOUT_SECONDS", "sahte-sure"),
        ("LOG_LEVEL", "sahte-seviye"),
        ("LOG_LEVEL", "TRACE"),
        ("AI_ENABLE_THINKING", "sahte-dusunme"),
        ("AI_ENABLE_THINKING", "2"),
    )
    for name, value in invalid_values:
        with subtests.test(name=name, value=value):
            use_environment(monkeypatch, {**REQUIRED_VALUES, name: value})

            error = load_error()

            assert str(error) == INVALID_PREFIX + name
            assert_values_hidden(error, SECRET_VALUES.values())


# Birden çok geçersiz ayarın alfabetik sırayla bildirildiğini doğrular.
def test_multiple_invalid_values_are_sorted(monkeypatch: pytest.MonkeyPatch) -> None:
    use_environment(
        monkeypatch,
        {**REQUIRED_VALUES, "RABBITMQ_PORT": "sahte-port", "LOG_LEVEL": "sahte-seviye"},
    )

    error = load_error()

    assert str(error) == INVALID_PREFIX + "LOG_LEVEL, RABBITMQ_PORT"


# Eksik ve geçersiz ayarların tek mesajda, her listede alfabetik verildiğini doğrular.
@pytest.mark.parametrize(
    ("missing", "invalid", "expected"),
    [
        (
            ("AI_API_KEY",),
            {"RABBITMQ_PORT": "sahte-port"},
            "Eksik ya da doldurulmamış ayarlar: AI_API_KEY. "
            "Geçersiz ayarlar: RABBITMQ_PORT",
        ),
        (
            ("S3_SECRET_KEY", "AI_API_KEY"),
            {"RABBITMQ_PORT": "sahte-port", "LOG_LEVEL": "sahte-seviye"},
            "Eksik ya da doldurulmamış ayarlar: AI_API_KEY, S3_SECRET_KEY. "
            "Geçersiz ayarlar: LOG_LEVEL, RABBITMQ_PORT",
        ),
    ],
)
def test_missing_and_invalid_values_are_reported_together(
    monkeypatch: pytest.MonkeyPatch,
    missing: tuple[str, ...],
    invalid: dict[str, str],
    expected: str,
) -> None:
    values = {
        name: value for name, value in REQUIRED_VALUES.items() if name not in missing
    }
    use_environment(monkeypatch, {**values, **invalid})

    error = load_error()

    assert str(error) == expected
    assert_values_hidden(error, REQUIRED_VALUES.values())


# Varsayılanlı alan ortamda boş ya da boşluksa varsayılanın kullanıldığını doğrular.
@pytest.mark.parametrize(("name", "default"), list(DEFAULTS.items()))
@pytest.mark.parametrize(
    "value",
    [
        pytest.param("", id="bos"),
        pytest.param("   ", id="bosluk"),
        pytest.param(" \t ", id="sekme"),
        pytest.param('"  "', id="tirnakli-bosluk"),
    ],
)
def test_blank_environment_value_uses_default(
    monkeypatch: pytest.MonkeyPatch, name: str, default: object, value: str
) -> None:
    use_environment(monkeypatch, {**REQUIRED_VALUES, name: value})

    settings = load_settings(None)

    assert getattr(settings, name.lower()) == default


# Varsayılanlı alan dosyada boş ya da boşluksa varsayılanın kullanıldığını doğrular.
@pytest.mark.parametrize(("name", "default"), list(DEFAULTS.items()))
@pytest.mark.parametrize(
    "template",
    [
        pytest.param("{name}=", id="bos"),
        pytest.param("{name}=   ", id="tirnaksiz-bosluk"),
        pytest.param('{name}="   "', id="tirnakli-bosluk"),
        pytest.param("{name}=' \t '", id="tirnakli-sekme"),
    ],
)
def test_blank_file_value_uses_default(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    name: str,
    default: object,
    template: str,
) -> None:
    use_environment(monkeypatch, REQUIRED_VALUES)
    env_file = write_env_file(tmp_path, [template.format(name=name)])

    settings = load_settings(env_file)

    assert getattr(settings, name.lower()) == default


# Ortamdaki boş değerin dosyadakini ezip varsayılana düştüğünü doğrular.
@pytest.mark.parametrize(
    ("name", "file_value", "file_setting"),
    [
        ("RABBITMQ_PORT", "5674", 5674),
        ("S3_BUCKET", "dosya-kovasi", "dosya-kovasi"),
        ("AI_REQUEST_TIMEOUT_SECONDS", "30", 30),
        ("AI_ENABLE_THINKING", "false", False),
        ("LOG_LEVEL", "debug", "DEBUG"),
    ],
)
def test_blank_environment_value_beats_file_and_uses_default(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    name: str,
    file_value: str,
    file_setting: object,
) -> None:
    use_environment(monkeypatch, REQUIRED_VALUES)
    env_file = write_env_file(tmp_path, [f"{name}={file_value}"])
    assert getattr(load_settings(env_file), name.lower()) == file_setting

    monkeypatch.setenv(name, "")

    assert getattr(load_settings(env_file), name.lower()) == DEFAULTS[name]


# Sonlu olmayan zaman aşımının değer içermeyen hatayla reddedildiğini doğrular.
@pytest.mark.parametrize("value", ["inf", "-inf", "nan", "1e400"])
def test_non_finite_timeout_is_invalid(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    use_environment(
        monkeypatch, {**REQUIRED_VALUES, "AI_REQUEST_TIMEOUT_SECONDS": value}
    )

    error = load_error()

    assert str(error) == INVALID_PREFIX + "AI_REQUEST_TIMEOUT_SECONDS"
    assert_values_hidden(error, SECRET_VALUES.values())


# Varsayılanlı alanda ortamdaki yer tutucunun eksik olarak bildirildiğini doğrular.
@pytest.mark.parametrize("name", list(DEFAULTS))
@pytest.mark.parametrize(
    "value",
    [
        pytest.param(PLACEHOLDER, id="tirnaksiz"),
        pytest.param(f'"{PLACEHOLDER}"', id="cift-tirnakli"),
        pytest.param(f"'{PLACEHOLDER}'", id="tek-tirnakli"),
        pytest.param(f'  "{PLACEHOLDER}"  ', id="bosluklu-tirnakli"),
    ],
)
def test_placeholder_environment_value_in_defaulted_field_is_missing(
    monkeypatch: pytest.MonkeyPatch, name: str, value: str
) -> None:
    use_environment(monkeypatch, {**REQUIRED_VALUES, name: value})

    error = load_error()

    assert str(error) == MISSING_PREFIX + name
    assert_values_hidden(error, [*SECRET_VALUES.values(), PLACEHOLDER])


# Varsayılanlı alanda dosyadaki yer tutucunun eksik olarak bildirildiğini doğrular.
@pytest.mark.parametrize("name", list(DEFAULTS))
@pytest.mark.parametrize(
    "template",
    [
        pytest.param("{name}={placeholder}", id="tirnaksiz"),
        pytest.param('{name}="{placeholder}"', id="cift-tirnakli"),
        pytest.param("{name}='{placeholder}'", id="tek-tirnakli"),
    ],
)
def test_placeholder_file_value_in_defaulted_field_is_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, name: str, template: str
) -> None:
    use_environment(monkeypatch, REQUIRED_VALUES)
    line = template.format(name=name, placeholder=PLACEHOLDER)
    env_file = write_env_file(tmp_path, [line])

    error = load_error(env_file)

    assert str(error) == MISSING_PREFIX + name
    assert_values_hidden(error, [*SECRET_VALUES.values(), PLACEHOLDER])


# Yer tutucu ile geçersiz bir alan birlikteyken birleşik mesaj verildiğini doğrular.
@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        pytest.param(
            {"S3_BUCKET": PLACEHOLDER, "RABBITMQ_PORT": "sahte-port"},
            "Eksik ya da doldurulmamış ayarlar: S3_BUCKET. "
            "Geçersiz ayarlar: RABBITMQ_PORT",
            id="kova-ve-port",
        ),
        pytest.param(
            {
                "AI_API_KEY": PLACEHOLDER,
                "LOG_LEVEL": f'"{PLACEHOLDER}"',
                "AI_REQUEST_TIMEOUT_SECONDS": "inf",
            },
            "Eksik ya da doldurulmamış ayarlar: AI_API_KEY, LOG_LEVEL. "
            "Geçersiz ayarlar: AI_REQUEST_TIMEOUT_SECONDS",
            id="anahtar-log-seviyesi-ve-zaman-asimi",
        ),
    ],
)
def test_placeholder_and_invalid_values_are_reported_together(
    monkeypatch: pytest.MonkeyPatch, overrides: dict[str, str], expected: str
) -> None:
    use_environment(monkeypatch, {**REQUIRED_VALUES, **overrides})

    error = load_error()

    assert str(error) == expected
    assert_values_hidden(error, [*SECRET_VALUES.values(), PLACEHOLDER])


# Düşünme ayarının true/false yazımlarının harf duyarsız çözüldüğünü doğrular.
@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("true", True),
        ("TRUE", True),
        ("True", True),
        ("false", False),
        ("FALSE", False),
        ("False", False),
        ("1", True),
        ("0", False),
        ("yes", True),
        ("no", False),
    ],
)
def test_enable_thinking_parses_boolean_values(
    monkeypatch: pytest.MonkeyPatch, value: str, expected: bool
) -> None:
    use_environment(monkeypatch, {**REQUIRED_VALUES, "AI_ENABLE_THINKING": value})

    assert load_settings(None).ai_enable_thinking is expected


# Log seviyesinin harf duyarsız okunup büyük harfe çevrildiğini doğrular.
def test_log_level_is_read_case_insensitively(
    monkeypatch: pytest.MonkeyPatch, subtests: pytest.Subtests
) -> None:
    cases = (
        ("debug", "DEBUG"),
        ("Info", "INFO"),
        ("warning", "WARNING"),
        ("ERROR", "ERROR"),
    )
    for value, expected in cases:
        with subtests.test(value=value):
            use_environment(monkeypatch, {**REQUIRED_VALUES, "LOG_LEVEL": value})

            assert load_settings(None).log_level == expected


# Varsayılan env dosyasının servis dizinindeki .env olduğunu doğrular.
def test_default_env_file_is_service_dotenv() -> None:
    default = inspect.signature(load_settings).parameters["env_file"].default

    assert DEFAULT_ENV_FILE == SERVICE_DIR / ".env"
    assert DEFAULT_ENV_FILE.is_absolute()
    assert default == DEFAULT_ENV_FILE


# Import'un ayar okumadığını ve env yolunun çalışma dizinine bağlı olmadığını doğrular.
def test_import_reads_no_settings_and_path_ignores_cwd(tmp_path: Path) -> None:
    result = subprocess.run(
        [sys.executable, "-E", "-c", IMPORT_CHECK_CODE, str(SERVICE_DIR)],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == str(SERVICE_DIR / ".env")
