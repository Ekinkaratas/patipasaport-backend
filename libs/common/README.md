# common

Shared building blocks for the gateway and the NestJS services: the gRPC JWT and token-exchange guards, role and public-route decorators, gRPC client interceptors (auth, correlation id, deadline), request context storage, validation pipes and string transforms, exception filters and gRPC error forwarding, Winston JSON logging, CloudEvents helpers and event types, the standard response envelope, a rollback helper, Turkish tax number validation and required environment variable checks.

```sh
npx nx lint common
npx nx test common
```
