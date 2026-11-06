
FROM mcr.microsoft.com/playwright:v1.58.2-jammy

# Actualizar Node.js a una versión corregida de la rama 24
RUN npm install -g n \
    && n 24.22.1 \
    && hash -r \
    && node --version

WORKDIR /app

COPY package*.json ./
RUN npm ci
RUN npm audit --audit-level=moderate
COPY . .

CMD ["node", "index.js"]
