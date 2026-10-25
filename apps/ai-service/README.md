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

## Entegrasyon testleri

Varsayılan `pytest` çalıştırması entegrasyon testlerini dışarıda bırakır (`-m 'not integration'`) ve ağa çıkmaz. Entegrasyon testleri gerçek RabbitMQ ile çalışır.

Ön koşullar:

- Ana proje dev modunda çalışıyor olmalı; RabbitMQ `localhost:5672` adresinden erişilebilir olmalı.
- AI RabbitMQ kullanıcısı `rabbitmq-init` ile oluşturulmuş olmalı.
- `apps/ai-service/.env` dolu olmalı (`RABBITMQ_HOST=localhost`, `AI_RABBITMQ_USER`, `AI_RABBITMQ_PASSWORD`). Testler ayarları `load_settings()` ile bu dosyadan okur.

```bash
.venv/Scripts/python -m pytest -m integration
```

- RabbitMQ'ya ulaşılamazsa testler atlanmaz; açık bir mesajla başarısız olur.
- Üretim adlarıyla yalnızca topolojinin çakışmadan tanımlandığı denenir. Gerçek kuyruklar tüketilmez, gerçek exchange'lere yayın yapılmaz.
- Diğer denemeler `ai-service.it-<rastgele>` önekli exchange ve kuyruklarla yapılır. Bunlar her testin sonunda, test başarısız olsa bile silinir ve silindikleri doğrulanır.
- Tekrar deneme testi gerçek 30 sn TTL'i beklediği için çalıştırma yaklaşık bir dakika sürer.

## Biçim

CI `nx format:check` çalıştırdığı için bu dizindeki `.md`, `.json` ve `.yml` dosyaları Prettier biçiminde olmalıdır. Depo kökünden:

```bash
npx prettier --write apps/ai-service/README.md
npx prettier --check apps/ai-service/README.md
```
