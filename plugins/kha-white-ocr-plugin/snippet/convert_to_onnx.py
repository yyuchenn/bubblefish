#!/usr/bin/env python3
"""
Convert manga-ocr model to ONNX format for deployment.
Usage: python convert_to_onnx.py [--model MODEL_NAME] [--output OUTPUT_DIR]
"""

import torch
import json
import argparse
from pathlib import Path
from PIL import Image
from transformers import ViTImageProcessor, AutoTokenizer, VisionEncoderDecoderModel


def export_encoder(model, processor, output_dir, opset_version=14):
    """Export the vision encoder to ONNX."""
    encoder_path = output_dir / "encoder.onnx"
    
    # Create dummy input
    dummy_image = Image.new('RGB', (224, 224), color='white')
    pixel_values = processor(dummy_image, return_tensors="pt").pixel_values
    
    # Export encoder
    print("Exporting encoder...")
    with torch.no_grad():
        torch.onnx.export(
            model.encoder,
            pixel_values,
            encoder_path,
            export_params=True,
            opset_version=opset_version,
            do_constant_folding=True,
            input_names=['pixel_values'],
            output_names=['encoder_hidden_states'],
            dynamic_axes={
                'pixel_values': {0: 'batch_size'},
                'encoder_hidden_states': {0: 'batch_size', 1: 'sequence_length'}
            }
        )
    
    print(f"✓ Encoder saved to {encoder_path}")
    return encoder_path


def export_decoder(model, tokenizer, output_dir, opset_version=14):
    """Export the text decoder to ONNX."""
    decoder_path = output_dir / "decoder.onnx"
    
    # Prepare dummy inputs
    batch_size = 1
    seq_length = 197  # ViT encoder output sequence length
    hidden_size = 768
    
    encoder_hidden_states = torch.randn(batch_size, seq_length, hidden_size)
    decoder_input_ids = torch.tensor([[2]], dtype=torch.long)  # Start with CLS token
    attention_mask = torch.ones_like(decoder_input_ids)
    
    # Wrap decoder for cleaner export
    class DecoderWrapper(torch.nn.Module):
        def __init__(self, decoder):
            super().__init__()
            self.decoder = decoder
        
        def forward(self, input_ids, encoder_hidden_states, attention_mask=None):
            outputs = self.decoder(
                input_ids=input_ids,
                attention_mask=attention_mask,
                encoder_hidden_states=encoder_hidden_states,
                use_cache=False,
                return_dict=False
            )
            return outputs[0]  # Return only logits
    
    wrapper = DecoderWrapper(model.decoder)
    wrapper.eval()
    
    # Export decoder
    print("Exporting decoder...")
    with torch.no_grad():
        torch.onnx.export(
            wrapper,
            (decoder_input_ids, encoder_hidden_states, attention_mask),
            decoder_path,
            export_params=True,
            opset_version=opset_version,
            do_constant_folding=True,
            input_names=['input_ids', 'encoder_hidden_states', 'attention_mask'],
            output_names=['logits'],
            dynamic_axes={
                'input_ids': {0: 'batch_size', 1: 'sequence_length'},
                'encoder_hidden_states': {0: 'batch_size', 1: 'encoder_sequence_length'},
                'attention_mask': {0: 'batch_size', 1: 'sequence_length'},
                'logits': {0: 'batch_size', 1: 'sequence_length'}
            }
        )
    
    print(f"✓ Decoder saved to {decoder_path}")
    return decoder_path


def save_configs(processor, tokenizer, output_dir):
    """Save preprocessor and tokenizer configurations."""
    # Save preprocessor config
    processor.save_pretrained(output_dir)
    
    # Save tokenizer vocabulary
    tokenizer.save_pretrained(output_dir)
    
    # Create config for standalone inference
    config = {
        "preprocessor": {
            "image_size": [224, 224],
            "rescale_factor": 0.00392156862745098,  # 1/255
            "image_mean": [0.5, 0.5, 0.5],
            "image_std": [0.5, 0.5, 0.5],
        },
        "model": {
            "decoder_start_token_id": 2,  # [CLS]
            "eos_token_id": 3,  # [SEP]
            "max_length": 300
        },
        "special_tokens": {
            "pad": {"id": 0, "token": "[PAD]"},
            "unk": {"id": 1, "token": "[UNK]"},
            "cls": {"id": 2, "token": "[CLS]"},
            "sep": {"id": 3, "token": "[SEP]"},
            "mask": {"id": 4, "token": "[MASK]"}
        }
    }
    
    config_path = output_dir / "config.json"
    with open(config_path, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
    
    print(f"✓ Configuration saved to {output_dir}")


def verify_models(output_dir):
    """Verify the exported ONNX models."""
    try:
        import onnx
        import onnxruntime as ort
        
        # Check encoder
        encoder_model = onnx.load(str(output_dir / "encoder.onnx"))
        onnx.checker.check_model(encoder_model)
        encoder_session = ort.InferenceSession(str(output_dir / "encoder.onnx"))
        print("✓ Encoder model verified")
        
        # Check decoder
        decoder_model = onnx.load(str(output_dir / "decoder.onnx"))
        onnx.checker.check_model(decoder_model)
        decoder_session = ort.InferenceSession(str(output_dir / "decoder.onnx"))
        print("✓ Decoder model verified")
        
        return True
    except ImportError:
        print("⚠ Install 'onnx' and 'onnxruntime' to verify models:")
        print("  pip install onnx onnxruntime")
        return False


def main():
    parser = argparse.ArgumentParser(description="Convert manga-ocr model to ONNX format")
    parser.add_argument(
        "--model", 
        default="kha-white/manga-ocr-base",
        help="Model name or path (default: kha-white/manga-ocr-base)"
    )
    parser.add_argument(
        "--output", 
        default="../onnx_model",
        help="Output directory (default: ../onnx_model)"
    )
    parser.add_argument(
        "--opset",
        type=int,
        default=14,
        help="ONNX opset version (default: 14)"
    )
    args = parser.parse_args()
    
    # Create output directory
    output_dir = Path(args.output)
    output_dir.mkdir(exist_ok=True)
    
    print(f"Converting model: {args.model}")
    print(f"Output directory: {output_dir}")
    print()
    
    # Load model and processors
    print("Loading model...")
    model = VisionEncoderDecoderModel.from_pretrained(args.model)
    processor = ViTImageProcessor.from_pretrained(args.model)
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model.eval()
    
    # Export models
    export_encoder(model, processor, output_dir, args.opset)
    export_decoder(model, tokenizer, output_dir, args.opset)
    
    # Save configurations
    save_configs(processor, tokenizer, output_dir)
    
    # Verify models
    print("\nVerifying models...")
    verify_models(output_dir)
    
    print(f"\n✅ Conversion complete! Models saved to {output_dir}/")
    print("\nTo use the models, run:")
    print(f"  python inference_onnx.py --model {output_dir} --image YOUR_IMAGE.png")


if __name__ == "__main__":
    main()