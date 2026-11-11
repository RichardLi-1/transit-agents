# The service, the collector and the Gemini agents, with the built display. Node 24
# runs the TypeScript sources directly, so only the display needs a build step.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages/contracts/package.json packages/contracts/
COPY services/api/package.json services/api/
COPY apps/display/package.json apps/display/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY apps/display apps/display
# The mock simulator, which the build copies to /simulator.
COPY apps/microsim-mock apps/microsim-mock
COPY scripts/build-simulator.ts scripts/
# Without the skills here, it keeps the docs' committed skills.json.
COPY scripts/build-docs-data.ts scripts/
RUN npm run build

FROM node:24-slim
# pdftotext reads uploaded PDFs, and ffmpeg takes the stills the media agent checks
# each video by. The agents reach Gemini over HTTPS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /uvx /bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/python UV_NO_CACHE=1 PYTHONUNBUFFERED=1
WORKDIR /app
# The agents' Python and packages, before the npm steps so this layer stays cached.
COPY agents/requirements.txt agents/requirements.txt
RUN uv venv /opt/agents --python 3.14.6 \
  && uv pip install --python /opt/agents/bin/python -r agents/requirements.txt
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY services/api/package.json services/api/
COPY apps/display/package.json apps/display/
RUN npm ci --omit=dev --no-audit --no-fund
COPY packages packages
COPY services/api services/api
COPY agents agents
# The engagement-needs and gtfs-analyst skills read the lines and trips the display draws.
COPY apps/display/public/data apps/display/public/data
COPY --from=build /app/apps/display/dist apps/display/dist
EXPOSE 4100
CMD ["sh", "services/api/start.sh"]
