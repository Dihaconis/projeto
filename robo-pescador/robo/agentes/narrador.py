"""Robô narrador: gera a voz de cada cena com edge-tts (gratuito, sem chave).

Uma faixa por cena permite saber exatamente quanto tempo cada imagem fica
na tela e sincronizar a legenda sem adivinhação.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from ..config import Config
from .. import midia

PALAVRAS_POR_SEGUNDO_TESTE = 2.6


async def _falar(texto: str, voz: str, velocidade: str, destino: Path) -> None:
    import edge_tts
    await edge_tts.Communicate(texto, voz, rate=velocidade).save(str(destino))


def _audio_teste(texto: str, destino: Path) -> None:
    segundos = max(2.0, len(texto.split()) / PALAVRAS_POR_SEGUNDO_TESTE)
    midia.rodar(["-f", "lavfi", "-i", f"sine=frequency=220:duration={segundos:.2f}",
                 "-af", "volume=0.05", "-c:a", "libmp3lame", "-q:a", "6", str(destino)])


def narrar(cfg: Config, roteiro: dict, pasta: Path, tentativas: int = 3) -> list[tuple[Path, float]]:
    """Devolve [(arquivo_mp3, duração_em_segundos), ...] na ordem das cenas."""
    pasta.mkdir(parents=True, exist_ok=True)
    faixas = []
    for i, cena in enumerate(roteiro["cenas"]):
        destino = pasta / f"fala_{i + 1:02d}.mp3"
        if destino.exists() and destino.stat().st_size > 2000:
            pass                                  # retomando: essa fala já foi gravada
        elif cfg.modo_teste:
            _audio_teste(cena["narracao"], destino)
        else:
            for n in range(tentativas):
                try:
                    asyncio.run(_falar(cena["narracao"], cfg.voz, cfg.velocidade_voz, destino))
                    break
                except Exception:  # noqa: BLE001 — falha de rede do serviço de voz
                    if n == tentativas - 1:
                        raise
        faixas.append((destino, midia.duracao(destino)))
    return faixas
