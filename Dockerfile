FROM oven/bun:latest

USER root
RUN apt-get update -y \
	&& apt-get install -y --no-install-recommends ca-certificates curl unzip tar gnupg lsb-release apt-transport-https \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

RUN chmod +x scripts/*.sh

RUN ./scripts/verify-install-deps.sh

RUN chown -R bun:bun /usr/src/app
USER bun

EXPOSE 3000
CMD ["bun", "run", "start"]