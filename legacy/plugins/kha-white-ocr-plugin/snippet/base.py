import re
from pathlib import Path

import torch
from PIL import Image
from transformers import ViTImageProcessor, AutoTokenizer, VisionEncoderDecoderModel, GenerationMixin


class MangaOcrModel(VisionEncoderDecoderModel, GenerationMixin):
    pass


class MangaOcr:
    def __init__(self, pretrained_model_name_or_path="kha-white/manga-ocr-base"):
        self.processor = ViTImageProcessor.from_pretrained(pretrained_model_name_or_path)
        self.tokenizer = AutoTokenizer.from_pretrained(pretrained_model_name_or_path)
        self.model = MangaOcrModel.from_pretrained(pretrained_model_name_or_path)

        if torch.cuda.is_available():
            self.model.cuda()


manga_ocr = MangaOcr()

path = "example.png"
img = Image.open(path)
img = img.convert("L").convert("RGB")

x = manga_ocr.processor(img, return_tensors="pt").pixel_values.squeeze()
x = manga_ocr.model.generate(x[None].to(manga_ocr.model.device), max_length=300)[0].cpu()
x = manga_ocr.tokenizer.decode(x, skip_special_tokens=True)

text = "".join(x.split())
text = text.replace("…", "...")
text = re.sub("[・.]{2,}", lambda x: (x.end() - x.start()) * ".", text)

print(text)
