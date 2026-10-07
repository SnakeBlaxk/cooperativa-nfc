# Imagen del SERVIDOR (API + PWA). La app de escritorio se compila con electron-builder, no con Docker.
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY server ./server
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/servidor.db
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server/index.js"]
