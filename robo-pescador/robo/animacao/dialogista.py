"""Robô roteirista de diálogo: escreve o causo como conversa entre o Vô e o Lucas.

Mesma ordem do roteirista dos curtos narrados:
1. fila de roteiros prontos (roteiros_animados/ no projeto ou no Drive), o mais antigo primeiro;
2. se a fila estiver vazia, o Gemini escreve um novo, sem repetir temas do histórico.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from ..config import RAIZ, Config
from ..llm import LLM, ErroLLM
from .desenho import EXPRESSOES

PASTA_FILA = RAIZ / "roteiros_animados"
PALAVRAS_POR_SEGUNDO = 2.3            # fala calma de causo


def _prompt(cfg: Config, personagens: list[str], historico: list[str]) -> str:
    s = cfg.serie
    alvo = int(s.get("animacao", {}).get("duracao_alvo_segundos", 75))
    palavras = int(alvo * PALAVRAS_POR_SEGUNDO)
    return f"""Você é o roteirista da série "{s['nome']}" ({s['bio']}).
Público: {s['publico']}
Cenário: {s['cenario']}
Personagens: {json.dumps({k: v for k, v in s['personagens'].items() if k in personagens}, ensure_ascii=False)}
Regras da série: {json.dumps(s['regras'], ensure_ascii=False)}

Escreva UM causo novo como DIÁLOGO entre {' e '.join(personagens)}, em português do Brasil falado no
Norte, para um desenho animado vertical de cerca de {alvo} segundos (umas {palavras} palavras no total).
- De 8 a 14 falas, alternando quem fala. Cada fala com no máximo 30 palavras, frases curtas e faladas.
- A primeira fala é o gancho: prende a atenção nos 3 primeiros segundos (pergunta, espanto ou mistério).
- A última fala do Vô traz a lição, dita de forma simples, com humor seco, sem sermão.
- "expressao" é a cara de quem fala e "reacao" a de quem escuta: {", ".join(EXPRESSOES)}.
- Nada de narrador: tudo é dito pelos personagens.
- Não repita estes temas já usados: {json.dumps(historico[-30:], ensure_ascii=False)}

Responda APENAS com JSON neste formato:
{{"titulo": "...", "frase_capa": "3 a 6 palavras para a capa", "gancho": "...",
  "falas": [{{"quem": "lucas", "texto": "...", "expressao": "surpreso", "reacao": "feliz"}}],
  "moral": "...", "cta": "pergunta curta para gerar comentários"}}"""


def validar(roteiro: dict, personagens: set[str]) -> dict:
    falas = roteiro.get("falas") or []
    if len(falas) < 4:
        raise ErroLLM("Roteiro em diálogo veio com menos de 4 falas.")
    for i, f in enumerate(falas, start=1):
        if f.get("quem") not in personagens:
            raise ErroLLM(f"Fala {i}: personagem '{f.get('quem')}' sem arte ({', '.join(sorted(personagens))}).")
        texto = " ".join(str(f.get("texto", "")).split())
        if not texto:
            raise ErroLLM(f"Fala {i} sem texto.")
        palavras = texto.split()
        f["texto"] = " ".join(palavras[:40])                      # fala longa demais cansa
        for campo in ("expressao", "reacao"):
            if f.get(campo) not in EXPRESSOES:
                f[campo] = "neutro"
    roteiro.setdefault("titulo", "Causo animado")
    roteiro["titulo"] = roteiro["titulo"][:100]
    return roteiro


def escrever(cfg: Config, llm: LLM, personagens: list[str], historico: list[str]) -> dict:
    return validar(llm.gerar_json(_prompt(cfg, personagens, historico)), set(personagens))


def _pastas_fila(cfg: Config) -> list[Path]:
    pastas = [PASTA_FILA]
    if cfg.pasta_drive:
        pastas.append(cfg.pasta_drive / "roteiros_animados")
    return [p for p in pastas if p.exists()]


def pegar_da_fila(cfg: Config, personagens: set[str]) -> tuple[dict, Path] | None:
    """Pega o roteiro mais antigo da fila e move para usados/ (com problema: com_erro/).
    Arquivos que começam com "prova" ficam na fila (são exemplos)."""
    for pasta in _pastas_fila(cfg):
        for arquivo in sorted(pasta.glob("*.json")):
            if arquivo.name.startswith("prova"):
                continue
            try:
                roteiro = validar(json.loads(arquivo.read_text(encoding="utf-8")), personagens)
                destino = pasta / "usados"
            except (json.JSONDecodeError, ErroLLM, KeyError, TypeError) as e:
                print(f"   roteiro {arquivo.name} com problema ({e}); separado em com_erro/")
                destino, roteiro = pasta / "com_erro", None
            destino.mkdir(exist_ok=True)
            shutil.move(str(arquivo), str(destino / arquivo.name))
            if roteiro:
                return roteiro, arquivo
    return None
