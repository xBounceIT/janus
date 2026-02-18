use image::codecs::jpeg::JpegEncoder;
use image::RgbImage;
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_pdu::geometry::InclusiveRectangle;
use ironrdp_session::image::DecodedImage;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatchCodec {
    Raw,
    Jpeg,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameRect {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

impl FrameRect {
    pub fn full(width: u16, height: u16) -> Self {
        Self {
            x: 0,
            y: 0,
            width,
            height,
        }
    }

    pub fn area(&self) -> u32 {
        u32::from(self.width) * u32::from(self.height)
    }

    fn right(&self) -> u16 {
        self.x + self.width - 1
    }

    fn bottom(&self) -> u16 {
        self.y + self.height - 1
    }

    fn intersects_or_adjacent(&self, other: &Self) -> bool {
        let ax1 = i32::from(self.x);
        let ay1 = i32::from(self.y);
        let ax2 = i32::from(self.right());
        let ay2 = i32::from(self.bottom());

        let bx1 = i32::from(other.x);
        let by1 = i32::from(other.y);
        let bx2 = i32::from(other.right());
        let by2 = i32::from(other.bottom());

        !(ax2 + 1 < bx1 || bx2 + 1 < ax1 || ay2 + 1 < by1 || by2 + 1 < ay1)
    }

    fn union(&self, other: &Self) -> Self {
        let left = self.x.min(other.x);
        let top = self.y.min(other.y);
        let right = self.right().max(other.right());
        let bottom = self.bottom().max(other.bottom());

        Self {
            x: left,
            y: top,
            width: right - left + 1,
            height: bottom - top + 1,
        }
    }
}

pub fn rect_from_inclusive(
    rect: &InclusiveRectangle,
    desktop_width: u16,
    desktop_height: u16,
) -> Option<FrameRect> {
    if desktop_width == 0 || desktop_height == 0 {
        return None;
    }

    let left = rect.left.min(desktop_width - 1);
    let top = rect.top.min(desktop_height - 1);
    let right = rect.right.min(desktop_width - 1);
    let bottom = rect.bottom.min(desktop_height - 1);

    if right < left || bottom < top {
        return None;
    }

    Some(FrameRect {
        x: left,
        y: top,
        width: right - left + 1,
        height: bottom - top + 1,
    })
}

pub fn merge_rects(mut rects: Vec<FrameRect>) -> Vec<FrameRect> {
    if rects.len() < 2 {
        return rects;
    }

    let mut changed = true;
    while changed {
        changed = false;

        let mut i = 0;
        while i < rects.len() {
            let mut j = i + 1;
            while j < rects.len() {
                if rects[i].intersects_or_adjacent(&rects[j]) {
                    rects[i] = rects[i].union(&rects[j]);
                    rects.swap_remove(j);
                    changed = true;
                } else {
                    j += 1;
                }
            }
            i += 1;
        }
    }

    rects
}

pub fn total_dirty_area(rects: &[FrameRect]) -> u32 {
    rects.iter().map(FrameRect::area).sum()
}

pub fn should_emit_full_frame(
    rects: &[FrameRect],
    desktop_width: u16,
    desktop_height: u16,
    threshold_percent: u8,
) -> bool {
    if rects.is_empty() || desktop_width == 0 || desktop_height == 0 {
        return false;
    }

    let dirty = total_dirty_area(rects);
    let total = u32::from(desktop_width) * u32::from(desktop_height);

    // Avoid float math for predictable thresholds.
    dirty.saturating_mul(100) >= total.saturating_mul(u32::from(threshold_percent))
}

pub fn encode_rect(
    decoded: &DecodedImage,
    rect: &FrameRect,
    codec: PatchCodec,
    jpeg_quality: u8,
) -> Option<Vec<u8>> {
    match codec {
        PatchCodec::Raw => extract_rgba_rect(decoded, rect),
        PatchCodec::Jpeg => {
            let rgb = extract_rgb_rect(decoded, rect)?;
            let mut out = Vec::new();
            let mut encoder = JpegEncoder::new_with_quality(&mut out, jpeg_quality);
            encoder.encode_image(&rgb).ok()?;
            Some(out)
        }
    }
}

fn extract_rgb_rect(decoded: &DecodedImage, rect: &FrameRect) -> Option<RgbImage> {
    let rgba = extract_rgba_rect(decoded, rect)?;
    let mut rgb = Vec::with_capacity(usize::from(rect.width) * usize::from(rect.height) * 3);
    for px in rgba.chunks_exact(4) {
        rgb.extend_from_slice(&[px[0], px[1], px[2]]);
    }

    RgbImage::from_raw(u32::from(rect.width), u32::from(rect.height), rgb)
}

fn extract_rgba_rect(decoded: &DecodedImage, rect: &FrameRect) -> Option<Vec<u8>> {
    let image_width = decoded.width();
    let image_height = decoded.height();
    if image_width == 0 || image_height == 0 {
        return None;
    }

    if rect.width == 0 || rect.height == 0 {
        return None;
    }

    if rect.x >= image_width || rect.y >= image_height {
        return None;
    }

    let max_w = image_width - rect.x;
    let max_h = image_height - rect.y;
    if rect.width > max_w || rect.height > max_h {
        return None;
    }

    let data = decoded.data();
    let bpp = decoded.bytes_per_pixel();
    let stride = decoded.stride();

    if bpp != 4 {
        return None;
    }

    let mut rgba = Vec::with_capacity(usize::from(rect.width) * usize::from(rect.height) * 4);

    for row in rect.y..(rect.y + rect.height) {
        let row_start = usize::from(row) * stride + usize::from(rect.x) * bpp;
        let row_end = row_start + usize::from(rect.width) * bpp;
        if row_end > data.len() {
            return None;
        }

        let row_data = &data[row_start..row_end];
        for px in row_data.chunks_exact(4) {
            match decoded.pixel_format() {
                PixelFormat::RgbA32 => rgba.extend_from_slice(&[px[0], px[1], px[2], px[3]]),
                _ => rgba.extend_from_slice(&[px[2], px[1], px[0], px[3]]),
            }
        }
    }

    Some(rgba)
}

#[cfg(test)]
mod tests {
    use super::{merge_rects, should_emit_full_frame, FrameRect};

    #[test]
    fn merge_rects_merges_adjacent() {
        let merged = merge_rects(vec![
            FrameRect {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            },
            FrameRect {
                x: 10,
                y: 0,
                width: 10,
                height: 10,
            },
        ]);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].x, 0);
        assert_eq!(merged[0].y, 0);
        assert_eq!(merged[0].width, 20);
        assert_eq!(merged[0].height, 10);
    }

    #[test]
    fn merge_rects_keeps_separate_regions() {
        let merged = merge_rects(vec![
            FrameRect {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            },
            FrameRect {
                x: 30,
                y: 30,
                width: 5,
                height: 5,
            },
        ]);

        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn full_frame_threshold_respected() {
        let rects = vec![FrameRect {
            x: 0,
            y: 0,
            width: 64,
            height: 64,
        }];

        assert!(should_emit_full_frame(&rects, 100, 100, 40));
        assert!(!should_emit_full_frame(&rects, 200, 200, 40));
    }
}
