-- ============================================================================
-- Central de plaquinhas — esquema do Supabase de VOCÊS (não o do restaurante).
--
-- Guarda só uma coisa: qual plaquinha (código) pertence a qual restaurante
-- (endereço do site dele). Qual mesa cada plaquinha é fica no banco do
-- próprio restaurante. Cole no SQL Editor e execute; pode rodar de novo.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.restaurantes (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null check (char_length(nome) between 1 and 80),
  -- Endereço do site do restaurante. A plaquinha abre destino?tag=CODIGO.
  destino    text not null check (destino ~* '^https?://[^\s]+$'),
  ativo      boolean not null default true,
  observacao text check (char_length(observacao) <= 300),
  criado_em  timestamptz not null default now()
);

create table if not exists public.etiquetas (
  codigo         text primary key check (codigo ~ '^[A-Z0-9]{4,16}$'),
  lote           text not null default '' check (char_length(lote) <= 40),
  restaurante_id uuid references public.restaurantes (id) on delete set null,
  gravada        boolean not null default false,
  criado_em      timestamptz not null default now(),
  vendida_em     timestamptz,
  leituras       int not null default 0,
  ultima_leitura timestamptz
);
create index if not exists etiquetas_restaurante_idx on public.etiquetas (restaurante_id);
create index if not exists etiquetas_lote_idx on public.etiquetas (lote);

-- Quem opera a central (vocês). Crie o usuário em Authentication › Users e
-- depois rode:
--   insert into public.operadores (user_id, nome)
--   select id, 'Seu nome' from auth.users where email = 'voce@empresa.com';
create table if not exists public.operadores (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  nome      text not null default '' check (char_length(nome) <= 60),
  criado_em timestamptz not null default now()
);

create or replace function public.eh_operador() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.operadores where user_id = auth.uid());
$$;
revoke execute on function public.eh_operador() from public, anon;
grant execute on function public.eh_operador() to authenticated;

alter table public.restaurantes enable row level security;
alter table public.etiquetas enable row level security;
alter table public.operadores enable row level security;
revoke all on public.restaurantes from anon;
revoke all on public.etiquetas from anon;
revoke all on public.operadores from anon;

drop policy if exists "operador gerencia restaurantes" on public.restaurantes;
create policy "operador gerencia restaurantes" on public.restaurantes
  for all to authenticated using (public.eh_operador()) with check (public.eh_operador());

drop policy if exists "operador gerencia etiquetas" on public.etiquetas;
create policy "operador gerencia etiquetas" on public.etiquetas
  for all to authenticated using (public.eh_operador()) with check (public.eh_operador());

drop policy if exists "operador ve operadores" on public.operadores;
create policy "operador ve operadores" on public.operadores
  for select to authenticated using (public.eh_operador());

-- ---------------------------------------------------------------------------
-- Redirecionador: chamado a cada toque/leitura de QR, sem login.
-- Devolve só o destino do código informado (não lista nada).
-- ---------------------------------------------------------------------------
create or replace function public.resolver_etiqueta(p_codigo text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e public.etiquetas; r public.restaurantes;
begin
  select * into e from public.etiquetas where codigo = upper(btrim(p_codigo));
  if not found then return jsonb_build_object('status', 'inexistente'); end if;
  update public.etiquetas set leituras = leituras + 1, ultima_leitura = now() where codigo = e.codigo;
  if e.restaurante_id is null then return jsonb_build_object('status', 'livre'); end if;
  select * into r from public.restaurantes where id = e.restaurante_id;
  if not found or not r.ativo then return jsonb_build_object('status', 'inativo'); end if;
  return jsonb_build_object('status', 'ok', 'destino', r.destino);
end $$;
revoke execute on function public.resolver_etiqueta(text) from public;
grant execute on function public.resolver_etiqueta(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Operação: gerar lote, vender (atribuir a um restaurante) e marcar gravadas.
-- Códigos de 7 caracteres sem letras/números que se confundem (0/O, 1/I/L).
-- ---------------------------------------------------------------------------
create or replace function public.gerar_etiquetas(p_qtd int, p_lote text) returns setof text
language plpgsql security definer set search_path = public as $$
declare
  alfabeto constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  b bytea; c text; feitos int := 0; tentativas int := 0;
begin
  if not public.eh_operador() then raise exception 'Acesso negado.'; end if;
  if p_qtd is null or p_qtd < 1 or p_qtd > 2000 then raise exception 'Gere de 1 a 2000 plaquinhas por vez.'; end if;
  while feitos < p_qtd and tentativas < p_qtd * 5 loop
    tentativas := tentativas + 1;
    b := extensions.gen_random_bytes(7);
    c := '';
    for i in 0..6 loop
      c := c || substr(alfabeto, (get_byte(b, i) % 31) + 1, 1);
    end loop;
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
         vendida_em = case when p_restaurante is null then null else now() end
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

revoke execute on function public.gerar_etiquetas(int, text) from public, anon;
revoke execute on function public.atribuir_etiquetas(text[], uuid) from public, anon;
revoke execute on function public.marcar_gravadas(text[], boolean) from public, anon;
grant execute on function public.gerar_etiquetas(int, text) to authenticated;
grant execute on function public.atribuir_etiquetas(text[], uuid) to authenticated;
grant execute on function public.marcar_gravadas(text[], boolean) to authenticated;
