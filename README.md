# PatiPasaport

A pet health passport platform: pet owners keep their animals' medical history in one place and decide, per clinic, who may see or add to it. Clinics upload lab results and images, an AI service (planned) drafts structured records from them, and a clinic reviews every draft before it becomes part of the permanent record.

This is a graduation project. The backend is complete; the AI service is the only part still to be built. Its integration points (events, queues, storage access) are already in place, and its contract document is the next update (see [Roadmap](#roadmap)).

## Architecture

```
                      HTTP :3000 (the only published port)
                               │
                          ┌────▼────┐
   Browser / mobile ────► │ gateway │  helmet · CORS · rate limiting · validation
                          └────┬────┘
        gRPC (internal network only, zero-trust JWT between services)
   ┌────────┬───────┬─────────┼──────────┬────────┬───────┐
   ▼        ▼       ▼         ▼          ▼        ▼       ▼
 access    auth   users    clinics     pets   medical-record
 (Redis)  (Redis)                                   │
                                          outbox ──► RabbitMQ ──► AI service (planned)
                                          files  ──► SeaweedFS (S3)
```

| Service | Responsibility | Storage |
|---|---|---|
| `gateway` | Only public entry point. HTTP/JSON API, request validation, token exchange, file upload | SeaweedFS (write) |
| `access` | Opaque token ⇄ short-lived JWT exchange, consents (who may access which pet), access checks | PostgreSQL, Redis |
| `auth` | Registration, login, refresh-token rotation, login lockout | PostgreSQL, Redis |
| `users` | User profiles | PostgreSQL |
| `clinics` | Clinics, stock, clinic view of a pet, result upload orchestration | PostgreSQL |
| `pets` | Pets, owner lookup, encrypted chip numbers | PostgreSQL |
| `medical-record` | Records, vaccinations, prescriptions, lab results, documents, AI draft reviews | PostgreSQL, RabbitMQ, SeaweedFS |

Design decisions worth knowing:

- **Database per service.** Cross-service relations are checked over gRPC, never with foreign keys.
- **Zero trust.** Every read and write re-checks access: pet owners through ownership, clinics through an active consent with the right scope.
- **Phantom tokens.** Clients hold opaque tokens; the gateway exchanges them for short-lived JWTs that internal services verify. Only `access` holds the private key.
- **Outbox + CloudEvents.** A document upload writes the document and an outbox row in one transaction; a relay publishes CloudEvents to RabbitMQ with retries and a dead-letter queue.
- **Human in the loop.** AI output is stored as a draft and only becomes a medical record after a clinic approves it.
- **Access audit log.** Every S3 request is logged through Fluent Bit.

Full database, messaging and storage design: [docs/db-schema.md](docs/db-schema.md).

## Tech stack

Nx monorepo · Node.js 24 · NestJS 11 (gRPC microservices + Express 5 gateway) · TypeScript · Prisma 7 · PostgreSQL 16 · Redis · RabbitMQ 4.3 · SeaweedFS (S3) · Fluent Bit · Protocol Buffers (buf + ts-proto) · Jest · Docker Compose.

## Getting started

Requirements: Node.js 24, Docker with Compose, and OpenSSL.

```sh
npm ci

cp .env.example .env
# fill in every "change-me" value, e.g. with: openssl rand -base64 18

openssl genrsa -out access_jwt_private.pem 2048
openssl rsa -in access_jwt_private.pem -pubout -out access_jwt_public.pem

docker compose up -d --build
curl http://localhost:3000/health
```

The default compose file publishes **only the gateway** on port 3000. Databases, Redis, RabbitMQ, SeaweedFS and the gRPC services are reachable only inside the Docker network.

### Local development

`docker-compose.dev.yml` additionally publishes the infrastructure and gRPC ports on `127.0.0.1`. Use it for migrations, Prisma Studio, e2e tests and tools such as grpcurl. Never use it in production.

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build

# apply database migrations (requires the dev ports)
npx nx run-many -t prisma-migrate-deploy
```

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

## API overview

Every route except `/health` and `/auth/logout` needs `X-Client-Type: 1` (web) or `2` (mobile). Every route except `/health` and `/auth/*` also needs `Authorization: Bearer <access token>`. Responses use one envelope: `{ data, message, success, correlationId }`; errors carry a stable code in `message`.

| Area | Routes |
|---|---|
| Health | `GET /health` |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout` |
| Consents | `POST /consents`, `POST /consents/:consentId/revoke`, `GET /consents`, `GET /consents/status` |
| Users | `GET` / `PATCH /users/me`, `POST /users/me/deactivate`, `POST /users/display-names` |
| Pets | `POST /pets`, `GET /pets`, `GET /pets/search`, `GET` / `PATCH /pets/:id` |
| Clinics | `GET /clinics/:id`, `POST /clinics/:clinicId/deactivate`, `POST` / `GET /clinics/:clinicId/stock-items`, `GET /clinics/:clinicId/pets/:petId/overview` |
| Documents | `POST /clinics/:clinicId/pets/:petId/documents` (multipart: `file` PDF/JPEG/PNG up to 10 MB, optional `note`), `GET /documents/:id` |
| Medical records | `GET /pets/:petId/records`, `/vaccinations`, `/prescriptions`, `/lab-results`, `POST /pets/:petId/records` |
| AI draft review | `GET /draft-reviews`, `POST /draft-reviews/:id/review` |

## Security

- **Transport headers:** helmet (strict CSP, `X-Frame-Options: DENY`, HSTS, `nosniff`, no `X-Powered-By`) and `Cache-Control: no-store` on every response.
- **CORS:** explicit origin allow-list, no wildcard, no credentials.
- **Rate limiting:** per IP, with stricter limits for authentication and uploads; `429` with `Retry-After`.
- **Input handling:** whitelist validation, string trimming, JSON depth limit (50), removal of prototype-pollution keys, magic-byte file type detection.
- **Injection:** all SQL goes through Prisma; raw queries are parameterized and `$queryRawUnsafe` / `$executeRawUnsafe` are banned by ESLint. The API returns JSON only and never reflects input in error messages.
- **Authentication:** argon2 password hashing, login lockout, rotating refresh tokens, opaque access tokens.
- **Network:** only the gateway is published; services talk over an internal Docker network.
- **Dependencies:** production images contain no known vulnerabilities (`npm audit --omit=dev --omit=optional`).

TLS is not terminated by this stack. In production, put a reverse proxy (Caddy or Nginx) in front of the gateway and enable Express `trust proxy`; otherwise every client shares the proxy's IP in the rate limiter.

## Testing

```sh
npx nx run-many -t lint build                    # static checks and builds
npx nx run-many -t test --output-style=static    # unit tests

# end-to-end tests run the built service on the host against the Docker stack
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
npx nx run-many -t e2e --parallel=1 --output-style=static
```

## Project layout

```
apps/        gateway and the six microservices, each with a *-e2e project
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
