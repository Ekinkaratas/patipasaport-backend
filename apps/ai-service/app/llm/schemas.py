from typing import Any

EXTRACTION_SCHEMA_NAME = "record_content"

EXTRACTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "isMedicalDocument": {"type": "boolean"},
        "confidence": {"type": "number"},
        "proposal": {
            "anyOf": [
                {
                    "type": "object",
                    "properties": {
                        "type": {
                            "type": "string",
                            "enum": [
                                "EXAMINATION",
                                "VACCINATION",
                                "PRESCRIPTION",
                                "LAB_RESULT",
                                "SURGERY",
                            ],
                        },
                        "title": {"type": "string"},
                        "notes": {"type": "string"},
                        "recordedAt": {"type": "string"},
                        "labResult": {
                            "anyOf": [
                                {
                                    "type": "object",
                                    "properties": {
                                        "sampledAt": {"type": "string"},
                                        "items": {
                                            "type": "array",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "testName": {"type": "string"},
                                                    "value": {"type": "string"},
                                                    "unit": {"type": "string"},
                                                    "referenceRange": {
                                                        "type": "string"
                                                    },
                                                    "flag": {
                                                        "type": "string",
                                                        "enum": [
                                                            "NORMAL",
                                                            "LOW",
                                                            "HIGH",
                                                            "",
                                                        ],
                                                    },
                                                },
                                                "required": [
                                                    "testName",
                                                    "value",
                                                    "unit",
                                                    "referenceRange",
                                                    "flag",
                                                ],
                                                "additionalProperties": False,
                                            },
                                        },
                                    },
                                    "required": ["sampledAt", "items"],
                                    "additionalProperties": False,
                                },
                                {"type": "null"},
                            ]
                        },
                        "vaccination": {
                            "anyOf": [
                                {
                                    "type": "object",
                                    "properties": {
                                        "vaccineName": {"type": "string"},
                                        "batchNumber": {"type": "string"},
                                        "administeredAt": {"type": "string"},
                                        "nextDueAt": {"type": "string"},
                                    },
                                    "required": [
                                        "vaccineName",
                                        "batchNumber",
                                        "administeredAt",
                                        "nextDueAt",
                                    ],
                                    "additionalProperties": False,
                                },
                                {"type": "null"},
                            ]
                        },
                        "prescription": {
                            "anyOf": [
                                {
                                    "type": "object",
                                    "properties": {
                                        "medicationName": {"type": "string"},
                                        "dosage": {"type": "string"},
                                        "frequency": {"type": "string"},
                                        "durationDays": {
                                            "anyOf": [
                                                {"type": "integer"},
                                                {"type": "null"},
                                            ]
                                        },
                                        "instructions": {"type": "string"},
                                        "prescribedAt": {"type": "string"},
                                    },
                                    "required": [
                                        "medicationName",
                                        "dosage",
                                        "frequency",
                                        "durationDays",
                                        "instructions",
                                        "prescribedAt",
                                    ],
                                    "additionalProperties": False,
                                },
                                {"type": "null"},
                            ]
                        },
                    },
                    "required": [
                        "type",
                        "title",
                        "notes",
                        "recordedAt",
                        "labResult",
                        "vaccination",
                        "prescription",
                    ],
                    "additionalProperties": False,
                },
                {"type": "null"},
            ]
        },
    },
    "required": ["isMedicalDocument", "confidence", "proposal"],
    "additionalProperties": False,
}

EXPLANATION_SCHEMA_NAME = "lab_explanation"

EXPLANATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "confidence": {"type": "number"},
        "summary": {"type": "string"},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "testName": {"type": "string"},
                    "explanation": {"type": "string"},
                },
                "required": ["testName", "explanation"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["confidence", "summary", "items"],
    "additionalProperties": False,
}

ASSESSMENT_SCHEMA_NAME = "health_assessment"

ASSESSMENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "confidence": {"type": "number"},
        "riskLevel": {
            "type": "string",
            "enum": ["LOW", "MODERATE", "HIGH", "URGENT"],
        },
        "summary": {"type": "string"},
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "testName": {"type": "string"},
                    "interpretation": {"type": "string"},
                },
                "required": ["testName", "interpretation"],
                "additionalProperties": False,
            },
        },
        "possibleConditions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "likelihood": {
                        "type": "string",
                        "enum": ["LOW", "MEDIUM", "HIGH"],
                    },
                    "evidence": {"type": "array", "items": {"type": "string"}},
                    "explanation": {"type": "string"},
                },
                "required": ["name", "likelihood", "evidence", "explanation"],
                "additionalProperties": False,
            },
        },
        "recommendations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "enum": [
                            "NUTRITION",
                            "CARE",
                            "FOLLOW_UP_TEST",
                            "VET_VISIT",
                            "VACCINATION",
                        ],
                    },
                    "text": {"type": "string"},
                },
                "required": ["category", "text"],
                "additionalProperties": False,
            },
        },
        "questionsForVet": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "confidence",
        "riskLevel",
        "summary",
        "findings",
        "possibleConditions",
        "recommendations",
        "questionsForVet",
    ],
    "additionalProperties": False,
}
