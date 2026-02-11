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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// API endpoints
app.get('/api/models', (req, res) => {
  const models = aiModelsManager.listModels();
  res.json(models);
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

  socket.on('disconnect', () => {
    console.log('Un utilisateur s\'est déconnecté');
  });
});

startServer(PORT);