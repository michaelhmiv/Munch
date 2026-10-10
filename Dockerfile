FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS base
WORKDIR /app
RUN chown node:node /app
RUN npm install --global bun@1.3.10 \
    && bun --version
COPY --chown=node:node package.json bun.lock ./
USER node
RUN bun install --frozen-lockfile
USER root
# The controlled USDA production pre-deploy downloads official ZIP releases.
# Keep these small OS tools in the runtime image so Railway can validate or
# seed the catalog before promoting a deployment.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip \
    && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node . .

USER node
EXPOSE 8080
# Railway's source-controlled startCommand matches this image default.
CMD ["bun", "--smol", "src/index.ts"]
