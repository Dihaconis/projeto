"""Acesso ao Gemini (plano gratuito) com tentativas e troca de modelo.

O plano gratuito tem limite por minuto e por dia. Quando o Google responde
429 (limite batido), esperamos e tentamos de novo; se continuar, passamos
para o próximo modelo da lista GEMINI_MODELOS.
"""
from __future__ import annotations

import json
import re
import time

from .config import Config


class ErroLLM(RuntimeError):
    pass


def _extrair_json(texto: str) -> dict:
    """Aceita JSON puro ou JSON dentro de ```json ... ```."""
    texto = texto.strip()
    bloco = re.search(r"```(?:json)?\s*(\{.*\})\s*```", texto, re.S)
    if bloco:
        texto = bloco.group(1)
    inicio, fim = texto.find("{"), texto.rfind("}")
    if inicio == -1 or fim == -1:
        raise ErroLLM("A resposta do modelo não trouxe JSON.")
    return json.loads(texto[inicio:fim + 1])


class LLM:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._cliente = None

    def _cliente_gemini(self):
        if self._cliente is None:
            from google import genai  # importa só quando precisa
            self._cliente = genai.Client(api_key=self.cfg.gemini_key)
        return self._cliente

    def gerar_json(self, prompt: str, tentativas: int = 3) -> dict:
        ultimo_erro: Exception | None = None
        for modelo in self.cfg.gemini_modelos:
            for n in range(tentativas):
                try:
                    resp = self._cliente_gemini().models.generate_content(
                        model=modelo,
                        contents=prompt,
                        config={"response_mime_type": "application/json",
                                "temperature": 0.9},
                    )
                    return _extrair_json(resp.text or "")
                except Exception as e:  # noqa: BLE001 — SDK lança vários tipos
                    ultimo_erro = e
                    msg = str(e)
                    if "429" in msg or "RESOURCE_EXHAUSTED" in msg:
                        if "PerDay" in msg or "per day" in msg.lower():
                            print(f"   cota do dia acabou no {modelo}, tentando outro modelo")
                            break                      # esperar não adianta: só amanhã
                        time.sleep(20 * (n + 1))      # limite por minuto: espera e tenta de novo
                        continue
                    if isinstance(e, (json.JSONDecodeError, ErroLLM)):
                        continue                       # resposta torta: tenta de novo
                    break                              # erro de modelo: próximo modelo
        raise ErroLLM(f"Nenhum modelo respondeu. Último erro: {ultimo_erro}")
