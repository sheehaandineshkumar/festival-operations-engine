FROM node:20-alpine
WORKDIR /app
COPY package.json server.js engine.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
