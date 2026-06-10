FROM node:22-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

WORKDIR /app

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps/proxy/package.json apps/proxy/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/schema/package.json packages/schema/package.json

RUN pnpm install --frozen-lockfile

FROM deps AS build

COPY . .

RUN pnpm build:runtime

FROM base AS runtime

ENV NODE_ENV="production"
ENV PORT="8787"

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/proxy/package.json apps/proxy/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/schema/package.json packages/schema/package.json

RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/apps/proxy/dist apps/proxy/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/schema/dist packages/schema/dist

EXPOSE 8787

CMD ["pnpm", "start:prod:proxy"]
