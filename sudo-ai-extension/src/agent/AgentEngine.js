/**
 * SUDO STUDIO — AgentEngine v3.0 (Mission Finale)
 * ─────────────────────────────────────────────────────────────────────────────
 * Full-stack autonomous agent: reads, writes, runs commands, scaffolds apps,
 * and drives ALL Sudo Studio features as first-class agent tools.
 *
 * New in v3.0 vs v2.0:
 *   PROB 1 — Real workspace writes + no-workspace guard + hallucination guard
 *     • write_file always resolves to workspace root (not cwd)
 *     • If no workspace open → clear actionable message, offer "Open Folder"
 *     • Hallucination guard: git clone to unrelated URL → reject + log
 *
 *   PROB 2 — Full app scaffolding
 *     • Detects scaffold request (Flutter/React/Express/Python/FastAPI/Next.js…)
 *     • Generates full project structure (all dirs + files with real content)
 *     • Shows final file-tree in the panel
 *
 *   PROB 3 — Agent Master: ALL Sudo Studio features as agent tools
 *     • TOOL: sdk_analyze    — detect missing SDKs for the project
 *     • TOOL: sdk_install    — install a specific SDK (triggers SDKPanel logic)
 *     • TOOL: doctor_run     — run Doctor diagnostics
 *     • TOOL: autofix_apply  — apply an AutoFix suggestion
 *     • TOOL: cicd_generate  — generate Dockerfile/docker-compose/GH Actions
 *     • TOOL: security_audit — scan for secrets + vuln report
 *     • TOOL: chat_query     — query the AI model directly for sub-reasoning
 *
 *   SYSTEM PROMPT now lists all tools including the 7 Sudo Studio tools.
 *   parseStepToTool() handles all 14 tool types.
 *   Every tool emits structured logs: stdout/stderr/exitCode visible in panel.
 */

'use strict';

const EventEmitter = require('events');
const fs           = require('fs');
const path         = require('path');
const { exec }     = require('child_process');
const axios        = require('axios');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const MAX_ITERATIONS  = 14;
const CMD_TIMEOUT_MS  = 60000;
const AI_TIMEOUT_MS   = 120000;
const AGENT_STATE_DIR = '.sudo/agent';
const MCP_CONFIG_FILE = '.sudo/mcp.json';

// Dangerous command patterns — require user approval before execution
const DANGEROUS_PATTERNS = [
    /git\s+reset\s+--hard/i,
    /git\s+clean\s+-f/i,
    /git\s+push\s+--force/i,
    /rm\s+-rf\s+\//i,
    /del\s+\/f\s+\/s\s+\/q/i,
    /format\s+[a-z]:/i,
    /DROP\s+TABLE/i,
    /kubectl\s+delete\s+namespace/i,
    /shutdown/i,
    /mkfs/i,
];

// ─── TOOL-CALL SANITIZERS ─────────────────────────────────────────────────────
/**
 * PROB 1 FIX: Small models (1.5B) sometimes copy the label "CMD: " or "cmd: "
 * verbatim into the value when generating a run_command tool call.
 * This strips those residual prefixes before execution.
 *
 * Examples of what gets caught:
 *   "CMD: python main.py"    → "python main.py"
 *   "cmd:python main.py"     → "python main.py"
 *   "COMMAND: node index.js" → "node index.js"
 */
function _sanitizeCmd(cmd) {
    if (!cmd || typeof cmd !== 'string') return '';
    // Strip leading CMD:/cmd:/COMMAND: prefixes (case-insensitive, optional space)
    cmd = cmd.replace(/^(?:CMD|cmd|COMMAND|command)\s*:\s*/i, '').trim();
    return cmd;
}

/**
 * PROB 1 FIX: Small models sometimes copy "file: " prefix into the FILE: value.
 *
 * Examples:
 *   "file: calculator.py"  → "calculator.py"
 *   "FILE:calculator.py"   → "calculator.py"
 *   "file:"                → '' (empty → will be rejected upstream)
 */
function _sanitizeFilePath(fp) {
    if (!fp || typeof fp !== 'string') return '';
    // Strip leading file:/FILE: prefix
    fp = fp.replace(/^(?:file|FILE)\s*:\s*/i, '').trim();
    // Reject obviously invalid paths (pure 'file:' with nothing after, or just ':')
    if (fp === '' || fp === ':') return '';
    return fp;
}

// ─── HALLUCINATION GUARD ──────────────────────────────────────────────────────
/**
 * Detects git clone commands pointing to URLs that are clearly unrelated to
 * the user's task. Returns { suspect: bool, reason: string }.
 * Called BEFORE executing any run_command.
 */
function hallucinationGuard(cmd, task) {
    // Only inspect git clone
    const cloneMatch = cmd.match(/git\s+clone\s+(\S+)/i);
    if (!cloneMatch) return { suspect: false };

    const url = cloneMatch[1].toLowerCase();
    const taskWords = task.toLowerCase()
        .split(/\W+/)
        .filter(w => w.length > 3);

    // Extract repo name from URL
    const urlParts = url.split('/').filter(Boolean);
    const repoName = (urlParts[urlParts.length - 1] || '').replace(/\.git$/, '').toLowerCase();

    // If any meaningful task word appears in the URL, it's probably legitimate
    const relevant = taskWords.some(w => url.includes(w) || repoName.includes(w));
    if (relevant) return { suspect: false };

    // Known-safe clone targets (Sudo Studio own repos)
    const knownSafe = ['sudo-studio', 'sudostudio', 'juleszackaria', 'sudo-ai'];
    if (knownSafe.some(s => url.includes(s))) return { suspect: false };

    // If URL doesn't mention anything from the task → suspect hallucination
    return {
        suspect: true,
        reason: `git clone d'un dépôt sans rapport avec la tâche ("${url}" ne correspond à aucun mot-clé de "${task.slice(0, 60)}")`
    };
}

// ─── SCAFFOLDING TEMPLATES ────────────────────────────────────────────────────
/**
 * Detects if a task is asking to scaffold a complete application,
 * and returns the file-map { 'path': 'content' } for the project.
 */
function detectScaffold(task, projectRoot) {
    const t = task.toLowerCase();

    // Flutter
    if (/\bflutter\b/i.test(t) && /\b(app|application|projet|project|crée|create|scaffold|nouveau|new)\b/i.test(t)) {
        const appName = (task.match(/\b([a-z][a-z0-9_]+)\b/g) || [])
            .find(w => !['flutter','create','app','new','une','un','un','une','crée','créer'].includes(w)) || 'my_app';
        return buildFlutterScaffold(appName);
    }

    // React
    if (/\breact\b/i.test(t) && /\b(app|application|projet|project|crée|create|scaffold|nouveau|new)\b/i.test(t)) {
        return buildReactScaffold();
    }

    // Next.js
    if (/\bnext\.?js\b/i.test(t) && /\b(app|application|projet|project|crée|create|scaffold|nouveau|new)\b/i.test(t)) {
        return buildNextJsScaffold();
    }

    // Express / Node API
    if (/\b(express|node.?api|nodejs.?api|rest.?api)\b/i.test(t) && /\b(app|application|projet|project|crée|create|scaffold|nouveau|new|api)\b/i.test(t)) {
        return buildExpressScaffold();
    }

    // FastAPI / Python API
    if (/\b(fastapi|flask|python.?api)\b/i.test(t) && /\b(app|application|projet|project|crée|create|scaffold|nouveau|new|api)\b/i.test(t)) {
        return buildFastAPIScaffold();
    }

    // Vue.js
    if (/\bvue\.?js\b/i.test(t) && /\b(app|application|projet|project|crée|create|scaffold|nouveau|new)\b/i.test(t)) {
        return buildVueScaffold();
    }

    return null;  // not a scaffold request
}

function buildFlutterScaffold(appName) {
    return {
        title: `Flutter App: ${appName}`,
        files: {
            'pubspec.yaml': `name: ${appName}
description: A Flutter application.
version: 1.0.0+1

environment:
  sdk: ">=3.0.0 <4.0.0"

dependencies:
  flutter:
    sdk: flutter
  cupertino_icons: ^1.0.2
  http: ^1.1.0

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^3.0.0

flutter:
  uses-material-design: true
`,
            'lib/main.dart': `import 'package:flutter/material.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '${appName}',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.deepPurple),
        useMaterial3: true,
      ),
      home: const HomePage(),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  int _counter = 0;

  void _incrementCounter() {
    setState(() { _counter++; });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
        title: const Text('${appName}'),
      ),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Text('Vous avez appuyé sur le bouton :'),
            Text('\$_counter', style: Theme.of(context).textTheme.headlineMedium),
          ],
        ),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _incrementCounter,
        tooltip: 'Incrémenter',
        child: const Icon(Icons.add),
      ),
    );
  }
}
`,
            'lib/screens/home_screen.dart': `import 'package:flutter/material.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(child: Text('Home Screen')),
    );
  }
}
`,
            'lib/widgets/app_button.dart': `import 'package:flutter/material.dart';

class AppButton extends StatelessWidget {
  final String label;
  final VoidCallback onPressed;
  final Color? color;

  const AppButton({super.key, required this.label, required this.onPressed, this.color});

  @override
  Widget build(BuildContext context) {
    return ElevatedButton(
      style: ElevatedButton.styleFrom(backgroundColor: color),
      onPressed: onPressed,
      child: Text(label),
    );
  }
}
`,
            'test/widget_test.dart': `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:${appName}/main.dart';

void main() {
  testWidgets('Counter increments smoke test', (WidgetTester tester) async {
    await tester.pumpWidget(const MyApp());
    expect(find.text('0'), findsOneWidget);
    await tester.tap(find.byIcon(Icons.add));
    await tester.pump();
    expect(find.text('1'), findsOneWidget);
  });
}
`,
            '.gitignore': `.dart_tool/
.flutter-plugins
.flutter-plugins-dependencies
.packages
.pub-cache/
.pub/
/build/
`,
            'README.md': `# ${appName}

Application Flutter générée par Sudo Studio Agent.

## Démarrage rapide

\`\`\`bash
flutter pub get
flutter run
\`\`\`

## Tests

\`\`\`bash
flutter test
\`\`\`
`,
        }
    };
}

function buildReactScaffold() {
    return {
        title: 'React App (Vite + TypeScript)',
        files: {
            'package.json': JSON.stringify({
                name: 'react-app',
                version: '0.1.0',
                private: true,
                scripts: { dev: 'vite', build: 'tsc && vite build', preview: 'vite preview', test: 'vitest' },
                dependencies: { react: '^18.2.0', 'react-dom': '^18.2.0' },
                devDependencies: { '@types/react': '^18.2.0', '@types/react-dom': '^18.2.0', '@vitejs/plugin-react': '^4.0.0', typescript: '^5.0.0', vite: '^5.0.0', vitest: '^1.0.0' }
            }, null, 2),
            'index.html': `<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>React App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
            'src/main.tsx': `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`,
            'src/App.tsx': `import { useState } from 'react';
import './App.css';

function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="app">
      <h1>React App</h1>
      <p>Généré par Sudo Studio Agent</p>
      <button onClick={() => setCount(c => c + 1)}>
        Compteur: {count}
      </button>
    </div>
  );
}

export default App;
`,
            'src/index.css': `body { margin: 0; font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; }
.app { max-width: 800px; margin: 0 auto; padding: 2rem; text-align: center; }
button { padding: 0.8rem 1.5rem; background: #1f6feb; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 1rem; }
button:hover { background: #388bfd; }
`,
            'src/App.css': '',
            'vite.config.ts': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: { globals: true, environment: 'jsdom' },
});
`,
            'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2020', lib: ['ES2020', 'DOM', 'DOM.Iterable'], module: 'ESNext', skipLibCheck: true, moduleResolution: 'bundler', resolveJsonModule: true, isolatedModules: true, noEmit: true, jsx: 'react-jsx', strict: true }, include: ['src'] }, null, 2),
            '.gitignore': `node_modules/\ndist/\n.env\n`,
            'README.md': `# React App\n\nGénéré par Sudo Studio Agent.\n\n## Démarrage\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`
        }
    };
}

function buildExpressScaffold() {
    return {
        title: 'Node.js / Express REST API',
        files: {
            'package.json': JSON.stringify({
                name: 'express-api',
                version: '1.0.0',
                main: 'src/index.js',
                scripts: { start: 'node src/index.js', dev: 'nodemon src/index.js', test: 'jest --passWithNoTests' },
                dependencies: { express: '^4.18.2', cors: '^2.8.5', dotenv: '^16.0.0', morgan: '^1.10.0' },
                devDependencies: { nodemon: '^3.0.0', jest: '^29.0.0' }
            }, null, 2),
            'src/index.js': `require('dotenv').config();
const app    = require('./app');
const PORT   = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(\`[SERVER] Listening on port \${PORT}\`);
});
`,
            'src/app.js': `const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');

const itemsRouter = require('./routes/items');

const app = express();
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));
app.use('/api/items', itemsRouter);

// 404 handler
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, _req, res, _next) => {
    console.error('[ERROR]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

module.exports = app;
`,
            'src/routes/items.js': `const express = require('express');
const router  = express.Router();
const { getAll, getById, create, update, remove } = require('../controllers/items.controller');

router.get('/',      getAll);
router.get('/:id',   getById);
router.post('/',     create);
router.put('/:id',   update);
router.delete('/:id', remove);

module.exports = router;
`,
            'src/controllers/items.controller.js': `// In-memory store — replace with a real DB (Prisma, Mongoose…)
let items = [{ id: 1, name: 'Example item', createdAt: new Date().toISOString() }];
let nextId = 2;

exports.getAll   = (_req, res) => res.json({ items });
exports.getById  = (req, res) => {
    const item = items.find(i => i.id === Number(req.params.id));
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
};
exports.create   = (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const item = { id: nextId++, name, createdAt: new Date().toISOString() };
    items.push(item);
    res.status(201).json(item);
};
exports.update   = (req, res) => {
    const idx = items.findIndex(i => i.id === Number(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    items[idx] = { ...items[idx], ...req.body, id: items[idx].id };
    res.json(items[idx]);
};
exports.remove   = (req, res) => {
    items = items.filter(i => i.id !== Number(req.params.id));
    res.status(204).end();
};
`,
            'src/middleware/errorHandler.js': `module.exports = (err, _req, res, _next) => {
    const status = err.status || 500;
    const message = status < 500 ? err.message : 'Internal Server Error';
    res.status(status).json({ error: message });
};
`,
            '.env.example': `PORT=3000\nNODE_ENV=development\n`,
            '.gitignore': `node_modules/\n.env\n`,
            'README.md': `# Express REST API\n\nGénéré par Sudo Studio Agent.\n\n## Démarrage\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n\n## Endpoints\n\n- \`GET /health\` — Health check\n- \`GET /api/items\` — Liste\n- \`GET /api/items/:id\` — Détail\n- \`POST /api/items\` — Créer\n- \`PUT /api/items/:id\` — Modifier\n- \`DELETE /api/items/:id\` — Supprimer\n`
        }
    };
}

function buildFastAPIScaffold() {
    return {
        title: 'Python FastAPI REST API',
        files: {
            'requirements.txt': `fastapi>=0.104.0\nuvicorn[standard]>=0.24.0\npydantic>=2.0.0\npython-dotenv>=1.0.0\nhttpx>=0.25.0\npytest>=7.0.0\nhttpx>=0.25.0\n`,
            'main.py': `from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from app.routers import items

load_dotenv()

app = FastAPI(title="Sudo Studio API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(items.router, prefix="/api/items", tags=["items"])


@app.get("/health")
def health_check():
    return {"status": "ok"}
`,
            'app/__init__.py': '',
            'app/routers/__init__.py': '',
            'app/routers/items.py': `from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional

router = APIRouter()

class Item(BaseModel):
    id: Optional[int] = None
    name: str
    description: Optional[str] = None

# In-memory store — replace with SQLAlchemy for production
_items: List[dict] = [{"id": 1, "name": "Example item", "description": "Sample"}]
_next_id = 2


@router.get("/", response_model=List[Item])
def get_items():
    return _items


@router.get("/{item_id}", response_model=Item)
def get_item(item_id: int):
    item = next((i for i in _items if i["id"] == item_id), None)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    return item


@router.post("/", response_model=Item, status_code=201)
def create_item(item: Item):
    global _next_id
    new_item = item.model_dump()
    new_item["id"] = _next_id
    _next_id += 1
    _items.append(new_item)
    return new_item


@router.put("/{item_id}", response_model=Item)
def update_item(item_id: int, item: Item):
    idx = next((i for i, x in enumerate(_items) if x["id"] == item_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Item not found")
    updated = {**_items[idx], **item.model_dump(exclude_unset=True), "id": item_id}
    _items[idx] = updated
    return updated


@router.delete("/{item_id}", status_code=204)
def delete_item(item_id: int):
    global _items
    _items = [i for i in _items if i["id"] != item_id]
`,
            'tests/__init__.py': '',
            'tests/test_items.py': `from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_get_items():
    r = client.get("/api/items/")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_create_item():
    r = client.post("/api/items/", json={"name": "Test item"})
    assert r.status_code == 201
    assert r.json()["name"] == "Test item"
`,
            '.env.example': `PORT=8000\nENVIRONMENT=development\n`,
            '.gitignore': `__pycache__/\n*.pyc\n.env\nvenv/\n.venv/\n`,
            'README.md': `# FastAPI REST API\n\nGénéré par Sudo Studio Agent.\n\n## Démarrage\n\n\`\`\`bash\npip install -r requirements.txt\nuvicorn main:app --reload\n\`\`\`\n\n## Tests\n\n\`\`\`bash\npytest\n\`\`\`\n`
        }
    };
}

function buildNextJsScaffold() {
    return {
        title: 'Next.js 14 App Router',
        files: {
            'package.json': JSON.stringify({
                name: 'nextjs-app', version: '0.1.0', private: true,
                scripts: { dev: 'next dev', build: 'next build', start: 'next start', lint: 'next lint' },
                dependencies: { next: '^14.0.0', react: '^18.2.0', 'react-dom': '^18.2.0' },
                devDependencies: { typescript: '^5.0.0', '@types/node': '^20.0.0', '@types/react': '^18.2.0', '@types/react-dom': '^18.2.0', eslint: '^8.0.0', 'eslint-config-next': '^14.0.0' }
            }, null, 2),
            'app/layout.tsx': `import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Next.js App',
  description: 'Généré par Sudo Studio Agent',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
`,
            'app/page.tsx': `export default function Home() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui', background: '#0d1117', minHeight: '100vh', color: '#e6edf3' }}>
      <h1>Next.js App</h1>
      <p>Généré par Sudo Studio Agent.</p>
    </main>
  );
}
`,
            'app/api/health/route.ts': `import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ status: 'ok', ts: Date.now() });
}
`,
            'next.config.js': `/** @type {import('next').NextConfig} */\nconst nextConfig = {};\nmodule.exports = nextConfig;\n`,
            'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2017', lib: ['dom', 'dom.iterable', 'esnext'], allowJs: true, skipLibCheck: true, strict: true, noEmit: true, incremental: true, esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler', resolveJsonModule: true, isolatedModules: true, jsx: 'preserve', paths: { '@/*': ['./*'] } }, include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'], exclude: ['node_modules'] }, null, 2),
            '.gitignore': `/node_modules\n/.next\n/out\n.env\n`,
            'README.md': `# Next.js App\n\nGénéré par Sudo Studio Agent.\n\n## Démarrage\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`
        }
    };
}

function buildVueScaffold() {
    return {
        title: 'Vue 3 + Vite App',
        files: {
            'package.json': JSON.stringify({
                name: 'vue-app', version: '0.1.0', private: true,
                scripts: { dev: 'vite', build: 'vue-tsc && vite build', preview: 'vite preview' },
                dependencies: { vue: '^3.3.0', 'vue-router': '^4.2.0' },
                devDependencies: { '@vitejs/plugin-vue': '^4.2.0', vite: '^5.0.0', 'vue-tsc': '^1.8.0', typescript: '^5.0.0' }
            }, null, 2),
            'index.html': `<!DOCTYPE html>\n<html lang="fr">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>Vue App</title>\n  </head>\n  <body>\n    <div id="app"></div>\n    <script type="module" src="/src/main.ts"></script>\n  </body>\n</html>\n`,
            'src/main.ts': `import { createApp } from 'vue';\nimport App from './App.vue';\n\ncreateApp(App).mount('#app');\n`,
            'src/App.vue': `<template>\n  <div class="app">\n    <h1>Vue App</h1>\n    <p>Généré par Sudo Studio Agent</p>\n    <button @click="count++">Compteur: {{ count }}</button>\n  </div>\n</template>\n\n<script setup lang="ts">\nimport { ref } from 'vue';\nconst count = ref(0);\n</script>\n\n<style scoped>\n.app { text-align: center; padding: 2rem; background: #0d1117; min-height: 100vh; color: #e6edf3; }\nbutton { padding: 0.8rem 1.5rem; background: #1f6feb; color: white; border: none; border-radius: 8px; cursor: pointer; }\n</style>\n`,
            'vite.config.ts': `import { defineConfig } from 'vite';\nimport vue from '@vitejs/plugin-vue';\nexport default defineConfig({ plugins: [vue()] });\n`,
            '.gitignore': `node_modules/\ndist/\n.env\n`,
            'README.md': `# Vue 3 App\n\nGénéré par Sudo Studio Agent.\n\n## Démarrage\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`
        }
    };
}

/** Build an ASCII tree from a file-map */
function buildFileTree(files, title) {
    const paths = Object.keys(files).sort();
    const tree = [title || 'Projet créé :'];
    const seen = new Set();
    for (const p of paths) {
        const parts = p.split('/');
        parts.forEach((part, i) => {
            const key = parts.slice(0, i + 1).join('/');
            if (!seen.has(key)) {
                seen.add(key);
                const indent = '  '.repeat(i);
                const isFile = (i === parts.length - 1);
                tree.push(`${indent}${isFile ? '📄' : '📁'} ${part}`);
            }
        });
    }
    return tree.join('\n');
}

// ─── AGENT SYSTEM PROMPT ──────────────────────────────────────────────────────
const AGENT_SYSTEM_PROMPT = `Tu es Sudo Agent v3.0, un agent de programmation autonome, précis et expert intégré dans Sudo Studio.

Tu travailles en mode agentique : chaque étape produit une ACTION CONCRÈTE que tu exécutes, observes, puis adaptes si nécessaire.

OUTILS DISPONIBLES (utilise EXACTEMENT ces formats JSON — PAS de préfixe texte dans les valeurs) :

OUTILS STANDARD :
1. TOOL: write_file\nFILE: calculator.py\nCONTENT:\ndef add(a, b):\n    return a + b
2. TOOL: run_command\nCMD: python calculator.py
3. TOOL: read_file\nFILE: main.py
4. TOOL: edit_file\nFILE: app.py\nOLD: old_text\nNEW: new_text
5. TOOL: search_code\nPATTERN: def main\nDIR: .
6. TOOL: git\nCMD: status

ATTENTION: Dans CMD, écris la commande DIRECTEMENT, pas "CMD: python..." mais juste "python..."
ATTENTION: Dans FILE, écris le chemin DIRECTEMENT, pas "file: calculator.py" mais juste "calculator.py"

OUTILS SUDO STUDIO (fonctionnalités propriétaires) :
7. TOOL: sdk_analyze\nPROJECT: <type_projet ou auto>
8. TOOL: sdk_install\nSDK: <nom_sdk ex: flutter, node, python, docker>
9. TOOL: doctor_run
10. TOOL: autofix_apply\nFILE: <fichier optionnel>
11. TOOL: cicd_generate\nTARGET: <github_actions|dockerfile|docker_compose|kubernetes>
12. TOOL: security_audit\nSCOPE: <all|secrets|deps|gitignore>
13. TOOL: chat_query\nQUESTION: <question pour le modèle IA>

RÈGLES ABSOLUES :
- Le code produit doit être COMPLET et FONCTIONNEL dans le bon langage demandé.
- Si la tâche dit "Dart", écris du vrai Dart. Si "Python", du vrai Python.
- Après chaque action, observe le résultat et adapte ton approche si nécessaire.
- Ne jamais marquer une étape comme réussie si le résultat contient une erreur.
- Pour git clone : n'exécute JAMAIS un clone d'un dépôt sans rapport avec la tâche demandée.`;

// ─── AGENT STATE ──────────────────────────────────────────────────────────────
class AgentState {
    constructor(task, projectRoot) {
        this.task              = task;
        this.projectRoot       = projectRoot;
        this.currentPlan       = [];
        this.currentStep       = 0;
        this.filesRead         = [];
        this.filesModified     = [];
        this.commandsExecuted  = [];
        this.testResults       = [];
        this.errors            = [];
        this.iteration         = 0;
        this.finalStatus       = 'running';
        this.startedAt         = Date.now();
        this.stoppedByUser     = false;
        this.logs              = [];
        this._projectContext   = '';
        this._toolResults      = [];
    }

    log(msg) {
        const ts = new Date().toISOString().slice(11, 23);
        const entry = `[${ts}] ${msg}`;
        this.logs.push(entry);
        console.log('[AGENT]', entry);
    }

    addToolResult(tool, args, result) {
        const entry = { tool, args: JSON.stringify(args).slice(0, 100), result: String(result).slice(0, 500) };
        this._toolResults.push(entry);
        if (this._toolResults.length > 8) this._toolResults.shift();
    }

    getToolResultContext() {
        return this._toolResults.map(r =>
            `[${r.tool}] args=${r.args} → ${r.result}`
        ).join('\n');
    }

    toSummary() {
        return {
            task:           this.task,
            status:         this.finalStatus,
            iteration:      this.iteration,
            filesModified:  this.filesModified,
            commandsRun:    this.commandsExecuted.map(c => c.cmd),
            testResults:    this.testResults,
            errors:         this.errors,
            durationMs:     Date.now() - this.startedAt,
            logs:           this.logs.slice(-50),
        };
    }

    persist(projectRoot) {
        try {
            const dir = path.join(projectRoot, AGENT_STATE_DIR, 'sessions');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `session_${this.startedAt}.json`);
            fs.writeFileSync(file, JSON.stringify(this.toSummary(), null, 2), 'utf8');
        } catch (_) { /* non-fatal */ }
    }
}

// ─── FILE TOOL ────────────────────────────────────────────────────────────────
class FileTool {
    constructor(projectRoot) {
        this.root = projectRoot;
    }

    _resolve(filePath) {
        if (path.isAbsolute(filePath)) return filePath;
        return path.join(this.root, filePath);
    }

    readFile(filePath) {
        const abs = this._resolve(filePath);
        if (!fs.existsSync(abs)) return { ok: false, error: `File not found: ${filePath}` };
        try {
            const content = fs.readFileSync(abs, 'utf8');
            return { ok: true, content, lines: content.split('\n').length, bytes: content.length };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    writeFile(filePath, content) {
        const abs = this._resolve(filePath);
        try {
            const dir = path.dirname(abs);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            if (fs.existsSync(abs)) {
                fs.writeFileSync(abs + '.sudo_bak', fs.readFileSync(abs));
            }
            fs.writeFileSync(abs, content, 'utf8');
            return { ok: true, path: filePath, abs };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    editFile(filePath, oldText, newText) {
        const r = this.readFile(filePath);
        if (!r.ok) return r;
        if (!r.content.includes(oldText)) {
            return { ok: false, error: `Pattern not found in ${filePath}: "${oldText.slice(0, 80)}"` };
        }
        const newContent = r.content.replace(oldText, newText);
        return this.writeFile(filePath, newContent);
    }

    listDir(dirPath, options = {}) {
        const abs = this._resolve(dirPath || '.');
        const { maxDepth = 2, excludes = ['node_modules', '.git', '__pycache__', 'dist', 'build', '.next', 'coverage', '.sudo'] } = options;

        const walk = (dir, depth) => {
            if (depth > maxDepth) return [];
            let entries = [];
            try {
                const items = fs.readdirSync(dir, { withFileTypes: true });
                for (const item of items) {
                    if (excludes.includes(item.name)) continue;
                    entries.push({ name: item.name, type: item.isDirectory() ? 'dir' : 'file', depth });
                    if (item.isDirectory()) {
                        entries = entries.concat(walk(path.join(dir, item.name), depth + 1));
                    }
                }
            } catch (_) {}
            return entries;
        };
        return { ok: true, entries: walk(abs, 0) };
    }

    searchText(pattern, dirPath, extensions = ['.js', '.ts', '.py', '.json', '.md', '.dart', '.go', '.rs', '.java', '.cs']) {
        const abs = this._resolve(dirPath || '.');
        const results = [];
        let re;
        try { re = new RegExp(pattern, 'gi'); } catch (_) { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); }

        const walk = (dir) => {
            try {
                for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (['node_modules', '.git', '__pycache__', 'dist', 'build'].includes(item.name)) continue;
                    const full = path.join(dir, item.name);
                    if (item.isDirectory()) { walk(full); }
                    else if (extensions.some(ext => item.name.endsWith(ext))) {
                        try {
                            const lines = fs.readFileSync(full, 'utf8').split('\n');
                            lines.forEach((line, i) => {
                                if (re.test(line)) {
                                    results.push({ file: path.relative(this.root, full), line: i + 1, text: line.trim().slice(0, 200) });
                                    re.lastIndex = 0;
                                }
                            });
                        } catch (_) {}
                    }
                }
            } catch (_) {}
        };
        walk(abs);
        return { ok: true, matches: results.slice(0, 50) };
    }
}

// ─── TERMINAL TOOL ────────────────────────────────────────────────────────────
class TerminalTool {
    constructor(projectRoot) {
        this.root = projectRoot;
    }

    run(cmd, options = {}) {
        return new Promise((resolve) => {
            const cwd     = options.cwd || this.root;
            const timeout = options.timeout || CMD_TIMEOUT_MS;
            const started = Date.now();

            exec(cmd, { cwd, timeout, maxBuffer: 1024 * 1024 * 4 }, (err, stdout, stderr) => {
                const duration = Date.now() - started;
                const exitCode = err
                    ? (typeof err.code === 'number' ? err.code : (err.killed ? 124 : 1))
                    : 0;

                const truncate = (s, max = 8000) => {
                    if (!s || s.length <= max) return s || '';
                    return s.slice(0, max / 2) + '\n...[truncated]...\n' + s.slice(-max / 2);
                };

                resolve({
                    ok:       exitCode === 0,
                    cmd,
                    exitCode,
                    stdout:   truncate(stdout),
                    stderr:   truncate(stderr),
                    duration,
                    timedOut: !!(err && err.killed),
                    error:    err ? err.message : null,
                });
            });
        });
    }
}

// ─── GIT TOOL ─────────────────────────────────────────────────────────────────
class GitTool {
    constructor(terminal) {
        this.term = terminal;
    }

    async status()        { return this.term.run('git status --porcelain'); }
    async diff(file)      { return this.term.run(file ? `git diff -- "${file}"` : 'git diff'); }
    async log(n = 10)     { return this.term.run(`git log --oneline -${n}`); }
    async addAll()        { return this.term.run('git add -A'); }
    async commit(msg)     { return this.term.run(`git commit -m "${msg.replace(/"/g, '\\"')}"`); }

    async changedFiles() {
        const r = await this.status();
        if (!r.ok && !r.stdout) return [];
        return r.stdout.trim().split('\n')
            .filter(l => l.trim())
            .map(l => ({ status: l.slice(0, 2).trim(), file: l.slice(3).trim() }));
    }
}

// ─── MCP CLIENT ───────────────────────────────────────────────────────────────
class MCPClient {
    constructor(projectRoot) {
        this.root    = projectRoot;
        this.tools   = [];
        this.servers = [];
        this._ready  = false;
    }

    async initialize() {
        const configPath = path.join(this.root, MCP_CONFIG_FILE);
        if (!fs.existsSync(configPath)) return;

        try {
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            this.servers = (cfg.servers || []).slice(0, 5);
            for (const srv of this.servers) {
                try { await this._discoverTools(srv); } catch (_) {}
            }
            this._ready = this.tools.length > 0;
        } catch (_) {}
    }

    async _discoverTools(srv) {
        if (srv.type === 'http') {
            const r = await axios.post(`${srv.url}/tools/list`, {}, { timeout: 5000 });
            const tools = (r.data?.tools || []).slice(0, 20);
            for (const t of tools) {
                this.tools.push({ ...t, serverId: srv.name, serverUrl: srv.url, type: 'http' });
            }
        }
    }

    async callTool(serverId, toolName, toolArgs) {
        const tool = this.tools.find(t => t.serverId === serverId && t.name === toolName);
        if (!tool) return { ok: false, error: `MCP tool not found: ${serverId}/${toolName}` };
        try {
            if (tool.type === 'http') {
                const r = await axios.post(`${tool.serverUrl}/tools/call`, { name: toolName, arguments: toolArgs }, { timeout: 30000 });
                return { ok: true, result: r.data?.result || r.data };
            }
            return { ok: false, error: 'Unsupported MCP transport' };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    getToolSummary() {
        if (!this._ready) return '';
        return 'MCP TOOLS:\n' + this.tools.map(t => `- ${t.serverId}/${t.name}: ${t.description || ''}`).join('\n');
    }
}

// ─── SUDO TOOLS (Sudo Studio integration) ────────────────────────────────────
/**
 * v3.0: Full Sudo Studio feature set exposed as agent tools.
 * Each method returns { ok, result, logs, error? } and emits structured logs.
 */
class SudoTools {
    constructor(termTool, projectRoot) {
        this.term = termTool;
        this.root = projectRoot;
    }

    // ── Doctor ────────────────────────────────────────────────────────────────
    async runDoctor() {
        const issues = [];
        const logs   = [];
        try {
            const r = await axios.get('http://localhost:6000/health', { timeout: 5000 });
            logs.push(`[DOCTOR] Runtime: ${r.data.status}`);
            logs.push(`[DOCTOR] Model loaded: ${r.data.model?.loaded}`);
            logs.push(`[DOCTOR] RAM available: ${r.data.system?.ram_available_gb} GB`);
            if (!r.data.model?.loaded) issues.push('Modèle IA non chargé');
            if (r.data.system?.ram_available_gb < 1.5) issues.push('RAM disponible faible (< 1.5 GB)');
            if (r.data.mock_mode) logs.push('[DOCTOR] ⚠️ Mode mock actif');
            logs.push(`[DOCTOR] Requests served: ${r.data.requests_served}`);
            return { ok: true, issues, logs, status: r.data.status, runtimeData: r.data };
        } catch (e) {
            issues.push('Runtime non joignable sur port 6000');
            logs.push(`[DOCTOR] ERROR: ${e.message}`);
            return { ok: false, error: `Runtime hors ligne: ${e.message}`, issues, logs };
        }
    }

    // ── AutoFix ───────────────────────────────────────────────────────────────
    async applyAutoFix(fileHint) {
        const logs = [];
        // Detect project type and run appropriate linter/fixer
        const commands = [];
        if (fs.existsSync(path.join(this.root, 'package.json'))) {
            const pkg = JSON.parse(fs.readFileSync(path.join(this.root, 'package.json'), 'utf8'));
            if (pkg.scripts?.lint) commands.push('npm run lint -- --fix');
            else commands.push('npx eslint . --fix --ext .js,.ts,.jsx,.tsx 2>&1 || true');
        }
        if (fs.existsSync(path.join(this.root, 'pubspec.yaml'))) {
            commands.push('dart fix --apply 2>&1 || true');
            commands.push('dart format . 2>&1 || true');
        }
        if (fs.existsSync(path.join(this.root, 'requirements.txt'))) {
            commands.push('black . 2>&1 || true');
            commands.push('ruff check . --fix 2>&1 || true');
        }

        if (!commands.length) {
            logs.push('[AUTOFIX] No supported auto-fix tool detected for this project.');
            return { ok: true, logs, fixed: 0 };
        }

        let fixed = 0;
        for (const cmd of commands) {
            const r = await this.term.run(cmd);
            const label = r.ok ? '[AUTOFIX] OK' : '[AUTOFIX] WARN';
            logs.push(`${label} $ ${cmd}`);
            if (r.stdout) logs.push(`  stdout: ${r.stdout.slice(0, 300)}`);
            if (r.stderr) logs.push(`  stderr: ${r.stderr.slice(0, 200)}`);
            if (r.ok) fixed++;
        }
        return { ok: true, logs, fixed };
    }

    // ── SDK Analyze ───────────────────────────────────────────────────────────
    async analyzeSDK(projectType) {
        const logs   = [];
        const needed = [];
        const found  = [];
        const missing = [];

        // Detect from workspace if not specified
        if (!projectType || projectType === 'auto') {
            if (fs.existsSync(path.join(this.root, 'pubspec.yaml')))    projectType = 'flutter';
            else if (fs.existsSync(path.join(this.root, 'package.json'))) projectType = 'node';
            else if (fs.existsSync(path.join(this.root, 'requirements.txt'))) projectType = 'python';
            else if (fs.existsSync(path.join(this.root, 'go.mod')))    projectType = 'go';
            else if (fs.existsSync(path.join(this.root, 'Cargo.toml'))) projectType = 'rust';
            else if (fs.existsSync(path.join(this.root, 'pom.xml')))   projectType = 'java';
            else projectType = 'unknown';
        }
        logs.push(`[SDK_ANALYZE] Project type: ${projectType}`);

        const checks = {
            flutter: [
                { name: 'Flutter', cmd: 'flutter --version' },
                { name: 'Dart',    cmd: 'dart --version' },
            ],
            node: [
                { name: 'Node.js', cmd: 'node --version' },
                { name: 'npm',     cmd: 'npm --version' },
            ],
            python: [
                { name: 'Python 3', cmd: process.platform === 'win32' ? 'python --version' : 'python3 --version' },
                { name: 'pip',      cmd: process.platform === 'win32' ? 'pip --version' : 'pip3 --version' },
            ],
            go:   [{ name: 'Go', cmd: 'go version' }],
            rust: [{ name: 'Rust/rustc', cmd: 'rustc --version' }],
            java: [{ name: 'Java', cmd: 'java --version 2>&1' }],
        };

        // Always check git
        const allChecks = [...(checks[projectType] || []), { name: 'Git', cmd: 'git --version' }, { name: 'Docker', cmd: 'docker --version' }];

        for (const { name, cmd } of allChecks) {
            needed.push(name);
            const r = await this.term.run(cmd, { timeout: 5000 });
            const version = (r.stdout || r.stderr || '').trim().split('\n')[0].slice(0, 80);
            if (r.ok && version) {
                found.push({ name, version });
                logs.push(`[SDK] ✅ ${name}: ${version}`);
            } else {
                missing.push(name);
                logs.push(`[SDK] ❌ ${name}: NOT FOUND`);
            }
        }

        return { ok: true, projectType, needed, found, missing, logs };
    }

    // ── SDK Install ───────────────────────────────────────────────────────────
    async installSDK(sdkName) {
        const logs = [];
        const name = sdkName.toLowerCase().trim();
        logs.push(`[SDK_INSTALL] Requesting install of: ${name}`);

        // These are display-only commands (user must confirm / run themselves in many cases)
        const installGuide = {
            node:    'Visit https://nodejs.org OR run: winget install OpenJS.NodeJS (Windows) / brew install node (Mac)',
            python:  'Visit https://python.org OR run: winget install Python.Python.3 (Windows) / brew install python3 (Mac)',
            flutter: 'Visit https://flutter.dev/docs/get-started/install',
            go:      'Visit https://go.dev/dl/ OR brew install go',
            rust:    'Run: curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh',
            docker:  'Visit https://docs.docker.com/get-docker/',
            java:    'Visit https://adoptium.net OR run: winget install Eclipse.Temurin.21',
            git:     'Visit https://git-scm.com OR run: winget install Git.Git',
        };

        if (installGuide[name]) {
            logs.push(`[SDK_INSTALL] 📦 Install guide for ${name}: ${installGuide[name]}`);
            // Attempt silent install where possible (Windows winget, Mac brew)
            const IS_WIN = process.platform === 'win32';
            const IS_MAC = process.platform === 'darwin';

            let autoCmd = null;
            if (IS_WIN) {
                const wingetCmds = { node: 'winget install -e OpenJS.NodeJS', python: 'winget install -e Python.Python.3', git: 'winget install -e Git.Git', docker: 'winget install -e Docker.DockerDesktop' };
                autoCmd = wingetCmds[name];
            } else if (IS_MAC) {
                const brewCmds = { node: 'brew install node', python: 'brew install python3', git: 'brew install git', go: 'brew install go', rust: 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y' };
                autoCmd = brewCmds[name];
            } else {
                const aptCmds = { node: 'curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs', python: 'sudo apt-get install -y python3 python3-pip', git: 'sudo apt-get install -y git', go: 'sudo apt-get install -y golang-go', docker: 'sudo apt-get install -y docker.io' };
                autoCmd = aptCmds[name];
            }

            if (autoCmd) {
                logs.push(`[SDK_INSTALL] Attempting auto-install: ${autoCmd}`);
                const r = await this.term.run(autoCmd, { timeout: 120000 });
                if (r.ok) {
                    logs.push(`[SDK_INSTALL] ✅ Auto-install succeeded`);
                    return { ok: true, logs, installed: true, sdk: name };
                }
                logs.push(`[SDK_INSTALL] ⚠️ Auto-install failed (exit ${r.exitCode}): ${(r.stderr || '').slice(0, 200)}`);
                logs.push(`[SDK_INSTALL] Please install manually: ${installGuide[name]}`);
                return { ok: false, logs, installed: false, sdk: name, manualGuide: installGuide[name] };
            }

            return { ok: true, logs, installed: false, sdk: name, manualGuide: installGuide[name] };
        }

        logs.push(`[SDK_INSTALL] Unknown SDK: ${name}. Supported: node, python, flutter, go, rust, docker, java, git`);
        return { ok: false, error: `Unknown SDK: ${name}`, logs };
    }

    // ── CI/CD Generate ────────────────────────────────────────────────────────
    async generateCICD(target) {
        const logs = [];
        const t = (target || 'all').toLowerCase();
        const created = [];

        // Detect project type
        let projectType = 'node';
        if (fs.existsSync(path.join(this.root, 'pubspec.yaml')))      projectType = 'flutter';
        else if (fs.existsSync(path.join(this.root, 'requirements.txt'))) projectType = 'python';
        else if (fs.existsSync(path.join(this.root, 'go.mod')))       projectType = 'go';
        else if (fs.existsSync(path.join(this.root, 'Cargo.toml')))   projectType = 'rust';
        else if (fs.existsSync(path.join(this.root, 'pom.xml')))      projectType = 'java';

        logs.push(`[CICD] Detected project type: ${projectType}`);

        const cicdFiles = buildCICDFiles(projectType, t);
        for (const [filePath, content] of Object.entries(cicdFiles)) {
            const abs = path.join(this.root, filePath);
            const dir = path.dirname(abs);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(abs, content, 'utf8');
            created.push(filePath);
            logs.push(`[CICD] ✅ Created: ${filePath}`);
        }

        return { ok: true, logs, created, projectType };
    }

    // ── Security Audit ────────────────────────────────────────────────────────
    async runSecurityAudit(scope) {
        const s = (scope || 'all').toLowerCase();
        const logs = [];
        const findings = [];

        // 1. Secret scanning
        if (s === 'all' || s === 'secrets') {
            logs.push('[SECURITY] Scanning for exposed secrets...');
            const secretPatterns = [
                { label: 'AWS Access Key',   re: /AKIA[0-9A-Z]{16}/ },
                { label: 'Generic API Key',  re: /(api[_-]?key|apikey)\s*[:=]\s*['"][a-zA-Z0-9_-]{16,}['"]/i },
                { label: 'Private Key',      re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
                { label: 'GitHub Token',     re: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
                { label: 'Stripe Key',       re: /(?:r|s)k_(live|test)_[0-9a-zA-Z]{24,}/ },
            ];
            const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.dart_tool']);
            const walkForSecrets = (dir) => {
                try {
                    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
                        if (skipDirs.has(item.name)) continue;
                        const full = path.join(dir, item.name);
                        if (item.isDirectory()) { walkForSecrets(full); continue; }
                        if (item.name.match(/\.(env|key|pem|p12|json|js|ts|py|dart|go|rb|php)$/) || item.name === '.env') {
                            try {
                                const content = fs.readFileSync(full, 'utf8');
                                for (const { label, re } of secretPatterns) {
                                    if (re.test(content)) {
                                        const relPath = path.relative(this.root, full);
                                        findings.push({ type: 'secret', severity: 'HIGH', file: relPath, label });
                                        logs.push(`[SECURITY] ❌ HIGH — ${label} found in ${relPath}`);
                                    }
                                }
                            } catch (_) {}
                        }
                    }
                } catch (_) {}
            };
            walkForSecrets(this.root);
            if (!findings.some(f => f.type === 'secret')) {
                logs.push('[SECURITY] ✅ No exposed secrets detected');
            }
        }

        // 2. .gitignore check
        if (s === 'all' || s === 'gitignore') {
            logs.push('[SECURITY] Checking .gitignore coverage...');
            const sensitiveFiles = ['.env', '.env.local', '.env.production', '*.pem', '*.key', 'secrets.json', 'credentials.json'];
            const giPath = path.join(this.root, '.gitignore');
            if (fs.existsSync(giPath)) {
                const gi = fs.readFileSync(giPath, 'utf8');
                for (const sf of sensitiveFiles) {
                    if (!gi.includes(sf)) {
                        findings.push({ type: 'gitignore', severity: 'MEDIUM', label: `${sf} not in .gitignore` });
                        logs.push(`[SECURITY] ⚠️ MEDIUM — ${sf} not covered by .gitignore`);
                    }
                }
                if (!findings.some(f => f.type === 'gitignore')) logs.push('[SECURITY] ✅ .gitignore looks good');
            } else {
                findings.push({ type: 'gitignore', severity: 'MEDIUM', label: 'No .gitignore file found' });
                logs.push('[SECURITY] ⚠️ MEDIUM — No .gitignore file found');
            }
        }

        // 3. npm audit
        if ((s === 'all' || s === 'deps') && fs.existsSync(path.join(this.root, 'package.json'))) {
            logs.push('[SECURITY] Running npm audit...');
            const r = await this.term.run('npm audit --json 2>&1', { timeout: 30000 });
            if (r.ok || r.stdout) {
                try {
                    const audit = JSON.parse(r.stdout);
                    const total = audit.metadata?.vulnerabilities?.total || 0;
                    const high  = (audit.metadata?.vulnerabilities?.high || 0) + (audit.metadata?.vulnerabilities?.critical || 0);
                    logs.push(`[SECURITY] npm audit: ${total} vulnerabilities (${high} high/critical)`);
                    if (high > 0) {
                        findings.push({ type: 'npm_audit', severity: 'HIGH', label: `${high} high/critical vulnerabilities in npm deps` });
                    }
                } catch (_) {
                    logs.push('[SECURITY] npm audit: Could not parse output');
                }
            }
        }

        const score = findings.length === 0 ? 100 : Math.max(0, 100 - findings.length * 15);
        logs.push(`[SECURITY] Score: ${score}/100 | Findings: ${findings.length}`);
        return { ok: true, logs, findings, score, scope: s };
    }

    // ── Chat Query (sub-reasoning) ────────────────────────────────────────────
    async chatQuery(question) {
        const logs = [];
        logs.push(`[CHAT] Querying AI: ${question.slice(0, 100)}...`);
        try {
            const r = await axios.post('http://localhost:6000/infer', {
                message: question, max_tokens: 512, temperature: 0.2
            }, { timeout: AI_TIMEOUT_MS });
            const reply = r.data.reply || r.data.response || '';
            logs.push(`[CHAT] Response (${reply.length} chars): ${reply.slice(0, 300)}`);
            return { ok: true, logs, reply, mock: r.data.mock === true };
        } catch (e) {
            logs.push(`[CHAT] ERROR: ${e.message}`);
            return { ok: false, error: e.message, logs };
        }
    }
}

// ─── CI/CD FILE GENERATOR ────────────────────────────────────────────────────
function buildCICDFiles(projectType, target) {
    const files = {};

    // GitHub Actions
    if (target === 'all' || target === 'github_actions') {
        const ciContent = {
            node: `name: Node.js CI
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18.x, 20.x]
    steps:
      - uses: actions/checkout@v4
      - name: Use Node.js \${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
          cache: 'npm'
      - run: npm ci
      - run: npm run build --if-present
      - run: npm test
`,
            flutter: `name: Flutter CI
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: subosito/flutter-action@v2
        with:
          flutter-version: '3.19.0'
          channel: 'stable'
          cache: true
      - run: flutter pub get
      - run: flutter analyze
      - run: flutter test
`,
            python: `name: Python CI
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python-version: ["3.10", "3.11", "3.12"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: \${{ matrix.python-version }}
      - run: pip install -r requirements.txt
      - run: pytest --tb=short -v
`,
            go: `name: Go CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
      - run: go build ./...
      - run: go test ./...
      - run: go vet ./...
`,
        };
        files['.github/workflows/ci.yml'] = ciContent[projectType] || ciContent.node;
    }

    // Dockerfile
    if (target === 'all' || target === 'dockerfile') {
        const dockerfiles = {
            node: `FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build --if-present

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
EXPOSE 3000
CMD ["node", "src/index.js"]
`,
            python: `FROM python:3.12-slim AS base
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
`,
            flutter: `FROM dart:stable AS build
WORKDIR /app
COPY pubspec.* ./
RUN dart pub get
COPY . .
RUN dart compile exe bin/main.dart -o bin/server
FROM debian:bullseye-slim
COPY --from=build /app/bin/server /app/server
EXPOSE 8080
CMD ["/app/server"]
`,
        };
        files['Dockerfile'] = dockerfiles[projectType] || dockerfiles.node;
    }

    // Docker Compose
    if (target === 'all' || target === 'docker_compose') {
        const composes = {
            node: `version: '3.9'
services:
  app:
    build: .
    ports:
      - "\${PORT:-3000}:3000"
    environment:
      NODE_ENV: \${NODE_ENV:-development}
    volumes:
      - .:/app
      - /app/node_modules
    restart: unless-stopped
`,
            python: `version: '3.9'
services:
  api:
    build: .
    ports:
      - "\${PORT:-8000}:8000"
    environment:
      ENVIRONMENT: \${ENVIRONMENT:-development}
    volumes:
      - .:/app
    restart: unless-stopped
`,
        };
        files['docker-compose.yml'] = composes[projectType] || composes.node;
    }

    // Kubernetes
    if (target === 'kubernetes') {
        files['k8s/deployment.yaml'] = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  labels:
    app: app
spec:
  replicas: 2
  selector:
    matchLabels:
      app: app
  template:
    metadata:
      labels:
        app: app
    spec:
      containers:
      - name: app
        image: app:latest
        ports:
        - containerPort: 3000
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "256Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 15
---
apiVersion: v1
kind: Service
metadata:
  name: app-service
spec:
  selector:
    app: app
  ports:
  - protocol: TCP
    port: 80
    targetPort: 3000
  type: LoadBalancer
`;
    }

    return files;
}

// ─── AI PROVIDER ──────────────────────────────────────────────────────────────
class AIProvider {
    constructor(options = {}) {
        this.runtimeUrl = options.runtimeUrl || 'http://localhost:6000';
    }

    async query(prompt, systemContext = '', options = {}) {
        const max_tokens  = options.max_tokens  || 1024;
        const temperature = options.temperature || 0.1;

        const fullPrompt = AGENT_SYSTEM_PROMPT +
            (systemContext ? '\n\nCONTEXT:\n' + systemContext : '') +
            '\n\nUser: ' + prompt.trim() + '\nAssistant:';

        const payload = { message: fullPrompt, prompt: fullPrompt, input: fullPrompt, max_tokens, temperature };

        try {
            const r = await axios.post(`${this.runtimeUrl}/infer`, payload, { timeout: AI_TIMEOUT_MS });
            const reply = r.data.reply || r.data.response || '';
            const mock  = r.data.mock === true;
            return { ok: true, reply, model: r.data.model, mock };
        } catch (e) {
            if (e.code === 'ECONNREFUSED') return { ok: false, error: 'Runtime offline', reply: null };
            if (e.code === 'ECONNABORTED' || (e.message || '').includes('timeout')) {
                return { ok: false, error: `Timeout after ${AI_TIMEOUT_MS}ms`, reply: null };
            }
            return { ok: false, error: e.message, reply: null };
        }
    }

    async plan(task, projectContext, mcpContext = '') {
        const prompt = `TÂCHE À ACCOMPLIR : ${task}

CONTEXTE DU PROJET :
${projectContext}
${mcpContext ? '\n' + mcpContext : ''}

Génère un plan d'action numéroté (maximum 8 étapes) SPÉCIFIQUE à cette tâche.
Chaque étape doit utiliser exactement l'un de ces formats d'outil :
  TOOL: write_file  → créer un fichier
  TOOL: run_command → exécuter une commande shell
  TOOL: read_file   → lire un fichier existant
  TOOL: edit_file   → modifier un fichier
  TOOL: search_code → chercher dans le code
  TOOL: git         → opérations git
  TOOL: sdk_analyze → analyser les SDKs requis
  TOOL: sdk_install → installer un SDK
  TOOL: doctor_run  → diagnostic système
  TOOL: cicd_generate → générer CI/CD
  TOOL: security_audit → audit sécurité

Format : 1. [DESCRIPTION COURTE] → TOOL: <outil> — <argument principal>

Plan pour : ${task}`;

        return this.query(prompt, '', { max_tokens: 512, temperature: 0.2 });
    }

    async generateCommand(stepDescription, projectContext, previousResults = '') {
        const prompt = `ÉTAPE : "${stepDescription}"
CONTEXTE : ${projectContext.slice(0, 1000)}
RÉSULTATS PRÉCÉDENTS : ${previousResults.slice(0, 500)}

Génère la commande shell exacte ou l'action pour accomplir cette étape.
Réponds avec :
TOOL: run_command
CMD: <commande>

OU :
TOOL: write_file
FILE: <chemin>
CONTENT:
<contenu>`;

        return this.query(prompt, '', { max_tokens: 300, temperature: 0.1 });
    }

    async generateFileContent(filePath, task, projectContext, previousResults = '') {
        const ext = path.extname(filePath).toLowerCase();
        const lang = {
            '.dart': 'Dart', '.py': 'Python', '.js': 'JavaScript', '.ts': 'TypeScript',
            '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.cs': 'C#', '.cpp': 'C++',
            '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.kt': 'Kotlin',
        }[ext] || 'code';

        const prompt = `TÂCHE : ${task}
FICHIER : ${filePath} (${lang})
CONTEXTE : ${projectContext.slice(0, 800)}
RÉSULTATS PRÉCÉDENTS : ${previousResults.slice(0, 400)}

Génère le contenu COMPLET et FONCTIONNEL de ${filePath} en ${lang}.
Code uniquement, sans explication.`;

        return this.query(prompt, '', { max_tokens: 1500, temperature: 0.05 });
    }

    async diagnose(errorContext, projectContext) {
        const prompt = `ERREUR :
${errorContext}
CONTEXTE : ${projectContext.slice(0, 1500)}

Diagnostique en 2 phrases, puis propose l'action corrective :
TOOL: <outil>
<arguments>`;

        return this.query(prompt, '', { max_tokens: 600, temperature: 0.1 });
    }
}

// ─── STEP PARSER ──────────────────────────────────────────────────────────────
/**
 * v3.0: Handles all 13 tool types including 7 Sudo Studio tools.
 */
function parseStepToTool(description) {
    const d = description.trim();

    // Structured tool call
    const toolMatch = d.match(/TOOL:\s*(\S+)\s*[—-]?\s*(.*)/i);
    if (toolMatch) {
        const rawType = toolMatch[1].toLowerCase();
        // Map aliases
        const typeMap = {
            'write_file': 'write_file', 'read_file': 'read_file', 'edit_file': 'edit_file',
            'run_command': 'run_command', 'search_code': 'search_code', 'git': 'git',
            'sdk_analyze': 'sdk_analyze', 'sdk_install': 'sdk_install',
            'doctor_run': 'doctor_run', 'doctor': 'doctor_run',
            'autofix_apply': 'autofix_apply', 'autofix': 'autofix_apply',
            'cicd_generate': 'cicd_generate', 'cicd': 'cicd_generate',
            'security_audit': 'security_audit', 'security': 'security_audit',
            'chat_query': 'chat_query', 'chat': 'chat_query',
            'ai_generate': 'ai_generate',
        };
        const type = typeMap[rawType] || rawType;
        return { type, arg: toolMatch[2].trim() };
    }

    // Natural language heuristics
    if (/^(read|lire|ouvrir|consulter)\s/i.test(d)) {
        const m = d.match(/[\w./\\-]+\.\w{1,6}/);
        return { type: 'read_file', arg: m ? m[0] : null };
    }
    if (/^(write|créer|create|générer|generate|écrire)\s/i.test(d)) {
        const m = d.match(/[\w./\\-]+\.\w{1,6}/);
        return { type: 'write_file', arg: m ? m[0] : null };
    }
    if (/^(edit|modifier|fix|corriger|update|patch)\s/i.test(d)) {
        const m = d.match(/[\w./\\-]+\.\w{1,6}/);
        return { type: 'edit_file', arg: m ? m[0] : null };
    }
    if (/^(run|lancer|execute|exécuter?|npm|pip|python|node|flutter|dart|yarn|cargo|make|go\s)\s/i.test(d)) {
        return { type: 'run_command', arg: d.replace(/^(run|lancer|execute|exécuter?)\s+/i, '').trim() };
    }
    if (/^(git|commit|push|pull|status|diff)\s/i.test(d)) {
        return { type: 'git', arg: d };
    }
    if (/^(search|grep|find|chercher|trouver)\s/i.test(d)) {
        return { type: 'search_code', arg: d };
    }

    // Sudo Studio tool keywords
    if (/\b(sdk.?analy|analyser.?sdk|check.?sdk|détect.?sdk)\b/i.test(d)) return { type: 'sdk_analyze', arg: 'auto' };
    if (/\b(sdk.?install|install.?sdk|installer)\b/i.test(d)) {
        const m = d.match(/\b(flutter|node|python|go|rust|docker|java|git)\b/i);
        return { type: 'sdk_install', arg: m ? m[1] : 'node' };
    }
    if (/\b(doctor|diagnostic|diagnos)\b/i.test(d)) return { type: 'doctor_run', arg: '' };
    if (/\b(autofix|auto.?fix|lint.?fix|format)\b/i.test(d)) return { type: 'autofix_apply', arg: '' };
    if (/\b(ci.?cd|cicd|pipeline|dockerfile|github.?action|gitlab.?ci)\b/i.test(d)) {
        const m = d.match(/\b(dockerfile|docker_compose|github_actions|gitlab_ci|kubernetes|k8s)\b/i);
        return { type: 'cicd_generate', arg: m ? m[1] : 'all' };
    }
    if (/\b(securit|audit.?secu|scan.?secret|vulnérab)\b/i.test(d)) return { type: 'security_audit', arg: 'all' };

    if (/\b(npm|pip|python|node|flutter|dart)\b/i.test(d)) return { type: 'run_command', arg: d };

    return { type: 'ai_generate', arg: null };
}

// ─── AGENT ENGINE ─────────────────────────────────────────────────────────────
class AgentEngine extends EventEmitter {
    constructor(options = {}) {
        super();

        // Workspace root resolution with fallback
        this.projectRoot = options.projectRoot || (() => {
            try {
                return require('vscode').workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd();
            } catch (_) { return process.cwd(); }
        })();

        this.fileTool    = new FileTool(this.projectRoot);
        this.termTool    = new TerminalTool(this.projectRoot);
        this.gitTool     = new GitTool(this.termTool);
        this.mcpClient   = new MCPClient(this.projectRoot);
        this.sudoTools   = new SudoTools(this.termTool, this.projectRoot);
        this.aiProvider  = new AIProvider(options.ai || {});
        this.state       = null;
        this._stopped    = false;
        this._approvalQueue = [];
        this._hasWorkspace = !!options.projectRoot || (() => {
            try { return !!(require('vscode').workspace.workspaceFolders?.[0]); } catch (_) { return false; }
        })();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    async run(task) {
        this._stopped = false;
        this.state    = new AgentState(task, this.projectRoot);
        console.log('[AGENT] Task:', task);
        console.log('[AGENT] projectRoot:', this.projectRoot);
        console.log('[AGENT] hasWorkspace:', this._hasWorkspace);
        this.state.log(`Agent v3.0 started — task: ${task}`);
        this._emit('step', { phase: 'start', message: `🚀 Sudo Agent v3.0 démarré — tâche: ${task}` });

        // PROB 1: Workspace guard for write tasks
        if (!this._hasWorkspace && this._isWriteTask(task)) {
            this._emit('step', {
                phase: 'error',
                message: [
                    '⚠️ Aucun dossier de projet ouvert.',
                    '',
                    'L\'agent ne peut pas écrire de fichiers sans un dossier ouvert dans Sudo Studio.',
                    '→ Utilisez Fichier > Ouvrir un Dossier (ou File > Open Folder)',
                    '  puis relancez la tâche.',
                    '',
                    'Si vous souhaitez une analyse ou une génération de code sans écriture,',
                    'reformulez votre tâche en commençant par "explique" ou "analyse".'
                ].join('\n')
            });
            this._emit('done', { status: 'failed', emoji: '⚠️', summary: this.state.toSummary(), filesModified: [], commandsRun: [] });
            // Offer to open folder via VS Code command
            try {
                const vscode = require('vscode');
                vscode.commands.executeCommand('vscode.openFolder');
            } catch (_) {}
            return this.state.toSummary();
        }

        // PROB 2: Scaffolding detection — handle before normal flow
        const scaffold = detectScaffold(task, this.projectRoot);
        if (scaffold) {
            return await this._runScaffold(scaffold, task);
        }

        try {
            await this.mcpClient.initialize().catch(() => {});

            await this._phase_analyze();
            if (this._stopped) return this._finish('stopped');

            await this._phase_plan();
            if (this._stopped) return this._finish('stopped');

            await this._phase_execute();

        } catch (e) {
            this.state.log(`FATAL: ${e.message}`);
            console.error('[AGENT] Fatal error:', e.stack);
            this._emit('error', { message: e.message, phase: 'execute' });
            return this._finish('failed');
        }

        return this._finish(this.state.finalStatus === 'running' ? 'success' : this.state.finalStatus);
    }

    /**
     * Returns true if the task clearly requires writing files,
     * which would fail without an open workspace.
     */
    _isWriteTask(task) {
        const t = task.toLowerCase();
        return /\b(crée?r?|create|write|écrire?|générer?|generate|scaffold|build|make|new app|nouvelle app)\b/i.test(t) &&
               !/\b(explique?|analyse?|montre?|affiche?|liste?|show|explain|describe)\b/i.test(t);
    }

    stop() {
        this._stopped = true;
        if (this.state) {
            this.state.log('Stopped by user');
            this.state.stoppedByUser = true;
        }
        this._emit('step', { phase: 'stop', message: '⏹ Agent arrêté par l\'utilisateur.' });
    }

    resolveApproval(approved) {
        if (this._approvalQueue.length) {
            const resolver = this._approvalQueue.shift();
            resolver(approved);
        }
    }

    // ── Scaffolding flow ──────────────────────────────────────────────────────

    async _runScaffold(scaffold, task) {
        this._emit('step', { phase: 'scaffold', message: `🏗️ Scaffolding détecté: ${scaffold.title}` });
        this.state.log(`Scaffold: ${scaffold.title} — ${Object.keys(scaffold.files).length} files`);

        const created = [];
        const failed  = [];

        this._emit('step', { phase: 'scaffold', message: `📁 Création de ${Object.keys(scaffold.files).length} fichiers...` });

        for (const [relPath, content] of Object.entries(scaffold.files)) {
            const result = this.fileTool.writeFile(relPath, content);
            if (result.ok) {
                created.push(relPath);
                this.state.filesModified.push(relPath);
                this._emit('tool_call', { tool: 'write_file', args: { file: relPath, bytes: content.length }, result: `✅ ${relPath}`, ok: true });
            } else {
                failed.push(relPath);
                this._emit('tool_call', { tool: 'write_file', args: { file: relPath }, result: `❌ ${result.error}`, ok: false });
            }
        }

        // Build and emit the file tree
        const tree = buildFileTree(scaffold.files, scaffold.title);
        this._emit('step', {
            phase: 'scaffold_done',
            message: `✅ Scaffold complet: ${created.length} fichiers créés${failed.length ? `, ${failed.length} échecs` : ''}\n\n${tree}`,
            data: { created, failed, tree }
        });

        this.state.log(`Scaffold done: ${created.length}/${Object.keys(scaffold.files).length} files created`);
        this.state.finalStatus = created.length > 0 ? 'success' : 'failed';
        return this._finish(this.state.finalStatus);
    }

    // ── Phases ────────────────────────────────────────────────────────────────

    async _phase_analyze() {
        console.log('[AGENT] ─── PHASE 1: ANALYZE ───');
        this._emit('step', { phase: 'analyze', message: '🔍 Analyse du projet en cours...' });

        const structure = this.fileTool.listDir('.', { maxDepth: 2 });
        const dirs  = structure.entries.filter(e => e.type === 'dir'  && e.depth === 0).map(e => e.name).join(', ');
        const files = structure.entries.filter(e => e.type === 'file' && e.depth === 0).map(e => e.name).join(', ');

        const contextFiles = ['package.json', 'README.md', 'requirements.txt', 'pyproject.toml', 'pubspec.yaml', 'go.mod', 'Cargo.toml'];
        const contextSnippets = [];
        for (const f of contextFiles) {
            const r = this.fileTool.readFile(f);
            if (r.ok) contextSnippets.push(`--- ${f} ---\n${r.content.slice(0, 600)}`);
        }

        const gitSt = await this.gitTool.status();

        this.state._projectContext = [
            `PROJECT ROOT: ${this.projectRoot}`,
            `DIRS: ${dirs || '(empty)'}`,
            `ROOT FILES: ${files || '(empty)'}`,
            gitSt.stdout ? `GIT STATUS:\n${gitSt.stdout.slice(0, 300)}` : '',
            ...contextSnippets,
            this.mcpClient.getToolSummary() || '',
        ].filter(Boolean).join('\n\n');

        this._emit('step', {
            phase: 'analyze',
            message: `📁 Projet analysé — ${structure.entries.length} entrées`,
            data: { dirs, rootFiles: files }
        });
    }

    async _phase_plan() {
        console.log('[AGENT] ─── PHASE 2: PLAN ───');
        this._emit('step', { phase: 'plan', message: '📋 Génération du plan IA...' });

        const aiResult = await this.aiProvider.plan(
            this.state.task,
            this.state._projectContext,
            this.mcpClient.getToolSummary()
        );

        let plan = [];
        if (aiResult.ok && aiResult.reply) {
            const lines = aiResult.reply.split('\n');
            for (const line of lines) {
                const m = line.match(/^\s*(\d+)[.)]\s+(.+)/);
                if (m) {
                    const desc = m[2].trim();
                    if (desc.length > 3) plan.push({ step: plan.length + 1, description: desc, status: 'pending', raw: line });
                }
            }
        }

        if (!plan.length) {
            plan = this._buildTaskSpecificFallbackPlan(this.state.task);
            this._emit('step', { phase: 'plan', message: '⚠️ Modèle IA indisponible — plan de secours généré' });
        } else if (aiResult.mock) {
            this._emit('step', { phase: 'plan', message: '⚠️ Modèle en mode mock — plan peut manquer de précision' });
        }

        this.state.currentPlan = plan;
        this._emit('step', {
            phase: 'plan',
            message: `📋 Plan: ${plan.length} étapes`,
            data: { plan, mock: aiResult.mock || false }
        });
    }

    _buildTaskSpecificFallbackPlan(task) {
        const t = task.toLowerCase();
        const fileMatch = task.match(/[\w-]+\.\w{1,6}/);
        const fileName  = fileMatch ? fileMatch[0] : null;

        // Sudo Studio tool tasks
        if (/\b(doctor|diagnostic)\b/i.test(t)) {
            return [{ step: 1, description: 'TOOL: doctor_run', status: 'pending' }];
        }
        if (/\b(securit|audit.?secu)\b/i.test(t)) {
            return [{ step: 1, description: 'TOOL: security_audit — all', status: 'pending' }];
        }
        if (/\b(ci.?cd|pipeline|dockerfile)\b/i.test(t)) {
            return [{ step: 1, description: 'TOOL: cicd_generate — all', status: 'pending' }];
        }
        if (/\b(sdk.?analy|check.?sdk)\b/i.test(t)) {
            return [{ step: 1, description: 'TOOL: sdk_analyze — auto', status: 'pending' }];
        }
        if (/\b(install.?(flutter|node|python|go|rust|docker))\b/i.test(t)) {
            const m = t.match(/\b(flutter|node|python|go|rust|docker|java|git)\b/);
            return [{ step: 1, description: `TOOL: sdk_install — ${m ? m[1] : 'node'}`, status: 'pending' }];
        }

        // File creation
        if ((/\b(write|create|créer|écrire|générer|generate)\b.*\bfile\b/i.test(task) ||
             /\b(dart|flutter|python|javascript|typescript|go|rust|java)\b/i.test(task)) && fileName) {
            const ext = path.extname(fileName).toLowerCase();
            const verifyCmd = {
                '.dart': `dart analyze ${fileName}`,
                '.py':   `python3 -c "import ast; ast.parse(open('${fileName}').read())"`,
                '.js':   `node --check ${fileName}`,
                '.ts':   `npx tsc --noEmit ${fileName}`,
                '.go':   `go vet ${fileName}`,
            }[ext] || `echo "Created: ${fileName}"`;
            return [
                { step: 1, description: `TOOL: write_file — ${fileName}`, status: 'pending' },
                { step: 2, description: `TOOL: run_command — ${verifyCmd}`, status: 'pending' },
            ];
        }

        // Fix/debug
        if (/\b(fix|repair|corriger|déboguer|debug)\b/i.test(t)) {
            const filesInTask = task.match(/[\w./\\-]+\.\w{1,6}/g) || [];
            const steps = [];
            if (filesInTask.length) steps.push({ step: 1, description: `TOOL: read_file — ${filesInTask[0]}`, status: 'pending' });
            steps.push({ step: steps.length + 1, description: 'TOOL: search_code — error', status: 'pending' });
            steps.push({ step: steps.length + 1, description: 'TOOL: edit_file — appliquer le correctif', status: 'pending' });
            return steps;
        }

        return [
            { step: 1, description: `TOOL: search_code — ${task.split(' ').slice(0, 3).join(' ')}`, status: 'pending' },
            { step: 2, description: `TOOL: ai_generate — ${task}`, status: 'pending' },
        ];
    }

    async _phase_execute() {
        console.log('[AGENT] ─── PHASE 3: EXECUTE ─── plan has', this.state.currentPlan.length, 'steps');
        let iteration = 0;

        while (iteration < MAX_ITERATIONS && !this._stopped) {
            iteration++;
            this.state.iteration = iteration;

            this._emit('step', {
                phase: 'iterate',
                message: `🔄 Itération ${iteration}/${MAX_ITERATIONS}`,
                data: { iteration, max: MAX_ITERATIONS }
            });

            let stepFailed = false;

            for (const step of this.state.currentPlan) {
                if (this._stopped) return;
                if (step.status === 'done') continue;

                step.status = 'running';
                this.state.currentStep = step.step;
                this._emit('step', {
                    phase: 'step',
                    message: `▶ Étape ${step.step}: ${step.description}`,
                    data: { step }
                });

                const result = await this._executeStep(step);

                if (result && result.ok === false) {
                    step.status = 'failed';
                    stepFailed  = true;
                    this._emit('step', {
                        phase: 'step_error',
                        message: `❌ Étape ${step.step} échouée: ${(result.error || result.stderr || '').slice(0, 200)}`,
                        data: { step, error: result.error || result.stderr }
                    });
                } else {
                    step.status = 'done';
                }

                const done  = this.state.currentPlan.filter(s => s.status === 'done').length;
                const total = this.state.currentPlan.length;
                this._emit('progress', { step: done, total, pct: Math.round(100 * done / total) });
            }

            const verified = await this._verify();
            if (verified) {
                this.state.finalStatus = 'success';
                return;
            }

            if (stepFailed && iteration < MAX_ITERATIONS) {
                // PROB 3: Stop early if _diagnoseAndRepair already set status to 'failed' (identical error loop)
                await this._diagnoseAndRepair();
                if (this.state.finalStatus === 'failed') return;
            } else if (!stepFailed) {
                // PROB 2 FIX: Don't declare SUCCESS if all commands failed (even if no stepFailed flag)
                // This happens when run_command returns ok=false but the step is marked done anyway
                const allCmdsFailed = this.state.commandsExecuted.length > 0 &&
                    this.state.commandsExecuted.every(c => !c.ok);
                if (allCmdsFailed && this.state.filesModified.length === 0) {
                    this.state.finalStatus = 'failed';
                    this.state.errors.push(`Toutes les commandes ont échoué (${this.state.commandsExecuted.length} commandes, 0 fichier créé)`);
                    return;
                }
                this.state.finalStatus = 'success';
                return;
            }
        }

        if (iteration >= MAX_ITERATIONS) {
            this.state.errors.push('Max iterations reached without success');
            this.state.finalStatus = 'failed';
        }
    }

    async _executeStep(step) {
        try {
            const parsed = parseStepToTool(step.description);
            console.log(`[AGENT] Step ${step.step} type=${parsed.type} arg=${parsed.arg || ''}`);

            switch (parsed.type) {
                case 'read_file':
                    return await this._toolReadFile(parsed.arg || step.description);

                case 'write_file':
                    return await this._toolWriteFileFromAI(parsed.arg || step.description, step.description);

                case 'edit_file':
                    return await this._toolAIEdit(step.description);

                case 'run_command': {
                    let cmd = parsed.arg ? _sanitizeCmd(parsed.arg) : null;
                    if (!cmd || cmd.length < 3 || /^(la|les|le|des|un|une|the|a|an)\s/i.test(cmd)) {
                        const gen = await this.aiProvider.generateCommand(step.description, this.state._projectContext, this.state.getToolResultContext());
                        if (gen.ok && gen.reply) {
                            const cmdMatch = gen.reply.match(/CMD:\s*(.+)/);
                            cmd = cmdMatch ? _sanitizeCmd(cmdMatch[1].trim()) : null;
                            if (!cmd && gen.reply.includes('TOOL: write_file')) {
                                return await this._toolWriteFileFromAIReply(gen.reply, step.description);
                            }
                        }
                        if (!cmd) return { ok: false, error: `Impossible de déterminer la commande pour: ${step.description}` };
                    }
                    return await this._toolRunCommand(cmd);
                }

                case 'search_code': {
                    const pattern = parsed.arg || step.description.replace(/^(search|grep|find|chercher|trouver)\s*/i, '').trim();
                    return await this._toolSearchCode(pattern);
                }

                case 'git':
                    return await this._toolGit(step.description);

                // ── Sudo Studio tools ────────────────────────────────────────
                case 'sdk_analyze':
                    return await this._toolSdkAnalyze(parsed.arg || 'auto');

                case 'sdk_install':
                    return await this._toolSdkInstall(parsed.arg || 'node');

                case 'doctor_run':
                    return await this._toolDoctorRun();

                case 'autofix_apply':
                    return await this._toolAutofixApply(parsed.arg || '');

                case 'cicd_generate':
                    return await this._toolCICDGenerate(parsed.arg || 'all');

                case 'security_audit':
                    return await this._toolSecurityAudit(parsed.arg || 'all');

                case 'chat_query': {
                    const question = parsed.arg || step.description.replace(/TOOL:\s*chat_query\s*/i, '').trim();
                    return await this._toolChatQuery(question);
                }

                case 'ai_generate':
                    return await this._toolAIGenerateAction(step.description);

                default:
                    return await this._toolAIGenerateAction(step.description);
            }
        } catch (e) {
            console.error('[AGENT] _executeStep threw:', e.message);
            return { ok: false, error: e.message };
        }
    }

    // ── Standard Tools ────────────────────────────────────────────────────────

    async _toolReadFile(filePath) {
        this.state.log(`READ: ${filePath}`);
        const result = this.fileTool.readFile(filePath);
        this.state.filesRead.push(filePath);
        const resultStr = result.ok ? `${result.lines} lines` : result.error;
        this.state.addToolResult('read_file', { file: filePath }, resultStr);
        this._emit('tool_call', { tool: 'read_file', args: { file: filePath }, result: resultStr, ok: result.ok });
        if (result.ok) {
            this.state._projectContext += `\n\n--- ${filePath} (${result.lines} lines) ---\n${result.content.slice(0, 3000)}`;
        }
        return result;
    }

    async _toolWriteFile(filePath, content, reason = '') {
        // PROB 1: Validate workspace before writing
        if (!this._hasWorkspace && !path.isAbsolute(filePath)) {
            const msg = `Aucun dossier de projet ouvert. Ouvrez un dossier via Fichier > Ouvrir un Dossier avant d'écrire des fichiers.`;
            this.state.log(`WRITE BLOCKED (no workspace): ${filePath}`);
            this._emit('step', { phase: 'error', message: `⚠️ ${msg}` });
            return { ok: false, error: msg };
        }

        this.state.log(`WRITE: ${filePath}${reason ? ' — ' + reason : ''}`);
        const result = this.fileTool.writeFile(filePath, content);
        if (result.ok && !this.state.filesModified.includes(filePath)) {
            this.state.filesModified.push(filePath);
        }
        const resultStr = result.ok ? `✅ Written: ${filePath} (${content.length} bytes)` : `❌ ${result.error}`;
        this.state.addToolResult('write_file', { file: filePath }, resultStr);
        this._emit('tool_call', {
            tool: 'write_file',
            args: { file: filePath, reason, bytes: content.length },
            result: resultStr,
            ok: result.ok
        });
        if (!result.ok) {
            this._emit('step', {
                phase: 'step_error',
                message: `❌ Impossible d'écrire ${filePath}: ${result.error}`
            });
        }
        return result;
    }

    async _toolWriteFileFromAI(filePathHint, stepDescription) {
        const fp = (filePathHint || stepDescription)
            .replace(/TOOL:\s*write_file\s*[—-]?\s*/i, '')
            .trim()
            .split(/\s+/)[0];

        this._emit('step', { phase: 'step', message: `✍️ Génération du contenu pour ${fp}...` });

        const aiResult = await this.aiProvider.generateFileContent(
            fp, this.state.task, this.state._projectContext, this.state.getToolResultContext()
        );

        if (!aiResult.ok || !aiResult.reply) {
            return { ok: false, error: `AI failed to generate content for ${fp}: ${aiResult.error || 'empty reply'}` };
        }

        let content = aiResult.reply.trim();
        content = content.replace(/^```[\w]*\n?/, '').replace(/\n?```\s*$/, '').trim();
        return await this._toolWriteFile(fp, content, stepDescription);
    }

    async _toolWriteFileFromAIReply(aiReply, stepDescription) {
        const fileMatch    = aiReply.match(/FILE:\s*(.+)/);
        const contentMatch = aiReply.match(/CONTENT:\n([\s\S]+)/);
        if (!fileMatch) return { ok: false, error: 'AI reply missing FILE: field' };
        // PROB 1 FIX: Strip literal 'file:' prefix if small model copied the label verbatim
        let fp = fileMatch[1].trim();
        fp = _sanitizeFilePath(fp);
        if (!fp) return { ok: false, error: 'AI reply FILE: field is empty or invalid after sanitization' };
        let   content = contentMatch ? contentMatch[1].trim() : '';
        content = content.replace(/^```[\w]*\n?/, '').replace(/\n?```\s*$/, '').trim();
        if (!content) return await this._toolWriteFileFromAI(fp, stepDescription);
        return await this._toolWriteFile(fp, content, stepDescription);
    }

    async _toolRunCommand(cmd, options = {}) {
        // PROB 1 FIX: Strip 'CMD: ' literal prefix if small model echoed the label verbatim
        cmd = _sanitizeCmd(cmd);
        if (!cmd) return { ok: false, error: 'Commande vide après sanitisation — le modèle a généré une commande invalide.' };

        // PROB 1: Hallucination guard
        if (this.state) {
            const guard = hallucinationGuard(cmd, this.state.task);
            if (guard.suspect) {
                const msg = `Action ignorée : ${guard.reason}`;
                this.state.log(`HALLUCINATION GUARD: ${msg}`);
                this._emit('step', { phase: 'step_error', message: `🛡️ ${msg}` });
                this._emit('tool_call', { tool: 'run_command', args: { cmd }, result: `BLOCKED: ${msg}`, ok: false });
                return { ok: false, error: msg };
            }
        }

        if (DANGEROUS_PATTERNS.some(re => re.test(cmd))) {
            const approved = await this._requestApproval('DANGEROUS_COMMAND', `Run: ${cmd}`);
            if (!approved) {
                this.state.log(`REJECTED dangerous command: ${cmd}`);
                return { ok: false, error: 'Rejected by user' };
            }
        }

        this.state.log(`CMD: ${cmd}`);
        this._emit('tool_call', { tool: 'run_command', args: { cmd }, result: '…running…', ok: null });

        const result = await this.termTool.run(cmd, options);
        this.state.commandsExecuted.push({ cmd, exitCode: result.exitCode, ok: result.ok });

        const output = result.ok
            ? `✅ Exit 0 | ${result.stdout.slice(0, 600)}`
            : `❌ Exit ${result.exitCode} | STDERR: ${(result.stderr || result.stdout).slice(0, 600)}`;

        this.state.addToolResult('run_command', { cmd }, output);
        this._emit('tool_call', { tool: 'run_command', args: { cmd }, result: output, ok: result.ok, exitCode: result.exitCode });

        if (!result.ok) {
            this.state.errors.push({ cmd, stderr: (result.stderr || '').slice(0, 800), stdout: (result.stdout || '').slice(0, 400), exitCode: result.exitCode });
        }

        return result;
    }

    async _toolAIEdit(instruction) {
        const prompt = `INSTRUCTION: ${instruction}
CONTEXTE : ${this.state._projectContext.slice(0, 2000)}
RÉSULTATS PRÉCÉDENTS : ${this.state.getToolResultContext()}

Format EXACT :
FILE: <chemin>
OLD: <texte exact à remplacer>
NEW: <remplacement>

Si aucune modification : NO_EDIT_NEEDED`;

        const ai = await this.aiProvider.query(prompt, '', { max_tokens: 1000, temperature: 0.1 });
        if (!ai.ok || !ai.reply || ai.reply.includes('NO_EDIT_NEEDED')) {
            return { ok: true };
        }

        const fileMatch = ai.reply.match(/^FILE:\s*(.+)$/m);
        const oldMatch  = ai.reply.match(/^OLD:\s*([\s\S]+?)^NEW:/m);
        const newMatch  = ai.reply.match(/^NEW:\s*([\s\S]+)/m);

        if (fileMatch && oldMatch && newMatch) {
            const file   = fileMatch[1].trim();
            const oldTxt = oldMatch[1].trim();
            const newTxt = newMatch[1].trim();
            const r      = this.fileTool.editFile(file, oldTxt, newTxt);
            if (r.ok && !this.state.filesModified.includes(file)) this.state.filesModified.push(file);
            this.state.addToolResult('edit_file', { file, instruction }, r.ok ? 'Edit applied' : r.error);
            this._emit('tool_call', { tool: 'edit_file', args: { file, instruction }, result: r.ok ? `✅ Edit applied to ${file}` : `❌ ${r.error}`, ok: r.ok });
            return r;
        }

        return { ok: false, error: 'Could not parse AI edit response' };
    }

    async _toolSearchCode(pattern) {
        const result = this.fileTool.searchText(pattern, '.');
        const summary = result.ok ? `${result.matches.length} matches` : result.error;
        this.state.addToolResult('search_code', { pattern }, summary);
        this._emit('tool_call', { tool: 'search_code', args: { pattern }, result: summary, ok: result.ok });
        if (result.ok && result.matches.length) {
            this.state._projectContext += '\n\nSEARCH RESULTS:\n' +
                result.matches.slice(0, 10).map(m => `${m.file}:${m.line}: ${m.text}`).join('\n');
        }
        return result;
    }

    async _toolGit(instruction) {
        const isWrite = /commit|push|merge|rebase/i.test(instruction);
        if (isWrite) {
            const approved = await this._requestApproval('GIT_WRITE', instruction);
            if (!approved) return { ok: false, error: 'Git write rejected by user' };
        }
        let cmd;
        if (/status/i.test(instruction))      cmd = 'git status';
        else if (/diff/i.test(instruction))   cmd = 'git diff';
        else if (/log/i.test(instruction))    cmd = 'git log --oneline -10';
        else if (/commit/i.test(instruction)) {
            const msg = instruction.replace(/.*commit\s*/i, '').trim() || 'fix: agent auto-fix';
            await this._toolRunCommand('git add -A');
            cmd = `git commit -m "${msg}"`;
        } else {
            const cmdPart = instruction.replace(/^(git|TOOL:\s*git)\s*/i, '').trim();
            cmd = `git ${cmdPart}`;
        }
        return this._toolRunCommand(cmd);
    }

    async _toolAIGenerateAction(stepDescription) {
        this._emit('step', { phase: 'step', message: `🤔 IA génère l'action pour: ${stepDescription}...` });
        const gen = await this.aiProvider.generateCommand(stepDescription, this.state._projectContext, this.state.getToolResultContext());
        if (!gen.ok || !gen.reply) return { ok: false, error: `AI could not generate action: ${gen.error || 'no reply'}` };

        const reply = gen.reply.trim();
        if (reply.includes('TOOL: run_command') || reply.includes('CMD:')) {
            const cmdMatch = reply.match(/CMD:\s*(.+)/);
            if (cmdMatch) return await this._toolRunCommand(_sanitizeCmd(cmdMatch[1].trim()));
        }
        if (reply.includes('TOOL: write_file') || reply.includes('FILE:')) {
            return await this._toolWriteFileFromAIReply(reply, stepDescription);
        }
        if (reply.includes('TOOL: edit_file')) return await this._toolAIEdit(stepDescription);
        if (reply.includes('TOOL: read_file')) {
            const m = reply.match(/FILE:\s*(.+)/);
            if (m) return await this._toolReadFile(m[1].trim());
        }
        if (reply.includes('TOOL: search_code')) {
            const m = reply.match(/PATTERN:\s*(.+)/);
            if (m) return await this._toolSearchCode(m[1].trim());
        }

        return { ok: false, error: 'AI reply format not parseable' };
    }

    // ── Sudo Studio Tools ─────────────────────────────────────────────────────

    async _toolSdkAnalyze(projectType) {
        this._emit('step', { phase: 'step', message: `🔧 Analyse des SDK requis (projet: ${projectType})...` });
        const result = await this.sudoTools.analyzeSDK(projectType);
        const summary = result.missing.length > 0
            ? `❌ SDKs manquants: ${result.missing.join(', ')}`
            : `✅ Tous les SDKs requis sont installés`;
        this.state.addToolResult('sdk_analyze', { projectType }, summary);
        this._emit('tool_call', { tool: 'sdk_analyze', args: { projectType }, result: summary, ok: result.ok });
        // Log each line to step output
        for (const line of result.logs) {
            this._emit('step', { phase: 'step', message: line });
        }
        if (result.missing.length > 0) {
            this.state._projectContext += `\n\nSDK ANALYSIS:\nMissing: ${result.missing.join(', ')}\nFound: ${result.found.map(f => `${f.name} ${f.version}`).join(', ')}`;
        }
        return result;
    }

    async _toolSdkInstall(sdkName) {
        this._emit('step', { phase: 'step', message: `📦 Installation SDK: ${sdkName}...` });
        const result = await this.sudoTools.installSDK(sdkName);
        const summary = result.installed ? `✅ ${sdkName} installé` : `⚠️ ${sdkName}: installation manuelle requise`;
        this.state.addToolResult('sdk_install', { sdk: sdkName }, summary);
        this._emit('tool_call', { tool: 'sdk_install', args: { sdk: sdkName }, result: summary, ok: result.ok });
        for (const line of result.logs || []) {
            this._emit('step', { phase: 'step', message: line });
        }
        if (result.manualGuide) {
            this._emit('step', { phase: 'step', message: `📖 Guide: ${result.manualGuide}` });
        }
        return result;
    }

    async _toolDoctorRun() {
        this._emit('step', { phase: 'step', message: '🩺 Diagnostic Sudo Studio en cours...' });
        const result = await this.sudoTools.runDoctor();
        const summary = result.issues.length > 0
            ? `⚠️ ${result.issues.length} problème(s): ${result.issues.join(', ')}`
            : `✅ Système OK — runtime ${result.status || 'healthy'}`;
        this.state.addToolResult('doctor_run', {}, summary);
        this._emit('tool_call', { tool: 'doctor_run', args: {}, result: summary, ok: result.ok });
        for (const line of result.logs || []) {
            this._emit('step', { phase: 'step', message: line });
        }
        return result;
    }

    async _toolAutofixApply(fileHint) {
        this._emit('step', { phase: 'step', message: '🔧 Application AutoFix...' });
        const result = await this.sudoTools.applyAutoFix(fileHint);
        const summary = `AutoFix: ${result.fixed} outil(s) exécuté(s)`;
        this.state.addToolResult('autofix_apply', { file: fileHint }, summary);
        this._emit('tool_call', { tool: 'autofix_apply', args: { file: fileHint }, result: summary, ok: result.ok });
        for (const line of result.logs || []) {
            this._emit('step', { phase: 'step', message: line });
        }
        return result;
    }

    async _toolCICDGenerate(target) {
        this._emit('step', { phase: 'step', message: `🚀 Génération CI/CD: ${target}...` });
        const result = await this.sudoTools.generateCICD(target);
        const summary = result.ok
            ? `✅ ${result.created.length} fichier(s) CI/CD créés: ${result.created.join(', ')}`
            : `❌ Erreur CI/CD: ${result.error || 'unknown'}`;
        this.state.addToolResult('cicd_generate', { target }, summary);
        this._emit('tool_call', { tool: 'cicd_generate', args: { target }, result: summary, ok: result.ok });
        for (const line of result.logs || []) {
            this._emit('step', { phase: 'step', message: line });
        }
        for (const f of result.created || []) {
            if (!this.state.filesModified.includes(f)) this.state.filesModified.push(f);
        }
        return result;
    }

    async _toolSecurityAudit(scope) {
        this._emit('step', { phase: 'step', message: `🔒 Audit sécurité (scope: ${scope})...` });
        const result = await this.sudoTools.runSecurityAudit(scope);
        const summary = `Score: ${result.score}/100 | ${result.findings.length} finding(s)`;
        this.state.addToolResult('security_audit', { scope }, summary);
        this._emit('tool_call', { tool: 'security_audit', args: { scope }, result: summary, ok: result.ok });
        for (const line of result.logs || []) {
            this._emit('step', { phase: 'step', message: line });
        }
        if (result.findings.length > 0) {
            this._emit('step', {
                phase: 'step',
                message: `🔒 Findings:\n${result.findings.map(f => `  [${f.severity}] ${f.label} ${f.file || ''}`).join('\n')}`
            });
        }
        return result;
    }

    async _toolChatQuery(question) {
        this._emit('step', { phase: 'step', message: `💬 Requête IA: ${question.slice(0, 80)}...` });
        const result = await this.sudoTools.chatQuery(question);
        const summary = result.ok ? `Reply (${result.reply.length} chars)` : `Error: ${result.error}`;
        this.state.addToolResult('chat_query', { question }, summary);
        this._emit('tool_call', { tool: 'chat_query', args: { question }, result: summary, ok: result.ok });
        if (result.ok && result.reply) {
            this.state._projectContext += `\n\nAI ANSWER to "${question.slice(0, 60)}":\n${result.reply.slice(0, 1000)}`;
            this._emit('step', { phase: 'step', message: `💬 Réponse IA: ${result.reply.slice(0, 300)}` });
        }
        return result;
    }

    // ── Verify ────────────────────────────────────────────────────────────────

    async _verify() {
        this._emit('step', { phase: 'verify', message: '🔍 Vérification du résultat...' });

        // PROB 2 FIX (a): All files listed in state.filesModified must exist on disk
        const filesOk = this.state.filesModified.every(f => {
            const r = this.fileTool.readFile(f);
            if (!r.ok) { this.state.log(`VERIFY FAIL: file not found on disk: ${f}`); return false; }
            return true;
        });
        if (!filesOk) {
            this._emit('step', { phase: 'verify', message: '❌ Vérification ÉCHEC — un ou plusieurs fichiers censés avoir été créés sont absents du disque.' });
            return false;
        }

        // PROB 2 FIX (b): Extract explicit filenames from the user's task and verify they exist
        const taskFileMentions = (this.state.task.match(/[\w./\\-]+\.(?:py|js|ts|dart|go|rs|java|cs|cpp|rb|php|html|css|json|yaml|yml|md|txt|sh|ps1)/gi) || []);
        for (const mention of taskFileMentions) {
            const basename = path.basename(mention);
            const r = this.fileTool.readFile(basename);
            if (!r.ok) {
                // Also try as a path relative to root
                const r2 = this.fileTool.readFile(mention.replace(/\\/g, '/'));
                if (!r2.ok) {
                    this.state.log(`VERIFY FAIL: task mentioned '${mention}' but it does not exist on disk`);
                    this._emit('step', {
                        phase: 'verify',
                        message: `❌ Vérification ÉCHEC — le fichier '${mention}' demandé dans la tâche n'existe pas sur le disque.`
                    });
                    return false;
                }
            }
        }

        // PROB 2 FIX (c): If there are critical command failures AND no files were created → fail
        const criticalErrors = this.state.errors.filter(e => e.exitCode !== 0);
        if (criticalErrors.length > 0 && this.state.filesModified.length === 0) {
            this._emit('step', { phase: 'verify', message: `❌ Vérification ÉCHEC — ${criticalErrors.length} erreur(s) de commande et aucun fichier créé.` });
            return false;
        }

        // Run npm test if available
        const pkg = this.fileTool.readFile('package.json');
        if (pkg.ok) {
            try {
                const p = JSON.parse(pkg.content);
                if (p.scripts?.test) {
                    const r = await this._toolRunCommand('npm test -- --passWithNoTests 2>&1 || npm test 2>&1', { timeout: 30000 });
                    if (r.ok) { this._emit('step', { phase: 'verify', message: '✅ Tests passent' }); return true; }
                    return false;
                }
            } catch (_) {}
        }

        this._emit('step', { phase: 'verify', message: '✅ Vérification OK — fichiers présents sur disque' });
        return true;
    }

    // ── Diagnose & Repair ─────────────────────────────────────────────────────

    async _diagnoseAndRepair() {
        this._emit('step', { phase: 'diagnose', message: '🔬 Diagnostic automatique...' });
        const lastErrors = this.state.errors.slice(-3);
        if (!lastErrors.length) return;

        // PROB 3 FIX: Detect identical consecutive errors — avoid cosmetic-variation loop
        if (lastErrors.length >= 2) {
            const last  = lastErrors[lastErrors.length - 1];
            const prev  = lastErrors[lastErrors.length - 2];
            // Same stderr (trimmed) = same error, different cmd escape = cosmetic fix that didn't work
            const sameStderr = last.stderr && prev.stderr &&
                last.stderr.trim().slice(0, 120) === prev.stderr.trim().slice(0, 120);
            if (sameStderr) {
                this._emit('step', {
                    phase: 'diagnose',
                    message: '⚠️ L\'erreur est identique à la tentative précédente — la correction n\'a rien changé. Abandon de la boucle de réparation.'
                });
                // Don't loop endlessly — mark as failed so the outer loop stops cleanly
                this.state.finalStatus = 'failed';
                this.state.errors.push('Auto-repair aborted: consecutive identical errors detected. Check the command syntax manually.');
                return;
            }
        }

        const errorContext = lastErrors.map(e =>
            `CMD: ${e.cmd}\nEXIT CODE: ${e.exitCode}\nSTDERR:\n${e.stderr}\nSTDOUT:\n${e.stdout || ''}`
        ).join('\n\n---\n\n');

        const diagnosis = await this.aiProvider.diagnose(errorContext, this.state._projectContext.slice(0, 2000));
        if (diagnosis.ok && diagnosis.reply) {
            const diagMsg = diagnosis.reply.slice(0, 200);
            this._emit('step', { phase: 'diagnose', message: '🩺 ' + diagMsg, data: { diagnosis: diagnosis.reply } });
            const toolParsed = parseStepToTool(diagnosis.reply);
            if (toolParsed.type !== 'ai_generate') {
                const repairDesc = diagnosis.reply.split('\n').find(l => l.includes('TOOL:')) || diagnosis.reply.slice(0, 150);
                this.state.currentPlan.push({ step: this.state.currentPlan.length + 1, description: repairDesc, status: 'pending' });
            }
        }
    }

    // ── Approval system ───────────────────────────────────────────────────────

    _requestApproval(type, description) {
        return new Promise((resolve) => {
            this._approvalQueue.push(resolve);
            this.state.finalStatus = 'awaiting_approval';
            this._emit('approval_needed', { action: type, description, resolve });
        });
    }

    // ── Finish ────────────────────────────────────────────────────────────────

    _finish(status) {
        this.state.finalStatus = status;
        this.state.persist(this.projectRoot);
        const summary = this.state.toSummary();
        const statusEmoji = { success: '✅', failed: '❌', stopped: '⏹', awaiting_approval: '⏸' };
        this._emit('done', {
            status, emoji: statusEmoji[status] || '❓',
            summary,
            filesModified:  this.state.filesModified,
            commandsRun:    this.state.commandsExecuted.map(c => c.cmd),
            testResults:    this.state.testResults,
        });
        return summary;
    }

    _emit(event, data) {
        this.emit(event, data);
    }
}

module.exports = { AgentEngine, AgentState, FileTool, TerminalTool, GitTool, AIProvider, MCPClient, SudoTools };
