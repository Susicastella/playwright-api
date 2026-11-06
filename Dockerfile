
FROM mcr.microsoft.com/playwright:v1.58.2-jammy

# Actualizar Node.js a una versión corregida de la rama 24
RUN npm install -g n \
    && n 24.22.1 \
    && hash -r \
    && node --version

WORKDIR /app

COPY package*.json ./
RUN npm ci
RUN npm audit --json > /tmp/npm-audit.json; node -e "const a=require('/tmp/npm-audit.json'); for(const [n,v] of Object.entries(a.vulnerabilities || {})) console.log(n, v.severity, JSON.stringify(v.fixAvailable))"
COPY . .

CMD ["node", "index.js"]
