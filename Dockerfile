FROM node:24-slim

WORKDIR /app

COPY package*.json ./
COPY server/package*.json ./server/
COPY mobile/package*.json ./mobile/
RUN npm ci

COPY . .

ENV NODE_ENV=production
EXPOSE 10000

CMD ["npm", "start"]
