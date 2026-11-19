"""Robô de qualidade: confere o pacote antes de avisar você.

Não aprova nada sozinho: lista problemas para você decidir se posta.
"""
from __future__ import annotations

import re
from pathlib import Path

from ..config import Config
from .. import midia

PALAVRAS_PROIBIDAS = ["porra", "caralho", "merda", "viado", "macaco"]


def revisar(cfg: Config, roteiro: dict, textos: dict, video: Path, capa: Path) -> list[str]:
    problemas: list[str] = []

    if not video.exists() or video.stat().st_size < 50_000:
        return ["O vídeo final não foi gerado."]

    dur = midia.duracao(video)
    alvo = cfg.serie["formato"]["duracao_alvo_segundos"]
    if dur < 15:
        problemas.append(f"Vídeo curto demais ({dur:.0f} s).")
    if dur > 90:
        problemas.append(f"Vídeo com {dur:.0f} s: passa de 90 s; o Reels e o Kwai podem cortar.")
    elif dur > alvo * 1.5:
        problemas.append(f"Vídeo com {dur:.0f} s, bem acima do alvo de {alvo} s.")
    if not midia.tem_audio(video):
        problemas.append("O vídeo saiu sem áudio.")
    if not capa.exists():
        problemas.append("Thumbnail não foi gerada.")

    texto_todo = " ".join([c["narracao"] for c in roteiro["cenas"]]
                          + [textos.get("titulo", ""), textos.get("descricao", "")]).lower()
    palavras = set(re.findall(r"\w+", texto_todo))
    achadas = [p for p in PALAVRAS_PROIBIDAS if p in palavras]
    if achadas:
        problemas.append(f"Palavras a revisar: {', '.join(achadas)}.")
    if len(textos.get("titulo", "")) > 70:
        problemas.append("Título passa de 70 caracteres; pode cortar no celular.")

    problemas += roteiro.get("avisos", [])
    return problemas
