FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app/server

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/src ./src
COPY server/sql ./sql
COPY public /app/public

USER node
EXPOSE 3000

CMD ["node", "src/index.js"]
