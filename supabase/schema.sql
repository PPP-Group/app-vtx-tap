-- ============================================================================
-- Plataforma NFC para restaurantes — esquema do Supabase
-- Cole no SQL Editor do projeto e execute. Pode rodar de novo a cada atualização.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Chamados das mesas
-- ---------------------------------------------------------------------------
create table if not exists public.chamados (
  id            uuid primary key default gen_random_uuid(),
  mesa          int  not null check (mesa between 1 and 500),
  tipo          text not null check (tipo in ('atendimento', 'pedido', 'conta', 'agua', 'outro')),
  nota          text check (char_length(nota) <= 80),
  pagamento     text check (char_length(pagamento) <= 20),
  itens         jsonb check (itens is null or (jsonb_typeof(itens) = 'array' and jsonb_array_length(itens) <= 40)),
  status        text not null default 'aberto' check (status in ('aberto', 'a_caminho', 'resolvido', 'cancelado')),
  atendente     text check (char_length(atendente) <= 60),
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  visto_em      timestamptz,
  resolvido_em  timestamptz
);
create index if not exists chamados_criado_em_idx on public.chamados (criado_em desc);
create index if not exists chamados_mesa_idx on public.chamados (mesa, criado_em desc);

-- ---------------------------------------------------------------------------
-- Comentários anônimos
-- ---------------------------------------------------------------------------
create table if not exists public.comentarios (
  id        uuid primary key default gen_random_uuid(),
  estrelas  int  not null check (estrelas between 1 and 5),
  tags      text[] not null default '{}' check (coalesce(array_length(tags, 1), 0) <= 10),
  texto     text check (char_length(texto) <= 500),
  mesa      int check (mesa between 1 and 500),
  lido      boolean not null default false,
  criado_em timestamptz not null default now()
);
create index if not exists comentarios_criado_em_idx on public.comentarios (criado_em desc);

-- ---------------------------------------------------------------------------
-- Configuração do restaurante, editada pelo painel: dados da loja, Wi-Fi,
-- cardápio, mesas e widgets. Uma única linha, id fixo 'geral'.
-- Colunas vazias usam os valores iniciais de demonstração.
-- ---------------------------------------------------------------------------
create table if not exists public.configuracao (
  id text primary key default 'geral'
);
alter table public.configuracao add column if not exists restaurante jsonb;
alter table public.configuracao add column if not exists wifi        jsonb;
alter table public.configuracao add column if not exists cardapio    jsonb;
alter table public.configuracao add column if not exists mesas       jsonb;
alter table public.configuracao add column if not exists widgets     jsonb;
alter table public.configuracao alter column mesas drop not null;
alter table public.configuracao alter column widgets drop not null;
alter table public.configuracao alter column mesas drop default;
alter table public.configuracao alter column widgets drop default;

-- ---------------------------------------------------------------------------
-- Gatilhos
-- ---------------------------------------------------------------------------
create or replace function public.toca_atualizado_em() returns trigger
language plpgsql as $$
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
      where mesa = new.mesa and criado_em > now() - interval '2 minutes') >= 5 then
    raise exception 'Muitos chamados desta mesa. Aguarde um instante.';
  end if;
  return new;
end $$;

drop trigger if exists chamados_limite on public.chamados;
create trigger chamados_limite before insert on public.chamados
  for each row execute function public.limita_chamados();

-- Funções de gatilho não ficam expostas na API (/rest/v1/rpc).
alter function public.toca_atualizado_em() set search_path = public;
revoke execute on function public.toca_atualizado_em() from public, anon, authenticated;
revoke execute on function public.limita_chamados() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Equipe: cada pessoa entra com um PIN próprio. Criar conta exige a senha
-- da equipe. Cadastro e login passam pela função "equipe" (Edge Function),
-- que usa as funções abaixo; nada disso fica exposto para o navegador.
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists private.segredo (
  id     int primary key default 1 check (id = 1),
  pepper text not null default encode(extensions.gen_random_bytes(32), 'hex')
);
insert into private.segredo (id) values (1) on conflict (id) do nothing;

create table if not exists private.equipe_config (
  id         int primary key default 1 check (id = 1),
  senha_hash text
);

create table if not exists private.tentativas (
  chave text not null,
  em    timestamptz not null default now()
);
create index if not exists tentativas_chave_em_idx on private.tentativas (chave, em);

create table if not exists public.equipe_membros (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null unique references auth.users (id) on delete cascade,
  nome      text not null check (char_length(nome) between 1 and 60),
  pin_hmac  text not null unique,
  criado_em timestamptz not null default now()
);
alter table public.equipe_membros enable row level security;
revoke all on public.equipe_membros from anon, authenticated;

-- Quem está logado e faz parte da equipe (usado nas regras de acesso).
create or replace function public.eh_equipe() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.equipe_membros where user_id = auth.uid());
$$;
revoke execute on function public.eh_equipe() from public, anon;
grant execute on function public.eh_equipe() to authenticated;

grant select (id, nome, criado_em) on public.equipe_membros to authenticated;
drop policy if exists "equipe ve a equipe" on public.equipe_membros;
create policy "equipe ve a equipe" on public.equipe_membros
  for select to authenticated using (public.eh_equipe());

create or replace function public.equipe_pin_hmac(p_pin text) returns text
language sql stable security definer set search_path = public as $$
  select encode(extensions.hmac(p_pin, (select pepper from private.segredo where id = 1), 'sha256'), 'hex');
$$;

-- 'ok' | 'errada' | 'definida' (primeira conta: a senha digitada vira a senha da equipe)
create or replace function public.equipe_conferir_senha(p_senha text) returns text
language plpgsql security definer set search_path = public as $$
declare h text;
begin
  select senha_hash into h from private.equipe_config where id = 1 for update;
  if h is null then
    insert into private.equipe_config (id, senha_hash)
    values (1, extensions.crypt(p_senha, extensions.gen_salt('bf')))
    on conflict (id) do update set senha_hash = excluded.senha_hash;
    return 'definida';
  end if;
  return case when extensions.crypt(p_senha, h) = h then 'ok' else 'errada' end;
end $$;

create or replace function public.equipe_tem_senha() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from private.equipe_config where id = 1 and senha_hash is not null);
$$;

create or replace function public.equipe_trocar_senha(p_senha text) returns void
language sql security definer set search_path = public as $$
  insert into private.equipe_config (id, senha_hash)
  values (1, extensions.crypt(p_senha, extensions.gen_salt('bf')))
  on conflict (id) do update set senha_hash = excluded.senha_hash;
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

revoke execute on function public.equipe_pin_hmac(text) from public, anon, authenticated;
revoke execute on function public.equipe_conferir_senha(text) from public, anon, authenticated;
revoke execute on function public.equipe_tem_senha() from public, anon, authenticated;
revoke execute on function public.equipe_trocar_senha(text) from public, anon, authenticated;
revoke execute on function public.equipe_pode_tentar(text, int, int) from public, anon, authenticated;
revoke execute on function public.equipe_limpar_tentativas(text) from public, anon, authenticated;
grant execute on function public.equipe_pin_hmac(text) to service_role;
grant execute on function public.equipe_conferir_senha(text) to service_role;
grant execute on function public.equipe_tem_senha() to service_role;
grant execute on function public.equipe_trocar_senha(text) to service_role;
grant execute on function public.equipe_pode_tentar(text, int, int) to service_role;
grant execute on function public.equipe_limpar_tentativas(text) to service_role;

-- ---------------------------------------------------------------------------
-- Segurança (RLS)
--   anon          = cliente na mesa (sem login)
--   equipe        = usuário logado que está em equipe_membros (public.eh_equipe())
-- ---------------------------------------------------------------------------
alter table public.chamados enable row level security;
alter table public.comentarios enable row level security;
alter table public.configuracao enable row level security;

-- O cliente só escreve as colunas que fazem sentido para ele.
revoke insert, update, delete on public.chamados from anon;
grant insert (id, mesa, tipo, nota, pagamento, itens) on public.chamados to anon;
grant update (status) on public.chamados to anon;
grant select on public.chamados to anon;

revoke insert, update, delete, select on public.comentarios from anon;
grant insert (estrelas, tags, texto, mesa) on public.comentarios to anon;

drop policy if exists "cliente cria chamado" on public.chamados;
create policy "cliente cria chamado" on public.chamados
  for insert to anon with check (status = 'aberto');

-- Necessário para o cliente acompanhar o status em tempo real.
drop policy if exists "cliente acompanha chamados recentes" on public.chamados;
create policy "cliente acompanha chamados recentes" on public.chamados
  for select to anon using (criado_em > now() - interval '3 hours');

-- O cliente só pode cancelar um chamado que ainda está aberto.
drop policy if exists "cliente cancela chamado aberto" on public.chamados;
create policy "cliente cancela chamado aberto" on public.chamados
  for update to anon using (status = 'aberto') with check (status = 'cancelado');

drop policy if exists "equipe gerencia chamados" on public.chamados;
create policy "equipe gerencia chamados" on public.chamados
  for all to authenticated using (public.eh_equipe()) with check (public.eh_equipe());

drop policy if exists "cliente envia comentario" on public.comentarios;
create policy "cliente envia comentario" on public.comentarios
  for insert to anon with check (true);

drop policy if exists "equipe le comentarios" on public.comentarios;
create policy "equipe le comentarios" on public.comentarios
  for select to authenticated using (public.eh_equipe());

drop policy if exists "equipe marca comentarios" on public.comentarios;
create policy "equipe marca comentarios" on public.comentarios
  for update to authenticated using (public.eh_equipe()) with check (public.eh_equipe());

-- Mesa (cliente) só lê; só a equipe cria e edita quantidade de mesas e widgets.
drop policy if exists "cliente le configuracao" on public.configuracao;
create policy "cliente le configuracao" on public.configuracao
  for select to anon using (true);

drop policy if exists "equipe gerencia configuracao" on public.configuracao;
create policy "equipe gerencia configuracao" on public.configuracao
  for all to authenticated using (public.eh_equipe()) with check (public.eh_equipe());

-- ---------------------------------------------------------------------------
-- Imagens da marca (logo e foto de capa): leitura pública, envio só pela equipe.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('marca', 'marca', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true;

drop policy if exists "equipe ve imagens da marca" on storage.objects;
create policy "equipe ve imagens da marca" on storage.objects
  for select to authenticated using (bucket_id = 'marca' and public.eh_equipe());

drop policy if exists "equipe envia imagens da marca" on storage.objects;
create policy "equipe envia imagens da marca" on storage.objects
  for insert to authenticated with check (bucket_id = 'marca' and public.eh_equipe());

drop policy if exists "equipe troca imagens da marca" on storage.objects;
create policy "equipe troca imagens da marca" on storage.objects
  for update to authenticated using (bucket_id = 'marca' and public.eh_equipe());

drop policy if exists "equipe apaga imagens da marca" on storage.objects;
create policy "equipe apaga imagens da marca" on storage.objects
  for delete to authenticated using (bucket_id = 'marca' and public.eh_equipe());

-- ---------------------------------------------------------------------------
-- Tempo real
-- ---------------------------------------------------------------------------
-- Pode rodar o arquivo de novo sem erro: só adiciona o que ainda não está publicado.
do $$
declare t text;
begin
  foreach t in array array['chamados', 'comentarios', 'configuracao'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
