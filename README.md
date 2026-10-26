# PatiPasaport

A pet health passport platform: pet owners keep their animals' medical history in one place and decide, per clinic, who may see or add to it. Clinics upload lab results and images, an AI service (planned) drafts structured records from them, and a clinic reviews every draft before it becomes part of the permanent record.

This is a graduation project. The backend is complete; the AI service is the only part still to be built. Its integration points (events, queues, storage access) are already in place, and its contract document is the next update (see [Roadmap](#roadmap)).

## Architecture

```
   Browser / mobile ──HTTPS──► nginx (TLS, the only public entry; frontend repo)
                               │  /api → http://gateway:3000 (internal network)
                          ┌────▼────┐
                          │ gateway │  helmet · CORS · rate limiting · validation
                          └────┬────┘
        gRPC (internal network only, zero-trust JWT between services)
   ┌────────┬───────┬─────────┼──────────┬────────┬───────┐
   ▼        ▼       ▼         ▼          ▼        ▼       ▼
 access    auth   users    clinics     pets   medical-record
 (Redis)  (Redis)                                   │
                                          outbox ──► RabbitMQ ──► ai-service (Python)
                                          files  ──► SeaweedFS (S3)
```

| Service | Responsibility | Storage |
|---|---|---|
| `gateway` | Only public entry point. HTTP/JSON API, request validation, token exchange, file upload | SeaweedFS (write) |
| `access` | Opaque token ⇄ short-lived JWT exchange, consents (who may access which pet), access checks | PostgreSQL, Redis |
| `auth` | Registration, login, refresh-token rotation, login lockout | PostgreSQL, Redis |
| `users` | User profiles | PostgreSQL |
| `clinics` | Clinics, stock with purchase and sale prices, sales and monthly sales reports, clinic view of a pet, result upload orchestration | PostgreSQL |
| `pets` | Pets, owner lookup, encrypted chip numbers | PostgreSQL |
| `medical-record` | Records, vaccinations, prescriptions, lab results, documents, AI draft reviews, AI lab result explanations | PostgreSQL, RabbitMQ, SeaweedFS |
| `ai-service` | Python worker, no ports. Reads uploaded documents into draft records and writes plain-language lab result explanations through an external AI API | RabbitMQ, SeaweedFS (read-only) |

Design decisions worth knowing:

- **Database per service.** Cross-service relations are checked over gRPC, never with foreign keys.
- **Zero trust.** Every read and write re-checks access: pet owners through ownership, clinics through an active consent with the right scope.
- **Phantom tokens.** Clients hold opaque tokens; the gateway exchanges them for short-lived JWTs that internal services verify. Only `access` holds the private key.
- **Outbox + CloudEvents.** A document upload writes the document and an outbox row in one transaction; a relay publishes CloudEvents to RabbitMQ with retries and a dead-letter queue. A new lab result record (approved draft or manual entry) writes the record, a pending explanation row and an explanation request in one transaction the same way.
- **Human in the loop.** AI output is stored as a draft and only becomes a medical record after a clinic approves it.
- **Access audit log.** Every S3 request is logged through Fluent Bit.

Full database, messaging and storage design: [docs/db-schema.md](docs/db-schema.md).

## Tech stack

Nx monorepo · Node.js 24 · NestJS 11 (gRPC microservices + Express 5 gateway) · TypeScript · Prisma 7 · PostgreSQL 16 · Redis · RabbitMQ 4.3 · SeaweedFS (S3) · Fluent Bit · Protocol Buffers (buf + ts-proto) · Jest · Python 3.14 + FastAPI (AI service) · Docker Compose.

## Getting started

Requirements: Node.js 24, Docker with Compose, and OpenSSL.

```sh
npm ci

cp .env.example .env
# fill in every "change-me" value, e.g. with: openssl rand -base64 18
# and every "bu alan doldurulacak" value (AI provider and AI RabbitMQ user)

openssl genrsa -out access_jwt_private.pem 2048
openssl rsa -in access_jwt_private.pem -pubout -out access_jwt_public.pem

docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
npx nx run-many -t prisma-migrate-deploy   # apply database migrations
curl http://localhost:3000/health
```

### Local development

`docker-compose.dev.yml` publishes the gateway on port 3000 and the infrastructure and gRPC ports on `127.0.0.1`. Use it for the frontend dev server, migrations, Prisma Studio, e2e tests and tools such as grpcurl. Never use it in production.

### Production

The default compose file (`docker compose up -d --build`) publishes **no ports at all**. A reverse proxy is the only public entry:

- Run nginx (it lives in the frontend repository) on the Compose network `patipasaport_backend` and proxy `/api/` to `http://gateway:3000/`.
- Terminate TLS in nginx and set `TRUST_PROXY=1` so rate limiting sees the real client IP.
- Keep the gateway unpublished; a client that could reach it directly could forge `X-Forwarded-For`.

### Configuration

All secrets live in `.env` (git-ignored); `.env.example` documents every variable. Services fail fast: a missing service address (`*_GRPC_URL`, database, Redis or RabbitMQ host) stops the service at startup with an error that names the variable.

Gateway settings:

| Variable | Default | Meaning |
|---|---|---|
| `CORS_ORIGINS` | empty | Comma-separated browser origins allowed to call the API, e.g. `https://app.example.com`. Empty allows none. |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Rate-limit window |
| `RATE_LIMIT_GLOBAL` | `100` | Requests per IP per window across all routes |
| `RATE_LIMIT_AUTH` | `10` | Shared limit for login, register and refresh |
| `RATE_LIMIT_UPLOAD` | `20` | Limit for document upload |
| `TRUST_PROXY` | empty | Number of reverse proxies in front of the gateway. Empty for local development, `1` behind nginx, `2` if another layer (e.g. Cloudflare or a load balancer) sits in front of nginx. `true` is rejected, because it would let clients forge their IP. |
| `REFRESH_COOKIE_PATH` | `/api/auth` | Browser-visible path of the refresh-token cookie. It must match the prefix the reverse proxy uses in front of `/auth`. |

AI service settings (a missing required value stops only `ai-service`; the rest of the stack keeps running):

| Variable | Default | Meaning |
|---|---|---|
| `AI_API_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | required | OpenAI-compatible AI provider |
| `AI_RABBITMQ_USER`, `AI_RABBITMQ_PASSWORD` | required | Limited RabbitMQ user created by `rabbitmq-init`; must differ from `RABBITMQ_USER` |
| `S3_AI_ACCESS_KEY`, `S3_AI_SECRET_KEY` | required | Read-only SeaweedFS user created by `seaweedfs-init` |
| `AI_REQUEST_TIMEOUT_SECONDS` | `120` | Timeout of one AI API request |
| `AI_ENABLE_THINKING` | `true` | Lets the model reason before answering |
| `AI_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING` or `ERROR` |

## API overview

Every route except `/health` and `/auth/logout` needs `X-Client-Type: 1` (web) or `2` (mobile). Every route except `/health` and `/auth/*` also needs `Authorization: Bearer <access token>`. Responses use one envelope: `{ data, message, success, correlationId }`; errors carry a stable code in `message`.

| Area | Routes |
|---|---|
| Health | `GET /health` |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout` (web: refresh token only in an httpOnly cookie; mobile: in the JSON body) |
| Consents | `POST /consents`, `POST /consents/:consentId/revoke`, `GET /consents`, `GET /consents/status` |
| Users | `GET` / `PATCH /users/me`, `POST /users/me/deactivate`, `POST /users/display-names` |
| Pets | `POST /pets`, `GET /pets`, `GET /pets/search`, `GET` / `PATCH /pets/:id` |
| Clinics | `GET /clinics/:id`, `POST /clinics/:clinicId/deactivate`, `GET /clinics/:clinicId/pets/:petId/overview` |
| Stock | `POST` / `GET /clinics/:clinicId/stock-items`, `PATCH` / `DELETE /clinics/:clinicId/stock-items/:itemId`, `POST /clinics/:clinicId/stock-items/:itemId/adjust` (atomic `{ delta }`) |
| Stock sales | `POST /clinics/:clinicId/stock-items/:itemId/sales` (`{ quantity, unitPrice? }`), `GET /clinics/:clinicId/stock-sales` (`fromDate`, `toDate`, paging), `POST /clinics/:clinicId/stock-sales/:saleId/cancel` (same month only), `GET /clinics/:clinicId/stock-sales/summary?month=YYYY-MM` (totals, daily, weekly, per product) |
| Documents | `POST /clinics/:clinicId/pets/:petId/documents` (multipart: `file` PDF/JPEG/PNG up to 10 MB, optional `note`), `GET /pets/:petId/documents` (optional `status`, paging), `GET /documents/:id`, `GET /documents/:id/file` (opens in the browser; `?download=1` downloads; content is checked against the stored SHA-256) |
| Medical records | `GET /pets/:petId/records`, `/vaccinations`, `/prescriptions`, `/lab-results`, `POST /pets/:petId/records` |
| AI draft review | `GET /draft-reviews`, `POST /draft-reviews/:id/review` |
| Lab result explanation | `GET /records/:recordId/explanation` (pet owner only; `status` 1 pending, 2 ready with summary, items, confidence and `generatedAt`, 3 failed) |

Money is an integer number of kuruş (`14990` = 149.90 TL). A sale stores the item's name and its purchase and sale prices as they were at the time of sale, so later price changes do not alter past profit. Days, weeks (Monday to Sunday, cut at the month's edges) and months in sales reports follow Istanbul time.

## Security

- **Transport headers:** helmet (strict CSP, `X-Frame-Options: DENY`, HSTS, `nosniff`, no `X-Powered-By`) and `Cache-Control: no-store` on every response.
- **CORS:** explicit origin allow-list, no wildcard, no credentials.
- **Rate limiting:** per IP, with stricter limits for authentication and uploads; `429` with `Retry-After`.
- **Input handling:** whitelist validation, string trimming, JSON depth limit (50), removal of prototype-pollution keys, magic-byte file type detection.
- **Injection:** all SQL goes through Prisma; raw queries are parameterized and `$queryRawUnsafe` / `$executeRawUnsafe` are banned by ESLint. The API returns JSON only and never reflects input in error messages.
- **Authentication:** argon2 password hashing, login lockout, rotating refresh tokens, opaque access tokens.
- **Refresh token on the web:** never exposed to JavaScript. It lives in the `pp_refresh` cookie (`HttpOnly`, `Secure`, `SameSite=Strict`, scoped to `/api/auth`) whose lifetime matches the token (12 hours, 30 days with "remember me"). CSRF is blocked by `SameSite=Strict` plus the required `X-Client-Type` header, which another site cannot send without CORS approval. Mobile clients keep the token in the body and store it in secure device storage.
- **Network:** no service is published in production; nginx is the only public entry and every service, the gateway included, is reachable only on the internal Docker network.
- **Dependencies:** production images contain no known vulnerabilities (`npm audit --omit=dev --omit=optional`).

TLS terminates at the reverse proxy (nginx), not in this stack. Behind it, `TRUST_PROXY=1` makes the gateway take the client IP from the last `X-Forwarded-For` entry, the one nginx appends, so every client gets its own rate-limit quota and forged entries are ignored.

## Testing

```sh
npx nx run-many -t lint build                    # static checks and builds
npx nx run-many -t test --output-style=static    # unit tests

# end-to-end tests run the built service on the host against the Docker stack
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
docker compose stop ai-service      # e2e tests play the AI role themselves
npx nx run-many -t e2e --parallel=1 --output-style=static
docker compose start ai-service
```

The AI service has its own lint and tests; see [apps/ai-service/README.md](apps/ai-service/README.md).

## Project layout

```
apps/        gateway and the six microservices, each with a *-e2e project
apps/ai-service  Python AI worker (not an Nx project)
libs/common  shared guards, pipes, filters, logging, CloudEvents helpers
libs/dto     request DTOs and validation rules shared by gateway and services
libs/proto   .proto contracts and generated TypeScript
libs/e2e-utils  helpers for end-to-end tests
tools/       SeaweedFS bucket setup and audit-log, Fluent Bit configuration
docs/        database, messaging and storage design
```

## Roadmap

1. **Next update: AI service contract** (`docs/ai-service-contract.md`). It will define the event types and payloads, the queue and retry topology, storage access and error handling that the AI service must follow.
2. **AI service:** consumes `document-uploaded` events from RabbitMQ, reads the file from SeaweedFS with read-only credentials and publishes the analysis result as an event.
3. **Deployment:** TLS reverse proxy and production configuration.

## License

[MIT](LICENSE)
