# Vídeo campanha VTX Tap

O filme "A mesa chama" foi feito em código com [Remotion](https://www.remotion.dev/) (React → MP4).

- **Telas:** reais, capturadas da plataforma rodando em modo demonstração.
- **Trilha e efeitos:** compostos por síntese.
- **Roteiro:** ver [roteiro.md](roteiro.md).

## Pastas

| Pasta | O que tem |
|---|---|
| `previas/` | Vídeos renderizados para avaliação |
| `projeto/` | Código do vídeo, sem `node_modules` e sem as capturas, que são regeneradas |

## Como renderizar de novo

Dentro de `projeto/`:

```bash
npm install
```

1. Suba o servidor da plataforma, o `plataforma-nfc` do `.claude/launch.json`, na porta 5500.
2. Capture as telas:
   ```bash
   node scripts/capturar.mjs && node scripts/capturar-orcamento.mjs
   ```
   As capturas usam o modo demonstração. A página tem o relógio adiantado para sexta, 20:41, e os estados (mesa 12 chamando, garçom a caminho, comentário, pedidos de delivery) são encenados direto no banco local do navegador.
3. Gere o áudio:
   ```bash
   cd scripts/audio && python trilha.py && python efeitos.py && python mix.py
   ```
4. Renderize:
   ```bash
   npx remotion render Filme ../previas/filme-16x9.mp4 --codec=h264 --crf=18
   ```

## Locução

A prévia usa uma **voz guia** (voz do Windows) só para marcar o tempo.

Para a versão final, grave ou gere cada frase do roteiro e salve em `projeto/public/audio/voz/` com os nomes `v01.wav`, `v02.wav` e assim por diante, os mesmos de `src/roteiro.json`. Depois rode `python mix.py`: a mixagem passa a usar a locução final e abaixa a trilha sob a voz.

## Restaurante fictício

Quintal Bistrô é o restaurante de teste da plataforma. Logo e capa foram desenhadas só para o vídeo pelo script `scripts/marca-quintal.mjs`. Não representam nenhum estabelecimento real.

## Licenças

- **Remotion:** gratuito para pessoas físicas e para empresas com até 3 funcionários. Acima disso, exige licença da empresa: <https://www.remotion.dev/license>.
- **Fontes:**
  - Big Shoulders Display, Schibsted Grotesk e IBM Plex Mono: Google Fonts, licença OFL.
  - Sora: OFL, já no projeto.
- **Trilha e efeitos:** originais, gerados pelos scripts em `scripts/audio`.
