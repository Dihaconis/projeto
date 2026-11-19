"""Funções de FFmpeg usadas por mais de um robô."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


class ErroFFmpeg(RuntimeError):
    pass


def checar_ffmpeg() -> None:
    for prog in ("ffmpeg", "ffprobe"):
        if not shutil.which(prog):
            raise SystemExit(
                f"{prog} não encontrado. No Windows: winget install --id Gyan.FFmpeg "
                "e depois feche e abra o terminal.")


def rodar(args: list[str], cwd: Path | None = None) -> None:
    proc = subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args],
                          cwd=cwd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise ErroFFmpeg(proc.stderr[-1500:])


def duracao(arquivo: Path) -> float:
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(arquivo)],
        capture_output=True, text=True)
    try:
        return float(proc.stdout.strip())
    except ValueError as e:
        raise ErroFFmpeg(f"Não consegui medir {arquivo.name}: {proc.stderr}") from e


def tem_audio(arquivo: Path) -> bool:
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
         "stream=codec_type", "-of", "csv=p=0", str(arquivo)],
        capture_output=True, text=True)
    return "audio" in proc.stdout
