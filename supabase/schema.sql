-- ============================================================================
-- VTX Tap — banco único para todos os restaurantes (e a central da Vortex).
--
-- Cada restaurante é uma linha em public.restaurantes, identificado pelo
-- subdomínio (slug): quintal.vortexsystems.tech → slug "quintal".
-- Tudo o que é de um restaurante (chamados, equipe, mesas, comentários,
-- plaquinhas) tem restaurante_id, e as regras de acesso (RLS) garantem que a
-- equipe de um restaurante só enxerga o dela.
--
-- Cole no SQL Editor e execute. Pode rodar de novo a cada atualização.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

-- ---------------------------------------------------------------------------
-- Operadores da central (Vortex). Convide o e-mail e crie o usuário em
-- Authentication › Users (Auto Confirm User): ele vira operador na hora.
--   insert into public.operadores_convite (email, nome) values ('voce@empresa.com', 'Seu nome');
-- ---------------------------------------------------------------------------
create table if not exists public.operadores (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  nome      text not null default '' check (char_length(nome) <= 60),
  criado_em timestamptz not null default now()
);
create table if not exists public.operadores_convite (
  email text primary key check (email = lower(email)),
  nome  text not null default '' check (char_length(nome) <= 60)
);
alter table public.operadores enable row level security;
alter table public.operadores_convite enable row level security;
revoke all on public.operadores from anon;
revoke all on public.operadores_convite from anon, authenticated;

create or replace function public.aceitar_convite_operador() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email_confirmed_at is not null then
    insert into public.operadores (user_id, nome)
    select new.id, c.nome from public.operadores_convite c where c.email = lower(new.email)
    on conflict (user_id) do nothing;
  end if;
  return new;
end $$;
revoke execute on function public.aceitar_convite_operador() from public, anon, authenticated;

drop trigger if exists operador_por_convite on auth.users;
create trigger operador_por_convite after insert or update of email, email_confirmed_at on auth.users
  for each row execute function public.aceitar_convite_operador();

insert into public.operadores (user_id, nome)
select u.id, c.nome from auth.users u join public.operadores_convite c on c.email = lower(u.email)
where u.email_confirmed_at is not null
on conflict (user_id) do nothing;

create or replace function public.eh_operador() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.operadores where user_id = auth.uid());
$$;
revoke execute on function public.eh_operador() from public, anon;
grant execute on function public.eh_operador() to authenticated;

drop policy if exists "operador ve operadores" on public.operadores;
create policy "operador ve operadores" on public.operadores
  for select to authenticated using (public.eh_operador());

-- ---------------------------------------------------------------------------
-- Restaurantes
-- ---------------------------------------------------------------------------
-- Código de ativação: a equipe digita na primeira leitura de uma plaquinha
-- nova, e ela passa a ser do restaurante. 8 caracteres sem 0/O, 1/I/L.
create or replace function public.novo_codigo(p_tamanho int) returns text
language plpgsql volatile set search_path = public as $$
declare alfabeto constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; b bytea; c text := '';
begin
  b := extensions.gen_random_bytes(p_tamanho);
  for i in 0..p_tamanho - 1 loop
    c := c || substr(alfabeto, (get_byte(b, i) % 31) + 1, 1);
  end loop;
  return c;
end $$;
revoke execute on function public.novo_codigo(int) from public, anon, authenticated;

create table if not exists public.restaurantes (
  id              uuid primary key default gen_random_uuid(),
  -- Subdomínio: letras minúsculas, números e hífen.
  slug            text not null unique check (
                    slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'
                    and slug not in ('tap', 'www', 'admin', 'api', 'app', 'central', 'mail', 'ftp', 'painel')),
  nome            text not null check (char_length(nome) between 1 and 80),
  ativo           boolean not null default true,
  codigo_ativacao text not null unique default public.novo_codigo(8),
  observacao      text check (char_length(observacao) <= 300),
  -- Configuração editada pelo painel do restaurante. Vazio = valores iniciais.
  restaurante     jsonb,
  wifi            jsonb,
  cardapio        jsonb,
  mesas           jsonb,
  widgets         jsonb,
  criado_em       timestamptz not null default now()
);
alter table public.restaurantes enable row level security;
revoke all on public.restaurantes from anon;

drop policy if exists "operador gerencia restaurantes" on public.restaurantes;
create policy "operador gerencia restaurantes" on public.restaurantes
  for all to authenticated using (public.eh_operador()) with check (public.eh_operador());

-- Senha da equipe de cada restaurante (definida pela central ao criar).
create table if not exists private.equipe_senha (
  restaurante_id uuid primary key references public.restaurantes (id) on delete cascade,
  senha_hash     text not null
);

create or replace function public.restaurante_ativo(p_restaurante uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.restaurantes where id = p_restaurante and ativo);
$$;

create or replace function public.total_mesas(p_restaurante uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select (mesas ->> 'total')::int from public.restaurantes where id = p_restaurante), 500);
$$;

-- Dados públicos do restaurante para a página da mesa e o painel (sem código de ativação).
create or replace function public.restaurante_publico(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', id, 'slug', slug, 'nome', nome, 'restaurante', restaurante,
    'wifi', wifi, 'cardapio', cardapio, 'mesas', mesas, 'widgets', widgets)
  from public.restaurantes where slug = lower(btrim(p_slug)) and ativo;
$$;

-- ---------------------------------------------------------------------------
-- Equipe: cada pessoa entra com um PIN próprio (único dentro do restaurante).
-- Cadastro e login passam pela função "equipe" (Edge Function).
-- ---------------------------------------------------------------------------
create table if not exists private.segredo (
  id     int primary key default 1 check (id = 1),
  pepper text not null default encode(extensions.gen_random_bytes(32), 'hex')
);
insert into private.segredo (id) values (1) on conflict (id) do nothing;

create table if not exists private.tentativas (
  chave text not null,
  em    timestamptz not null default now()
);
create index if not exists tentativas_chave_em_idx on private.tentativas (chave, em);

create table if not exists public.equipe_membros (
  id             uuid primary key default gen_random_uuid(),
  restaurante_id uuid not null references public.restaurantes (id) on delete cascade,
  user_id        uuid not null unique references auth.users (id) on delete cascade,
  nome           text not null check (char_length(nome) between 1 and 60),
  pin_hmac       text not null,
  criado_em      timestamptz not null default now(),
  unique (restaurante_id, pin_hmac)
);
alter table public.equipe_membros enable row level security;
revoke all on public.equipe_membros from anon, authenticated;

-- Restaurante de quem está logado (null = não é da equipe de ninguém).
create or replace function public.meu_restaurante() returns uuid
language sql stable security definer set search_path = public as $$
  select restaurante_id from public.equipe_membros where user_id = auth.uid();
$$;
revoke execute on function public.meu_restaurante() from public, anon;
grant execute on function public.meu_restaurante() to authenticated;

grant select (id, restaurante_id, nome, criado_em) on public.equipe_membros to authenticated;
drop policy if exists "equipe ve a equipe" on public.equipe_membros;
create policy "equipe ve a equipe" on public.equipe_membros
  for select to authenticated using (restaurante_id = public.meu_restaurante());

-- A equipe salva a configuração do próprio restaurante (só estas chaves).
create or replace function public.salvar_config(p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante();
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  update public.restaurantes set
    restaurante = case when p_patch ? 'restaurante' then p_patch -> 'restaurante' else restaurante end,
    wifi        = case when p_patch ? 'wifi'        then p_patch -> 'wifi'        else wifi end,
    cardapio    = case when p_patch ? 'cardapio'    then p_patch -> 'cardapio'    else cardapio end,
    mesas       = case when p_patch ? 'mesas'       then p_patch -> 'mesas'       else mesas end,
    widgets     = case when p_patch ? 'widgets'     then p_patch -> 'widgets'     else widgets end
  where id = r;
end $$;

create or replace function public.equipe_pin_hmac(p_restaurante uuid, p_pin text) returns text
language sql stable security definer set search_path = public as $$
  select encode(extensions.hmac(p_restaurante::text || ':' || p_pin, (select pepper from private.segredo where id = 1), 'sha256'), 'hex');
$$;

-- 'ok' | 'errada' | 'sem_senha'
create or replace function public.equipe_conferir_senha(p_restaurante uuid, p_senha text) returns text
language plpgsql stable security definer set search_path = public as $$
declare h text;
begin
  select senha_hash into h from private.equipe_senha where restaurante_id = p_restaurante;
  if h is null then return 'sem_senha'; end if;
  return case when extensions.crypt(p_senha, h) = h then 'ok' else 'errada' end;
end $$;

create or replace function public.equipe_trocar_senha(p_restaurante uuid, p_senha text) returns void
language sql security definer set search_path = public as $$
  insert into private.equipe_senha (restaurante_id, senha_hash)
  values (p_restaurante, extensions.crypt(p_senha, extensions.gen_salt('bf')))
  on conflict (restaurante_id) do update set senha_hash = excluded.senha_hash;
$$;

-- Freio contra tentativas: true = pode tentar; registra a tentativa.
create or replace function public.equipe_pode_tentar(p_chave text, p_max int, p_minutos int) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from private.tentativas where em < now() - interval '1 day';
  select count(*) into n from private.tentativas
   where chave = p_chave and em > now() - make_interval(mins => p_minutos);
  if n >= p_max then return false; end if;
  insert into private.tentativas (chave) values (p_chave);
  return true;
end $$;

create or replace function public.equipe_limpar_tentativas(p_chave text) returns void
language sql security definer set search_path = public as $$
  delete from private.tentativas where chave = p_chave;
$$;

-- ---------------------------------------------------------------------------
-- Plaquinhas: uma linha por plaquinha física (NFC e QR com o mesmo código).
-- Sai de fábrica sem dono; a equipe ativa com o código de ativação
-- (restaurante_id) e depois escolhe a mesa (mesa).
-- ---------------------------------------------------------------------------
create table if not exists public.etiquetas (
  codigo         text primary key check (codigo ~ '^[A-Z0-9]{4,16}$'),
  lote           text not null default '' check (char_length(lote) <= 40),
  restaurante_id uuid references public.restaurantes (id) on delete set null,
  mesa           int check (mesa between 1 and 500),
  gravada        boolean not null default false,
  criado_em      timestamptz not null default now(),
  ativada_em     timestamptz,
  vinculada_em   timestamptz,
  vinculada_por  text check (char_length(vinculada_por) <= 60),
  leituras       int not null default 0,
  ultima_leitura timestamptz
);
create index if not exists etiquetas_restaurante_idx on public.etiquetas (restaurante_id, mesa);
create index if not exists etiquetas_lote_idx on public.etiquetas (lote);
alter table public.etiquetas enable row level security;
revoke all on public.etiquetas from anon;

drop policy if exists "operador gerencia etiquetas" on public.etiquetas;
create policy "operador gerencia etiquetas" on public.etiquetas
  for all to authenticated using (public.eh_operador()) with check (public.eh_operador());
drop policy if exists "equipe ve as plaquinhas dela" on public.etiquetas;
create policy "equipe ve as plaquinhas dela" on public.etiquetas
  for select to authenticated using (restaurante_id = public.meu_restaurante());

-- Leituras por dia (horário de Brasília), para as métricas da central.
create table if not exists public.leituras_dia (
  dia            date not null,
  codigo         text not null references public.etiquetas (codigo) on delete cascade,
  restaurante_id uuid references public.restaurantes (id) on delete set null,
  n              int  not null default 0,
  primary key (dia, codigo)
);
create index if not exists leituras_dia_rest_idx on public.leituras_dia (restaurante_id, dia);
alter table public.leituras_dia enable row level security;
revoke all on public.leituras_dia from anon;
drop policy if exists "operador ve leituras" on public.leituras_dia;
create policy "operador ve leituras" on public.leituras_dia
  for select to authenticated using (public.eh_operador());

create table if not exists public.tentativas_ativacao (
  codigo text not null,
  em     timestamptz not null default now()
);
create index if not exists tentativas_ativacao_idx on public.tentativas_ativacao (codigo, em);
alter table public.tentativas_ativacao enable row level security;
revoke all on public.tentativas_ativacao from anon, authenticated;

-- A cada toque/leitura de QR (sem login). Devolve só o subdomínio do dono.
create or replace function public.resolver_etiqueta(p_codigo text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e public.etiquetas; r public.restaurantes;
begin
  select * into e from public.etiquetas where codigo = upper(btrim(p_codigo));
  if not found then return jsonb_build_object('status', 'inexistente'); end if;
  update public.etiquetas set leituras = leituras + 1, ultima_leitura = now() where codigo = e.codigo;
  insert into public.leituras_dia (dia, codigo, restaurante_id, n)
  values ((now() at time zone 'America/Sao_Paulo')::date, e.codigo, e.restaurante_id, 1)
  on conflict (dia, codigo) do update set n = public.leituras_dia.n + 1, restaurante_id = excluded.restaurante_id;
  if e.restaurante_id is null then return jsonb_build_object('status', 'livre'); end if;
  select * into r from public.restaurantes where id = e.restaurante_id;
  if not found or not r.ativo then return jsonb_build_object('status', 'inativo'); end if;
  return jsonb_build_object('status', 'ok', 'slug', r.slug);
end $$;

-- Plaquinha nova + código de ativação = plaquinha do restaurante.
-- Status: ok | codigo_incorreto | bloqueado | inexistente | inativo.
-- Devolve status em vez de lançar erro: um erro desfaria o registro da tentativa.
create or replace function public.ativar_etiqueta(p_codigo text, p_ativacao text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_cod text := upper(regexp_replace(coalesce(p_codigo, ''), '[^A-Za-z0-9]', '', 'g'));
  v_atv text := upper(regexp_replace(coalesce(p_ativacao, ''), '[^A-Za-z0-9]', '', 'g'));
  e public.etiquetas; r public.restaurantes;
begin
  select * into e from public.etiquetas where codigo = v_cod;
  if not found then return jsonb_build_object('status', 'inexistente'); end if;
  if e.restaurante_id is not null then
    select * into r from public.restaurantes where id = e.restaurante_id;
    if not found or not r.ativo then return jsonb_build_object('status', 'inativo'); end if;
    return jsonb_build_object('status', 'ok', 'slug', r.slug, 'restaurante', r.nome, 'ja_ativada', true);
  end if;
  delete from public.tentativas_ativacao where em < now() - interval '1 day';
  if (select count(*) from public.tentativas_ativacao where codigo = v_cod and em > now() - interval '10 minutes') >= 8 then
    return jsonb_build_object('status', 'bloqueado');
  end if;
  select * into r from public.restaurantes where codigo_ativacao = v_atv and ativo;
  if not found then
    insert into public.tentativas_ativacao (codigo) values (v_cod);
    return jsonb_build_object('status', 'codigo_incorreto');
  end if;
  update public.etiquetas set restaurante_id = r.id, ativada_em = now(), mesa = null
   where codigo = v_cod and restaurante_id is null;
  return jsonb_build_object('status', 'ok', 'slug', r.slug, 'restaurante', r.nome, 'ja_ativada', false);
end $$;

-- Página da mesa: qual mesa é esta plaquinha, neste restaurante.
create or replace function public.mesa_da_etiqueta(p_restaurante uuid, p_codigo text) returns int
language sql stable security definer set search_path = public as $$
  select mesa from public.etiquetas where codigo = upper(btrim(p_codigo)) and restaurante_id = p_restaurante;
$$;

-- Equipe liga a plaquinha a uma mesa. Plaquinha sem dono digitada pelo código
-- passa a ser deste restaurante.
create or replace function public.etiqueta_vincular(p_codigo text, p_mesa int) returns void
language plpgsql security definer set search_path = public as $$
declare
  r uuid := public.meu_restaurante();
  v_cod text := upper(regexp_replace(coalesce(p_codigo, ''), '[^A-Za-z0-9]', '', 'g'));
  e public.etiquetas;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  if p_mesa is null or p_mesa < 1 or p_mesa > public.total_mesas(r) then raise exception 'Mesa inválida.'; end if;
  select * into e from public.etiquetas where codigo = v_cod for update;
  if not found then raise exception 'Plaquinha não encontrada. Confira o código.'; end if;
  if e.restaurante_id is not null and e.restaurante_id <> r then raise exception 'Esta plaquinha é de outro restaurante.'; end if;
  update public.etiquetas
     set restaurante_id = r, ativada_em = coalesce(ativada_em, now()), mesa = p_mesa, vinculada_em = now(),
         vinculada_por = (select nome from public.equipe_membros where user_id = auth.uid())
   where codigo = v_cod;
end $$;

create or replace function public.etiqueta_desvincular(p_codigo text) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante();
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  update public.etiquetas set mesa = null, vinculada_em = null, vinculada_por = null
   where codigo = upper(btrim(p_codigo)) and restaurante_id = r;
end $$;

-- ---------------------------------------------------------------------------
-- Chamados, comentários e o sino liberado pela equipe
-- ---------------------------------------------------------------------------
create table if not exists public.chamados (
  id             uuid primary key default gen_random_uuid(),
  restaurante_id uuid not null references public.restaurantes (id) on delete cascade,
  mesa           int  not null check (mesa between 1 and 500),
  tipo           text not null check (tipo in ('atendimento', 'pedido', 'conta', 'agua', 'outro')),
  nota           text check (char_length(nota) <= 80),
  pagamento      text check (char_length(pagamento) <= 20),
  itens          jsonb check (itens is null or (jsonb_typeof(itens) = 'array' and jsonb_array_length(itens) <= 40)),
  status         text not null default 'aberto' check (status in ('aberto', 'a_caminho', 'resolvido', 'cancelado')),
  atendente      text check (char_length(atendente) <= 60),
  sessao_id      uuid,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now(),
  visto_em       timestamptz,
  resolvido_em   timestamptz
);
create index if not exists chamados_rest_criado_idx on public.chamados (restaurante_id, criado_em desc);
create index if not exists chamados_rest_mesa_idx on public.chamados (restaurante_id, mesa, criado_em desc);

create table if not exists public.comentarios (
  id             uuid primary key default gen_random_uuid(),
  restaurante_id uuid not null references public.restaurantes (id) on delete cascade,
  estrelas       int  not null check (estrelas between 1 and 5),
  tags           text[] not null default '{}' check (coalesce(array_length(tags, 1), 0) <= 10),
  texto          text check (char_length(texto) <= 500),
  mesa           int check (mesa between 1 and 500),
  lido           boolean not null default false,
  criado_em      timestamptz not null default now()
);
create index if not exists comentarios_rest_criado_idx on public.comentarios (restaurante_id, criado_em desc);

create table if not exists public.sessoes (
  id             uuid primary key default gen_random_uuid(),
  restaurante_id uuid not null references public.restaurantes (id) on delete cascade,
  token_hash     text not null unique,
  mesa           int  not null check (mesa between 1 and 500),
  nome           text not null check (char_length(nome) between 1 and 40),
  status         text not null default 'pendente' check (status in ('pendente', 'liberada', 'recusada', 'encerrada')),
  via            text check (via in ('equipe', 'codigo')),
  liberada_por   text check (char_length(liberada_por) <= 60),
  criado_em      timestamptz not null default now(),
  liberada_em    timestamptz,
  encerrada_em   timestamptz
);
create index if not exists sessoes_rest_mesa_idx on public.sessoes (restaurante_id, mesa, status);
create index if not exists sessoes_criado_idx on public.sessoes (criado_em desc);

create table if not exists public.mesas_abertas (
  restaurante_id uuid not null references public.restaurantes (id) on delete cascade,
  mesa           int  not null check (mesa between 1 and 500),
  codigo         text not null check (codigo ~ '^[0-9]{4}$'),
  aberta_em      timestamptz not null default now(),
  primary key (restaurante_id, mesa)
);

create or replace function public.toca_atualizado_em() returns trigger
language plpgsql set search_path = public as $$
begin
  new.atualizado_em := now();
  return new;
end $$;
drop trigger if exists chamados_atualizado_em on public.chamados;
create trigger chamados_atualizado_em before update on public.chamados
  for each row execute function public.toca_atualizado_em();

-- Freio contra spam: no máximo 5 chamados por mesa a cada 2 minutos.
create or replace function public.limita_chamados() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.chamados
      where restaurante_id = new.restaurante_id and mesa = new.mesa and criado_em > now() - interval '2 minutes') >= 5 then
    raise exception 'Muitos chamados desta mesa. Aguarde um instante.';
  end if;
  return new;
end $$;
drop trigger if exists chamados_limite on public.chamados;
create trigger chamados_limite before insert on public.chamados
  for each row execute function public.limita_chamados();

create or replace function public.hash_token(p_token uuid) returns text
language sql immutable set search_path = public as $$
  select encode(extensions.digest(p_token::text, 'sha256'), 'hex');
$$;

-- Sessões vencidas: liberada há mais de 6 h ou pendente há mais de 30 min.
create or replace function public.expira_sessoes() returns void
language sql security definer set search_path = public as $$
  update public.sessoes set status = 'encerrada', encerrada_em = now()
   where (status = 'liberada' and liberada_em < now() - interval '6 hours')
      or (status = 'pendente' and criado_em < now() - interval '30 minutes');
  delete from public.mesas_abertas m
   where not exists (select 1 from public.sessoes s
                     where s.restaurante_id = m.restaurante_id and s.mesa = m.mesa and s.status = 'liberada');
$$;

create or replace function public.codigo_da_mesa(p_restaurante uuid, p_mesa int) returns text
language plpgsql security definer set search_path = public as $$
declare c text; b bytea;
begin
  select codigo into c from public.mesas_abertas where restaurante_id = p_restaurante and mesa = p_mesa;
  if c is null then
    b := extensions.gen_random_bytes(2);
    c := lpad((((get_byte(b, 0) << 8) | get_byte(b, 1)) % 10000)::text, 4, '0');
    insert into public.mesas_abertas (restaurante_id, mesa, codigo) values (p_restaurante, p_mesa, c)
    on conflict (restaurante_id, mesa) do nothing;
    select codigo into c from public.mesas_abertas where restaurante_id = p_restaurante and mesa = p_mesa;
  end if;
  return c;
end $$;

create or replace function public.sessao_status(p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.sessoes;
begin
  perform public.expira_sessoes();
  select * into s from public.sessoes where token_hash = public.hash_token(p_token);
  if not found then return jsonb_build_object('status', 'inexistente'); end if;
  return jsonb_build_object(
    'status', s.status, 'mesa', s.mesa, 'nome', s.nome, 'restaurante_id', s.restaurante_id,
    'codigo', case when s.status = 'liberada' then
      (select codigo from public.mesas_abertas where restaurante_id = s.restaurante_id and mesa = s.mesa) end);
end $$;

-- Cliente pede para usar o sino. Com o código da mesa, já sai liberado.
create or replace function public.sessao_abrir(p_restaurante uuid, p_mesa int, p_nome text, p_codigo text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_nome  text := left(btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')), 40);
  v_cod   text := nullif(btrim(coalesce(p_codigo, '')), '');
  v_token uuid := gen_random_uuid();
  v_real  text;
begin
  perform public.expira_sessoes();
  if not public.restaurante_ativo(p_restaurante) then raise exception 'Restaurante indisponível.'; end if;
  if p_mesa is null or p_mesa < 1 or p_mesa > public.total_mesas(p_restaurante) then
    raise exception 'Mesa inválida.';
  end if;
  if v_nome = '' then raise exception 'Informe seu nome.'; end if;
  if (select count(*) from public.sessoes where restaurante_id = p_restaurante and mesa = p_mesa
      and criado_em > now() - interval '10 minutes') >= 12 then
    raise exception 'Muitos pedidos nesta mesa agora. Chame o garçom com um aceno.';
  end if;

  if v_cod is not null then
    if not public.equipe_pode_tentar('codigo-mesa:' || p_restaurante || ':' || p_mesa, 6, 10) then
      raise exception 'Muitas tentativas de código. Peça ao garçom para liberar.';
    end if;
    select codigo into v_real from public.mesas_abertas where restaurante_id = p_restaurante and mesa = p_mesa;
    if v_real is null or v_real <> v_cod then raise exception 'Código da mesa incorreto.'; end if;
    insert into public.sessoes (restaurante_id, token_hash, mesa, nome, status, via, liberada_em)
    values (p_restaurante, public.hash_token(v_token), p_mesa, v_nome, 'liberada', 'codigo', now());
  else
    if (select count(*) from public.sessoes where restaurante_id = p_restaurante and mesa = p_mesa and status = 'pendente') >= 4 then
      raise exception 'Já há pedidos aguardando nesta mesa. Aguarde o garçom.';
    end if;
    insert into public.sessoes (restaurante_id, token_hash, mesa, nome)
    values (p_restaurante, public.hash_token(v_token), p_mesa, v_nome);
  end if;
  return public.sessao_status(v_token) || jsonb_build_object('token', v_token);
end $$;

create or replace function public.sessao_sair(p_token uuid) returns void
language sql security definer set search_path = public as $$
  update public.sessoes set status = 'encerrada', encerrada_em = now()
   where token_hash = public.hash_token(p_token) and status in ('pendente', 'liberada');
$$;

-- Chamar o garçom: só com o sino liberado. Mesa e restaurante vêm da sessão.
create or replace function public.chamar(p_token uuid, p_tipo text, p_nota text default null,
  p_pagamento text default null, p_itens jsonb default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare s public.sessoes; v_id uuid;
begin
  perform public.expira_sessoes();
  select * into s from public.sessoes where token_hash = public.hash_token(p_token) and status = 'liberada';
  if not found then
    raise exception using errcode = 'VT401', message = 'O sino não está liberado para este celular.';
  end if;
  insert into public.chamados (restaurante_id, mesa, tipo, nota, pagamento, itens, sessao_id)
  values (s.restaurante_id, s.mesa, p_tipo, nullif(left(btrim(coalesce(p_nota, '')), 80), ''), p_pagamento, p_itens, s.id)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.chamado_cancelar(p_token uuid, p_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.chamados set status = 'cancelado'
   where id = p_id and status = 'aberto'
     and sessao_id = (select id from public.sessoes where token_hash = public.hash_token(p_token));
$$;

-- Equipe: liberar ou recusar um celular, e fechar a mesa.
create or replace function public.sessao_decidir(p_id uuid, p_liberar boolean) returns void
language plpgsql security definer set search_path = public as $$
declare s public.sessoes; r uuid := public.meu_restaurante();
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  update public.sessoes
     set status = case when p_liberar then 'liberada' else 'recusada' end,
         via = case when p_liberar then 'equipe' end,
         liberada_em = case when p_liberar then now() end,
         liberada_por = (select nome from public.equipe_membros where user_id = auth.uid())
   where id = p_id and status = 'pendente' and restaurante_id = r
  returning * into s;
  if found and p_liberar then perform public.codigo_da_mesa(r, s.mesa); end if;
end $$;

create or replace function public.mesa_fechar(p_mesa int) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante();
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  update public.sessoes set status = 'encerrada', encerrada_em = now()
   where restaurante_id = r and mesa = p_mesa and status in ('pendente', 'liberada');
  delete from public.mesas_abertas where restaurante_id = r and mesa = p_mesa;
end $$;

-- ---------------------------------------------------------------------------
-- Regras de acesso (RLS)
--   anon   = cliente na mesa (sem login): só pelas funções acima e o que segue
--   equipe = logado e em equipe_membros: só o próprio restaurante
-- ---------------------------------------------------------------------------
alter table public.chamados enable row level security;
alter table public.comentarios enable row level security;
alter table public.sessoes enable row level security;
alter table public.mesas_abertas enable row level security;

revoke insert, update, delete on public.chamados from anon;
grant select on public.chamados to anon;
revoke all on public.comentarios from anon;
grant insert (restaurante_id, estrelas, tags, texto, mesa) on public.comentarios to anon;
revoke all on public.sessoes from anon;
revoke all on public.mesas_abertas from anon;

-- Necessário para o cliente acompanhar o status do chamado em tempo real.
drop policy if exists "cliente acompanha chamados recentes" on public.chamados;
create policy "cliente acompanha chamados recentes" on public.chamados
  for select to anon using (criado_em > now() - interval '3 hours');

drop policy if exists "equipe gerencia chamados" on public.chamados;
create policy "equipe gerencia chamados" on public.chamados
  for all to authenticated using (restaurante_id = public.meu_restaurante())
  with check (restaurante_id = public.meu_restaurante());

drop policy if exists "cliente envia comentario" on public.comentarios;
create policy "cliente envia comentario" on public.comentarios
  for insert to anon with check (public.restaurante_ativo(restaurante_id));

drop policy if exists "equipe le comentarios" on public.comentarios;
create policy "equipe le comentarios" on public.comentarios
  for select to authenticated using (restaurante_id = public.meu_restaurante());

drop policy if exists "equipe marca comentarios" on public.comentarios;
create policy "equipe marca comentarios" on public.comentarios
  for update to authenticated using (restaurante_id = public.meu_restaurante())
  with check (restaurante_id = public.meu_restaurante());

drop policy if exists "equipe ve sessoes" on public.sessoes;
create policy "equipe ve sessoes" on public.sessoes
  for select to authenticated using (restaurante_id = public.meu_restaurante());

drop policy if exists "equipe ve mesas abertas" on public.mesas_abertas;
create policy "equipe ve mesas abertas" on public.mesas_abertas
  for select to authenticated using (restaurante_id = public.meu_restaurante());

-- ---------------------------------------------------------------------------
-- Central (operadores): criar restaurante, gerar lote, atribuir, métricas.
-- ---------------------------------------------------------------------------
create or replace function public.criar_restaurante(p_nome text, p_slug text, p_senha_equipe text) returns public.restaurantes
language plpgsql security definer set search_path = public as $$
declare r public.restaurantes;
begin
  if not public.eh_operador() then raise exception 'Acesso negado.'; end if;
  if char_length(coalesce(p_senha_equipe, '')) < 6 then raise exception 'A senha da equipe precisa ter pelo menos 6 caracteres.'; end if;
  begin
    insert into public.restaurantes (nome, slug) values (btrim(p_nome), lower(btrim(p_slug))) returning * into r;
  exception
    when unique_violation then raise exception 'Esse subdomínio já está em uso. Escolha outro.';
    when check_violation then raise exception 'Subdomínio inválido: use letras minúsculas, números e hífen (sem acento nem espaço).';
  end;
  perform public.equipe_trocar_senha(r.id, p_senha_equipe);
  return r;
end $$;

create or replace function public.central_senha_equipe(p_restaurante uuid, p_senha text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.eh_operador() then raise exception 'Acesso negado.'; end if;
  if char_length(coalesce(p_senha, '')) < 6 then raise exception 'A senha da equipe precisa ter pelo menos 6 caracteres.'; end if;
  perform public.equipe_trocar_senha(p_restaurante, p_senha);
end $$;

create or replace function public.trocar_codigo_ativacao(p_restaurante uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not public.eh_operador() then raise exception 'Acesso negado.'; end if;
  loop
    c := public.novo_codigo(8);
    begin
      update public.restaurantes set codigo_ativacao = c where id = p_restaurante;
      return c;
    exception when unique_violation then
      -- raríssimo: sorteia de novo
    end;
  end loop;
end $$;

-- Códigos de 7 caracteres; a chave primária garante que nunca repetem.
create or replace function public.gerar_etiquetas(p_qtd int, p_lote text) returns setof text
language plpgsql security definer set search_path = public as $$
declare c text; feitos int := 0; tentativas int := 0;
begin
  if not public.eh_operador() then raise exception 'Acesso negado.'; end if;
  if p_qtd is null or p_qtd < 1 or p_qtd > 2000 then raise exception 'Gere de 1 a 2000 plaquinhas por vez.'; end if;
  while feitos < p_qtd and tentativas < p_qtd * 5 loop
    tentativas := tentativas + 1;
    c := public.novo_codigo(7);
    insert into public.etiquetas (codigo, lote) values (c, left(btrim(coalesce(p_lote, '')), 40))
    on conflict (codigo) do nothing;
    if found then
      feitos := feitos + 1;
      return next c;
    end if;
  end loop;
end $$;

create or replace function public.atribuir_etiquetas(p_codigos text[], p_restaurante uuid) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.eh_operador() then raise exception 'Acesso negado.'; end if;
  update public.etiquetas
     set restaurante_id = p_restaurante,
         ativada_em = case when p_restaurante is null then null else now() end,
         mesa = null, vinculada_em = null, vinculada_por = null
   where codigo = any (p_codigos);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.marcar_gravadas(p_codigos text[], p_gravada boolean) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.eh_operador() then raise exception 'Acesso negado.'; end if;
  update public.etiquetas set gravada = p_gravada where codigo = any (p_codigos);
  get diagnostics n = row_count;
  return n;
end $$;

-- Métricas: leituras por dia e por restaurante, chamados e tempo de resposta,
-- com a comparação contra o período anterior de mesmo tamanho.
create or replace function public.metricas(p_dias int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  ini  date;
  ant  date;
  t_ini timestamptz;
begin
  if not public.eh_operador() then raise exception 'Acesso negado.'; end if;
  p_dias := least(greatest(coalesce(p_dias, 30), 1), 365);
  ini := hoje - (p_dias - 1);
  ant := ini - p_dias;
  t_ini := ini::timestamp at time zone 'America/Sao_Paulo';
  return jsonb_build_object(
    'hoje', hoje,
    'por_dia', coalesce((
      select jsonb_agg(jsonb_build_object('dia', d::date, 'n', coalesce(x.n, 0)) order by d)
        from generate_series(ini, hoje, interval '1 day') d
        left join (select dia, sum(n)::int n from public.leituras_dia where dia >= ini group by dia) x on x.dia = d::date
    ), '[]'::jsonb),
    'por_restaurante', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', r.id, 'nome', r.nome, 'slug', r.slug, 'ativo', r.ativo,
          'n', coalesce(a.n, 0), 'anterior', coalesce(b.n, 0),
          'etiquetas', (select count(*) from public.etiquetas e where e.restaurante_id = r.id),
          'lidas', coalesce(a.lidas, 0),
          'nunca_lidas', (select count(*) from public.etiquetas e where e.restaurante_id = r.id and e.leituras = 0),
          'ultima', (select max(e.ultima_leitura) from public.etiquetas e where e.restaurante_id = r.id),
          'chamados', coalesce(c.n, 0),
          'resposta_s', c.resp
        ) order by coalesce(a.n, 0) desc, r.nome)
        from public.restaurantes r
        left join (select restaurante_id, sum(n)::int n, count(distinct codigo)::int lidas
                     from public.leituras_dia where dia >= ini group by restaurante_id) a on a.restaurante_id = r.id
        left join (select restaurante_id, sum(n)::int n
                     from public.leituras_dia where dia >= ant and dia < ini group by restaurante_id) b on b.restaurante_id = r.id
        left join (select restaurante_id, count(*)::int n,
                          round(avg(extract(epoch from (visto_em - criado_em))) filter (where visto_em is not null))::int resp
                     from public.chamados where criado_em >= t_ini group by restaurante_id) c on c.restaurante_id = r.id
    ), '[]'::jsonb),
    'total', (select coalesce(sum(n), 0)::int from public.leituras_dia where dia >= ini),
    'total_anterior', (select coalesce(sum(n), 0)::int from public.leituras_dia where dia >= ant and dia < ini),
    'chamados', (select count(*)::int from public.chamados where criado_em >= t_ini)
  );
end $$;

-- ---------------------------------------------------------------------------
-- Quem pode chamar cada função
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  -- Internas: nem o navegador nem a equipe chamam direto.
  foreach f in array array[
    'public.novo_codigo(int)', 'public.total_mesas(uuid)', 'public.hash_token(uuid)',
    'public.expira_sessoes()', 'public.codigo_da_mesa(uuid, int)', 'public.toca_atualizado_em()',
    'public.limita_chamados()'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
  -- Só a função "equipe" (service_role).
  foreach f in array array[
    'public.equipe_pin_hmac(uuid, text)', 'public.equipe_conferir_senha(uuid, text)',
    'public.equipe_trocar_senha(uuid, text)', 'public.equipe_pode_tentar(text, int, int)',
    'public.equipe_limpar_tentativas(text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  -- Cliente na mesa e redirecionador (sem login). restaurante_ativo é usada
  -- na regra de acesso dos comentários, que roda como o cliente.
  foreach f in array array[
    'public.restaurante_ativo(uuid)',
    'public.restaurante_publico(text)', 'public.resolver_etiqueta(text)', 'public.ativar_etiqueta(text, text)',
    'public.mesa_da_etiqueta(uuid, text)', 'public.sessao_status(uuid)', 'public.sessao_abrir(uuid, int, text, text)',
    'public.sessao_sair(uuid)', 'public.chamar(uuid, text, text, text, jsonb)', 'public.chamado_cancelar(uuid, uuid)'] loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
  -- Logados (cada função confere se é equipe ou operador).
  foreach f in array array[
    'public.salvar_config(jsonb)', 'public.etiqueta_vincular(text, int)', 'public.etiqueta_desvincular(text)',
    'public.sessao_decidir(uuid, boolean)', 'public.mesa_fechar(int)',
    'public.criar_restaurante(text, text, text)', 'public.central_senha_equipe(uuid, text)',
    'public.trocar_codigo_ativacao(uuid)', 'public.gerar_etiquetas(int, text)',
    'public.atribuir_etiquetas(text[], uuid)', 'public.marcar_gravadas(text[], boolean)', 'public.metricas(int)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Imagens da marca (logo e capa): leitura pública; cada restaurante envia na
-- própria pasta (<restaurante_id>/arquivo).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('marca', 'marca', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true;

drop policy if exists "equipe ve imagens da marca" on storage.objects;
create policy "equipe ve imagens da marca" on storage.objects
  for select to authenticated using (bucket_id = 'marca' and (storage.foldername(name))[1] = public.meu_restaurante()::text);
drop policy if exists "equipe envia imagens da marca" on storage.objects;
create policy "equipe envia imagens da marca" on storage.objects
  for insert to authenticated with check (bucket_id = 'marca' and (storage.foldername(name))[1] = public.meu_restaurante()::text);
drop policy if exists "equipe troca imagens da marca" on storage.objects;
create policy "equipe troca imagens da marca" on storage.objects
  for update to authenticated using (bucket_id = 'marca' and (storage.foldername(name))[1] = public.meu_restaurante()::text);
drop policy if exists "equipe apaga imagens da marca" on storage.objects;
create policy "equipe apaga imagens da marca" on storage.objects
  for delete to authenticated using (bucket_id = 'marca' and (storage.foldername(name))[1] = public.meu_restaurante()::text);

-- ---------------------------------------------------------------------------
-- Tempo real
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['chamados', 'comentarios', 'sessoes', 'mesas_abertas', 'etiquetas'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
