"""Uso:
    python -m robo              # produz 1 episódio novo
    python -m robo --lote 4     # escreve 4 episódios de uma vez (bom com o Colab)
    python -m robo --continuar  # termina os episódios que pararam no meio
    python -m robo --teste      # roda sem internet, só para testar a montagem
    python -m robo --longo      # episódio longo (~15 min, YouTube) + cortes em pé
    python -m robo --status     # mostra filas, episódios parados e prontos
    python -m robo --vigiar 8   # fica 8 h esperando as imagens do Colab e termina os episódios sozinho
    python -m robo --animado    # desenho animado com boca sincronizada (roteiro de prova)
    python -m robo --animado roteiros_animados/meu_causo.json
"""
import argparse
import sys

from .agentes.diretor_arte import AguardandoImagens
from .chefe import inacabados, produzir_episodio
from .config import Config


def _rodar(cfg: Config, continuar=None, longo: bool = False) -> bool:
    """Devolve True se o episódio ficou pronto, False se ficou esperando imagens."""
    try:
        if longo:
            from .agentes.longo import produzir_longo
            pasta = produzir_longo(cfg)
        else:
            pasta = produzir_episodio(cfg, continuar=continuar)
    except AguardandoImagens:
        return False
    print(f"\nPronto. Pasta do episódio: {pasta}")
    return True


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")       # acentos no terminal do Windows
    p = argparse.ArgumentParser(prog="robo", description="Robô de vídeos da série.")
    p.add_argument("--teste", action="store_true", help="sem internet: imagens e voz falsas")
    p.add_argument("--continuar", action="store_true",
                   help="termina os episódios que pararam no meio, sem gastar roteiro novo")
    p.add_argument("--lote", type=int, default=1, help="quantos episódios novos fazer")
    p.add_argument("--longo", action="store_true", help="episódio longo para o YouTube + cortes")
    p.add_argument("--status", action="store_true", help="mostra como estão as filas e episódios")
    p.add_argument("--animado", nargs="?", const="", default=None, metavar="ROTEIRO",
                   help="desenho animado com boca sincronizada (sem arquivo: roteiro de prova)")
    p.add_argument("--vigiar", type=float, default=0, metavar="HORAS",
                   help="fica esperando as imagens do Colab e termina cada episódio quando elas chegam")
    args = p.parse_args()

    cfg = Config.carregar(modo_teste=True if args.teste else None)

    if args.status:
        from .status import mostrar
        mostrar(cfg)
        return 0

    if args.animado is not None:
        from pathlib import Path
        from .animacao.episodio import produzir_animado
        pasta = produzir_animado(cfg, Path(args.animado) if args.animado else None)
        print(f"\nPronto. Pasta do desenho: {pasta}")
        return 0

    if args.vigiar:
        from .vigia import vigiar
        vigiar(cfg, args.vigiar, _rodar)
        return 0

    if args.longo:
        _rodar(cfg, longo=True)
        return 0

    if args.continuar:
        parados = inacabados(cfg)
        if not parados:
            print("Nenhum episódio parado no meio.")
            return 0
        prontos = sum(_rodar(cfg, continuar=pasta) for pasta in parados)
        print(f"\n{prontos} de {len(parados)} episódios terminados.")
        return 0

    esperando = 0
    for n in range(max(1, args.lote)):
        if args.lote > 1:
            print(f"\n===== Episódio {n + 1} de {args.lote} =====")
        if not _rodar(cfg):
            esperando += 1
    if esperando:
        print(f"\n{esperando} episódio(s) esperando as imagens do Colab. "
              "Rode o caderno no Colab e depois: rodar.bat --continuar")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
