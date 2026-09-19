# Points à corriger

Audit du code dans `src/` (6 fichiers, ~1038 lignes). Chaque point est vérifié contre le code réel.

## Bugs

### 1. Fuite de slot de file d'attente
**Fichier :** [src/index.js:105-116](src/index.js#L105-L116)

```js
const [statusMsg] = await Promise.all([
	ctx.replyWithHTML(...),
	queue.acquire(ctx.from.id),
]);
// try/finally (avec queue.release()) commence seulement ici
```

`Promise.all` fait courir `ctx.replyWithHTML` en parallèle de `queue.acquire()`. Si `replyWithHTML` échoue (utilisateur ayant bloqué le bot, erreur Telegram transitoire) alors que `queue.acquire()` a déjà réussi en interne, le `try/finally` qui appelle `queue.release()` n'est jamais atteint. Le sémaphore de cet utilisateur reste bloqué indéfiniment (ses futurs messages restent bloqués dans `acquire`), et le pool global perd une place sur `MAX_CONCURRENT` de façon permanente.

**Piste de correction :** acquérir la queue d'abord, puis envelopper tout le reste (y compris le `replyWithHTML` initial) dans le `try/finally`.

---

### 2. Cooldown consommé même pour une plateforme non supportée
**Fichier :** [src/index.js:93](src/index.js#L93) (vs. vérification plateforme lignes [97-99](src/index.js#L97-L99))

`checkCooldown` horodate `lastRequest` **avant** de vérifier si la plateforme est supportée. Un utilisateur qui envoie un lien non supporté se voit ensuite imposer un délai d'attente alors qu'il n'a jamais lancé de téléchargement.

**Piste de correction :** ne mettre à jour le cooldown qu'après confirmation que la plateforme est supportée (ou juste avant de lancer réellement le téléchargement).

---

### 3. IGTV / vidéos uniques routées vers le mode "galerie d'images"
**Fichier :** [src/utils.js:33](src/utils.js#L33)

`isInstagramGallery` considère toute URL `/p/` ou `/tv/` comme une galerie d'images. Or `/tv/` (IGTV) est toujours une vidéo, et `/p/` peut être un post vidéo unique. Ces liens partent directement dans `downloadImages()` sans repli vers `download()`, ce qui produit `"No images found after download."` pour un téléchargement vidéo pourtant valide.

**Piste de correction :** ne pas présumer à partir de l'URL seule ; tenter `download()` d'abord (ou détecter le type réel via l'API/metadata) et ne basculer vers `downloadImages()` qu'en cas d'échec spécifique "pas de vidéo", comme c'est déjà fait pour TikTok (ligne 124-134).

---

### 4. Timeout fixe déconnecté de la taille max configurée
**Fichier :** [src/downloader.js:13](src/downloader.js#L13)

`TIMEOUT_MS` = 180s en dur, indépendant de `MAX_FILE_SIZE_MB`/`MAX_FILE_SIZE_BYTES`. Sur un réseau lent, un téléchargement proche de la taille max configurée peut légitimement dépasser 180s et se faire tuer (SIGKILL) avant la fin, avec un message "timed out" trompeur.

**Piste de correction :** calculer le timeout en fonction de `MAX_FILE_SIZE_MB` (ex. débit minimal attendu) ou le rendre configurable via l'environnement.

---

### 5. Diagnostic d'erreur trompeur dans `getRunner()`
**Fichier :** [src/downloader.js:296](src/downloader.js#L296)

```js
if (err.code === "NOT_FOUND") continue;
continue;
```

Les deux branches font la même chose : toute erreur non-ENOENT (permission refusée, install Python cassée, process qui plante) est traitée comme "binaire introuvable". Le message final dit toujours `"yt-dlp not found. Run: pip install yt-dlp..."` même quand la vraie cause est différente, ce qui égare l'admin dans son dépannage.

**Piste de correction :** distinguer les codes d'erreur et propager/logguer la vraie cause quand ce n'est pas un `ENOENT`.

---

## Qualité / dette technique

### 6. Duplication entre `buildArgs` et `buildImageArgs`
**Fichier :** [src/downloader.js:96](src/downloader.js#L96)

~8 flags CLI identiques (socket-timeout, retries, geo-bypass, user-agent, extractor-args, cookies, no-warnings, output, print-json, no-simulate) dupliqués entre les deux fonctions au lieu d'une base commune. Une future modification appliquée à une seule des deux ferait diverger silencieusement le comportement vidéo vs images.

**Piste de correction :** extraire les flags communs dans une fonction `buildBaseArgs()` partagée par `buildArgs` et `buildImageArgs`.

---

### 7. Code mort dans `stats.cleanup()`
**Fichier :** [src/stats.js:48](src/stats.js#L48)

La boucle qui supprime les compteurs `byPlatform` à zéro ne peut jamais s'exécuter : rien ne décrémente jamais ces compteurs (`recordSuccess` ne fait qu'incrémenter). Le code suggère une logique de nettoyage qui n'existe pas réellement, ce qui induit en erreur un futur lecteur.

**Piste de correction :** supprimer ce bloc mort, ou implémenter réellement une logique de purge si elle est souhaitée.

---

## Priorité suggérée

1. **#1** (fuite de sémaphore) — peut bloquer un utilisateur définitivement, impact critique.
2. **#3** (IGTV cassé) — casse un cas d'usage légitime existant.
3. **#2** (cooldown mal placé) — UX dégradée mais sans casse fonctionnelle.
4. **#4** et **#5** — fiabilité / diagnostic.
5. **#6** et **#7** — nettoyage, sans urgence.
