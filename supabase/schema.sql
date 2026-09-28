-- ============================================================================
-- Plataforma NFC para restaurantes — esquema do Supabase
-- Cole no SQL Editor do projeto e execute uma vez.
-- ============================================================================

create extension if not exists pgcrypto;

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

-- ---------------------------------------------------------------------------
-- Segurança (RLS)
--   anon          = cliente na mesa (sem login)
--   authenticated = equipe (usuários criados manualmente no painel do Supabase)
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
  for all to authenticated using (true) with check (true);

drop policy if exists "cliente envia comentario" on public.comentarios;
create policy "cliente envia comentario" on public.comentarios
  for insert to anon with check (true);

drop policy if exists "equipe le comentarios" on public.comentarios;
create policy "equipe le comentarios" on public.comentarios
  for select to authenticated using (true);

drop policy if exists "equipe marca comentarios" on public.comentarios;
create policy "equipe marca comentarios" on public.comentarios
  for update to authenticated using (true) with check (true);

-- Mesa (cliente) só lê; só a equipe cria e edita quantidade de mesas e widgets.
drop policy if exists "cliente le configuracao" on public.configuracao;
create policy "cliente le configuracao" on public.configuracao
  for select to anon using (true);

drop policy if exists "equipe gerencia configuracao" on public.configuracao;
create policy "equipe gerencia configuracao" on public.configuracao
  for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Imagens da marca (logo e foto de capa): leitura pública, envio só pela equipe.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('marca', 'marca', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true;

drop policy if exists "equipe envia imagens da marca" on storage.objects;
create policy "equipe envia imagens da marca" on storage.objects
  for insert to authenticated with check (bucket_id = 'marca');

drop policy if exists "equipe troca imagens da marca" on storage.objects;
create policy "equipe troca imagens da marca" on storage.objects
  for update to authenticated using (bucket_id = 'marca');

drop policy if exists "equipe apaga imagens da marca" on storage.objects;
create policy "equipe apaga imagens da marca" on storage.objects
  for delete to authenticated using (bucket_id = 'marca');

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
