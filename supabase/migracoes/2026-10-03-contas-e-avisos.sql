-- 03/10 (1 de 3): PIN redefinido vale 24 h, contas que se resolvem sozinhas e avisos por e-mail.
-- Rodar no SQL Editor do Supabase. Pode rodar de novo sem problema.

alter table private.fid_pins add column if not exists redefinir_ate timestamptz;

create or replace function public.fid_consultar(p_restaurante uuid, p_cpf text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_cpf text := regexp_replace(coalesce(p_cpf, ''), '[^0-9]', '', 'g'); cli public.fid_clientes;
begin
  if not public.fid_no_ar(p_restaurante) then return jsonb_build_object('status', 'inativo'); end if;
  if not public.cpf_valido(v_cpf) then return jsonb_build_object('status', 'erro', 'mensagem', 'CPF inválido. Confira os números.'); end if;
  if not public.equipe_pode_tentar('fid-consulta:' || public.ip_do_pedido(), 120, 10) then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Muitas consultas seguidas. Aguarde alguns minutos.');
  end if;
  if not exists (select 1 from public.fid_clientes where restaurante_id = p_restaurante and cpf = v_cpf) then
    return jsonb_build_object('status', 'novo');
  end if;
  perform public.fid_vencer(p_restaurante, v_cpf);
  perform public.fid_bonus_aniversario(p_restaurante, v_cpf);
  select * into cli from public.fid_clientes where restaurante_id = p_restaurante and cpf = v_cpf;
  return jsonb_build_object('status', 'ok', 'nome', split_part(cli.nome, ' ', 1), 'pontos', cli.pontos,
    'nivel', public.fid_nivel(p_restaurante, v_cpf),
    'pendentes', (select count(*) from public.fid_notas where restaurante_id = p_restaurante and cpf = v_cpf and status = 'pendente'),
    'cartao', case when public.fid_modo(p_restaurante) <> 'pontos' then public.fid_cartao_resumo(p_restaurante, v_cpf) end,
    'tem_pin', exists (select 1 from private.fid_pins where restaurante_id = p_restaurante and cpf = v_cpf and pin_hash <> ''));
end $$;

create or replace function public.fid_entrar(p_restaurante uuid, p_cpf text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_cpf text := regexp_replace(coalesce(p_cpf, ''), '[^0-9]', '', 'g'); h text; v_ate timestamptz;
begin
  if not public.fid_no_ar(p_restaurante) then return jsonb_build_object('status', 'inativo'); end if;
  if not public.cpf_valido(v_cpf) then return jsonb_build_object('status', 'erro', 'mensagem', 'CPF inválido. Confira os números.'); end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then return jsonb_build_object('status', 'erro', 'mensagem', 'O PIN tem 4 números.'); end if;
  if not public.equipe_pode_tentar('fid-pin:' || p_restaurante || ':' || v_cpf, 5, 15)
     or not public.equipe_pode_tentar('fid-pin-dia:' || p_restaurante || ':' || v_cpf, 12, 1440)
     or not public.equipe_pode_tentar('fid-pin-ip:' || public.ip_do_pedido(), 60, 15) then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Muitas tentativas. Aguarde 15 minutos ou peça para a equipe redefinir seu PIN.');
  end if;
  if not exists (select 1 from public.fid_clientes where restaurante_id = p_restaurante and cpf = v_cpf) then
    return jsonb_build_object('status', 'novo');
  end if;
  select pin_hash, redefinir_ate into h, v_ate from private.fid_pins where restaurante_id = p_restaurante and cpf = v_cpf;
  if h is null then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Peça para a equipe do restaurante redefinir o seu PIN.');
  elsif h = '' then
    -- PIN redefinido pela equipe: o próximo PIN digitado passa a valer, por 24 horas.
    if v_ate is null or v_ate < now() then
      return jsonb_build_object('status', 'erro', 'mensagem', 'O prazo para criar o PIN novo acabou. Peça para a equipe redefinir de novo.');
    end if;
    update private.fid_pins set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf')), redefinir_ate = null
     where restaurante_id = p_restaurante and cpf = v_cpf;
  elsif extensions.crypt(p_pin, h) <> h then
    return jsonb_build_object('status', 'erro', 'mensagem', 'PIN incorreto.');
  end if;
  perform public.equipe_limpar_tentativas('fid-pin:' || p_restaurante || ':' || v_cpf);
  perform public.equipe_limpar_tentativas('fid-pin-dia:' || p_restaurante || ':' || v_cpf);
  return jsonb_build_object('status', 'ok', 'token', public.fid_nova_sessao(p_restaurante, v_cpf), 'pin_novo', h = '');
end $$;

create or replace function public.fid_redefinir_pin(p_cpf text) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante();
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  if not exists (select 1 from public.fid_clientes where restaurante_id = r and cpf = p_cpf) then raise exception 'Cliente não encontrado.'; end if;
  -- O cliente cria o PIN novo no celular nas próximas 24 horas; depois disso, só redefinindo de novo.
  insert into private.fid_pins (restaurante_id, cpf, pin_hash, redefinir_ate) values (r, p_cpf, '', now() + interval '24 hours')
  on conflict (restaurante_id, cpf) do update set pin_hash = '', redefinir_ate = excluded.redefinir_ate;
  delete from private.fid_sessoes where restaurante_id = r and cpf = p_cpf;
end $$;

create or replace function public.fid_transferir(p_token uuid, p_destino text, p_pontos int, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_r uuid; v_cpf text; c jsonb; d public.fid_clientes; eu public.fid_clientes; h text;
  v_min int; v_max int; hoje int; tz text;
begin
  select s.restaurante_id, s.cpf into v_r, v_cpf from private.fid_sessoes s
   where s.token_hash = public.hash_token(p_token) and s.criado_em > now() - interval '180 days';
  if v_r is null then return jsonb_build_object('status', 'sem_sessao'); end if;
  if not public.fid_no_ar(v_r) then return jsonb_build_object('status', 'inativo'); end if;
  if public.fid_fora_do_horario(v_r, 'pontos') is not null then
    return jsonb_build_object('status', 'erro', 'mensagem', public.fid_fora_do_horario(v_r, 'pontos'));
  end if;
  c := public.fid_cfg(v_r);
  if coalesce(c -> 'transferencia' ->> 'ativo', '') <> 'true' then
    return jsonb_build_object('status', 'erro', 'mensagem', 'A transferência de pontos está desligada neste restaurante.');
  end if;
  v_min := least(greatest(public.num_ou(c -> 'transferencia' ->> 'minimo', 1), 1), 1000000)::int;
  v_max := least(greatest(public.num_ou(c -> 'transferencia' ->> 'maximoDia', 0), 0), 10000000)::int;
  if p_pontos is null or p_pontos < v_min then
    return jsonb_build_object('status', 'erro', 'mensagem', 'O mínimo para transferir é ' || v_min || ' ' || case when v_min = 1 then 'ponto' else 'pontos' end || '.');
  end if;
  -- PIN de quem manda (mesmas travas do login).
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then return jsonb_build_object('status', 'erro', 'mensagem', 'O PIN tem 4 números.'); end if;
  if not public.equipe_pode_tentar('fid-pin:' || v_r || ':' || v_cpf, 5, 15)
     or not public.equipe_pode_tentar('fid-pin-dia:' || v_r || ':' || v_cpf, 12, 1440) then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Muitas tentativas. Aguarde 15 minutos.');
  end if;
  select pin_hash into h from private.fid_pins where restaurante_id = v_r and cpf = v_cpf;
  if coalesce(h, '') = '' or extensions.crypt(p_pin, h) <> h then return jsonb_build_object('status', 'erro', 'mensagem', 'PIN incorreto.'); end if;
  perform public.equipe_limpar_tentativas('fid-pin:' || v_r || ':' || v_cpf);
  perform public.equipe_limpar_tentativas('fid-pin-dia:' || v_r || ':' || v_cpf);
  d := public.fid_destino(v_r, p_destino);
  if d.cpf is null then return jsonb_build_object('status', 'erro', 'mensagem', 'Não achamos ninguém no clube com esse CPF ou código.'); end if;
  if d.cpf = v_cpf then return jsonb_build_object('status', 'erro', 'mensagem', 'Esse é você. Digite o CPF ou o código de outra pessoa.'); end if;
  -- Trava as duas contas sempre na mesma ordem (evita impasse com transferências cruzadas).
  perform 1 from public.fid_clientes where restaurante_id = v_r and cpf in (v_cpf, d.cpf) order by cpf for update;
  perform public.fid_vencer(v_r, v_cpf);
  select * into eu from public.fid_clientes where restaurante_id = v_r and cpf = v_cpf;
  if eu.pontos < p_pontos then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Você tem ' || greatest(eu.pontos, 0) || ' pontos. Escolha uma quantidade menor.');
  end if;
  if v_max > 0 then
    tz := public.fid_fuso(v_r);
    select coalesce(-sum(pontos), 0) into hoje from public.fid_movimentos
     where restaurante_id = v_r and cpf = v_cpf and tipo = 'transferencia' and pontos < 0
       and (criado_em at time zone tz)::date = (now() at time zone tz)::date;
    if hoje + p_pontos > v_max then
      return jsonb_build_object('status', 'erro', 'mensagem', 'O limite é ' || v_max || ' pontos transferidos por dia. Hoje ainda dá para mandar '
        || greatest(v_max - hoje, 0) || '.');
    end if;
  end if;
  perform public.fid_mover(v_r, v_cpf, 'transferencia', -p_pontos, 'Transferência para ' || public.fid_nome_curto(d.nome), null, null, null, null, 'Cliente');
  perform public.fid_mover(v_r, d.cpf, 'transferencia', p_pontos, 'Transferência de ' || public.fid_nome_curto(eu.nome), null, null, null, null, 'Cliente');
  return jsonb_build_object('status', 'ok', 'pontos', eu.pontos - p_pontos, 'nome', public.fid_nome_curto(d.nome));
end $$;

-- ===========================================================================
-- Contas e avisos por e-mail
--   * Fila de e-mails (private.avisos_fila): o banco enfileira e chama a função "avisos" (pg_net),
--     que envia pelo Resend. Sem a chave do Resend, os e-mails ficam na fila e nada quebra.
--   * Códigos de recuperação (private.codigos): 6 números, valem 15 minutos, 5 tentativas.
--   * Cliente do clube resolve tudo sozinho: esqueci o PIN (código no e-mail), trocar o PIN,
--     atualizar os dados e apagar a conta. A equipe continua podendo redefinir o PIN.
--   * Avisos para o restaurante (novo cliente no clube, novo pedido) e para a Vortex (pedido de
--     contratação, restaurante novo, mudança de plano).
-- ===========================================================================
create table if not exists private.avisos_config (
  id      int primary key default 1 check (id = 1),
  url     text,                     -- https://<projeto>.supabase.co/functions/v1/avisos
  segredo text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  vortex  text                      -- e-mails extras para os avisos internos (os operadores da central já recebem)
);
insert into private.avisos_config (id) values (1) on conflict (id) do nothing;

create table if not exists private.avisos_fila (
  id             uuid primary key default gen_random_uuid(),
  tipo           text not null,
  para           text not null check (char_length(para) <= 320),
  assunto        text not null check (char_length(assunto) <= 200),
  html           text not null,
  restaurante_id uuid,
  criado_em      timestamptz not null default now(),
  enviado_em     timestamptz,
  tentativas     int not null default 0,
  erro           text,
  pego_em        timestamptz
);
create index if not exists avisos_fila_pendentes_idx on private.avisos_fila (criado_em) where enviado_em is null;

-- Pedidos de contratação vindos da página de orçamento.
create table if not exists private.leads (
  id        uuid primary key default gen_random_uuid(),
  nome      text not null,
  empresa   text not null,
  email     text not null,
  whatsapp  text not null,
  mesas     int,
  plano     jsonb,
  mensal    numeric,
  ip        text,
  criado_em timestamptz not null default now()
);

create table if not exists private.codigos (
  chave       text primary key,
  codigo_hash text not null,
  expira_em   timestamptz not null,
  tentativas  int not null default 0
);

-- Avisos do restaurante (não aparecem na página pública): e-mail e o que avisar.
alter table public.restaurantes add column if not exists avisos jsonb not null default '{}'::jsonb;
-- E-mail de recuperação do PIN de cada pessoa da equipe (opcional).
alter table public.equipe_membros add column if not exists email text check (email is null or char_length(email) <= 120);
create unique index if not exists equipe_membros_email_uidx on public.equipe_membros (restaurante_id, email) where email is not null;

create or replace function private.esc_html(p text) returns text language sql immutable as $$
  select replace(replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
$$;

-- Corpo do e-mail no manual de marca da VTX: faixa noite (#140B33) com o logo, título em Big Shoulders
-- (caixa alta), texto em Schibsted Grotesk, botão roxo (#7D27FC), detalhe ouro (#FFC61A), códigos em
-- IBM Plex Mono e o endosso "uma solução VORTEX". Sem emoji e sem exclamação. As fontes vêm do Google
-- Fonts; quem não carrega fonte (Gmail) cai nas alternativas da pilha.
create or replace function private.email_html(p_titulo text, p_corpo text, p_botao text default null, p_url text default null) returns text
language sql immutable as $$
  select '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    || '<meta name="color-scheme" content="light"><link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@900&family=IBM+Plex+Mono:wght@600&family=Schibsted+Grotesk:wght@400;600;700&display=swap" rel="stylesheet">'
    || '<style>.vtx-codigo{font-family:''IBM Plex Mono'',Consolas,''Courier New'',monospace}</style></head>'
    || '<body style="margin:0;padding:0;background:#F4F2F9;font-family:''Schibsted Grotesk'',Arial,Helvetica,sans-serif;color:#160E33">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F2F9;padding:28px 12px"><tr><td align="center">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:20px;overflow:hidden">'
    || '<tr><td style="background:#140B33;padding:22px 28px"><img src="https://tap.vortexsystems.tech/assets/img/vtx-tap.png" width="104" height="48" alt="VTX Tap" style="display:block;border:0"></td></tr>'
    || '<tr><td style="height:4px;background:#7D27FC;line-height:4px;font-size:0">&nbsp;</td></tr>'
    || '<tr><td style="padding:28px 28px 8px"><h1 style="margin:0 0 16px;font-family:''Big Shoulders Display'',Impact,''Arial Narrow'',Arial,sans-serif;font-weight:900;font-size:30px;line-height:1;text-transform:uppercase;letter-spacing:.3px;color:#160E33">'
    || private.esc_html(p_titulo) || '</h1>'
    || '<div style="font-size:15px;line-height:1.6;color:#2F2752">' || p_corpo || '</div>'
    || case when p_botao is not null and p_url ~ '^https://' then
         '<p style="margin:24px 0 4px"><a href="' || private.esc_html(p_url) || '" style="display:inline-block;background:#7D27FC;color:#FFFFFF;text-decoration:none;font-weight:700;font-size:15px;padding:13px 22px;border-radius:999px">'
         || private.esc_html(p_botao) || '</a></p>' else '' end
    || '</td></tr><tr><td style="padding:22px 28px 26px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #E1DCEE"><tr>'
    || '<td style="padding-top:16px;font-size:12px;line-height:1.5;color:#625A80">VTX Tap · uma solução <b style="letter-spacing:1.5px;color:#140B33">VORTEX</b><br>vortexsystems.tech</td>'
    || '<td align="right" style="padding-top:16px"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#FFC61A"></span></td>'
    || '</tr></table></td></tr></table></td></tr></table></body></html>';
$$;

-- Enfileira e já chama a função "avisos" (assíncrono; o cron reenvia o que falhar).
create or replace function private.aviso(p_tipo text, p_para text, p_assunto text, p_html text, p_restaurante uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare c private.avisos_config; v_para text := lower(btrim(coalesce(p_para, '')));
begin
  if v_para !~ '^[^@\s,]+@[^@\s,]+\.[^@\s,]+$' then return; end if;
  insert into private.avisos_fila (tipo, para, assunto, html, restaurante_id) values (p_tipo, v_para, left(p_assunto, 200), p_html, p_restaurante);
  select * into c from private.avisos_config where id = 1;
  if c.url is not null then
    perform net.http_post(url := c.url, body := jsonb_build_object('acao', 'enviar'),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-segredo', c.segredo), timeout_milliseconds := 5000);
  end if;
end $$;

-- Aviso interno para a Vortex: vai para o e-mail de cada operador cadastrado na central (master)
-- e para os endereços extras de avisos_config.vortex, se houver (separados por vírgula).
create or replace function private.aviso_vortex(p_tipo text, p_assunto text, p_html text) returns void
language plpgsql security definer set search_path = public as $$
declare e text;
begin
  for e in
    select distinct lower(btrim(x)) from (
      select u.email as x from public.operadores o join auth.users u on u.id = o.user_id
      union all
      select unnest(string_to_array(coalesce((select vortex from private.avisos_config where id = 1), ''), ','))
    ) t where btrim(coalesce(x, '')) <> ''
  loop
    perform private.aviso(p_tipo, e, p_assunto, p_html);
  end loop;
end $$;

-- Só a função "avisos" (service role): pega o lote pendente e marca o resultado.
create or replace function public.avisos_lote(p_segredo text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  if p_segredo is distinct from (select segredo from private.avisos_config where id = 1) then return jsonb_build_object('status', 'negado'); end if;
  -- Marca o lote como "pego" para duas chamadas ao mesmo tempo não mandarem o mesmo e-mail.
  with u as (
    update private.avisos_fila a set pego_em = now() where a.id in (
      select id from private.avisos_fila where enviado_em is null and tentativas < 5 and criado_em > now() - interval '2 days'
         and (pego_em is null or pego_em < now() - interval '2 minutes')
       order by criado_em limit 40 for update skip locked)
    returning a.id, a.para, a.assunto, a.html)
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'para', u.para, 'assunto', u.assunto, 'html', u.html)), '[]'::jsonb) into r from u;
  return jsonb_build_object('status', 'ok', 'avisos', r);
end $$;
create or replace function public.avisos_marcar(p_segredo text, p_id uuid, p_ok boolean, p_erro text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_segredo is distinct from (select segredo from private.avisos_config where id = 1) then return; end if;
  update private.avisos_fila set tentativas = tentativas + 1, enviado_em = case when p_ok then now() end, erro = left(p_erro, 300) where id = p_id;
end $$;

-- Código de 6 números para a chave dada (ex.: 'fid:<restaurante>:<cpf>' ou 'equipe:<membro>').
create or replace function private.codigo_novo(p_chave text) returns text
language plpgsql security definer set search_path = public as $$
declare b bytea := extensions.gen_random_bytes(4); c text;
begin
  c := lpad((((get_byte(b, 0)::bigint << 24) | (get_byte(b, 1) << 16) | (get_byte(b, 2) << 8) | get_byte(b, 3)) % 1000000)::text, 6, '0');
  insert into private.codigos (chave, codigo_hash, expira_em) values (p_chave, extensions.crypt(c, extensions.gen_salt('bf')), now() + interval '15 minutes')
  on conflict (chave) do update set codigo_hash = excluded.codigo_hash, expira_em = excluded.expira_em, tentativas = 0;
  return c;
end $$;
-- 'ok' | 'errado' | 'vencido' (vencido também depois de 5 erros). Código certo é usado uma vez só.
create or replace function private.codigo_conferir(p_chave text, p_codigo text) returns text
language plpgsql security definer set search_path = public as $$
declare k private.codigos;
begin
  select * into k from private.codigos where chave = p_chave for update;
  if not found or k.expira_em < now() or k.tentativas >= 5 then return 'vencido'; end if;
  if coalesce(p_codigo, '') !~ '^[0-9]{6}$' or extensions.crypt(p_codigo, k.codigo_hash) <> k.codigo_hash then
    update private.codigos set tentativas = tentativas + 1 where chave = p_chave;
    return 'errado';
  end if;
  delete from private.codigos where chave = p_chave;
  return 'ok';
end $$;

create or replace function private.email_mascarado(p text) returns text language sql immutable as $$
  select case when p ~ '@' then left(split_part(p, '@', 1), 2) || repeat('•', greatest(char_length(split_part(p, '@', 1)) - 2, 1)) || '@' || split_part(p, '@', 2) else '' end;
$$;

-- Endereço público do restaurante (domínio próprio no ar ou o subdomínio).
create or replace function private.endereco_rest(p_restaurante uuid) returns text
language sql stable security definer set search_path = public as $$
  select 'https://' || coalesce((select d.dominio from public.dominios d where d.restaurante_id = r.id and d.status = 'ativo'), r.slug || '.vortexsystems.tech')
    from public.restaurantes r where r.id = p_restaurante;
$$;

/* ---------- Cliente do clube: resolve sozinho ---------- */

-- Esqueci o PIN: manda um código para o e-mail do cadastro.
create or replace function public.fid_pin_esqueci(p_restaurante uuid, p_cpf text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_cpf text := regexp_replace(coalesce(p_cpf, ''), '[^0-9]', '', 'g'); cli public.fid_clientes; c text; rn text;
begin
  if not public.fid_no_ar(p_restaurante) then return jsonb_build_object('status', 'inativo'); end if;
  if not public.cpf_valido(v_cpf) then return jsonb_build_object('status', 'erro', 'mensagem', 'CPF inválido. Confira os números.'); end if;
  if not public.equipe_pode_tentar('fid-esqueci:' || p_restaurante || ':' || v_cpf, 3, 60)
     or not public.equipe_pode_tentar('fid-esqueci-ip:' || public.ip_do_pedido(), 10, 60) then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Você já pediu alguns códigos. Confira o e-mail (e o spam) ou tente de novo em 1 hora.');
  end if;
  select * into cli from public.fid_clientes where restaurante_id = p_restaurante and cpf = v_cpf;
  -- Mesma resposta exista ou não o CPF (não revela quem tem cadastro).
  if not found or coalesce(cli.email, '') = '' then
    return jsonb_build_object('status', 'enviado', 'email', null);
  end if;
  c := private.codigo_novo('fid:' || p_restaurante || ':' || v_cpf);
  select nome into rn from public.restaurantes where id = p_restaurante;
  perform private.aviso('fid_pin', cli.email, c || ' é o seu código do ' || rn,
    private.email_html('Seu código para criar um PIN novo',
      '<p>Olá, ' || private.esc_html(split_part(cli.nome, ' ', 1)) || '.</p><p>Use este código na página do <b>' || private.esc_html(rn)
      || '</b> para criar um PIN novo no clube:</p><p class="vtx-codigo" style="font-family:''IBM Plex Mono'',Consolas,''Courier New'',monospace;font-size:34px;font-weight:600;letter-spacing:8px;margin:18px 0;color:#140B33">' || c
      || '</p><p>O código vale 15 minutos. Se não foi você que pediu, ignore este e-mail: o seu PIN continua o mesmo.</p>'), p_restaurante);
  return jsonb_build_object('status', 'enviado', 'email', private.email_mascarado(cli.email));
end $$;

-- Código do e-mail + PIN novo: troca o PIN e já entra.
create or replace function public.fid_pin_codigo(p_restaurante uuid, p_cpf text, p_codigo text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_cpf text := regexp_replace(coalesce(p_cpf, ''), '[^0-9]', '', 'g'); r text;
begin
  if not public.fid_no_ar(p_restaurante) then return jsonb_build_object('status', 'inativo'); end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then return jsonb_build_object('status', 'erro', 'mensagem', 'O PIN tem 4 números.'); end if;
  if not public.equipe_pode_tentar('fid-codigo-ip:' || public.ip_do_pedido(), 30, 15) then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Muitas tentativas. Aguarde 15 minutos.');
  end if;
  r := private.codigo_conferir('fid:' || p_restaurante || ':' || v_cpf, p_codigo);
  if r = 'errado' then return jsonb_build_object('status', 'erro', 'mensagem', 'Código incorreto. Confira o e-mail.'); end if;
  if r = 'vencido' then return jsonb_build_object('status', 'erro', 'mensagem', 'Este código venceu. Peça um novo.'); end if;
  insert into private.fid_pins (restaurante_id, cpf, pin_hash) values (p_restaurante, v_cpf, extensions.crypt(p_pin, extensions.gen_salt('bf')))
  on conflict (restaurante_id, cpf) do update set pin_hash = excluded.pin_hash, redefinir_ate = null;
  -- Sai dos outros aparelhos: quem tinha o PIN antigo não continua logado.
  delete from private.fid_sessoes where restaurante_id = p_restaurante and cpf = v_cpf;
  perform public.equipe_limpar_tentativas('fid-pin:' || p_restaurante || ':' || v_cpf);
  perform public.equipe_limpar_tentativas('fid-pin-dia:' || p_restaurante || ':' || v_cpf);
  return jsonb_build_object('status', 'ok', 'token', public.fid_nova_sessao(p_restaurante, v_cpf));
end $$;

-- Sessão do cliente pelo token (null se não houver).
create or replace function private.fid_sessao(p_token uuid) returns table (restaurante_id uuid, cpf text)
language sql stable security definer set search_path = public as $$
  select s.restaurante_id, s.cpf from private.fid_sessoes s
   where s.token_hash = public.hash_token(p_token) and s.criado_em > now() - interval '180 days';
$$;

-- Confere o PIN atual do cliente logado (com as mesmas travas do login). null = certo; texto = o erro.
create or replace function private.fid_pin_errado(p_restaurante uuid, p_cpf text, p_pin text) returns text
language plpgsql security definer set search_path = public as $$
declare h text;
begin
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then return 'O PIN tem 4 números.'; end if;
  if not public.equipe_pode_tentar('fid-pin:' || p_restaurante || ':' || p_cpf, 5, 15)
     or not public.equipe_pode_tentar('fid-pin-dia:' || p_restaurante || ':' || p_cpf, 12, 1440) then
    return 'Muitas tentativas. Aguarde 15 minutos.';
  end if;
  select pin_hash into h from private.fid_pins where restaurante_id = p_restaurante and cpf = p_cpf;
  if coalesce(h, '') = '' or extensions.crypt(p_pin, h) <> h then return 'PIN incorreto.'; end if;
  perform public.equipe_limpar_tentativas('fid-pin:' || p_restaurante || ':' || p_cpf);
  return null;
end $$;

-- Trocar o PIN (logado): PIN atual + PIN novo.
create or replace function public.fid_trocar_pin(p_token uuid, p_atual text, p_novo text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_r uuid; v_cpf text; e text;
begin
  select s.restaurante_id, s.cpf into v_r, v_cpf from private.fid_sessao(p_token) s;
  if v_r is null then return jsonb_build_object('status', 'sem_sessao'); end if;
  if coalesce(p_novo, '') !~ '^[0-9]{4}$' then return jsonb_build_object('status', 'erro', 'mensagem', 'O PIN novo tem 4 números.'); end if;
  e := private.fid_pin_errado(v_r, v_cpf, p_atual);
  if e is not null then return jsonb_build_object('status', 'erro', 'mensagem', e); end if;
  update private.fid_pins set pin_hash = extensions.crypt(p_novo, extensions.gen_salt('bf')), redefinir_ate = null where restaurante_id = v_r and cpf = v_cpf;
  -- Fica logado só neste aparelho.
  delete from private.fid_sessoes where restaurante_id = v_r and cpf = v_cpf and token_hash <> public.hash_token(p_token);
  return jsonb_build_object('status', 'ok');
end $$;

-- Meus dados (logado): o que o cliente pode ver e mudar.
create or replace function public.fid_meus_dados(p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_r uuid; v_cpf text; cli public.fid_clientes;
begin
  select s.restaurante_id, s.cpf into v_r, v_cpf from private.fid_sessao(p_token) s;
  if v_r is null then return jsonb_build_object('status', 'sem_sessao'); end if;
  select * into cli from public.fid_clientes where restaurante_id = v_r and cpf = v_cpf;
  return jsonb_build_object('status', 'ok', 'nome', cli.nome, 'email', cli.email, 'telefone', cli.telefone, 'marketing', cli.marketing,
    'nascimento', cli.nascimento, 'cpf', '•••.' || substr(v_cpf, 4, 3) || '.' || substr(v_cpf, 7, 3) || '-••');
end $$;

-- Atualizar e-mail, telefone e ofertas (logado, com o PIN).
create or replace function public.fid_atualizar_meus_dados(p_token uuid, p_pin text, p_email text, p_telefone text, p_marketing boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_r uuid; v_cpf text; e text; v_email text := lower(btrim(coalesce(p_email, ''))); v_tel text := regexp_replace(coalesce(p_telefone, ''), '[^0-9]', '', 'g');
begin
  select s.restaurante_id, s.cpf into v_r, v_cpf from private.fid_sessao(p_token) s;
  if v_r is null then return jsonb_build_object('status', 'sem_sessao'); end if;
  if char_length(v_tel) in (12, 13) and v_tel like '55%' then v_tel := substr(v_tel, 3); end if;
  if char_length(v_email) > 120 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return jsonb_build_object('status', 'erro', 'mensagem', 'E-mail inválido.'); end if;
  if v_tel !~ '^[1-9][0-9]{9,10}$' then return jsonb_build_object('status', 'erro', 'mensagem', 'Telefone inválido. Use DDD + número.'); end if;
  e := private.fid_pin_errado(v_r, v_cpf, p_pin);
  if e is not null then return jsonb_build_object('status', 'erro', 'mensagem', e); end if;
  update public.fid_clientes set email = v_email, telefone = v_tel, marketing = coalesce(p_marketing, marketing) where restaurante_id = v_r and cpf = v_cpf;
  return jsonb_build_object('status', 'ok');
end $$;

-- Apagar a minha conta (LGPD), com o PIN. Some o cadastro, os pontos e o histórico deste restaurante.
create or replace function public.fid_apagar_minha_conta(p_token uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_r uuid; v_cpf text; e text;
begin
  select s.restaurante_id, s.cpf into v_r, v_cpf from private.fid_sessao(p_token) s;
  if v_r is null then return jsonb_build_object('status', 'sem_sessao'); end if;
  e := private.fid_pin_errado(v_r, v_cpf, p_pin);
  if e is not null then return jsonb_build_object('status', 'erro', 'mensagem', e); end if;
  update public.fid_clientes set indicado_por = null where restaurante_id = v_r and indicado_por = v_cpf;
  delete from private.fid_sessoes where restaurante_id = v_r and cpf = v_cpf;
  delete from public.fid_clientes where restaurante_id = v_r and cpf = v_cpf;
  return jsonb_build_object('status', 'ok');
end $$;

/* ---------- Restaurante: e-mail de avisos ---------- */
create or replace function public.meus_avisos() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(avisos, '{}'::jsonb) from public.restaurantes where id = public.meu_restaurante();
$$;
create or replace function public.salvar_avisos(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); v_email text := lower(btrim(coalesce(p ->> 'email', ''))); a jsonb;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  if not public.eu_admin() then raise exception 'Só o administrador do restaurante muda os avisos.'; end if;
  if v_email <> '' and (char_length(v_email) > 120 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then raise exception 'E-mail inválido.'; end if;
  a := jsonb_build_object('email', nullif(v_email, ''), 'novo_cliente', coalesce((p ->> 'novo_cliente')::boolean, true),
    'novo_pedido', coalesce((p ->> 'novo_pedido')::boolean, false), 'boas_vindas', coalesce((p ->> 'boas_vindas')::boolean, true));
  update public.restaurantes set avisos = a where id = r;
  return a;
end $$;

-- Novo cliente no clube: boas-vindas para ele e aviso para o restaurante.
create or replace function private.fid_cliente_novo_aviso() returns trigger
language plpgsql security definer set search_path = public as $$
declare r public.restaurantes; url text;
begin
  select * into r from public.restaurantes where id = new.restaurante_id;
  url := private.endereco_rest(r.id);
  if coalesce(r.avisos ->> 'boas_vindas', 'true') = 'true' and coalesce(new.email, '') <> '' then
    perform private.aviso('fid_boas_vindas', new.email, 'Bem-vindo ao clube do ' || r.nome,
      private.email_html('Você entrou no clube do ' || r.nome,
        '<p>Olá, ' || private.esc_html(split_part(new.nome, ' ', 1)) || '. Seu cadastro está pronto.</p>'
        || '<p>A cada compra com o seu CPF na nota, leia o QR Code da nota fiscal na página do restaurante para ganhar pontos ou selos.</p>'
        || '<p>Seu código de indicação: <b>' || private.esc_html(new.codigo) || '</b>. Guarde o seu PIN de 4 números: é com ele que você entra. Se esquecer, peça um código novo na própria página.</p>',
        'Abrir a página do clube', url || '/?fidelidade'), r.id);
  end if;
  if coalesce(r.avisos ->> 'novo_cliente', 'true') = 'true' and coalesce(r.avisos ->> 'email', '') <> '' then
    perform private.aviso('rest_novo_cliente', r.avisos ->> 'email', 'Novo cliente no clube: ' || split_part(new.nome, ' ', 1),
      private.email_html('Novo cliente no clube',
        '<p><b>' || private.esc_html(new.nome) || '</b> entrou no clube do ' || private.esc_html(r.nome) || '.</p>'
        || '<p>Clientes no clube: <b>' || (select count(*) from public.fid_clientes where restaurante_id = r.id) || '</b>.</p>',
        'Ver no painel', url || '/admin/#fidelidade'), r.id);
  end if;
  return new;
end $$;
drop trigger if exists fid_cliente_novo_aviso on public.fid_clientes;
create trigger fid_cliente_novo_aviso after insert on public.fid_clientes
  for each row execute function private.fid_cliente_novo_aviso();

-- Novo pedido do delivery: e-mail para o restaurante, se ligado.
create or replace function private.pedido_novo_aviso() returns trigger
language plpgsql security definer set search_path = public as $$
declare r public.restaurantes;
begin
  select * into r from public.restaurantes where id = new.restaurante_id;
  if coalesce(r.avisos ->> 'novo_pedido', 'false') = 'true' and coalesce(r.avisos ->> 'email', '') <> '' then
    perform private.aviso('rest_novo_pedido', r.avisos ->> 'email', 'Novo pedido no delivery: #' || new.numero,
      private.email_html('Pedido #' || new.numero || ' recebido',
        '<p>Chegou um pedido no delivery do ' || private.esc_html(r.nome) || '.</p>', 'Abrir o painel', private.endereco_rest(r.id) || '/admin/#delivery'), r.id);
  end if;
  return new;
end $$;
drop trigger if exists pedido_novo_aviso on public.pedidos;
create trigger pedido_novo_aviso after insert on public.pedidos
  for each row execute function private.pedido_novo_aviso();

-- Mudança de plano feita pelo restaurante: aviso para a Vortex.
create or replace function private.plano_mudou_aviso() returns trigger
language plpgsql security definer set search_path = public as $$
declare n text;
begin
  if new.origem <> 'restaurante' then return new; end if;
  select nome into n from public.restaurantes where id = new.restaurante_id;
  perform private.aviso_vortex('vtx_plano', 'Plano alterado: ' || n,
    private.email_html('O ' || n || ' mudou o plano',
      '<p>Mensalidade: ' || coalesce(public.brl(new.mensal_antes), '—') || ' → <b>' || public.brl(new.mensal_depois) || '</b>'
      || case when coalesce(new.taxa_unica, 0) > 0 then ' · taxa única ' || public.brl(new.taxa_unica) else '' end || '.</p>'
      || '<p>Feito por ' || private.esc_html(coalesce(new.por, 'Equipe')) || '.</p>', 'Abrir a central', 'https://tap.vortexsystems.tech/master/'));
  return new;
end $$;
drop trigger if exists plano_mudou_aviso on public.plano_mudancas;
create trigger plano_mudou_aviso after insert on public.plano_mudancas
  for each row execute function private.plano_mudou_aviso();

-- O painel mostra na hora quem entrou no clube (Realtime; a regra "equipe ve clientes" filtra por restaurante).
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'fid_clientes') then
    execute 'alter publication supabase_realtime add table public.fid_clientes';
  end if;
end $$;

/* ---------- Página de orçamento: pedido de contratação ---------- */
create or replace function public.lead_enviar(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_nome text := left(btrim(coalesce(p ->> 'nome', '')), 80);
  v_emp  text := left(btrim(coalesce(p ->> 'empresa', '')), 100);
  v_email text := lower(btrim(coalesce(p ->> 'email', '')));
  v_tel text := regexp_replace(coalesce(p ->> 'whatsapp', ''), '[^0-9]', '', 'g');
  v_mesas int := least(greatest(public.num_ou(p ->> 'mesas', 0), 0), 1000)::int;
  v_mensal numeric := least(greatest(public.num_ou(p ->> 'mensal', 0), 0), 100000);
  itens text;
begin
  if v_nome !~ '\S{2,}' then return jsonb_build_object('status', 'erro', 'mensagem', 'Informe seu nome.'); end if;
  if v_emp !~ '\S{2,}' then return jsonb_build_object('status', 'erro', 'mensagem', 'Informe o nome do restaurante.'); end if;
  if char_length(v_email) > 120 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return jsonb_build_object('status', 'erro', 'mensagem', 'E-mail inválido.'); end if;
  if v_tel !~ '^(55)?[1-9][0-9]{9,10}$' then return jsonb_build_object('status', 'erro', 'mensagem', 'WhatsApp inválido. Use DDD + número.'); end if;
  if not public.equipe_pode_tentar('lead-ip:' || public.ip_do_pedido(), 5, 60) then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Recebemos os seus pedidos. A gente responde em breve.');
  end if;
  insert into private.leads (nome, empresa, email, whatsapp, mesas, plano, mensal, ip)
  values (v_nome, v_emp, v_email, v_tel, v_mesas, p -> 'plano', v_mensal, public.ip_do_pedido());
  select string_agg(private.esc_html(x), ', ') into itens from jsonb_array_elements_text(coalesce(p -> 'plano' -> 'itens', '[]'::jsonb)) x;
  perform private.aviso_vortex('vtx_lead', 'Pedido de contratação: ' || v_emp,
    private.email_html('Novo pedido de contratação',
      '<p><b>' || private.esc_html(v_nome) || '</b> · ' || private.esc_html(v_emp) || '</p>'
      || '<p>E-mail: ' || private.esc_html(v_email) || '<br>WhatsApp: ' || v_tel || '<br>Mesas: ' || v_mesas || '</p>'
      || '<p>Serviços: ' || coalesce(itens, '—') || '<br>Mensalidade simulada: <b>' || public.brl(v_mensal) || '</b></p>'));
  perform private.aviso('lead_confirmacao', v_email, 'Recebemos o seu pedido · VTX Tap',
    private.email_html('Recebemos o seu pedido',
      '<p>Olá, ' || private.esc_html(split_part(v_nome, ' ', 1)) || '. Recebemos o orçamento do <b>' || private.esc_html(v_emp) || '</b>.</p>'
      || '<p>Nossa equipe fala com você pelo WhatsApp para confirmar os detalhes e agendar a implantação.</p>'
      || '<p>Serviços: ' || coalesce(itens, '—') || '<br>Mensalidade simulada: <b>' || public.brl(v_mensal) || '</b></p>'));
  return jsonb_build_object('status', 'ok');
end $$;

/* ---------- Central: restaurante novo com o e-mail do dono ---------- */
create or replace function public.central_boas_vindas(p_restaurante uuid, p_email text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.restaurantes; v_email text := lower(btrim(coalesce(p_email, ''))); url text;
begin
  if not public.eh_operador() then raise exception 'Acesso negado.'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido.'; end if;
  select * into r from public.restaurantes where id = p_restaurante;
  if not found then raise exception 'Restaurante não encontrado.'; end if;
  update public.restaurantes set avisos = coalesce(avisos, '{}'::jsonb) || jsonb_build_object('email', v_email) where id = r.id;
  url := private.endereco_rest(r.id);
  perform private.aviso('rest_boas_vindas', v_email, 'Bem-vindo à VTX Tap · ' || r.nome,
    private.email_html('O ' || r.nome || ' já está na VTX Tap',
      '<p>O painel da equipe é <b>' || url || '/admin</b>. Para criar a sua conta de administrador, toque em "Criar conta", use o <b>código da equipe</b> que combinamos com você e escolha um PIN só seu.</p>'
      || '<p>Depois, em Ajustes › Restaurante › Equipe, cadastre o seu e-mail para recuperar o PIN sozinho se esquecer, e convide a equipe.</p>'
      || '<p>Para ligar uma plaquinha: encoste o celular nela, digite o endereço <b>' || private.esc_html(r.slug) || '</b> (só na primeira vez), entre com o PIN e escolha a mesa.</p>'
      || '<p>Os avisos do restaurante (novo cliente no clube, pedidos) chegam neste e-mail. Dá para mudar em Ajustes.</p>',
      'Abrir o painel', url || '/admin/'), r.id);
  perform private.aviso_vortex('vtx_restaurante', 'Restaurante novo: ' || r.nome,
    private.email_html('Restaurante novo na VTX Tap', '<p><b>' || private.esc_html(r.nome) || '</b> (' || url || ') foi criado e recebeu o e-mail de boas-vindas em ' || private.esc_html(v_email) || '.</p>'));
  return jsonb_build_object('status', 'ok');
end $$;

-- Operador convida outro operador: entra na lista de convites e recebe o e-mail para criar a senha.
create or replace function public.central_convidar_operador(p_email text, p_nome text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(btrim(coalesce(p_email, ''))); v_nome text := left(btrim(coalesce(p_nome, '')), 60);
begin
  if not public.eh_operador() then raise exception 'Acesso negado.'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido.'; end if;
  insert into public.operadores_convite (email, nome) values (v_email, v_nome) on conflict (email) do update set nome = excluded.nome;
  -- Quem já tem conta confirmada vira operador na hora.
  insert into public.operadores (user_id, nome) select u.id, v_nome from auth.users u
   where lower(u.email) = v_email and u.email_confirmed_at is not null on conflict (user_id) do nothing;
  perform private.aviso('vtx_convite', v_email, 'Convite para a central da VTX Tap',
    private.email_html('Você foi convidado para a central',
      '<p>Olá' || case when v_nome <> '' then ', ' || private.esc_html(split_part(v_nome, ' ', 1)) else '' end || '. Você agora pode acessar a central da VTX Tap.</p>'
      || '<p>Abra a central, toque em <b>Primeiro acesso</b>, use este e-mail e crie a sua senha. Depois, confirme pelo link que chega no e-mail.</p>',
      'Abrir a central', 'https://tap.vortexsystems.tech/master/'));
  return jsonb_build_object('status', 'ok');
end $$;

-- Equipe: e-mail de recuperação e código (só a função "equipe", com a service role).
create or replace function public.equipe_codigo(p_membro uuid) returns text
language sql security definer set search_path = public as $$
  select private.codigo_novo('equipe:' || p_membro);
$$;
create or replace function public.equipe_codigo_conferir(p_membro uuid, p_codigo text) returns text
language sql security definer set search_path = public as $$
  select private.codigo_conferir('equipe:' || p_membro, p_codigo);
$$;
create or replace function public.equipe_aviso(p_para text, p_assunto text, p_titulo text, p_corpo text, p_restaurante uuid) returns void
language sql security definer set search_path = public as $$
  select private.aviso('equipe', p_para, p_assunto, private.email_html(p_titulo, p_corpo), p_restaurante);
$$;

do $$
declare f text;
begin
  foreach f in array array['private.esc_html(text)', 'private.email_html(text, text, text, text)', 'private.aviso(text, text, text, text, uuid)',
    'private.aviso_vortex(text, text, text)', 'private.codigo_novo(text)', 'private.codigo_conferir(text, text)', 'private.email_mascarado(text)',
    'private.endereco_rest(uuid)', 'private.fid_sessao(uuid)', 'private.fid_pin_errado(uuid, text, text)', 'private.fid_cliente_novo_aviso()',
    'private.pedido_novo_aviso()', 'private.plano_mudou_aviso()'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.avisos_lote(text)', 'public.avisos_marcar(text, uuid, boolean, text)', 'public.equipe_codigo(uuid)',
    'public.equipe_codigo_conferir(uuid, text)', 'public.equipe_aviso(text, text, text, text, uuid)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array['public.fid_pin_esqueci(uuid, text)', 'public.fid_pin_codigo(uuid, text, text, text)', 'public.fid_trocar_pin(uuid, text, text)',
    'public.fid_meus_dados(uuid)', 'public.fid_atualizar_meus_dados(uuid, text, text, text, boolean)', 'public.fid_apagar_minha_conta(uuid, text)',
    'public.lead_enviar(jsonb)'] loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
  foreach f in array array['public.meus_avisos()', 'public.salvar_avisos(jsonb)', 'public.central_boas_vindas(uuid, text)', 'public.central_convidar_operador(text, text)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- Reenvia a cada 5 minutos o que ficou na fila (função fora do ar, limite do provedor).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'avisos-reenviar';
    perform cron.schedule('avisos-reenviar', '*/5 * * * *', $c$
      select net.http_post(url := c.url, body := '{"acao":"enviar"}'::jsonb,
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-segredo', c.segredo), timeout_milliseconds := 5000)
      from private.avisos_config c
      where c.url is not null and exists (select 1 from private.avisos_fila where enviado_em is null and tentativas < 5 and criado_em > now() - interval '2 days')
    $c$);
  end if;
end $$;

