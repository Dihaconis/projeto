"""Robô roteirista: escreve o causo do episódio em cenas curtas.

Primeiro usa os roteiros prontos da fila (escritos pelo Claude e salvos em
roteiros/ no projeto ou na pasta do Drive). Se a fila estiver vazia, pede ao Gemini.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from ..config import RAIZ, Config
from ..llm import LLM, ErroLLM

ROTEIRO_TESTE = {
    "titulo_episodio": "O peixe que sabia contar",
    "gancho": "Lucas jurou que o tucunaré piscou pra ele.",
    "cenas": [
        {"narracao": "Lucas jurou que o tucunaré piscou pra ele antes de soltar a isca.",
         "descricao_visual": "Lucas na canoa olhando espantado para a água, Vô cochilando no fundo"},
        {"narracao": "O Vô nem abriu o olho. Disse que peixe esperto pisca mesmo, pra ver se o pescador é besta.",
         "descricao_visual": "Vô de chapéu de couro deitado na canoa, um olho só aberto, sorriso de canto"},
        {"narracao": "Lucas jogou a linha de novo. Nada. Jogou mais longe. Nada de novo.",
         "descricao_visual": "Lucas arremessando a linha com força, rio largo e praia de areia ao fundo"},
        {"narracao": "Aí o Vô contou do tempo do garimpo, quando um homem cavou a vida inteira no lugar errado por teimosia.",
         "descricao_visual": "lembrança em tons de sépia: garimpeiros com bateias na beira de um barranco"},
        {"narracao": "No meio da história, a linha esticou. Lucas puxou e veio um tucunaré do tamanho do braço.",
         "descricao_visual": "Lucas puxando um tucunaré grande, água espirrando, Vô rindo"},
        {"narracao": "O Vô só falou: quem muda o lugar da isca não é fraco, é pescador. E voltou a cochilar.",
         "descricao_visual": "pôr do sol amarelo sobre o Araguaia, canoa pequena, na pedreira ao longe uma sombra enorme de cobra quase invisível"},
    ],
    "moral": "Teimosia não é persistência.",
    "cta": "Comenta aí o maior peixe que tu já viu.",
}


def _prompt(cfg: Config, historico: list[str]) -> str:
    s = cfg.serie
    f = s["formato"]
    return f"""Você é o roteirista da série de vídeos curtos "{s['nome']}".
Público: {s['publico']}
Cenário: {s['cenario']}
Personagens: {json.dumps(s['personagens'], ensure_ascii=False)}
Regras da série: {json.dumps(s['regras'], ensure_ascii=False)}

Escreva UM causo novo, em português do Brasil falado no Norte, para um vídeo vertical de
cerca de {f['duracao_alvo_segundos']} segundos, narrado em terceira pessoa.
- Exatamente {f['cenas']} cenas. Cada narração com no máximo {f['palavras_por_cena_max']} palavras.
- A primeira cena é o gancho: prende a atenção nos 3 primeiros segundos.
- A última cena traz a lição do Vô.
- "descricao_visual" descreve só o que aparece na imagem (sem texto escrito na imagem).
- "imagem_en" é a mesma cena descrita EM INGLÊS para um gerador de imagens: uma frase só,
  concreta (quem aparece, o que faz, enquadramento, hora do dia). Chame o menino de "Lucas, the boy"
  e o avô de "Grandpa". Não descreva roupas nem estilo (isso é acrescentado depois).
  O cenário é sempre rio de água doce, nunca mar ou praia de ondas.
- "movimento_en" é, EM INGLÊS, o movimento para animar essa imagem no Google Flow:
  uma frase curta e simples (quem se mexe, como, e o movimento da câmera). Movimentos
  pequenos e naturais funcionam melhor. Termine com "keep the woodcut print style".
- O cenário é SEMPRE o rio Araguaia, de água doce. É PROIBIDO mostrar: mar, oceano, onda,
  gaivota (a ave), coqueiro, porto, navio. A Praia da Gaivota e a Ilha do Mauro são praias DE RIO:
  em "imagem_en" escreva "river sand beach" ou "sandbar on the Araguaia river", nunca só "beach".
- Lucas e o Vô têm sempre a mesma aparência (a descrição é acrescentada depois): não mude idade,
  cabelo, bigode nem o chapéu de couro do Vô. Não existe avó; a Bisavó só aparece em lembranças.
- Não repita estes temas já usados: {json.dumps(historico[-30:], ensure_ascii=False)}

Responda APENAS com JSON neste formato:
{{"titulo_episodio": "...", "gancho": "...",
  "cenas": [{{"narracao": "...", "descricao_visual": "...", "imagem_en": "...", "movimento_en": "..."}}],
  "moral": "...", "cta": "pergunta curta para gerar comentários"}}"""


def validar_roteiro(roteiro: dict, cfg: Config) -> dict:
    f = cfg.serie["formato"]
    cenas = roteiro.get("cenas") or []
    if len(cenas) < 3:
        raise ErroLLM("Roteiro veio com menos de 3 cenas.")
    for c in cenas:
        if not c.get("narracao") or not c.get("descricao_visual"):
            raise ErroLLM("Cena sem narração ou sem descrição visual.")
        palavras = c["narracao"].split()
        if len(palavras) > f["palavras_por_cena_max"] + 8:   # pequena folga
            c["narracao"] = " ".join(palavras[: f["palavras_por_cena_max"] + 8])
    roteiro.setdefault("titulo_episodio", "Causo sem nome")
    return roteiro


def escrever(cfg: Config, llm: LLM, historico: list[str]) -> dict:
    if cfg.modo_teste:
        return validar_roteiro(json.loads(json.dumps(ROTEIRO_TESTE)), cfg)
    return validar_roteiro(llm.gerar_json(_prompt(cfg, historico)), cfg)


def _pastas_fila(cfg: Config) -> list[Path]:
    pastas = [RAIZ / "roteiros"]
    if cfg.pasta_drive:
        pastas.append(cfg.pasta_drive / "roteiros")
    return [p for p in pastas if p.exists()]


def pegar_da_fila(cfg: Config) -> tuple[dict, Path] | None:
    """Pega o roteiro pronto mais antigo da fila e move o arquivo para roteiros/usados.

    Arquivos com problema vão para roteiros/com_erro, para não travar a fila.
    """
    if cfg.modo_teste:
        return None
    for pasta in _pastas_fila(cfg):
        for arquivo in sorted(pasta.glob("*.json")):
            try:
                roteiro = validar_roteiro(json.loads(arquivo.read_text(encoding="utf-8")), cfg)
                destino = pasta / "usados"
            except (json.JSONDecodeError, ErroLLM, KeyError, TypeError) as e:
                print(f"   roteiro {arquivo.name} com problema ({e}); separado em com_erro/")
                destino, roteiro = pasta / "com_erro", None
            destino.mkdir(exist_ok=True)
            shutil.move(str(arquivo), str(destino / arquivo.name))
            if roteiro:
                return roteiro, arquivo
    return None
