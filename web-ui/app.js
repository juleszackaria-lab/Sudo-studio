const socket = io();

// Terminal panes
const top = document.getElementById('terminal-top');
const bottom = document.getElementById('terminal-bottom');
const cmdInput = document.getElementById('cmd-input');
const cmdSend = document.getElementById('cmd-send');

const appendTop = (t)=>{top.textContent += '\n' + t; top.scrollTop = top.scrollHeight}
const appendBottom = (t)=>{bottom.textContent += '\n' + t; bottom.scrollTop = bottom.scrollHeight}

cmdSend.addEventListener('click', async ()=>{
  const v = cmdInput.value.trim();
  if(!v) return;
  appendBottom('> ' + v);
  // Simple command parser
  if (v === 'list-models'){
    const res = await fetch('/api/models');
    const arr = await res.json();
    appendBottom('models: ' + JSON.stringify(arr));
  } else if (v.startsWith('download:')){
    const [,rest] = v.split(':');
    const [name,url] = rest.split('|');
    appendBottom(`Request download ${name}`);
    const r = await fetch('/api/models/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({modelName:name,url})});
    const j = await r.json();
    appendBottom('Response: ' + JSON.stringify(j));
  } else {
    // emulate a response
    appendBottom('Emulate: commande non reconnue');
  }
});

// Chat
const chatWindow = document.getElementById('chat-window');
const modelNameInput = document.getElementById('model-name');
const promptInput = document.getElementById('prompt');
const sendPromptBtn = document.getElementById('send-prompt');

const appendChat = (who,text)=>{
  const el = document.createElement('div'); el.textContent = `${who}: ${text}`; chatWindow.appendChild(el); chatWindow.scrollTop = chatWindow.scrollHeight;
}

sendPromptBtn.addEventListener('click', async ()=>{
  const modelName = modelNameInput.value.trim();
  const prompt = promptInput.value.trim();
  if(!prompt) return;
  appendChat('You', prompt);
  // try socket first
  socket.emit('chat-message', { modelName, prompt });
  // also call REST endpoint
  const r = await fetch('/api/chat', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({modelName,prompt})});
  const j = await r.json();
  appendChat('AI', j.reply || JSON.stringify(j));
});

socket.on('chat-response', (data)=>{
  if(data && data.reply) appendChat('AI(socket)', data.reply);
});

// Models management
document.getElementById('list-models').addEventListener('click', async ()=>{
  const r = await fetch('/api/models'); const arr = await r.json();
  const ul = document.getElementById('models-list'); ul.innerHTML=''; arr.forEach(m=>{const li=document.createElement('li');li.textContent=m;ul.appendChild(li)});
});

document.getElementById('download-model').addEventListener('click', async ()=>{
  const v = document.getElementById('model-to-download').value.trim();
  if(!v) return; const [name,url] = v.split('|');
  const r = await fetch('/api/models/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({modelName:name,url})});
  const j = await r.json(); alert(JSON.stringify(j));
});
