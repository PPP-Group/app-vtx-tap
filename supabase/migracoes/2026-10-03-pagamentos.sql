-- ===========================================================================
-- Pagamentos (Asaas): mensalidade recorrente no cartão (o cartão é digitado na página segura do
-- Asaas e fica guardado lá, nunca passa pelo VTX Tap) ou Pix/boleto todo mês.
--   * private.assinaturas: uma por restaurante (cliente e assinatura no Asaas).
--   * private.faturas: espelho das cobranças, atualizado pelo webhook do Asaas.
--   * private.pag_eventos: eventos do webhook já processados (o Asaas pode mandar o mesmo duas vezes).
--   * Mudou o plano: o banco chama a função "pagamentos" (pg_net), que ajusta o valor da assinatura
--     e lança a taxa única das mesas a mais.
-- A função "pagamentos" usa as RPCs pag_* com a chave de serviço; o painel só lê (minha_cobranca).
-- ===========================================================================
create table if not exists private.pag_config (
  id      int primary key default 1 check (id = 1),
  url     text,                     -- https://<projeto>.supabase.co/functions/v1/pagamentos
  segredo text not null default encode(extensions.gen_random_bytes(24), 'hex')
);
insert into private.pag_config (id) values (1) on conflict (id) do nothing;

create table if not exists private.assinaturas (
  restaurante_id uuid primary key references public.restaurantes (id) on delete cascade,
  cliente_id     text not null,                       -- cus_... no Asaas
  assinatura_id  text unique,                         -- sub_... no Asaas
  forma          text not null check (forma in ('cartao', 'pix')),
  valor          numeric(10, 2) not null,
  status         text not null default 'ativa' check (status in ('ativa', 'cancelada')),
  nome           text not null check (char_length(nome) <= 120),
  documento      text not null check (documento ~ '^[0-9]{11}([0-9]{3})?$'),
  email          text not null check (char_length(email) <= 120),
  cartao         text check (char_length(cartao) <= 40),   -- ex.: "VISA final 1234"
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now()
);

create table if not exists private.faturas (
  id             text primary key,                    -- pay_... no Asaas
  restaurante_id uuid not null references public.restaurantes (id) on delete cascade,
  descricao      text,
  valor          numeric(10, 2) not null,
  vencimento     date not null,
  status         text not null,                       -- PENDING, RECEIVED, CONFIRMED, OVERDUE, REFUNDED...
  forma          text,                                -- CREDIT_CARD, PIX, BOLETO, UNDEFINED
  url            text,                                -- página de pagamento (invoiceUrl)
  pago_em        date,
  atualizado_em  timestamptz not null default now()
);
create index if not exists faturas_rest_idx on private.faturas (restaurante_id, vencimento desc);

create table if not exists private.pag_eventos (
  id          text primary key,
  evento      text not null,
  recebido_em timestamptz not null default now()
);

-- Painel: cobrança do próprio restaurante (qualquer pessoa da equipe vê; só o administrador muda).
create or replace function public.minha_cobranca() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r uuid := public.meu_restaurante(); a private.assinaturas;
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  select * into a from private.assinaturas where restaurante_id = r;
  return jsonb_build_object(
    'assinatura', case when a.restaurante_id is null then null else jsonb_build_object('forma', a.forma, 'valor', a.valor,
      'status', a.status, 'cartao', a.cartao, 'nome', a.nome, 'email', a.email,
      'documento', case when char_length(a.documento) = 11 then '•••.' || substr(a.documento, 4, 3) || '.•••-' || right(a.documento, 2)
                        else left(a.documento, 2) || '.•••.•••/' || substr(a.documento, 9, 4) || '-' || right(a.documento, 2) end) end,
    'faturas', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'descricao', f.descricao, 'valor', f.valor, 'vencimento', f.vencimento,
        'status', f.status, 'forma', f.forma, 'url', f.url, 'pago_em', f.pago_em) order by f.vencimento desc)
      from (select * from private.faturas where restaurante_id = r order by vencimento desc limit 12) f), '[]'::jsonb));
end $$;

-- Central: situação da cobrança de todos os restaurantes.
create or replace function public.central_cobrancas() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.eh_operador() then raise exception 'Acesso negado.'; end if;
  return coalesce((select jsonb_object_agg(a.restaurante_id, jsonb_build_object('forma', a.forma, 'valor', a.valor, 'status', a.status,
      'atrasadas', (select count(*) from private.faturas f where f.restaurante_id = a.restaurante_id and f.status = 'OVERDUE'),
      'proxima', (select min(f.vencimento) from private.faturas f where f.restaurante_id = a.restaurante_id and f.status in ('PENDING', 'OVERDUE')),
      'ultimo_pago', (select max(f.pago_em) from private.faturas f where f.restaurante_id = a.restaurante_id)))
    from private.assinaturas a), '{}'::jsonb);
end $$;

/* ---------- Só a função "pagamentos" (service role) ---------- */
-- Dados para criar ou ajustar a assinatura: plano, mensalidade e o que já existe.
create or replace function public.pag_dados(p_restaurante uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a private.assinaturas; r public.restaurantes;
begin
  select * into r from public.restaurantes where id = p_restaurante;
  if r.id is null then return null; end if;
  select * into a from private.assinaturas where restaurante_id = p_restaurante;
  return jsonb_build_object('nome', r.nome, 'slug', r.slug, 'mensal', public.plano_preco(public.plano_de(p_restaurante)),
    'assinatura', case when a.restaurante_id is null then null else to_jsonb(a) end,
    'pendente', (select jsonb_build_object('id', f.id, 'url', f.url) from private.faturas f
                  where f.restaurante_id = p_restaurante and f.status in ('PENDING', 'OVERDUE') order by f.vencimento limit 1));
end $$;

create or replace function public.pag_assinatura_gravar(p_restaurante uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into private.assinaturas (restaurante_id, cliente_id, assinatura_id, forma, valor, status, nome, documento, email)
  values (p_restaurante, p ->> 'cliente_id', p ->> 'assinatura_id', p ->> 'forma', (p ->> 'valor')::numeric,
          coalesce(p ->> 'status', 'ativa'), p ->> 'nome', p ->> 'documento', p ->> 'email')
  on conflict (restaurante_id) do update set
    cliente_id    = coalesce(p ->> 'cliente_id', private.assinaturas.cliente_id),
    assinatura_id = case when p ? 'assinatura_id' then p ->> 'assinatura_id' else private.assinaturas.assinatura_id end,
    forma         = coalesce(p ->> 'forma', private.assinaturas.forma),
    valor         = coalesce((p ->> 'valor')::numeric, private.assinaturas.valor),
    status        = coalesce(p ->> 'status', private.assinaturas.status),
    nome          = coalesce(p ->> 'nome', private.assinaturas.nome),
    documento     = coalesce(p ->> 'documento', private.assinaturas.documento),
    email         = coalesce(p ->> 'email', private.assinaturas.email),
    cartao        = case when p ? 'cartao' then p ->> 'cartao' else private.assinaturas.cartao end,
    atualizado_em = now();
end $$;

-- true quando o evento é novo (o webhook processa); false quando já foi visto.
create or replace function public.pag_evento_novo(p_id text, p_evento text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  insert into private.pag_eventos (id, evento) values (p_id, left(p_evento, 60)) on conflict (id) do nothing;
  return found;
end $$;

-- Grava a fatura vinda do Asaas. O restaurante sai do externalReference ou da assinatura.
-- Avisa por e-mail: pago (Vortex) e vencida (restaurante e Vortex).
create or replace function public.pag_fatura_gravar(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_r uuid; antes text; r public.restaurantes;
  v_status text := left(p ->> 'status', 30);
begin
  select restaurante_id into v_r from private.assinaturas where assinatura_id = p ->> 'subscription';
  if v_r is null and coalesce(p ->> 'externalReference', '') ~ '^[0-9a-f-]{36}$' then
    select id into v_r from public.restaurantes where id = (p ->> 'externalReference')::uuid;
  end if;
  if v_r is null then return null; end if;
  select status into antes from private.faturas where id = p ->> 'id';
  insert into private.faturas (id, restaurante_id, descricao, valor, vencimento, status, forma, url, pago_em)
  values (p ->> 'id', v_r, left(p ->> 'description', 200), (p ->> 'value')::numeric, (p ->> 'dueDate')::date, v_status,
          left(p ->> 'billingType', 20), left(p ->> 'invoiceUrl', 300), coalesce(p ->> 'clientPaymentDate', p ->> 'paymentDate')::date)
  on conflict (id) do update set descricao = excluded.descricao, valor = excluded.valor, vencimento = excluded.vencimento,
    status = excluded.status, forma = excluded.forma, url = coalesce(excluded.url, private.faturas.url),
    pago_em = coalesce(excluded.pago_em, private.faturas.pago_em), atualizado_em = now();
  -- Cartão usado (só bandeira e final, que o Asaas manda no evento).
  if p -> 'creditCard' ->> 'creditCardNumber' is not null then
    update private.assinaturas set cartao = left(coalesce(p -> 'creditCard' ->> 'creditCardBrand', 'Cartão') || ' final ' || (p -> 'creditCard' ->> 'creditCardNumber'), 40),
           atualizado_em = now() where restaurante_id = v_r;
  end if;
  if antes is distinct from v_status then
    select * into r from public.restaurantes where id = v_r;
    if v_status in ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH') and coalesce(antes, '') not in ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH') then
      perform private.aviso_vortex('vtx_pago', 'Pagamento recebido: ' || r.nome,
        private.email_html('Pagamento recebido',
          '<p>' || private.esc_html(r.nome) || ' pagou <b>' || public.brl((p ->> 'value')::numeric) || '</b>'
          || ' (vencimento ' || to_char((p ->> 'dueDate')::date, 'DD/MM/YYYY') || ').</p>', 'Abrir a central', 'https://tap.vortexsystems.tech/master/'));
    elsif v_status = 'OVERDUE' then
      perform private.aviso('rest_fatura_vencida', coalesce(nullif(r.avisos ->> 'email', ''), (select email from private.assinaturas where restaurante_id = v_r)),
        'Mensalidade do VTX Tap em aberto',
        private.email_html('Mensalidade em aberto',
          '<p>A mensalidade de <b>' || public.brl((p ->> 'value')::numeric) || '</b> com vencimento em '
          || to_char((p ->> 'dueDate')::date, 'DD/MM/YYYY') || ' ainda não foi paga.</p>'
          || '<p>Você pode pagar no cartão, Pix ou boleto pelo link abaixo. Se já pagou, desconsidere este aviso.</p>',
          'Pagar agora', p ->> 'invoiceUrl'), v_r);
      perform private.aviso_vortex('vtx_vencida', 'Fatura vencida: ' || r.nome,
        private.email_html('Fatura vencida',
          '<p>' || private.esc_html(r.nome) || ': ' || public.brl((p ->> 'value')::numeric) || ', vencida em '
          || to_char((p ->> 'dueDate')::date, 'DD/MM/YYYY') || '.</p>', 'Abrir a central', 'https://tap.vortexsystems.tech/master/'));
    end if;
  end if;
  return v_r;
end $$;

-- Confere o segredo das chamadas do banco para a função (sincronizar o valor).
create or replace function public.pag_segredo_ok(p_segredo text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_segredo is not distinct from (select segredo from private.pag_config where id = 1);
$$;

-- Mudou o plano de um restaurante com assinatura: a função ajusta o valor e lança a taxa única.
create or replace function private.plano_mudou_cobranca() returns trigger
language plpgsql security definer set search_path = public as $$
declare c private.pag_config;
begin
  if not exists (select 1 from private.assinaturas where restaurante_id = new.restaurante_id and status = 'ativa') then return new; end if;
  select * into c from private.pag_config where id = 1;
  if c.url is not null then
    perform net.http_post(url := c.url,
      body := jsonb_build_object('acao', 'sincronizar', 'restaurante', new.restaurante_id, 'mudanca', new.id, 'taxa', coalesce(new.taxa_unica, 0)),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-segredo', c.segredo), timeout_milliseconds := 8000);
  end if;
  return new;
end $$;
drop trigger if exists plano_mudou_cobranca on public.plano_mudancas;
create trigger plano_mudou_cobranca after insert on public.plano_mudancas
  for each row execute function private.plano_mudou_cobranca();

do $$
declare f text;
begin
  foreach f in array array['public.pag_dados(uuid)', 'public.pag_assinatura_gravar(uuid, jsonb)', 'public.pag_evento_novo(text, text)',
    'public.pag_fatura_gravar(jsonb)', 'public.pag_segredo_ok(text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array['public.minha_cobranca()', 'public.central_cobrancas()'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  execute 'revoke execute on function private.plano_mudou_cobranca() from public, anon, authenticated';
end $$;
