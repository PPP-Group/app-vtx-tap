#!/bin/sh
# Roda na subida do container (imagem oficial do nginx executa /docker-entrypoint.d/*.sh).
# Escreve env.js com as variáveis de ambiente para o navegador ler.
set -e

esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

cat > /usr/share/nginx/html/env.js <<JS
window.NFC_ENV = window.CENTRAL_ENV = {
  SUPABASE_URL: "$(esc "${SUPABASE_URL:-}")",
  SUPABASE_ANON_KEY: "$(esc "${SUPABASE_ANON_KEY:-}")",
  BASE_DOMAIN: "$(esc "${BASE_DOMAIN:-}")",
  CENTRAL_HOST: "$(esc "${CENTRAL_HOST:-}")"
};
JS

echo "env.js gerado (Supabase: $([ -n "${SUPABASE_URL:-}" ] && echo configurado || echo 'não configurado, modo demonstração'); central: ${CENTRAL_HOST:-?}; restaurantes: *.${BASE_DOMAIN:-?})"
