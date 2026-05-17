#!/usr/bin/env python3
"""
Sudo Studio Runtime Manager
Automatically downloads and starts AI models on first run
"""

import os
import sys
import subprocess
import json
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger('runtime-manager')

RUNTIME_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_CONFIG = os.path.join(RUNTIME_DIR, 'models.json')
DEFAULT_MODEL = 'Qwen/Qwen2.5-Coder-1.5B-Instruct'

def check_dependencies():
    """Check if required dependencies are installed"""
    try:
        import transformers
        import torch
        import flask
        import flask_cors
        logger.info("✓ All dependencies installed")
        return True
    except ImportError as e:
        logger.error(f"Missing dependency: {e}")
        logger.info("Installing dependencies...")
        subprocess.check_call([
            sys.executable, '-m', 'pip', 'install',
            'transformers', 'torch', 'flask', 'flask-cors', '--quiet'
        ])
        return True

def load_models_config():
    """Load models configuration"""
    if os.path.exists(MODELS_CONFIG):
        with open(MODELS_CONFIG) as f:
            return json.load(f)
    return {'current_model': None, 'available_models': []}

def save_models_config(config):
    """Save models configuration"""
    with open(MODELS_CONFIG, 'w') as f:
        json.dump(config, f, indent=2)

def start_runtime(model=None, port=6000):
    """Start the Python runtime server"""
    server_path = os.path.join(RUNTIME_DIR, 'server.py')
    
    cmd = [sys.executable, server_path, '--port', str(port)]
    
    if model:
        cmd.extend(['--model', model])
    else:
        cmd.append('--auto-download')
    
    logger.info(f"Starting runtime: {' '.join(cmd)}")
    
    try:
        subprocess.run(cmd)
    except KeyboardInterrupt:
        logger.info("Runtime stopped by user")

def main():
    import argparse
    parser = argparse.ArgumentParser(description='Sudo Studio Runtime Manager')
    parser.add_argument('--model', help='Model to load')
    parser.add_argument('--port', type=int, default=6000, help='Port')
    parser.add_argument('--install-deps', action='store_true', help='Install dependencies')
    
    args = parser.parse_args()
    
    # Check/install dependencies
    if args.install_deps or not check_dependencies():
        check_dependencies()
    
    # Load configuration
    config = load_models_config()
    
    # Determine which model to use
    model = args.model or config.get('current_model') or DEFAULT_MODEL
    
    logger.info(f"Selected model: {model}")
    
    # Save configuration
    config['current_model'] = model
    save_models_config(config)
    
    # Start runtime
    start_runtime(model, args.port)

if __name__ == '__main__':
    main()
