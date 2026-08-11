# ---- Agbota Segun — production image ----
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Application source
COPY . .

# Run as a non-root user.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 10000

# Render provides PORT; the server binds 0.0.0.0 and reads process.env.PORT.
CMD ["node", "server.js"]
