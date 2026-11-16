# Scheme Performance web app: the Vite build served by nginx. Built by docker-compose.yml at the repo root.
# Node pinned to a patched release (Oct 2026 security release: 22.23.4). Bump by hand; the image has no Node at run time.
# Images pinned by digest (5 Nov 2026), so a rebuild uses the same image; bump the tag and digest together.
FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The API address the browser calls, fixed at build time. /api/v1 (default): the same address (nginx forwards it).
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

# nginx-unprivileged: the same nginx, run as a normal user (uid 101) and listening on 8080, so a flaw in nginx does not
# hand out root in the container.
FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
