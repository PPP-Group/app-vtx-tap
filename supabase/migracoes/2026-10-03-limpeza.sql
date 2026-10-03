-- 03/10 (2 de 3): limpeza do que não é mais usado e faxina diária.

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

