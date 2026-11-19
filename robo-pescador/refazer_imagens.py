"""Refaz as imagens (e o vídeo) de um episódio já escrito, sem gastar roteiro novo.

Uso:
    python refazer_imagens.py                 # usa o último episódio pronto
    python refazer_imagens.py EP-20261104-004420

Cria uma pasta nova (mesmo nome + "-v2", "-v3"...) e deixa a original intacta.
"""
import json
import shutil
import sys

from robo.chefe import produzir_episodio
from robo.config import Config
from robo.llm import LLM

sys.stdout.reconfigure(encoding="utf-8")
cfg = Config.carregar()

if len(sys.argv) > 1:
    origem = cfg.pasta_saida / sys.argv[1]
else:
    prontos = sorted(p for p in cfg.pasta_saida.glob("EP-*") if (p / "video_final.mp4").exists())
    if not prontos:
        raise SystemExit("Nenhum episódio pronto para refazer.")
    origem = prontos[-1]

n = 2
while (destino := origem.with_name(f"{origem.name.split('-v')[0]}-v{n}")).exists():
    n += 1
destino.mkdir(parents=True)
for nome in ("roteiro.json", "textos.json"):
    shutil.copy(origem / nome, destino / nome)

roteiro = json.loads((destino / "roteiro.json").read_text(encoding="utf-8"))
roteiro.pop("avisos", None)
faltando = [c for c in roteiro["cenas"] if not c.get("imagem_en")]
if faltando:
    print("Traduzindo as cenas para inglês (para o gerador de imagens)...")
    pedido = (
        "Para cada descrição de cena abaixo, escreva UMA frase em inglês para um gerador de imagens: "
        "concreta (quem aparece, o que faz, enquadramento, hora do dia). Chame o menino de "
        "'Lucas, the boy' e o avô de 'Grandpa'. Não descreva roupas nem estilo. "
        "O cenário é sempre rio de água doce, nunca mar. "
        'Responda APENAS com JSON: {"cenas": ["...", "..."]}\n\n'
        + json.dumps([c["descricao_visual"] for c in roteiro["cenas"]], ensure_ascii=False))
    traducoes = LLM(cfg).gerar_json(pedido)["cenas"]
    for cena, en in zip(roteiro["cenas"], traducoes):
        cena["imagem_en"] = en
(destino / "roteiro.json").write_text(json.dumps(roteiro, ensure_ascii=False, indent=2), encoding="utf-8")

print(f"Refazendo em {destino.name}")
produzir_episodio(cfg, continuar=destino)
