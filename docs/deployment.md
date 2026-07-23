# Deployment

QuantCase runs bare-metal on a GCP Ubuntu VM: the four Node processes are supervised by **PM2**, fronted by **nginx** with **Certbot** TLS. There is **no Docker, docker-compose, or CI pipeline** — deployment is a git pull plus PM2 reload.

For the full step-by-step VM bring-up, follow the runbooks linked below; this page summarises the topology and the day-to-day operations.

## Topology

```
                 Internet (HTTPS)
                        │
                    ┌───▼────┐  nginx + Certbot
                    │ nginx  │  (qc-backend.nginx.conf)
                    └──┬──┬──┘
      api-dev.quantcase.ai│  │queue-dev.quantcase.ai (basic-auth)
                        │  │
                 ┌──────▼┐ ┌▼───────┐
                 │ :8000 │ │ :9000  │
                 │  API  │ │BullBoard│
                 └───────┘ └────────┘
        PM2-supervised Node processes (ecosystem.config.js):
        quantcase-backend · quantcase-worker · quantcase-scheduler · quantcase-bullboard
                        │
                 PostgreSQL + Redis
```

The [scheduler monitoring runbook](./runbooks/schedular-monitoring.md) also documents an optional **two-server split** (Server1 = API only; Server2 = worker + scheduler + Redis), where the API reaches the scheduler via `SCHEDULER_HOST` and the scheduler reaches the API via `API_URL`.

## PM2 processes

[`ecosystem.config.js`](../ecosystem.config.js) defines the four apps. All share `autorestart: true`, `max_restarts: 10`, `min_uptime: '30s'`, `restart_delay: 5000`, `time: true`, and write to `logs/`.

| App | Script | Notable config |
|-----|--------|----------------|
| `quantcase-backend` | `server.js` | `env.PORT=8000`, `max_memory_restart: '1G'` |
| `quantcase-worker` | `worker.js` | `node_args: '--max-old-space-size=8192'` (8 GB heap) |
| `quantcase-bullboard` | `lib/admin.js` | Bull Board dashboard on `:9000` |
| `quantcase-scheduler` | `scheduler.js` | internal control server on `127.0.0.1:8001` |

### Operating with PM2

```bash
pm2 start ecosystem.config.js     # start all four apps
pm2 status                        # list processes + restart counts
pm2 logs quantcase-worker         # tail a process's logs
pm2 reload ecosystem.config.js    # zero-downtime reload after a deploy
pm2 restart quantcase-scheduler   # restart one app
pm2 startup                       # generate the systemd unit for boot
pm2 save                          # persist the process list across reboots
```

> Run `pm2 startup` **and** `pm2 save` once so the four apps come back automatically after a VM reboot.

A typical deploy on the VM:

```bash
cd ~/quantcase-backend
git pull
npm install
npm run db:generate          # if schema.prisma changed
npm run db:push              # if schema.prisma changed
pm2 reload ecosystem.config.js
```

> The [GCP runbook](./runbooks/deploy-qc-gcp.md) shows an alternative first-boot start using `pm2 start "npm run dev" --name ...` / `worker:dev` (nodemon-based). Prefer `pm2 start ecosystem.config.js` for a stable production deployment — it pins the process names, memory limits, and the worker's 8 GB heap flag.

## nginx

[`qc-backend.nginx.conf`](../qc-backend.nginx.conf) defines two upstreams and two public vhosts (all TLS is Certbot-managed, with HTTP→HTTPS handled by the Certbot-generated port-80 blocks):

| Upstream | Target |
|----------|--------|
| `qc-backend` | `localhost:8000` |
| `qc-queue` | `localhost:9000` |

| Server name | Proxies to | Notes |
|-------------|-----------|-------|
| `api-dev.quantcase.ai` | `qc-backend` | `client_max_body_size 100M` (large PDF/transcript uploads); TLS via Certbot. |
| `queue-dev.quantcase.ai` | `qc-queue` | Bull Board behind HTTP basic auth (`/etc/nginx/.htpasswd`); WebSocket upgrade headers set for live queue updates. |

Deploying a config change:

```bash
sudo nano /etc/nginx/sites-enabled/qc-backend.nginx.conf   # or edit + symlink from sites-available
sudo nginx -t                                              # validate
sudo systemctl restart nginx
```

Create/rotate the Bull Board basic-auth user:

```bash
sudo htpasswd -c /etc/nginx/.htpasswd qc     # -c creates; omit -c to add/update a user
```

## TLS (Certbot)

Certbot is installed via snap and manages the certificates referenced in the nginx config (`/etc/letsencrypt/live/api-dev.quantcase.ai/`):

```bash
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/local/bin/certbot
```

Certbot rewrites the nginx server blocks to add the `listen 443 ssl` directives and the HTTP→HTTPS redirects (visible as the `# managed by Certbot` lines in [`qc-backend.nginx.conf`](../qc-backend.nginx.conf)).

## First-time VM provisioning

The full Ubuntu bring-up — `apt` packages (`git`, `nodejs`, `npm`, `build-essential`, `nginx`, `apache2-utils`), `nvm` install, global `pm2`, `git clone`, `npm install`, starting the four PM2 apps, the `sites-available`/`sites-enabled` symlink, `nginx -t` + restart, and Certbot — is captured in the runbook. Do not duplicate it here; follow:

- **[runbooks/deploy-qc-gcp.md](./runbooks/deploy-qc-gcp.md)** — GCP Ubuntu VM provisioning end-to-end (backend VM IP referenced there: `35.234.210.170`).

## Logs & monitoring

- PM2 writes per-app stdout/stderr to `logs/` (`backend-*.log`, `worker-*.log`, `scheduler-*.log`, `bullboard-*.log`); `time: true` prepends timestamps.
- **Bull Board** (`queue-dev.quantcase.ai`, basic-auth) shows live queue depth, active/failed jobs, and retries.
- The API exposes queue/scheduler/pipeline monitoring under `/api/monitoring/` — see the [scheduler monitoring runbook](./runbooks/schedular-monitoring.md).

## See also

- [architecture.md](./architecture.md) — the four-process architecture in detail
- [subsystems/scheduler.md](./subsystems/scheduler.md) — scheduler internals and job types
- [configuration.md](./configuration.md) — environment variables (including split-server vars)
- [runbooks/deploy-qc-gcp.md](./runbooks/deploy-qc-gcp.md) — full GCP VM provisioning
- [runbooks/schedular-monitoring.md](./runbooks/schedular-monitoring.md) — scheduler & monitoring change log
- [runbooks/JOB_QUEUE_GUIDE.md](./runbooks/JOB_QUEUE_GUIDE.md) — BullMQ job queue operations
- [`ecosystem.config.js`](../ecosystem.config.js), [`qc-backend.nginx.conf`](../qc-backend.nginx.conf) — sources
