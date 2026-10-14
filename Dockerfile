FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive
COPY tsconfig.json ./
COPY src ./src
RUN yarn build

FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --production --frozen-lockfile --non-interactive && yarn cache clean

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=127.0.0.1 PORT=3000 DATABASE_PATH=/app/data/lightning.sqlite
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME /app/data
CMD ["node", "dist/index.js"]
