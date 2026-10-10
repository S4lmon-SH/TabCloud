FROM node:24-alpine AS build
WORKDIR /app
RUN npm install --global pnpm@9.15.9
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
WORKDIR /app
RUN npm install --global pnpm@9.15.9
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/compute/package.json ./packages/compute/package.json
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.cjs"]
