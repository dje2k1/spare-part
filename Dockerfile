# MODE Stock — serveur de synchronisation + application (une seule image, aucune compilation).
# Construction : docker build -t mode-stock .   ·   Données persistantes : volume /data (à sauvegarder).
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data

# Dépendance du serveur (SDK Anthropic pour le relais d'analyse photo) — installée seule pour profiter du cache
COPY server/package.json server/package-lock.json server/
RUN npm ci --prefix server --omit=dev && npm cache clean --force

# Application (fichiers statiques servis tels quels) et serveur
COPY package.json index.html manifest.webmanifest sw.js ./
COPY css css
COPY js js
COPY vendor vendor
COPY fonts fonts
COPY icons icons
COPY server/*.js server/

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/api/config >/dev/null || exit 1
# Arrêt propre (SIGTERM) : journal et instantané écrits avant de quitter
STOPSIGNAL SIGTERM
CMD ["node", "server/index.js"]
