#!/bin/sh
set -eu

API_URI="http://rabbitmq:15672"
PLACEHOLDER="bu alan doldurulacak"
AI_PERMISSIONS='^(ai-service\..+|patipasaport\.events|patipasaport\.events\.dlx)$'

# Eksik değişkenin yalnızca adını içeren hata mesajını yazar ve çıkar.
fail_missing() {
  echo "rabbitmq-init: $1 .env içinde boş ya da doldurulmamış; AI kullanıcısı oluşturulmadı" >&2
  exit 1
}

# Yönetim API'sine mevcut yönetici hesabıyla rabbitmqadmin komutu gönderir.
admin_api() {
  rabbitmqadmin --base-uri "$API_URI" --non-interactive "$@"
}

# Yönetim API'si yanıt verene kadar kısa aralıklarla dener, yaklaşık 60 sn içinde yanıt gelmezse hatayla çıkar.
wait_for_api() {
  deadline=$(($(date +%s) + 60))
  until admin_api --timeout 5 show overview >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "rabbitmq-init: yönetim API'si 60 sn içinde yanıt vermedi ya da RABBITMQ_USER / RABBITMQ_PASSWORD reddedildi" >&2
      exit 1
    fi
    sleep 2
  done
}

for name in RABBITMQ_USER RABBITMQ_PASSWORD AI_RABBITMQ_USER AI_RABBITMQ_PASSWORD; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    fail_missing "$name"
  fi
done

for name in AI_RABBITMQ_USER AI_RABBITMQ_PASSWORD; do
  eval "value=\${$name}"
  if [ "$value" = "$PLACEHOLDER" ]; then
    fail_missing "$name"
  fi
done

if [ "$AI_RABBITMQ_USER" = "$RABBITMQ_USER" ]; then
  echo "rabbitmq-init: AI_RABBITMQ_USER ile RABBITMQ_USER aynı olamaz; hiçbir değişiklik yapılmadı" >&2
  exit 1
fi

export RABBITMQADMIN_USERNAME="$RABBITMQ_USER"
export RABBITMQADMIN_PASSWORD="$RABBITMQ_PASSWORD"

wait_for_api

if ! admin_api users declare --name="$AI_RABBITMQ_USER" --password="$AI_RABBITMQ_PASSWORD" >/dev/null 2>&1; then
  echo "rabbitmq-init: AI kullanıcısı oluşturulamadı ya da şifresi güncellenemedi" >&2
  exit 1
fi

if ! admin_api permissions declare --vhost=/ --username="$AI_RABBITMQ_USER" \
  --configure="$AI_PERMISSIONS" --write="$AI_PERMISSIONS" --read="$AI_PERMISSIONS" >/dev/null 2>&1; then
  echo "rabbitmq-init: AI kullanıcısına izinler verilemedi" >&2
  exit 1
fi

echo "rabbitmq-init: tamam"
