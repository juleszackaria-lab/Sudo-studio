# Démarrage automatique et déploiement

Ce fichier explique comment démarrer automatiquement le backend et configurer un déploiement automatique vers GitHub Container Registry.

1) Démarrage local automatique (Docker)

- Construire l'image:

```bash
cd backend
docker compose build
```

- Démarrer en arrière-plan (avec redémarrage automatique):

```bash
docker compose up -d
```

L'option `restart: always` dans `docker-compose.yml` garantit que le service redémarrera automatiquement au boot du serveur.

2) Option: démarrage automatique via systemd (hôte Linux)

Créer un service systemd pour lancer `docker compose up -d` au boot. Exemple de fichier `/etc/systemd/system/sudo-studio-backend.service`:

```ini
[Unit]
Description=Sudo-studio backend (Docker Compose)
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/path/to/your/repo/backend
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

Puis activer:

```bash
sudo systemctl daemon-reload
sudo systemctl enable sudo-studio-backend.service
sudo systemctl start sudo-studio-backend.service
```

3) Déploiement automatique sur GitHub (CI)

Un workflow GitHub Actions est ajouté dans `.github/workflows/ci-deploy.yml` qui construit l'image et la pousse vers `ghcr.io`. Vous devez définir le secret `GHCR_PAT` (Personal Access Token avec droits `write:packages`) dans les Settings du repo.

4) Variables d'environnement recommandées

- `ENTERPRISE_JWT_SECRET` — secret JWT pour l'authentification.
- `ENTERPRISE_INIT_ADMIN` — `true` pour créer un admin initial lors du premier démarrage.
- `ENTERPRISE_ADMIN_USER`, `ENTERPRISE_ADMIN_PASS` — identifiants de l'admin initial.

5) Notes de sécurité

- L'émulateur Docker est strictement whitelisté; il n'accepte aucune commande injectée par l'utilisateur.
- Ne mettez pas de secrets en clair dans le dépôt. Utilisez les secrets GitHub ou variables d'environnement système.
