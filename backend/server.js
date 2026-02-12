const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const aiModelsManager = require('./ai/aiModelsManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:5173'],
    methods: ['GET', 'POST'],
  },
});

let PORT = process.env.PORT || 5000;

const startServer = (port) => {
  server.listen(port, () => {
    console.log(`Serveur en cours d'exécution sur http://localhost:${port}`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} en cours d'utilisation, tentative avec un autre port...`);
      startServer(port + 1);
    } else {
      console.error('Erreur lors du démarrage du serveur :', err);
    }
  });
};

app.use(express.static(path.join(__dirname, '../dist')));
app.use(express.json()); // Middleware to parse JSON bodies

// Serve simple web UI for chat and model management
app.use('/ui', express.static(path.join(__dirname, '../web-ui')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// API endpoints
app.get('/api/models', (req, res) => {
  const models = aiModelsManager.listModels();
  res.json(models);
});

app.get('/api/models/:modelName', (req, res) => {
  const info = aiModelsManager.getModelInfo(req.params.modelName);
  if (!info) return res.status(404).json({ error: 'Model not found' });
  res.json(info);
});

app.post('/api/models/start', (req, res) => {
  const { modelName } = req.body;
  if (!modelName) return res.status(400).json({ error: 'modelName required' });
  try {
    const state = aiModelsManager.startModel(modelName);
    res.json({ message: 'started', state });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/models/stop', (req, res) => {
  const { modelName } = req.body;
  if (!modelName) return res.status(400).json({ error: 'modelName required' });
  try {
    aiModelsManager.stopModel(modelName);
    res.json({ message: 'stopped' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/models/infer', async (req, res) => {
  const { modelName, input } = req.body;
  try {
    const out = await aiModelsManager.infer(modelName, input);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/models/download', async (req, res) => {
  const { modelName, url } = req.body;

  if (!modelName || !url) {
    return res.status(400).json({ error: 'Model name and URL are required.' });
  }

  try {
    const modelPath = await aiModelsManager.downloadModel(modelName, url);
    res.json({ message: `Model ${modelName} downloaded successfully.`, path: modelPath });
  } catch (error) {
    res.status(500).json({ error: 'Failed to download model.' });
  }
});

// Chat endpoint: frontend posts { modelName, prompt }
app.post('/api/chat', async (req, res) => {
  const { modelName, prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });

  const available = aiModelsManager.listModels();
  if (modelName && !available.includes(modelName)) {
    return res.status(400).json({ error: `Model ${modelName} not available on server.` });
  }

  // Placeholder: here you would load the model and run inference.
  // For now we respond with a simulated reply referencing the prompt.
  const reply = `Réponse simulée pour le prompt: "${prompt}"`;
  res.json({ reply });
});

app.delete('/api/models/:modelName', (req, res) => {
  const { modelName } = req.params;

  try {
    aiModelsManager.deleteModel(modelName);
    res.json({ message: `Model ${modelName} deleted successfully.` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete model.' });
  }
});

io.on('connection', (socket) => {
  console.log('Un utilisateur est connecté');

  socket.on('chat-message', async (data) => {
    // data: { modelName, prompt }
    const { modelName, prompt } = data || {};
    const reply = `Réponse simulée: ${prompt || ''}`;
    socket.emit('chat-response', { reply });
  });

  socket.on('disconnect', () => {
    console.log('Un utilisateur s\'est déconnecté');
  });
});

startServer(PORT);