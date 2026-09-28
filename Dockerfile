FROM nginx:1.27-alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/40-env-js.sh /docker-entrypoint.d/40-env-js.sh
RUN chmod +x /docker-entrypoint.d/40-env-js.sh

COPY index.html env.js /usr/share/nginx/html/
COPY admin /usr/share/nginx/html/admin
COPY assets /usr/share/nginx/html/assets

EXPOSE 80
