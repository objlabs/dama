FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY . .
WORKDIR /workspace/apps/typescript-api
RUN npm ci --ignore-scripts && npm run build

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /workspace/apps/typescript-api/dist ./dist
ARG DAMA_BASE_PATH=""
ENV DAMA_BASE_PATH=$DAMA_BASE_PATH PORT=3000 NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
