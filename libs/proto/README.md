# proto

Protocol Buffers contracts for the gRPC services and the RabbitMQ event payloads (`src/lib/**/*.proto`). TypeScript code is generated into `src/generated` with buf and ts-proto; the Python AI service generates its own code from the same files (`apps/ai-service/scripts/generate_proto.py`).

```sh
npx nx run proto:generate
npx nx lint proto
```
