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
-- Configuração do delivery (faixas de taxa, pedido mínimo, pagamentos…).
alter table public.restaurantes add column if not exists delivery jsonb;
-- Prorrogação (adicional): nome, frase, minutos por chopp, duração, teto, horário limite e agenda.
alter table public.restaurantes add column if not exists prorrogacao jsonb;
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
-- A mensalidade segue a tabela de preços (assets/js/precos.js): página com sino 79 (o sino vem incluso) + 229 + 169
-- + Prorrogação 89 (adicional que entra no combo); 2 itens −10%, 3 −17% (arredondado para terminar em 9), os quatro por R$ 449.
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
    -- Adicionais (cobrados à parte, fora do desconto de combo).
    'adicionais', jsonb_build_object('prorrogacao', coalesce(p -> 'adicionais' ->> 'prorrogacao', '') = 'true'),
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
      'mesas', 500, 'dominio', 'sub', 'adicionais', jsonb_build_object('prorrogacao', false), 'contrato', 6, 'inicio', null, 'definido', false)
    else jsonb_build_object('adicionais', jsonb_build_object('prorrogacao', false)) || plano end
  from public.restaurantes where id = p_restaurante;
$$;

-- Preço mensal de cada adicional (o mesmo de Precos.ADICIONAIS). A Prorrogação entra no desconto de combo.
create or replace function public.adicional_preco(p_adicional text) returns numeric language sql immutable as $$
  select (case p_adicional when 'prorrogacao' then 89 else 0 end)::numeric;
$$;

-- Mensalidade do plano, em reais.
create or replace function public.plano_preco(p jsonb) returns numeric
language plpgsql immutable set search_path = public as $$
declare
  sv jsonb := coalesce(p -> 'servicos', '{}'::jsonb);
  soma numeric := 0; n int := 0; total numeric;
begin
  -- O sino (garcom) vem incluso na página: quem tem só o sino paga a página.
  if coalesce(sv ->> 'pagina', '') = 'true' or coalesce(sv ->> 'garcom', '') = 'true' then soma := soma + 79; n := n + 1; end if;
  if coalesce(sv ->> 'fidelidade', '') = 'true' then soma := soma + 229; n := n + 1; end if;
  if coalesce(sv ->> 'delivery', '') = 'true' then soma := soma + 169; n := n + 1; end if;
  -- A Prorrogação fica em plano.adicionais, mas entra no combo como os serviços.
  if coalesce(p -> 'adicionais' ->> 'prorrogacao', '') = 'true' then soma := soma + public.adicional_preco('prorrogacao'); n := n + 1; end if;
  total := case
    when n = 4 then 449
    when n = 3 then least(soma, floor(soma * 0.83 / 10) * 10 + 9)
    when n = 2 then least(soma, floor(soma * 0.90 / 10) * 10 + 9)
    else soma end;
  return total + (case when p ->> 'dominio' in ('proprio', 'registro') then 19 else 0 end);
end $$;

create or replace function public.plano_tem(p_restaurante uuid, p_servico text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.plano_de(p_restaurante) -> 'servicos' ->> p_servico, '') = 'true';
$$;

create or replace function public.plano_adicional(p_restaurante uuid, p_adicional text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.plano_de(p_restaurante) -> 'adicionais' ->> p_adicional, '') = 'true';
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
-- Taxa única da mudança: diferença da implantação quando o restaurante sobe de faixa de mesas.
alter table public.plano_mudancas add column if not exists taxa_unica numeric(10, 2) not null default 0;
create index if not exists plano_mudancas_rest_idx on public.plano_mudancas (restaurante_id, criado_em desc);
create index if not exists plano_mudancas_visto_idx on public.plano_mudancas (visto, criado_em desc);
alter table public.plano_mudancas enable row level security;
revoke all on public.plano_mudancas from anon;
drop policy if exists "operador ve mudancas" on public.plano_mudancas;
create policy "operador ve mudancas" on public.plano_mudancas
  for all to authenticated using (public.eh_operador()) with check (public.eh_operador());

-- Aplica um plano: guarda, sincroniza a fidelidade, corta mesas acima do contratado e registra a mudança.
-- Implantação por faixa de mesas (a mesma tabela de Precos.IMPLANTACAO): até 20, 21 a 50, 51 ou mais.
create or replace function public.implantacao_faixa(p_mesas int) returns numeric language sql immutable as $$
  select (case when coalesce(p_mesas, 0) <= 20 then 690 when p_mesas <= 50 then 990 else 1390 end)::numeric;
$$;

-- Maior faixa de implantação que o restaurante já pagou: o plano atual e todas as mudanças anteriores.
-- Assim, diminuir as mesas e aumentar de novo não cobra duas vezes. Plano ainda não definido: 0.
create or replace function public.implantacao_paga(p_restaurante uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select case when not coalesce((public.plano_de(p_restaurante) ->> 'definido')::boolean, false) then 0
    else greatest(public.implantacao_faixa((public.plano_de(p_restaurante) ->> 'mesas')::int),
      coalesce((select max(public.implantacao_faixa((m.depois ->> 'mesas')::int)) from public.plano_mudancas m where m.restaurante_id = p_restaurante), 0)) end;
$$;

-- Taxa única ao subir de faixa pelo painel: a diferença da implantação (metade no contrato de 12 meses).
create or replace function public.taxa_mesas(p_restaurante uuid, p_novo jsonb) returns numeric
language sql stable security definer set search_path = public as $$
  select case when public.implantacao_paga(p_restaurante) = 0 then 0
    else round(greatest(public.implantacao_faixa((p_novo ->> 'mesas')::int) - public.implantacao_paga(p_restaurante), 0)
      * case when (p_novo ->> 'contrato') = '12' then 0.5 else 1 end, 2) end;
$$;

create or replace function public.plano_aplicar(p_restaurante uuid, p_plano jsonb, p_origem text, p_por text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare antes jsonb := public.plano_de(p_restaurante); novo jsonb := public.plano_normalizar(p_plano); n int; taxa numeric := 0;
begin
  if antes is null then raise exception 'Restaurante não encontrado.'; end if;
  n := (novo ->> 'mesas')::int;
  -- Só a mudança feita pelo próprio restaurante gera a taxa; a central define o plano já com a implantação combinada.
  if p_origem = 'restaurante' then taxa := public.taxa_mesas(p_restaurante, novo); end if;
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
    insert into public.plano_mudancas (restaurante_id, antes, depois, mensal_antes, mensal_depois, origem, por, taxa_unica)
    values (p_restaurante, case when coalesce((antes ->> 'definido')::boolean, false) then antes end, novo,
            case when coalesce((antes ->> 'definido')::boolean, false) then public.plano_preco(antes) end, public.plano_preco(novo), p_origem, left(p_por, 120), taxa);
  end if;
  return novo || jsonb_build_object('taxa_unica', taxa);
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
    'modulos', modulos, 'fidelidade', fidelidade, 'delivery', delivery,
    'plano', jsonb_build_object('servicos', public.plano_de(id) -> 'servicos', 'mesas', public.plano_de(id) -> 'mesas',
      'adicionais', public.plano_de(id) -> 'adicionais'),
    'prorrogacao', prorrogacao)
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
-- Quem está logado (o painel usa ao abrir a página para manter a sessão).
create or replace function public.eu_membro() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('nome', nome, 'admin', admin, 'restaurante_id', restaurante_id)
    from public.equipe_membros where user_id = auth.uid();
$$;
revoke execute on function public.eu_membro() from public, anon;
grant execute on function public.eu_membro() to authenticated;
drop policy if exists "equipe ve a equipe" on public.equipe_membros;
create policy "equipe ve a equipe" on public.equipe_membros
  for select to authenticated using (restaurante_id = public.meu_restaurante());

-- A equipe salva a configuração do próprio restaurante (só estas chaves).
create or replace function public.salvar_config(p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); f jsonb := p_patch -> 'fidelidade'; sefaz_antes boolean;
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
    -- Conferência automática na SEFAZ é cobrada por nota: só o administrador liga ou desliga.
    sefaz_antes := coalesce((select fidelidade -> 'sefaz' ->> 'ativo' from public.restaurantes where id = r), '') = 'true';
    if (coalesce(f -> 'sefaz' ->> 'ativo', '') = 'true') <> sefaz_antes then
      if not public.eu_admin() then
        raise exception 'Só o administrador do restaurante pode ligar ou desligar a conferência automática na SEFAZ.';
      end if;
      f := jsonb_set(f, '{sefaz}', jsonb_build_object('ativo', not sefaz_antes, 'em', now(), 'por', coalesce(public.fid_quem(), 'Equipe')));
    else
      f := case when (select fidelidade ? 'sefaz' from public.restaurantes where id = r)
        then jsonb_set(f, '{sefaz}', (select fidelidade -> 'sefaz' from public.restaurantes where id = r)) else f - 'sefaz' end;
    end if;
  end if;
  if p_patch ? 'delivery' and (jsonb_typeof(p_patch -> 'delivery') <> 'object' or not public.plano_tem(r, 'delivery')) then
    raise exception 'O delivery não está no plano deste restaurante. Mude o plano na aba Plano.';
  end if;
  if p_patch ? 'prorrogacao' and (jsonb_typeof(p_patch -> 'prorrogacao') <> 'object' or not public.plano_adicional(r, 'prorrogacao')) then
    raise exception 'A Prorrogação é um adicional e não está no plano deste restaurante. Contrate na aba Plano.';
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
    fidelidade  = case when p_patch ? 'fidelidade'  then f                        else fidelidade end,
    delivery    = case when p_patch ? 'delivery'    then p_patch -> 'delivery'    else delivery end,
    prorrogacao = case when p_patch ? 'prorrogacao' then p_patch -> 'prorrogacao' else prorrogacao end
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
    'niveis', jsonb_build_object('ativo', false, 'base', 'sempre', 'meses', 12, 'lista', '[]'::jsonb),
    'aniversario', jsonb_build_object('ativo', false, 'mult', 1, 'bonus', 0),
    'transferencia', jsonb_build_object('ativo', true, 'minimo', 10, 'maximoDia', 0),
    'validade', jsonb_build_object('ativo', false, 'quantidade', 12, 'unidade', 'meses', 'desde', null),
    'modo', 'pontos'
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
      and (tipo in ('compra', 'manual', 'evento') or (tipo in ('estorno', 'ajuste') and resgate_id is null))
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

-- Pontos de uma compra: valor x pontos por real x (dia com mais pontos ou mês do aniversário, o maior)
-- x bônus do nível x clássico (time do cliente venceu no dia da compra).
create or replace function public.fid_calcular(p_restaurante uuid, p_valor numeric, p_quando timestamptz, p_cpf text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c jsonb := public.fid_cfg(p_restaurante);
  ppr numeric := least(greatest(public.num_ou(c ->> 'pontosPorReal', 1), 0), 1000);
  b jsonb := public.fid_boost(p_restaurante, p_quando);
  bm numeric := (b ->> 'mult')::numeric; bnome text := b ->> 'nome';
  nv jsonb := case when p_cpf is null then null else public.fid_nivel(p_restaurante, p_cpf) end;
  mn numeric := coalesce((nv ->> 'mult')::numeric, 1);
  am numeric := least(greatest(public.num_ou(c -> 'aniversario' ->> 'mult', 1), 1), 10);
  em numeric := 1; enome text; m numeric;
  dia date := (p_quando at time zone public.fid_fuso(p_restaurante))::date;
begin
  if p_cpf is not null and coalesce(c -> 'aniversario' ->> 'ativo', '') = 'true' and am > bm
     and exists (select 1 from public.fid_clientes where restaurante_id = p_restaurante and cpf = p_cpf
                  and aniversario_mes = extract(month from dia)) then
    bm := am; bnome := 'mês do aniversário';
  end if;
  if p_cpf is not null then
    select e.mult, e.nome into em, enome from public.fid_eventos e
      join public.fid_torcidas t on t.evento_id = e.id and t.cpf = p_cpf and t.time = e.vencedor
     where e.restaurante_id = p_restaurante and e.data = dia
     order by e.mult desc limit 1;
    em := coalesce(em, 1);
  end if;
  m := round(bm * mn * em, 2);
  return jsonb_build_object(
    'pontos', floor(greatest(coalesce(p_valor, 0), 0) * ppr * m)::int,
    'mult', m, 'boost', nullif(concat_ws(' · ', bnome, case when em > 1 then enome end), ''), 'nivel', case when mn > 1 then nv ->> 'nome' end);
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
-- Mês do aniversário (pedido no cadastro) e o ano em que o bônus de aniversário já foi pago.
alter table public.fid_clientes add column if not exists aniversario_mes smallint check (aniversario_mes between 1 and 12);
alter table public.fid_clientes add column if not exists aniversario_ano int;
-- Data completa do aniversário (dia, mês e ano). O mês continua em aniversario_mes (bônus e presente do mês).
alter table public.fid_clientes add column if not exists nascimento date;
create index if not exists fid_clientes_indicado_idx on public.fid_clientes (restaurante_id, indicado_por);

create table if not exists private.fid_pins (
  restaurante_id uuid not null,
  cpf            text not null,
  pin_hash       text not null,
  primary key (restaurante_id, cpf),
  foreign key (restaurante_id, cpf) references public.fid_clientes (restaurante_id, cpf) on delete cascade
);
-- PIN redefinido pela equipe: pin_hash vazio até o cliente criar o novo, e só até redefinir_ate (24 h).
alter table private.fid_pins add column if not exists redefinir_ate timestamptz;

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
  check (tipo in ('compra', 'indicacao', 'boas_vindas', 'manual', 'resgate', 'estorno', 'ajuste', 'nivel',
                  'aniversario', 'transferencia', 'validade', 'evento'));
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
-- Presente de aniversário: só no mês do aniversário do cliente, uma vez por ano (pode ser de graça).
alter table public.fid_premios add column if not exists aniversario boolean not null default false;
alter table public.fid_premios drop constraint if exists fid_premios_pontos_check;
alter table public.fid_premios add constraint fid_premios_pontos_check
  check (pontos between 1 and 1000000 or (aniversario and pontos = 0));
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
  if coalesce(c -> 'indicacao' ->> 'ativo', '') <> 'true' or public.fid_modo(p_restaurante) = 'selos' then return; end if;
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
-- Se for a nota de um pedido do delivery que já deu pontos (mesmo CPF, mesmo valor, emitida perto da hora
-- do pedido), a nota é ligada ao pedido e recusada com o motivo: a mesma compra não conta duas vezes.
create or replace function public.fid_creditar(p_chave text, p_valor numeric, p_emitida timestamptz, p_por text) returns int
language plpgsql security definer set search_path = public as $$
declare n public.fid_notas; calc jsonb; pts int; v_ped uuid; v_num int; quando timestamptz; v_prog text; st jsonb;
begin
  select * into n from public.fid_notas where chave = p_chave for update;
  if not found or n.status <> 'pendente' then return null; end if;
  quando := coalesce(p_emitida, n.emitida_em, n.lida_em);
  select p.id, p.numero into v_ped, v_num from public.pedidos p
   where p.restaurante_id = n.restaurante_id and p.cpf = n.cpf and p.fid_situacao = 'creditado' and p.nota_chave is null
     and (abs(p.total - p_valor) <= 0.05 or abs(p.subtotal - p_valor) <= 0.05)
     and quando between p.criado_em - interval '1 hour' and p.criado_em + interval '12 hours'
   order by abs(extract(epoch from quando - p.criado_em)) limit 1 for update;
  if v_ped is not null then
    update public.pedidos set nota_chave = p_chave where id = v_ped;
    update public.fid_notas
       set status = 'recusada', valor = p_valor, emitida_em = quando, conferida_em = now(), conferida_por = left(p_por, 60),
           motivo = 'Esta compra já contou pelo pedido nº ' || v_num || ' do delivery.'
     where chave = p_chave;
    return null;
  end if;
  -- Pontos ou selo: decide o horário em que a nota foi emitida. Fora de todos os horários, não conta.
  v_prog := public.fid_programa_em(n.restaurante_id, quando);
  if v_prog is null then
    update public.fid_notas
       set status = 'recusada', valor = p_valor, emitida_em = quando, conferida_em = now(), conferida_por = left(p_por, 60),
           motivo = 'A compra foi às ' || to_char(quando at time zone public.fid_fuso(n.restaurante_id), 'HH24"h"MI')
             || ', fora dos horários do programa de fidelidade.'
     where chave = p_chave;
    return null;
  end if;
  if v_prog = 'selos' then
    st := public.fid_carimbar(n.restaurante_id, n.cpf, p_valor, quando, p_chave, null, 'Compra de ' || public.brl(p_valor), p_por);
    if not coalesce((st ->> 'ok')::boolean, false) then
      update public.fid_notas
         set status = 'recusada', valor = p_valor, emitida_em = quando, conferida_em = now(), conferida_por = left(p_por, 60),
             motivo = left(st ->> 'motivo', 160)
       where chave = p_chave;
      return null;
    end if;
    update public.fid_notas
       set status = 'creditada', valor = p_valor, emitida_em = quando, pontos = 0, mult = null, programa = 'selos',
           conferida_em = now(), conferida_por = left(p_por, 60), motivo = null
     where chave = p_chave;
    return 0;
  end if;
  calc := public.fid_calcular(n.restaurante_id, p_valor, coalesce(p_emitida, n.lida_em), n.cpf);
  pts := (calc ->> 'pontos')::int;
  update public.fid_notas
     set status = 'creditada', valor = p_valor, emitida_em = coalesce(p_emitida, n.emitida_em, n.lida_em),
         pontos = pts, mult = (calc ->> 'mult')::numeric, programa = 'pontos', conferida_em = now(), conferida_por = left(p_por, 60), motivo = null
   where chave = p_chave;
  perform public.fid_mover(n.restaurante_id, n.cpf, 'compra', pts,
    'Compra de ' || public.brl(p_valor) || coalesce(' · ' || (calc ->> 'boost'), '') || coalesce(' · nível ' || (calc ->> 'nivel'), '')
      || case when (calc ->> 'mult')::numeric > 1
              then ' (' || replace(rtrim(rtrim(to_char((calc ->> 'mult')::numeric, 'FM990.99'), '0'), '.'), '.', ',') || 'x)' else '' end,
    p_valor, (calc ->> 'mult')::numeric, p_chave, null, p_por);
  perform public.fid_bonus_indicacao(n.restaurante_id, n.cpf);
  perform public.fid_bonus_aniversario(n.restaurante_id, n.cpf);
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
  if pts is null then
    return jsonb_build_object('status', 'recusada', 'motivo', (select motivo from public.fid_notas where chave = p_chave));
  end if;
  return jsonb_build_object('status', 'creditada', 'pontos', pts, 'valor', x.valor) || public.fid_nota_extra(p_chave);
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
    'sefaz', coalesce(c -> 'sefaz' ->> 'ativo', '') = 'true',
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
    'aniversario', case when coalesce(c -> 'aniversario' ->> 'ativo', '') = 'true' then jsonb_build_object('ativo', true,
        'mult', least(greatest(public.num_ou(c -> 'aniversario' ->> 'mult', 1), 1), 10),
        'bonus', least(greatest(public.num_ou(c -> 'aniversario' ->> 'bonus', 0), 0), 100000)::int)
      else jsonb_build_object('ativo', false) end,
    'transferencia', case when coalesce(c -> 'transferencia' ->> 'ativo', '') = 'true' then jsonb_build_object('ativo', true,
        'minimo', least(greatest(public.num_ou(c -> 'transferencia' ->> 'minimo', 1), 1), 1000000)::int,
        'maximoDia', least(greatest(public.num_ou(c -> 'transferencia' ->> 'maximoDia', 0), 0), 10000000)::int)
      else jsonb_build_object('ativo', false) end,
    'validade', case when public.fid_validade(p_restaurante) is not null then jsonb_build_object('ativo', true,
        'quantidade', least(greatest(public.num_ou(c -> 'validade' ->> 'quantidade', 12), 1), 3650)::int,
        'unidade', case when c -> 'validade' ->> 'unidade' = 'dias' then 'dias' else 'meses' end)
      else jsonb_build_object('ativo', false) end,
    'eventos', public.fid_eventos_publicos(p_restaurante),
    'modo', public.fid_modo(p_restaurante),
    'selos', case when public.fid_modo(p_restaurante) <> 'pontos' then public.fid_selos_cfg(p_restaurante) end,
    'horarios', case when public.fid_modo(p_restaurante) = 'ambos' then jsonb_build_object(
        'selos', public.fid_janela_limpa(c -> 'horarios' -> 'selos'), 'pontos', public.fid_janela_limpa(c -> 'horarios' -> 'pontos')) end,
    'premios', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'nome', nome, 'descricao', descricao, 'pontos', pontos, 'imagem', imagem,
          'nivel_min', nivel_min, 'aniversario', aniversario) order by aniversario desc, ordem, pontos, nome)
        from public.fid_premios where restaurante_id = p_restaurante and ativo
         and (not aniversario or coalesce(c -> 'aniversario' ->> 'ativo', '') = 'true')), '[]'::jsonb));
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

-- Data do aniversário vinda do app como AAAAMMDD (o mês sozinho, 1 a 12, não é data).
-- Inválida, antes de 1900 ou no futuro: null.
create or replace function public.fid_nascimento(p int) returns date
language plpgsql stable set search_path = public as $$
declare d date;
begin
  if p is null or p < 19000101 or p > 99991231 then return null; end if;
  begin
    d := to_date(p::text, 'YYYYMMDD');
  exception when others then
    return null;
  end;
  if to_char(d, 'YYYYMMDD') <> p::text or d > current_date then return null; end if;
  return d;
end $$;

drop function if exists public.fid_cadastrar(uuid, text, text, text, text, text, boolean, text);
-- p_aniversario: a data AAAAMMDD (o app antigo ainda manda só o mês, 1 a 12).
create or replace function public.fid_cadastrar(p_restaurante uuid, p_cpf text, p_nome text, p_email text, p_telefone text,
  p_pin text, p_marketing boolean default false, p_indicacao text default null, p_aniversario int default null) returns jsonb
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
    when p_aniversario is null or (p_aniversario not between 1 and 12 and public.fid_nascimento(p_aniversario) is null)
      then 'Informe a data do seu aniversário.'
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
  insert into public.fid_clientes (restaurante_id, cpf, nome, email, telefone, codigo, indicado_por, marketing, aniversario_mes, nascimento)
  values (p_restaurante, v_cpf, v_nome, v_email, v_tel, v_codigo, v_indicador, coalesce(p_marketing, false),
          case when p_aniversario between 1 and 12 then p_aniversario else extract(month from public.fid_nascimento(p_aniversario))::int end,
          public.fid_nascimento(p_aniversario));
  insert into private.fid_pins (restaurante_id, cpf, pin_hash)
  values (p_restaurante, v_cpf, extensions.crypt(p_pin, extensions.gen_salt('bf')));
  -- Indicação paga no cadastro (padrão) ou só na primeira compra, conforme as regras.
  if coalesce(c -> 'indicacao' ->> 'quando', '') <> 'compra' then
    perform public.fid_bonus_indicacao(p_restaurante, v_cpf);
  end if;
  -- Notas com este CPF que a equipe já importou entram na hora.
  perform public.fid_auto_creditar(x.chave) from public.fid_xml x
   where x.restaurante_id = p_restaurante and x.cpf = v_cpf;
  -- E os pedidos do delivery já entregues (com este CPF ou este celular).
  perform public.fid_creditar_pedido(p.id) from public.pedidos p
   where p.restaurante_id = p_restaurante and p.status = 'entregue' and coalesce(p.fid_situacao, 'sem_cadastro') = 'sem_cadastro'
     and (p.cpf = v_cpf or (p.cpf is null and p.cliente ->> 'telefone' = v_tel))
     and p.criado_em > now() - make_interval(days => public.fid_prazo(p_restaurante));
  -- Cadastrou no mês do aniversário: já ganha o presente.
  perform public.fid_bonus_aniversario(p_restaurante, v_cpf);
  return jsonb_build_object('status', 'ok', 'token', public.fid_nova_sessao(p_restaurante, v_cpf));
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

-- Conta completa (aparelho com PIN confirmado).
create or replace function public.fid_conta(p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_r uuid; v_cpf text; cli public.fid_clientes;
begin
  select s.restaurante_id, s.cpf into v_r, v_cpf from private.fid_sessoes s
   where s.token_hash = public.hash_token(p_token) and s.criado_em > now() - interval '180 days';
  if v_r is null then return jsonb_build_object('status', 'sem_sessao'); end if;
  if not exists (select 1 from public.fid_clientes where restaurante_id = v_r and cpf = v_cpf) then
    return jsonb_build_object('status', 'sem_sessao');
  end if;
  perform public.fid_vencer(v_r, v_cpf);
  perform public.fid_bonus_aniversario(v_r, v_cpf);
  select * into cli from public.fid_clientes where restaurante_id = v_r and cpf = v_cpf;
  return jsonb_build_object('status', 'ok',
    'cpf', cli.cpf, 'nome', cli.nome, 'email', cli.email, 'telefone', cli.telefone, 'pontos', cli.pontos,
    'codigo', cli.codigo, 'marketing', cli.marketing, 'criado_em', cli.criado_em,
    'aniversario_mes', cli.aniversario_mes, 'nascimento', cli.nascimento,
    'aniversariante', cli.aniversario_mes = extract(month from now() at time zone public.fid_fuso(v_r)),
    'a_vencer', public.fid_a_vencer(v_r, v_cpf),
    'torcidas', coalesce((select jsonb_object_agg(t.evento_id, t.time) from public.fid_torcidas t
        join public.fid_eventos e on e.id = t.evento_id
       where t.restaurante_id = v_r and t.cpf = v_cpf and e.data > now() - interval '10 days'), '{}'::jsonb),
    'presentes_ano', coalesce((select jsonb_agg(distinct x.premio_id) from public.fid_resgates x
        join public.fid_premios p on p.id = x.premio_id and p.aniversario
       where x.restaurante_id = v_r and x.cpf = v_cpf and x.status <> 'cancelado'
         and extract(year from x.criado_em at time zone public.fid_fuso(v_r)) = extract(year from now() at time zone public.fid_fuso(v_r))), '[]'::jsonb),
    'nivel', public.fid_atualizar_nivel(v_r, v_cpf, false),
    'indicacoes', (select count(*) from public.fid_clientes where restaurante_id = v_r and indicado_por = v_cpf),
    'cartao', case when public.fid_modo(v_r) <> 'pontos' then public.fid_cartao_resumo(v_r, v_cpf) end,
    'notas', coalesce((select jsonb_agg(jsonb_build_object('chave', n.chave, 'status', n.status, 'valor', coalesce(n.valor, n.valor_informado),
          'pontos', n.pontos, 'programa', n.programa, 'lida_em', n.lida_em, 'motivo', n.motivo) order by n.lida_em desc)
        from (select * from public.fid_notas where restaurante_id = v_r and cpf = v_cpf order by lida_em desc limit 20) n), '[]'::jsonb),
    'movimentos', coalesce((select jsonb_agg(jsonb_build_object('tipo', m.tipo, 'pontos', m.pontos, 'descricao', m.descricao, 'criado_em', m.criado_em) order by m.criado_em desc, m.id desc)
        from (select * from public.fid_movimentos where restaurante_id = v_r and cpf = v_cpf order by criado_em desc, id desc limit 40) m), '[]'::jsonb),
    'resgates', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'premio', x.premio_nome, 'pontos', x.pontos, 'codigo', x.codigo,
          'status', x.status, 'cartao', x.cartao_id is not null, 'criado_em', x.criado_em) order by x.criado_em desc)
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
    return jsonb_build_object('status', 'repetida', 'nota', n.status, 'pontos', n.pontos, 'motivo', n.motivo) || public.fid_nota_extra(n.chave);
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

-- Confere a nota logo depois da leitura do QR, antes de pedir o valor: já lida, de outro CNPJ, fora do prazo…
-- Não registra nada ('nova' = pode seguir para o valor).
create or replace function public.fid_nota_situacao(p_restaurante uuid, p_cpf text, p_qr text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_cpf   text := regexp_replace(coalesce(p_cpf, ''), '[^0-9]', '', 'g');
  v_chave text := substring(regexp_replace(btrim(coalesce(p_qr, '')), '[\s.-]', '', 'g') from '([0-9]{44})');
  prob    text;
  n public.fid_notas;
begin
  if not public.fid_no_ar(p_restaurante) then return jsonb_build_object('status', 'inativo'); end if;
  if v_chave is null then return jsonb_build_object('status', 'nova'); end if;
  if not public.equipe_pode_tentar('fid-situacao:' || public.ip_do_pedido(), 120, 10) then
    return jsonb_build_object('status', 'nova');
  end if;
  select * into n from public.fid_notas where chave = v_chave;
  if found then
    if n.cpf <> v_cpf then
      return jsonb_build_object('status', 'erro', 'mensagem', 'Esta nota já foi registrada em outra conta.');
    end if;
    return jsonb_build_object('status', 'repetida', 'nota', n.status, 'pontos', n.pontos, 'motivo', n.motivo) || public.fid_nota_extra(n.chave);
  end if;
  prob := public.fid_chave_problema(p_restaurante, v_chave);
  if prob is not null then return jsonb_build_object('status', 'erro', 'mensagem', prob); end if;
  return jsonb_build_object('status', 'nova');
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
  if public.fid_fora_do_horario(v_r, 'pontos') is not null then
    return jsonb_build_object('status', 'erro', 'mensagem', public.fid_fora_do_horario(v_r, 'pontos'));
  end if;
  select * into p from public.fid_premios where id = p_premio and restaurante_id = v_r and ativo;
  if not found then return jsonb_build_object('status', 'erro', 'mensagem', 'Este prêmio não está mais disponível.'); end if;
  perform public.fid_vencer(v_r, v_cpf);
  -- Presente de aniversário: só no mês do aniversário, uma vez por ano.
  if p.aniversario then
    select * into cli from public.fid_clientes where restaurante_id = v_r and cpf = v_cpf;
    if coalesce(public.fid_cfg(v_r) -> 'aniversario' ->> 'ativo', '') <> 'true' then
      return jsonb_build_object('status', 'erro', 'mensagem', 'Este prêmio não está mais disponível.');
    end if;
    if cli.aniversario_mes is null then
      return jsonb_build_object('status', 'erro', 'mensagem', 'Informe o mês do seu aniversário na sua conta para liberar o presente.');
    end if;
    if cli.aniversario_mes <> extract(month from now() at time zone public.fid_fuso(v_r)) then
      return jsonb_build_object('status', 'erro', 'mensagem', 'Este presente é só no mês do seu aniversário.');
    end if;
    if exists (select 1 from public.fid_resgates where restaurante_id = v_r and cpf = v_cpf and premio_id = p.id and status <> 'cancelado'
                and extract(year from criado_em at time zone public.fid_fuso(v_r)) = extract(year from now() at time zone public.fid_fuso(v_r))) then
      return jsonb_build_object('status', 'erro', 'mensagem', 'Você já pegou este presente de aniversário este ano.');
    end if;
  end if;
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
  if p.pontos > 0 then
    perform public.fid_mover(v_r, v_cpf, 'resgate', -p.pontos, 'Resgate: ' || p.nome, null, null, null, v_id, 'Cliente');
  end if;
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
    'selos_30d', (select count(*) from public.fid_selos where restaurante_id = r and criado_em > now() - interval '30 days'),
    'cartoes_30d', (select count(*) from public.fid_cartoes where restaurante_id = r and completo_em > now() - interval '30 days'),
    'cartoes_abertos', (select count(*) from public.fid_cartoes where restaurante_id = r and status = 'aberto' and selos > 0
                          and (vence_em is null or vence_em > now())),
    'ultimo_xml', (select max(importada_em) from public.fid_xml where restaurante_id = r));
end $$;

create or replace function public.fid_quem() returns text
language sql stable security definer set search_path = public as $$
  select nome from public.equipe_membros where user_id = auth.uid();
$$;

-- Devolve { status: 'creditada', pontos, programa, cartao } ou { status: 'recusada', motivo }.
drop function if exists public.fid_aprovar_nota(text, numeric, timestamptz);
create or replace function public.fid_aprovar_nota(p_chave text, p_valor numeric, p_emitida timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); n public.fid_notas; pts int;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  select * into n from public.fid_notas where chave = p_chave and restaurante_id = r;
  if not found or n.status <> 'pendente' then raise exception 'Esta nota não está mais esperando conferência.'; end if;
  if p_valor is null or p_valor <= 0 or p_valor >= 100000 then raise exception 'Informe o valor total da nota.'; end if;
  if p_emitida is not null and (p_emitida > now() + interval '1 hour' or p_emitida < n.lida_em - interval '400 days') then
    raise exception 'Data da compra inválida.';
  end if;
  pts := public.fid_creditar(p_chave, round(p_valor, 2), coalesce(p_emitida, n.lida_em), public.fid_quem());
  if pts is null then
    return jsonb_build_object('status', 'recusada', 'motivo', (select motivo from public.fid_notas where chave = p_chave));
  end if;
  return jsonb_build_object('status', 'creditada', 'pontos', pts) || public.fid_nota_extra(p_chave);
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
        if n.programa = 'selos' then
          perform public.fid_descarimbar(v_chave);
        else
          perform public.fid_mover(r, n.cpf, 'estorno', -coalesce(n.pontos, 0), 'Nota cancelada: ' || public.brl(n.valor),
            n.valor, null, v_chave, null, quem);
        end if;
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
    perform public.fid_itens_salvar(r, v_chave, v_cpf, v_emit, item -> 'itens');
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
        if n.programa = 'selos' then
          perform public.fid_descarimbar(v_chave);
        else
          perform public.fid_mover(r, n.cpf, 'ajuste', -coalesce(n.pontos, 0), 'Ajuste pelo XML: a nota tem outro CPF',
            n.valor, null, v_chave, null, quem);
        end if;
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
      if n.programa = 'selos' then
        update public.fid_notas set valor = round(v_valor, 2), emitida_em = v_emit, conferida_em = now(), conferida_por = 'XML da nota'
         where chave = v_chave;
        k_ja := k_ja + 1;
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
  if not p_entregar and x.cartao_id is not null then
    update public.fid_cartoes set status = 'completo' where id = x.cartao_id and status = 'resgatado';
  elsif not p_entregar and x.pontos > 0 then
    perform public.fid_mover(r, x.cpf, 'estorno', x.pontos, 'Resgate cancelado: ' || x.premio_nome, null, null, null, x.id, public.fid_quem());
  end if;
end $$;

-- Lançamento manual (só se o restaurante permitir nas regras). Fica no extrato com o nome de quem lançou.
create or replace function public.fid_lancar(p_cpf text, p_valor numeric, p_descricao text) returns int
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); calc jsonb; pts int; v_desc text := left(btrim(coalesce(p_descricao, '')), 100);
  v_prog text; st jsonb;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  if not public.fid_no_ar(r) then raise exception 'O programa de fidelidade não está ativo.'; end if;
  if coalesce(public.fid_cfg(r) ->> 'manual', '') <> 'true' then raise exception 'O lançamento manual está desligado nas regras do programa.'; end if;
  if not exists (select 1 from public.fid_clientes where restaurante_id = r and cpf = p_cpf) then raise exception 'Cliente não encontrado.'; end if;
  if p_valor is null or p_valor <= 0 or p_valor >= 100000 then raise exception 'Informe o valor da compra.'; end if;
  if v_desc = '' then raise exception 'Informe o motivo (ex.: pedido do delivery nº 123).'; end if;
  v_prog := public.fid_programa_em(r, now());
  if v_prog is null then raise exception 'Agora está fora dos horários do programa de fidelidade.'; end if;
  if v_prog = 'selos' then
    st := public.fid_carimbar(r, p_cpf, round(p_valor, 2), now(), null, null, 'Lançado: ' || v_desc || ' · ' || public.brl(p_valor), public.fid_quem());
    if not coalesce((st ->> 'ok')::boolean, false) then raise exception '%', st ->> 'motivo'; end if;
    return 0;
  end if;
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
  if not exists (select 1 from public.fid_clientes where restaurante_id = r and cpf = p_cpf) then raise exception 'Cliente não encontrado.'; end if;
  -- O cliente cria o PIN novo no celular nas próximas 24 horas; depois disso, só redefinindo de novo.
  insert into private.fid_pins (restaurante_id, cpf, pin_hash, redefinir_ate) values (r, p_cpf, '', now() + interval '24 hours')
  on conflict (restaurante_id, cpf) do update set pin_hash = '', redefinir_ate = excluded.redefinir_ate;
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

drop function if exists public.fid_editar_cliente(text, text, text, text, boolean);
create or replace function public.fid_editar_cliente(p_cpf text, p_nome text, p_email text, p_telefone text, p_marketing boolean,
  p_aniversario int default null) returns void
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
  if p_aniversario is not null and p_aniversario not between 1 and 12 and public.fid_nascimento(p_aniversario) is null then
    raise exception 'Data do aniversário inválida.';
  end if;
  -- p_aniversario: a data AAAAMMDD (ou só o mês, 1 a 12, do painel antigo).
  update public.fid_clientes set nome = v_nome, email = v_email, telefone = v_tel, marketing = coalesce(p_marketing, marketing),
         aniversario_mes = case when p_aniversario between 1 and 12 then p_aniversario
                                when public.fid_nascimento(p_aniversario) is not null then extract(month from public.fid_nascimento(p_aniversario))::int
                                else aniversario_mes end,
         nascimento = case when public.fid_nascimento(p_aniversario) is not null then public.fid_nascimento(p_aniversario)
                           when p_aniversario between 1 and 12 and extract(month from nascimento) <> p_aniversario then null
                           else nascimento end
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
  -- Central antiga (sem os adicionais na tela): mantém os que o restaurante já tem.
  return public.plano_aplicar(p_restaurante,
    p_plano || jsonb_build_object('adicionais', coalesce(p_plano -> 'adicionais', public.plano_de(p_restaurante) -> 'adicionais')), 'central',
    coalesce((select email from auth.users where id = auth.uid()), 'central'));
end $$;

create or replace function public.meu_plano() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); p jsonb;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  p := public.plano_de(r);
  return jsonb_build_object('plano', p, 'mensal', public.plano_preco(p), 'sefaz', public.sefaz_uso(r),
    'implantacao_paga', public.implantacao_paga(r),
    'historico', coalesce((select jsonb_agg(jsonb_build_object('criado_em', criado_em, 'origem', origem, 'por', por,
        'antes', antes, 'depois', depois, 'mensal_antes', mensal_antes, 'mensal_depois', mensal_depois, 'taxa_unica', taxa_unica) order by criado_em desc)
      from (select * from public.plano_mudancas where restaurante_id = r order by criado_em desc limit 20) m), '[]'::jsonb));
end $$;

-- Upsell/downsell pelo próprio restaurante: muda serviços, adicionais e mesas; domínio e contrato ficam com a central.
create or replace function public.meu_plano_alterar(p_plano jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); atual jsonb;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  if not public.eu_admin() then raise exception 'Só o administrador do restaurante pode mudar o plano.'; end if;
  atual := public.plano_de(r);
  return public.plano_aplicar(r, jsonb_build_object('servicos', p_plano -> 'servicos', 'mesas', p_plano -> 'mesas',
    'adicionais', coalesce(p_plano -> 'adicionais', atual -> 'adicionais'), 'dominio', atual -> 'dominio', 'contrato', atual -> 'contrato', 'inicio', atual -> 'inicio'),
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
    'public.plano_adicional(uuid, text)', 'public.adicional_preco(text)',
    'public.plano_aplicar(uuid, jsonb, text, text)', 'public.implantacao_faixa(int)', 'public.implantacao_paga(uuid)',
    'public.taxa_mesas(uuid, jsonb)'] loop
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
    'public.restaurante_publico(text)', 'public.resolver_etiqueta(text)',
    'public.mesa_da_etiqueta(uuid, text)', 'public.sessao_status(uuid)', 'public.sessao_abrir(uuid, int, text, text)',
    'public.sessao_sair(uuid)', 'public.chamar(uuid, text, text, text, jsonb)', 'public.chamado_cancelar(uuid, uuid)',
    'public.fid_programa(uuid)', 'public.fid_consultar(uuid, text)', 'public.fid_indicador(uuid, text)',
    'public.fid_cadastrar(uuid, text, text, text, text, text, boolean, text, int)', 'public.fid_entrar(uuid, text, text)',
    'public.fid_conta(uuid)', 'public.fid_sair(uuid)', 'public.fid_registrar_nota(uuid, text, text, numeric)',
    'public.fid_nota_situacao(uuid, text, text)',
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
    'public.gerar_etiquetas(int, text)',
    'public.atribuir_etiquetas(text[], uuid)', 'public.marcar_gravadas(text[], boolean)', 'public.metricas(int)',
    'public.fid_resumo()', 'public.fid_aprovar_nota(text, numeric, timestamptz)', 'public.fid_recusar_nota(text, text)',
    'public.fid_importar_xml(jsonb)', 'public.fid_resgate_decidir(uuid, boolean)', 'public.fid_lancar(text, numeric, text)',
    'public.fid_redefinir_pin(text)', 'public.fid_excluir_cliente(text)', 'public.fid_nivel_cliente(text)',
    'public.plano_alterar_central(uuid, jsonb)', 'public.meu_plano()', 'public.meu_plano_alterar(jsonb)',
    'public.fid_editar_cliente(text, text, text, text, boolean, int)'] loop
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

-- ---------------------------------------------------------------------------
-- Produtos das notas, conferência automática na SEFAZ e rankings.
-- Os produtos vêm do XML importado pela equipe ou da consulta da nota na SEFAZ
-- (função "nfce", pela API da Infosimples). Com eles saem os mais pedidos,
-- no geral e de cada cliente.
-- ---------------------------------------------------------------------------
create table if not exists public.fid_itens (
  chave          text not null check (chave ~ '^[0-9]{44}$'),
  n              int not null,
  restaurante_id uuid not null references public.restaurantes (id) on delete cascade,
  cpf            text,
  descricao      text not null check (char_length(descricao) between 1 and 120),
  quantidade     numeric(12, 3) not null default 1,
  unidade        text check (char_length(unidade) <= 10),
  valor          numeric(12, 2),
  emitida_em     timestamptz,
  primary key (chave, n)
);
create index if not exists fid_itens_rest_idx on public.fid_itens (restaurante_id, emitida_em desc);
create index if not exists fid_itens_cpf_idx on public.fid_itens (restaurante_id, cpf);
alter table public.fid_itens enable row level security;
revoke all on public.fid_itens from anon;
revoke insert, update, delete, truncate on public.fid_itens from authenticated;
drop policy if exists "equipe ve itens das notas" on public.fid_itens;
create policy "equipe ve itens das notas" on public.fid_itens
  for select to authenticated using (restaurante_id = public.meu_restaurante());

-- Grava os produtos de uma nota (substitui os que já existiam).
create or replace function public.fid_itens_salvar(p_restaurante uuid, p_chave text, p_cpf text, p_emitida timestamptz, p_itens jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare k int;
begin
  if jsonb_typeof(p_itens) <> 'array' then return 0; end if;
  delete from public.fid_itens where chave = p_chave;
  insert into public.fid_itens (chave, n, restaurante_id, cpf, descricao, quantidade, unidade, valor, emitida_em)
  select p_chave, x.i, p_restaurante, nullif(p_cpf, ''),
         left(btrim(regexp_replace(x.e ->> 'descricao', '\s+', ' ', 'g')), 120),
         least(greatest(coalesce(public.num_ou(x.e ->> 'quantidade', 1), 1), 0), 100000),
         left(nullif(btrim(x.e ->> 'unidade'), ''), 10),
         case when public.num_ou(x.e ->> 'valor', null) between 0 and 1000000 then round(public.num_ou(x.e ->> 'valor', null), 2) end,
         p_emitida
    from jsonb_array_elements(p_itens) with ordinality as x(e, i)
   where x.i <= 300 and btrim(coalesce(x.e ->> 'descricao', '')) <> '';
  get diagnostics k = row_count;
  return k;
end $$;

-- Notas conferidas na SEFAZ, por restaurante e mês: cobradas à parte na mensalidade.
create table if not exists private.fid_sefaz_uso (
  restaurante_id uuid not null references public.restaurantes (id) on delete cascade,
  mes            date not null,
  consultas      int not null default 0,
  primary key (restaurante_id, mes)
);

-- Preço de cada nota conferida na SEFAZ (o mesmo de Precos.SEFAZ_NOTA).
create or replace function public.sefaz_preco_nota() returns numeric language sql immutable as $$ select 0.25::numeric $$;

-- Uso da conferência no mês atual e no anterior: { ativo, preco, meses: [{ mes, notas, valor }] }.
create or replace function public.sefaz_uso(p_restaurante uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'ativo', coalesce(public.fid_cfg(p_restaurante) -> 'sefaz' ->> 'ativo', '') = 'true',
    'preco', public.sefaz_preco_nota(),
    'meses', coalesce((select jsonb_agg(jsonb_build_object('mes', m.mes, 'notas', coalesce(u.consultas, 0),
        'valor', round(coalesce(u.consultas, 0) * public.sefaz_preco_nota(), 2)) order by m.mes desc)
      from (select (date_trunc('month', now()) - make_interval(months => k))::date as mes from generate_series(0, 1) k) m
      left join private.fid_sefaz_uso u on u.restaurante_id = p_restaurante and u.mes = m.mes), '[]'::jsonb));
$$;

-- Custo estimado da API (Infosimples, faixas progressivas por volume da conta + franquia mínima de R$ 100).
-- Fica só no banco: o restaurante vê apenas o preço por nota, nunca o custo.
create or replace function private.sefaz_custo(p_notas int) returns numeric language sql immutable as $$
  select greatest(100, coalesce(sum(greatest(least(p_notas, f.ate) - f.de, 0) * f.preco), 0))
    from (values (0, 500, 0.20), (500, 2000, 0.16), (2000, 5000, 0.14), (5000, 10000, 0.13), (10000, 30000, 0.11),
                 (30000, 50000, 0.10), (50000, 80000, 0.09), (80000, 100000, 0.07), (100000, 2147483647, 0.05)) f(de, ate, preco);
$$;

-- Central: notas conferidas por restaurante e o total do mês (cobrado dos restaurantes e custo estimado).
create or replace function public.central_sefaz_uso(p_meses int default 3) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare desde date := (date_trunc('month', now()) - make_interval(months => greatest(least(coalesce(p_meses, 3), 24), 1) - 1))::date;
begin
  if not public.eh_operador() then raise exception 'Acesso negado.'; end if;
  return jsonb_build_object(
    'uso', coalesce((select jsonb_agg(jsonb_build_object('restaurante_id', u.restaurante_id, 'mes', u.mes, 'notas', u.consultas,
        'valor', round(u.consultas * public.sefaz_preco_nota(), 2)) order by u.mes desc)
      from private.fid_sefaz_uso u where u.mes >= desde), '[]'::jsonb),
    'meses', coalesce((select jsonb_agg(jsonb_build_object('mes', t.mes, 'notas', t.n, 'cobrado', round(t.n * public.sefaz_preco_nota(), 2),
        'custo', case when t.n > 0 then private.sefaz_custo(t.n) else 0 end) order by t.mes desc)
      from (select u.mes, sum(u.consultas)::int n from private.fid_sefaz_uso u where u.mes >= desde group by u.mes) t), '[]'::jsonb));
end $$;

-- Antes de pagar a consulta: a nota é do restaurante, está no prazo, o cliente existe e a nota ainda não
-- foi usada. Devolve { status: 'ok', chave, url } ou o motivo para não consultar.
create or replace function public.fid_sefaz_preparar(p_restaurante uuid, p_cpf text, p_qr text, p_limite int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_cpf text := regexp_replace(coalesce(p_cpf, ''), '[^0-9]', '', 'g');
  v_txt text := btrim(coalesce(p_qr, ''));
  v_chave text; prob text; n public.fid_notas; v_mes date := date_trunc('month', now())::date; usados int;
begin
  if not public.fid_no_ar(p_restaurante) then return jsonb_build_object('status', 'inativo'); end if;
  if not public.cpf_valido(v_cpf) then return jsonb_build_object('status', 'erro', 'mensagem', 'CPF inválido. Confira os números.'); end if;
  if not exists (select 1 from public.fid_clientes where restaurante_id = p_restaurante and cpf = v_cpf) then
    return jsonb_build_object('status', 'sem_cadastro');
  end if;
  v_chave := substring(regexp_replace(v_txt, '[\s.-]', '', 'g') from '([0-9]{44})');
  if v_chave is null then return jsonb_build_object('status', 'erro', 'mensagem', 'Não achamos a chave da nota. Leia o QR Code impresso na nota fiscal.'); end if;
  prob := public.fid_chave_problema(p_restaurante, v_chave);
  if prob is not null then return jsonb_build_object('status', 'erro', 'mensagem', prob); end if;
  select * into n from public.fid_notas where chave = v_chave;
  if found then
    if n.cpf <> v_cpf then return jsonb_build_object('status', 'erro', 'mensagem', 'Esta nota já foi registrada em outra conta.'); end if;
    if n.status <> 'pendente' then
      return jsonb_build_object('status', 'repetida', 'nota', n.status, 'pontos', n.pontos, 'motivo', n.motivo);
    end if;
  end if;
  -- Já conferida pelo XML da equipe: não precisa pagar a consulta.
  if exists (select 1 from public.fid_xml where chave = v_chave) then return jsonb_build_object('status', 'xml', 'chave', v_chave); end if;
  -- Conferência automática desligada pelo restaurante: segue o fluxo com a foto e a equipe (sem custo).
  if coalesce(public.fid_cfg(p_restaurante) -> 'sefaz' ->> 'ativo', '') <> 'true' then
    return jsonb_build_object('status', 'desligada');
  end if;
  -- Freio contra abuso de um mesmo CPF (não para o restaurante): passou disso, a equipe confere.
  if not public.equipe_pode_tentar('sefaz:' || p_restaurante || ':' || v_cpf, 15, 1440) then
    return jsonb_build_object('status', 'limite', 'mensagem', 'Muitas notas hoje. As próximas a equipe confere.');
  end if;
  insert into private.fid_sefaz_uso (restaurante_id, mes, consultas) values (p_restaurante, v_mes, 1)
  on conflict (restaurante_id, mes) do update set consultas = private.fid_sefaz_uso.consultas + 1
  returning consultas into usados;
  -- Sem teto por padrão: a conferência não para no meio do mês. p_limite > 0 só em emergência.
  if coalesce(p_limite, 0) > 0 and usados > p_limite then
    update private.fid_sefaz_uso u set consultas = u.consultas - 1 where u.restaurante_id = p_restaurante and u.mes = v_mes;
    return jsonb_build_object('status', 'limite', 'mensagem', 'A conferência automática deste mês acabou. A equipe confere a nota.');
  end if;
  return jsonb_build_object('status', 'ok', 'chave', v_chave,
    'url', case when v_txt ~* '^https?://[a-z0-9.-]+[.]gov[.]br/' then left(v_txt, 600) end);
end $$;

-- Nota conferida na SEFAZ: registra (se ainda não estava), credita com o valor oficial e guarda os produtos.
create or replace function public.fid_sefaz_registrar(p_restaurante uuid, p_cpf text, p_chave text, p_url text,
  p_valor numeric, p_emitida timestamptz, p_itens jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n public.fid_notas; pts int;
begin
  if p_valor is null or p_valor <= 0 or p_valor >= 100000 then return jsonb_build_object('status', 'erro', 'mensagem', 'Valor da nota inválido.'); end if;
  insert into public.fid_notas (chave, restaurante_id, cpf, url, lida_por)
  values (p_chave, p_restaurante, p_cpf, p_url, 'Cliente')
  on conflict (chave) do nothing;
  select * into n from public.fid_notas where chave = p_chave for update;
  if n.cpf <> p_cpf then return jsonb_build_object('status', 'erro', 'mensagem', 'Esta nota já foi registrada em outra conta.'); end if;
  perform public.fid_itens_salvar(p_restaurante, p_chave, p_cpf, p_emitida, p_itens);
  if n.status <> 'pendente' then return jsonb_build_object('status', 'repetida', 'nota', n.status, 'pontos', n.pontos) || public.fid_nota_extra(p_chave); end if;
  pts := public.fid_creditar(p_chave, round(p_valor, 2), coalesce(p_emitida, n.lida_em), 'SEFAZ');
  if pts is null then
    return jsonb_build_object('status', 'recusada', 'motivo', (select motivo from public.fid_notas where chave = p_chave));
  end if;
  return jsonb_build_object('status', 'creditada', 'pontos', pts) || public.fid_nota_extra(p_chave);
end $$;

-- A SEFAZ mostrou outro CPF (ou nenhum): a nota não vale e fica o motivo para o cliente.
create or replace function public.fid_sefaz_recusar(p_restaurante uuid, p_cpf text, p_chave text, p_url text, p_motivo text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  insert into public.fid_notas (chave, restaurante_id, cpf, url, lida_por, status, motivo, conferida_em, conferida_por)
  values (p_chave, p_restaurante, p_cpf, p_url, 'Cliente', 'recusada', left(p_motivo, 160), now(), 'SEFAZ')
  on conflict (chave) do update set status = 'recusada', motivo = left(p_motivo, 160), conferida_em = now(), conferida_por = 'SEFAZ'
    where public.fid_notas.status = 'pendente' and public.fid_notas.cpf = p_cpf;
  return jsonb_build_object('status', 'recusada', 'motivo', left(p_motivo, 160));
end $$;

-- Ranking do clube: os 10 que mais ganharam pontos (trocas não descontam). Nome curto: "Maria S.".
-- Com o token do cliente, devolve também a posição dele e os produtos que ele mais pede.
create or replace function public.fid_ranking(p_restaurante uuid, p_token uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_cpf text; eu jsonb;
begin
  if not public.fid_no_ar(p_restaurante) or coalesce(public.fid_cfg(p_restaurante) -> 'ranking' ->> 'ativo', 'true') = 'false' then
    return jsonb_build_object('ativo', false);
  end if;
  if p_token is not null then
    select s.cpf into v_cpf from private.fid_sessoes s
     where s.token_hash = public.hash_token(p_token) and s.restaurante_id = p_restaurante and s.criado_em > now() - interval '180 days';
  end if;
  return (with ganhos as (
      select m.cpf, sum(m.pontos)::int as pontos
        from public.fid_movimentos m
       where m.restaurante_id = p_restaurante and m.tipo <> 'resgate' and not (m.tipo = 'estorno' and m.resgate_id is not null)
       group by m.cpf having sum(m.pontos) > 0),
    pos as (
      select g.cpf, g.pontos, rank() over (order by g.pontos desc) as pos,
             (select w[1] || case when array_length(w, 1) > 1 then ' ' || left(w[array_length(w, 1)], 1) || '.' else '' end
                from (select regexp_split_to_array(btrim(c.nome), '\s+') as w) x) as nome
        from ganhos g join public.fid_clientes c on c.restaurante_id = p_restaurante and c.cpf = g.cpf)
    select jsonb_build_object('ativo', true,
      'top', coalesce((select jsonb_agg(jsonb_build_object('pos', p.pos, 'nome', p.nome, 'pontos', p.pontos, 'voce', p.cpf = v_cpf) order by p.pos, p.nome)
                        from (select * from pos order by pos, nome limit 10) p), '[]'::jsonb),
      'eu', case when v_cpf is null then null else jsonb_build_object(
          'pos', (select p.pos from pos p where p.cpf = v_cpf),
          'pontos', coalesce((select p.pontos from pos p where p.cpf = v_cpf), 0),
          'favoritos', coalesce((select jsonb_agg(f.descricao) from (
              select min(i.descricao) as descricao from public.fid_itens_com_delivery(p_restaurante) i
               where i.cpf = v_cpf
               group by lower(i.descricao) order by sum(i.quantidade) desc, count(*) desc limit 3) f), '[]'::jsonb)) end));
end $$;

-- Equipe: produtos mais pedidos (no geral ou de um cliente), nos últimos p_dias. Soma as notas e o delivery.
create or replace function public.fid_top_produtos(p_cpf text default null, p_dias int default 90) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r uuid := public.meu_restaurante();
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('descricao', t.descricao, 'quantidade', t.quantidade, 'notas', t.notas, 'clientes', t.clientes, 'valor', t.valor)
      order by t.quantidade desc, t.notas desc)
    from (select min(i.descricao) as descricao, sum(i.quantidade) as quantidade, count(distinct i.chave) as notas,
                 count(distinct i.cpf) as clientes, sum(i.valor) as valor
            from public.fid_itens_com_delivery(r) i
           where (p_cpf is null or i.cpf = regexp_replace(p_cpf, '[^0-9]', '', 'g'))
             and coalesce(i.emitida_em, now()) > now() - make_interval(days => least(greatest(coalesce(p_dias, 90), 1), 3650))
           group by lower(i.descricao)
           order by sum(i.quantidade) desc, count(distinct i.chave) desc
           limit 20) t), '[]'::jsonb);
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.fid_itens_salvar(uuid, text, text, timestamptz, jsonb)', 'public.sefaz_uso(uuid)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
  execute 'revoke execute on function public.central_sefaz_uso(int) from public, anon';
  execute 'grant execute on function public.central_sefaz_uso(int) to authenticated';
  -- Só a função "nfce" (service_role).
  foreach f in array array[
    'public.fid_sefaz_preparar(uuid, text, text, int)',
    'public.fid_sefaz_registrar(uuid, text, text, text, numeric, timestamptz, jsonb)',
    'public.fid_sefaz_recusar(uuid, text, text, text, text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  execute 'revoke execute on function public.fid_ranking(uuid, uuid) from public';
  execute 'grant execute on function public.fid_ranking(uuid, uuid) to anon, authenticated';
  execute 'revoke execute on function public.fid_top_produtos(text, int) from public, anon';
  execute 'grant execute on function public.fid_top_produtos(text, int) to authenticated';
end $$;

-- ---------------------------------------------------------------------------
-- Delivery: o cliente pede pela página /delivery do restaurante, a equipe
-- acompanha no painel (novo → em preparo → saiu para entrega → entregue) e o
-- cliente vê o andamento pelo link do pedido. Taxa por distância em faixas.
-- Configuração em restaurantes.delivery:
--   { ativo, local: { lat, lng, endereco }, faixas: [{ ate (km), taxa }], minimo,
--     tempo (min), pagamentos: { pix, cartao, dinheiro }, pix (chave), whatsapp }
-- ---------------------------------------------------------------------------

create table if not exists public.pedidos (
  id             uuid primary key default gen_random_uuid(),
  restaurante_id uuid not null references public.restaurantes (id) on delete cascade,
  numero         int not null,
  token_hash     text not null unique,
  status         text not null default 'recebido' check (status in ('recebido', 'preparo', 'saiu', 'entregue', 'cancelado')),
  cliente        jsonb not null,
  endereco       jsonb not null,
  itens          jsonb not null,
  subtotal       numeric(10, 2) not null,
  taxa           numeric(10, 2) not null,
  total          numeric(10, 2) not null,
  pagamento      jsonb not null,
  obs            text check (char_length(obs) <= 300),
  distancia_km   numeric(6, 2),
  entregador     text check (char_length(entregador) <= 60),
  motivo         text check (char_length(motivo) <= 160),
  historico      jsonb not null default '[]'::jsonb,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now()
);
-- Pedido que virou selo do cartão fidelidade (em vez de pontos).
alter table public.pedidos add column if not exists fid_selo boolean not null default false;
create index if not exists pedidos_rest_idx on public.pedidos (restaurante_id, criado_em desc);
-- Clube de fidelidade: CPF informado no pedido (ou achado pelo celular), pontos creditados na entrega
-- e a nota fiscal ligada ao pedido (para a mesma compra não contar duas vezes).
alter table public.pedidos add column if not exists cpf text check (cpf ~ '^[0-9]{11}$');
alter table public.pedidos add column if not exists fid_situacao text check (fid_situacao in ('creditado', 'nota', 'sem_cadastro', 'fora'));
alter table public.pedidos add column if not exists fid_pontos int;
alter table public.pedidos add column if not exists nota_chave text;
create index if not exists pedidos_cpf_idx on public.pedidos (restaurante_id, cpf) where cpf is not null;
alter table public.pedidos enable row level security;
revoke all on public.pedidos from anon;
revoke insert, update, delete, truncate on public.pedidos from authenticated;
drop policy if exists "equipe ve pedidos" on public.pedidos;
create policy "equipe ve pedidos" on public.pedidos
  for select to authenticated using (restaurante_id = public.meu_restaurante());

-- Distância em linha reta (km) entre dois pontos.
create or replace function public.distancia_km(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric) returns numeric
language sql immutable set search_path = public as $$
  select round((6371 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))::numeric, 2);
$$;

-- Cliente faz o pedido. Preços vêm do cardápio salvo (não do navegador); taxa pela distância.
create or replace function public.delivery_pedir(p_restaurante uuid, p_pedido jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.restaurantes; c jsonb;
  v_nome text := left(btrim(regexp_replace(coalesce(p_pedido #>> '{cliente,nome}', ''), '\s+', ' ', 'g')), 60);
  v_tel text := regexp_replace(coalesce(p_pedido #>> '{cliente,telefone}', ''), '[^0-9]', '', 'g');
  e jsonb := coalesce(p_pedido -> 'endereco', '{}'::jsonb); e2 jsonb;
  v_lat numeric; v_lng numeric; v_dist numeric; v_taxa numeric;
  itens jsonb := '[]'::jsonb; x jsonb; it jsonb; q int; sub numeric := 0; v_total numeric;
  g jsonb; op jsonb; sel jsonb; s2 jsonb; n int; qq int; tot int; v_preco numeric; rot jsonb;
  forma text := p_pedido #>> '{pagamento,forma}'; troco numeric;
  v_num int; v_token uuid := gen_random_uuid(); v_id uuid;
  v_cpf text := nullif(regexp_replace(coalesce(p_pedido ->> 'cpf', ''), '[^0-9]', '', 'g'), '');
begin
  select * into r from public.restaurantes where id = p_restaurante and ativo;
  if not found or not public.plano_tem(p_restaurante, 'delivery') then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Este restaurante não faz delivery por aqui.');
  end if;
  c := coalesce(r.delivery, '{}'::jsonb);
  if coalesce(c ->> 'ativo', '') <> 'true' then return jsonb_build_object('status', 'erro', 'mensagem', 'O delivery está fechado agora.'); end if;
  if not public.equipe_pode_tentar('pedido:' || public.ip_do_pedido(), 8, 60)
     or not public.equipe_pode_tentar('pedido-rest:' || p_restaurante, 300, 60) then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Muitos pedidos em pouco tempo. Aguarde alguns minutos.');
  end if;
  if v_nome !~ '^\S{2,}' then return jsonb_build_object('status', 'erro', 'mensagem', 'Informe seu nome.'); end if;
  if char_length(v_tel) in (12, 13) and v_tel like '55%' then v_tel := substr(v_tel, 3); end if;
  if v_tel !~ '^[1-9][0-9]{9,10}$' then return jsonb_build_object('status', 'erro', 'mensagem', 'Informe um celular com DDD.'); end if;
  -- CPF para os pontos do clube (opcional). Sem CPF, a conta do clube aberta neste aparelho.
  if v_cpf is not null and not public.cpf_valido(v_cpf) then
    return jsonb_build_object('status', 'erro', 'mensagem', 'CPF inválido. Confira os números ou deixe em branco.');
  end if;
  if v_cpf is null and coalesce(p_pedido ->> 'fid_token', '') ~ '^[0-9a-f-]{36}$' then
    select s.cpf into v_cpf from private.fid_sessoes s
     where s.token_hash = public.hash_token((p_pedido ->> 'fid_token')::uuid) and s.restaurante_id = p_restaurante
       and s.criado_em > now() - interval '180 days';
  end if;
  -- Endereço salvo (achado pelo celular em delivery_enderecos): o navegador só manda a referência;
  -- o endereço completo sai do pedido anterior, e só vale com o mesmo celular daquele pedido.
  if coalesce(e ->> 'ref', '') <> '' then
    if (e ->> 'ref') !~ '^[0-9a-f-]{36}$' then return jsonb_build_object('status', 'erro', 'mensagem', 'Endereço salvo não encontrado. Preencha o endereço.'); end if;
    select p.endereco into e2 from public.pedidos p
     where p.id = (e ->> 'ref')::uuid and p.restaurante_id = p_restaurante and p.cliente ->> 'telefone' = v_tel;
    if e2 is null then return jsonb_build_object('status', 'erro', 'mensagem', 'Endereço salvo não encontrado. Preencha o endereço.'); end if;
    e := e2 || jsonb_strip_nulls(jsonb_build_object('referencia', nullif(btrim(coalesce(e ->> 'referencia', '')), '')));
  end if;
  if btrim(coalesce(e ->> 'rua', '')) = '' or btrim(coalesce(e ->> 'numero', '')) = '' or btrim(coalesce(e ->> 'bairro', '')) = '' then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Complete o endereço: rua, número e bairro.');
  end if;
  -- Itens: só os do cardápio marcados para delivery, com o preço de lá.
  if jsonb_typeof(p_pedido -> 'itens') <> 'array' or jsonb_array_length(p_pedido -> 'itens') not between 1 and 60 then
    return jsonb_build_object('status', 'erro', 'mensagem', 'O carrinho está vazio.');
  end if;
  for x in select * from jsonb_array_elements(p_pedido -> 'itens') loop
    select i into it from jsonb_array_elements(coalesce(r.cardapio, '[]'::jsonb)) cat, jsonb_array_elements(cat -> 'itens') i
     where i ->> 'id' = x ->> 'id' and coalesce(i ->> 'delivery', '') = 'true' limit 1;
    if it is null then return jsonb_build_object('status', 'erro', 'mensagem', 'Um item do carrinho não está mais disponível. Atualize a página.'); end if;
    q := least(greatest(coalesce(public.num_ou(x ->> 'qtd', 1), 1), 1), 50)::int;
    -- Opções: 'escolha' (uma, soma ao preço) e 'extras' (adicionais com quantidade). Mesmas regras de Store.opcoes.
    v_preco := public.num_ou(it ->> 'preco', 0);
    rot := '[]'::jsonb;
    sel := case when jsonb_typeof(x -> 'opcoes') = 'array' then x -> 'opcoes' else '[]'::jsonb end;
    for g in select gr from jsonb_array_elements(case when jsonb_typeof(it -> 'grupos') = 'array' then it -> 'grupos' else '[]'::jsonb end) gr
              where jsonb_typeof(gr -> 'opcoes') = 'array' and jsonb_array_length(gr -> 'opcoes') > 0 loop
      if g ->> 'tipo' = 'escolha' then
        select count(*) into n from jsonb_array_elements(sel) z where z ->> 'g' = g ->> 'id';
        if n > 1 then return jsonb_build_object('status', 'erro', 'mensagem', (it ->> 'nome') || ': escolha só uma opção em "' || (g ->> 'nome') || '".'); end if;
        if n = 0 then
          if coalesce(public.num_ou(g ->> 'min', 0), 0) >= 1 then
            return jsonb_build_object('status', 'erro', 'mensagem', (it ->> 'nome') || ': escolha ' || (g ->> 'nome') || '.');
          end if;
          continue;
        end if;
        select o into op from jsonb_array_elements(sel) z, jsonb_array_elements(g -> 'opcoes') o
         where z ->> 'g' = g ->> 'id' and o ->> 'id' = z ->> 'o' limit 1;
        if op is null then return jsonb_build_object('status', 'erro', 'mensagem', 'Opção indisponível. Atualize a página.'); end if;
        v_preco := v_preco + coalesce(public.num_ou(op ->> 'preco', 0), 0);
        rot := rot || to_jsonb(op ->> 'nome');
      else
        tot := 0;
        for s2 in select z from jsonb_array_elements(sel) z where z ->> 'g' = g ->> 'id' loop
          select o into op from jsonb_array_elements(g -> 'opcoes') o where o ->> 'id' = s2 ->> 'o' limit 1;
          if op is null then return jsonb_build_object('status', 'erro', 'mensagem', 'Opção indisponível. Atualize a página.'); end if;
          qq := least(greatest(round(coalesce(public.num_ou(s2 ->> 'q', 0), 0)), 0), 20)::int;
          continue when qq = 0;
          tot := tot + qq;
          v_preco := v_preco + coalesce(public.num_ou(op ->> 'preco', 0), 0) * qq;
          rot := rot || to_jsonb(case when qq > 1 then qq || '× ' || (op ->> 'nome') else op ->> 'nome' end);
        end loop;
        if coalesce(public.num_ou(g ->> 'max', 0), 0) > 0 and tot > public.num_ou(g ->> 'max', 0) then
          return jsonb_build_object('status', 'erro', 'mensagem', (it ->> 'nome') || ': em "' || (g ->> 'nome') || '", escolha até ' || (g ->> 'max') || '.');
        end if;
        if tot < coalesce(public.num_ou(g ->> 'min', 0), 0) then
          return jsonb_build_object('status', 'erro', 'mensagem', (it ->> 'nome') || ': em "' || (g ->> 'nome') || '", escolha pelo menos ' || (g ->> 'min') || '.');
        end if;
      end if;
    end loop;
    v_preco := round(v_preco, 2);
    itens := itens || jsonb_build_object('id', it ->> 'id', 'nome', it ->> 'nome', 'preco', v_preco, 'qtd', q,
      'obs', nullif(left(btrim(coalesce(x ->> 'obs', '')), 140), ''), 'opcoes', rot);
    sub := sub + v_preco * q;
  end loop;
  if sub < coalesce(public.num_ou(c ->> 'minimo', 0), 0) then
    return jsonb_build_object('status', 'erro', 'mensagem', 'O pedido mínimo é ' || public.brl(public.num_ou(c ->> 'minimo', 0)) || '.');
  end if;
  -- Taxa: primeira faixa que cobre a distância.
  v_lat := public.num_ou(e ->> 'lat', null); v_lng := public.num_ou(e ->> 'lng', null);
  if v_lat is null or v_lng is null or public.num_ou(c #>> '{local,lat}', null) is null then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Não conseguimos localizar o endereço. Confira o CEP e o número.');
  end if;
  v_dist := public.distancia_km(public.num_ou(c #>> '{local,lat}', null), public.num_ou(c #>> '{local,lng}', null), v_lat, v_lng);
  select public.num_ou(f ->> 'taxa', 0) into v_taxa
    from jsonb_array_elements(case when jsonb_typeof(c -> 'faixas') = 'array' then c -> 'faixas' else '[]'::jsonb end) f
   where public.num_ou(f ->> 'ate', 0) >= v_dist
   order by public.num_ou(f ->> 'ate', 0) limit 1;
  if v_taxa is null then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Seu endereço está fora da área de entrega (' || replace(v_dist::text, '.', ',') || ' km).');
  end if;
  v_total := sub + v_taxa;
  if forma not in ('pix', 'cartao', 'dinheiro') or coalesce(c #>> array['pagamentos', forma], '') <> 'true' then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Escolha uma forma de pagamento.');
  end if;
  troco := public.num_ou(p_pedido #>> '{pagamento,troco}', null);
  if forma = 'dinheiro' and troco is not null and troco < v_total then
    return jsonb_build_object('status', 'erro', 'mensagem', 'O troco precisa ser para um valor maior que o total.');
  end if;
  -- Número do pedido do dia (1, 2, 3…), sem repetir mesmo com pedidos ao mesmo tempo.
  perform pg_advisory_xact_lock(hashtext('pedido:' || p_restaurante));
  select coalesce(max(numero), 0) + 1 into v_num from public.pedidos
   where restaurante_id = p_restaurante and (criado_em at time zone 'America/Sao_Paulo')::date = (now() at time zone 'America/Sao_Paulo')::date;
  insert into public.pedidos (restaurante_id, numero, token_hash, cliente, endereco, itens, subtotal, taxa, total, pagamento, obs, distancia_km, historico, cpf)
  values (p_restaurante, v_num, public.hash_token(v_token),
    jsonb_build_object('nome', v_nome, 'telefone', v_tel),
    jsonb_build_object('cep', left(regexp_replace(coalesce(e ->> 'cep', ''), '[^0-9]', '', 'g'), 8), 'rua', left(btrim(e ->> 'rua'), 120),
      'numero', left(btrim(e ->> 'numero'), 20), 'complemento', left(btrim(coalesce(e ->> 'complemento', '')), 80),
      'bairro', left(btrim(e ->> 'bairro'), 80), 'cidade', left(btrim(coalesce(e ->> 'cidade', '')), 80),
      'referencia', left(btrim(coalesce(e ->> 'referencia', '')), 120), 'lat', v_lat, 'lng', v_lng),
    itens, sub, v_taxa, v_total,
    jsonb_build_object('forma', forma, 'troco', case when forma = 'dinheiro' then troco end),
    nullif(left(btrim(coalesce(p_pedido ->> 'obs', '')), 300), ''), v_dist,
    jsonb_build_array(jsonb_build_object('status', 'recebido', 'em', now())), v_cpf)
  returning id into v_id;
  return jsonb_build_object('status', 'ok', 'token', v_token, 'numero', v_num, 'total', v_total);
end $$;

-- Endereços já usados neste restaurante, achados pelo celular (navegador sem nada guardado).
-- Devolve só um resumo mascarado ("Rua da Ba•••, nº 1•••", bairro) e a taxa: quem digita o celular de
-- outra pessoa não descobre o endereço dela. Para pedir, o navegador manda só a referência (ref).
create or replace function public.delivery_enderecos(p_restaurante uuid, p_telefone text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.restaurantes; c jsonb;
  v_tel text := regexp_replace(coalesce(p_telefone, ''), '[^0-9]', '', 'g');
  lista jsonb := '[]'::jsonb; x record; v_dist numeric; v_taxa numeric; v_nome text;
begin
  select * into r from public.restaurantes where id = p_restaurante and ativo;
  if not found or not public.plano_tem(p_restaurante, 'delivery') then return jsonb_build_object('status', 'nenhum'); end if;
  if char_length(v_tel) in (12, 13) and v_tel like '55%' then v_tel := substr(v_tel, 3); end if;
  if v_tel !~ '^[1-9][0-9]{9,10}$' then return jsonb_build_object('status', 'erro', 'mensagem', 'Informe um celular com DDD.'); end if;
  if not public.equipe_pode_tentar('dl-end:' || public.ip_do_pedido(), 12, 10) then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Muitas buscas em pouco tempo. Preencha o endereço.');
  end if;
  c := coalesce(r.delivery, '{}'::jsonb);
  for x in
    select * from (
      select distinct on (lower(p.endereco ->> 'rua'), p.endereco ->> 'numero', lower(coalesce(p.endereco ->> 'complemento', '')))
             p.id, p.endereco, p.cliente, p.criado_em
        from public.pedidos p
       where p.restaurante_id = p_restaurante and p.cliente ->> 'telefone' = v_tel and p.criado_em > now() - interval '1 year'
       order by lower(p.endereco ->> 'rua'), p.endereco ->> 'numero', lower(coalesce(p.endereco ->> 'complemento', '')), p.criado_em desc
    ) d order by d.criado_em desc limit 3
  loop
    v_nome := coalesce(v_nome, split_part(x.cliente ->> 'nome', ' ', 1));
    v_dist := null; v_taxa := null;
    if public.num_ou(c #>> '{local,lat}', null) is not null and public.num_ou(x.endereco ->> 'lat', null) is not null then
      v_dist := public.distancia_km(public.num_ou(c #>> '{local,lat}', null), public.num_ou(c #>> '{local,lng}', null),
                                    public.num_ou(x.endereco ->> 'lat', null), public.num_ou(x.endereco ->> 'lng', null));
      select public.num_ou(f ->> 'taxa', 0) into v_taxa
        from jsonb_array_elements(case when jsonb_typeof(c -> 'faixas') = 'array' then c -> 'faixas' else '[]'::jsonb end) f
       where public.num_ou(f ->> 'ate', 0) >= v_dist order by public.num_ou(f ->> 'ate', 0) limit 1;
    end if;
    lista := lista || jsonb_build_object('ref', x.id,
      'rua', rtrim(left(x.endereco ->> 'rua', greatest(3, ceil(char_length(x.endereco ->> 'rua') * .6)::int))) || '•••',
      'numero', left(x.endereco ->> 'numero', 1) || case when char_length(x.endereco ->> 'numero') > 1 then '•••' else '' end,
      'complemento', coalesce(x.endereco ->> 'complemento', '') <> '',
      'bairro', x.endereco ->> 'bairro', 'distancia', v_dist, 'taxa', v_taxa);
  end loop;
  if jsonb_array_length(lista) = 0 then return jsonb_build_object('status', 'nenhum'); end if;
  return jsonb_build_object('status', 'ok', 'nome', v_nome, 'enderecos', lista);
end $$;

-- Cliente acompanha o pedido pelo link (token).
create or replace function public.delivery_acompanhar(p_token uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('status', 'ok', 'pedido', jsonb_build_object(
      'numero', p.numero, 'status', p.status, 'itens', p.itens, 'subtotal', p.subtotal, 'taxa', p.taxa, 'total', p.total,
      'pagamento', p.pagamento, 'endereco', p.endereco - 'lat' - 'lng', 'entregador', p.entregador, 'motivo', p.motivo,
      'historico', p.historico, 'criado_em', p.criado_em,
      'fid', jsonb_build_object('cpf', p.cpf is not null, 'situacao', p.fid_situacao, 'pontos', p.fid_pontos, 'selo', p.fid_selo)),
    'restaurante', jsonb_build_object('nome', r.nome, 'telefone', r.restaurante ->> 'telefone', 'whatsapp', r.delivery ->> 'whatsapp',
      'pix', case when p.pagamento ->> 'forma' = 'pix' then r.delivery ->> 'pix' end, 'tempo', r.delivery ->> 'tempo'))
  from public.pedidos p join public.restaurantes r on r.id = p.restaurante_id
  where p.token_hash = public.hash_token(p_token) and p.criado_em > now() - interval '7 days';
$$;

-- Equipe muda o andamento do pedido.
create or replace function public.delivery_mudar(p_id uuid, p_status text, p_entregador text default null, p_motivo text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); p public.pedidos;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  select * into p from public.pedidos where id = p_id and restaurante_id = r for update;
  if not found then raise exception 'Pedido não encontrado.'; end if;
  if p_status not in ('recebido', 'preparo', 'saiu', 'entregue', 'cancelado') then raise exception 'Situação inválida.'; end if;
  if p.status in ('entregue', 'cancelado') and p_status <> p.status then raise exception 'Este pedido já foi finalizado.'; end if;
  update public.pedidos set status = p_status,
    entregador = coalesce(nullif(left(btrim(coalesce(p_entregador, '')), 60), ''), entregador),
    motivo = case when p_status = 'cancelado' then nullif(left(btrim(coalesce(p_motivo, '')), 160), '') else motivo end,
    historico = historico || jsonb_build_array(jsonb_build_object('status', p_status, 'em', now(), 'por', public.fid_quem())),
    atualizado_em = now()
  where id = p_id;
  -- Entregue: os pontos do clube entram sozinhos.
  if p_status = 'entregue' and p.status <> 'entregue' then perform public.fid_creditar_pedido(p_id); end if;
end $$;

do $$
begin
  execute 'revoke execute on function public.distancia_km(numeric, numeric, numeric, numeric) from public, anon, authenticated';
  execute 'revoke execute on function public.delivery_pedir(uuid, jsonb) from public';
  execute 'grant execute on function public.delivery_pedir(uuid, jsonb) to anon, authenticated';
  execute 'revoke execute on function public.delivery_enderecos(uuid, text) from public';
  execute 'grant execute on function public.delivery_enderecos(uuid, text) to anon, authenticated';
  execute 'revoke execute on function public.delivery_acompanhar(uuid) from public';
  execute 'grant execute on function public.delivery_acompanhar(uuid) to anon, authenticated';
  execute 'revoke execute on function public.delivery_mudar(uuid, text, text, text) from public, anon';
  execute 'grant execute on function public.delivery_mudar(uuid, text, text, text) to authenticated';
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pedidos') then
    execute 'alter publication supabase_realtime add table public.pedidos';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Pontos do delivery: quando a equipe marca "entregue", o pedido vira pontos sozinho, para o CPF
-- informado no pedido, a conta do clube aberta no aparelho ou, sem nenhum dos dois, o cliente do clube
-- com o mesmo celular. Mesmas regras da nota (fid_calcular: dobro, nível, início do programa e prazo).
-- A nota fiscal do pedido não conta de novo (fid_creditar liga a nota ao pedido), e se a nota já tinha
-- dado pontos antes da entrega, o pedido é que fica ligado a ela.
-- Quem ainda não é do clube: o pedido fica "sem_cadastro" e entra quando a pessoa se cadastra (fid_cadastrar).
-- ---------------------------------------------------------------------------
create or replace function public.fid_creditar_pedido(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.pedidos; cli public.fid_clientes; v_cpf text; ini timestamptz; calc jsonb; pts int; n public.fid_notas;
  v_prog text; st jsonb;
begin
  select * into p from public.pedidos where id = p_id for update;
  if not found or p.status <> 'entregue' or p.fid_situacao in ('creditado', 'nota') then return null; end if;
  v_cpf := p.cpf;
  if v_cpf is null then
    select case when count(*) = 1 then min(c.cpf) end into v_cpf from public.fid_clientes c
     where c.restaurante_id = p.restaurante_id and c.telefone = p.cliente ->> 'telefone';
    if v_cpf is null then return null; end if;
  end if;
  if not public.fid_no_ar(p.restaurante_id) then
    update public.pedidos set fid_situacao = 'fora' where id = p_id;
    return jsonb_build_object('status', 'fora');
  end if;
  select * into cli from public.fid_clientes where restaurante_id = p.restaurante_id and cpf = v_cpf;
  if not found then
    update public.pedidos set fid_situacao = 'sem_cadastro' where id = p_id;
    return jsonb_build_object('status', 'sem_cadastro');
  end if;
  ini := public.fid_inicio(p.restaurante_id);
  if (ini is not null and p.criado_em < ini)
     or p.criado_em < cli.criado_em - make_interval(days => public.fid_prazo(p.restaurante_id)) then
    update public.pedidos set fid_situacao = 'fora', cpf = v_cpf where id = p_id;
    return jsonb_build_object('status', 'fora');
  end if;
  -- A nota fiscal deste pedido já deu pontos (o cliente leu o QR antes de a equipe marcar entregue)?
  select * into n from public.fid_notas f
   where f.restaurante_id = p.restaurante_id and f.cpf = v_cpf and f.status = 'creditada'
     and (abs(f.valor - p.total) <= 0.05 or abs(f.valor - p.subtotal) <= 0.05)
     and f.emitida_em between p.criado_em - interval '1 hour' and p.criado_em + interval '12 hours'
     and not exists (select 1 from public.pedidos o where o.nota_chave = f.chave)
   order by abs(extract(epoch from f.emitida_em - p.criado_em)) limit 1;
  if found then
    update public.pedidos set fid_situacao = 'nota', cpf = v_cpf, nota_chave = n.chave, fid_pontos = n.pontos,
           fid_selo = coalesce(n.programa, '') = 'selos' where id = p_id;
    return jsonb_build_object('status', 'nota', 'pontos', n.pontos);
  end if;
  v_prog := public.fid_programa_em(p.restaurante_id, p.criado_em);
  if v_prog is null then
    update public.pedidos set fid_situacao = 'fora', cpf = v_cpf where id = p_id;
    return jsonb_build_object('status', 'fora');
  end if;
  if v_prog = 'selos' then
    st := public.fid_carimbar(p.restaurante_id, v_cpf, p.total, p.criado_em, null, p.id,
      'Delivery nº ' || p.numero || ' · ' || public.brl(p.total), 'Delivery');
    if not coalesce((st ->> 'ok')::boolean, false) then
      update public.pedidos set fid_situacao = 'fora', cpf = v_cpf where id = p_id;
      return jsonb_build_object('status', 'fora', 'motivo', st ->> 'motivo');
    end if;
    update public.pedidos set fid_situacao = 'creditado', cpf = v_cpf, fid_pontos = 0, fid_selo = true where id = p_id;
    return jsonb_build_object('status', 'creditado', 'pontos', 0, 'selo', true);
  end if;
  calc := public.fid_calcular(p.restaurante_id, p.total, p.criado_em, v_cpf);
  pts := (calc ->> 'pontos')::int;
  update public.pedidos set fid_situacao = 'creditado', cpf = v_cpf, fid_pontos = pts where id = p_id;
  perform public.fid_mover(p.restaurante_id, v_cpf, 'compra', pts,
    'Delivery nº ' || p.numero || ' · ' || public.brl(p.total) || coalesce(' · ' || (calc ->> 'boost'), '') || coalesce(' · nível ' || (calc ->> 'nivel'), '')
      || case when (calc ->> 'mult')::numeric > 1
              then ' (' || replace(rtrim(rtrim(to_char((calc ->> 'mult')::numeric, 'FM990.99'), '0'), '.'), '.', ',') || 'x)' else '' end,
    p.total, (calc ->> 'mult')::numeric, null, null, 'Delivery');
  perform public.fid_bonus_indicacao(p.restaurante_id, v_cpf);
  perform public.fid_bonus_aniversario(p.restaurante_id, v_cpf);
  return jsonb_build_object('status', 'creditado', 'pontos', pts);
end $$;

-- Produtos das notas (XML/SEFAZ) e dos pedidos entregues do delivery, para os mais pedidos e os favoritos.
-- O pedido cuja nota também foi importada entra uma vez só (pelos produtos da nota).
create or replace function public.fid_itens_com_delivery(p_restaurante uuid)
returns table (chave text, cpf text, descricao text, quantidade numeric, valor numeric, emitida_em timestamptz)
language sql stable security definer set search_path = public as $$
  select i.chave, i.cpf, i.descricao, i.quantidade, i.valor, i.emitida_em
    from public.fid_itens i where i.restaurante_id = p_restaurante
  union all
  select 'pedido:' || p.id, p.cpf, left(x ->> 'nome', 120), coalesce(public.num_ou(x ->> 'qtd', 1), 1),
         round(coalesce(public.num_ou(x ->> 'preco', 0), 0) * coalesce(public.num_ou(x ->> 'qtd', 1), 1), 2), p.criado_em
    from public.pedidos p, jsonb_array_elements(p.itens) x
   where p.restaurante_id = p_restaurante and p.status = 'entregue' and btrim(coalesce(x ->> 'nome', '')) <> ''
     and (p.nota_chave is null or not exists (select 1 from public.fid_itens j where j.chave = p.nota_chave));
$$;

do $$
begin
  execute 'revoke execute on function public.fid_creditar_pedido(uuid) from public, anon, authenticated';
  execute 'revoke execute on function public.fid_itens_com_delivery(uuid) from public, anon, authenticated';
end $$;

-- ---------------------------------------------------------------------------
-- Avisos do pedido (Web Push). O cliente ativa na tela do pedido; a cada mudança de situação,
-- o gatilho chama a função "push" (pg_net), que manda a notificação para o celular dele.
-- push_config.url fica vazio fora da produção: sem url, o gatilho não chama nada.
-- ---------------------------------------------------------------------------
create extension if not exists pg_net with schema extensions;

create table if not exists private.push_config (
  id            int primary key default 1 check (id = 1),
  url           text,
  segredo       text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  vapid_publica text,
  vapid_privada text
);
insert into private.push_config (id) values (1) on conflict do nothing;

create table if not exists private.pedido_push (
  pedido_id uuid not null references public.pedidos (id) on delete cascade,
  endpoint  text not null check (char_length(endpoint) <= 600),
  p256dh    text not null check (char_length(p256dh) <= 200),
  auth      text not null check (char_length(auth) <= 60),
  url       text not null check (char_length(url) <= 200),
  criado_em timestamptz not null default now(),
  primary key (pedido_id, endpoint)
);

-- Cliente liga os avisos do pedido (pelo link do pedido).
create or replace function public.delivery_push(p_token uuid, p_sub jsonb, p_url text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.pedidos; v_end text := p_sub ->> 'endpoint';
begin
  select * into p from public.pedidos where token_hash = public.hash_token(p_token) and criado_em > now() - interval '2 days';
  if not found then return jsonb_build_object('status', 'erro', 'mensagem', 'Pedido não encontrado.'); end if;
  if p.status in ('entregue', 'cancelado') then return jsonb_build_object('status', 'finalizado'); end if;
  if v_end is null or v_end !~ '^https://' or coalesce(p_sub #>> '{keys,p256dh}', '') = '' or coalesce(p_sub #>> '{keys,auth}', '') = ''
     or coalesce(p_url, '') !~ '^/delivery/\?pedido=[0-9a-f-]{36}$' then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Não foi possível ligar os avisos neste aparelho.');
  end if;
  if (select count(*) from private.pedido_push where pedido_id = p.id and endpoint <> v_end) >= 5 then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Muitos aparelhos neste pedido.');
  end if;
  insert into private.pedido_push (pedido_id, endpoint, p256dh, auth, url)
  values (p.id, left(v_end, 600), left(p_sub #>> '{keys,p256dh}', 200), left(p_sub #>> '{keys,auth}', 60), p_url)
  on conflict (pedido_id, endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, url = excluded.url;
  return jsonb_build_object('status', 'ok');
end $$;

-- Só a função "push" (service role): dados do aviso, chaves VAPID e limpeza de inscrições vencidas.
create or replace function public.push_pedido(p_id uuid, p_segredo text) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when c.segredo is distinct from p_segredo then jsonb_build_object('status', 'negado') else
    jsonb_build_object('status', 'ok', 'numero', p.numero, 'situacao', p.status, 'entregador', p.entregador, 'motivo', p.motivo,
      'restaurante', r.nome, 'vapid_publica', c.vapid_publica, 'vapid_privada', c.vapid_privada,
      'inscricoes', coalesce((select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'keys', jsonb_build_object('p256dh', s.p256dh, 'auth', s.auth), 'url', s.url))
                              from private.pedido_push s where s.pedido_id = p.id), '[]'::jsonb)) end
  from private.push_config c
  left join public.pedidos p on p.id = p_id
  left join public.restaurantes r on r.id = p.restaurante_id
  where c.id = 1;
$$;
create or replace function public.push_chaves(p_publica text default null, p_privada text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c private.push_config;
begin
  select * into c from private.push_config where id = 1 for update;
  if c.vapid_publica is null and p_publica is not null and p_privada is not null then
    update private.push_config set vapid_publica = p_publica, vapid_privada = p_privada where id = 1 returning * into c;
  end if;
  return jsonb_build_object('publica', c.vapid_publica, 'privada', c.vapid_privada);
end $$;
create or replace function public.push_remover(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from private.pedido_push where endpoint = p_endpoint;
$$;

-- A cada mudança de situação do pedido com avisos ligados: chama a função "push".
create or replace function private.pedido_avisar() returns trigger
language plpgsql security definer set search_path = public as $$
declare c private.push_config;
begin
  if new.status is not distinct from old.status then return new; end if;
  if not exists (select 1 from private.pedido_push where pedido_id = new.id) then return new; end if;
  select * into c from private.push_config where id = 1;
  if c.url is null then return new; end if;
  perform net.http_post(url := c.url, body := jsonb_build_object('acao', 'enviar', 'pedido', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-segredo', c.segredo), timeout_milliseconds := 5000);
  return new;
end $$;
drop trigger if exists pedidos_avisar on public.pedidos;
create trigger pedidos_avisar after update of status on public.pedidos
  for each row execute function private.pedido_avisar();

do $$
begin
  execute 'revoke execute on function public.delivery_push(uuid, jsonb, text) from public';
  execute 'grant execute on function public.delivery_push(uuid, jsonb, text) to anon, authenticated';
  execute 'revoke execute on function public.push_pedido(uuid, text) from public, anon, authenticated';
  execute 'revoke execute on function public.push_chaves(text, text) from public, anon, authenticated';
  execute 'revoke execute on function public.push_remover(text) from public, anon, authenticated';
  execute 'grant execute on function public.push_pedido(uuid, text) to service_role';
  execute 'grant execute on function public.push_chaves(text, text) to service_role';
  execute 'grant execute on function public.push_remover(text) to service_role';
  execute 'revoke execute on function private.pedido_avisar() from public, anon, authenticated';
end $$;

-- ---------------------------------------------------------------------------
-- Domínio próprio (ex.: cardapio.seurestaurante.com.br). O subdomínio continua sendo o endereço
-- de sempre; o domínio próprio é um endereço a mais, configurado pelo administrador no painel:
--   1. adiciona o domínio (dominio_definir) → o painel mostra o registro DNS a criar;
--   2. a função "dominio" e o roteador conferem o DNS (CNAME ou A para o servidor) → 'certificado';
--   3. o roteador de domínios põe a rota e o certificado HTTPS no Traefik e confere → 'ativo'.
-- Ao ficar no ar pela primeira vez, entra no plano (R$ 190 uma vez + R$ 19 por mês).
-- ---------------------------------------------------------------------------
create table if not exists private.dominios_config (
  id    int primary key default 1 check (id = 1),
  alvo  text,  -- para onde o CNAME aponta (o endereço da central, ex.: tap.vortexsystems.tech)
  base  text   -- domínio dos subdomínios (ex.: vortexsystems.tech): não pode ser usado como domínio próprio
);
insert into private.dominios_config (id) values (1) on conflict do nothing;

create table if not exists public.dominios (
  restaurante_id uuid primary key references public.restaurantes (id) on delete cascade,
  dominio        text not null unique check (char_length(dominio) <= 253),
  status         text not null default 'dns' check (status in ('dns', 'certificado', 'ativo')),
  mensagem       text check (char_length(mensagem) <= 300),
  por            text check (char_length(por) <= 120),
  criado_em      timestamptz not null default now(),
  verificado_em  timestamptz,
  ativo_em       timestamptz,
  checado_em     timestamptz
);
alter table public.dominios enable row level security;
revoke all on public.dominios from anon, authenticated;
grant select on public.dominios to authenticated;
drop policy if exists "equipe e operador veem o dominio" on public.dominios;
create policy "equipe e operador veem o dominio" on public.dominios
  for select to authenticated using (restaurante_id = public.meu_restaurante() or public.eh_operador());

-- "https://Cardapio.Bar.com.br/admin" → "cardapio.bar.com.br".
create or replace function public.dominio_normalizar(p text) returns text
language sql immutable set search_path = public as $$
  select nullif(regexp_replace(regexp_replace(regexp_replace(lower(btrim(coalesce(p, ''))), '^[a-z]+://', ''), '[/?#:@\s].*$', ''), '\.+$', ''), '');
$$;

create or replace function public.meu_dominio() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); v jsonb;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  select jsonb_build_object('slug', rs.slug, 'dominio', d.dominio, 'status', d.status, 'mensagem', d.mensagem,
      'verificado_em', d.verificado_em, 'ativo_em', d.ativo_em, 'checado_em', d.checado_em,
      'alvo', c.alvo, 'base', c.base, 'admin', public.eu_admin(), 'plano_dominio', public.plano_de(r) ->> 'dominio')
    into v
    from public.restaurantes rs
    left join public.dominios d on d.restaurante_id = rs.id
    cross join private.dominios_config c
   where rs.id = r and c.id = 1;
  return v;
end $$;

-- Administrador adiciona (ou troca) o domínio próprio.
create or replace function public.dominio_definir(p_dominio text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); v text := public.dominio_normalizar(p_dominio); c private.dominios_config;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  if not public.eu_admin() then raise exception 'Só o administrador do restaurante pode mudar o domínio.'; end if;
  select * into c from private.dominios_config where id = 1;
  if v is null or char_length(v) > 253 or v !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$' or v ~ '^[0-9.]+$' then
    raise exception 'Domínio inválido. Use só o endereço, sem https:// (ex.: cardapio.seurestaurante.com.br).';
  end if;
  if (c.base is not null and (v = c.base or v like '%.' || c.base)) or v = c.alvo then
    raise exception 'Esse endereço já é da VTX Tap. Use um domínio do restaurante (ex.: cardapio.seurestaurante.com.br).';
  end if;
  if exists (select 1 from public.dominios where dominio = v and restaurante_id <> r) then
    raise exception 'Esse domínio já está sendo usado por outro restaurante.';
  end if;
  insert into public.dominios (restaurante_id, dominio, por) values (r, v, left(public.fid_quem(), 120))
  on conflict (restaurante_id) do update set dominio = excluded.dominio, por = excluded.por, status = 'dns', mensagem = null,
    verificado_em = null, ativo_em = null, checado_em = null, criado_em = now()
  where public.dominios.dominio is distinct from excluded.dominio;
  return public.meu_dominio();
end $$;

-- Administrador remove o domínio próprio: o restaurante segue no subdomínio e o plano volta ao endereço incluso.
create or replace function public.dominio_remover() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); p jsonb;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  if not public.eu_admin() then raise exception 'Só o administrador do restaurante pode mudar o domínio.'; end if;
  delete from public.dominios where restaurante_id = r;
  p := public.plano_de(r);
  if p ->> 'dominio' = 'proprio' and coalesce((p ->> 'definido')::boolean, false) then
    perform public.plano_aplicar(r, p || '{"dominio": "sub"}'::jsonb, 'restaurante', coalesce(public.fid_quem(), 'Equipe') || ' (removeu o domínio próprio)');
  end if;
  return public.meu_dominio();
end $$;

-- Só a função "dominio" e o roteador (service role): lista, conferência e mudança de situação.
create or replace function public.dominios_lista() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('alvo', c.alvo, 'base', c.base,
    'dominios', coalesce((select jsonb_agg(jsonb_build_object('dominio', d.dominio, 'status', d.status, 'slug', r.slug) order by d.criado_em)
                            from public.dominios d join public.restaurantes r on r.id = d.restaurante_id where r.ativo), '[]'::jsonb))
  from private.dominios_config c where c.id = 1;
$$;

create or replace function public.dominio_marcar(p_dominio text, p_status text, p_mensagem text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.dominios; p jsonb; v_mud uuid;
begin
  if p_status not in ('dns', 'certificado', 'ativo') then raise exception 'Situação inválida.'; end if;
  select * into d from public.dominios where dominio = public.dominio_normalizar(p_dominio) for update;
  if not found then return jsonb_build_object('status', 'inexistente'); end if;
  update public.dominios set status = p_status, mensagem = left(p_mensagem, 300), checado_em = now(),
    verificado_em = case when p_status in ('certificado', 'ativo') then coalesce(verificado_em, now()) else verificado_em end,
    ativo_em = case when p_status = 'ativo' then coalesce(ativo_em, now()) else ativo_em end
  where restaurante_id = d.restaurante_id;
  -- Primeira vez no ar: entra no plano (R$ 19/mês) com a configuração (R$ 190, taxa única).
  if p_status = 'ativo' and d.ativo_em is null then
    p := public.plano_de(d.restaurante_id);
    if coalesce((p ->> 'definido')::boolean, false) and p ->> 'dominio' = 'sub' then
      perform public.plano_aplicar(d.restaurante_id, p || '{"dominio": "proprio"}'::jsonb, 'restaurante', 'Domínio próprio: ' || d.dominio);
      select id into v_mud from public.plano_mudancas where restaurante_id = d.restaurante_id order by criado_em desc limit 1;
      update public.plano_mudancas set taxa_unica = taxa_unica + 190 where id = v_mud;
    end if;
  end if;
  return jsonb_build_object('status', 'ok');
end $$;

-- Navegador aberto pelo domínio próprio: acha o restaurante (o mesmo retorno de restaurante_publico).
create or replace function public.restaurante_por_dominio(p_host text) returns jsonb
language sql stable security definer set search_path = public as $$
  select public.restaurante_publico(r.slug)
    from public.dominios d join public.restaurantes r on r.id = d.restaurante_id
   where d.dominio = public.dominio_normalizar(p_host) and d.status in ('certificado', 'ativo') and r.ativo;
$$;

-- Dados públicos do restaurante com o domínio próprio no ar (a ativação da plaquinha abre o painel por ele).
-- Mesma função do começo do arquivo, redefinida aqui porque depende de public.dominios.
create or replace function public.restaurante_publico(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', r.id, 'slug', r.slug, 'nome', r.nome, 'restaurante', r.restaurante,
    'wifi', r.wifi, 'cardapio', r.cardapio, 'mesas', r.mesas, 'widgets', r.widgets,
    'modulos', r.modulos, 'fidelidade', r.fidelidade, 'delivery', r.delivery,
    'plano', jsonb_build_object('servicos', public.plano_de(r.id) -> 'servicos', 'mesas', public.plano_de(r.id) -> 'mesas',
      'adicionais', public.plano_de(r.id) -> 'adicionais'),
    'prorrogacao', r.prorrogacao,
    'dominio', (select d.dominio from public.dominios d where d.restaurante_id = r.id and d.status = 'ativo'))
  from public.restaurantes r where r.slug = lower(btrim(p_slug)) and r.ativo;
$$;

-- Plaquinha: devolve também o domínio próprio no ar, para o redirecionador abrir por ele.
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
  return jsonb_build_object('status', 'ok', 'slug', r.slug,
    'dominio', (select d.dominio from public.dominios d where d.restaurante_id = r.id and d.status = 'ativo'));
end $$;

do $$
begin
  execute 'revoke execute on function public.dominio_normalizar(text) from public, anon, authenticated';
  execute 'revoke execute on function public.meu_dominio() from public, anon';
  execute 'grant execute on function public.meu_dominio() to authenticated';
  execute 'revoke execute on function public.dominio_definir(text) from public, anon';
  execute 'grant execute on function public.dominio_definir(text) to authenticated';
  execute 'revoke execute on function public.dominio_remover() from public, anon';
  execute 'grant execute on function public.dominio_remover() to authenticated';
  execute 'revoke execute on function public.dominios_lista() from public, anon, authenticated';
  execute 'grant execute on function public.dominios_lista() to service_role';
  execute 'revoke execute on function public.dominio_marcar(text, text, text) from public, anon, authenticated';
  execute 'grant execute on function public.dominio_marcar(text, text, text) to service_role';
  execute 'revoke execute on function public.restaurante_por_dominio(text) from public';
  execute 'grant execute on function public.restaurante_por_dominio(text) to anon, authenticated';
end $$;

-- ---------------------------------------------------------------------------
-- Clube: aniversário, transferência de pontos, validade e dia de clássico.
-- Tudo configurável nas regras (restaurantes.fidelidade):
--   aniversario   { ativo, mult (pontos x no mês do aniversário), bonus (pontos de presente, 1 vez por ano) }
--                 e prêmios marcados como "presente de aniversário" (só no mês, 1 vez por ano, podem custar 0);
--   transferencia { ativo, minimo, maximoDia (0 = sem limite) }: o cliente manda pontos para outro cliente
--                 (achado pelo CPF ou pelo código de indicação), confirmando com o PIN. Sai do ranking de quem
--                 manda e entra no de quem recebe;
--   validade      { ativo, quantidade, unidade 'meses'|'dias', desde 'AAAA-MM-DD' }: pontos ganhos há mais
--                 tempo que isso vencem (os mais antigos primeiro). Descontam do saldo e do ranking.
--                 "desde" = dia em que a regra foi ligada: o que foi ganho antes conta a partir daí;
--   eventos       (tabela fid_eventos) dia de clássico: o cliente escolhe o time até o início do jogo; se o
--                 time dele vencer, os pontos das compras daquele dia valem mult (ex.: dobro).
-- ---------------------------------------------------------------------------

-- Validade dos pontos (null = pontos não vencem).
create or replace function public.fid_validade(p_restaurante uuid) returns interval
language sql stable security definer set search_path = public as $$
  select case when coalesce(v ->> 'ativo', '') = 'true' then
    case when v ->> 'unidade' = 'dias' then make_interval(days => least(greatest(public.num_ou(v ->> 'quantidade', 365), 1), 3650)::int)
         else make_interval(months => least(greatest(public.num_ou(v ->> 'quantidade', 12), 1), 120)::int) end end
  from (select public.fid_cfg(p_restaurante) -> 'validade' as v) x;
$$;
create or replace function public.fid_validade_desde(p_restaurante uuid) returns timestamptz
language sql stable security definer set search_path = public as $$
  select case when coalesce(public.fid_cfg(p_restaurante) -> 'validade' ->> 'desde', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
              then ((public.fid_cfg(p_restaurante) -> 'validade' ->> 'desde')::date)::timestamp at time zone public.fid_fuso(p_restaurante) end;
$$;

-- Vence os pontos do cliente (FIFO: as saídas gastam primeiro os pontos mais antigos). Devolve quantos venceram.
-- Os pontos vencidos saem do saldo e do ranking.
create or replace function public.fid_vencer(p_restaurante uuid, p_cpf text) returns int
language plpgsql security definer set search_path = public as $$
declare iv interval := public.fid_validade(p_restaurante); desde timestamptz := public.fid_validade_desde(p_restaurante);
  saldo int; ganhos int; saidas int; v int;
begin
  if iv is null then return 0; end if;
  select pontos into saldo from public.fid_clientes where restaurante_id = p_restaurante and cpf = p_cpf for update;
  if not found or saldo <= 0 then return 0; end if;
  select coalesce(sum(pontos) filter (where pontos > 0 and greatest(criado_em, coalesce(desde, criado_em)) + iv <= now()), 0),
         coalesce(-sum(pontos) filter (where pontos < 0), 0)
    into ganhos, saidas from public.fid_movimentos where restaurante_id = p_restaurante and cpf = p_cpf;
  v := least(ganhos - saidas, saldo);
  if v <= 0 then return 0; end if;
  perform public.fid_mover(p_restaurante, p_cpf, 'validade', -v, 'Pontos vencidos', null, null, null, null, 'Validade');
  return v;
end $$;

-- Próximos pontos a vencer (nos próximos 30 dias): { pontos, em }. null = nada vencendo.
create or replace function public.fid_a_vencer(p_restaurante uuid, p_cpf text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare iv interval := public.fid_validade(p_restaurante); desde timestamptz := public.fid_validade_desde(p_restaurante);
  saidas int; acum int := 0; m record; primeira timestamptz; total int := 0;
begin
  if iv is null then return null; end if;
  select coalesce(-sum(pontos) filter (where pontos < 0), 0) into saidas
    from public.fid_movimentos where restaurante_id = p_restaurante and cpf = p_cpf;
  for m in select pontos, greatest(criado_em, coalesce(desde, criado_em)) + iv as vence
             from public.fid_movimentos where restaurante_id = p_restaurante and cpf = p_cpf and pontos > 0 order by 2 loop
    exit when m.vence > now() + interval '30 days';
    acum := acum + m.pontos;
    if acum > saidas then primeira := coalesce(primeira, m.vence); total := acum - saidas; end if;
  end loop;
  if total <= 0 then return null; end if;
  return jsonb_build_object('pontos', total, 'em', primeira);
end $$;

-- Todos os clientes de todos os restaurantes com validade (roda todo dia pelo pg_cron).
create or replace function public.fid_vencer_todos() returns int
language plpgsql security definer set search_path = public as $$
declare x record; n int := 0;
begin
  for x in select c.restaurante_id, c.cpf from public.fid_clientes c
            where c.pontos > 0 and public.fid_validade(c.restaurante_id) is not null loop
    n := n + public.fid_vencer(x.restaurante_id, x.cpf);
  end loop;
  return n;
end $$;

-- Presente de aniversário em pontos: uma vez por ano, no mês do aniversário.
create or replace function public.fid_bonus_aniversario(p_restaurante uuid, p_cpf text) returns int
language plpgsql security definer set search_path = public as $$
declare c jsonb := public.fid_cfg(p_restaurante); cli public.fid_clientes; b int;
  agora timestamp := now() at time zone public.fid_fuso(p_restaurante);
begin
  b := least(greatest(public.num_ou(c -> 'aniversario' ->> 'bonus', 0), 0), 100000)::int;
  if coalesce(c -> 'aniversario' ->> 'ativo', '') <> 'true' or b <= 0 or not public.fid_no_ar(p_restaurante)
     or public.fid_modo(p_restaurante) = 'selos' then return 0; end if;
  select * into cli from public.fid_clientes where restaurante_id = p_restaurante and cpf = p_cpf for update;
  if not found or cli.aniversario_mes is distinct from extract(month from agora)::int
     or coalesce(cli.aniversario_ano, 0) >= extract(year from agora)::int then return 0; end if;
  update public.fid_clientes set aniversario_ano = extract(year from agora)::int where restaurante_id = p_restaurante and cpf = p_cpf;
  perform public.fid_mover(p_restaurante, p_cpf, 'aniversario', b, 'Presente de aniversário', null, null, null, null, 'Aniversário');
  return b;
end $$;

-- Cliente que se cadastrou antes informa o aniversário (uma vez; depois só a equipe muda).
-- p_mes: a data AAAAMMDD; quem já tinha o mês salvo completa com o dia e o ano do mesmo mês.
-- (O app antigo ainda manda só o mês, 1 a 12.)
create or replace function public.fid_definir_aniversario(p_token uuid, p_mes int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_r uuid; v_cpf text; d date := public.fid_nascimento(p_mes); cli public.fid_clientes;
begin
  select s.restaurante_id, s.cpf into v_r, v_cpf from private.fid_sessoes s
   where s.token_hash = public.hash_token(p_token) and s.criado_em > now() - interval '180 days';
  if v_r is null then return jsonb_build_object('status', 'sem_sessao'); end if;
  select * into cli from public.fid_clientes where restaurante_id = v_r and cpf = v_cpf;
  if d is not null then
    if cli.nascimento is not null then
      return jsonb_build_object('status', 'erro', 'mensagem', 'O seu aniversário já está salvo. Para mudar, fale com a equipe.');
    end if;
    if cli.aniversario_mes is not null and cli.aniversario_mes <> extract(month from d) then
      return jsonb_build_object('status', 'erro', 'mensagem', 'O mês não bate com o aniversário que já está salvo. Para corrigir, fale com a equipe.');
    end if;
    update public.fid_clientes set nascimento = d, aniversario_mes = extract(month from d)::int where restaurante_id = v_r and cpf = v_cpf;
    perform public.fid_bonus_aniversario(v_r, v_cpf);
    return jsonb_build_object('status', 'ok');
  end if;
  if p_mes is null or p_mes not between 1 and 12 then return jsonb_build_object('status', 'erro', 'mensagem', 'Informe a data do seu aniversário.'); end if;
  update public.fid_clientes set aniversario_mes = p_mes where restaurante_id = v_r and cpf = v_cpf and aniversario_mes is null;
  if not found then return jsonb_build_object('status', 'erro', 'mensagem', 'O mês do aniversário já está salvo. Para mudar, fale com a equipe.'); end if;
  perform public.fid_bonus_aniversario(v_r, v_cpf);
  return jsonb_build_object('status', 'ok');
end $$;

-- Nome curto para mostrar a outra pessoa: "Maria S.".
create or replace function public.fid_nome_curto(p_nome text) returns text
language sql immutable set search_path = public as $$
  select w[1] || case when array_length(w, 1) > 1 then ' ' || left(w[array_length(w, 1)], 1) || '.' else '' end
    from (select regexp_split_to_array(btrim(coalesce(p_nome, '')), '\s+') as w) x;
$$;

-- Destino da transferência: CPF (11 números) ou código de indicação. Devolve o cliente ou um erro em texto.
create or replace function public.fid_destino(p_restaurante uuid, p_destino text) returns public.fid_clientes
language plpgsql stable security definer set search_path = public as $$
declare d text := regexp_replace(coalesce(p_destino, ''), '[^0-9A-Za-z]', '', 'g'); cli public.fid_clientes;
begin
  if d ~ '^[0-9]{11}$' then
    select * into cli from public.fid_clientes where restaurante_id = p_restaurante and cpf = d;
  elsif d ~ '^[A-Za-z0-9]{4,12}$' then
    select * into cli from public.fid_clientes where restaurante_id = p_restaurante and codigo = upper(d);
  end if;
  return cli;
end $$;

-- Cliente confere para quem vai transferir (antes de digitar a quantidade e o PIN).
create or replace function public.fid_transferir_destino(p_token uuid, p_destino text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_r uuid; v_cpf text; d public.fid_clientes;
begin
  select s.restaurante_id, s.cpf into v_r, v_cpf from private.fid_sessoes s
   where s.token_hash = public.hash_token(p_token) and s.criado_em > now() - interval '180 days';
  if v_r is null then return jsonb_build_object('status', 'sem_sessao'); end if;
  if not public.fid_no_ar(v_r) then return jsonb_build_object('status', 'inativo'); end if;
  if coalesce(public.fid_cfg(v_r) -> 'transferencia' ->> 'ativo', '') <> 'true' then
    return jsonb_build_object('status', 'erro', 'mensagem', 'A transferência de pontos está desligada neste restaurante.');
  end if;
  if not public.equipe_pode_tentar('fid-transf-busca:' || v_r || ':' || v_cpf, 20, 10) then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Muitas buscas seguidas. Aguarde alguns minutos.');
  end if;
  d := public.fid_destino(v_r, p_destino);
  if d.cpf is null then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Não achamos ninguém no clube com esse CPF ou código. A pessoa precisa estar cadastrada.');
  end if;
  if d.cpf = v_cpf then return jsonb_build_object('status', 'erro', 'mensagem', 'Esse é você. Digite o CPF ou o código de outra pessoa.'); end if;
  return jsonb_build_object('status', 'ok', 'nome', public.fid_nome_curto(d.nome));
end $$;

-- Transfere pontos para outro cliente do clube (confirma com o PIN de quem manda).
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

-- Dia de clássico.
create table if not exists public.fid_eventos (
  id             uuid primary key default gen_random_uuid(),
  restaurante_id uuid not null references public.restaurantes (id) on delete cascade,
  nome           text not null check (char_length(nome) between 1 and 60),
  data           date not null,
  hora           text check (hora ~ '^[0-2][0-9]:[0-5][0-9]$'),
  times          text[] not null check (array_length(times, 1) between 2 and 4),
  mult           numeric(4, 2) not null default 2 check (mult between 1.1 and 10),
  vencedor       text check (char_length(vencedor) <= 30),
  premiados      int,
  pontos_pagos   int,
  resultado_em   timestamptz,
  resultado_por  text check (char_length(resultado_por) <= 60),
  criado_em      timestamptz not null default now()
);
create index if not exists fid_eventos_rest_idx on public.fid_eventos (restaurante_id, data desc);
create table if not exists public.fid_torcidas (
  evento_id      uuid not null references public.fid_eventos (id) on delete cascade,
  restaurante_id uuid not null,
  cpf            text not null,
  time           text not null check (char_length(time) <= 30),
  criado_em      timestamptz not null default now(),
  primary key (evento_id, cpf),
  foreign key (restaurante_id, cpf) references public.fid_clientes (restaurante_id, cpf) on delete cascade
);
alter table public.fid_eventos enable row level security;
alter table public.fid_torcidas enable row level security;
revoke all on public.fid_eventos, public.fid_torcidas from anon;
revoke insert, update, delete, truncate on public.fid_eventos, public.fid_torcidas from authenticated;
drop policy if exists "equipe ve eventos" on public.fid_eventos;
create policy "equipe ve eventos" on public.fid_eventos for select to authenticated using (restaurante_id = public.meu_restaurante());
drop policy if exists "equipe ve torcidas" on public.fid_torcidas;
create policy "equipe ve torcidas" on public.fid_torcidas for select to authenticated using (restaurante_id = public.meu_restaurante());

-- Hora em que a torcida fecha (início do jogo; sem hora, fim do dia).
create or replace function public.fid_evento_fecha(e public.fid_eventos) returns timestamptz
language sql stable security definer set search_path = public as $$
  select (e.data + coalesce(e.hora, '23:59')::time) at time zone public.fid_fuso(e.restaurante_id);
$$;

-- Eventos que aparecem para o cliente: os próximos 30 dias e os resultados dos últimos 3 dias.
create or replace function public.fid_eventos_publicos(p_restaurante uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'nome', e.nome, 'data', e.data, 'hora', e.hora, 'times', to_jsonb(e.times),
      'mult', e.mult, 'vencedor', e.vencedor, 'aberta', e.vencedor is null and now() < public.fid_evento_fecha(e)) order by e.data, e.hora), '[]'::jsonb)
    from public.fid_eventos e
   where e.restaurante_id = p_restaurante
     and ((e.vencedor is null and e.data >= (now() at time zone public.fid_fuso(p_restaurante))::date - 1
           and e.data <= (now() at time zone public.fid_fuso(p_restaurante))::date + 30)
          or e.resultado_em > now() - interval '3 days');
$$;

-- Cliente escolhe o time (uma vez, até o início do jogo).
create or replace function public.fid_torcer(p_token uuid, p_evento uuid, p_time text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_r uuid; v_cpf text; e public.fid_eventos; ja text;
begin
  select s.restaurante_id, s.cpf into v_r, v_cpf from private.fid_sessoes s
   where s.token_hash = public.hash_token(p_token) and s.criado_em > now() - interval '180 days';
  if v_r is null then return jsonb_build_object('status', 'sem_sessao'); end if;
  if not public.fid_no_ar(v_r) then return jsonb_build_object('status', 'inativo'); end if;
  select * into e from public.fid_eventos where id = p_evento and restaurante_id = v_r;
  if not found then return jsonb_build_object('status', 'erro', 'mensagem', 'Evento não encontrado.'); end if;
  select time into ja from public.fid_torcidas where evento_id = e.id and cpf = v_cpf;
  if ja is not null then
    return jsonb_build_object('status', case when ja = p_time then 'ok' else 'erro' end, 'mensagem', 'Você já escolheu ' || ja || '.');
  end if;
  if e.vencedor is not null or now() >= public.fid_evento_fecha(e) then
    return jsonb_build_object('status', 'erro', 'mensagem', 'A escolha do time já fechou: o jogo começou.');
  end if;
  if not (p_time = any (e.times)) then return jsonb_build_object('status', 'erro', 'mensagem', 'Escolha um dos times.'); end if;
  insert into public.fid_torcidas (evento_id, restaurante_id, cpf, time) values (e.id, v_r, v_cpf, p_time);
  return jsonb_build_object('status', 'ok');
end $$;

-- Equipe: eventos com a contagem da torcida.
create or replace function public.fid_eventos_lista() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r uuid := public.meu_restaurante();
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'nome', e.nome, 'data', e.data, 'hora', e.hora, 'times', to_jsonb(e.times),
      'mult', e.mult, 'vencedor', e.vencedor, 'premiados', e.premiados, 'pontos_pagos', e.pontos_pagos, 'resultado_em', e.resultado_em,
      'aberta', e.vencedor is null and now() < public.fid_evento_fecha(e),
      'torcida', coalesce((select jsonb_object_agg(t.time, t.n) from (select time, count(*) as n from public.fid_torcidas
                                                                         where evento_id = e.id group by time) t), '{}'::jsonb))
      order by e.data desc, e.hora desc)
    from (select * from public.fid_eventos where restaurante_id = r order by data desc limit 40) e), '[]'::jsonb);
end $$;

-- Equipe cria ou edita um evento (antes do resultado).
create or replace function public.fid_evento_salvar(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  r uuid := public.meu_restaurante(); e public.fid_eventos; v_id uuid;
  v_nome text := left(btrim(coalesce(p ->> 'nome', '')), 60);
  v_hora text := nullif(btrim(coalesce(p ->> 'hora', '')), '');
  v_times text[]; v_mult numeric := round(least(greatest(public.num_ou(p ->> 'mult', 2), 1.1), 10), 2); v_data date;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  -- Times na ordem digitada, sem repetir.
  select array_agg(x order by i) into v_times from (
    select distinct on (lower(left(btrim(t), 30))) left(btrim(t), 30) as x, i
      from jsonb_array_elements_text(case when jsonb_typeof(p -> 'times') = 'array' then p -> 'times' else '[]'::jsonb end) with ordinality u(t, i)
     where btrim(t) <> '' order by lower(left(btrim(t), 30)), i) y;
  if coalesce(array_length(v_times, 1), 0) not between 2 and 4 then raise exception 'Informe os dois times (até quatro).'; end if;
  if coalesce(p ->> 'data', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Informe o dia do jogo.'; end if;
  v_data := (p ->> 'data')::date;
  if v_hora is null then raise exception 'Informe a hora do jogo: a escolha do time fecha nessa hora.'; end if;
  if v_hora !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Hora inválida (ex.: 16:00).'; end if;
  if v_nome = '' then v_nome := left(array_to_string(v_times, ' x '), 60); end if;
  if coalesce(p ->> 'id', '') ~ '^[0-9a-f-]{36}$' then
    select * into e from public.fid_eventos where id = (p ->> 'id')::uuid and restaurante_id = r for update;
    if not found then raise exception 'Evento não encontrado.'; end if;
    if e.vencedor is not null then raise exception 'Este evento já tem resultado.'; end if;
    if exists (select 1 from public.fid_torcidas where evento_id = e.id and not (time = any (v_times))) then
      raise exception 'Já tem torcedores escolhendo os times: não dá para trocar os times.';
    end if;
    update public.fid_eventos set nome = v_nome, data = v_data, hora = v_hora, times = v_times, mult = v_mult where id = e.id;
    return e.id;
  end if;
  if v_data < (now() at time zone public.fid_fuso(r))::date then raise exception 'O dia do jogo já passou.'; end if;
  insert into public.fid_eventos (restaurante_id, nome, data, hora, times, mult) values (r, v_nome, v_data, v_hora, v_times, v_mult)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.fid_evento_excluir(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante();
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  delete from public.fid_eventos where id = p_id and restaurante_id = r and vencedor is null;
  if not found then raise exception 'Evento não encontrado ou já com resultado.'; end if;
end $$;

-- Equipe lança o resultado. Quem torceu pelo vencedor ganha o bônus sobre os pontos das compras do dia
-- já creditadas; as que forem creditadas depois já entram multiplicadas (fid_calcular).
create or replace function public.fid_evento_resultado(p_id uuid, p_vencedor text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r uuid := public.meu_restaurante(); e public.fid_eventos; tz text; t record; base int; b int;
  n int := 0; total int := 0;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  select * into e from public.fid_eventos where id = p_id and restaurante_id = r for update;
  if not found then raise exception 'Evento não encontrado.'; end if;
  if e.vencedor is not null then raise exception 'O resultado já foi lançado.'; end if;
  if now() < public.fid_evento_fecha(e) then raise exception 'O jogo ainda não começou.'; end if;
  if not (p_vencedor = any (e.times) or p_vencedor = 'empate') then raise exception 'Escolha o time vencedor ou empate.'; end if;
  tz := public.fid_fuso(r);
  update public.fid_eventos set vencedor = p_vencedor, resultado_em = now(), resultado_por = public.fid_quem() where id = e.id;
  if p_vencedor <> 'empate' then
    for t in select cpf from public.fid_torcidas where evento_id = e.id and time = p_vencedor loop
      base := coalesce((select sum(pontos) from public.fid_notas where restaurante_id = r and cpf = t.cpf and status = 'creditada'
                          and (emitida_em at time zone tz)::date = e.data), 0)
            + coalesce((select sum(fid_pontos) from public.pedidos where restaurante_id = r and cpf = t.cpf and fid_situacao = 'creditado'
                          and (criado_em at time zone tz)::date = e.data), 0)
            + coalesce((select sum(pontos) from public.fid_movimentos where restaurante_id = r and cpf = t.cpf and tipo = 'manual'
                          and (criado_em at time zone tz)::date = e.data), 0);
      b := floor(base * (e.mult - 1))::int;
      if b > 0 then
        perform public.fid_mover(r, t.cpf, 'evento', b,
          left(e.nome || ': ' || p_vencedor || ' venceu (' || replace(rtrim(rtrim(to_char(e.mult, 'FM990.99'), '0'), '.'), '.', ',') || 'x)', 160),
          null, e.mult, null, null, public.fid_quem());
        n := n + 1; total := total + b;
      end if;
    end loop;
  end if;
  update public.fid_eventos set premiados = n, pontos_pagos = total where id = e.id;
  return jsonb_build_object('premiados', n, 'pontos', total);
end $$;

do $$
declare f text;
begin
  -- Internas (chamadas por outras funções).
  foreach f in array array['public.fid_vencer(uuid, text)', 'public.fid_vencer_todos()', 'public.fid_a_vencer(uuid, text)',
      'public.fid_bonus_aniversario(uuid, text)', 'public.fid_destino(uuid, text)', 'public.fid_validade(uuid)', 'public.fid_nascimento(int)',
      'public.fid_validade_desde(uuid)', 'public.fid_evento_fecha(public.fid_eventos)', 'public.fid_eventos_publicos(uuid)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
  -- Cliente (com o token do aparelho).
  foreach f in array array['public.fid_definir_aniversario(uuid, int)', 'public.fid_transferir_destino(uuid, text)',
      'public.fid_transferir(uuid, text, int, text)', 'public.fid_torcer(uuid, uuid, text)'] loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
  -- Equipe.
  foreach f in array array['public.fid_eventos_lista()', 'public.fid_evento_salvar(jsonb)', 'public.fid_evento_excluir(uuid)',
      'public.fid_evento_resultado(uuid, text)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- Validade: vence os pontos de todo mundo uma vez por dia (pg_cron). Sem pg_cron, os pontos vencem
-- quando o cliente abre a conta, consulta o saldo, troca ou transfere.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'fid-vencer-pontos';
    perform cron.schedule('fid-vencer-pontos', '17 6 * * *', 'select public.fid_vencer_todos()');
  end if;
exception when others then
  raise notice 'pg_cron indisponível: os pontos vencem quando o cliente usa a conta (%).', sqlerrm;
end $$;

-- ============================================================================
-- Prorrogação (adicional): happy hour que cresce a cada chopp, inspirado no Budclock.
-- O happy hour começa com um cronômetro (ex.: 60 min). Cada chopp servido, o garçom
-- lê o QR da Prorrogação (ou toca em "+1" no painel) e o relógio ganha mais 1 minuto.
-- Acaba quando o tempo zera. O restaurante personaliza nome, frase, minutos por chopp,
-- duração, teto, horário limite e a agenda (dias e hora em que começa sozinho).
-- ============================================================================
create table if not exists public.hh_sessoes (
  id             uuid primary key default gen_random_uuid(),
  restaurante_id uuid not null references public.restaurantes (id) on delete cascade,
  nome           text not null default 'Prorrogação' check (char_length(nome) <= 40),
  inicio         timestamptz not null default now(),
  fim            timestamptz not null,
  encerrada_em   timestamptz,
  motivo         text check (motivo in ('tempo', 'equipe')),
  leituras       int not null default 0,
  minutos_ganhos numeric(8, 2) not null default 0,
  criado_por     text check (char_length(criado_por) <= 60),
  -- Dia da agenda que esta sessão cumpre (a agenda começa uma vez por dia).
  agenda_dia     date
);
create unique index if not exists hh_sessoes_aberta_idx on public.hh_sessoes (restaurante_id) where encerrada_em is null;
create unique index if not exists hh_sessoes_agenda_idx on public.hh_sessoes (restaurante_id, agenda_dia) where agenda_dia is not null;
create index if not exists hh_sessoes_rest_idx on public.hh_sessoes (restaurante_id, inicio desc);

create table if not exists public.hh_leituras (
  id             uuid primary key default gen_random_uuid(),
  sessao_id      uuid not null references public.hh_sessoes (id) on delete cascade,
  restaurante_id uuid not null references public.restaurantes (id) on delete cascade,
  em             timestamptz not null default now(),
  qtd            int not null check (qtd between 1 and 50),
  minutos        numeric(8, 2) not null default 0,
  por            text check (char_length(por) <= 60),
  desfeita       boolean not null default false,
  desfeita_em    timestamptz,
  desfeita_por   text check (char_length(desfeita_por) <= 60)
);
create index if not exists hh_leituras_sessao_idx on public.hh_leituras (sessao_id, em desc);

alter table public.hh_sessoes enable row level security;
alter table public.hh_leituras enable row level security;
revoke all on public.hh_sessoes from anon, authenticated;
revoke all on public.hh_leituras from anon, authenticated;

-- Configuração arrumada (valores válidos, com os padrões).
create or replace function public.hh_cfg(p_restaurante uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'ativo', coalesce(c ->> 'ativo', '') = 'true',
    'nome', coalesce(nullif(left(btrim(c ->> 'nome'), 40), ''), 'Prorrogação'),
    -- Sem frase própria: "Cada chopp é mais 1 minuto de happy hour" (com o item e os minutos dos ajustes).
    'frase', coalesce(nullif(left(btrim(c ->> 'frase'), 120), ''),
      'Cada ' || coalesce(nullif(left(btrim(c ->> 'produto'), 30), ''), 'chopp') || ' é mais ' || m
        || case when m = 1 then ' minuto' else ' minutos' end || ' de happy hour'),
    'produto', coalesce(nullif(left(btrim(c ->> 'produto'), 30), ''), 'chopp'),
    'duracao', least(greatest(coalesce(public.num_ou(c ->> 'duracao', 60), 60), 5), 600)::int,
    'minutos', m,
    'teto', least(greatest(coalesce(public.num_ou(c ->> 'teto', 0), 0), 0), 1440)::int,
    'limite', case when coalesce(c ->> 'limite', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then c ->> 'limite' end,
    'agenda', jsonb_build_object(
      'ativo', coalesce(c -> 'agenda' ->> 'ativo', '') = 'true',
      'dias', coalesce((select jsonb_agg(distinct d::int) from jsonb_array_elements_text(
                 case when jsonb_typeof(c -> 'agenda' -> 'dias') = 'array' then c -> 'agenda' -> 'dias' else '[]'::jsonb end) d
               where d ~ '^[0-6]$'), '[]'::jsonb),
      'hora', case when coalesce(c -> 'agenda' ->> 'hora', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then c -> 'agenda' ->> 'hora' else '18:00' end))
  from (select prorrogacao as c from public.restaurantes where id = p_restaurante) x,
       lateral (select least(greatest(coalesce(public.num_ou(x.c ->> 'minutos', 1), 1), 1), 30)::int as m) y;
$$;

-- Horário limite (o relógio nunca passa dele): a primeira vez que dá aquela hora depois do início.
create or replace function public.hh_limite(p_restaurante uuid, p_inicio timestamptz) returns timestamptz
language plpgsql stable security definer set search_path = public as $$
declare l text := public.hh_cfg(p_restaurante) ->> 'limite'; tz text := public.fid_fuso(p_restaurante); t timestamptz;
begin
  if l is null then return 'infinity'::timestamptz; end if;
  t := ((p_inicio at time zone tz)::date + l::time) at time zone tz;
  if t <= p_inicio then t := t + interval '1 day'; end if;
  return t;
end $$;

-- Fecha a sessão cujo tempo acabou e começa a da agenda. Chamada por todas as funções da Prorrogação.
create or replace function public.hh_tick(p_restaurante uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  c jsonb := public.hh_cfg(p_restaurante); tz text := public.fid_fuso(p_restaurante);
  agora timestamp := now() at time zone public.fid_fuso(p_restaurante); ini timestamptz; ate timestamptz; aberta uuid;
begin
  update public.hh_sessoes set encerrada_em = fim, motivo = 'tempo'
   where restaurante_id = p_restaurante and encerrada_em is null and fim <= now();
  if c is null or not public.plano_adicional(p_restaurante, 'prorrogacao') or not (c ->> 'ativo')::boolean
     or not (c -> 'agenda' ->> 'ativo')::boolean or not (c -> 'agenda' -> 'dias') @> to_jsonb(extract(dow from agora)::int) then
    return;
  end if;
  if exists (select 1 from public.hh_sessoes where restaurante_id = p_restaurante and agenda_dia = agora::date) then return; end if;
  ini := (agora::date + (c -> 'agenda' ->> 'hora')::time) at time zone tz;
  ate := least(ini + make_interval(mins => (c ->> 'duracao')::int), public.hh_limite(p_restaurante, ini));
  if now() < ini or now() >= ate then return; end if;
  select id into aberta from public.hh_sessoes where restaurante_id = p_restaurante and encerrada_em is null and agenda_dia is null;
  if aberta is not null then
    -- A equipe já começou na mão: essa vale como a de hoje.
    update public.hh_sessoes set agenda_dia = agora::date where id = aberta;
  else
    insert into public.hh_sessoes (restaurante_id, nome, inicio, fim, criado_por, agenda_dia)
    values (p_restaurante, c ->> 'nome', ini, ate, 'Agenda', agora::date)
    on conflict do nothing;
  end if;
end $$;


-- A equipe só usa com o adicional contratado e ligado.
create or replace function public.hh_exigir(p_restaurante uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c jsonb;
begin
  if p_restaurante is null then raise exception 'Acesso negado.'; end if;
  if not public.plano_adicional(p_restaurante, 'prorrogacao') then
    raise exception 'A Prorrogação é um adicional e não está no plano deste restaurante. Contrate na aba Plano.';
  end if;
  c := public.hh_cfg(p_restaurante);
  if not (c ->> 'ativo')::boolean then raise exception 'Ligue a Prorrogação nos ajustes dela antes de usar.'; end if;
  return c;
end $$;

-- Painel: situação, ajustes, últimas leituras e histórico.
create or replace function public.hh_painel() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); st jsonb;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  st := public.hh_status(r);
  return st || jsonb_build_object('config', public.hh_cfg(r),
    'leituras', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'em', l.em, 'qtd', l.qtd, 'minutos', l.minutos, 'por', l.por,
          'desfeita', l.desfeita, 'desfeita_por', l.desfeita_por, 'mesa', l.mesa, 'comanda', l.comanda) order by l.em desc)
        from (select l.* from public.hh_leituras l
               where l.sessao_id = coalesce((st -> 'sessao' ->> 'id')::uuid,
                       (select id from public.hh_sessoes where restaurante_id = r order by inicio desc limit 1))
               order by l.em desc limit 15) l), '[]'::jsonb),
    'historico', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'nome', x.nome, 'inicio', x.inicio, 'fim', coalesce(x.encerrada_em, x.fim),
          'aberta', x.encerrada_em is null, 'motivo', x.motivo, 'leituras', x.leituras, 'minutos_ganhos', x.minutos_ganhos,
          'criado_por', x.criado_por) order by x.inicio desc)
        from (select * from public.hh_sessoes where restaurante_id = r order by inicio desc limit 20) x), '[]'::jsonb));
end $$;

-- Começa agora (p_minutos vazio = a duração dos ajustes).
create or replace function public.hh_comecar(p_minutos int default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); c jsonb; m int;
begin
  c := public.hh_exigir(r);
  perform public.hh_tick(r);
  if exists (select 1 from public.hh_sessoes where restaurante_id = r and encerrada_em is null) then
    raise exception 'Já tem uma % rolando.', c ->> 'nome';
  end if;
  m := least(greatest(coalesce(p_minutos, (c ->> 'duracao')::int), 1), 600);
  insert into public.hh_sessoes (restaurante_id, nome, inicio, fim, criado_por)
  values (r, c ->> 'nome', now(), least(now() + make_interval(mins => m), public.hh_limite(r, now())), coalesce(public.fid_quem(), 'Equipe'));
  return public.hh_painel();
end $$;


-- Desfaz a última leitura da sessão que está rolando (chopp lido duas vezes, engano).
create or replace function public.hh_desfazer() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); s public.hh_sessoes; l public.hh_leituras;
begin
  perform public.hh_exigir(r);
  perform public.hh_tick(r);
  select * into s from public.hh_sessoes where restaurante_id = r and encerrada_em is null for update;
  if s.id is null then raise exception 'Não tem nada rolando para desfazer.'; end if;
  select * into l from public.hh_leituras where sessao_id = s.id and not desfeita order by em desc limit 1;
  if l.id is null then raise exception 'Nenhuma leitura para desfazer.'; end if;
  update public.hh_leituras set desfeita = true, desfeita_em = now(), desfeita_por = coalesce(public.fid_quem(), 'Equipe') where id = l.id;
  update public.hh_sessoes set fim = fim - interval '1 minute' * l.minutos, leituras = leituras - l.qtd, minutos_ganhos = minutos_ganhos - l.minutos
   where id = s.id;
  perform public.hh_tick(r);
  return public.hh_painel();
end $$;

-- Encerra agora.
create or replace function public.hh_encerrar() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante();
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  perform public.hh_tick(r);
  update public.hh_sessoes set encerrada_em = now(), fim = least(fim, now()), motivo = 'equipe'
   where restaurante_id = r and encerrada_em is null;
  if not found then raise exception 'Não tem nada rolando agora.'; end if;
  return public.hh_painel();
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.hh_cfg(uuid)', 'public.hh_limite(uuid, timestamptz)', 'public.hh_tick(uuid)',
      'public.hh_exigir(uuid)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.hh_painel()', 'public.hh_comecar(int)', 'public.hh_desfazer()',
      'public.hh_encerrar()'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ============================================================================
-- Comandas individuais: a mesma plaquinha serve de comanda (uma por pessoa).
-- Ligada a uma comanda, ela abre a página com "Comanda 12" em vez da mesa.
-- Na Prorrogação, o garçom lê a comanda com o celular logado e soma o chopp.
-- ============================================================================
alter table public.etiquetas add column if not exists comanda int check (comanda between 1 and 9999);
create unique index if not exists etiquetas_comanda_idx on public.etiquetas (restaurante_id, comanda) where comanda is not null;

-- Ligou a uma mesa, desligou ou mudou de dono: deixa de ser comanda.
create or replace function public.etiqueta_limpa_comanda() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.mesa is not null or new.vinculada_em is null
     or (old.restaurante_id is not null and new.restaurante_id is distinct from old.restaurante_id) then
    new.comanda := null;
  end if;
  return new;
end $$;
revoke execute on function public.etiqueta_limpa_comanda() from public, anon, authenticated;
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'etiqueta_limpa_comanda' and tgrelid = 'public.etiquetas'::regclass) then
    create trigger etiqueta_limpa_comanda before update on public.etiquetas
      for each row execute function public.etiqueta_limpa_comanda();
  end if;
end $$;

-- Página da plaquinha: mesa ou comanda (sem login).
create or replace function public.etiqueta_info(p_restaurante uuid, p_codigo text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('mesa', mesa, 'comanda', comanda)
    from public.etiquetas where codigo = upper(btrim(p_codigo)) and restaurante_id = p_restaurante;
$$;

-- Equipe liga a plaquinha a uma comanda (número único no restaurante).
create or replace function public.etiqueta_comanda(p_codigo text, p_comanda int) returns void
language plpgsql security definer set search_path = public as $$
declare
  r uuid := public.meu_restaurante();
  v_cod text := upper(regexp_replace(coalesce(p_codigo, ''), '[^A-Za-z0-9]', '', 'g'));
  e public.etiquetas; outra text;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  if p_comanda is null or p_comanda < 1 or p_comanda > 9999 then raise exception 'Número da comanda inválido (1 a 9999).'; end if;
  select * into e from public.etiquetas where codigo = v_cod for update;
  if not found then raise exception 'Plaquinha não encontrada. Confira o código.'; end if;
  if e.restaurante_id is not null and e.restaurante_id <> r then raise exception 'Esta plaquinha é de outro restaurante.'; end if;
  select codigo into outra from public.etiquetas where restaurante_id = r and comanda = p_comanda and codigo <> v_cod;
  if outra is not null then raise exception 'A comanda % já está na plaquinha %.', p_comanda, outra; end if;
  update public.etiquetas
     set restaurante_id = r, ativada_em = coalesce(ativada_em, now()), mesa = null, comanda = p_comanda, vinculada_em = now(),
         vinculada_por = (select nome from public.equipe_membros where user_id = auth.uid())
   where codigo = v_cod;
end $$;

-- Leituras da Prorrogação: de qual mesa ou comanda veio o chopp.
alter table public.hh_leituras add column if not exists etiqueta text;
alter table public.hh_leituras add column if not exists mesa int;
alter table public.hh_leituras add column if not exists comanda int;
create index if not exists hh_leituras_etiqueta_idx on public.hh_leituras (etiqueta, em desc) where etiqueta is not null;

-- Soma os chopps (interna): respeita o teto e o horário limite.
create or replace function public.hh_somar_int(p_restaurante uuid, p_qtd int, p_etiqueta text, p_mesa int, p_comanda int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c jsonb; s public.hh_sessoes; q int; m numeric; pedido numeric; novo timestamptz; lid uuid;
begin
  c := public.hh_exigir(p_restaurante);
  perform public.hh_tick(p_restaurante);
  select * into s from public.hh_sessoes where restaurante_id = p_restaurante and encerrada_em is null for update;
  if s.id is null then raise exception 'A % não está rolando agora.', c ->> 'nome'; end if;
  q := least(greatest(coalesce(p_qtd, 1), 1), 50);
  pedido := q * (c ->> 'minutos')::int;
  m := pedido;
  if (c ->> 'teto')::int > 0 then m := least(m, greatest((c ->> 'teto')::int - s.minutos_ganhos, 0)); end if;
  novo := least(s.fim + interval '1 minute' * m, public.hh_limite(p_restaurante, s.inicio));
  m := greatest(round((extract(epoch from (novo - s.fim)) / 60)::numeric, 2), 0);
  novo := s.fim + interval '1 minute' * m;
  insert into public.hh_leituras (sessao_id, restaurante_id, qtd, minutos, por, etiqueta, mesa, comanda)
  values (s.id, p_restaurante, q, m, coalesce(public.fid_quem(), 'Equipe'), p_etiqueta, p_mesa, p_comanda)
  returning id into lid;
  update public.hh_sessoes set fim = novo, leituras = leituras + q, minutos_ganhos = minutos_ganhos + m where id = s.id;
  return jsonb_build_object('leitura_id', lid, 'adicionados', m, 'travado', m < pedido);
end $$;

create or replace function public.hh_somar(p_qtd int default 1) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); x jsonb;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  x := public.hh_somar_int(r, p_qtd, null, null, null);
  return public.hh_painel() || x;
end $$;

-- Garçom leu a plaquinha (comanda ou mesa) com o celular logado: soma 1 chopp.
-- A mesma plaquinha lida de novo em 20 segundos não conta (a página recarregou), a não ser com p_forcar.
create or replace function public.hh_somar_etiqueta(p_codigo text, p_forcar boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); e public.etiquetas; x jsonb; c jsonb;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  c := public.hh_exigir(r);
  select * into e from public.etiquetas where codigo = upper(btrim(p_codigo)) and restaurante_id = r;
  if not found then raise exception 'Esta plaquinha não é deste restaurante.'; end if;
  if e.mesa is null and e.comanda is null then raise exception 'Esta plaquinha ainda não está ligada a uma mesa ou comanda.'; end if;
  if not coalesce(p_forcar, false) and exists (select 1 from public.hh_leituras
      where etiqueta = e.codigo and not desfeita and em > now() - interval '20 seconds') then
    return public.hh_status(r) || jsonb_build_object('repetida', true, 'mesa', e.mesa, 'comanda', e.comanda);
  end if;
  x := public.hh_somar_int(r, 1, e.codigo, e.mesa, e.comanda);
  return public.hh_status(r) || x || jsonb_build_object('mesa', e.mesa, 'comanda', e.comanda);
end $$;

-- Desfaz uma leitura (o garçom tocou em "Desfazer" logo depois de ler a comanda).
create or replace function public.hh_desfazer_leitura(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); s public.hh_sessoes; l public.hh_leituras;
begin
  perform public.hh_exigir(r);
  perform public.hh_tick(r);
  select * into s from public.hh_sessoes where restaurante_id = r and encerrada_em is null for update;
  if s.id is null then raise exception 'Não tem nada rolando para desfazer.'; end if;
  select * into l from public.hh_leituras where id = p_id and sessao_id = s.id and not desfeita;
  if l.id is null then raise exception 'Esta leitura já foi desfeita.'; end if;
  update public.hh_leituras set desfeita = true, desfeita_em = now(), desfeita_por = coalesce(public.fid_quem(), 'Equipe') where id = l.id;
  update public.hh_sessoes set fim = fim - interval '1 minute' * l.minutos, leituras = leituras - l.qtd, minutos_ganhos = minutos_ganhos - l.minutos
   where id = s.id;
  perform public.hh_tick(r);
  return public.hh_status(r);
end $$;

-- Situação com a última leitura (para o telão mostrar "Comanda 12: +1 min") e quem mais prorrogou.
create or replace function public.hh_status(p_restaurante uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c jsonb; s public.hh_sessoes; u public.hh_sessoes; lim timestamptz; prox timestamptz;
  tz text := public.fid_fuso(p_restaurante); agora timestamp := now() at time zone public.fid_fuso(p_restaurante);
begin
  if not public.restaurante_ativo(p_restaurante) or not public.plano_adicional(p_restaurante, 'prorrogacao') then
    return jsonb_build_object('disponivel', false);
  end if;
  c := public.hh_cfg(p_restaurante);
  if not (c ->> 'ativo')::boolean then return jsonb_build_object('disponivel', false); end if;
  perform public.hh_tick(p_restaurante);
  select * into s from public.hh_sessoes where restaurante_id = p_restaurante and encerrada_em is null;
  if s.id is not null then lim := public.hh_limite(p_restaurante, s.inicio); end if;
  select * into u from public.hh_sessoes where restaurante_id = p_restaurante and encerrada_em is not null order by encerrada_em desc limit 1;
  if (c -> 'agenda' ->> 'ativo')::boolean then
    select min(((agora::date + d) + (c -> 'agenda' ->> 'hora')::time) at time zone tz) into prox
      from generate_series(0, 7) d
     where (c -> 'agenda' -> 'dias') @> to_jsonb(extract(dow from agora::date + d)::int)
       and ((agora::date + d) + (c -> 'agenda' ->> 'hora')::time) at time zone tz > now()
       and not exists (select 1 from public.hh_sessoes x where x.restaurante_id = p_restaurante and x.agenda_dia = agora::date + d);
  end if;
  return jsonb_build_object('disponivel', true, 'agora', now(),
    'nome', c -> 'nome', 'frase', c -> 'frase', 'produto', c -> 'produto', 'minutos', c -> 'minutos', 'teto', c -> 'teto',
    'rodando', s.id is not null,
    'sessao', case when s.id is not null then jsonb_build_object('id', s.id, 'inicio', s.inicio, 'fim', s.fim,
        'leituras', s.leituras, 'minutos_ganhos', s.minutos_ganhos,
        'limite_em', case when lim = 'infinity' then null else lim end,
        'ultima', (select max(em) from public.hh_leituras where sessao_id = s.id and not desfeita),
        'ultima_leitura', (select jsonb_build_object('id', l.id, 'em', l.em, 'qtd', l.qtd, 'minutos', l.minutos, 'mesa', l.mesa, 'comanda', l.comanda)
                             from public.hh_leituras l where l.sessao_id = s.id and not l.desfeita order by l.em desc limit 1),
        'destaques', coalesce((select jsonb_agg(d order by (d ->> 'qtd')::int desc) from (
            select jsonb_build_object('comanda', l.comanda, 'mesa', case when l.comanda is null then l.mesa end, 'qtd', sum(l.qtd)) d
              from public.hh_leituras l where l.sessao_id = s.id and not l.desfeita and (l.comanda is not null or l.mesa is not null)
             group by l.comanda, case when l.comanda is null then l.mesa end
             order by sum(l.qtd) desc limit 3) t), '[]'::jsonb)) end,
    'ultima_sessao', case when u.id is not null then jsonb_build_object('inicio', u.inicio, 'fim', u.encerrada_em,
        'leituras', u.leituras, 'minutos_ganhos', u.minutos_ganhos) end,
    'recorde', (select jsonb_build_object('minutos', round(extract(epoch from (x.encerrada_em - x.inicio)) / 60), 'leituras', x.leituras, 'em', x.inicio)
                  from public.hh_sessoes x where x.restaurante_id = p_restaurante and x.encerrada_em is not null
                 order by x.encerrada_em - x.inicio desc limit 1),
    'proxima', prox);
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.hh_somar_int(uuid, int, text, int, int)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.etiqueta_info(uuid, text)', 'public.hh_status(uuid)'] loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
  foreach f in array array['public.etiqueta_comanda(text, int)', 'public.hh_somar_etiqueta(text, boolean)', 'public.hh_desfazer_leitura(uuid)',
      'public.hh_somar(int)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Cartão fidelidade (selos): cada compra vale um selo; completou o cartão, ganha o prêmio.
-- Tipo do programa em restaurantes.fidelidade:
--   modo: 'pontos' (clube de pontos), 'selos' (só o cartão) ou 'ambos' (cada um no seu horário).
--   selos: { nome, total (3 a 30), premio, detalhe, valorMinimo, umPorDia, validadeDias (0 = não vence) }
--   horarios: { selos: { dias, de, ate }, pontos: { dias, de, ate } } (usado só no modo 'ambos').
-- Quem escolhe o programa é o horário em que a nota foi emitida, não o da leitura do QR.
-- Fora de todos os horários, a compra não conta. Uma nota alimenta um programa só.
-- ---------------------------------------------------------------------------
create table if not exists public.fid_cartoes (
  id             uuid primary key default gen_random_uuid(),
  restaurante_id uuid not null,
  cpf            text not null,
  total          int  not null check (total between 3 and 30),
  selos          int  not null default 0 check (selos >= 0),
  premio         text not null check (char_length(premio) <= 60),
  status         text not null default 'aberto' check (status in ('aberto', 'completo', 'resgatado', 'vencido')),
  criado_em      timestamptz not null default now(),
  vence_em       timestamptz,
  completo_em    timestamptz,
  foreign key (restaurante_id, cpf) references public.fid_clientes (restaurante_id, cpf) on delete cascade
);
create index if not exists fid_cartoes_cliente_idx on public.fid_cartoes (restaurante_id, cpf, criado_em desc);
create index if not exists fid_cartoes_rest_idx on public.fid_cartoes (restaurante_id, status);

create table if not exists public.fid_selos (
  id             bigint generated always as identity primary key,
  cartao_id      uuid not null references public.fid_cartoes (id) on delete cascade,
  restaurante_id uuid not null,
  cpf            text not null,
  dia            date not null,
  valor          numeric(12, 2),
  nota_chave     text,
  pedido_id      uuid,
  descricao      text check (char_length(descricao) <= 160),
  por            text check (char_length(por) <= 60),
  criado_em      timestamptz not null default now(),
  foreign key (restaurante_id, cpf) references public.fid_clientes (restaurante_id, cpf) on delete cascade
);
create index if not exists fid_selos_cliente_idx on public.fid_selos (restaurante_id, cpf, dia);
create unique index if not exists fid_selos_nota_idx on public.fid_selos (nota_chave) where nota_chave is not null;

-- Programa que a nota alimentou e a troca que veio de um cartão completo.
alter table public.fid_notas add column if not exists programa text check (programa in ('pontos', 'selos'));
alter table public.fid_resgates add column if not exists cartao_id uuid references public.fid_cartoes (id) on delete set null;

-- 'pontos' | 'selos' | 'ambos'
create or replace function public.fid_modo(p_restaurante uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when m in ('selos', 'ambos') then m else 'pontos' end from (select public.fid_cfg(p_restaurante) ->> 'modo' as m) x;
$$;

-- Regras do cartão, arrumadas e com os valores iniciais.
create or replace function public.fid_selos_cfg(p_restaurante uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'nome', left(coalesce(nullif(btrim(s ->> 'nome'), ''), 'Cartão fidelidade'), 40),
    'total', least(greatest(public.num_ou(s ->> 'total', 10), 3), 30)::int,
    'premio', left(coalesce(nullif(btrim(s ->> 'premio'), ''), '1 refeição grátis'), 60),
    'detalhe', left(coalesce(s ->> 'detalhe', ''), 160),
    'valorMinimo', round(least(greatest(public.num_ou(s ->> 'valorMinimo', 0), 0), 10000), 2),
    'umPorDia', coalesce(s ->> 'umPorDia', 'true') <> 'false',
    'validadeDias', least(greatest(public.num_ou(s ->> 'validadeDias', 90), 0), 730)::int)
  from (select case when jsonb_typeof(public.fid_cfg(p_restaurante) -> 'selos') = 'object'
                    then public.fid_cfg(p_restaurante) -> 'selos' else '{}'::jsonb end as s) x;
$$;

-- Horário de um programa: { dias [0=dom..6=sáb, vazio = todos], de/ate 'HH:MM' (pode virar a meia-noite) }.
create or replace function public.fid_janela_limpa(p jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'dias', case when jsonb_typeof(p -> 'dias') = 'array' then p -> 'dias' else '[]'::jsonb end,
    'de', case when coalesce(p ->> 'de', '') ~ '^[0-9]{1,2}:[0-9]{2}$' then p ->> 'de' else '' end,
    'ate', case when coalesce(p ->> 'ate', '') ~ '^[0-9]{1,2}:[0-9]{2}$' then p ->> 'ate' else '' end);
$$;

-- A hora local cai no horário? Sem dias nem horas = horário não configurado (nunca).
create or replace function public.fid_na_janela(p jsonb, p_loc timestamp) returns boolean
language plpgsql immutable set search_path = public as $$
declare
  j jsonb := public.fid_janela_limpa(p);
  dias jsonb := j -> 'dias';
  dia int := extract(dow from p_loc)::int;
  minuto int := (extract(hour from p_loc) * 60 + extract(minute from p_loc))::int;
  ini int; fim int;
begin
  if jsonb_typeof(p) is distinct from 'object' then return false; end if;
  if j ->> 'de' = '' or j ->> 'ate' = '' then
    return jsonb_array_length(dias) > 0 and dias @> to_jsonb(dia);
  end if;
  ini := split_part(j ->> 'de', ':', 1)::int * 60 + split_part(j ->> 'de', ':', 2)::int;
  fim := split_part(j ->> 'ate', ':', 1)::int * 60 + split_part(j ->> 'ate', ':', 2)::int;
  if fim > ini then
    return (jsonb_array_length(dias) = 0 or dias @> to_jsonb(dia)) and minuto >= ini and minuto < fim;
  end if;
  -- Vira a meia-noite: a madrugada conta como o dia em que o horário começou.
  return ((jsonb_array_length(dias) = 0 or dias @> to_jsonb(dia)) and minuto >= ini)
      or ((jsonb_array_length(dias) = 0 or dias @> to_jsonb((dia + 6) % 7)) and minuto < fim);
end $$;

-- Programa de uma compra feita em p_quando: 'pontos', 'selos' ou null (fora dos horários).
create or replace function public.fid_programa_em(p_restaurante uuid, p_quando timestamptz) returns text
language plpgsql stable security definer set search_path = public as $$
declare m text := public.fid_modo(p_restaurante); h jsonb; loc timestamp;
begin
  if m <> 'ambos' then return m; end if;
  h := public.fid_cfg(p_restaurante) -> 'horarios';
  loc := p_quando at time zone public.fid_fuso(p_restaurante);
  if public.fid_na_janela(h -> 'selos', loc) then return 'selos'; end if;
  if public.fid_na_janela(h -> 'pontos', loc) then return 'pontos'; end if;
  return null;
end $$;

-- Com os dois programas, cada um só deixa trocar e transferir no próprio horário (fora dele, o cliente só vê).
-- Devolve o motivo, ou null se pode.
create or replace function public.fid_fora_do_horario(p_restaurante uuid, p_prog text) returns text
language sql stable security definer set search_path = public as $$
  select case when public.fid_modo(p_restaurante) = 'ambos' and public.fid_programa_em(p_restaurante, now()) is distinct from p_prog
    then case when p_prog = 'selos' then 'O cartão só pode ser trocado no horário dele. Agora ele fica só para ver.'
              else 'Os pontos só podem ser usados no horário deles. Agora eles ficam só para ver.' end end;
$$;

-- Dá um selo pela compra: valor mínimo, 1 por dia (se ligado) e cartão vencido começa outro.
-- Devolve { ok, motivo } ou { ok, cartao, selos, total, completo, premio }.
create or replace function public.fid_carimbar(p_restaurante uuid, p_cpf text, p_valor numeric, p_quando timestamptz,
  p_chave text, p_pedido uuid, p_descricao text, p_por text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s jsonb := public.fid_selos_cfg(p_restaurante);
  v_dia date := (p_quando at time zone public.fid_fuso(p_restaurante))::date;
  v_min numeric := (s ->> 'valorMinimo')::numeric;
  v_val int := (s ->> 'validadeDias')::int;
  k public.fid_cartoes;
begin
  -- Uma compra por vez por cliente: duas notas do mesmo dia lidas juntas não furam o "1 por dia".
  perform 1 from public.fid_clientes where restaurante_id = p_restaurante and cpf = p_cpf for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'Cliente não encontrado.'); end if;
  if v_min > 0 and coalesce(p_valor, 0) < v_min then
    return jsonb_build_object('ok', false, 'motivo',
      'A compra de ' || public.brl(p_valor) || ' ficou abaixo do mínimo de ' || public.brl(v_min) || ' para ganhar selo.');
  end if;
  if (s ->> 'umPorDia')::boolean and exists (select 1 from public.fid_selos
       where restaurante_id = p_restaurante and cpf = p_cpf and dia = v_dia) then
    return jsonb_build_object('ok', false, 'motivo', 'Já tem selo do dia ' || to_char(v_dia, 'DD/MM') || ' no cartão. Vale 1 selo por dia.');
  end if;
  select * into k from public.fid_cartoes where restaurante_id = p_restaurante and cpf = p_cpf and status = 'aberto'
   order by criado_em desc limit 1 for update;
  if k.id is not null and k.vence_em is not null and k.vence_em < p_quando then
    update public.fid_cartoes set status = 'vencido' where id = k.id;
    k := null;
  end if;
  if k.id is null then
    insert into public.fid_cartoes (restaurante_id, cpf, total, premio)
    values (p_restaurante, p_cpf, (s ->> 'total')::int, s ->> 'premio') returning * into k;
  end if;
  insert into public.fid_selos (cartao_id, restaurante_id, cpf, dia, valor, nota_chave, pedido_id, descricao, por)
  values (k.id, p_restaurante, p_cpf, v_dia, p_valor, p_chave, p_pedido, left(p_descricao, 160), left(p_por, 60));
  update public.fid_cartoes
     set selos = selos + 1,
         vence_em = coalesce(vence_em, case when v_val > 0 then p_quando + make_interval(days => v_val) end),
         status = case when selos + 1 >= total then 'completo' else 'aberto' end,
         completo_em = case when selos + 1 >= total then now() else completo_em end
   where id = k.id returning * into k;
  return jsonb_build_object('ok', true, 'cartao', k.id, 'selos', k.selos, 'total', k.total,
    'completo', k.status = 'completo', 'premio', k.premio);
end $$;

-- Nota cancelada (ou de outro CPF): o selo sai do cartão. Cartão já trocado fica como está.
create or replace function public.fid_descarimbar(p_chave text) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_sel bigint; v_k uuid;
begin
  select s.id, s.cartao_id into v_sel, v_k from public.fid_selos s
    join public.fid_cartoes c on c.id = s.cartao_id
   where s.nota_chave = p_chave and c.status <> 'resgatado';
  if v_sel is null then return false; end if;
  delete from public.fid_selos where id = v_sel;
  update public.fid_cartoes
     set selos = greatest(selos - 1, 0),
         status = case when status = 'completo' then 'aberto' else status end,
         completo_em = case when status = 'completo' then null else completo_em end
   where id = v_k;
  return true;
end $$;

-- Cartão do cliente: o que está sendo preenchido e os completos esperando a troca.
create or replace function public.fid_cartao_resumo(p_restaurante uuid, p_cpf text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'aberto', (select jsonb_build_object('id', c.id, 'selos', c.selos, 'total', c.total, 'premio', c.premio,
                  'vence_em', c.vence_em, 'vencido', c.vence_em is not null and c.vence_em < now(),
                  'dias', coalesce((select jsonb_agg(s.dia order by s.id) from public.fid_selos s where s.cartao_id = c.id), '[]'::jsonb))
                 from public.fid_cartoes c
                where c.restaurante_id = p_restaurante and c.cpf = p_cpf and c.status = 'aberto'
                order by c.criado_em desc limit 1),
    'completos', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'premio', c.premio, 'total', c.total,
                  'completo_em', c.completo_em) order by c.completo_em)
                 from public.fid_cartoes c
                where c.restaurante_id = p_restaurante and c.cpf = p_cpf and c.status = 'completo'), '[]'::jsonb),
    'resgatados', (select count(*) from public.fid_cartoes
                    where restaurante_id = p_restaurante and cpf = p_cpf and status = 'resgatado'));
$$;

-- Programa que a nota alimentou e, se virou selo, como ficou o cartão.
create or replace function public.fid_nota_extra(p_chave text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('programa', coalesce(n.programa, 'pontos'),
      'cartao', (select jsonb_build_object('selos', c.selos, 'total', c.total, 'premio', c.premio,
                    'completo', c.status in ('completo', 'resgatado'))
                   from public.fid_selos s join public.fid_cartoes c on c.id = s.cartao_id
                  where s.nota_chave = n.chave))
    from public.fid_notas n where n.chave = p_chave), '{}'::jsonb);
$$;

-- Cliente troca um cartão completo pelo prêmio: recebe o código para mostrar ao garçom.
create or replace function public.fid_resgatar_cartao(p_token uuid, p_cartao uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_r uuid; v_cpf text; k public.fid_cartoes; v_id uuid; v_cod text; b bytea;
begin
  select s.restaurante_id, s.cpf into v_r, v_cpf from private.fid_sessoes s
   where s.token_hash = public.hash_token(p_token) and s.criado_em > now() - interval '180 days';
  if v_r is null then return jsonb_build_object('status', 'sem_sessao'); end if;
  if not public.fid_no_ar(v_r) then return jsonb_build_object('status', 'inativo'); end if;
  if public.fid_fora_do_horario(v_r, 'selos') is not null then
    return jsonb_build_object('status', 'erro', 'mensagem', public.fid_fora_do_horario(v_r, 'selos'));
  end if;
  select * into k from public.fid_cartoes where id = p_cartao and restaurante_id = v_r and cpf = v_cpf for update;
  if not found or k.status <> 'completo' then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Este cartão não está completo ou já foi trocado.');
  end if;
  if (select count(*) from public.fid_resgates where restaurante_id = v_r and cpf = v_cpf and status = 'pendente') >= 3 then
    return jsonb_build_object('status', 'erro', 'mensagem', 'Você já tem 3 resgates esperando a entrega. Mostre os códigos ao garçom.');
  end if;
  b := extensions.gen_random_bytes(2);
  v_cod := lpad((((get_byte(b, 0) << 8) | get_byte(b, 1)) % 10000)::text, 4, '0');
  insert into public.fid_resgates (restaurante_id, cpf, premio_id, premio_nome, pontos, codigo, cartao_id)
  values (v_r, v_cpf, null, k.premio, 0, v_cod, k.id) returning id into v_id;
  update public.fid_cartoes set status = 'resgatado' where id = k.id;
  return jsonb_build_object('status', 'ok',
    'resgate', jsonb_build_object('id', v_id, 'premio', k.premio, 'pontos', 0, 'codigo', v_cod, 'status', 'pendente',
      'cartao', true, 'criado_em', now()));
end $$;

alter table public.fid_cartoes enable row level security;
alter table public.fid_selos enable row level security;
revoke all on public.fid_cartoes, public.fid_selos from anon;
revoke insert, update, delete, truncate on public.fid_cartoes, public.fid_selos from authenticated;
drop policy if exists "equipe ve cartoes da fidelidade" on public.fid_cartoes;
create policy "equipe ve cartoes da fidelidade" on public.fid_cartoes
  for select to authenticated using (restaurante_id = public.meu_restaurante());
drop policy if exists "equipe ve selos da fidelidade" on public.fid_selos;
create policy "equipe ve selos da fidelidade" on public.fid_selos
  for select to authenticated using (restaurante_id = public.meu_restaurante());

do $$
declare f text;
begin
  foreach f in array array[
    'public.fid_modo(uuid)', 'public.fid_selos_cfg(uuid)', 'public.fid_janela_limpa(jsonb)',
    'public.fid_na_janela(jsonb, timestamp)', 'public.fid_programa_em(uuid, timestamptz)',
    'public.fid_carimbar(uuid, text, numeric, timestamptz, text, uuid, text, text)', 'public.fid_descarimbar(text)',
    'public.fid_cartao_resumo(uuid, text)', 'public.fid_nota_extra(text)', 'public.fid_fora_do_horario(uuid, text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
  execute 'revoke execute on function public.fid_resgatar_cartao(uuid, uuid) from public';
  execute 'grant execute on function public.fid_resgatar_cartao(uuid, uuid) to anon, authenticated';
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
  vortex  text                      -- e-mail(s) da Vortex que recebem os avisos internos, separados por vírgula
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

-- Aviso interno para a Vortex (um e-mail para cada endereço configurado).
create or replace function private.aviso_vortex(p_tipo text, p_assunto text, p_html text) returns void
language plpgsql security definer set search_path = public as $$
declare e text;
begin
  foreach e in array string_to_array(coalesce((select vortex from private.avisos_config where id = 1), ''), ',') loop
    perform private.aviso(p_tipo, btrim(e), p_assunto, p_html);
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

-- ===========================================================================
-- Limpeza (03/10)
--   * Sai a ativação de plaquinha por código (substituída por "digitar o endereço do restaurante"):
--     ativar_etiqueta, trocar_codigo_ativacao, a tabela tentativas_ativacao e a coluna codigo_ativacao.
--   * Faxina diária: o que já venceu e não serve para nada (sessões vencidas, códigos vencidos,
--     e-mails enviados há mais de 30 dias, chamados com mais de 1 ano).
-- ===========================================================================
drop function if exists public.ativar_etiqueta(text, text);
drop function if exists public.trocar_codigo_ativacao(uuid);
drop table if exists public.tentativas_ativacao;
alter table public.restaurantes drop column if exists codigo_ativacao;

create or replace function private.faxina() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from private.fid_sessoes where criado_em < now() - interval '180 days';
  delete from public.sessoes where criado_em < now() - interval '30 days';
  delete from private.codigos where expira_em < now() - interval '1 day';
  delete from private.tentativas where em < now() - interval '1 day';
  delete from private.avisos_fila where (enviado_em is not null and enviado_em < now() - interval '30 days')
     or criado_em < now() - interval '30 days';
  delete from public.chamados where criado_em < now() - interval '1 year';
end $$;
revoke execute on function private.faxina() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'faxina-diaria';
    perform cron.schedule('faxina-diaria', '41 6 * * *', 'select private.faxina()');
  end if;
end $$;

-- ===========================================================================
-- Segurança (03/10)
-- ===========================================================================
-- O cliente acompanha só o próprio chamado (pelo token da sessão da mesa). Antes, qualquer pessoa sem
-- login lia os chamados das últimas 3 horas de todos os restaurantes (mesa, observação, quem atendeu).
create or replace function public.chamado_status(p_token uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(c) - 'sessao_id' - 'restaurante_id'
    from public.chamados c join public.sessoes s on s.id = c.sessao_id
   where c.id = p_id and s.token_hash = public.hash_token(p_token);
$$;
revoke execute on function public.chamado_status(uuid, uuid) from public;
grant execute on function public.chamado_status(uuid, uuid) to anon, authenticated;
drop policy if exists "cliente acompanha chamados recentes" on public.chamados;
revoke select on public.chamados from anon;

-- Comentário anônimo: até 6 por hora do mesmo aparelho/rede e 200 por hora por restaurante (contra spam).
create or replace function private.limita_comentarios() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'anon' and (not public.equipe_pode_tentar('comentario:' || public.ip_do_pedido(), 6, 60)
     or not public.equipe_pode_tentar('comentario-rest:' || new.restaurante_id, 200, 60)) then
    raise exception 'Recebemos vários comentários seguidos. Tente de novo mais tarde.';
  end if;
  new.texto := left(new.texto, 500);
  return new;
end $$;
revoke execute on function private.limita_comentarios() from public, anon, authenticated;
drop trigger if exists comentarios_limite on public.comentarios;
create trigger comentarios_limite before insert on public.comentarios
  for each row execute function private.limita_comentarios();

-- Equipe: aparelho confiável. O PIN (4 a 8 números) só vale em aparelho que já entrou uma vez com o
-- código da equipe (ou pelo código do e-mail). De um aparelho novo, pede o código da equipe junto.
-- Assim, descobrir um PIN de fora do restaurante não basta para entrar no painel.
create table if not exists private.equipe_aparelhos (
  token_hash     text primary key,
  restaurante_id uuid not null references public.restaurantes (id) on delete cascade,
  criado_em      timestamptz not null default now(),
  usado_em       timestamptz not null default now()
);
create index if not exists equipe_aparelhos_rest_idx on private.equipe_aparelhos (restaurante_id);

create or replace function public.equipe_aparelho_ok(p_restaurante uuid, p_token text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then return false; end if;
  update private.equipe_aparelhos set usado_em = now()
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') and restaurante_id = p_restaurante
     and usado_em > now() - interval '180 days';
  return found;
end $$;
create or replace function public.equipe_aparelho_novo(p_restaurante uuid) returns text
language plpgsql security definer set search_path = public as $$
declare t text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  insert into private.equipe_aparelhos (token_hash, restaurante_id) values (encode(extensions.digest(t, 'sha256'), 'hex'), p_restaurante);
  return t;
end $$;
-- Trocar o código da equipe desconecta os aparelhos: cada um pede o código novo na próxima entrada.
create or replace function public.equipe_aparelhos_esquecer(p_restaurante uuid) returns void
language sql security definer set search_path = public as $$
  delete from private.equipe_aparelhos where restaurante_id = p_restaurante;
$$;
do $$
declare f text;
begin
  foreach f in array array['public.equipe_aparelho_ok(uuid, text)', 'public.equipe_aparelho_novo(uuid)', 'public.equipe_aparelhos_esquecer(uuid)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Funções sem search_path fixo (aviso do Supabase): fixa no public.
alter function private.sefaz_custo(integer) set search_path = public;
alter function public.sefaz_preco_nota() set search_path = public;
alter function public.implantacao_faixa(integer) set search_path = public;
alter function public.adicional_preco(text) set search_path = public;
alter function private.email_mascarado(text) set search_path = public;
alter function private.esc_html(text) set search_path = public;
alter function private.email_html(text, text, text, text) set search_path = public;

-- Índices das chaves estrangeiras que o Supabase apontou (crescimento com muitos restaurantes).
create index if not exists fid_resgates_cartao_idx on public.fid_resgates (cartao_id) where cartao_id is not null;
create index if not exists fid_resgates_premio_idx on public.fid_resgates (premio_id) where premio_id is not null;
create index if not exists fid_resgates_cliente_idx on public.fid_resgates (restaurante_id, cpf);
create index if not exists fid_selos_cartao_idx on public.fid_selos (cartao_id);
create index if not exists fid_torcidas_cliente_idx on public.fid_torcidas (restaurante_id, cpf);
create index if not exists hh_leituras_rest_idx on public.hh_leituras (restaurante_id, em desc);
create index if not exists leituras_dia_codigo_idx on public.leituras_dia (codigo);
