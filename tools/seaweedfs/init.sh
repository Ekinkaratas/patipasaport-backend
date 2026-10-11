#!/bin/sh
set -eu

MASTER="seaweedfs:9333"

for name in S3_BUCKET S3_GATEWAY_ACCESS_KEY S3_GATEWAY_SECRET_KEY S3_AI_ACCESS_KEY S3_AI_SECRET_KEY; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "seaweedfs-init: $name .env içinde boş; bucket ve kullanıcılar oluşturulmadı" >&2
    exit 1
  fi
done

weed_shell() {
  printf '%s\n' "$1" | weed shell -master="$MASTER"
}

if weed_shell "s3.bucket.list" | grep -qE "^[[:space:]]+${S3_BUCKET}[[:space:]]"; then
  echo "seaweedfs-init: bucket $S3_BUCKET zaten var"
else
  weed_shell "s3.bucket.create -name $S3_BUCKET"
fi

ensure_user() {
  user="$1"
  access_key="$2"
  secret_key="$3"
  role="$4"
  if weed_shell "s3.user.list" | grep -q "\"name\":\"$user\""; then
    echo "seaweedfs-init: kullanıcı $user zaten var"
  else
    weed_shell "s3.user.create -name $user -access_key $access_key -secret_key $secret_key"
  fi
  weed_shell "s3.user.provision -name $user -bucket $S3_BUCKET -role $role"
}

ensure_user gateway "$S3_GATEWAY_ACCESS_KEY" "$S3_GATEWAY_SECRET_KEY" readwrite
ensure_user ai "$S3_AI_ACCESS_KEY" "$S3_AI_SECRET_KEY" readonly

echo "seaweedfs-init: tamam"
