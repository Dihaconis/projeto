"""Robô social media: título, descrição e hashtags para cada rede."""
from __future__ import annotations

import json

from ..config import Config
from ..llm import LLM


def _prompt(cfg: Config, roteiro: dict) -> str:
    s = cfg.serie
    return f"""Você cuida das redes da série "{s['nome']}" ({s['bio']}).
Roteiro do vídeo curto de hoje:
{json.dumps(roteiro, ensure_ascii=False)}

Escreva os textos de postagem em português do Brasil. Responda APENAS com JSON:
{{"titulo": "até 70 caracteres, curiosidade sem mentir, sem caixa alta inteira",
  "texto_capa": "3 a 6 palavras para escrever na thumbnail",
  "descricao": "2 a 3 frases curtas que terminam com a pergunta do CTA",
  "hashtags": ["5 a 8 hashtags em minúsculas, sem acento"]}}"""


def escrever(cfg: Config, llm: LLM, roteiro: dict) -> dict:
    if cfg.modo_teste:
        textos = {
            "titulo": f"{roteiro['titulo_episodio']} | As Histórias de um Pescador",
            "texto_capa": roteiro["titulo_episodio"],
            "descricao": f"{roteiro.get('moral', '')} {roteiro.get('cta', '')}".strip(),
            "hashtags": ["#pescaria", "#rioaraguaia", "#humornortista"],
        }
    else:
        textos = llm.gerar_json(_prompt(cfg, roteiro))
    return ajustar(cfg, textos, roteiro)


def ajustar(cfg: Config, textos: dict, roteiro: dict) -> dict:
    """Põe as hashtags fixas da série na frente, sem repetir, e limita o título."""
    fixas = cfg.serie["formato"]["hashtags_fixas"]
    tags = [t if t.startswith("#") else f"#{t}" for t in textos.get("hashtags", [])]
    textos["hashtags"] = list(dict.fromkeys(fixas + tags))[:12]   # sem repetir
    textos["titulo"] = textos.get("titulo", roteiro["titulo_episodio"])[:100]
    return textos


def por_rede(textos: dict) -> dict[str, str]:
    """Texto pronto para colar em cada rede, respeitando o jeito de cada uma.

    - YouTube Shorts: título de até 100 caracteres + descrição com #shorts.
    - Instagram Reels: legenda completa + todas as hashtags (limite de 30).
    - TikTok: legenda curta + até 5 hashtags (as primeiras são as fixas da série).
    - Kwai: título + 3 hashtags.
    """
    tags = textos.get("hashtags", [])
    titulo = textos.get("titulo", "").strip()
    descricao = textos.get("descricao", "").strip()
    return {
        "YOUTUBE SHORTS": (f"Título: {titulo[:100]}\n"
                           f"Descrição: {descricao}\n\n#shorts {' '.join(tags[:3])}"),
        "INSTAGRAM REELS": f"{descricao}\n\n{' '.join(tags[:30])}",
        "TIKTOK": f"{titulo} {' '.join(tags[:5])}"[:2200],
        "KWAI": f"{titulo} {' '.join(tags[:3])}",
    }
