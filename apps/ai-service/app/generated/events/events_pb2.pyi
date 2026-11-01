from medical_record import medical_record_pb2 as _medical_record_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class DocumentUploaded(_message.Message):
    __slots__ = ("document_id", "pet_id", "clinic_id", "storage_path", "mime_type", "size_bytes", "sha256")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    PET_ID_FIELD_NUMBER: _ClassVar[int]
    CLINIC_ID_FIELD_NUMBER: _ClassVar[int]
    STORAGE_PATH_FIELD_NUMBER: _ClassVar[int]
    MIME_TYPE_FIELD_NUMBER: _ClassVar[int]
    SIZE_BYTES_FIELD_NUMBER: _ClassVar[int]
    SHA256_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    pet_id: str
    clinic_id: str
    storage_path: str
    mime_type: str
    size_bytes: int
    sha256: str
    def __init__(self, document_id: _Optional[str] = ..., pet_id: _Optional[str] = ..., clinic_id: _Optional[str] = ..., storage_path: _Optional[str] = ..., mime_type: _Optional[str] = ..., size_bytes: _Optional[int] = ..., sha256: _Optional[str] = ...) -> None: ...

class DocumentProcessingStarted(_message.Message):
    __slots__ = ("document_id", "model_version", "started_at")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_VERSION_FIELD_NUMBER: _ClassVar[int]
    STARTED_AT_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    model_version: str
    started_at: str
    def __init__(self, document_id: _Optional[str] = ..., model_version: _Optional[str] = ..., started_at: _Optional[str] = ...) -> None: ...

class DocumentAnalyzed(_message.Message):
    __slots__ = ("document_id", "model_version", "confidence", "proposal", "analyzed_at")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_VERSION_FIELD_NUMBER: _ClassVar[int]
    CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    PROPOSAL_FIELD_NUMBER: _ClassVar[int]
    ANALYZED_AT_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    model_version: str
    confidence: float
    proposal: _medical_record_pb2.RecordContent
    analyzed_at: str
    def __init__(self, document_id: _Optional[str] = ..., model_version: _Optional[str] = ..., confidence: _Optional[float] = ..., proposal: _Optional[_Union[_medical_record_pb2.RecordContent, _Mapping]] = ..., analyzed_at: _Optional[str] = ...) -> None: ...

class DocumentAnalysisFailed(_message.Message):
    __slots__ = ("document_id", "model_version", "error_code", "error_message", "failed_at")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_VERSION_FIELD_NUMBER: _ClassVar[int]
    ERROR_CODE_FIELD_NUMBER: _ClassVar[int]
    ERROR_MESSAGE_FIELD_NUMBER: _ClassVar[int]
    FAILED_AT_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    model_version: str
    error_code: str
    error_message: str
    failed_at: str
    def __init__(self, document_id: _Optional[str] = ..., model_version: _Optional[str] = ..., error_code: _Optional[str] = ..., error_message: _Optional[str] = ..., failed_at: _Optional[str] = ...) -> None: ...

class LabExplanationRequested(_message.Message):
    __slots__ = ("record_id", "title", "sampled_at", "species", "birth_date", "is_birth_date_estimated", "items")
    RECORD_ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    SAMPLED_AT_FIELD_NUMBER: _ClassVar[int]
    SPECIES_FIELD_NUMBER: _ClassVar[int]
    BIRTH_DATE_FIELD_NUMBER: _ClassVar[int]
    IS_BIRTH_DATE_ESTIMATED_FIELD_NUMBER: _ClassVar[int]
    ITEMS_FIELD_NUMBER: _ClassVar[int]
    record_id: str
    title: str
    sampled_at: str
    species: str
    birth_date: str
    is_birth_date_estimated: bool
    items: _containers.RepeatedCompositeFieldContainer[_medical_record_pb2.LabResultItem]
    def __init__(self, record_id: _Optional[str] = ..., title: _Optional[str] = ..., sampled_at: _Optional[str] = ..., species: _Optional[str] = ..., birth_date: _Optional[str] = ..., is_birth_date_estimated: _Optional[bool] = ..., items: _Optional[_Iterable[_Union[_medical_record_pb2.LabResultItem, _Mapping]]] = ...) -> None: ...

class LabExplanationGenerated(_message.Message):
    __slots__ = ("record_id", "model_version", "confidence", "explanation", "generated_at")
    RECORD_ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_VERSION_FIELD_NUMBER: _ClassVar[int]
    CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    EXPLANATION_FIELD_NUMBER: _ClassVar[int]
    GENERATED_AT_FIELD_NUMBER: _ClassVar[int]
    record_id: str
    model_version: str
    confidence: float
    explanation: _medical_record_pb2.LabExplanation
    generated_at: str
    def __init__(self, record_id: _Optional[str] = ..., model_version: _Optional[str] = ..., confidence: _Optional[float] = ..., explanation: _Optional[_Union[_medical_record_pb2.LabExplanation, _Mapping]] = ..., generated_at: _Optional[str] = ...) -> None: ...

class LabExplanationFailed(_message.Message):
    __slots__ = ("record_id", "model_version", "error_code", "error_message", "failed_at")
    RECORD_ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_VERSION_FIELD_NUMBER: _ClassVar[int]
    ERROR_CODE_FIELD_NUMBER: _ClassVar[int]
    ERROR_MESSAGE_FIELD_NUMBER: _ClassVar[int]
    FAILED_AT_FIELD_NUMBER: _ClassVar[int]
    record_id: str
    model_version: str
    error_code: str
    error_message: str
    failed_at: str
    def __init__(self, record_id: _Optional[str] = ..., model_version: _Optional[str] = ..., error_code: _Optional[str] = ..., error_message: _Optional[str] = ..., failed_at: _Optional[str] = ...) -> None: ...

class LabMeasurement(_message.Message):
    __slots__ = ("sampled_at", "value", "unit", "reference_range", "flag")
    SAMPLED_AT_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    UNIT_FIELD_NUMBER: _ClassVar[int]
    REFERENCE_RANGE_FIELD_NUMBER: _ClassVar[int]
    FLAG_FIELD_NUMBER: _ClassVar[int]
    sampled_at: str
    value: str
    unit: str
    reference_range: str
    flag: _medical_record_pb2.LabResultFlag
    def __init__(self, sampled_at: _Optional[str] = ..., value: _Optional[str] = ..., unit: _Optional[str] = ..., reference_range: _Optional[str] = ..., flag: _Optional[_Union[_medical_record_pb2.LabResultFlag, str]] = ...) -> None: ...

class LabSeries(_message.Message):
    __slots__ = ("test_name", "measurements")
    TEST_NAME_FIELD_NUMBER: _ClassVar[int]
    MEASUREMENTS_FIELD_NUMBER: _ClassVar[int]
    test_name: str
    measurements: _containers.RepeatedCompositeFieldContainer[LabMeasurement]
    def __init__(self, test_name: _Optional[str] = ..., measurements: _Optional[_Iterable[_Union[LabMeasurement, _Mapping]]] = ...) -> None: ...

class ClinicalNote(_message.Message):
    __slots__ = ("type", "title", "notes", "recorded_at")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    NOTES_FIELD_NUMBER: _ClassVar[int]
    RECORDED_AT_FIELD_NUMBER: _ClassVar[int]
    type: _medical_record_pb2.RecordType
    title: str
    notes: str
    recorded_at: str
    def __init__(self, type: _Optional[_Union[_medical_record_pb2.RecordType, str]] = ..., title: _Optional[str] = ..., notes: _Optional[str] = ..., recorded_at: _Optional[str] = ...) -> None: ...

class HealthAssessmentRequested(_message.Message):
    __slots__ = ("request_id", "as_of", "species", "breed", "sex", "is_neutered", "birth_date", "is_birth_date_estimated", "lab_series", "vaccinations", "prescriptions", "clinical_notes")
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    AS_OF_FIELD_NUMBER: _ClassVar[int]
    SPECIES_FIELD_NUMBER: _ClassVar[int]
    BREED_FIELD_NUMBER: _ClassVar[int]
    SEX_FIELD_NUMBER: _ClassVar[int]
    IS_NEUTERED_FIELD_NUMBER: _ClassVar[int]
    BIRTH_DATE_FIELD_NUMBER: _ClassVar[int]
    IS_BIRTH_DATE_ESTIMATED_FIELD_NUMBER: _ClassVar[int]
    LAB_SERIES_FIELD_NUMBER: _ClassVar[int]
    VACCINATIONS_FIELD_NUMBER: _ClassVar[int]
    PRESCRIPTIONS_FIELD_NUMBER: _ClassVar[int]
    CLINICAL_NOTES_FIELD_NUMBER: _ClassVar[int]
    request_id: str
    as_of: str
    species: str
    breed: str
    sex: str
    is_neutered: bool
    birth_date: str
    is_birth_date_estimated: bool
    lab_series: _containers.RepeatedCompositeFieldContainer[LabSeries]
    vaccinations: _containers.RepeatedCompositeFieldContainer[_medical_record_pb2.VaccinationDetails]
    prescriptions: _containers.RepeatedCompositeFieldContainer[_medical_record_pb2.PrescriptionDetails]
    clinical_notes: _containers.RepeatedCompositeFieldContainer[ClinicalNote]
    def __init__(self, request_id: _Optional[str] = ..., as_of: _Optional[str] = ..., species: _Optional[str] = ..., breed: _Optional[str] = ..., sex: _Optional[str] = ..., is_neutered: _Optional[bool] = ..., birth_date: _Optional[str] = ..., is_birth_date_estimated: _Optional[bool] = ..., lab_series: _Optional[_Iterable[_Union[LabSeries, _Mapping]]] = ..., vaccinations: _Optional[_Iterable[_Union[_medical_record_pb2.VaccinationDetails, _Mapping]]] = ..., prescriptions: _Optional[_Iterable[_Union[_medical_record_pb2.PrescriptionDetails, _Mapping]]] = ..., clinical_notes: _Optional[_Iterable[_Union[ClinicalNote, _Mapping]]] = ...) -> None: ...

class HealthAssessmentGenerated(_message.Message):
    __slots__ = ("request_id", "model_version", "confidence", "assessment", "generated_at")
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_VERSION_FIELD_NUMBER: _ClassVar[int]
    CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    ASSESSMENT_FIELD_NUMBER: _ClassVar[int]
    GENERATED_AT_FIELD_NUMBER: _ClassVar[int]
    request_id: str
    model_version: str
    confidence: float
    assessment: _medical_record_pb2.HealthAssessment
    generated_at: str
    def __init__(self, request_id: _Optional[str] = ..., model_version: _Optional[str] = ..., confidence: _Optional[float] = ..., assessment: _Optional[_Union[_medical_record_pb2.HealthAssessment, _Mapping]] = ..., generated_at: _Optional[str] = ...) -> None: ...

class HealthAssessmentFailed(_message.Message):
    __slots__ = ("request_id", "model_version", "error_code", "error_message", "failed_at")
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_VERSION_FIELD_NUMBER: _ClassVar[int]
    ERROR_CODE_FIELD_NUMBER: _ClassVar[int]
    ERROR_MESSAGE_FIELD_NUMBER: _ClassVar[int]
    FAILED_AT_FIELD_NUMBER: _ClassVar[int]
    request_id: str
    model_version: str
    error_code: str
    error_message: str
    failed_at: str
    def __init__(self, request_id: _Optional[str] = ..., model_version: _Optional[str] = ..., error_code: _Optional[str] = ..., error_message: _Optional[str] = ..., failed_at: _Optional[str] = ...) -> None: ...
