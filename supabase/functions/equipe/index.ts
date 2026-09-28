// Cadastro e login da equipe por PIN.
// Criar conta exige a senha da equipe; entrar exige só o PIN.
// A sessão devolvida é uma sessão normal do Supabase Auth, então as regras
// de acesso do banco (public.eh_equipe()) valem para tudo o que vem depois.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const erro = (msg: string, status = 400) => json({ erro: msg }, status);

const admin = () => createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const PIN_OK = /^\d{4,8}$/;

async function rpc<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

async function podeTentar(sb: SupabaseClient, chave: string, max: number, minutos: number) {
  return rpc<boolean>(sb, 'equipe_pode_tentar', { p_chave: chave, p_max: max, p_minutos: minutos });
}

// Cria uma sessão para o usuário sem senha: link mágico gerado no servidor e confirmado na hora.
async function abrirSessao(sb: SupabaseClient, email: string) {
  const { data, error } = await sb.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw error;
  const temp = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: v, error: e2 } = await temp.auth.verifyOtp({ token_hash: data.properties.hashed_token, type: 'email' });
  if (e2 || !v.session) throw e2 || new Error('Sessão não criada');
  return { access_token: v.session.access_token, refresh_token: v.session.refresh_token };
}

// Confere se quem chamou está logado e faz parte da equipe.
async function membroDaChamada(sb: SupabaseClient, req: Request) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data } = await sb.auth.getUser(token);
  if (!data.user) return null;
  const { data: m } = await sb.from('equipe_membros').select('id, nome, user_id').eq('user_id', data.user.id).maybeSingle();
  return m;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return erro('Método não permitido.', 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return erro('Pedido inválido.');
  }
  const acao = String(body.acao || '');
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'sem-ip';
  const sb = admin();

  try {
    if (acao === 'estado') {
      return json({ temSenha: await rpc<boolean>(sb, 'equipe_tem_senha') });
    }

    if (acao === 'entrar') {
      const pin = String(body.pin || '');
      if (!PIN_OK.test(pin)) return erro('O PIN tem de 4 a 8 números.');
      const livre = (await podeTentar(sb, `entrar:${ip}`, 10, 15)) && (await podeTentar(sb, 'entrar:*', 120, 15));
      if (!livre) return erro('Muitas tentativas. Aguarde 15 minutos e tente de novo.', 429);
      const hmac = await rpc<string>(sb, 'equipe_pin_hmac', { p_pin: pin });
      const { data: m } = await sb.from('equipe_membros').select('nome, user_id').eq('pin_hmac', hmac).maybeSingle();
      if (!m) return erro('PIN não encontrado. Confira ou crie sua conta.', 401);
      const { data: u, error } = await sb.auth.admin.getUserById(m.user_id);
      if (error || !u.user?.email) throw error || new Error('Usuário sem e-mail');
      await rpc(sb, 'equipe_limpar_tentativas', { p_chave: `entrar:${ip}` });
      return json({ nome: m.nome, sessao: await abrirSessao(sb, u.user.email) });
    }

    if (acao === 'cadastrar') {
      const nome = String(body.nome || '').trim().slice(0, 60);
      const pin = String(body.pin || '');
      const senha = String(body.senhaEquipe || '');
      if (!nome) return erro('Informe seu nome.');
      if (!PIN_OK.test(pin)) return erro('O PIN precisa ter de 4 a 8 números.');
      if (senha.length < 6) return erro('A senha da equipe tem pelo menos 6 caracteres.');
      if (!(await podeTentar(sb, `cadastrar:${ip}`, 6, 15))) return erro('Muitas tentativas. Aguarde 15 minutos e tente de novo.', 429);

      const hmac = await rpc<string>(sb, 'equipe_pin_hmac', { p_pin: pin });
      const { data: existe } = await sb.from('equipe_membros').select('id').eq('pin_hmac', hmac).maybeSingle();
      if (existe) return erro('Esse PIN já está em uso. Escolha outro.', 409);

      const conf = await rpc<string>(sb, 'equipe_conferir_senha', { p_senha: senha });
      if (conf === 'errada') return erro('Senha da equipe incorreta. Peça a senha para a gerência.', 403);

      const email = `m-${crypto.randomUUID()}@equipe.vtxtap.app`;
      const { data: novo, error } = await sb.auth.admin.createUser({ email, email_confirm: true, user_metadata: { nome } });
      if (error || !novo.user) throw error || new Error('Conta não criada');
      const { error: e2 } = await sb.from('equipe_membros').insert({ user_id: novo.user.id, nome, pin_hmac: hmac });
      if (e2) {
        await sb.auth.admin.deleteUser(novo.user.id);
        if (e2.code === '23505') return erro('Esse PIN já está em uso. Escolha outro.', 409);
        throw e2;
      }
      return json({ nome, primeiraConta: conf === 'definida', sessao: await abrirSessao(sb, email) });
    }

    // A partir daqui, só quem já é da equipe.
    const eu = await membroDaChamada(sb, req);
    if (!eu) return erro('Entre com seu PIN para continuar.', 401);

    if (acao === 'membros') {
      const { data, error } = await sb.from('equipe_membros').select('id, nome, criado_em, user_id').order('criado_em');
      if (error) throw error;
      return json({ membros: data.map((m) => ({ id: m.id, nome: m.nome, criado_em: m.criado_em, voce: m.user_id === eu.user_id })) });
    }

    if (acao === 'remover') {
      const { data: m } = await sb.from('equipe_membros').select('user_id').eq('id', String(body.id || '')).maybeSingle();
      if (!m) return erro('Pessoa não encontrada.', 404);
      const { error } = await sb.auth.admin.deleteUser(m.user_id);
      if (error) throw error;
      return json({ ok: true });
    }

    if (acao === 'trocar_senha') {
      const senha = String(body.senha || '');
      if (senha.length < 6) return erro('A senha da equipe precisa ter pelo menos 6 caracteres.');
      await rpc(sb, 'equipe_trocar_senha', { p_senha: senha });
      return json({ ok: true });
    }

    return erro('Ação desconhecida.');
  } catch (e) {
    console.error(acao, e);
    return erro('Não foi possível concluir agora. Tente de novo.', 500);
  }
});
