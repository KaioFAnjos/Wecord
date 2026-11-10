# Wecord

Chamada de vídeo entre vocês dois (ou até ~4 pessoas) com **compartilhamento de tela, de janelas e webcam**, direto de um PC para o outro.

- Compartilhe a **tela inteira** ou **uma janela específica**, com miniaturas para escolher
- **Som do computador** junto com a tela (Windows): filmes, vídeos e jogos com áudio
- Qualidade até **1440p a 60 fps**, com modo "Movimento" (jogos/vídeos) ou "Nitidez" (textos)
- Webcam, microfone, "silenciar tudo", chat, tela cheia, fixar quem está em destaque, volume por pessoa
- Indicador de quem está falando, resolução/fps da tela recebida, sons de entrada e saída
- **P2P criptografado** (WebRTC/DTLS-SRTP): o vídeo vai direto de um PC pro outro, sem servidor de mídia

---

## Para quem vai usar (instalação em 1 clique)

1. Baixe o **`Wecord-Instalador-X.Y.Z.exe`** mais recente em [Releases](https://github.com/KaioFAnjos/Wecord/releases/latest) e dê dois cliques.
2. O Windows pode mostrar **"O Windows protegeu o computador"** (o app não tem assinatura paga).
   Clique em **Mais informações → Executar assim mesmo**.
3. O Wecord instala sozinho, cria um atalho na Área de Trabalho e já abre.
4. Na primeira chamada, o Windows pode perguntar sobre o **Firewall**: clique em **Permitir**.

**Atualizações são automáticas:** ao abrir, o Wecord procura uma versão nova e baixa em segundo plano. Quando terminar, aparece "Nova versão pronta" no canto da tela. Clique em **Reiniciar e atualizar** ou feche o aviso: nesse caso a atualização é instalada quando você fechar o Wecord.

> Não quer instalar? Use o **`Wecord-Portatil-X.Y.Z.exe`**: é só abrir, não instala nada. O portátil **não** se atualiza sozinho.

### Como fazer uma chamada

| Quem chama | Quem entra |
|---|---|
| Digita o nome e clica em **Criar uma sala** | Digita o nome |
| O código (ex: `K7M-Q2P`) já fica copiado: mande pelo WhatsApp | Cola o código e clica em **Entrar** |

Na chamada:

| Botão | Atalho | O que faz |
|---|---|---|
| Microfone | `M` | Liga/desliga seu microfone |
| Câmera | `V` | Liga/desliga a webcam |
| Tela | `S` | Escolhe a tela ou janela para compartilhar (clique de novo para parar) |
| Áudio | `D` | Silencia tudo: você não ouve e não é ouvido |
| Chat | — | Mensagens de texto |
| Sair | — | Sai da sala |

Passe o mouse sobre um vídeo para **fixar**, ver em **tela cheia** (ou dê dois cliques) e ajustar o **volume** daquela pessoa ou da tela dela.

### Dicas

- **Som do computador com eco**: no Windows, o som compartilhado é tudo o que toca no PC, inclusive a voz da outra pessoa. Se ela ouvir eco da própria voz, desligue "Compartilhar o som do computador" no seletor.
- A qualidade da tela começa mais baixa e sobe em uns 10–15 segundos, conforme a conexão permite.
- Se quem criou a sala sair, a sala continua: quem ficou assume o código automaticamente.
- Se a conexão não funcionar em alguma rede (empresa, faculdade, 4G muito restrito), configure um servidor **TURN** em *Ajustes → Conexão avançada* (por exemplo, o plano gratuito do metered.ca ou um coturn próprio).

---

## Para desenvolvedores

```bash
npm install
npm start                 # roda o app (Electron)
npm run web               # versão navegador em http://localhost:5173
npm run dist:win          # gera dist/Wecord-Instalador-*.exe e dist/Wecord-Portatil-*.exe
npm run dist:linux        # AppImage
npm run dist:mac          # dmg (precisa rodar num Mac)
```

`npm run dist:win` funciona no Windows, no Linux e no WSL **sem precisar do Wine**: o desinstalador é extraído em JavaScript, e no WSL o ícone e os metadados do `.exe` são aplicados rodando o `rcedit` pelo próprio Windows (ver `scripts/build-win.js`).

### Lançando uma atualização

```bash
npm run release -- patch     # 1.0.0 → 1.0.1  (ou minor, major, ou 1.2.3)
```

O comando aumenta a versão no `package.json`, faz commit, cria a tag `vX.Y.Z` e envia ao GitHub. O workflow [.github/workflows/build.yml](.github/workflows/build.yml) gera os instaladores de Windows, macOS e Linux e publica tudo no GitHub Releases (o `.exe`, o `latest.yml` e o `.blockmap`, que permite baixar só a parte que mudou). Leva uns 10 minutos. Depois disso, todo Wecord instalado se atualiza sozinho ao abrir, ou em até 4 h se já estiver aberto.

- A versão da tag precisa ser igual à do `package.json` (o workflow confere).
- Rodar o workflow manualmente (Actions → Build → Run workflow) gera os instaladores **sem** publicar.
- Só o instalador do Windows se atualiza. O portátil, o AppImage e o dmg não se atualizam (o macOS exigiria assinatura paga).

Para testar duas pessoas no mesmo PC: `Wecord.exe --profile=teste` abre uma segunda instância independente.

### Arquitetura

```
main.js        Processo principal do Electron: janela, permissões, captura de tela
               (desktopCapturer + setDisplayMediaRequestHandler, loopback de áudio no Windows)
preload.js     Ponte segura (contextIsolation) com a interface
src/rtc.js     Rede: sinalização PeerJS + um RTCPeerConnection por pessoa (perfect negotiation)
src/app.js     Interface: tela inicial, chamada, seletor de tela, chat, configurações
src/styles.css Tema escuro
```

**Salas:** cada pessoa tem um ID aleatório no servidor de sinalização. A sala é um segundo ID
(`wecord-v1-room-CODIGO`) mantido por alguém dentro dela. Quem entra pergunta a esse "lobby" quem
está na sala e se conecta diretamente com cada um (malha P2P). Se quem mantém o lobby sair, o
membro com o menor ID assume.

**Mídia:** câmera e microfone vão num stream, a tela (vídeo + áudio) em outro, e um mapa
`stream.id → tipo` é enviado pelo canal de dados. Ligar e desligar câmera ou tela renegocia
automaticamente. Transceivers livres são reaproveitados, então o SDP não cresce sem limite.
Mensagens grandes (SDP) são divididas em pedaços, por causa do limite de cerca de 16 KB do canal
JSON do PeerJS.

**Servidores:** a sinalização usa o servidor público gratuito do PeerJS (`0.peerjs.com`), que só
troca as mensagens de conexão. Para não depender dele, rode o
[peerjs-server](https://github.com/peers/peerjs-server) e informe o endereço em *Ajustes → Conexão
avançada*. Todas as pessoas da sala precisam usar o mesmo servidor.
