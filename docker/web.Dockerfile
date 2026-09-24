# The dashboard (APP=web) and the demo shop (APP=demo) share this file.  docker build --build-arg APP=demo ...
FROM node:24-slim AS build
ARG APP=web
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/demo/package.json apps/demo/
COPY packages packages
RUN npm ci -w ${APP} --include-workspace-root
COPY apps/${APP} apps/${APP}
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_STANDALONE=true
RUN npm run build -w ${APP}

FROM node:24-slim
ARG APP=web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 APP=${APP} HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/${APP}/.next/standalone ./
COPY --from=build /repo/apps/${APP}/.next/static apps/${APP}/.next/static
COPY scripts/docker/demo-entrypoint.mjs scripts/docker/entrypoint.mjs ./scripts/docker/
RUN mkdir -p /data && chown node /data
USER node
CMD ["node", "scripts/docker/entrypoint.mjs"]
