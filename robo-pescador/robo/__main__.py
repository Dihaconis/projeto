"""Uso:
    python -m robo              # produz 1 episódio novo
    python -m robo --lote 4     # escreve 4 episódios de uma vez (bom com o Colab)
    python -m robo --continuar  # termina os episódios que pararam no meio
    python -m robo --teste      # roda sem internet, só para testar a montagem
    python -m robo --longo      # episódio longo (~15 min, YouTube) + cortes em pé
    python -m robo --status     # mostra filas, episódios parados e prontos
    python -m robo --vigiar 8   # fica 8 h esperando as imagens do Colab e termina os episódios sozinho
    python -m robo --animado            # desenho animado: roteiro da fila ou escrito pelo Gemini
    python -m robo --animado --lote 3   # 3 desenhos animados seguidos
    python -m robo --animado roteiros_animados/meu_causo.json
    python -m robo --amostras-voz lucas # amostras de voz no Telegram para você escolher
    python -m robo --longo-animado      # episódio longo animado (fila roteiros_longos_animados/) + cortes
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
                   help="desenho animado com boca sincronizada (sem arquivo: fila ou Gemini)")
    p.add_argument("--longo-animado", nargs="?", const="", default=None, metavar="ROTEIRO_OU_PASTA",
                   help="episódio longo animado 16:9 + cortes (sem nada: continua o parado ou pega da fila)")
    p.add_argument("--amostras-voz", metavar="PERSONAGEM", default=None,
                   help="manda no Telegram uma amostra de cada voz candidata (config/serie.yaml)")
    p.add_argument("--vigiar", type=float, default=0, metavar="HORAS",
                   help="fica esperando as imagens do Colab e termina cada episódio quando elas chegam")
    args = p.parse_args()

    cfg = Config.carregar(modo_teste=True if args.teste else None)

    if args.status:
        from .status import mostrar
        mostrar(cfg)
        return 0

    if args.longo_animado is not None:
        from pathlib import Path
        from .animacao.longo_animado import produzir_longo_animado
        try:
            pasta = produzir_longo_animado(cfg, Path(args.longo_animado) if args.longo_animado else None)
        except AguardandoImagens:
            print("Episódio esperando imagens. Coloque-as na pasta indicada e rode de novo: rodar.bat --longo-animado")
            return 0
        print(f"\nPronto. Pasta do episódio: {pasta}")
        return 0

    if args.amostras_voz:
        from datetime import datetime
        from .animacao import vozes
        from .notificador import avisar_audios
        am = cfg.serie.get("animacao", {}).get("amostras_voz", {})
        candidatas = am.get(args.amostras_voz)
        if not candidatas:
            print(f"Sem candidatas para '{args.amostras_voz}' em config/serie.yaml (animacao.amostras_voz).")
            return 1
        pasta = cfg.pasta_saida / f"VOZES-{args.amostras_voz}-{datetime.now():%Y%m%d-%H%M%S}"
        feitas, falhas = vozes.amostras(am["frase"], candidatas, pasta)
        texto = (f"🎙️ Amostras de voz para {args.amostras_voz}. Escute e me diga a letra da melhor; "
                 f"ela vai para config/serie.yaml (animacao.vozes.{args.amostras_voz}.edge).")
        if falhas:
            texto += "\nNão gravaram: " + "; ".join(falhas)
        avisar_audios(cfg, texto, feitas)
        return 0 if feitas else 1

    if args.animado is not None:
        from pathlib import Path
        from .animacao.episodio import produzir_animado
        for n in range(max(1, args.lote)):
            if args.lote > 1:
                print(f"\n===== Desenho {n + 1} de {args.lote} =====")
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
