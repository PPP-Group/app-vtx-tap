# Roteador de domínios próprios (veja main.mjs e o README, "Domínio próprio dos restaurantes").
# Roda como root para poder escrever na pasta de configuração do Traefik montada do servidor.
FROM node:22-alpine
WORKDIR /app
COPY main.mjs .
CMD ["node", "main.mjs"]
