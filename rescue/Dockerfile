FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# Rescue Solidity bytecode compiled from included source at build time.
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY rescue ./rescue
COPY lib/telegram.mjs ./lib/telegram.mjs
RUN node rescue/compile.mjs
RUN mkdir -p data && chown -R node:node /app
USER node
ENV PORT=3001
EXPOSE 3001
CMD ["node","rescue/bot.mjs"]
