[Docs](../README.md) · [Runbooks](../README.md#existing-reference-material) · Deploy on GCP

# Deploy QuantCase on a GCP VM

A bare-metal deployment runbook: provision a Ubuntu VM, install the runtime, run the four
QuantCase processes under PM2, and put nginx (with Basic Auth + TLS) in front. For the
architectural context behind the four processes, see [../architecture.md](../architecture.md);
for the fuller production write-up see [../deployment.md](../deployment.md).

> [!WARNING]
> The commands below include a placeholder Basic-Auth password (`<bullboard-password>`) and a
> placeholder host (`<server-ip>`). **Never commit real credentials or IPs into the repo.** Rotate
> the Bull Board password if it was ever shared in plaintext, and prefer an SSH tunnel over exposing
> `:9000` publicly.

## 1. Base packages

```bash
sudo -i -u ubuntu
sudo apt update
sudo apt install -y git nodejs npm build-essential
```

## 2. Node via nvm

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.5/install.sh | bash

export NVM_DIR="$([ -z "${XDG_CONFIG_HOME-}" ] && printf %s "${HOME}/.nvm" || printf %s "${XDG_CONFIG_HOME}/nvm")"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"   # load nvm
```

## 3. Clone & install

```bash
sudo npm i -g pm2
git clone https://github.com/atuldubey007/quantcase-backend.git
cd quantcase-backend
npm i
```

> [!IMPORTANT]
> Create a `.env` before starting the processes — see [../configuration.md](../configuration.md)
> for every variable (`DATABASE_URL`, `REDIS_*`, `OPENROUTER_API_KEY`, …). Then run
> `npm run db:generate && npm run db:push`.

## 4. Start the four processes under PM2

```bash
pm2 start "npm run dev"       --name "quantcase-backend"  -- --port 8000
pm2 start "npm run worker:dev" --name "quantcase-worker"
pm2 start "npm run admin"     --name "quantcase-bullboard"
pm2 start "npm run scheduler" --name "quantcase-scheduler"
```

## 5. nginx reverse proxy for Bull Board (Basic Auth)

```bash
sudo apt install -y nginx apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd qc
sudo nano /etc/nginx/sites-available/bullboard
```

```nginx
server {
    listen 80;
    server_name _;   # or your domain

    location / {
        auth_basic "Restricted Access";
        auth_basic_user_file /etc/nginx/.htpasswd;

        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/bullboard /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx

# smoke-test the proxied dashboard
curl -u qc:<bullboard-password> http://<server-ip>
```

## 6. Backend vhost + TLS

The API vhost config is checked in at [`../../qc-backend.nginx.conf`](../../qc-backend.nginx.conf).

```bash
sudo nano /etc/nginx/sites-enabled/qc-backend.nginx.conf
sudo nginx -t
sudo systemctl restart nginx

# Certbot for HTTPS
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/local/bin/certbot
sudo certbot --nginx
```

## See also

- [../deployment.md](../deployment.md) — the production deployment overview (PM2 topology, hosts)
- [../architecture.md](../architecture.md) — the four processes and how they connect
- [../configuration.md](../configuration.md) — environment variables and secrets
- [./scheduler-monitoring.md](./scheduler-monitoring.md) — scheduler & monitoring notes
- [./JOB_QUEUE_GUIDE.md](./JOB_QUEUE_GUIDE.md) — queue operations
