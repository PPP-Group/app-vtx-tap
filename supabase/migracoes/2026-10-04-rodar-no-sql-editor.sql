-- VTX Tap: parte das migrações de 03/10 que apaga algo (rodar no SQL Editor do Supabase)

create or replace function public.fid_redefinir_pin(p_cpf text) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid := public.meu_restaurante();
begin
  if r is null then raise exception 'Acesso negado.'; end if;
  if not exists (select 1 from public.fid_clientes where restaurante_id = r and cpf = p_cpf) then raise exception 'Cliente não encontrado.'; end if;
  insert into private.fid_pins (restaurante_id, cpf, pin_hash, redefinir_ate) values (r, p_cpf, '', now() + interval '24 hours')
  on conflict (restaurante_id, cpf) do update set pin_hash = '', redefinir_ate = excluded.redefinir_ate;
  delete from private.fid_sessoes where restaurante_id = r and cpf = p_cpf;
end $$;

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
  delete from private.fid_sessoes where restaurante_id = p_restaurante and cpf = v_cpf;
  perform public.equipe_limpar_tentativas('fid-pin:' || p_restaurante || ':' || v_cpf);
  perform public.equipe_limpar_tentativas('fid-pin-dia:' || p_restaurante || ':' || v_cpf);
  return jsonb_build_object('status', 'ok', 'token', public.fid_nova_sessao(p_restaurante, v_cpf));
end $$;

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
  delete from private.fid_sessoes where restaurante_id = v_r and cpf = v_cpf and token_hash <> public.hash_token(p_token);
  return jsonb_build_object('status', 'ok');
end $$;

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

drop policy if exists "cliente acompanha chamados recentes" on public.chamados;

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

create or replace function public.equipe_codigo_conferir(p_membro uuid, p_codigo text) returns text
language sql security definer set search_path = public as $$
  select private.codigo_conferir('equipe:' || p_membro, p_codigo);
$$;

-- Permissões de novo (agora que todas as funções existem).
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

revoke execute on function private.faxina() from public, anon, authenticated;

-- O site novo acompanha o chamado pela função chamado_status; a leitura direta sai.
revoke select on public.chamados from anon;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'faxina-diaria';
    perform cron.schedule('faxina-diaria', '41 6 * * *', 'select private.faxina()');
  end if;
end $$;
