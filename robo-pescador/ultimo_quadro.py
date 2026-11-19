"""Salva o último quadro de um clipe, para usar como primeiro quadro do próximo no Flow.

Assim a animação de uma cena "emenda" na outra sem pulo.

Uso:  python ultimo_quadro.py caminho\\do\\cena_01.mp4
Gera: cena_01_ultimo.jpg na mesma pasta.
"""
import sys
from pathlib import Path

from robo import midia

if len(sys.argv) != 2:
    raise SystemExit(__doc__)
video = Path(sys.argv[1])
if not video.exists():
    raise SystemExit(f"Não achei {video}")
destino = video.with_name(video.stem + "_ultimo.jpg")
midia.rodar(["-sseof", "-0.1", "-i", str(video), "-frames:v", "1", "-q:v", "2", str(destino)])
print(f"Pronto: {destino}")
