import copy
import json
import re
from collections.abc import Iterator
from typing import Any

import pytest

from app.generated import medical_record_pb2
from app.llm.schemas import EXTRACTION_SCHEMA, EXTRACTION_SCHEMA_NAME

ALLOWED_KEYWORDS = frozenset(
    {"type", "properties", "required", "additionalProperties", "items", "enum", "anyOf"}
)
JSON_TYPES = frozenset(
    {"object", "array", "string", "number", "integer", "boolean", "null"}
)
LOWER_CAMEL_CASE = re.compile(r"[a-z][a-zA-Z]*")

CONTRACT_EXAMPLE: dict[str, Any] = {
    "isMedicalDocument": True,
    "confidence": 0.86,
    "proposal": {
        "type": "LAB_RESULT",
        "title": "Hemogram",
        "notes": "",
        "recordedAt": "2026-10-20",
        "labResult": {
            "sampledAt": "2026-10-20",
            "items": [
                {
                    "testName": "WBC",
                    "value": "12.4",
                    "unit": "10^3/µL",
                    "referenceRange": "5.5-19.5",
                    "flag": "NORMAL",
                }
            ],
        },
    },
}


# Şemadaki bütün alt şemaları yollarıyla birlikte sırayla dolaşır.
def _walk(schema: dict[str, Any], path: str = "$") -> Iterator[tuple[str, dict]]:
    yield path, schema
    for name, child in schema.get("properties", {}).items():
        yield from _walk(child, f"{path}.{name}")
    if "items" in schema:
        yield from _walk(schema["items"], f"{path}[]")
    for index, option in enumerate(schema.get("anyOf", [])):
        yield from _walk(option, f"{path}|{index}")


# Değerin verilen JSON Schema türüne uyup uymadığını söyler.
def _matches_type(expected: str, value: object) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, int | float) and not isinstance(value, bool)
    return expected == "null" and value is None


# Değeri şemaya katı biçimde uygular ve uymayan yolların listesini döndürür.
def _violations(schema: dict[str, Any], value: object, path: str = "$") -> list[str]:
    if "anyOf" in schema:
        if any(not _violations(option, value, path) for option in schema["anyOf"]):
            return []
        return [path]
    if not _matches_type(schema["type"], value):
        return [path]
    if "enum" in schema and value not in schema["enum"]:
        return [path]
    problems: list[str] = []
    if isinstance(value, dict):
        properties = schema["properties"]
        problems.extend(f"{path}.{name}" for name in value if name not in properties)
        problems.extend(
            f"{path}.{name}" for name in schema["required"] if name not in value
        )
        for name, child in value.items():
            if name in properties:
                problems.extend(_violations(properties[name], child, f"{path}.{name}"))
    if isinstance(value, list):
        for index, item in enumerate(value):
            problems.extend(_violations(schema["items"], item, f"{path}[{index}]"))
    return problems


# Alt şemanın nesne seçeneğini, anyOf içindeyse oradan bularak döndürür.
def _object_option(schema: dict[str, Any]) -> dict[str, Any]:
    if schema.get("type") == "object":
        return schema
    return next(option for option in schema["anyOf"] if option.get("type") == "object")


# Örnekteki alanların şemada aynı yerde ve uygun türde bulunmadığı yolları döndürür.
def _unknown_fields(
    schema: dict[str, Any], value: object, path: str = "$"
) -> list[str]:
    if isinstance(value, dict):
        properties = _object_option(schema)["properties"]
        problems: list[str] = []
        for name, child in value.items():
            if name not in properties:
                problems.append(f"{path}.{name}")
            else:
                problems.extend(
                    _unknown_fields(properties[name], child, f"{path}.{name}")
                )
        return problems
    if isinstance(value, list):
        items = (
            _object_option(schema)["items"] if "anyOf" in schema else schema["items"]
        )
        problems = []
        for index, item in enumerate(value):
            problems.extend(_unknown_fields(items, item, f"{path}[{index}]"))
        return problems
    return _violations(schema, value, path)


# Proto mesajının alanlarının JSON adlarını döndürür.
def _json_names(message: Any) -> set[str]:
    return {field.json_name for field in message.DESCRIPTOR.fields}


# Sözleşme 6.5 örneğini, eksik ayrıntı alanlarını null yaparak katı şemaya tamamlar.
def _completed_contract_example() -> dict[str, Any]:
    example = copy.deepcopy(CONTRACT_EXAMPLE)
    example["proposal"]["vaccination"] = None
    example["proposal"]["prescription"] = None
    return example


# Şema adı sözleşme 8.2'deki json_schema adıyla aynıdır.
def test_schema_name() -> None:
    assert EXTRACTION_SCHEMA_NAME == "record_content"


# Şema JSON'a çevrilip geri okunabilir, böylece talimata metin olarak da gömülebilir.
def test_schema_is_json_serializable() -> None:
    text = json.dumps(EXTRACTION_SCHEMA, ensure_ascii=False)
    assert json.loads(text) == EXTRACTION_SCHEMA


# Kök düğüm katı kullanım için anyOf değil nesnedir ve üç alanı vardır.
def test_root_is_object_with_three_fields() -> None:
    assert EXTRACTION_SCHEMA["type"] == "object"
    assert "anyOf" not in EXTRACTION_SCHEMA
    assert list(EXTRACTION_SCHEMA["properties"]) == [
        "isMedicalDocument",
        "confidence",
        "proposal",
    ]
    assert EXTRACTION_SCHEMA["properties"]["isMedicalDocument"] == {"type": "boolean"}
    assert EXTRACTION_SCHEMA["properties"]["confidence"] == {"type": "number"}


# Her düğüm bilinen anahtar kelimelerle geçerli bir JSON Schema yapısı kurar.
def test_schema_has_valid_structure() -> None:
    for path, node in _walk(EXTRACTION_SCHEMA):
        assert isinstance(node, dict), path
        assert set(node) <= ALLOWED_KEYWORDS, path
        assert ("type" in node) != ("anyOf" in node), path
        if "anyOf" in node:
            assert set(node) == {"anyOf"}, path
            assert isinstance(node["anyOf"], list) and len(node["anyOf"]) >= 2, path
            continue
        assert node["type"] in JSON_TYPES, path
        if node["type"] == "object":
            assert isinstance(node["properties"], dict) and node["properties"], path
        else:
            assert not {"properties", "required", "additionalProperties"} & set(node)
        if node["type"] == "array":
            assert isinstance(node["items"], dict), path
        else:
            assert "items" not in node, path
        if "enum" in node:
            values = node["enum"]
            assert isinstance(values, list) and values, path
            assert len(values) == len(set(values)), path
            assert all(_matches_type(node["type"], value) for value in values), path


# Her nesnede additionalProperties false ve bütün alanlar required listesindedir.
def test_every_object_is_strict() -> None:
    objects = [
        (path, node)
        for path, node in _walk(EXTRACTION_SCHEMA)
        if node.get("type") == "object"
    ]
    assert len(objects) == 6
    for path, node in objects:
        assert node["additionalProperties"] is False, path
        assert node["required"] == list(node["properties"]), path


# Bütün alan adları lowerCamelCase yazılır.
def test_field_names_are_lower_camel_case() -> None:
    for path, node in _walk(EXTRACTION_SCHEMA):
        for name in node.get("properties", {}):
            assert LOWER_CAMEL_CASE.fullmatch(name), f"{path}.{name}"


# Kayıt türü enum'u proto'daki RecordType adlarıyla, UNSPECIFIED hariç aynıdır.
def test_record_type_enum_matches_proto() -> None:
    proposal = _object_option(EXTRACTION_SCHEMA["properties"]["proposal"])
    expected = [
        name
        for name in medical_record_pb2.RecordType.keys()
        if name != "RECORD_TYPE_UNSPECIFIED"
    ]
    assert proposal["properties"]["type"] == {"type": "string", "enum": expected}


# flag enum'u proto'daki LabResultFlag adlarını ve belirsiz durum için boş metni içerir.
def test_flag_enum_matches_proto() -> None:
    proposal = _object_option(EXTRACTION_SCHEMA["properties"]["proposal"])
    lab_result = _object_option(proposal["properties"]["labResult"])
    flag = lab_result["properties"]["items"]["items"]["properties"]["flag"]
    expected = [
        name
        for name in medical_record_pb2.LabResultFlag.keys()
        if name != "LAB_RESULT_FLAG_UNSPECIFIED"
    ]
    assert flag == {"type": "string", "enum": [*expected, ""]}


# Şemadaki alan adları proto mesajlarının JSON adlarıyla birebir aynıdır.
def test_schema_fields_match_proto_json_names() -> None:
    proposal = _object_option(EXTRACTION_SCHEMA["properties"]["proposal"])
    lab_result = _object_option(proposal["properties"]["labResult"])
    vaccination = _object_option(proposal["properties"]["vaccination"])
    prescription = _object_option(proposal["properties"]["prescription"])
    item = lab_result["properties"]["items"]["items"]
    assert set(proposal["properties"]) == _json_names(medical_record_pb2.RecordContent)
    assert set(lab_result["properties"]) == _json_names(
        medical_record_pb2.LabResultDetails
    )
    assert set(item["properties"]) == _json_names(medical_record_pb2.LabResultItem)
    assert set(vaccination["properties"]) == _json_names(
        medical_record_pb2.VaccinationDetails
    )
    assert set(prescription["properties"]) == _json_names(
        medical_record_pb2.PrescriptionDetails
    )


# proposal, ayrıntı nesneleri ve durationDays null alabilir, diğer alanlar alamaz.
@pytest.mark.parametrize(
    ("path", "nullable"),
    [
        (("proposal",), True),
        (("proposal", "labResult"), True),
        (("proposal", "vaccination"), True),
        (("proposal", "prescription"), True),
        (("proposal", "prescription", "durationDays"), True),
        (("proposal", "title"), False),
        (("proposal", "type"), False),
        (("proposal", "labResult", "items"), False),
        (("isMedicalDocument",), False),
        (("confidence",), False),
    ],
)
def test_nullable_parts(path: tuple[str, ...], nullable: bool) -> None:
    node = EXTRACTION_SCHEMA
    for name in path:
        node = _object_option(node)["properties"][name]
    assert (not _violations(node, None)) is nullable


# Sözleşme 6.5'teki örnek çıktının bütün alanları şemada aynı yerde ve uygun türdedir.
def test_contract_example_uses_schema_field_names() -> None:
    assert _unknown_fields(EXTRACTION_SCHEMA, CONTRACT_EXAMPLE) == []


# Eksik ayrıntı alanları null yapılan sözleşme örneği katı şemaya tamamen uyar.
def test_completed_contract_example_conforms() -> None:
    assert _violations(EXTRACTION_SCHEMA, _completed_contract_example()) == []


# Tıbbi olmayan belge yanıtı proposal null olarak şemaya uyar.
def test_not_medical_document_answer_conforms() -> None:
    answer = {"isMedicalDocument": False, "confidence": 0.95, "proposal": None}
    assert _violations(EXTRACTION_SCHEMA, answer) == []


# Aşı ve reçete yanıtları da katı şemaya uyar.
def test_vaccination_and_prescription_answers_conform() -> None:
    vaccination = {
        "isMedicalDocument": True,
        "confidence": 0.9,
        "proposal": {
            "type": "VACCINATION",
            "title": "Kuduz aşısı",
            "notes": "",
            "recordedAt": "2026-10-20",
            "labResult": None,
            "vaccination": {
                "vaccineName": "Kuduz",
                "batchNumber": "",
                "administeredAt": "2026-10-20",
                "nextDueAt": "",
            },
            "prescription": None,
        },
    }
    prescription = copy.deepcopy(vaccination)
    prescription["proposal"].update(
        {
            "type": "PRESCRIPTION",
            "vaccination": None,
            "prescription": {
                "medicationName": "Amoksisilin",
                "dosage": "250 mg",
                "frequency": "Günde 2 kez",
                "durationDays": None,
                "instructions": "",
                "prescribedAt": "2026-10-20",
            },
        }
    )
    assert _violations(EXTRACTION_SCHEMA, vaccination) == []
    assert _violations(EXTRACTION_SCHEMA, prescription) == []


# Şema fazla alanı, eksik alanı ve geçersiz enum değerini kabul etmez.
@pytest.mark.parametrize(
    ("mutate", "expected_path"),
    [
        (lambda example: example.update({"extra": 1}), "$.extra"),
        (lambda example: example["proposal"].pop("title"), "$.proposal"),
        (
            lambda example: example["proposal"]["labResult"]["items"][0].update(
                {"flag": "H"}
            ),
            "$.proposal",
        ),
        (lambda example: example.update({"confidence": "0.9"}), "$.confidence"),
    ],
)
def test_schema_rejects_invalid_answers(mutate: Any, expected_path: str) -> None:
    example = _completed_contract_example()
    mutate(example)
    assert expected_path in _violations(EXTRACTION_SCHEMA, example)
