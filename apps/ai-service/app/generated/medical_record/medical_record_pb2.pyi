from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class RecordType(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    RECORD_TYPE_UNSPECIFIED: _ClassVar[RecordType]
    EXAMINATION: _ClassVar[RecordType]
    VACCINATION: _ClassVar[RecordType]
    PRESCRIPTION: _ClassVar[RecordType]
    LAB_RESULT: _ClassVar[RecordType]
    SURGERY: _ClassVar[RecordType]

class DraftReviewStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    DRAFT_REVIEW_STATUS_UNSPECIFIED: _ClassVar[DraftReviewStatus]
    PENDING: _ClassVar[DraftReviewStatus]
    APPROVED: _ClassVar[DraftReviewStatus]
    REJECTED: _ClassVar[DraftReviewStatus]

class DocumentStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    DOCUMENT_STATUS_UNSPECIFIED: _ClassVar[DocumentStatus]
    QUEUED: _ClassVar[DocumentStatus]
    PROCESSING: _ClassVar[DocumentStatus]
    DRAFT_READY: _ClassVar[DocumentStatus]
    FAILED: _ClassVar[DocumentStatus]

class LabResultFlag(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    LAB_RESULT_FLAG_UNSPECIFIED: _ClassVar[LabResultFlag]
    NORMAL: _ClassVar[LabResultFlag]
    LOW: _ClassVar[LabResultFlag]
    HIGH: _ClassVar[LabResultFlag]

class LabExplanationStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    LAB_EXPLANATION_STATUS_UNSPECIFIED: _ClassVar[LabExplanationStatus]
    LAB_EXPLANATION_PENDING: _ClassVar[LabExplanationStatus]
    LAB_EXPLANATION_READY: _ClassVar[LabExplanationStatus]
    LAB_EXPLANATION_FAILED: _ClassVar[LabExplanationStatus]
RECORD_TYPE_UNSPECIFIED: RecordType
EXAMINATION: RecordType
VACCINATION: RecordType
PRESCRIPTION: RecordType
LAB_RESULT: RecordType
SURGERY: RecordType
DRAFT_REVIEW_STATUS_UNSPECIFIED: DraftReviewStatus
PENDING: DraftReviewStatus
APPROVED: DraftReviewStatus
REJECTED: DraftReviewStatus
DOCUMENT_STATUS_UNSPECIFIED: DocumentStatus
QUEUED: DocumentStatus
PROCESSING: DocumentStatus
DRAFT_READY: DocumentStatus
FAILED: DocumentStatus
LAB_RESULT_FLAG_UNSPECIFIED: LabResultFlag
NORMAL: LabResultFlag
LOW: LabResultFlag
HIGH: LabResultFlag
LAB_EXPLANATION_STATUS_UNSPECIFIED: LabExplanationStatus
LAB_EXPLANATION_PENDING: LabExplanationStatus
LAB_EXPLANATION_READY: LabExplanationStatus
LAB_EXPLANATION_FAILED: LabExplanationStatus

class FileReference(_message.Message):
    __slots__ = ("document_id", "storage_path", "original_name", "mime_type", "size_bytes", "uploaded_at")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    STORAGE_PATH_FIELD_NUMBER: _ClassVar[int]
    ORIGINAL_NAME_FIELD_NUMBER: _ClassVar[int]
    MIME_TYPE_FIELD_NUMBER: _ClassVar[int]
    SIZE_BYTES_FIELD_NUMBER: _ClassVar[int]
    UPLOADED_AT_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    storage_path: str
    original_name: str
    mime_type: str
    size_bytes: int
    uploaded_at: str
    def __init__(self, document_id: _Optional[str] = ..., storage_path: _Optional[str] = ..., original_name: _Optional[str] = ..., mime_type: _Optional[str] = ..., size_bytes: _Optional[int] = ..., uploaded_at: _Optional[str] = ...) -> None: ...

class VaccinationDetails(_message.Message):
    __slots__ = ("vaccine_name", "batch_number", "administered_at", "next_due_at")
    VACCINE_NAME_FIELD_NUMBER: _ClassVar[int]
    BATCH_NUMBER_FIELD_NUMBER: _ClassVar[int]
    ADMINISTERED_AT_FIELD_NUMBER: _ClassVar[int]
    NEXT_DUE_AT_FIELD_NUMBER: _ClassVar[int]
    vaccine_name: str
    batch_number: str
    administered_at: str
    next_due_at: str
    def __init__(self, vaccine_name: _Optional[str] = ..., batch_number: _Optional[str] = ..., administered_at: _Optional[str] = ..., next_due_at: _Optional[str] = ...) -> None: ...

class PrescriptionDetails(_message.Message):
    __slots__ = ("medication_name", "dosage", "frequency", "duration_days", "instructions", "prescribed_at")
    MEDICATION_NAME_FIELD_NUMBER: _ClassVar[int]
    DOSAGE_FIELD_NUMBER: _ClassVar[int]
    FREQUENCY_FIELD_NUMBER: _ClassVar[int]
    DURATION_DAYS_FIELD_NUMBER: _ClassVar[int]
    INSTRUCTIONS_FIELD_NUMBER: _ClassVar[int]
    PRESCRIBED_AT_FIELD_NUMBER: _ClassVar[int]
    medication_name: str
    dosage: str
    frequency: str
    duration_days: int
    instructions: str
    prescribed_at: str
    def __init__(self, medication_name: _Optional[str] = ..., dosage: _Optional[str] = ..., frequency: _Optional[str] = ..., duration_days: _Optional[int] = ..., instructions: _Optional[str] = ..., prescribed_at: _Optional[str] = ...) -> None: ...

class LabResultItem(_message.Message):
    __slots__ = ("test_name", "value", "unit", "reference_range", "flag")
    TEST_NAME_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    UNIT_FIELD_NUMBER: _ClassVar[int]
    REFERENCE_RANGE_FIELD_NUMBER: _ClassVar[int]
    FLAG_FIELD_NUMBER: _ClassVar[int]
    test_name: str
    value: str
    unit: str
    reference_range: str
    flag: LabResultFlag
    def __init__(self, test_name: _Optional[str] = ..., value: _Optional[str] = ..., unit: _Optional[str] = ..., reference_range: _Optional[str] = ..., flag: _Optional[_Union[LabResultFlag, str]] = ...) -> None: ...

class LabResultDetails(_message.Message):
    __slots__ = ("items", "sampled_at")
    ITEMS_FIELD_NUMBER: _ClassVar[int]
    SAMPLED_AT_FIELD_NUMBER: _ClassVar[int]
    items: _containers.RepeatedCompositeFieldContainer[LabResultItem]
    sampled_at: str
    def __init__(self, items: _Optional[_Iterable[_Union[LabResultItem, _Mapping]]] = ..., sampled_at: _Optional[str] = ...) -> None: ...

class RecordContent(_message.Message):
    __slots__ = ("type", "title", "notes", "recorded_at", "vaccination", "prescription", "lab_result")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    NOTES_FIELD_NUMBER: _ClassVar[int]
    RECORDED_AT_FIELD_NUMBER: _ClassVar[int]
    VACCINATION_FIELD_NUMBER: _ClassVar[int]
    PRESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    LAB_RESULT_FIELD_NUMBER: _ClassVar[int]
    type: RecordType
    title: str
    notes: str
    recorded_at: str
    vaccination: VaccinationDetails
    prescription: PrescriptionDetails
    lab_result: LabResultDetails
    def __init__(self, type: _Optional[_Union[RecordType, str]] = ..., title: _Optional[str] = ..., notes: _Optional[str] = ..., recorded_at: _Optional[str] = ..., vaccination: _Optional[_Union[VaccinationDetails, _Mapping]] = ..., prescription: _Optional[_Union[PrescriptionDetails, _Mapping]] = ..., lab_result: _Optional[_Union[LabResultDetails, _Mapping]] = ...) -> None: ...

class MedicalRecord(_message.Message):
    __slots__ = ("id", "pet_id", "clinic_id", "type", "title", "notes", "recorded_at", "attachments", "source_draft_review_id", "created_at", "vaccination", "prescription", "lab_result")
    ID_FIELD_NUMBER: _ClassVar[int]
    PET_ID_FIELD_NUMBER: _ClassVar[int]
    CLINIC_ID_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    NOTES_FIELD_NUMBER: _ClassVar[int]
    RECORDED_AT_FIELD_NUMBER: _ClassVar[int]
    ATTACHMENTS_FIELD_NUMBER: _ClassVar[int]
    SOURCE_DRAFT_REVIEW_ID_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    VACCINATION_FIELD_NUMBER: _ClassVar[int]
    PRESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    LAB_RESULT_FIELD_NUMBER: _ClassVar[int]
    id: str
    pet_id: str
    clinic_id: str
    type: RecordType
    title: str
    notes: str
    recorded_at: str
    attachments: _containers.RepeatedCompositeFieldContainer[FileReference]
    source_draft_review_id: str
    created_at: str
    vaccination: VaccinationDetails
    prescription: PrescriptionDetails
    lab_result: LabResultDetails
    def __init__(self, id: _Optional[str] = ..., pet_id: _Optional[str] = ..., clinic_id: _Optional[str] = ..., type: _Optional[_Union[RecordType, str]] = ..., title: _Optional[str] = ..., notes: _Optional[str] = ..., recorded_at: _Optional[str] = ..., attachments: _Optional[_Iterable[_Union[FileReference, _Mapping]]] = ..., source_draft_review_id: _Optional[str] = ..., created_at: _Optional[str] = ..., vaccination: _Optional[_Union[VaccinationDetails, _Mapping]] = ..., prescription: _Optional[_Union[PrescriptionDetails, _Mapping]] = ..., lab_result: _Optional[_Union[LabResultDetails, _Mapping]] = ...) -> None: ...

class ListRecordsByPetRequest(_message.Message):
    __slots__ = ("pet_id", "type", "from_date", "to_date", "page", "page_size")
    PET_ID_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    FROM_DATE_FIELD_NUMBER: _ClassVar[int]
    TO_DATE_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    pet_id: str
    type: RecordType
    from_date: str
    to_date: str
    page: int
    page_size: int
    def __init__(self, pet_id: _Optional[str] = ..., type: _Optional[_Union[RecordType, str]] = ..., from_date: _Optional[str] = ..., to_date: _Optional[str] = ..., page: _Optional[int] = ..., page_size: _Optional[int] = ...) -> None: ...

class ListRecordsResponse(_message.Message):
    __slots__ = ("records", "total", "page", "page_size")
    RECORDS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    records: _containers.RepeatedCompositeFieldContainer[MedicalRecord]
    total: int
    page: int
    page_size: int
    def __init__(self, records: _Optional[_Iterable[_Union[MedicalRecord, _Mapping]]] = ..., total: _Optional[int] = ..., page: _Optional[int] = ..., page_size: _Optional[int] = ...) -> None: ...

class CreateRecordRequest(_message.Message):
    __slots__ = ("pet_id", "attachments", "content")
    PET_ID_FIELD_NUMBER: _ClassVar[int]
    ATTACHMENTS_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    pet_id: str
    attachments: _containers.RepeatedCompositeFieldContainer[FileReference]
    content: RecordContent
    def __init__(self, pet_id: _Optional[str] = ..., attachments: _Optional[_Iterable[_Union[FileReference, _Mapping]]] = ..., content: _Optional[_Union[RecordContent, _Mapping]] = ...) -> None: ...

class RecordResponse(_message.Message):
    __slots__ = ("record",)
    RECORD_FIELD_NUMBER: _ClassVar[int]
    record: MedicalRecord
    def __init__(self, record: _Optional[_Union[MedicalRecord, _Mapping]] = ...) -> None: ...

class Document(_message.Message):
    __slots__ = ("id", "pet_id", "clinic_id", "storage_path", "original_name", "mime_type", "size_bytes", "sha256", "note", "status", "failure_reason", "draft_review_id", "created_at", "updated_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    PET_ID_FIELD_NUMBER: _ClassVar[int]
    CLINIC_ID_FIELD_NUMBER: _ClassVar[int]
    STORAGE_PATH_FIELD_NUMBER: _ClassVar[int]
    ORIGINAL_NAME_FIELD_NUMBER: _ClassVar[int]
    MIME_TYPE_FIELD_NUMBER: _ClassVar[int]
    SIZE_BYTES_FIELD_NUMBER: _ClassVar[int]
    SHA256_FIELD_NUMBER: _ClassVar[int]
    NOTE_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    FAILURE_REASON_FIELD_NUMBER: _ClassVar[int]
    DRAFT_REVIEW_ID_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    pet_id: str
    clinic_id: str
    storage_path: str
    original_name: str
    mime_type: str
    size_bytes: int
    sha256: str
    note: str
    status: DocumentStatus
    failure_reason: str
    draft_review_id: str
    created_at: str
    updated_at: str
    def __init__(self, id: _Optional[str] = ..., pet_id: _Optional[str] = ..., clinic_id: _Optional[str] = ..., storage_path: _Optional[str] = ..., original_name: _Optional[str] = ..., mime_type: _Optional[str] = ..., size_bytes: _Optional[int] = ..., sha256: _Optional[str] = ..., note: _Optional[str] = ..., status: _Optional[_Union[DocumentStatus, str]] = ..., failure_reason: _Optional[str] = ..., draft_review_id: _Optional[str] = ..., created_at: _Optional[str] = ..., updated_at: _Optional[str] = ...) -> None: ...

class RegisterDocumentRequest(_message.Message):
    __slots__ = ("pet_id", "storage_path", "original_name", "mime_type", "size_bytes", "sha256", "note")
    PET_ID_FIELD_NUMBER: _ClassVar[int]
    STORAGE_PATH_FIELD_NUMBER: _ClassVar[int]
    ORIGINAL_NAME_FIELD_NUMBER: _ClassVar[int]
    MIME_TYPE_FIELD_NUMBER: _ClassVar[int]
    SIZE_BYTES_FIELD_NUMBER: _ClassVar[int]
    SHA256_FIELD_NUMBER: _ClassVar[int]
    NOTE_FIELD_NUMBER: _ClassVar[int]
    pet_id: str
    storage_path: str
    original_name: str
    mime_type: str
    size_bytes: int
    sha256: str
    note: str
    def __init__(self, pet_id: _Optional[str] = ..., storage_path: _Optional[str] = ..., original_name: _Optional[str] = ..., mime_type: _Optional[str] = ..., size_bytes: _Optional[int] = ..., sha256: _Optional[str] = ..., note: _Optional[str] = ...) -> None: ...

class GetDocumentRequest(_message.Message):
    __slots__ = ("id",)
    ID_FIELD_NUMBER: _ClassVar[int]
    id: str
    def __init__(self, id: _Optional[str] = ...) -> None: ...

class DocumentResponse(_message.Message):
    __slots__ = ("document",)
    DOCUMENT_FIELD_NUMBER: _ClassVar[int]
    document: Document
    def __init__(self, document: _Optional[_Union[Document, _Mapping]] = ...) -> None: ...

class ListDocumentsByPetRequest(_message.Message):
    __slots__ = ("pet_id", "status", "page", "page_size")
    PET_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    pet_id: str
    status: DocumentStatus
    page: int
    page_size: int
    def __init__(self, pet_id: _Optional[str] = ..., status: _Optional[_Union[DocumentStatus, str]] = ..., page: _Optional[int] = ..., page_size: _Optional[int] = ...) -> None: ...

class ListDocumentsResponse(_message.Message):
    __slots__ = ("documents", "total", "page", "page_size")
    DOCUMENTS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    documents: _containers.RepeatedCompositeFieldContainer[Document]
    total: int
    page: int
    page_size: int
    def __init__(self, documents: _Optional[_Iterable[_Union[Document, _Mapping]]] = ..., total: _Optional[int] = ..., page: _Optional[int] = ..., page_size: _Optional[int] = ...) -> None: ...

class Vaccination(_message.Message):
    __slots__ = ("id", "record_id", "pet_id", "vaccine_name", "batch_number", "administered_at", "next_due_at", "clinic_id")
    ID_FIELD_NUMBER: _ClassVar[int]
    RECORD_ID_FIELD_NUMBER: _ClassVar[int]
    PET_ID_FIELD_NUMBER: _ClassVar[int]
    VACCINE_NAME_FIELD_NUMBER: _ClassVar[int]
    BATCH_NUMBER_FIELD_NUMBER: _ClassVar[int]
    ADMINISTERED_AT_FIELD_NUMBER: _ClassVar[int]
    NEXT_DUE_AT_FIELD_NUMBER: _ClassVar[int]
    CLINIC_ID_FIELD_NUMBER: _ClassVar[int]
    id: str
    record_id: str
    pet_id: str
    vaccine_name: str
    batch_number: str
    administered_at: str
    next_due_at: str
    clinic_id: str
    def __init__(self, id: _Optional[str] = ..., record_id: _Optional[str] = ..., pet_id: _Optional[str] = ..., vaccine_name: _Optional[str] = ..., batch_number: _Optional[str] = ..., administered_at: _Optional[str] = ..., next_due_at: _Optional[str] = ..., clinic_id: _Optional[str] = ...) -> None: ...

class ListVaccinationsRequest(_message.Message):
    __slots__ = ("pet_id", "only_upcoming", "page", "page_size")
    PET_ID_FIELD_NUMBER: _ClassVar[int]
    ONLY_UPCOMING_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    pet_id: str
    only_upcoming: bool
    page: int
    page_size: int
    def __init__(self, pet_id: _Optional[str] = ..., only_upcoming: _Optional[bool] = ..., page: _Optional[int] = ..., page_size: _Optional[int] = ...) -> None: ...

class ListVaccinationsResponse(_message.Message):
    __slots__ = ("vaccinations", "total", "page", "page_size")
    VACCINATIONS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    vaccinations: _containers.RepeatedCompositeFieldContainer[Vaccination]
    total: int
    page: int
    page_size: int
    def __init__(self, vaccinations: _Optional[_Iterable[_Union[Vaccination, _Mapping]]] = ..., total: _Optional[int] = ..., page: _Optional[int] = ..., page_size: _Optional[int] = ...) -> None: ...

class Prescription(_message.Message):
    __slots__ = ("id", "record_id", "pet_id", "medication_name", "dosage", "frequency", "duration_days", "instructions", "prescribed_at", "clinic_id")
    ID_FIELD_NUMBER: _ClassVar[int]
    RECORD_ID_FIELD_NUMBER: _ClassVar[int]
    PET_ID_FIELD_NUMBER: _ClassVar[int]
    MEDICATION_NAME_FIELD_NUMBER: _ClassVar[int]
    DOSAGE_FIELD_NUMBER: _ClassVar[int]
    FREQUENCY_FIELD_NUMBER: _ClassVar[int]
    DURATION_DAYS_FIELD_NUMBER: _ClassVar[int]
    INSTRUCTIONS_FIELD_NUMBER: _ClassVar[int]
    PRESCRIBED_AT_FIELD_NUMBER: _ClassVar[int]
    CLINIC_ID_FIELD_NUMBER: _ClassVar[int]
    id: str
    record_id: str
    pet_id: str
    medication_name: str
    dosage: str
    frequency: str
    duration_days: int
    instructions: str
    prescribed_at: str
    clinic_id: str
    def __init__(self, id: _Optional[str] = ..., record_id: _Optional[str] = ..., pet_id: _Optional[str] = ..., medication_name: _Optional[str] = ..., dosage: _Optional[str] = ..., frequency: _Optional[str] = ..., duration_days: _Optional[int] = ..., instructions: _Optional[str] = ..., prescribed_at: _Optional[str] = ..., clinic_id: _Optional[str] = ...) -> None: ...

class ListPrescriptionsRequest(_message.Message):
    __slots__ = ("pet_id", "only_active", "page", "page_size")
    PET_ID_FIELD_NUMBER: _ClassVar[int]
    ONLY_ACTIVE_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    pet_id: str
    only_active: bool
    page: int
    page_size: int
    def __init__(self, pet_id: _Optional[str] = ..., only_active: _Optional[bool] = ..., page: _Optional[int] = ..., page_size: _Optional[int] = ...) -> None: ...

class ListPrescriptionsResponse(_message.Message):
    __slots__ = ("prescriptions", "total", "page", "page_size")
    PRESCRIPTIONS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    prescriptions: _containers.RepeatedCompositeFieldContainer[Prescription]
    total: int
    page: int
    page_size: int
    def __init__(self, prescriptions: _Optional[_Iterable[_Union[Prescription, _Mapping]]] = ..., total: _Optional[int] = ..., page: _Optional[int] = ..., page_size: _Optional[int] = ...) -> None: ...

class LabResult(_message.Message):
    __slots__ = ("id", "record_id", "pet_id", "clinic_id", "test_name", "value", "unit", "reference_range", "flag", "sampled_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    RECORD_ID_FIELD_NUMBER: _ClassVar[int]
    PET_ID_FIELD_NUMBER: _ClassVar[int]
    CLINIC_ID_FIELD_NUMBER: _ClassVar[int]
    TEST_NAME_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    UNIT_FIELD_NUMBER: _ClassVar[int]
    REFERENCE_RANGE_FIELD_NUMBER: _ClassVar[int]
    FLAG_FIELD_NUMBER: _ClassVar[int]
    SAMPLED_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    record_id: str
    pet_id: str
    clinic_id: str
    test_name: str
    value: str
    unit: str
    reference_range: str
    flag: LabResultFlag
    sampled_at: str
    def __init__(self, id: _Optional[str] = ..., record_id: _Optional[str] = ..., pet_id: _Optional[str] = ..., clinic_id: _Optional[str] = ..., test_name: _Optional[str] = ..., value: _Optional[str] = ..., unit: _Optional[str] = ..., reference_range: _Optional[str] = ..., flag: _Optional[_Union[LabResultFlag, str]] = ..., sampled_at: _Optional[str] = ...) -> None: ...

class ListLabResultsRequest(_message.Message):
    __slots__ = ("pet_id", "test_name", "page", "page_size")
    PET_ID_FIELD_NUMBER: _ClassVar[int]
    TEST_NAME_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    pet_id: str
    test_name: str
    page: int
    page_size: int
    def __init__(self, pet_id: _Optional[str] = ..., test_name: _Optional[str] = ..., page: _Optional[int] = ..., page_size: _Optional[int] = ...) -> None: ...

class ListLabResultsResponse(_message.Message):
    __slots__ = ("lab_results", "total", "page", "page_size")
    LAB_RESULTS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    lab_results: _containers.RepeatedCompositeFieldContainer[LabResult]
    total: int
    page: int
    page_size: int
    def __init__(self, lab_results: _Optional[_Iterable[_Union[LabResult, _Mapping]]] = ..., total: _Optional[int] = ..., page: _Optional[int] = ..., page_size: _Optional[int] = ...) -> None: ...

class LabExplanationItem(_message.Message):
    __slots__ = ("test_name", "explanation")
    TEST_NAME_FIELD_NUMBER: _ClassVar[int]
    EXPLANATION_FIELD_NUMBER: _ClassVar[int]
    test_name: str
    explanation: str
    def __init__(self, test_name: _Optional[str] = ..., explanation: _Optional[str] = ...) -> None: ...

class LabExplanation(_message.Message):
    __slots__ = ("summary", "items")
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    ITEMS_FIELD_NUMBER: _ClassVar[int]
    summary: str
    items: _containers.RepeatedCompositeFieldContainer[LabExplanationItem]
    def __init__(self, summary: _Optional[str] = ..., items: _Optional[_Iterable[_Union[LabExplanationItem, _Mapping]]] = ...) -> None: ...

class GetLabExplanationRequest(_message.Message):
    __slots__ = ("record_id",)
    RECORD_ID_FIELD_NUMBER: _ClassVar[int]
    record_id: str
    def __init__(self, record_id: _Optional[str] = ...) -> None: ...

class LabExplanationResponse(_message.Message):
    __slots__ = ("status", "summary", "items", "confidence", "generated_at")
    STATUS_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    ITEMS_FIELD_NUMBER: _ClassVar[int]
    CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    GENERATED_AT_FIELD_NUMBER: _ClassVar[int]
    status: LabExplanationStatus
    summary: str
    items: _containers.RepeatedCompositeFieldContainer[LabExplanationItem]
    confidence: float
    generated_at: str
    def __init__(self, status: _Optional[_Union[LabExplanationStatus, str]] = ..., summary: _Optional[str] = ..., items: _Optional[_Iterable[_Union[LabExplanationItem, _Mapping]]] = ..., confidence: _Optional[float] = ..., generated_at: _Optional[str] = ...) -> None: ...

class DraftReview(_message.Message):
    __slots__ = ("id", "pet_id", "clinic_id", "source_files", "status", "review_note", "created_record_id", "created_at", "reviewed_at", "reviewed_by_clinic_id", "document_id", "proposal", "approved_content", "model_version", "confidence")
    ID_FIELD_NUMBER: _ClassVar[int]
    PET_ID_FIELD_NUMBER: _ClassVar[int]
    CLINIC_ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FILES_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    REVIEW_NOTE_FIELD_NUMBER: _ClassVar[int]
    CREATED_RECORD_ID_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    REVIEWED_AT_FIELD_NUMBER: _ClassVar[int]
    REVIEWED_BY_CLINIC_ID_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    PROPOSAL_FIELD_NUMBER: _ClassVar[int]
    APPROVED_CONTENT_FIELD_NUMBER: _ClassVar[int]
    MODEL_VERSION_FIELD_NUMBER: _ClassVar[int]
    CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    id: str
    pet_id: str
    clinic_id: str
    source_files: _containers.RepeatedCompositeFieldContainer[FileReference]
    status: DraftReviewStatus
    review_note: str
    created_record_id: str
    created_at: str
    reviewed_at: str
    reviewed_by_clinic_id: str
    document_id: str
    proposal: RecordContent
    approved_content: RecordContent
    model_version: str
    confidence: float
    def __init__(self, id: _Optional[str] = ..., pet_id: _Optional[str] = ..., clinic_id: _Optional[str] = ..., source_files: _Optional[_Iterable[_Union[FileReference, _Mapping]]] = ..., status: _Optional[_Union[DraftReviewStatus, str]] = ..., review_note: _Optional[str] = ..., created_record_id: _Optional[str] = ..., created_at: _Optional[str] = ..., reviewed_at: _Optional[str] = ..., reviewed_by_clinic_id: _Optional[str] = ..., document_id: _Optional[str] = ..., proposal: _Optional[_Union[RecordContent, _Mapping]] = ..., approved_content: _Optional[_Union[RecordContent, _Mapping]] = ..., model_version: _Optional[str] = ..., confidence: _Optional[float] = ...) -> None: ...

class ListDraftReviewsRequest(_message.Message):
    __slots__ = ("pet_id", "status", "page", "page_size")
    PET_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    pet_id: str
    status: DraftReviewStatus
    page: int
    page_size: int
    def __init__(self, pet_id: _Optional[str] = ..., status: _Optional[_Union[DraftReviewStatus, str]] = ..., page: _Optional[int] = ..., page_size: _Optional[int] = ...) -> None: ...

class ListDraftReviewsResponse(_message.Message):
    __slots__ = ("draft_reviews", "total", "page", "page_size")
    DRAFT_REVIEWS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    draft_reviews: _containers.RepeatedCompositeFieldContainer[DraftReview]
    total: int
    page: int
    page_size: int
    def __init__(self, draft_reviews: _Optional[_Iterable[_Union[DraftReview, _Mapping]]] = ..., total: _Optional[int] = ..., page: _Optional[int] = ..., page_size: _Optional[int] = ...) -> None: ...

class ReviewDraftRequest(_message.Message):
    __slots__ = ("id", "approved", "review_note", "edited_content")
    ID_FIELD_NUMBER: _ClassVar[int]
    APPROVED_FIELD_NUMBER: _ClassVar[int]
    REVIEW_NOTE_FIELD_NUMBER: _ClassVar[int]
    EDITED_CONTENT_FIELD_NUMBER: _ClassVar[int]
    id: str
    approved: bool
    review_note: str
    edited_content: RecordContent
    def __init__(self, id: _Optional[str] = ..., approved: _Optional[bool] = ..., review_note: _Optional[str] = ..., edited_content: _Optional[_Union[RecordContent, _Mapping]] = ...) -> None: ...

class DraftReviewResponse(_message.Message):
    __slots__ = ("draft_review",)
    DRAFT_REVIEW_FIELD_NUMBER: _ClassVar[int]
    draft_review: DraftReview
    def __init__(self, draft_review: _Optional[_Union[DraftReview, _Mapping]] = ...) -> None: ...
