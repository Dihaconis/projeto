"""Vigia: espera as imagens do Colab chegarem no Drive e termina cada episódio sozinho.

Só chama o --continuar de um episódio quando TODAS as imagens dele já chegaram,
para não mandar avisos repetidos de "esperando imagens" no Telegram.
"""
from __future__ import annotations

import json
import time
from datetime import datetime
from pathlib import Path

from .chefe import inacabados
from .config import Config


def imagens_completas(cfg: Config, pasta: Path) -> bool:
    roteiro = json.loads((pasta / "roteiro.json").read_text(encoding="utf-8"))
    n = len(roteiro.get("cenas") or [])
    if not n:
        return False
    vindas = cfg.pasta_drive / "imagens" / pasta.name if cfg.pasta_drive else None
    for i in range(1, n + 1):
        local = pasta / f"cena_{i:02d}.jpg"
        remoto = vindas / f"cena_{i:02d}_bruta.jpg" if vindas else None
        if not (local.exists() or (remoto and remoto.exists())):
            return False
    return True


def vigiar(cfg: Config, horas: float, rodar, intervalo: int = 60) -> int:
    """Roda até `horas` horas (ou até não sobrar episódio parado). Devolve quantos terminou."""
    fim = time.time() + horas * 3600
    feitos, falhas = 0, {}
    print(f"Vigiando por até {horas:g} h. Ctrl+C para parar.")
    while time.time() < fim:
        parados = inacabados(cfg)
        if not parados:
            print("Nenhum episódio esperando. Vigia encerrado.")
            break
        for pasta in parados:
            if falhas.get(pasta.name, 0) >= 2 or not imagens_completas(cfg, pasta):
                continue
            print(f"\n[{datetime.now():%H:%M}] Imagens de {pasta.name} chegaram. Montando...")
            try:
                if rodar(cfg, continuar=pasta):
                    feitos += 1
            except Exception as e:  # noqa: BLE001 — um episódio com erro não para o vigia
                falhas[pasta.name] = falhas.get(pasta.name, 0) + 1
                print(f"   erro em {pasta.name}: {type(e).__name__}: {str(e)[:300]}")
        time.sleep(intervalo)
    print(f"Vigia terminou: {feitos} episódio(s) montado(s).")
    return feitos
