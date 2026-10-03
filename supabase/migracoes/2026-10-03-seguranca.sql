-- 03/10 (3 de 3): segurança.

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
