#!/bin/sh
# Roda na subida do container: escreve env.js com as variáveis de ambiente da central.
set -e

esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

cat > /usr/share/nginx/html/env.js <<JS
window.CENTRAL_ENV = {
  SUPABASE_URL: "$(esc "${SUPABASE_URL:-}")",
  SUPABASE_ANON_KEY: "$(esc "${SUPABASE_ANON_KEY:-}")"
};
JS

echo "env.js da central gerado (Supabase: $([ -n "${SUPABASE_URL:-}" ] && echo configurado || echo 'não configurado, modo demonstração'))"
