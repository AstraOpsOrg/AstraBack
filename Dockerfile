# Etapa de producción
FROM oven/bun:latest
WORKDIR /usr/src/app

COPY package.json bun.lock ./

# Instala solo dependencias de producción
RUN bun install --frozen-lockfile --production 

COPY . .

EXPOSE 3010

CMD [ "bun", "run", "start" ]