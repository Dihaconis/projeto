"""Avisa você no Telegram com o pacote pronto para postar."""
from __future__ import annotations

from pathlib import Path

import requests

from .config import RAIZ, Config

ARQUIVO_CHAT = RAIZ / "dados" / "telegram_chat.txt"
API = "https://api.telegram.org/bot{token}/{metodo}"
LIMITE_VIDEO_BOT = 49 * 1024 * 1024   # bots do Telegram enviam até 50 MB


def _chamar(cfg: Config, metodo: str, dados: dict, arquivo: tuple[str, Path] | None = None) -> None:
    url = API.format(token=cfg.telegram_token, metodo=metodo)
    if arquivo:
        campo, caminho = arquivo
        with open(caminho, "rb") as f:
            r = requests.post(url, data=dados, files={campo: f}, timeout=300)
    else:
        r = requests.post(url, data=dados, timeout=60)
    r.raise_for_status()


def descobrir_chat(cfg: Config) -> str:
    """Acha o chat_id sozinho, para você não precisar procurar esse número.

    Basta mandar qualquer mensagem para o seu bot uma vez. O número fica salvo
    em dados/telegram_chat.txt (o GitHub guarda junto com o histórico).
    """
    if cfg.telegram_chat:
        return cfg.telegram_chat
    if ARQUIVO_CHAT.exists():
        return ARQUIVO_CHAT.read_text(encoding="utf-8").strip()
    url = API.format(token=cfg.telegram_token, metodo="getUpdates")
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    for upd in reversed(r.json().get("result", [])):
        msg = upd.get("message") or upd.get("edited_message") or {}
        chat_id = (msg.get("chat") or {}).get("id")
        if chat_id:
            ARQUIVO_CHAT.parent.mkdir(parents=True, exist_ok=True)
            ARQUIVO_CHAT.write_text(str(chat_id), encoding="utf-8")
            return str(chat_id)
    return ""


def avisar(cfg: Config, pacote: Path, video: Path, capa: Path, mensagem: str) -> bool:
    """Devolve True se avisou pelo Telegram; senão só imprime no terminal."""
    if cfg.telegram_token and not cfg.modo_teste:
        cfg.telegram_chat = descobrir_chat(cfg)
        if not cfg.telegram_chat:
            print("AVISO: mande um 'oi' para o seu bot no Telegram e rode de novo.")
    if not (cfg.telegram_token and cfg.telegram_chat):
        print("\n" + mensagem + f"\n\nArquivos em: {pacote}")
        return False

    chat = {"chat_id": cfg.telegram_chat}
    _chamar(cfg, "sendMessage", {**chat, "text": mensagem[:4000]})
    _chamar(cfg, "sendPhoto", {**chat, "caption": "Thumbnail"}, ("photo", capa))
    if video.stat().st_size <= LIMITE_VIDEO_BOT:
        # sendDocument manda o arquivo original, sem o Telegram recomprimir
        _chamar(cfg, "sendDocument", {**chat, "caption": "Vídeo pronto"}, ("document", video))
    else:
        _chamar(cfg, "sendMessage", {**chat, "text": "Vídeo passou de 50 MB; pegue na pasta do episódio."})
    return True


def avisar_texto(cfg: Config, texto: str) -> bool:
    """Manda só uma mensagem de texto (ex.: "episódio esperando as imagens do Colab")."""
    print(texto)
    if not cfg.telegram_token or cfg.modo_teste:
        return False
    cfg.telegram_chat = descobrir_chat(cfg)
    if not cfg.telegram_chat:
        return False
    try:
        _chamar(cfg, "sendMessage", {"chat_id": cfg.telegram_chat, "text": texto[:4000]})
        return True
    except requests.RequestException:
        return False


def avisar_longo(cfg: Config, roteiro: dict, pasta: Path, capa: Path, cortes: list[dict],
                 problemas: list[str], drive: Path | None) -> bool:
    """Episódio longo: o vídeo grande fica no Drive (passa do limite do Telegram);
    no Telegram vão o resumo, o PACOTE.txt com todos os textos, a thumbnail e os cortes."""
    onde = f"Google Drive → robo-pescador/prontos/{pasta.name}" if drive else str(pasta)
    resumo = (f"🎬 Episódio LONGO pronto: {roteiro['titulo_episodio']}\n"
              f"Vídeo do YouTube (horizontal) e {len(cortes)} cortes em pé.\n"
              f"Vídeo longo em: {onde}\n"
              "Os textos de cada rede estão no PACOTE.txt abaixo.\n"
              + ("⚠️ Confira: " + "; ".join(problemas) if problemas else "✅ Revisão sem problemas."))
    print(resumo)
    if not cfg.telegram_token or cfg.modo_teste:
        return False
    cfg.telegram_chat = descobrir_chat(cfg)
    if not cfg.telegram_chat:
        return False
    chat = {"chat_id": cfg.telegram_chat}
    try:
        _chamar(cfg, "sendMessage", {**chat, "text": resumo[:4000]})
        _chamar(cfg, "sendPhoto", {**chat, "caption": "Thumbnail do YouTube"}, ("photo", capa))
        _chamar(cfg, "sendDocument", {**chat, "caption": "Textos de postagem"},
                ("document", pasta / "PACOTE.txt"))
        for n, c in enumerate(cortes, start=1):
            if c["video"].exists() and c["video"].stat().st_size <= LIMITE_VIDEO_BOT:
                _chamar(cfg, "sendDocument", {**chat, "caption": f"Corte {n}: {c['titulo']}"[:1000]},
                        ("document", c["video"]))
        return True
    except requests.RequestException as e:
        print(f"AVISO: Telegram falhou ({type(e).__name__}); os arquivos estão em {onde}")
        return False


def avisar_audios(cfg: Config, texto: str, audios: list[tuple[str, Path]]) -> bool:
    """Manda uma mensagem e uma lista de áudios (legenda, arquivo .mp3), ex.: amostras de voz."""
    print(texto)
    for legenda, arq in audios:
        print(f"   {legenda}: {arq}")
    if not cfg.telegram_token or cfg.modo_teste:
        return False
    cfg.telegram_chat = descobrir_chat(cfg)
    if not cfg.telegram_chat:
        return False
    chat = {"chat_id": cfg.telegram_chat}
    try:
        _chamar(cfg, "sendMessage", {**chat, "text": texto[:4000]})
        for legenda, arq in audios:
            _chamar(cfg, "sendAudio", {**chat, "caption": legenda[:1000], "title": legenda[:60]}, ("audio", arq))
        return True
    except requests.RequestException as e:
        print(f"AVISO: Telegram falhou ({type(e).__name__}); os áudios estão nas pastas acima")
        return False
