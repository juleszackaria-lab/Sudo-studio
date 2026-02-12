#!/usr/bin/env python3
import argparse
from flask import Flask, request, jsonify
from transformers import pipeline

app = Flask(__name__)

parser = argparse.ArgumentParser()
parser.add_argument('--model', required=True)
parser.add_argument('--port', type=int, default=6000)
args = parser.parse_args()

model_name = args.model
print(f"Loading model {model_name}...")
try:
    gen = pipeline('text-generation', model=model_name)
    print('Model loaded')
except Exception as e:
    print('Failed to load model:', e)
    gen = None

@app.route('/infer', methods=['POST'])
def infer():
    data = request.json or {}
    prompt = data.get('input') or data.get('prompt') or ''
    if gen is None:
        return jsonify({'error': 'Model not loaded'}), 500
    out = gen(prompt, max_length=200, do_sample=False)
    text = out[0]['generated_text'] if out else ''
    return jsonify({'reply': text})

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=args.port)
