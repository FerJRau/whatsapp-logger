FROM node:20-slim

# Install build tools for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy app code
COPY index.js ./
COPY .env.example ./

# Create persistent directories
RUN mkdir -p /app/auth_store /app/data

# Environment defaults
ENV AUTH_DIR=/app/auth_store
ENV SQLITE_PATH=/app/data/messages.db
ENV LOG_LEVEL=info

# Run as non-root
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser

CMD ["node", "index.js"]
