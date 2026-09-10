FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends aria2 ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY tracker-service/*.mjs ./
RUN mkdir /data && chown node:node /data
USER node
ENV SHELF_DATA_DIRECTORY=/data LISTEN_HOST=0.0.0.0 PORT=8788
CMD ["node", "server.mjs"]
