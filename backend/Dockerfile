FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg \
       -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
    && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list \
       -o /etc/apt/sources.list.d/tailscale.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends tailscale \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN chmod +x ./start.sh

EXPOSE 10000

CMD ["./start.sh"]