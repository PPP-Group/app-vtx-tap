#!/bin/sh
# Roda na subida do container (imagem oficial do nginx executa /docker-entrypoint.d/*.sh).
# Escreve env.js com as variáveis de ambiente para o navegador ler.
set -e

esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

cat > /usr/share/nginx/html/env.js <<EOF
window.NFC_ENV = {
  SUPABASE_URL: "$(esc "${SUPABASE_URL:-}")",
  SUPABASE_ANON_KEY: "$(esc "${SUPABASE_ANON_KEY:-}")"
};
EOF

echo "env.js gerado (Supabase: $([ -n "${SUPABASE_URL:-}" ] && echo configurado || echo 'não configurado, modo demonstração'))"
