"""Robô editor: monta o vídeo vertical com zoom lento, voz, legenda e música.

Tudo com FFmpeg, sem programa pago. Os arquivos intermediários ficam na
pasta do episódio, então dá para abrir no CapCut e ajustar à mão.
"""
from __future__ import annotations

import re
from pathlib import Path

from ..config import Config
from .. import midia

FPS = 30
ESTILO_LEGENDA = ("FontName=Arial,FontSize=13,Bold=1,PrimaryColour=&H0028B8E8,"
                  "OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=0,"
                  "Alignment=2,MarginV=70")
# formato -> (largura, altura, estilo da legenda, palavras por pedaço de legenda)
FORMATOS = {
    "vertical": (1080, 1920, ESTILO_LEGENDA, 5),
    "horizontal": (1920, 1080, ESTILO_LEGENDA.replace("FontSize=13", "FontSize=17")
                   .replace("MarginV=70", "MarginV=18"), 8),
}


def _tempo_srt(segundos: float) -> str:
    ms = int(round(segundos * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _pedacos(texto: str, max_palavras: int = 5) -> list[str]:
    """Quebra a fala em pedaços curtos, que cabem na tela do celular."""
    frases = re.split(r"(?<=[.!?…])\s+", texto.strip())
    pedacos: list[str] = []
    for frase in frases:
        palavras = frase.split()
        for i in range(0, len(palavras), max_palavras):
            pedacos.append(" ".join(palavras[i:i + max_palavras]))
    return [p for p in pedacos if p]


def gerar_legenda(cenas: list[dict], duracoes: list[float], max_palavras: int = 5) -> str:
    """Distribui o tempo de cada cena entre os pedaços, pelo número de letras."""
    blocos, inicio, n = [], 0.0, 1
    for cena, dur in zip(cenas, duracoes):
        pedacos = _pedacos(cena["narracao"], max_palavras)
        total = sum(len(p) for p in pedacos) or 1
        t = inicio
        for p in pedacos:
            fim = t + dur * len(p) / total
            blocos.append(f"{n}\n{_tempo_srt(t)} --> {_tempo_srt(fim)}\n{p.upper()}\n")
            n, t = n + 1, fim
        inicio += dur
    return "\n".join(blocos)


def _clipe(imagem: Path, segundos: float, destino: Path, aproximar: bool,
           largura: int = 1080, altura: int = 1920) -> None:
    quadros = max(1, int(segundos * FPS))
    zoom = (f"min(1+0.12*on/{quadros},1.12)" if aproximar
            else f"max(1.12-0.12*on/{quadros},1)")
    w, h = largura, altura
    filtro = (
        f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},"
        f"scale={w * 3 // 2}:{h * 3 // 2},"   # 1,5x basta para o zoom ficar liso e esquenta menos
        f"zoompan=z='{zoom}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
        f":s={w}x{h}:fps={FPS},format=yuv420p")
    midia.rodar(["-loop", "1", "-framerate", str(FPS), "-i", str(imagem),
                 "-t", f"{segundos:.3f}", "-vf", filtro,
                 "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
                 "-an", str(destino)])


def _clipe_animado(video: Path, segundos: float, destino: Path,
                   largura: int = 1080, altura: int = 1920) -> None:
    """Usa um clipe animado (ex.: do Google Flow) no lugar da imagem parada.

    Corta para 9:16 sem esticar. Se o clipe for mais curto que a fala, segura o
    último quadro; se for mais longo, corta no tempo da fala.
    """
    filtro = (f"scale={largura}:{altura}:force_original_aspect_ratio=increase,crop={largura}:{altura},"
              f"fps={FPS},tpad=stop_mode=clone:stop_duration={segundos:.3f},format=yuv420p")
    midia.rodar(["-i", str(video), "-t", f"{segundos:.3f}", "-vf", filtro,
                 "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
                 "-an", str(destino)])


def _lista_concat(arquivos: list[Path], destino: Path) -> None:
    destino.write_text("".join(f"file '{a.name}'\n" for a in arquivos), encoding="utf-8")


def montar(cfg: Config, roteiro: dict, imagens: list[Path],
           faixas: list[tuple[Path, float]], pasta: Path,
           formato: str = "vertical", saida: str = "video_final.mp4",
           respiro: float = 0.15) -> Path:
    """Monta o vídeo. formato="horizontal" faz 1920x1080 (YouTube longo)."""
    midia.checar_ffmpeg()
    largura, altura, estilo_legenda, palavras_legenda = FORMATOS[formato]
    # Curto vertical que ficou abaixo de 62 s: alonga as pausas (sem acelerar a voz)
    # até chegar perto de 63,5 s, com pausa máxima de 1,0 s por cena.
    if formato == "vertical" and faixas:
        fala_total = sum(d for _, d in faixas)
        if fala_total + len(faixas) * respiro < 62:
            respiro = min(1.3, max(respiro, (65.0 - fala_total) / len(faixas)))
    duracoes = [d + respiro for _, d in faixas]     # respiro entre as falas

    # 1) um clipe por cena: animação do Flow quando houver, senão zoom lento na imagem
    clipes = []
    for i, (visual, dur) in enumerate(zip(imagens, duracoes)):
        destino = pasta / f"clipe_{i + 1:02d}.mp4"
        if visual.suffix.lower() in (".mp4", ".mov", ".webm"):
            _clipe_animado(visual, dur, destino, largura, altura)
        else:
            _clipe(visual, dur, destino, aproximar=(i % 2 == 0), largura=largura, altura=altura)
        clipes.append(destino)

    _lista_concat(clipes, pasta / "clipes.txt")
    midia.rodar(["-f", "concat", "-safe", "0", "-i", "clipes.txt", "-c", "copy", "visual.mp4"], cwd=pasta)

    # 2) voz: junta as falas, cada uma com o mesmo respiro do clipe
    entradas, filtros = [], []
    for i, (fala, _) in enumerate(faixas):
        entradas += ["-i", fala.name]
        filtros.append(f"[{i}:a]apad=pad_dur={respiro}[a{i}]")
    junta = "".join(f"[a{i}]" for i in range(len(faixas)))
    filtros.append(f"{junta}concat=n={len(faixas)}:v=0:a=1[voz]")
    midia.rodar([*entradas, "-filter_complex", ";".join(filtros), "-map", "[voz]",
                 "-c:a", "aac", "-b:a", "160k", "narracao.m4a"], cwd=pasta)

    # 3) legenda
    (pasta / "legendas.srt").write_text(
        gerar_legenda(roteiro["cenas"], duracoes, palavras_legenda), encoding="utf-8")

    # 4) vídeo final. Rodamos dentro da pasta para o filtro de legenda não
    #    tropeçar no "C:\" dos caminhos do Windows.
    args = ["-i", "visual.mp4", "-i", "narracao.m4a"]
    musica = cfg.musica_fundo if cfg.musica_fundo and cfg.musica_fundo.exists() else None
    if musica:
        args += ["-stream_loop", "-1", "-i", str(musica.resolve())]
        audio = "[1:a]volume=1.0[v];[2:a]volume=0.10[m];[v][m]amix=inputs=2:duration=first[aud]"
        mapa_audio = "[aud]"
    else:
        audio, mapa_audio = "", "1:a"

    video = f"[0:v]subtitles=legendas.srt:force_style='{estilo_legenda}'[vid]"
    filtro = video + (";" + audio if audio else "")
    base = [*args, "-filter_complex", filtro, "-map", "[vid]", "-map", mapa_audio,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", saida]
    try:
        midia.rodar(base, cwd=pasta)
    except midia.ErroFFmpeg:
        # FFmpeg sem libass: entrega sem legenda queimada (o .srt fica na pasta
        # para subir junto no YouTube ou colar no CapCut)
        filtro = "[0:v]null[vid]" + (";" + audio if audio else "")
        base[base.index("-filter_complex") + 1] = filtro
        midia.rodar(base, cwd=pasta)
        roteiro.setdefault("avisos", []).append(
            "Seu FFmpeg não tem suporte a legenda; o vídeo saiu sem legenda queimada. "
            "Instale a versão completa: winget install --id Gyan.FFmpeg")

    # limpa intermediários grandes; imagens, falas e .srt ficam
    for c in clipes:
        c.unlink(missing_ok=True)
    (pasta / "visual.mp4").unlink(missing_ok=True)
    (pasta / "clipes.txt").unlink(missing_ok=True)
    return pasta / saida
