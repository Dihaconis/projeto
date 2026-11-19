"""Monta o caderno do Colab (gerador_imagens_pescador.ipynb) a partir das células abaixo.

Rodar:  python colab/montar_caderno.py
"""
import json
from pathlib import Path

MD_INICIO = """# 🎣 Gerador de imagens — As Histórias de um Pescador

Este caderno gera as imagens que o robô pediu e devolve tudo no seu Google Drive.

**Como usar (uma ou duas vezes por semana):**
1. Menu **Ambiente de execução → Alterar o tipo de ambiente de execução → GPU T4**.
2. Menu **Ambiente de execução → Executar tudo** (ou Ctrl+F9).
3. Na primeira célula que mexe no Drive, autorize o acesso com a sua conta.
4. Pronto. Pode deixar a aba aberta: o caderno gera o que o robô pediu e depois fica **vigiando**
   pedidos novos por até 3 horas. Quando acabar, ele **desliga a GPU sozinho** para não gastar a cota.
5. O robô do notebook percebe as imagens no Drive e monta os vídeos sozinho.

**Use no computador, não no celular:** pelo app do celular a autorização do Drive costuma falhar ("mount failed").

**Por que não dá problema com o Google:** este caderno **não abre página web própria** (nada de link `gradio.live`). Tudo roda aqui mesmo, nas células, que é o uso permitido no Colab grátis.

**Regras deste caderno:** só desenhos da série. Nada de fotos de pessoas reais."""

CEL_GPU = """# 1) Confere a placa de vídeo e instala o necessário (uns 2 minutos)
import subprocess, sys
gpu = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                     capture_output=True, text=True).stdout.strip()
if not gpu:
    raise SystemExit("Sem GPU! Vá em Ambiente de execução → Alterar o tipo → GPU T4 e rode de novo.")
print("Placa:", gpu)
!pip install -q "diffusers>=0.30" "transformers>=4.44" accelerate safetensors"""

CEL_CONFIG = """# 2) Liga o Google Drive e prepara as pastas
from google.colab import drive
drive.mount("/content/drive")

from pathlib import Path
BASE = Path("/content/drive/MyDrive/robo-pescador")
PEDIDOS = BASE / "pedidos"
FEITOS = PEDIDOS / "feitos"
IMAGENS = BASE / "imagens"
REFERENCIAS = BASE / "referencias"
for p in (PEDIDOS, FEITOS, IMAGENS, REFERENCIAS):
    p.mkdir(parents=True, exist_ok=True)

# Ajustes (pode mudar)
MODELO = "RunDiffusion/Juggernaut-XL-v9"   # mesmo modelo que o Fooocus usava
PASSOS = 30                                # 30 a 40: mais passos, mais detalhe, mais lento
CFG = 5.0                                  # 3 a 7: mais alto segue mais o texto
FORCA_ESTILO = 0.8                         # 0 a 1: quanto copiar do referencias/estilo.jpg
VIGIAR_HORAS = 3                           # depois de atender, fica esperando pedidos novos por até 3 h
DESLIGAR_NO_FIM = True                     # desliga a GPU sozinho no fim, para não gastar sua cota

pendentes = sorted(PEDIDOS.glob("*.json"))
print(f"Pedidos esperando: {len(pendentes)}")
for p in pendentes:
    print("  -", p.stem)
if not pendentes:
    print("Nada para fazer. Rode o robô no notebook primeiro (IMAGENS_ORIGEM=colab).")"""

CEL_MODELO = """# 3) Carrega o modelo (na primeira vez baixa uns 7 GB, demora alguns minutos)
import torch
from diffusers import AutoencoderKL, DPMSolverMultistepScheduler, StableDiffusionXLPipeline

# VAE corrigido: evita imagens pretas em meia precisão
vae = AutoencoderKL.from_pretrained("madebyollin/sdxl-vae-fp16-fix", torch_dtype=torch.float16)
try:
    pipe = StableDiffusionXLPipeline.from_pretrained(
        MODELO, vae=vae, torch_dtype=torch.float16, variant="fp16", use_safetensors=True)
except Exception:
    pipe = StableDiffusionXLPipeline.from_pretrained(
        MODELO, vae=vae, torch_dtype=torch.float16, use_safetensors=True)
pipe.scheduler = DPMSolverMultistepScheduler.from_config(
    pipe.scheduler.config, use_karras_sigmas=True)   # DPM++ 2M Karras, o recomendado
pipe.to("cuda")
pipe.vae.enable_slicing()   # economiza memória ao decodificar a imagem

# Referência de estilo (opcional): coloque UMA imagem sua, no estilo da série, em
# robo-pescador/referencias/estilo.jpg — por exemplo a capa que você fez no Canva.
from PIL import Image
ref_estilo = None
arquivo_ref = REFERENCIAS / "estilo.jpg"
if arquivo_ref.exists():
    pipe.load_ip_adapter("h94/IP-Adapter", subfolder="sdxl_models",
                         weight_name="ip-adapter_sdxl.bin")
    # copia só o ESTILO da referência (cores, traço), não o conteúdo
    pipe.set_ip_adapter_scale({"up": {"block_0": [0.0, FORCA_ESTILO, 0.0]}})
    ref_estilo = Image.open(arquivo_ref).convert("RGB")
    print("Usando referência de estilo:", arquivo_ref.name)
else:
    print("Sem referência de estilo (opcional). Seguindo só com o texto.")
print("Modelo pronto.")"""

CEL_GERAR = """# 4) Gera as imagens de todos os pedidos que estão no Drive
import json, shutil, time

def gerar(prompt, negativo, seed, largura, altura):
    extra = {"ip_adapter_image": ref_estilo} if ref_estilo is not None else {}
    return pipe(
        prompt=prompt, negative_prompt=negativo or None,
        width=largura, height=altura,
        num_inference_steps=PASSOS, guidance_scale=CFG,
        generator=torch.Generator("cuda").manual_seed(int(seed)),
        **extra,
    ).images[0]

feitas = []

def atender_pedidos():
    \"\"\"Gera tudo que estiver em pedidos/ e move cada pedido atendido para pedidos/feitos.\"\"\"
    n = 0
    for arquivo in sorted(PEDIDOS.glob("*.json")):
        pedido = json.loads(arquivo.read_text(encoding="utf-8"))
        destino = IMAGENS / pedido["episodio"]
        destino.mkdir(parents=True, exist_ok=True)
        larg, alt = pedido.get("largura", 768), pedido.get("altura", 1344)
        print(f"\\n== {pedido['episodio']} ({len(pedido['cenas'])} cenas, {larg}x{alt})")
        for cena in pedido["cenas"]:
            saida = destino / cena["arquivo"]
            if saida.exists():
                feitas.append(saida)
                continue
            t = time.time()
            img = gerar(cena["prompt"], pedido.get("negativo", ""), cena["seed"], larg, alt)
            img.save(saida, quality=95)
            feitas.append(saida)
            n += 1
            print(f"   ok: {cena['arquivo']} ({time.time() - t:.0f} s)")
        shutil.move(str(arquivo), str(FEITOS / arquivo.name))   # pedido atendido
    return n

total = atender_pedidos()
print(f"\\nPronto: {total} imagens novas no Drive. O robô do notebook continua sozinho.")"""

CEL_PREVIA = """# 5) Prévia das últimas imagens
from PIL import Image
from IPython.display import display
ultimas = feitas[-6:]
if ultimas:
    mini = [Image.open(p).convert("RGB").resize((192, 336)) for p in ultimas]
    grade = Image.new("RGB", (192 * len(mini), 336), "white")
    for i, m in enumerate(mini):
        grade.paste(m, (192 * i, 0))
    display(grade)"""

CEL_VIGIA = """# 6) Modo vigia: fica esperando pedidos novos do robô (ex.: o episódio longo)
#    Para parar antes da hora: botão ■ desta célula.
import time
fim = time.time() + VIGIAR_HORAS * 3600
ultimo = time.time()
print(f"Vigiando a pasta pedidos/ por até {VIGIAR_HORAS} h...")
while time.time() < fim:
    if atender_pedidos():
        ultimo = time.time()
    elif time.time() - ultimo > 45 * 60:
        print("45 min sem pedidos novos: encerrando.")
        break
    time.sleep(60)
if DESLIGAR_NO_FIM:
    from google.colab import runtime
    print("Desligando a GPU para não gastar a cota. Até a próxima!")
    runtime.unassign()"""

MD_TESTE = """## Testar um estilo (opcional)
Use a célula abaixo para experimentar textos à vontade, antes de mudar a série. Ela não mexe nos pedidos."""

CEL_TESTE = """# Teste livre: troque o texto e rode só esta célula
TEXTO = ("Woodcut print illustration, Brazilian cordel folk art, thick black lines, bold flat colors. "
         "Lucas, the boy, and Grandpa fishing in a small wooden canoe at sunset. "
         "Araguaia river, calm fresh water, white sand banks, forest")
NEGATIVO = "photo, photorealistic, 3d render, text, watermark"
SEMENTE = 42
teste = gerar(TEXTO, NEGATIVO, SEMENTE, 768, 1344)
teste.save(BASE / "teste.jpg", quality=95)
display(teste.resize((384, 672)))"""


def celula_codigo(fonte: str) -> dict:
    return {"cell_type": "code", "execution_count": None, "metadata": {},
            "outputs": [], "source": fonte.splitlines(keepends=True)}


def celula_texto(fonte: str) -> dict:
    return {"cell_type": "markdown", "metadata": {}, "source": fonte.splitlines(keepends=True)}


caderno = {
    "cells": [
        celula_texto(MD_INICIO),
        celula_codigo(CEL_GPU),
        celula_codigo(CEL_CONFIG),
        celula_codigo(CEL_MODELO),
        celula_codigo(CEL_GERAR),
        celula_codigo(CEL_PREVIA),
        celula_codigo(CEL_VIGIA),
        celula_texto(MD_TESTE),
        celula_codigo(CEL_TESTE),
    ],
    "metadata": {
        "accelerator": "GPU",
        "colab": {"gpuType": "T4", "provenance": []},
        "kernelspec": {"display_name": "Python 3", "name": "python3"},
        "language_info": {"name": "python"},
    },
    "nbformat": 4,
    "nbformat_minor": 0,
}

destino = Path(__file__).with_name("gerador_imagens_pescador.ipynb")
destino.write_text(json.dumps(caderno, ensure_ascii=False, indent=1), encoding="utf-8")
print("Caderno salvo em", destino)
