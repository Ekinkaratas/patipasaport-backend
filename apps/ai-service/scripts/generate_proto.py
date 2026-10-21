import subprocess
import sys
from importlib import resources
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_DIR.parents[1]
PROTO_SOURCE_DIR = REPO_ROOT / "libs" / "proto" / "src" / "lib"
OUTPUT_DIR = SERVICE_DIR / "app" / "generated"
PROTO_FILES = ("medical_record/medical_record.proto", "events/events.proto")
GENERATED_PATTERNS = ("*_pb2.py", "*_pb2.pyi")


# Çıktı dizinindeki eski *_pb2.py ve *_pb2.pyi dosyalarını siler.
def remove_generated_files() -> None:
    for pattern in GENERATED_PATTERNS:
        for path in OUTPUT_DIR.rglob(pattern):
            path.unlink()


# grpc_tools.protoc'u aynı yorumlayıcıyla çalıştırıp çıkış kodunu döndürür.
def run_protoc() -> int:
    with resources.as_file(resources.files("grpc_tools") / "_proto") as include_dir:
        command = [
            sys.executable,
            "-m",
            "grpc_tools.protoc",
            f"--proto_path={PROTO_SOURCE_DIR}",
            f"--proto_path={include_dir}",
            f"--python_out={OUTPUT_DIR}",
            f"--pyi_out={OUTPUT_DIR}",
            *PROTO_FILES,
        ]
        return subprocess.run(command, cwd=SERVICE_DIR, check=False).returncode


# Mesaj kodunu yeniden üretir; protoc hata verirse stderr'e yazıp aynı kodu döndürür.
def main() -> int:
    remove_generated_files()
    return_code = run_protoc()
    if return_code != 0:
        print(f"protoc hata verdi (kod {return_code}).", file=sys.stderr)
    return return_code


if __name__ == "__main__":
    sys.exit(main())
