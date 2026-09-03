# syntax=docker/dockerfile:1
# ============================================================
# apps/clinics/Dockerfile
# PatiPasaport - clinics servisi (Nx "prune" workflow)
#
# NOT: Nx app klasoru "clinics" (cogul) olarak olusturuldugu icin
# nx komutu ve dist yolu da "clinics" olarak guncellendi.
#
# ON KOSUL: patipasaport-base imaji build edilmis olmali:
#   docker build -f Dockerfile.base -t patipasaport-base:latest .
#
# Build:
#   docker build -f apps/clinics/Dockerfile -t patipasaport-clinic:latest .
# ============================================================

# ---- 1) Build aşaması: ortak base imajdan devam ----
FROM patipasaport-base:latest AS builder

RUN npx nx run clinics:prune

# ---- 2) Production aşaması: küçük, temiz final imaj ----
FROM node:20-alpine AS production

RUN apk add --no-cache libc6-compat
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /workspace/dist/apps/clinics ./

RUN npm ci --omit=dev

EXPOSE ${PORT}

CMD ["node", "main.js"]