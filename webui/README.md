# mihomo Gateway Web UI

Small Bun + Elysia admin UI for the OpenRC-managed `mihomo` service.

Required runtime environment:

- `WEBUI_ADMIN_PASSWORD`: password for the admin UI
- `WEBUI_PORT`: listen port, defaults to `8080`
- `MIHOMO_API_SECRET`: mihomo external-controller secret used for MetaCubeXD setup
- `MIHOMO_EXTERNAL_CONTROLLER`: mihomo controller bind address, defaults to `0.0.0.0:9090`
