function canvasRoundTrip(
  file: File,
  maxDimension: number,
  quality: number,
): Promise<File> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      // Modern browsers apply EXIF orientation when rendering <img>, so
      // drawImage captures already-corrected pixels. The output JPEG has
      // no EXIF rotation flag — it's baked into the pixel data.
      let { width, height } = img;
      if (width > maxDimension || height > maxDimension) {
        if (width >= height) {
          height = Math.round((height / width) * maxDimension);
          width = maxDimension;
        } else {
          width = Math.round((width / height) * maxDimension);
          height = maxDimension;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (!blob) { reject(new Error('Image processing failed')); return; }
          resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), {
            type: 'image/jpeg',
            lastModified: Date.now(),
          }));
        },
        'image/jpeg',
        quality,
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to load image'));
    };

    img.src = objectUrl;
  });
}

// Resize + re-encode an image client-side before upload. Avatars display at
// ~80px on screen; shrinking to 800px max dimension at 0.85 JPEG quality takes
// a 10MB iPhone photo down to ~200-400KB with no visible quality loss.
export function compressImage(file: File): Promise<File> {
  return canvasRoundTrip(file, 800, 0.85);
}

// Normalize orientation for AI analysis. Uses a larger max dimension (2000px)
// and higher quality (0.92) to preserve text legibility for OCR. The canvas
// round-trip applies EXIF orientation so upside-down/rotated phone photos
// arrive at Claude right-side up.
export function normalizeForAnalysis(file: File): Promise<File> {
  return canvasRoundTrip(file, 2000, 0.92);
}

// Album photos (swipe-right camera capture): same 2000px/0.92 transform as
// normalizeForAnalysis — good enough for a full-screen viewer, and the EXIF
// orientation fix matters even more here since these are raw camera shots,
// not scanned documents. Separate export (not reusing normalizeForAnalysis
// directly) so the name at each call site matches its actual purpose.
export function compressPhoto(file: File): Promise<File> {
  return canvasRoundTrip(file, 2000, 0.92);
}
