"""Confere se o bot do Telegram está funcionando e reenvia o último episódio pronto.

Uso:  python testar_telegram.py
"""
import sys

import requests

from robo.config import Config
from robo.notificador import API, avisar, descobrir_chat

sys.stdout.reconfigure(encoding="utf-8")
cfg = Config.carregar()
if not cfg.telegram_token:
    raise SystemExit("Falta TELEGRAM_TOKEN no .env")

eu = requests.get(API.format(token=cfg.telegram_token, metodo="getMe"), timeout=30).json()
if not eu.get("ok"):
    raise SystemExit(f"Token recusado pelo Telegram: {eu.get('description')}")
print(f"Bot online: @{eu['result']['username']}")

cfg.telegram_chat = descobrir_chat(cfg)
if not cfg.telegram_chat:
    raise SystemExit("O bot ainda não recebeu nenhuma mensagem sua. Abra o bot, toque em Iniciar e mande 'oi'.")
print("Conversa com você encontrada.")

prontos = sorted(p for p in cfg.pasta_saida.glob("EP-*") if (p / "video_final.mp4").exists())
if not prontos:
    raise SystemExit("Nenhum episódio pronto para enviar.")
pasta = prontos[-1]
mensagem = (pasta / "PACOTE.txt").read_text(encoding="utf-8")
avisar(cfg, pasta, pasta / "video_final.mp4", pasta / "thumbnail.jpg", mensagem)
print(f"Enviado: {pasta.name}")
