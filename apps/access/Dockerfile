# syntax=docker/dockerfile:1
# ============================================================
# apps/access/Dockerfile
# PatiPasaport - access servisi (Nx "prune" workflow)
#
# ON KOSUL: patipasaport-base imaji build edilmis olmali:
#   docker build -f Dockerfile.base -t patipasaport-base:latest .
#
# Build:
#   docker build -f apps/access/Dockerfile -t patipasaport-access:latest .
# ============================================================

# ---- 1) Build aşaması: ortak base imajdan devam ----
FROM patipasaport-base:latest AS builder

# project.json'daki "prune" target'i (build -> prune-lockfile +
# copy-workspace-modules) tek komutla tetiklenir.
# Sonuc: dist/apps/access/ icinde main.js + pruned package.json +
# pruned package-lock.json + workspace_modules/ birlikte olusur.
RUN npx nx run access:prune

# ---- 2) Production aşaması: küçük, temiz final imaj ----
FROM node:20-alpine AS production

RUN apk add --no-cache libc6-compat
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# dist/apps/access klasörünün TAMAMI tek seferde kopyalanıyor
# (workspace_modules'a olan "file:" referansları npm ci sırasında
# çözülebilsin diye main.js + package*.json + workspace_modules
# birlikte gelmeli).
COPY --from=builder /workspace/dist/apps/access ./

# Pruned lockfile sayesinde SADECE bu servisin gerçekten kullandığı
# external paketler kurulur.
RUN npm ci --omit=dev

EXPOSE ${PORT}

CMD ["node", "main.js"]
