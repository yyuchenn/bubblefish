#!/usr/bin/env python3
"""
Standalone ONNX inference for manga-ocr without transformers dependency.
Usage: python inference_onnx.py --model MODEL_DIR --image IMAGE_PATH
"""

import json
import argparse
import re
from pathlib import Path
import numpy as np
from PIL import Image
import onnxruntime as ort


class ImageProcessor:
    """Standalone image processor without transformers dependency."""
    
    def __init__(self, config):
        """Initialize from configuration dictionary."""
        self.image_size = tuple(config['preprocessor']['image_size'])
        self.rescale_factor = config['preprocessor']['rescale_factor']
        self.image_mean = np.array(config['preprocessor']['image_mean'])
        self.image_std = np.array(config['preprocessor']['image_std'])
    
    def process(self, image):
        """Process PIL image to model input format."""
        # Convert to RGB
        if image.mode != 'RGB':
            image = image.convert('RGB')
        
        # Resize to model input size
        image = image.resize(self.image_size, Image.Resampling.BILINEAR)
        
        # Convert to numpy array
        image_array = np.array(image, dtype=np.float32)
        
        # Rescale from [0, 255] to [0, 1]
        image_array = image_array * self.rescale_factor
        
        # Normalize
        image_array = (image_array - self.image_mean) / self.image_std
        
        # Convert from HWC to CHW format
        image_array = np.transpose(image_array, (2, 0, 1))
        
        # Add batch dimension
        image_array = np.expand_dims(image_array, axis=0)
        
        return image_array.astype(np.float32)


class Tokenizer:
    """Standalone tokenizer without transformers dependency."""
    
    def __init__(self, vocab_path, config):
        """Load vocabulary and configuration."""
        # Load vocabulary
        self.vocab = {}
        self.id_to_token = {}
        
        with open(vocab_path, 'r', encoding='utf-8') as f:
            for idx, line in enumerate(f):
                token = line.strip()
                self.vocab[token] = idx
                self.id_to_token[idx] = token
        
        # Set special token IDs from config
        self.special_tokens = config['special_tokens']
        self.pad_token_id = self.special_tokens['pad']['id']
        self.unk_token_id = self.special_tokens['unk']['id']
        self.cls_token_id = self.special_tokens['cls']['id']
        self.sep_token_id = self.special_tokens['sep']['id']
        self.mask_token_id = self.special_tokens['mask']['id']
        
        # Create set of special token strings
        self.special_token_set = {
            self.special_tokens['pad']['token'],
            self.special_tokens['unk']['token'],
            self.special_tokens['cls']['token'],
            self.special_tokens['sep']['token'],
            self.special_tokens['mask']['token']
        }
    
    def decode(self, token_ids, skip_special_tokens=True):
        """Decode token IDs to text."""
        tokens = []
        for token_id in token_ids:
            if token_id in self.id_to_token:
                token = self.id_to_token[token_id]
                if skip_special_tokens and token in self.special_token_set:
                    continue
                tokens.append(token)
        
        # Join without spaces (Japanese text)
        text = ''.join(tokens)
        
        # Remove BERT subword markers
        text = text.replace('##', '')
        
        return text


class MangaOCR:
    """Main OCR class using ONNX models."""
    
    def __init__(self, model_dir):
        """Load models and configurations."""
        model_path = Path(model_dir)
        
        # Load configuration
        with open(model_path / "config.json", 'r', encoding='utf-8') as f:
            self.config = json.load(f)
        
        # Initialize processors
        self.processor = ImageProcessor(self.config)
        self.tokenizer = Tokenizer(model_path / "vocab.txt", self.config)
        
        # Load ONNX models
        print(f"Loading models from {model_path}...")
        self.encoder_session = ort.InferenceSession(
            str(model_path / "encoder.onnx"),
            providers=['CPUExecutionProvider']
        )
        self.decoder_session = ort.InferenceSession(
            str(model_path / "decoder.onnx"),
            providers=['CPUExecutionProvider']
        )
        
        # Model parameters
        self.decoder_start_token_id = self.config['model']['decoder_start_token_id']
        self.eos_token_id = self.config['model']['eos_token_id']
        self.max_length = self.config['model']['max_length']
        
        print("✓ Models loaded successfully")
    
    def __call__(self, image_path, verbose=False):
        """Run OCR on an image."""
        # Load image
        if isinstance(image_path, str) or isinstance(image_path, Path):
            image = Image.open(image_path)
        else:
            image = image_path
        
        # Convert to grayscale then back to RGB (improves OCR quality)
        image = image.convert("L").convert("RGB")
        
        # Process image
        pixel_values = self.processor.process(image)
        
        # Run encoder
        encoder_outputs = self.encoder_session.run(
            None, 
            {'pixel_values': pixel_values}
        )[0]
        
        if verbose:
            print(f"Encoder output shape: {encoder_outputs.shape}")
        
        # Generate text with decoder
        generated_ids = [self.decoder_start_token_id]
        
        for step in range(self.max_length):
            # Prepare decoder inputs
            input_ids = np.array([generated_ids], dtype=np.int64)
            attention_mask = np.ones_like(input_ids, dtype=np.int64)
            
            # Run decoder
            logits = self.decoder_session.run(
                None,
                {
                    'input_ids': input_ids,
                    'encoder_hidden_states': encoder_outputs,
                    'attention_mask': attention_mask
                }
            )[0]
            
            # Get next token (greedy decoding)
            next_token_id = int(np.argmax(logits[0, -1, :]))
            generated_ids.append(next_token_id)
            
            # Stop if end-of-sequence token
            if next_token_id == self.eos_token_id:
                if verbose:
                    print(f"Generated {len(generated_ids)-1} tokens")
                break
        
        # Decode to text (skip the initial CLS token)
        text = self.tokenizer.decode(generated_ids[1:], skip_special_tokens=True)
        
        # Post-process text
        text = self.post_process(text)
        
        return text
    
    def post_process(self, text):
        """Apply post-processing to decoded text."""
        # Remove spaces
        text = "".join(text.split())
        
        # Replace ellipsis
        text = text.replace("…", "...")
        
        # Handle repeated dots
        text = re.sub(r"[・.]{2,}", lambda m: "." * len(m.group()), text)
        
        return text


def main():
    parser = argparse.ArgumentParser(description="Run manga OCR using ONNX models")
    parser.add_argument(
        "--model",
        default="onnx_model",
        help="Path to ONNX model directory (default: onnx_model)"
    )
    parser.add_argument(
        "--image",
        required=True,
        help="Path to input image"
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose output"
    )
    args = parser.parse_args()
    
    # Check if model directory exists
    model_path = Path(args.model)
    if not model_path.exists():
        print(f"Error: Model directory '{model_path}' not found")
        print("Please run 'python convert_to_onnx.py' first to convert the model")
        return 1
    
    # Check if image exists
    image_path = Path(args.image)
    if not image_path.exists():
        print(f"Error: Image file '{image_path}' not found")
        return 1
    
    # Initialize OCR
    ocr = MangaOCR(model_path)
    
    # Run OCR
    print(f"\nProcessing: {image_path}")
    result = ocr(image_path, verbose=args.verbose)
    
    # Print result
    print(f"\nResult: {result}")
    
    return 0


if __name__ == "__main__":
    exit(main())