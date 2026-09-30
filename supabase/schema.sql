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
-- Módulos liberados pela Vortex ({"fidelidade": true}) e regras do programa de fidelidade.
alter table public.restaurantes add column if not exists modulos jsonb not null default '{}'::jsonb;
alter table public.restaurantes add column if not exists fidelidade jsonb;
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


-- ---------------------------------------------------------------------------
-- Plano contratado: serviços (página + cardápio, chamar o garçom, fidelidade),
-- mesas, domínio e contrato. Sem plano definido = tudo liberado, como antes.
-- A mensalidade segue a tabela de preços (assets/js/precos.js): 49 + 69 + 199 + 149,
-- 2 serviços −10%, 3 −15% (arredondado para terminar em 9), os quatro por R$ 399.
-- ---------------------------------------------------------------------------
alter table public.restaurantes add column if not exists plano jsonb;

-- Arruma um plano (valores válidos). Erro se nenhum serviço for escolhido.
create or replace function public.plano_normalizar(p jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare s jsonb := coalesce(p -> 'servicos', '{}'::jsonb); n jsonb;
begin
  n := jsonb_build_object(
    'servicos', jsonb_build_object(
      'pagina', coalesce(s ->> 'pagina', '') = 'true',
      'garcom', coalesce(s ->> 'garcom', '') = 'true',
      'fidelidade', coalesce(s ->> 'fidelidade', '') = 'true',
      'delivery', coalesce(s ->> 'delivery', '') = 'true'),
    'mesas', least(greatest(coalesce(public.num_ou(p ->> 'mesas', 20), 20), 1), 500)::int,
    'dominio', case when p ->> 'dominio' in ('proprio', 'registro') then p ->> 'dominio' else 'sub' end,
    'contrato', case when p ->> 'contrato' = '12' then 12 else 6 end,
    'inicio', case when coalesce(p ->> 'inicio', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then p ->> 'inicio' end,
    'definido', true);
  if not (n -> 'servicos' @> '{"pagina": true}' or n -> 'servicos' @> '{"garcom": true}' or n -> 'servicos' @> '{"fidelidade": true}'
          or n -> 'servicos' @> '{"delivery": true}') then
    raise exception 'Escolha pelo menos um serviço.';
  end if;
  return n;
end $$;

-- Plano em vigor (sem plano definido: tudo liberado e até 500 mesas).
create or replace function public.plano_de(p_restaurante uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when plano is null then jsonb_build_object(
      'servicos', jsonb_build_object('pagina', true, 'garcom', true, 'fidelidade', coalesce(modulos ->> 'fidelidade', '') = 'true', 'delivery', false),
      'mesas', 500, 'dominio', 'sub', 'contrato', 6, 'inicio', null, 'definido', false)
    else plano end
  from public.restaurantes where id = p_restaurante;
$$;

-- Mensalidade do plano, em reais.
create or replace function public.plano_preco(p jsonb) returns numeric
language plpgsql immutable set search_path = public as $$
declare
  sv jsonb := coalesce(p -> 'servicos', '{}'::jsonb);
  soma numeric := 0; n int := 0; total numeric;
begin
  if coalesce(sv ->> 'pagina', '') = 'true' then soma := soma + 49; n := n + 1; end if;
  if coalesce(sv ->> 'garcom', '') = 'true' then soma := soma + 69; n := n + 1; end if;
  if coalesce(sv ->> 'fidelidade', '') = 'true' then soma := soma + 199; n := n + 1; end if;
  if coalesce(sv ->> 'delivery', '') = 'true' then soma := soma + 149; n := n + 1; end if;
  total := case
    when n = 4 then 399
    when n = 3 then least(soma, floor(soma * 0.85 / 10) * 10 + 9)
    when n = 2 then least(soma, floor(soma * 0.90 / 10) * 10 + 9)
    else soma end;
  return total + (case when p ->> 'dominio' in ('proprio', 'registro') then 19 else 0 end);
end $$;

create or replace function public.plano_tem(p_restaurante uuid, p_servico text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.plano_de(p_restaurante) -> 'servicos' ->> p_servico, '') = 'true';
$$;

-- Histórico das mudanças de plano (feitas pela central ou pelo próprio restaurante).
create table if not exists public.plano_mudancas (
  id             uuid primary key default gen_random_uuid(),
  restaurante_id uuid not null references public.restaurantes (id) on delete cascade,
  antes          jsonb,
  depois         jsonb not null,
  mensal_antes   numeric(10, 2),
  mensal_depois  numeric(10, 2) not null,
  origem         text not null check (origem in ('central', 'restaurante')),
  por            text check (char_length(por) <= 120),
  visto          boolean not null default false,
  criado_em      timestamptz not null default now()
);
create index if not exists plano_mudancas_rest_idx on public.plano_mudancas (restaurante_id, criado_em desc);
create index if not exists plano_mudancas_visto_idx on public.plano_mudancas (visto, criado_em desc);
alter table public.plano_mudancas enable row level security;
revoke all on public.plano_mudancas from anon;
drop policy if exists "operador ve mudancas" on public.plano_mudancas;
create policy "operador ve mudancas" on public.plano_mudancas
  for all to authenticated using (public.eh_operador()) with check (public.eh_operador());

-- Aplica um plano: guarda, sincroniza a fidelidade, corta mesas acima do contratado e registra a mudança.
create or replace function public.plano_aplicar(p_restaurante uuid, p_plano jsonb, p_origem text, p_por text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare antes jsonb := public.plano_de(p_restaurante); novo jsonb := public.plano_normalizar(p_plano); n int;
begin
  if antes is null then raise exception 'Restaurante não encontrado.'; end if;
  n := (novo ->> 'mesas')::int;
  update public.restaurantes set
    plano = novo,
    modulos = coalesce(modulos, '{}'::jsonb) || jsonb_build_object('fidelidade', novo -> 'servicos' -> 'fidelidade'),
    mesas = case when mesas is not null and coalesce((mesas ->> 'total')::int, 0) > n then jsonb_build_object('total', n,
        'areas', coalesce((select jsonb_agg(jsonb_set(a, '{ate}', to_jsonb(least((a ->> 'ate')::int, n))))
                             from jsonb_array_elements(case when jsonb_typeof(mesas -> 'areas') = 'array' then mesas -> 'areas' else '[]'::jsonb end) a
                            where (a ->> 'de')::int <= n), '[]'::jsonb))
      else mesas end
  where id = p_restaurante;
  if (antes - 'definido' - 'inicio') is distinct from (novo - 'definido' - 'inicio') or not coalesce((antes ->> 'definido')::boolean, false) then
    insert into public.plano_mudancas (restaurante_id, antes, depois, mensal_antes, mensal_depois, origem, por)
    values (p_restaurante, case when coalesce((antes ->> 'definido')::boolean, false) then antes end, novo,
            case when coalesce((antes ->> 'definido')::boolean, false) then public.plano_preco(antes) end, public.plano_preco(novo), p_origem, left(p_por, 120));
  end if;
  return novo;
end $$;

create or replace function public.restaurante_ativo(p_restaurante uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.restaurantes where id = p_restaurante and ativo);
$$;

create or replace function public.total_mesas(p_restaurante uuid) returns int
language sql stable security definer set search_path = public as $$
  -- Mesas configuradas, nunca acima das contratadas no plano.
  select least(coalesce((select (mesas ->> 'total')::int from public.restaurantes where id = p_restaurante), 500),
               coalesce((public.plano_de(p_restaurante) ->> 'mesas')::int, 500));
$$;

-- Dados públicos do restaurante para a página da mesa e o painel (sem código de ativação).
create or replace function public.restaurante_publico(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', id, 'slug', slug, 'nome', nome, 'restaurante', restaurante,
    'wifi', wifi, 'cardapio', cardapio, 'mesas', mesas, 'widgets', widgets,
    'modulos', modulos, 'fidelidade', fidelidade,
    'plano', jsonb_build_object('servicos', public.plano_de(id) -> 'servicos', 'mesas', public.plano_de(id) -> 'mesas'))
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
-- Administrador: adiciona, remove e troca o PIN das pessoas, e muda o plano.
-- A primeira conta de cada restaurante é administradora.
alter table public.equipe_membros add column if not exists admin boolean not null default false;
update public.equipe_membros m set admin = true
 where m.id in (select distinct on (restaurante_id) id from public.equipe_membros order by restaurante_id, criado_em)
   and not exists (select 1 from public.equipe_membros x where x.restaurante_id = m.restaurante_id and x.admin);

-- Restaurante de quem está logado (null = não é da equipe de ninguém).
create or replace function public.meu_restaurante() returns uuid
language sql stable security definer set search_path = public as $$
  select restaurante_id from public.equipe_membros where user_id = auth.uid();
$$;
revoke execute on function public.meu_restaurante() from public, anon;
grant execute on function public.meu_restaurante() to authenticated;

grant select (id, restaurante_id, nome, criado_em, admin) on public.equipe_membros to authenticated;

create or replace function public.eu_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select admin from public.equipe_membros where user_id = auth.uid()), false);
$$;
revoke execute on function public.eu_admin() from public, anon;
grant execute on function public.eu_admin() to authenticated;
drop policy if exists "equipe ve a equipe" on public.equipe_membros;
create policy "equipe ve a equipe" on public.equipe_membros
  for select to authenticated using (restaurante_id = public.meu_restaurante());

-- A equipe salva a configuração do próprio restaurante (só estas chaves).
create or replace function public.salvar_config(p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); f jsonb := p_patch -> 'fidelidade';
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  if p_patch ? 'fidelidade' then
    if not coalesce((select modulos ->> 'fidelidade' = 'true' from public.restaurantes where id = r), false) then
      raise exception 'O programa de fidelidade não está liberado para este restaurante. Fale com a Vortex.';
    end if;
    if jsonb_typeof(f) <> 'object' then raise exception 'Regras do programa inválidas.'; end if;
    if coalesce(f ->> 'ativo', '') = 'true' and (jsonb_typeof(f -> 'cnpjs') <> 'array' or jsonb_array_length(f -> 'cnpjs') = 0) then
      raise exception 'Informe o CNPJ que sai nas notas fiscais antes de ativar o programa.';
    end if;
  end if;
  if p_patch ? 'mesas' and coalesce(public.num_ou(p_patch -> 'mesas' ->> 'total', 0), 0) > (public.plano_de(r) ->> 'mesas')::int then
    raise exception 'Seu plano tem % mesas. Para usar mais, aumente as mesas na aba Plano.', public.plano_de(r) ->> 'mesas';
  end if;
  update public.restaurantes set
    restaurante = case when p_patch ? 'restaurante' then p_patch -> 'restaurante' else restaurante end,
    wifi        = case when p_patch ? 'wifi'        then p_patch -> 'wifi'        else wifi end,
    cardapio    = case when p_patch ? 'cardapio'    then p_patch -> 'cardapio'    else cardapio end,
    mesas       = case when p_patch ? 'mesas'       then p_patch -> 'mesas'       else mesas end,
    widgets     = case when p_patch ? 'widgets'     then p_patch -> 'widgets'     else widgets end,
    fidelidade  = case when p_patch ? 'fidelidade'  then f                        else fidelidade end
  where id = r;
  -- Regras novas: atualiza o nível guardado de cada cliente (o bônus de nível sai na próxima compra).
  if p_patch ? 'fidelidade' then
    perform public.fid_atualizar_nivel(r, c.cpf, false) from public.fid_clientes c where c.restaurante_id = r;
  end if;
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

-- Devolver a plaquinha ao estoque é só da central (limpar_etiquetas): o
-- painel do restaurante só tira da mesa.
drop function if exists public.etiqueta_liberar(text);

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
  if not public.plano_tem(p_restaurante, 'garcom') then raise exception 'Este restaurante não usa o chamado pelo celular.'; end if;
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
  if not public.plano_tem(s.restaurante_id, 'garcom') then raise exception 'Este restaurante não usa o chamado pelo celular.'; end if;
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

-- Limpar plaquinhas. 'mesa' tira da mesa (continua do restaurante);
-- 'restaurante' devolve ao estoque; 'tudo' zera (sem dono, sem mesa, NFC a
-- gravar de novo, leituras zeradas). O código da plaquinha nunca muda.
create or replace function public.limpar_etiquetas(p_codigos text[], p_nivel text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.eh_operador() then raise exception 'Acesso negado.'; end if;
  if p_nivel is null or p_nivel not in ('mesa', 'restaurante', 'tudo') then raise exception 'Opção inválida.'; end if;
  update public.etiquetas set
    mesa = null, vinculada_em = null, vinculada_por = null,
    restaurante_id = case when p_nivel = 'mesa' then restaurante_id end,
    ativada_em = case when p_nivel = 'mesa' then ativada_em end,
    gravada = case when p_nivel = 'tudo' then false else gravada end,
    leituras = case when p_nivel = 'tudo' then 0 else leituras end,
    ultima_leitura = case when p_nivel = 'tudo' then null else ultima_leitura end
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
-- Programa de fidelidade (módulo liberado pela Vortex em cada restaurante)
--
-- O cliente se cadastra com o CPF (a chave da conta no restaurante), pede CPF
-- na nota e lê o QR da NFC-e. A chave de acesso da nota (44 números) prova que
-- ela é deste restaurante (CNPJ) e só vale uma vez. Valor, CPF e horário da
-- compra vêm do XML das NFC-e que a equipe importa no painel (confere tudo de
-- uma vez, e quem deu CPF na nota ganha mesmo sem ler o QR) ou da conferência
-- manual pelo link da SEFAZ. Pontos = valor × pontos por real × multiplicador
-- do horário da compra (boosts).
-- ---------------------------------------------------------------------------
-- Número vindo do JSON de configuração; texto inválido vira o padrão.
create or replace function public.num_ou(p text, p_padrao numeric) returns numeric
language sql immutable set search_path = public as $$
  select case when btrim(coalesce(p, '')) ~ '^-?[0-9]+([.][0-9]+)?$' then btrim(p)::numeric else p_padrao end;
$$;

-- IP de quem chamou (para o freio contra abuso nas funções abertas).
create or replace function public.ip_do_pedido() returns text
language sql stable set search_path = public as $$
  select coalesce(nullif(btrim(split_part(coalesce(
    (nullif(current_setting('request.headers', true), '')::json) ->> 'x-forwarded-for', ''), ',', 1)), ''), 'sem-ip');
$$;

create or replace function public.cpf_valido(p text) returns boolean
language plpgsql immutable set search_path = public as $$
declare s int; r int; i int;
begin
  if p is null or p !~ '^[0-9]{11}$' or p ~ '^([0-9])\1{10}$' then return false; end if;
  s := 0;
  for i in 1..9 loop s := s + substr(p, i, 1)::int * (11 - i); end loop;
  r := (s * 10) % 11;
  if r = 10 then r := 0; end if;
  if r <> substr(p, 10, 1)::int then return false; end if;
  s := 0;
  for i in 1..10 loop s := s + substr(p, i, 1)::int * (12 - i); end loop;
  r := (s * 10) % 11;
  if r = 10 then r := 0; end if;
  return r = substr(p, 11, 1)::int;
end $$;

-- Chave de acesso da NF-e/NFC-e: 44 números com dígito verificador (módulo 11).
create or replace function public.chave_valida(p text) returns boolean
language plpgsql immutable set search_path = public as $$
declare s int := 0; w int := 2; i int; dv int;
begin
  if p is null or p !~ '^[0-9]{44}$' then return false; end if;
  for i in reverse 43..1 loop
    s := s + substr(p, i, 1)::int * w;
    w := case when w = 9 then 2 else w + 1 end;
  end loop;
  dv := 11 - (s % 11);
  if dv >= 10 then dv := 0; end if;
  return dv = substr(p, 44, 1)::int and substr(p, 5, 2)::int between 1 and 12;
end $$;

-- Regras do programa com os valores iniciais.
create or replace function public.fid_cfg(p_restaurante uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'ativo', false, 'nome', 'Clube de pontos', 'pontosPorReal', 1, 'boosts', '[]'::jsonb,
    'cnpjs', '[]'::jsonb, 'prazoDias', 7, 'inicio', null, 'manual', false, 'regulamento', '',
    'fuso', 'America/Sao_Paulo', 'indicacao', jsonb_build_object('ativo', true, 'indicador', 50, 'indicado', 20, 'quando', 'cadastro'),
    'niveis', jsonb_build_object('ativo', false, 'base', 'sempre', 'meses', 12, 'lista', '[]'::jsonb)
  ) || coalesce((select fidelidade from public.restaurantes where id = p_restaurante), '{}'::jsonb);
$$;

create or replace function public.fid_liberado(p_restaurante uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.restaurantes
                  where id = p_restaurante and ativo and coalesce(modulos ->> 'fidelidade', '') = 'true');
$$;

-- Liberado pela Vortex e ligado pela equipe.
create or replace function public.fid_no_ar(p_restaurante uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.fid_liberado(p_restaurante) and coalesce(public.fid_cfg(p_restaurante) ->> 'ativo', '') = 'true';
$$;

create or replace function public.fid_fuso(p_restaurante uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when f in ('America/Sao_Paulo', 'America/Campo_Grande', 'America/Cuiaba', 'America/Porto_Velho',
                         'America/Boa_Vista', 'America/Manaus', 'America/Rio_Branco', 'America/Noronha',
                         'America/Belem', 'America/Fortaleza', 'America/Recife', 'America/Bahia')
              then f else 'America/Sao_Paulo' end
  from (select public.fid_cfg(p_restaurante) ->> 'fuso' as f) x;
$$;

create or replace function public.fid_prazo(p_restaurante uuid) returns int
language sql stable security definer set search_path = public as $$
  select least(greatest(public.num_ou(public.fid_cfg(p_restaurante) ->> 'prazoDias', 7), 1), 365)::int;
$$;

-- Início do programa (compras antes não valem). null = sem data.
create or replace function public.fid_inicio(p_restaurante uuid) returns timestamptz
language sql stable security definer set search_path = public as $$
  select case when coalesce(public.fid_cfg(p_restaurante) ->> 'inicio', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
              then ((public.fid_cfg(p_restaurante) ->> 'inicio')::date)::timestamp at time zone public.fid_fuso(p_restaurante) end;
$$;

-- Maior multiplicador que vale no momento da compra (não acumula).
-- Boost: { nome, mult, dias [0=dom..6=sáb, vazio = todos], de/ate 'HH:MM'
-- (pode virar a meia-noite), inicio/fim 'AAAA-MM-DD' (período), ativo }.
create or replace function public.fid_boost(p_restaurante uuid, p_quando timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c jsonb := public.fid_cfg(p_restaurante);
  loc timestamp := p_quando at time zone public.fid_fuso(p_restaurante);
  dia int := extract(dow from loc)::int;
  minuto int := (extract(hour from loc) * 60 + extract(minute from loc))::int;
  b jsonb; dias jsonb; m numeric; ini int; fim int; ok boolean;
  melhor numeric := 1; nome text := null;
begin
  for b in select * from jsonb_array_elements(case when jsonb_typeof(c -> 'boosts') = 'array' then c -> 'boosts' else '[]'::jsonb end) loop
    if coalesce(b ->> 'ativo', 'true') = 'false' then continue; end if;
    m := least(greatest(public.num_ou(b ->> 'mult', 1), 1), 10);
    if m <= melhor then continue; end if;
    if coalesce(b ->> 'inicio', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and loc::date < (b ->> 'inicio')::date then continue; end if;
    if coalesce(b ->> 'fim', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and loc::date > (b ->> 'fim')::date then continue; end if;
    dias := case when jsonb_typeof(b -> 'dias') = 'array' then b -> 'dias' else '[]'::jsonb end;
    if coalesce(b ->> 'de', '') ~ '^[0-9]{1,2}:[0-9]{2}$' and coalesce(b ->> 'ate', '') ~ '^[0-9]{1,2}:[0-9]{2}$' then
      ini := split_part(b ->> 'de', ':', 1)::int * 60 + split_part(b ->> 'de', ':', 2)::int;
      fim := split_part(b ->> 'ate', ':', 1)::int * 60 + split_part(b ->> 'ate', ':', 2)::int;
      if fim > ini then
        ok := (jsonb_array_length(dias) = 0 or dias @> to_jsonb(dia)) and minuto >= ini and minuto < fim;
      else
        -- Vira a meia-noite: a madrugada conta como o dia em que a faixa começou.
        ok := ((jsonb_array_length(dias) = 0 or dias @> to_jsonb(dia)) and minuto >= ini)
           or ((jsonb_array_length(dias) = 0 or dias @> to_jsonb((dia + 6) % 7)) and minuto < fim);
      end if;
    else
      ok := jsonb_array_length(dias) = 0 or dias @> to_jsonb(dia);
    end if;
    if ok then
      melhor := m;
      nome := nullif(left(btrim(coalesce(b ->> 'nome', '')), 60), '');
    end if;
  end loop;
  return jsonb_build_object('mult', melhor, 'nome', nome);
end $$;

drop function if exists public.fid_calcular(uuid, numeric, timestamptz);

-- Níveis do clube (ex.: Bronze, Prata, Ouro). Lista arrumada pelo mínimo de pontos;
-- o primeiro nível é a porta de entrada e começa em 0. Vazia = sem níveis.
-- Nível: { id, nome, descricao, cor '#RRGGBB', minimo, mult (bônus nas compras), bonus (pontos ao chegar), beneficios [] }.
create or replace function public.fid_niveis(p_restaurante uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare n jsonb := public.fid_cfg(p_restaurante) -> 'niveis'; v_out jsonb;
begin
  if jsonb_typeof(n) is distinct from 'object' or coalesce(n ->> 'ativo', '') <> 'true' or jsonb_typeof(n -> 'lista') is distinct from 'array' then
    return '[]'::jsonb;
  end if;
  select coalesce(jsonb_agg(x order by (x ->> 'minimo')::int), '[]'::jsonb) into v_out from (
    select jsonb_build_object(
      'id', left(regexp_replace(l ->> 'id', '[^A-Za-z0-9_-]', '', 'g'), 24),
      'nome', left(btrim(l ->> 'nome'), 30),
      'descricao', left(btrim(coalesce(l ->> 'descricao', '')), 80),
      'cor', case when coalesce(l ->> 'cor', '') ~ '^#[0-9A-Fa-f]{6}$' then l ->> 'cor' else '#8C6416' end,
      'minimo', least(greatest(public.num_ou(l ->> 'minimo', 0), 0), 10000000)::int,
      'mult', round(least(greatest(public.num_ou(l ->> 'mult', 1), 1), 5), 2),
      'bonus', least(greatest(public.num_ou(l ->> 'bonus', 0), 0), 100000)::int,
      'beneficios', coalesce((select jsonb_agg(left(btrim(b.v), 80)) from (
          select v from jsonb_array_elements_text(case when jsonb_typeof(l -> 'beneficios') = 'array' then l -> 'beneficios' else '[]'::jsonb end) v
           where btrim(v) <> '' limit 8) b), '[]'::jsonb)) x
    from jsonb_array_elements(n -> 'lista') with ordinality t(l, i)
    where i <= 6 and btrim(coalesce(l ->> 'nome', '')) <> '' and coalesce(l ->> 'id', '') ~ '[A-Za-z0-9]'
  ) s;
  if jsonb_array_length(v_out) > 0 then v_out := jsonb_set(v_out, '{0,minimo}', '0'::jsonb); end if;
  return v_out;
end $$;

-- Pontos que contam para o nível: os ganhos em compras (com estornos e ajustes),
-- desde sempre ou nos últimos N meses. Bônus e trocas não contam.
create or replace function public.fid_pontos_nivel(p_restaurante uuid, p_cpf text) returns int
language plpgsql stable security definer set search_path = public as $$
declare n jsonb := public.fid_cfg(p_restaurante) -> 'niveis'; v_meses int;
begin
  v_meses := case when jsonb_typeof(n) = 'object' and n ->> 'base' = 'meses'
                  then least(greatest(public.num_ou(n ->> 'meses', 12), 1), 60)::int end;
  return greatest(coalesce((select sum(pontos) from public.fid_movimentos
    where restaurante_id = p_restaurante and cpf = p_cpf
      and (tipo in ('compra', 'manual') or (tipo in ('estorno', 'ajuste') and resgate_id is null))
      and (v_meses is null or criado_em > now() - make_interval(months => v_meses))), 0), 0)::int;
end $$;

-- Nível atual do cliente e quanto falta para o próximo. null = programa sem níveis.
create or replace function public.fid_nivel(p_restaurante uuid, p_cpf text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare lista jsonb := public.fid_niveis(p_restaurante); q int; atual jsonb; prox jsonb; v_i int := 0; k int;
begin
  if jsonb_array_length(lista) = 0 then return null; end if;
  q := public.fid_pontos_nivel(p_restaurante, p_cpf);
  for k in 0 .. jsonb_array_length(lista) - 1 loop
    if ((lista -> k) ->> 'minimo')::int <= q then atual := lista -> k; v_i := k;
    else prox := lista -> k; exit;
    end if;
  end loop;
  return atual || jsonb_build_object('indice', v_i, 'pontos_nivel', q, 'proximo',
    case when prox is null then null else jsonb_build_object('id', prox ->> 'id', 'nome', prox ->> 'nome', 'cor', prox ->> 'cor',
      'minimo', (prox ->> 'minimo')::int, 'falta', (prox ->> 'minimo')::int - q) end);
end $$;

-- Pontos de uma compra: valor x pontos por real x dia com mais pontos x bônus do nível.
create or replace function public.fid_calcular(p_restaurante uuid, p_valor numeric, p_quando timestamptz, p_cpf text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  ppr numeric := least(greatest(public.num_ou(public.fid_cfg(p_restaurante) ->> 'pontosPorReal', 1), 0), 1000);
  b jsonb := public.fid_boost(p_restaurante, p_quando);
  nv jsonb := case when p_cpf is null then null else public.fid_nivel(p_restaurante, p_cpf) end;
  mn numeric := coalesce((nv ->> 'mult')::numeric, 1);
  m numeric := round((b ->> 'mult')::numeric * mn, 2);
begin
  return jsonb_build_object(
    'pontos', floor(greatest(coalesce(p_valor, 0), 0) * ppr * m)::int,
    'mult', m, 'boost', b ->> 'nome', 'nivel', case when mn > 1 then nv ->> 'nome' end);
end $$;

create or replace function public.brl(p numeric) returns text
language sql immutable set search_path = public as $$
  select 'R$ ' || replace(replace(replace(to_char(coalesce(p, 0), 'FM999,999,990.00'), ',', '#'), '.', ','), '#', '.');
$$;

-- Clientes: CPF é a chave da conta dentro do restaurante.
create table if not exists public.fid_clientes (
  restaurante_id  uuid not null references public.restaurantes (id) on delete cascade,
  cpf             text not null check (cpf ~ '^[0-9]{11}$'),
  nome            text not null check (char_length(nome) between 3 and 80),
  email           text not null check (char_length(email) between 5 and 120),
  telefone        text not null check (telefone ~ '^[0-9]{10,11}$'),
  pontos          int  not null default 0,
  codigo          text not null check (codigo ~ '^[A-Z0-9]{4,12}$'),
  indicado_por    text check (indicado_por ~ '^[0-9]{11}$'),
  bonus_indicacao boolean not null default false,
  marketing       boolean not null default false,
  nivel           text,
  niveis_bonus    text[] not null default '{}',
  criado_em       timestamptz not null default now(),
  primary key (restaurante_id, cpf),
  unique (restaurante_id, codigo)
);
alter table public.fid_clientes add column if not exists nivel text;
alter table public.fid_clientes add column if not exists niveis_bonus text[] not null default '{}';
create index if not exists fid_clientes_indicado_idx on public.fid_clientes (restaurante_id, indicado_por);

create table if not exists private.fid_pins (
  restaurante_id uuid not null,
  cpf            text not null,
  pin_hash       text not null,
  primary key (restaurante_id, cpf),
  foreign key (restaurante_id, cpf) references public.fid_clientes (restaurante_id, cpf) on delete cascade
);

-- Aparelho do cliente que já confirmou o PIN (lembrado por 180 dias).
create table if not exists private.fid_sessoes (
  token_hash     text primary key,
  restaurante_id uuid not null,
  cpf            text not null,
  criado_em      timestamptz not null default now(),
  foreign key (restaurante_id, cpf) references public.fid_clientes (restaurante_id, cpf) on delete cascade
);
create index if not exists fid_sessoes_cliente_idx on private.fid_sessoes (restaurante_id, cpf);

-- Extrato: todo ganho e gasto de pontos.
create table if not exists public.fid_movimentos (
  id             bigint generated always as identity primary key,
  restaurante_id uuid not null,
  cpf            text not null,
  tipo           text not null,
  pontos         int  not null,
  valor          numeric(12, 2),
  mult           numeric(5, 2),
  descricao      text check (char_length(descricao) <= 160),
  nota_chave     text,
  resgate_id     uuid,
  por            text check (char_length(por) <= 60),
  criado_em      timestamptz not null default now(),
  foreign key (restaurante_id, cpf) references public.fid_clientes (restaurante_id, cpf) on delete cascade
);
alter table public.fid_movimentos drop constraint if exists fid_movimentos_tipo_check;
alter table public.fid_movimentos add constraint fid_movimentos_tipo_check
  check (tipo in ('compra', 'indicacao', 'boas_vindas', 'manual', 'resgate', 'estorno', 'ajuste', 'nivel'));
create index if not exists fid_movimentos_cliente_idx on public.fid_movimentos (restaurante_id, cpf, criado_em desc);
create index if not exists fid_movimentos_rest_idx on public.fid_movimentos (restaurante_id, criado_em desc);

-- Notas lidas (QR ou chave digitada). A chave primária impede usar a mesma nota duas vezes.
create table if not exists public.fid_notas (
  chave           text primary key check (chave ~ '^[0-9]{44}$'),
  restaurante_id  uuid not null references public.restaurantes (id) on delete cascade,
  cpf             text not null,
  url             text check (char_length(url) <= 600),
  status          text not null default 'pendente' check (status in ('pendente', 'creditada', 'recusada', 'estornada')),
  valor_informado numeric(12, 2),
  valor           numeric(12, 2),
  emitida_em      timestamptz,
  pontos          int,
  mult            numeric(5, 2),
  lida_em         timestamptz not null default now(),
  lida_por        text check (char_length(lida_por) <= 60),
  conferida_em    timestamptz,
  conferida_por   text check (char_length(conferida_por) <= 60),
  motivo          text check (char_length(motivo) <= 160),
  foreign key (restaurante_id, cpf) references public.fid_clientes (restaurante_id, cpf) on delete cascade
);
create index if not exists fid_notas_rest_idx on public.fid_notas (restaurante_id, status, lida_em desc);
create index if not exists fid_notas_cliente_idx on public.fid_notas (restaurante_id, cpf, lida_em desc);

-- Dados das NFC-e vindos do XML importado pela equipe (a fonte oficial de valor e CPF).
create table if not exists public.fid_xml (
  chave          text primary key check (chave ~ '^[0-9]{44}$'),
  restaurante_id uuid not null references public.restaurantes (id) on delete cascade,
  cpf            text check (cpf ~ '^[0-9]{11}$'),
  valor          numeric(12, 2),
  emitida_em     timestamptz,
  cancelada      boolean not null default false,
  importada_em   timestamptz not null default now(),
  importada_por  text check (char_length(importada_por) <= 60)
);
create index if not exists fid_xml_cpf_idx on public.fid_xml (restaurante_id, cpf);

-- Cardápio de prêmios.
create table if not exists public.fid_premios (
  id             uuid primary key default gen_random_uuid(),
  restaurante_id uuid not null references public.restaurantes (id) on delete cascade,
  nome           text not null check (char_length(nome) between 1 and 60),
  descricao      text not null default '' check (char_length(descricao) <= 160),
  pontos         int  not null check (pontos between 1 and 1000000),
  imagem         text not null default '' check (char_length(imagem) <= 600),
  ativo          boolean not null default true,
  ordem          int  not null default 0,
  nivel_min      text check (char_length(nivel_min) <= 24),
  criado_em      timestamptz not null default now()
);
alter table public.fid_premios add column if not exists nivel_min text check (char_length(nivel_min) <= 24);
create index if not exists fid_premios_rest_idx on public.fid_premios (restaurante_id, ordem);

-- Resgates: o cliente troca os pontos e mostra o código ao garçom.
create table if not exists public.fid_resgates (
  id             uuid primary key default gen_random_uuid(),
  restaurante_id uuid not null,
  cpf            text not null,
  premio_id      uuid references public.fid_premios (id) on delete set null,
  premio_nome    text not null,
  pontos         int  not null,
  codigo         text not null check (codigo ~ '^[0-9]{4}$'),
  status         text not null default 'pendente' check (status in ('pendente', 'entregue', 'cancelado')),
  criado_em      timestamptz not null default now(),
  resolvido_em   timestamptz,
  resolvido_por  text check (char_length(resolvido_por) <= 60),
  foreign key (restaurante_id, cpf) references public.fid_clientes (restaurante_id, cpf) on delete cascade
);
create index if not exists fid_resgates_rest_idx on public.fid_resgates (restaurante_id, status, criado_em desc);

-- Lança pontos no extrato e atualiza o saldo.
create or replace function public.fid_mover(p_restaurante uuid, p_cpf text, p_tipo text, p_pontos int,
  p_descricao text default null, p_valor numeric default null, p_mult numeric default null,
  p_chave text default null, p_resgate uuid default null, p_por text default null) returns int
language plpgsql security definer set search_path = public as $$
declare saldo int;
begin
  insert into public.fid_movimentos (restaurante_id, cpf, tipo, pontos, valor, mult, descricao, nota_chave, resgate_id, por)
  values (p_restaurante, p_cpf, p_tipo, p_pontos, p_valor, p_mult, left(p_descricao, 160), p_chave, p_resgate, left(p_por, 60));
  update public.fid_clientes set pontos = pontos + p_pontos
   where restaurante_id = p_restaurante and cpf = p_cpf
  returning pontos into saldo;
  if p_tipo in ('compra', 'manual', 'estorno', 'ajuste') then
    perform public.fid_atualizar_nivel(p_restaurante, p_cpf);
    select pontos into saldo from public.fid_clientes where restaurante_id = p_restaurante and cpf = p_cpf;
  end if;
  return saldo;
end $$;

-- Guarda o nível do cliente e paga o bônus de cada nível alcançado (uma vez por nível,
-- mesmo que o cliente caia e volte). p_bonus = false só atualiza o nível guardado.
create or replace function public.fid_atualizar_nivel(p_restaurante uuid, p_cpf text, p_bonus boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare nv jsonb := public.fid_nivel(p_restaurante, p_cpf); cli public.fid_clientes; l jsonb;
begin
  select * into cli from public.fid_clientes where restaurante_id = p_restaurante and cpf = p_cpf for update;
  if not found then return nv; end if;
  if cli.nivel is distinct from nv ->> 'id' then
    update public.fid_clientes set nivel = nv ->> 'id' where restaurante_id = p_restaurante and cpf = p_cpf;
  end if;
  if nv is null or not p_bonus then return nv; end if;
  for l in select * from jsonb_array_elements(public.fid_niveis(p_restaurante)) loop
    if (l ->> 'minimo')::int <= (nv ->> 'pontos_nivel')::int and (l ->> 'bonus')::int > 0 and not ((l ->> 'id') = any (cli.niveis_bonus)) then
      cli.niveis_bonus := cli.niveis_bonus || (l ->> 'id');
      update public.fid_clientes set niveis_bonus = cli.niveis_bonus where restaurante_id = p_restaurante and cpf = p_cpf;
      perform public.fid_mover(p_restaurante, p_cpf, 'nivel', (l ->> 'bonus')::int, 'Bônus: chegou ao nível ' || (l ->> 'nome'));
    end if;
  end loop;
  return nv;
end $$;

-- Indicação: na primeira compra conferida do indicado, os dois ganham.
create or replace function public.fid_bonus_indicacao(p_restaurante uuid, p_cpf text) returns void
language plpgsql security definer set search_path = public as $$
declare
  c jsonb := public.fid_cfg(p_restaurante);
  cli public.fid_clientes;
  p_ind int := least(greatest(public.num_ou(c -> 'indicacao' ->> 'indicador', 0), 0), 100000)::int;
  p_novo int := least(greatest(public.num_ou(c -> 'indicacao' ->> 'indicado', 0), 0), 100000)::int;
begin
  if coalesce(c -> 'indicacao' ->> 'ativo', '') <> 'true' then return; end if;
  select * into cli from public.fid_clientes where restaurante_id = p_restaurante and cpf = p_cpf for update;
  if not found or cli.indicado_por is null or cli.bonus_indicacao then return; end if;
  update public.fid_clientes set bonus_indicacao = true where restaurante_id = p_restaurante and cpf = p_cpf;
  if p_novo > 0 then
    perform public.fid_mover(p_restaurante, p_cpf, 'boas_vindas', p_novo, 'Bônus de boas-vindas (indicação)');
  end if;
  if p_ind > 0 and exists (select 1 from public.fid_clientes where restaurante_id = p_restaurante and cpf = cli.indicado_por) then
    perform public.fid_mover(p_restaurante, cli.indicado_por, 'indicacao', p_ind,
      'Indicação: ' || split_part(cli.nome, ' ', 1)
        || case when c -> 'indicacao' ->> 'quando' = 'compra' then ' fez a primeira compra' else ' entrou no clube' end);
  end if;
end $$;

-- Credita uma nota pendente com o valor conferido. Devolve os pontos.
create or replace function public.fid_creditar(p_chave text, p_valor numeric, p_emitida timestamptz, p_por text) returns int
language plpgsql security definer set search_path = public as $$
declare n public.fid_notas; calc jsonb; pts int;
begin
  select * into n from public.fid_notas where chave = p_chave for update;
  if not found or n.status <> 'pendente' then return null; end if;
  calc := public.fid_calcular(n.restaurante_id, p_valor, coalesce(p_emitida, n.lida_em), n.cpf);
  pts := (calc ->> 'pontos')::int;
  update public.fid_notas
     set status = 'creditada', valor = p_valor, emitida_em = coalesce(p_emitida, n.emitida_em, n.lida_em),
         pontos = pts, mult = (calc ->> 'mult')::numeric, conferida_em = now(), conferida_por = left(p_por, 60), motivo = null
   where chave = p_chave;
  perform public.fid_mover(n.restaurante_id, n.cpf, 'compra', pts,
    'Compra de ' || public.brl(p_valor) || coalesce(' · ' || (calc ->> 'boost'), '') || coalesce(' · nível ' || (calc ->> 'nivel'), '')
      || case when (calc ->> 'mult')::numeric > 1
              then ' (' || replace(rtrim(rtrim(to_char((calc ->> 'mult')::numeric, 'FM990.99'), '0'), '.'), '.', ',') || 'x)' else '' end,
    p_valor, (calc ->> 'mult')::numeric, p_chave, null, p_por);
  perform public.fid_bonus_indicacao(n.restaurante_id, n.cpf);
  return pts;
end $$;

-- Confere uma nota pendente com o XML importado.
create or replace function public.fid_conferir_xml(p_chave text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n public.fid_notas; x public.fid_xml; v_motivo text; ini timestamptz; prazo int; pts int;
begin
  select * into n from public.fid_notas where chave = p_chave for update;
  if not found then return jsonb_build_object('status', 'inexistente'); end if;
  if n.status <> 'pendente' then return jsonb_build_object('status', n.status, 'pontos', n.pontos); end if;
  select * into x from public.fid_xml where chave = p_chave;
  if not found or (not x.cancelada and (x.valor is null or x.emitida_em is null)) then
    return jsonb_build_object('status', 'pendente');
  end if;
  -- Nota sem CPF ou com o CPF de outra pessoa: sai da conta (o dono do CPF ainda pode usar).
  if not x.cancelada and (x.cpf is null or x.cpf <> n.cpf) then
    delete from public.fid_notas where chave = p_chave;
    return jsonb_build_object('status', 'recusada', 'motivo',
      case when x.cpf is null then 'A nota foi emitida sem CPF. Peça o CPF na nota da próxima vez.'
           else 'O CPF desta nota é de outra pessoa.' end);
  end if;
  ini := public.fid_inicio(n.restaurante_id);
  prazo := public.fid_prazo(n.restaurante_id);
  v_motivo := case
    when x.cancelada then 'Esta nota foi cancelada.'
    when ini is not null and x.emitida_em < ini then 'A compra foi antes do início do programa.'
    when n.lida_em > x.emitida_em + make_interval(days => prazo) then 'A nota foi registrada depois do prazo de ' || prazo || ' dias.'
  end;
  if v_motivo is not null then
    update public.fid_notas set status = 'recusada', motivo = v_motivo, valor = x.valor, emitida_em = x.emitida_em,
           conferida_em = now(), conferida_por = 'XML da nota'
     where chave = p_chave;
    return jsonb_build_object('status', 'recusada', 'motivo', v_motivo);
  end if;
  pts := public.fid_creditar(p_chave, x.valor, x.emitida_em, 'XML da nota');
  return jsonb_build_object('status', 'creditada', 'pontos', pts, 'valor', x.valor);
end $$;

-- Nota do XML com CPF de cliente cadastrado: credita mesmo sem o QR ter sido lido.
create or replace function public.fid_auto_creditar(p_chave text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare x public.fid_xml; cli public.fid_clientes; ini timestamptz;
begin
  select * into x from public.fid_xml where chave = p_chave;
  if not found or x.cancelada or x.cpf is null or x.valor is null or x.emitida_em is null then return null; end if;
  if exists (select 1 from public.fid_notas where chave = p_chave) then return null; end if;
  select * into cli from public.fid_clientes where restaurante_id = x.restaurante_id and cpf = x.cpf;
  if not found then return jsonb_build_object('status', 'sem_cadastro'); end if;
  ini := public.fid_inicio(x.restaurante_id);
  -- Vale a compra feita depois do cadastro ou até o prazo antes dele.
  if (ini is not null and x.emitida_em < ini)
     or x.emitida_em < cli.criado_em - make_interval(days => public.fid_prazo(x.restaurante_id)) then
    return null;
  end if;
  insert into public.fid_notas (chave, restaurante_id, cpf, lida_em, lida_por)
  values (p_chave, x.restaurante_id, x.cpf, x.emitida_em, 'XML da nota');
  return public.fid_conferir_xml(p_chave);
end $$;

-- Motivo para não aceitar a chave neste restaurante (null = ok).
create or replace function public.fid_chave_problema(p_restaurante uuid, p_chave text) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  c jsonb := public.fid_cfg(p_restaurante);
  mes date; ini timestamptz;
  hoje date := (now() at time zone public.fid_fuso(p_restaurante))::date;
begin
  if not public.chave_valida(p_chave) then return 'Chave de acesso inválida. Confira os 44 números da nota.'; end if;
  if substr(p_chave, 21, 2) not in ('65', '59') then return 'Esta não é uma nota fiscal de consumidor (NFC-e).'; end if;
  if jsonb_typeof(c -> 'cnpjs') <> 'array' or jsonb_array_length(c -> 'cnpjs') = 0 then
    return 'O restaurante ainda não cadastrou o CNPJ das notas. Avise a equipe.';
  end if;
  if not (c -> 'cnpjs') @> to_jsonb(substr(p_chave, 7, 14)) then return 'Esta nota é de outro estabelecimento.'; end if;
  mes := make_date(2000 + substr(p_chave, 3, 2)::int, substr(p_chave, 5, 2)::int, 1);
  if mes > hoje then return 'Chave de acesso inválida. Confira os 44 números da nota.'; end if;
  if (mes + interval '1 month')::date + public.fid_prazo(p_restaurante) < hoje then
    return 'Esta nota passou do prazo para ganhar pontos.';
  end if;
  ini := public.fid_inicio(p_restaurante);
  if ini is not null and (mes + interval '1 month')::date <= (ini at time zone public.fid_fuso(p_restaurante))::date then
    return 'A compra foi antes do início do programa.';
  end if;
  return null;
end $$;

-- ---------- Cliente (sem login: CPF para achar a conta, PIN para gastar) ----------
create or replace function public.fid_programa(p_restaurante uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c jsonb; hoje date;
begin
  if not public.fid_no_ar(p_restaurante) then return jsonb_build_object('ativo', false); end if;
  c := public.fid_cfg(p_restaurante);
  hoje := (now() at time zone public.fid_fuso(p_restaurante))::date;
  return jsonb_build_object(
    'ativo', true,
    'nome', left(coalesce(nullif(btrim(c ->> 'nome'), ''), 'Clube de pontos'), 40),
    'pontosPorReal', least(greatest(public.num_ou(c ->> 'pontosPorReal', 1), 0), 1000),
    'prazoDias', public.fid_prazo(p_restaurante),
    'regulamento', left(coalesce(c ->> 'regulamento', ''), 4000),
    'indicacao', case when coalesce(c -> 'indicacao' ->> 'ativo', '') = 'true' then jsonb_build_object('ativo', true,
        'indicador', least(greatest(public.num_ou(c -> 'indicacao' ->> 'indicador', 0), 0), 100000)::int,
        'indicado', least(greatest(public.num_ou(c -> 'indicacao' ->> 'indicado', 0), 0), 100000)::int,
        'quando', case when c -> 'indicacao' ->> 'quando' = 'compra' then 'compra' else 'cadastro' end)
      else jsonb_build_object('ativo', false) end,
    'boosts', coalesce((select jsonb_agg(jsonb_build_object('nome', b ->> 'nome', 'mult', least(greatest(public.num_ou(b ->> 'mult', 1), 1), 10),
          'dias', case when jsonb_typeof(b -> 'dias') = 'array' then b -> 'dias' else '[]'::jsonb end,
          'de', coalesce(b ->> 'de', ''), 'ate', coalesce(b ->> 'ate', ''), 'inicio', coalesce(b ->> 'inicio', ''), 'fim', coalesce(b ->> 'fim', '')))
        from jsonb_array_elements(case when jsonb_typeof(c -> 'boosts') = 'array' then c -> 'boosts' else '[]'::jsonb end) b
       where coalesce(b ->> 'ativo', 'true') <> 'false' and public.num_ou(b ->> 'mult', 1) > 1
         and not (coalesce(b ->> 'fim', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and (b ->> 'fim')::date < hoje)), '[]'::jsonb),
    'niveis', case when jsonb_array_length(public.fid_niveis(p_restaurante)) > 0 then jsonb_build_object('ativo', true,
        'base', case when c -> 'niveis' ->> 'base' = 'meses' then 'meses' else 'sempre' end,
        'meses', least(greatest(public.num_ou(c -> 'niveis' ->> 'meses', 12), 1), 60)::int,
        'lista', public.fid_niveis(p_restaurante))
      else jsonb_build_object('ativo', false) end,
    'premios', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'nome', nome, 'descricao', descricao, 'pontos', pontos, 'imagem', imagem,
          'nivel_min', nivel_min) order by ordem, pontos, nome)
        from public.fid_premios where restaurante_id = p_restaurante and ativo), '[]'::jsonb));
end $$;

-- Achar a conta pelo CPF: só o primeiro nome e o saldo.
create or replace function public.fid_consultar(p_restaurante uuid, p_cpf text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_cpf text := regexp_replace(coalesce(p_cpf, ''), '[^0-9]', '', 'g'); cli public.fid_clientes;
begin
  if not public.fid_no_ar(p_restaurante) then return jsonb_build_object('status', 'inativo'); end if;
  if not public.cpf_valido(v_cpf) then return jsonb_build_object('status', 'erro', 'mensagem', 'CPF inválido. Confira os números.'); end if;
  if not public.equipe_pode_tentar('fid-consulta:' || public.ip_do_pedido(), 120, 10) then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Muitas consultas seguidas. Aguarde alguns minutos.');
  end if;
  select * into cli from public.fid_clientes where restaurante_id = p_restaurante and cpf = v_cpf;
  if not found then return jsonb_build_object('status', 'novo'); end if;
  return jsonb_build_object('status', 'ok', 'nome', split_part(cli.nome, ' ', 1), 'pontos', cli.pontos,
    'nivel', public.fid_nivel(p_restaurante, v_cpf),
    'pendentes', (select count(*) from public.fid_notas where restaurante_id = p_restaurante and cpf = v_cpf and status = 'pendente'),
    'tem_pin', exists (select 1 from private.fid_pins where restaurante_id = p_restaurante and cpf = v_cpf));
end $$;

-- Primeiro nome de quem indicou (para mostrar no cadastro).
create or replace function public.fid_indicador(p_restaurante uuid, p_codigo text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_nome text;
begin
  if not public.fid_no_ar(p_restaurante) then return jsonb_build_object('status', 'inativo'); end if;
  if not public.equipe_pode_tentar('fid-indicador:' || public.ip_do_pedido(), 60, 10) then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Muitas consultas seguidas. Aguarde alguns minutos.');
  end if;
  select split_part(nome, ' ', 1) into v_nome from public.fid_clientes
   where restaurante_id = p_restaurante and codigo = upper(regexp_replace(coalesce(p_codigo, ''), '[^A-Za-z0-9]', '', 'g'));
  return case when v_nome is null then jsonb_build_object('status', 'nao') else jsonb_build_object('status', 'ok', 'nome', v_nome) end;
end $$;

create or replace function public.fid_nova_sessao(p_restaurante uuid, p_cpf text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_token uuid := gen_random_uuid();
begin
  delete from private.fid_sessoes where criado_em < now() - interval '180 days';
  insert into private.fid_sessoes (token_hash, restaurante_id, cpf) values (public.hash_token(v_token), p_restaurante, p_cpf);
  return v_token;
end $$;

create or replace function public.fid_cadastrar(p_restaurante uuid, p_cpf text, p_nome text, p_email text, p_telefone text,
  p_pin text, p_marketing boolean default false, p_indicacao text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_cpf   text := regexp_replace(coalesce(p_cpf, ''), '[^0-9]', '', 'g');
  v_nome  text := left(btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')), 80);
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_tel   text := regexp_replace(coalesce(p_telefone, ''), '[^0-9]', '', 'g');
  v_ind   text := upper(regexp_replace(coalesce(p_indicacao, ''), '[^A-Za-z0-9]', '', 'g'));
  v_indicador text;
  v_codigo text;
  c jsonb := public.fid_cfg(p_restaurante);
  erro text;
begin
  if not public.fid_no_ar(p_restaurante) then return jsonb_build_object('status', 'inativo'); end if;
  if char_length(v_tel) in (12, 13) and v_tel like '55%' then v_tel := substr(v_tel, 3); end if;
  erro := case
    when not public.cpf_valido(v_cpf) then 'CPF inválido. Confira os números.'
    when v_nome !~ '^\S{2,}( \S+)+$' then 'Informe seu nome completo (nome e sobrenome).'
    when char_length(v_email) > 120 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then 'E-mail inválido.'
    when v_tel !~ '^[1-9][0-9]{9,10}$' then 'Telefone inválido. Use DDD + número.'
    when coalesce(p_pin, '') !~ '^[0-9]{4}$' then 'O PIN tem 4 números.'
  end;
  if erro is not null then return jsonb_build_object('status', 'erro', 'mensagem', erro); end if;
  if not public.equipe_pode_tentar('fid-cadastro:' || public.ip_do_pedido(), 40, 60) then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Muitos cadastros deste aparelho. Tente mais tarde.');
  end if;
  if exists (select 1 from public.fid_clientes where restaurante_id = p_restaurante and cpf = v_cpf) then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Este CPF já tem cadastro. Entre com o seu PIN.', 'existe', true);
  end if;
  if v_ind <> '' and coalesce(c -> 'indicacao' ->> 'ativo', '') = 'true' then
    select cpf into v_indicador from public.fid_clientes where restaurante_id = p_restaurante and codigo = v_ind;
    if v_indicador is null then
      return jsonb_build_object('status', 'erro', 'mensagem', 'Código de indicação não encontrado. Confira ou deixe em branco.');
    end if;
  end if;
  loop
    v_codigo := public.novo_codigo(6);
    exit when not exists (select 1 from public.fid_clientes where restaurante_id = p_restaurante and codigo = v_codigo);
  end loop;
  insert into public.fid_clientes (restaurante_id, cpf, nome, email, telefone, codigo, indicado_por, marketing)
  values (p_restaurante, v_cpf, v_nome, v_email, v_tel, v_codigo, v_indicador, coalesce(p_marketing, false));
  insert into private.fid_pins (restaurante_id, cpf, pin_hash)
  values (p_restaurante, v_cpf, extensions.crypt(p_pin, extensions.gen_salt('bf')));
  -- Indicação paga no cadastro (padrão) ou só na primeira compra, conforme as regras.
  if coalesce(c -> 'indicacao' ->> 'quando', '') <> 'compra' then
    perform public.fid_bonus_indicacao(p_restaurante, v_cpf);
  end if;
  -- Notas com este CPF que a equipe já importou entram na hora.
  perform public.fid_auto_creditar(x.chave) from public.fid_xml x
   where x.restaurante_id = p_restaurante and x.cpf = v_cpf;
  return jsonb_build_object('status', 'ok', 'token', public.fid_nova_sessao(p_restaurante, v_cpf));
end $$;

create or replace function public.fid_entrar(p_restaurante uuid, p_cpf text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_cpf text := regexp_replace(coalesce(p_cpf, ''), '[^0-9]', '', 'g'); h text;
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
  select pin_hash into h from private.fid_pins where restaurante_id = p_restaurante and cpf = v_cpf;
  if h is null then
    -- PIN redefinido pela equipe: o próximo PIN digitado passa a valer.
    insert into private.fid_pins (restaurante_id, cpf, pin_hash)
    values (p_restaurante, v_cpf, extensions.crypt(p_pin, extensions.gen_salt('bf')));
  elsif extensions.crypt(p_pin, h) <> h then
    return jsonb_build_object('status', 'erro', 'mensagem', 'PIN incorreto.');
  end if;
  perform public.equipe_limpar_tentativas('fid-pin:' || p_restaurante || ':' || v_cpf);
  perform public.equipe_limpar_tentativas('fid-pin-dia:' || p_restaurante || ':' || v_cpf);
  return jsonb_build_object('status', 'ok', 'token', public.fid_nova_sessao(p_restaurante, v_cpf), 'pin_novo', h is null);
end $$;

-- Conta completa (aparelho com PIN confirmado).
create or replace function public.fid_conta(p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_r uuid; v_cpf text; cli public.fid_clientes;
begin
  select s.restaurante_id, s.cpf into v_r, v_cpf from private.fid_sessoes s
   where s.token_hash = public.hash_token(p_token) and s.criado_em > now() - interval '180 days';
  if v_r is null then return jsonb_build_object('status', 'sem_sessao'); end if;
  select * into cli from public.fid_clientes where restaurante_id = v_r and cpf = v_cpf;
  if not found then return jsonb_build_object('status', 'sem_sessao'); end if;
  return jsonb_build_object('status', 'ok',
    'cpf', cli.cpf, 'nome', cli.nome, 'email', cli.email, 'telefone', cli.telefone, 'pontos', cli.pontos,
    'codigo', cli.codigo, 'marketing', cli.marketing, 'criado_em', cli.criado_em,
    'nivel', public.fid_atualizar_nivel(v_r, v_cpf, false),
    'indicacoes', (select count(*) from public.fid_clientes where restaurante_id = v_r and indicado_por = v_cpf),
    'notas', coalesce((select jsonb_agg(jsonb_build_object('chave', n.chave, 'status', n.status, 'valor', coalesce(n.valor, n.valor_informado),
          'pontos', n.pontos, 'lida_em', n.lida_em, 'motivo', n.motivo) order by n.lida_em desc)
        from (select * from public.fid_notas where restaurante_id = v_r and cpf = v_cpf order by lida_em desc limit 20) n), '[]'::jsonb),
    'movimentos', coalesce((select jsonb_agg(jsonb_build_object('tipo', m.tipo, 'pontos', m.pontos, 'descricao', m.descricao, 'criado_em', m.criado_em) order by m.criado_em desc, m.id desc)
        from (select * from public.fid_movimentos where restaurante_id = v_r and cpf = v_cpf order by criado_em desc, id desc limit 40) m), '[]'::jsonb),
    'resgates', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'premio', x.premio_nome, 'pontos', x.pontos, 'codigo', x.codigo,
          'status', x.status, 'criado_em', x.criado_em) order by x.criado_em desc)
        from (select * from public.fid_resgates where restaurante_id = v_r and cpf = v_cpf
                and (status = 'pendente' or criado_em > now() - interval '60 days') order by criado_em desc limit 15) x), '[]'::jsonb));
end $$;

create or replace function public.fid_sair(p_token uuid) returns void
language sql security definer set search_path = public as $$
  delete from private.fid_sessoes where token_hash = public.hash_token(p_token);
$$;

-- Registrar uma nota pelo QR (ou chave digitada). Cliente ou equipe.
-- Devolve status em vez de lançar erro: um erro desfaria o registro da tentativa.
create or replace function public.fid_registrar_nota(p_restaurante uuid, p_cpf text, p_qr text, p_valor numeric default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_cpf   text := regexp_replace(coalesce(p_cpf, ''), '[^0-9]', '', 'g');
  v_txt   text := btrim(coalesce(p_qr, ''));
  v_chave text;
  v_url   text;
  v_equipe text;
  prob    text;
  n public.fid_notas;
begin
  if not public.fid_no_ar(p_restaurante) then return jsonb_build_object('status', 'inativo'); end if;
  if auth.uid() is not null then
    select nome into v_equipe from public.equipe_membros where user_id = auth.uid() and restaurante_id = p_restaurante;
  end if;
  if not public.cpf_valido(v_cpf) then return jsonb_build_object('status', 'erro', 'mensagem', 'CPF inválido. Confira os números.'); end if;
  if v_equipe is null and (not public.equipe_pode_tentar('fid-nota:' || public.ip_do_pedido(), 60, 10)
                           or not public.equipe_pode_tentar('fid-nota-cpf:' || p_restaurante || ':' || v_cpf, 12, 60)) then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Muitas notas em pouco tempo. Aguarde alguns minutos.');
  end if;
  if not exists (select 1 from public.fid_clientes where restaurante_id = p_restaurante and cpf = v_cpf) then
    return jsonb_build_object('status', 'sem_cadastro');
  end if;
  v_chave := substring(regexp_replace(v_txt, '[\s.-]', '', 'g') from '([0-9]{44})');
  if v_chave is null then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Não achamos a chave da nota. Leia o QR Code impresso na nota fiscal.');
  end if;
  prob := public.fid_chave_problema(p_restaurante, v_chave);
  if prob is not null then return jsonb_build_object('status', 'erro', 'mensagem', prob); end if;
  if v_txt ~* '^https?://[a-z0-9.-]+[.]gov[.]br/' then v_url := left(v_txt, 600); end if;
  select * into n from public.fid_notas where chave = v_chave;
  if found then
    if n.cpf <> v_cpf then
      return jsonb_build_object('status', 'erro', 'mensagem', 'Esta nota já foi registrada em outra conta.');
    end if;
    return jsonb_build_object('status', 'repetida', 'nota', n.status, 'pontos', n.pontos, 'motivo', n.motivo);
  end if;
  insert into public.fid_notas (chave, restaurante_id, cpf, url, valor_informado, lida_por)
  values (v_chave, p_restaurante, v_cpf, v_url,
          case when p_valor > 0 and p_valor < 100000 then round(p_valor, 2) end, coalesce(v_equipe, 'Cliente'));
  -- Se a equipe já importou o XML desta nota, confere na hora.
  if exists (select 1 from public.fid_xml where chave = v_chave) then
    return public.fid_conferir_xml(v_chave);
  end if;
  return jsonb_build_object('status', 'pendente');
end $$;

create or replace function public.fid_resgatar(p_token uuid, p_premio uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_r uuid; v_cpf text; cli public.fid_clientes; p public.fid_premios;
  v_id uuid; v_cod text; b bytea; nv jsonb; v_min int;
begin
  select s.restaurante_id, s.cpf into v_r, v_cpf from private.fid_sessoes s
   where s.token_hash = public.hash_token(p_token) and s.criado_em > now() - interval '180 days';
  if v_r is null then return jsonb_build_object('status', 'sem_sessao'); end if;
  if not public.fid_no_ar(v_r) then return jsonb_build_object('status', 'inativo'); end if;
  select * into p from public.fid_premios where id = p_premio and restaurante_id = v_r and ativo;
  if not found then return jsonb_build_object('status', 'erro', 'mensagem', 'Este prêmio não está mais disponível.'); end if;
  -- Prêmio exclusivo de um nível (se o nível não existe mais, vale para todos).
  if p.nivel_min is not null then
    select (i - 1)::int into v_min from jsonb_array_elements(public.fid_niveis(v_r)) with ordinality t(l, i) where l ->> 'id' = p.nivel_min;
    nv := public.fid_nivel(v_r, v_cpf);
    if v_min is not null and coalesce((nv ->> 'indice')::int, -1) < v_min then
      return jsonb_build_object('status', 'erro', 'mensagem', 'Este prêmio é exclusivo do nível '
        || (select l ->> 'nome' from jsonb_array_elements(public.fid_niveis(v_r)) l where l ->> 'id' = p.nivel_min) || ' em diante.');
    end if;
  end if;
  select * into cli from public.fid_clientes where restaurante_id = v_r and cpf = v_cpf for update;
  if cli.pontos < p.pontos then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Faltam ' || (p.pontos - cli.pontos) || ' pontos para este prêmio.');
  end if;
  if (select count(*) from public.fid_resgates where restaurante_id = v_r and cpf = v_cpf and status = 'pendente') >= 3 then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Você já tem 3 resgates esperando a entrega. Mostre os códigos ao garçom.');
  end if;
  b := extensions.gen_random_bytes(2);
  v_cod := lpad((((get_byte(b, 0) << 8) | get_byte(b, 1)) % 10000)::text, 4, '0');
  insert into public.fid_resgates (restaurante_id, cpf, premio_id, premio_nome, pontos, codigo)
  values (v_r, v_cpf, p.id, p.nome, p.pontos, v_cod) returning id into v_id;
  perform public.fid_mover(v_r, v_cpf, 'resgate', -p.pontos, 'Resgate: ' || p.nome, null, null, null, v_id, 'Cliente');
  return jsonb_build_object('status', 'ok', 'pontos', cli.pontos - p.pontos,
    'resgate', jsonb_build_object('id', v_id, 'premio', p.nome, 'pontos', p.pontos, 'codigo', v_cod, 'status', 'pendente', 'criado_em', now()));
end $$;

-- ---------- Equipe ----------
create or replace function public.fid_resumo() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r uuid := public.meu_restaurante();
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  return jsonb_build_object(
    'clientes', (select count(*) from public.fid_clientes where restaurante_id = r),
    'novos_30d', (select count(*) from public.fid_clientes where restaurante_id = r and criado_em > now() - interval '30 days'),
    'pontos', (select coalesce(sum(greatest(pontos, 0)), 0) from public.fid_clientes where restaurante_id = r),
    'notas_pendentes', (select count(*) from public.fid_notas where restaurante_id = r and status = 'pendente'),
    'resgates_pendentes', (select count(*) from public.fid_resgates where restaurante_id = r and status = 'pendente'),
    'compras_30d', (select count(*) from public.fid_notas where restaurante_id = r and status = 'creditada' and emitida_em > now() - interval '30 days'),
    'valor_30d', (select coalesce(sum(valor), 0) from public.fid_notas where restaurante_id = r and status = 'creditada' and emitida_em > now() - interval '30 days'),
    'entregues_30d', (select count(*) from public.fid_resgates where restaurante_id = r and status = 'entregue' and resolvido_em > now() - interval '30 days'),
    'ultimo_xml', (select max(importada_em) from public.fid_xml where restaurante_id = r));
end $$;

create or replace function public.fid_quem() returns text
language sql stable security definer set search_path = public as $$
  select nome from public.equipe_membros where user_id = auth.uid();
$$;

create or replace function public.fid_aprovar_nota(p_chave text, p_valor numeric, p_emitida timestamptz default null) returns int
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); n public.fid_notas;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  select * into n from public.fid_notas where chave = p_chave and restaurante_id = r;
  if not found or n.status <> 'pendente' then raise exception 'Esta nota não está mais esperando conferência.'; end if;
  if p_valor is null or p_valor <= 0 or p_valor >= 100000 then raise exception 'Informe o valor total da nota.'; end if;
  if p_emitida is not null and (p_emitida > now() + interval '1 hour' or p_emitida < n.lida_em - interval '400 days') then
    raise exception 'Data da compra inválida.';
  end if;
  return public.fid_creditar(p_chave, round(p_valor, 2), coalesce(p_emitida, n.lida_em), public.fid_quem());
end $$;

create or replace function public.fid_recusar_nota(p_chave text, p_motivo text) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante();
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  update public.fid_notas
     set status = 'recusada', motivo = left(coalesce(nullif(btrim(p_motivo), ''), 'Recusada pela equipe.'), 160),
         conferida_em = now(), conferida_por = public.fid_quem()
   where chave = p_chave and restaurante_id = r and status = 'pendente';
  if not found then raise exception 'Esta nota não está mais esperando conferência.'; end if;
end $$;

-- XML das NFC-e: [{ chave, cpf, valor, emitida_em, cancelada }], até 500 por vez.
create or replace function public.fid_importar_xml(p_notas jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r uuid := public.meu_restaurante();
  c jsonb;
  quem text := public.fid_quem();
  item jsonb; st jsonb; n public.fid_notas;
  v_chave text; v_cpf text; v_valor numeric; v_emit timestamptz; v_canc boolean;
  k_recebidas int := 0; k_invalidas int := 0; k_outro int := 0; k_creditadas int := 0; k_pontos int := 0;
  k_recusadas int := 0; k_canceladas int := 0; k_estornadas int := 0; k_sem_cadastro int := 0; k_sem_cpf int := 0;
  k_ja int := 0; k_ajustadas int := 0; calc jsonb; dif int;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  if not public.fid_liberado(r) then raise exception 'O programa de fidelidade não está liberado para este restaurante.'; end if;
  if jsonb_typeof(p_notas) <> 'array' or jsonb_array_length(p_notas) > 500 then raise exception 'Envie até 500 notas por vez.'; end if;
  c := public.fid_cfg(r);
  for item in select * from jsonb_array_elements(p_notas) loop
    k_recebidas := k_recebidas + 1;
    v_chave := item ->> 'chave';
    if not public.chave_valida(v_chave) then k_invalidas := k_invalidas + 1; continue; end if;
    if jsonb_typeof(c -> 'cnpjs') <> 'array' or not (c -> 'cnpjs') @> to_jsonb(substr(v_chave, 7, 14)) then
      k_outro := k_outro + 1; continue;
    end if;
    if exists (select 1 from public.fid_xml where chave = v_chave and restaurante_id <> r) then k_outro := k_outro + 1; continue; end if;
    v_canc := coalesce(item ->> 'cancelada', '') = 'true';
    if v_canc then
      insert into public.fid_xml (chave, restaurante_id, cancelada, importada_por) values (v_chave, r, true, quem)
      on conflict (chave) do update set cancelada = true;
      k_canceladas := k_canceladas + 1;
      select * into n from public.fid_notas where chave = v_chave for update;
      if found and n.status = 'creditada' then
        update public.fid_notas set status = 'estornada', motivo = 'Nota cancelada pelo restaurante.' where chave = v_chave;
        perform public.fid_mover(r, n.cpf, 'estorno', -coalesce(n.pontos, 0), 'Nota cancelada: ' || public.brl(n.valor),
          n.valor, null, v_chave, null, quem);
        k_estornadas := k_estornadas + 1;
      elsif found and n.status = 'pendente' then
        perform public.fid_conferir_xml(v_chave);
      end if;
      continue;
    end if;
    v_cpf := regexp_replace(coalesce(item ->> 'cpf', ''), '[^0-9]', '', 'g');
    if not public.cpf_valido(v_cpf) then v_cpf := null; end if;
    v_valor := public.num_ou(item ->> 'valor', null);
    begin
      v_emit := (item ->> 'emitida_em')::timestamptz;
    exception when others then
      v_emit := null;
    end;
    if v_valor is null or v_valor < 0 or v_valor >= 1000000 or v_emit is null then k_invalidas := k_invalidas + 1; continue; end if;
    insert into public.fid_xml (chave, restaurante_id, cpf, valor, emitida_em, importada_por)
    values (v_chave, r, v_cpf, round(v_valor, 2), v_emit, quem)
    on conflict (chave) do update set cpf = excluded.cpf, valor = excluded.valor, emitida_em = excluded.emitida_em,
      importada_em = now(), importada_por = excluded.importada_por;
    if v_cpf is null then k_sem_cpf := k_sem_cpf + 1; end if;
    select * into n from public.fid_notas where chave = v_chave for update;
    if found and n.status = 'pendente' then
      st := public.fid_conferir_xml(v_chave);
      -- Lida por outra pessoa: a nota volta a ser do dono do CPF.
      if st ->> 'status' = 'recusada' and v_cpf is not null and not exists (select 1 from public.fid_notas where chave = v_chave) then
        st := coalesce(public.fid_auto_creditar(v_chave), st);
      end if;
    elsif found and n.status = 'creditada' and coalesce(n.conferida_por, '') <> 'XML da nota' then
      -- Conferida à mão: o XML confirma ou corrige (valor, CPF e horário oficiais).
      if v_cpf is distinct from n.cpf then
        update public.fid_notas set status = 'estornada', motivo = 'O CPF do XML é diferente do cadastro.',
               conferida_em = now(), conferida_por = 'XML da nota' where chave = v_chave;
        perform public.fid_mover(r, n.cpf, 'ajuste', -coalesce(n.pontos, 0), 'Ajuste pelo XML: a nota tem outro CPF',
          n.valor, null, v_chave, null, quem);
        k_ajustadas := k_ajustadas + 1;
        if v_cpf is not null then
          delete from public.fid_notas where chave = v_chave;
          st := public.fid_auto_creditar(v_chave);
          if st ->> 'status' = 'creditada' then
            k_creditadas := k_creditadas + 1;
            k_pontos := k_pontos + coalesce((st ->> 'pontos')::int, 0);
          end if;
        end if;
        continue;
      end if;
      calc := public.fid_calcular(r, round(v_valor, 2), v_emit, n.cpf);
      dif := (calc ->> 'pontos')::int - coalesce(n.pontos, 0);
      update public.fid_notas set valor = round(v_valor, 2), emitida_em = v_emit, pontos = (calc ->> 'pontos')::int,
             mult = (calc ->> 'mult')::numeric, conferida_em = now(), conferida_por = 'XML da nota'
       where chave = v_chave;
      if dif <> 0 then
        perform public.fid_mover(r, n.cpf, 'ajuste', dif,
          'Ajuste pelo XML: valor da nota ' || public.brl(round(v_valor, 2)) || ' (lançado ' || public.brl(n.valor) || ')',
          round(v_valor, 2), (calc ->> 'mult')::numeric, v_chave, null, quem);
        k_ajustadas := k_ajustadas + 1;
      end if;
      k_ja := k_ja + 1;
      continue;
    elsif found then
      k_ja := k_ja + 1;
      continue;
    elsif v_cpf is not null then
      st := public.fid_auto_creditar(v_chave);
    else
      continue;
    end if;
    if st ->> 'status' = 'creditada' then
      k_creditadas := k_creditadas + 1;
      k_pontos := k_pontos + coalesce((st ->> 'pontos')::int, 0);
    elsif st ->> 'status' = 'recusada' then k_recusadas := k_recusadas + 1;
    elsif st ->> 'status' = 'sem_cadastro' then k_sem_cadastro := k_sem_cadastro + 1;
    end if;
  end loop;
  delete from public.fid_xml where restaurante_id = r and importada_em < now() - interval '400 days';
  return jsonb_build_object('recebidas', k_recebidas, 'invalidas', k_invalidas, 'outro_cnpj', k_outro,
    'creditadas', k_creditadas, 'pontos', k_pontos, 'recusadas', k_recusadas, 'canceladas', k_canceladas,
    'estornadas', k_estornadas, 'sem_cadastro', k_sem_cadastro, 'sem_cpf', k_sem_cpf, 'ja_conferidas', k_ja,
    'ajustadas', k_ajustadas);
end $$;

create or replace function public.fid_resgate_decidir(p_id uuid, p_entregar boolean) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); x public.fid_resgates;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  update public.fid_resgates
     set status = case when p_entregar then 'entregue' else 'cancelado' end, resolvido_em = now(), resolvido_por = public.fid_quem()
   where id = p_id and restaurante_id = r and status = 'pendente'
  returning * into x;
  if not found then raise exception 'Este resgate já foi resolvido.'; end if;
  if not p_entregar then
    perform public.fid_mover(r, x.cpf, 'estorno', x.pontos, 'Resgate cancelado: ' || x.premio_nome, null, null, null, x.id, public.fid_quem());
  end if;
end $$;

-- Lançamento manual (só se o restaurante permitir nas regras). Fica no extrato com o nome de quem lançou.
create or replace function public.fid_lancar(p_cpf text, p_valor numeric, p_descricao text) returns int
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); calc jsonb; pts int; v_desc text := left(btrim(coalesce(p_descricao, '')), 100);
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  if not public.fid_no_ar(r) then raise exception 'O programa de fidelidade não está ativo.'; end if;
  if coalesce(public.fid_cfg(r) ->> 'manual', '') <> 'true' then raise exception 'O lançamento manual está desligado nas regras do programa.'; end if;
  if not exists (select 1 from public.fid_clientes where restaurante_id = r and cpf = p_cpf) then raise exception 'Cliente não encontrado.'; end if;
  if p_valor is null or p_valor <= 0 or p_valor >= 100000 then raise exception 'Informe o valor da compra.'; end if;
  if v_desc = '' then raise exception 'Informe o motivo (ex.: pedido do delivery nº 123).'; end if;
  calc := public.fid_calcular(r, p_valor, now(), p_cpf);
  pts := (calc ->> 'pontos')::int;
  perform public.fid_mover(r, p_cpf, 'manual', pts, 'Lançado: ' || v_desc || ' · ' || public.brl(p_valor),
    round(p_valor, 2), (calc ->> 'mult')::numeric, null, null, public.fid_quem());
  perform public.fid_bonus_indicacao(r, p_cpf);
  return pts;
end $$;

-- Nível atual de um cliente (ficha da equipe); atualiza o nível guardado.
create or replace function public.fid_nivel_cliente(p_cpf text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante();
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  if not exists (select 1 from public.fid_clientes where restaurante_id = r and cpf = p_cpf) then return null; end if;
  return public.fid_atualizar_nivel(r, p_cpf, false);
end $$;

create or replace function public.fid_redefinir_pin(p_cpf text) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante();
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  delete from private.fid_pins where restaurante_id = r and cpf = p_cpf;
  delete from private.fid_sessoes where restaurante_id = r and cpf = p_cpf;
end $$;

create or replace function public.fid_excluir_cliente(p_cpf text) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante();
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  update public.fid_clientes set indicado_por = null where restaurante_id = r and indicado_por = p_cpf;
  delete from public.fid_clientes where restaurante_id = r and cpf = p_cpf;
end $$;

create or replace function public.fid_editar_cliente(p_cpf text, p_nome text, p_email text, p_telefone text, p_marketing boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  r uuid := public.meu_restaurante();
  v_nome  text := left(btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')), 80);
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_tel   text := regexp_replace(coalesce(p_telefone, ''), '[^0-9]', '', 'g');
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  if char_length(v_tel) in (12, 13) and v_tel like '55%' then v_tel := substr(v_tel, 3); end if;
  if v_nome !~ '^\S{2,}( \S+)+$' then raise exception 'Informe o nome completo.'; end if;
  if char_length(v_email) > 120 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido.'; end if;
  if v_tel !~ '^[1-9][0-9]{9,10}$' then raise exception 'Telefone inválido. Use DDD + número.'; end if;
  update public.fid_clientes set nome = v_nome, email = v_email, telefone = v_tel, marketing = coalesce(p_marketing, marketing)
   where restaurante_id = r and cpf = p_cpf;
  if not found then raise exception 'Cliente não encontrado.'; end if;
end $$;

-- Leitura pela equipe (só o próprio restaurante); mudanças só pelas funções acima.
alter table public.fid_clientes enable row level security;
alter table public.fid_movimentos enable row level security;
alter table public.fid_notas enable row level security;
alter table public.fid_xml enable row level security;
alter table public.fid_premios enable row level security;
alter table public.fid_resgates enable row level security;
revoke all on public.fid_clientes, public.fid_movimentos, public.fid_notas, public.fid_xml, public.fid_premios, public.fid_resgates from anon;
revoke insert, update, delete, truncate on public.fid_clientes, public.fid_movimentos, public.fid_notas, public.fid_xml, public.fid_resgates from authenticated;

drop policy if exists "equipe ve clientes da fidelidade" on public.fid_clientes;
create policy "equipe ve clientes da fidelidade" on public.fid_clientes
  for select to authenticated using (restaurante_id = public.meu_restaurante());
drop policy if exists "equipe ve extrato da fidelidade" on public.fid_movimentos;
create policy "equipe ve extrato da fidelidade" on public.fid_movimentos
  for select to authenticated using (restaurante_id = public.meu_restaurante());
drop policy if exists "equipe ve notas da fidelidade" on public.fid_notas;
create policy "equipe ve notas da fidelidade" on public.fid_notas
  for select to authenticated using (restaurante_id = public.meu_restaurante());
drop policy if exists "equipe ve xml da fidelidade" on public.fid_xml;
create policy "equipe ve xml da fidelidade" on public.fid_xml
  for select to authenticated using (restaurante_id = public.meu_restaurante());
drop policy if exists "equipe ve resgates da fidelidade" on public.fid_resgates;
create policy "equipe ve resgates da fidelidade" on public.fid_resgates
  for select to authenticated using (restaurante_id = public.meu_restaurante());
drop policy if exists "equipe gerencia premios" on public.fid_premios;
create policy "equipe gerencia premios" on public.fid_premios
  for all to authenticated using (restaurante_id = public.meu_restaurante())
  with check (restaurante_id = public.meu_restaurante());


-- ---------------------------------------------------------------------------
-- Plano: a central muda o de qualquer restaurante; a equipe muda o seu (serviços e mesas).
-- ---------------------------------------------------------------------------
create or replace function public.plano_alterar_central(p_restaurante uuid, p_plano jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.eh_operador() then raise exception 'Acesso negado.'; end if;
  return public.plano_aplicar(p_restaurante, p_plano, 'central',
    coalesce((select email from auth.users where id = auth.uid()), 'central'));
end $$;

create or replace function public.meu_plano() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); p jsonb;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  p := public.plano_de(r);
  return jsonb_build_object('plano', p, 'mensal', public.plano_preco(p),
    'historico', coalesce((select jsonb_agg(jsonb_build_object('criado_em', criado_em, 'origem', origem, 'por', por,
        'antes', antes, 'depois', depois, 'mensal_antes', mensal_antes, 'mensal_depois', mensal_depois) order by criado_em desc)
      from (select * from public.plano_mudancas where restaurante_id = r order by criado_em desc limit 20) m), '[]'::jsonb));
end $$;

-- Upsell/downsell pelo próprio restaurante: muda serviços e mesas; domínio e contrato ficam com a central.
create or replace function public.meu_plano_alterar(p_plano jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); atual jsonb;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  if not public.eu_admin() then raise exception 'Só o administrador do restaurante pode mudar o plano.'; end if;
  atual := public.plano_de(r);
  return public.plano_aplicar(r, jsonb_build_object('servicos', p_plano -> 'servicos', 'mesas', p_plano -> 'mesas',
    'dominio', atual -> 'dominio', 'contrato', atual -> 'contrato', 'inicio', atual -> 'inicio'),
    'restaurante', coalesce(public.fid_quem(), 'Equipe'));
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
    'public.limita_chamados()',
    'public.num_ou(text, numeric)', 'public.ip_do_pedido()', 'public.cpf_valido(text)', 'public.chave_valida(text)',
    'public.brl(numeric)', 'public.fid_cfg(uuid)', 'public.fid_liberado(uuid)', 'public.fid_no_ar(uuid)',
    'public.fid_fuso(uuid)', 'public.fid_prazo(uuid)', 'public.fid_inicio(uuid)', 'public.fid_boost(uuid, timestamptz)',
    'public.fid_calcular(uuid, numeric, timestamptz, text)', 'public.fid_niveis(uuid)',
    'public.fid_pontos_nivel(uuid, text)', 'public.fid_nivel(uuid, text)', 'public.fid_atualizar_nivel(uuid, text, boolean)',
    'public.fid_mover(uuid, text, text, int, text, numeric, numeric, text, uuid, text)',
    'public.fid_bonus_indicacao(uuid, text)', 'public.fid_creditar(text, numeric, timestamptz, text)',
    'public.fid_conferir_xml(text)', 'public.fid_auto_creditar(text)', 'public.fid_chave_problema(uuid, text)',
    'public.fid_nova_sessao(uuid, text)', 'public.fid_quem()',
    'public.plano_normalizar(jsonb)', 'public.plano_de(uuid)', 'public.plano_preco(jsonb)', 'public.plano_tem(uuid, text)',
    'public.plano_aplicar(uuid, jsonb, text, text)'] loop
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
    'public.sessao_sair(uuid)', 'public.chamar(uuid, text, text, text, jsonb)', 'public.chamado_cancelar(uuid, uuid)',
    'public.fid_programa(uuid)', 'public.fid_consultar(uuid, text)', 'public.fid_indicador(uuid, text)',
    'public.fid_cadastrar(uuid, text, text, text, text, text, boolean, text)', 'public.fid_entrar(uuid, text, text)',
    'public.fid_conta(uuid)', 'public.fid_sair(uuid)', 'public.fid_registrar_nota(uuid, text, text, numeric)',
    'public.fid_resgatar(uuid, uuid)'] loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
  -- Logados (cada função confere se é equipe ou operador).
  foreach f in array array[
    'public.salvar_config(jsonb)', 'public.etiqueta_vincular(text, int)', 'public.etiqueta_desvincular(text)',
    'public.limpar_etiquetas(text[], text)',
    'public.sessao_decidir(uuid, boolean)', 'public.mesa_fechar(int)',
    'public.criar_restaurante(text, text, text)', 'public.central_senha_equipe(uuid, text)',
    'public.trocar_codigo_ativacao(uuid)', 'public.gerar_etiquetas(int, text)',
    'public.atribuir_etiquetas(text[], uuid)', 'public.marcar_gravadas(text[], boolean)', 'public.metricas(int)',
    'public.fid_resumo()', 'public.fid_aprovar_nota(text, numeric, timestamptz)', 'public.fid_recusar_nota(text, text)',
    'public.fid_importar_xml(jsonb)', 'public.fid_resgate_decidir(uuid, boolean)', 'public.fid_lancar(text, numeric, text)',
    'public.fid_redefinir_pin(text)', 'public.fid_excluir_cliente(text)', 'public.fid_nivel_cliente(text)',
    'public.plano_alterar_central(uuid, jsonb)', 'public.meu_plano()', 'public.meu_plano_alterar(jsonb)',
    'public.fid_editar_cliente(text, text, text, text, boolean)'] loop
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
  foreach t in array array['chamados', 'comentarios', 'sessoes', 'mesas_abertas', 'etiquetas', 'fid_notas', 'fid_resgates'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
