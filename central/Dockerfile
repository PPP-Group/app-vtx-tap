# Central de plaquinhas (redirecionador + painel interno).
# Contexto de build: a RAIZ do repositório (usa base.css e ui.js do projeto).
FROM nginx:1.27-alpine

COPY central/nginx.conf /etc/nginx/conf.d/default.conf
COPY central/40-env-js.sh /docker-entrypoint.d/40-env-js.sh
RUN chmod +x /docker-entrypoint.d/40-env-js.sh

COPY central/index.html central/t.html central/central.js central/central.css central/placa.js central/env.js /usr/share/nginx/html/
COPY assets/css/base.css /usr/share/nginx/html/assets/css/base.css
COPY assets/js/ui.js /usr/share/nginx/html/assets/js/ui.js
COPY assets/img/icon.svg /usr/share/nginx/html/assets/img/icon.svg

EXPOSE 80
