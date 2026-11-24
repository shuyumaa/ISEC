# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Public URLs, baked into Astro's trusted hosts (the origin check also reads them at run time).
ARG ISEC_HOSTS
ARG SITE_URL
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4321 DATA_DIR=/data BRAND_DIR=/app/private/brand
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/private ./private
COPY package.json server.mjs ./
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 4321
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
