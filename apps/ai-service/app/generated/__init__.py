import sys
from pathlib import Path

if (_GENERATED_DIR := str(Path(__file__).resolve().parent)) not in sys.path:
    sys.path.insert(0, _GENERATED_DIR)

from events import events_pb2
from medical_record import medical_record_pb2

__all__ = ["events_pb2", "medical_record_pb2"]
