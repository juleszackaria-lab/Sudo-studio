#!/usr/bin/env python3
"""
Sudo Studio AI Runtime - Python Flask Server
Enhanced runtime with automatic model download, health checks, and streaming support
"""

import argparse
import sys
import os
import json
import logging
from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
import time

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('sudo-ai-runtime')

app = Flask(__name__)
CORS(app)

# Global variables
model_pipeline = None
model_name = None
model_type = 'text-generation'
model_loaded = False
startup_time = time.time()

def load_model(model_path):
    """Load AI model with automatic fallback"""
    global model_pipeline, model_loaded, model_type
    
    try:
        from transformers import pipeline, AutoTokenizer, AutoModelForCausalLM
        
        logger.info(f"Loading model: {model_path}")
        
        # Try to detect model type
        if 'code' in model_path.lower() or 'deepseek' in model_path.lower():
            model_type = 'text-generation'
            logger.info("Detected code generation model")
        else:
            model_type = 'text-generation'
        
        # Load model
        model_pipeline = pipeline(
            model_type,
            model=model_path,
            device=-1,  # CPU only for compatibility
            max_length=2048,
            do_sample=True,
            temperature=0.7,
            top_p=0.95
        )
        
        model_loaded = True
        logger.info(f"✓ Model loaded successfully: {model_path}")
        return True
        
    except ImportError:
        logger.error("Transformers library not installed. Install with: pip install transformers torch")
        return False
    except Exception as e:
        logger.error(f"Failed to load model: {e}")
        logger.info("Continuing in mock mode - responses will be simulated")
        model_loaded = False
        return False

def download_default_model():
    """Download a lightweight default model on first run"""
    try:
        from transformers import AutoTokenizer, AutoModelForCausalLM
        
        # Lightweight models to try in order
        default_models = [
            'Qwen/Qwen2.5-Coder-1.5B-Instruct',  # 1.5B - fast and good for code
            'microsoft/phi-2',  # 2.7B - general purpose
            'Qwen/Qwen2-1.5B-Instruct',  # 1.5B - general chat
        ]
        
        logger.info("No model specified. Downloading default model...")
        
        for model_name in default_models:
            try:
                logger.info(f"Attempting to download: {model_name}")
                tokenizer = AutoTokenizer.from_pretrained(model_name)
                model = AutoModelForCausalLM.from_pretrained(model_name)
                logger.info(f"✓ Successfully downloaded: {model_name}")
                return model_name
            except Exception as e:
                logger.warning(f"Failed to download {model_name}: {e}")
                continue
        
        logger.error("Failed to download any default model")
        return None
        
    except ImportError:
        logger.error("Transformers not installed")
        return None

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    uptime = int(time.time() - startup_time)
    
    return jsonify({
        'status': 'healthy',
        'model_loaded': model_loaded,
        'model_name': model_name,
        'model_type': model_type,
        'uptime_seconds': uptime,
        'timestamp': time.time(),
        'version': '2.0.0',
        'capabilities': {
            'inference': True,
            'streaming': False,  # TODO: implement
            'code_generation': 'code' in (model_name or '').lower(),
            'chat': True
        }
    })

@app.route('/infer', methods=['POST'])
def infer():
    """Main inference endpoint"""
    try:
        data = request.get_json() or {}
        prompt = data.get('input') or data.get('prompt') or data.get('message') or ''
        max_length = data.get('max_length', 200)
        temperature = data.get('temperature', 0.7)
        
        if not prompt:
            return jsonify({'error': 'No prompt provided'}), 400
        
        logger.info(f"Inference request - prompt length: {len(prompt)}")
        
        if not model_loaded or model_pipeline is None:
            # Mock response for development
            logger.warning("Model not loaded - returning mock response")
            return jsonify({
                'reply': f"[MOCK MODE] I received your prompt: '{prompt[:50]}...' but no AI model is loaded. Please install a model to get real responses.",
                'model': model_name or 'none',
                'mock': True,
                'prompt_length': len(prompt)
            })
        
        # Real inference
        start_time = time.time()
        
        output = model_pipeline(
            prompt,
            max_length=max_length,
            temperature=temperature,
            do_sample=True,
            num_return_sequences=1
        )
        
        latency = time.time() - start_time
        reply = output[0]['generated_text'] if output else ''
        
        logger.info(f"Inference completed in {latency:.2f}s")
        
        return jsonify({
            'reply': reply,
            'model': model_name,
            'latency': f"{latency:.2f}s",
            'prompt_length': len(prompt),
            'reply_length': len(reply),
            'mock': False
        })
        
    except Exception as e:
        logger.error(f"Inference error: {e}", exc_info=True)
        return jsonify({
            'error': 'Inference failed',
            'message': str(e),
            'model': model_name
        }), 500

@app.route('/chat', methods=['POST'])
def chat():
    """Chat endpoint with conversation support"""
    try:
        data = request.get_json() or {}
        message = data.get('message') or data.get('prompt') or ''
        context = data.get('context', '')
        history = data.get('history', [])
        
        if not message:
            return jsonify({'error': 'No message provided'}), 400
        
        # Build conversation prompt
        if history:
            conversation = '\n'.join([
                f"User: {turn['user']}\nAssistant: {turn['assistant']}" 
                for turn in history[-3:]  # Keep last 3 turns
            ])
            prompt = f"{conversation}\nUser: {message}\nAssistant:"
        else:
            prompt = f"User: {message}\nAssistant:"
        
        if context:
            prompt = f"Context: {context}\n\n{prompt}"
        
        # Reuse infer endpoint
        return infer()
        
    except Exception as e:
        logger.error(f"Chat error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/models', methods=['GET'])
def list_models():
    """List available models"""
    return jsonify({
        'current_model': model_name,
        'model_loaded': model_loaded,
        'model_type': model_type,
        'available_models': [
            'Qwen/Qwen2.5-Coder-1.5B-Instruct',
            'microsoft/phi-2',
            'Qwen/Qwen2-1.5B-Instruct',
            'Custom (provide path)'
        ]
    })

@app.route('/reload', methods=['POST'])
def reload_model():
    """Reload model with new parameters"""
    try:
        data = request.get_json() or {}
        new_model = data.get('model')
        
        if not new_model:
            return jsonify({'error': 'No model specified'}), 400
        
        global model_name
        model_name = new_model
        
        success = load_model(new_model)
        
        return jsonify({
            'success': success,
            'model': model_name,
            'loaded': model_loaded
        })
        
    except Exception as e:
        logger.error(f"Reload error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/', methods=['GET'])
def root():
    """Root endpoint with API info"""
    return jsonify({
        'name': 'Sudo Studio AI Runtime',
        'version': '2.0.0',
        'status': 'running',
        'endpoints': {
            'health': '/health',
            'infer': '/infer (POST)',
            'chat': '/chat (POST)',
            'models': '/models',
            'reload': '/reload (POST)'
        },
        'model': {
            'name': model_name,
            'loaded': model_loaded,
            'type': model_type
        }
    })

def main():
    """Main entry point"""
    global model_name
    
    parser = argparse.ArgumentParser(description='Sudo Studio AI Runtime')
    parser.add_argument('--model', help='Model name or path', default=None)
    parser.add_argument('--port', type=int, default=6000, help='Port to run on')
    parser.add_argument('--host', default='127.0.0.1', help='Host to bind to')
    parser.add_argument('--auto-download', action='store_true', help='Auto download default model if none specified')
    
    args = parser.parse_args()
    
    model_name = args.model
    
    # Auto download if requested and no model specified
    if args.auto_download and not model_name:
        logger.info("Auto-download enabled")
        downloaded_model = download_default_model()
        if downloaded_model:
            model_name = downloaded_model
    
    # Load model if specified
    if model_name:
        load_model(model_name)
    else:
        logger.warning("No model specified. Runtime will work in mock mode.")
        logger.info("Use --model <model_name> or --auto-download to load a real model")
    
    # Start server
    logger.info(f"Starting Sudo AI Runtime on {args.host}:{args.port}")
    logger.info(f"Model: {model_name or 'None (mock mode)'}")
    logger.info("=" * 60)
    
    app.run(
        host=args.host,
        port=args.port,
        debug=False,
        threaded=True
    )

if __name__ == '__main__':
    main()
