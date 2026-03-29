FROM mcr.microsoft.com/playwright:v1.41.0

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "index.js"]