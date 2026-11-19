from robo.config import Config
from robo.notificador import avisar_texto

texto = """🎣 Rodada diária (18/11)

✅ Pronto hoje: nada novo — as imagens do Colab ainda não chegaram.

⏳ Esperando o Colab: 9 episódios
• Longo: O ouro que o Vô soltou no rio
• Curtos de ontem: O anzol da Bisavó, A canoa furada, O tucunaré que voltou pro rio, A lanterna que apagou
• Curtos de hoje: O boto que seguia a canoa, As andorinhas voando baixo, O recado na garrafa, A rede rasgada

👉 Pelo computador, abra o caderno gerador_imagens_pescador no Colab (conta mv.vegas2003) e aperte "Executar tudo". Depois o robô monta sozinho (ou rode --continuar).

✍️ Escrevi 4 roteiros curtos novos (os de hoje acima)."""

ok = avisar_texto(Config.carregar(), texto)
print("enviado:", ok)
