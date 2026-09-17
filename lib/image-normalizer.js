import { Buffer } from 'node:buffer';
import sharp from 'sharp';

const RESIZABLE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function decodeCanonicalBase64(data) {
    const decoded = Buffer.from(data, 'base64');
    return data.length > 0 && decoded.toString('base64') === data ? decoded : undefined;
}

/**
 * Downscale an ACP image to the attachment store's intrinsic-dimension limit.
 *
 * Invalid, unsupported, or over-pixel-budget inputs stay unchanged so the
 * attachment store remains the owner of their stable admission errors.
 */
export async function normalizeEncodedImageForAttachmentStore(image, limits) {
    if (!RESIZABLE_MEDIA_TYPES.has(image.mediaType))
        return image;
    const decoded = decodeCanonicalBase64(image.data);
    if (decoded === undefined)
        return image;
    let metadata;
    try {
        metadata = await sharp(decoded, { failOn: 'error', limitInputPixels: false }).metadata();
    }
    catch {
        return image;
    }
    const width = metadata.width;
    const height = metadata.height;
    if (width === undefined ||
        height === undefined ||
        Math.max(width, height) <= limits.maxImageDimension ||
        width * height > limits.maxImagePixels) {
        return image;
    }
    try {
        const resized = await sharp(decoded, {
            failOn: 'error',
            limitInputPixels: limits.maxImagePixels,
        })
            .resize({
            width: limits.maxImageDimension,
            height: limits.maxImageDimension,
            fit: 'inside',
            withoutEnlargement: true,
        })
            .toBuffer();
        return { ...image, data: resized.toString('base64') };
    }
    catch {
        return image;
    }
}

export async function normalizeEncodedImagesForAttachmentStore(attachments, images) {
    return Promise.all(images.map((image) => normalizeEncodedImageForAttachmentStore(image, attachments.imageLimits)));
}
