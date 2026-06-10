/**
 * SUDO STUDIO - DevOps Automation Panel
 * Generates: Dockerfile, docker-compose, GitHub Actions, GitLab CI, Kubernetes
 * Works LOCALLY - no backend required. Detects project stack from workspace.
 * Also has AI-powered generation via runtime port 6000.
 */
const vscode = require('vscode');
const axios  = require('axios');
const path   = require('path');
const fs     = require('fs');
const { exec } = require('child_process');

class DevOpsPanel {
    static currentPanel = undefined;

    constructor(panel, extensionUri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.disposables = [];
        this.projectInfo = null;

        this.panel.webview.html = this.getHtmlContent();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(m => this.handleMessage(m), null, this.disposables);

        // Auto-detect project
        setTimeout(() => this.detectProject(), 300);
    }

    static createOrShow(extensionUri) {
        if (DevOpsPanel.currentPanel) {
            DevOpsPanel.currentPanel.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'sudoDevOps', '🚀 DevOps Automation',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        DevOpsPanel.currentPanel = new DevOpsPanel(panel, extensionUri);
    }

    async handleMessage(msg) {
        switch (msg.type) {
            case 'generateDockerfile':   await this.generateDockerfile(msg.opts); break;
            case 'generateCompose':      await this.generateCompose(msg.opts); break;
            case 'generateGithubActions': await this.generateGithubActions(msg.opts); break;
            case 'generateGitlabCI':     await this.generateGitlabCI(msg.opts); break;
            case 'generateKubernetes':   await this.generateKubernetes(msg.opts); break;
            case 'generateNginx':        await this.generateNginx(msg.opts); break;
            case 'openFile':             await this.openFile(msg.filePath); break;
            case 'refreshProject':       await this.detectProject(); break;
            case 'aiGenerate':           await this.aiGenerate(msg.prompt, msg.type); break;
        }
    }

    // ── Project Detection ───────────────────────────────────────────────────
    async detectProject() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            this.panel.webview.postMessage({ type: 'noWorkspace' });
            return;
        }
        const root = folder.uri.fsPath;
        const info = { root, name: path.basename(root), stack: 'unknown', port: 3000 };

        const exists = f => fs.existsSync(path.join(root, f));

        if (exists('package.json')) {
            const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            if (deps['next']) { info.stack = 'nextjs'; info.port = 3000; }
            else if (deps['react']) { info.stack = 'react'; info.port = 3000; }
            else if (deps['vue']) { info.stack = 'vue'; info.port = 8080; }
            else if (deps['express'] || deps['fastify'] || deps['hapi']) { info.stack = 'nodejs'; info.port = 3000; }
            else { info.stack = 'nodejs'; info.port = 3000; }
            info.packageName = pkg.name;
            info.startScript = pkg.scripts?.start || 'node index.js';
            info.buildScript = pkg.scripts?.build;
        } else if (exists('requirements.txt') || exists('Pipfile') || exists('pyproject.toml')) {
            if (exists('manage.py')) { info.stack = 'django'; info.port = 8000; }
            else if (exists('app.py') || exists('main.py')) { info.stack = 'flask'; info.port = 5000; }
            else { info.stack = 'python'; info.port = 8000; }
        } else if (exists('go.mod')) {
            info.stack = 'go'; info.port = 8080;
        } else if (exists('pom.xml') || exists('build.gradle')) {
            info.stack = 'java'; info.port = 8080;
        } else if (exists('Cargo.toml')) {
            info.stack = 'rust'; info.port = 8080;
        } else if (exists('pubspec.yaml')) {
            info.stack = 'flutter'; info.port = 80;
        }

        this.projectInfo = info;
        this.panel.webview.postMessage({ type: 'projectDetected', info });
    }

    // ── Dockerfile Generator ────────────────────────────────────────────────
    async generateDockerfile(opts = {}) {
        const info = this.projectInfo || { stack: 'nodejs', port: 3000, startScript: 'node index.js' };
        const stack = opts.stack || info.stack;
        const port  = opts.port  || info.port;

        const templates = {
            nodejs: `# Node.js Application
FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE ${port}
CMD ["node", "${info.startScript?.replace('node ', '') || 'index.js'}"]`,

            nextjs: `# Next.js Application
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
EXPOSE ${port}
CMD ["npm", "start"]`,

            react: `# React Application (static build)
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]`,

            flask: `# Flask Application
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE ${port}
CMD ["python", "app.py"]`,

            django: `# Django Application
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN python manage.py collectstatic --noinput
EXPOSE ${port}
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:${port}"]`,

            python: `# Python Application
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE ${port}
CMD ["python", "main.py"]`,

            go: `# Go Application
FROM golang:1.21-alpine AS build
WORKDIR /app
COPY go.* .
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o main .

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=build /app/main .
EXPOSE ${port}
CMD ["./main"]`,

            java: `# Java Application (Spring Boot)
FROM eclipse-temurin:21-jdk AS build
WORKDIR /app
COPY . .
RUN ./mvnw package -DskipTests

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
EXPOSE ${port}
CMD ["java", "-jar", "app.jar"]`,

            rust: `# Rust Application
FROM rust:1.75-alpine AS build
WORKDIR /app
COPY . .
RUN cargo build --release

FROM alpine:latest
WORKDIR /app
COPY --from=build /app/target/release/app .
EXPOSE ${port}
CMD ["./app"]`,

            flutter: `# Flutter Web Application
FROM cirrusci/flutter:stable AS build
WORKDIR /app
COPY . .
RUN flutter pub get
RUN flutter build web --release

FROM nginx:alpine
COPY --from=build /app/build/web /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]`
        };

        const content = templates[stack] || templates.nodejs;
        await this.writeFile('Dockerfile', content, 'dockerfile');
    }

    // ── docker-compose Generator ────────────────────────────────────────────
    async generateCompose(opts = {}) {
        const info = this.projectInfo || { name: 'app', stack: 'nodejs', port: 3000 };
        const svcName = (info.packageName || info.name || 'app').toLowerCase().replace(/[^a-z0-9]/g, '-');
        const port = opts.port || info.port;

        const content = `version: '3.9'

services:
  ${svcName}:
    build: .
    ports:
      - "${port}:${port}"
    environment:
      - NODE_ENV=production
    restart: unless-stopped
    networks:
      - app-network
    volumes:
      - app-data:/app/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:${port}/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  ${opts.withDB ? `postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: appdb
      POSTGRES_USER: admin
      POSTGRES_PASSWORD: \${DB_PASSWORD:-changeme}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      - app-network

  redis:
    image: redis:7-alpine
    networks:
      - app-network` : '# Uncomment to add PostgreSQL and Redis\n  # postgres: ...\n  # redis: ...'}

networks:
  app-network:
    driver: bridge

volumes:
  app-data:
  ${opts.withDB ? 'postgres-data:' : '# app-volumes here'}
`;
        await this.writeFile('docker-compose.yml', content, 'yaml');
    }

    // ── GitHub Actions Generator ────────────────────────────────────────────
    async generateGithubActions(opts = {}) {
        const info = this.projectInfo || { stack: 'nodejs', port: 3000 };
        const stack = opts.stack || info.stack;
        const isNode = ['nodejs', 'nextjs', 'react', 'vue'].includes(stack);
        const isPython = ['python', 'flask', 'django'].includes(stack);

        const content = `name: CI/CD Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

${isNode ? `      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint --if-present

      - name: Test
        run: npm test --if-present` : ''}
${isPython ? `      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install dependencies
        run: pip install -r requirements.txt

      - name: Test
        run: pytest --if-present` : ''}

  build-and-push:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Login to Docker Hub
        uses: docker/login-action@v3
        with:
          username: \${{ secrets.DOCKERHUB_USERNAME }}
          password: \${{ secrets.DOCKERHUB_TOKEN }}

      - name: Build and push Docker image
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: |
            \${{ secrets.DOCKERHUB_USERNAME }}/${info.name || 'app'}:latest
            \${{ secrets.DOCKERHUB_USERNAME }}/${info.name || 'app'}:\${{ github.sha }}

  deploy:
    needs: build-and-push
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    environment: production
    steps:
      - name: Deploy to server
        run: echo "Add your deploy step here (SSH, k8s, etc.)"
`;
        await this.writeFile('.github/workflows/ci-cd.yml', content, 'yaml', true);
    }

    // ── GitLab CI Generator ─────────────────────────────────────────────────
    async generateGitlabCI(opts = {}) {
        const info = this.projectInfo || { stack: 'nodejs' };
        const content = `stages:
  - test
  - build
  - deploy

variables:
  DOCKER_IMAGE: \${CI_REGISTRY_IMAGE}:\${CI_COMMIT_SHORT_SHA}

test:
  stage: test
  image: node:20-alpine
  script:
    - npm ci
    - npm test --if-present
  cache:
    paths:
      - node_modules/

build:
  stage: build
  image: docker:24
  services:
    - docker:24-dind
  before_script:
    - docker login -u \$CI_REGISTRY_USER -p \$CI_REGISTRY_PASSWORD \$CI_REGISTRY
  script:
    - docker build -t \$DOCKER_IMAGE .
    - docker push \$DOCKER_IMAGE
  only:
    - main

deploy:
  stage: deploy
  script:
    - echo "Add deployment steps here"
  only:
    - main
  environment:
    name: production
`;
        await this.writeFile('.gitlab-ci.yml', content, 'yaml');
    }

    // ── Kubernetes Generator ─────────────────────────────────────────────────
    async generateKubernetes(opts = {}) {
        const info = this.projectInfo || { name: 'app', port: 3000 };
        const appName = (info.name || 'app').toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const port    = info.port || 3000;

        const content = `# Kubernetes Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${appName}
  labels:
    app: ${appName}
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ${appName}
  template:
    metadata:
      labels:
        app: ${appName}
    spec:
      containers:
        - name: ${appName}
          image: your-registry/${appName}:latest
          ports:
            - containerPort: ${port}
          resources:
            requests:
              memory: "128Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
          livenessProbe:
            httpGet:
              path: /health
              port: ${port}
            initialDelaySeconds: 30
            periodSeconds: 10
          env:
            - name: NODE_ENV
              value: production
---
apiVersion: v1
kind: Service
metadata:
  name: ${appName}-service
spec:
  selector:
    app: ${appName}
  ports:
    - protocol: TCP
      port: 80
      targetPort: ${port}
  type: ClusterIP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${appName}-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
    - host: your-domain.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${appName}-service
                port:
                  number: 80
`;
        await this.writeFile('k8s/deployment.yaml', content, 'yaml', true);
    }

    // ── Nginx Config ────────────────────────────────────────────────────────
    async generateNginx(opts = {}) {
        const port = (this.projectInfo?.port || 3000);
        const content = `server {
    listen 80;
    server_name your-domain.com;

    # Redirect HTTP to HTTPS
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/ssl/certs/your-cert.pem;
    ssl_certificate_key /etc/ssl/private/your-key.pem;

    # Proxy to app
    location / {
        proxy_pass http://localhost:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }

    # Static files cache
    location ~* \\.(jpg|jpeg|png|gif|ico|css|js)\$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-XSS-Protection "1; mode=block";
    add_header X-Content-Type-Options "nosniff";
}
`;
        await this.writeFile('nginx.conf', content, 'nginx');
    }

    // ── AI-powered generation ───────────────────────────────────────────────
    async aiGenerate(prompt, type) {
        this.panel.webview.postMessage({ type: 'aiGenerating', fileType: type });
        try {
            const r = await axios.post('http://localhost:6000/infer', {
                message: prompt, max_tokens: 512
            }, { timeout: 60000 });
            const content = r.data.reply || '';
            // Extract code block if present
            const codeMatch = content.match(/```[\w]*\n([\s\S]*?)```/);
            const code = codeMatch ? codeMatch[1] : content;
            this.panel.webview.postMessage({ type: 'aiResult', content: code, fileType: type });
        } catch (e) {
            this.panel.webview.postMessage({ type: 'aiError', text: e.message });
        }
    }

    // ── File writing ─────────────────────────────────────────────────────────
    async writeFile(relativePath, content, lang, mkdir = false) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            vscode.window.showWarningMessage('Aucun workspace ouvert');
            return;
        }

        const fullPath = path.join(folder.uri.fsPath, relativePath);

        // Create directories if needed
        if (mkdir) {
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        }

        // Check if file exists
        if (fs.existsSync(fullPath)) {
            const answer = await vscode.window.showWarningMessage(
                `${relativePath} existe déjà. Écraser?`,
                'Oui', 'Annuler'
            );
            if (answer !== 'Oui') {
                this.panel.webview.postMessage({ type: 'fileCancelled', file: relativePath });
                return;
            }
        }

        fs.writeFileSync(fullPath, content, 'utf8');

        // Open file in editor
        const doc = await vscode.workspace.openTextDocument(fullPath);
        await vscode.window.showTextDocument(doc);

        this.panel.webview.postMessage({
            type: 'fileGenerated',
            file: relativePath,
            fullPath
        });

        vscode.window.showInformationMessage(
            `✅ ${relativePath} généré avec succès!`,
            'Voir le fichier'
        ).then(sel => {
            if (sel === 'Voir le fichier') vscode.workspace.openTextDocument(fullPath).then(d => vscode.window.showTextDocument(d));
        });
    }

    async openFile(filePath) {
        try {
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc);
        } catch (e) {}
    }

    dispose() {
        DevOpsPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) d.dispose();
        }
    }

    getHtmlContent() {
        return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DevOps Automation</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);min-height:100vh}
#header{background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border);padding:14px 18px;display:flex;align-items:center;justify-content:space-between}
#header h1{font-size:17px;font-weight:600}
.btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:8px 15px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;transition:opacity .2s;white-space:nowrap}
.btn:hover{opacity:.85} .btn:disabled{opacity:.4;cursor:not-allowed}
.btn-sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.btn-sm{padding:5px 10px;font-size:12px}
#content{padding:16px 18px;display:flex;flex-direction:column;gap:16px}
.project-bar{background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);border-radius:8px;padding:12px 14px;display:flex;align-items:center;gap:10px}
.stack-badge{padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;background:rgba(99,102,241,.2);color:#818cf8}
.section{background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);border-radius:10px;padding:14px 16px}
.section-title{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground);margin-bottom:12px}
.gen-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.gen-card{background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-panel-border);border-radius:8px;padding:12px;cursor:pointer;transition:border-color .2s,transform .2s;text-align:center}
.gen-card:hover{border-color:var(--vscode-focusBorder);transform:translateY(-2px)}
.gen-card .icon{font-size:28px;margin-bottom:6px}
.gen-card .name{font-size:13px;font-weight:600;margin-bottom:3px}
.gen-card .desc{font-size:11px;color:var(--vscode-descriptionForeground)}
.gen-card.busy{opacity:.6;cursor:not-allowed}
#aiSection{display:flex;gap:8px;margin-top:12px}
#aiInput{flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:6px;padding:8px 10px;font-size:13px;font-family:inherit}
#aiInput:focus{outline:none;border-color:var(--vscode-focusBorder)}
#statusMsg{padding:8px 12px;border-radius:6px;font-size:12px;margin-top:8px;display:none}
#statusMsg.show{display:block}
#statusMsg.success{background:rgba(76,175,80,.1);color:#4caf50;border:1px solid rgba(76,175,80,.3)}
#statusMsg.error{background:rgba(244,67,54,.1);color:#f44336;border:1px solid rgba(244,67,54,.3)}
#statusMsg.info{background:rgba(33,150,243,.1);color:#2196f3;border:1px solid rgba(33,150,243,.3)}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background);border-radius:3px}
</style>
</head>
<body>
<div id="header">
    <div>
        <h1>🚀 DevOps Automation</h1>
        <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px">Génération automatique de fichiers DevOps</div>
    </div>
    <button class="btn btn-sec btn-sm" onclick="vscPost({type:'refreshProject'})">🔍 Détecter Projet</button>
</div>

<div id="content">
    <!-- Project info -->
    <div class="project-bar" id="projectBar">
        <span style="font-size:18px">📁</span>
        <div style="flex:1">
            <div id="projectName" style="font-weight:600;font-size:13px">Aucun workspace ouvert</div>
            <div id="projectPath" style="font-size:11px;color:var(--vscode-descriptionForeground)">Ouvrez un dossier dans VSCode</div>
        </div>
        <span class="stack-badge" id="stackBadge">?</span>
    </div>

    <div id="statusMsg"></div>

    <!-- Docker Section -->
    <div class="section">
        <div class="section-title">🐳 Docker</div>
        <div class="gen-grid">
            <div class="gen-card" onclick="generate('generateDockerfile')">
                <div class="icon">🐳</div>
                <div class="name">Dockerfile</div>
                <div class="desc">Image optimisée multi-stage selon votre stack</div>
            </div>
            <div class="gen-card" onclick="generate('generateCompose')">
                <div class="icon">🔧</div>
                <div class="name">docker-compose.yml</div>
                <div class="desc">Services, volumes, réseaux configurés</div>
            </div>
            <div class="gen-card" onclick="generate('generateCompose', {withDB:true})">
                <div class="icon">🗄️</div>
                <div class="name">compose + DB</div>
                <div class="desc">Avec PostgreSQL + Redis inclus</div>
            </div>
            <div class="gen-card" onclick="generate('generateNginx')">
                <div class="icon">⚡</div>
                <div class="name">nginx.conf</div>
                <div class="desc">Reverse proxy avec SSL, cache, headers</div>
            </div>
        </div>
    </div>

    <!-- CI/CD Section -->
    <div class="section">
        <div class="section-title">⚙️ CI/CD Pipelines</div>
        <div class="gen-grid">
            <div class="gen-card" onclick="generate('generateGithubActions')">
                <div class="icon">🐙</div>
                <div class="name">GitHub Actions</div>
                <div class="desc">Test → Build → Deploy automatique</div>
            </div>
            <div class="gen-card" onclick="generate('generateGitlabCI')">
                <div class="icon">🦊</div>
                <div class="name">GitLab CI/CD</div>
                <div class="desc">Pipeline .gitlab-ci.yml complet</div>
            </div>
        </div>
    </div>

    <!-- Kubernetes Section -->
    <div class="section">
        <div class="section-title">☸️ Kubernetes</div>
        <div class="gen-grid">
            <div class="gen-card" onclick="generate('generateKubernetes')">
                <div class="icon">☸️</div>
                <div class="name">k8s/deployment.yaml</div>
                <div class="desc">Deployment + Service + Ingress complet</div>
            </div>
        </div>
    </div>

    <!-- AI Generate Section -->
    <div class="section">
        <div class="section-title">🤖 Génération IA Personnalisée</div>
        <div style="font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:10px">
            Décrivez ce que vous voulez générer. Nécessite le runtime IA (port 6000).
        </div>
        <div id="aiSection">
            <input id="aiInput" placeholder="Ex: Génère un Dockerfile optimisé pour une app FastAPI avec Uvicorn..." />
            <button class="btn btn-sm" onclick="aiGen()">🤖 Générer</button>
        </div>
        <div id="aiResult" style="display:none;margin-top:10px;background:var(--vscode-textCodeBlock-background);padding:10px;border-radius:6px;font-family:monospace;font-size:11px;max-height:300px;overflow:auto;white-space:pre-wrap"></div>
    </div>
</div>

<script>
const vscode = acquireVsCodeApi();
function vscPost(m) { vscode.postMessage(m); }

function generate(type, opts) {
    const card = event.currentTarget;
    card.classList.add('busy');
    vscPost({ type, opts: opts || {} });
    setTimeout(() => card.classList.remove('busy'), 3000);
}

function aiGen() {
    const prompt = document.getElementById('aiInput').value.trim();
    if (!prompt) return;
    showStatus('🤖 Génération en cours...', 'info');
    document.getElementById('aiResult').style.display = 'none';
    vscPost({ type: 'aiGenerate', prompt, fileType: 'generic' });
}

function showStatus(msg, type) {
    const el = document.getElementById('statusMsg');
    el.textContent = msg;
    el.className = 'show ' + type;
    setTimeout(() => el.classList.remove('show'), 6000);
}

window.addEventListener('message', ev => {
    const m = ev.data;
    switch(m.type) {
        case 'projectDetected': {
            const i = m.info;
            document.getElementById('projectName').textContent = i.name || 'Projet';
            document.getElementById('projectPath').textContent = i.root || '';
            document.getElementById('stackBadge').textContent = i.stack || '?';
            break;
        }
        case 'noWorkspace':
            document.getElementById('projectName').textContent = 'Aucun workspace ouvert';
            document.getElementById('stackBadge').textContent = '?';
            break;
        case 'fileGenerated':
            showStatus('✅ ' + m.file + ' généré avec succès!', 'success');
            break;
        case 'fileCancelled':
            showStatus('ℹ️ Annulé: ' + m.file, 'info');
            break;
        case 'aiGenerating':
            showStatus('🤖 Génération IA...', 'info');
            break;
        case 'aiResult': {
            const box = document.getElementById('aiResult');
            box.textContent = m.content;
            box.style.display = 'block';
            showStatus('✅ Résultat IA généré', 'success');
            break;
        }
        case 'aiError':
            showStatus('❌ Erreur IA: ' + m.text + ' — Assurez-vous que le runtime est lancé', 'error');
            break;
    }
});
</script>
</body>
</html>`;
    }
}

module.exports = { DevOpsPanel };
