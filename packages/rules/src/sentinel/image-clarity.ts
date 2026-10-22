import { z } from 'zod';
import { defineSentinelRule, exempt, pass, review, unknown } from './core.js';

export const clarityEvidenceSchema = z
  .object({
    purpose: z.string().min(1),
    style: z.enum(['continuous', 'pixel-art', 'texture', 'intentional-low-resolution']),
    currentSrc: z.string().min(1),
    loadEpoch: z.number().int().nonnegative(),
    /** Decoded resource pixel dimensions, NOT HTMLImageElement.naturalWidth (density-corrected CSS px). */
    pixelWidth: z.number().positive(),
    pixelHeight: z.number().positive(),
    /** Measured painted resource size, including object-fit and transforms. */
    renderedWidth: z.number().positive(),
    renderedHeight: z.number().positive(),
    screenshotUncompressed: z.boolean(),
    recognizable: z.boolean().nullable(),
  })
  .strict();
export const imageClarityRule = defineSentinelRule(
  {
    id: 'UIK-R012',
    name: '图像清晰度审查',
    kind: 'review',
    description: '结合实际资源像素、显示尺寸、设备像素比与识别用途审查清晰度，不规定统一分辨率。',
  },
  clarityEvidenceSchema,
  (c, d) => {
    if (d.style !== 'continuous') return exempt('The image has an intentional pixel, texture or low-resolution style');
    const image = c.node.image;
    if (!image?.complete || !image.naturalWidth || !image.naturalHeight)
      return unknown('A completed, available image is required; progressive/lazy loading is not a clarity defect');
    if (image.currentSrc !== d.currentSrc || image.loadEpoch !== d.loadEpoch)
      return unknown('The decoded resource metadata belongs to a different image or load');
    const dpr = c.page.snapshot.dom?.environment?.devicePixelRatio;
    if (!dpr || dpr <= 0 || !d.screenshotUncompressed)
      return unknown('The target display density and an uncompressed visual observation are required');
    const densityX = d.pixelWidth / (d.renderedWidth * dpr);
    const densityY = d.pixelHeight / (d.renderedHeight * dpr);
    const facts = { purpose: d.purpose, densityX, densityY, dpr };
    if (d.recognizable === true)
      return pass('The actual image remains recognizable for its bound purpose at the target display size', facts);
    if (d.recognizable === false)
      return review('The completed resource is hard to recognize at the measured display size', facts);
    if (densityX < 1 || densityY < 1)
      return review(
        'The resource is enlarged beyond its decoded pixel density; inspect recognizability and intended style',
        facts,
      );
    return unknown(
      'Pixel density alone cannot establish visual clarity; inspect the original resource and rendered image',
      facts,
    );
  },
);
