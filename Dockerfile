FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY bot.mjs ./
COPY lib ./lib
COPY artifacts ./artifacts
COPY webapp ./webapp
RUN mkdir -p data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "bot.mjs"]
