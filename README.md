# Apollo Load Reproduction Harness

Push Apollo 2.5.x to its limit with intentional schema drift, cache-heavy payloads, and a real-time dashboard that visualises the carnage.

## Project Layout

- `server/` — Apollo Server 4 + Express, exposing `events(limit, seed)` with gigantic nested payloads, an SSE metrics stream, and a static dashboard.
- `client/` — Kotlin/Apollo 2.5.14 stress harness that hammers the endpoint with a stale schema, pushes the normalised cache, and publishes metrics.

## Prerequisites

- Node.js 18+
- Java 17+
- Kotlin toolchain (Gradle wrapper pinned to 8.1.1)

## Quick Start

1. **Install & launch the server**
   ```bash
   cd server
   npm install
   npm start
   ```
   Visit `http://127.0.0.1:4000/` for the dashboard, or `http://127.0.0.1:4000/graphql` for the raw endpoint.

2. **Generate models / build the client (first run)**
   ```bash
   cd client
   ./gradlew build
   ```

3. **Run the load harness with live metrics**
   ```bash
   APOLLO_METRICS_URL=http://127.0.0.1:4000/metrics \
   ./gradlew run --no-daemon
   ```

   The defaults intentionally go hard (`APOLLO_LOAD_SCALE=1000`, derived iterations, and large payloads). Tailor the run with Gradle properties:

   | Property | Purpose | Default |
   | --- | --- | --- |
   | `APOLLO_CONCURRENCY` | Coroutines hammering the server | `16` |
   | `APOLLO_LOAD_SCALE` | Multiplier for per-worker iterations | `1000` |
   | `APOLLO_EVENT_LIMIT` | Requested events per query (capped at 8000) | `50 * APOLLO_LOAD_SCALE` |
   | `APOLLO_SEED_BASE` / `APOLLO_SEED_WINDOW` | Control deterministic payload shuffling | `1337` / `64` |

   Example meltdown run:
   ```bash
   APOLLO_METRICS_URL=http://127.0.0.1:4000/metrics \
   ./gradlew run --no-daemon \
     -PAPOLLO_CONCURRENCY=48 \
     -PAPOLLO_LOAD_SCALE=3000 \
     -PAPOLLO_EVENT_LIMIT=8000 \
     -PAPOLLO_SEED_WINDOW=512
   ```

## What to Watch

- **Dashboard** (`server/public/`): Real-time totals, error rate, throughput, per-worker progress, cache writes/hits/misses, processed bytes, and history via SSE.
- **Client logs**: Apollo parse errors from mismatched union members (`JsonPayload`) and structured `message` objects where the stale schema expects a string.
- **CPU usage**: The combination of huge payloads, strict cache usage, and repeated cache-only reads should spike CPU on both sides.

## Extending the Harness

- Capture JVM flame graphs (async-profiler/JFR) while the load runs.
- Add additional payload variants in `server/src/index.js` to explore other deserialization pitfalls.
- Wire mutations or cache eviction to trigger even more churn inside Apollo’s normalised cache.
