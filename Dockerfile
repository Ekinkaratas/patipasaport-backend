# ============================================================
# docker-compose.yml her servis icin bu dosyayi farkli APP degeriyle
# cagirir; ortak asamalar (deps, prod-deps) BuildKit tarafindan 7 imaj
# arasinda paylasilir, sadece "build" asamasi servise ozeldir.
#
# Neden "nx run <app>:prune" kullanılmıyor?
#   @nx/js:prune-lockfile, webpack'in generatePackageJson çıktısını
#   apps/<app>/package.json'daki (bağımsızlık) manifestle eziyor ->
#   dist/apps/<app>/package.json boş çıkıyor -> "npm ci --omit=dev"
#   hiçbir şey kurmuyor -> konteyner "Cannot find module" ile çöküyor.
#   Bunun yerine kök package-lock.json'dan production bağımlılıkları
#   ayrı bir aşamada kurulup runtime imajına kopyalanıyor.
# ============================================================

ARG NODE_VERSION=24-alpine

FROM node:${NODE_VERSION} AS deps
WORKDIR /workspace
COPY package.json package-lock.json ./
# sharing=locked: compose 7 imajı paralel build ederken aynı npm cache
# mount'una eş zamanlı yazmasın (aksi halde ENOTEMPTY yarısı oluşur).
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci

FROM deps AS build
ARG APP
ENV NX_DAEMON=false \
    NX_SKIP_NX_CACHE=true \
    NODE_ENV=production
COPY . .
# --excludeTaskDependencies build'in dependsOn'daki prisma-generate'i
# atlamasına yol açar; Prisma kullanan servislerde client burada üretilir.
RUN test -n "${APP}" || { echo "APP build-arg zorunlu (orn. --build-arg APP=auth)"; exit 1; } \
    && if [ -f "apps/${APP}/prisma.config.ts" ]; then \
         npx prisma generate --config "apps/${APP}/prisma.config.ts"; \
       fi \
    && npx nx run "${APP}:build" --excludeTaskDependencies --skipNxCache \
    && test -f "dist/apps/${APP}/main.js"

FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /workspace
COPY package.json package-lock.json ./

RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --omit=optional

FROM node:${NODE_VERSION} AS runtime
ARG APP
ENV NODE_ENV=production \
    APP_NAME=${APP}
WORKDIR /app

COPY --from=prod-deps --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build     --chown=node:node /workspace/dist/apps/${APP} ./

USER node

CMD ["node", "main.js"]
