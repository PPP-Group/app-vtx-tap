# Um app só para a central e todos os restaurantes.
#   CENTRAL_HOST  endereço da central e das plaquinhas (ex.: tap.vortexsystems.tech)
#   BASE_DOMAIN   domínio dos restaurantes (ex.: vortexsystems.tech → quintal.vortexsystems.tech)
#   SUPABASE_URL / SUPABASE_ANON_KEY   do projeto Supabase único
FROM nginx:1.27-alpine

ENV CENTRAL_HOST=tap.localhost \
    BASE_DOMAIN=

COPY deploy/templates /etc/nginx/templates
COPY deploy/comum.conf /etc/nginx/snippets/comum.conf
COPY deploy/40-env-js.sh /docker-entrypoint.d/40-env-js.sh
RUN chmod +x /docker-entrypoint.d/40-env-js.sh && rm -f /etc/nginx/conf.d/default.conf

COPY index.html env.js /usr/share/nginx/html/
COPY admin /usr/share/nginx/html/admin
COPY lp /usr/share/nginx/html/lp
COPY delivery /usr/share/nginx/html/delivery
COPY telao /usr/share/nginx/html/telao
COPY assets /usr/share/nginx/html/assets
COPY central/index.html central/t.html central/central.js central/central.css central/placa.js central/sw.js central/manifest.webmanifest /usr/share/nginx/html/central/

EXPOSE 80
