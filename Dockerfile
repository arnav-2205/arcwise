FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=3000 ARCWISE_DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["npx", "tsx", "server/index.ts"]
