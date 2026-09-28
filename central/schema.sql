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

-- Código de ativação do restaurante: a equipe digita na primeira leitura de
-- uma plaquinha nova, e ela passa a ser daquele restaurante.
-- 8 caracteres sem letras/números que se confundem (0/O, 1/I/L).
create or replace function public.novo_codigo_ativacao() returns text
language plpgsql volatile set search_path = public as $$
declare alfabeto constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; b bytea; c text := '';
begin
  b := extensions.gen_random_bytes(8);
  for i in 0..7 loop
    c := c || substr(alfabeto, (get_byte(b, i) % 31) + 1, 1);
  end loop;
  return c;
end $$;
revoke execute on function public.novo_codigo_ativacao() from public, anon, authenticated;

alter table public.restaurantes add column if not exists codigo_ativacao text;
update public.restaurantes set codigo_ativacao = public.novo_codigo_ativacao() where codigo_ativacao is null;
alter table public.restaurantes alter column codigo_ativacao set default public.novo_codigo_ativacao();
alter table public.restaurantes alter column codigo_ativacao set not null;
create unique index if not exists restaurantes_codigo_ativacao_idx on public.restaurantes (codigo_ativacao);

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

-- Quem opera a central (vocês). Veja os convites logo abaixo.
create table if not exists public.operadores (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  nome      text not null default '' check (char_length(nome) <= 60),
  criado_em timestamptz not null default now()
);

-- Convites: quem for criado em Authentication com um destes e-mails, já
-- confirmado (Add user › Auto Confirm User), vira operador na hora. Quem já
-- existe com o e-mail confirmado é ligado ao rodar este arquivo.
--   insert into public.operadores_convite (email, nome) values ('voce@empresa.com', 'Seu nome');
create table if not exists public.operadores_convite (
  email text primary key check (email = lower(email)),
  nome  text not null default '' check (char_length(nome) <= 60)
);

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

alter table public.restaurantes enable row level security;
alter table public.etiquetas enable row level security;
alter table public.operadores enable row level security;
alter table public.operadores_convite enable row level security;
revoke all on public.restaurantes from anon;
revoke all on public.etiquetas from anon;
revoke all on public.operadores from anon;
revoke all on public.operadores_convite from anon, authenticated;

drop policy if exists "operador gerencia restaurantes" on public.restaurantes;
create policy "operador gerencia restaurantes" on public.restaurantes
  for all to authenticated using (public.eh_operador()) with check (public.eh_operador());

drop policy if exists "operador gerencia etiquetas" on public.etiquetas;
create policy "operador gerencia etiquetas" on public.etiquetas
  for all to authenticated using (public.eh_operador()) with check (public.eh_operador());

drop policy if exists "operador ve operadores" on public.operadores;
create policy "operador ve operadores" on public.operadores
  for select to authenticated using (public.eh_operador());

-- Leituras por dia (horário de Brasília), para as métricas do painel.
-- Guarda o restaurante do momento da leitura: se a plaquinha trocar de dono,
-- o histórico continua com quem ela era.
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
  insert into public.leituras_dia (dia, codigo, restaurante_id, n)
  values ((now() at time zone 'America/Sao_Paulo')::date, e.codigo, e.restaurante_id, 1)
  on conflict (dia, codigo) do update set n = public.leituras_dia.n + 1, restaurante_id = excluded.restaurante_id;
  if e.restaurante_id is null then return jsonb_build_object('status', 'livre'); end if;
  select * into r from public.restaurantes where id = e.restaurante_id;
  if not found or not r.ativo then return jsonb_build_object('status', 'inativo'); end if;
  return jsonb_build_object('status', 'ok', 'destino', r.destino);
end $$;
revoke execute on function public.resolver_etiqueta(text) from public;
grant execute on function public.resolver_etiqueta(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Ativação pela própria equipe: plaquinha nova + código de ativação do
-- restaurante = plaquinha daquele restaurante. Sem login; freio de 8
-- tentativas erradas por plaquinha a cada 10 minutos.
-- Status: ok | codigo_incorreto | bloqueado | inexistente | inativo.
-- ---------------------------------------------------------------------------
create table if not exists public.tentativas_ativacao (
  codigo text not null,
  em     timestamptz not null default now()
);
create index if not exists tentativas_ativacao_idx on public.tentativas_ativacao (codigo, em);
alter table public.tentativas_ativacao enable row level security;
revoke all on public.tentativas_ativacao from anon, authenticated;

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
    return jsonb_build_object('status', 'ok', 'destino', r.destino, 'restaurante', r.nome, 'ja_ativada', true);
  end if;
  delete from public.tentativas_ativacao where em < now() - interval '1 day';
  -- Devolve o status em vez de lançar erro: um erro desfaria o registro da tentativa.
  if (select count(*) from public.tentativas_ativacao where codigo = v_cod and em > now() - interval '10 minutes') >= 8 then
    return jsonb_build_object('status', 'bloqueado');
  end if;
  select * into r from public.restaurantes where codigo_ativacao = v_atv and ativo;
  if not found then
    insert into public.tentativas_ativacao (codigo) values (v_cod);
    return jsonb_build_object('status', 'codigo_incorreto');
  end if;
  update public.etiquetas set restaurante_id = r.id, vendida_em = now()
   where codigo = v_cod and restaurante_id is null;
  return jsonb_build_object('status', 'ok', 'destino', r.destino, 'restaurante', r.nome, 'ja_ativada', false);
end $$;
revoke execute on function public.ativar_etiqueta(text, text) from public;
grant execute on function public.ativar_etiqueta(text, text) to anon, authenticated;

create or replace function public.trocar_codigo_ativacao(p_restaurante uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not public.eh_operador() then raise exception 'Acesso negado.'; end if;
  loop
    c := public.novo_codigo_ativacao();
    begin
      update public.restaurantes set codigo_ativacao = c where id = p_restaurante;
      return c;
    exception when unique_violation then
      -- raríssimo: sorteia de novo
    end;
  end loop;
end $$;
revoke execute on function public.trocar_codigo_ativacao(uuid) from public, anon;
grant execute on function public.trocar_codigo_ativacao(uuid) to authenticated;

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

-- ---------------------------------------------------------------------------
-- Métricas do painel: leituras por dia e por restaurante no período, com a
-- comparação contra o período anterior de mesmo tamanho.
-- ---------------------------------------------------------------------------
create or replace function public.metricas(p_dias int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  ini  date;
  ant  date;
begin
  if not public.eh_operador() then raise exception 'Acesso negado.'; end if;
  p_dias := least(greatest(coalesce(p_dias, 30), 1), 365);
  ini := hoje - (p_dias - 1);
  ant := ini - p_dias;
  return jsonb_build_object(
    'hoje', hoje,
    'por_dia', coalesce((
      select jsonb_agg(jsonb_build_object('dia', d::date, 'n', coalesce(x.n, 0)) order by d)
        from generate_series(ini, hoje, interval '1 day') d
        left join (select dia, sum(n)::int n from public.leituras_dia where dia >= ini group by dia) x on x.dia = d::date
    ), '[]'::jsonb),
    'por_restaurante', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', r.id, 'nome', r.nome, 'ativo', r.ativo,
          'n', coalesce(a.n, 0), 'anterior', coalesce(b.n, 0),
          'etiquetas', (select count(*) from public.etiquetas e where e.restaurante_id = r.id),
          'lidas', coalesce(a.lidas, 0),
          'nunca_lidas', (select count(*) from public.etiquetas e where e.restaurante_id = r.id and e.leituras = 0),
          'ultima', (select max(e.ultima_leitura) from public.etiquetas e where e.restaurante_id = r.id)
        ) order by coalesce(a.n, 0) desc, r.nome)
        from public.restaurantes r
        left join (select restaurante_id, sum(n)::int n, count(distinct codigo)::int lidas
                     from public.leituras_dia where dia >= ini group by restaurante_id) a on a.restaurante_id = r.id
        left join (select restaurante_id, sum(n)::int n
                     from public.leituras_dia where dia >= ant and dia < ini group by restaurante_id) b on b.restaurante_id = r.id
    ), '[]'::jsonb),
    'total', (select coalesce(sum(n), 0)::int from public.leituras_dia where dia >= ini),
    'total_anterior', (select coalesce(sum(n), 0)::int from public.leituras_dia where dia >= ant and dia < ini)
  );
end $$;
revoke execute on function public.metricas(int) from public, anon;
grant execute on function public.metricas(int) to authenticated;
