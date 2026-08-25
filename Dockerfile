FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
# The one-off USDA production seed runner downloads official ZIP releases.
# Keep these small OS tools in the runtime image so the explicit startup gate
# can validate or seed without exposing PostgreSQL outside Railway.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip \
    && rm -rf /var/lib/apt/lists/*
COPY . .

USER bun
EXPOSE 8080
# --smol runs Bun's GC more aggressively and grows the heap more slowly,
# keeping RSS low on small Railway instances. The wrapper is inert unless
# MUNCH_USDA_SEED_MODE is explicitly set to dry-run or seed.
CMD ["bash", "scripts/start-production.sh"]
