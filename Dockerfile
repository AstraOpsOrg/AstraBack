FROM oven/bun:latest
WORKDIR /usr/src/app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production 
COPY . .
EXPOSE 3000 
CMD [ "bun", "run", "start" ]