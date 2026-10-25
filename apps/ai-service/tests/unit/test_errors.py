from typing import cast

import pytest

from app.errors import (
    AI_PROVIDER_REJECTED,
    AI_PROVIDER_UNAVAILABLE,
    ERROR_MESSAGES,
    FILE_INTEGRITY_ERROR,
    FILE_NOT_FOUND,
    INTERNAL_ERROR,
    INVALID_AI_OUTPUT,
    NOT_A_MEDICAL_DOCUMENT,
    TOO_MANY_PAGES,
    UNREADABLE_DOCUMENT,
    UNSUPPORTED_MIME_TYPE,
    PermanentError,
    TransientError,
)

CONTRACT_CODES = (
    "FILE_NOT_FOUND",
    "FILE_INTEGRITY_ERROR",
    "UNSUPPORTED_MIME_TYPE",
    "UNREADABLE_DOCUMENT",
    "TOO_MANY_PAGES",
    "NOT_A_MEDICAL_DOCUMENT",
    "INVALID_AI_OUTPUT",
    "AI_PROVIDER_REJECTED",
    "AI_PROVIDER_UNAVAILABLE",
    "INTERNAL_ERROR",
)
SECRET_MARKER = "GIZLI-KOD-7Q"


# Kod sabitlerinin değerinin sözleşme 6.8 ve 7.5'teki adın kendisi olduğunu doğrular.
def test_code_constants_equal_their_names() -> None:
    constants = (
        FILE_NOT_FOUND,
        FILE_INTEGRITY_ERROR,
        UNSUPPORTED_MIME_TYPE,
        UNREADABLE_DOCUMENT,
        TOO_MANY_PAGES,
        NOT_A_MEDICAL_DOCUMENT,
        INVALID_AI_OUTPUT,
        AI_PROVIDER_REJECTED,
        AI_PROVIDER_UNAVAILABLE,
        INTERNAL_ERROR,
    )

    assert constants == CONTRACT_CODES


# Her kodun boş olmayan, en fazla 500 karakterlik sabit bir mesajı olduğunu doğrular.
def test_every_code_has_short_fixed_message() -> None:
    assert set(ERROR_MESSAGES) == set(CONTRACT_CODES)
    for code in CONTRACT_CODES:
        message = ERROR_MESSAGES[code]
        assert isinstance(message, str)
        assert message.strip() == message
        assert 1 <= len(message) <= 500
        assert not any(mark in message for mark in ("{", "}", "%"))
        assert all(character.isprintable() for character in message)


# Mesaj tablosunun salt okunur olduğunu doğrular.
def test_error_messages_are_read_only() -> None:
    with pytest.raises(TypeError):
        cast(dict[str, str], ERROR_MESSAGES)[FILE_NOT_FOUND] = "Değiştirilmiş"


# PermanentError'ın kodu taşıdığını ve str() ile yalnızca kodu verdiğini doğrular.
@pytest.mark.parametrize("code", CONTRACT_CODES)
def test_permanent_error_carries_only_code(code: str) -> None:
    error = PermanentError(code)

    assert error.code == code
    assert str(error) == code
    assert error.args == (code,)
    assert isinstance(error, Exception)
    assert not isinstance(error, TransientError)


# Bilinmeyen ya da metin olmayan kodda ValueError verildiğini doğrular.
@pytest.mark.parametrize("code", [SECRET_MARKER, "", "file_not_found", None, 404])
def test_permanent_error_rejects_unknown_code(code: object) -> None:
    with pytest.raises(ValueError) as caught:
        PermanentError(cast(str, code))

    assert SECRET_MARKER not in str(caught.value)


# TransientError'ın kalıcı hatadan ayrı, sıradan bir istisna olduğunu doğrular.
def test_transient_error_is_separate_exception() -> None:
    error = TransientError()

    assert isinstance(error, Exception)
    assert not isinstance(error, PermanentError)
    assert not issubclass(PermanentError, TransientError)
