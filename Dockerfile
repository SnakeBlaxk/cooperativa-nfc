# Imagen del SERVIDOR (API + PWA) + WhatsApp (WAHA, motor GOWS) en el mismo contenedor.
# La app de escritorio se compila con electron-builder, no con Docker.
# Base: imagen oficial de WAHA (Debian + Node 24). Zuki Pay no usa módulos nativos (sql.js es WebAssembly).
# Versión fija para que un deploy no cambie WAHA sin querer; para actualizar, cambie la etiqueta y pruebe.
FROM devlikeapro/waha:gows-2026.10.1
WORKDIR /zuki
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY server ./server
# NODE_OPTIONS de la imagen base pide 16 GB de heap. Aquí: límite para Zuki Pay (WAHA recibe el suyo en server/start.js).
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/servidor.db \
    NODE_OPTIONS="--max-old-space-size=160 --max-semi-space-size=1" MALLOC_ARENA_MAX=2 \
    WAHA_INTERNAL_PORT=3001 WHATSAPP_DEFAULT_ENGINE=GOWS WAHA_LOCAL_STORE_BASE_DIR=/app/.sessions
EXPOSE 3000
# ENTRYPOINT heredado: ["/usr/bin/tini", "--"] (reenvía SIGTERM a Zuki Pay, que guarda la base y la sesión y apaga WAHA)
CMD ["node", "/zuki/server/start.js"]
