#####
# BASE
FROM node:24-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./

# --- all dependencies, used for building and development ---
FROM base AS deps
RUN npm ci

# --- compile the engine and routers to plain JS (templates and transports are compiled separately and mounted) ---
FROM deps AS build
COPY tsconfig.json tsconfig.engine.json ./
COPY engine ./engine
RUN npm run engine-compiler

# BASE
#####

#####
# DEV

# --- development: source is bind-mounted by docker-compose.dev.yml ---
FROM deps AS dev
COPY tsconfig.json tsconfig.engine.json tsconfig.templates.json ./
COPY .storybook ./.storybook
ENV TEMPLATES_DIR=/app/templates \
    TRANSPORTS_DIR=/app/transports
EXPOSE 3000 6006
CMD ["npm", "run", "dev"]

# DEV
#####

#####
# PROD

# --- production dependencies only ---
FROM base AS prod-deps
RUN npm ci --omit=dev

# --- production engine image: no templates, no dev tooling, no TSX ---
# Compiled templates and transports are mounted read-only at /app/templates and /app/transports so that
# their bare imports (zod, react, ...) resolve against /app/node_modules.
FROM node:24-slim AS engine
ENV NODE_ENV=production \
    PORT=3000 \
    TEMPLATES_DIR=/app/templates \
    TRANSPORTS_DIR=/app/transports
WORKDIR /app
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist/engine ./dist/engine
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/engine/index.js"]

# PROD
#####