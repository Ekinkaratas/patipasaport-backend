#!/usr/bin/env bash
# ============================================================
# build-base.sh
# PatiPasaport ortak base imajını build eder ve etiketler.
#
# Servis Dockerfile'ları "FROM patipasaport-base:latest" ile
# başladığı için, herhangi bir servisi build etmeden ÖNCE bu
# script'in çalıştırılmış olması gerekir (base imaj değiştiyse
# de tekrar çalıştırılmalı).
#
# Kullanım:
#   chmod +x build-base.sh
#   ./build-base.sh
# ============================================================
set -euo pipefail

echo "==> patipasaport-base imajı build ediliyor..."
docker build -f Dockerfile.base -t patipasaport-base:latest .
echo "==> Tamamlandı: patipasaport-base:latest"
