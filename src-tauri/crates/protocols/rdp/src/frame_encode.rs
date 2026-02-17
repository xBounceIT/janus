use image::{ImageBuffer, Rgba, RgbaImage};
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_session::image::DecodedImage;

/// Encode the current decoded image as JPEG bytes.
/// Returns `None` if encoding fails.
pub fn encode_jpeg(decoded: &DecodedImage, quality: u8) -> Option<Vec<u8>> {
    let width = decoded.width() as u32;
    let height = decoded.height() as u32;
    let data = decoded.data();

    // Build an RGBA image, handling pixel format differences
    let rgba_image: RgbaImage = match decoded.pixel_format() {
        PixelFormat::RgbA32 => {
            // Already RGBA order
            ImageBuffer::from_raw(width, height, data.to_vec())?
        }
        PixelFormat::BgrA32 => {
            // BGRA → RGBA: swap R and B channels
            let mut pixels = data.to_vec();
            for chunk in pixels.chunks_exact_mut(4) {
                chunk.swap(0, 2);
            }
            ImageBuffer::from_raw(width, height, pixels)?
        }
        _ => {
            // For other formats, attempt a generic 4-byte-per-pixel conversion
            // assuming BGRA order (most common on Windows RDP)
            let bpp = decoded.bytes_per_pixel();
            if bpp != 4 {
                return None;
            }
            let mut pixels = data.to_vec();
            for chunk in pixels.chunks_exact_mut(4) {
                chunk.swap(0, 2);
            }
            ImageBuffer::from_raw(width, height, pixels)?
        }
    };

    // Strip alpha by converting to RGB, then encode as JPEG
    let rgb_image: image::RgbImage = image::DynamicImage::ImageRgba8(rgba_image).to_rgb8();

    let mut buf = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    encoder.encode_image(&rgb_image).ok()?;

    Some(buf)
}

/// Encode only a sub-rectangle of the decoded image as JPEG.
/// Falls back to full-frame encode if rect extraction fails.
#[allow(dead_code)]
pub fn encode_jpeg_rect(
    decoded: &DecodedImage,
    quality: u8,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
) -> Option<Vec<u8>> {
    let full_width = decoded.width() as u32;
    let full_height = decoded.height() as u32;

    // Clamp bounds
    let x = x as u32;
    let y = y as u32;
    let w = (width as u32).min(full_width.saturating_sub(x));
    let h = (height as u32).min(full_height.saturating_sub(y));

    if w == 0 || h == 0 {
        return None;
    }

    let data = decoded.data();
    let bpp = decoded.bytes_per_pixel();
    let stride = decoded.stride();
    let is_bgra = !matches!(decoded.pixel_format(), PixelFormat::RgbA32);

    let mut rect_pixels = Vec::with_capacity((w * h * 4) as usize);
    for row in y..(y + h) {
        let row_start = (row as usize) * stride + (x as usize) * bpp;
        let row_end = row_start + (w as usize) * bpp;
        if row_end > data.len() {
            return None;
        }
        let row_data = &data[row_start..row_end];
        for chunk in row_data.chunks_exact(4) {
            if is_bgra {
                rect_pixels.extend_from_slice(&[chunk[2], chunk[1], chunk[0], chunk[3]]);
            } else {
                rect_pixels.extend_from_slice(chunk);
            }
        }
    }

    let rgba: RgbaImage = ImageBuffer::<Rgba<u8>, _>::from_raw(w, h, rect_pixels)?;
    let rgb = image::DynamicImage::ImageRgba8(rgba).to_rgb8();

    let mut buf = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    encoder.encode_image(&rgb).ok()?;

    Some(buf)
}
