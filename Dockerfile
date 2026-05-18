# ============================================
# Stage 1: Build
# ============================================
FROM node:24-bookworm AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build tools)
RUN npm ci

# Copy source code
COPY . .

# Compile TypeScript to JavaScript
RUN npm run build

# ============================================
# Stage 2: Runtime
# ============================================
FROM node:24-bookworm-slim AS runtime

# Install dumb-init for proper signal handling and zombie reaping
# Also install Chromium dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

WORKDIR /app

# Install production dependencies only (no tsx, no dev tools)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/ecosystem.config.cjs ./

# Create non-root user for security
RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app

USER appuser

# Expose API port
EXPOSE 3030

# Healthcheck (matches actual Fastify endpoint)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:3030/api/v1/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Use absolute path for dumb-init to prevent $PATH resolution issues
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Run compiled JavaScript directly (no tsx required in production)
CMD ["node", "dist/index.js"]
