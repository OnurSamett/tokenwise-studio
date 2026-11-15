# tokenwise studio başlangıç rehberi

[English getting started guide](getting-started.md) · [Ana README](../README.md)

Studio, kodlama ajanlarını bir araya getiren yerel uygulamadır. Claude Code, Codex CLI veya Antigravity'yi **kendisi kurmaz**; bulut modellerini bilgisayarına indirmez ve sağlayıcı hesaplarına senin yerine giriş yapmaz. Kullanmak istediğin ajanları ayrıca kurarsın; hepsini kurmak zorunda değilsin. Erişim ve limitler sağlayıcıya ve hesabına bağlıdır.

## 1. Studio'yu kur ve proje aç

1. macOS'ta [Mac uygulamasını indir](https://github.com/OnurSamett/tokenwise-studio/releases/latest/download/tokenwise-studio.dmg), DMG'yi aç ve uygulamayı Applications klasörüne sürükle. Node.js çalışma zamanı uygulamanın içindedir. Gerekirse [Git'i](https://git-scm.com/install/) ayrıca kur.
2. tokenwise studio'yu açıp bir proje klasörü seç. Dosya değiştiren çalışanlar ve yalıtılmış worktree'leri için Git deposu gerekir; Git olmayan bir klasörde uygulama kurulumu açıklayabilir.
3. Windows için [masaüstü beta](https://github.com/OnurSamett/tokenwise-studio/releases/latest/download/tokenwise-studio-windows.zip) vardır. Ön koşullar ve sınırlar için [Windows kurulum notlarını](../README.md#windows-beta) incele.

Bu bilgisayarda desteklenen bir CLI'a zaten giriş yaptıysan Studio mevcut oturumu kullanabilir. Aksi halde aşağıdaki sağlayıcılardan birini veya birkaçını seç.

## 2. Ajanı kur ve hesabına giriş yap

- **Claude:** [Claude Code'u kur](https://code.claude.com/docs/en/setup), Terminal'de `claude auth login` çalıştır ve yönergeleri izle. Claude masaüstü uygulamasına giriş yapmış olmak, Claude Code'un da kurulu ve giriş yapılmış olduğunu garanti etmez.
- **Codex:** [Codex CLI'ı kur](https://github.com/openai/codex#quickstart), ardından `codex login` çalıştırıp giriş yöntemini seç. Codex masaüstü uygulamasını kurmak, CLI'ın da kurulduğunu veya giriş yaptığını garanti etmez.
- **Gemini:** [Google Antigravity'yi kur](https://antigravity.google/download) ve hesabına giriş yap. Studio, Antigravity'nin `agy` CLI'ını arar. Kurulumun `agy` komutunu PATH'e eklemiyorsa sağlayıcının CLI kurulum yönergelerini izle. Gemini'yi yönetici olarak kullanmak için Studio Ayarlar'daki ilgili Antigravity seçeneğini aç. Studio, Antigravity'ye MCP sunucusu kaydedebilir; değiştirmeden önce ayarları incele.

Desteklenen platformları, hesapları ve plan gereksinimlerini sağlayıcının belgelerinden kontrol et. CLI eksikse, uygulamanın PATH'inde değilse, oturum kapalıysa veya kota doluysa sağlayıcı kullanılamayabilir; kurulumdan sonra Studio'yu yeniden başlatıp durum göstergelerine bak. Şifreni veya doğrulama kodunu sohbet alanına yapıştırma; doğrudan sağlayıcı üzerinden giriş yap.

**Ayrıca Studio CLI'ı kurduysan** araç ve oturum durumlarını Terminal'de şu komutla kontrol edebilirsin:

```sh
tokenwise-studio doctor
```

İndirilen masaüstü uygulaması bu komutu sistem PATH'ine her zaman eklemez. Uygulamanın karşılama ekranında da sağlayıcı durumları görünür. Bir NVIDIA anahtarının yapılandırılmış olması, her modelin yanıt vereceği anlamına gelmez.

## 3. İsteğe bağlı: ücretsiz veya yerel modeller

- **NVIDIA'nın barındırdığı modeller:** [NVIDIA API Catalog](https://docs.api.nvidia.com/nim/docs/api-quickstart) üzerinden anahtar oluştur, Studio'nun erişebileceği `NVIDIA_API_KEY` ortam değişkenini ayarla ve Ayarlar'da ücretsiz modellere izin ver. Deneme limitleri ve model erişimi değişebilir. Sağlayıcıya gönderilen istekler ve proje içeriği onun koşullarına tabidir. Anahtarını sohbete yapıştırma, depoya commit etme veya ekran görüntüsünde paylaşma.
- **Yerel Ollama:** [Ollama'yı kurup başlat](https://docs.ollama.com/quickstart), Codex CLI'ı kur ve yapılandırılmış yerel modeli indir (varsayılan model `gpt-oss:20b`; örneğin `ollama pull gpt-oss:20b`). Yerel çalıştırma bilgisayarının kaynaklarını kullanır; model boyutu ve donanım gereksinimi değişebilir.

## 4. İlk görevi çalıştır

Mesaj alanından hazır bir yönetici veya ekip seç, küçük bir görev yaz ve sonucu incele. Yazma işleri ayrı Git worktree'lerinde yürür. Değişiklikleri uygulamadan önce inceleme panelinden gözden geçir; seçtiğin görevi çalıştırmak için ilgili sağlayıcının erişilebilir olması gerekir. Ayrıntılar için [Nasıl çalışır?](../README.md#how-it-works) bölümüne bak.

## Sağlayıcı hazır görünmüyorsa

1. İlgili CLI'ın kurulu, hesabının açık ve kullanıcı hesabının erişimine uygun olduğundan emin ol. Kurulum, PATH veya ortam değişkenini değiştirdikten sonra Studio'yu yeniden başlat.
2. Bağımsız Studio CLI kuruluysa Terminal'de `tokenwise-studio doctor` çalıştır. Yalnızca uygulamayı kullanıyorsan karşılama ekranındaki durum göstergelerine ve sağlayıcının kendi giriş komutuna bak.
3. Sağlayıcı hesabını ve kotayı kontrol et. API erişimi, modelin sunulması ve plan erişimi ayrı konulardır; başlamak için tüm sağlayıcıları denemen gerekmez.
4. Ücretsiz modellerde anahtarın ve izin ayarının yapıldığını doğrula; sağlayıcı bir modeli listelediğinde bile model yanıt vermeyebilir. Ollama'da servisin çalıştığını ve yapılandırılmış modelin indirildiğini kontrol et.
