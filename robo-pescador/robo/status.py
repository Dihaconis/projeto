"""Painel simples: o que está na fila, o que está parado e o que já ficou pronto."""
from __future__ import annotations

import json
from pathlib import Path

from .chefe import _pronto
from .config import RAIZ, Config


def _fila(pastas: list[Path]) -> list[str]:
    return [a.name for p in pastas if p.exists() for a in sorted(p.glob("*.json"))]


def mostrar(cfg: Config) -> None:
    drive = cfg.pasta_drive
    curtos = _fila([RAIZ / "roteiros"] + ([drive / "roteiros"] if drive else []))
    longos = _fila([RAIZ / "roteiros_longos"] + ([drive / "roteiros_longos"] if drive else []))
    print(f"Roteiros curtos na fila: {len(curtos)}")
    for n in curtos:
        print("   -", n)
    print(f"Roteiros longos na fila: {len(longos)}")
    for n in longos:
        print("   -", n)
    if drive and (drive / "pedidos").exists():
        pend = sorted((drive / "pedidos").glob("*.json"))
        print(f"Pedidos de imagem esperando o Colab: {len(pend)}")
    eps = sorted(cfg.pasta_saida.glob("EP-*"), key=lambda p: p.stat().st_mtime) if cfg.pasta_saida.exists() else []
    prontos = [p for p in eps if _pronto(p)]
    parados = [p for p in eps if not _pronto(p) and (p / "roteiro.json").exists()]
    print(f"Episódios parados no meio: {len(parados)}")
    for p in parados:
        titulo = json.loads((p / "roteiro.json").read_text(encoding="utf-8")).get("titulo_episodio", "?")
        print(f"   - {p.name}: {titulo}")
    print(f"Episódios prontos: {len(prontos)} (últimos 5)")
    for p in prontos[-5:]:
        titulo = json.loads((p / "roteiro.json").read_text(encoding="utf-8")).get("titulo_episodio", "?")
        print(f"   - {p.name}: {titulo}")
