"""Configuração central: lê o .env e a bíblia da série uma vez só."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

try:
    from dotenv import load_dotenv
except ImportError:  # python-dotenv é opcional na nuvem (lá usamos secrets)
    load_dotenv = None

RAIZ = Path(__file__).resolve().parent.parent


def _env(nome: str, padrao: str = "") -> str:
    return os.environ.get(nome, padrao).strip()


@dataclass
class Config:
    serie: dict
    gemini_key: str = ""
    gemini_modelos: list[str] = field(default_factory=list)
    pollinations_token: str = ""
    voz: str = "pt-BR-AntonioNeural"
    velocidade_voz: str = "-6%"
    telegram_token: str = ""
    telegram_chat: str = ""
    musica_fundo: Path | None = None
    pasta_saida: Path = RAIZ / "saida"
    modo_teste: bool = False
    imagens_origem: str = "pollinations"     # "pollinations" ou "colab"
    pasta_drive: Path | None = None          # pasta robo-pescador dentro do Google Drive
    animar: bool = False                     # para uma vez para você fazer clipes no Flow

    @classmethod
    def carregar(cls, modo_teste: bool | None = None) -> "Config":
        if load_dotenv:
            load_dotenv(RAIZ / ".env")
        with open(RAIZ / "config" / "serie.yaml", encoding="utf-8") as f:
            serie = yaml.safe_load(f)

        musica = _env("MUSICA_FUNDO")
        teste = _env("MODO_TESTE", "0") == "1" if modo_teste is None else modo_teste
        cfg = cls(
            serie=serie,
            gemini_key=_env("GEMINI_API_KEY"),
            gemini_modelos=[m.strip() for m in _env(
                "GEMINI_MODELOS", "gemini-flash-latest,gemini-3.5-flash,gemini-flash-lite-latest").split(",") if m.strip()],
            pollinations_token=_env("POLLINATIONS_TOKEN"),
            voz=_env("VOZ_NARRADOR", "pt-BR-AntonioNeural"),
            velocidade_voz=_env("VELOCIDADE_VOZ", "-6%"),
            telegram_token=_env("TELEGRAM_TOKEN"),
            telegram_chat=_env("TELEGRAM_CHAT_ID"),
            musica_fundo=Path(musica) if musica else None,
            pasta_saida=RAIZ / _env("PASTA_SAIDA", "saida"),
            modo_teste=teste,
            imagens_origem=_env("IMAGENS_ORIGEM", "pollinations").lower(),
            pasta_drive=Path(_env("PASTA_DRIVE")) if _env("PASTA_DRIVE") else None,
            animar=_env("ANIMAR", "0") == "1",
        )
        cfg.validar()
        return cfg

    def validar(self) -> None:
        """Falha cedo, com mensagem clara, em vez de quebrar no meio do vídeo."""
        if not self.modo_teste and not self.gemini_key:
            raise SystemExit(
                "Falta GEMINI_API_KEY no .env. Pegue uma grátis em "
                "https://aistudio.google.com/apikey ou rode com MODO_TESTE=1.")
        if self.imagens_origem not in ("pollinations", "colab"):
            raise SystemExit("IMAGENS_ORIGEM no .env deve ser 'pollinations' ou 'colab'.")
        if self.imagens_origem == "colab" and not self.modo_teste:
            if not self.pasta_drive:
                raise SystemExit(
                    "Com IMAGENS_ORIGEM=colab, preencha PASTA_DRIVE no .env com a pasta "
                    "robo-pescador do Google Drive (ex.: G:\\Meu Drive\\robo-pescador).")
            if not self.pasta_drive.exists():
                raise SystemExit(
                    f"Não achei a pasta {self.pasta_drive}. O Google Drive para computador está "
                    "instalado e aberto? A pasta robo-pescador já existe no Drive?")
