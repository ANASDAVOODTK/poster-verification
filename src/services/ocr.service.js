import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
export async function performArabicOCR(imageBuffer) {
  // Pre-process image: Grayscale + Contrast improves Tesseract accuracy for Arabic
  const processedImage = await sharp(imageBuffer)
    .greyscale()
    .normalize()
    .toBuffer();

  const worker = await createWorker('ara'); // Load Arabic
  const { data: { text } } = await worker.recognize(processedImage);
  await worker.terminate();
  return text;
}

