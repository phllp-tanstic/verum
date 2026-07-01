FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl bash ca-certificates git jq gzip \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 22 via NodeSource ─────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && node --version && npm --version

# ── bb v0.87.0 ───────────────────────────────────────────────────────────────
COPY bb_v087/bb /usr/local/bin/bb_v087
RUN chmod +x /usr/local/bin/bb_v087 && bb_v087 --version

# ── Noir nargo — both versions pre-cached ────────────────────────────────────
ENV NARGO_INSTALL_DIR=/usr/local/nargo-versions
RUN mkdir -p $NARGO_INSTALL_DIR/beta22 $NARGO_INSTALL_DIR/beta9

RUN curl -fsSL https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
ENV PATH="/root/.nargo/bin:$PATH"

RUN noirup -v 1.0.0-beta.22 \
    && cp /root/.nargo/bin/nargo $NARGO_INSTALL_DIR/beta22/nargo \
    && echo "beta.22 cached"

RUN noirup -v 1.0.0-beta.9 \
    && cp /root/.nargo/bin/nargo $NARGO_INSTALL_DIR/beta9/nargo \
    && echo "beta.9 cached"

RUN cp $NARGO_INSTALL_DIR/beta22/nargo /root/.nargo/bin/nargo \
    && nargo --version

# ── App source ────────────────────────────────────────────────────────────────
WORKDIR /app

COPY verum_circuit ./verum_circuit
COPY commitment_hasher ./commitment_hasher

# Ensure target dirs are writable at runtime for nargo/bb output
RUN chmod -R 777 /app/verum_circuit/target /app/commitment_hasher

COPY frontend/package*.json ./frontend/
RUN cd frontend && npm install --omit=dev

COPY frontend ./frontend

ENV HOME=/root
ENV CIRCUIT_DIR=/app/verum_circuit
ENV HASHER_DIR=/app/commitment_hasher
ENV BB_087_PATH=/usr/local/bin/bb_v087
ENV NARGO_VERSIONS_DIR=/usr/local/nargo-versions
ENV PORT=3000
ENV NODE_ENV=production

WORKDIR /app/frontend
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1

CMD ["node", "server.cjs"]
