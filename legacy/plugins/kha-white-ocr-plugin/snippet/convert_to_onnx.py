#!/usr/bin/env python3
"""
Convert manga-ocr model to ONNX format for deployment.
Usage: python convert_to_onnx.py [--model MODEL_NAME] [--output OUTPUT_DIR]
"""

import argparse
import json
from pathlib import Path

import torch
from PIL import Image
from transformers import AutoTokenizer, ViTImageProcessor, VisionEncoderDecoderModel


def image_size(processor):
    """Return width/height in the order consumed by the Rust plugin."""
    size = processor.size
    if isinstance(size, int):
        return [size, size]
    return [int(size['width']), int(size['height'])]


def sample_pixels(processor):
    image = Image.new('RGB', tuple(image_size(processor)), color='white')
    return processor(image, return_tensors='pt').pixel_values.to(
        device='cpu', dtype=torch.float32
    )


def generation_token_id(model, tokenizer, name):
    value = getattr(model.generation_config, name, None)
    if value is None:
        value = getattr(model.config, name, None)
    if value is None:
        value = getattr(tokenizer, name, None)
    if name == 'decoder_start_token_id' and value is None:
        value = tokenizer.cls_token_id
    if not isinstance(value, int):
        raise ValueError(f'The plugin requires one integer {name}, got {value!r}')
    return value


def export_encoder(model, processor, output_dir, opset_version=14):
    """Export the vision encoder to ONNX."""
    encoder_path = output_dir / "encoder.onnx"
    
    pixel_values = sample_pixels(processor)

    class EncoderWrapper(torch.nn.Module):
        def __init__(self, encoder):
            super().__init__()
            self.encoder = encoder

        def forward(self, pixel_values):
            return self.encoder(pixel_values=pixel_values, return_dict=False)[0]

    wrapper = EncoderWrapper(model.encoder).eval()
    
    # Export encoder
    print("Exporting encoder...")
    with torch.no_grad():
        torch.onnx.export(
            wrapper,
            pixel_values,
            encoder_path,
            export_params=True,
            opset_version=opset_version,
            do_constant_folding=True,
            dynamo=False,
            external_data=False,
            input_names=['pixel_values'],
            output_names=['encoder_hidden_states'],
            dynamic_axes={
                'pixel_values': {0: 'batch_size'},
                'encoder_hidden_states': {0: 'batch_size'}
            }
        )
    
    print(f"✓ Encoder saved to {encoder_path}")
    return encoder_path


def export_decoder(model, tokenizer, processor, output_dir, opset_version=14):
    """Export the text decoder to ONNX."""
    decoder_path = output_dir / "decoder.onnx"
    
    # Infer the encoder dimensions from this checkpoint rather than hard-coding ViT.
    with torch.no_grad():
        encoder_hidden_states = model.encoder(
            pixel_values=sample_pixels(processor), return_dict=False
        )[0]
    start_id = generation_token_id(model, tokenizer, 'decoder_start_token_id')
    # Trace more than one token so causal-mask branches also cover later steps.
    decoder_input_ids = torch.tensor([[start_id, start_id]], dtype=torch.long)
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
            dynamo=False,
            external_data=False,
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


def save_configs(model, processor, tokenizer, output_dir):
    """Save preprocessor and tokenizer configurations."""
    # Save preprocessor config
    processor.save_pretrained(output_dir)
    
    # Save tokenizer vocabulary
    tokenizer.save_pretrained(output_dir)

    # Rust consumes a BERT vocabulary as one token per line, including with a fast
    # tokenizer whose save_pretrained implementation only writes tokenizer.json.
    vocab = tokenizer.get_vocab()
    if sorted(vocab.values()) != list(range(len(vocab))):
        raise ValueError('The plugin requires contiguous vocabulary IDs')
    ordered_vocab = sorted(vocab, key=vocab.get)
    if any('\n' in token or '\r' in token for token in ordered_vocab):
        raise ValueError('The plugin vocabulary cannot contain newline tokens')
    (output_dir / 'vocab.txt').write_text(
        '\n'.join(ordered_vocab) + '\n', encoding='utf-8'
    )

    special_tokens = {}
    for name in ('pad', 'unk', 'cls', 'sep', 'mask'):
        token = getattr(tokenizer, f'{name}_token')
        token_id = getattr(tokenizer, f'{name}_token_id')
        if token is None or token_id is None:
            raise ValueError(f'The plugin requires a {name} token')
        special_tokens[name] = {'id': token_id, 'token': token}
    
    # Create config for standalone inference
    config = {
        "preprocessor": {
            "image_size": image_size(processor),
            "rescale_factor": processor.rescale_factor if processor.do_rescale else 1.0,
            "image_mean": list(processor.image_mean) if processor.do_normalize else [0.0] * 3,
            "image_std": list(processor.image_std) if processor.do_normalize else [1.0] * 3,
        },
        "model": {
            "decoder_start_token_id": generation_token_id(model, tokenizer, 'decoder_start_token_id'),
            "eos_token_id": generation_token_id(model, tokenizer, 'eos_token_id'),
            # Keep the existing OCR limit within the checkpoint's position limit.
            "max_length": min(300, int(model.decoder.config.max_position_embeddings))
        },
        "special_tokens": special_tokens
    }
    
    config_path = output_dir / "config.json"
    with open(config_path, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
    
    print(f"✓ Configuration saved to {output_dir}")


def verify_models(output_dir):
    """Require valid, self-contained graphs loadable from bytes like the plugin."""
    import numpy as np
    import onnx
    import onnxruntime as ort

    for name in ('encoder.onnx', 'decoder.onnx', 'config.json', 'vocab.txt'):
        path = output_dir / name
        if not path.is_file() or path.stat().st_size == 0:
            raise RuntimeError(f'Missing or empty plugin model file: {path}')

    def load_session(name, expected_inputs, expected_outputs):
        model_bytes = (output_dir / name).read_bytes()
        graph = onnx.load_model_from_string(model_bytes)
        if any(t.data_location == onnx.TensorProto.EXTERNAL for t in graph.graph.initializer):
            raise RuntimeError(f'{name} has external weights; the plugin embeds one ONNX file')
        onnx.checker.check_model(graph)
        del graph
        session = ort.InferenceSession(model_bytes, providers=['CPUExecutionProvider'])
        inputs = [(item.name, item.type) for item in session.get_inputs()]
        outputs = [item.name for item in session.get_outputs()]
        if inputs != expected_inputs or outputs != expected_outputs:
            raise RuntimeError(f'{name} has incompatible inputs/outputs: {inputs}, {outputs}')
        return session

    config = json.loads((output_dir / 'config.json').read_text(encoding='utf-8'))
    width, height = config['preprocessor']['image_size']
    encoder_session = load_session(
        'encoder.onnx', [('pixel_values', 'tensor(float)')], ['encoder_hidden_states']
    )
    hidden_states = encoder_session.run(
        None, {'pixel_values': np.zeros((1, 3, height, width), dtype=np.float32)}
    )[0]
    if not np.isfinite(hidden_states).all():
        raise RuntimeError('Encoder produced non-finite hidden states')
    del encoder_session
    print('✓ Encoder model verified from bytes')

    decoder_session = load_session(
        'decoder.onnx',
        [('input_ids', 'tensor(int64)'), ('encoder_hidden_states', 'tensor(float)'),
         ('attention_mask', 'tensor(int64)')],
        ['logits']
    )
    vocab_size = len((output_dir / 'vocab.txt').read_text(encoding='utf-8').splitlines())
    for length in (1, 2, 8):
        input_ids = np.full((1, length), config['model']['decoder_start_token_id'], dtype=np.int64)
        logits = decoder_session.run(None, {
            'input_ids': input_ids,
            'encoder_hidden_states': hidden_states,
            'attention_mask': np.ones_like(input_ids),
        })[0]
        if logits.shape != (1, length, vocab_size) or not np.isfinite(logits).all():
            raise RuntimeError(f'Decoder output invalid at sequence length {length}: {logits.shape}')
    print(f'✓ Decoder model verified from bytes with ONNX Runtime {ort.__version__}')
    return True


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
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"Converting model: {args.model}")
    print(f"Output directory: {output_dir}")
    print()
    
    # Load model and processors
    print("Loading model...")
    model = VisionEncoderDecoderModel.from_pretrained(
        args.model, attn_implementation='eager', torch_dtype=torch.float32
    ).to(device='cpu', dtype=torch.float32)
    model.config.use_cache = False
    model.decoder.config.use_cache = False
    processor = ViTImageProcessor.from_pretrained(args.model)
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model.eval()
    
    # Export models
    export_encoder(model, processor, output_dir, args.opset)
    export_decoder(model, tokenizer, processor, output_dir, args.opset)
    
    # Save configurations
    save_configs(model, processor, tokenizer, output_dir)
    
    # Verify models
    print("\nVerifying models...")
    verify_models(output_dir)
    
    print(f"\n✅ Conversion complete! Models saved to {output_dir}/")
    print("\nTo use the models, run:")
    print(f"  python inference_onnx.py --model {output_dir} --image YOUR_IMAGE.png")


if __name__ == "__main__":
    main()
