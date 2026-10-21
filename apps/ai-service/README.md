# PatiPasaport AI Servisi

Belge okuma ve tahlil açıklaması üreten Python 3.14 + FastAPI servisi. Sözleşme ve geliştirme kuralları: [ai-service-contract.md](../../docs/ai-service-contract.md).

## Kurulum

Komutlar `apps/ai-service` dizininde çalıştırılır. Sanal ortamın Python'u Windows'ta `.venv/Scripts/python`, Linux/macOS'ta `.venv/bin/python` yolundadır.

```bash
py -3.14 -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt -c constraints.txt
cp .env.example .env
```

Linux/macOS'ta sanal ortam `python3.14 -m venv .venv` ile oluşturulur. `.env` içindeki `bu alan doldurulacak` değerleri doldurulur; `.env` depoya eklenmez.

## Komutlar

```bash
.venv/Scripts/python -m ruff check .
.venv/Scripts/python -m pytest
.venv/Scripts/python scripts/generate_proto.py
.venv/Scripts/python -m uvicorn app.main:app --port 8000
```

## Biçim

CI `nx format:check` çalıştırdığı için bu dizindeki `.md`, `.json` ve `.yml` dosyaları Prettier biçiminde olmalıdır. Depo kökünden:

```bash
npx prettier --write apps/ai-service/README.md
npx prettier --check apps/ai-service/README.md
```
