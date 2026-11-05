# Seamline server (Bun). Serves the app and runs the picture-to-3D jobs.
FROM oven/bun:1.2-slim
WORKDIR /app
COPY server.ts .
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "server.ts"]
