# Savage Worlds Compatibility Package for Gravewright — lançamento 0.1.0

Lançamento desta implementação para Django e da extensão de regras do servidor.
As versões anteriores 0.2.x–0.4.0 identificavam etapas de desenvolvimento.
A numeração não altera os lançamentos já publicados de implementações anteriores.

## Entrega

- Fichas de personagem e NPC com cinco abas, cálculos e exceções individuais.
- Treze estruturas de itens criadas pelo usuário, com biblioteca e cópias na ficha.
- Rolagens, dano, Absorção, recuperação, poderes e dispositivos arcanos.
- Combate com iniciativa por cartas nativas, grupos, Benes, pausa e retomada.
- Três baralhos originais completos, importados pelo usuário em Personalizar.
- Configurações de moeda, PP, Ferimentos, Coringas, Movimento e carga por mesa.
- Modais nativas, permissões de mestre/jogador, salvamento e recuperação de operações.
- Interfaces em português, inglês e espanhol.
- Integração com o Translator oficial: idioma por conta, 646 rótulos revisados
  por idioma e atualização dos controles sem recomeçar ações ou alterar conteúdo
  do usuário. Galerias não trazem títulos em português embutidos nas imagens.

Os pacotes começam sem compêndios, descrições ou conteúdo do livro. As imagens
de cartas são originais. A única imagem oficial incluída é o logo fornecido para
uso com permissão. O aviso literal da Pinnacle aparece nos dois pacotes e no
Sobre da modal Personalizar. O PDF e outras imagens oficiais não são distribuídos.

## Compatibilidade

Requer SDK 1.0.0 e Gravewright 0.2.3 ou posterior, que inclui os contratos
genéricos `context.host` e `card.asset.upload`. Atualize o VTT antes de instalar
os pacotes SWADE 0.1.0. Os contratos do core permanecem independentes de sistemas.

Instale a extensão de regras **0.1.0** em Módulos e o sistema **0.1.0** em Sistemas.
Ative a extensão e selecione a versão **0.1.0** na mesa. Não altere os IDs dos
pacotes para migrar protótipos. Fichas, configurações, baralhos e recibos existentes
continuam no mesmo namespace. Os arquivos .sha256 acompanham os dois ZIPs.

## Verificação

Os builds verificam os manifests, versões, traduções, arquivos, CRC e SHA-256.
Testes de regras e contratos usam fixtures isoladas. Os testes reais de navegador
instalam o ZIP em banco e mídia descartáveis e verificam fichas, itens, combate,
baralhos, configurações, permissões, conflitos e persistência.

Fechar estes artefatos não publica uma release nem ativa os pacotes na mesa em uso.
