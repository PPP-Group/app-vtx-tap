// Cadastro e login da equipe por PIN, por restaurante.
// Todo pedido traz o restaurante (id). Com o código da equipe (a "senha da equipe", definida
// pela central e trocada pelo administrador), a pessoa cria a própria conta: a PRIMEIRA vira
// administradora, as outras entram como equipe. Só administrador adiciona, remove, dá acesso de
// administrador, troca o PIN dos outros e o código da equipe. Entrar exige só o PIN.
// A sessão devolvida é uma sessão normal do Supabase Auth, então as regras
// de acesso do banco (public.meu_restaurante()) valem para tudo o que vem depois.
//
// Esqueci o PIN: cada pessoa pode cadastrar um e-mail de recuperação (acao 'meu_email'). Com ele,
// 'esqueci' manda um código de 6 números e 'redefinir' troca o PIN e já entra, sem depender de ninguém.
// Sem e-mail: o administrador troca o PIN; o único administrador sem e-mail pede à Vortex, que troca
// pela central (ações 'central_*', só para operadores).
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
// Chave secreta nova (sb_secret_..., no secret VTX_SECRET_KEY) ou, até a troca, a service_role antiga.
const SERVICE = Deno.env.get('VTX_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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
const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const mascarar = (e: string) => e.replace(/^(.{2})[^@]*/, (_, a) => a + '•••');

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

// Confere se quem chamou está logado e faz parte da equipe deste restaurante.
async function membroDaChamada(sb: SupabaseClient, req: Request, restaurante: string) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data } = await sb.auth.getUser(token);
  if (!data.user) return null;
  const { data: m } = await sb.from('equipe_membros').select('id, nome, user_id, admin')
    .eq('user_id', data.user.id).eq('restaurante_id', restaurante).maybeSingle();
  return m;
}

async function criarMembro(sb: SupabaseClient, rest: string, nome: string, pin: string, admin: boolean) {
  const hmac = await rpc<string>(sb, 'equipe_pin_hmac', { p_restaurante: rest, p_pin: pin });
  const { data: existe } = await sb.from('equipe_membros').select('id').eq('restaurante_id', rest).eq('pin_hmac', hmac).maybeSingle();
  if (existe) return { erro: 'Esse PIN já está em uso. Escolha outro.' };
  const email = `m-${crypto.randomUUID()}@equipe.vtxtap.app`;
  const { data: novo, error } = await sb.auth.admin.createUser({ email, email_confirm: true, user_metadata: { nome } });
  if (error || !novo.user) throw error || new Error('Conta não criada');
  const { error: e2 } = await sb.from('equipe_membros').insert({ restaurante_id: rest, user_id: novo.user.id, nome, pin_hmac: hmac, admin });
  if (e2) {
    await sb.auth.admin.deleteUser(novo.user.id);
    if (e2.code === '23505') return { erro: 'Esse PIN já está em uso. Escolha outro.' };
    throw e2;
  }
  return { email, id: novo.user.id };
}

async function qtdAdmins(sb: SupabaseClient, rest: string) {
  const { count } = await sb.from('equipe_membros').select('id', { count: 'exact', head: true }).eq('restaurante_id', rest).eq('admin', true);
  return count || 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const rest = String(body.restaurante || '');
  if (!UUID.test(rest)) return erro('Restaurante não identificado.');

  try {
    const { data: r } = await sb.from('restaurantes').select('id, ativo').eq('id', rest).maybeSingle();
    if (!r || !r.ativo) return erro('Restaurante indisponível.', 404);

    if (acao === 'estado') {
      const conf = await rpc<string>(sb, 'equipe_conferir_senha', { p_restaurante: rest, p_senha: '' });
      const { count } = await sb.from('equipe_membros').select('id', { count: 'exact', head: true }).eq('restaurante_id', rest);
      return json({ temSenha: conf !== 'sem_senha', temEquipe: (count || 0) > 0 });
    }

    if (acao === 'entrar') {
      const pin = String(body.pin || '');
      if (!PIN_OK.test(pin)) return erro('O PIN tem de 4 a 8 números.');
      const livre = (await podeTentar(sb, `entrar:${ip}`, 10, 15)) && (await podeTentar(sb, `entrar:${rest}`, 60, 15));
      if (!livre) return erro('Muitas tentativas. Aguarde 15 minutos e tente de novo.', 429);
      // Aparelho confiável: de um aparelho novo, o PIN só vale junto com o código da equipe.
      const confiavel = await rpc<boolean>(sb, 'equipe_aparelho_ok', { p_restaurante: rest, p_token: String(body.aparelho || '') });
      if (!confiavel) {
        const senha = String(body.senhaEquipe || '');
        if (!senha) return json({ erro: 'Primeira vez neste aparelho: digite também o código da equipe.', aparelhoNovo: true }, 403);
        if ((await rpc<string>(sb, 'equipe_conferir_senha', { p_restaurante: rest, p_senha: senha })) !== 'ok') {
          return json({ erro: 'Código da equipe incorreto. Peça ao administrador.', aparelhoNovo: true }, 403);
        }
      }
      const hmac = await rpc<string>(sb, 'equipe_pin_hmac', { p_restaurante: rest, p_pin: pin });
      const { data: m } = await sb.from('equipe_membros').select('nome, user_id, admin').eq('restaurante_id', rest).eq('pin_hmac', hmac).maybeSingle();
      if (!m) return erro('PIN não encontrado. Confira o número ou peça ao administrador.', 401);
      const { data: u, error } = await sb.auth.admin.getUserById(m.user_id);
      if (error || !u.user?.email) throw error || new Error('Usuário sem e-mail');
      await rpc(sb, 'equipe_limpar_tentativas', { p_chave: `entrar:${ip}` });
      const aparelho = confiavel ? null : await rpc<string>(sb, 'equipe_aparelho_novo', { p_restaurante: rest });
      return json({ nome: m.nome, admin: !!m.admin, aparelho, sessao: await abrirSessao(sb, u.user.email) });
    }

    // Cadastro com o código da equipe (nome + código + PIN próprio). A primeira conta do restaurante vira
    // administradora; as outras entram como equipe e só viram administradoras se um administrador der o acesso.
    if (acao === 'cadastrar') {
      const nome = String(body.nome || '').trim().slice(0, 60);
      const pin = String(body.pin || '');
      const senha = String(body.senhaEquipe || '');
      if (!nome) return erro('Informe seu nome.');
      if (!PIN_OK.test(pin)) return erro('O PIN precisa ter de 4 a 8 números.');
      if (senha.length < 6) return erro('O código da equipe tem pelo menos 6 caracteres.');
      if (!(await podeTentar(sb, `cadastrar:${ip}`, 6, 15))) return erro('Muitas tentativas. Aguarde 15 minutos e tente de novo.', 429);

      const conf = await rpc<string>(sb, 'equipe_conferir_senha', { p_restaurante: rest, p_senha: senha });
      if (conf === 'sem_senha') return erro('O código da equipe ainda não foi definido. Fale com a Vortex.', 403);
      if (conf === 'errada') return erro('Código da equipe incorreto. Peça o código ao administrador do restaurante.', 403);

      const { count } = await sb.from('equipe_membros').select('id', { count: 'exact', head: true }).eq('restaurante_id', rest);
      const primeira = (count || 0) === 0;
      const r = await criarMembro(sb, rest, nome, pin, primeira);
      if (r.erro) return erro(r.erro, 409);
      return json({ nome, admin: primeira, primeiraConta: primeira, aparelho: await rpc<string>(sb, 'equipe_aparelho_novo', { p_restaurante: rest }),
        sessao: await abrirSessao(sb, r.email!) });
    }

    // Esqueci o PIN: código no e-mail de recuperação. A resposta é a mesma com ou sem e-mail cadastrado.
    if (acao === 'esqueci') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!EMAIL_OK.test(email) || email.length > 120) return erro('E-mail inválido.');
      if (!(await podeTentar(sb, `esqueci:${ip}`, 6, 60)) || !(await podeTentar(sb, `esqueci:${rest}:${email}`, 3, 60))) {
        return erro('Você já pediu alguns códigos. Confira o e-mail (e o spam) ou tente de novo em 1 hora.', 429);
      }
      const { data: m } = await sb.from('equipe_membros').select('id, nome').eq('restaurante_id', rest).eq('email', email).maybeSingle();
      if (m) {
        const codigo = await rpc<string>(sb, 'equipe_codigo', { p_membro: m.id });
        const { data: rn } = await sb.from('restaurantes').select('nome').eq('id', rest).maybeSingle();
        await rpc(sb, 'equipe_aviso', {
          p_para: email, p_assunto: `${codigo} é o seu código do painel ${rn?.nome || ''}`.trim(), p_titulo: 'Seu código para criar um PIN novo',
          p_corpo: `<p>Olá, ${m.nome.split(' ')[0].replace(/[<>&"]/g, '')}.</p><p>Use este código no painel da equipe para criar um PIN novo:</p>`
            + `<p style="font-family:'IBM Plex Mono',Consolas,'Courier New',monospace;font-size:34px;font-weight:600;letter-spacing:8px;margin:18px 0;color:#140B33">${codigo}</p>`
            + '<p>O código vale 15 minutos. Se não foi você que pediu, ignore este e-mail: o seu PIN continua o mesmo.</p>',
          p_restaurante: rest,
        });
      }
      return json({ ok: true, email: mascarar(email) });
    }

    if (acao === 'redefinir') {
      const email = String(body.email || '').trim().toLowerCase();
      const pin = String(body.pin || '');
      if (!PIN_OK.test(pin)) return erro('O PIN precisa ter de 4 a 8 números.');
      if (!(await podeTentar(sb, `redefinir:${ip}`, 20, 15))) return erro('Muitas tentativas. Aguarde 15 minutos.', 429);
      const { data: m } = await sb.from('equipe_membros').select('id, nome, user_id, admin').eq('restaurante_id', rest).eq('email', email).maybeSingle();
      const r = m ? await rpc<string>(sb, 'equipe_codigo_conferir', { p_membro: m.id, p_codigo: String(body.codigo || '') }) : 'vencido';
      if (r === 'errado') return erro('Código incorreto. Confira o e-mail.', 403);
      if (r !== 'ok' || !m) return erro('Este código venceu. Peça um novo.', 403);
      const hmac = await rpc<string>(sb, 'equipe_pin_hmac', { p_restaurante: rest, p_pin: pin });
      const { data: dono } = await sb.from('equipe_membros').select('id').eq('restaurante_id', rest).eq('pin_hmac', hmac).maybeSingle();
      if (dono && dono.id !== m.id) return erro('Esse PIN já está em uso. Escolha outro.', 409);
      const { error } = await sb.from('equipe_membros').update({ pin_hmac: hmac }).eq('id', m.id);
      if (error) throw error;
      const { data: u } = await sb.auth.admin.getUserById(m.user_id);
      // O código do e-mail prova quem é: este aparelho passa a ser confiável.
      return json({ nome: m.nome, admin: !!m.admin, aparelho: await rpc<string>(sb, 'equipe_aparelho_novo', { p_restaurante: rest }),
        sessao: await abrirSessao(sb, u.user!.email!) });
    }

    // Central da Vortex (só operadores): ver a equipe, trocar o PIN e dar acesso de administrador.
    if (acao.startsWith('central_')) {
      const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const { data: ud } = token ? await sb.auth.getUser(token) : { data: { user: null } };
      const { data: op } = ud.user ? await sb.from('operadores').select('user_id').eq('user_id', ud.user.id).maybeSingle() : { data: null };
      if (!op) return erro('Só a central da Vortex pode fazer isso.', 403);
      if (acao === 'central_membros') {
        const { data, error } = await sb.from('equipe_membros').select('id, nome, criado_em, admin, email').eq('restaurante_id', rest).order('criado_em');
        if (error) throw error;
        return json({ membros: data.map((m) => ({ id: m.id, nome: m.nome, criado_em: m.criado_em, admin: !!m.admin, email: m.email ? mascarar(m.email) : null })) });
      }
      const { data: m } = await sb.from('equipe_membros').select('id, admin').eq('id', String(body.id || '')).eq('restaurante_id', rest).maybeSingle();
      if (!m) return erro('Pessoa não encontrada.', 404);
      if (acao === 'central_trocar_pin') {
        const pin = String(body.pin || '');
        if (!PIN_OK.test(pin)) return erro('O PIN precisa ter de 4 a 8 números.');
        const hmac = await rpc<string>(sb, 'equipe_pin_hmac', { p_restaurante: rest, p_pin: pin });
        const { data: dono } = await sb.from('equipe_membros').select('id').eq('restaurante_id', rest).eq('pin_hmac', hmac).maybeSingle();
        if (dono && dono.id !== m.id) return erro('Esse PIN já está em uso. Escolha outro.', 409);
        const { error } = await sb.from('equipe_membros').update({ pin_hmac: hmac }).eq('id', m.id);
        if (error) throw error;
        return json({ ok: true });
      }
      if (acao === 'central_admin') {
        if (!body.admin && m.admin && (await qtdAdmins(sb, rest)) <= 1) return erro('O restaurante precisa de pelo menos um administrador.');
        const { error } = await sb.from('equipe_membros').update({ admin: !!body.admin }).eq('id', m.id);
        if (error) throw error;
        return json({ ok: true });
      }
      return erro('Ação desconhecida.');
    }

    // A partir daqui, só quem já é da equipe.
    const eu = await membroDaChamada(sb, req, rest);
    if (!eu) return erro('Entre com seu PIN para continuar.', 401);

    if (acao === 'membros') {
      const { data, error } = await sb.from('equipe_membros').select('id, nome, criado_em, user_id, admin, email').eq('restaurante_id', rest).order('criado_em');
      if (error) throw error;
      return json({
        euAdmin: !!eu.admin,
        membros: data.map((m) => ({ id: m.id, nome: m.nome, criado_em: m.criado_em, admin: !!m.admin, voce: m.user_id === eu.user_id,
          email: m.user_id === eu.user_id ? m.email || null : (m.email ? mascarar(m.email) : null) })),
      });
    }

    // O meu e-mail de recuperação do PIN (vazio apaga).
    if (acao === 'meu_email') {
      const email = String(body.email || '').trim().toLowerCase();
      if (email && (!EMAIL_OK.test(email) || email.length > 120)) return erro('E-mail inválido.');
      if (email) {
        const { data: outro } = await sb.from('equipe_membros').select('id').eq('restaurante_id', rest).eq('email', email).neq('id', eu.id).maybeSingle();
        if (outro) return erro('Esse e-mail já está na conta de outra pessoa da equipe.', 409);
      }
      const { error } = await sb.from('equipe_membros').update({ email: email || null }).eq('id', eu.id);
      if (error) throw error;
      return json({ ok: true });
    }

    // Trocar o próprio PIN: qualquer pessoa. O de outra pessoa: só administrador.
    if (acao === 'trocar_pin') {
      const pin = String(body.pin || '');
      if (!PIN_OK.test(pin)) return erro('O PIN precisa ter de 4 a 8 números.');
      const id = String(body.id || eu.id);
      if (id !== eu.id && !eu.admin) return erro('Só o administrador troca o PIN de outra pessoa.', 403);
      const hmac = await rpc<string>(sb, 'equipe_pin_hmac', { p_restaurante: rest, p_pin: pin });
      const { data: dono } = await sb.from('equipe_membros').select('id').eq('restaurante_id', rest).eq('pin_hmac', hmac).maybeSingle();
      if (dono && dono.id !== id) return erro('Esse PIN já está em uso. Escolha outro.', 409);
      const { error, count } = await sb.from('equipe_membros').update({ pin_hmac: hmac }, { count: 'exact' }).eq('id', id).eq('restaurante_id', rest);
      if (error) throw error;
      if (!count) return erro('Pessoa não encontrada.', 404);
      return json({ ok: true });
    }

    // Daqui para baixo, só administrador.
    if (!eu.admin) return erro('Só o administrador do restaurante pode fazer isso.', 403);

    if (acao === 'adicionar') {
      const nome = String(body.nome || '').trim().slice(0, 60);
      const pin = String(body.pin || '');
      if (!nome) return erro('Informe o nome da pessoa.');
      if (!PIN_OK.test(pin)) return erro('O PIN precisa ter de 4 a 8 números.');
      const r = await criarMembro(sb, rest, nome, pin, !!body.admin);
      if (r.erro) return erro(r.erro, 409);
      return json({ ok: true });
    }

    if (acao === 'remover') {
      const { data: m } = await sb.from('equipe_membros').select('id, user_id, admin').eq('id', String(body.id || '')).eq('restaurante_id', rest).maybeSingle();
      if (!m) return erro('Pessoa não encontrada.', 404);
      if (m.id === eu.id) return erro('Você não pode remover a si mesmo.');
      const { error } = await sb.auth.admin.deleteUser(m.user_id);
      if (error) throw error;
      return json({ ok: true });
    }

    if (acao === 'admin') {
      const quer = !!body.admin;
      const { data: m } = await sb.from('equipe_membros').select('id, admin').eq('id', String(body.id || '')).eq('restaurante_id', rest).maybeSingle();
      if (!m) return erro('Pessoa não encontrada.', 404);
      if (!quer && m.admin && (await qtdAdmins(sb, rest)) <= 1) return erro('O restaurante precisa de pelo menos um administrador.');
      const { error } = await sb.from('equipe_membros').update({ admin: quer }).eq('id', m.id);
      if (error) throw error;
      return json({ ok: true });
    }

    // Desconectar todos os aparelhos (ex.: celular perdido): cada um volta a pedir o código da equipe.
    if (acao === 'esquecer_aparelhos') {
      await rpc(sb, 'equipe_aparelhos_esquecer', { p_restaurante: rest });
      return json({ ok: true });
    }

    if (acao === 'trocar_senha') {
      const senha = String(body.senha || '');
      if (senha.length < 6) return erro('O código da equipe precisa ter pelo menos 6 caracteres.');
      await rpc(sb, 'equipe_trocar_senha', { p_restaurante: rest, p_senha: senha });
      return json({ ok: true });
    }

    return erro('Ação desconhecida.');
  } catch (e) {
    console.error(acao, e);
    return erro('Não foi possível concluir agora. Tente de novo.', 500);
  }
});
