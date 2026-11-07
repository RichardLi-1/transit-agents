# The service and the collector, with the built display. Node 24 runs the
# TypeScript sources directly, so only the display needs a build step.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages/contracts/package.json packages/contracts/
COPY services/api/package.json services/api/
COPY apps/display/package.json apps/display/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY apps/display apps/display
RUN npm run build

FROM node:24-slim
# pdftotext reads uploaded PDFs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY services/api/package.json services/api/
COPY apps/display/package.json apps/display/
RUN npm ci --omit=dev --no-audit --no-fund
COPY packages packages
COPY services/api services/api
COPY --from=build /app/apps/display/dist apps/display/dist
EXPOSE 4100
CMD ["sh", "services/api/start.sh"]
