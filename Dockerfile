FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
# The controlled USDA production pre-deploy downloads official ZIP releases.
# Keep these small OS tools in the runtime image so Railway can validate or
# seed the catalog before promoting a deployment.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip \
    && rm -rf /var/lib/apt/lists/*
COPY . .

USER bun
EXPOSE 8080
# Railway's source-controlled startCommand matches this image default.
CMD ["bun", "--smol", "src/index.ts"]
