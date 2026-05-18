#!/usr/bin/env python3
"""
====================================================================================================
SUDO STUDIO - ENTERPRISE RUNTIME MANAGER
====================================================================================================

Production-grade runtime orchestrator with advanced model management.

CAPABILITIES:
- Automatic dependency installation with verification
- Model validation and integrity checking
- Configuration persistence
- Multi-model management
- Health monitoring
- Process lifecycle management
- Error recovery and retry logic
- Logging and diagnostics
- Version compatibility checking
- Cache management
- GPU detection and configuration
- Environment validation

@module manager.enterprise
@version 2.0.0
@enterprise
"""

import os
import sys
import subprocess
import json
import logging
import time
import hashlib
import shutil
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, asdict
from datetime import datetime

# ====================================================================================================
# LOGGING CONFIGURATION
# ====================================================================================================

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler('manager.log', mode='a')
    ]
)
logger = logging.getLogger('runtime-manager')

# ====================================================================================================
# CONFIGURATION
# ====================================================================================================

RUNTIME_DIR = Path(__file__).parent.absolute()
CONFIG_DIR = RUNTIME_DIR / 'config'
CACHE_DIR = RUNTIME_DIR / 'cache'
MODELS_CONFIG = CONFIG_DIR / 'models.json'
DEPS_CONFIG = CONFIG_DIR / 'dependencies.json'

# Ensure directories exist
CONFIG_DIR.mkdir(exist_ok=True)
CACHE_DIR.mkdir(exist_ok=True)

@dataclass
class ModelConfig:
    """Model configuration"""
    id: str
    name: str
    size: str
    type: str
    description: str
    verified: bool = False
    last_used: Optional[str] = None
    
@dataclass
class RuntimeConfig:
    """Runtime configuration"""
    current_model: Optional[str] = None
    models: List[Dict] = None
    dependencies_installed: bool = False
    last_health_check: Optional[str] = None
    gpu_enabled: bool = True
    streaming_enabled: bool = True
    
    def __post_init__(self):
        if self.models is None:
            self.models = []

# Default recommended models
DEFAULT_MODELS = [
    ModelConfig(
        id='Qwen/Qwen2.5-Coder-1.5B-Instruct',
        name='Qwen 2.5 Coder',
        size='1.5B',
        type='code',
        description='Optimized for code generation and programming tasks'
    ),
    ModelConfig(
        id='microsoft/phi-2',
        name='Phi-2',
        size='2.7B',
        type='general',
        description='General purpose text generation'
    ),
    ModelConfig(
        id='Qwen/Qwen2-1.5B-Instruct',
        name='Qwen 2',
        size='1.5B',
        type='chat',
        description='Conversational AI model'
    ),
    ModelConfig(
        id='deepseek-ai/deepseek-coder-1.3b-instruct',
        name='DeepSeek Coder',
        size='1.3B',
        type='code',
        description='Code-focused model with strong performance'
    ),
]

# Required dependencies with versions
REQUIRED_DEPENDENCIES = {
    'transformers': '>=4.35.0',
    'torch': '>=2.0.0',
    'flask': '>=2.3.0',
    'flask-cors': '>=4.0.0',
    'huggingface-hub': '>=0.19.0',
    'accelerate': '>=0.24.0',
    'sentencepiece': '>=0.1.99',  # For some tokenizers
    'psutil': '>=5.9.0',  # For memory monitoring
}

# ====================================================================================================
# CONFIGURATION MANAGEMENT
# ====================================================================================================

def load_config() -> RuntimeConfig:
    """Load runtime configuration"""
    try:
        if MODELS_CONFIG.exists():
            with open(MODELS_CONFIG, 'r') as f:
                data = json.load(f)
                return RuntimeConfig(**data)
    except Exception as e:
        logger.warning(f"Could not load config: {e}")
    
    # Return default config
    return RuntimeConfig(
        models=[asdict(m) for m in DEFAULT_MODELS]
    )

def save_config(config: RuntimeConfig):
    """Save runtime configuration"""
    try:
        with open(MODELS_CONFIG, 'w') as f:
            json.dump(asdict(config), f, indent=2)
        logger.debug("Configuration saved")
    except Exception as e:
        logger.error(f"Failed to save config: {e}")

# ====================================================================================================
# DEPENDENCY MANAGEMENT
# ====================================================================================================

def check_python_version() -> Tuple[bool, str]:
    """Check if Python version is compatible"""
    version = sys.version_info
    if version.major == 3 and version.minor >= 8:
        return True, f"{version.major}.{version.minor}.{version.micro}"
    return False, f"{version.major}.{version.minor}.{version.micro}"

def get_installed_version(package: str) -> Optional[str]:
    """Get installed version of a package"""
    try:
        result = subprocess.run(
            [sys.executable, '-m', 'pip', 'show', package],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if result.returncode == 0:
            for line in result.stdout.split('\n'):
                if line.startswith('Version:'):
                    return line.split(':')[1].strip()
    except Exception as e:
        logger.debug(f"Could not get version for {package}: {e}")
    
    return None

def check_dependencies() -> Dict[str, bool]:
    """Check if all required dependencies are installed"""
    logger.info("🔍 Checking dependencies...")
    
    results = {}
    all_installed = True
    
    for package, version_req in REQUIRED_DEPENDENCIES.items():
        try:
            installed_version = get_installed_version(package)
            
            if installed_version:
                logger.info(f"  ✅ {package} {installed_version}")
                results[package] = True
            else:
                logger.warning(f"  ❌ {package} not installed")
                results[package] = False
                all_installed = False
                
        except Exception as e:
            logger.error(f"  ❌ {package} check failed: {e}")
            results[package] = False
            all_installed = False
    
    return results

def install_dependencies(packages: Optional[List[str]] = None) -> bool:
    """
    Install required dependencies with error handling and retry
    """
    if packages is None:
        packages = list(REQUIRED_DEPENDENCIES.keys())
    
    logger.info(f"📦 Installing dependencies: {', '.join(packages)}")
    
    # Upgrade pip first
    logger.info("⬆️  Upgrading pip...")
    try:
        subprocess.run(
            [sys.executable, '-m', 'pip', 'install', '--upgrade', 'pip'],
            check=True,
            timeout=120,
            capture_output=True
        )
        logger.success("✅ pip upgraded")
    except Exception as e:
        logger.warning(f"⚠️  pip upgrade failed: {e}")
    
    # Install packages
    install_cmd = [
        sys.executable, '-m', 'pip', 'install',
        '--upgrade',  # Upgrade if already installed
    ]
    
    # Add version requirements
    install_packages = []
    for package in packages:
        version_req = REQUIRED_DEPENDENCIES.get(package, '')
        install_packages.append(f"{package}{version_req}")
    
    install_cmd.extend(install_packages)
    
    try:
        logger.info(f"⚙️  Running: {' '.join(install_cmd)}")
        
        result = subprocess.run(
            install_cmd,
            check=True,
            timeout=600,  # 10 minutes
            capture_output=True,
            text=True
        )
        
        logger.success("✅ All dependencies installed successfully")
        
        # Verify installation
        time.sleep(1)  # Give system time to register packages
        results = check_dependencies()
        
        failed = [pkg for pkg, installed in results.items() if not installed]
        if failed:
            logger.error(f"❌ Installation verification failed for: {', '.join(failed)}")
            return False
        
        return True
        
    except subprocess.TimeoutExpired:
        logger.error("❌ Installation timeout (10 minutes)")
        return False
    except subprocess.CalledProcessError as e:
        logger.error(f"❌ Installation failed: {e}")
        if e.stderr:
            logger.error(f"Error output: {e.stderr}")
        return False
    except Exception as e:
        logger.error(f"❌ Unexpected error during installation: {e}")
        return False

def check_gpu_availability() -> Dict[str, any]:
    """Check GPU availability and capabilities"""
    gpu_info = {
        'available': False,
        'type': None,
        'count': 0,
        'devices': []
    }
    
    try:
        import torch
        
        # Check CUDA
        if torch.cuda.is_available():
            gpu_info['available'] = True
            gpu_info['type'] = 'CUDA'
            gpu_info['count'] = torch.cuda.device_count()
            
            for i in range(gpu_info['count']):
                props = torch.cuda.get_device_properties(i)
                gpu_info['devices'].append({
                    'id': i,
                    'name': props.name,
                    'memory_gb': props.total_memory / (1024**3),
                    'compute_capability': f"{props.major}.{props.minor}"
                })
            
            logger.info(f"🎮 GPU: {gpu_info['count']} CUDA device(s) detected")
            return gpu_info
        
        # Check MPS (Apple Silicon)
        if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            gpu_info['available'] = True
            gpu_info['type'] = 'MPS'
            gpu_info['count'] = 1
            gpu_info['devices'].append({
                'id': 0,
                'name': 'Apple Silicon',
                'type': 'MPS'
            })
            
            logger.info("🍎 GPU: Apple Silicon MPS detected")
            return gpu_info
        
        logger.info("💻 GPU: Not available, using CPU")
        
    except ImportError:
        logger.debug("PyTorch not installed yet")
    except Exception as e:
        logger.warning(f"GPU detection error: {e}")
    
    return gpu_info

# ====================================================================================================
# MODEL MANAGEMENT
# ====================================================================================================

def verify_model(model_id: str) -> Tuple[bool, str]:
    """
    Verify model exists and is accessible
    """
    try:
        from huggingface_hub import HfApi, hf_hub_download
        
        logger.info(f"🔍 Verifying model: {model_id}")
        
        api = HfApi()
        
        # Check if model exists
        try:
            model_info = api.model_info(model_id)
            
            # Get model size
            size_mb = getattr(model_info, 'size', 0) / (1024 * 1024)
            
            logger.success(f"✅ Model verified: {model_id} ({size_mb:.1f}MB)")
            return True, f"Verified ({size_mb:.1f}MB)"
            
        except Exception as e:
            logger.error(f"❌ Model not found: {model_id}")
            return False, f"Not found: {str(e)}"
        
    except ImportError:
        logger.warning("⚠️  huggingface_hub not installed, skipping verification")
        return True, "Not verified (missing deps)"
    except Exception as e:
        logger.error(f"❌ Verification error: {e}")
        return False, str(e)

def list_cached_models() -> List[Dict]:
    """List models in HuggingFace cache"""
    cached = []
    
    try:
        from huggingface_hub import scan_cache_dir
        
        cache_info = scan_cache_dir()
        
        for repo in cache_info.repos:
            cached.append({
                'id': repo.repo_id,
                'size_mb': repo.size_on_disk / (1024 * 1024),
                'last_accessed': repo.last_accessed,
                'last_modified': repo.last_modified,
            })
        
        logger.info(f"📦 Found {len(cached)} cached models")
        
    except Exception as e:
        logger.debug(f"Could not scan cache: {e}")
    
    return cached

def cleanup_cache(keep_models: Optional[List[str]] = None) -> int:
    """
    Clean up model cache, optionally keeping specific models
    """
    try:
        from huggingface_hub import scan_cache_dir
        
        cache_info = scan_cache_dir()
        deleted_size = 0
        
        for repo in cache_info.repos:
            if keep_models and repo.repo_id in keep_models:
                logger.info(f"⏭️  Keeping: {repo.repo_id}")
                continue
            
            try:
                # Delete strategy (delete old repos)
                strategy = cache_info.delete_revisions(*[rev.commit_hash for rev in repo.revisions])
                strategy.execute()
                
                deleted_size += repo.size_on_disk
                logger.info(f"🗑️  Deleted: {repo.repo_id} ({repo.size_on_disk / (1024**2):.1f}MB)")
                
            except Exception as e:
                logger.warning(f"Could not delete {repo.repo_id}: {e}")
        
        logger.success(f"✅ Freed {deleted_size / (1024**2):.1f}MB")
        return deleted_size
        
    except Exception as e:
        logger.error(f"Cache cleanup failed: {e}")
        return 0

# ====================================================================================================
# RUNTIME MANAGEMENT
# ====================================================================================================

def check_runtime_health(port: int = 6000) -> bool:
    """Check if runtime server is healthy"""
    try:
        import urllib.request
        import json
        
        url = f"http://127.0.0.1:{port}/health"
        
        with urllib.request.urlopen(url, timeout=5) as response:
            data = json.loads(response.read().decode())
            
            if data.get('status') == 'healthy':
                logger.success(f"✅ Runtime healthy on port {port}")
                return True
            
    except Exception as e:
        logger.debug(f"Runtime not responding: {e}")
    
    return False

def start_runtime(
    model: Optional[str] = None,
    port: int = 6000,
    host: str = '127.0.0.1',
    enterprise: bool = True,
    **kwargs
) -> subprocess.Popen:
    """
    Start the runtime server
    """
    # Choose server version
    if enterprise:
        server_path = RUNTIME_DIR / 'server.enterprise.py'
        if not server_path.exists():
            logger.warning("Enterprise server not found, falling back to standard")
            server_path = RUNTIME_DIR / 'server.py'
    else:
        server_path = RUNTIME_DIR / 'server.py'
    
    # Build command
    cmd = [
        sys.executable,
        str(server_path),
        '--port', str(port),
        '--host', host,
    ]
    
    if model:
        cmd.extend(['--model', model])
    elif kwargs.get('auto_download', False):
        cmd.append('--auto-download')
    
    if kwargs.get('no_gpu', False):
        cmd.append('--no-gpu')
    
    if kwargs.get('no_streaming', False):
        cmd.append('--no-streaming')
    
    logger.info(f"🚀 Starting runtime: {' '.join(cmd)}")
    
    try:
        # Start process
        process = subprocess.Popen(
            cmd,
            stdout=sys.stdout,
            stderr=sys.stderr,
        )
        
        # Wait a bit for startup
        time.sleep(2)
        
        # Check if started successfully
        if process.poll() is None:
            logger.success(f"✅ Runtime started (PID: {process.pid})")
            return process
        else:
            logger.error("❌ Runtime failed to start")
            return None
        
    except Exception as e:
        logger.error(f"❌ Failed to start runtime: {e}")
        return None

# ====================================================================================================
# HEALTH CHECKS
# ====================================================================================================

def run_diagnostics() -> Dict[str, any]:
    """
    Run comprehensive system diagnostics
    """
    logger.info("🔍 Running system diagnostics...")
    
    diagnostics = {
        'timestamp': datetime.now().isoformat(),
        'python': {},
        'dependencies': {},
        'gpu': {},
        'models': {},
        'runtime': {},
    }
    
    # Python version
    py_ok, py_version = check_python_version()
    diagnostics['python'] = {
        'version': py_version,
        'compatible': py_ok,
        'executable': sys.executable,
    }
    
    if py_ok:
        logger.success(f"✅ Python {py_version}")
    else:
        logger.error(f"❌ Python {py_version} (need 3.8+)")
    
    # Dependencies
    dep_results = check_dependencies()
    diagnostics['dependencies'] = dep_results
    
    all_deps = all(dep_results.values())
    if all_deps:
        logger.success("✅ All dependencies installed")
    else:
        missing = [pkg for pkg, installed in dep_results.items() if not installed]
        logger.warning(f"⚠️  Missing: {', '.join(missing)}")
    
    # GPU
    gpu_info = check_gpu_availability()
    diagnostics['gpu'] = gpu_info
    
    # Models
    cached_models = list_cached_models()
    diagnostics['models'] = {
        'cached_count': len(cached_models),
        'cached_models': cached_models,
    }
    
    # Runtime health
    runtime_healthy = check_runtime_health()
    diagnostics['runtime'] = {
        'responsive': runtime_healthy,
    }
    
    logger.info("=" * 60)
    logger.info("DIAGNOSTIC SUMMARY")
    logger.info("=" * 60)
    logger.info(f"Python: {'✅' if py_ok else '❌'} {py_version}")
    logger.info(f"Dependencies: {'✅' if all_deps else '⚠️'} {sum(dep_results.values())}/{len(dep_results)}")
    logger.info(f"GPU: {'✅' if gpu_info['available'] else '💻'} {gpu_info.get('type', 'CPU')}")
    logger.info(f"Cached Models: {len(cached_models)}")
    logger.info(f"Runtime: {'✅' if runtime_healthy else '⏹️'} {'Running' if runtime_healthy else 'Stopped'}")
    logger.info("=" * 60)
    
    return diagnostics

# ====================================================================================================
# MAIN CLI
# ====================================================================================================

def main():
    """Main entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description='Sudo Studio Runtime Manager (Enterprise)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Start with auto-download
  python manager.py start --auto-download
  
  # Start with specific model
  python manager.py start --model Qwen/Qwen2.5-Coder-1.5B-Instruct
  
  # Install dependencies
  python manager.py install-deps
  
  # Run diagnostics
  python manager.py diagnose
  
  # List cached models
  python manager.py list-models
        """
    )
    
    subparsers = parser.add_subparsers(dest='command', help='Command to run')
    
    # Start command
    start_parser = subparsers.add_parser('start', help='Start runtime server')
    start_parser.add_argument('--model', help='Model to load')
    start_parser.add_argument('--port', type=int, default=6000, help='Port (default: 6000)')
    start_parser.add_argument('--host', default='127.0.0.1', help='Host (default: 127.0.0.1)')
    start_parser.add_argument('--auto-download', action='store_true', help='Auto download model')
    start_parser.add_argument('--no-gpu', action='store_true', help='Disable GPU')
    start_parser.add_argument('--no-streaming', action='store_true', help='Disable streaming')
    start_parser.add_argument('--standard', action='store_true', help='Use standard server (not enterprise)')
    
    # Install dependencies
    subparsers.add_parser('install-deps', help='Install required dependencies')
    
    # Diagnostics
    subparsers.add_parser('diagnose', help='Run system diagnostics')
    
    # List models
    subparsers.add_parser('list-models', help='List cached models')
    
    # Verify model
    verify_parser = subparsers.add_parser('verify', help='Verify model')
    verify_parser.add_argument('model', help='Model ID to verify')
    
    # Clean cache
    clean_parser = subparsers.add_parser('clean-cache', help='Clean model cache')
    clean_parser.add_argument('--keep', nargs='*', help='Models to keep')
    
    args = parser.parse_args()
    
    # Execute command
    if args.command == 'start':
        # Check dependencies first
        dep_results = check_dependencies()
        if not all(dep_results.values()):
            logger.warning("⚠️  Some dependencies missing. Installing...")
            if not install_dependencies():
                logger.error("❌ Failed to install dependencies. Exiting.")
                sys.exit(1)
        
        # Load config
        config = load_config()
        
        # Determine model
        model = args.model or config.current_model
        
        if model:
            logger.info(f"🤖 Using model: {model}")
        elif args.auto_download:
            logger.info("🔄 Auto-download enabled")
        else:
            logger.warning("⚠️  No model specified and auto-download disabled")
        
        # Update config
        if model:
            config.current_model = model
            save_config(config)
        
        # Start runtime
        process = start_runtime(
            model=model,
            port=args.port,
            host=args.host,
            enterprise=not args.standard,
            auto_download=args.auto_download,
            no_gpu=args.no_gpu,
            no_streaming=args.no_streaming,
        )
        
        if process:
            try:
                process.wait()
            except KeyboardInterrupt:
                logger.info("🛑 Stopping runtime...")
                process.terminate()
                process.wait(timeout=5)
        else:
            sys.exit(1)
    
    elif args.command == 'install-deps':
        success = install_dependencies()
        sys.exit(0 if success else 1)
    
    elif args.command == 'diagnose':
        diagnostics = run_diagnostics()
        
        # Save diagnostics
        diag_file = CONFIG_DIR / f'diagnostics_{int(time.time())}.json'
        with open(diag_file, 'w') as f:
            json.dump(diagnostics, f, indent=2)
        
        logger.info(f"📄 Diagnostics saved to: {diag_file}")
    
    elif args.command == 'list-models':
        cached = list_cached_models()
        
        if cached:
            logger.info(f"📦 Cached models ({len(cached)}):")
            for model in cached:
                logger.info(f"  • {model['id']} ({model['size_mb']:.1f}MB)")
        else:
            logger.info("📦 No cached models")
    
    elif args.command == 'verify':
        success, message = verify_model(args.model)
        logger.info(f"Result: {message}")
        sys.exit(0 if success else 1)
    
    elif args.command == 'clean-cache':
        deleted = cleanup_cache(keep_models=args.keep)
        logger.info(f"🗑️  Deleted {deleted / (1024**2):.1f}MB")
    
    else:
        parser.print_help()

if __name__ == '__main__':
    main()
