 
 
sudo -i -u ubuntu
sudo apt update
sudo apt install git
sudo apt install nodejs npm
sudo apt install build-essential

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.5/install.sh | bash

export NVM_DIR="$([ -z "${XDG_CONFIG_HOME-}" ] && printf %s "${HOME}/.nvm" || printf %s "${XDG_CONFIG_HOME}/nvm")"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" # This loads nvm



sudo npm i pm2 -g
git clone https://github.com/atuldubey007/quantcase-backend.git
cd quantcase-backend

npm i


pm2 start "npm run dev" --name "quantcase-backend" -- --port 8000
pm2 start "npm run worker:dev" --name "quantcase-worker"
pm2 start "npm run admin" --name "quantcase-bullboard"
pm2 start "npm run scheduler" --name "quantcase-scheduler"



sudo apt install nginx apache2-utils -y
sudo htpasswd -c /etc/nginx/.htpasswd qc
sudo nano /etc/nginx/sites-available/bullboard

server {
    listen 80;
    server_name _;   # or your domain if you have one

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


sudo ln -s /etc/nginx/sites-available/bullboard /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx


# BACKEND
curl -u qc:helloqc http://35.234.210.170



sudo nano /etc/nginx/sites-enabled/qc-backend.nginx.conf
sudo nginx -t
sudo systemctl restart nginx


sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/local/bin/certbot

